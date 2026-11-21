<?php

declare(strict_types=1);

// Служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * transport_board_test.php — сьют `transportboard` (V10-T6): API доски api/transport_board.php (GET ?from=&to=) и
 * чтение журнала api/transport_journal.php (GET, только admin, фильтры, пагинация, CSV). Контракт —
 * reports/V10/specs/CONTRACT.md, спека — reports/V10/specs/T6_board_journal_api.md.
 *
 * Usage:  php api/transport_board_test.php        (сьют `transportboard` в scripts/verify_all.sh)
 *
 * Изолированный прогон (как api/transport_db_test.php): data/app.db копируется во временный файл, CLI-часть и
 * временный `php -S` работают через env SC_APP_DB на этой копии — data/app.db не изменяется (sha1 до/после).
 * Фикстуры: базы/ТС/перенос — через API T1 (api/transport_vehicles.php); заявки, назначения, отсутствия,
 * записи журнала — прямыми INSERT в копию БД (API заявок/назначений — T5, параллельно). Все данные синтетические.
 * Вывод: «=== RESULTS: N passed, M failed ... ===» и «DB intact: YES».
 */

$root = realpath(__DIR__ . '/..');
if ($root === false) {
    fwrite(STDERR, "Cannot resolve project root\n");
    exit(1);
}
$realDb = $root . '/data/app.db';
$realDbHashBefore = is_file($realDb) ? sha1_file($realDb) : '';

$tmpDir = sys_get_temp_dir();
$tmpDb = tempnam($tmpDir, 'sc_tbd_db_');
if ($tmpDb === false || !copy($realDb, $tmpDb)) {
    fwrite(STDERR, "Cannot create temp DB copy\n");
    exit(1);
}
putenv('SC_APP_DB=' . $tmpDb);
$_ENV['SC_APP_DB'] = $tmpDb;

// auth.php (из transport_lib.php) стартует сессию: не оставляем файлов в системном каталоге, грузим до первого вывода.
ini_set('session.save_path', $tmpDir);
ini_set('session.use_cookies', '0');
ini_set('session.use_strict_mode', '0');

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
if (is_file(__DIR__ . '/transport_lib.php')) {
    require_once __DIR__ . '/transport_lib.php';
}
// Эндпоинт подключаем как библиотеку (без выполнения запроса): нужны tb_build_board() и tb_can_edit_map().
define('TRANSPORT_BOARD_LIB_ONLY', true);
if (is_file(__DIR__ . '/transport_board.php')) {
    require_once __DIR__ . '/transport_board.php';
}

$passed = 0;
$failed = 0;
$testNo = 0;

