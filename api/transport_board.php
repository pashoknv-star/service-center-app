<?php

declare(strict_types=1);

/**
 * transport_board.php — модуль «Транспорт» (V10-T6): API доски. Только чтение.
 * Контракт — reports/V10/specs/CONTRACT.md «transport_board.php», спека — reports/V10/specs/T6_board_journal_api.md.
 *
 * GET api/transport_board.php?from=YYYY-MM-DD&to=YYYY-MM-DD   — любой авторизованный (чужие заявки видны всем ролям)
 *   Период — не длиннее 31 дня ВКЛЮЧИТЕЛЬНО (to − from + 1 ≤ 31); иначе 422 range_too_long {max_days}.
 *   {
 *     success, from, to,
 *     can_move_vehicle: bool,                                  // admin или viewer (transport_can_move_vehicle)
 *     bases: [{ id, name, sort_order, vehicles: [{ id, name, plate, base_id, status, default_driver_id, sort_order, version }] }],
 *     assignments: [{                                          // назначения, пересекающие период; сортировка start_at, id
 *         id, request_id, vehicle_id, base_id (текущая база ТС), driver_id, driver_name,
 *         crew: [{ employee_id, name }], stops: [{ ord, kind, place, lat, lon, stay_min, leg_km, leg_min_map, leg_min }],
 *         start_at, end_at, duration_min, version,
 *         days: [YYYY-MM-DD…],                                  // дни периода, которые назначение занимает (через полночь — оба)
 *         request: { id, display_no, title, subscriber, address, status, version, created_by, created_by_name, can_edit }
 *     }],
 *     queue: [ request… ],                                     // нераспределённые: status = new и нет назначений (от периода не зависит)
 *     queue_truncated: bool,                                   // очередь обрезана TB_QUEUE_MAX
 *     absences: [{ employee_id, date, type }]                  // type: vacation | sick | day_off | trip | trip_forecast
 *   }
 *
 * Как устроен запрос (без N+1). Число SQL-запросов не зависит от числа назначений: ровно по одному запросу на таблицу
 * (базы, ТС, назначения JOIN заявки, бригада, остановки, очередь, отпуска/больничные, командировки) + постоянные запросы
 * transport_allowed_drivers() (3) + при делегировании прав один запрос users; ответ собирается в PHP из индексированных
 * массивов. Проверяет сьют transportboard (K3 — счётчик выполнений запросов).
 *
 * Отсутствия — только факт и тип (employee_id, date, type): без комментариев, целей и мест командировок, телефонов.
 * Учитываются сотрудники, которые нужны доске: допустимые водители (группа «Транспорт» ∪ пул) и водители/бригада назначений периода.
 * Время — наивная локальная строка +05 «YYYY-MM-DDTHH:MM»; назначение занимает полуинтервал [start_at, end_at).
 *
 * Ошибки ({"error":"<код>"}): 401 unauthorized; 405 method_not_allowed; 422 invalid_from / invalid_to / invalid_range /
 * range_too_long; 500 server_error. Ничего не пишет (ни данные, ни журнал).
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/transport_lib.php';

/** Максимальная длина периода доски, дней (включительно). */
const TB_MAX_DAYS = 31;
/** Максимум заявок в очереди нераспределённых (сверх — queue_truncated). */
const TB_QUEUE_MAX = 500;
/** Максимум идентификаторов в SQL-списке IN для ограничения отсутствий (больше — фильтр только в PHP). */
const TB_IN_LIMIT = 500;
/** Статусы schedule_entries, считающиеся отсутствием → тип на доске. */
const TB_ABSENCE_STATUS = ['vacation' => 'vacation', 'sick' => 'sick', 'dayoff' => 'day_off', 'day_off' => 'day_off', 'trip' => 'trip'];

// =====================================================================
// Разбор параметров
// =====================================================================

/** Строгая дата YYYY-MM-DD (реальная календарная); иначе null. */
function tb_valid_date(mixed $v): ?string
{
    if (!is_string($v) || preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m) !== 1) {
        return null;
    }
    return checkdate((int) $m[2], (int) $m[3], (int) $m[1]) ? $v : null;
}

/** Следующий календарный день, 'YYYY-MM-DD'. */
function tb_next_day(string $date): string
{
    return (new DateTimeImmutable($date))->modify('+1 day')->format('Y-m-d');
}

/**
 * Период из запроса: [from, to]. 422 invalid_from / invalid_to / invalid_range / range_too_long.
 *
 * @return array{0:string,1:string}
 */
