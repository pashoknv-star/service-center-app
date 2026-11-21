<?php

declare(strict_types=1);

/**
 * transport_warnings.php — внутренняя библиотека модуля «Транспорт» (V10-T5): предупреждения назначений и confirm_token.
 * НЕ HTTP-эндпоинт (прямой запрос → 404). Подключается из api/transport_assignments.php. Контракт — CONTRACT.md часть 2.
 *
 * Предупреждения не блокируют запись: подтверждаются confirm_token'ом, выданным для ЭТОГО набора предупреждений.
 * Коды (severity всегда 'warning'; не больше одного предупреждения каждого кода, детали — списками):
 *   vehicle_overlap   — ТС занято другим назначением (интервалы [start_at, end_at); касание границ — не пересечение);
 *   driver_overlap    — водитель занят (другим назначением как водитель ИЛИ как член бригады);
 *   crew_overlap      — член бригады занят (другим назначением как член бригады ИЛИ как водитель);
 *   driver_absent     — у водителя в дни назначения отпуск / больничный / командировка;
 *   crew_absent       — то же для членов бригады;
 *   vehicle_in_repair — vehicles.status = 'repair';
 *   route_sum_mismatch — сумма stay_min + leg_min всех точек маршрута ≠ duration_min (только если маршрут непустой).
 *
 * Назначения заявок в статусе cancelled в пересечениях НЕ учитываются (отменённая заявка ТС/людей не занимает);
 * done — учитываются (работа состоялась в это время).
 *
 * Отсутствия (коды — из исходников, не из памяти):
 *   schedule_entries.status IN ('vacation','sick','trip') — api/save.php:499 (allowedStatuses supervisor: trip/day_off; vacation/sick
 *     пишет только admin), index.html:2544-2570 (VACATION_TYPES / TYPE_CSS / TYPE_TO_STATUS: vacation, sick, trip, dayoff→day_off),
 *     api/db.php:693 (legacy-статус 'trip' в schedule_entries), api/trips.php:56-57 ('sick' и legacy 'trip' не блокируют командировки);
 *     'day_off' (отгул) отсутствием не считается: в контракте только «отпуск/болезнь/командировка»;
 *   trips + trip_participants (api/schema.sql:160-194): период участника start_date..end_date включительно, любой статус
 *     командировки ('forecast' | 'confirmed').
 *   approval_status записи не учитывается (черновик отпуска — тоже плановое отсутствие).
 */

if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath((string) $_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/transport_lib.php';

/** Статусы schedule_entries, считающиеся отсутствием (см. шапку). */
const TRANSPORT_ABSENCE_SCHEDULE_STATUSES = ['vacation', 'sick', 'trip'];
/** Срок жизни confirm_token, секунд. */
const TRANSPORT_CONFIRM_TTL = 1800;
/** Порядок кодов в ответе. */
const TRANSPORT_WARNING_ORDER = [
    'vehicle_in_repair', 'vehicle_overlap', 'driver_overlap', 'crew_overlap', 'driver_absent', 'crew_absent', 'route_sum_mismatch',
];

/** Конец интервала включительно по дням: дата момента end_at − 1 минута (end_at ровно 00:00 не затрагивает следующий день). */
function transport_last_day(string $startAt, string $endAt): string
{
    $end = transport_parse_local($endAt);
    $start = transport_parse_local($startAt);
    if ($end === null || $start === null) {
        return substr($startAt, 0, 10);
    }
    $last = $end->modify('-1 minute')->format('Y-m-d');
    return $last < substr($startAt, 0, 10) ? substr($startAt, 0, 10) : $last;
}

/** Время «ЧЧ:ММ» из 'YYYY-MM-DDTHH:MM' для сообщений. */
function transport_hm(string $t): string
{
    return substr($t, 11, 5);
}

/**
 * Занятость: другие назначения (не отменённых заявок) с пересекающимся интервалом, где участвует любой из $personIds
 * (водитель или член бригады) либо стоит ТС $vehicleId.
 *
 * @param list<string> $personIds
 * @return list<array<string,mixed>> assignment_id, request_id, display_no, start_at, end_at, vehicle_id, driver_id, people (список employee_id)
 */
function transport_find_overlaps(PDO $pdo, string $startAt, string $endAt, ?string $vehicleId, array $personIds, ?string $excludeId): array
{
    $conds = [];
    $args = [':start' => $startAt, ':end' => $endAt, ':ex' => $excludeId ?? ''];
    if ($vehicleId !== null) {
        $conds[] = 'a.vehicle_id = :veh';
        $args[':veh'] = $vehicleId;
    }
    if ($personIds !== []) {
        $ph = [];
        foreach (array_values($personIds) as $i => $pid) {
            $ph[] = ':p' . $i;
            $args[':p' . $i] = $pid;
        }
        $in = implode(',', $ph);
        $conds[] = "a.driver_id IN ($in)";
        $conds[] = "EXISTS (SELECT 1 FROM assignment_crew c WHERE c.assignment_id = a.id AND c.employee_id IN ($in))";
    }
    if ($conds === []) {
        return [];
    }
    $sql = 'SELECT a.id, a.request_id, a.vehicle_id, a.driver_id, a.start_at, a.end_at, r.display_no
            FROM transport_assignments a JOIN transport_requests r ON r.id = a.request_id
            WHERE a.id <> :ex AND r.status <> \'cancelled\' AND a.start_at < :end AND a.end_at > :start
              AND (' . implode(' OR ', $conds) . ')
            ORDER BY a.start_at, a.id';
    $st = $pdo->prepare($sql);
    $st->execute($args);
    $rows = $st->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as &$r) {
        $sc = $pdo->prepare('SELECT employee_id FROM assignment_crew WHERE assignment_id = :a');
        $sc->execute([':a' => $r['id']]);
        $r['people'] = array_merge([(string) $r['driver_id']], array_map('strval', $sc->fetchAll(PDO::FETCH_COLUMN)));
    }
    unset($r);
    return $rows;
}

