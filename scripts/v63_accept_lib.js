// V6.3-3 (приёмка, вне gate): общие хелперы поверх v6_accept_lib.js — реальные клавиши/мышь по CDP, открытие «Задач», сид.
'use strict';
const path = require('path');
const cp = require('child_process');
const L0 = require('./v6_accept_lib.js');
// startEnv({root}) — поднять сервер на другой выгрузке кода (замер «до» на 0e69a2d); без root — как в v6_accept_lib.js.
const L = Object.assign({}, L0, {
  startEnv: async (opts) => {
    const env = await L0.startEnv(opts);
    if (opts && opts.root) {
      try { env.srv.kill(); } catch (e) { /* */ }
      await L0.sleep(300);
      const e2 = Object.assign({}, process.env, { SC_APP_DB: env.tmpDb }); delete e2.TASKS_VALIDATE_WEBHOOK_URL;
      env.srv = cp.spawn('php', ['-S', '127.0.0.1:' + env.port, '-t', opts.root], { env: e2, cwd: opts.root, stdio: 'ignore' });
      for (let i = 0; i < 80; i++) { try { const r = await fetch(env.base + '/api/session.php'); if (r.status < 500) break; } catch (e) { /* */ } await L0.sleep(100); }
      const c0 = env.cleanup; env.cleanup = () => { try { env.srv.kill(); } catch (e) { /* */ } c0(); };
    }
    return env;
  },
});
const { seed, D } = require('./v6_accept_seed.js');
const sleep = L.sleep;
const OUT = path.join(L.ROOT, 'reports/V6_3/V6.3-3_screens');
require('fs').mkdirSync(OUT, { recursive: true });

function kit(cdp, env) {
  const k = L.pageKit(cdp, env.base, OUT);
  const ev = (x) => cdp.ev(x);
  k.ev = ev;
  // реальные клавиши
  k.key = async (key, o) => {
    o = o || {};
    const code = o.code || ({ Enter: 'Enter', Backspace: 'Backspace', Escape: 'Escape', ',': 'Comma', Tab: 'Tab', ' ': 'Space' }[key] || undefined);
    const vk = { Enter: 13, Backspace: 8, Escape: 27, Tab: 9, ',': 188, ' ': 32 }[key];
    const text = o.text !== undefined ? o.text : (key === 'Enter' ? '\r' : (key.length === 1 ? key : undefined));
    await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, text });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    await sleep(80);
  };
  k.type = async (s) => { await cdp.send('Input.insertText', { text: s }); await sleep(80); };
  k.mouse = (type, x, y, extra) => cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra || {}));
  k.move = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  k.rclick = async (x, y) => {
    await k.move(x, y);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
    await sleep(250);
  };
  // перетаскивание: down → шаги move → (pause) → up
  k.drag = async (x0, y0, x1, y1, o) => {
    o = o || {};
    await k.move(x0, y0);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
    const n = o.steps || 8;
    for (let i = 1; i <= n; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / n, y: y0 + (y1 - y0) * i / n, button: 'left', buttons: 1 }); await sleep(30); }
    await sleep(o.hold || 250);
    if (o.beforeUp) await o.beforeUp();
    if (o.noUp) return;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(o.after || 700);
  };
  k.gotoTasks = async () => {
    const shown = () => ev(`(() => { const w = document.querySelector('#tasksView .tk-wrap'); if (!w) return false; const r = w.getBoundingClientRect(); return r.width > 50 && r.height > 50; })()`);
    if (!(await shown())) {
      await ev('document.getElementById("vacationTrigger").click()'); await sleep(700);
      if (!(await shown())) { await k.click('#tabTasks'); await sleep(1200); }
    }
    await k.waitFor('!window.Tasks.__t.S.loading', 20000);
  };
  k.view = async (v) => { await k.waitFor('!!document.querySelector(\'#tasksView [data-tk-act="setView"][data-view="' + v + '"]\')', 15000); await k.click('#tasksView [data-tk-act="setView"][data-view="' + v + '"]'); await k.waitFor('!window.Tasks.__t.S.loading', 20000); await sleep(400); };
  k.openTasks = async (view, extra) => {
    await ev('window.Tasks.open(' + JSON.stringify(Object.assign({ employeeId: '', date: D(2), view, mode: 'week' }, extra || {})) + ')');
    await k.waitFor('!window.Tasks.__t.S.loading', 20000); await sleep(500);
  };
  return k;
}

const api = async (env, ck, method, url, body) => L.http(env.base, ck, method, url, body);

module.exports = { L, seed, D, sleep, OUT, kit, api };
