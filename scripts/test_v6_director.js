#!/usr/bin/env node
// V6-3 (R-2, «Управление СЦ») verification harness.
//
// Чистый Node (без браузера/зависимостей), образец — e51/e52/tasksmx. Покрывает:
//  A) имя зоны: ZONES[3] в index.html и js/storage.js совпадает и равно «Управление СЦ»; весь массив ZONES
//     в двух файлах идентичен; <select id="editDept"> без «В2С»; «В2С» (в т.ч. латинские двойники) нигде
//     в коде/api/js/scripts не осталось; код не опирается на имя зоны (нет ZONES.indexOf/сравнения по имени);
//  B) порядок групп матрицы: реальные matrixZoneRank/compareMatrixEmployees + реальный renderVacationMatrix
//     из index.html, исполненный в vm со стабами: зона 3 — первой группой независимо от порядка ZONES и входа,
//     подпись группы «Управление СЦ», класс подсветки ТОЛЬКО у строк зоны 3, пустая зона 3 → группы/класса нет,
//     остальной порядок — как раньше, у строки сохранён data-emp-id (V6-1 openMatrixAt), дней отпуска не касается;
//  C) CSS: золотая плитка ограничена зоной 3, 7 бриллиантов (5–9), inline SVG, без внешних файлов и без анимации,
//     контраст названия ≥ 4.5:1 на обоих краях градиента, рамка у фото, мобильные правила, подсветка строки
//     матрицы 6–10 % и не затрагивает цвета отпусков/hover/выделение диапазона;
//  D) фото: JPEG, квадрат ≤ 300×300, ≤ 60 КБ;
//  E) данные на проде (scripts/v6_director_data.sql) на копии dev-БД с вымышленным сотрудником: DRY-RUN ничего не
//     меняет и печатает счётчики; APPLY меняет ровно 1 сотрудника + snapshot + audit + sync_log; история не тронута;
//     повтор — 0 изменений; 0 / 2 совпадения и существующий «Игнатенко» — no-op; миграция v10→v11 на копии БД.
// Итог: «RESULT: N passed, M failed».
'use strict';

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const INDEX = read('index.html');
const STORAGE = read('js/storage.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 400) : '')); }
}

// --- выделение кода из index.html -------------------------------------------------
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('нет функции ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('не закрыта функция ' + name);
}
function extractZones(src) {
  const m = src.match(/(?:const|var)\s+ZONES\s*=\s*\[([\s\S]*?)\]\s*;/);
  if (!m) throw new Error('нет ZONES');
  return { decl: m[0], list: vm.runInNewContext('[' + m[1] + ']') };
}

// ============================================================================
console.log('=== A. Название зоны ===');
const zi = extractZones(INDEX), zs = extractZones(STORAGE);
check('ZONES[3] в index.html = «Управление СЦ»', zi.list[3] === 'Управление СЦ', zi.list[3]);
check('ZONES[3] в js/storage.js = «Управление СЦ»', zs.list[3] === 'Управление СЦ', zs.list[3]);
check('ZONES совпадает в index.html и js/storage.js (7 зон)', zi.list.length === 7 && JSON.stringify(zi.list) === JSON.stringify(zs.list), JSON.stringify([zi.list, zs.list]));
check('прочие зоны не переименованы', JSON.stringify(zi.list.filter((_, i) => i !== 3)) === JSON.stringify(['Группа клиентского сервиса', 'Группа эксплуатации', 'Группа сопровождения', 'Супервайзер', 'Энергетик', 'Транспорт']));
const sel = INDEX.match(/<select id="editDept">([\s\S]*?)<\/select>/);
check('<select id="editDept">: option 3 = «Управление СЦ»', !!sel && /<option value="3">Управление СЦ<\/option>/.test(sel[1]));
check('<select id="editDept">: 7 опций, без «В2С»', !!sel && (sel[1].match(/<option/g) || []).length === 7 && !/[ВB]2[СC]/i.test(sel[1]));

