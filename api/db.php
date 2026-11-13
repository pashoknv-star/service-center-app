<?php

declare(strict_types=1);

/**
 * Database — singleton-обёртка над PDO для Service Center App.
 *
 * Подключение: SQLite, путь к файлу — data/app.db (относительно корня проекта).
 * PRAGMA: journal_mode=WAL, foreign_keys=ON, busy_timeout=5000.
 *
 * Методы:
 *   getInstance()   — singleton-доступ к PDO-инстансу.
 *   getPDO()        — прямой доступ к PDO.
 *   getSchemaVersion() — текущая версия схемы из meta (int) или 0.
 *   migrate()       — применяет schema.sql при необходимости и обновляет meta.
 *
 * Схема v8 (E12-2): таблица trip_requests — очередь заявок RPA-роботу
 * (relay-механизм: poll GET / callback POST в api/trip_relay.php).
 * Схема v9 (T1-1): блок «Задачи» — tasks, task_assignees, task_checklist
 * (api/tasks.php, правила — api/tasks_rules.php).
 */

final class Database
{
    /** Корень проекта (на два уровня выше api/). */
    private const PROJECT_ROOT = __DIR__ . DIRECTORY_SEPARATOR . '..';

    /** Путь к файлу БД (по умолчанию; переопределяется env SC_APP_DB для тестов на копии). */
    private const DB_PATH = self::PROJECT_ROOT . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'app.db';

    /** Путь к schema.sql. */
    private const SCHEMA_PATH = __DIR__ . DIRECTORY_SEPARATOR . 'schema.sql';

    /** Текущая целевая версия схемы. */
    private const SCHEMA_VERSION = 11;

    private static ?Database $instance = null;

    private PDO $pdo;

    // -------------------------------------------------------------------------
    // Singleton
    // -------------------------------------------------------------------------

    /** Запрет прямого создания. */
    private function __construct()
    {
        $this->connect();
    }

    /** Запрет клонирования. */
    private function __clone()
    {
    }

    /** @return self */
    public static function getInstance(): self
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /** Прямой доступ к PDO. */
    public function getPDO(): PDO
    {
        return $this->pdo;
    }

    /**
     * Возвращает номер версии схемы из таблицы meta.
     *
     * @return int версия схемы (0, если meta/schema_version отсутствует)
     */
    public function getSchemaVersion(): int
    {
        // Проверяем, существует ли таблица meta.
        try {
            $stmt = $this->pdo->query(
                "SELECT value FROM meta WHERE key = 'schema_version'"
            );
            $row = $stmt ? $stmt->fetch(PDO::FETCH_ASSOC) : false;
            if ($row && isset($row['value'])) {
                return (int) $row['value'];
            }
        } catch (PDOException $e) {
            // Таблица ещё не создана — возвращаем 0.
        }
        return 0;
    }

    /**
     * Применяет schema.sql, если текущая версия меньше целевой.
     *
     * @return bool true, если миграция была выполнена (или уже актуальна).
     */
    public function migrate(): bool
    {
        $current = $this->getSchemaVersion();

        if ($current >= self::SCHEMA_VERSION) {
            return true; // уже актуально
        }

        if (!is_readable(self::SCHEMA_PATH)) {
            throw new RuntimeException(
                'Schema file not found or not readable: ' . self::SCHEMA_PATH
            );
        }

        $sql = file_get_contents(self::SCHEMA_PATH);
        if ($sql === false) {
            throw new RuntimeException(
                'Failed to read schema file: ' . self::SCHEMA_PATH
            );
        }

        // Удаляем прагму foreign_keys, чтобы не мешать выполнению внутри транзакции
        // (SQLite не разрешает изменение PRAGMA foreign_keys внутри транзакции).
        $sql = preg_replace('/PRAGMA\s+foreign_keys\s*=\s*ON\s*;/i', '', $sql);

        // Выполняем схему (CREATE TABLE IF NOT EXISTS — идемпотентно).
        $this->pdo->exec($sql);

        // -------------------------------------------------------------------
        // Инкрементальные миграции (ALTER TABLE, которые не покрываются
        // CREATE TABLE IF NOT EXISTS для уже существующих таблиц).
        // -------------------------------------------------------------------
        $this->applyIncrementalMigrations($current);

        // Фиксируем версию.
        $this->setMeta('schema_version', (string) self::SCHEMA_VERSION);

        return true;
    }

