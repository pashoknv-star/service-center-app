<?php

declare(strict_types=1);

/**
 * transport_assignments.php — модуль «Транспорт» (V10-T5): назначения ТС/водителя/бригады/маршрута на заявку.
 * Контракт — reports/V10/specs/CONTRACT.md «Часть 2»; предупреждения и confirm_token — api/transport_warnings.php.
 *
 * POST   api/transport_assignments.php {request_id, vehicle_id, driver_id, crew:[employee_id…], start_at, duration_min,
 *                                       stops:[{ord?,kind,place,lat?,lon?,stay_min,leg_km?,leg_min_map?,leg_min}],
 *                                       dry_run?:bool, confirm_token?:string}
 *          dry_run:true → 200 {success, warnings:[{code,severity,message,…}], confirm_token}, ничего не пишет;
 *          без dry_run: есть предупреждения и нет подходящего confirm_token → 409 confirmation_required {warnings};
 *          успех → 201 {success, assignment, request:{id,status,version}}; заявка new → assigned автоматически.
 * PUT    api/transport_assignments.php?id= {…те же поля (отсутствующие берутся из текущего назначения), version, dry_run?, confirm_token?}
 *          → 200 {success, assignment, request}; request_id менять нельзя (422 request_change_forbidden).
 * DELETE api/transport_assignments.php?id= → 200 {success, request:{id,status,version}}; последнее назначение удалено → заявка assigned|in_progress → new.
 *
 * Права — как у правки родительской заявки: transport_can_edit_request() (viewer, аноним и «чужая» заявка → 403; проверка раньше
 * валидации и предупреждений, dry_run тоже). Назначения заявок done/cancelled не создаются, не правятся и не удаляются
 * (422 request_closed).
 *
 * Валидация (422, порядок: форма → справочники): invalid_start, invalid_duration, invalid_step (stay_min/leg_min/leg_min_map),
 * invalid_stops, invalid_crew, unknown_vehicle, driver_not_allowed, unknown_employee, driver_in_crew, request_closed,
 * version_required, invalid_version, request_change_forbidden. Прочее: 400 invalid_json; 404 not_found; 409 VERSION_CONFLICT
 * (current_version, assignment) / confirmation_required (warnings); 503 busy.
 *
 * confirm_token привязан к операции (create|request_id / update|assignment_id), пользователю, сессии и ОТПЕЧАТКУ набора предупреждений
 * (коды + конкретные конфликты); срок 30 минут. Любой другой токен (чужой набор, мусор, пустой, не строка) → 409 confirmation_required
 * с актуальным набором. Проверка пересечений и запись — в одной транзакции BEGIN IMMEDIATE (transport_write()): токен проверяется
 * против набора, вычисленного ВНУТРИ транзакции. Журнал (assignment.create | assignment.update | assignment.delete, request.status при
 * автосмене статуса) пишется в той же транзакции; отказы и dry_run журнал не засоряют.
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/transport_lib.php';
require_once __DIR__ . '/transport_warnings.php';

handleOptions();

const TAS_MAX_STOPS = 50;
const TAS_MAX_CREW = 50;
const TAS_PLACE_MAX = 200;
const TAS_KINDS = ['departure', 'intermediate', 'arrival'];

/** Писать могут только admin и supervisor (viewer/аноним → 403 до любых проверок содержимого). */
function tas_require_writer(): void
{
    if (!in_array(transport_role(), ['admin', 'supervisor'], true)) {
        transport_fail('forbidden', 403);
    }
}

/** Кратное 15 неотрицательное целое (stay_min/leg_min/leg_min_map); иначе 422 invalid_step. */
function tas_step_value(mixed $v): int
{
    $i = transport_int($v);
    if ($i === null || !transport_check_step($i)) {
        transport_fail('invalid_step', 422);
    }
    return $i;
}

/**
 * Маршрут: null/нет → []; список точек → нормализованный список по ord.
 *
 * @return list<array<string,mixed>>
 */
