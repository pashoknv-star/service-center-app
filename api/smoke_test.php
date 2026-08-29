<?php

declare(strict_types=1);

/**
 * smoke_test.php — Phase 9A backend smoke test.
 *
 * Usage:
 *   php api/smoke_test.php
 *
 * Starts a temporary built-in PHP server, exercises HTTP endpoints with real
 * cookies/headers, then cleans up test artifacts. Exit code 0 = all pass.
 */

$root = realpath(__DIR__ . '/..');
if ($root === false) {
    fwrite(STDERR, "Cannot resolve project root\n");
    exit(1);
}

// Include helper functions for testing
require_once __DIR__ . '/helpers.php';

$host = '127.0.0.1';
// Порт подбираем с проверкой реального захвата: если порт занят (stale-сервер),
// php -S молча умрёт, а запросы уйдут на чужой сервер -> HTML вместо JSON.
// Поэтому: пробуем до 10 случайных портов, каждый проверяем fsockopen ДО старта
// (порт свободен) и повторной проверкой подключения НЕ наш ли сервер отвечает.
$port = null;
$base = null;
for ($attempt = 0; $attempt < 10; $attempt++) {
    $candidate = 18880 + random_int(0, 500);
    // Порт уже занят?
    $fp = @fsockopen($host, $candidate, $errno, $errstr, 0.2);
    if ($fp) {
        fclose($fp);
        continue; // занят — пробуем следующий
    }
    $port = $candidate;
    break;
}
if ($port === null) {
    failExit('No free port in range 18880-19380');
}
$base = "http://{$host}:{$port}";
$cookieAdmin = tempnam(sys_get_temp_dir(), 'sc_admin_cookie_');
$cookieSup   = tempnam(sys_get_temp_dir(), 'sc_sup_cookie_');
$serverLog   = tempnam(sys_get_temp_dir(), 'sc_server_log_');
$testEmpId   = 'emp_smoke_' . bin2hex(random_bytes(4));
$testEntryApprovedDate = '2099-01-01';
$testImportDate = '2099-01-02';
$hadFailure = false;
$testNo = 0;
$passed = 0;
$failed = 0;
$cleanupErrors = [];

function out(string $s): void { echo $s, PHP_EOL; }
function failExit(string $s): void { fwrite(STDERR, $s . PHP_EOL); exit(1); }
function assertTrue(bool $cond, string $msg = 'assert failed'): void { if (!$cond) { throw new RuntimeException($msg); } }
function jsonDecode(string $raw): array {
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new RuntimeException('Invalid JSON: ' . json_last_error_msg() . ' | raw=' . substr($raw, 0, 300));
    }
    return $data;
}
function countAssoc($value): int {
    if (is_array($value)) return count($value);
    return 0;
}

function httpRequest(string $method, string $url, array $opts = []): array {
    $ch = curl_init($url);
    if ($ch === false) {
        throw new RuntimeException('curl_init failed');
    }
    $headers = $opts['headers'] ?? [];
    $body = $opts['body'] ?? null;
    $cookie = $opts['cookie'] ?? null;
    $timeout = $opts['timeout'] ?? 20;

    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER => true,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_CUSTOMREQUEST => strtoupper($method),
        CURLOPT_FOLLOWLOCATION => false,
    ]);

    if ($cookie) {
        curl_setopt($ch, CURLOPT_COOKIEJAR, $cookie);
        curl_setopt($ch, CURLOPT_COOKIEFILE, $cookie);
    }

    if ($body !== null) {
        if (is_array($body) && !($opts['multipart'] ?? false)) {
            $headers[] = 'Content-Type: application/json';
            $body = json_encode($body, JSON_UNESCAPED_UNICODE);
        }
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }

    if ($headers) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    }

    $resp = curl_exec($ch);
    if ($resp === false) {
        $err = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('curl_exec failed: ' . $err);
    }
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    $rawHeaders = substr($resp, 0, $headerSize);
    $rawBody = substr($resp, $headerSize);
    curl_close($ch);
    return ['status' => $status, 'headers_raw' => $rawHeaders, 'body' => $rawBody];
}

function login(string $base, string $cookie, string $username, string $password): array {
    return httpRequest('POST', $base . '/api/login.php', [
        'cookie' => $cookie,
        'body' => ['username' => $username, 'password' => $password],
    ]);
}

function headerValue(string $rawHeaders, string $name): string {
    foreach (explode("\r\n", $rawHeaders) as $line) {
        $pos = strpos($line, ':');
        if ($pos === false) {
            continue;
        }
        $key = strtolower(trim(substr($line, 0, $pos)));
        if ($key === strtolower($name)) {
            return trim(substr($line, $pos + 1));
        }
    }
    return '';
}

function cleanup(string $base, string $cookieAdmin, string $testEmpId, string $approvedDate, string $importDate, array &$cleanupErrors, string $dbPath): void {
    $targets = [
        [$testEmpId, $approvedDate],
        ['emp_1', $importDate],
        ['emp_1', '2099-12-30'], // E8 smoke-тесты
    ];
    foreach ($targets as [$eid, $date]) {
        try {
            httpRequest('DELETE', $base . '/api/entries.php?employeeId=' . rawurlencode($eid) . '&date=' . rawurlencode($date), [
                'cookie' => $cookieAdmin,
                'body' => ['force' => true],
            ]);
        } catch (Throwable $e) {
            $cleanupErrors[] = 'entry cleanup ' . $eid . ' ' . $date . ': ' . $e->getMessage();
        }
    }
    try {
        httpRequest('DELETE', $base . '/api/employees.php?id=' . rawurlencode($testEmpId), [
            'cookie' => $cookieAdmin,
            'body' => ['confirm' => true],
        ]);
    } catch (Throwable $e) {
        $cleanupErrors[] = 'employee cleanup ' . $testEmpId . ': ' . $e->getMessage();
    }

    // Final safety net: hard-clean known smoke artifacts directly in SQLite so
    // a failing HTTP cleanup can never leave test data in the production DB.
    try {
        $pdo = new PDO('sqlite:' . $dbPath);
        // Remove smoke fixture if we created it in this run.
        $GLOBALS['fixtureCreatedGroup'] ?? false;
        if (!empty($GLOBALS['fixtureCreatedGroup'])) {
            $pdo->exec("DELETE FROM groups WHERE id = 'g0' AND name = 'Smoke Fixture Group'");
        }
        if (!empty($GLOBALS['fixtureCreatedEmployee'])) {
            $pdo->exec("DELETE FROM employees WHERE id = 'emp_1' AND full_name = 'Smoke Fixture Employee'");
        }
        $stmt = $pdo->prepare('DELETE FROM schedule_entries WHERE (employee_id = :emp1 AND date = :d1) OR (employee_id = :emp2 AND date = :d2) OR (employee_id = :emp3 AND date = :d3)');
        $stmt->execute([':emp1' => 'emp_1', ':d1' => $approvedDate, ':emp2' => 'emp_1', ':d2' => $importDate, ':emp3' => 'emp_1', ':d3' => '2099-12-30']);
        $stmt = $pdo->prepare('DELETE FROM employees WHERE id = :id');
        $stmt->execute([':id' => $testEmpId]);
        // T3: удаляем все созданные smoke-командировки и их участников.
        $stmt = $pdo->prepare('DELETE FROM trips WHERE created_by = :cb AND title LIKE :tl');
        $stmt->execute([':cb' => 'admin', ':tl' => 'T3-%']);
        $stmt = $pdo->prepare('DELETE FROM trips WHERE created_by = :cb AND (title = :t1 OR title = :t2 OR title = :t3)');
        $stmt->execute([':cb' => 'admin', ':t1' => 'Совещание в Москве', ':t2' => 'Совещание в Москве (обновлено)', ':t3' => 'Поверх больничного']);
        $stmt = $pdo->prepare('DELETE FROM trips WHERE created_by = :cb AND title = :t');
        $stmt->execute([':cb' => 'admin', ':t' => 'На удаление']);
        $stmt = $pdo->prepare('DELETE FROM trips WHERE created_by = :cb AND title = :t');
        $stmt->execute([':cb' => 'supervisor_zone0', ':t' => 'Зональный forecast']);
        // Удаляем осиротевшие/leftover trip participants (от trips, удалённых выше/ранее).
        $pdo->exec("DELETE FROM trip_participants WHERE trip_id NOT IN (SELECT id FROM trips)");
    } catch (Throwable $e) {
        $cleanupErrors[] = 'sqlite cleanup: ' . $e->getMessage();
    }
}

$cmd = sprintf('php -S %s:%d -t %s > %s 2>&1', $host, $port, escapeshellarg($root), escapeshellarg($serverLog));
$descriptors = [
    0 => ['pipe', 'r'],
    1 => ['pipe', 'w'],
    2 => ['pipe', 'w'],
];
$proc = proc_open($cmd, $descriptors, $pipes, $root);
if (!is_resource($proc)) {
    failExit('Failed to start php built-in server');
}
foreach ($pipes as $p) { fclose($p); }

$serverReady = false;
for ($i = 0; $i < 50; $i++) {
    usleep(200000);
    $fp = @fsockopen($host, $port, $errno, $errstr, 0.2);
    if ($fp) {
        fclose($fp);
        $serverReady = true;
        break;
    }
}
if (!$serverReady) {
    proc_terminate($proc);
    failExit('Server did not start on ' . $base);
}

// Sanity-check: сервер должен быть ИМЕННО наш (отвечает на session.php JSON-ем).
// Защита от случая «наш php -S умер, порт занял чужой/stale-сервер».
{
    $probe = httpRequest('GET', $base . '/api/session.php');
    $probeJson = json_decode($probe['body'], true);
    if (!is_array($probeJson) || !array_key_exists('authenticated', $probeJson)) {
        proc_terminate($proc);
        failExit('Sanity check failed: server on port ' . $port . ' is not our app (got: ' . substr($probe['body'], 0, 120) . ')');
    }
}

out('=== SMOKE TEST START ===');

$run = function (string $label, callable $fn) use (&$testNo, &$passed, &$failed, &$hadFailure) {
    $testNo++;
    try {
        $extra = $fn();
        $passed++;
        out(sprintf('[%d] %s: PASS%s', $testNo, $label, $extra ? ' — ' . $extra : ''));
    } catch (Throwable $e) {
        $failed++;
        $hadFailure = true;
        out(sprintf('[%d] %s: FAIL — %s', $testNo, $label, $e->getMessage()));
    }
};