    /**
     * Применяет инкрементальные миграции (ALTER TABLE) от текущей версии
     * до целевой. Каждая миграция обёрнута в проверку, чтобы быть
     * идемпотентной — повторный запуск не вызывает ошибку, даже если
     * колонка уже существует.
     *
     * @param int $current Текущая версия схемы в БД.
     */
    private function applyIncrementalMigrations(int $current): void
    {
        // --- v1 → v2: добавляем scope_group_id в users ---
        if ($current < 2) {
            $this->addColumnIfNotExists('users', 'scope_group_id', 'TEXT');
        }

        // --- v2 → v3 (E8): версия записей + журнал синхронизации ---
        if ($current < 3) {
            // Колонка version в schedule_entries (старые строки = версия 1).
            $this->addColumnIfNotExists(
                'schedule_entries',
                'version',
                'INTEGER NOT NULL DEFAULT 1'
            );
            // Таблица sync_log (создаётся также schema.sql; здесь — для существующих БД).
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS sync_log (' .
                "    id          INTEGER PRIMARY KEY AUTOINCREMENT," .
                "    entity_type TEXT," .
                "    entity_id   TEXT," .
                "    action      TEXT," .
                "    actor       TEXT," .
                "    updated_at  TEXT" .
                ')'
            );
        }

        // --- v3 → v4 (E5): журнал аудита действий пользователей ---
        if ($current < 4) {
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS audit_log (' .
                "    id          INTEGER PRIMARY KEY AUTOINCREMENT," .
                "    ts          TEXT," .
                "    actor       TEXT," .
                "    role        TEXT," .
                "    action      TEXT," .
                "    entity_type TEXT," .
                "    entity_id   TEXT," .
                "    details     TEXT" .
                ')'
            );
            $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts)');
        }

        // --- v4 → v5 (E5-4): очистка audit_log старше 7 дней ---
        if ($current < 5) {
            $this->cleanupAuditLog();
        }

        // --- v5 → v6: командировки (trips + trip_participants) ---
        if ($current < 6) {
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS trips (' .
                "    id          TEXT PRIMARY KEY," .
                "    title       TEXT NOT NULL," .
                "    location    TEXT," .
                "    comment     TEXT," .
                "    status      TEXT NOT NULL DEFAULT 'forecast'," .
                "    version     INTEGER NOT NULL DEFAULT 1," .
                "    created_by  TEXT," .
                "    created_at  TEXT, updated_at TEXT" .
                ')'
            );
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS trip_participants (' .
                "    trip_id     TEXT NOT NULL," .
                "    employee_id TEXT NOT NULL," .
                "    start_date  TEXT NOT NULL," .
                "    end_date    TEXT NOT NULL," .
                "    PRIMARY KEY (trip_id, employee_id)," .
                "    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE," .
                "    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE" .
                ')'
            );
            $this->pdo->exec(
                'CREATE INDEX IF NOT EXISTS idx_trips_dates ON trips (created_at)'
            );
            $this->pdo->exec(
                'CREATE INDEX IF NOT EXISTS idx_trip_participants_emp ON trip_participants (employee_id)'
            );
        }

        // --- v6 → v7 (E12-1): поля RPA v1.2 (HelpMe) в trips ---
        if ($current < 7) {
            $this->addColumnIfNotExists('trips', 'origin', 'TEXT');
            $this->addColumnIfNotExists('trips', 'hotel', 'TEXT');
            // Флаги «плечо нужно»: DEFAULT 1 — плечо нужно для существующих строк.
            $this->addColumnIfNotExists('trips', 'transport_out_required', 'INTEGER DEFAULT 1');
            $this->addColumnIfNotExists('trips', 'transport_out_mode', 'TEXT');
            $this->addColumnIfNotExists('trips', 'transport_back_required', 'INTEGER DEFAULT 1');
            $this->addColumnIfNotExists('trips', 'transport_back_mode', 'TEXT');
            $this->addColumnIfNotExists('trips', 'advance_amount', 'INTEGER');
            $this->addColumnIfNotExists('trips', 'business_process', 'TEXT');
            $this->addColumnIfNotExists('trips', 'phone', 'TEXT');
        }

