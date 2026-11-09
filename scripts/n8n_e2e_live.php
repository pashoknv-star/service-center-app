<?php

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * n8n_e2e_live.php — сквозная проверка РЕАЛЬНОГО n8n через настоящий HTTP-API приложения (T1-4, AC-3/AC-4/AC-8).
 * php -S поднимается на временной копии БД (SC_APP_DB) с переменными из окружения / ~/.config/service-center-app/dev.env
 * (значения не печатаются). Сценарии: создание задачи (n8n отвечает) → 201 ok; блок sick → 422 с suggested_start n8n;
 * недоступный webhook (несуществующий путь) → 201 + pending (AC-8); перепроверка pending через реальный tasks-recheck.
 * Не входит в verify_all.sh (нужна сеть). Exit 0 — все сценарии прошли.
 */

$root = realpath(__DIR__ . '/..');
$realDb = $root . '/data/app.db';
$hashBefore = sha1_file($realDb);

$keys = ['TASKS_VALIDATE_WEBHOOK_URL', 'TASKS_RECHECK_WEBHOOK_URL', 'TASKS_N8N_WEBHOOK_SECRET'];
$cfg = [];
foreach ($keys as $k) {
    $v = getenv($k);
    $cfg[$k] = is_string($v) ? trim($v) : '';
}
$devEnv = (getenv('HOME') ?: '') . '/.config/service-center-app/dev.env';
if (is_file($devEnv)) {
    foreach (file($devEnv, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if ($line[0] !== '#' && strpos($line, '=') !== false) {
            [$k, $v] = explode('=', $line, 2);
            if (in_array($k, $keys, true) && $cfg[$k] === '') {
                $cfg[$k] = trim($v);
            }
        }
    }
}
foreach ($keys as $k) {
    if ($cfg[$k] === '') {
        fwrite(STDERR, "n8n не настроен: нет $k\n");
        exit(2);
    }
}

$tmpDb = tempnam(sys_get_temp_dir(), 'sc_e2e_db_');
copy($realDb, $tmpDb);
$pdo = new PDO('sqlite:' . $tmpDb);
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('PRAGMA busy_timeout = 5000');
foreach (['live_a' => 'Лайв Альфа', 'live_b' => 'Лайв Браво'] as $id => $nm) {
    $pdo->prepare("INSERT INTO employees (id, full_name, location, phone, photo_url, sort_order) VALUES (:i, :n, 'QA', '+7 900 000-00-00', 'images/x.jpg', 0)")
        ->execute([':i' => $id, ':n' => $nm]);
}
$sick = function (string $e, string $d) use ($pdo): void {
    $pdo->prepare("INSERT OR REPLACE INTO schedule_entries (employee_id, date, status, approval_status, version, updated_at) VALUES (:e, :d, 'sick', 'draft', 1, :t)")
        ->execute([':e' => $e, ':d' => $d, ':t' => date('c')]);
};
$sick('live_a', '2027-09-14');

function req(string $m, string $url, array $o = []): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_CUSTOMREQUEST => $m]);
    if (!empty($o['cookie'])) {
        curl_setopt($ch, CURLOPT_COOKIEJAR, $o['cookie']);
        curl_setopt($ch, CURLOPT_COOKIEFILE, $o['cookie']);
    }
    if (array_key_exists('body', $o)) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($o['body'], JSON_UNESCAPED_UNICODE));
    }
    $t0 = microtime(true);
    $raw = curl_exec($ch);
    $ms = (int) round((microtime(true) - $t0) * 1000);
    $st = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ['status' => $st, 'json' => json_decode((string) $raw, true), 'ms' => $ms];
}
function start_app(string $root, string $tmpDb, array $cfg, int $port, string $log): array
{
    $env = getenv();
    $env['SC_APP_DB'] = $tmpDb;
    foreach ($cfg as $k => $v) {
        $env[$k] = $v;
    }
    $p = proc_open(sprintf('exec php -S 127.0.0.1:%d -t %s > %s 2>&1', $port, escapeshellarg($root), escapeshellarg($log)),
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root, $env);
    foreach ($pipes as $x) {
        fclose($x);
    }
    for ($i = 0; $i < 50; $i++) {
        usleep(200000);
        $fp = @fsockopen('127.0.0.1', $port, $en, $es, 0.2);
        if ($fp) {
            fclose($fp);
            return [$p, 'http://127.0.0.1:' . $port];
        }
    }
    throw new RuntimeException('server did not start');
}

