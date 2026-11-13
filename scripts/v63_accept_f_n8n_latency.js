// V6.3-3 (приёмка, вне gate): F — задержка создания задачи с N повторами при НЕОТВЕЧАЮЩЕМ n8n (tasks-validate вызывается по каждому повтору, таймаут 3 с).
// Локальный «зависший» HTTP-сервер вместо n8n; php -S на копии БД. Сеть/прод/n8n не используются.
// Запуск: node scripts/v63_accept_f_n8n_latency.js
'use strict';
const http = require('http'), cp = require('child_process'), path = require('path');
const { L, OUT } = require('./v63_accept_lib.js');
const sleep = L.sleep;
(async () => {
  const C = L.makeChecker(path.join(OUT, 'F_results.json'));
  const hung = http.createServer(() => { /* никогда не отвечает */ });
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const hport = hung.address().port;
  const env = await L.startEnv();
  try {
    try { env.srv.kill(); } catch (e) { /* */ }
    await sleep(300);
    const e2 = Object.assign({}, process.env, { SC_APP_DB: env.tmpDb, TASKS_VALIDATE_WEBHOOK_URL: 'http://127.0.0.1:' + hport + '/validate', TASKS_N8N_WEBHOOK_SECRET: 'x'.repeat(24) });
    env.srv = cp.spawn('php', ['-S', '127.0.0.1:' + env.port, '-t', L.ROOT], { env: e2, cwd: L.ROOT, stdio: 'ignore' });
    for (let i = 0; i < 80; i++) { try { const r = await fetch(env.base + '/api/session.php'); if (r.status < 500) break; } catch (e) { /* */ } await sleep(100); }
    const ck = (await L.login(env.base, 'admin')).join('; ');
    const res = {};
    for (const n of [0, 1, 4, 8]) {
      const occ = Array.from({ length: n }, (_, i) => ({ start_at: '2027-03-' + String(10 + i).padStart(2, '0') + 'T10:00' }));
      const t0 = Date.now();
      const r = await L.http(env.base, ck, 'POST', 'api/tasks.php', { title: 'n8n зависает ' + n, assignees: ['emp_1'], start_at: '2027-03-01T10:00', end_at: '2027-03-01T11:00', occurrences: occ });
      res[n] = { status: r.status, ms: Date.now() - t0, check_state: r.json.task && r.json.task.check_state };
      console.log('повторов ' + n + ': HTTP ' + r.status + ', ' + res[n].ms + ' мс, check_state=' + res[n].check_state);
    }
    C.note('latency', res);
    const per = (res[8].ms - res[0].ms) / 8;
    C.check('создание с 8 повторами при зависшем n8n успешно (201, check_state=pending), но время растёт линейно: ≈' + Math.round(per) + ' мс на повтор (таймаут 3 с) → 100 повторов ≈ ' + Math.round(per * 100 / 1000) + ' с', res[8].status === 201 && res[8].check_state === 'pending', JSON.stringify(res));
    C.note('estimate_100_s', Math.round(per * 100 / 1000));
  } finally { C.save(); console.log('F: ' + C.passed + ' passed, ' + C.failed + ' failed'); env.cleanup(); hung.close(); process.exit(C.failed ? 1 : 0); }
})();