/** @param list<array<string,mixed>> $rows */
function transport_conflict_details(array $rows): array
{
    return array_map(static fn(array $r): array => [
        'assignment_id' => (string) $r['id'],
        'request_id'    => (string) $r['request_id'],
        'display_no'    => $r['display_no'] === null ? null : (int) $r['display_no'],
        'start_at'      => (string) $r['start_at'],
        'end_at'        => (string) $r['end_at'],
    ], $rows);
}

/** Отсутствия сотрудников за период дат: employee_id → отсортированный список видов ('vacation'|'sick'|'trip'). */
function transport_absences(PDO $pdo, array $employeeIds, string $dayFrom, string $dayTo): array
{
    $out = [];
    $ids = array_values(array_unique(array_map('strval', $employeeIds)));
    if ($ids === []) {
        return $out;
    }
    $in = implode(',', array_fill(0, count($ids), '?'));
    $stIn = implode(',', array_fill(0, count(TRANSPORT_ABSENCE_SCHEDULE_STATUSES), '?'));
    $st = $pdo->prepare(
        "SELECT DISTINCT employee_id, status FROM schedule_entries
         WHERE employee_id IN ($in) AND date >= ? AND date <= ? AND status IN ($stIn)"
    );
    $st->execute(array_merge($ids, [$dayFrom, $dayTo], TRANSPORT_ABSENCE_SCHEDULE_STATUSES));
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $out[(string) $r['employee_id']][(string) $r['status']] = true;
    }
    $st = $pdo->prepare(
        "SELECT DISTINCT p.employee_id FROM trip_participants p JOIN trips t ON t.id = p.trip_id
         WHERE p.employee_id IN ($in) AND p.start_date <= ? AND p.end_date >= ?"
    );
    $st->execute(array_merge($ids, [$dayTo, $dayFrom]));
    foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $eid) {
        $out[(string) $eid]['trip'] = true;
    }
    $res = [];
    foreach ($out as $eid => $kinds) {
        $k = array_keys($kinds);
        sort($k);
        $res[(string) $eid] = $k;
    }
    return $res;
}

/** Названия видов отсутствия для сообщений. */
function transport_absence_label(string $kind): string
{
    return ['vacation' => 'отпуск', 'sick' => 'больничный', 'trip' => 'командировка'][$kind] ?? $kind;
}

/** Имя сотрудника для текста сообщения (в журнал не попадает). */
function transport_employee_name(PDO $pdo, string $id): string
{
    $st = $pdo->prepare('SELECT full_name FROM employees WHERE id = :id');
    $st->execute([':id' => $id]);
    $n = $st->fetchColumn();
    return is_string($n) && $n !== '' ? $n : $id;
}

/**
 * Все предупреждения нормализованного назначения.
 *
 * @param array{vehicle_id:string,driver_id:string,crew:list<string>,start_at:string,end_at:string,duration_min:int,stops:list<array<string,mixed>>} $n
 * @return list<array<string,mixed>> элементы {code, severity, message, …детали, fp}; fp — внутренний отпечаток для confirm_token
 */