function tb_parse_range(): array
{
    $from = tb_valid_date($_GET['from'] ?? null);
    if ($from === null) {
        transport_fail('invalid_from', 422);
    }
    $to = tb_valid_date($_GET['to'] ?? null);
    if ($to === null) {
        transport_fail('invalid_to', 422);
    }
    if ($to < $from) {
        transport_fail('invalid_range', 422);
    }
    $days = (int) (new DateTimeImmutable($from))->diff(new DateTimeImmutable($to))->days + 1;
    if ($days > TB_MAX_DAYS) {
        transport_fail('range_too_long', 422, ['max_days' => TB_MAX_DAYS]);
    }
    return [$from, $to];
}

// =====================================================================
// Права: can_edit пакетом (без запроса на каждую заявку)
// =====================================================================

/**
 * can_edit для набора заявок за ≤ 1 запрос. Правило — то же, что transport_can_edit_request() (transport_lib.php):
 * admin — любая; supervisor — своя (created_by = users.id) и заявки авторов из TRANSPORT_EDIT_DELEGATION (по логину автора);
 * viewer и аноним — никогда. Эквивалентность проверяет сьют transportboard (K1) по всем парам «пользователь × автор».
 *
 * @param list<array> $requests заявки (нужны id, created_by)
 * @param array|null  $user     строка users; null — текущий пользователь сессии
 * @return array<string,bool>   request id → can_edit
 */
function tb_can_edit_map(PDO $pdo, array $requests, ?array $user = null): array
{
    $u = transport_user($user);
    $role = $u === null ? '' : user_role($u);
    $out = [];
    if ($role === 'admin') {
        foreach ($requests as $r) { $out[(string) $r['id']] = true; }
        return $out;
    }
    if ($role !== 'supervisor') {
        foreach ($requests as $r) { $out[(string) $r['id']] = false; }
        return $out;
    }
    $self = (string) ($u['id'] ?? '');
    $delegates = TRANSPORT_EDIT_DELEGATION[(string) ($u['username'] ?? '')] ?? [];
    $logins = [];
    if ($delegates !== []) {
        $authors = [];
        foreach ($requests as $r) {
            $a = (string) ($r['created_by'] ?? '');
            if ($a !== '' && $a !== $self) { $authors[$a] = true; }
        }
        $authors = array_keys($authors);
        foreach (array_chunk($authors, 400) as $chunk) {
            $in = implode(',', array_fill(0, count($chunk), '?'));
            $st = $pdo->prepare("SELECT id, username FROM users WHERE id IN ($in)");
            $st->execute($chunk);
            foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $logins[(string) $row['id']] = (string) $row['username'];
            }
        }
    }
    foreach ($requests as $r) {
        $a = (string) ($r['created_by'] ?? '');
        if ($a === '') {
            $can = false;
        } elseif ($a === $self) {
            $can = true;
        } else {
            $can = isset($logins[$a]) && in_array($logins[$a], $delegates, true);
        }
        $out[(string) $r['id']] = $can;
    }
    return $out;
}

// =====================================================================
// Сборка доски
// =====================================================================

/** Карточка заявки (одинаковая в назначении и в очереди). */
function tb_request_card(array $r, bool $canEdit): array
{
    return [
        'id'              => (string) $r['id'],
        'display_no'      => $r['display_no'] === null ? null : (int) $r['display_no'],
        'title'           => (string) $r['title'],
        'subscriber'      => $r['subscriber'] === null ? null : (string) $r['subscriber'],
        'address'         => $r['address'] === null ? null : (string) $r['address'],
        'status'          => (string) $r['status'],
        'version'         => (int) $r['version'],
        'created_by'      => $r['created_by'] === null ? null : (string) $r['created_by'],
        'created_by_name' => $r['created_by_name'] === null ? null : (string) $r['created_by_name'],
        'can_edit'        => $canEdit,
    ];
}

/** Календарные дни [from..to] (включительно), YYYY-MM-DD; пусто, если from > to. */
function tb_days(string $from, string $to): array
{
    $days = [];
    if ($from > $to) {
        return $days;
    }
    $d = new DateTimeImmutable($from);
    $end = new DateTimeImmutable($to);
    while ($d <= $end) {
        $days[] = $d->format('Y-m-d');
        $d = $d->modify('+1 day');
    }
    return $days;
}

