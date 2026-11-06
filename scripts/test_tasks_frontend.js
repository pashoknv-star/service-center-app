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
  const confirms = { answer: true, asked: [] };
  const win = {};
  const sandbox = {
    window: win, console, setTimeout, clearTimeout, Promise, JSON, Date, Math, String, Number, Array, Object, RegExp, Error, encodeURIComponent,
    document: {
      readyState: 'complete',
      head: makeEl('head'),
      getElementById: (id) => els[id] || null,
      createElement: (t) => makeEl(t),
      addEventListener() {},
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
  function findTag(attr, val, pred) {
    const re = new RegExp('<[a-zA-Z]+\\b[^>]*\\b' + attr + '="' + val + '"[^>]*>', 'g');
    const html = root.innerHTML;
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
  return { sandbox, els, root, T, S: T.__t.S, calls, toasts, confirms, settle, click, change, field, filter, has, count, findTag };
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

  // ---- 2. чистые функции ------------------------------------------------------
  console.log('-- unit');
  const U = probe.T.__t;
  check('U1 truncate: длинный текст режется с «…», короткий не меняется',
    U.truncate('a'.repeat(100), 10).length === 10 && U.truncate('a'.repeat(100), 10).slice(-1) === '…' && U.truncate('коротко', 10) === 'коротко');
  check('U2 weekStart: понедельник недели (2099-03-04 → 2099-03-02 или соотв. Пн)',
    new Date(U.weekStart('2026-11-07') + 'T00:00:00Z').getUTCDay() === 1 && U.weekStart('2026-11-07') === '2026-11-02' && U.weekStart('2026-11-08') === '2026-11-02');
  check('U3 normEmpId: 2 → emp_2, emp_5 остаётся', U.normEmpId(2) === 'emp_2' && U.normEmpId('emp_5') === 'emp_5' && U.normEmpId('') === '');
  check('U4 esc экранирует HTML', U.esc('<b onclick="x">&\'') === '&lt;b onclick=&quot;x&quot;&gt;&amp;&#39;');

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
    const tileHtml = (/<div class="tk-ev[^"]*"[\s\S]*?<div class="tk-ev-desc">[^<]*<\/div>/.exec(A.root.innerHTML) || [''])[0];
    const descM = /<div class="tk-ev-desc">([^<]*)<\/div>/.exec(A.root.innerHTML);
    check('E20 плитка = ФИО + описание, длинное описание обрезано с «…»',
      tileHtml.indexOf(A.S.employees.find((e) => e.id === e1).name) >= 0 && descM && descM[1].slice(-1) === '…' && descM[1].length <= 48 && longDesc.indexOf(descM[1].slice(0, 20)) === 0, descM && descM[1]);
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
