#!/usr/bin/env node
// V8-T2 (Командировки: механика «прогноз → подтверждена», п.3 владельца + п.7 дополнения): сьют `tripsstatus`.
//
// Реальный headless Chromium по CDP + `php -S` на КОПИИ data/app.db (SC_APP_DB; data/app.db не меняется,
// проверяется sha1). Каркас — scripts/v6_accept_lib.js (как у tripsform). Пароли в браузер не вводятся:
// cookie берётся запросом к api/login.php (dev-учётки, стартовый пароль — только dev-БД).
//
// Что проверяется:
//   сервер  — PUT ?action=confirm: forecast → confirmed, по заявке на участника в trip_requests; повторный
//             confirm — no-op без дублей; пустое место → 400 location_required (статус и заявки не меняются);
//             создание прогноза без места по-прежнему можно; PUT без status статус не трогает и заявок не ставит;
//             supervisor: confirm прогноза своей зоны — да, чужой зоны — 403, правка подтверждённой — 403;
//   браузер — новая командировка: кнопки «На подтверждение» / «Подтвердить», нет селекта статуса; «На подтверждение»
//             = forecast без заявок; «Подтвердить» = confirmed + заявки; без места «Подтвердить» не отправляется
//             (ошибка у поля); существующий прогноз — те же 2 кнопки, поля места/комментария заполнены; подтверждённая
//             — только «Сохранить», статус и заявки не меняются; двойной клик не плодит дубли; сбой confirm после
//             сохранения → остаётся прогноз, ошибка видна, форма по сохранённой записи, повтор = одна командировка;
//             статус виден в списке и в Матрице (type-trip-forecast / type-trip-confirmed) сразу, без перезагрузки;
//             supervisor: «Подтвердить» у чужой зоны скрыта, подтверждённая — только чтение; viewer — только чтение.
// Итоговая строка: «RESULT: N passed, M failed».
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const L = require('./v6_accept_lib.js');
const sleep = L.sleep;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const REAL_DB = path.join(L.ROOT, 'data/app.db');
const SHOTS = process.env.TRIPSSTATUS_SHOTS || '';          // каталог для скриншотов (по умолчанию не снимаются)

// V8-T7 (P3-3): год сценариев — год ТЕКУЩЕЙ даты (Матрица открывается в текущем календарном году), а не зашитый 2026.
// TRIPS_FAKE_NOW=2027-03-15T12:00:00Z — подменить «сейчас» в самом тесте и в браузере (фиктивный Date до загрузки страницы).
const FAKE_NOW = process.env.TRIPS_FAKE_NOW ? new Date(process.env.TRIPS_FAKE_NOW) : null;
const NOW = FAKE_NOW || new Date();
const Y = NOW.getFullYear();
const NOV0 = Math.round((Date.UTC(Y, 10, 1) - Date.UTC(Y, 0, 1)) / 86400000);   // день года 31 октября Y
const D = (n) => Y + '-11-' + String(n).padStart(2, '0');
const DOY = (n) => NOV0 + n;                                  // Y-11-n → день года
const fakeDateScript = (ts) => '(function(){var R=Date,off=' + (ts - Date.now()) + ';function F(){if(!(this instanceof F))return new R(R.now()+off).toString();if(arguments.length===0)return new R(R.now()+off);return new (Function.prototype.bind.apply(R,[null].concat([].slice.call(arguments))))();}F.prototype=R.prototype;F.now=function(){return R.now()+off;};F.UTC=R.UTC;F.parse=R.parse;window.Date=F;})();';
const PHONE = '+7' + '9991234567';

