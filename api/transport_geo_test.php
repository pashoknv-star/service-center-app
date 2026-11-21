<?php

declare(strict_types=1);

// Служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * transport_geo_test.php — сьют `transportgeo` (V10-T7): геопрокси api/transport_geo.php модуля «Транспорт».
 * Источник требований — reports/V10/SPIKE_MAP.md §5 (округление), §6 (проект прокси), reports/V10/specs/T7_geo_proto.md.
 *
 * Usage:  php api/transport_geo_test.php        (сьют `transportgeo` в scripts/verify_all.sh; входит в общий gate)
 *
 * Как устроено (никаких обращений к реальным сервисам — только 127.0.0.1):
 *   • data/app.db копируется во временный файл, весь тест (CLI и все `php -S`) работает через env SC_APP_DB на этой копии;
 *     data/app.db не изменяется (sha1 до/после, «DB intact: YES»);
 *   • поднимается ПОДДЕЛЬНЫЙ внешний сервис scripts/transport_geo_fake_upstream.php (Nominatim + OSRM + Photon + ORS + Valhalla
 *     в одном), который пишет КАЖДЫЙ входящий запрос целиком (метод, путь, query, все заголовки, тело) и отвечает «грязно»;
 *   • поднимается настоящий api/transport_geo.php на `php -S` (несколько обработчиков); адреса провайдеров, e-mail и пороги —
 *     во временном конфиге (env TRANSPORT_GEO_CONFIG), который тест переписывает между проверками;
 *   • защита от случайного выхода в сеть: серверу прокси выставлены http(s)_proxy на закрытый порт (127.0.0.1 — в no_proxy);
 *   • проверка утечек (leak_scan) применяется к журналу фейка; негативный контроль подтверждает, что она ловит лишний параметр;
 *   • все данные синтетические (ФИО в фикстурах собираются из кусков, чтобы check_no_pii.sh не срабатывал).
 * Вывод: «=== RESULTS: N passed, M failed ... ===» и «DB intact: YES».
 */

$root = realpath(__DIR__ . '/..');
if ($root === false) {
    fwrite(STDERR, "Cannot resolve project root\n");
    exit(1);
}
$apiDir = $root . '/api';
$realDb = $root . '/data/app.db';
$realDbHashBefore = is_file($realDb) ? sha1_file($realDb) : '';

$tmpDir = sys_get_temp_dir();
$tmpDb = tempnam($tmpDir, 'sc_tgeo_db_');
if ($tmpDb === false || !copy($realDb, $tmpDb)) {
    fwrite(STDERR, "Cannot create temp DB copy\n");
    exit(1);
}
putenv('SC_APP_DB=' . $tmpDb);
putenv('TASKS_VALIDATE_WEBHOOK_URL');
$_ENV['SC_APP_DB'] = $tmpDb;

// Библиотечный режим: функции transport_geo_* доступны без запуска обработчика (auth.php стартует сессию — не в CLI-вывод).
ini_set('session.save_path', $tmpDir);
ini_set('session.use_cookies', '0');
ini_set('session.use_strict_mode', '0');
define('TRANSPORT_GEO_LIB_ONLY', true);
require_once $apiDir . '/helpers.php';
require_once $apiDir . '/db.php';
$libLoaded = false;
// До реализации файла нет — проверки упадут по существу (красный прогон), а не фатальной ошибкой.
if (is_file($apiDir . '/transport_geo.php')) {
    require_once $apiDir . '/transport_geo.php';
    $libLoaded = true;
}

// ----------------------------------------------------------------------------
// Счётчики и утилиты
// ----------------------------------------------------------------------------
$passed = 0;
$failed = 0;

function out(string $s): void { echo $s, PHP_EOL; }

function chk(string $name, bool $cond, string $detail = ''): void
{
    global $passed, $failed;
    if ($cond) {
        $passed++;
    } else {
        $failed++;
        $cut = mb_strlen($detail) > 400 ? mb_substr($detail, 0, 400) . '…' : $detail;
        out('FAIL: ' . $name . ($cut !== '' ? ' — ' . $cut : ''));
    }
}

function section(string $title, callable $fn): void
{
    out('--- ' . $title);
    try {
        $fn();
    } catch (Throwable $e) {
        chk($title . ': исключение в тесте', false, get_class($e) . ': ' . $e->getMessage());
    }
}

function jenc(mixed $v): string { return (string) json_encode($v, JSON_UNESCAPED_UNICODE); }

final class Ctx
{
    public static string $base = '';       // адрес прокси (настоящий api/transport_geo.php)
    public static string $fake = '';       // адрес поддельного внешнего сервиса
    public static string $fakeLog = '';
    public static string $cfgFile = '';
    public static string $serverLog = '';
    public static PDO $pdo;
    /** @var array<string,string> who => cookie jar */
    public static array $cookies = [];
    public static int $seq = 0;
}

function freePort(int $from, int $range): int
{
    for ($i = 0; $i < 30; $i++) {
        $cand = $from + random_int(0, $range);
        $fp = @fsockopen('127.0.0.1', $cand, $errno, $errstr, 0.2);
        if ($fp) { fclose($fp); continue; }
        return $cand;
    }
    fwrite(STDERR, "No free port\n");
    exit(1);
}

function waitPort(int $port): bool
{
    for ($i = 0; $i < 50; $i++) {
        $fp = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.2);
        if ($fp) { fclose($fp); return true; }
        usleep(200000);
    }
    return false;
}

/** @return resource|false */
function startServer(string $cmd, array $env, string $cwd)
{
    $proc = proc_open('exec ' . $cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd, $env);
    if (is_resource($proc)) {
        foreach ($pipes as $p) { fclose($p); }
    }
    return $proc;
}

// ----------------------------------------------------------------------------
// HTTP-клиент теста (к ПРОКСИ приложения; к внешним сервисам тест не ходит)
// ----------------------------------------------------------------------------
/** @param string[] $extraHeaders */
function http(string $method, string $url, ?string $cookie = null, ?string $rawBody = null, array $extraHeaders = []): array
{
    $ch = curl_init($url);
    $headers = array_merge(['Accept: application/json'], $extraHeaders);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 40, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_FOLLOWLOCATION => false,
    ]);
    if ($cookie !== null) {
        curl_setopt($ch, CURLOPT_COOKIEJAR, $cookie);
        curl_setopt($ch, CURLOPT_COOKIEFILE, $cookie);
    }
    if ($rawBody !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
        $headers[] = 'Content-Type: application/json';
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    $t0 = microtime(true);
    $raw = curl_exec($ch);
    $dt = microtime(true) - $t0;
    if ($raw === false) {
        $e = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('curl: ' . $e);
    }
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ['status' => $status, 'raw' => (string) $raw, 'json' => json_decode((string) $raw, true), 'dt' => $dt];
}

/** POST api/transport_geo.php?action=… с JSON-телом от имени who (admin|z0|z1|view|anon). */
function geo(string $who, string $action, array $body = [], array $extraHeaders = [], ?string $base = null): array
{
    $url = ($base ?? Ctx::$base) . '/transport_geo.php' . ($action !== '' ? '?action=' . rawurlencode($action) : '');
    return http('POST', $url, Ctx::$cookies[$who] ?? null, jenc($body === [] ? new stdClass() : $body), $extraHeaders);
}

function search(string $q, string $who = 'admin', array $extra = []): array { return geo($who, 'search', array_merge(['q' => $q], $extra)); }
function reverse(mixed $lat, mixed $lon, string $who = 'admin', array $extra = []): array { return geo($who, 'reverse', array_merge(['lat' => $lat, 'lon' => $lon], $extra)); }
function route(mixed $lat1, mixed $lon1, mixed $lat2, mixed $lon2, string $who = 'admin', array $extra = []): array
{
    return geo($who, 'route', array_merge(['lat1' => $lat1, 'lon1' => $lon1, 'lat2' => $lat2, 'lon2' => $lon2], $extra));
}

/** Уникальные координаты второй точки — чтобы ключ кэша маршрута каждый раз был новым. */
function uniq(): float { Ctx::$seq++; return 55.0 + Ctx::$seq * 0.01; }

// ----------------------------------------------------------------------------
// Конфиг прокси, журнал фейка, состояние БД
// ----------------------------------------------------------------------------
/**
 * Записывает временный конфиг прокси: ВСЕ адреса провайдеров — на фейк. $over: значения поверх базовых; null — удалить ключ.
 */
function writeCfg(array $over = []): void
{
    $f = Ctx::$fake;
    $cfg = [
        'contact_email' => 'geo-test@example.invalid',
        'nominatim_url' => $f, 'photon_url' => $f, 'osrm_url' => $f, 'ors_url' => $f, 'valhalla_url' => $f,
        'ors_key' => '',
        'search_providers' => ['nominatim'], 'route_providers' => ['osrm'],
        'gap_ms' => 0, 'timeout_search_ms' => 4000, 'timeout_route_ms' => 6000,
        'user_per_min' => 1000, 'breaker_fails' => 100, 'breaker_window_s' => 60, 'breaker_open_s' => 60,
    ];
    foreach ($over as $k => $v) {
        if ($v === null) { unset($cfg[$k]); } else { $cfg[$k] = $v; }
    }
    file_put_contents(Ctx::$cfgFile, '<?php return ' . var_export($cfg, true) . ";\n");
}

/** Сброс: пустой журнал фейка, пустой geo_cache (кэш, лимиты, breaker), новый конфиг. */
function rs(array $over = []): void
{
    file_put_contents(Ctx::$fakeLog, '');
    Ctx::$pdo->exec('DELETE FROM geo_cache');
    writeCfg($over);
}

/** @return array<int,array<string,mixed>> */
function fakeSeen(): array
{
    if (!is_file(Ctx::$fakeLog)) { return []; }
    $r = [];
    foreach (explode("\n", (string) file_get_contents(Ctx::$fakeLog)) as $l) {
        if (trim($l) !== '') { $r[] = json_decode($l, true); }
    }
    return $r;
}
function fakeCount(): int { return count(fakeSeen()); }
function lastReq(): array { $s = fakeSeen(); return $s === [] ? [] : $s[count($s) - 1]; }

function modeStrip(string $path): string
{
    return preg_replace('#^(/(slow|err500|err429|err403|garbage|shape|big|redirect|noroute|nosegment|dur[0-9.]+|dist[0-9.]+))+#', '', $path) ?? $path;
}

function cacheRows(string $kinds = "'search','reverse','route'"): int
{
    return (int) Ctx::$pdo->query("SELECT COUNT(*) FROM geo_cache WHERE kind IN ($kinds)")->fetchColumn();
}

/** Состарить запись кэша: fetched_at = сейчас − $ageSec. */
function ageRow(string $key, int $ageSec): int
{
    $st = Ctx::$pdo->prepare('UPDATE geo_cache SET fetched_at = :t WHERE key = :k');
    $st->execute([':t' => (string) (time() - $ageSec), ':k' => $key]);
    return $st->rowCount();
}

