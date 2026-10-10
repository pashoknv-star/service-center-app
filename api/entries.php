<?php

declare(strict_types=1);

/**
 * entries.php — CRUD для отдельных schedule_entries (матрица отпусков).
 *
 *   GET ?employeeId=X&year=2026   — все entries сотрудника за год.
 *   GET ?year=2026                 — все entries за год.
 *   GET ?employeeId=X              — все entries сотрудника (без фильтра по году).
 *   GET (без параметров)           — все entries (осторожно при больших данных).
 *
 *   POST                           — создать/обновить entry (upsert):
 *        body: { employeeId, date, status, comment?, approvalStatus? }
 *        INSERT OR REPLACE через prepared statement.
 *
 *   PUT ?employeeId=X&date=2026-07-15 — обновить entry:
 *        body: { status?, comment?, approvalStatus? }
 *        ЗАЩИТА: если current approvalStatus='approved' и new approvalStatus!='approved'
 *                → 403 { error: 'cannot_modify_approved' }.
 *
 *   DELETE ?employeeId=X&date=2026-07-15 — удалить entry:
 *        body: { force: true } — требуется для удаления approved записи (только admin).
 *        ЗАЩИТА: если approvalStatus='approved' и force !== true → 403
 *                { error: 'cannot_delete_approved' }.
 *
 * Все endpoints требуют require_auth() + require_edit() (кроме DELETE approved —
 * там дополнительно require_admin() при force=true).
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();

try {
    $db  = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    switch ($method) {
        // ===============================================================
        // GET — чтение entries
        // ===============================================================
        case 'GET':
            require_auth();

            // 2026-08-24 (E8-4): зональный фильтр чтения СНЯТ — все
            // аутентифицированные пользователи видят все записи матрицы
            // (зона ограничивает только запись; см. POST/PUT/DELETE ниже).
            $employeeId = $_GET['employeeId'] ?? $_GET['employee_id'] ?? null;
            $year       = $_GET['year']       ?? null;

            $params = [];
            $sql = 'SELECT employee_id, date, status, comment, approval_status, updated_at
                    FROM schedule_entries WHERE 1=1';

            if ($employeeId !== null && $employeeId !== '') {
                $sql .= ' AND employee_id = :employee_id';
                $params[':employee_id'] = (string) $employeeId;
            }
            if ($year !== null && $year !== '') {
                $yearInt = (int) $year;
                $sql .= ' AND substr(date, 1, 4) = :year';
                $params[':year'] = (string) $yearInt;
            }
            $sql .= ' ORDER BY employee_id, date';

            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            sendJson(array_map('normalizeEntry', $rows));
            break;

        // ===============================================================
        // POST — создать/обновить entry (upsert)
        // ===============================================================
        case 'POST':
            require_auth();
            require_edit();

            $body = getJsonBody();

            $employeeId = $body['employeeId'] ?? $body['employee_id'] ?? null;
            $date       = $body['date'] ?? null;

            if ($employeeId === null || $employeeId === '') {
                error('missing_employeeId', 400);
            }
            if ($date === null || $date === '') {
                error('missing_date', 400);
            }
            // Простейшая валидация формата даты.
            $parsed = date_create((string) $date);
            if ($parsed === false) {
                error('invalid_date', 400);
            }

            // E8-3: зональная проверка для супервайзеров (admin проходит)
            $currentUser = current_user();
            $isAdmin = !empty($currentUser['is_admin']);
            if (!$isAdmin) {
                $empScopeStmt = $pdo->prepare('SELECT group_id FROM employees WHERE id = :id LIMIT 1');
                $empScopeStmt->execute([':id' => (string) $employeeId]);
                $empGroupId = $empScopeStmt->fetch(PDO::FETCH_COLUMN);
                if ($empGroupId !== false && $empGroupId !== null) {
                    $userScope = $currentUser['scope_group_id'] ?? null;
                    if ($userScope === null || $empGroupId !== $userScope) {
                        sendJson(['error' => 'zone_forbidden'], 403);
                    }
                }
            }

            $status         = $body['status']         ?? null;
            $comment        = $body['comment']        ?? null;
            $approvalStatus = $body['approvalStatus'] ?? $body['approval_status'] ?? 'draft';

            // Защита approved при попытке перезаписи через plain POST:
            // Supervisor не может изменять approved записи на не-approved.
            // Admin имеет полный доступ.
            $chk = $pdo->prepare(
                'SELECT approval_status FROM schedule_entries
                 WHERE employee_id = :eid AND date = :dt LIMIT 1'
            );
            $chk->execute([':eid' => $employeeId, ':dt' => $date]);
            $existing = $chk->fetch();

            if (!$isAdmin
                && $existing
                && ($existing['approval_status'] ?? '') === 'approved'
                && $approvalStatus !== 'approved'
            ) {
                sendJson(['error' => 'cannot_modify_approved'], 403);
            }

            $ts = now();
            $stmt = $pdo->prepare(
                'INSERT INTO schedule_entries
                    (employee_id, date, status, comment, approval_status, updated_at)
                 VALUES
                    (:employee_id, :date, :status, :comment, :approval_status, :updated_at)
                 ON CONFLICT(employee_id, date) DO UPDATE SET
                    status          = excluded.status,
                    comment         = excluded.comment,
                    approval_status = excluded.approval_status,
                    updated_at      = excluded.updated_at'
            );
            $stmt->bindValue(':employee_id', (string) $employeeId, PDO::PARAM_STR);
            $stmt->bindValue(':date', (string) $date, PDO::PARAM_STR);
            $stmt->bindValue(':status', $status, PDO::PARAM_STR);
            $stmt->bindValue(':comment', $comment, PDO::PARAM_STR);
            $stmt->bindValue(':approval_status', (string) $approvalStatus, PDO::PARAM_STR);
            $stmt->bindValue(':updated_at', $ts, PDO::PARAM_STR);
            $stmt->execute();

            // Возвращаем актуальную запись.
            $read = $pdo->prepare(
                'SELECT employee_id, date, status, comment, approval_status, updated_at
                 FROM schedule_entries WHERE employee_id = :eid AND date = :dt'
            );
            $read->execute([':eid' => $employeeId, ':dt' => $date]);
            $row = $read->fetch(PDO::FETCH_ASSOC);

            // E5: audit entry upsert (POST)
            try {
                audit($pdo, 'entry.upsert', null, null, 'entry', $employeeId . ':' . $date);
            } catch (Throwable $_e) { /* non-critical */ }

            // E10-6: событие свежести — без записи в sync_log polling и
            // stale-гард не видят эту правку (делает другие вкладки слепыми).
            try {
                $pdo->prepare(
                    'INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at)
                     VALUES (:t, :id, :a, :actor, :ts)'
                )->execute([
                    ':t'     => 'entry',
                    ':id'    => (string) $employeeId . ':' . (string) $date,
                    ':a'     => 'upsert',
                    ':actor' => (function_exists('sync_actor') ? sync_actor() : 'api'),
                    ':ts'    => $ts,
                ]);
            } catch (Throwable $_sl) { /* non-critical */ }

            sendJson(normalizeEntry($row));
            break;

        // ===============================================================
        // PUT — обновить entry
        // ===============================================================
        case 'PUT':
            require_auth();
            require_edit();

            $employeeId = $_GET['employeeId'] ?? $_GET['employee_id'] ?? null;
            $date       = $_GET['date'] ?? null;

            if ($employeeId === null || $employeeId === '') {
                error('missing_employeeId', 400);
            }
            if ($date === null || $date === '') {
                error('missing_date', 400);
            }

            // E8-3: зональная проверка для супервайзеров (admin проходит)
            $currentUser = current_user();
            $isAdmin = !empty($currentUser['is_admin']);
            if (!$isAdmin) {
                $empScopeStmt = $pdo->prepare('SELECT group_id FROM employees WHERE id = :id LIMIT 1');
                $empScopeStmt->execute([':id' => (string) $employeeId]);
                $empGroupId = $empScopeStmt->fetch(PDO::FETCH_COLUMN);
                if ($empGroupId !== false && $empGroupId !== null) {
                    $userScope = $currentUser['scope_group_id'] ?? null;
                    if ($userScope === null || $empGroupId !== $userScope) {
                        sendJson(['error' => 'zone_forbidden'], 403);
                    }
                }
            }

            $body = getJsonBody();

            // Загружаем текущую запись.
            $stmt = $pdo->prepare(
                'SELECT employee_id, date, status, comment, approval_status, updated_at
                 FROM schedule_entries WHERE employee_id = :eid AND date = :dt LIMIT 1'
            );
            $stmt->execute([':eid' => $employeeId, ':dt' => $date]);
            $current = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!$current) {
                error('entry_not_found', 404);
            }

            $currentApproval = $current['approval_status'] ?? 'draft';
            $newApproval     = $body['approvalStatus'] ?? $body['approval_status'] ?? $currentApproval;

            // ЗАЩИТА: supervisor не может понижать статус approved → не-approved.
            // Admin имеет полный доступ и может редактировать approved записи.
            $currentUser = current_user();
            $isAdmin = !empty($currentUser['is_admin']);
            if (!$isAdmin && $currentApproval === 'approved' && $newApproval !== 'approved') {
                sendJson(['error' => 'cannot_modify_approved'], 403);
            }

            $newStatus  = $body['status']  ?? $current['status']  ?? null;
            $newComment = $body['comment'] ?? $current['comment'] ?? null;

            $ts = now();
            $upd = $pdo->prepare(
                'UPDATE schedule_entries
                    SET status          = :status,
                        comment         = :comment,
                        approval_status = :approval_status,
                        updated_at      = :updated_at
                 WHERE employee_id = :eid AND date = :dt'
            );
            $upd->bindValue(':status', $newStatus, PDO::PARAM_STR);
            $upd->bindValue(':comment', $newComment, PDO::PARAM_STR);
            $upd->bindValue(':approval_status', (string) $newApproval, PDO::PARAM_STR);
            $upd->bindValue(':updated_at', $ts, PDO::PARAM_STR);
            $upd->bindValue(':eid', (string) $employeeId, PDO::PARAM_STR);
            $upd->bindValue(':dt', (string) $date, PDO::PARAM_STR);
            $upd->execute();

            // Возвращаем обновлённую запись.
            $read = $pdo->prepare(
                'SELECT employee_id, date, status, comment, approval_status, updated_at
                 FROM schedule_entries WHERE employee_id = :eid AND date = :dt'
            );
            $read->execute([':eid' => $employeeId, ':dt' => $date]);
            $row = $read->fetch(PDO::FETCH_ASSOC);

            // E5: audit entry update (PUT)
            try {
                audit($pdo, 'entry.upsert', null, null, 'entry', $employeeId . ':' . $date);
            } catch (Throwable $_e) { /* non-critical */ }

            sendJson(normalizeEntry($row));
            break;

        // ===============================================================
        // DELETE — удалить entry (с защитой approved)
        // ===============================================================
        case 'DELETE':
            require_auth();
            require_edit();

            $employeeId = $_GET['employeeId'] ?? $_GET['employee_id'] ?? null;
            $date       = $_GET['date'] ?? null;

            if ($employeeId === null || $employeeId === '') {
                error('missing_employeeId', 400);
            }
            if ($date === null || $date === '') {
                error('missing_date', 400);
            }

            // E8-3: зональная проверка для супервайзеров (admin проходит)
            $currentUser = current_user();
            $isAdmin = !empty($currentUser['is_admin']);
            if (!$isAdmin) {
                $empScopeStmt = $pdo->prepare('SELECT group_id FROM employees WHERE id = :id LIMIT 1');
                $empScopeStmt->execute([':id' => (string) $employeeId]);
                $empGroupId = $empScopeStmt->fetch(PDO::FETCH_COLUMN);
                if ($empGroupId !== false && $empGroupId !== null) {
                    $userScope = $currentUser['scope_group_id'] ?? null;
                    if ($userScope === null || $empGroupId !== $userScope) {
                        sendJson(['error' => 'zone_forbidden'], 403);
                    }
                }
            }

            // Загружаем текущую запись, чтобы проверить approval_status.
            $stmt = $pdo->prepare(
                'SELECT approval_status FROM schedule_entries
                 WHERE employee_id = :eid AND date = :dt LIMIT 1'
            );
            $stmt->execute([':eid' => $employeeId, ':dt' => $date]);
            $current = $stmt->fetch(PDO::FETCH_ASSOC);

            if (!$current) {
                error('entry_not_found', 404);
            }

            $approval = $current['approval_status'] ?? 'draft';
            $body     = getJsonBodySafe();
            $force    = strToBool($body['force'] ?? false);

            // ЗАЩИТА: approved нельзя удалить без force=true.
            if ($approval === 'approved' && !$force) {
                sendJson(['error' => 'cannot_delete_approved'], 403);
            }

            // Если force=true — удаляем approved только если текущий пользователь admin.
            if ($approval === 'approved' && $force) {
                require_admin();
            }

            $del = $pdo->prepare(
                'DELETE FROM schedule_entries
                 WHERE employee_id = :eid AND date = :dt'
            );
            $del->bindValue(':eid', (string) $employeeId, PDO::PARAM_STR);
            $del->bindValue(':dt', (string) $date, PDO::PARAM_STR);
            $del->execute();

            // E5: audit entry delete
            try {
                audit($pdo, 'entry.delete', null, null, 'entry', (string) $employeeId . ':' . $date);
            } catch (Throwable $_e) { /* non-critical */ }

            // E10-6: событие свежести для polling/stale-гарда.
            try {
                $pdo->prepare(
                    'INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at)
                     VALUES (:t, :id, :a, :actor, :ts)'
                )->execute([
                    ':t'     => 'entry',
                    ':id'    => (string) $employeeId . ':' . (string) $date,
                    ':a'     => 'delete',
                    ':actor' => (function_exists('sync_actor') ? sync_actor() : 'api'),
                    ':ts'    => now(),
                ]);
            } catch (Throwable $_sl2) { /* non-critical */ }

            sendJson([
                'success'    => true,
                'deleted'    => true,
                'employeeId' => $employeeId,
                'date'       => $date,
            ]);
            break;

        default:
            sendJson(['error' => 'Method not allowed'], 405);
    }
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

/**
 * Преобразует строку БД в camelCase-объект для API-ответа.
 *
 * @param array|false $row
 * @return array
 */
function normalizeEntry($row): array
{
    if (!$row) {
        return [];
    }
    return [
        'employeeId'     => $row['employee_id']     ?? null,
        'date'           => $row['date']            ?? null,
        'status'         => $row['status']          ?? null,
        'comment'        => $row['comment']         ?? null,
        'approvalStatus' => $row['approval_status'] ?? null,
        'updatedAt'      => $row['updated_at']      ?? null,
    ];
}

/**
 * Безопасное чтение JSON-тела для DELETE (тело может отсутствовать).
 *
 * @return array
 */
function getJsonBodySafe(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return [];
    }
    return $data;
}
