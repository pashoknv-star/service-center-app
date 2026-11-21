# V10-T1 — отчёт: схема v15, ТС, базы, пул водителей, перенос ТС, журнал (сьют `transportdb`)

Задача Kanban `t_6dec04ad`, ветка `v10-t1-schema`. Класс 🔴 (миграции `api/db.php`). Индексы кода не использовались: все утверждения — по исходникам на текущем коммите и прогонам.

## 0. Отклонения от `CONTRACT.md`

Функциональных отклонений нет. Уточнения, которых контракт не фиксировал (расширения без смены имён и семантики):

1. `transport_can_edit_request(array $request, ?array $user = null, ?PDO $pdo = null)` — два необязательных параметра (пользователь, PDO) сверх контрактной `(array $request)`; вызов с одним аргументом работает как в контракте. Автор заявки определяется по `users.id = created_by`, делегирование — по ЛОГИНУ автора (`users.username`) через `TRANSPORT_EDIT_DELEGATION` (`api/transport_lib.php:33`, `:165`).
2. `transport_role()` / `transport_user_id()` / `transport_can_move_vehicle()` принимают необязательный `?array $user` (для юнит-тестов).
3. Коды ошибок, которых нет в контракте: 400 `invalid_action` / `invalid_entity`, 405 `method_not_allowed`; 422 `invalid_name`, `invalid_plate`, `invalid_status`, `invalid_sort_order`, `invalid_version`, `id_required`. Коды из контракта (`duplicate_name`, `duplicate_plate`, `unknown_base`, `driver_not_allowed`, `use_move`, `same_base`, `version_required`, `unknown_employee`, `already_in_pool`, `driver_in_use`) — как в контракте.
4. Госномер хранится нормализованным (верхний регистр, без пробелов); уникальность имени базы без учёта регистра (в т.ч. кириллицы) проверяется в API (UNIQUE в SQLite — только точное совпадение).
5. Таблицы заявок/назначений/бригады/остановок/`geo_cache` создаются, API к ним — T5/T6/T7 (не входит).
6. `ts` журнала — локальное +05 с секундами (`YYYY-MM-DDTHH:MM:SS`); `transport_now_local()` — без секунд (`YYYY-MM-DDTHH:MM`), как `start_at`.

## 1. Что сделано (контракт как реализован)

| Область | Файл:строка | Суть |
|---|---|---|
| Схема v15 | `api/schema.sql` (раздел «Модуль «Транспорт»» в конце), `api/db.php:38` (`SCHEMA_VERSION = 15`), `api/db.php:405` (вызов), `api/db.php:425` (`createTransportSchemaV15()`) | 9 таблиц, индексы, 2 триггера журнала; только добавление, `IF NOT EXISTS`; `employee_id`/`driver_id`/`default_driver_id` — TEXT без FK на `employees` (повторный импорт сотрудников не стирает транспорт; как `task_assignees` с v10) |
| Индексы | `idx_transport_assignments_vehicle (vehicle_id,start_at,end_at)`, `idx_transport_assignments_driver (driver_id,start_at,end_at)`, `idx_transport_assignments_request`, `idx_vehicles_base`, `idx_assignment_crew_employee`, `idx_transport_requests_*` (display_no UNIQUE, status, created_by, external), `idx_transport_journal_*` (ts, entity) | |
| CHECK | `transport_assignments.duration_min` (>0, ≤10080, %15), `assignment_stops.stay_min`/`leg_min`/`leg_min_map` (≥0, %15), статусы ТС/заявки, `kind` остановки, диапазоны `lat`/`lon` | |
| Журнал | триггеры `trg_transport_journal_no_update` / `_no_delete` → `RAISE(ABORT,'transport_journal is append-only')` | `audit_cleanup` (`api/helpers.php`) и `cleanupAuditLog` (`api/db.php:817`) работают только с `audit_log` — кейсы J4/J5 (запись журнала «состарена» до 2020 г., очистка вызвана, запись на месте) |
| Библиотека | `api/transport_lib.php` | `transport_role`, `transport_user_id`, `transport_can_move_vehicle` (admin/viewer), `transport_can_edit_request` + `TRANSPORT_EDIT_DELEGATION`, `transport_allowed_drivers` (группа по НАЗВАНИЮ «Транспорт», не `g6`, ∪ пул, дубли схлопнуты, приоритет `group`, без телефона/фото), `transport_journal_write`, `transport_check_step`, `transport_now_local` (+05), `transport_tx` / `transport_fail` / `transport_handle` |
| API | `api/transport_vehicles.php` | GET (всем авторизованным); `POST/PUT ?entity=base|vehicle`, `POST/DELETE ?entity=pool` — только admin; `POST ?action=move&id=` — admin или viewer; журнал в той же транзакции (`base.create|update`, `vehicle.create|update|move`, `driver_pool.add|remove`); `version` ТС и 409 `VERSION_CONFLICT` (`current_version`, `vehicle`) по образцу `api/tasks.php`; совместим с PHP 8.1 |

