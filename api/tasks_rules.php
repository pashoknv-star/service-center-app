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
 * n8n (T1-4, раздел «Интеграция с n8n» ниже): tasks_check_period_checked() (вердикт webhook
 * tasks-validate, fallback — эта же PHP-логика), tasks_recheck_pending() (webhook tasks-recheck).
 * Правила продублированы в n8n/code/common.js — менять синхронно (сверка: scripts/n8n_compare.php).
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
// Интеграция с n8n (T1-4): push-модель, приложение → n8n по HTTPS
// =====================================================================
//
// n8n НИКОГДА не вызывает приложение: все факты приложение отправляет в теле запроса.
//   tasks-validate  POST {employee_ids[], from, to, facts} → {blocked_days[], notes[], suggested_start}
//   tasks-recheck   POST {tasks:[{id, employee_ids[], from, to}], facts} → {results:[{id, conflict, blocked_days[]}]}
// Конфигурация — ТОЛЬКО окружение: TASKS_VALIDATE_WEBHOOK_URL, TASKS_RECHECK_WEBHOOK_URL,
// TASKS_N8N_WEBHOOK_SECRET (заголовок X-Tasks-Secret). Без переменных — чистый PHP-режим.
// Секрет и тела запросов в лог не пишутся.

/**
 * Таймаут синхронного вызова tasks-validate, мс (пользователь ждёт ответа; TZ §3: 3 с).
 * Превышение — штатная ситуация (задача сохраняется как pending), не аномалия.
 */
const TASKS_N8N_TIMEOUT_MS = 3000;

/**
 * Таймаут фонового вызова tasks-recheck, мс (D-4, решение владельца 2026-11-10): идёт после ответа
 * пользователю (tasks_send_json_then), поэтому может ждать дольше; задержки n8n на российском VPS допустимы.
 */
const TASKS_N8N_RECHECK_TIMEOUT_MS = 10000;

/** Порог аномалии, мс: вызов n8n дольше 10 с (или фоновый recheck, упёршийся в свой таймаут) → строка `tasks n8n ANOMALY`. */
const TASKS_N8N_ANOMALY_MS = 10000;

/** Заголовок-секрет webhook (header-auth credential в n8n). */
const TASKS_N8N_SECRET_HEADER = 'X-Tasks-Secret';

/** Минимальный интервал между перепроверками pending, с (15 мин; метка в meta). */
const TASKS_RECHECK_INTERVAL_SEC = 900;

/** Максимум задач в одном пакете перепроверки. */
const TASKS_RECHECK_BATCH = 200;

/** Ключ meta с меткой времени (unix-секунды) последней попытки перепроверки. */
const TASKS_RECHECK_META_KEY = 'tasks_recheck_at';

/** @return array{validate_url: string, recheck_url: string, secret: string} */
function tasks_n8n_config(): array
{
    $get = static function (string $k): string {
        $v = getenv($k);
        return is_string($v) ? trim($v) : '';
    };
    return [
        'validate_url' => $get('TASKS_VALIDATE_WEBHOOK_URL'),
        'recheck_url'  => $get('TASKS_RECHECK_WEBHOOK_URL'),
        'secret'       => $get('TASKS_N8N_WEBHOOK_SECRET'),
    ];
}

/**
 * Лог длительности вызова n8n (D-4). Одна строка в error_log, без секрета и без payload.
 *   `tasks n8n ANOMALY workflow=… ms=… reason=…` — вызов не завершился за 10 с: recheck, упёршийся в свой
 *      таймаут, либо любой вызов с ms > TASKS_N8N_ANOMALY_MS;
 *   `tasks n8n timeout workflow=… ms=… limit_ms=…` — таймаут validate (3 с): штатно, задача pending (не аномалия).
 */
