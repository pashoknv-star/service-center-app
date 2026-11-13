#!/usr/bin/env node
// T1-2 verification harness: js/tasks.js (панель «Задачи»: Список / Доска / Календарь).
//
// 1) статические проверки: каждая кнопка data-tk-act имеет обработчик (урок «4× мёртвых
//    кнопок»), нет inline-обработчиков, точечные вставки в index.html на месте,
//    inline-<script> index.html проходят синтаксис;
// 2) сквозной e2e БЕЗ браузера: js/tasks.js исполняется в vm с минимальным DOM-шимом и
//    ходит по HTTP в НАСТОЯЩИЙ api/tasks.php (временный `php -S` на копии data/app.db,
//    env SC_APP_DB — data/app.db не меняется, проверяется sha1):
//    создать → список → клик по фамилии → доска → календарь → закрыть;
//    ролевой доступ admin / supervisor / viewer (элементы записи не рендерятся,
//    API отвечает 403), 422 «принять предложенную дату», 409 VERSION_CONFLICT.
// Pure Node >= 22 (node:sqlite для подготовки фактов матрицы), без зависимостей.
// Итоговая строка в формате остальных JS-сьютов: «RESULT: N passed, M failed».
'use strict';

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js/tasks.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const REAL_DB = path.join(ROOT, 'data/app.db');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 300) : '')); }
}
const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

// ----------------------------------------------------------------------------
// DOM-шим
// ----------------------------------------------------------------------------
function makeEl(id) {
  const el = {
    id, style: {}, dataset: {}, innerHTML: '', textContent: '', listeners: {},
    _cls: new Set(),
    parentNode: null,
    className: '',
    classList: null,
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    focus() {},
    fire(type, ev) { (this.listeners[type] || []).forEach((fn) => fn(ev)); },
    click() { this.fire('click', { target: this, preventDefault() {} }); },
    closest() { return this; },
  };
  el.classList = {
    add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
    contains: (c) => el._cls.has(c),
    toggle: (c, f) => { (f === undefined ? !el._cls.has(c) : f) ? el._cls.add(c) : el._cls.delete(c); },
  };
  return el;
}

function makeEnv(base, cookie) {
  const els = {};
  ['tasksView', 'tabTasks', 'tabMatrix', 'tabTrips', 'matrixWrapper', 'tripsListView', 'vacationPanel', 'vacationTrigger']
    .forEach((id) => { els[id] = makeEl(id); });
  els.tasksView.style.display = 'none';
  els.tabMatrix._cls.add('active');
  els.vacationTrigger.addEventListener('click', () => els.vacationPanel._cls.add('open'));

  const calls = [];            // все HTTP-вызовы модуля
  let inflight = 0;
  const toasts = [];
  const events = [];           // document.dispatchEvent (tasks:changed)
  const body = makeEl('body');
  body.children = [];
  body.appendChild = function (el) { this.children.push(el); el.parentNode = this; };
  body.removeChild = function (el) { this.children = this.children.filter((c) => c !== el); el.parentNode = null; };
  const confirms = { answer: true, asked: [] };
  const win = {};
  const sandbox = {
    window: win, console, setTimeout, clearTimeout, Promise, JSON, Date, Math, String, Number, Array, Object, RegExp, Error, encodeURIComponent,
    CustomEvent: class { constructor(type) { this.type = type; } },
    document: {
      readyState: 'complete',
      head: makeEl('head'),
      body,
      getElementById: (id) => els[id] || null,
      createElement: (t) => makeEl(t),
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent(ev) { events.push(ev.type); return true; },
    },
    fetch: (url, opt) => {
      opt = opt || {};
      calls.push({ method: opt.method || 'GET', url, body: opt.body ? JSON.parse(opt.body) : null });
      inflight++;
      const headers = Object.assign({}, opt.headers || {}, cookie ? { Cookie: cookie } : {});
      return fetch(base + '/' + url, { method: opt.method || 'GET', headers, body: opt.body })
        .then((r) => {
          // inflight снимается, когда тело ответа ПРОЧИТАНО (а не когда пришли заголовки): php -S отдаёт
          // тело после shutdown-фазы PHP, под нагрузкой хоста это занимает сотни мс — иначе settle() ложно срабатывает.
          const readText = r.text.bind(r);
          r.text = () => readText().finally(() => { inflight--; });
          return r;
        }, (e) => { inflight--; throw e; });
    },
  };
  win.window = win;
  win.showToast = (text, type) => toasts.push({ text, type });
  win.confirm = (q) => { confirms.asked.push(q); return confirms.answer; };
  Object.assign(win, sandbox);
  sandbox.window = win;
  vm.createContext(sandbox);
  // window === глобал песочницы
  sandbox.window = sandbox;
  sandbox.showToast = win.showToast;
  sandbox.confirm = win.confirm;
  vm.runInContext(SRC, sandbox, { filename: 'js/tasks.js' });

  const root = els.tasksView;
  const T = sandbox.Tasks;

  async function settle() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 12));
      if (inflight === 0) {
        await new Promise((r) => setTimeout(r, 25));
        if (inflight === 0) return;
      }
    }
    throw new Error('settle: запросы не завершились за 20 с');
  }
  const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  function parseTag(tag) {
    const ds = {}, attrs = {};
    const re = /([\w:-]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(tag)) !== null) {
      attrs[m[1]] = unesc(m[2]);
      if (m[1].indexOf('data-') === 0) {
        ds[m[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = unesc(m[2]);
      }
    }
    return { dataset: ds, attrs, checked: /\schecked[\s>]/.test(tag) };
  }
  function findTag(attr, val, pred, html) {
    const re = new RegExp('<[a-zA-Z]+\\b[^>]*\\b' + attr + '="' + val + '"[^>]*>', 'g');
    html = html === undefined ? root.innerHTML : html;
    let m;
    while ((m = re.exec(html)) !== null) {
      const t = parseTag(m[0]);
      if (!pred || pred(t.dataset, t)) return t;
    }
    return null;
  }
  const has = (needle) => root.innerHTML.indexOf(needle) >= 0;
  const count = (needle) => root.innerHTML.split(needle).length - 1;
  async function click(act, pred) {
    const t = findTag('data-tk-act', act, pred);
    if (!t) throw new Error('кнопка data-tk-act="' + act + '" не отрендерена');
    root.fire('click', { target: { closest: () => ({ dataset: t.dataset }) }, preventDefault() {} });
    await settle();
  }
  async function change(attr, val, value, extra) {
    const t = findTag(attr, val);
    if (!t) throw new Error('поле ' + attr + '="' + val + '" не отрендерено');
    root.fire('change', { target: Object.assign({ dataset: t.dataset, value, type: t.attrs.type || 'text', checked: !!(extra && extra.checked) }, extra || {}) });
    await settle();
  }
  // V6.2 (W-4): клавиатура/ввод в поле-тегах (keydown/input на корне, как в браузере)
  async function key(name, k, value, extra) {
    const t = findTag('data-tk-field', name);
    if (!t) throw new Error('поле data-tk-field=\"' + name + '\" не отрендерено');
    const ev = Object.assign({ target: { dataset: t.dataset, value, type: 'text' }, key: k, prevented: false, preventDefault() { this.prevented = true; } }, extra || {});
    root.fire('keydown', ev);
    await settle();
    return ev;
  }
  async function input(name, value, extra) {
    const t = findTag('data-tk-field', name);
    if (!t) throw new Error('поле data-tk-field=\"' + name + '\" не отрендерено');
    root.fire('input', Object.assign({ target: { dataset: t.dataset, value, type: 'text' } }, extra || {}));
    await settle();
  }
  const field = (name, value) => change('data-tk-field', name, value);
  const filter = (name, value, extra) => change('data-tk-filter', name, value, extra);
  // T1-8: окно замены (элемент #tasksReassignModal в document.body)
  const modalEl = () => body.children.find((c) => c.id === 'tasksReassignModal') || null;
  const mhtml = () => (modalEl() ? modalEl().innerHTML : '');
  const mhas = (needle) => mhtml().indexOf(needle) >= 0;
  const mcount = (needle) => mhtml().split(needle).length - 1;
  async function mclick(act, pred) {
    const t = findTag('data-tk-act', act, pred, mhtml());
    if (!t) throw new Error('кнопка окна data-tk-act="' + act + '" не отрендерена');
    modalEl().fire('click', { target: { closest: () => ({ dataset: t.dataset }) }, preventDefault() {} });
    await settle();
  }
  async function mchange(attr, val, value, extra) {
    const t = findTag(attr, val, null, mhtml());
    if (!t) throw new Error('поле окна ' + attr + '="' + val + '" не отрендерено');
    modalEl().fire('change', { target: Object.assign({ dataset: t.dataset, value, type: t.attrs.type || 'text', checked: !!(extra && extra.checked) }, extra || {}) });
    await settle();
  }
  return { sandbox, els, root, T, S: T.__t.S, calls, toasts, confirms, settle, click, change, field, key, input, filter, has, count, findTag,
    body, events, modalEl, mhtml, mhas, mcount, mclick, mchange };
}

