// V6.2-3 (приёмка, вне gate): отказ сервера при перетаскивании/вставке на день больничного — что видит пользователь и где плитка.
'use strict';
const { L, seed, D, sleep, OUT, kit, api } = require('./v62_accept_lib.js');
(async () => {
  const env = await L.startEnv(); const C = L.checker ? L.checker() : null;
  const out = [];
  const log = (n, ok, extra) => { out.push({ name: n, ok: !!ok, extra }); console.log((ok ? '  PASS  ' : '  FAIL  ') + n + (extra ? ' — ' + extra : '')); };
  try {
    const s = await seed(env); const T = s.T;
    const adminCk = s.adminCookies.join('; ');
    const G = (id) => api(env, adminCk, 'GET', 'api/tasks.php?id=' + id).then((r) => r.json.task);
    const A = await env.openBrowser(); const cdp = A.cdp, k = kit(cdp, env), ev = k.ev;
    const WK = '#tasksView .tk-wk';
    const R = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
    const tile = (id) => R('#tasksView .tk-ev-t[data-id="' + id + '"]');
    const slot = (date, min) => R('#tasksView .tk-slot[data-date="' + date + '"][data-min="' + min + '"]');
    await k.size(1280, 900, false); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('calendar');
    await ev('window.Tasks.open(' + JSON.stringify({ employeeId: '', date: D(2), view: 'calendar', mode: 'week' }) + ')');
    await k.waitFor('!window.Tasks.__t.S.loading', 20000); await sleep(600);
    await ev(`document.querySelector('${WK}').scrollTop = 8 * 48`); await sleep(250);
    const st0 = await ev(`document.querySelector('${WK}').scrollTop`);
    const t0 = await tile(T.dog), sl = await slot(D(4), 12 * 60); const wk0 = await R(WK);
    const g0 = await G(T.dog);
    // наблюдатель: все всплывающие/тост-элементы и alert/confirm
    await ev(`window.__msgs = []; new MutationObserver((ms) => { ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) window.__msgs.push((n.className || '') + ' | ' + (n.innerText || '').slice(0, 200)); })); }).observe(document.body, { childList: true, subtree: true });`);
    await ev(`window.__alerts = []; window.alert = (m) => { window.__alerts.push(String(m)); };`);
    await k.drag(t0.cx, t0.y + 8, sl.cx, sl.y + 6, { steps: 8, after: 1500 });
    const g1 = await G(T.dog);
    const st1 = await ev(`document.querySelector('${WK}').scrollTop`);
    const back = await tile(T.dog);
    const msgs = await ev('JSON.stringify(window.__msgs)'); const alerts = await ev('JSON.stringify(window.__alerts)');
    log('сервер не изменил задачу после отказа', g1.start_at === g0.start_at && g1.version === g0.version, g0.start_at + ' → ' + g1.start_at);
    log('scrollTop календаря до/после отказа', true, st0 + ' → ' + st1);
    log('плитка: координаты до/после (в окне)', true, JSON.stringify([t0.y, back && back.y]));
    const wk1 = await R(WK);
    log('плитка после отказа на том же месте относительно сетки (сетка сдвинута баннером ошибки на ' + Math.round(wk1.y - wk0.y) + ' px)', back && Math.abs((back.y - wk1.y) - (t0.y - wk0.y)) <= 3, JSON.stringify([t0.y - wk0.y, back && back.y - wk1.y]));
    log('сообщение пользователю (DOM-добавления)', msgs.length > 4, msgs);
    log('alert()', true, alerts);
    const toast = await ev(`JSON.stringify([...document.querySelectorAll('.tk-ctoast,.tk-toast,.tk-msg,.tk-err,[role=alert],[role=status]')].map((e) => e.className + ' | ' + e.innerText.slice(0, 200)))`);
    log('видимые тосты/ошибки сейчас', true, toast);
    const shadows = await ev(`JSON.stringify([...document.querySelectorAll('#tasksView .tk-shadow,#tasksView .tk-drop,#tasksView [class*=hover],#tasksView .tk-slot-on')].map((e) => { const r = e.getBoundingClientRect(); return e.className + ' @' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }))`);
    log('после отказа не осталось «тени»/подсветки цели перетаскивания', JSON.parse(shadows).filter((x) => /tk-shadow/.test(x)).length === 0, shadows);
    const wkTop = await ev(`document.querySelector('${WK}').getBoundingClientRect().top`);
    log('баннер ошибки сдвигает календарь вниз (layout shift, наблюдение)', true, 'верх сетки: ' + wkTop);
    await sleep(6500);
    const wkTop2 = await ev(`document.querySelector('${WK}').getBoundingClientRect().top`);
    const bannerLeft = await ev(`!!document.querySelector('.tk-msg-error')`);
    log('баннер ошибки сам исчезает/остаётся через 6.5 с (наблюдение)', true, 'баннер: ' + bannerLeft + ', верх сетки: ' + wkTop2);
    await k.shot('F01_reject_after_drag_1280');
    // тот же сценарий: вставка на больничный
    const hit = await ev(`JSON.stringify({ctxMenu: !!document.querySelector('.tk-ctx')})`);
    log('меню ПКМ не осталось открытым', JSON.parse(hit).ctxMenu === false, hit);
    console.log(JSON.stringify({ passed: out.filter((x) => x.ok).length, failed: out.filter((x) => !x.ok).length }));
    require('fs').writeFileSync(OUT + '/F_results.json', JSON.stringify({ checks: out }, null, 1));
  } catch (e) { console.log('ERR', e && e.stack || e); }
  env.cleanup(); process.exit(0);
})();