const oldName = new RegExp('(?<![\\p{L}\\p{N}])[В' + 'B' + 'в' + 'b]2[СCсc](?![\\p{L}\\p{N}])', 'u');   // кириллические и латинские двойники, целым словом
const codeFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['.git', 'reports', 'staff_project', 'node_modules', 'data', 'static', 'images'].includes(e.name) && !rel.startsWith('n8n/')) walk(rel); }
    else if (/\.(php|js|html|sh|sql|json|py)$/.test(e.name)) codeFiles.push(rel);
  }
})('.');
const self = path.relative(ROOT, __filename);
const leftovers = codeFiles.filter((f) => f !== self && f !== 'api/tasks_test.php' && f !== 'api/db.php' && f !== 'scripts/v6_director_data.sql' && oldName.test(read(f)));
check('«В2С» не осталось в коде/api/js/scripts (' + codeFiles.length + ' файлов; тесты миграции и SQL-скрипт упоминают старое имя намеренно)', leftovers.length === 0, leftovers.join(', '));
check('миграция v11 переименовывает только g3 с именем «В2С» или «Директор СЦ» (v12 — V6.3-2, повторы задач)', /UPDATE groups SET name = 'Управление СЦ' WHERE id = 'g3' AND name IN \('В2С', 'Директор СЦ'\)/.test(read('api/db.php')) && /SCHEMA_VERSION = 12/.test(read('api/db.php')));
const oldDir = ['Директор', 'СЦ'].join(' ');   // прежнее имя зоны 3 (склейка — чтобы сьют не находил его в самом себе)
const leftovers2 = codeFiles.filter((f) => !['api/tasks_test.php', 'api/db.php', 'scripts/v6_accept_data.sh', self].includes(f) && read(f).includes(oldDir));
check('прежнее имя зоны «' + oldDir + '» нигде не осталось в коде/api/js/scripts (кроме миграции v11 и её тестов)', leftovers2.length === 0, leftovers2.join(', '));
const byName = codeFiles.filter((f) => /\.(js|html|php)$/.test(f) && !/_test\.|^scripts\/test_/.test(f) && /ZONES\.(indexOf|findIndex|includes)\(|zoneByName|groupByName/.test(read(f)));
check('ничто не сопоставляет зону по имени (ZONES.indexOf/findIndex/includes, zoneByName, groupByName)', byName.length === 0, byName.join(', '));
check('в коде нет ФИО из решения владельца (опора на зону/группу)', !/Костецк|Игнатенк/.test(INDEX + STORAGE + read('api/db.php') + read('js/tasks_matrix.js')));

// ============================================================================
console.log('=== B. Матрица: порядок групп и подсветка (реальный renderVacationMatrix в vm) ===');
const helperSrc = 'const DIRECTOR_ZONE = 3;\n' + extractFunction(INDEX, 'matrixZoneRank') + '\n' + extractFunction(INDEX, 'compareMatrixEmployees');
check('DIRECTOR_ZONE в index.html = 3', /const DIRECTOR_ZONE = 3;/.test(INDEX));
const renderSrc = extractFunction(INDEX, 'renderVacationMatrix');

function dayOfYearToDate(year, doy) {
  const d = new Date(Date.UTC(year, 0, doy));
  return { month: d.getUTCMonth(), day: d.getUTCDate() };
}
function renderWith(emps, opts) {
  opts = opts || {};
  const els = () => ({ forEach() {}, length: 0 });
  const ctx = {
    console, Number, String, Math, Date, Map, parseInt,
    currentYear: 2026, employees: emps, vacationData: opts.vacationData || {},
    yearDisplay: { textContent: '' },
    matrixHead: { innerHTML: '', querySelectorAll: els },
    matrixBody: { innerHTML: '', querySelectorAll: els },
    cellTooltip: { style: {} }, vacationPanel: { classList: { contains: () => false } },
    document: { addEventListener() {} },
    MONTH_NAMES: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
    isLeapYear: (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0,
    getDaysInMonth: (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
    formatDateStr: (y, m, d) => y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
    dayOfYearToDate,
    HolidaysCalendar: { isHoliday: () => false, isWeekend: () => false, getLabel: () => '' },
    TYPE_CSS: { vacation: 'type-vacation' },
    getDayVacationType: opts.vtype || (() => null),
    getDayVacationRecord: () => null,
    handleCellClick() {}, handleCellMouseDown() {}, handleCellMouseEnter() {}, handleCellMouseUp() {}, handleCellHover() {},
    buildMatrixColumnIndex() {}, resetMatrixEmployeeCard() {},
  };
  vm.createContext(ctx);
  vm.runInContext(zi.decl + '\n' + helperSrc + '\n' + renderSrc + '\nrenderVacationMatrix();', ctx);
  return ctx.matrixBody.innerHTML;
}
function parseBody(html) {
  const rows = [];
  const re = /<tr( class="([^"]*)")?>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = re.exec(html))) {
    const cls = (m[2] || '').split(/\s+/).filter(Boolean);
    const lbl = /matrix-group-label">([^<]*)</.exec(m[3]);
    const emp = /data-emp-id="([^"]*)"[^>]*>([^<]*)</.exec(m[3]);
    rows.push({ cls, group: lbl ? lbl[1] : null, empId: emp ? emp[1] : null, name: emp ? emp[2] : null });
  }
  return rows;
}
const E = (id, name, dept, slot) => ({ id, name, dept, slot, role: 'Роль' });
const mixed = [E('a', 'Альфа', 0, 1), E('b', 'Браво', 1, 1), E('c', 'Чарли', 2, 1), E('d', 'Дельта', 4, 1), E('x', 'Тест Директор', 3, 5), E('y', 'Тест Директор Два', 3, 2), E('e', 'Эхо', 5, 1)];
let rows = parseBody(renderWith(mixed));
const order = rows.map((r) => r.group || r.name);
check('первая строка — группа «Управление СЦ»', rows[0].group === 'Управление СЦ' && rows[0].cls.includes('matrix-group-row'), JSON.stringify(rows[0]));
check('зона 3 — самой верхней группой над всеми остальными (зона 3 в конце входа)', JSON.stringify(order) === JSON.stringify(['Управление СЦ', 'Тест Директор Два', 'Тест Директор', 'Группа клиентского сервиса', 'Альфа', 'Группа эксплуатации', 'Браво', 'Группа сопровождения', 'Чарли', 'Супервайзер', 'Дельта', 'Энергетик', 'Эхо']), JSON.stringify(order));
check('внутри зоны 3 порядок по slot, у остальных зон — как раньше (по зоне, затем slot)', order[1] === 'Тест Директор Два' && order[2] === 'Тест Директор');
const dirRows = rows.filter((r) => r.cls.includes('matrix-row-director'));
check('класс подсветки matrix-row-director — ровно у строк зоны 3 (2 строки)', dirRows.length === 2 && dirRows.every((r) => /Директор/.test(r.name)), JSON.stringify(dirRows));
check('у остальных строк сотрудников класса подсветки нет', rows.filter((r) => r.empId && !r.cls.includes('matrix-row-director')).length === 5);
check('класс matrix-group-director — только у группы «Управление СЦ»', rows.filter((r) => r.cls.includes('matrix-group-director')).length === 1 && rows[0].cls.includes('matrix-group-director'));
check('у строки сохранён data-emp-id (опора V6-1 openMatrixAt и tasks_matrix)', dirRows.map((r) => r.empId).join() === 'y,x', dirRows.map((r) => r.empId).join());

// вход в другом порядке — результат тот же
rows = parseBody(renderWith(mixed.slice().reverse()));
check('результат не зависит от порядка входного массива', rows[0].group === 'Управление СЦ' && rows[1].name === 'Тест Директор Два' && rows[2].name === 'Тест Директор');

// пустая зона 3 → группы нет, ничего не подсвечено, порядок прежний
const noDir = mixed.filter((e) => e.dept !== 3);
rows = parseBody(renderWith(noDir));
check('пустая зона 3 → группы «Управление СЦ» нет', !rows.some((r) => r.group === 'Управление СЦ'));
check('пустая зона 3 → ни одной подсвеченной строки/группы', !rows.some((r) => r.cls.includes('matrix-row-director') || r.cls.includes('matrix-group-director')));
check('пустая зона 3 → порядок как в прежнем коде (по зоне, затем slot)', JSON.stringify(rows.map((r) => r.group || r.name)) === JSON.stringify(['Группа клиентского сервиса', 'Альфа', 'Группа эксплуатации', 'Браво', 'Группа сопровождения', 'Чарли', 'Супервайзер', 'Дельта', 'Энергетик', 'Эхо']));

