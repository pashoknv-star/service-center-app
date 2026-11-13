// V6.3-1 (вне gate): реальный Chromium — И-1 «не больше 2 исполнителей + …» в Списке и на Доске, И-2 пропорция колонок Списка.
// Запуск: node scripts/v63_1_accept.js            → проверки ПОСЛЕ правки; reports/V6_3/V6.3-1_screens/*.png, V63_1_results_after.json
//         MODE=before node scripts/v63_1_accept.js → только замеры ДО правки (на коде без И-1/И-2), V63_1_results_before.json
// ONLY=1280|375 — один вьюпорт. Каркас — v6_accept_lib.js / v6_accept_seed.js (php -S на КОПИИ data/app.db; пароли в браузер не вводятся).
// Реальные события: мышь (Input.dispatchMouseEvent).
'use strict';
const path = require('path'), fs = require('fs');
const L = require('./v6_accept_lib.js');
const { seed, D } = require('./v6_accept_seed.js');
const MODE = process.env.MODE === 'before' ? 'before' : 'after';
const OUT = path.join(L.ROOT, 'reports/V6_3/V6.3-1_screens');
fs.mkdirSync(OUT, { recursive: true });
const sleep = L.sleep;
const pfx = MODE === 'before' ? 'before_' : '';

(async () => {
  const env = await L.startEnv();
  const C = L.makeChecker(path.join(OUT, 'V63_1_results_' + MODE + '.json'));
  try {
    const s = await seed(env);
    const ck = s.adminCookies.join('; ');
    const supCookies = await L.login(env.base, 'supervisor_zone0'), viewCookies = await L.login(env.base, 'viewer_test');
    const mk = async (title, assignees, day) => {
      const r = await L.http(env.base, ck, 'POST', 'api/tasks.php', { title, start_at: D(day) + 'T10:00', end_at: D(day) + 'T11:00', assignees, description: 'Описание для ' + title });
      if (r.status !== 201) throw new Error('mk ' + title + ' → ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      return r.json.task.id;
    };
    // 1 / 2 / 3 / 5 исполнителей; 3 — первый в отпуске (D(2)) → «!»
    const N = { a1: ['emp_105'], a2: ['emp_105', 'emp_106'], a3: ['emp_101', 'emp_106', 'emp_107'], a5: ['emp_105', 'emp_106', 'emp_107', 'emp_1', 'emp_2'] };
    const W = {};
    W.a1 = await mk('V63 Один исполнитель', N.a1, 6);
    W.a2 = await mk('V63 Два исполнителя', N.a2, 6);
    W.a3 = await mk('V63 Три исполнителя', N.a3, 2);
    W.a5 = await mk('V63 Пять исполнителей', N.a5, 6);

    const { cdp, version } = await env.openBrowser();
    C.note('browser', version);
    const k = L.pageKit(cdp, env.base, OUT);
    const ev = (x) => cdp.ev(x);
    const S = (expr) => ev('(() => { const S = window.Tasks.__t.S; return ' + expr + '; })()');
    const openTasks = async (view) => {
      await ev('window.Tasks.open(' + JSON.stringify({ employeeId: '', date: D(2), view, mode: 'week' }) + ')');
      await k.waitFor('!window.Tasks.__t.S.loading && !!document.querySelector("#tasksView")', 20000); await sleep(500);
    };
    const loadAs = async (cookies, w, h, mob) => {
      await k.size(w, h, mob);
      await k.load(cookies);
      await ev('document.getElementById("vacationTrigger").click()'); await sleep(600);
      await k.click('#tabTasks'); await sleep(1500);
      await k.waitFor('!window.Tasks.__t.S.loading', 20000);
    };
    const rowSel = (id) => '#tasksView tr.tk-row[data-id="' + id + '"]';
    // замер таблицы Списка: ширина таблицы, колонки, высоты строк (по названию задачи)
    const measure = () => ev(`(() => { const t = document.querySelector('#tasksView .tk-table'), tw = document.querySelector('#tasksView .tk-tablewrap');
      const th = [...t.querySelectorAll('thead th')]; const r1 = (x) => Math.round(x * 10) / 10;
      const rows = {}, cont = {}; [...t.querySelectorAll('tbody tr.tk-row')].forEach((tr) => { const ch = (td) => { const rg = document.createRange(); rg.selectNodeContents(td); return r1(rg.getBoundingClientRect().height); };
        rows[tr.querySelector('td.tk-c-task b').textContent] = r1(tr.getBoundingClientRect().height); cont[tr.querySelector('td.tk-c-task b').textContent] = { exec: ch(tr.querySelector('td.tk-c-exec')), desc: ch(tr.querySelector('td.tk-desc')), task: ch(tr.querySelector('td.tk-c-task')) }; });
      return { wrap: tw.clientWidth, scrollW: tw.scrollWidth, table: r1(t.getBoundingClientRect().width), layout: getComputedStyle(t).tableLayout,
        cols: th.map((x) => [x.textContent.replace(/[↕↑↓]/g, '').trim(), r1(x.getBoundingClientRect().width)]), rows, cont }; })()`);

    const shotList = async (name, top, left) => { await ev('(() => { const tw = document.querySelector("#tasksView .tk-tablewrap"); tw.scrollIntoView({block: "start"}); tw.scrollTop = ' + (top === 'end' ? 'tw.scrollHeight' : top) + '; tw.scrollLeft = ' + (left || 0) + '; })()'); await sleep(400); await k.shot(name); };
    const vps = [[1280, 900, false, '1280'], [375, 2200, true, '375']].filter((v) => !process.env.ONLY || process.env.ONLY === v[3]);
    for (const [w, h, mob, tag] of vps) {
      console.log('=== viewport ' + tag + ' admin (' + MODE + ')');
      await loadAs(s.adminCookies, w, h, mob);
      await openTasks('list');
      const m = await measure();
      C.note('measure_' + tag, m);
      console.log('  ' + JSON.stringify(m.cols) + ' table=' + m.table + ' wrap=' + m.wrap + ' scrollW=' + m.scrollW);
      await shotList(pfx + 'I2_list_columns_' + tag, 0, 0); if (tag === '375') await shotList(pfx + 'I2_list_columns_375_scrolled', 0, 330);
      if (MODE === 'before') continue;

      // ================= И-2: пропорция колонок =================
      const col = (n) => (m.cols.find((c) => c[0] === n) || [0, 0])[1];
      const BEF = JSON.parse(fs.readFileSync(path.join(OUT, 'V63_1_results_before.json'), 'utf8'))['measure_' + tag];
      const bcol = (n) => (BEF.cols.find((c) => c[0] === n) || [0, 0])[1];
      if (tag === '1280') {
        C.check(tag + ' И-2 «Исполнитель»: ' + bcol('Исполнитель') + ' → ' + col('Исполнитель') + ' px (= ×1,5 = 192)', Math.abs(col('Исполнитель') - 192) <= 1 && Math.abs(col('Исполнитель') / bcol('Исполнитель') - 1.5) < 0.01, JSON.stringify(m.cols));
        C.check(tag + ' И-2 общая ширина таблицы неизменна: ' + BEF.table + ' → ' + m.table + ' px', Math.abs(BEF.table - m.table) <= 1, '');
        const oth = m.cols.filter((c) => !['Исполнитель', 'Описание', 'Задача'].includes(c[0]));
        C.check(tag + ' И-2 остальные колонки без изменений — ' + oth.map((c) => c[0] + ' ' + bcol(c[0]) + '→' + c[1]).join(', '), oth.every((c) => Math.abs(c[1] - bcol(c[0])) <= 1), JSON.stringify(m.cols));
        C.check(tag + ' И-2 «Задача» закреплена на 193 px (естественная ширина в автораскладке зависит от заголовков: на этих данных ДО ' + bcol('Задача') + ' px): ' + col('Задача') + ' px; Задача+Описание: ' + Math.round((bcol('Задача') + bcol('Описание')) * 10) / 10 + ' → ' + Math.round((col('Задача') + col('Описание')) * 10) / 10 + ' (−64 = прибавка «Исполнителя»)',
          Math.abs(col('Задача') - 193) <= 1 && Math.abs((bcol('Задача') + bcol('Описание')) - (col('Задача') + col('Описание')) - 64) <= 1, JSON.stringify(m.cols));
        C.check(tag + ' И-2 «Описание» = ' + col('Описание') + ' px (цель 233 = 297 − 64 при замере V6.2-1)', Math.abs(col('Описание') - 233) <= 1.5, JSON.stringify(m.cols));
        // высота строк с ≤ 2 исполнителями не выросла
        const keys = ['V63 Один исполнитель', 'V63 Два исполнителя', 'Совещание у директора', 'Обед с партнёрами', 'Планёрка отдела'];
        // строка не вырастает «из-за ФИО»: ФИО-блок не выше прежнего; рост строки возможен только от более узкого «Описания» (требование И-2)
        const fioGrew = keys.filter((n) => m.cont[n].exec > BEF.cont[n].exec + 0.5);
        const fioDrives = keys.filter((n) => m.cont[n].exec > Math.max(m.cont[n].desc, m.cont[n].task) + 0.5 && m.rows[n] > BEF.rows[n] + 0.5);
        C.note('rowHeights_1280', keys.map((n) => ({ n, row: [BEF.rows[n], m.rows[n]], exec: [BEF.cont[n].exec, m.cont[n].exec], desc: [BEF.cont[n].desc, m.cont[n].desc], task: [BEF.cont[n].task, m.cont[n].task] })));
        C.check(tag + ' И-2 ФИО-блок строк с ≤2 исполнителями не выше прежнего (' + keys.map((n) => n.slice(0, 14) + ' ' + BEF.cont[n].exec + '→' + m.cont[n].exec).join('; ') + '), ФИО не определяют высоту выросших строк', fioGrew.length === 0 && fioDrives.length === 0, fioGrew.concat(fioDrives).join());
        C.check(tag + ' (инфо) высоты строк ДО→ПОСЛЕ: ' + keys.map((n) => n.slice(0, 14) + ' ' + BEF.rows[n] + '→' + m.rows[n]).join('; '), true);
      } else {
        C.check(tag + ' И-2 375: горизонтальная прокрутка (scrollWidth ' + m.scrollW + ' > окно ' + m.wrap + '), «Исполнитель» ' + col('Исполнитель') + ' px, таблица ' + m.table + ' (было ' + BEF.table + ')', m.scrollW > m.wrap + 50 && Math.abs(col('Исполнитель') - 192) <= 1, JSON.stringify(m));
        C.check(tag + ' И-2 375: общая ширина таблицы изменилась не более чем на разницу колонок (' + BEF.table + ' → ' + m.table + ')', Math.abs((m.table - BEF.table) - ((col('Исполнитель') - bcol('Исполнитель')) + (col('Описание') - bcol('Описание')))) <= 1, '');
      }
      const stick = await ev(`(() => { const tw = document.querySelector('#tasksView .tk-tablewrap'); tw.scrollTop = 80; const r = tw.getBoundingClientRect(), t = document.querySelector('#tasksView .tk-table thead th').getBoundingClientRect(); return { sc: tw.scrollTop, dy: Math.round(t.top - r.top), pos: getComputedStyle(document.querySelector('#tasksView .tk-table thead th')).position, can: tw.scrollHeight > tw.clientHeight }; })()`);
      C.check(tag + ' И-2 шапка sticky', stick.pos === 'sticky' && (!stick.can || (stick.sc > 0 && Math.abs(stick.dy) <= 2)), JSON.stringify(stick));
      await ev('document.querySelector("#tasksView .tk-tablewrap").scrollTop = 0');

      // ================= И-1: Список =================
      const cell = (id) => ev(`(() => { const td = document.querySelector('${rowSel(id)} td.tk-c-exec'); const names = [...td.querySelectorAll('[data-tk-act="filterEmp"]')];
        const more = td.querySelector('.tk-more'); const mr = more && more.getBoundingClientRect(); const lastName = names[names.length - 1] && [...names[names.length - 1].getClientRects()].pop();
        const cs = more && getComputedStyle(more);
        return { names: names.map((n) => n.textContent), text: td.textContent, more: more ? more.textContent : null, title: td.title || (more && more.title) || '', warn: td.querySelectorAll('.tk-warnico').length,
          gap: more && lastName ? (mr.top >= lastName.bottom - 2 ? 'новая строка' : Math.round((mr.left - lastName.right) * 10) / 10) : null, moreBg: cs ? cs.backgroundColor : null, moreH: mr ? Math.round(mr.height) : null,
          h: Math.round(td.getBoundingClientRect().height), tdw: Math.round(td.getBoundingClientRect().width) }; })()`);
      const c1 = await cell(W.a1), c2 = await cell(W.a2), c3 = await cell(W.a3), c5 = await cell(W.a5);
      C.note('execCells_' + tag, { c1, c2, c3, c5 });
      C.check(tag + ' И-1 Список, 1 исполнитель: 1 ФИО, без «…»', c1.names.length === 1 && c1.more === null, JSON.stringify(c1));
      C.check(tag + ' И-1 Список, 2 исполнителя: 2 ФИО, без «…», без общего title', c2.names.length === 2 && c2.more === null && !c2.title, JSON.stringify(c2));
      C.check(tag + ' И-1 Список, 3 исполнителя: 2 ФИО + «…», третьего нет в тексте, «!» у первого (отпуск) на месте', c3.names.length === 2 && c3.more === '…' && c3.text.indexOf('Смирнова') < 0 && c3.warn === 1, JSON.stringify(c3));
      C.check(tag + ' И-1 Список, 5 исполнителей: 2 ФИО + «…»; title — все 5', c5.names.length === 2 && c5.more === '…' && /^Исполнители: /.test(c5.title) && c5.title.split(', ').length === 5, JSON.stringify(c5));
      C.check(tag + ' И-1 «…» отделено от ФИО: зазор ' + c5.gap + ' px, свой фон ' + c5.moreBg + ' (чип), а не часть фамилии', (c5.gap === 'новая строка' || c5.gap >= 4) && c5.moreBg && c5.moreBg !== 'rgba(0, 0, 0, 0)', JSON.stringify(c5));
      const th5 = await ev(`(() => { const td = document.querySelector('${rowSel(W.a5)} td.tk-c-exec'); const m = td.querySelector('.tk-more'); m.scrollIntoView({block:'center'}); const r = m.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { hit: el && (el === m || m.contains(el) || td.contains(el)), title: (el && el.closest('[title]') || {}).title || '' }; })()`);
      C.check(tag + ' И-1 подсказка «…» в точке курсора содержит всех 5', th5.hit && th5.title.split(', ').length === 5, JSON.stringify(th5));
      await shotList('I1_list_executors_' + tag, 'end', tag === '375' ? 330 : 0);
      // клик по ФИО → фильтр по сотруднику (R-14); «…» не фильтрует
      await k.click(rowSel(W.a5) + ' td.tk-c-exec [data-tk-act="filterEmp"]', 1); await sleep(500);
      const f5 = await S('({ view: S.view, emp: S.filters.emp })');
      C.check(tag + ' И-1 реальный клик по второму ФИО → Список с фильтром emp_106', f5.view === 'list' && f5.emp === 'emp_106', JSON.stringify(f5));
      await openTasks('list'); await ev('window.Tasks.__t.S.filters.emp=""; window.Tasks.open({employeeId:"",date:"' + D(2) + '",view:"list",mode:"week"})'); await sleep(500);
      await k.click(rowSel(W.a5) + ' td.tk-c-exec .tk-more'); await sleep(400);
      const fm = await S('({ view: S.view, emp: S.filters.emp, sel: S.selectedId })');
      C.check(tag + ' И-1 клик по «…» открывает карточку задачи (как клик по строке), фильтр не ставится', fm.sel === W.a5 && !fm.emp, JSON.stringify(fm));
      const det = await ev(`(() => { const d = document.querySelector('#tasksView .tk-detail'); const kv = d && [...d.querySelectorAll('.tk-kv')].find((x) => /Исполнители/.test(x.textContent)); return kv ? [...kv.querySelectorAll('[data-tk-act="filterEmp"]')].length : -1; })()`);
      C.check(tag + ' И-1 карточка задачи — все 5 исполнителей, без «…»', det === 5, det);
      await k.shot('I1_card_all_executors_' + tag);

      // ================= И-1: Доска =================
      await openTasks('board');
      const bc = (id) => ev(`(() => { const c = document.querySelector('#tasksView .tk-card[data-id="${id}"] .tk-sub'); const more = c.querySelector('.tk-more'); const names = [...c.querySelectorAll('[data-tk-act="filterEmp"]')];
        const lastName = [...names[names.length - 1].getClientRects()].pop(), mr = more && more.getBoundingClientRect(); return { names: names.length, more: more ? more.textContent : null, title: c.title, gap: mr ? (mr.top >= lastName.bottom - 2 ? 'новая строка' : Math.round((mr.left - lastName.right) * 10) / 10) : null, bg: more && getComputedStyle(more).backgroundColor }; })()`);
      const b3 = await bc(W.a3), b5 = await bc(W.a5), b2 = await bc(W.a2);
      C.check(tag + ' И-1 Доска: 3 → 2 ФИО + «…» (отделено, зазор ' + b3.gap + ' px), title — все; 2 → без «…»', b3.names === 2 && b3.more === '…' && (b3.gap === 'новая строка' || b3.gap >= 4) && b3.bg !== 'rgba(0, 0, 0, 0)' && /^Исполнители: /.test(b3.title) && b2.names === 2 && b2.more === null, JSON.stringify([b2, b3]));
      C.check(tag + ' И-1 Доска: 5 → 2 ФИО + «…», title — все 5 (общий код со Списком)', b5.names === 2 && b5.more === '…' && b5.title.split(', ').length === 5, JSON.stringify(b5));
      await k.shotEl('#tasksView .tk-split-board', 'I1_board_executors_' + tag, { maxH: 900 });
      await k.click('#tasksView .tk-card[data-id="' + W.a5 + '"] .tk-sub [data-tk-act="filterEmp"]', 0); await sleep(500);
      const bf = await S('({ view: S.view, emp: S.filters.emp })');
      C.check(tag + ' И-1 Доска: клик по первому ФИО → Список по сотруднику emp_105', bf.view === 'list' && bf.emp === 'emp_105', JSON.stringify(bf));
    }

    // ================= роли: supervisor / viewer =================
    if (MODE === 'after') {
      for (const [role, cookies] of [['supervisor', supCookies], ['viewer', viewCookies]]) {
        for (const [w, h, mob, tag] of vps) {
          console.log('=== viewport ' + tag + ' ' + role);
          await loadAs(cookies, w, h, mob);
          await openTasks('list');
          const m = await measure();
          const col = (n) => (m.cols.find((c) => c[0] === n) || [0, 0])[1];
          C.note('measure_' + role + '_' + tag, m);
          const c5 = await ev(`(() => { const td = document.querySelector('${rowSel(W.a5)} td.tk-c-exec'); return { names: td.querySelectorAll('[data-tk-act="filterEmp"]').length, more: !!td.querySelector('.tk-more'), title: td.title }; })()`);
          C.check(role + ' ' + tag + ' Список: колонок ' + m.cols.length + ' (без «Править»), «Исполнитель» ' + col('Исполнитель') + ' px, 5 исполнителей → 2 ФИО + «…» с title',
            m.cols.length === 6 && Math.abs(col('Исполнитель') - 192) <= 1 && c5.names === 2 && c5.more && /^Исполнители: /.test(c5.title), JSON.stringify([m.cols, c5]));
          if (tag === '1280') {
            await k.click(rowSel(W.a5) + ' td.tk-c-exec [data-tk-act="filterEmp"]', 0); await sleep(500);
            const f = await S('({ view: S.view, emp: S.filters.emp })');
            C.check(role + ' ' + tag + ' клик по ФИО → фильтр работает (без прав записи)', f.view === 'list' && f.emp === 'emp_105', JSON.stringify(f));
            await openTasks('list');
          }
          await shotList('R_' + role + '_list_' + tag, 'end', tag === '375' ? 330 : 0);
        }
      }
    }
    C.check('в консоли страницы нет исключений', cdp.exceptions.length === 0, cdp.exceptions.join('\n'));
  } catch (e) {
    console.log('ОШИБКА СКРИПТА', e.stack || e); C.failed++; C.res.error = String(e.stack || e).slice(0, 600);
  } finally {
    C.save(); env.cleanup();
    console.log('RESULT ' + MODE + ': ' + C.passed + ' passed, ' + C.failed + ' failed');
    process.exit(C.failed ? 1 : 0);
  }
})();
