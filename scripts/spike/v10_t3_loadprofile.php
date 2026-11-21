<?php

declare(strict_types=1);

/**
 * V10-T3 (ADR_DB, §3) — нагрузочный профиль модуля «Транспорт»: рост БД и скорость недельной доски на синтетических данных.
 * ОДНОРАЗОВЫЙ скрипт, в gate не входит. Работает ТОЛЬКО на копии (data/app.db копируется, не открывается на запись).
 *
 * ВАЖНО: в исходных материалах (`Модуль Транспорт/`, голосовые владельца) НЕТ чисел о числе ТС/заявок/назначений в сутки
 * (проверено grep по *.md и расшифровкой 3 голосовых). Поэтому профили ниже — ДОПУЩЕНИЯ (помечены в ADR_DB.md),
 * а скрипт измеряет ЛИНЕЙНО-МАСШТАБИРУЕМЫЕ величины (байт на запись, мс запроса на N строк): владелец подставляет свои числа.
 *
 * DDL — по reports/V10/PLAN.md §3 (схема v15 из T1 в этой ветке ещё не слита; колонки/индексы взяты из плана, не из кода).
 *
 * Запуск (из корня репозитория):
 *   php scripts/spike/v10_t3_loadprofile.php --scenario=s1 --years=1,3,5 --out=/path/s1.json
 * Сценарии (ДОПУЩЕНИЯ): s1: 8 ТС, 10 заявок/сутки; s2: 40 ТС, 50 заявок/сутки; s3: 150 ТС, 200 заявок/сутки.
 *   Остальное одинаково: 30% заявок — с двумя ТС (мульти-ТС), у назначения 2–4 остановки, экипаж 1–4, 8 записей журнала на заявку.
 * Опции: --src=<БД-источник> --tmp=<каталог> --events=<записей журнала на заявку> (8) --reps=<повторов замера> (200)
 */

$opt = [];
foreach (array_slice($argv, 1) as $a) {
    if (preg_match('/^--([a-z0-9-]+)=(.*)$/', $a, $m)) {
        $opt[$m[1]] = $m[2];
    }
}
$root = dirname(__DIR__, 2);
$tmpDir = $opt['tmp'] ?? ((getenv('TMPDIR') ?: sys_get_temp_dir()) . '/v10_t3');
@mkdir($tmpDir, 0775, true);
$src = $opt['src'] ?? ($root . '/data/app.db');
$scen = $opt['scenario'] ?? 's1';
$years = array_map('intval', explode(',', $opt['years'] ?? '1,3,5'));
$events = (int) ($opt['events'] ?? 8);
$reps = (int) ($opt['reps'] ?? 200);
$profiles = ['s1' => [8, 10], 's2' => [40, 50], 's3' => [150, 200]];
[$nVeh, $perDay] = $profiles[$scen] ?? $profiles['s1'];

$sha0 = sha1_file($src);
$db = $tmpDir . "/load_{$scen}.db";
foreach (['', '-wal', '-shm'] as $s) {
    @unlink($db . $s);
}
copy($src, $db);

function lp_open(string $db, bool $fast): PDO
{
    $pdo = new PDO('sqlite:' . $db, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->exec('PRAGMA journal_mode = WAL');          // как api/db.php:724-726
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    if ($fast) {
        $pdo->exec('PRAGMA synchronous = OFF');       // только на время генерации
    }
    return $pdo;
}

$pdo = lp_open($db, true);
$pdo->exec('CREATE TABLE transport_bases (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort_order INTEGER NOT NULL DEFAULT 0)');
$pdo->exec("CREATE TABLE vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, plate TEXT NOT NULL UNIQUE, base_id INTEGER NOT NULL REFERENCES transport_bases(id),
    status TEXT NOT NULL DEFAULT 'in_service', default_driver_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1)");
$pdo->exec("CREATE TABLE transport_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, display_no TEXT, title TEXT, subscriber TEXT, address TEXT, comment TEXT,
    status TEXT NOT NULL DEFAULT 'new', source TEXT, external_id TEXT, version INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT, updated_at TEXT)");
$pdo->exec('CREATE TABLE transport_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL REFERENCES transport_requests(id),
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id), driver_id TEXT, driver_name_snap TEXT, start_at TEXT NOT NULL,
    duration_min INTEGER NOT NULL CHECK (duration_min % 15 = 0), end_at TEXT NOT NULL, override_json TEXT, version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT, updated_at TEXT)');
