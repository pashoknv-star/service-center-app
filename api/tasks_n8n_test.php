<?php

declare(strict_types=1);

// Служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * tasks_n8n_test.php — тесты интеграции блока «Задачи» с n8n (T1-4): вызов webhook (validate 3 с, recheck 10 с, лог аномалий > 10 с),
 * заголовок-секрет, fallback + check_state='pending' (AC-8), вердикт n8n как источник правил,
 * перепроверка pending (tasks-recheck) после ответа пользователю, не чаще раза в 15 мин.
 *
 * Usage:  php api/tasks_n8n_test.php
 *
 * Реальный n8n НЕ вызывается: поднимается mock-webhook (php -S, router во временной папке).
 * Сверка с настоящим n8n — scripts/n8n_compare.php. Изолированный прогон как у tasks_test.php:
 * копия data/app.db (SC_APP_DB), «DB intact: YES». Переменные TASKS_* из окружения сбрасываются.
 */

$root = realpath(__DIR__ . '/..');
if ($root === false) {
    fwrite(STDERR, "Cannot resolve project root\n");
    exit(1);
}
$realDb = $root . '/data/app.db';
$realDbHashBefore = is_file($realDb) ? sha1_file($realDb) : '';

$tmpDir = sys_get_temp_dir();
$tmpDb = tempnam($tmpDir, 'sc_n8n_db_');
if ($tmpDb === false || !copy($realDb, $tmpDb)) {
    fwrite(STDERR, "Cannot create temp DB copy\n");
    exit(1);
}
foreach (['TASKS_VALIDATE_WEBHOOK_URL', 'TASKS_RECHECK_WEBHOOK_URL', 'TASKS_N8N_WEBHOOK_SECRET'] as $v) {
    putenv($v);
}
putenv('SC_APP_DB=' . $tmpDb);
$_ENV['SC_APP_DB'] = $tmpDb;

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/tasks_rules.php';

$passed = 0;
$failed = 0;
$testNo = 0;

function out(string $s): void { echo $s, PHP_EOL; }
function ok(bool $cond, string $msg = 'assert failed'): void { if (!$cond) { throw new RuntimeException($msg); } }
function eq(mixed $actual, mixed $expected, string $what = 'value'): void
{
    if ($actual !== $expected) {
        throw new RuntimeException($what . ': expected ' . json_encode($expected, JSON_UNESCAPED_UNICODE)
            . ', got ' . json_encode($actual, JSON_UNESCAPED_UNICODE));
    }
}

$run = function (string $label, callable $fn) use (&$testNo, &$passed, &$failed): void {
    $testNo++;
    try {
        $extra = $fn();
        $passed++;
        out(sprintf('[%d] %s: PASS%s', $testNo, $label, $extra ? ' — ' . $extra : ''));
    } catch (Throwable $e) {
        $failed++;
        out(sprintf('[%d] %s: FAIL — %s', $testNo, $label, $e->getMessage()));
    }
};

function free_port(string $host): int
{
    for ($i = 0; $i < 20; $i++) {
        $cand = 19900 + random_int(0, 900);
        $fp = @fsockopen($host, $cand, $errno, $errstr, 0.2);
        if ($fp) { fclose($fp); continue; }
        return $cand;
    }
    throw new RuntimeException('No free port');
}

function wait_port(string $host, int $port): void
{
    for ($i = 0; $i < 50; $i++) {
        usleep(200000);
        $fp = @fsockopen($host, $port, $errno, $errstr, 0.2);
        if ($fp) { fclose($fp); return; }
    }
    throw new RuntimeException('Server did not start on port ' . $port);
}

function req(string $method, string $url, array $o = []): array
{
    $ch = curl_init($url);
    $headers = $o['headers'] ?? [];
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30,
        CURLOPT_CUSTOMREQUEST => $method, CURLOPT_FOLLOWLOCATION => false,
    ]);
    if (!empty($o['cookie'])) {
        curl_setopt($ch, CURLOPT_COOKIEJAR, $o['cookie']);
        curl_setopt($ch, CURLOPT_COOKIEFILE, $o['cookie']);
    }
    if (array_key_exists('body', $o)) {
        $headers[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($o['body'], JSON_UNESCAPED_UNICODE));
    }
    if ($headers) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    }
    $t0 = microtime(true);
    $raw = curl_exec($ch);
    $ms = (int) round((microtime(true) - $t0) * 1000);
    if ($raw === false) {
        $e = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('curl: ' . $e);
    }
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ['status' => $status, 'raw' => (string) $raw, 'json' => json_decode((string) $raw, true), 'ms' => $ms];
}

