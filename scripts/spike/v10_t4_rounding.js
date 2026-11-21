// V10-T4 SPIKE: округление времени в пути вверх до 15 минут (проект формулы, не код приложения).
// Вход — секунды от сервиса маршрутов (число, возможно дробное). Выход — минуты, кратные 15.
// Правило: секунды сначала округляются до целых (Math.round), затем ceil(sec/900)*15 в целочисленной арифметике;
// 0 с -> 0 мин (точки совпадают), любое положительное значение -> не меньше 15 мин.
'use strict';

function legMinMap(durationSec) {
  if (typeof durationSec !== 'number' || !isFinite(durationSec) || durationSec < 0) return null; // нет оценки
  const sec = Math.round(durationSec);
  if (sec === 0) return 0;
  return Math.ceil(sec / 900) * 15;
}

// граничные значения: минуты (в таблице отчёта) -> секунды
const MIN_CASES = [0, 1, 14, 15, 16, 29, 30, 31, 44, 45, 46, 60, 61, 90, 91];
const rows = MIN_CASES.map((m) => [m + ' мин', m * 60, legMinMap(m * 60)]);
// секундные границы вокруг 15 мин и дробные значения сервисов
const SEC_CASES = [0, 0.4, 0.5, 1, 899, 899.4, 899.5, 900, 900.4, 900.5, 901, 6620.4, 14464.6];
const rows2 = SEC_CASES.map((s) => [s + ' с', s, legMinMap(s)]);

const EXPECT = { 0: 0, 60: 15, 840: 15, 900: 15, 960: 30, 1740: 30, 1800: 30, 1860: 45, 2640: 45, 2700: 45, 2760: 60, 3600: 60, 3660: 75, 5400: 90, 5460: 105 };
let bad = 0;
for (const [sec, want] of Object.entries(EXPECT)) {
  const got = legMinMap(Number(sec));
  if (got !== want) { bad++; console.log('FAIL', sec, got, want); }
}
if (legMinMap(NaN) !== null || legMinMap(-1) !== null || legMinMap(undefined) !== null) { bad++; console.log('FAIL: нет оценки'); }

const out = [];
out.push('| вход | секунд | результат, мин |', '|---|---:|---:|');
for (const r of rows.concat(rows2)) out.push('| ' + r[0] + ' | ' + r[1] + ' | ' + r[2] + ' |');
console.log(out.join('\n'));
console.log(bad === 0 ? 'ROUNDING: OK' : 'ROUNDING: FAIL ' + bad);
process.exit(bad === 0 ? 0 : 1);