// регрессия: сравнение со старым компаратором на данных без зоны 3 (случайные наборы)
{
  const oldCmp = (a, b) => (a.dept !== b.dept ? a.dept - b.dept : (a.slot || 0) - (b.slot || 0));
  const ctx = vm.createContext({ Number });
  vm.runInContext(helperSrc, ctx);
  let same = true;
  for (let t = 0; t < 200 && same; t++) {
    const list = [];
    for (let i = 0; i < 25; i++) { let d = Math.floor(Math.random() * 6); if (d >= 3) d++; list.push({ id: 'r' + i, dept: d, slot: Math.floor(Math.random() * 8) }); }
    const a = list.slice().sort(oldCmp).map((e) => e.id).join();
    const b = list.slice().sort(ctx.compareMatrixEmployees).map((e) => e.id).join();
    if (a !== b) same = false;
  }
  check('без зоны 3 новый компаратор даёт тот же порядок, что старый (200 случайных наборов)', same);
}

// ячейки отпуска у строки зоны 3 — те же классы, что у остальных
{
  const vt = (id, y, doy) => (doy >= 10 && doy <= 12 ? 'vacation' : null);
  const html = renderWith([E('x', 'Тест Директор', 3, 1), E('a', 'Альфа', 0, 1)], { vtype: vt });
  const cellsOf = (id) => (html.match(new RegExp('class="([^"]*)" data-emp="' + id + '" data-day="(\\d+)"', 'g')) || []);
  const dirCells = cellsOf('x'), otherCells = cellsOf('a');
  check('классы ячеек строки зоны 3 идентичны классам обычной строки (подсветка — только CSS на строке)', dirCells.length === 365 && dirCells.map((c) => c.replace(/data-emp="x"/, '')).join() === otherCells.map((c) => c.replace(/data-emp="a"/, '')).join());
  check('дни отпуска у строки зоны 3 с type-vacation (цвета отпусков работают как раньше)', dirCells.filter((c) => /type-vacation/.test(c)).length === 3);
}

