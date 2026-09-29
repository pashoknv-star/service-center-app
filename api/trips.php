<?php

declare(strict_types=1);

/**
 * trips.php — фича «Командировки»: CRUD + подтверждение.
 *
 * Контракт (ARCHITECTURE_TRIPS.md, раздел 3). Паттерн E8 из save.php
 * (версии записей + sync_log + audit), НЕ копия entries.php.
 *
 * GET  api/trips.php                          — список всех trips с участниками
 *                                              { success, trips: [...], lastSyncId }
 * POST api/trips.php                          — создание (auth + edit + зона)
 *      body: { title, location?, comment?, status?('forecast'|'confirmed'),
 *              participants: [{employeeId, startDate, endDate}] (>=1),
 *              origin?, hotel?, transportOutRequired?, transportOutMode?,
 *              transportBackRequired?, transportBackMode?, advanceAmount?,
 *              businessProcess?, phone? }
 *              — E12-1, RPA v1.2 (HelpMe); отсутствующие поля -> NULL.
 * PUT  api/trips.php?id=trip_...              — изменение полей/состава/дат
 *      body: { title?, location?, comment?, status?,
 *              participants?: [...], entryVersion?,  (E8-сверка версии)
 *              <те же RPA-поля v1.2, что в POST> }
 * PUT  api/trips.php?id=trip_...&action=confirm — forecast -> confirmed
 *      (E12-2: после UPDATE, в той же транзакции, каждому участнику
 *      ставится заявка в trip_requests для RPA-робота; дубль-защита D4:
 *      участник с уже висящей queued/delivered заявкой пропускается;
 *      сбой очереди НЕ валит confirm — D1)
 * DELETE api/trips.php?id=trip_...            — удаление (confirmed — только admin)
 *
 * Валидация RPA v1.2 (E12-1): advanceAmount — целое >= 0 (иначе 400
 * advance_invalid); transportOutMode/transportBackMode — 'avia' | 'zd'
 * (иначе 400 transport_mode_invalid); origin/hotel/businessProcess/phone —
 * строки (trim, пустая строка -> NULL).
 *
 * Права:
 *   admin      — всё, включая правку/удаление confirmed.
 *   supervisor — create/edit/confirm/delete только своей зоны (scope_group_id),
 *                confirmed — read-only (403 confirmed_immutable).
 *   viewer     — только GET (POST/PUT/DELETE -> 403 через require_edit).
 *
 * Пересечения (в транзакции, ДО вставки): для каждого участника и каждой даты
 * периода проверяется schedule_entries со статусом IN ('vacation','day_off') ->
 * 409 { error: 'overlapping_entry', employeeId, date, status }.
 * 'sick' и legacy 'trip' НЕ блокируют.
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();

/** Актёр для sync_log: имя текущего пользователя или 'api'. */
function trips_sync_actor(): string
{
    $u = current_user();
    return is_array($u) && !empty($u['username']) ? (string) $u['username'] : 'api';
}

/** Записывает событие в sync_log (внутри транзакции trips.php). */
function trips_sync_log(PDO $pdo, string $entityId, string $action, string $ts): void
{
    static $stmt = null;
    if ($stmt === null) {
        $stmt = $pdo->prepare(
            'INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at)
             VALUES (\'trip\', :id, :a, :actor, :ts)'
        );
    }
    $stmt->bindValue(':id', $entityId, PDO::PARAM_STR);
    $stmt->bindValue(':a', $action, PDO::PARAM_STR);
    $stmt->bindValue(':actor', trips_sync_actor(), PDO::PARAM_STR);
    $stmt->bindValue(':ts', $ts, PDO::PARAM_STR);
    $stmt->execute();
}

/** Валидная ли дата в формате YYYY-MM-DD и реальный ли день календаря. */
function trips_valid_date(string $d): bool
{
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) {
        return false;
    }
    // date_create проверяет «правильность» даты (2026-02-30 -> invalid).
    $dt = date_create($d);
    return $dt !== false;
}