function tas_norm_stops(mixed $raw): array
{
    if ($raw === null) {
        return [];
    }
    if (!is_array($raw) || !array_is_list($raw) || count($raw) > TAS_MAX_STOPS) {
        transport_fail('invalid_stops', 422);
    }
    $out = [];
    $seen = [];
    foreach ($raw as $i => $s) {
        if (!is_array($s)) {
            transport_fail('invalid_stops', 422);
        }
        $kind = $s['kind'] ?? null;
        if (!is_string($kind) || !in_array($kind, TAS_KINDS, true)) {
            transport_fail('invalid_stops', 422);
        }
        $place = $s['place'] ?? null;
        $place = is_string($place) ? trim($place) : '';
        if ($place === '' || mb_strlen($place) > TAS_PLACE_MAX) {
            transport_fail('invalid_stops', 422);
        }
        $ord = $i + 1;
        if (array_key_exists('ord', $s) && $s['ord'] !== null) {
            $ord = transport_int($s['ord']);
            if ($ord === null || $ord < 1) {
                transport_fail('invalid_stops', 422);
            }
        }
        if (isset($seen[$ord])) {
            transport_fail('invalid_stops', 422);
        }
        $seen[$ord] = true;
        $coord = static function (mixed $v, float $lim): ?float {
            if ($v === null) {
                return null;
            }
            if ((!is_int($v) && !is_float($v)) || !is_finite((float) $v) || abs((float) $v) > $lim) {
                transport_fail('invalid_stops', 422);
            }
            return (float) $v;
        };
        $km = $s['leg_km'] ?? null;
        if ($km !== null && ((!is_int($km) && !is_float($km)) || !is_finite((float) $km) || $km < 0)) {
            transport_fail('invalid_stops', 422);
        }
        $stay = tas_step_value($s['stay_min'] ?? 0);
        $leg = tas_step_value($s['leg_min'] ?? 0);
        $map = array_key_exists('leg_min_map', $s) && $s['leg_min_map'] !== null ? tas_step_value($s['leg_min_map']) : null;
        $out[] = [
            'ord'         => $ord,
            'kind'        => $kind,
            'place'       => $place,
            'lat'         => $coord($s['lat'] ?? null, 90.0),
            'lon'         => $coord($s['lon'] ?? null, 180.0),
            'stay_min'    => $stay,
            'leg_km'      => $km === null ? null : (float) $km,
            'leg_min_map' => $map,
            'leg_min'     => $leg,
        ];
    }
    usort($out, static fn(array $a, array $b): int => $a['ord'] <=> $b['ord']);
    return $out;
}

/**
 * Нормализация и проверка полей назначения. $cur — текущее назначение (публичный вид) для PUT: отсутствующие поля берутся из него.
 * Порядок проверок: start_at → duration_min → stops → vehicle → driver → crew → driver_in_crew.
 *
 * @return array{vehicle_id:string,driver_id:string,driver_name:string,crew:list<string>,crew_names:array<string,string>,start_at:string,duration_min:int,end_at:string,stops:list<array<string,mixed>>}
 */