function tasks_n8n_log_call(string $workflow, array $r, int $timeoutMs): void
{
    if ($workflow === '') {
        return;
    }
    $reason = (string) ($r['reason'] ?? 'ok');
    $ms = (int) $r['ms'];
    $background = $workflow === 'tasks-recheck';   // фоновый вызов: его таймаут и есть порог аномалии
    if ($ms > TASKS_N8N_ANOMALY_MS || ($reason === 'timeout' && $background)) {
        error_log('tasks n8n ANOMALY workflow=' . $workflow . ' ms=' . $ms . ' reason=' . $reason);
    } elseif ($reason === 'timeout') {
        error_log('tasks n8n timeout workflow=' . $workflow . ' ms=' . $ms . ' limit_ms=' . $timeoutMs);
    }
}

/**
 * POST JSON на webhook n8n с жёстким общим таймаутом; длительность измеряется всегда (поле ms).
 * $workflow ('tasks-validate' | 'tasks-recheck') — для лога таймаутов/аномалий (tasks_n8n_log_call); пусто — без лога.
 *
 * @return array{ok: bool, status: int, json: ?array, reason: ?string, ms: int}
 *   reason (без секретов): no_secret | connect_error | timeout | http_<код> | invalid_json | no_transport
 */
function tasks_n8n_post(string $url, string $secret, array $payload, int $timeoutMs = TASKS_N8N_TIMEOUT_MS, string $workflow = ''): array
{
    $t0 = microtime(true);
    $done = static function (bool $ok, int $status, ?array $json, ?string $reason) use ($t0, $workflow, $timeoutMs): array {
        $r = ['ok' => $ok, 'status' => $status, 'json' => $json, 'reason' => $reason,
              'ms' => (int) round((microtime(true) - $t0) * 1000)];
        if ($reason !== 'no_secret') {   // вызова не было — нечего мерить
            tasks_n8n_log_call($workflow, $r, $timeoutMs);
        }
        return $r;
    };
    if ($secret === '') {
        return $done(false, 0, null, 'no_secret');
    }
    $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($body === false) {
        return $done(false, 0, null, 'invalid_json');
    }
    $headers = ['Content-Type: application/json', 'Accept: application/json', TASKS_N8N_SECRET_HEADER . ': ' . $secret];

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST              => true,
            CURLOPT_POSTFIELDS        => $body,
            CURLOPT_HTTPHEADER        => $headers,
            CURLOPT_RETURNTRANSFER    => true,
            CURLOPT_CONNECTTIMEOUT_MS => $timeoutMs,
            CURLOPT_TIMEOUT_MS        => $timeoutMs,   // общий потолок, включая TLS и ответ
            CURLOPT_FOLLOWLOCATION    => false,
            CURLOPT_NOSIGNAL          => true,
        ]);
        $raw = curl_exec($ch);
        $errno = curl_errno($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($raw === false) {
            return $done(false, 0, null, $errno === 28 ? 'timeout' : 'connect_error');
        }
    } else {
        $ctx = stream_context_create(['http' => [
            'method' => 'POST', 'header' => implode("\r\n", $headers), 'content' => $body,
            'timeout' => $timeoutMs / 1000, 'ignore_errors' => true, 'follow_location' => 0,
        ]]);
        $raw = @file_get_contents($url, false, $ctx);
        if ($raw === false) {
            $elapsed = (microtime(true) - $t0) * 1000;
            return $done(false, 0, null, $elapsed >= $timeoutMs - 50 ? 'timeout' : 'connect_error');
        }
        $status = 0;
        foreach ($http_response_header ?? [] as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
                $status = (int) $m[1];
            }
        }
    }
    if ($status < 200 || $status >= 300) {
        return $done(false, $status, null, 'http_' . $status);
    }
    $json = json_decode((string) $raw, true);
    if (!is_array($json)) {
        return $done(false, $status, null, 'invalid_json');
    }
    return $done(true, $status, $json, null);
}

/** Строка факта в формате calendar_facts. */
function tasks_fact_row(PDO $pdo, string $date, ?string $status, ?array $trip): array
{
    $info = tasks_day_info($pdo, $date);
    return [
        'date'          => $date,
        'matrix_status' => $status,
        'day_type'      => $info['type'],
        'is_day_off'    => tasks_is_day_off_type($info['type']),
        'holiday_label' => $info['label'],
        'trip'          => $trip,
    ];
}

