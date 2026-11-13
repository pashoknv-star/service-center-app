-- ============================================================================
-- Service Center App — SQLite Schema
-- Version: 10
-- Tables: groups, positions, employees, schedule_entries, holidays,
--         vacation_balances, users, meta, sync_log, audit_log,
--         trips, trip_participants, trip_requests,
--         tasks, task_assignees, task_checklist
--           Блок «Задачи» (schema v9, T1-1; v10, T1-7: task_assignees без FK на employees)
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
    archived    INTEGER NOT NULL DEFAULT 0
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
