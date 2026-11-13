// V6.2-3 (приёмка, вне gate): A — W-1…W-4 (Список, ✎, Доска «…», метки-теги), роли, 375.
// Запуск: V62_BEFORE_ROOT=<выгрузка 0e69a2d> node scripts/v62_accept_a_list_tags.js → reports/V6_2/V6.2-3_screens/A_*.png, A_results.json
'use strict';
const path = require('path');
const { L, seed, D, sleep, OUT, kit, api } = require('./v62_accept_lib.js');

async function measure(root) {
  const env = await L.startEnv({ root });
  try {
    const s = await seed(env);
    const b = await env.openBrowser();
    const k = kit(b.cdp, env);
    await k.size(1280, 900, false); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
    return await k.ev(`(() => { const ths=[...document.querySelectorAll('#tasksView .tk-table thead th')]; const t=document.querySelector('#tasksView .tk-table'); return { order: ths.map(x=>x.textContent.trim()), w: ths.map(x=>+x.getBoundingClientRect().width.toFixed(1)), table: +t.getBoundingClientRect().width.toFixed(1) }; })()`);
  } finally { env.cleanup(); }
}

(async () => {
  const C = L.makeChecker(path.join(OUT, 'A_results.json'));
  const beforeRoot = process.env.V62_BEFORE_ROOT;
  let before = null;
  if (beforeRoot) { before = await measure(beforeRoot); C.note('before', before); console.log('before', JSON.stringify(before)); }
  const env = await L.startEnv();
  try {
    const s = await seed(env);
    const adminCk = s.adminCookies.join('; ');
    const T = s.T;
    const mk = async (title, as, extra) => { const r = await api(env, adminCk, 'POST', 'api/tasks.php', Object.assign({ title, start_at: D(1) + 'T13:00', end_at: D(1) + 'T14:00', assignees: as }, extra || {})); if (r.status !== 201) throw new Error(title + ' ' + r.status + JSON.stringify(r.json)); return r.json.task.id; };
    const X = {};
    X.n1 = await mk('Один исполнитель', ['emp_1']);
    X.n2 = await mk('Два исполнителя', ['emp_1', 'emp_2']);
    X.n3 = await mk('Три исполнителя', ['emp_1', 'emp_2', 'emp_3']);
    X.n5 = await mk('Пять исполнителей', ['emp_1', 'emp_2', 'emp_3', 'emp_4', 'emp_105']);
    X.tags = await mk('Задача с тегами', ['emp_1'], { label: 'alpha, beta, gamma' });
    X.tags2 = await mk('Вторая с тегами', ['emp_2'], { label: 'beta, Delta' });
    X.old = await mk('Старая метка с запятой', ['emp_3'], { label: 'x' });
    L.sql(env.tmpDb, "UPDATE tasks SET label='старый,тег 2' WHERE id='" + X.old + "';"); // как на проде: «сырая» метка с запятой в обход нормализации
    const A = await env.openBrowser(); C.note('browser', A.version);
    const cdp = A.cdp, k = kit(cdp, env), ev = k.ev;
    const rowSel = (id) => '#tasksView .tk-row[data-id="' + id + '"]';

    // ============================================== W-1 (admin, 1280)
    console.log('=== W-1 Список, колонки (1280)');
    await k.size(1280, 900, false); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
    const m = await ev(`(() => { const ths=[...document.querySelectorAll('#tasksView .tk-table thead th')]; const t=document.querySelector('#tasksView .tk-table'); return { order: ths.map(x=>x.textContent.trim()), w: ths.map(x=>+x.getBoundingClientRect().width.toFixed(1)), table: +t.getBoundingClientRect().width.toFixed(1), wrap: document.querySelector('#tasksView .tk-tablewrap').clientWidth }; })()`);
    console.log(JSON.stringify(m)); C.note('after_1280', m);
    const iExec = m.order.indexOf('Исполнитель'), iDesc = m.order.indexOf('Описание'), iTask = m.order.indexOf('Задача');
    C.check('W-1 порядок колонок: Задача · Описание · Исполнитель · Срок · Приор. · Статус · (Править)', m.order.map(x => x.replace('↕', '')).slice(0, 6).join('|') === 'Задача|Описание|Исполнитель|Срок|Приор.|Статус' && iDesc === iTask + 1 && iExec === iDesc + 1, m.order.join('|'));
    if (before) {
      const bE = before.w[before.order.indexOf('Исполнитель')], bD = before.w[before.order.indexOf('Описание')];
      C.note('measure', { before_exec: bE, before_desc: bD, after_exec: m.w[iExec], after_desc: m.w[iDesc], before_table: before.table, after_table: m.table });
      C.check('W-1 «Исполнитель» ≈ 50 % прежней ширины (±5 п.п.): ' + bE + ' → ' + m.w[iExec], Math.abs(m.w[iExec] / bE - 0.5) <= 0.05, m.w[iExec] / bE);
      C.check('W-1 «Описание» стало шире: ' + bD + ' → ' + m.w[iDesc], m.w[iDesc] > bD + 40, '');
      console.log('  before exec', bE, 'desc', bD, '→ after exec', m.w[iExec], 'desc', m.w[iDesc]);
    }
    C.check('W-1 таблица помещается в 1280 без горизонтальной прокрутки', m.table <= m.wrap + 1, m.table + ' vs ' + m.wrap);
    const cell = await ev(`(() => { const r = document.querySelector(${JSON.stringify(rowSel(T.dirmeet))}); const ex = r.querySelector('.tk-c-exec'); return { txt: ex.textContent.trim(), h: ex.getBoundingClientRect().height, bang: /!/.test(ex.textContent) }; })()`);
    C.check('W-1 «!» у исполнителя на отпуске (R-8) сохраняется: «' + cell.txt + '»', cell.bang, JSON.stringify(cell));
    const wrapped = await ev(`(() => { const ex = document.querySelector(${JSON.stringify(rowSel(T.dirmeet))} + ' .tk-c-exec'); const ws = ex.getBoundingClientRect().width; return { scrollW: ex.scrollWidth, w: ws, h: ex.getBoundingClientRect().height }; })()`);
    C.check('W-1 длинное ФИО переносится, не вылезает из колонки', wrapped.scrollW <= wrapped.w + 1 && wrapped.h > 30, JSON.stringify(wrapped));
    await k.shot('A01_list_1280_admin');
    await k.shotEl('#tasksView .tk-tablewrap', 'A01b_list_table_1280', { maxH: 520 });

    // ============================================== W-2
    console.log('=== W-2 ✎');
    const n = await ev(`({ rows: document.querySelectorAll('#tasksView .tk-row').length, btns: document.querySelectorAll('#tasksView .tk-row .tk-editbtn').length, lastTh: document.querySelector('#tasksView .tk-table thead th:last-child').textContent.trim(), title: document.querySelector('#tasksView .tk-editbtn').title, txt: document.querySelector('#tasksView .tk-editbtn').textContent.trim(), sz: (r => r.width + 'x' + r.height)(document.querySelector('#tasksView .tk-editbtn').getBoundingClientRect()) })`);
    C.check('W-2 admin: ✎ в каждой строке (' + n.btns + '/' + n.rows + '), подсказка «Править», кнопка ' + n.sz, n.btns === n.rows && n.rows > 5 && n.title === 'Править' && n.txt === '✎' && n.lastTh === 'Править', JSON.stringify(n));
    await k.click(rowSel(T.plan) + ' .tk-editbtn'); await sleep(500);
    let st = await ev(`({ form: !!document.querySelector('#tasksView form.tk-form'), title: (document.querySelector('[data-tk-field="title"]')||{}).value, detail: !!document.querySelector('#tasksView .tk-detail'), view: window.Tasks.__t.S.view })`);
    C.check('W-2 реальный клик по ✎ → форма правки именно этой задачи, карточка не открыта, остались в Списке', st.form && st.title === 'Планёрка отдела' && !st.detail && st.view === 'list', JSON.stringify(st));
    await k.shot('A02_edit_form_from_list_1280');
    await k.click('[data-tk-act="cancelForm"]'); await sleep(300);
    const rt = await k.rect(rowSel(T.plan) + ' .tk-c-task');
    await k.clickXY(rt.x, rt.y); await sleep(500);
    st = await ev(`({ form: !!document.querySelector('#tasksView form.tk-form'), detail: !!document.querySelector('#tasksView .tk-detail') })`);
    st.view = await ev('window.Tasks.__t.S.view');
    C.check('W-2 клик по строке (ячейка «Задача») → карточка (как до V6.2: открывается на Доске), а не форма: ' + JSON.stringify(st), st.detail && !st.form, JSON.stringify(st));
    await k.view('list');
    await ev(`document.querySelector(${JSON.stringify(rowSel(T.call) + ' .tk-editbtn')}).focus()`); await k.key('Enter'); await sleep(500);
    st = await ev(`({ form: !!document.querySelector('#tasksView form.tk-form'), title: (document.querySelector('[data-tk-field="title"]')||{}).value })`);
    C.check('W-2 клавиатура: Enter на ✎ → форма «Звонок клиенту»', st.form && st.title === 'Звонок клиенту', JSON.stringify(st));
    await k.click('[data-tk-act="cancelForm"]'); await sleep(300);
    await ev(`document.querySelector(${JSON.stringify(rowSel(T.call) + ' .tk-editbtn')}).focus()`); await k.key(' '); await sleep(500);
    st = await ev(`({ form: !!document.querySelector('#tasksView form.tk-form') })`);
    C.check('W-2 клавиатура: Space на ✎ → форма', st.form, JSON.stringify(st));
    await k.click('[data-tk-act="cancelForm"]'); await sleep(300);

    // ============================================== W-3 Доска
    console.log('=== W-3 Доска');
    await k.view('board');
    const card = async (id) => ev(`(() => { const c = document.querySelector('#tasksView .tk-card[data-id="${id}"]'); const sub = c.querySelector('.tk-sub'); return { txt: sub.textContent.trim(), title: sub.getAttribute('title'), btns: [...sub.querySelectorAll('[data-tk-act="filterEmp"]')].map(b=>b.textContent.trim()), dots: sub.textContent.indexOf('…') >= 0 }; })()`);
    const c1 = await card(X.n1), c2 = await card(X.n2), c3 = await card(X.n3), c5 = await card(X.n5);
    console.log(JSON.stringify([c1, c2, c3, c5]));
    C.check('W-3 1 исполнитель: одно ФИО, без «…»', c1.btns.length === 1 && !c1.dots, JSON.stringify(c1));
    C.check('W-3 2 исполнителя: два ФИО, без «…»', c2.btns.length === 2 && !c2.dots, JSON.stringify(c2));
    C.check('W-3 3 исполнителя: два ФИО + «…», title = полный список из 3', c3.btns.length === 2 && c3.dots && c3.title && c3.title.split(',').length === 3, JSON.stringify(c3));
    C.check('W-3 5 исполнителей: два ФИО + «…», title = все 5', c5.btns.length === 2 && c5.dots && c5.title && c5.title.split(',').length === 5, JSON.stringify(c5));
    await k.click('#tasksView .tk-card[data-id="' + X.n3 + '"] [data-tk-act="filterEmp"]'); await sleep(500);
    st = await ev(`JSON.stringify({ v: window.Tasks.__t.S.view, e: window.Tasks.__t.S.filters.emp })`);
    C.check('W-3 клик по первому ФИО на плитке → Список по сотруднику (R-14)', /"v":"list"/.test(st) && /emp_1/.test(st), st);
    await ev('window.Tasks.__t.S.filters.emp=""'); await k.view('board');
    await k.shot('A03_board_names_1280');
    await k.click('#tasksView .tk-card[data-id="' + X.n5 + '"] b'); await sleep(400);
    const det = await ev(`document.querySelector('#tasksView .tk-detail').textContent`);
    C.check('W-3 карточка задачи с 5 исполнителями показывает всех (без «…»)', (det.match(/…/g) || []).length === 0 && ['Козлов', 'Иванов'].some((x) => det.indexOf(x) >= 0), det.slice(0, 300));
    await k.shot('A03b_board_card_detail_1280');

    // ============================================== W-4 теги
    console.log('=== W-4 теги');
    await k.view('list');
    const oldChips = await ev(`[...document.querySelectorAll(${JSON.stringify(rowSel(X.old) + ' .tk-tagbtn')})].map(e => e.textContent.trim())`);
    C.check('W-4 «старая» метка «старый,тег 2» (в БД как на проде) → 2 отдельных чипа в Списке: ' + JSON.stringify(oldChips), oldChips.length === 2 && oldChips[0] === 'старый' && oldChips[1] === 'тег 2', JSON.stringify(oldChips));
    const oldApi = await api(env, adminCk, 'GET', 'api/tasks.php?id=' + X.old);
    C.check('W-4 API: старая метка → label строкой «старый,тег 2» и labels[] из 2', oldApi.json.task && oldApi.json.task.label === 'старый,тег 2' && JSON.stringify(oldApi.json.task.labels) === JSON.stringify(['старый', 'тег 2']), JSON.stringify(oldApi.json.task));
    const chipSel = (id) => '#tasksView .tk-row[data-id="' + id + '"] .tk-tagbtn';
    const betaIdx = await ev(`[...document.querySelectorAll(${JSON.stringify(chipSel(X.tags))})].findIndex(e => e.textContent.trim() === 'beta')`);
    await k.click(chipSel(X.tags), betaIdx); await sleep(500);
    st = await ev(`JSON.stringify({ v: window.Tasks.__t.S.view, l: window.Tasks.__t.S.filters.label, rows: [...document.querySelectorAll('#tasksView .tk-row')].map(r => r.querySelector('b').textContent) })`);
    const stj = JSON.parse(st);
    C.check('W-4 клик по чипу «beta» в Списке → фильтр «Метка» = beta, видны ровно 2 задачи с этим тегом', stj.v === 'list' && stj.l === 'beta' && stj.rows.length === 2 && stj.rows.includes('Задача с тегами') && stj.rows.includes('Вторая с тегами'), st);
    await k.shot('A04_list_filtered_by_tag_1280');
    const opts = await ev(`[...document.querySelectorAll('#tasksView select[data-tk-filter="label"] option')].map(o => o.textContent.trim())`);
    console.log('options', JSON.stringify(opts));
    const tagOpts = opts.slice(1);
    const uniq = new Set(tagOpts.map(x => x.toLowerCase())).size === tagOpts.length;
    const sorted = [...tagOpts].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
    C.check('W-4 фильтр «Метка»: отдельные теги, без дублей (' + tagOpts.length + ')', uniq && ['alpha', 'beta', 'gamma', 'старый', 'тег 2'].every(x => tagOpts.includes(x)) && !tagOpts.some(o => o.indexOf(',') >= 0), JSON.stringify(tagOpts));
    C.check('W-4 фильтр «Метка»: по алфавиту', JSON.stringify(tagOpts.map(x => x.toLowerCase())) === JSON.stringify(sorted.map(x => x.toLowerCase())), JSON.stringify(tagOpts) + ' vs ' + JSON.stringify(sorted));
    await ev(`(() => { const s = document.querySelector('#tasksView select[data-tk-filter="label"]'); s.value = 'тег 2'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(500);
    const rows2 = await ev(`[...document.querySelectorAll('#tasksView .tk-row b')].map(b => b.textContent)`);
    C.check('W-4 фильтр «Метка» = «тег 2» (вторая часть старой метки) → только «Старая метка с запятой»', rows2.length === 1 && rows2[0] === 'Старая метка с запятой', JSON.stringify(rows2));
    await ev('document.querySelector("#tasksView [data-tk-act=resetFilters]").click()'); await sleep(300);
    await k.view('board');
    const bch = await ev(`[...document.querySelectorAll('#tasksView .tk-card[data-id="${X.tags}"] .tk-tagbtn')].map(e => e.textContent.trim())`);
    C.check('W-4 Доска: теги — отдельные чипы ' + JSON.stringify(bch), bch.includes('alpha') && bch.includes('beta') && bch.includes('gamma'), JSON.stringify(bch));
    await k.click('#tasksView .tk-card[data-id="' + X.tags + '"] b'); await sleep(400);
    const dch = await ev(`[...document.querySelectorAll('#tasksView .tk-detail .tk-tagbtn')].map(e => e.textContent.trim())`);
    C.check('W-4 карточка: теги — отдельные чипы ' + JSON.stringify(dch), dch.includes('alpha') && dch.includes('gamma'), JSON.stringify(dch));
    await k.click('#tasksView .tk-detail .tk-tagbtn[data-f="label"]', 2); await sleep(500);
    st = await ev(`JSON.stringify({ v: window.Tasks.__t.S.view, l: window.Tasks.__t.S.filters.label })`);
    C.check('W-4 клик по тегу в карточке → Список с фильтром по этому тегу (R-12): ' + st, /"v":"list"/.test(st) && /"l":"(gamma|beta|alpha)"/.test(st), st);
    await ev('document.querySelector("#tasksView [data-tk-act=resetFilters]").click()'); await sleep(300);

    // --- ввод тегов в форме
    await k.click(rowSel(X.tags) + ' .tk-editbtn'); await sleep(500);
    const chips = () => ev(`[...document.querySelectorAll('#tasksView form.tk-form .tk-tagchip')].map(e => e.getAttribute('data-tk-tag'))`);
    let c0 = await chips();
    C.check('W-4 форма: 3 существующих тега показаны чипами ' + JSON.stringify(c0), JSON.stringify(c0) === JSON.stringify(['alpha', 'beta', 'gamma']), JSON.stringify(c0));
    await k.shotEl('#tasksView form.tk-form', 'A05_form_tags_1280', { maxH: 900 });
    const inpSel = '#tasksView form.tk-form [data-tk-field="labelInput"]';
    await k.click(inpSel);
    await k.type('delta'); await k.key('Enter');
    let c = await chips(); C.check('W-4 ввод «delta» + Enter → чип (4)', c.length === 4 && c[3] === 'delta', JSON.stringify(c));
    let inpv = await ev(`document.querySelector(${JSON.stringify(inpSel)}).value`);
    C.check('W-4 после Enter поле ввода очищено и остаётся в фокусе', inpv === '' && await ev(`document.activeElement === document.querySelector(${JSON.stringify(inpSel)})`), inpv);
    await k.type('epsilon'); await k.key(',', { text: ',' });
    c = await chips(); C.check('W-4 ввод «epsilon» + запятая → чип (5), запятой в поле нет', c.length === 5 && c[4] === 'epsilon' && (await ev(`document.querySelector(${JSON.stringify(inpSel)}).value`)) === '', JSON.stringify(c));
    await k.type('ALPHA'); await k.key('Enter');
    c = await chips(); C.check('W-4 дубль без учёта регистра («ALPHA») не добавляется', c.length === 5 && !c.includes('ALPHA'), JSON.stringify(c));
    await ev(`(() => { const i = document.querySelector(${JSON.stringify(inpSel)}); i.value = ''; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await k.key('Enter'); c = await chips();
    C.check('W-4 Enter на пустом вводе ничего не делает (форма не отправлена)', c.length === 5 && await ev('!!document.querySelector("#tasksView form.tk-form")'), JSON.stringify(c));
    await k.type('zz'); await k.key('Backspace');
    c = await chips(); inpv = await ev(`document.querySelector(${JSON.stringify(inpSel)}).value`);
    C.check('W-4 Backspace в НЕпустом вводе стирает символ, чип не трогает', c.length === 5 && inpv === 'z', inpv + ' ' + JSON.stringify(c));
    await k.key('Backspace');
    await k.key('Backspace'); c = await chips();
    C.check('W-4 Backspace в пустом вводе удаляет последний чип (epsilon)', c.length === 4 && !c.includes('epsilon'), JSON.stringify(c));
    await k.click('#tasksView form.tk-form .tk-tagchip .tk-x', 0); await sleep(300);
    c = await chips(); C.check('W-4 реальный клик по × на первом чипе удаляет «alpha»', c.length === 3 && !c.includes('alpha'), JSON.stringify(c));
    let pasted = false;
    try {
      await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: env.base });
      await ev(`navigator.clipboard.writeText('пэйст1, пэйст2 ,  пэйст3,,')`);
      await k.click(inpSel);
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2, commands: ['paste'] });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
      await sleep(400);
      c = await chips(); pasted = c.includes('пэйст1');
    } catch (e) { console.log('  (clipboard) ' + e.message); }
    C.note('real_clipboard_paste', pasted);
    if (!pasted) { await k.click(inpSel); await k.type('пэйст1, пэйст2 ,  пэйст3,,'); await sleep(300); c = await chips(); }
    C.check('W-4 вставка строки «пэйст1, пэйст2 ,  пэйст3,,» → 3 отдельных чипа (' + (pasted ? 'реальная вставка из буфера' : 'insertText') + ') ' + JSON.stringify(c), c.includes('пэйст1') && c.includes('пэйст2') && c.includes('пэйст3') && c.length === 6 && !c.includes(''), JSON.stringify(c));
    await k.shot('A06_form_tags_after_input_1280');
    await k.click(inpSel); await k.type('q'.repeat(31)); await k.key('Enter');
    const err1 = await ev(`(document.querySelector('#tasksView form.tk-form .tk-err, #tasksView form.tk-form .tk-error, #tasksView .tk-msg, #tasksView .tk-formerr') || {}).textContent || ''`);
    c = await chips();
    C.check('W-4 тег из 31 символа → понятная ошибка, чип не добавлен, текст не потерян: «' + err1.trim().slice(0, 80) + '»', c.length === 6 && /30/.test(err1) && (await ev(`document.querySelector(${JSON.stringify(inpSel)}).value`)).length === 31, err1 + JSON.stringify(c));
    await k.shot('A07_form_tag_too_long_1280');
    await ev(`(() => { const i = document.querySelector(${JSON.stringify(inpSel)}); i.value = ''; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await k.click(inpSel); await k.type('хвост без энтера');
    await k.click('[data-tk-act="saveForm"]'); await sleep(900);
    const sv = await api(env, adminCk, 'GET', 'api/tasks.php?id=' + X.tags);
    console.log('saved label:', JSON.stringify(sv.json.task.label), JSON.stringify(sv.json.task.labels));
    C.check('W-4 «Сохранить» с непревращённым хвостом → тег сохранён; сервер: label=строка, labels[7]', sv.json.task.labels.length === 7 && sv.json.task.labels.includes('хвост без энтера') && !sv.json.task.labels.includes('alpha') && sv.json.task.label === sv.json.task.labels.join(', '), JSON.stringify(sv.json.task.labels) + ' / ' + sv.json.task.label);
    await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
    const rl = await ev(`[...document.querySelectorAll(${JSON.stringify(rowSel(X.tags) + ' .tk-tagbtn')})].map(e => e.textContent.trim())`);
    C.check('W-4 после перезагрузки страницы теги в Списке те же (7 отдельных чипов)', rl.length === 7 && rl.includes('хвост без энтера'), JSON.stringify(rl));
    await k.click(rowSel(X.tags) + ' .tk-editbtn'); await sleep(500);
    c = await chips(); C.check('W-4 повторная правка: форма показывает те же 7 тегов чипами', c.length === 7, JSON.stringify(c));
    await k.click('[data-tk-act="cancelForm"]'); await sleep(300);
    await k.shotEl('#tasksView .tk-tablewrap', 'A08_list_tag_chips_1280', { maxH: 520 });
    await k.click('#tasksView [data-tk-act="newTask"]'); await sleep(500);
    await k.click('#tasksView form.tk-form [data-tk-field="title"]'); await k.type('Новая с тегами');
    await ev(`(() => { const s = document.querySelector('[data-tk-field="assigneePick"]'); s.value = 'emp_1'; s.dispatchEvent(new Event('change', {bubbles:true})); })()`); await sleep(300);
    await k.click(inpSel); await k.type('one'); await k.key('Enter'); await k.type('two'); await k.key(',');
    await k.click('[data-tk-act="saveForm"]'); await sleep(900);
    const nlist = await api(env, adminCk, 'GET', 'api/tasks.php?from=2026-01-01&to=2027-12-31');
    const nt = (nlist.json.tasks || []).find(t => t.title === 'Новая с тегами');
    C.check('W-4 создание задачи с тегами «one», «two» → label «one, two», labels[2]', nt && nt.label === 'one, two' && nt.labels.length === 2, JSON.stringify(nt && [nt.label, nt.labels]));

    // ============================================== API
    console.log('=== API label');
    const P = (label, extra) => api(env, adminCk, 'POST', 'api/tasks.php', Object.assign({ title: 'API ' + Math.random().toString(36).slice(2, 6), start_at: D(5) + 'T09:00', assignees: ['emp_1'], label }, extra || {}));
    let r = await P('  Foo ,bar,, foo , Bar baz  ,   ');
    C.check('API: «  Foo ,bar,, foo , Bar baz  ,   » → label «Foo, bar, Bar baz», labels[3], 201', r.status === 201 && r.json.task.label === 'Foo, bar, Bar baz' && JSON.stringify(r.json.task.labels) === JSON.stringify(['Foo', 'bar', 'Bar baz']), r.status + JSON.stringify(r.json.task));
    const id1 = r.json.task && r.json.task.id;
    r = await P('');       C.check('API: пустая строка → label null, labels []', r.status === 201 && r.json.task.label === null && r.json.task.labels.length === 0, JSON.stringify(r.json.task));
    r = await P(' , ,');    C.check('API: « , ,» → label null', r.status === 201 && r.json.task.label === null, JSON.stringify(r.json.task));
    r = await P(null);      C.check('API: label null → null', r.status === 201 && r.json.task.label === null, JSON.stringify(r.json.task));
    r = await P('я'.repeat(30)); C.check('API: тег ровно 30 символов (кириллица) принимается', r.status === 201 && r.json.task.labels[0].length === 30, r.status);
    r = await P('я'.repeat(31)); C.check('API: тег 31 символ → 400 invalid_label + message: «' + (r.json.message || '') + '»', r.status === 400 && r.json.error === 'invalid_label' && /30/.test(r.json.message || ''), JSON.stringify(r.json));
    const six = Array.from({ length: 6 }, (_, i) => String(i).repeat(30)).join(', ');
    r = await P(six);       C.check('API: 6 тегов по 30 = 190 символов принимается', r.status === 201 && r.json.task.labels.length === 6, r.status + JSON.stringify(r.json).slice(0, 100));
    const seven = Array.from({ length: 7 }, (_, i) => String(i).repeat(30)).join(', ');
    r = await P(seven);     C.check('API: 7 тегов по 30 = 222 символа → 400 invalid_label: «' + (r.json.message || '') + '»', r.status === 400 && r.json.error === 'invalid_label' && /200/.test(r.json.message || ''), JSON.stringify(r.json));
    const dups = Array.from({ length: 10 }, () => 'z'.repeat(29)).join(', ');
    r = await P(dups);      C.check('API: 10 одинаковых тегов — дубли не считаются в длину → 201, 1 тег', r.status === 201 && r.json.task.labels.length === 1, r.status);
    r = await P(['a', 'b']); C.check('API: label массивом → 400 invalid_label', r.status === 400 && r.json.error === 'invalid_label', JSON.stringify(r.json));
    r = await P(12345);     C.check('API: label числом → 400 invalid_label', r.status === 400 && r.json.error === 'invalid_label', JSON.stringify(r.json));
    r = await api(env, adminCk, 'POST', 'api/tasks.php', { title: 'без метки', start_at: D(5) + 'T09:00', assignees: ['emp_1'] });
    C.check('API: POST без поля label → label null, labels [] (n8n-совместимость)', r.status === 201 && r.json.task.label === null && Array.isArray(r.json.task.labels), JSON.stringify(r.json.task));
    const g = await api(env, adminCk, 'GET', 'api/tasks.php?id=' + id1);
    r = await api(env, adminCk, 'PUT', 'api/tasks.php?id=' + id1, { version: g.json.task.version, label: 'x, X, y ,' });
    C.check('API PUT: label «x, X, y ,» → «x, y»', r.status === 200 && r.json.task.label === 'x, y' && r.json.task.labels.length === 2, r.status + JSON.stringify(r.json.task && r.json.task.label));
    r = await api(env, adminCk, 'PUT', 'api/tasks.php?id=' + id1, { version: r.json.task.version, title: 'API переименована' });
    C.check('API PUT: без поля label метка не трогается', r.status === 200 && r.json.task.label === 'x, y', JSON.stringify(r.json.task && r.json.task.label));
    const v2 = r.json.task.version;
    r = await api(env, adminCk, 'PUT', 'api/tasks.php?id=' + id1, { version: v2, label: 'я'.repeat(31) });
    const g2 = await api(env, adminCk, 'GET', 'api/tasks.php?id=' + id1);
    C.check('API PUT: тег 31 → 400 invalid_label, БД не изменилась', r.status === 400 && r.json.error === 'invalid_label' && g2.json.task.label === 'x, y' && g2.json.task.version === v2, r.status + g2.json.task.label);
    r = await api(env, adminCk, 'PUT', 'api/tasks.php?id=' + id1, { version: v2, label: '' });
    C.check('API PUT: label «» → NULL', r.status === 200 && r.json.task.label === null, JSON.stringify(r.json.task && r.json.task.label));
    const lst = await api(env, adminCk, 'GET', 'api/tasks.php?from=2026-01-01&to=2027-12-31');
    C.check('API GET list: у каждой задачи есть и label, и labels[]', (lst.json.tasks || []).length > 10 && lst.json.tasks.every(t => 'label' in t && Array.isArray(t.labels)), '');
    for (const u of ['supervisor_zone0', 'viewer_test']) {
      const ck = (await L.login(env.base, u)).join('; ');
      const w = await api(env, ck, 'PUT', 'api/tasks.php?id=' + X.tags, { version: 99, label: 'hack' });
      C.check('API ' + u + ': PUT label → 403', w.status === 403, w.status);
    }

    // ============================================== РОЛИ (1280 / 375)
    for (const [user, role] of [['supervisor_zone0', 'supervisor'], ['viewer_test', 'viewer']]) {
      for (const [w, h, mob] of [[1280, 900, false], [375, 740, true]]) {
        console.log('=== роль ' + role + ' ' + w);
        const ck = await L.login(env.base, user);
        await k.size(w, h, mob); await k.load(ck); await k.gotoTasks(); await k.view('list');
        const rr = await ev(`({ th: [...document.querySelectorAll('#tasksView .tk-table thead th')].map(x => x.textContent.trim()), edit: document.querySelectorAll('#tasksView .tk-editbtn').length, chips: document.querySelectorAll('#tasksView .tk-row .tk-tagbtn').length })`);
        C.check(role + ' ' + w + ': нет колонки/кнопок ✎ (6 колонок: ' + rr.th.join('|') + ')', rr.edit === 0 && rr.th.map(x => x.replace('↕', '')).join('|') === 'Задача|Описание|Исполнитель|Срок|Приор.|Статус', JSON.stringify(rr));
        if (w === 1280) {
          await k.click(rowSel(X.tags) + ' .tk-tagbtn', 0); await sleep(400);
          const f = await ev('JSON.stringify(window.Tasks.__t.S.filters.label)');
          C.check(role + ': клик по чипу-тегу (фильтр) работает: ' + f, f !== '""' && f !== 'null', f);
          await ev('document.querySelector("#tasksView [data-tk-act=resetFilters]").click()'); await sleep(200);
          await k.shot('A09_' + role + '_list_1280');
        } else await k.shot('A09_' + role + '_list_375');
      }
    }

    // ============================================== 375 admin
    console.log('=== admin 375');
    await k.size(375, 740, true); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
    const m375 = await ev(`(() => { const w = document.querySelector('#tasksView .tk-tablewrap'); const ths=[...document.querySelectorAll('#tasksView .tk-table thead th')]; return { cw: w.clientWidth, sw: w.scrollWidth, order: ths.map(x=>x.textContent.trim()), exec: ths.find(x=>x.textContent.trim()==='Исполнитель').getBoundingClientRect().width, edit: document.querySelectorAll('#tasksView .tk-editbtn').length, pos: getComputedStyle(ths[0]).position, ov: getComputedStyle(w).overflowX, bodyW: document.documentElement.scrollWidth }; })()`);
    console.log(JSON.stringify(m375)); C.note('m375', m375);
    C.check('375 Список: таблица шире окна и прокручивается внутри обёртки, страница не уезжает вбок', m375.sw > m375.cw && /auto|scroll/.test(m375.ov) && m375.bodyW <= 376, JSON.stringify(m375));
    C.check('375: ✎ есть, шапка sticky, порядок колонок прежний', m375.edit > 5 && m375.pos === 'sticky' && m375.order.slice(0, 3).join('|') === 'Задача|Описание|Исполнитель', JSON.stringify(m375));
    await k.shot('A10_list_375_admin');
    const tr = await ev(`(() => { const w = document.querySelector('#tasksView .tk-tablewrap'); const r = w.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 120, s0: w.scrollLeft }; })()`);
    const touch = async (pts) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] }); for (const p of pts.slice(1)) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p[0], y: p[1] }] }); await sleep(25); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(400); };
    await touch([[tr.x + 100, tr.y], [tr.x + 60, tr.y], [tr.x, tr.y], [tr.x - 60, tr.y], [tr.x - 120, tr.y]]);
    const s1 = await ev(`document.querySelector('#tasksView .tk-tablewrap').scrollLeft`);
    C.check('375: Список прокручивается пальцем по горизонтали (scrollLeft ' + tr.s0 + ' → ' + s1 + ')', s1 > tr.s0 + 20, s1);
    await k.shot('A10b_list_375_scrolled');
    await k.click(rowSel(T.plan) + ' .tk-editbtn'); await sleep(500);
    C.check('375: клик по ✎ открывает форму правки', await ev('!!document.querySelector("#tasksView form.tk-form")'), '');
    await k.shot('A11_form_tags_375');
    await k.click('[data-tk-act="cancelForm"]'); await sleep(300); await k.view('board');
    await k.shot('A12_board_375');
    const c375 = await card(X.n5);
    C.check('375 Доска: 5 исполнителей → 2 ФИО + «…»', c375.btns.length === 2 && c375.dots, JSON.stringify(c375));
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