async function main() {
  if (!fs.existsSync(process.env.CHROME_BIN || path.join(require('os').homedir(), '.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell'))) {
    check('Chromium найден (CHROME_BIN / ~/.cache/ms-playwright)', false, 'нет браузера — сьют не может выполняться');
    return;
  }
  const dbBefore = sha1(REAL_DB);
  const env = await L.startEnv();
  try {
    const admin = (await L.login(env.base, 'admin')).join('; ');
    const sup0 = (await L.login(env.base, 'supervisor_zone0')).join('; ');
    const sup1 = (await L.login(env.base, 'supervisor_zone1')).join('; ');
    const viewer = (await L.login(env.base, 'viewer_test')).join('; ');
    const api = (ck, method, url, body) => L.http(env.base, ck, method, url, body);

    const { cdp } = await env.openBrowser();
    if (FAKE_NOW) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: fakeDateScript(FAKE_NOW.getTime()) });
    const k = L.pageKit(cdp, env.base, SHOTS || process.env.TMPDIR || '/tmp');
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    const shot = async (n) => { if (SHOTS) await k.shot(n); };
    await k.size(1400, 900);
    const ev = (x) => cdp.ev(x);
    const q = (sel) => JSON.stringify(sel);
    const guard = async (label, fn) => { try { await fn(); } catch (e) { check('Сценарий «' + label + '» выполнен без сбоя теста', false, e && e.message); } };

    // ----------------------------------------------------------------------------------------------
    // помощники
    // ----------------------------------------------------------------------------------------------
    const p = (emp, s, e) => ({ employeeId: emp, startDate: s || D(23), endDate: e || D(25) });
    const body = (title, parts, extra) => Object.assign({ title, location: 'Казань', comment: '', status: 'forecast', participants: parts, phone: PHONE, transportOutRequired: 1, transportOutMode: 'avia', transportBackRequired: 1, transportBackMode: 'zd' }, extra || {});
    const reqCount = (tripId) => parseInt(L.sql(env.tmpDb, "select count(*) from trip_requests where trip_id='" + tripId + "';").trim(), 10);
    const reqEmps = (tripId) => L.sql(env.tmpDb, "select employee_id from trip_requests where trip_id='" + tripId + "' order by employee_id;").trim().split('\n').filter(Boolean);
    const listTrips = async (ck) => (await api(ck || admin, 'GET', 'api/trips.php')).json.trips || [];
    const tripsByTitle = async (title) => (await listTrips()).filter((t) => t.title === title);
    const getTrip = async (id) => (await listTrips()).find((t) => t.id === id);
    async function waitTrip(title, ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 6000)) { const t = (await tripsByTitle(title))[0]; if (t) return t; await sleep(200); }
      return null;
    }
    async function waitStatus(id, status, ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 6000)) { const t = await getTrip(id); if (t && t.status === status) return t; await sleep(200); }
      return await getTrip(id);
    }
    const create = async (ck, title, parts, extra) => (await api(ck, 'POST', 'api/trips.php', body(title, parts, extra))).json.trip;

    async function load(cookies) {
      await k.setCookies(cookies.split('; '));
      await cdp.send('Page.navigate', { url: env.base + '/index.html' });
      const ok = await k.waitFor('!!(window.Trips && document.querySelectorAll(".day-cell-data").length > 0 && document.getElementById("tabTrips"))', 40000);
      if (!ok) throw new Error('страница не загрузилась');
      await k.waitFor('!!Trips.getCurrentUser()', 8000);
      await ev('Trips.loadTrips().then(()=>Trips.overlay())');
      await sleep(400);
    }
    const refresh = async () => { await ev('Trips.loadTrips().then(()=>Trips.overlay())'); await sleep(300); };
    const openPanel = async () => { await ev('document.getElementById("vacationPanel").classList.add("open")'); await sleep(300); };
    async function newForm() {
      await openPanel();
      await ev('Trips.closeTripForm && Trips.closeTripForm(); document.getElementById("tabTrips").click()');
      await sleep(200);
      await ev('(document.getElementById("newTripBtn")||{click(){}}).click()');
      const ok = await k.waitFor('!!document.getElementById("tripTitle")', 8000);
      await sleep(300);
      return ok;
    }
    async function openExisting(id) {
      await openPanel();
      await ev('Trips.closeTripForm(); document.getElementById("tabTrips").click(); Trips.openTripModal(' + q(id) + ')');
      const ok = await k.waitFor('!!document.getElementById("tripTitle")', 8000);
      await sleep(300);
      return ok;
    }
    async function typeInto(id, text, clear) {
      await ev('(() => { const e = document.getElementById(' + q(id) + '); e.focus(); ' + (clear ? 'e.select();' : '') + ' })()');
      await cdp.send('Input.insertText', { text });
      await sleep(60);
    }
    const val = (id) => ev('document.getElementById(' + q(id) + ').value');
    const pickBtn = () => ev('[...document.querySelectorAll("#tripFormPanel button")].find(b => /Добавить сотрудника/.test(b.textContent)).click()');
    async function pickEmployees(ids) {
      await pickBtn();
      await sleep(150);
      for (const id of ids) {
        await ev('document.querySelector(\'.employee[data-id="' + String(id) + '"]\').dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,ctrlKey:true}))');
      }
      await ev('document.querySelector(".trip-pick-edge-btn-primary").click()');
      await sleep(250);
    }
    const rows = () => ev('[...document.querySelectorAll("#tripParticipants .trip-participant-row")].map(r => ({emp: String(r.getAttribute("data-emp-id")).replace(/^emp_/, ""), s: r.querySelectorAll(".trip-participant-date")[0].value, e: r.querySelectorAll(".trip-participant-date")[1].value}))');
    const setDates = (i, s, e) => ev('(() => { const r = document.querySelectorAll("#tripParticipants .trip-participant-row")[' + i + ']; const d = r.querySelectorAll(".trip-participant-date"); d[0].value = ' + q(s) + '; d[1].value = ' + q(e) + '; })()');
    const toasts = () => ev('[...document.querySelectorAll("#toastContainer .toast")].map(t => t.textContent)');
    const clearToasts = () => ev('(() => { const c = document.getElementById("toastContainer"); if (c) c.innerHTML = ""; })()');
    const fieldError = (id) => ev('(() => { const f = document.getElementById(' + q(id) + '); if (!f) return null; const e = [...f.parentNode.querySelectorAll("div.trip-form-error")].find(x => x.offsetParent !== null && x.textContent.trim()); return e ? e.textContent.trim() : null; })()');
    const visibleButtons = () => ev('[...document.querySelectorAll("#tripFormPanel .trip-panel-actions button")].filter(b => b.offsetParent !== null).map(b => b.textContent.trim())');
    const formSelects = () => ev('[...document.querySelectorAll("#tripFormPanel select")].map(s => s.id)');
    async function fillValid(title, opts) {
      await typeInto('tripTitle', title);
      if (!(opts && opts.nophone)) await typeInto('tripPhone', '89991234567');
      await ev('(() => { const o = document.getElementById("transportOutMode"), b = document.getElementById("transportBackMode"); o.value = "avia"; o.dispatchEvent(new Event("change",{bubbles:true})); b.value = "zd"; b.dispatchEvent(new Event("change",{bubbles:true})); })()');
    }
    // новая форма: название, телефон, проезд, (место), (комментарий), участники с датами
    async function fillNew(title, o) {
      o = o || {};
      await newForm();
      await fillValid(title, o);
      if (o.location) await typeInto('tripLocation', o.location);
      if (o.comment) await typeInto('tripComment', o.comment);
      await pickEmployees(o.emps || [2, 3]);
      const n = (o.emps || [2, 3]).length;
      const d0 = o.d0 || 23;
      for (let i = 0; i < n; i++) await setDates(i, D(d0 + i), D(d0 + 2 + i));
    }
    const clickSave = async () => { await clearToasts(); return k.click('#tripSaveBtn'); };
    const clickConfirm = async () => { await clearToasts(); return k.click('#tripConfirmBtn'); };
    const cellClass = (emp, day) => ev('(() => { const c = document.querySelector(\'#matrixBody .day-cell-data[data-emp="' + emp + '"][data-day="' + day + '"]\'); return c ? c.className : null; })()');
    const listItem = (title) => ev('(() => { const it = [...document.querySelectorAll("#tripsList .trip-list-item")].find(x => x.textContent.indexOf(' + q(title) + ') >= 0); if (!it) return null; const l = it.querySelector(".trip-status-label"); return { label: l ? l.textContent.trim() : null, cls: l ? l.className : null, icon: it.querySelector(".trip-status").className }; })()');
    const showList = async () => { await ev('Trips.closeTripForm && Trips.closeTripForm(); document.getElementById("tabTrips").click()'); await sleep(250); };

    // ==============================================================================================
    // СЕРВЕР
    // ==============================================================================================
    console.log('--- сервер: api/trips.php (forecast → confirmed) ---');
    await guard('сервер', async () => {
      let r = await api(admin, 'POST', 'api/trips.php', body('SRV A', [p('emp_2'), p('emp_3', D(24), D(26))], { location: '' }));
      check('сервер: создание прогноза БЕЗ места назначения разрешено (201, forecast)', r.status === 201 && r.json.trip && r.json.trip.status === 'forecast', r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      const a = r.json.trip;
      check('сервер: у нового прогноза 0 заявок в trip_requests', reqCount(a.id) === 0);

      r = await api(admin, 'PUT', 'api/trips.php?id=' + a.id + '&action=confirm');
      check('п.7 сервер: confirm с пустым location → 400 location_required', r.status === 400 && r.json.error === 'location_required', r.status + ' ' + JSON.stringify(r.json));
      check('п.7 сервер: ответ несёт понятное сообщение', /место назначения/i.test(r.json.message || ''), JSON.stringify(r.json));
      let a1 = await getTrip(a.id);
      check('п.7 сервер: после отказа статус прежний (forecast), версия не выросла, заявок 0', a1.status === 'forecast' && a1.version === a.version && reqCount(a.id) === 0, JSON.stringify([a1.status, a1.version, reqCount(a.id)]));

      r = await api(admin, 'PUT', 'api/trips.php?id=' + a.id, { location: '   ', entryVersion: a1.version });
      check('п.7 сервер: место из одних пробелов тоже не считается заполненным (confirm → 400)', (await api(admin, 'PUT', 'api/trips.php?id=' + a.id + '&action=confirm')).json.error === 'location_required');

      r = await api(admin, 'PUT', 'api/trips.php?id=' + a.id, { location: 'Самара', comment: 'ком', entryVersion: (await getTrip(a.id)).version });
      check('сервер: PUT прогноза с местом/комментарием сохраняет их, статус остаётся forecast', r.status === 200 && r.json.trip.location === 'Самара' && r.json.trip.comment === 'ком' && r.json.trip.status === 'forecast', JSON.stringify(r.json).slice(0, 200));
      check('сервер: ... и заявок по-прежнему 0', reqCount(a.id) === 0);

      r = await api(admin, 'PUT', 'api/trips.php?id=' + a.id + '&action=confirm');
      check('сервер: confirm прогноза с местом → 200, confirmed', r.status === 200 && r.json.success && r.json.trip.status === 'confirmed', r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      check('сервер: по одной заявке на каждого участника (2 участника → 2 заявки, разные сотрудники)', reqCount(a.id) === 2 && reqEmps(a.id).join() === 'emp_2,emp_3', JSON.stringify([reqCount(a.id), reqEmps(a.id)]));
      const vAfter = (await getTrip(a.id)).version;
      const rows0 = L.sql(env.tmpDb, "select request_id from trip_requests where trip_id='" + a.id + "' order by request_id;");

      r = await api(admin, 'PUT', 'api/trips.php?id=' + a.id + '&action=confirm');
      check('сервер: повторный confirm — no-op (200, статус confirmed, версия не выросла)', r.status === 200 && r.json.trip.status === 'confirmed' && r.json.trip.version === vAfter, r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      const rs = await Promise.all([1, 2, 3].map(() => api(admin, 'PUT', 'api/trips.php?id=' + a.id + '&action=confirm')));
      check('сервер: ещё 3 подряд confirm — заявки те же (2, без дублей, те же request_id)', reqCount(a.id) === 2 && L.sql(env.tmpDb, "select request_id from trip_requests where trip_id='" + a.id + "' order by request_id;") === rows0 && rs.every((x) => x.status === 200), String(reqCount(a.id)));

      r = await api(admin, 'PUT', 'api/trips.php?id=' + a.id, { comment: 'после подтверждения', entryVersion: vAfter });
      const a2 = await getTrip(a.id);
      check('сервер: admin правит подтверждённую (200); PUT без status → статус остаётся confirmed', r.status === 200 && a2.status === 'confirmed' && a2.comment === 'после подтверждения', r.status + ' ' + a2.status);
      check('сервер: правка подтверждённой не ставит повторных заявок (всё ещё 2)', reqCount(a.id) === 2);

      // POST/confirm без участников зоны supervisor'а, права
      const own = await create(sup0, 'SRV own', [p('emp_4', D(10), D(12))]);
      check('сервер: supervisor_zone0 создаёт прогноз своей зоны', own && own.status === 'forecast', JSON.stringify(own));
      r = await api(sup1, 'PUT', 'api/trips.php?id=' + own.id + '&action=confirm');
      check('сервер: supervisor_zone1 НЕ может подтвердить прогноз чужой зоны (403 zone_forbidden)', r.status === 403 && r.json.error === 'zone_forbidden', r.status + ' ' + JSON.stringify(r.json));
      check('сервер: ... статус forecast, заявок 0', (await getTrip(own.id)).status === 'forecast' && reqCount(own.id) === 0);
      r = await api(viewer, 'PUT', 'api/trips.php?id=' + own.id + '&action=confirm');
      check('сервер: viewer не может подтвердить (403)', r.status === 403, r.status + ' ' + JSON.stringify(r.json));
      r = await api(sup0, 'PUT', 'api/trips.php?id=' + own.id + '&action=confirm');
      check('сервер: supervisor_zone0 подтверждает прогноз своей зоны (200, confirmed, 1 заявка)', r.status === 200 && r.json.trip.status === 'confirmed' && reqCount(own.id) === 1, r.status + ' заявок=' + reqCount(own.id) + ' ' + JSON.stringify(r.json).slice(0, 160));
      r = await api(sup0, 'PUT', 'api/trips.php?id=' + own.id, { comment: 'правка', entryVersion: (await getTrip(own.id)).version });
      check('сервер: supervisor НЕ правит подтверждённую (403 confirmed_immutable)', r.status === 403 && r.json.error === 'confirmed_immutable', r.status + ' ' + JSON.stringify(r.json));
      check('сервер: отклонённая правка supervisor не изменила комментарий', (await getTrip(own.id)).comment !== 'правка');
      check('сервер: supervisor не удаляет подтверждённую (403)', (await api(sup0, 'DELETE', 'api/trips.php?id=' + own.id)).status === 403);

      r = await api(admin, 'PUT', 'api/trips.php?id=trip_nope&action=confirm');
      check('сервер: confirm несуществующей → 404', r.status === 404, r.status);

      // request_id = 'SC-trip-<n>-<time()>': у разных trip в одну секунду он совпадал → PRIMARY KEY падал и заявки
      // терялись молча (confirmed без заявок). Подтверждаем 6 командировок подряд (все укладываются в 1–2 секунды).
      const many = [];
      for (let i = 0; i < 6; i++) many.push(await create(admin, 'SRV burst ' + i, [p('emp_2', D(8 + i), D(8 + i)), p('emp_3', D(8 + i), D(8 + i))], { location: 'Тюмень' }));
      for (const t of many) await api(admin, 'PUT', 'api/trips.php?id=' + t.id + '&action=confirm');
      const perTrip = many.map((t) => reqCount(t.id));
      const allIds = L.sql(env.tmpDb, "select request_id from trip_requests where trip_id in (" + many.map((t) => "'" + t.id + "'").join(',') + ");").trim().split('\n').filter(Boolean);
      check('сервер: 6 командировок, подтверждённых подряд (в одну секунду), получают ВСЕ заявки (по 2 каждая)', perTrip.every((n) => n === 2), JSON.stringify(perTrip));
      check('сервер: request_id всех 12 заявок различны', new Set(allIds).size === 12 && allIds.length === 12, allIds.length + '/' + new Set(allIds).size);
      check('сервер: префикс request_id для робота сохранён («SC-trip-<n>-<время>…»)', allIds.every((x) => /^SC-trip-[12]-\d+/.test(x)), JSON.stringify(allIds.slice(0, 3)));

      // ----------------------------------------------------------------------------------------------
      // V8-T7 P2-2: статус меняется ТОЛЬКО через PUT ?action=confirm (в обход — нельзя ни POST, ни PUT)
      // ----------------------------------------------------------------------------------------------
      r = await api(admin, 'POST', 'api/trips.php', body('SRV bypass post', [p('emp_2', D(1), D(2))], { status: 'confirmed', location: '' }));
      check('P2-2 admin POST status=confirmed → 400 invalid_status', r.status === 400 && r.json.error === 'invalid_status', r.status + ' ' + JSON.stringify(r.json));
      check('P2-2 ... командировка не создана', (await tripsByTitle('SRV bypass post')).length === 0);
      r = await api(admin, 'POST', 'api/trips.php', body('SRV bypass post', [p('emp_2', D(1), D(2))], { status: 'confirmed' }));
      check('P2-2 admin POST status=confirmed даже с местом → 400 (создаётся только прогноз)', r.status === 400 && r.json.error === 'invalid_status' && (await tripsByTitle('SRV bypass post')).length === 0, r.status + ' ' + JSON.stringify(r.json));
      r = await api(admin, 'POST', 'api/trips.php', body('SRV bypass post', [p('emp_2', D(1), D(2))], { status: 'bogus' }));
      check('P2-2 POST с неизвестным status → 400 invalid_status', r.status === 400 && r.json.error === 'invalid_status', r.status + ' ' + JSON.stringify(r.json));
      r = await api(admin, 'POST', 'api/trips.php', body('SRV post fc', [p('emp_2', D(1), D(2))], { status: 'forecast' }));
      check('P2-2 POST status=forecast (как шлёт форма) → 201 forecast', r.status === 201 && r.json.trip.status === 'forecast', r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
      const noStatus = body('SRV post nostatus', [p('emp_2', D(1), D(2))]); delete noStatus.status;
      r = await api(admin, 'POST', 'api/trips.php', noStatus);
      check('P2-2 POST без status → 201 forecast (по умолчанию)', r.status === 201 && r.json.trip.status === 'forecast', r.status + ' ' + JSON.stringify(r.json).slice(0, 160));

      // (б) supervisor пытается подтвердить своим PUT: статус и заявки не меняются
      const mine = await create(sup0, 'SRV bypass put', [p('emp_4', D(3), D(4))], { location: 'Пенза' });
      r = await api(sup0, 'PUT', 'api/trips.php?id=' + mine.id, { status: 'confirmed', entryVersion: mine.version });
      check('P2-2 supervisor PUT status=confirmed на своём прогнозе → 400 status_change_forbidden', r.status === 400 && r.json.error === 'status_change_forbidden', r.status + ' ' + JSON.stringify(r.json));
      const mine1 = await getTrip(mine.id);
      check('P2-2 ... статус остался forecast, версия не выросла, заявок 0', mine1.status === 'forecast' && mine1.version === mine.version && reqCount(mine.id) === 0, JSON.stringify([mine1.status, mine1.version, reqCount(mine.id)]));
      r = await api(sup0, 'PUT', 'api/trips.php?id=' + mine.id, { status: 'confirmed', comment: 'левый заход', entryVersion: mine.version });
      check('P2-2 ... вместе с другими полями тело не применяется целиком (комментарий не изменён)', r.status === 400 && (await getTrip(mine.id)).comment !== 'левый заход');
      r = await api(admin, 'PUT', 'api/trips.php?id=' + mine.id, { status: 'confirmed', entryVersion: mine.version });
      check('P2-2 admin PUT status=confirmed на прогнозе → тоже 400 status_change_forbidden', r.status === 400 && r.json.error === 'status_change_forbidden' && (await getTrip(mine.id)).status === 'forecast', r.status + ' ' + JSON.stringify(r.json));
      r = await api(admin, 'PUT', 'api/trips.php?id=' + mine.id, { status: 'bogus' });
      check('P2-2 PUT с неизвестным status → 400 invalid_status', r.status === 400 && r.json.error === 'invalid_status', r.status + ' ' + JSON.stringify(r.json));
      r = await api(admin, 'PUT', 'api/trips.php?id=' + mine.id, { status: 'forecast', comment: 'тот же статус', entryVersion: mine.version });
      check('P2-2 PUT со status, равным текущему (forecast), допустим (совместимость) → 200', r.status === 200 && r.json.trip.status === 'forecast' && r.json.trip.comment === 'тот же статус', r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
      // confirm остаётся единственным путём
      r = await api(admin, 'PUT', 'api/trips.php?id=' + mine.id + '&action=confirm');
      check('P2-2 PUT ?action=confirm по-прежнему подтверждает (200 confirmed, 1 заявка)', r.status === 200 && r.json.trip.status === 'confirmed' && reqCount(mine.id) === 1, r.status + ' заявок=' + reqCount(mine.id));
      // (в) обратный переход confirmed → forecast невозможен
      const vc = (await getTrip(mine.id)).version;
      r = await api(admin, 'PUT', 'api/trips.php?id=' + mine.id, { status: 'forecast', entryVersion: vc });
      check('P2-2 admin PUT status=forecast на подтверждённой → 400 status_change_forbidden (обратного перехода нет)', r.status === 400 && r.json.error === 'status_change_forbidden', r.status + ' ' + JSON.stringify(r.json));
      const mc = await getTrip(mine.id);
      check('P2-2 ... статус остался confirmed, версия та же, заявка на месте', mc.status === 'confirmed' && mc.version === vc && reqCount(mine.id) === 1, JSON.stringify([mc.status, mc.version, reqCount(mine.id)]));
      r = await api(admin, 'PUT', 'api/trips.php?id=' + mine.id, { status: 'confirmed', comment: 'админ правит', entryVersion: vc });
      check('P2-2 PUT со status=confirmed на подтверждённой (равен текущему) допустим → 200', r.status === 200 && r.json.trip.status === 'confirmed' && r.json.trip.comment === 'админ правит', r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
      check('P2-2 ... повторных заявок не появилось', reqCount(mine.id) === 1);

      // ----------------------------------------------------------------------------------------------
      // V8-T7 P3-6: подтверждённая не остаётся без места (PUT admin с пустым location → 400 location_required)
      // ----------------------------------------------------------------------------------------------
      const vl = (await getTrip(mine.id)).version;
      r = await api(admin, 'PUT', 'api/trips.php?id=' + mine.id, { location: '', entryVersion: vl });
      check('P3-6 admin PUT location="" на подтверждённой → 400 location_required', r.status === 400 && r.json.error === 'location_required', r.status + ' ' + JSON.stringify(r.json));
      check('P3-6 ... ответ несёт понятное сообщение', /место назначения/i.test(r.json.message || ''), JSON.stringify(r.json));
      r = await api(admin, 'PUT', 'api/trips.php?id=' + mine.id, { location: '   ', entryVersion: vl });
      check('P3-6 место из одних пробелов — тоже 400 location_required', r.status === 400 && r.json.error === 'location_required', r.status + ' ' + JSON.stringify(r.json));
      const ml = await getTrip(mine.id);
      check('P3-6 ... место и версия не изменились', ml.location === 'Пенза' && ml.version === vl, JSON.stringify([ml.location, ml.version]));
      r = await api(admin, 'PUT', 'api/trips.php?id=' + mine.id, { location: 'Пенза-2', entryVersion: vl });
      check('P3-6 смена места на непустое на подтверждённой допустима (200)', r.status === 200 && r.json.trip.location === 'Пенза-2', r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
      const fcl = await create(admin, 'SRV fc noloc put', [p('emp_2', D(5), D(6))], { location: 'Уфа' });
      r = await api(admin, 'PUT', 'api/trips.php?id=' + fcl.id, { location: '', entryVersion: fcl.version });
      check('P3-6 у ПРОГНОЗА пустое место по-прежнему допустимо (PUT location="" → 200)', r.status === 200 && r.json.trip.location === '', r.status + ' ' + JSON.stringify(r.json).slice(0, 160));

      // ----------------------------------------------------------------------------------------------
      // V8-T7 P3-5: телефон обязателен только для подтверждения (решение владельца 2026-11-18)
      // ----------------------------------------------------------------------------------------------
      r = await api(admin, 'POST', 'api/trips.php', body('SRV nophone', [p('emp_3', D(5), D(6))], { phone: '' }));
      check('P3-5 создание прогноза БЕЗ телефона разрешено (201 forecast)', r.status === 201 && r.json.trip.status === 'forecast' && !r.json.trip.phone, r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
      const np = r.json.trip;
      const np0 = body('SRV nophone2', [p('emp_3', D(5), D(6))]); delete np0.phone;
      r = await api(admin, 'POST', 'api/trips.php', np0);
      check('P3-5 создание прогноза без поля phone вообще — тоже 201', r.status === 201 && r.json.trip.status === 'forecast', r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
      const np2 = r.json.trip;
      r = await api(admin, 'PUT', 'api/trips.php?id=' + np.id, { comment: 'без телефона', entryVersion: np.version });
      check('P3-5 правка прогноза без телефона разрешена (200)', r.status === 200, r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
      r = await api(admin, 'PUT', 'api/trips.php?id=' + np.id + '&action=confirm');
      check('P3-5 confirm командировки без телефона → 400 phone_required', r.status === 400 && r.json.error === 'phone_required', r.status + ' ' + JSON.stringify(r.json));
      check('P3-5 ... ответ несёт понятное сообщение про телефон', /телефон/i.test(r.json.message || ''), JSON.stringify(r.json));
      const npa = await getTrip(np.id);
      check('P3-5 ... статус forecast, заявок 0', npa.status === 'forecast' && reqCount(np.id) === 0, JSON.stringify([npa.status, reqCount(np.id)]));
      r = await api(admin, 'PUT', 'api/trips.php?id=' + np2.id, { location: 'Кострома', phone: '   ', entryVersion: np2.version });
      check('P3-5 телефон из одних пробелов — тоже пусто: confirm → 400 phone_required', (await api(admin, 'PUT', 'api/trips.php?id=' + np2.id + '&action=confirm')).json.error === 'phone_required' && reqCount(np2.id) === 0);
      r = await api(sup0, 'PUT', 'api/trips.php?id=' + (await create(sup0, 'SRV sup nophone', [p('emp_4', D(21), D(22))], { phone: '' })).id + '&action=confirm');
      check('P3-5 supervisor: confirm без телефона → 400 phone_required (как и admin)', r.status === 400 && r.json.error === 'phone_required', r.status + ' ' + JSON.stringify(r.json));
      // место проверяется первым, но обе ошибки понятны: без места и без телефона
      const both = await create(admin, 'SRV noboth', [p('emp_3', D(7), D(8))], { phone: '', location: '' });
      r = await api(admin, 'PUT', 'api/trips.php?id=' + both.id + '&action=confirm');
      check('P3-5 без места и без телефона: 400 (location_required — первая из проверок), статус не меняется', r.status === 400 && /^(location|phone)_required$/.test(r.json.error) && (await getTrip(both.id)).status === 'forecast');
      r = await api(admin, 'PUT', 'api/trips.php?id=' + np.id, { phone: PHONE, location: 'Курган', entryVersion: (await getTrip(np.id)).version });
      r = await api(admin, 'PUT', 'api/trips.php?id=' + np.id + '&action=confirm');
      check('P3-5 с телефоном и местом confirm проходит (200 confirmed, 1 заявка)', r.status === 200 && r.json.trip.status === 'confirmed' && reqCount(np.id) === 1, r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
      const vp = (await getTrip(np.id)).version;
      r = await api(admin, 'PUT', 'api/trips.php?id=' + np.id, { phone: '', entryVersion: vp });
      check('P3-5 admin PUT подтверждённой с пустым телефоном → 400 phone_required', r.status === 400 && r.json.error === 'phone_required', r.status + ' ' + JSON.stringify(r.json));
      check('P3-5 ... телефон и версия не изменились', (await getTrip(np.id)).phone === PHONE && (await getTrip(np.id)).version === vp);
      r = await api(admin, 'PUT', 'api/trips.php?id=' + np.id, { phone: '+7' + '9990001122', entryVersion: vp });
      check('P3-5 смена телефона подтверждённой на непустой допустима (200)', r.status === 200 && r.json.trip.phone === '+7' + '9990001122', r.status + ' ' + JSON.stringify(r.json).slice(0, 160));
    });

    // ==============================================================================================
    // БРАУЗЕР, admin
    // ==============================================================================================
    console.log('--- браузер: admin ---');
    await load(admin);
    cdp.exceptions.length = 0;
    await ev('window.__noReload = 12345');

    await guard('новая форма: кнопки, поля, нет селекта статуса', async () => {
      await newForm();
      const btns = await visibleButtons();
      check('новая командировка: кнопки «На подтверждение» и «Подтвердить» (и «Отменить»), «Сохранить» нет', btns.includes('На подтверждение') && btns.includes('Подтвердить') && !btns.includes('Сохранить'), JSON.stringify(btns));
      const sels = await formSelects();
      check('новая командировка: нет селекта статуса (в форме только селекты способа проезда)', sels.every((x) => /^transport(Out|Back)Mode$/.test(x)) && sels.length === 2, JSON.stringify(sels));
      check('новая командировка: нет подписи «Статус» и поля tripStatus', await ev('!document.getElementById("tripStatus") && ![...document.querySelectorAll("#tripFormPanel .trip-form-label")].some(l => /^Статус/.test(l.textContent.trim()))'));
      check('п.7: поля «Место назначения» и «Комментарий» есть в форме и необязательны для «На подтверждение»', await ev('!!document.getElementById("tripLocation") && !!document.getElementById("tripComment")') && await ev('[...document.querySelectorAll("#tripFormPanel .trip-form-label")].some(l => /Место назначения/.test(l.textContent))'));
      await shot('T2_new_form_two_buttons');
    });

    await guard('«На подтверждение» = прогноз', async () => {
      await fillNew('UI forecast', { emps: [2, 3], comment: 'ком-1', d0: 27 });
      await clickSave();
      const t = await waitTrip('UI forecast');
      check('«На подтверждение» (без места): командировка создана как forecast', !!t && t.status === 'forecast', JSON.stringify(t && t.status) + ' toasts=' + JSON.stringify(await toasts()) + ' err=' + JSON.stringify(await ev('[...document.querySelectorAll("#tripFormPanel .trip-form-error")].map(e => e.textContent)')) + ' form=' + (await ev('!!document.getElementById("tripFormPanel")')));
      check('«На подтверждение»: заявок в очереди 0', t && reqCount(t.id) === 0);
      check('«На подтверждение»: место пустое, комментарий сохранён', t && t.location === '' && t.comment === 'ком-1', JSON.stringify(t && [t.location, t.comment]));
      await sleep(300);
      check('«На подтверждение»: форма закрыта, виден список', await ev('!document.getElementById("tripFormPanel") && !!document.getElementById("tripsList")'));
      const li = await listItem('UI forecast');
      check('список: у прогноза подпись «Прогноз» и значок status-forecast', li && li.label === 'Прогноз' && /status-forecast/.test(li.icon), JSON.stringify(li));
      check('матрица: ячейки командировки сразу type-trip-forecast (без перезагрузки)', /type-trip-forecast/.test(await cellClass(2, DOY(27))) && !/type-trip-confirmed/.test(await cellClass(2, DOY(27))), await cellClass(2, DOY(27)));
      await shot('T2_list_forecast');
    });

    await guard('«Подтвердить» без места', async () => {
      await fillNew('UI noloc', { emps: [4] });
      await clickConfirm();
      await sleep(500);
      check('«Подтвердить» без места: ошибка у поля «Место назначения»', /место назначения/i.test(await fieldError('tripLocation') || ''), await fieldError('tripLocation'));
      check('«Подтвердить» без места: ни сохранения, ни confirm не ушли (командировки нет)', (await tripsByTitle('UI noloc')).length === 0);
      check('«Подтвердить» без места: форма осталась открытой с введёнными данными', await ev('!!document.getElementById("tripFormPanel") && document.getElementById("tripTitle").value === "UI noloc"'));
      await shot('T2_confirm_no_location');
      // «На подтверждение» без места при этом проходит
      await clickSave();
      const t = await waitTrip('UI noloc');
      check('«На подтверждение» без места — проходит (forecast)', !!t && t.status === 'forecast');
    });

    await guard('«Подтвердить» = сохранить и подтвердить', async () => {
      await fillNew('UI confirm', { emps: [2, 3], location: 'Новосибирск', comment: 'ком-2', d0: 20 });
      await clickConfirm();
      const t0 = await waitTrip('UI confirm');
      const t = t0 && await waitStatus(t0.id, 'confirmed');
      check('«Подтвердить» (новая): командировка confirmed', !!t && t.status === 'confirmed', JSON.stringify(t && t.status));
      check('«Подтвердить»: место и комментарий сохранены', t && t.location === 'Новосибирск' && t.comment === 'ком-2', JSON.stringify(t && [t.location, t.comment]));
      check('«Подтвердить»: по одной заявке на каждого участника (2)', t && reqCount(t.id) === 2 && reqEmps(t.id).join() === 'emp_2,emp_3', JSON.stringify(t && [reqCount(t.id), reqEmps(t.id)]));
      check('«Подтвердить»: ровно одна командировка с этим названием', (await tripsByTitle('UI confirm')).length === 1);
      await sleep(400);
      check('«Подтвердить»: тост «Командировка подтверждена», форма закрыта', (await toasts()).some((x) => /подтверждена/i.test(x)) && await ev('!document.getElementById("tripFormPanel")'), JSON.stringify(await toasts()));
      const li = await listItem('UI confirm');
      check('список сразу: «Подтверждена» и значок status-confirmed', li && li.label === 'Подтверждена' && /status-confirmed/.test(li.icon), JSON.stringify(li));
      check('матрица сразу: type-trip-confirmed (без перезагрузки страницы)', /type-trip-confirmed/.test(await cellClass(2, DOY(20))) && !/type-trip-forecast/.test(await cellClass(2, DOY(20))) && /type-trip-confirmed/.test(await cellClass(3, DOY(21))), await cellClass(2, DOY(20)));
      check('страница не перезагружалась (маркер window.__noReload жив)', (await ev('window.__noReload')) === 12345);
      await shot('T2_list_confirmed');
      if (SHOTS) {
        await ev('document.getElementById("tabMatrix").click()');
        await sleep(300);
        await ev('(() => { const c = document.querySelector(\'#matrixBody .day-cell-data[data-emp="2"][data-day="' + DOY(27) + '"]\'); if (c) c.scrollIntoView({block:"center", inline:"center"}); })()');
        await sleep(400);
        await shot('T2_matrix_forecast_and_confirmed');
        await showList();
      }
    });

    await guard('существующий прогноз', async () => {
      const f = await create(admin, 'UI existing', [p('emp_2', D(1), D(3)), p('emp_3', D(1), D(3))], { location: 'Омск', comment: 'старый' });
      await refresh();
      await openExisting(f.id);
      const btns = await visibleButtons();
      check('прогноз: те же две кнопки «На подтверждение» и «Подтвердить»', btns.includes('На подтверждение') && btns.includes('Подтвердить') && !btns.includes('Сохранить'), JSON.stringify(btns));
      check('прогноз: поля места и комментария заполнены сохранёнными значениями', (await val('tripLocation')) === 'Омск' && (await val('tripComment')) === 'старый');
      check('п.5: в форме прогноза нет селекта статуса; в заголовке подпись «Прогноз»', (await formSelects()).length === 2 && /Прогноз/.test(await ev('(document.getElementById("tripStatusBadge")||{textContent:""}).textContent')));
      await shot('T2_existing_forecast');
      // «На подтверждение» = сохранить изменения прогноза
      await typeInto('tripComment', 'новый', true);
      await clickSave();
      const s1 = await waitStatus(f.id, 'forecast');
      await sleep(300);
      const s2 = await getTrip(f.id);
      check('прогноз → «На подтверждение»: изменения сохранены, статус forecast, заявок 0', s2.comment === 'новый' && s2.status === 'forecast' && reqCount(f.id) === 0, JSON.stringify([s2.comment, s2.status, reqCount(f.id)]));
      check('прогноз → «На подтверждение»: форма закрыта; в payload PUT не уходит status (статус не менялся)', await ev('!document.getElementById("tripFormPanel")'));
      // «Подтвердить»
      await refresh();
      await openExisting(f.id);
      await typeInto('tripComment', 'перед подтверждением', true);
      await clickConfirm();
      const s3 = await waitStatus(f.id, 'confirmed');
      check('прогноз → «Подтвердить»: confirmed, правка комментария сохранена', s3.status === 'confirmed' && s3.comment === 'перед подтверждением', JSON.stringify([s3.status, s3.comment]));
      check('прогноз → «Подтвердить»: 2 заявки (по участнику)', reqCount(f.id) === 2, reqCount(f.id));
      await sleep(300);
      check('матрица: ячейки прогноза стали type-trip-confirmed сразу', /type-trip-confirmed/.test(await cellClass(2, DOY(1))), await cellClass(2, DOY(1)));
    });

    await guard('прогноз без места → «Подтвердить»', async () => {
      const f = await create(admin, 'UI old noloc', [p('emp_4', D(5), D(7))], { location: '' });
      await refresh();
      await openExisting(f.id);
      check('прогноз без места: поле места пустое', (await val('tripLocation')) === '');
      await clickConfirm();
      await sleep(400);
      check('прогноз без места → «Подтвердить»: ошибка у поля, confirm не ушёл (forecast, 0 заявок)', /место назначения/i.test(await fieldError('tripLocation') || '') && (await getTrip(f.id)).status === 'forecast' && reqCount(f.id) === 0, await fieldError('tripLocation'));
      await typeInto('tripLocation', 'Пермь');
      await clickConfirm();
      const s = await waitStatus(f.id, 'confirmed');
      check('... после ввода места «Подтвердить» проходит: confirmed, место сохранено, 1 заявка', s.status === 'confirmed' && s.location === 'Пермь' && reqCount(f.id) === 1, JSON.stringify([s.status, s.location, reqCount(f.id)]));
    });

    await guard('двойной клик', async () => {
      await fillNew('UI dbl', { emps: [2, 3], location: 'Уфа' });
      // два клика подряд в одном тике: второй приходит, пока первый запрос не завершён
      await ev('(() => { const b = document.getElementById("tripConfirmBtn"); b.click(); b.click(); b.click(); })()');
      await sleep(1500);
      const ts = await tripsByTitle('UI dbl');
      check('двойной клик «Подтвердить» (новая): одна командировка, confirmed', ts.length === 1 && ts[0].status === 'confirmed', JSON.stringify(ts.map((x) => x.status)));
      check('двойной клик: заявок ровно 2 (без дублей)', ts[0] && reqCount(ts[0].id) === 2, ts[0] && reqCount(ts[0].id));

      await fillNew('UI dbl2', { emps: [2], location: 'Тула' });
      const r = await k.rect('#tripConfirmBtn');
      await k.clickXY(r.x, r.y); await k.clickXY(r.x, r.y);
      await sleep(1500);
      const ts2 = await tripsByTitle('UI dbl2');
      check('два реальных клика мышью подряд: одна командировка, 1 заявка', ts2.length === 1 && ts2[0].status === 'confirmed' && reqCount(ts2[0].id) === 1, JSON.stringify(ts2.map((x) => x.status)));

      const f = await create(admin, 'UI dbl3', [p('emp_4', D(12), D(13))], { location: 'Сочи' });
      await refresh(); await openExisting(f.id);
      await ev('(() => { const b = document.getElementById("tripConfirmBtn"); b.click(); b.click(); })()');
      await sleep(1500);
      check('двойной клик «Подтвердить» (прогноз): confirmed, 1 заявка', (await getTrip(f.id)).status === 'confirmed' && reqCount(f.id) === 1);
    });

    await guard('подтверждённая: только «Сохранить»', async () => {
      const f = await create(admin, 'UI conf edit', [p('emp_2', D(14), D(15)), p('emp_3', D(14), D(15))], { location: 'Курск' });
      await api(admin, 'PUT', 'api/trips.php?id=' + f.id + '&action=confirm');
      const reqBefore = reqCount(f.id);
      await refresh(); await openExisting(f.id);
      const btns = await visibleButtons();
      check('подтверждённая (admin): только «Сохранить» — без «На подтверждение» и «Подтвердить»', btns.includes('Сохранить') && !btns.includes('На подтверждение') && !btns.includes('Подтвердить'), JSON.stringify(btns));
      check('подтверждённая: в заголовке «Подтверждена», селекта статуса нет, поля не заблокированы', /Подтверждена/.test(await ev('(document.getElementById("tripStatusBadge")||{textContent:""}).textContent')) && (await formSelects()).length === 2 && await ev('!document.getElementById("tripTitle").disabled && !document.getElementById("tripSaveBtn").disabled'));
      await shot('T2_confirmed_admin_save_only');
      await typeInto('tripComment', 'правка админа');
      await typeInto('tripLocation', 'Курск Б', true);
      await clickSave();
      await sleep(1000);
      const s = await getTrip(f.id);
      check('подтверждённая → «Сохранить»: изменения сохранены, статус confirmed', s.status === 'confirmed' && /правка админа/.test(s.comment) && /Курск Б$/.test(s.location), JSON.stringify([s.status, s.comment, s.location]));
      check('подтверждённая → «Сохранить»: повторных заявок нет', reqCount(f.id) === reqBefore && reqBefore === 2, JSON.stringify([reqBefore, reqCount(f.id)]));
      check('подтверждённая → «Сохранить»: форма закрыта, тост «сохранена»', await ev('!document.getElementById("tripFormPanel")') && (await toasts()).some((x) => /сохранена/i.test(x)), JSON.stringify(await toasts()));
    });

    await guard('сбой confirm после сохранения', async () => {
      await fillNew('UI failconf', { emps: [3], location: 'Тверь' });
      await ev('(() => { window.__of = window.fetch; window.fetch = function(u) { if (String(u).indexOf("action=confirm") >= 0) return Promise.resolve(new Response(JSON.stringify({error: "boom"}), {status: 500, headers: {"Content-Type": "application/json"}})); return window.__of.apply(this, arguments); }; })()');
      await clickConfirm();
      await sleep(1000);
      const ts = await tripsByTitle('UI failconf');
      check('сбой confirm: командировка сохранена и осталась прогнозом (1 шт., forecast, 0 заявок)', ts.length === 1 && ts[0].status === 'forecast' && reqCount(ts[0].id) === 0, JSON.stringify(ts.map((x) => x.status)));
      const msg = await ev('(() => { const e = document.querySelector("#tripFormPanel [data-trip-err]"); return e ? e.textContent : null; })()');
      check('сбой confirm: пользователь видит ошибку («сохранена как прогноз, но не подтверждена») в форме и тостом', /сохранена как прогноз, но не подтверждена/.test(msg || '') && (await toasts()).some((x) => /не подтверждена/.test(x)), JSON.stringify([msg, await toasts()]));
      check('сбой confirm: форма перерисована по сохранённой записи (Прогноз, обе кнопки, поля на месте)', await ev('!!document.getElementById("tripConfirmBtn") && /Прогноз/.test((document.getElementById("tripStatusBadge")||{textContent:""}).textContent) && document.getElementById("tripLocation").value === "Тверь"'));
      await shot('T2_confirm_failed_stays_forecast');
      check('сбой confirm: в Матрице остаётся прогноз', /type-trip-forecast/.test(await cellClass(3, DOY(23))), await cellClass(3, DOY(23)));
      // «подтвердить позже»: повторный клик подтверждает ТУ ЖЕ командировку (не создаёт вторую)
      await ev('window.fetch = window.__of');
      await clickConfirm();
      const s = await waitStatus(ts[0].id, 'confirmed');
      check('после сбоя повторное «Подтвердить»: та же командировка стала confirmed', s && s.status === 'confirmed');
      check('после сбоя: командировка одна (дубля не создано), заявка одна', (await tripsByTitle('UI failconf')).length === 1 && reqCount(ts[0].id) === 1);
    });

    await guard('ошибка confirm от сервера: понятный текст', async () => {
      // место было стёрто «в обход» формы: сервер отвечает location_required — текст должен быть человеческим
      const f = await create(admin, 'UI srvloc', [p('emp_4', D(20), D(21))], { location: 'Ярославль' });
      await refresh(); await openExisting(f.id);
      await api(admin, 'PUT', 'api/trips.php?id=' + f.id, { location: '', entryVersion: f.version });
      await clearToasts();
      await ev('Trips.confirmTrip(' + q(f.id) + ').then(() => "ok", e => e.message)').then(async (m) => {
        check('confirmTrip: сообщение сервера location_required показывается понятным текстом', /место назначения/i.test(m), m);
      });
    });

    // ---- V8-T7 P3-5 (UI): телефон обязателен только для «Подтвердить» ----
    await guard('P3-5 UI: телефон только для «Подтвердить»', async () => {
      await fillNew('UI nophone', { emps: [2], location: 'Липецк', nophone: true, d0: 1 });
      await clickConfirm();
      await sleep(500);
      check('P3-5 «Подтвердить» без телефона: ошибка у поля телефона', /телефон/i.test((await fieldError('tripPhone')) || ''), JSON.stringify(await fieldError('tripPhone')));
      check('P3-5 ... ни сохранения, ни confirm на сервер не ушли (командировки нет)', (await tripsByTitle('UI nophone')).length === 0);
      check('P3-5 ... форма осталась открытой с введёнными данными', await ev('!!document.getElementById("tripFormPanel") && document.getElementById("tripTitle").value === "UI nophone"'));
      if (SHOTS) {
        // ошибка у поля телефона при «Подтвердить» без телефона — 1440 и 375 px
        await k.size(1440, 900); await sleep(300);
        await k.shotEl('#tripFormPanel', 'T7_confirm_no_phone_1440', { maxW: 1440 });
        await k.size(375, 812, true); await sleep(400);
        await k.shotEl('#tripFormPanel', 'T7_confirm_no_phone_375');
        await k.size(1400, 900); await sleep(300);
      }
      await clickSave();
      const t = await waitTrip('UI nophone');
      check('P3-5 «На подтверждение» без телефона проходит: прогноз создан, телефона нет', !!t && t.status === 'forecast' && !t.phone, JSON.stringify(t && [t.status, t.phone]));
      check('P3-5 ... заявок 0', t && reqCount(t.id) === 0);
      await sleep(300);
      await refresh();
      await openExisting(t.id);
      await clickConfirm();
      await sleep(500);
      const t1 = await getTrip(t.id);
      check('P3-5 прогноз без телефона → «Подтвердить»: ошибка у поля, статус forecast, 0 заявок', /телефон/i.test((await fieldError('tripPhone')) || '') && t1.status === 'forecast' && reqCount(t.id) === 0, JSON.stringify([await fieldError('tripPhone'), t1.status, reqCount(t.id)]));
      await typeInto('tripPhone', '89991234567');
      await clickConfirm();
      const s = await waitStatus(t.id, 'confirmed');
      check('P3-5 ... после ввода телефона «Подтвердить» проходит: confirmed, телефон +7 + 10 цифр, 1 заявка', s.status === 'confirmed' && s.phone === PHONE && reqCount(t.id) === 1, JSON.stringify([s.status, s.phone, reqCount(t.id)]));
      // неполный номер — ошибка у поля даже для «На подтверждение»
      await fillNew('UI badphone', { emps: [3], location: 'Липецк', nophone: true, d0: 1 });
      await typeInto('tripPhone', '123');
      await clickSave();
      await sleep(500);
      check('P3-5 неполный номер: ошибка у поля даже для «На подтверждение», запроса нет', /телефон/i.test((await fieldError('tripPhone')) || '') && (await tripsByTitle('UI badphone')).length === 0, JSON.stringify(await fieldError('tripPhone')));
    });

    // ---- V8-T7 P3-6/P3-5 (UI): подтверждённая — нельзя стереть место и телефон ----
    await guard('подтверждённая: нельзя стереть место и телефон', async () => {
      const f = await create(admin, 'UI conf clear', [p('emp_2', D(14), D(15))], { location: 'Орск' });
      await api(admin, 'PUT', 'api/trips.php?id=' + f.id + '&action=confirm');
      await refresh(); await openExisting(f.id);
      await ev('document.getElementById("tripLocation").value = ""');
      await clickSave();
      await sleep(500);
      check('P3-6 подтверждённая: «Сохранить» с пустым местом — ошибка у поля «Место назначения», запроса нет', /место назначения/i.test((await fieldError('tripLocation')) || '') && (await getTrip(f.id)).location === 'Орск', JSON.stringify(await fieldError('tripLocation')));
      if (SHOTS) {
        await k.size(1440, 900); await sleep(300);
        await k.shotEl('#tripFormPanel', 'T7_confirmed_no_location_1440', { maxW: 1440 });
        await k.size(375, 812, true); await sleep(400);
        await k.shotEl('#tripFormPanel', 'T7_confirmed_no_location_375');
        await k.size(1400, 900); await sleep(300);
      }
      await ev('document.getElementById("tripLocation").value = "Орск"; document.getElementById("tripPhone").value = ""');
      await clickSave();
      await sleep(500);
      check('P3-5 подтверждённая: «Сохранить» с пустым телефоном — ошибка у поля телефона, запроса нет', /телефон/i.test((await fieldError('tripPhone')) || '') && (await getTrip(f.id)).phone === PHONE, JSON.stringify(await fieldError('tripPhone')));
      check('P3-5/P3-6 ... форма осталась открытой, статус confirmed, заявки те же', await ev('!!document.getElementById("tripFormPanel")') && (await getTrip(f.id)).status === 'confirmed' && reqCount(f.id) === 1);
    });

    // ---- V8-T7 P2-2 (UI): ни один штатный путь не шлёт status иначе, чем forecast при создании ----
    await guard('UI не шлёт status', async () => {
      await ev('(() => { window.__tripReq = []; window.__spyOrig = window.fetch; window.fetch = function(u, o) { try { if (/api\\/trips\\.php/.test(String(u)) && o && /^(POST|PUT)$/.test(o.method || "")) window.__tripReq.push({ m: o.method, u: String(u), b: o.body ? JSON.parse(o.body) : null }); } catch (e) { /* */ } return window.__spyOrig.apply(this, arguments); }; })()');
      try {
        // (i) новая → «На подтверждение»; (ii) новая → «Подтвердить»
        await fillNew('UI spy 1', { emps: [2], location: 'Рязань', d0: 3 });
        await clickSave();
        const t1 = await waitTrip('UI spy 1');
        await fillNew('UI spy 2', { emps: [3], location: 'Рязань', d0: 3 });
        await clickConfirm();
        const t2 = await waitTrip('UI spy 2');
        await waitStatus(t2.id, 'confirmed');
        // (iii) правка прогноза → «На подтверждение»; (iv) правка подтверждённой → «Сохранить»
        await refresh(); await openExisting(t1.id);
        await typeInto('tripComment', 'spy-правка');
        await clickSave();
        await sleep(800);
        await refresh(); await openExisting(t2.id);
        await typeInto('tripComment', 'spy-правка-2');
        await clickSave();
        await sleep(800);
        // (v) создание из Матрицы (мультивыбор/popup) — та же форма
        await ev('Trips.closeTripForm && Trips.closeTripForm(); window.createTripFromSelection(4, ' + DOY(12) + ', ' + DOY(13) + ')');
        await sleep(500);
        await typeInto('tripTitle', 'UI spy 3');
        await typeInto('tripLocation', 'Рязань');
        await typeInto('tripPhone', '89991234567');
        await ev('(() => { const o = document.getElementById("transportOutMode"), b = document.getElementById("transportBackMode"); o.value = "avia"; b.value = "zd"; })()');
        await clickConfirm();
        const t3 = await waitTrip('UI spy 3');
        if (t3) await waitStatus(t3.id, 'confirmed');
        const reqs = await ev('window.__tripReq');
        const posts = reqs.filter((x) => x.m === 'POST'), puts = reqs.filter((x) => x.m === 'PUT');
        check('P2-2 UI: записано достаточно запросов (3 POST; PUT: 2 confirm + 2 правки)', posts.length === 3 && puts.length === 4, JSON.stringify(reqs.map((x) => x.m + ' ' + x.u.replace(/^.*trips\.php/, ''))));
        check('P2-2 UI: каждый POST создаёт прогноз (status=forecast)', posts.every((x) => x.b && x.b.status === 'forecast'), JSON.stringify(posts.map((x) => x.b && x.b.status)));
        check('P2-2 UI: ни один PUT (правка/подтверждение) не несёт поле status', puts.every((x) => !x.b || !('status' in x.b)), JSON.stringify(puts.map((x) => x.b && Object.keys(x.b))));
        check('P2-2 UI: подтверждение — только PUT …&action=confirm (по одному на «Подтвердить»)', puts.filter((x) => /action=confirm/.test(x.u)).length === 2, JSON.stringify(puts.map((x) => x.u.replace(/^.*trips\.php/, ''))));
      } finally {
        await ev('if (window.__spyOrig) window.fetch = window.__spyOrig');
      }
    });

    check('admin: нет исключений JS в браузере', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));

    // ==============================================================================================
    // БРАУЗЕР, supervisor
    // ==============================================================================================
    console.log('--- браузер: supervisor ---');
    await guard('supervisor_zone0 (своя зона)', async () => {
      const own = await create(sup0, 'SUP own', [p('emp_2', D(16), D(17))], { location: 'Брянск' });
      const conf = await create(admin, 'SUP confirmed', [p('emp_3', D(16), D(17))], { location: 'Псков' });
      await api(admin, 'PUT', 'api/trips.php?id=' + conf.id + '&action=confirm');
      await load(sup0);
      cdp.exceptions.length = 0;

      await newForm();
      let btns = await visibleButtons();
      check('supervisor своей зоны: новая форма — «На подтверждение» и «Подтвердить»', btns.includes('На подтверждение') && btns.includes('Подтвердить'), JSON.stringify(btns));

      await openExisting(own.id);
      btns = await visibleButtons();
      check('supervisor: прогноз своей зоны — обе кнопки', btns.includes('На подтверждение') && btns.includes('Подтвердить'), JSON.stringify(btns));
      check('supervisor: у прогноза своей зоны есть «Удалить» (зона участника сопоставляется по emp_N ↔ числовому id Матрицы)', btns.includes('Удалить'), JSON.stringify(btns));
      await shot('T2_supervisor_own_forecast');
      await clickConfirm();
      const s = await waitStatus(own.id, 'confirmed');
      check('supervisor: «Подтвердить» прогноз своей зоны → confirmed, 1 заявка', s.status === 'confirmed' && reqCount(own.id) === 1, JSON.stringify([s.status, reqCount(own.id)]));

      await refresh();
      await openExisting(conf.id);
      btns = await visibleButtons();
      const ro = await ev('({ title: document.getElementById("tripTitle").disabled, loc: document.getElementById("tripLocation").disabled, comment: document.getElementById("tripComment").disabled, phone: document.getElementById("tripPhone").disabled, save: document.getElementById("tripSaveBtn").disabled, note: (document.getElementById("tripReadOnlyNote")||{textContent:""}).textContent, confirm: !!document.getElementById("tripConfirmBtn") })');
      check('supervisor: подтверждённая — форма только для чтения (поля и «Сохранить» заблокированы)', ro.title && ro.loc && ro.comment && ro.phone && ro.save, JSON.stringify(ro));
      check('supervisor: подтверждённая — кнопки «Подтвердить» и «На подтверждение» нет, есть пояснение про администратора', !ro.confirm && !btns.includes('На подтверждение') && !btns.includes('Подтвердить') && /администратор/.test(ro.note), JSON.stringify([btns, ro.note]));
      await shot('T2_supervisor_confirmed_readonly');
      check('supervisor: нет исключений JS', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));
    });

    await guard('supervisor_zone1 (чужая зона)', async () => {
      const foreign = await create(admin, 'SUP foreign', [p('emp_4', D(18), D(19))], { location: 'Орёл' });
      await load(sup1);
      cdp.exceptions.length = 0;
      await openExisting(foreign.id);
      const btns = await visibleButtons();
      const ro = await ev('({ title: document.getElementById("tripTitle").disabled, save: document.getElementById("tripSaveBtn").disabled, confirm: !!document.getElementById("tripConfirmBtn"), note: (document.getElementById("tripReadOnlyNote")||{textContent:""}).textContent })');
      check('supervisor чужой зоны: у прогноза НЕТ кнопки «Подтвердить» и «Удалить»', !ro.confirm && !btns.includes('Подтвердить') && !btns.includes('Удалить'), JSON.stringify(btns));
      check('supervisor чужой зоны: форма только для чтения с пояснением про другой отдел', ro.title && ro.save && /другого отдела/.test(ro.note), JSON.stringify(ro));
      await shot('T2_supervisor_foreign_forecast');
      check('supervisor чужой зоны: сервер всё равно откажет (confirm → 403, forecast, 0 заявок)', (await api(sup1, 'PUT', 'api/trips.php?id=' + foreign.id + '&action=confirm')).status === 403 && (await getTrip(foreign.id)).status === 'forecast' && reqCount(foreign.id) === 0);

      // новая форма: пока в составе сотрудник чужой зоны, «Подтвердить» скрыта; убрали — снова видна
      await newForm();
      let b0 = await ev('(() => { const b = document.getElementById("tripConfirmBtn"); return !!b && b.style.display !== "none"; })()');
      await pickEmployees([2]);
      let b1 = await ev('(() => { const b = document.getElementById("tripConfirmBtn"); return !!b && b.style.display !== "none"; })()');
      check('supervisor_zone1, новая форма: без участников «Подтвердить» видна, с сотрудником чужой зоны (emp_2, g0) — скрыта', b0 === true && b1 === false, JSON.stringify([b0, b1]));
      await shot('T2_supervisor_foreign_participant_new_form');
      // «На подтверждение» с чужим участником: сервер отказывает, текст понятный, командировка не создана
      await fillValid('SUP foreign new');
      await setDates(0, D(23), D(25));
      await clickSave();
      await sleep(700);
      check('supervisor_zone1: «На подтверждение» с участником чужой зоны — понятная ошибка, командировка не создана', (await toasts()).some((x) => /другого отдела/.test(x)) && (await tripsByTitle('SUP foreign new')).length === 0, JSON.stringify(await toasts()));
      await ev('Trips.removeParticipantRow(0)');
      await sleep(150);
      const b2 = await ev('(() => { const b = document.getElementById("tripConfirmBtn"); return !!b && b.style.display !== "none"; })()');
      check('supervisor_zone1: после удаления чужого участника «Подтвердить» снова видна', b2 === true);
      check('supervisor_zone1: нет исключений JS', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));
    });

    // ==============================================================================================
    // БРАУЗЕР, viewer
    // ==============================================================================================
    console.log('--- браузер: viewer ---');
    await guard('viewer', async () => {
      const f = await create(admin, 'VIEW fc', [p('emp_2', D(8), D(9))], { location: 'Рязань' });
      await load(viewer);
      await openExisting(f.id);
      const btns = await visibleButtons();
      const v = await ev('({ save: document.getElementById("tripSaveBtn").disabled, title: document.getElementById("tripTitle").disabled, loc: document.getElementById("tripLocation").disabled, confirm: !!document.getElementById("tripConfirmBtn") })');
      check('viewer: форма только для чтения, «Подтвердить» нет', v.save && v.title && v.loc && !v.confirm && !btns.includes('Подтвердить'), JSON.stringify([btns, v]));
      check('viewer: сервер отклоняет confirm (403), статус forecast', (await api(viewer, 'PUT', 'api/trips.php?id=' + f.id + '&action=confirm')).status === 403 && (await getTrip(f.id)).status === 'forecast');
      await shot('T2_viewer_readonly');
    });

    // ==============================================================================================
    // статика
    // ==============================================================================================
    const tripsJs = fs.readFileSync(path.join(L.ROOT, 'js/trips.js'), 'utf8');
    check('js/trips.js: нет селектов статуса (draft-status, tripStatus)', !/id="draft-status"/.test(tripsJs) && !/id="tripStatus"/.test(tripsJs));
    check('js/trips.js: кнопка «Подтвердить» вызывает window.Trips.saveAndConfirmTrip, и он экспортирован', /window\.Trips\.saveAndConfirmTrip\(/.test(tripsJs) && /saveAndConfirmTrip: saveAndConfirmTrip/.test(tripsJs));
    check('api/trips.php: confirm проверяет location (location_required) до транзакции', /location_required/.test(fs.readFileSync(path.join(L.ROOT, 'api/trips.php'), 'utf8')));

    check('data/app.db не изменена прогоном (sha1)', sha1(REAL_DB) === dbBefore);
  } finally {
    env.cleanup();
  }
}

main().then(() => {
  console.log('');
  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.log('  FAIL  необработанная ошибка сьюта — ' + (e && e.stack || e));
  failed++;
  console.log('');
  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(1);
});
