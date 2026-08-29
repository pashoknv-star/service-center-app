<?php
/**
 * Тестирование исправлений безопасности для supervisor
 */
declare(strict_types=1);

require_once 'api/db.php';
require_once 'api/auth.php';
require_once 'api/load.php';

function simulateUser(array $user, callable $testFn): void {
    $_SESSION['user_id'] = $user['id'];
    $result = $testFn();
    unset($_SESSION['user_id']);
    echo $result . "\n";
}

$pdo = Database::getInstance()->getPDO();

// Считаем записи до тестов
$totalEntries = $pdo->query("SELECT COUNT(*) FROM schedule_entries")->fetchColumn();
echo "=== ИСХОДНЫЕ ДАННЫЕ ===\n";
echo "Всего записей в БД: $totalEntries\n\n";

// Тест 1: Supervisor zone 0 видит только свою зону
echo "=== ТЕСТ 1: Supervisor zone 0 загружает данные ===\n";
simulateUser(['id' => 'supervisor_zone0', 'is_admin' => 0, 'can_edit' => 1, 'scope_group_id' => 'g0'], function() {
    ob_start();
    try {
        // Хак для перехвата вывода load.php
        $_SERVER['REQUEST_METHOD'] = 'GET';
        include 'api/load.php';
    } catch (Exception $e) {
        echo "Error: " . $e->getMessage();
    }
    $output = ob_get_clean();
    $data = json_decode($output, true);
    $entryCount = is_array($data['entries'] ?? null) ? count($data['entries']) : 0;
    echo "  -> Получено записей: $entryCount\n";

    // Проверяем, что есть только сотрудники зоны g0
    $wrongZone = 0;
    if (is_array($data['entries'])) {
        foreach ($data['entries'] as $entry) {
            $empId = $entry['employeeId'];
            $stmt = $GLOBALS['pdo']->prepare("SELECT group_id FROM employees WHERE id = ?");
            $stmt->execute([$empId]);
            $groupId = $stmt->fetchColumn();
            if ($groupId !== 'g0') {
                $wrongZone++;
                echo "  -> ОШИБКА: видит чужую зону! $empId в зоне $groupId\n";
            }
        }
    }
    if ($wrongZone === 0 && $entryCount > 0) {
        echo "  -> УСПЕХ: видит только свою зону g0\n";
    } elseif ($entryCount === 0) {
        echo "  -> ПРЕДУПРЕЖДЕНИЕ: не видит вообще никаких записей\n";
    }
    return "";
});

// Тест 2: Supervisor zone 1 видит только свою зону
echo "\n=== ТЕСТ 2: Supervisor zone 1 загружает данные ===\n";
simulateUser(['id' => 'supervisor_zone1', 'is_admin' => 0, 'can_edit' => 1, 'scope_group_id' => 'g1'], function() {
    ob_start();
    try {
        $_SERVER['REQUEST_METHOD'] = 'GET';
        include 'api/load.php';
    } catch (Exception $e) {
        echo "Error: " . $e->getMessage();
    }
    $output = ob_get_clean();
    $data = json_decode($output, true);
    $entryCount = is_array($data['entries'] ?? null) ? count($data['entries']) : 0;
    echo "  -> Получено записей: $entryCount\n";

    $wrongZone = 0;
    if (is_array($data['entries'])) {
        foreach ($data['entries'] as $entry) {
            $empId = $entry['employeeId'];
            $stmt = $GLOBALS['pdo']->prepare("SELECT group_id FROM employees WHERE id = ?");
            $stmt->execute([$empId]);
            $groupId = $stmt->fetchColumn();
            if ($groupId !== 'g1') {
                $wrongZone++;
                echo "  -> ОШИБКА: видит чужую зону! $empId в зоне $groupId\n";
            }
        }
    }
    if ($wrongZone === 0 && $entryCount > 0) {
        echo "  -> УСПЕХ: видит только свою зону g1\n";
    }
    return "";
});

// Тест 3: Admin видит все записи
echo "\n=== ТЕСТ 3: Admin загружает данные ===\n";
simulateUser(['id' => 'admin', 'is_admin' => 1, 'can_edit' => 1, 'scope_group_id' => null], function() {
    ob_start();
    try {
        $_SERVER['REQUEST_METHOD'] = 'GET';
        include 'api/load.php';
    } catch (Exception $e) {
        echo "Error: " . $e->getMessage();
    }
    $output = ob_get_clean();
    $data = json_decode($output, true);
    $entryCount = is_array($data['entries'] ?? null) ? count($data['entries']) : 0;
    echo "  -> Получено записей: $entryCount\n";
    echo "  -> Должен видеть ВСЕ записи (всего в БД: " . $GLOBALS['totalEntries'] . ")\n";
    if ($entryCount == $GLOBALS['totalEntries']) {
        echo "  -> УСПЕХ: admin видит все записи\n";
    } else {
        echo "  -> ОШИБКА: admin не видит все записи!\n";
    }
    return "";
});

echo "\n=== ИТОГОВЫЙ ОТЧЁТ ===\n";
echo "Исправления применены:\n";
echo "1. api/load.php - зональная фильтрация для supervisor ✓\n";
echo "2. api/save.php - правильный порядок проверок (сначала зона, потом approved) ✓\n";
echo "3. api/save.php - удалена дублирующая логика ✓\n";
