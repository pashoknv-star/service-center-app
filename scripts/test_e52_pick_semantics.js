// E5-2 verification harness: employee-pick click semantics. Pure Node, no deps.
// Loads js/trips.js in a DOM shim and exercises the pick-mode document click
// handler (plain click = replace selection, Ctrl/Cmd+click = toggle), the
// «Подтвердить» empty-selection guard and the new cancelEmployeePick().
// Mirrors scripts/test_e51_pick_geometry.js.
'use strict';

const fs = require('fs');
const vm = require('vm');

const tripsSrc = fs.readFileSync(__dirname + '/../js/trips.js', 'utf8');

// ---- minimal DOM shims (trips.js runs as a browser IIFE) ----
function makeEl(tag) {
  const el = {
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
    parent: null,
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
      if (edgeRef.current === this) edgeRef.current = null;
    },
    closest(selector) {
      const parts = String(selector).split(',').map(s => s.trim()).filter(Boolean);
      let node = this;
      while (node) {
        for (const p of parts) {
          if (p[0] === '.' && node.classList.contains(p.slice(1))) return node;
          if (p[0] !== '.' && p === node.tagName.toLowerCase()) return node;
        }
        node = node.parent;
      }
      return null;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(c) { c.parent = this; this.children.push(c); }
  };
  return el;
}

const edgeRef = { current: null };   // .trip-pick-edge container
const panelRef = { current: null };  // .vacation-panel
const cards = [];                    // rendered .employee cards
const bodyChildren = [];
const docListeners = {};             // document-level listener registry

const documentShim = {
  head: makeEl('head'),
  body: null,
  _byId: {},
  getElementById(id) { return this._byId[id] || null; },
  documentElement: { style: {} },
  querySelector(sel) {
    if (sel === '.vacation-panel') return panelRef.current;
    if (sel === '.trip-pick-edge') return edgeRef.current;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '.employee.selected') return cards.filter(c => c.classList.contains('selected'));
    return [];
  },
  addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  removeEventListener(type, fn) {
    docListeners[type] = (docListeners[type] || []).filter(f => f !== fn);
  },
  createElement(tag) { return makeEl(tag); }
};
documentShim.body = {
  appendChild(c) { bodyChildren.push(c); },
  querySelector(sel) { return documentShim.querySelector(sel); },
  querySelectorAll(sel) { return documentShim.querySelectorAll(sel); },
  addEventListener() {}, removeEventListener() {},
  classList: { add() {}, remove() {}, contains() { return false; } }
};

const windowShim = {
  document: documentShim,
  location: { href: 'http://localhost/', origin: 'http://localhost' },
  navigator: { userAgent: 'node-shim' },
  alert(msg) { windowShim.__lastAlert = msg; },
  confirm() { return true; },
  addEventListener() {},
  removeEventListener() {},
  Trips: null,
  __serverEmployees: [
    { id: 'emp_1', name: 'Сотрудник 1' },
    { id: 'emp_2', name: 'Сотрудник 2' },
    { id: '3',     name: 'Сотрудник 3' }
  ]
};

const sandbox = {
  document: documentShim,
  window: windowShim,
  self: windowShim,
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  alert(msg) { windowShim.__lastAlert = msg; },
  confirm() { return true; },
  fetch() { return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); },
  URLSearchParams, Promise, JSON, Math, Date, Set, Map,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent
};
vm.createContext(sandbox);
vm.runInContext(tripsSrc, sandbox, { filename: 'js/trips.js' });

const Trips = windowShim.Trips;
if (!Trips || typeof Trips.startEmployeePick !== 'function') {
  console.error('FATAL: window.Trips.startEmployeePick not exported');
  process.exit(1);
}
if (typeof Trips.cancelEmployeePick !== 'function') {
  console.error('FATAL: window.Trips.cancelEmployeePick not exported');
  process.exit(1);
}
sandbox.Trips = Trips;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' -- ' + detail : '')); }
}

// ---- static checks (acceptance #1, #2) ----
check('static: legacy ctrl-early-return removed',
  !/if \(!\(event\.ctrlKey \|\| event\.metaKey\)\) return/.test(tripsSrc));
check('static: cancelEmployeePick defined',
  /function cancelEmployeePick\(\)/.test(tripsSrc));
check('static: cancelEmployeePick exported in window.Trips',
  /cancelEmployeePick:\s*cancelEmployeePick/.test(tripsSrc));
check('static: edge «Отменить» wired to cancelEmployeePick',
  /btnCancel[\s\S]{0,400}?cancelEmployeePick\(\)/.test(tripsSrc));
check('static: plain-click branch calls selectSingleEmployeePick',
  /selectSingleEmployeePick\(card, empId\)/.test(tripsSrc));

// ---- helpers ----
function makeCard(id) {
  const c = makeEl('article');
  c.classList.add('employee');
  c.setAttribute('data-id', String(id));
  cards.push(c);
  return c;
}
function clickEvent(target, opts) {
  return {
    target,
    ctrlKey: !!(opts && opts.ctrl),
    metaKey: !!(opts && opts.meta),
    _pd: false, _sp: false,
    preventDefault() { this._pd = true; },
    stopPropagation() { this._sp = true; }
  };
}
function fireDocClick(ev) {
  (docListeners.click || []).slice().forEach(fn => fn(ev));
}
function picked() { return windowShim.Trips.pickedEmployees; }

const card1 = makeCard(1);
const card2 = makeCard(2);
const card3 = makeCard(3);
const draft = { id: null, participants: [] };

// ---- T1: start pick mode ----
panelRef.current = makeEl('aside');
panelRef.current.classList.add('vacation-panel');
Trips.startEmployeePick(draft);
check('start: pick active', windowShim._employeePickActive === true);
check('start: document click listener installed',
  (docListeners.click || []).length === 1);