$fails = 0;
$step = function (string $label, bool $ok, string $detail) use (&$fails): void {
    echo ($ok ? 'PASS ' : 'FAIL ') . $label . ' — ' . $detail . PHP_EOL;
    if (!$ok) {
        $fails++;
    }
};
$procs = [];
try {
    // === Сервер 1: реальные URL/секрет ===
    $log1 = $tmpDb . '.log1';
    [$p1, $base] = start_app($root, $tmpDb, $cfg, 19700 + random_int(0, 99), $log1);
    $procs[] = $p1;
    $cookie = $tmpDb . '.cj';
    $lg = req('POST', $base . '/api/login.php', ['cookie' => $cookie, 'body' => ['username' => 'admin', 'password' => 'changeme']]);
    $step('login', $lg['status'] === 200, 'HTTP ' . $lg['status']);
    $T = $base . '/api/tasks.php';
    $A = fn(string $m, string $q = '', ?array $b = null) => req($m, $T . $q, ['cookie' => $cookie] + ($b !== null ? ['body' => $b] : []));

    $r = $A('POST', '', ['title' => 'live ok', 'start_at' => '2027-09-20', 'end_at' => '2027-09-21', 'assignees' => ['live_b']]);
    $step('E1 POST, реальный n8n отвечает', $r['status'] === 201 && ($r['json']['task']['check_state'] ?? '') === 'ok', 'HTTP ' . $r['status'] . ', check_state=' . ($r['json']['task']['check_state'] ?? '?') . ', ' . $r['ms'] . ' мс');
    $okMs = $r['ms'];

    $r = $A('POST', '', ['title' => 'live blocked', 'start_at' => '2027-09-13', 'end_at' => '2027-09-15', 'assignees' => ['live_a']]);
    $j = $r['json'] ?? [];
    $step('E2 POST на sick (вердикт n8n) → 422', $r['status'] === 422 && ($j['error'] ?? '') === 'TASK_BLOCKED_BY_SICK_OR_TRIP'
        && ($j['suggested_start'] ?? '') === '2027-09-15' && ($j['blocked_days'][0]['date'] ?? '') === '2027-09-14',
        'HTTP ' . $r['status'] . ', blocked=' . json_encode($j['blocked_days'] ?? null) . ', suggested_start=' . ($j['suggested_start'] ?? '?') . ', ' . $r['ms'] . ' мс');
    $step('E2b divergence-лог n8n/php пуст', !is_file($log1) || stripos((string) file_get_contents($log1), 'DIVERGENCE') === false, 'нет расхождений в error_log сервера');

    // === Сервер 2: webhook-путь не существует (имитация недоступности) → pending ===
    $cfgBad = $cfg;
    $cfgBad['TASKS_VALIDATE_WEBHOOK_URL'] = preg_replace('#/webhook/[^/]+$#', '/webhook/tasks-validate-missing', $cfg['TASKS_VALIDATE_WEBHOOK_URL']);
    $cfgBad['TASKS_RECHECK_WEBHOOK_URL'] = $cfg['TASKS_RECHECK_WEBHOOK_URL'];
    [$p2, $base2] = start_app($root, $tmpDb, $cfgBad, 19800 + random_int(0, 99), $tmpDb . '.log2');
    $procs[] = $p2;
    $T2 = $base2 . '/api/tasks.php';
    $lg2 = req('POST', $base2 . '/api/login.php', ['cookie' => $cookie . '2', 'body' => ['username' => 'admin', 'password' => 'changeme']]);
    $B = fn(string $m, string $q = '', ?array $b = null) => req($m, $T2 . $q, ['cookie' => $cookie . '2'] + ($b !== null ? ['body' => $b] : []));
    $r = $B('POST', '', ['title' => 'live pending', 'start_at' => '2027-09-28', 'end_at' => '2027-09-29', 'assignees' => ['live_a']]);
    $pid = $r['json']['task']['id'] ?? '';
    $step('E3 AC-8: webhook недоступен (404) → 201 + pending', $r['status'] === 201 && ($r['json']['task']['check_state'] ?? '') === 'pending', 'HTTP ' . $r['status'] . ', check_state=' . ($r['json']['task']['check_state'] ?? '?') . ', ' . $r['ms'] . ' мс');

    // Новый больничный на период pending-задачи, затем реальный tasks-recheck через GET списка.
    $sick('live_a', '2027-09-29');
    $pdo->prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('tasks_recheck_at', :v)")->execute([':v' => (string) (time() - 3600)]);
    $lst = $A('GET', '?from=2027-09-01&to=2027-09-30');   // сервер 1: recheck URL реальный
    $conf = null;
    foreach ($lst['json']['tasks'] ?? [] as $t) {
        if ($t['id'] === $pid) {
            $conf = $t['conflict'];
        }
    }
    $step('E4 GET списка не ждёт n8n; conflict по новому больничному', $lst['status'] === 200 && $conf === true && $lst['ms'] < 1500, 'HTTP ' . $lst['status'] . ', conflict=' . json_encode($conf) . ', GET ' . $lst['ms'] . ' мс');
    $state = 'pending';
    for ($i = 0; $i < 40 && $state !== 'ok'; $i++) {
        usleep(250000);
        $state = (string) $pdo->query('SELECT check_state FROM tasks WHERE id = ' . $pdo->quote($pid))->fetchColumn();
    }
    $aud = $pdo->query("SELECT details FROM audit_log WHERE action = 'task.recheck' AND entity_id = " . $pdo->quote($pid))->fetchColumn();
    $step('E5 реальный tasks-recheck: pending → ok, audit task.recheck', $state === 'ok' && is_string($aud) && (json_decode($aud, true)['conflict'] ?? null) === true, 'check_state=' . $state . ', audit=' . ($aud ?: '—'));
    echo 'Макс. время POST с реальным n8n: ' . $okMs . ' мс' . PHP_EOL;
} catch (Throwable $e) {
    echo 'FAIL исключение: ' . $e->getMessage() . PHP_EOL;
    $fails++;
}
foreach ($procs as $p) {
    proc_terminate($p);
}
foreach (glob($tmpDb . '*') ?: [] as $f) {
    @unlink($f);
}
$intact = sha1_file($realDb) === $hashBefore;
echo 'DB intact: ' . ($intact ? 'YES' : 'NO') . PHP_EOL;
echo $fails === 0 ? 'E2E LIVE: ALL PASSED' . PHP_EOL : "E2E LIVE: $fails FAILED" . PHP_EOL;
exit($fails === 0 && $intact ? 0 : 1);
