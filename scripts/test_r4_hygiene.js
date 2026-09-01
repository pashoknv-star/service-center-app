// R4 verification harness: evaluates js/trips.js in a DOM shim and exercises
// the new zone / monkey-patch-restore / hygiene code paths. Pure Node, no deps.
'use strict';

const fs = require('fs');
const vm = require('vm');

const tripsSrc = fs.readFileSync(__dirname + '/../js/trips.js', 'utf8');

// ---- minimal DOM/event shims (trips.js runs in a browser IIFE) ----
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
    value: '',
    disabled: false,
    textContent: '',
    children: [],
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = (this.listeners[type] || []).filter(f => f !== fn);
      this.listeners[type] = a;
    },
    getAttribute(k) { return this.dataset[k] || null; },
    setAttribute(k, v) { this.dataset[k] = String(v); },
    remove() {},
    closest() { return null; },
    querySelector(sel) {
      if (sel === '.vacation-panel') return this._vacationPanel || null;
      if (sel === '.trip-pick-dock') return this._dock || null;
      if (sel === '.day-cell-data') return this._dayCell || null;
      return null;
    }
  };
}

const documentShim = {
  _byId: {},
  getElementById(id) { return this._byId[id] || null; },
  querySelector(sel) {
    if (sel === '.vacation-panel') return this._vacationPanel || null;
    if (sel === '.trip-pick-dock') return this._dock || null;
    if (sel === '.trip-modal-overlay') return this._overlay || null;
    return null;
  },
  querySelectorAll(sel) { return []; },
  createElement(tag) { return makeEl(tag); },
  body: { appendChild() {}, insertAdjacentHTML() {}, querySelector() { return null; } },
  head: { appendChild() {} },
  addEventListener(type, fn) { (this._listeners = this._listeners || {})[type] = this._listeners[type] || []; this._listeners[type].push(fn); },
  removeEventListener(type, fn) { const a = ((this._listeners || {})[type] || []).filter(f => f !== fn); (this._listeners = this._listeners || {})[type] = a; },
  documentElement: { style: {} }
};

const windowShim = {
  document: documentShim,
  console,
  setTimeout,
  clearTimeout,
  fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, trips: [], lastSyncId: 0 }) }),
  // Host globals the real page defines AFTER trips.js loads (inline script)
  currentYear: 2026,
  handleCellMouseUp: undefined, // NOT defined in the current build (closure) — D3 must handle absence
  getDayVacationType: undefined
};

const sandbox = {
  window: windowShim,
  document: documentShim,
  console,
  Date,
  Math,
  Number,
  String,
  Array,
  Object,
  JSON,
  isNaN,
  parseInt,
  parseFloat,
  Set,
  Map,
  Promise,
  fetch: windowShim.fetch,
  setTimeout,
  clearTimeout,
  location: { protocol: 'http:', host: 'x' },
  navigator: { userAgent: 'node' },
  globalThis: null
};
sandbox.globalThis = sandbox;

// Classic script — top-level `var` lands on the sandbox; `window.X` on windowShim.
vm.createContext(sandbox);
vm.runInContext(tripsSrc, sandbox, { filename: 'trips.js' });

// Before tests: supply the zone-capable mirror that index.html now sets.
windowShim.__serverEmployees = [
  { id: 'emp_1', name: 'Иванов', dept: 1 },
  { id: 'emp_2', name: 'Петров', dept: 0 },
  { id: 'emp_9', name: 'Сидоров', dept: 0 }
];

// Host-page closure globals that trips.js already relies on (pre-existing
// usage: openDraftModal, startCalendarPick call formatDateStr unguarded; the
// browser host defines both in its inline script). Mirror them so the tests
// isolate the NEW guards rather than tripping on host-environment gaps.
windowShim.formatDateStr = function (year, month, day) {
  var mm = String(month + 1).padStart(2, '0');
  var dd = String(day).padStart(2, '0');
  return year + '-' + mm + '-' + dd;
};
// The IIFE resolves bare `formatDateStr`/`getDayVacationType` on the script
// global — mirror them there too (browser: window IS the global).
sandbox.formatDateStr = windowShim.formatDateStr;
windowShim.getDayVacationType = undefined; // D2 test starts with unavailable

const Trips = sandbox.window.Trips;
// In a browser, `window.Trips = {...}` also creates the bare global `Trips`
// that endEmployeePick references (pre-existing). Mirror it for the harness.
sandbox.Trips = Trips;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

// ============ Test 1: exports ============
check('canDeleteTrip exported', typeof Trips.canDeleteTrip === 'function');
check('canConfirmTrip exported', typeof Trips.canConfirmTrip === 'function');

// ============ Test 2: zone-aware canDeleteTrip ============
// Admin can delete anything
check('admin deletes foreign-zone trip', Trips.canDeleteTrip(
  { id: 't1', status: 'forecast', participants: [{ employeeId: 'emp_9' }] },
  { isAdmin: true, role: 'admin', scopeGroupId: null }
) === true);

// Supervisor of g1 with a g1 participant — allowed
check('g1 supervisor deletes own-zone forecast', Trips.canDeleteTrip(
  { id: 't2', status: 'forecast', participants: [{ employeeId: 'emp_1' }] },
  { isAdmin: false, role: 'supervisor', scopeGroupId: 'g1' }
) === true);

