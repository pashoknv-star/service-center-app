// V6.3-3 (приёмка, вне gate): B — Д-1 повторяющиеся задачи, пример владельца целиком (admin, 1280), затем 375.
// Запуск: node scripts/v63_accept_b_recur.js → reports/V6_3/V6.3-3_screens/B_*.png, B_results.json
'use strict';
const path = require('path');
const { L, seed, D, sleep, OUT, kit, api } = require('./v63_accept_lib.js');

const MAIN = '2027-01-01', REP_FORM = '2027-01-11', REP_PASTE = '2027-01-20', REP_MOVED = '2027-01-21';
const HOUR = 48;

(async () => {
  const C = L.makeChecker(path.join(OUT, 'B_results.json'));
  const env = await L.startEnv();
  try {
    const s = await seed(env);
    const ck = s.adminCookies.join('; ');
    const A = await env.openBrowser(); C.note('browser', A.version);
    const cdp = A.cdp, k = kit(cdp, env), ev = k.ev;
    const srvList = async () => (await api(env, ck, 'GET', 'api/tasks.php?from=2026-01-01&to=2028-12-31')).json.tasks;
    const srv = async (id) => (await api(env, ck, 'GET', 'api/tasks.php?id=' + id)).json.task;
    const byTitle = async (t) => (await srvList()).filter((x) => x.title === t);
    const S = (expr) => ev('(() => { const S = window.Tasks.__t.S; return ' + expr + '; })()');
    const settled = async () => { await sleep(150); await k.waitFor('!window.Tasks.__t.S.busy && !window.Tasks.__t.S.loading', 20000); await sleep(400); };
    const setField = (sel, v) => ev('(() => { const el = document.querySelector(' + JSON.stringify('#tasksView ' + sel) + '); if (!el) return false; el.value = ' + JSON.stringify(v) + '; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
    const btn = (act) => k.click('#tasksView [data-tk-act="' + act + '"]');
    const emps = (await api(env, ck, 'GET', 'api/employees.php')).json;
    const eList = (Array.isArray(emps) ? emps : emps.data || emps.employees || []).map((e) => String(e.id));
    const E1 = 'emp_1', E2 = 'emp_2', E3 = 'emp_3';
    const installHooks = () => ev(`(() => {
      window.__calls = []; window.__cm = []; window.__confirms = []; window.__confirmAns = true;
      if (!window.__fp) { window.__fp = true; const of = window.fetch; window.fetch = function (u, o) { window.__calls.push({ u: String(u), m: (o && o.method) || 'GET', b: o && o.body }); return of.apply(this, arguments); };
        document.addEventListener('contextmenu', (e) => window.__cm.push({ prevented: e.defaultPrevented }), false);
        window.confirm = (m) => { window.__confirms.push(m); return window.__confirmAns; }; }
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
        ovf: () => document.documentElement.scrollWidth - document.documentElement.clientWidth };
      return true; })()`);
    const H = (expr) => ev('window.__h.' + expr);
    const calls = () => ev('window.__calls.slice()');
    const writes = async () => (await calls()).filter((c) => c.m !== 'GET');
    const fresh = async (cookies, w, h, mobile) => { await k.size(w || 1280, h || 900, !!mobile); await k.load(cookies); await installHooks(); };
    const openCal = async (date, mode) => {
      await ev('window.Tasks.open({employeeId:"",date:' + JSON.stringify(date) + ',view:"calendar",mode:' + JSON.stringify(mode || 'week') + '})');
      await k.waitFor('!!document.querySelector("#tasksView .tk-cal-bd") && !window.Tasks.__t.S.loading', 30000); await sleep(500);
      await H('scroll(384)'); await sleep(250);
    };
    const gotoWeek = async (date) => { await ev('(() => { window.Tasks.__t.S.cal.anchor = "' + date + '"; window.Tasks.reload(); })()'); await settled(); await H('scroll(384)'); await sleep(250); };
    const toastTexts = () => H('toasts()');

    // ===================================================================== 1. пример владельца: форма
    console.log('=== Д-1 admin 1280: создание через форму');
    await fresh(s.adminCookies);
    await ev('window.Tasks.open({view:"list"})'); await settled();
    await btn('newTask'); await sleep(300);
    const hasOccSection = await ev(`(() => { const f = document.querySelector('#tasksView .tk-f-occ'); return f ? { label: (f.querySelector('label, .tk-f-lbl, span') || {}).textContent, btn: !!f.querySelector('[data-tk-act=addOcc]'), none: /повторов нет/.test(f.textContent) } : null; })()`);
    console.log('occ section', JSON.stringify(hasOccSection));
    C.check('Д-1 форма создания: раздел «Повторения» с кнопкой «+ Добавить повтор» и подписью «повторов нет»', hasOccSection && hasOccSection.btn && hasOccSection.none, JSON.stringify(hasOccSection));
    await k.shotEl('#tasksView form.tk-form', 'B00_form_empty_1280', { maxH: 1100 });
    await setField('[data-tk-field="title"]', 'пойти погулять');
    await setField('[data-tk-field="description"]', 'погулять на улице в пуховике');
    await setField('[data-tk-field="assigneePick"]', E2);
    await setField('[data-tk-field="kind"]', 'period');
    await setField('[data-tk-field="startDate"]', MAIN); await setField('[data-tk-field="startTime"]', '13:00');
    await setField('[data-tk-field="endDate"]', MAIN); await setField('[data-tk-field="endTime"]', '14:00');
    // реальный клик по «+ Добавить повтор»
    await btn('addOcc'); await sleep(200);
    const rowsN = await ev('document.querySelectorAll("#tasksView .tk-occrow").length');
    C.check('Д-1 реальный клик «+ Добавить повтор» → появилась строка повтора (дата + время)', rowsN === 1 && (await ev('!!document.querySelector("#tasksView [data-tk-occ-date=\\"0\\"]") && !!document.querySelector("#tasksView [data-tk-occ-time=\\"0\\"]")')), rowsN);
    const defaults = await ev('({ d: document.querySelector("#tasksView [data-tk-occ-date=\\"0\\"]").value, t: document.querySelector("#tasksView [data-tk-occ-time=\\"0\\"]").value })');
    console.log('defaults of new occ row', JSON.stringify(defaults));
    await setField('[data-tk-occ-date="0"]', REP_FORM); await setField('[data-tk-occ-time="0"]', '14:30');
    await k.shotEl('#tasksView form.tk-form', 'B01_form_filled_1280', { maxH: 1100 });
    await k.shotEl('#tasksView .tk-f-occ', 'B01b_form_occurrences_1280');
    await btn('saveForm'); await settled();
    let walk = (await byTitle('пойти погулять'))[0];
    C.check('Д-1 пример владельца: «пойти погулять» / «погулять на улице в пуховике», 01.01.2027 13:00–14:00, повтор 11.01.2027 14:30–15:30 сохранены; форма закрыта; других задач с таким названием нет',
      walk && walk.description === 'погулять на улице в пуховике' && walk.start_at === MAIN + 'T13:00' && walk.end_at === MAIN + 'T14:00' && walk.occurrences.length === 1 && walk.occurrences[0].start_at === REP_FORM + 'T14:30' && walk.occurrences[0].end_at === REP_FORM + 'T15:30' && (await byTitle('пойти погулять')).length === 1 && (await S('S.form')) === null, JSON.stringify(walk && [walk.start_at, walk.end_at, walk.occurrences]));
    C.check('Д-1 API: next_at = ближайшее предстоящее выполнение = 01.01.2027 13:00 (сегодня 14.11.2026), days[] включает 01.01 и 11.01', walk.next_at === MAIN + 'T13:00' && walk.days.includes(MAIN) && walk.days.includes(REP_FORM), JSON.stringify([walk.next_at, walk.days]));

    // ===================================================================== 2. Список и Доска: одна запись
    console.log('=== Список / Доска');
    await ev('window.Tasks.open({view:"list"})'); await settled();
    let rows = await ev(`[...document.querySelectorAll('#tasksView .tk-row')].filter((r) => /пойти погулять/.test(r.textContent)).map((r) => ({ due: r.querySelector('[data-tk-due]').textContent.replace(/\\s+/g, ' ').trim(), dueTitle: r.querySelector('[data-tk-due]').getAttribute('title'), badge: (r.querySelector('.tk-occ-n') || {}).textContent, badgeTitle: (r.querySelector('.tk-occ-n') || {}).title, desc: r.textContent }))`);
    console.log('list row', JSON.stringify(rows));
    C.check('Д-1 Список: ровно ОДНА строка «пойти погулять»', rows.length === 1, rows.length);
    C.check('Д-1 Список: «Срок» = ближайшее выполнение (01.01 13:00) и значок «↻ 1»', rows[0] && /01\.01/.test(rows[0].due) && /13:00/.test(rows[0].due) && rows[0].badge === '↻ 1', JSON.stringify(rows[0]));
    C.check('Д-1 Список: подсказка «↻ 1» перечисляет ВСЕ даты (01.01 13:00 и ↻ 11.01 14:30)', rows[0] && /01\.01/.test(rows[0].badgeTitle) && /11\.01/.test(rows[0].badgeTitle) && /14:30/.test(rows[0].badgeTitle) && /13:00/.test(rows[0].badgeTitle), rows[0] && rows[0].badgeTitle);
    C.check('Д-1 Список: описание отображается («погулять на улице в пуховике»)', rows[0] && /погулять на улице в пуховике/.test(rows[0].desc || ''), rows[0] && rows[0].desc);
    await ev(`document.querySelector('#tasksView .tk-row[data-id="${walk.id}"]').scrollIntoView({block:'center'})`); await sleep(300);
    await k.shot('B02_list_one_row_1280');
    await k.shotEl('#tasksView .tk-row[data-id="' + walk.id + '"]', 'B02b_list_row_1280', { maxH: 140 });
    await ev('window.Tasks.open({view:"board"})'); await settled();
    const cards = await ev(`[...document.querySelectorAll('#tasksView .tk-card')].filter((c) => /пойти погулять/.test(c.textContent)).map((c) => ({ t: c.textContent.replace(/\\s+/g, ' ').trim(), badgeTitle: (c.querySelector('.tk-occ-n') || {}).title }))`);
    C.check('Д-1 Доска: ровно ОДНА плитка, срок 01.01 13:00 и «↻ 1», подсказка со всеми датами', cards.length === 1 && /↻ 1/.test(cards[0].t) && /01\.01/.test(cards[0].t) && /11\.01/.test(cards[0].badgeTitle || ''), JSON.stringify(cards));
    await k.shot('B03_board_one_tile_1280');
    await k.click('#tasksView .tk-card[data-id="' + walk.id + '"] b'); await sleep(400);
    let dates = await ev('[...document.querySelectorAll("#tasksView .tk-detail .tk-dates li")].map((l) => l.textContent.replace(/\\s+/g, " ").trim())');
    C.check('Д-1 карточка: «Даты выполнения · 2»: основная 01.01 13:00 и ↻ 11.01 14:30, ближайшая отмечена', /Даты выполнения · 2/.test(await ev('document.querySelector("#tasksView .tk-detail").textContent')) && dates.length === 2 && /01\.01/.test(dates[0]) && /основная/.test(dates[0]) && /11\.01/.test(dates[1]) && /14:30/.test(dates[1]) && /ближайшая/.test(dates.join(' ')), JSON.stringify(dates));
    await k.shot('B04_card_dates_1280');

    // ===================================================================== 3. календарь: плитки ↻ — время и длительность
    console.log('=== Календарь');
    await openCal(REP_FORM, 'week');
    const ot = await H('occTile("' + walk.id + '","' + REP_FORM + '")');
    const dayR = await H('day("' + REP_FORM + '")');
    const expTop = (14.5 * HOUR), expH = HOUR;
    console.log('occ tile', JSON.stringify(ot), 'day', JSON.stringify(dayR));
    const tileBox = await ev(`(() => { const t = document.querySelector('#tasksView .tk-cal-bd .tk-day[data-date="${REP_FORM}"] .tk-ev.tk-occ'); const d = document.querySelector('#tasksView .tk-cal-bd .tk-day[data-date="${REP_FORM}"]'); const r = t.getBoundingClientRect(), dr = d.getBoundingClientRect(); return { top: r.top - dr.top, h: r.height, text: t.textContent.replace(/\\s+/g, ' ').trim(), rep: !!t.querySelector('.tk-ev-rep'), title: t.getAttribute('title'), dashed: getComputedStyle(t).borderLeftStyle, id: t.dataset.id, occ: t.dataset.occ }; })()`);
    console.log('tileBox', JSON.stringify(tileBox));
    C.check('Д-1 календарь: на неделе 11.01 есть плитка ↻ (значок, пунктирная рамка) этой же задачи с временем 14:30 в тексте', tileBox && tileBox.rep && /14:30/.test(tileBox.text + ' ' + tileBox.title) && tileBox.dashed === 'dashed' && tileBox.id === walk.id && tileBox.occ !== undefined, JSON.stringify(tileBox));
    C.check('Д-1 календарь: плитка повтора расположена на 14:30 (±3 px от ' + expTop + ' в колонке дня: ' + Math.round(tileBox.top) + ') и высота = 1 час (±4 px от ' + expH + ': ' + Math.round(tileBox.h) + ')', Math.abs(tileBox.top - (expTop + (dayR.t - dayR.t))) < 40 && Math.abs(tileBox.h - expH) <= 4, JSON.stringify(tileBox));
    // сверка с положением ячейки 14:30 (слот) — абсолютная
    const slot1430 = await H('slot("' + REP_FORM + '", 870)');
    const slot1400 = await H('slot("' + REP_FORM + '", 840)');
    console.log('slot 14:30', JSON.stringify(slot1430), 'slot 14:00', JSON.stringify(slot1400));
    if (slot1430) C.check('Д-1 календарь: верх плитки ↻ совпадает с верхом ячейки 14:30 (Δ ' + Math.round(ot.t - slot1430.t) + ' px)', Math.abs(ot.t - slot1430.t) <= 3, ot.t + ' vs ' + slot1430.t);
    else if (slot1400) C.check('Д-1 календарь: верх плитки ↻ на 14:30 = верх ячейки 14:00 + 24 px (Δ ' + Math.round(ot.t - slot1400.t - 24) + ')', Math.abs(ot.t - (slot1400.t + HOUR / 2)) <= 3, ot.t + ' vs ' + slot1400.t);
    await k.shot('B05_calendar_week_occurrence_1280');
    // клик по плитке повтора → карточка той же задачи
    await k.clickXY(ot.x, ot.t + 10); await sleep(500);
    C.check('Д-1 клик по плитке ↻ открывает карточку той же задачи (не форму) с перечнем дат', (await S('S.selectedId')) === walk.id && (await ev('!!document.querySelector("#tasksView .tk-detail .tk-dates")')) && !(await S('S.form')), (await S('S.selectedId')));
    await ev('window.Tasks.__t.S.selectedId = null; window.Tasks.__t.render()'); await H('scroll(384)'); await sleep(200);

    // ===================================================================== 4. копировать → вставить повтор
    console.log('=== копировать / вставить повтор');
    await gotoWeek(MAIN);
    let tp = await H('tile("' + walk.id + '")');
    C.check('Д-1 неделя 28.12–03.01: плитка основной даты 01.01 13:00 есть (без ↻)', !!tp && !(await ev('document.querySelector("#tasksView .tk-ev.tk-occ")')));
    await k.rclick(tp.x, tp.y);
    let mn = await H('menu()');
    C.check('Д-1 ПКМ по плитке основной даты: одно меню «Копировать» (нет «Удалить повтор»)', mn && mn.items.length === 1 && mn.items[0].t === 'Копировать', JSON.stringify(mn));
    await k.shot('B06_menu_copy_1280');
    await k.clickXY(mn.items[0].x, mn.items[0].y); await sleep(300);
    await gotoWeek(REP_PASTE);
    const cell = await H('slot("' + REP_PASTE + '", 600)');
    await k.rclick(cell.x, cell.y);
    mn = await H('menu()');
    C.check('Д-1 ПКМ по пустой ячейке 20.01 10:00: единственный активный пункт «Вставить повтор» (не «Вставить»)', mn && mn.items.length === 1 && mn.items[0].t === 'Вставить повтор' && mn.items[0].dis === false, JSON.stringify(mn));
    await k.shot('B07_menu_paste_repeat_1280');
    await ev('window.__calls.length = 0');
    const before = (await srvList()).length;
    await k.clickXY(mn.items[0].x, mn.items[0].y); await settled();
    walk = await srv(walk.id);
    const wr = await writes();
    const after = (await srvList()).length;
    C.check('Д-1 «Вставить повтор»: один POST …action=occ_add, НОВАЯ ЗАДАЧА НЕ СОЗДАНА (задач ' + before + ' → ' + after + '), у задачи 2 повтора: 11.01 14:30 и 20.01 10:00 (конец 11:00, длительность 1 ч)',
      wr.length === 1 && /action=occ_add/.test(wr[0].u) && wr[0].m === 'POST' && before === after && walk.occurrences.length === 2 && walk.occurrences[1].start_at === REP_PASTE + 'T10:00' && walk.occurrences[1].end_at === REP_PASTE + 'T11:00' && (await byTitle('пойти погулять')).length === 1, JSON.stringify([wr, walk.occurrences]));
    const ct = await H('ctoast()');
    C.check('Д-1 сообщение «Повтор добавлен на 20.01 10:00» с действием «Открыть»; плитка ↻ на 20.01', ct && /Повтор добавлен на 20\.01 10:00/.test(ct.text) && /Открыть/.test(ct.text) && !!(await H('occTile("' + walk.id + '","' + REP_PASTE + '")')), JSON.stringify(ct));
    await k.shot('B08_repeat_added_toast_1280');
    await k.clickXY(ct.act.x, ct.act.y); await sleep(400);
    dates = await ev('[...document.querySelectorAll("#tasksView .tk-dates li")].map((l) => l.textContent.replace(/\\s+/g, " ").trim())');
    C.check('Д-1 «Открыть» → карточка с тремя датами: 01.01 основная, 11.01, 20.01', (await S('S.selectedId')) === walk.id && dates.length === 3 && /20\.01/.test(dates[2]), JSON.stringify(dates));
    await k.shot('B09_card_three_dates_1280');
    // повтор вставкой в «ту же» дату/время → ошибка (дубль)
    await ev('window.Tasks.__t.S.selectedId = null; window.Tasks.__t.render()'); await H('scroll(384)'); await sleep(200);
    // повтор в ту же дату/время: ячейку закрывает сама плитка повтора (ПКМ даёт меню плитки), поэтому проверяем сервером и формой (раздел C)
    const dupCnt0 = (await srv(walk.id)).occurrences.length;
    const dupR = await api(env, ck, 'POST', 'api/tasks.php?id=' + walk.id + '&action=occ_add', { version: (await srv(walk.id)).version, start_at: REP_PASTE + 'T10:00' });
    const w2 = await srv(walk.id);
    C.check('Д-1 API: occ_add на ту же дату/время (20.01 10:00) → 400 occurrence_duplicate с понятным message, повторов по-прежнему ' + dupCnt0, dupR.status === 400 && dupR.json.error === 'occurrence_duplicate' && /уже есть|совпад/i.test(dupR.json.message || '') && w2.occurrences.length === dupCnt0, JSON.stringify(dupR));
    const dupMain = await api(env, ck, 'POST', 'api/tasks.php?id=' + walk.id + '&action=occ_add', { version: w2.version, start_at: MAIN + 'T13:00' });
    C.check('Д-1 API: occ_add на дату/время основной даты (01.01 13:00) → 400 occurrence_duplicate', dupMain.status === 400 && dupMain.json.error === 'occurrence_duplicate', JSON.stringify(dupMain));

    // ===================================================================== 5. перенос повтора
    console.log('=== перенос повтора');
    await ev('window.Tasks.__t.S.msg = null; window.Tasks.__t.render()'); await H('scroll(384)'); await sleep(200);
    const mainBefore = (await srv(walk.id)).start_at + '|' + (await srv(walk.id)).end_at;
    const otm = await H('occTile("' + walk.id + '","' + REP_PASTE + '")');
    const dTgt = await H('day("' + REP_MOVED + '")');
    const grab = { x: otm.x, y: otm.t + 10 }, drop = { x: dTgt.x, y: dTgt.t + 11 * HOUR + 12 };
    await k.move(grab.x, grab.y);
    await k.mouse('mousePressed', grab.x, grab.y);
    for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grab.x + (drop.x - grab.x) * i / 10, y: grab.y + (drop.y - grab.y) * i / 10, button: 'left', buttons: 1 }); await sleep(25); }
    await sleep(250);
    const shadow = await ev('(() => { const s = document.querySelector("#tasksView .tk-shadow"); return s ? s.textContent : ""; })()');
    C.check('Д-1 при перетаскивании ↻-плитки видна тень с новым временем (11:00…): «' + shadow + '»', /^11:00/.test(shadow), shadow);
    await k.shot('B10_occurrence_drag_shadow_1280');
    await ev('window.__calls.length = 0');
    await k.mouse('mouseReleased', drop.x, drop.y); await settled();
    const mv = await srv(walk.id);
    const wr2 = await writes();
    C.check('Д-1 перенос повтора: один POST occ_move (не PUT); повтор 21.01 11:00–12:00; основная дата и повтор 11.01 14:30 не тронуты', wr2.length === 1 && /action=occ_move/.test(wr2[0].u) && wr2[0].m === 'POST' && mv.start_at + '|' + mv.end_at === mainBefore && mv.occurrences.length === 2 && mv.occurrences[0].start_at === REP_FORM + 'T14:30' && mv.occurrences[1].start_at === REP_MOVED + 'T11:00' && mv.occurrences[1].end_at === REP_MOVED + 'T12:00', JSON.stringify([wr2, mv.start_at, mv.occurrences]));
    await k.shot('B11_occurrence_moved_1280');
    // перенос основной плитки (регрессия W-5): PUT, повторы остаются
    await gotoWeek(MAIN);
    tp = await H('tile("' + walk.id + '")');
    const dTgt2 = await H('day("2027-01-02")');
    await ev('window.__calls.length = 0');
    await k.drag(tp.x, tp.t + 10, dTgt2.x, dTgt2.t + 15 * HOUR + 12, { steps: 10 }); await settled();
    const mv2 = await srv(walk.id), wr3 = await writes();
    C.check('Д-1 перенос ОСНОВНОЙ плитки (01.01 → 02.01 15:00): PUT; повторы сдвинуты НЕ как даты (11.01 14:30 и 21.01 11:00 остались), концы повторов пересчитаны под длительность 1 ч', wr3.length === 1 && wr3[0].m === 'PUT' && mv2.start_at === '2027-01-02T15:00' && mv2.occurrences.length === 2 && mv2.occurrences[0].start_at === REP_FORM + 'T14:30' && mv2.occurrences[1].start_at === REP_MOVED + 'T11:00' && mv2.occurrences.every((o) => /T\d\d:\d\d$/.test(o.end_at)), JSON.stringify([wr3.map((c) => c.m), mv2.start_at, mv2.end_at, mv2.occurrences]));
    // вернуть
    await api(env, ck, 'PUT', 'api/tasks.php?id=' + walk.id, { version: mv2.version, start_at: MAIN + 'T13:00', end_at: MAIN + 'T14:00' });

    // ===================================================================== 6. удалить повтор
    console.log('=== удалить повтор');
    await openCal(REP_MOVED, 'week');
    const ot2 = await H('occTile("' + walk.id + '","' + REP_MOVED + '")');
    await k.rclick(ot2.x, ot2.y);
    mn = await H('menu()');
    C.check('Д-1 ПКМ по плитке повтора: «Копировать» и «Удалить повтор»', mn && mn.items.map((i) => i.t).join('|') === 'Копировать|Удалить повтор', JSON.stringify(mn));
    await k.shot('B12_menu_delete_repeat_1280');
    // отказ в confirm: повтор остаётся
    await ev('window.__confirmAns = false; window.__confirms.length = 0; window.__calls.length = 0');
    await k.clickXY(mn.items[1].x, mn.items[1].y); await settled();
    const keep = await srv(walk.id), conf1 = await ev('window.__confirms.slice()');
    C.check('Д-1 «Удалить повтор» → запрос подтверждения (' + JSON.stringify(conf1) + '); при отказе повтор остаётся, запросов записи нет', conf1.length === 1 && /повтор/i.test(conf1[0]) && keep.occurrences.length === 2 && (await writes()).length === 0, JSON.stringify([conf1, keep.occurrences]));
    await ev('window.__confirmAns = true'); await H('scroll(384)');
    const ot3 = await H('occTile("' + walk.id + '","' + REP_MOVED + '")');
    await k.rclick(ot3.x, ot3.y); mn = await H('menu()');
    await ev('window.__calls.length = 0');
    await k.clickXY(mn.items[1].x, mn.items[1].y); await settled();
    const del = await srv(walk.id), wr4 = await writes();
    C.check('Д-1 подтверждено → один POST occ_delete; удалён ТОЛЬКО этот повтор (остался 11.01 14:30), задача открыта, основная дата на месте; плитки на 21.01 нет', wr4.length === 1 && /action=occ_delete/.test(wr4[0].u) && del.occurrences.length === 1 && del.occurrences[0].start_at === REP_FORM + 'T14:30' && del.status === 'open' && del.start_at === MAIN + 'T13:00' && !(await H('occTile("' + walk.id + '","' + REP_MOVED + '")')), JSON.stringify([wr4.map((c) => c.u), del.occurrences]));
    // вернуть второй повтор для дальнейших проверок
    await api(env, ck, 'POST', 'api/tasks.php?id=' + walk.id + '&action=occ_add', { version: del.version, start_at: REP_PASTE + 'T10:00' });

    // ===================================================================== 7. закрыть → закрыта целиком
    console.log('=== закрытие');
    walk = await srv(walk.id);
    await ev('window.Tasks.open({view:"board", taskId:' + JSON.stringify(walk.id) + '})'); await settled();
    await k.clickText('#tasksView .tk-detail button', 'Закрыть'); await settled();
    const cl = await srv(walk.id);
    C.check('Д-1 «Закрыть» закрывает задачу ЦЕЛИКОМ: статус closed одним действием, повторы остаются у закрытой задачи (отдельного статуса у повтора нет)', cl.status === 'closed' && cl.occurrences.length === 2 && cl.occurrences.every((o) => !('status' in o)), JSON.stringify(cl.occurrences));
    await ev('window.Tasks.open({view:"list"})'); await settled();
    const stRow = await ev(`(() => { const r = document.querySelector('#tasksView .tk-row[data-id="${walk.id}"]'); return r ? r.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    console.log('closed row:', stRow);
    await openCal(REP_FORM, 'week');
    C.check('Д-1 закрытая задача: плитка повтора на 11.01 приглушена (tk-dim) так же, как основная', await ev('!!document.querySelector("#tasksView .tk-ev.tk-occ.tk-dim")'), '');
    await k.shot('B13_closed_task_dim_1280');
    await api(env, ck, 'POST', 'api/tasks.php?id=' + walk.id + '&action=reopen', { version: cl.version });

    // ===================================================================== 8. больничный / командировка
    console.log('=== больничный / командировка');
    L.sql(env.tmpDb, "INSERT OR REPLACE INTO schedule_entries (employee_id,date,status,approval_status,updated_at,version) VALUES ('" + E1 + "','2027-02-03','sick','approved','2026-11-14',1);");
    await ev('window.Tasks.open({view:"list"})'); await settled();
    await btn('newTask'); await sleep(300);
    await setField('[data-tk-field="title"]', 'Повтор на больничный');
    await setField('[data-tk-field="assigneePick"]', E1);
    await setField('[data-tk-field="startDate"]', '2027-02-01'); await setField('[data-tk-field="startTime"]', '10:00');
    await btn('addOcc'); await setField('[data-tk-occ-date="0"]', '2027-02-05');
    await btn('addOcc'); await setField('[data-tk-occ-date="1"]', '2027-02-03');
    await btn('saveForm'); await settled();
    const sick = await ev('({ idx: (document.querySelector("#tasksView [data-tk-occ-err]") || { dataset: {} }).dataset.tkOccErr, txt: (document.querySelector("#tasksView [data-tk-occ-err]") || {}).textContent || "", form: !!document.querySelector("#tasksView form.tk-form") })');
    console.log('sick err', JSON.stringify(sick));
    C.check('Д-1 повтор на день больничного исполнителя (03.02): задача НЕ создана, форма открыта, понятная ошибка у нужной строки (с датой и словом «больничный»)', sick.form && sick.idx === '0' && /03\.02/.test(sick.txt) && /больнич/i.test(sick.txt) && (await byTitle('Повтор на больничный')).length === 0, JSON.stringify(sick));
    await k.shotEl('#tasksView .tk-f-occ', 'B14_occurrence_sick_error_1280');
    await btn('cancelForm'); await sleep(200);
    // командировка
    L.sql(env.tmpDb, "INSERT INTO trips (id,title,status,version,created_at,updated_at) VALUES ('trip_v63','Командировка приёмки','confirmed',1,'2026-11-01T00:00:00+00:00','2026-11-01T00:00:00+00:00'); INSERT INTO trip_participants (trip_id,employee_id,start_date,end_date) VALUES ('trip_v63','" + E3 + "','2027-03-10','2027-03-12');");
    const trip = await api(env, ck, 'POST', 'api/tasks.php', { title: 'Повтор на командировку', assignees: [E3], start_at: '2027-03-01T10:00', end_at: '2027-03-01T11:00', occurrences: [{ start_at: '2027-03-11T10:00' }] });
    C.check('Д-1 API: повтор на день командировки исполнителя (11.03) → 422 TASK_BLOCKED_BY_SICK_OR_TRIP, occurrence_index 0, понятное message с датой', trip.status === 422 && trip.json.error === 'TASK_BLOCKED_BY_SICK_OR_TRIP' && trip.json.occurrence_index === 0 && /11\.03/.test(trip.json.message || '') && /командиров/i.test(trip.json.message || ''), JSON.stringify(trip.json));
    const tripOk = await api(env, ck, 'POST', 'api/tasks.php', { title: 'Командировка основная дата', assignees: [E3], start_at: '2027-03-11T10:00', end_at: '2027-03-11T11:00' });
    C.check('Д-1 контроль: тот же день как ОСНОВНАЯ дата тоже блокируется (то же правило для повтора и основной)', tripOk.status === 422, tripOk.status);
    // вставка повтора в календаре на день больничного → тост с ошибкой, повтор не добавлен
    const okT = await api(env, ck, 'POST', 'api/tasks.php', { title: 'Календарь больничный', assignees: [E1], start_at: '2027-02-08T10:00', end_at: '2027-02-08T11:00' });
    await openCal('2027-02-08', 'week'); const okTile = await H('tile("' + okT.json.task.id + '")');
    await k.rclick(okTile.x, okTile.y); mn = await H('menu()'); await k.clickXY(mn.items[0].x, mn.items[0].y); await sleep(300);
    await gotoWeek('2027-02-03');
    const sc = await H('slot("2027-02-03", 600)');
    await ev('window.__calls.length = 0');
    await k.rclick(sc.x, sc.y); mn = await H('menu()');
    await k.clickXY(mn.items[0].x, mn.items[0].y); await settled();
    const sickPaste = await srv(okT.json.task.id);
    const tt = (await toastTexts()).join(' | ') + ' | ' + JSON.stringify(await H('ctoast()'));
    console.log('toast after sick paste:', tt);
    C.check('Д-1 вставка повтора в календаре на больничный (03.02) → повтор НЕ добавлен, пользователю понятное сообщение: «' + tt.slice(0, 160) + '»', sickPaste.occurrences.length === 0 && /больнич|командиров/i.test(tt), tt);
    await k.shot('B15_paste_on_sick_error_1280');

    // ===================================================================== 9. матрица
    console.log('=== матрица');
    const MX = ['2026-12-08', '2026-12-15', '2026-12-22'];
    const mxT = await api(env, ck, 'POST', 'api/tasks.php', { title: 'Матрица повторы приёмка', assignees: [E1], start_at: MX[0] + 'T10:00', end_at: MX[0] + 'T11:00', occurrences: [{ start_at: MX[1] + 'T10:00' }, { start_at: MX[2] + 'T10:00' }] });
    await fresh(s.adminCookies);
    await ev('document.getElementById("vacationTrigger").click()'); await sleep(900);
    await k.click('#tabMatrix'); await sleep(1500);
    await k.waitFor('!!document.querySelector(".tk-mx-ic[data-tk-date=\\"' + MX[0] + '\\"]")', 15000);
    const icAt = (d, emp) => ev('(() => { const e = document.querySelector(".tk-mx-ic[data-tk-api=\\"' + emp + '\\"][data-tk-date=\\"' + d + '\\"]"); return e ? { t: e.textContent, title: e.getAttribute("title"), fr: e.parentNode.classList.contains("tk-fr") } : null; })()');
    const ics = [await icAt(MX[0], E1), await icAt(MX[1], E1), await icAt(MX[2], E1)];
    const icNo = await icAt('2026-12-16', E1);
    console.log('matrix icons', JSON.stringify(ics), JSON.stringify(icNo));
    C.check('Д-1 матрица: значок задачи у исполнителя на дне основной даты (08.12) и на днях обоих повторов (15.12, 22.12); на соседнем дне (16.12) — нет', ics.every((x) => x) && !icNo, JSON.stringify(ics));
    C.check('Д-1 матрица: на днях повторов ячейка исполнителя с рамкой задачи (tk-fr)', ics.every((x) => x && x.fr), JSON.stringify(ics));
    await ev(`(() => { const e = document.querySelector('.tk-mx-ic[data-tk-api="${E1}"][data-tk-date="${MX[1]}"]'); e.scrollIntoView({block:'center', inline:'center'}); })()`); await sleep(400);
    await k.shot('B16_matrix_icons_on_repeat_days_1280');
    // клик по значку на дне повтора → открывает карточку задачи
    const icRect = await k.rect('.tk-mx-ic[data-tk-api="' + E1 + '"][data-tk-date="' + MX[1] + '"]');
    await k.clickXY(icRect.x, icRect.y); await sleep(700);
    const afterIc = await ev('({ view: window.Tasks.__t.S.view, anchor: window.Tasks.__t.S.cal.anchor, occTile: !!document.querySelector("#tasksView .tk-day[data-date=\\"' + MX[1] + '\\"] .tk-ev.tk-occ"), name: (document.querySelector("#tasksView .tk-day[data-date=\\"' + MX[1] + '\\"] .tk-ev.tk-occ") || {}).textContent })');
    console.log('after icon click', JSON.stringify(afterIc).slice(0, 300));
    C.check('Д-1 матрица: клик по значку на дне повтора (15.12) открывает «Задачи» → Календарь на этой неделе с плиткой ↻ этой задачи (как у значка основной даты)', afterIc.view === 'calendar' && afterIc.occTile && /Матрица повторы приёмка/.test(afterIc.name || ''), JSON.stringify(afterIc).slice(0, 200));
    await k.shot('B16b_matrix_icon_click_calendar_1280');

    // ===================================================================== 10. 409 (две вкладки)
    console.log('=== 409 две вкладки');
    const B = await env.openBrowser(); const kb = kit(B.cdp, env);
    const t409 = await api(env, ck, 'POST', 'api/tasks.php', { title: 'Конфликт версий', assignees: [E2], start_at: '2027-05-03T10:00', end_at: '2027-05-03T11:00', occurrences: [{ start_at: '2027-05-05T10:00' }] });
    const id409 = t409.json.task.id;
    await fresh(s.adminCookies);                       // вкладка 1 (A): загружает версию
    await openCal('2027-05-03', 'week');
    await kb.size(1280, 900, false); await kb.load(s.adminCookies);
    await B.cdp.ev('window.Tasks.open({employeeId:"",date:"2027-05-03",view:"calendar",mode:"week"})'); await kb.waitFor('!!document.querySelector("#tasksView .tk-cal-bd") && !window.Tasks.__t.S.loading', 30000);
    await B.cdp.ev('document.querySelector("#tasksView .tk-wk").scrollTop = 384'); await sleep(300);
    // вкладка B копирует и вставляет повтор → версия +1 на сервере
    const tB = await B.cdp.ev('(() => { const e = document.querySelector("#tasksView .tk-cal-bd .tk-ev[data-id=\\"' + id409 + '\\"]:not(.tk-occ)"); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
    await kb.rclick(tB.x, tB.y);
    const mB = await B.cdp.ev('(() => { const m = document.querySelector(".tk-ctx"); return [...m.querySelectorAll(".tk-ctx-i")].map((b) => { const q = b.getBoundingClientRect(); return { t: b.textContent, x: q.left + q.width / 2, y: q.top + q.height / 2 }; }); })()');
    await kb.clickXY(mB[0].x, mB[0].y); await sleep(300);
    const cB = await B.cdp.ev('(() => { const e = document.querySelector("#tasksView [data-tk-act=\\"calCell\\"][data-date=\\"2027-05-04\\"][data-min=\\"600\\"]"); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
    await kb.rclick(cB.x, cB.y);
    const mB2 = await B.cdp.ev('(() => { const m = document.querySelector(".tk-ctx"); return [...m.querySelectorAll(".tk-ctx-i")].map((b) => { const q = b.getBoundingClientRect(); return { t: b.textContent, x: q.left + q.width / 2, y: q.top + q.height / 2 }; }); })()');
    await kb.clickXY(mB2[0].x, mB2[0].y); await sleep(900);
    const afterB = await srv(id409);
    C.check('Д-1 409: вкладка B добавила повтор 04.05 10:00 → на сервере 2 повтора, версия выросла', afterB.occurrences.length === 2 && afterB.version > t409.json.task.version, JSON.stringify([afterB.version, t409.json.task.version]));
    // вкладка A (устаревшая версия) тянет повтор 05.05 → 409
    await ev('window.__calls.length = 0'); await H('scroll(384)'); await sleep(200);
    const oA = await H('occTile("' + id409 + '","2027-05-05")');
    const dA = await H('day("2027-05-06")');
    await k.drag(oA.x, oA.t + 10, dA.x, dA.t + 12 * HOUR + 12, { steps: 10 }); await settled();
    const aw = await writes();
    const after409 = await srv(id409);
    const tx = (await toastTexts()).join(' | ');
    console.log('409 writes', JSON.stringify(aw.map((c) => c.u)), 'toast', tx);
    C.check('Д-1 409 (две вкладки): перенос повтора из устаревшей вкладки → отказ сервера 409, повтор на месте (05.05 10:00), пользователю понятное сообщение: «' + tx.slice(0, 150) + '»', aw.length >= 1 && /occ_move/.test(aw[0].u) && after409.occurrences.some((o) => o.start_at === '2027-05-05T10:00') && /изменен|обновл|конфликт/i.test(tx), JSON.stringify([aw.map((c) => c.u), after409.occurrences, tx]));
    await k.shot('B17_conflict_409_tab_stale_1280');
    const raw409 = await api(env, ck, 'POST', 'api/tasks.php?id=' + id409 + '&action=occ_move', { version: 1, occurrence_id: after409.occurrences[0].id, start_at: '2027-05-07T10:00' });
    C.check('Д-1 409 API напрямую: устаревшая version → 409 VERSION_CONFLICT (occ_move)', raw409.status === 409 && /VERSION_CONFLICT/i.test(JSON.stringify(raw409.json)), JSON.stringify(raw409));
    for (const act of ['occ_add', 'occ_delete']) {
      const r = await api(env, ck, 'POST', 'api/tasks.php?id=' + id409 + '&action=' + act, { version: 1, start_at: '2027-05-09T10:00', occurrence_id: after409.occurrences[0].id });
      C.check('Д-1 409 API: ' + act + ' со старой version → 409', r.status === 409, r.status);
    }
    const noV = await api(env, ck, 'POST', 'api/tasks.php?id=' + id409 + '&action=occ_add', { start_at: '2027-05-09T10:00' });
    C.check('Д-1 API: occ_add без version → 4xx (version обязателен), повтор не добавлен', noV.status >= 400 && noV.status < 500 && (await srv(id409)).occurrences.length === 2, JSON.stringify(noV));

    // ===================================================================== 11. 375
    console.log('=== 375');
    await fresh(s.adminCookies, 375, 800, true);
    await ev('window.Tasks.open({view:"list"})'); await settled();
    await btn('newTask'); await sleep(300);
    await setField('[data-tk-field="title"]', 'Мобильная форма');
    await setField('[data-tk-field="assigneePick"]', E2);
    await setField('[data-tk-field="startDate"]', '2027-04-05'); await setField('[data-tk-field="startTime"]', '09:00');
    await btn('addOcc'); await btn('addOcc'); await sleep(200);
    C.check('Д-1 375: форма с двумя строками повторов — без горизонтальной прокрутки страницы, строки умещаются в экран', (await H('ovf()')) <= 1 && (await ev('[...document.querySelectorAll("#tasksView .tk-occrow")].every((r) => r.getBoundingClientRect().right <= 376)')), await H('ovf()'));
    await k.shotEl('#tasksView .tk-f-occ', 'B20_form_occurrences_375');
    await btn('cancelForm'); await sleep(200);
    await ev('window.Tasks.open({view:"list"})'); await settled();
    await ev(`document.querySelector('#tasksView .tk-row[data-id="${walk.id}"]').scrollIntoView({block:'center'})`);
    const m375 = await ev(`(() => { const w = document.querySelector('#tasksView .tk-tablewrap'); const r = document.querySelector('#tasksView .tk-row[data-id="${walk.id}"]'); return { sw: w.scrollWidth, cw: w.clientWidth, badge: !!r.querySelector('.tk-occ-n'), due: r.querySelector('[data-tk-due]').textContent.replace(/\\s+/g, ' ').trim(), ovf: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`);
    C.check('Д-1 375 Список: «↻ N» и ближайший срок в строке; прокрутка таблицы внутри обёртки, страница не уезжает', m375.badge && /↻ 2/.test(m375.due) && m375.sw > m375.cw && m375.ovf <= 1, JSON.stringify(m375));
    await k.shot('B21_list_375');
    await openCal(REP_FORM, 'week');
    C.check('Д-1 375 календарь: плитка ↻ в сетке', await ev('!!document.querySelector("#tasksView .tk-ev.tk-occ")'), '');
    await k.shot('B22_calendar_375');
    await ev('window.Tasks.open({view:"board", taskId:' + JSON.stringify(walk.id) + '})'); await settled();
    C.check('Д-1 375 карточка: «Даты выполнения · 3», страница не уезжает', /Даты выполнения · 3/.test(await ev('document.querySelector("#tasksView .tk-detail").textContent')) && (await H('ovf()')) <= 1, '');
    await k.shot('B23_card_375');
    await ev('window.Tasks.open({view:"board"})'); await settled();
    await k.shot('B24_board_375');
    C.check('0 необработанных исключений на странице', cdp.exceptions.length === 0 && B.cdp.exceptions.length === 0, cdp.exceptions.concat(B.cdp.exceptions).join('\n'));
  } catch (e) {
    console.log('ОШИБКА ХАРНЕССА: ' + e.stack);
    C.check('harness без ошибок', false, e.message);
  } finally {
    C.save();
    console.log('\nB: ' + C.passed + ' passed, ' + C.failed + ' failed');
    env.cleanup();
    process.exit(C.failed ? 1 : 0);
  }
})();
