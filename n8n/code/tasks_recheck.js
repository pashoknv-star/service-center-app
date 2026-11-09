// ---- tasks-recheck: вход {tasks:[{id, employee_ids[], from, to}], facts} →
//      {results:[{id, conflict, blocked_days[]} | {id, error}]}
// Запись check_state/conflict делает ПРИЛОЖЕНИЕ; n8n только выносит вердикт.
const body = $input.first().json.body ?? {};
const MAX_TASKS = 500;
const fail = (code) => [{ json: { error: code } }];

if (!Array.isArray(body.tasks) || body.tasks.length === 0 || body.tasks.length > MAX_TASKS) return fail('tasks_invalid');
if (body.facts === null || typeof body.facts !== 'object' || Array.isArray(body.facts)) return fail('facts_invalid');

const results = [];
for (const t of body.tasks) {
  const id = t && typeof t.id === 'string' ? t.id : null;
  if (id === null) return fail('tasks_invalid');
  const employees = normEmployees(t.employee_ids);
  const range = checkRange(t.from, t.to);
  const idx = employees === null || range.error ? null : indexFacts(body.facts, employees);
  if (employees === null || range.error || idx === null) {
    results.push({ id, error: employees === null ? 'employee_ids_invalid' : range.error || 'facts_invalid' });
    continue;
  }
  const blocked = blockedIn(idx, t.from, t.to);
  results.push({ id, conflict: blocked.length > 0, blocked_days: blocked });
}
return [{ json: { results } }];
