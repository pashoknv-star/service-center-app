// V6.2-3 (приёмка, вне gate): D — стыки с T1: иконки задач в матрице (+ после перетаскивания в календаре), реальный HTML5-drag Доски, режимы календаря.
// Запуск: node scripts/v62_accept_d_matrix_board.js → reports/V6_2/V6.2-3_screens/D_*.png, D_results.json
'use strict';
const path = require('path');
const { L, seed, D, sleep, OUT, kit, api } = require('./v62_accept_lib.js');

(async () => {
  const C = L.makeChecker(path.join(OUT, 'D_results.json'));
  const env = await L.startEnv();
  try {
    const s = await seed(env);
    const adminCk = s.adminCookies.join('; ');
    const mk = async (title, start, end, as, extra) => { const r = await api(env, adminCk, 'POST', 'api/tasks.php', Object.assign({ title, start_at: start, end_at: end, assignees: as }, extra || {})); if (r.status !== 201) throw new Error(title + ' ' + r.status + JSON.stringify(r.json)); return r.json.task.id; };
    const G = (id) => api(env, adminCk, 'GET', 'api/tasks.php?id=' + id).then((r) => r.json.task);
    const idMx = await mk('Matrix-тест', D(9) + 'T10:00', D(9) + 'T11:00', ['emp_4'], { label: 'mx, тест' });
    const idBoard = await mk('Board-drag', D(8) + 'T12:00', D(8) + 'T13:00', ['emp_1']);
    const A = await env.openBrowser(); C.note('browser', A.version);
    const cdp = A.cdp, k = kit(cdp, env), ev = k.ev;
    await k.size(1280, 900, false); await k.load(s.adminCookies);
    // ---------- матрица
    console.log('=== матрица: иконки');
    await ev('document.getElementById("vacationTrigger").click()'); await sleep(900);
    await k.click('#tabMatrix'); await sleep(1500);
    const yr = await ev(`(() => { const y = document.querySelector('#yearLabel, .year-label, #currentYear'); return y ? y.textContent.trim() : null; })()`);
    const icSel = (emp, date) => '.tk-mx-ic[data-tk-emp="' + emp.replace('emp_', '') + '"][data-tk-date="' + date + '"]';
    const waitIc = async (emp, date, want) => k.waitFor('!!document.querySelector(' + JSON.stringify(icSel(emp, date)) + ') === ' + want, 8000);
    const hasIc = await waitIc('emp_4', D(9), true);
    C.check('T1 матрица: иконка задачи у emp_4 на ' + D(9) + ' есть (год: ' + yr + ')', hasIc, '');
    const icinfo = await ev(`(() => { const e = document.querySelector(${JSON.stringify(icSel('emp_4', D(9)))}); return e ? { txt: e.textContent, title: e.title, cnt: e.dataset.tkCount } : null; })()`);
    C.check('T1 матрица: счётчик 1, подсказка «Открытых задач: 1 — Matrix-тест»', icinfo && icinfo.txt === '1' && /Matrix-тест/.test(icinfo.title), JSON.stringify(icinfo));
    await k.shot('D01_matrix_icons_1280');
    // клик по иконке → панель задач, календарь на дате
    await k.click(icSel('emp_4', D(9))); await sleep(1500);
    await k.waitFor('!window.Tasks.__t.S.loading', 20000);
    const st = await ev(`JSON.stringify({ view: window.Tasks.__t.S.view, tabTasks: document.getElementById('tabTasks').classList.contains('active'), cal: window.Tasks.__t.S.cal && window.Tasks.__t.S.cal.date })`);
    C.check('T1 клик по иконке матрицы → панель «Задачи», календарь: ' + st, /"view":"calendar"/.test(st) && /"tabTasks":true/.test(st), st);
    await k.shot('D02_icon_click_opens_calendar_1280');
    // перетащить задачу в календаре на другой день и час
    await ev(`document.querySelector('#tasksView .tk-wk').scrollTop = 8 * 48`); await sleep(300);
    const R = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
    const t0 = await R('#tasksView .tk-ev-t[data-id="' + idMx + '"]'), sl = await R('#tasksView .tk-slot[data-date="' + D(11) + '"][data-min="' + (14 * 60) + '"]');
    console.log('tile', JSON.stringify(t0), 'slot', JSON.stringify(sl));
    await k.drag(t0.cx, t0.y + 8, sl.cx, sl.y + 6, { steps: 8 });
    const g = await G(idMx);
    C.check('перетащили «Matrix-тест» на ' + D(11) + ' 14:00 → сервер ' + g.start_at, g.start_at === D(11) + 'T14:00' && g.end_at === D(11) + 'T15:00', g.start_at + '–' + g.end_at);
    // обратно в матрицу: иконка переехала
    await k.click('#tabMatrix'); await sleep(1500);
    const moved = await waitIc('emp_4', D(11), true), gone = await waitIc('emp_4', D(9), false);
    C.check('СТЫК перетащенная задача → иконка в матрице переехала на ' + D(11) + ' (на ' + D(9) + ' её нет)', moved && gone, JSON.stringify({ moved, gone }));
    await k.shot('D03_matrix_after_drag_1280');
    // копия через ПКМ → ещё одна иконка (счётчик)
    await k.click('#tabTasks'); await sleep(900);
    await k.waitFor('!window.Tasks.__t.S.loading', 20000);
    await ev(`document.querySelector('#tasksView .tk-wk').scrollTop = 8 * 48`); await sleep(300);
    const t1 = await R('#tasksView .tk-ev-t[data-id="' + idMx + '"]');
    await k.rclick(t1.cx, t1.cy); await k.clickText('.tk-ctx .tk-ctx-i', 'Копировать'); await sleep(300);
    const sl2 = await R('#tasksView .tk-slot[data-date="' + D(11) + '"][data-min="' + (17 * 60) + '"]');
    await k.rclick(sl2.cx, sl2.y + 6); await k.clickText('.tk-ctx .tk-ctx-i', 'Вставить'); await sleep(1200);
    await k.click('#tabMatrix'); await sleep(1500);
    await k.waitFor('(() => { const e = document.querySelector(' + JSON.stringify(icSel('emp_4', D(11))) + '); return e && e.dataset.tkCount === "2"; })()', 8000);
    const cnt = await ev(`(() => { const e = document.querySelector(${JSON.stringify(icSel('emp_4', D(11)))}); return e ? e.dataset.tkCount : null; })()`);
    C.check('СТЫК копия (ПКМ) → в матрице на ' + D(11) + ' счётчик иконки = 2', cnt === '2', cnt);

    // ---------- Доска: реальный HTML5 drag
    console.log('=== Доска: drag&drop');
    await k.click('#tabTasks'); await sleep(900);
    await k.view('board');
    let dragData = null;
    cdp.ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Input.dragIntercepted') dragData = d.params.data; });
    const dragFromTo = async (from, to) => {
      dragData = null;
      await cdp.send('Input.setInterceptDrags', { enabled: true });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 8 && !dragData; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 6, y: from.y + i * 6, button: 'left', buttons: 1 }); await sleep(60); }
      if (!dragData) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x, y: from.y, button: 'left' }); await cdp.send('Input.setInterceptDrags', { enabled: false }); return false; }
      for (const t of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type: t, x: to.x, y: to.y, data: dragData });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left' });
      await cdp.send('Input.setInterceptDrags', { enabled: false });
      await sleep(1000); return true;
    };
    const vis = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const from = await vis('.tk-card[data-id="' + idBoard + '"] b');
    const to = await ev(`(() => { const r = document.querySelector('.tk-col[data-tk-col="closed"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: ${from.y} }; })()`);
    const started = await dragFromTo(from, to);
    let gb = await G(idBoard);
    C.check('T1 Доска: настоящий HTML5-drag карточки «Открыта» → «Закрыта» (dragIntercepted + dragEnter/Over/Drop): сервер status=' + gb.status, started && gb.status === 'closed', JSON.stringify([started, gb.status]));
    await k.shot('D04_board_after_drag_1280');
    const from2 = await vis('.tk-col[data-tk-col="closed"] .tk-card[data-id="' + idBoard + '"] b');
    const to2 = await ev(`(() => { const r = document.querySelector('.tk-col[data-tk-col="open"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: ${from2.y} }; })()`);
    const started2 = await dragFromTo(from2, to2);
    gb = await G(idBoard);
    C.check('T1 Доска: обратно «Закрыта» → «Открыта»: сервер status=' + gb.status, started2 && gb.status === 'open', JSON.stringify([started2, gb.status]));
    // карточка Доски не реагирует на мышиный «перенос» календаря: ПКМ по карточке — нативное меню
    await ev('window.__cm = []; document.addEventListener("contextmenu", e => setTimeout(() => window.__cm.push(e.defaultPrevented), 0));');
    const cr = await vis('.tk-card[data-id="' + idBoard + '"] b');
    await k.rclick(cr.x, cr.y);
    C.check('V6.2 ПКМ по карточке Доски: нашего меню нет, нативное не подавлено', !(await ev('!!document.querySelector(".tk-ctx")')) && (await ev('JSON.stringify(window.__cm)')) === '[false]', await ev('JSON.stringify(window.__cm)'));
    await k.key('Escape');

    // ---------- режимы календаря
    await k.view('calendar');
    const modes = await ev(`[...document.querySelectorAll('#tasksView [data-tk-act="calMode"]')].map(b => b.textContent.trim())`);
    C.note('cal_modes', modes);
    C.check('(наблюдение) режимы календаря: ' + JSON.stringify(modes) + ' — «Месяц» в календаре задач отсутствует (PLAN W-5/W-6 упоминают «Месяц»)', modes.length === 2, JSON.stringify(modes));
    C.check('0 необработанных исключений', cdp.exceptions.length === 0, cdp.exceptions.join('\n'));
  } catch (e) {
    console.log('ОШИБКА ХАРНЕССА: ' + e.stack);
    C.check('harness без ошибок', false, e.message);
  } finally {
    C.save();
    console.log('\nD: ' + C.passed + ' passed, ' + C.failed + ' failed');
    env.cleanup();
    process.exit(C.failed ? 1 : 0);
  }
})();