function tas_prepare(PDO $pdo, array $body, ?array $cur): array
{
    $startRaw = array_key_exists('start_at', $body) || $cur === null ? ($body['start_at'] ?? null) : $cur['start_at'];
    $start = transport_parse_local($startRaw);
    if ($start === null || (int) $start->format('i') % TRANSPORT_STEP_MIN !== 0) {
        transport_fail('invalid_start', 422);
    }
    $durRaw = array_key_exists('duration_min', $body) || $cur === null ? ($body['duration_min'] ?? null) : $cur['duration_min'];
    $dur = transport_int($durRaw);
    if ($dur === null || $dur <= 0 || $dur > 10080 || !transport_check_step($dur)) {
        transport_fail('invalid_duration', 422);
    }
    $stopsRaw = array_key_exists('stops', $body) || $cur === null ? ($body['stops'] ?? null) : $cur['stops'];
    $stops = tas_norm_stops($stopsRaw);

    $vehicleId = array_key_exists('vehicle_id', $body) || $cur === null ? ($body['vehicle_id'] ?? null) : $cur['vehicle_id'];
    if (!is_string($vehicleId) || $vehicleId === '') {
        transport_fail('unknown_vehicle', 422);
    }
    $st = $pdo->prepare('SELECT 1 FROM vehicles WHERE id = :id');
    $st->execute([':id' => $vehicleId]);
    if ($st->fetchAll() === []) {
        transport_fail('unknown_vehicle', 422);
    }

    $driverId = array_key_exists('driver_id', $body) || $cur === null ? ($body['driver_id'] ?? null) : $cur['driver_id'];
    $driverName = null;
    if (is_string($driverId) && $driverId !== '') {
        foreach (transport_allowed_drivers($pdo) as $d) {
            if ($d['employee_id'] === $driverId) {
                $driverName = $d['name'];
                break;
            }
        }
    }
    if ($driverName === null) {
        transport_fail('driver_not_allowed', 422);
    }

    if (array_key_exists('crew', $body) || $cur === null) {
        $crewRaw = $body['crew'] ?? [];
        if (!is_array($crewRaw) || !array_is_list($crewRaw) || count($crewRaw) > TAS_MAX_CREW) {
            transport_fail('invalid_crew', 422);
        }
    } else {
        $crewRaw = array_map(static fn(array $c): string => $c['employee_id'], $cur['crew']);
    }
    $crew = [];
    foreach ($crewRaw as $c) {
        if (!is_string($c) || $c === '') {
            transport_fail('unknown_employee', 422);
        }
        $crew[$c] = true;
    }
    $crew = array_keys($crew);
    $names = [];
    if ($crew !== []) {
        $in = implode(',', array_fill(0, count($crew), '?'));
        $st = $pdo->prepare("SELECT id, full_name FROM employees WHERE id IN ($in)");
        $st->execute($crew);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $e) {
            $names[(string) $e['id']] = (string) $e['full_name'];
        }
        foreach ($crew as $c) {
            if (!isset($names[$c])) {
                transport_fail('unknown_employee', 422);
            }
        }
    }
    if (in_array($driverId, $crew, true)) {
        transport_fail('driver_in_crew', 422);
    }
    sort($crew);

    return [
        'vehicle_id'   => $vehicleId,
        'driver_id'    => $driverId,
        'driver_name'  => $driverName,
        'crew'         => $crew,
        'crew_names'   => $names,
        'start_at'     => $start->format('Y-m-d\TH:i'),
        'duration_min' => $dur,
        'end_at'       => transport_add_minutes($start, $dur),
        'stops'        => $stops,
    ];
}

/** Состояние назначения для журнала и сравнения «изменилось ли» (идентификаторы, без имён). */
function tas_snapshot(string $requestId, array $n): array
{
    $stops = array_map(static fn(array $s): array => [
        'ord' => $s['ord'], 'kind' => $s['kind'], 'place' => $s['place'], 'lat' => $s['lat'], 'lon' => $s['lon'],
        'stay_min' => $s['stay_min'], 'leg_km' => $s['leg_km'], 'leg_min_map' => $s['leg_min_map'], 'leg_min' => $s['leg_min'],
    ], $n['stops']);
    $crew = $n['crew'];
    sort($crew);
    return [
        'request_id'   => $requestId,
        'vehicle_id'   => (string) $n['vehicle_id'],
        'driver_id'    => (string) $n['driver_id'],
        'crew'         => $crew,
        'start_at'     => (string) $n['start_at'],
        'duration_min' => (int) $n['duration_min'],
        'end_at'       => (string) $n['end_at'],
        'stops'        => $stops,
    ];
}

/** Публичное назначение → нормализованный вид (для снимка «до»). */
function tas_from_public(array $a): array
{
    return [
        'vehicle_id' => $a['vehicle_id'], 'driver_id' => $a['driver_id'],
        'crew' => array_map(static fn(array $c): string => $c['employee_id'], $a['crew']),
        'start_at' => $a['start_at'], 'duration_min' => $a['duration_min'], 'end_at' => $a['end_at'],
        'stops' => $a['stops'],
    ];
}