// Supervisor of g0 with a g1 participant — NOT allowed (D4 fix)
check('g0 supervisor CANNOT delete g1-zone trip', Trips.canDeleteTrip(
  { id: 't3', status: 'forecast', participants: [{ employeeId: 'emp_1' }] },
  { isAdmin: false, role: 'supervisor', scopeGroupId: 'g0' }
) === false);

// Supervisor without scope — fail closed
check('supervisor without scopeGroupId cannot delete', Trips.canDeleteTrip(
  { id: 't4', status: 'forecast', participants: [{ employeeId: 'emp_1' }] },
  { isAdmin: false, role: 'supervisor' }
) === false);

// Non-forecast trip — not deletable even by supervisor
check('supervisor cannot delete confirmed trip', Trips.canDeleteTrip(
  { id: 't5', status: 'confirmed', participants: [{ employeeId: 'emp_1' }] },
  { isAdmin: false, role: 'supervisor', scopeGroupId: 'g1' }
) === false);

// ============ Test 3: canConfirmTrip ============
check('admin can confirm', Trips.canConfirmTrip(
  { id: 't6', status: 'forecast', participants: [{ employeeId: 'emp_1' }] },
  { isAdmin: true, role: 'admin' }
) === true);
check('supervisor own zone can confirm', Trips.canConfirmTrip(
  { id: 't7', status: 'forecast', participants: [{ employeeId: 'emp_1' }] },
  { isAdmin: false, role: 'supervisor', scopeGroupId: 'g1' }
) === true);
check('supervisor foreign zone cannot confirm', Trips.canConfirmTrip(
  { id: 't8', status: 'forecast', participants: [{ employeeId: 'emp_1' }] },
  { isAdmin: false, role: 'supervisor', scopeGroupId: 'g0' }
) === false);

// ============ Test 4: getDayVacationType guard (D2) ============
// With getDayVacationType undefined at host, openDraft must not throw.
sandbox.document._overlay = makeEl('div'); // openDraftModal path: uses trip-modal-overlay
// openDraft → no conflicts → openDraftModal (querySelector + insertAdjacentHTML)
let threw = false;
let errMsg = '';
try {
  Trips.openDraft([{ employeeId: 'emp_1', startDate: '2026-03-10', endDate: '2026-03-12' }]);
} catch (e) { threw = true; errMsg = String(e && e.stack || e); }
check('openDraft does not throw when getDayVacationType unavailable', !threw);
if (!threw && errMsg) console.log('  (err suppressed?)');
if (errMsg) console.log('  openDraft error:', errMsg.split('\n')[0]);

// ============ Test 5: date validation (D5) ============
// With getDayVacationType available, invalid dates must be skipped, not loop/crash.
windowShim.getDayVacationType = function () { return 'vacation'; };
let threw2 = false;
try {
  Trips.openDraft([{ employeeId: 'emp_1', startDate: '2026-13-40', endDate: '2026-13-41' }]);
} catch (e) { threw2 = true; console.log('  invalid-date openDraft error:', String(e)); }
check('openDraft skips invalid dates without throwing', !threw2);

// ============ Test 6: endEmployeePick null-guard (D7) ============
sandbox.document._vacationPanel = null; // panel absent
let threw3 = false;
try {
  Trips.endEmployeePick();
} catch (e) { threw3 = true; console.log('  endEmployeePick error:', String(e)); }
check('endEmployeePick handles missing vacation-panel', !threw3);

// ============ Test 7: monkey-patch restore (D3) ============
// Simulate a host that DID define window.handleCellMouseUp before pick.
const originalHostHandler = function () { return 'original'; };
windowShim.handleCellMouseUp = originalHostHandler;

// Start calendar pick; expect window.handleCellMouseUp to be replaced
Trips.startCalendarPick(null, 0);
check('calendar pick replaced window.handleCellMouseUp', windowShim.handleCellMouseUp !== originalHostHandler);
check('_calendarPickContext set', !!windowShim._calendarPickContext);

// The patch calls orig when NOT in pick mode; drive it as if a normal click happened
// after pick ended: ensure it falls through to original.
// First, cancel via Escape: the escHandler must restore the original.
let escEvent = { key: 'Escape' };
// grab the registered keydown handler
const keydownHandlers = (documentShim._listeners || {}).keydown || [];
check('ESC handler registered', keydownHandlers.length > 0);
keydownHandlers.forEach(fn => fn(escEvent));
check('ESC cancelled _calendarPickContext', windowShim._calendarPickContext === null);
check('ESC restored original handleCellMouseUp', windowShim.handleCellMouseUp === originalHostHandler);

// Start again and this time complete a pick (supports _state.draft path)
// (we don't drive the full draft flow, just verify the completion path restores; the
//  update branch requires _state.draft which is internal — but restore call is
//  unconditional when a valid cell is picked. We simulate by calling the handler
//  with no day-cell: it falls through to original because _calendarPickContext set.)
Trips.startCalendarPick(null, 0);
windowShim.handleCellMouseUp({ target: { closest: () => makeEl('td') } });
// clean: restore via ESC again
(documentShim._listeners.keydown || []).forEach(fn => fn({ key: 'Escape' }));
check('final restore after second pick', windowShim.handleCellMouseUp === originalHostHandler);

console.log('');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);