// ---- common.js: детерминированные правила блока «Задачи» (T1-4) ----------------
// Строго эквивалентно api/tasks_rules.php (T1-1). Без LLM, без сетевых вызовов:
// n8n НИКОГДА не обращается к приложению — все факты приходят в теле запроса.
// Этот блок вставляется build-скриптом (scripts/n8n_deploy.py) в оба workflow.
const HORIZON_DAYS = 400;      // = TASKS_SUGGEST_HORIZON_DAYS (tasks_rules.php)
const MAX_PERIOD_DAYS = 366;   // = TASKS_MAX_PERIOD_DAYS
const MAX_EMPLOYEES = 100;
const DAY_MS = 86400000;

// 'YYYY-MM-DD' → UTC-миллисекунды дня или null (как tasks_parse_when без времени + checkdate).
function parseYmd(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}
function fmtYmd(t) {
  const dt = new Date(t);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}
const addDays = (ymd, n) => fmtYmd(parseYmd(ymd) + n * DAY_MS);
const diffDays = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / DAY_MS);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Период [from, to] → {error} | {days: string[]}.
function checkRange(from, to) {
  if (parseYmd(from) === null) return { error: 'invalid_from' };
  if (parseYmd(to) === null) return { error: 'invalid_to' };
  const n = diffDays(from, to);
  if (n < 0) return { error: 'date_range_invalid' };
  if (n + 1 > MAX_PERIOD_DAYS) return { error: 'period_too_long' };
  const days = [];
  for (let i = 0; i <= n; i++) days.push(addDays(from, i));
  return { days };
}

// facts = {employee_id: [{date, matrix_status, day_type, is_day_off, holiday_label, trip}, ...]}
// (формат calendar_facts). Строки могут быть разреженными: отсутствие строки = нет блока.
// Возвращает Map "emp\u0000date" → row, только для запрошенных сотрудников.
function indexFacts(facts, employeeIds) {
  const idx = new Map();
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) return null;
  for (const emp of employeeIds) {
    const rows = facts[emp];
    if (rows === undefined || rows === null) continue;
    if (!Array.isArray(rows)) return null;
    for (const r of rows) {
      if (r === null || typeof r !== 'object' || parseYmd(r.date) === null) return null;
      idx.set(emp + '\u0000' + r.date, { emp, row: r });
    }
  }
  return idx;
}

// Причина блока: sick | trip | null (tasks_blocked_from_facts).
function blockReason(r) {
  if (r.matrix_status === 'sick') return 'sick';
  if (r.matrix_status === 'trip' || (r.trip !== null && r.trip !== undefined)) return 'trip';
  return null;
}

// Блокирующие дни в [from, to], отсортированы по (date, employee_id).
function blockedIn(idx, from, to) {
  const out = [];
  for (const { emp, row } of idx.values()) {
    if (row.date < from || row.date > to) continue;
    const reason = blockReason(row);
    if (reason !== null) out.push({ date: row.date, employee_id: emp, reason });
  }
  out.sort((a, b) => cmp(a.date, b.date) || cmp(a.employee_id, b.employee_id));
  return out;
}

// Ближайший старт >= start для периода длиной length дней (tasks_suggest_start).
function suggestStart(idx, start, length) {
  length = Math.max(1, length);
  const limit = addDays(start, HORIZON_DAYS);
  const winEnd = addDays(limit, length - 1);
  const dates = [...new Set(blockedIn(idx, start, winEnd).map((b) => b.date))].sort();
  let cand = start;
  while (cand <= limit) {
    const end = addDays(cand, length - 1);
    let last = null;
    for (const d of dates) if (d >= cand && d <= end) last = d;
    if (last === null) return cand;
    cand = addDays(last, 1);
  }
  return null;
}

// Нейтральные пометки (tasks_notes_from_facts): выходной/праздник по календарю и vacation/day_off.
function buildNotes(idx, days) {
  const notes = [];
  const dayInfo = new Map();
  for (const { row } of idx.values()) {
    if (!dayInfo.has(row.date) && typeof row.day_type === 'string') {
      dayInfo.set(row.date, { type: row.day_type, label: row.holiday_label === undefined ? null : row.holiday_label });
    }
  }
  const set = new Set(days);
  for (const d of days) {
    const info = dayInfo.get(d);
    if (info && ['weekend', 'holiday', 'transferred_day_off'].includes(info.type)) {
      notes.push({ date: d, employee_id: null, kind: info.type === 'holiday' ? 'holiday' : 'weekend', label: info.label });
    }
  }
  for (const { emp, row } of idx.values()) {
    if (!set.has(row.date)) continue;
    if (row.matrix_status === 'vacation' || row.matrix_status === 'day_off') {
      notes.push({ date: row.date, employee_id: emp, kind: row.matrix_status, label: null });
    }
  }
  notes.sort((a, b) => cmp(a.date, b.date) || cmp(a.employee_id === null ? '' : a.employee_id, b.employee_id === null ? '' : b.employee_id) || cmp(a.kind, b.kind));
  return notes;
}

// Нормализация списка сотрудников → string[] | null.
function normEmployees(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_EMPLOYEES) return null;
  const out = [];
  for (const e of v) {
    if (typeof e !== 'string' || e.trim() === '') return null;
    const t = e.trim();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
// ---- /common.js ----------------------------------------------------------------
