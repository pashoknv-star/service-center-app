<?php

declare(strict_types=1);

/**
 * V10-T3 (ADR_DB) — замер параллельной записи в SQLite. ОДНОРАЗОВЫЙ скрипт, в gate не входит.
 *
 * Что меряет: N параллельных писателей (отдельные процессы PHP — как отдельные запросы Apache/PHP)
 * выполняют транзакцию «проверить пересечение ТС по времени + вставить назначение + вставить журнал»
 * в трёх режимах транзакции (none / deferred / immediate) и двух режимах журнала SQLite (wal / delete).
 *   none      — без транзакции (автокоммит, «проверил → вставил» двумя отдельными операциями);
 *   deferred  — `BEGIN` (ровно то, что делает PDO::beginTransaction() во всём текущем коде проекта);
 *   immediate — `BEGIN IMMEDIATE`.
 * Каждая операция открывает НОВОЕ соединение и ставит PRAGMA в том же порядке, что api/db.php:723-726
 * (journal_mode, foreign_keys, busy_timeout=5000), потому что в проде соединение живёт один запрос.
 *
 * ДАННЫЕ ПРОДА НЕ ТРОГАЕТ: источник только копируется (cp) во временный каталог; все записи — в копию.
 * Таблицы замера (t3_assignments, t3_journal) создаются ТОЛЬКО в копии и не совпадают с именами схемы v15.
 *
 * Запуск (из корня репозитория):
 *   php scripts/spike/v10_t3_concurrency.php matrix --writers=1,2,4,8 --modes=wal,delete \
 *       --tx=none,deferred,immediate --ops=150 --work-ms=3 --out=/path/result.json
 *   php scripts/spike/v10_t3_concurrency.php matrix --transport=http ...   # через php -S + PHP_CLI_SERVER_WORKERS
 *   php scripts/spike/v10_t3_concurrency.php probe                          # факты о PDO/SQLite этой машины
 * Параметры matrix (в скобках — умолчание):
 *   --src=<файл БД-источник> (data/app.db)   --tmp=<каталог> ($TMPDIR/v10_t3)   --ops=<операций на писателя> (150)
 *   --work-ms=<пауза внутри транзакции между проверкой и вставкой, имитация логики приложения> (3)
 *   --retries=<повторов после SQLITE_BUSY, с паузой 5–25 мс> (0)   --transport=proc|http (proc)
 *   --bg-hold-ms=<длина фонового «длинного писателя» вроде save.php; 0 — нет> (0)  --bg-period-ms=<период> (200)
 *   --contest=<доля операций, где все писатели борются за один и тот же слот ТС> (0.5)
 */

const T3_BUSY_MS = 5000;

/** Стадия операции — для диагностики, где именно прилетел SQLITE_BUSY. */
$GLOBALS['t3_stage'] = '';

// ---------------------------------------------------------------------------------------------
// Общие функции
// ---------------------------------------------------------------------------------------------

function t3_open(string $db, string $mode): PDO
{
    // Копия api/db.php:717-726 (те же опции PDO, тот же порядок PRAGMA), только режим журнала параметризован.
    $pdo = new PDO('sqlite:' . $db, null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ]);
    $GLOBALS['t3_stage'] = 'connect:journal_mode';
    $pdo->exec('PRAGMA journal_mode = ' . ($mode === 'wal' ? 'WAL' : 'DELETE'));
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA busy_timeout = ' . T3_BUSY_MS);
    return $pdo;
}

function t3_is_busy(Throwable $e): bool
{
    if (!($e instanceof PDOException)) {
        return false;
    }
    $code = is_array($e->errorInfo ?? null) ? (int) ($e->errorInfo[1] ?? 0) : 0;
    return $code === 5 || $code === 6 || stripos($e->getMessage(), 'database is locked') !== false
        || stripos($e->getMessage(), 'database table is locked') !== false;
}

function t3_ts(int $minutes): string
{
    // Наивная локальная строка YYYY-MM-DDTHH:MM (формат времени модуля, 00_COMMON.md «Решения координатора»).
    return gmdate('Y-m-d\TH:i', 1796083200 + $minutes * 60); // 2026-12-01T00:00 как точка отсчёта
}

