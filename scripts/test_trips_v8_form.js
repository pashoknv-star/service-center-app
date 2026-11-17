#!/usr/bin/env node
// V8-T1 (Командировки: ошибки формы, п.1 владельца): сьют `tripsform`.
//
// Реальный headless Chromium по CDP + `php -S` на КОПИИ data/app.db (SC_APP_DB; data/app.db не меняется,
// проверяется sha1). Каркас — scripts/v6_accept_lib.js (тот же, что у приёмок V6/V7). Пароли в браузер не
// вводятся: cookie берётся запросом к api/login.php (dev-учётки, стартовый пароль — только dev-БД).
//
// По тесту (минимум) на каждый пункт ТЗ:
//   п.1  сохранение формы (phoneEl/регэксп `[^\\d]`, обязательные поля, видимые ошибки, молчаливые return),
//   п.2  📅 → Матрица в режиме выбора дат сотрудника → даты в строку участника → форма с прежними полями,
//   п.3  способ проезда: select не заблокирован навсегда (admin/supervisor), у viewer заблокирован,
//   п.4  «+7 » при фокусе, нормализация 8/7/+7/10 цифр, на сервер уходит +7XXXXXXXXXX (и в payload робота),
//   п.5  повтор сотрудника: UI (кнопка «+ Добавить сотрудника», черновик от карточки, матрица, createTripFromSelection)
//        и сервер (api/trips.php POST/PUT → 400 duplicate_participant),
//   п.6  тост «Командировка создана» не показывается при одном открытии формы.
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
const SHOTS = process.env.TRIPSFORM_SHOTS || '';          // каталог для скриншотов (по умолчанию не снимаются)