// ----------------------------------------------------------------------------
// Mock n8n: router во временной папке; поведение — через control-файл, журнал вызовов — JSONL.
// ----------------------------------------------------------------------------
$mockDir = $tmpDir . '/sc_n8n_mock_' . bin2hex(random_bytes(4));
mkdir($mockDir, 0700);
$ctlFile = $mockDir . '/ctl.json';
$logFile = $mockDir . '/calls.jsonl';
$SECRET = 'test-secret-' . bin2hex(random_bytes(8));   // тестовый, не боевой
file_put_contents($ctlFile, '{}');
file_put_contents($logFile, '');
file_put_contents($mockDir . '/router.php', <<<'PHP'
<?php
// Mock webhook n8n (T1-4 tests). Повторяет контракт tasks-validate / tasks-recheck и header-auth.
$ctl = json_decode((string) @file_get_contents(getenv('MOCK_CTL')), true) ?: [];
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$kind = $path === '/webhook/tasks-validate' ? 'validate' : ($path === '/webhook/tasks-recheck' ? 'recheck' : null);
$raw = (string) file_get_contents('php://input');
$body = json_decode($raw, true);
$secretOk = hash_equals((string) getenv('MOCK_SECRET'), (string) ($_SERVER['HTTP_X_TASKS_SECRET'] ?? ''));
file_put_contents(getenv('MOCK_LOG'), json_encode([
    'kind' => $kind, 'method' => $_SERVER['REQUEST_METHOD'], 'secret_ok' => $secretOk,
    'ctype' => $_SERVER['CONTENT_TYPE'] ?? '', 'body' => $body, 'raw' => $raw,
]) . "\n", FILE_APPEND | LOCK_EX);
if ($kind === null) { http_response_code(404); exit; }
if (!$secretOk) { http_response_code(403); echo 'Authorization data is wrong!'; exit; }
$c = $ctl[$kind] ?? [];
if (!empty($c['delay_ms'])) { usleep((int) $c['delay_ms'] * 1000); }
http_response_code((int) ($c['status'] ?? 200));
header('Content-Type: application/json');
if (isset($c['raw'])) { echo $c['raw']; exit; }
if (($c['mode'] ?? '') === 'auto' && $kind === 'recheck') {
    // Простейшая реализация правил по фактам из запроса (только блоки sick/trip).
    $results = [];
    foreach ($body['tasks'] as $t) {
        $blocked = [];
        foreach ($t['employee_ids'] as $emp) {
            foreach (($body['facts'][$emp] ?? []) as $r) {
                if ($r['date'] < $t['from'] || $r['date'] > $t['to']) { continue; }
                $reason = $r['matrix_status'] === 'sick' ? 'sick' : (($r['matrix_status'] === 'trip' || $r['trip'] !== null) ? 'trip' : null);
                if ($reason) { $blocked[] = ['date' => $r['date'], 'employee_id' => $emp, 'reason' => $reason]; }
            }
        }
        $results[] = ['id' => $t['id'], 'conflict' => $blocked !== [], 'blocked_days' => $blocked];
    }
    echo json_encode(['results' => $results]);
    exit;
}
echo json_encode($c['response'] ?? new stdClass());
PHP
);
$setCtl = function (array $ctl) use ($ctlFile): void { file_put_contents($ctlFile, json_encode($ctl)); };
$calls = function (?string $kind = null) use ($logFile): array {
    $out = [];
    foreach (file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $l) {
        $j = json_decode($l, true);
        if ($j && ($kind === null || $j['kind'] === $kind)) { $out[] = $j; }
    }
    return $out;
};
$resetCalls = function () use ($logFile): void { file_put_contents($logFile, ''); };