/**
 * Строки только с БЛОКИРУЮЩИМИ фактами (sick/trip) за диапазон — разреженный формат
 * calendar_facts: отсутствие строки = нет блока. employee_id => строки по возрастанию даты.
 *
 * @param string[] $employeeIds
 */
function tasks_sparse_blocking_facts(PDO $pdo, array $employeeIds, string $from, string $to): array
{
    return tasks_sparse_rows_from_matrix($pdo, tasks_matrix_facts($pdo, $employeeIds, $from, $to), $from, $to);
}

/** То же из уже загруженных фактов матрицы (tasks_matrix_facts). */
function tasks_sparse_rows_from_matrix(PDO $pdo, array $matrix, string $from, string $to): array
{
    $out = [];
    foreach (tasks_blocked_from_facts($matrix, $from, $to) as $b) {
        $f = $matrix[$b['employee_id']][$b['date']];
        $out[$b['employee_id']][] = tasks_fact_row($pdo, $b['date'], $f['status'] ?? null, $f['trip'] ?? null);
    }
    return $out;
}

/**
 * Факты для tasks-validate: полные строки calendar_facts на [from, to] (нужны для notes)
 * + разреженные блокирующие строки на (to, to + HORIZON] — этого достаточно для
 * suggested_start: PHP-эталон смотрит блоки в [from, from + HORIZON + длина − 1] = [from, to + HORIZON].
 * Размер ограничен: полный блок = employees × len(period) ≤ 100 × 366 строк, хвост — только число
 * реальных sick/trip-дней сотрудников (единицы–десятки), а не 400 × employees.
 *
 * @param string[] $employeeIds
 */
function tasks_n8n_validate_facts(PDO $pdo, array $employeeIds, string $from, string $to): array
{
    $facts = tasks_calendar_facts($pdo, $employeeIds, $from, $to);
    $tail = tasks_sparse_blocking_facts(
        $pdo, $employeeIds, tasks_date_add($to, 1), tasks_date_add($to, TASKS_SUGGEST_HORIZON_DAYS)
    );
    foreach ($tail as $emp => $rows) {
        foreach ($rows as $r) {
            $facts[$emp][] = $r;
        }
    }
    return $facts;
}

/**
 * Приводит ответ tasks-validate к строгому виду или null, если формат неверен.
 *
 * @return array{blocked_days: array, notes: array, suggested_start: ?string}|null
 */
function tasks_n8n_normalize_verdict(?array $j): ?array
{
    if ($j === null || !isset($j['blocked_days'], $j['notes']) || !is_array($j['blocked_days']) || !is_array($j['notes'])
        || !array_key_exists('suggested_start', $j)) {
        return null;
    }
    $blocked = [];
    foreach ($j['blocked_days'] as $b) {
        if (!is_array($b) || !tasks_valid_date_string($b['date'] ?? null) || !is_string($b['employee_id'] ?? null)
            || !in_array($b['reason'] ?? null, ['sick', 'trip'], true)) {
            return null;
        }
        $blocked[] = ['date' => $b['date'], 'employee_id' => $b['employee_id'], 'reason' => $b['reason']];
    }
    $notes = [];
    foreach ($j['notes'] as $n) {
        if (!is_array($n) || !tasks_valid_date_string($n['date'] ?? null) || !is_string($n['kind'] ?? null)
            || !(($n['employee_id'] ?? null) === null || is_string($n['employee_id']))
            || !(($n['label'] ?? null) === null || is_string($n['label']))) {
            return null;
        }
        $notes[] = ['date' => $n['date'], 'employee_id' => $n['employee_id'] ?? null, 'kind' => $n['kind'],
                    'label' => $n['label'] ?? null];
    }
    $sug = $j['suggested_start'];
    if ($sug !== null && !tasks_valid_date_string($sug)) {
        return null;
    }
    return ['blocked_days' => $blocked, 'notes' => $notes, 'suggested_start' => $sug];
}