## 2. Проверено

- `bash scripts/verify_all.sh transportdb` → `RESULTS: 112 passed, 0 failed`, `DB intact: YES` (временная копия БД через `SC_APP_DB`; sha1 `data/app.db` до/после совпадает).
- Полный `bash scripts/verify_all.sh` → `GATE: PASS (23 suites)` (таблица ниже). `BASELINE[transportdb]=112` — в том же коммите.
- `php -l` на `api/db.php`, `api/transport_lib.php`, `api/transport_vehicles.php`, `api/transport_db_test.php` — без ошибок; `node scripts/check_syntax.js` → `failed: 0`; `bash scripts/check_no_pii.sh` → `OK`.
- Красный прогон до реализации — `reports/V10/T1_RED_run_before_fix.txt` (0 passed / 114 «failed» = 112 тестов + 2 строки `SETUP`, которые в зелёном прогоне проходят молча и в счёт не входят).
- Миграция на копии: dev-БД имеет `schema_version = 6`, поэтому M1 — v6→v15 на копии; M2 — путь v14→v15: на копии убираются объекты транспорта и ставится `schema_version = 14`, затем `migrate()`: прежние данные на месте, повторный `migrate()` и «ложная 14» — no-op; M3 сверяет DDL в `db.php` и `schema.sql` построчно по `sqlite_master`; M4 — свежая пустая БД.
- Ручной прогон: `sqlite3 копия.db < ddl_v15.sql` дважды без ошибок, `integrity_check = ok`, `foreign_key_check` пусто, 9 таблиц, UPDATE журнала → `transport_journal is append-only`; `data/app.db` не изменён (sha1 `a2e65ae47cc7…` до и после, `git status data/` пуст).
- Права (R1/R2, M-кейсы): admin — всё; supervisor_zone0/zone1 — чтение, справочник и `move` → 403; viewer_test — чтение и `move` → 200, остальная запись → 403; аноним → 401; при отказах состояние БД и журнал не меняются. Юнит-проверки `transport_can_edit_request` (L6–L10): admin — любые; zone0 — свои и заявки zone1; zone1 — только свои; viewer и аноним — никогда.
- Атомарность (J8): сбой записи журнала откатывает мутацию целиком (500).

### Таблица gate

