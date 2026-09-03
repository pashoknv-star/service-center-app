// E5-1 verification harness: pick-mode geometry. Pure Node, no deps.
// Loads js/trips.js in a DOM shim and exercises startEmployeePick /
// confirmEmployeePick / endEmployeePick. Mirrors scripts/test_r4_hygiene.js.
'use strict';

const fs = require('fs');
const vm = require('vm');

const tripsSrc = fs.readFileSync(__dirname + '/../js/trips.js', 'utf8');
const indexHtml = fs.readFileSync(__dirname + '/../index.html', 'utf8');

// ---- minimal DOM shims (trips.js runs as a browser IIFE) ----
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); }
    },
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    children: [],
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = (this.listeners[type] || []).filter(f => f !== fn);
      this.listeners[type] = a;
    },
    getAttribute(k) { return this.dataset[k] || null; },
    setAttribute(k, v) { this.dataset[k] = String(v); },
    remove() {
      // Real DOM: removal detaches the node so querySelector stops finding it.
      if (edgeRef.current === this) edgeRef.current = null;
    },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(c) { this.children.push(c); }
  };
}

const edgeRef = { current: null };   // .trip-pick-edge container
const panelRef = { current: null };  // .vacation-panel
const bodyChildren = [];

const documentShim = {
  head: makeEl('head'),
  body: {
    appendChild(c) { bodyChildren.push(c); }
  },
  _byId: {},
  getElementById(id) { return this._byId[id] || null; },
  documentElement: { style: {} },
  querySelector(sel) {
    if (sel === '.vacation-panel') return panelRef.current;
    if (sel === '.trip-pick-edge') return edgeRef.current;
    return null;
  },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
  createElement(tag) { return makeEl(tag); }
};
documentShim.body.querySelector = function(sel) {
  if (sel === '.trip-pick-edge') return edgeRef.current;
  return null;
};
documentShim.body.querySelectorAll = function() { return []; };
documentShim.body.addEventListener = function() {};
documentShim.body.removeEventListener = function() {};

const windowShim = {
  document: documentShim,
  location: { href: 'http://localhost/', origin: 'http://localhost' },
  navigator: { userAgent: 'node-shim' },
  alert(msg) { windowShim.__lastAlert = msg; },
  confirm() { return true; },
  addEventListener() {},
  removeEventListener() {},
  Trips: null
};

const sandbox = {
  document: documentShim,
  window: windowShim,
  self: windowShim,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  alert(msg) { windowShim.__lastAlert = msg; },
  confirm() { return true; },
  fetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
  URLSearchParams,
  Promise,
  JSON,
  Math,
  Date,
  Set,
  Map,
  isNaN,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent
};

vm.createContext(sandbox);
vm.runInContext(tripsSrc, sandbox, { filename: 'js/trips.js' });

const Trips = windowShim.Trips;
if (!Trips || typeof Trips.startEmployeePick !== 'function') {
  console.error('FATAL: window.Trips.startEmployeePick not exported');
  process.exit(1);
}
// In a browser, `window.Trips = {...}` also creates the bare global `Trips`
// that trips.js internals reference; mirror that in the sandbox.
sandbox.Trips = Trips;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

// ---- static checks against index.html (acceptance #2) ----
const slidedRule = indexHtml.match(/aside\.vacation-panel\.trip-panel-slided\s*\{[^}]*\}/);
check('index.html: .trip-panel-slided rule exists', !!slidedRule);
if (slidedRule) {
  const rule = slidedRule[0];
  check('index.html: translateX(-100%), no calc(-100% + 46px)',
    rule.includes('translateX(-100%)') && !rule.includes('46px'),
    rule.replace(/\s+/g, ' '));
  check('index.html: left:0 kills base left:3px (panel right<=0)',
    rule.includes('left: 0'));
}
check('index.html: out-click guard keeps .trip-pick-edge exemption',
  /closest\('\.btn, \.trip-btn, \.trip-pick-edge'\)/.test(indexHtml));

// ---- live checks: startEmployeePick (acceptance #1, #3) ----
panelRef.current = makeEl('aside');
panelRef.current.className = 'vacation-panel';

