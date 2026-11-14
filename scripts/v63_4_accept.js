// V6.3-4 (приёмка, вне gate): ширины колонок Списка — матрица «до (6072f41) / после» и скриншоты.
// Запуск: V63_BEFORE_ROOT=<выгрузка 6072f41: git archive 6072f41 | tar -x -C DIR> node scripts/v63_4_accept.js
//   → reports/V6_3/V6.3-4_screens/W4_matrix.json, W4_results.json, *.png; таблица матрицы — в stdout (и W4_matrix.md)
// Реальный Chromium (CDP), php -S на КОПИИ data/app.db; мышь — реальные события. Пароли в браузер не вводятся.
'use strict';
const path = require('path'), fs = require('fs');
const { L, seed, D, sleep, kit, api } = require('./v63_accept_lib.js');
const OUT = path.join(L.ROOT, 'reports/V6_3/V6.3-4_screens');
fs.mkdirSync(OUT, { recursive: true });
const WIDTHS = [1024, 1100, 1200, 1280, 1366, 1600, 1920];
const TOL = 2;
const M = `(() => { const ths = [...document.querySelectorAll('#tasksView .tk-table thead th')], t = document.querySelector('#tasksView .tk-table'), w = document.querySelector('#tasksView .tk-tablewrap');
  return { order: ths.map((x) => x.textContent.replace('↕', '').trim()), w: ths.map((x) => Math.round(x.getBoundingClientRect().width * 10) / 10), table: Math.round(t.getBoundingClientRect().width * 10) / 10, wrap: w.clientWidth, scrollW: w.scrollWidth, pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`;

const LONGW = 'Сверхдлинноеслово'.repeat(3);
const DATASETS = {
  short: async () => {},
  long: async (env, ck) => {
    await api(env, ck, 'POST', 'api/tasks.php', { title: 'Подготовка документов для проверки контролирующим органом и согласование с юристами', description: 'Собрать все документы за квартал, сверить с реестром, подготовить пояснительную записку и отправить на согласование руководителям подразделений. '.repeat(2), assignees: ['emp_1', 'emp_2', 'emp_3'], start_at: D(1) + 'T10:00', end_at: D(1) + 'T11:00' });
  },
  mixed: async (env, ck) => {
    const mk = (title, description, assignees, day) => api(env, ck, 'POST', 'api/tasks.php', { title, description, assignees, start_at: D(day) + 'T09:00', end_at: D(day) + 'T10:00' });
    await mk('А', '', ['emp_1'], 1);
    await mk('Очень длинная тема задачи без описания, которая должна занять несколько строк в колонке «Задача» при любой ширине окна', '', ['emp_105', 'emp_106'], 2);
    await mk('Короткая тема', 'Очень длинное описание. '.repeat(30), ['emp_101', 'emp_105', 'emp_106', 'emp_107', 'emp_1'], 3);
    await mk(LONGW, 'Описание', ['emp_2'], 4);
    await mk('Тема', LONGW + ' ' + LONGW, ['emp_3'], 5);
    await mk('Техническая задача, пересечение графиков и подтверждение выхода на смену', 'Проверить графики и подтвердить.', ['emp_4', 'emp_5'], 6);
  },
};

async function run(root, name, extra) {
  const env = await L.startEnv({ root });
  const out = {};
  try {
    const s = await seed(env); const ck = s.adminCookies.join('; ');
    await DATASETS[name](env, ck);
    if (extra) await extra(env, ck);
    const A = await env.openBrowser(); const k = kit(A.cdp, env);
    for (const w of WIDTHS.concat([375])) {
      await k.size(w, 900, w === 375); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
      out[w] = await k.ev(M);
    }
  } finally { env.cleanup(); }
  return out;
}

function compare(b, a) {
  // → { ok, rows: [..], issues: [..] } по правилу V6.3-4
  const idx = (o, n) => o.order.indexOf(n), issues = [];
  const bi = (n) => b.w[idx(b, n)], ai = (n) => a.w[idx(a, n)];
  if (Math.abs(ai('Исполнитель') - 192) > 0.6) issues.push('Исполнитель ' + ai('Исполнитель'));
  if (Math.abs((bi('Описание') - 64) - ai('Описание')) > TOL) issues.push('Описание ' + bi('Описание') + ' → ' + ai('Описание') + ' (ожидалось ' + (bi('Описание') - 64).toFixed(1) + ')');
  ['Задача', 'Срок', 'Приор.', 'Статус', 'Править'].forEach((n) => { if (idx(b, n) >= 0 && Math.abs(bi(n) - ai(n)) > TOL) issues.push(n + ' ' + bi(n) + ' → ' + ai(n)); });
  if (Math.abs(b.table - a.table) > TOL) issues.push('таблица ' + b.table + ' → ' + a.table);
  return issues;
}

