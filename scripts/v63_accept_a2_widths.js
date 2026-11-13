// V6.3-3 (приёмка, вне gate): A2 — ширины колонок и таблицы Списка при разных ширинах окна, ДО (6072f41) и ПОСЛЕ.
// Запуск: V63_BEFORE_ROOT=<выгрузка 6072f41> node scripts/v63_accept_a2_widths.js → A2_widths.json, таблица в stdout
'use strict';
const path = require('path');
const { L, seed, D, sleep, OUT, kit, api } = require('./v63_accept_lib.js');
const M = `(() => { const ths = [...document.querySelectorAll('#tasksView .tk-table thead th')], t = document.querySelector('#tasksView .tk-table'), w = document.querySelector('#tasksView .tk-tablewrap');
  return { order: ths.map((x) => x.textContent.replace('↕', '').trim()), w: ths.map((x) => Math.round(x.getBoundingClientRect().width * 10) / 10), table: Math.round(t.getBoundingClientRect().width * 10) / 10, wrap: w.clientWidth, scrollW: w.scrollWidth }; })()`;
async function run(root) {
  const env = await L.startEnv({ root });
  const out = {};
  try {
    const s = await seed(env); const ck = s.adminCookies.join('; ');
    // «боевые» данные: длинные темы и описания
    if (process.env.V63_LONG !== '0') await api(env, ck, 'POST', 'api/tasks.php', { title: 'Подготовка документов для проверки контролирующим органом и согласование с юристами', description: 'Собрать все документы за квартал, сверить с реестром, подготовить пояснительную записку и отправить на согласование руководителям подразделений. '.repeat(2), assignees: ['emp_1', 'emp_2', 'emp_3'], start_at: D(1) + 'T10:00', end_at: D(1) + 'T11:00' });
    const A = await env.openBrowser(); const k = kit(A.cdp, env);
    for (const w of [1024, 1100, 1200, 1280, 1366, 1600, 1920]) {
      await k.size(w, 900, false); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
      out[w] = await k.ev(M);
    }
  } finally { env.cleanup(); }
  return out;
}
(async () => {
  const before = await run(process.env.V63_BEFORE_ROOT), after = await run();
  const C = L.makeChecker(path.join(OUT, process.env.V63_LONG === '0' ? 'A2_widths_short.json' : 'A2_widths.json'));
  console.log('ширина окна | ДО: Задача/Описание/Исполнитель/…/таблица (окно) | ПОСЛЕ');
  for (const w of Object.keys(before)) {
    const b = before[w], a = after[w];
    console.log(w + ' | ДО ' + b.w.join('/') + ' таблица ' + b.table + ' (окно ' + b.wrap + ', scrollW ' + b.scrollW + ') | ПОСЛЕ ' + a.w.join('/') + ' таблица ' + a.table + ' (окно ' + a.wrap + ', scrollW ' + a.scrollW + ')');
  }
  C.note('before', before); C.note('after', after);
  const ex = (o) => o.w[o.order.indexOf('Исполнитель')];
  C.check('Исполнитель = 192 на всех ширинах окна', Object.keys(after).every((w) => ex(after[w]) === 192), JSON.stringify(Object.keys(after).map((w) => [w, ex(after[w])])));
  C.check('Исполнитель ДО = 128 на всех ширинах (база сравнения)', Object.keys(before).every((w) => ex(before[w]) === 128), '');
  for (const w of [1280, 1366, 1600, 1920]) C.check(w + ': ширина таблицы неизменна (' + before[w].table + ' → ' + after[w].table + ') и помещается в окно', Math.abs(before[w].table - after[w].table) < 0.6 && after[w].table <= after[w].wrap + 1, '');
  for (const w of [1024, 1100, 1200]) C.note('narrow_' + w, { before_table: before[w].table, after_table: after[w].table, wrap: after[w].wrap });
  C.save();
  console.log('A2: ' + C.passed + ' passed, ' + C.failed + ' failed');
  process.exit(C.failed ? 1 : 0);
})();
