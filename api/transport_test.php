<?php

declare(strict_types=1);

// Служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * transport_test.php — сьют `transport` (V10-T2): тесты API заявок и назначений модуля «Транспорт»
 * ДО реализации (api/transport_requests.php, api/transport_assignments.php — задача V10-T5).
 * Единственный источник правды — reports/V10/specs/CONTRACT.md (часть 2) и 00_COMMON.md.
 * Фикстуры справочников (базы, ТС, пул, перенос) берутся из API T1 (api/transport_vehicles.php) по контракту,
 * сотрудники / schedule_entries / trips — прямыми SQL на временной копии БД. Все данные синтетические.
 *
 * ОЖИДАЕМО КРАСНЫЙ ДО V10-T5 (и до слияния T1: нужна схема v15). Тест-автор ≠ автор реализации: T5 тесты не правит.
 *
 * Usage:  php api/transport_test.php         (явно: bash scripts/verify_all.sh transport; в общий gate НЕ входит)
 *
 * Изоляция (как api/tasks_links_test.php): data/app.db копируется во временный файл, весь тест (CLI-часть и
 * временный `php -S` с несколькими обработчиками PHP_CLI_SERVER_WORKERS) работает через env SC_APP_DB на этой копии;
 * data/app.db не изменяется (sha1 до/после). Вывод: «=== RESULTS: N passed, M failed ... ===» и «DB intact: YES».
 *
 * Детерминизм: даты фикстур — фиксированные (2032-…), отсчёт от константы, а не от «сегодня»; каждый тест создаёт
 * собственные ТС/водителей/сотрудников/заявки и свой день, порядок прогона не важен.
 * Каждое падение печатает причину; «FIXTURE …» — фикстура (API T1/создание заявки) не создалась,
 * «не JSON (эндпоинт/реализация отсутствует?)» — реализации ещё нет.
 */

$root = realpath(__DIR__ . '/..');
if ($root === false) {
    fwrite(STDERR, "Cannot resolve project root\n");
    exit(1);
}
$realDb = $root . '/data/app.db';
$realDbHashBefore = is_file($realDb) ? sha1_file($realDb) : '';

$tmpDir = sys_get_temp_dir();
$tmpDb = tempnam($tmpDir, 'sc_transport_db_');
if ($tmpDb === false || !copy($realDb, $tmpDb)) {
    fwrite(STDERR, "Cannot create temp DB copy\n");
    exit(1);
}
putenv('SC_APP_DB=' . $tmpDb);
putenv('TASKS_VALIDATE_WEBHOOK_URL');
$_ENV['SC_APP_DB'] = $tmpDb;

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';

// ----------------------------------------------------------------------------
// Контекст и мелкие утилиты
// ----------------------------------------------------------------------------
final class Ctx
{
    public static string $base = '';
    /** @var array<string,string> who => cookie jar */
    public static array $cookies = [];
    public static PDO $pdo;
    public static int $seq = 0;
    public static int $dseq = 0;
    /** @var array<string,string> username => users.id */
    public static array $uid = [];
    public static ?array $fx = null;
    public static ?string $fxErr = null;
}

$passed = 0;
$failed = 0;
$testNo = 0;
$failKinds = [];

function out(string $s): void { echo $s, PHP_EOL; }
function ok(bool $cond, string $msg = 'assert failed'): void { if (!$cond) { throw new RuntimeException($msg); } }
function eq(mixed $actual, mixed $expected, string $what = 'value'): void
{
    if ($actual !== $expected) {
        $cut = static fn(string $s): string => mb_strlen($s) > 300 ? mb_substr($s, 0, 300) . '…(+' . (mb_strlen($s) - 300) . ')' : $s;
        throw new RuntimeException($cut($what) . ': expected ' . $cut((string) json_encode($expected, JSON_UNESCAPED_UNICODE))
            . ', got ' . $cut((string) json_encode($actual, JSON_UNESCAPED_UNICODE)));
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
        $msg = $e->getMessage();
        if ($e instanceof PDOException && stripos($msg, 'no such table') !== false) {
            $msg .= ' [схема v15 из T1 не применена — таблицы модуля отсутствуют]';
        }
        out(sprintf('[%d] %s: FAIL — %s', $testNo, $label, $msg));
        $kind = (stripos($msg, 'не JSON') !== false || stripos($msg, 'схема v15') !== false || stripos($msg, 'FIXTURE') !== false || stripos($msg, 'нужна схема v15') !== false) ? 'нет реализации (T1/T5): эндпоинт не JSON, нет таблиц или фикстура не создалась' : 'прочие';
        $GLOBALS['failKinds'][$kind] = ($GLOBALS['failKinds'][$kind] ?? 0) + 1;
    }
};

function nextSeq(): int { return ++Ctx::$seq; }

/** Рабочий день теста: уникальный, детерминированный, от константы 2032-01-05 (шаг 3 дня). */
function day(): string
{
    Ctx::$dseq++;
    return (new DateTimeImmutable('2032-01-05', new DateTimeZone('UTC')))->modify('+' . (Ctx::$dseq * 3) . ' days')->format('Y-m-d');
}
function addDays(string $ymd, int $n): string
{
    return (new DateTimeImmutable($ymd, new DateTimeZone('UTC')))->modify(($n >= 0 ? '+' : '') . $n . ' days')->format('Y-m-d');
}
function at(string $ymd, string $hm): string { return $ymd . 'T' . $hm; }

// ----------------------------------------------------------------------------
// HTTP
// ----------------------------------------------------------------------------
function http(string $method, string $url, ?string $cookie = null, ?array $body = null): array
{
    $ch = curl_init($url);
    $headers = ['Accept: application/json'];
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 40,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    if ($cookie !== null) {
        curl_setopt($ch, CURLOPT_COOKIEJAR, $cookie);
        curl_setopt($ch, CURLOPT_COOKIEFILE, $cookie);
    }
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
        $headers[] = 'Content-Type: application/json';
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
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

/** Параллельные запросы (curl_multi): [['who','method','file','query','body'], …] → результаты в том же порядке. */
function race(array $calls): array
{
    $mh = curl_multi_init();
    $hs = [];
    foreach ($calls as $i => $c) {
        [$who, $method, $file, $query, $body] = $c + [4 => null];
        $url = Ctx::$base . '/api/' . $file . ($query !== '' ? '?' . $query : '');
        $ch = curl_init($url);
        $headers = ['Accept: application/json'];
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 60, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_FOLLOWLOCATION => false]);
        $cj = Ctx::$cookies[$who] ?? null;
        if ($cj !== null) {
            curl_setopt($ch, CURLOPT_COOKIEFILE, $cj);   // только чтение jar: параллельные запросы не должны перетирать его
        }
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
            $headers[] = 'Content-Type: application/json';
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_multi_add_handle($mh, $ch);
        $hs[$i] = $ch;
    }
    do {
        $st = curl_multi_exec($mh, $active);
        if ($active) { curl_multi_select($mh, 0.2); }
    } while ($active && $st === CURLM_OK);
    $res = [];
    foreach ($hs as $i => $ch) {
        $raw = (string) curl_multi_getcontent($ch);
        $res[$i] = ['status' => curl_getinfo($ch, CURLINFO_RESPONSE_CODE), 'raw' => $raw, 'json' => json_decode($raw, true)];
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $res;
}

/** who: admin | admin2 | z0 | z1 | view | anon. */
function api(string $who, string $method, string $file, string $query = '', ?array $body = null): array
{
    $url = Ctx::$base . '/api/' . $file . ($query !== '' ? '?' . $query : '');
    return http($method, $url, Ctx::$cookies[$who] ?? null, $body);
}
function rq(string $who, string $method, string $q = '', ?array $body = null): array { return api($who, $method, 'transport_requests.php', $q, $body); }
function asg(string $who, string $method, string $q = '', ?array $body = null): array { return api($who, $method, 'transport_assignments.php', $q, $body); }
function vhc(string $who, string $method, string $q = '', ?array $body = null): array { return api($who, $method, 'transport_vehicles.php', $q, $body); }

function diag(array $r): string
{
    $j = $r['json'];
    if (!is_array($j)) {
        $head = trim(preg_replace('/\s+/', ' ', substr(strip_tags($r['raw']), 0, 90)) ?? '');
        return 'HTTP ' . $r['status'] . ', ответ не JSON (эндпоинт/реализация отсутствует?): «' . $head . '»';
    }
    return 'HTTP ' . $r['status'] . ' ' . mb_substr((string) json_encode($j, JSON_UNESCAPED_UNICODE), 0, 260);
}
function expect_status(array $r, int $st, string $what): void
{
    if ($r['status'] !== $st) {
        throw new RuntimeException($what . ': ожидался HTTP ' . $st . '; ' . diag($r));
    }
    if ($st >= 200 && $st < 300 && (!is_array($r['json']) || ($r['json']['success'] ?? null) !== true)) {
        throw new RuntimeException($what . ': HTTP ' . $st . ' без success:true; ' . diag($r));
    }
}
/** @param string|string[] $codes */
function expect_err(array $r, int $st, string|array $codes, string $what): void
{
    if ($r['status'] !== $st) {
        throw new RuntimeException($what . ': ожидался HTTP ' . $st . ' ' . json_encode($codes, JSON_UNESCAPED_UNICODE) . '; ' . diag($r));
    }
    $codes = (array) $codes;
    $got = is_array($r['json']) ? ($r['json']['error'] ?? null) : null;
    if (!in_array($got, $codes, true)) {
        throw new RuntimeException($what . ': HTTP ' . $st . ', ожидался error ' . json_encode($codes, JSON_UNESCAPED_UNICODE) . '; ' . diag($r));
    }
}
function unwrap(array $r, string $key): array
{
    $j = $r['json'];
    if (!is_array($j)) { throw new RuntimeException('нет JSON: ' . diag($r)); }
    if (isset($j[$key]) && is_array($j[$key])) { return $j[$key]; }
    if (isset($j['id'])) { return $j; }   // контракт не фиксирует обёртку: допускаем плоский ответ
    throw new RuntimeException('нет объекта «' . $key . '» в ответе: ' . diag($r));
}
function listOf(array $r, string $key): array
{
    $j = $r['json'];
    if (!is_array($j)) { throw new RuntimeException('нет JSON: ' . diag($r)); }
    if (array_is_list($j)) { return $j; }
    foreach ([$key, 'items', 'data'] as $k) {
        if (isset($j[$k]) && is_array($j[$k])) { return $j[$k]; }
    }
    throw new RuntimeException('нет списка «' . $key . '» в ответе: ' . diag($r));
}
function ids(array $items): array { return array_map(static fn($x) => (string) ($x['id'] ?? ''), $items); }
function wcodes(array $r): array
{
    $w = is_array($r['json']) ? ($r['json']['warnings'] ?? null) : null;
    if (!is_array($w)) { throw new RuntimeException('нет warnings в ответе: ' . diag($r)); }
    $c = array_map(static fn($x) => (string) ($x['code'] ?? ''), $w);
    sort($c);
    return $c;
}
function token(array $r): string
{
    $t = is_array($r['json']) ? ($r['json']['confirm_token'] ?? null) : null;
    if (!is_string($t) || $t === '') { throw new RuntimeException('нет confirm_token в ответе: ' . diag($r)); }
    return $t;
}
function crewIds(array $a): array
{
    $o = [];
    foreach (($a['crew'] ?? []) as $c) { $o[] = is_array($c) ? (string) ($c['employee_id'] ?? $c['id'] ?? '') : (string) $c; }
    sort($o);
    return $o;
}