$pdo->exec('CREATE INDEX idx_ta_vehicle ON transport_assignments (vehicle_id, start_at, end_at)');
$pdo->exec('CREATE INDEX idx_ta_driver ON transport_assignments (driver_id, start_at, end_at)');
$pdo->exec('CREATE INDEX idx_ta_request ON transport_assignments (request_id)');
$pdo->exec('CREATE TABLE assignment_crew (assignment_id INTEGER NOT NULL REFERENCES transport_assignments(id), employee_id TEXT NOT NULL, name_snap TEXT,
    PRIMARY KEY (assignment_id, employee_id))');
$pdo->exec('CREATE TABLE assignment_stops (assignment_id INTEGER NOT NULL REFERENCES transport_assignments(id), ord INTEGER NOT NULL, kind TEXT NOT NULL, place TEXT,
    lat REAL, lon REAL, stay_min INTEGER, leg_km REAL, leg_min_map INTEGER, leg_min INTEGER, PRIMARY KEY (assignment_id, ord))');
$pdo->exec('CREATE TABLE transport_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, role TEXT, action TEXT, entity_type TEXT, entity_id TEXT,
    before_json TEXT, after_json TEXT, warnings_json TEXT)');
$pdo->exec('CREATE INDEX idx_tj_ts ON transport_journal (ts)');
$pdo->exec('CREATE INDEX idx_tj_entity ON transport_journal (entity_type, entity_id)');
$pdo->exec("CREATE TRIGGER tj_no_upd BEFORE UPDATE ON transport_journal BEGIN SELECT RAISE(ABORT, 'transport_journal is append-only'); END");
$pdo->exec("CREATE TRIGGER tj_no_del BEFORE DELETE ON transport_journal BEGIN SELECT RAISE(ABORT, 'transport_journal is append-only'); END");
$pdo->exec("INSERT INTO transport_bases (name, sort_order) VALUES ('База A', 1), ('База B', 2)");
$ins = $pdo->prepare('INSERT INTO vehicles (name, plate, base_id, sort_order) VALUES (:n, :p, :b, :s)');
for ($i = 1; $i <= $nVeh; $i++) {
    $ins->execute([':n' => "ТС $i", ':p' => sprintf('X%03dXX', $i), ':b' => 1 + ($i % 2), ':s' => $i]);
}

