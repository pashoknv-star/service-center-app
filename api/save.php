<?php

declare(strict_types=1);

/**
 * save.php — POST: полное сохранение состояния (upsert).
 *
 * Тело: { groups[], positions[], employees[], entries{}, holidays{},
 *         vacationBalances{}, year }
 *
 * Использует транзакцию (BEGIN/COMMIT).
 * employees: upsert (INSERT OR REPLACE), обновляется updated_at.
 * entries: для каждого employeeId:date — INSERT OR REPLACE.
 * Удалённые сотрудники НЕ удаляются (безопасность данных): только upsert того,
 * что пришло в payload.
 *
 * Возвращает: { success: true, savedAt: <ISO> }
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();
requireMethod('POST');
require_auth();
require_edit();

/** Актёр для sync_log: имя текущего пользователя или 'api'. */
function sync_actor(): string
{
    $u = current_user();
    return is_array($u) && !empty($u['username']) ? (string) $u['username'] : 'api';
}

/** Записывает событие в sync_log (внутри транзакции save.php). */
function sync_log(PDO $pdo, string $entityType, string $entityId, string $action, string $ts): void
{
    static $stmt = null;
    if ($stmt === null) {
        $stmt = $pdo->prepare(
            'INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at)
             VALUES (:t, :id, :a, :actor, :ts)'
        );
    }
    $stmt->bindValue(':t', $entityType, PDO::PARAM_STR);
    $stmt->bindValue(':id', $entityId, PDO::PARAM_STR);
    $stmt->bindValue(':a', $action, PDO::PARAM_STR);
    $stmt->bindValue(':actor', sync_actor(), PDO::PARAM_STR);
    $stmt->bindValue(':ts', $ts, PDO::PARAM_STR);
    $stmt->execute();
}

/** Ротация sync_log: держим не более 10000 последних событий. */
function sync_log_rotate(PDO $pdo): void
{
    $maxId = $pdo->query('SELECT MAX(id) FROM sync_log')->fetchColumn();
    if ($maxId !== false && (int) $maxId > 10000) {
        $pdo->exec('DELETE FROM sync_log WHERE id < ' . ((int) $maxId - 10000));
    }
}

