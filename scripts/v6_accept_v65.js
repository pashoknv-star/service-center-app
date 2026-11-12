// V6-5 (вне gate): реальный Chromium — ФИО в плитке Доски (P2-1) и узкие плитки «Недели» (P2-2).
// Запуск: node scripts/v6_accept_v65.js  → reports/V6/V6-5_screens/*.png, V65_results.json (1280 и 375).
// Каркас — v6_accept_lib.js / v6_accept_seed.js (php -S на КОПИИ data/app.db; пароли в браузер не вводятся).
'use strict';
const path = require('path'), fs = require('fs');
const L = require('./v6_accept_lib.js');
const { seed, D } = require('./v6_accept_seed.js');
const OUT = path.join(L.ROOT, 'reports/V6/V6-5_screens');
fs.mkdirSync(OUT, { recursive: true });
const sleep = L.sleep;

(async () => {
  const env = await L.startEnv();
  const C = L.makeChecker(path.join(OUT, 'V65_results.json'));
  try {
    const s = await seed(env);
    const T = s.T, ck = s.adminCookies.join('; ');
    const { cdp, version } = await env.openBrowser();
    C.note('browser', version);
    const k = L.pageKit(cdp, env.base, OUT);
    const ev = (x) => cdp.ev(x);
    const S = (expr) => ev('(() => { const S = window.Tasks.__t.S; return ' + expr + '; })()');
    const openTasks = async (view, extra) => {
      await ev('window.Tasks.open(' + JSON.stringify(Object.assign({ employeeId: '', date: D(2), view, mode: 'week' }, extra || {})) + ')');
      await k.waitFor('!window.Tasks.__t.S.loading && !!document.querySelector("#tasksView")', 20000); await sleep(500);
    };
    // события CDP (dragIntercepted)
    let dragData = null;
    cdp.ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Input.dragIntercepted') dragData = d.params.data; });
    const dragFromTo = async (from, to) => {
      dragData = null;
      await cdp.send('Input.setInterceptDrags', { enabled: true });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 6 && !dragData; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 6, y: from.y + i * 6, button: 'left', buttons: 1 }); await sleep(60); }
      if (!dragData) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x, y: from.y, button: 'left' }); await cdp.send('Input.setInterceptDrags', { enabled: false }); return false; }
      for (const t of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type: t, x: to.x, y: to.y, data: dragData });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left' });
      await cdp.send('Input.setInterceptDrags', { enabled: false });
      await sleep(900);
      return true;
    };
    const status = async (id) => ((await L.http(env.base, ck, 'GET', 'api/tasks.php?id=' + id)).json.task || {}).status;

    for (const vp of [[1280, 900, false, '1280'], [375, 2200, true, '375']].filter((v) => !process.env.ONLY || process.env.ONLY === v[3])) {
      const [w, h, mob, tag] = vp;
      console.log('=== viewport ' + tag);
      await k.size(w, h, mob);
      await k.load(s.adminCookies);
      await ev('document.getElementById("vacationTrigger").click()'); await sleep(600);
      await k.click('#tabTasks'); await sleep(1500);
      await k.waitFor('!window.Tasks.__t.S.loading', 20000);

      // ---- P2-1: ФИО в плитке Доски
      await openTasks('board');
      const sel = '.tk-card[data-id="' + T.dirmeet + '"] .tk-sub [data-tk-act="filterEmp"]';
      const info = await ev(`(() => { const e = document.querySelector('${sel}'); if (!e) return null; const cs = getComputedStyle(e); return { text: e.textContent, tag: e.tagName, role: e.getAttribute('role'), emp: e.dataset.emp, color: cs.color, cursor: cs.cursor, bb: cs.borderBottomStyle }; })()`);
      C.note('nameTile_' + tag, info);
      C.check(tag + ' P2-1 в плитке Доски ФИО — кнопка filterEmp (цвет ссылки, указатель, пунктир)', info && info.tag === 'SPAN' && info.role === 'button' && info.emp === 'emp_101' && info.cursor === 'pointer' && info.bb === 'dotted', JSON.stringify(info));
      await k.shotEl('.tk-split-board', 'V65_01_board_names_' + tag, { maxH: 700 });
      await k.click(sel); await sleep(600);
      const f = await S('({ view: S.view, f: S.filters, sel: S.selectedId, detail: !!document.querySelector(".tk-detail"), rows: [...document.querySelectorAll("#tasksView .tk-table tbody tr")].map(r => (r.querySelector("td:nth-child(2)")||{}).textContent) })');
      const nonEmpty = Object.keys(f.f).filter((x) => f.f[x] !== '' && f.f[x] !== false && f.f[x] != null);
      C.check(tag + ' P2-1 клик по ФИО в плитке → «Список», ровно один фильтр (emp=emp_101), карточка не открыта', f.view === 'list' && f.f.emp === 'emp_101' && nonEmpty.join() === 'emp' && !f.sel && !f.detail && f.rows.length >= 3 && f.rows.every((r) => /Директор Тестов/.test(r)), JSON.stringify(f));
      await k.shot('V65_02_name_click_list_' + tag);

      // ---- P2-1: drag&drop Доски (старт — прямо с ФИО!) и клик по самой плитке
      await openTasks('board');
      await k.click('.tk-card[data-id="' + T.dirmeet + '"] b'); await sleep(500);
      const opened = await S('({ sel: S.selectedId, detail: !!document.querySelector(".tk-detail") })');
      C.check(tag + ' P2-1 клик по плитке (не по ФИО) по-прежнему открывает карточку', opened.sel === T.dirmeet && opened.detail, JSON.stringify(opened));
      await openTasks('board');
      await ev('document.querySelector(\'.tk-card[data-id="' + T.dog + '"]\').scrollIntoView({block:"start"})'); await sleep(300);
      const vis = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); const r = e.getBoundingClientRect(); const top = Math.max(r.top, 0), bot = Math.min(r.bottom, innerHeight); return { x: r.left + r.width / 2, y: (top + bot) / 2, inView: bot > top }; })()`);
      const from2 = await vis('.tk-card[data-id="' + T.dog + '"] .tk-sub [data-tk-act="filterEmp"]'), to2 = await vis('.tk-col[data-tk-col="closed"]');
      const started = await dragFromTo(from2, to2);
      const st = await status(T.dog);
      C.check(tag + ' P2-1 drag&drop: перетаскивание, начатое С ФИО, переносит плитку «Открыта» → «Закрыта» (на сервере status=closed), список не открылся', started && st === 'closed' && (await S('S.view')) === 'board', JSON.stringify({ started, st, view: await S('S.view') }));
      await k.shot('V65_03_board_after_drag_' + tag);
      // вернуть назад drag&drop-ом (закрытая → «Открыта»), старт с заголовка плитки
      await openTasks('board');
      await ev('document.querySelector(\'.tk-col[data-tk-col="closed"] .tk-card[data-id="' + T.dog + '"]\').scrollIntoView({block:"start"})'); await sleep(300);
      const f4 = await vis('.tk-col[data-tk-col="closed"] .tk-card[data-id="' + T.dog + '"] b'), t4 = await vis('.tk-col[data-tk-col="open"]');
      const started2 = await dragFromTo(f4, t4);
      C.check(tag + ' P2-1 drag&drop обратно (с заголовка плитки) «Закрыта» → «Открыта» работает', started2 && (await status(T.dog)) === 'open', String(started2));

      // ---- P2-2: Неделя, 4 пересекающиеся задачи 09:00–11:00 в среду
      await k.size(w, tag === '375' ? 900 : h, mob);
      await openTasks('calendar', { mode: 'week' });
      const wk = await ev(`(() => { const tiles = [...document.querySelectorAll('#tasksView .tk-cal-bd .tk-ev-t')].filter(t => t.dataset.cols >= 3).map(t => { const b = t.querySelector('.tk-ev-title'); const cs = getComputedStyle(t); const r = t.getBoundingClientRect(); const rb = b.getBoundingClientRect();
          return { text: b.textContent, title: t.title.split('\\n')[0], cls: t.className, w: Math.round(r.width * 10) / 10, h: Math.round(r.height), ws: cs.whiteSpace, ov: cs.overflow, to: cs.textOverflow, wb: cs.wordBreak, lines: Math.round(rb.height / 14), clipped: b.scrollWidth > t.clientWidth }; });
        const normal = [...document.querySelectorAll('#tasksView .tk-cal-bd .tk-ev-t')].filter(t => t.dataset.cols < 3 && !/tk-ev-s/.test(t.className)).map(t => { const cs = getComputedStyle(t); return { text: t.textContent.slice(0, 30), ws: cs.whiteSpace, wb: cs.wordBreak, to: cs.textOverflow }; });
        return { tiles, normal }; })()`);
      C.note('weekTiles_' + tag, wk);
      C.check(tag + ' P2-2 «Неделя»: 4 узкие плитки (≥3 дорожек), у каждой nowrap + overflow:hidden + text-overflow:ellipsis, перенос по буквам отсутствует, в высоту одна строка текста',
        wk.tiles.length === 4 && wk.tiles.every((t) => /tk-ev-n/.test(t.cls) && t.ws === 'nowrap' && t.ov === 'hidden' && t.to === 'ellipsis' && t.wb === 'normal' && t.lines <= 1), JSON.stringify(wk.tiles));
      C.check(tag + ' P2-2 полная тема в title узкой плитки; у обычных плиток (1–2 дорожки, не «короткие») стиль прежний (перенос разрешён, без ellipsis)', wk.tiles.every((t) => t.title === t.text) && wk.normal.length >= 3 && wk.normal.every((t) => t.ws === 'normal' && t.to === 'clip'), JSON.stringify(wk.normal));
      await k.shotEl('#tasksView .tk-wk', 'V65_04_week_narrow_' + tag, { maxH: 760 });
      await ev('document.querySelector("#tasksView .tk-wk").scrollTop = 384'); await sleep(300);
      await k.shot('V65_05_week_0900_' + tag);
      // «День» не изменился
      await openTasks('calendar', { mode: 'day' });
      const dayTiles = await ev(`[...document.querySelectorAll('#tasksView .tk-cal-bd .tk-ev-t')].map(t => ({ n: /tk-ev-n/.test(t.className), ws: getComputedStyle(t).whiteSpace }))`);
      C.check(tag + ' P2-2 «День» не затронут: нет tk-ev-n, white-space не nowrap у плиток из нескольких строк', dayTiles.length >= 1 && dayTiles.every((t) => !t.n), JSON.stringify(dayTiles));
      await k.shot('V65_06_day_' + tag);
    }
    C.check('в консоли страницы нет исключений', cdp.exceptions.length === 0, cdp.exceptions.join('|'));
  } catch (e) {
    console.log('ОШИБКА', e && e.stack || e); C.check('скрипт дошёл до конца без исключения', false, e && e.message);
  } finally {
    C.save(); env.cleanup();
    console.log('RESULT: ' + C.passed + ' passed, ' + C.failed + ' failed');
    process.exit(C.failed ? 1 : 0);
  }
})();