const edge = bodyChildren.find(c => c.className === 'trip-pick-edge');
edgeRef.current = edge;
const bConfirm = edge.children[0];
const bCancel = edge.children[1];

// ---- T2: plain click = single select, event does not reach host ----
fireDocClick(clickEvent(card1));
check('plain click: card1 selected', card1.classList.contains('selected'));
check('plain click: picked = {1}', picked() && picked().size === 1 && picked().has('1'));

const ev2 = clickEvent(card2);
fireDocClick(ev2);
check('plain click: preventDefault called', ev2._pd === true);
check('plain click: stopPropagation called', ev2._sp === true);

// ---- T3: plain click replaces previous selection ----
check('replace: card2 selected, card1 deselected',
  card2.classList.contains('selected') && !card1.classList.contains('selected'));
check('replace: picked = {2}', picked().size === 1 && picked().has('2'));

// ---- T4: Ctrl+click adds to selection ----
fireDocClick(clickEvent(card3, { ctrl: true }));
check('ctrl click: picked = {2,3}',
  picked().size === 2 && picked().has('2') && picked().has('3') && card3.classList.contains('selected'));

// ---- T5: Ctrl+click toggles off ----
fireDocClick(clickEvent(card3, { ctrl: true }));
check('ctrl toggle: picked back to {2}',
  picked().size === 1 && picked().has('2') && !card3.classList.contains('selected'));

// ---- T6: Meta+click behaves like Ctrl ----
fireDocClick(clickEvent(card1, { meta: true }));
check('meta click: picked = {1,2}',
  picked().size === 2 && picked().has('1') && picked().has('2'));

// ---- T7: clicks on inner controls pass through ----
const innerBtn = makeEl('button');
innerBtn.parent = card1;
const evBtn = clickEvent(innerBtn);
fireDocClick(evBtn);
check('inner control: not intercepted', evBtn._pd === false && evBtn._sp === false);
check('inner control: selection unchanged', picked().size === 2);

// ---- T8: clicks outside cards pass through ----
const outside = makeEl('div');
const evOut = clickEvent(outside);
fireDocClick(evOut);
check('outside click: not intercepted', evOut._pd === false && evOut._sp === false);

// ---- T9: confirm with selection -> participants + pick ends ----
const partsBefore = draft.participants.length;
bConfirm.listeners.click[0]();
check('confirm: participants added with empty dates',
  draft.participants.length === partsBefore + 2 &&
  draft.participants.every(p => p.startDate === '' && p.endDate === ''));
check('confirm: pick ended', windowShim._employeePickActive === false);
check('confirm: document click listener removed',
  (docListeners.click || []).length === 0);
check('confirm: pickedEmployees reset', Trips.pickedEmployees === null);
check('confirm: slided class removed',
  !panelRef.current.classList.contains('trip-panel-slided'));
check('confirm: info panel suppression lifted', Trips.suppressInfoPanel() === false);

// ---- T10: confirm with 0 selected -> alert, pick mode STAYS ----
Trips.startEmployeePick(draft);
edgeRef.current = bodyChildren[bodyChildren.length - 1];
const bConfirm2 = edgeRef.current.children[0];
windowShim.__lastAlert = null;
bConfirm2.listeners.click[0]();
check('confirm(empty): alert shown',
  windowShim.__lastAlert === 'Выберите хотя бы одного сотрудника');
check('confirm(empty): pick mode kept', windowShim._employeePickActive === true);
check('confirm(empty): edge still present', edgeRef.current === edgeRef.current && !!edgeRef.current);
check('confirm(empty): panel still slided',
  panelRef.current.classList.contains('trip-panel-slided'));

// ---- T11: «Отменить» -> cancelEmployeePick: selection cleared, panel back, NO participants ----
const innerBtn2 = makeEl('button'); // unused, keep shape
fireDocClick(clickEvent(card1));            // plain click select {1}
fireDocClick(clickEvent(card2, { ctrl: true })); // ctrl add {1,2}
const partsBeforeCancel = draft.participants.length;
check('pre-cancel: selection {1,2}',
  picked() && picked().size === 2 &&
  card1.classList.contains('selected') && card2.classList.contains('selected'));
const bCancel2 = edgeRef.current.children[1];
bCancel2.listeners.click[0]();
check('cancel: pick ended', windowShim._employeePickActive === false);
check('cancel: highlights cleared from cards',
  !card1.classList.contains('selected') && !card2.classList.contains('selected'));
check('cancel: pickedEmployees reset', Trips.pickedEmployees === null);
check('cancel: NO participants added',
  draft.participants.length === partsBeforeCancel);
check('cancel: document click listener removed',
  (docListeners.click || []).length === 0);
check('cancel: slided class removed',
  !panelRef.current.classList.contains('trip-panel-slided'));
check('cancel: edge removed', edgeRef.current === null);

// ---- T12: repeat pick flow works after cancel ----
Trips.startEmployeePick({ id: null, participants: [] });
check('repeat: pick restarts cleanly', windowShim._employeePickActive === true);
check('repeat: listener reinstalled', (docListeners.click || []).length === 1);
const edge2 = bodyChildren[bodyChildren.length - 1];
edgeRef.current = edge2;
fireDocClick(clickEvent(card3, { ctrl: true }));
check('repeat: ctrl-click works in new session',
  Trips.pickedEmployees && Trips.pickedEmployees.has('3'));
edge2.children[0].listeners.click[0](); // confirm -> ends
check('repeat: second confirm ends pick', windowShim._employeePickActive === false);

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