try {
    $body = getJsonBody();
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $pdo->beginTransaction();
    try {
        $ts = now();

        // ---------------------------------------------------------------
        // E8-2: роль текущего пользователя.
        // admin — полный доступ, конфликты версий его не касаются;
        // supervisor — только trip/day_off и только своя зона (по-записно);
        // viewer отсекается require_edit() (403).
        // ---------------------------------------------------------------
        $e82User = current_user();
        $e82IsAdmin = is_array($e82User) && !empty($e82User['is_admin']);
        $e82IsSupervisor = !$e82IsAdmin && is_array($e82User)
            && !empty($e82User['can_edit'])
            && !empty($e82User['scope_group_id']);
        $e82Scope = (is_array($e82User) && !empty($e82User['scope_group_id']))
            ? (string) $e82User['scope_group_id'] : null;
        $appliedVersions = [];          // 'empId:date' => финальная version
        $e82EmpScope = [];              // кэш scope сотрудников
        $e82EmpScopeStmt = null;

        // ---------------------------------------------------------------
        // groups (upsert)
        // ---------------------------------------------------------------
        if ($e82IsAdmin && isset($body['groups']) && is_array($body['groups'])) {
            $stmtG = $pdo->prepare(
                'INSERT INTO groups (id, name, sort_order)
                 VALUES (:id, :name, :sort_order)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    sort_order = excluded.sort_order'
            );
            foreach ($body['groups'] as $g) {
                $stmtG->bindValue(':id', $g['id'] ?? null, PDO::PARAM_STR);
                $stmtG->bindValue(':name', $g['name'] ?? null, PDO::PARAM_STR);
                $stmtG->bindValue(':sort_order', isset($g['sort_order']) ? (int) $g['sort_order'] : (isset($g['sortOrder']) ? (int) $g['sortOrder'] : null), PDO::PARAM_INT);
                $stmtG->execute();
            }
        }

        // ---------------------------------------------------------------
        // positions (upsert)
        // ---------------------------------------------------------------
        if ($e82IsAdmin && isset($body['positions']) && is_array($body['positions'])) {
            $stmtP = $pdo->prepare(
                'INSERT INTO positions (id, name, sort_order)
                 VALUES (:id, :name, :sort_order)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    sort_order = excluded.sort_order'
            );
            foreach ($body['positions'] as $p) {
                $stmtP->bindValue(':id', $p['id'] ?? null, PDO::PARAM_STR);
                $stmtP->bindValue(':name', $p['name'] ?? null, PDO::PARAM_STR);
                $stmtP->bindValue(':sort_order', isset($p['sort_order']) ? (int) $p['sort_order'] : (isset($p['sortOrder']) ? (int) $p['sortOrder'] : null), PDO::PARAM_INT);
                $stmtP->execute();
            }
        }

        // ---------------------------------------------------------------
        // employees (upsert, обновляем updated_at)
        // SYNC: карточки, отсутствующие в payload, удаляются —
        // фронт отправляет полное состояние (кнопка «Сохранить» убрана).
        // ---------------------------------------------------------------
        if ($e82IsAdmin && isset($body['employees']) && is_array($body['employees'])) {
            $stmtE = $pdo->prepare(
                'INSERT INTO employees
                    (id, full_name, position_id, location, group_id, phone, photo_url,
                     is_technical, requires_full_profile, sort_order, created_at, updated_at)
                 VALUES
                    (:id, :full_name, :position_id, :location, :group_id, :phone, :photo_url,
                     :is_technical, :requires_full_profile, :sort_order, :created_at, :updated_at)
                 ON CONFLICT(id) DO UPDATE SET
                    full_name            = excluded.full_name,
                    position_id          = excluded.position_id,
                    location             = excluded.location,
                    group_id             = excluded.group_id,
                    phone                = excluded.phone,
                    photo_url            = excluded.photo_url,
                    is_technical         = excluded.is_technical,
                    requires_full_profile= excluded.requires_full_profile,
                    sort_order           = excluded.sort_order,
                    updated_at           = excluded.updated_at'
            );
            $keepEmpIds = [];
            // --- E10-2 (2026-09-19): защита от массового затирания устаревшим клиентом ---
            // Инцидент 2026-09-18 06:43: автосейв вкладки со старым state одним запросом
            // затёр photo_url (~40 сотрудников) и location (~43), откатил фамилии/позиции/
            // сортировку. Сигнатура: >=3 сотрудников в ОДНОМ запросе получают ПУСТОЕ
            // значение поля, которое в БД непустое (photo_url/location). Такие строки
            // замораживаются (серверные значения сохраняются), аудит: employee.wipe_blocked.
            // Порог 3 не мешает легитимным поштучным операциям: каждый клик «Удалить фото»
            // или очистка локации вызывает свой save с ОДНИМ затиранием; сортировка и
            // переименования под гард не попадают (меняются, а не emptied).
            $wipeSuspects = [];
            try {
                $curMap = [];
                $resCur = $pdo->query('SELECT id, photo_url, location FROM employees');
                while ($r = $resCur->fetch(PDO::FETCH_ASSOC)) {
                    $curMap[(string) $r['id']] = $r;
                }
                foreach ($body['employees'] as $e) {
                    if (!is_array($e) || !array_key_exists('id', $e)) {
                        continue;
                    }
                    $eid = (string) $e['id'];
                    if (!isset($curMap[$eid])) {
                        continue; // новой строке нечего затирать
                    }
                    $newPhoto = $e['photo_url'] ?? $e['photoUrl'] ?? $e['photo'] ?? null;
                    $newLoc   = $e['location'] ?? null;
                    $photoWipe = ($curMap[$eid]['photo_url'] !== null && $curMap[$eid]['photo_url'] !== '')
                        && ($newPhoto === null || $newPhoto === '');
                    $locWipe = ($curMap[$eid]['location'] !== null && $curMap[$eid]['location'] !== '')
                        && ($newLoc === null || $newLoc === '');
                    if ($photoWipe || $locWipe) {
                        $wipeSuspects[$eid] = true;
                    }
                }
            } catch (Throwable $_we) {
                $wipeSuspects = []; // при ошибке выборки гард не срабатывает (безопасный отказ)
            }
            $staleWipe = count($wipeSuspects) >= 3;
            if ($staleWipe) {
                try {
                    audit($pdo, 'employee.wipe_blocked', null, null, 'employee',
                        implode(',', array_keys($wipeSuspects)),
                        ['suspectCount' => count($wipeSuspects),
                         'reason' => 'mass blank of photo_url/location in a single request (stale client suspected); server values kept']);
                } catch (Throwable $_ae) { /* non-critical */ }
            }
            // E5-6: предварительный выборка для аудита create vs update.
            $stmtPreSel = null;
            foreach ($body['employees'] as $e) {
                $id = $e['id'] ?? genId('emp_');
                // E10-2: замороженные строки не обновляем (сервер — истина), но
                // регистрируем их в keepIds, чтобы sync-delete их не удалил.
                if ($staleWipe && isset($wipeSuspects[(string) $id])) {
                    $keepEmpIds[(string) $id] = true;
                    continue;
                }
                // Для новых записей created_at = ts; для существующих сохраняем.
                $createdAt = $e['created_at'] ?? $ts;
                // --- E5-6: SELECT до execute для определения create/update ---
                $wasExisting = false;
                $oldRow = null;
                try {
                    if ($stmtPreSel === null) {
                        $stmtPreSel = $pdo->prepare(
                            'SELECT full_name, position_id, location, group_id, phone, photo_url, is_technical, requires_full_profile, sort_order FROM employees WHERE id = :eid LIMIT 1'
                        );
                    }
                    $stmtPreSel->bindValue(':eid', $id, PDO::PARAM_STR);
                    $stmtPreSel->execute();
                    $oldRow = $stmtPreSel->fetch(PDO::FETCH_ASSOC);
                    $wasExisting = $oldRow !== false;
                } catch (Throwable $_pe) { /* table might not exist yet */ }
                // --- Конец E5-6 предвыборки ---
                $stmtE->bindValue(':id', $id, PDO::PARAM_STR);
                $stmtE->bindValue(':full_name', $e['fullName'] ?? $e['full_name'] ?? $e['name'] ?? '', PDO::PARAM_STR);
                $stmtE->bindValue(':position_id', $e['position_id'] ?? $e['positionId'] ?? null, PDO::PARAM_STR);
                $stmtE->bindValue(':location', $e['location'] ?? null, PDO::PARAM_STR);
                $stmtE->bindValue(':group_id', $e['group_id'] ?? $e['groupId'] ?? null, PDO::PARAM_STR);
                $stmtE->bindValue(':phone', $e['phone'] ?? null, PDO::PARAM_STR);
                $stmtE->bindValue(':photo_url', $e['photo_url'] ?? $e['photoUrl'] ?? $e['photo'] ?? null, PDO::PARAM_STR);
                $stmtE->bindValue(':is_technical', strToBool($e['is_technical'] ?? $e['isTechnical'] ?? false) ? 1 : 0, PDO::PARAM_INT);
                $stmtE->bindValue(':requires_full_profile', strToBool($e['requires_full_profile'] ?? $e['requiresFullProfile'] ?? false) ? 1 : 0, PDO::PARAM_INT);
                $stmtE->bindValue(':sort_order', array_key_exists('sort_order', $e) ? (int) $e['sort_order'] : (array_key_exists('sortOrder', $e) ? (int) $e['sortOrder'] : null), PDO::PARAM_INT);
                $stmtE->bindValue(':created_at', $createdAt, PDO::PARAM_STR);
                $stmtE->bindValue(':updated_at', $ts, PDO::PARAM_STR);
                $stmtE->execute();
                // E8: журнал синхронизации.
                sync_log($pdo, 'employee', $id, 'upsert', $ts);
                // E5-6: аудит create / update сотрудника (UI-путь).
                try {
                    if (!$wasExisting) {
                        audit($pdo, 'employee.create', null, null, 'employee', $id, [
                            'fullName' => $e['fullName'] ?? $e['full_name'] ?? $e['name'] ?? '',
                            'positionId' => $e['position_id'] ?? $e['positionId'] ?? null,
                            'groupId' => $e['group_id'] ?? $e['groupId'] ?? null,
                        ]);
                    } else {
                        $newVals = [
                            'full_name' => $e['fullName'] ?? $e['full_name'] ?? $e['name'] ?? '',
                            'position_id' => $e['position_id'] ?? $e['positionId'] ?? null,
                            'location' => $e['location'] ?? null,
                            'group_id' => $e['group_id'] ?? $e['groupId'] ?? null,
                            'phone' => $e['phone'] ?? null,
                            'photo_url' => $e['photo_url'] ?? $e['photoUrl'] ?? $e['photo'] ?? null,
                            'is_technical' => strToBool($e['is_technical'] ?? $e['isTechnical'] ?? false) ? 1 : 0,
                            'requires_full_profile' => strToBool($e['requires_full_profile'] ?? $e['requiresFullProfile'] ?? false) ? 1 : 0,
                            'sort_order' => array_key_exists('sort_order', $e) ? (int) $e['sort_order'] : (array_key_exists('sortOrder', $e) ? (int) $e['sortOrder'] : null),
                        ];
                        $changes = [];
                        if (is_array($oldRow)) {
                            foreach ($newVals as $col => $newVal) {
                                $oldVal = $oldRow[$col] ?? null;
                                $normOld = ($oldVal === null || $oldVal === '') ? null : $oldVal;
                                $normNew = ($newVal === null || $newVal === '') ? null : $newVal;
                                if ($normOld != $normNew) {
                                    $changes[$col] = $newVal === null ? '' : (string) $newVal;
                                }
                            }
                        }
                        if (!empty($changes)) {
                            audit($pdo, 'employee.update', null, null, 'employee', $id, ['changes' => $changes]);
                        }
                    }
                } catch (Throwable $_e) { /* non-critical */ }
                $keepEmpIds[$id] = true;
            }
            // Удаляем сотрудников, которых нет в payload (вместе с их записями матрицы).
            // --- E10-2 (2026-09-19): защита от массового удаления устаревшим клиентом ---
            // Легитимный UI удаляет ПОШТУЧНО (кнопка «Удалить» → свой save с 1 удалением).
            // >=3 отсутствующих в одном запросе — сигнатура stale-вкладки: блокируем
            // все удаления этого запроса, серверные строки сохраняем, аудит
            // employee.mass_delete_blocked. Внешний импорт идёт через import.php
            // и этим гардом не затрагивается.
            if (!empty($keepEmpIds)) {
                $existing = $pdo->query('SELECT id FROM employees')->fetchAll(PDO::FETCH_COLUMN);
                $toDelete = [];
                foreach ($existing as $oldId) {
                    if (!isset($keepEmpIds[$oldId])) {
                        $toDelete[] = $oldId;
                    }
                }
                if (count($toDelete) >= 3) {
                    try {
                        audit($pdo, 'employee.mass_delete_blocked', null, null, 'employee',
                            implode(',', $toDelete),
                            ['deleteCount' => count($toDelete),
                             'reason' => '>=3 employees missing from a single full-state payload (stale client suspected); server rows kept']);
                    } catch (Throwable $_ae2) { /* non-critical */ }
                    $toDelete = [];
                }
                $stmtDelEmp = $pdo->prepare('DELETE FROM employees WHERE id = :id');
                $stmtDelEnt = $pdo->prepare('DELETE FROM schedule_entries WHERE employee_id = :id');
                foreach ($toDelete as $oldId) {
                    // E5-6: прочитать удаляемого сотрудника для аудита.
                    try {
                        $stmtD = $pdo->prepare('SELECT full_name FROM employees WHERE id = :eid LIMIT 1');
                        $stmtD->bindValue(':eid', $oldId, PDO::PARAM_STR);
                        $stmtD->execute();
                        $delRow = $stmtD->fetch(PDO::FETCH_ASSOC);
                    } catch (Throwable $_d) { $delRow = null; }
                    $stmtDelEnt->bindValue(':id', $oldId, PDO::PARAM_STR);
                    $stmtDelEnt->execute();
                    $stmtDelEmp->bindValue(':id', $oldId, PDO::PARAM_STR);
                    $stmtDelEmp->execute();
                    // E8: журнал синхронизации (удаление сотрудника).
                    sync_log($pdo, 'employee', $oldId, 'delete', $ts);
                    // E5-6: аудит удаления сотрудника (UI-путь).
                    try {
                        if ($delRow && isset($delRow['full_name'])) {
                            audit($pdo, 'employee.delete', null, null, 'employee', $oldId, [
                                'fullName' => $delRow['full_name'],
                            ]);
                        }
                    } catch (Throwable $_e) { /* non-critical */ }
                }
            }
        }

        // ---------------------------------------------------------------
        // entries (ключ "employeeId:date" — INSERT OR REPLACE)
        // E8: версионность. Если payload содержит entryVersion (или version),
        // сравниваем с версией в БД: расхождение → конфликт, entry НЕ
        // принимается и попадает в ответ (conflicts[]). Без version в payload
        // — прежнее поведение (полная совместимость со старым фронтом).
        // ---------------------------------------------------------------
        $conflicts = [];
        $rejections = [];   // E8-2: по-записные отклонения по правам (supervisor)
        if (isset($body['entries']) && (is_array($body['entries']) || is_object($body['entries']))) {
            // E8-2: supervisor шлёт полное состояние, но может менять только trip/day_off
            // в своей зоне. Чужие и запрещённые записи — молча пропускаем как no-op
            // (сервер-истина), а применённые версии отдаём в appliedVersions.
            $stmtEn = $pdo->prepare(
                'INSERT INTO schedule_entries
                    (employee_id, date, status, comment, approval_status, version, updated_at)
                 VALUES
                    (:employee_id, :date, :status, :comment, :approval_status, :version, :updated_at)
                 ON CONFLICT(employee_id, date) DO UPDATE SET
                    status          = excluded.status,
                    comment         = excluded.comment,
                    approval_status = excluded.approval_status,
                    version         = excluded.version,
                    updated_at      = excluded.updated_at'
            );
            // Предвыборка текущих версий затрагиваемых записей (для конфликтов).
            $stmtVer = $pdo->prepare(
                'SELECT version, status, comment, approval_status, updated_at
                 FROM schedule_entries WHERE employee_id = :eid AND date = :d'
            );
            $keepKeys = [];   // "employeeId:date", присутствующие в payload
            $payYears = [];   // годы, представленные в payload
            foreach ((array) $body['entries'] as $entry) {
                // entry может быть объектом {employeeId, date, ...} или значением под ключом "empId:date".
                if (!is_array($entry)) {
                    continue;
                }
                $empId = $entry['employeeId'] ?? $entry['employee_id'] ?? null;
                $date  = $entry['date'] ?? null;
                if ($empId === null || $date === null) {
                    continue;
                }
                $key = $empId . ':' . $date;

                // --- E8: проверка версии И approved guard ДО проверок зоны/статуса ---
                $stmtVer->bindValue(':eid', $empId, PDO::PARAM_STR);
                $stmtVer->bindValue(':d', $date, PDO::PARAM_STR);
                $stmtVer->execute();
                $serverRow = $stmtVer->fetch(PDO::FETCH_ASSOC);
                $serverVersion = $serverRow ? (int) $serverRow['version'] : 0;
                $clientVersion = $entry['entryVersion'] ?? $entry['version'] ?? null;

                // E8: определяем статус записи ДО проверок (исправление: был после использования)
                $entryStatus = $entry['status'] ?? null;

                // --- Права supervisor: зональные проверки ПЕРЕД approved guard ---
                if (!$e82IsAdmin && $e82IsSupervisor) {
                    if ($e82EmpScopeStmt === null) {
                        $e82EmpScopeStmt = $pdo->prepare(
                            'SELECT group_id FROM employees WHERE id = :id LIMIT 1'
                        );
                    }
                    if (!array_key_exists((string) $empId, $e82EmpScope)) {
                        $e82EmpScopeStmt->execute([':id' => (string) $empId]);
                        $scopeRow = $e82EmpScopeStmt->fetch(PDO::FETCH_COLUMN);
                        $e82EmpScope[(string) $empId] = ($scopeRow !== false && $scopeRow !== null)
                            ? (string) $scopeRow : null;
                    }
                    $empScope = $e82EmpScope[(string) $empId];
                    $inOwnZone = ($empScope !== null && $e82Scope !== null && $empScope === $e82Scope);

                    if (!$inOwnZone) {
                        // Чужая зона - reject
                        $rejections[] = [
                            'key'    => $key,
                            'reason' => 'out_of_scope',
                        ];
                        $keepKeys[$key] = true;
                        $payYears[substr((string) $date, 0, 4)] = true;
                        continue;
                    }
                }

                // --- E8-2 (дореализация 2026-08-24): статусная проверка ---
                // supervisor может писать ТОЛЬКО trip / day_off.
                // E8-4: при глобальной видимости payload супервайзера несёт
                // echo чужих vacation/sick записей — они молча отклоняются
                // (фронт rejections[] не обрабатывает), keepKeys защищает
                // их от SYNC-удаления.
                if (!$e82IsAdmin && $e82IsSupervisor) {
                    $allowedStatuses = ['trip', 'day_off', 'dayoff'];
                    if ($entryStatus === null || !in_array((string) $entryStatus, $allowedStatuses, true)) {
                        $rejections[] = [
                            'key'    => $key,
                            'reason' => 'status_not_allowed',
                        ];
                        $keepKeys[$key] = true;
                        $payYears[substr((string) $date, 0, 4)] = true;
                        continue;
                    }
                }

                // --- Approved guard: supervisor НЕ может редактировать approved записи ---
                $existingApprovalStatus = $serverRow['approval_status'] ?? null;
                if (!$e82IsAdmin && $existingApprovalStatus === 'approved') {
                    // Supervisor пытается изменить approved запись → reject
                    $rejections[] = [
                        'key'    => $key,
                        'reason' => 'approved_record_immutable',
                    ];
                    $keepKeys[$key] = true;
                    $payYears[substr((string) $date, 0, 4)] = true;
                    continue;
                }
                
                if (!$e82IsAdmin && $clientVersion !== null && (int) $clientVersion !== $serverVersion) {
                    // Конфликт: версия клиента устарела. Entry не принимаем.
                    $conflicts[] = [
                        'key'           => $key,
                        'clientVersion' => (int) $clientVersion,
                        'serverVersion' => $serverVersion,
                        'serverEntry'   => $serverRow ?: null,
                    ];
                    // Запись всё равно считаем «покрытой» payload: она известна
                    // клиенту, SYNC-удаление её не должно трогать.
                    $keepKeys[$key] = true;
                    $payYears[substr((string) $date, 0, 4)] = true;
                    continue;
                }


                // Запись принята — применим её
                $newVersion = $serverVersion + 1;

                // --- E8-2: no-op skip идентичных записей ---
                // Эхо собственного сохранения: версия НЕ растёт, текущая версия
                // отдаётся в appliedVersions, чтобы клиент синхронизировался
                // без ложного конфликта.
                $incomingStatus   = ($entryStatus === null) ? null : (string) $entryStatus;
                $incomingComment  = ($entry['comment'] ?? null) === null ? null : (string) $entry['comment'];
                $incomingApproval = (string) ($entry['approvalStatus'] ?? $entry['approval_status'] ?? 'draft');
                if (
                    $serverRow
                    && (string) $serverRow['status'] === (string) $incomingStatus
                    && (string) ($serverRow['comment'] ?? '') === (string) ($incomingComment ?? '')
                    && (string) ($serverRow['approval_status'] ?? 'draft') === $incomingApproval
                ) {
                    $appliedVersions[$key] = (int) $serverRow['version'];
                    $keepKeys[$key] = true;
                    $payYears[substr((string) $date, 0, 4)] = true;
                    continue;
                }

                $stmtEn->bindValue(':employee_id', $empId, PDO::PARAM_STR);
                $stmtEn->bindValue(':date', $date, PDO::PARAM_STR);
                $stmtEn->bindValue(':status', $entry['status'] ?? null, PDO::PARAM_STR);
                $stmtEn->bindValue(':comment', $entry['comment'] ?? null, PDO::PARAM_STR);
                $stmtEn->bindValue(':approval_status', $entry['approvalStatus'] ?? $entry['approval_status'] ?? 'draft', PDO::PARAM_STR);
                $stmtEn->bindValue(':version', $newVersion, PDO::PARAM_INT);
                $stmtEn->bindValue(':updated_at', $ts, PDO::PARAM_STR);
                $stmtEn->execute();

                // E8: журнал синхронизации.
                sync_log($pdo, 'entry', $key, 'upsert', $ts);

                // E5: журнал аудита
                try {
                    audit($pdo, 'entry.upsert', null, null, 'entry', $key, ['status' => $entry['status'] ?? null, 'date' => $date]);
                } catch (Throwable $_e) { /* non-critical */ }

                // E8-2: применённая версия для клиента.
                $appliedVersions[$key] = $newVersion;

                $keepKeys[$key] = true;
                $payYears[substr((string) $date, 0, 4)] = true;
            }

            // -----------------------------------------------------------
            // SYNC: payload — полное состояние. Записи годов payload,
            // отсутствующие в payload, удаляются (иначе «Очистить» в
            // матрице и удаление сотрудников не сохранялись бы).
            // Годы, не представленные в payload, не трогаем.
            // -----------------------------------------------------------
            if (empty($payYears) && isset($body['year'])) {
                $payYears[(string) (int) $body['year']] = true;
            }
            if (!empty($payYears)) {
                $yearConds = [];
                foreach (array_keys($payYears) as $y) {
                    $yearConds[] = 'date LIKE ' . $pdo->quote($y . '-%');
                }
                $whereYear = implode(' OR ', $yearConds);
                $rows = $pdo->query(
                    "SELECT employee_id, date FROM schedule_entries WHERE $whereYear"
                )->fetchAll(PDO::FETCH_ASSOC);
                // --- E10-4 (2026-09-28): защита календаря от stale-клиента ---
                // Инцидент 2026-09-28 08:52: устаревшая вкладка delete'нула 1360
                // записей календаря через sync-delete (гард E10-2 защищал только
                // employees). Сигнатура stale-клиента: удаление записей у >=10
                // РАЗНЫХ сотрудников за один запрос. Легитимные операции матрицы
                // («Очистить», удаление отпуска) касаются 1-2 сотрудников и под
                // порог не попадают. Блокируем ВСЕ sync-удаления запроса, аудит
                // entry.mass_delete_blocked.
                $staleDelEmps = [];
                foreach ($rows as $row) {
                    $k = $row['employee_id'] . ':' . $row['date'];
                    if (!isset($keepKeys[$k])) {
                        $staleDelEmps[$row['employee_id']] = true;
                    }
                }
                if (count($staleDelEmps) >= 10) {
                    try {
                        audit($pdo, 'entry.mass_delete_blocked', null, null, 'entry',
                            'year:' . implode(',', array_keys($payYears)),
                            ['employeeCount' => count($staleDelEmps),
                             'reason' => '>=10 distinct employees would lose entries in one sync-delete (stale client suspected); server rows kept']);
                    } catch (Throwable $_ae3) { /* non-critical */ }
                    $rows = []; // ничего не удаляем
                }
                $stmtDel = $pdo->prepare(
                    'DELETE FROM schedule_entries WHERE employee_id = :eid AND date = :d'
                );
                $deletedEntries = 0;
                foreach ($rows as $row) {
                    $k = $row['employee_id'] . ':' . $row['date'];
                    if (!isset($keepKeys[$k])) {
                        // --- E8-3: зональная проверка при SYNC-удалении ---
                        // Не-admin (supervisor) не должен удалять записи из чужих зон.
                        if (!$e82IsAdmin && $e82IsSupervisor) {
                            // Кэш зон уже заполнен в entries-цикле, при пустом — выборка по требованию.
                            $empId = $row['employee_id'];
                            if (!array_key_exists($empId, $e82EmpScope)) {
                                if ($e82EmpScopeStmt === null) {
                                    $e82EmpScopeStmt = $pdo->prepare(
                                        'SELECT group_id FROM employees WHERE id = :id LIMIT 1'
                                    );
                                }
                                $e82EmpScopeStmt->execute([':id' => $empId]);
                                $scopeRow = $e82EmpScopeStmt->fetch(PDO::FETCH_COLUMN);
                                $e82EmpScope[$empId] = ($scopeRow !== false && $scopeRow !== null)
                                    ? (string) $scopeRow : null;
                            }
                            $empScope = $e82EmpScope[$empId];
                            $inOwnZone = ($empScope !== null && $e82Scope !== null && $empScope === $e82Scope);
                            // Чужая зона: не удаляем, сохраняем как keepKey.
                            if (!$inOwnZone) {
                                $keepKeys[$k] = true;
                                continue;
                            }
                        }

                        // E5: прочитать удаляемую строку для деталей аудита
                        $delStmt = $pdo->prepare(
                            'SELECT status, comment FROM schedule_entries WHERE employee_id = :eid AND date = :d'
                        );
                        $delStmt->bindValue(':eid', $row['employee_id'], PDO::PARAM_STR);
                        $delStmt->bindValue(':d', $row['date'], PDO::PARAM_STR);
                        $delStmt->execute();
                        $delRow = $delStmt->fetch(PDO::FETCH_ASSOC);
                        $delDetails = [];
                        if ($delRow && is_array($delRow)) {
                            if (isset($delRow['status'])) {
                                $delDetails['status'] = $delRow['status'];
                            }
                            if (isset($delRow['comment']) && $delRow['comment'] !== null) {
                                $delDetails['comment'] = $delRow['comment'];
                            }
                        }

                        $stmtDel->bindValue(':eid', $row['employee_id'], PDO::PARAM_STR);
                        $stmtDel->bindValue(':d', $row['date'], PDO::PARAM_STR);
                        $stmtDel->execute();
                        $deletedEntries++;
                        // E8: журнал синхронизации (удаления).
                        sync_log($pdo, 'entry', $k, 'delete', $ts);

                        // E5: журнал аудита с деталями
                        try {
                            audit($pdo, 'entry.delete', null, null, 'entry', $k, empty($delDetails) ? null : $delDetails);
                        } catch (Throwable $_e) { /* non-critical */ }
                    }
                }
            }
        }

        // ---------------------------------------------------------------
        // holidays (ключ "date" — upsert)
        // ---------------------------------------------------------------
        if (isset($body['holidays']) && (is_array($body['holidays']) || is_object($body['holidays']))) {
            $stmtH = $pdo->prepare(
                'INSERT INTO holidays (date, type, label)
                 VALUES (:date, :type, :label)
                 ON CONFLICT(date) DO UPDATE SET
                    type  = excluded.type,
                    label = excluded.label'
            );
            foreach ((array) $body['holidays'] as $h) {
                if (!is_array($h)) {
                    continue;
                }
                $date = $h['date'] ?? null;
                if ($date === null) {
                    continue;
                }
                $stmtH->bindValue(':date', $date, PDO::PARAM_STR);
                $stmtH->bindValue(':type', $h['type'] ?? 'holiday', PDO::PARAM_STR);
                $stmtH->bindValue(':label', $h['label'] ?? null, PDO::PARAM_STR);
                $stmtH->execute();
            }
        }

        // ---------------------------------------------------------------
        // vacationBalances (ключ "employeeId:year" — upsert)
        // ---------------------------------------------------------------
        if (isset($body['vacationBalances']) && (is_array($body['vacationBalances']) || is_object($body['vacationBalances']))) {
            $stmtV = $pdo->prepare(
                'INSERT INTO vacation_balances
                    (employee_id, year, total_days, used_days, remaining_days)
                 VALUES
                    (:employee_id, :year, :total_days, :used_days, :remaining_days)
                 ON CONFLICT(employee_id, year) DO UPDATE SET
                    total_days     = excluded.total_days,
                    used_days      = excluded.used_days,
                    remaining_days = excluded.remaining_days'
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
                $stmtV->bindValue(':employee_id', $empId, PDO::PARAM_STR);
                $stmtV->bindValue(':year', (int) $year, PDO::PARAM_INT);
                $stmtV->bindValue(':total_days', isset($vb['totalDays']) ? (float) $vb['totalDays'] : (isset($vb['total_days']) ? (float) $vb['total_days'] : null), PDO::PARAM_STR);
                $stmtV->bindValue(':used_days', isset($vb['usedDays']) ? (float) $vb['usedDays'] : (isset($vb['used_days']) ? (float) $vb['used_days'] : null), PDO::PARAM_STR);
                $stmtV->bindValue(':remaining_days', isset($vb['remainingDays']) ? (float) $vb['remainingDays'] : (isset($vb['remaining_days']) ? (float) $vb['remaining_days'] : null), PDO::PARAM_STR);
                $stmtV->execute();
            }
        }

        // ---------------------------------------------------------------
        // year (meta)
        // ---------------------------------------------------------------
        if (isset($body['year'])) {
            $db->setMeta('current_year', (string) (int) $body['year']);
        }

        // E8: ротация журнала синхронизации (не более ~10000 событий).
        sync_log_rotate($pdo);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    sendJson([
        'success' => true,
        'savedAt' => now(),
        // E8: список отклонённых по версии записей (пуст для старого фронта).
        'conflicts' => $conflicts,
        // E8-2: применённые версии 'empId:date' => version (мерж в карту клиента;
        // no-op записи отдают текущую версию без инкремента).
        'appliedVersions' => $appliedVersions,
        // E8-2: по-записные отклонения супервайзера (out_of_scope / status_not_allowed).
        'rejections' => $rejections,
    ]);
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}
