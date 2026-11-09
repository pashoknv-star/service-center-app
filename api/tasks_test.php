<?php

declare(strict_types=1);

// Служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * tasks_test.php — тесты блока «Задачи» (T1-1): миграция БД v9, правила FR-10/11,
 * api/tasks.php (CRUD, RBAC, version, audit), calendar_facts, приватность.
 *
 * Usage:  php api/tasks_test.php
 *
 * Изолированный прогон: data/app.db копируется во временный файл, весь тест
 * (CLI-часть и временный `php -S`) работает через env SC_APP_DB на этой копии —
 * data/app.db не изменяется (проверяется sha1 до/после). Вывод в формате smoke:
 * «=== RESULTS: N passed, M failed ... ===» и «DB intact: YES».
 * Токен сервисного API читается из БД-копии и нигде не выводится.
 */

$root = realpath(__DIR__ . '/..');
if ($root === false) {
    fwrite(STDERR, "Cannot resolve project root\n");
    exit(1);
}
$realDb = $root . '/data/app.db';
$realDbHashBefore = is_file($realDb) ? sha1_file($realDb) : '';

$tmpDir = sys_get_temp_dir();
$tmpDb = tempnam($tmpDir, 'sc_tasks_db_');
if ($tmpDb === false || !copy($realDb, $tmpDb)) {
    fwrite(STDERR, "Cannot create temp DB copy\n");
    exit(1);
}
putenv('SC_APP_DB=' . $tmpDb);
putenv('TASKS_VALIDATE_WEBHOOK_URL'); // сброс: внешняя проверка не настроена
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

/** Снимок таблиц (md5 по строкам) для проверки «существующие данные не тронуты». */
function snapshotTables(PDO $pdo, array $skip = []): array
{
    $snap = [];
    $tables = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        ->fetchAll(PDO::FETCH_COLUMN);
    foreach ($tables as $t) {
        if (in_array($t, $skip, true)) {
            continue;
        }
        $rows = $pdo->query('SELECT * FROM "' . $t . '" ORDER BY rowid')->fetchAll(PDO::FETCH_ASSOC);
        $snap[$t] = [count($rows), md5(json_encode($rows))];
    }
    return $snap;
}

function tcols(PDO $pdo, string $table): array
{
    return $pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll(PDO::FETCH_COLUMN, 1);
}

// ----------------------------------------------------------------------------
// CLI-часть: миграция + правила (на копии БД)
// ----------------------------------------------------------------------------
$db = Database::getInstance();
$pdo = $db->getPDO();
$pdo->exec('PRAGMA busy_timeout = 5000');
$verBefore = $db->getSchemaVersion();
$snapBefore = snapshotTables($pdo, ['audit_log', 'meta']);
$metaBefore = $pdo->query("SELECT key, value FROM meta WHERE key != 'schema_version' ORDER BY key")->fetchAll(PDO::FETCH_ASSOC);

out('=== TASKS TEST START ===');

$run('M1 миграция: схема < 9 → 9, три таблицы созданы', function () use ($db, $pdo, $verBefore) {
    ok($verBefore < 9, 'ожидалась исходная схема < 9, а не ' . $verBefore);
    $has = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_assignees','task_checklist')")
        ->fetchAll(PDO::FETCH_COLUMN);
    ok(count($has) === 0, 'таблицы задач уже есть до миграции');
    $db->migrate();
    eq($db->getSchemaVersion(), 9, 'schema_version');
    $has = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_assignees','task_checklist') ORDER BY name")
        ->fetchAll(PDO::FETCH_COLUMN);
    eq($has, ['task_assignees', 'task_checklist', 'tasks'], 'tables');
    return 'v' . $verBefore . '→v9';
});

$run('M2 миграция: колонки и индексы по TZ §1', function () use ($pdo) {
    eq(tcols($pdo, 'tasks'), ['id', 'title', 'description', 'start_at', 'end_at', 'priority', 'label', 'status',
        'check_state', 'version', 'created_by', 'created_at', 'updated_at', 'closed_at', 'archived'], 'tasks cols');
    eq(tcols($pdo, 'task_assignees'), ['task_id', 'employee_id', 'role'], 'task_assignees cols');
    eq(tcols($pdo, 'task_checklist'), ['id', 'task_id', 'text', 'done', 'sort_order'], 'task_checklist cols');
    $idx = $pdo->query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_task%' ORDER BY name")
        ->fetchAll(PDO::FETCH_COLUMN);
    foreach (['idx_task_assignees_emp', 'idx_tasks_start_at', 'idx_tasks_status'] as $i) {
        ok(in_array($i, $idx, true), 'нет индекса ' . $i);
    }
    // Значения по умолчанию и CHECK-ограничения.
    $pdo->exec("INSERT INTO tasks (id, title, start_at) VALUES ('tt_def', 'x', '2030-01-01')");
    $r = $pdo->query("SELECT status, check_state, version, archived, priority FROM tasks WHERE id='tt_def'")->fetch(PDO::FETCH_ASSOC);
    eq([$r['status'], $r['check_state'], (int) $r['version'], (int) $r['archived'], (int) $r['priority']],
        ['open', 'pending', 1, 0, 2], 'defaults');
    foreach ([
        "INSERT INTO tasks (id, title, start_at, status) VALUES ('tt_bad1', 'x', '2030-01-01', 'weird')",
        "INSERT INTO tasks (id, title, start_at, priority) VALUES ('tt_bad2', 'x', '2030-01-01', 7)",
        "INSERT INTO tasks (id, title, start_at, check_state) VALUES ('tt_bad3', 'x', '2030-01-01', 'maybe')",
        "INSERT INTO task_assignees (task_id, employee_id, role) VALUES ('tt_def', 'nobody', 'watcher')",
        "INSERT INTO task_assignees (task_id, employee_id, role) VALUES ('tt_def', 'nobody', 'boss')",
    ] as $sql) {
        $threw = false;
        try { $pdo->exec($sql); } catch (PDOException $e) { $threw = true; }
        ok($threw, 'ограничение не сработало: ' . $sql);
    }
    $pdo->exec("DELETE FROM tasks WHERE id = 'tt_def'");
    return 'cols+indexes+CHECK';
});

$run('M3 миграция: существующие данные не тронуты', function () use ($pdo, $snapBefore, $metaBefore) {
    $snapAfter = snapshotTables($pdo, ['audit_log', 'meta', 'tasks', 'task_assignees', 'task_checklist']);
    foreach ($snapBefore as $t => $s) {
        ok(isset($snapAfter[$t]), 'таблица пропала: ' . $t);
        eq($snapAfter[$t], $s, 'таблица ' . $t);
    }
    $metaAfter = $pdo->query("SELECT key, value FROM meta WHERE key != 'schema_version' ORDER BY key")->fetchAll(PDO::FETCH_ASSOC);
    eq($metaAfter, $metaBefore, 'meta');
    return count($snapBefore) . ' таблиц побайтово равны';
});

