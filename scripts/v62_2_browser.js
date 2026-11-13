// V6.2-2 (вне gate): реальный Chromium — перетаскивание плиток календаря (W-5) и копирование ПКМ (W-6).
// Реальные события мыши/касаний через CDP (Input.dispatchMouseEvent / dispatchTouchEvent / synthesizeScrollGesture).
// Каркас — v6_accept_lib.js (php -S на КОПИИ data/app.db; пароли в браузер не вводятся: cookie из api/login.php).
// Запуск: node scripts/v62_2_browser.js [outDir]  → reports/V6_2/V6.2-2_screens/*.png, V62-2_results.json
'use strict';
const path = require('path'), fs = require('fs');
const L = require('./v6_accept_lib.js');
const OUT = path.resolve(process.argv[2] || path.join(L.ROOT, 'reports/V6_2/V6.2-2_screens'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = L.sleep;
const day = (n) => new Date(Date.UTC(2099, 5, 8 + n)).toISOString().slice(0, 10);   // 0 = пн 2099-06-08
const [MON, TUE, WED, THU, FRI, SAT, SUN] = [0, 1, 2, 3, 4, 5, 6].map(day);

(async () => {
  const env = await L.startEnv();
  const C = L.makeChecker(path.join(OUT, 'V62-2_results.json'));
  const check = C.check;
  try {
    const adminCookies = await L.login(env.base, 'admin');
    const ck = adminCookies.join('; ');
    const emp = await L.http(env.base, ck, 'GET', 'api/employees.php');
    const eList = (Array.isArray(emp.json) ? emp.json : emp.json.data || emp.json.employees || []).map((e) => String(e.id));
    const [e1, e2, e3] = eList;
    const mk = async (body) => {
      const r = await L.http(env.base, ck, 'POST', 'api/tasks.php', Object.assign({ assignees: [e1] }, body));
      if (r.status !== 201) throw new Error('seed ' + body.title + ' → ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 200));
      return r.json.task;
    };
    const srv = async (id) => (await L.http(env.base, ck, 'GET', 'api/tasks.php?id=' + id)).json.task;
    const T = {};
    T.s1 = await mk({ title: 'DnD неделя', start_at: WED + 'T10:00', end_at: WED + 'T11:30' });
    T.s2 = await mk({ title: 'DnD Esc', start_at: TUE + 'T14:00', end_at: TUE + 'T15:00', assignees: [e2] });
    T.s3 = await mk({ title: 'Весь день вторник', start_at: TUE });
    T.s4 = await mk({ title: 'Многодневная', start_at: MON + 'T09:00', end_at: WED + 'T17:00', assignees: [e3] });
    T.s5 = await mk({ title: 'Двухчасовая', start_at: FRI + 'T08:00', end_at: FRI + 'T10:00' });
    T.s6 = await mk({
      title: 'Источник копии <b>', description: 'Описание «источника»', priority: 1, label: 'монтаж, срочно', assignees: [e1, e2], watchers: [e3],
      checklist: [{ text: 'пункт а', done: true }, { text: 'пункт б', done: false }], start_at: THU + 'T09:00', end_at: THU + 'T10:30',
    });
    T.s7 = await mk({ title: 'Конфликт версий', start_at: SAT + 'T12:00', end_at: SAT + 'T13:00' });
    T.s8 = await mk({ title: 'Пересечение 1', start_at: FRI + 'T15:00', end_at: FRI + 'T16:00', assignees: [e1] });
    T.s9 = await mk({ title: 'Пересечение 2', start_at: FRI + 'T15:30', end_at: FRI + 'T16:30', assignees: [e2] });
    T.s10 = await mk({ title: 'Пересечение 3', start_at: FRI + 'T15:45', end_at: FRI + 'T17:00', assignees: [e3] });
    T.s11 = await mk({ title: 'Для доски', start_at: SUN + 'T10:00', end_at: SUN + 'T11:00', assignees: [e2] });

    const { cdp, version } = await env.openBrowser();
    C.note('browser', version);
    const k = L.pageKit(cdp, env.base, OUT);
    const ev = (x) => cdp.ev(x);
    const S = (expr) => ev('(() => { const S = window.Tasks.__t.S; return ' + expr + '; })()');
    const mouse = (type, x, y, extra) => cdp.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra || {}));
    const down = async (p) => { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await mouse('mousePressed', p.x, p.y); };
    const move = (p) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
    const up = (p) => mouse('mouseReleased', p.x, p.y);
    const slide = async (from, to, n) => { n = n || 8; for (let i = 1; i <= n; i++) { await move({ x: from.x + (to.x - from.x) * i / n, y: from.y + (to.y - from.y) * i / n }); await sleep(25); } };
    const rclick = async (p) => { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await mouse('mousePressed', p.x, p.y, { button: 'right', buttons: 2 }); await mouse('mouseReleased', p.x, p.y, { button: 'right', buttons: 0 }); await sleep(200); };
    const key = async (name, code) => { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code }); await sleep(150); };
    const settled = async () => { await sleep(150); await k.waitFor('!window.Tasks.__t.S.busy && !window.Tasks.__t.S.loading', 20000); await sleep(350); };
    const calls = () => ev('window.__calls.slice()');
    const resetCalls = () => ev('window.__calls.length = 0');
    const writes = async () => (await calls()).filter((c) => c.m !== 'GET');

    // --- помощники страницы
    const install = () => ev(`(() => {
      window.__calls = []; window.__cm = [];
      if (!window.__fetchPatched) { window.__fetchPatched = true; const of = window.fetch;
        window.fetch = function (u, o) { window.__calls.push({ u: String(u), m: (o && o.method) || 'GET' });
          if (window.__failPut && o && o.method === 'PUT') { window.__failPut = false; return Promise.resolve(new Response(JSON.stringify({ success: false, error: 'end_before_start' }), { status: 400, headers: { 'Content-Type': 'application/json' } })); }
          return of.apply(this, arguments); };
        document.addEventListener('contextmenu', (e) => window.__cm.push({ prevented: e.defaultPrevented, cls: (e.target.className || '') + '' }), false); }
      const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right }; };
      window.__h = {
        wk: () => R(document.querySelector('#tasksView .tk-wk')),
        tile: (id) => R(document.querySelector('#tasksView .tk-cal-bd .tk-ev[data-id="' + id + '"]')),
        adTile: (id, date) => R(document.querySelector('#tasksView .tk-ad-c[data-date="' + date + '"] .tk-ev[data-id="' + id + '"]')),
        day: (date) => R(document.querySelector('#tasksView .tk-day[data-date="' + date + '"]')),
        ad: (date) => R(document.querySelector('#tasksView .tk-ad-c[data-date="' + date + '"]')),
        slot: (date, min) => R(document.querySelector('#tasksView [data-tk-act="calCell"][data-date="' + date + '"][data-min="' + min + '"]')),
        head: (date) => R(document.querySelector('#tasksView .tk-wk-h[data-date="' + date + '"]')),
        shadow: () => { const e = document.querySelector('#tasksView .tk-shadow'); if (!e) return null; const p = e.parentNode.getBoundingClientRect(), r = e.getBoundingClientRect(); return { text: e.textContent, cls: e.className, topInParent: r.top - p.top, h: r.height, parent: e.parentNode.dataset.date, parentCls: e.parentNode.className }; },
        scroll: (top) => { document.querySelector('#tasksView .tk-wk').scrollTop = top; return document.querySelector('#tasksView .tk-wk').scrollTop; },
        menu: () => { const m = document.querySelector('.tk-ctx'); if (!m) return null; const r = m.getBoundingClientRect(); return { text: m.textContent, items: [...m.querySelectorAll('.tk-ctx-i')].map((b) => ({ t: b.textContent, dis: b.disabled, ...(() => { const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })() })), l: r.left, t: r.top, r: r.right, b: r.bottom, vw: innerWidth, vh: innerHeight }; },
        ctoast: () => { const t = document.querySelector('.tk-ctoast'); if (!t) return null; const a = t.querySelector('.tk-ctoast-act'); const q = a && a.getBoundingClientRect(); return { text: t.textContent, act: q ? { x: q.left + q.width / 2, y: q.top + q.height / 2 } : null }; },
        toasts: () => [...document.querySelectorAll('#toastContainer .toast')].map((e) => e.textContent),
      };
      return true; })()`);
    const H = (expr) => ev('window.__h.' + expr);
    const openCal = async (date, mode) => {
      await ev('window.Tasks.open({employeeId:"",date:' + JSON.stringify(date) + ',view:"calendar",mode:' + JSON.stringify(mode) + '})');
      await k.waitFor('!!document.querySelector("#tasksView .tk-cal-bd") && !window.Tasks.__t.S.loading', 30000); await sleep(500);
    };
    const fresh = async (cookies, w, h) => { await k.size(w || 1280, h || 900, false); await k.load(cookies); await install(); };

    // ================================================================ admin 1280
    await fresh(adminCookies);
    await openCal(WED, 'week');
    check('A0 «Неделя» 2099-06-08…14 открыта в реальном Chromium, плитки админа помечены tk-dnd', (await ev('document.querySelectorAll("#tasksView .tk-ev.tk-dnd[data-tk-dnd]").length')) >= 12);

    // ---- W-5 «Неделя»: ср 10:00–11:30 → чт 14:00
    await H('scroll(384)'); await sleep(200);
    let tp = await H('tile("' + T.s1.id + '")');
    const grab = { x: tp.x, y: tp.t + 10 };
    await down(grab);
    let dd = await H('day("' + THU + '")');
    const target = { x: dd.x, y: dd.t + 14 * 48 + 10 + 4 };
    await slide(grab, target);
    let sh = await H('shadow()');
    check('W5-1 «Неделя»: во время перетаскивания видна «тень» в колонке четверга на 14:00 (top 672 px) с подписью «14:00–15:30», исходная плитка бледнеет',
      sh && sh.parent === THU && Math.abs(sh.topInParent - 672) <= 1.5 && /^14:00–15:30$/.test(sh.text.trim()) && (await ev('!!document.querySelector("#tasksView .tk-ev.tk-drag-src[data-id=\\"' + T.s1.id + '\\"]")')) && (await ev('document.getElementById("tasksView").classList.contains("tk-dragging")')), JSON.stringify(sh));
    await k.shot('W5_week_drag_shadow_1280');
    await resetCalls();
    await up(target); await settled();
    let r1 = await srv(T.s1.id);
    check('W5-2 отпустили: на сервере чт 14:00–15:30 (длительность 1 ч 30 мин сохранена, шаг 30), версия 2; один PUT', r1.start_at === THU + 'T14:00' && r1.end_at === THU + 'T15:30' && r1.version === 2 && (await writes()).length === 1 && (await writes())[0].m === 'PUT', JSON.stringify([r1.start_at, r1.end_at, r1.version, await writes()]));
    tp = await H('tile("' + T.s1.id + '")'); dd = await H('day("' + THU + '")');
    check('W5-3 плитка перерисована в четверге на 14:00 (top = 672 px, высота 72 px); «тени» и режима перетаскивания нет; карточка не открылась (click подавлен)',
      Math.abs(tp.t - dd.t - 672) <= 1.5 && Math.abs(tp.h - 72) <= 1.5 && !(await H('shadow()')) && !(await ev('document.getElementById("tasksView").classList.contains("tk-dragging")')) && (await S('S.selectedId')) === null && (await S('S.form')) === null);
    check('W5-4 тост «Задача перенесена: 11.06 14:00»', (await H('toasts()')).some((t) => /Задача перенесена: 11\.06 14:00/.test(t)), JSON.stringify(await H('toasts()')));
    await k.shot('W5_week_after_drop_1280');

    // ---- W-5 «День»: чт 14:00 → 16:30 в той же колонке
    await ev('document.querySelector("#tasksView [data-tk-act=\\"calMode\\"][data-mode=\\"day\\"]").click()'); await settled();
    await ev('(() => { window.Tasks.__t.S.cal.anchor = "' + THU + '"; window.Tasks.reload(); })()'); await settled();
    await H('scroll(384)'); await sleep(200);
    check('W5-5 режим «День» (чт 11.06): одна колонка, плитка на месте', (await ev('document.querySelectorAll("#tasksView .tk-wk-h").length')) === 1 && !!(await H('tile("' + T.s1.id + '")')));
    tp = await H('tile("' + T.s1.id + '")');
    const g2 = { x: tp.x, y: tp.t + 12 };
    await down(g2);
    dd = await H('day("' + THU + '")');
    const t2 = { x: tp.x, y: dd.t + 16.5 * 48 + 12 };
    await slide(g2, t2);
    sh = await H('shadow()');
    check('W5-6 «День»: тень на 16:30, подпись «16:30–18:00»', sh && Math.abs(sh.topInParent - 16.5 * 48) <= 1.5 && /^16:30–18:00$/.test(sh.text.trim()), JSON.stringify(sh));
    await k.shot('W5_day_drag_shadow_1280');
    await up(t2); await settled();
    r1 = await srv(T.s1.id);
    check('W5-7 «День»: на сервере чт 16:30–18:00', r1.start_at === THU + 'T16:30' && r1.end_at === THU + 'T18:00' && r1.version === 3, JSON.stringify([r1.start_at, r1.end_at, r1.version]));

    // ---- W-5 «Весь день»
    await ev('document.querySelector("#tasksView [data-tk-act=\\"calMode\\"][data-mode=\\"week\\"]").click()'); await settled();
    await ev('(() => { window.Tasks.__t.S.cal.anchor = "' + WED + '"; window.Tasks.reload(); })()'); await settled();
    await H('scroll(384)'); await sleep(200);
    let at = await H('adTile("' + T.s3.id + '","' + TUE + '")'), ac = await H('ad("' + THU + '")');
    await down({ x: at.x, y: at.y });
    await slide({ x: at.x, y: at.y }, { x: ac.x, y: ac.y }, 10);
    sh = await H('shadow()');
    check('W5-8 «Весь день»: тень в ячейке чт полосы «Весь день», подпись с новой датой («Чт 11.06»)', sh && sh.parent === THU && /Чт 11\.06/.test(sh.text) && /tk-ad-c/.test(sh.parentCls), JSON.stringify(sh));
    await k.shot('W5_allday_drag_shadow_1280');
    await up({ x: ac.x, y: ac.y }); await settled();
    const r3 = await srv(T.s3.id);
    check('W5-9 «Весь день»: на сервере start_at = 2099-06-11 (только дата, времени нет), конца нет', r3.start_at === THU && r3.end_at === null, JSON.stringify([r3.start_at, r3.end_at]));
    // многодневная (пн 09:00 → ср 17:00): хватаем за вторник, бросаем на среду (+1 день)
    at = await H('adTile("' + T.s4.id + '","' + TUE + '")'); ac = await H('ad("' + WED + '")');
    await down({ x: at.x, y: at.y }); await slide({ x: at.x, y: at.y }, { x: ac.x, y: ac.y }, 8);
    sh = await H('shadow()');
    await up({ x: ac.x, y: ac.y }); await settled();
    const r4 = await srv(T.s4.id);
    check('W5-10 многодневная, +1 день: оба конца сдвинуты, время суток прежнее (вт 09:00 → чт 17:00); тень подписана диапазоном «09.06 — 11.06»', r4.start_at === TUE + 'T09:00' && r4.end_at === THU + 'T17:00' && sh && /09\.06 — 11\.06/.test(sh.text), JSON.stringify([r4.start_at, r4.end_at, sh && sh.text]));

    // ---- Esc
    await H('scroll(384)'); await sleep(200);
    tp = await H('tile("' + T.s2.id + '")'); dd = await H('day("' + THU + '")');
    const g3 = { x: tp.x, y: tp.t + 10 }, t3 = { x: dd.x, y: dd.t + 11 * 48 + 14 };
    await down(g3); await slide(g3, t3);
    check('W5-11 перед Esc тень есть (чт 11:00)', !!(await H('shadow()')));
    await resetCalls();
    await key('Escape', 27);
    check('W5-12 Esc: тень пропала, плитка вернулась к обычному виду (tk-drag-src снят, режим tk-dragging снят)', !(await H('shadow()')) && !(await ev('document.querySelector("#tasksView .tk-drag-src")')) && !(await ev('document.getElementById("tasksView").classList.contains("tk-dragging")')));
    await slide(t3, { x: t3.x - 60, y: t3.y + 40 }, 4);
    await up({ x: t3.x - 60, y: t3.y + 40 }); await sleep(500);
    const r2 = await srv(T.s2.id);
    check('W5-13 отпускание после Esc: запросов на запись нет, на сервере прежнее время (вт 14:00–15:00), карточка и форма не открылись', (await writes()).length === 0 && r2.start_at === TUE + 'T14:00' && r2.version === 1 && (await S('S.selectedId')) === null && (await S('S.form')) === null);
    await k.shot('W5_after_esc_1280');

    // ---- отпустили на старом месте
    tp = await H('tile("' + T.s2.id + '")');
    const g4 = { x: tp.x, y: tp.t + 10 };
    await down(g4); await slide(g4, { x: g4.x + 30, y: g4.y + 60 }, 5); await slide({ x: g4.x + 30, y: g4.y + 60 }, { x: g4.x + 1, y: g4.y + 1 }, 5);
    const shSame = await H('shadow()');
    await up({ x: g4.x + 1, y: g4.y + 1 }); await sleep(500);
    check('W5-14 отпустили на старом месте: тень «серая» (без изменений), записей нет, версия 1, карточка не открылась', shSame && /tk-shadow-same/.test(shSame.cls) && (await writes()).length === 0 && (await srv(T.s2.id)).version === 1 && (await S('S.selectedId')) === null);

    // ---- простой клик открывает карточку
    tp = await H('tile("' + T.s2.id + '")');
    await k.clickXY(tp.x, tp.y); await sleep(400);
    check('W5-15 простой клик по плитке (без сдвига) открывает карточку справа', (await S('S.selectedId')) === T.s2.id && /DnD Esc/.test(await ev('(document.querySelector("#tasksView .tk-detail")||{}).textContent||""')) && (await writes()).length === 0);
    await ev('window.Tasks.__t.S.selectedId = null; window.Tasks.__t.render()');

    // ---- граница 23:59 + автопрокрутка у нижнего края
    await H('scroll(384)'); await sleep(200);
    tp = await H('tile("' + T.s5.id + '")');
    const g5 = { x: tp.x, y: tp.t + 10 };
    await down(g5);
    const wkR = await H('wk()');
    const bottom = { x: g5.x, y: wkR.b - 10 };
    await slide(g5, bottom, 6);
    const sc0 = await ev('document.querySelector("#tasksView .tk-wk").scrollTop');
    for (let i = 0; i < 45; i++) { await move({ x: bottom.x + (i % 2), y: bottom.y }); await sleep(40); }
    const sc1 = await ev('document.querySelector("#tasksView .tk-wk").scrollTop');
    check('W5-16 автопрокрутка: пока курсор у нижнего края календаря, сетка сама прокручивается вниз', sc1 > sc0 + 150, sc0 + ' → ' + sc1);
    dd = await H('day("' + FRI + '")');
    const t5 = { x: dd.x, y: dd.t + 23.5 * 48 + 10 + 3 };
    // дошли до 23:30 — курсор уже у края; ставим на 23:30 (сетка прокручена до конца)
    await move(t5); await sleep(80);
    sh = await H('shadow()');
    check('W5-17 граница суток: 2-часовая задача, брошенная на 23:30 — тень «23:30–23:59» (конец не за 23:59)', sh && /^23:30–23:59$/.test(sh.text.trim()), JSON.stringify(sh));
    await k.shot('W5_autoscroll_2359_1280');
    await up(t5); await settled();
    const r5 = await srv(T.s5.id);
    check('W5-18 на сервере пт 23:30–23:59', r5.start_at === FRI + 'T23:30' && r5.end_at === FRI + 'T23:59', JSON.stringify([r5.start_at, r5.end_at]));

    // ---- ошибка проверки: откат плитки + сообщение
    await H('scroll(384)'); await sleep(200);
    tp = await H('tile("' + T.s8.id + '")');
    // s8 в пятницу 15:00; scrollTop 384 показывает 08:00…≈20:00
    const g6 = { x: tp.x, y: tp.t + 8 };
    const bef6 = await srv(T.s8.id);
    await ev('window.__failPut = true');
    dd = await H('day("' + MON + '")');
    const t6 = { x: dd.x, y: dd.t + 12 * 48 + 8 };
    await down(g6); await slide(g6, t6, 10); await up(t6); await settled();
    const aft6 = await srv(T.s8.id);
    const tp6 = await H('tile("' + T.s8.id + '")'), dFri = await H('day("' + FRI + '")');
    check('W5-19 ошибка сохранения (400 end_before_start): сообщение «Перенос не выполнен…», плитка откатилась в пятницу на 15:00, на сервере без изменений',
      aft6.version === bef6.version && /Перенос не выполнен/.test(await S('(S.msg||{}).text||""')) && tp6 && Math.abs(tp6.t - dFri.t - 15 * 48) <= 1.5 && (await H('toasts()')).some((t) => /Перенос не выполнен/.test(t)), JSON.stringify([await S('S.msg'), tp6, dFri]));
    await k.shot('W5_rollback_error_1280');
    await ev('window.Tasks.__t.S.msg = null; window.Tasks.__t.render()');

    // ---- 409: две вкладки
    const b2 = await env.openBrowser();
    const k2 = L.pageKit(b2.cdp, env.base, OUT);
    await k2.size(1280, 900); await k2.load(adminCookies);
    await b2.cdp.ev('window.Tasks.open({employeeId:"",date:"' + WED + '",view:"calendar",mode:"week"})');
    await k2.waitFor('!!document.querySelector("#tasksView .tk-cal-bd") && !window.Tasks.__t.S.loading', 30000); await sleep(500);
    await b2.cdp.ev('document.querySelector("#tasksView .tk-wk").scrollTop = 384'); await sleep(200);
    // вкладка 2: сдвигает «Конфликт версий» (сб 12:00 → 14:00)
    const tp2 = await b2.cdp.ev('(() => { const e = document.querySelector("#tasksView .tk-cal-bd .tk-ev[data-id=\\"' + T.s7.id + '\\"]"); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 8 }; })()');
    const sat2 = await b2.cdp.ev('(() => { const r = document.querySelector("#tasksView .tk-day[data-date=\\"' + SAT + '\\"]").getBoundingClientRect(); return { x: r.left + r.width / 2, t: r.top }; })()');
    const m2 = (type, x, y) => b2.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    await b2.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tp2.x, y: tp2.y }); await m2('mousePressed', tp2.x, tp2.y);
    for (let i = 1; i <= 6; i++) { await b2.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tp2.x, y: tp2.y + 24 * 2 * i / 6 * 2 + 0, button: 'left', buttons: 1 }); await sleep(20); }
    await m2('mouseReleased', tp2.x, tp2.y + 96); await k2.waitFor('!window.Tasks.__t.S.busy', 15000); await sleep(600);
    const s7b = await srv(T.s7.id);
    check('W5-20 (вкладка 2) перенос «Конфликт версий» прошёл: версия 2', s7b.version === 2 && s7b.start_at !== SAT + 'T12:00', JSON.stringify([s7b.start_at, s7b.version]));
    // вкладка 1: устаревшая плитка (версия 1) → перенос → 409
    await H('scroll(384)'); await sleep(200);
    tp = await H('tile("' + T.s7.id + '")'); dd = await H('day("' + SAT + '")');
    const g7 = { x: tp.x, y: tp.t + 8 }, t7 = { x: dd.x, y: dd.t + 18 * 48 + 8 };
    await resetCalls();
    await down(g7); await slide(g7, t7, 10); await up(t7); await settled();
    const s7c = await srv(T.s7.id);
    const loc7 = await S('(S.tasks.find((t) => t.id === "' + T.s7.id + '") || {}).version');
    check('W5-21 409 (две вкладки): понятное сообщение («…изменена другим пользователем…»), перенос не применён, задачи перечитаны (у плитки версия 2)',
      /другим пользователем/.test(await S('(S.msg||{}).text||""')) && s7c.start_at === s7b.start_at && s7c.version === 2 && loc7 === 2 && (await H('toasts()')).some((t) => /Конфликт версий/.test(t)), JSON.stringify([await S('S.msg'), s7c.start_at, loc7]));
    await k.shot('W5_409_conflict_1280');
    await ev('window.Tasks.__t.S.msg = null; window.Tasks.__t.render()');

    // ================================================================ W-6 копирование
    await install();
    await fresh(adminCookies);
    await openCal(WED, 'week');
    await H('scroll(384)'); await sleep(200);
    // «Вставить» неактивно, пока ничего не скопировано
    let cell = await H('slot("' + MON + '", 600)');
    await rclick(cell);
    let mn = await H('menu()');
    const cm0 = await ev('window.__cm.slice(-1)[0]');
    check('W6-1 ПКМ по пустой ячейке (пн 10:00) до «Копировать»: своё меню, нативное подавлено, единственный пункт «Вставить» — неактивен',
      mn && mn.items.length === 1 && mn.items[0].t === 'Вставить' && mn.items[0].dis === true && cm0 && cm0.prevented === true, JSON.stringify([mn, cm0]));
    await k.shot('W6_menu_paste_disabled_1280');
    await key('Escape', 27);
    check('W6-2 Esc закрывает меню', !(await H('menu()')));
    // нативное меню не подавляется над шапкой
    const hd = await H('head("' + TUE + '")');
    await rclick(hd);
    const cmH = await ev('window.__cm.slice(-1)[0]');
    check('W6-3 ПКМ над заголовком дня (не плитка/ячейка): наше меню не открывается, нативное не подавлено', !(await H('menu()')) && cmH && cmH.prevented === false, JSON.stringify(cmH));
    // ПКМ по плитке
    tp = await H('tile("' + T.s6.id + '")');
    await rclick({ x: tp.x, y: tp.y });
    mn = await H('menu()');
    const cm1 = await ev('window.__cm.slice(-1)[0]');
    check('W6-4 ПКМ по плитке: нативное подавлено, своё меню в позиции курсора с пунктом «Копировать»', mn && mn.items.length === 1 && mn.items[0].t === 'Копировать' && !mn.items[0].dis && cm1 && cm1.prevented === true && Math.abs(mn.l - tp.x) < 4 && Math.abs(mn.t - tp.y) < 4, JSON.stringify([mn, cm1, tp]));
    await k.shot('W6_menu_tile_1280');
    // закрытие кликом мимо и прокруткой
    const ttl = await H('head("' + TUE + '")');
    await k.clickXY(ttl.x, ttl.y); await sleep(200);
    check('W6-5 клик мимо закрывает меню', !(await H('menu()')));
    await rclick({ x: tp.x, y: tp.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: tp.x, y: tp.y, deltaX: 0, deltaY: 120 }); await sleep(250);
    check('W6-6 прокрутка (колесо) закрывает меню', !(await H('menu()')));
    // Копировать
    await H('scroll(384)'); await sleep(250);
    tp = await H('tile("' + T.s6.id + '")');
    await rclick({ x: tp.x, y: tp.y });
    mn = await H('menu()');
    if (!mn) console.log('DEBUG', JSON.stringify(tp), JSON.stringify(await ev('({ cm: window.__cm.slice(-2), el: (document.elementFromPoint(' + tp.x + ',' + tp.y + ')||{}).className, scroll: document.querySelector("#tasksView .tk-wk").scrollTop })')));
    if (mn) { await k.clickXY(mn.items[0].x, mn.items[0].y); await sleep(300); }
    check('W6-7 «Копировать»: меню закрылось, тост «Скопировано: «Источник копии <b>»…», запросов записи нет, исходная задача не тронута',
      !(await H('menu()')) && (await H('toasts()')).some((t) => /Скопировано: «Источник копии <b>»/.test(t)) && (await writes()).length === 0 && (await srv(T.s6.id)).version === 1, JSON.stringify(await H('toasts()')));
    // Вставить в пн 10:00 → начало 10:00, длительность 1 ч 30 мин
    cell = await H('slot("' + MON + '", 600)');
    await rclick(cell);
    mn = await H('menu()');
    check('W6-8 ПКМ по пустой ячейке после «Копировать»: «Вставить» активно', mn && mn.items[0].t === 'Вставить' && mn.items[0].dis === false);
    await k.shot('W6_menu_cell_1280');
    await resetCalls();
    await k.clickXY(mn.items[0].x, mn.items[0].y);
    await sleep(120);
    const flash0 = await ev('document.querySelectorAll("#tasksView .tk-ev.tk-flash").length');
    await settled();
    const flashNow = await ev('document.querySelectorAll("#tasksView .tk-ev.tk-flash").length');
    const copies = async (from, to) => (await L.http(env.base, ck, 'GET', 'api/tasks.php?from=' + (from || MON) + '&to=' + (to || SUN))).json.tasks.filter((t) => t.title === 'Источник копии <b>' && t.id !== T.s6.id);
    let cps = await copies();
    const cA = cps.find((t) => t.start_at === MON + 'T10:00');
    check('W6-9 «Вставить» создаёт задачу сразу (один POST): пн 10:00–11:30, тема, описание, приоритет 1, метка «как есть», статус «Открыта»',
      (await writes()).length === 1 && (await writes())[0].m === 'POST' && cA && cA.end_at === MON + 'T11:30' && cA.description === 'Описание «источника»' && cA.priority === 1 && cA.label === 'монтаж, срочно' && cA.status === 'open', JSON.stringify([await writes(), cA]));
    check('W6-10 исполнители, наблюдатели и чек-лист (пункты без отметок) скопированы', cA && cA.assignees.map((x) => x.employee_id).sort().join() === [e1, e2].sort().join() && cA.watchers.map((x) => x.employee_id).join() === e3 && cA.checklist.map((c) => c.text + ':' + c.done).join('|') === 'пункт а:false|пункт б:false', JSON.stringify(cA && [cA.assignees, cA.watchers, cA.checklist]));
    const ctw = await H('ctoast()');
    check('W6-11 новая плитка подсвечена (tk-flash), всплывающее сообщение «Скопировано на 08.06 10:00» с действием «Открыть»', (flash0 === 1 || flashNow === 1) && ctw && /Скопировано на 08\.06 10:00/.test(ctw.text) && /Открыть/.test(ctw.text), JSON.stringify([flash0, flashNow, ctw]));
    await k.shot('W6_pasted_highlight_toast_1280');
    await k.clickXY(ctw.act.x, ctw.act.y); await sleep(400);
    check('W6-12 «Открыть» открывает карточку копии (справа её тема и описание), сообщение закрыто', (await S('S.selectedId')) === cA.id && /Описание «источника»/.test(await ev('(document.querySelector("#tasksView .tk-detail")||{}).textContent||""')) && !(await H('ctoast()')));
    await k.shot('W6_open_card_from_toast_1280');
    // второй раз — тот же буфер: «Весь день» среда, и 23:30 воскресенья
    const adC = await H('ad("' + WED + '")');
    await rclick(adC); mn = await H('menu()'); await k.clickXY(mn.items[0].x, mn.items[0].y); await settled();
    await H('scroll(2000)'); await sleep(250);
    const cellN = await H('slot("' + SUN + '", 1410)');
    await rclick(cellN); mn = await H('menu()'); await k.clickXY(mn.items[0].x, mn.items[0].y); await settled();
    cps = await copies();
    const cB = cps.find((t) => t.start_at === WED), cC = cps.find((t) => t.start_at === SUN + 'T23:30');
    check('W6-13 тот же буфер вставляется повторно: «Весь день» ср — без времени (start_at = дата, конца нет); вс 23:30 — конец прижат к 23:59',
      cps.length === 3 && cB && cB.end_at === null && cC && cC.end_at === SUN + 'T23:59', JSON.stringify(cps.map((t) => [t.start_at, t.end_at])));
    check('W6-14 все копии открыты, оригинал не изменился', cps.every((t) => t.status === 'open') && (await srv(T.s6.id)).version === 1);
    // перезагрузка страницы: буфер в памяти страницы — после неё «Вставить» снова неактивно
    await fresh(adminCookies); await openCal(WED, 'week'); await H('scroll(384)'); await sleep(200);
    cell = await H('slot("' + MON + '", 840)'); await rclick(cell); mn = await H('menu()');
    check('W6-15 буфер хранится в памяти страницы (не в системном буфере): после перезагрузки «Вставить» снова неактивно', mn && mn.items[0].dis === true);
    await key('Escape', 27);

    // ================================================================ регрессия 1280
    // R-10: клик по пустой ячейке → «Новая задача»
    cell = await H('slot("' + FRI + '", 660)');
    await k.clickXY(cell.x, cell.y); await sleep(400);
    const form = await ev(`(() => { const g = (f) => { const e = document.querySelector('#tasksView [data-tk-field="' + f + '"]'); return e ? e.value : null; }; return { form: !!document.querySelector('#tasksView form.tk-form'), h4: (document.querySelector('#tasksView .tk-form h4')||{}).textContent, sd: g('startDate'), st: g('startTime'), et: g('endTime') }; })()`);
    check('REG-1 (R-10) клик по пустой ячейке пт 11:00 по-прежнему открывает «Новая задача»: 11:00–12:00', form.form && form.h4 === 'Новая задача' && form.sd === FRI && form.st === '11:00' && form.et === '12:00', JSON.stringify(form));
    await ev('document.querySelector(\'#tasksView [data-tk-act="cancelForm"]\').click()'); await sleep(300);
    // R-11: пересечения рядом
    await H('scroll(384)'); await sleep(200);
    const lanes = await ev(`[...document.querySelectorAll('#tasksView .tk-cal-bd .tk-ev')].filter((e) => /Пересечение/.test(e.textContent)).map((e) => { const r = e.getBoundingClientRect(), d = e.parentNode.getBoundingClientRect(); return { cols: +e.dataset.cols, w: r.width, dw: d.width, x: Math.round(r.left) }; })`);
    check('REG-2 (R-11) три пересекающиеся в пятницу — по-прежнему 3 дорожки по ~1/3 ширины, рядом', lanes.length === 3 && lanes.every((l) => l.cols === 3 && Math.abs(l.w - (l.dw / 3 - 6)) <= 2) && new Set(lanes.map((l) => l.x)).size === 3, JSON.stringify(lanes));
    // Доска: drag&drop Открыта → Закрыта и обратно
    await ev('window.Tasks.open({employeeId:"",date:"' + WED + '",view:"board"})'); await k.waitFor('!window.Tasks.__t.S.loading && !!document.querySelector("#tasksView .tk-col")', 20000); await sleep(500);
    let dragData = null;
    cdp.ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Input.dragIntercepted') dragData = d.params.data; });
    const dragFromTo = async (from, to) => {
      dragData = null;
      await cdp.send('Input.setInterceptDrags', { enabled: true });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 6 && !dragData; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + i * 6, y: from.y + i * 6, button: 'left', buttons: 1 }); await sleep(60); }
      if (!dragData) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x, y: from.y, button: 'left' }); await cdp.send('Input.setInterceptDrags', { enabled: false }); return false; }
      for (const t of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type: t, x: to.x, y: to.y, data: dragData });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left' });
      await cdp.send('Input.setInterceptDrags', { enabled: false });
      await sleep(900); return true;
    };
    const vis = (sel) => ev(`(() => { const e = document.querySelector('${sel}'); e.scrollIntoView({block:"center"}); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const from = await vis('.tk-card[data-id="' + T.s11.id + '"] b');
    const to = await ev(`(() => { const r = document.querySelector('.tk-col[data-tk-col="closed"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: ${from.y} }; })()`);
    const started = await dragFromTo(from, to);
    check('REG-3 drag&drop Доски (HTML5, реальные события): «Для доски» перенесена «Открыта» → «Закрыта», на сервере status=closed', started && (await srv(T.s11.id)).status === 'closed', JSON.stringify({ started }));
    await k.shot('REG_board_drag_1280');

    // ================================================================ роли
    for (const [role, user] of [['supervisor', 'supervisor_zone0'], ['viewer', 'viewer_test']]) {
      await fresh(await L.login(env.base, user));
      await openCal(WED, 'week'); await H('scroll(384)'); await sleep(200);
      const who = await S('(S.user||{}).role');
      tp = await H('tile("' + T.s6.id + '")'); dd = await H('day("' + MON + '")');
      await resetCalls();
      await down({ x: tp.x, y: tp.t + 10 }); await slide({ x: tp.x, y: tp.t + 10 }, { x: dd.x, y: dd.t + 600 }, 8);
      const shR = await H('shadow()');
      await up({ x: dd.x, y: dd.t + 600 }); await sleep(500);
      const dnd = await ev('document.querySelectorAll("#tasksView .tk-dnd, #tasksView [data-tk-dnd]").length');
      const dragging = await ev('document.getElementById("tasksView").classList.contains("tk-dragging")');
      check('RL-' + role + '-1 (' + who + ') реальное перетаскивание плитки: тени нет, плитки без tk-dnd, записей нет, версия 1', !shR && dnd === 0 && !dragging && (await writes()).length === 0 && (await srv(T.s6.id)).version === 1, JSON.stringify([shR, dnd, await writes()]));
      tp = await H('tile("' + T.s6.id + '")');
      await rclick({ x: tp.x, y: tp.y });
      const cmT = await ev('window.__cm.slice(-1)[0]');
      const cellR = await H('head("' + TUE + '")');
      await rclick(cellR);
      const cmC = await ev('window.__cm.slice(-1)[0]');
      check('RL-' + role + '-2 ПКМ по плитке и по ячейке: нативное меню браузера не подавлено, нашего меню нет', !(await H('menu()')) && cmT && cmT.prevented === false && cmC && cmC.prevented === false, JSON.stringify([cmT, cmC]));
      if (role === 'viewer') await k.shot('RL_viewer_no_dnd_no_menu_1280');
    }
    // ================================================================ 375: касания (реальные touch-события) и мышь
    await fresh(adminCookies, 375, 812);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await openCal(WED, 'week');
    await ev('window.Tasks.__t.S.selectedId = null; window.Tasks.__t.render()'); await sleep(200);
    const tch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    const vTile = () => ev(`(() => { const w = document.querySelector('#tasksView .tk-wk').getBoundingClientRect();
      const L = [...document.querySelectorAll('#tasksView .tk-cal-bd .tk-ev')].map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.id, x: r.left + r.width / 2, y: r.top + Math.min(12, r.height / 2), l: r.left, r: r.right, t: r.top, b: r.bottom }; })
        .filter((q) => q.x > w.left + 52 && q.x < w.right - 6 && q.y > w.top + 90 && q.y < w.bottom - 10); return L.sort((a, b) => a.x - b.x); })()`);
    await H('scroll(300)'); await sleep(250);
    await resetCalls();
    let vt = await vTile();
    check('M-0 375 px: в видимой области календаря есть плитки для проверки касаний', vt.length >= 1, JSON.stringify(vt));
    const p0 = vt[0];
    const st0 = await ev('document.querySelector("#tasksView .tk-wk").scrollTop');
    // прокрутка пальцем, начатая ПРЯМО на плитке: палец идёт вверх → календарь прокручивается вниз
    await tch('touchStart', p0.x, p0.y);
    for (let i = 1; i <= 12; i++) { await tch('touchMove', p0.x, p0.y - i * 12); await sleep(25); }
    const shM = await H('shadow()'), drM = await ev('document.getElementById("tasksView").classList.contains("tk-dragging")');
    await tch('touchEnd', p0.x, p0.y - 144); await sleep(500);
    const st1 = await ev('document.querySelector("#tasksView .tk-wk").scrollTop');
    check('M-1 375 px: прокрутка пальцем, начатая на плитке, прокручивает календарь (scrollTop вырос), а не тянет плитку: тени и режима перетаскивания нет, записей нет, карточка не открылась',
      st1 > st0 + 60 && !shM && !drM && (await writes()).length === 0 && (await S('S.selectedId')) === null, JSON.stringify([st0, st1, shM, await writes()]));
    await k.shot('M_touch_scroll_375');
    // горизонтальная прокрутка пальцем
    await H('scroll(300)'); await sleep(200);
    vt = await vTile(); const p1 = vt[0];
    const sl0 = await ev('document.querySelector("#tasksView .tk-wk").scrollLeft');
    await tch('touchStart', p1.x, p1.y);
    for (let i = 1; i <= 12; i++) { await tch('touchMove', p1.x - i * 14, p1.y); await sleep(25); }
    const shH = await H('shadow()');
    await tch('touchEnd', p1.x - 168, p1.y); await sleep(500);
    const sl1 = await ev('document.querySelector("#tasksView .tk-wk").scrollLeft');
    check('M-2 375 px: горизонтальная прокрутка пальцем (от плитки) работает как раньше (scrollLeft вырос), перетаскивания и записей нет', sl1 > sl0 + 60 && !shH && (await writes()).length === 0, JSON.stringify([sl0, sl1, shH]));
    // диагональный жест (вниз-вправо) — тоже не перетаскивание
    await ev('document.querySelector("#tasksView .tk-wk").scrollLeft = 0'); await H('scroll(300)'); await sleep(250);
    vt = await vTile(); const p2 = vt[0];
    await tch('touchStart', p2.x, p2.y);
    for (let i = 1; i <= 8; i++) { await tch('touchMove', p2.x + i * 8, p2.y + i * 10); await sleep(25); }
    const shD = await H('shadow()');
    await tch('touchEnd', p2.x + 64, p2.y + 80); await sleep(500);
    check('M-3 375 px: диагональное движение пальцем от плитки — перетаскивания нет, записей на сервер нет', !shD && (await writes()).length === 0, JSON.stringify([shD, await writes()]));
    // тап по плитке открывает карточку, как раньше
    await H('scroll(300)'); await sleep(250);
    vt = await vTile(); const p3 = vt[0];
    await tch('touchStart', p3.x, p3.y); await sleep(60); await tch('touchEnd', p3.x, p3.y); await sleep(500);
    check('M-4 375 px: тап по плитке открывает карточку (как раньше); записей нет', (await S('S.selectedId')) === p3.id && (await writes()).length === 0, await S('S.selectedId'));
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
    // мышью на узком окне: перетаскивание и меню работают, меню помещается в окно
    await ev('window.Tasks.__t.S.selectedId = null; window.Tasks.__t.render()'); await sleep(200);
    await H('scroll(300)'); await sleep(250);
    vt = await vTile();
    const pr = vt[vt.length - 1];
    await rclick({ x: pr.x, y: pr.y });
    mn = await H('menu()');
    check('M-5 375 px, мышь: ПКМ по плитке у правого края — меню помещается в окно (не выходит за правый/нижний край)', mn && mn.r <= mn.vw && mn.b <= mn.vh && mn.l >= 0, JSON.stringify([mn, pr]));
    await k.shot('M_menu_375');
    await key('Escape', 27);
    {
      const pm = vt[0], dayW = await ev('(() => { const r = document.querySelector("#tasksView .tk-day").getBoundingClientRect(); return r.width; })()');
      await resetCalls();
      await down({ x: pm.x, y: pm.y }); await slide({ x: pm.x, y: pm.y }, { x: pm.x + 40, y: pm.y + 48 * 3 }, 6);
      const shMouse = await H('shadow()');
      await k.shot('M_mouse_drag_shadow_375');
      await key('Escape', 27);
      await up({ x: pm.x + 40, y: pm.y + 48 * 3 }); await sleep(400);
      check('M-6 375 px, мышь: перетаскивание мышью работает (тень видна), Esc отменяет — записей нет', !!shMouse && (await writes()).length === 0, JSON.stringify([shMouse, dayW]));
    }

    check('Z-0 необработанных исключений на странице за весь прогон нет', cdp.exceptions.length === 0, cdp.exceptions.join(' | '));
  } catch (e) {
    C.check('FATAL', false, (e && e.stack) || e);
  } finally {
    env.cleanup();
  }
  C.save();
  console.log('RESULT: ' + C.passed + ' passed, ' + C.failed + ' failed');
  process.exit(C.failed ? 1 : 0);
})();