function out(string $s): void { echo $s, PHP_EOL; }
function ok(bool $cond, string $msg = 'assert failed'): void { if (!$cond) { throw new RuntimeException($msg); } }
function eq(mixed $actual, mixed $expected, string $what = 'value'): void
{
    if ($actual !== $expected) {
        $cut = static fn(string $s): string => mb_strlen($s) > 400 ? mb_substr($s, 0, 400) . '…(+' . (mb_strlen($s) - 400) . ')' : $s;
        throw new RuntimeException($cut($what) . ': expected ' . $cut((string) json_encode($expected, JSON_UNESCAPED_UNICODE))
            . ', got ' . $cut((string) json_encode($actual, JSON_UNESCAPED_UNICODE)));
    }
}
/** Функция должна существовать (до реализации — FAIL по существу, а не фатальная ошибка). */
function need(string $fn): void
{
    if (!function_exists($fn)) {
        throw new RuntimeException($fn . '() не реализована');
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

/** Счётчик SQL-запросов: statement::execute + PDO::query + PDO::exec (prepare не считается — считаем выполнения). */
class CountingStmt extends PDOStatement
{
    protected function __construct() {}
    public function execute(?array $params = null): bool
    {
        CountingPDO::$n++;
        CountingPDO::$log[] = $this->queryString;
        return parent::execute($params);
    }
}
class CountingPDO extends PDO
{
    public static int $n = 0;
    /** @var list<string> */
    public static array $log = [];
    public function __construct(string $file)
    {
        parent::__construct('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $this->setAttribute(PDO::ATTR_STATEMENT_CLASS, [CountingStmt::class]);
        parent::exec('PRAGMA foreign_keys = ON');
        parent::exec('PRAGMA busy_timeout = 5000');
    }
    public function query(string $query, ?int $fetchMode = null, mixed ...$fetchModeArgs): PDOStatement|false
    {
        self::$n++;
        self::$log[] = $query;
        return $fetchMode === null ? parent::query($query) : parent::query($query, $fetchMode, ...$fetchModeArgs);
    }
    public function exec(string $statement): int|false
    {
        self::$n++;
        self::$log[] = $statement;
        return parent::exec($statement);
    }
    public static function reset(): void { self::$n = 0; self::$log = []; }
}

// ----------------------------------------------------------------------------
// CLI-часть: миграция копии, соединения
// ----------------------------------------------------------------------------
$db = Database::getInstance();
$pdo = $db->getPDO();
$pdo->exec('PRAGMA busy_timeout = 5000');
$db->migrate();
// Второе соединение (со счётчиком) живёт до конца скрипта — закрытие дескриптора снимает POSIX-блокировки WAL соседнего соединения.
$cpdo = new CountingPDO($tmpDb);

out('=== TRANSPORTBOARD TEST START ===');

// ----------------------------------------------------------------------------
// HTTP-часть: временный php -S на копии БД
// ----------------------------------------------------------------------------
$host = '127.0.0.1';
$port = null;
for ($attempt = 0; $attempt < 10; $attempt++) {
    $cand = 20900 + random_int(0, 400);
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
$serverLog = tempnam($tmpDir, 'sc_tbd_srv_');
$cookies = ['admin' => tempnam($tmpDir, 'sc_tb_a_'), 'z0' => tempnam($tmpDir, 'sc_tb_0_'), 'z1' => tempnam($tmpDir, 'sc_tb_1_'),
    'view' => tempnam($tmpDir, 'sc_tb_v_'), 'anon' => tempnam($tmpDir, 'sc_tb_n_')];
$env = getenv();
$env['SC_APP_DB'] = $tmpDb;
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
        CURLOPT_HEADER => true,
        CURLOPT_TIMEOUT => 60,
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
    $hs = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    $head = substr((string) $raw, 0, $hs);
    $bodyRaw = (string) substr((string) $raw, $hs);
    return ['status' => $status, 'head' => $head, 'raw' => $bodyRaw, 'json' => json_decode($bodyRaw, true)];
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

$VEH = $base . '/api/transport_vehicles.php';
$BEP = $base . '/api/transport_board.php';
$JEP = $base . '/api/transport_journal.php';
$login = function (string $who, string $user) use ($base, $cookies): void {
    $r = req('POST', $base . '/api/login.php', ['cookie' => $cookies[$who], 'body' => ['username' => $user, 'password' => 'changeme']]);
    if ($r['status'] !== 200) {
        throw new RuntimeException("login $user failed: " . $r['status']);
    }
};
/** Запрос к api/transport_vehicles.php (фикстуры и перенос ТС). */
$veh = fn(string $who, string $m, string $q = '', ?array $body = null) => req($m, $VEH . $q, ['cookie' => $cookies[$who]] + ($body !== null ? ['body' => $body] : []));
/** Запрос к доске: $q — строка запроса без «?». */
$boardQ = fn(string $who, string $q, string $m = 'GET') => req($m, $BEP . ($q === '' ? '' : '?' . $q), ['cookie' => $cookies[$who]]);
$board = fn(string $who, string $from, string $to) => $boardQ($who, 'from=' . $from . '&to=' . $to);
/** Запрос к журналу. */
$jr = fn(string $who, string $q = '', string $m = 'GET') => req($m, $JEP . ($q === '' ? '' : '?' . $q), ['cookie' => $cookies[$who]]);

$err = function (array $r, int $status, string $code): void {
    eq($r['status'], $status, 'HTTP ' . substr($r['raw'], 0, 200));
    eq($r['json']['error'] ?? null, $code, 'error');
};
$cnt = fn(string $t): int => (int) $pdo->query("SELECT COUNT(*) FROM $t")->fetchColumn();
$allUsers = [];
foreach ($pdo->query('SELECT * FROM users')->fetchAll(PDO::FETCH_ASSOC) as $u) { $allUsers[$u['username']] = $u; }

/** Отпечаток таблиц, которые доска/журнал читают (чтение ничего не меняет). */
$fingerprint = fn(): string => md5((string) json_encode(array_map(
    fn(string $t) => $pdo->query("SELECT * FROM $t ORDER BY rowid")->fetchAll(),
    ['transport_bases', 'vehicles', 'transport_driver_pool', 'transport_requests', 'transport_assignments', 'assignment_crew',
        'assignment_stops', 'transport_journal', 'schedule_entries', 'trips', 'trip_participants', 'employees', 'users', 'audit_log']
)));

// ----------------------------------------------------------------------------
// Прямые INSERT-фикстуры (копия БД)
// ----------------------------------------------------------------------------
$insReq = function (string $id, int $no, string $title, string $status, string $authorId, string $authorName) use ($pdo): void {
    $pdo->prepare("INSERT INTO transport_requests (id, display_no, title, subscriber, address, comment, status, source, version, created_by, created_by_name, created_at, updated_at)
                   VALUES (:i, :n, :t, :s, :a, :c, :st, 'manual', 3, :cb, :cn, '2032-01-01T00:00:00+05:00', '2032-01-01T00:00:00+05:00')")
        ->execute([':i' => $id, ':n' => $no, ':t' => $title, ':s' => 'Абонент-' . $id, ':a' => 'Адрес-' . $id, ':c' => 'СекретныйКомментарийЗаявки', ':st' => $status, ':cb' => $authorId, ':cn' => $authorName]);
};
/** Назначение + бригада + остановки; end_at = start_at + duration_min. */
$insAsg = function (string $id, string $reqId, string $vehId, string $drvId, string $start, int $dur, array $crew = [], array $stops = []) use ($pdo): string {
    $end = (new DateTimeImmutable($start))->modify('+' . $dur . ' minutes')->format('Y-m-d\TH:i');
    $nm = $pdo->prepare('SELECT full_name FROM employees WHERE id = :i');
    $nm->execute([':i' => $drvId]);
    $pdo->prepare("INSERT INTO transport_assignments (id, request_id, vehicle_id, driver_id, driver_name_snap, start_at, duration_min, end_at, override_json, version, created_by, created_at, updated_at)
                   VALUES (:i, :r, :v, :d, :dn, :s, :du, :e, NULL, 4, 'admin', '2032-01-01T00:00:00+05:00', '2032-01-01T00:00:00+05:00')")
        ->execute([':i' => $id, ':r' => $reqId, ':v' => $vehId, ':d' => $drvId, ':dn' => (string) $nm->fetchColumn(), ':s' => $start, ':du' => $dur, ':e' => $end]);
    foreach ($crew as $c) {
        $nm->execute([':i' => $c]);
        $pdo->prepare('INSERT INTO assignment_crew (assignment_id, employee_id, name_snap) VALUES (:a, :e, :n)')
            ->execute([':a' => $id, ':e' => $c, ':n' => (string) $nm->fetchColumn()]);
    }
    foreach ($stops as $s) {
        $pdo->prepare('INSERT INTO assignment_stops (assignment_id, ord, kind, place, lat, lon, stay_min, leg_km, leg_min_map, leg_min) VALUES (:a, :o, :k, :p, :la, :lo, :st, :km, :mm, :lm)')
            ->execute([':a' => $id, ':o' => $s[0], ':k' => $s[1], ':p' => $s[2], ':la' => $s[3], ':lo' => $s[4], ':st' => $s[5], ':km' => $s[6], ':mm' => $s[7], ':lm' => $s[8]]);
    }
    return $end;
};
$insAbs = function (string $emp, string $date, string $status) use ($pdo): void {
    $pdo->prepare("INSERT INTO schedule_entries (employee_id, date, status, comment, approval_status, updated_at, version)
                   VALUES (:e, :d, :s, 'СекретныйКомментарийОтпуска', 'approved', '2032-01-01T00:00:00+05:00', 1)")
        ->execute([':e' => $emp, ':d' => $date, ':s' => $status]);
};
$insTrip = function (string $id, string $emp, string $from, string $to, string $status) use ($pdo): void {
    $pdo->prepare("INSERT INTO trips (id, title, location, comment, status, version, created_by, created_at, updated_at, phone)
                   VALUES (:i, 'СекретнаяЦельКомандировки', 'СекретныйПунктНазначения', 'СекретныйКомментарийКомандировки', :st, 1, 'tbd', '2032-01-01T00:00:00+05:00', '2032-01-01T00:00:00+05:00', '+7990TRIPPHONE')")
        ->execute([':i' => $id, ':st' => $status]);
    $pdo->prepare('INSERT INTO trip_participants (trip_id, employee_id, start_date, end_date) VALUES (:t, :e, :f, :to)')
        ->execute([':t' => $id, ':e' => $emp, ':f' => $from, ':to' => $to]);
};
$insJ = function (string $ts, string $actor, string $role, string $action, string $etype, string $eid, ?string $before = null, ?string $after = null, ?string $warn = null) use ($pdo): int {
    $pdo->prepare('INSERT INTO transport_journal (ts, actor, role, action, entity_type, entity_id, before_json, after_json, warnings_json) VALUES (:ts, :a, :r, :ac, :et, :ei, :b, :af, :w)')
        ->execute([':ts' => $ts, ':a' => $actor, ':r' => $role, ':ac' => $action, ':et' => $etype, ':ei' => $eid, ':b' => $before, ':af' => $after, ':w' => $warn]);
    return (int) $pdo->lastInsertId();
};
$ids = [];
$assignedIds = static function (array $r): array {
    $a = array_map(fn($x) => $x['id'], $r['json']['assignments'] ?? []);
    sort($a);
    return $a;
};
$queueNos = static fn(array $r): array => array_map(fn($x) => $x['display_no'], $r['json']['queue'] ?? []);

try {
    $login('admin', 'admin');
    $login('z0', 'supervisor_zone0');
    $login('z1', 'supervisor_zone1');
    $login('view', 'viewer_test');

    // =====================================================================
    // Фикстуры: базы и ТС — через API T1; сотрудники, заявки, назначения, отсутствия — прямые INSERT
    // =====================================================================
    $fx = function (string $who, string $m, string $q, array $body): array {
        global $veh;
        $r = $veh($who, $m, $q, $body);
        if (!in_array($r['status'], [200, 201], true)) {
            throw new RuntimeException('FIXTURE (API T1 ' . $q . '): ' . $r['status'] . ' ' . substr($r['raw'], 0, 200));
        }
        return $r['json'];
    };
    $ids['b1'] = $fx('admin', 'POST', '?entity=base', ['name' => 'Тест-База А', 'sort_order' => 1])['base']['id'];
    $ids['b2'] = $fx('admin', 'POST', '?entity=base', ['name' => 'Тест-База Б', 'sort_order' => 2])['base']['id'];
    $ids['v1'] = $fx('admin', 'POST', '?entity=vehicle', ['name' => 'Тест-ТС 1', 'plate' => 'Т001ТТ86', 'base_id' => $ids['b1'], 'sort_order' => 1])['vehicle']['id'];
    $ids['v2'] = $fx('admin', 'POST', '?entity=vehicle', ['name' => 'Тест-ТС 2', 'plate' => 'Т002ТТ86', 'base_id' => $ids['b1'], 'sort_order' => 2])['vehicle']['id'];
    $ids['v3'] = $fx('admin', 'POST', '?entity=vehicle', ['name' => 'Тест-ТС 3', 'plate' => 'Т003ТТ86', 'base_id' => $ids['b2'], 'status' => 'repair', 'sort_order' => 3])['vehicle']['id'];

    foreach ([
        ['tbd_d1', 'Водителев Первый', 'g6'], ['tbd_d2', 'Водителев Второй', 'g6'], ['tbd_p1', 'Совместов Первый', null],
        ['tbd_c1', 'Бригадов Один', 'g1'], ['tbd_c2', 'Бригадов Два', 'g1'], ['tbd_c3', 'Бригадов Три', 'g1'], ['tbd_x', 'Посторонов Четвёртый', 'g1'],
    ] as [$eid, $nm, $gid]) {
        $pdo->prepare("INSERT INTO employees (id, full_name, location, group_id, phone, photo_url, sort_order) VALUES (:i, :n, 'QA', :g, :ph, :pu, 0)")
            ->execute([':i' => $eid, ':n' => $nm, ':g' => $gid, ':ph' => '+7990PHONE' . substr($eid, -2), ':pu' => 'photos/' . $eid . '.jpg']);
    }
    $fx('admin', 'POST', '?entity=pool', ['employee_id' => 'tbd_p1']);

    // Заявки: автор — users.id (в dev-БД id = логин).
    $insReq('tbd_r1', 9001, 'Заявка 1 (admin)', 'assigned', 'admin', 'admin');
    $insReq('tbd_r2', 9002, 'Заявка 2 (zone1)', 'assigned', 'supervisor_zone1', 'supervisor_zone1');
    $insReq('tbd_r3', 9003, 'Заявка 3 (zone0)', 'in_progress', 'supervisor_zone0', 'supervisor_zone0');
    $insReq('tbd_r4', 9004, 'Заявка 4 (admin, до периода)', 'done', 'admin', 'admin');
    $insReq('tbd_r5', 9005, 'Заявка 5 (admin, после периода)', 'assigned', 'admin', 'admin');
    $insReq('tbd_r6', 9006, 'Заявка 6 (граница периода)', 'assigned', 'supervisor_zone1', 'supervisor_zone1');
    $insReq('tbd_r7', 9007, 'Заявка 7 (до периода)', 'assigned', 'admin', 'admin');
    $insReq('tbd_r8', 9008, 'Заявка 8 (многодневная)', 'assigned', 'supervisor_zone0', 'supervisor_zone0');
    $insReq('tbd_r9', 9009, 'Заявка 9 (далеко)', 'assigned', 'admin', 'admin');
    // Очередь: new без назначений; не в очереди — new с назначением, assigned/done/cancelled без назначений.
    $insReq('tbd_n1', 9101, 'Очередь 1 (admin)', 'new', 'admin', 'admin');
    $insReq('tbd_n2', 9102, 'Очередь 2 (zone1)', 'new', 'supervisor_zone1', 'supervisor_zone1');
    $insReq('tbd_n3', 9103, 'Очередь 3 (zone0)', 'new', 'supervisor_zone0', 'supervisor_zone0');
    $insReq('tbd_nx1', 9111, 'Не очередь: new, но есть назначение', 'new', 'admin', 'admin');
    $insReq('tbd_nx2', 9112, 'Не очередь: assigned без назначений', 'assigned', 'admin', 'admin');
    $insReq('tbd_nx3', 9113, 'Не очередь: done', 'done', 'admin', 'admin');
    $insReq('tbd_nx4', 9114, 'Не очередь: cancelled', 'cancelled', 'admin', 'admin');

    $stops1 = [
        [0, 'departure', 'Тест-База А', 60.1, 65.2, 0, null, null, 0],
        [1, 'intermediate', 'Тестпункт Средний', 60.5, 65.9, 15, 12.5, 30, 30],
        [2, 'arrival', 'Тестпункт Конечный', null, null, 0, 20.0, 45, 45],
    ];
    // Период P = 2032-03-10 … 2032-03-16 (7 дней).
    $insAsg('tbd_a1', 'tbd_r1', $ids['v1'], 'tbd_d1', '2032-03-10T09:00', 120, ['tbd_c1', 'tbd_c2'], $stops1);
    $insAsg('tbd_a2', 'tbd_r2', $ids['v2'], 'tbd_d2', '2032-03-12T22:00', 240);                  // через полночь: 12 и 13
    $insAsg('tbd_a3', 'tbd_r4', $ids['v1'], 'tbd_d1', '2032-03-09T22:00', 120);                  // заканчивается ровно 10.03 00:00 — вне P
    $insAsg('tbd_a4', 'tbd_r5', $ids['v1'], 'tbd_d1', '2032-03-17T00:00', 60);                   // начинается ровно 17.03 00:00 — вне P
    $insAsg('tbd_a5', 'tbd_r6', $ids['v2'], 'tbd_d1', '2032-03-16T23:45', 15);                   // последний квант P; end 17.03 00:00
    $insAsg('tbd_a6', 'tbd_r7', $ids['v3'], 'tbd_d2', '2032-03-09T23:00', 180, ['tbd_c3']);       // заходит в P: 09.03 23:00 → 10.03 02:00
    $insAsg('tbd_a7', 'tbd_r8', $ids['v1'], 'tbd_p1', '2032-03-14T08:00', 4320);                 // 14.03 08:00 → 17.03 08:00 (трое суток)
    $insAsg('tbd_a8', 'tbd_r9', $ids['v2'], 'tbd_d2', '2032-05-01T10:00', 60);                   // далеко от P
    $insAsg('tbd_a10', 'tbd_r3', $ids['v3'], 'tbd_d2', '2032-03-13T10:00', 60);                  // заявка zone0 в периоде
    $insAsg('tbd_a9', 'tbd_nx1', $ids['v2'], 'tbd_d1', '2032-03-11T10:00', 60);                  // заявка new с назначением (не очередь)

    // Отсутствия (schedule_entries / trips).
    $insAbs('tbd_d1', '2032-03-11', 'vacation');
    $insAbs('tbd_d2', '2032-03-12', 'sick');
    $insAbs('tbd_c1', '2032-03-13', 'dayoff');
    $insAbs('tbd_c2', '2032-03-20', 'vacation');   // вне периода
    $insAbs('tbd_d1', '2032-03-15', 'work');       // не отсутствие
    $insAbs('tbd_x', '2032-03-11', 'vacation');    // не водитель и не в бригаде — доске не нужен
    $insAbs('tbd_p1', '2032-03-14', 'vacation');   // водитель из пула (свободный водитель тоже подсвечивается)
    $insTrip('tbd_t1', 'tbd_c2', '2032-03-08', '2032-03-11', 'confirmed');   // кроется 10 и 11 (обрезается периодом)
    $insTrip('tbd_t2', 'tbd_d2', '2032-03-15', '2032-03-20', 'forecast');    // прогноз: 15 и 16
    $insTrip('tbd_t3', 'tbd_x', '2032-03-10', '2032-03-12', 'confirmed');    // посторонний

    $P = ['2032-03-10', '2032-03-16'];

    // =====================================================================
    // Доступ и параметры доски
    // =====================================================================
    $run('A1 GET доски без сессии → 401 unauthorized', function () use ($board, $err, $P) {
        $err($board('anon', $P[0], $P[1]), 401, 'unauthorized');
        return 'ok';
    });
    foreach (['admin' => 'admin', 'z0' => 'supervisor_zone0', 'z1' => 'supervisor_zone1', 'view' => 'viewer_test'] as $who => $uname) {
        $run('A2 GET доски: ' . $uname . ' читает (200 {success, from, to, can_move_vehicle, bases, assignments, queue, absences})', function () use ($board, $who, $P) {
            $r = $board($who, $P[0], $P[1]);
            eq($r['status'], 200, 'status ' . substr($r['raw'], 0, 300));
            eq($r['json']['success'] ?? null, true, 'success');
            eq([$r['json']['from'] ?? null, $r['json']['to'] ?? null], $P, 'from/to');
            foreach (['bases', 'assignments', 'queue', 'absences'] as $k) {
                ok(isset($r['json'][$k]) && is_array($r['json'][$k]), 'нет списка ' . $k);
            }
            ok(is_bool($r['json']['can_move_vehicle'] ?? null), 'can_move_vehicle — bool');
            return 'ok';
        });
    }
    foreach (['admin' => true, 'z0' => false, 'z1' => false, 'view' => true] as $who => $exp) {
        $run('A3 can_move_vehicle для роли ' . $who . ' = ' . ($exp ? 'true' : 'false') . ' (admin и viewer — да, supervisor — нет)', function () use ($board, $who, $exp, $P) {
            eq($board($who, $P[0], $P[1])['json']['can_move_vehicle'] ?? null, $exp, 'can_move_vehicle');
            return 'ok';
        });
    }
    $run('A4 только GET: admin POST/PUT/DELETE → 405 method_not_allowed; аноним POST → 401', function () use ($boardQ, $err, $P) {
        foreach (['POST', 'PUT', 'DELETE', 'PATCH'] as $m) {
            $err($boardQ('admin', 'from=' . $P[0] . '&to=' . $P[1], $m), 405, 'method_not_allowed');
        }
        $err($boardQ('anon', 'from=' . $P[0] . '&to=' . $P[1], 'POST'), 401, 'unauthorized');
        return 'ok';
    });
    $run('A5 параметры: нет from/to, пустые, не-даты (2032-02-30, 2032-13-01, "abc", SQL-инъекция, массив) → 422', function () use ($boardQ) {
        foreach (['', 'from=2032-03-10', 'to=2032-03-10', 'from=&to=', 'from=2032-02-30&to=2032-03-02', 'from=2032-03-01&to=2032-13-01',
            'from=abc&to=def', 'from=' . rawurlencode("2032-03-01';DROP TABLE vehicles;--") . '&to=2032-03-02', 'from[]=2032-03-01&to=2032-03-02', 'from=2032-3-1&to=2032-3-2',
            'from=' . rawurlencode('2032-03-01T10:00') . '&to=2032-03-02'] as $q) {
            $r = $boardQ('admin', $q);
            eq($r['status'], 422, 'HTTP для «' . $q . '»: ' . substr($r['raw'], 0, 160));
            ok(is_string($r['json']['error'] ?? null) && $r['json']['error'] !== '', 'код ошибки для «' . $q . '»');
        }
        return 'ok';
    });
    $run('A6 to < from → 422 invalid_range', function () use ($boardQ, $err) {
        $err($boardQ('admin', 'from=2032-03-10&to=2032-03-09'), 422, 'invalid_range');
        return 'ok';
    });
    $run('A7 период ≤ 31 дня включительно: 31 день (март) → 200; 32 дня → 422 range_too_long; 1 день → 200; 1 год → 422', function () use ($boardQ, $err) {
        eq($boardQ('admin', 'from=2032-03-01&to=2032-03-31')['status'], 200, '31 день');
        $r = $boardQ('admin', 'from=2032-03-01&to=2032-04-01');
        $err($r, 422, 'range_too_long');
        eq($r['json']['max_days'] ?? null, 31, 'max_days');
        eq($boardQ('admin', 'from=2032-03-10&to=2032-03-10')['status'], 200, '1 день');
        $err($boardQ('admin', 'from=2032-01-01&to=2032-12-31'), 422, 'range_too_long');
        eq($boardQ('admin', 'from=2032-02-01&to=2032-03-02')['status'], 200, '2032-02-01…03-02 = 31 день (февраль високосный, 29 дней)');
        eq($boardQ('admin', 'from=2032-02-01&to=2032-03-03')['status'], 422, '…03-03 = 32 дня');
        return 'ok';
    });

    // =====================================================================
    // Состав доски
    // =====================================================================
    $run('B1 базы с ТС: обе базы по sort_order, у каждой vehicles с текущим base_id; поля ТС по контракту', function () use ($board, $ids, $P) {
        $r = $board('view', $P[0], $P[1]);
        $bases = [];
        foreach ($r['json']['bases'] as $b) { $bases[$b['id']] = $b; }
        ok(isset($bases[$ids['b1']], $bases[$ids['b2']]), 'нет баз: ' . implode(',', array_keys($bases)));
        eq(array_keys($bases[$ids['b1']]), ['id', 'name', 'sort_order', 'vehicles'], 'поля базы');
        eq($bases[$ids['b1']]['name'], 'Тест-База А', 'имя базы');
        eq(array_column($bases[$ids['b1']]['vehicles'], 'id'), [$ids['v1'], $ids['v2']], 'ТС базы А по sort_order');
        eq(array_column($bases[$ids['b2']]['vehicles'], 'id'), [$ids['v3']], 'ТС базы Б');
        $v = $bases[$ids['b2']]['vehicles'][0];
        eq(array_keys($v), ['id', 'name', 'plate', 'base_id', 'status', 'default_driver_id', 'sort_order', 'version'], 'поля ТС');
        eq([$v['plate'], $v['status'], $v['base_id'], $v['version']], ['Т003ТТ86', 'repair', $ids['b2'], 1], 'значения ТС');
        $order = array_keys($bases);
        ok(array_search($ids['b1'], $order, true) < array_search($ids['b2'], $order, true), 'базы по sort_order');
        return 'ok';
    });
    $run('B2 назначения периода 10–16.03: ровно a1, a2, a5, a6, a7, a9, a10; вне периода (a3 кончилось в 00:00 10.03, a4 началось 00:00 17.03, a8 — май) нет', function () use ($board, $assignedIds, $P) {
        eq($assignedIds($board('admin', $P[0], $P[1])), ['tbd_a1', 'tbd_a10', 'tbd_a2', 'tbd_a5', 'tbd_a6', 'tbd_a7', 'tbd_a9'], 'id назначений');
        return 'ok';
    });
    $run('B3 назначения отсортированы по start_at, затем id', function () use ($board, $P) {
        $a = $board('admin', $P[0], $P[1])['json']['assignments'];
        $keys = array_map(fn($x) => $x['start_at'] . '|' . $x['id'], $a);
        $sorted = $keys; sort($sorted);
        eq($keys, $sorted, 'порядок');
        return 'ok';
    });
    $run('B4 поля назначения: id, request_id, vehicle_id, base_id (текущая база ТС), driver_id/driver_name, crew, stops, start_at, end_at, duration_min, version, days, request', function () use ($board, $ids, $P) {
        $a = null;
        foreach ($board('admin', $P[0], $P[1])['json']['assignments'] as $x) { if ($x['id'] === 'tbd_a1') { $a = $x; } }
        ok($a !== null, 'a1 не найдено');
        eq(array_keys($a), ['id', 'request_id', 'vehicle_id', 'base_id', 'driver_id', 'driver_name', 'crew', 'stops', 'start_at', 'end_at', 'duration_min', 'version', 'days', 'request'], 'ключи назначения');
        eq([$a['request_id'], $a['vehicle_id'], $a['base_id'], $a['driver_id'], $a['driver_name']], ['tbd_r1', $ids['v1'], $ids['b1'], 'tbd_d1', 'Водителев Первый'], 'связи');
        eq([$a['start_at'], $a['end_at'], $a['duration_min'], $a['version']], ['2032-03-10T09:00', '2032-03-10T11:00', 120, 4], 'время и версия');
        eq($a['crew'], [['employee_id' => 'tbd_c1', 'name' => 'Бригадов Один'], ['employee_id' => 'tbd_c2', 'name' => 'Бригадов Два']], 'бригада');
        eq($a['days'], ['2032-03-10'], 'days');
        return 'ok';
    });
    $run('B5 остановки назначения: порядок ord, kind, place, координаты и целые/дробные поля; null сохраняются', function () use ($board, $P) {
        $a = null;
        foreach ($board('admin', $P[0], $P[1])['json']['assignments'] as $x) { if ($x['id'] === 'tbd_a1') { $a = $x; } }
        eq(count($a['stops']), 3, 'число остановок');
        eq($a['stops'][0], ['ord' => 0, 'kind' => 'departure', 'place' => 'Тест-База А', 'lat' => 60.1, 'lon' => 65.2, 'stay_min' => 0, 'leg_km' => null, 'leg_min_map' => null, 'leg_min' => 0], 'старт');
        eq($a['stops'][1], ['ord' => 1, 'kind' => 'intermediate', 'place' => 'Тестпункт Средний', 'lat' => 60.5, 'lon' => 65.9, 'stay_min' => 15, 'leg_km' => 12.5, 'leg_min_map' => 30, 'leg_min' => 30], 'промежуточная');
        eq([$a['stops'][2]['lat'], $a['stops'][2]['lon'], $a['stops'][2]['kind']], [null, null, 'arrival'], 'без координат');
        return 'ok';
    });
    $run('B6 карточка заявки в назначении: id, display_no, title, subscriber, address, status, version, created_by(_name), can_edit; без комментария заявки', function () use ($board, $P) {
        $a = null;
        foreach ($board('view', $P[0], $P[1])['json']['assignments'] as $x) { if ($x['id'] === 'tbd_a2') { $a = $x; } }
        eq(array_keys($a['request']), ['id', 'display_no', 'title', 'subscriber', 'address', 'status', 'version', 'created_by', 'created_by_name', 'can_edit'], 'ключи заявки');
        eq([$a['request']['id'], $a['request']['display_no'], $a['request']['title'], $a['request']['status'], $a['request']['version']],
            ['tbd_r2', 9002, 'Заявка 2 (zone1)', 'assigned', 3], 'значения');
        eq([$a['request']['created_by'], $a['request']['created_by_name'], $a['request']['subscriber'], $a['request']['address']],
            ['supervisor_zone1', 'supervisor_zone1', 'Абонент-tbd_r2', 'Адрес-tbd_r2'], 'автор и контакты');
        return 'ok';
    });
    $run('B7 чужие заявки видны всем ролям: viewer, zone0, zone1, admin видят одинаковый набор назначений', function () use ($board, $assignedIds, $P) {
        $exp = $assignedIds($board('admin', $P[0], $P[1]));
        ok(count($exp) >= 7, 'доска пуста: ' . count($exp));
        foreach (['view', 'z0', 'z1'] as $who) {
            eq($assignedIds($board($who, $P[0], $P[1])), $exp, 'набор для ' . $who);
        }
        return count($exp) . ' назначений';
    });

    // ---- Границы дат и полночь
    $run('C1 назначение через полночь (a2: 12.03 22:00 → 13.03 02:00) попадает в оба дня: доска за 12.03 и за 13.03 содержит a2; days = [12, 13]', function () use ($board, $assignedIds) {
        foreach (['2032-03-12', '2032-03-13'] as $d) {
            ok(in_array('tbd_a2', $assignedIds($board('admin', $d, $d)), true), 'a2 в день ' . $d);
        }
        foreach (['2032-03-11', '2032-03-14'] as $d) {
            ok(!in_array('tbd_a2', $assignedIds($board('admin', $d, $d)), true), 'a2 НЕ в день ' . $d);
        }
        $a = null;
        foreach ($board('admin', '2032-03-10', '2032-03-16')['json']['assignments'] as $x) { if ($x['id'] === 'tbd_a2') { $a = $x; } }
        eq($a['days'], ['2032-03-12', '2032-03-13'], 'days');
        return 'ok';
    });
    $run('C2 граница «конец ровно в 00:00»: a3 (09.03 22:00–10.03 00:00) есть на 09.03 и нет на 10.03; days = [09.03]', function () use ($board, $assignedIds) {
        ok(in_array('tbd_a3', $assignedIds($board('admin', '2032-03-09', '2032-03-09')), true), 'a3 в 09.03');
        ok(!in_array('tbd_a3', $assignedIds($board('admin', '2032-03-10', '2032-03-10')), true), 'a3 не в 10.03');
        $a = $board('admin', '2032-03-08', '2032-03-10')['json']['assignments'];
        $a3 = array_values(array_filter($a, fn($x) => $x['id'] === 'tbd_a3'))[0];
        eq($a3['days'], ['2032-03-09'], 'days a3');
        return 'ok';
    });
    $run('C3 граница «начало ровно в 00:00»: a4 (17.03 00:00) есть на 17.03 и нет на 16.03', function () use ($board, $assignedIds) {
        ok(in_array('tbd_a4', $assignedIds($board('admin', '2032-03-17', '2032-03-17')), true), 'a4 в 17.03');
        ok(!in_array('tbd_a4', $assignedIds($board('admin', '2032-03-16', '2032-03-16')), true), 'a4 не в 16.03');
        return 'ok';
    });
    $run('C4 последний квант периода: a5 (16.03 23:45–17.03 00:00) на 16.03 есть (days=[16.03]), на 17.03 нет', function () use ($board, $assignedIds) {
        ok(in_array('tbd_a5', $assignedIds($board('admin', '2032-03-16', '2032-03-16')), true), 'a5 в 16.03');
        ok(!in_array('tbd_a5', $assignedIds($board('admin', '2032-03-17', '2032-03-17')), true), 'a5 не в 17.03');
        return 'ok';
    });
    $run('C5 назначение, начатое до периода (a6: 09.03 23:00 → 10.03 02:00), есть на доске 10–16.03 с days = [10.03] (дни обрезаны периодом)', function () use ($board) {
        $a = array_values(array_filter($board('admin', '2032-03-10', '2032-03-16')['json']['assignments'], fn($x) => $x['id'] === 'tbd_a6'));
        eq(count($a), 1, 'a6 в периоде');
        eq($a[0]['days'], ['2032-03-10'], 'days');
        eq($a[0]['start_at'], '2032-03-09T23:00', 'start_at не обрезается');
        return 'ok';
    });
    $run('C6 многодневное назначение (a7: 14.03 08:00 → 17.03 08:00): days внутри периода = [14, 15, 16]; на 17.03 есть, на 13.03 нет', function () use ($board, $assignedIds) {
        $a = array_values(array_filter($board('admin', '2032-03-10', '2032-03-16')['json']['assignments'], fn($x) => $x['id'] === 'tbd_a7'));
        eq($a[0]['days'], ['2032-03-14', '2032-03-15', '2032-03-16'], 'days');
        ok(in_array('tbd_a7', $assignedIds($board('admin', '2032-03-17', '2032-03-17')), true), 'a7 в 17.03');
        ok(!in_array('tbd_a7', $assignedIds($board('admin', '2032-03-13', '2032-03-13')), true), 'a7 не в 13.03');
        return 'ok';
    });
    $run('C7 пустой период — пустые assignments/absences, базы всё равно приходят', function () use ($board, $ids) {
        $r = $board('admin', '2031-01-01', '2031-01-07');
        eq([$r['json']['assignments'], $r['json']['absences']], [[], []], 'пусто');
        ok(count($r['json']['bases']) >= 2, 'базы есть');
        return 'ok';
    });

    // ---- Очередь нераспределённых
    $run('D1 очередь: status=new без назначений — n1, n2, n3 по display_no; new с назначением (nx1), assigned/done/cancelled без назначений не попадают', function () use ($board, $queueNos, $P) {
        $r = $board('admin', $P[0], $P[1]);
        eq($queueNos($r), [9101, 9102, 9103], 'display_no очереди');
        eq(array_column($r['json']['queue'], 'status'), ['new', 'new', 'new'], 'статусы');
        return 'ok';
    });
    $run('D2 очередь не зависит от периода (заявка без дат): другой период — та же очередь; видна всем ролям', function () use ($board, $queueNos) {
        foreach (['admin', 'z0', 'z1', 'view'] as $who) {
            eq($queueNos($board($who, '2031-01-01', '2031-01-07')), [9101, 9102, 9103], 'очередь для ' . $who);
        }
        return 'ok';
    });
    $run('D3 элемент очереди — карточка заявки (те же поля, что request в назначении, включая can_edit)', function () use ($board, $P) {
        $q = $board('admin', $P[0], $P[1])['json']['queue'][0];
        eq(array_keys($q), ['id', 'display_no', 'title', 'subscriber', 'address', 'status', 'version', 'created_by', 'created_by_name', 'can_edit'], 'ключи');
        eq([$q['id'], $q['title'], $q['created_by']], ['tbd_n1', 'Очередь 1 (admin)', 'admin'], 'значения');
        return 'ok';
    });
    $run('D4 заявка из очереди после появления назначения уходит из очереди (прямая вставка) и возвращается после удаления', function () use ($board, $queueNos, $insAsg, $ids, $pdo, $P) {
        $insAsg('tbd_a_tmp', 'tbd_n3', $ids['v3'], 'tbd_d1', '2032-03-12T10:00', 60);
        try {
            eq($queueNos($board('admin', $P[0], $P[1])), [9101, 9102], 'без n3');
            eq($queueNos($board('admin', '2031-01-01', '2031-01-02')), [9101, 9102], 'без n3 и в другом периоде (назначение есть, заявка не «нераспределённая»)');
        } finally {
            $pdo->exec("DELETE FROM transport_assignments WHERE id = 'tbd_a_tmp'");
        }
        eq($queueNos($board('admin', $P[0], $P[1])), [9101, 9102, 9103], 'после удаления');
        return 'ok';
    });

    // ---- can_edit
    $canEdit = fn(array $r): array => (function () use ($r) {
        $m = [];
        foreach ($r['json']['assignments'] as $a) { $m[$a['request']['id']] = $a['request']['can_edit']; }
        foreach ($r['json']['queue'] as $q) { $m[$q['id']] = $q['can_edit']; }
        ksort($m);
        return $m;
    })();
    $matrix = [
        'admin' => ['tbd_n1' => true, 'tbd_n2' => true, 'tbd_n3' => true, 'tbd_r1' => true, 'tbd_r2' => true, 'tbd_r3' => true, 'tbd_r6' => true, 'tbd_r7' => true, 'tbd_r8' => true, 'tbd_nx1' => true],
        'z0'    => ['tbd_n1' => false, 'tbd_n2' => true, 'tbd_n3' => true, 'tbd_r1' => false, 'tbd_r2' => true, 'tbd_r3' => true, 'tbd_r6' => true, 'tbd_r7' => false, 'tbd_r8' => true, 'tbd_nx1' => false],
        'z1'    => ['tbd_n1' => false, 'tbd_n2' => true, 'tbd_n3' => false, 'tbd_r1' => false, 'tbd_r2' => true, 'tbd_r3' => false, 'tbd_r6' => true, 'tbd_r7' => false, 'tbd_r8' => false, 'tbd_nx1' => false],
        'view'  => ['tbd_n1' => false, 'tbd_n2' => false, 'tbd_n3' => false, 'tbd_r1' => false, 'tbd_r2' => false, 'tbd_r3' => false, 'tbd_r6' => false, 'tbd_r7' => false, 'tbd_r8' => false, 'tbd_nx1' => false],
    ];
    foreach ($matrix as $who => $exp) {
        $run('E1 can_edit по заявкам для роли ' . $who . ' (admin — все; zone0 — свои и заявки zone1; zone1 — только свои; viewer — никогда)', function () use ($board, $canEdit, $who, $exp, $P) {
            $got = $canEdit($board($who, $P[0], $P[1]));
            $want = $exp;
            // в ответе есть только заявки периода и очереди
            $want = array_intersect_key($want, $got);
            ksort($want);
            eq(array_intersect_key($got, $want), $want, 'can_edit');
            ok(count($want) >= 8, 'проверено заявок: ' . count($want));
            return count($want) . ' заявок';
        });
    }

    // ---- Отсутствия
    $run('F1 отсутствия подсвечиваются: ровно {employee_id, date, type} для водителей/бригады периода, тип отпуск/болезнь/отгул/командировка/прогноз командировки', function () use ($board, $P) {
        $abs = $board('admin', $P[0], $P[1])['json']['absences'];
        $got = array_map(fn($a) => $a['employee_id'] . '|' . $a['date'] . '|' . $a['type'], $abs);
        sort($got);
        $exp = [
            'tbd_c1|2032-03-13|day_off',
            'tbd_c2|2032-03-10|trip', 'tbd_c2|2032-03-11|trip',
            'tbd_d1|2032-03-11|vacation',
            'tbd_d2|2032-03-12|sick',
            'tbd_d2|2032-03-15|trip_forecast', 'tbd_d2|2032-03-16|trip_forecast',
            'tbd_p1|2032-03-14|vacation',
        ];
        sort($exp);
        eq($got, $exp, 'absences');
        foreach ($abs as $a) { eq(array_keys($a), ['employee_id', 'date', 'type'], 'ключи отсутствия'); }
        return count($abs) . ' отсутствий';
    });
    $run('F2 не попадают: посторонний сотрудник (отпуск и командировка), отпуск вне периода (20.03), статус «work»; отсутствия в узком периоде — только внутри него', function () use ($board) {
        $r = $board('admin', '2032-03-11', '2032-03-11');
        $got = array_map(fn($a) => $a['employee_id'] . '|' . $a['date'] . '|' . $a['type'], $r['json']['absences']);
        sort($got);
        eq($got, ['tbd_d1|2032-03-11|vacation'], 'отсутствия 11.03 (c2 в командировке, но его назначение — 10.03, вне окна: на доске его нет)');
        foreach ($board('admin', '2032-03-10', '2032-03-16')['json']['absences'] as $a) {
            ok($a['employee_id'] !== 'tbd_x', 'посторонний в absences');
            ok($a['date'] >= '2032-03-10' && $a['date'] <= '2032-03-16', 'дата вне периода: ' . $a['date']);
        }
        return 'ok';
    });
    $run('F3 отсутствия не дублируются (отпуск и командировка в один день — две записи разных типов, одинаковые — одна) и отсортированы по дате и сотруднику', function () use ($board, $insAbs, $insTrip, $pdo, $P) {
        $insAbs('tbd_d1', '2032-03-12', 'vacation');
        $insTrip('tbd_t4', 'tbd_d1', '2032-03-12', '2032-03-12', 'confirmed');
        $insTrip('tbd_t5', 'tbd_d1', '2032-03-12', '2032-03-12', 'confirmed');   // дубль командировки того же типа
        try {
            $abs = array_values(array_filter($board('admin', $P[0], $P[1])['json']['absences'], fn($a) => $a['employee_id'] === 'tbd_d1' && $a['date'] === '2032-03-12'));
            eq(array_map(fn($a) => $a['type'], $abs), ['trip', 'vacation'], 'два типа, без дубля');
            $all = array_map(fn($a) => $a['date'] . '|' . $a['employee_id'], $board('admin', $P[0], $P[1])['json']['absences']);
            $sorted = $all; sort($sorted);
            eq($all, $sorted, 'порядок по дате');
        } finally {
            $pdo->exec("DELETE FROM schedule_entries WHERE employee_id = 'tbd_d1' AND date = '2032-03-12'");
            $pdo->exec("DELETE FROM trips WHERE id IN ('tbd_t4', 'tbd_t5')");
        }
        return 'ok';
    });
    $run('F4 приватность: в ответе нет телефона/фото сотрудников, комментариев заявок/отпусков/командировок, целей и мест командировок', function () use ($board, $P) {
        foreach (['admin', 'view'] as $who) {
            $resp = $board($who, $P[0], $P[1]);
            eq($resp['status'], 200, 'доска ' . $who);
            $raw = $resp['raw'];
            foreach (['+7990PHONE', 'photos/', 'phone', 'photo', 'СекретныйКомментарийЗаявки', 'СекретныйКомментарийОтпуска', 'СекретнаяЦельКомандировки',
                'СекретныйПунктНазначения', 'СекретныйКомментарийКомандировки', '+7990TRIPPHONE', 'password', 'is_admin'] as $needle) {
                ok(stripos($raw, $needle) === false, 'утечка «' . $needle . '» для ' . $who);
            }
        }
        return 'ok';
    });

    // ---- Чтение не меняет данные
    $run('G1 чтение доски (все роли, все варианты ошибок) ничего не меняет: БД и журнал до/после совпадают', function () use ($board, $boardQ, $fingerprint, $P) {
        $before = $fingerprint();
        eq($board('admin', $P[0], $P[1])['status'], 200, 'доска отвечает');
        foreach (['admin', 'z0', 'z1', 'view', 'anon'] as $who) { $board($who, $P[0], $P[1]); }
        $boardQ('admin', 'from=bad&to=bad');
        $boardQ('admin', 'from=2032-01-01&to=2032-12-31');
        eq($fingerprint(), $before, 'состояние');
        return 'ok';
    });

    // ---- Перенос ТС виден на доске
    $run('H1 перенос ТС (viewer, action=move): доска показывает ТС в новой базе, version+1; назначения прежних дат остаются у ТС, base_id назначения — текущая база ТС', function () use ($veh, $board, $ids, $P) {
        $r = $veh('view', 'POST', '?action=move&id=' . $ids['v1'], ['base_id' => $ids['b2'], 'version' => 1]);
        eq($r['status'], 200, 'move: ' . substr($r['raw'], 0, 200));
        $b = $board('admin', $P[0], $P[1]);
        $bases = [];
        foreach ($b['json']['bases'] as $x) { $bases[$x['id']] = array_column($x['vehicles'], null, 'id'); }
        ok(!isset($bases[$ids['b1']][$ids['v1']]), 'v1 больше не в базе А');
        ok(isset($bases[$ids['b2']][$ids['v1']]), 'v1 в базе Б');
        eq([$bases[$ids['b2']][$ids['v1']]['base_id'], $bases[$ids['b2']][$ids['v1']]['version']], [$ids['b2'], 2], 'base_id/version');
        eq(array_column($bases[$ids['b1']], 'id'), [$ids['v2']], 'в базе А остался v2');
        $a1 = array_values(array_filter($b['json']['assignments'], fn($x) => $x['id'] === 'tbd_a1'))[0];
        eq([$a1['vehicle_id'], $a1['base_id']], [$ids['v1'], $ids['b2']], 'назначение a1 осталось на v1; base_id — текущая');
        eq($a1['start_at'], '2032-03-10T09:00', 'время не изменилось');
        return 'ok';
    });
    $run('H2 перенос виден и viewer-у, и supervisor-у (одна и та же картина), перенос обратно (admin) возвращает ТС в базу А', function () use ($veh, $board, $ids, $P) {
        foreach (['z0', 'view'] as $who) {
            $b = $board($who, $P[0], $P[1]);
            $inB2 = [];
            foreach ($b['json']['bases'] as $x) { if ($x['id'] === $ids['b2']) { $inB2 = array_column($x['vehicles'], 'id'); } }
            eq($inB2, [$ids['v1'], $ids['v3']], 'базa Б для ' . $who);
        }
        eq($veh('admin', 'POST', '?action=move&id=' . $ids['v1'], ['base_id' => $ids['b1'], 'version' => 2])['status'], 200, 'move back');
        $b = $board('admin', $P[0], $P[1]);
        foreach ($b['json']['bases'] as $x) { if ($x['id'] === $ids['b1']) { eq(array_column($x['vehicles'], 'id'), [$ids['v1'], $ids['v2']], 'базa А'); } }
        return 'ok';
    });
    $run('H3 смена статуса ТС (ремонт) и новая база видны на доске без перезапуска (чтение — всегда свежее)', function () use ($veh, $board, $ids, $P) {
        $r = $veh('admin', 'PUT', '?entity=vehicle&id=' . $ids['v2'], ['version' => 1, 'status' => 'repair']);
        eq($r['status'], 200, 'PUT: ' . substr($r['raw'], 0, 160));
        $nb = $veh('admin', 'POST', '?entity=base', ['name' => 'Тест-База В (пустая)', 'sort_order' => 3]);
        eq($nb['status'], 201, 'база');
        $b = $board('view', $P[0], $P[1]);
        $st = [];
        foreach ($b['json']['bases'] as $x) { foreach ($x['vehicles'] as $v) { $st[$v['id']] = $v['status']; } }
        eq($st[$ids['v2']], 'repair', 'v2 repair');
        $empty = array_values(array_filter($b['json']['bases'], fn($x) => $x['id'] === $nb['json']['base']['id']));
        eq(count($empty), 1, 'пустая база на доске');
        eq($empty[0]['vehicles'], [], 'без ТС');
        return 'ok';
    });

    // =====================================================================
    // CLI: tb_build_board / tb_can_edit_map / число SQL-запросов
    // =====================================================================
    $U = fn(string $login): array => $allUsers[$login];
    $run('K1 tb_can_edit_map равен transport_can_edit_request для каждой пары (пользователь × автор): admin, zone0, zone1, viewer, аноним × admin, zone0, zone1, viewer, неизвестный, пусто', function () use ($cpdo, $U) {
        need('tb_can_edit_map');
        $authors = ['admin', 'supervisor_zone0', 'supervisor_zone1', 'viewer_test', 'ghost_user', '', null];
        $reqs = [];
        foreach ($authors as $i => $a) { $reqs[] = ['id' => 'r' . $i, 'created_by' => $a]; }
        $n = 0;
        foreach (['admin', 'supervisor_zone0', 'supervisor_zone1', 'viewer_test', null] as $login) {
            $user = $login === null ? null : $U($login);
            $map = tb_can_edit_map($cpdo, $reqs, $user);
            foreach ($reqs as $r) {
                eq($map[$r['id']] ?? null, transport_can_edit_request($r, $user, $cpdo), 'user=' . ($login ?? 'anon') . ' author=' . json_encode($r['created_by']));
                $n++;
            }
        }
        return $n . ' пар';
    });
    $run('K2 tb_build_board вызывается с явным пользователем и совпадает с HTTP-ответом по составу (assignments, queue, absences)', function () use ($cpdo, $U, $board, $assignedIds, $P) {
        need('tb_build_board');
        $d = tb_build_board($cpdo, $P[0], $P[1], $U('admin'));
        $http = $board('admin', $P[0], $P[1])['json'];
        eq(array_map(fn($a) => $a['id'], $d['assignments']), array_map(fn($a) => $a['id'], $http['assignments']), 'assignments');
        eq(array_map(fn($a) => $a['id'], $d['queue']), array_map(fn($a) => $a['id'], $http['queue']), 'queue');
        eq(count($d['absences']), count($http['absences']), 'absences');
        eq($d['can_move_vehicle'], true, 'admin can_move');
        if (($dump = getenv('TRANSPORTBOARD_DUMP')) !== false && $dump !== '') {   // пример ответа для отчёта (синтетика)
            file_put_contents($dump, json_encode(tb_build_board($cpdo, '2032-03-12', '2032-03-13', $U('supervisor_zone0')), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_PRESERVE_ZERO_FRACTION));
        }
        return 'ok';
    });
    $run('K3 число SQL-запросов доски не зависит от числа назначений (N+1 нет): 5 назначений vs +60 (с бригадой, остановками, заявками zone1, отсутствиями) — одно и то же число', function () use ($cpdo, $U, $pdo, $insReq, $insAsg, $insAbs, $ids, $P) {
        need('tb_build_board');
        $counts = [];
        foreach (['admin', 'supervisor_zone0', 'viewer_test'] as $login) {
            CountingPDO::reset();
            $d0 = tb_build_board($cpdo, $P[0], $P[1], $U($login));
            $counts[$login] = [CountingPDO::$n, count($d0['assignments'])];
        }
        $stops = [[0, 'departure', 'А', 60.0, 65.0, 0, null, null, 0], [1, 'arrival', 'Б', 61.0, 66.0, 0, 10.0, 15, 15]];
        for ($i = 1; $i <= 60; $i++) {
            $rid = sprintf('tbd_bulk_r%02d', $i);
            $insReq($rid, 9500 + $i, 'Массовая ' . $i, $i % 2 ? 'assigned' : 'in_progress', $i % 3 === 0 ? 'supervisor_zone1' : ($i % 3 === 1 ? 'supervisor_zone0' : 'admin'), 'u');
            $insAsg(sprintf('tbd_bulk_a%02d', $i), $rid, [$ids['v1'], $ids['v2'], $ids['v3']][$i % 3], $i % 2 ? 'tbd_d1' : 'tbd_d2',
                sprintf('2032-03-%02dT%02d:00', 10 + $i % 7, 6 + $i % 12), 60, ['tbd_c1', 'tbd_c2', 'tbd_c3'], $stops);
        }
        $insAbs('tbd_c3', '2032-03-15', 'sick');
        $after = [];
        foreach (['admin', 'supervisor_zone0', 'viewer_test'] as $login) {
            CountingPDO::reset();
            $d1 = tb_build_board($cpdo, $P[0], $P[1], $U($login));
            $after[$login] = [CountingPDO::$n, count($d1['assignments'])];
            ok($after[$login][1] >= $counts[$login][1] + 60, 'назначений стало больше: ' . json_encode($after[$login]));
            eq($after[$login][0], $counts[$login][0], 'число запросов для ' . $login . ' (было ' . $counts[$login][0] . ' при ' . $counts[$login][1] . ' назначениях)');
            ok($after[$login][0] <= 16, 'число запросов ограничено константой ≤ 16: ' . $after[$login][0]);
        }
        $d = tb_build_board($cpdo, $P[0], $P[1], $U('supervisor_zone0'));
        $own = 0;
        foreach ($d['assignments'] as $a) { if ($a['request']['can_edit']) { $own++; } }
        ok($own >= 40, 'can_edit у zone0 посчитан для множества заявок (без запроса на каждую): ' . $own);
        return 'запросов: admin ' . $after['admin'][0] . ', zone0 ' . $after['supervisor_zone0'][0] . ', viewer ' . $after['viewer_test'][0] . ' при ' . $after['admin'][1] . ' назначениях; SQL: ' . count(CountingPDO::$log);
    });
    $run('K4 после массовых фикстур HTTP-доска отвечает 200, данные совпадают с CLI, ответ детерминирован (два запроса подряд идентичны)', function () use ($board, $P) {
        $a = $board('admin', $P[0], $P[1]);
        $b = $board('admin', $P[0], $P[1]);
        eq($a['status'], 200, 'status');
        eq($a['raw'], $b['raw'], 'идентичность ответов');
        ok(count($a['json']['assignments']) >= 65, 'назначений: ' . count($a['json']['assignments']));
        return count($a['json']['assignments']) . ' назначений';
    });
    $run('K5 сразу после запросов к доске БД не получила записей журнала и миграций «на лету» (journal count неизменен при чтении)', function () use ($board, $cnt, $P) {
        $n = $cnt('transport_journal');
        eq($board('admin', $P[0], $P[1])['status'], 200, 'доска отвечает');
        $board('view', $P[0], $P[1]);
        eq($cnt('transport_journal'), $n, 'журнал');
        return 'ok';
    });

    // =====================================================================
    // Журнал: доступ
    // =====================================================================
    $run('J1 журнал без сессии → 401 unauthorized (JSON и CSV)', function () use ($jr, $err) {
        $err($jr('anon'), 401, 'unauthorized');
        $err($jr('anon', 'format=csv'), 401, 'unauthorized');
        return 'ok';
    });
    foreach (['z0' => 'supervisor_zone0', 'z1' => 'supervisor_zone1', 'view' => 'viewer_test'] as $who => $uname) {
        $run('J2 журнал: ' . $uname . ' → 403 forbidden (JSON и CSV), данных нет', function () use ($jr, $err, $who) {
            $r = $jr($who);
            $err($r, 403, 'forbidden');
            ok(!isset($r['json']['items']), 'items не отдаются');
            $c = $jr($who, 'format=csv');
            $err($c, 403, 'forbidden');
            ok(strpos($c['raw'], 'entity_type') === false, 'CSV не отдаётся');
            return 'ok';
        });
    }
    $run('J3 журнал: admin GET → 200; только GET: admin POST/PUT/DELETE/PATCH → 405; viewer POST → 403; аноним POST → 401', function () use ($jr, $err) {
        eq($jr('admin')['status'], 200, 'GET');
        foreach (['POST', 'PUT', 'DELETE', 'PATCH'] as $m) {
            $err($jr('admin', '', $m), 405, 'method_not_allowed');
        }
        $err($jr('view', '', 'POST'), 403, 'forbidden');
        $err($jr('anon', '', 'POST'), 401, 'unauthorized');
        return 'ok';
    });

    // ---- Журнал: фикстуры
    $J = [];
    $J[1] = $insJ('2031-12-30T10:00:00+05:00', 'tbd_actor_a', 'admin', 'tbd.create', 'tbd_ent', 'tbd_e1', null, '{"k":1,"имя":"Ёж"}');
    $J[2] = $insJ('2031-12-31T23:59:59+05:00', 'tbd_actor_a', 'admin', 'tbd.update', 'tbd_ent', 'tbd_e1', '{"k":1}', '{"k":2}', '[{"code":"vehicle_overlap","severity":"warning"}]');
    $J[3] = $insJ('2032-01-01T00:00:00+05:00', 'tbd_actor_b', 'supervisor', 'tbd.update', 'tbd_ent', 'tbd_e2', '{"k":1}', '{"k":3}');
    $J[4] = $insJ('2032-01-01T12:00:00+05:00', 'tbd_actor_b', 'supervisor', 'tbd.delete', 'tbd_ent', 'tbd_e2', '{"k":3}', null);
    $J[5] = $insJ('2032-01-02T00:00:00+05:00', 'tbd_actor_a', 'admin', 'tbd.create', 'tbd_ent', 'tbd_e3', null, '{"k":5}');
    $jids = fn(array $r): array => array_map(fn($x) => $x['id'], $r['json']['items'] ?? []);
    $jsort = function (array $ids): array { sort($ids); return $ids; };

    $run('L1 журнал JSON: формат {success, total, limit, offset, items[]}; элемент — id, ts, actor, role, action, entity_type, entity_id, before, after, warnings (JSON разобран)', function () use ($jr, $J) {
        $r = $jr('admin', 'entity_type=tbd_ent&limit=50');
        eq($r['status'], 200, 'status ' . substr($r['raw'], 0, 200));
        eq([$r['json']['success'], $r['json']['total'], $r['json']['limit'], $r['json']['offset']], [true, 5, 50, 0], 'шапка');
        eq(count($r['json']['items']), 5, 'элементов');
        $it = array_column($r['json']['items'], null, 'id');
        eq(array_keys($it[$J[2]]), ['id', 'ts', 'actor', 'role', 'action', 'entity_type', 'entity_id', 'before', 'after', 'warnings'], 'ключи');
        eq($it[$J[2]]['before'], ['k' => 1], 'before разобран');
        eq($it[$J[2]]['after'], ['k' => 2], 'after разобран');
        eq($it[$J[2]]['warnings'], [['code' => 'vehicle_overlap', 'severity' => 'warning']], 'warnings разобраны');
        eq($it[$J[1]]['before'], null, 'before NULL');
        eq($it[$J[1]]['after'], ['k' => 1, 'имя' => 'Ёж'], 'кириллица');
        eq($it[$J[4]]['after'], null, 'after NULL');
        eq($it[$J[1]]['id'], $J[1], 'id целое');
        ok(is_int($it[$J[1]]['id']), 'id — int');
        return 'ok';
    });
    $run('L2 порядок: новые сверху (id по убыванию)', function () use ($jr, $jids, $J) {
        eq($jids($jr('admin', 'entity_type=tbd_ent')), [$J[5], $J[4], $J[3], $J[2], $J[1]], 'порядок');
        return 'ok';
    });
    $run('L3 фильтр entity_type: tbd_ent — 5 записей, несуществующий тип — пусто с total 0', function () use ($jr, $jids) {
        eq(count($jids($jr('admin', 'entity_type=tbd_ent'))), 5, 'tbd_ent');
        $r = $jr('admin', 'entity_type=no_such_type');
        eq([$r['status'], $r['json']['items'], $r['json']['total']], [200, [], 0], 'пусто');
        return 'ok';
    });
    $run('L4 фильтр entity_id: tbd_e1 — записи 1,2; tbd_e2 — 3,4; вместе с entity_type', function () use ($jr, $jids, $J, $jsort) {
        eq($jsort($jids($jr('admin', 'entity_type=tbd_ent&entity_id=tbd_e1'))), $jsort([$J[1], $J[2]]), 'e1');
        eq($jsort($jids($jr('admin', 'entity_type=tbd_ent&entity_id=tbd_e2'))), $jsort([$J[3], $J[4]]), 'e2');
        eq($jsort($jids($jr('admin', 'entity_id=tbd_e3'))), [$J[5]], 'только entity_id');
        return 'ok';
    });
    $run('L5 фильтр actor: tbd_actor_a — 1,2,5; tbd_actor_b — 3,4; точное совпадение (префикс tbd_actor не подходит)', function () use ($jr, $jids, $J, $jsort) {
        eq($jsort($jids($jr('admin', 'actor=tbd_actor_a'))), $jsort([$J[1], $J[2], $J[5]]), 'a');
        eq($jsort($jids($jr('admin', 'actor=tbd_actor_b'))), $jsort([$J[3], $J[4]]), 'b');
        eq($jids($jr('admin', 'actor=tbd_actor')), [], 'префикс');
        return 'ok';
    });
    $run('L6 фильтр action: tbd.update — 2,3; tbd.create — 1,5; tbd.delete — 4', function () use ($jr, $jids, $J, $jsort) {
        eq($jsort($jids($jr('admin', 'action=tbd.update'))), $jsort([$J[2], $J[3]]), 'update');
        eq($jsort($jids($jr('admin', 'action=tbd.create'))), $jsort([$J[1], $J[5]]), 'create');
        eq($jids($jr('admin', 'action=tbd.delete')), [$J[4]], 'delete');
        return 'ok';
    });
    $run('L7 фильтр по датам: from=2032-01-01 — записи 3,4,5 (включая 00:00:00), to=2031-12-31 — 1,2 (включая 23:59:59), день 2032-01-01 — 3,4', function () use ($jr, $jids, $J, $jsort) {
        eq($jsort($jids($jr('admin', 'entity_type=tbd_ent&from=2032-01-01'))), $jsort([$J[3], $J[4], $J[5]]), 'from');
        eq($jsort($jids($jr('admin', 'entity_type=tbd_ent&to=2031-12-31'))), $jsort([$J[1], $J[2]]), 'to');
        eq($jsort($jids($jr('admin', 'entity_type=tbd_ent&from=2032-01-01&to=2032-01-01'))), $jsort([$J[3], $J[4]]), 'день');
        eq($jsort($jids($jr('admin', 'entity_type=tbd_ent&from=2031-12-31&to=2032-01-02'))), $jsort([$J[2], $J[3], $J[4], $J[5]]), 'от 31.12 до 02.01');
        eq($jids($jr('admin', 'entity_type=tbd_ent&from=2032-01-03')), [], 'после всех');
        return 'ok';
    });
    $run('L8 комбинация фильтров (AND): actor=tbd_actor_a + action=tbd.update + from=2031-12-31 → запись 2; actor=b + action=create → пусто', function () use ($jr, $jids, $J) {
        eq($jids($jr('admin', 'actor=tbd_actor_a&action=tbd.update&from=2031-12-31')), [$J[2]], 'a+update');
        eq($jids($jr('admin', 'actor=tbd_actor_b&action=tbd.create')), [], 'b+create');
        eq($jids($jr('admin', 'entity_type=tbd_ent&entity_id=tbd_e1&actor=tbd_actor_a&action=tbd.create&from=2031-12-30&to=2031-12-30')), [$J[1]], 'все фильтры');
        return 'ok';
    });
    $run('L9 фильтры безопасны: SQL-спецсимволы и % _ в значениях — как обычный текст (0 результатов), таблица цела', function () use ($jr, $jids, $cnt) {
        $n = $cnt('transport_journal');
        foreach (["x' OR '1'='1", 'tbd%', 'tbd_actor_%', '"; DROP TABLE transport_journal;--', "\\"] as $v) {
            $r = $jr('admin', 'actor=' . rawurlencode($v));
            eq([$r['status'], $jids($r)], [200, []], 'actor=' . $v);
            $r = $jr('admin', 'entity_type=' . rawurlencode($v) . '&action=' . rawurlencode($v));
            eq([$r['status'], $jids($r)], [200, []], 'entity_type=' . $v);
        }
        eq($cnt('transport_journal'), $n, 'журнал цел');
        return 'ok';
    });
    $run('L10 неверные параметры → 422: from/to не дата, from > to, limit 0/-1/abc, offset -1/abc, format=xml', function () use ($jr, $err) {
        $err($jr('admin', 'from=2032-02-30'), 422, 'invalid_from');
        $err($jr('admin', 'to=abc'), 422, 'invalid_to');
        $err($jr('admin', 'from=2032-02-02&to=2032-02-01'), 422, 'invalid_range');
        foreach (['limit=0', 'limit=-1', 'limit=abc', 'limit=1.5'] as $q) { $err($jr('admin', $q), 422, 'invalid_limit'); }
        foreach (['offset=-1', 'offset=abc'] as $q) { $err($jr('admin', $q), 422, 'invalid_offset'); }
        $err($jr('admin', 'format=xml'), 422, 'invalid_format');
        return 'ok';
    });

    // ---- Пагинация (205 строк)
    $pdo->beginTransaction();
    for ($i = 1; $i <= 205; $i++) {
        $insJ('2032-02-01T00:00:00+05:00', 'tbd_bulk', 'admin', 'tbd.bulk', 'tbd_bulk', 'bulk_' . $i, null, '{"i":' . $i . '}');
    }
    $pdo->commit();
    $run('M1 пагинация: limit=2 страницами offset 0,2,4… собирает все 205 записей без дублей и пропусков; total = 205 на каждой странице; порядок — id по убыванию', function () use ($jr, $jids) {
        $all = [];
        for ($off = 0; $off < 210; $off += 2) {
            $r = $jr('admin', 'entity_type=tbd_bulk&limit=2&offset=' . $off);
            eq($r['status'], 200, 'status');
            eq($r['json']['total'], 205, 'total');
            eq([$r['json']['limit'], $r['json']['offset']], [2, $off], 'эхо limit/offset');
            foreach ($jids($r) as $id) { $all[] = $id; }
        }
        eq(count($all), 205, 'всего собрано');
        eq(count(array_unique($all)), 205, 'без дублей');
        $sorted = $all; rsort($sorted);
        eq($all, $sorted, 'убывание id');
        return '205 записей';
    });
    $run('M2 лимиты: по умолчанию 50; limit=200 → 200 записей; limit=500 → зажимается до 200 (в ответе limit=200)', function () use ($jr, $jids) {
        $r = $jr('admin', 'entity_type=tbd_bulk');
        eq([count($jids($r)), $r['json']['limit']], [50, 50], 'по умолчанию');
        $r = $jr('admin', 'entity_type=tbd_bulk&limit=200');
        eq([count($jids($r)), $r['json']['limit']], [200, 200], '200');
        $r = $jr('admin', 'entity_type=tbd_bulk&limit=500');
        eq([$r['status'], count($jids($r)), $r['json']['limit'], $r['json']['total']], [200, 200, 200, 205], 'зажим');
        return 'ok';
    });
    $run('M3 offset за концом → пусто (total прежний); последняя страница неполная: offset=200&limit=10 → 5 записей', function () use ($jr, $jids) {
        $r = $jr('admin', 'entity_type=tbd_bulk&limit=10&offset=1000');
        eq([$jids($r), $r['json']['total']], [[], 205], 'за концом');
        eq(count($jids($jr('admin', 'entity_type=tbd_bulk&limit=10&offset=200'))), 5, 'хвост');
        return 'ok';
    });

    // ---- CSV
    $jSeedCsv = function () use ($insJ): array {
        $ids = [];
        $ids['plain'] = $insJ('2032-02-02T10:00:00+05:00', 'csv_plain', 'admin', 'csv.plain', 'tbd_csv', 'c_plain', '{"a":1}', '{"a":2}');
        $ids['eq']    = $insJ('2032-02-02T10:01:00+05:00', '=HYPERLINK("http://x.test","клик")', '+admin', '-cmd', 'tbd_csv', '@SUM(A1)', '=1+1', "\t=2+2");
        $ids['semi']  = $insJ('2032-02-02T10:02:00+05:00', 'csv;semi', 'admin', 'csv.semi', 'tbd_csv', 'c;semi', '{"a":"x;y"}', "line1\nline2\r\nline3");
        $ids['quote'] = $insJ('2032-02-02T10:03:00+05:00', 'say "hi"', 'admin', 'csv.quote', 'tbd_csv', 'c_quote', null, '{"q":"\\"\\""}');
        $ids['cr']    = $insJ('2032-02-02T10:04:00+05:00', "\r=cmd", 'admin', "'=already", 'tbd_csv', 'c_cr', null, null);
        return $ids;
    };
    $C = $jSeedCsv();
    /** Разбор CSV (BOM, «;») в массив строк. */
    $parseCsv = function (string $raw): array {
        ok(strncmp($raw, "\xEF\xBB\xBF", 3) === 0, 'нет BOM');
        $h = fopen('php://memory', 'w+');
        fwrite($h, substr($raw, 3));
        rewind($h);
        $rows = [];
        while (($row = fgetcsv($h, 0, ';', '"', '')) !== false) { $rows[] = $row; }
        fclose($h);
        return $rows;
    };
    $run('N1 CSV: Content-Type text/csv; charset=utf-8, Content-Disposition attachment *.csv, no-store, BOM, заголовок колонок, «;»', function () use ($jr, $parseCsv) {
        $r = $jr('admin', 'format=csv&entity_type=tbd_csv');
        eq($r['status'], 200, 'status');
        ok((bool) preg_match('~^content-type:\s*text/csv;\s*charset=utf-8~mi', $r['head']), 'Content-Type: ' . $r['head']);
        ok((bool) preg_match('~^content-disposition:\s*attachment;\s*filename="[^"]+\.csv"~mi', $r['head']), 'Content-Disposition');
        ok((bool) preg_match('~^cache-control:.*no-store~mi', $r['head']), 'no-store');
        $rows = $parseCsv($r['raw']);
        eq($rows[0], ['id', 'ts', 'actor', 'role', 'action', 'entity_type', 'entity_id', 'before_json', 'after_json', 'warnings_json'], 'заголовок');
        eq(count($rows), 6, 'шапка + 5 записей');
        return 'ok';
    });
    $run('N2 CSV: ячейки, начинающиеся с = + - @ (а также TAB/CR), получают префикс «\'» (защита от формул) в actor, role, action, entity_id, after_json; обычные не меняются', function () use ($jr, $parseCsv, $C) {
        $rows = $parseCsv($jr('admin', 'format=csv&entity_type=tbd_csv')['raw']);
        $by = [];
        foreach (array_slice($rows, 1) as $row) { $by[(int) $row[0]] = $row; }
        $r = $by[$C['eq']];
        eq($r[2], "'=HYPERLINK(\"http://x.test\",\"клик\")", 'actor');
        eq($r[3], "'+admin", 'role');
        eq($r[4], "'-cmd", 'action');
        eq($r[6], "'@SUM(A1)", 'entity_id');
        eq($r[7], "'=1+1", 'before_json');
        eq($r[8], "'\t=2+2", 'after_json (TAB)');
        eq($by[$C['cr']][2], "'\r=cmd", 'actor (CR)');
        eq($by[$C['cr']][4], "'=already", 'action, начинающийся с апострофа, — не формула: без изменений');
        eq($by[$C['plain']][2], 'csv_plain', 'обычная ячейка не тронута');
        return 'ok';
    });
    $run('N3 CSV: ни одна ячейка данных (кроме заголовка) не начинается с = + - @ TAB CR — по всему выгрузке журнала (без фильтров)', function () use ($jr, $parseCsv) {
        $r = $jr('admin', 'format=csv');
        $rows = $parseCsv($r['raw']);
        ok(count($rows) > 200, 'строк: ' . count($rows));
        foreach (array_slice($rows, 1) as $row) {
            foreach ($row as $cell) {
                ok($cell === '' || strpbrk($cell[0], "=+-@\t\r") === false, 'опасная ячейка: ' . $cell);
            }
        }
        return count($rows) - 1 . ' строк';
    });
    $run('N4 CSV: разделитель, кавычки и переводы строк внутри ячеек экранируются (RFC 4180): значения возвращаются разбором без потерь', function () use ($jr, $parseCsv, $C) {
        $rows = $parseCsv($jr('admin', 'format=csv&entity_type=tbd_csv')['raw']);
        $by = [];
        foreach (array_slice($rows, 1) as $row) { $by[(int) $row[0]] = $row; }
        eq([$by[$C['semi']][2], $by[$C['semi']][6], $by[$C['semi']][7]], ['csv;semi', 'c;semi', '{"a":"x;y"}'], 'точка с запятой');
        eq($by[$C['semi']][8], "line1\nline2\r\nline3", 'переводы строк');
        eq($by[$C['quote']][2], 'say "hi"', 'кавычки');
        eq($by[$C['quote']][8], '{"q":"\\"\\""}', 'JSON с кавычками');
        foreach ($by as $row) { eq(count($row), 10, 'число колонок'); }
        return 'ok';
    });
    $run('N5 CSV учитывает фильтры (actor, action, from/to) и не ограничен 200 строками: bulk (205 записей) выгружается целиком', function () use ($jr, $parseCsv, $J) {
        $rows = $parseCsv($jr('admin', 'format=csv&actor=tbd_actor_a&action=tbd.create')['raw']);
        eq(array_map(fn($r) => (int) $r[0], array_slice($rows, 1)), [$J[5], $J[1]], 'фильтры в CSV');
        $rows = $parseCsv($jr('admin', 'format=csv&entity_type=tbd_bulk')['raw']);
        eq(count($rows) - 1, 205, 'строк bulk');
        $rows = $parseCsv($jr('admin', 'format=csv&from=2031-12-31&to=2031-12-31&entity_type=tbd_ent')['raw']);
        eq(count($rows) - 1, 1, 'по дате');
        return 'ok';
    });
    $run('N6 CSV: limit/offset тоже работают (limit=3&offset=1 над bulk → 3 строки, начиная со второй по id)', function () use ($jr, $parseCsv, $jids) {
        $json = $jr('admin', 'entity_type=tbd_bulk&limit=4&offset=0');
        $exp = array_slice($jids($json), 1, 3);
        $rows = $parseCsv($jr('admin', 'format=csv&entity_type=tbd_bulk&limit=3&offset=1')['raw']);
        eq(array_map(fn($r) => (int) $r[0], array_slice($rows, 1)), $exp, 'строки');
        return 'ok';
    });
    $run('N7 JSON отдаёт значения без CSV-префикса (экранирование — только в выгрузке)', function () use ($jr, $C) {
        $r = $jr('admin', 'entity_type=tbd_csv');
        $it = array_column($r['json']['items'], null, 'id');
        eq($it[$C['eq']]['actor'], '=HYPERLINK("http://x.test","клик")', 'actor как есть');
        eq($it[$C['eq']]['action'], '-cmd', 'action как есть');
        return 'ok';
    });

    // ---- Журнал: реальные события модуля и неизменность при чтении
    $run('P1 записи, созданные T1 (base.create, vehicle.create, vehicle.move), читаются через API: actor/role/action/entity, before/after перемещения', function () use ($jr, $ids) {
        $r = $jr('admin', 'action=vehicle.move&entity_id=' . rawurlencode($ids['v1']));
        eq($r['status'], 200, 'status');
        eq(count($r['json']['items']), 2, 'два переноса (туда и обратно)');
        $new = $r['json']['items'][0];   // последний — обратно в А (admin)
        $old = $r['json']['items'][1];   // первый — в Б (viewer_test)
        eq([$old['actor'], $old['role'], $old['entity_type']], ['viewer_test', 'viewer', 'vehicle'], 'viewer перенёс');
        eq([$old['before'], $old['after']], [['base_id' => $ids['b1']], ['base_id' => $ids['b2']]], 'before/after');
        eq([$new['actor'], $new['role']], ['admin', 'admin'], 'admin вернул');
        $c = $jr('admin', 'action=base.create');
        ok(count($c['json']['items']) >= 3, 'base.create: ' . count($c['json']['items']));
        return 'ok';
    });
    $run('P2 чтение журнала (JSON, CSV, фильтры, ошибки, отказы разным ролям) не меняет журнал и БД: отпечаток до/после совпадает', function () use ($jr, $fingerprint) {
        $before = $fingerprint();
        eq($jr('admin')['status'], 200, 'журнал отвечает');
        eq($jr('admin', 'format=csv')['status'], 200, 'CSV отвечает');
        $jr('admin'); $jr('admin', 'format=csv'); $jr('admin', 'entity_type=tbd_bulk&limit=7&offset=3');
        $jr('admin', 'limit=abc'); $jr('admin', 'format=xml'); $jr('admin', '', 'POST'); $jr('admin', '', 'DELETE');
        foreach (['z0', 'z1', 'view', 'anon'] as $w) { $jr($w); $jr($w, 'format=csv'); }
        eq($fingerprint(), $before, 'состояние');
        return 'ok';
    });
    $run('P3 append-only не нарушен чтением: прямой UPDATE/DELETE записи журнала по-прежнему запрещён триггером; запись, считанная через API, равна строке БД', function () use ($pdo, $jr, $J) {
        foreach (["UPDATE transport_journal SET actor = 'x' WHERE id = {$J[1]}", "DELETE FROM transport_journal WHERE id = {$J[1]}"] as $sql) {
            try { $pdo->exec($sql); throw new RuntimeException('ожидался отказ: ' . $sql); }
            catch (PDOException $e) { ok(stripos($e->getMessage(), 'append-only') !== false, $e->getMessage()); }
        }
        $row = $pdo->query("SELECT * FROM transport_journal WHERE id = {$J[2]}")->fetch(PDO::FETCH_ASSOC);
        $it = $jr('admin', 'entity_id=tbd_e1&action=tbd.update')['json']['items'][0];
        eq([$it['ts'], $it['actor'], $it['role'], $it['action'], $it['entity_type'], $it['entity_id']],
            [$row['ts'], $row['actor'], $row['role'], $row['action'], $row['entity_type'], $row['entity_id']], 'совпадение с БД');
        eq(json_encode($it['before']), $row['before_json'], 'before');
        return 'ok';
    });
    $run('P4 отказ не-admin не раскрывает существование записей: тело 403 — только {error}', function () use ($jr) {
        foreach (['z0', 'z1', 'view'] as $w) {
            eq(array_keys($jr($w, 'entity_type=tbd_ent')['json']), ['error'], 'ключи для ' . $w);
        }
        return 'ok';
    });
} finally {
    proc_terminate($proc);
    foreach ($cookies as $c) { @unlink($c); }
    @unlink($serverLog);
}

// Файлы сессии от auth.php и временные файлы.
if (function_exists('session_id') && session_id() !== '') {
    @unlink(rtrim(session_save_path(), '/') . '/sess_' . session_id());
}

// Явно закрываем соединения и удаляем копию БД.
unset($pdo, $cpdo, $db);
@unlink($tmpDb);
@unlink($tmpDb . '-wal');
@unlink($tmpDb . '-shm');

$realDbHashAfter = is_file($realDb) ? sha1_file($realDb) : '';
$dbIntact = ($realDbHashBefore === $realDbHashAfter);

out('=== RESULTS: ' . $passed . ' passed, ' . $failed . ' failed out of ' . ($passed + $failed) . ' ===');
out('DB intact: ' . ($dbIntact ? 'YES' : 'NO'));
exit(($failed === 0 && $dbIntact) ? 0 : 1);