/**
 * Дни периода [$from..$to], которые занимает назначение [start_at, end_at): последний занятый день — день момента
 * end_at − 1 минута (конец ровно в 00:00 следующего дня этот день не занимает).
 */
function tb_assignment_days(string $startAt, string $endAt, string $from, string $to): array
{
    try {
        $first = substr($startAt, 0, 10);
        $last = (new DateTimeImmutable($endAt))->modify('-1 minute')->format('Y-m-d');
    } catch (Throwable $e) {
        return [];
    }
    return tb_days(max($first, $from), min($last, $to));
}

/**
 * Доска за период. Не пишет в БД.
 *
 * @param array|null $user строка users; null — текущий пользователь сессии
 * @return array<string,mixed>
 */
function tb_build_board(PDO $pdo, string $from, string $to, ?array $user = null): array
{
    $wFrom = $from . 'T00:00';                 // начало периода
    $wTo = tb_next_day($to) . 'T00:00';        // конец периода (исключая)

    // ---- Базы и ТС (2 запроса)
    $bases = [];
    foreach ($pdo->query('SELECT id, name, sort_order FROM transport_bases ORDER BY sort_order, name, id')->fetchAll(PDO::FETCH_ASSOC) as $b) {
        $bases[(string) $b['id']] = ['id' => (string) $b['id'], 'name' => (string) $b['name'], 'sort_order' => (int) $b['sort_order'], 'vehicles' => []];
    }
    $vehBase = [];
    $vq = $pdo->query('SELECT id, name, plate, base_id, status, default_driver_id, sort_order, version FROM vehicles ORDER BY sort_order, name, id');
    foreach ($vq->fetchAll(PDO::FETCH_ASSOC) as $v) {
        $vehBase[(string) $v['id']] = (string) $v['base_id'];
        if (!isset($bases[(string) $v['base_id']])) {
            continue;   // защита: ТС с неизвестной базой (FK это запрещает) на доске не показываем
        }
        $bases[(string) $v['base_id']]['vehicles'][] = [
            'id'                => (string) $v['id'],
            'name'              => (string) $v['name'],
            'plate'             => (string) $v['plate'],
            'base_id'           => (string) $v['base_id'],
            'status'            => (string) $v['status'],
            'default_driver_id' => $v['default_driver_id'] === null ? null : (string) $v['default_driver_id'],
            'sort_order'        => (int) $v['sort_order'],
            'version'           => (int) $v['version'],
        ];
    }

    // ---- Назначения периода + заявки (1 запрос), бригада (1), остановки (1)
    $win = 'a.start_at < :wto AND a.end_at > :wfrom';
    $st = $pdo->prepare(
        "SELECT a.id AS a_id, a.request_id, a.vehicle_id, a.driver_id, a.driver_name_snap, a.start_at, a.duration_min, a.end_at,
                a.version AS a_version,
                r.id AS r_id, r.display_no, r.title, r.subscriber, r.address, r.status AS r_status, r.version AS r_version,
                r.created_by, r.created_by_name
         FROM transport_assignments a JOIN transport_requests r ON r.id = a.request_id
         WHERE $win ORDER BY a.start_at, a.id"
    );
    $st->execute([':wto' => $wTo, ':wfrom' => $wFrom]);
    $asgRows = $st->fetchAll(PDO::FETCH_ASSOC);

    $crew = [];
    $st = $pdo->prepare(
        "SELECT c.assignment_id, c.employee_id, c.name_snap FROM assignment_crew c
         JOIN transport_assignments a ON a.id = c.assignment_id WHERE $win ORDER BY c.assignment_id, c.rowid"
    );
    $st->execute([':wto' => $wTo, ':wfrom' => $wFrom]);
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $c) {
        $crew[(string) $c['assignment_id']][] = ['employee_id' => (string) $c['employee_id'], 'name' => (string) ($c['name_snap'] ?? '')];
    }

    $stops = [];
    $st = $pdo->prepare(
        "SELECT s.assignment_id, s.ord, s.kind, s.place, s.lat, s.lon, s.stay_min, s.leg_km, s.leg_min_map, s.leg_min
         FROM assignment_stops s JOIN transport_assignments a ON a.id = s.assignment_id WHERE $win ORDER BY s.assignment_id, s.ord"
    );
    $st->execute([':wto' => $wTo, ':wfrom' => $wFrom]);
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $s) {
        $stops[(string) $s['assignment_id']][] = [
            'ord'         => (int) $s['ord'],
            'kind'        => (string) $s['kind'],
            'place'       => (string) $s['place'],
            'lat'         => $s['lat'] === null ? null : (float) $s['lat'],
            'lon'         => $s['lon'] === null ? null : (float) $s['lon'],
            'stay_min'    => (int) $s['stay_min'],
            'leg_km'      => $s['leg_km'] === null ? null : (float) $s['leg_km'],
            'leg_min_map' => $s['leg_min_map'] === null ? null : (int) $s['leg_min_map'],
            'leg_min'     => (int) $s['leg_min'],
        ];
    }

    // ---- Очередь нераспределённых (1 запрос; на 1 строку больше лимита — признак обрезки)
    $qRows = $pdo->query(
        'SELECT r.id, r.display_no, r.title, r.subscriber, r.address, r.status, r.version, r.created_by, r.created_by_name
         FROM transport_requests r
         WHERE r.status = \'new\' AND NOT EXISTS (SELECT 1 FROM transport_assignments a WHERE a.request_id = r.id)
         ORDER BY (r.display_no IS NULL), r.display_no, r.created_at, r.id LIMIT ' . (TB_QUEUE_MAX + 1)
    )->fetchAll(PDO::FETCH_ASSOC);
    $queueTruncated = count($qRows) > TB_QUEUE_MAX;
    $qRows = array_slice($qRows, 0, TB_QUEUE_MAX);

    // ---- can_edit пакетом (≤ 1 запрос)
    $reqForEdit = [];
    foreach ($asgRows as $r) {
        $reqForEdit[(string) $r['r_id']] = ['id' => (string) $r['r_id'], 'created_by' => $r['created_by']];
    }
    foreach ($qRows as $r) {
        $reqForEdit[(string) $r['id']] = ['id' => (string) $r['id'], 'created_by' => $r['created_by']];
    }
    $canEdit = tb_can_edit_map($pdo, array_values($reqForEdit), $user);

    // ---- Сборка назначений
    $assignments = [];
    $relevant = [];   // сотрудники, нужные доске: водители/бригада назначений периода
    foreach ($asgRows as $r) {
        $aid = (string) $r['a_id'];
        $request = [
            'id' => $r['r_id'], 'display_no' => $r['display_no'], 'title' => $r['title'], 'subscriber' => $r['subscriber'],
            'address' => $r['address'], 'status' => $r['r_status'], 'version' => $r['r_version'],
            'created_by' => $r['created_by'], 'created_by_name' => $r['created_by_name'],
        ];
        $relevant[(string) $r['driver_id']] = true;
        foreach ($crew[$aid] ?? [] as $c) { $relevant[$c['employee_id']] = true; }
        $assignments[] = [
            'id'           => $aid,
            'request_id'   => (string) $r['request_id'],
            'vehicle_id'   => (string) $r['vehicle_id'],
            'base_id'      => $vehBase[(string) $r['vehicle_id']] ?? null,
            'driver_id'    => (string) $r['driver_id'],
            'driver_name'  => (string) ($r['driver_name_snap'] ?? ''),
            'crew'         => $crew[$aid] ?? [],
            'stops'        => $stops[$aid] ?? [],
            'start_at'     => (string) $r['start_at'],
            'end_at'       => (string) $r['end_at'],
            'duration_min' => (int) $r['duration_min'],
            'version'      => (int) $r['a_version'],
            'days'         => tb_assignment_days((string) $r['start_at'], (string) $r['end_at'], $from, $to),
            'request'      => tb_request_card($request, $canEdit[(string) $r['r_id']] ?? false),
        ];
    }
    $queue = [];
    foreach ($qRows as $r) {
        $queue[] = tb_request_card($r, $canEdit[(string) $r['id']] ?? false);
    }

    // ---- Отсутствия: допустимые водители (3 запроса) + отпуска/больничные (1) + командировки (1)
    $allowed = array_map(fn(array $d): string => $d['employee_id'], transport_allowed_drivers($pdo));
    foreach ($allowed as $id) { $relevant[$id] = true; }
    $absences = tb_absences($pdo, $from, $to, $wFrom, $wTo, $allowed, $relevant);

    return [
        'success'          => true,
        'from'             => $from,
        'to'               => $to,
        'can_move_vehicle' => transport_can_move_vehicle($user),
        'bases'            => array_values($bases),
        'assignments'      => $assignments,
        'queue'            => $queue,
        'queue_truncated'  => $queueTruncated,
        'absences'         => $absences,
    ];
}

