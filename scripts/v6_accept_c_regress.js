// V6-4 (приёмка, вне gate): C — роли, регрессии T1 (окно замены, «Без исполнителя», drag&drop), sync двух реальных окон,
// шаг данных на живых окнах (sync_log). Запуск: node scripts/v6_accept_c_regress.js → reports/V6/V6-4_screens/C_*.png, C_results.json
'use strict';
const path = require('path'), fs = require('fs'), cp = require('child_process');
const L = require('./v6_accept_lib.js');
const { seed, D } = require('./v6_accept_seed.js');
const OUT = path.join(L.ROOT, 'reports/V6/V6-4_screens');
fs.mkdirSync(OUT, { recursive: true });
const sleep = L.sleep;

(async () => {
  const env = await L.startEnv();
  const C = L.makeChecker(path.join(OUT, 'C_results.json'));
  try {
    const s = await seed(env);
    const T = s.T;
    const adminCk = s.adminCookies.join('; ');
    const A = await env.openBrowser();
    C.note('browser', A.version);
    const k = L.pageKit(A.cdp, env.base, OUT);
    const ev = (x) => A.cdp.ev(x);
    const openTasks = async (view, extra) => {
      await ev('window.Tasks.open(' + JSON.stringify(Object.assign({ employeeId: '', date: D(2), view, mode: 'week' }, extra || {})) + ')');
      await k.waitFor('!window.Tasks.__t.S.loading', 20000); await sleep(500);
    };
    const gotoTasks = async () => { await ev('document.getElementById("vacationTrigger").click()'); await sleep(500); await k.click('#tabTasks'); await sleep(1200); await k.waitFor('!window.Tasks.__t.S.loading', 20000); };

    // ============================== РОЛИ
    for (const [user, role] of [['supervisor_zone0', 'supervisor'], ['viewer_test', 'viewer']]) {
      console.log('=== роль ' + role);
      const ck = await L.login(env.base, user);
      await k.size(1280, 900, false);
      await k.load(ck);
      await gotoTasks();
      await openTasks('calendar', { mode: 'week' });
      await ev('document.querySelector("#tasksView .tk-wk").scrollTop = 14*48-100'); await sleep(300);
      const rr = await ev(`({ cells: document.querySelectorAll('#tasksView [data-tk-act="calCell"]').length, can: document.querySelectorAll('#tasksView .tk-can').length, newBtn: !!document.querySelector('#tasksView [data-tk-act="newTask"]') })`);
      C.check(role + ' календарь: нет ячеек создания (calCell), нет .tk-can, нет кнопки «Новая задача»', rr.cells === 0 && rr.can === 0 && !rr.newBtn, JSON.stringify(rr));
      // реальный клик по пустой ячейке 14:00 среды: форма не открывается
      const pt = await ev(`(() => { const d = document.querySelector('#tasksView .tk-day[data-date="${D(4)}"]'); d.scrollIntoView({block:'center'}); const r = d.getBoundingClientRect(); const wk = document.querySelector('#tasksView .tk-wk'); const wr = wk.getBoundingClientRect(); return { x: r.left + r.width * 0.9, y: Math.min(wr.bottom - 60, Math.max(wr.top + 200, r.top + 17*48 + 10)) }; })()`);
      await k.clickXY(pt.x, pt.y); await sleep(500);
      const formOpen = await ev('!!document.querySelector("#tasksView form.tk-form")');
      C.check(role + ' реальный клик по ячейке календаря: форма «Новая задача» НЕ открывается', formOpen === false, formOpen);
      await k.shot('C01_' + role + '_calendar_no_create_1280');
      // карточка: нет кнопок записи
      await k.click('#tasksView .tk-ev-t[data-id="' + T.dirmeet + '"]'); await sleep(500);
      const cd = await ev(`(() => { const d = document.querySelector('.tk-detail'); return { btns: [...d.querySelectorAll('.tk-actions button')].map(b => b.textContent.trim()), edit: !!d.querySelector('[data-tk-act="editTask"]'), vac: !!d.querySelector('.tk-note-vac'), link: !!d.querySelector('a[data-tk-act="openMatrix"]') }; })()`);
      C.check(role + ' карточка: нет «Править/Закрыть/В архив»; пометка отпуска со ссылкой есть (просмотр)', cd.btns.length === 0 && !cd.edit && cd.vac && cd.link, JSON.stringify(cd));
      await k.shot('C02_' + role + '_card_readonly_1280');
      // R-15 доступен
      await k.click('.tk-detail .tk-note-vac a[data-tk-act="openMatrix"]'); await sleep(900);
      const mx = await ev('JSON.stringify({ tab: document.getElementById("tabMatrix").classList.contains("active"), row: !!document.querySelector("#matrixBody tr.mx-flash.matrix-row-director") })');
      C.check(role + ' R-15 переход в матрицу из карточки работает (только просмотр)', /"tab":true/.test(mx) && /"row":true/.test(mx), mx);
      await k.click('#tabTasks'); await sleep(900);
      // клики-фильтры и сортировка
      await openTasks('board'); await k.click('.tk-card[data-id="' + T.dirmeet + '"]'); await sleep(400);
      await k.click('.tk-detail [data-tk-act="filterBy"][data-f="label"]'); await sleep(500);
      const st = await ev('JSON.stringify({ v: window.Tasks.__t.S.view, l: window.Tasks.__t.S.filters.label })');
      C.check(role + ' R-12 клик по метке работает (→ Список)', /"v":"list"/.test(st) && /руководство/.test(st), st);
      await k.clickText('#tasksView .tk-table th', 'Приор.'); await sleep(300);
      C.check(role + ' R-17 сортировка по «Приор.» работает', await ev('!!document.querySelector("#tasksView .tk-table th[aria-sort]")'));
      const wr = await ev(`({ drag: document.querySelectorAll('#tasksView [draggable="true"]').length })`);
      await openTasks('board');
      const wr2 = await ev(`({ drag: document.querySelectorAll('#tasksView [draggable="true"]').length, edit: document.querySelectorAll('#tasksView [data-tk-act="editTask"],#tasksView [data-tk-act="newTask"]').length })`);
      C.check(role + ' Доска: карточки не draggable, кнопок правки/создания нет', wr2.drag === 0 && wr2.edit === 0, JSON.stringify(wr2));
      await k.shot('C03_' + role + '_board_1280');
      // API: запись запрещена
      const w = await L.http(env.base, ck.join('; '), 'POST', 'api/tasks.php', { title: 'x', start_at: D(1), assignees: ['emp_1'] });
      C.check(role + ' API POST api/tasks.php → 403 (запись закрыта и на сервере)', w.status === 403, w.status);
      // 375
      await k.size(375, 740, true); await k.load(ck); await gotoTasks(); await openTasks('calendar', { mode: 'week' });
      const r375 = await ev(`({ cells: document.querySelectorAll('#tasksView [data-tk-act="calCell"]').length })`);
      C.check(role + ' 375: календарь без ячеек создания', r375.cells === 0, JSON.stringify(r375));
      await k.shot('C04_' + role + '_calendar_375');
    }

    // ============================== АДМИН: T1-регрессии
    console.log('=== admin: окно замены, «Без исполнителя», drag&drop');
    await k.size(1280, 900, false); await k.load(s.adminCookies); await gotoTasks();
    await openTasks('board');
    const badge = await ev('(document.querySelector("[data-tk-badge=orphans]")||{}).textContent');
    C.check('admin: счётчик «⚠ 1» на вкладке «Задачи» (одна задача без исполнителя)', /1/.test(badge || ''), badge);
    const sec = await ev(`(() => { const s = document.querySelector('[data-tk-sec="orphans"]'); return s ? s.textContent.trim().slice(0, 80) : null; })()`);
    C.check('admin: Доска — секция «⚠ Без исполнителя · 1»', sec && /Без исполнителя · 1/.test(sec), sec);
    await k.click('.tk-sec-orph .tk-card[data-id="' + T.orph + '"]'); await sleep(500);
    await k.click('.tk-detail [data-tk-act="assignOrphan"]'); await sleep(900);
    const frm = await ev(`({ form: !!document.querySelector('#tasksView form.tk-form'), h4: (document.querySelector('#tasksView .tk-form h4')||{}).textContent })`);
    C.check('admin: «Назначить» в карточке задачи без исполнителя открывает форму правки на исполнителях (T1-8)', frm.form && /Редактирование/.test(frm.h4), JSON.stringify(frm));
    await ev(`(() => { const e = document.querySelector('#tasksView [data-tk-field="assigneePick"]'); e.value = 'emp_101'; e.dispatchEvent(new Event('change', {bubbles:true})); })()`); await sleep(300);
    await k.shot('C10_orphan_assign_form_1280');
    await k.click('#tasksView [data-tk-act="saveForm"]'); await sleep(2000);
    const after = await ev(`(() => { const t = window.Tasks.__t.S.tasks.find(t => t.id === '${T.orph}'); return { as: t && (t.assignees || []).map(a => a.employee_id + ':' + !!a.removed), badge: (document.querySelector('[data-tk-badge=orphans]')||{}).textContent || null, secLeft: !!document.querySelector('[data-tk-sec="orphans"]'), err: window.Tasks.__t.S.form && window.Tasks.__t.S.form.error }; })()`);
    C.check('admin: назначение директора (зона «Директор СЦ») на задачу без исполнителя прошло: счётчик ⚠ и секция пропали', after.as && after.as.join() === 'emp_101:false' && !after.badge && !after.secLeft, JSON.stringify(after));
    await k.shot('C11_orphan_after_assign_1280');
    // окно замены: РЕАЛЬНОЕ удаление сотрудника через редактор (index.html #deleteEmp) — у него 2 открытые задачи (одна — с соисполнителем)
    await ev('document.getElementById("vacationPanel").classList.remove("open"); window.scrollTo(0,0)'); await sleep(400);
    // курсор sync клиента должен догнать sync_log (иначе E10-6 справедливо блокирует «устаревшее» удаление)
    for (let i = 0; i < 45; i++) { const mx = +L.sql(env.tmpDb, 'select max(id) from sync_log;').trim(); const cur = await ev('window.__syncCursor'); if (cur >= mx) break; await sleep(1000); }
    await ev('(() => { const e = document.querySelector(\'.zone .employee[data-id="105"]\'); e.scrollIntoView({block:"center"}); })()'); await sleep(400);
    const er = await k.rect('.zone .employee[data-id="105"]');
    await k.clickXY(er.x, er.y); await sleep(700);
    const edOpen = await ev('(() => { const d = document.getElementById("deleteEmp"); return !!d && d.offsetParent !== null; })()');
    C.check('admin: клик по карточке сотрудника открывает редактор с «Удалить сотрудника»', edOpen, edOpen);
    await k.shot('C12_employee_editor_1280');
    await k.click('#deleteEmp'); await sleep(2500);
    const mm = await ev(`(() => ({ has: !!document.querySelector('[data-tk-mtarget]'), items: [...document.querySelectorAll('[data-tk-mitem]')].length, btns: [...document.querySelectorAll('[data-tk-act="mAssign"],[data-tk-act="mLater"]')].map(b => b.textContent.trim()), dialogs: 0 }))()`);
    C.check('admin: после удаления сотрудника открылось окно замены (2 задачи, «Назначить»/«Позже»)', mm.has && mm.items === 2 && mm.btns.includes('Назначить'), JSON.stringify(mm) + ' диалоги: ' + JSON.stringify(A.cdp.dialogs));
    await k.shot('C13_replace_modal_1280');
    // в списке «Передать» — директор из зоны «Директор СЦ»
    const tgt = await ev(`(() => { const e = document.querySelector('[data-tk-mtarget]'); return e ? [...e.options].map(o => o.textContent.trim()) : null; })()`);
    C.check('admin: в окне замены среди сотрудников есть директор из зоны «Директор СЦ»', (tgt || []).some((x) => /Директор Тестов/.test(x)), JSON.stringify(tgt));
    await ev(`(() => { const e = document.querySelector('[data-tk-mtarget]'); e.value = 'emp_101'; e.dispatchEvent(new Event('change', {bubbles:true})); })()`); await sleep(400);
    await k.click('[data-tk-act="mAssign"]'); await sleep(2500);
    const done = await ev(`(() => ({ items: [...document.querySelectorAll('[data-tk-mitem]')].map(li => li.className + '|' + li.textContent.replace(/\\s+/g,' ').slice(0,100)) }))()`);
    const srv2 = await L.http(env.base, adminCk, 'GET', 'api/tasks.php?from=2026-11-01&to=2026-11-30');
    const tl = (srv2.json.tasks || srv2.json.data || []);
    const night = tl.find((t) => t.id === T.night), lunch = tl.find((t) => t.id === T.lunch);
    const ids = (t) => t ? (t.assignees || []).map((a) => a.employee_id + (a.removed ? '!' : '')).sort().join() : 'нет';
    C.check('admin: окно замены передало задачи директору (проверено на сервере): «Ночная выгрузка» → emp_101; «Обед» → emp_101 + emp_106', ids(night) === 'emp_101' && /emp_101/.test(ids(lunch)) && /emp_106/.test(ids(lunch)) && !/emp_105/.test(ids(lunch)), ids(night) + ' | ' + ids(lunch) + ' | ' + JSON.stringify(done).slice(0, 300));
    await k.shot('C14_replace_modal_done_1280');
    await ev(`(() => { const b = document.querySelector('[data-tk-act="mLater"]'); if (b) b.click(); })()`); await sleep(400);
    await ev('document.getElementById("vacationTrigger").click()'); await sleep(500);
    // drag&drop (реальные мышь/drag-события)
    await openTasks('board');
    const rc = await k.rect('.tk-col[data-tk-col="open"] .tk-card[data-id="' + T.plan + '"]');
    const rt = await ev(`(() => { const e = document.querySelector('.tk-col[data-tk-col="closed"]'); e.scrollIntoView({block:'center'}); const b = e.getBoundingClientRect(); return { x: b.left + b.width/2, y: b.top + 70 }; })()`);
    const rc2 = await k.rect('.tk-col[data-tk-col="open"] .tk-card[data-id="' + T.plan + '"]');
    let dragVia = 'mouse';
    await A.cdp.send('Input.setInterceptDrags', { enabled: true }).catch(() => {});
    await A.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rc2.x, y: rc2.y });
    await A.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc2.x, y: rc2.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) await A.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rc2.x + (rt.x - rc2.x) * i / 8, y: rc2.y + (rt.y - rc2.y) * i / 8, button: 'left', buttons: 1 });
    await A.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rt.x, y: rt.y, button: 'left', clickCount: 1 });
    await sleep(1200);
    let srv = await L.http(env.base, adminCk, 'GET', 'api/tasks.php?from=2026-11-01&to=2026-11-30');
    let st = ((srv.json.tasks || srv.json.data || []).find((t) => t.id === T.plan) || {}).status;
    if (st !== 'closed') {
      dragVia = 'synthetic';
      await ev(`(() => { const c = document.querySelector('.tk-col[data-tk-col="open"] .tk-card[data-id="${T.plan}"]'); const col = document.querySelector('.tk-col[data-tk-col="closed"]'); const dt = new DataTransfer(); const f = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })); f(c, 'dragstart'); f(col, 'dragenter'); f(col, 'dragover'); f(col, 'drop'); f(c, 'dragend'); })()`);
      await sleep(1200);
      srv = await L.http(env.base, adminCk, 'GET', 'api/tasks.php?from=2026-11-01&to=2026-11-30');
      st = ((srv.json.tasks || srv.json.data || []).find((t) => t.id === T.plan) || {}).status;
    }
    C.check('admin: drag&drop на Доске «Открыта» → «Закрыта» закрывает задачу (проверено на сервере; способ: ' + dragVia + ')', st === 'closed', st);
    C.note('drag_via', dragVia);
    await k.shot('C12_dragdrop_closed_1280');
    // и обратно
    await ev(`(() => { const c = document.querySelector('.tk-col[data-tk-col="closed"] .tk-card[data-id="${T.plan}"]'); const col = document.querySelector('.tk-col[data-tk-col="open"]'); const dt = new DataTransfer(); const f = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })); f(c, 'dragstart'); f(col, 'dragenter'); f(col, 'dragover'); f(col, 'drop'); f(c, 'dragend'); })()`);
    await sleep(1200);
    srv = await L.http(env.base, adminCk, 'GET', 'api/tasks.php?from=2026-11-01&to=2026-11-30');
    st = ((srv.json.tasks || srv.json.data || []).find((t) => t.id === T.plan) || {}).status;
    C.check('admin: drag&drop «Закрыта» → «Открыта» переоткрывает задачу', st === 'open', st);

    // ============================== SYNC двух реальных окон + шаг данных
    console.log('=== sync двух окон');
    // директор в БД получает «боевое» вымышленное имя, чтобы прогнать APPLY v6_director_data.sql на живых окнах
    L.sql(env.tmpDb, "UPDATE employees SET full_name='Костецкий Андрей Николаевич', photo_url='images/old_photo.webp' WHERE id='emp_101'; INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at) VALUES ('employee','emp_101','upsert','accept','2026-11-13T00:00:00+00:00');");
    const B = await env.openBrowser();
    const kb = L.pageKit(B.cdp, env.base, OUT);
    await k.size(1280, 800, false); await k.load(s.adminCookies);
    await kb.size(1280, 800, false); await kb.load(s.adminCookies);
    await ev('document.getElementById("vacationTrigger").click()'); await sleep(400); await k.click('#tabTasks'); await sleep(1200);
    await B.cdp.ev('document.getElementById("vacationTrigger").click()'); await sleep(400); await kb.click('#tabTasks'); await sleep(1200);
    await ev('window.Tasks.open({employeeId:"",date:"' + D(2) + '",view:"board",mode:"week"})');
    await B.cdp.ev('window.Tasks.open({employeeId:"",date:"' + D(2) + '",view:"board",mode:"week"})'); await sleep(1500);
    const names = (cdp) => cdp.ev('(() => { const z = document.querySelector(\'.zone[data-zone="3"]\'); const n = z && z.querySelector(".employee"); return n ? n.textContent.replace(/\\s+/g, " ").trim().slice(0, 60) : null; })()');
    const photoOf = (cdp) => cdp.ev('(() => { const i = document.querySelector(\'.zone[data-zone="3"] .photo img\'); return i ? i.getAttribute("src") : null; })()');
    const before = [await names(A.cdp), await names(B.cdp)];
    C.check('sync: оба окна видят директора под старым именем «Костецкий Андрей Николаевич» (вымышленное) до APPLY', before.every((x) => /Костецкий/.test(x || '')), JSON.stringify(before));
    // окно A создаёт задачу через UI-API (admin), окно B должно подтянуть её без перезагрузки
    const mk = await L.http(env.base, adminCk, 'POST', 'api/tasks.php', { title: 'Sync-задача из окна A', start_at: D(1) + 'T12:00', end_at: D(1) + 'T13:00', assignees: ['emp_1'] });
    // APPLY шага данных на живой БД (две открытых вкладки)
    const sqlFile = path.join(L.ROOT, 'scripts/v6_director_data.sql');
    const r = cp.spawnSync('sqlite3', [env.tmpDb], { input: '.timeout 8000\n.read ' + sqlFile + '\n', encoding: 'utf8' });
    C.check('sync: APPLY шага данных на живой БД (два окна открыты) → «APPLIED: 1 сотрудник обновлён»', /APPLIED: 1/.test(r.stdout), (r.stdout + r.stderr).slice(-300));
    // ждём poll (20 с) — окна не перезагружаем
    let okA = false, okB = false;
    for (let i = 0; i < 60 && !(okA && okB); i++) { await sleep(1000); okA = /Игнатенко/.test(await names(A.cdp) || ''); okB = /Игнатенко/.test(await names(B.cdp) || ''); }
    C.check('sync: ОБА окна без перезагрузки подтянули новое ФИО «Игнатенко Павел Валерьевич» (дельта sync_log из шага данных)', okA && okB, JSON.stringify([await names(A.cdp), await names(B.cdp)]));
    const ph = [await photoOf(A.cdp), await photoOf(B.cdp)];
    C.check('sync: у обоих окон photo_url обновился на images/photo_1794600000_d1ec7040.jpg', ph.every((x) => /photo_1794600000_d1ec7040\.jpg/.test(x || '')), JSON.stringify(ph));
    const grpA = await ev('document.querySelector(\'.zone[data-zone="3"] .zt-title\').textContent');
    C.check('sync: плитка по-прежнему «Директор СЦ» (зона g3)', grpA === 'Директор СЦ', grpA);
    // задача из «окна A» в Доске окна B (API-создание само по себе sync_log не пишет; перечитывание — по дельте сотрудника)
    let seen = false;
    for (let i = 0; i < 25 && !seen; i++) { seen = await B.cdp.ev('!!window.Tasks.__t.S.tasks.find(t => t.title === "Sync-задача из окна A")'); if (!seen) await sleep(1000); }
    const bState = await B.cdp.ev('JSON.stringify({active: window.Tasks.isActive(), open: document.getElementById("vacationPanel").classList.contains("open"), view: window.Tasks.__t.S.view, n: window.Tasks.__t.S.tasks.length, dirty: window.Tasks.__t.S.dirty, form: !!window.Tasks.__t.S.form})');
    C.note('window_B_state_after_apply', bState);
    C.note('sync_obs_task_created_in_A_seen_in_B', seen);
    C.note('window_B_state_after_apply', bState);
    console.log('  OBS  Sync-задача (создана через API) в окне B после дельты сотрудника: ' + seen + ' ' + bState);
    await kb.shot('C20_sync_window_B_after_apply_1280');
    await k.shot('C21_sync_window_A_after_apply_1280');
    // В матрице у второго окна: строка директора первая с новым ФИО
    await B.cdp.ev('document.getElementById("tabMatrix").click()'); await sleep(600);
    const mxn = await B.cdp.ev('(() => { const r = document.querySelector("#matrixBody tr.matrix-row-director .name-col"); return r ? r.textContent.trim() : null; })()');
    C.note('matrix_B_name_without_rerender', mxn);
    await B.cdp.ev('document.getElementById("nextYear").click()'); await sleep(500); await B.cdp.ev('document.getElementById("prevYear").click()'); await sleep(700);
    const mxn2 = await B.cdp.ev('(() => { const r = document.querySelector("#matrixBody tr.matrix-row-director .name-col"); return r ? r.textContent.trim() : null; })()');
    C.check('sync: в матрице окна B (после перерисовки сменой года) строка директора — первая, золотая, «Игнатенко Павел Валерьевич»', /Игнатенко Павел Валерьевич/.test(mxn2 || ''), mxn2);
    console.log('  OBS  матрица окна B без перерисовки: ' + mxn);
    await kb.shot('C22_matrix_window_B_after_apply_1280');
    // ---- T1-11: удаление сотрудника в окне A → окно B (без перезагрузки) получает «⚠» и секцию «Без исполнителя»
    await B.cdp.ev('document.getElementById("tabTasks").click()'); await sleep(800);
    await B.cdp.ev('window.Tasks.open({employeeId:"",date:"' + D(2) + '",view:"board",mode:"week"})'); await sleep(1200);
    const bBadge0 = await B.cdp.ev('(document.querySelector("[data-tk-badge=orphans]")||{}).textContent || null');
    // свежее окно A2 (как в реальной работе: администратор открывает страницу и удаляет сотрудника)
    const A2 = await env.openBrowser(); const k2 = L.pageKit(A2.cdp, env.base, OUT); const ev2 = (x) => A2.cdp.ev(x);
    await k2.size(1280, 900, false); await k2.load(s.adminCookies);
    for (let i = 0; i < 45; i++) { const mx = +L.sql(env.tmpDb, 'select max(id) from sync_log;').trim(); const cur = await ev2('window.__syncCursor'); if (cur >= mx) break; await sleep(1000); }
    await ev2('(() => { const e = document.querySelector(\'.zone .employee[data-id="107"]\'); e.scrollIntoView({block:"center"}); })()'); await sleep(1200);
    const er2 = await k2.rect('.zone .employee[data-id="107"]'); await sleep(600);
    await k2.clickXY(er2.x, er2.y); await sleep(900);
    await k2.click('#deleteEmp'); await sleep(2800);
    const mA = await ev2('!!document.querySelector("[data-tk-mtarget]")');
    C.check('T1-11: в окне A2 после удаления сотрудника («Смирнова», 1 открытая задача) открылось окно замены', mA, 'в БД emp_107: ' + L.sql(env.tmpDb, "select count(*) from employees where id='emp_107';").trim() + '; диалоги: ' + JSON.stringify(A2.cdp.dialogs.map(function (x) { return x.slice(0, 30) + '…' + x.slice(-34); })));
    await k2.shot('C24_window_A2_replace_modal_1280');
    await ev2(`(() => { const b = document.querySelector('[data-tk-act="mLater"]'); if (b) b.click(); })()`); await sleep(500);
    let bBadge1 = null, bSec = false;
    for (let i = 0; i < 40 && !(bBadge1 && bSec); i++) { await sleep(1000); bBadge1 = await B.cdp.ev('(document.querySelector("[data-tk-badge=orphans]")||{}).textContent || null'); bSec = await B.cdp.ev('!!document.querySelector("[data-tk-sec=orphans]")'); }
    C.check('T1-11 sync: окно B БЕЗ перезагрузки показало счётчик «⚠» и секцию «Без исполнителя» после удаления сотрудника в окне A (было: ' + bBadge0 + ')', !!bBadge1 && bSec, JSON.stringify([bBadge0, bBadge1, bSec]));
    await kb.shot('C23_sync_window_B_orphan_after_delete_in_A_1280');
    C.check('нет необработанных исключений (окно A, окно B)', A.cdp.exceptions.length === 0 && B.cdp.exceptions.length === 0, JSON.stringify([A.cdp.exceptions, B.cdp.exceptions]).slice(0, 400));
  } catch (e) { console.log('FATAL', e); C.check('прогон без аварии', false, e.stack); }
  finally { C.save(); env.cleanup(); console.log('PASSED ' + C.passed + ' FAILED ' + C.failed); process.exit(C.failed ? 1 : 0); }
})();
