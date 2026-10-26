<?php

declare(strict_types=1);

// HF-2 (S-06/A-07): служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * seed_positions.php — CLI-заполнение справочника должностей по умолчанию.
 *
 * Что делает:
 *   1. Подключается к data/app.db.
 *   2. Применяет схему (на случай, если БД ещё не инициализирована).
 *   3. Если таблица positions пуста — заполняет её 12 должностями по умолчанию.
 *   4. Если уже есть записи — пропускает (идемпотентно).
 *
 * Запуск:  php api/seed_positions.php
 *
 * Функция seedDefaultPositions() экспортируется для повторного использования
 * из init_db.php (через require_once).
 */

require_once __DIR__ . DIRECTORY_SEPARATOR . 'db.php';

/**
 * Справочник должностей по умолчанию.
 *
 * Основан на анализе существующих данных проекта.
 * Ключи — фиксированные идентификаторы (id), значения — [name, sort_order].
 *
 * @var array<string, array{0:string, 1:int}>
 */
const DEFAULT_POSITIONS = [
    'pos_master'      => ['Мастер',                  0],
    'pos_ingener'     => ['Инженер',                 1],
    'pos_ved_ingener' => ['Ведущий инженер',         2],
    'pos_rukovoditel' => ['Руководитель направления', 3],
    'pos_spec'        => ['Специалист',              4],
    'pos_tehnik'      => ['Техник',                  5],
    'pos_operator'    => ['Оператор',                6],
    'pos_dispetcher'  => ['Диспетчер',               7],
    'pos_kladovwik'   => ['Кладовщик',               8],
    'pos_voditel'     => ['Водитель',                9],
    'pos_energetik'   => ['Энергетик',               10],
    'pos_stazher'     => ['Стажёр',                  11],
];

/**
 * Заполняет таблицу positions значениями по умолчанию (идемпотентно).
 *
 * Логика:
 *   - Если в positions уже есть ХОТЯ БЫ ОДНА запись — считаем, что справочник
 *     уже заполнен, ничего не делаем (идемпотентность на уровне таблицы).
 *   - Если таблица пуста — вставляем все записи из DEFAULT_POSITIONS.
 *   - Конфликты PRIMARY KEY обрабатываем через INSERT OR IGNORE на случай
 *     гонки/частичного заполнения — дубликаты не возникнут.
 *
 * @param PDO $pdo  Подключение к БД.
 *
 * @return array{inserted:int, existing:int} Сколько добавлено / сколько уже было.
 */
function seedDefaultPositions(PDO $pdo): array
{
    // Текущее количество записей в таблице.
    $countStmt = $pdo->query('SELECT COUNT(*) FROM positions');
    $existing  = $countStmt ? (int) $countStmt->fetchColumn() : 0;

    $inserted = 0;

    $stmt = $pdo->prepare(
        'INSERT OR IGNORE INTO positions (id, name, sort_order)
         VALUES (:id, :name, :sort_order)'
    );

    foreach (DEFAULT_POSITIONS as $id => [$name, $sortOrder]) {
        $stmt->bindValue(':id',         $id,        PDO::PARAM_STR);
        $stmt->bindValue(':name',       $name,      PDO::PARAM_STR);
        $stmt->bindValue(':sort_order', $sortOrder, PDO::PARAM_INT);
        $stmt->execute();
        if ($stmt->rowCount() > 0) {
            $inserted++;
        }
    }

    return ['inserted' => $inserted, 'existing' => $existing];
}

// =========================================================================
// CLI-точка входа (выполняется только при прямом запуске скрипта).
// =========================================================================
if (PHP_SAPI === 'cli' && realpath(__FILE__) === realpath($_SERVER['SCRIPT_FILENAME'] ?? '')) {
    echo "=== Service Center App — Seed positions ===\n";

    try {
        $db  = Database::getInstance();
        $pdo = $db->getPDO();

        // Гарантируем наличие таблицы positions.
        $db->migrate();

        $result = seedDefaultPositions($pdo);

        if ($result['existing'] > 0 && $result['inserted'] === 0) {
            echo "Positions already populated ({$result['existing']} records) — nothing to do.\n";
        } elseif ($result['existing'] === 0) {
            echo "Inserted {$result['inserted']} default positions (table was empty).\n";
        } else {
            echo "Inserted {$result['inserted']} positions; {$result['existing']} already existed.\n";
        }

        // Финальная сводка.
        $total = $pdo->query('SELECT COUNT(*) FROM positions')->fetchColumn();
        echo "Total positions now: {$total}\n";
        echo "=== Done ===\n";
        exit(0);
    } catch (Throwable $e) {
        fwrite(STDERR, "ERROR: " . $e->getMessage() . "\n");
        exit(1);
    }
}