/** 409 VERSION_CONFLICT с актуальным назначением. */
function tas_version_conflict(PDO $pdo, string $id): never
{
    $cur = transport_assignment_public($pdo, $id);
    transport_fail('VERSION_CONFLICT', 409, [
        'current_version' => $cur !== null ? $cur['version'] : null,
        'assignment'      => $cur,
    ]);
}

/**
 * Предупреждения и подтверждение: пусто → null; непусто и токен подходит ТЕКУЩЕМУ набору → список для журнала;
 * иначе 409 confirmation_required с актуальными предупреждениями.
 *
 * @return list<array<string,mixed>>|null предупреждения для журнала/override_json
 */
function tas_confirm(array $warnings, string $scope, mixed $token): ?array
{
    if ($warnings === []) {
        return null;
    }
    if (!transport_confirm_valid($token, $scope, $warnings)) {
        transport_fail('confirmation_required', 409, ['warnings' => transport_warnings_public($warnings)]);
    }
    return transport_warnings_for_journal($warnings);
}

/** Запись состава бригады и маршрута назначения (старые строки удаляются явно — не зависим от PRAGMA foreign_keys). */
function tas_write_children(PDO $pdo, string $id, array $n): void
{
    $pdo->prepare('DELETE FROM assignment_crew WHERE assignment_id = :a')->execute([':a' => $id]);
    $pdo->prepare('DELETE FROM assignment_stops WHERE assignment_id = :a')->execute([':a' => $id]);
    $ic = $pdo->prepare('INSERT INTO assignment_crew (assignment_id, employee_id, name_snap) VALUES (:a, :e, :n)');
    foreach ($n['crew'] as $eid) {
        $ic->execute([':a' => $id, ':e' => $eid, ':n' => $n['crew_names'][$eid] ?? null]);
    }
    $is = $pdo->prepare(
        'INSERT INTO assignment_stops (assignment_id, ord, kind, place, lat, lon, stay_min, leg_km, leg_min_map, leg_min)
         VALUES (:a, :ord, :k, :p, :lat, :lon, :stay, :km, :map, :leg)'
    );
    foreach ($n['stops'] as $s) {
        $is->execute([':a' => $id, ':ord' => $s['ord'], ':k' => $s['kind'], ':p' => $s['place'], ':lat' => $s['lat'], ':lon' => $s['lon'],
                      ':stay' => $s['stay_min'], ':km' => $s['leg_km'], ':map' => $s['leg_min_map'], ':leg' => $s['leg_min']]);
    }
}

/** Краткий вид заявки для ответов: {id, status, version}. */
function tas_request_brief(PDO $pdo, string $requestId): array
{
    $r = transport_fetch_request($pdo, $requestId) ?? [];
    return ['id' => $requestId, 'status' => (string) ($r['status'] ?? ''), 'version' => (int) ($r['version'] ?? 0)];
}

/** Родительская заявка для записи: 404/403; закрытая (done/cancelled) → 422 request_closed. */
function tas_load_request(PDO $pdo, string $requestId): array
{
    $req = transport_fetch_request($pdo, $requestId);
    if ($req === null) {
        transport_fail('not_found', 404);
    }
    if (!transport_can_edit_request($req, null, $pdo)) {
        transport_fail('forbidden', 403);
    }
    if (in_array($req['status'], ['done', 'cancelled'], true)) {
        transport_fail('request_closed', 422);
    }
    return $req;
}

function tas_flag(array $body, string $key): bool
{
    $v = $body[$key] ?? false;
    return $v === true || $v === 1 || $v === '1' || $v === 'true';
}

/** Заявка new → assigned (первое/любое новое назначение) с версией и записью журнала. */
function tas_auto_assigned(PDO $pdo, array $req): void
{
    if ($req['status'] !== 'new') {
        return;
    }
    $pdo->prepare("UPDATE transport_requests SET status = 'assigned', version = version + 1, updated_at = :ts WHERE id = :id")
        ->execute([':ts' => transport_ts(), ':id' => $req['id']]);
    transport_journal_write($pdo, 'request.status', 'request', (string) $req['id'], ['status' => 'new'], ['status' => 'assigned', 'auto' => true]);
}

// =====================================================================
// Операции
// =====================================================================

