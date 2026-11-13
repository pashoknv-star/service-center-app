// V6.2-1 (вне gate): реальный Chromium — W-1 колонки Списка, W-2 «Править» в строке, W-3 Доска ≤ 2 исполнителей, W-4 метки-теги.
// Запуск: node scripts/v62_1_accept.js  → reports/V6_2/V6.2-1_screens/*.png, V62_1_results.json (1280 и 375; admin / supervisor / viewer).
// Каркас — v6_accept_lib.js / v6_accept_seed.js (php -S на КОПИИ data/app.db; пароли в браузер не вводятся: cookie из login.php).
// Реальные события: мышь (Input.dispatchMouseEvent), клавиатура (Input.dispatchKeyEvent), ввод текста (Input.insertText).
'use strict';
const path = require('path'), fs = require('fs');
const L = require('./v6_accept_lib.js');
const { seed, D } = require('./v6_accept_seed.js');
const OUT = path.join(L.ROOT, 'reports/V6_2/V6.2-1_screens');
fs.mkdirSync(OUT, { recursive: true });
const sleep = L.sleep;

(async () => {
  const env = await L.startEnv();
  const C = L.makeChecker(path.join(OUT, 'V62_1_results.json'));
  try {
    const s = await seed(env);
    const ck = s.adminCookies.join('; ');
    const supCookies = await L.login(env.base, 'supervisor_zone0'), viewCookies = await L.login(env.base, 'viewer_test');
    // --- данные W-3/W-4
    const mk = async (title, assignees, label, day) => {
      const r = await L.http(env.base, ck, 'POST', 'api/tasks.php', { title, start_at: D(day) + 'T10:00', end_at: D(day) + 'T11:00', assignees, label, description: 'Описание для ' + title });
      if (r.status !== 201) throw new Error('mk ' + title + ' → ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      return r.json.task.id;
    };
    const W = {};
    W.three = await mk('W62 Совещание трёх исполнителей', ['emp_105', 'emp_106', 'emp_107'], 'Alpha, beta, срочно', 6);
    W.pair = await mk('W62 Пара исполнителей', ['emp_105', 'emp_106'], 'beta,  Gamma ,alpha', 6);
    W.edit = await mk('W62 Задача для правки тегов', ['emp_107'], 'старое', 7);
    W.legacy = await mk('W62 Старая метка с запятой', ['emp_105'], null, 7);
    env.tmpDb && L.sql(env.tmpDb, "UPDATE tasks SET label = 'старый,тег 2' WHERE id = '" + W.legacy + "';");
    const api = async (cookie, url) => (await L.http(env.base, cookie, 'GET', url)).json;
    const task = async (id) => (await api(ck, 'api/tasks.php?id=' + id)).task;

    const { cdp, version } = await env.openBrowser();
    C.note('browser', version);
    const k = L.pageKit(cdp, env.base, OUT);
    const ev = (x) => cdp.ev(x);
    const S = (expr) => ev('(() => { const S = window.Tasks.__t.S; return ' + expr + '; })()');
    const openTasks = async (view, extra) => {
      await ev('window.Tasks.open(' + JSON.stringify(Object.assign({ employeeId: '', date: D(2), view, mode: 'week' }, extra || {})) + ')');
      await k.waitFor('!window.Tasks.__t.S.loading && !!document.querySelector("#tasksView")', 20000); await sleep(500);
    };
    // реальная клавиатура
    const KEYS = { Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      ',': { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, text: ',' }, ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' } };
    const press = async (name) => {
      const kk = KEYS[name];
      await cdp.send('Input.dispatchKeyEvent', Object.assign({ type: kk.text ? 'keyDown' : 'rawKeyDown' }, kk));
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: kk.key, code: kk.code, windowsVirtualKeyCode: kk.windowsVirtualKeyCode });
      await sleep(150);
    };
    const typeText = async (t) => { await cdp.send('Input.insertText', { text: t }); await sleep(150); };
    const draft = () => S('({ labels: S.form.draft.labels.slice(), input: S.form.draft.labelInput })');
    const chipsDom = () => ev('[...document.querySelectorAll("#tasksView .tk-tagchip")].map(e => e.dataset.tkTag)');
    const focused = () => ev('document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.tkField || document.activeElement.tagName : ""');
    const rowSel = (id) => '#tasksView tr.tk-row[data-id="' + id + '"]';

    const loadAs = async (cookies, w, h, mob) => {
      await k.size(w, h, mob);
      await k.load(cookies);
      await ev('document.getElementById("vacationTrigger").click()'); await sleep(600);
      await k.click('#tabTasks'); await sleep(1500);
      await k.waitFor('!window.Tasks.__t.S.loading', 20000);
    };

    for (const vp of [[1280, 900, false, '1280'], [375, 2200, true, '375']].filter((v) => !process.env.ONLY || process.env.ONLY === v[3])) {
      const [w, h, mob, tag] = vp;
      console.log('=== viewport ' + tag + ' admin');
      // одинаковые исходные данные для каждой ширины (предыдущий прогон правил теги и создавал задачу)
      L.sql(env.tmpDb, "UPDATE tasks SET label = 'старое', version = version + 1 WHERE id = '" + W.edit + "'; DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE title = 'W62 Новая с тегами'); DELETE FROM task_checklist WHERE task_id IN (SELECT id FROM tasks WHERE title = 'W62 Новая с тегами'); DELETE FROM tasks WHERE title = 'W62 Новая с тегами';");
      await loadAs(s.adminCookies, w, h, mob);

      // ================= W-1: колонки Списка =================
      await openTasks('list');
      const tbl = await ev(`(() => { const t = document.querySelector('#tasksView .tk-table'); const tw = document.querySelector('#tasksView .tk-tablewrap'); const th = [...t.querySelectorAll('thead th')];
        return { wrap: tw.clientWidth, scrollW: tw.scrollWidth, table: Math.round(t.getBoundingClientRect().width * 10) / 10, cols: th.map(x => [x.textContent.replace(/[↕↑↓]/g, '').trim(), Math.round(x.getBoundingClientRect().width * 10) / 10]), pos: getComputedStyle(th[0]).position }; })()`);
      C.note('listWidths_' + tag, tbl);
      const order = tbl.cols.map((c) => c[0]).join('|');
      const wExec = tbl.cols.find((c) => c[0] === 'Исполнитель')[1], wDesc = tbl.cols.find((c) => c[0] === 'Описание')[1];
      C.check(tag + ' W-1 порядок колонок: Задача · Описание · Исполнитель · Срок · Приор. · Статус · Править', order === 'Задача|Описание|Исполнитель|Срок|Приор.|Статус|Править', order);
      if (tag === '1280') {
        C.check(tag + ' W-1 «Исполнитель» ≈ 50 % прежней (до правки на 1280: 255.8 px → теперь ' + wExec + ' px), «Описание» шире прежней (200.8 → ' + wDesc + ' px) и шире «Исполнителя»',
          Math.abs(wExec - 128) <= 1 && wDesc > 280 && wDesc > wExec * 2, JSON.stringify(tbl.cols));
      } else {
        C.check(tag + ' W-1 на 375: таблица шире экрана и прокручивается горизонтально (scrollWidth ' + tbl.scrollW + ' > clientWidth ' + tbl.wrap + '), «Исполнитель» ' + wExec + ' px', tbl.scrollW > tbl.wrap + 50 && Math.abs(wExec - 128) <= 1, JSON.stringify(tbl));
      }
      // sticky-шапка: прокрутка тела списка — шапка остаётся наверху контейнера
      const stick = await ev(`(() => { const tw = document.querySelector('#tasksView .tk-tablewrap'); tw.scrollTop = 80; const r = tw.getBoundingClientRect(), t = document.querySelector('#tasksView .tk-table thead th').getBoundingClientRect(); return { sc: tw.scrollTop, dy: Math.round(t.top - r.top), pos: getComputedStyle(document.querySelector('#tasksView .tk-table thead th')).position, can: tw.scrollHeight > tw.clientHeight }; })()`);
      C.check(tag + ' W-1 шапка sticky (position:sticky; при прокрутке тела остаётся у верха контейнера)', stick.pos === 'sticky' && (!stick.can || (stick.sc > 0 && Math.abs(stick.dy) <= 2)), JSON.stringify(stick));
      await ev('document.querySelector("#tasksView .tk-tablewrap").scrollTop = 0');
      // ФИО переносятся, «!» и клик-фильтр целы
      const fio = await ev(`(() => { const td = document.querySelector('${rowSel(s.T.dirmeet)} td.tk-c-exec'); const a = td.querySelector('[data-tk-act="filterEmp"]'); const cs = getComputedStyle(td); return { text: td.textContent, warn: !!td.querySelector('.tk-warnico'), h: Math.round(td.getBoundingClientRect().height), ow: cs.overflowWrap, w: Math.round(td.getBoundingClientRect().width), emp: a && a.dataset.emp, sw: td.scrollWidth, cw: td.clientWidth }; })()`);
      C.note('fioCell_' + tag, fio);
      C.check(tag + ' W-1 ФИО в узкой колонке переносятся (без горизонтального переполнения ячейки), «!» (R-8) на месте, ссылка-фильтр (R-14) на месте', fio.warn && fio.emp === 'emp_101' && fio.sw <= fio.cw + 1 && fio.ow === 'anywhere' && fio.h > 30, JSON.stringify(fio));
      await k.shotEl('#tasksView .tk-tablewrap', 'W1_list_columns_' + tag, { maxH: 760 });
      // клик по ФИО в узкой колонке → фильтр по сотруднику (R-14)
      await k.click(rowSel(s.T.dirmeet) + ' td.tk-c-exec [data-tk-act="filterEmp"]'); await sleep(500);
      C.check(tag + ' W-1 R-14: клик по ФИО в колонке → Список с фильтром по сотруднику', (await S('S.view === "list" && S.filters.emp === "emp_101" && !S.filters.label')), '');
      await openTasks('list');

      // ================= W-2: ✎ в строке =================
      const eb = await ev(`(() => { const b = document.querySelector('${rowSel(W.edit)} .tk-editbtn'); const r = b.getBoundingClientRect(); return { n: document.querySelectorAll('#tasksView .tk-editbtn').length, rows: document.querySelectorAll('#tasksView tr.tk-row').length, title: b.title, label: b.getAttribute('aria-label'), text: b.textContent, w: Math.round(r.width), h: Math.round(r.height), type: b.type, th: document.querySelector('#tasksView th.tk-c-edit').textContent }; })()`);
      C.note('editBtn_' + tag, eb);
      C.check(tag + ' W-2 admin: ✎ в каждой строке (' + eb.n + '/' + eb.rows + '), title «Править», доступное имя, размер ' + eb.w + '×' + eb.h + ' px', eb.n === eb.rows && eb.title === 'Править' && /Править задачу/.test(eb.label) && eb.text === '✎' && eb.w >= 30 && eb.h >= 30 && eb.th === 'Править', JSON.stringify(eb));
      await k.click(rowSel(W.edit) + ' .tk-editbtn'); await sleep(600);
      const f1 = await S('({ form: S.form && S.form.id, view: S.view, sel: S.selectedId, detail: !!document.querySelector("#tasksView .tk-detail"), h4: (document.querySelector("#tasksView .tk-form h4")||{}).textContent, title: (document.querySelector("[data-tk-field=title]")||{}).value })');
      C.check(tag + ' W-2 реальный клик по ✎ → сразу форма правки этой задачи; карточка не открыта; остались в «Списке»', f1.form === W.edit && f1.view === 'list' && !f1.detail && f1.sel !== W.edit && /Редактирование/.test(f1.h4) && f1.title === 'W62 Задача для правки тегов', JSON.stringify(f1));
      await k.shot('W2_click_edit_form_' + tag);
      await k.click('[data-tk-act="cancelForm"]'); await sleep(400);
      // клик по строке — карточка, как раньше
      await k.click(rowSel(W.edit) + ' td.tk-c-task b'); await sleep(600);
      const f2 = await S('({ view: S.view, sel: S.selectedId, detail: !!document.querySelector("#tasksView .tk-detail"), form: !!S.form })');
      C.check(tag + ' W-2 клик по строке (не по ✎) открывает карточку, как раньше', f2.sel === W.edit && f2.detail && !f2.form, JSON.stringify(f2));
      await openTasks('list');
      // клавиатура: Tab-фокус на ✎ + Enter, затем Space
      for (const key of ['Enter', ' ']) {
        await ev(`document.querySelector('${rowSel(W.edit)} .tk-editbtn').focus()`);
        await press(key); await sleep(500);
        const fk = await S('({ form: S.form && S.form.id, sel: S.selectedId })');
        C.check(tag + ' W-2 клавиатура: фокус на ✎ + ' + (key === ' ' ? 'Space' : 'Enter') + ' → форма правки', fk.form === W.edit && fk.sel !== W.edit, JSON.stringify(fk));
        await k.click('[data-tk-act="cancelForm"]'); await sleep(300);
      }

      // ================= W-4: форма, теги =================
      await k.click(rowSel(W.edit) + ' .tk-editbtn'); await sleep(500);
      const tb = await ev(`(() => { const b = document.querySelector('#tasksView [data-tk-tagsbox]'); const i = b.querySelector('input'); return { chips: [...b.querySelectorAll('.tk-tagchip')].map(e => e.dataset.tkTag), list: i.getAttribute('list'), opts: [...document.querySelectorAll('#tkLabels option')].map(o => o.value), w: Math.round(b.getBoundingClientRect().width), iw: Math.round(i.getBoundingClientRect().width) }; })()`);
      C.check(tag + ' W-4 форма: «старое» — чипом; подсказки (datalist) — уникальные существующие теги: ' + tb.opts.join(', '), tb.chips.join() === 'старое' && tb.list === 'tkLabels' && tb.opts.indexOf('Alpha') >= 0 && tb.opts.indexOf('beta') >= 0 && tb.opts.indexOf('старый') >= 0 && new Set(tb.opts.map((x) => x.toLowerCase())).size === tb.opts.length, JSON.stringify(tb));
      await k.click('#tasksView [data-tk-field="labelInput"]');
      await typeText('Первый'); await press('Enter');
      let d1 = await draft();
      C.check(tag + ' W-4 ввод + Enter → чип «Первый», поле очищено, фокус остался в поле', d1.labels.join('|') === 'старое|Первый' && d1.input === '' && (await focused()) === 'labelInput', JSON.stringify(d1));
      await typeText('Второй'); await press(',');
      d1 = await draft();
      C.check(tag + ' W-4 ввод + запятая → чип «Второй» (запятая в поле не попала)', d1.labels.join('|') === 'старое|Первый|Второй' && d1.input === '', JSON.stringify(d1));
      await typeText('первый'); await press('Enter');
      d1 = await draft();
      C.check(tag + ' W-4 дубль (другой регистр) не добавляется', d1.labels.join('|') === 'старое|Первый|Второй', JSON.stringify(d1));
      await typeText('Из, вставки, трёх'); await sleep(300);
      d1 = await draft();
      C.check(tag + ' W-4 строка с запятыми (вставка/ввод) → несколько чипов: «Из», «вставки», «трёх»', d1.labels.join('|') === 'старое|Первый|Второй|Из|вставки|трёх' && d1.input === '' && (await chipsDom()).length === 6, JSON.stringify(d1));
      await press('Backspace');
      d1 = await draft();
      C.check(tag + ' W-4 Backspace в пустом поле удаляет последний чип («трёх»)', d1.labels.join('|') === 'старое|Первый|Второй|Из|вставки', JSON.stringify(d1));
      await typeText('аб'); await press('Backspace');
      d1 = await draft();
      C.check(tag + ' W-4 Backspace в непустом поле правит текст (чипы целы): «а»', d1.labels.length === 5 && d1.input === 'а', JSON.stringify(d1));
      await ev('(() => { const i = document.querySelector("[data-tk-field=labelInput]"); i.select(); })()'); await press('Backspace'); // очистить введённое
      d1 = await draft();
      // × на чипе — реальным кликом
      await k.click('#tasksView .tk-tagchip[data-tk-tag="Из"] [data-tk-act="removeTag"]'); await sleep(300);
      d1 = await draft();
      C.check(tag + ' W-4 клик по × на чипе «Из» удаляет именно его', d1.labels.join('|') === 'старое|Первый|Второй|вставки', JSON.stringify(d1));
      await k.shotEl('#tasksView .tk-form', 'W4_form_tags_' + tag, { maxH: 800 });
      // длинный тег
      await k.click('#tasksView [data-tk-field="labelInput"]');
      await typeText('я'.repeat(31)); await press('Enter');
      const errTxt = await S('S.form.error');
      d1 = await draft();
      C.check(tag + ' W-4 тег > 30 символов → понятная ошибка в форме, чип не добавлен, текст не потерян', /длиннее 30 символов/.test(errTxt) && d1.labels.length === 4 && d1.input.length === 31, errTxt);
      await k.shot('W4_form_tag_error_' + tag);
      await ev('(() => { const i = document.querySelector("[data-tk-field=labelInput]"); i.select(); })()'); await press('Backspace'); await sleep(200);
      // непревращённый текст сохраняется
      await typeText('Хвост без Enter'); await sleep(200);
      await k.click('[data-tk-act="saveForm"]'); await sleep(1200);
      const saved = await task(W.edit);
      C.check(tag + ' W-4 «Сохранить» с непревращённым текстом: на сервере «старое, Первый, Второй, вставки, Хвост без Enter», labels[5]', saved.label === 'старое, Первый, Второй, вставки, Хвост без Enter' && saved.labels.length === 5, saved.label);
      const after = await S('({ form: !!S.form, view: S.view })');
      C.check(tag + ' W-4 после сохранения форма закрыта, остались в «Списке»', !after.form && after.view === 'list', JSON.stringify(after));
      // перечитывание: перезагрузка страницы, теги в Списке — 5 чипов
      await loadAs(s.adminCookies, w, h, mob);
      await openTasks('list');
      const chipsList = await ev(`[...document.querySelectorAll('${rowSel(W.edit)} .tk-ltag')].map(e => e.textContent)`);
      C.check(tag + ' W-4 после перезагрузки страницы: в строке Списка 5 отдельных чипов-тегов', chipsList.join('|') === 'старое|Первый|Второй|вставки|Хвост без Enter', chipsList.join('|'));
      // править ещё раз: чипы подгружены
      await k.click(rowSel(W.edit) + ' .tk-editbtn'); await sleep(400);
      C.check(tag + ' W-4 повторная правка: в форме те же 5 чипов', (await chipsDom()).join('|') === 'старое|Первый|Второй|вставки|Хвост без Enter', (await chipsDom()).join('|'));
      await k.click('[data-tk-act="cancelForm"]'); await sleep(300);

      // ================= W-4: чипы в Списке, Доске, карточке; фильтр =================
      await openTasks('list');
      await k.shotEl('#tasksView .tk-tablewrap', 'W4_list_tags_' + tag, { maxH: 760 });
      const lt = await ev(`[...document.querySelectorAll('${rowSel(W.three)} .tk-ltag')].map(e => ({ t: e.textContent, f: e.dataset.f, v: e.dataset.v, role: e.getAttribute('role'), cur: getComputedStyle(e).cursor }))`);
      C.check(tag + ' W-4 Список: «Alpha, beta, срочно» — 3 отдельных чипа-кнопки (filterBy label), курсор-указатель', lt.length === 3 && lt.every((x) => x.f === 'label' && x.role === 'button' && x.cur === 'pointer') && lt.map((x) => x.t).join() === 'Alpha,beta,срочно', JSON.stringify(lt));
      const lg = await ev(`[...document.querySelectorAll('${rowSel(W.legacy)} .tk-ltag')].map(e => e.textContent)`);
      C.check(tag + ' W-4 старое значение «старый,тег 2» (как на проде) показано двумя тегами', lg.join('|') === 'старый|тег 2', lg.join('|'));
      // реальный клик по чипу «beta» в Списке → фильтр по тегу
      await k.click(rowSel(W.three) + ' .tk-ltag[data-v="beta"]'); await sleep(600);
      const fb = await S('({ view: S.view, f: Object.assign({}, S.filters), sel: S.selectedId, sel2: document.querySelector("[data-tk-filter=label]").value, ids: [...document.querySelectorAll("#tasksView tr.tk-row")].map(r => r.dataset.id) })');
      C.check(tag + ' W-4 клик по чипу «beta» в Списке → фильтр «Метка = beta» (select показывает beta), карточка не открыта, видны ровно задачи с этим тегом (3: «Alpha, beta…», «beta, Gamma…» + ранее созданные? — ' + fb.ids.length + ')',
        fb.view === 'list' && fb.f.label === 'beta' && fb.sel2 === 'beta' && !fb.sel && fb.ids.indexOf(W.three) >= 0 && fb.ids.indexOf(W.pair) >= 0 && fb.ids.indexOf(W.edit) < 0 && fb.ids.length === 2, JSON.stringify(fb));
      await k.shot('W4_filter_by_tag_click_' + tag);
      const opts = await ev(`[...document.querySelectorAll('[data-tk-filter=label] option')].map(o => o.value).filter(Boolean)`);
      const srt = opts.slice().sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
      C.check(tag + ' W-4 фильтр «Метка»: отдельные теги, уникальные, по алфавиту: ' + opts.join(', '), opts.join('|') === srt.join('|') && opts.every((o) => o.indexOf(',') < 0) && new Set(opts.map((o) => o.toLowerCase())).size === opts.length && opts.length >= 8, opts.join('|'));
      // выбор в select (регистр не важен для «gamma» — тег «Gamma»)
      await ev(`(() => { const s = document.querySelector('[data-tk-filter=label]'); s.value = 'Gamma'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(400);
      C.check(tag + ' W-4 выбор «Gamma» в фильтре → только задача с этим тегом', (await S('[...document.querySelectorAll("#tasksView tr.tk-row")].map(r => r.dataset.id).join()')) === W.pair);
      await k.click('[data-tk-act="resetFilters"]'); await sleep(300);

      // ================= W-3: Доска =================
      await openTasks('board');
      const bt = await ev(`(() => { const c = document.querySelector('.tk-card[data-id="${W.three}"]'); const sub = c.querySelector('.tk-sub'); return { names: [...sub.querySelectorAll('[data-tk-act="filterEmp"]')].map(e => e.textContent), text: sub.textContent, title: sub.title, tags: [...c.querySelectorAll('.tk-ltag')].map(e => e.textContent) }; })()`);
      C.note('boardTile_' + tag, bt);
      C.check(tag + ' W-3 Доска: 3 исполнителя → 2 ФИО-кнопки и «…» после второго, третьего ФИО в плитке нет; title = полный список (3)', bt.names.length === 2 && /…/.test(bt.text) && bt.text.indexOf('Смирнова') < 0 && /^Исполнители: .*Козлов.*Орлова.*Смирнова/.test(bt.title), JSON.stringify(bt));
      C.check(tag + ' W-3/W-4 теги плитки Доски — отдельные чипы: ' + bt.tags.join(', '), bt.tags.join('|') === 'Alpha|beta|срочно', bt.tags.join('|'));
      const bp = await ev(`(() => { const sub = document.querySelector('.tk-card[data-id="${W.pair}"] .tk-sub'); return { n: sub.querySelectorAll('[data-tk-act="filterEmp"]').length, dots: /…/.test(sub.textContent), title: sub.title }; })()`);
      C.check(tag + ' W-3 Доска: 2 исполнителя — оба, без «…», без title-списка', bp.n === 2 && !bp.dots && bp.title === '', JSON.stringify(bp));
      await k.shotEl('.tk-card[data-id="' + W.three + '"]', 'W3_tile_three_assignees_' + tag, { scale: 2 });
      await k.shotEl('.tk-card[data-id="' + W.pair + '"]', 'W3_tile_two_assignees_' + tag, { scale: 2 });
      await k.shotEl('.tk-split-board', 'W3_board_two_names_' + tag, { maxH: 800 });
      await k.click('.tk-card[data-id="' + W.three + '"] .tk-sub [data-tk-act="filterEmp"]'); await sleep(600);
      C.check(tag + ' W-3 реальный клик по первому ФИО плитки → «Список» по сотруднику (V6-5 сохранён)', (await S('S.view === "list" && S.filters.emp === "emp_105" && !S.selectedId')), '');
      // клик по тегу плитки Доски → Список с фильтром
      await openTasks('board');
      await k.click('.tk-card[data-id="' + W.three + '"] .tk-ltag[data-v="срочно"]'); await sleep(600);
      const fc = await S('({ view: S.view, label: S.filters.label, ids: [...document.querySelectorAll("#tasksView tr.tk-row")].map(r => r.dataset.id) })');
      C.check(tag + ' W-4 R-12: реальный клик по тегу «срочно» в плитке Доски → «Список», фильтр label=срочно, 1 задача', fc.view === 'list' && fc.label === 'срочно' && fc.ids.join() === W.three, JSON.stringify(fc));
      // карточка: все 3 исполнителя, теги-чипы
      await openTasks('board', { taskId: W.three });
      const dc = await ev(`(() => { const d = document.querySelector('.tk-detail'); const kv = [...d.querySelectorAll('.tk-kv')].find(x => /Исполнители/.test(x.textContent)); return { names: kv.querySelectorAll('[data-tk-act="filterEmp"]').length, dots: /…/.test(kv.textContent), tags: [...d.querySelectorAll('.tk-ltag')].map(e => e.textContent) }; })()`);
      C.check(tag + ' W-3/W-4 карточка задачи: все 3 исполнителя без «…»; теги — 3 чипа', dc.names === 3 && !dc.dots && dc.tags.join('|') === 'Alpha|beta|срочно', JSON.stringify(dc));
      await k.shot('W3_card_all_assignees_' + tag);
      await k.click('.tk-detail .tk-ltag[data-v="Alpha"]'); await sleep(500);
      C.check(tag + ' W-4 реальный клик по тегу в карточке → «Список» по тегу «Alpha»', (await S('S.view === "list" && S.filters.label === "Alpha"')) && (await S('document.querySelectorAll("#tasksView tr.tk-row").length')) === 2, '');
      await openTasks('list'); await k.click('[data-tk-act="resetFilters"]');
      // создание новой задачи с тегами через ✎-путь «+ Новая задача»
      await k.click('[data-tk-act="newTask"]'); await sleep(400);
      await k.click('#tasksView [data-tk-field="title"]'); await typeText('W62 Новая с тегами');
      await ev(`(() => { const s = document.querySelector('[data-tk-field=assigneePick]'); s.value = 'emp_106'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(300);
      await k.click('#tasksView [data-tk-field="labelInput"]');
      await typeText('Новая'); await press('Enter'); await typeText('метка'); await press(','); await typeText('Новая'); await press('Enter');
      await k.click('[data-tk-act="saveForm"]'); await sleep(1200);
      const nt = (await api(ck, 'api/tasks.php')).tasks.find((x) => x.title === 'W62 Новая с тегами');
      C.check(tag + ' W-4 создание с тегами из формы: сохранено «Новая, метка» (дубль не записан), labels[2]', nt && nt.label === 'Новая, метка' && nt.labels.length === 2, nt && nt.label);
      await k.shot('W4_created_task_list_' + tag);
    }

    // ================= supervisor / viewer =================
    for (const [role, cookies] of [['supervisor', supCookies], ['viewer', viewCookies]]) {
      for (const [w, h, mob, tag] of [[1280, 900, false, '1280'], [375, 2200, true, '375']].filter((v) => !process.env.ONLY || process.env.ONLY === v[3])) {
        console.log('=== viewport ' + tag + ' ' + role);
        await loadAs(cookies, w, h, mob);
        await openTasks('list');
        const ro = await ev(`(() => ({ th: [...document.querySelectorAll('#tasksView thead th')].map(x => x.textContent.replace(/[↕↑↓]/g, '').trim()), edit: document.querySelectorAll('#tasksView .tk-editbtn, #tasksView .tk-c-edit').length, ro: !!document.querySelector('.tk-ro'), chips: document.querySelectorAll('#tasksView tr.tk-row .tk-ltag').length, newBtn: !!document.querySelector('[data-tk-act=newTask]') }))()`);
        C.check(tag + ' ' + role + ' W-1/W-2 колонки: Задача|Описание|Исполнитель|Срок|Приор.|Статус; колонки/кнопок «Править» и «+ Новая задача» нет; «только просмотр»', ro.th.join('|') === 'Задача|Описание|Исполнитель|Срок|Приор.|Статус' && ro.edit === 0 && ro.ro && !ro.newBtn, JSON.stringify(ro));
        await k.shotEl('#tasksView .tk-tablewrap', 'R_' + role + '_list_' + tag, { maxH: 700 });
        // чип-фильтр работает и без прав записи (реальный клик)
        const t0 = await ev(`(() => { const c = document.querySelector('#tasksView tr.tk-row .tk-ltag'); return c ? { id: c.closest('tr').dataset.id, v: c.dataset.v } : null; })()`);
        await k.click('#tasksView tr.tk-row .tk-ltag'); await sleep(500);
        const rf = await S('({ view: S.view, label: S.filters.label, form: !!S.form, tagsbox: !!document.querySelector("[data-tk-tagsbox]") })');
        C.check(tag + ' ' + role + ' W-4 клик по тегу-чипу «' + (t0 && t0.v) + '» → фильтр по тегу, формы/поля-тегов нет', t0 && rf.view === 'list' && rf.label === t0.v && !rf.form && !rf.tagsbox, JSON.stringify(rf));
        const pre = await S('S.tasks.length');
        await ev('window.Tasks.__t.ACTIONS.editTask({ dataset: { id: "' + W.edit + '" } }, { stopPropagation() {} })'); await sleep(300);
        C.check(tag + ' ' + role + ' принудительный вызов editTask формы не открывает', !(await S('!!S.form')) && !(await ev('!!document.querySelector("#tasksView [data-tk-field=labelInput]")')), '');
        await openTasks('board');
        const rb = await ev(`(() => { const sub = document.querySelector('.tk-card[data-id="${W.three}"] .tk-sub'); return { n: sub.querySelectorAll('[data-tk-act="filterEmp"]').length, dots: /…/.test(sub.textContent), title: sub.title, drag: !!document.querySelector('.tk-card[draggable]') }; })()`);
        C.check(tag + ' ' + role + ' W-3 Доска: 2 ФИО + «…» + title; карточки не draggable', rb.n === 2 && rb.dots && /^Исполнители: /.test(rb.title) && !rb.drag, JSON.stringify(rb));
        await k.shotEl('.tk-split-board', 'R_' + role + '_board_' + tag, { maxH: 700 });
      }
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
