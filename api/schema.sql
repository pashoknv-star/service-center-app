-- ============================================================================
-- Service Center App — SQLite Schema
-- Version: 7
-- Tables: groups, positions, employees, schedule_entries, holidays,
--         vacation_balances, users, meta, sync_log, audit_log,
--         trips, trip_participants
-- Features: E5-4 automatic audit_log cleanup (>7 days)
--           Business trips (trips + trip_participants, schema v6)
--           RPA v1.2 (HelpMe) fields on trips (schema v7, E12-1)
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