```
SUITE    RES  PASSED EXPECT   TIME  NOTE
smoke    PASS     84     84     3s  
tasks    PASS     66     66     5s  
tasksn8n PASS     27     27    26s  
tasksatt PASS     24     24     5s  
tasklinks PASS     37     37     6s  
transportdb PASS    112    112     3s  
tasksui  PASS    334    334    25s  
tasksmx  PASS     79     79     6s  
taskscal PASS    220    220     7s  
director PASS    101    101    16s  
emptasks PASS     34     34     2s  
tasklinksui PASS    211    211   125s  
e51      PASS     23     23     1s  
e52      PASS     41     41     0s  
hygiene  PASS     19     19     0s  
trips    PASS      7      7     3s  
tripsform PASS    131    131    62s  
tripsstatus PASS    147    147    77s  
syntax   PASS      -      -     0s  
phplint  PASS     41      -     5s  
pii      PASS      -      -     1s  
refs     PASS     28     28    34s  удалено 0, со ссылками 0, исключений 0
tasklink PASS     43     43     9s  коммитов 3, с кодом 1, нарушений 0
clean    PASS

GATE: PASS (23 suites)
```

## 3. Обновлённые тесты с ожиданием `schema_version == 14`

Найдено `rg "schema_version" api scripts`; осознанно 14 → 15 (меняется только число, проверки не ослаблены):

- `api/tasks_test.php` (блоки миграции M1 и повторы v8/v9/v10/v11 → 15);
- `api/tasks_links_test.php` (версия и `meta.schema_version`);
- `api/task_files_test.php` (версия после миграции);
- `scripts/test_v6_director.js` (`SCHEMA_VERSION = 15` в `api/db.php`, миграция копии → 15, сценарий v10→v11).

Прочие вхождения (`api/init_db.php`, `scripts/v6_accept_data.sh`, `api/db.php`) тестами версии 14 не являются.

## 4. Готовый идемпотентный DDL v15 для прод-БД

Выкладка `api/db.php` мигрирует БД автоматически при первом запросе (бэкап `data/app.db` перед выкладкой — по `DEPLOY_HOSTLAND.md`). Для ручного применения — тот же текст (только `CREATE ... IF NOT EXISTS`, существующие данные не затрагиваются); после него `UPDATE meta SET value='15' WHERE key='schema_version';` (код сделает это сам):

