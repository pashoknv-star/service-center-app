-- ============================================================================
-- V6-3 + V6-6 (R-2, решения владельца 2026-11-12 и 2026-11-13): данные «Управление СЦ» в БОЕВОЙ базе.
--
--   Сотрудник «Костецкий Андрей Николаевич» (зона 3) → «Игнатенко Павел Валерьевич»,
--   фото — картинка «Дон Корлеоне», группа g3 (в приложении «Управление СЦ»), должность «Директор»,
--   ИСТОРИЯ ЭТОГО СОТРУДНИКА ОЧИЩАЕТСЯ (решение владельца 2026-11-13: «История Костецкого — очистить»).
--
-- НЕ выполнять без команды владельца «Деплой». Порядок — reports/V6/V6-3_DATA_STEP.md.
-- Только sqlite3 CLI (прод: sqlite3 3.26; PHP 5.3 на CLI не запускается). Файл НЕ трогает data/app.db сам —
-- его запускают командой ниже на бэкапнутой боевой базе.
--
--   DRY-RUN (только SELECT, ничего не меняет):
--     sed '/^-- @@APPLY/,$d' scripts/v6_director_data.sql | sqlite3 -readonly data/app.db
--   APPLY (DRY-RUN + изменение в одной транзакции):
--     sqlite3 data/app.db < scripts/v6_director_data.sql
--
-- Что делает APPLY (одна транзакция BEGIN IMMEDIATE … COMMIT, .bail on — при любой ошибке откат):
--   * ФИО → «Игнатенко Павел Валерьевич», photo_url, group_id = 'g3', updated_at;
--   * должность «Директор»: берётся запись positions с name = 'Директор' (при дублях — с наименьшим sort_order, id);
--     нет такой — создаётся 'pos_директор' (id по правилу js/storage.js positionSlug: 'pos_' + имя в нижнем регистре,
--     чтобы следующее сохранение из браузера дало ТОТ ЖЕ id, а не дубль), sort_order = MAX+1; назначается сотруднику;
--   * очистка истории ТОЛЬКО этого сотрудника (по employee_id): schedule_entries, vacation_balances,
--     trip_participants, task_assignees (все роли и статусы задач), trip_requests (очередь RPA-заявок по его
--     участию в командировках — единственная «другая» таблица со ссылкой на сотрудника);
--   * сами tasks / trips / чек-листы НЕ удаляются. У затронутых tasks и trips version+1 и updated_at (устаревшие
--     открытые формы получат 409 вместо тихого возврата исполнителя/участника);
--   * audit_log НЕ чистится; добавляются записи employee.update и employee.history_clear (со счётчиками);
--   * sync_log: employee/upsert, entry/delete по каждой удалённой записи графика, trip/upsert по затронутым
--     командировкам — открытые окна подтянут изменения дельта-синхронизацией (для tasks механизма нет).
--
-- Правила APPLY (все проверки — внутри SQL, а не «на глаз»; не выполнено хоть одно — NO-OP, ничего не меняется):
--   * ровно 1 сотрудник с этим ФИО (0 или >1 — NO-OP);
--   * сотрудника «Игнатенко Павел Валерьевич» ещё нет (иначе дубль);
--   * группа g3 существует; schema_version >= 10 (есть task_assignees.full_name_snapshot);
--   * должность «Директор» либо уже есть в positions, либо id 'pos_директор' свободен;
--   * идемпотентно: после первого применения «Костецкий…» не находится → повтор = 0 изменений.
-- ============================================================================
.headers on
.mode list
.separator " | "

-- ---------------------------------------------------------------------------
-- ==== DRY-RUN =============================================================
-- ---------------------------------------------------------------------------

SELECT 'schema_version' AS what, value FROM meta WHERE key = 'schema_version';

SELECT 'matches (нужно ровно 1)' AS what, COUNT(*) AS n
  FROM employees WHERE full_name = 'Костецкий Андрей Николаевич';

SELECT 'target already exists (нужно 0)' AS what, COUNT(*) AS n
  FROM employees WHERE full_name = 'Игнатенко Павел Валерьевич';

SELECT 'group g3' AS what, id, name FROM groups WHERE id = 'g3';

-- другие сотрудники зоны 3 (по решению владельца их нет; если >0 — СТОП, показать владельцу; вывод только в терминал)
SELECT 'другие сотрудники g3 (до APPLY; ожидается 0)' AS what, COUNT(*) AS n
  FROM employees WHERE group_id = 'g3' AND full_name <> 'Костецкий Андрей Николаевич';