/** Цель операции: [vehicle_id, start_minutes, len_slots, kind]. Шаг сетки — 15 мин. */
function t3_target(array $c, int $w, int $seq): array
{
    $contestEvery = max(1, (int) round(1 / max(0.01, (float) $c['contest'])));
    if ($seq % $contestEvery === 0) {
        // Спорная: на шаге $seq все писатели целятся в один и тот же слот одного и того же ТС.
        $step = intdiv($seq, $contestEvery);
        $veh = 1 + ($step % 6);
        $startSlot = $step * 8;                 // слоты разных шагов не пересекаются (длина ≤ 4)
        $len = 1 + (($w * 7 + $seq) % 4);       // 1..4 слота; любые два интервала с общим началом пересекаются
        return [$veh, $startSlot * 15, $len, 'contested'];
    }
    // Приватная: ТС писателя (100+w), никогда не пересекается с чужими.
    return [100 + $w, $seq * 4 * 15, 2, 'private'];
}

/** Одна операция. Возвращает 'ok' | 'conflict' (законный отказ по пересечению); бросает при ошибке БД. */
function t3_op(PDO $pdo, array $c, int $w, int $seq): string
{
    [$veh, $startMin, $len, $kind] = t3_target($c, $w, $seq);
    $s = t3_ts($startMin);
    $e = t3_ts($startMin + $len * 15);
    $tx = (string) $c['tx'];

    $GLOBALS['t3_stage'] = 'begin';
    if ($tx === 'immediate') {
        $pdo->exec('BEGIN IMMEDIATE');
    } elseif ($tx === 'deferred') {
        $pdo->exec('BEGIN');
    }
    try {
        $GLOBALS['t3_stage'] = 'check(select)';
        $st = $pdo->prepare('SELECT COUNT(*) FROM t3_assignments WHERE vehicle_id = :v AND start_at < :e AND end_at > :s');
        $st->execute([':v' => $veh, ':e' => $e, ':s' => $s]);
        $cnt = (int) $st->fetchColumn();
        if (!empty($c['no_close_cursor'])) {
            // ЛОВУШКА (измеряется отдельно): fetchColumn() без closeCursor() оставляет SELECT «в процессе» — читающая
            // транзакция остаётся открытой до сброса/уничтожения оператора, и следующий INSERT в WAL может получить BUSY.
        } else {
            $st->closeCursor();
        }
        if ($cnt > 0) {
            if ($tx !== 'none') {
                $pdo->exec('ROLLBACK');
            }
            return 'conflict';
        }
        if ((int) $c['work_ms'] > 0) {
            usleep((int) $c['work_ms'] * 1000);   // «логика приложения» между проверкой и записью (окно гонки)
        }
        $GLOBALS['t3_stage'] = 'insert_assignment';
        $ins = $pdo->prepare('INSERT INTO t3_assignments (vehicle_id, start_at, end_at, duration_min, writer, seq, kind)
                              VALUES (:v, :s, :e, :d, :w, :q, :k)');
        $ins->execute([':v' => $veh, ':s' => $s, ':e' => $e, ':d' => $len * 15, ':w' => $w, ':q' => $seq, ':k' => $kind]);
        $aid = (int) $pdo->lastInsertId();
        $GLOBALS['t3_stage'] = 'insert_journal';
        $j = $pdo->prepare('INSERT INTO t3_journal (ts, actor, action, entity_type, entity_id, after_json)
                            VALUES (:ts, :a, :ac, :et, :ei, :aj)');
        $j->execute([
            ':ts' => gmdate('Y-m-d\TH:i:s+00:00'), ':a' => 'w' . $w, ':ac' => 'assignment.create',
            ':et' => 'assignment', ':ei' => (string) $aid,
            ':aj' => json_encode(['vehicle_id' => $veh, 'start_at' => $s, 'end_at' => $e, 'duration_min' => $len * 15]),
        ]);
        $GLOBALS['t3_stage'] = 'commit';
        if ($tx !== 'none') {
            $pdo->exec('COMMIT');
        }
        return 'ok';
    } catch (Throwable $ex) {
        if ($tx !== 'none') {
            try {
                $pdo->exec('ROLLBACK');
            } catch (Throwable $ignore) {
                // нет активной транзакции — нормально
            }
        }
        throw $ex;
    }
}

/** Цикл писателя. Возвращает ['lat'=>[ms…], 'out'=>[исход…], 'first_busy'=>int, 't0'=>ns, 't1'=>ns]. */
function t3_writer_loop(array $c, int $w, ?callable $doOne = null): array
{
    $lat = [];
    $out = [];
    $firstBusy = 0;
    $stages = [];
    // Барьер старта: все писатели стартуют в один момент (hrtime — монотонные часы, общие для процессов).
    $startAt = (int) $c['start_ns'];
    while (hrtime(true) < $startAt) {
        usleep(200);
    }
    $t0 = hrtime(true);
    mt_srand(1000 + $w);
    for ($seq = 0; $seq < (int) $c['ops']; $seq++) {
        $a = hrtime(true);
        $attempt = 0;
        $res = null;
        while (true) {
            try {
                $res = $doOne !== null ? $doOne($seq) : (function () use ($c, $w, $seq) {
                    $pdo = t3_open((string) $c['db'], (string) $c['mode']);   // новое соединение на каждую операцию
                    return t3_op($pdo, $c, $w, $seq);
                })();
                break;
            } catch (Throwable $e) {
                if (t3_is_busy($e)) {
                    if ($attempt === 0) {
                        $firstBusy++;
                        $st0 = (string) $GLOBALS['t3_stage'];
                        $stages[$st0] = ($stages[$st0] ?? 0) + 1;
                    }
                    if ($attempt < (int) $c['retries']) {
                        $attempt++;
                        usleep(mt_rand(5000, 25000));
                        continue;
                    }
                    $res = 'busy';
                } else {
                    $res = 'error:' . substr($e->getMessage(), 0, 80);
                }
                break;
            }
        }
        $lat[] = (hrtime(true) - $a) / 1e6;
        $out[] = $res;
    }
    return ['lat' => $lat, 'out' => $out, 'first_busy' => $firstBusy, 'stages' => $stages, 't0' => $t0, 't1' => hrtime(true)];
}

function t3_pct(array $v, float $p): float
{
    if (!$v) {
        return 0.0;
    }
    sort($v);
    $i = (int) ceil($p / 100 * count($v)) - 1;
    return (float) $v[max(0, min(count($v) - 1, $i))];
}

// ---------------------------------------------------------------------------------------------
// Режим php -S (router): /op?db=&mode=&tx=&w=&seq=&work_ms=&contest=
// ---------------------------------------------------------------------------------------------
if (PHP_SAPI === 'cli-server') {
    $q = $_GET;
    $c = ['db' => (string) ($q['db'] ?? ''), 'mode' => (string) ($q['mode'] ?? 'wal'), 'tx' => (string) ($q['tx'] ?? 'immediate'),
          'work_ms' => (int) ($q['work_ms'] ?? 0), 'contest' => (float) ($q['contest'] ?? 0.5), 'no_close_cursor' => !empty($q['ncc'])];
    header('Content-Type: application/json');
    try {
        $pdo = t3_open($c['db'], $c['mode']);
        echo json_encode(['r' => t3_op($pdo, $c, (int) ($q['w'] ?? 0), (int) ($q['seq'] ?? 0))]);
    } catch (Throwable $e) {
        echo json_encode(['r' => t3_is_busy($e) ? 'busy' : 'error:' . substr($e->getMessage(), 0, 80)]);
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Подкоманды CLI
// ---------------------------------------------------------------------------------------------
$argvIn = $argv ?? [];
$cmd = $argvIn[1] ?? '';
$opt = [];
foreach (array_slice($argvIn, 2) as $a) {
    if (preg_match('/^--([a-z0-9-]+)=(.*)$/', $a, $m)) {
        $opt[$m[1]] = $m[2];
    }
}

if ($cmd === 'worker') {            // внутренний: один писатель-процесс; конфиг — base64(JSON) в --cfg
    $c = json_decode((string) base64_decode($opt['cfg'] ?? ''), true);
    $w = (int) $c['w'];
    if (($c['transport'] ?? 'proc') === 'http') {
        $ch = curl_init();
        $res = t3_writer_loop($c, $w, function (int $seq) use ($c, $w, $ch) {
            $url = $c['url'] . '/op?' . http_build_query(['db' => $c['db'], 'mode' => $c['mode'], 'tx' => $c['tx'], 'w' => $w, 'seq' => $seq,
                                                          'work_ms' => $c['work_ms'], 'contest' => $c['contest'], 'ncc' => (int) ($c['no_close_cursor'] ?? 0)]);
            curl_setopt_array($ch, [CURLOPT_URL => $url, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30]);
            $body = curl_exec($ch);
            $j = is_string($body) ? json_decode($body, true) : null;
            if (!is_array($j)) {
                throw new RuntimeException('http failure');
            }
            if ($j['r'] === 'busy') {
                throw new PDOException('database is locked');
            }
            if (str_starts_with((string) $j['r'], 'error:')) {
                throw new RuntimeException((string) $j['r']);
            }
            return (string) $j['r'];
        });
    } else {
        $res = t3_writer_loop($c, $w);
    }
    echo json_encode($res);
    exit(0);
}

if ($cmd === 'bgwriter') {          // внутренний: «длинный писатель» вроде save.php — периодически держит блокировку записи
    $c = json_decode((string) base64_decode($opt['cfg'] ?? ''), true);
    $end = (int) $c['bg_end_ns'];
    while (hrtime(true) < (int) $c['start_ns']) {
        usleep(200);
    }
    $n = 0;
    $busy = 0;
    while (hrtime(true) < $end) {
        try {
            $pdo = t3_open((string) $c['db'], (string) $c['mode']);
            $pdo->exec('BEGIN IMMEDIATE');
            $pdo->exec("INSERT INTO t3_bg (ts) VALUES ('" . gmdate('c') . "')");
            usleep((int) $c['bg_hold_ms'] * 1000);
            $pdo->exec('COMMIT');
            $n++;
        } catch (Throwable $e) {
            $busy++;
        }
        usleep((int) $c['bg_period_ms'] * 1000);
    }
    echo json_encode(['bg_commits' => $n, 'bg_failed' => $busy]);
    exit(0);
}

if ($cmd === 'probe') {
    t3_probe();
    exit(0);
}

if ($cmd === 'matrix') {
    t3_matrix($opt);
    exit(0);
}

fwrite(STDERR, "usage: v10_t3_concurrency.php matrix|probe [--opt=val …] (см. заголовок файла)\n");
exit(2);

// ---------------------------------------------------------------------------------------------
// Оркестратор
// ---------------------------------------------------------------------------------------------

function t3_setup_copy(string $src, string $dst, string $mode): void
{
    foreach (['', '-wal', '-shm', '-journal'] as $suf) {
        @unlink($dst . $suf);
    }
    if (!copy($src, $dst)) {
        throw new RuntimeException("copy failed: $src -> $dst");
    }
    $pdo = new PDO('sqlite:' . $dst, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('PRAGMA journal_mode = ' . ($mode === 'wal' ? 'WAL' : 'DELETE'));
    $pdo->exec('CREATE TABLE t3_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, vehicle_id INTEGER NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
        duration_min INTEGER NOT NULL CHECK (duration_min % 15 = 0), writer INTEGER, seq INTEGER, kind TEXT)');
    $pdo->exec('CREATE INDEX t3_assign_v ON t3_assignments (vehicle_id, start_at, end_at)');
    $pdo->exec('CREATE TABLE t3_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT,
        before_json TEXT, after_json TEXT, warnings_json TEXT)');
    $pdo->exec("CREATE TRIGGER t3_journal_no_upd BEFORE UPDATE ON t3_journal BEGIN SELECT RAISE(ABORT, 'transport_journal is append-only'); END");
    $pdo->exec("CREATE TRIGGER t3_journal_no_del BEFORE DELETE ON t3_journal BEGIN SELECT RAISE(ABORT, 'transport_journal is append-only'); END");
    $pdo->exec('CREATE TABLE t3_bg (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT)');
    $pdo = null;
}

function t3_cell(array $o, string $mode, string $tx, int $n): array
{
    $db = $o['tmp'] . "/cell_{$mode}.db";
    t3_setup_copy($o['src'], $db, $mode);

    $url = null;
    $srv = null;
    $srvPipes = [];
    if ($o['transport'] === 'http') {
        $port = 18700 + random_int(0, 200);
        $url = "http://127.0.0.1:$port";
        $env = array_merge(getenv(), ['PHP_CLI_SERVER_WORKERS' => (string) max(2, $n)]);
        $srv = proc_open([PHP_BINARY, '-S', "127.0.0.1:$port", __FILE__], [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $srvPipes, null, $env);
        for ($i = 0; $i < 50; $i++) {
            $s = @fsockopen('127.0.0.1', $port, $en, $es, 0.1);
            if ($s) {
                fclose($s);
                break;
            }
            usleep(100000);
        }
    }

    $startNs = hrtime(true) + 1_200_000_000;     // барьер: через 1.2 с
    $cfg = ['db' => $db, 'mode' => $mode, 'tx' => $tx, 'ops' => $o['ops'], 'work_ms' => $o['work_ms'], 'retries' => $o['retries'],
            'contest' => $o['contest'], 'no_close_cursor' => $o['no_close_cursor'], 'start_ns' => $startNs, 'transport' => $o['transport'], 'url' => $url,
            'bg_hold_ms' => $o['bg_hold_ms'], 'bg_period_ms' => $o['bg_period_ms']];
    $procs = [];
    for ($w = 0; $w < $n; $w++) {
        $c = $cfg + ['w' => $w];
        $procs[$w] = t3_spawn(['worker', '--cfg=' . base64_encode(json_encode($c))]);
    }
    $bg = null;
    if ((int) $o['bg_hold_ms'] > 0) {
        // ориентир длительности: ops × (work + запас) × n — фон работает с запасом, потом процесс просто завершается
        $cfgBg = $cfg + ['bg_end_ns' => $startNs + (int) ((($o['ops'] * ($o['work_ms'] + 8) * max(1, $n)) + 3000) * 1e6)];
        $bg = t3_spawn(['bgwriter', '--cfg=' . base64_encode(json_encode($cfgBg))]);
    }
    $results = [];
    foreach ($procs as $w => $p) {
        $raw = t3_collect($p);
        $r = json_decode($raw, true);
        if (!is_array($r)) {
            throw new RuntimeException("worker $w returned garbage: " . substr($raw, 0, 300));
        }
        $results[$w] = $r;
    }
    $bgRes = $bg ? json_decode(t3_collect($bg), true) : null;
    if ($srv) {
        proc_terminate($srv);
        proc_close($srv);
    }

    // Агрегация
    $lat = [];
    $counts = ['ok' => 0, 'conflict' => 0, 'busy' => 0, 'error' => 0];
    $firstBusy = 0;
    $t0 = PHP_INT_MAX;
    $t1 = 0;
    $errs = [];
    $stages = [];
    foreach ($results as $r) {
        foreach ($r['stages'] as $k => $v) {
            $stages[$k] = ($stages[$k] ?? 0) + $v;
        }
        foreach ($r['lat'] as $l) {
            $lat[] = $l;
        }
        foreach ($r['out'] as $x) {
            if (isset($counts[$x])) {
                $counts[$x]++;
            } else {
                $counts['error']++;
                $errs[$x] = ($errs[$x] ?? 0) + 1;
            }
        }
        $firstBusy += (int) $r['first_busy'];
        $t0 = min($t0, (int) $r['t0']);
        $t1 = max($t1, (int) $r['t1']);
    }
    $wall = max(0.001, ($t1 - $t0) / 1e9);
    $total = $n * (int) $o['ops'];

    // Пост-проверка (нарушения)
    $chk = new PDO('sqlite:' . $db, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $chk->exec('PRAGMA busy_timeout = 30000');
    $overlaps = (int) $chk->query('SELECT COUNT(*) FROM t3_assignments a JOIN t3_assignments b
        ON a.vehicle_id = b.vehicle_id AND a.id < b.id AND a.start_at < b.end_at AND b.start_at < a.end_at')->fetchColumn();
    $rows = (int) $chk->query('SELECT COUNT(*) FROM t3_assignments')->fetchColumn();
    $jrows = (int) $chk->query('SELECT COUNT(*) FROM t3_journal')->fetchColumn();
    $noJournal = (int) $chk->query("SELECT COUNT(*) FROM t3_assignments a WHERE NOT EXISTS
        (SELECT 1 FROM t3_journal j WHERE j.entity_type='assignment' AND j.entity_id = CAST(a.id AS TEXT))")->fetchColumn();
    $orphanJ = (int) $chk->query("SELECT COUNT(*) FROM t3_journal j WHERE NOT EXISTS
        (SELECT 1 FROM t3_assignments a WHERE CAST(a.id AS TEXT) = j.entity_id)")->fetchColumn();
    $integrity = (string) $chk->query('PRAGMA integrity_check')->fetchColumn();
    $jm = (string) $chk->query('PRAGMA journal_mode')->fetchColumn();
    $contestedWinners = (int) $chk->query("SELECT COUNT(*) FROM t3_assignments WHERE kind='contested'")->fetchColumn();
    $contestedSteps = (int) $chk->query("SELECT COUNT(DISTINCT vehicle_id || ':' || start_at) FROM t3_assignments WHERE kind='contested'")->fetchColumn();
    $chk = null;

    return [
        'mode' => $mode, 'tx' => $tx, 'writers' => $n, 'ops_total' => $total,
        'ok' => $counts['ok'], 'conflict' => $counts['conflict'], 'busy' => $counts['busy'], 'error' => $counts['error'],
        'busy_first_attempt' => $firstBusy,
        'busy_pct' => round(100 * $counts['busy'] / $total, 2),
        'busy_first_pct' => round(100 * $firstBusy / $total, 2),
        'p50_ms' => round(t3_pct($lat, 50), 2), 'p95_ms' => round(t3_pct($lat, 95), 2),
        'p99_ms' => round(t3_pct($lat, 99), 2), 'max_ms' => round(max($lat), 1),
        'wall_s' => round($wall, 2), 'throughput_ops_s' => round($total / $wall, 1),
        'commits_s' => round($counts['ok'] / $wall, 1),
        'violations_overlap_pairs' => $overlaps,
        'contested_rows_over_distinct_slots' => $contestedWinners - $contestedSteps,
        'assignments_without_journal' => $noJournal, 'journal_without_assignment' => $orphanJ,
        'rows_assignments' => $rows, 'rows_journal' => $jrows,
        'integrity' => $integrity, 'journal_mode_after' => $jm,
        'bg' => $bgRes, 'error_samples' => $errs, 'busy_first_stages' => $stages,
    ];
}

function t3_spawn(array $args): array
{
    $cmd = array_merge([PHP_BINARY, __FILE__], $args);
    $p = proc_open($cmd, [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    return ['p' => $p, 'pipes' => $pipes];
}

function t3_collect(array $h): string
{
    $out = stream_get_contents($h['pipes'][1]);
    $err = stream_get_contents($h['pipes'][2]);
    fclose($h['pipes'][1]);
    fclose($h['pipes'][2]);
    proc_close($h['p']);
    if ($err !== '' && $err !== false) {
        fwrite(STDERR, $err);
    }
    return (string) $out;
}

function t3_matrix(array $opt): void
{
    $root = dirname(__DIR__, 2);
    $tmpEnv = getenv('TMPDIR') ?: sys_get_temp_dir();
    $o = [
        'src' => $opt['src'] ?? ($root . '/data/app.db'),
        'tmp' => $opt['tmp'] ?? ($tmpEnv . '/v10_t3'),
        'ops' => (int) ($opt['ops'] ?? 150),
        'work_ms' => (int) ($opt['work-ms'] ?? 3),
        'retries' => (int) ($opt['retries'] ?? 0),
        'transport' => $opt['transport'] ?? 'proc',
        'bg_hold_ms' => (int) ($opt['bg-hold-ms'] ?? 0),
        'bg_period_ms' => (int) ($opt['bg-period-ms'] ?? 200),
        'contest' => (float) ($opt['contest'] ?? 0.5),
        'no_close_cursor' => (int) ($opt['no-close-cursor'] ?? 0),
    ];
    $modes = explode(',', $opt['modes'] ?? 'wal,delete');
    $txs = explode(',', $opt['tx'] ?? 'none,deferred,immediate');
    $writers = array_map('intval', explode(',', $opt['writers'] ?? '1,2,4,8'));
    @mkdir($o['tmp'], 0775, true);

    $pdoV = new PDO('sqlite::memory:');
    $meta = [
        'php' => PHP_VERSION, 'sqlite' => (string) $pdoV->query('SELECT sqlite_version()')->fetchColumn(),
        'src' => $o['src'], 'src_sha1_before' => sha1_file($o['src']), 'src_bytes' => filesize($o['src']),
        'cpus' => (int) trim((string) @shell_exec('nproc')), 'options' => $o,
    ];
    echo "# V10-T3 concurrency matrix\n# " . json_encode($meta, JSON_UNESCAPED_SLASHES) . "\n";
    printf("%-6s %-9s %2s | %6s %6s %6s %6s | %6s %6s | %7s %7s %7s %7s | %7s %7s | %5s %5s %5s\n",
        'mode', 'tx', 'N', 'ok', 'confl', 'busy', 'err', 'busy%', '1st%', 'p50ms', 'p95ms', 'p99ms', 'max', 'ops/s', 'commit/s', 'viol', 'noJ', 'orphJ');
    $rows = [];
    foreach ($modes as $mode) {
        foreach ($txs as $tx) {
            foreach ($writers as $n) {
                $r = t3_cell($o, $mode, $tx, $n);
                $rows[] = $r;
                printf("%-6s %-9s %2d | %6d %6d %6d %6d | %6.2f %6.2f | %7.2f %7.2f %7.2f %7.1f | %7.1f %7.1f | %5d %5d %5d%s\n",
                    $mode, $tx, $n, $r['ok'], $r['conflict'], $r['busy'], $r['error'], $r['busy_pct'], $r['busy_first_pct'],
                    $r['p50_ms'], $r['p95_ms'], $r['p99_ms'], $r['max_ms'], $r['throughput_ops_s'], $r['commits_s'], $r['violations_overlap_pairs'],
                    $r['assignments_without_journal'], $r['journal_without_assignment'],
                    $r['integrity'] !== 'ok' ? '  INTEGRITY=' . $r['integrity'] : '');
                if ($r['bg']) {
                    echo '   bg writer: ' . json_encode($r['bg']) . "\n";
                }
                if ($r['busy_first_stages']) {
                    echo '   busy(1st attempt) by stage: ' . json_encode($r['busy_first_stages']) . "\n";
                }
                if ($r['error_samples']) {
                    echo '   error samples: ' . json_encode($r['error_samples'], JSON_UNESCAPED_UNICODE) . "\n";
                }
            }
        }
    }
    $meta['src_sha1_after'] = sha1_file($o['src']);
    echo '# src sha1 before=' . $meta['src_sha1_before'] . ' after=' . $meta['src_sha1_after'] . ' '
        . ($meta['src_sha1_before'] === $meta['src_sha1_after'] ? 'UNCHANGED' : 'CHANGED!!!') . "\n";
    if (isset($opt['out'])) {
        file_put_contents((string) $opt['out'], json_encode(['meta' => $meta, 'rows' => $rows], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }
}

// ---------------------------------------------------------------------------------------------
// probe: факты о PDO/SQLite на этой машине (вставляются в ADR_DB.md §1/§2)
// ---------------------------------------------------------------------------------------------
function t3_probe(): void
{
    $tmp = (getenv('TMPDIR') ?: sys_get_temp_dir()) . '/v10_t3';
    @mkdir($tmp, 0775, true);
    $db = $tmp . '/probe.db';
    foreach (['', '-wal', '-shm', '-journal'] as $suf) {
        @unlink($db . $suf);
    }
    $o = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION];
    echo 'php=' . PHP_VERSION . ' pdo_drivers=' . implode(',', PDO::getAvailableDrivers()) . "\n";
    $a = new PDO('sqlite:' . $db, null, null, $o);
    echo 'sqlite_version=' . $a->query('SELECT sqlite_version()')->fetchColumn() . "\n";
    echo 'PDO default busy_timeout (до PRAGMA) = ' . $a->query('PRAGMA busy_timeout')->fetchColumn() . " мс\n";
    $a->exec('PRAGMA journal_mode = WAL');
    $a->exec('PRAGMA foreign_keys = ON');
    $a->exec('PRAGMA busy_timeout = 5000');
    echo 'после PRAGMA как в api/db.php: busy_timeout=' . $a->query('PRAGMA busy_timeout')->fetchColumn()
        . ' journal_mode=' . $a->query('PRAGMA journal_mode')->fetchColumn()
        . ' synchronous=' . $a->query('PRAGMA synchronous')->fetchColumn() . ' (2=FULL, 1=NORMAL)'
        . ' wal_autocheckpoint=' . $a->query('PRAGMA wal_autocheckpoint')->fetchColumn()
        . ' foreign_keys=' . $a->query('PRAGMA foreign_keys')->fetchColumn()
        . ' recursive_triggers=' . $a->query('PRAGMA recursive_triggers')->fetchColumn() . "\n";
    $a->exec('CREATE TABLE p (id INTEGER PRIMARY KEY, v INTEGER)');
    $a->exec('INSERT INTO p VALUES (1, 0)');

    // 1) beginTransaction() — отложенный (DEFERRED): блокировку записи не берёт, второй писатель проходит.
    $b = new PDO('sqlite:' . $db, null, null, $o);
    $b->exec('PRAGMA busy_timeout = 300');
    $a->beginTransaction();
    $a->query('SELECT * FROM p')->fetchAll();
    $b->exec('BEGIN IMMEDIATE');           // если бы beginTransaction() брал блокировку записи — тут был бы SQLITE_BUSY
    $b->exec('UPDATE p SET v = v + 1');
    $b->exec('COMMIT');
    echo "1) PDO::beginTransaction()+SELECT не удерживает блокировку записи: BEGIN IMMEDIATE из другого соединения прошёл\n";
    // 2) а потом «повышение» устаревшего снимка до записи падает сразу (SQLITE_BUSY_SNAPSHOT), не дожидаясь busy_timeout
    $a->exec('PRAGMA busy_timeout = 5000');
    $t = hrtime(true);
    try {
        $a->exec('UPDATE p SET v = v + 10');
        echo "2) UPDATE после чужого коммита: прошёл (неожиданно)\n";
    } catch (PDOException $e) {
        printf("2) повышение read→write после чужого коммита: исключение через %.1f мс при busy_timeout=5000 (errorInfo=%s) — busy_timeout НЕ ждали\n",
            (hrtime(true) - $t) / 1e6, json_encode($e->errorInfo));
    }
    try {
        $a->rollBack();
    } catch (Throwable $e) {
    }

    // 3) exec('BEGIN IMMEDIATE') / commit() / inTransaction() на этой версии PHP
    $a->exec('BEGIN IMMEDIATE');
    echo '3) после exec(BEGIN IMMEDIATE): PDO::inTransaction()=' . var_export($a->inTransaction(), true);
    try {
        $a->commit();
        echo ' ; PDO::commit() — ok';
    } catch (Throwable $e) {
        echo ' ; PDO::commit() — ИСКЛЮЧЕНИЕ: ' . $e->getMessage();
        $a->exec('COMMIT');
    }
    echo " (PHP " . PHP_VERSION . "; на Hostland веб-PHP 8.1.34 — НЕ ПРОВЕРЕНО; безопасно использовать exec('COMMIT')/exec('ROLLBACK'))\n";

    // 4) таймаут ожидания блокировки писателя при BEGIN IMMEDIATE (busy_timeout=300): сколько ждёт и что бросает
    $a->exec('BEGIN IMMEDIATE');
    $b->exec('PRAGMA busy_timeout = 300');
    $t = hrtime(true);
    try {
        $b->exec('BEGIN IMMEDIATE');
        echo "4) второй BEGIN IMMEDIATE прошёл (неожиданно)\n";
    } catch (PDOException $e) {
        printf("4) второй BEGIN IMMEDIATE при занятом писателе: исключение через %.0f мс при busy_timeout=300 (errorInfo=%s)\n",
            (hrtime(true) - $t) / 1e6, json_encode($e->errorInfo));
    }
    $a->exec('ROLLBACK');
    echo 'compile_options (избранное): ' . implode(', ', array_filter(
        $a->query('PRAGMA compile_options')->fetchAll(PDO::FETCH_COLUMN),
        fn($x) => preg_match('/THREADSAFE|ENABLE_(RTREE|JSON1|FTS)|DEFAULT_(WAL_SYNCHRONOUS|SYNCHRONOUS)|MAX_|OMIT_/', $x)
    )) . "\n";
}
