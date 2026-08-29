-- ============================================================================
-- Service Center App — SQLite Schema
-- Version: 5
-- Tables: groups, positions, employees, schedule_entries, holidays,
--         vacation_balances, users, meta, sync_log, audit_log
-- Features: E5-4 automatic audit_log cleanup (>7 days)
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