SELECT 'другой сотрудник g3' AS what, id, full_name
  FROM employees WHERE group_id = 'g3' AND full_name <> 'Костецкий Андрей Николаевич' ORDER BY full_name;

-- карточка сотрудника: текущая должность
SELECT e.id, e.full_name, e.group_id, g.name AS group_name,
       e.position_id AS cur_position_id, p.name AS cur_position, e.photo_url, e.location, e.updated_at
  FROM employees e
  LEFT JOIN groups g ON g.id = e.group_id
  LEFT JOIN positions p ON p.id = e.position_id
 WHERE e.full_name = 'Костецкий Андрей Николаевич';

-- новая должность
SELECT 'новая должность «Директор»' AS what,
       COALESCE((SELECT id FROM positions WHERE name = 'Директор' ORDER BY sort_order, id LIMIT 1), 'pos_директор') AS position_id,
       CASE WHEN EXISTS (SELECT 1 FROM positions WHERE name = 'Директор')
            THEN 'уже есть в positions (будет назначена)'
            WHEN EXISTS (SELECT 1 FROM positions WHERE id = 'pos_директор')
            THEN 'КОНФЛИКТ: id pos_директор занят другим именем — APPLY будет NO-OP'
            ELSE 'нет в positions — будет СОЗДАНА' END AS action;

-- ЧТО БУДЕТ УДАЛЕНО (история сотрудника; сами tasks/trips остаются)
SELECT 'УДАЛИТСЯ: schedule_entries' AS what, COUNT(*) AS n, MIN(date) AS first_date, MAX(date) AS last_date
  FROM schedule_entries
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич');

SELECT '   по статусам' AS what, status, COUNT(*) AS n
  FROM schedule_entries
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич')
 GROUP BY status ORDER BY status;

SELECT 'УДАЛИТСЯ: vacation_balances' AS what, COUNT(*) AS n, MIN(year) AS first_year, MAX(year) AS last_year
  FROM vacation_balances
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич');

SELECT 'УДАЛИТСЯ: trip_participants' AS what, COUNT(*) AS n
  FROM trip_participants
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич');

SELECT 'УДАЛИТСЯ: trip_requests (очередь RPA)' AS what, COUNT(*) AS n
  FROM trip_requests
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич');

SELECT 'УДАЛИТСЯ: task_assignees (все роли)' AS what, COUNT(*) AS n
  FROM task_assignees
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич');

SELECT '   по ролям и статусам задач' AS what, ta.role, t.status, t.archived, COUNT(*) AS n
  FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
 WHERE ta.employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич')
 GROUP BY ta.role, t.status, t.archived ORDER BY ta.role, t.status, t.archived;

-- НЕ удаляются, но меняются (version+1, updated_at):
SELECT 'ОСТАНУТСЯ, version+1: задач' AS what, COUNT(DISTINCT ta.task_id) AS n
  FROM task_assignees ta
 WHERE ta.employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич');

SELECT 'ОСТАНУТСЯ, version+1: командировок' AS what, COUNT(DISTINCT trip_id) AS n
  FROM trip_participants
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич');

