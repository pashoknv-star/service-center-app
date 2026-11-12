#!/usr/bin/env node
// V6-2: проверка календаря «Задачи» в РЕАЛЬНОМ Chromium (CDP, без зависимостей; вне gate verify_all.sh).
// Поднимает `php -S` на копии data/app.db (SC_APP_DB), логинится curl-подобным fetch (пароль в браузер не вводится —
// cookie ставится через CDP), засевает синтетические задачи и проверяет геометрию, клики мышью, роли, нагрузку;
// складывает скриншоты 1280/375 в reports/V6/V6-2_screens/ и результаты в browser_results.json.
// Запуск: node scripts/calendar_browser.js [outDir]
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'reports/V6/V6-2_screens'));
const REAL_DB = path.join(ROOT, 'data/app.db');
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell');
fs.mkdirSync(OUT, { recursive: true });

const results = { checks: [], perf: {}, notes: [] };
let passed = 0, failed = 0;
function check(name, cond, extra) {
  results.checks.push({ name, ok: !!cond, extra: cond ? undefined : extra });
  if (cond) { passed++; console.log('  PASS  ' + name); } else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
}
async function login(base, user) {
  const r = await fetch(base + '/api/login.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: 'changeme' }) });
  if (r.status !== 200) throw new Error('login ' + user + ' → ' + r.status);
  const set = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
  return set.filter(Boolean).map((c) => c.split(';')[0]);
}
async function http(base, cookie, method, url, body) {
  const r = await fetch(base + '/' + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, json: j || {} };
}

// ---------------------------------------------------------------- CDP
class CDP {
  constructor(url) { this.id = 0; this.pending = new Map(); this.ws = new WebSocket(url); this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); this.events = []; this.ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') this.events.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300)); if (d.id && this.pending.has(d.id)) { const p = this.pending.get(d.id); this.pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } }; }
  send(method, params, timeout) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('CDP timeout ' + method)); }, timeout || 60000);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async ev(expr, timeout) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