/**
 * Отсутствия сотрудников доски за [$from..$to]: [{employee_id, date, type}] (только факт и тип; без комментариев и мест).
 * Источники: schedule_entries (vacation, sick, dayoff/day_off, trip) и trips + trip_participants (confirmed → trip,
 * forecast → trip_forecast; период участника обрезается периодом доски). Сортировка: дата, сотрудник, тип; дубли схлопнуты.
 *
 * @param list<string>      $allowed  допустимые водители (идентификаторы)
 * @param array<string,true> $relevant сотрудники, которых показывает доска
 * @return list<array{employee_id:string,date:string,type:string}>
 */
function tb_absences(PDO $pdo, string $from, string $to, string $wFrom, string $wTo, array $allowed, array $relevant): array
{
    // Ограничение по сотрудникам в SQL: участники назначений периода (подзапросы) + допустимые водители (список IN).
    $emp = '(%1$s IN (SELECT a.driver_id FROM transport_assignments a WHERE a.start_at < :wto1 AND a.end_at > :wfrom1)
          OR %1$s IN (SELECT c.employee_id FROM assignment_crew c JOIN transport_assignments a ON a.id = c.assignment_id
                      WHERE a.start_at < :wto2 AND a.end_at > :wfrom2)';
    $params = [':wto1' => $wTo, ':wfrom1' => $wFrom, ':wto2' => $wTo, ':wfrom2' => $wFrom];
    $extra = '';
    if ($allowed !== [] && count($allowed) <= TB_IN_LIMIT) {
        $ph = [];
        foreach (array_values($allowed) as $i => $id) {
            $ph[] = ':d' . $i;
            $params[':d' . $i] = $id;
        }
        $extra = ' OR %1$s IN (' . implode(',', $ph) . ')';
    } elseif ($allowed !== []) {
        $extra = ' OR 1';   // слишком много водителей для списка IN: фильтр по сотрудникам остаётся на стороне PHP
    }
    $empSql = static fn(string $col): string => sprintf($emp . $extra . ')', $col);

    $found = [];
    $statusIn = "'" . implode("','", array_keys(TB_ABSENCE_STATUS)) . "'";

    $st = $pdo->prepare(
        "SELECT s.employee_id, s.date, s.status FROM schedule_entries s
         WHERE s.date >= :f AND s.date <= :t AND s.status IN ($statusIn) AND " . $empSql('s.employee_id')
    );
    $st->execute($params + [':f' => $from, ':t' => $to]);
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $e = (string) $r['employee_id'];
        $d = (string) $r['date'];
        $type = TB_ABSENCE_STATUS[(string) $r['status']] ?? null;
        if ($type === null || !isset($relevant[$e]) || tb_valid_date($d) === null) {
            continue;
        }
        $found[$d . '|' . $e . '|' . $type] = ['employee_id' => $e, 'date' => $d, 'type' => $type];
    }

    $st = $pdo->prepare(
        'SELECT tp.employee_id, tp.start_date, tp.end_date, t.status FROM trip_participants tp JOIN trips t ON t.id = tp.trip_id
         WHERE tp.start_date <= :t AND tp.end_date >= :f AND ' . $empSql('tp.employee_id')
    );
    $st->execute($params + [':f' => $from, ':t' => $to]);
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $e = (string) $r['employee_id'];
        $s = tb_valid_date($r['start_date']);
        $en = tb_valid_date($r['end_date']);
        if (!isset($relevant[$e]) || $s === null || $en === null) {
            continue;
        }
        $type = (string) $r['status'] === 'forecast' ? 'trip_forecast' : 'trip';
        foreach (tb_days(max($s, $from), min($en, $to)) as $d) {
            $found[$d . '|' . $e . '|' . $type] = ['employee_id' => $e, 'date' => $d, 'type' => $type];
        }
    }

    ksort($found, SORT_STRING);
    return array_values($found);
}

// =====================================================================
// Основной блок (не выполняется, если файл подключён тестом как библиотека)
// =====================================================================

if (!defined('TRANSPORT_BOARD_LIB_ONLY')) {
    handleOptions();
    transport_handle(function (): void {
        $db = Database::getInstance();
        $pdo = $db->getPDO();
        $db->migrate();

        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        require_auth();   // аноним → 401 (раньше проверки метода: не раскрываем устройство API анониму)
        if ($method !== 'GET') {
            transport_fail('method_not_allowed', 405);
        }
        [$from, $to] = tb_parse_range();
        sendJson(tb_build_board($pdo, $from, $to));
    });
}
