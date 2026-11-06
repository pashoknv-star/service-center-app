<?php

declare(strict_types=1);

/**
 * tasks_rules.php — детерминированные правила блока «Задачи» (T1-1, TZ §3, FR-10/11).
 *
 * Чистые функции поверх PDO (без HTTP/сессий): используются
 *   - api/tasks.php (проверка FR-10 при POST/PUT, вычисляемые поля GET, calendar_facts);
 *   - как эталонная логика для n8n workflow `tasks-validate` (T1-4) и как fallback,
 *     если n8n недоступен.
 *
 * Правила:
 *   1. Дни задачи = все даты от start_at до end_at (end_at NULL → один день).
 *   2. По каждому ИСПОЛНИТЕЛЮ (role=assignee; наблюдатели не учитываются):
 *      день со schedule_entries.status ∈ {sick, trip} или покрытый записью
 *      trips/trip_participants → БЛОК (reason 'sick' | 'trip').
 *      Выходной/праздник (holidays + data/holidays/*.json) и vacation/day_off
 *      в матрице → допустимо, только нейтральная пометка (notes).
 *   3. suggested_start = ближайшая дата ≥ start, начиная с которой весь период
 *      (та же длина) помещается вне блокирующих дней.
 *   4. conflict для открытой задачи вычисляется при GET теми же правилами.
 *
 * Время хранится как локальное (+05), ISO без смещения: 'YYYY-MM-DD' или
 * 'YYYY-MM-DDTHH:MM[:SS]'. Правила оперируют только датами.
 *
 * Точка расширения n8n (T1-4): tasks_external_validate() / tasks_resolve_check_state().
 */

// holidays_provider подключаем как библиотеку (endpoint-часть не исполняется).
if (!defined('HOLIDAYS_PROVIDER_AS_LIB')) {
    define('HOLIDAYS_PROVIDER_AS_LIB', true);
}
require_once __DIR__ . '/holidays_provider.php';

/** Максимальная длина периода задачи, дней. */
const TASKS_MAX_PERIOD_DAYS = 366;

/** Горизонт поиска suggested_start (дней от start). */
const TASKS_SUGGEST_HORIZON_DAYS = 400;

// =====================================================================
// Даты
// =====================================================================

/**
 * Разбирает 'YYYY-MM-DD' или 'YYYY-MM-DDTHH:MM[:SS]'.
 *
 * @return array{date: string, time: ?string}|null null — формат/дата некорректны.
 */
function tasks_parse_when(mixed $v): ?array
{
    if (!is_string($v)) {
        return null;
    }
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/', $v, $m)) {
        return null;
    }
    if (!checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
        return null;
    }
    $time = null;
    if (isset($m[4]) && $m[4] !== '') {
        $h = (int) $m[4];
        $i = (int) $m[5];
        $s = isset($m[6]) && $m[6] !== '' ? (int) $m[6] : 0;
        if ($h > 23 || $i > 59 || $s > 59) {
            return null;
        }
        $time = substr($v, 11);
    }
    return ['date' => substr($v, 0, 10), 'time' => $time];
}

/** Дата 'Y-m-d' + N дней (UTC-арифметика, без влияния DST). */
function tasks_date_add(string $date, int $days): string
{
    $d = new DateTimeImmutable($date . ' 00:00:00', new DateTimeZone('UTC'));
    return $d->modify(($days >= 0 ? '+' : '') . $days . ' day')->format('Y-m-d');
}

/** Число дней между датами (to - from), целое. */
function tasks_date_diff(string $from, string $to): int
{
    $a = new DateTimeImmutable($from . ' 00:00:00', new DateTimeZone('UTC'));
    $b = new DateTimeImmutable($to . ' 00:00:00', new DateTimeZone('UTC'));
    return (int) round(($b->getTimestamp() - $a->getTimestamp()) / 86400);
}

/** @return string[] все даты от $from до $to включительно. */
function tasks_dates_between(string $from, string $to): array
{
    $out = [];
    $n = tasks_date_diff($from, $to);
    for ($i = 0; $i <= $n; $i++) {
        $out[] = tasks_date_add($from, $i);
    }
    return $out;
}

/**
 * Валидирует период задачи.
 *
 * @return array{error: ?string, first_day?: string, last_day?: string, days?: string[]}
 *   error: invalid_start_at | invalid_end_at | end_before_start | period_too_long | null
 */
