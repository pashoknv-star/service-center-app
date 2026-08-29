<?php

declare(strict_types=1);

/**
 * load.php — GET: загрузка всего состояния (ScheduleState).
 *
 * Возвращает JSON-структуру:
 *   {
 *     version, year: 2026, groups:[], positions:[], employees:[],
 *     entries: {}, holidays: {}, vacationBalances: {}, updatedAt
 *   }
 *
 *   entries          — объект с ключами "employeeId:date"
 *   holidays         — объект с ключами "date"
 *   vacationBalances — объект с ключами "employeeId:year"
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();
requireMethod('GET');
require_auth();

try {
    $db = Database::getInstance();
    $pdo = $db->getPDO();

    // Гарантируем, что схема применена.
    $db->migrate();

    // Получаем текущего пользователя (E8-4: зональный фильтр чтения снят —
    // все видят всех; переменная оставлена для будущих write-проверок).
    $currentUser = current_user();

    // --- groups (camelCase) ---
    $groupRows = $pdo->query(
        'SELECT id, name, sort_order FROM groups ORDER BY sort_order, name'
    )->fetchAll(PDO::FETCH_ASSOC);
    $groups = [];
    foreach ($groupRows as $row) {
        $groups[] = [
            'id'        => $row['id'],
            'name'      => $row['name'],
            'sortOrder' => isset($row['sort_order']) ? (int) $row['sort_order'] : null,
        ];
    }

    // --- positions (camelCase) ---
    $positionRows = $pdo->query(
        'SELECT id, name, sort_order FROM positions ORDER BY sort_order, name'
    )->fetchAll(PDO::FETCH_ASSOC);
    $positions = [];
    foreach ($positionRows as $row) {
        $positions[] = [
            'id'        => $row['id'],
            'name'      => $row['name'],
            'sortOrder' => isset($row['sort_order']) ? (int) $row['sort_order'] : null,
        ];
    }

    // --- employees (camelCase) ---
    // Все пользователи видят всех сотрудников (read-only для чужих зон).
    $empSql = 'SELECT id, full_name, position_id, location, group_id, phone, photo_url,
                      is_technical, requires_full_profile, sort_order, created_at, updated_at
               FROM employees
               ORDER BY sort_order, full_name';
    $empRows = $pdo->query($empSql)->fetchAll(PDO::FETCH_ASSOC);
    $employees = [];
    foreach ($empRows as $row) {
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
            'sortOrder'           => isset($row['sort_order']) ? (int) $row['sort_order'] : null,
            'createdAt'           => $row['created_at'],
            'updatedAt'           => $row['updated_at'],
        ];
    }

    // --- entries (ключ "employeeId:date") ---
    // E8: включаем version записи для оптимистичной синхронизации.
    // 2026-08-24 (E8-4): зональный фильтр чтения СНЯТ по требованию владельца —
    // все пользователи видят всех сотрудников и все записи матрицы.
    // Зона supervisor ограничивает ТОЛЬКО редактирование (save.php/entries.php
    // POST/sync.php deletes — write-путь защищён отдельно).
    $entries = [];
    $entrySql = 'SELECT employee_id, date, status, comment, approval_status, version, updated_at
                 FROM schedule_entries';
    $entryStmt = $pdo->prepare($entrySql);
    $entryStmt->execute();
    $entryRows = $entryStmt->fetchAll(PDO::FETCH_ASSOC);
    foreach ($entryRows as $row) {
        $key = $row['employee_id'] . ':' . $row['date'];
        $entries[$key] = [
            'employeeId'     => $row['employee_id'],
            'date'           => $row['date'],
            'status'         => $row['status'],
            'comment'        => $row['comment'],
            'approvalStatus' => $row['approval_status'],
            'version'        => isset($row['version']) ? (int) $row['version'] : 1,
            'updatedAt'      => $row['updated_at'],
        ];
    }

    // --- holidays (ключ "date") ---
    $holidays = [];
    $holidayRows = $pdo->query(
        'SELECT date, type, label FROM holidays ORDER BY date'
    )->fetchAll(PDO::FETCH_ASSOC);
    foreach ($holidayRows as $row) {
        $holidays[$row['date']] = [
            'date'  => $row['date'],
            'type'  => $row['type'],
            'label' => $row['label'],
        ];
    }

    // --- vacationBalances (ключ "employeeId:year") ---
    $vacationBalances = [];
    $vacRows = $pdo->query(
        'SELECT employee_id, year, total_days, used_days, remaining_days
         FROM vacation_balances'
    )->fetchAll(PDO::FETCH_ASSOC);
    foreach ($vacRows as $row) {
        $key = $row['employee_id'] . ':' . $row['year'];
        $vacationBalances[$key] = [
            'employeeId'    => $row['employee_id'],
            'year'          => (int) $row['year'],
            'totalDays'     => isset($row['total_days']) ? (float) $row['total_days'] : null,
            'usedDays'      => isset($row['used_days']) ? (float) $row['used_days'] : null,
            'remainingDays' => isset($row['remaining_days']) ? (float) $row['remaining_days'] : null,
        ];
    }

    // --- year (из meta или по умолчанию 2026) ---
    $yearStmt = $pdo->prepare("SELECT value FROM meta WHERE key = 'current_year'");
    $yearStmt->execute();
    $yearRow = $yearStmt->fetch();
    $year = $yearRow ? (int) $yearRow['value'] : 2026;

    // E8: последний id журнала синхронизации (курсор polling-дельты).
    $lastSyncId = 0;
    try {
        $lastSyncId = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM sync_log')->fetchColumn();
    } catch (Throwable $e) {
        // Таблица ещё не существует — синхронизация недоступна.
    }

    sendJson([
        'version'          => 1,
        'year'             => $year,
        'groups'           => $groups,
        'positions'        => $positions,
        'employees'        => $employees,
        'entries'          => (object) $entries,
        'holidays'         => (object) $holidays,
        'vacationBalances' => (object) $vacationBalances,
        'lastSyncId'       => $lastSyncId,
        'updatedAt'        => now(),
    ]);
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}