// ----------------------------------------------------------------------------
// сервер + HTTP-хелперы
// ----------------------------------------------------------------------------
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
async function login(base, user) {
  const r = await fetch(base + '/api/login.php', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: 'changeme' }),
  });
  if (r.status !== 200) throw new Error('login ' + user + ' → ' + r.status);
  const set = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
  return set.filter(Boolean).map((c) => c.split(';')[0]).join('; ');
}
async function http(base, cookie, method, url, body) {
  const r = await fetch(base + '/' + url, {
    method, headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* не JSON */ }
  return { status: r.status, json: j || {} };
}

// ----------------------------------------------------------------------------
function unescTitle(x) { return x.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }

async function main() {
  console.log('=== T1-2 TASKS PANEL FRONTEND TEST ===');

  // ---- 1. статические проверки ------------------------------------------------
  console.log('-- static');
  const probe = makeEnv('http://127.0.0.1:1', '');
  const ACTIONS = probe.T.__t.ACTIONS;
  const acts = Array.from(new Set((SRC.match(/data-tk-act="(\w+)"/g) || []).map((s) => s.slice(13, -1))));
  const dead = acts.filter((a) => typeof ACTIONS[a] !== 'function');
  check('S1 каждая кнопка data-tk-act (' + acts.length + ') имеет обработчик в ACTIONS', acts.length > 10 && dead.length === 0, dead.join(','));
  check('S2 нет inline-обработчиков (onclick/onchange/onsubmit…) в js/tasks.js', !/\son(click|change|submit|input|drop|dragstart)\s*=/i.test(SRC));
  check('S3 index.html: вкладка #tabTasks, контейнер #tasksView, скрипт js/tasks.js — по одному разу, скрипт после trips.js',
    (INDEX.match(/id="tabTasks"/g) || []).length === 1 && (INDEX.match(/id="tasksView"/g) || []).length === 1 &&
    (INDEX.match(/<script src="js\/tasks\.js"><\/script>/g) || []).length === 1 &&
    INDEX.indexOf('js/trips.js') < INDEX.indexOf('js/tasks.js'));
  const exportsApi = Object.keys(probe.T);
  const refs = Array.from(new Set((INDEX.match(/\bTasks\.(\w+)/g) || []).map((s) => s.slice(6))));
  check('S4 все обращения Tasks.* из index.html существуют (' + (refs.join(',') || 'нет обращений') + ')', refs.every((r) => exportsApi.indexOf(r) >= 0));
  check('S5 экспорт window.Tasks.open и window.openTasksPanel (вход для T1-3)',
    typeof probe.T.open === 'function' && vm.runInContext('typeof window.openTasksPanel', probe.sandbox) === 'function');
  let syntaxOk = true, syntaxMsg = '';
  const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let sm, n = 0;
  while ((sm = scriptRe.exec(INDEX)) !== null) {
    n++;
    try { new vm.Script(sm[1], { filename: 'inline-' + n + '.js' }); } catch (e) { syntaxOk = false; syntaxMsg = e.message; }
  }
  check('S6 inline-<script> index.html (' + n + ') проходят проверку синтаксиса', syntaxOk && n > 0, syntaxMsg);
  const chk = cp.spawnSync(process.execPath, ['--check', path.join(ROOT, 'js/tasks.js')]);
  check('S7 node --check js/tasks.js', chk.status === 0, String(chk.stderr));
  // T1-8: точечная правка #deleteEmp в index.html вызывает экспортированные Tasks.openTasksFor / Tasks.offerReassign
  const delStart = INDEX.indexOf("document.getElementById('deleteEmp').addEventListener('click'");
  const delEnd = INDEX.indexOf("document.getElementById('cloneEmp')", delStart);
  const delSrc = delStart >= 0 && delEnd > delStart ? INDEX.slice(delStart, delEnd) : '';
  check('S8 index.html #deleteEmp: вызывает Tasks.openTasksFor (до confirm) и Tasks.offerReassign (после save), оба экспортированы',
    /Tasks\.openTasksFor\(/.test(delSrc) && /Tasks\.offerReassign\(/.test(delSrc) &&
    delSrc.indexOf('openTasksFor') < delSrc.indexOf('confirm(') && delSrc.indexOf('await save()') < delSrc.indexOf('offerReassign') &&
    typeof probe.T.openTasksFor === 'function' && typeof probe.T.offerReassign === 'function');
  // T1-11 (P3-4): poll() вызывает Tasks.onRemoteChange только после применённой дельты и только если функция экспортирована
  const pollStart = INDEX.indexOf('if (changed) {\n            renderVacationMatrix();');
  const pollSeg = pollStart >= 0 ? INDEX.slice(pollStart, pollStart + 1100) : '';
  check('S10 index.html poll(): после применения дельты (changed или employeesDeleted) — guarded вызов Tasks.onRemoteChange (внутри try, до .catch); метод экспортирован',
    /if \(\(changed \|\| \(d\.employeesDeleted && d\.employeesDeleted\.length\)\) && window\.Tasks && typeof window\.Tasks\.onRemoteChange === 'function'\)/.test(pollSeg) &&
    pollSeg.indexOf('renderVacationMatrix()') < pollSeg.indexOf('onRemoteChange') && pollSeg.indexOf('onRemoteChange') < pollSeg.indexOf('.catch(') &&
    (INDEX.match(/Tasks\.onRemoteChange\(/g) || []).length === 1 && typeof probe.T.onRemoteChange === 'function', pollSeg.slice(0, 200));
  const modalActs = ['assignOrphan', 'mAssign', 'mAccept', 'mLater'];
  check('S9 новые data-tk-act (' + modalActs.join(',') + ') есть в исходнике и имеют обработчики в ACTIONS',
    modalActs.every((a) => SRC.indexOf('data-tk-act="' + a + '"') >= 0 && typeof ACTIONS[a] === 'function'));

  // ---- 1b. обработчик #deleteEmp (код из index.html, исполняется в vm с заглушками) ---------
  console.log('-- deleteEmp (код обработчика из index.html)');
  const DEL_ORIG = 'Удалить сотрудника безвозвратно? Все данные отпусков будут потеряны.';
  async function runDelete(o, twice) {
    const handlers = {};
    const log = { confirms: [], offered: [], saves: 0, refreshed: 0 };
    const letIdx = INDEX.lastIndexOf('let deleteEmpBusy', delStart);
    const ctx = {
      document: { getElementById: (id) => ({ addEventListener: (t, fn) => { handlers[id] = fn; }, classList: { remove() {} } }) },
      confirm: (q) => { log.confirms.push(q); return o.confirm !== false; },
      currentId: 7,
      employees: [{ id: 7, name: 'Иванов И.И.' }, { id: 8, name: 'Другой' }],
      vacationData: { 2026: { 7: [1], 8: [2] } },
      editor: { classList: { remove() {} } },
      render() {}, renderVacationMatrix() {},
      save: async () => { log.saves++; return o.save || { success: true }; },
      window: { Tasks: {
        openTasksFor: async () => { if (o.throws) throw new Error('boom'); return o.info; },
        offerReassign: (id, name, tasks) => { log.offered.push([id, name, tasks]); },
        refreshOrphans: () => { log.refreshed++; },
      } },
    };
    vm.createContext(ctx);
    vm.runInContext(INDEX.slice(letIdx, delEnd), ctx);
    const p1 = handlers.deleteEmp();
    const p2 = twice ? handlers.deleteEmp() : null;
    await p1; if (p2) await p2;
    log.employees = ctx.employees.map((e) => e.id);
    log.vac = Object.keys(ctx.vacationData[2026]);
    return log;
  }
  const open3 = { ok: true, count: 3, tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  let hr = await runDelete({ info: open3 });
  check('H1 N=3: confirm дополнен «Открытых задач: 3 — останутся без исполнителя.», удаление, окно замены после save() с (id, ФИО, задачи)',
    hr.confirms.length === 1 && hr.confirms[0] === DEL_ORIG + '\n\nОткрытых задач: 3 — останутся без исполнителя.' &&
    hr.saves === 1 && hr.employees.join() === '8' && hr.vac.join() === '8' &&
    hr.offered.length === 1 && hr.offered[0][0] === 7 && hr.offered[0][1] === 'Иванов И.И.' && hr.offered[0][2].length === 3, JSON.stringify(hr));
  hr = await runDelete({ info: { ok: false, count: 0, tasks: [] } });
  check('H2 запрос open_for не удался: исходный текст confirm, удаление НЕ блокируется, окна нет',
    hr.confirms[0] === DEL_ORIG && hr.saves === 1 && hr.employees.join() === '8' && hr.offered.length === 0);
  hr = await runDelete({ throws: true });
  check('H3 openTasksFor бросил исключение: исходный текст confirm, удаление проходит', hr.confirms[0] === DEL_ORIG && hr.saves === 1 && hr.offered.length === 0);
  hr = await runDelete({ info: { ok: true, count: 0, tasks: [] } });
  check('H4 N=0: текст без строки про задачи, окна замены нет', hr.confirms[0] === DEL_ORIG && hr.saves === 1 && hr.offered.length === 0);
  hr = await runDelete({ info: open3, confirm: false });
  check('H5 отказ в confirm: ничего не удалено, save не вызывался, окна нет',
    hr.saves === 0 && hr.employees.join() === '7,8' && hr.vac.join() === '7,8' && hr.offered.length === 0);
  hr = await runDelete({ info: open3, save: { success: false, fallback: true } });
  check('H6 save() не подтвердил удаление на сервере (fallback): окно замены не показывается', hr.saves === 1 && hr.offered.length === 0);
  hr = await runDelete({ info: open3 }, true);
  check('H7 двойной клик не запускает удаление дважды', hr.saves === 1 && hr.confirms.length === 1 && hr.offered.length === 1);

  // ---- 1c. V6-1 R-15: window.openMatrixAt (код из index.html в vm с заглушками DOM) ----
  console.log('-- openMatrixAt (код из index.html)');
  const omStart = INDEX.indexOf('var matrixFlashTimer = null;');
  const omRet = INDEX.indexOf('return { year: year, row: row, cell: cell };', omStart);
  const omEnd = omRet > 0 ? INDEX.indexOf('\n    };', omRet) + 7 : -1;
  async function runOpenMatrix(opts, rowIds, startYear, panelOpen, nameW) {
    const log = { clicks: [], renders: 0, holidays: [], timers: [], styleAdded: 0 };
    const mkSet = () => { const st = new Set(); return { add: (c) => st.add(c), remove: (c) => st.delete(c), contains: (c) => st.has(c), has: (c) => st.has(c) }; };
    const rows = rowIds.map((id, i) => {
      const r = { id, cls: mkSet(), offsetWidth: 5, rectTop: 100 + i * 700, classList: null };
      r.classList = r.cls;
      r.getBoundingClientRect = () => ({ top: r.rectTop, height: 20 });
      r.querySelector = (sel) => { const m = /data-day="(\d+)"/.exec(sel); return m ? { offsetLeft: +m[1] * 20, offsetWidth: 20, rowId: id } : null; };
      return r;
    });
    const sel = [];
    const matrixBody = {
      querySelector: (q) => {
        sel.push(q);
        let m = /^\.name-col\[data-emp-id="([\w-]+)"\]$/.exec(q);
        if (q === '.name-col') return { offsetWidth: nameW || 0 };
        if (m) { const r = rows.find((x) => String(x.id) === m[1]); return r ? { closest: () => r, offsetWidth: nameW || 0 } : null; }
        m = /data-day="(\d+)"/.exec(q);
        return m ? { offsetLeft: +m[1] * 20, offsetWidth: 20, rowId: 'any' } : null;
      },
      querySelectorAll: (q) => (q === 'tr.mx-flash' ? rows.filter((r) => r.cls.has('mx-flash')) : []),
    };
    const matrixWrapper = { style: {}, scrollLeft: 0, scrollTop: 0, clientWidth: 1000, clientHeight: 400, getBoundingClientRect: () => ({ top: 100 }) };
    const ctx = {
      window: {}, vacationPanel: { classList: mkSet() }, vacationTrigger: { click: () => { log.clicks.push('trigger'); } },
      matrixBody, matrixWrapper,
      document: {
        getElementById: (id) => (id === 'tabMatrix' ? { click: () => log.clicks.push('tabMatrix') } : null),
        createElement: () => ({}), head: { appendChild: () => { log.styleAdded++; } },
      },
      HolidaysCalendar: { load: async (y) => { log.holidays.push(y); } },
      renderVacationMatrix: () => { log.renders++; },
      setTimeout: (fn, ms) => { log.timers.push({ fn, ms }); return log.timers.length; }, clearTimeout: () => {},
      Date, Math, parseInt, String, RegExp,
    };
    if (panelOpen) ctx.vacationPanel.classList.add('open');
    vm.createContext(ctx);
    vm.runInContext('var currentYear = ' + startYear + ';\n' + INDEX.slice(omStart, omEnd), ctx);
    const res = await ctx.window.openMatrixAt(opts);
    log.res = res; log.rows = rows; log.matrixWrapper = matrixWrapper; log.sel = sel; log.year = vm.runInContext('currentYear', ctx);
    return log;
  }
  check('OM0 index.html: код openMatrixAt найден для разбора', omStart > 0 && omEnd > omStart);
  if (omStart > 0 && omEnd > omStart) {
    let om = await runOpenMatrix({ employeeId: 'emp_5', date: '2099-12-03' }, [9, 5, 7], 2026, false);
    check('OM1 R-15 openMatrixAt: открывает панель отпусков (если закрыта) и вкладку «Матрица»; год даты 2099 → перерисовка + загрузка календаря',
      om.clicks.join() === 'trigger,tabMatrix' && om.year === 2099 && om.renders === 2 && om.holidays.join() === '2099' && om.matrixWrapper.style.display === 'block', JSON.stringify([om.clicks, om.year, om.renders]));
    check('OM2 R-15 строка найдена по id сотрудника (при перемешанном порядке строк), прокрутка по горизонтали к дате (337-й день, по центру), вертикаль — к строке',
      om.res.row && om.res.row.id === 5 && om.matrixWrapper.scrollLeft === 337 * 20 - (1000 - 20) / 2 && om.matrixWrapper.scrollTop > 0 &&
      om.sel.some((q) => q === '.name-col[data-emp-id="5"]'), JSON.stringify([om.res.row && om.res.row.id, om.matrixWrapper.scrollLeft, om.matrixWrapper.scrollTop]));
    const flashed = om.rows.filter((r) => r.cls.has('mx-flash')).map((r) => r.id);
    check('OM3 R-15 строка подсвечена (mx-flash) только у нужного сотрудника; через ~2 с подсветка снимается', flashed.join() === '5' && om.timers.length === 1 && om.timers[0].ms >= 2000 && om.timers[0].ms <= 2500 &&
      (om.timers[0].fn(), om.rows.every((r) => !r.cls.has('mx-flash'))));
    om = await runOpenMatrix({ employeeId: 'emp_5', date: '2099-12-03' }, [9, 5, 7], 2099, true, 200);
    check('OM3b R-15 закреплённая колонка ФИО (200 px) не закрывает дату: центр дат считается в области справа от неё',
      om.matrixWrapper.scrollLeft === 337 * 20 + 10 - 200 - (1000 - 200) / 2, om.matrixWrapper.scrollLeft);
    om = await runOpenMatrix({ employeeId: 7, date: '2026-03-01' }, [9, 5, 7], 2026, true);
    check('OM4 R-15 тот же год: без перерисовки; панель уже открыта (триггер не нажимается); employeeId числом (7) находит строку; 1 марта 2026 = 60-й день',
      om.clicks.join() === 'tabMatrix' && om.renders === 0 && om.res.row && om.res.row.id === 7 && om.matrixWrapper.scrollLeft === 60 * 20 - 490);
    om = await runOpenMatrix({ employeeId: 'no_such', date: '2026-01-01' }, [9, 5], 2026, true);
    check('OM5 R-15 сотрудник не в матрице → без исключения и без подсветки; к дате всё равно прокручено', om.res.row === null && om.rows.every((r) => !r.cls.has('mx-flash')) && om.matrixWrapper.scrollLeft === Math.max(0, 20 - 490) + 0);
    om = await runOpenMatrix({ employeeId: '5"] x[a="', date: '2026-02-01' }, [5], 2026, true);
    check('OM6 R-15 id с кавычками/скобками не попадает в селектор (защита от инъекции), исключения нет', om.res.row === null && !om.sel.some((q) => /x\[a=/.test(q)));
    om = await runOpenMatrix({ employeeId: 'emp_5', date: 'мусор' }, [5], 2026, true);
    check('OM7 R-15 некорректная дата: год не меняется, строка подсвечивается, без исключения', om.year === 2026 && om.res.row && om.res.row.id === 5 && om.res.cell === null);
  }

  // ---- 2. чистые функции ------------------------------------------------------
  console.log('-- unit');
  const U = probe.T.__t;
  check('U1 truncate: длинный текст режется с «…», короткий не меняется',
    U.truncate('a'.repeat(100), 10).length === 10 && U.truncate('a'.repeat(100), 10).slice(-1) === '…' && U.truncate('коротко', 10) === 'коротко');
  check('U2 weekStart: понедельник недели (2099-03-04 → 2099-03-02 или соотв. Пн)',
    new Date(U.weekStart('2026-11-07') + 'T00:00:00Z').getUTCDay() === 1 && U.weekStart('2026-11-07') === '2026-11-02' && U.weekStart('2026-11-08') === '2026-11-02');
  check('U3 normEmpId: 2 → emp_2, emp_5 остаётся', U.normEmpId(2) === 'emp_2' && U.normEmpId('emp_5') === 'emp_5' && U.normEmpId('') === '');
  check('U4 esc экранирует HTML', U.esc('<b onclick="x">&\'') === '&lt;b onclick=&quot;x&quot;&gt;&amp;&#39;');
  check('U5 plural: 1 открытая задача, 2–4 открытые задачи, 5/11/12 открытых задач, 21 открытая задача',
    [1, 2, 4, 5, 11, 12, 21, 22].map((k) => U.plural(k, 'a', 'b', 'c')).join('') === 'abbcccab');
  const gone = (o) => Object.assign({ employee_id: 'x', full_name: 'Иванов И.И.', removed: true, removed_at: null }, o || {});
  const live = { employee_id: 'y', full_name: 'Петров П.П.', removed: false, removed_at: null };
  check('U6 isOrphan: только открытая неархивная с orphan:true; закрытая/архивная/смешанная — нет',
    U.isOrphan({ orphan: true, status: 'open', assignees: [gone()] }) === true &&
    U.isOrphan({ orphan: true, status: 'closed', assignees: [gone()] }) === false &&
    U.isOrphan({ orphan: true, status: 'open', archived: 1, assignees: [gone()] }) === false &&
    U.isOrphan({ orphan: false, status: 'open', assignees: [gone(), live] }) === false);
  check('U7 removedDate: null/мусор → пусто (никогда «null»/«Invalid Date»), ISO → дд.мм.гггг, берётся самая поздняя',
    U.removedDate({ assignees: [gone()] }) === '' && U.removedDate({ assignees: [gone({ removed_at: 'не дата' })] }) === '' &&
    /^\d{2}\.\d{2}\.\d{4}$/.test(U.removedDate({ assignees: [gone({ removed_at: '2026-11-11T13:00:00+00:00' })] })) &&
    U.removedDate({ assignees: [gone({ removed_at: '2026-11-11T13:00:00+00:00' }), gone({ employee_id: 'z', removed_at: '2026-11-12T13:00:00+00:00' })] }).slice(0, 2) === '12');

  // ---- 3. сервер на копии БД --------------------------------------------------
  console.log('-- e2e (php -S на копии БД)');
  const hashBefore = sha1(REAL_DB);
  const tmpDb = path.join(os.tmpdir(), 'sc_tasks_ui_' + process.pid + '.db');
  fs.copyFileSync(REAL_DB, tmpDb);
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, { SC_APP_DB: tmpDb });
  delete env.TASKS_VALIDATE_WEBHOOK_URL;
  const srv = cp.spawn('php', ['-S', '127.0.0.1:' + port, '-t', ROOT], { env, cwd: ROOT, stdio: 'ignore' });
  let ready = false, lastErr = '';
  for (let i = 0; i < 60 && !ready; i++) {
    try { const r = await fetch(base + '/api/session.php'); ready = r.status < 500; lastErr = 'status ' + r.status; } catch (e) { lastErr = String(e); }
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) { srv.kill(); check('E0 php -S поднялся', false, lastErr); return finish(srv, tmpDb, hashBefore); }

  const { DatabaseSync } = require('node:sqlite');
  const sdb = () => new DatabaseSync(tmpDb);
  try {
    const adminCk = await login(base, 'admin');
    const supCk = await login(base, 'supervisor_zone0');
    const viewCk = await login(base, 'viewer_test');

    // ---------- admin ----------
    const A = makeEnv(base, adminCk);
    A.els.tabTasks.click();
    await A.settle();
    check('E1 вкладка «Задачи»: панель показана, матрица/командировки скрыты, вид по умолчанию «Список»',
      A.root.style.display === 'block' && A.els.matrixWrapper.style.display === 'none' && A.els.tripsListView.style.display === 'none' &&
      A.els.tabTasks._cls.has('active') && !A.els.tabMatrix._cls.has('active') &&
      A.S.view === 'list' && A.has('class="tk-sw active" data-tk-act="setView" data-view="list"'));
    check('E2 admin: сотрудники загружены, есть «+ Новая задача»', A.S.employees.length >= 3 && A.has('data-tk-act="newTask"'), A.S.employees.length);
    const emps = A.S.employees;
    const e1 = emps[1].id, e2 = emps[2].id, e3 = emps[3].id;

    // создать
    await A.click('newTask');
    check('E3 форма создания: поля название/описание/исполнители/срок/приоритет/метка/чек-лист, «наблюдатель» неактивен',
      ['title', 'description', 'assigneePick', 'kind', 'startDate', 'startTime', 'priority', 'labelInput'].every((f) => A.findTag('data-tk-field', f)) &&
      A.has('data-tk-act="addCheck"') && A.has('data-tk-act="saveForm"') && /Наблюдатель<\/label><select disabled/.test(A.root.innerHTML));
    await A.click('saveForm');
    check('E4 пустое название → понятная ошибка, запрос не отправлен', A.has('Укажите название задачи') && !A.calls.some((c) => c.method === 'POST'));
    // найти субботу в 2099 для проверки пометок «выходной»
    let sat = '2099-03-07';
    while (new Date(sat + 'T00:00:00Z').getUTCDay() !== 6) sat = U.addDays(sat, 1);
    const fri = U.addDays(sat, -1), sun = U.addDays(sat, 1), mon = U.addDays(sat, 2);
    const longDesc = 'Подготовить подробный отчёт по итогам квартала и согласовать его со всеми руководителями групп до конца периода';
    await A.field('title', 'E2E задача');
    await A.field('description', longDesc);
    await A.field('assigneePick', e1);
    await A.field('assigneePick', e2);
    await A.field('kind', 'period');
    await A.field('startDate', fri);
    await A.field('startTime', '09:00');
    await A.field('endDate', mon);
    await A.field('endTime', '18:00');
    await A.field('priority', '1');
    await A.field('labelInput', 'e2e');           // V6.2: введённый, но не превращённый в чип текст сохраняется как тег
    await A.click('addCheck');
    await A.click('addCheck');
    await A.change('data-tk-ck-text', '0', 'Шаг один');
    await A.change('data-tk-ck-text', '1', 'Шаг два');
    await A.change('data-tk-ck-done', '1', '', { checked: true });
    check('E5 в форме выбрано 2 исполнителя, 2 пункта чек-листа', A.S.form.draft.assignees.length === 2 && A.S.form.draft.checklist.length === 2 && A.count('class="tk-chip"') === 2);
    await A.click('saveForm');
    check('E6 создание: POST ушёл, форма закрыта, тост «Задача создана», задача в списке',
      A.calls.some((c) => c.method === 'POST' && c.url === 'api/tasks.php' && c.body.title === 'E2E задача' && c.body.priority === 1 && c.body.assignees.length === 2) &&
      A.S.form === null && A.toasts.some((t) => t.text === 'Задача создана') && A.has('E2E задача') && A.S.tasks.length === 1,
      JSON.stringify(A.S.form && A.S.form.error));
    const tid = A.S.tasks[0].id;
    const srvTask = (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + tid)).json.task;
    check('E7 на сервере: исполнители 2, период Пт 09:00 — Пн 18:00, чек-лист 2 (1 выполнен), приоритет 1, метка',
      srvTask && srvTask.assignees.length === 2 && srvTask.start_at === fri + 'T09:00' && srvTask.end_at === mon + 'T18:00' &&
      srvTask.checklist.length === 2 && srvTask.checklist[1].done === true && srvTask.priority === 1 && srvTask.label === 'e2e');
    check('E8 список: колонки Задача/Описание/Исполнитель/Срок + сортируемые Приор./Статус, приоритет «высокий» выделен, ФИО — ссылки',
      ['Задача', 'Описание', 'Исполнитель', 'Срок'].every((c) => A.has('>' + c + '</th>')) &&
      A.has('data-tk-act="sortBy" data-key="priority"') && A.has('data-tk-act="sortBy" data-key="status"') && A.has('tk-hi') && A.count('data-tk-act="filterEmp"') === 2);
    // фильтры списка
    await A.filter('priority', '3');
    check('E9 фильтр «приоритет = низкий» скрывает задачу, «Сбросить» возвращает', !A.has('E2E задача') && (await A.click('resetFilters'), A.has('E2E задача')));
    await A.filter('emp', e3);
    check('E10 фильтр по сотруднику, не назначенному на задачу, → пусто', !A.has('E2E задача'));
    await A.click('resetFilters');
    await A.filter('status', 'closed');
    check('E11 фильтр «статус = закрыта» скрывает открытую задачу', !A.has('E2E задача'));
    await A.click('resetFilters');
    await A.filter('label', 'e2e');
    check('E12 фильтр по метке находит задачу', A.has('E2E задача'));
    await A.click('resetFilters');

    // клик по фамилии → «Список» по сотруднику (V6-1 R-14; раньше вёл на Доску)
    await A.click('filterEmp', (d) => d.emp === e1);
    check('E13 клик по фамилии → «Список», отфильтрован по сотруднику, остальные фильтры пусты (R-14)',
      A.S.view === 'list' && A.S.filters.emp === e1 && !A.S.filters.priority && !A.S.filters.label && !A.S.filters.status && !A.S.filters.due && A.has('E2E задача') && A.has('class="tk-table tk-table-v62"'));
    await A.filter('emp', e3);
    check('E14 список по другому сотруднику: задачи нет', !A.has('E2E задача'));
    await A.click('resetFilters');
    await A.click('setView', (d) => d.view === 'board');
    check('E15 карточка на доске draggable только для admin', A.has('draggable="true"') && A.has('data-tk-drag="' + tid + '"'));
    await A.click('setView', (d) => d.view === 'list');

    // клик по задаче в списке → доска с выделенной карточкой
    await A.click('setView', (d) => d.view === 'list');
    await A.click('openTask', (d) => d.id === tid);
    check('E16 клик по задаче в списке → «Доска» с выделенной карточкой и карточкой справа',
      A.S.view === 'board' && A.S.selectedId === tid && A.has('tk-card tk-sel') && A.has('class="tk-detail"') && A.has('Шаг один') && A.has('data-tk-act="editTask"') && A.has('data-tk-act="closeTask"'));
    check('E17 нейтральные пометки: выходной показан справочно, без «конфликта» и предупреждений',
      A.has('выходной') && !A.has('tk-box-warn') && !A.has('конфликт'));

    // календарь
    await A.click('setView', (d) => d.view === 'calendar');
    check('E18 переключатель → «Календарь»: запрошен диапазон недели, плитки показаны',
      A.S.view === 'calendar' && A.calls.some((c) => /api\/tasks\.php\?from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d$/.test(c.url)));
    await A.T.open({ employeeId: Number(e1.replace(/\D/g, '')), date: sat, view: 'calendar' });
    await A.settle();
    const tiles = A.count('class="tk-ev');
    check('E19 openTasksPanel({employeeId, date, view:"calendar"}): неделя с этим днём, плитки сотрудника подсвечены',
      A.S.view === 'calendar' && A.S.cal.anchor === sat && A.S.cal.emp === e1 && tiles >= 3 && A.has('tk-hl') && A.els.vacationPanel._cls.has('open'), 'tiles=' + tiles);
    // V6-2 (R-6): плитка = время + тема; ФИО и описание из плитки убраны, исполнители — в подсказке (title)
    const evTile = (A.root.innerHTML.split('<div class="tk-ev ').filter((r) => r.indexOf('data-id="' + tid + '"') >= 0)[0] || '');
    const evVisible = evTile.slice(0, evTile.indexOf('</div>')).replace(/ title="[^"]*"/g, '');
    check('E20 плитка = время + тема (жирно); ФИО и описание не показываются, исполнитель — в подсказке (title)',
      evVisible.indexOf('<b class="tk-ev-title">E2E задача</b>') >= 0 && evVisible.indexOf(A.S.employees.find((e) => e.id === e1).name) < 0 &&
      evVisible.indexOf('Подготовить') < 0 && evTile.indexOf('Исполнители: ' + A.S.employees.find((e) => e.id === e1).name) >= 0, evTile.slice(0, 300));
    await A.filter('calOnly', '', { checked: true });
    check('E21 «только выбранный» оставляет плитки сотрудника; снятие возвращает всех',
      A.S.cal.only === true && A.count('class="tk-ev') >= 1);
    await A.filter('calEmp', '');
    check('E22 «Все сотрудники» сбрасывает подсветку и фильтр', A.S.cal.emp === '' && A.S.cal.only === false && !A.has('tk-hl'));
    await A.click('openTask', (d) => d.id === tid && !d.view);
    check('E23 клик по плитке → карточка справа (описание, чек-лист, исполнители)',
      A.S.view === 'calendar' && A.S.selectedId === tid && A.has('Подготовить подробный отчёт') && A.has('Шаг два') && A.has('class="tk-detail"') && A.has('tk-ev tk-sel'));
    await A.click('calMode', (d) => d.mode === 'day');
    check('E24 режим «День»: одна колонка', A.S.cal.mode === 'day' && A.count('class="tk-wk-h') === 1);
    await A.click('calNext');
    check('E25 «▶» в режиме дня: +1 день', A.S.cal.anchor === U.addDays(sat, 1));
    await A.click('calMode', (d) => d.mode === 'week');
    await A.click('calToday');
    check('E26 «Сегодня» возвращает текущую неделю (плиток нет — задача в 2099)', A.S.cal.anchor && A.count('class="tk-ev') === 0 && A.has('На этот период задач нет'));
    await A.T.open({ employeeId: e1, date: sat, view: 'calendar', taskId: tid });
    await A.settle();

    // закрыть / переоткрыть
    await A.click('closeTask', (d) => d.id === tid);
    const closedSrv = (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + tid)).json.task;
    check('E27 «Закрыть» → статус closed на сервере, тост, плитка приглушена',
      closedSrv.status === 'closed' && A.toasts.some((t) => t.text === 'Задача закрыта') && A.has('data-tk-act="reopenTask"') && A.has('tk-dim'));
    await A.click('setView', (d) => d.view === 'board');
    check('E28 доска: Открыта · 0 / Закрыта · 1', A.has('Открыта · 0') && A.has('Закрыта · 1'));
    await A.click('reopenTask', (d) => d.id === tid);
    check('E29 «Переоткрыть» → open', (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + tid)).json.task.status === 'open' && A.has('Открыта · 1'));
    // drag&drop
    const colEl = (c) => ({ closest: () => ({ dataset: { tkCol: c } }) });
    A.root.fire('dragstart', { target: { closest: () => ({ dataset: { tkDrag: tid } }) }, dataTransfer: { setData() {} } });
    A.root.fire('drop', { target: colEl('closed'), preventDefault() {} });
    await A.settle();
    check('E30 перетаскивание карточки в «Закрыта» закрывает задачу (admin)', (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + tid)).json.task.status === 'closed');
    A.root.fire('dragstart', { target: { closest: () => ({ dataset: { tkDrag: tid } }) }, dataTransfer: { setData() {} } });
    A.root.fire('drop', { target: colEl('open'), preventDefault() {} });
    await A.settle();
    check('E31 перетаскивание обратно в «Открыта» переоткрывает', (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + tid)).json.task.status === 'open');

    // правка + переназначение
    check('E32a R-1: кнопки «Переназначить» и действия reassignTask больше нет (ни в карточке, ни в ACTIONS)',
      !A.has('reassignTask') && !A.has('Переназначить') && A.has('data-tk-act="editTask"') && typeof A.T.__t.ACTIONS.reassignTask === 'undefined' && !/reassignTask/.test(SRC));
    await A.click('editTask', (d) => d.id === tid);
    check('E32 «Править» открывает форму с текущими исполнителями (замена исполнителей — через неё)', A.S.form && A.S.form.id === tid && A.S.form.draft.assignees.length === 2 && A.has('Редактирование задачи'));
    await A.click('removeAssignee', (d) => d.emp === e2);
    await A.field('title', 'E2E задача (правка)');
    await A.click('saveForm');
    const edited = (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + tid)).json.task;
    check('E33 правка/переназначение сохранены (1 исполнитель, новое название, version 2+)',
      edited.title === 'E2E задача (правка)' && edited.assignees.length === 1 && edited.assignees[0].employee_id === e1 && edited.version >= 2);

    // 409
    await A.click('setView', (d) => d.view === 'list');
    await A.click('openTask', (d) => d.id === tid);
    await A.click('editTask', (d) => d.id === tid);
    const other = await http(base, adminCk, 'PUT', 'api/tasks.php?id=' + tid, { version: edited.version, title: 'Правка из другой вкладки' });
    await A.field('title', 'Моя устаревшая правка');
    await A.click('saveForm');
    const afterConflict = (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + tid)).json.task;
    check('E34 409 VERSION_CONFLICT: данные другой вкладки не затёрты, показано понятное сообщение, карточка перезагружена',
      other.status === 200 && afterConflict.title === 'Правка из другой вкладки' && A.S.form === null &&
      A.has('изменена другим пользователем') && A.has('Правка из другой вкладки') && A.S.selectedId === tid && A.S.view === 'board',
      A.S.msg && A.S.msg.text);

    // 422 + принять предложенную дату
    const sdb1 = sdb();
    const blockDay = '2099-06-10';
    sdb1.prepare("INSERT OR REPLACE INTO schedule_entries (employee_id, date, status, comment, approval_status, updated_at, version) VALUES (?, ?, 'sick', NULL, 'draft', '2099-01-01', 1)").run(e3, blockDay);
    sdb1.close();
    await A.click('newTask');
    await A.field('title', 'Задача на больничный');
    await A.field('assigneePick', e3);
    await A.field('kind', 'period');
    await A.field('startDate', '2099-06-09');
    await A.field('endDate', '2099-06-11');
    await A.click('saveForm');
    check('E35 422 TASK_BLOCKED_BY_SICK_OR_TRIP: форма остаётся, показаны заблокированные дни и «Принять предложенную дату»',
      A.S.form && A.S.form.blocked && A.S.form.blocked.blocked_days.some((d) => d.date === blockDay) &&
      A.has('больничный') && A.has('data-tk-act="acceptSuggested"') && A.has('Принять предложенную дату'));
    const countBefore = (await http(base, adminCk, 'GET', 'api/tasks.php')).json.tasks.length;
    check('E36 до подтверждения admin задача НЕ создана', !(await http(base, adminCk, 'GET', 'api/tasks.php')).json.tasks.some((t) => t.title === 'Задача на больничный'));
    await A.click('acceptSuggested');
    const all = (await http(base, adminCk, 'GET', 'api/tasks.php')).json.tasks;
    const sug = all.find((t) => t.title === 'Задача на больничный');
    check('E37 «Принять предложенную дату» → задача создана на предложенный срок вне больничного',
      sug && sug.first_day > blockDay && sug.last_day > sug.first_day && A.S.form === null && all.length === countBefore + 1, JSON.stringify(sug && [sug.start_at, sug.end_at]));

    // AC-4 conflict + AC-8 pending
    const mk = await http(base, adminCk, 'POST', 'api/tasks.php', { title: 'Будет конфликт', start_at: '2099-08-10', end_at: '2099-08-12', assignees: [e3] });
    const sdb2 = sdb();
    sdb2.prepare("INSERT OR REPLACE INTO schedule_entries (employee_id, date, status, comment, approval_status, updated_at, version) VALUES (?, '2099-08-11', 'sick', NULL, 'draft', '2099-01-01', 1)").run(e3);
    sdb2.prepare("UPDATE tasks SET check_state = 'pending' WHERE id = ?").run(mk.json.task.id);
    sdb2.close();
    await A.click('setView', (d) => d.view === 'list');
    check('E38 AC-8/AC-4 в списке: пометки «конфликт: больничный» и «не проверено»', A.has('конфликт: больничный') && A.has('не проверено'));
    await A.click('openTask', (d) => d.id === mk.json.task.id);
    check('E39 карточка: блок конфликта и блок «Не проверено»', A.has('tk-box-warn') && A.has('Не проверено.') && A.has('Задача не отменяется'));

    // архив
    A.confirms.answer = true;
    await A.click('archiveTask', (d) => d.id === mk.json.task.id);
    const arch = (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + mk.json.task.id)).json.task;
    check('E40 «В архив» (с подтверждением) → archived=1, из списка исчезает',
      arch.archived === 1 && A.confirms.asked.length === 1 && !A.S.tasks.some((t) => t.id === mk.json.task.id) && A.S.selectedId === null);

    // ---------- D-1 (T1-8): «Исполнитель удалён» + окно замены ----------
    console.log('-- D-1 (T1-8) «Исполнитель удалён» + окно замены');
    const NONE = '__none__';
    const dbx = sdb();
    const insEmp = dbx.prepare("INSERT OR REPLACE INTO employees (id, full_name, location, sort_order) VALUES (?, ?, 'QA', 0)");
    insEmp.run('t8_gone', 'Удалённый Первый'); insEmp.run('t8_ok', 'Принимающий Тестович');
    insEmp.run('t8_sick', 'Больной Тестович'); insEmp.run('t8_tmp', 'Временный Тестович'); insEmp.run('t8_gone2', 'Удалённый Второй');
    dbx.prepare("INSERT OR REPLACE INTO schedule_entries (employee_id, date, status, comment, approval_status, updated_at, version) VALUES ('t8_sick', '2099-11-03', 'sick', NULL, 'draft', '2099-01-01', 1)").run();
    dbx.close();
    const mkT = async (title, extra) => {
      const r = await http(base, adminCk, 'POST', 'api/tasks.php', Object.assign({ title, start_at: '2099-10-05', assignees: ['t8_gone'] }, extra || {}));
      if (!r.json.success) throw new Error('mkT ' + title + ' → ' + JSON.stringify(r.json));
      return r.json.task;
    };
    const getT = async (id) => (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + id)).json.task;
    const tA = await mkT('D1 Сирота A');
    const tB = await mkT('D1 Сирота B', { start_at: '2099-11-02', end_at: '2099-11-04' });
    const tM = await mkT('D1 Смешанная', { assignees: ['t8_gone', 't8_ok'] });
    const tE = await mkT('D1 Конфликт версий', { start_at: '2099-10-06' });
    const tF = await mkT('D1 Карточка Назначить', { start_at: '2099-10-07' });
    const tC = await mkT('D1 Закрытая', { start_at: '2099-10-08' });
    await http(base, adminCk, 'POST', 'api/tasks.php?id=' + tC.id + '&action=close', { version: tC.version });

    A.els.tabTasks.click();
    await A.settle();
    const tabHtml = () => A.els.tabTasks.innerHTML;
    check('D1-1 счётчик ⚠: открытых задач без исполнителя нет → на вкладке «Задачи» счётчика нет', tabHtml().indexOf('tk-orph-cnt') < 0 && tabHtml().indexOf('⚠') < 0, tabHtml());
    const of = await A.T.openTasksFor('t8_gone');
    check('D1-2 openTasksFor до удаления: 5 открытых задач (закрытая не считается), ok=true',
      of.ok === true && of.count === 5 && of.tasks.length === 5 && !of.tasks.some((t) => t.id === tC.id) && of.tasks.every((t) => t.version >= 1), JSON.stringify(of));
    const offline = makeEnv('http://127.0.0.1:1', '');
    const of2 = await offline.T.openTasksFor('t8_gone');
    const of3 = await A.T.openTasksFor('');
    check('D1-3 openTasksFor при сбое сети/пустом id: ok=false, count=0, без исключения (удаление не блокируется)',
      of2.ok === false && of2.count === 0 && of3.ok === false);

    const del = await http(base, adminCk, 'DELETE', 'api/employees.php?id=t8_gone', { confirm: true });
    check('D1-4 сотрудник удалён через API (admin) — задачи остались', del.status === 200 && (await getT(tA.id)) && (await getT(tA.id)).orphan === true, del.status);
    await A.T.refreshOrphans();
    await A.settle();
    check('D1-5 счётчик ⚠ 4 (A, B, E, F без исполнителя; смешанная и закрытая не считаются)', /<span class="tk-orph-cnt"[^>]*>⚠ 4<\/span>/.test(tabHtml()), tabHtml());

    // Список
    A.els.tabTasks.click();
    await A.settle();
    await A.click('setView', (d) => d.view === 'list');
    await A.click('resetFilters');
    const rowOf = (id) => (A.root.innerHTML.split('<tr ').filter((r) => r.indexOf('data-id="' + id + '"') >= 0)[0] || '');
    check('D1-6 Список: у задачи без исполнителя серая плашка «Исполнитель удалён (Удалённый Первый)» и оранжевая полоса (класс tk-orph)',
      rowOf(tA.id).indexOf('class="tk-row tk-orph"') >= 0 && rowOf(tA.id).indexOf('<span class="tk-plate"') >= 0 &&
      rowOf(tA.id).indexOf('Исполнитель удалён (Удалённый Первый)') >= 0 && A.count('class="tk-plate"') === 4, A.count('class="tk-plate"'));
    check('D1-7 Список: 2 исполнителя, удалён один — не «без исполнителя»: нет плашки/полосы, удалённый зачёркнут, действующий — ссылка',
      rowOf(tM.id).indexOf('tk-orph') < 0 && rowOf(tM.id).indexOf('tk-plate') < 0 &&
      /<s class="tk-gone"[^>]*>Удалённый Первый<\/s>/.test(rowOf(tM.id)) && rowOf(tM.id).indexOf('data-emp="t8_ok"') >= 0);
    check('D1-8 Список: закрытая задача удалённого — без пометок (ни плашки, ни полосы, ни зачёркивания), ФИО (snapshot) осталось',
      rowOf(tC.id).indexOf('tk-orph') < 0 && rowOf(tC.id).indexOf('tk-plate') < 0 && rowOf(tC.id).indexOf('tk-gone') < 0 &&
      rowOf(tC.id).indexOf('Удалённый Первый') >= 0);
    check('D1-9 фильтр «Сотрудник» содержит пункт «Без исполнителя»', A.has('<option value="' + NONE + '">Без исполнителя</option>'));
    await A.filter('emp', NONE);
    check('D1-10 фильтр «Без исполнителя»: остаются только 4 задачи без исполнителя',
      A.count('<tr class="tk-row') === 4 && rowOf(tA.id) && rowOf(tB.id) && rowOf(tE.id) && rowOf(tF.id) && !rowOf(tM.id) && !rowOf(tC.id));
    await A.click('resetFilters');

    // Доска
    await A.click('setView', (d) => d.view === 'board');
    const secStart = A.root.innerHTML.indexOf('data-tk-sec="orphans"');
    const colsStart = A.root.innerHTML.indexOf('class="tk-cols"');
    const secHtml = secStart >= 0 ? A.root.innerHTML.slice(secStart, colsStart) : '';
    const openColHtml = A.root.innerHTML.slice(A.root.innerHTML.indexOf('data-tk-col="open"'), A.root.innerHTML.indexOf('data-tk-col="closed"'));
    check('D1-11 Доска: сверху секция «Без исполнителя» (⚠ 4) с карточками A/B/E/F и плашкой; смешанной в ней нет, она в колонке «Открыта»',
      secStart >= 0 && secStart < colsStart && secHtml.indexOf('⚠ Без исполнителя · 4') >= 0 && (secHtml.match(/data-tk-act="openTask"/g) || []).length === 4 &&
      [tA, tB, tE, tF].every((t) => secHtml.indexOf('data-id="' + t.id + '"') >= 0) && secHtml.indexOf('data-id="' + tM.id + '"') < 0 &&
      secHtml.indexOf('Исполнитель удалён (Удалённый Первый)') >= 0 && openColHtml.indexOf('data-id="' + tM.id + '"') >= 0 && openColHtml.indexOf('data-id="' + tA.id + '"') < 0);
    const cardOf = (html, id) => (html.split('<div class="tk-card').filter((r) => r.indexOf('data-id="' + id + '"') >= 0)[0] || '');
    check('P3-3 Доска: в мини-карточке смешанной задачи удалённый исполнитель зачёркнут (<s class="tk-gone">Удалённый Первый</s>), действующий — обычным текстом; у задач без исполнителя — плашка, без зачёркивания',
      />Принимающий Тестович<\/span>, <s class="tk-gone"[^>]*>Удалённый Первый<\/s>/.test(cardOf(openColHtml, tM.id)) &&
      cardOf(secHtml, tA.id).indexOf('tk-plate') >= 0 && cardOf(secHtml, tA.id).indexOf('<s class="tk-gone"') < 0, cardOf(openColHtml, tM.id).slice(0, 300));

    // Календарь
    await A.T.open({ employeeId: '', date: '2099-10-05', view: 'calendar' });
    await A.settle();
    const tileOf = (id) => (A.root.innerHTML.split('<div class="tk-ev').filter((r) => r.indexOf('data-id="' + id + '"') >= 0)[0] || '');
    check('D1-12 Календарь: плитка без исполнителя — класс tk-orph (пунктирная оранжевая рамка) и значок «Без исполнителя» (V6-2 R-6: компактно, без текста на плитке); ФИО не показывается',
      tileOf(tA.id).indexOf('tk-orph') >= 0 && tileOf(tA.id).indexOf('tk-ic-orph" title="Без исполнителя"') >= 0 && tileOf(tA.id).indexOf('<b>Удалённый') < 0);
    check('D1-13 Календарь: у смешанной и закрытой задач плитка без пометок «без исполнителя»',
      tileOf(tM.id) && tileOf(tM.id).indexOf('tk-orph') < 0 && tileOf(tM.id).indexOf('без исполнителя') < 0 &&
      tileOf(tC.id) && tileOf(tC.id).indexOf('tk-orph') < 0 && tileOf(tC.id).indexOf('Удалённый Первый') >= 0);

    // Карточка
    await A.click('openTask', (d) => d.id === tA.id);
    const detailHtml = () => A.root.innerHTML.slice(A.root.innerHTML.indexOf('<aside class="tk-detail"'));
    check('D1-14 Карточка: плашка «Исполнитель удалён <дата>» (дата из removed_at), кнопка «Назначить» (admin), подсказка «закрыть можно без исполнителя»',
      /data-tk-box="orphan"><b>Исполнитель удалён \d{2}\.\d{2}\.\d{4}<\/b>/.test(detailHtml()) && detailHtml().indexOf('data-tk-act="assignOrphan"') >= 0 &&
      detailHtml().indexOf('Закрыть задачу можно и без исполнителя') >= 0 && detailHtml().indexOf('data-tk-act="closeTask"') >= 0 &&
      !/null|Invalid Date|undefined/.test(detailHtml()), detailHtml().slice(0, 400));
    await A.click('openTask', (d) => d.id === tM.id);
    check('D1-15 Карточка смешанной задачи: удалённый зачёркнут, плашки «без исполнителя» и кнопки «Назначить» нет',
      /<s class="tk-gone"[^>]*>Удалённый Первый<\/s>/.test(detailHtml()) && detailHtml().indexOf('data-tk-box="orphan"') < 0 && detailHtml().indexOf('assignOrphan') < 0);
    await A.click('openTask', (d) => d.id === tC.id);
    check('D1-16 Карточка закрытой задачи: без плашки/зачёркивания, ФИО осталось',
      detailHtml().indexOf('data-tk-box="orphan"') < 0 && detailHtml().indexOf('tk-gone') < 0 && detailHtml().indexOf('Удалённый Первый') >= 0);

    // removed_at = null / ФИО = null (старые данные)
    const fake = (id, assignees, orphan) => Object.assign({}, JSON.parse(JSON.stringify(tA)), { id, title: 'Старые данные ' + id, assignees, orphan, status: 'open', archived: 0 });
    A.S.tasks.push(fake('fake-1', [{ employee_id: 'x1', full_name: null, removed: true, removed_at: null }], true));
    A.S.tasks.push(fake('fake-2', [{ employee_id: 'x2', full_name: null, removed: true, removed_at: null }, { employee_id: 't8_ok', full_name: 'Принимающий Тестович', removed: false, removed_at: null }], false));
    A.S.view = 'board'; A.S.selectedId = 'fake-1'; A.T.__t.render();
    const h1 = A.root.innerHTML;
    check('D1-17 removed_at=null и ФИО=null: плашка «Исполнитель удалён» без даты и без скобок, ни «null», ни «Invalid Date»',
      h1.indexOf('<b>Исполнитель удалён</b>') >= 0 && h1.indexOf('>Исполнитель удалён</span>') >= 0 && !/null|Invalid Date|undefined/.test(h1.slice(h1.indexOf('data-tk-sec="orphans"'))), h1.slice(h1.indexOf('data-tk-box="orphan"'), h1.indexOf('data-tk-box="orphan"') + 200));
    A.S.selectedId = 'fake-2'; A.T.__t.render();
    check('D1-18 ФИО удалённого пусто у смешанной задачи: показывается «сотрудник удалён» (зачёркнуто), не id',
      /<s class="tk-gone"[^>]*>сотрудник удалён<\/s>/.test(A.root.innerHTML) && A.root.innerHTML.indexOf('>x2<') < 0);
    A.S.tasks.push(fake('fake-3', [{ employee_id: 'x3', full_name: '<img src=x onerror=1>', removed: true, removed_at: null }, { employee_id: 't8_ok', full_name: 'Принимающий Тестович', removed: false, removed_at: null }], false));
    A.S.selectedId = null; A.T.__t.render();
    check('P3-3b экранирование сохранено: ФИО удалённого с HTML на Доске — <s class="tk-gone">&lt;img src=x onerror=1&gt;</s>, сырого тега нет',
      A.root.innerHTML.indexOf('<s class="tk-gone" title="Сотрудник удалён">&lt;img src=x onerror=1&gt;</s>') >= 0 && A.root.innerHTML.indexOf('<img src=x') < 0);
    A.S.tasks = A.S.tasks.filter((t) => t.id.indexOf('fake-') !== 0); A.S.selectedId = null;

    // supervisor / viewer: все пометки видны, «Назначить» и окно — нет
    for (const [label, ck] of [['supervisor', supCk], ['viewer', viewCk]]) {
      const R = makeEnv(base, ck);
      R.els.tabTasks.click();
      await R.settle();
      const rh = () => R.root.innerHTML;
      const rtab = R.els.tabTasks.innerHTML;
      await R.click('openTask', (d) => d.id === tA.id);
      const rdet = rh().slice(rh().indexOf('<aside class="tk-detail"'));
      const postsBefore = R.calls.filter((c) => c.method !== 'GET').length;
      const shown = await R.T.offerReassign('t8_gone', 'Удалённый Первый', of.tasks);
      await R.settle();
      R.T.__t.ACTIONS.assignOrphan({ dataset: { id: tA.id } });
      check('D1-R-' + label + ' видит счётчик ⚠ 4, плашку и дату в карточке; НЕТ «Назначить», окно замены не показывается, запросов записи нет',
        /⚠ 4<\/span>/.test(rtab) && /data-tk-box="orphan"><b>Исполнитель удалён/.test(rdet) && rdet.indexOf('assignOrphan') < 0 && rdet.indexOf('data-tk-act="closeTask"') < 0 &&
        shown === false && R.modalEl() === null && R.S.form === null && R.calls.filter((c) => c.method !== 'GET').length === postsBefore, rtab);
      await R.click('setView', (d) => d.view === 'list');
      check('D1-R-' + label + '-list в Списке плашки и фильтр «Без исполнителя» видны', R.count('class="tk-plate"') === 4 && R.count('tk-row tk-orph') === 4 && R.has('value="' + NONE + '"'));
    }

    // «Назначить» в карточке (admin): PUT assignees = только новый, без удалённого id
    await A.T.open({ view: 'board', taskId: tF.id });
    await A.settle();
    await A.click('assignOrphan', (d) => d.id === tF.id);
    check('D1-19 «Назначить» в карточке: открывается форма, удалённый исполнитель в чипах не показывается', A.S.form && A.S.form.id === tF.id && A.S.form.draft.assignees.length === 0 &&
      A.has('никого не выбрано') && A.root.innerHTML.indexOf('"t8_gone"') < 0);
    await A.field('assigneePick', 't8_ok');
    const putsBefore = A.calls.filter((c) => c.method === 'PUT').length;
    await A.click('saveForm');
    const putF = A.calls.filter((c) => c.method === 'PUT').slice(putsBefore)[0];
    const fAfter = await getT(tF.id);
    check('D1-20 «Назначить» → PUT с version и assignees=[t8_ok]; задача больше не orphan; счётчик ⚠ 3',
      putF && putF.body.version === tF.version && JSON.stringify(putF.body.assignees) === '["t8_ok"]' && fAfter.orphan === false &&
      fAfter.assignees.length === 1 && fAfter.assignees[0].employee_id === 't8_ok' && /⚠ 3<\/span>/.test(tabHtml()) && A.events.indexOf('tasks:changed') >= 0, tabHtml());

    // правка текста смешанной / «без исполнителя» задачи не трогает состав исполнителей
    await A.T.open({ view: 'board', taskId: tM.id });
    await A.settle();
    await A.click('editTask', (d) => d.id === tM.id);
    await A.field('description', 'Правка без смены исполнителей');
    let pb = A.calls.filter((c) => c.method === 'PUT').length;
    await A.click('saveForm');
    const putM = A.calls.filter((c) => c.method === 'PUT').slice(pb)[0];
    const mAfter = await getT(tM.id);
    check('D1-21 правка смешанной задачи: форма не показывает удалённого, PUT без assignees, удалённый остаётся в задаче (snapshot цел)',
      putM && !('assignees' in putM.body) && mAfter.description === 'Правка без смены исполнителей' && mAfter.assignees.length === 2 && mAfter.assignees.some((a) => a.removed && a.full_name === 'Удалённый Первый'), JSON.stringify(putM && putM.body));
    await A.T.open({ view: 'board', taskId: tB.id });
    await A.settle();
    await A.click('editTask', (d) => d.id === tB.id);
    await A.field('description', 'Правка сироты');
    pb = A.calls.filter((c) => c.method === 'PUT').length;
    await A.click('saveForm');
    const putB = A.calls.filter((c) => c.method === 'PUT').slice(pb)[0];
    const bAfter = await getT(tB.id);
    check('D1-22 правка задачи «без исполнителя» разрешена без выбора исполнителя (PUT без assignees → 200), задача остаётся orphan',
      putB && !('assignees' in putB.body) && A.S.form === null && bAfter.description === 'Правка сироты' && bAfter.orphan === true, A.S.form && A.S.form.error);

    // окно замены
    const modalTasks = of.tasks.filter((t) => t.id !== tF.id);
    const evBefore = A.events.length;
    const shownA = await A.T.offerReassign('t8_gone', 'Удалённый Первый', modalTasks);
    await A.settle();
    const selOpts = (A.mhtml().match(/<select data-tk-mtarget[\s\S]*?<\/select>/) || [''])[0];
    check('D1-23 окно: «У Удалённый Первый было 4 открытые задачи», 4 задачи с галочками (все отмечены), «Передать: [сотрудник ▾]» только из действующих, кнопки «Назначить» и «Позже»',
      shownA === true && A.modalEl() && A.mhas('было 4 открытые задачи') && A.mcount('data-tk-mchk=') === 4 && (A.mhtml().match(/data-tk-mchk="[^"]+" checked/g) || []).length === 4 &&
      selOpts.indexOf('value="t8_ok"') >= 0 && selOpts.indexOf('value="t8_sick"') >= 0 && selOpts.indexOf('value="t8_gone"') < 0 &&
      A.mhas('data-tk-act="mAssign"') && A.mhas('data-tk-act="mLater"') && A.mhas('>Позже<') && A.mhas('Передать:'), A.mhtml().slice(0, 300));
    check('D1-24 окно: у смешанной задачи показано, что остаётся другой исполнитель (его не затирают)', A.mhas('Остаётся исполнителем: Принимающий Тестович'));
    let pc = A.calls.filter((c) => c.method === 'PUT').length;
    await A.mclick('mAssign');
    check('D1-25 «Назначить» без выбранного сотрудника: понятная ошибка, запросов записи нет', A.mhas('Выберите сотрудника') && A.calls.filter((c) => c.method === 'PUT').length === pc);
    await A.mchange('data-tk-mtarget', '1', 't8_sick');
    // другой пользователь меняет задачу E после открытия окна → 409 при первом PUT
    const eNow = await getT(tE.id);
    const bump = await http(base, adminCk, 'PUT', 'api/tasks.php?id=' + tE.id, { version: eNow.version, title: 'D1 Конфликт версий (чужая правка)' });
    pc = A.calls.filter((c) => c.method === 'PUT').length;
    const gets0 = A.calls.filter((c) => c.method === 'GET' && c.url.indexOf('id=' + tE.id) >= 0).length;
    const tn26 = A.toasts.length;
    await A.mclick('mAssign');
    const puts = A.calls.filter((c) => c.method === 'PUT').slice(pc);
    const putsE = puts.filter((c) => c.url.indexOf(tE.id) >= 0);
    const putM2 = puts.filter((c) => c.url.indexOf(tM.id) >= 0)[0];
    const sA = await getT(tA.id), sM = await getT(tM.id), sE = await getT(tE.id), sB = await getT(tB.id);
    check('D1-26 «Назначить»: PUT по каждой отмеченной задаче с version; A, M, E переназначены на «Больной Тестович», B — нет',
      bump.status === 200 && puts.length === 5 && puts.every((c) => typeof c.body.version === 'number') &&
      sA.orphan === false && sA.assignees.length === 1 && sA.assignees[0].employee_id === 't8_sick' &&
      sE.assignees.length === 1 && sE.assignees[0].employee_id === 't8_sick' && sE.title.indexOf('чужая правка') > 0 &&
      sB.orphan === true && sB.assignees[0].removed === true, puts.map((c) => c.url + ':' + JSON.stringify(c.body)).join(' | '));
    check('D1-27 смешанная задача: новый исполнитель добавлен к оставшемуся (assignees = [t8_ok, t8_sick]), удалённый заменён',
      putM2 && JSON.stringify(putM2.body.assignees) === '["t8_ok","t8_sick"]' && sM.assignees.length === 2 && !sM.assignees.some((a) => a.removed) &&
      sM.assignees.map((a) => a.employee_id).sort().join() === 't8_ok,t8_sick');
    check('D1-28 409 VERSION_CONFLICT: задача перечитана и PUT повторён один раз (2 PUT, GET между ними), в итоге назначена',
      putsE.length === 2 && A.calls.filter((c) => c.method === 'GET' && c.url.indexOf('id=' + tE.id) >= 0).length > gets0 && A.mcount('class="tk-mok"') === 3, putsE.length);
    const blockedHtml = A.mhtml().slice(A.mhtml().indexOf('tk-mblocked'));
    // T1-11 P3-1: после 409-повтора строка задачи E в окне — с названием и версией с сервера
    const liE = (A.mhtml().split('<li ').filter((r) => r.indexOf('data-tk-mitem="' + tE.id + '"') >= 0)[0] || '');
    check('P3-1b после 409-повтора строка задачи в окне показывает новое название с сервера («чужая правка»), а не снятое при открытии окна',
      liE.indexOf('D1 Конфликт версий (чужая правка)') >= 0 && liE.indexOf('<b>D1 Конфликт версий</b>') < 0 &&
      A.S.modal.items.find((it) => it.id === tE.id).version === sE.version, liE.slice(0, 300));
    // T1-11 P3-2: 3 из 4 назначены (B — 422) → «Переназначено 3 из 4; остальные — см. окно», тип info, без «Задачи переназначены»
    const tn26list = A.toasts.slice(tn26);
    check('P3-2b частичный успех (3 из 4, B заблокирована 422): тост «Переназначено 3 из 4; остальные — см. окно» (info), тоста «Задачи переназначены» нет',
      tn26list.length === 1 && tn26list[0].text === 'Переназначено 3 из 4; остальные — см. окно' && tn26list[0].type === 'info', JSON.stringify(tn26list));
    check('D1-29 422 sick/trip: задача B НЕ переназначена, в окне причина (дата — ФИО — больничный) и кнопка «Принять предложенную дату»; остальные переназначены',
      A.mhas('tk-mblocked') && /больничный/.test(blockedHtml) && blockedHtml.indexOf('Больной Тестович') >= 0 && A.mcount('data-tk-act="mAccept"') === 1 &&
      A.mhas('Принять предложенную дату') && A.mcount('tk-mit-done') === 3, A.mhtml().slice(-700));
    check('D1-30 после переназначения: событие tasks:changed, счётчик ⚠ 1 (осталась только B)', A.events.length > evBefore && A.events.slice(evBefore).indexOf('tasks:changed') >= 0 && /⚠ 1<\/span>/.test(tabHtml()), tabHtml());
    await A.mclick('mLater');
    await A.settle();
    check('D1-31 «Позже»: окно закрыто, задача B осталась в счётчике ⚠ 1, изменений на сервере нет',
      A.modalEl() === null && A.S.modal === null && /⚠ 1<\/span>/.test(tabHtml()) && (await getT(tB.id)).orphan === true);

    // «Принять предложенную дату»
    await A.T.offerReassign('t8_gone', 'Удалённый Первый', [{ id: tB.id, title: tB.title, start_at: tB.start_at, end_at: tB.end_at, version: tB.version }]);
    await A.settle();
    check('D1-32 окно для одной задачи: «У … было 1 открытая задача» (склонение)', A.mhas('было 1 открытая задача'));
    await A.mchange('data-tk-mtarget', '1', 't8_sick');
    const tn33 = A.toasts.length;
    await A.mclick('mAssign');
    check('D1-33 B снова 422: показана кнопка «Принять предложенную дату», задача не изменена', A.mcount('data-tk-act="mAccept"') === 1 && (await getT(tB.id)).orphan === true);
    check('P3-2c ни одной задачи не назначено (единственная B → 422): тоста успеха нет', A.toasts.length === tn33, JSON.stringify(A.toasts.slice(tn33)));
    const oldPeriodB = A.T.__t.fmtPeriod(tB);
    const liB0 = (A.mhtml().split('<li ').filter((r) => r.indexOf('data-tk-mitem="' + tB.id + '"') >= 0)[0] || '');
    check('P3-1c-pre до «Принять предложенную дату» строка B показывает исходный срок', liB0.indexOf(A.T.__t.esc(oldPeriodB)) >= 0, liB0.slice(0, 250));
    pc = A.calls.filter((c) => c.method === 'PUT').length;
    const tn34 = A.toasts.length;
    await A.mclick('mAccept', (d) => d.id === tB.id);
    const putAcc = A.calls.filter((c) => c.method === 'PUT').slice(pc).pop();
    const bFinal = await getT(tB.id);
    check('D1-34 «Принять предложенную дату»: PUT с предложенным сроком и исполнителем; задача назначена, срок сдвинут за больничный, ⚠ нет',
      putAcc && putAcc.body.start_at && putAcc.body.end_at && bFinal.orphan === false && bFinal.assignees[0].employee_id === 't8_sick' &&
      bFinal.start_at.slice(0, 10) > '2099-11-03' && A.mcount('tk-mit-done') === 1 && A.mhas('>Закрыть<') && tabHtml().indexOf('⚠') < 0, JSON.stringify(putAcc && putAcc.body) + ' ' + bFinal.start_at);
    const liB1 = (A.mhtml().split('<li ').filter((r) => r.indexOf('data-tk-mitem="' + tB.id + '"') >= 0)[0] || '');
    const newPeriodB = A.T.__t.fmtPeriod(bFinal);
    check('P3-1a после 422 → «Принять предложенную дату» строка задачи в окне показывает НОВЫЙ срок с сервера (не прежний), версия обновлена',
      newPeriodB !== oldPeriodB && liB1.indexOf(A.T.__t.esc(newPeriodB)) >= 0 && liB1.indexOf(A.T.__t.esc(oldPeriodB)) < 0 &&
      A.S.modal.items.find((it) => it.id === tB.id).version === bFinal.version, oldPeriodB + ' → ' + newPeriodB + ' | ' + liB1.slice(0, 250));
    const tn34list = A.toasts.slice(tn34);
    check('P3-2a все обработанные назначены (1 из 1 после «Принять предложенную дату»): тост «Задачи переназначены» (success)',
      tn34list.length === 1 && tn34list[0].text === 'Задачи переназначены' && tn34list[0].type === 'success', JSON.stringify(tn34list));
    await A.mclick('mLater');
    check('D1-35 «Закрыть» после полной обработки: окно закрыто', A.modalEl() === null && A.S.modal === null);

    // получатель удалён, пока окно открыто → 400 employee_not_found внутри окна
    const tN = await mkT('D1 Для второго окна', { assignees: ['t8_gone2'], start_at: '2099-10-09' });
    await http(base, adminCk, 'DELETE', 'api/employees.php?id=t8_gone2', { confirm: true });
    await A.T.offerReassign('t8_gone2', 'Удалённый Второй', [{ id: tN.id, title: tN.title, start_at: tN.start_at, end_at: null, version: tN.version }]);
    await A.settle();
    await A.mchange('data-tk-mtarget', '1', 't8_tmp');
    await http(base, adminCk, 'DELETE', 'api/employees.php?id=t8_tmp', { confirm: true });
    await A.mclick('mAssign');
    const optsAfter = (A.mhtml().match(/<select data-tk-mtarget[\s\S]*?<\/select>/) || [''])[0];
    check('D1-36 получатель удалён, пока окно открыто: 400 employee_not_found показан в окне, задача не изменена, список сотрудников обновлён',
      A.modalEl() && A.mhas('Выбранный сотрудник не найден') && (await getT(tN.id)).orphan === true && optsAfter.indexOf('t8_tmp') < 0 && A.S.modal.target === '', A.mhtml().slice(0, 300));
    await A.mclick('mLater');

    // задача закрыта другим пользователем, пока окно открыто: 409 → перечитали → закрыта → не переназначается, без повторного PUT
    const tK = await mkT('D1 Закроют до назначения', { assignees: ['t8_ok'], start_at: '2099-10-10' });
    await A.T.offerReassign('t8_ghost', 'Призрак Тестович', [{ id: tK.id, title: tK.title, start_at: tK.start_at, end_at: null, version: tK.version }]);
    await A.settle();
    await A.mchange('data-tk-mtarget', '1', 't8_sick');
    const kNow = await getT(tK.id);
    await http(base, adminCk, 'POST', 'api/tasks.php?id=' + tK.id + '&action=close', { version: kNow.version });
    pc = A.calls.filter((c) => c.method === 'PUT').length;
    await A.mclick('mAssign');
    const putsK = A.calls.filter((c) => c.method === 'PUT').slice(pc).filter((c) => c.url.indexOf(tK.id) >= 0);
    const kAfter = await getT(tK.id);
    check('D1-37 задачу закрыли, пока окно открыто: 409 → перечитана → «уже закрыта», повторного PUT нет, исполнители не тронуты',
      putsK.length === 1 && A.mhas('Задача уже закрыта или в архиве') && kAfter.status === 'closed' && kAfter.assignees.length === 1 && kAfter.assignees[0].employee_id === 't8_ok' && A.mcount('tk-mit-skipped') === 1);
    await A.mclick('mLater');
    check('D1-38 после всех окон счётчик ⚠ = 1 (осталась только задача для удалённого «Второго»)', /⚠ 1<\/span>/.test(tabHtml()), tabHtml());

    // ---------- T1-11 (P3-4): Tasks.onRemoteChange() — удаление сотрудника другим клиентом ----------
    console.log('-- T1-11 P3-4 onRemoteChange');
    const dby = sdb();
    const insE2 = dby.prepare("INSERT OR REPLACE INTO employees (id, full_name, location, sort_order) VALUES (?, ?, 'QA', 0)");
    insE2.run('t11_g1', 'Удаляемый Одиннадцатый'); insE2.run('t11_g2', 'Удаляемый Двенадцатый');
    dby.close();
    const tG1 = await mkT('P34 Задача удаляемого 1', { assignees: ['t11_g1'], label: 'p34', start_at: '2099-12-01' });
    const tG2 = await mkT('P34 Задача удаляемого 2', { assignees: ['t11_g2'], label: 'p34', start_at: '2099-12-02' });
    const tH = await mkT('P34 Задача действующего', { assignees: ['t8_ok'], label: 'p34', start_at: '2099-12-03' });
    const badgeN = (R) => { const m = /⚠ (\d+)<\/span>/.exec(R.els.tabTasks.innerHTML); return m ? +m[1] : 0; };
    const getsOf = (R, from) => R.calls.slice(from).map((c) => c.method + ' ' + c.url);

    // (1) панель закрыта (вкладка не открывалась): один запрос ?orphans=1, список не грузится
    const C = makeEnv(base, adminCk);
    await C.settle();
    const c0 = C.calls.length;
    await C.T.onRemoteChange();
    await C.settle();
    const c1 = getsOf(C, c0);
    check('P3-4a onRemoteChange при закрытой панели: только один запрос ?orphans=1 (счётчик обновлён), список/сотрудники не запрашиваются',
      c1.length === 1 && /^GET api\/tasks\.php\?orphans=1$/.test(c1[0]) && C.S.tasks.length === 0 && C.root.innerHTML === '', c1.join(' | '));

    // (2) открыт Список с фильтром и выбранной задачей
    const R = makeEnv(base, adminCk);
    R.els.vacationTrigger.click();
    R.els.tabTasks.click();
    await R.settle();
    await R.click('setView', (d) => d.view === 'list');
    await R.filter('label', 'p34');
    await R.click('openTask', (d) => d.id === tH.id);
    await R.click('setView', (d) => d.view === 'list');
    R.S.selectedId = tH.id;
    const rowIn = (id) => (R.root.innerHTML.split('<tr ').filter((r) => r.indexOf('data-id="' + id + '"') >= 0)[0] || '');
    const nb0 = badgeN(R);
    check('P3-4b-pre до удаления: Список с фильтром «p34», задача G1 с действующим исполнителем (без плашки)',
      R.S.view === 'list' && R.S.filters.label === 'p34' && rowIn(tG1.id) && rowIn(tG1.id).indexOf('tk-plate') < 0 && rowIn(tG1.id).indexOf('Удаляемый Одиннадцатый') >= 0, rowIn(tG1.id).slice(0, 200));
    // «другой клиент» удаляет сотрудника (БД + sync_log — через настоящий API)
    const del1 = await http(base, adminCk, 'DELETE', 'api/employees.php?id=t11_g1', { confirm: true });
    const r0 = R.calls.length;
    await R.T.onRemoteChange();
    await R.settle();
    check('P3-4b onRemoteChange при открытом Списке: счётчик ⚠ вырос на 1, список перезагружен (G1 теперь с плашкой «Исполнитель удалён»), удалённый пропал из фильтра «Сотрудник»',
      del1.status === 200 && badgeN(R) === nb0 + 1 && rowIn(tG1.id).indexOf('tk-plate') >= 0 && rowIn(tG1.id).indexOf('Исполнитель удалён (Удаляемый Одиннадцатый)') >= 0 &&
      R.root.innerHTML.indexOf('<option value="t11_g1"') < 0, 'badge ' + nb0 + '→' + badgeN(R) + ' ' + getsOf(R, r0).join(' | '));
    check('P3-4c фильтр «p34», выбранная задача и вид сохранены; нет записей на сервер; перечитан именно список (GET api/tasks.php) и сотрудники',
      R.S.view === 'list' && R.S.filters.label === 'p34' && R.S.selectedId === tH.id && R.S.form === null &&
      getsOf(R, r0).every((s) => s.indexOf('GET ') === 0) && getsOf(R, r0).some((s) => s === 'GET api/tasks.php') && getsOf(R, r0).some((s) => s.indexOf('orphans=1') > 0) &&
      rowIn(tH.id) && rowIn(tG2.id), getsOf(R, r0).join(' | '));

    // (3) открыто окно замены: окно не сброшено
    const tHm = await mkT('P34 Для окна', { assignees: ['t8_ok'], start_at: '2099-12-04', label: 'p34' });
    await R.T.offerReassign('t8_gone_no', 'Никто', [{ id: tHm.id, title: tHm.title, start_at: tHm.start_at, end_at: null, version: tHm.version }]);
    await R.settle();
    const modalBefore = R.S.modal;
    await R.T.onRemoteChange();
    await R.settle();
    check('P3-4d открытое окно замены не сбрасывается при onRemoteChange (тот же объект S.modal, элемент в DOM)', modalBefore && R.S.modal === modalBefore && R.modalEl() !== null && R.mhas('P34 Для окна'));
    await R.mclick('mLater');

    // (4) открыта форма правки: перечитывается только счётчик, форма не сброшена
    const http2 = await http(base, adminCk, 'DELETE', 'api/employees.php?id=t11_g2', { confirm: true });
    await R.click('openTask', (d) => d.id === tH.id);
    await R.click('editTask', (d) => d.id === tH.id);
    await R.field('description', 'Черновик, который нельзя потерять');
    const formObj = R.S.form;
    const nb1 = badgeN(R), r1 = R.calls.length;
    await R.T.onRemoteChange();
    await R.settle();
    const g = getsOf(R, r1);
    check('P3-4e открыта форма правки: счётчик ⚠ обновлён (+1), форма не сброшена (тот же объект, черновик цел), список/сотрудники не перечитывались (только ?orphans=1)',
      http2.status === 200 && badgeN(R) === nb1 + 1 && R.S.form === formObj && R.S.form.draft.description === 'Черновик, который нельзя потерять' &&
      R.has('data-tk-act="saveForm"') && g.length === 1 && g[0] === 'GET api/tasks.php?orphans=1', g.join(' | ') + ' badge ' + nb1 + '→' + badgeN(R));
    await R.click('cancelForm');
    check('P3-4f после «Отмена» формы отложенное обновление применяется: G2 показан с плашкой «Исполнитель удалён», фильтр и выбор целы',
      R.S.form === null && R.S.filters.label === 'p34' && R.S.selectedId === tH.id && R.has('Исполнитель удалён'), R.S.view + ' ' + R.S.filters.label);

    // (5) панель «Задачи» открыта, но панель отпусков закрыта (class open снят): только счётчик, список — при следующем открытии
    R.els.vacationPanel._cls.delete('open');
    R.S.view = 'list'; R.S.dirty = false;
    const r2 = R.calls.length;
    await R.T.onRemoteChange();
    await R.settle();
    const g2 = getsOf(R, r2);
    check('P3-4g панель отпусков закрыта (вкладка «Задачи» активна): запрос только ?orphans=1; список отложен до открытия панели', g2.length === 1 && g2[0] === 'GET api/tasks.php?orphans=1' && R.S.dirty === true, g2.join(' | '));
    R.els.vacationTrigger.click();
    await new Promise((r) => setTimeout(r, 40));
    await R.settle();
    check('P3-4h при следующем открытии панели отложенное обновление выполнено (GET api/tasks.php), флаг сброшен', R.S.dirty === false && getsOf(R, r2).some((s) => s === 'GET api/tasks.php'), getsOf(R, r2).join(' | '));

    // ---------- V6-1: Список / Доска / карточка (R-1, R-4, R-5, R-7, R-8, R-12…R-17) ----------
    console.log('-- V6-1 Список/Доска/карточка');
    const dbv = sdb();
    const insV = dbv.prepare("INSERT OR REPLACE INTO employees (id, full_name, location, sort_order) VALUES (?, ?, 'QA', 0)");
    insV.run('v61_a', 'Отпускник Тестович'); insV.run('v61_b', 'Здоровый Тестович'); insV.run('v61_s', 'Сортировка Тестович');
    insV.run('v61_x', 'Взлом <b>Тегович</b>');
    dbv.close();
    const mkV = async (title, extra) => {
      const r = await http(base, adminCk, 'POST', 'api/tasks.php', Object.assign({ title, start_at: '2099-12-01', end_at: '2099-12-12', assignees: ['v61_s'] }, extra || {}));
      if (!r.json.success) throw new Error('mkV ' + title + ' → ' + JSON.stringify(r.json));
      return r.json.task;
    };
    const LONG = 'Подготовить сводный отчёт по итогам квартала, согласовать с руководителями групп и разослать <b>всем</b> участникам до конца периода (хвост-хвост-хвост)';
    const LABEL = 'v61 "метка"<i>';
    const vX = await mkV('V61 Отпуск и больничный', { description: LONG, label: LABEL, priority: 1, assignees: ['v61_a'] });
    const vY = await mkV('V61 Здоровый', { priority: 3, label: 'v61b', assignees: ['v61_b'] });
    // пометки живут в матрице: вносим после создания задачи (как в E38)
    const dbw = sdb();
    const insE = dbw.prepare("INSERT OR REPLACE INTO schedule_entries (employee_id, date, status, comment, approval_status, updated_at, version) VALUES (?, ?, ?, NULL, 'draft', '2099-01-01', 1)");
    [['2099-12-02', 'vacation'], ['2099-12-03', 'vacation'], ['2099-12-04', 'vacation'], ['2099-12-08', 'day_off'], ['2099-12-10', 'sick'], ['2099-12-12', 'trip']]
      .forEach((x) => insE.run('v61_a', x[0], x[1]));
    dbw.close();
    // три задачи одного сотрудника для проверки сортировки: исходный порядок = порядок ответа API
    const vS1 = await mkV('V61 s1 обычный открыт', { priority: 2 });
    const vS2 = await mkV('V61 s2 высокий закрыт', { priority: 1 });
    const vS3 = await mkV('V61 s3 низкий открыт', { priority: 3 });
    const vS4 = await mkV('V61 s4 высокий открыт', { priority: 1 });
    await http(base, adminCk, 'POST', 'api/tasks.php?id=' + vS2.id + '&action=close', { version: vS2.version });
    const hasMatrixCalls = [];
    A.sandbox.window.openMatrixAt = (o) => { hasMatrixCalls.push(o); return Promise.resolve({}); };
    await A.T.open({ view: 'list' });
    await A.settle();
    const rowTitles = (E) => (E.root.innerHTML.match(/<tr class="tk-row[^>]*>\s*<td class="tk-c-task"><b>[^<]*<\/b>/g) || []).map((x) => /<b>([^<]*)<\/b>/.exec(x)[1]);
    const v61Row = (E, id) => { const m = new RegExp('<tr class="tk-row[^>]*data-id="' + id + '"[\\s\\S]*?</tr>').exec(E.root.innerHTML); return m ? m[0] : ''; };

    // R-1 (кроме E32a): «Назначить» у задач без исполнителя и окно замены остались
    check('V6-1 R-1 «Назначить» (assignOrphan) и окно замены (mAssign/mAccept/mLater) на месте, «Править» одна',
      ['assignOrphan', 'mAssign', 'mAccept', 'mLater', 'editTask'].every((a) => typeof A.T.__t.ACTIONS[a] === 'function') && SRC.indexOf('data-tk-act="assignOrphan"') >= 0);

    // R-16: колонка «Описание» сразу после «Исполнитель»
    const hdr = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(A.root.innerHTML)[1];
    check('V6-1 R-16 → V6.2 W-1: в шапке «Описание» стоит сразу после «Задача», затем «Исполнитель» (колонки поменяны местами)', /<th class="tk-c-task">Задача<\/th><th class="tk-c-desc">Описание<\/th><th class="tk-c-exec">Исполнитель<\/th><th>Срок<\/th>/.test(hdr), hdr);
    const rX = v61Row(A, vX.id), rY = v61Row(A, vY.id);
    const descX = /<td class="tk-desc" title="([^"]*)">([^<]*)<\/td>/.exec(rX);
    check('V6-1 R-16 длинное описание: ≤80 символов с «…», полный текст в title (экранирован), без сырых тегов',
      descX && descX[2].length <= 80 && descX[2].slice(-1) === '…' && unescTitle(descX[1]) === LONG && rX.indexOf('<b>всем</b>') < 0 && rX.indexOf('&lt;b&gt;всем') >= 0, descX && descX[2]);
    check('V6-1 R-16 пустое описание → «—» (без title)', /<td class="tk-desc"><span class="tk-muted">—<\/span><\/td>/.test(rY));
    // колонка стоит именно после исполнителя в строке
    const cells = rX.split('</td>');
    check('V6-1 R-16 → V6.2 W-1 в строке: 2-я ячейка — описание, 3-я — исполнитель', cells[2].indexOf('Отпускник Тестович') >= 0 && cells[1].indexOf('tk-desc') >= 0, cells[2]);

    // R-8: «!» рядом с ФИО
    const wi = /<span class="tk-warnico"[^>]*title="([^"]*)"[^>]*>!<\/span>/.exec(rX);
    check('V6-1 R-8 у исполнителя в отпуске/отгуле/больничном/командировке — «!» с причинами и датами в title',
      wi && unescTitle(wi[1]) === 'отпуск 02.12–04.12; отгул 08.12; больничный 10.12; командировка 12.12' && cells[2].indexOf('tk-warnico') >= 0, wi && wi[1]);
    check('V6-1 R-8 у исполнителя без пометок «!» нет', rY.indexOf('tk-warnico') < 0);
    // удалённый исполнитель: «!» не показывается, даже если по его employee_id есть пометки
    const keepTasks = A.S.tasks;
    A.S.tasks = [Object.assign({}, A.S.tasks.find((t) => t.id === vX.id), { assignees: [{ employee_id: 'v61_a', full_name: 'Отпускник Тестович', removed: true, removed_at: null }, { employee_id: 'v61_b', removed: false }] })];
    A.T.__t.render();
    check('V6-1 R-8 удалённому исполнителю «!» не показывается; у действующего без пометок — тоже нет', A.count('tk-warnico') === 0 && A.has('<s class="tk-gone"'));
    A.S.tasks = keepTasks; A.T.__t.render();
    check('V6-1 R-8 клик по «!»/ФИО не ломает строку: «!» внутри строки с openTask (клик по строке открывает карточку)', /data-tk-act="openTask"/.test(rX) && rX.indexOf('tk-warnico') > 0);

    // R-17: сортировка
    await A.filter('emp', 'v61_s');
    const ORIG = rowTitles(A);
    check('V6-1 R-17 исходный порядок: 4 задачи сотрудника, сортировка выключена, в шапке нейтральный «↕»',
      ORIG.length === 4 && A.S.sort.key === '' && A.count('tk-arr-off') === 2 && A.count('aria-sort="none"') === 2, ORIG.join('|'));
    await A.click('sortBy', (d) => d.key === 'priority');
    const asc = rowTitles(A);
    check('V6-1 R-17 «Приор.» ↑: высокий → обычный → низкий; внутри равного приоритета — исходный порядок; стрелка ↑ и aria-sort',
      asc.join('|') === [ORIG.find((t) => /s2/.test(t)), ORIG.find((t) => /s4/.test(t))].sort((a, b) => ORIG.indexOf(a) - ORIG.indexOf(b)).concat(ORIG.filter((t) => /s1/.test(t)), ORIG.filter((t) => /s3/.test(t))).join('|') &&
      A.S.sort.key === 'priority' && A.S.sort.dir === 'asc' && A.has('data-key="priority" title') && /aria-sort="ascending"[^>]*><button[^>]*data-key="priority"[^>]*>Приор\.<span class="tk-arr"[^>]*>↑</.test(A.root.innerHTML), asc.join('|'));
    check('V6-1 R-17 сортировка не сбрасывает фильтры (emp остался)', A.S.filters.emp === 'v61_s');
    await A.click('sortBy', (d) => d.key === 'priority');
    const desc = rowTitles(A);
    check('V6-1 R-17 «Приор.» ↓: низкий → обычный → высокий; стрелка ↓',
      desc[0].indexOf('s3') > 0 && desc[1].indexOf('s1') > 0 && A.S.sort.dir === 'desc' && />Приор\.<span class="tk-arr"[^>]*>↓</.test(A.root.innerHTML), desc.join('|'));
    await A.click('sortBy', (d) => d.key === 'priority');
    check('V6-1 R-17 третий клик — без сортировки: исходный порядок, стрелки нет', rowTitles(A).join('|') === ORIG.join('|') && A.S.sort.key === '' && A.S.sort.dir === '');
    await A.click('sortBy', (d) => d.key === 'status');
    const st1 = rowTitles(A);
    check('V6-1 R-17 «Статус» ↑: открытые, затем закрытая (вторичный порядок — исходный); «Приор.» без стрелки',
      st1[3].indexOf('s2') > 0 && st1.slice(0, 3).join('|') === ORIG.filter((t) => !/s2/.test(t)).join('|') && A.S.sort.key === 'status' && />Статус<span class="tk-arr"[^>]*>↑</.test(A.root.innerHTML) && />Приор\.<span class="tk-arr tk-arr-off"/.test(A.root.innerHTML), st1.join('|'));
    await A.click('sortBy', (d) => d.key === 'status');
    check('V6-1 R-17 «Статус» ↓: закрытая первой', rowTitles(A)[0].indexOf('s2') > 0 && A.S.sort.dir === 'desc');
    await A.click('sortBy', (d) => d.key === 'priority');
    check('V6-1 R-17 переключение на другую колонку начинает с ↑ (одна активная сортировка)', A.S.sort.key === 'priority' && A.S.sort.dir === 'asc');
    await A.click('setView', (d) => d.view === 'board');
    await A.click('setView', (d) => d.view === 'list');
    check('V6-1 R-17 состояние сортировки держится в S при смене вида (до перезагрузки), а «Сбросить» сбрасывает только фильтры',
      A.S.sort.key === 'priority' && (await A.click('resetFilters'), A.S.sort.key === 'priority' && A.S.filters.emp === ''));
    await A.click('sortBy', (d) => d.key === 'priority'); await A.click('sortBy', (d) => d.key === 'priority');   // ↓ → выкл

    // R-5: оформление шапки и зебры (CSS-текст из модуля + контраст)
    const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const thCss = /\.tk-table th\{([^}]*)\}/.exec(SRC)[1];
    const thBg = /background:(#[0-9a-f]{6})/i.exec(thCss)[1], thFg = /;color:(#[0-9a-f]{6})/i.exec(thCss)[1];
    const zebra = /\.tk-table tbody tr:nth-child\(even\)\{background:(#[0-9a-f]{6})\}/i.exec(SRC);
    check('V6-1 R-5 шапка: жирная, с фоном, явной нижней границей, sticky; контраст текста ≥ 4.5:1',
      /font-weight:700/.test(thCss) && /position:sticky;top:0/.test(thCss) && /border-bottom:2px solid/.test(thCss) && contrast(thBg, thFg) >= 4.5, thBg + ' ' + thFg + ' ' + contrast(thBg, thFg).toFixed(2));
    check('V6-1 R-5 зебра строк (чётные строки), контраст текста строки (#1A2B49) на зебре ≥ 4.5:1; sticky работает: у .tk-tablewrap есть max-height (своя прокрутка)',
      zebra && contrast(zebra[1], '#1A2B49') >= 4.5 && /\.tk-tablewrap\{[^}]*max-height:/.test(SRC), zebra && zebra[1]);

    // R-12 / R-13: клик по метке, приоритету, статусу (плитка Доски и карточка)
    await A.click('resetFilters');
    await A.filter('emp', 'v61_a');
    await A.click('setView', (d) => d.view === 'board');
    check('V6-1 R-12/13 плитка Доски: метка, приоритет и статус — кликабельные теги (filterBy), метка экранирована',
      A.has('data-f="label" data-v="' + A.T.__t.esc(LABEL) + '"') && A.has('data-f="priority" data-v="1"') && A.has('data-f="status" data-v="open"') && A.has('role="button"'));
    await A.click('filterBy', (d) => d.f === 'label');
    check('V6-1 R-12 клик по метке плитки → «Список», фильтры сброшены, filters.label = метка (спецсимволы целы), строка этой метки видна',
      A.S.view === 'list' && A.S.filters.label === LABEL && !A.S.filters.emp && !A.S.filters.priority && !A.S.filters.status && !A.S.filters.due && A.has('V61 Отпуск и больничный') && !A.has('V61 Здоровый'), JSON.stringify(A.S.filters));
    await A.T.open({ view: 'board', taskId: vY.id });
    await A.settle();
    check('V6-1 R-12/13 карточка .tk-detail: те же теги (метка, приоритет, статус) кликабельны',
      /<aside class="tk-detail">[\s\S]*data-f="status"[\s\S]*data-f="priority" data-v="3"[\s\S]*data-f="label" data-v="v61b"/.test(A.root.innerHTML));
    A.S.filters.priority = '2'; A.S.filters.status = 'closed';   // «грязные» фильтры: клик должен их сбросить
    await A.click('filterBy', (d) => d.f === 'priority' && d.v === '3' && A.root.innerHTML.indexOf('class="tk-detail"') >= 0);
    check('V6-1 R-13 клик по приоритету в карточке → «Список», filters.priority = 3, остальные сброшены (и «грязный» status тоже)',
      A.S.view === 'list' && A.S.filters.priority === '3' && A.S.filters.status === '' && A.S.filters.label === '' && A.has('V61 Здоровый') && !A.has('V61 Отпуск и больничный'), JSON.stringify(A.S.filters));
    await A.T.open({ view: 'board', taskId: vS2.id });
    await A.settle();
    await A.click('filterBy', (d) => d.f === 'status' && d.v === 'closed');
    check('V6-1 R-13 клик по статусу «Закрыта» → «Список», filters.status = closed; закрытая видна, открытая — нет',
      A.S.view === 'list' && A.S.filters.status === 'closed' && A.has('V61 s2 высокий закрыт') && !A.has('V61 s1 обычный открыт'), JSON.stringify(A.S.filters));
    A.T.__t.ACTIONS.filterBy({ dataset: { f: 'emp', v: 'x' } });
    check('V6-1 R-12 filterBy принимает только label/priority/status (чужие поля игнорируются)', A.S.filters.emp === '' && A.S.filters.status === 'closed');
    // клавиатура: Enter/Space на теге = клик
    await A.click('resetFilters');
    await A.T.open({ view: 'board', taskId: vS1.id });
    await A.settle();
    const kt = A.findTag('data-tk-act', 'filterBy', (d) => d.f === 'priority');
    const ktEl = { dataset: kt.dataset, closest() { return ktEl; } };
    A.root.fire('keydown', { key: 'Enter', target: ktEl, preventDefault() {} });
    await A.settle();
    check('V6-1 R-13 тег доступен с клавиатуры (Enter) — то же действие', A.S.view === 'list' && A.S.filters.priority === '2', JSON.stringify(A.S.filters));

    // R-14: ФИО → «Список» (из Списка, Доски и карточки), остальные фильтры сброшены
    await A.T.open({ view: 'board', taskId: vX.id });
    await A.settle();
    A.S.filters.priority = '3'; A.S.filters.label = 'zzz';
    const insideDetail = /<aside class="tk-detail">[\s\S]*data-tk-act="filterEmp" data-emp="v61_a"/.test(A.root.innerHTML);
    await A.click('filterEmp', (d) => d.emp === 'v61_a');
    check('V6-1 R-14 клик по ФИО в карточке Доски → «Список», filters.emp = id, остальные фильтры сброшены, выбор карточки снят',
      insideDetail && A.S.view === 'list' && A.S.filters.emp === 'v61_a' && A.S.filters.priority === '' && A.S.filters.label === '' && A.S.selectedId === null && A.has('V61 Отпуск и больничный'), JSON.stringify(A.S.filters));
    A.S.filters.status = 'open'; A.T.__t.render();
    await A.click('filterEmp', (d) => d.emp === 'v61_a');
    check('V6-1 R-14 клик по ФИО в самом Списке: остаётся «Список», лишние фильтры сброшены', A.S.view === 'list' && A.S.filters.status === '' && A.S.filters.emp === 'v61_a');

    // V6-5 (P2-1): ФИО в плитке Доски — ссылка «Список по сотруднику» (span[role=button], внутри draggable-карточки)
    await A.click('resetFilters');
    await A.T.open({ view: 'board' });
    await A.settle();
    const v65TileOf = (id) => (A.root.innerHTML.split('<div class="tk-card').filter((r) => r.indexOf('data-id="' + id + '"') >= 0)[0] || '');
    const tileX = v65TileOf(vX.id);
    check('V6-5 P2-1 плитка Доски: ФИО — span[role=button].tk-name[data-tk-act=filterEmp][data-emp] (не <a>, не ломает draggable), есть title',
      /<div class="tk-sub"><span role="button" tabindex="0" class="tk-name tk-namebtn" data-tk-act="filterEmp" data-emp="v61_a" title="[^"]+">/.test(tileX) && tileX.indexOf('draggable="true"') >= 0 && tileX.indexOf('<a ') < 0, tileX.slice(0, 400));
    check('V6-5 P2-1 CSS: у .tk-namebtn курсор-указатель', /\.tk-namebtn\{cursor:pointer\}/.test(SRC));
    check('V6-5 P2-1 drag&drop плитки не затронут: draggable/data-tk-drag — на корне карточки, а не на ФИО',
      /draggable="true" data-tk-drag="/.test(tileX.split('<b>')[0]) && !/data-tk-drag/.test(tileX.split('<b>')[1]));
    await A.click('filterEmp', (d) => d.emp === 'v61_a');
    check('V6-5 P2-1 клик по ФИО в плитке Доски → «Список», ровно один фильтр (emp), карточка не открыта (selectedId пуст)',
      A.S.view === 'list' && A.S.filters.emp === 'v61_a' && !A.S.filters.status && !A.S.filters.priority && !A.S.filters.label && !A.S.filters.due && A.S.selectedId === null, JSON.stringify(A.S.filters));
    // клавиатура: Enter на ФИО-кнопке = клик
    await A.T.open({ view: 'board' });
    await A.settle();
    const nmEl = { dataset: { tkAct: 'filterEmp', emp: 'v61_b' } }; nmEl.closest = () => nmEl;
    A.root.fire('keydown', { key: 'Enter', target: { closest: (sel) => (/tk-namebtn/.test(sel) ? nmEl : null) }, preventDefault() {} });
    await A.settle();
    check('V6-5 P2-1 ФИО-кнопка доступна с клавиатуры (Enter) — то же действие', A.S.view === 'list' && A.S.filters.emp === 'v61_b', JSON.stringify(A.S.filters));

    // R-7 + R-15: карточка с отпуском
    await A.click('resetFilters');
    await A.T.open({ view: 'board', taskId: vX.id });
    await A.settle();
    const det = A.root.innerHTML.slice(A.root.innerHTML.indexOf('<aside class="tk-detail">'));
    const vacLis = det.match(/<li class="tk-note-vac"[^>]*>[\s\S]*?<\/li>/g) || [];
    check('V6-1 R-7 в «Пометках» строки vacation/day_off — плашки .tk-note-vac (3 отпуска + 1 отгул); праздники/выходные — обычные <li> без плашки',
      vacLis.length === 4 && /data-tk-note="day_off"/.test(vacLis.join('')) && (det.match(/<li>/g) || []).length >= 2 && !/<li class="tk-note-vac"[^>]*>[^<]*(выходной|праздник)/.test(det), vacLis.length + ' ' + ((det.match(/<li>/g) || []).length));
    const vacCss = /\.tk-notes li\.tk-note-vac\{([^}]*)\}/.exec(SRC)[1];
    check('V6-1 R-7 CSS плашки: яркий оранжевый (#ff8a00) + repeating-linear-gradient(45deg, мелкая бледная штриховка ≤ 5px шаг); контраст текста ≥ 4.5:1',
      (() => { const g = /repeating-linear-gradient\(45deg,rgba\(255,255,255,(\.\d+)\) 0,rgba\(255,255,255,\.\d+\) ([\d.]+)px,rgba\(255,255,255,0\) [\d.]+px,rgba\(255,255,255,0\) ([\d.]+)px\)/.exec(vacCss); return !!g && +g[1] <= 0.4 && +g[3] <= 5; })() && /#ff8a00/i.test(vacCss) &&
      contrast('#ff8a00', '#1a2b49') >= 4.5, contrast('#ff8a00', '#1a2b49').toFixed(2));
    const openLink = A.findTag('data-tk-act', 'openMatrix', null, vacLis[0]);
    check('V6-1 R-15 ФИО в пометке отпуска — ссылка openMatrix с id сотрудника и датой пометки',
      openLink && openLink.dataset.emp === 'v61_a' && openLink.dataset.date === '2099-12-02' && /<a [^>]*>Отпускник Тестович<\/a>/.test(vacLis[0]), vacLis[0]);
    const dayOffLink = A.findTag('data-tk-act', 'openMatrix', (d) => d.date === '2099-12-08');
    check('V6-1 R-15 у отгула ссылка тоже есть (дата отгула)', !!dayOffLink && dayOffLink.dataset.emp === 'v61_a');
    await A.click('openMatrix', (d) => d.date === '2099-12-03');
    check('V6-1 R-15 клик → window.openMatrixAt({employeeId, date}) вызван ровно один раз с id сотрудника и датой пометки',
      hasMatrixCalls.length === 1 && hasMatrixCalls[0].employeeId === 'v61_a' && hasMatrixCalls[0].date === '2099-12-03', JSON.stringify(hasMatrixCalls));
    // имя сотрудника с HTML — экранировано в пометке и в «!»
    const vZ = await mkV('V61 html-имя', { assignees: ['v61_x'] });
    const dbq = sdb();
    dbq.prepare("INSERT OR REPLACE INTO schedule_entries (employee_id, date, status, comment, approval_status, updated_at, version) VALUES ('v61_x', '2099-12-05', 'vacation', NULL, 'draft', '2099-01-01', 1)").run();
    dbq.close();
    await A.T.open({ view: 'board', taskId: vZ.id });
    await A.settle();
    check('V6-1 R-7/R-15 имя сотрудника с HTML в пометке экранировано (нет сырого <b>Тегович</b>)',
      A.has('Взлом &lt;b&gt;Тегович&lt;/b&gt;') && !A.has('<b>Тегович</b>'));
    // неопознанный сотрудник (нет в справочнике) — без ссылки
    A.S.tasks = A.S.tasks.map((t) => t.id === vZ.id ? Object.assign({}, t, { notes: [{ date: '2099-12-05', employee_id: 'ghost_1', kind: 'vacation', label: null }] }) : t);
    A.T.__t.render();
    check('V6-1 R-15 сотрудник не найден в справочнике → плашка без ссылки (нет «мёртвого» клика)', A.has('tk-note-vac') && !A.has('data-tk-act="openMatrix"'));
    // экспорт openMatrixAt в index.html — одна вставка, ищет строку по id (не по индексу), без правок стилей матрицы
    check('V6-1 R-15 index.html: ровно одно определение window.openMatrixAt; строка ищется по [data-emp-id]/[data-emp], не по индексу',
      (INDEX.match(/window\.openMatrixAt\s*=/g) || []).length === 1 && /\.name-col\[data-emp-id="' \+ empKey/.test(INDEX) && !/rows\[\s*\w+\s*\]/.test(INDEX.slice(INDEX.indexOf('window.openMatrixAt ='), INDEX.indexOf('return { year: year, row: row, cell: cell }'))));

    // R-4: Доска — три колонки равной ширины
    await A.click('setView', (d) => d.view === 'board');
    const bh = A.root.innerHTML;
    check('V6-1 R-4 Доска: сетка tk-split-board, внутри колонки Открыта, Закрыта и карточка .tk-detail (3 элемента на одном уровне сетки)',
      /class="tk-split tk-split-board"/.test(bh) && /data-tk-col="open"/.test(bh) && /data-tk-col="closed"/.test(bh) && /<aside class="tk-detail">/.test(bh));
    check('V6-1 R-4 CSS: 3 равные колонки repeat(3,minmax(0,1fr)), «Без исполнителя» на всю ширину (grid-column:1/-1), ≤760px — одна колонка',
      /\.tk-split-board\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(SRC) && /\.tk-split-board \.tk-sec\{grid-column:1\/-1/.test(SRC) &&
      /@media \(max-width:760px\)\{\.tk-split-board\{grid-template-columns:minmax\(0,1fr\)\}/.test(SRC));
    check('V6-1 R-4 Календарь не затронут: renderCalendar по-прежнему на .tk-split (flex), без tk-split-board',
      !/renderCalendar[\s\S]{0,2500}tk-split-board/.test(SRC.slice(SRC.indexOf('function renderCalendar'), SRC.indexOf('function renderDetail'))));

    // =====================================================================================================
    // V6.2-1: W-1 колонки Списка, W-2 «Править» в строке, W-3 Доска ≤ 2 исполнителей, W-4 метки-теги
    // =====================================================================================================
    const MORE_HTML = ' <span class="tk-more">…</span>', MORE_RE = /<span class="tk-more">…<\/span>/;
    let V63ID = null;
    console.log('-- V6.2-1 W-1…W-4');
    await A.T.open({ view: 'list' });
    await A.settle();
    await A.click('resetFilters');
    {
      const esc2 = A.T.__t.esc;
      const nameOf = (id) => (A.S.employees.find((e) => e.id === id) || {}).name;
      const mkW = async (title, extra) => mkV(title, Object.assign({ start_at: '2099-11-20', end_at: null }, extra || {}));
      const w3 = await mkW('W62 три исполнителя', { assignees: ['v61_a', 'v61_b', 'v61_s'], label: 'Alpha, beta' });
      const w2 = await mkW('W62 два исполнителя', { assignees: ['v61_a', 'v61_b'], label: 'beta,  Gamma ,alpha' });
      const w4 = await mkW('W62 четыре исполнителя', { assignees: ['v61_a', 'v61_b', 'v61_s', 'v61_x'] });
      const w1 = await mkW('W62 один исполнитель', { assignees: ['v61_s'] });
      const wx = await mkW('W62 тег <i>x</i>', { assignees: ['v61_s'], label: 'тег <i>x</i> & "q"' });
      // старое значение «a,b» (как на проде: 2 задачи с запятой) — без миграции показывается несколькими тегами
      const dbl = sdb();
      dbl.prepare('UPDATE tasks SET label = ? WHERE id = ?').run('старый,тег 2', w1.id);
      dbl.close();
      await A.T.open({ view: 'list' });
      await A.settle();
      const rowOf = (id) => { const m = new RegExp('<tr class="tk-row[^>]*data-id="' + id + '"[\\s\\S]*?</tr>').exec(A.root.innerHTML); return m ? m[0] : ''; };
      const cellsOf = (row) => row.split('</td>').slice(0, -1);

      // ---- W-1 ----
      const hdrW = /<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(A.root.innerHTML)[1];
      const thTexts = (hdrW.match(/<th[^>]*>[\s\S]*?<\/th>/g) || []).map((x) => x.replace(/<span class="tk-arr[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '').trim());
      check('V6.2 W-1 порядок колонок: Задача · Описание · Исполнитель · Срок · Приор. · Статус · (Править)', thTexts.join('|') === 'Задача|Описание|Исполнитель|Срок|Приор.|Статус|Править', thTexts.join('|'));
      const r3 = rowOf(w3.id), c3 = cellsOf(r3);
      check('V6.2 W-1 строка: 7 ячеек — задача, описание, исполнитель (V6.3-1: 2 ФИО из 3 + «…», фильтр-ссылки сохранены), срок, приоритет, статус, ✎',
        c3.length === 7 && /class="tk-c-task"/.test(c3[0]) && /class="tk-desc"/.test(c3[1]) && /class="tk-c-exec"/.test(c3[2]) && (c3[2].match(/data-tk-act="filterEmp"/g) || []).length === 2 &&
        /class="tk-c-edit"/.test(c3[6]) && /Открыта/.test(c3[5]), c3.map((x) => x.slice(0, 50)).join(' | '));
      const wRule = /\.tk-table-v62 th\.tk-c-exec,\.tk-table-v62 td\.tk-c-exec\{width:(\d+)px;min-width:(\d+)px;max-width:(\d+)px;overflow-wrap:anywhere\}/.exec(SRC);
      check('V6.2 W-1 → V6.3-1 И-2: ширина «Исполнителя» зафиксирована (width = min = max), ФИО переносятся (overflow-wrap:anywhere); значение 192 px = 128 × 1,5',
        wRule && wRule[1] === wRule[2] && wRule[2] === wRule[3] && +wRule[1] === 192 && +wRule[1] / 128 === 1.5, wRule && wRule[0]);
      check('V6.2 W-1 «Описание» забирает освободившееся: у .tk-desc в таблице нет max-width, min-width ≥ 220px', /\.tk-table-v62 td\.tk-desc\{min-width:2\d\dpx;max-width:none\}/.test(SRC));
      check('V6.2 W-1 «Приор.» и «Статус» по-прежнему сортируются, шапка sticky (th position:sticky), таблица в .tk-tablewrap (горизонтальная прокрутка на 375)',
        A.has('data-tk-act="sortBy" data-key="priority"') && A.has('data-tk-act="sortBy" data-key="status"') && /\.tk-table th\{position:sticky;top:0/.test(SRC) && /\.tk-tablewrap\{overflow:auto/.test(SRC) && A.has('class="tk-tablewrap"'));

      // ---- W-2 ----
      const nRows = A.count('<tr class="tk-row');
      check('V6.2 W-2 admin: в каждой строке кнопка ✎ (title «Править», aria-label, type=button), в шапке — колонка с доступным именем «Править»',
        nRows >= 5 && A.count('class="tk-editbtn"') === nRows && /<button type="button" class="tk-editbtn" data-tk-act="editTask" data-id="[^"]+" title="Править" aria-label="Править задачу «[^"]*»">✎<\/button>/.test(r3) &&
        /<th class="tk-c-edit"><span class="tk-sr">Править<\/span><\/th>/.test(A.root.innerHTML), nRows + ' ' + A.count('tk-editbtn'));
      check('V6.2 W-2 в строке задачи с тегом <i> aria-label экранирован', /aria-label="Править задачу «W62 тег &lt;i&gt;x&lt;\/i&gt;»"/.test(rowOf(wx.id)));
      let stopped = 0;
      const rowEl = { dataset: { tkAct: 'openTask', id: w3.id, view: 'board' } };
      const btnEl = { dataset: { tkAct: 'editTask', id: w3.id } };
      A.root.fire('click', { target: { closest: () => btnEl }, stopPropagation() { stopped++; }, preventDefault() {} });
      await A.settle();
      check('V6.2 W-2 клик по ✎: сразу форма правки ЭТОЙ задачи (тот же путь, что «Править» в карточке), карточка не открыта, остались в «Списке», stopPropagation вызван',
        A.S.form && A.S.form.id === w3.id && A.has('Редактирование задачи') && A.S.view === 'list' && A.S.selectedId !== w3.id && !A.has('class="tk-detail"') && stopped === 1 && A.S.form.draft.title === 'W62 три исполнителя', JSON.stringify({ form: A.S.form && A.S.form.id, view: A.S.view, sel: A.S.selectedId, stopped }));
      check('V6.2 W-2 в форме правки теги задачи — чипами, а не строкой: «Alpha», «beta»', A.S.form.draft.labels.join('|') === 'Alpha|beta' && A.count('class="tk-chip tk-tagchip"') === 2);
      await A.click('cancelForm');
      check('V6.2 W-2 «Отмена» возвращает в «Список» (строка на месте)', A.S.form === null && A.S.view === 'list' && A.has('W62 три исполнителя'));
      await A.click('openTask', (d) => d.id === w3.id);
      check('V6.2 W-2 клик по строке (не по ✎) — как раньше: открывается карточка (Доска + .tk-detail)', A.S.view === 'board' && A.S.selectedId === w3.id && A.has('class="tk-detail"'));
      check('V6.2 W-2 «Править» в карточке и ✎ — одна и та же функция (ACTIONS.editTask)', A.findTag('data-tk-act', 'editTask', (d) => d.id === w3.id) && typeof A.T.__t.ACTIONS.editTask === 'function' && (SRC.match(/data-tk-act="editTask"/g) || []).length === 2);
      await A.T.open({ view: 'list' }); await A.settle();
      // ✎ → правка → сохранение → строка обновилась, клавиатура: у <button> Enter/Space = click (нативно), tabindex не нужен
      await A.click('editTask', (d) => d.id === w1.id);
      await A.field('title', 'W62 один исполнитель (правка)');
      await A.click('saveForm');
      check('V6.2 W-2 ✎ → правка названия → «Сохранить»: форма закрыта, в Списке новое название, сервер сохранил',
        A.S.form === null && A.S.view === 'list' && A.has('W62 один исполнитель (правка)') && (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + w1.id)).json.task.title === 'W62 один исполнитель (правка)');
      check('V6.2 W-2 правка через ✎ старого значения «старый,тег 2» не потеряла теги (оба в форме и на сервере — «старый, тег 2»)',
        (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + w1.id)).json.task.label === 'старый, тег 2');

      // ---- W-3 ----
      await A.T.open({ view: 'board' }); await A.settle();
      const tile = (id) => (A.root.innerHTML.split('<div class="tk-card').filter((r) => r.indexOf('data-id="' + id + '"') >= 0)[0] || '');
      const sub = (id) => (/<div class="tk-sub"([^>]*)>([\s\S]*?)<\/div>/.exec(tile(id)) || [])[0] || '';
      const n3 = A.S.tasks.find((t) => t.id === w3.id).assignees.map((x) => x.full_name || nameOf(x.employee_id));   // порядок — как в ответе API
      check('V6.2 W-3 (данные) у тестовой задачи 3 исполнителя', n3.length === 3 && n3.every(Boolean), n3.join(','));
      const s3 = sub(w3.id);
      const names3 = (s3.match(/class="tk-name tk-namebtn" data-tk-act="filterEmp" data-emp="([^"]+)"/g) || []);
      check('V6.2 W-3 Доска, 3 исполнителя: в подстроке ровно 2 ФИО-кнопки и «…» после второго; третьего ФИО в тексте нет',
        names3.length === 2 && MORE_RE.test(s3) && s3.indexOf(MORE_HTML) > s3.lastIndexOf('data-tk-act="filterEmp"') && s3.indexOf(n3[2] + '</span>') < 0, s3);
      const ttl = unescTitle((/title="(Исполнители: [^"]*)"/.exec(s3) || [])[1] || '');
      check('V6.2 W-3 полный список ФИО — в title подстроки («Исполнители: A, B, C»)', ttl === 'Исполнители: ' + n3.join(', '), ttl);
      const s4 = sub(w4.id);
      check('V6.2 W-3 4 исполнителя: 2 ФИО + «…», в title — все 4', (s4.match(/data-tk-act="filterEmp"/g) || []).length === 2 && s4.indexOf(MORE_HTML) > 0 && (unescTitle((/title="(Исполнители: [^"]*)"/.exec(s4) || [])[1] || '').split(', ').length === 4), s4);
      const s2 = sub(w2.id);
      check('V6.2 W-3 2 исполнителя: оба ФИО, без «…» и без общего title', (s2.match(/data-tk-act="filterEmp"/g) || []).length === 2 && s2.indexOf('…') < 0 && !/<div class="tk-sub" title=/.test(s2), s2);
      const s1 = sub(w1.id);
      check('V6.2 W-3 1 исполнитель: без «…»', (s1.match(/data-tk-act="filterEmp"/g) || []).length === 1 && s1.indexOf('…') < 0, s1);
      // удалённый среди первых двух — зачёркнут, считается в лимите
      const keepW = A.S.tasks;
      const t3 = A.S.tasks.find((t) => t.id === w3.id);
      A.S.tasks = A.S.tasks.map((t) => t.id !== w3.id ? t : Object.assign({}, t, { assignees: [{ employee_id: 'v61_a', full_name: 'Удалённый Икс', removed: true, removed_at: null }].concat(t.assignees.filter((a) => a.employee_id !== 'v61_a')) }));
      A.T.__t.render();
      const s3r = sub(w3.id);
      check('V6.2 W-3 удалённый исполнитель среди первых двух — зачёркнут (<s class="tk-gone">), «…» и title на месте, живой — кнопка', /<s class="tk-gone" title="Сотрудник удалён">Удалённый Икс<\/s>/.test(s3r) && (s3r.match(/data-tk-act="filterEmp"/g) || []).length === 1 && s3r.indexOf(MORE_HTML) > 0 && /title="Исполнители: Удалённый Икс, /.test(s3r), s3r);
      A.S.tasks = keepW; A.T.__t.render();
      await A.click('filterEmp', (d) => d.emp === 'v61_a');
      check('V6.2 W-3 первое ФИО из плитки по-прежнему кликабельно (V6-5): → «Список» по сотруднику', A.S.view === 'list' && A.S.filters.emp === 'v61_a' && !A.S.filters.label && A.has('W62 три исполнителя'));
      const lr = rowOf(w3.id);
      check('V6.2 W-3 → V6.3-1 И-1: Список — 2 из 3 исполнителей + «…» (третьего в строке нет; полный перечень — в карточке)', n3.slice(0, 2).every((n) => lr.indexOf(esc2(n)) >= 0) && lr.replace(/ title="[^"]*"/g, '').indexOf(esc2(n3[2])) < 0 && lr.indexOf(MORE_HTML) > 0, lr.slice(0, 300));
      V63ID = w3.id;
      await A.T.open({ view: 'board', taskId: w3.id }); await A.settle();
      const detW = A.root.innerHTML.slice(A.root.innerHTML.indexOf('<aside class="tk-detail">'));
      check('V6.2 W-3 карточка задачи — без изменений: «Исполнители» — все 3, без «…»', /<span>Исполнители<\/span><div>[\s\S]*?<\/div>/.test(detW) && n3.every((n) => /<span>Исполнители<\/span><div>[\s\S]*?<\/div>/.exec(detW)[0].indexOf(esc2(n)) >= 0) && !/<span>Исполнители<\/span><div>[^]*?…/.test(/<span>Исполнители<\/span><div>[\s\S]*?<\/div>/.exec(detW)[0]));

      // ---- V6.3-1 (И-1, И-2): Список — не больше 2 исполнителей + «…», пропорция колонок ----
      console.log('-- V6.3-1 И-1/И-2');
      {
        const extraEmp = A.S.employees.map((e) => e.id).find((id) => ['v61_a', 'v61_b', 'v61_s', 'v61_x'].indexOf(id) < 0);
        const q5 = await mkW('V63 пять исполнителей', { assignees: ['v61_s', 'v61_b', 'v61_a', 'v61_x', extraEmp] });
        const q3v = await mkV('V63 три исполнителя, первый в отпуске', { assignees: ['v61_a', 'v61_b', 'v61_s'], start_at: '2099-12-01', end_at: '2099-12-05' });   // v61_a — отпуск 02–04.12 (R-8)
        await A.T.open({ view: 'list' }); await A.settle(); await A.click('resetFilters');
        const execCell = (id) => { const c = cellsOf(rowOf(id)); return c.length > 2 ? c[2] : ''; };
        const namesFull = (id) => A.S.tasks.find((t) => t.id === id).assignees.map((x) => x.full_name || nameOf(x.employee_id));
        const fio = (cell) => (cell.match(/data-tk-act="filterEmp"/g) || []).length;
        const noTitle = (cell) => cell.replace(/ title="[^"]*"/g, '');
        const ttlOf = (cell) => unescTitle((/<td class="tk-c-exec" title="([^"]*)"/.exec(cell) || [])[1] || '');
        const c1 = execCell(w1.id), c2 = execCell(w2.id), c3n = execCell(w3.id), c5 = execCell(q5.id);
        check('V6.3-1 И-1 Список, 1 исполнитель: 1 ФИО, без «…», без общего title', fio(c1) === 1 && !MORE_RE.test(c1) && !/<td class="tk-c-exec" title=/.test(c1), c1);
        check('V6.3-1 И-1 Список, 2 исполнителя: оба ФИО, без «…», без общего title', fio(c2) === 2 && !MORE_RE.test(c2) && !/<td class="tk-c-exec" title=/.test(c2) && namesFull(w2.id).every((n) => c2.indexOf(esc2(n)) >= 0), c2);
        const n5 = namesFull(q5.id);
        check('V6.3-1 И-1 Список, 3 исполнителя: 2 ФИО-ссылки + «…» после второго, третьего ФИО в ячейке нет', fio(c3n) === 2 && MORE_RE.test(c3n) && c3n.indexOf(MORE_HTML) > c3n.lastIndexOf('data-tk-act="filterEmp"') && noTitle(c3n).indexOf(esc2(n3[2])) < 0, c3n);
        check('V6.3-1 И-1 Список, 5 исполнителей: 2 ФИО-ссылки + «…»; ФИО с 3-го по 5-й в тексте ячейки нет', n5.length === 5 && fio(c5) === 2 && (c5.match(MORE_RE) || []).length === 1 && n5.slice(2).every((n) => noTitle(c5).indexOf(esc2(n)) < 0), c5);
        check('V6.3-1 И-1 title ячейки при 3 и 5 исполнителях — полный список «Исполнители: A, B, …» (в порядке API)', ttlOf(c3n) === 'Исполнители: ' + n3.join(', ') && ttlOf(c5) === 'Исполнители: ' + n5.join(', '), ttlOf(c3n) + ' | ' + ttlOf(c5));
        check('V6.3-1 И-1 title с ФИО <b> экранирован (нет сырых тегов)', (() => { const x = execCell((A.S.tasks.find((t) => t.assignees.some((a) => a.employee_id === 'v61_x')) || {}).id); return x.indexOf('<b>Тегович') < 0; })() && c5.indexOf('<b>Тегович') < 0 && c5.indexOf('&lt;b&gt;Тегович') >= 0);
        check('V6.3-1 И-1 «…» — отдельный элемент .tk-more после пробела (не часть ссылки-ФИО), в ссылках «…» нет', c5.indexOf(', ') > 0 && /<\/a>(<span class="tk-warnico"[^>]*>!<\/span>)? <span class="tk-more">…<\/span>/.test(c5) && !/<a [^>]*>[^<]*…[^<]*<\/a>/.test(c5) && /\.tk-more\{[^}]*padding:0 6px/.test(SRC) && /\.tk-more\{[^}]*background:#[0-9a-f]+/.test(SRC));
        // первые два ФИО кликабельны (R-14), «!» (R-8) и зачёркивание удалённых (T1-8) сохраняются
        const cv = execCell(q3v.id);
        check('V6.3-1 И-1 «!» (R-8) у ФИО в отпуске (среди первых двух) сохранён при 3 исполнителях', fio(cv) === 2 && (cv.match(/class="tk-warnico"/g) || []).length === 1 && /data-emp="v61_a">[^<]*<\/a><span class="tk-warnico"/.test(cv) && cv.indexOf('class="tk-warnico"') < cv.indexOf(MORE_HTML) && MORE_RE.test(cv), cv);
        const keepL = A.S.tasks;
        A.S.tasks = A.S.tasks.map((t) => t.id !== w3.id ? t : Object.assign({}, t, { assignees: [{ employee_id: 'v61_a', full_name: 'Удалённый Икс', removed: true, removed_at: null }].concat(t.assignees.filter((a) => a.employee_id !== 'v61_a')) }));
        A.T.__t.render();
        const cr = execCell(w3.id);
        check('V6.3-1 И-1 удалённый среди первых двух — зачёркнут (<s class="tk-gone">), считается в лимите: 1 ссылка + «…», title — все 3', /<s class="tk-gone" title="Сотрудник удалён">Удалённый Икс<\/s>/.test(cr) && fio(cr) === 1 && MORE_RE.test(cr) && /title="Исполнители: Удалённый Икс, /.test(cr), cr);
        A.S.tasks = keepL; A.T.__t.render();
        await A.click('filterEmp', (d) => d.emp === 'v61_b');
        check('V6.3-1 И-1 клик по ФИО в ячейке Списка → «Список» с фильтром по этому сотруднику (R-14)', A.S.view === 'list' && A.S.filters.emp === 'v61_b' && A.has('W62 три исполнителя'));
        await A.click('resetFilters');
        // карточка — все исполнители, без «…»
        await A.T.open({ view: 'board', taskId: q5.id }); await A.settle();
        const det5 = A.root.innerHTML.slice(A.root.innerHTML.indexOf('<aside class="tk-detail">'));
        const kv5 = /<span>Исполнители<\/span><div>[\s\S]*?<\/div>/.exec(det5)[0];
        check('V6.3-1 И-1 карточка задачи — все 5 исполнителей, без «…» и без title-списка', n5.every((n) => kv5.indexOf(esc2(n)) >= 0) && kv5.indexOf('…') < 0 && kv5.indexOf('tk-more') < 0, kv5.slice(0, 200));
        // Доска и Список — общий код
        check('V6.3-1 И-1 общий код: одна функция limitNames (slice по BOARD_NAMES_MAX) используется и Доской (nameStrike), и Списком (nameLinks); отдельной копии нет',
          (SRC.match(/\.slice\(0, BOARD_NAMES_MAX\)/g) || []).length === 1 && /function nameStrike\(t\) \{[^]*?return limitNames\(t,/.test(SRC) && /return limit \? limitNames\(t, one\)/.test(SRC) && (SRC.match(/NAMES_MORE_HTML/g) || []).length === 2);
        await A.T.open({ view: 'board' }); await A.settle();
        const b5 = sub(q5.id);
        check('V6.3-1 И-1 Доска: «…» — тот же отдельный чип .tk-more после пробела, title — все 5', fio(b5) === 2 && b5.indexOf('</span>' + MORE_HTML) > 0 && unescTitle((/title="(Исполнители: [^"]*)"/.exec(b5) || [])[1] || '') === 'Исполнители: ' + n5.join(', '), b5);

        // ---- И-2: ширины колонок Списка (CSS-правила; замеры в Chromium — scripts/v63_1_accept.js) ----
        const execRule = /\.tk-table-v62 th\.tk-c-exec,\.tk-table-v62 td\.tk-c-exec\{width:(\d+)px;min-width:(\d+)px;max-width:(\d+)px;/.exec(SRC);
        const taskRule = /@media \(min-width:1200px\)\{\.tk-table-v62 th\.tk-c-task,\.tk-table-v62 td\.tk-c-task\{width:(\d+)px\}\}/.exec(SRC);
        const descRule = /\.tk-table-v62 td\.tk-desc\{min-width:(\d+)px;max-width:none\}/.exec(SRC);
        const editRule = /\.tk-table-v62 th\.tk-c-edit,\.tk-table-v62 td\.tk-c-edit\{width:(\d+)px/.exec(SRC);
        check('V6.3-1 И-2 «Исполнитель» = прежняя ширина × 1,5: 128 → 192 px (width = min = max)', execRule && +execRule[1] === 192 && execRule[1] === execRule[2] && execRule[2] === execRule[3] && 192 === 128 * 1.5, execRule && execRule[0]);
        // 1280: таблица 1075 px, фикс. колонки Срок 244 / Приор. 87 / Статус 83 / Править 44 не менялись (автоширина по содержимому), «Задача» закреплена
        const TABLE = 1075.4, FIXED_OTHER = 243.9 + 86.8 + 82.6 + 44;
        const descBefore = TABLE - 193 - 128 - FIXED_OTHER, descAfter = TABLE - (taskRule ? +taskRule[1] : 0) - (execRule ? +execRule[1] : 0) - FIXED_OTHER;
        check('V6.3-1 И-2 доли на 1280: «Описание» отдаёт ровно прибавку «Исполнителя» (' + descBefore.toFixed(1) + ' → ' + descAfter.toFixed(1) + ' px ≈ 297 → 233), общая ширина таблицы не меняется (Задача + Описание + Исполнитель = const)',
          taskRule && +taskRule[1] === 193 && Math.abs((descBefore - descAfter) - 64) < 0.01 && Math.abs(descBefore - 297.1) < 1 && Math.abs(descAfter - 233.1) < 1, taskRule && taskRule[0]);
        check('V6.3-1 И-2 «Описание» по-прежнему без max-width, min-width ≥ 220 (233 ≥ 220); у «Описания» нет своей фиксированной ширины (остаток таблицы)', descRule && +descRule[1] >= 220 && +descRule[1] <= 233 && !/tk-c-desc\{[^}]*width:\d+px/.test(SRC) && !/\.tk-table-v62 td\.tk-desc\{[^}]*[^-]width:\d+px/.test(SRC));
        check('V6.3-1 И-2 прочие колонки не тронуты: «Править» 44 px, правило «Задача» только ≥ 1200 px (на 375 — как раньше), шапка sticky и таблица в прокручиваемом .tk-tablewrap', editRule && +editRule[1] === 44 && /@media \(min-width:1200px\)/.test(SRC) && /\.tk-table th\{position:sticky;top:0/.test(SRC) && /\.tk-tablewrap\{overflow:auto/.test(SRC));
        check('V6.3-1 «Срок» Списка и карточка/форма/календарь не менялись: ячейка срока — прежняя (tk-nowrap + fmtPeriod)', /'<td class="tk-nowrap">' \+ esc\(fmtPeriod\(t\)\) \+ '<\/td>'/.test(SRC));
      }

      // ---- W-4: отображение ----
      await A.T.open({ view: 'list' }); await A.settle();
      await A.click('resetFilters');
      const lr3 = rowOf(w3.id);
      const chips3 = (lr3.match(/class="tk-tag tk-tagbtn tk-ltag"[^>]*>[^<]*<\/span>/g) || []);
      check('V6.2 W-4 Список: «Alpha, beta» — два отдельных кликабельных чипа (filterBy label), у каждого title «Показать в Списке…»',
        chips3.length === 2 && /data-f="label" data-v="Alpha"/.test(chips3[0]) && /data-f="label" data-v="beta"/.test(chips3[1]) && /title="Показать в Списке все задачи с меткой «Alpha»"/.test(chips3[0]), chips3.join(' '));
      const lw1 = rowOf(w1.id);
      check('V6.2 W-4 старое значение «старый,тег 2» (как на проде) — несколько тегов без миграции',
        (lw1.match(/data-f="label" data-v="[^"]+"/g) || []).join('|') === 'data-f="label" data-v="старый"|data-f="label" data-v="тег 2"', lw1.slice(0, 400));
      check('V6.2 W-4 тег с HTML экранирован в чипе и в data-v', rowOf(wx.id).indexOf('<i>x</i>') < 0 && /data-v="тег &lt;i&gt;x&lt;\/i&gt; &amp; &quot;q&quot;"/.test(rowOf(wx.id)));
      await A.T.open({ view: 'board' }); await A.settle();
      check('V6.2 W-4 Доска: теги плитки — отдельные кликабельные чипы', (tile(w2.id).match(/class="tk-tag tk-tagbtn tk-ltag"/g) || []).length === 3 && (tile(w3.id).match(/data-f="label"/g) || []).length === 2);
      await A.T.open({ view: 'board', taskId: w2.id }); await A.settle();
      const detW2 = A.root.innerHTML.slice(A.root.innerHTML.indexOf('<aside class="tk-detail">'));
      check('V6.2 W-4 карточка: теги — отдельные кликабельные чипы (3)', (detW2.match(/data-f="label" data-v="/g) || []).length === 3);
      await A.click('filterBy', (d) => d.f === 'label' && d.v === 'beta');
      const betaRows = (A.root.innerHTML.match(/<tr class="tk-row[^>]*data-id="[^"]+"/g) || []).map((x) => /data-id="([^"]+)"/.exec(x)[1]);
      check('V6.2 W-4 R-12: клик по тегу «beta» → «Список», ровно один фильтр label=beta; видны задачи, ГДЕ ЕСТЬ этот тег (2 из «Alpha, beta» и «beta, Gamma, alpha»), без других',
        A.S.view === 'list' && A.S.filters.label === 'beta' && !A.S.filters.emp && !A.S.filters.status && betaRows.length === 2 && betaRows.indexOf(w3.id) >= 0 && betaRows.indexOf(w2.id) >= 0, betaRows.length + ' ' + JSON.stringify(A.S.filters));
      await A.click('resetFilters');
      await A.filter('label', 'gamma');
      check('V6.2 W-4 фильтр совпадает без учёта регистра: «gamma» находит тег «Gamma»', A.has('W62 два исполнителя') && !A.has('W62 три исполнителя'));
      await A.click('resetFilters');
      const optsM = /<select data-tk-filter="label">([\s\S]*?)<\/select>/.exec(A.root.innerHTML)[1];
      const optVals = (optsM.match(/<option value="([^"]*)"/g) || []).map((x) => /value="([^"]*)"/.exec(x)[1]).filter(Boolean).map((x) => unescTitle(x));
      const sortedCopy = optVals.slice().sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
      check('V6.2 W-4 фильтр «Метка»: варианты — отдельные теги, уникальные (Alpha и alpha — один), по алфавиту; составных строк с запятой нет',
        optVals.length >= 6 && optVals.join('|') === sortedCopy.join('|') && optVals.every((o) => o.indexOf(',') < 0) && new Set(optVals.map((o) => o.toLowerCase())).size === optVals.length &&
        optVals.indexOf('Alpha') >= 0 && optVals.indexOf('alpha') < 0 && optVals.indexOf('Gamma') >= 0 && optVals.indexOf('старый') >= 0 && optVals.indexOf('тег 2') >= 0, optVals.join('|'));
      check('V6.2 W-4 labelsOf/splitTags — модульные: «a ,A,  b  c ,,» → [a, "b c"]', JSON.stringify(A.T.__t.splitTags('a ,A,  b  c ,,')) === JSON.stringify(['a', 'b c']));

      // ---- W-4: форма ----
      await A.click('newTask');
      const kb = async (k, v) => A.key('labelInput', k, v);
      const labs = () => A.S.form.draft.labels.join('|');
      check('V6.2 W-4 форма: поле «Метка» — контейнер тегов + input[list=tkLabels] (подсказки из существующих тегов), без старого input[data-tk-field=label]',
        A.has('data-tk-tagsbox="1"') && A.has('list="tkLabels"') && !A.findTag('data-tk-field', 'label') && A.count('<datalist id="tkLabels"><option') === 1 && A.has('<option value="Alpha">') && A.has('<option value="тег 2">') && !A.has('<option value="alpha">'));
      let e = await kb('Enter', 'первый');
      check('V6.2 W-4 Enter в поле → чип, ввод очищен, действие по умолчанию отменено', labs() === 'первый' && A.S.form.draft.labelInput === '' && e.prevented && A.count('class="tk-chip tk-tagchip"') === 1);
      e = await kb(',', 'второй');
      check('V6.2 W-4 запятая в поле → чип', labs() === 'первый|второй' && e.prevented && A.count('class="tk-chip tk-tagchip"') === 2);
      e = await kb('Enter', '  ПЕРВЫЙ ');
      check('V6.2 W-4 дубль без учёта регистра не добавляется, ввод очищается', labs() === 'первый|второй' && A.S.form.draft.labelInput === '');
      e = await kb('Enter', '   ');
      check('V6.2 W-4 Enter на пустом вводе ничего не делает', labs() === 'первый|второй');
      e = await kb('Backspace', 'ab');
      check('V6.2 W-4 Backspace в НЕпустом вводе — обычное редактирование (чипы целы, событие не отменено)', labs() === 'первый|второй' && !e.prevented);
      e = await kb('Backspace', '');
      check('V6.2 W-4 Backspace в пустом вводе удаляет последний чип', labs() === 'первый' && e.prevented && A.count('class="tk-chip tk-tagchip"') === 1);
      await A.input('labelInput', 'тег1, тег2, Тег3', { inputType: 'insertFromPaste' });
      check('V6.2 W-4 вставка строки с запятыми → несколько чипов (все три, ввод пуст)', labs() === 'первый|тег1|тег2|Тег3' && A.S.form.draft.labelInput === '');
      await A.input('labelInput', 'набран,');
      check('V6.2 W-4 набранная запятая (input) → чип «набран», хвост после запятой остаётся в поле', labs() === 'первый|тег1|тег2|Тег3|набран' && A.S.form.draft.labelInput === '');
      await A.input('labelInput', 'хв');
      check('V6.2 W-4 обычный ввод только обновляет черновик (без чипа)', labs() === 'первый|тег1|тег2|Тег3|набран' && A.S.form.draft.labelInput === 'хв');
      await A.click('removeTag', (d) => d.idx === '1');
      check('V6.2 W-4 × на чипе удаляет именно его (тег1), остальные на месте, введённый текст сохранён', labs() === 'первый|тег2|Тег3|набран' && A.S.form.draft.labelInput === 'хв' && !A.has('data-tk-tag="тег1"') && A.has('data-tk-tag="тег2"'));
      check('V6.2 W-4 у × есть title и aria-label', /data-tk-act="removeTag" data-idx="0" title="Убрать тег" aria-label="Убрать тег «первый»"/.test(A.root.innerHTML));
      await A.input('labelInput', 'Alpha', { inputType: 'insertReplacementText' });
      check('V6.2 W-4 выбор подсказки из datalist (insertReplacementText) → сразу чип', labs().split('|').indexOf('Alpha') === 4 && A.S.form.draft.labelInput === '', labs());
      await A.input('labelInput', 'Alpha', { inputType: 'insertText' });
      check('V6.2 W-4 ввод «Alpha» руками (insertText) в чип не превращается до Enter', A.S.form.draft.labelInput === 'Alpha' && labs().split('|').length === 5);
      await A.field('labelInput', '');
      const long31 = 'я'.repeat(31);
      e = await kb('Enter', long31);
      check('V6.2 W-4 тег длиннее 30 → понятная ошибка в форме, чип не добавлен, введённое не потеряно', A.has('длиннее 30 символов') && labs().split('|').length === 5 && A.S.form.draft.labelInput === long31, A.S.form.error);
      await A.field('labelInput', '');
      e = await kb('Enter', 'коротко');
      check('V6.2 W-4 после исправления ошибка тега снимается', !A.has('длиннее 30 символов') && labs().split('|').indexOf('коротко') === 5);
      // сохранить: чипы + «введённый, но не превращённый в чип» текст
      await A.click('cancelForm');
      await A.click('newTask');
      await A.field('title', 'W62 теги формы');
      await A.field('assigneePick', 'v61_s');
      await kb('Enter', 'один'); await kb(',', 'два'); await kb('Enter', 'Один');
      await A.field('labelInput', 'хвост-не-чип');
      check('V6.2 W-4 перед сохранением: чипы «один, два», в поле текст «хвост-не-чип»', labs() === 'один|два' && A.S.form.draft.labelInput === 'хвост-не-чип');
      const postsPre = A.calls.length;
      await A.click('saveForm');
      const postW = A.calls.slice(postsPre).find((c) => c.method === 'POST' && c.url === 'api/tasks.php');
      check('V6.2 W-4 «Сохранить»: непревращённый текст тоже уходит тегом — label = «один, два, хвост-не-чип»', postW && postW.body.label === 'один, два, хвост-не-чип' && A.S.form === null, postW && postW.body.label);
      const srvNew = A.S.tasks.find((t) => t.title === 'W62 теги формы');
      check('V6.2 W-4 перечитывание: сервер вернул label «один, два, хвост-не-чип» и labels[3]; в Списке 3 чипа', srvNew && srvNew.label === 'один, два, хвост-не-чип' && srvNew.labels.join('|') === 'один|два|хвост-не-чип' && (rowOf(srvNew.id).match(/data-f="label"/g) || []).length === 3, srvNew && srvNew.label);
      // правка существующей: чипы из labels, удалить и добавить, сохранить
      await A.click('editTask', (d) => d.id === srvNew.id);
      check('V6.2 W-4 правка: теги подгружены чипами (3)', labs() === 'один|два|хвост-не-чип' && A.count('class="tk-chip tk-tagchip"') === 3);
      await A.click('removeTag', (d) => d.idx === '0');
      await kb('Backspace', '');
      await kb('Enter', 'новый');
      await A.click('saveForm');
      const srvNew2 = (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + srvNew.id)).json.task;
      check('V6.2 W-4 правка: «× на первом», Backspace, добавление → сохранено «два, новый», версия выросла', srvNew2.label === 'два, новый' && srvNew2.labels.join('|') === 'два|новый' && srvNew2.version === srvNew.version + 1 && A.S.form === null, srvNew2.label);
      // пустая метка → NULL
      await A.click('editTask', (d) => d.id === srvNew.id);
      await A.click('removeTag', (d) => d.idx === '0'); await A.click('removeTag', (d) => d.idx === '0');
      await A.click('saveForm');
      const srvNew3 = (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + srvNew.id)).json.task;
      check('V6.2 W-4 все чипы убраны → метка NULL, labels []', srvNew3.label === null && srvNew3.labels.length === 0);
      // ошибка сервера показывается понятным текстом (message), а не «Ошибка сервера (invalid_label)»
      const errTxt = A.T.__t.errText({ status: 400, data: { error: 'invalid_label', message: 'Тег «яяя…» длиннее 30 символов.' } });
      check('V6.2 W-4 ответ сервера invalid_label с message → текст показывается как есть; без message — запасной понятный текст', errTxt === 'Тег «яяя…» длиннее 30 символов.' && /тег — до 30 символов/.test(A.T.__t.errText({ status: 400, data: { error: 'invalid_label' } })));
      check('V6.2 W-4 клиентский предел строки: 7 тегов по 30 → ошибка «Все теги вместе длиннее 200»', /Все теги вместе длиннее 200/.test(A.T.__t.draftError({ title: 'x', assignees: ['v61_s'], startDate: '2099-01-01', kind: 'single', labels: ['1', '2', '3', '4', '5', '6', '7'].map((c) => c.repeat(30)), labelInput: '' })));
      check('V6.2 W-4 CSS чипов формы и 375px: .tk-tagsbox flex-wrap, input не сжимается (flex:1 1 120px)', /\.tk-f \.tk-tagsbox\{display:flex;flex-wrap:wrap/.test(SRC) && /input\[type=text\]\{flex:1 1 120px/.test(SRC));
      await A.click('resetFilters');
    }

    // ---------- supervisor / viewer ----------
    for (const [label, ck] of [['supervisor', supCk], ['viewer', viewCk]]) {
      const R = makeEnv(base, ck);
      R.els.tabTasks.click();
      await R.settle();
      check('R-' + label + '-1 панель работает (видны задачи), режим «только просмотр»',
        R.root.style.display === 'block' && R.S.tasks.length >= 2 && R.has('только просмотр') && R.T.canWrite() === false);
      // V6.2 W-2: у supervisor/viewer в Списке нет ни колонки «Править», ни кнопок ✎; принудительный вызов editTask формы не открывает
      {
        const lst = R.root.innerHTML;
        const thN = ((/<thead><tr>([\s\S]*?)<\/tr><\/thead>/.exec(lst) || [])[1] || '').match(/<th[ >]/g) || [];
        const pre = R.calls.length;
        R.T.__t.ACTIONS.editTask({ dataset: { id: tid } }, { stopPropagation() {} });
        check('R-' + label + '-8 V6.2 W-2: в Списке нет колонки «Править» и кнопок ✎ (6 колонок), editTask принудительно — формы нет, запросов нет',
          R.S.view === 'list' && thN.length === 6 && lst.indexOf('tk-c-edit') < 0 && lst.indexOf('tk-editbtn') < 0 && lst.indexOf('Править') < 0 && R.S.form === null && R.calls.length === pre, thN.length + ' ' + R.S.view);
        const kt = R.T.__t.ACTIONS.removeTag; kt({ dataset: { idx: '0' } });
        // V6.3-1 И-1: у supervisor/viewer в Списке тоже не больше 2 ФИО + «…», title — все; ФИО кликабельны
        const rowV = (new RegExp('<tr class="tk-row[^>]*data-id="' + V63ID + '"[\\s\\S]*?</tr>').exec(lst) || [''])[0];
        const cellV = (rowV.split('</td>')[2] || '');
        check('R-' + label + '-10 V6.3-1 И-1: в Списке 3 исполнителя → 2 ФИО-ссылки + «…» + title с полным списком',
          !!V63ID && (cellV.match(/data-tk-act="filterEmp"/g) || []).length === 2 && MORE_RE.test(cellV) && /<td class="tk-c-exec" title="Исполнители: /.test(cellV), cellV.slice(0, 200));
        check('R-' + label + '-9 V6.2 W-4: у наблюдателя нет поля-тегов; чипы тегов в Списке — кликабельные фильтры', lst.indexOf('data-tk-tagsbox') < 0 && lst.indexOf('data-tk-field="labelInput"') < 0 && /data-tk-act="filterBy" data-f="label"/.test(lst) && R.S.form === null);
      }
      const writeMarks = ['data-tk-act="newTask"', 'data-tk-act="editTask"', 'data-tk-act="closeTask"', 'data-tk-act="reopenTask"',
        'data-tk-act="archiveTask"', 'data-tk-act="reassignTask"', 'data-tk-act="saveForm"', 'draggable', 'data-tk-drag', '<form'];
      const seen = [];
      const scan = () => writeMarks.forEach((m) => { if (R.has(m)) seen.push(m); });
      scan();
      await R.click('openTask', (d) => d.id === tid);        // список → доска + карточка
      scan();
      check('R-' + label + '-2 доска + карточка: ни одного элемента записи не отрендерено', R.S.view === 'board' && R.has('class="tk-detail"') && seen.length === 0, seen.join(','));
      await R.click('setView', (d) => d.view === 'calendar');
      await R.T.open({ employeeId: e1, date: sat, view: 'calendar', taskId: tid });
      await R.settle();
      scan();
      check('R-' + label + '-3 календарь + карточка: элементов записи нет, плитки и карточка читаются', seen.length === 0 && R.count('class="tk-ev') >= 3 && R.has('Шаг два'), seen.join(','));
      // V6-1 (R-12…R-14, R-17): клики-фильтры и сортировка доступны без прав записи
      const flow = [];
      await R.T.open({ view: 'board', taskId: tid }); await R.settle(); scan();
      await R.click('filterBy', (d) => d.f === 'label' && d.v === 'e2e'); scan(); flow.push(R.S.view === 'list' && R.S.filters.label === 'e2e' && R.has('tk-table'));
      await R.T.open({ view: 'board', taskId: tid }); await R.settle();
      await R.click('filterBy', (d) => d.f === 'priority' && d.v === '1'); scan(); flow.push(R.S.view === 'list' && R.S.filters.priority === '1' && !R.S.filters.label);
      await R.T.open({ view: 'board', taskId: tid }); await R.settle();
      await R.click('filterBy', (d) => d.f === 'status'); scan(); flow.push(R.S.view === 'list' && R.S.filters.status === 'open' && !R.S.filters.priority);
      await R.click('filterEmp', (d) => d.emp === e1); scan(); flow.push(R.S.view === 'list' && R.S.filters.emp === e1 && !R.S.filters.status);
      await R.click('sortBy', (d) => d.key === 'priority'); scan(); flow.push(R.S.sort.key === 'priority' && R.S.sort.dir === 'asc' && R.S.filters.emp === e1);
      await R.click('sortBy', (d) => d.key === 'priority'); await R.click('sortBy', (d) => d.key === 'priority'); flow.push(R.S.sort.key === '');
      check('R-' + label + '-6 V6-1: клики по метке/приоритету/статусу/ФИО ведут в «Список» с фильтром, сортировка работает; кнопок правки и «Переназначить» нет',
        flow.every(Boolean) && seen.length === 0, flow.join(',') + ' ' + seen.join(',') + ' ' + JSON.stringify(R.S.filters) + R.S.view);
      // V6-5 (P2-1): ФИО в плитке Доски кликабельно и без прав записи (плитка не draggable)
      await R.T.open({ view: 'board' }); await R.settle();
      check('R-' + label + '-7 V6-5: в плитке Доски ФИО — кнопка filterEmp, клик → «Список» по сотруднику; плитка без draggable',
        R.has('class="tk-name tk-namebtn" data-tk-act="filterEmp"') && !R.has('draggable') && (await R.click('filterEmp', (d) => d.emp === e1), R.S.view === 'list' && R.S.filters.emp === e1), JSON.stringify(R.S.filters) + R.S.view);
      // принудительные вызовы обработчиков записи — защита в самом модуле
      const postsBefore = R.calls.filter((c) => c.method !== 'GET').length;
      R.T.__t.ACTIONS.newTask({ dataset: {} });
      R.T.__t.ACTIONS.closeTask({ dataset: { id: tid } });
      R.T.__t.ACTIONS.archiveTask({ dataset: { id: tid } });
      R.root.fire('dragstart', { target: { closest: () => ({ dataset: { tkDrag: tid } }) }, dataTransfer: { setData() {} } });
      R.root.fire('drop', { target: colEl('closed'), preventDefault() {} });
      await R.settle();
      check('R-' + label + '-4 принудительный вызов действий записи не отправляет запросов и не открывает форму',
        R.S.form === null && R.calls.filter((c) => c.method !== 'GET').length === postsBefore);
      const w = [
        await http(base, ck, 'POST', 'api/tasks.php', { title: 'hack', start_at: '2099-09-01', assignees: [e1] }),
        await http(base, ck, 'PUT', 'api/tasks.php?id=' + tid, { version: 99, title: 'hack' }),
        await http(base, ck, 'POST', 'api/tasks.php?id=' + tid + '&action=close', {}),
        await http(base, ck, 'POST', 'api/tasks.php?id=' + tid + '&action=reopen', {}),
        await http(base, ck, 'DELETE', 'api/tasks.php?id=' + tid),
      ];
      const still = (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + tid)).json.task;
      check('R-' + label + '-5 API на любую запись → 403, данные не изменились',
        w.every((r) => r.status === 403) && still.title === 'Правка из другой вкладки' && still.status === 'open' && still.archived === 0, w.map((r) => r.status).join(','));
    }

    // вкладка не залипает: уход на «Матрицу»
    A.els.matrixWrapper.style.display = 'block';
    A.els.tabMatrix.click();
    check('E41 переход на «Матрицу отпусков» скрывает панель «Задачи»', A.root.style.display === 'none' && !A.els.tabTasks._cls.has('active') && A.T.isActive() === false);
  } catch (e) {
    check('E-FATAL необработанное исключение теста', false, (e && e.stack) || e);
  }
  return finish(srv, tmpDb, hashBefore);
}

function finish(srv, tmpDb, hashBefore) {
  try { srv.kill(); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(tmpDb); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(tmpDb + '-wal'); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(tmpDb + '-shm'); } catch (e) { /* ignore */ }
  const intact = sha1(REAL_DB) === hashBefore;
  check('Z1 data/app.db не изменена тестом (sha1)', intact);
  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log('RESULT: ' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); });