// ============================================================================
console.log('=== C. CSS: золотая плитка, бриллианты, подсветка строки ===');
const cssBlock = (() => {
  const a = INDEX.indexOf('V6-3 (R-2): «Управление СЦ» — золотая плитка');
  const b = INDEX.indexOf('.zone-inner-scroll', a) > a ? a : a;
  const start = INDEX.lastIndexOf('/*', a);
  const end = INDEX.indexOf('.zone[data-zone="3"] .zone-content::-webkit-scrollbar-thumb', a);
  return INDEX.slice(start, INDEX.indexOf('}', end) + 1);
})();
const selectors = [...cssBlock.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/^\s*([^{}\/*@][^{}]*?)\s*\{/gm)].map((m) => m[1]).join(',').split(',').map((s) => s.trim()).filter(Boolean);
check('блок золотой плитки есть и все его селекторы начинаются с .zone[data-zone="3"] (остальные зоны не меняются)', selectors.length >= 8 && selectors.every((s) => s.startsWith('.zone[data-zone="3"]')), selectors.filter((s) => !s.startsWith('.zone[data-zone="3"]')).join(' | '));
check('рамка плитки золотая, фон — мягкий градиент старого золота', /\.zone\[data-zone="3"\]\s*\{[^}]*linear-gradient\(135deg[^}]*border:\s*1px solid #c4a050/.test(cssBlock));
const ztRule = (cssBlock.match(/\.zone\[data-zone="3"\] \.zt\s*\{([^}]*)\}/) || [])[1] || '';
check('боковая плашка .zt — золотой градиент', /linear-gradient\(180deg/.test(ztRule));
const gemRule = (cssBlock.match(/\.zone\[data-zone="3"\] \.zt::before\s*\{([^}]*)\}/) || [])[1] || '';
const gemLayers = (gemRule.match(/var\(--gem\)/g) || []).length;
const gemPos = ((gemRule.match(/background-position:\s*([^;]*);/) || [])[1] || '').split(',').length;
const gemSize = ((gemRule.match(/background-size:\s*([^;]*);/) || [])[1] || '').split(',').length;
check('россыпь бриллиантов: 5–9 штук (7), позиции и размеры заданы для каждого', gemLayers >= 5 && gemLayers <= 9 && gemPos === gemLayers && gemSize === gemLayers, [gemLayers, gemPos, gemSize].join('/'));
check('бриллианты — inline SVG (data:image/svg+xml), без внешних файлов и http(s)-ссылок', /--gem:\s*url\("data:image\/svg\+xml,/.test(cssBlock) && !/https?:\/\/[^'"%]*\.(png|jpe?g|svg|gif|webp)/i.test(cssBlock) && !/url\((?!"data:)/.test(cssBlock));
check('без анимации в блоке золотой плитки (нет animation/@keyframes)', !/animation|@keyframes|transition/.test(cssBlock));
check('россыпь не перехватывает клики (pointer-events: none) и лежит под текстом', /pointer-events:\s*none/.test(gemRule) && /\.zone\[data-zone="3"\] \.zt > \* \{ position: relative; \}/.test(cssBlock));

function lum(hex) {
  const c = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const stops = [...ztRule.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]);
const ink = (cssBlock.match(/--gold-ink:\s*(#[0-9a-f]{6})/i) || [])[1];
const countInk = (cssBlock.match(/\.zone\[data-zone="3"\] \.count\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i) || [])[1];
const stopSet = stops.filter((s) => lum(s) > 0.2);   // цвета плашки (border-right #a8832f тоже ниже по яркости, но в расчёт берём все цвета градиента)
const gradStops = (ztRule.match(/linear-gradient\(180deg,([^)]*)\)/) || [])[1].match(/#[0-9a-f]{6}/gi);
const minContrast = Math.min(...gradStops.map((s) => contrast(ink, s)));
check('контраст названия «УПРАВЛЕНИЕ СЦ» (' + ink + ') на самом тёмном/светлом краю плашки ≥ 4.5:1 (мин ' + minContrast.toFixed(2) + ')', minContrast >= 4.5, minContrast);
const minCountContrast = Math.min(...gradStops.map((s) => contrast(countInk, s)));
check('контраст счётчика «N чел.» (' + countInk + ') на плашке ≥ 4.5:1 (мин ' + minCountContrast.toFixed(2) + ')', minCountContrast >= 4.5, minCountContrast);
check('название зоны читается: .zt-title окрашен в --gold-ink', /\.zone\[data-zone="3"\] \.zt-title\s*\{[^}]*color:\s*var\(--gold-ink\)/.test(cssBlock));
check('карточка сотрудника: тонкая золотая рамка у фото (2px) и у карточки', /\.zone\[data-zone="3"\] \.employee \.photo\s*\{[^}]*border:\s*2px solid #c9a24d/.test(cssBlock) && /\.zone\[data-zone="3"\] \.employee\s*\{[^}]*border-color:\s*rgba\(184, 146, 58/.test(cssBlock));
check('мобильные правила: золотая зона учтена в @media (рамка фото, размер бриллиантов на плашке 36px)', /@media[^{]*\{[\s\S]*?\.zone\[data-zone="3"\] \.employee \.photo \{ border-width: 2px; \}[\s\S]*?\.zone\[data-zone="3"\] \.zt::before \{ background-size:/.test(INDEX));
const noYellow = [...cssBlock.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]).every((h) => {
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx === mn) return true;
  const sat = (mx - mn) / mx;
  let hue = mx === r ? 60 * (((g - b) / (mx - mn)) % 6) : mx === g ? 60 * ((b - r) / (mx - mn) + 2) : 60 * ((r - g) / (mx - mn) + 4);
  if (hue < 0) hue += 360;
  const isCyanish = hue >= 190 && hue <= 230; // голубые прожилки бриллиантов (в data-URI — не в этом списке)
  return isCyanish || hue < 30 || hue > 52 || sat < 0.7 || mx < 0xc0;
});
check('палитра — старое золото, без кислотного жёлтого (оттенок 30–52° с насыщенностью ≥ 70 % и яркостью ≥ 75 % отсутствует)', noYellow);

const rowCss = INDEX.slice(INDEX.indexOf('V6-3 (R-2): строка зоны 3'), INDEX.indexOf('Crosshair is 15% lighter'));
const tintAlpha = Number((rowCss.match(/rgba\(184, 146, 58, (0\.\d+)\),\s*rgba\(184, 146, 58, \1\)/) || [])[1]);
check('подсветка строки: золотой тон 6–10 % непрозрачности (' + tintAlpha + ')', tintAlpha >= 0.06 && tintAlpha <= 0.10);
check('тон строки не перекрашивает отпуск/больничный/командировку/выходной-день-off и выделение диапазона', /:not\(\.type-vacation\):not\(\.type-sick\):not\(\.type-trip\):not\(\.type-dayoff\):not\(\.range-selecting\)/.test(rowCss));
check('hover-строка и «dimmed» (Ctrl-выбор) не переопределяются подсветкой', /tr\.matrix-row-director:not\(\.matrix-hover-row\):not\(\.trip-row-dimmed\) > \.day-cell-data/.test(rowCss) && /tr\.matrix-row-director:not\(\.matrix-hover-row\):not\(\.trip-row-dimmed\) > \.name-col/.test(rowCss));
check('у ФИО тонкий золотой акцент слева (inset 3px), колонка ФИО остаётся непрозрачной (sticky)', /inset 3px 0 0 #c9a24d/.test(rowCss) && /background-color: #f8f1df !important/.test(rowCss));
check('подпись группы «Управление СЦ» — тот же золотой тон', /matrix-group-director \.matrix-group-label/.test(rowCss) && /matrix-group-director \.matrix-group-bg/.test(rowCss));
check('все селекторы подсветки матрицы привязаны к .matrix-row-director / .matrix-group-director (остальные строки не меняются)', [...rowCss.matchAll(/^\s*(\.matrix-table[^{}]*?)\s*\{/gm)].every((m) => /matrix-row-director|matrix-group-director/.test(m[1])));
check('js/tasks_matrix.js не завязан на порядок строк (ищет строки по data-emp-id)', /data-emp-id|dataset\.empId/.test(read('js/tasks_matrix.js')) && !/rows\[\d|childNodes\[\d|children\[\d/.test(read('js/tasks_matrix.js')));

// ============================================================================
console.log('=== D. Фото director_avatar.jpg ===');
{
  const f = path.join(ROOT, 'reports/V6/assets/director_avatar.jpg');
  const b = fs.readFileSync(f);
  check('файл существует, это JPEG (FFD8…FFD9)', b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9);
  check('размер ≤ 60 КБ (' + b.length + ' байт)', b.length <= 60 * 1024);
  let w = 0, h = 0;
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xff) { i++; continue; }
    const mk = b[i + 1];
    if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  check('квадрат ≤ 300×300 (' + w + '×' + h + ')', w === h && w > 0 && w <= 300);
}

// ============================================================================
console.log('=== E. Данные на проде: scripts/v6_director_data.sql на копии БД (V6-3 + V6-6: должность «Директор», очистка истории) ===');
const SQL = read('scripts/v6_director_data.sql');
const SQLITE = 'sqlite3';
const hasSqlite = (() => { try { cp.execFileSync(SQLITE, ['--version']); return true; } catch (e) { return false; } })();
check('sqlite3 CLI доступен', hasSqlite);
if (hasSqlite) {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'v6dir_'));
  const sh = (db, sql, extra) => cp.execFileSync(SQLITE, [...(extra || []), db], { input: sql, encoding: 'utf8' });
  const q = (db, sql) => sh(db, sql).trim();
  const dryRunSql = SQL.replace(/^-- @@APPLY[\s\S]*$/m, '');
  const KOST = 'Костецкий Андрей Николаевич', IGN = 'Игнатенко Павел Валерьевич';
  const POS = 'pos_директор';

  check('скрипт: одна транзакция (BEGIN IMMEDIATE … COMMIT), .bail on, .timeout 5000', /\.bail on/.test(SQL) && /\.timeout 5000/.test(SQL) && (SQL.match(/^BEGIN IMMEDIATE;/mg) || []).length === 1 && (SQL.match(/^COMMIT;/mg) || []).length === 1);
  check('скрипт: audit_log и sync_log не чистятся (нет DELETE по ним)', !/DELETE\s+FROM\s+(audit_log|sync_log|tasks|trips|employees)\b/i.test(SQL));
  check('скрипт: очистка только по employee_id цели (все DELETE — «WHERE employee_id IN (SELECT id FROM v6_t)»)', (SQL.match(/^DELETE FROM \w+\s+WHERE employee_id IN \(SELECT id FROM v6_t\);/mg) || []).length === 5 && (SQL.match(/^DELETE FROM/mg) || []).length === 5);

  // миграция копии dev-БД v6 → v11 штатным кодом приложения (SC_APP_DB)
  const base = path.join(tmp, 'base.db');
  fs.copyFileSync(path.join(ROOT, 'data/app.db'), base);
  const mig = (db) => cp.execFileSync('php', ['-r', 'require "' + ROOT + '/api/db.php"; $d = Database::getInstance(); $d->migrate(); echo $d->getSchemaVersion();'], { env: { ...process.env, SC_APP_DB: db }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  check('миграция копии dev-БД → schema_version 12 (v12 V6.3-2)', mig(base) === '12');

  // Вымышленные данные: «Костецкий» (история во ВСЕХ очищаемых таблицах) + контрольный «Другой Сотрудник» (его данные не трогаются).
  function seed(db, opts) {
    opts = opts || {};
    fs.copyFileSync(base, db);
    let sql = "INSERT INTO employees (id, full_name, position_id, location, group_id, photo_url, sort_order, created_at, updated_at) VALUES " +
      "('emp_k1', '" + KOST + "', 'pos_master', 'Офис', 'g3', 'images/old.webp', 9, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')," +
      "('emp_o1', 'Другой Сотрудник', 'pos_ingener', 'Офис', 'g0', NULL, 10, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');" +
      "INSERT INTO schedule_entries (employee_id, date, status) VALUES ('emp_k1', '2026-07-01', 'vacation'), ('emp_k1', '2026-07-02', 'vacation'), ('emp_k1', '2026-08-03', 'sick'), ('emp_o1', '2026-07-01', 'vacation'), ('emp_o1', '2026-09-01', 'sick');" +
      "INSERT INTO vacation_balances (employee_id, year, total_days, used_days, remaining_days) VALUES ('emp_k1', 2026, 28, 2, 26), ('emp_o1', 2026, 28, 0, 28);" +
      "INSERT INTO tasks (id, title, start_at, status) VALUES ('t_only', 'Единственный исполнитель', '2026-12-01', 'open'), ('t_shared', 'Общая задача', '2026-12-02', 'open'), ('t_closed', 'Закрытая', '2026-06-01', 'closed'), ('t_watch', 'Наблюдатель', '2026-12-03', 'open'), ('t_o1', 'Чужая задача', '2026-12-04', 'open');" +
      "INSERT INTO task_assignees (task_id, employee_id, role, full_name_snapshot) VALUES ('t_only', 'emp_k1', 'assignee', '" + KOST + "'), ('t_shared', 'emp_k1', 'assignee', '" + KOST + "'), ('t_shared', 'emp_o1', 'assignee', 'Другой Сотрудник'), ('t_closed', 'emp_k1', 'assignee', '" + KOST + "'), ('t_watch', 'emp_o1', 'assignee', 'Другой Сотрудник'), ('t_watch', 'emp_k1', 'watcher', '" + KOST + "'), ('t_o1', 'emp_o1', 'assignee', 'Другой Сотрудник');" +
      "INSERT INTO trips (id, title, status, version) VALUES ('trip_1', 'Командировка только он', 'confirmed', 1), ('trip_2', 'Командировка общая', 'confirmed', 1), ('trip_3', 'Командировка чужая', 'confirmed', 1);" +
      "INSERT INTO trip_participants (trip_id, employee_id, start_date, end_date) VALUES ('trip_1', 'emp_k1', '2026-05-01', '2026-05-03'), ('trip_2', 'emp_k1', '2026-06-01', '2026-06-03'), ('trip_2', 'emp_o1', '2026-06-01', '2026-06-03'), ('trip_3', 'emp_o1', '2026-07-10', '2026-07-12');" +
      "INSERT INTO trip_requests (request_id, trip_id, employee_id, payload, status) VALUES ('rq_1', 'trip_1', 'emp_k1', '{}', 'queued'), ('rq_2', 'trip_3', 'emp_o1', '{}', 'queued');";
    if (opts.twin) sql += "INSERT INTO employees (id, full_name, group_id, sort_order) VALUES ('emp_k2', '" + KOST + "', 'g3', 11);";
    if (opts.ign) sql += "INSERT INTO employees (id, full_name, group_id, sort_order) VALUES ('emp_i0', '" + IGN + "', 'g3', 12);";
    if (opts.posExists) sql += "INSERT INTO positions (id, name, sort_order) VALUES ('pos_dir_exist', 'Директор', 77), ('pos_dir_dup', 'Директор', 78);";
    if (opts.posConflict) sql += "INSERT INTO positions (id, name, sort_order) VALUES ('" + POS + "', 'Другая должность', 77);";
    if (opts.none) sql = '';
    if (sql) sh(db, sql);
  }
  const HIST = ['schedule_entries', 'vacation_balances', 'trip_participants', 'trip_requests', 'task_assignees'];
  const histOf = (db, emp) => HIST.map((t) => +q(db, "SELECT COUNT(*) FROM " + t + " WHERE employee_id = '" + emp + "'"));
  const tot = (db, t) => +q(db, 'SELECT COUNT(*) FROM ' + t);
  const dump = (db) => sh(db, '.dump');

  // --- DRY-RUN ---
  const db1 = path.join(tmp, 'case1.db');
  seed(db1);
  const before = dump(db1);
  const nPos0 = tot(db1, 'positions'), maxSort0 = +q(db1, 'SELECT MAX(sort_order) FROM positions');
  const dry = cp.execFileSync(SQLITE, ['-readonly', db1], { input: dryRunSql, encoding: 'utf8' });
  check('DRY-RUN: ничего не меняет (дамп БД идентичен, -readonly)', dump(db1) === before);
  check('DRY-RUN: matches = 1, другие сотрудники g3 = 0, «Игнатенко» уже есть = 0', /matches \(нужно ровно 1\)\s+\|?\s*1\b/.test(dry) && /другие сотрудники g3 \(до APPLY; ожидается 0\)\s+\|?\s*0\b/.test(dry) && /target already exists \(нужно 0\)\s+\|?\s*0\b/.test(dry), dry.slice(0, 700));
  check('DRY-RUN: карточка — id, группа, ТЕКУЩАЯ должность (Master), фото', /emp_k1/.test(dry) && /cur_position/.test(dry) && /pos_master/.test(dry) && /Master/.test(dry) && /images\/old\.webp/.test(dry), dry.slice(0, 900));
  check('DRY-RUN: новая должность «Директор» — нет в positions, будет СОЗДАНА (pos_директор)', /новая должность «Директор»\s+\|?\s*pos_директор\s+\|?\s*нет в positions — будет СОЗДАНА/.test(dry), dry);
  check('DRY-RUN: «УДАЛИТСЯ» — schedule_entries 3, vacation_balances 1, trip_participants 2, trip_requests 1, task_assignees 4', /УДАЛИТСЯ: schedule_entries\s+\|?\s*3\b/.test(dry) && /УДАЛИТСЯ: vacation_balances\s+\|?\s*1\b/.test(dry) && /УДАЛИТСЯ: trip_participants\s+\|?\s*2\b/.test(dry) && /УДАЛИТСЯ: trip_requests[^\n]*?\s\|?\s*1\b/.test(dry) && /УДАЛИТСЯ: task_assignees \(все роли\)\s+\|?\s*4\b/.test(dry), dry);
  check('DRY-RUN: по статусам графика (sick 1 / vacation 2), по ролям и статусам задач (watcher 1, assignee open 2 + closed 1)', /\|\s*sick\s*\|\s*1\b/.test(dry) && /\|\s*vacation\s*\|\s*2\b/.test(dry) && /\|\s*watcher\s*\|\s*open\s*\|\s*0\s*\|\s*1\b/.test(dry) && /\|\s*assignee\s*\|\s*open\s*\|\s*0\s*\|\s*2\b/.test(dry) && /\|\s*assignee\s*\|\s*closed\s*\|\s*0\s*\|\s*1\b/.test(dry), dry);
  check('DRY-RUN: «ОСТАНУТСЯ, version+1»: 4 задачи, 2 командировки; командировок без участников 1 (trip_1 перечислена)', /ОСТАНУТСЯ, version\+1: задач\s+\|?\s*4\b/.test(dry) && /ОСТАНУТСЯ, version\+1: командировок\s+\|?\s*2\b/.test(dry) && /командировок останется БЕЗ участников\s+\|?\s*1\b/.test(dry) && /командировка без участников \| trip_1 \| Командировка только он/.test(dry), dry);
  check('DRY-RUN: «станут Без исполнителя» = 1 и назва́ние задачи в выводе (t_only), общая задача (t_shared) — нет', /станут «Без исполнителя» \(открытых задач\)\s+\|?\s*1\b/.test(dry) && /задача без исполнителя \| t_only \| Единственный исполнитель/.test(dry) && !/задача без исполнителя \| t_shared/.test(dry), dry);
  check('DRY-RUN не содержит раздел APPLY (sed отрезает по маркеру)', !/^(BEGIN IMMEDIATE|UPDATE |DELETE FROM|INSERT INTO|CREATE TEMP)/m.test(dryRunSql));

  // --- APPLY ---
  const k0 = histOf(db1, 'emp_k1'), o0 = histOf(db1, 'emp_o1');
  const tasksBefore = q(db1, "SELECT id || ':' || title || ':' || version FROM tasks ORDER BY id");
  const nTasks0 = tot(db1, 'tasks'), nTrips0 = tot(db1, 'trips'), nEmp0 = tot(db1, 'employees'), nGroups0 = tot(db1, 'groups');
  const nAudit0 = tot(db1, 'audit_log'), nSync0 = tot(db1, 'sync_log');
  const out = sh(db1, SQL);
  check('предусловие: у «Костецкого» история во всех 5 очищаемых таблицах (3, 1, 2, 1, 4)', k0.join() === '3,1,2,1,4', k0.join());
  check('APPLY: «APPLIED: 1 сотрудник обновлён, история очищена», integrity_check ok, foreign_key_check пуст', /APPLIED: 1 сотрудник обновлён, история очищена/.test(out) && /\bok\b/.test(out) && !/Error|constraint/i.test(out), out.slice(-500));
  check('APPLY: ФИО, фото (формат api/upload.php), g3, updated_at', q(db1, "SELECT full_name || '|' || group_id || '|' || photo_url || '|' || (updated_at LIKE '____-__-__T__:__:__+00:00') FROM employees WHERE id = 'emp_k1'") === IGN + '|g3|images/photo_1794600000_d1ec7040.jpg|1');
  check('APPLY: photo_url соответствует формату upload.php (photo_<unix>_<8 hex>.<ext>)', /^images\/photo_\d{10}_[0-9a-f]{8}\.(webp|jpg)$/.test(q(db1, "SELECT photo_url FROM employees WHERE id = 'emp_k1'")));
  check('APPLY: должность «Директор» создана: id pos_директор (правило positionSlug), sort_order = MAX+1, назначена сотруднику', q(db1, "SELECT id || '|' || name || '|' || sort_order FROM positions WHERE name = 'Директор'") === POS + '|Директор|' + (maxSort0 + 1) && tot(db1, 'positions') === nPos0 + 1 && q(db1, "SELECT position_id FROM employees WHERE id = 'emp_k1'") === POS, q(db1, "SELECT position_id FROM employees WHERE id = 'emp_k1'"));
  check('APPLY: id должности = positionSlug из js/storage.js (следующее сохранение из браузера не даст дубль)', (() => { const ctx = {}; vm.runInNewContext(STORAGE.match(/function positionSlug[\s\S]*?\n  }\n/)[0] + '; out = positionSlug("Директор");', ctx); return ctx.out === POS; })());
  check('APPLY: ОЧИСТКА — у сотрудника 0 записей в КАЖДОЙ из 5 таблиц (schedule_entries, vacation_balances, trip_participants, trip_requests, task_assignees)', histOf(db1, 'emp_k1').join() === '0,0,0,0,0', histOf(db1, 'emp_k1').join());
  check('APPLY: чужие данные не тронуты (emp_o1: 2, 1, 2, 1, 3 — те же числа)', histOf(db1, 'emp_o1').join() === o0.join() && o0.join() === '2,1,2,1,3', histOf(db1, 'emp_o1').join());
  check('APPLY: задачи и командировки на месте (tasks 5→5, trips 3→3), trip_1 осталась без участников', tot(db1, 'tasks') === nTasks0 && tot(db1, 'trips') === nTrips0 && q(db1, "SELECT COUNT(*) FROM trip_participants WHERE trip_id = 'trip_1'") === '0' && q(db1, "SELECT COUNT(*) FROM task_checklist") === '0');
  check('APPLY: название/состав задач не изменены; version+1 только у 4 затронутых (t_only, t_shared, t_closed, t_watch), у t_o1 прежняя', q(db1, "SELECT id || ':' || title FROM tasks ORDER BY id") === tasksBefore.split('\n').map((l) => l.replace(/:\d+$/, '')).join('\n') && q(db1, "SELECT group_concat(id || '=' || version) FROM (SELECT id, version FROM tasks ORDER BY id)") === 't_closed=2,t_o1=1,t_only=2,t_shared=2,t_watch=2', q(db1, "SELECT group_concat(id || '=' || version) FROM (SELECT id, version FROM tasks ORDER BY id)"));
  check('APPLY: version+1 у trip_1 и trip_2, trip_3 прежняя', q(db1, "SELECT group_concat(id || '=' || version) FROM (SELECT id, version FROM trips ORDER BY id)") === 'trip_1=2,trip_2=2,trip_3=1');
  check('APPLY: «⚠ Без исполнителя» (правило tasks.php ?orphans=1): ровно t_only', q(db1, "SELECT group_concat(t.id) FROM tasks t WHERE t.archived = 0 AND t.status = 'open' AND NOT EXISTS (SELECT 1 FROM task_assignees ta JOIN employees e ON e.id = ta.employee_id WHERE ta.task_id = t.id AND ta.role = 'assignee')") === 't_only');
  check('APPLY: employees и groups — те же числа; audit_log +2 (employee.update, employee.history_clear)', tot(db1, 'employees') === nEmp0 && tot(db1, 'groups') === nGroups0 && tot(db1, 'audit_log') === nAudit0 + 2);
  check('APPLY: audit employee.update (changes с position_id) и employee.history_clear (счётчики 3/1/2/1/4)', q(db1, "SELECT COUNT(*) FROM audit_log WHERE action = 'employee.update' AND entity_id = 'emp_k1' AND actor = 'sql:v6-6' AND details LIKE '%\"changes\"%' AND details LIKE '%\"position_id\":\"" + POS + "\"%'") === '1' && q(db1, "SELECT COUNT(*) FROM audit_log WHERE action = 'employee.history_clear' AND entity_id = 'emp_k1' AND details = '{\"deleted\":{\"schedule_entries\":3,\"vacation_balances\":1,\"trip_participants\":2,\"trip_requests\":1,\"task_assignees\":4}}'") === '1');
  check('APPLY: sync_log +6 — employee/upsert (1), entry/delete по каждой удалённой записи графика (3), trip/upsert по затронутым командировкам (trip_1, trip_2; trip_3 нет)', tot(db1, 'sync_log') === nSync0 + 6 && q(db1, "SELECT COUNT(*) FROM sync_log WHERE entity_type = 'employee' AND entity_id = 'emp_k1' AND action = 'upsert' AND actor = 'sql:v6-6'") === '1' && q(db1, "SELECT group_concat(entity_id) FROM (SELECT entity_id FROM sync_log WHERE entity_type = 'entry' AND action = 'delete' AND actor = 'sql:v6-6' ORDER BY entity_id)") === 'emp_k1:2026-07-01,emp_k1:2026-07-02,emp_k1:2026-08-03' && q(db1, "SELECT group_concat(entity_id) FROM (SELECT entity_id FROM sync_log WHERE entity_type = 'trip' AND action = 'upsert' AND actor = 'sql:v6-6' ORDER BY entity_id)") === 'trip_1,trip_2', q(db1, "SELECT entity_type, entity_id, action FROM sync_log WHERE actor = 'sql:v6-6'"));
  check('APPLY: после COMMIT проверки скрипта — «остаток Костецкий» 0, история «Игнатенко» везде 0', /остаток «Костецкий…» \(после APPLY должно быть 0\)\s+\|?\s*0\b/.test(out) && /история «Игнатенко…» \(после APPLY везде 0\)\s+\|?\s*0\s+\|?\s*0\s+\|?\s*0\s+\|?\s*0\s+\|?\s*0\b/.test(out), out.slice(-700));
  check('APPLY: integrity_check ok, foreign_key_check пуст', q(db1, 'PRAGMA integrity_check') === 'ok' && q(db1, 'PRAGMA foreign_key_check') === '');

  // --- повтор ---
  const afterFirst = dump(db1);
  const out2 = sh(db1, SQL);
  check('повтор APPLY: «NO-OP», БД побайтово не изменилась (0 изменений, в т.ч. audit/sync/version/positions)', /NO-OP/.test(out2) && dump(db1) === afterFirst, out2.slice(-300));

  // --- откат (бэкап до APPLY → .restore) ---
  const dbR = path.join(tmp, 'rollback.db'), bak = path.join(tmp, 'rollback.bak');
  seed(dbR);
  const dR = dump(dbR);
  sh(dbR, ".backup '" + bak + "'");
  sh(dbR, SQL);
  check('перед откатом БД действительно изменена APPLY', dump(dbR) !== dR && histOf(dbR, 'emp_k1').join() === '0,0,0,0,0');
  sh(dbR, ".restore '" + bak + "'");
  check('откат (.backup → .restore внутрь существующего файла): БД побайтово как до APPLY, история на месте, должность прежняя', dump(dbR) === dR && histOf(dbR, 'emp_k1').join() === '3,1,2,1,4' && q(dbR, "SELECT position_id FROM employees WHERE id = 'emp_k1'") === 'pos_master' && q(dbR, "SELECT COUNT(*) FROM positions WHERE name = 'Директор'") === '0');

  // --- должность уже есть ---
  const dbP = path.join(tmp, 'posexists.db'); seed(dbP, { posExists: true });
  const nPosP = tot(dbP, 'positions');
  const outP = sh(dbP, SQL);
  check('должность «Директор» уже есть (2 дубля): назначается с наименьшим sort_order, новая НЕ создаётся', /APPLIED/.test(outP) && q(dbP, "SELECT position_id FROM employees WHERE id = 'emp_k1'") === 'pos_dir_exist' && tot(dbP, 'positions') === nPosP && q(dbP, "SELECT COUNT(*) FROM positions WHERE id = '" + POS + "'") === '0');
  const dbP2 = path.join(tmp, 'posexists2.db'); seed(dbP2, { posExists: true });
  const dryP = cp.execFileSync(SQLITE, ['-readonly', dbP2], { input: dryRunSql, encoding: 'utf8' });
  check('DRY-RUN при существующей должности: «уже есть в positions (будет назначена)», id pos_dir_exist', /новая должность «Директор»\s+\|?\s*pos_dir_exist\s+\|?\s*уже есть в positions/.test(dryP), dryP.slice(0, 700));

  // --- негативные случаи ---
  const neg = (name, opts, prep, label) => {
    const d = path.join(tmp, name + '.db'); seed(d, opts); if (prep) sh(d, prep);
    const dm = dump(d); const o = sh(d, SQL);
    check(label + ' → NO-OP, БД не изменена', /NO-OP/.test(o) && dump(d) === dm, o.slice(-250));
  };
  neg('none', { none: true }, null, '0 совпадений');
  neg('twin', { twin: true }, null, '2 совпадения');
  neg('ign', { ign: true }, null, '«Игнатенко…» уже существует (защита от дубля)');
  neg('v9', {}, "UPDATE meta SET value = '9' WHERE key = 'schema_version';", 'schema_version < 10 (нет full_name_snapshot)');
  neg('nog3', {}, "UPDATE employees SET group_id = 'g0' WHERE id = 'emp_k1'; DELETE FROM employees WHERE group_id = 'g3'; DELETE FROM groups WHERE id = 'g3';", 'нет группы g3');
  neg('posconf', { posConflict: true }, null, 'id pos_директор занят другим именем');

  // --- «другие сотрудники g3» попадают в DRY-RUN (сигнал СТОП) ---
  const dbG = path.join(tmp, 'other_g3.db'); seed(dbG);
  sh(dbG, "INSERT INTO employees (id, full_name, group_id, sort_order) VALUES ('emp_g3x', 'Тестов Лишний', 'g3', 20);");
  const dryG = cp.execFileSync(SQLITE, ['-readonly', dbG], { input: dryRunSql, encoding: 'utf8' });
  check('DRY-RUN: другой сотрудник g3 → счётчик 1 и его имя (сигнал СТОП для оператора)', /другие сотрудники g3 \(до APPLY; ожидается 0\)\s+\|?\s*1\b/.test(dryG) && /другой сотрудник g3 \| emp_g3x \| Тестов Лишний/.test(dryG), dryG.slice(0, 600));

  // --- миграция v10→v11 на копии с данными: строки до/после во всех таблицах ---
  const migCase = (label, oldName) => {
    const dbM = path.join(tmp, 'mig_' + label + '.db');
    seed(dbM);
    sh(dbM, "UPDATE groups SET name = '" + oldName + "' WHERE id = 'g3'; UPDATE meta SET value = '10' WHERE key = 'schema_version';");
    const tables = q(dbM, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").split('\n');
    const rc = (db) => Object.fromEntries(tables.map((t) => [t, +q(db, 'SELECT COUNT(*) FROM "' + t + '"')]));
    const rowsBefore = rc(dbM);
    const gBefore = q(dbM, "SELECT id || ':' || name FROM groups WHERE id != 'g3' ORDER BY id");
    mig(dbM);
    const rowsAfter = rc(dbM);
    check('миграция v10→v11 (g3 «' + oldName + '»): число строк во всех ' + tables.length + ' таблицах не изменилось', JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter), JSON.stringify([rowsBefore, rowsAfter]));
    check('миграция v10→v11 (g3 «' + oldName + '»): g3 = «Управление СЦ», прочие группы не тронуты, schema_version 12', q(dbM, "SELECT name FROM groups WHERE id = 'g3'") === 'Управление СЦ' && q(dbM, "SELECT id || ':' || name FROM groups WHERE id != 'g3' ORDER BY id") === gBefore && q(dbM, "SELECT value FROM meta WHERE key = 'schema_version'") === '12');
    check('миграция v10→v11 (g3 «' + oldName + '»): integrity_check ok, foreign_key_check пуст', q(dbM, 'PRAGMA integrity_check') === 'ok' && q(dbM, 'PRAGMA foreign_key_check') === '');
    const dM = dump(dbM);
    sh(dbM, "UPDATE meta SET value = '10' WHERE key = 'schema_version';");
    mig(dbM);
    sh(dbM, "UPDATE meta SET value = '12' WHERE key = 'schema_version';");
    check('миграция (g3 «' + oldName + '»): повтор — no-op (БД идентична)', dump(dbM) === dM);
    return dbM;
  };
  migCase('b2c', 'В' + '2С');
  migCase('dir', 'Директор' + ' СЦ');
  const dbMy = path.join(tmp, 'mig_own.db'); seed(dbMy);
  sh(dbMy, "UPDATE groups SET name = 'Мой отдел' WHERE id = 'g3'; UPDATE meta SET value = '10' WHERE key = 'schema_version';");
  mig(dbMy);
  check('миграция: чужое имя g3, заданное вручную, не перетирается', q(dbMy, "SELECT name FROM groups WHERE id = 'g3'") === 'Мой отдел');

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\nRESULT: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