(async () => {
  const C = L.makeChecker(path.join(OUT, 'W4_results.json'));
  const matrix = {};
  let md = '| окно | данные | Задача до/после | Описание до/после (Δ) | Исполнитель | Срок | Приор. | Статус | ✎ | Таблица до/после | окно (wrap) | вердикт |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const name of (process.env.ONLY === 'bulk' ? [] : Object.keys(DATASETS))) {
    const before = await run(process.env.V63_BEFORE_ROOT, name), after = await run(null, name);
    matrix[name] = { before, after };
    for (const w of WIDTHS.concat([375])) {
      const b = before[w], a = after[w], g = (o, n) => { const i = o.order.indexOf(n); return i < 0 ? '–' : o.w[i]; };
      if (w === 375) {
        const iss = [];
        if (Math.abs(g(a, 'Исполнитель') - 192) > 0.6) iss.push('Исполнитель ' + g(a, 'Исполнитель'));
        if (a.table > b.table + TOL) iss.push('таблица выросла ' + b.table + ' → ' + a.table);
        if (a.pageOverflow !== 0) iss.push('страница уехала: ' + a.pageOverflow);
        C.check('375 [' + name + ']: прокрутка внутри .tk-tablewrap (scrollW ' + a.scrollW + ' > окно ' + a.wrap + '), Исполнитель 192, таблица не шире, чем была (' + b.table + ' → ' + a.table + '), страница не уезжает', a.scrollW > a.wrap && !iss.length, iss.join('; '));
        md += '| 375 | ' + name + ' | ' + g(b, 'Задача') + ' / ' + g(a, 'Задача') + ' | ' + g(b, 'Описание') + ' / ' + g(a, 'Описание') + ' | ' + g(a, 'Исполнитель') + ' | ' + g(a, 'Срок') + ' | ' + g(a, 'Приор.') + ' | ' + g(a, 'Статус') + ' | ' + g(a, 'Править') + ' | ' + b.table + ' / ' + a.table + ' | ' + a.wrap + ' | ' + (iss.length ? 'FAIL' : 'ок (прокрутка)') + ' |\n';
        continue;
      }
      const iss = compare(b, a);
      C.check(w + ' [' + name + ']: Исполнитель 192; Описание = прежнее − 64 (±' + TOL + '); Задача/Срок/Приор./Статус/✎/таблица прежние (±' + TOL + ')', iss.length === 0, iss.join('; '));
      C.check(w + ' [' + name + ']: прокрутка таблицы не появилась там, где её не было (scrollW ' + b.scrollW + ' → ' + a.scrollW + ', окно ' + b.wrap + ' → ' + a.wrap + ')', (b.scrollW <= b.wrap + 1) ? (a.scrollW <= a.wrap + 1) : (a.scrollW <= b.scrollW + TOL), '');
      md += '| ' + w + ' | ' + name + ' | ' + g(b, 'Задача') + ' / ' + g(a, 'Задача') + ' | ' + g(b, 'Описание') + ' / ' + g(a, 'Описание') + ' (' + (g(a, 'Описание') - g(b, 'Описание')).toFixed(1) + ') | ' + g(a, 'Исполнитель') + ' | ' + g(b, 'Срок') + ' / ' + g(a, 'Срок') + ' | ' + g(b, 'Приор.') + ' / ' + g(a, 'Приор.') + ' | ' + g(b, 'Статус') + ' / ' + g(a, 'Статус') + ' | ' + g(a, 'Править') + ' | ' + b.table + ' / ' + a.table + ' | ' + a.wrap + ' | ' + (iss.length ? 'FAIL: ' + iss.join('; ') : 'ок') + ' |\n';
    }
  }
  fs.writeFileSync(path.join(OUT, 'W4_matrix.json'), JSON.stringify(matrix, null, 1));
  fs.writeFileSync(path.join(OUT, 'W4_matrix.md'), md);
  console.log(md);

  // ---- скорость / мерцание / перерисовка / ресайз: 300 задач, до и после ----
  const bulk = async (root) => {
    const env = await L.startEnv({ root }); const r = {};
    try {
      const s = await seed(env); const ck = s.adminCookies.join('; ');
      const emps = ['emp_1', 'emp_2', 'emp_3', 'emp_4', 'emp_105', 'emp_106', 'emp_107'];
      for (let i = 0; i < 300; i++) {
        await api(env, ck, 'POST', 'api/tasks.php', { title: 'Задача номер ' + i + (i % 7 === 0 ? ' с длинным названием для проверки переноса строк' : ''), description: i % 3 ? 'Описание ' + i + ' '.padEnd(i % 5 * 30, 'текст ') : '', assignees: [emps[i % 7], emps[(i + 3) % 7]], start_at: D(i % 20) + 'T10:00', end_at: D(i % 20) + 'T11:00' });
      }
      const A = await env.openBrowser(); const k = kit(A.cdp, env);
      await k.size(1280, 900, false); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
      r.rows = await k.ev(`document.querySelectorAll('#tasksView .tk-table tbody tr').length`);
      r.m1280 = await k.ev(M);
      r.ms = await k.ev(`(() => { const S = window.Tasks.__t.S, R = window.Tasks.__t.render, a = [], b = [], c = []; const t0title = S.tasks[0].title;
        for (let i = 0; i < 12; i++) { S.tasks[0].title = t0title + ' ' + i; const t0 = performance.now(); R(); const t1 = performance.now(); document.querySelector('#tasksView .tk-table').getBoundingClientRect(); const t2 = performance.now(); a.push(t2 - t0); b.push(t1 - t0); }
        for (let i = 0; i < 12; i++) { const t0 = performance.now(); R(); document.querySelector('#tasksView .tk-table').getBoundingClientRect(); c.push(performance.now() - t0); }
        S.tasks[0].title = t0title; R();
        const med = (x) => { x = x.slice().sort((p, q) => p - q); return Math.round(x[6] * 10) / 10; };
        return { median: med(a), max: Math.round(Math.max.apply(null, a) * 10) / 10, renderOnlyMedian: med(b), sameDataMedian: med(c) }; })()`);
      // синхронность: сразу после render() (в том же JS-вызове) таблица уже в итоговом состоянии
      r.sync = await k.ev(`(() => { window.Tasks.__t.render(); const t = document.querySelector('#tasksView .tk-table'); const th = [...t.tHead.rows[0].cells].map((x) => Math.round(x.getBoundingClientRect().width)); return { cls: t.className, th, table: Math.round(t.getBoundingClientRect().width) }; })()`);
      // кадры при перерисовке: ни в одном кадре таблица не бывает в промежуточном состоянии
      r.frames = await k.ev(`new Promise((res) => { const seen = new Set(); let n = 0; const R = window.Tasks.__t.render; const tick = () => { const t = document.querySelector('#tasksView .tk-table'); seen.add(t ? t.className + '|' + Math.round(t.getBoundingClientRect().width) + '|' + Math.round(t.tHead.rows[0].cells[2].getBoundingClientRect().width) : 'none'); if (++n < 20) { R(); requestAnimationFrame(tick); } else res([...seen]); }; R(); requestAnimationFrame(tick); })`);
      // ресайз 1280 → 1600 → 1100: перерасчёт без перерисовки
      r.resize = {};
      for (const w of [1600, 1100, 1280]) { await k.size(w, 900, false); await sleep(500); r.resize[w] = await k.ev(M); }
      // скрытая панель: рендер при display:none, затем показ
      r.hidden = await k.ev(`new Promise((res) => { const v = document.getElementById('tasksView'); v.style.display = 'none'; window.Tasks.__t.render(); const t0 = document.querySelector('#tasksView .tk-table'); const hiddenCls = t0.className; setTimeout(() => { v.style.display = ''; setTimeout(() => { const t = document.querySelector('#tasksView .tk-table'); res({ hiddenCls, shownCls: t.className, ex: Math.round(t.tHead.rows[0].cells[2].getBoundingClientRect().width) }); }, 400); }, 200); })`);
    } finally { env.cleanup(); }
    return r;
  };
  const bB = await bulk(process.env.V63_BEFORE_ROOT), bA = await bulk(null);
  console.log('300 задач: до', JSON.stringify({ ms: bB.ms, rows: bB.rows }), 'после', JSON.stringify({ ms: bA.ms, rows: bA.rows }));
  C.note('bulk_before', bB); C.note('bulk_after', bA);
  C.check('300 задач (' + bA.rows + ' строк): те же ширины, что «до» (Описание −64, Исполнитель 192, таблица прежняя)', compare(bB.m1280, bA.m1280).length === 0, compare(bB.m1280, bA.m1280).join('; '));
  C.check('300 задач: render()+раскладка, данные изменились (замер заново): медиана ' + bA.ms.median + ' мс против ' + bB.ms.median + ' мс «до» (' + (bA.ms.median / bB.ms.median).toFixed(2) + '×; две раскладки вместо одной) — не более 2,6×', bA.ms.median / bB.ms.median <= 2.6, '');
  C.check('300 задач: перерисовка с теми же данными (кэш ширин): ' + bA.ms.sameDataMedian + ' мс против ' + bB.ms.sameDataMedian + ' мс «до» — не медленнее 1,3×', bA.ms.sameDataMedian / bB.ms.sameDataMedian <= 1.3, '');
  C.check('перерисовка синхронна: сразу после render() таблица в итоговом состоянии (tk-fit, Исполнитель 192)', /tk-fit/.test(bA.sync.cls) && !/tk-measure/.test(bA.sync.cls) && bA.sync.th[2] === 192, JSON.stringify(bA.sync));
  C.check('мерцания нет: в 20 последовательных кадрах перерисовки таблица всегда в одном и том же состоянии (' + bA.frames.length + ' вариант)', bA.frames.length === 1, JSON.stringify(bA.frames));
  const okR = [1600, 1100, 1280].every((w) => bA.resize[w] && bA.resize[w].w[2] === 192 && Math.abs(bA.resize[w].w[1] - bA.resize[w].w[1]) < 1);
  const cmpR = [1600, 1100, 1280].map((w) => { const bb = bB.resize[w], aa = bA.resize[w]; return compare(bb, aa); });
  C.check('смена ширины окна без перерисовки (1280→1600→1100→1280): ширины пересчитаны и совпадают с «до» по правилу', okR && cmpR.every((x) => !x.length), JSON.stringify(cmpR));
  C.check('рендер при скрытой панели → после показа ширины подогнаны (ResizeObserver)', /tk-fit/.test(bA.hidden.shownCls) && bA.hidden.ex === 192, JSON.stringify(bA.hidden));

  // ---- скриншоты 1280/375: admin и supervisor ----
  if (process.env.ONLY === 'bulk') { console.log('ONLY=bulk: W4 ' + C.passed + ' passed, ' + C.failed + ' failed'); process.exit(C.failed ? 1 : 0); }
  const env = await L.startEnv();
  try {
    const s = await seed(env);
    await DATASETS.long(env, s.adminCookies.join('; '));
    const supCookies = await L.login(env.base, 'supervisor_zone0');
    const A = await env.openBrowser(); const k = kit(A.cdp, env);
    const shot = async (name) => { const r = await A.cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); console.log('  shot ' + name); };
    for (const [role, cookies] of [['admin', s.adminCookies], ['supervisor', supCookies]]) {
      for (const w of [1280, 375]) {
        await k.size(w, 900, w === 375); await k.load(cookies); await k.gotoTasks(); await k.view('list');
        const m = await k.ev(M);
        C.note(role + '_' + w, m);
        const cols = role === 'admin' ? 7 : 6;
        C.check(role + ' ' + w + ': ' + cols + ' колонок (' + m.order.join('|') + '), Исполнитель 192, нет перекрытий (сумма ширин = таблица ±1)', m.order.length === cols && m.w[2] === 192 && Math.abs(m.w.reduce((x, y) => x + y, 0) - m.table) <= 1, JSON.stringify(m));
        await shot('W4_' + role + '_list_' + w);
        if (w === 375) { await k.ev(`document.querySelector('#tasksView .tk-tablewrap').scrollLeft = 400`); await sleep(200); await shot('W4_' + role + '_list_375_scrolled'); }
      }
    }
  } finally { env.cleanup(); }
  C.save();
  console.log('W4: ' + C.passed + ' passed, ' + C.failed + ' failed');
  process.exit(C.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