SELECT 'командировок останется БЕЗ участников' AS what, COUNT(*) AS n
  FROM trips tr
 WHERE EXISTS (SELECT 1 FROM trip_participants tp WHERE tp.trip_id = tr.id
                AND tp.employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич'))
   AND NOT EXISTS (SELECT 1 FROM trip_participants tp WHERE tp.trip_id = tr.id
                AND tp.employee_id NOT IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич'));
SELECT '   командировка без участников' AS what, tr.id, tr.title, tr.status
  FROM trips tr
 WHERE EXISTS (SELECT 1 FROM trip_participants tp WHERE tp.trip_id = tr.id
                AND tp.employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич'))
   AND NOT EXISTS (SELECT 1 FROM trip_participants tp WHERE tp.trip_id = tr.id
                AND tp.employee_id NOT IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич'))
 ORDER BY tr.id;

-- задачи, которые станут «⚠ Без исполнителя» (открытые, неархивные; он — единственный действующий исполнитель).
-- Названия — ТОЛЬКО в терминал (не копировать в чат/репозиторий без нужды).
SELECT 'станут «Без исполнителя» (открытых задач)' AS what, COUNT(*) AS n
  FROM tasks t
 WHERE t.archived = 0 AND t.status = 'open'
   AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.role = 'assignee'
                AND ta.employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич'))
   AND NOT EXISTS (SELECT 1 FROM task_assignees o JOIN employees oe ON oe.id = o.employee_id
                    WHERE o.task_id = t.id AND o.role = 'assignee'
                      AND oe.full_name <> 'Костецкий Андрей Николаевич');
SELECT '   задача без исполнителя' AS what, t.id, t.title, t.start_at
  FROM tasks t
 WHERE t.archived = 0 AND t.status = 'open'
   AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.role = 'assignee'
                AND ta.employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич'))
   AND NOT EXISTS (SELECT 1 FROM task_assignees o JOIN employees oe ON oe.id = o.employee_id
                    WHERE o.task_id = t.id AND o.role = 'assignee'
                      AND oe.full_name <> 'Костецкий Андрей Николаевич')
 ORDER BY t.start_at, t.id;

-- ---------------------------------------------------------------------------
-- @@APPLY  (всё ниже, до конца файла, DRY-RUN-вариант отрезает командой sed)
-- ==== APPLY ===============================================================
-- ---------------------------------------------------------------------------
.timeout 5000
.bail on
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

DROP TABLE IF EXISTS temp.v6_t;
DROP TABLE IF EXISTS temp.v6_del;
DROP TABLE IF EXISTS temp.v6_trips;
-- Цель = ровно один подходящий сотрудник при выполнении ВСЕХ условий; иначе таблица пуста и ниже ничего не меняется.
CREATE TEMP TABLE v6_t AS
  SELECT e.id AS id
    FROM employees e
   WHERE e.full_name = 'Костецкий Андрей Николаевич'
     AND (SELECT COUNT(*) FROM employees WHERE full_name = 'Костецкий Андрей Николаевич') = 1
     AND (SELECT COUNT(*) FROM employees WHERE full_name = 'Игнатенко Павел Валерьевич') = 0
     AND EXISTS (SELECT 1 FROM groups WHERE id = 'g3')
     AND CAST((SELECT value FROM meta WHERE key = 'schema_version') AS INTEGER) >= 10
     AND (EXISTS (SELECT 1 FROM positions WHERE name = 'Директор')
          OR NOT EXISTS (SELECT 1 FROM positions WHERE id = 'pos_директор'));

-- Счётчики того, что будет удалено (до удаления) — для audit_log и итога.
CREATE TEMP TABLE v6_del AS
  SELECT 'schedule_entries' AS what, COUNT(*) AS n FROM schedule_entries WHERE employee_id IN (SELECT id FROM v6_t)
  UNION ALL SELECT 'vacation_balances', COUNT(*) FROM vacation_balances WHERE employee_id IN (SELECT id FROM v6_t)
  UNION ALL SELECT 'trip_participants', COUNT(*) FROM trip_participants WHERE employee_id IN (SELECT id FROM v6_t)
  UNION ALL SELECT 'trip_requests', COUNT(*) FROM trip_requests WHERE employee_id IN (SELECT id FROM v6_t)
  UNION ALL SELECT 'task_assignees', COUNT(*) FROM task_assignees WHERE employee_id IN (SELECT id FROM v6_t);

-- Командировки, у которых он был участником (для version+1 и sync_log).
CREATE TEMP TABLE v6_trips AS
  SELECT DISTINCT trip_id AS id FROM trip_participants WHERE employee_id IN (SELECT id FROM v6_t);

-- Должность «Директор»: создаём, только если по имени её нет (и только если цель найдена).
INSERT INTO positions (id, name, sort_order)
SELECT 'pos_директор', 'Директор', so
  FROM (SELECT COALESCE(MAX(sort_order), -1) + 1 AS so FROM positions)
 WHERE EXISTS (SELECT 1 FROM v6_t)
   AND NOT EXISTS (SELECT 1 FROM positions WHERE name = 'Директор');

UPDATE employees
   SET full_name   = 'Игнатенко Павел Валерьевич',
       photo_url   = 'images/photo_1794600000_d1ec7040.jpg',   -- формат api/upload.php: images/photo_<unix>_<8 hex>.<ext>
       group_id    = 'g3',
       position_id = (SELECT id FROM positions WHERE name = 'Директор' ORDER BY sort_order, id LIMIT 1),
       updated_at  = strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00'
 WHERE id IN (SELECT id FROM v6_t);

-- audit_log (журнал не чистится): формат проекта (ts ISO-8601 UTC, details JSON)
INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details)
SELECT strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00', 'sql:v6-6', 'admin', 'employee.update', 'employee', t.id,
       '{"changes":{"full_name":"Игнатенко Павел Валерьевич","group_id":"g3","photo_url":"images/photo_1794600000_d1ec7040.jpg","position_id":"'
       || (SELECT position_id FROM employees WHERE id = t.id) || '"}}'
  FROM v6_t t;
INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details)
SELECT strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00', 'sql:v6-6', 'admin', 'employee.history_clear', 'employee', t.id,
       '{"deleted":{"schedule_entries":' || (SELECT n FROM v6_del WHERE what = 'schedule_entries')
       || ',"vacation_balances":' || (SELECT n FROM v6_del WHERE what = 'vacation_balances')
       || ',"trip_participants":' || (SELECT n FROM v6_del WHERE what = 'trip_participants')
       || ',"trip_requests":' || (SELECT n FROM v6_del WHERE what = 'trip_requests')
       || ',"task_assignees":' || (SELECT n FROM v6_del WHERE what = 'task_assignees') || '}}'
  FROM v6_t t;

-- sync_log: открытые окна подтянут изменения дельта-синхронизацией (как save.php / entries.php / trips.php)
INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at)
SELECT 'employee', id, 'upsert', 'sql:v6-6', strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00'
  FROM v6_t;
INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at)
SELECT 'entry', se.employee_id || ':' || se.date, 'delete', 'sql:v6-6', strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00'
  FROM schedule_entries se WHERE se.employee_id IN (SELECT id FROM v6_t);
INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at)
SELECT 'trip', id, 'upsert', 'sql:v6-6', strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00'
  FROM v6_trips;

-- version+1 у затронутых задач и командировок (optimistic concurrency: устаревшая форма получит 409)
UPDATE tasks
   SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00'
 WHERE id IN (SELECT task_id FROM task_assignees WHERE employee_id IN (SELECT id FROM v6_t));
UPDATE trips
   SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00'
 WHERE id IN (SELECT id FROM v6_trips);

-- ОЧИСТКА ИСТОРИИ (только по employee_id цели; tasks / trips остаются)
DELETE FROM schedule_entries  WHERE employee_id IN (SELECT id FROM v6_t);
DELETE FROM vacation_balances WHERE employee_id IN (SELECT id FROM v6_t);
DELETE FROM trip_participants WHERE employee_id IN (SELECT id FROM v6_t);
DELETE FROM trip_requests     WHERE employee_id IN (SELECT id FROM v6_t);
DELETE FROM task_assignees    WHERE employee_id IN (SELECT id FROM v6_t);

SELECT CASE WHEN (SELECT COUNT(*) FROM v6_t) = 1
            THEN 'APPLIED: 1 сотрудник обновлён, история очищена'
            ELSE 'NO-OP: условия не выполнены (нужно: ровно 1 «Костецкий…», 0 «Игнатенко…», g3, schema>=10, должность «Директор» найдена или id pos_директор свободен) — ничего не изменено'
       END AS result;
SELECT 'удалено: ' || what AS what, n FROM v6_del WHERE (SELECT COUNT(*) FROM v6_t) = 1;

DROP TABLE temp.v6_trips;
DROP TABLE temp.v6_del;
DROP TABLE temp.v6_t;
COMMIT;

-- проверки после COMMIT
SELECT e.id, e.full_name, e.group_id, e.position_id, p.name AS position, e.photo_url, e.updated_at
  FROM employees e LEFT JOIN positions p ON p.id = e.position_id
 WHERE e.full_name = 'Игнатенко Павел Валерьевич';
SELECT 'остаток «Костецкий…» (после APPLY должно быть 0)' AS what, COUNT(*) AS n
  FROM employees WHERE full_name = 'Костецкий Андрей Николаевич';
SELECT 'история «Игнатенко…» (после APPLY везде 0)' AS what,
       (SELECT COUNT(*) FROM schedule_entries  WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Игнатенко Павел Валерьевич')) AS schedule_entries,
       (SELECT COUNT(*) FROM vacation_balances WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Игнатенко Павел Валерьевич')) AS vacation_balances,
       (SELECT COUNT(*) FROM trip_participants WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Игнатенко Павел Валерьевич')) AS trip_participants,
       (SELECT COUNT(*) FROM trip_requests     WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Игнатенко Павел Валерьевич')) AS trip_requests,
       (SELECT COUNT(*) FROM task_assignees    WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Игнатенко Павел Валерьевич')) AS task_assignees;
PRAGMA foreign_key_check;
PRAGMA integrity_check;
