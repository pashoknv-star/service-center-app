-- ============================================================================
-- Service Center App — SQLite Schema
-- Version: 10
-- Tables: groups, positions, employees, schedule_entries, holidays,
--         vacation_balances, users, meta, sync_log, audit_log,
--         trips, trip_participants, trip_requests,
--         tasks, task_assignees, task_checklist
--           Блок «Задачи» (schema v9, T1-1; v10, T1-7: task_assignees без FK на employees)
--         transport_bases, vehicles, transport_driver_pool, transport_requests, transport_assignments,
--         assignment_crew, assignment_stops, geo_cache, transport_journal
--           Модуль «Транспорт» (schema v15, V10-T1; раздел в конце файла)
-- Features: E5-4 automatic audit_log cleanup (>7 days)
--           Business trips (trips + trip_participants, schema v6)
--           RPA v1.2 (HelpMe) fields on trips (schema v7, E12-1)
--           RPA relay queue trip_requests (schema v8, E12-2)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ----------------------------------------------------------------------------
-- groups: подразделения сотрудников
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    name       TEXT,
    sort_order INTEGER
);

-- ----------------------------------------------------------------------------
-- positions: должности
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
    id         TEXT PRIMARY KEY,
    name       TEXT,
    sort_order INTEGER
);

-- ----------------------------------------------------------------------------
-- employees: сотрудники
-- FK position_id -> positions(id) ON DELETE SET NULL
-- FK group_id    -> groups(id)    ON DELETE SET NULL
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
    id                   TEXT PRIMARY KEY,
    full_name            TEXT    NOT NULL,
    position_id          TEXT,
    location             TEXT,
    group_id             TEXT,
    phone                TEXT,
    photo_url            TEXT,
    is_technical         INTEGER DEFAULT 0,
    requires_full_profile INTEGER DEFAULT 0,
    sort_order           INTEGER,
    created_at           TEXT,
    updated_at           TEXT,
    FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE SET NULL,
    FOREIGN KEY (group_id)    REFERENCES groups(id)    ON DELETE SET NULL
);

-- ----------------------------------------------------------------------------
-- schedule_entries: записи матрицы отпусков
-- entryKey = employee_id || ':' || date
-- FK employee_id -> employees(id) ON DELETE CASCADE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schedule_entries (
    employee_id     TEXT,
    date            TEXT,
    status          TEXT,
    comment         TEXT,
    approval_status TEXT    DEFAULT 'draft',
    version         INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT,
    PRIMARY KEY (employee_id, date),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- holidays: календарь выходных и праздников (ключ — date)
-- type: 'weekend' | 'holiday' | 'transferred_day_off' | 'working_weekend'
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS holidays (
    date  TEXT PRIMARY KEY,
    type  TEXT,
    label TEXT
);

-- ----------------------------------------------------------------------------
-- vacation_balances: остатки отпусков
-- balanceKey = employee_id || ':' || year
-- FK employee_id -> employees(id) ON DELETE CASCADE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vacation_balances (
    employee_id     TEXT,
    year            INTEGER,
    total_days      REAL,
    used_days       REAL,
    remaining_days  REAL,
    PRIMARY KEY (employee_id, year),
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------------------
-- users: учётные записи (аутентификация)
-- can_edit / is_admin хранятся как INTEGER (0|1)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id               TEXT PRIMARY KEY,
    username         TEXT UNIQUE NOT NULL,
    password_hash    TEXT NOT NULL,
    display_name     TEXT,
    can_edit         INTEGER DEFAULT 0,
    is_admin         INTEGER DEFAULT 0,
    scope_group_id   TEXT
);

-- ----------------------------------------------------------------------------
-- meta: ключ-значение для настроек (schema_version и др.)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- ----------------------------------------------------------------------------
-- sync_log: журнал изменений для дельта-синхронизации (E8, схема v3)
-- Пишется при каждом изменении entries/employees в save.php, vacation_import.php.
-- Ротация: save.php держит не более ~10000 последних событий.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT,
    entity_id   TEXT,
    action      TEXT,
    actor       TEXT,
    updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_id ON sync_log (id);

-- ----------------------------------------------------------------------------
-- audit_log: журнал аудита действий пользователей (E5, схема v4+)
-- Очистка: E5-4 автоматически удаляет записи старше 7 дней через migrate()
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT,
    actor       TEXT,
    role        TEXT,
    action      TEXT,
    entity_type TEXT,
    entity_id   TEXT,
    details     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);

