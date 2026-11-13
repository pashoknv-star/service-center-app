// V6.2-3 (приёмка, вне gate): B — W-5 (перетаскивание), W-6 (ПКМ копировать/вставить), роли, 375 (касания), стыки веток.
// Запуск: node scripts/v62_accept_b_calendar.js → reports/V6_2/V6.2-3_screens/B_*.png, B_results.json
'use strict';
const path = require('path');
const { L, seed, D, sleep, OUT, kit, api } = require('./v62_accept_lib.js');

(async () => {
  const C = L.makeChecker(path.join(OUT, 'B_results.json'));
  const env = await L.startEnv();
  try {
    const s = await seed(env);
    const adminCk = s.adminCookies.join('; ');
    const mk = async (title, start, end, as, extra) => { const r = await api(env, adminCk, 'POST', 'api/tasks.php', Object.assign({ title, start_at: start, end_at: end, assignees: as }, extra || {})); if (r.status !== 201) throw new Error(title + ' ' + r.status + JSON.stringify(r.json)); return r.json.task.id; };
    const G = (id) => api(env, adminCk, 'GET', 'api/tasks.php?id=' + id).then((r) => r.json.task);
    const X = {};
    X.orig = await mk('Оригинал', D(7) + 'T10:00', D(7) + 'T11:30', ['emp_1', 'emp_2'], { watchers: ['emp_3'], description: 'Описание оригинала <b>x</b>', priority: 1, label: 'alpha, beta', checklist: [{ text: 'Пункт A', done: true }, { text: 'Пункт B', done: false }] });
    X.day = await mk('День-тест', D(8) + 'T09:00', D(8) + 'T10:00', ['emp_4']);
    X.ad = await mk('Без времени', D(9), null, ['emp_1']);
    X.multi = await mk('Многодневная', D(9) + 'T09:00', D(10) + 'T18:00', ['emp_3']);
    X.long = await mk('Длинная', D(10) + 'T20:00', D(10) + 'T22:00', ['emp_2']);
    X.conf = await mk('Конфликт', D(11) + 'T10:00', D(11) + 'T11:00', ['emp_4']);
    X.p1 = await mk('Пер1', D(12) + 'T09:00', D(12) + 'T10:00', ['emp_1']);
    X.p2 = await mk('Пер2', D(12) + 'T09:00', D(12) + 'T10:00', ['emp_2']);
    X.p3 = await mk('Пер3', D(12) + 'T09:30', D(12) + 'T10:30', ['emp_3']);
    X.clk = await mk('Клик', D(13) + 'T12:00', D(13) + 'T13:00', ['emp_1']);
    X.closed = await mk('Закрытая для копии', D(7) + 'T15:00', D(7) + 'T16:00', ['emp_4'], { checklist: [{ text: 'Сделано', done: true }] });
    await api(env, adminCk, 'POST', 'api/tasks.php?id=' + X.closed + '&action=close', {});
    const A = await env.openBrowser(); C.note('browser', A.version);
    const cdp = A.cdp, k = kit(cdp, env), ev = k.ev;

    const WK = '#tasksView .tk-wk';
    const openCal = async (mode, date) => { await ev('window.Tasks.open(' + JSON.stringify({ employeeId: '', date: date || D(7), view: 'calendar', mode: mode || 'week' }) + ')'); await k.waitFor('!window.Tasks.__t.S.loading', 20000); await sleep(600); };
    const scrollTo = async (hour) => { await ev(`document.querySelector('${WK}').scrollTop = ${hour} * 48`); await sleep(250); };
    const R = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
    const tile = (id) => R('#tasksView .tk-ev-t[data-id="' + id + '"]');
    const slot = (date, min) => R('#tasksView .tk-slot[data-date="' + date + '"][data-min="' + min + '"]');
    const adc = (date) => R('#tasksView .tk-ad-c[data-date="' + date + '"]');
    const shadow = () => ev(`(() => { const e = document.querySelector('#tasksView .tk-shadow, .tk-shadow'); if (!e) return null; const r = e.getBoundingClientRect(); return { txt: e.textContent.trim(), cls: e.className, x: r.left, y: r.top, h: r.height, same: /tk-shadow-same/.test(e.className) }; })()`);
    const hm = (iso) => (iso || '').slice(11, 16);
    const toastTxt = () => ev(`(() => { const t = [...document.querySelectorAll('.tk-ctoast, #toast, .toast, .tk-msg')].map(e => e.textContent.trim()).filter(Boolean); return t.join(' || '); })()`);
    await ev(`window.__cm = []; document.addEventListener('contextmenu', e => { setTimeout(() => window.__cm.push({ prevented: e.defaultPrevented, tag: e.target.className || e.target.tagName }), 0); }, false);`).catch(() => {});

    // ====================================== W-5 «Неделя»
    console.log('=== W-5 Неделя (1280)');
    await k.size(1280, 900, false); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('calendar');
    await ev(`window.__cm = []; document.addEventListener('contextmenu', e => { setTimeout(() => window.__cm.push({ prevented: e.defaultPrevented, tag: String(e.target.className || e.target.tagName) }), 0); }, false);`);
    await openCal('week', D(7)); await scrollTo(8);
    const wkh = (await R(WK)).h; console.log('wk height', wkh);
    const info0 = await ev(`({ dnd: document.querySelectorAll('#tasksView .tk-dnd').length, tiles: document.querySelectorAll('#tasksView .tk-ev-t').length })`);
    C.check('W-5 admin: плитки с признаком перетаскивания (tk-dnd) — ' + info0.dnd, info0.dnd >= 8, JSON.stringify(info0));
    await k.shot('B00_week_1280_before');
    let t0 = await tile(X.orig), sl = await slot(D(10), 14 * 60);
    console.log('tile', JSON.stringify(t0), 'slot', JSON.stringify(sl));
    // перетаскивание: захват у верхнего края плитки (+8px), отпускание в ячейке чт 14:00
    let shot = null;
    await k.drag(t0.cx, t0.y + 8, sl.cx, sl.y + 6, { steps: 10, beforeUp: async () => { shot = await shadow(); await k.shot('B01_week_drag_shadow_1280'); } });
    console.log('shadow', JSON.stringify(shot));
    C.check('W-5 «Неделя»: во время перетаскивания видна тень с подписью нового времени: «' + (shot && shot.txt) + '»', shot && /14:00/.test(shot.txt) && /15:30/.test(shot.txt), JSON.stringify(shot));
    let g = await G(X.orig);
    C.check('W-5 «Неделя»: сервер — чт ' + D(10) + ' 14:00–15:30 (длительность 1ч30 сохранена), version 2: ' + g.start_at + ' – ' + g.end_at + ' v' + g.version, g.start_at === D(10) + 'T14:00' && g.end_at === D(10) + 'T15:30' && g.version === 2, JSON.stringify([g.start_at, g.end_at, g.version]));
    const t1 = await tile(X.orig);
    C.check('W-5 плитка перерисована на новом месте (колонка четверга, y как у 14:00)', t1 && Math.abs(t1.y - (await slot(D(10), 14 * 60)).y) <= 3 && Math.abs(t1.h - 72) <= 3, JSON.stringify(t1));
    C.check('W-5 карточка после перетаскивания не открылась', !(await ev('window.Tasks.__t.S.selectedId')) && !(await ev('!!document.querySelector("#tasksView form.tk-form")')), '');
    await k.shot('B02_week_after_drop_1280');
    // (прочие поля при переносе не изменились)
    C.check('W-5 перенос не тронул поля: исполнители, метка, чек-лист, приоритет', g.assignees.length === 2 && g.label === 'alpha, beta' && g.checklist.length === 2 && g.checklist[0].done === true && g.priority === 1 && g.status === 'open', JSON.stringify([g.assignees.length, g.label, g.checklist.length, g.priority]));
    // «стык»: Список и Доска показывают новый срок
    await k.view('list');
    const lrow = await ev(`(() => { const r = document.querySelector('#tasksView .tk-row[data-id="${X.orig}"]'); return r ? r.querySelector('.tk-nowrap').textContent.trim() : null; })()`);
    C.check('СТЫК перетащенная → Список показывает новый срок: «' + lrow + '»', lrow && /14:00/.test(lrow) && /15:30/.test(lrow) && /26\.11/.test(lrow), lrow);
    await k.view('board');
    const brd = await ev(`(() => { const c = document.querySelector('#tasksView .tk-card[data-id="${X.orig}"] .tk-sub'); return c ? c.textContent : null; })()`);
    C.check('СТЫК перетащенная → Доска показывает новый срок: «' + brd + '»', brd && /26\.11 14:00/.test(brd), brd);
    await k.view('calendar'); await openCal('week', D(7)); await scrollTo(8);

    // Esc
    t0 = await tile(X.orig); sl = await slot(D(11), 16 * 60);
    let shEsc = null;
    await k.drag(t0.cx, t0.y + 8, sl.cx, sl.y + 6, { steps: 8, beforeUp: async () => { shEsc = await shadow(); await k.key('Escape'); await sleep(250); } });
    const afterEsc = await shadow(); g = await G(X.orig);
    C.check('W-5 Esc во время перетаскивания: тень убрана, после отпускания ничего не записано (v2, 14:00)', shEsc && !afterEsc && g.version === 2 && g.start_at === D(10) + 'T14:00', JSON.stringify([shEsc, afterEsc, g.version, g.start_at]));
    C.check('W-5 Esc: карточка не открылась после отпускания', !(await ev('window.Tasks.__t.S.selectedId')), '');
    await k.shot('B03_after_esc_1280');
    // отпустить на месте: сдвиг > 5px, но та же ячейка
    t0 = await tile(X.orig);
    let shSame = null;
    await k.drag(t0.cx, t0.y + 6, t0.cx + 14, t0.y + 14, { steps: 6, beforeUp: async () => { shSame = await shadow(); } });
    g = await G(X.orig);
    C.check('W-5 отпустили на старом месте: запись не выполнена (v2); тень «серая» (' + (shSame ? shSame.cls : 'нет') + ')', g.version === 2 && g.start_at === D(10) + 'T14:00', JSON.stringify([g.version, shSame]));
    // клик без сдвига → карточка; 3px дрожание → всё равно карточка
    t0 = await tile(X.clk);
    await scrollTo(8);
    const tc = await tile(X.clk);
    await k.move(tc.cx, tc.cy);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tc.cx, y: tc.cy, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tc.cx + 3, y: tc.cy + 2, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tc.cx + 3, y: tc.cy + 2, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(600);
    const dt = await ev(`({ detail: !!document.querySelector('#tasksView .tk-detail'), sel: window.Tasks.__t.S.selectedId })`);
    g = await G(X.clk);
    C.check('W-5 клик по плитке с дрожанием 3 px (без сдвига) → открывается карточка, записи нет', dt.detail && dt.sel === X.clk && g.version === 1, JSON.stringify([dt, g.version]));
    await k.shot('B04_click_opens_card_1280');
    // захват из середины плитки и отпускание: как считается начало
    await openCal('week', D(7)); await scrollTo(8);
    t0 = await tile(X.orig); sl = await slot(D(11), 14 * 60 + 30);
    let shMid = null;
    await k.drag(t0.cx, t0.cy, sl.cx, sl.y + 6, { steps: 8, beforeUp: async () => { shMid = await shadow(); } });
    g = await G(X.orig);
    console.log('grab-middle drop at 14:30 cell → ' + g.start_at + ' – ' + g.end_at + ' shadow ' + (shMid && shMid.txt));
    C.note('grab_middle_result', { start: g.start_at, end: g.end_at, shadow: shMid && shMid.txt });
    C.check('W-5 захват из СЕРЕДИНЫ плитки (смещение захвата 45 мин), отпускание на ячейке 14:30 → плитка следует за курсором: начало 14:00 (14:37 − 45 мин, шаг 30) [' + g.start_at + '–' + g.end_at + ']', g.start_at === D(11) + 'T14:00', g.start_at);
    // вернуть оригинал на место для W-6 (чт D(10) 14:00)
    await openCal('week', D(7)); await scrollTo(8);
    t0 = await tile(X.orig); sl = await slot(D(10), 14 * 60);
    await k.drag(t0.cx, t0.y + 8, sl.cx, sl.y + 6, { steps: 8 });

    // «День»
    console.log('=== W-5 День');
    await openCal('day', D(8)); await scrollTo(8);
    t0 = await tile(X.day); sl = await slot(D(8), 16 * 60 + 30);
    let shDay = null;
    await k.drag(t0.cx, t0.y + 8, sl.cx, sl.y + 6, { steps: 8, beforeUp: async () => { shDay = await shadow(); await k.shot('B05_day_drag_shadow_1280'); } });
    g = await G(X.day);
    C.check('W-5 «День»: тень «16:30–17:30», сервер 16:30–17:30', shDay && /16:30/.test(shDay.txt) && g.start_at === D(8) + 'T16:30' && g.end_at === D(8) + 'T17:30', JSON.stringify([shDay && shDay.txt, g.start_at, g.end_at]));
    await k.shot('B05b_day_after_drop_1280');

    // «Весь день»
    console.log('=== W-5 Весь день');
    await openCal('week', D(7)); await scrollTo(8);
    let a0 = await R('#tasksView .tk-ad-c[data-date="' + D(9) + '"] .tk-ev[data-id="' + X.ad + '"]'), a1 = await adc(D(11));
    let shAd = null;
    await k.drag(a0.cx, a0.cy, a1.cx, a1.cy, { steps: 8, beforeUp: async () => { shAd = await shadow(); await k.shot('B06_allday_drag_shadow_1280'); } });
    g = await G(X.ad);
    C.check('W-5 «Весь день»: тень в ячейке; сервер — только дата ' + D(11) + ', без времени (' + g.start_at + ')', shAd && g.start_at === D(11) && !g.end_at, JSON.stringify([shAd && shAd.txt, g.start_at, g.end_at]));
    // многодневная: тянем из ячейки пн-... D(9) на D(11)
    await openCal('week', D(7)); await scrollTo(8);
    a0 = await R('#tasksView .tk-ad-c[data-date="' + D(9) + '"] .tk-ev[data-id="' + X.multi + '"]'); a1 = await adc(D(11));
    let shMu = null;
    await k.drag(a0.cx, a0.cy, a1.cx, a1.cy + 2, { steps: 8, beforeUp: async () => { shMu = await shadow(); } });
    g = await G(X.multi);
    C.check('W-5 многодневная: оба конца +2 дня, время суток прежнее → ' + g.start_at + ' – ' + g.end_at + ' (тень «' + (shMu && shMu.txt) + '»)', g.start_at === D(11) + 'T09:00' && g.end_at === D(12) + 'T18:00', JSON.stringify([g.start_at, g.end_at]));
    await k.shot('B07_allday_after_1280');

    // 23:30 → конец ≤ 23:59
    console.log('=== W-5 23:30');
    await openCal('week', D(7)); await scrollTo(16);
    t0 = await tile(X.long); sl = await slot(D(10), 23 * 60 + 30);
    console.log('long tile', JSON.stringify(t0), 'slot2330', JSON.stringify(sl), 'wk', JSON.stringify(await R(WK)));
    let sh2359 = null;
    await k.drag(t0.cx, t0.y + 8, sl.cx, Math.min(sl.y + 6, (await R(WK)).y + (await R(WK)).h - 4), { steps: 10, beforeUp: async () => { sh2359 = await shadow(); await k.shot('B08_2330_shadow_1280'); } });
    g = await G(X.long);
    C.check('W-5 23:30: 2-часовая задача, сброс на 23:30 → тень «23:30–23:59», сервер ' + g.start_at + ' – ' + g.end_at, g.start_at === D(10) + 'T23:30' && g.end_at <= D(10) + 'T23:59' && g.end_at.slice(0, 10) === D(10), JSON.stringify([sh2359 && sh2359.txt, g.start_at, g.end_at]));
    await k.shot('B08b_2330_after_1280');

    // 409: две вкладки
    console.log('=== W-5 409 (два браузера)');
    const B2 = await env.openBrowser(); const k2 = kit(B2.cdp, env), ev2 = k2.ev;
    await k2.size(1280, 900, false); await k2.load(s.adminCookies); await k2.gotoTasks(); await k2.view('calendar');
    await ev2('window.Tasks.open(' + JSON.stringify({ employeeId: '', date: D(7), view: 'calendar', mode: 'week' }) + ')'); await k2.waitFor('!window.Tasks.__t.S.loading', 20000); await sleep(600);
    await ev2(`document.querySelector('${WK}').scrollTop = 8 * 48`); await sleep(250);
    // вкладка 1 переносит «Конфликт» с чт... D(11) 10:00 на D(12) 12:00
    await openCal('week', D(7)); await scrollTo(8);
    t0 = await tile(X.conf); sl = await slot(D(12), 12 * 60);
    await k.drag(t0.cx, t0.y + 8, sl.cx, sl.y + 6, { steps: 8 });
    g = await G(X.conf);
    C.check('409-подготовка: вкладка 1 перенесла «Конфликт» на ' + g.start_at + ', v' + g.version, g.start_at === D(12) + 'T12:00' && g.version === 2, JSON.stringify([g.start_at, g.version]));
    // вкладка 2 (устарела: версия 1, плитка на D(11) 10:00) тянет на D(13) 18:00
    const rect2 = (sel) => ev2(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
    const t2 = await rect2('#tasksView .tk-ev-t[data-id="' + X.conf + '"]'), s2 = await rect2('#tasksView .tk-slot[data-date="' + D(13) + '"][data-min="' + (18 * 60) + '"]');
    console.log('tab2 tile', JSON.stringify(t2), 'slot', JSON.stringify(s2));
    await k2.drag(t2.cx, t2.y + 8, s2.cx, s2.y + 6, { steps: 8, after: 1200 });
    const msg409 = await ev2(`document.body.innerText`);
    const m409 = /уже изменена|другим пользователем|обновлён/i.test(msg409);
    await k2.shot('B09_409_conflict_tab2_1280');
    await sleep(1500);
    g = await G(X.conf);
    const t2b = await rect2('#tasksView .tk-ev-t[data-id="' + X.conf + '"]'), s2b = await rect2('#tasksView .tk-slot[data-date="' + D(12) + '"][data-min="' + (12 * 60) + '"]');
    const ver2 = await ev2(`(window.Tasks.__t.S.tasks.find(t => t.id === ${JSON.stringify(X.conf)}) || {}).version`);
    C.check('W-5 409: вкладка 2 показала понятное сообщение (текст со «…уже изменена…/обновлён…»)', m409, (msg409.match(/.{0,60}(изменена|обновлён).{0,100}/i) || [''])[0]);
    C.check('W-5 409: вкладка 2 перечитала задачи (версия 2, плитка на D(12) 12:00 — как у вкладки 1), перенос не применён: сервер ' + g.start_at, g.start_at === D(12) + 'T12:00' && g.version === 2 && ver2 === 2 && t2b && s2b && Math.abs(t2b.y - s2b.y) <= 3, JSON.stringify([g.start_at, g.version, ver2, t2b, s2b]));
    console.log('409 message:', (msg409.match(/.{0,80}(изменена|обновлён).{0,120}/i) || [''])[0]);
    B2.cdp.ws.close();

    // ====================================== W-6
    console.log('=== W-6 копирование ПКМ');
    await openCal('week', D(7)); await scrollTo(8);
    await ev('window.__cm.length = 0');
    // «Вставить» неактивно до копирования
    sl = await slot(D(12), 15 * 60);
    await k.rclick(sl.cx, sl.y + 6);
    let menu = await ev(`(() => { const m = document.querySelector('.tk-ctx'); if (!m) return null; const r = m.getBoundingClientRect(); return { items: [...m.querySelectorAll('.tk-ctx-i')].map(b => ({ t: b.textContent.trim(), dis: b.disabled })), x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const cm1 = await ev('JSON.stringify(window.__cm)');
    C.check('W-6 ПКМ по пустой ячейке до копирования: своё меню, «Вставить» неактивно; нативное меню подавлено', menu && menu.items.length === 1 && menu.items[0].t === 'Вставить' && menu.items[0].dis === true && /"prevented":true/.test(cm1), JSON.stringify([menu, cm1]));
    await k.shot('B10_menu_paste_disabled_1280');
    await k.key('Escape'); await sleep(200);
    C.check('W-6 меню закрывается по Esc', !(await ev('!!document.querySelector(".tk-ctx")')), '');
    // ПКМ по плитке → «Копировать»
    const to = await tile(X.orig);
    await k.rclick(to.cx, to.cy);
    menu = await ev(`(() => { const m = document.querySelector('.tk-ctx'); if (!m) return null; const r = m.getBoundingClientRect(); return { items: [...m.querySelectorAll('.tk-ctx-i')].map(b => ({ t: b.textContent.trim(), dis: b.disabled })), x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    C.check('W-6 ПКМ по плитке → меню «Копировать» (активно)', menu && menu.items.length === 1 && menu.items[0].t === 'Копировать' && !menu.items[0].dis, JSON.stringify(menu));
    await k.shot('B11_menu_copy_tile_1280');
    // клик мимо закрывает
    await k.clickXY(20, 880); await sleep(200);
    C.check('W-6 клик мимо закрывает меню', !(await ev('!!document.querySelector(".tk-ctx")')), '');
    await k.rclick(to.cx, to.cy);
    await k.clickText('.tk-ctx .tk-ctx-i', 'Копировать'); await sleep(400);
    const toastC = await toastTxt();
    console.log('toast after copy:', toastC);
    C.note('toast_after_copy', toastC);
    // ПКМ по ячейке пт D(12) 15:00 → Вставить
    sl = await slot(D(12), 15 * 60);
    await k.rclick(sl.cx, sl.y + 6);
    menu = await ev(`(() => { const m = document.querySelector('.tk-ctx'); return m ? [...m.querySelectorAll('.tk-ctx-i')].map(b => ({ t: b.textContent.trim(), dis: b.disabled })) : null; })()`);
    C.check('W-6 после «Копировать» ПКМ по ячейке: «Вставить» активно', menu && menu[0].t === 'Вставить' && !menu[0].dis, JSON.stringify(menu));
    await k.shot('B12_menu_paste_enabled_1280');
    const pre = await G(X.orig);
    const before = await api(env, adminCk, 'GET', 'api/tasks.php?from=2026-01-01&to=2027-12-31');
    const idsBefore = new Set(before.json.tasks.map((t) => t.id));
    await k.clickText('.tk-ctx .tk-ctx-i', 'Вставить'); await sleep(1200);
    const after = await api(env, adminCk, 'GET', 'api/tasks.php?from=2026-01-01&to=2027-12-31');
    const created = after.json.tasks.filter((t) => !idsBefore.has(t.id));
    C.check('W-6 «Вставить» создала ровно одну новую задачу', created.length === 1, created.length);
    const nc = created[0] ? await G(created[0].id) : {}; const orig = await G(X.orig); const origV = (await G(X.orig)).version;
    console.log('copy:', JSON.stringify(nc).slice(0, 700));
    C.check('W-6 копия: start/end = ячейка пт D(12) 15:00 + прежняя длительность 1ч30 → 15:00–16:30 (' + nc.start_at + ' – ' + nc.end_at + ')', nc.start_at === D(12) + 'T15:00' && nc.end_at === D(12) + 'T16:30', JSON.stringify([nc.start_at, nc.end_at]));
    C.check('W-6 копия: тема/описание/приоритет/метка как у оригинала', nc.title === orig.title && nc.description === orig.description && nc.priority === orig.priority && nc.label === orig.label && JSON.stringify(nc.labels) === JSON.stringify(['alpha', 'beta']), JSON.stringify([nc.title, nc.description, nc.priority, nc.label]));
    const names = (arr) => (arr || []).map((a) => a.employee_id).sort().join(',');
    C.check('W-6 копия: исполнители [emp_1,emp_2] и наблюдатель [emp_3] как у оригинала', names(nc.assignees) === 'emp_1,emp_2' && names(nc.watchers) === 'emp_3', names(nc.assignees) + ' / ' + names(nc.watchers));
    C.check('W-6 копия: чек-лист 2 пункта «Пункт A», «Пункт B», ВСЕ без отметок (у оригинала «A» отмечен)', nc.checklist && nc.checklist.length === 2 && nc.checklist.every((c) => !c.done) && nc.checklist[0].text === 'Пункт A' && orig.checklist[0].done === true, JSON.stringify(nc.checklist));
    C.check('W-6 копия: статус open, версия 1, другой id; оригинал не тронут (чт 14:00–15:30, версия ' + orig.version + ' — как до копирования)', nc.status === 'open' && nc.version === 1 && nc.id !== X.orig && orig.start_at === D(10) + 'T14:00' && orig.end_at === D(10) + 'T15:30' && orig.version === pre.version, JSON.stringify([nc.status, nc.id, orig.start_at, orig.version, pre.version]));
    const flash = await ev(`(() => { const e = document.querySelector('#tasksView .tk-ev.tk-flash'); return e ? e.getAttribute('data-id') : null; })()`);
    const toast = await toastTxt();
    console.log('flash', flash, 'toast', toast);
    C.check('W-6 новая плитка подсвечена (tk-flash)', flash === nc.id, flash);
    C.check('W-6 всплывающее сообщение: «Скопировано на 28.11 15:00» и действие «Открыть»: «' + toast + '»', /Скопировано на 28\.11 15:00/.test(toast) && /Открыть/.test(toast), toast);
    await k.shot('B13_pasted_flash_toast_1280');
    await k.clickText('.tk-ctoast .tk-ctoast-act', 'Открыть'); await sleep(600);
    const op = await ev(`({ sel: window.Tasks.__t.S.selectedId, detail: !!document.querySelector('#tasksView .tk-detail') })`);
    C.check('W-6 «Открыть» из сообщения → карточка копии', op.detail && op.sel === nc.id, JSON.stringify(op));
    await k.shot('B14_open_copy_card_1280');
    // повторная вставка из того же буфера + «Весь день»
    await scrollTo(8);
    sl = await slot(D(13), 9 * 60);
    await k.rclick(sl.cx, sl.y + 6); await k.clickText('.tk-ctx .tk-ctx-i', 'Вставить'); await sleep(1000);
    const a2 = await api(env, adminCk, 'GET', 'api/tasks.php?from=2026-01-01&to=2027-12-31');
    const second = a2.json.tasks.filter((t) => !idsBefore.has(t.id) && t.id !== nc.id);
    C.check('W-6 повторная вставка из того же буфера в другой день/час (' + D(13) + ' 09:00) → ещё одна копия', second.length === 1 && second[0].start_at === D(13) + 'T09:00' && second[0].end_at === D(13) + 'T10:30', JSON.stringify(second.map(t => [t.start_at, t.end_at])));
    const adCell = await adc(D(8));
    await k.rclick(adCell.x + 10, adCell.cy);
    menu = await ev(`(() => { const m = document.querySelector('.tk-ctx'); return m ? [...m.querySelectorAll('.tk-ctx-i')].map(b => ({ t: b.textContent.trim(), dis: b.disabled })) : null; })()`);
    C.check('W-6 ПКМ по полосе «Весь день» → «Вставить» доступно', menu && menu[0].t === 'Вставить' && !menu[0].dis, JSON.stringify(menu));
    await k.clickText('.tk-ctx .tk-ctx-i', 'Вставить'); await sleep(1000);
    const a3 = await api(env, adminCk, 'GET', 'api/tasks.php?from=2026-01-01&to=2027-12-31');
    const third = a3.json.tasks.filter((t) => !idsBefore.has(t.id) && t.id !== nc.id && t.id !== (second[0] || {}).id);
    C.check('W-6 вставка в «Весь день» (' + D(8) + ') → задача без времени: ' + JSON.stringify(third.map(t => [t.start_at, t.end_at])), third.length === 1 && third[0].start_at === D(8) && !third[0].end_at, JSON.stringify(third.map(t => [t.start_at, t.end_at])));
    // копия закрытой задачи → open, чек-лист без отметок
    await openCal('week', D(7)); await scrollTo(8);
    const tcl = await tile(X.closed);
    await k.rclick(tcl.cx, tcl.cy); await k.clickText('.tk-ctx .tk-ctx-i', 'Копировать'); await sleep(300);
    sl = await slot(D(12), 11 * 60);
    await k.rclick(sl.cx, sl.y + 6); await k.clickText('.tk-ctx .tk-ctx-i', 'Вставить'); await sleep(1000);
    const a4 = await api(env, adminCk, 'GET', 'api/tasks.php?from=2026-01-01&to=2027-12-31');
    const fourth = a4.json.tasks.find((t) => t.title === 'Закрытая для копии' && t.id !== X.closed);
    const f4 = fourth ? await G(fourth.id) : {};
    C.check('W-6 копия ЗАКРЫТОЙ задачи: статус open, чек-лист без отметок, время ' + f4.start_at, f4.status === 'open' && f4.checklist && f4.checklist.length === 1 && !f4.checklist[0].done && f4.start_at === D(12) + 'T11:00', JSON.stringify(f4));
    // нативное меню над шапкой
    await ev('window.__cm.length = 0');
    const hd = await R('#tasksView .tk-wk-h');
    await k.rclick(hd.cx, hd.cy);
    const cmh = await ev('JSON.stringify(window.__cm)');
    C.check('W-6 ПКМ над шапкой дня: нашего меню нет, нативное не подавлено', !(await ev('!!document.querySelector(".tk-ctx")')) && /"prevented":false/.test(cmh), cmh);
    // закрытие меню прокруткой
    await scrollTo(8);
    sl = await slot(D(11), 12 * 60);
    await k.rclick(sl.cx, sl.y + 6);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: sl.cx, y: sl.cy, deltaX: 0, deltaY: 120 }); await sleep(300);
    C.check('W-6 меню закрывается прокруткой колесом', !(await ev('!!document.querySelector(".tk-ctx")')), '');
    // «Копировать» НЕ из строки Списка: ПКМ в Списке/Доске нашего меню нет
    await k.view('list');
    await ev('window.__cm.length = 0');
    const lr = await R('#tasksView .tk-row[data-id="' + X.orig + '"] .tk-c-task');
    await k.rclick(lr.cx, lr.cy);
    C.check('W-6 ПКМ по строке Списка: нашего меню нет (нативное)', !(await ev('!!document.querySelector(".tk-ctx")')) && /"prevented":false/.test(await ev('JSON.stringify(window.__cm)')), '');
    await k.key('Escape');

    // ====================================== СТЫКИ
    console.log('=== стыки');
    // копия с несколькими тегами → теги в Списке и фильтр
    await k.view('list');
    const cpChips = await ev(`[...document.querySelectorAll('#tasksView .tk-row[data-id="${nc.id}"] .tk-tagbtn')].map(e => e.textContent.trim())`);
    C.check('СТЫК копия с тегами «alpha, beta» → в Списке 2 отдельных чипа ' + JSON.stringify(cpChips), cpChips.length === 2 && cpChips[0] === 'alpha' && cpChips[1] === 'beta', JSON.stringify(cpChips));
    await k.click('#tasksView .tk-row[data-id="' + nc.id + '"] .tk-tagbtn', 1); await sleep(500);
    const flt = await ev(`JSON.stringify({ l: window.Tasks.__t.S.filters.label, rows: [...document.querySelectorAll('#tasksView .tk-row b')].map(b => b.textContent) })`);
    const fj = JSON.parse(flt);
    C.check('СТЫК клик по чипу «beta» у копии → фильтр по тегу: оригинал + 3 копии (всего ' + fj.rows.length + ') — все «Оригинал»', fj.l === 'beta' && fj.rows.length === 4 && fj.rows.every(x => x === 'Оригинал'), flt);
    await k.shot('B15_list_filter_beta_copies_1280');
    await ev('document.querySelector("#tasksView [data-tk-act=resetFilters]").click()'); await sleep(300);
    // ✎ из Списка → форма с тегами → сохранение → плитка календаря на месте
    await k.click('#tasksView .tk-row[data-id="' + X.orig + '"] .tk-editbtn'); await sleep(500);
    const fch = await ev(`[...document.querySelectorAll('#tasksView form.tk-form .tk-tagchip')].map(e => e.getAttribute('data-tk-tag'))`);
    await k.click('#tasksView form.tk-form [data-tk-field="labelInput"]'); await k.type('gamma'); await k.key('Enter');
    await k.click('[data-tk-act="saveForm"]'); await sleep(1000);
    g = await G(X.orig);
    C.check('СТЫК ✎ из Списка → форма показывает теги ' + JSON.stringify(fch) + ', +«gamma» → сохранено: «' + g.label + '», срок прежний ' + g.start_at, JSON.stringify(fch) === JSON.stringify(['alpha', 'beta']) && g.label === 'alpha, beta, gamma' && g.start_at === D(10) + 'T14:00' && g.end_at === D(10) + 'T15:30', JSON.stringify([fch, g.label, g.start_at]));
    await k.view('calendar'); await openCal('week', D(7)); await scrollTo(8);
    const tp = await tile(X.orig), sp = await slot(D(10), 14 * 60);
    C.check('СТЫК после сохранения из формы плитка календаря на месте (чт 14:00, высота 72)', tp && Math.abs(tp.y - sp.y) <= 3 && Math.abs(tp.h - 72) <= 3, JSON.stringify([tp, sp]));
    // стили двух веток в одном <style>
    const styles = await ev(`(() => { const st = [...document.querySelectorAll('style')].map(s => s.textContent).join('\\n'); const need = ['.tk-editbtn', '.tk-tagbtn', '.tk-tagsbox', '.tk-shadow', '.tk-ctx', '.tk-ctoast', '.tk-dnd', '.tk-flash', '.tk-table-v62']; return need.map(n => [n, st.indexOf(n) >= 0]); })()`);
    C.check('СТЫК в странице присутствуют правила обеих веток (editbtn/tagbtn/tagsbox ↔ shadow/ctx/ctoast/dnd/flash)', styles.every(x => x[1]), JSON.stringify(styles));
    const ctxLook = await ev(`(() => { const probe = document.createElement('div'); probe.className = 'tk-ctx'; document.body.appendChild(probe); const cs = getComputedStyle(probe); const o = { pos: cs.position, z: cs.zIndex, bg: cs.backgroundColor }; probe.remove(); const e = document.querySelector('#tasksView .tk-ev-t'); const ce = getComputedStyle(e); o.evPos = ce.position; o.evCursor = ce.cursor; return o; })()`);
    C.check('СТЫК computed-стили: .tk-ctx fixed/белый, плитка absolute — правила не перебиты: ' + JSON.stringify(ctxLook), ctxLook.pos === 'fixed' && /255, 255, 255/.test(ctxLook.bg) && ctxLook.evPos === 'absolute', JSON.stringify(ctxLook));

    // ====================================== R-10 / R-11 в этом же прогоне
    await k.view('calendar'); await openCal('week', D(7)); await scrollTo(8);
    const p1 = await tile(X.p1), p2 = await tile(X.p2), p3 = await tile(X.p3);
    C.check('R-11 три пересекающиеся плитки в пятницу — рядом по дорожкам (x различны, ширина ~1/3 дня)', p1 && p2 && p3 && new Set([p1.x, p2.x, p3.x].map(Math.round)).size === 3 && p1.w < (await R('#tasksView .tk-day')).w * 0.45, JSON.stringify([p1, p2, p3]));
    await k.shot('B16_overlap_R11_1280');
    const emp = await slot(D(13), 18 * 60);
    await k.clickXY(emp.cx, emp.cy); await sleep(600);
    const frm = await ev(`({ form: !!document.querySelector('#tasksView form.tk-form'), sd: (document.querySelector('[data-tk-field="startDate"]') || {}).value, st: (document.querySelector('[data-tk-field="startTime"]') || {}).value })`);
    C.check('R-10 клик по пустой ячейке (' + D(13) + ' 18:00) → «Новая задача» с датой/временем ячейки: ' + JSON.stringify(frm), frm.form && frm.sd === D(13) && frm.st === '18:00', JSON.stringify(frm));
    await k.click('[data-tk-act="cancelForm"]'); await sleep(300);
    C.check('0 необработанных исключений (admin 1280)', cdp.exceptions.length === 0, cdp.exceptions.join('\n'));

    // ====================================== РОЛИ
    for (const [user, role] of [['supervisor_zone0', 'supervisor'], ['viewer_test', 'viewer']]) {
      console.log('=== роль ' + role);
      const ck = await L.login(env.base, user);
      await k.size(1280, 900, false); await k.load(ck); await k.gotoTasks(); await k.view('calendar');
      await ev(`window.__cm = []; document.addEventListener('contextmenu', e => { setTimeout(() => window.__cm.push({ prevented: e.defaultPrevented }), 0); }, false);`);
      await openCal('week', D(7)); await scrollTo(8);
      const dn = await ev(`({ dnd: document.querySelectorAll('#tasksView .tk-dnd, #tasksView [data-tk-dnd]').length, cells: document.querySelectorAll('#tasksView [data-tk-act="calCell"]').length })`);
      C.check(role + ': плиток tk-dnd нет, ячеек создания нет', dn.dnd === 0 && dn.cells === 0, JSON.stringify(dn));
      const tt = await tile(X.clk);
      const vBefore = (await G(X.clk)).version;
      let shR = null;
      await k.drag(tt.cx, tt.y + 8, tt.cx + 150, tt.y + 200, { steps: 8, beforeUp: async () => { shR = await shadow(); } });
      const gg = await G(X.clk);
      C.check(role + ': мышиное перетаскивание — тени нет, на сервере ничего не изменилось', !shR && gg.version === vBefore && gg.start_at === D(13) + 'T12:00', JSON.stringify([shR, gg.version]));
      await ev('window.__cm.length = 0');
      const tt2 = await tile(X.clk);
      await k.rclick(tt2.cx, tt2.cy);
      const cmr = await ev('JSON.stringify(window.__cm)');
      C.check(role + ': ПКМ по плитке — нашего меню нет, нативное не подавлено', !(await ev('!!document.querySelector(".tk-ctx")')) && /"prevented":false/.test(cmr), cmr);
      const cellR = await R('#tasksView .tk-slot');
      await k.rclick(cellR.cx, cellR.cy);
      C.check(role + ': ПКМ по ячейке — нашего меню нет', !(await ev('!!document.querySelector(".tk-ctx")')), '');
      if (role === 'viewer') await k.shot('B17_viewer_no_dnd_no_menu_1280');
      // клик по плитке по-прежнему открывает карточку
      await k.clickXY(tt2.cx, tt2.cy); await sleep(500);
      C.check(role + ': клик по плитке открывает карточку (просмотр)', await ev('!!document.querySelector("#tasksView .tk-detail")'), '');
    }
    C.check('0 необработанных исключений (роли)', cdp.exceptions.length === 0, cdp.exceptions.join('\n'));

    // ====================================== 375: касания
    console.log('=== 375 касания');
    await k.size(375, 740, true); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('calendar');
    await openCal('week', D(7)); await scrollTo(8);
    await k.shot('B18_calendar_375');
    const touch = async (pts, hold) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] }); for (const p of pts.slice(1)) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p[0], y: p[1] }] }); await sleep(25); } if (hold) await sleep(hold); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(500); };
    const tOr = await tile(X.p1) || await tile(X.clk);
    const vis = await ev(`(() => { const w = document.querySelector('${WK}'); const r = w.getBoundingClientRect(); return { top: r.top, h: r.height, sl: w.scrollLeft, st: w.scrollTop, sw: w.scrollWidth, cw: w.clientWidth }; })()`);
    console.log('wk375', JSON.stringify(vis));
    // плитка пятницы (Пер1) может быть за правым краем — прокрутим по горизонтали, чтобы она была в окне
    await ev(`document.querySelector('${WK}').scrollLeft = 99999`); await sleep(300);
    const tt3 = await tile(X.clk); // последний столбец
    console.log('tile 375', JSON.stringify(tt3));
    const p0 = await ev(`(() => { const w = document.querySelector('${WK}'); return { st: w.scrollTop, sl: w.scrollLeft }; })()`);
    const vBefore2 = (await G(X.clk)).version;
    await touch([[tt3.cx, tt3.cy + 30], [tt3.cx, tt3.cy + 10], [tt3.cx, tt3.cy - 20], [tt3.cx, tt3.cy - 60], [tt3.cx, tt3.cy - 100]]);
    const p1s = await ev(`(() => { const w = document.querySelector('${WK}'); return { st: w.scrollTop, sl: w.scrollLeft, sh: !!document.querySelector('.tk-shadow'), ctx: !!document.querySelector('.tk-ctx') }; })()`);
    C.check('375 прокрутка календаря пальцем вертикально от плитки: scrollTop ' + p0.st + ' → ' + p1s.st + ', тени нет, меню нет', Math.abs(p1s.st - p0.st) > 30 && !p1s.sh && !p1s.ctx, JSON.stringify(p1s));
    await ev(`document.querySelector('${WK}').scrollTop = 8 * 48`); await sleep(250);
    const tt4 = await tile(X.clk) || tt3;
    await touch([[tt4.cx - 40, tt4.cy], [tt4.cx - 10, tt4.cy], [tt4.cx + 30, tt4.cy], [tt4.cx + 80, tt4.cy]]);
    const p2s = await ev(`(() => { const w = document.querySelector('${WK}'); return { st: w.scrollTop, sl: w.scrollLeft, sh: !!document.querySelector('.tk-shadow') }; })()`);
    const g375 = await G(X.clk);
    C.check('375 горизонтальная прокрутка пальцем: scrollLeft ' + p1s.sl + ' → ' + p2s.sl + ', тени нет, на сервере ничего не изменилось (v' + g375.version + ')', p2s.sl !== p1s.sl && !p2s.sh && g375.version === vBefore2 && g375.start_at === D(13) + 'T12:00', JSON.stringify([p1s, p2s, g375.version]));
    // долгое нажатие
    await ev('window.__cm = []; document.addEventListener("contextmenu", e => { setTimeout(() => window.__cm.push({ prevented: e.defaultPrevented, pt: e.pointerType }), 0); }, false);');
    const tt5 = await tile(X.clk) || tt3;
    await ev(`document.querySelector('${WK}').scrollTop = 8 * 48`); await sleep(200);
    const tt6 = await tile(X.clk);
    if (tt6) await touch([[tt6.cx, tt6.cy]], 1200);
    const lp = await ev(`({ ctx: !!document.querySelector('.tk-ctx'), cm: window.__cm, sh: !!document.querySelector('.tk-shadow') })`);
    C.check('375 долгое нажатие на плитке (1,2 с): нашего меню нет, тени нет (' + JSON.stringify(lp.cm) + ')', !lp.ctx && !lp.sh, JSON.stringify(lp));
    // долгое нажатие на пустой ячейке
    const emp375 = await ev(`(() => { const e = document.querySelector('#tasksView .tk-slot[data-date="${D(9)}"][data-min="${15 * 60}"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
    if (emp375) await touch([[emp375.cx, emp375.cy]], 1200);
    C.check('375 долгое нажатие на пустой ячейке: нашего меню нет', !(await ev('!!document.querySelector(".tk-ctx")')), '');
    await k.shot('B19_375_after_longpress');
    // мышь на 375: меню помещается в окно
    await ev(`document.querySelector('${WK}').scrollLeft = 0`); await sleep(200);
    const tm = await tile(X.orig) || await tile(X.p1);
    if (tm) {
      await k.rclick(Math.min(tm.cx, 360), tm.cy);
      const mr = await ev(`(() => { const m = document.querySelector('.tk-ctx'); if (!m) return null; const r = m.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, vw: innerWidth, vh: innerHeight }; })()`);
      C.check('375 (мышь): меню у края помещается в окно: ' + JSON.stringify(mr), mr && mr.l >= 0 && mr.r <= mr.vw && mr.b <= mr.vh, JSON.stringify(mr));
      await k.shot('B20_ctx_375_mouse');
      await k.key('Escape');
    }
    C.check('0 необработанных исключений (375)', cdp.exceptions.length === 0, cdp.exceptions.join('\n'));
  } catch (e) {
    console.log('ОШИБКА ХАРНЕССА: ' + e.stack);
    C.check('harness без ошибок', false, e.message);
  } finally {
    C.save();
    console.log('\nB: ' + C.passed + ' passed, ' + C.failed + ' failed');
    env.cleanup();
    process.exit(C.failed ? 1 : 0);
  }
})();
