#!/usr/bin/env node
// V10-T8 (Транспорт: вкладка и доска «День / Неделя», перенос ТС между базами): сьют `transportboardui`.
//
// Реальный headless Chromium по CDP + `php -S` на КОПИИ data/app.db (SC_APP_DB; data/app.db не меняется,
// проверяется sha1). Каркас — scripts/v6_accept_lib.js (как у tasklinksui / tripsform). Пароли в браузер не вводятся:
// cookie берётся запросом к api/login.php (dev-учётки). Данные доски — через настоящие API T1/T5/T6 (синтетика).
//
// Что проверяется:
//   вкладка      — «Транспорт» у admin / supervisor / viewer, переключение с Матрицы / Командировок / Задач, скрипт подключён локально;
//   доска «День» — базы как группы (порядок, пустая база), ТС, ремонт, полосы назначений (положение по времени, дорожки при
//                  пересечении, переход через полночь), очередь нераспределённых, карточка назначения (водитель, бригада,
//                  остановки), подсветка отсутствий, чужие заявки видны всем ролям;
//   «Неделя»     — 7 дней, чипы назначений, нагрузка, переход в день по ячейке, подсветка отсутствий;
//   навигация    — ◀ ▶ «Сегодня» (+05), период запроса, единственный источник данных — api/transport_board.php;
//   перенос ТС   — admin и viewer: перетаскивание и меню «Переместить в базу…», подтверждение с пометкой «постоянный»,
//                  отмена, сохранение (БД, перезагрузка страницы, журнал vehicle.move), конфликт версий; supervisor — без управления;
//   точки T9     — Transport.openForm(ctx): заглушка и подмена; «Новая заявка» / «Назначить» / «Изменить» по правам;
//   поллинг      — Transport.__t.tick(): перечитывает, не рисует поверх скрытой вкладки, таймер снимается при уходе;
//   безопасность — <img onerror> в названии / абоненте / адресе не исполняется и выводится текстом;
//   вёрстка      — 375 и 1280 px без горизонтального скролла страницы (день, неделя, диалог, меню);
//   прочее       — нет исключений JS, data/app.db не изменена.
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
const SHOTS = process.env.TRANSPORTBOARDUI_SHOTS || '';

