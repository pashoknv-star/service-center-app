<?php

declare(strict_types=1);

/**
 * sync.php — E8: дельта-синхронизация матрицы (polling).
 *
 * GET api/sync.php?afterId=N
 *   Возвращает изменения из sync_log с id > N:
 *   {
 *     success, serverTime, lastSyncId,
 *     entries:          { "empId:date": {employeeId, date, status, comment,
 *                                        approvalStatus, version, updatedAt} },
 *     deletedEntries:   [ "empId:date", ... ],   // события delete, записи нет в БД
 *     employeesChanged: [ id, ... ],
 *     employeesDeleted: [ id, ... ]
 *   }
 *
 *   Семантика: для каждого события из журнала отдаём АКТУАЛЬНОЕ состояние
 *   записи из БД. Если записи уже нет — считаем удалённой (в deletedEntries).
 *   Таким образом клиент мержит дельту поверх локального состояния.
 *
 * POST api/sync.php
 *   Тело: { keys: ["empId:date", ...] }  (необязательно)
 *   Возвращает текущие версии записей для пред-проверки конфликтов:
 *   { success, serverTime, lastSyncId, versions: { "empId:date": N } }
 *
 * Авторизация: как у load.php (require_auth, любая роль — чтение).
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();
require_auth();

try {
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // -----------------------------------------------------------------
    // POST: пред-проверка версий или удаление записей.
    // -----------------------------------------------------------------
    require_edit(); // Для записи нужны права на редактирование
    $body = getJsonBody();

    // Если есть deletes — обрабатываем удаления
    if (isset($body['deletes']) && is_array($body['deletes']) && $body['deletes'] !== []) {
        $currentUser = current_user();
        $isAdmin = !empty($currentUser['is_admin']);
        $scopeGroupId = $currentUser['scope_group_id'] ?? null;

        $pdo->beginTransaction();
        try {
            $ts = now();
            $deletedCount = 0;

            foreach ($body['deletes'] as $del) {
                $employeeId = $del['employeeId'] ?? $del['employee_id'] ?? null;
                $date       = $del['date'] ?? null;

                if ($employeeId === null || $employeeId === '' || $date === null || $date === '') {
                    continue;
                }

                // E8-3: зональная проверка для супервайзеров
                if (!$isAdmin) {
                    $empScopeStmt = $pdo->prepare('SELECT group_id FROM employees WHERE id = :id LIMIT 1');
                    $empScopeStmt->execute([':id' => (string) $employeeId]);
                    $empGroupId = $empScopeStmt->fetch(PDO::FETCH_COLUMN);
                    if ($empGroupId !== false && $empGroupId !== null) {
                        if ($scopeGroupId === null || $empGroupId !== $scopeGroupId) {
                            continue; // Пропускаем удаление чужой зоны
                        }
                    }
                }

                // Удаляем запись
                $delStmt = $pdo->prepare(
                    'DELETE FROM schedule_entries
                     WHERE employee_id = :eid AND date = :dt'
                );
                $delStmt->bindValue(':eid', (string) $employeeId, PDO::PARAM_STR);
                $delStmt->bindValue(':dt', (string) $date, PDO::PARAM_STR);
                $delStmt->execute();

                if ($delStmt->rowCount() > 0) {
                    $deletedCount++;
                    // Логируем событие в sync_log
                    $logStmt = $pdo->prepare(
                        'INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at)
                         VALUES (:t, :id, :a, :actor, :ts)'
                    );
                    $logStmt->bindValue(':t', 'entry', PDO::PARAM_STR);
                    $logStmt->bindValue(':id', $employeeId . ':' . $date, PDO::PARAM_STR);
                    $logStmt->bindValue(':a', 'delete', PDO::PARAM_STR);
                    $logStmt->bindValue(':actor', $currentUser['username'] ?? 'sync', PDO::PARAM_STR);
                    $logStmt->bindValue(':ts', $ts, PDO::PARAM_STR);
                    $logStmt->execute();
                }
            }

            $pdo->commit();

            $lastSyncId = (int) $pdo->query(
                'SELECT COALESCE(MAX(id), 0) FROM sync_log'
            )->fetchColumn();

            sendJson([
                'success'    => true,
                'serverTime' => $ts,
                'lastSyncId' => $lastSyncId,
                'deleted'    => $deletedCount,
            ]);
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    // Если нет deletes — пред-проверка версий (оригинальная логика)
    $keys = $body['keys'] ?? [];
    $versions = [];
    if (is_array($keys) && $keys !== []) {
        $stmt = $pdo->prepare(
            'SELECT employee_id, date, version
             FROM schedule_entries
             WHERE employee_id || \':\' || date = :k'
        );
        foreach ($keys as $k) {
            if (!is_string($k) || $k === '') {
                continue;
            }
            $stmt->bindValue(':k', $k, PDO::PARAM_STR);
            $stmt->execute();
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            $versions[$k] = $row ? (int) $row['version'] : 0;
        }
        $lastSyncId = (int) $pdo->query(
            'SELECT COALESCE(MAX(id), 0) FROM sync_log'
        )->fetchColumn();
        sendJson([
            'success'    => true,
            'serverTime' => now(),
            'lastSyncId' => $lastSyncId,
            'versions'   => (object) $versions,
        ]);
    }

    // -----------------------------------------------------------------
    // GET: дельта по afterId.
    // -----------------------------------------------------------------
    requireMethod('GET');
    $afterId = isset($_GET['afterId']) ? (int) $_GET['afterId'] : 0;
    if ($afterId < 0) {
        $afterId = 0;
    }

    // 2026-08-24 (E8-4): зональный фильтр чтения СНЯТ — дельта отдаёт все
    // изменения всем аутентифицированным пользователям. Прежний вариант для
    // не-админа помечал чужие записи как deletedEntries → фронт стирал их
    // из матрицы при каждом poll-цикле («срезание» зон).
    // Запись (POST deletes) остаётся зонально ограничена ниже.
    $currentUser = current_user();

    // Последний id журнала (новый курсор клиента).
    $lastSyncId = (int) $pdo->query(
        'SELECT COALESCE(MAX(id), 0) FROM sync_log'
    )->fetchColumn();

    $entries = [];
    $deletedEntries = [];
    $employeesChanged = [];
    $employeesDeleted = [];

    if ($lastSyncId > $afterId) {
        // События журнала после курсора.
        $rows = $pdo->query(
            'SELECT DISTINCT entity_type, entity_id FROM sync_log WHERE id > ' . $afterId
        )->fetchAll(PDO::FETCH_ASSOC);

        $stmtEntry = $pdo->prepare(
            'SELECT employee_id, date, status, comment, approval_status, version, updated_at
             FROM schedule_entries WHERE employee_id || \':\' || date = :k LIMIT 1'
        );
        $stmtEmp = $pdo->prepare('SELECT id FROM employees WHERE id = :id LIMIT 1');

        foreach ($rows as $row) {
            $type = $row['entity_type'];
            $eid  = (string) $row['entity_id'];
            if ($type === 'entry') {
                $stmtEntry->bindValue(':k', $eid, PDO::PARAM_STR);
                $stmtEntry->execute();
                $er = $stmtEntry->fetch(PDO::FETCH_ASSOC);
                if ($er) {
                    $entries[$eid] = [
                        'employeeId'     => $er['employee_id'],
                        'date'           => $er['date'],
                        'status'         => $er['status'],
                        'comment'        => $er['comment'],
                        'approvalStatus' => $er['approval_status'],
                        'version'        => isset($er['version']) ? (int) $er['version'] : 1,
                        'updatedAt'      => $er['updated_at'],
                    ];
                } else {
                    // Записи в БД нет — она действительно удалена.
                    $deletedEntries[] = $eid;
                }
            } elseif ($type === 'employee') {
                $stmtEmp->bindValue(':id', $eid, PDO::PARAM_STR);
                $stmtEmp->execute();
                if ($stmtEmp->fetch()) {
                    $employeesChanged[] = $eid;
                } else {
                    $employeesDeleted[] = $eid;
                }
            }
        }
    }

    sendJson([
        'success'          => true,
        'serverTime'       => now(),
        'afterId'          => $afterId,
        'lastSyncId'       => $lastSyncId,
        'entries'          => (object) $entries,
        'deletedEntries'   => $deletedEntries,
        'employeesChanged' => $employeesChanged,
        'employeesDeleted' => $employeesDeleted,
    ]);
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}