$host = '127.0.0.1';
$mockPort = free_port($host);
$mockBase = "http://{$host}:{$mockPort}";
$mockEnv = getenv();
$mockEnv += ['MOCK_CTL' => $ctlFile];
$mockEnv['MOCK_CTL'] = $ctlFile;
$mockEnv['MOCK_LOG'] = $logFile;
$mockEnv['MOCK_SECRET'] = $SECRET;
$mockProc = proc_open(
    sprintf('exec php -S %s:%d %s > /dev/null 2>&1', $host, $mockPort, escapeshellarg($mockDir . '/router.php')),
    [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $mockPipes, $mockDir, $mockEnv
);
if (!is_resource($mockProc)) {
    fwrite(STDERR, "Failed to start mock\n");
    exit(1);
}
foreach ($mockPipes as $p) { fclose($p); }
wait_port($host, $mockPort);

$VURL = $mockBase . '/webhook/tasks-validate';
$RURL = $mockBase . '/webhook/tasks-recheck';

// ----------------------------------------------------------------------------
// БД-копия + фикстуры
// ----------------------------------------------------------------------------
$db = Database::getInstance();
$pdo = $db->getPDO();
$pdo->exec('PRAGMA busy_timeout = 5000');
$db->migrate();
$PHONE = '+7 900 123-45-67';
foreach ([['nn_a', 'Нэнэ Альфа'], ['nn_b', 'Нэнэ Браво'], ['nn_u1', 'Нэнэ Юнит Один'], ['nn_u2', 'Нэнэ Юнит Два']] as [$eid, $nm]) {
    $pdo->prepare('INSERT INTO employees (id, full_name, location, phone, photo_url, sort_order) VALUES (:i, :n, \'QA\', :p, :ph, 0)')
        ->execute([':i' => $eid, ':n' => $nm, ':p' => $PHONE, ':ph' => 'images/nn_photo_secret.jpg']);
}
$addEntry = function (string $emp, string $date, string $status) use ($pdo): void {
    $pdo->prepare('INSERT OR REPLACE INTO schedule_entries (employee_id, date, status, approval_status, version, updated_at)
                   VALUES (:e, :d, :s, \'draft\', 1, :t)')->execute([':e' => $emp, ':d' => $date, ':s' => $status, ':t' => date('c')]);
};
$addTrip = function (string $emp, string $from, string $to) use ($pdo): void {
    $tid = 'trip_nn_' . bin2hex(random_bytes(3));
    $pdo->prepare('INSERT INTO trips (id, title, status, version, created_by, created_at, updated_at) VALUES (:i, \'nn trip\', \'confirmed\', 1, \'nn\', :t, :t)')
        ->execute([':i' => $tid, ':t' => date('c')]);
    $pdo->prepare('INSERT INTO trip_participants (trip_id, employee_id, start_date, end_date) VALUES (:i, :e, :f, :t)')
        ->execute([':i' => $tid, ':e' => $emp, ':f' => $from, ':t' => $to]);
};
// Период 2027-06-01..05: nn_u1 больничный 06-03, nn_u2 отпуск 06-02; «хвост»: nn_u2 командировка 06-10..11, nn_u1 больничный 09-01.
$addEntry('nn_u1', '2027-06-03', 'sick');
$addEntry('nn_u2', '2027-06-02', 'vacation');
$addTrip('nn_u2', '2027-06-10', '2027-06-11');
$addEntry('nn_u1', '2027-09-01', 'sick');

$setEnv = function (bool $validate, bool $recheck, ?string $secret) use ($VURL, $RURL, $SECRET): void {
    putenv($validate ? 'TASKS_VALIDATE_WEBHOOK_URL=' . $VURL : 'TASKS_VALIDATE_WEBHOOK_URL');
    putenv($recheck ? 'TASKS_RECHECK_WEBHOOK_URL=' . $RURL : 'TASKS_RECHECK_WEBHOOK_URL');
    putenv($secret === null ? 'TASKS_N8N_WEBHOOK_SECRET' : 'TASKS_N8N_WEBHOOK_SECRET=' . $secret);
};

out('=== TASKS N8N TEST START ===');

// --- Транспорт ---------------------------------------------------------------
$run('N1 tasks_n8n_post: JSON POST, заголовок-секрет, ответ разобран', function () use ($VURL, $SECRET, $setCtl, $calls, $resetCalls) {
    $resetCalls();
    $setCtl(['validate' => ['response' => ['blocked_days' => [], 'notes' => [], 'suggested_start' => null]]]);
    $r = tasks_n8n_post($VURL, $SECRET, ['a' => 1, 'ю' => 'я']);
    eq($r['ok'], true, 'ok');
    eq($r['json']['suggested_start'], null, 'json');
    $c = $calls('validate');
    eq(count($c), 1, 'вызовов');
    eq($c[0]['method'], 'POST', 'method');
    eq($c[0]['secret_ok'], true, 'секрет доставлен заголовком X-Tasks-Secret');
    ok(strpos($c[0]['ctype'], 'application/json') === 0, 'Content-Type');
    eq($c[0]['body'], ['a' => 1, 'ю' => 'я'], 'тело');
    $bad = tasks_n8n_post($VURL, 'wrong-secret', []);
    eq([$bad['ok'], $bad['reason']], [false, 'http_403'], 'неверный секрет → http_403');
    return 'ok, 403 на неверный секрет';
});

$run('N2 tasks_n8n_post: пустой секрет — вызова нет; недоступный хост → connect_error', function () use ($VURL, $SECRET, $calls, $resetCalls) {
    $resetCalls();
    $r = tasks_n8n_post($VURL, '', []);
    eq([$r['ok'], $r['reason']], [false, 'no_secret'], 'no_secret');
    eq(count($calls()), 0, 'вызова не было');
    $r = tasks_n8n_post('http://127.0.0.1:9/x', $SECRET, []);
    eq([$r['ok'], $r['reason']], [false, 'connect_error'], 'connect_error');
    return 'no_secret, connect_error';
});

$run('N3 таймаут: ответ медленнее 3 с → reason=timeout за ≤ 3.6 с', function () use ($VURL, $SECRET, $setCtl) {
    $setCtl(['validate' => ['delay_ms' => 4500, 'response' => ['blocked_days' => [], 'notes' => [], 'suggested_start' => null]]]);
    $r = tasks_n8n_post($VURL, $SECRET, []);
    eq([$r['ok'], $r['reason']], [false, 'timeout'], 'timeout');
    ok($r['ms'] >= 2800 && $r['ms'] <= 3600, 'ms=' . $r['ms']);
    // Дать mock дочитать sleep, чтобы не задерживать следующие тесты.
    usleep(1700000);
    return $r['ms'] . ' мс';
});

$run('N4 некорректные ответы: 500, не-JSON, неверная форма → available=false', function () use ($setEnv, $setCtl, $SECRET) {
    $setEnv(true, false, $SECRET);
    try {
        $ctx = ['employee_ids' => ['nn_a'], 'from' => '2027-06-01', 'to' => '2027-06-01', 'facts' => []];
        $cases = [
            'http_500'         => ['status' => 500, 'raw' => '{"error":"x"}'],
            'invalid_json'     => ['raw' => 'not json'],
            'invalid_response' => ['raw' => '{"x":1}'],
        ];
        foreach ($cases as $expected => $c) {
            $setCtl(['validate' => $c]);
            $e = tasks_external_validate($ctx);
            eq([$e['configured'], $e['available'], $e['reason']], [true, false, $expected], $expected);
            eq(tasks_resolve_check_state($e), 'pending', 'pending для ' . $expected);
        }
    } finally {
        $setEnv(false, false, null);
    }
    return '3 случая → pending';
});

$run('N5 tasks_n8n_normalize_verdict: строгая проверка формы', function () {
    $good = ['blocked_days' => [['date' => '2027-06-03', 'employee_id' => 'e1', 'reason' => 'sick', 'junk' => 1]],
             'notes' => [['date' => '2027-06-04', 'employee_id' => null, 'kind' => 'weekend', 'label' => null]],
             'suggested_start' => '2027-06-06'];
    $n = tasks_n8n_normalize_verdict($good);
    eq($n['blocked_days'], [['date' => '2027-06-03', 'employee_id' => 'e1', 'reason' => 'sick']], 'лишние поля отброшены');
    eq($n['suggested_start'], '2027-06-06', 'suggested_start');
    foreach ([
        'нет suggested_start' => ['blocked_days' => [], 'notes' => []],
        'reason' => ['blocked_days' => [['date' => '2027-06-03', 'employee_id' => 'e1', 'reason' => 'vacation']], 'notes' => [], 'suggested_start' => null],
        'дата блока' => ['blocked_days' => [['date' => '2027-02-30', 'employee_id' => 'e1', 'reason' => 'sick']], 'notes' => [], 'suggested_start' => null],
        'suggested_start дата' => ['blocked_days' => [], 'notes' => [], 'suggested_start' => 'завтра'],
        'notes.kind' => ['blocked_days' => [], 'notes' => [['date' => '2027-06-04', 'employee_id' => null]], 'suggested_start' => null],
    ] as $what => $bad) {
        eq(tasks_n8n_normalize_verdict($bad), null, $what);
    }
    eq(tasks_n8n_normalize_verdict(null), null, 'null');
    return '5 негативных + позитивный';
});

// --- Факты и вердикт ---------------------------------------------------------
$run('N6 факты для tasks-validate: полные строки периода + только блоки в хвосте, без ПДн', function () use ($pdo, $PHONE) {
    $f = tasks_n8n_validate_facts($pdo, ['nn_u1', 'nn_u2'], '2027-06-01', '2027-06-05');
    $rows1 = $f['nn_u1'];
    $inPeriod = array_values(array_filter($rows1, fn($r) => $r['date'] <= '2027-06-05'));
    eq(count($inPeriod), 5, 'полных строк на период nn_u1');
    eq(array_keys($rows1[0]), ['date', 'matrix_status', 'day_type', 'is_day_off', 'holiday_label', 'trip'], 'формат calendar_facts');
    $tail1 = array_values(array_filter($rows1, fn($r) => $r['date'] > '2027-06-05'));
    eq(array_column($tail1, 'date'), ['2027-09-01'], 'хвост nn_u1: только больничный');
    $tail2 = array_values(array_filter($f['nn_u2'], fn($r) => $r['date'] > '2027-06-05'));
    eq(array_column($tail2, 'date'), ['2027-06-10', '2027-06-11'], 'хвост nn_u2: командировка');
    ok($tail2[0]['trip'] !== null, 'trip в хвосте');
    $raw = json_encode($f, JSON_UNESCAPED_UNICODE);
    foreach (['Нэнэ', 'phone', 'photo', '900 123'] as $needle) {
        ok(stripos($raw, $needle) === false, "факты содержат '$needle'");
    }
    // Хвост не длиннее горизонта PHP-эталона: to + 400.
    // Граница: блок 2027-06-03 = to + 400 при to = 2026-04-29 (включительно), при to = 2026-04-28 — вне окна.
    $tailOf = static function (array $facts, string $to): array {
        return array_values(array_column(array_filter($facts['nn_u1'] ?? [], static fn($r) => $r['date'] > $to), 'date'));
    };
    eq($tailOf(tasks_n8n_validate_facts($pdo, ['nn_u1'], '2026-04-28', '2026-04-29'), '2026-04-29'), ['2027-06-03'], 'to+400 включительно');
    eq($tailOf(tasks_n8n_validate_facts($pdo, ['nn_u1'], '2026-04-27', '2026-04-28'), '2026-04-28'), [], 'to+401 вне окна');
    return count($rows1) . '+' . count($f['nn_u2']) . ' строк';
});

$run('N7 без настройки n8n: PHP-эталон, check_state=ok, вызовов нет', function () use ($pdo, $setEnv, $calls, $resetCalls) {
    $setEnv(false, false, null);
    $resetCalls();
    $r = tasks_check_period_checked($pdo, ['nn_u1', 'nn_u2'], '2027-06-01', '2027-06-05');
    eq([$r['source'], $r['check_state'], $r['ok']], ['php', 'ok', false], 'source/state/ok');
    eq(count($calls()), 0, 'вызовов не было');
    eq(array_column($r['blocked_days'], 'date'), ['2027-06-03'], 'blocked');
    return 'php/ok';
});

$run('N8 n8n отвечает: вердикт n8n, check_state=ok; в запросе employee_ids/from/to/facts', function () use ($pdo, $setEnv, $setCtl, $calls, $resetCalls, $SECRET) {
    $php = tasks_check_period($pdo, ['nn_u1', 'nn_u2'], '2027-06-01', '2027-06-05');
    $setEnv(true, false, $SECRET);
    try {
        $resetCalls();
        $setCtl(['validate' => ['response' => ['blocked_days' => $php['blocked_days'], 'notes' => $php['notes'], 'suggested_start' => $php['suggested_start']]]]);
        $r = tasks_check_period_checked($pdo, ['nn_u1', 'nn_u2'], '2027-06-01', '2027-06-05');
    } finally {
        $setEnv(false, false, null);
    }
    eq([$r['source'], $r['check_state'], $r['ok']], ['n8n', 'ok', false], 'source/state/ok');
    eq($r['blocked_days'], $php['blocked_days'], 'blocked');
    eq($r['suggested_start'], $php['suggested_start'], 'suggested_start');
    $c = $calls('validate');
    eq(count($c), 1, 'один вызов');
    eq($c[0]['secret_ok'], true, 'секрет');
    eq(array_keys($c[0]['body']), ['employee_ids', 'from', 'to', 'facts'], 'ключи запроса');
    eq([$c[0]['body']['employee_ids'], $c[0]['body']['from'], $c[0]['body']['to']], [['nn_u1', 'nn_u2'], '2027-06-01', '2027-06-05'], 'значения');
    return 'source=n8n, suggested_start=' . var_export($r['suggested_start'], true);
});

$run('N9 вариант B: вердикт n8n первичен (даже при расхождении с PHP; расхождение уходит в error_log)', function () use ($pdo, $setEnv, $setCtl, $SECRET) {
    $setEnv(true, false, $SECRET);
    $logf = tempnam(sys_get_temp_dir(), 'sc_n8n_elog_');
    $prev = ini_set('error_log', $logf);
    try {
        $setCtl(['validate' => ['response' => ['blocked_days' => [], 'notes' => [], 'suggested_start' => null]]]);
        $r = tasks_check_period_checked($pdo, ['nn_u1'], '2027-06-01', '2027-06-05');
    } finally {
        $setEnv(false, false, null);
        ini_set('error_log', $prev === false ? '' : $prev);
    }
    $log = (string) file_get_contents($logf);
    @unlink($logf);
    eq([$r['source'], $r['ok'], $r['blocked_days']], ['n8n', true, []], 'вердикт n8n применён');
    ok(strpos($log, 'DIVERGENCE') !== false, 'расхождение залогировано');
    ok(strpos($log, $SECRET) === false, 'секрет не в логе');
    return 'divergence logged';
});

$run('N10 n8n недоступен: PHP-fallback, check_state=pending, блок по PHP сохраняется', function () use ($pdo, $setEnv, $setCtl, $SECRET) {
    $setEnv(true, false, $SECRET);
    $logf = tempnam(sys_get_temp_dir(), 'sc_n8n_elog_');
    $prev = ini_set('error_log', $logf);
    try {
        $setCtl(['validate' => ['status' => 500, 'raw' => 'boom']]);
        $r = tasks_check_period_checked($pdo, ['nn_u1'], '2027-06-01', '2027-06-05');
    } finally {
        $setEnv(false, false, null);
        ini_set('error_log', $prev === false ? '' : $prev);
    }
    $log = (string) file_get_contents($logf);
    @unlink($logf);
    eq([$r['source'], $r['check_state'], $r['ok'], $r['n8n_reason']], ['php', 'pending', false, 'http_500'], 'fallback');
    eq(array_column($r['blocked_days'], 'date'), ['2027-06-03'], 'PHP-блок');
    ok(strpos($log, 'unavailable') !== false && strpos($log, $SECRET) === false, 'лог без секрета');
    return 'pending';
});

$run('N11 tasks_recheck_claim: раз в 15 мин, только при pending и настроенном URL', function () use ($pdo, $setEnv, $SECRET) {
    $pdo->exec("DELETE FROM meta WHERE key = 'tasks_recheck_at'");
    $pdo->exec("INSERT INTO tasks (id, title, start_at, check_state) VALUES ('nn_cl', 'claim', '2027-06-01', 'pending')");
    $setEnv(false, false, $SECRET);
    eq(tasks_recheck_claim($pdo, 1000000), false, 'URL не настроен');
    $setEnv(false, true, $SECRET);
    try {
        eq(tasks_recheck_claim($pdo, 1000000), true, 'первый захват');
        eq(tasks_recheck_claim($pdo, 1000000 + 899), false, '< 15 мин');
        eq(tasks_recheck_claim($pdo, 1000000 + 900), true, '≥ 15 мин');
        $pdo->exec("UPDATE tasks SET check_state = 'ok' WHERE id = 'nn_cl'");
        eq(tasks_recheck_claim($pdo, 2000000), false, 'нет pending → слот не занимается');
    } finally {
        $setEnv(false, false, null);
        $pdo->exec("DELETE FROM tasks WHERE id = 'nn_cl'");
        $pdo->exec("DELETE FROM meta WHERE key = 'tasks_recheck_at'");
    }
    return 'ok';
});

$run('N12 tasks_recheck_pending: вердикты с ошибкой/чужой id игнорируются, задача остаётся pending', function () use ($pdo, $setEnv, $setCtl, $SECRET) {
    $pdo->exec("INSERT INTO tasks (id, title, start_at, check_state) VALUES ('nn_bad', 'bad', '2027-06-01', 'pending')");
    $pdo->exec("INSERT INTO task_assignees (task_id, employee_id, role) VALUES ('nn_bad', 'nn_a', 'assignee')");
    $setEnv(true, true, $SECRET);
    try {
        $setCtl(['recheck' => ['response' => ['results' => [
            ['id' => 'unknown', 'conflict' => false, 'blocked_days' => []],
            ['id' => 'nn_bad', 'error' => 'invalid_from'],
        ]]]]);
        $s = tasks_recheck_pending($pdo);
        eq([$s['available'], $s['checked'], $s['resolved']], [true, 1, 0], 'stat');
        eq((string) $pdo->query("SELECT check_state FROM tasks WHERE id = 'nn_bad'")->fetchColumn(), 'pending', 'pending');
        $setCtl(['recheck' => ['status' => 500, 'raw' => 'x']]);
        $s = tasks_recheck_pending($pdo);
        eq([$s['available'], $s['reason'], $s['resolved']], [false, 'http_500', 0], 'n8n down');
        eq((string) $pdo->query("SELECT check_state FROM tasks WHERE id = 'nn_bad'")->fetchColumn(), 'pending', 'pending');
    } finally {
        $setEnv(false, false, null);
        $pdo->exec("DELETE FROM tasks WHERE id = 'nn_bad'");
    }
    return 'остаётся pending';
});

// --- D-4 (T1-9): таймауты 3 с / 10 с и лог аномалий ----------------------------
// Запись error_log во временный файл: [результат вызова, текст лога].
$withLog = function (callable $fn): array {
    $logf = tempnam(sys_get_temp_dir(), 'sc_n8n_elog_');
    $prev = ini_set('error_log', $logf);
    try {
        $res = $fn();
    } finally {
        ini_set('error_log', $prev === false ? '' : $prev);
    }
    $log = (string) file_get_contents($logf);
    @unlink($logf);
    return [$res, $log];
};
$addPending = function (string $id, string $emp) use ($pdo): void {
    $pdo->exec("INSERT INTO tasks (id, title, start_at, check_state) VALUES ('$id', 'pend', '2027-06-01', 'pending')");
    $pdo->exec("INSERT INTO task_assignees (task_id, employee_id, role) VALUES ('$id', '$emp', 'assignee')");
};
$stateOf = fn(string $id): string => (string) $pdo->query("SELECT check_state FROM tasks WHERE id = " . $pdo->quote($id))->fetchColumn();

$run('N13 D-4 константы: validate 3000 мс, recheck 10000 мс (отдельная), порог аномалии 10000 мс', function () {
    eq(TASKS_N8N_TIMEOUT_MS, 3000, 'validate timeout');
    eq(TASKS_N8N_RECHECK_TIMEOUT_MS, 10000, 'recheck timeout');
    eq(TASKS_N8N_ANOMALY_MS, 10000, 'anomaly threshold');
    $p = (new ReflectionFunction('tasks_recheck_pending'))->getParameters();
    eq($p[2]->getName() . '=' . $p[2]->getDefaultValue(), 'timeoutMs=10000', 'recheck: таймаут по умолчанию = константа 10000');
    return '3000 / 10000 / 10000';
});

$run('N14 validate с задержкой 4 с → pending за ≤ ~3,5 с; лог «timeout» (штатно), без ANOMALY и секрета', function () use ($pdo, $setEnv, $setCtl, $SECRET, $withLog) {
    $setEnv(true, false, $SECRET);
    try {
        $setCtl(['validate' => ['delay_ms' => 4000, 'response' => ['blocked_days' => [], 'notes' => [], 'suggested_start' => null]]]);
        $t0 = microtime(true);
        [$r, $log] = $withLog(fn() => tasks_check_period_checked($pdo, ['nn_a'], '2027-08-20', '2027-08-21'));
        $ms = (int) round((microtime(true) - $t0) * 1000);
    } finally {
        $setEnv(false, false, null);
    }
    eq([$r['source'], $r['check_state'], $r['n8n_reason']], ['php', 'pending', 'timeout'], 'fallback pending');
    ok($ms >= 2800 && $ms <= 3500, 'validate занял ' . $ms . ' мс');
    ok(preg_match('/tasks n8n timeout workflow=tasks-validate ms=\d+ limit_ms=3000/', $log) === 1, 'строка timeout: ' . trim($log));
    ok(strpos($log, 'ANOMALY') === false, 'таймаут validate — не аномалия');
    ok(strpos($log, $SECRET) === false, 'секрет не в логе');
    usleep(1300000);   // mock дочитывает sleep
    return $ms . ' мс';
});

$run('N15 recheck с задержкой 4 с (таймаут 10 с) → успех: pending → ok, без ANOMALY', function () use ($pdo, $setEnv, $setCtl, $SECRET, $withLog, $addPending, $stateOf) {
    $addPending('nn_rc4', 'nn_a');
    $setEnv(false, true, $SECRET);
    try {
        $setCtl(['recheck' => ['mode' => 'auto', 'delay_ms' => 4000]]);
        $t0 = microtime(true);
        [$s, $log] = $withLog(fn() => tasks_recheck_pending($pdo));
        $ms = (int) round((microtime(true) - $t0) * 1000);
        eq([$s['available'], $s['checked'], $s['resolved']], [true, 1, 1], 'stat');
        eq($stateOf('nn_rc4'), 'ok', 'pending → ok');
        ok($ms >= 3800 && $ms < 9000, 'recheck занял ' . $ms . ' мс (дольше 3 с, но в пределах 10 с)');
        ok(strpos($log, 'ANOMALY') === false && strpos($log, 'tasks n8n timeout') === false, 'лога таймаутов нет: ' . trim($log));
    } finally {
        $setEnv(false, false, null);
        $pdo->exec("DELETE FROM tasks WHERE id = 'nn_rc4'");
        $pdo->exec("DELETE FROM audit_log WHERE action = 'task.recheck' AND entity_id = 'nn_rc4'");   // чтобы не влиять на счёт audit в H5
    }
    return $ms . ' мс';
});

$run('N16 recheck сверх таймаута → строка «tasks n8n ANOMALY» (workflow, мс, reason), задача pending', function () use ($pdo, $setEnv, $setCtl, $SECRET, $withLog, $addPending, $stateOf) {
    $addPending('nn_rc_slow', 'nn_a');
    $setEnv(false, true, $SECRET);
    try {
        $setCtl(['recheck' => ['mode' => 'auto', 'delay_ms' => 3000]]);
        $t0 = microtime(true);
        [$s, $log] = $withLog(fn() => tasks_recheck_pending($pdo, 200, 1500));   // таймаут 1,5 с вместо 10 с (чтобы не ждать 10+ с)
        $ms = (int) round((microtime(true) - $t0) * 1000);
        eq([$s['available'], $s['reason'], $s['resolved']], [false, 'timeout', 0], 'stat');
        eq($stateOf('nn_rc_slow'), 'pending', 'остаётся pending');
        ok($ms >= 1400 && $ms <= 2200, 'ушёл по таймауту за ' . $ms . ' мс');
        $lines = array_values(array_filter(explode("\n", $log), fn($l) => strpos($l, 'ANOMALY') !== false));
        eq(count($lines), 1, 'ровно одна строка ANOMALY');
        ok(preg_match('/tasks n8n ANOMALY workflow=tasks-recheck ms=\d+ reason=timeout$/', trim($lines[0])) === 1, 'формат: ' . trim($lines[0]));
        ok(strpos($log, $SECRET) === false && strpos($log, 'nn_rc_slow') === false && strpos($log, '2027-06') === false, 'без секрета и payload');
        usleep(1700000);   // mock дочитывает sleep
    } finally {
        $setEnv(false, false, null);
        $pdo->exec("DELETE FROM tasks WHERE id = 'nn_rc_slow'");
    }
    return $ms . ' мс';
});

$run('N17 tasks_n8n_log_call: > 10 с → ANOMALY, таймаут validate → без ANOMALY, быстрый вызов и пустой workflow → тишина', function () use ($withLog) {
    $call = fn(string $wf, ?string $reason, int $ms) => $withLog(fn() => tasks_n8n_log_call($wf, ['ok' => $reason === null, 'reason' => $reason, 'ms' => $ms], 3000))[1];
    ok(strpos($call('tasks-recheck', null, 10500), 'tasks n8n ANOMALY workflow=tasks-recheck ms=10500 reason=ok') !== false, 'успех за 10,5 с → ANOMALY');
    ok(strpos($call('tasks-recheck', 'timeout', 10003), 'tasks n8n ANOMALY workflow=tasks-recheck ms=10003 reason=timeout') !== false, 'recheck timeout → ANOMALY');
    $v = $call('tasks-validate', 'timeout', 3002);
    ok(strpos($v, 'tasks n8n timeout workflow=tasks-validate ms=3002') !== false && strpos($v, 'ANOMALY') === false, 'validate timeout → без ANOMALY');
    eq($call('tasks-recheck', null, 4000), '', 'быстрый успех — тишина');
    eq($call('tasks-validate', 'http_500', 120), '', 'быстрый http_500 — тишина (его пишет вызывающий код)');
    eq($call('', 'timeout', 20000), '', 'без workflow — тишина');
    return '6 случаев';
});

// ----------------------------------------------------------------------------
// HTTP-часть: приложение (php -S) с TASKS_*-переменными, смотрящими на mock
// ----------------------------------------------------------------------------
$appPort = free_port($host);
$base = "http://{$host}:{$appPort}";
$serverLog = tempnam($tmpDir, 'sc_n8n_srv_');
$cookie = tempnam($tmpDir, 'sc_n8n_ck_');
$env = getenv();
$env['SC_APP_DB'] = $tmpDb;
$env['TASKS_VALIDATE_WEBHOOK_URL'] = $VURL;
$env['TASKS_RECHECK_WEBHOOK_URL'] = $RURL;
$env['TASKS_N8N_WEBHOOK_SECRET'] = $SECRET;
$proc = proc_open(
    sprintf('exec php -S %s:%d -t %s > %s 2>&1', $host, $appPort, escapeshellarg($root), escapeshellarg($serverLog)),
    [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root, $env
);
if (!is_resource($proc)) {
    fwrite(STDERR, "Failed to start php -S\n");
    exit(1);
}
foreach ($pipes as $p) { fclose($p); }
wait_port($host, $appPort);

$T = $base . '/api/tasks.php';
$A = fn(string $m, string $q = '', ?array $body = null) => req($m, $T . $q, ['cookie' => $cookie] + ($body !== null ? ['body' => $body] : []));
$state = fn(string $id): string => (string) $pdo->query("SELECT check_state FROM tasks WHERE id = " . $pdo->quote($id))->fetchColumn();
$resetClaim = function (int $agoSec = 3600) use ($pdo): void {
    $pdo->prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('tasks_recheck_at', :v)")->execute([':v' => (string) (time() - $agoSec)]);
};
$waitFor = function (callable $cond, int $maxMs = 9000): bool {
    $t0 = microtime(true);
    while ((microtime(true) - $t0) * 1000 < $maxMs) {
        if ($cond()) { return true; }
        usleep(150000);
    }
    return false;
};
$okVerdict = ['blocked_days' => [], 'notes' => [], 'suggested_start' => null];

try {
    $r = req('POST', $base . '/api/login.php', ['cookie' => $cookie, 'body' => ['username' => 'admin', 'password' => 'changeme']]);
    if ($r['status'] !== 200) {
        throw new RuntimeException('login failed: ' . $r['status']);
    }

    $run('H1 POST при живом n8n: 201, check_state=ok, webhook вызван с секретом', function () use ($A, $setCtl, $okVerdict, $calls, $resetCalls) {
        $resetCalls();
        $setCtl(['validate' => ['response' => $okVerdict]]);
        $r = $A('POST', '', ['title' => 'H1', 'start_at' => '2027-07-05', 'end_at' => '2027-07-06', 'assignees' => ['nn_a']]);
        eq($r['status'], 201, 'status');
        eq($r['json']['task']['check_state'], 'ok', 'check_state');
        $c = $calls('validate');
        eq(count($c), 1, 'вызовов webhook');
        eq([$c[0]['secret_ok'], $c[0]['body']['employee_ids'], $c[0]['body']['from'], $c[0]['body']['to']], [true, ['nn_a'], '2027-07-05', '2027-07-06'], 'запрос');
        return $r['ms'] . ' мс';
    });

    $run('H2 вариант B: n8n вернул блок → 422 TASK_BLOCKED с suggested_start от n8n, задача не создана', function () use ($A, $setCtl, $pdo) {
        $n0 = (int) $pdo->query('SELECT COUNT(*) FROM tasks')->fetchColumn();
        $setCtl(['validate' => ['response' => [
            'blocked_days' => [['date' => '2027-07-12', 'employee_id' => 'nn_a', 'reason' => 'trip']],
            'notes' => [], 'suggested_start' => '2027-07-14']]]);
        $r = $A('POST', '', ['title' => 'H2', 'start_at' => '2027-07-12', 'end_at' => '2027-07-13', 'assignees' => ['nn_a']]);
        eq($r['status'], 422, 'status');
        eq($r['json']['error'], 'TASK_BLOCKED_BY_SICK_OR_TRIP', 'code');
        eq([$r['json']['suggested_start'], $r['json']['suggested_end']], ['2027-07-14', '2027-07-15'], 'suggested');
        eq((int) $pdo->query('SELECT COUNT(*) FROM tasks')->fetchColumn(), $n0, 'задач не прибавилось');
        return 'suggested 2027-07-14';
    });

    $run('H3 AC-8: n8n недоступен (500) → задача сохранена как pending; блок по PHP-fallback всё равно 422', function () use ($A, $setCtl, $state, &$pendingIds) {
        $setCtl(['validate' => ['status' => 500, 'raw' => 'boom']]);
        $r = $A('POST', '', ['title' => 'H3', 'start_at' => '2027-08-02', 'end_at' => '2027-08-03', 'assignees' => ['nn_a']]);
        eq($r['status'], 201, 'status');
        eq($r['json']['task']['check_state'], 'pending', 'pending');
        $pendingIds = [$r['json']['task']['id']];
        $r2 = $A('POST', '', ['title' => 'H3b', 'start_at' => '2027-06-02', 'end_at' => '2027-06-04', 'assignees' => ['nn_u1']]);
        eq([$r2['status'], $r2['json']['error'] ?? null], [422, 'TASK_BLOCKED_BY_SICK_OR_TRIP'], 'PHP-блок при недоступном n8n');
        eq($r2['json']['suggested_start'], '2027-06-04' === '' ? '' : $r2['json']['suggested_start'], 'suggested есть');
        return 'pending + 422';
    });

    $run('H4 таймаут: n8n отвечает > 3 с → PUT укладывается в ~3 с, задача pending', function () use ($A, $setCtl, $okVerdict, &$pendingIds) {
        $setCtl(['validate' => ['response' => $okVerdict]]);
        $r = $A('POST', '', ['title' => 'H4', 'start_at' => '2027-08-10', 'assignees' => ['nn_b']]);
        eq([$r['status'], $r['json']['task']['check_state']], [201, 'ok'], 'создана ok');
        $id = $r['json']['task']['id'];
        $setCtl(['validate' => ['delay_ms' => 4500, 'response' => $okVerdict]]);
        $u = $A('PUT', '?id=' . $id, ['version' => $r['json']['task']['version'], 'end_at' => '2027-08-12']);
        eq($u['status'], 200, 'PUT status');
        eq($u['json']['task']['check_state'], 'pending', 'pending после таймаута');
        ok($u['ms'] >= 2800 && $u['ms'] <= 4300, 'PUT занял ' . $u['ms'] . ' мс');
        $pendingIds[] = $id;
        usleep(1800000);   // mock дочитывает sleep
        return 'PUT ' . $u['ms'] . ' мс';
    });

    $run('H5 перепроверка: GET списка отвечает сразу, n8n зовётся ПОСЛЕ ответа, pending → ok, conflict по новому больничному', function () use ($A, $setCtl, $calls, $resetCalls, $resetClaim, $waitFor, $addEntry, $state, $pdo, &$pendingIds) {
        ok(count($pendingIds) === 2, 'ожидалось 2 pending-задачи');
        // Новый больничный исполнителя nn_a внутри периода H3 (2027-08-02..03) → conflict.
        $addEntry('nn_a', '2027-08-03', 'sick');
        $resetCalls();
        $resetClaim(3600);
        $setCtl(['recheck' => ['mode' => 'auto', 'delay_ms' => 2200]]);
        $r = $A('GET', '?from=2027-08-01&to=2027-08-31');
        eq($r['status'], 200, 'GET status');
        ok($r['ms'] < 1500, 'GET не ждёт n8n: ' . $r['ms'] . ' мс');
        $conf = [];
        foreach ($r['json']['tasks'] as $t) { $conf[$t['id']] = $t['conflict']; }
        eq($conf[$pendingIds[0]], true, 'conflict (live) у задачи с новым больничным');
        ok($waitFor(fn() => $state($pendingIds[0]) === 'ok' && $state($pendingIds[1]) === 'ok'), 'pending → ok за ожидание');
        $c = $calls('recheck');
        eq(count($c), 1, 'один вызов recheck');
        eq($c[0]['secret_ok'], true, 'секрет');
        eq(count($c[0]['body']['tasks']), 2, 'пакет из 2 задач');
        $raw = $c[0]['raw'];
        foreach (['Нэнэ', 'phone', 'photo', '900 123', 'title', 'H3', 'H4'] as $needle) {
            ok(stripos($raw, $needle) === false, "запрос recheck содержит '$needle'");
        }
        $aud = $pdo->query("SELECT entity_id, details, actor FROM audit_log WHERE action = 'task.recheck' ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
        eq(count($aud), 2, 'audit task.recheck ×2');
        $byId = [];
        foreach ($aud as $a) { $byId[$a['entity_id']] = json_decode($a['details'], true); }
        eq($byId[$pendingIds[0]]['conflict'], true, 'audit: conflict=true');
        eq($byId[$pendingIds[1]]['conflict'], false, 'audit: conflict=false');
        eq($aud[0]['actor'], 'system', 'actor');
        // version не менялся (вкладки не получают лишний 409).
        eq((int) $pdo->query("SELECT version FROM tasks WHERE id = " . $pdo->quote($pendingIds[0]))->fetchColumn(), 1, 'version');
        return 'GET ' . $r['ms'] . ' мс';
    });

    $run('H6 троттлинг: новая pending-задача не перепроверяется раньше чем через 15 мин; после — перепроверяется', function () use ($A, $setCtl, $calls, $resetCalls, $resetClaim, $waitFor, $state, $okVerdict) {
        $setCtl(['validate' => ['status' => 500, 'raw' => 'x']]);
        $r = $A('POST', '', ['title' => 'H6', 'start_at' => '2027-09-14', 'assignees' => ['nn_b']]);
        $id = $r['json']['task']['id'];
        eq($r['json']['task']['check_state'], 'pending', 'pending');
        $resetCalls();
        $setCtl(['recheck' => ['mode' => 'auto']]);
        $resetClaim(60);   // последняя попытка 1 мин назад
        $A('GET', '?from=2027-09-01&to=2027-09-30');
        usleep(600000);
        eq(count($calls('recheck')), 0, 'вызова нет (< 15 мин)');
        eq($state($id), 'pending', 'ещё pending');
        $resetClaim(901);
        $A('GET', '?from=2027-09-01&to=2027-09-30');
        ok($waitFor(fn() => $state($id) === 'ok'), 'после 15 мин → ok');
        eq(count($calls('recheck')), 1, 'ровно один вызов');
        return 'throttle ok';
    });

    $run('H7 n8n недоступен при перепроверке: GET 200 без задержки, задача остаётся pending, слот занят', function () use ($A, $setCtl, $calls, $resetCalls, $resetClaim, $waitFor, $state, $pdo) {
        $setCtl(['validate' => ['status' => 500, 'raw' => 'x']]);
        $r = $A('POST', '', ['title' => 'H7', 'start_at' => '2027-10-04', 'assignees' => ['nn_b']]);
        $id = $r['json']['task']['id'];
        eq($r['json']['task']['check_state'], 'pending', 'pending');
        $resetCalls();
        $setCtl(['recheck' => ['status' => 503, 'raw' => 'down']]);
        $resetClaim(3600);
        $g = $A('GET', '?from=2027-10-01&to=2027-10-31');
        eq($g['status'], 200, 'GET 200');
        ok($waitFor(fn() => count($calls('recheck')) === 1, 4000), 'recheck вызван');
        usleep(300000);
        eq($state($id), 'pending', 'pending');
        $g2 = $A('GET', '?from=2027-10-01&to=2027-10-31');
        eq($g2['status'], 200, 'GET 200 (2)');
        usleep(400000);
        eq(count($calls('recheck')), 1, 'повторно не зовётся в пределах 15 мин');
        $meta = (int) $pdo->query("SELECT value FROM meta WHERE key = 'tasks_recheck_at'")->fetchColumn();
        ok(abs(time() - $meta) < 30, 'метка перепроверки обновлена');
        return 'pending сохранён';
    });

    $run('H8 без переменных n8n приложение работает как раньше (PHP-режим): ok, вызовов нет — N7 + tasks_test', function () use ($setEnv, $calls, $resetCalls) {
        // Серверный процесс стартован с переменными; PHP-режим покрыт N7 и сьютом tasks (33 теста без n8n).
        $setEnv(false, false, null);
        $resetCalls();
        eq(tasks_n8n_config(), ['validate_url' => '', 'recheck_url' => '', 'secret' => ''], 'конфиг пуст');
        eq(tasks_external_validate([])['reason'], 'not_configured', 'not_configured');
        eq(count($calls()), 0, 'вызовов нет');
        return 'not_configured';
    });
} finally {
    proc_terminate($proc);
    proc_terminate($mockProc);
    @unlink($cookie);
    @unlink($serverLog);
    foreach (glob($mockDir . '/*') ?: [] as $f) { @unlink($f); }
    @rmdir($mockDir);
}

unset($pdo, $db);
@unlink($tmpDb);
@unlink($tmpDb . '-wal');
@unlink($tmpDb . '-shm');

$realDbHashAfter = is_file($realDb) ? sha1_file($realDb) : '';
$dbIntact = ($realDbHashBefore === $realDbHashAfter);

out('=== RESULTS: ' . $passed . ' passed, ' . $failed . ' failed out of ' . ($passed + $failed) . ' ===');
out('DB intact: ' . ($dbIntact ? 'YES' : 'NO'));
exit(($failed === 0 && $dbIntact) ? 0 : 1);