// --- генерация данных ---------------------------------------------------------------------------------------
mt_srand(42);
$stRq = $pdo->prepare("INSERT INTO transport_requests (display_no, title, subscriber, address, comment, status, source, version, created_by, created_at, updated_at)
    VALUES (:d, :t, :s, :a, :c, 'done', 'manual', 3, 'u1', :ca, :ua)");
$stAs = $pdo->prepare('INSERT INTO transport_assignments (request_id, vehicle_id, driver_id, driver_name_snap, start_at, duration_min, end_at, override_json, version, created_at, updated_at)
    VALUES (:r, :v, :d, :dn, :s, :m, :e, NULL, 2, :ca, :ua)');
$stCr = $pdo->prepare('INSERT INTO assignment_crew (assignment_id, employee_id, name_snap) VALUES (:a, :e, :n)');
$stSt = $pdo->prepare('INSERT INTO assignment_stops (assignment_id, ord, kind, place, lat, lon, stay_min, leg_km, leg_min_map, leg_min)
    VALUES (:a, :o, :k, :p, :la, :lo, :sm, :km, :lm, :lmm)');
$stJr = $pdo->prepare('INSERT INTO transport_journal (ts, actor, role, action, entity_type, entity_id, before_json, after_json, warnings_json)
    VALUES (:ts, :a, :r, :ac, :et, :ei, :b, :af, :w)');

function lp_assignment_json(int $id, int $rid, int $veh, string $s, int $dur, array $crew, array $stops, int $ver): string
{
    return json_encode(['id' => $id, 'request_id' => $rid, 'vehicle_id' => $veh, 'driver_id' => 'emp_drv_' . ($veh % 6),
        'driver_name_snap' => 'Водитель ' . ($veh % 6), 'start_at' => $s, 'duration_min' => $dur, 'crew' => $crew, 'stops' => $stops,
        'override_json' => null, 'version' => $ver], JSON_UNESCAPED_UNICODE);
}

$day = 0;
$totals = ['requests' => 0, 'assignments' => 0, 'journal' => 0];
$results = [];
$maxYears = max($years);
$epoch = 1796083200;     // 2026-12-01T00:00 UTC — условная точка отсчёта
$weekStart = null;

foreach (range(1, $maxYears) as $yr) {
    for ($d = 0; $d < 365; $d++, $day++) {
        $date = gmdate('Y-m-d', $epoch + $day * 86400);
        $pdo->beginTransaction();
        for ($k = 0; $k < $perDay; $k++) {
            $now = $date . 'T' . sprintf('%02d:%02d:00+00:00', 3 + intdiv($k * 10, max(1, $perDay)), ($k * 7) % 60);
            $stRq->execute([':d' => sprintf('T-%06d', $totals['requests'] + 1), ':t' => 'Заявка на выезд (синтетика) ' . $k, ':s' => 'Абонент ' . mt_rand(1, 500),
                ':a' => 'Населённый пункт ' . mt_rand(1, 40) . ', ул. Синтетическая, ' . mt_rand(1, 99), ':c' => str_repeat('комментарий ', mt_rand(0, 6)),
                ':ca' => $now, ':ua' => $now]);
            $rid = (int) $pdo->lastInsertId();
            $totals['requests']++;
            $nAs = (mt_rand(1, 100) <= 30) ? 2 : 1;
            $aIds = [];
            $lastJson = '';
            for ($a = 0; $a < $nAs; $a++) {
                $veh = 1 + (($k * 3 + $a * 5 + $d) % $nVeh);
                $startMin = 8 * 60 + (($k * 45) % (9 * 60));
                $startMin -= $startMin % 15;
                $dur = 15 * mt_rand(1, 24);
                $s = $date . 'T' . sprintf('%02d:%02d', intdiv($startMin, 60), $startMin % 60);
                $endTs = gmdate('Y-m-d\TH:i', strtotime($s . ':00 UTC') + $dur * 60);
                $stAs->execute([':r' => $rid, ':v' => $veh, ':d' => 'emp_drv_' . ($veh % 6), ':dn' => 'Водитель ' . ($veh % 6), ':s' => $s, ':m' => $dur, ':e' => $endTs,
                    ':ca' => $now, ':ua' => $now]);
                $aid = (int) $pdo->lastInsertId();
                $aIds[] = $aid;
                $totals['assignments']++;
                $crew = [];
                for ($c = 0, $nc = mt_rand(1, 4); $c < $nc; $c++) {
                    $crew[] = ['employee_id' => 'emp_' . mt_rand(1, 60), 'name_snap' => 'Сотрудник ' . mt_rand(1, 60)];
                    $stCr->execute([':a' => $aid, ':e' => $crew[$c]['employee_id'] . '_' . $c, ':n' => $crew[$c]['name_snap']]);
                }
                $stops = [];
                for ($o = 1, $ns = mt_rand(2, 4); $o <= $ns; $o++) {
                    $stops[] = ['ord' => $o, 'kind' => $o === 1 ? 'departure' : ($o === $ns ? 'arrival' : 'intermediate'),
                        'place' => 'Населённый пункт ' . mt_rand(1, 40), 'lat' => round(60 + mt_rand(0, 99999) / 100000, 5), 'lon' => round(65 + mt_rand(0, 99999) / 100000, 5),
                        'stay_min' => 15 * mt_rand(0, 4), 'leg_km' => mt_rand(5, 180) / 2, 'leg_min_map' => 15 * mt_rand(1, 8), 'leg_min' => 15 * mt_rand(1, 8)];
                    $stSt->execute([':a' => $aid, ':o' => $o, ':k' => $stops[$o - 1]['kind'], ':p' => $stops[$o - 1]['place'], ':la' => $stops[$o - 1]['lat'],
                        ':lo' => $stops[$o - 1]['lon'], ':sm' => $stops[$o - 1]['stay_min'], ':km' => $stops[$o - 1]['leg_km'], ':lm' => $stops[$o - 1]['leg_min_map'],
                        ':lmm' => $stops[$o - 1]['leg_min']]);
                }
                $lastJson = lp_assignment_json($aid, $rid, $veh, $s, $dur, $crew, $stops, 1);
                $lastJson2 = lp_assignment_json($aid, $rid, $veh, $s, $dur + 15, $crew, $stops, 2);
                // допущение: $events записей журнала на заявку; раскладка — создание заявки, создание назначения(й), смены статуса, правки
                $evs = [];
                $evs[] = ['assignment.create', 'assignment', (string) $aid, null, $lastJson, mt_rand(1, 100) <= 30 ? json_encode([['code' => 'vehicle_overlap', 'message' => 'ТС занято в это время (синтетика)', 'ref' => ['assignment_id' => $aid - 1]]], JSON_UNESCAPED_UNICODE) : null];
                $evs[] = ['assignment.update', 'assignment', (string) $aid, $lastJson, $lastJson2, null];
                foreach ($evs as $e) {
                    $stJr->execute([':ts' => $now, ':a' => 'u1', ':r' => 'supervisor', ':ac' => $e[0], ':et' => $e[1], ':ei' => $e[2], ':b' => $e[3], ':af' => $e[4], ':w' => $e[5]]);
                    $totals['journal']++;
                }
            }
            // остальные события заявки: создание заявки + смены статусов (мелкий JSON)
            $reqJson = json_encode(['id' => $rid, 'status' => 'new', 'title' => 'Заявка на выезд', 'version' => 1], JSON_UNESCAPED_UNICODE);
            $reqJson2 = json_encode(['id' => $rid, 'status' => 'assigned', 'title' => 'Заявка на выезд', 'version' => 2], JSON_UNESCAPED_UNICODE);
            $stJr->execute([':ts' => $now, ':a' => 'u1', ':r' => 'supervisor', ':ac' => 'request.create', ':et' => 'request', ':ei' => (string) $rid, ':b' => null, ':af' => $reqJson, ':w' => null]);
            $totals['journal']++;
            $have = 1 + 2 * $nAs;
            for ($x = $have; $x < $events; $x++) {
                $stJr->execute([':ts' => $now, ':a' => 'u1', ':r' => 'supervisor', ':ac' => 'request.status', ':et' => 'request', ':ei' => (string) $rid, ':b' => $reqJson, ':af' => $reqJson2, ':w' => null]);
                $totals['journal']++;
            }
        }
        $pdo->commit();
    }
    if (in_array($yr, $years, true)) {
        $pdo->exec('PRAGMA wal_checkpoint(TRUNCATE)');
        $results[] = lp_measure($db, $scen, $yr, $totals, $epoch + ($day - 4) * 86400, $reps, $nVeh, $perDay, $events, $tmpDir);
    }
}
$pdo = null;
$sha1 = sha1_file($src);
echo '# src sha1 before=' . $sha0 . ' after=' . $sha1 . ' ' . ($sha0 === $sha1 ? 'UNCHANGED' : 'CHANGED!!!') . "\n";
if (isset($opt['out'])) {
    file_put_contents((string) $opt['out'], json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

function lp_pct(array $v, float $p): float
{
    sort($v);
    return (float) $v[max(0, min(count($v) - 1, (int) ceil($p / 100 * count($v)) - 1))];
}

function lp_time(callable $f, int $reps): array
{
    for ($i = 0; $i < 5; $i++) {
        $f();
    }
    $t = [];
    for ($i = 0; $i < $reps; $i++) {
        $a = hrtime(true);
        $f();
        $t[] = (hrtime(true) - $a) / 1e6;
    }
    return ['p50' => round(lp_pct($t, 50), 2), 'p95' => round(lp_pct($t, 95), 2)];
}

function lp_board(PDO $pdo, string $ws, string $we): int
{
    // Недельная доска (по смыслу T6 «неделя одним запросом»): назначения недели + экипаж + остановки по списку id.
    $s1 = $pdo->prepare('SELECT a.id, a.request_id, a.vehicle_id, a.driver_id, a.driver_name_snap, a.start_at, a.duration_min, a.end_at, a.override_json, a.version,
            r.display_no, r.title, r.status, r.created_by, v.name AS vehicle_name, v.base_id
        FROM transport_assignments a JOIN transport_requests r ON r.id = a.request_id JOIN vehicles v ON v.id = a.vehicle_id
        WHERE a.start_at < :we AND a.end_at > :ws ORDER BY v.base_id, v.sort_order, a.start_at');
    $s1->execute([':ws' => $ws, ':we' => $we]);
    $a = $s1->fetchAll();
    $ids = array_column($a, 'id');
    $n = count($a);
    if ($ids) {
        $in = implode(',', array_map('intval', $ids));
        $n += count($pdo->query("SELECT assignment_id, employee_id, name_snap FROM assignment_crew WHERE assignment_id IN ($in)")->fetchAll());
        $n += count($pdo->query("SELECT * FROM assignment_stops WHERE assignment_id IN ($in) ORDER BY assignment_id, ord")->fetchAll());
    }
    return $n;
}

function lp_plan(PDO $pdo, string $ws, string $we): string
{
    $o = [];
    foreach ($pdo->query("EXPLAIN QUERY PLAN SELECT a.id FROM transport_assignments a WHERE a.start_at < '$we' AND a.end_at > '$ws'")->fetchAll() as $r) {
        $o[] = $r['detail'];
    }
    return implode(' ; ', $o);
}

function lp_idxsize(PDO $pdo, string $name): int
{
    return (int) $pdo->query("SELECT IFNULL(SUM(pgsize), 0) FROM dbstat WHERE name = '$name'")->fetchColumn();
}

function lp_measure(string $db, string $scen, int $yr, array $tot, int $weekEpoch, int $reps, int $nVeh, int $perDay, int $events, string $tmp): array
{
    $bytes = filesize($db);
    $pdo = lp_open($db, false);                       // без synchronous=OFF: режим как в проде
    $weeks = [
        'last' => [gmdate('Y-m-d\T00:00', $weekEpoch), gmdate('Y-m-d\T00:00', $weekEpoch + 7 * 86400)],              // «сейчас» = конец истории
        'mid'  => [gmdate('Y-m-d\T00:00', $weekEpoch - $yr * 182 * 86400), gmdate('Y-m-d\T00:00', $weekEpoch - $yr * 182 * 86400 + 7 * 86400)],   // середина истории
    ];
    $variants = ['A_plan_indexes_only' => null, 'B_plus_start_at' => 'CREATE INDEX idx_ta_start ON transport_assignments (start_at, end_at)',
                 'C_plus_end_at' => 'CREATE INDEX idx_ta_end ON transport_assignments (end_at, start_at)'];
    $board = [];
    foreach ($variants as $vn => $ddl) {
        $buildMs = null;
        $idxBytes = null;
        if ($ddl !== null) {
            $t = hrtime(true);
            $pdo->exec($ddl);
            $buildMs = round((hrtime(true) - $t) / 1e6, 1);
            $idxBytes = lp_idxsize($pdo, $vn === 'B_plus_start_at' ? 'idx_ta_start' : 'idx_ta_end');
        }
        foreach ($weeks as $wn => [$ws, $we]) {
            $rows = lp_board($pdo, $ws, $we);
            $board["$vn/$wn"] = lp_time(fn() => lp_board($pdo, $ws, $we), $reps) + ['rows' => $rows, 'plan' => lp_plan($pdo, $ws, $we), 'index_build_ms' => $buildMs, 'index_bytes' => $idxBytes];
        }
        if ($ddl !== null) {
            $pdo->exec('DROP INDEX ' . ($vn === 'B_plus_start_at' ? 'idx_ta_start' : 'idx_ta_end'));
        }
    }
    [$ws, $we] = $weeks['last'];
    $overlap = lp_time(function () use ($pdo, $ws, $we): void {
        $s = $pdo->prepare('SELECT COUNT(*) FROM transport_assignments WHERE vehicle_id = 3 AND start_at < :we AND end_at > :ws');
        $s->execute([':ws' => $ws, ':we' => $we]);
        $s->fetchColumn();
        $s->closeCursor();
    }, $reps);
    $journalTail = lp_time(function () use ($pdo): void {
        $pdo->query('SELECT * FROM transport_journal ORDER BY id DESC LIMIT 50')->fetchAll();
    }, $reps);
    $journalEntity = lp_time(function () use ($pdo): void {
        $pdo->query("SELECT * FROM transport_journal WHERE entity_type = 'request' AND entity_id = '1234'")->fetchAll();
    }, $reps);
    $journalCount = (int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn();
    $cA = hrtime(true);
    $journalMonth = count($pdo->query("SELECT * FROM transport_journal WHERE ts >= '" . gmdate('Y-m-d', $weekEpoch - 30 * 86400) . "' AND ts < '" . gmdate('Y-m-d', $weekEpoch + 86400) . "'")->fetchAll());
    $journalMonthMs = round((hrtime(true) - $cA) / 1e6, 1);

    // запись «заявка+назначение+журнал» одной транзакцией на этом объёме (BEGIN IMMEDIATE, synchronous=FULL, как в проде)
    $writeT = [];
    for ($i = 0; $i < 60; $i++) {
        $a = hrtime(true);
        $pdo->exec('BEGIN IMMEDIATE');
        $pdo->exec("INSERT INTO transport_requests (display_no, title, status, version, created_by, created_at) VALUES ('W', 'bench', 'new', 1, 'u1', 'x')");
        $rid = (int) $pdo->lastInsertId();
        $pdo->exec("INSERT INTO transport_assignments (request_id, vehicle_id, driver_id, start_at, duration_min, end_at, created_at) VALUES ($rid, 1, 'emp_drv_1', '2099-01-01T08:00', 60, '2099-01-01T09:00', 'x')");
        $pdo->exec("INSERT INTO transport_journal (ts, actor, role, action, entity_type, entity_id, after_json) VALUES ('x','u1','admin','bench','request','$rid','{}')");
        $pdo->exec('COMMIT');
        $writeT[] = (hrtime(true) - $a) / 1e6;
    }
    $pdo->exec("DELETE FROM transport_assignments WHERE start_at >= '2099-01-01'");
    $pdo->exec("DELETE FROM transport_requests WHERE title = 'bench'");   // журнал — append-only: 60 bench-строк остаются (≈0,04 % объёма)

    $stat = [];
    foreach ($pdo->query("SELECT name, SUM(pgsize) s FROM dbstat WHERE name IN ('transport_journal','idx_tj_ts','idx_tj_entity','transport_requests','transport_assignments',
        'assignment_crew','assignment_stops','idx_ta_vehicle','idx_ta_driver','idx_ta_request','audit_log','sync_log') GROUP BY name ORDER BY s DESC")->fetchAll() as $r) {
        $stat[$r['name']] = (int) $r['s'];
    }
    $pdo->exec('PRAGMA wal_checkpoint(TRUNCATE)');
    $pdo = null;

    // бэкап «как на хостинге» (sqlite3 .backup) и полная проверка целостности
    $bk = $tmp . "/backup_{$scen}_{$yr}.db";
    @unlink($bk);
    $t = hrtime(true);
    shell_exec('sqlite3 ' . escapeshellarg($db) . ' ".backup ' . escapeshellarg($bk) . '" 2>&1');
    $backupMs = round((hrtime(true) - $t) / 1e6);
    $backupBytes = is_file($bk) ? filesize($bk) : -1;
    @unlink($bk);
    $t = hrtime(true);
    $ic = trim((string) shell_exec('sqlite3 ' . escapeshellarg($db) . ' "PRAGMA integrity_check" 2>&1'));
    $icMs = round((hrtime(true) - $t) / 1e6);
    $jb = ($stat['transport_journal'] ?? 0) + ($stat['idx_tj_ts'] ?? 0) + ($stat['idx_tj_entity'] ?? 0);
    return [
        'scenario' => $scen, 'years' => $yr, 'vehicles' => $nVeh, 'requests_per_day' => $perDay, 'events_per_request' => $events,
        'requests' => $tot['requests'], 'assignments' => $tot['assignments'], 'journal_rows' => $journalCount,
        'db_bytes' => $bytes, 'db_MB' => round($bytes / 1048576, 1),
        'journal_bytes_with_indexes' => $jb, 'journal_MB' => round($jb / 1048576, 1), 'journal_bytes_per_row' => (int) round($jb / max(1, $tot['journal'])),
        'bytes_per_request_all_tables' => (int) round(($bytes - 1589248) / max(1, $tot['requests'])),
        'dbstat_bytes' => $stat,
        'board' => $board,
        'vehicle_overlap_check_ms' => $overlap, 'journal_tail50_ms' => $journalTail, 'journal_by_entity_ms' => $journalEntity,
        'journal_30d_rows' => $journalMonth, 'journal_30d_ms' => $journalMonthMs,
        'write_tx_ms_p50_p95' => [round(lp_pct($writeT, 50), 2), round(lp_pct($writeT, 95), 2)],
        'backup_ms' => $backupMs, 'backup_bytes' => $backupBytes, 'integrity_check' => $ic, 'integrity_check_ms' => $icMs,
    ];
}