// ----------------------------------------------------------------------------
// SQL-фикстуры (временная БД): сотрудники, отпуск/болезнь, командировки
// ----------------------------------------------------------------------------
function emp(string $label, string $group = 'g1'): string
{
    $n = nextSeq();
    $id = 'tx_e' . $n;
    Ctx::$pdo->prepare("INSERT INTO employees (id, full_name, location, group_id, sort_order, created_at, updated_at)
                        VALUES (:i, :n, 'QA', :g, 0, '2032-01-01T00:00:00+05:00', '2032-01-01T00:00:00+05:00')")
        ->execute([':i' => $id, ':n' => $label . ' Проверочный-' . $n, ':g' => $group]);
    return $id;
}
/** Водитель из группы «Транспорт» (в dev-БД это g6, группа ищется по названию). */
function drv(): string { return emp('Водитель', 'g6'); }
/** Совместитель: сотрудник другой группы + запись в пуле (через API T1). */
function poolDrv(): string
{
    $e = emp('Совместитель', 'g1');
    $r = vhc('admin', 'POST', 'entity=pool', ['employee_id' => $e]);
    if (!in_array($r['status'], [200, 201], true)) {
        throw new RuntimeException('FIXTURE (API T1: POST entity=pool): ' . diag($r));
    }
    return $e;
}
function absence(string $emp, string $date, string $status): void
{
    Ctx::$pdo->prepare("INSERT INTO schedule_entries (employee_id, date, status, comment, approval_status, updated_at, version)
                        VALUES (:e, :d, :s, '', 'approved', '2032-01-01T00:00:00+05:00', 1)")
        ->execute([':e' => $emp, ':d' => $date, ':s' => $status]);
}
function trip(string $emp, string $from, string $to): void
{
    $id = 'tx_trip' . nextSeq();
    Ctx::$pdo->prepare("INSERT INTO trips (id, title, location, status, version, created_by, created_at, updated_at)
                        VALUES (:i, 'Выезд-тест', 'Тестпункт', 'confirmed', 1, 'tx', '2032-01-01T00:00:00+05:00', '2032-01-01T00:00:00+05:00')")
        ->execute([':i' => $id]);
    Ctx::$pdo->prepare('INSERT INTO trip_participants (trip_id, employee_id, start_date, end_date) VALUES (:t, :e, :f, :to)')
        ->execute([':t' => $id, ':e' => $emp, ':f' => $from, ':to' => $to]);
}

// ----------------------------------------------------------------------------
// Фикстуры через API T1 (по контракту) и заявки/назначения (API T5)
// ----------------------------------------------------------------------------
function fx(): array
{
    if (Ctx::$fxErr !== null) { throw new RuntimeException(Ctx::$fxErr); }
    if (Ctx::$fx !== null) { return Ctx::$fx; }
    try {
        $out = [];
        foreach (['baseA' => 'Тестбаза-Север', 'baseB' => 'Тестбаза-Юг'] as $k => $name) {
            $r = vhc('admin', 'POST', 'entity=base', ['name' => $name, 'sort_order' => $k === 'baseA' ? 1 : 2]);
            if ($r['status'] !== 201 || !isset($r['json']['base']['id'])) {
                throw new RuntimeException('POST entity=base: ' . diag($r));
            }
            $out[$k] = (string) $r['json']['base']['id'];
        }
        Ctx::$fx = $out;
    } catch (Throwable $e) {
        Ctx::$fxErr = 'FIXTURE (API T1 по контракту): ' . $e->getMessage();
        throw new RuntimeException(Ctx::$fxErr);
    }
    return Ctx::$fx;
}
function veh(array $over = []): string
{
    $n = nextSeq();
    $body = $over + ['name' => 'ТС-тест-' . $n, 'plate' => 'Т' . sprintf('%03d', $n) . 'ТТ86', 'base_id' => fx()['baseA']];
    $r = vhc('admin', 'POST', 'entity=vehicle', $body);
    if ($r['status'] !== 201 || !isset($r['json']['vehicle']['id'])) {
        throw new RuntimeException('FIXTURE (API T1: POST entity=vehicle): ' . diag($r));
    }
    return (string) $r['json']['vehicle']['id'];
}
function mkReq(string $who = 'admin', array $over = []): array
{
    $r = rq($who, 'POST', '', $over + ['title' => 'Заявка-тест-' . nextSeq()]);
    if ($r['status'] !== 201) { throw new RuntimeException('FIXTURE: создание заявки (' . $who . '): ' . diag($r)); }
    return unwrap($r, 'request');
}
function getReq(string $id, string $who = 'admin'): array
{
    $r = rq($who, 'GET', 'id=' . rawurlencode($id));
    if ($r['status'] !== 200) { throw new RuntimeException('GET заявки: ' . diag($r)); }
    return unwrap($r, 'request');
}
/** Маршрут «выезд → приезд»: сумма stay_min + leg_min равна длительности (предупреждения route_sum_mismatch нет). */
function route(int $dur): array
{
    return [
        ['ord' => 1, 'kind' => 'departure', 'place' => 'Тестпункт-А', 'stay_min' => 0, 'leg_min' => 0],
        ['ord' => 2, 'kind' => 'arrival', 'place' => 'Тестпункт-Б', 'stay_min' => 0, 'leg_min' => $dur],
    ];
}
function payload(string $reqId, string $vid, string $did, string $start, int $dur = 60, array $over = []): array
{
    return $over + [
        'request_id' => $reqId, 'vehicle_id' => $vid, 'driver_id' => $did, 'crew' => [],
        'start_at' => $start, 'duration_min' => $dur, 'stops' => route($dur),
    ];
}
function mkAsg(string $reqId, string $vid, string $did, string $start, int $dur = 60, array $over = [], string $who = 'admin'): array
{
    $r = asg($who, 'POST', '', payload($reqId, $vid, $did, $start, $dur, $over));
    if ($r['status'] !== 201) { throw new RuntimeException('FIXTURE: создание назначения (' . $who . '): ' . diag($r)); }
    return unwrap($r, 'assignment');
}
function dryAsg(string $who, array $p): array { return asg($who, 'POST', '', $p + ['dry_run' => true]); }
/** Создать назначение «с подтверждением»: dry_run → confirm_token → запись (если предупреждений нет — просто запись). */
function confirmAsg(string $who, array $p): array
{
    $d = dryAsg($who, $p);
    if ($d['status'] !== 200) { throw new RuntimeException('FIXTURE: dry_run: ' . diag($d)); }
    $extra = ($d['json']['warnings'] ?? []) !== [] ? ['confirm_token' => token($d)] : [];
    $r = asg($who, 'POST', '', $p + $extra);
    if ($r['status'] !== 201) { throw new RuntimeException('FIXTURE: создание назначения с подтверждением: ' . diag($r)); }
    return unwrap($r, 'assignment');
}
function cleanState(): array { return [jcount(), (int) Ctx::$pdo->query('SELECT COUNT(*) FROM transport_assignments')->fetchColumn(), (int) Ctx::$pdo->query('SELECT COUNT(*) FROM transport_requests')->fetchColumn()]; }

// ----------------------------------------------------------------------------
// Журнал / БД
// ----------------------------------------------------------------------------
function jcount(?string $entityId = null): int
{
    if ($entityId === null) { return (int) Ctx::$pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn(); }
    $st = Ctx::$pdo->prepare('SELECT COUNT(*) FROM transport_journal WHERE entity_id = :e');
    $st->execute([':e' => $entityId]);
    return (int) $st->fetchColumn();
}
function jrows(string $entityId): array
{
    $st = Ctx::$pdo->prepare('SELECT * FROM transport_journal WHERE entity_id = :e ORDER BY id');
    $st->execute([':e' => $entityId]);
    return $st->fetchAll(PDO::FETCH_ASSOC);
}
function asgCount(string $reqId): int
{
    $st = Ctx::$pdo->prepare('SELECT COUNT(*) FROM transport_assignments WHERE request_id = :r');
    $st->execute([':r' => $reqId]);
    return (int) $st->fetchColumn();
}
function scalar(string $sql, array $args = []): mixed
{
    $st = Ctx::$pdo->prepare($sql);
    $st->execute($args);
    return $st->fetchColumn();
}

// ----------------------------------------------------------------------------
// CLI-часть: миграция копии и поднятие сервера
// ----------------------------------------------------------------------------
$db = Database::getInstance();
$pdo = $db->getPDO();
$pdo->exec('PRAGMA busy_timeout = 5000');
Ctx::$pdo = $pdo;
$db->migrate();
foreach ($pdo->query('SELECT id, username FROM users')->fetchAll(PDO::FETCH_ASSOC) as $u) {
    Ctx::$uid[$u['username']] = $u['id'];
}

$host = '127.0.0.1';
$port = null;
for ($attempt = 0; $attempt < 10; $attempt++) {
    $cand = 20400 + random_int(0, 400);
    $fp = @fsockopen($host, $cand, $errno, $errstr, 0.2);
    if ($fp) { fclose($fp); continue; }
    $port = $cand;
    break;
}
if ($port === null) {
    fwrite(STDERR, "No free port\n");
    exit(1);
}
Ctx::$base = "http://{$host}:{$port}";
$serverLog = tempnam($tmpDir, 'sc_transport_srv_');
foreach (['admin', 'admin2', 'z0', 'z1', 'view'] as $who) {
    Ctx::$cookies[$who] = (string) tempnam($tmpDir, 'sc_tx_' . $who . '_');
}
$env = getenv();
$env['SC_APP_DB'] = $tmpDb;
$env['PHP_CLI_SERVER_WORKERS'] = '4';   // несколько обработчиков: тесты атомарности (группа C) — настоящие параллельные запросы
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

$login = function (string $who, string $user): array {
    $r = http('POST', Ctx::$base . '/api/login.php', Ctx::$cookies[$who], ['username' => $user, 'password' => 'changeme']);
    if ($r['status'] !== 200) {
        throw new RuntimeException("login $user failed: " . diag($r));
    }
    return $r['json']['user'];
};

/** Совпадение «чужие заявки»: кто может править заявки владельца (контракт, сводная таблица прав). */
$can = static fn(string $actor, string $owner): bool => match ($actor) {
    'admin' => true,
    'z0' => in_array($owner, ['z0', 'z1'], true),   // supervisor_zone0: свои и заявки supervisor_zone1 (TRANSPORT_EDIT_DELEGATION)
    'z1' => $owner === 'z1',                         // supervisor_zone1: только свои
    default => false,                                // viewer: никогда
};

out('=== TRANSPORT TEST START (ожидаемо красный до V10-T5) ===');

try {
    $roles = [
        'admin' => $login('admin', 'admin')['role'],
        'z0' => $login('z0', 'supervisor_zone0')['role'],
        'z1' => $login('z1', 'supervisor_zone1')['role'],
        'view' => $login('view', 'viewer_test')['role'],
    ];
    $login('admin2', 'admin');

    // =====================================================================
    // H — харнес и предусловия (T1)
    // =====================================================================
    $run('H1 харнес: временный php -S отвечает, аноним на существующем api/tasks.php → 401 (сервер и изоляция работают)', function () {
        $r = http('GET', Ctx::$base . '/api/tasks.php');
        eq($r['status'], 401, 'status');
        return 'сервер жив';
    });
    $run('H2 харнес: четыре учётки логинятся с отдельными cookie-банками, роли admin/supervisor/supervisor/viewer', function () use ($roles) {
        eq($roles, ['admin' => 'admin', 'z0' => 'supervisor', 'z1' => 'supervisor', 'view' => 'viewer'], 'роли');
        ok(count(array_unique(array_map(static fn($c) => $c, Ctx::$cookies))) === count(Ctx::$cookies), 'банки различны');
        return 'ok';
    });
    $run('H3 предусловие T1: схема v15 — meta.schema_version ≥ 15 и все таблицы модуля существуют', function () {
        $v = (int) scalar("SELECT value FROM meta WHERE key = 'schema_version'");
        ok($v >= 15, 'meta.schema_version = ' . $v . ' (нужна схема v15 из T1)');
        $have = Ctx::$pdo->query("SELECT name FROM sqlite_master WHERE type = 'table'")->fetchAll(PDO::FETCH_COLUMN);
        foreach (['transport_bases', 'vehicles', 'transport_driver_pool', 'transport_requests', 'transport_assignments',
                  'assignment_crew', 'assignment_stops', 'geo_cache', 'transport_journal'] as $t) {
            ok(in_array($t, $have, true), 'нет таблицы ' . $t);
        }
        return 'v' . $v;
    });
    $run('H4 фикстуры T1 по контракту: базы и ТС создаются через api/transport_vehicles.php, GET отдаёт bases/vehicles/drivers', function () {
        fx();
        $vid = veh();
        $r = vhc('admin', 'GET');
        expect_status($r, 200, 'GET transport_vehicles');
        foreach (['bases', 'vehicles', 'drivers'] as $k) { ok(isset($r['json'][$k]) && is_array($r['json'][$k]), 'нет ' . $k); }
        ok(in_array($vid, array_map(static fn($v) => $v['id'], $r['json']['vehicles']), true), 'созданное ТС не в списке');
        return $vid;
    });

    // =====================================================================
    // P — права (сводная таблица CONTRACT.md)
    // =====================================================================
    $run('P1 аноним: GET списка заявок → 401 unauthorized', function () {
        expect_err(rq('anon', 'GET'), 401, 'unauthorized', 'GET list');
        return 'ok';
    });
    $run('P2 аноним: GET заявки по id → 401 (а не 404: проверка авторизации раньше поиска)', function () {
        expect_err(rq('anon', 'GET', 'id=tr_nonexistent'), 401, 'unauthorized', 'GET id');
        return 'ok';
    });
    $run('P3 аноним: POST заявки → 401, заявка не создаётся', function () {
        $n = (int) scalar('SELECT COUNT(*) FROM transport_requests');
        expect_err(rq('anon', 'POST', '', ['title' => 'Аноним-тест']), 401, 'unauthorized', 'POST');
        eq((int) scalar('SELECT COUNT(*) FROM transport_requests'), $n, 'число заявок');
        return 'ok';
    });
    $run('P4 аноним: PUT заявки и PUT ?action=status → 401', function () {
        $req = mkReq();
        expect_err(rq('anon', 'PUT', 'id=' . $req['id'], ['title' => 'x', 'version' => $req['version']]), 401, 'unauthorized', 'PUT');
        expect_err(rq('anon', 'PUT', 'id=' . $req['id'] . '&action=status', ['status' => 'cancelled', 'version' => $req['version']]), 401, 'unauthorized', 'status');
        eq(getReq($req['id'])['status'], 'new', 'статус не менялся');
        return 'ok';
    });
    $run('P5 аноним: назначения POST / dry_run / PUT / DELETE → 401, ничего не пишется', function () {
        $req = mkReq();
        $p = payload($req['id'], veh(), drv(), at(day(), '09:00'));
        $s0 = cleanState();
        expect_err(asg('anon', 'POST', '', $p), 401, 'unauthorized', 'POST');
        expect_err(asg('anon', 'POST', '', $p + ['dry_run' => true]), 401, 'unauthorized', 'dry_run');
        expect_err(asg('anon', 'PUT', 'id=ta_x', $p + ['version' => 1]), 401, 'unauthorized', 'PUT');
        expect_err(asg('anon', 'DELETE', 'id=ta_x'), 401, 'unauthorized', 'DELETE');
        eq(cleanState(), $s0, 'состояние');
        return 'ok';
    });
    $run('P6 чтение: список заявок доступен всем четырём ролям (200, success), чужая заявка admin видна', function () {
        $req = mkReq('admin');
        foreach (['admin', 'z0', 'z1', 'view'] as $who) {
            $r = rq($who, 'GET', 'status=new');
            expect_status($r, 200, 'GET list ' . $who);
            ok(in_array($req['id'], ids(listOf($r, 'requests')), true), $who . ': не видит заявку admin в списке');
        }
        return 'ok';
    });
    foreach (['admin', 'z0', 'z1'] as $owner) {
        $run("P7-$owner чужие заявки читаются всеми: заявка автора $owner — GET ?id= у admin/zone0/zone1/viewer = 200, поля на месте", function () use ($owner) {
            $req = mkReq($owner, ['title' => 'Читаемая-' . $owner]);
            foreach (['admin', 'z0', 'z1', 'view'] as $who) {
                $r = rq($who, 'GET', 'id=' . $req['id']);
                expect_status($r, 200, 'GET ' . $who);
                $g = unwrap($r, 'request');
                eq($g['title'], 'Читаемая-' . $owner, $who . ': title');
                foreach (['id', 'display_no', 'subscriber', 'address', 'comment', 'status', 'source', 'external_id', 'created_by', 'created_by_name', 'version', 'assignments', 'can_edit'] as $k) {
                    ok(array_key_exists($k, $g), $who . ': нет поля ' . $k);
                }
            }
            return 'ok';
        });
    }
    foreach (['admin' => 'admin', 'z0' => 'supervisor_zone0', 'z1' => 'supervisor_zone1'] as $who => $uname1) {
        $run("P8-$who создание заявки: $uname1 → 201, created_by = его users.id, статус new", function () use ($who, $uname1) {
            $r = rq($who, 'POST', '', ['title' => 'Создана-' . $who]);
            expect_status($r, 201, 'POST');
            $q = unwrap($r, 'request');
            eq($q['created_by'], Ctx::$uid[$uname1], 'created_by');
            eq($q['status'], 'new', 'status');
            eq(scalar('SELECT created_by FROM transport_requests WHERE id = :i', [':i' => $q['id']]), Ctx::$uid[$uname1], 'created_by в БД');
            return $q['id'];
        });
    }
    $run('P8-view создание заявки: viewer → 403 forbidden, в БД ничего не появляется (и журнал не растёт)', function () {
        $s0 = cleanState();
        expect_err(rq('view', 'POST', '', ['title' => 'Viewer-запрет']), 403, 'forbidden', 'POST');
        eq(cleanState(), $s0, 'состояние');
        return 'ok';
    });

    // Матрица «кто → чьи заявки» для всех операций записи (12 сочетаний; viewer — всегда 403).
    foreach (['admin', 'z0', 'z1', 'view'] as $actor) {
        foreach (['admin', 'z0', 'z1'] as $owner) {
            $allowed = $can($actor, $owner);
            $run("P9 матрица: $actor правит заявку автора $owner → " . ($allowed ? 'разрешено (PUT/статус/назначения)' : '403 на PUT/статус/POST/PUT/DELETE назначения, ничего не меняется'),
                function () use ($actor, $owner, $allowed) {
                    $req = mkReq($owner);
                    $vid = veh(); $did = drv(); $d = day();
                    $a0 = mkAsg($req['id'], $vid, $did, at($d, '08:00'), 60, [], 'admin');   // назначение создаёт admin (правит любые)
                    $cur = getReq($req['id']);
                    $v2 = veh(); $d2 = drv();   // фикстуры (журнал T1) — до замера состояния
                    $s0 = cleanState();
                    $res = [];
                    $res['put'] = rq($actor, 'PUT', 'id=' . $req['id'], ['title' => 'Правка-' . $actor, 'version' => $cur['version']]);
                    $res['post'] = asg($actor, 'POST', '', payload($req['id'], $v2, $d2, at($d, '12:00'), 60));
                    $res['putA'] = asg($actor, 'PUT', 'id=' . $a0['id'], payload($req['id'], $vid, $did, at($d, '08:00'), 90) + ['version' => $a0['version']]);
                    $res['del'] = asg($actor, 'DELETE', 'id=' . $a0['id']);
                    $cur2 = getReq($req['id']);
                    $res['status'] = rq($actor, 'PUT', 'id=' . $req['id'] . '&action=status', ['status' => 'cancelled', 'version' => $cur2['version']]);
                    if ($allowed) {
                        expect_status($res['put'], 200, 'PUT');
                        expect_status($res['post'], 201, 'POST назначения');
                        expect_status($res['putA'], 200, 'PUT назначения');
                        eq(unwrap($res['putA'], 'assignment')['end_at'], at($d, '09:30'), 'end_at после PUT');
                        expect_status($res['del'], 200, 'DELETE назначения');
                        expect_status($res['status'], 200, 'status');
                        eq(getReq($req['id'])['status'], 'cancelled', 'итоговый статус');
                    } else {
                        foreach ($res as $k => $r) { expect_err($r, 403, 'forbidden', $k); }
                        $after = getReq($req['id']);
                        eq($after['title'], $req['title'], 'title не менялся');
                        eq($after['status'], 'assigned', 'статус не менялся');
                        eq($after['version'], $cur['version'], 'версия не менялась');
                        eq(ids($after['assignments']), [$a0['id']], 'назначения не менялись');
                        eq(cleanState(), $s0, 'БД/журнал не тронуты');
                    }
                    return 'ok';
                });
        }
    }
    foreach (['admin', 'z0', 'z1'] as $owner) {
        $run("P10-$owner can_edit в GET ?id=: заявка автора $owner — admin/zone0/zone1/viewer = " . json_encode([true, $can('z0', $owner), $can('z1', $owner), false]), function () use ($owner, $can) {
            $req = mkReq($owner);
            foreach (['admin', 'z0', 'z1', 'view'] as $who) {
                $g = getReq($req['id'], $who);
                ok(array_key_exists('can_edit', $g), $who . ': нет can_edit');
                eq($g['can_edit'], $can($who, $owner), 'can_edit для ' . $who);
            }
            return 'ok';
        });
    }
    $run('P11 can_edit в элементах списка GET (from/to по дню назначения): значения совпадают с таблицей прав для всех ролей', function () use ($can) {
        $d = day();
        $reqs = [];
        foreach (['admin', 'z0', 'z1'] as $o) {
            $q = mkReq($o);
            mkAsg($q['id'], veh(), drv(), at($d, '09:00'));
            $reqs[$o] = $q['id'];
        }
        foreach (['admin', 'z0', 'z1', 'view'] as $who) {
            $r = rq($who, 'GET', 'from=' . $d . '&to=' . $d);
            expect_status($r, 200, 'GET list ' . $who);
            $byId = [];
            foreach (listOf($r, 'requests') as $it) { $byId[(string) $it['id']] = $it; }
            foreach ($reqs as $o => $id) {
                ok(isset($byId[$id]), $who . ': нет заявки ' . $o . ' в списке за день назначения');
                eq($byId[$id]['can_edit'] ?? null, $can($who, $o), $who . ' → заявка ' . $o);
            }
        }
        return 'ok';
    });
    $run('P12 viewer: dry_run назначения → 403 (проверка записи раньше предупреждений), ничего не пишется', function () {
        $req = mkReq('admin');
        $p = payload($req['id'], veh(), drv(), at(day(), '09:00'));
        $s0 = cleanState();
        expect_err(dryAsg('view', $p), 403, 'forbidden', 'dry_run viewer');
        eq(cleanState(), $s0, 'состояние');
        return 'ok';
    });
    foreach (['z0', 'z1', 'view'] as $who) {
        $run("P13-$who справочники: $who → 403 на POST base/vehicle/pool, PUT vehicle, DELETE pool; БД не меняется", function () use ($who) {
            $b = fx()['baseA'];
            $vid = veh();
            $e = emp('Кандидат');
            $v0 = (int) scalar('SELECT COUNT(*) FROM vehicles');
            $b0 = (int) scalar('SELECT COUNT(*) FROM transport_bases');
            $p0 = (int) scalar('SELECT COUNT(*) FROM transport_driver_pool');
            $j0 = jcount();
            expect_err(vhc($who, 'POST', 'entity=base', ['name' => 'Чужая-база-' . $who]), 403, 'forbidden', 'POST base');
            expect_err(vhc($who, 'POST', 'entity=vehicle', ['name' => 'х', 'plate' => 'Х999ХХ86', 'base_id' => $b]), 403, 'forbidden', 'POST vehicle');
            expect_err(vhc($who, 'POST', 'entity=pool', ['employee_id' => $e]), 403, 'forbidden', 'POST pool');
            expect_err(vhc($who, 'PUT', 'entity=vehicle&id=' . $vid, ['name' => 'Переименование', 'version' => 1]), 403, 'forbidden', 'PUT vehicle');
            expect_err(vhc($who, 'DELETE', 'entity=pool&id=' . $e), 403, 'forbidden', 'DELETE pool');
            eq([(int) scalar('SELECT COUNT(*) FROM vehicles'), (int) scalar('SELECT COUNT(*) FROM transport_bases'),
                (int) scalar('SELECT COUNT(*) FROM transport_driver_pool'), jcount()], [$v0, $b0, $p0, $j0], 'справочники/журнал без изменений');
            return 'ok';
        });
    }
    $run('P13-anon справочники: аноним → 401 на GET/POST/PUT/DELETE и action=move', function () {
        $vid = veh();
        expect_err(vhc('anon', 'GET'), 401, 'unauthorized', 'GET');
        expect_err(vhc('anon', 'POST', 'entity=base', ['name' => 'А']), 401, 'unauthorized', 'POST base');
        expect_err(vhc('anon', 'PUT', 'entity=vehicle&id=' . $vid, ['version' => 1]), 401, 'unauthorized', 'PUT');
        expect_err(vhc('anon', 'DELETE', 'entity=pool&id=tx_none'), 401, 'unauthorized', 'DELETE');
        expect_err(vhc('anon', 'POST', 'action=move&id=' . $vid, ['base_id' => fx()['baseB'], 'version' => 1]), 401, 'unauthorized', 'move');
        return 'ok';
    });
    foreach (['admin', 'view'] as $who) {
        $run("P14-$who перенос ТС: $who → 200, база сменилась навсегда (GET и БД), версия выросла; назначение на ТС не изменилось", function () use ($who) {
            $f = fx();
            $vid = veh();
            $req = mkReq('admin');
            $a = mkAsg($req['id'], $vid, drv(), at(day(), '09:00'));
            $cur = null;
            foreach (vhc('admin', 'GET')['json']['vehicles'] as $v) { if ($v['id'] === $vid) { $cur = $v; } }
            ok($cur !== null, 'ТС не найдено');
            $r = vhc($who, 'POST', 'action=move&id=' . $vid, ['base_id' => $f['baseB'], 'version' => $cur['version']]);
            expect_status($r, 200, 'move');
            eq($r['json']['vehicle']['base_id'], $f['baseB'], 'base_id в ответе');
            eq(scalar('SELECT base_id FROM vehicles WHERE id = :i', [':i' => $vid]), $f['baseB'], 'base_id в БД');
            ok($r['json']['vehicle']['version'] > $cur['version'], 'версия не выросла');
            $g = getReq($req['id']);
            eq($g['assignments'][0]['vehicle_id'], $vid, 'назначение по-прежнему на этом ТС');
            eq($g['assignments'][0]['start_at'], $a['start_at'], 'назначение не менялось');
            return 'ok';
        });
    }
    foreach (['z0', 'z1'] as $who) {
        $run("P14-$who перенос ТС: supervisor ($who) → 403, база не меняется", function () use ($who) {
            $f = fx();
            $vid = veh();
            $j0 = jcount();
            expect_err(vhc($who, 'POST', 'action=move&id=' . $vid, ['base_id' => $f['baseB'], 'version' => 1]), 403, 'forbidden', 'move');
            eq(scalar('SELECT base_id FROM vehicles WHERE id = :i', [':i' => $vid]), $f['baseA'], 'base_id не менялся');
            eq(jcount(), $j0, 'журнал не растёт');
            return 'ok';
        });
    }

    // =====================================================================
    // R — заявки
    // =====================================================================
    $run('R1 создание: минимальное тело {title} → 201; статус new, версия ≥ 1, id «tr_…», пустые необязательные поля, нет назначений, can_edit=true', function () {
        $r = rq('admin', 'POST', '', ['title' => 'Минимальная заявка']);
        expect_status($r, 201, 'POST');
        $q = unwrap($r, 'request');
        ok(str_starts_with((string) $q['id'], 'tr_'), 'id не «tr_…»: ' . $q['id']);
        eq($q['title'], 'Минимальная заявка', 'title');
        eq($q['status'], 'new', 'status');
        ok(is_int($q['version']) && $q['version'] >= 1, 'version');
        eq($q['assignments'], [], 'assignments');
        eq($q['can_edit'], true, 'can_edit');
        ok(array_key_exists('external_id', $q) && $q['external_id'] === null, 'external_id = null');
        foreach (['subscriber', 'address', 'comment'] as $k) { ok(in_array($q[$k] ?? null, [null, ''], true), $k . ' пуст'); }
        ok(is_string($q['created_by_name']) && $q['created_by_name'] !== '', 'created_by_name');
        return $q['id'];
    });
    $run('R2 создание: все поля (subscriber/address/comment/source) сохраняются и читаются GET ?id=', function () {
        $r = rq('z1', 'POST', '', ['title' => 'Полная', 'subscriber' => 'Абонент-тест-1', 'address' => 'Тестпункт-А, ул. Проверочная, 1', 'comment' => 'Комментарий проверки', 'source' => 'manual']);
        expect_status($r, 201, 'POST');
        $g = getReq(unwrap($r, 'request')['id']);
        eq([$g['title'], $g['subscriber'], $g['address'], $g['comment'], $g['source']],
            ['Полная', 'Абонент-тест-1', 'Тестпункт-А, ул. Проверочная, 1', 'Комментарий проверки', 'manual'], 'поля');
        return 'ok';
    });
    $run('R3 создание: title обязателен — пустое / пробелы / отсутствует → 422, заявка не создаётся', function () {
        $n = (int) scalar('SELECT COUNT(*) FROM transport_requests');
        foreach ([[], ['title' => ''], ['title' => '   '], ['title' => null]] as $i => $body) {
            $r = rq('admin', 'POST', '', $body);
            ok($r['status'] === 422 && is_string($r['json']['error'] ?? null), 'случай ' . $i . ': ожидался 422 с error; ' . diag($r));
        }
        eq((int) scalar('SELECT COUNT(*) FROM transport_requests'), $n, 'число заявок');
        return 'ok';
    });
    $run('R4 created_by: берётся из сессии, а не из тела (подмена created_by/status/id в POST игнорируется или отклоняется)', function () {
        $r = rq('z0', 'POST', '', ['title' => 'Подмена', 'created_by' => Ctx::$uid['admin'], 'status' => 'done', 'display_no' => 'ZZ', 'id' => 'tr_forged']);
        if ($r['status'] === 201) {
            $q = unwrap($r, 'request');
            eq($q['created_by'], Ctx::$uid['supervisor_zone0'], 'created_by');
            eq($q['status'], 'new', 'status');
            ok($q['id'] !== 'tr_forged', 'id не должен приниматься от клиента');
            ok($q['display_no'] !== 'ZZ', 'display_no не должен приниматься от клиента');
        } else {
            expect_err($r, 422, [(string) ($r['json']['error'] ?? '')], 'отказ');
        }
        eq((int) scalar("SELECT COUNT(*) FROM transport_requests WHERE id = 'tr_forged'"), 0, 'forged id не в БД');
        return 'ok';
    });
    $run('R5 display_no: у каждой заявки непустой и уникальный, правка заявки его не меняет', function () {
        $a = mkReq('admin'); $b = mkReq('z0'); $c = mkReq('z1');
        $nos = [(string) $a['display_no'], (string) $b['display_no'], (string) $c['display_no']];
        foreach ($nos as $n) { ok($n !== '', 'display_no пуст'); }
        eq(count(array_unique($nos)), 3, 'уникальность ' . json_encode($nos));
        $r = rq('admin', 'PUT', 'id=' . $a['id'], ['title' => 'Другое название', 'version' => $a['version']]);
        expect_status($r, 200, 'PUT');
        eq((string) getReq($a['id'])['display_no'], $nos[0], 'display_no после правки');
        return json_encode($nos, JSON_UNESCAPED_UNICODE);
    });
    $run('R6 правка PUT: поля заявки меняются, версия растёт, created_by/display_no/id неизменны, GET показывает новое', function () {
        $q = mkReq('admin', ['subscriber' => 'Абонент-до']);
        $r = rq('admin', 'PUT', 'id=' . $q['id'], ['title' => 'Название-после', 'subscriber' => 'Абонент-после', 'address' => 'Адрес-после', 'comment' => 'Комм-после', 'version' => $q['version']]);
        expect_status($r, 200, 'PUT');
        $u = unwrap($r, 'request');
        ok($u['version'] > $q['version'], 'версия не выросла');
        $g = getReq($q['id']);
        eq([$g['title'], $g['subscriber'], $g['address'], $g['comment']], ['Название-после', 'Абонент-после', 'Адрес-после', 'Комм-после'], 'поля');
        eq([$g['created_by'], $g['display_no'], $g['status']], [$q['created_by'], $q['display_no'], 'new'], 'неизменяемые поля');
        return 'v' . $q['version'] . '→' . $g['version'];
    });
    $run('R7 PUT без version → 422 version_required, заявка не меняется', function () {
        $q = mkReq('admin');
        expect_err(rq('admin', 'PUT', 'id=' . $q['id'], ['title' => 'Без версии']), 422, 'version_required', 'PUT');
        eq(getReq($q['id'])['title'], $q['title'], 'title');
        return 'ok';
    });
    $run('R8 VERSION_CONFLICT: PUT с устаревшей версией → 409, в теле current_version, данные не меняются', function () {
        $q = mkReq('admin');
        expect_status(rq('admin', 'PUT', 'id=' . $q['id'], ['title' => 'Первая правка', 'version' => $q['version']]), 200, 'правка 1');
        $cur = getReq($q['id']);
        $r = rq('admin', 'PUT', 'id=' . $q['id'], ['title' => 'Вторая на старой версии', 'version' => $q['version']]);
        expect_err($r, 409, 'VERSION_CONFLICT', 'PUT stale');
        eq($r['json']['current_version'], $cur['version'], 'current_version');
        eq(getReq($q['id'])['title'], 'Первая правка', 'данные первой правки сохранены');
        return 'ok';
    });
    $run('R9 VERSION_CONFLICT на смене статуса: устаревшая версия → 409, статус не меняется', function () {
        $q = mkReq('admin');
        expect_status(rq('admin', 'PUT', 'id=' . $q['id'], ['title' => 'Сдвиг версии', 'version' => $q['version']]), 200, 'правка');
        $r = rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => 'cancelled', 'version' => $q['version']]);
        expect_err($r, 409, 'VERSION_CONFLICT', 'status stale');
        eq(getReq($q['id'])['status'], 'new', 'статус');
        return 'ok';
    });
    $run('R10 PUT не меняет created_by / display_no / status через тело (подмена игнорируется или 422)', function () {
        $q = mkReq('z1');
        $r = rq('z1', 'PUT', 'id=' . $q['id'], ['title' => 'Подмена-PUT', 'created_by' => Ctx::$uid['admin'], 'display_no' => 'ZZ-9', 'status' => 'done', 'version' => $q['version']]);
        ok(in_array($r['status'], [200, 422], true), 'ожидался 200 или 422; ' . diag($r));
        $g = getReq($q['id']);
        eq([$g['created_by'], $g['display_no'], $g['status']], [$q['created_by'], $q['display_no'], 'new'], 'неизменяемые поля');
        return 'HTTP ' . $r['status'];
    });
    $run('R11 несуществующая заявка: GET / PUT / status → 404 not_found', function () {
        expect_err(rq('admin', 'GET', 'id=tr_nonexistent'), 404, 'not_found', 'GET');
        expect_err(rq('admin', 'PUT', 'id=tr_nonexistent', ['title' => 'x', 'version' => 1]), 404, 'not_found', 'PUT');
        expect_err(rq('admin', 'PUT', 'id=tr_nonexistent&action=status', ['status' => 'cancelled', 'version' => 1]), 404, 'not_found', 'status');
        return 'ok';
    });
    $run('R12 DELETE заявки не поддержан: admin → 405, заявка осталась (отмена — статусом cancelled)', function () {
        $q = mkReq('admin');
        $r = rq('admin', 'DELETE', 'id=' . $q['id']);
        eq($r['status'], 405, 'status; ' . diag($r));
        eq(getReq($q['id'])['status'], 'new', 'заявка на месте');
        return 'ok';
    });
    $run('R13 DELETE заявки → 405 и для автора-supervisor (даже своей), заявка осталась', function () {
        $q = mkReq('z0');
        $r = rq('z0', 'DELETE', 'id=' . $q['id']);
        eq($r['status'], 405, 'status; ' . diag($r));
        eq((int) scalar('SELECT COUNT(*) FROM transport_requests WHERE id = :i', [':i' => $q['id']]), 1, 'заявка в БД');
        return 'ok';
    });
    $run('R14 отмена статусом: new → cancelled (200), версия выросла, заявка читается и не удалена', function () {
        $q = mkReq('admin');
        $r = rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => 'cancelled', 'version' => $q['version']]);
        expect_status($r, 200, 'status');
        $g = getReq($q['id']);
        eq($g['status'], 'cancelled', 'status');
        ok($g['version'] > $q['version'], 'версия');
        return 'ok';
    });
    $run('R15 возврат: cancelled → new (200)', function () {
        $q = mkReq('admin');
        expect_status(rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => 'cancelled', 'version' => $q['version']]), 200, 'отмена');
        $c = getReq($q['id']);
        expect_status(rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => 'new', 'version' => $c['version']]), 200, 'возврат');
        eq(getReq($q['id'])['status'], 'new', 'status');
        return 'ok';
    });
    $run('R16 цепочка переходов с назначением: assigned → in_progress → done → new (возврат done → new)', function () {
        $q = mkReq('z0');
        mkAsg($q['id'], veh(), drv(), at(day(), '09:00'), 60, [], 'z0');
        eq(getReq($q['id'])['status'], 'assigned', 'после назначения');
        foreach (['in_progress', 'done', 'new'] as $st) {
            $c = getReq($q['id']);
            expect_status(rq('z0', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => $st, 'version' => $c['version']]), 200, '→ ' . $st);
            eq(getReq($q['id'])['status'], $st, 'status = ' . $st);
        }
        return 'ok';
    });
    $run('R17 invalid_transition: вручную new → assigned нельзя (только автоматически при появлении назначения) → 422, статус не меняется', function () {
        $q = mkReq('admin');
        expect_err(rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => 'assigned', 'version' => $q['version']]), 422, 'invalid_transition', 'new→assigned');
        $g = getReq($q['id']);
        eq([$g['status'], $g['version']], ['new', $q['version']], 'без изменений');
        return 'ok';
    });
    $run('R18 invalid_transition: из cancelled нельзя в in_progress и в done (только возврат в new) → 422', function () {
        $q = mkReq('admin');
        expect_status(rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => 'cancelled', 'version' => $q['version']]), 200, 'отмена');
        foreach (['in_progress', 'done'] as $st) {
            $c = getReq($q['id']);
            expect_err(rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => $st, 'version' => $c['version']]), 422, 'invalid_transition', 'cancelled→' . $st);
        }
        eq(getReq($q['id'])['status'], 'cancelled', 'статус');
        return 'ok';
    });
    $run('R19 неизвестный статус и отсутствие status → 422, статус не меняется', function () {
        $q = mkReq('admin');
        foreach ([['status' => 'bogus', 'version' => $q['version']], ['version' => $q['version']], ['status' => '', 'version' => $q['version']]] as $i => $b) {
            $r = rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', $b);
            ok($r['status'] === 422 && is_string($r['json']['error'] ?? null), 'случай ' . $i . ': ожидался 422; ' . diag($r));
        }
        eq(getReq($q['id'])['status'], 'new', 'статус');
        return 'ok';
    });
    $run('R20 список: фильтр status — new и cancelled разделяются, без from/to', function () {
        $n = mkReq('admin');
        $c = mkReq('admin');
        expect_status(rq('admin', 'PUT', 'id=' . $c['id'] . '&action=status', ['status' => 'cancelled', 'version' => $c['version']]), 200, 'отмена');
        $ln = ids(listOf(rq('admin', 'GET', 'status=new'), 'requests'));
        $lc = ids(listOf(rq('admin', 'GET', 'status=cancelled'), 'requests'));
        ok(in_array($n['id'], $ln, true) && !in_array($c['id'], $ln, true), 'status=new');
        ok(in_array($c['id'], $lc, true) && !in_array($n['id'], $lc, true), 'status=cancelled');
        return 'ok';
    });
    $run('R21 список: from/to по дню назначения — заявка с назначением в диапазоне есть, вне диапазона нет; в элементе assignments', function () {
        $d = day();
        $q = mkReq('admin');
        $a = mkAsg($q['id'], veh(), drv(), at($d, '09:00'));
        $in = listOf(rq('admin', 'GET', 'from=' . $d . '&to=' . $d), 'requests');
        ok(in_array($q['id'], ids($in), true), 'заявка не найдена в диапазоне её дня');
        foreach ($in as $it) { if ($it['id'] === $q['id']) { eq(ids($it['assignments']), [$a['id']], 'assignments в элементе списка'); } }
        $out = listOf(rq('admin', 'GET', 'from=' . addDays($d, -30) . '&to=' . addDays($d, -10)), 'requests');
        ok(!in_array($q['id'], ids($out), true), 'заявка не должна попадать в диапазон до её дня');
        return 'ok';
    });

    // =====================================================================
    // A — назначения
    // =====================================================================
    $run('A1 создание → 201 {success, assignment}: id «ta_…», поля, end_at = start + duration, версия, маршрут из 2 точек', function () {
        $q = mkReq('admin');
        $vid = veh(); $did = drv(); $d = day();
        $r = asg('admin', 'POST', '', payload($q['id'], $vid, $did, at($d, '09:00'), 90));
        expect_status($r, 201, 'POST');
        $a = unwrap($r, 'assignment');
        ok(str_starts_with((string) $a['id'], 'ta_'), 'id не «ta_…»');
        eq([$a['request_id'], $a['vehicle_id'], $a['driver_id'], $a['start_at'], $a['duration_min'], $a['end_at']],
            [$q['id'], $vid, $did, at($d, '09:00'), 90, at($d, '10:30')], 'поля');
        ok(is_int($a['version']) && $a['version'] >= 1, 'version');
        eq(array_map(static fn($s) => [$s['ord'], $s['kind'], $s['stay_min'], $s['leg_min']], $a['stops']), [[1, 'departure', 0, 0], [2, 'arrival', 0, 90]], 'stops');
        return $a['id'];
    });
    $run('A2 автоматически new → assigned при появлении первого назначения; назначение видно во вложенных assignments заявки', function () {
        $q = mkReq('z1');
        eq($q['status'], 'new', 'до');
        $a = mkAsg($q['id'], veh(), drv(), at(day(), '09:00'), 60, [], 'z1');
        $g = getReq($q['id']);
        eq($g['status'], 'assigned', 'после');
        eq(ids($g['assignments']), [$a['id']], 'assignments');
        eq([$g['assignments'][0]['vehicle_id'], $g['assignments'][0]['end_at']], [$a['vehicle_id'], $a['end_at']], 'поля вложенного назначения');
        return 'ok';
    });
    $run('A3 end_at: 09:00 + 15 / 60 / 90 / 480 минут = 09:15 / 10:00 / 10:30 / 17:00', function () {
        $d = day();
        foreach ([15 => '09:15', 60 => '10:00', 90 => '10:30', 480 => '17:00'] as $dur => $end) {
            $q = mkReq('admin');
            $a = mkAsg($q['id'], veh(), drv(), at($d, '09:00'), $dur);
            eq($a['end_at'], at($d, $end), 'end_at для ' . $dur);
        }
        return 'ok';
    });
    $run('A4 переход через полночь: 22:30 + 120 мин → end_at 00:30 следующего дня; 22:00 + 120 → ровно 00:00 следующего дня', function () {
        $d = day();
        $q = mkReq('admin');
        $a = mkAsg($q['id'], veh(), drv(), at($d, '22:30'), 120);
        eq($a['end_at'], at(addDays($d, 1), '00:30'), 'end_at (22:30+120)');
        $b = mkAsg($q['id'], veh(), drv(), at($d, '22:00'), 120);
        eq($b['end_at'], at(addDays($d, 1), '00:00'), 'end_at (22:00+120)');
        eq(getReq($q['id'])['assignments'][0]['end_at'], $a['end_at'], 'GET заявки отдаёт тот же end_at');
        return 'ok';
    });
    $run('A5 длительность до 7 суток: 1440 мин → +1 день; 10080 мин (максимум) принимается → +7 суток', function () {
        $d = day();
        $q = mkReq('admin');
        eq(mkAsg($q['id'], veh(), drv(), at($d, '06:15'), 1440)['end_at'], at(addDays($d, 1), '06:15'), '1440');
        eq(mkAsg($q['id'], veh(), drv(), at($d, '06:15'), 10080)['end_at'], at(addDays($d, 7), '06:15'), '10080');
        return 'ok';
    });
    $run('A6 PUT пересчитывает end_at при смене длительности; версия растёт; запись в БД обновлена', function () {
        $q = mkReq('admin');
        $vid = veh(); $did = drv(); $d = day();
        $a = mkAsg($q['id'], $vid, $did, at($d, '09:00'), 60);
        $r = asg('admin', 'PUT', 'id=' . $a['id'], payload($q['id'], $vid, $did, at($d, '09:00'), 135) + ['version' => $a['version']]);
        expect_status($r, 200, 'PUT');
        $u = unwrap($r, 'assignment');
        eq([$u['duration_min'], $u['end_at']], [135, at($d, '11:15')], 'ответ');
        ok($u['version'] > $a['version'], 'версия');
        eq(scalar('SELECT end_at FROM transport_assignments WHERE id = :i', [':i' => $a['id']]), at($d, '11:15'), 'end_at в БД');
        return 'ok';
    });
    $run('A7 PUT пересчитывает end_at при смене начала (в т.ч. перенос через полночь)', function () {
        $q = mkReq('admin');
        $vid = veh(); $did = drv(); $d = day();
        $a = mkAsg($q['id'], $vid, $did, at($d, '09:00'), 60);
        $r = asg('admin', 'PUT', 'id=' . $a['id'], payload($q['id'], $vid, $did, at($d, '23:15'), 60) + ['version' => $a['version']]);
        expect_status($r, 200, 'PUT');
        eq(unwrap($r, 'assignment')['end_at'], at(addDays($d, 1), '00:15'), 'end_at');
        return 'ok';
    });
    $run('A8 PUT без version → 422 version_required; устаревшая версия → 409 VERSION_CONFLICT с current_version; данные не меняются', function () {
        $q = mkReq('admin');
        $vid = veh(); $did = drv(); $d = day();
        $a = mkAsg($q['id'], $vid, $did, at($d, '09:00'), 60);
        expect_err(asg('admin', 'PUT', 'id=' . $a['id'], payload($q['id'], $vid, $did, at($d, '09:00'), 90)), 422, 'version_required', 'без version');
        $u = unwrap(asg('admin', 'PUT', 'id=' . $a['id'], payload($q['id'], $vid, $did, at($d, '09:00'), 75 + 15) + ['version' => $a['version']]), 'assignment');
        $r = asg('admin', 'PUT', 'id=' . $a['id'], payload($q['id'], $vid, $did, at($d, '09:00'), 120) + ['version' => $a['version']]);
        expect_err($r, 409, 'VERSION_CONFLICT', 'stale');
        eq($r['json']['current_version'], $u['version'], 'current_version');
        eq((int) scalar('SELECT duration_min FROM transport_assignments WHERE id = :i', [':i' => $a['id']]), 90, 'данные не менялись');
        return 'ok';
    });
    $run('A9 PUT меняет ТС, водителя, бригаду и маршрут; GET заявки показывает новое, прежние строки маршрута/бригады заменены', function () {
        $q = mkReq('admin');
        $v1 = veh(); $v2 = veh(); $d1 = drv(); $d2 = drv(); $c1 = emp('Бригадир'); $c2 = emp('Помощник'); $d = day();
        $a = mkAsg($q['id'], $v1, $d1, at($d, '09:00'), 60, ['crew' => [$c1]]);
        $stops = [
            ['ord' => 1, 'kind' => 'departure', 'place' => 'Тестпункт-А', 'stay_min' => 15, 'leg_min' => 0],
            ['ord' => 2, 'kind' => 'intermediate', 'place' => 'Тестпункт-В', 'stay_min' => 15, 'leg_min' => 30],
            ['ord' => 3, 'kind' => 'arrival', 'place' => 'Тестпункт-Б', 'stay_min' => 0, 'leg_min' => 0],
        ];
        $r = asg('admin', 'PUT', 'id=' . $a['id'], payload($q['id'], $v2, $d2, at($d, '09:00'), 60, ['crew' => [$c2], 'stops' => $stops]) + ['version' => $a['version']]);
        expect_status($r, 200, 'PUT');
        $g = getReq($q['id'])['assignments'][0];
        eq([$g['vehicle_id'], $g['driver_id'], crewIds($g)], [$v2, $d2, [$c2]], 'ТС/водитель/бригада');
        eq(array_map(static fn($s) => $s['kind'], $g['stops']), ['departure', 'intermediate', 'arrival'], 'маршрут');
        eq((int) scalar('SELECT COUNT(*) FROM assignment_crew WHERE assignment_id = :i', [':i' => $a['id']]), 1, 'строки бригады в БД');
        eq((int) scalar('SELECT COUNT(*) FROM assignment_stops WHERE assignment_id = :i', [':i' => $a['id']]), 3, 'строки маршрута в БД');
        return 'ok';
    });
    $run('A10 маршрут сохраняется целиком: координаты, leg_km, стоянки и время в пути читаются обратно', function () {
        $q = mkReq('admin');
        $stops = [
            ['ord' => 1, 'kind' => 'departure', 'place' => 'Тестпункт-А', 'lat' => 60.1234, 'lon' => 64.5678, 'stay_min' => 15, 'leg_min' => 0],
            ['ord' => 2, 'kind' => 'intermediate', 'place' => 'Тестпункт-В', 'lat' => 60.5, 'lon' => 64.9, 'stay_min' => 30, 'leg_km' => 12.5, 'leg_min_map' => 30, 'leg_min' => 30],
            ['ord' => 3, 'kind' => 'arrival', 'place' => 'Тестпункт-Б', 'stay_min' => 0, 'leg_km' => 40.0, 'leg_min_map' => 45, 'leg_min' => 45],
        ];
        $a = mkAsg($q['id'], veh(), drv(), at(day(), '08:00'), 120, ['stops' => $stops]);
        $g = getReq($q['id'])['assignments'][0];
        eq(count($g['stops']), 3, 'число точек');
        eq([$g['stops'][1]['place'], $g['stops'][1]['stay_min'], $g['stops'][1]['leg_min']], ['Тестпункт-В', 30, 30], 'промежуточная');
        ok(abs((float) $g['stops'][0]['lat'] - 60.1234) < 1e-6 && abs((float) $g['stops'][0]['lon'] - 64.5678) < 1e-6, 'lat/lon');
        ok(abs((float) $g['stops'][1]['leg_km'] - 12.5) < 1e-6, 'leg_km');
        eq($g['stops'][2]['kind'], 'arrival', 'приезд');
        return $a['id'];
    });
    $run('A11 мультиТС: несколько назначений одной заявки на разные ТС/водителей в одно время — 201 без предупреждений, статус остаётся assigned', function () {
        $q = mkReq('z0');
        $d = day();
        $a1 = mkAsg($q['id'], veh(), drv(), at($d, '09:00'), 60, [], 'z0');
        $dry = dryAsg('z0', payload($q['id'], veh(), drv(), at($d, '09:00'), 60));
        expect_status($dry, 200, 'dry_run второго ТС');
        eq(wcodes($dry), [], 'предупреждений нет');
        $a2 = mkAsg($q['id'], veh(), drv(), at($d, '09:00'), 60, [], 'z0');
        $g = getReq($q['id']);
        eq($g['status'], 'assigned', 'статус');
        $got = ids($g['assignments']); sort($got);
        $exp = [$a1['id'], $a2['id']]; sort($exp);
        eq($got, $exp, 'оба назначения');
        return 'ok';
    });
    $run('A12 удаление: у заявки два назначения — удаление одного оставляет assigned, удаление последнего возвращает new', function () {
        $q = mkReq('admin');
        $d = day();
        $a1 = mkAsg($q['id'], veh(), drv(), at($d, '09:00'));
        $a2 = mkAsg($q['id'], veh(), drv(), at($d, '11:00'));
        expect_status(asg('admin', 'DELETE', 'id=' . $a1['id']), 200, 'DELETE 1');
        $g = getReq($q['id']);
        eq([$g['status'], ids($g['assignments'])], ['assigned', [$a2['id']]], 'после первого');
        expect_status(asg('admin', 'DELETE', 'id=' . $a2['id']), 200, 'DELETE 2');
        $g = getReq($q['id']);
        eq([$g['status'], $g['assignments']], ['new', []], 'после последнего');
        return 'ok';
    });
    $run('A13 удаление назначения убирает его строки бригады и маршрута (assignment_crew / assignment_stops) и саму запись', function () {
        $q = mkReq('admin');
        $a = mkAsg($q['id'], veh(), drv(), at(day(), '09:00'), 60, ['crew' => [emp('Бригадир'), emp('Помощник')]]);
        eq((int) scalar('SELECT COUNT(*) FROM assignment_crew WHERE assignment_id = :i', [':i' => $a['id']]), 2, 'бригада до');
        expect_status(asg('admin', 'DELETE', 'id=' . $a['id']), 200, 'DELETE');
        foreach (['transport_assignments' => 'id', 'assignment_crew' => 'assignment_id', 'assignment_stops' => 'assignment_id'] as $t => $col) {
            eq((int) scalar("SELECT COUNT(*) FROM $t WHERE $col = :i", [':i' => $a['id']]), 0, 'остатки в ' . $t);
        }
        return 'ok';
    });
    $run('A14 несуществующее назначение: PUT и DELETE → 404 not_found; несуществующая заявка при POST → 404 not_found', function () {
        $q = mkReq('admin');
        expect_err(asg('admin', 'PUT', 'id=ta_nonexistent', payload($q['id'], veh(), drv(), at(day(), '09:00')) + ['version' => 1]), 404, 'not_found', 'PUT');
        expect_err(asg('admin', 'DELETE', 'id=ta_nonexistent'), 404, 'not_found', 'DELETE');
        expect_err(asg('admin', 'POST', '', payload('tr_nonexistent', veh(), drv(), at(day(), '09:00'))), 404, 'not_found', 'POST');
        return 'ok';
    });
    $run('A15 request_closed: назначение на done и на cancelled заявку → 422, ничего не создаётся; dry_run — тоже 422', function () {
        $d = day();
        foreach (['done', 'cancelled'] as $final) {
            $q = mkReq('admin');
            if ($final === 'done') {
                mkAsg($q['id'], veh(), drv(), at($d, '08:00'));
                foreach (['in_progress', 'done'] as $st) {
                    expect_status(rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => $st, 'version' => getReq($q['id'])['version']]), 200, '→ ' . $st);
                }
            } else {
                expect_status(rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => 'cancelled', 'version' => $q['version']]), 200, 'отмена');
            }
            $n = asgCount($q['id']);
            $p = payload($q['id'], veh(), drv(), at($d, '12:00'));
            expect_err(asg('admin', 'POST', '', $p), 422, 'request_closed', $final . ' POST');
            expect_err(dryAsg('admin', $p), 422, 'request_closed', $final . ' dry_run');
            eq(asgCount($q['id']), $n, $final . ': число назначений');
        }
        return 'ok';
    });
    $run('A16 после возврата cancelled → new назначение снова создаётся (заявка не «закрыта») и ставит assigned', function () {
        $q = mkReq('admin');
        expect_status(rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => 'cancelled', 'version' => $q['version']]), 200, 'отмена');
        expect_status(rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => 'new', 'version' => getReq($q['id'])['version']]), 200, 'возврат');
        mkAsg($q['id'], veh(), drv(), at(day(), '09:00'));
        eq(getReq($q['id'])['status'], 'assigned', 'статус');
        return 'ok';
    });
    $run('A17 неизвестное ТС → 422 unknown_vehicle; неизвестный сотрудник в бригаде → 422 unknown_employee; ничего не пишется', function () {
        $q = mkReq('admin');
        $d = day();
        $pUnk = payload($q['id'], 'tv_nonexistent', drv(), at($d, '09:00'));
        $pCrew = payload($q['id'], veh(), drv(), at($d, '09:00'), 60, ['crew' => ['tx_no_such_employee']]);
        $s0 = cleanState();
        expect_err(asg('admin', 'POST', '', $pUnk), 422, 'unknown_vehicle', 'ТС');
        expect_err(asg('admin', 'POST', '', $pCrew), 422, 'unknown_employee', 'бригада');
        eq(cleanState(), $s0, 'состояние');
        return 'ok';
    });

    // =====================================================================
    // D — водители и бригада
    // =====================================================================
    $run('D1 допустимый водитель: сотрудник группы «Транспорт» принимается (201)', function () {
        $q = mkReq('admin');
        $a = mkAsg($q['id'], veh(), $did = drv(), at(day(), '09:00'));
        eq($a['driver_id'], $did, 'driver_id');
        return 'ok';
    });
    $run('D2 допустимый водитель: совместитель из пула (transport_driver_pool), не состоящий в группе «Транспорт», принимается', function () {
        $q = mkReq('admin');
        $pid = poolDrv();
        $a = mkAsg($q['id'], veh(), $pid, at(day(), '09:00'));
        eq($a['driver_id'], $pid, 'driver_id');
        eq(scalar('SELECT group_id FROM employees WHERE id = :i', [':i' => $pid]), 'g1', 'совместитель не из группы Транспорт');
        return 'ok';
    });
    $run('D3 driver_not_allowed: сотрудник вне группы «Транспорт» и вне пула → 422, назначение не создаётся (и dry_run тоже 422)', function () {
        $q = mkReq('admin');
        $e = emp('Посторонний', 'g2');
        $p = payload($q['id'], veh(), $e, at(day(), '09:00'));
        $s0 = cleanState();
        expect_err(asg('admin', 'POST', '', $p), 422, 'driver_not_allowed', 'POST');
        expect_err(dryAsg('admin', $p), 422, 'driver_not_allowed', 'dry_run');
        eq(cleanState(), $s0, 'состояние');
        return 'ok';
    });
    $run('D4 неизвестный driver_id → 422 (driver_not_allowed или unknown_employee)', function () {
        $q = mkReq('admin');
        expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), 'tx_no_such_driver', at(day(), '09:00'))), 422, ['driver_not_allowed', 'unknown_employee'], 'POST');
        return 'ok';
    });
    $run('D5 удаление из пула: прежнее назначение остаётся, новое с этим водителем → 422 driver_not_allowed', function () {
        $pid = poolDrv();
        $q = mkReq('admin');
        $d = day();
        $a = mkAsg($q['id'], veh(), $pid, at($d, '09:00'));
        expect_status(vhc('admin', 'DELETE', 'entity=pool&id=' . $pid), 200, 'DELETE pool');
        expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), $pid, at($d, '14:00'))), 422, 'driver_not_allowed', 'после удаления из пула');
        eq(ids(getReq($q['id'])['assignments']), [$a['id']], 'прежнее назначение сохранено');
        return 'ok';
    });
    $run('D6 допустимость вычисляется на момент запроса: водитель переведён из группы «Транспорт» в другую группу → 422 driver_not_allowed', function () {
        $q = mkReq('admin');
        $e = drv();
        $d = day();
        mkAsg($q['id'], veh(), $e, at($d, '09:00'));
        Ctx::$pdo->prepare("UPDATE employees SET group_id = 'g3' WHERE id = :i")->execute([':i' => $e]);
        expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), $e, at($d, '14:00'))), 422, 'driver_not_allowed', 'после перевода');
        return 'ok';
    });
    $run('D7 driver_in_crew: водитель в составе бригады → 422 (POST, dry_run и PUT), ничего не пишется', function () {
        $q = mkReq('admin');
        $did = drv(); $vid = veh(); $d = day();
        $p = payload($q['id'], $vid, $did, at($d, '09:00'), 60, ['crew' => [emp('Бригадир'), $did]]);
        $s0 = cleanState();
        expect_err(asg('admin', 'POST', '', $p), 422, 'driver_in_crew', 'POST');
        expect_err(dryAsg('admin', $p), 422, 'driver_in_crew', 'dry_run');
        eq(cleanState(), $s0, 'состояние после POST/dry_run');
        $a = mkAsg($q['id'], $vid, $did, at($d, '09:00'));
        expect_err(asg('admin', 'PUT', 'id=' . $a['id'], $p + ['version' => $a['version']]), 422, 'driver_in_crew', 'PUT');
        eq(crewIds(getReq($q['id'])['assignments'][0]), [], 'бригада не изменилась');
        return 'ok';
    });
    $run('D8 бригада — любые сотрудники (разные группы, в т.ч. водитель группы «Транспорт» как рядовой член), состав читается обратно', function () {
        $q = mkReq('admin');
        $crew = [emp('Монтажник', 'g0'), emp('Инженер', 'g1'), emp('Диспетчер', 'g2'), emp('Энергетик', 'g5'), emp('Бригадир', 'g4'), drv()];
        $a = mkAsg($q['id'], veh(), drv(), at(day(), '09:00'), 60, ['crew' => $crew]);
        $exp = $crew; sort($exp);
        eq(crewIds($a), $exp, 'бригада в ответе POST');
        eq(crewIds(getReq($q['id'])['assignments'][0]), $exp, 'бригада в GET');
        return count($crew) . ' чел.';
    });
    $run('D9 пустая бригада допустима (только водитель)', function () {
        $q = mkReq('admin');
        $a = mkAsg($q['id'], veh(), drv(), at(day(), '09:00'), 60, ['crew' => []]);
        eq(crewIds($a), [], 'crew');
        return 'ok';
    });
    $run('D10 PUT: смена водителя на недопустимого → 422 driver_not_allowed, назначение не меняется', function () {
        $q = mkReq('admin');
        $vid = veh(); $did = drv(); $d = day();
        $a = mkAsg($q['id'], $vid, $did, at($d, '09:00'));
        expect_err(asg('admin', 'PUT', 'id=' . $a['id'], payload($q['id'], $vid, emp('Посторонний', 'g2'), at($d, '09:00')) + ['version' => $a['version']]), 422, 'driver_not_allowed', 'PUT');
        eq(getReq($q['id'])['assignments'][0]['driver_id'], $did, 'водитель');
        return 'ok';
    });
    $run('D11 согласованность GET drivers (T1) и приёмки в назначении: из списка — принимается, не из списка — 422', function () {
        $gid = drv(); $pid = poolDrv(); $other = emp('Посторонний', 'g4');
        $r = vhc('admin', 'GET');
        $drivers = [];
        foreach ($r['json']['drivers'] as $x) { $drivers[(string) $x['employee_id']] = $x; }
        ok(isset($drivers[$gid]) && $drivers[$gid]['source'] === 'group', 'водитель группы не в drivers');
        ok(isset($drivers[$pid]) && $drivers[$pid]['source'] === 'pool', 'совместитель не в drivers');
        ok(!isset($drivers[$other]), 'посторонний в drivers');
        ok(strpos($r['raw'], 'phone') === false && strpos($r['raw'], 'photo') === false, 'в drivers нет телефона/фото');
        $q = mkReq('admin'); $d = day();
        foreach ([$gid, $pid] as $i => $e) { mkAsg($q['id'], veh(), $e, at($d, sprintf('%02d:00', 8 + $i * 3))); }
        expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), $other, at($d, '20:00'))), 422, 'driver_not_allowed', 'посторонний');
        return 'ok';
    });

    // =====================================================================
    // S — шаг 15 минут и формат времени
    // =====================================================================
    $run('S1 start_at кратно 15 минутам: :00/:15/:30/:45 принимаются', function () {
        $d = day();
        foreach (['09:00', '09:15', '09:30', '09:45'] as $hm) {
            $q = mkReq('admin');
            eq(mkAsg($q['id'], veh(), drv(), at($d, $hm))['start_at'], at($d, $hm), 'start_at ' . $hm);
        }
        return 'ok';
    });
    $run('S2 invalid_start: минуты не кратны 15 (09:10, 09:05, 09:59) → 422, назначение не создаётся', function () {
        $q = mkReq('admin');
        $d = day();
        $vv = veh(); $dd = drv();
        $s0 = cleanState();
        foreach (['09:10', '09:05', '09:59'] as $hm) {
            expect_err(asg('admin', 'POST', '', payload($q['id'], $vv, $dd, at($d, $hm))), 422, 'invalid_start', $hm);
        }
        eq(cleanState(), $s0, 'состояние');
        return 'ok';
    });
    $run('S3 invalid_start: неверный формат — «abc», только дата, пустая строка, null, число → 422', function () {
        $q = mkReq('admin'); $d = day();
        foreach (['abc', $d, '', null, 12345] as $i => $bad) {
            expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), drv(), 'x', 60, ['start_at' => $bad])), 422, 'invalid_start', 'случай ' . $i);
        }
        $p = payload($q['id'], veh(), drv(), 'x'); unset($p['start_at']);
        expect_err(asg('admin', 'POST', '', $p), 422, 'invalid_start', 'start_at отсутствует');
        return 'ok';
    });
    $run('S4 invalid_start: несуществующие дата/время (30 февраля, 25:00, 24:15, месяц 13) → 422', function () {
        $q = mkReq('admin');
        foreach (['2032-02-30T09:00', '2032-01-05T25:00', '2032-01-05T24:15', '2032-13-05T09:00'] as $bad) {
            expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), drv(), $bad)), 422, 'invalid_start', $bad);
        }
        return 'ok';
    });
    $run('S5 длительность 15/30/45/60 принимается: end_at = start + длительность', function () {
        $d = day();
        foreach ([15 => '09:15', 30 => '09:30', 45 => '09:45', 60 => '10:00'] as $dur => $end) {
            $q = mkReq('admin');
            $a = mkAsg($q['id'], veh(), drv(), at($d, '09:00'), $dur);
            eq([$a['duration_min'], $a['end_at']], [$dur, at($d, $end)], 'длительность ' . $dur);
        }
        return 'ok';
    });
    $run('S6 invalid_duration: 10 / 20 / 44 (не кратно 15) → 422, ничего не пишется', function () {
        $q = mkReq('admin'); $d = day();
        $vv = veh(); $dd = drv();
        $s0 = cleanState();
        foreach ([10, 20, 44] as $bad) {
            expect_err(asg('admin', 'POST', '', payload($q['id'], $vv, $dd, at($d, '09:00'), $bad)), 422, 'invalid_duration', (string) $bad);
        }
        eq(cleanState(), $s0, 'состояние');
        return 'ok';
    });
    $run('S7 invalid_duration: 0, отрицательная, дробная, null, отсутствует → 422', function () {
        $q = mkReq('admin'); $d = day();
        foreach ([0, -15, 30.5, null] as $i => $bad) {
            expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), drv(), at($d, '09:00'), 60, ['duration_min' => $bad])), 422, 'invalid_duration', 'случай ' . $i);
        }
        $p = payload($q['id'], veh(), drv(), at($d, '09:00')); unset($p['duration_min']);
        expect_err(asg('admin', 'POST', '', $p), 422, 'invalid_duration', 'duration_min отсутствует');
        return 'ok';
    });
    $run('S8 invalid_duration: больше 7 суток (10095 — кратно 15, но > 10080) → 422', function () {
        $q = mkReq('admin');
        expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), drv(), at(day(), '09:00'), 10095)), 422, 'invalid_duration', '10095');
        return 'ok';
    });
    $run('S9 invalid_step: stay_min 10 / 20 / 44 в точке маршрута → 422', function () {
        $q = mkReq('admin'); $d = day();
        foreach ([10, 20, 44] as $bad) {
            $st = route(60); $st[0]['stay_min'] = $bad;
            expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), drv(), at($d, '09:00'), 60, ['stops' => $st])), 422, 'invalid_step', 'stay_min ' . $bad);
        }
        return 'ok';
    });
    $run('S10 invalid_step: leg_min 10 / 20 / 44 → 422', function () {
        $q = mkReq('admin'); $d = day();
        foreach ([10, 20, 44] as $bad) {
            $st = route(60); $st[1]['leg_min'] = $bad;
            expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), drv(), at($d, '09:00'), 60, ['stops' => $st])), 422, 'invalid_step', 'leg_min ' . $bad);
        }
        return 'ok';
    });
    $run('S11 invalid_step: отрицательные и нечисловые stay_min/leg_min (−15, 7.5, «х») → 422', function () {
        $q = mkReq('admin'); $d = day();
        foreach ([['stay_min', -15], ['leg_min', -15], ['stay_min', 7.5], ['leg_min', 'х']] as [$k, $bad]) {
            $st = route(60); $st[1][$k] = $bad;
            expect_err(asg('admin', 'POST', '', payload($q['id'], veh(), drv(), at($d, '09:00'), 60, ['stops' => $st])), 422, 'invalid_step', $k . '=' . json_encode($bad));
        }
        return 'ok';
    });
    $run('S12 stay_min и leg_min: 15 / 30 / 45 / 60 принимаются и читаются обратно (0 — в маршруте по умолчанию route())', function () {
        $q = mkReq('admin'); $d = day();
        foreach ([15, 30, 45, 60] as $v) {
            $st = [
                ['ord' => 1, 'kind' => 'departure', 'place' => 'Тестпункт-А', 'stay_min' => $v, 'leg_min' => 0],
                ['ord' => 2, 'kind' => 'arrival', 'place' => 'Тестпункт-Б', 'stay_min' => 0, 'leg_min' => $v],
            ];
            $a = mkAsg($q['id'], veh(), drv(), at($d, '09:00'), 2 * $v, ['stops' => $st]);
            eq([$a['stops'][0]['stay_min'], $a['stops'][1]['leg_min']], [$v, $v], 'значения ' . $v);
        }
        return 'ok';
    });
    $run('S13 PUT: invalid_start / invalid_duration / invalid_step → 422, назначение не меняется', function () {
        $q = mkReq('admin');
        $vid = veh(); $did = drv(); $d = day();
        $a = mkAsg($q['id'], $vid, $did, at($d, '09:00'), 60);
        $bad = route(60); $bad[1]['leg_min'] = 44;
        foreach ([['invalid_start', at($d, '09:10'), 60, null], ['invalid_duration', at($d, '09:00'), 44, null], ['invalid_step', at($d, '09:00'), 60, $bad]] as [$code, $start, $dur, $stops]) {
            $p = payload($q['id'], $vid, $did, $start, $dur) + ['version' => $a['version']];
            if ($stops !== null) { $p['stops'] = $stops; }
            expect_err(asg('admin', 'PUT', 'id=' . $a['id'], $p), 422, $code, $code);
        }
        $g = getReq($q['id'])['assignments'][0];
        eq([$g['start_at'], $g['duration_min'], $g['version']], [at($d, '09:00'), 60, $a['version']], 'без изменений');
        return 'ok';
    });
    $run('S14 ошибка шага во второй точке откатывает всё: нет назначения, строк маршрута/бригады, смены статуса и записи журнала', function () {
        $q = mkReq('admin');
        $st = [
            ['ord' => 1, 'kind' => 'departure', 'place' => 'Тестпункт-А', 'stay_min' => 15, 'leg_min' => 0],
            ['ord' => 2, 'kind' => 'intermediate', 'place' => 'Тестпункт-В', 'stay_min' => 15, 'leg_min' => 15],
            ['ord' => 3, 'kind' => 'arrival', 'place' => 'Тестпункт-Б', 'stay_min' => 0, 'leg_min' => 20],
        ];
        $pBad = payload($q['id'], veh(), drv(), at(day(), '09:00'), 60, ['stops' => $st, 'crew' => [emp('Бригадир')]]);   // фикстуры — до замера
        $n = [jcount(), (int) scalar('SELECT COUNT(*) FROM assignment_stops'), (int) scalar('SELECT COUNT(*) FROM assignment_crew'), (int) scalar('SELECT COUNT(*) FROM transport_assignments')];
        expect_err(asg('admin', 'POST', '', $pBad), 422, 'invalid_step', 'POST');
        eq([jcount(), (int) scalar('SELECT COUNT(*) FROM assignment_stops'), (int) scalar('SELECT COUNT(*) FROM assignment_crew'), (int) scalar('SELECT COUNT(*) FROM transport_assignments')], $n, 'таблицы');
        eq(getReq($q['id'])['status'], 'new', 'статус заявки');
        return 'ok';
    });
    $run('S15 dry_run проверяет те же правила: invalid_start / invalid_duration / invalid_step → 422 без confirm_token', function () {
        $q = mkReq('admin'); $d = day();
        $bad = route(60); $bad[0]['stay_min'] = 10;
        foreach ([['invalid_start', payload($q['id'], veh(), drv(), at($d, '09:10'))], ['invalid_duration', payload($q['id'], veh(), drv(), at($d, '09:00'), 44)],
                  ['invalid_step', payload($q['id'], veh(), drv(), at($d, '09:00'), 60, ['stops' => $bad])]] as [$code, $p]) {
            $r = dryAsg('admin', $p);
            expect_err($r, 422, $code, 'dry_run ' . $code);
            ok(!isset($r['json']['confirm_token']), 'токен не должен выдаваться при ошибке');
        }
        return 'ok';
    });

    // =====================================================================
    // W — предупреждения, dry_run, confirm_token
    // =====================================================================
    $run('W1 без предупреждений: dry_run → 200 {success, warnings: []}; обычный POST без токена → 201', function () {
        $q = mkReq('admin');
        $p = payload($q['id'], veh(), drv(), at(day(), '09:00'));
        $r = dryAsg('admin', $p);
        expect_status($r, 200, 'dry_run');
        eq(wcodes($r), [], 'warnings');
        expect_status(asg('admin', 'POST', '', $p), 201, 'POST без токена');
        return 'ok';
    });
    $run('W2 vehicle_overlap: то же ТС, пересекающийся интервал, другие водитель/бригада → ровно [vehicle_overlap], severity=warning, message непуст, выдан confirm_token', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120);
        $r = dryAsg('admin', payload(mkReq('admin')['id'], $vid, drv(), at($d, '10:00'), 60));
        expect_status($r, 200, 'dry_run');
        eq(wcodes($r), ['vehicle_overlap'], 'коды');
        $w = $r['json']['warnings'][0];
        eq($w['severity'], 'warning', 'severity');
        ok(is_string($w['message']) && $w['message'] !== '', 'message');
        token($r);
        return 'ok';
    });
    $run('W3 граничное касание — НЕ пересечение: новое назначение начинается в момент конца прежнего и заканчивается в момент начала прежнего → без предупреждений', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '10:00'), 60);   // [10:00, 11:00)
        foreach ([[at($d, '11:00'), 60], [at($d, '09:00'), 60]] as $i => [$start, $dur]) {
            $r = dryAsg('admin', payload(mkReq('admin')['id'], $vid, drv(), $start, $dur));
            expect_status($r, 200, 'dry_run ' . $i);
            eq(wcodes($r), [], 'касание ' . ($i === 0 ? 'после' : 'до'));
        }
        return 'ok';
    });
    $run('W4 пересечение на минимальный шаг (15 мин) с обеих сторон, вложенность, охват и точное совпадение — vehicle_overlap', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '10:00'), 60);   // [10:00, 11:00)
        foreach ([[at($d, '10:45'), 60, 'хвост +15'], [at($d, '09:15'), 60, 'голова +15'], [at($d, '10:15'), 30, 'вложено'],
                  [at($d, '08:00'), 240, 'охватывает'], [at($d, '10:00'), 60, 'совпадает']] as [$start, $dur, $what]) {
            $r = dryAsg('admin', payload(mkReq('admin')['id'], $vid, drv(), $start, $dur));
            expect_status($r, 200, $what);
            eq(wcodes($r), ['vehicle_overlap'], $what);
        }
        return 'ok';
    });
    $run('W5 пересечение через полночь: прежнее 23:00 + 120 (до 01:00) и новое в 00:30 следующего дня → vehicle_overlap; новое в 01:00 — касание, без предупреждения', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '23:00'), 120);
        $r = dryAsg('admin', payload(mkReq('admin')['id'], $vid, drv(), at(addDays($d, 1), '00:30'), 30));
        eq(wcodes($r), ['vehicle_overlap'], 'пересечение за полночью');
        $r = dryAsg('admin', payload(mkReq('admin')['id'], $vid, drv(), at(addDays($d, 1), '01:00'), 30));
        eq(wcodes($r), [], 'касание в 01:00');
        return 'ok';
    });
    $run('W6 driver_overlap: тот же водитель на другом ТС в пересекающееся время → ровно [driver_overlap]; касание — без предупреждения', function () {
        $did = drv(); $d = day();
        mkAsg(mkReq('admin')['id'], veh(), $did, at($d, '09:00'), 120);   // [09:00, 11:00)
        $r = dryAsg('admin', payload(mkReq('admin')['id'], veh(), $did, at($d, '10:30'), 60));
        eq(wcodes($r), ['driver_overlap'], 'пересечение');
        eq(wcodes(dryAsg('admin', payload(mkReq('admin')['id'], veh(), $did, at($d, '11:00'), 60))), [], 'касание');
        return 'ok';
    });
    $run('W7 crew_overlap: сотрудник бригады занят в другой бригаде в пересекающееся время → ровно [crew_overlap]; касание — без предупреждения', function () {
        $m = emp('Монтажник'); $d = day();
        mkAsg(mkReq('admin')['id'], veh(), drv(), at($d, '09:00'), 120, ['crew' => [$m]]);
        $r = dryAsg('admin', payload(mkReq('admin')['id'], veh(), drv(), at($d, '10:00'), 60, ['crew' => [$m, emp('Помощник')]]));
        eq(wcodes($r), ['crew_overlap'], 'пересечение');
        eq(wcodes(dryAsg('admin', payload(mkReq('admin')['id'], veh(), drv(), at($d, '11:00'), 60, ['crew' => [$m]]))), [], 'касание');
        return 'ok';
    });
    $run('W8 все три пересечения сразу: [crew_overlap, driver_overlap, vehicle_overlap] в одном наборе', function () {
        $vid = veh(); $did = drv(); $m = emp('Монтажник'); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, $did, at($d, '09:00'), 120, ['crew' => [$m]]);
        $r = dryAsg('admin', payload(mkReq('admin')['id'], $vid, $did, at($d, '10:00'), 60, ['crew' => [$m]]));
        eq(wcodes($r), ['crew_overlap', 'driver_overlap', 'vehicle_overlap'], 'коды');
        foreach ($r['json']['warnings'] as $w) { eq($w['severity'], 'warning', 'severity ' . $w['code']); }
        return 'ok';
    });
    $run('W9 разные ТС, водители и бригады в одно время — пересечения нет (параллельная работа допустима)', function () {
        $d = day();
        mkAsg(mkReq('admin')['id'], veh(), drv(), at($d, '09:00'), 120, ['crew' => [emp('Монтажник')]]);
        $r = dryAsg('admin', payload(mkReq('admin')['id'], veh(), drv(), at($d, '09:00'), 120, ['crew' => [emp('Помощник')]]));
        eq(wcodes($r), [], 'warnings');
        return 'ok';
    });
    $run('W10 правка PUT не конфликтует сама с собой: продление собственного назначения без других назначений — без предупреждений, без токена', function () {
        $q = mkReq('admin');
        $vid = veh(); $did = drv(); $d = day();
        $a = mkAsg($q['id'], $vid, $did, at($d, '09:00'), 60);
        $p = payload($q['id'], $vid, $did, at($d, '09:00'), 120) + ['version' => $a['version']];
        $r = asg('admin', 'PUT', 'id=' . $a['id'], $p + ['dry_run' => true]);
        expect_status($r, 200, 'PUT dry_run');
        eq(wcodes($r), [], 'warnings');
        expect_status(asg('admin', 'PUT', 'id=' . $a['id'], $p), 200, 'PUT без токена');
        return 'ok';
    });
    $run('W11 PUT в пересечение: без токена 409 confirmation_required (ничего не меняется); dry_run даёт токен; с токеном — 200', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '12:00'), 60);
        $q = mkReq('admin'); $did = drv();
        $a = mkAsg($q['id'], $vid, $did, at($d, '08:00'), 60);
        $p = payload($q['id'], $vid, $did, at($d, '12:30'), 60) + ['version' => $a['version']];
        $r = asg('admin', 'PUT', 'id=' . $a['id'], $p);
        expect_err($r, 409, 'confirmation_required', 'PUT без токена');
        eq(getReq($q['id'])['assignments'][0]['start_at'], at($d, '08:00'), 'не менялось');
        $dry = asg('admin', 'PUT', 'id=' . $a['id'], $p + ['dry_run' => true]);
        expect_status($dry, 200, 'PUT dry_run');
        eq(wcodes($dry), ['vehicle_overlap'], 'dry_run warnings');
        eq(getReq($q['id'])['assignments'][0]['start_at'], at($d, '08:00'), 'dry_run не пишет');
        expect_status(asg('admin', 'PUT', 'id=' . $a['id'], $p + ['confirm_token' => token($dry)]), 200, 'PUT с токеном');
        eq(getReq($q['id'])['assignments'][0]['start_at'], at($d, '12:30'), 'записано');
        return 'ok';
    });
    $run('W12 после удаления конфликтующего назначения пересечения нет', function () {
        $vid = veh(); $d = day();
        $a = mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 60);
        $p = payload(mkReq('admin')['id'], $vid, drv(), at($d, '09:30'), 60);
        eq(wcodes(dryAsg('admin', $p)), ['vehicle_overlap'], 'до удаления');
        expect_status(asg('admin', 'DELETE', 'id=' . $a['id']), 200, 'DELETE');
        eq(wcodes(dryAsg('admin', $p)), [], 'после удаления');
        return 'ok';
    });
    foreach (['vacation' => 'отпуск', 'sick' => 'болезнь'] as $st => $label) {
        $run("W13-$st driver_absent: водитель в статусе «$label» (schedule_entries.status='$st') в день назначения → ровно [driver_absent]", function () use ($st) {
            $did = drv(); $d = day();
            absence($did, $d, $st);
            $r = dryAsg('admin', payload(mkReq('admin')['id'], veh(), $did, at($d, '09:00'), 60));
            expect_status($r, 200, 'dry_run');
            eq(wcodes($r), ['driver_absent'], 'коды');
            eq($r['json']['warnings'][0]['severity'], 'warning', 'severity');
            return 'ok';
        });
        $run("W14-$st crew_absent: член бригады в статусе «$label» в день назначения → ровно [crew_absent]", function () use ($st) {
            $m = emp('Монтажник'); $d = day();
            absence($m, $d, $st);
            $r = dryAsg('admin', payload(mkReq('admin')['id'], veh(), drv(), at($d, '09:00'), 60, ['crew' => [$m, emp('Помощник')]]));
            expect_status($r, 200, 'dry_run');
            eq(wcodes($r), ['crew_absent'], 'коды');
            return 'ok';
        });
    }
    $run('W15 driver_absent / crew_absent: командировка (trips + trip_participants) покрывает день назначения → предупреждение; границы периода включительно', function () {
        $d = day();
        $did = drv(); $m = emp('Монтажник');
        trip($did, $d, addDays($d, 2));          // водитель в командировке с этого дня
        trip($m, addDays($d, -3), $d);           // член бригады — последний день командировки = день назначения
        $r = dryAsg('admin', payload(mkReq('admin')['id'], veh(), $did, at($d, '09:00'), 60, ['crew' => [$m]]));
        eq(wcodes($r), ['crew_absent', 'driver_absent'], 'коды');
        return 'ok';
    });
    $run('W16 отсутствие в другой день не мешает: отпуск за день до и за день после (назначение в пределах одного дня) → без предупреждений; командировка закончилась накануне', function () {
        $d = day();
        $did = drv(); $m = emp('Монтажник');
        absence($did, addDays($d, -1), 'vacation');
        absence($did, addDays($d, 1), 'sick');
        trip($m, addDays($d, -5), addDays($d, -1));
        $r = dryAsg('admin', payload(mkReq('admin')['id'], veh(), $did, at($d, '09:00'), 60, ['crew' => [$m]]));
        eq(wcodes($r), [], 'warnings');
        return 'ok';
    });
    $run('W17 назначение через полночь затрагивает оба дня: отпуск только на следующий день → driver_absent; отпуск через день после — нет', function () {
        $d = day();
        $a = drv(); $b = drv();
        absence($a, addDays($d, 1), 'vacation');
        absence($b, addDays($d, 2), 'vacation');
        eq(wcodes(dryAsg('admin', payload(mkReq('admin')['id'], veh(), $a, at($d, '22:00'), 180))), ['driver_absent'], 'следующий день');
        eq(wcodes(dryAsg('admin', payload(mkReq('admin')['id'], veh(), $b, at($d, '22:00'), 180))), [], 'через день');
        return 'ok';
    });
    $run('W18 набор из четырёх кодов: водитель болен, член бригады в отпуске, ТС в ремонте и занято → [crew_absent, driver_absent, vehicle_in_repair, vehicle_overlap]', function () {
        $d = day();
        $vid = veh(['status' => 'repair']);
        $did = drv(); $m = emp('Монтажник');
        absence($did, $d, 'sick');
        absence($m, $d, 'vacation');
        confirmAsg('admin', payload(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120));   // ТС в ремонте: фикстура подтверждается токеном
        $r = dryAsg('admin', payload(mkReq('admin')['id'], $vid, $did, at($d, '10:00'), 60, ['crew' => [$m]]));
        expect_status($r, 200, 'dry_run');
        eq(wcodes($r), ['crew_absent', 'driver_absent', 'vehicle_in_repair', 'vehicle_overlap'], 'коды');
        foreach ($r['json']['warnings'] as $w) { eq($w['severity'], 'warning', 'severity ' . $w['code']); }
        return 'ok';
    });
    $run('W19 vehicle_in_repair: ТС со status=repair → ровно [vehicle_in_repair]; in_service — без предупреждений; после возврата в работу предупреждение исчезает', function () {
        $d = day();
        $vid = veh(['status' => 'repair']);
        $did = drv();
        $r = dryAsg('admin', payload(mkReq('admin')['id'], $vid, $did, at($d, '09:00'), 60));
        eq(wcodes($r), ['vehicle_in_repair'], 'ремонт');
        eq($r['json']['warnings'][0]['severity'], 'warning', 'severity');
        eq(wcodes(dryAsg('admin', payload(mkReq('admin')['id'], veh(), drv(), at($d, '09:00'), 60))), [], 'in_service');
        $cur = null;
        foreach (vhc('admin', 'GET')['json']['vehicles'] as $v) { if ($v['id'] === $vid) { $cur = $v; } }
        expect_status(vhc('admin', 'PUT', 'entity=vehicle&id=' . $vid, ['status' => 'in_service', 'version' => $cur['version']]), 200, 'вернуть в работу');
        eq(wcodes(dryAsg('admin', payload(mkReq('admin')['id'], $vid, $did, at($d, '09:00'), 60))), [], 'после возврата');
        return 'ok';
    });
    $run('W20 route_sum_mismatch: сумма stay_min+leg_min маршрута меньше / больше duration_min → [route_sum_mismatch]; равна → нет', function () {
        $q = mkReq('admin'); $d = day();
        $mk = static fn(int $stay, int $leg) => [
            ['ord' => 1, 'kind' => 'departure', 'place' => 'Тестпункт-А', 'stay_min' => $stay, 'leg_min' => 0],
            ['ord' => 2, 'kind' => 'arrival', 'place' => 'Тестпункт-Б', 'stay_min' => 0, 'leg_min' => $leg],
        ];
        foreach ([[0, 45, ['route_sum_mismatch'], 'меньше (45 ≠ 60)'], [15, 60, ['route_sum_mismatch'], 'больше (75 ≠ 60)'], [15, 45, [], 'равна (15+45 = 60)']] as [$stay, $leg, $exp, $what]) {
            $r = dryAsg('admin', payload($q['id'], veh(), drv(), at($d, '09:00'), 60, ['stops' => $mk($stay, $leg)]));
            expect_status($r, 200, $what);
            eq(wcodes($r), $exp, $what);
        }
        return 'ok';
    });
    $run('W21 route_sum_mismatch считает все точки: стоянки промежуточных остановок и выезда входят в сумму', function () {
        $q = mkReq('admin'); $d = day();
        $st = [
            ['ord' => 1, 'kind' => 'departure', 'place' => 'Тестпункт-А', 'stay_min' => 15, 'leg_min' => 0],
            ['ord' => 2, 'kind' => 'intermediate', 'place' => 'Тестпункт-В', 'stay_min' => 30, 'leg_min' => 30],
            ['ord' => 3, 'kind' => 'arrival', 'place' => 'Тестпункт-Б', 'stay_min' => 0, 'leg_min' => 45],
        ];   // 15 + 30 + 30 + 45 = 120
        eq(wcodes(dryAsg('admin', payload($q['id'], veh(), drv(), at($d, '09:00'), 120, ['stops' => $st]))), [], '120 = 120');
        eq(wcodes(dryAsg('admin', payload($q['id'], veh(), drv(), at($d, '09:00'), 105, ['stops' => $st]))), ['route_sum_mismatch'], '120 ≠ 105');
        return 'ok';
    });
    $run('W22 dry_run ничего не пишет: ни назначения, ни строк бригады/маршрута, ни смены статуса, ни записи журнала (с предупреждениями и без)', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120);
        $q = mkReq('admin');
        $pw = payload($q['id'], $vid, drv(), at($d, '10:00'), 60, ['crew' => [emp('Монтажник')]]);
        $pn = payload($q['id'], veh(), drv(), at($d, '10:00'), 60);   // фикстуры — до замера
        $before = [cleanState(), (int) scalar('SELECT COUNT(*) FROM assignment_crew'), (int) scalar('SELECT COUNT(*) FROM assignment_stops')];
        foreach ([$pw, $pn] as $p) {
            expect_status(dryAsg('admin', $p), 200, 'dry_run');
        }
        eq([cleanState(), (int) scalar('SELECT COUNT(*) FROM assignment_crew'), (int) scalar('SELECT COUNT(*) FROM assignment_stops')], $before, 'таблицы');
        eq(getReq($q['id'])['status'], 'new', 'статус заявки');
        return 'ok';
    });
    $run('W23 без токена при предупреждениях: 409 confirmation_required с актуальным списком warnings; ничего не создаётся, статус new, журнал не растёт', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120);
        $q = mkReq('admin');
        $s0 = cleanState();
        $r = asg('admin', 'POST', '', payload($q['id'], $vid, drv(), at($d, '10:00'), 60));
        expect_err($r, 409, 'confirmation_required', 'POST без токена');
        eq(wcodes($r), ['vehicle_overlap'], 'warnings в ответе 409');
        eq(cleanState(), $s0, 'состояние');
        eq(getReq($q['id'])['status'], 'new', 'статус');
        return 'ok';
    });
    $run('W24 с верным токеном (из dry_run этого же набора) → 201; предупреждения не блокируют: назначение создано, статус assigned', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120);
        $q = mkReq('admin');
        $p = payload($q['id'], $vid, drv(), at($d, '10:00'), 60);
        $tok = token(dryAsg('admin', $p));
        $r = asg('admin', 'POST', '', $p + ['confirm_token' => $tok]);
        expect_status($r, 201, 'POST с токеном');
        eq(getReq($q['id'])['status'], 'assigned', 'статус');
        eq((int) scalar('SELECT COUNT(*) FROM transport_assignments WHERE vehicle_id = :v', [':v' => $vid]), 2, 'пересекающиеся назначения записаны');
        return 'ok';
    });
    $run('W25 токен другого набора предупреждений (выдан для driver_overlap, предъявлен при vehicle_overlap) → 409 confirmation_required, запись не происходит', function () {
        $d = day();
        $vid = veh(); $did = drv();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120);     // занято ТС
        mkAsg(mkReq('admin')['id'], veh(), $did, at($d, '09:00'), 120);    // занят водитель
        $q = mkReq('admin');
        $pVeh = payload($q['id'], $vid, drv(), at($d, '10:00'), 60);       // даст [vehicle_overlap]
        $pDrv = payload($q['id'], veh(), $did, at($d, '10:00'), 60);       // даст [driver_overlap]
        $tokDrv = token(dryAsg('admin', $pDrv));
        $s0 = cleanState();
        $r = asg('admin', 'POST', '', $pVeh + ['confirm_token' => $tokDrv]);
        expect_err($r, 409, 'confirmation_required', 'чужой токен');
        eq(wcodes($r), ['vehicle_overlap'], 'актуальные предупреждения');
        eq(cleanState(), $s0, 'состояние');
        expect_status(asg('admin', 'POST', '', $pVeh + ['confirm_token' => token(dryAsg('admin', $pVeh))]), 201, 'свой токен работает');
        return 'ok';
    });
    $run('W26 токен «шире/уже» набора: токен для [vehicle_overlap] не годится для [vehicle_overlap, route_sum_mismatch] и наоборот → 409', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120);
        $q = mkReq('admin');
        $pOne = payload($q['id'], $vid, drv(), at($d, '10:00'), 60);
        $bad = route(60); $bad[1]['leg_min'] = 45;
        $pTwo = payload($q['id'], $vid, drv(), at($d, '10:00'), 60, ['stops' => $bad]);
        $tOne = token(dryAsg('admin', $pOne));
        $dTwo = dryAsg('admin', $pTwo);
        eq(wcodes($dTwo), ['route_sum_mismatch', 'vehicle_overlap'], 'набор из двух');
        $s0 = cleanState();
        $r = asg('admin', 'POST', '', $pTwo + ['confirm_token' => $tOne]);
        expect_err($r, 409, 'confirmation_required', 'токен меньшего набора');
        eq(wcodes($r), ['route_sum_mismatch', 'vehicle_overlap'], 'в ответе полный набор');
        expect_err(asg('admin', 'POST', '', $pOne + ['confirm_token' => token($dTwo)]), 409, 'confirmation_required', 'токен большего набора');
        eq(cleanState(), $s0, 'состояние');
        return 'ok';
    });
    $run('W27 мусорный/пустой/нестроковый confirm_token → 409 confirmation_required, запись не происходит', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120);
        $q = mkReq('admin');
        $p = payload($q['id'], $vid, drv(), at($d, '10:00'), 60);
        $s0 = cleanState();
        foreach (['garbage', '', 0, ['x']] as $i => $bad) {
            expect_err(asg('admin', 'POST', '', $p + ['confirm_token' => $bad]), 409, 'confirmation_required', 'случай ' . $i);
        }
        eq(cleanState(), $s0, 'состояние');
        return 'ok';
    });
    $run('W28 несколько предупреждений сразу не блокируют: все четыре подтверждаются одним токеном (ремонт + пересечение ТС + водитель в отпуске + маршрут)', function () {
        $d = day();
        $vid = veh(['status' => 'repair']); $did = drv();
        absence($did, $d, 'vacation');
        confirmAsg('admin', payload(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120));   // ТС в ремонте: фикстура подтверждается токеном
        $q = mkReq('admin');
        $bad = route(60); $bad[1]['leg_min'] = 45;
        $p = payload($q['id'], $vid, $did, at($d, '10:00'), 60, ['stops' => $bad]);
        $dry = dryAsg('admin', $p);
        eq(wcodes($dry), ['driver_absent', 'route_sum_mismatch', 'vehicle_in_repair', 'vehicle_overlap'], 'набор');
        expect_status(asg('admin', 'POST', '', $p + ['confirm_token' => token($dry)]), 201, 'POST с токеном');
        return 'ok';
    });
    $run('W29 право на подтверждение — как на правку заявки: supervisor_zone1 получает токен и создаёт назначение на свою заявку, на чужую — 403 даже с токеном', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120);
        $own = mkReq('z1'); $alien = mkReq('z0');
        $pOwn = payload($own['id'], $vid, drv(), at($d, '10:00'), 60);
        expect_err(asg('z1', 'POST', '', $pOwn), 409, 'confirmation_required', 'без токена');
        expect_status(asg('z1', 'POST', '', $pOwn + ['confirm_token' => token(dryAsg('z1', $pOwn))]), 201, 'с токеном на свою');
        $pAlien = payload($alien['id'], $vid, drv(), at($d, '10:00'), 60);
        expect_err(asg('z1', 'POST', '', $pAlien + ['confirm_token' => token(dryAsg('admin', $pAlien))]), 403, 'forbidden', 'на чужую');
        return 'ok';
    });

    // =====================================================================
    // J — журнал
    // =====================================================================
    $run('J1 создание заявки пишет ровно одну запись журнала: before_json NULL, after_json — заявка, actor/role/ts/entity_type заполнены, роль supervisor', function () {
        $j0 = jcount();
        $q = mkReq('z0', ['title' => 'Журнал-создание']);
        $rows = jrows($q['id']);
        eq(count($rows), 1, 'записей по заявке');
        eq(jcount() - $j0, 1, 'всего новых записей');
        $row = $rows[0];
        eq($row['before_json'], null, 'before_json');
        $after = json_decode((string) $row['after_json'], true);
        ok(is_array($after), 'after_json — JSON');
        eq($after['title'], 'Журнал-создание', 'after.title');
        ok(preg_match('/create|add|new/i', (string) $row['action']) === 1, 'action «создание»: ' . $row['action']);
        eq($row['role'], 'supervisor', 'role');
        ok(in_array($row['actor'], [Ctx::$uid['supervisor_zone0'], 'supervisor_zone0'], true), 'actor: ' . $row['actor']);
        ok((string) $row['ts'] !== '' && (string) $row['entity_type'] !== '', 'ts/entity_type');
        return $row['action'];
    });
    $run('J2 правка заявки: запись с before_json (старое название) и after_json (новое); роль admin', function () {
        $q = mkReq('admin', ['title' => 'Было']);
        expect_status(rq('admin', 'PUT', 'id=' . $q['id'], ['title' => 'Стало', 'version' => $q['version']]), 200, 'PUT');
        $rows = jrows($q['id']);
        eq(count($rows), 2, 'создание + правка');
        $row = $rows[1];
        eq([json_decode((string) $row['before_json'], true)['title'] ?? null, json_decode((string) $row['after_json'], true)['title'] ?? null], ['Было', 'Стало'], 'before/after');
        ok(preg_match('/update|edit|change/i', (string) $row['action']) === 1, 'action «правка»: ' . $row['action']);
        eq($row['role'], 'admin', 'role');
        return $row['action'];
    });
    $run('J3 смена статуса: запись с before.status = new и after.status = cancelled', function () {
        $q = mkReq('admin');
        expect_status(rq('admin', 'PUT', 'id=' . $q['id'] . '&action=status', ['status' => 'cancelled', 'version' => $q['version']]), 200, 'status');
        $rows = jrows($q['id']);
        eq(count($rows), 2, 'создание + статус');
        eq([json_decode((string) $rows[1]['before_json'], true)['status'] ?? null, json_decode((string) $rows[1]['after_json'], true)['status'] ?? null], ['new', 'cancelled'], 'before/after status');
        return $rows[1]['action'];
    });
    $run('J4 создание назначения: ровно одна запись по entity_id назначения; before NULL; after содержит vehicle_id/driver_id/start_at/duration_min; сущность отличается от заявки', function () {
        $q = mkReq('admin');
        $vid = veh(); $did = drv(); $d = day();
        $a = mkAsg($q['id'], $vid, $did, at($d, '09:00'), 90);
        $rows = jrows($a['id']);
        eq(count($rows), 1, 'записей по назначению');
        $after = json_decode((string) $rows[0]['after_json'], true);
        eq($rows[0]['before_json'], null, 'before_json');
        eq([$after['vehicle_id'] ?? null, $after['driver_id'] ?? null, $after['start_at'] ?? null, $after['duration_min'] ?? null], [$vid, $did, at($d, '09:00'), 90], 'after_json');
        ok($rows[0]['entity_type'] !== jrows($q['id'])[0]['entity_type'], 'entity_type назначения совпадает с заявкой: ' . $rows[0]['entity_type']);
        return $rows[0]['action'];
    });
    $run('J5 правка назначения: запись с before.duration_min = 60 и after.duration_min = 90', function () {
        $q = mkReq('admin'); $vid = veh(); $did = drv(); $d = day();
        $a = mkAsg($q['id'], $vid, $did, at($d, '09:00'), 60);
        expect_status(asg('admin', 'PUT', 'id=' . $a['id'], payload($q['id'], $vid, $did, at($d, '09:00'), 90) + ['version' => $a['version']]), 200, 'PUT');
        $rows = jrows($a['id']);
        eq(count($rows), 2, 'создание + правка');
        eq([json_decode((string) $rows[1]['before_json'], true)['duration_min'] ?? null, json_decode((string) $rows[1]['after_json'], true)['duration_min'] ?? null], [60, 90], 'before/after');
        return 'ok';
    });
    $run('J6 удаление назначения: запись с before_json (удалённое) и after_json NULL, хотя сама запись удалена из transport_assignments', function () {
        $q = mkReq('admin'); $vid = veh();
        $a = mkAsg($q['id'], $vid, drv(), at(day(), '09:00'));
        expect_status(asg('admin', 'DELETE', 'id=' . $a['id']), 200, 'DELETE');
        $rows = jrows($a['id']);
        eq(count($rows), 2, 'создание + удаление');
        eq(json_decode((string) $rows[1]['before_json'], true)['vehicle_id'] ?? null, $vid, 'before.vehicle_id');
        eq($rows[1]['after_json'], null, 'after_json');
        ok(preg_match('/delete|remove/i', (string) $rows[1]['action']) === 1, 'action «удаление»: ' . $rows[1]['action']);
        return $rows[1]['action'];
    });
    $run('J7 предупреждения попадают в журнал: у подтверждённого назначения warnings_json содержит коды набора; у назначения без предупреждений — пусто', function () {
        $vid = veh(); $d = day();
        $clean = mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120);
        $over = confirmAsg('admin', payload(mkReq('admin')['id'], $vid, drv(), at($d, '10:00'), 60));
        $w = json_decode((string) (jrows($over['id'])[0]['warnings_json'] ?? 'null'), true);
        ok(is_array($w), 'warnings_json у подтверждённого — JSON-массив');
        $codes = array_map(static fn($x) => $x['code'] ?? null, $w);
        eq($codes, ['vehicle_overlap'], 'коды в журнале');
        $w0 = json_decode((string) (jrows($clean['id'])[0]['warnings_json'] ?? 'null'), true);
        ok($w0 === null || $w0 === [], 'у чистого назначения warnings_json пуст');
        return 'ok';
    });
    $run('J8 журнал не засоряется отказами: VERSION_CONFLICT, confirmation_required, dry_run, 422, 403, 404 и чтение не добавляют записей', function () {
        $vid = veh(); $d = day();
        mkAsg(mkReq('admin')['id'], $vid, drv(), at($d, '09:00'), 120);
        $q = mkReq('admin');
        $stale = $q['version'];
        expect_status(rq('admin', 'PUT', 'id=' . $q['id'], ['title' => 'сдвиг', 'version' => $stale]), 200, 'сдвиг версии');
        $vid2 = veh();   // фикстура — до замера журнала
        $j0 = jcount();
        $p = payload($q['id'], $vid, drv(), at($d, '10:00'), 60);
        $pBad = payload($q['id'], $vid2, drv(), at($d, '09:10'));
        $calls = [
            'VERSION_CONFLICT' => fn() => rq('admin', 'PUT', 'id=' . $q['id'], ['title' => 'x', 'version' => $stale]),
            'confirmation_required' => fn() => asg('admin', 'POST', '', $p),
            'dry_run' => fn() => dryAsg('admin', $p),
            '422' => fn() => asg('admin', 'POST', '', $pBad),
            '403' => fn() => asg('view', 'POST', '', $p),
            '404' => fn() => rq('admin', 'GET', 'id=tr_nonexistent'),
            'GET' => fn() => rq('admin', 'GET', 'id=' . $q['id']),
        ];
        foreach ($calls as $what => $fn) {
            $fn();
            eq(jcount(), $j0, 'журнал после «' . $what . '»');
        }
        return 'ok';
    });
    $run('J9 откат мутации откатывает запись журнала и наоборот (одна транзакция): сбой вставки в журнал отменяет создание заявки', function () {
        Ctx::$pdo->exec("CREATE TRIGGER IF NOT EXISTS tx_test_fail_journal BEFORE INSERT ON transport_journal
                         WHEN (SELECT value FROM meta WHERE key = 'tx_fail_journal') = '1'
                         BEGIN SELECT RAISE(ABORT, 'tx test: journal insert failed'); END");
        try {
            $n = (int) scalar('SELECT COUNT(*) FROM transport_requests');
            $j0 = jcount();
            Ctx::$pdo->exec("INSERT INTO meta (key, value) VALUES ('tx_fail_journal', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
            $r = rq('admin', 'POST', '', ['title' => 'Откат-журнал']);
            Ctx::$pdo->exec("DELETE FROM meta WHERE key = 'tx_fail_journal'");
            ok($r['status'] >= 400, 'ожидалась ошибка при сбое журнала; ' . diag($r));
            eq((int) scalar('SELECT COUNT(*) FROM transport_requests'), $n, 'заявка не должна остаться без записи журнала');
            eq(jcount(), $j0, 'журнал');
            expect_status(rq('admin', 'POST', '', ['title' => 'После-сбоя']), 201, 'после снятия сбоя создание работает (БД не заблокирована)');
        } finally {
            Ctx::$pdo->exec("DELETE FROM meta WHERE key = 'tx_fail_journal'");
            Ctx::$pdo->exec('DROP TRIGGER IF EXISTS tx_test_fail_journal');
        }
        return 'ok';
    });
    $run('J10 сбой журнала при создании назначения откатывает всё: нет назначения, строк бригады/маршрута, смены статуса new → assigned', function () {
        $q = mkReq('admin');
        $vid = veh(); $did = drv(); $d = day();
        Ctx::$pdo->exec("CREATE TRIGGER IF NOT EXISTS tx_test_fail_journal BEFORE INSERT ON transport_journal
                         WHEN (SELECT value FROM meta WHERE key = 'tx_fail_journal') = '1'
                         BEGIN SELECT RAISE(ABORT, 'tx test: journal insert failed'); END");
        try {
            $n = [(int) scalar('SELECT COUNT(*) FROM transport_assignments'), (int) scalar('SELECT COUNT(*) FROM assignment_crew'), (int) scalar('SELECT COUNT(*) FROM assignment_stops'), jcount()];
            Ctx::$pdo->exec("INSERT INTO meta (key, value) VALUES ('tx_fail_journal', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
            $r = asg('admin', 'POST', '', payload($q['id'], $vid, $did, at($d, '09:00'), 60, ['crew' => [emp('Бригадир')]]));
            Ctx::$pdo->exec("DELETE FROM meta WHERE key = 'tx_fail_journal'");
            ok($r['status'] >= 400, 'ожидалась ошибка; ' . diag($r));
            eq([(int) scalar('SELECT COUNT(*) FROM transport_assignments'), (int) scalar('SELECT COUNT(*) FROM assignment_crew'), (int) scalar('SELECT COUNT(*) FROM assignment_stops'), jcount()], $n, 'таблицы');
            eq(getReq($q['id'])['status'], 'new', 'статус заявки');
        } finally {
            Ctx::$pdo->exec("DELETE FROM meta WHERE key = 'tx_fail_journal'");
            Ctx::$pdo->exec('DROP TRIGGER IF EXISTS tx_test_fail_journal');
        }
        return 'ok';
    });
    $run('J11 сбой журнала при удалении последнего назначения откатывает и удаление, и возврат статуса в new', function () {
        $q = mkReq('admin');
        $a = mkAsg($q['id'], veh(), drv(), at(day(), '09:00'));
        Ctx::$pdo->exec("CREATE TRIGGER IF NOT EXISTS tx_test_fail_journal BEFORE INSERT ON transport_journal
                         WHEN (SELECT value FROM meta WHERE key = 'tx_fail_journal') = '1'
                         BEGIN SELECT RAISE(ABORT, 'tx test: journal insert failed'); END");
        try {
            Ctx::$pdo->exec("INSERT INTO meta (key, value) VALUES ('tx_fail_journal', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
            $r = asg('admin', 'DELETE', 'id=' . $a['id']);
            Ctx::$pdo->exec("DELETE FROM meta WHERE key = 'tx_fail_journal'");
            ok($r['status'] >= 400, 'ожидалась ошибка; ' . diag($r));
            $g = getReq($q['id']);
            eq([$g['status'], ids($g['assignments'])], ['assigned', [$a['id']]], 'назначение и статус сохранены');
        } finally {
            Ctx::$pdo->exec("DELETE FROM meta WHERE key = 'tx_fail_journal'");
            Ctx::$pdo->exec('DROP TRIGGER IF EXISTS tx_test_fail_journal');
        }
        return 'ok';
    });
    $run('J12 журнал append-only: UPDATE и DELETE записи → ошибка триггера (transport_journal is append-only), строка не меняется', function () {
        $q = mkReq('admin', ['title' => 'Журнал-неизменяем']);
        $row = jrows($q['id'])[0];
        $before = scalar('SELECT COUNT(*) FROM transport_journal');
        foreach (["UPDATE transport_journal SET actor = 'подмена' WHERE id = " . (int) $row['id'], 'DELETE FROM transport_journal WHERE id = ' . (int) $row['id'],
                  'DELETE FROM transport_journal'] as $sql) {
            $threw = null;
            try { Ctx::$pdo->exec($sql); } catch (Throwable $e) { $threw = $e->getMessage(); }
            ok($threw !== null && stripos($threw, 'append-only') !== false, 'ожидалась ошибка триггера для «' . $sql . '», получено: ' . var_export($threw, true));
        }
        eq(scalar('SELECT COUNT(*) FROM transport_journal'), $before, 'число записей');
        eq(jrows($q['id'])[0]['actor'], $row['actor'], 'actor не изменён');
        return 'ok';
    });
    $run('J13 очистка audit_log (audit_cleanup, 7 дней) журнал транспорта не трогает: старая запись остаётся', function () {
        Ctx::$pdo->prepare("INSERT INTO transport_journal (ts, actor, role, action, entity_type, entity_id, before_json, after_json, warnings_json)
                            VALUES ('2020-01-01T00:00:00+05:00', 'tx', 'admin', 'test.old', 'test', 'tx_old_entry', NULL, '{}', NULL)")->execute();
        Ctx::$pdo->prepare("INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details) VALUES ('2020-01-01T00:00:00+00:00', 'tx', 'admin', 'tx.old', 'test', 'tx_old_audit', NULL)")->execute();
        audit_cleanup(Ctx::$pdo);
        eq((int) scalar("SELECT COUNT(*) FROM audit_log WHERE entity_id = 'tx_old_audit'"), 0, 'контроль: старая запись audit_log очищена');
        eq(jcount('tx_old_entry'), 1, 'запись transport_journal осталась');
        return 'ok';
    });
    $run('J14 actor/role по ролям: правка supervisor_zone0 заявки zone1 — запись с role=supervisor и актором zone0 (а не автором заявки)', function () {
        $q = mkReq('z1');
        expect_status(rq('z0', 'PUT', 'id=' . $q['id'], ['title' => 'Правка-делегата', 'version' => $q['version']]), 200, 'PUT zone0');
        $row = jrows($q['id'])[1];
        eq($row['role'], 'supervisor', 'role');
        ok(in_array($row['actor'], [Ctx::$uid['supervisor_zone0'], 'supervisor_zone0'], true), 'actor — правящий, а не автор: ' . $row['actor']);
        return 'ok';
    });

    // =====================================================================
    // C — атомарность и параллельные запросы (php -S с 4 обработчиками, разные сессии)
    // =====================================================================
    $run('C1 гонка за ТС: два параллельных POST на пересекающиеся интервалы одного ТС без токена — ровно один 201 и один 409 confirmation_required [vehicle_overlap] (5 раундов)', function () {
        for ($round = 1; $round <= 5; $round++) {
            $vid = veh(); $d = day();
            $r1 = mkReq('admin'); $r2 = mkReq('z1');
            $res = race([
                ['admin', 'POST', 'transport_assignments.php', '', payload($r1['id'], $vid, drv(), at($d, '09:00'), 120)],
                ['z1', 'POST', 'transport_assignments.php', '', payload($r2['id'], $vid, drv(), at($d, '10:00'), 120)],
            ]);
            $st = [$res[0]['status'], $res[1]['status']];
            sort($st);
            eq($st, [201, 409], 'раунд ' . $round . ': статусы; ' . diag($res[0]) . ' | ' . diag($res[1]));
            $loser = $res[0]['status'] === 409 ? $res[0] : $res[1];
            expect_err($loser, 409, 'confirmation_required', 'раунд ' . $round . ' проигравший');
            eq(wcodes($loser), ['vehicle_overlap'], 'раунд ' . $round . ' warnings');
            eq((int) scalar('SELECT COUNT(*) FROM transport_assignments WHERE vehicle_id = :v', [':v' => $vid]), 1, 'раунд ' . $round . ': в БД одно назначение');
        }
        return '5 раундов';
    });
    $run('C2 гонка за водителя: параллельные POST на пересекающиеся интервалы одного водителя (разные ТС) — один 201, один 409 [driver_overlap] (5 раундов)', function () {
        for ($round = 1; $round <= 5; $round++) {
            $did = drv(); $d = day();
            $r1 = mkReq('z0'); $r2 = mkReq('admin');
            $res = race([
                ['z0', 'POST', 'transport_assignments.php', '', payload($r1['id'], veh(), $did, at($d, '09:00'), 120)],
                ['admin', 'POST', 'transport_assignments.php', '', payload($r2['id'], veh(), $did, at($d, '09:30'), 120)],
            ]);
            $st = [$res[0]['status'], $res[1]['status']];
            sort($st);
            eq($st, [201, 409], 'раунд ' . $round . ': статусы; ' . diag($res[0]) . ' | ' . diag($res[1]));
            $loser = $res[0]['status'] === 409 ? $res[0] : $res[1];
            eq(wcodes($loser), ['driver_overlap'], 'раунд ' . $round . ' warnings');
            eq((int) scalar('SELECT COUNT(*) FROM transport_assignments WHERE driver_id = :d', [':d' => $did]), 1, 'раунд ' . $round . ': в БД одно назначение');
        }
        return '5 раундов';
    });
    $run('C3 три параллельных запроса на одно ТС и общее время: ровно один 201, остальные 409; пересечение не проходит молча', function () {
        for ($round = 1; $round <= 3; $round++) {
            $vid = veh(); $d = day();
            $reqs = ['admin' => mkReq('admin'), 'z0' => mkReq('z0'), 'z1' => mkReq('z1')];
            $calls = [];
            foreach ($reqs as $who => $q) {
                $calls[] = [$who, 'POST', 'transport_assignments.php', '', payload($q['id'], $vid, drv(), at($d, '09:00'), 60)];
            }
            $res = race($calls);
            $st = array_map(static fn($r) => $r['status'], $res);
            sort($st);
            eq($st, [201, 409, 409], 'раунд ' . $round . ': статусы ' . implode(' | ', array_map('diag', $res)));
            eq((int) scalar('SELECT COUNT(*) FROM transport_assignments WHERE vehicle_id = :v', [':v' => $vid]), 1, 'раунд ' . $round . ': в БД одно назначение');
        }
        return '3 раунда';
    });
    $run('C4 гонка PUT одной версии заявки из двух сессий: ровно один 200 и один 409 VERSION_CONFLICT; итог — запись победителя (5 раундов)', function () {
        for ($round = 1; $round <= 5; $round++) {
            $q = mkReq('admin');
            $res = race([
                ['admin', 'PUT', 'transport_requests.php', 'id=' . $q['id'], ['title' => 'Гонка-А', 'version' => $q['version']]],
                ['admin2', 'PUT', 'transport_requests.php', 'id=' . $q['id'], ['title' => 'Гонка-Б', 'version' => $q['version']]],
            ]);
            $st = [$res[0]['status'], $res[1]['status']];
            sort($st);
            eq($st, [200, 409], 'раунд ' . $round . ': статусы; ' . diag($res[0]) . ' | ' . diag($res[1]));
            $loser = $res[0]['status'] === 409 ? $res[0] : $res[1];
            expect_err($loser, 409, 'VERSION_CONFLICT', 'раунд ' . $round);
            $win = $res[0]['status'] === 200 ? 'Гонка-А' : 'Гонка-Б';
            eq(getReq($q['id'])['title'], $win, 'раунд ' . $round . ': итоговое название');
        }
        return '5 раундов';
    });
    $run('C5 гонка PUT одной версии назначения: ровно один 200 и один 409 VERSION_CONFLICT', function () {
        $q = mkReq('admin'); $vid = veh(); $did = drv(); $d = day();
        $a = mkAsg($q['id'], $vid, $did, at($d, '09:00'), 60);
        $res = race([
            ['admin', 'PUT', 'transport_assignments.php', 'id=' . $a['id'], payload($q['id'], $vid, $did, at($d, '09:00'), 90) + ['version' => $a['version']]],
            ['admin2', 'PUT', 'transport_assignments.php', 'id=' . $a['id'], payload($q['id'], $vid, $did, at($d, '09:00'), 120) + ['version' => $a['version']]],
        ]);
        $st = [$res[0]['status'], $res[1]['status']];
        sort($st);
        eq($st, [200, 409], 'статусы; ' . diag($res[0]) . ' | ' . diag($res[1]));
        $win = $res[0]['status'] === 200 ? 90 : 120;
        eq((int) scalar('SELECT duration_min FROM transport_assignments WHERE id = :i', [':i' => $a['id']]), $win, 'итоговая длительность');
        return 'ok';
    });
    $run('C6 параллельное создание заявок из четырёх сессий (2 раунда): все 201, display_no уникальны, у всех свой created_by', function () {
        $all = [];
        for ($round = 1; $round <= 2; $round++) {
            $calls = [];
            foreach (['admin', 'admin2', 'z0', 'z1'] as $who) {
                $calls[] = [$who, 'POST', 'transport_requests.php', '', ['title' => 'Параллельная-' . $round . '-' . $who]];
            }
            foreach (race($calls) as $i => $r) {
                expect_status($r, 201, 'раунд ' . $round . ' запрос ' . $i);
                $all[] = (string) unwrap($r, 'request')['display_no'];
            }
        }
        eq(count(array_unique($all)), 8, 'уникальность display_no ' . json_encode($all));
        return 'ok';
    });
} finally {
    proc_terminate($proc);
    foreach (Ctx::$cookies as $c) { @unlink($c); }
    @unlink($serverLog);
}

// Явно закрываем соединение и удаляем копию БД.
unset($pdo, $db);
Ctx::$pdo = new PDO('sqlite::memory:');   // отпускаем дескриптор файла перед удалением
@unlink($tmpDb);
@unlink($tmpDb . '-wal');
@unlink($tmpDb . '-shm');

$realDbHashAfter = is_file($realDb) ? sha1_file($realDb) : '';
$dbIntact = ($realDbHashBefore === $realDbHashAfter);

out('=== RESULTS: ' . $passed . ' passed, ' . $failed . ' failed out of ' . ($passed + $failed) . ' ===');
foreach ((array) ($failKinds ?? []) as $k => $n) { out('  причина падений — ' . $k . ': ' . $n); }
out('DB intact: ' . ($dbIntact ? 'YES' : 'NO'));
exit(($failed === 0 && $dbIntact) ? 0 : 1);