function tas_create(PDO $pdo, array $body): void
{
    tas_require_writer();
    $requestId = $body['request_id'] ?? null;
    if (!is_string($requestId) || $requestId === '') {
        transport_fail('not_found', 404);
    }
    tas_load_request($pdo, $requestId);   // 404 / 403 / request_closed — раньше проверки полей
    $n = tas_prepare($pdo, $body, null);
    $scope = 'create|' . $requestId;

    if (tas_flag($body, 'dry_run')) {
        $w = transport_collect_warnings($pdo, $n, null);
        sendJson(['success' => true, 'warnings' => transport_warnings_public($w), 'confirm_token' => transport_confirm_issue($scope, $w)]);
    }

    $token = $body['confirm_token'] ?? null;
    $id = transport_write($pdo, function () use ($pdo, $body, $requestId, $scope, $token): string {
        $req = tas_load_request($pdo, $requestId);
        $n = tas_prepare($pdo, $body, null);
        $warnings = transport_collect_warnings($pdo, $n, null);
        $journalWarnings = tas_confirm($warnings, $scope, $token);

        $id = genId('ta_');
        $ts = transport_ts();
        $pdo->prepare(
            'INSERT INTO transport_assignments (id, request_id, vehicle_id, driver_id, driver_name_snap, start_at, duration_min, end_at,
                                                override_json, version, created_by, created_at, updated_at)
             VALUES (:id, :rid, :veh, :drv, :dn, :start, :dur, :end, :ov, 1, :by, :ts, :ts)'
        )->execute([
            ':id' => $id, ':rid' => $requestId, ':veh' => $n['vehicle_id'], ':drv' => $n['driver_id'], ':dn' => $n['driver_name'],
            ':start' => $n['start_at'], ':dur' => $n['duration_min'], ':end' => $n['end_at'],
            ':ov' => $journalWarnings === null ? null : transport_journal_json($journalWarnings),
            ':by' => transport_user_id(), ':ts' => $ts,
        ]);
        tas_write_children($pdo, $id, $n);
        transport_journal_write($pdo, 'assignment.create', 'assignment', $id, null, tas_snapshot($requestId, $n), $journalWarnings);
        tas_auto_assigned($pdo, $req);
        return $id;
    });
    sendJson([
        'success'    => true,
        'assignment' => transport_assignment_public($pdo, $id),
        'request'    => tas_request_brief($pdo, $requestId),
    ], 201);
}

function tas_update(PDO $pdo, array $body): void
{
    tas_require_writer();
    $id = $_GET['id'] ?? '';
    if (!is_string($id) || trim($id) === '') {
        transport_fail('id_required', 422);
    }
    $row = transport_fetch_assignment($pdo, $id);
    if ($row === null) {
        transport_fail('not_found', 404);
    }
    $requestId = (string) $row['request_id'];
    tas_load_request($pdo, $requestId);
    if (array_key_exists('request_id', $body) && $body['request_id'] !== null && $body['request_id'] !== $requestId) {
        transport_fail('request_change_forbidden', 422);
    }
    $ver = transport_read_version($body);
    if ($ver === null) {
        transport_fail('version_required', 422);
    }
    $scope = 'update|' . $id;
    $dry = tas_flag($body, 'dry_run');
    $token = $body['confirm_token'] ?? null;

    $core = function (bool $inTx) use ($pdo, $id, $requestId, $ver, $body, $scope, $dry, $token): ?array {
        $cur = transport_assignment_public($pdo, $id);
        if ($cur === null) {
            transport_fail('not_found', 404);
        }
        if ($inTx) {
            tas_load_request($pdo, $requestId);
        }
        if ($ver !== $cur['version']) {
            tas_version_conflict($pdo, $id);
        }
        $n = tas_prepare($pdo, $body, $cur);
        $warnings = transport_collect_warnings($pdo, $n, $id);
        if ($dry) {
            sendJson(['success' => true, 'warnings' => transport_warnings_public($warnings), 'confirm_token' => transport_confirm_issue($scope, $warnings)]);
        }
        $before = tas_snapshot($requestId, tas_from_public($cur));
        $after = tas_snapshot($requestId, $n);
        if ($before === $after) {
            return $cur;   // ничего не изменилось: без записи, version не растёт, журнала нет
        }
        $journalWarnings = tas_confirm($warnings, $scope, $token);
        $upd = $pdo->prepare(
            'UPDATE transport_assignments SET vehicle_id = :veh, driver_id = :drv, driver_name_snap = :dn, start_at = :start,
                    duration_min = :dur, end_at = :end, override_json = :ov, version = version + 1, updated_at = :ts
             WHERE id = :id AND version = :v'
        );
        $upd->execute([
            ':veh' => $n['vehicle_id'], ':drv' => $n['driver_id'], ':dn' => $n['driver_name'], ':start' => $n['start_at'],
            ':dur' => $n['duration_min'], ':end' => $n['end_at'],
            ':ov' => $journalWarnings === null ? null : transport_journal_json($journalWarnings),
            ':ts' => transport_ts(), ':id' => $id, ':v' => $ver,
        ]);
        if ($upd->rowCount() !== 1) {
            tas_version_conflict($pdo, $id);
        }
        tas_write_children($pdo, $id, $n);
        transport_journal_write($pdo, 'assignment.update', 'assignment', $id, $before, $after, $journalWarnings);
        return transport_assignment_public($pdo, $id);
    };

    if ($dry) {
        $core(false);   // sendJson внутри
        return;
    }
    $out = transport_write($pdo, static fn(): ?array => $core(true));
    sendJson(['success' => true, 'assignment' => $out, 'request' => tas_request_brief($pdo, $requestId)]);
}