function serverLogText(): string { return is_file(Ctx::$serverLog) ? (string) file_get_contents(Ctx::$serverLog) : ''; }

const TG_UA_RE = '/^ServiceCenterApp-Transport\/0\.1 \(internal staff-scheduling tool; contact: [^)\s]+\)$/';
const TG_ORS_KEY = 'TESTKEY123';
/** «Канарейки»: значения, которые ни при каких условиях не должны оказаться в исходящем запросе. */
const TG_CANARIES = ['Ленина', 'Заявка', 'Subscriber-XYZ', 'ул.', '79000000000', 'ref-secret', 'evil.example', '5.6.7.8'];

/**
 * Проверка журнала фейка на утечки (SPIKE_MAP §6.5): возвращает список нарушений (пусто — чисто).
 * Query строго из белого списка (ключи и значения), метод GET, пустое тело, нет канареек, заголовки — только разрешённые.
 *
 * @param array<int,array<string,mixed>> $entries
 * @return string[]
 */
function leakScan(array $entries): array
{
    $v = [];
    foreach ($entries as $i => $e) {
        $tag = '#' . $i . ' ' . ($e['path'] ?? '?');
        $path = modeStrip((string) ($e['path'] ?? ''));
        $q = is_array($e['query'] ?? null) ? $e['query'] : [];
        $keys = array_keys($q);
        sort($keys);
        if (($e['method'] ?? '') !== 'GET') { $v[] = $tag . ': метод не GET'; }
        if (($e['body'] ?? 'x') !== '') { $v[] = $tag . ': непустое тело'; }
        $raw = jenc($e);
        foreach (TG_CANARIES as $c) {
            if (mb_strpos($raw, $c) !== false) { $v[] = $tag . ': канарейка «' . $c . '»'; }
        }
        $h = array_change_key_case(is_array($e['headers'] ?? null) ? $e['headers'] : [], CASE_LOWER);
        foreach (['cookie', 'referer', 'x-forwarded-for', 'x-real-ip', 'origin', 'x-requested-with', 'content-length', 'content-type'] as $bad) {
            if (isset($h[$bad])) { $v[] = $tag . ': заголовок ' . $bad; }
        }
        $isOrs = $path === '/v2/directions/driving-car';
        if (isset($h['authorization']) && !($isOrs && $h['authorization'] === TG_ORS_KEY)) { $v[] = $tag . ': заголовок authorization'; }
        if (isset($h['x-client-id']) && !($path === '/route' && $h['x-client-id'] === 'ServiceCenterApp-Transport')) { $v[] = $tag . ': заголовок x-client-id'; }
        if (!preg_match(TG_UA_RE, (string) ($h['user-agent'] ?? ''))) { $v[] = $tag . ': User-Agent ' . ($h['user-agent'] ?? '—'); }
        if (($h['accept'] ?? '') !== 'application/json') { $v[] = $tag . ': Accept ' . ($h['accept'] ?? '—'); }

        $expectKeys = null;
        $constOk = true;
        if ($path === '/search') {
            $expectKeys = ['accept-language', 'addressdetails', 'countrycodes', 'format', 'limit', 'q', 'viewbox'];
            $constOk = ($q['format'] ?? '') === 'jsonv2' && ($q['countrycodes'] ?? '') === 'ru' && ($q['limit'] ?? '') === '5'
                && ($q['accept-language'] ?? '') === 'ru' && ($q['addressdetails'] ?? '') === '1' && ($q['viewbox'] ?? '') === '59.0,65.8,86.0,58.0'
                && preg_match('/^\p{L}[\p{L} .\'’-]*$/u', (string) ($q['q'] ?? '')) === 1;
        } elseif ($path === '/reverse') {
            $expectKeys = ['accept-language', 'addressdetails', 'format', 'lat', 'lon', 'zoom'];
            $constOk = ($q['format'] ?? '') === 'jsonv2' && ($q['zoom'] ?? '') === '14' && ($q['accept-language'] ?? '') === 'ru' && ($q['addressdetails'] ?? '') === '1'
                && preg_match('/^-?\d{1,3}\.\d{3}$/', (string) ($q['lat'] ?? '')) === 1 && preg_match('/^-?\d{1,3}\.\d{3}$/', (string) ($q['lon'] ?? '')) === 1;
        } elseif (preg_match('#^/route/v1/driving/-?\d{1,3}\.\d{3},-?\d{1,3}\.\d{3};-?\d{1,3}\.\d{3},-?\d{1,3}\.\d{3}$#', $path)) {
            $expectKeys = ['alternatives', 'overview', 'steps'];
            $constOk = ($e['query_raw'] ?? '') === 'overview=false&alternatives=false&steps=false';
        } elseif ($path === '/api/') {
            $expectKeys = ['bbox', 'limit', 'osm_tag', 'q'];
            $constOk = ($q['limit'] ?? '') === '5' && ($q['osm_tag'] ?? '') === 'place' && ($q['bbox'] ?? '') === '59.0,58.0,86.0,65.8'
                && preg_match('/^\p{L}[\p{L} .\'’-]*$/u', (string) ($q['q'] ?? '')) === 1;
        } elseif ($isOrs) {
            $expectKeys = ['end', 'start'];
            $constOk = preg_match('/^-?\d{1,3}\.\d{3},-?\d{1,3}\.\d{3}$/', (string) ($q['start'] ?? '')) === 1 && preg_match('/^-?\d{1,3}\.\d{3},-?\d{1,3}\.\d{3}$/', (string) ($q['end'] ?? '')) === 1;
        } elseif ($path === '/route') {
            $expectKeys = ['json'];
            $j = json_decode((string) ($q['json'] ?? ''), true);
            $constOk = is_array($j) && array_keys($j) === ['locations', 'costing', 'directions_options'] && ($j['costing'] ?? '') === 'auto'
                && ($j['directions_options'] ?? null) === ['units' => 'kilometers'] && is_array($j['locations'] ?? null) && count($j['locations']) === 2;
            if ($constOk) {
                foreach ($j['locations'] as $loc) {
                    $constOk = $constOk && is_array($loc) && array_keys($loc) === ['lat', 'lon']
                        && preg_match('/^-?\d{1,3}(\.\d{1,3})?$/', (string) $loc['lat']) === 1 && preg_match('/^-?\d{1,3}(\.\d{1,3})?$/', (string) $loc['lon']) === 1;
                }
            }
        } else {
            $v[] = $tag . ': неизвестная конечная точка';
            continue;
        }
        if ($keys !== $expectKeys) { $v[] = $tag . ': ключи query ' . jenc($keys) . ' ≠ белому списку ' . jenc($expectKeys); }
        if (!$constOk) { $v[] = $tag . ': значения query вне белого списка ' . jenc($e['query_raw'] ?? ''); }
    }
    return $v;
}