function transport_collect_warnings(PDO $pdo, array $n, ?string $excludeAssignmentId): array
{
    $w = [];
    $start = (string) $n['start_at'];
    $end = (string) $n['end_at'];
    $driver = (string) $n['driver_id'];
    $crew = array_values(array_map('strval', $n['crew']));

    // --- ТС в ремонте ---
    $st = $pdo->prepare('SELECT status FROM vehicles WHERE id = :id');
    $st->execute([':id' => $n['vehicle_id']]);
    if ($st->fetchColumn() === 'repair') {
        $w[] = [
            'code' => 'vehicle_in_repair', 'severity' => 'warning',
            'message' => 'ТС находится в ремонте.',
            'vehicle_id' => (string) $n['vehicle_id'],
            'fp' => 'v:' . $n['vehicle_id'],
        ];
    }

    // --- пересечения интервалов [start_at, end_at) ---
    $vehRows = transport_find_overlaps($pdo, $start, $end, (string) $n['vehicle_id'], [], $excludeAssignmentId);
    $vehRows = array_values(array_filter($vehRows, static fn(array $r): bool => (string) $r['vehicle_id'] === (string) $n['vehicle_id']));
    if ($vehRows !== []) {
        $w[] = [
            'code' => 'vehicle_overlap', 'severity' => 'warning',
            'message' => 'ТС уже занято в это время: ' . implode(', ', array_map(
                static fn(array $r): string => 'заявка №' . ($r['display_no'] ?? '?') . ' (' . transport_hm((string) $r['start_at']) . '–' . transport_hm((string) $r['end_at']) . ')',
                $vehRows
            )) . '.',
            'conflicts' => transport_conflict_details($vehRows),
            'fp' => implode(',', array_map(static fn(array $r): string => (string) $r['id'], $vehRows)),
        ];
    }
    $people = array_values(array_unique(array_merge([$driver], $crew)));
    $busy = transport_find_overlaps($pdo, $start, $end, null, $people, $excludeAssignmentId);
    $drvRows = array_values(array_filter($busy, static fn(array $r): bool => in_array($driver, $r['people'], true)));
    if ($drvRows !== []) {
        $w[] = [
            'code' => 'driver_overlap', 'severity' => 'warning',
            'message' => 'Водитель ' . transport_employee_name($pdo, $driver) . ' уже занят в это время: ' . implode(', ', array_map(
                static fn(array $r): string => 'заявка №' . ($r['display_no'] ?? '?') . ' (' . transport_hm((string) $r['start_at']) . '–' . transport_hm((string) $r['end_at']) . ')',
                $drvRows
            )) . '.',
            'employee_id' => $driver,
            'conflicts' => transport_conflict_details($drvRows),
            'fp' => $driver . ':' . implode(',', array_map(static fn(array $r): string => (string) $r['id'], $drvRows)),
        ];
    }
    $crewBusy = [];   // employee_id → [assignment rows]
    foreach ($crew as $eid) {
        foreach ($busy as $r) {
            if (in_array($eid, $r['people'], true)) {
                $crewBusy[$eid][] = $r;
            }
        }
    }
    if ($crewBusy !== []) {
        ksort($crewBusy);
        $names = array_map(static fn(string $e): string => transport_employee_name($pdo, $e), array_keys($crewBusy));
        $all = [];
        $fp = [];
        foreach ($crewBusy as $eid => $rows) {
            foreach ($rows as $r) {
                $all[(string) $r['id']] = $r;
            }
            $fp[] = $eid . ':' . implode(',', array_map(static fn(array $r): string => (string) $r['id'], $rows));
        }
        $w[] = [
            'code' => 'crew_overlap', 'severity' => 'warning',
            'message' => 'Заняты в это время члены бригады: ' . implode(', ', $names) . '.',
            'employee_ids' => array_keys($crewBusy),
            'conflicts' => transport_conflict_details(array_values($all)),
            'fp' => implode(';', $fp),
        ];
    }

    // --- отсутствия в дни назначения ---
    $abs = transport_absences($pdo, $people, substr($start, 0, 10), transport_last_day($start, $end));
    if (isset($abs[$driver])) {
        $w[] = [
            'code' => 'driver_absent', 'severity' => 'warning',
            'message' => 'Водитель ' . transport_employee_name($pdo, $driver) . ': ' . implode(', ', array_map('transport_absence_label', $abs[$driver])) . ' в дни назначения.',
            'employee_id' => $driver,
            'kinds' => $abs[$driver],
            'fp' => $driver . ':' . implode(',', $abs[$driver]),
        ];
    }
    $crewAbs = [];
    foreach ($crew as $eid) {
        if (isset($abs[$eid])) {
            $crewAbs[$eid] = $abs[$eid];
        }
    }
    if ($crewAbs !== []) {
        ksort($crewAbs);
        $parts = [];
        $fp = [];
        foreach ($crewAbs as $eid => $kinds) {
            $parts[] = transport_employee_name($pdo, $eid) . ' (' . implode(', ', array_map('transport_absence_label', $kinds)) . ')';
            $fp[] = $eid . ':' . implode(',', $kinds);
        }
        $w[] = [
            'code' => 'crew_absent', 'severity' => 'warning',
            'message' => 'Члены бригады отсутствуют в дни назначения: ' . implode('; ', $parts) . '.',
            'employee_ids' => array_keys($crewAbs),
            'kinds' => $crewAbs,
            'fp' => implode(';', $fp),
        ];
    }

    // --- сумма маршрута ---
    if ($n['stops'] !== []) {
        $sum = 0;
        foreach ($n['stops'] as $s) {
            $sum += (int) $s['stay_min'] + (int) $s['leg_min'];
        }
        if ($sum !== (int) $n['duration_min']) {
            $w[] = [
                'code' => 'route_sum_mismatch', 'severity' => 'warning',
                'message' => 'Сумма стоянок и времени в пути маршрута (' . $sum . ' мин) не равна длительности назначения (' . $n['duration_min'] . ' мин).',
                'route_min' => $sum,
                'duration_min' => (int) $n['duration_min'],
                'fp' => $sum . '/' . $n['duration_min'],
            ];
        }
    }

    usort($w, static fn(array $a, array $b): int =>
        array_search($a['code'], TRANSPORT_WARNING_ORDER, true) <=> array_search($b['code'], TRANSPORT_WARNING_ORDER, true));
    return $w;
}