function tasks_validate_period(mixed $startAt, mixed $endAt): array
{
    $s = tasks_parse_when($startAt);
    if ($s === null) {
        return ['error' => 'invalid_start_at'];
    }
    $e = null;
    if ($endAt !== null && $endAt !== '') {
        $e = tasks_parse_when($endAt);
        if ($e === null) {
            return ['error' => 'invalid_end_at'];
        }
        $diff = tasks_date_diff($s['date'], $e['date']);
        if ($diff < 0) {
            return ['error' => 'end_before_start'];
        }
        if ($diff === 0 && $s['time'] !== null && $e['time'] !== null && strcmp($e['time'], $s['time']) < 0) {
            return ['error' => 'end_before_start'];
        }
        if ($diff + 1 > TASKS_MAX_PERIOD_DAYS) {
            return ['error' => 'period_too_long'];
        }
    }
    $last = $e !== null ? $e['date'] : $s['date'];
    return [
        'error'     => null,
        'first_day' => $s['date'],
        'last_day'  => $last,
        'days'      => tasks_dates_between($s['date'], $last),
    ];
}

// =====================================================================
// Календарные факты
// =====================================================================

/**
 * Тип дня по производственному календарю.
 * Приоритет: таблица holidays (ручные правки) → data/holidays/{год}.json
 * (через holidays_provider_year, с его fallback «выходные + праздники»).
 *
 * @return array{type: string, label: ?string}
 *   type: workday | weekend | holiday | transferred_day_off | working_weekend
 */
function tasks_day_info(PDO $pdo, string $date): array
{
    static $yearCache = [];     // year => holidays map (файлы календаря неизменны в рамках процесса)
    try {
        $st = $pdo->prepare('SELECT type, label FROM holidays WHERE date = :d LIMIT 1');
        $st->execute([':d' => $date]);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        if ($r) {
            return ['type' => (string) $r['type'], 'label' => $r['label'] !== null ? (string) $r['label'] : null];
        }
    } catch (Throwable $_e) {
        // таблицы holidays может не быть в урезанной БД — работаем по файлам
    }
    $year = (int) substr($date, 0, 4);
    if (!isset($yearCache[$year])) {
        $yearCache[$year] = holidays_provider_year($year)['holidays'] ?? [];
    }
    if (isset($yearCache[$year][$date])) {
        $h = $yearCache[$year][$date];
        return [
            'type'  => (string) ($h['type'] ?? 'workday'),
            'label' => isset($h['label']) && $h['label'] !== null ? (string) $h['label'] : null,
        ];
    }
    return ['type' => 'workday', 'label' => null];
}

/** Нерабочий ли тип дня (выходной/праздник/перенос). */
function tasks_is_day_off_type(string $type): bool
{
    return in_array($type, ['weekend', 'holiday', 'transferred_day_off'], true);
}

/**
 * Факты матрицы по сотрудникам за диапазон: статус schedule_entries и покрытие trips.
 *
 * @param string[] $employeeIds
 * @return array<string, array<string, array{status: ?string, trip: ?array{id: string, status: string}}>>
 *   employee_id => date => факт (только даты, где есть статус или trip)
 */
function tasks_matrix_facts(PDO $pdo, array $employeeIds, string $from, string $to): array
{
    $employeeIds = array_values(array_unique(array_map('strval', $employeeIds)));
    $facts = [];
    if ($employeeIds === []) {
        return $facts;
    }
    $in = implode(',', array_fill(0, count($employeeIds), '?'));

    $stmt = $pdo->prepare(
        "SELECT employee_id, date, status FROM schedule_entries
         WHERE employee_id IN ($in) AND date >= ? AND date <= ?"
    );
    $stmt->execute(array_merge($employeeIds, [$from, $to]));
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $facts[(string) $r['employee_id']][(string) $r['date']] = [
            'status' => $r['status'] !== null ? (string) $r['status'] : null,
            'trip'   => null,
        ];
    }

    $stmt = $pdo->prepare(
        "SELECT tp.employee_id, tp.start_date, tp.end_date, t.id AS trip_id, t.status AS trip_status
         FROM trip_participants tp JOIN trips t ON t.id = tp.trip_id
         WHERE tp.employee_id IN ($in) AND tp.start_date <= ? AND tp.end_date >= ?"
    );
    $stmt->execute(array_merge($employeeIds, [$to, $from]));
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $s = max((string) $r['start_date'], $from);
        $e = min((string) $r['end_date'], $to);
        if (tasks_parse_when($s) === null || tasks_parse_when($e) === null || $s > $e) {
            continue;
        }
        foreach (tasks_dates_between($s, $e) as $d) {
            $emp = (string) $r['employee_id'];
            $cur = $facts[$emp][$d] ?? ['status' => null, 'trip' => null];
            if ($cur['trip'] === null) {
                $cur['trip'] = ['id' => (string) $r['trip_id'], 'status' => (string) $r['trip_status']];
            }
            $facts[$emp][$d] = $cur;
        }
    }
    return $facts;
}

