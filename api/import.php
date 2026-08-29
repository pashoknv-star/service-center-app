<?php

declare(strict_types=1);

/**
 * api/import.php — POST: восстановление состояния из JSON backup.
 *
 * Фаза 8 (часть A): Import JSON backup.
 *
 * Требует require_admin() — восстановление данных только администратором.
 *
 * Тело: полный ScheduleState (тот же формат, что возвращает export.php):
 *   { version?, year?, groups[], positions[], employees[], entries{},
 *     holidays{}, vacationBalances{} }
 *
 * Обязательные ключи: groups, positions, employees.
 *
 * Выполняется в транзакции: сначала полная очистка таблиц, затем вставка
 * данных из payload. Откат при любой ошибке.
 *
 * Возвращает:
 *   { success: true, imported: { groups, positions, employees, entries,
 *     holidays, balances } }
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();
requireMethod('POST');
require_auth();
require_admin();

try {
    $body = getJsonBody();
    $db   = Database::getInstance();
    $pdo  = $db->getPDO();
    $db->migrate();

    // --- Валидация обязательных ключей ---
    foreach (['groups', 'positions', 'employees'] as $key) {
        if (!isset($body[$key]) || !is_array($body[$key])) {
            error('invalid_format: missing required key "' . $key . '"', 400);
        }
    }

    $counts = ['groups' => 0, 'positions' => 0, 'employees' => 0, 'entries' => 0, 'holidays' => 0, 'balances' => 0];

    $pdo->beginTransaction();
    try {
        // --- Полная очистка (в правильном порядке из-за FK) ---
        $pdo->exec('DELETE FROM schedule_entries');
        $pdo->exec('DELETE FROM vacation_balances');
        $pdo->exec('DELETE FROM employees');
        $pdo->exec('DELETE FROM positions');
        $pdo->exec('DELETE FROM groups');
        $pdo->exec('DELETE FROM holidays');

        // --- groups ---
        $stmtG = $pdo->prepare('INSERT INTO groups (id, name, sort_order) VALUES (?, ?, ?)');
        foreach ($body['groups'] as $g) {
            $sort = isset($g['sortOrder']) ? (int) $g['sortOrder'] : (isset($g['sort_order']) ? (int) $g['sort_order'] : null);
            $stmtG->execute([$g['id'] ?? null, $g['name'] ?? '', $sort]);
            $counts['groups']++;
        }

        // --- positions ---
        $stmtP = $pdo->prepare('INSERT INTO positions (id, name, sort_order) VALUES (?, ?, ?)');
        foreach ($body['positions'] as $p) {
            $sort = isset($p['sortOrder']) ? (int) $p['sortOrder'] : (isset($p['sort_order']) ? (int) $p['sort_order'] : null);
            $stmtP->execute([$p['id'] ?? null, $p['name'] ?? '', $sort]);
            $counts['positions']++;
        }

        // --- employees ---
        $stmtE = $pdo->prepare(
            'INSERT INTO employees
                (id, full_name, position_id, location, group_id, phone, photo_url,
                 is_technical, requires_full_profile, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $ts = now();
        foreach ($body['employees'] as $e) {
            $id        = $e['id'] ?? genId('emp_');
            $createdAt = $e['createdAt'] ?? $e['created_at'] ?? $ts;
            $sort      = isset($e['sortOrder']) ? (int) $e['sortOrder'] : (isset($e['sort_order']) ? (int) $e['sort_order'] : null);
            $isTech    = !empty($e['isTechnical']) || !empty($e['is_technical']) ? 1 : 0;
            $reqFull   = !empty($e['requiresFullProfile']) || !empty($e['requires_full_profile']) ? 1 : 0;
            $fullName  = $e['fullName'] ?? $e['full_name'] ?? $e['name'] ?? '';
            $posId     = $e['positionId'] ?? $e['position_id'] ?? null;
            $grpId     = $e['groupId'] ?? $e['group_id'] ?? null;
            $photoUrl  = $e['photoUrl'] ?? $e['photo_url'] ?? $e['photo'] ?? '';
            $stmtE->execute([
                $id, $fullName, $posId, $e['location'] ?? '', $grpId,
                $e['phone'] ?? '', $photoUrl, $isTech, $reqFull, $sort,
                $createdAt, $e['updatedAt'] ?? $e['updated_at'] ?? $ts,
            ]);
            $counts['employees']++;
        }

        // --- entries (объект с ключами "employeeId:date" ИЛИ массив) ---
        if (isset($body['entries']) && (is_array($body['entries']) || is_object($body['entries']))) {
            $stmtEn = $pdo->prepare(
                'INSERT INTO schedule_entries
                    (employee_id, date, status, comment, approval_status, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)'
            );
            foreach ((array) $body['entries'] as $entry) {
                if (!is_array($entry)) {
                    continue;
                }
                $empId = $entry['employeeId'] ?? $entry['employee_id'] ?? null;
                $date  = $entry['date'] ?? null;
                if ($empId === null || $date === null) {
                    continue;
                }
                $approval = $entry['approvalStatus'] ?? $entry['approval_status'] ?? 'draft';
                $stmtEn->execute([$empId, $date, $entry['status'] ?? 'vacation', $entry['comment'] ?? '', $approval, $ts]);
                $counts['entries']++;
            }
        }

        // --- holidays ---
        if (isset($body['holidays']) && (is_array($body['holidays']) || is_object($body['holidays']))) {
            $stmtH = $pdo->prepare('INSERT INTO holidays (date, type, label) VALUES (?, ?, ?)');
            foreach ((array) $body['holidays'] as $h) {
                if (!is_array($h)) {
                    continue;
                }
                $date = $h['date'] ?? null;
                if ($date === null) {
                    continue;
                }
                $stmtH->execute([$date, $h['type'] ?? 'holiday', $h['label'] ?? null]);
                $counts['holidays']++;
            }
        }

        // --- vacationBalances ---
        if (isset($body['vacationBalances']) && (is_array($body['vacationBalances']) || is_object($body['vacationBalances']))) {
            $stmtV = $pdo->prepare(
                'INSERT INTO vacation_balances
                    (employee_id, year, total_days, used_days, remaining_days)
                 VALUES (?, ?, ?, ?, ?)'
            );
            foreach ((array) $body['vacationBalances'] as $vb) {
                if (!is_array($vb)) {
                    continue;
                }
                $empId = $vb['employeeId'] ?? $vb['employee_id'] ?? null;
                $year  = $vb['year'] ?? null;
                if ($empId === null || $year === null) {
                    continue;
                }
                $stmtV->execute([
                    $empId, (int) $year,
                    isset($vb['totalDays']) ? (float) $vb['totalDays'] : (isset($vb['total_days']) ? (float) $vb['total_days'] : null),
                    isset($vb['usedDays']) ? (float) $vb['usedDays'] : (isset($vb['used_days']) ? (float) $vb['used_days'] : null),
                    isset($vb['remainingDays']) ? (float) $vb['remainingDays'] : (isset($vb['remaining_days']) ? (float) $vb['remaining_days'] : null),
                ]);
                $counts['balances']++;
            }
        }

        // --- year (meta) ---
        if (isset($body['year'])) {
            $db->setMeta('current_year', (string) (int) $body['year']);
        }

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    // E5: audit import.run
    try {
        $auditCounts = ['groups' => count($body['groups']), 'positions' => count($body['positions']), 'employees' => count($body['employees'])];
        audit($pdo, 'import.run', null, null, 'system', null, ['counts' => $auditCounts]);
    } catch (Throwable $_e) { /* non-critical */ }

    sendJson(['success' => true, 'imported' => $counts]);
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}
