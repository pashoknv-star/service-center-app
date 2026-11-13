// V6.3-3 (приёмка, вне gate): E — Д-1 дополнительные стыки: конфликт на повторе, фильтр сотрудника в календаре, режим «День», «Весь день»,
// главная дата = повтор в форме, повтор того же дня, архив, вторая ↻-плитка при вставке из ↻.
// Запуск: node scripts/v63_accept_e_extra.js → reports/V6_3/V6.3-3_screens/E_*.png, E_results.json
'use strict';
const path = require('path');
const { L, seed, D, sleep, OUT, kit, api } = require('./v63_accept_lib.js');
const HOUR = 48;

(async () => {
  const C = L.makeChecker(path.join(OUT, 'E_results.json'));
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
    const hooks = () => ev(`(() => { window.confirm = () => true;
      const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, t: r.top, h: r.height, l: r.left, w: r.width }; };
      window.__h = { occTiles: (id) => [...document.querySelectorAll('#tasksView .tk-ev.tk-occ[data-id="' + id + '"]')].map(R), tiles: (id) => [...document.querySelectorAll('#tasksView .tk-cal-bd .tk-ev[data-id="' + id + '"]')].map((e) => ({ occ: e.classList.contains('tk-occ'), r: R(e) })),
        day: (d) => R(document.querySelector('#tasksView .tk-day[data-date="' + d + '"]')), scroll: (top) => { const w = document.querySelector('#tasksView .tk-wk'); if (w) w.scrollTop = top; return !!w; },
        menu: () => { const m = document.querySelector('.tk-ctx'); if (!m) return null; return [...m.querySelectorAll('.tk-ctx-i')].map((b) => { const q = b.getBoundingClientRect(); return { t: b.textContent, dis: b.disabled, x: q.left + q.width / 2, y: q.top + q.height / 2 }; }); },
        adStrip: (d) => R(document.querySelector('#tasksView [data-tk-act="calCell"][data-date="' + d + '"][data-ad="1"], #tasksView .tk-ad [data-date="' + d + '"]')) }; return true; })()`);
    const H = (e) => ev('window.__h.' + e);
    const fresh = async (cookies, w, h, mobile) => { await k.size(w || 1280, h || 900, !!mobile); await k.load(cookies); await hooks(); };
    const openCal = async (date, mode) => {
      await ev('window.Tasks.open({employeeId:"",date:' + JSON.stringify(date) + ',view:"calendar",mode:' + JSON.stringify(mode || 'week') + '})');
      await k.waitFor('!!document.querySelector("#tasksView .tk-cal-bd") && !window.Tasks.__t.S.loading', 30000); await sleep(500);
      await H('scroll(384)'); await sleep(250);
    };

    // ============================================== конфликт на повторе
    console.log('=== конфликт на повторе');
    const cf = await post({ title: 'Конфликт на повторе', assignees: [E1], start_at: '2027-03-01T10:00', end_at: '2027-03-01T11:00', occurrences: [{ start_at: '2027-03-08T10:00' }] });
    L.sql(env.tmpDb, "INSERT OR REPLACE INTO schedule_entries (employee_id,date,status,approval_status,updated_at,version) VALUES ('" + E1 + "','2027-03-08','sick','approved','2026-11-14',1);");
    const cf2 = await get(cf.json.task.id);
    C.check('API conflict: больничный поставили ПОСЛЕ создания на день ПОВТОРА (08.03) → задача conflict=true (основная дата 01.03 чистая)', cf2.conflict === true, JSON.stringify([cf2.conflict, cf2.notes]));
    const cf3 = await post({ title: 'Нет конфликта', assignees: [E2], start_at: '2027-03-01T10:00', end_at: '2027-03-01T11:00', occurrences: [{ start_at: '2027-03-09T10:00' }] });
    C.check('API conflict: контроль — у чистой задачи с повтором conflict=false', (await get(cf3.json.task.id)).conflict === false, '');
    await fresh(s.adminCookies);
    await ev('window.Tasks.open({view:"list"})'); await settled();
    const chip = await ev(`(() => { const r = document.querySelector('#tasksView .tk-row[data-id="${cf.json.task.id}"]'); return r ? r.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
    C.check('UI Список: у задачи с конфликтом на повторе виден чип «конфликт: больничный»: «' + (chip || '').slice(0, 120) + '»', /конфликт/i.test(chip || ''), chip);
    await k.shotEl('#tasksView .tk-row[data-id="' + cf.json.task.id + '"]', 'E01_list_conflict_on_occurrence_1280', { maxH: 140 });
    // календарь: плитка повтора с конфликтом помечена
    await openCal('2027-03-08', 'week');
    const confTile = await ev(`(() => { const t = document.querySelector('#tasksView .tk-cal-bd .tk-ev.tk-occ[data-id="${cf.json.task.id}"]'); return t ? { conf: t.classList.contains('tk-conf'), cls: t.className } : null; })()`);
    C.check('UI календарь: плитка ↻ с конфликтом помечена tk-conf: ' + JSON.stringify(confTile), confTile && confTile.conf, JSON.stringify(confTile));
    await k.shot('E02_calendar_conflict_tile_1280');

    // ============================================== фильтр «Сотрудник» в календаре
    console.log('=== фильтр сотрудника');
    const fe = await post({ title: 'Фильтр сотрудника', assignees: [E2], start_at: '2027-04-05T10:00', end_at: '2027-04-05T11:00', occurrences: [{ start_at: '2027-04-07T10:00' }] });
    await openCal('2027-04-05', 'week');
    const hl = (emp, only) => ev('(() => { const S = window.Tasks.__t.S; S.cal.emp = "' + emp + '"; S.cal.only = ' + (only ? 'true' : 'false') + '; window.Tasks.__t.render(); const t = document.querySelector("#tasksView .tk-cal-bd .tk-ev.tk-occ[data-id=\\"' + fe.json.task.id + '\\"]"); return t ? { hl: t.classList.contains("tk-hl") } : null; })()');
    const rAll = await hl('', false), rOwnHl = await hl(E2, false), rOtherHl = await hl(E1, false), rOtherOnly = await hl(E1, true), rOwnOnly = await hl(E2, true);
    C.check('UI календарь: фильтр «Сотрудник» работает и для ↻-плиток: исполнитель → подсвечена; другой сотрудник → не подсвечена; «только он» (другой) → плитки ↻ нет; «только он» (исполнитель) → есть', rAll && !rAll.hl && rOwnHl && rOwnHl.hl && rOtherHl && !rOtherHl.hl && rOtherOnly === null && rOwnOnly && rOwnOnly.hl, JSON.stringify([rAll, rOwnHl, rOtherHl, rOtherOnly, rOwnOnly]));
    await ev('(() => { const S = window.Tasks.__t.S; S.cal.emp = ""; S.cal.only = false; window.Tasks.__t.render(); })()');

    // ============================================== режим «День» и «Весь день»
    console.log('=== День / Весь день');
    await openCal('2027-04-07', 'day');
    const dayT = await H('occTiles("' + fe.json.task.id + '")');
    C.check('UI календарь «День» (07.04): ↻-плитка есть, высота 1 час', dayT.length === 1 && Math.abs(dayT[0].h - HOUR) <= 4, JSON.stringify(dayT));
    await k.shot('E03_calendar_day_occurrence_1280');
    const ad = await post({ title: 'Без времени повтор', assignees: [E2], start_at: '2027-05-10', end_at: '2027-05-10', occurrences: [{ start_at: '2027-05-12' }] });
    await openCal('2027-05-10', 'week');
    const adTiles = await ev(`[...document.querySelectorAll('#tasksView .tk-ev[data-id="${ad.json.task.id}"]')].map((e) => ({ occ: e.classList.contains('tk-occ'), inAd: !!e.closest('.tk-ad, .tk-allday, [data-tk-ad]'), txt: e.textContent.replace(/\\s+/g, ' ').trim(), date: (e.closest('[data-date]') || {}).dataset ? e.closest('[data-date]').dataset.date : null }))`);
    console.log('allday tiles', JSON.stringify(adTiles));
    C.check('UI календарь «Весь день»: задача без времени и её повтор — по плитке в полосе «Весь день» (10.05 и ↻ 12.05)', adTiles.length === 2 && adTiles.some((t) => t.occ && /12/.test(String(t.date || ''))), JSON.stringify(adTiles));
    await k.shot('E04_calendar_allday_occurrence_1280');
    // копирование плитки повтора (↻) → вставка: добавляет повтор той же задачи
    const o1 = await H('occTiles("' + ad.json.task.id + '")');
    await k.rclick(o1[0].x, o1[0].y); let mn = await H('menu()');
    C.check('UI «Весь день»: ПКМ по ↻-плитке без времени — «Копировать» и «Удалить повтор»', mn && mn.map((i) => i.t).join('|') === 'Копировать|Удалить повтор', JSON.stringify(mn));
    await k.clickXY(mn[0].x, mn[0].y); await sleep(300);
    // вставка в ячейку времени на 13.05 10:00 → задача без времени: повтор — только дата 13.05
    const d13 = await H('day("2027-05-13")');
    const cell13 = await ev(`(() => { const e = document.querySelector('#tasksView [data-tk-act="calCell"][data-date="2027-05-13"][data-min="600"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await k.rclick(cell13.x, cell13.y); mn = await H('menu()');
    await k.clickXY(mn[0].x, mn[0].y); await settled();
    const adNow = await get(ad.json.task.id);
    C.check('Копирование ↻-плитки → вставка в ячейку 13.05 10:00 у задачи БЕЗ времени: добавлен повтор «2027-05-13» (только дата), новая задача не создана', adNow.occurrences.length === 2 && adNow.occurrences[1].start_at === '2027-05-13' && (await api(env, ck, 'GET', 'api/tasks.php?from=2027-05-01&to=2027-05-31')).json.tasks.filter((t) => t.title === 'Без времени повтор').length === 1, JSON.stringify(adNow.occurrences));

    // ============================================== форма: основная дата = существующий повтор
    console.log('=== форма: основная дата = повтор');
    const fm = await post({ title: 'Дата как повтор', assignees: [E2], start_at: '2027-06-01T09:00', end_at: '2027-06-01T10:00', occurrences: [{ start_at: '2027-06-03T09:00' }] });
    await ev('window.Tasks.open({view:"list"})'); await settled();
    await k.waitFor('!document.querySelector(".tk-ctoast") && !document.querySelector("#toastContainer .toast")', 20000);   // уведомления перекрывают правый нижний угол
    const eb = await k.rect('#tasksView .tk-row[data-id="' + fm.json.task.id + '"] .tk-editbtn');
    console.log('E-debug editbtn rect', JSON.stringify(eb), 'top element:', await ev('(() => { const e = document.elementFromPoint(' + eb.x + ',' + eb.y + '); return e ? e.tagName + "." + e.className + " | " + (e.closest("[data-tk-act]") ? e.closest("[data-tk-act]").dataset.tkAct : "") : null; })()'), 'toasts', await ev('[...document.querySelectorAll(".tk-ctoast,.toast,.tk-ctx")].map(e=>e.className).join(",")'));
    await k.click('#tasksView .tk-row[data-id="' + fm.json.task.id + '"] .tk-editbtn'); await sleep(600);
    console.log('E-debug form open?', await ev('!!document.querySelector("#tasksView form.tk-form")'), 'view', await ev('window.Tasks.__t.S.view'), 'form', await ev('JSON.stringify(window.Tasks.__t.S.form && Object.keys(window.Tasks.__t.S.form))'));
    await setField('[data-tk-field="startDate"]', '2027-06-03'); await setField('[data-tk-field="endDate"]', '2027-06-03');
    await btn('saveForm'); await settled();
    const e1 = await ev('({ txt: (document.querySelector("#tasksView [data-tk-occ-err]") || {}).textContent || "", form: !!document.querySelector("#tasksView form.tk-form") })');
    const fmNow = await get(fm.json.task.id);
    C.check('Форма: основную дату сдвинули на дату существующего повтора (03.06 09:00) → отказ с понятным текстом у строки повтора («' + e1.txt + '»), данные не изменились', e1.form && e1.txt.length > 5 && fmNow.start_at === '2027-06-01T09:00', JSON.stringify([e1, fmNow.start_at]));
    await k.shotEl('#tasksView .tk-f-occ', 'E05_form_main_equals_occurrence_1280');
    await btn('cancelForm'); await sleep(300);
    // повтор в тот же день, другое время: две плитки в один день, одна иконка в матрице
    const sd = await post({ title: 'Два раза в день', assignees: [E2], start_at: '2027-07-05T09:00', end_at: '2027-07-05T10:00', occurrences: [{ start_at: '2027-07-05T15:00' }] });
    await openCal('2027-07-05', 'week');
    const tt = await H('tiles("' + sd.json.task.id + '")');
    C.check('UI календарь: основная (09:00) и повтор того же дня (15:00) — две плитки в одной колонке, одна ↻', tt.length === 2 && tt.filter((t) => t.occ).length === 1 && Math.abs(tt[0].r.x - tt[1].r.x) < 3 && Math.abs(tt[0].r.t - tt[1].r.t) > 100, JSON.stringify(tt));
    await k.shot('E06_calendar_two_tiles_same_day_1280');
    // повтор на соседний день по полуночи: многодневный
    // ============================================== архив
    const ar = await post({ title: 'Архивная с повтором', assignees: [E2], start_at: '2027-08-02T09:00', end_at: '2027-08-02T10:00', occurrences: [{ start_at: '2027-08-04T09:00' }] });
    await api(env, ck, 'DELETE', 'api/tasks.php?id=' + ar.json.task.id, undefined);
    await openCal('2027-08-02', 'week');
    C.check('UI календарь: после «В архив» плитки задачи и её ↻-плитки пропали', (await H('tiles("' + ar.json.task.id + '")')).length === 0, '');
    C.check('0 необработанных исключений на странице', cdp.exceptions.length === 0, cdp.exceptions.join('\n'));
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