/**
 * Блокирующие дни из готовых фактов.
 *
 * @return array<int, array{date: string, employee_id: string, reason: string}>
 *   отсортировано по дате, затем employee_id; reason: 'sick' | 'trip'
 */
function tasks_blocked_from_facts(array $facts, string $from, string $to): array
{
    $out = [];
    foreach ($facts as $emp => $byDate) {
        foreach ($byDate as $date => $f) {
            if ($date < $from || $date > $to) {
                continue;
            }
            $reason = null;
            if (($f['status'] ?? null) === 'sick') {
                $reason = 'sick';
            } elseif (($f['status'] ?? null) === 'trip' || ($f['trip'] ?? null) !== null) {
                $reason = 'trip';
            }
            if ($reason !== null) {
                $out[] = ['date' => (string) $date, 'employee_id' => (string) $emp, 'reason' => $reason];
            }
        }
    }
    usort($out, static function (array $a, array $b): int {
        return [$a['date'], $a['employee_id']] <=> [$b['date'], $b['employee_id']];
    });
    return $out;
}

/**
 * Блокирующие дни (sick/trip) исполнителей в диапазоне.
 *
 * @param string[] $employeeIds
 */
function tasks_blocked_days(PDO $pdo, array $employeeIds, string $from, string $to): array
{
    return tasks_blocked_from_facts(tasks_matrix_facts($pdo, $employeeIds, $from, $to), $from, $to);
}

/**
 * Ближайший старт ≥ $startDate, при котором период длиной $length дней
 * не содержит блокирующих дней ни у одного исполнителя. null — в горизонте нет.
 *
 * @param string[] $employeeIds
 */
function tasks_suggest_start(PDO $pdo, array $employeeIds, string $startDate, int $length): ?string
{
    $length = max(1, $length);
    $limit = tasks_date_add($startDate, TASKS_SUGGEST_HORIZON_DAYS);
    $blocked = tasks_blocked_days($pdo, $employeeIds, $startDate, tasks_date_add($limit, $length - 1));
    $dates = array_values(array_unique(array_column($blocked, 'date')));
    sort($dates);

    $cand = $startDate;
    while ($cand <= $limit) {
        $winEnd = tasks_date_add($cand, $length - 1);
        $lastInWindow = null;
        foreach ($dates as $d) {
            if ($d >= $cand && $d <= $winEnd) {
                $lastInWindow = $d;
            }
        }
        if ($lastInWindow === null) {
            return $cand;
        }
        $cand = tasks_date_add($lastInWindow, 1);
    }
    return null;
}

/**
 * Нейтральные пометки за период: выходной/праздник (по календарю, employee_id=null)
 * и vacation/day_off в матрице исполнителя. Пометки НЕ блокируют.
 *
 * @param string[] $days
 * @return array<int, array{date: string, employee_id: ?string, kind: string, label: ?string}>
 */
function tasks_notes_from_facts(PDO $pdo, array $facts, array $days): array
{
    $notes = [];
    foreach ($days as $d) {
        $info = tasks_day_info($pdo, $d);
        if (tasks_is_day_off_type($info['type'])) {
            $notes[] = [
                'date'        => $d,
                'employee_id' => null,
                'kind'        => $info['type'] === 'holiday' ? 'holiday' : 'weekend',
                'label'       => $info['label'],
            ];
        }
    }
    $set = array_flip($days);
    foreach ($facts as $emp => $byDate) {
        foreach ($byDate as $d => $f) {
            if (!isset($set[$d])) {
                continue;
            }
            $st = $f['status'] ?? null;
            if ($st === 'vacation' || $st === 'day_off') {
                $notes[] = ['date' => (string) $d, 'employee_id' => (string) $emp, 'kind' => $st, 'label' => null];
            }
        }
    }
    usort($notes, static function (array $a, array $b): int {
        return [$a['date'], (string) $a['employee_id'], $a['kind']] <=> [$b['date'], (string) $b['employee_id'], $b['kind']];
    });
    return $notes;
}