Trips.startEmployeePick({ id: null });

check('pick: active + suppressInfoPanel=true',
  windowShim._employeePickActive === true && Trips.suppressInfoPanel() === true);
check('pick: panel keeps fixed — NO style.position override',
  panelRef.current.style.position === undefined || panelRef.current.style.position === '',
  'style.position=' + JSON.stringify(panelRef.current.style.position));
check('pick: slided class added',
  panelRef.current.classList.contains('trip-panel-slided'));
check('pick: .trip-pick-edge appended to document.body',
  bodyChildren.some(c => c.className === 'trip-pick-edge'));

const edge = bodyChildren.find(c => c.className === 'trip-pick-edge');
edgeRef.current = edge;

check('edge: container is a DIV (not the button itself)', edge.tagName === 'DIV');
check('edge: exactly 2 stacked buttons',
  edge.children.length === 2 && edge.children.every(c => c.tagName === 'BUTTON'));

const bConfirm = edge.children[0];
const bCancel = edge.children[1];
check('edge: button[0] Podtverdit primary',
  bConfirm.textContent === 'Подтвердить' && /trip-pick-edge-btn-primary/.test(bConfirm.className));
check('edge: button[1] Otmenit secondary',
  bCancel.textContent === 'Отменить' && /trip-pick-edge-btn-secondary/.test(bCancel.className));

// CSS block: container geometry + horizontal text (no rotation)
const css = documentShim.head.children.map(c => c.textContent).join('\n');
const pickEdgeCss = css.match(/\.trip-pick-edge\s*\{[^}]*\}/);
check('css: .trip-pick-edge rule injected', !!pickEdgeCss);
if (pickEdgeCss) {
  const r = pickEdgeCss[0];
  check('css: fixed left:0 top:50% translateY(-50%)',
    /position:\s*fixed/.test(r) && /left:\s*0/.test(r) && /top:\s*50%/.test(r) && /translateY\(-50%\)/.test(r));
  const w = r.match(/width:\s*(\d+)px/);
  check('css: container width ~50px (50-64 range)', !!w && +w[1] >= 50 && +w[1] <= 64, w && w[1]);
  // E6-T3 (владелец, «Ошибки 6»): требование 0° ОТМЕНЕНО — текст ярлыка теперь
  // ОБЯЗАН быть повёрнут (90°, чтение снизу вверх). Ассерт E5 заменён:
  check('css: vertical text (writing-mode + rotate for bottom-up reading)',
    /writing-mode:\s*vertical-rl/.test(css) && /rotate\(180deg\)/.test(css));
}
check('css: primary button styled with --rt-purple',
  /\.trip-pick-edge-btn-primary\s*\{[^}]*--rt-purple/.test(css));

// ---- behaviour: Отменить -> endEmployeePick ----
windowShim._employeePickClickHandler = function() {};
bCancel.listeners.click[0]();
check('cancel: pick deactivated', windowShim._employeePickActive === false);
check('cancel: slided class removed',
  !panelRef.current.classList.contains('trip-panel-slided'));
check('cancel: edge container removed from body',
  edgeRef.current === null);

// ---- behaviour: Подтвердить with empty selection -> alert, pick stays ----
panelRef.current.classList.add('trip-panel-slided');
Trips.startEmployeePick({ id: null });
edgeRef.current = bodyChildren[bodyChildren.length - 1];
const bConfirm2 = edgeRef.current.children[0];
bConfirm2.listeners.click[0]();
check('confirm(empty): alert shown, pick NOT ended',
  windowShim.__lastAlert === 'Выберите хотя бы одного сотрудника' && windowShim._employeePickActive === true);

// ---- behaviour: Подтвердить with selection -> participant added + pick ends ----
const draft = { id: null, participants: [] };
windowShim._employeePickContext = draft;
windowShim.Trips.pickedEmployees = new Set(['1']);
bConfirm2.listeners.click[0]();
check('confirm(seeded): pick ended after confirm', windowShim._employeePickActive === false);
check('confirm(seeded): edge removed again', edgeRef.current === null);

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