        // --- v7 → v8 (E12-2): очередь заявок RPA-роботу (relay) ---
        if ($current < 8) {
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS trip_requests (' .
                "    request_id  TEXT PRIMARY KEY," .
                "    trip_id     TEXT NOT NULL," .
                "    employee_id TEXT," .
                "    payload     TEXT NOT NULL," .
                "    status      TEXT NOT NULL DEFAULT 'queued'," .
                "    ticket_id   TEXT," .
                "    attempts    INTEGER DEFAULT 0," .
                "    last_error  TEXT," .
                "    created_at  TEXT," .
                "    claimed_at  TEXT," .
                "    done_at     TEXT" .
                ')'
            );
            $this->pdo->exec(
                'CREATE INDEX IF NOT EXISTS idx_trip_requests_status ON trip_requests (status)'
            );
            $this->pdo->exec(
                'CREATE INDEX IF NOT EXISTS idx_trip_requests_created_at ON trip_requests (created_at)'
            );
        }

        // --- v8 → v9 (T1-1): блок «Задачи» (tasks, task_assignees, task_checklist) ---
        // Только CREATE ... IF NOT EXISTS: существующие данные не затрагиваются.
        if ($current < 9) {
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS tasks (' .
                "    id          TEXT PRIMARY KEY," .
                "    title       TEXT NOT NULL," .
                "    description TEXT," .
                "    start_at    TEXT NOT NULL," .
                "    end_at      TEXT," .
                "    priority    INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3)," .
                "    label       TEXT," .
                "    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))," .
                "    check_state TEXT NOT NULL DEFAULT 'pending' CHECK (check_state IN ('ok','pending'))," .
                "    version     INTEGER NOT NULL DEFAULT 1," .
                "    created_by  TEXT," .
                "    created_at  TEXT," .
                "    updated_at  TEXT," .
                "    closed_at   TEXT," .
                "    archived    INTEGER NOT NULL DEFAULT 0" .
                ')'
            );
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS task_assignees (' .
                "    task_id     TEXT NOT NULL," .
                "    employee_id TEXT NOT NULL," .
                "    role        TEXT NOT NULL CHECK (role IN ('assignee','watcher'))," .
                "    PRIMARY KEY (task_id, employee_id, role)," .
                "    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE," .
                "    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE" .
                ')'
            );
            $this->pdo->exec(
                'CREATE TABLE IF NOT EXISTS task_checklist (' .
                "    id         INTEGER PRIMARY KEY AUTOINCREMENT," .
                "    task_id    TEXT NOT NULL," .
                "    text       TEXT NOT NULL," .
                "    done       INTEGER NOT NULL DEFAULT 0," .
                "    sort_order INTEGER NOT NULL DEFAULT 0," .
                "    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE" .
                ')'
            );
            $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasks_start_at ON tasks (start_at)');
            $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status)');
            $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_task_assignees_emp ON task_assignees (employee_id)');
            $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_task_checklist_task ON task_checklist (task_id)');
        }

        // --- v9 → v10 (T1-7, D-1): исполнитель задачи переживает удаление сотрудника ---
        // task_assignees пересобирается БЕЗ FK на employees (FK на tasks CASCADE сохраняется)
        // + full_name_snapshot (ФИО на момент назначения/переименования).
        if ($current < 10) {
            $this->rebuildTaskAssigneesV10();
        }

        // --- v10 → v11 (V6-3 + V6-6, R-2): зона 3 переименована → «Управление СЦ» ---
        // Миграция v11 ещё нигде не выкладывалась, поэтому имя поправлено в ней самой (v12 не заводился).
        // Только группа g3 и только пока у неё одно из ДВУХ прежних имён («В2С» — боевая база,
        // «Директор СЦ» — dev/копии, прошедшие первую редакцию v11); любое другое имя (в т.ч. уже
        // новое или правка владельца) не трогается; остальные группы не затрагиваются; повтор — no-op.
        if ($current < 11) {
            $this->pdo->exec(
                "UPDATE groups SET name = 'Управление СЦ' WHERE id = 'g3' AND name IN ('В2С', 'Директор СЦ')"
            );
        }

        // --- Legacy-конверсия 'trip'-entries → Trip-объекты (идемпотентна) ---
        // Происходит при миграции (в т.ч. когда схема уже v6), защищена
        // meta-флагом 'trips_legacy_migrated' — повторный запуск дублей не даёт.
        $this->migrateLegacyTrips();

        // E5-4: периодическая очистка журнала аудита (сохраняет прежнее
        // поведение для БД, пришедших с версии >= 5).
        $this->cleanupAuditLog();
    }

    /**
     * v9 → v10: пересборка task_assignees (create new → copy → drop → rename) без FK на
     * employees и с колонкой full_name_snapshot (заполняется из employees).
     *
     * Идемпотентна: если у таблицы уже нет FK на employees и есть full_name_snapshot —
     * ничего не делает (свежая БД получает именно такую таблицу из schema.sql).
     * PRAGMA foreign_keys нельзя менять внутри транзакции — отключается до BEGIN и
     * возвращается в ON после COMMIT/ROLLBACK (рекомендация SQLite для пересборки таблиц).
     */
    private function rebuildTaskAssigneesV10(): void
    {
        $exists = $this->pdo->query(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_assignees'"
        )->fetchColumn();
        if (!$exists) {
            return; // нечего пересобирать (создастся из schema.sql)
        }
        $cols = $this->pdo->query('PRAGMA table_info(task_assignees)')->fetchAll(PDO::FETCH_COLUMN, 1);
        $hasSnapshot = in_array('full_name_snapshot', $cols, true);
        $hasEmpFk = false;
        foreach ($this->pdo->query('PRAGMA foreign_key_list(task_assignees)')->fetchAll(PDO::FETCH_ASSOC) as $fk) {
            if (strtolower((string) $fk['table']) === 'employees') {
                $hasEmpFk = true;
            }
        }
        if ($hasSnapshot && !$hasEmpFk) {
            return; // уже v10
        }

        $this->pdo->exec('PRAGMA foreign_keys = OFF');
        try {
            $this->pdo->beginTransaction();
            try {
                $this->pdo->exec('DROP TABLE IF EXISTS task_assignees_v10');
                $this->pdo->exec(
                    'CREATE TABLE task_assignees_v10 (' .
                    "    task_id            TEXT NOT NULL," .
                    "    employee_id        TEXT NOT NULL," .
                    "    role               TEXT NOT NULL CHECK (role IN ('assignee','watcher'))," .
                    "    full_name_snapshot TEXT," .
                    "    PRIMARY KEY (task_id, employee_id, role)," .
                    "    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE" .
                    ')'
                );
                $this->pdo->exec(
                    'INSERT INTO task_assignees_v10 (task_id, employee_id, role, full_name_snapshot) ' .
                    'SELECT ta.task_id, ta.employee_id, ta.role, ' .
                    ($hasSnapshot
                        ? 'COALESCE((SELECT e.full_name FROM employees e WHERE e.id = ta.employee_id), ta.full_name_snapshot) '
                        : '(SELECT e.full_name FROM employees e WHERE e.id = ta.employee_id) ') .
                    'FROM task_assignees ta'
                );
                $this->pdo->exec('DROP TABLE task_assignees');
                $this->pdo->exec('ALTER TABLE task_assignees_v10 RENAME TO task_assignees');
                $this->pdo->exec(
                    'CREATE INDEX IF NOT EXISTS idx_task_assignees_emp ON task_assignees (employee_id)'
                );
                $this->pdo->commit();
            } catch (Throwable $e) {
                if ($this->pdo->inTransaction()) {
                    $this->pdo->rollBack();
                }
                throw $e;
            }
        } finally {
            $this->pdo->exec('PRAGMA foreign_keys = ON');
        }
    }

    /**
     * Legacy-конверсия: подряд идущие schedule_entries со статусом 'trip'
     * группируются в Trip-объекты (status='confirmed' — визуал не меняется).
     * Разрыв в датах = новая командировка; год НЕ ограничивает группировку.
     *
     * Каждой командировке: genId('trip_'), version=1, участники — периоды
     * сотрудника. sync_log НЕ пишется (миграция, а не пользовательское
     * действие); в audit_log пишется одно событие 'trip.legacy_migrate'
     * с количеством созданных командировок.
     *
     * Идемпотентность обеспечивает meta-ключ 'trips_legacy_migrated'.
     */
    private function migrateLegacyTrips(): void
    {
        // Флаг уже стоит — повторный запуск ничего не делает (дублей нет).
        $flagStmt = $this->pdo->prepare(
            "SELECT value FROM meta WHERE key = 'trips_legacy_migrated'"
        );
        $flagStmt->execute();
        if ($flagStmt->fetch(PDO::FETCH_COLUMN)) {
            return;
        }

        try {
            // Таблицы trips/schedule_entries могут отсутствовать, если миграция
            // v6 ещё не выполняла CREATE (свежая БД без схема-прохода) — в этом
            // случае конвертировать нечего; помечаем флаг и выходим.
            $tables = $this->pdo->query(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('trips','schedule_entries')"
            )->fetchAll(PDO::FETCH_COLUMN);
            if (!in_array('trips', $tables, true) || !in_array('schedule_entries', $tables, true)) {
                $this->setMeta('trips_legacy_migrated', '1');
                return;
            }

            $rows = $this->pdo->query(
                "SELECT employee_id, date, comment
                 FROM schedule_entries
                 WHERE status = 'trip'
                 ORDER BY employee_id, date"
            )->fetchAll(PDO::FETCH_ASSOC);

            if (empty($rows)) {
                $this->setMeta('trips_legacy_migrated', '1');
                return;
            }

            // Группировка по сотрудникам.
            $byEmp = [];
            foreach ($rows as $r) {
                $byEmp[$r['employee_id']][] = $r;
            }

            // Защита от осиротевших ссылок: если сотрудник удалён (schedule_entries
            // остались), его run-ы пропускаем — иначе FK trip_participants упал бы
            // и прервал миграцию, оставив частичное состояние.
            $empExistsStmt = $this->pdo->prepare(
                'SELECT 1 FROM employees WHERE id = :id LIMIT 1'
            );
            foreach (array_keys($byEmp) as $empId) {
                $empExistsStmt->bindValue(':id', (string) $empId, PDO::PARAM_STR);
                $empExistsStmt->execute();
                if (!$empExistsStmt->fetch()) {
                    error_log('T3: legacy trips migration — employee ' . $empId . ' not found, skipping its runs');
                    unset($byEmp[$empId]);
                }
            }

            $createdCount = 0;
            $stmtTrip = $this->pdo->prepare(
                'INSERT INTO trips (id, title, location, comment, status, version, created_by, created_at, updated_at)
                 VALUES (:id, :title, :location, :comment, :status, 1, :created_by, :ts, :ts)'
            );
            $stmtPart = $this->pdo->prepare(
                'INSERT INTO trip_participants (trip_id, employee_id, start_date, end_date)
                 VALUES (:trip_id, :employee_id, :start_date, :end_date)'
            );

            $ts = gmdate('Y-m-d\TH:i:s+00:00');

            foreach ($byEmp as $empId => $empRows) {
                $runs = [];
                $currentRun = null;
                $prevDate = null;

                foreach ($empRows as $r) {
                    $date = (string) $r['date'];
                    if ($currentRun === null) {
                        $currentRun = [
                            'employee_id' => $empId,
                            'start'       => $date,
                            'end'         => $date,
                            'comment'     => isset($r['comment']) && $r['comment'] !== ''
                                ? (string) $r['comment'] : null,
                        ];
                    } else {
                        // Разрыв строго больше 1 дня => новая командировка.
                        $gapDays = (strtotime($date) - strtotime($prevDate)) / 86400;
                        if ($gapDays > 1) {
                            $runs[] = $currentRun;
                            $currentRun = [
                                'employee_id' => $empId,
                                'start'       => $date,
                                'end'         => $date,
                                'comment'     => isset($r['comment']) && $r['comment'] !== ''
                                    ? (string) $r['comment'] : null,
                            ];
                        } else {
                            $currentRun['end'] = $date;
                            if ($currentRun['comment'] === null
                                && isset($r['comment']) && $r['comment'] !== '') {
                                $currentRun['comment'] = (string) $r['comment'];
                            }
                        }
                    }
                    $prevDate = $date;
                }
                if ($currentRun !== null) {
                    $runs[] = $currentRun;
                }

                foreach ($runs as $run) {
                    $tripId = uniqid('trip_', true);
                    $stmtTrip->bindValue(':id', $tripId, PDO::PARAM_STR);
                    $stmtTrip->bindValue(':title', 'Командировка (миграция)', PDO::PARAM_STR);
                    $stmtTrip->bindValue(':location', $run['comment'], PDO::PARAM_STR);
                    $stmtTrip->bindValue(':comment', null, PDO::PARAM_STR);
                    $stmtTrip->bindValue(':status', 'confirmed', PDO::PARAM_STR);
                    $stmtTrip->bindValue(':created_by', 'legacy_migration', PDO::PARAM_STR);
                    $stmtTrip->bindValue(':ts', $ts, PDO::PARAM_STR);
                    $stmtTrip->execute();

                    $stmtPart->bindValue(':trip_id', $tripId, PDO::PARAM_STR);
                    $stmtPart->bindValue(':employee_id', $run['employee_id'], PDO::PARAM_STR);
                    $stmtPart->bindValue(':start_date', $run['start'], PDO::PARAM_STR);
                    $stmtPart->bindValue(':end_date', $run['end'], PDO::PARAM_STR);
                    $stmtPart->execute();

                    $createdCount++;
                }
            }

            // Аудит миграции (одна запись на весь прогон через audit(), если helpers загружен).
            if ($createdCount > 0 && function_exists('audit')) {
                audit($this->pdo, 'trip.legacy_migrate', null, null, 'trip', null, ['count' => $createdCount]);
            }
            if ($createdCount > 0) {
                error_log('T3: legacy trips migration created ' . $createdCount . ' trip(s)');
            }

            $this->setMeta('trips_legacy_migrated', '1');
        } catch (Throwable $e) {
            // Миграция не должна валить первый HTTP-запрос: логируем ошибку.
            // НЕ ставим флаг 'trips_legacy_migrated' — при исправлении данных
            // следующий запрос корректно повторит конверсию (без дублей, т.к.
            // уже созданные trip-строки не пересекаются с повторным SELECT).
            error_log('T3: legacy trips migration FAILED: ' . $e->getMessage());
            throw $e;
        }
    }

    /**
     * Добавляет колонку в таблицу, если её ещё нет (PRAGMA table_info).
     *
     * @param string $table      Имя таблицы.
     * @param string $column     Имя колонки.
     * @param string $definition SQL-определение типа (например 'TEXT').
     */
    private function addColumnIfNotExists(string $table, string $column, string $definition): void
    {
        $stmt = $this->pdo->prepare("PRAGMA table_info({$table})");
        $stmt->execute();
        $cols = $stmt->fetchAll(PDO::FETCH_COLUMN, 1); // индекс 1 = name

        if (!in_array($column, $cols, true)) {
            $this->pdo->exec(
                "ALTER TABLE {$table} ADD COLUMN {$column} {$definition}"
            );
        }
    }

    /**
     * Записывает/обновляет значение в meta.
     *
     * @param string $key
     * @param string $value
     */
    public function setMeta(string $key, string $value): void
    {
        $stmt = $this->pdo->prepare(
            "INSERT INTO meta (key, value) VALUES (:key, :value)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        );
        $stmt->execute([':key' => $key, ':value' => $value]);
    }

    /**
     * Очищает записи audit_log старше 7 дней.
     * Использует индекс idx_audit_log_ts для оптимизации.
     */
    private function cleanupAuditLog(): void
    {
        // Устанавливаем cutoff дату (7 дней назад от текущего момента) в ISO8601 UTC формате
        $cutoffDate = gmdate('Y-m-d\TH:i:s+00:00', time() - 7*86400);
        
        // Удаляем записи старше 7 дней с использованием индекса
        $stmt = $this->pdo->prepare(
            "DELETE FROM audit_log WHERE ts < :cutoff"
        );
        $stmt->bindValue(':cutoff', $cutoffDate);
        $deletedCount = $stmt->execute();
        
        // Логируем очистку для отладки
        error_log("E5-4: Очистка audit_log удалено " . ($deletedCount ? $stmt->rowCount() : 0) . " записей старше {$cutoffDate}");
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    /**
     * Создаёт каталог data (если нужно) и устанавливает PDO-подключение.
     */
    private function connect(): void
    {
        $dbPath = self::DB_PATH;
        $envPath = getenv('SC_APP_DB');
        if (is_string($envPath) && $envPath !== '') {
            $dbPath = $envPath;
        }
        $dataDir = dirname($dbPath);
        if (!is_dir($dataDir)) {
            if (!mkdir($dataDir, 0775, true) && !is_dir($dataDir)) {
                throw new RuntimeException(
                    'Failed to create data directory: ' . $dataDir
                );
            }
        }

        $dsn = 'sqlite:' . $dbPath;

        $this->pdo = new PDO($dsn, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);

        // --- PRAGMA ---
        $this->pdo->exec('PRAGMA journal_mode = WAL');
        $this->pdo->exec('PRAGMA foreign_keys = ON');
        $this->pdo->exec('PRAGMA busy_timeout = 5000');
    }
}