/**
 * ЭТАЛОННАЯ проверка FR-10 (используется tasks.php и n8n `tasks-validate`, T1-4).
 *
 * @param string[]    $assigneeIds исполнители (роль assignee)
 * @param string      $startAt     'YYYY-MM-DD[THH:MM[:SS]]'
 * @param string|null $endAt
 * @return array{ok: bool, blocked_days: array, suggested_start: ?string, notes: array,
 *               first_day: string, last_day: string, days: string[]}
 *         или ['error' => код] при некорректном периоде
 */
function tasks_check_period(PDO $pdo, array $assigneeIds, string $startAt, ?string $endAt): array
{
    $p = tasks_validate_period($startAt, $endAt);
    if ($p['error'] !== null) {
        return ['error' => $p['error']];
    }
    $facts = tasks_matrix_facts($pdo, $assigneeIds, $p['first_day'], $p['last_day']);
    $blocked = tasks_blocked_from_facts($facts, $p['first_day'], $p['last_day']);
    $suggested = null;
    if ($blocked !== []) {
        $suggested = tasks_suggest_start($pdo, $assigneeIds, $p['first_day'], count($p['days']));
    }
    return [
        'ok'              => $blocked === [],
        'blocked_days'    => $blocked,
        'suggested_start' => $suggested,
        'notes'           => tasks_notes_from_facts($pdo, $facts, $p['days']),
        'first_day'       => $p['first_day'],
        'last_day'        => $p['last_day'],
        'days'            => $p['days'],
    ];
}

/**
 * Факты календаря для сервисного эндпойнта `?calendar_facts` (токен, n8n).
 * Только статус матрицы, выходной/праздник и trip — без телефонов/фото/ФИО.
 *
 * @param string[] $employeeIds
 * @return array<string, array<int, array>> employee_id => дни диапазона
 */
function tasks_calendar_facts(PDO $pdo, array $employeeIds, string $from, string $to): array
{
    $employeeIds = array_values(array_unique(array_map('strval', $employeeIds)));
    $facts = tasks_matrix_facts($pdo, $employeeIds, $from, $to);
    $dates = tasks_dates_between($from, $to);
    $dayInfo = [];
    foreach ($dates as $d) {
        $dayInfo[$d] = tasks_day_info($pdo, $d);
    }
    $out = [];
    foreach ($employeeIds as $emp) {
        $days = [];
        foreach ($dates as $d) {
            $f = $facts[$emp][$d] ?? null;
            $days[] = [
                'date'           => $d,
                'matrix_status'  => $f['status'] ?? null,
                'day_type'       => $dayInfo[$d]['type'],
                'is_day_off'     => tasks_is_day_off_type($dayInfo[$d]['type']),
                'holiday_label'  => $dayInfo[$d]['label'],
                'trip'           => $f['trip'] ?? null,
            ];
        }
        $out[$emp] = $days;
    }
    return $out;
}

// =====================================================================
// Точка расширения n8n (T1-4)
// =====================================================================

/**
 * Внешняя проверка (n8n webhook `tasks-validate`). В T1-1 вызов НЕ реализован:
 * функция лишь сообщает, настроена ли внешняя проверка (env TASKS_VALIDATE_WEBHOOK_URL).
 * T1-4 заменит тело на HTTP-вызов (таймаут 3 с) и вернёт
 * ['configured'=>true,'available'=>bool,'result'=>array|null].
 *
 * @param array{employees: string[], from: string, to: string} $ctx
 * @return array{configured: bool, available: bool, reason?: string}
 */
function tasks_external_validate(array $ctx): array
{
    $url = getenv('TASKS_VALIDATE_WEBHOOK_URL');
    if (!is_string($url) || $url === '') {
        return ['configured' => false, 'available' => false, 'reason' => 'not_configured'];
    }
    // TODO(T1-4): HTTP POST на webhook с таймаутом 3 с.
    return ['configured' => true, 'available' => false, 'reason' => 'not_implemented'];
}

/**
 * check_state по результату внешней проверки: 'ok' — внешняя проверка не нужна
 * (локальные правила авторитетны) или пройдена; 'pending' — настроена, но недоступна
 * (задача сохраняется, перепроверка по расписанию — AC-8).
 */
function tasks_resolve_check_state(array $external): string
{
    if (empty($external['configured'])) {
        return 'ok';
    }
    return !empty($external['available']) ? 'ok' : 'pending';
}