/** Полный объект trip с участниками (camelCase) или null. */
function trips_fetch(PDO $pdo, string $id): ?array
{
    $stmtT = $pdo->prepare(
        'SELECT id, title, location, comment, status, version, created_by, created_at, updated_at,
                origin, hotel, transport_out_required, transport_out_mode,
                transport_back_required, transport_back_mode, advance_amount,
                business_process, phone
         FROM trips WHERE id = :id LIMIT 1'
    );
    $stmtT->bindValue(':id', $id, PDO::PARAM_STR);
    $stmtT->execute();
    $row = $stmtT->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }

    $stmtP = $pdo->prepare(
        'SELECT employee_id, start_date, end_date
         FROM trip_participants WHERE trip_id = :id ORDER BY employee_id'
    );
    $stmtP->bindValue(':id', $id, PDO::PARAM_STR);
    $stmtP->execute();
    $participants = [];
    foreach ($stmtP->fetchAll(PDO::FETCH_ASSOC) as $p) {
        $participants[] = [
            'employeeId' => $p['employee_id'],
            'startDate'  => $p['start_date'],
            'endDate'    => $p['end_date'],
        ];
    }

    return [
        'id'           => $row['id'],
        'title'        => $row['title'],
        'location'     => $row['location'],
        'comment'      => $row['comment'],
        'status'       => $row['status'],
        'version'      => (int) $row['version'],
        'createdBy'    => $row['created_by'],
        'createdAt'    => $row['created_at'],
        'updatedAt'    => $row['updated_at'],
        // E12-1: RPA v1.2 (HelpMe). Транспортные флаги — 0/1 (NULL -> 1,
        // т.к. миграция для существующих строк ставит «плечо нужно»).
        'origin'       => $row['origin'],
        'hotel'        => $row['hotel'],
        'transportOutRequired'  => $row['transport_out_required'] === null ? 1 : (int) $row['transport_out_required'],
        'transportOutMode'      => $row['transport_out_mode'],
        'transportBackRequired' => $row['transport_back_required'] === null ? 1 : (int) $row['transport_back_required'],
        'transportBackMode'     => $row['transport_back_mode'],
        'advanceAmount' => $row['advance_amount'] === null ? null : (int) $row['advance_amount'],
        'businessProcess' => $row['business_process'],
        'phone'        => $row['phone'],
        'participants' => $participants,
    ];
}

/**
 * Проверка пересечений с vacation/day_off в schedule_entries.
 * Для каждого участника и каждой даты периода — SELECT по дате.
 *
 * @param PDO   $pdo
 * @param array $participants [{employeeId,startDate,endDate}]
 * @return array|null null если пересечений нет, иначе {employeeId,date,status}
 */
function trips_check_overlaps(PDO $pdo, array $participants): ?array
{
    $stmt = $pdo->prepare(
        "SELECT status FROM schedule_entries
         WHERE employee_id = :eid AND date = :d
           AND status IN ('vacation','day_off') LIMIT 1"
    );
    foreach ($participants as $p) {
        $start = strtotime((string) $p['startDate']);
        $end   = strtotime((string) $p['endDate']);
        if ($start === false || $end === false) {
            continue;
        }
        for ($t = $start; $t <= $end; $t += 86400) {
            $date = date('Y-m-d', $t);
            $stmt->bindValue(':eid', (string) $p['employeeId'], PDO::PARAM_STR);
            $stmt->bindValue(':d', $date, PDO::PARAM_STR);
            $stmt->execute();
            $status = $stmt->fetch(PDO::FETCH_COLUMN);
            if ($status !== false && $status !== null) {
                return [
                    'employeeId' => (string) $p['employeeId'],
                    'date'       => $date,
                    'status'     => (string) $status,
                ];
            }
        }
    }
    return null;
}

/** Нормализует и валидирует массив участников из body. Возвращает массив участников или null (ошибка уже отправлена). */
function trips_normalize_participants(array $raw, PDO $pdo): ?array
{
    if ($raw === []) {
        sendJson(['error' => 'participants_required'], 400);
    }
    $participants = [];
    $empIds = [];
    foreach ($raw as $p) {
        if (!is_array($p)) {
            sendJson(['error' => 'invalid_participant'], 400);
        }
        $empId    = $p['employeeId'] ?? $p['employee_id'] ?? null;
        $startDate = (string) ($p['startDate'] ?? $p['start_date'] ?? '');
        $endDate   = (string) ($p['endDate'] ?? $p['end_date'] ?? '');
        if ($empId === null || $empId === '') {
            sendJson(['error' => 'missing_employee_id'], 400);
        }
        if ($startDate === '' || $endDate === '') {
            sendJson(['error' => 'missing_dates'], 400);
        }
        if (!trips_valid_date($startDate) || !trips_valid_date($endDate)) {
            sendJson(['error' => 'invalid_date'], 400);
        }
        if (strtotime($endDate) < strtotime($startDate)) {
            sendJson(['error' => 'date_range_invalid'], 400);
        }
        // Сотрудник должен существовать.
        $stmtE = $pdo->prepare('SELECT id FROM employees WHERE id = :id LIMIT 1');
        $stmtE->bindValue(':id', (string) $empId, PDO::PARAM_STR);
        $stmtE->execute();
        if (!$stmtE->fetch()) {
            sendJson(['error' => 'participant_not_found'], 400);
        }
        $participants[] = [
            'employeeId' => (string) $empId,
            'startDate'  => $startDate,
            'endDate'    => $endDate,
        ];
        $empIds[] = (string) $empId;
    }
    return $participants !== [] ? $participants : null;
}

