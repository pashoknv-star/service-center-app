// ---- tasks-validate: вход {employee_ids[], from, to, facts} → {blocked_days[], notes[], suggested_start}
const body = $input.first().json.body ?? {};
const fail = (code) => [{ json: { error: code } }];

const employees = normEmployees(body.employee_ids);
if (employees === null) return fail('employee_ids_invalid');
const range = checkRange(body.from, body.to);
if (range.error) return fail(range.error);
const idx = indexFacts(body.facts, employees);
if (idx === null) return fail('facts_invalid');

const blocked = blockedIn(idx, body.from, body.to);
return [{
  json: {
    blocked_days: blocked,
    notes: buildNotes(idx, range.days),
    suggested_start: blocked.length > 0 ? suggestStart(idx, body.from, range.days.length) : null,
  },
}];
