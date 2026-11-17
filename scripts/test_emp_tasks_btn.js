#!/usr/bin/env node
// V8-T3 verification harness: кнопка «Задачи» в карточке сотрудника (index.html #tasksFromEmpCardBtn) + Tasks.openForEmployee (js/tasks.js).
//
// Проверяется:
//  - статика: подпись «Задачи», класс editor-only, старый id/обработчик «Командировка из карточки» удалён из кода
//    (index.html, js/, scripts/, api/ — отчёты reports/** и навигационный CODEMAP.md не в счёт), Trips не экспортирует
//    старый Trips-обработчик кнопки, обработчик кнопки в index.html исполняется в vm: resetMatrixEmployeeCard → Tasks.openForEmployee(currentId);
//  - видимость кнопки: ровно та, что даёт editor-only (session.canEdit: admin/supervisor — да, viewer — нет);
//  - e2e БЕЗ браузера: js/tasks.js в vm с DOM-шимом против НАСТОЯЩЕГО api/tasks.php (php -S на копии data/app.db, SC_APP_DB):
//    admin → «Список» по сотруднику + форма НОВОЙ задачи с предвыбранным сотрудником, сохранение создаёт задачу с ним;
//    supervisor → «Список» по сотруднику без формы/«+ Новая задача»/✎, запись сервером отклоняется (403);
//    несохранённый на сервере сотрудник → понятная ошибка, формы нет.
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
const TRIPS = fs.readFileSync(path.join(ROOT, 'js/trips.js'), 'utf8');
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
  // V7: XMLHttpRequest (загрузка вложений с прогрессом) поверх настоящего fetch → php -S; FormData/File — из Node
  class XHR {
    constructor() { this.upload = {}; this.status = 0; this.responseText = ''; this.withCredentials = false; }
    open(m, u) { this._m = m; this._u = u; }
    send(fd) {
      calls.push({ method: this._m, url: this._u, body: null, form: fd && typeof fd.get === 'function' ? fd.get('file') : null });
      inflight++;
      fetch(base + '/' + this._u, { method: this._m, headers: cookie ? { Cookie: cookie } : {}, body: fd })
        .then((r) => r.text().then((t) => {
          this.status = r.status; this.responseText = t;
          if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: 1, total: 2 });
          try { if (this.onload) this.onload(); } finally { inflight--; }
        }), () => { try { if (this.onerror) this.onerror(); } finally { inflight--; } });
    }
  }
  sandbox.XMLHttpRequest = XHR;
  sandbox.FormData = FormData;
  sandbox.File = File;
  sandbox.Blob = Blob;
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
  // V7: окно вложений (#tasksAttModal в document.body)
  const attEl = () => body.children.find((c) => c.id === 'tasksAttModal') || null;
  const ahtml = () => (attEl() ? attEl().innerHTML : '');
  const ahas = (needle) => ahtml().indexOf(needle) >= 0;
  async function aclick(act, pred) {
    const t = findTag('data-tk-act', act, pred, ahtml());
    if (!t) throw new Error('кнопка окна вложений data-tk-act="' + act + '" не отрендерена');
    attEl().fire('click', { target: { closest: () => ({ dataset: t.dataset }) }, preventDefault() {} });
    await settle();
  }
  function afiles(files, how) {          // how: 'pick' (input change) | 'drop'
    const ev = how === 'drop'
      ? { target: {}, prevented: false, preventDefault() { this.prevented = true; }, dataTransfer: { types: ['Files'], files } }
      : { target: { dataset: { tkAttInput: '' }, files, value: 'x' } };
    attEl().fire(how === 'drop' ? 'drop' : 'change', ev);
    return ev;
  }
  return { sandbox, els, root, T, S: T.__t.S, calls, toasts, confirms, settle, click, change, field, key, input, filter, has, count, findTag,
    body, events, modalEl, mhtml, mhas, mcount, mclick, mchange, attEl, ahtml, ahas, aclick, afiles };
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
// обработчик кнопки из index.html — в vm с заглушками
function runCardButton(o) {
  const hs = {};
  const start = INDEX.indexOf("document.getElementById('tasksFromEmpCardBtn').addEventListener('click'");
  const end = INDEX.indexOf('// =====', start);
  const log = { order: [], toasts: [], opened: [] };
  const ctx = {
    document: { getElementById: (id) => ({ addEventListener: (t, fn) => { hs[id] = fn; } }) },
    currentId: o.currentId,
    resetMatrixEmployeeCard: () => { log.order.push('reset'); },
    showToast: (t, ty) => { log.toasts.push([t, ty]); },
    window: o.noTasks ? {} : { Tasks: { openForEmployee: (id) => { log.order.push('open'); log.opened.push(id); return Promise.resolve(true); } } },
  };
  vm.createContext(ctx);
  vm.runInContext(INDEX.slice(start, end), ctx);
  hs.tasksFromEmpCardBtn();
  return log;
}

