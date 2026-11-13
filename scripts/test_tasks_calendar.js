#!/usr/bin/env node
// V6-2 verification harness: календарь «Задачи» по часам (Неделя/День, как в Outlook) и время с шагом 30 минут.
//   R-3  выпадающий список времени «—, 00:00 … 23:30» вместо <input type=time>, некратное время сохраняется;
//   R-6  плитка = время + тема (жирно), без ФИО/описания; значки «конфликт/не проверено/без исполнителя»;
//   R-9  сетка 24 равные строки (48 px/час), плитка абсолютно позиционирована (top/height), «Весь день»,
//        линия «сейчас», прокрутка к 08:00 (и её сохранение при перерисовке);
//   R-10 клик по пустой ячейке (день, полчаса) → «Новая задача» с датой/временем; только admin;
//   R-11 раскладка пересекающихся задач по дорожкам (классический алгоритм колонок).
// По образцу scripts/test_tasks_frontend.js: js/tasks.js исполняется в vm с DOM-шимом; часть проверок идёт по
// HTTP в НАСТОЯЩИЙ api/tasks.php (временный `php -S` на копии data/app.db, env SC_APP_DB; sha1 data/app.db сверяется).
// Реальный Chromium (скриншоты, геометрия) — scripts/calendar_browser.js (вне gate; результаты — в отчёте V6-2).
// Pure Node >= 22, без зависимостей. Итог: «RESULT: N passed, M failed».
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
const REAL_DB = path.join(ROOT, 'data/app.db');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sha1 = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