```sql
CREATE TABLE IF NOT EXISTS transport_bases (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS vehicles (
    id                TEXT PRIMARY KEY NOT NULL,
    name              TEXT NOT NULL,
    plate             TEXT NOT NULL UNIQUE,
    base_id           TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'in_service' CHECK (status IN ('in_service','repair')),
    default_driver_id TEXT,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    version           INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT,
    updated_at        TEXT,
    FOREIGN KEY (base_id) REFERENCES transport_bases(id)
);
CREATE INDEX IF NOT EXISTS idx_vehicles_base ON vehicles (base_id);
CREATE TABLE IF NOT EXISTS transport_driver_pool (
    employee_id TEXT PRIMARY KEY NOT NULL,
    added_by    TEXT,
    added_at    TEXT
);
CREATE TABLE IF NOT EXISTS transport_requests (
    id              TEXT PRIMARY KEY NOT NULL,
    display_no      INTEGER,
    title           TEXT NOT NULL,
    subscriber      TEXT,
    address         TEXT,
    comment         TEXT,
    status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','assigned','in_progress','done','cancelled')),
    source          TEXT,
    external_id     TEXT,
    version         INTEGER NOT NULL DEFAULT 1,
    created_by      TEXT,
    created_by_name TEXT,
    created_at      TEXT,
    updated_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_transport_requests_display_no ON transport_requests (display_no);
CREATE INDEX IF NOT EXISTS idx_transport_requests_status ON transport_requests (status);
CREATE INDEX IF NOT EXISTS idx_transport_requests_created_by ON transport_requests (created_by);
CREATE INDEX IF NOT EXISTS idx_transport_requests_external ON transport_requests (external_id);
CREATE TABLE IF NOT EXISTS transport_assignments (
    id               TEXT PRIMARY KEY NOT NULL,
    request_id       TEXT NOT NULL,
    vehicle_id       TEXT NOT NULL,
    driver_id        TEXT NOT NULL,
    driver_name_snap TEXT,
    start_at         TEXT NOT NULL,
    duration_min     INTEGER NOT NULL CHECK (duration_min > 0 AND duration_min <= 10080 AND duration_min % 15 = 0),
    end_at           TEXT NOT NULL,
    override_json    TEXT,
    version          INTEGER NOT NULL DEFAULT 1,
    created_by       TEXT,
    created_at       TEXT,
    updated_at       TEXT,
    FOREIGN KEY (request_id) REFERENCES transport_requests(id) ON DELETE CASCADE,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
);
CREATE INDEX IF NOT EXISTS idx_transport_assignments_vehicle ON transport_assignments (vehicle_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_transport_assignments_driver ON transport_assignments (driver_id, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_transport_assignments_request ON transport_assignments (request_id);
CREATE TABLE IF NOT EXISTS assignment_crew (
    assignment_id TEXT NOT NULL,
    employee_id   TEXT NOT NULL,
    name_snap     TEXT,
    PRIMARY KEY (assignment_id, employee_id),
    FOREIGN KEY (assignment_id) REFERENCES transport_assignments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_assignment_crew_employee ON assignment_crew (employee_id);
CREATE TABLE IF NOT EXISTS assignment_stops (
    assignment_id TEXT NOT NULL,
    ord           INTEGER NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('departure','intermediate','arrival')),
    place         TEXT NOT NULL,
    lat           REAL CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
    lon           REAL CHECK (lon IS NULL OR (lon >= -180 AND lon <= 180)),
    stay_min      INTEGER NOT NULL DEFAULT 0 CHECK (stay_min >= 0 AND stay_min % 15 = 0),
    leg_km        REAL,
    leg_min_map   INTEGER CHECK (leg_min_map IS NULL OR (leg_min_map >= 0 AND leg_min_map % 15 = 0)),
    leg_min       INTEGER NOT NULL DEFAULT 0 CHECK (leg_min >= 0 AND leg_min % 15 = 0),
    PRIMARY KEY (assignment_id, ord),
    FOREIGN KEY (assignment_id) REFERENCES transport_assignments(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS geo_cache (
    key          TEXT PRIMARY KEY NOT NULL,
    kind         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    fetched_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transport_journal (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT,
    actor         TEXT,
    role          TEXT,
    action        TEXT,
    entity_type   TEXT,
    entity_id     TEXT,
    before_json   TEXT,
    after_json    TEXT,
    warnings_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_transport_journal_ts ON transport_journal (ts);
CREATE INDEX IF NOT EXISTS idx_transport_journal_entity ON transport_journal (entity_type, entity_id);
CREATE TRIGGER IF NOT EXISTS trg_transport_journal_no_update BEFORE UPDATE ON transport_journal
BEGIN
    SELECT RAISE(ABORT, 'transport_journal is append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_transport_journal_no_delete BEFORE DELETE ON transport_journal
BEGIN
    SELECT RAISE(ABORT, 'transport_journal is append-only');
END;
```

## 5. Риски и замечания

- Допустимые водители: в dev-БД группа «Транспорт» пуста; на проде группа ищется по названию — при переименовании группы останется только пул (`TRANSPORT_DRIVER_GROUP_NAME`, `api/transport_lib.php:38`).
- Нет FK на `employees`: `employee_id` в пуле/бригаде может «осиротеть» после удаления сотрудника — сознательно (история), имя хранится в `*_snap`.
- `TRANSPORT_EDIT_DELEGATION` — буквально по сообщению владельца (zone0 → zone1); смена — одна константа.
- `transport_journal` не чистится (append-only); оценка роста — `ADR_DB.md` (T3).
- Hotspot: `scripts/verify_all.sh` (`BASELINE`/`ALL_SUITES`/ветка `run_suite`) правят параллельные задачи — возможен конфликт слияния (разрешается построчно).
- Не пушилось, не деплоилось, `AGENTS.md` не менялся.

## 6. Правки для `AGENTS.md`

См. `reports/V10/T1_AGENTS_patch.md`.