-- ----------------------------------------------------------------------------
-- trips: командировки (фича «Командировки», schema v6)
-- status: 'forecast' | 'confirmed' (ровно два по ТЗ)
-- version: E8 optimistic concurrency (entryVersion-сверка в trips.php PUT)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
    id          TEXT PRIMARY KEY,           -- genId('trip_'), сервер
    title       TEXT NOT NULL,              -- цель/название
    location    TEXT,                       -- населённый пункт
    comment     TEXT,
    status      TEXT NOT NULL DEFAULT 'forecast',  -- forecast | confirmed
    version     INTEGER NOT NULL DEFAULT 1, -- E8 optimistic concurrency
    created_by  TEXT,
    created_at  TEXT, updated_at TEXT,
    -- RPA v1.2 (HelpMe), схема v7 (E12-1) -------------------------------
    origin      TEXT,                       -- место отправления
    hotel       TEXT,                       -- данные о гостинице
    transport_out_required INTEGER DEFAULT 1,  -- предзаказ билетов «выезд»
    transport_out_mode     TEXT,               -- 'avia' | 'zd'
    transport_back_required INTEGER DEFAULT 1, -- предзаказ «возврат»
    transport_back_mode    TEXT,               -- 'avia' | 'zd'
    advance_amount INTEGER,                 -- сумма аванса, целые рубли, >= 0
    business_process TEXT,                   -- точное значение пункта списка HelpMe
    phone       TEXT                        -- телефон сотрудника (ручной ввод)
);