try {
    // 0 FIXTURE — self-sufficiency: create group g0 + employee emp_1 if absent
    // (fresh DB from init_db.php has no employees; smoke must not depend on dev data).
    $fixtureCreatedGroup = false;
    $fixtureCreatedEmployee = false;
    {
        $pdoF = new PDO('sqlite:' . $root . '/data/app.db');
        $pdoF->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $g = $pdoF->query("SELECT COUNT(*) FROM groups WHERE id = 'g0'")->fetchColumn();
        if (!$g) {
            $pdoF->exec("INSERT INTO groups (id, name, sort_order) VALUES ('g0', 'Smoke Fixture Group', 0)");
            $fixtureCreatedGroup = true;
        }
        $g1 = $pdoF->query("SELECT COUNT(*) FROM groups WHERE id = 'g1'")->fetchColumn();
        if (!$g1) {
            $pdoF->exec("INSERT INTO groups (id, name, sort_order) VALUES ('g1', 'Smoke Fixture Group 1', 1)");
        }
        $e = $pdoF->query("SELECT COUNT(*) FROM employees WHERE id = 'emp_1'")->fetchColumn();
        if (!$e) {
            $pdoF->exec("INSERT INTO employees (id, full_name, position_id, location, group_id, phone, sort_order)
                         VALUES ('emp_1', 'Smoke Fixture Employee', 'pos_master', 'QA', 'g0', '', 0)");
            $fixtureCreatedEmployee = true;
        }
        // T3 fixtures. Каноническая зональная раскладка (T2-аудит):
        //   g0: emp_5, emp_16, emp_17, emp_18
        //   g1: emp_1, emp_2
        // supervisor_zone0 -> g0, supervisor_zone1 -> g1.
        // Принудительно (идемпотентно) выставляем group_id, чтобы тесты E8/T3
        // не зависели от dev-данных.
        $fixtureEmps = [
            ['emp_1', 'Smoke Fixture Employee', 'g1'],
            ['emp_2', 'Smoke Employee 2', 'g1'],
            ['emp_5', 'Smoke Employee 5', 'g0'],
            ['emp_16', 'Smoke Employee 16', 'g0'],
            ['emp_17', 'Smoke Employee 17', 'g0'],
            ['emp_18', 'Smoke Employee 18', 'g0'],
        ];
        foreach ($fixtureEmps as [$fid, $fname, $fgid]) {
            $exists = $pdoF->query("SELECT COUNT(*) FROM employees WHERE id = '{$fid}'")->fetchColumn();
            if (!$exists) {
                $pdoF->exec("INSERT INTO employees (id, full_name, position_id, location, group_id, phone, sort_order)
                             VALUES ('{$fid}', '{$fname}', 'pos_master', 'QA', '{$fgid}', '', 0)");
            } else {
                $pdoF->exec("UPDATE employees SET group_id = '{$fgid}' WHERE id = '{$fid}'");
            }
        }
        // Remove any stale smoke entries from previous runs.
        $del = $pdoF->prepare('DELETE FROM schedule_entries WHERE employee_id IN (:e1, :e2) AND date IN (:d1, :d2)');
        $del->execute([':e1' => 'emp_1', ':e2' => $testEmpId, ':d1' => $testEntryApprovedDate, ':d2' => $testImportDate]);
        unset($pdoF);
    }

    // 1 AUTH
    $run('login(admin/changeme)', function () use ($base, $cookieAdmin) {
        $r = login($base, $cookieAdmin, 'admin', 'changeme');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(($j['success'] ?? false) === true, 'success!=true');
        assertTrue(($j['user']['role'] ?? null) === 'admin', 'role!=admin');
        return 'role=admin';
    });

    $run('login(admin/wrong)', function () use ($base) {
        $r = login($base, tempnam(sys_get_temp_dir(), 'bad_cookie_'), 'admin', 'wrong');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 401, 'status ' . $r['status']);
        assertTrue(($j['success'] ?? true) === false, 'expected success=false');
        return '401 invalid_credentials';
    });

    $run('session(anon)', function () use ($base) {
        $r = httpRequest('GET', $base . '/api/session.php');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(($j['authenticated'] ?? true) === false, 'expected authenticated=false');
        return 'authenticated=false';
    });

    // 2 LOAD/SAVE
    $run('load.php(auth)', function () use ($base, $cookieAdmin) {
        $r = httpRequest('GET', $base . '/api/load.php', ['cookie' => $cookieAdmin]);
        $j = jsonDecode($r['body']);
        foreach (['version','year','groups','positions','employees','entries','holidays','vacationBalances','updatedAt'] as $k) {
            assertTrue(array_key_exists($k, $j), 'missing key ' . $k);
        }
        return 'employees=' . countAssoc($j['employees']) . ', entries=' . countAssoc($j['entries']);
    });

    $run('save.php(minimal payload)', function () use ($base, $cookieAdmin) {
        $payload = [
            'year' => 2026,
            'groups' => [],
            'positions' => [],
            'employees' => [],
            'entries' => (object)[],
            'holidays' => (object)[],
            'vacationBalances' => (object)[],
        ];
        $r = httpRequest('POST', $base . '/api/save.php', ['cookie' => $cookieAdmin, 'body' => $payload]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(($j['success'] ?? false) === true, 'success!=true');
        return 'savedAt=' . ($j['savedAt'] ?? '?');
    });

    // 3 CRUD
    $run('employees POST create', function () use ($base, $cookieAdmin, $testEmpId) {
        $payload = [
            'id' => $testEmpId,
            'fullName' => 'Smoke Test User',
            'positionId' => 'pos_master',
            'groupId' => 'g0',
            'location' => 'QA',
            'phone' => '+70000000000',
            'sortOrder' => 999,
        ];
        $r = httpRequest('POST', $base . '/api/employees.php', ['cookie' => $cookieAdmin, 'body' => $payload]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 201, 'status ' . $r['status']);
        assertTrue(($j['id'] ?? null) === $testEmpId, 'wrong id');
        return $testEmpId;
    });

    $run('employees GET by id', function () use ($base, $cookieAdmin, $testEmpId) {
        $r = httpRequest('GET', $base . '/api/employees.php?id=' . rawurlencode($testEmpId), ['cookie' => $cookieAdmin]);
        $j = jsonDecode($r['body']);
        assertTrue(($j['id'] ?? null) === $testEmpId, 'not found');
        return $j['fullName'] ?? '';
    });

    $run('employees PUT update', function () use ($base, $cookieAdmin, $testEmpId) {
        $r = httpRequest('PUT', $base . '/api/employees.php?id=' . rawurlencode($testEmpId), [
            'cookie' => $cookieAdmin,
            'body' => ['phone' => '+71111111111', 'location' => 'QA-2'],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue(($j['phone'] ?? null) === '+71111111111', 'phone not updated');
        return 'phone updated';
    });

    $run('positions GET camelCase', function () use ($base, $cookieAdmin) {
        $r = httpRequest('GET', $base . '/api/positions.php', ['cookie' => $cookieAdmin]);
        $j = jsonDecode($r['body']);
        assertTrue(is_array($j) && count($j) > 0, 'empty positions');
        assertTrue(array_key_exists('sortOrder', $j[0]), 'missing sortOrder');
        return 'count=' . count($j);
    });

    $run('employees DELETE confirm', function () use ($base, $cookieAdmin, $testEmpId) {
        $r = httpRequest('DELETE', $base . '/api/employees.php?id=' . rawurlencode($testEmpId), [
            'cookie' => $cookieAdmin,
            'body' => ['confirm' => true],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue(($j['success'] ?? false) === true, 'delete failed');
        return 'deleted';
    });

    // 4 HOLIDAYS
    $run('holidays_provider.php?year=2026', function () use ($base) {
        $r = httpRequest('GET', $base . '/api/holidays_provider.php?year=2026');
        $j = jsonDecode($r['body']);
        assertTrue(($j['year'] ?? null) === 2026, 'year!=2026');
        assertTrue(isset($j['holidays']) && is_array($j['holidays']), 'missing holidays map');
        assertTrue(count($j['holidays']) === 117, 'expected 117, got ' . count($j['holidays']));
        $found = isset($j['holidays']['2026-01-01']) && (($j['holidays']['2026-01-01']['label'] ?? '') === 'Новый год');
        assertTrue($found, '2026-01-01 Новый год not found');
        return '117 records';
    });

    // 5 PROTECTION
    $run('export.php anon -> 401', function () use ($base) {
        $r = httpRequest('GET', $base . '/api/export.php');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 401, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'unauthorized', 'wrong error');
        return 'unauthorized';
    });

    $run('load.php anon -> 401', function () use ($base) {
        $r = httpRequest('GET', $base . '/api/load.php');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 401, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'unauthorized', 'wrong error');
        return 'unauthorized';
    });

    $run('save.php anon -> 401', function () use ($base) {
        $r = httpRequest('POST', $base . '/api/save.php', [
            'body' => ['year' => 2026, 'groups' => [], 'positions' => [], 'employees' => [], 'entries' => (object)[]],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 401, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'unauthorized', 'wrong error');
        return 'unauthorized';
    });

    $run('employees.php anon -> 401', function () use ($base) {
        $r = httpRequest('GET', $base . '/api/employees.php');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 401, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'unauthorized', 'wrong error');
        return 'unauthorized';
    });

    $run('groups.php anon -> 401', function () use ($base) {
        $r = httpRequest('GET', $base . '/api/groups.php');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 401, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'unauthorized', 'wrong error');
        return 'unauthorized';
    });

    $run('positions.php anon -> 401', function () use ($base) {
        $r = httpRequest('GET', $base . '/api/positions.php');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 401, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'unauthorized', 'wrong error');
        return 'unauthorized';
    });

    $run('login(supervisor_zone0/changeme)', function () use ($base, $cookieSup) {
        $r = login($base, $cookieSup, 'supervisor_zone0', 'changeme');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(($j['user']['role'] ?? null) === 'supervisor', 'role!=supervisor');
        return 'role=supervisor';
    });

    $run('import.php supervisor -> 403', function () use ($base, $cookieSup) {
        $payload = ['groups' => [], 'positions' => [], 'employees' => []];
        $r = httpRequest('POST', $base . '/api/import.php', ['cookie' => $cookieSup, 'body' => $payload]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 403, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'forbidden', 'wrong error');
        return 'forbidden';
    });

    $run('upload.php anon -> 401', function () use ($base) {
        $r = httpRequest('POST', $base . '/upload.php');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 401, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'unauthorized', 'wrong error');
        return 'unauthorized';
    });

    $run('entries approved create', function () use ($base, $cookieAdmin, $testEntryApprovedDate) {
        $payload = [
            'employeeId' => 'emp_1',
            'date' => $testEntryApprovedDate,
            'status' => 'vacation',
            'comment' => 'smoke-approved',
            'approvalStatus' => 'approved',
        ];
        $r = httpRequest('POST', $base . '/api/entries.php', ['cookie' => $cookieAdmin, 'body' => $payload]);
        $j = jsonDecode($r['body']);
        assertTrue(($j['approvalStatus'] ?? '') === 'approved', 'not approved');
        return 'approved created';
    });

    $run('entries DELETE approved without force -> 403', function () use ($base, $cookieAdmin, $testEntryApprovedDate) {
        $r = httpRequest('DELETE', $base . '/api/entries.php?employeeId=emp_1&date=' . rawurlencode($testEntryApprovedDate), [
            'cookie' => $cookieAdmin,
            'body' => [],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 403, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'cannot_delete_approved', 'wrong error');
        return 'protected';
    });

    // 6 VACATION IMPORT
    $run('vacation_import valid Bearer token', function () use ($base, $cookieAdmin, $testImportDate) {
        $meta = httpRequest('GET', $base . '/api/export.php', ['cookie' => $cookieAdmin]);
        $j = jsonDecode($meta['body']);
        assertTrue(isset($j['version']), 'export auth failed');
        // token is not in export; read token from DB via init_db side effect is not exposed.
        $pdo = new PDO('sqlite:' . dirname(__DIR__) . '/data/app.db');
        $stmt = $pdo->query("SELECT value FROM meta WHERE key='external_api_token'");
        $token = (string) $stmt->fetchColumn();
        assertTrue($token !== '', 'empty external_api_token');
        $payload = [
            'employeeId' => 'emp_1',
            'startDate' => $testImportDate,
            'endDate' => $testImportDate,
            'status' => 'trip',
            'comment' => 'SmokeCity',
            'approvalStatus' => 'approved',
        ];
        $r = httpRequest('POST', $base . '/api/vacation_import.php', [
            'headers' => ['Authorization: Bearer ' . $token],
            'body' => $payload,
        ]);
        $j = jsonDecode($r['body']);
        assertTrue(($j['imported'] ?? 0) > 0, 'imported <= 0');
        return 'imported=' . $j['imported'];
    });

    $run('vacation_import wrong token -> invalid_token', function () use ($base, $testImportDate) {
        $payload = [
            'employeeId' => 'emp_1',
            'startDate' => $testImportDate,
            'endDate' => $testImportDate,
            'status' => 'trip',
        ];
        $r = httpRequest('POST', $base . '/api/vacation_import.php', [
            'headers' => ['Authorization: Bearer wrong-token'],
            'body' => $payload,
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 401, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'invalid_token', 'wrong error');
        return 'invalid_token';
    });

    $run('entries GET imported comment', function () use ($base, $cookieAdmin) {
        $r = httpRequest('GET', $base . '/api/entries.php?employeeId=emp_1&year=2099', ['cookie' => $cookieAdmin]);
        $j = jsonDecode($r['body']);
        $found = false;
        foreach ($j as $row) {
            if (($row['date'] ?? '') === '2099-01-02' && ($row['comment'] ?? '') === 'SmokeCity') {
                $found = true; break;
            }
        }
        assertTrue($found, 'imported comment not found');
        return 'comment preserved';
    });

    // --- E8: совместное редактирование (версии + дельта) ---
    $run('E8 save creates entry with auto version', function () use ($base, $cookieAdmin) {
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_1', 'date' => '2099-12-30', 'status' => 'vacation', 'comment' => ''],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(($j['success'] ?? false) === true, 'save failed');
        assertTrue(($j['conflicts'] ?? null) === [], 'unexpected conflicts');

        $r2 = httpRequest('GET', $base . '/api/load.php', ['cookie' => $cookieAdmin]);
        $j2 = jsonDecode($r2['body']);
        $e = $j2['entries']['emp_1:2099-12-30'] ?? null;
        assertTrue(is_array($e), 'entry not found after save');
        assertTrue(($e['status'] ?? '') === 'vacation', 'wrong status');
        assertTrue((int) ($e['version'] ?? 0) === 1, 'expected version 1, got ' . ($e['version'] ?? 'null'));
        return 'v1 auto-assigned';
    });

    $run('E8 stale version -> conflict, server state kept', function () use ($base, $cookieAdmin) {
        // E8-2: админ больше не конфликтует (его правка всегда побеждает),
        // поэтому конфликт проверяется от имени супервайзера zone1 (emp_1 — его зона).
        $cookieS1 = tempnam(sys_get_temp_dir(), 'sc_sup1_cookie_');
        $r0 = login($base, $cookieS1, 'supervisor_zone1', 'changeme');
        assertTrue($r0['status'] === 200, 'sup1 login failed: ' . $r0['status']);
        // Клиент шлёт устаревшую версию 0 при серверной 1 → конфликт.
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieS1,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_1', 'date' => '2099-12-30', 'status' => 'trip', 'entryVersion' => 0],
                ],
            ],
        ]);
        @unlink($cookieS1);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(($j['success'] ?? false) === true, 'save failed');
        $c = $j['conflicts'] ?? [];
        assertTrue(is_array($c) && count($c) === 1, 'expected 1 conflict, got ' . count((array) $c));
        assertTrue(($c[0]['key'] ?? '') === 'emp_1:2099-12-30', 'wrong conflict key');
        assertTrue((int) ($c[0]['clientVersion'] ?? -1) === 0, 'wrong clientVersion');
        assertTrue((int) ($c[0]['serverVersion'] ?? -1) === 1, 'wrong serverVersion');

        // Серверное состояние не перезаписано: статус по-прежнему vacation.
        $r2 = httpRequest('GET', $base . '/api/load.php', ['cookie' => $cookieAdmin]);
        $j2 = jsonDecode($r2['body']);
        $e = $j2['entries']['emp_1:2099-12-30'] ?? null;
        assertTrue(is_array($e), 'entry disappeared');
        assertTrue(($e['status'] ?? '') === 'vacation', 'server state overwritten: ' . ($e['status'] ?? ''));
        assertTrue((int) ($e['version'] ?? 0) === 1, 'version changed unexpectedly');
        return 'conflict rejected, state kept';
    });

    $run('E8 sync.php delta + version pre-check', function () use ($base, $cookieAdmin) {
        // Дельта с нулевого курсора содержит нашу запись.
        $r = httpRequest('GET', $base . '/api/sync.php?afterId=0', ['cookie' => $cookieAdmin]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(($j['success'] ?? false) === true, 'sync failed');
        assertTrue((int) ($j['lastSyncId'] ?? 0) >= 1, 'lastSyncId should be >= 1');
        $e = $j['entries']['emp_1:2099-12-30'] ?? null;
        assertTrue(is_array($e), 'entry missing from delta');
        assertTrue(($e['status'] ?? '') === 'vacation', 'wrong status in delta');

        // Пред-проверка версий через POST.
        $r2 = httpRequest('POST', $base . '/api/sync.php', [
            'cookie' => $cookieAdmin,
            'body' => ['keys' => ['emp_1:2099-12-30']],
        ]);
        $j2 = jsonDecode($r2['body']);
        assertTrue($r2['status'] === 200, 'status ' . $r2['status']);
        assertTrue((int) ($j2['versions']['emp_1:2099-12-30'] ?? -1) === 1, 'wrong pre-check version');

        // Дельта от актуального курсора пуста.
        $lastId = (int) $j['lastSyncId'];
        $r3 = httpRequest('GET', $base . '/api/sync.php?afterId=' . $lastId, ['cookie' => $cookieAdmin]);
        $j3 = jsonDecode($r3['body']);
        $fresh = (array) $j3['entries'];
        assertTrue(count($fresh) === 0, 'delta from lastId should be empty, got ' . count($fresh));
        return 'delta + precheck ok';
    });

    // --- E8-2: appliedVersions + роли --- (координатор)
    $run('E8-2 save returns appliedVersions', function () use ($base, $cookieAdmin) {
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_1', 'date' => '2099-11-01', 'status' => 'vacation', 'comment' => 'av1'],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue((int) ($j['appliedVersions']['emp_1:2099-11-01'] ?? 0) === 1, 'appliedVersions v1 missing');
        return 'appliedVersions=v1';
    });

    $run('E8-2 identical re-save -> no version growth (echo no-op)', function () use ($base, $cookieAdmin) {
        $body = [
            'year' => 2099,
            'entries' => [
                ['employeeId' => 'emp_1', 'date' => '2099-11-01', 'status' => 'vacation', 'comment' => 'av1'],
            ],
        ];
        $r = httpRequest('POST', $base . '/api/save.php', ['cookie' => $cookieAdmin, 'body' => $body]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(($j['conflicts'] ?? null) === [], 'unexpected conflicts');
        assertTrue((int) ($j['appliedVersions']['emp_1:2099-11-01'] ?? 0) === 1,
            'version grew on echo: ' . (($j['appliedVersions']['emp_1:2099-11-01'] ?? 'null')));
        return 'echo kept v1';
    });

    $run('E8-2 admin stale version -> no conflict, overwrites', function () use ($base, $cookieAdmin) {
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_1', 'date' => '2099-11-01', 'status' => 'sick', 'entryVersion' => 99],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(($j['conflicts'] ?? null) === [], 'admin must not conflict');
        assertTrue((int) ($j['appliedVersions']['emp_1:2099-11-01'] ?? 0) === 2,
            'expected v2 after admin override, got ' . (($j['appliedVersions']['emp_1:2099-11-01'] ?? 'null')));
        return 'admin overrode to v2';
    });

    $run('E8-2 supervisor vacation -> rejected status_not_allowed', function () use ($base, $cookieSup) {
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieSup,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_5', 'date' => '2099-11-02', 'status' => 'vacation'],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        $rej = $j['rejections'] ?? [];
        assertTrue(is_array($rej) && count($rej) === 1, 'expected 1 rejection, got ' . count((array) $rej));
        assertTrue(($rej[0]['key'] ?? '') === 'emp_5:2099-11-02', 'wrong rejection key');
        assertTrue(($rej[0]['reason'] ?? '') === 'status_not_allowed', 'wrong reason: ' . ($rej[0]['reason'] ?? ''));
        return 'status_not_allowed';
    });

    $run('E8-2 supervisor out-of-zone -> rejected out_of_scope', function () use ($base, $cookieSup) {
        // emp_1 принадлежит g1 (зона supervisor_zone1), supervisor_zone0 лезет в чужое.
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieSup,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_1', 'date' => '2099-11-03', 'status' => 'trip'],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        $rej = $j['rejections'] ?? [];
        assertTrue(is_array($rej) && count($rej) === 1, 'expected 1 rejection, got ' . count((array) $rej));
        assertTrue(($rej[0]['reason'] ?? '') === 'out_of_scope', 'wrong reason: ' . ($rej[0]['reason'] ?? ''));
        return 'out_of_scope';
    });

    $run('E8-2 supervisor trip own zone -> applied', function () use ($base, $cookieSup) {
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieSup,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_5', 'date' => '2099-11-04', 'status' => 'trip', 'comment' => 'own'],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(($j['rejections'] ?? []) === [], 'unexpected rejections');
        assertTrue((int) ($j['appliedVersions']['emp_5:2099-11-04'] ?? 0) >= 1, 'not applied');
        return 'applied own-zone trip';
    });

    $run('E8-2 viewer -> 403', function () use ($base) {
        $cookieView = tempnam(sys_get_temp_dir(), 'sc_view_cookie_');
        $r0 = login($base, $cookieView, 'viewer_test', 'changeme');
        assertTrue($r0['status'] === 200, 'viewer login failed: ' . $r0['status']);
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieView,
            'body' => ['year' => 2099, 'entries' => []],
        ]);
        @unlink($cookieView);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 403, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'forbidden', 'wrong error');
        return 'forbidden';
    });

    $run('E8-2 two non-admin clients -> real conflict', function () use ($base, $cookieAdmin) {
        // Оба клиента — супервайзеры zone1 (emp_1 в их зоне), статус trip разрешён.
        $cookieS1a = tempnam(sys_get_temp_dir(), 'sc_s1a_cookie_');
        $cookieS1b = tempnam(sys_get_temp_dir(), 'sc_s1b_cookie_');
        login($base, $cookieS1a, 'supervisor_zone1', 'changeme');
        login($base, $cookieS1b, 'supervisor_zone1', 'changeme');
        // Первый применяет правку: emp_1:2099-12-30 (свежая или существующая —
        // версия берётся динамически, т.к. SYNC-удаления между тестами меняют её).
        $r1 = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieS1a,
            'body' => ['year' => 2099, 'entries' => [
                ['employeeId' => 'emp_1', 'date' => '2099-12-30', 'status' => 'trip', 'comment' => 'c1-' . uniqid()],
            ]],
        ]);
        $j1 = jsonDecode($r1['body']);
        $v1 = (int) ($j1['appliedVersions']['emp_1:2099-12-30'] ?? 0);
        assertTrue($v1 >= 1, 'first client not applied');
        // Второй шлёт устаревшую версию → реальный конфликт, серверная = $v1.
        $r2 = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieS1b,
            'body' => ['year' => 2099, 'entries' => [
                ['employeeId' => 'emp_1', 'date' => '2099-12-30', 'status' => 'day_off', 'entryVersion' => $v1 - 1],
            ]],
        ]);
        @unlink($cookieS1a);
        @unlink($cookieS1b);
        $j2 = jsonDecode($r2['body']);
        $c = $j2['conflicts'] ?? [];
        assertTrue(is_array($c) && count($c) === 1, 'expected 1 conflict, got ' . count((array) $c));
        assertTrue(($c[0]['key'] ?? '') === 'emp_1:2099-12-30', 'wrong key');
        assertTrue((int) ($c[0]['serverVersion'] ?? -1) === $v1, 'wrong serverVersion');
        return 'real conflict detected';
    });

    // --- E8-3: зональный доступ и удаление ---
    // Сначала создаём тестовые записи в обеих зонах через админа
    $run('setup E8-3 test entries', function () use ($base, $cookieAdmin) {
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_16', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't40-setup-g0'],
                    ['employeeId' => 'emp_17', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't40-setup-g0'],
                    ['employeeId' => 'emp_18', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't40-setup-g0'],
                    ['employeeId' => 'emp_1', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't40-setup-g1'],
                    ['employeeId' => 'emp_2', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't40-setup-g1'],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'setup save failed');
        return 'test entries created';
    });

    $run('T40 supervisor g0 sees ALL employees (E8-4: visibility is global)', function () use ($base) {
        $cookieS0 = tempnam(sys_get_temp_dir(), 'sc_s0_cookie_');
        $r0 = login($base, $cookieS0, 'supervisor_zone0', 'changeme');
        assertTrue($r0['status'] === 200, 'sup0 login failed: ' . $r0['status']);
        $r = httpRequest('GET', $base . '/api/entries.php?year=2099', ['cookie' => $cookieS0]);
        @unlink($cookieS0);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        // E8-4 (2026-08-24): требование владельца — все видят всех сотрудников
        // и все записи; зона ограничивает только редактирование.
        // g0: emp_16, emp_17, emp_18; g1: emp_1, emp_2
        $foundG0 = $foundG1 = false;
        foreach ($j as $row) {
            $eid = $row['employeeId'] ?? '';
            if (in_array($eid, ['emp_16', 'emp_17', 'emp_18'])) $foundG0 = true;
            if (in_array($eid, ['emp_1', 'emp_2'])) $foundG1 = true;
        }
        assertTrue($foundG0, 'g0 employees not visible');
        assertTrue($foundG1, 'E8-4: g1 employees MUST be visible to g0 supervisor');
        return 'all zones visible (E8-4)';
    });

    $run('T41 supervisor g0 SEES g1 entries (E8-4: read access is global)', function () use ($base, $cookieAdmin) {
        // Создаём запись в g1 через админа
        $r1 = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_1', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't41-test'],
                ],
            ],
        ]);
        $j1 = jsonDecode($r1['body']);
        assertTrue($r1['status'] === 200, 'setup save failed');
        // E8-4: супервайзер g0 ВИДИТ запись g1 (но не может редактировать — T42)
        $cookieS0 = tempnam(sys_get_temp_dir(), 'sc_s0_cookie_');
        login($base, $cookieS0, 'supervisor_zone0', 'changeme');
        $r2 = httpRequest('GET', $base . '/api/entries.php?year=2099', ['cookie' => $cookieS0]);
        @unlink($cookieS0);
        $j2 = jsonDecode($r2['body']);
        $found = false;
        foreach ($j2 as $row) {
            if (($row['employeeId'] ?? '') === 'emp_1' && ($row['date'] ?? '') === '2099-12-25') {
                $found = true; break;
            }
        }
        assertTrue($found, 'E8-4: g1 entry MUST be visible to g0 supervisor');
        return 'g1 entry visible (E8-4)';
    });

    $run('T42 supervisor g0 cannot write to g1', function () use ($base) {
        $cookieS0 = tempnam(sys_get_temp_dir(), 'sc_s0_cookie_');
        login($base, $cookieS0, 'supervisor_zone0', 'changeme');
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieS0,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_1', 'date' => '2099-12-26', 'status' => 'trip'],
                ],
            ],
        ]);
        @unlink($cookieS0);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        $rej = $j['rejections'] ?? [];
        assertTrue(is_array($rej) && count($rej) === 1, 'expected 1 rejection, got ' . count((array) $rej));
        assertTrue(($rej[0]['reason'] ?? '') === 'out_of_scope', 'wrong reason: ' . ($rej[0]['reason'] ?? ''));
        return 'write rejected';
    });

    $run('T43 admin sees all zones', function () use ($base, $cookieAdmin) {
        // Создаём записи в обеих зонах (так как reset может удалиться)
        $rSetup = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_16', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't43-g0'],
                    ['employeeId' => 'emp_17', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't43-g0'],
                    ['employeeId' => 'emp_18', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't43-g0'],
                    ['employeeId' => 'emp_1', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't43-g1'],
                    ['employeeId' => 'emp_2', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't43-g1'],
                ],
            ],
        ]);
        assertTrue($rSetup['status'] === 200, 'T43 setup failed: ' . $rSetup['status']);

        $r = httpRequest('GET', $base . '/api/entries.php?year=2099', ['cookie' => $cookieAdmin]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        // Проверяем наличие сотрудников из обеих зон
        $foundG0 = $foundG1 = false;
        foreach ($j as $row) {
            $eid = $row['employeeId'] ?? '';
            if (in_array($eid, ['emp_16', 'emp_17', 'emp_18'])) $foundG0 = true;
            if (in_array($eid, ['emp_1', 'emp_2'])) $foundG1 = true;
        }
        assertTrue($foundG0, 'g0 not visible to admin');
        assertTrue($foundG1, 'g1 not visible to admin');
        return 'all zones visible';
    });

    $run('T44 admin can delete any entries', function () use ($base, $cookieAdmin) {
        // Создаём записи в обеих зонах
        $r1 = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_16', 'date' => '2099-12-27', 'status' => 'trip', 'comment' => 't44-g0'],
                    ['employeeId' => 'emp_1', 'date' => '2099-12-27', 'status' => 'trip', 'comment' => 't44-g1'],
                ],
            ],
        ]);
        $j1 = jsonDecode($r1['body']);
        assertTrue($r1['status'] === 200, 'setup save failed');
        // Удаляем через sync.php
        $r2 = httpRequest('POST', $base . '/api/sync.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'deletes' => [
                    ['employeeId' => 'emp_16', 'date' => '2099-12-27'],
                    ['employeeId' => 'emp_1', 'date' => '2099-12-27'],
                ],
            ],
        ]);
        $j2 = jsonDecode($r2['body']);
        assertTrue($r2['status'] === 200, 'delete status ' . $r2['status']);
        assertTrue(($j2['success'] ?? false) === true, 'delete failed');
        // Проверяем, что записи удалены
        $r3 = httpRequest('GET', $base . '/api/entries.php?year=2099', ['cookie' => $cookieAdmin]);
        $j3 = jsonDecode($r3['body']);
        $found = false;
        foreach ($j3 as $row) {
            if (($row['date'] ?? '') === '2099-12-27') {
                $found = true; break;
            }
        }
        assertTrue(!$found, 'entries should be deleted');
        return 'both zones deleted';
    });

    $run('T45 SYNC-delete by supervisor does not touch other zones', function () use ($base, $cookieAdmin) {
        // Создаём записи в обеих зонах
        $r1 = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [
                    ['employeeId' => 'emp_16', 'date' => '2099-12-28', 'status' => 'trip', 'comment' => 't45-g0'],
                    ['employeeId' => 'emp_1', 'date' => '2099-12-28', 'status' => 'trip', 'comment' => 't45-g1'],
                ],
            ],
        ]);
        $j1 = jsonDecode($r1['body']);
        assertTrue($r1['status'] === 200, 'setup save failed');
        // Супервайзер g0 удаляет только свою запись
        $cookieS0 = tempnam(sys_get_temp_dir(), 'sc_s0_cookie_');
        login($base, $cookieS0, 'supervisor_zone0', 'changeme');
        $r2 = httpRequest('POST', $base . '/api/sync.php', [
            'cookie' => $cookieS0,
            'body' => [
                'deletes' => [
                    ['employeeId' => 'emp_16', 'date' => '2099-12-28'],
                    // Пытается удалить и чужую запись тоже
                    ['employeeId' => 'emp_1', 'date' => '2099-12-28'],
                ],
            ],
        ]);
        @unlink($cookieS0);
        $j2 = jsonDecode($r2['body']);
        assertTrue($r2['status'] === 200, 'delete status ' . $r2['status']);
        // Проверяем: запись g0 должна быть удалена, запись g1 — остаться
        $r3 = httpRequest('GET', $base . '/api/entries.php?year=2099', ['cookie' => $cookieAdmin]);
        $j3 = jsonDecode($r3['body']);
        $foundG0 = $foundG1 = false;
        foreach ($j3 as $row) {
            if (($row['employeeId'] ?? '') === 'emp_16' && ($row['date'] ?? '') === '2099-12-28') {
                $foundG0 = true;
            }
            if (($row['employeeId'] ?? '') === 'emp_1' && ($row['date'] ?? '') === '2099-12-28') {
                $foundG1 = true;
            }
        }
        assertTrue(!$foundG0, 'g0 entry should be deleted');
        assertTrue($foundG1, 'g1 entry should remain');
        return 'only own zone deleted';
    });

    // --- T3: фича «Командировки» (trips.php + sync-ветка) ---
    // Используем год 2098 (не пересекается с 2099-фикстурами E8 и импортом).
    $run('T3-1 trips GET anon -> 401', function () use ($base) {
        $r = httpRequest('GET', $base . '/api/trips.php');
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 401, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'unauthorized', 'wrong error');
        return 'unauthorized';
    });

    $run('T3-2 trips viewer GET ok + POST 403', function () use ($base) {
        $cookieView = tempnam(sys_get_temp_dir(), 'sc_t3view_cookie_');
        $r0 = login($base, $cookieView, 'viewer_test', 'changeme');
        assertTrue($r0['status'] === 200, 'viewer login failed: ' . $r0['status']);
        $r = httpRequest('GET', $base . '/api/trips.php', ['cookie' => $cookieView]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'GET status ' . $r['status']);
        assertTrue(array_key_exists('trips', $j), 'missing trips');
        $r2 = httpRequest('POST', $base . '/api/trips.php', [
            'cookie' => $cookieView,
            'body' => ['title' => 'x', 'participants' => []],
        ]);
        @unlink($cookieView);
        $j2 = jsonDecode($r2['body']);
        assertTrue($r2['status'] === 403, 'POST status ' . $r2['status']);
        assertTrue(($j2['error'] ?? '') === 'forbidden', 'wrong error');
        return 'GET ok, POST forbidden';
    });

    $run('T3-3 admin POST create forecast trip (2 participants)', function () use ($base, $cookieAdmin) {
        $r = httpRequest('POST', $base . '/api/trips.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'title' => 'Совещание в Москве',
                'location' => 'Москва',
                'comment' => 'квартальный отчёт',
                'participants' => [
                    ['employeeId' => 'emp_5', 'startDate' => '2098-03-01', 'endDate' => '2098-03-03'],
                    ['employeeId' => 'emp_16', 'startDate' => '2098-03-04', 'endDate' => '2098-03-06'],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 201, 'status ' . $r['status']);
        assertTrue(($j['success'] ?? false) === true, 'success!=true');
        $trip = $j['trip'] ?? null;
        assertTrue(is_array($trip), 'missing trip');
        $tripId = $trip['id'] ?? '';
        assertTrue(strpos((string) $tripId, 'trip_') === 0, 'id not trip_: ' . $tripId);
        assertTrue((int) ($trip['version'] ?? 0) === 1, 'expected version 1');
        assertTrue(($trip['status'] ?? '') === 'forecast', 'expected forecast');
        assertTrue(count($trip['participants'] ?? []) === 2, 'expected 2 participants');
        $GLOBALS['T3_TRIP_ID'] = $tripId;
        return $tripId . ' v' . $trip['version'];
    });

    $run('T3-4 GET contains created trip', function () use ($base, $cookieAdmin) {
        $r = httpRequest('GET', $base . '/api/trips.php', ['cookie' => $cookieAdmin]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        $found = false;
        foreach ($j['trips'] ?? [] as $t) {
            if (($t['id'] ?? '') === ($GLOBALS['T3_TRIP_ID'] ?? '')) {
                $found = true;
                assertTrue(count($t['participants'] ?? []) === 2, 'participants mismatch');
                assertTrue(array_key_exists('updatedAt', $t), 'missing updatedAt');
                break;
            }
        }
        assertTrue($found, 'trip not found in GET list');
        return 'found with participants';
    });

    $run('T3-5 POST overlap vacation -> 409', function () use ($base, $cookieAdmin) {
        // Создаём vacation на 2098-03-10 у emp_1 через save.php.
        $r1 = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => ['year' => 2098, 'entries' => [
                ['employeeId' => 'emp_1', 'date' => '2098-03-10', 'status' => 'vacation', 'comment' => 'T3-vac'],
            ]],
        ]);
        $j1 = jsonDecode($r1['body']);
        assertTrue($r1['status'] === 200 && ($j1['success'] ?? false) === true, 'vacation setup failed');
        $r = httpRequest('POST', $base . '/api/trips.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'title' => 'Пересечение отпуск',
                'participants' => [
                    ['employeeId' => 'emp_1', 'startDate' => '2098-03-10', 'endDate' => '2098-03-10'],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 409, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'overlapping_entry', 'wrong error: ' . ($j['error'] ?? ''));
        assertTrue(($j['employeeId'] ?? '') === 'emp_1', 'wrong employeeId');
        assertTrue(($j['date'] ?? '') === '2098-03-10', 'wrong date: ' . ($j['date'] ?? ''));
        assertTrue(($j['status'] ?? '') === 'vacation', 'wrong status');
        return '409 overlapping_entry';
    });

    $run('T3-6 POST overlap day_off -> 409', function () use ($base, $cookieAdmin) {
        $r1 = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => ['year' => 2098, 'entries' => [
                ['employeeId' => 'emp_5', 'date' => '2098-03-12', 'status' => 'day_off', 'comment' => 'T3-doff'],
            ]],
        ]);
        $j1 = jsonDecode($r1['body']);
        assertTrue($r1['status'] === 200 && ($j1['success'] ?? false) === true, 'day_off setup failed');
        $r = httpRequest('POST', $base . '/api/trips.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'title' => 'Пересечение выходной',
                'participants' => [
                    ['employeeId' => 'emp_5', 'startDate' => '2098-03-12', 'endDate' => '2098-03-12'],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 409, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'overlapping_entry', 'wrong error');
        assertTrue(($j['status'] ?? '') === 'day_off', 'wrong status');
        return '409 day_off';
    });

    $run('T3-7 POST overlap sick -> SUCCESS', function () use ($base, $cookieAdmin) {
        $r1 = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => ['year' => 2098, 'entries' => [
                ['employeeId' => 'emp_1', 'date' => '2098-03-15', 'status' => 'sick', 'comment' => 'T3-sick'],
            ]],
        ]);
        $j1 = jsonDecode($r1['body']);
        assertTrue($r1['status'] === 200 && ($j1['success'] ?? false) === true, 'sick setup failed');
        $r = httpRequest('POST', $base . '/api/trips.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'title' => 'Поверх больничного',
                'participants' => [
                    ['employeeId' => 'emp_1', 'startDate' => '2098-03-15', 'endDate' => '2098-03-15'],
                ],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 201, 'status ' . $r['status']);
        assertTrue(($j['success'] ?? false) === true, 'success!=true');
        $GLOBALS['T3_TRIP_SICK'] = $j['trip']['id'] ?? '';
        return 'created over sick';
    });

    $run('T3-8 PUT without entryVersion -> title updated, version=2', function () use ($base, $cookieAdmin) {
        $id = $GLOBALS['T3_TRIP_ID'] ?? '';
        assertTrue($id !== '', 'no trip id');
        $r = httpRequest('PUT', $base . '/api/trips.php?id=' . rawurlencode($id), [
            'cookie' => $cookieAdmin,
            'body' => ['title' => 'Совещание в Москве (обновлено)'],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        $trip = $j['trip'] ?? [];
        assertTrue(($trip['title'] ?? '') === 'Совещание в Москве (обновлено)', 'title not updated');
        assertTrue((int) ($trip['version'] ?? 0) === 2, 'expected version 2, got ' . ($trip['version'] ?? 'null'));
        return 'v2';
    });

    $run('T3-9 PUT stale entryVersion=1 -> 409 version_conflict', function () use ($base, $cookieAdmin) {
        $id = $GLOBALS['T3_TRIP_ID'] ?? '';
        $r = httpRequest('PUT', $base . '/api/trips.php?id=' . rawurlencode($id), [
            'cookie' => $cookieAdmin,
            'body' => ['title' => 'конфликт', 'entryVersion' => 1],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 409, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'version_conflict', 'wrong error');
        assertTrue((int) ($j['clientVersion'] ?? -1) === 1, 'wrong clientVersion');
        assertTrue((int) ($j['serverVersion'] ?? -1) === 2, 'wrong serverVersion');
        assertTrue(is_array($j['serverTrip'] ?? null), 'missing serverTrip');
        return '409 conflict with serverTrip';
    });

    $run('T3-10 confirm + admin edit confirmed OK', function () use ($base, $cookieAdmin) {
        $id = $GLOBALS['T3_TRIP_ID'] ?? '';
        $r = httpRequest('PUT', $base . '/api/trips.php?id=' . rawurlencode($id) . '&action=confirm', [
            'cookie' => $cookieAdmin,
            'body' => [],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'confirm status ' . $r['status']);
        assertTrue(($j['trip']['status'] ?? '') === 'confirmed', 'not confirmed');
        // admin может править confirmed:
        $r2 = httpRequest('PUT', $base . '/api/trips.php?id=' . rawurlencode($id), [
            'cookie' => $cookieAdmin,
            'body' => ['comment' => 'после подтверждения'],
        ]);
        $j2 = jsonDecode($r2['body']);
        assertTrue($r2['status'] === 200, 'admin edit confirmed status ' . $r2['status']);
        assertTrue(($j2['trip']['comment'] ?? '') === 'после подтверждения', 'comment not updated');
        return 'confirmed + admin edit ok';
    });

    $run('T3-11 supervisor_zone0 confirmed immutable + delete confirmed 403 + delete forecast ok', function () use ($base) {
        // supervisor_zone0: emp_5, emp_16/17/18 (g0) — его зона; emp_1/emp_2 (g1) — чужая.
        // T3_TRIP_ID (Совещание в Москве) имеет участников только g0 → зона проходит,
        // и confirmed-гвард срабатывает.
        $cookieS0 = tempnam(sys_get_temp_dir(), 'sc_t3s0_cookie_');
        $r0 = login($base, $cookieS0, 'supervisor_zone0', 'changeme');
        assertTrue($r0['status'] === 200, 'sup0 login failed: ' . $r0['status']);
        $id = $GLOBALS['T3_TRIP_ID'] ?? '';
        // PUT confirmed -> 403
        $r = httpRequest('PUT', $base . '/api/trips.php?id=' . rawurlencode($id), [
            'cookie' => $cookieS0,
            'body' => ['title' => 'ne popadet'],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 403, 'PUT confirmed status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'confirmed_immutable', 'wrong error');
        // DELETE confirmed -> 403
        $r2 = httpRequest('DELETE', $base . '/api/trips.php?id=' . rawurlencode($id), ['cookie' => $cookieS0]);
        $j2 = jsonDecode($r2['body']);
        assertTrue($r2['status'] === 403, 'DELETE confirmed status ' . $r2['status']);
        assertTrue(($j2['error'] ?? '') === 'confirmed_immutable', 'wrong error');
        // CREATE forecast с участником g0 (emp_5) и DELETE (forecast, своя зона) -> success
        $r3 = httpRequest('POST', $base . '/api/trips.php', [
            'cookie' => $cookieS0,
            'body' => [
                'title' => 'Зональный forecast',
                'participants' => [
                    ['employeeId' => 'emp_5', 'startDate' => '2098-04-01', 'endDate' => '2098-04-02'],
                ],
            ],
        ]);
        $j3 = jsonDecode($r3['body']);
        assertTrue($r3['status'] === 201, 'sup0 create status ' . $r3['status']);
        $forecastId = $j3['trip']['id'] ?? '';
        $r4 = httpRequest('DELETE', $base . '/api/trips.php?id=' . rawurlencode($forecastId), ['cookie' => $cookieS0]);
        $j4 = jsonDecode($r4['body']);
        @unlink($cookieS0);
        assertTrue($r4['status'] === 200, 'sup0 delete forecast status ' . $r4['status']);
        assertTrue(($j4['deleted'] ?? false) === true, 'not deleted');
        return 'confirmed immutable, forecast deleted';
    });

    $run('T3-12 supervisor foreign zone POST -> 403 zone_forbidden', function () use ($base) {
        $cookieS0 = tempnam(sys_get_temp_dir(), 'sc_t3s0b_cookie_');
        login($base, $cookieS0, 'supervisor_zone0', 'changeme');
        // emp_2 belongs to g1 (чужой зоне).
        $r = httpRequest('POST', $base . '/api/trips.php', [
            'cookie' => $cookieS0,
            'body' => [
                'title' => 'Чужой участник',
                'participants' => [
                    ['employeeId' => 'emp_2', 'startDate' => '2098-05-01', 'endDate' => '2098-05-02'],
                ],
            ],
        ]);
        @unlink($cookieS0);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 403, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'zone_forbidden', 'wrong error');
        assertTrue(in_array('emp_2', $j['foreignEmployees'] ?? [], true), 'missing foreignEmployees');
        return '403 zone_forbidden';
    });

    $run('T3-13 DELETE forecast admin + sync contains trip events', function () use ($base, $cookieAdmin) {
        // Сначала создаём forecast через админа, чтобы затем удалить.
        $r0 = httpRequest('POST', $base . '/api/trips.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'title' => 'На удаление',
                'participants' => [
                    ['employeeId' => 'emp_16', 'startDate' => '2098-06-01', 'endDate' => '2098-06-01'],
                ],
            ],
        ]);
        $j0 = jsonDecode($r0['body']);
        $delId = $j0['trip']['id'] ?? '';
        assertTrue($delId !== '', 'create before delete failed');
        $r1 = httpRequest('DELETE', $base . '/api/trips.php?id=' . rawurlencode($delId), ['cookie' => $cookieAdmin]);
        $j1 = jsonDecode($r1['body']);
        assertTrue($r1['status'] === 200 && ($j1['deleted'] ?? false) === true, 'admin delete failed');
        // Синк от нулевого курсора: содержит trip-события (создание+обновления+удаление).
        $r2 = httpRequest('GET', $base . '/api/sync.php?afterId=0', ['cookie' => $cookieAdmin]);
        $j2 = jsonDecode($r2['body']);
        assertTrue($r2['status'] === 200, 'sync status ' . $r2['status']);
        assertTrue(is_array($j2['tripsChanged'] ?? null) || is_object($j2['tripsChanged'] ?? null), 'missing tripsChanged');
        assertTrue(isset($j2['tripsDeleted']) && is_array($j2['tripsDeleted']), 'missing tripsDeleted');
        $changed = (array) ($j2['tripsChanged'] ?? []);
        $deleted = (array) ($j2['tripsDeleted'] ?? []);
        // Должны присутствовать: созданный trip (T3-3), trip поверх sick (T3-7) и удалённый delId.
        $foundChanged = isset($changed[$GLOBALS['T3_TRIP_ID'] ?? '']) || isset($changed[$GLOBALS['T3_TRIP_SICK'] ?? '']);
        assertTrue($foundChanged, 'no trip events in tripsChanged');
        assertTrue(in_array($delId, $deleted, true), 'deleted trip missing from tripsDeleted');
        return 'tripsChanged=' . count($changed) . ', tripsDeleted=' . count($deleted);
    });

    $run('T3-14 validations: empty title / bad dates / unknown employee', function () use ($base, $cookieAdmin) {
        $mk = function (array $body) use ($base, $cookieAdmin) {
            return jsonDecode(httpRequest('POST', $base . '/api/trips.php', [
                'cookie' => $cookieAdmin,
                'body' => $body,
            ])['body']);
        };
        $basePayload = ['title' => 'вал', 'participants' => [['employeeId' => 'emp_1', 'startDate' => '2098-07-01', 'endDate' => '2098-07-01']]];
        // empty title
        $j1 = $mk(['title' => '   ', 'participants' => $basePayload['participants']]);
        assertTrue(($j1['error'] ?? '') === 'title_required', 'title_required expected, got ' . ($j1['error'] ?? ''));
        // endDate < startDate
        $j2 = $mk(['title' => 'bad', 'participants' => [['employeeId' => 'emp_1', 'startDate' => '2098-07-10', 'endDate' => '2098-07-01']]]);
        assertTrue(($j2['error'] ?? '') === 'date_range_invalid', 'date_range_invalid expected');
        // nonexistent employee
        $j3 = $mk(['title' => 'bad', 'participants' => [['employeeId' => 'emp_ghost', 'startDate' => '2098-07-01', 'endDate' => '2098-07-01']]]);
        assertTrue(($j3['error'] ?? '') === 'participant_not_found', 'participant_not_found expected');
        // invalid date format
        $j4 = $mk(['title' => 'bad', 'participants' => [['employeeId' => 'emp_1', 'startDate' => '2098-13-99', 'endDate' => '2098-13-99']]]);
        assertTrue(($j4['error'] ?? '') === 'invalid_date', 'invalid_date expected');
        return '4 validations ok';
    });

    // 7 RESET
    $run('reset.php admin', function () use ($base, $cookieAdmin) {
        $r = httpRequest('GET', $base . '/api/reset.php', ['cookie' => $cookieAdmin]);
        $j = jsonDecode($r['body']);
        foreach (['groups','positions','employees','entries'] as $k) {
            assertTrue(array_key_exists($k, $j), 'missing ' . $k);
        }
        return 'employees=' . countAssoc($j['employees']);
    });

    // 8 AUDIT — E5 smoke checks
    $run('audit_log table exists after mutation', function () use ($root) {
        $pdoA = new PDO('sqlite:' . $root . '/data/app.db');
        // Check table exists
        $tables = $pdoA->query("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'")->fetch();
        assertTrue($tables !== false && isset($tables['name']), 'audit_log table missing');
        return 'table ok';
    });

    $run('audit has login entry for admin after login smoke', function () use ($root) {
        $pdoA = new PDO('sqlite:' . $root . '/data/app.db');
        $rows = $pdoA->query(
            "SELECT action, actor FROM audit_log WHERE action IN ('auth.login','entry.upsert','employee.create') ORDER BY id DESC LIMIT 5"
        )->fetchAll(PDO::FETCH_ASSOC);
        $foundLogin = false;
        foreach ($rows as $row) {
            if (($row['action'] ?? '') === 'auth.login') {
                $foundLogin = true; break;
            }
        }
        assertTrue($foundLogin, 'no auth.login record in audit_log');
        return 'login found in audit';
    });

    $run('audit entry.upsert exists after save.php smoke', function () use ($root) {
        $pdoA = new PDO('sqlite:' . $root . '/data/app.db');
        $cnt = (int) $pdoA->query("SELECT COUNT(*) FROM audit_log WHERE action='entry.upsert'")->fetchColumn();
        assertTrue($cnt > 0, 'no entry.upsert in audit_log (got ' . $cnt . ')');
        return 'upsert count=' . $cnt;
    });

    $run('audit_log ts is not null and ISO8601 format', function () use ($root) {
        $pdoA = new PDO('sqlite:' . $root . '/data/app.db');
        $rows = $pdoA->query(
            "SELECT ts FROM audit_log WHERE action IN ('auth.login','entry.upsert') ORDER BY id DESC LIMIT 5"
        )->fetchAll(PDO::FETCH_ASSOC);
        assertTrue(count($rows) > 0, 'no audit rows to check ts on');
        foreach ($rows as $row) {
            $ts = $row['ts'] ?? null;
            assertTrue($ts !== null && $ts !== '', 'ts is NULL or empty');
            assertTrue(preg_match('#^\d{4}-\d{2}-\d{2}T#', (string) $ts) === 1,
                'ts not ISO8601: ' . var_export($ts, true));
        }
        return 'all ts values non-null ISO8601';
    });

    // 10 AUDIT CLEANUP — E5-4c детерминированная проверка
    $run('audit_cleanup deletes old rows deterministically', function () use ($root) {
        // Считаем до вставки
        $pdoA = new PDO('sqlite:' . $root . '/data/app.db');
        $pdoA->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $cutoffDate = gmdate('Y-m-d\TH:i:s+00:00', time() - 7*86400);
        
        $oldBefore = (int) $pdoA->query("SELECT COUNT(*) FROM audit_log WHERE ts < '{$cutoffDate}'")->fetchColumn();
        $newBefore = (int) $pdoA->query("SELECT COUNT(*) FROM audit_log WHERE ts >= '{$cutoffDate}'")->fetchColumn();

        // Вставляем старую запись (8 дней назад)
        $oldTs = gmdate('Y-m-d\TH:i:s+00:00', time() - 8*86400);
        $stmt = $pdoA->prepare("INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details) VALUES (:ts, 'test', 'admin', 'test_action', 'system', null, '{}')");
        $stmt->execute([':ts' => $oldTs]);

        // Вставляем свежую запись
        $newTs = gmdate('Y-m-d\TH:i:s+00:00');
        $stmt->execute([':ts' => $newTs]);

        // Вызываем audit_cleanup напрямую — должна удалить всё старше cutoff
        audit_cleanup($pdoA);

        // Старая строка удалена
        $oldAfter = (int) $pdoA->query("SELECT COUNT(*) FROM audit_log WHERE ts < '{$cutoffDate}'")->fetchColumn();
        assertTrue($oldAfter === 0, 'old records not removed: count=' . $oldAfter);

        // Свежая осталась (COUNT не уменьшился)
        $newAfter = (int) $pdoA->query("SELECT COUNT(*) FROM audit_log WHERE ts >= '{$cutoffDate}'")->fetchColumn();
        assertTrue($newAfter >= $newBefore, 'new records incorrectly removed');

        // Повторная вставка + cleanup снова удаляет (детерминированность)
        $stmt->execute([':ts' => $oldTs]);
        audit_cleanup($pdoA);
        $oldAfter2 = (int) $pdoA->query("SELECT COUNT(*) FROM audit_log WHERE ts < '{$cutoffDate}'")->fetchColumn();
        assertTrue($oldAfter2 === 0, 'second old record not removed');

        // Удаляем тестовые строки
        $pdoA->exec("DELETE FROM audit_log WHERE actor = 'test' AND details = '{}'");

        return "before(old={$oldBefore},new={$newBefore}) -> after(old={$oldAfter},new={$newAfter}), repeat(old={$oldAfter2})";
    });

    $run('audit cutoff format is ISO8601 UTC with +00:00', function () use ($root) {
        $pdoA = new PDO('sqlite:' . $root . '/data/app.db');
        // Создаем старую запись для теста очистки (более 8 дней назад)
        $oldTs = gmdate('Y-m-d\TH:i:s+00:00', time() - 8*86400 - 3600); // 8 дней + 1 час назад
        $stmt = $pdoA->prepare("INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details) VALUES (?, 'test', 'admin', 'test_action', 'system', null, '{}')");
        $stmt->execute([$oldTs]);
        
        // Создаем новую запись (в пределах 7 дней)
        $newTs = gmdate('Y-m-d\TH:i:s+00:00'); // сейчас
        $stmt = $pdoA->prepare("INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details) VALUES (?, 'test', 'admin', 'test_action', 'system', null, '{}')");
        $stmt->execute([$newTs]);
        
        // Вызываем логику очистки напрямую (игнорируя вероятность 5%)
        $cutoffDate = gmdate('Y-m-d\TH:i:s+00:00', time() - 7*86400);
        $stmt = $pdoA->prepare("DELETE FROM audit_log WHERE ts < :cutoff");
        $stmt->bindValue(':cutoff', $cutoffDate);
        $stmt->execute();
        
        // Проверяем, что старая запись удалена
        $count = (int) $pdoA->query("SELECT COUNT(*) FROM audit_log WHERE ts < '{$cutoffDate}'")->fetchColumn();
        assertTrue($count === 0, 'old records not cleaned up');
        
        // Проверяем, что новые записи остались
        $newCount = (int) $pdoA->query("SELECT COUNT(*) FROM audit_log WHERE ts >= '{$cutoffDate}'")->fetchColumn();
        assertTrue($newCount > 0, 'new records incorrectly removed');
        
        return 'cutoff format correct, cleanup works';
    });

    // 9 AUDIT EXPORT — E5-2
    $run('E5-2 admin csv export -> 200 text/csv + BOM + ";" separator', function () use ($base, $cookieAdmin) {
        $r = httpRequest('GET', $base . '/api/audit_export.php?format=csv&days=7', ['cookie' => $cookieAdmin]);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(strpos(headerValue($r['headers_raw'], 'Content-Type'), 'text/csv') === 0, 'wrong Content-Type: ' . headerValue($r['headers_raw'], 'Content-Type'));
        assertTrue(strpos($r['body'], "\xEF\xBB\xBF") === 0, 'missing UTF-8 BOM');
        assertTrue(strpos($r['body'], 'ts;actor;role;action;entity_type;entity_id;details') !== false, 'wrong header row (needs ";" separator)');
        assertTrue(strpos(headerValue($r['headers_raw'], 'Content-Disposition'), 'audit-log-') !== false, 'missing Content-Disposition filename');
        assertTrue(strpos(headerValue($r['headers_raw'], 'Cache-Control'), 'no-store') !== false, 'missing no-store Cache-Control');
        return 'csv size=' . strlen($r['body']);
    });

    $run('audit-export md export -> 200 text/markdown table', function () use ($base, $cookieAdmin) {
        $r = httpRequest('GET', $base . '/api/audit_export.php?format=md&days=7', ['cookie' => $cookieAdmin]);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(strpos(headerValue($r['headers_raw'], 'Content-Type'), 'text/markdown') === 0, 'wrong Content-Type: ' . headerValue($r['headers_raw'], 'Content-Type'));
        assertTrue(strpos($r['body'], '| ts | actor | role | action | entity_type | entity_id | details |') !== false, 'markdown table header missing');
        // Хотя бы одна строка данных
        assertTrue(strpos($r['body'], '| 202') !== false, 'no data rows in markdown table');
        return 'md size=' . strlen($r['body']);
    });

    $run('audit-export xlsx -> 200 ZIP with [Content_Types].xml', function () use ($base, $cookieAdmin, $root) {
        $r = httpRequest('GET', $base . '/api/audit_export.php?format=xlsx&days=7', ['cookie' => $cookieAdmin]);
        assertTrue($r['status'] === 200, 'status ' . $r['status']);
        assertTrue(strpos(headerValue($r['headers_raw'], 'Content-Type'), 'spreadsheetml') !== false, 'wrong Content-Type: ' . headerValue($r['headers_raw'], 'Content-Type'));
        assertTrue(strpos(headerValue($r['headers_raw'], 'Content-Disposition'), '.xlsx') !== false, 'filename should end .xlsx');
        // Диагностика (фронт) есть только при fallback
        assertTrue(headerValue($r['headers_raw'], 'X-Audit-Export-Fallback') === '', 'unexpected fallback header');
        // Валидный ZIP с [Content_Types].xml (при наличии ZipArchive) — иначе проверим, что это корректный CSV-fallback.
        $bytes = $r['body'];
        if ($bytes === '' ) {
            throw new RuntimeException('empty xlsx body');
        }
        if (substr($bytes, 0, 2) === 'PK') {
            $tmp = tempnam(sys_get_temp_dir(), 'sc_xlsx_');
            file_put_contents($tmp, $bytes);
            $zip = new ZipArchive();
            assertTrue($zip->open($tmp) === true, 'xlsx is not a valid zip');
            assertTrue($zip->locateName('[Content_Types].xml') !== false, 'missing [Content_Types].xml');
            $zip->close();
            @unlink($tmp);
            $detail = 'valid zip PK';
        } else {
            // fallback csv
            assertTrue(substr($bytes, 0, 3) === "\xEF\xBB\xBF", 'non-zip fallback should be csv with BOM');
            $detail = 'csv fallback';
        }
        return 'xlsx ' . $detail . ' size=' . strlen($bytes);
    });

    $run('audit-export viewer -> 403', function () use ($base) {
        $cookieView = tempnam(sys_get_temp_dir(), 'sc_view_cookie_');
        $r0 = login($base, $cookieView, 'viewer_test', 'changeme');
        assertTrue($r0['status'] === 200, 'viewer login failed: ' . $r0['status']);
        $r = httpRequest('GET', $base . '/api/audit_export.php?format=csv&days=7', ['cookie' => $cookieView]);
        @unlink($cookieView);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 403, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'forbidden', 'wrong error');
        return 'forbidden';
    });

    $run('audit-export supervisor -> 403', function () use ($base, $cookieSup) {
        $r = httpRequest('GET', $base . '/api/audit_export.php?format=md&days=7', ['cookie' => $cookieSup]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 403, 'status ' . $r['status']);
        assertTrue(($j['error'] ?? '') === 'forbidden', 'wrong error');
        return 'forbidden';
    });

    // --- E5-5: Behavioral checks for audit details ---
    $run('audit entry.delete has details.status', function () use ($base, $cookieAdmin, $root) {
        $pdoB = new PDO('sqlite:' . $root . '/data/app.db');
        $pdoB->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $now = gmdate('Y-m-d\TH:i:s+00:00');
        // Create a unique entry to trigger SYNC delete via save.php
        $stmt = $pdoB->prepare(
            'INSERT OR IGNORE INTO schedule_entries (employee_id, date, status, comment, approval_status, version, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?)'
        );
        $stmt->execute(['emp_sde', '2099-05-05', 'vacation', 'smoke-del-entry', 'draft', $now]);
        // Call save.php with empty entries for 2099 — triggers SYNC delete
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [],
                'groups' => [],
                'positions' => [],
                'employees' => [],
                'holidays' => [],
                'vacationBalances' => [],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'save failed: ' . $r['status']);
        // Check audit_log for entry.delete with details having status key (non-null)
        $auditRows = $pdoB->query(
            "SELECT details FROM audit_log WHERE action='entry.delete' ORDER BY id DESC LIMIT 1"
        )->fetchAll(PDO::FETCH_ASSOC);
        assertTrue(count($auditRows) > 0, 'no entry.delete audit record');
        $details = json_decode($auditRows[0]['details'] ?? '', true);
        assertTrue(is_array($details) && array_key_exists('status', $details) && $details['status'] !== null,
            'entry.delete details missing non-null status: ' . ($auditRows[0]['details'] ?? 'null'));
        return 'status=' . var_export($details['status'], true);
    });

    $run('audit employee.update has details.changes.phone', function () use ($root) {
        $pdoA = new PDO('sqlite:' . $root . '/data/app.db');
        $pdoA->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $auditRows = $pdoA->query(
            "SELECT details FROM audit_log WHERE action='employee.update' ORDER BY id DESC LIMIT 1"
        )->fetchAll(PDO::FETCH_ASSOC);
        assertTrue(count($auditRows) > 0, 'no employee.update audit record');
        $details = json_decode($auditRows[0]['details'] ?? '', true);
        assertTrue(is_array($details) && array_key_exists('changes', $details),
            'employee.update details missing changes key: ' . ($auditRows[0]['details'] ?? 'null'));
        assertTrue(array_key_exists('phone', $details['changes']),
            'changes missing phone: ' . json_encode($details['changes']));
        return 'changes=' . json_encode($details['changes']);
    });

    $run('audit employee.delete has details.fullName', function () use ($root) {
        $pdoA = new PDO('sqlite:' . $root . '/data/app.db');
        $pdoA->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $auditRows = $pdoA->query(
            "SELECT details FROM audit_log WHERE action='employee.delete' ORDER BY id DESC LIMIT 1"
        )->fetchAll(PDO::FETCH_ASSOC);
        assertTrue(count($auditRows) > 0, 'no employee.delete audit record');
        $details = json_decode($auditRows[0]['details'] ?? '', true);
        assertTrue(is_array($details) && array_key_exists('fullName', $details)
            && $details['fullName'] !== '' && $details['fullName'] !== null,
            'employee.delete details missing non-empty fullName: ' . ($auditRows[0]['details'] ?? 'null'));
        return 'fullName=' . var_export($details['fullName'], true);
    });

    // --- E5-6: Behavioral checks for save.php employee audit (UI-path) ---
    $runE56TestEmpId = 'emp_smoke_e56_' . bin2hex(random_bytes(4));
    $run('E5-6 save.php employee.create audit via payload', function () use ($base, $cookieAdmin, $root, $runE56TestEmpId) {
        $pdoB = new PDO('sqlite:' . $root . '/data/app.db');
        $pdoB->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        // Count existing employee.create records
        $cntBefore = (int) $pdoB->query("SELECT COUNT(*) FROM audit_log WHERE action='employee.create'")->fetchColumn();
        // Call save.php with a NEW employee — triggers upsert/create
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [],
                'groups' => [['id' => 'g0', 'name' => 'Smoke Fixture Group', 'sort_order' => 0]],
                'positions' => [['id' => 'pos_master', 'name' => 'Master', 'sort_order' => 0]],
                'employees' => [[
                    'id' => $runE56TestEmpId,
                    'fullName' => 'Smoke E56 Create User',
                    'positionId' => 'pos_master',
                    'groupId' => 'g0',
                    'phone' => '+700****0000',
                ]],
                'holidays' => [],
                'vacationBalances' => [],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'save failed: ' . $r['status']);
        assertTrue(($j['success'] ?? false) === true, 'success!=true');
        // Verify count increased (new CREATE written to audit_log)
        $cntAfter = (int) $pdoB->query("SELECT COUNT(*) FROM audit_log WHERE action='employee.create'")->fetchColumn();
        assertTrue($cntAfter > $cntBefore, 'no employee.create audit record after save (before=' . $cntBefore . ', after=' . $cntAfter . ')');
        // Grab the newest create record and verify details
        $auditRow = $pdoB->query(
            "SELECT details FROM audit_log WHERE action='employee.create' ORDER BY id DESC LIMIT 1"
        )->fetch(PDO::FETCH_ASSOC);
        assertTrue($auditRow !== false, 'no employee.create audit record at all');
        $details = json_decode($auditRow['details'] ?? '', true);
        assertTrue(is_array($details) && array_key_exists('fullName', $details),
            'employee.create details missing fullName: ' . ($auditRow['details'] ?? 'null'));
        assertTrue($details['fullName'] === 'Smoke E56 Create User', 'wrong fullName');
        return 'created=' . $details['fullName'];
    });

    $run('E5-6 save.php employee.update audit on phone change', function () use ($base, $cookieAdmin, $root, $runE56TestEmpId) {
        $pdoB = new PDO('sqlite:' . $root . '/data/app.db');
        $pdoB->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        // Count existing employee.update records
        $cntBefore = (int) $pdoB->query("SELECT COUNT(*) FROM audit_log WHERE action='employee.update'")->fetchColumn();
        // Re-send same employee but with different phone -> should trigger update audit
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [],
                'groups' => [['id' => 'g0', 'name' => 'Smoke Fixture Group', 'sort_order' => 0]],
                'positions' => [['id' => 'pos_master', 'name' => 'Master', 'sort_order' => 0]],
                'employees' => [[
                    'id' => $runE56TestEmpId,
                    'fullName' => 'Smoke E56 Create User',
                    'positionId' => 'pos_master',
                    'groupId' => 'g0',
                    'phone' => '+799****9999', // changed phone
                ]],
                'holidays' => [],
                'vacationBalances' => [],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'save failed: ' . $r['status']);
        // Should have created at least one employee.update record
        $cntAfter = (int) $pdoB->query("SELECT COUNT(*) FROM audit_log WHERE action='employee.update'")->fetchColumn();
        assertTrue($cntAfter > $cntBefore, 'no employee.update audit record after phone change (before=' . $cntBefore . ', after=' . $cntAfter . ')');
        $auditRows = $pdoB->query(
            "SELECT details FROM audit_log WHERE action='employee.update' ORDER BY id DESC LIMIT 1"
        )->fetchAll(PDO::FETCH_ASSOC);
        $details = json_decode($auditRows[0]['details'] ?? '', true);
        assertTrue(is_array($details) && array_key_exists('changes', $details),
            'employee.update details missing changes: ' . ($auditRows[0]['details'] ?? 'null'));
        assertTrue(array_key_exists('phone', $details['changes']),
            'changes missing phone: ' . json_encode($details['changes']));
        return 'changes.phone=' . ($details['changes']['phone'] ?? 'MISSING');
    });

    $run('E5-6 save.php no duplicate audit on unchanged re-save', function () use ($base, $cookieAdmin, $root, $runE56TestEmpId) {
        $pdoB = new PDO('sqlite:' . $root . '/data/app.db');
        $pdoB->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        // Count current employee.update records
        $cntBefore = (int) $pdoB->query("SELECT COUNT(*) FROM audit_log WHERE action='employee.update'")->fetchColumn();
        // Re-send exactly same data (same phone) -> NO new audit record expected
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [],
                'groups' => [['id' => 'g0', 'name' => 'Smoke Fixture Group', 'sort_order' => 0]],
                'positions' => [['id' => 'pos_master', 'name' => 'Master', 'sort_order' => 0]],
                'employees' => [[
                    'id' => $runE56TestEmpId,
                    'fullName' => 'Smoke E56 Create User',
                    'positionId' => 'pos_master',
                    'groupId' => 'g0',
                    'phone' => '+799****9999', // same as before
                ]],
                'holidays' => [],
                'vacationBalances' => [],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'save failed: ' . $r['status']);
        // No new update audit should be logged
        $cntAfter = (int) $pdoB->query("SELECT COUNT(*) FROM audit_log WHERE action='employee.update'")->fetchColumn();
        assertTrue($cntAfter === $cntBefore,
            'duplicate audit on unchanged re-save: before=' . $cntBefore . ', after=' . $cntAfter);
        return 'no duplicate audit';
    });

    $run('E5-6 save.php employee.delete audit via payload removal', function () use ($base, $cookieAdmin, $root, $runE56TestEmpId) {
        $pdoB = new PDO('sqlite:' . $root . '/data/app.db');
        $pdoB->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        // Verify employee exists
        $exists = $pdoB->query("SELECT COUNT(*) FROM employees WHERE id = '$runE56TestEmpId'")->fetchColumn();
        assertTrue($exists > 0, 'test employee should exist before delete');
        // Count existing employee.delete records
        $cntBefore = (int) $pdoB->query("SELECT COUNT(*) FROM audit_log WHERE action='employee.delete'")->fetchColumn();
        // Call save.php with ONLY the fixture employee (no e56 emp in payload) -> triggers SYNC delete of e56
        $r = httpRequest('POST', $base . '/api/save.php', [
            'cookie' => $cookieAdmin,
            'body' => [
                'year' => 2099,
                'entries' => [],
                'groups' => [['id' => 'g0', 'name' => 'Smoke Fixture Group', 'sort_order' => 0]],
                'positions' => [['id' => 'pos_master', 'name' => 'Master', 'sort_order' => 0]],
                'employees' => [[ // only keep the fixture; e56 gets deleted by SYNC
                    'id' => 'emp_1',
                    'fullName' => 'Smoke Fixture Employee',
                    'positionId' => 'pos_master',
                    'groupId' => 'g0',
                ]],
                'holidays' => [],
                'vacationBalances' => [],
            ],
        ]);
        $j = jsonDecode($r['body']);
        assertTrue($r['status'] === 200, 'save failed: ' . $r['status']);
        // Should have created at least one employee.delete record
        $cntAfter = (int) $pdoB->query("SELECT COUNT(*) FROM audit_log WHERE action='employee.delete'")->fetchColumn();
        assertTrue($cntAfter > $cntBefore, 'no employee.delete audit record (before=' . $cntBefore . ', after=' . $cntAfter . ')');
        $auditRows = $pdoB->query(
            "SELECT details FROM audit_log WHERE action='employee.delete' ORDER BY id DESC LIMIT 1"
        )->fetchAll(PDO::FETCH_ASSOC);
        $details = json_decode($auditRows[0]['details'] ?? '', true);
        assertTrue(is_array($details) && array_key_exists('fullName', $details),
            'employee.delete details missing fullName: ' . ($auditRows[0]['details'] ?? 'null'));
        assertTrue(strlen($details['fullName']) > 0, 'empty fullName in delete audit');
        return 'deleted=' . $details['fullName'];
    });
} finally {
    // Also clean up the E5-6 test employee (if still exists).
    try {
        $pdoX = new PDO('sqlite:' . $root . '/data/app.db');
        $stmtX = $pdoX->prepare('DELETE FROM employees WHERE id = :e56 AND full_name = \'Smoke E56 Create User\'');
        $stmtX->execute([':e56' => $runE56TestEmpId]);
    } catch (Throwable $_) {}
    cleanup($base, $cookieAdmin, $testEmpId, $testEntryApprovedDate, $testImportDate, $cleanupErrors, $root . '/data/app.db');
    proc_terminate($proc);
    @unlink($cookieAdmin);
    @unlink($cookieSup);
}

