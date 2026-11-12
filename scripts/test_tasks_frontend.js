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
  return { sandbox, els, root, T, S: T.__t.S, calls, toasts, confirms, settle, click, change, field, filter, has, count, findTag,
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
      ['title', 'description', 'assigneePick', 'kind', 'startDate', 'startTime', 'priority', 'label'].every((f) => A.findTag('data-tk-field', f)) &&
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
    await A.field('label', 'e2e');
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
    check('E8 список: колонки Задача/Исполнитель/Срок/Приор./Статус, приоритет «высокий» выделен, ФИО — ссылки',
      ['Задача', 'Исполнитель', 'Срок', 'Приор.', 'Статус'].every((c) => A.has('<th>' + c + '</th>')) && A.has('tk-hi') && A.count('data-tk-act="filterEmp"') === 2);
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

    // клик по фамилии → доска по сотруднику
    await A.click('filterEmp', (d) => d.emp === e1);
    check('E13 клик по фамилии → «Доска», отфильтрована по сотруднику (Открыта · 1 / Закрыта · 0)',
      A.S.view === 'board' && A.S.filters.emp === e1 && A.has('Открыта · 1') && A.has('Закрыта · 0') && A.has('data-tk-col="open"') && A.has('data-tk-col="closed"'));
    await A.filter('emp', e3);
    check('E14 доска по другому сотруднику: Открыта · 0', A.has('Открыта · 0'));
    await A.click('clearEmp');
    check('E15 карточка на доске draggable только для admin', A.has('draggable="true"') && A.has('data-tk-drag="' + tid + '"'));

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
    await A.click('reassignTask', (d) => d.id === tid);
    check('E32 «Переназначить» открывает форму с текущими исполнителями', A.S.form && A.S.form.id === tid && A.S.form.draft.assignees.length === 2 && A.has('Редактирование задачи'));
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
      /Принимающий Тестович, <s class="tk-gone"[^>]*>Удалённый Первый<\/s>/.test(cardOf(openColHtml, tM.id)) &&
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

    // ---------- supervisor / viewer ----------
    for (const [label, ck] of [['supervisor', supCk], ['viewer', viewCk]]) {
      const R = makeEnv(base, ck);
      R.els.tabTasks.click();
      await R.settle();
      check('R-' + label + '-1 панель работает (видны задачи), режим «только просмотр»',
        R.root.style.display === 'block' && R.S.tasks.length >= 2 && R.has('только просмотр') && R.T.canWrite() === false);
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