function tas_delete(PDO $pdo): void
{
    tas_require_writer();
    $id = $_GET['id'] ?? '';
    if (!is_string($id) || trim($id) === '') {
        transport_fail('id_required', 422);
    }
    $row = transport_fetch_assignment($pdo, $id);
    if ($row === null) {
        transport_fail('not_found', 404);
    }
    $requestId = (string) $row['request_id'];
    tas_load_request($pdo, $requestId);

    transport_write($pdo, function () use ($pdo, $id, $requestId): void {
        $cur = transport_assignment_public($pdo, $id);
        if ($cur === null) {
            transport_fail('not_found', 404);
        }
        $req = tas_load_request($pdo, $requestId);
        $pdo->prepare('DELETE FROM assignment_crew WHERE assignment_id = :a')->execute([':a' => $id]);
        $pdo->prepare('DELETE FROM assignment_stops WHERE assignment_id = :a')->execute([':a' => $id]);
        $pdo->prepare('DELETE FROM transport_assignments WHERE id = :a')->execute([':a' => $id]);
        transport_journal_write($pdo, 'assignment.delete', 'assignment', $id, tas_snapshot($requestId, tas_from_public($cur)), null);
        $st = $pdo->prepare('SELECT COUNT(*) FROM transport_assignments WHERE request_id = :r');
        $st->execute([':r' => $requestId]);
        $left = (int) $st->fetchColumn();
        if ($left === 0 && in_array($req['status'], ['assigned', 'in_progress'], true)) {
            $pdo->prepare("UPDATE transport_requests SET status = 'new', version = version + 1, updated_at = :ts WHERE id = :id")
                ->execute([':ts' => transport_ts(), ':id' => $requestId]);
            transport_journal_write($pdo, 'request.status', 'request', $requestId, ['status' => (string) $req['status']], ['status' => 'new', 'auto' => true]);
        }
    });
    sendJson(['success' => true, 'request' => tas_request_brief($pdo, $requestId)]);
}

// =====================================================================
// Основной блок
// =====================================================================

transport_handle(function (): void {
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($method, ['POST', 'PUT', 'DELETE'], true)) {
        transport_fail('method_not_allowed', 405);   // чтение назначений — через transport_requests.php (вложено в заявку)
    }
    require_auth();   // аноним → 401

    if ($method === 'DELETE') {
        tas_delete($pdo);
        return;
    }
    $body = transport_read_body();
    if ($method === 'POST') {
        tas_create($pdo, $body);
        return;
    }
    tas_update($pdo, $body);
});