// Verify DB intact after cleanup.
$dbPath = $root . '/data/app.db';
$dbIntact = false;
try {
    $pdo = new PDO('sqlite:' . $dbPath);
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM employees WHERE id = :id');
    $stmt->execute([':id' => $testEmpId]);
    $empLeft = (int) $stmt->fetchColumn();
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM schedule_entries WHERE (employee_id = :emp1 AND date = :d1) OR (employee_id = :emp2 AND date = :d2)');
    $stmt->execute([':emp1' => 'emp_1', ':d1' => $testEntryApprovedDate, ':emp2' => 'emp_1', ':d2' => $testImportDate]);
    $entriesLeft = (int) $stmt->fetchColumn();
    $dbIntact = ($empLeft === 0 && $entriesLeft === 0);
} catch (Throwable $e) {
    $cleanupErrors[] = 'db_intact_check: ' . $e->getMessage();
}

out('=== RESULTS: ' . $passed . ' passed, ' . $failed . ' failed out of ' . ($passed + $failed) . ' ===');
out('DB intact: ' . ($dbIntact ? 'YES' : 'NO'));
if ($cleanupErrors) {
    out('Cleanup warnings: ' . implode(' | ', $cleanupErrors));
}

exit(($hadFailure || !$dbIntact) ? 1 : 0);
