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
 */

final class Database
{
    /** Корень проекта (на два уровня выше api/). */
    private const PROJECT_ROOT = __DIR__ . DIRECTORY_SEPARATOR . '..';

    /** Путь к файлу БД. */
    private const DB_PATH = self::PROJECT_ROOT . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'app.db';

    /** Путь к schema.sql. */
    private const SCHEMA_PATH = __DIR__ . DIRECTORY_SEPARATOR . 'schema.sql';

    /** Текущая целевая версия схемы. */
    private const SCHEMA_VERSION = 5;

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
        $dataDir = dirname(self::DB_PATH);
        if (!is_dir($dataDir)) {
            if (!mkdir($dataDir, 0775, true) && !is_dir($dataDir)) {
                throw new RuntimeException(
                    'Failed to create data directory: ' . $dataDir
                );
            }
        }

        $dsn = 'sqlite:' . self::DB_PATH;

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