function trackedFiles() {
  const r = cp.spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

async function main() {
  console.log('=== V8-T3 EMPLOYEE CARD BUTTON «ЗАДАЧИ» TEST ===');
  const OLD_ID = 'trip' + 'FromEmpCardBtn', OLD_FN = 'openTrip' + 'FromEmployee', OLD_BTN = 'trip' + 'FromEmpBtn';

  // ---- 1. статика -------------------------------------------------------------
  console.log('-- static');
  const btn = /<button\b[^>]*\bid="tasksFromEmpCardBtn"[^>]*>([^<]*)<\/button>/.exec(INDEX);
  check('S1 index.html: ровно одна кнопка #tasksFromEmpCardBtn, подпись «Задачи», класс editor-only',
    (INDEX.match(/id="tasksFromEmpCardBtn"/g) || []).length === 1 && !!btn && btn[1].trim() === 'Задачи' && /class="[^"]*\beditor-only\b/.test(btn[0]), btn && btn[0]);
  const edStart = INDEX.indexOf('<aside class="editor" id="editor">');
  const edEnd = INDEX.indexOf('</aside>', edStart);
  check('S2 кнопка «Задачи» лежит в карточке сотрудника (aside#editor), «Командировка» в карточке больше нет',
    edStart > 0 && INDEX.slice(edStart, edEnd).indexOf('id="tasksFromEmpCardBtn"') > 0 && !/Командировка/.test(INDEX.slice(edStart, edEnd)));
  const hits = [];
  trackedFiles().filter((f) => !/^reports\//.test(f) && f !== 'CODEMAP.md' && f !== 'scripts/test_emp_tasks_btn.js' && /\.(html|js|php|sh|md|json|css)$/.test(f)).forEach((f) => {
    let t = ''; try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return; }
    [OLD_ID, OLD_FN, OLD_BTN].forEach((s) => { if (t.indexOf(s) >= 0) hits.push(f + ':' + s); });
  });
  check('S3 старый путь удалён из кода: нет старых id кнопок и функции-обработчика Trips (rg по отслеживаемым файлам вне reports/)', hits.length === 0, hits.join(' '));
  check('S4 js/trips.js: старый обработчик и его вспомогательная функция чтения id карточки удалены, window.__editingEmployeeId не используется нигде',
    TRIPS.indexOf('getCurrent' + 'EditingEmployeeId') < 0 && INDEX.indexOf('__editingEmployeeId') < 0 && TRIPS.indexOf('__editingEmployeeId') < 0);
  check('S5 «Командировки» из Матрицы/вкладки целы: Trips.startEmployeePick/confirmEmployeePick/openTripModal/saveTrip экспортированы, кнопка «+ Добавить сотрудника» на месте',
    /startEmployeePick: startEmployeePick,/.test(TRIPS) && /confirmEmployeePick: confirmEmployeePick,/.test(TRIPS) &&
    /openTripModal: openTripModal,/.test(TRIPS) && /saveTrip: saveTrip,/.test(TRIPS) && /_dom\.newTripBtn\.addEventListener\('click', openNewTripModal\)/.test(TRIPS) &&
    (TRIPS.match(/window\.Trips\.startEmployeePick\(\)/g) || []).length >= 1);
  const probe = makeEnv('http://127.0.0.1:1', '');
  check('S6 Tasks.openForEmployee экспортирован (index.html обращается к нему)', typeof probe.T.openForEmployee === 'function' && /window\.Tasks\.openForEmployee\(/.test(INDEX));
  let lg = runCardButton({ currentId: 7 });
  check('S7 клик по кнопке: карточка уступает место (resetMatrixEmployeeCard) → Tasks.openForEmployee(id открытой карточки)',
    lg.order.join() === 'reset,open' && lg.opened[0] === 7 && lg.toasts.length === 0, JSON.stringify(lg));
  lg = runCardButton({ currentId: 7, noTasks: true });
  check('S8 модуль задач не загружен: понятный тост, карточка не сбрасывается', lg.order.length === 0 && lg.toasts.length === 1 && lg.toasts[0][1] === 'error', JSON.stringify(lg));
  lg = runCardButton({ currentId: null });
  check('S9 нет открытой карточки (currentId = null): ничего не открывается', lg.order.length === 0 && lg.opened.length === 0);
  let syntaxOk = true, syntaxMsg = '';
  const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let sm, n = 0;
  while ((sm = scriptRe.exec(INDEX)) !== null) {
    n++;
    try { new vm.Script(sm[1], { filename: 'inline-' + n + '.js' }); } catch (e) { syntaxOk = false; syntaxMsg = e.message; }
  }
  check('S10 inline-<script> index.html (' + n + ') проходят проверку синтаксиса', syntaxOk && n > 0, syntaxMsg);
  check('S11 node --check js/tasks.js и js/trips.js',
    cp.spawnSync(process.execPath, ['--check', path.join(ROOT, 'js/tasks.js')]).status === 0 && cp.spawnSync(process.execPath, ['--check', path.join(ROOT, 'js/trips.js')]).status === 0);

  // ---- 2. сервер на копии БД --------------------------------------------------
  console.log('-- e2e (php -S на копии БД)');
  const hashBefore = sha1(REAL_DB);
  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc_tasks_ui_')), 'app.db');
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

  try {
    const adminCk = await login(base, 'admin');
    const supCk = await login(base, 'supervisor_zone0');
    const viewCk = await login(base, 'viewer_test');

    // видимость кнопки = editor-only = session.canEdit
    const can = {};
    for (const [k, ck] of [['admin', adminCk], ['supervisor', supCk], ['viewer', viewCk]]) {
      const r = await http(base, ck, 'GET', 'api/session.php');
      can[k] = r.json && r.json.user ? r.json.user.canEdit : undefined;
    }
    check('V1 editor-only (canEdit из сессии): admin — кнопка видна, supervisor — видна, viewer — скрыта (как и раньше)',
      can.admin === true && can.supervisor === true && can.viewer === false, JSON.stringify(can));
    check('V2 applyRoleGating скрывает .editor-only только при canEdit !== true (правка видимости не нужна)',
      /const showEditor = user\.canEdit === true;/.test(INDEX) && /el\.style\.display = showEditor \? '' : 'none'/.test(INDEX));

    // подготовка: задачи на двух сотрудников
    const A = makeEnv(base, adminCk);
    await A.T.activate();
    await A.settle();
    const emps = A.S.employees;
    check('E0 справочник сотрудников загружен (>= 3)', emps.length >= 3, emps.length);
    const e1 = emps[1].id, e3 = emps[3].id;
    const mk1 = await http(base, adminCk, 'POST', 'api/tasks.php', { title: 'Задача Первого', start_at: '2099-08-10', assignees: [e1] });
    const mk3 = await http(base, adminCk, 'POST', 'api/tasks.php', { title: 'Задача Третьего', start_at: '2099-08-11', assignees: [e3] });
    check('E00 подготовка: две задачи на разных сотрудников созданы', mk1.status === 201 && mk3.status === 201, mk1.status + '/' + mk3.status);
    A.els.tabMatrix.click();

    // ---------- admin ----------
    console.log('-- admin');
    const AD = makeEnv(base, adminCk);
    const legacyId = /^emp_(\d+)$/.test(e1) ? Number(/^emp_(\d+)$/.exec(e1)[1]) : e1;     // карточка в index.html хранит числовой id
    const okA = await AD.T.openForEmployee(legacyId);
    await AD.settle();
    check('A1 клик: панель «Задачи» открыта (vacationPanel.open), «Список», фильтр = этот сотрудник (id нормализован до emp_N)',
      okA === true && AD.els.vacationPanel._cls.has('open') && AD.root.style.display === 'block' && AD.S.view === 'list' && AD.S.filters.emp === e1 &&
      AD.S.filters.due === '' && AD.S.filters.priority === '' && AD.S.filters.label === '' && AD.S.filters.status === '', JSON.stringify(AD.S.filters));
    check('A2 открыта форма НОВОЙ задачи («Новая задача», не «Редактирование»), сотрудник уже выбран исполнителем (чип с ФИО, draft.assignees)',
      AD.S.form && AD.S.form.id === null && AD.has('<h4>Новая задача</h4>') && AD.S.form.draft.assignees.length === 1 && AD.S.form.draft.assignees[0] === e1 &&
      AD.count('class="tk-chip"') === 1 && AD.has(emps[1].name), JSON.stringify(AD.S.form && AD.S.form.draft.assignees));
    check('A3 как при обычном «+ Новая задача»: на экране форма (список под ней не рисуется), фильтр списка уже стоит на сотруднике',
      AD.root.innerHTML.indexOf('data-tk-form') >= 0 && AD.root.innerHTML.indexOf('tk-table') < 0 && AD.S.filters.emp === e1);
    check('A4 выбранный сотрудник не дублируется в «+ добавить исполнителя…»',
      !new RegExp('<option value="' + e1 + '"').test(AD.root.innerHTML.slice(AD.root.innerHTML.indexOf('data-tk-field="assigneePick"'))));
    await AD.click('saveForm');
    check('A5 пустое название → штатная валидация формы, запрос не отправлен, форма на месте', AD.has('Укажите название задачи') && !AD.calls.some((c) => c.method === 'POST') && AD.S.form !== null);
    await AD.field('title', 'Задача из карточки сотрудника');
    await AD.field('startDate', '2099-09-01');
    await AD.click('saveForm');
    const post = AD.calls.filter((c) => c.method === 'POST' && c.url === 'api/tasks.php');
    check('A6 сохранение — штатным POST api/tasks.php: исполнитель = этот сотрудник, форма закрыта, тост «Задача создана», задача в списке сотрудника',
      post.length === 1 && post[0].body.title === 'Задача из карточки сотрудника' && post[0].body.assignees.length === 1 && post[0].body.assignees[0] === e1 &&
      AD.S.form === null && AD.toasts.some((t) => t.text === 'Задача создана') && AD.has('Задача из карточки сотрудника'), JSON.stringify(post.map((p) => p.body)));
    const srvAll = (await http(base, adminCk, 'GET', 'api/tasks.php')).json.tasks || [];
    const created = srvAll.find((t) => t.title === 'Задача из карточки сотрудника');
    check('A7 на сервере задача создана и привязана к этому сотруднику (GET api/tasks.php: assignees[].employee_id)',
      !!created && created.assignees.length === 1 && created.assignees[0].employee_id === e1, JSON.stringify(created && created.assignees));
    check('A7b после сохранения список остался отфильтрованным по сотруднику: его задачи есть, задачи Третьего нет', AD.has('Задача Первого') && !AD.has('Задача Третьего'));

    // повторный клик по кнопке — снова чистая форма, прежние фильтры/выбор сброшены
    AD.S.filters.status = 'closed';
    AD.S.selectedId = created ? created.id : null;
    await AD.T.openForEmployee(e1);
    await AD.settle();
    check('A8 повторное открытие: фильтры сброшены (кроме сотрудника), выбранной карточки нет, форма новая и пустая',
      AD.S.filters.status === '' && AD.S.filters.emp === e1 && AD.S.selectedId === null && AD.S.form && AD.S.form.id === null && AD.S.form.draft.title === '' && AD.S.form.draft.assignees.join() === e1);
    check('A9 из той же панели «+ Новая задача» без сотрудника по-прежнему доступна и «Отмена» закрывает форму',
      AD.has('data-tk-act="newTask"') && AD.has('data-tk-act="cancelForm"'));
    await AD.click('cancelForm');
    check('A10 «Отмена» закрывает форму, список сотрудника остался', AD.S.form === null && AD.S.filters.emp === e1 && AD.has('Задача Первого'));

    // ---------- supervisor ----------
    console.log('-- supervisor');
    const SU = makeEnv(base, supCk);
    const okS = await SU.T.openForEmployee(legacyId);
    await SU.settle();
    const html = SU.root.innerHTML;
    check('B1 supervisor: панель открыта, «Список», фильтр = этот сотрудник', okS === true && SU.els.vacationPanel._cls.has('open') && SU.S.view === 'list' && SU.S.filters.emp === e1);
    check('B2 список — только задачи этого сотрудника (свои 2 строки, чужой нет)', SU.has('Задача Первого') && SU.has('Задача из карточки сотрудника') && !SU.has('Задача Третьего'));
    check('B3 только просмотр: формы нет, нет «+ Новая задача», «Сохранить», ✎ «Править», колонки правки; есть плашка «только просмотр»',
      SU.S.form === null && SU.T.canWrite() === false && html.indexOf('data-tk-act="newTask"') < 0 && html.indexOf('data-tk-act="saveForm"') < 0 &&
      html.indexOf('data-tk-act="editTask"') < 0 && html.indexOf('tk-c-edit') < 0 && html.indexOf('data-tk-form') < 0 && html.indexOf('только просмотр') >= 0);
    // клик по строке открывает карточку (чтение); кнопок записи в ней тоже нет
    await SU.click('openTask');
    const dh = SU.root.innerHTML;
    check('B4 карточка задачи в режиме просмотра: нет «Править»/«Закрыть задачу»/«Удалить»/формы',
      dh.indexOf('data-tk-act="editTask"') < 0 && dh.indexOf('data-tk-act="closeTask"') < 0 && dh.indexOf('data-tk-act="reopenTask"') < 0 &&
      dh.indexOf('data-tk-act="deleteTask"') < 0 && dh.indexOf('data-tk-act="newTask"') < 0 && dh.indexOf('data-tk-form') < 0, dh.match(/data-tk-act="(\w+)"/g));
    const w = await http(base, supCk, 'POST', 'api/tasks.php', { title: 'Нельзя', start_at: '2099-09-02', assignees: [e1] });
    check('B5 сервер по-прежнему отвечает 403 на запись supervisor (UI не обходит права)', w.status === 403, w.status);

    // ---------- сотрудник не сохранён на сервере ----------
    console.log('-- несохранённый сотрудник');
    const NX = makeEnv(base, adminCk);
    const okN = await NX.T.openForEmployee(999999);
    await NX.settle();
    check('N1 сотрудника нет на сервере: возвращает false, формы нет, понятная ошибка «Выбранный сотрудник не найден»',
      okN === false && NX.S.form === null && NX.S.filters.emp === '' && NX.has('Выбранный сотрудник не найден'), NX.S.msg && NX.S.msg.text);
    check('N2 пустой id: ничего не делает (false)', (await NX.T.openForEmployee('')) === false && (await NX.T.openForEmployee(null)) === false);
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
  try { if (path.basename(path.dirname(tmpDb)).indexOf('sc_tasks_ui_') === 0) fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  check('Z1 data/app.db не изменена тестом (sha1)', sha1(REAL_DB) === hashBefore);
  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log('RESULT: ' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); });