$run('M4 миграция идемпотентна (повтор + откат версии на 8 с данными задач)', function () use ($db, $pdo) {
    $db->migrate();
    eq($db->getSchemaVersion(), 9, 'повторная миграция');
    $pdo->exec("INSERT INTO tasks (id, title, start_at) VALUES ('tt_keep', 'keep', '2030-01-02')");
    $pdo->exec("UPDATE meta SET value = '8' WHERE key = 'schema_version'");
    $db->migrate();
    eq($db->getSchemaVersion(), 9, 'миграция с v8');
    eq((int) $pdo->query("SELECT COUNT(*) FROM tasks WHERE id = 'tt_keep'")->fetchColumn(), 1, 'строка задачи сохранена');
    $pdo->exec("DELETE FROM tasks WHERE id = 'tt_keep'");
    return 'v9→v9, v8→v9';
});

// Фикстуры: сотрудники (с «секретными» phone/photo — проверка приватности ответов).
$PHONE = '+7 900 123-45-67';
$PHOTO = 'images/tt_photo_secret.jpg';
foreach ([['tt_a', 'Тестов Альфа'], ['tt_b', 'Тестов Браво'], ['tt_c', 'Тестов Чарли'], ['tt_d', 'Тестов Дельта'],
          ['tt_u1', 'Юнит Один'], ['tt_u2', 'Юнит Два'], ['tt_u3', 'Юнит Три']] as [$eid, $nm]) {
    $pdo->prepare('INSERT INTO employees (id, full_name, location, phone, photo_url, sort_order) VALUES (:i, :n, \'QA\', :p, :ph, 0)')
        ->execute([':i' => $eid, ':n' => $nm, ':p' => $PHONE, ':ph' => $PHOTO]);
}
$addEntry = function (string $emp, string $date, string $status) use ($pdo): void {
    $pdo->prepare('INSERT OR REPLACE INTO schedule_entries (employee_id, date, status, approval_status, version, updated_at)
                   VALUES (:e, :d, :s, \'draft\', 1, :t)')
        ->execute([':e' => $emp, ':d' => $date, ':s' => $status, ':t' => date('c')]);
};
$addTrip = function (string $emp, string $from, string $to, string $status = 'confirmed') use ($pdo): string {
    $tid = 'trip_tt_' . bin2hex(random_bytes(3));
    $pdo->prepare('INSERT INTO trips (id, title, status, version, created_by, created_at, updated_at) VALUES (:i, \'tt trip\', :s, 1, \'tt\', :t, :t)')
        ->execute([':i' => $tid, ':s' => $status, ':t' => date('c')]);
    $pdo->prepare('INSERT INTO trip_participants (trip_id, employee_id, start_date, end_date) VALUES (:i, :e, :f, :t)')
        ->execute([':i' => $tid, ':e' => $emp, ':f' => $from, ':t' => $to]);
    return $tid;
};

// --- Правила (unit) ---------------------------------------------------------
$run('R1 tasks_parse_when / tasks_validate_period', function () {
    eq(tasks_parse_when('2027-03-01'), ['date' => '2027-03-01', 'time' => null], 'date');
    eq(tasks_parse_when('2027-03-01T09:30'), ['date' => '2027-03-01', 'time' => '09:30'], 'datetime');
    eq(tasks_parse_when('2027-03-01T09:30:15')['time'], '09:30:15', 'seconds');
    foreach (['2027-02-30', '2027-13-01', '27-03-01', '2027-03-01T25:00', '2027-03-01 09:00', '', 'abc'] as $bad) {
        eq(tasks_parse_when($bad), null, 'bad ' . $bad);
    }
    eq(tasks_parse_when(123), null, 'non-string');
    $p = tasks_validate_period('2027-03-01', '2027-03-03');
    eq($p['days'], ['2027-03-01', '2027-03-02', '2027-03-03'], 'days');
    eq(tasks_validate_period('2027-03-01', null)['days'], ['2027-03-01'], 'single');
    eq(tasks_validate_period('2027-03-05', '2027-03-01')['error'], 'end_before_start', 'order');
    eq(tasks_validate_period('2027-03-01T10:00', '2027-03-01T09:00')['error'], 'end_before_start', 'same day time order');
    eq(tasks_validate_period('2027-03-01T10:00', '2027-03-01T10:00')['error'], null, 'same time ok');
    eq(tasks_validate_period('bad', null)['error'], 'invalid_start_at', 'bad start');
    eq(tasks_validate_period('2027-03-01', 'bad')['error'], 'invalid_end_at', 'bad end');
    eq(tasks_validate_period('2027-01-01', '2028-01-02')['error'], 'period_too_long', 'too long (367 дн.)');
    eq(tasks_validate_period('2027-01-01', '2028-01-01')['error'], null, '366 days ok');
    return 'формат/порядок/длина';
});

$run('R2 блок: sick, trip-запись матрицы, trips/trip_participants; vacation/day_off не блокируют', function () use ($pdo, $addEntry, $addTrip) {
    $addEntry('tt_u1', '2028-01-11', 'sick');
    $addEntry('tt_u1', '2028-01-12', 'vacation');
    $addEntry('tt_u1', '2028-01-13', 'day_off');
    $addEntry('tt_u2', '2028-01-12', 'trip');
    $tripId = $addTrip('tt_u2', '2028-01-14', '2028-01-15', 'forecast');
    $b = tasks_blocked_days($pdo, ['tt_u1', 'tt_u2'], '2028-01-10', '2028-01-16');
    eq($b, [
        ['date' => '2028-01-11', 'employee_id' => 'tt_u1', 'reason' => 'sick'],
        ['date' => '2028-01-12', 'employee_id' => 'tt_u2', 'reason' => 'trip'],
        ['date' => '2028-01-14', 'employee_id' => 'tt_u2', 'reason' => 'trip'],
        ['date' => '2028-01-15', 'employee_id' => 'tt_u2', 'reason' => 'trip'],
    ], 'blocked');
    $f = tasks_matrix_facts($pdo, ['tt_u2'], '2028-01-14', '2028-01-14');
    eq($f['tt_u2']['2028-01-14']['trip']['id'], $tripId, 'trip id в фактах');
    eq(tasks_blocked_days($pdo, [], '2028-01-10', '2028-01-16'), [], 'пустой список исполнителей');
    return '4 блока, vacation/day_off не блокируют';
});

$run('R3 suggested_start: ближайшая дата, где весь период вне блоков (несколько исполнителей)', function () use ($pdo, $addEntry) {
    $addEntry('tt_u1', '2028-02-02', 'sick');
    $addEntry('tt_u2', '2028-02-04', 'trip');
    $addEntry('tt_u2', '2028-02-05', 'trip');
    $r = tasks_check_period($pdo, ['tt_u1', 'tt_u2'], '2028-02-01', '2028-02-03');
    eq($r['ok'], false, 'ok');
    eq(count($r['blocked_days']), 1, 'blocked count');
    eq($r['suggested_start'], '2028-02-06', 'suggested_start');
    // Без блоков — ok и suggested_start не нужен.
    $r2 = tasks_check_period($pdo, ['tt_u1'], '2028-02-10', '2028-02-12');
    eq([$r2['ok'], $r2['suggested_start'], $r2['blocked_days']], [true, null, []], 'ok period');
    // Период длиннее зазора между блоками: 3 дня не помещаются между 02-02 и 02-04.
    eq(tasks_suggest_start($pdo, ['tt_u1', 'tt_u2'], '2028-02-03', 2), '2028-02-06', 'длинный период перепрыгивает зазор');
    eq(tasks_suggest_start($pdo, ['tt_u1', 'tt_u2'], '2028-02-03', 1), '2028-02-03', 'однодневный помещается в зазор');
    return 'start=02-06';
});

$run('R4 suggested_start: null, если в горизонте нет свободного окна', function () use ($pdo) {
    $pdo->beginTransaction();
    $ins = $pdo->prepare('INSERT OR REPLACE INTO schedule_entries (employee_id, date, status, approval_status, version, updated_at) VALUES (\'tt_u3\', :d, \'sick\', \'draft\', 1, \'x\')');
    for ($i = 0; $i <= TASKS_SUGGEST_HORIZON_DAYS; $i++) {
        $ins->execute([':d' => tasks_date_add('2028-03-01', $i)]);
    }
    $pdo->commit();
    eq(tasks_suggest_start($pdo, ['tt_u3'], '2028-03-01', 1), null, 'null');
    return 'горизонт ' . TASKS_SUGGEST_HORIZON_DAYS . ' дн.';
});

$run('R5 notes: выходной/праздник/отпуск — пометки без блока; holidays-таблица приоритетнее файлов', function () use ($pdo, $addEntry) {
    $addEntry('tt_u1', '2027-03-03', 'vacation');
    $addEntry('tt_u1', '2027-03-04', 'day_off');
    $r = tasks_check_period($pdo, ['tt_u1'], '2027-03-01', '2027-03-09');
    eq($r['ok'], true, 'не блокирует');
    $kinds = [];
    foreach ($r['notes'] as $n) { $kinds[] = $n['date'] . ':' . $n['kind'] . ':' . ($n['employee_id'] ?? '-'); }
    eq($kinds, ['2027-03-03:vacation:tt_u1', '2027-03-04:day_off:tt_u1', '2027-03-06:weekend:-',
        '2027-03-07:weekend:-', '2027-03-08:holiday:-'], 'notes');
    ok(!empty($r['notes'][4]['label']), 'у праздника есть label');
    // Ручная правка календаря в таблице holidays важнее data/holidays/*.json.
    $pdo->exec("INSERT OR REPLACE INTO holidays (date, type, label) VALUES ('2028-04-05', 'holiday', 'Тестовый праздник')");
    $pdo->exec("INSERT OR REPLACE INTO holidays (date, type, label) VALUES ('2028-04-08', 'working_weekend', NULL)");
    eq(tasks_day_info($pdo, '2028-04-05'), ['type' => 'holiday', 'label' => 'Тестовый праздник'], 'holidays table');
    eq(tasks_day_info($pdo, '2028-04-08')['type'], 'working_weekend', 'working_weekend');
    $r3 = tasks_check_period($pdo, ['tt_u1'], '2028-04-08', null);
    eq($r3['notes'], [], 'рабочая суббота — без пометки');
    $pdo->exec("DELETE FROM holidays WHERE date IN ('2028-04-05','2028-04-08')");
    // Год без файла data/holidays → fallback holidays_provider (выходные + праздники).
    eq(tasks_day_info($pdo, '2031-01-01')['type'], 'holiday', 'fallback holiday');
    $sat = new DateTimeImmutable('2031-03-01');
    while ($sat->format('N') !== '6') { $sat = $sat->modify('+1 day'); }
    eq(tasks_day_info($pdo, $sat->format('Y-m-d'))['type'], 'weekend', 'fallback weekend');
    return 'notes+holidays+fallback';
});

$run('R6 точка расширения n8n: check_state ok|pending', function () {
    eq(tasks_resolve_check_state(['configured' => false]), 'ok', 'не настроено → ok');
    eq(tasks_resolve_check_state(['configured' => true, 'available' => false]), 'pending', 'недоступно → pending');
    eq(tasks_resolve_check_state(['configured' => true, 'available' => true]), 'ok', 'доступно → ok');
    eq(tasks_external_validate(['employees' => [], 'from' => 'a', 'to' => 'b'])['configured'], false, 'env пуст');
    putenv('TASKS_VALIDATE_WEBHOOK_URL=http://127.0.0.1:9/never-called');
    try {
        $ext = tasks_external_validate(['employees' => [], 'from' => 'a', 'to' => 'b']);
        eq($ext['configured'], true, 'env задан');
        eq(tasks_resolve_check_state($ext), 'pending', 'n8n настроен, но вызов не реализован/недоступен → pending');
    } finally {
        putenv('TASKS_VALIDATE_WEBHOOK_URL');
    }
    return 'ok/pending';
});

// ----------------------------------------------------------------------------
// HTTP-часть: временный php -S на копии БД
// ----------------------------------------------------------------------------
$host = '127.0.0.1';
$port = null;
for ($attempt = 0; $attempt < 10; $attempt++) {
    $cand = 19500 + random_int(0, 400);
    $fp = @fsockopen($host, $cand, $errno, $errstr, 0.2);
    if ($fp) { fclose($fp); continue; }
    $port = $cand;
    break;
}
if ($port === null) {
    fwrite(STDERR, "No free port\n");
    exit(1);
}
$base = "http://{$host}:{$port}";
$serverLog = tempnam($tmpDir, 'sc_tasks_srv_');
$cookies = ['admin' => tempnam($tmpDir, 'sc_tk_a_'), 'sup' => tempnam($tmpDir, 'sc_tk_s_'), 'view' => tempnam($tmpDir, 'sc_tk_v_')];
$env = getenv();
$env['SC_APP_DB'] = $tmpDb;
unset($env['TASKS_VALIDATE_WEBHOOK_URL']);
$proc = proc_open(
    sprintf('exec php -S %s:%d -t %s > %s 2>&1', $host, $port, escapeshellarg($root), escapeshellarg($serverLog)),
    [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
    $pipes,
    $root,
    $env
);
if (!is_resource($proc)) {
    fwrite(STDERR, "Failed to start php -S\n");
    exit(1);
}
foreach ($pipes as $p) { fclose($p); }

function req(string $method, string $url, array $o = []): array
{
    $ch = curl_init($url);
    $headers = $o['headers'] ?? [];
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_FOLLOWLOCATION => false,
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
    $raw = curl_exec($ch);
    if ($raw === false) {
        $e = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('curl: ' . $e);
    }
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ['status' => $status, 'raw' => (string) $raw, 'json' => json_decode((string) $raw, true)];
}

$ready = false;
for ($i = 0; $i < 50; $i++) {
    usleep(200000);
    $fp = @fsockopen($host, $port, $errno, $errstr, 0.2);
    if ($fp) { fclose($fp); $ready = true; break; }
}
if (!$ready) {
    proc_terminate($proc);
    fwrite(STDERR, "Server did not start\n");
    exit(1);
}

$T = $base . '/api/tasks.php';
$login = function (string $who, string $user) use ($base, $cookies): void {
    $r = req('POST', $base . '/api/login.php', ['cookie' => $cookies[$who], 'body' => ['username' => $user, 'password' => 'changeme']]);
    if ($r['status'] !== 200) {
        throw new RuntimeException("login $user failed: " . $r['status']);
    }
};
$A = fn(string $m, string $q = '', ?array $body = null) => req($m, $T . $q, ['cookie' => $cookies['admin']] + ($body !== null ? ['body' => $body] : []));
$S = fn(string $m, string $q = '', ?array $body = null) => req($m, $T . $q, ['cookie' => $cookies['sup']] + ($body !== null ? ['body' => $body] : []));
$V = fn(string $m, string $q = '', ?array $body = null) => req($m, $T . $q, ['cookie' => $cookies['view']] + ($body !== null ? ['body' => $body] : []));
$N = fn(string $m, string $q = '', ?array $body = null) => req($m, $T . $q, $body !== null ? ['body' => $body] : []);
$taskCount = fn(): int => (int) $pdo->query('SELECT COUNT(*) FROM tasks')->fetchColumn();
$auditCount = fn(string $action, ?string $id = null): int => (int) ($id === null
    ? $pdo->query("SELECT COUNT(*) FROM audit_log WHERE action = '$action'")->fetchColumn()
    : $pdo->query("SELECT COUNT(*) FROM audit_log WHERE action = '$action' AND entity_id = '$id'")->fetchColumn());
$mk = function (array $over = []) use ($A): array {
    $body = $over + ['title' => 'T-' . bin2hex(random_bytes(3)), 'start_at' => '2027-04-05', 'end_at' => '2027-04-07', 'assignees' => ['tt_a']];
    $r = $A('POST', '', $body);
    if ($r['status'] !== 201) {
        throw new RuntimeException('mk failed: ' . $r['status'] . ' ' . substr($r['raw'], 0, 200));
    }
    return $r['json']['task'];
};
$seed = null;

try {
    $login('admin', 'admin');
    $login('sup', 'supervisor_zone0');
    $login('view', 'viewer_test');
    $seed = $mk(['title' => 'Seed', 'watchers' => ['tt_b'], 'description' => 'Описание', 'priority' => 3, 'label' => 'ремонт',
        'checklist' => [['text' => 'Шаг 1'], ['text' => 'Шаг 2', 'done' => true]]]);
    $seedId = $seed['id'];

    // --- RBAC ---------------------------------------------------------------
    $run('H1 RBAC anon: GET/POST/PUT/DELETE/close/reopen/calendar_facts → 401', function () use ($N, $seedId, $taskCount) {
        $n0 = $taskCount();
        $cases = [
            ['GET', ''], ['GET', '?id=' . $seedId], ['POST', '', ['title' => 'x', 'start_at' => '2027-04-05', 'assignees' => ['tt_a']]],
            ['PUT', '?id=' . $seedId, ['version' => 1, 'title' => 'hack']], ['DELETE', '?id=' . $seedId],
            ['POST', '?id=' . $seedId . '&action=close', []], ['POST', '?id=' . $seedId . '&action=reopen', []],
            ['GET', '?calendar_facts&employee_id=tt_a&from=2027-04-05&to=2027-04-06'],
        ];
        foreach ($cases as $c) {
            [$m, $q] = $c;
            $b = $c[2] ?? null;
            $r = $N($m, $q, $b);
            eq($r['status'], 401, "anon $m $q");
        }
        eq($taskCount(), $n0, 'данные не изменились');
        return count($cases) . ' запросов → 401';
    });

    $roleMatrix = function (string $label, callable $call, string $role) use ($A, $seedId, $taskCount, $auditCount) {
        $n0 = $taskCount();
        $a0 = $auditCount('task.create') + $auditCount('task.update') + $auditCount('task.close') + $auditCount('task.archive');
        $w = [
            ['POST', '', ['title' => 'x', 'start_at' => '2027-04-05', 'assignees' => ['tt_a']]],
            ['PUT', '?id=' . $seedId, ['version' => 1, 'title' => 'hack']],
            ['POST', '?id=' . $seedId . '&action=close', []],
            ['POST', '?id=' . $seedId . '&action=reopen', []],
            ['DELETE', '?id=' . $seedId],
        ];
        foreach ($w as $c) {
            [$m, $q] = $c;
            $r = $call($m, $q, $c[2] ?? null);
            eq($r['status'], 403, "$role $m $q");
        }
        $r = $call('GET', '');
        eq($r['status'], 200, "$role GET list");
        ok(is_array($r['json']['tasks'] ?? null), "$role list shape");
        $r = $call('GET', '?id=' . $seedId);
        eq($r['status'], 200, "$role GET id");
        eq($r['json']['task']['title'], 'Seed', "$role видит задачу");
        eq($taskCount(), $n0, 'данные не изменились');
        $a1 = $auditCount('task.create') + $auditCount('task.update') + $auditCount('task.close') + $auditCount('task.archive');
        eq($a1, $a0, 'аудит не пишется для отказов');
        $seedNow = $A('GET', '?id=' . $seedId)['json']['task'];
        eq([$seedNow['title'], $seedNow['status'], $seedNow['archived']], ['Seed', 'open', 0], 'seed не затронут');
        return '5 записей → 403, чтение 200';
    };
    $run('H2 RBAC supervisor: любая запись → 403, чтение → 200', fn() => $roleMatrix('sup', $S, 'supervisor'));
    $run('H3 RBAC viewer: любая запись → 403, чтение → 200', fn() => $roleMatrix('view', $V, 'viewer'));

    // --- CRUD / admin ---------------------------------------------------------
    $run('H4 admin POST: 201, вычисляемые поля, created_by, audit task.create (AC-1, AC-7)', function () use ($A, $pdo, $auditCount) {
        $r = $A('POST', '', ['title' => '  Проверить стенд  ', 'description' => 'Описание', 'start_at' => '2027-04-12T09:00', 'end_at' => '2027-04-14T18:00',
            'priority' => 1, 'label' => 'выезд', 'assignees' => ['tt_a', 'tt_b'], 'watchers' => ['tt_c', 'tt_a'],
            'checklist' => [['text' => 'Пункт'], 'Строка']]);
        eq($r['status'], 201, 'status');
        $t = $r['json']['task'];
        ok(str_starts_with($t['id'], 'task_'), 'id');
        eq($t['title'], 'Проверить стенд', 'trim title');
        eq([$t['status'], $t['version'], $t['check_state'], $t['priority'], $t['archived']], ['open', 1, 'ok', 1, 0], 'defaults');
        eq($t['first_day'], '2027-04-12', 'first_day');
        eq($t['days'], ['2027-04-12', '2027-04-13', '2027-04-14'], 'days');
        eq([$t['conflict'], $t['notes']], [false, []], 'conflict/notes');
        eq($t['created_by'], 'admin', 'created_by');
        eq(array_column($t['assignees'], 'employee_id'), ['tt_a', 'tt_b'], 'assignees');
        eq(array_column($t['watchers'], 'employee_id'), ['tt_c'], 'watcher, не дублирующий исполнителя');
        eq(array_column($t['checklist'], 'text'), ['Пункт', 'Строка'], 'checklist');
        eq($t['assignees'][0]['full_name'], 'Тестов Альфа', 'full_name');
        eq($auditCount('task.create', $t['id']), 1, 'audit task.create');
        $row = $pdo->query("SELECT actor, role, details FROM audit_log WHERE action='task.create' AND entity_id='" . $t['id'] . "'")->fetch(PDO::FETCH_ASSOC);
        eq([$row['actor'], $row['role']], ['admin', 'admin'], 'audit actor/role');
        // Задача без периода: end_at = NULL, один день.
        $r2 = $A('POST', '', ['title' => 'Один день', 'start_at' => '2027-04-20', 'assignees' => ['tt_a']]);
        eq($r2['status'], 201, 'single status');
        eq([$r2['json']['task']['end_at'], $r2['json']['task']['days']], [null, ['2027-04-20']], 'без периода');
        return $t['id'];
    });

    $run('H5 POST валидация → 400 без записи в БД', function () use ($A, $taskCount) {
        $n0 = $taskCount();
        $ok = ['title' => 'v', 'start_at' => '2027-04-05', 'assignees' => ['tt_a']];
        $cases = [
            'title_required'    => ['title' => ''] + $ok,
            'invalid_start_at'  => ['start_at' => '05.04.2027'] + $ok,
            'end_before_start'  => ['end_at' => '2027-04-01'] + $ok,
            'invalid_end_at'    => ['end_at' => 'zzz'] + $ok,
            'invalid_priority'  => ['priority' => 5] + $ok,
            'assignees_required' => ['assignees' => []] + $ok,
            'employee_not_found' => ['assignees' => ['nobody_x']] + $ok,
            'invalid_assignees' => ['assignees' => 'tt_a'] + $ok,
            'period_too_long'   => ['end_at' => '2029-04-05'] + $ok,
            'invalid_checklist' => ['checklist' => [['text' => '']]] + $ok,
            'invalid_title'     => ['title' => str_repeat('я', 201)] + $ok,
        ];
        foreach ($cases as $code => $body) {
            $r = $A('POST', '', $body);
            eq([$r['status'], $r['json']['error'] ?? null], [400, $code], 'case ' . $code);
        }
        $noAss = $ok;
        unset($noAss['assignees']);
        eq($A('POST', '', $noAss)['json']['error'] ?? null, 'assignees_required', 'без поля assignees');
        eq($taskCount(), $n0, 'ничего не создано');
        return count($cases) . ' кейсов';
    });

    $run('H6 PUT: правка, version++, audit task.update; без version → 400 (AC-1, AC-7)', function () use ($A, $mk, $auditCount) {
        $t = $mk();
        $r = $A('PUT', '?id=' . $t['id'], ['title' => 'Новое имя', 'priority' => 3, 'description' => null, 'label' => 'x', 'version' => 1]);
        eq($r['status'], 200, 'status');
        eq([$r['json']['task']['title'], $r['json']['task']['priority'], $r['json']['task']['version']], ['Новое имя', 3, 2], 'поля');
        eq($auditCount('task.update', $t['id']), 1, 'audit');
        $r = $A('PUT', '?id=' . $t['id'], ['title' => 'без версии']);
        eq([$r['status'], $r['json']['error']], [400, 'version_required'], 'version_required');
        $r = $A('PUT', '?id=nope_id', ['version' => 1, 'title' => 'x']);
        eq($r['status'], 404, 'unknown id');
        // Ничего не изменилось → версия и аудит не трогаются.
        $r = $A('PUT', '?id=' . $t['id'], ['title' => 'Новое имя', 'version' => 2]);
        eq([$r['status'], $r['json']['unchanged'] ?? null, $r['json']['task']['version']], [200, true, 2], 'unchanged');
        eq($auditCount('task.update', $t['id']), 1, 'audit не вырос');
        return 'v1→v2';
    });

    $run('H7 PUT: переназначение исполнителей/наблюдателей и чек-лист; audit хранит before/after', function () use ($A, $mk, $pdo) {
        $t = $mk(['assignees' => ['tt_a'], 'checklist' => [['text' => 'a'], ['text' => 'b']]]);
        $ids = array_column($t['checklist'], 'id');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => 1, 'assignees' => ['tt_c', 'tt_d'], 'watchers' => ['tt_a'],
            'checklist' => [['id' => $ids[1], 'text' => 'b', 'done' => true], ['text' => 'c']]]);
        eq($r['status'], 200, 'status ' . $r['raw']);
        $n = $r['json']['task'];
        eq(array_column($n['assignees'], 'employee_id'), ['tt_d', 'tt_c'], 'assignees (порядок по ФИО)');
        eq(array_column($n['watchers'], 'employee_id'), ['tt_a'], 'watchers');
        eq(array_column($n['checklist'], 'text'), ['b', 'c'], 'checklist');
        eq($n['checklist'][0]['id'], $ids[1], 'id пункта сохранён');
        eq($n['checklist'][0]['done'], true, 'done');
        $d = json_decode((string) $pdo->query("SELECT details FROM audit_log WHERE action='task.update' AND entity_id='" . $t['id'] . "'")->fetchColumn(), true);
        eq([$d['assignees_before'], $d['assignees_after']], [['tt_a'], ['tt_c', 'tt_d']], 'audit before/after');
        ok(in_array('assignees', $d['changed'], true) && in_array('checklist', $d['changed'], true), 'changed');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => 2, 'assignees' => []]);
        eq($r['json']['error'] ?? null, 'assignees_required', 'нельзя снять всех исполнителей');
        return 'переназначено';
    });

    $run('H8 AC-5: устаревший version → 409 VERSION_CONFLICT, данные не затираются', function () use ($A, $mk, $pdo) {
        $t = $mk(['title' => 'Исходное']);
        $r1 = $A('PUT', '?id=' . $t['id'], ['version' => 1, 'title' => 'Вкладка 1']);
        eq($r1['status'], 200, 'первая вкладка');
        $r2 = $A('PUT', '?id=' . $t['id'], ['version' => 1, 'title' => 'Вкладка 2 (устарела)', 'priority' => 1]);
        eq([$r2['status'], $r2['json']['error']], [409, 'VERSION_CONFLICT'], 'конфликт');
        eq($r2['json']['current_version'], 2, 'current_version');
        $row = $pdo->query("SELECT title, priority, version FROM tasks WHERE id='" . $t['id'] . "'")->fetch(PDO::FETCH_ASSOC);
        eq([$row['title'], (int) $row['priority'], (int) $row['version']], ['Вкладка 1', 2, 2], 'данные не затёрты');
        // То же для close и delete с устаревшей версией.
        eq($A('POST', '?id=' . $t['id'] . '&action=close', ['version' => 1])['status'], 409, 'close stale');
        eq($A('DELETE', '?id=' . $t['id'], ['version' => 1])['status'], 409, 'delete stale');
        eq((int) $pdo->query("SELECT archived FROM tasks WHERE id='" . $t['id'] . "'")->fetchColumn(), 0, 'не архивирована');
        return '409 на PUT/close/DELETE';
    });

    $run('H9 close/reopen: статусы, closed_at, version, audit; идемпотентность (AC-1, AC-7)', function () use ($A, $mk, $auditCount) {
        $t = $mk();
        $r = $A('POST', '?id=' . $t['id'] . '&action=close', ['version' => 1]);
        eq($r['status'], 200, 'close');
        $c = $r['json']['task'];
        eq([$c['status'], $c['version']], ['closed', 2], 'closed v2');
        ok($c['closed_at'] !== null, 'closed_at');
        $r = $A('POST', '?id=' . $t['id'] . '&action=close', []);
        eq([$r['status'], $r['json']['unchanged'] ?? null, $r['json']['task']['version']], [200, true, 2], 'повторный close');
        $r = $A('POST', '?id=' . $t['id'] . '&action=reopen', []);
        $o = $r['json']['task'];
        eq([$r['status'], $o['status'], $o['version'], $o['closed_at']], [200, 'open', 3, null], 'reopen');
        eq([$auditCount('task.close', $t['id']), $auditCount('task.reopen', $t['id'])], [1, 1], 'audit');
        eq($A('POST', '?id=' . $t['id'] . '&action=explode', [])['json']['error'] ?? null, 'invalid_action', 'invalid_action');
        eq($A('POST', '?id=' . $t['id'], [])['json']['error'] ?? null, 'invalid_action', 'POST без action');
        return 'open→closed→open';
    });

    $run('H10 DELETE = архив: archived=1, скрыта из списка, читается по id; изменения запрещены (AC-7)', function () use ($A, $mk, $auditCount) {
        $t = $mk(['start_at' => '2027-05-17', 'end_at' => '2027-05-18']);
        $r = $A('DELETE', '?id=' . $t['id']);
        eq($r['status'], 200, 'delete');
        eq([$r['json']['archived'], $r['json']['task']['archived'], $r['json']['task']['version']], [true, 1, 2], 'archived');
        $list = $A('GET', '?from=2027-05-17&to=2027-05-18')['json']['tasks'];
        ok(!in_array($t['id'], array_column($list, 'id'), true), 'скрыта из списка');
        $list = $A('GET', '?from=2027-05-17&to=2027-05-18&include_archived=1')['json']['tasks'];
        ok(in_array($t['id'], array_column($list, 'id'), true), 'видна с include_archived');
        eq($A('GET', '?id=' . $t['id'])['json']['task']['archived'], 1, 'GET по id');
        eq($A('PUT', '?id=' . $t['id'], ['version' => 2, 'title' => 'x'])['json']['error'] ?? null, 'task_archived', 'PUT');
        eq($A('POST', '?id=' . $t['id'] . '&action=reopen', [])['json']['error'] ?? null, 'task_archived', 'reopen');
        eq($A('DELETE', '?id=' . $t['id'])['json']['unchanged'] ?? null, true, 'повторный DELETE');
        eq($auditCount('task.archive', $t['id']), 1, 'audit task.archive');
        return 'archived=1';
    });

    $run('H11 GET список: диапазон, employee_id, без employee_id — все, status, валидация', function () use ($A, $mk) {
        $x = $mk(['title' => 'X', 'start_at' => '2027-12-06', 'end_at' => null, 'assignees' => ['tt_a']]);
        $y = $mk(['title' => 'Y', 'start_at' => '2027-12-13', 'end_at' => '2027-12-15', 'assignees' => ['tt_b']]);
        $z = $mk(['title' => 'Z', 'start_at' => '2027-12-20', 'end_at' => '2027-12-21', 'assignees' => ['tt_a'], 'watchers' => ['tt_b']]);
        $ids = fn(array $r) => array_column($r['json']['tasks'], 'id');
        $r = $A('GET', '?from=2027-12-01&to=2027-12-31');
        eq($r['status'], 200, 'status');
        eq($ids($r), [$x['id'], $y['id'], $z['id']], 'все задачи диапазона (без employee_id)');
        eq($ids($A('GET', '?from=2027-12-06&to=2027-12-12')), [$x['id']], 'диапазон 1');
        eq($ids($A('GET', '?from=2027-12-14&to=2027-12-14')), [$y['id']], 'пересечение срока');
        eq($ids($A('GET', '?from=2027-12-16&to=2027-12-19')), [], 'пустой диапазон');
        eq($ids($A('GET', '?from=2027-12-01&to=2027-12-31&employee_id=tt_b')), [$y['id'], $z['id']], 'employee_id (исполнитель или наблюдатель)');
        eq($ids($A('GET', '?from=2027-12-01&to=2027-12-31&employee_id=tt_a')), [$x['id'], $z['id']], 'employee_id tt_a');
        $A('POST', '?id=' . $y['id'] . '&action=close', []);
        eq($ids($A('GET', '?from=2027-12-01&to=2027-12-31&status=closed')), [$y['id']], 'status=closed');
        eq($ids($A('GET', '?from=2027-12-01&to=2027-12-31&status=open')), [$x['id'], $z['id']], 'status=open');
        eq($A('GET', '?from=bad')['json']['error'] ?? null, 'invalid_from', 'invalid_from');
        eq($A('GET', '?to=2027-13-01')['json']['error'] ?? null, 'invalid_to', 'invalid_to');
        eq($A('GET', '?status=zzz')['json']['error'] ?? null, 'invalid_status', 'invalid_status');
        eq($A('GET', '?id=unknown_task')['status'], 404, '404');
        return '3 задачи';
    });

    // --- FR-10 / AC-3 / AC-4 -------------------------------------------------------
    $run('F1 AC-3: sick в периоде → 422 TASK_BLOCKED_BY_SICK_OR_TRIP, blocked_days + suggested_start, без записи', function () use ($A, $addEntry, $taskCount, $auditCount) {
        $addEntry('tt_d', '2027-08-04', 'sick');
        $n0 = $taskCount();
        $a0 = $auditCount('task.create');
        $r = $A('POST', '', ['title' => 'Блок', 'start_at' => '2027-08-02', 'end_at' => '2027-08-06', 'assignees' => ['tt_d']]);
        eq([$r['status'], $r['json']['error']], [422, 'TASK_BLOCKED_BY_SICK_OR_TRIP'], 'код');
        eq($r['json']['blocked_days'], [['date' => '2027-08-04', 'employee_id' => 'tt_d', 'reason' => 'sick']], 'blocked_days');
        eq([$r['json']['suggested_start'], $r['json']['suggested_end']], ['2027-08-05', '2027-08-09'], 'suggested');
        // Время суток сохраняется в подсказке.
        $r = $A('POST', '', ['title' => 'Блок', 'start_at' => '2027-08-02T09:00', 'end_at' => '2027-08-06T18:00', 'assignees' => ['tt_d']]);
        eq([$r['json']['suggested_start'], $r['json']['suggested_end']], ['2027-08-05T09:00', '2027-08-09T18:00'], 'suggested с временем');
        // Подсказка действительно проходит.
        $r = $A('POST', '', ['title' => 'По подсказке', 'start_at' => '2027-08-05', 'end_at' => '2027-08-09', 'assignees' => ['tt_d']]);
        eq($r['status'], 201, 'подсказка принимается');
        eq($taskCount(), $n0 + 1, 'заблокированные не созданы');
        eq($auditCount('task.create'), $a0 + 1, 'audit только для созданной');
        return 'blocked_days+suggested_start';
    });

    $run('F2 FR-10: блок «любой исполнитель», наблюдатель не блокирует; trip-запись и trip_participants', function () use ($A, $addEntry, $addTrip) {
        // Любой из исполнителей: tt_d болен 2027-08-04, tt_a здоров.
        $r = $A('POST', '', ['title' => 'Двое', 'start_at' => '2027-08-04', 'assignees' => ['tt_a', 'tt_d']]);
        eq([$r['status'], $r['json']['blocked_days'][0]['employee_id']], [422, 'tt_d'], 'один из двух исполнителей');
        // Наблюдатель на больничном — не блок.
        $r = $A('POST', '', ['title' => 'Наблюдатель', 'start_at' => '2027-08-04', 'assignees' => ['tt_a'], 'watchers' => ['tt_d']]);
        eq($r['status'], 201, 'watcher не блокирует');
        // trip-запись в матрице.
        $addEntry('tt_d', '2027-08-18', 'trip');
        $r = $A('POST', '', ['title' => 'Trip', 'start_at' => '2027-08-18', 'assignees' => ['tt_d']]);
        eq([$r['status'], $r['json']['blocked_days'][0]['reason'], $r['json']['suggested_start']], [422, 'trip', '2027-08-19'], 'trip entry');
        // Командировка (trips + trip_participants).
        $addTrip('tt_c', '2027-09-06', '2027-09-08');
        $r = $A('POST', '', ['title' => 'Trip2', 'start_at' => '2027-09-01', 'end_at' => '2027-09-07', 'assignees' => ['tt_c']]);
        eq($r['status'], 422, 'trip participant');
        eq(array_column($r['json']['blocked_days'], 'date'), ['2027-09-06', '2027-09-07'], 'blocked dates');
        eq($r['json']['suggested_start'], '2027-09-09', 'suggested после командировки');
        return 'sick/trip/trips';
    });

    $run('F3 AC-3: выходные/праздник/отпуск/day_off в сроке сохраняются (только notes)', function () use ($A, $addEntry) {
        $addEntry('tt_b', '2027-03-03', 'vacation');
        $addEntry('tt_b', '2027-03-04', 'day_off');
        $r = $A('POST', '', ['title' => 'Через праздники', 'start_at' => '2027-03-01', 'end_at' => '2027-03-09', 'assignees' => ['tt_b']]);
        eq($r['status'], 201, 'сохранена');
        $t = $r['json']['task'];
        eq(count($t['days']), 9, '9 дней');
        eq($t['conflict'], false, 'нет conflict');
        $kinds = array_map(fn($n) => $n['date'] . ':' . $n['kind'], $t['notes']);
        eq($kinds, ['2027-03-03:vacation', '2027-03-04:day_off', '2027-03-06:weekend', '2027-03-07:weekend', '2027-03-08:holiday'], 'notes');
        // Те же notes приходят в GET по id и в списке.
        eq($A('GET', '?id=' . $t['id'])['json']['task']['notes'], $t['notes'], 'GET id notes');
        $list = $A('GET', '?from=2027-03-01&to=2027-03-09&employee_id=tt_b')['json']['tasks'];
        eq($list[0]['notes'], $t['notes'], 'list notes');
        return '5 пометок';
    });

    $run('F4 FR-10 при PUT: удлинение/переназначение на блок → 422; правка текста конфликтной задачи не блокируется', function () use ($A, $mk, $addEntry, $pdo) {
        $t = $mk(['title' => 'Растянуть', 'start_at' => '2027-10-04', 'end_at' => '2027-10-05', 'assignees' => ['tt_a']]);
        $addEntry('tt_a', '2027-10-07', 'sick');
        $addEntry('tt_d', '2027-10-05', 'sick');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => 1, 'end_at' => '2027-10-08']);
        eq([$r['status'], $r['json']['error']], [422, 'TASK_BLOCKED_BY_SICK_OR_TRIP'], 'удлинение');
        eq($r['json']['blocked_days'][0]['date'], '2027-10-07', 'blocked date');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => 1, 'assignees' => ['tt_d']]);
        eq($r['status'], 422, 'переназначение на больного');
        $row = $pdo->query("SELECT end_at, version FROM tasks WHERE id='" . $t['id'] . "'")->fetch(PDO::FETCH_ASSOC);
        eq([$row['end_at'], (int) $row['version']], ['2027-10-05', 1], 'не изменилась');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => 1, 'end_at' => '2027-10-06']);
        eq($r['status'], 200, 'безопасное удлинение');
        // Позже появился больничный внутри срока → conflict; правка текста проходит.
        $addEntry('tt_a', '2027-10-06', 'sick');
        $c = $A('GET', '?id=' . $t['id'])['json']['task'];
        eq($c['conflict'], true, 'conflict');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => 2, 'title' => 'Переименовать конфликтную']);
        eq($r['status'], 200, 'правка текста конфликтной задачи');
        return '422 / 200';
    });

    $run('F5 AC-4: больничный поверх задачи не блокируется, задача получает conflict (закрытая — нет)', function () use ($A, $mk, $base, $cookies) {
        $t = $mk(['title' => 'Под больничный', 'start_at' => '2027-11-15', 'end_at' => '2027-11-17', 'assignees' => ['tt_a']]);
        eq($A('GET', '?id=' . $t['id'])['json']['task']['conflict'], false, 'до больничного');
        $r = req('POST', $base . '/api/entries.php', ['cookie' => $cookies['admin'], 'body' => ['employeeId' => 'tt_a', 'date' => '2027-11-16', 'status' => 'sick']]);
        ok(in_array($r['status'], [200, 201], true), 'запись больничного прошла: ' . $r['status'] . ' ' . substr($r['raw'], 0, 120));
        $g = $A('GET', '?id=' . $t['id'])['json']['task'];
        eq($g['conflict'], true, 'conflict после больничного');
        eq($g['conflict_days'], [['date' => '2027-11-16', 'employee_id' => 'tt_a', 'reason' => 'sick']], 'conflict_days');
        eq($g['status'], 'open', 'задача не тронута');
        $list = $A('GET', '?from=2027-11-15&to=2027-11-17')['json']['tasks'];
        eq($list[0]['conflict'], true, 'conflict в списке');
        $A('POST', '?id=' . $t['id'] . '&action=close', []);
        eq($A('GET', '?id=' . $t['id'])['json']['task']['conflict'], false, 'закрытая — без conflict');
        $A('POST', '?id=' . $t['id'] . '&action=reopen', []);
        eq($A('GET', '?id=' . $t['id'])['json']['task']['conflict'], true, 'после reopen conflict снова');
        return 'conflict_days=1';
    });

    // --- calendar_facts --------------------------------------------------------------
    $token = (string) $pdo->query("SELECT value FROM meta WHERE key = 'external_api_token'")->fetchColumn();
    $F = fn(string $q, ?string $tok = null, ?string $cookie = null) => req('GET', $T . '?calendar_facts' . $q, array_filter([
        'headers' => $tok !== null ? ['Authorization: Bearer ' . $tok] : [],
        'cookie'  => $cookie,
    ]));

    $run('C1 calendar_facts: без токена/с неверным токеном/по сессии → 401', function () use ($F, $cookies, $token) {
        $q = '&employee_id=tt_a&from=2027-03-06&to=2027-03-08';
        eq($F($q)['status'], 401, 'без токена');
        eq($F($q)['json']['error'], 'missing_bearer_token', 'код');
        eq($F($q, 'wrong-token-value')['status'], 401, 'неверный');
        eq($F($q, 'wrong-token-value')['json']['error'], 'invalid_token', 'код 2');
        eq($F($q, null, $cookies['admin'])['status'], 401, 'admin-сессия без токена не годится');
        eq($F($q, null, $cookies['sup'])['status'], 401, 'supervisor-сессия');
        ok($token !== '', 'в БД есть сервисный токен');
        return '401 ×5';
    });

    $run('C2 calendar_facts: статус матрицы, выходной/праздник, trip по дням', function () use ($F, $token) {
        $r = $F('&employee_id=tt_a&from=2027-03-06&to=2027-03-09', $token);
        eq($r['status'], 200, 'status');
        $d = $r['json']['facts']['tt_a'];
        eq(array_column($d, 'date'), ['2027-03-06', '2027-03-07', '2027-03-08', '2027-03-09'], 'даты');
        eq([$d[0]['day_type'], $d[0]['is_day_off']], ['weekend', true], 'суббота');
        eq([$d[2]['day_type'], $d[2]['is_day_off']], ['holiday', true], 'праздник');
        ok(!empty($d[2]['holiday_label']), 'label праздника');
        eq([$d[3]['day_type'], $d[3]['is_day_off']], ['workday', false], 'будний');
        // Статус матрицы и trip.
        $r = $F('&employee_id=tt_d,tt_c&from=2027-08-03&to=2027-08-05', $token);
        eq($r['json']['facts']['tt_d'][1]['matrix_status'], 'sick', 'sick в матрице');
        eq($r['json']['facts']['tt_d'][0]['matrix_status'], null, 'нет записи → null');
        $r = $F('&employee_id=tt_c&from=2027-09-05&to=2027-09-06', $token);
        eq($r['json']['facts']['tt_c'][0]['trip'], null, 'нет trip');
        ok(is_array($r['json']['facts']['tt_c'][1]['trip']) && !empty($r['json']['facts']['tt_c'][1]['trip']['id']), 'trip 09-06');
        return 'weekend/holiday/sick/trip';
    });

    $run('C3 calendar_facts: валидация параметров', function () use ($F, $token) {
        eq($F('&from=2027-03-06&to=2027-03-08', $token)['json']['error'], 'employee_id_required', 'без employee_id');
        eq($F('&employee_id=tt_a&to=2027-03-08', $token)['json']['error'], 'invalid_from', 'без from');
        eq($F('&employee_id=tt_a&from=2027-03-06&to=nope', $token)['json']['error'], 'invalid_to', 'bad to');
        eq($F('&employee_id=tt_a&from=2027-03-09&to=2027-03-06', $token)['json']['error'], 'date_range_invalid', 'order');
        eq($F('&employee_id=tt_a&from=2027-01-01&to=2028-12-31', $token)['json']['error'], 'period_too_long', 'long');
        $r = $F('&employee_id=nobody_x&from=2027-03-06&to=2027-03-08', $token);
        eq([$r['status'], $r['json']['error']], [400, 'employee_not_found'], 'unknown employee');
        return '6 кейсов → 400';
    });

    $run('P1 приватность: ни список, ни карточка, ни calendar_facts не содержат телефонов/фото; токен не светится', function () use ($A, $F, $token, $seedId, $PHONE, $PHOTO, $pdo) {
        $raws = [
            $A('GET', '?from=2027-01-01&to=2028-12-31&include_archived=1')['raw'],
            $A('GET', '?id=' . $seedId)['raw'],
            $F('&employee_id=tt_a,tt_b&from=2027-03-01&to=2027-03-31', $token)['raw'],
            $A('POST', '', ['title' => 'p', 'start_at' => '2027-04-26', 'assignees' => ['tt_a'], 'watchers' => ['tt_b']])['raw'],
        ];
        $checked = 0;
        foreach ($raws as $i => $raw) {
            ok(strlen($raw) > 50, "ответ $i непустой");
            foreach (['phone', 'photo', '900 123', 'tt_photo_secret', $PHONE, $PHOTO] as $needle) {
                ok(stripos($raw, $needle) === false, "ответ $i содержит '$needle'");
            }
            ok(strpos($raw, $token) === false, "ответ $i содержит токен");
            $checked++;
        }
        $audit = (string) $pdo->query("SELECT group_concat(details, ' ') FROM audit_log WHERE action LIKE 'task.%'")->fetchColumn();
        ok(stripos($audit, '900 123') === false && stripos($audit, 'photo') === false, 'audit_log без phone/photo');
        return $checked . ' ответов + audit чисты';
    });

    $run('H12 AC-7: audit_log содержит все мутации (create/update/close/reopen/archive) с actor=admin', function () use ($pdo) {
        $rows = $pdo->query("SELECT action, COUNT(*) c, MIN(actor) a, MAX(actor) b, MIN(role) r FROM audit_log WHERE entity_type='task' GROUP BY action")->fetchAll(PDO::FETCH_ASSOC);
        $by = [];
        foreach ($rows as $r) { $by[$r['action']] = $r; }
        foreach (['task.create', 'task.update', 'task.close', 'task.reopen', 'task.archive'] as $a) {
            ok(isset($by[$a]) && (int) $by[$a]['c'] >= 1, 'нет записей ' . $a);
            eq([$by[$a]['a'], $by[$a]['b'], $by[$a]['r']], ['admin', 'admin', 'admin'], 'actor/role ' . $a);
        }
        // Каждая созданная задача имеет ровно одну запись task.create.
        $missing = (int) $pdo->query("SELECT COUNT(*) FROM tasks t WHERE NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.action='task.create' AND a.entity_id=t.id)")->fetchColumn();
        eq($missing, 0, 'задач без task.create в аудите');
        return implode(',', array_map(fn($r) => $r['action'] . '=' . $r['c'], $rows));
    });

    $run('G1 регрессия: holidays_provider (endpoint) отдаёт тот же JSON после рефакторинга в библиотеку', function () use ($base, $root) {
        $r = req('GET', $base . '/api/holidays_provider.php?year=2027');
        eq($r['status'], 200, 'status');
        $file = json_decode((string) file_get_contents($root . '/data/holidays/2027.json'), true);
        eq($r['json'], $file, 'совпадает с data/holidays/2027.json');
        $r = req('GET', $base . '/api/holidays_provider.php?year=2031');
        eq($r['json']['holidays']['2031-01-01']['type'] ?? null, 'holiday', 'fallback без файла');
        eq(req('GET', $base . '/api/holidays_provider.php?year=1999')['status'], 400, 'год вне диапазона');
        eq(req('POST', $base . '/api/holidays_provider.php?year=2027')['status'], 405, 'POST → 405');
        return 'endpoint не изменился';
    });

    $run('G2 нет утечки: ошибки не раскрывают пути; OPTIONS → 204; неподдерживаемый метод → 405', function () use ($A, $T) {
        $r = req('OPTIONS', $T);
        eq($r['status'], 204, 'OPTIONS');
        $r = $A('PATCH', '?id=x');
        eq($r['status'], 405, 'PATCH');
        $r = $A('POST', '', null);
        ok(in_array($r['status'], [400, 422], true), 'POST без тела → 400');
        ok(strpos($r['raw'], '/home/') === false && strpos($r['raw'], '.php') === false, 'нет путей в ответе');
        return 'ok';
    });
} finally {
    proc_terminate($proc);
    foreach ($cookies as $c) { @unlink($c); }
    @unlink($serverLog);
}

// Явно закрываем соединение и удаляем копию БД.
unset($pdo, $db);
@unlink($tmpDb);
@unlink($tmpDb . '-wal');
@unlink($tmpDb . '-shm');

$realDbHashAfter = is_file($realDb) ? sha1_file($realDb) : '';
$dbIntact = ($realDbHashBefore === $realDbHashAfter);

out('=== RESULTS: ' . $passed . ' passed, ' . $failed . ' failed out of ' . ($passed + $failed) . ' ===');
out('DB intact: ' . ($dbIntact ? 'YES' : 'NO'));
exit(($failed === 0 && $dbIntact) ? 0 : 1);