// 2026-11-23 = день года 327 (янв 31, фев 28, мар 31, апр 30, май 31, июн 30, июл 31, авг 31, сен 30, окт 31 = 304; +23)
const D = (n) => '2026-11-' + String(n).padStart(2, '0');
const DOY = (n) => 304 + n;

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
    const viewer = (await L.login(env.base, 'viewer_test')).join('; ');
    const api = (ck, method, url, body) => L.http(env.base, ck, method, url, body);

    const { cdp } = await env.openBrowser();
    const k = L.pageKit(cdp, env.base, SHOTS || process.env.TMPDIR || '/tmp');
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    const shot = async (n) => { if (SHOTS) await k.shot(n); };
    await k.size(1400, 900);
    const ev = (x) => cdp.ev(x);
    const q = (sel) => JSON.stringify(sel);
    // сценарий: исключение внутри (нет элемента и т.п.) фиксируется как FAIL, остальные сценарии продолжаются
    const guard = async (label, fn) => { try { await fn(); } catch (e) { check('Сценарий «' + label + '» выполнен без сбоя теста', false, e && e.message); } };

    // ----------------------------------------------------------------------------------------------
    // помощники страницы
    // ----------------------------------------------------------------------------------------------
    async function load(cookies) {
      await k.setCookies(cookies.split('; '));
      await cdp.send('Page.navigate', { url: env.base + '/index.html' });
      const ok = await k.waitFor('!!(window.Trips && document.querySelectorAll(".day-cell-data").length > 0 && document.getElementById("tabTrips"))', 40000);
      if (!ok) throw new Error('страница не загрузилась');
      await ev('Trips.loadTrips().then(()=>Trips.overlay())');
      await sleep(400);
    }
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
    const rows = () => ev('[...document.querySelectorAll("#tripParticipants .trip-participant-row")].map(r => ({emp: String(r.getAttribute("data-emp-id")).replace(/^emp_/, ""), name: r.querySelector(".trip-participant-name").value, s: r.querySelectorAll(".trip-participant-date")[0].value, e: r.querySelectorAll(".trip-participant-date")[1].value}))');
    const setDates = (i, s, e) => ev('(() => { const r = document.querySelectorAll("#tripParticipants .trip-participant-row")[' + i + ']; const d = r.querySelectorAll(".trip-participant-date"); d[0].value = ' + q(s) + '; d[1].value = ' + q(e) + '; })()');
    const toasts = () => ev('[...document.querySelectorAll("#toastContainer .toast")].map(t => t.textContent)');
    const clearToasts = () => ev('(() => { const c = document.getElementById("toastContainer"); if (c) c.innerHTML = ""; })()');
    const listTrips = async () => (await api(admin, 'GET', 'api/trips.php')).json.trips || [];
    const findTrip = async (title) => (await listTrips()).find((t) => t.title === title);
    async function waitTrip(title, ms) {
      const t0 = Date.now();
      while (Date.now() - t0 < (ms || 6000)) { const t = await findTrip(title); if (t) return t; await sleep(200); }
      return null;
    }
    const clickSave = async () => { await clearToasts(); return k.click('#tripFormPanel .trip-panel-actions .trip-btn-primary'); };
    // сообщение «у поля»: .trip-form-error — потомок родителя поля, виден на экране
    const fieldError = (id) => ev('(() => { const f = document.getElementById(' + q(id) + '); if (!f) return null; const e = [...f.parentNode.querySelectorAll("div.trip-form-error")].find(x => x.offsetParent !== null && x.textContent.trim()); return e ? e.textContent.trim() : null; })()');
    async function fillValid(title, opts) {
      opts = opts || {};
      await typeInto('tripTitle', title);
      await typeInto('tripPhone', opts.phone || '89991234567');
      await ev('(() => { const o = document.getElementById("transportOutMode"), b = document.getElementById("transportBackMode"); o.value = "avia"; o.dispatchEvent(new Event("change",{bubbles:true})); b.value = "zd"; b.dispatchEvent(new Event("change",{bubbles:true})); })()');
    }
    const cellRect = (emp, day) => ev('(() => { const c = document.querySelector(\'#matrixBody .day-cell-data[data-emp="' + emp + '"][data-day="' + day + '"]\'); if (!c) return null; const r = c.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width}; })()');
    async function drag(emp, d1, d2) {
      const a = await cellRect(emp, DOY(d1));
      if (!a) return false;
      const b = await cellRect(emp, DOY(d2));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
      if (d2 !== d1) {
        const steps = Math.abs(d2 - d1);
        for (let i = 1; i <= steps; i++) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x + (b.x - a.x) * i / steps, y: a.y, button: 'left', buttons: 1 });
        }
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await sleep(350);
      return true;
    }
    const matrixVisible = () => ev('getComputedStyle(document.getElementById("matrixWrapper")).display !== "none"');
    const formVisible = () => ev('getComputedStyle(document.getElementById("tripsListView")).display !== "none" && !!document.getElementById("tripFormPanel")');
    const pickBarPresent = () => ev('!!document.getElementById("tripDatePickBar")');
    const popupShown = () => ev('document.getElementById("cellPopup").classList.contains("show")');

    // ----------------------------------------------------------------------------------------------
    // серверная часть п.4/п.5 (curl-слой): дубль участника, формат телефона, payload робота
    // ----------------------------------------------------------------------------------------------
    console.log('--- сервер: api/trips.php (дубль участника, телефон) ---');
    const p = (emp, s, e) => ({ employeeId: emp, startDate: s || D(23), endDate: e || D(25) });
    const baseBody = (title, parts, extra) => Object.assign({ title, location: '', comment: '', status: 'forecast', participants: parts, phone: '+79991234567', transportOutRequired: 1, transportOutMode: 'avia', transportBackRequired: 1, transportBackMode: 'zd' }, extra || {});

    let r = await api(admin, 'POST', 'api/trips.php', baseBody('SRV dup', [p('emp_2'), p('emp_2')]));
    check('П5 сервер: POST с двумя одинаковыми employeeId → 400 duplicate_participant (а не 500)', r.status === 400 && r.json.error === 'duplicate_participant', r.status + ' ' + JSON.stringify(r.json));
    check('П5 сервер: в ответе понятное сообщение и employeeId', /уже в командировке/i.test(r.json.message || '') && r.json.employeeId === 'emp_2', JSON.stringify(r.json));
    check('П5 сервер: после отклонённого POST командировка не создана', !(await findTrip('SRV dup')));

    r = await api(admin, 'POST', 'api/trips.php', baseBody('SRV ok', [p('emp_2'), p('emp_3', D(24), D(26))], { location: 'Казань' })); // V8-T2: confirm требует место назначения
    check('П5 сервер: два разных участника — создаётся (200/201)', (r.status === 200 || r.status === 201) && r.json.success === true, r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
    const srvTrip = r.json.trip || {};
    check('П4 сервер: телефон +79991234567 принят и возвращается без изменений', srvTrip.phone === '+79991234567', JSON.stringify(srvTrip.phone));

    r = await api(admin, 'PUT', 'api/trips.php?id=' + srvTrip.id, { participants: [p('emp_2'), p('emp_3'), p('emp_2', D(26), D(27))], entryVersion: srvTrip.version });
    check('П5 сервер: PUT с повтором employeeId → 400 duplicate_participant', r.status === 400 && r.json.error === 'duplicate_participant', r.status + ' ' + JSON.stringify(r.json));
    const after = await findTrip('SRV ok');
    check('П5 сервер: после отклонённого PUT состав не изменился (2 участника)', after && after.participants.length === 2, JSON.stringify(after && after.participants));

    r = await api(admin, 'PUT', 'api/trips.php?id=' + srvTrip.id + '&action=confirm');
    const reqRow = L.sql(env.tmpDb, "select payload from trip_requests where trip_id='" + srvTrip.id + "' order by request_id limit 1;").trim();
    let payload = null; try { payload = JSON.parse(reqRow); } catch (e) { /* */ }
    check('П4 сервер: payload для робота несёт employee.phone = +79991234567', payload && payload.employee && payload.employee.phone === '+79991234567', reqRow.slice(0, 200));

    r = await api(sup0, 'POST', 'api/trips.php', baseBody('SRV sup dup', [p('emp_2'), p('emp_2')]));
    check('П5 сервер: supervisor — тот же отказ на дубль (400)', r.status === 400 && r.json.error === 'duplicate_participant', r.status + ' ' + JSON.stringify(r.json));
    r = await api(sup0, 'POST', 'api/trips.php', baseBody('SRV sup ok', [p('emp_2'), p('emp_4')]));
    check('П5 сервер: supervisor своего отдела — два разных участника создаются', (r.status === 200 || r.status === 201) && r.json.success === true, r.status + ' ' + JSON.stringify(r.json).slice(0, 200));

    // прежняя запись с «старым» форматом телефона и выключенным плечом — нужна для проверок формы (п.3/п.4)
    const legacy = (await api(admin, 'POST', 'api/trips.php', baseBody('LEGACY', [p('emp_4', D(10), D(12))], { phone: '+7 (999) 000-00-00', transportOutRequired: 0, transportOutMode: null, transportBackRequired: 1, transportBackMode: 'avia' }))).json.trip;
    check('П4 сервер: прежний формат телефона «+7 (999) 000-00-00» по-прежнему принимается', legacy && legacy.phone === '+7 (999) 000-00-00', JSON.stringify(legacy && legacy.phone));

    // ----------------------------------------------------------------------------------------------
    // браузер, admin
    // ----------------------------------------------------------------------------------------------
    console.log('--- браузер: admin ---');
    await load(admin);
    cdp.exceptions.length = 0;

    // ---- п.4: телефон ----
    await guard('п.4 телефон', async () => {
    await newForm();
    await ev('document.getElementById("tripPhone").focus()');
    await sleep(100);
    check('П4 при фокусе на пустом поле стоит «+7 »', (await val('tripPhone')) === '+7 ', JSON.stringify(await val('tripPhone')));
    for (let i = 0; i < 5; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
    await sleep(80);
    check('П4 префикс «+7 » удалить нельзя (5×Backspace)', (await val('tripPhone')) === '+7 ', JSON.stringify(await val('tripPhone')));
    const forms = { '89991234567': 'с 8', '79991234567': 'с 7', '+79991234567': 'с +7', '9991234567': '10 цифр' };
    for (const raw of Object.keys(forms)) {
      await ev('(() => { const e = document.getElementById("tripPhone"); e.value = ""; e.dispatchEvent(new Event("input",{bubbles:true})); e.focus(); })()');
      await cdp.send('Input.insertText', { text: raw });
      await sleep(80);
      check('П4 вставка ' + forms[raw] + ' (' + raw + ') → «+7 (999) 123-45-67»', (await val('tripPhone')) === '+7 (999) 123-45-67', JSON.stringify(await val('tripPhone')));
    }
    await ev('(() => { const e = document.getElementById("tripPhone"); e.value = ""; e.dispatchEvent(new Event("input",{bubbles:true})); e.focus(); })()');
    for (const ch of '999') { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); }
    await sleep(80);
    check('П4 посимвольный набор «999» после «+7 » → «+7 (999»', (await val('tripPhone')) === '+7 (999', JSON.stringify(await val('tripPhone')));
    await shot('T1_phone_prefix');
    await ev('(() => { const e = document.getElementById("tripPhone"); e.value = ""; e.dispatchEvent(new Event("input",{bubbles:true})); e.blur(); })()');
    await sleep(60);
    });

    // ---- п.3: способ проезда ----
    await guard('п.3 способ проезда', async () => {
    check('П3 admin: select «Выезд» не заблокирован при включённом чекбоксе', await ev('!document.getElementById("transportOutMode").disabled'));
    check('П3 admin: select «Возврат» не заблокирован при включённом чекбоксе', await ev('!document.getElementById("transportBackMode").disabled'));
    await ev('(() => { const s = document.getElementById("transportOutMode"); s.value = "zd"; s.dispatchEvent(new Event("change",{bubbles:true})); })()');
    check('П3 admin: способ «ЖД» выбирается', (await val('transportOutMode')) === 'zd');
    await ev('document.getElementById("transportOutRequired").click()');
    check('П3 «не требуется» блокирует выбор и сбрасывает значение', await ev('document.getElementById("transportOutMode").disabled && document.getElementById("transportOutMode").value === ""'));
    await ev('document.getElementById("transportOutRequired").click()');
    check('П3 повторное включение возвращает выбор (select снова доступен)', await ev('!document.getElementById("transportOutMode").disabled'));
    await shot('T1_transport_enabled');
    });

    // ---- п.5 (UI): повторный выбор сотрудника ----
    await guard('п.5 повторный выбор', async () => {
    await newForm();
    await pickEmployees([2]);
    check('П5 «+ Добавить сотрудника»: выбран emp_2 — одна строка', (await rows()).length === 1);
    await clearToasts();
    await pickEmployees([2]);
    const rs2 = await rows();
    check('П5 повторный выбор того же сотрудника не создаёт вторую строку', rs2.length === 1, JSON.stringify(rs2));
    check('П5 повторный выбор — сообщение «уже в командировке»', (await toasts()).some((t) => /уже в командировке/i.test(t)), JSON.stringify(await toasts()));
    await clearToasts();
    await pickEmployees([2, 3]);
    const rs3 = await rows();
    check('П5 выбор {emp_2, emp_3} при существующем emp_2 добавляет только emp_3', rs3.length === 2 && rs3.map((x) => x.emp).sort().join() === '2,3', JSON.stringify(rs3));
    check('П5 то же — сообщение называет уже добавленного', (await toasts()).some((t) => /уже в командировке/i.test(t)), JSON.stringify(await toasts()));
    await shot('T1_duplicate_participant');

    // черновик от карточки сотрудника (в него заранее положен сам сотрудник — главный путь появления дубля)
    await ev('Trips.closeTripForm()');
    await ev('document.getElementById("tabTrips").click()');
    await clearToasts();
    await ev('Trips.startEmployeePick({ employeeId: "emp_2", name: "Ivanov Ivan", participants: [{ employeeId: "emp_2", name: "Ivanov Ivan", startDate: "", endDate: "" }] })');
    await ev('["2","3"].forEach(id => document.querySelector(".employee[data-id=\\"" + id + "\\"]").dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,ctrlKey:true})))');
    await ev('document.querySelector(".trip-pick-edge-btn-primary").click()');
    await sleep(400);
    const rs4 = await rows();
    check('П5 черновик от карточки сотрудника: повторный выбор того же сотрудника → 2 строки (не 3)', rs4.length === 2 && rs4.map((x) => x.emp).sort().join() === '2,3', JSON.stringify(rs4));
    check('П5 черновик от карточки: сообщение «уже в командировке»', (await toasts()).some((t) => /уже в командировке/i.test(t)), JSON.stringify(await toasts()));

    // выбор в Матрице: форма из popup с повторяющимися строками (getSelectedEmployeeIds + текущий)
    await ev('Trips.renderTripFormInPanel({ title: "Командировка", location: "", comment: "", status: "forecast", participants: [{employeeId: 2, startDate: "' + D(23) + '", endDate: "' + D(25) + '"}, {employeeId: "emp_2", startDate: "' + D(23) + '", endDate: "' + D(25) + '"}, {employeeId: 3, startDate: "' + D(23) + '", endDate: "' + D(25) + '"}] })');
    await sleep(300);
    const rs5 = await rows();
    check('П5 форма от выбора в Матрице: дубль сотрудника (2 и emp_2) схлопывается в одну строку', rs5.length === 2, JSON.stringify(rs5));

    // сохранение с дублем, обойдя UI: строка вставлена вручную
    await newForm();
    await fillValid('FORM dup');
    await pickEmployees([2]);
    await setDates(0, D(23), D(25));
    await ev('(() => { Trips.addParticipantRow(); const r = document.querySelectorAll("#tripParticipants .trip-participant-row"); const n = r[r.length - 1]; n.setAttribute("data-emp-id", "emp_2"); n.querySelector(".trip-participant-name").value = "Ivanov Ivan"; const d = n.querySelectorAll(".trip-participant-date"); d[0].value = "' + D(23) + '"; d[1].value = "' + D(25) + '"; })()');
    await clearToasts();
    await clickSave();
    await sleep(900);
    check('П5 save с дублем строк: на сервер не уходит (командировки нет)', !(await findTrip('FORM dup')));
    check('П5 save с дублем строк: видимое сообщение «уже в командировке»', (await toasts()).some((t) => /уже в командировке/i.test(t)) || /уже в командировке/i.test(await ev('document.getElementById("tripParticipants").parentNode.textContent')), JSON.stringify(await toasts()));
    });

    // ---- п.6: тост при одном лишь открытии формы ----
    await guard('п.6 тост', async () => {
    await ev('Trips.closeTripForm()');
    await clearToasts();
    await ev('window.createTripFromSelection(2, ' + DOY(23) + ', ' + DOY(25) + ')');
    await sleep(500);
    check('П6 createTripFromSelection открывает форму с одним участником', await ev('!!document.getElementById("tripFormPanel")') && (await rows()).length === 1);
    check('П6 при открытии формы нет тоста «Командировка создана»', !(await toasts()).some((t) => /Командировка создана/.test(t)), JSON.stringify(await toasts()));
    check('П6 участник из выбора в Матрице: даты подставлены', (await rows())[0].s === D(23) && (await rows())[0].e === D(25), JSON.stringify(await rows()));
    const idx = fs.readFileSync(path.join(L.ROOT, 'index.html'), 'utf8');
    check("П6 в index.html нет showToast('Командировка создана'…)", !/showToast\(\s*['"]Командировка создана['"]/.test(idx));
    });

    // ---- п.1: сохранение формы ----
    await guard('п.1 сохранение', async () => {
    await newForm();
    cdp.exceptions.length = 0;
    await fillValid('FORM A');
    await pickEmployees([2, 3]);
    await setDates(0, D(23), D(25));
    await setDates(1, D(24), D(26));
    await clearToasts();
    await shot('T1_form_filled');
    await clickSave();
    let tripA = await waitTrip('FORM A');
    const tripAMissing = !tripA;
    if (!tripA) tripA = (await api(admin, 'POST', 'api/trips.php', baseBody('FORM A', [p('emp_2'), p('emp_3')]))).json.trip;
    check('П1 заполненная форма сохраняется (командировка на сервере)', !tripAMissing);
    check('П1 сохранены оба участника с их датами', !tripAMissing && tripA.participants.length === 2 && tripA.participants.some((x) => x.employeeId === 'emp_2' && x.startDate === D(23) && x.endDate === D(25)) && tripA.participants.some((x) => x.employeeId === 'emp_3' && x.startDate === D(24) && x.endDate === D(26)), JSON.stringify(tripA && tripA.participants));
    check('П4 телефон «89991234567» ушёл на сервер как +79991234567', !tripAMissing && tripA.phone === '+79991234567', JSON.stringify(tripA && tripA.phone));
    check('П3 выбранные способы проезда «туда: Авиа», «обратно: ЖД» сохранены', !tripAMissing && tripA.transportOutMode === 'avia' && tripA.transportBackMode === 'zd', JSON.stringify(tripA && [tripA.transportOutMode, tripA.transportBackMode]));
    await sleep(500);
    check('П1 после сохранения форма закрыта, виден список', await ev('!document.getElementById("tripFormPanel") && !!document.getElementById("tripsList")'));
    check('П1 командировка появилась в списке', (await ev('(document.getElementById("tripsList")||{textContent:""}).textContent')).includes('FORM A'));
    check('П1/П6 тост об успехе показан после сохранения', (await toasts()).some((t) => /Заведена новая командировка|создана|сохранена/i.test(t)), JSON.stringify(await toasts()));
    await shot('T1_saved_list');
    await ev('document.getElementById("tabMatrix").click()');
    await sleep(300);
    const mx = await ev('(() => { const c = (e, d) => document.querySelector(\'#matrixBody .day-cell-data[data-emp="\' + e + \'"][data-day="\' + d + \'"]\'); return { a: /type-trip-/.test(c(2, ' + DOY(23) + ').className), b: /type-trip-/.test(c(3, ' + DOY(26) + ').className), out: /type-trip-/.test(c(2, ' + DOY(27) + ').className) }; })()');
    check('П1 командировка видна в Матрице (обе строки участников, только в их датах)', mx.a && mx.b && !mx.out, JSON.stringify(mx));
    await shot('T1_matrix_trip');
    check('П1 при сохранении нет исключений JS (ReferenceError/TypeError)', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));

    // правка существующей командировки сохраняется (PUT) и не затирает неотображаемые поля
    await api(admin, 'PUT', 'api/trips.php?id=' + tripA.id, { location: 'Тюмень', comment: 'КОММЕНТАРИЙ', entryVersion: tripA.version });
    await load(admin);
    await openExisting(tripA.id);
    await typeInto('tripTitle', 'FORM A2', true);
    await clickSave();
    await sleep(1200);
    const tripA2 = await findTrip('FORM A2');
    check('П1 правка существующей командировки сохраняется (PUT)', !!tripA2 && tripA2.id === tripA.id);
    check('П1 правка: место и комментарий (нет в форме) не затёрты', tripA2 && tripA2.location === 'Тюмень' && tripA2.comment === 'КОММЕНТАРИЙ', JSON.stringify(tripA2 && [tripA2.location, tripA2.comment]));
    });

    // ---- п.1: валидация видимая ----
    await guard('п.1 валидация', async () => {
    const before = (await listTrips()).length;
    await newForm();
    await typeInto('tripTitle', 'FORM V');
    await pickEmployees([2]);
    await setDates(0, D(23), D(25));
    await ev('(() => { const o = document.getElementById("transportOutMode"); o.value = "avia"; const b = document.getElementById("transportBackMode"); b.value = "zd"; })()');
    await clearToasts();
    await clickSave();
    await sleep(500);
    check('П1 пустой телефон: сообщение видно у поля телефона', /Телефон/.test((await fieldError('tripPhone')) || ''), JSON.stringify(await fieldError('tripPhone')));
    await shot('T1_validation_phone');
    check('П1 пустой телефон: запрос не ушёл', (await listTrips()).length === before);
    await typeInto('tripPhone', '123');
    await clearToasts();
    await clickSave();
    await sleep(400);
    check('П1 телефон из 3 цифр: сообщение у поля', /Телефон/.test((await fieldError('tripPhone')) || ''), JSON.stringify(await fieldError('tripPhone')));
    await typeInto('tripPhone', '', true);
    await ev('document.getElementById("tripPhone").value = ""');
    await typeInto('tripPhone', '9991234567');
    await ev('document.getElementById("transportBackMode").value = ""');
    await clearToasts();
    await clickSave();
    await sleep(400);
    check('П1 не выбран способ проезда: сообщение у поля «Возврат»', /способ/i.test((await fieldError('transportBackMode')) || ''), JSON.stringify(await fieldError('transportBackMode')));
    await ev('document.getElementById("transportBackMode").value = "zd"; document.getElementById("transportOutMode").value = "avia"');
    await setDates(0, D(26), D(24));
    await clearToasts();
    await clickSave();
    await sleep(400);
    check('П1 дата окончания раньше начала: видимое сообщение', (await toasts()).some((t) => /позже|раньше|окончан/i.test(t)) || /позже|раньше|окончан/i.test(await ev('document.getElementById("tripParticipants").parentNode.textContent')), JSON.stringify(await toasts()));
    await setDates(0, '', '');
    await clearToasts();
    await clickSave();
    await sleep(400);
    check('П1 не указаны даты: видимое сообщение у строки участника', /дат/i.test(await ev('document.getElementById("tripParticipants").parentNode.textContent')) , await ev('document.getElementById("tripParticipants").parentNode.textContent'));
    // ни одной заполненной строки участников — раньше return без сообщения
    await newForm();
    await typeInto('tripTitle', 'FORM V2');
    await typeInto('tripPhone', '9991234567');
    await ev('Trips.addParticipantRow()');
    await clearToasts();
    await clickSave();
    await sleep(400);
    check('П1 только пустая строка участника: видимое сообщение (не молчаливый return)', (await toasts()).some((t) => /участник/i.test(t)) || /участник/i.test(await ev('document.getElementById("tripParticipants").parentNode.textContent')), JSON.stringify(await toasts()));
    check('П1 валидация: командировки с ошибочными данными не созданы', !(await findTrip('FORM V')) && !(await findTrip('FORM V2')));
    });

    // ---- п.2: 📅 — выбор дат в Матрице ----
    await guard('п.2 выбор дат', async () => {
    await newForm();
    await typeInto('tripTitle', 'PICK new');
    await typeInto('tripPhone', '9991234567');
    await pickEmployees([2, 3]);
    await clearToasts();
    cdp.exceptions.length = 0;
    await k.click('#tripParticipants .trip-participant-row:nth-child(1) button[title*="календар"]');
    await sleep(500);
    check('П2 📅 переключает на Матрицу (не остаётся на вкладке «Командировки»)', (await matrixVisible()) && !(await ev('getComputedStyle(document.getElementById("tripsListView")).display !== "none"')));
    check('П2 в Матрице показана панель режима выбора дат', await pickBarPresent());
    check('П2 в панели названо ФИО сотрудника', /Ivanov Ivan/.test(await ev('(document.getElementById("tripDatePickBar")||{textContent:""}).textContent')), await ev('(document.getElementById("tripDatePickBar")||{textContent:""}).textContent'));
    check('П2 строка выбранного сотрудника выделена в Матрице', await ev('!!document.querySelector("#matrixBody tr.trip-datepick-row .day-cell-data[data-emp=\\"2\\"]")'));
    await shot('T1_datepick_mode');
    // клик по ячейке ДРУГОГО сотрудника не завершает выбор
    const other = await cellRect(3, DOY(30));
    if (other) await k.clickXY(other.x, other.y);
    await sleep(300);
    check('П2 клик по строке другого сотрудника не завершает выбор (режим продолжается)', await pickBarPresent() && await matrixVisible());
    check('П2 клик по ячейке в режиме выбора не открывает меню отпуска/командировки (cellPopup)', !(await popupShown()));
    check('П2 подсказка: сообщение про строку нужного сотрудника', (await toasts()).some((t) => /Ivanov Ivan/.test(t)), JSON.stringify(await toasts()));
    // протяжка 23–25 ноября
    check('П2 выбор протяжкой по строке сотрудника (23–25.11)', await drag(2, 23, 25));
    check('П2 после выбора форма возвращается (вкладка «Командировки», форма на месте)', await formVisible());
    check('П2 режим выбора завершён (панель убрана, Матрица скрыта)', !(await pickBarPresent()) && !(await matrixVisible()));
    const rp = await rows();
    check('П2 выбранный диапазон подставлен в даты участника 1', rp[0] && rp[0].s === D(23) && rp[0].e === D(25), JSON.stringify(rp));
    check('П2 даты второго участника не тронуты', rp[1] && rp[1].s === '' && rp[1].e === '', JSON.stringify(rp));
    check('П2 остальные поля формы сохранены (название, телефон)', (await val('tripTitle')) === 'PICK new' && (await val('tripPhone')) === '+7 (999) 123-45-67', (await val('tripTitle')) + ' / ' + (await val('tripPhone')));
    check('П2 при выборе дат нет исключений JS', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));
    await shot('T1_datepick_done');
    // одиночный клик = один день, второй участник
    await k.click('#tripParticipants .trip-participant-row:nth-child(2) button[title*="календар"]');
    await sleep(400);
    await drag(3, 26, 26);
    const rp2 = await rows();
    check('П2 одиночный клик по ячейке = один день (26.11) у второго участника', rp2[1] && rp2[1].s === D(26) && rp2[1].e === D(26), JSON.stringify(rp2));
    check('П2 даты первого участника после второго выбора сохранились', rp2[0].s === D(23) && rp2[0].e === D(25), JSON.stringify(rp2));
    // Esc и «Отменить»
    await k.click('#tripParticipants .trip-participant-row:nth-child(1) button[title*="календар"]');
    await sleep(300);
    await ev('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await sleep(300);
    check('П2 Esc отменяет выбор и возвращает форму с прежними датами', await formVisible() && !(await pickBarPresent()) && (await rows())[0].s === D(23));
    await k.click('#tripParticipants .trip-participant-row:nth-child(1) button[title*="календар"]');
    await sleep(300);
    await ev('(document.querySelector("#tripDatePickBar button")||{click(){}}).click()');
    await sleep(300);
    check('П2 кнопка «Отменить» в панели возвращает форму', await formVisible() && !(await pickBarPresent()));
    // сохранение и результат
    await ev('(() => { const o = document.getElementById("transportOutMode"), b = document.getElementById("transportBackMode"); o.value = "avia"; b.value = "zd"; })()');
    await clickSave();
    let tripP = await waitTrip('PICK new');
    const tripPReal = tripP;
    const tripPToasts = JSON.stringify(await toasts());
    if (!tripP) tripP = (await api(admin, 'POST', 'api/trips.php', baseBody('PICK new', [p('emp_2'), p('emp_3')]))).json.trip;
    check('П2 новая командировка с датами из Матрицы сохранена', tripPReal && tripPReal.participants.find((x) => x.employeeId === 'emp_2' && x.startDate === D(23) && x.endDate === D(25)) && tripPReal.participants.find((x) => x.employeeId === 'emp_3' && x.startDate === D(26) && x.endDate === D(26)), JSON.stringify(tripPReal && tripPReal.participants) + ' toasts=' + tripPToasts);

    // существующая командировка
    await openExisting(tripP.id);
    await typeInto('tripTitle', 'PICK new ed', true);
    await k.click('#tripParticipants .trip-participant-row:nth-child(1) button[title*="календар"]');
    await sleep(500);
    check('П2 существующая командировка: 📅 открывает Матрицу в режиме выбора', (await matrixVisible()) && (await pickBarPresent()));
    await drag(2, 24, 27);
    const re = await rows();
    check('П2 существующая командировка: даты участника заменены (24–27.11), форма вернулась', await formVisible() && re[0].s === D(24) && re[0].e === D(27), JSON.stringify(re));
    check('П2 существующая командировка: набранное название сохранено при возврате', (await val('tripTitle')) === 'PICK new ed');
    await clickSave();
    await sleep(1200);
    const tripP2 = await findTrip('PICK new ed');
    check('П2 существующая командировка: новые даты сохранены на сервере', tripP2 && tripP2.participants.find((x) => x.employeeId === 'emp_2' && x.startDate === D(24) && x.endDate === D(27)), JSON.stringify(tripP2 && tripP2.participants));
    });

    // ---- п.3: прежняя запись с выключенным плечом ----
    await guard('п.3/п.4 прежняя запись', async () => {
    await openExisting(legacy.id);
    check('П3 прежняя запись: плечо «Выезд» не требуется → чекбокс снят, select отключён', await ev('!document.getElementById("transportOutRequired").checked && document.getElementById("transportOutMode").disabled'));
    check('П3 прежняя запись: плечо «Возврат» требуется → select доступен, значение «Авиа»', await ev('!document.getElementById("transportBackMode").disabled && document.getElementById("transportBackMode").value === "avia"'));
    await ev('document.getElementById("transportOutRequired").click()');
    check('П3 прежняя запись: включение плеча возвращает выбор', await ev('!document.getElementById("transportOutMode").disabled'));
    check('П4 прежняя запись: старый формат телефона показан в едином виде «+7 (999) 000-00-00»', (await val('tripPhone')) === '+7 (999) 000-00-00', await val('tripPhone'));
    await ev('(() => { const o = document.getElementById("transportOutMode"); o.value = "zd"; })()');
    await clickSave();
    await sleep(1200);
    const leg2 = await findTrip('LEGACY');
    check('П4 прежняя запись: после сохранения телефон хранится как +79990000000, ничего не сломано', leg2 && leg2.phone === '+79990000000' && leg2.transportOutMode === 'zd' && leg2.transportBackMode === 'avia', JSON.stringify(leg2 && [leg2.phone, leg2.transportOutMode, leg2.transportBackMode]));

    // прежняя запись с нестандартным (не российским) номером: клик по полю его не портит, сохранение без правки не блокируется
    const foreign = (await api(admin, 'POST', 'api/trips.php', baseBody('LEGACY2', [p('emp_3', D(2), D(3))], { phone: '+44 20 7946 0958' }))).json.trip;
    await ev('Trips.loadTrips().then(() => true)');
    await openExisting(foreign.id);
    await ev('document.getElementById("tripPhone").focus()');
    await sleep(80);
    check('П4 прежний нестандартный номер: фокус по полю не искажает значение', (await val('tripPhone')) === '+44 20 7946 0958', await val('tripPhone'));
    await ev('document.getElementById("tripPhone").blur()');
    await clickSave();
    await sleep(1200);
    const foreign2 = await findTrip('LEGACY2');
    check('П4 прежний нестандартный номер: сохранение без правки номера проходит и номер не меняется', foreign2 && foreign2.phone === '+44 20 7946 0958', JSON.stringify(foreign2 && foreign2.phone));
    });

    // ---- защита от мёртвых кнопок: каждый window.Trips.X( в разметке trips.js имеет экспорт ----
    await guard('мёртвые кнопки', async () => {
    const src = fs.readFileSync(path.join(L.ROOT, 'js/trips.js'), 'utf8');
    const used = [...new Set([...src.matchAll(/window\.Trips\.(\w+)\(/g)].map((m) => m[1]))];
    const missing = await ev('(' + JSON.stringify(used) + ').filter(n => typeof Trips[n] !== "function")');
    check('Каждый onclick/oninput="window.Trips.X(…)" имеет экспорт X в window.Trips (' + used.length + ' шт.)', missing.length === 0, JSON.stringify(missing));
    });

    // ----------------------------------------------------------------------------------------------
    // браузер, supervisor своего отдела
    // ----------------------------------------------------------------------------------------------
    console.log('--- браузер: supervisor_zone0 ---');
    await guard('supervisor', async () => {
    await load(sup0);
    cdp.exceptions.length = 0;
    await newForm();
    check('supervisor: форма новой командировки открывается', await ev('!!document.getElementById("tripTitle")'));
    check('П3 supervisor: select способа проезда доступен', await ev('!document.getElementById("transportOutMode").disabled && !document.getElementById("transportBackMode").disabled'));
    await fillValid('SUP trip', { phone: '+7 999 123 45 67' });
    await pickEmployees([2, 4]);
    await k.click('#tripParticipants .trip-participant-row:nth-child(1) button[title*="календар"]');
    await sleep(500);
    await drag(2, 17, 19);
    await setDates(1, D(18), D(20));
    const sr = await rows();
    check('П2 supervisor: даты участника выбраны через 📅 в Матрице', sr[0].s === D(17) && sr[0].e === D(19), JSON.stringify(sr));
    await pickEmployees([2]);
    check('П5 supervisor: повторный выбор отклонён', (await rows()).length === 2);
    await clickSave();
    const tripS = await waitTrip('SUP trip');
    check('П1 supervisor: командировка своего отдела сохраняется', !!tripS && tripS.participants.length === 2, JSON.stringify(tripS && tripS.participants));
    check('П4 supervisor: телефон «+7 999 123 45 67» нормализован до +79991234567', tripS && tripS.phone === '+79991234567', JSON.stringify(tripS && tripS.phone));
    check('supervisor: нет исключений JS', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));
    });

    // ----------------------------------------------------------------------------------------------
    // браузер, viewer — ограничения не сломаны
    // ----------------------------------------------------------------------------------------------
    console.log('--- браузер: viewer ---');
    await guard('viewer', async () => {
    await load(viewer);
    await ev('Trips.getCurrentUser(); null');
    await k.waitFor('!!Trips.getCurrentUser()', 8000);
    await openExisting(legacy.id);
    const vw = await ev('({ out: document.getElementById("transportOutMode").disabled, back: document.getElementById("transportBackMode").disabled, outC: document.getElementById("transportOutRequired").disabled, save: document.querySelector("#tripFormPanel .trip-panel-actions .trip-btn-primary").disabled, phone: document.getElementById("tripPhone").disabled, title: document.getElementById("tripTitle").disabled, pick: [...document.querySelectorAll("#tripParticipants button[title*=\\"календар\\"]")].every(b => b.disabled) })');
    check('П3 viewer: способ проезда заблокирован (оба select и чекбокс)', vw.out && vw.back && vw.outC, JSON.stringify(vw));
    check('viewer: «Сохранить», телефон, название и 📅 заблокированы', vw.save && vw.phone && vw.title && vw.pick, JSON.stringify(vw));
    check('viewer: кнопка «Новая командировка» скрыта', await ev('getComputedStyle(document.getElementById("newTripBtn")||document.body).display === "none" || !document.getElementById("newTripBtn")'));
    await shot('T1_viewer_form');
    check('viewer: сервер отклоняет создание (403)', (await api(viewer, 'POST', 'api/trips.php', baseBody('VIEW', [p('emp_2')]))).status === 403);
    });

    // ----------------------------------------------------------------------------------------------
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
