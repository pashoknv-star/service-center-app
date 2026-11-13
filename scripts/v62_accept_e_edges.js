// V6.2-3 (приёмка, вне gate): E — граничные случаи W-5/W-6 (больничный → 422, задача без конца, XSS в тосте, буфер между режимами),
// ширины Списка на 1024/1366/1920, обновление списка тегов после сохранения.
// Запуск: node scripts/v62_accept_e_edges.js → reports/V6_2/V6.2-3_screens/E_*.png, E_results.json
'use strict';
const path = require('path');
const { L, seed, D, sleep, OUT, kit, api } = require('./v62_accept_lib.js');

(async () => {
  const C = L.makeChecker(path.join(OUT, 'E_results.json'));
  const env = await L.startEnv();
  try {
    const s = await seed(env);
    const adminCk = s.adminCookies.join('; '), T = s.T;
    const G = (id) => api(env, adminCk, 'GET', 'api/tasks.php?id=' + id).then((r) => r.json.task);
    const all = async () => (await api(env, adminCk, 'GET', 'api/tasks.php?from=2026-01-01&to=2027-12-31')).json.tasks;
    const A = await env.openBrowser(); C.note('browser', A.version);
    const cdp = A.cdp, k = kit(cdp, env), ev = k.ev;
    const WK = '#tasksView .tk-wk';
    const R = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
    const tile = (id) => R('#tasksView .tk-ev-t[data-id="' + id + '"]');
    const slot = (date, min) => R('#tasksView .tk-slot[data-date="' + date + '"][data-min="' + min + '"]');
    const bodyText = () => ev('document.body.innerText');
    const openCal = async (mode, date) => { await ev('window.Tasks.open(' + JSON.stringify({ employeeId: '', date, view: 'calendar', mode }) + ')'); await k.waitFor('!window.Tasks.__t.S.loading', 20000); await sleep(600); await ev(`document.querySelector('${WK}').scrollTop = 8 * 48`); await sleep(250); };

    await k.size(1280, 900, false); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('calendar');
    await openCal('week', D(2));
    // ---- перетаскивание на больничный (emp_3 болеет D(4)) → 422
    console.log('=== drag на больничный');
    let t0 = await tile(T.dog), sl = await slot(D(4), 12 * 60);
    const v0 = (await G(T.dog)); const wk0 = await R(WK);
    await k.drag(t0.cx, t0.y + 8, sl.cx, sl.y + 6, { steps: 8, after: 1200 });
    let g = await G(T.dog);
    const txt = await bodyText();
    const msg = (txt.match(/.{0,60}(больнич|командиров|не выполнен).{0,160}/i) || [''])[0];
    C.check('W-5 перенос на день больничного исполнителя → отказ сервера (422): задача не изменилась (' + g.start_at + '), сообщение: «' + msg.replace(/\n/g, ' ') + '»', g.start_at === v0.start_at && g.version === v0.version && /больнич|командиров|не выполнен/i.test(txt), JSON.stringify([g.start_at, g.version, msg]));
    const back = await tile(T.dog);
    const wk1 = await R(WK); const shift = wk1.y - wk0.y;   // баннер ошибки над календарём сдвигает всю сетку вниз (см. ACCEPTANCE, P3)
    C.check('W-5 после отказа плитка снова на старом месте относительно сетки (сдвиг сетки баннером ошибки: ' + Math.round(shift) + ' px)', back && Math.abs((back.y - wk1.y) - (t0.y - wk0.y)) <= 3 && Math.abs(back.x - t0.x) <= 3, JSON.stringify([t0, back, shift]));
    await k.shot('E01_drag_to_sick_day_422_1280');
    // ---- вставка на больничный
    console.log('=== paste на больничный');
    const n0 = (await all()).length;
    t0 = await tile(T.dog);
    await k.rclick(t0.cx, t0.cy); await k.clickText('.tk-ctx .tk-ctx-i', 'Копировать'); await sleep(300);
    sl = await slot(D(4), 14 * 60);
    await k.rclick(sl.cx, sl.y + 6); await k.clickText('.tk-ctx .tk-ctx-i', 'Вставить'); await sleep(1200);
    const n1 = (await all()).length;
    const txt2 = await bodyText();
    const msg2 = (txt2.match(/.{0,60}(больнич|командиров|не выполнен|не удалось).{0,160}/i) || [''])[0];
    C.check('W-6 вставка на день больничного исполнителя → копия не создана (' + n0 + ' → ' + n1 + '), сообщение: «' + msg2.replace(/\n/g, ' ') + '»', n1 === n0 && /больнич|командиров|не выполнен|не удалось/i.test(txt2), msg2);
    await k.shot('E02_paste_to_sick_day_1280');
    // ---- буфер переживает смену режима: «День»
    await openCal('day', D(1));
    await ev(`document.querySelector('${WK}').scrollTop = 14 * 48`); await sleep(200);
    sl = await slot(D(1), 18 * 60);
    await k.rclick(sl.cx, sl.y + 6);
    const menu = await ev(`(() => { const m = document.querySelector('.tk-ctx'); return m ? [...m.querySelectorAll('.tk-ctx-i')].map(b => ({ t: b.textContent.trim(), dis: b.disabled })) : null; })()`);
    C.check('W-6 буфер сохраняется при смене режима «Неделя» → «День»: «Вставить» активно', menu && menu[0].t === 'Вставить' && !menu[0].dis, JSON.stringify(menu));
    await k.clickText('.tk-ctx .tk-ctx-i', 'Вставить'); await sleep(1200);
    const copies = (await all()).filter((t) => t.title === 'Согласование договора' && t.id !== T.dog);
    C.check('W-6 вставка в режиме «День» на ' + D(1) + ' 18:00: длительность 1ч30 сохранена (' + (copies[0] && copies[0].start_at) + '–' + (copies[0] && copies[0].end_at) + ')', copies.length === 1 && copies[0].start_at === D(1) + 'T18:00' && copies[0].end_at === D(1) + 'T19:30', JSON.stringify(copies.map(c => [c.start_at, c.end_at])));
    await k.shot('E03_paste_in_day_mode_1280');

    // ---- задача без конца (только начало)
    console.log('=== задача без конца');
    await openCal('week', D(2));
    t0 = await tile(T.start); sl = await slot(D(3), 16 * 60);
    console.log('start-only tile', JSON.stringify(t0));
    await k.drag(t0.cx, t0.y + 5, sl.cx, sl.y + 6, { steps: 8 });
    g = await G(T.start);
    C.check('W-5 задача «только время начала» (15:00, без конца): перенос на ' + D(3) + ' 16:00 → ' + g.start_at + ', конец ' + JSON.stringify(g.end_at) + ' (не появился)', g.start_at === D(3) + 'T16:00' && !g.end_at, JSON.stringify([g.start_at, g.end_at]));
    t0 = await tile(T.start);
    await k.rclick(t0.cx, t0.cy); await k.clickText('.tk-ctx .tk-ctx-i', 'Копировать'); await sleep(250);
    sl = await slot(D(0), 11 * 60);
    await k.rclick(sl.cx, sl.y + 6); await k.clickText('.tk-ctx .tk-ctx-i', 'Вставить'); await sleep(1200);
    const sc = (await all()).filter((t) => t.title === 'Только время начала' && t.id !== T.start);
    C.check('W-6 копия задачи без конца: ' + JSON.stringify(sc.map(c => [c.start_at, c.end_at])), sc.length === 1 && sc[0].start_at === D(0) + 'T11:00' && !sc[0].end_at, JSON.stringify(sc.map(c => [c.start_at, c.end_at])));

    // ---- XSS в тосте и плитке
    console.log('=== XSS');
    await openCal('week', D(2));
    t0 = await tile(T.xss);
    await k.rclick(t0.cx, t0.cy); await k.clickText('.tk-ctx .tk-ctx-i', 'Копировать'); await sleep(300);
    const injected1 = await ev(`document.querySelectorAll('.tk-ctoast b, #toast b, .toast b, .tk-ctoast i, #toast i').length`);
    const toastHtml = await ev(`[...document.querySelectorAll('.tk-ctoast, #toast, .toast')].map(e => e.innerHTML).join(' | ')`);
    C.check('XSS тост «Скопировано: «Тема <b>x</b>…»» выводит теги текстом, DOM не внедрён', injected1 === 0 && /&lt;b&gt;/.test(toastHtml), toastHtml.slice(0, 300));
    await ev(`document.querySelector('${WK}').scrollTop = 12 * 48`); await sleep(200);
    sl = await slot(D(1), 20 * 60);
    await k.rclick(sl.cx, sl.y + 6); await k.clickText('.tk-ctx .tk-ctx-i', 'Вставить'); await sleep(1200);
    const injected2 = await ev(`document.querySelectorAll('#tasksView .tk-ev b b, #tasksView .tk-ev i, #tasksView .tk-ctoast b, #tasksView script').length`);
    const xc = (await all()).filter((t) => /Тема <b>x<\/b>/.test(t.title) && t.id !== T.xss);
    C.check('XSS копия: тема/метка/описание сохранены дословно, в плитках HTML не внедрён', injected2 === 0 && xc.length === 1 && xc[0].title === 'Тема <b>x</b> & "кавычки"' && xc[0].label === 'метка <i>x</i>' && /<script>1<\/script>/.test(xc[0].description), JSON.stringify(xc.map(c => [c.title, c.label])));
    await k.shot('E04_xss_copy_1280');

    // ---- ширины Списка на 1024 / 1366 / 1920
    console.log('=== ширины Списка');
    for (const [w, h] of [[1024, 768], [1366, 768], [1920, 1080]]) {
      await k.size(w, h, false); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
      const m = await ev(`(() => { const wr = document.querySelector('#tasksView .tk-tablewrap'), ths = [...document.querySelectorAll('#tasksView .tk-table thead th')]; return { cw: wr.clientWidth, sw: wr.scrollWidth, w: ths.map(x => Math.round(x.getBoundingClientRect().width)), names: ths.map(x => x.textContent.trim().replace('↕', '')), edit: !!document.querySelector('#tasksView .tk-editbtn') }; })()`);
      console.log(w, JSON.stringify(m));
      C.note('widths_' + w, m);
      const iE = m.names.indexOf('Исполнитель'), iD = m.names.indexOf('Описание');
      C.check(w + ' px: «Исполнитель» ' + m.w[iE] + ' px, «Описание» ' + m.w[iD] + ' px; таблица ' + m.sw + ' в окне ' + m.cw + (m.sw > m.cw + 1 ? ' (есть горизонтальная прокрутка)' : ' (помещается)'), m.w[iE] <= 130 && m.w[iD] >= 200, JSON.stringify(m));
      await k.shot('E05_list_' + w);
    }

    // ---- список тегов обновляется после сохранения (без перезагрузки)
    console.log('=== фильтр «Метка» после правки');
    await k.size(1280, 900, false); await k.load(s.adminCookies); await k.gotoTasks(); await k.view('list');
    await k.click('#tasksView .tk-row[data-id="' + T.plan + '"] .tk-editbtn'); await sleep(500);
    await k.click('#tasksView form.tk-form [data-tk-field="labelInput"]'); await k.type('новый-тег'); await k.key('Enter');
    await k.click('[data-tk-act="saveForm"]'); await sleep(1000);
    const opts = await ev(`[...document.querySelectorAll('#tasksView select[data-tk-filter="label"] option')].map(o => o.textContent.trim())`);
    C.check('фильтр «Метка» без перезагрузки содержит только что добавленный тег «новый-тег» и «планёрка»', opts.includes('новый-тег') && opts.includes('планёрка'), JSON.stringify(opts));
    C.check('0 необработанных исключений', cdp.exceptions.length === 0, cdp.exceptions.join('\n'));
  } catch (e) {
    console.log('ОШИБКА ХАРНЕССА: ' + e.stack);
    C.check('harness без ошибок', false, e.message);
  } finally {
    C.save();
    console.log('\nE: ' + C.passed + ' passed, ' + C.failed + ' failed');
    env.cleanup();
    process.exit(C.failed ? 1 : 0);
  }
})();
