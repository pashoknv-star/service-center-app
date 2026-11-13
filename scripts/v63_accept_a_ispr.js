// V6.3-3 (приёмка, вне gate): A — И-1 (Список ≤ 2 исполнителей + «…», Доска), И-2 (ширины колонок, ширина таблицы), роли, 375.
// Запуск: V63_BEFORE_ROOT=<выгрузка 6072f41, код до V6.3-1> node scripts/v63_accept_a_ispr.js → reports/V6_3/V6.3-3_screens/A_*.png, A_results.json
'use strict';
const path = require('path');
const { L, seed, D, sleep, OUT, kit, api } = require('./v63_accept_lib.js');

const MEASURE = `(() => {
  const ths = [...document.querySelectorAll('#tasksView .tk-table thead th')], t = document.querySelector('#tasksView .tk-table'), wrap = document.querySelector('#tasksView .tk-tablewrap');
  const rows = {}; [...document.querySelectorAll('#tasksView .tk-row')].forEach((r) => { rows[r.querySelector('b').textContent.trim()] = Math.round(r.getBoundingClientRect().height * 10) / 10; });
  const ex = {}; [...document.querySelectorAll('#tasksView .tk-row')].forEach((r) => { const c = r.querySelector('.tk-c-exec'); if (c) ex[r.querySelector('b').textContent.trim()] = Math.round(c.getBoundingClientRect().height * 10) / 10; });
  return { order: ths.map((x) => x.textContent.replace('↕', '').trim()), w: ths.map((x) => Math.round(x.getBoundingClientRect().width * 10) / 10),
    table: Math.round(t.getBoundingClientRect().width * 10) / 10, wrap: wrap.clientWidth, scrollW: wrap.scrollWidth, rows, ex,
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`;

async function mk(env, ck, title, as, extra) {
  const r = await api(env, ck, 'POST', 'api/tasks.php', Object.assign({ title, start_at: D(1) + 'T13:00', end_at: D(1) + 'T14:00', assignees: as }, extra || {}));
  if (r.status !== 201) throw new Error(title + ' ' + r.status + JSON.stringify(r.json).slice(0, 200));
  return r.json.task.id;
}
const NAMES = {};

async function prep(env) {
  const s = await seed(env);
  const ck = s.adminCookies.join('; ');
  const X = {};
  X.n1 = await mk(env, ck, 'И1 Один', ['emp_1']);
  X.n2 = await mk(env, ck, 'И1 Два', ['emp_1', 'emp_2']);
  X.n3 = await mk(env, ck, 'И1 Три', ['emp_1', 'emp_2', 'emp_3']);
  X.n5 = await mk(env, ck, 'И1 Пять', ['emp_1', 'emp_2', 'emp_3', 'emp_4', 'emp_105']);
  X.n7 = await mk(env, ck, 'И1 Семь с отпуском', ['emp_1', 'emp_2', 'emp_3', 'emp_4', 'emp_105', 'emp_106', 'emp_101']);
  return { s, ck, X };
}

async function measureAt(root, w) {
  const env = await L.startEnv({ root });
  try {
    const { s } = await prep(env);
    const b = await env.openBrowser();
    const k = kit(b.cdp, env);
    await k.size(w, 900, w < 700); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
    return await k.ev(MEASURE);
  } finally { env.cleanup(); }
}

