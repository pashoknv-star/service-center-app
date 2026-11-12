// V6-4 (приёмка, вне gate): синтетические данные для браузерной приёмки (только временная копия БД).
'use strict';
const fs = require('fs'), path = require('path');
const L = require('./v6_accept_lib.js');

const AVATAR = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(L.ROOT, 'reports/V6/assets/director_avatar.jpg')).toString('base64');
const D = (n) => { const d = new Date(Date.UTC(2026, 10, 16 + n)); return d.toISOString().slice(0, 10); }; // 0 = пн 2026-11-16

async function seed(env) {
  const db = env.tmpDb, base = env.base;
  const adminCookies = await L.login(base, 'admin'); // миграция до v11 + cookie
  const ck = adminCookies.join('; ');
  const pos = L.sql(db, 'select id from positions limit 1;').trim();
  const emps = [
    ['emp_101', 'Директор Тестов Павел Игоревич', 'g3', AVATAR],
    ['emp_105', 'Козлов Сергей Петрович', 'g1', null],
    ['emp_106', 'Орлова Мария Ивановна', 'g2', null],
    ['emp_107', 'Смирнова Ольга Юрьевна', 'g0', null],
    ['emp_199', 'Удаляемый Сотрудник Тестович', 'g1', null],
  ];
  let sqlText = '';
  emps.forEach((e, i) => {
    sqlText += "INSERT INTO employees (id, full_name, position_id, location, group_id, photo_url, sort_order, created_at, updated_at) VALUES ('" + e[0] + "','" + e[1] + "','" + pos + "','Офис','" + e[2] + "'," + (e[3] ? "'" + e[3] + "'" : 'NULL') + "," + (10 + i) + ",'2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00');\n";
  });
  L.sql(db, sqlText);
  const eRes = await L.http(base, ck, 'GET', 'api/employees.php');
  const list = Array.isArray(eRes.json) ? eRes.json : (eRes.json.data || eRes.json.employees || []);
  const byName = {}; list.forEach((e) => { byName[e.full_name || e.name] = String(e.id); });
  const ids = { dir: 'emp_101', e1: 'emp_1', e2: 'emp_2', e3: 'emp_3', e4: 'emp_4', e5: 'emp_105', e6: 'emp_106', e7: 'emp_107', gone: 'emp_199' };
  const longDesc = 'Подготовить подробный отчёт по итогам квартала: выручка, расходы, загрузка сотрудников, замечания клиентов и план мероприятий на следующий квартал — всё в одном документе.';
  const T = {};
  const seedTasks = [
    // ключ, название, начало, конец, исполнители, доп.
    ['dirmeet', 'Совещание у директора', D(2) + 'T10:00', D(2) + 'T11:00', [ids.dir], { priority: 1, label: 'руководство', description: longDesc }],
    ['plan', 'Планёрка отдела', D(2) + 'T09:00', D(2) + 'T10:30', [ids.e2], { label: 'планёрка' }],
    ['dog', 'Согласование договора', D(2) + 'T09:30', D(2) + 'T11:00', [ids.e3], { priority: 3 }],
    ['call', 'Звонок клиенту', D(2) + 'T10:00', D(2) + 'T10:45', [ids.e4], {}],
    ['lunch', 'Обед с партнёрами', D(2) + 'T12:00', D(2) + 'T13:00', [ids.e5, ids.e6], { label: 'встреча' }],
    ['start', 'Только время начала', D(2) + 'T15:00', null, [ids.e7], {}],
    ['short', 'Короткая встреча 15 минут', D(2) + 'T16:00', D(2) + 'T16:15', [ids.e1], {}],
    ['night', 'Ночная выгрузка данных', D(2) + 'T23:00', D(2) + 'T23:30', [ids.e5], {}],
    ['inv', 'Инвентаризация склада', D(1), null, [ids.e1], {}],
    ['multi', 'Командировочный отчёт', D(1) + 'T09:00', D(3) + 'T18:00', [ids.e3], { label: 'отчёты' }],
    ['sicktask', 'Задача на больничном', D(4) + 'T10:00', D(4) + 'T11:00', [ids.e3], {}],
    ['xss', 'Тема <b>x</b> & "кавычки"', D(3) + 'T14:00', D(3) + 'T15:00', [ids.e1], { label: 'метка <i>x</i>', description: 'Описание <script>1</script>' }],
    ['orph', 'Задача осиротеет', D(3) + 'T11:00', D(3) + 'T12:00', [ids.gone], {}],
    ['closed', 'Закрытая задача', D(0) + 'T10:00', D(0) + 'T11:00', [ids.e2], { label: 'руководство' }],
    ['dirmeet2', 'Приём у директора', D(0) + 'T14:00', D(0) + 'T15:00', [ids.dir], { priority: 2 }],
    ['dirshort', 'Планирование без отпуска', D(5) + 'T10:00', D(5) + 'T11:00', [ids.dir], {}],
  ];
  for (const [k, title, s, e, as, x] of seedTasks) {
    const body = Object.assign({ title, start_at: s, end_at: e, assignees: as }, x);
    const r = await L.http(base, ck, 'POST', 'api/tasks.php', body);
    if (r.status !== 201) throw new Error('seed ' + title + ' → ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 300));
    T[k] = r.json.task.id;
  }
  // закрыть «Закрытая задача»
  const pr = await L.http(base, ck, 'POST', 'api/tasks.php?id=' + T.closed + '&action=close', {});
  // отпуска/больничные (после создания задач — чтобы не блокировали)
  let ss = '';
  const se = (emp, date, st) => { ss += "INSERT OR REPLACE INTO schedule_entries (employee_id,date,status,approval_status,updated_at,version) VALUES ('" + emp + "','" + date + "','" + st + "','approved','2026-11-01T00:00:00+00:00',1);\n"; };
  [2, 3].forEach((n) => se('emp_101', D(n), 'vacation'));         // 18, 19 — отпуск директора
  [2, 3].forEach((n) => se('emp_2', D(n), 'vacation'));            // 18, 19 — отпуск Ивановой
  se('emp_3', D(4), 'sick');                                       // 20 — больничный
  se('emp_1', D(3), 'day_off');
  L.sql(db, ss);
  // осиротить задачу
  L.sql(db, "DELETE FROM employees WHERE id='emp_199';");
  return { ids, T, adminCookies, D, closedPut: pr.status };
}

module.exports = { seed, D, AVATAR };