// даты сценария: пятница 2032-03-12 (неделя пн 08.03 … вс 14.03), сегодня — по +05
const D = '2032-03-12', D2 = '2032-03-13', DW = '2032-03-09';
const MON = '2032-03-08', SUN = '2032-03-14';
const todayLocal = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);

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
    const k = L.pageKit(cdp, env.base, SHOTS || process.env.TMPDIR || '/tmp');
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    const shot = async (n) => { if (SHOTS) await k.shot(n); };
    const ev = (x) => cdp.ev(x);
    const q = (s) => JSON.stringify(s);
    const guard = async (label, fn) => { try { await fn(); } catch (e) { check('Сценарий «' + label + '» выполнен без сбоя теста', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); } };
    const waitFor = (expr, ms) => k.waitFor(expr, ms || 10000);

    // ------------------------------------------------------------------------------------------
    // данные (настоящий API)
    // ------------------------------------------------------------------------------------------
    const ok2 = (r, what) => { if (r.status < 200 || r.status >= 300) throw new Error(what + ' → ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 300)); return r.json; };
    const mkBase = async (name, so) => ok2(await api(admin, 'POST', 'api/transport_vehicles.php?entity=base', { name, sort_order: so }), 'base ' + name).base;
    const mkVeh = async (name, plate, base, status) => ok2(await api(admin, 'POST', 'api/transport_vehicles.php?entity=vehicle', { name, plate, base_id: base.id, status: status || 'in_service' }), 'vehicle ' + name).vehicle;
    const mkReq = async (ck, title, extra) => ok2(await api(ck, 'POST', 'api/transport_requests.php', Object.assign({ title }, extra || {})), 'request ' + title).request;
    const mkAsg = async (ck, body) => {
      const dry = ok2(await api(ck, 'POST', 'api/transport_assignments.php', Object.assign({ dry_run: true }, body)), 'dry_run');
      const b = Object.assign({}, body);
      if (dry.warnings && dry.warnings.length) b.confirm_token = dry.confirm_token;
      return ok2(await api(ck, 'POST', 'api/transport_assignments.php', b), 'assignment');
    };
    const stops = (a, b, c) => [
      { ord: 1, kind: 'departure', place: a, stay_min: 0, leg_min: 0 },
      { ord: 2, kind: 'intermediate', place: b, stay_min: 15, leg_min: 30, leg_km: 20 },
      { ord: 3, kind: 'arrival', place: c, stay_min: 0, leg_min: 45 }];

    for (const e of ['emp_1', 'emp_2']) ok2(await api(admin, 'POST', 'api/transport_vehicles.php?entity=pool', { employee_id: e }), 'pool ' + e);
    const BA = await mkBase('Тест-База А', 1), BB = await mkBase('Тест-База Б', 2), BC = await mkBase('Пустая база', 3);
    const V1 = await mkVeh('ТС-Один', 'Т001ТТ86', BA), V2 = await mkVeh('ТС-Два', 'Т002ТТ86', BA);
    const V3 = await mkVeh('ТС-Три', 'Т003ТТ86', BA, 'repair'), V4 = await mkVeh('ТС-Четыре', 'Т004ТТ86', BB);
    const XSS = '<img src=x onerror="window.__xss=1">';
    const R1 = await mkReq(admin, XSS + 'Заявка-Один', { subscriber: '<b>Абонент</b> <img src=x onerror="window.__xss=2">', address: 'ул. <i>Х</i> ' + XSS });
    const R2 = await mkReq(sup1, 'Заявка-Два (zone1)', { subscriber: 'Абонент-2', address: 'Адрес-2' });
    const R3 = await mkReq(admin, 'Заявка-Три');
    const R6 = await mkReq(admin, 'Заявка-Шесть (неделя)');
    const R7 = await mkReq(admin, 'Заявка-Сегодня');
    const Q4 = await mkReq(admin, 'Очередь-Админ', { subscriber: 'Абонент-Q4' });
    const Q5 = await mkReq(sup0, XSS + 'Очередь-Супервизор', { subscriber: '<b>Q5</b>', address: XSS });
    const A1 = (await mkAsg(admin, { request_id: R1.id, vehicle_id: V1.id, driver_id: 'emp_1', crew: ['emp_3'], start_at: D + 'T08:00', duration_min: 180, stops: stops('Урай', 'Кондинское', 'Советский') })).assignment;
    const A2 = (await mkAsg(sup1, { request_id: R2.id, vehicle_id: V2.id, driver_id: 'emp_2', crew: ['emp_4'], start_at: D + 'T22:00', duration_min: 240, stops: [] })).assignment;
    const A3 = (await mkAsg(admin, { request_id: R3.id, vehicle_id: V1.id, driver_id: 'emp_2', crew: [], start_at: D + 'T09:00', duration_min: 120, stops: [] })).assignment;
    const A6 = (await mkAsg(admin, { request_id: R6.id, vehicle_id: V4.id, driver_id: 'emp_1', crew: [], start_at: DW + 'T09:00', duration_min: 60, stops: [] })).assignment;
    const TODAY = todayLocal();
    const A7 = (await mkAsg(admin, { request_id: R7.id, vehicle_id: V4.id, driver_id: 'emp_2', crew: [], start_at: TODAY + 'T10:00', duration_min: 60, stops: [] })).assignment;
    L.sql(env.tmpDb, "insert into schedule_entries (employee_id, date, status, comment, approval_status, updated_at, version) values ('emp_1','" + D + "','sick','секрет-коммент','approved','2032-01-01',1);" +
      "insert into schedule_entries (employee_id, date, status, comment, approval_status, updated_at, version) values ('emp_4','" + D2 + "','vacation',null,'approved','2032-01-01',1);");
    const dbVeh = (id) => L.sql(env.tmpDb, "select base_id from vehicles where id = '" + id + "';").trim();
    const journalMoves = () => parseInt(L.sql(env.tmpDb, "select count(*) from transport_journal where action = 'vehicle.move';").trim(), 10);

    // ------------------------------------------------------------------------------------------
    // помощники браузера
    // ------------------------------------------------------------------------------------------
    const exists = (sel) => ev('!!document.querySelector(' + q(sel) + ')');
    const count = (sel) => ev('document.querySelectorAll(' + q(sel) + ').length');
    const textOf = (sel) => ev('(() => { const e = document.querySelector(' + q(sel) + '); return e ? e.textContent : null; })()');
    const attrOf = (sel, a) => ev('(() => { const e = document.querySelector(' + q(sel) + '); return e ? e.getAttribute(' + q(a) + ') : null; })()');
    const vis = (sel) => ev('(() => { const e = document.querySelector(' + q(sel) + '); return !!(e && e.offsetParent !== null && getComputedStyle(e).display !== "none"); })()');
    const ids = (sel, attr) => ev('[...document.querySelectorAll(' + q(sel) + ')].map(e => e.getAttribute(' + q(attr) + '))');
    const boardReqs = () => ev('performance.getEntriesByType("resource").filter(r => /transport_board\\.php/.test(r.name)).length');
    const transportApiUrls = () => ev('performance.getEntriesByType("resource").map(r => r.name).filter(n => /api\\/transport_/.test(n)).map(n => n.replace(/^https?:\\/\\/[^/]+\\//, "").replace(/\\?.*$/, ""))');
    const overflowX = () => ev('(() => { const r = document.getElementById("transportView"), p = document.getElementById("vacationPanel"); return { view: r ? r.scrollWidth - r.clientWidth : -99, panel: p ? p.scrollWidth - p.clientWidth : 0, doc: document.documentElement.scrollWidth - window.innerWidth }; })()');
    const noHScroll = (o) => o.view <= 1 && o.panel <= 1 && o.doc <= 1;
    const S = () => ev('(() => { const s = Transport.__t.S; return { view: s.view, date: s.date, from: s.from, to: s.to, active: s.active, sel: s.sel, loading: s.loading, canMove: s.board ? s.board.can_move_vehicle : null }; })()');

    async function openBoard(ck, o) {
      o = o || {};
      await k.size(o.w || 1280, o.h || 900, (o.w || 1280) < 500);
      await k.load(ck.split('; '));
      await ev('Transport.open(' + JSON.stringify({ view: o.view || 'day', date: o.date || D }) + ')');
      const okb = await waitFor('!!(Transport.isActive() && Transport.__t.S.board && !Transport.__t.S.loading && document.querySelector("#transportView .tp-base"))', 20000);
      if (!okb) throw new Error('доска не открылась');
      await sleep(250);
    }
    const setView = async (view, date) => { await ev('Transport.open(' + JSON.stringify({ view, date: date || D }) + ')'); await waitFor('!!(Transport.__t.S.board && !Transport.__t.S.loading && Transport.__t.S.view === ' + q(view) + ')', 10000); await sleep(200); };
    async function dnd(vid, baseId) {          // перетаскивание строки ТС на заголовок/тело группы базы (события HTML5 DnD с DataTransfer)
      return ev('(() => { const src = document.querySelector(".tp-veh[data-vehicle-id=" + JSON.stringify(' + q(vid) + ') + "]"); const dst = document.querySelector(".tp-base[data-base-id=" + JSON.stringify(' + q(baseId) + ') + "]"); if (!src || !dst) return "no-elements";' +
        ' const dt = new DataTransfer(); const f = (t, el) => el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));' +
        ' f("dragstart", src); f("dragenter", dst); const over = f("dragover", dst); const hl = dst.classList.contains("tp-drop"); f("drop", dst); f("dragend", src); return hl ? "ok" : "no-highlight"; })()');
    }
    const dlgOpen = () => exists('#transportDlg');
    const dlgText = () => textOf('#transportDlg');
    const msgText = () => ev('(() => { const e = document.querySelector("#transportView .tp-msg"); return e ? e.textContent : ""; })()');

    // ==========================================================================================
    // 1. ВКЛАДКА
    // ==========================================================================================
    console.log('--- вкладка «Транспорт» ---');
    await guard('вкладка', async () => {
      await k.size(1280, 900);
      await k.load(admin.split('; '));
      check('window.Transport определён', await ev('typeof window.Transport === "object" && typeof Transport.open === "function"'));
      check('скрипт js/transport.js подключён относительным путём (без внешних URL)', await ev('(() => { const s = [...document.scripts].filter(x => /transport\\.js/.test(x.getAttribute("src") || "")); return s.length === 1 && !/^(https?:)?\\/\\//.test(s[0].getAttribute("src")); })()'));
      check('кнопка вкладки #tabTransport в панели, подпись «Транспорт»', (await textOf('#panelTabs #tabTransport')) === 'Транспорт');
      check('контейнер #transportView скрыт до открытия', !(await vis('#transportView')));
      await ev('document.getElementById("vacationTrigger").click()'); await sleep(500);
      await k.click('#tabTransport');
      await waitFor('Transport.isActive()', 8000);
      check('клик по вкладке: #transportView виден, вкладка active', (await vis('#transportView')) && (await ev('document.getElementById("tabTransport").classList.contains("active")')));
      check('... остальные вкладки неактивны, Матрица и Командировки скрыты', await ev('["tabMatrix","tabTrips","tabTasks"].every(i => !document.getElementById(i).classList.contains("active")) && document.getElementById("matrixWrapper").style.display === "none" && document.getElementById("tripsListView").style.display === "none"'));
      await waitFor('!!document.querySelector("#transportView .tp-base")', 10000);
      check('... доска загрузилась (есть группы баз)', (await count('#transportView .tp-base')) >= 3);
      await k.click('#tabTasks'); await sleep(500);
      check('переход на «Задачи»: «Транспорт» скрыт и неактивен', !(await vis('#transportView')) && !(await ev('Transport.isActive()')));
      await k.click('#tabTransport'); await sleep(400);
      check('возврат на «Транспорт»: снова виден', (await vis('#transportView')) && (await ev('Transport.isActive()')));
      await k.click('#tabMatrix'); await sleep(400);
      check('переход на «Матрицу»: «Транспорт» скрыт', !(await vis('#transportView')) && !(await ev('Transport.isActive()')));
      await k.click('#tabTrips'); await sleep(300);
      await k.click('#tabTransport'); await sleep(400);
      await k.click('#tabTrips'); await sleep(400);
      check('переход на «Командировки»: «Транспорт» скрыт', !(await vis('#transportView')) && (await vis('#tripsListView')));
    });
    await guard('вкладка по ролям', async () => {
      for (const [name, ck] of [['supervisor', sup0], ['viewer', viewer]]) {
        await k.size(1280, 900); await k.load(ck.split('; '));
        check(name + ': вкладка «Транспорт» есть и доска открывается', (await exists('#tabTransport')) && (await ev('(async () => { await Transport.open({ view: "day", date: ' + q(D) + ' }); return true; })()')) && await waitFor('!!document.querySelector("#transportView .tp-base")', 15000));
      }
    });

    // ==========================================================================================
    // 2. ДОСКА «ДЕНЬ» (admin, 1280)
    // ==========================================================================================
    console.log('--- доска «День» ---');
    await guard('день', async () => {
      await openBoard(admin, { view: 'day', date: D });
      const st = await S();
      check('режим «День», дата ' + D + ', запрос ' + D + '…' + D, st.view === 'day' && st.date === D && st.from === D && st.to === D, JSON.stringify(st));
      check('заголовок периода — русская дата («12 марта 2032», пятница)', /12 марта 2032/.test(await textOf('#transportView .tp-title')) && /Пт/.test(await textOf('#transportView .tp-title')), await textOf('#transportView .tp-title'));
      check('базы — группами в порядке sort_order: А, Б, пустая', JSON.stringify(await ids('#transportView .tp-base', 'data-base-id')) === JSON.stringify([BA.id, BB.id, BC.id]), JSON.stringify(await ids('#transportView .tp-base', 'data-base-id')));
      check('заголовок группы: название базы и число ТС («Тест-База А» · 3 ТС)', /Тест-База А/.test(await textOf('.tp-base[data-base-id="' + BA.id + '"] .tp-base-h')) && /3 ТС/.test(await textOf('.tp-base[data-base-id="' + BA.id + '"] .tp-base-h')), await textOf('.tp-base[data-base-id="' + BA.id + '"] .tp-base-h'));
      check('ТС сгруппированы по базам (А: 1, 2, 3; Б: 4)', JSON.stringify(await ids('.tp-base[data-base-id="' + BA.id + '"] .tp-veh', 'data-vehicle-id')) === JSON.stringify([V1.id, V2.id, V3.id]) && JSON.stringify(await ids('.tp-base[data-base-id="' + BB.id + '"] .tp-veh', 'data-vehicle-id')) === JSON.stringify([V4.id]));
      check('пустая база показана с пометкой «нет ТС»', /нет ТС/.test(await textOf('.tp-base[data-base-id="' + BC.id + '"]')), await textOf('.tp-base[data-base-id="' + BC.id + '"]'));
      check('строка ТС: название и госномер', /ТС-Один/.test(await textOf('.tp-veh[data-vehicle-id="' + V1.id + '"]')) && /Т001ТТ86/.test(await textOf('.tp-veh[data-vehicle-id="' + V1.id + '"]')));
      check('ТС в ремонте помечено (класс tp-repair, «ремонт»)', (await ev('document.querySelector(".tp-veh[data-vehicle-id=" + ' + q(JSON.stringify(V3.id)) + ' + "]").classList.contains("tp-repair")')) && /ремонт/.test(await textOf('.tp-veh[data-vehicle-id="' + V3.id + '"]')));
      check('назначения: полосы A1, A2 (с 22:00), A3 присутствуют', [A1, A2, A3].every((a) => true) && JSON.stringify((await ids('#transportView .tp-blk', 'data-assign-id')).sort()) === JSON.stringify([A1.id, A2.id, A3.id].sort()), JSON.stringify(await ids('#transportView .tp-blk', 'data-assign-id')));
      const pos = await ev('(() => { const g = (id) => { const e = document.querySelector(".tp-blk[data-assign-id=" + JSON.stringify(id) + "]"); return e ? { l: parseFloat(e.style.left), w: parseFloat(e.style.width), top: e.offsetTop } : null; }; return { a1: g(' + q(A1.id) + '), a2: g(' + q(A2.id) + '), a3: g(' + q(A3.id) + ') }; })()');
      check('A1 08:00–11:00: left ≈ 33.33 %, width = 12.5 %', pos.a1 && Math.abs(pos.a1.l - 33.333) < 0.1 && Math.abs(pos.a1.w - 12.5) < 0.1, JSON.stringify(pos.a1));
      check('A2 22:00 → 02:00: в этот день left ≈ 91.67 %, width ≈ 8.33 % (обрезано по полночь)', pos.a2 && Math.abs(pos.a2.l - 91.667) < 0.1 && Math.abs(pos.a2.w - 8.333) < 0.1, JSON.stringify(pos.a2));
      check('A1 и A3 пересекаются (08–11 и 09–11) — разные дорожки (разный top)', pos.a1 && pos.a3 && pos.a1.top !== pos.a3.top, JSON.stringify([pos.a1, pos.a3]));
      const t1 = await textOf('.tp-blk[data-assign-id="' + A1.id + '"]');
      check('текст полосы A1: время 08:00–11:00, № заявки, водитель, бригада', /08:00/.test(t1) && /11:00/.test(t1) && new RegExp('№' + R1.display_no).test(t1) && /E9 Test Employee/.test(t1) && /бр\.\s*1/.test(t1), t1);
      check('очередь нераспределённых: Q4 и Q5, без заявок с назначениями', JSON.stringify((await ids('#transportView .tp-q', 'data-request-id')).sort()) === JSON.stringify([Q4.id, Q5.id].sort()), JSON.stringify(await ids('#transportView .tp-q', 'data-request-id')));
      check('заголовок очереди содержит число (2)', /\(2\)/.test(await textOf('#transportView .tp-queue .tp-qh')), await textOf('#transportView .tp-queue .tp-qh'));
      check('карточка очереди: № заявки, название, абонент и автор (Administrator) — чужие заявки видны', /Очередь-Админ/.test(await textOf('.tp-q[data-request-id="' + Q4.id + '"]')) && /Абонент-Q4/.test(await textOf('.tp-q[data-request-id="' + Q4.id + '"]')) && /создал: Administrator/.test(await textOf('.tp-q[data-request-id="' + Q4.id + '"]')), await textOf('.tp-q[data-request-id="' + Q4.id + '"]'));
      // карточка назначения
      await k.click('.tp-blk[data-assign-id="' + A1.id + '"]');
      await sleep(250);
      const det = await textOf('#transportView .tp-detail');
      check('клик по полосе открывает карточку: название заявки, абонент, адрес — как ТЕКСТ', det && det.indexOf(XSS + 'Заявка-Один') >= 0 && det.indexOf('<b>Абонент</b>') >= 0 && det.indexOf('ул. <i>Х</i>') >= 0, det);
      check('карточка: ТС, водитель, бригада (имя сотрудника), база', /ТС-Один/.test(det) && /E9 Test Employee/.test(det) && /Petrov Petr/.test(det) && /Тест-База А/.test(det), det);
      check('карточка: время «12.03 08:00–11:00» и длительность «3 ч»', /12\.03[^\n]*08:00[^\n]*11:00/.test(det) && /3 ч/.test(det), det);
      check('карточка: маршрут — выезд / остановка / приезд (Урай, Кондинское, Советский) в порядке ord', /Урай[\s\S]*Кондинское[\s\S]*Советский/.test(det) && /стоянка 15 мин/.test(det), det);
      check('подсветка отсутствия: водитель A1 в больничном — маркер .tp-abs в полосе и в карточке', (await exists('.tp-blk[data-assign-id="' + A1.id + '"] .tp-abs')) && (await exists('#transportView .tp-detail .tp-abs')) && /больничн/.test(det), det);
      check('комментарий отсутствия (приватное) не выводится', (await ev('document.getElementById("transportView").textContent.indexOf("секрет-коммент") < 0')));
      check('у A3 (водитель не отсутствует) маркера нет', !(await exists('.tp-blk[data-assign-id="' + A3.id + '"] .tp-abs')));
      check('чужая заявка (A2 автор supervisor_zone1) видна admin и открывается карточкой', await (async () => { await k.click('.tp-blk[data-assign-id="' + A2.id + '"]'); await sleep(200); return /Заявка-Два/.test(await textOf('#transportView .tp-detail')) && /zone1/.test(await textOf('#transportView .tp-detail')); })());
      check('<img onerror> из названия/абонента/адреса не исполнился (window.__xss не задан) и <img> в доске нет', (await ev('window.__xss === undefined')) && (await count('#transportView img')) === 0);
      check('в очереди название Q5 с <img> выведено текстом', (await textOf('.tp-q[data-request-id="' + Q5.id + '"]')).indexOf(XSS + 'Очередь-Супервизор') >= 0);
      // следующий день: продолжение A2
      await k.click('#transportView [data-tp-act="next"]');
      await waitFor('Transport.__t.S.date === ' + q(D2) + ' && !Transport.__t.S.loading', 8000); await sleep(250);
      check('▶: дата ' + D2 + ', запрос на ' + D2, (await S()).from === D2 && (await S()).to === D2, JSON.stringify(await S()));
      const cont = await ev('(() => { const e = document.querySelector(".tp-blk[data-assign-id=" + JSON.stringify(' + q(A2.id) + ') + "]"); return e ? { l: parseFloat(e.style.left), w: parseFloat(e.style.width), cl: e.classList.contains("tp-cont-l") } : null; })()');
      check('A2 продолжается на следующий день: 00:00–02:00, left 0, width ≈ 8.33 %, класс tp-cont-l', cont && cont.l === 0 && Math.abs(cont.w - 8.333) < 0.1 && cont.cl, JSON.stringify(cont));
      check('подсветка отсутствия в этот день: бригада A2 (emp_4) в отпуске — маркер в полосе', await exists('.tp-blk[data-assign-id="' + A2.id + '"] .tp-abs'));
      await k.click('#transportView [data-tp-act="prev"]');
      await waitFor('Transport.__t.S.date === ' + q(D) + ' && !Transport.__t.S.loading', 8000);
      check('◀: возврат на ' + D, (await S()).date === D);
    });

    // ==========================================================================================
    // 3. «НЕДЕЛЯ»
    // ==========================================================================================
    console.log('--- доска «Неделя» ---');
    await guard('неделя', async () => {
      await k.click('#transportView [data-tp-act="viewWeek"]');
      await waitFor('Transport.__t.S.view === "week" && !Transport.__t.S.loading', 8000); await sleep(300);
      const st = await S();
      check('«Неделя»: период пн ' + MON + ' … вс ' + SUN + ' (запрос ' + MON + '…' + SUN + ')', st.view === 'week' && st.from === MON && st.to === SUN, JSON.stringify(st));
      check('заголовок: «8–14 марта 2032»', /8–14 марта 2032/.test(await textOf('#transportView .tp-title')), await textOf('#transportView .tp-title'));
      check('7 колонок дней (Пн … Вс)', (await count('#transportView .tp-wk-h .tp-wk-day')) === 7 && /Пн/.test(await textOf('#transportView .tp-wk-h .tp-wk-day')), await count('#transportView .tp-wk-h .tp-wk-day'));
      check('те же базы-группы и ТС-строки (4 ТС, 3 базы)', (await count('#transportView .tp-base')) === 3 && (await count('#transportView .tp-veh')) === 4);
      check('чипы назначений недели: A1, A2, A3, A6 (A7 — сегодняшнее, вне периода — нет)', JSON.stringify([...new Set(await ids('#transportView .tp-chip', 'data-assign-id'))].sort()) === JSON.stringify([A1.id, A2.id, A3.id, A6.id].sort()), JSON.stringify(await ids('#transportView .tp-chip', 'data-assign-id')));
      check('A2 (через полночь) — чип в двух ячейках: пт и сб', (await count('.tp-chip[data-assign-id="' + A2.id + '"]')) === 2);
      const ch = await textOf('.tp-chip[data-assign-id="' + A1.id + '"]');
      check('чип A1: время начала 08:00, № заявки, водитель', /08:00/.test(ch) && new RegExp('№' + R1.display_no).test(ch) && /E9 Test Employee/.test(ch), ch);
      check('ячейка с отсутствием (A1, пт) подсвечена: .tp-abs', await exists('.tp-wk-cell[data-vehicle-id="' + V1.id + '"][data-date="' + D + '"] .tp-abs'));
      check('нагрузка ячейки пт для ТС-Один: «5 ч · 2 зад.»', /5 ч · 2 зад\./.test(await textOf('.tp-wk-cell[data-vehicle-id="' + V1.id + '"][data-date="' + D + '"]')), await textOf('.tp-wk-cell[data-vehicle-id="' + V1.id + '"][data-date="' + D + '"]'));
      check('пустая ячейка: «свободно»', /свободно/.test(await textOf('.tp-wk-cell[data-vehicle-id="' + V1.id + '"][data-date="' + MON + '"]')));
      check('ТС в ремонте: ячейки помечены «ремонт»', /ремонт/.test(await textOf('.tp-wk-cell[data-vehicle-id="' + V3.id + '"][data-date="' + D + '"]')));
      check('очередь нераспределённых видна и в неделе', (await count('#transportView .tp-q')) === 2);
      await k.click('.tp-chip[data-assign-id="' + A6.id + '"]'); await sleep(250);
      check('клик по чипу открывает карточку назначения (Заявка-Шесть)', /Заявка-Шесть/.test(await textOf('#transportView .tp-detail')) && (await S()).view === 'week');
      await k.click('.tp-wk-cell[data-vehicle-id="' + V4.id + '"][data-date="' + D + '"]');
      await waitFor('Transport.__t.S.view === "day" && !Transport.__t.S.loading', 8000); await sleep(250);
      check('клик по пустому месту ячейки — переход в «День» этой даты', (await S()).view === 'day' && (await S()).date === D, JSON.stringify(await S()));
      await k.click('#transportView [data-tp-act="viewWeek"]');
      await waitFor('Transport.__t.S.view === "week" && !Transport.__t.S.loading', 8000);
      await k.click('#transportView [data-tp-act="next"]');
      await waitFor('Transport.__t.S.from === "2032-03-15" && !Transport.__t.S.loading', 8000);
      check('▶ в неделе: +7 дней (15–21 марта)', (await S()).from === '2032-03-15' && (await S()).to === '2032-03-21', JSON.stringify(await S()));
      await k.click('#transportView [data-tp-act="today"]');
      await waitFor('Transport.__t.S.view === "week" && !Transport.__t.S.loading && Transport.__t.S.date === ' + q(TODAY), 8000);
      check('«Сегодня» (+05): дата = сегодня по Екатеринбургу (' + TODAY + ')', (await S()).date === TODAY, JSON.stringify(await S()));
      check('сегодняшнее назначение A7 видно в неделе', await exists('.tp-chip[data-assign-id="' + A7.id + '"]'));
      await setView('day', TODAY);
      check('«День» → сегодня: A7 — полоса, left = 10/24', await ev('(() => { const e = document.querySelector(".tp-blk[data-assign-id=" + JSON.stringify(' + q(A7.id) + ') + "]"); return !!e && Math.abs(parseFloat(e.style.left) - 41.667) < 0.1; })()'));
      check('в день без назначений ТС показаны, полос нет у ТС-Один', (await count('.tp-veh[data-vehicle-id="' + V1.id + '"] ~ .tp-blk, .tp-row[data-vehicle-id="' + V1.id + '"] .tp-blk')) === 0);
    });

    // ==========================================================================================
    // 4. ИСТОЧНИК ДАННЫХ
    // ==========================================================================================
    console.log('--- источник данных ---');
    await guard('источник данных', async () => {
      const urls = await transportApiUrls();
      check('к API транспорта доска обращалась только к transport_board.php (до переноса)', urls.length > 0 && urls.every((u) => u === 'api/transport_board.php'), JSON.stringify([...new Set(urls)]));
      check('период ≤ 31 дня: неделя запрашивается одним запросом пн–вс', await ev('(() => { const n = performance.getEntriesByType("resource").map(r => r.name).filter(x => /transport_board\\.php/.test(x)); return n.some(x => /from=2032-03-08&to=2032-03-14/.test(x)); })()'));
    });

    // ==========================================================================================
    // 5. ПЕРЕНОС ТС: admin — перетаскивание
    // ==========================================================================================
    console.log('--- перенос ТС (admin, перетаскивание) ---');
    await guard('перенос admin', async () => {
      await openBoard(admin, { view: 'day', date: D });
      check('admin: can_move_vehicle=true из API', (await S()).canMove === true);
      check('admin: все 4 строки ТС перетаскиваемые (draggable=true) и есть кнопки «Переместить в базу…»', (await count('.tp-veh[draggable="true"]')) === 4 && (await count('[data-tp-act="moveMenu"]')) === 4);
      const vBefore = await ev('Transport.__t.S.board.bases.flatMap(b => b.vehicles).find(v => v.id === ' + q(V2.id) + ').version');
      const j0 = journalMoves();
      check('drag ТС-Два на базу Б: подсветка зоны сброса (tp-drop) и диалог подтверждения', (await dnd(V2.id, BB.id)) === 'ok' && await dlgOpen());
      const dt = await dlgText();
      check('диалог называет ТС и базу назначения и предупреждает: перенос постоянный', /ТС-Два/.test(dt) && /Тест-База Б/.test(dt) && /постоянн/i.test(dt), dt);
      check('диалог — модальный (role=dialog, aria-modal)', (await attrOf('#transportDlg [role="dialog"], #transportDlg[role="dialog"]', 'aria-modal')) === 'true');
      await shot('admin_1280_move_dialog');
      await k.click('#transportDlg [data-tp-act="dlgCancel"]'); await sleep(200);
      check('«Отмена»: диалог закрыт, ТС в БД остался в базе А, журнал не вырос', !(await dlgOpen()) && dbVeh(V2.id) === BA.id && journalMoves() === j0);
      check('drop ТС на ту же базу — диалога нет', (await dnd(V1.id, BA.id)) !== 'x' && !(await dlgOpen()));
      await dnd(V2.id, BB.id);
      await waitFor('!!document.querySelector("#transportDlg")', 3000);
      await k.click('#transportDlg [data-tp-act="dlgOk"]');
      await waitFor('!document.querySelector("#transportDlg") && !Transport.__t.S.loading', 8000); await sleep(400);
      check('«Переместить»: в БД base_id = база Б', dbVeh(V2.id) === BB.id, dbVeh(V2.id));
      check('клики в диалоге переноса не закрывают панель (глобальный «клик вне панели» их не видит)', await ev('document.getElementById("vacationPanel").classList.contains("open") && Transport.isActive()'));
      check('журнал: запись vehicle.move (+1)', journalMoves() === j0 + 1, journalMoves());
      check('в UI ТС-Два теперь в группе базы Б, version вырос, сообщение об успехе', (await ids('.tp-base[data-base-id="' + BB.id + '"] .tp-veh', 'data-vehicle-id')).indexOf(V2.id) >= 0 && (await ev('Transport.__t.S.board.bases.flatMap(b => b.vehicles).find(v => v.id === ' + q(V2.id) + ').version')) === vBefore + 1 && /перенесён/i.test(await msgText()), await msgText());
      check('назначение A2 осталось на ТС-Два (перенос не меняет назначения)', await exists('.tp-veh[data-vehicle-id="' + V2.id + '"]') && (await ev('Transport.__t.S.board.assignments.find(a => a.id === ' + q(A2.id) + ').vehicle_id')) === V2.id);
      await k.load(admin.split('; '));
      await ev('Transport.open({ view: "day", date: ' + q(D) + ' })');
      await waitFor('!!document.querySelector("#transportView .tp-base")', 15000); await sleep(300);
      check('после перезагрузки страницы ТС-Два в группе базы Б (сохранилось)', (await ids('.tp-base[data-base-id="' + BB.id + '"] .tp-veh', 'data-vehicle-id')).indexOf(V2.id) >= 0 && (await ids('.tp-base[data-base-id="' + BA.id + '"] .tp-veh', 'data-vehicle-id')).indexOf(V2.id) < 0);
      check('drag ТС с несуществующей/чужой цели не ломает: drop вне баз — ничего не происходит', await ev('(() => { const src = document.querySelector(".tp-veh"); const dt = new DataTransfer(); src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt })); document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt })); src.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt })); return !document.querySelector("#transportDlg"); })()'));
    });

    // ==========================================================================================
    // 6. ПЕРЕНОС ТС: viewer — меню; конфликт версий
    // ==========================================================================================
    console.log('--- перенос ТС (viewer, меню; конфликт версий) ---');
    await guard('перенос viewer', async () => {
      await openBoard(viewer, { view: 'day', date: D });
      check('viewer: can_move_vehicle=true, строки перетаскиваемы, кнопки меню есть', (await S()).canMove === true && (await count('.tp-veh[draggable="true"]')) === 4 && (await count('[data-tp-act="moveMenu"]')) === 4);
      await k.click('[data-tp-act="moveMenu"][data-vehicle-id="' + V1.id + '"]');
      await waitFor('!!document.querySelector("#transportMenu")', 3000);
      check('«Переместить в базу…»: меню открыто; в нём все базы, кроме текущей (Б и пустая)', (await exists('#transportMenu')) && JSON.stringify((await ids('#transportMenu [data-base-id]', 'data-base-id')).sort()) === JSON.stringify([BB.id, BC.id].sort()), JSON.stringify(await ids('#transportMenu [data-base-id]', 'data-base-id')));
      check('меню: заголовок называет ТС, есть пометка о постоянном переносе', /ТС-Один/.test(await textOf('#transportMenu')) && /постоянн/i.test(await textOf('#transportMenu')), await textOf('#transportMenu'));
      await shot('viewer_1280_move_menu');
      await k.click('#transportMenu [data-base-id="' + BC.id + '"]');
      await waitFor('!!document.querySelector("#transportDlg")', 3000);
      check('выбор базы в меню → диалог подтверждения («Пустая база», «постоянный»)', (await dlgOpen()) && !(await exists('#transportMenu')) && /Пустая база/.test(await dlgText()) && /постоянн/i.test(await dlgText()), await dlgText());
      const j0 = journalMoves();
      await k.click('#transportDlg [data-tp-act="dlgOk"]');
      await waitFor('!document.querySelector("#transportDlg") && !Transport.__t.S.loading', 8000); await sleep(400);
      check('viewer перенёс ТС-Один в «Пустая база»: БД и журнал (vehicle.move)', dbVeh(V1.id) === BC.id && journalMoves() === j0 + 1, dbVeh(V1.id));
      check('панель осталась открытой после подтверждения (клик в диалоге)', await ev('document.getElementById("vacationPanel").classList.contains("open")'));
      check('в UI: ТС-Один в группе «Пустая база», пометка «нет ТС» у неё исчезла', (await ids('.tp-base[data-base-id="' + BC.id + '"] .tp-veh', 'data-vehicle-id')).indexOf(V1.id) >= 0 && !/нет ТС/.test(await textOf('.tp-base[data-base-id="' + BC.id + '"]')));
      check('viewer: назначения чужих заявок видны, а кнопок «Новая заявка», «Назначить», «Изменить» нет', (await count('.tp-blk')) >= 3 && !(await exists('[data-tp-act="newReq"]')) && !(await exists('[data-tp-act="assign"]')) && !(await exists('[data-tp-act="editReq"]')));
      // конфликт версий: пока открыта доска, версию ТС-Четыре меняют через API
      const cur = ok2(await api(admin, 'GET', 'api/transport_vehicles.php'), 'GET vehicles').vehicles.find((v) => v.id === V4.id);
      ok2(await api(admin, 'PUT', 'api/transport_vehicles.php?entity=vehicle&id=' + encodeURIComponent(V4.id), { version: cur.version, name: 'ТС-Четыре (перекрашено)' }), 'PUT vehicle');
      const j1 = journalMoves();
      await k.click('[data-tp-act="moveMenu"][data-vehicle-id="' + V4.id + '"]');
      await waitFor('!!document.querySelector("#transportMenu")', 3000);
      await k.click('#transportMenu [data-base-id="' + BA.id + '"]');
      await waitFor('!!document.querySelector("#transportDlg")', 3000);
      await k.click('#transportDlg [data-tp-act="dlgOk"]');
      await waitFor('!document.querySelector("#transportDlg") && !Transport.__t.S.loading', 8000); await sleep(500);
      const mt = await msgText();
      check('VERSION_CONFLICT: понятное сообщение («изменён … обновлены … повторите»), перенос не выполнен', /изменён|изменен/i.test(mt) && /повтор/i.test(mt) && dbVeh(V4.id) === BB.id && journalMoves() === j1, mt);
      check('... доска перечитана: у ТС-Четыре новое название и актуальная версия', /перекрашено/.test(await textOf('.tp-veh[data-vehicle-id="' + V4.id + '"]')) && (await ev('Transport.__t.S.board.bases.flatMap(b => b.vehicles).find(v => v.id === ' + q(V4.id) + ').version')) === cur.version + 1);
      await k.click('[data-tp-act="moveMenu"][data-vehicle-id="' + V4.id + '"]');
      await waitFor('!!document.querySelector("#transportMenu")', 3000);
      await k.click('#transportMenu [data-base-id="' + BA.id + '"]');
      await waitFor('!!document.querySelector("#transportDlg")', 3000);
      await k.click('#transportDlg [data-tp-act="dlgOk"]');
      await waitFor('!document.querySelector("#transportDlg") && !Transport.__t.S.loading', 8000); await sleep(500);
      check('повторный перенос после перезагрузки данных проходит (база А)', dbVeh(V4.id) === BA.id && journalMoves() === j1 + 1, dbVeh(V4.id));
      check('Esc закрывает меню без переноса', await (async () => {
        await k.click('[data-tp-act="moveMenu"][data-vehicle-id="' + V4.id + '"]');
        await waitFor('!!document.querySelector("#transportMenu")', 3000);
        await ev('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))'); await sleep(200);
        return !(await exists('#transportMenu')) && !(await dlgOpen());
      })());
    });

    // ==========================================================================================
    // 7. supervisor: чтение и права
    // ==========================================================================================
    console.log('--- supervisor ---');
    await guard('supervisor', async () => {
      await openBoard(sup0, { view: 'day', date: D });
      check('supervisor: can_move_vehicle=false', (await S()).canMove === false);
      check('supervisor: управления переносом нет — ни draggable, ни кнопок меню, ни ручек', (await count('.tp-veh[draggable="true"]')) === 0 && (await count('[data-tp-act="moveMenu"]')) === 0 && (await count('.tp-hnd')) === 0);
      check('supervisor: перенос из консоли (Transport.__t.askMove) не отправляет запрос и не открывает диалог', await (async () => {
        const n0 = (await transportApiUrls()).length, b0 = dbVeh(V4.id);
        await ev('Transport.__t.askMove(' + q(V4.id) + ', ' + q(BC.id) + ')'); await sleep(300);
        return !(await dlgOpen()) && (await transportApiUrls()).length === n0 && dbVeh(V4.id) === b0;
      })());
      check('сервер: supervisor POST move → 403', (await api(sup0, 'POST', 'api/transport_vehicles.php?action=move&id=' + encodeURIComponent(V4.id), { base_id: BB.id, version: 1 })).status === 403);
      check('supervisor видит чужие заявки (A1 admin, A2 zone1) и очередь (Q4 admin)', (await count('.tp-blk')) >= 3 && (await exists('.tp-q[data-request-id="' + Q4.id + '"]')));
      check('supervisor: «+ Новая заявка» виден', await exists('[data-tp-act="newReq"]'));
      check('zone0: у своей заявки в очереди (Q5) есть «Назначить», у чужой (Q4 admin) — нет', (await exists('.tp-q[data-request-id="' + Q5.id + '"] [data-tp-act="assign"]')) && !(await exists('.tp-q[data-request-id="' + Q4.id + '"] [data-tp-act="assign"]')));
      await k.click('.tp-blk[data-assign-id="' + A2.id + '"]'); await sleep(250);
      check('zone0 правит заявки zone1 (can_edit): в карточке A2 есть «Изменить»', await exists('#transportView .tp-detail [data-tp-act="editReq"]'));
      await k.click('.tp-blk[data-assign-id="' + A1.id + '"]'); await sleep(250);
      check('в карточке чужой заявки admin (A1) «Изменить» нет', !(await exists('#transportView .tp-detail [data-tp-act="editReq"]')));
      await shot('supervisor_1280_day');
    });

    // ==========================================================================================
    // 8. ТОЧКИ РАСШИРЕНИЯ ДЛЯ T9 / T11
    // ==========================================================================================
    console.log('--- Transport.openForm (точка расширения T9) ---');
    await guard('openForm', async () => {
      await openBoard(admin, { view: 'day', date: D });
      check('Transport.openForm — функция', await ev('typeof Transport.openForm === "function"'));
      await k.click('[data-tp-act="newReq"]'); await sleep(250);
      check('заглушка: «+ Новая заявка» показывает «форма — в следующем этапе»', /в следующем этапе/i.test(await msgText()), await msgText());
      await ev('window.__ctx = []; Transport.openForm = function (c) { window.__ctx.push(c); };');
      await k.click('[data-tp-act="newReq"]');
      await k.click('.tp-q[data-request-id="' + Q4.id + '"] [data-tp-act="assign"]');
      await k.click('.tp-blk[data-assign-id="' + A1.id + '"]');
      await k.click('#transportView .tp-detail [data-tp-act="editReq"]');
      const ctx = await ev('window.__ctx');
      check('подмена Transport.openForm получает контекст: new (с датой), assign (requestId), edit (requestId + assignmentId)', ctx.length === 3 && ctx[0].mode === 'new' && ctx[0].date === D && ctx[1].mode === 'assign' && ctx[1].requestId === Q4.id && ctx[2].mode === 'edit' && ctx[2].requestId === R1.id && ctx[2].assignmentId === A1.id, JSON.stringify(ctx));
      check('после закрытия формы T9 может вызвать Transport.reload() — доска перечитывается', await (async () => { const n = await boardReqs(); await ev('Transport.reload()'); await sleep(700); return (await boardReqs()) === n + 1; })());
    });

    // ==========================================================================================
    // 9. ПОЛЛИНГ
    // ==========================================================================================
    console.log('--- поллинг ---');
    await guard('поллинг', async () => {
      await openBoard(admin, { view: 'day', date: D });
      check('интервал опроса задан (Transport.__t.POLL_MS в разумных пределах 10–120 с)', await ev('Transport.__t.POLL_MS >= 10000 && Transport.__t.POLL_MS <= 120000'));
      check('на активной вкладке таймер запущен', await ev('!!Transport.__t.S.timer'));
      await k.click('.tp-blk[data-assign-id="' + A1.id + '"]'); await sleep(200);
      const n0 = await boardReqs();
      await ev('Transport.__t.tick()'); await sleep(700);
      check('tick(): доска перечитана (+1 запрос), карточка выбранного назначения не сброшена', (await boardReqs()) === n0 + 1 && /Заявка-Один/.test(await textOf('#transportView .tp-detail')), await boardReqs());
      await ev('Object.defineProperty(document, "hidden", { configurable: true, get: () => true })');
      const n1 = await boardReqs();
      await ev('Transport.__t.tick()'); await sleep(500);
      check('вкладка браузера скрыта: tick() запросов не делает', (await boardReqs()) === n1);
      await ev('delete document.hidden');
      // изменение на сервере подхватывается опросом
      const R9 = await mkReq(admin, 'Новая из опроса');
      await ev('Transport.__t.tick()'); await sleep(700);
      check('новая заявка, созданная на сервере, появляется в очереди после опроса', await exists('.tp-q[data-request-id="' + R9.id + '"]'));
      await k.click('#tabTasks'); await sleep(400);
      check('при уходе с вкладки таймер снят, tick() не делает запросов', await (async () => { const n = await boardReqs(); await ev('Transport.__t.tick()'); await sleep(400); return !(await ev('!!Transport.__t.S.timer')) && (await boardReqs()) === n; })());
      await k.click('#tabTransport'); await sleep(500);
      check('при возврате на вкладку — опрос снова идёт (таймер есть)', await ev('!!Transport.__t.S.timer'));
      await k.setCookies([]);
      await ev('Transport.__t.tick()'); await sleep(700);
      check('сессия истекла (401): доска показывает сообщение, не падает', /сесси|войд/i.test(await msgText()), await msgText());
    });

    // ==========================================================================================
    // 10. ВЁРСТКА: 375 и 1280, роли
    // ==========================================================================================
    console.log('--- вёрстка 375 / 1280 ---');
    await guard('вёрстка', async () => {
      for (const [name, ck] of [['admin', admin], ['supervisor', sup0], ['viewer', viewer]]) {
        for (const w of [1280, 375]) {
          await openBoard(ck, { view: 'day', date: D, w, h: w === 375 ? 800 : 900 });
          const od = await overflowX();
          check(name + ' ' + w + ' «День»: без горизонтального скролла страницы', noHScroll(od), JSON.stringify(od));
          await k.click('.tp-blk[data-assign-id="' + A1.id + '"], .tp-card[data-assign-id="' + A1.id + '"]'); await sleep(200);
          await shot(name + '_' + w + '_day');
          await setView('week', D);
          const ow = await overflowX();
          check(name + ' ' + w + ' «Неделя»: без горизонтального скролла страницы', noHScroll(ow), JSON.stringify(ow));
          await shot(name + '_' + w + '_week');
          if (name !== 'supervisor') {
            await setView('day', D);
            await k.click('[data-tp-act="moveMenu"][data-vehicle-id="' + V3.id + '"]');
            await waitFor('!!document.querySelector("#transportMenu")', 3000);
            const om = await overflowX();
            const inView = await ev('(() => { const m = document.querySelector("#transportMenu"); const r = m.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1; })()');
            check(name + ' ' + w + ' меню переноса: целиком в окне, скролла страницы нет', noHScroll(om) && inView, JSON.stringify([om, inView]));
            const first = await ev('document.querySelector("#transportMenu [data-base-id]").getAttribute("data-base-id")');
            await k.click('#transportMenu [data-base-id="' + first + '"]');
            await waitFor('!!document.querySelector("#transportDlg")', 3000);
            const od2 = await overflowX();
            const inView2 = await ev('(() => { const m = document.querySelector("#transportDlg .tp-dlg"); const r = m.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1; })()');
            check(name + ' ' + w + ' диалог подтверждения: в окне, скролла нет', noHScroll(od2) && inView2, JSON.stringify([od2, inView2]));
            await shot(name + '_' + w + '_dialog');
            await k.click('#transportDlg [data-tp-act="dlgCancel"]');
          }
        }
      }
    });

    // ==========================================================================================
    // 11. ИТОГИ
    // ==========================================================================================
    check('нет необработанных исключений JS за весь прогон', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));
    check('нет диалогов alert/confirm (всё через собственные окна)', cdp.dialogs.length === 0, JSON.stringify(cdp.dialogs));
  } finally {
    env.cleanup();
  }
  check('data/app.db не изменена (sha1 до = после)', sha1(REAL_DB) === dbBefore);
}

main().then(() => {
  console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.log('FATAL ' + (e && e.stack || e)); console.log('\nRESULT: ' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); });
