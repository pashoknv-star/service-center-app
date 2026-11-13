// V6.3-3 (приёмка, вне gate): C — Д-1: права (admin/supervisor/viewer, UI + прямой API), граничные случаи API/формы, next_at, сортировка, каскад.
// Запуск: node scripts/v63_accept_c_roles_edges.js → reports/V6_3/V6.3-3_screens/C_*.png, C_results.json
'use strict';
const path = require('path');
const { L, seed, D, sleep, OUT, kit, api } = require('./v63_accept_lib.js');
const HOUR = 48;

(async () => {
  const C = L.makeChecker(path.join(OUT, 'C_results.json'));
  const env = await L.startEnv();
  try {
    const s = await seed(env);
    const ck = s.adminCookies.join('; ');
    const E1 = 'emp_1', E2 = 'emp_2';
    const post = (body) => api(env, ck, 'POST', 'api/tasks.php', body);
    const get = async (id) => (await api(env, ck, 'GET', 'api/tasks.php?id=' + id)).json.task;
    const A = await env.openBrowser(); C.note('browser', A.version);
    const cdp = A.cdp, k = kit(cdp, env), ev = k.ev;
    const settled = async () => { await sleep(150); await k.waitFor('!window.Tasks.__t.S.busy && !window.Tasks.__t.S.loading', 20000); await sleep(400); };
    const setField = (sel, v) => ev('(() => { const el = document.querySelector(' + JSON.stringify('#tasksView ' + sel) + '); if (!el) return false; el.value = ' + JSON.stringify(v) + '; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
    const btn = (act) => k.click('#tasksView [data-tk-act="' + act + '"]');
    const hooks = () => ev(`(() => { window.__calls = []; window.__cm = [];
      if (!window.__fp) { window.__fp = true; const of = window.fetch; window.fetch = function (u, o) { window.__calls.push({ u: String(u), m: (o && o.method) || 'GET' }); return of.apply(this, arguments); };
        document.addEventListener('contextmenu', (e) => window.__cm.push({ prevented: e.defaultPrevented }), false); window.confirm = () => true; }
      const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, t: r.top, h: r.height }; };
      window.__h = { occTile: (id, date) => R(document.querySelector('#tasksView .tk-cal-bd .tk-day[data-date="' + date + '"] .tk-ev.tk-occ[data-id="' + id + '"]')),
        tile: (id) => R(document.querySelector('#tasksView .tk-cal-bd .tk-ev[data-id="' + id + '"]:not(.tk-occ)')), day: (d) => R(document.querySelector('#tasksView .tk-day[data-date="' + d + '"]')),
        scroll: (top) => { document.querySelector('#tasksView .tk-wk').scrollTop = top; return true; }, menu: () => !!document.querySelector('.tk-ctx') }; return true; })()`);
    const fresh = async (cookies, w, h, mobile) => { await k.size(w || 1280, h || 900, !!mobile); await k.load(cookies); await hooks(); };
    const openCal = async (date) => {
      await ev('window.Tasks.open({employeeId:"",date:' + JSON.stringify(date) + ',view:"calendar",mode:"week"})');
      await k.waitFor('!!document.querySelector("#tasksView .tk-cal-bd") && !window.Tasks.__t.S.loading', 30000); await sleep(500);
      await ev('window.__h.scroll(384)'); await sleep(250);
    };

    // ================================================================ API-границы (admin)
    console.log('=== API: границы');
    const base = { title: 'Граница', assignees: [E1], start_at: '2027-06-01T10:00', end_at: '2027-06-01T11:30' };
    const occs = (n) => Array.from({ length: n }, (_, i) => ({ start_at: new Date(Date.UTC(2027, 6, 1 + i)).toISOString().slice(0, 10) + 'T12:00' }));
    let r = await post(Object.assign({}, base, { title: 'Граница 100', occurrences: occs(100) }));
    C.check('API 100 повторов — принято (201)', r.status === 201 && r.json.task.occurrences.length === 100, r.status + JSON.stringify(r.json).slice(0, 150));
    const id100 = r.json.task && r.json.task.id;
    r = await post(Object.assign({}, base, { title: 'Граница 101', occurrences: occs(101) }));
    C.check('API 101 повтор → 400 occurrences_too_many, задача не создана', r.status === 400 && r.json.error === 'occurrences_too_many' && !(await api(env, ck, 'GET', 'api/tasks.php?from=2027-01-01&to=2028-12-31')).json.tasks.some((t) => t.title === 'Граница 101'), JSON.stringify(r));
    if (id100) {
      const t100 = await get(id100);
      r = await api(env, ck, 'POST', 'api/tasks.php?id=' + id100 + '&action=occ_add', { version: t100.version, start_at: '2028-01-01T10:00' });
      C.check('API occ_add сверх 100 → 400 occurrences_too_many', r.status === 400 && r.json.error === 'occurrences_too_many', JSON.stringify(r));
    }
    r = await post(Object.assign({}, base, { title: 'Дубль основной', occurrences: [{ start_at: '2027-06-01T10:00' }] }));
    C.check('API повтор = основная дата+время → 400 occurrence_duplicate (с index 0 и понятным message)', r.status === 400 && r.json.error === 'occurrence_duplicate' && r.json.index === 0 && /совпад|уже/i.test(r.json.message || ''), JSON.stringify(r));
    r = await post(Object.assign({}, base, { title: 'Дубль между собой', occurrences: [{ start_at: '2027-06-05T10:00' }, { start_at: '2027-06-05T10:00' }] }));
    C.check('API два одинаковых повтора → 400 occurrence_duplicate, index 1', r.status === 400 && r.json.error === 'occurrence_duplicate' && r.json.index === 1, JSON.stringify(r));
    r = await post(Object.assign({}, base, { title: 'Дата в тот же день, иное время', occurrences: [{ start_at: '2027-06-01T14:00' }] }));
    C.check('API повтор в тот же ДЕНЬ, но в другое время — допустим (201)', r.status === 201 && r.json.task.occurrences.length === 1, r.status);
    for (const [name, v] of [['мусор', 'абв'], ['дата без времени у задачи со временем', '2027-06-09'], ['невозможная дата', '2027-02-30T10:00'], ['время 25:00', '2027-06-09T25:00'], ['null', null]]) {
      r = await post(Object.assign({}, base, { title: 'Формат ' + name, occurrences: [{ start_at: v }] }));
      C.check('API неверный повтор (' + name + ') → 400 invalid_occurrence с понятным message', r.status === 400 && /invalid_occurrence/.test(r.json.error) && !!r.json.message, JSON.stringify(r));
    }
    r = await post(Object.assign({}, base, { title: 'Не список', occurrences: 'x' }));
    C.check('API occurrences не списком → 400', r.status === 400, JSON.stringify(r));
    // конец повтора: не за 23:59, длительность
    r = await post({ title: 'Ночная длительность', assignees: [E1], start_at: '2027-07-01T22:00', end_at: '2027-07-01T23:30', occurrences: [{ start_at: '2027-07-10T23:00' }] });
    console.log('night', JSON.stringify(r.json.task && [r.json.task.start_at, r.json.task.end_at, r.json.task.occurrences]));
    C.check('API длительность повтора = длительности задачи, конец в пределах суток не позже 23:59 (задача 22:00–23:30, повтор 23:00 → 23:59 того же дня)', r.status === 201 && r.json.task.occurrences[0].end_at === '2027-07-10T23:59', JSON.stringify(r.json.task && r.json.task.occurrences));
    r = await post({ title: 'Через полночь', assignees: [E1], start_at: '2027-07-01T22:00', end_at: '2027-07-02T01:00', occurrences: [{ start_at: '2027-07-10T23:00' }] });
    C.check('API задача через полночь (22:00 → 01:00 след. дня, 3 ч): повтор 23:00 → 02:00 следующего дня (длительность сохранена, как у основной)', r.status === 201 && r.json.task.occurrences[0].end_at === '2027-07-11T02:00' && r.json.task.occurrences && r.json.task.days.length === 4, JSON.stringify(r.json.task && [r.json.task.days, r.json.task.occurrences]));
    r = await post({ title: 'Многодневная', assignees: [E1], start_at: '2027-08-02T09:00', end_at: '2027-08-04T18:00', occurrences: [{ start_at: '2027-08-16T09:00' }] });
    C.check('API многодневная задача (2 дня 9 ч): повтор — те же 2 дня 9 ч (16.08 09:00 → 18.08 18:00), days[] = 6 дней', r.status === 201 && r.json.task.occurrences[0].end_at === '2027-08-18T18:00' && r.json.task.days.length === 6, JSON.stringify(r.json.task && [r.json.task.occurrences, r.json.task.days]));
    r = await post({ title: 'Только дни', assignees: [E1], start_at: '2027-09-06', end_at: '2027-09-07', occurrences: [{ start_at: '2027-09-20' }] });
    C.check('API задача без времени (06–07.09): повтор — дата 20.09, конец 21.09 (те же 2 дня)', r.status === 201 && r.json.task.occurrences[0].start_at === '2027-09-20' && r.json.task.occurrences[0].end_at === '2027-09-21', JSON.stringify(r.json.task && r.json.task.occurrences));
    const noTime = r.json.task;
    r = await post({ title: 'Только дни', assignees: [E1], start_at: '2027-09-06', end_at: '2027-09-07', occurrences: [{ start_at: '2027-09-20T10:00' }] });
    C.check('API задача без времени + повтор со временем → 400 invalid_occurrence', r.status === 400 && /invalid_occurrence/.test(r.json.error), JSON.stringify(r));
    // задача без конца («только время начала») + повтор: у повтора конца тоже нет
    r = await post({ title: 'Только начало повтор', assignees: [E1], start_at: '2027-09-27T15:00', occurrences: [{ start_at: '2027-09-29T16:00' }] });
    C.check('API задача «только время начала» (без конца): повтор тоже без конца (end_at = null)', r.status === 201 && r.json.task.occurrences[0].end_at === null && r.json.task.end_at === null, JSON.stringify(r.json.task && r.json.task.occurrences));
    // аудит
    const auditA = L.sql(env.tmpDb, "select action || ' ' || coalesce(details,'') from audit_log where action like 'task%' and (details like '%occurrence%' ) order by id desc limit 3;").trim();
    console.log('audit:', auditA.slice(0, 400));
    C.check('Аудит: изменение набора повторов попадает в audit_log (occurrences/occurrence в details)', auditA.length > 0, auditA);
    // PUT без version
    // PUT: пересчёт длительности при смене времени задачи
    r = await post({ title: 'Пересчёт', assignees: [E1], start_at: '2027-10-04T10:00', end_at: '2027-10-04T11:00', occurrences: [{ start_at: '2027-10-11T10:00' }, { start_at: '2027-10-12T15:00' }] });
    const tr = r.json.task;
    const up = await api(env, ck, 'PUT', 'api/tasks.php?id=' + tr.id, { version: tr.version, start_at: '2027-10-04T10:00', end_at: '2027-10-04T12:30' });
    C.check('API PUT смена длительности задачи (1 ч → 2,5 ч): без поля occurrences повторы сохранены, их концы пересчитаны (+2,5 ч): 12:30 и 17:30', up.status === 200 && up.json.task.occurrences.length === 2 && up.json.task.occurrences[0].end_at === '2027-10-11T12:30' && up.json.task.occurrences[1].end_at === '2027-10-12T17:30', JSON.stringify(up.json.task && up.json.task.occurrences));
    const rep = await api(env, ck, 'PUT', 'api/tasks.php?id=' + tr.id, { version: up.json.task.version, occurrences: [{ start_at: '2027-10-20T09:00' }] });
    C.check('API PUT с occurrences = полная замена набора (остался один 20.10 09:00)', rep.status === 200 && rep.json.task.occurrences.length === 1 && rep.json.task.occurrences[0].start_at === '2027-10-20T09:00', JSON.stringify(rep.json.task && rep.json.task.occurrences));
    const clr = await api(env, ck, 'PUT', 'api/tasks.php?id=' + tr.id, { version: rep.json.task.version, occurrences: [] });
    C.check('API PUT occurrences:[] → все повторы удалены, next_at = start_at', clr.status === 200 && clr.json.task.occurrences.length === 0 && clr.json.task.next_at === clr.json.task.start_at, JSON.stringify(clr.json.task && [clr.json.task.occurrences, clr.json.task.next_at]));

    // ================================================================ next_at: ближайшее предстоящее / все прошли — последнее
    console.log('=== next_at');
    const today = new Date().toISOString().slice(0, 10);
    const ymd = (off) => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
    r = await post({ title: 'next прошлое+будущее', assignees: [E1], start_at: ymd(-30) + 'T10:00', end_at: ymd(-30) + 'T11:00', occurrences: [{ start_at: ymd(-10) + 'T10:00' }, { start_at: ymd(20) + 'T10:00' }, { start_at: ymd(40) + 'T10:00' }] });
    C.check('next_at: основная и первый повтор в прошлом → ближайшее ПРЕДСТОЯЩЕЕ (+20 дн.), а не последнее и не первое', r.status === 201 && r.json.task.next_at === ymd(20) + 'T10:00', JSON.stringify(r.json.task && r.json.task.next_at) + ' ожидалось ' + ymd(20));
    const nx1 = r.json.task;
    r = await post({ title: 'next всё прошло', assignees: [E1], start_at: ymd(-30) + 'T10:00', end_at: ymd(-30) + 'T11:00', occurrences: [{ start_at: ymd(-10) + 'T10:00' }, { start_at: ymd(-20) + 'T10:00' }] });
    C.check('next_at: все выполнения прошли → ПОСЛЕДНЕЕ (−10 дн.)', r.status === 201 && r.json.task.next_at === ymd(-10) + 'T10:00', JSON.stringify(r.json.task && r.json.task.next_at));
    r = await post({ title: 'next сегодня позже/раньше', assignees: [E1], start_at: ymd(-5) + 'T10:00', end_at: ymd(-5) + 'T11:00', occurrences: [{ start_at: today + 'T00:05' }, { start_at: ymd(3) + 'T10:00' }] });
    console.log('next today', r.json.task && r.json.task.next_at, 'now', new Date().toISOString());
    // UI: Список — сортировка по сроку
    await fresh(s.adminCookies);
    await ev('window.Tasks.open({view:"list"})'); await settled();
    const dueTxt = await ev(`(() => { const r = document.querySelector('#tasksView .tk-row[data-id="${nx1.id}"]'); return r ? r.querySelector('[data-tk-due]').textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    const d20 = ymd(20).slice(8, 10) + '.' + ymd(20).slice(5, 7);
    C.check('UI Список: «Срок» задачи «next прошлое+будущее» = ' + d20 + ' (ближайшее предстоящее), «↻ 3»', dueTxt && dueTxt.indexOf(d20) >= 0 && /↻ 3/.test(dueTxt), dueTxt);
    // сортировка по сроку
    const sortHdr = await ev(`(() => { const th = [...document.querySelectorAll('#tasksView .tk-table thead th')].find((x) => /Срок/.test(x.textContent)); return th ? th.outerHTML.slice(0, 200) : null; })()`);
    console.log('Срок header:', sortHdr);
    await ev(`(() => { const th = [...document.querySelectorAll('#tasksView .tk-table thead th')].find((x) => /Срок/.test(x.textContent)); (th.querySelector('[data-tk-act]') || th).click(); })()`); await sleep(500);
    const order = await ev(`[...document.querySelectorAll('#tasksView .tk-row')].map((r) => ({ t: r.querySelector('b').textContent.trim(), due: (r.querySelector('[data-tk-due]').textContent.match(/\\d\\d\\.\\d\\d/) || [''])[0] }))`);
    console.log('sorted:', JSON.stringify(order.slice(0, 8)));
    const idxA = order.findIndex((x) => x.t === 'next прошлое+будущее'), idxB = order.findIndex((x) => x.t === 'next всё прошло');
    const apiNext = {}; (await api(env, ck, 'GET', 'api/tasks.php?from=2026-01-01&to=2028-12-31')).json.tasks.forEach((t) => { apiNext[t.id] = t.next_at; });
    const rowIds = await ev(`[...document.querySelectorAll('#tasksView .tk-row')].map((r) => r.dataset.id)`);
    const keys = rowIds.map((id) => String(apiNext[id] || '').slice(0, 16));
    const mono = keys.every((x, i) => i === 0 || keys[i - 1] <= x);
    console.log('sorted by next_at keys:', JSON.stringify(keys.slice(0, 12)), 'mono', mono);
    C.check('UI Список: сортировка по «Сроку» упорядочивает строки по next_at (' + keys.length + ' строк, неубывание), «next всё прошло» (−10 дн.) раньше «next прошлое+будущее» (+20 дн.)', mono && keys.length > 10 && idxA >= 0 && idxB >= 0 && idxB < idxA, JSON.stringify([idxA, idxB, keys.slice(0, 6)]));
    await k.shot('C01_list_sorted_by_due_1280');

    // ================================================================ форма: правка существующей задачи с повторами
    console.log('=== форма: правка');
    r = await post({ title: 'Правка повторов', assignees: [E2], start_at: '2027-11-01T09:00', end_at: '2027-11-01T10:00', occurrences: [{ start_at: '2027-11-03T09:00' }, { start_at: '2027-11-08T16:00' }] });
    const ed = r.json.task;
    await ev('window.Tasks.open({view:"list"})'); await settled();
    await k.click('#tasksView .tk-row[data-id="' + ed.id + '"] .tk-editbtn'); await sleep(500);
    const rowsPre = await ev('[...document.querySelectorAll("#tasksView .tk-occrow")].map((r) => [r.querySelector("[data-tk-occ-date]").value, (r.querySelector("[data-tk-occ-time]") || {}).value])');
    C.check('Форма правки показывает существующие повторы строками (дата+время) по возрастанию: ' + JSON.stringify(rowsPre), JSON.stringify(rowsPre) === JSON.stringify([['2027-11-03', '09:00'], ['2027-11-08', '16:00']]), JSON.stringify(rowsPre));
    await k.shotEl('#tasksView form.tk-form', 'C02_form_edit_with_occurrences_1280', { maxH: 1200 });
    // дубль в форме: повтор = основная дата
    await setField('[data-tk-occ-date="0"]', '2027-11-01'); await setField('[data-tk-occ-time="0"]', '09:00');
    await btn('saveForm'); await settled();
    const dupErr = await ev('({ txt: (document.querySelector("#tasksView [data-tk-occ-err]") || {}).textContent || "", form: !!document.querySelector("#tasksView form.tk-form") })');
    C.check('Форма: повтор = основная дата+время → сохранение не выполнено, понятная ошибка у строки: «' + dupErr.txt + '»', dupErr.form && /совпад|уже|основн/i.test(dupErr.txt) && (await get(ed.id)).occurrences.length === 2, JSON.stringify(dupErr));
    await k.shotEl('#tasksView .tk-f-occ', 'C03_form_duplicate_error_1280');
    // два одинаковых повтора
    await setField('[data-tk-occ-date="0"]', '2027-11-08'); await setField('[data-tk-occ-time="0"]', '16:00');
    await btn('saveForm'); await settled();
    const dupErr2 = await ev('({ txt: (document.querySelector("#tasksView [data-tk-occ-err]") || {}).textContent || "", form: !!document.querySelector("#tasksView form.tk-form") })');
    C.check('Форма: два одинаковых повтора → ошибка, форма открыта: «' + dupErr2.txt + '»', dupErr2.form && dupErr2.txt.length > 5, JSON.stringify(dupErr2));
    // удалить × первую строку, добавить новую, сохранить
    await ev('document.querySelector("#tasksView [data-tk-act=removeOcc][data-idx=\\"0\\"]").scrollIntoView({block:"center"})'); await sleep(200);
    await k.click('#tasksView [data-tk-act="removeOcc"][data-idx="0"]'); await sleep(300);
    const afterRm = await ev('document.querySelectorAll("#tasksView .tk-occrow").length');
    await btn('saveForm'); await settled();
    const ed2 = await get(ed.id);
    C.check('Форма: × удаляет строку повтора (' + afterRm + ' строка осталась), «Сохранить» → на сервере 1 повтор (08.11 16:00), форма закрыта', afterRm === 1 && ed2.occurrences.length === 1 && ed2.occurrences[0].start_at === '2027-11-08T16:00' && (await ev('!document.querySelector("#tasksView form.tk-form")')), JSON.stringify(ed2.occurrences));
    // смена времени основной даты в форме → концы повторов пересчитываются
    await k.click('#tasksView .tk-row[data-id="' + ed.id + '"] .tk-editbtn'); await sleep(500);
    await setField('[data-tk-field="endTime"]', '12:00');
    await btn('saveForm'); await settled();
    const ed3 = await get(ed.id);
    C.check('Форма: задача 09:00–10:00 → 09:00–12:00 (3 ч): конец повтора 08.11 пересчитан до 19:00', ed3.end_at === '2027-11-01T12:00' && ed3.occurrences[0].end_at === '2027-11-08T19:00', JSON.stringify([ed3.end_at, ed3.occurrences]));
    // удалить все повторы в форме
    await k.click('#tasksView .tk-row[data-id="' + ed.id + '"] .tk-editbtn'); await sleep(500);
    await k.click('#tasksView [data-tk-act="removeOcc"][data-idx="0"]'); await btn('saveForm'); await settled();
    const ed4 = await get(ed.id);
    C.check('Форма: удалены все повторы → задача без повторов, в Списке нет «↻»', ed4.occurrences.length === 0 && !(await ev(`!!document.querySelector('#tasksView .tk-row[data-id="${ed.id}"] .tk-occ-n')`)), JSON.stringify(ed4.occurrences));
    // «+ Добавить повтор» ×3: даты по умолчанию растут; × последний
    await k.click('#tasksView .tk-row[data-id="' + ed.id + '"] .tk-editbtn'); await sleep(500);
    await btn('addOcc'); await btn('addOcc'); await btn('addOcc');
    const defs = await ev('[...document.querySelectorAll("#tasksView [data-tk-occ-date]")].map((e) => e.value)');
    C.check('Форма: три нажатия «+ Добавить повтор» → три разные даты по возрастанию: ' + JSON.stringify(defs), defs.length === 3 && new Set(defs).size === 3 && JSON.stringify(defs) === JSON.stringify([...defs].sort()), JSON.stringify(defs));
    await btn('cancelForm'); await sleep(300);
    C.check('Форма: «Отмена» не сохраняет добавленные строки', (await get(ed.id)).occurrences.length === 0, '');
    // Задача без времени в форме: повтор — только дата
    await btn('newTask'); await sleep(300);
    await setField('[data-tk-field="title"]', 'Без времени UI'); await setField('[data-tk-field="assigneePick"]', E1); await setField('[data-tk-field="startDate"]', '2027-12-06');
    const hasTimeSel = await ev('!!document.querySelector("#tasksView [data-tk-field=\\"startTime\\"]") && document.querySelector("#tasksView [data-tk-field=\\"startTime\\"]").value');
    console.log('startTime value for new task:', hasTimeSel);
    await btn('cancelForm'); await sleep(300);

    // ================================================================ закрытая / архивная / удаление (каскад)
    console.log('=== закрытие, удаление');
    const cl = await post({ title: 'Каскад', assignees: [E1], start_at: '2027-12-01T10:00', end_at: '2027-12-01T11:00', occurrences: [{ start_at: '2027-12-05T10:00' }, { start_at: '2027-12-06T10:00' }] });
    const clId = cl.json.task.id;
    const cnt = () => L.sql(env.tmpDb, "select count(*) from task_occurrences where task_id='" + clId + "';").trim();
    const c0 = cnt();
    const ccl = await api(env, ck, 'POST', 'api/tasks.php?id=' + clId + '&action=close', { version: cl.json.task.version });
    const closed = await get(clId);
    const addClosed = await api(env, ck, 'POST', 'api/tasks.php?id=' + clId + '&action=occ_add', { version: closed.version, start_at: '2027-12-09T10:00' });
    console.log('close', ccl.status, 'occ_add on closed', addClosed.status, JSON.stringify(addClosed.json).slice(0, 160));
    const c1 = cnt();
    C.note('occ_add_on_closed_task', { status: addClosed.status, json: addClosed.json });
    const closed2 = await get(clId);
    const del = await api(env, ck, 'DELETE', 'api/tasks.php?id=' + clId + '&version=' + closed2.version, undefined);
    console.log('delete', del.status, JSON.stringify(del.json).slice(0, 160));
    let del2 = del;
    if (del.status >= 400) del2 = await api(env, ck, 'DELETE', 'api/tasks.php?id=' + clId, { version: closed2.version });
    const archived = await get(clId);
    C.check('DELETE задачи = архив (так задумано API): archived=1, повторы сохранены (' + cnt() + '), в обычном списке её нет', del.status < 400 && L.sql(env.tmpDb, "select archived from tasks where id='" + clId + "';").trim() === '1' && cnt() === c1 && !(await api(env, ck, 'GET', 'api/tasks.php?from=2027-12-01&to=2027-12-31')).json.tasks.some((t) => t.id === clId), JSON.stringify([del.status, archived && archived.archived]));
    const fkOff = L.sql(env.tmpDb, "PRAGMA foreign_keys=ON; DELETE FROM tasks WHERE id='" + clId + "'; select count(*) from task_occurrences where task_id='" + clId + "';").trim();
    C.check('Жёсткое удаление строки tasks (sqlite, foreign_keys=ON): повторы удалены каскадом (было ' + c1 + ' → ' + fkOff + ')', c0 === '2' && /(^|\n)0$/.test(fkOff), fkOff);
    C.check('Сироты: в task_occurrences нет строк без задачи', L.sql(env.tmpDb, 'select count(*) from task_occurrences where task_id not in (select id from tasks);').trim() === '0', '');

    // ================================================================ права: UI и API
    console.log('=== права');
    const MX = await post({ title: 'Права повторы', assignees: [E1], start_at: '2027-01-12T10:00', end_at: '2027-01-12T11:00', occurrences: [{ start_at: '2027-01-14T10:00' }, { start_at: '2027-01-15T10:00' }] });
    const PT = MX.json.task;
    for (const [user, role] of [['supervisor_zone0', 'supervisor'], ['viewer_test', 'viewer']]) {
      const rc = await L.login(env.base, user); const rck = rc.join('; ');
      console.log('--- ' + role);
      await fresh(rc);
      await ev('window.Tasks.open({view:"list"})'); await settled();
      const ui = await ev('({ newTask: !!document.querySelector("#tasksView [data-tk-act=newTask]"), edit: document.querySelectorAll("#tasksView .tk-editbtn").length, addOcc: !!document.querySelector("#tasksView [data-tk-act=addOcc]"), badge: !!document.querySelector("#tasksView .tk-row[data-id=\\"' + PT.id + '\\"] .tk-occ-n") })');
      C.check(role + ' Список: «↻ 2» виден, но нет «Новая задача», «✎» и «+ Добавить повтор»', ui.badge && !ui.newTask && ui.edit === 0 && !ui.addOcc, JSON.stringify(ui));
      // открыть форму программно нельзя? пробуем: клик по строке → карточка
      await ev('window.Tasks.open({view:"board", taskId:' + JSON.stringify(PT.id) + '})'); await settled();
      const card = await ev('({ dates: [...document.querySelectorAll("#tasksView .tk-detail .tk-dates li")].length, close: [...document.querySelectorAll("#tasksView .tk-detail button")].map((b) => b.textContent.trim()) })');
      C.check(role + ' карточка: перечень дат (3) виден, кнопок записи (Закрыть/Править) нет: ' + JSON.stringify(card.close), card.dates === 3 && !card.close.some((x) => /Закрыть|Править|Удалить|Переоткрыть/.test(x)), JSON.stringify(card));
      await openCal('2027-01-12');
      const occT = await ev('window.__h.occTile("' + PT.id + '","2027-01-14")');
      const mainT = await ev('window.__h.tile("' + PT.id + '")');
      const dnd = await ev('document.querySelectorAll("#tasksView .tk-dnd, #tasksView [data-tk-dnd]").length');
      C.check(role + ' календарь: плитки ↻ видны (' + !!occT + '), перетаскиваемых плиток нет (' + dnd + ')', !!occT && !!mainT && dnd === 0, JSON.stringify([occT, dnd]));
      await k.rclick(occT.x, occT.y);
      const cm = await ev('({ menu: window.__h.menu(), last: window.__cm.slice(-1)[0] })');
      C.check(role + ' ПКМ по плитке ↻: нашего меню («Копировать»/«Удалить повтор») нет, родное меню браузера не подавлено', !cm.menu && cm.last && cm.last.prevented === false, JSON.stringify(cm));
      const cell = await ev('(() => { const e = document.querySelector("#tasksView [data-tk-act=\\"calCell\\"][data-date=\\"2027-01-13\\"][data-min=\\"600\\"]"); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
      if (cell) { await k.rclick(cell.x, cell.y); }
      C.check(role + ' ПКМ по ячейке: меню «Вставить повтор» нет', !(await ev('window.__h.menu()')), '');
      // реальное перетаскивание плитки повтора и основной
      await ev('window.__calls.length = 0');
      const dT = await ev('window.__h.day("2027-01-13")');
      await k.drag(occT.x, occT.t + 10, dT.x, dT.t + 14 * HOUR + 12, { steps: 8 }); await sleep(600);
      await k.drag(mainT.x, mainT.t + 10, dT.x, dT.t + 16 * HOUR + 12, { steps: 8 }); await sleep(600);
      const wcalls = (await ev('window.__calls.slice()')).filter((c) => c.m !== 'GET');
      const afterDrag = await get(PT.id);
      C.check(role + ' перетаскивание плиток (повтор и основная) мышью: ни одного запроса записи, данные на сервере не изменились', wcalls.length === 0 && afterDrag.version === PT.version && afterDrag.start_at === PT.start_at && afterDrag.occurrences.length === 2 && afterDrag.occurrences[0].start_at === '2027-01-14T10:00', JSON.stringify([wcalls, afterDrag.version, PT.version]));
      if (role === 'viewer') await k.shot('C04_viewer_calendar_1280');
      // прямые вызовы API
      const cur = await get(PT.id);
      const oid = cur.occurrences[0].id;
      for (const [act, body] of [['occ_add', { version: cur.version, start_at: '2027-01-20T10:00' }], ['occ_move', { version: cur.version, occurrence_id: oid, start_at: '2027-01-21T10:00' }], ['occ_delete', { version: cur.version, occurrence_id: oid }]]) {
        const w = await api(env, rck, 'POST', 'api/tasks.php?id=' + PT.id + '&action=' + act, body);
        C.check('API ' + role + ' ' + act + ' → 403, данные не изменились', w.status === 403, w.status + JSON.stringify(w.json));
      }
      const wc = await api(env, rck, 'POST', 'api/tasks.php', { title: 'Хак ' + role, assignees: [E1], start_at: '2027-02-01T10:00', occurrences: [{ start_at: '2027-02-02T10:00' }] });
      const wp = await api(env, rck, 'PUT', 'api/tasks.php?id=' + PT.id, { version: cur.version, occurrences: [] });
      C.check('API ' + role + ' POST create с occurrences → 403; PUT occurrences:[] → 403', wc.status === 403 && wp.status === 403, wc.status + '/' + wp.status);
      const fin = await get(PT.id);
      C.check('после всех попыток ' + role + ': задача и повторы не изменились (version ' + fin.version + ', повторов ' + fin.occurrences.length + ')', fin.version === cur.version && fin.occurrences.length === 2, '');
    }
    const anon = await api(env, '', 'POST', 'api/tasks.php?id=' + PT.id + '&action=occ_add', { version: 1, start_at: '2027-01-20T10:00' });
    C.check('API без входа occ_add → 401', anon.status === 401, anon.status);
    const adm = await api(env, ck, 'POST', 'api/tasks.php?id=' + PT.id + '&action=occ_unknown', { version: 1 });
    console.log('unknown action', adm.status);
    const oldView = await api(env, ck, 'GET', 'api/tasks.php?id=' + PT.id);
    C.check('GET задачи (admin): occurrences[{id,start_at,end_at}] по возрастанию, next_at, days[] содержат дни повторов', oldView.json.task.occurrences.length === 2 && oldView.json.task.occurrences.every((o) => o.id && o.start_at && o.end_at) && oldView.json.task.days.includes('2027-01-14') && oldView.json.task.days.includes('2027-01-15') && !!oldView.json.task.next_at, JSON.stringify(oldView.json.task));
    // фильтр from/to по повтору
    const f1 = await api(env, ck, 'GET', 'api/tasks.php?from=2027-01-14&to=2027-01-14');
    C.check('API список ?from=to=14.01: задача находится по ПОВТОРУ (основная дата 12.01 вне диапазона)', f1.json.tasks.some((t) => t.id === PT.id), '');
    // XSS: заголовок с разметкой + повтор: плитка календаря
    const xs = await post({ title: '<img src=x onerror=window.__xss=1>', assignees: [E1], start_at: '2027-01-18T10:00', end_at: '2027-01-18T11:00', occurrences: [{ start_at: '2027-01-19T10:00' }] });
    await fresh(s.adminCookies); await openCal('2027-01-18');
    await ev('window.Tasks.open({view:"list"})'); await settled();
    await openCal('2027-01-18');
    C.check('XSS: тема с <img onerror> в плитках/списке/подсказках повтора экранируется (window.__xss не выставлен, <img> нет в DOM задач)', !(await ev('window.__xss')) && !(await ev('!!document.querySelector("#tasksView img[src=x]")')), '');
    C.check('0 необработанных исключений на странице', cdp.exceptions.length === 0, cdp.exceptions.join('\n'));
  } catch (e) {
    console.log('ОШИБКА ХАРНЕССА: ' + e.stack);
    C.check('harness без ошибок', false, e.message);
  } finally {
    C.save();
    console.log('\nC: ' + C.passed + ' passed, ' + C.failed + ' failed');
    env.cleanup();
    process.exit(C.failed ? 1 : 0);
  }
})();
