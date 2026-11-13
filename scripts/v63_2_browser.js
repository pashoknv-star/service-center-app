// V6.3-2 (вне gate): реальный Chromium — повторяющиеся задачи (Д-1): форма «Повторения», календарь (вставка = повтор,
// перенос/удаление повтора, плитки ↻), Список/Доска (↻ N, срок = next_at), карточка, матрица; роли admin/supervisor/viewer; 1280 и 375.
// Каркас — v6_accept_lib.js (php -S на КОПИИ data/app.db; пароли в браузер не вводятся: cookie из api/login.php).
// Запуск: node scripts/v63_2_browser.js [outDir]  → reports/V6_3/V6.3-2_screens/*.png, V63-2_results.json
'use strict';
const path = require('path'), fs = require('fs');
const L = require('./v6_accept_lib.js');
const OUT = path.resolve(process.argv[2] || path.join(L.ROOT, 'reports/V6_3/V6.3-2_screens'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = L.sleep;
const MAIN = '2027-01-01', REP_FORM = '2027-01-11', REP_PASTE = '2027-01-20', REP_MOVED = '2027-01-21';   // Пт; Пн; Ср; Чт
const MX1 = '2026-12-08', MX2 = '2026-12-15', MX3 = '2026-12-22';   // в год матрицы по умолчанию (2026)
const SICK_DAY = '2027-02-03';

(async () => {
  const env = await L.startEnv();
  const C = L.makeChecker(path.join(OUT, 'V63-2_results.json'));
  const check = C.check;
  try {
    const adminCookies = await L.login(env.base, 'admin');
    const ck = adminCookies.join('; ');
    const emp = await L.http(env.base, ck, 'GET', 'api/employees.php');
    const eList = (Array.isArray(emp.json) ? emp.json : emp.json.data || emp.json.employees || []).map((e) => String(e.id));
    const [, e1, e2] = eList;
    const srvList = async () => (await L.http(env.base, ck, 'GET', 'api/tasks.php')).json.tasks;
    const srv = async (id) => (await L.http(env.base, ck, 'GET', 'api/tasks.php?id=' + id)).json.task;
    const byTitle = async (t) => (await srvList()).filter((x) => x.title === t);
    // задача для матрицы и ролей (создаётся заранее через API)
    const rm = await L.http(env.base, ck, 'POST', 'api/tasks.php', { title: 'Матрица повторы', assignees: [e1], start_at: MX1 + 'T10:00', end_at: MX1 + 'T11:00', occurrences: [{ start_at: MX2 + 'T10:00' }, { start_at: MX3 + 'T10:00' }] });
    if (rm.status !== 201) throw new Error('seed matrix task ' + rm.status + JSON.stringify(rm.json));
    const TM = rm.json.task;

    const { cdp, version } = await env.openBrowser();
    C.note('browser', version);
    const k = L.pageKit(cdp, env.base, OUT);
    const ev = (x) => cdp.ev(x);
    const S = (expr) => ev('(() => { const S = window.Tasks.__t.S; return ' + expr + '; })()');
    const mouse = (type, x, y, extra) => cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra || {}));
    const down = async (p) => { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await mouse('mousePressed', p.x, p.y); };
    const move = (p) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
    const up = (p) => mouse('mouseReleased', p.x, p.y);
    const slide = async (from, to, n) => { n = n || 8; for (let i = 1; i <= n; i++) { await move({ x: from.x + (to.x - from.x) * i / n, y: from.y + (to.y - from.y) * i / n }); await sleep(25); } };
    const rclick = async (p) => { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await mouse('mousePressed', p.x, p.y, { button: 'right', buttons: 2 }); await mouse('mouseReleased', p.x, p.y, { button: 'right', buttons: 0 }); await sleep(200); };
    const settled = async () => { await sleep(150); await k.waitFor('!window.Tasks.__t.S.busy && !window.Tasks.__t.S.loading', 20000); await sleep(400); };
    const install = () => ev(`(() => {
      window.__calls = []; window.__cm = [];
      if (!window.__fetchPatched) { window.__fetchPatched = true; const of = window.fetch;
        window.fetch = function (u, o) { window.__calls.push({ u: String(u), m: (o && o.method) || 'GET' }); return of.apply(this, arguments); };
        document.addEventListener('contextmenu', (e) => window.__cm.push({ prevented: e.defaultPrevented }), false);
        window.confirm = () => true; }
      const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, w: r.width, h: r.height, b: r.bottom }; };
      window.__h = {
        tile: (id) => R(document.querySelector('#tasksView .tk-cal-bd .tk-ev[data-id="' + id + '"]:not(.tk-occ)')),
        occTile: (id, date) => R(document.querySelector('#tasksView .tk-cal-bd .tk-day[data-date="' + date + '"] .tk-ev.tk-occ[data-id="' + id + '"]')),
        day: (date) => R(document.querySelector('#tasksView .tk-day[data-date="' + date + '"]')),
        slot: (date, min) => R(document.querySelector('#tasksView [data-tk-act="calCell"][data-date="' + date + '"][data-min="' + min + '"]')),
        scroll: (top) => { document.querySelector('#tasksView .tk-wk').scrollTop = top; return true; },
        menu: () => { const m = document.querySelector('.tk-ctx'); if (!m) return null; return { items: [...m.querySelectorAll('.tk-ctx-i')].map((b) => { const q = b.getBoundingClientRect(); return { t: b.textContent, dis: b.disabled, x: q.left + q.width / 2, y: q.top + q.height / 2 }; }) }; },
        ctoast: () => { const t = document.querySelector('.tk-ctoast'); if (!t) return null; const a = t.querySelector('.tk-ctoast-act'); const q = a && a.getBoundingClientRect(); return { text: t.textContent, act: q ? { x: q.left + q.width / 2, y: q.top + q.height / 2 } : null }; },
        toasts: () => [...document.querySelectorAll('#toastContainer .toast')].map((e) => e.textContent),
        ovf: () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
      return true; })()`);
    const H = (expr) => ev('window.__h.' + expr);
    const calls = () => ev('window.__calls.slice()');
    const writes = async () => (await calls()).filter((c) => c.m !== 'GET');
    const fresh = async (cookies, w, h, mobile) => { await k.size(w || 1280, h || 900, !!mobile); await k.load(cookies); await install(); };
    const openCal = async (date, mode) => {
      await ev('window.Tasks.open({employeeId:"",date:' + JSON.stringify(date) + ',view:"calendar",mode:' + JSON.stringify(mode || 'week') + '})');
      await k.waitFor('!!document.querySelector("#tasksView .tk-cal-bd") && !window.Tasks.__t.S.loading', 30000); await sleep(500);
      await H('scroll(384)'); await sleep(250);
    };
    const gotoWeek = async (date) => { await ev('(() => { window.Tasks.__t.S.cal.anchor = "' + date + '"; window.Tasks.reload(); })()'); await settled(); await H('scroll(384)'); await sleep(250); };
    // поле формы: значение + change (как делает браузер при выборе/вводе)
    const setField = (sel, v) => ev('(() => { const el = document.querySelector(' + JSON.stringify('#tasksView ' + sel) + '); if (!el) return false; el.value = ' + JSON.stringify(v) + '; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
    const btn = (act) => k.click('#tasksView [data-tk-act="' + act + '"]');

    // ================================================================ admin 1280: пример владельца
    await fresh(adminCookies);
    await ev('window.Tasks.open({view:"list"})'); await settled();
    await btn('newTask'); await sleep(300);
    check('A0 форма создания: раздел «Повторения» с кнопкой «+ Добавить повтор»', (await ev('!!document.querySelector("#tasksView [data-tk-act=addOcc]") && document.querySelector("#tasksView .tk-f-occ, #tasksView .tk-occs") !== null')));
    await setField('[data-tk-field="title"]', 'пойти погулять');
    await setField('[data-tk-field="assigneePick"]', e2);
    await setField('[data-tk-field="kind"]', 'period');
    await setField('[data-tk-field="startDate"]', MAIN); await setField('[data-tk-field="startTime"]', '13:00');
    await setField('[data-tk-field="endDate"]', MAIN); await setField('[data-tk-field="endTime"]', '14:00');
    await btn('addOcc'); await sleep(200);
    await setField('[data-tk-occ-date="0"]', REP_FORM); await setField('[data-tk-occ-time="0"]', '14:30');
    check('A1 строка повтора в форме: дата 11.01.2027 и время 14:30', (await ev('document.querySelector("#tasksView [data-tk-occ-date=\\"0\\"]").value')) === REP_FORM && (await ev('document.querySelector("#tasksView [data-tk-occ-time=\\"0\\"]").value')) === '14:30');
    await k.shotEl('#tasksView .tk-occs', 'A01_form_occurrences_1280');
    await btn('saveForm'); await settled();
    let walk = (await byTitle('пойти погулять'))[0];
    check('A2 пример владельца: задача 01.01.2027 13:00 «пойти погулять» + повтор 11.01.2027 14:30 (конец 15:30) сохранены, форма закрыта',
      walk && walk.start_at === MAIN + 'T13:00' && walk.occurrences.length === 1 && walk.occurrences[0].start_at === REP_FORM + 'T14:30' && walk.occurrences[0].end_at === REP_FORM + 'T15:30' && (await S('S.form')) === null, JSON.stringify(walk && walk.occurrences));
    await ev('window.Tasks.open({view:"list"})'); await settled();
    let rows = await ev('[...document.querySelectorAll("#tasksView .tk-table tr")].filter((r) => /пойти погулять/.test(r.textContent)).map((r) => r.querySelector("[data-tk-due]") ? r.querySelector("[data-tk-due]").textContent : "")');
    check('A3 Список: одна строка задачи; в «Сроке» ближайшая дата и «↻ 1»', rows.length === 1 && /↻ 1/.test(rows[0]) && /01\.01/.test(rows[0]), JSON.stringify(rows));
    const tip = await ev('(() => { const r = [...document.querySelectorAll("#tasksView .tk-table tr")].find((x) => /пойти погулять/.test(x.textContent)); const b = r && r.querySelector(".tk-occ-n"); return b ? b.title : ""; })()');
    check('A3a подсказка «↻ 1» перечисляет все даты (01.01 и 11.01)', /01\.01/.test(tip) && /11\.01/.test(tip), tip);
    await k.shotEl('#tasksView .tk-table', 'A03_list_one_row_occ_badge_1280', { maxH: 420 });
    await ev('window.Tasks.open({view:"board"})'); await settled();
    const cards = await ev('[...document.querySelectorAll("#tasksView .tk-card")].filter((c) => /пойти погулять/.test(c.textContent)).map((c) => c.textContent)');
    check('A4 Доска: одна плитка задачи с «↻ 1»', cards.length === 1 && /↻ 1/.test(cards[0]), JSON.stringify(cards));
    await k.shot('A04_board_one_tile_1280');

    // ---- календарь: копирование плитки → вставка = повтор
    await openCal(MAIN, 'week');
    let tp = await H('tile("' + walk.id + '")');
    check('A5 календарь (неделя 28.12–03.01): плитка основной даты 01.01 13:00 есть, ↻-плитки на этой неделе нет', !!tp && !(await ev('document.querySelector("#tasksView .tk-ev.tk-occ")')));
    await rclick({ x: tp.x, y: tp.y });
    let mn = await H('menu()');
    check('A6 ПКМ по плитке задачи: пункт «Копировать» (без «Удалить повтор»)', mn && mn.items.length === 1 && mn.items[0].t === 'Копировать');
    await k.clickXY(mn.items[0].x, mn.items[0].y); await sleep(300);
    await gotoWeek(REP_PASTE);
    const cell = await H('slot("' + REP_PASTE + '", 600)');
    await rclick(cell);
    mn = await H('menu()');
    check('A7 ПКМ по ячейке 20.01 10:00 после «Копировать»: пункт «Вставить повтор» активен', mn && mn.items.length === 1 && mn.items[0].t === 'Вставить повтор' && mn.items[0].dis === false, JSON.stringify(mn));
    await k.shot('A07_menu_paste_repeat_1280');
    await ev('window.__calls.length = 0');
    await k.clickXY(mn.items[0].x, mn.items[0].y); await settled();
    walk = await srv(walk.id);
    const allWalk = await byTitle('пойти погулять');
    const wr = await writes();
    check('A8 «Вставить повтор»: один POST …action=occ_add; НОВАЯ ЗАДАЧА НЕ СОЗДАНА (на сервере по-прежнему одна), у неё повторы 11.01 14:30 и 20.01 10:00 (конец 11:00)',
      wr.length === 1 && /action=occ_add/.test(wr[0].u) && allWalk.length === 1 && walk.occurrences.length === 2 && walk.occurrences[1].start_at === REP_PASTE + 'T10:00' && walk.occurrences[1].end_at === REP_PASTE + 'T11:00', JSON.stringify([wr, walk.occurrences]));
    const toastC = await H('ctoast()');
    check('A9 сообщение «Повтор добавлен на 20.01 10:00» с действием «Открыть»; на плитке значок ↻ и подсветка', toastC && /Повтор добавлен на 20\.01 10:00/.test(toastC.text) && /Открыть/.test(toastC.text) && (await ev('document.querySelectorAll("#tasksView .tk-ev.tk-occ .tk-ev-rep").length')) === 1, JSON.stringify(toastC));
    await k.shot('A09_repeat_added_toast_1280');
    await k.clickXY(toastC.act.x, toastC.act.y); await sleep(400);
    const dates = await ev('[...document.querySelectorAll("#tasksView .tk-dates li")].map((l) => l.textContent.replace(/\\s+/g, " ").trim())');
    check('A10 «Открыть» → карточка той же задачи с перечнем дат: 01.01 (основная), 11.01 ↻, 20.01 ↻; ближайшая отмечена', (await S('S.selectedId')) === walk.id && dates.length === 3 && /основная/.test(dates[0]) && /↻/.test(dates[1]) && /ближайшая/.test(dates.join(' ')), JSON.stringify(dates));
    await k.shot('A10_card_dates_list_1280');

    // ---- перенос повтора перетаскиванием
    await ev('window.Tasks.__t.S.selectedId = null; window.Tasks.__t.render()'); await H('scroll(384)'); await sleep(250);
    const ot = await H('occTile("' + walk.id + '","' + REP_PASTE + '")');
    const dTgt = await H('day("' + REP_MOVED + '")');
    const grab = { x: ot.x, y: ot.t + 10 }, drop = { x: dTgt.x, y: dTgt.t + 11 * 48 + 12 };
    await down(grab); await slide(grab, drop, 10);
    check('A11 тень повтора на чт 11:00 при перетаскивании', (await ev('(() => { const s = document.querySelector("#tasksView .tk-shadow"); return s ? s.textContent : ""; })()')).indexOf('11:00') === 0);
    await k.shot('A11_occurrence_drag_shadow_1280');
    await ev('window.__calls.length = 0');
    await up(drop); await settled();
    const mv = await srv(walk.id);
    const wr2 = await writes();
    check('A12 перенос повтора: один POST occ_move; на сервере повтор 21.01 11:00–12:00, основная дата (01.01 13:00) и повтор 11.01 не тронуты',
      wr2.length === 1 && /action=occ_move/.test(wr2[0].u) && mv.start_at === MAIN + 'T13:00' && mv.occurrences.length === 2 && mv.occurrences[0].start_at === REP_FORM + 'T14:30' && mv.occurrences[1].start_at === REP_MOVED + 'T11:00' && mv.occurrences[1].end_at === REP_MOVED + 'T12:00', JSON.stringify([wr2, mv.occurrences]));
    await k.shot('A12_occurrence_moved_1280');

    // ---- удаление повтора
    const ot2 = await H('occTile("' + walk.id + '","' + REP_MOVED + '")');
    await rclick({ x: ot2.x, y: ot2.y });
    mn = await H('menu()');
    check('A13 ПКМ по плитке повтора: пункты «Копировать» и «Удалить повтор»', mn && mn.items.map((i) => i.t).join('|') === 'Копировать|Удалить повтор', JSON.stringify(mn));
    await k.shot('A13_menu_delete_repeat_1280');
    await ev('window.__calls.length = 0');
    await k.clickXY(mn.items[1].x, mn.items[1].y); await settled();
    const del = await srv(walk.id);
    check('A14 «Удалить повтор» (с подтверждением): удалён только этот повтор (остался 11.01 14:30), задача и основная дата на месте', del.occurrences.length === 1 && del.occurrences[0].start_at === REP_FORM + 'T14:30' && del.status === 'open' && !(await H('occTile("' + walk.id + '","' + REP_MOVED + '")')) && (await writes()).length === 1);

    // ---- блок: повтор на больничном исполнителя
    L.sql(env.tmpDb, "INSERT OR REPLACE INTO schedule_entries (employee_id,date,status,approval_status,updated_at,version) VALUES ('" + e1 + "','" + SICK_DAY + "','sick','approved','2026-11-14',1);");
    await ev('window.Tasks.open({view:"list"})'); await settled();
    await btn('newTask'); await sleep(300);
    await setField('[data-tk-field="title"]', 'Повтор на больничный');
    await setField('[data-tk-field="assigneePick"]', e1);
    await setField('[data-tk-field="startDate"]', '2027-02-01'); await setField('[data-tk-field="startTime"]', '10:00');
    await btn('addOcc'); await setField('[data-tk-occ-date="0"]', '2027-02-05');
    await btn('addOcc'); await setField('[data-tk-occ-date="1"]', SICK_DAY);
    await btn('saveForm'); await settled();
    const errTxt = await ev('(document.querySelector("#tasksView [data-tk-occ-err]") || {}).textContent || ""');
    const errIdx = await ev('(document.querySelector("#tasksView [data-tk-occ-err]") || { dataset: {} }).dataset.tkOccErr');
    check('A15 повтор на день больничного исполнителя: задача не создана, понятная ошибка у нужной строки (на 03.02, первая по порядку), форма открыта',
      errIdx === '0' && /03\.02/.test(errTxt) && /больнич/.test(errTxt) && (await byTitle('Повтор на больничный')).length === 0 && (await S('S.form')) !== null, errIdx + ' ' + errTxt);
    await k.shotEl('#tasksView .tk-occs', 'A15_occurrence_sick_error_1280');
    await btn('cancelForm'); await sleep(200);

    // ---- закрыть → закрыта целиком
    await ev('window.Tasks.open({view:"board", taskId:' + JSON.stringify(walk.id) + '})'); await settled();
    await k.clickText('#tasksView .tk-detail button', 'Закрыть'); await settled();
    const cl = await srv(walk.id);
    check('A16 «Закрыть»: задача закрыта целиком (статус closed; повтор остался у закрытой задачи, отдельно не закрывается)', cl.status === 'closed' && cl.occurrences.length === 1);
    await openCal(REP_FORM, 'week');
    check('A17 закрытая задача: плитка повтора на 11.01 есть и тоже «приглушена» (tk-dim)', (await ev('!!document.querySelector("#tasksView .tk-ev.tk-occ.tk-dim")')));
    await k.shot('A17_closed_task_occurrence_dim_1280');
    await L.http(env.base, ck, 'POST', 'api/tasks.php?id=' + walk.id + '&action=reopen', { version: cl.version });

    // ---- матрица: иконки на днях основной даты и повторов
    await ev('document.getElementById("vacationTrigger").click()'); await sleep(900);
    await k.click('#tabMatrix'); await sleep(1200);

    const apiId = e1;
    const icAt = (d) => ev('(() => { const e = document.querySelector(".tk-mx-ic[data-tk-api=\\"' + apiId + '\\"][data-tk-date=\\"' + d + '\\"]"); return e ? e.textContent : null; })()');
    await k.waitFor('!!document.querySelector(".tk-mx-ic[data-tk-date=\\"' + MX1 + '\\"]")', 10000);
    const ics = [await icAt(MX1), await icAt(MX2), await icAt(MX3)];
    check('M1 матрица 2026: иконки задачи «Матрица повторы» на днях основной даты (08.12) и обоих повторов (15.12, 22.12)', ics.every((x) => x !== null), JSON.stringify(ics));
    check('M2 у сотрудника-исполнителя рамка и на днях повторов (ячейки tk-fr)', (await ev('(() => { const n = (d) => { const e = document.querySelector(".tk-mx-ic[data-tk-api=\\"' + apiId + '\\"][data-tk-date=\\"" + d + "\\"]"); return e && e.parentNode.classList.contains("tk-fr"); }; return n("' + MX2 + '") && n("' + MX3 + '"); })()')));
    await k.shot('M_matrix_icons_on_repeat_days_1280');

    // ================================================================ роли: supervisor / viewer — только чтение
    for (const role of ['supervisor_zone0', 'viewer_test']) {
      const rc = await L.login(env.base, role);
      await fresh(rc);
      await openCal(MX2, 'week');
      const hasOcc = await ev('!!document.querySelector("#tasksView .tk-ev.tk-occ")');
      const dnd = await ev('document.querySelectorAll("#tasksView [data-tk-dnd]").length');
      const occ = await H('occTile("' + TM.id + '","' + MX2 + '")');
      if (occ) await rclick({ x: occ.x, y: occ.y });
      const cmv = await ev('window.__cm.slice(-1)[0]');
      check('R-' + role + '-1 календарь: плитка повтора ↻ видна, перетаскивания и нашего меню нет (родное меню браузера не подавлено)', hasOcc && dnd === 0 && !(await H('menu()')) && cmv && cmv.prevented === false, JSON.stringify([hasOcc, dnd, cmv]));
      await ev('window.Tasks.open({view:"list"})'); await settled();
      check('R-' + role + '-2 Список: «↻ 2» виден, кнопок записи нет', (await ev('!!document.querySelector("#tasksView .tk-occ-n")')) && !(await ev('!!document.querySelector("#tasksView [data-tk-act=newTask]")')));
      const w403 = await L.http(env.base, rc.join('; '), 'POST', 'api/tasks.php?id=' + TM.id + '&action=occ_add', { version: 1, start_at: '2026-12-28T10:00' });
      check('R-' + role + '-3 API occ_add → 403', w403.status === 403, w403.status);
      if (role === 'viewer_test') await k.shot('R_viewer_calendar_repeat_1280');
    }

    // ================================================================ 375 px (мобильный), admin
    await fresh(adminCookies, 375, 800, true);
    await ev('window.Tasks.open({view:"list"})'); await settled();
    await btn('newTask'); await sleep(300);
    await setField('[data-tk-field="title"]', 'Мобильная форма');
    await setField('[data-tk-field="assigneePick"]', e2);
    await setField('[data-tk-field="startDate"]', '2027-04-05'); await setField('[data-tk-field="startTime"]', '09:00');
    await btn('addOcc'); await btn('addOcc'); await sleep(200);
    check('N1 375 px: форма с двумя строками повторов — без горизонтальной прокрутки страницы', (await H('ovf()')) <= 1, await H('ovf()'));
    await k.shotEl('#tasksView .tk-occs', 'N01_form_occurrences_375');
    await btn('cancelForm'); await sleep(200);
    await ev('window.Tasks.open({view:"list"})'); await settled();
    check('N2 375 px: Список — «↻ 2» у задачи с повторами виден, страница без горизонтальной прокрутки', (await ev('!!document.querySelector("#tasksView .tk-occ-n")')) && (await H('ovf()')) <= 1, await H('ovf()'));
    await k.shot('N02_list_375');
    await openCal(MX2, 'week');
    check('N3 375 px: календарь — плитка повтора ↻ в сетке', (await ev('!!document.querySelector("#tasksView .tk-ev.tk-occ")')) );
    await k.shot('N03_calendar_375');
    await ev('window.Tasks.open({view:"board", taskId:' + JSON.stringify(TM.id) + '})'); await settled();
    check('N4 375 px: карточка — блок «Даты выполнения · 3»', /Даты выполнения · 3/.test(await ev('document.querySelector("#tasksView .tk-detail").textContent')));
    await k.shot('N04_card_375');
  } catch (e) {
    console.log('FATAL', e && e.stack || e);
    check('FATAL необработанное исключение', false, (e && e.stack) || e);
  } finally {
    C.save();
    env.cleanup();
  }
  console.log('RESULT: ' + C.passed + ' passed, ' + C.failed + ' failed');
  process.exit(C.failed ? 1 : 0);
})();
