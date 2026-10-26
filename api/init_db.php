<?php

declare(strict_types=1);

// HF-2 (S-06/A-07): служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * init_db.php — CLI-инициализация БД Service Center App.
 *
 * Что делает:
 *   1. Подключается к data/app.db (создаёт файл при необходимости).
 *   2. Применяет schema.sql (создаёт все таблицы).
 *   3. Записывает schema_version = 1 в meta.
 *   4. Создаёт администратора по умолчанию (admin / changeme), если его ещё нет.
 *
 * Запуск:  php api/init_db.php
 */

require_once __DIR__ . DIRECTORY_SEPARATOR . 'db.php';
require_once __DIR__ . DIRECTORY_SEPARATOR . 'seed_positions.php';

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script must be run from CLI.\n");
    exit(1);
}

echo "=== Service Center App — DB initialization ===\n";

// --------------------------------------------------------------------
// 1. Подключение и миграция
// --------------------------------------------------------------------
try {
    $db = Database::getInstance();
    echo "Connected to database.\n";

    $db->migrate();
    echo "Schema applied (or already up to date).\n";

    $version = $db->getSchemaVersion();
    echo "Current schema version: {$version}\n";
} catch (Throwable $e) {
    fwrite(STDERR, "ERROR during migration: " . $e->getMessage() . "\n");
    exit(1);
}

// --------------------------------------------------------------------
// 2. Создание пользователей по умолчанию (admin + 2 supervisor)
// --------------------------------------------------------------------
try {
    $pdo = $db->getPDO();

    // --- 2a. admin ---
    $stmt = $pdo->prepare("SELECT id FROM users WHERE username = :username");
    $stmt->execute([':username' => 'admin']);
    $exists = $stmt->fetch();

    if ($exists) {
        echo "Default admin user already exists — skipping.\n";
    } else {
        $id           = 'admin';
        $passwordHash = password_hash('changeme', PASSWORD_DEFAULT);
        $displayName  = 'Administrator';

        $insert = $pdo->prepare(
            "INSERT INTO users (id, username, password_hash, display_name, can_edit, is_admin, scope_group_id)
             VALUES (:id, :username, :password_hash, :display_name, 1, 1, NULL)"
        );
        $insert->execute([
            ':id'            => $id,
            ':username'      => 'admin',
            ':password_hash' => $passwordHash,
            ':display_name'  => $displayName,
        ]);

        echo "Default admin user created (username: admin, password: changeme).\n";
    }

    // --- 2b. Определяем scope_group_id для supervisors из существующих групп ---
    $scope0 = null;
    $scope1 = null;

    // Группа с sort_order = 0
    $stmt = $pdo->prepare("SELECT id FROM groups WHERE sort_order = 0 ORDER BY id LIMIT 1");
    $stmt->execute();
    $g0 = $stmt->fetch();
    if ($g0) {
        $scope0 = $g0['id'];
    } elseif (getenv('FORCE_SCOPE_IDS')) {
        // Если групп ещё нет, используем g0 как идентификатор-заглушку.
        $scope0 = 'g0';
    }

    // Группа с sort_order = 1
    $stmt = $pdo->prepare("SELECT id FROM groups WHERE sort_order = 1 ORDER BY id LIMIT 1");
    $stmt->execute();
    $g1 = $stmt->fetch();
    if ($g1) {
        $scope1 = $g1['id'];
    } elseif (getenv('FORCE_SCOPE_IDS')) {
        $scope1 = 'g1';
    }

    // --- 2c. supervisor_zone0 ---
    $supervisors = [
        [
            'id'             => 'supervisor_zone0',
            'username'       => 'supervisor_zone0',
            'display_name'   => 'Руководитель зоны 0',
            'scope_group_id' => $scope0 ?? 'g0',
        ],
        [
            'id'             => 'supervisor_zone1',
            'username'       => 'supervisor_zone1',
            'display_name'   => 'Ведущий инженер зоны 1',
            'scope_group_id' => $scope1 ?? 'g1',
        ],
    ];

    $checkStmt  = $pdo->prepare("SELECT id FROM users WHERE username = :username");
    $insertStmt = $pdo->prepare(
        "INSERT INTO users (id, username, password_hash, display_name, can_edit, is_admin, scope_group_id)
         VALUES (:id, :username, :password_hash, :display_name, 1, 0, :scope_group_id)"
    );

    $supervisorHash = password_hash('changeme', PASSWORD_DEFAULT);

    foreach ($supervisors as $sv) {
        $checkStmt->execute([':username' => $sv['username']]);
        if ($checkStmt->fetch()) {
            echo "User '{$sv['username']}' already exists — skipping.\n";
            continue;
        }

        // Если группы не найдены, scope_group_id = NULL (норма по ТЗ).
        $scopeVal = ($sv['scope_group_id'] === 'g0' || $sv['scope_group_id'] === 'g1')
            ? null
            : $sv['scope_group_id'];

        $insertStmt->execute([
            ':id'             => $sv['id'],
            ':username'       => $sv['username'],
            ':password_hash'  => $supervisorHash,
            ':display_name'   => $sv['display_name'],
            ':scope_group_id' => $scopeVal,
        ]);

        $label = $scopeVal ?? 'NULL (no group yet)';
        echo "Supervisor user '{$sv['username']}' created (scope_group_id: {$label}).\n";
    }
} catch (Throwable $e) {
    fwrite(STDERR, "ERROR creating users: " . $e->getMessage() . "\n");
    exit(1);
}

// --------------------------------------------------------------------
// 3. Заполнение справочника должностей по умолчанию (идемпотентно)
// --------------------------------------------------------------------
try {
    $result = seedDefaultPositions($pdo);
    if ($result['existing'] > 0 && $result['inserted'] === 0) {
        echo "Positions already populated ({$result['existing']} records) — skipping.\n";
    } else {
        echo "Seeded {$result['inserted']} default positions.\n";
    }
} catch (Throwable $e) {
    fwrite(STDERR, "ERROR seeding positions: " . $e->getMessage() . "\n");
    exit(1);
}

// --------------------------------------------------------------------
// 4. external_api_token (генерируется один раз для внешнего API)
// --------------------------------------------------------------------
try {
    $stmt = $pdo->prepare("SELECT value FROM meta WHERE key = 'external_api_token'");
    $stmt->execute();
    $existing = $stmt->fetch();

    if ($existing && !empty($existing['value'])) {
        echo "External API token already exists (skipped). Use it as: Bearer <token>\n";
    } else {
        // 64-символьный токен: 32 случайных байта → bin2hex.
        $token = bin2hex(random_bytes(32));
        $db->setMeta('external_api_token', $token);
        echo "External API token generated (used by vacation_import.php):\n";
        echo "  Token: {$token}\n";
        echo "  Authorization: Bearer {$token}\n";
    }
} catch (Throwable $e) {
    fwrite(STDERR, "ERROR generating external_api_token: " . $e->getMessage() . "\n");
    exit(1);
}

// --------------------------------------------------------------------
// 5. Отчёт о созданных таблицах
// --------------------------------------------------------------------
echo "\n";
echo "Tables in database:\n";
$tables = $pdo->query(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
)->fetchAll(PDO::FETCH_COLUMN);

foreach ($tables as $t) {
    echo "  - {$t}\n";
}

echo "\n=== Done ===\n";
exit(0);
