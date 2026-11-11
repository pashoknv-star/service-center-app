# T1-7 — D-1 backend: задача остаётся при удалении сотрудника («исполнитель удалён»)

Исполнитель: sd_worker_02. База: `eb2bcbc` (T1-9). Push/деплой не выполнялись. Контракт ниже — для T1-8 (UI).

## 1. Что изменено

| Файл | Изменение |
|---|---|
| `api/db.php` | `SCHEMA_VERSION` 9→10; `rebuildTaskAssigneesV10()` — пересборка `task_assignees` (create new → copy → drop → rename) без FK на `employees`, + `full_name_snapshot`; в транзакции, `PRAGMA foreign_keys` OFF до BEGIN и ON после COMMIT/ROLLBACK; идемпотентна (если FK на employees нет и колонка есть — no-op); snapshot при миграции берётся из `employees`; индекс `idx_task_assignees_emp` пересоздаётся |
| `api/schema.sql` | v10: `task_assignees` без FK на employees, колонка `full_name_snapshot TEXT` (свежая БД получает сразу v10) |
| `api/tasks.php` | `removed`/`removed_at`/snapshot в `assignees[]`/`watchers[]`; `orphan` у задачи; `?orphans=1`, `?open_for=`; правила PUT (п. 3 ниже); snapshot при каждом назначении (`tasks_replace_people`); удалённые не участвуют в conflict/notes/FR-10 |
| `api/tasks_rules.php` | единственная правка: `tasks_recheck_pending` берёт исполнителей через `JOIN employees` (удалённые не уходят в n8n recheck) |
| `api/helpers.php` | `tasks_open_ids_for_employee()` (аудит и `open_for`), `tasks_refresh_name_snapshot()` |
| `api/employees.php` | PUT: при смене `full_name` — обновление snapshot; DELETE: `open_tasks` в details `employee.delete` (логика удаления не менялась) |
| `api/save.php` | sync-путь: обновление snapshot при смене `full_name`; `open_tasks` в `employee.delete` (логика удаления не менялась) |
| `api/import.php` | после вставки сотрудников — освежение snapshot тех, кто вернулся с тем же id (логика очистки не менялась) |
| `api/tasks_test.php` | 33 → 46 тестов (M1/M2/M4 обновлены на v10; новые M5, D1–D12) |
| `scripts/test_tasks_matrix.js` | +B19 (orphan-задача не ломает матрицу), 70 → 71 |
| `scripts/verify_all.sh`, `AGENTS.md` | BASELINE: `tasks` 46, `tasksmx` 71 |

`index.html`, `js/*` не тронуты.

## 2. Контракт для T1-8 (UI)

### 2.1. Элемент `assignees[]` и `watchers[]` (список и карточка)
```json
{ "employee_id": "emp_x", "full_name": "Иванов И.", "removed": false, "removed_at": null }
{ "employee_id": "emp_y", "full_name": "Петров П.", "removed": true,  "removed_at": "2026-11-11T13:00:00+00:00" }
```
- `removed` = `employee_id` отсутствует в `employees` (вычисляется при чтении).
- У удалённого `full_name` — snapshot (ФИО на момент назначения/последнего переименования; может быть `null` только у данных, назначенных до миграции для уже несуществовавшего сотрудника).
- `removed_at` — `ts` последней записи `audit_log` `employee.delete` по id; `null`, если записи нет. **Внимание:** `audit_log` чистится по сроку 7 дней (E5-4) → для давних удалений `removed_at = null` — UI не должен на него опираться как на обязательное поле.
- Порядок: действующие исполнители первыми (по sort_order/ФИО), удалённые — в конце.

### 2.2. Поле задачи `orphan: bool`
`true` — нет ни одного действующего исполнителя (все `assignees[]` с `removed:true`). У задачи с 2 исполнителями, где удалён один, `orphan:false`. Поле есть во всех ответах `api/tasks.php` (список, карточка, ответы POST/PUT/close/…).
`conflict` у orphan-задачи считается только по действующим исполнителям (у orphan всегда `false`).

### 2.3. `GET api/tasks.php?orphans=1`
`{success:true, count:N, tasks:[<полные задачи как в списке>]}` — открытые (`status=open`) неархивные задачи с `orphan:true`, **без фильтра периода** (параметры `from/to/employee_id` игнорируются). Для счётчика ⚠ и фильтра «Без исполнителя». Роли: admin/supervisor/viewer — 200; аноним — 401.

### 2.4. `GET api/tasks.php?open_for=<employee_id>`
`{success:true, count:N, tasks:[{id,title,start_at,end_at,version}]}` — открытые неархивные задачи, где сотрудник — **действующий исполнитель** (роль `assignee`; наблюдатели не считаются). Порядок: `start_at, id`. Для удалённого/неизвестного id → `count:0, tasks:[]`. Вызывать **до** удаления (подтверждение и модальное окно). Роли — как у `?orphans=1`.