/** 'YYYY-MM-DD' без времени. */
function tasks_valid_date_string(mixed $v): bool
{
    $p = tasks_parse_when($v);
    return $p !== null && $p['time'] === null;
}

/**
 * Внешняя проверка (n8n webhook `tasks-validate`).
 *
 * @param array $ctx {employee_ids: string[], from: string, to: string, facts: array}
 * @return array{configured: bool, available: bool, reason?: string, result?: ?array, ms?: int}
 *   available=true ⇒ result — нормализованный вердикт (tasks_n8n_normalize_verdict).
 */
function tasks_external_validate(array $ctx): array
{
    $cfg = tasks_n8n_config();
    if ($cfg['validate_url'] === '') {
        return ['configured' => false, 'available' => false, 'reason' => 'not_configured'];
    }
    $r = tasks_n8n_post($cfg['validate_url'], $cfg['secret'], $ctx, TASKS_N8N_TIMEOUT_MS, 'tasks-validate');
    $res = ['configured' => true, 'available' => false, 'reason' => $r['reason'], 'result' => null, 'ms' => $r['ms']];
    if ($r['ok']) {
        $v = tasks_n8n_normalize_verdict($r['json']);
        if ($v === null) {
            $res['reason'] = 'invalid_response';
        } else {
            $res['available'] = true;
            $res['reason'] = null;
            $res['result'] = $v;
        }
    }
    return $res;
}

/**
 * check_state по результату внешней проверки: 'ok' — внешняя проверка не нужна
 * (локальные правила авторитетны) или пройдена; 'pending' — настроена, но недоступна
 * (задача сохраняется, перепроверка — AC-8).
 */
function tasks_resolve_check_state(array $external): string
{
    if (empty($external['configured'])) {
        return 'ok';
    }
    return !empty($external['available']) ? 'ok' : 'pending';
}

/**
 * Проверка FR-10 с учётом n8n (вариант B): если n8n настроен и ответил — вердикт n8n
 * (check_state 'ok'); иначе PHP-эталон (fallback) и check_state 'pending' (допущение Д-3).
 * Без настройки n8n — PHP-эталон, 'ok'. При расхождении n8n и PHP пишет предупреждение в error_log.
 *
 * @return array как tasks_check_period() + 'check_state' ('ok'|'pending') + 'source' ('php'|'n8n')
 *         (+ 'n8n_reason' при fallback), либо ['error' => код].
 */
function tasks_check_period_checked(PDO $pdo, array $assigneeIds, string $startAt, ?string $endAt): array
{
    $php = tasks_check_period($pdo, $assigneeIds, $startAt, $endAt);
    if (isset($php['error'])) {
        return $php;
    }
    $cfg = tasks_n8n_config();
    if ($cfg['validate_url'] === '') {
        return $php + ['check_state' => 'ok', 'source' => 'php'];
    }
    $ids = array_values(array_unique(array_map('strval', $assigneeIds)));
    $ext = tasks_external_validate([
        'employee_ids' => $ids,
        'from'         => $php['first_day'],
        'to'           => $php['last_day'],
        'facts'        => tasks_n8n_validate_facts($pdo, $ids, $php['first_day'], $php['last_day']),
    ]);
    if (tasks_resolve_check_state($ext) !== 'ok') {
        error_log('[tasks] n8n tasks-validate unavailable: ' . ($ext['reason'] ?? '?') . ' → php fallback, check_state=pending');
        return $php + ['check_state' => 'pending', 'source' => 'php', 'n8n_reason' => (string) ($ext['reason'] ?? 'unavailable')];
    }
    $v = $ext['result'];
    $same = $v['blocked_days'] === $php['blocked_days'] && $v['notes'] === $php['notes']
        && $v['suggested_start'] === $php['suggested_start'];
    if (!$same) {
        error_log('[tasks] n8n/php DIVERGENCE for ' . json_encode(['from' => $php['first_day'], 'to' => $php['last_day'], 'employees' => $ids])
            . ' n8n=' . json_encode($v, JSON_UNESCAPED_UNICODE) . ' php='
            . json_encode(['blocked_days' => $php['blocked_days'], 'notes' => $php['notes'], 'suggested_start' => $php['suggested_start']], JSON_UNESCAPED_UNICODE));
    }
    return [
        'ok'              => $v['blocked_days'] === [],
        'blocked_days'    => $v['blocked_days'],
        'suggested_start' => $v['suggested_start'],
        'notes'           => $v['notes'],
        'first_day'       => $php['first_day'],
        'last_day'        => $php['last_day'],
        'days'            => $php['days'],
        'check_state'     => 'ok',
        'source'          => 'n8n',
    ];
}

