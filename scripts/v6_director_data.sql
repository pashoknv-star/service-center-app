-- ============================================================================
-- V6-3 (R-2, решение владельца 2026-11-12): данные «Директор СЦ» в БОЕВОЙ базе.
--
--   Сотрудник «Костецкий Андрей Николаевич» (зона 3, плитка «В2С») → «Игнатенко Павел Валерьевич»,
--   фото — картинка «Дон Корлеоне», группа g3 (в приложении теперь «Директор СЦ»).
--
-- НЕ выполнять без команды владельца «Деплой». Порядок — reports/V6/V6-3_DATA_STEP.md.
-- Только sqlite3 CLI (прод: sqlite3 3.26; PHP 5.3 на CLI не запускается). Файл НЕ трогает data/app.db сам —
-- его запускают командой ниже на бэкапнутой боевой базе.
--
--   DRY-RUN (только SELECT, ничего не меняет):
--     sed '/^-- @@APPLY/,$d' scripts/v6_director_data.sql | sqlite3 -readonly data/app.db
--   APPLY (DRY-RUN + изменение в одной транзакции; запускать только после того, как владелец увидел счётчики):
--     sqlite3 data/app.db < scripts/v6_director_data.sql
--
-- Правила APPLY (все проверки — внутри SQL, а не «на глаз»):
--   * ровно 1 сотрудник с этим ФИО, иначе — ничего не меняется (0 или >1 совпадений);
--   * сотрудника «Игнатенко Павел Валерьевич» ещё нет (иначе дубль) — иначе ничего не меняется;
--   * группа g3 существует; schema_version >= 10 (есть task_assignees.full_name_snapshot);
--   * идемпотентно: после первого применения «Костецкий…» не находится → повтор = 0 изменений;
--   * история отпусков / командировок / задач Костецкого НЕ удаляется и не переносится: id сотрудника
--     сохраняется, записи остаются привязанными к той же строке employees (решение по ним — за владельцем,
--     в DRY-RUN выводятся только счётчики);
--   * должность (position_id) НЕ меняется — владелец не просил; DRY-RUN показывает текущую.
-- ============================================================================
.headers on
.mode column

-- ---------------------------------------------------------------------------
-- ==== DRY-RUN =============================================================
-- ---------------------------------------------------------------------------

SELECT 'schema_version' AS what, value FROM meta WHERE key = 'schema_version';

SELECT 'matches (нужно ровно 1)' AS what, COUNT(*) AS n
  FROM employees WHERE full_name = 'Костецкий Андрей Николаевич';

SELECT 'target already exists (нужно 0)' AS what, COUNT(*) AS n
  FROM employees WHERE full_name = 'Игнатенко Павел Валерьевич';

SELECT 'group g3' AS what, id, name FROM groups WHERE id = 'g3';

-- карточка сотрудника
SELECT e.id, e.full_name, e.group_id, g.name AS group_name,
       e.position_id, p.name AS position, e.photo_url, e.location, e.updated_at
  FROM employees e
  LEFT JOIN groups g ON g.id = e.group_id
  LEFT JOIN positions p ON p.id = e.position_id
 WHERE e.full_name = 'Костецкий Андрей Николаевич';

-- счётчики связанных данных (НЕ меняются этим скриптом)
SELECT 'schedule_entries' AS what, COUNT(*) AS n, MIN(date) AS first_date, MAX(date) AS last_date
  FROM schedule_entries
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич');

SELECT 'schedule_entries по статусам' AS what, status, COUNT(*) AS n
  FROM schedule_entries
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич')
 GROUP BY status ORDER BY status;

SELECT 'vacation_balances' AS what, COUNT(*) AS n, MIN(year) AS first_year, MAX(year) AS last_year
  FROM vacation_balances
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич');

SELECT 'trip_participants' AS what, COUNT(*) AS n
  FROM trip_participants
 WHERE employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич');

SELECT 'task_assignees open' AS what, COUNT(*) AS n
  FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
 WHERE ta.employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич')
   AND t.status = 'open' AND t.archived = 0;

SELECT 'task_assignees closed/archived' AS what, COUNT(*) AS n
  FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
 WHERE ta.employee_id IN (SELECT id FROM employees WHERE full_name = 'Костецкий Андрей Николаевич')
   AND (t.status = 'closed' OR t.archived = 1);

-- ---------------------------------------------------------------------------
-- @@APPLY  (всё ниже, до конца файла, DRY-RUN-вариант отрезает командой sed)
-- ==== APPLY ===============================================================
-- ---------------------------------------------------------------------------
.bail on
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

DROP TABLE IF EXISTS temp.v6_t;
-- Цель = ровно один подходящий сотрудник при выполнении ВСЕХ условий; иначе таблица пуста и ниже ничего не меняется.
CREATE TEMP TABLE v6_t AS
  SELECT e.id AS id
    FROM employees e
   WHERE e.full_name = 'Костецкий Андрей Николаевич'
     AND (SELECT COUNT(*) FROM employees WHERE full_name = 'Костецкий Андрей Николаевич') = 1
     AND (SELECT COUNT(*) FROM employees WHERE full_name = 'Игнатенко Павел Валерьевич') = 0
     AND EXISTS (SELECT 1 FROM groups WHERE id = 'g3')
     AND CAST((SELECT value FROM meta WHERE key = 'schema_version') AS INTEGER) >= 10;

UPDATE employees
   SET full_name  = 'Игнатенко Павел Валерьевич',
       photo_url  = 'images/photo_1794600000_d1ec7040.jpg',   -- формат api/upload.php: images/photo_<unix>_<8 hex>.<ext>
       group_id   = 'g3',
       updated_at = strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00'
 WHERE id IN (SELECT id FROM v6_t);

-- ФИО-снимок в назначениях задач (T1-7, D-1)
UPDATE task_assignees
   SET full_name_snapshot = 'Игнатенко Павел Валерьевич'
 WHERE employee_id IN (SELECT id FROM v6_t);

-- audit_log: формат проекта (ts ISO-8601 UTC, action employee.update, details {"changes":{...}})
INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details)
SELECT strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00', 'sql:v6-3', 'admin', 'employee.update', 'employee', id,
       '{"changes":{"full_name":"Игнатенко Павел Валерьевич","group_id":"g3","photo_url":"images/photo_1794600000_d1ec7040.jpg"}}'
  FROM v6_t;

-- sync_log: открытые окна подтянут изменение сотрудника дельта-синхронизацией (как save.php)
INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at)
SELECT 'employee', id, 'upsert', 'sql:v6-3', strftime('%Y-%m-%dT%H:%M:%S', 'now') || '+00:00'
  FROM v6_t;

SELECT CASE WHEN (SELECT COUNT(*) FROM v6_t) = 1
            THEN 'APPLIED: 1 сотрудник обновлён'
            ELSE 'NO-OP: условия не выполнены (нужно: ровно 1 «Костецкий…», 0 «Игнатенко…», g3, schema>=10) — ничего не изменено'
       END AS result;

DROP TABLE temp.v6_t;
COMMIT;

-- проверки после COMMIT
SELECT e.id, e.full_name, e.group_id, e.photo_url, e.updated_at
  FROM employees e WHERE e.full_name = 'Игнатенко Павел Валерьевич';
SELECT 'остаток «Костецкий…» (после APPLY должно быть 0)' AS what, COUNT(*) AS n
  FROM employees WHERE full_name = 'Костецкий Андрей Николаевич';
PRAGMA foreign_key_check;
PRAGMA integrity_check;