/**
 * E12-1: нормализует и валидирует RPA-поля v1.2 (HelpMe) из body.
 *
 * @param array $body       Тело запроса (POST/PUT).
 * @param bool  $isPut      true для PUT (отсутствующее поле = «не менять»).
 * @param array $existing    Текущий trip (только для PUT).
 * @return array Значения для INSERT/UPDATE: ключ -> значение (или NULL).
 */
function trips_normalize_rpa_fields(array $body, bool $isPut, array $existing = []): array
{
    // --- Строки: origin/hotel/businessProcess/phone (trim, '' -> NULL) ---
    $textFields = [
        'origin'          => 'origin',
        'hotel'           => 'hotel',
        'businessProcess' => 'business_process',
        'phone'           => 'phone',
    ];
    $out = [];
    foreach ($textFields as $bodyKey => $col) {
        if (!$isPut || array_key_exists($bodyKey, $body)) {
            $v = isset($body[$bodyKey]) && $body[$bodyKey] !== null ? trim((string) $body[$bodyKey]) : '';
            $out[$col] = $v !== '' ? $v : null;
        }
    }

    // --- Целочисленные флаги: transportOutRequired/transportBackRequired ---
    $boolFields = [
        'transportOutRequired'  => 'transport_out_required',
        'transportBackRequired' => 'transport_back_required',
    ];
    foreach ($boolFields as $bodyKey => $col) {
        if (!$isPut || array_key_exists($bodyKey, $body)) {
            $raw = $body[$bodyKey] ?? null;
            if ($raw === null || $raw === '') {
                $out[$col] = null; // поле отсутствует/пустое -> NULL (POST)
            } elseif (is_bool($raw)) {
                $out[$col] = $raw ? 1 : 0;
            } elseif (is_int($raw)) {
                $out[$col] = $raw === 0 ? 0 : 1;
            } elseif (is_string($raw) && ($raw === '0' || $raw === '1')) {
                $out[$col] = (int) $raw;
            } else {
                $out[$col] = 1; // «плечо нужно» — толерантная интерпретация truthy
            }
        }
    }

    // --- Сумма аванса: целое >= 0, иначе 400 advance_invalid ---
    if (!$isPut || array_key_exists('advanceAmount', $body)) {
        $raw = $body['advanceAmount'] ?? null;
        if ($raw === null || $raw === '') {
            $out['advance_amount'] = null;
        } elseif (is_int($raw) && $raw >= 0) {
            $out['advance_amount'] = $raw;
        } elseif (is_string($raw) && preg_match('/^\d+$/', $raw) === 1) {
            $out['advance_amount'] = (int) $raw;
        } else {
            sendJson(['error' => 'advance_invalid'], 400);
        }
    }

    // --- Способ «выезд»/«возврат»: только 'avia' | 'zd' ---
    $modeFields = [
        'transportOutMode'  => 'transport_out_mode',
        'transportBackMode' => 'transport_back_mode',
    ];
    foreach ($modeFields as $bodyKey => $col) {
        if (!$isPut || array_key_exists($bodyKey, $body)) {
            $raw = $body[$bodyKey] ?? null;
            if ($raw === null || $raw === '') {
                $out[$col] = null;
            } elseif (is_string($raw) && in_array($raw, ['avia', 'zd'], true)) {
                $out[$col] = $raw;
            } else {
                sendJson(['error' => 'transport_mode_invalid'], 400);
            }
        }
    }

    return $out;
}

/**
 * E12-2: строит payload заявки RPA-роботу (контракт v1.2, HelpMe).
 *
 * Даты — DD.MM.YYYY; days = dateEnd - dateStart + 1 (включительно).
 * D5: sentAt — МОМЕНТ ГЕНЕРАЦИИ payload (now()), а не дата поездки.
 * D6: fullName берётся из employees.full_name вызывающей стороной;
 *     NULL-строки нормализуются в '' (роботу не уходят JSON-null).
 *
 * @param string $requestId ID заявки (generateRequestId()).
 * @param array  $trip      Полный trip из trips_fetch() (camelCase).
 * @param array  $p         Участник {employeeId, startDate, endDate, fullName}.
 * @return array Payload для JSON-колонки trip_requests.payload.
 */