async function main() {
  console.log('=== V6-2 CALENDAR — real Chromium ===');
  const tmpDb = path.join(os.tmpdir(), 'sc_cal_browser_' + process.pid + '.db');
  fs.copyFileSync(REAL_DB, tmpDb);
  const port = await freePort(), base = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, { SC_APP_DB: tmpDb }); delete env.TASKS_VALIDATE_WEBHOOK_URL;
  const srv = cp.spawn('php', ['-S', '127.0.0.1:' + port, '-t', ROOT], { env, cwd: ROOT, stdio: 'ignore' });
  const cport = await freePort();
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'cal_chrome_'));
  const chrome = cp.spawn(CHROME, ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=' + cport, '--user-data-dir=' + udd, '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' });
  const cleanup = () => { try { srv.kill(); } catch (e) { /* */ } try { chrome.kill(); } catch (e) { /* */ } try { fs.unlinkSync(tmpDb); } catch (e) { /* */ } try { fs.rmSync(udd, { recursive: true, force: true }); } catch (e) { /* */ } };
  try {
    for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/api/session.php'); if (r.status < 500) break; } catch (e) { /* */ } await sleep(100); }
    let ws = null;
    for (let i = 0; i < 100 && !ws; i++) { try { const l = await (await fetch('http://127.0.0.1:' + cport + '/json/list')).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch (e) { /* */ } if (!ws) await sleep(100); }
    if (!ws) throw new Error('chromium не поднялся');
    const cdp = new CDP(ws); await cdp.ready;
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    const ver = await (await fetch('http://127.0.0.1:' + cport + '/json/version')).json();
    results.browser = ver.Browser;
    console.log('  browser: ' + ver.Browser);

    // ---- данные
    const adminCookies = await login(base, 'admin');
    const adminCk = adminCookies.join('; ');
    const emp = await http(base, adminCk, 'GET', 'api/employees.php');
    const eList = (Array.isArray(emp.json) ? emp.json : emp.json.data || emp.json.employees || []).map((e) => String(e.id));
    if (eList.length < 4) throw new Error('в dev-БД мало сотрудников: ' + eList.length);
    const [e1, e2, e3, e4] = eList.slice(0, 4);
    const WK = '2099-06-08', day = (n) => { const d = new Date(Date.UTC(2099, 5, 8 + n)); return d.toISOString().slice(0, 10); };
    const wed = day(2), tue = day(1), thu = day(3), fri = day(4), sat = day(5);
    const seed = [
      ['Планёрка отдела', wed + 'T09:00', wed + 'T10:30', [e1]],
      ['Согласование договора', wed + 'T09:30', wed + 'T11:00', [e2]],
      ['Звонок клиенту', wed + 'T10:00', wed + 'T10:45', [e3]],
      ['Обед с партнёрами', wed + 'T12:00', wed + 'T13:00', [e1, e2]],
      ['Отчёт по продажам', wed + 'T13:00', wed + 'T14:00', [e4]],
      ['Только время начала', wed + 'T15:00', null, [e3]],
      ['Короткая встреча 15 минут', wed + 'T16:00', wed + 'T16:15', [e1]],
      ['Ночная выгрузка данных', wed + 'T23:00', wed + 'T23:30', [e2]],
      ['Инвентаризация склада', tue, null, [e1]],
      ['Приёмка оборудования', tue, null, [e2]],
      ['Командировочный отчёт', tue + 'T09:00', thu + 'T18:00', [e3]],
      ['Пятничная планёрка', fri + 'T11:00', fri + 'T12:00', [e1]],
      ['Пятничный созвон', fri + 'T11:30', fri + 'T12:30', [e2]],
      ['Субботнее дежурство', sat, null, [e4]],
    ];
    const ids = {};
    for (const [title, s, e, as] of seed) {
      const r = await http(base, adminCk, 'POST', 'api/tasks.php', { title, start_at: s, end_at: e, assignees: as });
      if (r.status !== 201) throw new Error('seed ' + title + ' → ' + r.status + ' ' + JSON.stringify(r.json));
      ids[title] = r.json.task.id;
    }
    console.log('  seeded ' + seed.length + ' tasks, week ' + WK);

    async function setCookies(cookies) {
      await cdp.send('Network.clearBrowserCookies');
      for (const c of cookies) { const [n, ...v] = c.split('='); await cdp.send('Network.setCookie', { name: n, value: v.join('='), url: base + '/' }); }
    }
    async function size(w, h) { await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); }
    async function shot(name) { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64')); console.log('  shot ' + name + '.png'); }
    async function waitFor(expr, ms) { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { try { if (await cdp.ev(expr)) return true; } catch (e) { /* */ } await sleep(150); } return false; }
    async function load(cookies) {
      await setCookies(cookies);
      await cdp.send('Page.navigate', { url: base + '/index.html' });
      const ok = await waitFor('!!(window.Tasks && window.Tasks.__t && document.getElementById("tabTasks"))', 60000);
      if (!ok) throw new Error('index.html: window.Tasks не появился');
      await sleep(1500);
    }
    async function openCal(date, mode) {
      await cdp.ev('window.Tasks.open({employeeId:"",date:' + JSON.stringify(date) + ',view:"calendar",mode:' + JSON.stringify(mode) + '})');
      const ok = await waitFor('!!document.querySelector("#tasksView .tk-cal-bd") && !window.Tasks.__t.S.loading', 30000);
      await sleep(400);
      return ok;
    }
    const metrics = () => cdp.ev(`(() => {
      const R = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      const q = (s) => [...document.querySelectorAll('#tasksView ' + s)];
      const cal = document.querySelector('#tasksView .tk-wk');
      const days = q('.tk-cal-bd .tk-day').map((d) => ({ date: d.dataset.date, r: R(d) }));
      const tiles = q('.tk-cal-bd .tk-ev-t').map((t) => { const d = t.closest('.tk-day'); return { id: t.dataset.id, date: d.dataset.date, r: R(t), day: R(d), s: +t.dataset.s, e: +t.dataset.e, col: +t.dataset.col, cols: +t.dataset.cols, text: t.innerText, title: t.title }; });
      return { scrollTop: cal.scrollTop, scrollHeight: cal.scrollHeight, clientHeight: cal.clientHeight, clientWidth: cal.clientWidth, scrollWidth: cal.scrollWidth, wk: R(cal),
        hr: q('.tk-hr').map((e) => R(e).h), slots: [...document.querySelector('#tasksView .tk-cal-bd .tk-day').querySelectorAll('.tk-slot')].map((e) => R(e).h), dayH: days.map((d) => d.r.h), dayW: days.map((d) => d.r.w), days, tiles,
        hd: q('.tk-wk-h').length, hrLabels: q('.tk-hr').map((e) => e.textContent), adTiles: q('.tk-cal-ad .tk-ev').length, now: q('.tk-now').map(R),
        hdRect: R(document.querySelector('#tasksView .tk-cal-hd')), adRect: R(document.querySelector('#tasksView .tk-cal-ad')) };
    })()`);

    // ======================================================== admin, 1280
    await size(1280, 900);
    await load(adminCookies);
    check('B0 страница index.html загрузилась в реальном Chromium, модуль Tasks инициализирован', true);
    check('B1 календарь «Неделя» открыт через Tasks.open', await openCal(wed, 'week'));
    let m = await metrics();
    const eq = (arr, v, tol) => arr.length > 0 && arr.every((x) => Math.abs(x - v) <= (tol || 0.01));
    check('B2 24 строки часов 00…23, каждая высотой ровно 48 px', m.hr.length === 24 && eq(m.hr, 48) && m.hrLabels[0] === '00:00' && m.hrLabels[23] === '23:00', JSON.stringify(m.hr.slice(0, 3)));
    check('B3 48 ячеек получаса в дне, каждая 24 px; высота колонки дня = 1152 px (00:00–24:00)', m.slots.length === 48 && eq(m.slots, 24) && eq(m.dayH, 1152, 0.5), m.dayH.join());
    check('B4 7 колонок дней одинаковой ширины (равный отступ)', m.days.length === 7 && Math.max(...m.dayW) - Math.min(...m.dayW) < 1, m.dayW.join());
    check('B5 при открытии прокрутка на 08:00 (scrollTop = 384)', Math.abs(m.scrollTop - 384) <= 1, m.scrollTop);
    const geom = m.tiles.filter((t) => t.date === wed).map((t) => ({ id: t.id, dTop: t.r.y - t.day.y, dh: t.r.h, exTop: t.s * 0.8, exH: Math.max((t.e - t.s) * 0.8, 18) }));
    check('B6 позиция/высота плиток в реальной раскладке: top = начало×0.8 px, height = длительность×0.8 px (±1 px)', geom.length === 8 && geom.every((g) => Math.abs(g.dTop - g.exTop) <= 1.01 && Math.abs(g.dh - g.exH) <= 1.01), JSON.stringify(geom.filter((g) => Math.abs(g.dTop - g.exTop) > 1.01 || Math.abs(g.dh - g.exH) > 1.01)));
    const tw = m.tiles.filter((t) => t.date === wed);
    const inter = (a, b) => a.r.x < b.r.x + b.r.w - 0.5 && b.r.x < a.r.x + a.r.w - 0.5 && a.r.y < b.r.y + b.r.h - 0.5 && b.r.y < a.r.y + a.r.h - 0.5;
    let overl = [];
    for (let i = 0; i < tw.length; i++) for (let j = i + 1; j < tw.length; j++) if (inter(tw[i], tw[j])) overl.push(tw[i].id + '×' + tw[j].id);
    check('B7 ни одна пара плиток в дне не накладывается друг на друга (визуально, по getBoundingClientRect)', overl.length === 0, overl.join());
    const lane3 = tw.filter((t) => t.cols === 3);
    check('B8 три пересекающиеся задачи (09:00–10:30, 09:30–11:00, 10:00–10:45) — 3 дорожки по ~1/3 ширины колонки, рядом', lane3.length === 3 && lane3.every((t) => Math.abs(t.r.w - (t.day.w / 3 - 6)) <= 1.5) && new Set(lane3.map((t) => Math.round(t.r.x))).size === 3, JSON.stringify(lane3.map((t) => [t.cols, Math.round(t.r.w), Math.round(t.day.w)])));
    const touch = tw.filter((t) => /Обед|Отчёт по/.test(t.text));
    check('B9 касание концов (обед до 13:00, отчёт с 13:00) — не пересечение: обе плитки во всю ширину колонки', touch.length === 2 && touch.every((t) => t.cols === 1 && Math.abs(t.r.w - (t.day.w - 6)) <= 1.5), JSON.stringify(touch.map((t) => [t.cols, t.r.w, t.day.w])));
    const fri2 = m.tiles.filter((t) => t.date === fri);
    check('B10 пятница: 11:00–12:00 и 11:30–12:30 — две дорожки по 1/2 ширины', fri2.length === 2 && fri2.every((t) => t.cols === 2 && Math.abs(t.r.w - (t.day.w / 2 - 6)) <= 1.5));
    check('B11 «Весь день»: безвременные (вт ×2, сб) и многодневная «Командировочный отчёт» (вт–чт, на 3 днях) = 6 плиток — в полосе над сеткой, а не в сетке', m.adTiles === 6 && !m.tiles.some((t) => /Командировочный|Инвентаризация/.test(t.text)), m.adTiles);
    check('B12 шапка и «Весь день» над сеткой, сетка прокручивается ниже них (sticky): hd.bottom ≤ ad.top+1, высота шапки 36', m.hdRect.h === 36 && m.adRect.y >= m.hdRect.y + m.hdRect.h - 1);
    const tt = m.tiles.find((t) => /Обед/.test(t.text));
    check('B13 текст плитки в браузере — время и тема, без ФИО; исполнитель — в title', tt && /^12:00–13:00\s*Обед с партнёрами/.test(tt.text.replace(/\n/g, ' ')) && !/Test|Ivanov|Petrov/.test(tt.text) && /Исполнители: /.test(tt.title), tt && JSON.stringify([tt.text, tt.title]));
    // визуальные значки на скриншоте
    await cdp.ev(`(() => { const T = window.Tasks.__t, S = T.S; const f = (t) => S.tasks.find((x) => x.title === t);
      f('Согласование договора').conflict = true; f('Только время начала').check_state = 'pending';
      const o = f('Короткая встреча 15 минут'); o.orphan = true; o.assignees = [{ employee_id: 'x', full_name: 'Удалённый Сотрудник', removed: true }];
      f('Инвентаризация склада').conflict = true; T.render(); })()`);
    await sleep(300);
    await shot('R9_week_1280');
    // значки в DOM
    const ic = await cdp.ev(`[...document.querySelectorAll('#tasksView .tk-ev-ic')].map((e) => e.className + ':' + e.textContent + ':' + e.title)`);
    check('B14 значки на плитках в реальном DOM: конфликт «!», не проверено «?», без исполнителя «0»', ic.some((s) => /tk-ic-conf:!:Конфликт/.test(s)) && ic.some((s) => /tk-ic-pend:\?:Не проверено/.test(s)) && ic.some((s) => /tk-ic-orph:0:Без исполнителя/.test(s)), ic.join('|'));
    // ---- «Сейчас»
    // (линия «сейчас» — отдельным сценарием ниже, в текущей неделе)

    // ---- клики мышью по ячейкам
    async function clickAt(x, y) { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); }
    const hourRect = (d, hh) => cdp.ev(`(() => { const day = document.querySelector('#tasksView .tk-day[data-date="${d}"]'); const r = day.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    async function scrollToHour(h) { await cdp.ev(`(() => { const c = document.querySelector('#tasksView .tk-wk'); c.scrollTop = ${h} * 48 - 120; })()`); await sleep(150); }
    async function clickCell(d, hh, half, xFrac) {
      await scrollToHour(hh);
      const dr = await hourRect(d);
      const y = dr.y + hh * 48 + (half ? 36 : 10), x = dr.x + dr.w * (xFrac || 0.9);
      await clickAt(x, y);
      await sleep(350);
      return cdp.ev(`(() => { const g = (f) => { const e = document.querySelector('#tasksView [data-tk-field="' + f + '"]'); return e ? e.value : null; };
        return { form: !!document.querySelector('#tasksView form.tk-form'), h4: (document.querySelector('#tasksView .tk-form h4') || {}).textContent, startDate: g('startDate'), startTime: g('startTime'), endDate: g('endDate'), endTime: g('endTime'), kind: (document.querySelector('#tasksView input[name=tkKind]:checked') || {}).value }; })()`);
    }
    let f = await clickCell(day(4), 14, false);
    check('K1 реальный клик по пятнице, 14:00–14:30 (верхняя половина часа) → форма «Новая задача»: ' + day(4) + ', 14:00–15:00, «Период»', f.form && f.h4 === 'Новая задача' && f.startDate === day(4) && f.endDate === day(4) && f.startTime === '14:00' && f.endTime === '15:00' && f.kind === 'period', JSON.stringify(f));
    await shot('R10_form_from_cell_1280');
    await cdp.ev('document.querySelector(\'#tasksView [data-tk-act="cancelForm"]\').click()'); await sleep(300);
    f = await clickCell(day(0), 9, true);
    check('K2 клик в нижнюю половину часа (понедельник, 09:30–10:00) → начало 09:30, конец 10:30', f.form && f.startDate === day(0) && f.startTime === '09:30' && f.endTime === '10:30', JSON.stringify(f));
    await cdp.ev('document.querySelector(\'#tasksView [data-tk-act="cancelForm"]\').click()'); await sleep(300);
    check('K3 «Отмена» возвращает в календарь недели с сохранённой прокруткой', await cdp.ev('!!document.querySelector("#tasksView .tk-cal-bd")') && Math.abs((await metrics()).scrollTop - (9 * 48 - 120)) <= 2);
    // клик по плитке
    await scrollToHour(12);
    const tp2 = await cdp.ev(`(() => { const t = [...document.querySelectorAll('#tasksView .tk-ev-t')].find((e) => /Обед/.test(e.textContent)); const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await clickAt(tp2.x, tp2.y); await sleep(350);
    check('K4 реальный клик по плитке «Обед с партнёрами» — открывается карточка справа (не форма создания)', await cdp.ev(`!document.querySelector('#tasksView form.tk-form') && /Обед с партнёрами/.test((document.querySelector('#tasksView .tk-detail')||{}).textContent||'') && window.Tasks.__t.S.selectedId === ${JSON.stringify(ids['Обед с партнёрами'])}`));
    await shot('R6_week_card_1280');

    // ---- «День» 1280
    await cdp.ev('document.querySelector(\'#tasksView [data-tk-act="calMode"][data-mode="day"]\').click()');
    await waitFor('document.querySelectorAll("#tasksView .tk-wk-h").length === 1 && !window.Tasks.__t.S.loading', 20000); await sleep(400);
    await cdp.ev('window.Tasks.__t.S.selectedId = null; window.Tasks.__t.render()'); await sleep(200);
    m = await metrics();
    check('B15 «День»: одна колонка, 24 строки по 48 px, колонка дня = 1152 px, плитки раскладываются так же (3 дорожки на 09:00–11:00)', m.hd === 1 && eq(m.hr, 48) && eq(m.dayH, 1152, 0.5) && m.tiles.filter((t) => t.cols === 3).length === 3, JSON.stringify([m.hd, m.dayH, m.tiles.length]));
    await cdp.ev('document.querySelector("#tasksView .tk-wk").scrollTop = 6 * 48'); await sleep(200);
    await shot('R9_day_1280');

    // ---- форма с временем (R-3), 1280
    await cdp.ev('document.querySelector(\'#tasksView [data-tk-act="calMode"][data-mode="week"]\').click()'); await waitFor('!window.Tasks.__t.S.loading', 20000);
    await cdp.ev('window.Tasks.__t.ACTIONS.editTask({ dataset: { id: ' + JSON.stringify(ids['Планёрка отдела']) + ' } })'); await sleep(300);
    const tsel = await cdp.ev(`(() => { const o = (f) => { const s = document.querySelector('#tasksView [data-tk-field="' + f + '"]'); return s ? { tag: s.tagName, n: s.options.length, first: s.options[0].textContent, second: s.options[1].textContent, last: s.options[s.options.length - 1].textContent, val: s.value } : null; };
      return { start: o('startTime'), end: o('endTime'), timeInputs: document.querySelectorAll('#tasksView input[type=time]').length, kind: (document.querySelector('#tasksView input[name=tkKind]:checked')||{}).value }; })()`);
    check('F-1 форма в реальном браузере: «Начало» — <select> из 49 пунктов «—, 00:00 … 23:30», выбрано 09:00; <input type=time> нет', tsel.start && tsel.start.tag === 'SELECT' && tsel.start.n === 49 && tsel.start.first === '—' && tsel.start.second === '00:00' && tsel.start.last === '23:30' && tsel.start.val === '09:00' && tsel.timeInputs === 0, JSON.stringify(tsel));
    check('F-2 «Конец» (период): <select>, выбрано 10:30', tsel.end && tsel.end.tag === 'SELECT' && tsel.end.n === 49 && tsel.end.val === '10:30');
    await shot('R3_form_time_1280');
    // реальное нажатие мышью на список времени: открываем select и выбираем клавишами (headless не рисует popup)
    await cdp.ev('document.querySelector(\'#tasksView [data-tk-act="cancelForm"]\').click()'); await sleep(200);

    // ======================================================== 375
    await size(375, 812);
    await sleep(500);
    check('M0 375 px: календарь «Неделя»', await openCal(wed, 'week'));
    await cdp.ev('window.Tasks.__t.S.selectedId = null; window.Tasks.__t.render()'); await sleep(300);
    m = await metrics();
    check('M1 375 px: страница не ломается — горизонтальной прокрутки у документа нет, календарь прокручивается внутри себя', await cdp.ev('document.documentElement.scrollWidth <= window.innerWidth + 1') && m.scrollWidth > m.clientWidth, JSON.stringify([m.scrollWidth, m.clientWidth]));
    check('M2 375 px: строки часов по-прежнему 48 px, 24 шт., колонка дня 1152 px', m.hr.length === 24 && eq(m.hr, 48) && eq(m.dayH, 1152, 0.5));
    await shot('R9_week_375');
    await cdp.ev('document.querySelector(\'#tasksView [data-tk-act="calMode"][data-mode="day"]\').click()'); await waitFor('document.querySelectorAll("#tasksView .tk-wk-h").length === 1 && !window.Tasks.__t.S.loading', 20000); await sleep(400);
    m = await metrics();
    check('M3 375 px, «День»: колонка дня на всю ширину (≥ 200 px), 3 дорожки в 09:00–11:00, плитки не накладываются',
      m.dayW[0] >= 200 && (() => { const tw2 = m.tiles.filter((t) => t.date === wed); for (let i = 0; i < tw2.length; i++) for (let j = i + 1; j < tw2.length; j++) if (inter(tw2[i], tw2[j])) return false; return tw2.filter((t) => t.cols === 3).length === 3; })(), JSON.stringify(m.dayW));
    await cdp.ev('document.querySelector("#tasksView .tk-wk").scrollTop = 6 * 48'); await sleep(200);
    await shot('R9_day_375');
    // клик мышью на 375
    await cdp.ev('window.Tasks.__t.S.cal.scrollTop = null; window.Tasks.__t.render()'); await sleep(200);
    f = await clickCell(wed, 16, true, 0.5);
    check('K5 375 px: реальный клик по ячейке среды 16:30 → форма: 16:30–17:30', f.form && f.startDate === wed && f.startTime === '16:30' && f.endTime === '17:30' && f.kind === 'period', JSON.stringify(f));
    await shot('R10_form_from_cell_375');
    await cdp.ev('window.Tasks.__t.ACTIONS.cancelForm()'); await sleep(200);
    await cdp.ev('window.Tasks.__t.ACTIONS.editTask({ dataset: { id: ' + JSON.stringify(ids['Планёрка отдела']) + ' } })'); await sleep(300);
    await shot('R3_form_time_375');
    check('F-3 375 px: форма с выпадающими списками времени помещается в ширину (нет горизонтальной прокрутки страницы)', await cdp.ev('document.documentElement.scrollWidth <= window.innerWidth + 1'));
    await cdp.ev('window.Tasks.__t.ACTIONS.cancelForm()'); await sleep(200);

    // ======================================================== «сейчас» (текущая неделя)
    await size(1280, 900);
    const today = await cdp.ev('(() => { const n = new Date(); return n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0") + "-" + String(n.getDate()).padStart(2, "0"); })()');
    const nowMin = await cdp.ev('(() => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); })()');
    await cdp.ev('window.Tasks.__t.S.cal.mode = "week"');
    await openCal(today, 'week');
    await cdp.ev('document.querySelector("#tasksView .tk-wk").scrollTop = Math.max(0, ' + nowMin + ' * 0.8 - 250)'); await sleep(250);
    m = await metrics();
    check('N-1 текущая неделя: линия «сейчас» одна, в колонке сегодняшнего дня, на высоте минут×0.8 px (±2)', m.now.length === 1 && Math.abs((m.now[0].y - m.days.find((d) => d.date === today).r.y) - nowMin * 0.8) <= 2, JSON.stringify(m.now));
    await shot('R9_week_now_line_1280');
    await openCal(day(0), 'week');
    check('N-2 неделя без сегодняшнего дня: линии «сейчас» нет', (await metrics()).now.length === 0);

    // ======================================================== роли
    for (const [role, login_] of [['supervisor', 'supervisor_zone0'], ['viewer', 'viewer_test']]) {
      await size(1280, 900);
      await load(await login(base, login_));
      await openCal(wed, 'week');
      const rm = await metrics();
      await scrollToHour(10);
      const dr = await hourRect(wed);
      await clickAt(dr.x + dr.w * 0.9, dr.y + 10 * 48 + 10); await sleep(400);
      const st = await cdp.ev(`({ form: !!document.querySelector('#tasksView form.tk-form'), cells: document.querySelectorAll('#tasksView [data-tk-act="calCell"]').length, can: document.querySelectorAll('#tasksView .tk-can').length, role: (window.Tasks.__t.S.user||{}).role, tiles: document.querySelectorAll('#tasksView .tk-ev').length })`);
      check('RL-' + role + ' (реальная сессия, реальный клик по ячейке 10:00): форма не открылась, ячеек создания нет, календарь и плитки видны', !st.form && st.cells === 0 && st.can === 0 && st.tiles > 5 && rm.hr.length === 24, JSON.stringify(st));
      if (role === 'viewer') await shot('R10_viewer_week_1280');
      await cdp.ev('window.Tasks.__t.ACTIONS.calCell({ dataset: { date: ' + JSON.stringify(wed) + ', min: "600" } })'); await sleep(200);
      check('RL-' + role + '-2 принудительный вызов обработчика calCell тоже ничего не открывает', !(await cdp.ev('!!document.querySelector("#tasksView form.tk-form")')));
    }

    // ======================================================== нагрузка (admin)
    await size(1280, 900);
    await load(adminCookies);
    await openCal(wed, 'week');
    const perf = await cdp.ev(`(async () => {
      const T = window.Tasks.__t, S = T.S;
      const emps = Array.from({ length: 50 }, (_, i) => ({ id: 'emp_' + (500 + i), name: 'Сотрудник Нагрузочный ' + (i + 1) }));
      S.employees = emps; S.empById = {}; emps.forEach((e) => { S.empById[e.id] = e; });
      let seed = 11; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      const base = new Date(Date.UTC(2099, 5, 8)); const D = (n) => new Date(base.getTime() + n * 86400000).toISOString().slice(0, 10);
      const hm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
      const tasks = []; let n = 0;
      emps.forEach((e, i) => { for (let k = 0; k < 3; k++) { const d = D(Math.floor(rnd() * 7)), s = (8 + Math.floor(rnd() * 20)) * 30, dur = (1 + Math.floor(rnd() * 4)) * 30, timed = rnd() > 0.2;
        tasks.push({ id: 'L' + (n++), title: 'Задача ' + (i + 1) + '.' + (k + 1), description: 'Описание', start_at: timed ? d + 'T' + hm(s) : d, end_at: timed ? d + 'T' + hm(Math.min(s + dur, 1439)) : null, first_day: d, last_day: d, status: 'open', archived: 0, priority: 2, version: 1,
          assignees: [{ employee_id: e.id, full_name: e.name, removed: false }], orphan: false, notes: [], conflict: false, conflict_days: [], check_state: 'ok', label: '', checklist: [], watchers: [] }); } });
      const out = { tasks: tasks.length };
      for (const mode of ['week', 'day']) {
        S.cal.mode = mode; S.cal.anchor = D(2); S.tasks = tasks; S.view = 'calendar'; S.form = null;
        const js = [], lay = [], paint = [];
        for (let i = 0; i < 7; i++) {
          const t0 = performance.now(); T.render(); const t1 = performance.now(); void document.body.offsetHeight; const t2 = performance.now();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const t3 = performance.now();
          js.push(t1 - t0); lay.push(t2 - t1); paint.push(t3 - t0);
        }
        const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
        out[mode] = { renderJsMs: +med(js).toFixed(1), layoutMs: +med(lay).toFixed(1), toPaintMs: +med(paint).toFixed(1), nodes: document.querySelectorAll('#tasksView *').length, tiles: document.querySelectorAll('#tasksView .tk-ev').length, htmlKB: Math.round(document.getElementById('tasksView').innerHTML.length / 1024) };
      }
      S.cal.mode = 'week'; S.cal.anchor = D(2); T.render();
      return out;
    })()`, 120000);
    results.perf = perf;
    console.log('  perf: ' + JSON.stringify(perf));
    check('P-1 нагрузка в реальном Chromium: неделя, 50 сотрудников × 3 задачи (150) — полный render + layout + paint < 500 мс (медиана)', perf.week.toPaintMs < 500 && perf.tasks === 150, JSON.stringify(perf.week));
    await shot('R9_week_load_50x3_1280');
    check('Z-0 необработанных исключений на странице за весь прогон нет (Runtime.exceptionThrown)', cdp.events.length === 0, cdp.events.join(' | '));
  } catch (e) {
    check('FATAL', false, (e && e.stack) || e);
  } finally {
    cleanup();
  }
  fs.writeFileSync(path.join(OUT, 'browser_results.json'), JSON.stringify(results, null, 1));
  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}
main();