/** Предупреждения для клиента: без внутреннего отпечатка. */
function transport_warnings_public(array $warnings): array
{
    return array_map(static function (array $w): array {
        unset($w['fp']);
        return $w;
    }, $warnings);
}

/** Предупреждения для журнала/override_json: без текста сообщений (в них могут быть имена сотрудников) и без отпечатка. */
function transport_warnings_for_journal(array $warnings): ?array
{
    if ($warnings === []) {
        return null;
    }
    return array_map(static function (array $w): array {
        unset($w['fp'], $w['message']);
        return $w;
    }, $warnings);
}

// =====================================================================
// confirm_token
// =====================================================================

/**
 * Отпечаток набора предупреждений: коды + отпечатки конкретных конфликтов (id пересекающихся назначений, сотрудники, виды
 * отсутствия, суммы). Изменился набор — изменился отпечаток — старый токен недействителен.
 */
function transport_warnings_fingerprint(array $warnings): string
{
    $pairs = array_map(static fn(array $w): string => $w['code'] . '=' . $w['fp'], $warnings);
    sort($pairs);
    return hash('sha256', implode("\n", $pairs));
}

/** Ключ подписи: привязан к сессии и пользователю (токен из чужой сессии не годится), отдельного секрета в БД нет. */
function transport_confirm_key(): string
{
    $sid = session_id();
    return hash('sha256', 'transport-confirm|' . (string) $sid . '|' . transport_user_id());
}

function transport_confirm_sign(int $exp, string $scope, string $fingerprint): string
{
    return hash_hmac('sha256', $exp . '|' . transport_user_id() . '|' . $scope . '|' . $fingerprint, transport_confirm_key());
}

/**
 * Выдать токен подтверждения для набора предупреждений.
 *
 * @param string $scope 'create|<request_id>' или 'update|<assignment_id>': токен действует только для этой операции
 */
function transport_confirm_issue(string $scope, array $warnings): string
{
    $exp = time() + TRANSPORT_CONFIRM_TTL;
    return $exp . '.' . transport_confirm_sign($exp, $scope, transport_warnings_fingerprint($warnings));
}

/** Токен годится: строка формата «exp.hmac», не истёк, подпись совпадает с ТЕКУЩИМ набором предупреждений и операцией. */
function transport_confirm_valid(mixed $token, string $scope, array $warnings): bool
{
    if (!is_string($token) || preg_match('/^(\d{1,12})\.([0-9a-f]{64})$/', $token, $m) !== 1) {
        return false;
    }
    $exp = (int) $m[1];
    if ($exp < time() || session_id() === '' || session_id() === false) {
        return false;
    }
    return hash_equals(transport_confirm_sign($exp, $scope, transport_warnings_fingerprint($warnings)), $m[2]);
}
