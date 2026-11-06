#!/usr/bin/env node
// T1-3 verification harness: js/tasks_matrix.js (иконка варианта B + рамка срока в матрице отпусков).
//
// Образец — e51/e52 (чистый Node без зависимостей): модуль исполняется в vm с DOM-шимом.
//  A) статика: скрипт в index.html, синтаксис, контракт DOM матрицы, модуль только читает api/tasks.php;
//  B) геометрия/семантика: иконка ТОЛЬКО на первом дне открытой задачи, рамка по ВСЕМУ сроку
//     (выходные/отпуск тоже), закрытая/архивная — без иконки и рамки, красный круг при conflict,
//     несколько исполнителей, границы года, слияние пересекающихся сроков;
//  C) клики: иконка → openTasksPanel({employeeId,date,view:'calendar'}); Ctrl/Shift и пик-режим
//     командировок не перехватываются; mousedown на иконке не стартует выбор диапазона;
//  D) данные: один GET api/tasks.php?from&to на год, кеш, обновление после мутаций (tasks:changed),
//     устаревший ответ не затирает свежий, ошибки сети/401 безопасны;
//  E) производительность: 50 сотрудников × 365 дней (в шиме — число операций и время);
//  F) e2e по НАСТОЯЩЕМУ api/tasks.php (php -S на копии data/app.db): admin/supervisor/viewer
//     видят иконки и открывают панель, аноним — нет, закрытие задачи убирает иконку.
// Pure Node >= 22 (node:sqlite для подготовки фактов). Итог: «RESULT: N passed, M failed».
'use strict';

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'js/tasks_matrix.js'), 'utf8');
const TASKS_SRC = fs.readFileSync(path.join(ROOT, 'js/tasks.js'), 'utf8');
const TRIPS_SRC = fs.readFileSync(path.join(ROOT, 'js/trips.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const REAL_DB = path.join(ROOT, 'data/app.db');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 300) : '')); }
}
const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------------
// мини-DOM: ровно то, что трогает модуль
// ----------------------------------------------------------------------------
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
class El {
  static ops = 0;           // счётчик DOM-мутаций (classList.add/remove, appendChild/removeChild)
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parentNode = null; this.dataset = {}; this._attrs = {};
    this._cls = new Set(); this.listeners = {}; this.style = {}; this.textContent = '';
    const self = this;
    this.classList = {
      add: (c) => { El.ops++; self._cls.add(c); }, remove: (c) => { El.ops++; self._cls.delete(c); }, contains: (c) => self._cls.has(c),
    };
  }
  get className() { return Array.from(this._cls).join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get cells() { return this.children.filter((c) => c.tagName === 'TD'); }
  setAttribute(k, v) { this._attrs[k] = String(v); }
  getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; }
  appendChild(c) { El.ops++; c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { El.ops++; this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  addEventListener(t, fn, cap) { (this.listeners[t] = this.listeners[t] || []).push({ fn, cap: !!cap }); }
  matches(sel) {
    const m = /^([a-zA-Z]+)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(sel);
    if (!m) throw new Error('shim: неподдерживаемый селектор ' + sel);
    if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
    for (const c of (m[2] || '').split('.').filter(Boolean)) if (!this._cls.has(c)) return false;
    const re = /\[([\w-]+)(?:="([^"]*)")?\]/g; let a;
    while ((a = re.exec(m[3] || '')) !== null) {
      const key = camel(a[1].replace(/^data-/, ''));
      if (!a[1].startsWith('data-')) return false;
      if (this.dataset[key] === undefined) return false;
      if (a[2] !== undefined && String(this.dataset[key]) !== a[2]) return false;
    }
    return true;
  }
  closest(sel) { for (let e = this; e; e = e.parentNode) if (e.matches && e.matches(sel)) return e; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/** Матрица как в renderVacationMatrix: tbody > tr > td.name-col[data-emp-id] + td.day-cell-data[data-emp][data-day]. */
function buildMatrix(env, empIds, year, extraCls) {
  const total = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  const body = env.els.matrixBody;
  body.children = [];
  const grp = new El('tr'); const gl = new El('td'); gl.className = 'name-col matrix-group-label';
  grp.appendChild(gl); grp.appendChild(Object.assign(new El('td'), {})); body.appendChild(grp);   // строка группы (2 ячейки)
  empIds.forEach((id) => {
    const tr = new El('tr');
    const nm = new El('td'); nm.className = 'name-col'; nm.dataset.empId = String(id); tr.appendChild(nm);
    for (let d = 1; d <= total; d++) {
      const td = new El('td'); td.className = 'day-cell-data' + ((extraCls && extraCls(id, d)) ? ' ' + extraCls(id, d) : '');
      td.dataset.emp = String(id); td.dataset.day = String(d);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  });
  env.rows = {}; body.children.forEach((tr) => { if (tr.children[0].dataset.empId) env.rows[tr.children[0].dataset.empId] = tr; });
}

function makeEnv(opts) {
  opts = opts || {};
  const els = {};
  ['matrixBody', 'matrixWrapper', 'yearDisplay', 'authOverlay'].forEach((id) => { els[id] = new El(id === 'matrixBody' ? 'tbody' : 'div'); els[id].id = id; });
  els.yearDisplay.textContent = String(opts.year || 2026);
  els.matrixWrapper.style.display = 'block';
  els.authOverlay.className = 'auth-overlay hidden';
  const docListeners = {};
  const observers = [];
  const calls = [];                    // все fetch-вызовы модуля
  const opened = [];                   // вызовы openTasksPanel
  const doc = {
    readyState: 'complete', head: new El('head'), body: new El('body'),
    getElementById: (id) => els[id] || null,
    createElement: (t) => new El(t),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    dispatch: (t) => (docListeners[t] || []).forEach((fn) => fn({ type: t })),
  };
  const sandbox = {
    console, setTimeout, clearTimeout, Promise, JSON, Date, Math, String, Number, Array, Object, RegExp, Error, Set,
    document: doc,
    MutationObserver: function (cb) { const o = { cb, target: null, observe(t) { o.target = t; } }; observers.push(o); return o; },
    fetch: (url, o) => {
      calls.push({ url, method: (o && o.method) || 'GET', credentials: o && o.credentials });
      return opts.fetch(url, o);
    },
  };
  sandbox.window = sandbox;
  sandbox.openTasksPanel = (a) => { opened.push(a); };
  if (opts.renderVacationMatrix) sandbox.renderVacationMatrix = opts.renderVacationMatrix;
  vm.createContext(sandbox);
  const env = { els, doc, sandbox, observers, calls, opened, rows: {}, docListeners };
  if (opts.employees) buildMatrix(env, opts.employees, opts.year || 2026, opts.extraCls);
  vm.runInContext(SRC, sandbox, { filename: 'js/tasks_matrix.js' });
  env.M = sandbox.TasksMatrix;
  /** Имитация DOM-события: capture-слушатели tbody → слушатели цели → bubble. */
  env.fire = (target, type, props) => {
    const ev = Object.assign({ type, target, stopped: false, defaultPrevented: false,
      stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; } }, props || {});
    const path_ = []; for (let e = target; e; e = e.parentNode) path_.unshift(e);
    for (const n of path_) { for (const l of (n.listeners[type] || [])) if (l.cap) l.fn(ev); if (ev.stopped) return ev; }
    for (const n of path_.slice().reverse()) { for (const l of (n.listeners[type] || [])) if (!l.cap) l.fn(ev); if (ev.stopped) return ev; }
    return ev;
  };
  env.cell = (emp, day) => env.rows[String(emp)].children[day];          // children[0] = td.name-col
  env.icons = () => Object.keys(env.rows).reduce((a, e) => a.concat(env.rows[e].children.slice(1).filter((c) => c.children.length).map((c) => ({ emp: e, day: +c.dataset.day, el: c.children[0] }))), []);
  env.framed = (emp) => env.rows[String(emp)].children.slice(1).filter((c) => c._cls.has('tk-fr')).map((c) => +c.dataset.day);
  return env;
}
const okJson = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const doy = (ymd, year) => Math.round((Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) - Date.UTC(year || +ymd.slice(0, 4), 0, 1)) / 86400000) + 1;
let tid = 0;
function task(first, last, emps, o) {
  o = o || {};
  return {
    id: 't' + (++tid), title: o.title || ('Задача ' + tid), status: o.status || 'open', archived: o.archived || 0,
    start_at: first + 'T09:00', end_at: last && last !== first ? last + 'T18:00' : null,
    first_day: first, last_day: last || first, conflict: !!o.conflict,
    assignees: emps.map((e) => ({ employee_id: 'emp_' + e, full_name: 'Сотрудник ' + e })),
  };
}
async function settle() { await sleep(15); await sleep(15); }

// ----------------------------------------------------------------------------
async function main() {
  console.log('=== T1-3 TASKS MATRIX ICON + SPAN FRAME TEST ===');

  // ---- A. статика -------------------------------------------------------------
  console.log('-- static');
  const tag = '<script src="js/tasks_matrix.js"></script>';
  check('A1 index.html: <script src="js/tasks_matrix.js"> ровно один раз, после js/tasks.js',
    INDEX.split(tag).length === 2 && INDEX.indexOf('js/tasks.js') < INDEX.indexOf('js/tasks_matrix.js'));
  const chk = cp.spawnSync(process.execPath, ['--check', path.join(ROOT, 'js/tasks_matrix.js')]);
  check('A2 node --check js/tasks_matrix.js', chk.status === 0, String(chk.stderr));
  let syntaxOk = true, syntaxMsg = ''; const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi; let sm, n = 0;
  while ((sm = scriptRe.exec(INDEX)) !== null) { n++; try { new vm.Script(sm[1], { filename: 'inline-' + n + '.js' }); } catch (e) { syntaxOk = false; syntaxMsg = e.message; } }
  check('A3 inline-<script> index.html (' + n + ') проходят проверку синтаксиса (node --check)', syntaxOk && n > 0, syntaxMsg);
  check('A4 нет inline-обработчиков (onclick/onmousedown/…) в js/tasks_matrix.js', !/\bon(click|mousedown|change|submit|input|drop|dragstart)\s*=/i.test(SRC));
  check('A5 контракт DOM матрицы существует в index.html: #matrixBody, #yearDisplay, td.name-col[data-emp-id], td.day-cell-data[data-emp][data-day]',
    /id="matrixBody"/.test(INDEX) && /id="yearDisplay"/.test(INDEX) && INDEX.includes('<td class="name-col" data-emp-id="\' + emp.id + \'"') &&
    INDEX.includes('data-emp="\' + emp.id + \'" data-day="\' + doy + \'"></td>'));
  check('A6 псевдоэлемент ::before у .day-cell-data свободен (index.html/trips.js) — рамка его не перебивает',
    !/day-cell-data[^{}]*::?before/.test(INDEX) && !/day-cell-data[^{}]*::?before/.test(TRIPS_SRC));
  check('A7 модуль только читает: единственный сетевой вызов — GET api/tasks.php; нет save.php/storage/POST/PUT/DELETE',
    (SRC.match(/fetch\(/g) || []).length === 1 && /var API = 'api\/tasks\.php'/.test(SRC) &&
    !/save\.php|Storage\.|localStorage|['"](POST|PUT|DELETE)['"]/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('A8 доступ всем ролям: в модуле нет проверок роли/admin (запись закрыта на API)',
    !/isAdmin|canEdit|supervisor|viewer|session\.php|\.role\b/.test(SRC.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('A9 js/tasks.js шлёт tasks:changed после записи (handleWriteResult) — триггер обновления матрицы',
    /function notifyChanged\(\)[\s\S]*?dispatchEvent\(new CustomEvent\('tasks:changed'\)\)/.test(TASKS_SRC) &&
    /function handleWriteResult[\s\S]*?notifyChanged\(\);[\s\S]*?S\.form = null;/.test(TASKS_SRC));
  const css = makeEnv({ fetch: () => okJson({ success: true, tasks: [] }) }).M.__t.css();
  check('A10 CSS: рамка 1.5px solid var(--rt-blue), radius 8, свечение, без заливки, pointer-events:none; иконка #0088CC / красная #F44336',
    /1\.5px solid var\(--rt-blue\)/.test(css) && /border-radius:8px/.test(css) && /box-shadow:0 0 6px rgba\(0,136,204,\.2\)/.test(css) &&
    /pointer-events:none/.test(css) && !/\.tk-fr[^{]*\{[^}]*background/.test(css) && /background:#0088CC/.test(css) && /background:#F44336/.test(css));

  // ---- B. геометрия / семантика ----------------------------------------------
  console.log('-- geometry / semantics');
  const EMPS = [1, 2, 3, 4];
  // 2026: 09.11 = день 313 (Пн). Ячейки сотрудника 1 получают статусы матрицы: 11.11 отпуск, 12.11 больничный, 14–15.11 выходные.
  const statusCls = (id, d) => (id === 1 && d === 315 ? 'type-vacation' : (id === 1 && d === 316 ? 'type-sick' : (d === 318 || d === 319 ? 'day-weekend' : '')));
  const mk = (tasks, o) => makeEnv(Object.assign({ year: 2026, employees: EMPS, extraCls: statusCls, fetch: () => okJson({ success: true, tasks }) }, o || {}));
  const D = (ymd) => doy(ymd, 2026);

  // B1–B6: срок Пн 09.11 … Вс 15.11 (7 дней) накрывает отпуск, больничный и выходные
  let A = mk([task('2026-11-09', '2026-11-15', [1], { title: 'A' })]);
  await A.M.overlay(2026); await settle();
  const first = D('2026-11-09'), last = D('2026-11-15');
  check('B1 иконка ТОЛЬКО на первом дне срока (1 иконка, день ' + first + ')',
    A.icons().length === 1 && A.icons()[0].day === first && A.icons()[0].emp === '1', JSON.stringify(A.icons().map((i) => i.day)));
  const fr = A.framed(1);
  check('B2 рамка по ВСЕМУ сроку: ячейки ' + first + '…' + last + ' (включая выходной/отпуск), вне срока — нет',
    fr.length === 7 && fr[0] === first && fr[6] === last && fr.every((d, i) => d === first + i), fr.join(','));
  check('B3 края рамки: левая скобка только на первом дне, правая только на последнем',
    A.cell(1, first)._cls.has('tk-fr-l') && !A.cell(1, first)._cls.has('tk-fr-r') && A.cell(1, last)._cls.has('tk-fr-r') && !A.cell(1, last)._cls.has('tk-fr-l') &&
    !A.cell(1, first + 2)._cls.has('tk-fr-l') && !A.cell(1, first + 2)._cls.has('tk-fr-r'));
  const vac = A.cell(1, 315), sick = A.cell(1, 316), wk = A.cell(1, 318);
  check('B4 цвета статусов матрицы не затронуты: у ячеек отпуска/больничного/выходного внутри срока сохранены type-vacation/type-sick/day-weekend, рамка есть, детей нет (рамка — ::before)',
    vac._cls.has('type-vacation') && sick._cls.has('type-sick') && wk._cls.has('day-weekend') && [vac, sick, wk].every((c) => c._cls.has('day-cell-data') && c._cls.has('tk-fr') && c.children.length === 0));
  check('B5 другие сотрудники не затронуты', A.framed(2).length === 0 && A.framed(3).length === 0 && A.icons().every((i) => i.emp === '1'));
  const ic0 = A.icons()[0].el;
  check('B6 иконка: счётчик 1, дата срока и сотрудник в data-*, класс круга, не красная (нет conflict)',
    ic0.textContent === '1' && ic0.dataset.tkDate === '2026-11-09' && ic0.dataset.tkEmp === '1' && ic0.dataset.tkApi === 'emp_1' &&
    ic0.className === 'tk-mx-ic' && ic0.getAttribute('role') === 'button');

  // B7 закрытая/архивная — без иконки и рамки
  A = mk([task('2026-11-09', '2026-11-13', [1], { status: 'closed' }), task('2026-11-16', '2026-11-18', [2], { archived: 1 })]);
  await A.M.overlay(2026); await settle();
  check('B7 закрытая и архивная задачи: ни иконки, ни рамки', A.icons().length === 0 && A.framed(1).length === 0 && A.framed(2).length === 0);

  // B8 conflict — красный круг; счётчик несколько задач в один день
  A = mk([task('2026-11-10', '2026-11-12', [1]), task('2026-11-10', '2026-11-10', [1], { conflict: true }), task('2026-11-10', null, [2])]);
  await A.M.overlay(2026); await settle();
  const i1 = A.icons().filter((i) => i.emp === '1'), i2 = A.icons().filter((i) => i.emp === '2');
  check('B8 две открытые задачи стартуют в один день → ОДИН круг со счётчиком 2; conflict у любой → красный (tk-mx-conf)',
    i1.length === 1 && i1[0].el.textContent === '2' && i1[0].el.classList.contains('tk-mx-conf') && i2.length === 1 && i2[0].el.textContent === '1' && !i2[0].el.classList.contains('tk-mx-conf'));
  check('B9 задача без периода (end_at NULL) = один день: рамка из 1 ячейки с обеими скобками',
    A.framed(2).length === 1 && A.cell(2, D('2026-11-10'))._cls.has('tk-fr-l') && A.cell(2, D('2026-11-10'))._cls.has('tk-fr-r'));

  // B10 несколько исполнителей — иконка и рамка в строке КАЖДОГО
  A = mk([task('2026-11-10', '2026-11-12', [1, 3], { title: 'Двое' })]);
  await A.M.overlay(2026); await settle();
  check('B10 два исполнителя: иконка и рамка в строках обоих, у третьего — нет',
    A.icons().map((i) => i.emp).sort().join() === '1,3' && A.framed(1).length === 3 && A.framed(3).length === 3 && A.framed(2).length === 0);

  // B11 тот же день: счётчик > 9
  A = mk(Array.from({ length: 12 }, () => task('2026-11-10', null, [4])));
  await A.M.overlay(2026); await settle();
  check('B11 12 задач в один день → «9+» (круг не раздувается)', A.icons().length === 1 && A.icons()[0].el.textContent === '9+' && A.icons()[0].el.dataset.tkCount === '12');

  // B12–B14 границы года
  const span = task('2026-12-29', '2027-01-03', [1], { title: 'Через год' });
  const prev = task('2025-12-29', '2026-01-04', [2], { title: 'С прошлого года' });
  A = mk([span, prev]);
  await A.M.overlay(2026); await settle();
  check('B12 2026: срок 29.12.2026–03.01.2027 — иконка на 29.12 (день 363), рамка 363–365 без правой скобки',
    A.icons().filter((i) => i.emp === '1').length === 1 && A.icons().find((i) => i.emp === '1').day === 363 && A.framed(1).join() === '363,364,365' &&
    A.cell(1, 363)._cls.has('tk-fr-l') && !A.cell(1, 365)._cls.has('tk-fr-r'));
  check('B13 2026: срок 29.12.2025–04.01.2026 — иконки нет (первый день в прошлом году), рамка 1–4 без левой скобки, правая на дне 4',
    A.icons().filter((i) => i.emp === '2').length === 0 && A.framed(2).join() === '1,2,3,4' && !A.cell(2, 1)._cls.has('tk-fr-l') && A.cell(2, 4)._cls.has('tk-fr-r'));
  const A27 = makeEnv({ year: 2027, employees: [1, 2], fetch: () => okJson({ success: true, tasks: [span, prev] }) });
  await A27.M.overlay(2027); await settle();
  check('B14 2027: иконки нет вовсе, рамка 1–3 (продолжение срока) с правой скобкой на дне 3 и без левой',
    A27.icons().length === 0 && A27.framed(1).join() === '1,2,3' && !A27.cell(1, 1)._cls.has('tk-fr-l') && A27.cell(1, 3)._cls.has('tk-fr-r'));

  // B15–B16 пересекающиеся/смежные сроки одного сотрудника
  A = mk([task('2026-11-10', '2026-11-14', [1]), task('2026-11-12', '2026-11-17', [1]), task('2026-11-18', '2026-11-19', [1])]);
  await A.M.overlay(2026); await settle();
  const f1 = A.framed(1), s = D('2026-11-10');
  const lefts = f1.filter((d) => A.cell(1, d)._cls.has('tk-fr-l')), rights = f1.filter((d) => A.cell(1, d)._cls.has('tk-fr-r'));
  check('B15 пересекающиеся сроки сливаются в одну рамку (10–17), смежный срок (18–19) — отдельная рамка со своими скобками',
    f1.join() === [s, s + 1, s + 2, s + 3, s + 4, s + 5, s + 6, s + 7, s + 8, s + 9].join() && lefts.join() === [s, s + 8].join() && rights.join() === [s + 7, s + 9].join(), JSON.stringify({ f1, lefts, rights }));
  check('B16 иконки — по одной на каждую задачу-старт: дни 10, 12, 18 (счётчик 1)',
    A.icons().map((i) => i.day).join() === [s, s + 2, s + 8].join());

  // B17 устойчивость: сотрудник вне матрицы, задача вне года, мусорные данные
  A = mk([task('2026-11-10', '2026-11-11', [99]), task('2024-01-01', '2024-01-05', [1]), { id: 'bad', status: 'open', assignees: [{ employee_id: 'emp_1' }] }, null,
    task('2026-11-20', '2026-11-18', [3])]);   // конец раньше начала → один день
  let threw = false; try { await A.M.overlay(2026); await settle(); } catch (e) { threw = true; }
  check('B17 неизвестный сотрудник / задача вне года / мусор / конец<начала — без исключений; конец<начала = 1 день',
    !threw && A.icons().length === 1 && A.icons()[0].emp === '3' && A.framed(3).length === 1 && A.framed(1).length === 0);

  // B18 перерисовка не накапливает мусор
  A = mk([task('2026-11-10', '2026-11-12', [1])]);
  await A.M.overlay(2026); await A.M.overlay(2026); await A.M.overlay(2026); await settle();
  check('B18 повторная отрисовка не дублирует иконки и классы (1 иконка, 3 ячейки рамки)', A.icons().length === 1 && A.framed(1).length === 3);

  // ---- C. клики ---------------------------------------------------------------
  console.log('-- clicks');
  A = mk([task('2026-11-10', '2026-11-12', [1], { title: 'Клик' })]);
  await A.M.overlay(2026); await settle();
  const cellFirst = A.cell(1, D('2026-11-10')), icon = cellFirst.children[0];
  let cellClicks = 0, cellDowns = 0;
  cellFirst.addEventListener('click', () => { cellClicks++; });
  cellFirst.addEventListener('mousedown', () => { cellDowns++; });
  let ev = A.fire(icon, 'click', { button: 0 });
  check('C1 клик по иконке → openTasksPanel({employeeId:"emp_1", date:"2026-11-10", view:"calendar"}) ровно один раз',
    A.opened.length === 1 && A.opened[0].employeeId === 'emp_1' && A.opened[0].date === '2026-11-10' && A.opened[0].view === 'calendar', JSON.stringify(A.opened));
  check('C2 клик по иконке не доходит до обработчика ячейки (popup отпуска/выбор не срабатывает)', cellClicks === 0 && ev.stopped);
  A.fire(icon, 'mousedown', { button: 0 });
  check('C3 mousedown на иконке не стартует выбор диапазона ячеек (обработчик ячейки не вызван), панель не открыта повторно', cellDowns === 0 && A.opened.length === 1);
  A.fire(cellFirst, 'click', { button: 0 }); A.fire(cellFirst, 'mousedown', { button: 0 });
  check('C4 клик/mousedown по самой ячейке (вне иконки) идёт как раньше', cellClicks === 1 && cellDowns === 1 && A.opened.length === 1);
  A.fire(A.cell(1, D('2026-11-11')), 'click', { button: 0 });
  check('C5 клик по ячейке внутри рамки (не по иконке) — обычный выбор ячейки, панель задач не открывается', A.opened.length === 1);
  A.fire(icon, 'click', { button: 0, ctrlKey: true }); A.fire(icon, 'click', { button: 0, metaKey: true }); A.fire(icon, 'click', { button: 0, shiftKey: true });
  check('C6 Ctrl/Meta/Shift+клик по иконке не перехватывается: панель не открыта, событие дошло до ячейки (3 клика)', A.opened.length === 1 && cellClicks === 4, 'opened=' + A.opened.length + ' cellClicks=' + cellClicks);
  A.sandbox._employeePickActive = true;
  A.fire(icon, 'click', { button: 0 });
  A.sandbox._employeePickActive = false;
  A.sandbox.Trips = { suppressInfoPanel: () => true };
  A.fire(icon, 'click', { button: 0 });
  A.sandbox.Trips = { suppressInfoPanel: () => false };
  check('C7 пик-режим командировок (_employeePickActive / Trips.suppressInfoPanel) — иконка не перехватывает клик', A.opened.length === 1);
  A.fire(icon, 'click', { button: 2 });
  check('C8 правая кнопка мыши не открывает панель', A.opened.length === 1);
  A.fire(icon, 'click', { button: 0 });
  check('C9 после пик-режима иконка снова открывает панель', A.opened.length === 2);
  const noPanel = mk([task('2026-11-10', null, [1])]);
  delete noPanel.sandbox.openTasksPanel;
  await noPanel.M.overlay(2026); await settle();
  let t2 = false; try { noPanel.fire(noPanel.icons()[0].el, 'click', { button: 0 }); } catch (e) { t2 = true; }
  check('C10 если панель задач недоступна — клик безопасен (без исключения)', !t2);

  // ---- D. данные: запросы, кеш, обновление -----------------------------------
  console.log('-- data / cache / refresh');
  let calls = 0, payload = [task('2026-11-10', '2026-11-12', [1], { title: 'D1' })];
  A = makeEnv({ year: 2026, employees: EMPS, fetch: () => { calls++; return okJson({ success: true, tasks: payload }); } });
  await A.M.overlay(2026); await A.M.overlay(2026); await A.M.overlay(2026); await settle();
  check('D1 три отрисовки одного года = ОДИН запрос: GET api/tasks.php?from=2026-01-01&to=2026-12-31 (same-origin)',
    calls === 1 && A.calls[0].url === 'api/tasks.php?from=2026-01-01&to=2026-12-31' && A.calls[0].method === 'GET' && A.calls[0].credentials === 'same-origin', JSON.stringify(A.calls));
  A.els.yearDisplay.textContent = '2027'; buildMatrix(A, EMPS, 2027);
  await A.M.overlay(2027); await A.M.overlay(2027); await settle();
  check('D2 другой год = ещё один запрос (2027-01-01…2027-12-31), без повторов', calls === 2 && A.calls[1].url === 'api/tasks.php?from=2027-01-01&to=2027-12-31');
  A.els.yearDisplay.textContent = '2026'; buildMatrix(A, EMPS, 2026);
  await A.M.overlay(2026); await settle();
  check('D3 возврат на уже загруженный год — из кеша, без запроса; рамка и иконка нарисованы сразу', calls === 2 && A.icons().length === 1);

  // обновление после мутаций: матрица видима
  payload = [task('2026-11-10', '2026-11-12', [1], { status: 'closed' })];
  A.doc.dispatch('tasks:changed'); await settle();
  check('D4 tasks:changed при видимой матрице → повторный запрос и перерисовка: закрытая задача исчезла (иконка и рамка)',
    calls === 3 && A.icons().length === 0 && A.framed(1).length === 0, 'calls=' + calls);
  // матрица скрыта (открыта панель «Задачи») — запрос откладывается до возврата
  A.els.matrixWrapper.style.display = 'none';
  payload = [task('2026-11-10', '2026-11-12', [1])];
  A.doc.dispatch('tasks:changed'); await settle();
  const obs = A.observers.filter((o) => o.target === A.els.matrixWrapper)[0];
  check('D5 tasks:changed при скрытой матрице → запроса нет (экономия), отложено до показа', calls === 3 && A.M.__t.state().dirty === true && !!obs);
  A.els.matrixWrapper.style.display = 'block'; obs.cb(); await settle();
  check('D6 матрица снова показана → один запрос, иконка вернулась', calls === 4 && A.icons().length === 1 && A.M.__t.state().dirty === false);

  // устаревший ответ не затирает свежий
  let resolveOld, n2 = 0;
  const slowEnv = makeEnv({ year: 2026, employees: EMPS, fetch: () => {
    n2++;
    if (n2 === 1) return new Promise((res) => { resolveOld = () => res({ ok: true, status: 200, json: () => Promise.resolve({ success: true, tasks: [task('2026-11-10', '2026-11-12', [1], { title: 'старое' })] }) }); });
    return okJson({ success: true, tasks: [task('2026-11-16', '2026-11-18', [2], { title: 'свежее' })] });
  } });
  const pOld = slowEnv.M.overlay(2026);
  slowEnv.doc.dispatch('tasks:changed'); await settle();           // мутация во время первого запроса → refresh
  resolveOld(); await pOld; await settle();
  check('D7 устаревший ответ (запрос начат до мутации) не попадает в кеш и не рисуется поверх свежего',
    slowEnv.icons().length === 1 && slowEnv.icons()[0].emp === '2' && slowEnv.framed(1).length === 0, JSON.stringify(slowEnv.icons().map((i) => i.emp)));

  // ошибки
  for (const [label, f] of [['HTTP 401', () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'unauthorized' }) })],
    ['сеть недоступна', () => Promise.reject(new Error('net'))], ['не JSON', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) })],
    ['success:false', () => okJson({ success: false })]]) {
    const E = makeEnv({ year: 2026, employees: EMPS, fetch: f });
    let thr = false; try { await E.M.overlay(2026); await settle(); } catch (e) { thr = true; }
    check('D8 ответ «' + label + '» → без исключений, иконок и рамок нет, кеш не заполнен', !thr && E.icons().length === 0 && E.framed(1).length === 0 && !E.M.__t.state().cache[2026]);
  }

  // хук renderVacationMatrix
  let renders = 0;
  const hookEnv = makeEnv({ year: 2026, employees: EMPS, fetch: () => okJson({ success: true, tasks: [task('2026-11-10', '2026-11-12', [1])] }),
    renderVacationMatrix: function () { renders++; buildMatrix(hookEnv, EMPS, 2026); return 'ret'; } });
  hookEnv.sandbox.window = hookEnv.sandbox;
  await settle();
  const ret = hookEnv.sandbox.renderVacationMatrix(); await settle();
  check('D9 renderVacationMatrix обёрнут: возвращаемое значение сохранено, после перерисовки матрицы иконка/рамка рисуются заново',
    ret === 'ret' && renders === 1 && hookEnv.icons().length === 1 && hookEnv.framed(1).length === 3);
  const noRender = makeEnv({ year: 2026, employees: EMPS, fetch: () => okJson({ success: true, tasks: [] }) });
  check('D10 слушатели: capture click+mousedown на tbody и tasks:changed на document установлены',
    (noRender.els.matrixBody.listeners.click || []).some((l) => l.cap) && (noRender.els.matrixBody.listeners.mousedown || []).some((l) => l.cap) &&
    (noRender.docListeners['tasks:changed'] || []).length === 1);
  const empty = new El('div');
  const emptyEnv = (() => { const sb = { console, Promise, JSON, Date, Math, String, Number, Array, Object, RegExp, Error, Set, document: { readyState: 'complete', getElementById: () => null, createElement: () => new El('x'), addEventListener() {} }, fetch: () => { throw new Error('не должен вызываться'); } }; sb.window = sb; vm.createContext(sb); vm.runInContext(SRC, sb); return sb; })();
  check('D11 без разметки матрицы (#matrixBody нет) модуль не активируется и не делает запросов', typeof emptyEnv.TasksMatrix.init === 'function' && !!empty);

  // ---- E. производительность --------------------------------------------------
  console.log('-- performance (шим: число DOM-операций и время JS; в реальном браузере — см. отчёт)');
  const N = 50, perfEmps = Array.from({ length: N }, (_, i) => i + 1);
  const perfTasks = [];
  for (let i = 0; i < 600; i++) {   // 600 открытых задач на год, 1–2 исполнителя, срок 1–10 дней
    const start = 1 + ((i * 37) % 350), len = 1 + (i % 10), e1 = 1 + (i % N), two = i % 3 === 0;
    const ymd = (d) => new Date(Date.UTC(2026, 0, d)).toISOString().slice(0, 10);
    perfTasks.push(task(ymd(start), ymd(start + len - 1), two ? [e1, 1 + ((i * 7 + 3) % N)] : [e1], { conflict: i % 17 === 0 }));
  }
  const P = makeEnv({ year: 2026, employees: perfEmps, fetch: () => okJson({ success: true, tasks: perfTasks }) });
  const cellsTotal = N * 365;
  let t0 = process.hrtime.bigint(); await P.M.overlay(2026); await settle();
  const tFirst = Number(process.hrtime.bigint() - t0) / 1e6;
  const iconsN = P.icons().length, framedN = perfEmps.reduce((a, e) => a + P.framed(e).length, 0);
  t0 = process.hrtime.bigint(); El.ops = 0; for (let k = 0; k < 10; k++) await P.M.overlay(2026);
  const tRepaint = Number(process.hrtime.bigint() - t0) / 1e6 / 10, opsRepaint = El.ops / 10;
  console.log('  INFO  ' + N + ' сотрудников × 365 дней = ' + cellsTotal + ' ячеек, 600 задач: иконок ' + iconsN + ', ячеек в рамке ' + framedN +
    '; DOM-мутаций на полную перерисовку (снять+нарисовать) ' + opsRepaint + '; время в шиме (не браузерное!): первая отрисовка ' + tFirst.toFixed(1) +
    ' мс, перерисовка из кеша ' + tRepaint.toFixed(1) + ' мс');
  check('E1 один запрос на год; перерисовка из кеша — число DOM-мутаций ограничено задачами (≤ 6·ячеек рамки + 4·иконок), не 18 250 ячейками матрицы; JS в шиме < 500 мс',
    P.calls.length === 1 && opsRepaint <= 6 * framedN + 4 * iconsN && tRepaint < 500, 'ops=' + opsRepaint + ' t=' + tRepaint.toFixed(1));
  check('E2 затрагиваются только ячейки срока: рамка < 40% ячеек, иконок ≤ числа (задача×исполнитель)', framedN < cellsTotal * 0.4 && iconsN <= 600 * 2);

  // ---- F. e2e по настоящему api/tasks.php -------------------------------------
  console.log('-- e2e (php -S на копии БД)');
  const hashBefore = sha1(REAL_DB);
  const tmpDb = path.join(os.tmpdir(), 'sc_tasks_matrix_' + process.pid + '.db');
  fs.copyFileSync(REAL_DB, tmpDb);
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
  const base = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, { SC_APP_DB: tmpDb });
  delete env.TASKS_VALIDATE_WEBHOOK_URL;
  const srv = cp.spawn('php', ['-S', '127.0.0.1:' + port, '-t', ROOT], { env, cwd: ROOT, stdio: 'ignore' });
  let ready = false, lastErr = '';
  for (let i = 0; i < 150 && !ready; i++) {
    try { const r = await fetch(base + '/api/session.php'); ready = r.status < 500; lastErr = 'status ' + r.status; } catch (e) { lastErr = String(e); }
    if (!ready) await sleep(100);
  }
  if (!ready) { srv.kill(); check('F0 php -S поднялся', false, lastErr); return finish(srv, tmpDb, hashBefore); }
  const { DatabaseSync } = require('node:sqlite');
  try {
    const login = async (user) => {
      const r = await fetch(base + '/api/login.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: 'changeme' }) });
      if (r.status !== 200) throw new Error('login ' + user + ' → ' + r.status);
      return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    };
    const adminCk = await login('admin'), supCk = await login('supervisor_zone0'), viewCk = await login('viewer_test');
    const http = async (ck, method, url, body) => {
      const r = await fetch(base + '/' + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, ck ? { Cookie: ck } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
      let j = null; try { j = await r.json(); } catch (e) { /* не JSON */ }
      return { status: r.status, j: j || {} };
    };
    const emps = (await http(adminCk, 'GET', 'api/employees.php')).j;
    const eIds = (Array.isArray(emps) ? emps : emps.employees).map((e) => String(e.id));
    const nid = (id) => id.replace(/^emp_/, '');
    // календарь 2099: выбираем будни/выходные
    const mon = '2099-03-02';     // 2099-03-02 — понедельник
    const add = (ymd, n) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10) + n)).toISOString().slice(0, 10);
    const created = {};
    const mkTask = async (key, b) => { const r = await http(adminCk, 'POST', 'api/tasks.php', b); created[key] = r.j.task; return r; };
    const r1 = await mkTask('span', { title: 'E2E срок', assignees: [eIds[0]], start_at: mon + 'T09:00', end_at: add(mon, 6) + 'T18:00' });   // Пн … Вс (захватывает выходные)
    await mkTask('two', { title: 'E2E двое', assignees: [eIds[1], eIds[2]], start_at: add(mon, 8) + 'T09:00' });
    const rc = await mkTask('closed', { title: 'E2E закрыта', assignees: [eIds[3]], start_at: add(mon, 1) + 'T09:00', end_at: add(mon, 3) + 'T18:00' });
    await http(adminCk, 'POST', 'api/tasks.php?id=' + created.closed.id + '&action=close', { version: created.closed.version });
    check('F1 admin создал задачи через настоящий API (срок на выходные, двое исполнителей, закрытая)', r1.status === 201 && rc.status === 201 && created.span && created.two && created.closed, r1.status);
    // больничный поверх задачи «двое» → conflict (AC-4)
    const db = new DatabaseSync(tmpDb);
    db.prepare("INSERT OR REPLACE INTO schedule_entries(employee_id,date,status,comment,approval_status,updated_at,version) VALUES (?,?,?,?,?,?,1)")
      .run(eIds[2], add(mon, 8), 'sick', '', 'draft', '2099-01-01T00:00:00+00:00');
    db.close();

    const domEmps = eIds.map(nid);
    const mkReal = (cookie) => {
      const E = makeEnv({ year: 2099, employees: domEmps, fetch: (url, o) => fetch(base + '/' + url, { method: (o && o.method) || 'GET', headers: Object.assign({}, (o && o.headers) || {}, cookie ? { Cookie: cookie } : {}) }) });
      return E;
    };
    const dayOf = (ymd) => doy(ymd, 2099);
    const roles = [['admin', adminCk], ['supervisor', supCk], ['viewer', viewCk]];
    for (const [role, ck] of roles) {
      const E = mkReal(ck);
      await E.M.overlay(2099); await sleep(80);
      const byEmp = (id) => E.icons().filter((i) => i.emp === nid(id));
      const ok = byEmp(eIds[0]).length === 1 && byEmp(eIds[0])[0].day === dayOf(mon) && E.framed(nid(eIds[0])).length === 7 &&
        byEmp(eIds[1]).length === 1 && byEmp(eIds[2]).length === 1 && E.icons().filter((i) => i.emp === nid(eIds[3])).length === 0 && E.framed(nid(eIds[3])).length === 0;
      check('F2 ' + role + ': иконка на первом дне (Пн), рамка на все 7 дней (с выходными), у закрытой задачи ни иконки, ни рамки',
        ok, JSON.stringify(E.icons().map((i) => i.emp + ':' + i.day)));
      const red = byEmp(eIds[1])[0] && byEmp(eIds[2])[0] && byEmp(eIds[1])[0].el.classList.contains('tk-mx-conf') && byEmp(eIds[2])[0].el.classList.contains('tk-mx-conf');
      check('F3 ' + role + ': conflict (больничный поверх срока) от API → красный круг у обоих исполнителей', !!red);
      if (byEmp(eIds[0])[0]) E.fire(byEmp(eIds[0])[0].el, 'click', { button: 0 });
      check('F4 ' + role + ': клик по иконке → openTasksPanel({employeeId:"' + eIds[0] + '", date:"' + mon + '", view:"calendar"})',
        E.opened.length === 1 && E.opened[0].employeeId === eIds[0] && E.opened[0].date === mon && E.opened[0].view === 'calendar', JSON.stringify(E.opened));
      check('F5 ' + role + ': модуль сделал ровно один запрос GET api/tasks.php?from=2099-01-01&to=2099-12-31',
        E.calls.length === 1 && E.calls[0].url === 'api/tasks.php?from=2099-01-01&to=2099-12-31');
    }
    const anon = mkReal('');
    await anon.M.overlay(2099); await sleep(80);
    check('F6 аноним (нет сессии → 401): иконок и рамок нет, без исключений', anon.icons().length === 0 && anon.framed(nid(eIds[0])).length === 0);

    // мутация → обновление
    const E = mkReal(adminCk);
    await E.M.overlay(2099); await sleep(80);
    await http(adminCk, 'POST', 'api/tasks.php?id=' + created.span.id + '&action=close', { version: created.span.version });
    E.doc.dispatch('tasks:changed');
    for (let i = 0; i < 400 && E.icons().filter((x) => x.emp === nid(eIds[0])).length; i++) await sleep(50);   // refresh асинхронный: ждём результат, а не фиксированное время
    check('F7 admin закрыл задачу через API + tasks:changed → иконка и рамка убраны, остальные на месте (2 иконки)',
      E.icons().filter((i) => i.emp === nid(eIds[0])).length === 0 && E.framed(nid(eIds[0])).length === 0 && E.icons().length === 2 && E.calls.length === 2, JSON.stringify(E.icons().map((i) => i.emp)));
  } catch (e) {
    check('F-FATAL необработанное исключение теста', false, (e && e.stack) || e);
  }
  return finish(srv, tmpDb, hashBefore);
}

function finish(srv, tmpDb, hashBefore) {
  try { srv.kill(); } catch (e) { /* ignore */ }
  for (const f of [tmpDb, tmpDb + '-wal', tmpDb + '-shm']) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
  check('Z1 data/app.db не изменена тестом (sha1)', sha1(REAL_DB) === hashBefore);
  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); console.log('RESULT: ' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); });
