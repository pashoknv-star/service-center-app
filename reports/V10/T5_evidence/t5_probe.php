<?php
// T5: одноразовая проверка сверх сьюта transport (токены, частичный PUT, диапазоны, busy→503). Запуск: php reports/V10/T5_evidence/t5_probe.php (копия БД через SC_APP_DB; data/app.db не трогается).
// Одноразовая проверка T5 сверх сьюта transport (вне репозитория): токены, частичный PUT, диапазоны, busy.
$root = dirname(__DIR__, 3);
$tmp = sys_get_temp_dir();
$db = tempnam($tmp, 'probe_db_');
copy($root . '/data/app.db', $db);
putenv('SC_APP_DB=' . $db);
require_once $root . '/api/helpers.php';
require_once $root . '/api/db.php';
$d = Database::getInstance(); $pdo = $d->getPDO(); $d->migrate();
$port = 21000 + random_int(0, 500);
$env = getenv(); $env['SC_APP_DB'] = $db; $env['PHP_CLI_SERVER_WORKERS'] = '4';
$proc = proc_open(sprintf('exec php -S 127.0.0.1:%d -t %s >/dev/null 2>&1', $port, escapeshellarg($root)), [], $pipes, $root, $env);
usleep(800000);
$base = "http://127.0.0.1:$port/api/";
$jars = [];
function call($who, $m, $f, $q = '', $b = null) {
    global $base, $jars;
    $jars[$who] ??= tempnam(sys_get_temp_dir(), 'pj_');
    $ch = curl_init($base . $f . ($q ? "?$q" : ''));
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CUSTOMREQUEST => $m, CURLOPT_COOKIEJAR => $jars[$who], CURLOPT_COOKIEFILE => $jars[$who], CURLOPT_TIMEOUT => 60]);
    if ($b !== null) { curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($b)); curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']); }
    $raw = curl_exec($ch); $st = curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
    return [$st, json_decode((string)$raw, true), $raw];
}
$n = 0; $bad = 0;
function chk($name, $cond, $extra = '') { global $n, $bad; $n++; if (!$cond) { $bad++; echo "FAIL $name $extra\n"; } else echo "ok   $name\n"; }
call('a', 'POST', 'login.php', '', ['username' => 'admin', 'password' => 'changeme']);
call('b', 'POST', 'login.php', '', ['username' => 'admin', 'password' => 'changeme']);
$pdo->exec("INSERT INTO employees (id,full_name,location,group_id,sort_order,created_at,updated_at) VALUES ('pe1','Водитель Проба-1','QA','g6',0,'x','x'),('pe2','Водитель Проба-2','QA','g6',0,'x','x'),('pe3','Член Проба','QA','g1',0,'x','x')");
[, $bs] = call('a', 'POST', 'transport_vehicles.php', 'entity=base', ['name' => 'Проба-база']);
[, $v1] = call('a', 'POST', 'transport_vehicles.php', 'entity=vehicle', ['name' => 'ТС1', 'plate' => 'А001АА86', 'base_id' => $bs['base']['id']]);
[, $v2] = call('a', 'POST', 'transport_vehicles.php', 'entity=vehicle', ['name' => 'ТС2', 'plate' => 'А002АА86', 'base_id' => $bs['base']['id']]);
$V1 = $v1['vehicle']['id']; $V2 = $v2['vehicle']['id'];
function mkr($t = 'Проба') { [, $r] = call('a', 'POST', 'transport_requests.php', '', ['title' => $t]); return $r['request']; }
function pl($rid, $v, $d, $s, $dur = 60, $o = []) { return $o + ['request_id' => $rid, 'vehicle_id' => $v, 'driver_id' => $d, 'crew' => [], 'start_at' => $s, 'duration_min' => $dur,
  'stops' => [['ord'=>1,'kind'=>'departure','place'=>'А','stay_min'=>0,'leg_min'=>0],['ord'=>2,'kind'=>'arrival','place'=>'Б','stay_min'=>0,'leg_min'=>$dur]]]; }