// ---------------------------------------------------------------------
// Перепроверка pending (tasks-recheck)
// ---------------------------------------------------------------------

/**
 * Нужна ли перепроверка и «занять слот»: n8n recheck настроен, есть pending-задачи,
 * с прошлой попытки прошло ≥ TASKS_RECHECK_INTERVAL_SEC. Метка (meta) ставится в момент захвата —
 * параллельные чтения не дублируют вызов, а недоступный n8n не вызывается чаще раза в интервал.
 */
function tasks_recheck_claim(PDO $pdo, ?int $nowTs = null): bool
{
    $cfg = tasks_n8n_config();
    if ($cfg['recheck_url'] === '') {
        return false;
    }
    $nowTs = $nowTs ?? time();
    $has = $pdo->query("SELECT 1 FROM tasks WHERE check_state = 'pending' AND archived = 0 LIMIT 1")->fetchColumn();
    if (!$has) {
        return false;
    }
    $pdo->prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (:k, '0')")->execute([':k' => TASKS_RECHECK_META_KEY]);
    $upd = $pdo->prepare(
        'UPDATE meta SET value = :now WHERE key = :k AND CAST(value AS INTEGER) <= :th'
    );
    $upd->execute([':now' => (string) $nowTs, ':k' => TASKS_RECHECK_META_KEY, ':th' => $nowTs - TASKS_RECHECK_INTERVAL_SEC]);
    return $upd->rowCount() === 1;
}

/**
 * Пакетная перепроверка pending-задач через tasks-recheck. Запись — только здесь, в приложении:
 * при вердикте n8n check_state 'pending' → 'ok' (без смены version/updated_at, чтобы не вызывать
 * 409 у открытых вкладок) + audit 'task.recheck' {conflict, blocked_days_count}. Признак conflict
 * вычисляется при чтении (tasks_build, AC-4) и поэтому отдельно не хранится.
 * Недоступность n8n не бросает исключений — задачи остаются pending.
 * Таймаут вызова — TASKS_N8N_RECHECK_TIMEOUT_MS (10 с; параметр $timeoutMs — для тестов); аномалии (> 10 с) — в error_log.
 *
 * @return array{configured: bool, available: bool, checked: int, resolved: int, conflicts: int, reason?: ?string}
 */