(async () => {
  const C = L.makeChecker(path.join(OUT, 'A_results.json'));
  const beforeRoot = process.env.V63_BEFORE_ROOT;
  let before1280 = null, before375 = null;
  if (beforeRoot) { before1280 = await measureAt(beforeRoot, 1280); before375 = await measureAt(beforeRoot, 375); C.note('before_1280', before1280); C.note('before_375', before375); console.log('before 1280', JSON.stringify({ o: before1280.order, w: before1280.w, t: before1280.table })); }
  const env = await L.startEnv();
  try {
    const { s, ck, X } = await prep(env);
    const T = s.T;
    const A = await env.openBrowser(); C.note('browser', A.version);
    const cdp = A.cdp, k = kit(cdp, env), ev = k.ev;
    const rowSel = (id) => '#tasksView .tk-row[data-id="' + id + '"]';
    const cell = (id) => ev(`(() => { const td = document.querySelector(${JSON.stringify(rowSel(id) + ' .tk-c-exec')}); const links = [...td.querySelectorAll('[data-tk-act="filterEmp"]')]; const emps = links.map((b) => b.dataset.emp); const more = td.querySelector('.tk-more');
      const mr = more && more.getBoundingClientRect(); const lr = links.length ? links[links.length - 1].getBoundingClientRect() : null;
      return { text: td.textContent.replace(/\\s+/g, ' ').trim(), links: links.map((b) => b.textContent.trim()), emps, more: !!more, moreText: more ? more.textContent : null, moreInLink: !!(more && more.closest('[data-tk-act="filterEmp"]')),
        title: td.getAttribute('title'), h: td.getBoundingClientRect().height, sameLine: mr && lr ? Math.abs((mr.top + mr.height / 2) - (lr.top + lr.height / 2)) < 10 : null, gap: mr && lr && Math.abs((mr.top + mr.height / 2) - (lr.top + lr.height / 2)) < 10 ? Math.round((mr.left - lr.right) * 10) / 10 : null, moreBg: more ? getComputedStyle(more).backgroundColor : null }; })()`);

    // ======================================================= И-1 / И-2 admin 1280
    console.log('=== admin 1280 Список');
    await k.size(1280, 900, false); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
    const m = await ev(MEASURE); C.note('after_1280', m); console.log(JSON.stringify({ o: m.order, w: m.w, t: m.table, wrap: m.wrap }));
    const iE = m.order.indexOf('Исполнитель'), iD = m.order.indexOf('Описание');
    const c1 = await cell(X.n1), c2 = await cell(X.n2), c3 = await cell(X.n3), c5 = await cell(X.n5), c7 = await cell(X.n7);
    console.log(JSON.stringify([c1, c2, c3, c5, c7]));
    C.check('И-1 1 исполнитель: 1 ФИО-ссылка, без «…», без title', c1.links.length === 1 && !c1.more && !c1.title, JSON.stringify(c1));
    C.check('И-1 2 исполнителя: 2 ФИО-ссылки, без «…», без title', c2.links.length === 2 && !c2.more && !c2.title, JSON.stringify(c2));
    C.check('И-1 3 исполнителя: ровно 2 ФИО + «…», в тексте ячейки нет 3-го ФИО', c3.links.length === 2 && c3.more && c3.moreText === '…' && !/Смирнов|Петров|Сидор/.test(c3.text) && c3.text.split(',').length === 2, JSON.stringify(c3));
    C.check('И-1 5 исполнителей: ровно 2 ФИО + «…»', c5.links.length === 2 && c5.more, JSON.stringify(c5));
    C.check('И-1 7 исполнителей (у 7-го отпуск): ровно 2 ФИО + «…»', c7.links.length === 2 && c7.more, JSON.stringify(c7));
    const full = (await api(env, ck, 'GET', 'api/tasks.php?id=' + X.n5)).json.task;
    const fullNames = full.assignees.filter((a) => a.role === 'assignee' || !a.role).map((a) => a.full_name || a.name || a.full_name_snapshot);
    console.log('API assignees n5', JSON.stringify(full.assignees));
    C.check('И-1 подсказка (title) при 3 и 5: «Исполнители: …» с ПОЛНЫМ списком (в нём все ФИО из API)', !!c3.title && !!c5.title && fullNames.length === 5 && fullNames.every((n) => c5.title.indexOf(n) >= 0) && c5.title.split(',').length === 5, c5.title + ' | ' + JSON.stringify(fullNames));
    C.check('И-1 «…» — отдельный элемент (не внутри ссылки на ФИО), визуально чип с фоном ' + c5.moreBg + ', зазор до ФИО ' + c5.gap, !c5.moreInLink && c5.moreBg !== 'rgba(0, 0, 0, 0)' && (c5.gap === null || c5.gap >= 3), JSON.stringify(c5));
    // клик по ФИО фильтрует (реальная мышь)
    await k.click(rowSel(X.n5) + ' .tk-c-exec [data-tk-act="filterEmp"]', 1); await sleep(500);
    let st = JSON.parse(await ev(`JSON.stringify({ v: window.Tasks.__t.S.view, e: window.Tasks.__t.S.filters.emp, rows: [...document.querySelectorAll('#tasksView .tk-row b')].map(b => b.textContent.trim()) })`));
    C.check('И-1 реальный клик по 2-му ФИО (' + c5.links[1] + ') → фильтр по этому сотруднику (emp_2), Список остаётся, строки только его задач', st.v === 'list' && st.e === c5.emps[1] && st.rows.includes('И1 Пять') && !st.rows.includes('Планёрка отдела'), JSON.stringify(st));
    await k.shot('A01_list_filter_by_name_1280');
    await ev('document.querySelector("#tasksView [data-tk-act=resetFilters]").click()'); await sleep(400);
    // клик по «…» → карточка, без фильтра
    await k.click(rowSel(X.n5) + ' .tk-c-exec .tk-more'); await sleep(500);
    st = JSON.parse(await ev(`JSON.stringify({ e: window.Tasks.__t.S.filters.emp, sel: window.Tasks.__t.S.selectedId, detail: !!document.querySelector('#tasksView .tk-detail') })`));
    C.check('И-1 клик по «…» → карточка задачи открывается, фильтр не ставится', st.sel === X.n5 && st.detail && !st.e, JSON.stringify(st));
    const det = await ev(`document.querySelector('#tasksView .tk-detail').textContent`);
    C.check('И-1 карточка «Пять»: все 5 исполнителей, без «…»', fullNames.every((n) => det.indexOf(n) >= 0) && det.indexOf('…') < 0, det.slice(0, 250));
    await k.shot('A02_card_all_executors_1280');
    await k.view('list');
    // hover над «…» (реальный mouseMoved) — title в точке курсора
    const mr = await k.rect(rowSel(X.n5) + ' .tk-c-exec .tk-more');
    await k.move(mr.x, mr.y); await sleep(200);
    const hoverTitle = await ev(`(() => { const e = document.elementFromPoint(${mr.x}, ${mr.y}); let n = e; while (n && !n.getAttribute('title')) n = n.parentElement; return n ? n.getAttribute('title') : null; })()`);
    C.check('И-1 курсор над «…»: подсказка в точке = полный список', hoverTitle && hoverTitle === c5.title, hoverTitle);
    // удалённый/сирота: задача из seed — «Задача осиротеет»
    const orph = await ev(`(() => { const r = document.querySelector(${JSON.stringify(rowSel(T.orph) + ' .tk-c-exec')}); return r ? r.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    console.log('orph cell:', orph);
    C.check('И-1 «сирота» (исполнитель удалён): ячейка не пуста и без «…»-артефактов: «' + orph + '»', orph !== null && orph.indexOf('…') < 0, orph);
    // подробности вида
    await k.shot('A03_list_1280_admin');
    await k.shotEl(rowSel(X.n1), 'A03a_row_n1', { maxH: 120 });
    // высота
    await ev(`document.querySelector(${JSON.stringify(rowSel(X.n5))}).scrollIntoView({block:'center'})`); await sleep(300);
    await k.shot('A04_list_executors_rows_1280');

    // ---- И-2: ширины
    console.log('=== И-2 ширины');
    const w = (name) => m.w[m.order.indexOf(name)];
    const bw = (name) => before1280 ? before1280.w[before1280.order.indexOf(name)] : null;
    if (before1280) {
      C.note('И-2 до/после 1280', { order: m.order, before: before1280.w, after: m.w, before_table: before1280.table, after_table: m.table });
      C.check('И-2 «Исполнитель» ДО = 128 → ПОСЛЕ = 192 (×1,5): ' + bw('Исполнитель') + ' → ' + w('Исполнитель'), bw('Исполнитель') === 128 && w('Исполнитель') === 192, w('Исполнитель'));
      C.check('И-2 ширина таблицы неизменна: ' + before1280.table + ' → ' + m.table, Math.abs(before1280.table - m.table) < 0.6, m.table);
      const dDesc = Math.round((w('Описание') - bw('Описание')) * 10) / 10, dTask = Math.round((w('Задача') - bw('Задача')) * 10) / 10;
      C.check('И-2 «Описание» уменьшилось (сдвиг ' + dDesc + ' px; «Задача» ' + dTask + ' px) — суммарно прибавка Исполнителя (+64) компенсирована остальным без изменения Срок/Приор./Статус/Править', dDesc < 0 && ['Срок', 'Приор.', 'Статус', 'Править'].every((n) => Math.abs(w(n) - bw(n)) < 0.6) && Math.abs((dDesc + dTask) + 64) < 1, JSON.stringify({ before: before1280.w, after: m.w }));
      C.note('desc_delta', dDesc); C.note('task_delta', dTask); console.log('Описание Δ', dDesc, 'Задача Δ', dTask);
      C.check('И-2 «Задача» не изменилась (Δ ' + dTask + ' px), «Описание» отдало ровно −64 (' + dDesc + ')', Math.abs(dTask) < 1 && Math.abs(dDesc + 64) < 1.5, dDesc + '/' + dTask);
      // высота строк
      const grew = Object.keys(m.rows).filter((t) => before1280.rows[t] !== undefined && m.rows[t] > before1280.rows[t] + 0.5).map((t) => t + ' ' + before1280.rows[t] + '→' + m.rows[t]);
      C.note('rows_grew', grew); console.log('строки, выросшие по высоте:', JSON.stringify(grew));
      const exGrew = Object.keys(m.ex).filter((t) => before1280.ex[t] !== undefined && m.ex[t] > before1280.ex[t] + 0.5).map((t) => t + ' ' + before1280.ex[t] + '→' + m.ex[t]);
      C.note('exec_cell_grew', exGrew);
      C.note('exec_cell_grew_is_row_height', exGrew); console.log('ячейка(td) выросла:', JSON.stringify(exGrew));
    }
    C.check('И-2 таблица помещается в 1280 без горизонтальной прокрутки, страница не уезжает', m.table <= m.wrap + 1 && m.pageOverflow <= 0, JSON.stringify({ t: m.table, wrap: m.wrap, ov: m.pageOverflow }));
    C.check('И-2 «Исполнитель» ≥ «Описание» не требуется; «Исполнитель» 192 = 128 × 1,5 (+50 % ширины колонки)', w('Исполнитель') === 192, w('Исполнитель'));
    C.check('И-2 порядок колонок как в V6.2: Задача · Описание · Исполнитель · Срок · Приор. · Статус · Править', m.order.join('|') === 'Задача|Описание|Исполнитель|Срок|Приор.|Статус|Править', m.order.join('|'));
    await k.shotEl('#tasksView .tk-tablewrap', 'A05_list_table_1280', { maxH: 480 });

    // ---- Доска 1280
    console.log('=== Доска 1280');
    await k.view('board');
    const bcard = (id) => ev(`(() => { const c = document.querySelector('#tasksView .tk-card[data-id="${id}"]'); const sub = c.querySelector('.tk-sub'); const more = sub.querySelector('.tk-more'); const links = [...sub.querySelectorAll('[data-tk-act="filterEmp"]')];
      return { txt: sub.textContent.replace(/\\s+/g, ' ').trim(), title: sub.getAttribute('title'), btns: links.map((b) => b.textContent.trim()), more: !!more, moreInLink: !!(more && more.closest('[data-tk-act="filterEmp"]')), moreBg: more ? getComputedStyle(more).backgroundColor : null }; })()`);
    const b1 = await bcard(X.n1), b2 = await bcard(X.n2), b3 = await bcard(X.n3), b5 = await bcard(X.n5);
    console.log(JSON.stringify([b1, b2, b3, b5]));
    C.check('И-1 Доска 1/2: ФИО без «…»; 3/5: ровно 2 ФИО + «…» отдельным значком (чип с фоном), title с полным списком', b1.btns.length === 1 && !b1.more && b2.btns.length === 2 && !b2.more && b3.btns.length === 2 && b3.more && b5.btns.length === 2 && b5.more && !b5.moreInLink && b5.moreBg !== 'rgba(0, 0, 0, 0)' && b5.title.split(',').length === 5, JSON.stringify([b3, b5]));
    await k.shotEl('#tasksView .tk-card[data-id="' + X.n5 + '"]', 'A06_board_tile_dots_1280', { maxH: 140 });
    await k.shot('A06b_board_1280');

    // ======================================================= роли 1280 / 375
    for (const [user, role] of [['supervisor_zone0', 'supervisor'], ['viewer_test', 'viewer']]) {
      for (const [wd, h, mob] of [[1280, 900, false], [375, 740, true]]) {
        console.log('=== роль ' + role + ' ' + wd);
        const rck = await L.login(env.base, user);
        await k.size(wd, h, mob); await k.load(rck); await k.gotoTasks(); await k.view('list');
        const mm = await ev(MEASURE);
        C.note('role_' + role + '_' + wd, { order: mm.order, w: mm.w, table: mm.table, wrap: mm.wrap, scrollW: mm.scrollW });
        const i = mm.order.indexOf('Исполнитель');
        const cc = await cell(X.n5), c3r = await cell(X.n3), c2r = await cell(X.n2);
        C.check(role + ' ' + wd + ': 6 колонок (нет ✎), «Исполнитель» ' + mm.w[i] + ' px', mm.order.join('|') === 'Задача|Описание|Исполнитель|Срок|Приор.|Статус' && mm.w[i] === 192, JSON.stringify(mm.order) + mm.w);
        C.check(role + ' ' + wd + ': 2 ФИО + «…» (5), «…» (3), без «…» (2), title полный', cc.links.length === 2 && cc.more && c3r.links.length === 2 && c3r.more && c2r.links.length === 2 && !c2r.more && cc.title && cc.title.split(',').length === 5, JSON.stringify([cc, c3r, c2r]));
        if (wd === 1280) {
          C.check(role + ' 1280: таблица не шире окна', mm.table <= mm.wrap + 1, mm.table + '/' + mm.wrap);
          await k.click(rowSel(X.n5) + ' .tk-c-exec [data-tk-act="filterEmp"]', 0); await sleep(400);
          const f = await ev('window.Tasks.__t.S.filters.emp');
          C.check(role + ' 1280: клик по ФИО фильтрует (' + f + ')', f === cc.emps[0], f);
          await ev('document.querySelector("#tasksView [data-tk-act=resetFilters]").click()'); await sleep(300);
          await k.shot('A07_' + role + '_list_1280');
        } else {
          C.check(role + ' 375: горизонтальная прокрутка внутри обёртки (scrollW ' + mm.scrollW + ' > окно ' + mm.wrap + '), страница не уезжает', mm.scrollW > mm.wrap && mm.pageOverflow <= 0, JSON.stringify(mm));
          await k.shot('A07_' + role + '_list_375');
        }
      }
    }

    // ======================================================= admin 375
    console.log('=== admin 375');
    await k.size(375, 740, true); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
    const m375 = await ev(MEASURE);
    const m375x = await ev(`(() => { const w = document.querySelector('#tasksView .tk-tablewrap'); const th = document.querySelector('#tasksView .tk-table thead th'); return { ov: getComputedStyle(w).overflowX, pos: getComputedStyle(th).position }; })()`);
    C.note('after_375', m375); console.log(JSON.stringify({ o: m375.order, w: m375.w, t: m375.table, wrap: m375.wrap, scrollW: m375.scrollW }));
    C.check('И-2 375: «Исполнитель» ' + m375.w[m375.order.indexOf('Исполнитель')] + ' px (192), таблица шире окна → горизонтальная прокрутка; страница не уезжает; шапка sticky', m375.w[m375.order.indexOf('Исполнитель')] === 192 && m375.scrollW > m375.wrap && /auto|scroll/.test(m375x.ov) && m375.pageOverflow <= 0 && m375x.pos === 'sticky', JSON.stringify([m375, m375x]).slice(0, 400));
    if (before375) {
      C.check('И-2 375: ширина таблицы ' + before375.table + ' → ' + m375.table + ' (прибавка = +64 «Исполнителя»; на 375 колонки с min-width, горизонтальная прокрутка, как раньше)', Math.abs((m375.table - before375.table) - 64) < 1 || Math.abs(m375.table - before375.table) < 1, JSON.stringify([before375.table, m375.table]));
    }
    await k.shot('A08_list_375_admin');
    const tr = await ev(`(() => { const w = document.querySelector('#tasksView .tk-tablewrap'); const r = w.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 120, s0: w.scrollLeft }; })()`);
    const touch = async (pts) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] }); for (const p of pts.slice(1)) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p[0], y: p[1] }] }); await sleep(25); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(400); };
    await touch([[tr.x + 100, tr.y], [tr.x + 60, tr.y], [tr.x, tr.y], [tr.x - 60, tr.y], [tr.x - 120, tr.y]]);
    const s1 = await ev(`document.querySelector('#tasksView .tk-tablewrap').scrollLeft`);
    C.check('И-2 375: Список прокручивается пальцем по горизонтали (scrollLeft ' + tr.s0 + ' → ' + s1 + ')', s1 > tr.s0 + 20, s1);
    await ev(`document.querySelector('#tasksView .tk-tablewrap').scrollLeft = 330`); await sleep(300);
    const c5m = await cell(X.n5);
    C.check('И-1 375: 2 ФИО + «…» при 5', c5m.links.length === 2 && c5m.more, JSON.stringify(c5m));
    await k.shot('A08b_list_375_scrolled');
    await k.view('board');
    const b5m = await bcard(X.n5);
    C.check('И-1 375 Доска: 2 ФИО + «…»', b5m.btns.length === 2 && b5m.more, JSON.stringify(b5m));
    await k.shot('A09_board_375');
    C.check('0 необработанных исключений на странице', cdp.exceptions.length === 0, cdp.exceptions.join('\n'));
  } catch (e) {
    console.log('ОШИБКА ХАРНЕССА: ' + e.stack);
    C.check('harness без ошибок', false, e.message);
  } finally {
    C.save();
    console.log('\nA: ' + C.passed + ' passed, ' + C.failed + ' failed');
    env.cleanup();
    process.exit(C.failed ? 1 : 0);
  }
})();