function trips_build_rpa_payload(string $requestId, array $trip, array $p): array
{
    $tsStart = strtotime((string) $p['startDate']);
    $tsEnd   = strtotime((string) $p['endDate']);
    $dateStart = $tsStart !== false ? date('d.m.Y', $tsStart) : (string) $p['startDate'];
    $dateEnd   = $tsEnd   !== false ? date('d.m.Y', $tsEnd)   : (string) $p['endDate'];
    $days = ($tsStart !== false && $tsEnd !== false)
        ? (int) round(($tsEnd - $tsStart) / 86400) + 1
        : 1;

    $origin      = (string) ($trip['origin'] ?? '');
    $destination = (string) ($trip['location'] ?? '');

    return [
        'requestId' => $requestId,
        'sentAt'    => now(), // D5: момент генерации, не дата поездки
        'employee'  => [
            'fullName' => (string) ($p['fullName'] ?? ''), // D6: NULL -> ''
            'phone'    => (string) ($trip['phone'] ?? ''), // NULL -> ''
        ],
        'trip'      => [
            'destination' => $destination,
            'origin'      => $origin,
            'dateStart'   => $dateStart,
            'dateEnd'     => $dateEnd,
            'details'     => (string) ($trip['comment'] ?? ''),
            'hotel'       => (string) ($trip['hotel'] ?? ''),
            'days'        => $days,
        ],
        'transport' => [
            'out'  => [
                'required' => (int) ($trip['transportOutRequired'] ?? 1),
                'mode'     => (string) ($trip['transportOutMode'] ?? ''),
                'from'     => $origin,
                'to'       => $destination,
            ],
            'back' => [
                'required' => (int) ($trip['transportBackRequired'] ?? 1),
                'mode'     => (string) ($trip['transportBackMode'] ?? ''),
                'from'     => $destination,
                'to'       => $origin,
            ],
        ],
        'businessProcess' => (string) ($trip['businessProcess'] ?? ''),
        'advance'         => ['amount' => $trip['advanceAmount'] ?? null],
    ];
}