function tasks_recheck_pending(PDO $pdo, int $limit = TASKS_RECHECK_BATCH, int $timeoutMs = TASKS_N8N_RECHECK_TIMEOUT_MS): array
{
    $stat = ['configured' => false, 'available' => false, 'checked' => 0, 'resolved' => 0, 'conflicts' => 0];
    $cfg = tasks_n8n_config();
    if ($cfg['recheck_url'] === '') {
        return $stat + ['reason' => 'not_configured'];
    }
    $stat['configured'] = true;

    $stmt = $pdo->prepare(
        "SELECT id, start_at, end_at, version FROM tasks
         WHERE check_state = 'pending' AND archived = 0 ORDER BY updated_at, id LIMIT :n"
    );
    $stmt->bindValue(':n', max(1, $limit), PDO::PARAM_INT);
    $stmt->execute();
    $assg = $pdo->prepare("SELECT employee_id FROM task_assignees WHERE task_id = :t AND role = 'assignee' ORDER BY employee_id");

    $batch = [];   // id => ['version' => int, 'ids' => string[], 'from' => string, 'to' => string]
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $p = tasks_validate_period($r['start_at'], $r['end_at']);
        $assg->execute([':t' => $r['id']]);
        $ids = array_map('strval', $assg->fetchAll(PDO::FETCH_COLUMN));
        if ($p['error'] !== null || $ids === []) {
            continue;
        }
        $batch[(string) $r['id']] = ['version' => (int) $r['version'], 'ids' => $ids, 'from' => $p['first_day'], 'to' => $p['last_day']];
    }
    if ($batch === []) {
        return $stat + ['reason' => 'nothing_pending'];
    }

    $allIds = [];
    $min = null;
    $max = null;
    $tasks = [];
    foreach ($batch as $id => $b) {
        $allIds = array_merge($allIds, $b['ids']);
        $min = $min === null || $b['from'] < $min ? $b['from'] : $min;
        $max = $max === null || $b['to'] > $max ? $b['to'] : $max;
        $tasks[] = ['id' => $id, 'employee_ids' => $b['ids'], 'from' => $b['from'], 'to' => $b['to']];
    }
    $allIds = array_values(array_unique($allIds));
    $matrix = tasks_matrix_facts($pdo, $allIds, $min, $max);
    $facts = tasks_sparse_rows_from_matrix($pdo, $matrix, $min, $max);
    $stat['checked'] = count($tasks);

    $r = tasks_n8n_post($cfg['recheck_url'], $cfg['secret'], ['tasks' => $tasks, 'facts' => (object) $facts], $timeoutMs, 'tasks-recheck');
    if (!$r['ok'] || !isset($r['json']['results']) || !is_array($r['json']['results'])) {
        error_log('[tasks] n8n tasks-recheck unavailable: ' . ($r['reason'] ?? 'invalid_response'));
        return array_merge($stat, ['reason' => $r['reason'] ?? 'invalid_response']);
    }
    $stat['available'] = true;

    $upd = $pdo->prepare(
        "UPDATE tasks SET check_state = 'ok'
         WHERE id = :id AND version = :v AND check_state = 'pending' AND archived = 0"
    );
    foreach ($r['json']['results'] as $res) {
        $id = is_array($res) && is_string($res['id'] ?? null) ? $res['id'] : null;
        if ($id === null || !isset($batch[$id]) || !array_key_exists('conflict', $res) || !is_bool($res['conflict'])
            || !is_array($res['blocked_days'] ?? null)) {
            continue;   // вердикт с ошибкой/неизвестная задача — остаётся pending
        }
        $b = $batch[$id];
        // Сверка с PHP-эталоном (логируем расхождение, запись идёт по вердикту n8n).
        $phpConf = tasks_blocked_from_facts($matrix, $b['from'], $b['to']);
        $phpConf = array_values(array_filter($phpConf, static fn($x) => in_array($x['employee_id'], $b['ids'], true)));
        if (($phpConf !== []) !== $res['conflict']) {
            error_log('[tasks] n8n/php DIVERGENCE (recheck) task=' . $id . ' n8n_conflict=' . json_encode($res['conflict'])
                . ' php_conflict=' . json_encode($phpConf !== []));
        }
        $pdo->beginTransaction();
        try {
            $upd->execute([':id' => $id, ':v' => $b['version']]);
            if ($upd->rowCount() === 1) {
                audit($pdo, 'task.recheck', 'system', null, 'task', $id, [
                    'check_state'        => 'ok',
                    'conflict'           => $res['conflict'],
                    'blocked_days_count' => count($res['blocked_days']),
                ]);
                $stat['resolved']++;
                if ($res['conflict']) {
                    $stat['conflicts']++;
                }
            }
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('[tasks] recheck write failed for ' . $id . ': ' . $e->getMessage());
        }
    }
    return $stat;
}