// ----------------------------------------------------------------------------
// Поднимаем фейк, прокси, логинимся
// ----------------------------------------------------------------------------
$db = Database::getInstance();
$db->migrate();
Ctx::$pdo = new PDO('sqlite:' . $tmpDb, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
Ctx::$pdo->exec('PRAGMA busy_timeout = 5000');

$fakePort = freePort(20900, 150);
$appPort = freePort(21100, 150);
$mutPort = freePort(21300, 150);
Ctx::$fake = 'http://127.0.0.1:' . $fakePort;
Ctx::$base = 'http://127.0.0.1:' . $appPort . '/api';
Ctx::$fakeLog = (string) tempnam($tmpDir, 'sc_tgeo_fakelog_');
Ctx::$cfgFile = (string) tempnam($tmpDir, 'sc_tgeo_cfg_');
Ctx::$serverLog = (string) tempnam($tmpDir, 'sc_tgeo_srv_');
$fakeSrvLog = (string) tempnam($tmpDir, 'sc_tgeo_fsrv_');
$mutSrvLog = (string) tempnam($tmpDir, 'sc_tgeo_msrv_');
foreach (['admin', 'z0', 'z1', 'view', 'anon'] as $who) {
    Ctx::$cookies[$who] = (string) tempnam($tmpDir, 'sc_tgeo_' . $who . '_');
}
writeCfg();

$baseEnv = getenv();
unset($baseEnv['TASKS_VALIDATE_WEBHOOK_URL']);
$fakeEnv = $baseEnv + [];
$fakeEnv['FAKE_LOG'] = Ctx::$fakeLog;
$fakeEnv['FAKE_ORS_KEY'] = TG_ORS_KEY;
$fakeEnv['PHP_CLI_SERVER_WORKERS'] = '4';
$appEnv = $baseEnv + [];
$appEnv['SC_APP_DB'] = $tmpDb;
$appEnv['TRANSPORT_GEO_CONFIG'] = Ctx::$cfgFile;
$appEnv['PHP_CLI_SERVER_WORKERS'] = '4';
// Страховка: любой исходящий запрос не на 127.0.0.1 упрётся в закрытый порт (реальных сервисов в тестах быть не должно).
foreach (['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as $pv) { $appEnv[$pv] = 'http://127.0.0.1:9'; }
$appEnv['no_proxy'] = '127.0.0.1,localhost';
$appEnv['NO_PROXY'] = '127.0.0.1,localhost';

$fakeProc = startServer(sprintf('php -S 127.0.0.1:%d %s > %s 2>&1', $fakePort, escapeshellarg($root . '/scripts/transport_geo_fake_upstream.php'), escapeshellarg($fakeSrvLog)), $fakeEnv, $root);
$appProc = startServer(sprintf('php -S 127.0.0.1:%d -t %s > %s 2>&1', $appPort, escapeshellarg($root), escapeshellarg(Ctx::$serverLog)), $appEnv, $root);
$mutProc = false;
$mutDir = $tmpDir . '/sc_tgeo_mut_' . getmypid();

if (!is_resource($fakeProc) || !is_resource($appProc) || !waitPort($fakePort) || !waitPort($appPort)) {
    fwrite(STDERR, "Servers did not start\n");
    exit(1);
}

$login = function (string $who, string $user): array {
    $r = http('POST', 'http://127.0.0.1:' . parse_url(Ctx::$base, PHP_URL_PORT) . '/api/login.php', Ctx::$cookies[$who], jenc(['username' => $user, 'password' => 'changeme']));
    if ($r['status'] !== 200) { throw new RuntimeException("login $user failed: HTTP " . $r['status']); }
    return $r['json']['user'];
};

out('=== TRANSPORT GEO TEST START ===');

try {
    $roles = [];
    foreach (['admin' => 'admin', 'z0' => 'supervisor_zone0', 'z1' => 'supervisor_zone1', 'view' => 'viewer_test'] as $who => $user) {
        $roles[$who] = $login($who, $user)['role'];
    }
    chk('H1 харнес: роли admin/supervisor/supervisor/viewer', $roles === ['admin' => 'admin', 'z0' => 'supervisor', 'z1' => 'supervisor', 'view' => 'viewer'], jenc($roles));
    chk('H2 харнес: библиотека api/transport_geo.php загружается (lib-режим)', $libLoaded && function_exists('transport_geo_leg_min_map'));

    // =====================================================================
    // A. Доступ: аноним 401, viewer 403, admin/supervisor 200; метод, действие, тело
    // =====================================================================
    section('A. Доступ и разбор запроса', function () {
        rs();
        $bodies = ['search' => ['q' => 'Урай'], 'reverse' => ['lat' => 60.129, 'lon' => 64.804], 'route' => ['lat1' => 60.129, 'lon1' => 64.804, 'lat2' => 59.592, 'lon2' => 65.909]];
        foreach ($bodies as $action => $b) {
            $r = geo('anon', $action, $b);
            chk("A: аноним $action → 401 unauthorized", $r['status'] === 401 && ($r['json']['error'] ?? '') === 'unauthorized', 'HTTP ' . $r['status'] . ' ' . mb_substr($r['raw'], 0, 80));
            $r = geo('view', $action, $b);
            chk("A: viewer $action → 403 forbidden", $r['status'] === 403 && ($r['json']['error'] ?? '') === 'forbidden', 'HTTP ' . $r['status'] . ' ' . mb_substr($r['raw'], 0, 80));
        }
        chk('A: ни аноним, ни viewer не вызвали исходящих запросов', fakeCount() === 0, 'в журнале фейка ' . fakeCount());
        $r = geo('admin', 'search', ['q' => 'Урай']);
        chk('A: admin search → 200 success', $r['status'] === 200 && ($r['json']['success'] ?? null) === true, 'HTTP ' . $r['status'] . ' ' . mb_substr($r['raw'], 0, 120));
        $r = geo('z0', 'search', ['q' => 'Югорск']);
        chk('A: supervisor_zone0 search → 200', $r['status'] === 200 && ($r['json']['success'] ?? null) === true, 'HTTP ' . $r['status']);
        $r = geo('z1', 'reverse', ['lat' => 60.2, 'lon' => 64.9]);
        chk('A: supervisor_zone1 reverse → 200', $r['status'] === 200 && ($r['json']['success'] ?? null) === true, 'HTTP ' . $r['status']);
        $r = geo('z1', 'route', ['lat1' => 60.1, 'lon1' => 64.8, 'lat2' => 59.5, 'lon2' => 65.9]);
        chk('A: supervisor_zone1 route → 200', $r['status'] === 200 && ($r['json']['success'] ?? null) === true, 'HTTP ' . $r['status']);

        $r = http('GET', Ctx::$base . '/transport_geo.php?action=search&q=' . rawurlencode('Урай'), Ctx::$cookies['admin']);
        chk('A: GET → 405 method_not_allowed (только POST)', $r['status'] === 405 && ($r['json']['error'] ?? '') === 'method_not_allowed', 'HTTP ' . $r['status']);
        $n = fakeCount();
        $r = geo('admin', 'bogus', ['q' => 'Урай']);
        chk('A: неизвестное действие → 400 invalid_action', $r['status'] === 400 && ($r['json']['error'] ?? '') === 'invalid_action', 'HTTP ' . $r['status']);
        $r = geo('admin', '', ['q' => 'Урай']);
        chk('A: без действия → 400 invalid_action', $r['status'] === 400 && ($r['json']['error'] ?? '') === 'invalid_action', 'HTTP ' . $r['status']);
        $r = http('POST', Ctx::$base . '/transport_geo.php?action=search', Ctx::$cookies['admin'], '{not json');
        chk('A: битый JSON → 400 invalid_json', $r['status'] === 400 && ($r['json']['error'] ?? '') === 'invalid_json', 'HTTP ' . $r['status']);
        $r = http('POST', Ctx::$base . '/transport_geo.php?action=search', Ctx::$cookies['admin'], '');
        chk('A: пустое тело → 422 bad_place_name', $r['status'] === 422 && ($r['json']['error'] ?? '') === 'bad_place_name', 'HTTP ' . $r['status']);
        chk('A: ошибки запроса не создали исходящих', fakeCount() === $n, 'было ' . $n . ', стало ' . fakeCount());
    });

    // =====================================================================
    // B. Поиск: что уходит наружу и что возвращается клиенту
    // =====================================================================
    section('B. Поиск населённого пункта', function () {
        rs();
        $r = search('  Урай ', 'admin', ['subscriber' => 'Subscriber-XYZ', 'address' => 'ул. Ленина 5', 'title' => 'Заявка 42', 'phone' => '79000000000', 'note' => 'ref-secret']);
        $s = fakeSeen();
        chk('B: один исходящий запрос', count($s) === 1, 'запросов: ' . count($s));
        $e = $s[0] ?? [];
        chk('B: путь /search, q = нормализованное название', ($e['path'] ?? '') === '/search' && ($e['query']['q'] ?? '') === 'Урай', jenc($e['query'] ?? null));
        chk('B: query — ровно 7 ключей белого списка, значения-константы', leakScan($s) === [], jenc(leakScan($s)));
        chk('B: в query нет bounded (рамка — только viewbox)', !isset(($e['query'] ?? [])['bounded']));
        $h = array_change_key_case($e['headers'] ?? [], CASE_LOWER);
        chk('B: User-Agent проекта с e-mail из конфига', ($h['user-agent'] ?? '') === 'ServiceCenterApp-Transport/0.1 (internal staff-scheduling tool; contact: geo-test@example.invalid)', $h['user-agent'] ?? '—');
        foreach (['cookie', 'referer', 'authorization', 'x-forwarded-for', 'x-real-ip', 'origin'] as $hn) {
            chk("B: заголовок $hn не пересылается", !isset($h[$hn]));
        }
        chk('B: GET без тела', ($e['method'] ?? '') === 'GET' && ($e['body'] ?? 'x') === '');
        foreach (['Subscriber-XYZ', 'Ленина', 'Заявка', '79000000000', 'ref-secret'] as $needle) {
            chk("B: в исходящем запросе нет канарейки «{$needle}»", mb_strpos(jenc($e), $needle) === false);
        }
        $j = $r['json'];
        chk('B: ответ 200, success=true, degraded=false, cached=false', $r['status'] === 200 && ($j['success'] ?? null) === true && ($j['degraded'] ?? null) === false && ($j['cached'] ?? null) === false, jenc($j));
        chk('B: ключи ответа — только success, degraded, cached, items', is_array($j) && array_keys($j) === ['success', 'degraded', 'cached', 'items'], jenc(is_array($j) ? array_keys($j) : $j));
        $items = $j['items'] ?? [];
        chk('B: из трёх строк остаются населённые пункты (административная единица отброшена)', count($items) === 2, jenc($items));
        chk('B: элемент — только name, lat, lon, kind, county, state', ($items[0] ?? null) !== null && array_keys($items[0]) === ['name', 'lat', 'lon', 'kind', 'county', 'state'], jenc($items[0] ?? null));
        chk('B: первым идёт Урай из ХМАО (RU-KHM), координаты — 5 знаков', ($items[0]['name'] ?? '') === 'Урай' && ($items[0]['lat'] ?? 0) === 60.12912 && ($items[0]['lon'] ?? 0) === 64.80363 && str_contains((string) ($items[0]['state'] ?? ''), 'Ханты-Мансийский'), jenc($items[0] ?? null));
        chk('B: вторым — Урай из Кировской области (подпись региона для выбора)', ($items[1]['state'] ?? '') === 'Кировская область' && ($items[1]['kind'] ?? '') === 'village', jenc($items[1] ?? null));
        $out = jenc($j);
        foreach (['Ленина', 'house_number', 'postcode', '628285', 'osm_id', 'place_id', 'display_name', 'importance', 'road', 'hint', '613000', 'Кировская улица'] as $needle) {
            chk("B: клиенту не вернулось «{$needle}»", mb_strpos($out, $needle) === false);
        }
        $r2 = search('Советский');
        $it = $r2['json']['items'] ?? [];
        chk('B: Советский — один пункт, дубль «городское поселение» отброшен', count($it) === 1 && ($it[0]['name'] ?? '') === 'Советский', jenc($it));
        $r3 = search('Сельцо');
        chk('B: префикс «сельское поселение» убран из названия', ($r3['json']['items'][0]['name'] ?? '') === 'Сельцо', jenc($r3['json']['items'] ?? null));
        $n = fakeCount();
        $r4 = search('Нигдевия');
        chk('B: ничего не найдено — success, degraded=false, items=[]', ($r4['json']['success'] ?? null) === true && ($r4['json']['degraded'] ?? null) === false && ($r4['json']['items'] ?? null) === [], jenc($r4['json']));
        chk('B: Photon/ORS/Valhalla при штатной работе Nominatim не вызываются', fakeCount() === $n + 1 && leakScan(fakeSeen()) === [], 'запросов ' . fakeCount());
        // Лишние поля в теле не влияют на ответ и не уходят наружу
        $r5 = geo('admin', 'search', ['q' => 'Югорск', 'limit' => 500, 'format' => 'xml', 'viewbox' => '0,0,1,1', 'countrycodes' => 'us']);
        chk('B: служебные параметры из тела клиента (limit/format/viewbox/countrycodes) игнорируются', leakScan(fakeSeen()) === [] && ($r5['status'] ?? 0) === 200, jenc(leakScan(fakeSeen())));
        // Заголовки клиента не пересылаются
        rs();
        geo('admin', 'search', ['q' => 'Лангепас'], ['Referer: http://evil.example/ref-secret', 'Origin: http://evil.example', 'X-Forwarded-For: 5.6.7.8', 'X-Real-IP: 5.6.7.8', 'X-Requested-With: XMLHttpRequest']);
        chk('B: Referer/Origin/X-Forwarded-For/X-Real-IP клиента не дошли до сервиса', fakeCount() === 1 && leakScan(fakeSeen()) === [], jenc(leakScan(fakeSeen())));
    });

    // =====================================================================
    // C. Кэш geo_cache и TTL
    // =====================================================================
    section('C. Кэш и TTL', function () {
        rs();
        search('Урай');
        $n = fakeCount();
        $r = search('урай');
        chk('C: повтор (другой регистр) — из кэша, наружу не ходили', ($r['json']['cached'] ?? null) === true && fakeCount() === $n, jenc($r['json']) . ' n=' . fakeCount());
        $key = 'search:' . sha1(mb_strtolower('Урай'));
        $row = Ctx::$pdo->query("SELECT * FROM geo_cache WHERE key = " . Ctx::$pdo->quote($key))->fetch();
        chk('C: запись в geo_cache: kind=search, fetched_at ≈ сейчас', is_array($row) && $row['kind'] === 'search' && abs((int) $row['fetched_at'] - time()) < 10, jenc($row));
        $pl = (string) ($row['payload_json'] ?? '');
        chk('C: в кэш попал уже отфильтрованный ответ (без улиц и osm_id)', $pl !== '' && !preg_match('/Ленина|osm_id|house_number|postcode|display_name/u', $pl), mb_substr($pl, 0, 200));
        ageRow($key, 89 * 86400);
        $n = fakeCount();
        search('Урай');
        chk('C: поиск — TTL 90 суток: запись 89 суток ещё действует', fakeCount() === $n);
        ageRow($key, 91 * 86400);
        search('Урай');
        chk('C: поиск — запись старше 90 суток обновляется (запрос наружу)', fakeCount() === $n + 1, 'n=' . fakeCount());
        // «не найдено» — 1 час
        search('Нигдевия');
        $nk = 'search:' . sha1(mb_strtolower('Нигдевия'));
        $n = fakeCount();
        ageRow($nk, 3000);
        search('Нигдевия');
        chk('C: «не найдено» — 50 минут назад ещё из кэша', fakeCount() === $n);
        ageRow($nk, 3700);
        search('Нигдевия');
        chk('C: «не найдено» — старше часа перезапрашивается', fakeCount() === $n + 1, 'n=' . fakeCount());
        // обратный: 90 суток
        reverse(60.1291234, 64.8036278);
        $rk = 'reverse:60.129,64.804';
        $n = fakeCount();
        $rr = reverse('60.12912', '64.80362');
        chk('C: обратный — ключ по округлённым координатам (другое представление — тот же ключ)', ($rr['json']['cached'] ?? null) === true && fakeCount() === $n, jenc($rr['json']));
        ageRow($rk, 91 * 86400);
        reverse(60.129, 64.804);
        chk('C: обратный — запись старше 90 суток перезапрашивается', fakeCount() === $n + 1);
        // маршрут: 30 суток
        route(60.129, 64.804, 59.592, 65.909);
        $tk = 'route:64.804,60.129;65.909,59.592';
        $n = fakeCount();
        $r = route(60.12912, 64.80362, 59.59248, 65.90851);
        chk('C: маршрут — повтор из кэша, наружу не ходили', ($r['json']['cached'] ?? null) === true && fakeCount() === $n, jenc($r['json']));
        ageRow($tk, 29 * 86400);
        route(60.129, 64.804, 59.592, 65.909);
        chk('C: маршрут — TTL 30 суток: 29 суток ещё действует', fakeCount() === $n);
        ageRow($tk, 31 * 86400);
        route(60.129, 64.804, 59.592, 65.909);
        chk('C: маршрут — старше 30 суток перезапрашивается', fakeCount() === $n + 1);
        $r = route(59.592, 65.909, 60.129, 64.804);
        chk('C: обратное направление маршрута — другой ключ, идёт наружу', fakeCount() === $n + 2 && ($r['json']['cached'] ?? null) === false);
        // сбои не кэшируются
        rs(['nominatim_url' => Ctx::$fake . '/err500']);
        search('Кондинское');
        chk('C: сбой (HTTP 500) не записан в кэш', cacheRows() === 0, 'строк ' . cacheRows());
    });

    // =====================================================================
    // D. Вход: белый список названия, отказ ДО исходящего запроса
    // =====================================================================
    section('D. Белый список входа: название', function () {
        rs();
        $bad = ['ул. Ленина 5, Урай', 'Урай, улица Ленина', 'улица Ленина', 'дом 5', implode(' ', ['Иванов', 'Иван', 'Ивано' . 'вич']),
            'Иванов ' . 'И.' . 'И.', 'Урай 2 микрорайон 60', 'Урай; DROP TABLE', 'Урай&format=xml', "Урай\nHost: evil", 'У', str_repeat('а', 61),
            'пр-кт Ленина', 'кв. 12', '', '   ', 'a b c d', '+790****0000', 'Урай,'];
        foreach ($bad as $b) {
            $r = search($b);
            chk('D: отказ для «' . str_replace("\n", '\\n', $b) . '» → 422 bad_place_name', $r['status'] === 422 && ($r['json']['error'] ?? '') === 'bad_place_name', 'HTTP ' . $r['status'] . ' ' . mb_substr($r['raw'], 0, 80));
        }
        foreach ([['q' => ['Урай']], ['q' => 5], ['q' => null], []] as $odd) {
            $r = geo('admin', 'search', $odd);
            chk('D: нестроковый/пустой q ' . jenc($odd) . ' → 422', $r['status'] === 422 && ($r['json']['error'] ?? '') === 'bad_place_name', 'HTTP ' . $r['status']);
        }
        chk('D: отказанные вводы не создали ни одного исходящего запроса', fakeCount() === 0, 'запросов ' . fakeCount());
        foreach (['Урай', 'Междуреченский', 'Ханты-Мансийск', 'Нижние Нарыкары', 'Усть-Аха', 'Старый Катыш', 'Кондинское', 'Советский', 'Нягань'] as $good) {
            chk("D: допустимо «{$good}» (функция проверки)", $GLOBALS['libLoaded'] && transport_geo_place_name($good) === $good);
        }
        chk('D: нормализация пробелов', $GLOBALS['libLoaded'] && transport_geo_place_name("  Нижние \t Нарыкары ") === 'Нижние Нарыкары');
        $r = search('Нижние Нарыкары');
        chk('D: составное название проходит по HTTP, q уходит целиком', ($r['json']['success'] ?? null) === true && (lastReq()['query']['q'] ?? '') === 'Нижние Нарыкары', jenc(lastReq()['query'] ?? null));
    });

    // =====================================================================
    // E. Обратный геокод
    // =====================================================================
    section('E. Обратный геокод', function () {
        rs();
        $r = reverse('60.1291234', 64.8036278, 'admin', ['address' => 'ул. Ленина 5', 'subscriber' => 'Subscriber-XYZ', 'title' => 'Заявка 42']);
        $s = fakeSeen();
        chk('E: один исходящий запрос /reverse', count($s) === 1 && ($s[0]['path'] ?? '') === '/reverse', 'запросов ' . count($s));
        $q = $s[0]['query'] ?? [];
        chk('E: ключи query — фиксированный набор из 6', leakScan($s) === [] && count($q) === 6, jenc(leakScan($s)));
        chk('E: координаты округлены до 3 знаков (60.129, 64.804), zoom=14', ($q['lat'] ?? '') === '60.129' && ($q['lon'] ?? '') === '64.804' && ($q['zoom'] ?? '') === '14', jenc($q));
        $j = $r['json'];
        chk('E: ключи ответа — success, degraded, cached, place', is_array($j) && array_keys($j) === ['success', 'degraded', 'cached', 'place'], jenc($j));
        chk('E: place = населённый пункт (name, level, county, state)', ($j['place'] ?? null) === ['name' => 'Урай', 'level' => 'town', 'county' => 'городской округ Урай', 'state' => 'Ханты-Мансийский автономный округ — Югра'], jenc($j['place'] ?? null));
        chk('E: клиенту — без улицы, дома, индекса, osm_id', !preg_match('/Ленина|house_number|postcode|628285|osm_id|display_name|road/u', jenc($j)));
        $r = reverse(61.1, 63.5);
        chk('E: «только муниципальное образование» → название без префикса «городское поселение»', ($r['json']['place']['name'] ?? '') === 'Советский' && ($r['json']['place']['level'] ?? '') === 'municipality', jenc($r['json']['place'] ?? null));
        chk('E: улица Гастелло из ответа сервиса не вернулась', mb_strpos($r['raw'], 'Гастелло') === false);
        $r = reverse(5.0, 60.0);
        chk('E: «в поле» — name=null, level=null, остаётся район', is_array($r['json']['place'] ?? null) && array_key_exists('name', $r['json']['place']) && $r['json']['place']['name'] === null && $r['json']['place']['level'] === null && ($r['json']['place']['county'] ?? '') === 'Кондинский район', jenc($r['json']['place'] ?? null));
        $n = fakeCount();
        $rn = reverse(5.0, 60.0);
        chk('E: «в поле» тоже кэшируется (повтор не идёт наружу)', ($rn['json']['cached'] ?? null) === true && fakeCount() === $n);
        $n = fakeCount();
        $badc = [['lat' => 'abc', 'lon' => 1], ['lat' => '91', 'lon' => 1], ['lat' => 1, 'lon' => '181'], ['lat' => '60.1;x', 'lon' => 1], ['lon' => 1],
            ['lat' => [1], 'lon' => 1], ['lat' => null, 'lon' => 1], ['lat' => 60.1, 'lon' => '-181'], ['lat' => '', 'lon' => ''], ['lat' => true, 'lon' => 1]];
        foreach ($badc as $b) {
            $rr = geo('admin', 'reverse', $b);
            chk('E: отказ для ' . jenc($b) . ' → 422 bad_coords', $rr['status'] === 422 && ($rr['json']['error'] ?? '') === 'bad_coords', 'HTTP ' . $rr['status'] . ' ' . mb_substr($rr['raw'], 0, 60));
        }
        chk('E: отказанные координаты не создали исходящих', fakeCount() === $n);
        $rr = geo('admin', 'reverse', ['lat' => 'NaN', 'lon' => 1]);
        chk('E: NaN-строка → 422 bad_coords', $rr['status'] === 422);
        $rr = reverse('-33.5', '151');
        chk('E: числовые строки и отрицательные координаты допустимы', ($rr['json']['success'] ?? null) === true && (lastReq()['query']['lat'] ?? '') === '-33.500', jenc(lastReq()['query'] ?? null));
    });

    // =====================================================================
    // F. Маршрут
    // =====================================================================
    section('F. Маршрут', function () {
        rs();
        $r = route(60.12912, 64.80362, '59.59248', '65.90851', 'admin', ['title' => 'Заявка 42', 'subscriber' => 'Subscriber-XYZ', 'address' => 'ул. Ленина 5']);
        $s = fakeSeen();
        $e = $s[0] ?? [];
        chk('F: один исходящий запрос', count($s) === 1, 'запросов ' . count($s));
        chk('F: путь — только lon,lat;lon,lat с 3 знаками', ($e['path'] ?? '') === '/route/v1/driving/64.804,60.129;65.909,59.592', $e['path'] ?? '—');
        chk('F: query фиксирован: overview=false&alternatives=false&steps=false', ($e['query_raw'] ?? '') === 'overview=false&alternatives=false&steps=false', $e['query_raw'] ?? '—');
        chk('F: утечек нет (белый список, заголовки, канарейки)', leakScan($s) === [], jenc(leakScan($s)));
        $j = $r['json'];
        chk('F: ответ {success, degraded:false, cached:false, route:{km, sec, min_map}}', ($j ?? null) === ['success' => true, 'degraded' => false, 'cached' => false, 'route' => ['km' => 124.3, 'sec' => 6620, 'min_map' => 120]], jenc($j));
        chk('F: hint/названия улиц/waypoints клиенту не вернулись', !preg_match('/SECRETHINT|Глинки|Ленина|waypoints|legs|summary/u', $r['raw']));
        $r = route(1, 1, 1, 1);
        $rr = route(0, 0, 0, 0);
        chk('F: нулевые/одинаковые координаты допустимы по формату (0 — число)', ($rr['json']['success'] ?? null) === true);
        $n = fakeCount();
        foreach ([['lat1' => 'x', 'lon1' => 1, 'lat2' => 1, 'lon2' => 1], ['lat1' => 1, 'lon1' => 1, 'lat2' => 100, 'lon2' => 1], ['lat1' => 1, 'lon1' => 1, 'lat2' => 1],
                 ['lat1' => 1, 'lon1' => 200, 'lat2' => 1, 'lon2' => 1], []] as $b) {
            $rr = geo('admin', 'route', $b);
            chk('F: отказ для ' . jenc($b) . ' → 422 bad_coords', $rr['status'] === 422 && ($rr['json']['error'] ?? '') === 'bad_coords', 'HTTP ' . $rr['status']);
        }
        chk('F: отказанные вводы не создали исходящих', fakeCount() === $n);
        rs(['osrm_url' => Ctx::$fake . '/noroute']);
        $r = route(60.1, 64.8, uniq(), 65.9);
        chk('F: NoRoute (200) → 200 degraded, reason=no_route', $r['status'] === 200 && ($r['json'] ?? null) === ['success' => true, 'degraded' => true, 'reason' => 'no_route'], jenc($r['json']));
        rs(['osrm_url' => Ctx::$fake . '/nosegment', 'breaker_fails' => 3]);
        for ($i = 0; $i < 4; $i++) { $r = route(60.1, 64.8, uniq(), 65.9); }
        chk('F: NoSegment (HTTP 400) → degraded/no_route и не считается сбоем сервиса (4 запроса дошли, breaker не открылся)', ($r['json']['reason'] ?? '') === 'no_route' && fakeCount() === 4, jenc($r['json']) . ' n=' . fakeCount());
        rs(['osrm_url' => Ctx::$fake . '/dist100/dur0']);
        $r = route(60.1, 64.8, uniq(), 65.9);
        chk('F: расстояние 100 м → km 0.1; длительность 0 с → sec 0, min_map 0', ($r['json']['route'] ?? null) === ['km' => 0.1, 'sec' => 0, 'min_map' => 0], jenc($r['json']['route'] ?? null));
    });

    // =====================================================================
    // G. Округление: PHP, JS и HTTP на одном наборе значений
    // =====================================================================
    section('G. Округление времени пути', function () {
        $file = $GLOBALS['root'] . '/scripts/transport_geo_round_cases.json';
        $cases = json_decode((string) file_get_contents($file), true)['cases'] ?? [];
        chk('G: набор граничных значений загружен (≥ 30 случаев)', count($cases) >= 30, 'случаев ' . count($cases));
        $jsFile = $GLOBALS['root'] . '/js/transport_geo_round.js';
        chk('G: js/transport_geo_round.js существует', is_file($jsFile));
        $jsOut = null;
        if (is_file($jsFile)) {
            $runner = (string) tempnam(sys_get_temp_dir(), 'sc_tgeo_js_');
            file_put_contents($runner, "const fs=require('fs');const m=require(process.argv[2]);const c=JSON.parse(fs.readFileSync(process.argv[3],'utf8')).cases;\n"
                . "console.log(JSON.stringify(c.map(x=>m.legMinMap(x.sec))));\n");
            $o = [];
            $rc = 0;
            exec('node ' . escapeshellarg($runner) . ' ' . escapeshellarg($jsFile) . ' ' . escapeshellarg($file) . ' 2>&1', $o, $rc);
            @unlink($runner);
            $jsOut = $rc === 0 ? json_decode(implode("\n", $o), true) : null;
            chk('G: node выполнил js/transport_geo_round.js (module.exports.legMinMap)', is_array($jsOut) && count($jsOut) === count($cases), 'rc=' . $rc . ' ' . mb_substr(implode(' ', $o), 0, 200));
        }
        foreach ($cases as $i => $c) {
            $want = $c['expect'];
            $label = jenc($c['sec']) . ' → ' . jenc($want) . ' (' . ($c['note'] ?? '') . ')';
            $php = $GLOBALS['libLoaded'] ? transport_geo_leg_min_map($c['sec']) : 'нет функции';
            chk('G PHP: ' . $label, $php === $want, 'получено ' . jenc($php));
            $js = is_array($jsOut) && array_key_exists($i, $jsOut) ? $jsOut[$i] : 'нет результата JS';
            chk('G JS:  ' . $label, $js === $want, 'получено ' . jenc($js));
            chk('G PHP == JS: ' . jenc($c['sec']), $php === $js, 'php=' . jenc($php) . ' js=' . jenc($js));
        }
        if (is_file($jsFile)) {
            $src = (string) file_get_contents($jsFile);
            chk('G: js/transport_geo_round.js без DOM и без сети', !preg_match('/\bdocument\b|XMLHttpRequest|\bfetch\s*\(|https?:\/\//', $src));
            chk('G: JS экспортирует legMinMap и для браузера (window.TransportGeoRound)', str_contains($src, 'TransportGeoRound') && str_contains($src, 'module.exports'));
        }
        // По HTTP: сервер округляет секунды сервиса сам, клиент получает {km, sec, min_map}
        foreach ([['899.5', 900, 15], ['900.4', 900, 15], ['900.5', 901, 30], ['9876', 9876, 165], ['22092', 22092, 375], ['6620.4', 6620, 120], ['0.4', 0, 0], ['5', 5, 15]] as [$dur, $sec, $min]) {
            rs(['osrm_url' => Ctx::$fake . '/dur' . $dur]);
            $r = route(60.1, 64.8, uniq(), 65.9);
            chk("G HTTP: сервис вернул $dur с → sec=$sec, min_map=$min", ($r['json']['route']['sec'] ?? null) === $sec && ($r['json']['route']['min_map'] ?? null) === $min, jenc($r['json']['route'] ?? $r['raw']));
        }
    });

    // =====================================================================
    // H. Деградация: любой отказ → HTTP 200 {success:true, degraded:true, reason}
    // =====================================================================
    section('H. Деградация', function () {
        $cases = [
            ['search', 'slow', 'timeout'], ['search', 'err500', 'http_500'], ['search', 'err429', 'http_429'], ['search', 'err403', 'http_403'],
            ['search', 'garbage', 'invalid_json'], ['search', 'shape', 'bad_response'], ['search', 'big', 'too_large'], ['search', 'redirect', 'http_302'],
            ['route', 'slow', 'timeout'], ['route', 'err500', 'http_500'], ['route', 'garbage', 'invalid_json'], ['route', 'shape', 'bad_response'],
            ['reverse', 'err500', 'http_500'], ['reverse', 'garbage', 'invalid_json'], ['reverse', 'slow', 'timeout'], ['reverse', 'shape', 'bad_response'],
        ];
        foreach ($cases as [$act, $mode, $reason]) {
            $url = Ctx::$fake . '/' . $mode;
            rs(['nominatim_url' => $url, 'osrm_url' => $url, 'timeout_search_ms' => 500, 'timeout_route_ms' => 500]);
            $t0 = microtime(true);
            $r = $act === 'search' ? search('Кондинское') : ($act === 'reverse' ? reverse(60.1, 64.8) : route(60.1, 64.8, uniq(), 65.9));
            $dt = microtime(true) - $t0;
            $j = $r['json'];
            chk("H: $act при «$mode» → 200 degraded, reason=$reason", $r['status'] === 200 && ($j ?? null) === ['success' => true, 'degraded' => true, 'reason' => $reason], 'HTTP ' . $r['status'] . ' ' . jenc($j));
            if ($mode === 'slow') {
                chk("H: $act таймаут укладывается в 1.5 с (timeout_ms=500)", $dt < 1.5, sprintf('%.2f c', $dt));
            }
            chk("H: $act при «$mode» — сбой не попал в кэш", cacheRows() === 0);
        }
        rs(['nominatim_url' => Ctx::$fake . '/redirect']);
        search('Кондинское');
        chk('H: редирект 302 не выполнялся (в журнале фейка один запрос)', fakeCount() === 1, 'запросов ' . fakeCount());
        rs(['nominatim_url' => 'http://127.0.0.1:1', 'osrm_url' => 'http://127.0.0.1:1']);
        $r = search('Югорск');
        chk('H: сервис недоступен (порт закрыт) → degraded/connect_error', $r['status'] === 200 && ($r['json'] ?? null) === ['success' => true, 'degraded' => true, 'reason' => 'connect_error'], jenc($r['json']));
        $r = route(60.1, 64.8, uniq(), 65.9);
        chk('H: маршрут, порт закрыт → degraded/connect_error', ($r['json']['reason'] ?? '') === 'connect_error' && ($r['json']['degraded'] ?? null) === true, jenc($r['json']));
        $log = serverLogText();
        chk('H: error_log — одна строка на аномалию с причиной и сервисом', (bool) preg_match('/transport_geo: degraded service=nominatim reason=http_500 ms=\d+/', $log), 'в логе сервера нет строки degraded');
        chk('H: error_log без параметров запроса (названия, координаты, URL)', !preg_match('/Кондинское|Югорск|60\.129|127\.0\.0\.1:\d+\/(search|reverse|route)/u', $log), 'в логе есть параметры');
    });

    // =====================================================================
    // I. Ограничения частоты: глобальный (≥ 1,1 с к одному сервису) и пользовательский
    // =====================================================================
    section('I. Ограничение частоты', function () {
        rs(['gap_ms' => 1100]);
        $a = search('Лангепас');
        $b = search('Покачи');
        chk('I: первый ушёл наружу, второй сразу — degraded/rate_limited', ($a['json']['degraded'] ?? null) === false && ($b['json'] ?? null) === ['success' => true, 'degraded' => true, 'reason' => 'rate_limited'] && fakeCount() === 1, jenc($b['json']) . ' n=' . fakeCount());
        $c = reverse(60.5, 64.5);
        chk('I: обратный геокод — тот же сервис Nominatim, тоже rate_limited', ($c['json']['reason'] ?? '') === 'rate_limited' && fakeCount() === 1, jenc($c['json']));
        $d = route(60.1, 64.8, uniq(), 65.9);
        chk('I: лимит по сервисам независим — маршрут (OSRM) проходит сразу', ($d['json']['degraded'] ?? null) === false && fakeCount() === 2, jenc($d['json']));
        $e = search('Лангепас');
        chk('I: попадание в кэш лимитом частоты не ограничивается', ($e['json']['cached'] ?? null) === true && fakeCount() === 2);
        usleep(1200000);
        $f = search('Покачи');
        chk('I: через 1.2 с запрос снова проходит', ($f['json']['degraded'] ?? null) === false && fakeCount() === 3, jenc($f['json']) . ' n=' . fakeCount());
        chk('I: rate_limited не кэшируется', cacheRows() === 3 && Ctx::$pdo->query("SELECT COUNT(*) FROM geo_cache WHERE key = 'search:" . sha1(mb_strtolower('Покачи')) . "'")->fetchColumn() == 1, 'строк ' . cacheRows());

        rs(['user_per_min' => 3]);
        $codes = [];
        foreach (['Лангепас', 'Покачи', 'Югорск', 'Нягань'] as $name) { $codes[] = search($name)['json']['reason'] ?? 'ok'; }
        chk('I: пользовательский лимит (3/мин): 4-й запрос → rate_limited, наружу не ушёл', $codes === ['ok', 'ok', 'ok', 'rate_limited'] && fakeCount() === 3, jenc($codes) . ' n=' . fakeCount());
        $z = geo('z0', 'search', ['q' => 'Радужный']);
        chk('I: другой пользователь не затронут чужим счётчиком', ($z['json']['degraded'] ?? null) === false, jenc($z['json']));
        $h = search('Лангепас');
        chk('I: ответ из кэша выдаётся и после исчерпания пользовательского лимита', ($h['json']['cached'] ?? null) === true);
        $v = geo('view', 'search', ['q' => 'Урай']);
        chk('I: viewer по-прежнему 403 (до всяких счётчиков)', $v['status'] === 403);
    });

    // =====================================================================
    // J. Circuit-breaker и цепочка провайдеров
    // =====================================================================
    section('J. Circuit-breaker', function () {
        rs(['nominatim_url' => Ctx::$fake . '/err500', 'breaker_fails' => 3, 'breaker_open_s' => 2]);
        $r = [];
        for ($i = 1; $i <= 3; $i++) { $r[$i] = search('Город' . str_repeat('а', $i)); }
        chk('J: три сбоя подряд: все degraded/http_500, все ушли наружу', fakeCount() === 3 && ($r[3]['json']['reason'] ?? '') === 'http_500', jenc($r[3]['json']) . ' n=' . fakeCount());
        $r4 = search('Городок');
        chk('J: после 3 сбоев — degraded/circuit_open без обращения наружу', ($r4['json'] ?? null) === ['success' => true, 'degraded' => true, 'reason' => 'circuit_open'] && fakeCount() === 3, jenc($r4['json']) . ' n=' . fakeCount());
        $rv = reverse(60.5, 64.5);
        chk('J: breaker — на сервис: обратный геокод Nominatim тоже закрыт', ($rv['json']['reason'] ?? '') === 'circuit_open' && fakeCount() === 3);
        writeCfg(['nominatim_url' => Ctx::$fake . '/err500', 'osrm_url' => Ctx::$fake, 'breaker_fails' => 3, 'breaker_open_s' => 2]);
        $rt = route(60.1, 64.8, uniq(), 65.9);
        chk('J: другой сервис (OSRM) breaker Nominatim не касается', ($rt['json']['degraded'] ?? null) === false && fakeCount() === 4, jenc($rt['json']));
        usleep(2300000);
        writeCfg(['nominatim_url' => Ctx::$fake, 'osrm_url' => Ctx::$fake, 'breaker_fails' => 3, 'breaker_open_s' => 2]);
        $ok = search('Городок');
        chk('J: через breaker_open_s запрос снова идёт наружу и успешен', ($ok['json']['degraded'] ?? null) === false && fakeCount() === 5, jenc($ok['json']) . ' n=' . fakeCount());

        rs(['nominatim_url' => Ctx::$fake . '/err500', 'breaker_fails' => 3, 'breaker_open_s' => 60]);
        search('Алпатово'); search('Бубнов');
        writeCfg(['nominatim_url' => Ctx::$fake, 'breaker_fails' => 3, 'breaker_open_s' => 60]);
        search('Верхнеказымский');
        writeCfg(['nominatim_url' => Ctx::$fake . '/err500', 'breaker_fails' => 3, 'breaker_open_s' => 60]);
        $a = search('Горнореченск'); $b = search('Данилово');
        chk('J: успешный ответ обнуляет счётчик сбоев (2 сбоя + успех + 2 сбоя — breaker не открыт)', ($b['json']['reason'] ?? '') === 'http_500' && fakeCount() === 5, jenc($b['json']) . ' n=' . fakeCount());

        rs(['nominatim_url' => Ctx::$fake . '/err500', 'breaker_fails' => 3, 'breaker_window_s' => 2, 'breaker_open_s' => 60]);
        search('Ёлкино'); search('Жилино');
        usleep(2300000);
        search('Зелёное');
        $x = search('Игрим');
        chk('J: сбои старше окна breaker_window_s не копятся (2 сбоя, пауза, ещё 1 — не открыт)', ($x['json']['reason'] ?? '') === 'http_500' && fakeCount() === 4, jenc($x['json']) . ' n=' . fakeCount());

        rs(['nominatim_url' => Ctx::$fake . '/err429', 'breaker_fails' => 3]);
        search('Каменка'); search('Леуши'); search('Малиновка');
        $x = search('Нахрачи');
        chk('J: HTTP 429 считается сбоем сервиса (3 раза → circuit_open)', ($x['json']['reason'] ?? '') === 'circuit_open' && fakeCount() === 3, jenc($x['json']));
        $log = serverLogText();
        chk('J: открытие breaker — одна строка в error_log, без параметров', (bool) preg_match('/transport_geo: breaker opened service=nominatim/', $log) && !preg_match('/Каменка|Леуши|Малиновка/u', $log));
    });

    section('J2. Цепочка провайдеров и ключ ORS', function () {
        // поиск: Nominatim → Photon
        rs(['search_providers' => ['nominatim', 'photon'], 'nominatim_url' => Ctx::$fake . '/err500']);
        $r = search('Урай');
        $s = fakeSeen();
        chk('J2: Nominatim отказал → ответил Photon (2 запроса: /err500/search, /api/)', count($s) === 2 && modeStrip((string) $s[0]['path']) === '/search' && ($s[1]['path'] ?? '') === '/api/', jenc(array_column($s, 'path')));
        $items = $r['json']['items'] ?? [];
        chk('J2: ответ Photon нормализован: 1 пункт, поля name/lat/lon/kind/county/state, улица (highway) отброшена', count($items) === 1 && array_keys($items[0]) === ['name', 'lat', 'lon', 'kind', 'county', 'state'] && $items[0]['name'] === 'Урай' && $items[0]['kind'] === 'town' && $items[0]['lat'] === 60.12912, jenc($items));
        chk('J2: Photon-запрос — q, limit, osm_tag, bbox; без утечек', leakScan($s) === [], jenc(leakScan($s)));
        chk('J2: из Photon клиенту не ушли улица/дом/индекс/osm_id', !preg_match('/Ленина|housenumber|postcode|osm_id|628285/u', $r['raw']));
        // поиск: оба отказали → причина первого провайдера
        rs(['search_providers' => ['nominatim', 'photon'], 'nominatim_url' => Ctx::$fake . '/err500', 'photon_url' => Ctx::$fake . '/err429']);
        $r = search('Урай');
        chk('J2: оба отказали → degraded с причиной основного провайдера (http_500)', ($r['json'] ?? null) === ['success' => true, 'degraded' => true, 'reason' => 'http_500'] && fakeCount() === 2, jenc($r['json']));
        // неизвестный провайдер в списке игнорируется
        rs(['search_providers' => ['bogus', 'nominatim']]);
        $r = search('Урай');
        chk('J2: неизвестный провайдер в конфиге игнорируется', ($r['json']['degraded'] ?? null) === false && fakeCount() === 1, jenc($r['json']));
        // маршрут: OSRM → ORS (с ключом)
        rs(['route_providers' => ['osrm', 'ors', 'valhalla'], 'osrm_url' => Ctx::$fake . '/err500', 'ors_key' => TG_ORS_KEY]);
        $r = route(60.12912, 64.80362, 59.59248, 65.90851);
        $s = fakeSeen();
        $paths = array_map(static fn($e) => modeStrip((string) $e['path']), $s);
        chk('J2: OSRM отказал → ответил ORS (2 запроса), Valhalla не вызывался', count($s) === 2 && $paths[1] === '/v2/directions/driving-car', jenc($paths));
        chk('J2: ответ ORS нормализован в {km, sec, min_map}', ($r['json']['route'] ?? null) === ['km' => 124.3, 'sec' => 6620, 'min_map' => 120], jenc($r['json']['route'] ?? $r['raw']));
        $oh = array_change_key_case($s[1]['headers'] ?? [], CASE_LOWER);
        chk('J2: ORS-запрос несёт ключ ТОЛЬКО в Authorization; query — start,end (lon,lat, 3 знака)', ($oh['authorization'] ?? '') === TG_ORS_KEY && ($s[1]['query'] ?? []) === ['start' => '64.804,60.129', 'end' => '65.909,59.592'], jenc($s[1]['query'] ?? null));
        chk('J2: утечек нет (ключ — только на ORS, не на OSRM)', leakScan($s) === [] && !isset(array_change_key_case($s[0]['headers'] ?? [], CASE_LOWER)['authorization']), jenc(leakScan($s)));
        chk('J2: ключ ORS не попал в ответ клиенту и в error_log', mb_strpos($r['raw'], TG_ORS_KEY) === false && mb_strpos(serverLogText(), TG_ORS_KEY) === false);
        // маршрут: ORS без ключа пропускается, ответил Valhalla
        rs(['route_providers' => ['osrm', 'ors', 'valhalla'], 'osrm_url' => Ctx::$fake . '/err500', 'ors_key' => '']);
        $r = route(60.12912, 64.80362, 59.59248, 65.90851);
        $s = fakeSeen();
        $paths = array_map(static fn($e) => modeStrip((string) $e['path']), $s);
        chk('J2: без ключа ORS пропускается: OSRM → Valhalla (2 запроса, к ORS не ходили)', $paths === ['/route/v1/driving/64.804,60.129;65.909,59.592', '/route'], jenc($paths));
        chk('J2: ответ Valhalla нормализован: km 124.3, sec 6620, min_map 120', ($r['json']['route'] ?? null) === ['km' => 124.3, 'sec' => 6620, 'min_map' => 120], jenc($r['json']['route'] ?? $r['raw']));
        chk('J2: Valhalla-запрос — json{locations,costing:auto,directions_options}, X-Client-Id приложения; без утечек', leakScan($s) === [], jenc(leakScan($s)));
        // ORS с неверным ключом → 401 → Valhalla
        rs(['route_providers' => ['ors', 'valhalla'], 'ors_key' => 'WRONG-KEY']);
        $r = route(60.1, 64.8, uniq(), 65.9);
        chk('J2: ORS ответил 401 (неверный ключ) → запасной Valhalla дал результат', ($r['json']['degraded'] ?? null) === false && fakeCount() === 2, jenc($r['json']));
        chk('J2: неверный ключ тоже не попал в ответ/лог', mb_strpos($r['raw'] . serverLogText(), 'WRONG-KEY') === false);
        rs(['route_providers' => ['osrm', 'valhalla'], 'osrm_url' => Ctx::$fake . '/err500', 'valhalla_url' => Ctx::$fake . '/err500']);
        $r = route(60.1, 64.8, uniq(), 65.9);
        chk('J2: все маршрутные провайдеры отказали → degraded, причина основного', ($r['json'] ?? null) === ['success' => true, 'degraded' => true, 'reason' => 'http_500'], jenc($r['json']));
    });

    // =====================================================================
    // K. Конфиг: e-mail для User-Agent, заглушка и предупреждение
    // =====================================================================
    section('K. Конфиг data/transport_geo.config.php', function () {
        rs(['contact_email' => null]);
        $before = substr_count(serverLogText(), 'contact_email');
        search('Лангепас');
        search('Покачи');
        search('Югорск');
        $h = array_change_key_case(fakeSeen()[0]['headers'] ?? [], CASE_LOWER);
        chk('K: e-mail не задан → в User-Agent заглушка OWNER_EMAIL_TO_BE_SET', ($h['user-agent'] ?? '') === 'ServiceCenterApp-Transport/0.1 (internal staff-scheduling tool; contact: OWNER_EMAIL_TO_BE_SET)', $h['user-agent'] ?? '—');
        $after = substr_count(serverLogText(), 'contact_email');
        chk('K: предупреждение в error_log — ровно один раз (на трёх запросах)', $after - $before === 1, 'новых строк: ' . ($after - $before));
        chk('K: предупреждение называет файл конфига и заглушку', (bool) preg_match('/transport_geo: contact_email is not set in data\/transport_geo\.config\.php.*OWNER_EMAIL_TO_BE_SET/', serverLogText()));
        rs(['contact_email' => "a@b.c\r\nX-Evil: 1"]);
        search('Лангепас');
        $h = array_change_key_case(fakeSeen()[0]['headers'] ?? [], CASE_LOWER);
        chk('K: некорректный e-mail (CR/LF) → заглушка; инъекции заголовка нет', mb_strpos((string) ($h['user-agent'] ?? ''), 'OWNER_EMAIL_TO_BE_SET') !== false && !isset($h['x-evil']), jenc($h));
        rs(['contact_email' => 'ops@example.invalid']);
        search('Лангепас');
        $h = array_change_key_case(fakeSeen()[0]['headers'] ?? [], CASE_LOWER);
        chk('K: заданный e-mail попадает в User-Agent', str_contains((string) ($h['user-agent'] ?? ''), 'contact: ops@example.invalid)'), $h['user-agent'] ?? '—');
        rs(['evil_url' => Ctx::$fake . '/err500', 'search_providers' => ['nominatim']]);
        $r = search('Лангепас');
        chk('K: неизвестные ключи конфига игнорируются', ($r['json']['degraded'] ?? null) === false);

        // lib-режим: загрузка конфига
        if (!$GLOBALS['libLoaded']) { chk('K: lib-режим недоступен', false); return; }
        $d = transport_geo_default_config();
        foreach (['nominatim_url' => 'https://nominatim.openstreetmap.org', 'photon_url' => 'https://photon.komoot.io', 'osrm_url' => 'https://routing.openstreetmap.de/routed-car',
                  'ors_url' => 'https://api.openrouteservice.org', 'valhalla_url' => 'https://valhalla1.openstreetmap.de'] as $k => $url) {
            chk("K: адрес по умолчанию $k = $url (https, из SPIKE_MAP §6.1)", ($d[$k] ?? '') === $url, $d[$k] ?? '—');
        }
        chk('K: по умолчанию ключа ORS и e-mail нет; цепочки: поиск Nominatim→Photon, маршрут OSRM→ORS→Valhalla',
            ($d['ors_key'] ?? 'x') === '' && ($d['contact_email'] ?? 'x') === '' && $d['search_providers'] === ['nominatim', 'photon'] && $d['route_providers'] === ['osrm', 'ors', 'valhalla']);
        chk('K: пороги по умолчанию из SPIKE_MAP §6.4 (gap 1100 мс, таймауты 4000/6000, 30/мин, breaker 3/60/60)',
            $d['gap_ms'] === 1100 && $d['timeout_search_ms'] === 4000 && $d['timeout_route_ms'] === 6000 && $d['user_per_min'] === 30 && $d['breaker_fails'] === 3 && $d['breaker_window_s'] === 60 && $d['breaker_open_s'] === 60, jenc($d));
        $tf = (string) tempnam(sys_get_temp_dir(), 'sc_tgeo_cfgx_');
        file_put_contents($tf, "<?php return " . var_export([
            'nominatim_url' => 'file:///etc/passwd', 'osrm_url' => 'http://osrm.example.invalid/x/', 'photon_url' => 'ftp://x', 'gap_ms' => -5, 'timeout_search_ms' => 'abc',
            'search_providers' => ['photon', 'bogus', 'nominatim'], 'route_providers' => 'osrm', 'ors_key' => " k-1 ", 'contact_email' => 'x y@z', 'evil' => 1, 'user_per_min' => 7,
        ], true) . ";\n");
        $c = transport_geo_load_config($tf);
        @unlink($tf);
        chk('K: адрес не http/https в конфиге отвергается → значение по умолчанию', $c['nominatim_url'] === $d['nominatim_url'] && $c['photon_url'] === $d['photon_url'], $c['nominatim_url']);
        chk('K: корректный адрес принимается, хвостовой «/» срезается', $c['osrm_url'] === 'http://osrm.example.invalid/x', $c['osrm_url']);
        chk('K: числовые параметры вне диапазона/не числа → по умолчанию; корректные принимаются', $c['gap_ms'] === 1100 && $c['timeout_search_ms'] === 4000 && $c['user_per_min'] === 7, jenc([$c['gap_ms'], $c['timeout_search_ms'], $c['user_per_min']]));
        chk('K: список провайдеров очищается от неизвестных, порядок сохраняется; не-список → по умолчанию', $c['search_providers'] === ['photon', 'nominatim'] && $c['route_providers'] === $d['route_providers'], jenc([$c['search_providers'], $c['route_providers']]));
        chk('K: ключ ORS — trim; e-mail с пробелом отвергается; неизвестный ключ не попал в конфиг', $c['ors_key'] === 'k-1' && $c['contact_email'] === '' && !array_key_exists('evil', $c), jenc([$c['ors_key'], $c['contact_email']]));
        $c2 = transport_geo_load_config(sys_get_temp_dir() . '/sc_tgeo_no_such_config.php');
        chk('K: нет файла конфига → значения по умолчанию', $c2 === $d);
    });

    // =====================================================================
    // L. Сессия отпускается до исходящего вызова
    // =====================================================================
    section('L. session_write_close() до исходящего вызова', function () {
        rs(['nominatim_url' => Ctx::$fake . '/slow', 'timeout_search_ms' => 4000]);
        $mh = curl_multi_init();
        $mk = function (string $url, string $body) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body,
                CURLOPT_HTTPHEADER => ['Content-Type: application/json'], CURLOPT_COOKIEFILE => Ctx::$cookies['admin']]);
            return $ch;
        };
        $chA = $mk(Ctx::$base . '/transport_geo.php?action=search', jenc(['q' => 'Лангепас']));
        $chB = $mk(Ctx::$base . '/transport_geo.php?action=bogus', '{}');
        $t0 = microtime(true);
        $done = [];
        curl_multi_add_handle($mh, $chA);
        $addedB = false;
        do {
            curl_multi_exec($mh, $active);
            if (!$addedB && microtime(true) - $t0 > 0.5) { curl_multi_add_handle($mh, $chB); $addedB = true; }
            while (($info = curl_multi_info_read($mh)) !== false) {
                $done[$info['handle'] === $chA ? 'A' : 'B'] = microtime(true) - $t0;
            }
            if ($active) { curl_multi_select($mh, 0.05); }
        } while (($active || !$addedB) && microtime(true) - $t0 < 25);
        while (($info = curl_multi_info_read($mh)) !== false) {
            $done[$info['handle'] === $chA ? 'A' : 'B'] = microtime(true) - $t0;
        }
        $bBody = (string) curl_multi_getcontent($chB);
        $aBody = (string) curl_multi_getcontent($chA);
        curl_multi_remove_handle($mh, $chA); curl_multi_remove_handle($mh, $chB);
        curl_multi_close($mh);
        chk('L: медленный поиск (фейк держит 3 с) завершился успешно', (json_decode($aBody, true)['degraded'] ?? null) === false && ($done['A'] ?? 0) > 2.5, sprintf('A=%.2f c %s', $done['A'] ?? -1, mb_substr($aBody, 0, 80)));
        chk('L: второй запрос той же сессии, пришедший во время исходящего вызова, не ждёт его', isset($done['B']) && $done['B'] < 1.6 && ($done['B'] ?? 9) < ($done['A'] ?? 0), sprintf('A=%.2f c B=%.2f c', $done['A'] ?? -1, $done['B'] ?? -1));
        chk('L: второй запрос получил штатный ответ (invalid_action), сессия не потеряна', (json_decode($bBody, true)['error'] ?? '') === 'invalid_action', mb_substr($bBody, 0, 80));
        $src = (string) file_get_contents($GLOBALS['apiDir'] . '/transport_geo.php');
        $posClose = preg_match('/^\s*session_write_close\(\);/m', $src);
        chk('L: статически: в обработчике есть оператор session_write_close() (поведение доказано выше)', $posClose === 1 && str_contains($src, 'curl_init('));
    });

    // =====================================================================
    // P. Разбор РЕАЛЬНЫХ ответов сервисов (сохранены в T4_evidence; сеть не используется)
    // =====================================================================
    section('P. Парсеры на реальных ответах (reports/V10/T4_evidence)', function () {
        $ev = $GLOBALS['root'] . '/reports/V10/T4_evidence/';
        $load = static fn(string $f): array => is_file($ev . $f) ? (json_decode((string) file_get_contents($ev . $f), true) ?: []) : [];
        if (!$GLOBALS['libLoaded']) { chk('P: lib-режим недоступен', false); return; }
        $s = transport_geo_parse_search('nominatim', $load('nominatim_search_uray.json'));
        chk('P: реальный Nominatim «Урай»: первым Урай ХМАО (60.12912, 64.80363), все — населённые пункты, ≤ 5', is_array($s) && $s !== [] && count($s) <= 5 && $s[0]['lat'] === 60.12912 && $s[0]['lon'] === 64.80363 && $s[0]['kind'] === 'town', jenc($s[0] ?? null));
        chk('P: реальный поиск — у каждого элемента ровно 6 разрешённых полей, в тексте нет улиц/индексов', is_array($s) && array_reduce($s, static fn($c, $i) => $c && array_keys($i) === ['name', 'lat', 'lon', 'kind', 'county', 'state'], true) && !preg_match('/улица|628\d{3}|osm_id|house/u', jenc($s)));
        $p = transport_geo_parse_search('photon', $load('photon_search_uray.json'));
        chk('P: реальный Photon «Урай» разбирается в тот же формат', is_array($p) && $p !== [] && $p[0]['name'] === 'Урай' && $p[0]['kind'] === 'town', jenc($p[0] ?? null));
        $r = transport_geo_parse_reverse($load('nominatim_reverse_uray_z16.json'));
        chk('P: реальный обратный геокод z16 (в ответе есть улица) → только «Урай», без улицы', ($r['name'] ?? '') === 'Урай' && !str_contains(jenc($r), 'Ленина') && !str_contains(jenc($r), 'улица'), jenc($r));
        $r = transport_geo_parse_reverse($load('nominatim_reverse_forest_z14.json'));
        chk('P: реальный обратный геокод «в лесу» → name=null, остаётся район', is_array($r) && $r['name'] === null && $r['county'] === 'Кондинский район', jenc($r));
        foreach ([['route_osrm_fossgis_uray_mezhd.json', 'osrm', 124.3, 6620, 120], ['route_osrm_fossgis_uray_sovetsky.json', 'osrm', 191.1, 9879, 165],
                  ['route_osrm_fossgis_uray_khm.json', 'osrm', 430.9, 22095, 375], ['route_osrm_fossgis_uray_short.json', 'osrm', 3.3, 345, 15],
                  ['route_valhalla_uray_mezhd.json', 'valhalla', 126.6, 8507, 150]] as [$f, $svc, $km, $sec, $min]) {
            $rt = transport_geo_parse_route($svc, $load($f));
            chk("P: реальный маршрут $f → km $km, sec $sec, min_map $min", $rt === ['km' => $km, 'sec' => $sec, 'min_map' => $min], jenc($rt));
        }
    });

    // =====================================================================
    // M. Статика: единственная точка исходящих HTTP, гигиена, Leaflet
    // =====================================================================
    section('M. Единственная точка исходящих HTTP и локальный Leaflet', function () {
        $root = $GLOBALS['root'];
        $hits = [];
        foreach (glob($root . '/api/*.php') ?: [] as $f) {
            if (preg_match('/_test\.php$/', $f)) { continue; }
            $src = (string) file_get_contents($f);
            if (preg_match('/\bcurl_init\s*\(|\bfsockopen\s*\(|\bstream_socket_client\s*\(|\bfile_get_contents\s*\(\s*\$url|file_get_contents\s*\(\s*[\'"]https?:|\bcurl_multi_init\s*\(|\bfopen\s*\(\s*[\'"]https?:/', $src)) {
                $hits[] = basename($f);
            }
        }
        sort($hits);
        out('info: файлы api/ с исходящим HTTP на текущем коммите: ' . jenc($hits));
        chk('M: исходящий HTTP в api/*.php — только tasks_rules.php (n8n) и transport_geo.php', $hits === ['tasks_rules.php', 'transport_geo.php'], jenc($hits));
        $src = (string) file_get_contents($root . '/api/transport_geo.php');
        chk('M: в transport_geo.php редиректы выключены, протоколы http/https', preg_match('/CURLOPT_FOLLOWLOCATION\s*=>\s*false/', $src) === 1 && !preg_match('/CURLOPT_FOLLOWLOCATION\s*=>\s*true/', $src) && str_contains($src, 'CURLPROTO_HTTPS'));
        chk('M: в transport_geo.php нет пересылки заголовков/cookie пользователя наружу', !preg_match('/\$_COOKIE|HTTP_REFERER|HTTP_COOKIE|HTTP_X_FORWARDED|getallheaders\s*\(/', $src));
        chk('M: в коде нет e-mail и ключей (только заглушка OWNER_EMAIL_TO_BE_SET)', !preg_match('/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/', $src) && str_contains($src, 'OWNER_EMAIL_TO_BE_SET'));
        chk('M: transport_geo.php — strict_types и доступ только через require_edit()', str_contains($src, 'declare(strict_types=1)') && str_contains($src, 'require_edit()'));

        $lf = $root . '/js/vendor/leaflet';
        foreach (['leaflet.js', 'leaflet.css', 'LICENSE', 'README.md', 'images/marker-icon.png', 'images/marker-icon-2x.png', 'images/marker-shadow.png', 'images/layers.png', 'images/layers-2x.png'] as $f) {
            chk("M: js/vendor/leaflet/$f на месте", is_file("$lf/$f") && filesize("$lf/$f") > 0);
        }
        $js = is_file("$lf/leaflet.js") ? (string) file_get_contents("$lf/leaflet.js") : '';
        chk('M: leaflet.js — Leaflet 1.9.4', str_contains(substr($js, 0, 200), 'Leaflet 1.9.4'));
        $readme = is_file("$lf/README.md") ? (string) file_get_contents("$lf/README.md") : '';
        chk('M: README.md называет версию 1.9.4 и лицензию BSD-2-Clause', str_contains($readme, '1.9.4') && str_contains($readme, 'BSD-2-Clause'));
        foreach (['leaflet.js', 'leaflet.css', 'LICENSE', 'images/marker-icon.png', 'images/marker-icon-2x.png', 'images/marker-shadow.png', 'images/layers.png', 'images/layers-2x.png'] as $f) {
            $h = is_file("$lf/$f") ? hash_file('sha256', "$lf/$f") : 'нет файла';
            chk("M: контрольная сумма SHA-256 $f в README совпадает с файлом", strlen((string) $h) === 64 && str_contains($readme, (string) $h), $f);
        }
        $css = is_file("$lf/leaflet.css") ? (string) file_get_contents("$lf/leaflet.css") : '';
        chk('M: leaflet.css ссылается на images/ локально (без CDN)', str_contains($css, 'images/layers.png') && !preg_match('#url\(\s*[\'"]?https?:#', $css));
        $bad = 0;
        foreach (['js/vendor/leaflet/leaflet.css', 'js/transport_geo_round.js'] as $f) {
            if (is_file("$root/$f") && preg_match('#https?://[^\s"\']*(unpkg|cdnjs|jsdelivr|cdn\.)#i', (string) file_get_contents("$root/$f"))) { $bad++; }
        }
        chk('M: ни CDN-ссылок в leaflet.css и transport_geo_round.js', $bad === 0);
        $gi = is_file($root . '/.gitignore') ? (string) file_get_contents($root . '/.gitignore') : '';
        chk('M: .gitignore закрывает data/transport_geo.config.php (ключи/e-mail — вне git)', (bool) preg_match('#^data/transport_geo\.config\.php\s*$#m', $gi));
        $tracked = trim((string) shell_exec('cd ' . escapeshellarg($root) . ' && git ls-files data/transport_geo.config.php 2>/dev/null'));
        chk('M: data/transport_geo.config.php не отслеживается git', $tracked === '');
    });

    // =====================================================================
    // N. Негативный контроль: лишний параметр в копии прокси → проверка утечек падает
    // =====================================================================
    section('N. Негативный контроль (проверка действительно ловит утечку)', function () use (&$mutProc, $mutDir, $mutPort, $mutSrvLog, $appEnv, $root, $apiDir) {
        rs();
        $real = fakeCount();
        search('Урай');
        route(60.1, 64.8, uniq(), 65.9);
        chk('N: исходный прокси — журнал фейка чист (опорная точка контроля)', leakScan(fakeSeen()) === [] && fakeCount() === 2, jenc(leakScan(fakeSeen())));

        $src = (string) file_get_contents($apiDir . '/transport_geo.php');
        $m1 = substr_count($src, "'accept-language' => 'ru',");
        $m2 = substr_count($src, 'overview=false&alternatives=false&steps=false');
        chk('N: в исходнике найдены точки внедрения для обеих мутаций', $m1 >= 1 && $m2 >= 1, "accept-language: $m1, overview: $m2");
        $mut = str_replace('__DIR__', var_export($apiDir, true), $src);
        $mut = preg_replace("/'accept-language' => 'ru',/", "'accept-language' => 'ru', 'comment' => 'ул. Ленина 5, Заявка 42',", $mut) ?? $mut;
        $mut = str_replace('overview=false&alternatives=false&steps=false', 'overview=false&alternatives=false&steps=false&note=Subscriber-XYZ', $mut);
        @mkdir($mutDir);
        file_put_contents($mutDir . '/transport_geo.php', $mut);
        $env = $appEnv;
        $env['PHP_CLI_SERVER_WORKERS'] = '2';
        $mutProc = startServer(sprintf('php -S 127.0.0.1:%d -t %s > %s 2>&1', $mutPort, escapeshellarg($mutDir), escapeshellarg($mutSrvLog)), $env, $root);
        chk('N: сервер с мутантом (лишние параметры comment и note) запущен', is_resource($mutProc) && waitPort($mutPort));
        rs();
        $base = 'http://127.0.0.1:' . $mutPort;
        $r1 = geo('admin', 'search', ['q' => 'Урай'], [], $base);
        $r2 = geo('admin', 'route', ['lat1' => 60.1, 'lon1' => 64.8, 'lat2' => uniq(), 'lon2' => 65.9], [], $base);
        chk('N: мутант отвечает (сессия общая), запросы дошли до фейка', $r1['status'] === 200 && $r2['status'] === 200 && fakeCount() === 2, 'HTTP ' . $r1['status'] . '/' . $r2['status'] . ' n=' . fakeCount());
        $viol = leakScan(fakeSeen());
        $joined = implode(' | ', $viol);
        chk('N: проверка утечек ловит лишний query-параметр в поиске (comment)', str_contains($joined, 'comment'), $joined);
        chk('N: проверка утечек ловит лишний query-параметр в маршруте (note)', str_contains($joined, 'note'), $joined);
        chk('N: проверка утечек ловит канарейки («Ленина», «Subscriber-XYZ»)', str_contains($joined, 'канарейка «Ленина»') && str_contains($joined, 'канарейка «Subscriber-XYZ»'), $joined);
        chk('N: мутант даёт ≥ 4 нарушения (контроль не «случайно» зелёный)', count($viol) >= 4, 'нарушений ' . count($viol));
        if (is_resource($mutProc)) { proc_terminate($mutProc); proc_close($mutProc); $mutProc = false; }
        @unlink($mutDir . '/transport_geo.php');
        @rmdir($mutDir);
    });
} finally {
    foreach ([$fakeProc, $appProc] as $p) { if (is_resource($p)) { proc_terminate($p); proc_close($p); } }
    if (is_resource($mutProc)) { proc_terminate($mutProc); proc_close($mutProc); }
    foreach (Ctx::$cookies as $c) { @unlink($c); }
    @unlink(Ctx::$fakeLog); @unlink(Ctx::$cfgFile); @unlink(Ctx::$serverLog); @unlink($fakeSrvLog); @unlink($mutSrvLog);
}

// Закрываем соединения и удаляем копию БД.
unset($db);
Ctx::$pdo = new PDO('sqlite::memory:');
@unlink($tmpDb);
@unlink($tmpDb . '-wal');
@unlink($tmpDb . '-shm');

$realDbHashAfter = is_file($realDb) ? sha1_file($realDb) : '';
$dbIntact = ($realDbHashBefore === $realDbHashAfter);

out('=== RESULTS: ' . $passed . ' passed, ' . $failed . ' failed out of ' . ($passed + $failed) . ' ===');
out('DB intact: ' . ($dbIntact ? 'YES' : 'NO'));
exit(($failed === 0 && $dbIntact) ? 0 : 1);