-- ----------------------------------------------------------------------------
-- trip_participants: участники командировки (индивидуальные периоды)
-- FK trip_id     -> trips(id)     ON DELETE CASCADE
-- FK employee_id -> employees(id) ON DELETE CASCADE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_participants (
    trip_id     TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    start_date  TEXT NOT NULL,              -- индивидуальный период
    end_date    TEXT NOT NULL,
    PRIMARY KEY (trip_id, employee_id),
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_trips_dates ON trips (created_at);
CREATE INDEX IF NOT EXISTS idx_trip_participants_emp ON trip_participants (employee_id);

-- ----------------------------------------------------------------------------
-- trip_requests: очередь заявок RPA-роботу (relay-механизм E12-2, schema v8)
-- status: 'queued' | 'delivered' | 'created' | 'validation_error' | 'failed'
--   queued    — создана при confirm, ждёт poll робота
--   delivered — выдана роботу по GET (claimed_at), ждёт callback
--   created / validation_error / failed — финальные, выставляются callback POST
-- payload — JSON-контракт v1.2 (HelpMe), заморожен на момент confirm.
-- Токен робота: meta['rpa_relay_token'] (создаётся лениво в trip_relay.php).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_requests (
    request_id  TEXT PRIMARY KEY,           -- generateRequestId(): SC-xxxx-N-unixtime
    trip_id     TEXT NOT NULL,
    employee_id TEXT,
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued',
    ticket_id   TEXT,
    attempts    INTEGER DEFAULT 0,
    last_error  TEXT,
    created_at  TEXT,
    claimed_at  TEXT,
    done_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_trip_requests_status ON trip_requests (status);
CREATE INDEX IF NOT EXISTS idx_trip_requests_created_at ON trip_requests (created_at);

-- ----------------------------------------------------------------------------
-- Блок «Задачи» (T1-1, schema v9; в ТЗ значилось «v7», но v7/v8 заняты E12-1/E12-2)
-- tasks: задача. Время — локальное +05, ISO без смещения ('YYYY-MM-DD' или
--   'YYYY-MM-DDTHH:MM[:SS]'); срок без периода: end_at = NULL.
--   status: 'open' | 'closed' (закрывает только admin).
--   check_state: 'ok' | 'pending' — результат проверки FR-10 (pending = внешняя
--   проверка n8n недоступна, перепроверка по расписанию; T1-4).
--   version — optimistic concurrency (409 VERSION_CONFLICT). archived=1 — «удалена».
-- task_assignees: role 'assignee' (исполнитель) | 'watcher' (наблюдатель).
-- task_checklist: пункты чек-листа.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    description TEXT,
    start_at    TEXT NOT NULL,
    end_at      TEXT,
    priority    INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
    label       TEXT,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    check_state TEXT NOT NULL DEFAULT 'pending' CHECK (check_state IN ('ok','pending')),
    version     INTEGER NOT NULL DEFAULT 1,
    created_by  TEXT,
    created_at  TEXT,
    updated_at  TEXT,
    closed_at   TEXT,
    archived    INTEGER NOT NULL DEFAULT 0,
    links_text  TEXT   -- v14 (V9): поле «Связанные задачи» — свободный текст с токенами ((ID|название)); источник истины связей исходящей задачи
);
CREATE TABLE IF NOT EXISTS task_assignees (
    task_id     TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('assignee','watcher')),
    full_name_snapshot TEXT,   -- ФИО на момент назначения/переименования (для «исполнитель удалён»)
    PRIMARY KEY (task_id, employee_id, role),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    -- v10 (T1-7, D-1): БЕЗ FK на employees — удаление сотрудника не стирает назначение;
    -- «удалён» вычисляется при чтении (employee_id отсутствует в employees).
);
CREATE TABLE IF NOT EXISTS task_checklist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_start_at ON tasks (start_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_task_assignees_emp ON task_assignees (employee_id);
CREATE INDEX IF NOT EXISTS idx_task_checklist_task ON task_checklist (task_id);

-- task_occurrences (v12, V6.3-2, Д-1): повторы задачи — конкретные дата/время начала; конец =
--   начало + длительность задачи (пересчитывается при смене длительности/дат). Всё остальное
--   (тема, исполнители, статус…) общее с задачей. Удаление задачи каскадом удаляет повторы.
CREATE TABLE IF NOT EXISTS task_occurrences (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id  TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at   TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_occurrences_task ON task_occurrences (task_id);
CREATE INDEX IF NOT EXISTS idx_task_occurrences_start ON task_occurrences (start_at);

-- task_attachments (v13, V7): вложения задач — метаданные; файлы лежат в <каталог БД>/task_files/<stored_name>
--   (32 hex, без расширения; прямой веб-доступ закрыт). Отдача и права — api/task_files.php.
--   При архивации задачи вложения удаляются (записи и файлы).
CREATE TABLE IF NOT EXISTS task_attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    orig_name   TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    uploaded_by TEXT,
    uploaded_at TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments (task_id);

-- task_links (v14, V9): симметричная связь «Связанные задачи» — каноническая пара (task_a < task_b, побайтово).
--   Строка есть, пока хотя бы в одной из двух задач в tasks.links_text остался токен ((ID|название)) на другую.
--   Направление (исходящая/входящая) в таблице не хранится — вычисляется при чтении по токенам links_text.
--   Строки не удаляются при close/reopen/архиве задачи (архивная = перечёркнутая ссылка у обеих сторон).
CREATE TABLE IF NOT EXISTS task_links (
    task_a     TEXT NOT NULL,
    task_b     TEXT NOT NULL,
    created_at TEXT,
    created_by TEXT,
    PRIMARY KEY (task_a, task_b),
    CHECK (task_a < task_b),
    FOREIGN KEY (task_a) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (task_b) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_links_b ON task_links (task_b);

-- ============================================================================
-- Модуль «Транспорт» (schema v15, V10-T1). Только добавление (IF NOT EXISTS), порядок объявления — по FK.
-- Время — наивная локальная строка 'YYYY-MM-DDTHH:MM' (+05); длительности и стоянки кратны 15 минутам.
-- Ссылки на сотрудников (employee_id / driver_id / default_driver_id) — TEXT без FK на employees: удаление или
-- повторный импорт сотрудников (api/import.php, save.php) не должны стирать справочник/историю транспорта
-- (как task_assignees с v10); имя на момент действия — *_snap.
-- ============================================================================

-- transport_bases: базы ТС (заменяют «населённый пункт нахождения»); названия вносит admin через API.
CREATE TABLE IF NOT EXISTS transport_bases (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL UNIQUE,   -- регистронезависимая уникальность по-кириллице — проверка в API (SQLite NOCASE понимает только ASCII)
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
);

-- vehicles: транспортные средства. base_id меняется ТОЛЬКО действием move (постоянный перенос, журнал vehicle.move).
--   plate хранится нормализованным (верхний регистр, без пробелов). version — оптимистичная блокировка (409 VERSION_CONFLICT).
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

-- transport_driver_pool: сотрудники-совместители, имеющие право управлять ТС (вместе с группой «Транспорт» — допустимые водители).
CREATE TABLE IF NOT EXISTS transport_driver_pool (
    employee_id TEXT PRIMARY KEY NOT NULL,
    added_by    TEXT,
    added_at    TEXT
);

-- transport_requests: заявки на транспорт (API — фаза V10-B). created_by — users.id автора. display_no — сквозной номер.
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

-- transport_assignments: назначение ТС и водителя на заявку. end_at = start_at + duration_min (считает сервер).
--   override_json — подтверждённые предупреждения (не блокируют). driver_name_snap — ФИО водителя на момент назначения.
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

-- assignment_crew: бригада назначения (любые сотрудники; водитель в бригаду не входит — проверяет API).
CREATE TABLE IF NOT EXISTS assignment_crew (
    assignment_id TEXT NOT NULL,
    employee_id   TEXT NOT NULL,
    name_snap     TEXT,
    PRIMARY KEY (assignment_id, employee_id),
    FOREIGN KEY (assignment_id) REFERENCES transport_assignments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_assignment_crew_employee ON assignment_crew (employee_id);

-- assignment_stops: маршрут назначения. stay_min / leg_min / leg_min_map кратны 15 (leg_min_map — предложение карты, leg_min — принятое).
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

-- geo_cache: кэш ответов картографических сервисов (api/transport_geo.php — фаза V10-B).
CREATE TABLE IF NOT EXISTS geo_cache (
    key          TEXT PRIMARY KEY NOT NULL,
    kind         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    fetched_at   TEXT NOT NULL
);

-- transport_journal: журнал изменений модуля. APPEND-ONLY: UPDATE, DELETE и REPLACE существующего id запрещены триггерами (V10-T1b); очистка audit_log
--   (api/helpers.php audit_cleanup, api/db.php cleanupAuditLog — 7 дней) эту таблицу не затрагивает. Запись — в той же
--   транзакции, что и изменение (api/transport_lib.php transport_journal_write). ts — локальное время +05 с секундами.
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
-- V10-T1b: REPLACE / INSERT OR REPLACE с существующим id удаляет старую строку без вызова BEFORE DELETE (recursive_triggers=OFF)
--   и переписывает запись мимо двух триггеров выше. BEFORE INSERT с проверкой «такой id уже есть» закрывает обход (в т.ч. OR IGNORE
--   и ON CONFLICT DO UPDATE — вставка завершается ошибкой). NEW.id > 0: у вставки без id в BEFORE INSERT NEW.id = -1, поэтому
--   без этого условия строка с id = -1 блокировала бы все штатные вставки; id журнала (AUTOINCREMENT) всегда > 0.
--   DDL дословно совпадает с константой Database::TRANSPORT_JOURNAL_NO_REPLACE_SQL (api/db.php); сьют transportdb (M3, M5).
CREATE TRIGGER IF NOT EXISTS trg_transport_journal_no_replace BEFORE INSERT ON transport_journal
WHEN NEW.id > 0 AND EXISTS (SELECT 1 FROM transport_journal WHERE id = NEW.id)
BEGIN
    SELECT RAISE(ABORT, 'transport_journal is append-only');
END;