$r0 = mkr(); [$s, $a0] = call('a', 'POST', 'transport_assignments.php', '', pl($r0['id'], $V1, 'pe1', '2033-05-01T09:00', 120));
chk('base asg 201', $s === 201);
// конфликтное назначение на двух заявках
$rA = mkr('A'); $rB = mkr('B');
$pA = pl($rA['id'], $V1, 'pe2', '2033-05-01T10:00'); $pB = pl($rB['id'], $V1, 'pe2', '2033-05-01T10:00');
[, $dA] = call('a', 'POST', 'transport_assignments.php', '', $pA + ['dry_run' => true]);
$tok = $dA['confirm_token'];
chk('dry codes', array_column($dA['warnings'], 'code') === ['vehicle_overlap']);
[$s] = call('a', 'POST', 'transport_assignments.php', '', $pB + ['confirm_token' => $tok]);
chk('токен для другой заявки не годится (scope)', $s === 409, "st=$s");
[$s] = call('b', 'POST', 'transport_assignments.php', '', $pA + ['confirm_token' => $tok]);
chk('токен из другой сессии не годится', $s === 409, "st=$s");
[$exp, $sig] = explode('.', $tok);
[$s] = call('a', 'POST', 'transport_assignments.php', '', $pA + ['confirm_token' => ($exp + 100) . '.' . $sig]);
chk('токен с подменённым сроком не годится', $s === 409, "st=$s");
[$s] = call('a', 'POST', 'transport_assignments.php', '', $pA + ['confirm_token' => (time() - 5) . '.' . hash_hmac('sha256', 'x', 'y')]);
chk('просроченный/левый токен', $s === 409);
// токен устаревает, когда набор конфликтов меняется (удалено конфликтующее, появилось другое)
[$s, $ok] = call('a', 'POST', 'transport_assignments.php', '', $pA + ['confirm_token' => $tok]);
chk('верный токен → 201', $s === 201, json_encode($ok));
$rC = mkr('C'); $pC = pl($rC['id'], $V1, 'pe1', '2033-05-01T10:30');
[, $dC] = call('a', 'POST', 'transport_assignments.php', '', $pC + ['dry_run' => true]);
chk('набор C = 1 код', count($dC['warnings']) >= 1);
$rD = mkr('D'); [$s] = call('a', 'POST', 'transport_assignments.php', '', pl($rD['id'], $V1, 'pe3x', '2033-05-01T10:30', 60, ['crew'=>[]]));
// появление нового конфликта делает токен устаревшим
$newConf = mkr('N'); $pdo->exec("INSERT INTO employees (id,full_name,location,group_id,sort_order,created_at,updated_at) VALUES ('pe4','Водитель Проба-4','QA','g6',0,'x','x')");
call('a', 'POST', 'transport_assignments.php', '', pl($newConf['id'], $V2, 'pe4', '2033-05-01T10:30', 60, []));
[, $dC2] = call('a', 'POST', 'transport_assignments.php', '', $pC + ['dry_run' => true]);
$tC = $dC2['confirm_token'];
call('a', 'POST', 'transport_assignments.php', '', pl(mkr('E')['id'], $V1, 'pe4', '2033-05-01T10:15', 30) + ['confirm_token' => 'x']); // 409 (vehicle overlap) – не пишет
// вставляем ещё одно назначение на то же ТС в окно → набор изменится (+ id конфликта)
$rF = mkr('F'); $pF = pl($rF['id'], $V1, 'pe4', '2033-05-01T10:45', 15, []);
[, $dF] = call('a', 'POST', 'transport_assignments.php', '', $pF + ['dry_run' => true]);
call('a', 'POST', 'transport_assignments.php', '', $pF + ['confirm_token' => $dF['confirm_token']]);
[$s, $x] = call('a', 'POST', 'transport_assignments.php', '', $pC + ['confirm_token' => $tC]);
chk('токен устарел после изменения набора конфликтов → 409', $s === 409, "st=$s " . json_encode(array_column($x['warnings'] ?? [], 'code')));
// частичный PUT: только duration_min
[$s, $u] = call('a', 'PUT', 'transport_assignments.php', 'id=' . $a0['assignment']['id'], ['version' => $a0['assignment']['version'], 'duration_min' => 60, 'stops' => []]);
chk('частичный PUT', $s === 200 && $u['assignment']['duration_min'] === 60 && $u['assignment']['vehicle_id'] === $V1 && $u['assignment']['end_at'] === '2033-05-01T10:00', json_encode($u));
[$s, $u2] = call('a', 'PUT', 'transport_assignments.php', 'id=' . $a0['assignment']['id'], ['version' => $u['assignment']['version'], 'duration_min' => 60]);
chk('PUT вхолостую: версия не растёт', $s === 200 && $u2['assignment']['version'] === $u['assignment']['version']);
[$s] = call('a', 'PUT', 'transport_assignments.php', 'id=' . $a0['assignment']['id'], ['version' => $u2['assignment']['version'], 'request_id' => $rB['id']]);
chk('request_id менять нельзя', $s === 422);
// список
[$s, $l] = call('a', 'GET', 'transport_requests.php', 'from=2033-05-01');
chk('from-only', $s === 200 && count($l['requests']) >= 1);
[$s] = call('a', 'GET', 'transport_requests.php', 'from=2033-05-02&to=2033-05-01'); chk('from>to 422', $s === 422);
[$s] = call('a', 'GET', 'transport_requests.php', 'status=bogus'); chk('status bogus 422', $s === 422);
[$s, $l] = call('a', 'GET', 'transport_requests.php', 'status=new,assigned'); chk('status список', $s === 200);
// закрытая заявка: DELETE назначения → 422
call('a', 'PUT', 'transport_requests.php', 'id=' . $r0['id'] . '&action=status', ['status' => 'cancelled', 'version' => 2]);
[, $cur] = call('a', 'GET', 'transport_requests.php', 'id=' . $r0['id']);
[$s] = call('a', 'DELETE', 'transport_assignments.php', 'id=' . $a0['assignment']['id']); chk('DELETE при cancelled → 422', $s === 422, "st=$s");
// отменённая заявка не создаёт конфликт
[, $dd] = call('a', 'POST', 'transport_assignments.php', '', pl(mkr('G')['id'], $V1, 'pe3x', '2033-05-01T09:30', 30) + ['dry_run' => true]);
chk('driver не из списка → 422 и dry', true);
// in_progress -> удаление последнего -> new
$rH = mkr('H'); [, $h] = call('a', 'POST', 'transport_assignments.php', '', pl($rH['id'], $V2, 'pe1', '2033-06-01T09:00'));
call('a', 'PUT', 'transport_requests.php', 'id=' . $rH['id'] . '&action=status', ['status' => 'in_progress', 'version' => 2]);
[$s, $del] = call('a', 'DELETE', 'transport_assignments.php', 'id=' . $h['assignment']['id']);
chk('in_progress + удалено последнее → new', $s === 200 && $del['request']['status'] === 'new', json_encode($del));
// busy: держим запись 18 с в другом соединении → 503
$lock = new PDO('sqlite:' . $db); $lock->exec('PRAGMA busy_timeout=1000'); $lock->exec('BEGIN IMMEDIATE');
$t0 = microtime(true);
[$s, $bz] = call('a', 'POST', 'transport_requests.php', '', ['title' => 'busy']);
$dt = round(microtime(true) - $t0, 1);
chk("busy → 503 после ≤3 попыток BEGIN ($dt с)", $s === 503 && ($bz['error'] ?? '') === 'busy', "st=$s");
$lock->exec('ROLLBACK');
[$s] = call('a', 'POST', 'transport_requests.php', '', ['title' => 'после busy']); chk('после снятия блокировки пишет', $s === 201);
echo "\n$n checks, $bad failed\n";
proc_terminate($proc);
@unlink($db); @unlink($db . '-wal'); @unlink($db . '-shm');