### 2.5. Правила записи (admin)
| Операция над orphan-задачей | Результат |
|---|---|
| close / reopen / archive (`DELETE`) | 200, как у обычной задачи |
| PUT без `assignees` (текст, приоритет, срок, watchers, чек-лист) | 200; удалённые исполнители остаются как есть (snapshot сохраняется) |
| PUT с `assignees`, набор **совпадает** с текущим | 200 `unchanged:true` (это не переназначение) |
| PUT с `assignees`, набор **изменён** | все id нового набора должны существовать: удалённый id → **400** `{error:"employee_not_found", employee_id}` |
| переназначение = PUT `assignees:[новый_id]` (замена удалённого на нового, с `version`) | 200; снимается `orphan`; пишется обычный `task.update` (`assignees_before/after`) |
| переназначение на сотрудника с больничным/командировкой в срок | **422** `TASK_BLOCKED_BY_SICK_OR_TRIP` + `blocked_days`, `suggested_start`, `suggested_end` (FR-10) |
| PUT с `assignees:[]` | 400 `assignees_required` (как раньше) |

Удалённые исполнители не участвуют в проверке FR-10 (в т.ч. в запросах к n8n validate/recheck), в `conflict`, `notes`. Если после фильтра исполнителей не осталось — проверка пропускается (`check_state='ok'`).

### 2.6. Аудит
`employee.delete` (и `employees.php` DELETE, и sync-delete `save.php`): `details = {fullName, open_tasks:[task_id…]}` — открытые неархивные задачи, где удаляемый был исполнителем (список пустой `[]`, если таких нет). Переназначение пишется как `task.update`.

## 3. Решения / отклонения от ТЗ
- Snapshot обновляется при переименовании только если `full_name` реально изменился (в sync-пути — по diff `changes`), чтобы не писать в `task_assignees` на каждый autosave.
- Watchers: поле `removed` есть и у них; правило «PUT изменяет набор → все существуют» применено только к `assignees` (как в ТЗ). Для watchers прежнее поведение: проверяются только добавляемые id.
- Полная очистка `import.php`: удаляет `employees` без каскада на `task_assignees` (FK снят) — задачи и назначения сохраняются; вернувшийся с тем же id сотрудник снова «действующий».
- `?orphans=1` не вызывает n8n-recheck (отдельная ветка).
- Матрица: `js/tasks_matrix.js` не менялась; по коду строки удалённого сотрудника нет → иконка/рамка не рисуются (`rows[emp]` отсутствует → `return`); тест B19 подтверждает отсутствие исключений и корректную отрисовку у действующего исполнителя смешанной задачи.

## 4. Проверки
- `php api/tasks_test.php` → `RESULTS: 46 passed, 0 failed`, `DB intact: YES`. Покрыто: миграция v9→v10 на БД с задачами (строки, snapshot, FK только на tasks/CASCADE, индекс, `foreign_keys` возвращён, `foreign_key_check` пуст, повтор идемпотентен, сотрудник удаляется — назначение живо); удаление через `employees.php` DELETE и sync `save.php` (orphan/removed/snapshot/`removed_at`, 2 исполнителя → `orphan:false`); переименование (оба пути) обновляет snapshot; `import.php` с тем же id → восстановление; `?orphans=1` (без периода, исключает закрытые/архивные/с исполнителем); `?open_for=`; close/reopen/archive/PUT текста/срока/watchers для orphan → 200; PUT assignees на удалённого → 400 `employee_not_found`; замена → 200 + audit; больничный → 422 + `suggested_start` (в т.ч. смешанный случай); audit `open_tasks` (оба пути, только открытые неархивные); RBAC новых GET (anon 401, supervisor/viewer 200); приватность (нет phone/photo).
- `bash scripts/verify_all.sh`:

```
SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84     3s
tasks    PASS     46     46     2s
tasksn8n PASS     25     25    26s
tasksui  PASS     63     63     5s
tasksmx  PASS     71     71     6s
e51      PASS     23     23     0s
e52      PASS     41     41     0s
hygiene  PASS     19     19     0s
trips    PASS      7      7     3s
syntax   PASS      -      -     0s
phplint  PASS     33      -     2s
pii      PASS      -      -     0s
clean    PASS
GATE: PASS (12 suites)
```
- `data/app.db` чиста (`git status`).

## 5. Риски / на что обратить внимание при деплое
- Миграция v10 выполняется автоматически при первом обращении к любому API (`migrate()`); на проде — бэкап `data/app.db` перед выкладкой (DEPLOY_HOSTLAND §4). Таблица `task_assignees` пересобирается в транзакции; для прод-БД без задач (блок «Задачи» ещё не выкладывался) таблица создаётся сразу в v10.
- `removed_at` опирается на `audit_log` (хранение 7 дней): для давних удалений будет `null` — осознанно по ТЗ.
- Сотрудники, удалённые ДО выкладки v10, уже потеряли назначения каскадом (v9) — восстановить нельзя; snapshot доступен только для назначений, существующих на момент миграции/после неё.
- Реальный браузер/UI не затрагивался (T1-8).
