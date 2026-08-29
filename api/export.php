<?php

declare(strict_types=1);

/**
 * api/export.php — GET: полный JSON backup состояния (ScheduleState).
 *
 * Фаза 8 (часть A): Export JSON backup.
 *
 * Доступен всем залогиненным (включая viewer) — экспорт не меняет данные.
 *
 * Параметры:
 *   ?download=1  — отдать как вложение с именем
 *                   service-center-backup-YYYY-MM-DD.json
 *
 * Возвращает:
 *   { version, year, groups, positions, employees, entries, holidays,
 *     vacationBalances, exportedAt }
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();
requireMethod('GET');
require_auth();

try {
    $db  = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    // --- groups ---
    $groups = [];
    foreach ($pdo->query('SELECT id, name, sort_order FROM groups ORDER BY sort_order, name')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $groups[] = [
            'id'        => $row['id'],
            'name'      => $row['name'],
            'sortOrder' => $row['sort_order'] !== null ? (int) $row['sort_order'] : null,
        ];
    }

    // --- positions ---
    $positions = [];
    foreach ($pdo->query('SELECT id, name, sort_order FROM positions ORDER BY sort_order, name')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $positions[] = [
            'id'        => $row['id'],
            'name'      => $row['name'],
            'sortOrder' => $row['sort_order'] !== null ? (int) $row['sort_order'] : null,
        ];
    }

    // --- employees ---
    $employees = [];
    foreach ($pdo->query(
        'SELECT id, full_name, position_id, location, group_id, phone, photo_url,
                is_technical, requires_full_profile, sort_order, created_at, updated_at
         FROM employees
         ORDER BY sort_order, full_name'
    )->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $employees[] = [
            'id'                  => $row['id'],
            'fullName'            => $row['full_name'],
            'positionId'          => $row['position_id'],
            'location'            => $row['location'],
            'groupId'             => $row['group_id'],
            'phone'               => $row['phone'],
            'photoUrl'            => $row['photo_url'],
            'isTechnical'         => !empty($row['is_technical']),
            'requiresFullProfile' => !empty($row['requires_full_profile']),
            'sortOrder'           => $row['sort_order'] !== null ? (int) $row['sort_order'] : null,
            'createdAt'           => $row['created_at'],
            'updatedAt'           => $row['updated_at'],
        ];
    }

    // --- entries (ключ "employeeId:date") ---
    $entries = [];
    foreach ($pdo->query('SELECT employee_id, date, status, comment, approval_status, updated_at FROM schedule_entries')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $entries[$row['employee_id'] . ':' . $row['date']] = [
            'employeeId'     => $row['employee_id'],
            'date'           => $row['date'],
            'status'         => $row['status'],
            'comment'        => $row['comment'],
            'approvalStatus' => $row['approval_status'],
            'updatedAt'      => $row['updated_at'],
        ];
    }

    // --- holidays (ключ "date") ---
    $holidays = [];
    foreach ($pdo->query('SELECT date, type, label FROM holidays ORDER BY date')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $holidays[$row['date']] = [
            'date'  => $row['date'],
            'type'  => $row['type'],
            'label' => $row['label'],
        ];
    }

    // --- vacationBalances (ключ "employeeId:year") ---
    $vacationBalances = [];
    foreach ($pdo->query('SELECT employee_id, year, total_days, used_days, remaining_days FROM vacation_balances')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $vacationBalances[$row['employee_id'] . ':' . $row['year']] = [
            'employeeId'    => $row['employee_id'],
            'year'          => (int) $row['year'],
            'totalDays'     => $row['total_days'] !== null ? (float) $row['total_days'] : null,
            'usedDays'      => $row['used_days'] !== null ? (float) $row['used_days'] : null,
            'remainingDays' => $row['remaining_days'] !== null ? (float) $row['remaining_days'] : null,
        ];
    }

    // --- year (meta) ---
    $yearStmt = $pdo->prepare("SELECT value FROM meta WHERE key = 'current_year'");
    $yearStmt->execute();
    $yearRow = $yearStmt->fetch();
    $year = $yearRow ? (int) $yearRow['value'] : 2026;

    $payload = [
        'version'          => 1,
        'year'             => $year,
        'groups'           => $groups,
        'positions'        => $positions,
        'employees'        => $employees,
        'entries'          => (object) $entries,
        'holidays'         => (object) $holidays,
        'vacationBalances' => (object) $vacationBalances,
        'exportedAt'       => now(),
    ];

    // Режим вложения.
    if (isset($_GET['download']) && $_GET['download'] === '1') {
        header('Content-Type: application/json; charset=utf-8');
        header('Content-Disposition: attachment; filename="service-center-backup-' . date('Y-m-d') . '.json"');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        exit;
    }

    sendJson($payload);
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}