// ----------------------------------------------------------------------------
// DOM-шим (как в tasksui) + «прокручиваемый» календарь: innerHTML заменяет элемент .tk-wk новым (scrollTop = 0),
// как настоящая перерисовка DOM.
// ----------------------------------------------------------------------------
function makeEl(id) {
  const el = {
    id, style: {}, dataset: {}, textContent: '', listeners: {},
    _cls: new Set(), parentNode: null, className: '', classList: null,
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    focus() {},
    fire(type, ev) { (this.listeners[type] || []).forEach((fn) => fn(ev)); },
    click() { this.fire('click', { target: this, preventDefault() {} }); },
    closest() { return this; },
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) {
      html = String(v);
      el.calEl = html.indexOf('class="tk-wk"') >= 0 ? { scrollTop: 0, scrollLeft: 0 } : null;
    },
  });
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
  els.tasksView.querySelector = function (sel) { return sel === '.tk-wk' ? this.calEl : null; };
  els.vacationTrigger.addEventListener('click', () => els.vacationPanel._cls.add('open'));

  const calls = [];
  let inflight = 0;
  const toasts = [];
  const body = makeEl('body');
  body.children = [];
  body.appendChild = function (el) { this.children.push(el); el.parentNode = this; };
  body.removeChild = function (el) { this.children = this.children.filter((c) => c !== el); el.parentNode = null; };
  const win = {};
  const docL = {};          // слушатели document (перетаскивание и меню ставят их на время жеста)
  const sandbox = {
    window: win, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Date, Math, String, Number, Array, Object, RegExp, Error, encodeURIComponent,
    CustomEvent: class { constructor(type) { this.type = type; } },
    document: {
      readyState: 'complete', head: makeEl('head'), body,
      getElementById: (id) => els[id] || null,
      createElement: (t) => makeEl(t),
      addEventListener(t, fn) { (docL[t] = docL[t] || []).push(fn); },
      removeEventListener(t, fn) { docL[t] = (docL[t] || []).filter((f) => f !== fn); },
      dispatchEvent() { return true; },
    },
    fetch: (url, opt) => {
      opt = opt || {};
      calls.push({ method: opt.method || 'GET', url, body: opt.body ? JSON.parse(opt.body) : null });
      inflight++;
      const headers = Object.assign({}, opt.headers || {}, cookie ? { Cookie: cookie } : {});
      return fetch(base + '/' + url, { method: opt.method || 'GET', headers, body: opt.body })
        .then((r) => {
          const readText = r.text.bind(r);
          r.text = () => readText().finally(() => { inflight--; });
          return r;
        }, (e) => { inflight--; throw e; });
    },
  };
  win.window = win;
  win.showToast = (text, type) => toasts.push({ text, type });
  win.confirm = () => true;
  Object.assign(win, sandbox);
  sandbox.window = win;
  vm.createContext(sandbox);
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
      if (m[1].indexOf('data-') === 0) ds[m[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = unesc(m[2]);
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
  // клик по элементу с data-tk-act (как делает браузер: closest('[data-tk-act]') → dataset)
  async function click(act, pred) {
    const t = findTag('data-tk-act', act, pred);
    if (!t) throw new Error('элемент data-tk-act="' + act + '" не отрендерен');
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
  return { sandbox, els, root, T, S: T.__t.S, U: T.__t, calls, toasts, settle, click, change, field, has, count, findTag, parseTag, body, docL,
    fireDoc(type, ev) { (docL[type] || []).slice().forEach((fn) => fn(ev)); } };
}

// ----------------------------------------------------------------------------
// разбор разметки календаря
// ----------------------------------------------------------------------------
function section(html, startMark, endMark) {
  const a = html.indexOf(startMark);
  if (a < 0) return '';
  const b = endMark ? html.indexOf(endMark, a + startMark.length) : -1;
  return b < 0 ? html.slice(a) : html.slice(a, b);
}
function tilesOf(html, P) {
  // плитки <div class="tk-ev …" …> (теги без вложенных div до закрытия, нам нужны только атрибуты)
  const out = [];
  const re = /<div class="tk-ev [^"]*"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = P.parseTag(m[0]);
    const st = t.attrs.style || '';
    const num = (r) => { const x = r.exec(st); return x ? parseFloat(x[1]) : null; };
    out.push({
      id: t.dataset.id, cls: t.attrs.class, title: t.attrs.title || '',
      top: num(/top:([\d.]+)px/), h: num(/height:([\d.]+)px/), left: num(/left:([\d.]+)%/), w: num(/width:calc\(([\d.]+)%/),
      col: t.dataset.col === undefined ? null : +t.dataset.col, cols: t.dataset.cols === undefined ? null : +t.dataset.cols,
      s: t.dataset.s === undefined ? null : +t.dataset.s, e: t.dataset.e === undefined ? null : +t.dataset.e,
    });
  }
  return out;
}
// плитки сетки часов по дням: { 'YYYY-MM-DD': [tile…] }
function bodyTilesByDay(P) {
  const body = section(P.root.innerHTML, 'class="tk-cal-bd"');
  const parts = body.split('<div class="tk-day').slice(1);
  const res = {};
  parts.forEach((p) => {
    const d = /data-date="([\d-]+)"/.exec(p)[1];
    res[d] = tilesOf(p, P);
  });
  return res;
}
function adTilesByDay(P) {
  const ad = section(P.root.innerHTML, 'data-tk-ad="1"', 'class="tk-cal-bd"');
  const parts = ad.split('<div class="tk-ad-c').slice(1);
  const res = {};
  parts.forEach((p) => {
    const d = /data-date="([\d-]+)"/.exec(p)[1];
    res[d] = tilesOf(p, P);
  });
  return res;
}

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

// воспроизводимый ГПСЧ для property-теста раскладки
function prng(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }

// ----------------------------------------------------------------------------
async function main() {
  console.log('=== V6-2 TASKS CALENDAR TEST ===');
  const P = makeEnv('http://127.0.0.1:1', '');
  const U = P.U;
  const HP = U.CAL_HOUR_PX;

  // ---- 1. R-11: раскладка пересечений (чистая функция) ------------------------
  console.log('-- R-11 раскладка');
  const iv = (k, s, e) => ({ k, s: s * 60, e: e * 60 });
  const lay = (arr) => { const r = U.calLayout(arr); const o = {}; r.forEach((x) => { o[x.k] = x; }); return o; };
  let L = lay([iv('a', 9, 10), iv('b', 9.5, 10.5)]);
  check('L1 две пересекающиеся задачи: 2 дорожки, разные колонки', L.a.cols === 2 && L.b.cols === 2 && L.a.col !== L.b.col && [L.a.col, L.b.col].sort().join() === '0,1', JSON.stringify(L));
  L = lay([iv('a', 9, 11), iv('b', 9.5, 10.5), iv('c', 10, 11.5)]);
  check('L2 три задачи с общим временем: 3 дорожки, колонки 0/1/2', L.a.cols === 3 && L.b.cols === 3 && L.c.cols === 3 && [L.a.col, L.b.col, L.c.col].sort().join() === '0,1,2', JSON.stringify(L));
  L = lay([iv('a', 9, 10), iv('b', 9.5, 10.5), iv('c', 10.25, 11)]);
  check('L3 частичное пересечение (a∩b, b∩c, a∩c нет): одна группа из 2 дорожек, c занимает дорожку a', L.a.cols === 2 && L.b.cols === 2 && L.c.cols === 2 && L.c.col === L.a.col && L.b.col !== L.a.col, JSON.stringify(L));
  L = lay([iv('a', 9, 10), iv('b', 10, 11)]);
  check('L4 касание концов (10:00 = 10:00) — не пересечение: обе во всю ширину', L.a.cols === 1 && L.b.cols === 1 && L.a.col === 0 && L.b.col === 0, JSON.stringify(L));
  L = lay([iv('a', 9, 10), iv('b', 9.5, 10.5), iv('c', 14, 15)]);
  check('L5 непересекающаяся задача не наследует дорожки чужой группы (cols=1), группа — 2', L.c.cols === 1 && L.c.col === 0 && L.a.cols === 2 && L.b.cols === 2);
  L = lay([iv('a', 9, 12), iv('b', 9, 10), iv('c', 10, 11), iv('d', 11, 12)]);
  check('L6 длинная задача + три последовательных короче внутри неё: 2 дорожки, короткие делят одну', L.a.cols === 2 && L.b.cols === 2 && L.b.col === L.c.col && L.c.col === L.d.col && L.a.col !== L.b.col, JSON.stringify(L));
  L = lay([iv('x', 8, 9), iv('y', 8, 9), iv('z', 8, 9)]);
  check('L7 три одинаковых интервала: 3 разные дорожки', L.x.cols === 3 && new Set([L.x.col, L.y.col, L.z.col]).size === 3);
  const base7 = [iv('a', 9, 10), iv('b', 9.5, 10.5), iv('c', 10.25, 11), iv('d', 14, 15), iv('e', 14.5, 16)];
  const sig = (o) => Object.keys(o).sort().map((k) => k + ':' + o[k].col + '/' + o[k].cols).join(' ');
  check('L8 результат не зависит от порядка входных данных', sig(lay(base7)) === sig(lay(base7.slice().reverse())) && sig(lay(base7)) === sig(lay([base7[3], base7[1], base7[4], base7[0], base7[2]])));
  {
    const rnd = prng(20261112);
    let bad = '';
    for (let trial = 0; trial < 400 && !bad; trial++) {
      const n = 1 + Math.floor(rnd() * 12), items = [];
      for (let i = 0; i < n; i++) { const s = Math.floor(rnd() * 46) * 30, d = (1 + Math.floor(rnd() * 6)) * 30; items.push({ k: 'k' + i, s, e: Math.min(1440, s + d) }); }
      const r = U.calLayout(items);
      for (const x of r) {
        if (!(x.cols >= 1 && x.col >= 0 && x.col < x.cols)) bad = 'range ' + JSON.stringify(x);
        for (const y of r) {
          if (x === y) continue;
          const over = x.s < y.e && y.s < x.e;
          if (over && x.col === y.col) bad = 'одна дорожка у пересекающихся ' + JSON.stringify([x, y]);
          if (over && x.cols !== y.cols) bad = 'разный cols в одной группе ' + JSON.stringify([x, y]);
        }
        if (!r.some((y) => y !== x && x.s < y.e && y.s < x.e) && x.cols !== 1) bad = 'одиночная не на всю ширину ' + JSON.stringify(x);
      }
    }
    check('L9 свойство (400 случайных дней): пересекающиеся — разные дорожки и один cols; одиночные — cols=1', bad === '', bad);
  }

  // ---- 2. R-9: интервал плитки -----------------------------------------------
  console.log('-- R-9 интервалы');
  const T1 = (s, e, f, l) => ({ first_day: f || '2099-03-04', last_day: l || f || '2099-03-04', start_at: s, end_at: e });
  const sl = (t) => U.calSlotOf(t);
  let r = sl(T1('2099-03-04T09:00', '2099-03-04T10:30'));
  check('S1 09:00–10:30 → 540…630 (top = начало, height = длительность)', r && r.s === 540 && r.e === 630);
  r = sl(T1('2099-03-04T14:00', null));
  check('S2 только время начала = 1 час', r && r.s === 840 && r.e === 900);
  r = sl(T1('2099-03-04T09:00', '2099-03-04T09:10'));
  check('S3 короче 30 мин → минимум 30 мин', r && r.e - r.s === 30);
  r = sl(T1('2099-03-04T23:30', null));
  check('S4 23:30 без конца: 1 час обрезается сеткой до 24:00', r && r.s === 1410 && r.e === 1440);
  check('S5 без времени → null («Весь день»)', sl(T1('2099-03-04', null)) === null && sl(T1('2099-03-04', '2099-03-04')) === null);
  check('S6 многодневная со временем → null («Весь день» на всех днях)', sl(T1('2099-03-04T09:00', '2099-03-06T18:00', '2099-03-04', '2099-03-06')) === null);
  r = sl(T1('2099-03-04T09:00', '2099-03-04'));
  check('S7 период одного дня, конец без времени → 1 час от начала', r && r.e - r.s === 60);

  // ---- 3. Рендер недели/дня (шим, задачи подставлены в состояние) -----------------
  console.log('-- R-9 / R-6 рендер');
  const wk = U.weekStart('2099-03-04');                 // понедельник
  const D = (n) => U.addDays(wk, n);
  const mon = D(0), tue = D(1), wed = D(2), sat = D(5), sun = D(6);
  const emps = [{ id: 'emp_1', name: 'Иванов Иван' }, { id: 'emp_2', name: 'Петров Пётр' }, { id: 'emp_3', name: 'Сидорова Анна' }];
  P.S.user = { role: 'admin', isAdmin: true };
  P.S.employees = emps; P.S.empById = {}; emps.forEach((e) => { P.S.empById[e.id] = e; });
  const mk = (id, title, start, end, extra) => Object.assign({
    id, title, description: 'Подробное описание ' + id, start_at: start, end_at: end || null,
    first_day: start.slice(0, 10), last_day: (end || start).slice(0, 10), status: 'open', archived: 0, priority: 2, version: 1,
    assignees: [{ employee_id: 'emp_1', full_name: 'Иванов Иван', removed: false, removed_at: null }], orphan: false, notes: [], conflict: false,
    conflict_days: [], check_state: 'ok', label: '', checklist: [], watchers: [],
  }, extra || {});
  const setCal = (tasks, mode, anchor) => {
    P.S.tasks = tasks; P.S.view = 'calendar'; P.S.cal.mode = mode; P.S.cal.anchor = anchor; P.S.cal.emp = ''; P.S.cal.only = false;
    P.S.form = null; P.S.selectedId = null; P.S.loading = false; P.S.cal.adAll = false; P.S.cal.scrollTop = null;
    P.U.render();
  };
  setCal([], 'week', wed);
  const html0 = P.root.innerHTML;
  check('W1 неделя: 7 колонок дней (tk-wk-h), понедельник…воскресенье, колонка часов', P.count('class="tk-wk-h') === 7 && P.count('class="tk-day') === 7 && P.count('class="tk-gut"') === 2);
  const hrLabels = (html0.match(/<div class="tk-hr">(\d\d:00)<\/div>/g) || []).map((s) => s.replace(/\D/g, '').slice(0, 2));
  check('W2 колонка часов: 24 подписи 00…23 по порядку', hrLabels.length === 24 && hrLabels.every((v, i) => +v === i), hrLabels.join(','));
  check('W3 каждый день — 48 ячеек по 30 мин (24 часовых + 24 «получасовых» линии)',
    P.count('class="tk-slot"') === 7 * 24 && P.count('class="tk-slot tk-half"') === 7 * 24 && P.count('data-tk-act="calCell"') === 7 * 48);
  check('W4 пустой период: «На этот период задач нет.», сетка при этом остаётся', P.has('На этот период задач нет') && P.has('class="tk-cal-bd"'));
  check('W5 высота часа 48 px (в пределах 40–48): CAL_HOUR_PX', HP === 48);
  {
    const css = (SRC.match(/\.tk-hr\{height:' \+ CAL_HOUR_PX/) || [])[0];
    check('W6 строка часа и ячейка получаса задаются из CAL_HOUR_PX (равная высота всех 24 строк)', !!css && /\.tk-slot\{height:' \+ \(CAL_HOUR_PX \/ 2\)/.test(SRC));
  }

  const tasks = [
    mk('t_a', 'Планёрка', wed + 'T09:00', wed + 'T10:30'),
    mk('t_b', 'Только начало', wed + 'T14:00'),
    mk('t_c', 'Короткая', wed + 'T16:00', wed + 'T16:10'),
    mk('t_d', 'Поздняя', wed + 'T23:30'),
    mk('t_e', 'Без времени', wed),
    mk('t_f', 'Командировка-период', tue + 'T09:00', D(4) + 'T18:00'),
    mk('t_g', 'Период без времени', sat, sun),
    mk('t_h', 'Полночь', wed + 'T00:00', wed + 'T01:00'),
  ];
  setCal(tasks, 'week', wed);
  let bd = bodyTilesByDay(P), ad = adTilesByDay(P);
  const tile = (day, id) => (bd[day] || []).find((x) => x.id === id);
  let x = tile(wed, 't_a');
  check('P1 09:00–10:30: top=432px (9×48), height=72px', x && x.top === 432 && x.h === 72, JSON.stringify(x));
  x = tile(wed, 't_b');
  check('P2 только начало 14:00: top=672px, height=48px (1 час)', x && x.top === 672 && x.h === 48, JSON.stringify(x));
  x = tile(wed, 't_c');
  check('P3 16:00–16:10: height = 24px (минимум 30 мин)', x && x.top === 768 && x.h === 24, JSON.stringify(x));
  x = tile(wed, 't_d');
  check('P4 23:30 без конца: плитка помещается в сетку (top=1128, height=24 → до 1152)', x && x.top === 1128 && x.top + x.h <= 24 * HP, JSON.stringify(x));
  x = tile(wed, 't_h');
  check('P5 00:00–01:00: top=0, height=48', x && x.top === 0 && x.h === 48, JSON.stringify(x));
  check('P6 плитки дня не пересекаются → каждая во всю ширину (left 0%, width calc(100% - 6px), cols=1)',
    ['t_a', 't_b', 't_c', 't_d', 't_h'].every((id) => { const q = tile(wed, id); return q && q.cols === 1 && q.col === 0 && q.left === 0 && q.w === 100; }));
  check('P7 задача без времени — в полосе «Весь день» (tk-ev-ad), в сетке часов её нет',
    (ad[wed] || []).some((q) => q.id === 't_e' && /tk-ev-ad/.test(q.cls)) && !tile(wed, 't_e') && !P.root.innerHTML.slice(P.root.innerHTML.indexOf('class="tk-cal-bd"')).includes('data-id="t_e"'));
  check('P8 многодневная со временем (вт 09:00 → пт 18:00): «Весь день» на всех 4 днях, не в сетке часов',
    [1, 2, 3, 4].every((n) => (ad[D(n)] || []).some((q) => q.id === 't_f')) && !(ad[mon] || []).some((q) => q.id === 't_f') &&
    !Object.keys(bd).some((d) => tile(d, 't_f')));
  check('P9 период без времени (сб–вс): «Весь день» в обе даты', (ad[sat] || []).some((q) => q.id === 't_g') && (ad[sun] || []).some((q) => q.id === 't_g'));
  {
    const adHtml = section(P.root.innerHTML, 'data-tk-ad="1"', 'class="tk-cal-bd"');
    check('P10 многодневная: «09:00 →» в первый день, «…» в середине, «→ 18:00» в последний',
      /data-date="[\d-]+">[\s\S]*?<span class="tk-ev-when">09:00 →<\/span>/.test(adHtml) && adHtml.includes('<span class="tk-ev-when">…</span>') && adHtml.includes('<span class="tk-ev-when">→ 18:00</span>'));
  }
  check('P11 в шапке «Весь день» подписана строка', P.has('class="tk-gut tk-gut-ad">Весь день<'));

  // ---- 3a. «Весь день»: больше 3 → «+N ещё»
  setCal([1, 2, 3, 4, 5].map((n) => mk('ad' + n, 'Весь день ' + n, wed)), 'week', wed);
  let adc = adTilesByDay(P);
  check('A1 в полосе «Весь день» показано 3 задачи и кнопка «+2 ещё»', adc[wed].length === 3 && P.has('data-tk-act="calAdToggle">+2 ещё<'));
  await P.click('calAdToggle');
  adc = adTilesByDay(P);
  check('A2 «+2 ещё» разворачивает все 5, появляется «свернуть»; повторный клик сворачивает обратно',
    adc[wed].length === 5 && P.has('>свернуть<') && !P.has('+2 ещё') && ((await P.click('calAdToggle')), adTilesByDay(P)[wed].length === 3));

  // ---- 3b. День
  setCal(tasks, 'day', wed);
  const bd1 = bodyTilesByDay(P);
  check('D1 режим «День»: одна колонка, 48 ячеек, 24 подписи часов, те же позиции плиток',
    P.count('class="tk-wk-h') === 1 && P.count('data-tk-act="calCell"') === 48 && P.count('class="tk-hr"') === 24 &&
    (bd1[wed].find((q) => q.id === 't_a') || {}).top === 432 && (bd1[wed].find((q) => q.id === 't_a') || {}).h === 72);
  check('D2 режим «День»: «Весь день» содержит безвременную и многодневную, но не задачи других дней', adTilesByDay(P)[wed].map((q) => q.id).sort().join() === 't_e,t_f');

  // ---- 3c. Раскладка в рендере (R-11 в разметке)
  setCal([
    mk('o1', 'Один', wed + 'T09:00', wed + 'T10:00'), mk('o2', 'Два', wed + 'T09:30', wed + 'T10:30'), mk('o3', 'Три', wed + 'T09:45', wed + 'T11:00'),
    mk('n1', 'Следом', wed + 'T11:00', wed + 'T12:00'), mk('s1', 'Одиночная', wed + 'T15:00', wed + 'T16:00'),
    mk('m1', 'Утром', tue + 'T09:00', tue + 'T10:00'),
  ], 'week', wed);
  bd = bodyTilesByDay(P);
  const q1 = tile(wed, 'o1'), q2 = tile(wed, 'o2'), q3 = tile(wed, 'o3');
  check('R11-1 три пересекающиеся: каждая шириной 1/3 колонки (width calc(33.3333% - 6px)), left 0 / 33.3333% / 66.6667%',
    [q1, q2, q3].every((q) => q && q.cols === 3 && q.w === 33.3333) && [q1.left, q2.left, q3.left].sort((a, b) => a - b).join() === '0,33.3333,66.6667', JSON.stringify([q1, q2, q3]));
  check('R11-2 «следом» (касание 11:00 = 11:00 — не пересечение с o3) и одиночная — во всю ширину', tile(wed, 'n1').cols === 1 && tile(wed, 'n1').w === 100 && tile(wed, 's1').cols === 1);
  check('R11-3 раскладка независима по дням: во вторник одна задача во всю ширину', tile(tue, 'm1').cols === 1 && tile(tue, 'm1').left === 0);
  check('R11-4 пересекающиеся плитки не накладываются: дорожки по горизонтали не пересекаются',
    (() => { const a = [q1, q2, q3].sort((x1, x2) => x1.left - x2.left); return a[0].left + a[0].w <= a[1].left + 0.0001 && a[1].left + a[1].w <= a[2].left + 0.0001; })());
  check('R11-5 узкие плитки недели (3+ дорожек) помечены tk-ev-n (скрыто время, остаётся тема; время — в подсказке); широкие и режим «День» — нет',
    [q1, q2, q3].every((q) => /tk-ev-n/.test(q.cls)) && !/tk-ev-n/.test(tile(wed, 'n1').cls) && /09:00–10:00/.test(q1.title));
  const nCss = (/\.tk-ev\.tk-ev-n\{([^}]*)\}/.exec(SRC) || [])[1] || '';
  check('R11-7 V6-5 (P2-2) узкая плитка недели: тема в одну строку с «…» (white-space:nowrap; overflow:hidden; text-overflow:ellipsis), без переноса по буквам (нет word-break); полная тема — в title',
    /white-space:nowrap/.test(nCss) && /overflow:hidden/.test(nCss) && /text-overflow:ellipsis/.test(nCss) && !/word-break|overflow-wrap/.test(nCss) &&
    [[q1, 'Один'], [q2, 'Два'], [q3, 'Три']].every((p) => p[0].title.split('\n')[0] === p[1]), nCss);
  check('R11-8 V6-5: правило нарезки действует только на .tk-ev-n — обычная плитка (.tk-ev-t) и «День» не получают nowrap/ellipsis; word-break:break-word в плитках нет',
    !/\.tk-ev\.tk-ev-t\{[^}]*(nowrap|ellipsis)/.test(SRC) && !/\.tk-ev[^{]*\{[^}]*word-break/.test(SRC) && !/tk-ev-n/.test(tile(wed, 'n1').cls));
  P.S.cal.mode = 'day'; P.U.render();
  check('R11-6 режим «День»: те же 3 дорожки, но время на плитках не скрывается (нет tk-ev-n)',
    (() => { const b = bodyTilesByDay(P)[wed]; return b.filter((q) => q.cols === 3).length === 3 && b.every((q) => !/tk-ev-n/.test(q.cls)); })());
  P.S.cal.mode = 'week'; P.U.render();

  // ---- 3d. «Сейчас»
  const todayStr = (() => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); })();
  const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
  let m0 = nowMin();
  setCal([], 'week', todayStr);
  let m1 = nowMin();
  const nowTop = (() => { const mm = /class="tk-now" style="top:([\d.]+)px"/.exec(P.root.innerHTML); return mm ? parseFloat(mm[1]) : null; })();
  check('N1 «Сегодня» в текущей неделе: ровно одна линия «сейчас», top = минуты × 0.8 px', P.count('class="tk-now"') === 1 && nowTop !== null && nowTop >= m0 * 0.8 - 0.01 && nowTop <= m1 * 0.8 + 0.01, nowTop + ' vs ' + m0 * 0.8);
  check('N2 линия «сейчас» стоит в колонке сегодняшнего дня', (/<div class="tk-day[^"]*" data-date="([\d-]+)">(?:(?!<div class="tk-day)[\s\S])*?class="tk-now"/.exec(P.root.innerHTML) || [])[1] === todayStr);
  setCal([], 'week', U.addDays(todayStr, 14));
  check('N3 неделя без сегодняшнего дня — линии «сейчас» нет', P.count('class="tk-now"') === 0);
  setCal([], 'day', todayStr);
  check('N4 режим «День» на сегодня — линия «сейчас» есть', P.count('class="tk-now"') === 1);

  // ---- 3e. Прокрутка
  setCal(tasks, 'week', wed);
  check('SC1 при открытии календаря прокрутка на 08:00 (scrollTop = 8 × 48 = 384)', P.root.calEl && P.root.calEl.scrollTop === 8 * HP, P.root.calEl && P.root.calEl.scrollTop);
  P.root.calEl.scrollTop = 700;
  P.U.render();
  check('SC2 перерисовка (выбор плитки, синхронизация) не сбрасывает прокрутку', P.root.calEl.scrollTop === 700);
  await P.click('openTask', (d) => d.id === 't_a');
  check('SC3 клик по плитке (карточка справа) — прокрутка сохраняется', P.S.selectedId === 't_a' && P.root.calEl.scrollTop === 700);
  P.root.calEl.scrollTop = 900;
  await P.click('calCell', (d) => d.date === wed && d.min === '600');
  check('SC4 форма «Новая задача» из ячейки открыта', P.S.form && P.has('class="tk-form"') && P.root.calEl === null);
  await P.click('cancelForm');
  check('SC5 после «Отмена» формы календарь возвращается на прежнюю прокрутку (900)', P.S.form === null && P.root.calEl && P.root.calEl.scrollTop === 900);
  P.S.view = 'list'; P.U.render();
  P.S.view = 'calendar'; P.U.render();
  check('SC6 вернулись в календарь из «Списка» — снова 08:00', P.root.calEl && P.root.calEl.scrollTop === 8 * HP);

  // ---- 4. R-6: содержимое плитки -------------------------------------------------
  console.log('-- R-6 плитка');
  const evil = '<img src=x onerror=alert(1)>';
  const t6 = [
    mk('r6a', 'Подготовить отчёт', wed + 'T09:00', wed + 'T10:00', { assignees: [{ employee_id: 'emp_1', full_name: 'Иванов Иван', removed: false }, { employee_id: 'emp_2', full_name: 'Петров Пётр', removed: false }] }),
    mk('r6b', 'Конфликтная', wed + 'T11:00', wed + 'T12:00', { conflict: true, conflict_days: [{ date: wed, employee_id: 'emp_1', reason: 'sick' }], check_state: 'pending' }),
    mk('r6c', 'Осиротевшая', wed + 'T13:00', wed + 'T14:00', { orphan: true, assignees: [{ employee_id: 'x9', full_name: 'Удалённый Первый', removed: true, removed_at: null }] }),
    mk('r6d', evil, wed + 'T15:00', wed + 'T16:00', { assignees: [{ employee_id: 'emp_9', full_name: evil, removed: false }] }),
    mk('r6e', 'Обычная без значков', wed),
  ];
  setCal(t6, 'week', wed);
  const rawTile = (id) => { const h = P.root.innerHTML; const i = h.indexOf('data-id="' + id + '"'); const a = h.lastIndexOf('<div class="tk-ev', i); return h.slice(a, h.indexOf('</div>', i) + 6); };
  const visible = (h) => h.replace(/ title="[^"]*"/g, '');
  let tl = rawTile('r6a');
  check('T1 плитка: время и тема жирно (<b class="tk-ev-title">)', tl.includes('<span class="tk-ev-when">09:00–10:00</span>') && tl.includes('<b class="tk-ev-title">Подготовить отчёт</b>'), tl);
  check('T2 ФИО и описание на плитке не выводятся', !visible(tl).includes('Иванов') && !visible(tl).includes('Петров') && !visible(tl).includes('Подробное описание') && !tl.includes('tk-ev-desc'));
  check('T3 исполнители перечислены в подсказке (title)', tl.includes('Исполнители: Иванов Иван, Петров Пётр'));
  check('T4 у обычной плитки нет значков', !/tk-ev-ic/.test(rawTile('r6a')) && !/tk-ev-ic/.test(rawTile('r6e')));
  tl = rawTile('r6b');
  check('T5 конфликт и «не проверено» — компактные значки (tk-ic-conf «!», tk-ic-pend «?»), не текст «⚠ конфликт»',
    tl.includes('<span class="tk-ev-ic tk-ic-conf" title="Конфликт">!</span>') && tl.includes('<span class="tk-ev-ic tk-ic-pend" title="Не проверено">?</span>') && !visible(tl).includes('⚠ конфликт') && !visible(tl).includes('>не проверено<'), tl);
  check('T6 подсказка конфликтной плитки содержит причину (больничный) и «Не проверено»', /title="[^"]*Конфликт: больничный[^"]*Не проверено/.test(tl.replace(/\n/g, ' ')) || (tl.includes('Конфликт: больничный') && tl.includes('Не проверено')), tl);
  tl = rawTile('r6c');
  check('T7 «без исполнителя» — значок tk-ic-orph (title «Без исполнителя»), пунктирная рамка tk-orph, ФИО не на плитке',
    tl.includes('tk-orph') && tl.includes('<span class="tk-ev-ic tk-ic-orph" title="Без исполнителя">0</span>') && !visible(tl).includes('Удалённый'), tl);
  tl = rawTile('r6d');
  check('T8 экранирование: тема и ФИО с HTML не создают тегов (ни в тексте, ни в title)', !P.root.innerHTML.includes('<img src=x') && tl.includes('&lt;img src=x onerror=alert(1)&gt;'), tl);
  check('T9 плитка в полосе «Весь день» устроена так же (тема жирно, без ФИО/описания)', rawTile('r6e').includes('<b class="tk-ev-title">Обычная без значков</b>') && !visible(rawTile('r6e')).includes('Иванов'));
  P.S.tasks = [mk('cl', 'Закрытая', wed + 'T09:00', wed + 'T10:00', { status: 'closed' }), mk('sl', 'Выбранная', wed + 'T11:00', wed + 'T12:00')]; P.S.selectedId = 'sl'; P.U.render();
  check('T10 закрытая — приглушена (tk-dim), выбранная — «tk-ev tk-sel» (совместимо с tasksui E23/E27)', rawTile('cl').includes('tk-dim') && rawTile('sl').includes('class="tk-ev tk-sel'));
  P.S.selectedId = null;
  P.S.tasks = [mk('vc', 'Отпуск у исполнителя', wed + 'T09:00', wed + 'T10:00', { notes: [{ date: wed, kind: 'vacation', label: '' }] })]; P.U.render();
  check('T11 пометка «отпуск/выходной» из плитки убрана (только подсказка), на плитке нет tk-tag', !visible(rawTile('vc')).includes('tk-tag') && !visible(rawTile('vc')).includes('отпуск'));

  // ---- 5. R-3: поля времени ------------------------------------------------------
  console.log('-- R-3 время');
  const opts = (html) => { const out = []; const re = /<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g; let m; while ((m = re.exec(html)) !== null) out.push({ v: m[1], sel: !!m[2], l: m[3] }); return out; };
  let o = opts(U.timeOptionsHtml(''));
  check('F1 список времени: «—», 00:00, 00:30 … 23:30 (49 пунктов, шаг 30 мин), выбрано «—»',
    o.length === 49 && o[0].v === '' && o[0].l === '—' && o[0].sel && o[1].v === '00:00' && o[2].v === '00:30' && o[48].v === '23:30' &&
    o.slice(1).every((q, i) => q.v === String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00')) && o.filter((q) => q.sel).length === 1);
  o = opts(U.timeOptionsHtml('09:07'));
  check('F2 некратное время: отдельный выбранный пункт 09:07 между 09:00 и 09:30 (50 пунктов)',
    o.length === 50 && o.findIndex((q) => q.v === '09:07') === o.findIndex((q) => q.v === '09:00') + 1 && o.filter((q) => q.sel).length === 1 && o.find((q) => q.sel).v === '09:07');
  o = opts(U.timeOptionsHtml('09:30'));
  check('F3 кратное 30 значение выбирается в обычном списке (49 пунктов, без дублей)', o.length === 49 && o.find((q) => q.sel).v === '09:30');
  P.S.tasks = []; P.S.view = 'list'; P.S.form = null; P.U.render();
  await P.click('newTask');
  check('F4 форма: поле «Дата/начало» — <select> со списком, <input type="time"> в форме нет',
    P.findTag('data-tk-field', 'startTime') && /<select class="tk-time" data-tk-field="startTime">/.test(P.root.innerHTML) && !/type="time"/.test(P.root.innerHTML));
  await P.field('kind', 'period');
  check('F5 «Период»: и «Начало», и «Конец» — списки времени; 2 × 49 пунктов',
    /<select class="tk-time" data-tk-field="endTime">/.test(P.root.innerHTML) && !/type="time"/.test(P.root.innerHTML) && opts(section(P.root.innerHTML, 'data-tk-field="startTime"', 'data-tk-field="priority"')).length >= 98);
  await P.field('startTime', '09:30'); await P.field('endTime', '');
  check('F6 выбор в списке попадает в черновик; «—» = пусто', P.S.form.draft.startTime === '09:30' && P.S.form.draft.endTime === '');
  const pl1 = P.U.buildPayload(Object.assign({}, P.S.form.draft, { title: 'x', assignees: ['emp_1'], startDate: '2099-03-04', endDate: '2099-03-04' }), true);
  check('F7 контракт API не меняется: start_at «YYYY-MM-DDTHH:MM», пустое время → только дата', pl1.start_at === '2099-03-04T09:30' && pl1.end_at === '2099-03-04');
  P.S.form = null;
  // существующая задача с некратным временем
  const odd = mk('odd', 'Некратное', '2099-03-04T09:07', '2099-03-04T10:13', { assignees: [{ employee_id: 'emp_1', full_name: 'Иванов Иван', removed: false }] });
  P.S.tasks = [odd]; P.S.view = 'list'; P.U.render();
  P.U.ACTIONS.editTask({ dataset: { id: 'odd' } });
  {
    const fh = P.root.innerHTML;
    const st = opts(section(fh, 'data-tk-field="startTime"', '</select>')), en = opts(section(fh, 'data-tk-field="endTime"', '</select>'));
    check('F8 правка задачи 09:07–10:13: оба некратных значения показаны выбранными пунктами', st.find((q) => q.sel).v === '09:07' && en.find((q) => q.sel).v === '10:13' && st.length === 50 && en.length === 50);
    const pl = P.U.buildPayload(P.S.form.draft, false);
    check('F9 без смены времени сохраняется без изменений: start_at …T09:07, end_at …T10:13', pl.start_at === '2099-03-04T09:07' && pl.end_at === '2099-03-04T10:13', JSON.stringify(pl));
    await P.field('startTime', '09:30');
    const pl2 = P.U.buildPayload(P.S.form.draft, false);
    P.U.render();   // следующая перерисовка формы: пункта 09:07 в списке начала уже нет (черновик хранит 09:30)
    check('F10 после смены начала 09:30 меняется только оно; конец 10:13 не тронут; пункта 09:07 в списке начала больше нет',
      pl2.start_at === '2099-03-04T09:30' && pl2.end_at === '2099-03-04T10:13' && opts(section(P.root.innerHTML, 'data-tk-field="startTime"', '</select>')).every((q) => q.v !== '09:07') &&
      opts(section(P.root.innerHTML, 'data-tk-field="endTime"', '</select>')).some((q) => q.v === '10:13' && q.sel));
  }
  P.S.form = null;

  // ---- 6. R-10: клик по ячейке (черновик) --------------------------------------------
  console.log('-- R-10 клик по ячейке');
  setCal([mk('exist', 'Существующая', wed + 'T10:00', wed + 'T11:00')], 'week', wed);
  const slotAt = (day, min) => P.findTag('data-tk-act', 'calCell', (d) => d.date === day && d.min === String(min));
  check('C0 у каждой ячейки есть день и минута начала (data-date, data-min = 0…1410 с шагом 30)', slotAt(wed, 0) && slotAt(wed, 30) && slotAt(wed, 1410) && !slotAt(wed, 1440) && !slotAt(wed, 15));
  await P.click('calCell', (d) => d.date === wed && d.min === '600');
  let dr = P.S.form && P.S.form.draft;
  check('C1 клик по ячейке среды 10:00 → «Новая задача»: дата=среда, начало 10:00, конец 11:00, «Период»',
    !!P.S.form && P.S.form.id === null && dr.startDate === wed && dr.endDate === wed && dr.startTime === '10:00' && dr.endTime === '11:00' && dr.kind === 'period' && P.has('<h4>Новая задача</h4>'), JSON.stringify(dr));
  check('C2 в форме выбраны: «Период», в списках — 10:00 и 11:00, поля даты = день ячейки',
    P.findTag('name', 'tkKind', (d, t) => t.attrs.value === 'period' && t.checked) !== null &&
    opts(section(P.root.innerHTML, 'data-tk-field="startTime"', '</select>')).find((q) => q.sel).v === '10:00' && opts(section(P.root.innerHTML, 'data-tk-field="endTime"', '</select>')).find((q) => q.sel).v === '11:00' &&
    P.has('data-tk-field="startDate" value="' + wed + '"') && P.has('data-tk-field="endDate" value="' + wed + '"'));
  check('C3 остальные поля формы — как у обычной новой задачи (пустые название/исполнители, приоритет 2)', dr.title === '' && dr.assignees.length === 0 && dr.priority === 2 && dr.checklist.length === 0);
  await P.click('cancelForm');
  const cases = [[sat, 0, '00:00', '01:00'], [D(1), 30, '00:30', '01:30'], [mon, 630, '10:30', '11:30'], [sun, 1320, '22:00', '23:00'], [wed, 1380, '23:00', '23:59'], [wed, 1410, '23:30', '23:59']];
  for (const [day, min, st, en] of cases) {
    await P.click('calCell', (d) => d.date === day && d.min === String(min));
    dr = P.S.form.draft;
    check('C4 ячейка ' + day + ' ' + st + ' → начало ' + st + ', конец ' + en + (en === '23:59' ? ' (не выходит за сутки)' : ' (+1 ч)'), dr.startDate === day && dr.endDate === day && dr.startTime === st && dr.endTime === en && dr.kind === 'period', JSON.stringify(dr));
    await P.click('cancelForm');
  }
  check('C5 клик в нижнюю половину часа (10:30) даёт начало hh:30, в верхнюю — hh:00 (ячейки data-min 600 и 630)', U.calSlotDraft(wed, 630).startTime === '10:30' && U.calSlotDraft(wed, 600).startTime === '10:00');
  {
    const eDay = P.S.cal.anchor;
    await P.click('calCell', (d) => d.date === wed && d.min === '720');
    await P.field('title', 'Из календаря');
    const drf = P.S.form.draft;
    const pl = P.U.buildPayload(Object.assign({}, drf, { assignees: ['emp_1'] }), true);
    check('C6 отправка: start_at = «день»T12:00, end_at = «день»T13:00 (формат API прежний)', pl.start_at === wed + 'T12:00' && pl.end_at === wed + 'T13:00' && P.U.draftError(Object.assign({}, drf, { assignees: ['emp_1'] })) === '', JSON.stringify(pl));
    await P.click('cancelForm');
    check('C7 «Отмена» возвращает в тот же календарь (неделя не сменилась)', P.S.view === 'calendar' && P.S.cal.anchor === eDay && P.has('class="tk-wk"'));
  }
  // клик по плитке — как раньше
  await P.click('openTask', (d) => d.id === 'exist');
  check('C8 клик по плитке открывает карточку (не форму «Новая задача»)', P.S.selectedId === 'exist' && P.S.form === null && P.has('class="tk-detail"') && P.has('Существующая'));
  {
    // плитка рендерится ПОВЕРХ ячейки; сама плитка не содержит calCell — клик по ней не создаёт задачу
    const tileTag = rawTile('exist');
    check('C9 разметка: плитка — data-tk-act="openTask" (а не calCell); ячейки — отдельные элементы под плиткой', tileTag.includes('data-tk-act="openTask"') && !tileTag.includes('calCell'));
  }
  // «День»: клик
  setCal([], 'day', wed);
  await P.click('calCell', (d) => d.date === wed && d.min === '1020');
  check('C10 режим «День»: клик по 17:00 → начало 17:00, конец 18:00', P.S.form.draft.startTime === '17:00' && P.S.form.draft.endTime === '18:00' && P.S.form.draft.startDate === wed);
  await P.click('cancelForm');

  // ---- 7. роли: supervisor / viewer — клик ничего не делает ---------------------------
  for (const role of ['supervisor', 'viewer']) {
    const Q = makeEnv('http://127.0.0.1:1', '');
    Q.S.user = { role, isAdmin: false }; Q.S.employees = emps; Q.S.empById = {}; emps.forEach((e) => { Q.S.empById[e.id] = e; });
    Q.S.tasks = [mk('rv', 'Видна всем', wed + 'T09:00', wed + 'T10:00')]; Q.S.view = 'calendar'; Q.S.cal.mode = 'week'; Q.S.cal.anchor = wed; Q.U.render();
    check('RL-' + role + '-1 календарь рисуется (плитки на месте), но ячеек для создания нет: ни calCell, ни tk-can',
      Q.count('class="tk-ev') >= 1 && !Q.has('calCell') && !Q.has('tk-can') && Q.count('class="tk-slot') === 7 * 48 && !Q.has('<form'));
    const before = Q.calls.length;
    Q.U.ACTIONS.calCell({ dataset: { date: wed, min: '600' } });
    Q.root.fire('click', { target: { closest: () => ({ dataset: { tkAct: 'calCell', date: wed, min: '600' } }) }, preventDefault() {} });
    await Q.settle();
    check('RL-' + role + '-2 принудительный клик по ячейке (обработчик и событие): форма не открыта, запросов нет, состояние не изменилось',
      Q.S.form === null && Q.calls.length === before && !Q.has('<form') && Q.S.view === 'calendar');
    Q.U.ACTIONS.openTask({ dataset: { id: 'rv' } });
    check('RL-' + role + '-3 клик по плитке открывает карточку (только просмотр), без кнопок записи', Q.S.selectedId === 'rv' && Q.has('class="tk-detail"') && !Q.has('data-tk-act="editTask"'));
  }

  // ---- 7a. V6.2-2 (W-5): новое время при сбросе (чистая функция) -------------------------------
  console.log('-- W-5 расчёт сброса');
  const dc = (t, tgt) => U.calDropCalc(t, tgt);
  const tt = (s, e, f, l) => mk('x', 'Т', s, e, f ? { first_day: f, last_day: l || f } : undefined);
  let c = dc(tt(wed + 'T09:00', wed + 'T10:30'), { kind: 'slot', date: D(3), min: 840 });
  check('DR1 «Неделя»: 09:00–10:30 → чт 14:00: начало 14:00, длительность 1 ч 30 мин сохранена (конец 15:30), день сменился',
    c.start_at === D(3) + 'T14:00' && c.end_at === D(3) + 'T15:30' && c.first_day === D(3) && c.last_day === D(3), JSON.stringify(c));
  check('DR2 привязка к шагу 30 мин: 10:07 → 10:00, 10:20 → 10:30, 10:15 → 10:30 (округление к ближайшему)',
    dc(tt(wed + 'T09:00', wed + 'T10:00'), { kind: 'slot', date: wed, min: 607 }).start_at === wed + 'T10:00' &&
    dc(tt(wed + 'T09:00', wed + 'T10:00'), { kind: 'slot', date: wed, min: 620 }).start_at === wed + 'T10:30' &&
    dc(tt(wed + 'T09:00', wed + 'T10:00'), { kind: 'slot', date: wed, min: 615 }).start_at === wed + 'T10:30');
  c = dc(tt(wed + 'T14:00', null), { kind: 'slot', date: tue, min: 600 });
  check('DR3 задача только с началом: время сменилось, конца по-прежнему нет (end_at = null)', c.start_at === tue + 'T10:00' && c.end_at === null, JSON.stringify(c));
  c = dc(tt(wed + 'T09:00', wed + 'T11:00'), { kind: 'slot', date: wed, min: 1380 });
  check('DR4 граница суток: 2-часовая задача на 23:00 → конец не за 23:59 (23:00–23:59)', c.start_at === wed + 'T23:00' && c.end_at === wed + 'T23:59' && c.last_day === wed, JSON.stringify(c));
  c = dc(tt(wed + 'T09:00', wed + 'T10:00'), { kind: 'slot', date: wed, min: 1410 });
  check('DR4a 23:30 с 1-часовой: 23:30–23:59', c.start_at === wed + 'T23:30' && c.end_at === wed + 'T23:59', JSON.stringify(c));
  c = dc(tt(wed + 'T09:00', wed + 'T10:00'), { kind: 'slot', date: wed, min: 5000 });
  check('DR4b ниже сетки (min > 23:30) — прижимается к 23:30, не выходит за сутки; выше (min < 0) — к 00:00',
    c.start_at === wed + 'T23:30' && dc(tt(wed + 'T09:00', wed + 'T10:00'), { kind: 'slot', date: wed, min: -90 }).start_at === wed + 'T00:00');
  check('DR5 отпустили на старом месте — «без изменений»: тот же день и тот же получас (в т.ч. 09:07 ≈ 09:00)',
    dc(tt(wed + 'T09:00', wed + 'T10:30'), { kind: 'slot', date: wed, min: 540 }).unchanged === true &&
    dc(tt(wed + 'T09:07', wed + 'T10:13'), { kind: 'slot', date: wed, min: 540 }).unchanged === true);
  check('DR5a тот же час, но другой день — это изменение; тот же день, другой час — тоже',
    !dc(tt(wed + 'T09:00', wed + 'T10:30'), { kind: 'slot', date: tue, min: 540 }).unchanged && !dc(tt(wed + 'T09:00', wed + 'T10:30'), { kind: 'slot', date: wed, min: 570 }).unchanged);
  c = dc(tt(tue + 'T09:00', D(4) + 'T18:00', tue, D(4)), { kind: 'days', days: 2 });
  check('DR6 многодневная (вт 09:00 → пт 18:00) +2 дня: оба конца сдвинуты, время суток сохранено',
    c.start_at === D(3) + 'T09:00' && c.end_at === D(6) + 'T18:00' && c.first_day === D(3) && c.last_day === D(6), JSON.stringify(c));
  c = dc(tt(wed, null), { kind: 'days', days: -3 });
  check('DR7 «Весь день»: задача без времени −3 дня — меняется только дата, времени не появляется', c.start_at === D(-1) && c.end_at === null && c.first_day === D(-1), JSON.stringify(c));
  c = dc(tt(sat, sun, sat, sun), { kind: 'days', days: 7 });
  check('DR7a период без времени (сб–вс) +7: обе даты, без времени', c.start_at === D(12) && c.end_at === D(13), JSON.stringify(c));
  check('DR8 сдвиг на 0 дней — «без изменений»', dc(tt(wed, null), { kind: 'days', days: 0 }).unchanged === true);
  c = dc(tt(wed + 'T14:30', wed + 'T15:30'), { kind: 'days', days: 5 });
  check('DR9 «Месяц» (сдвиг на день): время сохраняется — 14:30–15:30 остаются, дата +5', c.start_at === D(7) + 'T14:30' && c.end_at === D(7) + 'T15:30' && c.last_day === D(7), JSON.stringify(c));
  check('DR10 плитка без времени не принимает «slot» (ошибка), неверные аргументы — ошибка',
    dc(tt(wed, null), { kind: 'slot', date: wed, min: 600 }).error === 'not_timed' && dc(tt(wed, null), { kind: 'x' }).error === 'bad_args' && dc(null, { kind: 'days', days: 1 }).error === 'bad_args');
  c = dc(tt('2099-03-30T10:00', '2099-03-30T11:00', '2099-03-30'), { kind: 'days', days: 3 });
  check('DR11 переход через границу месяца: 30.03 + 3 дня = 02.04', c.start_at === '2099-04-02T10:00' && c.end_at === '2099-04-02T11:00', JSON.stringify(c));
  c = dc(tt(wed + 'T09:00', wed), { kind: 'slot', date: tue, min: 600 });
  check('DR12 конец без времени (только дата) при сбросе в сетку: начало 10:00, конец = новая дата без времени', c.start_at === tue + 'T10:00' && c.end_at === tue, JSON.stringify(c));
  check('DR13 в запрос «Весь день» время суток не появляется и не теряется: многодневная с временем в «Весь день» — время концов прежнее',
    dc(tt(tue + 'T09:30', D(3) + 'T17:45', tue, D(3)), { kind: 'days', days: 1 }).start_at === wed + 'T09:30' && dc(tt(tue + 'T09:30', D(3) + 'T17:45', tue, D(3)), { kind: 'days', days: 1 }).end_at === D(4) + 'T17:45');

  // ---- 7b. V6.2-2 (W-6): состав и срок копии ----------------------------------------------
  console.log('-- W-6 копия');
  const pc = (t, tgt) => U.calPasteCalc(U.calClipOf(t), tgt);
  c = pc(mk('p', 'П', wed + 'T09:00', wed + 'T10:30'), { kind: 'slot', date: D(3), min: 900 });
  check('PC1 вставка в ячейку чт 15:00: начало 15:00, длительность как у оригинала (1 ч 30 мин) → конец 16:30', c.start_at === D(3) + 'T15:00' && c.end_at === D(3) + 'T16:30', JSON.stringify(c));
  c = pc(mk('p', 'П', wed + 'T09:00', wed + 'T10:30'), { kind: 'slot', date: wed, min: 1410 });
  check('PC2 вставка в 23:30 задачи на 1,5 ч: конец прижат к 23:59 (в пределах суток)', c.start_at === wed + 'T23:30' && c.end_at === wed + 'T23:59' && c.last_day === wed, JSON.stringify(c));
  c = pc(mk('p', 'П', wed), { kind: 'slot', date: tue, min: 600 });
  check('PC3 оригинал без времени в ячейку 10:00: начало 10:00, конца нет', c.start_at === tue + 'T10:00' && c.end_at === null, JSON.stringify(c));
  c = pc(mk('p', 'П', wed + 'T14:00', null), { kind: 'slot', date: tue, min: 660 });
  check('PC4 оригинал только с началом: у копии тоже нет конца', c.start_at === tue + 'T11:00' && c.end_at === null);
  c = pc(mk('p', 'П', wed + 'T09:00', wed + 'T10:30'), { kind: 'allday', date: sat });
  check('PC5 вставка в полосу «Весь день»: без времени (start_at = дата), конца нет у однодневной', c.start_at === sat && c.end_at === null && c.first_day === sat && c.last_day === sat, JSON.stringify(c));
  c = pc(mk('p', 'П', tue + 'T09:00', D(3) + 'T17:00', tue, D(3)), { kind: 'allday', date: sat });
  check('PC5a многодневная в «Весь день»: длительность (3 дня) сохранена датами без времени', c.start_at === sat && c.end_at === D(7) && c.last_day === D(7), JSON.stringify(c));
  c = pc(mk('p', 'П', wed + 'T14:30', wed + 'T15:30'), { kind: 'month', date: D(10) });
  check('PC6 «Месяц»: то же время суток, что у оригинала (14:30–15:30), дата ячейки', c.start_at === D(10) + 'T14:30' && c.end_at === D(10) + 'T15:30', JSON.stringify(c));
  c = pc(mk('p', 'П', tue + 'T09:00', D(3) + 'T17:00', tue, D(3)), { kind: 'slot', date: D(5), min: 600 });
  check('PC7 многодневная (вт 09:00 → чт 17:00 = 2 дня 8 ч) в ячейку сб 10:00 → вс… конец = пн 18:00 (та же длительность)', c.start_at === D(5) + 'T10:00' && c.end_at === D(7) + 'T18:00' && c.last_day === D(7), JSON.stringify(c));
  // V6.3-2 (Д-1): «Копировать» хранит только ссылку на задачу; «Вставить» добавляет повтор (новая задача не создаётся)
  const srcT = mk('src', 'Исходная «задача» <b>', wed + 'T09:00', wed + 'T10:00', { version: 7, status: 'closed' });
  const clip = U.calClipOf(srcT), clipO = U.calClipOf(srcT, 42);
  check('CL1 снимок буфера: ссылка на задачу (id, версия, тема) и её срок; копия содержимого (исполнители, чек-лист…) не нужна — повтор не создаёт задачу',
    clip.id === 'src' && clip.version === 7 && clip.title === srcT.title && clip.occ === null && clip.start_at === wed + 'T09:00' && !('assignees' in clip) && !('checklist' in clip), JSON.stringify(clip));
  check('CL2 копирование плитки повтора помнит id повтора', clipO.id === 'src' && clipO.occ === 42);
  check('CL3 снимок не зависит от оригинала: правка темы после «Копировать» не меняет буфер', (() => { srcT.title = 'Другое'; return clip.title.indexOf('Исходная') === 0; })());
  check('CL4 ограничение V6.2 «задачу без исполнителя копировать нельзя» снято: copy не требует исполнителей', (() => {
    const E = makeEnv('http://127.0.0.1:1', '');
    E.S.user = { role: 'admin', isAdmin: true }; E.S.tasks = [mk('na', 'Без исполнителя', wed + 'T09:00', wed + 'T10:00', { assignees: [], orphan: true })];
    E.U.calCopy('na');
    return E.U.clip() && E.U.clip().id === 'na';
  })());

  // ---- 7c. V6.2-2: права и мышь/касание (шим) -------------------------------------------------
  console.log('-- W-5/W-6 права, касания');
  const fakeTile = (id, date, timed, top, occ) => {
    const el = { dataset: Object.assign({ id, tkDnd: '1' }, occ === undefined ? {} : { occ }), classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ top: top === undefined ? 100 : top }), closest: (sel) => (sel === '[data-date]' ? { dataset: { date } } : null) };
    if (timed) el.dataset.s = '540';
    return el;
  };
  const onTile = (el) => ({ closest: (sel) => (sel === '.tk-wk' ? {} : (sel === '.tk-ev' || sel === '.tk-wk .tk-ev') ? el : null) });
  const onCell = (date, min) => ({ closest: (sel) => (sel === '.tk-wk' ? {} : sel === '[data-tk-act="calCell"]' ? { dataset: { date, min: String(min) } } : null) });
  const onStrip = (date) => ({ closest: (sel) => (sel === '.tk-wk' ? {} : sel === '.tk-ad-c' ? { dataset: { date } } : null) });
  const onHead = { closest: (sel) => (sel === '.tk-wk' ? {} : null) };
  const outside = { closest: () => null };
  const mev = (target, extra) => Object.assign({ target, button: 0, pointerType: 'mouse', clientX: 200, clientY: 130, buttons: 1, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }, extra || {});
  const menuEls = (E) => E.body.children.filter((x) => x.className === 'tk-ctx');
  const toastEls = (E) => E.body.children.filter((x) => x.className === 'tk-ctoast');
  {
    const Ad = makeEnv('http://127.0.0.1:1', '');
    Ad.S.user = { role: 'admin', isAdmin: true }; Ad.S.employees = emps; Ad.S.empById = {}; emps.forEach((e) => { Ad.S.empById[e.id] = e; });
    Ad.S.tasks = [mk('vt', 'Плитка', wed + 'T09:00', wed + 'T10:00'), mk('va', 'Весь день', wed)]; Ad.S.view = 'calendar'; Ad.S.cal.mode = 'week'; Ad.S.cal.anchor = wed; Ad.U.render();
    check('RD1 admin: плитки помечены для перетаскивания (tk-dnd, data-tk-dnd) — и в сетке, и в «Весь день»', Ad.count('data-tk-dnd="1"') === 2 && Ad.count(' tk-dnd') >= 2);
    const evTouch = mev(onTile(fakeTile('vt', wed, true)), { pointerType: 'touch' });
    Ad.root.fire('pointerdown', evTouch);
    check('RD2 касание (pointerType touch) не начинает перетаскивание: прокрутка пальцем остаётся прокруткой', Ad.U.drag() === null && Ad.docL.pointermove === undefined);
    Ad.root.fire('pointerdown', mev(onTile(fakeTile('vt', wed, true)), { button: 2 }));
    check('RD3 правая кнопка мыши не начинает перетаскивание', Ad.U.drag() === null);
    Ad.root.fire('pointerdown', mev(onTile(fakeTile('vt', wed, true)), { pointerType: 'pen' }));
    check('RD3a перо не начинает перетаскивание', Ad.U.drag() === null);
    const ctTouch = mev(onTile(fakeTile('vt', wed, true)), { pointerType: 'touch' });
    Ad.root.fire('contextmenu', ctTouch);
    check('RD4 долгое касание (contextmenu от touch) — наше меню не открывается, родное поведение не подавляется', !ctTouch.prevented && menuEls(Ad).length === 0);
    const ctHead = mev(onHead);
    Ad.root.fire('contextmenu', ctHead);
    const ctOut = mev(outside);
    Ad.root.fire('contextmenu', ctOut);
    check('RD5 родное меню браузера: над заголовком/колонкой часов календаря и вне календаря не подавляется', !ctHead.prevented && !ctOut.prevented && menuEls(Ad).length === 0);
    const ctTile = mev(onTile(fakeTile('vt', wed, true)), { clientX: 310, clientY: 220 });
    Ad.root.fire('contextmenu', ctTile);
    check('RD6 ПКМ по плитке: родное меню подавлено, открыто своё меню с единственным пунктом «Копировать» (в позиции курсора)',
      ctTile.prevented && menuEls(Ad).length === 1 && />Копировать</.test(menuEls(Ad)[0].innerHTML) && !/Вставить/.test(menuEls(Ad)[0].innerHTML) && menuEls(Ad)[0].style.left === '310px' && menuEls(Ad)[0].style.top === '220px', menuEls(Ad)[0] && menuEls(Ad)[0].innerHTML);
    Ad.fireDoc('keydown', mev(null, { key: 'Escape' }));
    check('RD7 меню закрывается по Esc', menuEls(Ad).length === 0 && !Ad.U.ctxOpen());
    Ad.root.fire('contextmenu', mev(onCell(wed, 600)));
    Ad.fireDoc('pointerdown', mev(outside));
    check('RD8 меню закрывается кликом мимо (pointerdown вне меню)', menuEls(Ad).length === 0);
    Ad.root.fire('contextmenu', mev(onCell(wed, 600)));
    Ad.fireDoc('pointerdown', mev({ closest: (sel) => (sel === '.tk-ctx' ? {} : null) }));
    check('RD8a клик по самому меню его не закрывает (закроет выбор пункта)', menuEls(Ad).length === 1);
    Ad.fireDoc('scroll', mev(null));
    check('RD9 меню закрывается прокруткой', menuEls(Ad).length === 0);
    Ad.root.fire('contextmenu', mev(onCell(wed, 600)));
    Ad.fireDoc('wheel', mev(null));
    check('RD9a меню закрывается колесом мыши', menuEls(Ad).length === 0);
    Ad.U.clearClip();
    Ad.root.fire('contextmenu', mev(onCell(wed, 600)));
    const m0 = menuEls(Ad)[0], callsBefore = Ad.calls.length;
    check('RD10 ПКМ по пустой ячейке: пункт «Вставить повтор», пока ничего не скопировано — неактивен (disabled), клик по нему ничего не создаёт',
      m0 && />Вставить повтор</.test(m0.innerHTML) && /disabled/.test(m0.innerHTML) && (m0.fire('click', { target: { closest: () => ({ dataset: { tkCtx: '0' } }) } }), Ad.calls.length === callsBefore && menuEls(Ad).length === 1));
    Ad.U.ctxClose();
    Ad.root.fire('contextmenu', mev(onStrip(sat)));
    check('RD11 ПКМ по полосе «Весь день» (ячейка дня) тоже даёт «Вставить повтор»', menuEls(Ad).length === 1 && />Вставить повтор</.test(menuEls(Ad)[0].innerHTML));
    Ad.U.ctxClose();
    // клик без сдвига: перетаскивание не начинается, карточка открывается
    Ad.root.fire('pointerdown', mev(onTile(fakeTile('vt', wed, true))));
    check('RD12 нажатие мышью на плитку: жест «ждёт» сдвига (перетаскивание ещё не началось), слушатели повешены на document', Ad.U.drag() && Ad.U.drag().started === false && (Ad.docL.pointermove || []).length === 1);
    Ad.fireDoc('pointermove', mev(null, { clientX: 202, clientY: 131 }));
    check('RD13 сдвиг меньше порога (< 5 px) — всё ещё клик', Ad.U.drag() && Ad.U.drag().started === false);
    Ad.fireDoc('pointerup', mev(null, { clientX: 202, clientY: 131 }));
    check('RD14 отпустили без сдвига: жест снят, слушатели document сняты, следующий click не подавляется (карточка откроется)',
      Ad.U.drag() === null && (Ad.docL.pointermove || []).length === 0 && (Ad.docL.pointerup || []).length === 0 &&
      (() => { const ce = mev(outside); Ad.U.onClickCapture(ce); return !ce.stopped && !ce.prevented; })());
    Ad.U.ACTIONS.openTask({ dataset: { id: 'vt' } });
    check('RD14a клик по плитке по-прежнему открывает карточку', Ad.S.selectedId === 'vt' && Ad.has('class="tk-detail"'));
    // перерисовка (синхронизация) во время перетаскивания: плитка пропала из DOM → жест отменяется без записи
    {
      const gone = fakeTile('vt', wed, true); gone.isConnected = false;
      const pb4 = Ad.calls.length;
      Ad.U.HOOK.hit = () => ({ date: tue, min: 600 });
      Ad.root.fire('pointerdown', mev(onTile(gone)));
      Ad.fireDoc('pointermove', mev(null, { clientX: 260, clientY: 190 }));
      check('RD15 плитку убрали из DOM во время перетаскивания (перерисовка): жест отменён, слушатели сняты, запросов нет, следующий click подавлен',
        Ad.U.drag() === null && (Ad.docL.pointermove || []).length === 0 && Ad.calls.length === pb4 && (() => { const ce = mev(outside); Ad.U.onClickCapture(ce); return !!ce.stopped; })());
      Ad.U.HOOK.hit = null;
      Ad.root.fire('pointerdown', mev(onTile(fakeTile('vt', wed, true))));
      Ad.fireDoc('pointermove', mev(null, { clientX: 260, clientY: 190, buttons: 0 }));
      check('RD16 кнопку отпустили вне окна (move с buttons=0): жест отменён', Ad.U.drag() === null && (Ad.docL.pointermove || []).length === 0);
    }
  }
  for (const role of ['supervisor', 'viewer']) {
    const Q = makeEnv('http://127.0.0.1:1', '');
    Q.S.user = { role, isAdmin: false }; Q.S.employees = emps; Q.S.empById = {}; emps.forEach((e) => { Q.S.empById[e.id] = e; });
    Q.S.tasks = [mk('rt', 'Плитка', wed + 'T09:00', wed + 'T10:00')]; Q.S.view = 'calendar'; Q.S.cal.mode = 'week'; Q.S.cal.anchor = wed; Q.U.render();
    check('W56-' + role + '-1 плитки не помечены как перетаскиваемые: нет tk-dnd и data-tk-dnd (курсор «рука» не показывается)', Q.count('class="tk-ev') >= 1 && !Q.has('tk-dnd') && !Q.has('data-tk-dnd'));
    Q.root.fire('pointerdown', mev(onTile(fakeTile('rt', wed, true))));
    check('W56-' + role + '-2 нажатие мышью по плитке: перетаскивание не начинается, слушатели не вешаются', Q.U.drag() === null && Q.docL.pointermove === undefined);
    const cev = mev(onTile(fakeTile('rt', wed, true)));
    Q.root.fire('contextmenu', cev);
    const cev2 = mev(onCell(wed, 600));
    Q.root.fire('contextmenu', cev2);
    check('W56-' + role + '-3 ПКМ: нативное меню браузера не подавляется, своего меню нет', !cev.prevented && !cev2.prevented && menuEls(Q).length === 0 && !Q.U.ctxOpen());
    const nBefore = Q.calls.length;
    Q.U.calCopy('rt');
    Q.U.calPaste({ kind: 'slot', date: wed, min: 600 });
    check('W56-' + role + '-4 принудительный вызов «Копировать»/«Вставить»: буфер пуст, запросов нет', Q.U.clip() === null && Q.calls.length === nBefore);
    Q.U.calMove(Q.S.tasks[0], { start_at: wed + 'T10:00', end_at: wed + 'T11:00', first_day: wed, last_day: wed });
    check('W56-' + role + '-5 принудительный перенос: запросов нет, плитка на месте', Q.calls.length === nBefore && Q.S.tasks[0].start_at === wed + 'T09:00');
  }


  console.log('-- нагрузка');
  {
    const rnd = prng(7);
    const emps50 = Array.from({ length: 50 }, (_, i) => ({ id: 'emp_' + (100 + i), name: 'Сотрудник Тестовый ' + (i + 1) }));
    const L50 = [];
    emps50.forEach((e, i) => {
      for (let k = 0; k < 3; k++) {
        const day = D(Math.floor(rnd() * 7)), s = (8 + Math.floor(rnd() * 20)) * 30, dur = (1 + Math.floor(rnd() * 4)) * 30;
        const hm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
        const timed = rnd() > 0.2;
        L50.push(mk('L' + i + '_' + k, 'Задача ' + (i + 1) + '.' + (k + 1), timed ? day + 'T' + hm(s) : day, timed ? day + 'T' + hm(Math.min(s + dur, 1439)) : null,
          { assignees: [{ employee_id: e.id, full_name: e.name, removed: false }] }));
      }
    });
    const Z = makeEnv('http://127.0.0.1:1', '');
    Z.S.user = { role: 'admin', isAdmin: true }; Z.S.employees = emps50; Z.S.empById = {}; emps50.forEach((e) => { Z.S.empById[e.id] = e; });
    Z.S.tasks = L50; Z.S.view = 'calendar'; Z.S.cal.mode = 'week'; Z.S.cal.anchor = wed;
    const times = [];
    for (let i = 0; i < 7; i++) { const t0 = process.hrtime.bigint(); Z.U.render(); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    times.sort((a, b) => a - b);
    const med = times[3];
    const tiles = Z.count('class="tk-ev ');
    const bdz = bodyTilesByDay(Z);
    const sumTimed = Object.keys(bdz).reduce((a, d) => a + bdz[d].length, 0);
    const sumAd = Object.keys(adTilesByDay(Z)).reduce((a, d) => a + adTilesByDay(Z)[d].length, 0);
    console.log('  INFO  render(): 150 задач × неделя, медиана из 7 = ' + med.toFixed(1) + ' мс (мин ' + times[0].toFixed(1) + ', макс ' + times[6].toFixed(1) + '), HTML ' + (Z.root.innerHTML.length / 1024).toFixed(0) + ' КБ, плиток ' + tiles + ', в сетке ' + sumTimed + ', «Весь день» (видимых) ' + sumAd);
    check('P-LOAD неделя 50 сотрудников × 3 задачи (150): строка разметки строится < 1000 мс (медиана), все плитки сетки раскладываются', med < 1000 && sumTimed > 100);
    let maxCols = 0; Object.keys(bdz).forEach((d) => bdz[d].forEach((q) => { if (q.cols > maxCols) maxCols = q.cols; }));
    console.log('  INFO  максимум дорожек в одном дне: ' + maxCols);
  }

  // ---- 9. e2e по реальному API ----------------------------------------------------------
  console.log('-- e2e (php -S на копии БД)');
  const hashBefore = sha1(REAL_DB);
  const tmpDb = path.join(os.tmpdir(), 'sc_tasks_cal_' + process.pid + '.db');
  fs.copyFileSync(REAL_DB, tmpDb);
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, { SC_APP_DB: tmpDb });
  delete env.TASKS_VALIDATE_WEBHOOK_URL;
  const srv = cp.spawn('php', ['-S', '127.0.0.1:' + port, '-t', ROOT], { env, cwd: ROOT, stdio: 'ignore' });
  let ready = false, lastErr = '';
  for (let i = 0; i < 60 && !ready; i++) {
    try { const rr = await fetch(base + '/api/session.php'); ready = rr.status < 500; lastErr = 'status ' + rr.status; } catch (e) { lastErr = String(e); }
    if (!ready) await new Promise((rr) => setTimeout(rr, 100));
  }
  if (!ready) { srv.kill(); check('E0 php -S поднялся', false, lastErr); return finish(srv, tmpDb, hashBefore); }
  try {
    const adminCk = await login(base, 'admin');
    const supCk = await login(base, 'supervisor_zone0');
    const A = makeEnv(base, adminCk);
    A.els.tabTasks.click();
    await A.settle();
    const e1 = A.S.employees[1].id;
    const day = '2099-06-10';
    await A.T.open({ employeeId: '', date: day, view: 'calendar', mode: 'week' });
    await A.settle();
    check('E1 календарь открыт по реальному API: неделя 2099-06-08…14, сетка и ячейки есть', A.S.view === 'calendar' && A.has('class="tk-cal-bd"') && A.count('data-tk-act="calCell"') === 7 * 48);
    check('E1a прокрутка при открытии — 08:00 (384 px)', A.root.calEl && A.root.calEl.scrollTop === 8 * HP, A.root.calEl && A.root.calEl.scrollTop);
    A.root.calEl.scrollTop = 700; A.U.render();
    await A.T.open({ employeeId: '', date: day, view: 'calendar' });
    await A.settle();
    check('E1b повторный Tasks.open (клик по иконке в матрице) при уже открытом календаре снова ставит 08:00', A.root.calEl && A.root.calEl.scrollTop === 8 * HP, A.root.calEl && A.root.calEl.scrollTop);
    // создание из ячейки: среда 2099-06-10 10:30
    await A.click('calCell', (d) => d.date === day && d.min === '630');
    await A.field('title', 'Создано кликом по ячейке');
    await A.field('assigneePick', e1);
    check('E2 форма из ячейки: 2099-06-10, 10:30–11:30, период', A.S.form.draft.startDate === day && A.S.form.draft.startTime === '10:30' && A.S.form.draft.endTime === '11:30' && A.S.form.draft.kind === 'period');
    await A.click('saveForm');
    const post = A.calls.filter((c) => c.method === 'POST' && c.url === 'api/tasks.php').pop();
    check('E3 POST api/tasks.php: start_at 2099-06-10T10:30, end_at 2099-06-10T11:30 (контракт прежний), форма закрыта, тост «Задача создана»',
      post && post.body.start_at === day + 'T10:30' && post.body.end_at === day + 'T11:30' && A.S.form === null && A.toasts.some((t) => t.text === 'Задача создана'), JSON.stringify(post && post.body));
    const created = A.S.tasks.find((t) => t.title === 'Создано кликом по ячейке');
    const bdE = bodyTilesByDay(A);
    const tE = created && (bdE[day] || []).find((q) => q.id === created.id);
    check('E4 после сохранения плитка стоит в нужном дне и часе: top = 10.5×48 = 504 px, height = 48 px', tE && tE.top === 504 && tE.h === 48, JSON.stringify(tE));
    check('E5 новая плитка получена из БД: сервер вернул тот же start_at/end_at', created && created.start_at === day + 'T10:30' && created.end_at === day + 'T11:30', JSON.stringify(created && [created.start_at, created.end_at]));
    // пересечение: две задачи на 10:00–11:00 и 10:30–11:30 → рядом
    const mkSrv = await http(base, adminCk, 'POST', 'api/tasks.php', { title: 'Пересекается с первой', start_at: day + 'T10:00', end_at: day + 'T11:00', assignees: [e1] });
    await A.T.reload(); await A.settle();
    const bdE2 = bodyTilesByDay(A);
    const pair = (bdE2[day] || []).filter((q) => q.id === created.id || q.id === (mkSrv.json.task || {}).id);
    check('E6 две пересекающиеся задачи с сервера (10:00–11:00 и 10:30–11:30) стоят рядом: по 2 дорожки, 50% ширины',
      mkSrv.status === 201 && pair.length === 2 && pair.every((q) => q.cols === 2 && q.w === 50) && pair[0].left !== pair[1].left, JSON.stringify(pair));
    // некратное время: POST → правка в форме → без смены времени PUT повторяет значение
    const oddSrv = await http(base, adminCk, 'POST', 'api/tasks.php', { title: 'Некратное время', start_at: '2099-06-11T09:07', end_at: '2099-06-11T10:13', assignees: [e1] });
    await A.T.reload(); await A.settle();
    const oddId = (oddSrv.json.task || {}).id;
    await A.click('openTask', (d) => d.id === oddId);
    await A.click('editTask', (d) => d.id === oddId);
    check('E7 правка задачи 09:07–10:13 с сервера: некратные значения — выбранные пункты списков', A.S.form && A.S.form.draft.startTime === '09:07' && A.S.form.draft.endTime === '10:13' &&
      opts(section(A.root.innerHTML, 'data-tk-field="startTime"', '</select>')).find((q) => q.sel).v === '09:07' && opts(section(A.root.innerHTML, 'data-tk-field="endTime"', '</select>')).find((q) => q.sel).v === '10:13');
    await A.field('title', 'Некратное время (правка названия)');
    await A.click('saveForm');
    const put = A.calls.filter((c) => c.method === 'PUT').pop();
    const srvOdd = (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + oddId)).json.task;
    check('E8 сохранение без смены времени: PUT повторяет …T09:07/…T10:13, на сервере время не изменилось',
      put && put.body.start_at === '2099-06-11T09:07' && put.body.end_at === '2099-06-11T10:13' && srvOdd.start_at === '2099-06-11T09:07' && srvOdd.end_at === '2099-06-11T10:13' && srvOdd.title === 'Некратное время (правка названия)', JSON.stringify(put && put.body) + ' ' + JSON.stringify(srvOdd && [srvOdd.start_at, srvOdd.end_at]));
    // supervisor по реальному API
    const S2 = makeEnv(base, supCk);
    S2.els.tabTasks.click(); await S2.settle();
    await S2.T.open({ employeeId: '', date: day, view: 'calendar', mode: 'week' }); await S2.settle();
    const postsBefore = S2.calls.filter((c) => c.method !== 'GET').length;
    S2.U.ACTIONS.calCell({ dataset: { date: day, min: '600' } });
    await S2.settle();
    check('E9 supervisor (реальная сессия): календарь виден, ячеек создания нет, принудительный клик не открывает форму и ничего не отправляет',
      S2.S.view === 'calendar' && S2.has('class="tk-cal-bd"') && !S2.has('calCell') && S2.S.form === null && S2.calls.filter((c) => c.method !== 'GET').length === postsBefore);
    // календарь: «День» по реальному API
    await A.click('calMode', (d) => d.mode === 'day');
    check('E10 «День» по реальному API: одна колонка, запрошен один день, плитка созданной задачи на месте', A.S.cal.mode === 'day' && A.count('class="tk-wk-h') === 1 && A.calls.some((c) => /api\/tasks\.php\?from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d$/.test(c.url)));

    // ---- V6.2-2: перетаскивание и копирование по реальному API ------------------------------
    console.log('-- W-5/W-6 e2e (реальный api/tasks.php)');
    await A.T.open({ employeeId: '', date: day, view: 'calendar', mode: 'week' }); await A.settle();
    const AD = (n) => A.U.addDays(A.U.weekStart(day), n);   // Пн 2099-06-08 … Вс 2099-06-14; day = среда
    const e2 = A.S.employees[2].id, e3 = A.S.employees[3].id;
    const mkS = async (body) => (await http(base, adminCk, 'POST', 'api/tasks.php', Object.assign({ assignees: [e1] }, body))).json.task;
    const getS = async (id) => (await http(base, adminCk, 'GET', 'api/tasks.php?id=' + id)).json.task;
    const putN = () => A.calls.filter((q) => q.method === 'PUT').length;
    const press = (id, date, timed) => A.root.fire('pointerdown', mev(onTile(fakeTile(id, date, timed)), { clientX: 200, clientY: 130 }));
    const moveTo = (hit, x, y) => { A.U.HOOK.hit = () => hit; A.fireDoc('pointermove', mev(null, { clientX: x || 260, clientY: y || 190 })); };
    const release = async () => { A.fireDoc('pointerup', mev(null, { clientX: 260, clientY: 190 })); await A.settle(); };
    const clickSupp = () => { const ce = mev(outside); A.U.onClickCapture(ce); return !!ce.stopped; };

    // DD1 «Неделя»: плитка 09:00–10:30 (ср) → чт 14:00
    const d1 = await mkS({ title: 'DnD: неделя', start_at: day + 'T09:00', end_at: day + 'T10:30' });
    await A.T.reload(); await A.settle();
    press(d1.id, day, true);
    check('DD1a нажатие на плитку мышью: жест начат, но до сдвига < 5 px перетаскивания нет', A.U.drag() && !A.U.drag().started);
    moveTo({ date: AD(3), min: 840 });
    const dg = A.U.drag();
    check('DD1b сдвиг ≥ 5 px начинает перетаскивание; «тень» считается на лету: чт 14:00–15:30, длительность сохранена', dg && dg.started && dg.calc && dg.calc.start_at === AD(3) + 'T14:00' && dg.calc.end_at === AD(3) + 'T15:30', JSON.stringify(dg && dg.calc));
    const putBefore = putN();
    A.fireDoc('pointerup', mev(null, { clientX: 260, clientY: 190 }));
    const optimistic = A.S.tasks.find((q) => q.id === d1.id);
    check('DD1c сразу после отпускания плитка уже на новом месте (перенос показан до ответа сервера), жест снят, click подавлен',
      optimistic.start_at === AD(3) + 'T14:00' && A.U.drag() === null && clickSupp() && (A.docL.pointermove || []).length === 0);
    await A.settle();
    const srv1 = await getS(d1.id), put1 = A.calls.filter((q) => q.method === 'PUT').pop();
    check('DD1d PUT api/tasks.php?id=… с version=1 и новыми start_at/end_at; на сервере чт 14:00–15:30, версия 2',
      putN() === putBefore + 1 && put1.body.version === 1 && put1.body.start_at === AD(3) + 'T14:00' && put1.body.end_at === AD(3) + 'T15:30' &&
      srv1.start_at === AD(3) + 'T14:00' && srv1.end_at === AD(3) + 'T15:30' && srv1.version === 2, JSON.stringify([put1 && put1.body, srv1 && [srv1.start_at, srv1.end_at, srv1.version]]));
    check('DD1e после ответа календарь перечитан: плитка в чт на top = 14×48 = 672 px, высота 72 px; тост «Задача перенесена»',
      (() => { const q = (bodyTilesByDay(A)[AD(3)] || []).find((x) => x.id === d1.id); return q && q.top === 672 && q.h === 72; })() && A.toasts.some((q) => /Задача перенесена: 11\.06 14:00/.test(q.text)),
      JSON.stringify(A.toasts.slice(-2)));

    // DD2 Esc — ничего не меняется
    const d2 = await mkS({ title: 'DnD: Esc', start_at: day + 'T11:00', end_at: day + 'T12:00' });
    await A.T.reload(); await A.settle();
    let pb = putN();
    press(d2.id, day, true); moveTo({ date: AD(4), min: 600 });
    check('DD2a перетаскивание идёт (рассчитан чт/пт 10:00)', A.U.drag() && A.U.drag().started && A.U.drag().calc.start_at === AD(4) + 'T10:00');
    A.fireDoc('keydown', mev(null, { key: 'Escape' }));
    check('DD2b Esc: перетаскивание отменено (тень убрана), кнопка ещё нажата — движения игнорируются', A.U.drag() && A.U.drag().cancelled === true && A.U.drag().shadow === null);
    moveTo({ date: AD(5), min: 600 });
    await release();
    check('DD2c отпускание после Esc: запросов нет, на сервере всё прежнее, click после жеста подавлен (карточка/форма не открываются)',
      putN() === pb && (await getS(d2.id)).start_at === day + 'T11:00' && A.U.drag() === null && clickSupp() && A.S.form === null);

    // DD3 отпустили на старом месте и вне календаря — без изменений
    press(d2.id, day, true); moveTo({ date: day, min: 660 });
    check('DD3a над старым местом: расчёт «без изменений»', A.U.drag().calc && A.U.drag().calc.unchanged === true);
    await release();
    press(d2.id, day, true); moveTo(null);
    check('DD3b над областью вне календаря: цели нет', A.U.drag().calc === null && A.U.drag().hit === null);
    await release();
    check('DD3c ни старое место, ни область вне календаря запросов не шлют', putN() === pb && (await getS(d2.id)).version === 1);

    // DD4 «Весь день»: меняется только дата
    const d3 = await mkS({ title: 'DnD: весь день', start_at: day });
    const d4 = await mkS({ title: 'DnD: многодневная', start_at: AD(1) + 'T09:00', end_at: AD(3) + 'T17:00' });
    await A.T.reload(); await A.settle();
    press(d3.id, day, false); moveTo({ date: AD(4), min: null });
    check('DD4a «Весь день» (ср → пт): расчёт — только дата, без времени', A.U.drag().calc.start_at === AD(4) && A.U.drag().calc.end_at === null);
    await release();
    const srv3 = await getS(d3.id);
    check('DD4b на сервере start_at = пятница, времени нет', srv3.start_at === AD(4) && srv3.end_at === null && srv3.version === 2, JSON.stringify([srv3.start_at, srv3.end_at]));
    press(d4.id, AD(1), false); moveTo({ date: AD(2), min: null });
    await release();
    const srv4 = await getS(d4.id);
    check('DD4c многодневная (вт 09:00 → чт 17:00), перетащена на день вправо: оба конца со сдвигом, время прежнее (ср 09:00 → пт 17:00)', srv4.start_at === AD(2) + 'T09:00' && srv4.end_at === AD(4) + 'T17:00', JSON.stringify([srv4.start_at, srv4.end_at]));
    const adTiles = adTilesByDay(A);
    check('DD4d после перерисовки многодневная — в «Весь день» на ср, чт, пт', [2, 3, 4].every((n) => (adTiles[AD(n)] || []).some((q) => q.id === d4.id)) && !(adTiles[AD(1)] || []).some((q) => q.id === d4.id));

    // DD5 конфликт версий (409): другой пользователь изменил задачу
    const d5 = await mkS({ title: 'DnD: конфликт', start_at: day + 'T13:00', end_at: day + 'T14:00' });
    await A.T.reload(); await A.settle();
    const other = await http(base, adminCk, 'PUT', 'api/tasks.php?id=' + d5.id, { title: 'DnD: конфликт (изменил другой)', version: 1 });
    check('DD5a (подготовка) вторая вкладка изменила задачу: версия 2', other.status === 200 && other.json.task.version === 2);
    press(d5.id, day, true); moveTo({ date: AD(1), min: 900 });
    await release();
    const srv5 = await getS(d5.id), loc5 = A.S.tasks.find((q) => q.id === d5.id);
    check('DD5b 409: понятное сообщение (баннер и тост), перенос не применён на сервере', srv5.start_at === day + 'T13:00' && A.S.msg && A.S.msg.type === 'error' && /другим пользователем/.test(A.S.msg.text) && A.toasts.some((q) => /Конфликт версий/.test(q.text)), JSON.stringify(A.S.msg));
    check('DD5c после 409 задачи перечитаны: у плитки версия 2, свежее название, прежнее время; плитка вернулась на 13:00 (top 624)',
      loc5 && loc5.version === 2 && loc5.title === 'DnD: конфликт (изменил другой)' && loc5.start_at === day + 'T13:00' && (() => { const q = (bodyTilesByDay(A)[day] || []).find((x) => x.id === d5.id); return q && q.top === 624; })());

    // DD6 ошибка проверки на сервере — сообщение и откат плитки
    const d6 = await mkS({ title: 'DnD: ошибка', start_at: day + 'T15:00', end_at: day + 'T16:00' });
    await A.T.reload(); await A.settle();
    const t6 = A.S.tasks.find((q) => q.id === d6.id);
    A.S.msg = null;
    const pr6 = A.U.calMove(t6, { start_at: AD(3) + 'T25:00', end_at: null, first_day: AD(3), last_day: AD(3) });
    check('DD6a сразу после броска плитка показана на новом месте (до ответа)', A.S.tasks.find((q) => q.id === d6.id).first_day === AD(3));
    await pr6; await A.settle();
    check('DD6b ответ 400 (invalid_start_at): сообщение пользователю, плитка откатилась на прежнее место, запись на сервере прежняя',
      A.S.msg && A.S.msg.type === 'error' && /Перенос не выполнен/.test(A.S.msg.text) && A.S.tasks.find((q) => q.id === d6.id).start_at === day + 'T15:00' && (await getS(d6.id)).start_at === day + 'T15:00' &&
      (bodyTilesByDay(A)[day] || []).some((x) => x.id === d6.id), JSON.stringify(A.S.msg));
    A.S.msg = null;

    // CP: копирование ПКМ
    const mm = (E, i) => menuEls(E)[0].fire('click', { target: { closest: () => ({ dataset: { tkCtx: String(i) } }) } });
    const c1 = await mkS({
      title: 'Копируемая <i>', description: 'Описание копии', priority: 1, label: 'метка1, метка2', assignees: [e1, e2], watchers: [e3],
      checklist: [{ text: 'пункт а', done: true }, { text: 'пункт б', done: false }], start_at: day + 'T09:00', end_at: day + 'T10:30',
    });
    await A.T.reload(); await A.settle();
    A.U.clearClip();
    A.root.fire('contextmenu', mev(onTile(fakeTile(c1.id, day, true))));
    mm(A, 0);
    check('CP1 ПКМ по плитке → «Копировать»: буфер — ссылка на задачу (id, тема), меню закрылось, запросов на сервер нет',
      A.U.clip() && A.U.clip().id === c1.id && A.U.clip().title === 'Копируемая <i>' && A.U.clip().occ === null && menuEls(A).length === 0 && A.toasts.some((q) => /Скопировано: «Копируемая/.test(q.text)));
    const nBefore = A.S.tasks.length, srvCnt = async () => (await http(base, adminCk, 'GET', 'api/tasks.php?from=' + AD(0) + '&to=' + AD(6))).json.tasks.filter((q) => q.title === 'Копируемая <i>').length;
    A.root.fire('contextmenu', mev(onCell(AD(4), 900)));
    check('CP2 после «Копировать» пункт «Вставить повтор» в пустой ячейке активен (пункта «Вставить» нет)', menuEls(A).length === 1 && />Вставить повтор</.test(menuEls(A)[0].innerHTML) && !/disabled/.test(menuEls(A)[0].innerHTML));
    mm(A, 0);
    await A.settle();
    let s1 = await getS(c1.id);
    const o1 = (s1.occurrences || []).find((q) => q.start_at === AD(4) + 'T15:00');
    check('CP3 вставка в пт 15:00: НОВАЯ ЗАДАЧА НЕ СОЗДАНА, у исходной появился повтор пт 15:00–16:30 (длительность 1 ч 30 мин), версия 2',
      (await srvCnt()) === 1 && A.S.tasks.length === nBefore && s1.occurrences.length === 1 && o1 && o1.end_at === AD(4) + 'T16:30' && s1.version === 2, JSON.stringify(s1.occurrences));
    check('CP4 основная дата и поля исходной задачи не тронуты (09:00–10:30, исполнители, чек-лист, статус)',
      s1.start_at === day + 'T09:00' && s1.end_at === day + 'T10:30' && s1.assignees.length === 2 && s1.checklist.length === 2 && s1.status === 'open');
    const occTile = (E, id, date) => (bodyTilesByDay(E)[date] || []).find((q) => q.id === id && /\btk-occ\b/.test(q.cls));
    const tOcc = occTile(A, c1.id, AD(4));
    check('CP5 плитка повтора: отдельная плитка в пт на 15:00 (top 720), класс tk-occ, значок ↻, подсвечена (tk-flash); плитка основной даты на месте',
      tOcc && tOcc.top === 720 && tOcc.cls.includes('tk-flash') && A.S.cal.flashOcc === o1.id && A.has('class="tk-ev-rep"') && (bodyTilesByDay(A)[day] || []).some((q) => q.id === c1.id && !/\btk-occ\b/.test(q.cls)), JSON.stringify(tOcc));
    check('CP6 всплывающее сообщение «Повтор добавлен на 12.06 15:00» с действием «Открыть»', toastEls(A).length === 1 && toastEls(A)[0].innerHTML.includes('Повтор добавлен на 12.06 15:00') && toastEls(A)[0].innerHTML.includes('>Открыть<'), toastEls(A)[0] && toastEls(A)[0].innerHTML);
    toastEls(A)[0].fire('click', { target: { closest: () => ({ dataset: { tkCtoast: 'act' } }) } });
    await A.settle();
    check('CP7 «Открыть» открывает карточку той же задачи с перечнем дат выполнения (основная + повтор), сообщение закрыто',
      A.S.selectedId === c1.id && A.has('class="tk-detail"') && A.has('data-tk-dates="1"') && A.has('Даты выполнения · 2') && toastEls(A).length === 0);
    A.S.selectedId = null; A.U.render();
    A.U.ACTIONS.openTask({ dataset: { id: c1.id, occ: String(o1.id) } });
    check('CP7a клик по плитке повтора открывает карточку той же задачи (data-id плитки — id задачи)', A.S.selectedId === c1.id && A.has('class="tk-detail"') && (A.root.innerHTML.match(/<div class="tk-ev [^"]*tk-occ[^"]*"[^>]*>/) || [''])[0].includes('data-id="' + c1.id + '"'));
    // вставка в «Весь день» задачи со временем → время начала самой задачи (09:00)
    A.root.fire('contextmenu', mev(onStrip(AD(5))));
    mm(A, 0);
    await A.settle();
    s1 = await getS(c1.id);
    check('CP8 тот же буфер: вставка в «Весь день» сб — повтор получает время начала задачи (сб 09:00–10:30); версия 3', s1.occurrences.some((q) => q.start_at === AD(5) + 'T09:00' && q.end_at === AD(5) + 'T10:30') && s1.version === 3, JSON.stringify(s1.occurrences));
    // ячейка 23:30: конец не за 23:59
    A.root.fire('contextmenu', mev(onCell(AD(0), 1410)));
    mm(A, 0);
    await A.settle();
    s1 = await getS(c1.id);
    check('CP9 вставка в 23:30: конец повтора прижат к 23:59 того же дня', s1.occurrences.some((q) => q.start_at === AD(0) + 'T23:30' && q.end_at === AD(0) + 'T23:59') && s1.occurrences.length === 3, JSON.stringify(s1.occurrences));
    check('CP9a повторы идут по возрастанию (пн 23:30, пт 15:00, сб 09:00); next_at — на сервере есть и совпадает с одним из выполнений',
      s1.occurrences.map((q) => q.start_at).join() === [AD(0) + 'T23:30', AD(4) + 'T15:00', AD(5) + 'T09:00'].join() && [day + 'T09:00'].concat(s1.occurrences.map((q) => q.start_at)).includes(s1.next_at), JSON.stringify([s1.occurrences, s1.next_at]));
    // дубль с основной датой → понятная ошибка, ничего не меняется
    const vBefore = (await getS(c1.id)).version;
    A.S.msg = null;
    A.root.fire('contextmenu', mev(onCell(day, 540)));
    mm(A, 0);
    await A.settle();
    check('CP10 вставка точно на основную дату/время (ср 09:00): сообщение об ошибке, повтор не добавлен, версия прежняя',
      A.S.msg && A.S.msg.type === 'error' && /Повтор не добавлен/.test(A.S.msg.text) && /совпадает/.test(A.S.msg.text) && (await getS(c1.id)).version === vBefore && (await getS(c1.id)).occurrences.length === 3, JSON.stringify(A.S.msg));
    A.S.msg = null;
    // задача без времени: повтор — только датой, даже при вставке в ячейку часа
    const c3 = await mkS({ title: 'Без времени для повтора', start_at: day });
    await A.T.reload(); await A.settle();
    A.U.calCopy(c3.id);
    await A.U.calPaste({ kind: 'slot', date: AD(3), min: 600 });
    await A.settle();
    const s3 = await getS(c3.id);
    check('CP11 задача без времени: вставка в ячейку 10:00 даёт повтор только с датой (чт, без времени)', s3.occurrences.length === 1 && s3.occurrences[0].start_at === AD(3) && s3.occurrences[0].end_at === null, JSON.stringify(s3.occurrences));
    // перенос ТОЛЬКО повтора
    await A.T.reload(); await A.settle();
    s1 = await getS(c1.id);
    const oFri = s1.occurrences.find((q) => q.start_at === AD(4) + 'T15:00');
    const pn = A.calls.length;
    A.root.fire('pointerdown', mev(onTile(fakeTile(c1.id, AD(4), true, 100, String(oFri.id))), { clientX: 200, clientY: 130 }));
    moveTo({ date: AD(3), min: 840 });
    check('CP12 тень повтора: перенос пт 15:00 → чт 14:00, длительность 1 ч 30 мин сохранена', A.U.drag() && A.U.drag().started && A.U.drag().occ === String(oFri.id) && A.U.drag().calc.start_at === AD(3) + 'T14:00' && A.U.drag().calc.end_at === AD(3) + 'T15:30', JSON.stringify(A.U.drag() && A.U.drag().calc));
    A.fireDoc('pointerup', mev(null, { clientX: 260, clientY: 190 }));
    check('CP12a сразу после отпускания плитка повтора уже на новом месте (чт 14:00 → top 672), основная плитка не двигалась (ср 09:00 → top 432)',
      (() => { const q = occTile(A, c1.id, AD(3)); return q && q.top === 672 && (bodyTilesByDay(A)[day] || []).some((x) => x.id === c1.id && x.top === 432); })());
    await A.settle();
    const mvCall = A.calls.slice(pn).filter((q) => q.method === 'POST' && /action=occ_move/.test(q.url)).pop(), s1m = await getS(c1.id);
    check('CP13 POST ?id=…&action=occ_move с version и occurrence_id; на сервере повтор чт 14:00–15:30, основная дата прежняя (ср 09:00), повторов по-прежнему 3',
      mvCall && mvCall.body.version === s1.version && String(mvCall.body.occurrence_id) === String(oFri.id) && mvCall.body.start_at === AD(3) + 'T14:00' &&
      s1m.occurrences.some((q) => q.id === oFri.id && q.start_at === AD(3) + 'T14:00' && q.end_at === AD(3) + 'T15:30') && s1m.start_at === day + 'T09:00' && s1m.occurrences.length === 3, JSON.stringify([mvCall && mvCall.body, s1m.occurrences]));
    check('CP13a тост «Повтор перенесён: 11.06 14:00»; запрос — не PUT (основная дата не переписывается)', A.toasts.some((q) => /Повтор перенесён: 11\.06 14:00/.test(q.text)) && !A.calls.slice(pn).some((q) => q.method === 'PUT'));
    // 409: другая вкладка изменила задачу
    const other2 = await http(base, adminCk, 'PUT', 'api/tasks.php?id=' + c1.id, { title: 'Копируемая <i>', description: 'правка другой вкладкой', version: s1m.version });
    check('CP14a (подготовка) другая вкладка изменила задачу', other2.status === 200 && other2.json.task.version === s1m.version + 1);
    A.S.msg = null;
    A.root.fire('pointerdown', mev(onTile(fakeTile(c1.id, AD(3), true, 100, String(oFri.id))), { clientX: 200, clientY: 130 }));
    moveTo({ date: AD(2), min: 600 });
    await release();
    const s1c = await getS(c1.id);
    check('CP14 перенос повтора по устаревшей версии: 409 — понятное сообщение, повтор на сервере не сдвинут, календарь обновлён (свежая версия)',
      A.S.msg && /другим пользователем/.test(A.S.msg.text) && s1c.occurrences.some((q) => q.id === oFri.id && q.start_at === AD(3) + 'T14:00') && A.S.tasks.find((q) => q.id === c1.id).version === s1c.version, JSON.stringify(A.S.msg));
    A.S.msg = null;
    // ПКМ по плитке повтора: «Копировать» + «Удалить повтор»; копирование плитки повтора = копирование задачи
    A.U.clearClip();
    A.root.fire('contextmenu', mev(onTile(fakeTile(c1.id, AD(3), true, 100, String(oFri.id)))));
    check('CP15 ПКМ по плитке повтора: два пункта — «Копировать» и «Удалить повтор»', menuEls(A).length === 1 && />Копировать</.test(menuEls(A)[0].innerHTML) && />Удалить повтор</.test(menuEls(A)[0].innerHTML));
    mm(A, 0);
    check('CP15a «Копировать» по плитке повтора копирует задачу (id задачи, occ = id повтора)', A.U.clip() && A.U.clip().id === c1.id && String(A.U.clip().occ) === String(oFri.id));
    A.root.fire('contextmenu', mev(onCell(AD(6), 600)));
    mm(A, 0);
    await A.settle();
    const s1p = await getS(c1.id);
    const oSun = s1p.occurrences.find((q) => q.start_at === AD(6) + 'T10:00');
    check('CP15b вставка скопированного повтора в вс 10:00: у задачи 4 повтора, вс 10:00–11:30; новых задач нет', s1p.occurrences.length === 4 && oSun && oSun.end_at === AD(6) + 'T11:30' && (await srvCnt()) === 1, JSON.stringify(s1p.occurrences));
    // удаление повтора
    let asked = null; A.sandbox.confirm = (m) => { asked = m; return false; };
    A.root.fire('contextmenu', mev(onTile(fakeTile(c1.id, AD(6), true, 100, String(oSun.id)))));
    mm(A, 1);
    await A.settle();
    check('CP16 «Удалить повтор» спрашивает подтверждение (текст с датой и темой); отказ — ничего не удалено', asked && /Удалить повтор 14\.06 10:00/.test(asked) && (await getS(c1.id)).occurrences.length === 4, asked);
    A.sandbox.confirm = () => true;
    A.root.fire('contextmenu', mev(onTile(fakeTile(c1.id, AD(6), true, 100, String(oSun.id)))));
    mm(A, 1);
    await A.settle();
    const s1d = await getS(c1.id);
    check('CP17 подтверждено: удалён только этот повтор (остались 3), задача и основная дата на месте, плитка исчезла, тост «Повтор удалён»',
      s1d.occurrences.length === 3 && !s1d.occurrences.some((q) => q.start_at === AD(6) + 'T10:00') && s1d.status === 'open' && s1d.start_at === day + 'T09:00' && !occTile(A, c1.id, AD(6)) && A.toasts.some((q) => /Повтор удалён: 14\.06 10:00/.test(q.text)));
    // Список: одна строка, «↻ N» и подсказка
    A.S.view = 'list'; A.S.filters.emp = ''; A.U.render();
    const listRows = (A.root.innerHTML.match(/data-tk-act="openTask" data-id="[^"]+"/g) || []).filter((q) => q.includes('"' + c1.id + '"'));
    check('CP18 Список: задача с повторами — одна строка, «↻ 3» рядом со сроком, в подсказке все даты', listRows.length === 1 && A.has('data-tk-occ-n="3"') && /Повторов: 3/.test(A.root.innerHTML), String(listRows.length));
    A.S.view = 'calendar'; A.U.render();
    // роли по реальному API
    {
      const nb = S2.calls.filter((q) => q.method !== 'GET').length;
      S2.root.fire('pointerdown', mev(onTile(fakeTile(d1.id, AD(3), true))));
      const sc = mev(onTile(fakeTile(d1.id, AD(3), true))), sc2 = mev(onCell(AD(3), 600));
      S2.root.fire('contextmenu', sc); S2.root.fire('contextmenu', sc2);
      check('CP19 supervisor (реальная сессия): плитки без перетаскивания, ПКМ — родное меню браузера, наше не открывается, записей нет',
        !S2.has('data-tk-dnd') && S2.U.drag() === null && !sc.prevented && !sc2.prevented && menuEls(S2).length === 0 && S2.calls.filter((q) => q.method !== 'GET').length === nb);
      S2.U.calDeleteOcc(c1.id, 1);
      S2.U.calCopy(c1.id, 1);
      check('CP19a supervisor: принудительные «Удалить повтор»/«Копировать» ничего не делают', S2.calls.filter((q) => q.method !== 'GET').length === nb && S2.U.clip() === null);
      const r403 = await http(base, supCk, 'POST', 'api/tasks.php?id=' + c1.id + '&action=occ_add', { version: 1, start_at: AD(1) + 'T10:00' });
      check('CP19b API: supervisor → occ_add запрещён (403)', r403.status === 403, JSON.stringify(r403));
    }
    // блок на повторе (больничный/командировка): мок-сервер отвечает 422 так же, как настоящий API
    {
      const mock = require('http').createServer((rq, rs) => {
        rs.setHeader('Content-Type', 'application/json');
        if (/action=occ_add/.test(rq.url)) { rs.statusCode = 422; rs.end(JSON.stringify({ success: false, error: 'TASK_BLOCKED_BY_SICK_OR_TRIP', message: 'Повтор 12.06 15:00: Тестов Т. на больничном — повтор нельзя назначить на эти дни.', blocked_days: [{ date: AD(4), employee_id: e1, reason: 'sick' }] })); }
        else { rs.statusCode = 404; rs.end('{}'); }
      });
      await new Promise((rz) => mock.listen(0, '127.0.0.1', rz));
      const M = makeEnv('http://127.0.0.1:' + mock.address().port, '');
      M.S.user = { role: 'admin', isAdmin: true }; M.S.employees = emps; M.S.empById = {};
      M.S.tasks = [mk('mt', 'Задача мок', day + 'T09:00', day + 'T10:00')]; M.S.view = 'calendar'; M.S.cal.mode = 'week'; M.S.cal.anchor = day; M.U.render();
      M.U.calCopy('mt');
      await M.U.calPaste({ kind: 'slot', date: AD(4), min: 900 });
      check('CP20 повтор на день больничного исполнителя: сообщение сервера показано пользователю, повтор не добавлен',
        M.S.msg && M.S.msg.type === 'error' && /Повтор не добавлен: Повтор 12\.06 15:00: Тестов Т\. на больничном/.test(M.S.msg.text) && M.S.tasks[0].occurrences === undefined, JSON.stringify(M.S.msg));
      await new Promise((rz) => mock.close(rz));
    }
    A.U.HOOK.hit = null;
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