try {
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $user = current_user();
    $isAdmin = is_array($user) && !empty($user['is_admin']);
    $scopeGroupId = is_array($user) && !empty($user['scope_group_id'])
        ? (string) $user['scope_group_id'] : null;

    // -----------------------------------------------------------------
    // GET: список всех trips (любая роль; зонального фильтра чтения НЕТ — E8-4).
    // -----------------------------------------------------------------
    if ($method === 'GET') {
        require_auth();
        $tripRows = $pdo->query(
            'SELECT id FROM trips ORDER BY created_at DESC, id'
        )->fetchAll(PDO::FETCH_COLUMN);
        $trips = [];
        foreach ($tripRows as $tid) {
            $t = trips_fetch($pdo, (string) $tid);
            if ($t !== null) {
                $trips[] = $t;
            }
        }
        $lastSyncId = (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM sync_log')->fetchColumn();
        sendJson([
            'success'    => true,
            'trips'      => $trips,
            'lastSyncId' => $lastSyncId,
        ]);
    }

    // Любые мутации требуют прав редактирования.
    require_edit();

    // -----------------------------------------------------------------
    // POST: создание.
    // -----------------------------------------------------------------
    if ($method === 'POST') {
        $body = getJsonBody();
        $title = isset($body['title']) ? trim((string) $body['title']) : '';
        if ($title === '') {
            sendJson(['error' => 'title_required'], 400);
        }
        $location = isset($body['location']) ? (string) $body['location'] : null;
        $comment  = isset($body['comment']) ? (string) $body['comment'] : null;
        $status   = isset($body['status']) ? (string) $body['status'] : 'forecast';
        if (!in_array($status, ['forecast', 'confirmed'], true)) {
            sendJson(['error' => 'invalid_status'], 400);
        }
        $rawParticipants = $body['participants'] ?? null;
        if (!is_array($rawParticipants) || $rawParticipants === []) {
            sendJson(['error' => 'participants_required'], 400);
        }

        // Валидация списка участников и существования сотрудников.
        $participants = trips_normalize_participants($rawParticipants, $pdo);

        // E12-1: RPA-поля v1.2 (отсутствующие -> NULL).
        $rpa = trips_normalize_rpa_fields($body, false);

        $pdo->beginTransaction();
        try {
            // --- Зона: не-admin (supervisor) — все участники должны быть его зоны ---
            if (!$isAdmin) {
                $foreign = [];
                $stmtZ = $pdo->prepare('SELECT group_id FROM employees WHERE id = :id LIMIT 1');
                $scopeCache = [];
                foreach ($participants as $p) {
                    $eid = $p['employeeId'];
                    if (!array_key_exists($eid, $scopeCache)) {
                        $stmtZ->bindValue(':id', $eid, PDO::PARAM_STR);
                        $stmtZ->execute();
                        $g = $stmtZ->fetch(PDO::FETCH_COLUMN);
                        $scopeCache[$eid] = ($g !== false && $g !== null) ? (string) $g : null;
                    }
                    $inOwnZone = ($scopeCache[$eid] !== null && $scopeGroupId !== null
                        && $scopeCache[$eid] === $scopeGroupId);
                    if (!$inOwnZone) {
                        $foreign[] = $eid;
                    }
                }
                if ($foreign !== []) {
                    sendJson(['error' => 'zone_forbidden', 'foreignEmployees' => $foreign], 403);
                }
            }

            // --- Пересечения (vacation/day_off) ДО вставки ---
            $overlap = trips_check_overlaps($pdo, $participants);
            if ($overlap !== null) {
                sendJson([
                    'error'      => 'overlapping_entry',
                    'employeeId' => $overlap['employeeId'],
                    'date'       => $overlap['date'],
                    'status'     => $overlap['status'],
                ], 409);
            }

            // --- Вставка ---
            $id = genId('trip_');
            $ts = now();
            $username = is_array($user) && !empty($user['username'])
                ? (string) $user['username'] : 'api';
            $stmtTrip = $pdo->prepare(
                'INSERT INTO trips (id, title, location, comment, status, version, created_by, created_at, updated_at,
                                    origin, hotel, transport_out_required, transport_out_mode,
                                    transport_back_required, transport_back_mode, advance_amount,
                                    business_process, phone)
                 VALUES (:id, :title, :location, :comment, :status, 1, :created_by, :ts, :ts,
                         :origin, :hotel, :transport_out_required, :transport_out_mode,
                         :transport_back_required, :transport_back_mode, :advance_amount,
                         :business_process, :phone)'
            );
            $stmtTrip->bindValue(':id', $id, PDO::PARAM_STR);
            $stmtTrip->bindValue(':title', $title, PDO::PARAM_STR);
            $stmtTrip->bindValue(':location', $location, PDO::PARAM_STR);
            $stmtTrip->bindValue(':comment', $comment, PDO::PARAM_STR);
            $stmtTrip->bindValue(':status', $status, PDO::PARAM_STR);
            $stmtTrip->bindValue(':created_by', $username, PDO::PARAM_STR);
            $stmtTrip->bindValue(':ts', $ts, PDO::PARAM_STR);
            $stmtTrip->bindValue(':origin', $rpa['origin'], PDO::PARAM_STR);
            $stmtTrip->bindValue(':hotel', $rpa['hotel'], PDO::PARAM_STR);
            $stmtTrip->bindValue(':transport_out_required', $rpa['transport_out_required'] === null ? null : (int) $rpa['transport_out_required'], PDO::PARAM_INT);
            $stmtTrip->bindValue(':transport_out_mode', $rpa['transport_out_mode'], PDO::PARAM_STR);
            $stmtTrip->bindValue(':transport_back_required', $rpa['transport_back_required'] === null ? null : (int) $rpa['transport_back_required'], PDO::PARAM_INT);
            $stmtTrip->bindValue(':transport_back_mode', $rpa['transport_back_mode'], PDO::PARAM_STR);
            $stmtTrip->bindValue(':advance_amount', $rpa['advance_amount'] === null ? null : (int) $rpa['advance_amount'], PDO::PARAM_INT);
            $stmtTrip->bindValue(':business_process', $rpa['business_process'], PDO::PARAM_STR);
            $stmtTrip->bindValue(':phone', $rpa['phone'], PDO::PARAM_STR);
            $stmtTrip->execute();

            $stmtPart = $pdo->prepare(
                'INSERT INTO trip_participants (trip_id, employee_id, start_date, end_date)
                 VALUES (:trip_id, :employee_id, :start_date, :end_date)'
            );
            foreach ($participants as $p) {
                $stmtPart->bindValue(':trip_id', $id, PDO::PARAM_STR);
                $stmtPart->bindValue(':employee_id', $p['employeeId'], PDO::PARAM_STR);
                $stmtPart->bindValue(':start_date', $p['startDate'], PDO::PARAM_STR);
                $stmtPart->bindValue(':end_date', $p['endDate'], PDO::PARAM_STR);
                $stmtPart->execute();
            }

            trips_sync_log($pdo, $id, 'upsert', $ts);
            try {
                audit($pdo, 'trip.create', null, null, 'trip', $id, [
                    'title'        => $title,
                    'status'       => $status,
                    'participants' => count($participants),
                ]);
            } catch (Throwable $_e) { /* non-critical */ }

            $pdo->commit();

            sendJson([
                'success' => true,
                'trip'    => trips_fetch($pdo, $id),
            ], 201);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    // -----------------------------------------------------------------
    // PUT / DELETE: требуют id.
    // -----------------------------------------------------------------
    $id = isset($_GET['id']) ? (string) $_GET['id'] : '';
    if ($id === '') {
        sendJson(['error' => 'missing_id'], 400);
    }

    $existing = trips_fetch($pdo, $id);
    if ($existing === null) {
        sendJson(['error' => 'not_found'], 404);
    }

    // Зонная проверка trip: не-admin должен иметь право на ВСЕХ участников.
    if (!$isAdmin) {
        $foreign = [];
        $stmtZ = $pdo->prepare('SELECT group_id FROM employees WHERE id = :id LIMIT 1');
        $scopeCache = [];
        foreach ($existing['participants'] as $p) {
            $eid = $p['employeeId'];
            if (!array_key_exists($eid, $scopeCache)) {
                $stmtZ->bindValue(':id', $eid, PDO::PARAM_STR);
                $stmtZ->execute();
                $g = $stmtZ->fetch(PDO::FETCH_COLUMN);
                $scopeCache[$eid] = ($g !== false && $g !== null) ? (string) $g : null;
            }
            if ($scopeCache[$eid] === null || $scopeGroupId === null || $scopeCache[$eid] !== $scopeGroupId) {
                $foreign[] = $eid;
            }
        }
        if ($foreign !== []) {
            sendJson(['error' => 'zone_forbidden', 'foreignEmployees' => $foreign], 403);
        }
    }

    // -----------------------------------------------------------------
    // DELETE.
    // -----------------------------------------------------------------
    if ($method === 'DELETE') {
        if ($existing['status'] === 'confirmed' && !$isAdmin) {
            sendJson(['error' => 'confirmed_immutable'], 403);
        }
        $pdo->beginTransaction();
        try {
            $ts = now();
            // CASCADE удалит участников.
            $stmtDel = $pdo->prepare('DELETE FROM trips WHERE id = :id');
            $stmtDel->bindValue(':id', $id, PDO::PARAM_STR);
            $stmtDel->execute();

            trips_sync_log($pdo, $id, 'delete', $ts);
            try {
                audit($pdo, 'trip.delete', null, null, 'trip', $id, [
                    'title'  => $existing['title'],
                    'status' => $existing['status'],
                ]);
            } catch (Throwable $_e) { /* non-critical */ }

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        sendJson(['success' => true, 'deleted' => true]);
    }

    // -----------------------------------------------------------------
    // PUT: изменение / подтверждение.
    // -----------------------------------------------------------------
    if ($method === 'PUT') {
        $action = isset($_GET['action']) ? (string) $_GET['action'] : '';
        $body = getJsonBody();

        // --- PUT ?action=confirm: forecast -> confirmed ---
        if ($action === 'confirm') {
            if ($existing['status'] === 'confirmed') {
                // Повторное подтверждение — no-op, отдаём текущий объект.
                sendJson(['success' => true, 'trip' => $existing]);
            }
            if ($existing['status'] !== 'forecast') {
                sendJson(['error' => 'invalid_status_transition'], 400);
            }
            // Гвард не нужен: до этой точки статус === forecast, а зонная
            // проверка по существующим участникам уже выполнена выше
            // (zone_forbidden). Спека §6/D2: confirm разрешён admin и
            // supervisor своей зоны; confirmed остаётся admin-only для
            // правки/удаления (гварды ниже в PUT/DELETE).

            $pdo->beginTransaction();
            try {
                $ts = now();
                $newVersion = (int) $existing['version'] + 1;
                $stmtUpd = $pdo->prepare(
                    'UPDATE trips SET status = :status, version = :version, updated_at = :ts WHERE id = :id'
                );
                $stmtUpd->bindValue(':status', 'confirmed', PDO::PARAM_STR);
                $stmtUpd->bindValue(':version', $newVersion, PDO::PARAM_INT);
                $stmtUpd->bindValue(':ts', $ts, PDO::PARAM_STR);
                $stmtUpd->bindValue(':id', $id, PDO::PARAM_STR);
                $stmtUpd->execute();

                // --- E12-2: заявка RPA-роботу на КАЖДОГО участника (в той же
                // транзакции). D1: сбой очереди НЕ валит confirm; D4: дубль-
                // защита — участник с уже висящей queued/delivered заявкой
                // по этому trip пропускается (повторный confirm-цикл не
                // плодит строки).
                try {
                    $stmtDup = $pdo->prepare(
                        "SELECT 1 FROM trip_requests
                         WHERE trip_id = :tid AND employee_id = :eid
                           AND status IN ('queued','delivered') LIMIT 1"
                    );
                    $stmtReq = $pdo->prepare(
                        'INSERT INTO trip_requests
                            (request_id, trip_id, employee_id, payload, status, attempts, created_at)
                         VALUES
                            (:request_id, :trip_id, :employee_id, :payload, :status, 0, :created_at)'
                    );
                    foreach ($existing['participants'] as $pnum => $p) {
                        $eid = (string) $p['employeeId'];
                        $stmtDup->bindValue(':tid', $id, PDO::PARAM_STR);
                        $stmtDup->bindValue(':eid', $eid, PDO::PARAM_STR);
                        $stmtDup->execute();
                        if ($stmtDup->fetch(PDO::FETCH_COLUMN)) {
                            continue; // D4: заявка уже queued/delivered — не дублируем
                        }
                        // D6: ФИО из employees; сотрудник мог быть удалён —
                        // тогда fullName='' (payload всё равно строится).
                        $stmtEmp = $pdo->prepare(
                            'SELECT full_name FROM employees WHERE id = :id LIMIT 1'
                        );
                        $stmtEmp->bindValue(':id', $eid, PDO::PARAM_STR);
                        $stmtEmp->execute();
                        $fullName = $stmtEmp->fetch(PDO::FETCH_COLUMN);
                        $p['fullName'] = is_string($fullName) ? $fullName : '';

                        $requestId = generateRequestId($id, $pnum + 1);
                        $payload = trips_build_rpa_payload($requestId, $existing, $p);
                        $stmtReq->bindValue(':request_id', $requestId, PDO::PARAM_STR);
                        $stmtReq->bindValue(':trip_id', $id, PDO::PARAM_STR);
                        $stmtReq->bindValue(':employee_id', $eid, PDO::PARAM_STR);
                        $stmtReq->bindValue(
                            ':payload',
                            json_encode($payload, JSON_UNESCAPED_UNICODE),
                            PDO::PARAM_STR
                        );
                        $stmtReq->bindValue(':status', 'queued', PDO::PARAM_STR);
                        $stmtReq->bindValue(':created_at', $ts, PDO::PARAM_STR);
                        $stmtReq->execute();
                    }
                } catch (Throwable $_relay) {
                    // D1: очередь — не причина срыва подтверждения.
                    error_log('E12-2: trip_requests enqueue failed (confirm continues): ' . $_relay->getMessage());
                }

                trips_sync_log($pdo, $id, 'upsert', $ts);
                try {
                    audit($pdo, 'trip.confirm', null, null, 'trip', $id, [
                        'title' => $existing['title'],
                    ]);
                } catch (Throwable $_e) { /* non-critical */ }

                $pdo->commit();
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }
            sendJson(['success' => true, 'trip' => trips_fetch($pdo, $id)]);
        }

        // --- Обычный PUT: изменение полей/состава/дат ---
        // Гвард подтверждённых: confirmed правится только admin.
        if ($existing['status'] === 'confirmed' && !$isAdmin) {
            sendJson(['error' => 'confirmed_immutable'], 403);
        }

        // E8: сверка версии при наличии entryVersion в body.
        // Для trips.php гвард версии действует для ВСЕХ пользователей (включая
        // admin) — контракт trips требует НЕ перезаписывать молча (в отличие от
        // save.php, где admin-оверрайд разрешён). Совпало/отсутствует — применяем.
        $clientVersion = $body['entryVersion'] ?? $body['version'] ?? null;
        $serverVersion = (int) $existing['version'];
        if ($clientVersion !== null && (int) $clientVersion !== $serverVersion) {
            sendJson([
                'error'         => 'version_conflict',
                'clientVersion' => (int) $clientVersion,
                'serverVersion' => $serverVersion,
                'serverTrip'    => $existing,
            ], 409);
        }

        // Новый состав (если передан) нормализуем и валидируем.
        $participants = $existing['participants'];
        if (array_key_exists('participants', $body)) {
            $raw = $body['participants'];
            if (!is_array($raw) || $raw === []) {
                sendJson(['error' => 'participants_required'], 400);
            }
            $participants = trips_normalize_participants($raw, $pdo);
        }

        $newTitle = array_key_exists('title', $body) ? trim((string) $body['title']) : $existing['title'];
        if ($newTitle === '') {
            sendJson(['error' => 'title_required'], 400);
        }
        $newLocation = array_key_exists('location', $body) ? (string) $body['location'] : $existing['location'];
        $newComment  = array_key_exists('comment', $body) ? (string) $body['comment'] : $existing['comment'];
        $newStatus   = array_key_exists('status', $body) ? (string) $body['status'] : $existing['status'];
        if (!in_array($newStatus, ['forecast', 'confirmed'], true)) {
            sendJson(['error' => 'invalid_status'], 400);
        }

        // E12-1: RPA-поля v1.2. В PUT отсутствующее поле = «не менять».
        // Для флагов/аванса NULL в body ($raw === null) тоже означает «не менять».
        $rpa = trips_normalize_rpa_fields($body, true, $existing);
        $rpaUpdate = [];
        $flagCols = ['transport_out_required', 'transport_back_required'];
        foreach ($rpa as $col => $val) {
            $bodyKey = [
                'origin'                  => 'origin',
                'hotel'                   => 'hotel',
                'business_process'        => 'businessProcess',
                'phone'                   => 'phone',
                'transport_out_required'  => 'transportOutRequired',
                'transport_back_required' => 'transportBackRequired',
                'advance_amount'          => 'advanceAmount',
                'transport_out_mode'      => 'transportOutMode',
                'transport_back_mode'     => 'transportBackMode',
            ][$col];
            if (!array_key_exists($bodyKey, $body)) {
                continue; // поле не передано — оставляем текущее значение
            }
            if (in_array($col, $flagCols, true) && $val === null) {
                continue; // null у флага в PUT = «не менять»
            }
            if ($col === 'advance_amount' && $val === null && ($body['advanceAmount'] ?? null) !== null) {
                continue; // непустой сброс аванса в NULL не предусмотрен контрактом
            }
            $rpaUpdate[$col] = $val;
        }

        // Зонная проверка нового состава.
        if (!$isAdmin) {
            $foreign = [];
            $stmtZ = $pdo->prepare('SELECT group_id FROM employees WHERE id = :id LIMIT 1');
            $scopeCache = [];
            foreach ($participants as $p) {
                $eid = $p['employeeId'];
                if (!array_key_exists($eid, $scopeCache)) {
                    $stmtZ->bindValue(':id', $eid, PDO::PARAM_STR);
                    $stmtZ->execute();
                    $g = $stmtZ->fetch(PDO::FETCH_COLUMN);
                    $scopeCache[$eid] = ($g !== false && $g !== null) ? (string) $g : null;
                }
                if ($scopeCache[$eid] === null || $scopeGroupId === null || $scopeCache[$eid] !== $scopeGroupId) {
                    $foreign[] = $eid;
                }
            }
            if ($foreign !== []) {
                sendJson(['error' => 'zone_forbidden', 'foreignEmployees' => $foreign], 403);
            }
        }

        $pdo->beginTransaction();
        try {
            // Пересечения НОВОГО набора участников/дат (исключая самого себя —
            // trip не конфликтует сам с собой: schedule_entries не содержит
            // записей от trips, поэтому проверка по schedule_entries безопасна).
            $overlap = trips_check_overlaps($pdo, $participants);
            if ($overlap !== null) {
                sendJson([
                    'error'      => 'overlapping_entry',
                    'employeeId' => $overlap['employeeId'],
                    'date'       => $overlap['date'],
                    'status'     => $overlap['status'],
                ], 409);
            }

            $ts = now();
            $newVersion = $serverVersion + 1;
            // E12-1: динамические SET-части для RPA-полей (только переданные).
            $rpaSetSql = '';
            foreach (array_keys($rpaUpdate) as $i => $col) {
                $rpaSetSql .= ", {$col} = :rpa{$i}";
            }
            $stmtUpd = $pdo->prepare(
                'UPDATE trips SET title = :title, location = :location, comment = :comment,
                        status = :status, version = :version, updated_at = :ts
                        ' . $rpaSetSql . '
                 WHERE id = :id'
            );
            $stmtUpd->bindValue(':title', $newTitle, PDO::PARAM_STR);
            $stmtUpd->bindValue(':location', $newLocation, PDO::PARAM_STR);
            $stmtUpd->bindValue(':comment', $newComment, PDO::PARAM_STR);
            $stmtUpd->bindValue(':status', $newStatus, PDO::PARAM_STR);
            $stmtUpd->bindValue(':version', $newVersion, PDO::PARAM_INT);
            $stmtUpd->bindValue(':ts', $ts, PDO::PARAM_STR);
            $stmtUpd->bindValue(':id', $id, PDO::PARAM_STR);
            foreach (array_keys($rpaUpdate) as $i => $col) {
                $val = $rpaUpdate[$col];
                if ($val === null) {
                    $stmtUpd->bindValue(":rpa{$i}", null, PDO::PARAM_NULL);
                } elseif (is_int($val)) {
                    $stmtUpd->bindValue(":rpa{$i}", $val, PDO::PARAM_INT);
                } else {
                    $stmtUpd->bindValue(":rpa{$i}", (string) $val, PDO::PARAM_STR);
                }
            }
            $stmtUpd->execute();

            // Полная замена набора участников.
            $stmtDelP = $pdo->prepare('DELETE FROM trip_participants WHERE trip_id = :id');
            $stmtDelP->bindValue(':id', $id, PDO::PARAM_STR);
            $stmtDelP->execute();

            $stmtPart = $pdo->prepare(
                'INSERT INTO trip_participants (trip_id, employee_id, start_date, end_date)
                 VALUES (:trip_id, :employee_id, :start_date, :end_date)'
            );
            foreach ($participants as $p) {
                $stmtPart->bindValue(':trip_id', $id, PDO::PARAM_STR);
                $stmtPart->bindValue(':employee_id', $p['employeeId'], PDO::PARAM_STR);
                $stmtPart->bindValue(':start_date', $p['startDate'], PDO::PARAM_STR);
                $stmtPart->bindValue(':end_date', $p['endDate'], PDO::PARAM_STR);
                $stmtPart->execute();
            }

            trips_sync_log($pdo, $id, 'upsert', $ts);
            try {
                audit($pdo, 'trip.update', null, null, 'trip', $id, [
                    'title'  => $newTitle,
                    'status' => $newStatus,
                ]);
            } catch (Throwable $_e) { /* non-critical */ }

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        sendJson(['success' => true, 'trip' => trips_fetch($pdo, $id)]);
    }

    sendJson(['error' => 'Method not allowed'], 405);
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}