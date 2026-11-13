// V6-4 (приёмка, вне gate): B — «Задачи»: Список, Доска, карточка, Календарь, форма; стыки веток.
// Запуск: node scripts/v6_accept_b_tasks.js  → reports/V6/V6-4_screens/B_*.png, B_results.json
'use strict';
const path = require('path'), fs = require('fs');
const L = require('./v6_accept_lib.js');
const { seed, D } = require('./v6_accept_seed.js');
const OUT = path.join(L.ROOT, 'reports/V6/V6-4_screens');
fs.mkdirSync(OUT, { recursive: true });
const sleep = L.sleep;

(async () => {
  const env = await L.startEnv();
  const C = L.makeChecker(path.join(OUT, 'B_results.json'));
  try {
    const s = await seed(env);
    const T = s.T;
    const { cdp, version } = await env.openBrowser();
    C.note('browser', version);
    const k = L.pageKit(cdp, env.base, OUT);
    const ev = (x) => cdp.ev(x);
    const openTasks = async (view, extra) => {
      await ev('window.Tasks.open(' + JSON.stringify(Object.assign({ employeeId: '', date: D(2), view, mode: 'week' }, extra || {})) + ')');
      await k.waitFor('!window.Tasks.__t.S.loading && !!document.querySelector("#tasksView")', 20000); await sleep(500);
    };
    const S = (expr) => ev('(() => { const S = window.Tasks.__t.S; return ' + expr + '; })()');
    const luminance = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const contrast = (a, b) => { const l1 = luminance(a), l2 = luminance(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

    for (const vp of [[1280, 900, false, '1280'], [375, 740, true, '375']].filter((v) => !process.env.ONLY || process.env.ONLY === v[3])) {
      const [w, h, mob, tag] = vp; const HH = tag === '1280' ? 14 : 18;
      console.log('=== viewport ' + tag);
      await k.size(w, h, mob);
      await k.load(s.adminCookies);
      await ev('document.getElementById("vacationTrigger").click()'); await sleep(600);
      await k.click('#tabTasks'); await sleep(1500);
      await k.waitFor('!window.Tasks.__t.S.loading', 20000);

      // ======================= СПИСОК
      await openTasks('list');
      const li = await ev(`(() => {
        const th = document.querySelector('#tasksView .tk-table th'), td = document.querySelector('#tasksView .tk-table tbody tr td');
        const cth = getComputedStyle(th), ctd = getComputedStyle(td);
        const rows = [...document.querySelectorAll('#tasksView .tk-table tbody tr')];
        const heads = [...document.querySelectorAll('#tasksView .tk-table th')].map(e => e.textContent.trim());
        const byTitle = (t) => rows.find(r => r.querySelector('td b') && r.querySelector('td b').textContent.indexOf(t) === 0);
        const warn = (t) => { const r = byTitle(t); if (!r) return 'нет строки'; const w = r.querySelector('.tk-warnico'); return w ? { text: w.textContent, title: w.title } : null; };
        const evenA = rows[0] && getComputedStyle(rows[0]).backgroundColor, evenB = rows[1] && getComputedStyle(rows[1]).backgroundColor;
        const desc = byTitle('Совещание у директора').children[2];
        return { heads, thFont: cth.fontWeight, thBg: cth.backgroundColor, thColor: cth.color, thPos: cth.position, thBorder: cth.borderBottomWidth, tdFont: ctd.fontWeight, tdBg: ctd.backgroundColor, tdColor: ctd.color,
          zebra: [evenA, evenB], n: rows.length,
          warnDir: warn('Совещание у директора'), warnSick: warn('Задача на больничном'), warnPlain: warn('Планирование без отпуска'), warnPlan: warn('Планёрка отдела'),
          descText: desc.textContent, descTitle: desc.title || (desc.firstElementChild && desc.firstElementChild.title) || '',
          htmlInjected: document.querySelectorAll('#tasksView .tk-table b > b, #tasksView .tk-table i, #tasksView .tk-table script').length,
          xssRowText: (byTitle('Тема') || {}).textContent || '', rowOrderTitles: rows.map(r => r.querySelector('td b').textContent.slice(0, 14)) };
      })()`);
      console.log(JSON.stringify(li).slice(0, 1500));
      C.note('list_' + tag, li);
      C.check(tag + ' R-16 колонки Списка: Задача, Исполнитель, Описание, Срок, Приор., Статус', /Задача.*Исполнитель.*Описание.*Срок.*Приор.*Статус/.test(li.heads.join('|').replace(/\|/g, ' ')), li.heads.join('|'));
      C.check(tag + ' R-5 шапка: жирная (≥600), фон отличается от строк, граница 2px, sticky, контраст ≥4.5', +li.thFont >= 600 && li.thBg !== li.tdBg && parseFloat(li.thBorder) >= 2 && li.thPos === 'sticky' && contrast(li.thColor, li.thBg) >= 4.5, JSON.stringify([li.thFont, li.thBg, li.tdBg, li.thBorder, li.thPos, contrast(li.thColor, li.thBg)]));
      C.check(tag + ' R-5 шрифт шапки заметно выразительнее строк (700 против ≤500)', +li.thFont > +li.tdFont || +li.thFont >= 700, JSON.stringify([li.thFont, li.tdFont]));
      C.check(tag + ' R-5 зебра: соседние строки разных оттенков', li.zebra[0] !== li.zebra[1], JSON.stringify(li.zebra));
      C.check(tag + ' R-8 «!» у директора в отпуске (с причиной и датами в подсказке)', li.warnDir && li.warnDir.text.trim() === '!' && /отпуск 18\.11/.test(li.warnDir.title), JSON.stringify(li.warnDir));
      C.check(tag + ' R-8 «!» у сотрудника с больничным (20.11)', li.warnSick && /больничный 20\.11/.test(li.warnSick.title), JSON.stringify(li.warnSick));
      C.check(tag + ' R-8 нет «!» у исполнителя без отпуска/больничного', li.warnPlain === null, JSON.stringify(li.warnPlain));
      C.check(tag + ' R-16 описание обрезано (≤80 + «…»), полный текст в подсказке', li.descText.length <= 81 && /…$/.test(li.descText) && li.descTitle.length > 100, JSON.stringify([li.descText.length, li.descTitle.length]));
      C.check(tag + ' экранирование: теги в теме/метке выведены текстом, DOM не внедрён', li.htmlInjected === 0 && /<b>x<\/b>/.test(li.xssRowText), li.xssRowText + '|' + li.htmlInjected);
      await k.shot('B01_list_' + tag);
      // R-17 сортировка: реальные клики по заголовкам
      const prio = () => ev(`[...document.querySelectorAll('#tasksView .tk-table tbody tr')].map(r => r.children[4].textContent.trim())`);
      const stat = () => ev(`[...document.querySelectorAll('#tasksView .tk-table tbody tr')].map(r => r.children[5].textContent.trim())`);
      const rank = { 'высокий': 1, 'обычный': 2, 'низкий': 3 };
      const base0 = await prio();
      await k.clickText('#tasksView .tk-table th', 'Приор.'); await sleep(300);
      const p1 = await prio(); const a1 = await ev('document.querySelector("#tasksView .tk-table th[aria-sort]") && document.querySelector("#tasksView .tk-table th[aria-sort]").getAttribute("aria-sort")');
      await k.shot('B02_list_sort_priority_asc_' + tag);
      await k.clickText('#tasksView .tk-table th', 'Приор.'); await sleep(300);
      const p2 = await prio(); const a2 = await ev('document.querySelector("#tasksView .tk-table th[aria-sort]") && document.querySelector("#tasksView .tk-table th[aria-sort]").getAttribute("aria-sort")');
      await k.clickText('#tasksView .tk-table th', 'Приор.'); await sleep(300);
      const p3 = await prio(); const a3 = await ev('!document.querySelector("#tasksView .tk-table th[aria-sort]") || document.querySelector("#tasksView .tk-table th[aria-sort]").getAttribute("aria-sort")');
      const sorted = (arr, dir) => arr.every((v, i) => i === 0 || (dir > 0 ? rank[arr[i - 1]] <= rank[v] : rank[arr[i - 1]] >= rank[v]));
      C.check(tag + ' R-17 «Приор.»: клик1 — по возрастанию, клик2 — по убыванию, клик3 — сброс (исходный порядок)', sorted(p1, 1) && sorted(p2, -1) && JSON.stringify(p3) === JSON.stringify(base0) && a1 !== a2, JSON.stringify([p1.join(), p2.join(), a1, a2, a3]));
      await k.clickText('#tasksView .tk-table th', 'Статус'); await sleep(300);
      const s1 = await stat();
      await k.clickText('#tasksView .tk-table th', 'Статус'); await sleep(300);
      const s2 = await stat();
      C.check(tag + ' R-17 «Статус»: сортировка в обе стороны (Открыта/Закрыта группируются)', JSON.stringify(s1) !== JSON.stringify(s2) && s1.join().replace(/Открыта,?/g, 'O').indexOf('OZ') < 0, JSON.stringify([s1, s2]));
      await k.clickText('#tasksView .tk-table th', 'Статус'); await sleep(200);

      // ======================= ДОСКА + КАРТОЧКА
      await openTasks('board');
      await k.click('.tk-card[data-id="' + T.dirmeet + '"]'); await sleep(500);
      const bw = await ev(`(() => { const r = (s) => { const e = document.querySelector(s); if(!e) return null; const b = e.getBoundingClientRect(); return {x:Math.round(b.left),y:Math.round(b.top),w:Math.round(b.width*10)/10,h:Math.round(b.height)}; };
        return { open: r('.tk-col[data-tk-col="open"]'), closed: r('.tk-col[data-tk-col="closed"]'), detail: r('.tk-detail'), orph: r('.tk-sec-orph'), cardW: r('.tk-col[data-tk-col="open"] .tk-card'), cols: getComputedStyle(document.querySelector('.tk-split-board')).gridTemplateColumns }; })()`);
      console.log(JSON.stringify(bw));
      C.note('board_' + tag, bw);
      const eq3 = Math.abs(bw.open.w - bw.closed.w) < 1.5 && Math.abs(bw.open.w - bw.detail.w) < 1.5;
      C.check(tag + ' R-4 Доска: «Открыта», «Закрыта», карточка — одной ширины (' + [bw.open.w, bw.closed.w, bw.detail.w].join('/') + ')', eq3, JSON.stringify(bw));
      if (tag === '1280') C.check('1280 R-4 три колонки в один ряд, секция «⚠ Без исполнителя» над ними во всю ширину', bw.open.y === bw.closed.y && bw.open.y === bw.detail.y && bw.orph && bw.orph.w > bw.open.w * 2.5, JSON.stringify(bw));
      else C.check('375 R-4 колонки друг под другом (столбиком)', bw.closed.y > bw.open.y + 20 && bw.detail.y > bw.closed.y - 5 || bw.detail.y !== bw.open.y, JSON.stringify(bw));
      const card = await ev(`(() => { const d = document.querySelector('.tk-detail'); const btns = [...d.querySelectorAll('button')].map(b => b.textContent.trim());
        const vac = d.querySelector('.tk-note-vac'); const cs = vac && getComputedStyle(vac);
        return { btns, hasReassign: /Переназначить/i.test(d.textContent) || !!document.querySelector('[data-tk-act="reassignTask"]'), vac: vac ? { bg: cs.backgroundColor, img: cs.backgroundImage, color: cs.color, text: vac.textContent, link: !!vac.querySelector('a[data-tk-act="openMatrix"]') } : null }; })()`);
      console.log(JSON.stringify(card));
      C.note('card_' + tag, card);
      C.check(tag + ' R-1 в карточке нет «Переназначить»; «Править» одна; есть «Закрыть», «В архив»', !card.hasReassign && card.btns.filter((b) => b === 'Править').length === 1 && card.btns.includes('Закрыть') && card.btns.includes('В архив'), card.btns.join('|'));
      C.check(tag + ' R-7 пометка отпуска: оранжевая (#ff8a00) + repeating-linear-gradient 45°', card.vac && /rgb\(255, 138, 0\)/.test(card.vac.bg) && /repeating-linear-gradient\(45deg/.test(card.vac.img), JSON.stringify(card.vac));
      await k.shotEl('.tk-detail', 'B03_board_card_vacation_note_' + tag, { maxH: 900 });
      await k.shot('B04_board_' + tag);
      // R-7: параметры штриховки из CSS
      const hatch = await ev(`(() => { const e = document.querySelector('.tk-detail .tk-note-vac'); return getComputedStyle(e).backgroundImage; })()`);
      C.note('hatch_' + tag, hatch);
      // R-15: клик по ФИО в «Пометках» → матрица
      await k.click('.tk-detail .tk-note-vac a[data-tk-act="openMatrix"]'); await sleep(900);
      const mx = await ev(`(() => { const r = document.querySelector('#matrixBody tr.mx-flash'); return { matrixShown: getComputedStyle(document.getElementById('matrixWrapper')).display !== 'none', tabActive: document.getElementById('tabMatrix').classList.contains('active'), row: r ? r.querySelector('.name-col').textContent.trim().slice(0,32) + '|' + r.className : null, tasksHidden: getComputedStyle(document.getElementById('tasksView')).display === 'none', year: document.getElementById('yearDisplay').textContent }; })()`);
      C.check(tag + ' R-15 клик по ФИО в пометке карточки → матрица, строка директора (первая, золотая) подсвечена на дате', mx.matrixShown && mx.tabActive && mx.tasksHidden && mx.row && /Директор Тестов/.test(mx.row) && /matrix-row-director/.test(mx.row), JSON.stringify(mx));
      await k.shot('B05_card_to_matrix_director_' + tag);
      // вернуться в «Задачи»
      await k.click('#tabTasks'); await sleep(1200);
      // R-12: метка из карточки (карточка директора — метка «руководство»)
      await openTasks('board'); await k.click('.tk-card[data-id="' + T.dirmeet + '"]'); await sleep(400);
      const filt = () => S('({ view: S.view, f: S.filters, rows: [...document.querySelectorAll("#tasksView .tk-table tbody tr")].length })');
      await k.click('.tk-detail [data-tk-act="filterBy"][data-f="label"]'); await sleep(500);
      const f12 = await filt();
      C.check(tag + ' R-12 клик по метке в карточке Доски → «Список», фильтр метки = «руководство», остальные пусты', f12.view === 'list' && f12.f.label === 'руководство' && !f12.f.emp && !f12.f.priority && !f12.f.status && f12.rows === 2, JSON.stringify(f12));
      await k.shot('B06_R12_label_to_list_' + tag);
      // R-12 из плитки
      await openTasks('board');
      const tileTag = await ev(`(() => { const c = document.querySelector('.tk-card[data-id="${T.dirmeet}"]'); const t = [...c.querySelectorAll('[data-tk-act="filterBy"]')].map(e => e.dataset.f + '=' + e.dataset.v + ':' + e.textContent.trim()); return t; })()`);
      C.note('tileTags_' + tag, tileTag);
      const clickTile = async (key) => { await openTasks('board'); await k.click('.tk-card[data-id="' + T.dirmeet + '"] [data-tk-act="filterBy"][data-f="' + key + '"]'); await sleep(500); return filt(); };
      let f = await clickTile('label');
      C.check(tag + ' R-12 клик по метке в ПЛИТКЕ Доски → Список с фильтром метки', f.view === 'list' && f.f.label === 'руководство' && !f.f.emp && f.rows === 2, JSON.stringify(f));
      f = await clickTile('priority');
      C.check(tag + ' R-13 клик по приоритету в плитке → Список, фильтр приоритета = высокий (1)', f.view === 'list' && String(f.f.priority) === '1' && !f.f.label && f.rows >= 1, JSON.stringify(f));
      f = await clickTile('status');
      C.check(tag + ' R-13 клик по статусу в плитке → Список, фильтр статуса = Открыта', f.view === 'list' && f.f.status === 'open' && !f.f.label, JSON.stringify(f));
      // из карточки: приоритет и статус
      for (const key of ['priority', 'status']) {
        await openTasks('board'); await k.click('.tk-card[data-id="' + T.dirmeet + '"]'); await sleep(400);
        await k.click('.tk-detail [data-tk-act="filterBy"][data-f="' + key + '"]'); await sleep(500);
        f = await filt();
        C.check(tag + ' R-13 клик по «' + key + '» в карточке → Список, фильтр ' + key, f.view === 'list' && (key === 'priority' ? String(f.f.priority) === '1' : f.f.status === 'open'), JSON.stringify(f));
      }
      // R-14: ФИО из плитки и из карточки
      await openTasks('board');
      const tileHasFio = await ev('!!document.querySelector(\'.tk-card[data-id="' + T.dirmeet + '"] [data-tk-act="filterEmp"]\')');
      C.check(tag + ' R-14 ФИО в ПЛИТКЕ Доски кликабельно (data-tk-act=filterEmp) → Список (отчёт V6-1 заявляет «из плитки»)', tileHasFio, 'в плитке .tk-card ФИО — обычный текст (nameStrike, js/tasks.js:362)');
      if (tileHasFio) { await k.click('.tk-card[data-id="' + T.dirmeet + '"] [data-tk-act="filterEmp"]'); await sleep(500);
      f = await filt();
      C.check(tag + ' R-14 клик по ФИО в плитке → Список, фильтр сотрудника = директор (остальные сброшены)', f.view === 'list' && f.f.emp === 'emp_101' && !f.f.label && f.rows === 3, JSON.stringify(f));
      await k.shot('B07_R14_fio_to_list_' + tag); }
      await openTasks('board'); await k.click('.tk-card[data-id="' + T.dirmeet + '"]'); await sleep(400);
      await k.click('.tk-detail [data-tk-act="filterEmp"]'); await sleep(500);
      f = await filt();
      C.check(tag + ' R-14 клик по ФИО в карточке → Список, фильтр сотрудника', f.view === 'list' && f.f.emp === 'emp_101' && f.rows >= 3, JSON.stringify(f));
      // из Списка: клик по ФИО
      await openTasks('list'); await k.click('#tasksView .tk-table tbody [data-tk-act="filterEmp"]'); await sleep(500);
      f = await filt();
      C.check(tag + ' R-14 клик по ФИО в строке Списка → фильтр по сотруднику, остаёмся в Списке', f.view === 'list' && !!f.f.emp, JSON.stringify(f));

      // ======================= КАЛЕНДАРЬ
      await openTasks('calendar', { mode: 'week' });
      const wk = await ev(`(() => { const R = (e) => { const r = e.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; };
        const cal = document.querySelector('#tasksView .tk-wk'); const days = [...document.querySelectorAll('#tasksView .tk-cal-bd .tk-day')];
        const tiles = [...document.querySelectorAll('#tasksView .tk-cal-bd .tk-ev-t')].map(t => { const d = t.closest('.tk-day'); return { title: (t.querySelector('.tk-ev-title')||{}).textContent, date: d.dataset.date, cols: +t.dataset.cols, col: +t.dataset.col, r: R(t), day: R(d), text: t.innerText.replace(/\\n/g,' ') }; });
        return { scrollTop: cal.scrollTop, hr: [...document.querySelectorAll('#tasksView .tk-hr')].map(e => R(e).h), hrL: [...document.querySelectorAll('#tasksView .tk-hr')].map(e => e.textContent.trim()), slots: days[0].querySelectorAll('.tk-slot').length, dayW: days.map(d => R(d).w), dayH: days.map(d => R(d).h), ad: document.querySelectorAll('#tasksView .tk-cal-ad .tk-ev').length, adLabel: (document.querySelector('#tasksView .tk-cal-ad') || {}).textContent.slice(0, 40), tiles }; })()`);
      C.note('week_' + tag, { scrollTop: wk.scrollTop, ad: wk.ad, adLabel: wk.adLabel });
      const ok48 = wk.hr.length === 24 && wk.hr.every((x) => Math.abs(x - 48) < 0.02);
      C.check(tag + ' R-9 «Неделя»: 24 часовые строки (00:00…23:00) по 48 px, 48 получасовых ячеек в дне, дни равной ширины', ok48 && wk.hrL[0] === '00:00' && wk.hrL[23] === '23:00' && wk.slots === 48 && Math.max.apply(null, wk.dayW) - Math.min.apply(null, wk.dayW) < 1, JSON.stringify([wk.hr.slice(0, 3), wk.hrL[0], wk.hrL[23], wk.slots, wk.dayW]));
      C.check(tag + ' R-9 при открытии календарь прокручен к 08:00 (scrollTop=384)', Math.abs(wk.scrollTop - 384) <= 2, wk.scrollTop);
      const wed = wk.tiles.filter((t) => t.date === D(2));
      const geomOk = wed.every((t) => { const m = t.text.match(/^(\d\d):(\d\d)/); if (!m) return true; const s = (+m[1]) * 60 + (+m[2]); return Math.abs((t.r.y - t.day.y) - s * 0.8) <= 1.2; });
      C.check(tag + ' R-9 плитки стоят в своих часах: top = начало×0.8 px для всех плиток среды', wed.length >= 8 && geomOk, JSON.stringify(wed.map((t) => [t.title, Math.round(t.r.y - t.day.y), t.text.slice(0, 12)])));
      const inter = (a, b) => a.r.x < b.r.x + b.r.w - 0.5 && b.r.x < a.r.x + a.r.w - 0.5 && a.r.y < b.r.y + b.r.h - 0.5 && b.r.y < a.r.y + a.r.h - 0.5;
      let ov = []; for (let i = 0; i < wed.length; i++) for (let j = i + 1; j < wed.length; j++) if (inter(wed[i], wed[j])) ov.push(wed[i].title + '×' + wed[j].title);
      C.check(tag + ' R-11 пересекающиеся плитки не накладываются: стоят рядом (4 задачи 09:00–11:00 — 4 дорожки)', ov.length === 0 && wed.filter((t) => t.cols >= 3).length === 4, ov.join() + '|' + wed.filter((t) => t.cols >= 3).length);
      const dm = wed.find((t) => /Планёрка/.test(t.title));
      C.check(tag + ' R-6 плитка = время + тема, без исполнителя/описания', dm && !/Иванов|Ivanov|Описание/i.test(dm.text) && /Планёрка отдела/.test(dm.text), dm && dm.text);
      C.check(tag + ' R-9 «Весь день»: безвременные и многодневные задачи — в полосе сверху (≥ 3 плитки), в сетке их нет', wk.ad >= 3 && !wk.tiles.some((t) => /Инвентаризация/.test(t.title || '')), JSON.stringify([wk.ad, wk.adLabel]));
      await k.shot('B10_calendar_week_' + tag);
      // сетка 00:00-24:00: прокрутка в начало и конец → снимки
      await ev('document.querySelector("#tasksView .tk-wk").scrollTop = 0'); await sleep(300);
      await k.shot('B11_calendar_week_top_' + tag);
      await ev('document.querySelector("#tasksView .tk-wk").scrollTop = 99999'); await sleep(300);
      await k.shot('B12_calendar_week_bottom_' + tag);
      await openTasks('calendar', { mode: 'day', date: D(2) });
      const dy = await ev(`(() => { const days = document.querySelectorAll('#tasksView .tk-cal-bd .tk-day'); const cal = document.querySelector('#tasksView .tk-wk'); const tiles = [...document.querySelectorAll('#tasksView .tk-cal-bd .tk-ev-t')].map(t => { const b = t.getBoundingClientRect(); const d = t.closest('.tk-day').getBoundingClientRect(); return { title: t.querySelector('.tk-ev-title').textContent, cols: +t.dataset.cols, w: b.width, dw: d.width, text: t.innerText.replace(/\\n/g,' ') }; }); return { days: days.length, hr: document.querySelectorAll('#tasksView .tk-hr').length, tiles, scrollTop: cal.scrollTop, ad: document.querySelectorAll('#tasksView .tk-cal-ad .tk-ev').length }; })()`);
      C.check(tag + ' R-9 «День»: одна колонка, 24 строки часов, плитки (4 пересекающиеся делят ширину), прокрутка к 08:00', dy.days === 1 && dy.hr === 24 && dy.tiles.filter((t) => t.cols === 4).length === 4 && Math.abs(dy.scrollTop - 384) <= 2, JSON.stringify([dy.days, dy.hr, dy.scrollTop, dy.tiles.map((t) => t.cols)]));
      await k.shot('B13_calendar_day_' + tag);

      // --- карточка из Календаря: R-7, R-12…R-15
      await openTasks('calendar', { mode: 'week' });
      await ev('document.querySelector("#tasksView .tk-wk").scrollTop = 384');
      await k.click('#tasksView .tk-ev-t[data-id="' + T.dirmeet + '"]'); await sleep(500);
      const cc = await ev(`(() => { const d = document.querySelector('.tk-detail'); if (!d) return null; const v = d.querySelector('.tk-note-vac'); const cs = v && getComputedStyle(v); return { vis: d.getBoundingClientRect().width, vac: v ? { bg: cs.backgroundColor, img: cs.backgroundImage.slice(0, 120) } : null, btns: [...d.querySelectorAll('button')].map(b => b.textContent.trim()), reassign: /Переназначить/.test(d.textContent) }; })()`);
      C.check(tag + ' СТЫК: карточка открыта из Календаря: R-7 оранжевая штриховка, R-1 нет «Переназначить»', cc && cc.vac && /rgb\(255, 138, 0\)/.test(cc.vac.bg) && /repeating-linear-gradient/.test(cc.vac.img) && !cc.reassign, JSON.stringify(cc));
      await k.shot('B14_calendar_card_' + tag);
      await k.shotEl('.tk-detail', 'B15_calendar_card_closeup_' + tag, { maxH: 900 });
      for (const [key, chk] of [['label', (x) => x.f.label === 'руководство'], ['priority', (x) => String(x.f.priority) === '1'], ['status', (x) => x.f.status === 'open']]) {
        await openTasks('calendar', { mode: 'week' }); await ev('document.querySelector("#tasksView .tk-wk").scrollTop = 384');
        await k.click('#tasksView .tk-ev-t[data-id="' + T.dirmeet + '"]'); await sleep(400);
        await k.click('.tk-detail [data-tk-act="filterBy"][data-f="' + key + '"]'); await sleep(500);
        f = await filt();
        C.check(tag + ' СТЫК: из карточки Календаря клик по «' + key + '» → Список с фильтром', f.view === 'list' && chk(f), JSON.stringify(f));
      }
      await openTasks('calendar', { mode: 'week' }); await ev('document.querySelector("#tasksView .tk-wk").scrollTop = 384');
      await k.click('#tasksView .tk-ev-t[data-id="' + T.dirmeet + '"]'); await sleep(400);
      await k.click('.tk-detail [data-tk-act="filterEmp"]'); await sleep(500); f = await filt();
      C.check(tag + ' СТЫК: из карточки Календаря клик по ФИО → Список (фильтр сотрудника-директора)', f.view === 'list' && f.f.emp === 'emp_101', JSON.stringify(f));
      await openTasks('calendar', { mode: 'week' }); await ev('document.querySelector("#tasksView .tk-wk").scrollTop = 384');
      await k.click('#tasksView .tk-ev-t[data-id="' + T.dirmeet + '"]'); await sleep(400);
      await k.click('.tk-detail .tk-note-vac a[data-tk-act="openMatrix"]'); await sleep(900);
      const mx2 = await ev(`(() => { const r = document.querySelector('#matrixBody tr.mx-flash'); return { tab: document.getElementById('tabMatrix').classList.contains('active'), row: r ? r.className + '|' + r.querySelector('.name-col').textContent.trim().slice(0,24) : null }; })()`);
      C.check(tag + ' СТЫК: из карточки Календаря клик по ФИО в отпуске → матрица, подсвечена золотая строка директора', mx2.tab && mx2.row && /matrix-row-director/.test(mx2.row) && /mx-flash/.test(mx2.row), JSON.stringify(mx2));
      await k.shot('B16_calendar_card_to_matrix_' + tag);
      await k.click('#tabTasks'); await sleep(1000);

      // ======================= R-10 создание кликом по ячейке → директор → список с «!»; R-3 шаг 30 мин
      await openTasks('calendar', { mode: 'week' });
      await ev('window.Tasks.__t.S.filters.emp = ""; window.Tasks.__t.render();'); await sleep(300);
      await ev('document.querySelector("#tasksView .tk-wk").scrollTop = ' + (HH*48-100) + ''); await sleep(300);
      const cellSel = '#tasksView [data-tk-act="calCell"][data-date="' + D(2) + '"][data-min="' + (HH*60) + '"]';
      const cellExists = await ev('!!document.querySelector(' + JSON.stringify(cellSel) + ')');
      C.check(tag + ' R-10 ячейка ' + HH + ':00 среды существует и кликабельна (admin)', cellExists, cellSel);
      await k.click(cellSel); await sleep(600); await k.shot('B19_after_cell_click_' + tag);
      const fm = await ev(`(() => { const g = (f) => { const e = document.querySelector('#tasksView [data-tk-field="' + f + '"]'); return e ? e.value : null; }; const opts = (f) => { const e = document.querySelector('#tasksView [data-tk-field="' + f + '"]'); return e ? [...e.options].map(o => o.value) : null; };
        const pick = document.querySelector('#tasksView [data-tk-field="assigneePick"]');
        return { h4: (document.querySelector('#tasksView .tk-form h4')||{}).textContent, startDate: g('startDate'), startTime: g('startTime'), endDate: g('endDate'), endTime: g('endTime'), kind: (document.querySelector('#tasksView input[name=tkKind]:checked')||{}).value, st: opts('startTime'), et: opts('endTime'), types: [...document.querySelectorAll('#tasksView input[type=time]')].length, pickOpts: pick ? [...pick.options].map(o => o.textContent.trim()) : null }; })()`);
      console.log(JSON.stringify(fm).slice(0, 900));
      C.check(tag + ' R-10 клик по ячейке ' + HH + ':00 → «Новая задача»: дата ' + D(2) + ', ' + HH + ':00–' + (HH+1) + ':00', fm.h4 === 'Новая задача' && fm.startDate === D(2) && fm.startTime === HH + ':00' && fm.endTime === (HH + 1) + ':00', JSON.stringify([fm.h4, fm.startDate, fm.startTime, fm.endDate, fm.endTime, fm.kind]));
      const step30 = (arr) => arr && arr.filter(Boolean).length === 48 && arr.filter(Boolean).every((v, i) => v === String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00'));
      C.check(tag + ' R-3 время (форма из Календаря): списки с шагом 30 мин 00:00…23:30 (48 пунктов + «—»), нет <input type=time>', step30(fm.st) && step30(fm.et) && fm.types === 0, JSON.stringify([fm.st && fm.st.length, fm.types]));
      const dirFirst = (fm.pickOpts || []).findIndex((o) => /Директор Тестов/.test(o));
      C.check(tag + ' R-2 в списке исполнителей формы есть «Директор Тестов Павел Игоревич»', dirFirst > 0, JSON.stringify(fm.pickOpts));
      await k.shot('B20_form_from_calendar_cell_' + tag);
      // выбираем директора в select, заполняем название, сохраняем
      await ev(`(() => { const e = document.querySelector('#tasksView [data-tk-field="assigneePick"]'); e.value = 'emp_101'; e.dispatchEvent(new Event('change', {bubbles:true})); })()`); await sleep(300);
      await ev(`(() => { const e = document.querySelector('#tasksView [data-tk-field="title"]'); e.value = 'Создано кликом (директор ' + '${tag}' + ')'; e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); })()`); await sleep(200);
      const chips = await ev('document.getElementById("tkAssignees").textContent');
      C.check(tag + ' СТЫК R-10→R-2: исполнитель из зоны «Управление СЦ» выбран (чип)', /Директор Тестов/.test(chips), chips);
      await k.shot('B21_form_director_selected_' + tag);
      await k.click('#tasksView [data-tk-act="saveForm"]'); await sleep(1500);
      const saved = await S('({ err: S.form && S.form.error, formOpen: !!S.form, n: S.tasks.filter(t => t.title === "Создано кликом (директор ' + tag + ')").length })');
      C.check(tag + ' СТЫК: задача создана (форма закрыта, ошибок нет)', !saved.formOpen && !saved.err && saved.n === 1, JSON.stringify(saved));
      const srv = await L.http(env.base, s.adminCookies.join('; '), 'GET', 'api/tasks.php?from=2026-11-01&to=2026-11-30');
      const created = ((srv.json.tasks || srv.json.data || []).find((t) => t.title === 'Создано кликом (директор ' + tag + ')')) || null;
      C.check(tag + ' СТЫК: на сервере start_at/end_at = ' + D(2) + 'T' + HH + ':00/' + (HH+1) + ':00 и исполнитель emp_101', created && created.start_at === D(2) + 'T' + HH + ':00' && created.end_at === D(2) + 'T' + (HH + 1) + ':00' && JSON.stringify(created.assignees || []).indexOf('emp_101') >= 0, JSON.stringify(created).slice(0, 300));
      await openTasks('list');
      const warn = await ev(`(() => { const r = [...document.querySelectorAll('#tasksView .tk-table tbody tr')].find(r => r.textContent.indexOf('Создано кликом (директор ${tag})') >= 0); if (!r) return 'нет строки'; const w = r.querySelector('.tk-warnico'); return w ? w.title : null; })()`);
      C.check(tag + ' СТЫК R-10→R-8: новая задача директора (отпуск 18–19.11) в Списке с «!» и подсказкой «отпуск…»', typeof warn === 'string' && /отпуск 18\.11/.test(warn), String(warn));
      await k.shot('B22_list_new_task_warning_' + tag);
      // R-3 из Доски: «Новая задача»
      await openTasks('board'); await k.click('#tasksView [data-tk-act="newTask"]'); await sleep(500);
      const fb = await ev(`(() => { const opts = (f) => { const e = document.querySelector('#tasksView [data-tk-field="' + f + '"]'); return e ? [...e.options].map(o => o.value) : null; }; return { st: opts('startTime'), types: document.querySelectorAll('#tasksView input[type=time]').length, h4: (document.querySelector('#tasksView .tk-form h4')||{}).textContent }; })()`);
      C.check(tag + ' R-3 время (форма из Доски «Новая задача»): шаг 30 мин, нет <input type=time>', fb.h4 === 'Новая задача' && step30(fb.st) && fb.types === 0, JSON.stringify([fb.h4, fb.st && fb.st.length, fb.types]));
      await k.shot('B23_form_from_board_' + tag);
      await k.click('#tasksView [data-tk-act="cancelForm"]'); await sleep(300);
    }
    C.note('exceptions', cdp.exceptions); C.note('dialogs', cdp.dialogs);
    C.check('нет необработанных исключений на странице', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));
  } catch (e) { console.log('FATAL', e); C.check('прогон без аварии', false, e.stack); }
  finally { C.save(); env.cleanup(); console.log('PASSED ' + C.passed + ' FAILED ' + C.failed); process.exit(C.failed ? 1 : 0); }
})();
