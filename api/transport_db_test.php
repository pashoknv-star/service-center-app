<?php

declare(strict_types=1);

// Служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * transport_db_test.php — сьют `transportdb` (V10-T1): схема v15 модуля «Транспорт», журнал transport_journal
 * (append-only), api/transport_lib.php (роли, допустимые водители, шаг 15, +05), api/transport_vehicles.php
 * (базы, ТС, пул водителей-совместителей, перенос ТС) и матрица прав из reports/V10/specs/CONTRACT.md.
 *
 * Usage:  php api/transport_db_test.php        (сьют `transportdb` в scripts/verify_all.sh)
 *
 * Изолированный прогон (как api/tasks_links_test.php): data/app.db копируется во временный файл, весь тест
 * (CLI-часть и временный `php -S`) работает через env SC_APP_DB на этой копии — data/app.db не изменяется
 * (sha1 до/после). Вывод: «=== RESULTS: N passed, M failed ... ===» и «DB intact: YES».
 * Все ФИО и телефоны в фикстурах синтетические.
 */

$root = realpath(__DIR__ . '/..');
if ($root === false) {
    fwrite(STDERR, "Cannot resolve project root\n");
    exit(1);
}
$realDb = $root . '/data/app.db';
$realDbHashBefore = is_file($realDb) ? sha1_file($realDb) : '';

$tmpDir = sys_get_temp_dir();
$tmpDb = tempnam($tmpDir, 'sc_tdb_db_');
if ($tmpDb === false || !copy($realDb, $tmpDb)) {
    fwrite(STDERR, "Cannot create temp DB copy\n");
    exit(1);
}
putenv('SC_APP_DB=' . $tmpDb);
$_ENV['SC_APP_DB'] = $tmpDb;

// auth.php (подключается из transport_lib.php) стартует сессию: не оставляем файлов в системном каталоге
// и грузим ДО первого вывода (иначе session_start() в CLI ругается на отправленные заголовки).
ini_set('session.save_path', $tmpDir);
ini_set('session.use_cookies', '0');
ini_set('session.use_strict_mode', '0');

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
// До реализации файла нет — тесты упадут по существу (красный прогон), а не фатальной ошибкой.
if (is_file(__DIR__ . '/transport_lib.php')) {
    require_once __DIR__ . '/transport_lib.php';
}

$passed = 0;
$failed = 0;
$testNo = 0;

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
/** Функция библиотеки должна существовать (до реализации — FAIL по существу, а не фатальная ошибка). */
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

function openDb(string $file): PDO
{
    $p = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $p->exec('PRAGMA foreign_keys = ON');
    return $p;
}

function tcols(PDO $pdo, string $table): array
{
    return $pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll(PDO::FETCH_COLUMN, 1);
}

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
        $snap[$t] = [count($rows), md5((string) json_encode($rows))];
    }
    return $snap;
}

const T_TABLES = ['transport_bases', 'vehicles', 'transport_driver_pool', 'transport_requests', 'transport_assignments',
    'assignment_crew', 'assignment_stops', 'geo_cache', 'transport_journal'];

/** Нормализация SQL из sqlite_master: без комментариев и пробелов, нижний регистр. */
function normSql(string $s): string
{
    $s = preg_replace('/--[^\n]*/u', '', $s) ?? $s;
    $s = preg_replace('/\s+/u', ' ', $s) ?? $s;
    $s = preg_replace('/\s*([(),])\s*/u', '$1', $s) ?? $s;
    return mb_strtolower(trim($s));
}

/** Объекты схемы транспорта (таблицы, индексы, триггеры): имя → нормализованный SQL. */
function transportObjects(PDO $pdo): array
{
    $in = "'" . implode("','", T_TABLES) . "'";
    $rows = $pdo->query("SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ($in) AND sql IS NOT NULL ORDER BY type, name")
        ->fetchAll(PDO::FETCH_ASSOC);
    $m = [];
    foreach ($rows as $r) {
        $m[$r['type'] . ':' . $r['name']] = normSql((string) $r['sql']);
    }
    return $m;
}

/** Состояние «до v15»: убрать все объекты транспорта и поставить schema_version = 14. */
function downgradeTo14(PDO $pdo): void
{
    $pdo->exec('PRAGMA foreign_keys = OFF');
    foreach (['assignment_stops', 'assignment_crew', 'transport_assignments', 'transport_requests', 'vehicles',
        'transport_driver_pool', 'transport_bases', 'geo_cache', 'transport_journal'] as $t) {
        $pdo->exec('DROP TABLE IF EXISTS ' . $t);
    }
    $pdo->exec("UPDATE meta SET value = '14' WHERE key = 'schema_version'");
    $pdo->exec('PRAGMA foreign_keys = ON');
}

function throws(PDO $pdo, string $sql, string $needle = ''): string
{
    try {
        $pdo->exec($sql);
    } catch (Throwable $e) {
        if ($needle !== '' && stripos($e->getMessage(), $needle) === false) {
            throw new RuntimeException('ожидалась ошибка «' . $needle . '», получена: ' . $e->getMessage() . ' — ' . $sql);
        }
        return $e->getMessage();
    }
    throw new RuntimeException('ожидалась ошибка, но запрос прошёл: ' . $sql);
}

// Миграция — в ОТДЕЛЬНОМ процессе (как на проде: новый процесс php открывает БД и вызывает migrate()).
$migScript = tempnam($tmpDir, 'sc_tdb_mig_');
file_put_contents($migScript, '<?php require ' . var_export(__DIR__ . '/db.php', true) . ';'
    . '$d = Database::getInstance(); $mode = $argv[1] ?? "";'
    . 'if ($mode === "again14") { $d->getPDO()->exec("UPDATE meta SET value = \'14\' WHERE key = \'schema_version\'"); }'
    . 'if ($mode === "incr14") { $rm = new ReflectionMethod($d, "applyIncrementalMigrations"); $rm->invoke($d, 14); echo "incr"; exit; }'
    . 'echo $d->getSchemaVersion(), ">"; $d->migrate(); echo $d->getSchemaVersion();');
$migrate = function (string $file, string $mode) use ($migScript): string {
    return trim((string) shell_exec('SC_APP_DB=' . escapeshellarg($file) . ' php ' . escapeshellarg($migScript) . ' ' . $mode . ' 2>/dev/null'));
};
$rmDb = static function (string $f): void { @unlink($f); @unlink($f . '-wal'); @unlink($f . '-shm'); };

// ----------------------------------------------------------------------------
// CLI-часть: миграция и схема
// ----------------------------------------------------------------------------
$db = Database::getInstance();
$pdo = $db->getPDO();
$pdo->exec('PRAGMA busy_timeout = 5000');
$verBefore = $db->getSchemaVersion();

out('=== TRANSPORTDB TEST START ===');

$run('M1 миграция копии dev-БД (v6) → v15: meta.schema_version = 15, все 9 таблиц транспорта; повторный migrate — no-op', function () use ($db, $pdo, $verBefore) {
    ok($verBefore < 9, 'ожидалась исходная схема < 9, а не ' . $verBefore);
    $db->migrate();
    eq($db->getSchemaVersion(), 15, 'schema_version');
    eq($pdo->query("SELECT value FROM meta WHERE key = 'schema_version'")->fetchColumn(), '15', 'meta.schema_version');
    foreach (T_TABLES as $t) {
        eq((int) $pdo->query("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '$t'")->fetchColumn(), 1, 'таблица ' . $t);
    }
    $snap = snapshotTables($pdo, ['audit_log', 'meta']);
    $db->migrate();
    eq(snapshotTables($pdo, ['audit_log', 'meta']), $snap, 'повторный migrate не меняет данные');
    eq($pdo->query('PRAGMA integrity_check')->fetchColumn(), 'ok', 'integrity_check');
    eq($pdo->query('PRAGMA foreign_key_check')->fetchAll(), [], 'foreign_key_check');
    return 'v' . $verBefore . '→v15';
});

$run('M2 v14 → v15 на копии: прежние данные на месте, объекты созданы, повтор и «ложная 14» безопасны', function () use ($tmpDir, $realDb, $migrate, $rmDb) {
    // ВАЖНО: основную копию ($tmpDb) не копируем и не открываем второй раз — закрытие любого дескриптора файла в
    // процессе снимает POSIX-блокировки открытого WAL-соединения (split-brain с php -S). Берём свежую копию data/app.db.
    $f = tempnam($tmpDir, 'sc_tdb_v14_');
    ok($f !== false && copy($realDb, $f), 'копия');
    try {
        eq($migrate($f, 'prep'), '6>15', 'подготовка: копия dev-БД v6 → v15');
        $p = openDb($f);
        $p->exec('PRAGMA journal_mode = DELETE');
        $p->exec("INSERT INTO employees (id, full_name, location, sort_order) VALUES ('m2_e', 'Миграционов Е', 'QA', 0)");
        $p->exec("INSERT INTO tasks (id, title, start_at, version) VALUES ('m2_t1', 'Старая задача', '2030-03-01', 4)");
        $p->exec("INSERT INTO task_assignees (task_id, employee_id, role, full_name_snapshot) VALUES ('m2_t1', 'm2_e', 'assignee', 'Миграционов Е')");
        $p->exec("INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details) VALUES ('2999-01-01T00:00:00+00:00', 'x', 'admin', 'm2.keep', 'system', NULL, '{}')");
        $full = transportObjects($p);   // эталон: что создаёт обычная миграция (schema.sql + db.php)
        ok(count($full) >= 9 + 5 + 3, 'эталон схемы транспорта не пуст: ' . count($full) . ' объектов');
        downgradeTo14($p);
        eq(transportObjects($p), [], 'подготовка: объектов транспорта нет');
        $before = snapshotTables($p, ['audit_log', 'meta']);
        $auditBefore = $p->query('SELECT COUNT(*) FROM audit_log')->fetchColumn();
        unset($p);

        eq($migrate($f, 'first'), '14>15', 'первая миграция 14→15 (вывод процесса)');
        $q = openDb($f);
        eq($q->query("SELECT value FROM meta WHERE key = 'schema_version'")->fetchColumn(), '15', 'meta.schema_version');
        $after = snapshotTables($q, ['audit_log', 'meta']);
        foreach (T_TABLES as $t) {
            eq($after[$t] ?? null, [0, md5('[]')], 'новая таблица пуста: ' . $t);
            unset($after[$t]);
        }
        eq($after, $before, 'прежние таблицы не изменились');
        eq((int) $q->query('SELECT COUNT(*) FROM audit_log')->fetchColumn() >= 1, true, 'audit_log не опустошён');
        eq(transportObjects($q), $full, 'объекты v15 (таблицы, индексы, триггеры) совпадают с эталоном');
        eq($q->query('PRAGMA integrity_check')->fetchColumn(), 'ok', 'integrity_check');
        eq($q->query('PRAGMA foreign_key_check')->fetchAll(), [], 'foreign_key_check');
        $snap15 = snapshotTables($q, ['audit_log', 'meta']);
        unset($q);
        eq($migrate($f, 'again'), '15>15', 'повтор на v15');
        eq($migrate($f, 'again14'), '14>15', 'повторное применение с версии 14 (всё уже существует)');
        $q = openDb($f);
        eq(snapshotTables($q, ['audit_log', 'meta']), $snap15, 'повторы ничего не ломают и не меняют');
        eq(transportObjects($q), $full, 'объекты после повторов');
        unset($q);
    } finally {
        $rmDb($f);
    }
    return 'v14→v15, данные равны, повтор — no-op';
});

$run('M3 DDL блока v15 в db.php (applyIncrementalMigrations) эквивалентен schema.sql: те же таблицы, индексы, триггеры и CHECK', function () use ($tmpDir, $realDb, $migrate, $rmDb) {
    $f = tempnam($tmpDir, 'sc_tdb_incr_');
    ok($f !== false && copy($realDb, $f), 'копия');
    try {
        eq($migrate($f, 'prep'), '6>15', 'подготовка');
        $p = openDb($f);
        $p->exec('PRAGMA journal_mode = DELETE');
        $full = transportObjects($p);
        downgradeTo14($p);
        unset($p);
        eq($migrate($f, 'incr14'), 'incr', 'только инкрементальный блок (без schema.sql)');
        $q = openDb($f);
        $incr = transportObjects($q);
        unset($q);
        eq(array_keys($incr), array_keys($full), 'набор объектов');
        foreach ($full as $name => $sql) {
            eq($incr[$name], $sql, 'DDL ' . $name);
        }
    } finally {
        $rmDb($f);
    }
    return count($full) . ' объектов совпали';
});

$run('M4 свежая пустая БД: migrate() создаёт полную схему v15 (таблицы, триггеры журнала, индексы)', function () use ($tmpDir, $migrate, $rmDb) {
    $f = tempnam($tmpDir, 'sc_tdb_fresh_');
    ok($f !== false, 'файл');
    try {
        eq($migrate($f, 'fresh'), '0>15', 'свежая БД');
        $q = openDb($f);
        foreach (T_TABLES as $t) {
            eq((int) $q->query("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='$t'")->fetchColumn(), 1, $t);
        }
        $trg = $q->query("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='transport_journal' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
        eq($trg, ['trg_transport_journal_no_delete', 'trg_transport_journal_no_replace', 'trg_transport_journal_no_update'], 'три триггера журнала: ' . implode(',', $trg));
        unset($q);
    } finally {
        $rmDb($f);
    }
    return 'ok';
});

// Столбцы таблиц — ключевые имена контракта (CONTRACT.md «Схема v15», PLAN §3): T5 на них опирается.
$expectCols = [
    'transport_bases' => ['id', 'name', 'sort_order', 'created_at', 'updated_at'],
    'vehicles' => ['id', 'name', 'plate', 'base_id', 'status', 'default_driver_id', 'sort_order', 'version', 'created_at', 'updated_at'],
    'transport_driver_pool' => ['employee_id', 'added_by', 'added_at'],
    'transport_requests' => ['id', 'display_no', 'title', 'subscriber', 'address', 'comment', 'status', 'source', 'external_id',
        'version', 'created_by', 'created_by_name', 'created_at', 'updated_at'],
    'transport_assignments' => ['id', 'request_id', 'vehicle_id', 'driver_id', 'driver_name_snap', 'start_at', 'duration_min', 'end_at',
        'override_json', 'version', 'created_by', 'created_at', 'updated_at'],
    'assignment_crew' => ['assignment_id', 'employee_id', 'name_snap'],
    'assignment_stops' => ['assignment_id', 'ord', 'kind', 'place', 'lat', 'lon', 'stay_min', 'leg_km', 'leg_min_map', 'leg_min'],
    'geo_cache' => ['key', 'kind', 'payload_json', 'fetched_at'],
    'transport_journal' => ['id', 'ts', 'actor', 'role', 'action', 'entity_type', 'entity_id', 'before_json', 'after_json', 'warnings_json'],
];
foreach ($expectCols as $table => $cols) {
    $run('S1 столбцы ' . $table . ' (имена и порядок по контракту)', function () use ($pdo, $table, $cols) {
        eq(tcols($pdo, $table), $cols, $table . ' cols');
        return count($cols) . ' столбцов';
    });
}

$run('S2 индексы по (vehicle_id,start_at,end_at) и (driver_id,start_at,end_at) на transport_assignments', function () use ($pdo) {
    $found = [];
    foreach ($pdo->query('PRAGMA index_list(transport_assignments)')->fetchAll() as $ix) {
        $found[implode(',', $pdo->query('PRAGMA index_info(' . $ix['name'] . ')')->fetchAll(PDO::FETCH_COLUMN, 2))] = $ix['name'];
    }
    ok(isset($found['vehicle_id,start_at,end_at']), 'нет индекса (vehicle_id,start_at,end_at): ' . json_encode($found));
    ok(isset($found['driver_id,start_at,end_at']), 'нет индекса (driver_id,start_at,end_at)');
    // планировщик реально использует индекс для поиска пересечений ТС
    $plan = $pdo->query("EXPLAIN QUERY PLAN SELECT id FROM transport_assignments WHERE vehicle_id = 'x' AND start_at < '2031-01-02T00:00' AND end_at > '2031-01-01T00:00'")
        ->fetchAll(PDO::FETCH_ASSOC);
    ok(stripos(json_encode($plan), 'USING INDEX') !== false || stripos(json_encode($plan), 'USING COVERING INDEX') !== false, 'план без индекса: ' . json_encode($plan));
    return 'ok';
});

$run('S3 индексы журнала: по ts и по (entity_type, entity_id)', function () use ($pdo) {
    $found = [];
    foreach ($pdo->query('PRAGMA index_list(transport_journal)')->fetchAll() as $ix) {
        $found[implode(',', $pdo->query('PRAGMA index_info(' . $ix['name'] . ')')->fetchAll(PDO::FETCH_COLUMN, 2))] = $ix['name'];
    }
    ok(isset($found['ts']), 'нет индекса по ts: ' . json_encode($found));
    ok(isset($found['entity_type,entity_id']), 'нет индекса по (entity_type, entity_id)');
    return 'ok';
});

$run('S4 индексы: vehicles(base_id), assignment_crew(employee_id), transport_requests(status), assignments(request_id)', function () use ($pdo) {
    $want = ['vehicles' => 'base_id', 'assignment_crew' => 'employee_id', 'transport_requests' => 'status', 'transport_assignments' => 'request_id'];
    foreach ($want as $t => $col) {
        $has = false;
        foreach ($pdo->query('PRAGMA index_list(' . $t . ')')->fetchAll() as $ix) {
            $cols = $pdo->query('PRAGMA index_info(' . $ix['name'] . ')')->fetchAll(PDO::FETCH_COLUMN, 2);
            if ($cols !== [] && $cols[0] === $col) {
                $has = true;
            }
        }
        ok($has, 'нет индекса с первым столбцом ' . $col . ' у ' . $t);
    }
    return 'ok';
});

// Фикстуры для проверок ограничений (CLI).
// Сбой подготовки фикстур не должен валить весь прогон фатальной ошибкой: фиксируем его как провал,
// а проверки, которым фикстура нужна, упадут по существу.
$setup = function (string $label, callable $fn) use (&$failed, &$testNo): void {
    try {
        $fn();
    } catch (Throwable $e) {
        $failed++;
        $testNo++;
        out(sprintf('[%d] SETUP %s: FAIL — %s', $testNo, $label, $e->getMessage()));
    }
};
$setup('фикстуры ограничений (база, ТС, заявка)', function () use ($pdo) {
    $pdo->exec("INSERT INTO transport_bases (id, name, sort_order) VALUES ('chk_b', 'Проверочная база', 1)");
    $pdo->exec("INSERT INTO vehicles (id, name, plate, base_id) VALUES ('chk_v', 'ТС проверка', 'Х001ХХ01', 'chk_b')");
    $pdo->exec("INSERT INTO transport_requests (id, title) VALUES ('chk_r', 'Заявка проверка')");
});
$insA = static fn(string $id, mixed $dur): string => "INSERT INTO transport_assignments (id, request_id, vehicle_id, driver_id, start_at, duration_min, end_at)
    VALUES ('$id', 'chk_r', 'chk_v', 'chk_drv', '2031-05-01T08:00', $dur, '2031-05-01T09:00')";

$run('C1 CHECK шага 15: duration_min — кратно 15, > 0, ≤ 10080 (7 суток)', function () use ($pdo, $insA) {
    foreach ([15, 30, 45, 60, 480, 10080] as $i => $d) {
        $pdo->exec($insA('chk_a_ok' . $i, $d));
    }
    foreach ([1, 7, 14, 20, 29, 44, 0, -15, 10095, 10081] as $i => $d) {
        throws($pdo, $insA('chk_a_bad' . $i, $d), 'constraint');
    }
    throws($pdo, $insA('chk_a_null', 'NULL'), 'constraint');
    eq((int) $pdo->query("SELECT COUNT(*) FROM transport_assignments WHERE id LIKE 'chk_a_%'")->fetchColumn(), 6, 'остались только корректные');
    return '6 допустимых, 10 недопустимых + NULL';
});

$run('C2 CHECK шага 15 у остановок: stay_min и leg_min (и leg_min_map) — кратны 15 и ≥ 0', function () use ($pdo) {
    $pdo->exec("INSERT INTO transport_assignments (id, request_id, vehicle_id, driver_id, start_at, duration_min, end_at)
        VALUES ('chk_s_a', 'chk_r', 'chk_v', 'chk_drv', '2031-05-02T08:00', 60, '2031-05-02T09:00')");
    $ins = static fn(int $ord, string $stay, string $leg, string $map = 'NULL'): string => "INSERT INTO assignment_stops
        (assignment_id, ord, kind, place, stay_min, leg_min, leg_min_map) VALUES ('chk_s_a', $ord, 'intermediate', 'Точка', $stay, $leg, $map)";
    $pdo->exec($ins(1, '0', '0'));
    $pdo->exec($ins(2, '15', '45', '60'));
    $pdo->exec($ins(3, '0', '0', '0'));
    $ord = 10;
    foreach ([['10', '0', 'NULL'], ['0', '7', 'NULL'], ['-15', '0', 'NULL'], ['0', '-15', 'NULL'], ['0', '0', '20'], ['0', '0', '-15'], ['16', '16', '16']] as [$st, $lg, $mp]) {
        throws($pdo, $ins($ord++, $st, $lg, $mp), 'constraint');
    }
    eq((int) $pdo->query("SELECT COUNT(*) FROM assignment_stops WHERE assignment_id = 'chk_s_a'")->fetchColumn(), 3, 'остались только корректные');
    return '3 допустимых, 7 недопустимых';
});

$run('C3 CHECK перечислений и координат: статусы ТС/заявки, kind остановки, lat/lon', function () use ($pdo) {
    throws($pdo, "INSERT INTO vehicles (id, name, plate, base_id, status) VALUES ('chk_v2', 'x', 'Х002ХХ01', 'chk_b', 'broken')", 'constraint');
    throws($pdo, "INSERT INTO transport_requests (id, title, status) VALUES ('chk_r2', 'x', 'bogus')", 'constraint');
    foreach (['new', 'assigned', 'in_progress', 'done', 'cancelled'] as $i => $s) {
        $pdo->exec("INSERT INTO transport_requests (id, title, status) VALUES ('chk_rs$i', 'x', '$s')");
    }
    throws($pdo, "INSERT INTO assignment_stops (assignment_id, ord, kind, place) VALUES ('chk_s_a', 20, 'weird', 'x')", 'constraint');
    foreach (['departure', 'intermediate', 'arrival'] as $i => $k) {
        $pdo->exec("INSERT INTO assignment_stops (assignment_id, ord, kind, place, lat, lon) VALUES ('chk_s_a', " . (30 + $i) . ", '$k', 'x', 60.1, 65.4)");
    }
    throws($pdo, "INSERT INTO assignment_stops (assignment_id, ord, kind, place, lat, lon) VALUES ('chk_s_a', 40, 'arrival', 'x', 91, 10)", 'constraint');
    throws($pdo, "INSERT INTO assignment_stops (assignment_id, ord, kind, place, lat, lon) VALUES ('chk_s_a', 41, 'arrival', 'x', 10, 181)", 'constraint');
    return 'ok';
});

$run('C4 ограничения целостности: UNIQUE имя базы и госномер, FK vehicles→база, assignments→ТС/заявка, PK (assignment_id, ord), NOT NULL', function () use ($pdo) {
    throws($pdo, "INSERT INTO transport_bases (id, name) VALUES ('chk_b_dup', 'Проверочная база')", 'unique');
    throws($pdo, "INSERT INTO vehicles (id, name, plate, base_id) VALUES ('chk_v3', 'x', 'Х001ХХ01', 'chk_b')", 'unique');
    throws($pdo, "INSERT INTO vehicles (id, name, plate, base_id) VALUES ('chk_v4', 'x', 'Х004ХХ01', 'нет_базы')", 'foreign key');
    throws($pdo, "INSERT INTO transport_assignments (id, request_id, vehicle_id, driver_id, start_at, duration_min, end_at) VALUES ('chk_f1', 'chk_r', 'нет_тс', 'd', '2031-05-01T08:00', 15, '2031-05-01T08:15')", 'foreign key');
    throws($pdo, "INSERT INTO transport_assignments (id, request_id, vehicle_id, driver_id, start_at, duration_min, end_at) VALUES ('chk_f2', 'нет_заявки', 'chk_v', 'd', '2031-05-01T08:00', 15, '2031-05-01T08:15')", 'foreign key');
    throws($pdo, "INSERT INTO assignment_stops (assignment_id, ord, kind, place) VALUES ('chk_s_a', 1, 'arrival', 'дубль ord')", 'unique');
    throws($pdo, "INSERT INTO vehicles (id, name, plate, base_id) VALUES ('chk_v5', NULL, 'Х005ХХ01', 'chk_b')", 'not null');
    throws($pdo, "INSERT INTO transport_driver_pool (employee_id) VALUES (NULL)", '');
    return 'ok';
});

$run('C5 каскад: удаление назначения удаляет бригаду и остановки; база с ТС не удаляется (RESTRICT)', function () use ($pdo) {
    $pdo->exec("INSERT INTO assignment_crew (assignment_id, employee_id, name_snap) VALUES ('chk_s_a', 'chk_e1', 'Бригадов Один'), ('chk_s_a', 'chk_e2', 'Бригадов Два')");
    throws($pdo, "INSERT INTO assignment_crew (assignment_id, employee_id) VALUES ('chk_s_a', 'chk_e1')", 'unique');
    ok((int) $pdo->query("SELECT COUNT(*) FROM assignment_stops WHERE assignment_id = 'chk_s_a'")->fetchColumn() > 0, 'есть остановки');
    throws($pdo, "DELETE FROM transport_bases WHERE id = 'chk_b'", 'foreign key');
    $pdo->exec("DELETE FROM transport_assignments WHERE id = 'chk_s_a'");
    eq((int) $pdo->query("SELECT COUNT(*) FROM assignment_stops WHERE assignment_id = 'chk_s_a'")->fetchColumn(), 0, 'остановки удалены каскадом');
    eq((int) $pdo->query("SELECT COUNT(*) FROM assignment_crew WHERE assignment_id = 'chk_s_a'")->fetchColumn(), 0, 'бригада удалена каскадом');
    return 'ok';
});

$run('C6 удаление сотрудника не стирает транспортные данные (нет FK на employees: пул, бригада, водитель, ТС)', function () use ($pdo) {
    $pdo->exec("INSERT INTO employees (id, full_name, location, sort_order) VALUES ('chk_e9', 'Удалёнов Проверочный', 'QA', 0)");
    $pdo->exec("INSERT INTO transport_driver_pool (employee_id, added_by, added_at) VALUES ('chk_e9', 'x', 'x')");
    $pdo->exec("UPDATE vehicles SET default_driver_id = 'chk_e9' WHERE id = 'chk_v'");
    $pdo->exec("DELETE FROM employees WHERE id = 'chk_e9'");
    eq((int) $pdo->query("SELECT COUNT(*) FROM transport_driver_pool WHERE employee_id = 'chk_e9'")->fetchColumn(), 1, 'запись пула цела');
    eq($pdo->query("SELECT default_driver_id FROM vehicles WHERE id = 'chk_v'")->fetchColumn(), 'chk_e9', 'default_driver_id цел');
    $pdo->exec("DELETE FROM transport_driver_pool WHERE employee_id = 'chk_e9'");
    $pdo->exec("UPDATE vehicles SET default_driver_id = NULL WHERE id = 'chk_v'");
    return 'ok';
});

// ----------------------------------------------------------------------------
// Журнал: append-only на уровне БД, очистка audit_log его не касается
// ----------------------------------------------------------------------------
$oldJournalId = 0;
$setup('старая запись журнала', function () use ($pdo, &$oldJournalId) {
    $pdo->exec("INSERT INTO transport_journal (ts, actor, role, action, entity_type, entity_id, before_json, after_json, warnings_json)
        VALUES ('2020-01-01T00:00:00+05:00', 'old_actor', 'admin', 'test.old', 'vehicle', 'chk_v', NULL, '{\"a\":1}', NULL)");
    $oldJournalId = (int) $pdo->lastInsertId();
});

$run('J1 журнал: UPDATE запрещён триггером (RAISE ABORT), запись не меняется', function () use ($pdo, $oldJournalId) {
    $m = throws($pdo, "UPDATE transport_journal SET actor = 'hacker' WHERE id = $oldJournalId", 'append-only');
    ok(stripos($m, 'transport_journal') !== false, 'сообщение называет таблицу: ' . $m);
    throws($pdo, "UPDATE transport_journal SET after_json = '{}'", 'append-only');
    eq($pdo->query("SELECT actor FROM transport_journal WHERE id = $oldJournalId")->fetchColumn(), 'old_actor', 'actor прежний');
    return $m;
});

$run('J2 журнал: DELETE запрещён триггером (в т.ч. массовый и «по давности»), записи на месте', function () use ($pdo, $oldJournalId) {
    $n = (int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn();
    throws($pdo, "DELETE FROM transport_journal WHERE id = $oldJournalId", 'append-only');
    throws($pdo, 'DELETE FROM transport_journal', 'append-only');
    throws($pdo, "DELETE FROM transport_journal WHERE ts < '2999-01-01'", 'append-only');
    eq((int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn(), $n, 'число записей');
    return 'записей: ' . $n;
});

$run('J3 журнал: INSERT разрешён, id монотонный (AUTOINCREMENT), повторная вставка не перетирает старую запись', function () use ($pdo, $oldJournalId) {
    $pdo->exec("INSERT INTO transport_journal (ts, actor, role, action, entity_type, entity_id) VALUES ('2020-01-02T00:00:00+05:00', 'a', 'admin', 'test.new', 'vehicle', 'chk_v')");
    $newId = (int) $pdo->lastInsertId();
    ok($newId > $oldJournalId, 'id растёт');
    throws($pdo, "INSERT INTO transport_journal (id, ts, actor, role, action, entity_type, entity_id) VALUES ($oldJournalId, 'x', 'x', 'x', 'x', 'x', 'x')", 'append-only');
    eq($pdo->query("SELECT actor FROM transport_journal WHERE id = $oldJournalId")->fetchColumn(), 'old_actor', 'старая запись цела');
    return 'id ' . $oldJournalId . '→' . $newId;
});

$run('J4 audit_cleanup() (helpers.php) удаляет старые audit_log, но НЕ трогает transport_journal (даже «состаренный» до 2020 г.)', function () use ($pdo, $oldJournalId) {
    $pdo->exec("INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details) VALUES ('2020-01-01T00:00:00+00:00', 'old', 'admin', 'j4.old', 'system', NULL, '{}')");
    $pdo->exec("INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details) VALUES ('2999-01-01T00:00:00+00:00', 'new', 'admin', 'j4.new', 'system', NULL, '{}')");
    $jBefore = $pdo->query('SELECT * FROM transport_journal ORDER BY id')->fetchAll();
    audit_cleanup($pdo);
    eq((int) $pdo->query("SELECT COUNT(*) FROM audit_log WHERE action = 'j4.old'")->fetchColumn(), 0, 'старая audit_log-запись удалена очисткой');
    eq((int) $pdo->query("SELECT COUNT(*) FROM audit_log WHERE action = 'j4.new'")->fetchColumn(), 1, 'свежая audit_log-запись осталась');
    eq($pdo->query('SELECT * FROM transport_journal ORDER BY id')->fetchAll(), $jBefore, 'журнал транспорта не изменился');
    eq($pdo->query("SELECT ts FROM transport_journal WHERE id = $oldJournalId")->fetchColumn(), '2020-01-01T00:00:00+05:00', 'старая запись журнала на месте');
    return 'journal ' . count($jBefore) . ' записей цел';
});

$run('J5 ротация в db.php (cleanupAuditLog при migrate) тоже не трогает журнал; повторное применение v15 безопасно', function () use ($db, $pdo) {
    $pdo->exec("INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details) VALUES ('2020-01-01T00:00:00+00:00', 'old', 'admin', 'j5.old', 'system', NULL, '{}')");
    $jBefore = $pdo->query('SELECT * FROM transport_journal ORDER BY id')->fetchAll();
    $objs = transportObjects($pdo);
    $pdo->exec("UPDATE meta SET value = '14' WHERE key = 'schema_version'");
    $db->migrate();   // current < 15 → schema.sql + applyIncrementalMigrations (+ cleanupAuditLog)
    eq($db->getSchemaVersion(), 15, 'версия вернулась к 15');
    eq((int) $pdo->query("SELECT COUNT(*) FROM audit_log WHERE action = 'j5.old'")->fetchColumn(), 0, 'ротация audit_log сработала');
    eq($pdo->query('SELECT * FROM transport_journal ORDER BY id')->fetchAll(), $jBefore, 'журнал цел после migrate()');
    eq(transportObjects($pdo), $objs, 'схема не изменилась');
    return 'ok';
});

// V10-T1b: обход неизменяемости через REPLACE / OR IGNORE / upsert с уже существующим id
$jRow = function (PDO $p, int $id): array {
    return $p->query("SELECT * FROM transport_journal WHERE id = $id")->fetch() ?: [];
};
$jIns = static fn(string $verb, int $id, string $actor): string =>
    "$verb INTO transport_journal (id, ts, actor, role, action, entity_type, entity_id, after_json) VALUES ($id, '2020-03-01T00:00:00+05:00', '$actor', 'admin', 'test.forged', 'vehicle', 'x', '{}')";

$run('JR1 журнал: INSERT OR REPLACE и REPLACE INTO с существующим id → ошибка append-only, запись не перезаписана', function () use ($pdo, $oldJournalId, $jRow, $jIns) {
    $row = $jRow($pdo, $oldJournalId);
    ok($row !== [] && $row['actor'] === 'old_actor', 'исходная запись на месте');
    $n = (int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn();
    // Оба варианта проверяются независимо: до фикса запрос проходит и перезаписывает запись — провал перечисляет, что именно прошло.
    $bad = [];
    $m = '';
    foreach (['INSERT OR REPLACE' => 'HACK_or_replace', 'REPLACE' => 'HACK_replace'] as $verb => $actor) {
        try {
            $pdo->exec($jIns($verb, $oldJournalId, $actor));
            $bad[] = "«{$verb}» ПРОШЁЛ без ошибки, actor стал «" . ($jRow($pdo, $oldJournalId)['actor'] ?? '∅') . '»';
        } catch (PDOException $e) {
            if (stripos($e->getMessage(), 'append-only') === false) {
                $bad[] = $verb . ': неожиданная ошибка ' . $e->getMessage();
            }
            $m = $e->getMessage();
        }
        if ($jRow($pdo, $oldJournalId) !== $row) {
            $bad[] = $verb . ': запись журнала изменена';
            $row = $jRow($pdo, $oldJournalId);   // дальше сравниваем с актуальным состоянием — второй вариант оценивается отдельно
        }
    }
    eq($bad, [], 'обход неизменяемости журнала: ' . implode('; ', $bad));
    eq((int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn(), $n, 'число записей');
    eq((int) $pdo->query("SELECT COUNT(*) FROM transport_journal WHERE actor LIKE 'HACK%'")->fetchColumn(), 0, 'подделок нет');
    return $m;
});

$run('JR2 журнал: INSERT OR IGNORE и INSERT … ON CONFLICT(id) DO UPDATE / DO NOTHING с существующим id не меняют запись (ошибка или пропуск)', function () use ($pdo, $oldJournalId, $jRow, $jIns) {
    $row = $jRow($pdo, $oldJournalId);
    $n = (int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn();
    $res = [];
    foreach ([
        'OR IGNORE' => $jIns('INSERT OR IGNORE', $oldJournalId, 'HACK_ignore'),
        'ON CONFLICT DO UPDATE' => $jIns('INSERT', $oldJournalId, 'HACK_upsert') . " ON CONFLICT(id) DO UPDATE SET actor = 'HACK_upsert', after_json = '{\"forged\":1}'",
        'ON CONFLICT DO NOTHING' => $jIns('INSERT', $oldJournalId, 'HACK_nothing') . ' ON CONFLICT(id) DO NOTHING',
    ] as $name => $sql) {
        try {
            $pdo->exec($sql);
            $res[] = $name . ': пропуск';
        } catch (Throwable $e) {
            ok(stripos($e->getMessage(), 'append-only') !== false, $name . ': неожиданная ошибка ' . $e->getMessage());
            $res[] = $name . ': ошибка append-only';
        }
        eq($jRow($pdo, $oldJournalId), $row, $name . ': запись журнала не изменилась');
    }
    eq((int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn(), $n, 'число записей');
    return implode('; ', $res);
});

$run('JR3 журнал: штатные вставки работают — без id, id = NULL, новый id (в т.ч. через INSERT OR REPLACE); UPDATE/DELETE по-прежнему запрещены', function () use ($pdo, $oldJournalId, $jRow, $jIns) {
    $n = (int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn();
    $pdo->exec("INSERT INTO transport_journal (ts, actor, role, action, entity_type, entity_id) VALUES ('2020-02-01T00:00:00+05:00', 'j8_noid', 'admin', 'test.j8', 'vehicle', 'chk_v')");
    $id1 = (int) $pdo->lastInsertId();
    $pdo->exec("INSERT INTO transport_journal (id, ts, actor, role, action, entity_type, entity_id) VALUES (NULL, '2020-02-01T00:00:00+05:00', 'j8_null', 'admin', 'test.j8', 'vehicle', 'chk_v')");
    $id2 = (int) $pdo->lastInsertId();
    $pdo->exec("INSERT OR REPLACE INTO transport_journal (ts, actor, role, action, entity_type, entity_id) VALUES ('2020-02-01T00:00:00+05:00', 'j8_orr', 'admin', 'test.j8', 'vehicle', 'chk_v')");
    $id3 = (int) $pdo->lastInsertId();
    $new = (int) $pdo->query('SELECT MAX(id) FROM transport_journal')->fetchColumn() + 100;
    $pdo->exec($jIns('INSERT', $new, 'j8_newid'));
    $pdo->exec($jIns('INSERT OR REPLACE', $new + 1, 'j8_newid_orr'));
    ok($id1 > $oldJournalId && $id2 > $id1 && $id3 > $id2, "id монотонны: $id1, $id2, $id3");
    eq((int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn(), $n + 5, 'добавлено 5 записей');
    eq($jRow($pdo, $new)['actor'], 'j8_newid', 'запись с новым id создана');
    throws($pdo, "UPDATE transport_journal SET actor = 'hacker' WHERE id = $id1", 'append-only');
    throws($pdo, "DELETE FROM transport_journal WHERE id = $id1", 'append-only');
    eq($jRow($pdo, $id1)['actor'], 'j8_noid', 'запись цела');
    return "id $id1, $id2, $id3, $new";
});

$run('JR4 журнал: запись с id ≤ 0 не «отравляет» журнал — вставка без id после неё работает (условие NEW.id > 0 в триггере); записи с id > 0 защищены', function () use ($tmpDir, $migrate, $rmDb) {
    $f = tempnam($tmpDir, 'sc_tdb_j9_');
    ok($f !== false, 'файл');
    try {
        eq($migrate($f, 'fresh'), '0>15', 'свежая БД');
        $q = openDb($f);
        $q->exec("INSERT INTO transport_journal (ts, actor) VALUES ('t', 'legit')");
        // В BEFORE INSERT NEW.id у вставки без id равен -1: без условия NEW.id > 0 строка с id = -1 блокировала бы все штатные вставки.
        $q->exec("INSERT INTO transport_journal (id, ts, actor) VALUES (-1, 't', 'neg')");
        $q->exec("INSERT INTO transport_journal (ts, actor) VALUES ('t', 'after_neg')");
        eq($q->query("SELECT actor FROM transport_journal WHERE actor = 'after_neg'")->fetchColumn(), 'after_neg', 'вставка без id после id = -1');
        throws($q, "INSERT OR REPLACE INTO transport_journal (id, ts, actor) VALUES (1, 't', 'HACK')", 'append-only');
        eq($q->query('SELECT actor FROM transport_journal WHERE id = 1')->fetchColumn(), 'legit', 'запись id=1 цела');
        unset($q);
    } finally {
        $rmDb($f);
    }
    return 'ok';
});

$run('M5 БД, уже мигрированная до v15 без триггера trg_transport_journal_no_replace (dev-копия): migrate() создаёт его, данные журнала целы, повтор — no-op', function () use ($tmpDir, $realDb, $migrate, $rmDb) {
    $f = tempnam($tmpDir, 'sc_tdb_m5_');
    ok($f !== false && copy($realDb, $f), 'копия');
    try {
        eq($migrate($f, 'prep'), '6>15', 'подготовка: v15');
        $p = openDb($f);
        $p->exec('PRAGMA journal_mode = DELETE');
        $full = transportObjects($p);
        ok(isset($full['trigger:trg_transport_journal_no_replace']), 'эталон содержит триггер trg_transport_journal_no_replace');
        $p->exec('DROP TRIGGER trg_transport_journal_no_replace');   // состояние «v15 до фикса T1b»
        $p->exec("INSERT INTO transport_journal (ts, actor) VALUES ('m5', 'keep')");
        $p->exec("INSERT OR REPLACE INTO transport_journal (id, ts, actor) VALUES (1, 'm5', 'overwritten_before_fix')");   // без триггера — проходит
        eq(count(transportObjects($p)), count($full) - 1, 'триггера нет');
        unset($p);
        eq($migrate($f, 'plain'), '15>15', 'migrate() на актуальной версии');
        $q = openDb($f);
        eq(transportObjects($q), $full, 'триггер восстановлен, прочие объекты те же');
        eq($q->query('SELECT actor FROM transport_journal WHERE id = 1')->fetchColumn(), 'overwritten_before_fix', 'данные журнала не тронуты миграцией');
        throws($q, "INSERT OR REPLACE INTO transport_journal (id, ts, actor) VALUES (1, 'm5', 'HACK')", 'append-only');
        $snap = snapshotTables($q, ['audit_log', 'meta']);
        unset($q);
        eq($migrate($f, 'plain'), '15>15', 'повтор');
        $q = openDb($f);
        eq(transportObjects($q), $full, 'повтор — no-op: объекты');
        eq(snapshotTables($q, ['audit_log', 'meta']), $snap, 'повтор — no-op: данные');
        unset($q);
    } finally {
        $rmDb($f);
    }
    return 'триггер добавлен, повтор — no-op';
});

// ----------------------------------------------------------------------------
// transport_lib.php: юнит-проверки
// ----------------------------------------------------------------------------
$U_ADMIN = ['id' => 'admin', 'username' => 'admin', 'is_admin' => 1, 'can_edit' => 1];
$U_Z0 = ['id' => 'supervisor_zone0', 'username' => 'supervisor_zone0', 'is_admin' => 0, 'can_edit' => 1];
$U_Z1 = ['id' => 'supervisor_zone1', 'username' => 'supervisor_zone1', 'is_admin' => 0, 'can_edit' => 1];
$U_VIEW = ['id' => 'viewer_test', 'username' => 'viewer_test', 'is_admin' => 0, 'can_edit' => 0];
$U_OTHER = ['id' => 'sup_other', 'username' => 'sup_other', 'is_admin' => 0, 'can_edit' => 1];
$reqBy = static fn(string $by): array => ['id' => 'r_' . $by, 'created_by' => $by];

$run('L1 transport_check_step: кратность 15 (0/15/30/45/60/…), не кратные и отрицательные — нет', function () {
    need('transport_check_step');
    foreach ([0, 15, 30, 45, 60, 90, 1440, 10080] as $m) {
        eq(transport_check_step($m), true, "шаг $m");
    }
    foreach ([1, 5, 7, 14, 16, 29, 44, 61, -15, -1] as $m) {
        eq(transport_check_step($m), false, "не шаг $m");
    }
    return 'ok';
});

$run('L2 transport_now_local: формат YYYY-MM-DDTHH:MM, часовой пояс +05 (не UTC и не системный)', function () {
    need('transport_now_local');
    $s = transport_now_local();
    ok((bool) preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/', $s), 'формат: ' . $s);
    $expect = gmdate('Y-m-d\TH:i', time() + 5 * 3600);
    $diff = abs(strtotime($s . ':00 UTC') - strtotime($expect . ':00 UTC'));
    ok($diff <= 120, "расхождение с UTC+5: $diff с ($s vs $expect)");
    return $s;
});

$run('L3 transport_role / transport_user_id по строке users (admin / supervisor / viewer); без пользователя — пусто', function () use ($U_ADMIN, $U_Z0, $U_VIEW) {
    need('transport_role');
    need('transport_user_id');
    eq(transport_role($U_ADMIN), 'admin', 'admin');
    eq(transport_role($U_Z0), 'supervisor', 'supervisor');
    eq(transport_role($U_VIEW), 'viewer', 'viewer');
    eq(transport_user_id($U_Z0), 'supervisor_zone0', 'user id');
    eq(transport_role(null), '', 'без пользователя');
    eq(transport_user_id(null), '', 'без пользователя');
    return 'ok';
});

$run('L4 transport_can_move_vehicle: admin и viewer — да; supervisor_zone0/zone1 и аноним — нет', function () use ($U_ADMIN, $U_Z0, $U_Z1, $U_VIEW, $U_OTHER) {
    need('transport_can_move_vehicle');
    eq(transport_can_move_vehicle($U_ADMIN), true, 'admin');
    eq(transport_can_move_vehicle($U_VIEW), true, 'viewer');
    eq(transport_can_move_vehicle($U_Z0), false, 'zone0');
    eq(transport_can_move_vehicle($U_Z1), false, 'zone1');
    eq(transport_can_move_vehicle($U_OTHER), false, 'другой supervisor');
    eq(transport_can_move_vehicle(null), false, 'аноним');
    return 'ok';
});

$run('L5 TRANSPORT_EDIT_DELEGATION: ровно supervisor_zone0 → [supervisor_zone1], прочих записей нет', function () {
    ok(defined('TRANSPORT_EDIT_DELEGATION'), 'константа не определена');
    eq(TRANSPORT_EDIT_DELEGATION, ['supervisor_zone0' => ['supervisor_zone1']], 'карта делегирования');
    return 'ok';
});

$run('L6 transport_can_edit_request: admin — любые заявки (в т.ч. чужие и без автора)', function () use ($U_ADMIN, $reqBy) {
    need('transport_can_edit_request');
    foreach (['admin', 'supervisor_zone0', 'supervisor_zone1', 'viewer_test', 'unknown', ''] as $by) {
        eq(transport_can_edit_request($reqBy($by), $U_ADMIN), true, 'admin на заявку ' . $by);
    }
    return '6 заявок';
});

$run('L7 transport_can_edit_request: supervisor_zone0 — свои и заявки supervisor_zone1; чужие (admin, viewer, прочие) — нет', function () use ($U_Z0, $reqBy) {
    need('transport_can_edit_request');
    eq(transport_can_edit_request($reqBy('supervisor_zone0'), $U_Z0), true, 'свои');
    eq(transport_can_edit_request($reqBy('supervisor_zone1'), $U_Z0), true, 'заявки zone1');
    eq(transport_can_edit_request($reqBy('admin'), $U_Z0), false, 'заявки admin');
    eq(transport_can_edit_request($reqBy('viewer_test'), $U_Z0), false, 'заявки viewer');
    eq(transport_can_edit_request($reqBy('sup_other'), $U_Z0), false, 'заявки другого supervisor');
    eq(transport_can_edit_request($reqBy('unknown'), $U_Z0), false, 'неизвестный автор');
    eq(transport_can_edit_request(['id' => 'r'], $U_Z0), false, 'без created_by');
    return 'ok';
});

$run('L8 transport_can_edit_request: supervisor_zone1 — только свои; обратного права нет (zone0 и admin — чужие)', function () use ($U_Z1, $reqBy) {
    need('transport_can_edit_request');
    eq(transport_can_edit_request($reqBy('supervisor_zone1'), $U_Z1), true, 'свои');
    eq(transport_can_edit_request($reqBy('supervisor_zone0'), $U_Z1), false, 'заявки zone0');
    eq(transport_can_edit_request($reqBy('admin'), $U_Z1), false, 'заявки admin');
    eq(transport_can_edit_request($reqBy('viewer_test'), $U_Z1), false, 'заявки viewer');
    return 'ok';
});

$run('L9 transport_can_edit_request: viewer — никогда (даже собственная заявка), аноним — нет', function () use ($U_VIEW, $reqBy) {
    need('transport_can_edit_request');
    foreach (['viewer_test', 'supervisor_zone0', 'supervisor_zone1', 'admin'] as $by) {
        eq(transport_can_edit_request($reqBy($by), $U_VIEW), false, 'viewer на заявку ' . $by);
    }
    eq(transport_can_edit_request($reqBy('admin'), null), false, 'аноним');
    return 'ok';
});

$run('L10 «свой» = users.id автора, делегирование — по ЛОГИНУ автора (поиск в users): id ≠ логин не ломает правило', function () use ($pdo, $U_Z0, $U_Z1, $reqBy) {
    need('transport_can_edit_request');
    // В dev-БД id пользователя совпадает с логином; разводим их на время проверки (копия БД, возвращаем обратно).
    $pdo->exec("UPDATE users SET id = 'uid_z1_alias' WHERE username = 'supervisor_zone1'");
    try {
        $z1 = ['id' => 'uid_z1_alias'] + $U_Z1;
        eq(transport_can_edit_request($reqBy('uid_z1_alias'), $z1), true, 'свои по id');
        eq(transport_can_edit_request($reqBy('uid_z1_alias'), $U_Z0), true, 'zone0 правит заявку, созданную id автора zone1');
        eq(transport_can_edit_request($reqBy('supervisor_zone1'), $U_Z0), false, 'прежний id (логин) больше не автор');
        eq(transport_can_edit_request($reqBy('supervisor_zone0'), $z1), false, 'обратного права нет');
    } finally {
        $pdo->exec("UPDATE users SET id = 'supervisor_zone1' WHERE username = 'supervisor_zone1'");
    }
    return 'ok';
});

// Сотрудники-фикстуры (синтетические; телефон/фото заданы, чтобы проверить, что их не отдают).
foreach ([
    ['tdb_g1', 'Группов Первый', 'g6'], ['tdb_g2', 'Группов Второй', 'g6'],
    ['tdb_p1', 'Совместов Первый', 'g0'], ['tdb_p2', 'Совместов Второй', null],
    ['tdb_c1', 'Бригадов Один', 'g1'], ['tdb_c2', 'Бригадов Два', 'g1'],
] as [$eid, $nm, $gid]) {
    $pdo->prepare("INSERT INTO employees (id, full_name, location, group_id, phone, photo_url, sort_order)
                   VALUES (:i, :n, 'QA', :g, :ph, :pu, 0)")
        ->execute([':i' => $eid, ':n' => $nm, ':g' => $gid, ':ph' => '+79990000' . substr($eid, -1) . '00', ':pu' => 'photos/' . $eid . '.jpg']);
}

$driversMap = static function (array $list): array {
    $m = [];
    foreach ($list as $d) { $m[$d['employee_id']] = $d['source']; }
    ksort($m);
    return $m;
};

$run('L11 transport_allowed_drivers: группа «Транспорт» (по названию) ∪ пул; дубль схлопнут с приоритетом group; только employee_id/name/source', function () use ($pdo, $driversMap) {
    need('transport_allowed_drivers');
    eq($driversMap(transport_allowed_drivers($pdo)), ['tdb_g1' => 'group', 'tdb_g2' => 'group'], 'только группа');
    $pdo->exec("INSERT INTO transport_driver_pool (employee_id, added_by, added_at) VALUES ('tdb_p1', 'x', 'x'), ('tdb_g1', 'x', 'x')");
    $list = transport_allowed_drivers($pdo);
    eq($driversMap($list), ['tdb_g1' => 'group', 'tdb_g2' => 'group', 'tdb_p1' => 'pool'], 'группа ∪ пул, g1 — один раз как group');
    foreach ($list as $d) {
        eq(array_keys($d), ['employee_id', 'name', 'source'], 'ключи элемента');
    }
    $pdo->exec("DELETE FROM transport_driver_pool");
    return 'ok';
});

$run('L12 transport_allowed_drivers ищет группу по НАЗВАНИЮ, а не по id g6 (регистр и пробелы не важны)', function () use ($pdo, $driversMap) {
    need('transport_allowed_drivers');
    $pdo->exec("UPDATE groups SET name = 'Прочее' WHERE id = 'g6'");
    try {
        eq($driversMap(transport_allowed_drivers($pdo)), [], 'g6 переименована — её сотрудники больше не водители');
        $pdo->exec("INSERT INTO groups (id, name, sort_order) VALUES ('tdb_grp', '  ТРАНСПОРТ ', 99)");
        $pdo->exec("INSERT INTO employees (id, full_name, location, group_id, sort_order) VALUES ('tdb_g3', 'Группов Третий', 'QA', 'tdb_grp', 0)");
        eq($driversMap(transport_allowed_drivers($pdo)), ['tdb_g3' => 'group'], 'другая группа с названием «Транспорт»');
    } finally {
        $pdo->exec("UPDATE groups SET name = 'Транспорт' WHERE id = 'g6'");
        $pdo->exec("DELETE FROM employees WHERE id = 'tdb_g3'");
        $pdo->exec("DELETE FROM groups WHERE id = 'tdb_grp'");
    }
    eq($driversMap(transport_allowed_drivers($pdo)), ['tdb_g1' => 'group', 'tdb_g2' => 'group'], 'после восстановления');
    return 'ok';
});

$run('L13 transport_journal_write: запись внутри транзакции вызывающего; откат транзакции откатывает и запись; warnings_json — JSON', function () use ($pdo) {
    need('transport_journal_write');
    $n0 = (int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn();
    $pdo->beginTransaction();
    transport_journal_write($pdo, 'unit.rollback', 'vehicle', 'v_u', ['a' => 1], ['a' => 2]);
    eq((int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn(), $n0 + 1, 'видна внутри транзакции');
    $pdo->rollBack();
    eq((int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn(), $n0, 'после rollBack записи нет');
    $pdo->beginTransaction();
    transport_journal_write($pdo, 'unit.commit', 'vehicle', 'v_u', null, ['x' => 'Ёж'], [['code' => 'vehicle_overlap', 'severity' => 'warning']]);
    $pdo->commit();
    $r = $pdo->query("SELECT * FROM transport_journal WHERE action = 'unit.commit'")->fetch();
    eq($r['before_json'], null, 'before NULL');
    eq(json_decode((string) $r['after_json'], true), ['x' => 'Ёж'], 'after');
    eq(json_decode((string) $r['warnings_json'], true), [['code' => 'vehicle_overlap', 'severity' => 'warning']], 'warnings');
    ok(strpos((string) $r['after_json'], 'Ёж') !== false, 'кириллица не экранируется в \\u');
    ok((bool) preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:00$/', (string) $r['ts']), 'ts в +05: ' . $r['ts']);
    eq($r['entity_type'], 'vehicle', 'entity_type');
    eq($r['entity_id'], 'v_u', 'entity_id');
    ok($r['actor'] !== null && $r['actor'] !== '', 'actor заполнен');
    return 'ts ' . $r['ts'];
});

// ----------------------------------------------------------------------------
// HTTP-часть: временный php -S на копии БД
// ----------------------------------------------------------------------------
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
$base = "http://{$host}:{$port}";
$serverLog = tempnam($tmpDir, 'sc_tdb_srv_');
$cookies = ['admin' => tempnam($tmpDir, 'sc_td_a_'), 'z0' => tempnam($tmpDir, 'sc_td_0_'), 'z1' => tempnam($tmpDir, 'sc_td_1_'),
    'view' => tempnam($tmpDir, 'sc_td_v_'), 'anon' => tempnam($tmpDir, 'sc_td_n_')];
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
        CURLOPT_TIMEOUT => 30,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    if (!empty($o['cookie'])) {
        curl_setopt($ch, CURLOPT_COOKIEJAR, $o['cookie']);
        curl_setopt($ch, CURLOPT_COOKIEFILE, $o['cookie']);
    }
    if (array_key_exists('rawbody', $o)) {
        $headers[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, $o['rawbody']);
    } elseif (array_key_exists('body', $o)) {
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

$EP = $base . '/api/transport_vehicles.php';
$login = function (string $who, string $user) use ($base, $cookies): void {
    $r = req('POST', $base . '/api/login.php', ['cookie' => $cookies[$who], 'body' => ['username' => $user, 'password' => 'changeme']]);
    if ($r['status'] !== 200) {
        throw new RuntimeException("login $user failed: " . $r['status']);
    }
};
/** Запрос к API от имени роли: admin | z0 | z1 | view | anon. */
$api = fn(string $who, string $m, string $q = '', ?array $body = null) => req($m, $EP . $q, ['cookie' => $cookies[$who]] + ($body !== null ? ['body' => $body] : []));

// ---- помощники проверки состояния/журнала
$state = fn(): string => md5((string) json_encode([
    $pdo->query('SELECT * FROM transport_bases ORDER BY id')->fetchAll(),
    $pdo->query('SELECT * FROM vehicles ORDER BY id')->fetchAll(),
    $pdo->query('SELECT * FROM transport_driver_pool ORDER BY employee_id')->fetchAll(),
    $pdo->query('SELECT * FROM transport_journal ORDER BY id')->fetchAll(),
]));
$jMax = fn(): int => (int) $pdo->query('SELECT COALESCE(MAX(id), 0) FROM transport_journal')->fetchColumn();
/** Новые записи журнала после id. */
$jSince = function (int $after) use ($pdo): array {
    $rows = $pdo->query('SELECT * FROM transport_journal WHERE id > ' . $after . ' ORDER BY id')->fetchAll();
    foreach ($rows as &$r) {
        foreach (['before_json', 'after_json', 'warnings_json'] as $k) {
            $r[substr($k, 0, -5)] = $r[$k] === null ? null : json_decode((string) $r[$k], true);
        }
    }
    return $rows;
};
$norm = static function (mixed $v): mixed {
    if (is_array($v)) { ksort($v); }
    return $v;
};
/** Ровно одна новая запись журнала с заданными полями. */
$jOne = function (int $after, string $action, string $etype, string $eid, mixed $before, mixed $afterVal, string $actor = 'admin', string $role = 'admin') use ($jSince, $norm): array {
    $rows = $jSince($after);
    eq(count($rows), 1, 'новых записей журнала');
    $r = $rows[0];
    eq($r['action'], $action, 'action');
    eq($r['entity_type'], $etype, 'entity_type');
    eq($r['entity_id'], $eid, 'entity_id');
    eq($norm($r['before']), $norm($before), 'before');
    eq($norm($r['after']), $norm($afterVal), 'after');
    eq($r['actor'], $actor, 'actor');
    eq($r['role'], $role, 'role');
    eq($r['warnings_json'], null, 'warnings_json');
    ok((bool) preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:00$/', (string) $r['ts']), 'ts: ' . $r['ts']);
    return $r;
};
$vRow = fn(string $id): array => $pdo->query("SELECT * FROM vehicles WHERE id = '$id'")->fetch();
$bRow = fn(string $id): array => $pdo->query("SELECT * FROM transport_bases WHERE id = '$id'")->fetch();
$cnt = fn(string $t): int => (int) $pdo->query("SELECT COUNT(*) FROM $t")->fetchColumn();
$err = function (array $r, int $status, string $code) : void {
    eq($r['status'], $status, 'HTTP ' . substr($r['raw'], 0, 200));
    eq($r['json']['error'] ?? null, $code, 'error');
};
$ids = [];

try {
    $login('admin', 'admin');
    $login('z0', 'supervisor_zone0');
    $login('z1', 'supervisor_zone1');
    $login('view', 'viewer_test');

    // =====================================================================
    // Чтение
    // =====================================================================
    $run('G1 GET без сессии → 401 unauthorized', function () use ($api, $err) {
        $err($api('anon', 'GET'), 401, 'unauthorized');
        return 'ok';
    });

    foreach (['admin' => 'admin', 'z0' => 'supervisor_zone0', 'z1' => 'supervisor_zone1', 'view' => 'viewer_test'] as $who => $uname) {
        $run('G2 GET: ' . $uname . ' читает справочники (200; bases/vehicles/drivers)', function () use ($api, $who) {
            $r = $api($who, 'GET');
            eq($r['status'], 200, 'status ' . $r['raw']);
            eq($r['json']['success'] ?? null, true, 'success');
            foreach (['bases', 'vehicles', 'drivers'] as $k) {
                ok(isset($r['json'][$k]) && is_array($r['json'][$k]), 'нет списка ' . $k);
            }
            return 'ok';
        });
    }

    $run('G3 GET: drivers — только employee_id/name/source, без телефона и фото; группа и пул, дубль один раз', function () use ($api, $pdo, $driversMap) {
        $pdo->exec("INSERT INTO transport_driver_pool (employee_id, added_by, added_at) VALUES ('tdb_p1', 'x', 'x'), ('tdb_g1', 'x', 'x')");
        try {
            $r = $api('view', 'GET');
            eq($driversMap($r['json']['drivers']), ['tdb_g1' => 'group', 'tdb_g2' => 'group', 'tdb_p1' => 'pool'], 'drivers');
            foreach ($r['json']['drivers'] as $d) {
                eq(array_keys($d), ['employee_id', 'name', 'source'], 'ключи');
            }
            foreach (['phone', 'photo', '+79990000', 'photos/'] as $needle) {
                ok(strpos($r['raw'], $needle) === false, 'утечка «' . $needle . '» в ответе');
            }
            $names = array_column($r['json']['drivers'], 'name', 'employee_id');
            eq($names['tdb_p1'], 'Совместов Первый', 'имя');
        } finally {
            $pdo->exec('DELETE FROM transport_driver_pool');
        }
        return 'ok';
    });

    $run('G4 GET: недопустимый метод → 405; неизвестная сущность/действие → 400; битый JSON → 400 invalid_json', function () use ($api, $cookies, $EP, $err) {
        eq($api('admin', 'PATCH')['status'], 405, 'PATCH');
        $err($api('admin', 'POST', '?entity=bogus', ['name' => 'x']), 400, 'invalid_entity');
        $err($api('admin', 'POST', '?action=bogus&id=x', []), 400, 'invalid_action');
        $err($api('admin', 'POST', '', ['name' => 'x']), 400, 'invalid_entity');
        $r = req('POST', $EP . '?entity=base', ['cookie' => $cookies['admin'], 'rawbody' => '{bad json']);
        $err($r, 400, 'invalid_json');
        return 'ok';
    });

    // =====================================================================
    // Базы (admin)
    // =====================================================================
    $run('B1 POST ?entity=base: admin создаёт базу (201 {success, base}), запись в журнале base.create (before NULL)', function () use ($api, $jMax, $jOne, $bRow, &$ids) {
        $j = $jMax();
        $r = $api('admin', 'POST', '?entity=base', ['name' => 'Тестбаза Север', 'sort_order' => 10]);
        eq($r['status'], 201, 'status ' . $r['raw']);
        eq($r['json']['success'], true, 'success');
        $b = $r['json']['base'];
        eq(array_keys($b), ['id', 'name', 'sort_order'], 'поля base');
        eq([$b['name'], $b['sort_order']], ['Тестбаза Север', 10], 'значения');
        ok(is_string($b['id']) && strpos($b['id'], 'tb_') === 0, 'id с префиксом tb_: ' . $b['id']);
        eq($bRow($b['id'])['name'], 'Тестбаза Север', 'в БД');
        $ids['b1'] = $b['id'];
        $jOne($j, 'base.create', 'base', $b['id'], null, ['name' => 'Тестбаза Север', 'sort_order' => 10]);
        return $b['id'];
    });

    $run('B2 POST base без sort_order: следующий по порядку (max+1); имя обрезается и схлопывает пробелы', function () use ($api, &$ids) {
        $r = $api('admin', 'POST', '?entity=base', ['name' => '  Тестбаза    Юг ']);
        eq($r['status'], 201, 'status ' . $r['raw']);
        eq($r['json']['base']['name'], 'Тестбаза Юг', 'нормализованное имя');
        eq($r['json']['base']['sort_order'], 11, 'sort_order = max+1');
        $ids['b2'] = $r['json']['base']['id'];
        return 'ok';
    });

    $run('B3 POST base: пустое/пробельное/отсутствующее/нестроковое/слишком длинное имя → 422 invalid_name, ничего не пишется', function () use ($api, $state, $err) {
        $s = $state();
        foreach ([[''], ['   '], [null], [123], [['x']], [str_repeat('Ж', 101)]] as [$name]) {
            $body = $name === null ? [] : ['name' => $name];
            $err($api('admin', 'POST', '?entity=base', $body), 422, 'invalid_name');
        }
        eq($state(), $s, 'состояние и журнал не изменились');
        return '6 вариантов';
    });

    $run('B4 POST base: дубль имени (точный, без учёта регистра по-кириллице, с лишними пробелами) → 422 duplicate_name', function () use ($api, $state, $err) {
        $s = $state();
        foreach (['Тестбаза Север', 'тестбаза север', 'ТЕСТБАЗА СЕВЕР', '  Тестбаза   Север  '] as $nm) {
            $err($api('admin', 'POST', '?entity=base', ['name' => $nm]), 422, 'duplicate_name');
        }
        eq($state(), $s, 'состояние и журнал не изменились');
        return '4 варианта';
    });

    $run('B5 POST base: некорректный sort_order → 422 invalid_sort_order', function () use ($api, $state, $err) {
        $s = $state();
        foreach (['x', 1.5, ['1'], true] as $so) {
            $err($api('admin', 'POST', '?entity=base', ['name' => 'Тестбаза Мусор', 'sort_order' => $so]), 422, 'invalid_sort_order');
        }
        eq($state(), $s, 'не изменилось');
        return 'ok';
    });

    $run('B6 PUT ?entity=base&id=: переименование и порядок → 200, журнал base.update (before/after только изменённые поля)', function () use ($api, $jMax, $jOne, $bRow, &$ids) {
        $j = $jMax();
        $r = $api('admin', 'PUT', '?entity=base&id=' . rawurlencode($ids['b2']), ['name' => 'Тестбаза Юг-2', 'sort_order' => 20]);
        eq($r['status'], 200, 'status ' . $r['raw']);
        eq($r['json']['base'], ['id' => $ids['b2'], 'name' => 'Тестбаза Юг-2', 'sort_order' => 20], 'base в ответе');
        eq($bRow($ids['b2'])['name'], 'Тестбаза Юг-2', 'в БД');
        $jOne($j, 'base.update', 'base', $ids['b2'], ['name' => 'Тестбаза Юг', 'sort_order' => 11], ['name' => 'Тестбаза Юг-2', 'sort_order' => 20]);
        // вернуть имя
        $r2 = $api('admin', 'PUT', '?entity=base&id=' . rawurlencode($ids['b2']), ['name' => 'Тестбаза Юг']);
        eq($r2['status'], 200, 'возврат имени');
        return 'ok';
    });

    $run('B7 PUT base: без изменений — 200 и нет записи в журнале; смена регистра собственного имени допустима', function () use ($api, $jMax, $jSince, $bRow, &$ids) {
        $j = $jMax();
        $r = $api('admin', 'PUT', '?entity=base&id=' . rawurlencode($ids['b1']), ['name' => 'Тестбаза Север', 'sort_order' => 10]);
        eq($r['status'], 200, 'no-op ' . $r['raw']);
        eq($api('admin', 'PUT', '?entity=base&id=' . rawurlencode($ids['b1']), [])['status'], 200, 'пустое тело');
        eq($jSince($j), [], 'журнал без записей');
        $r = $api('admin', 'PUT', '?entity=base&id=' . rawurlencode($ids['b1']), ['name' => 'ТЕСТБАЗА СЕВЕР']);
        eq($r['status'], 200, 'смена регистра: ' . $r['raw']);
        eq($bRow($ids['b1'])['name'], 'ТЕСТБАЗА СЕВЕР', 'имя изменено');
        $api('admin', 'PUT', '?entity=base&id=' . rawurlencode($ids['b1']), ['name' => 'Тестбаза Север']);
        return 'ok';
    });

    $run('B8 PUT base: дубль чужого имени → 422 duplicate_name; неизвестная база → 404; нет id → 422 id_required; плохое имя → 422', function () use ($api, $state, $err, &$ids) {
        $s = $state();
        $err($api('admin', 'PUT', '?entity=base&id=' . rawurlencode($ids['b2']), ['name' => 'тестбаза север']), 422, 'duplicate_name');
        $err($api('admin', 'PUT', '?entity=base&id=tb_nope', ['name' => 'Х']), 404, 'not_found');
        $err($api('admin', 'PUT', '?entity=base', ['name' => 'Х']), 422, 'id_required');
        $err($api('admin', 'PUT', '?entity=base&id=' . rawurlencode($ids['b2']), ['name' => '  ']), 422, 'invalid_name');
        $err($api('admin', 'PUT', '?entity=base&id=' . rawurlencode($ids['b2']), ['sort_order' => 'abc']), 422, 'invalid_sort_order');
        eq($state(), $s, 'не изменилось');
        return 'ok';
    });

    // =====================================================================
    // Пул водителей-совместителей
    // =====================================================================
    $run('P1 POST ?entity=pool: admin добавляет совместителя (201), журнал driver_pool.add; в GET drivers источник «pool»', function () use ($api, $jMax, $jOne, $driversMap, $cnt) {
        $j = $jMax();
        $r = $api('admin', 'POST', '?entity=pool', ['employee_id' => 'tdb_p1']);
        eq($r['status'], 201, 'status ' . $r['raw']);
        eq($r['json']['success'], true, 'success');
        eq($cnt('transport_driver_pool'), 1, 'строка в пуле');
        $jOne($j, 'driver_pool.add', 'driver_pool', 'tdb_p1', null, ['employee_id' => 'tdb_p1']);
        $g = $api('view', 'GET');
        eq($driversMap($g['json']['drivers']), ['tdb_g1' => 'group', 'tdb_g2' => 'group', 'tdb_p1' => 'pool'], 'drivers');
        return 'ok';
    });

    $run('P2 POST pool: неизвестный/пустой/отсутствующий/нестроковый employee_id → 422 unknown_employee', function () use ($api, $state, $err) {
        $s = $state();
        foreach ([['employee_id' => 'нет_такого'], ['employee_id' => ''], [], ['employee_id' => 5]] as $body) {
            $err($api('admin', 'POST', '?entity=pool', $body), 422, 'unknown_employee');
        }
        eq($state(), $s, 'не изменилось');
        return 'ok';
    });

    $run('P3 POST pool: повторное добавление → 422 already_in_pool (без новой записи и без журнала)', function () use ($api, $state, $err) {
        $s = $state();
        $err($api('admin', 'POST', '?entity=pool', ['employee_id' => 'tdb_p1']), 422, 'already_in_pool');
        eq($state(), $s, 'не изменилось');
        return 'ok';
    });

    $run('P4 пул: сотрудник группы «Транспорт» тоже можно внести в пул, но в drivers он один раз (group); DELETE убирает из пула, журнал driver_pool.remove', function () use ($api, $jMax, $jOne, $jSince, $driversMap, $cnt) {
        $r = $api('admin', 'POST', '?entity=pool', ['employee_id' => 'tdb_g1']);
        eq($r['status'], 201, 'добавление члена группы: ' . $r['raw']);
        $g = $api('admin', 'GET');
        eq($driversMap($g['json']['drivers']), ['tdb_g1' => 'group', 'tdb_g2' => 'group', 'tdb_p1' => 'pool'], 'g1 один раз, как group');
        $j = $jMax();
        $d = $api('admin', 'DELETE', '?entity=pool&id=tdb_g1');
        eq($d['status'], 200, 'status ' . $d['raw']);
        eq($d['json']['success'], true, 'success');
        eq($cnt('transport_driver_pool'), 1, 'остался p1');
        $jOne($j, 'driver_pool.remove', 'driver_pool', 'tdb_g1', ['employee_id' => 'tdb_g1'], null);
        return 'ok';
    });

    $run('P5 DELETE pool: не из пула → 404 not_found; без id → 422 id_required; ничего не пишется', function () use ($api, $state, $err) {
        $s = $state();
        $err($api('admin', 'DELETE', '?entity=pool&id=tdb_c1'), 404, 'not_found');
        $err($api('admin', 'DELETE', '?entity=pool'), 422, 'id_required');
        eq($state(), $s, 'не изменилось');
        return 'ok';
    });

    $run('P6 drivers: сотрудник из пула, удалённый из employees, в списке не показывается (и GET не падает); запись пула можно убрать', function () use ($api, $pdo, $driversMap, $cnt) {
        $pdo->exec("INSERT INTO employees (id, full_name, location, sort_order) VALUES ('tdb_gone', 'Удалёнов Бывший', 'QA', 0)");
        $r = $api('admin', 'POST', '?entity=pool', ['employee_id' => 'tdb_gone']);
        eq($r['status'], 201, 'добавлен: ' . $r['raw']);
        $pdo->exec("DELETE FROM employees WHERE id = 'tdb_gone'");
        $g = $api('admin', 'GET');
        eq($g['status'], 200, 'GET: ' . $g['raw']);
        eq($driversMap($g['json']['drivers']), ['tdb_g1' => 'group', 'tdb_g2' => 'group', 'tdb_p1' => 'pool'], 'tdb_gone отсутствует');
        $d = $api('admin', 'DELETE', '?entity=pool&id=tdb_gone');
        eq($d['status'], 200, 'удаление устаревшей записи: ' . $d['raw']);
        eq($cnt('transport_driver_pool'), 1, 'остался p1');
        return 'ok';
    });

    // =====================================================================
    // Транспортные средства (admin)
    // =====================================================================
    $run('V1 POST ?entity=vehicle: создание ТС (201), госномер нормализуется (верхний регистр, без пробелов), version 1, status in_service, журнал vehicle.create', function () use ($api, $jMax, $jOne, $vRow, &$ids) {
        $j = $jMax();
        $r = $api('admin', 'POST', '?entity=vehicle', ['name' => 'ТС Тест-1', 'plate' => ' а 123 вс 86 ', 'base_id' => $ids['b1'], 'default_driver_id' => 'tdb_g1']);
        eq($r['status'], 201, 'status ' . $r['raw']);
        eq($r['json']['success'], true, 'success');
        $v = $r['json']['vehicle'];
        eq(array_keys($v), ['id', 'name', 'plate', 'base_id', 'status', 'default_driver_id', 'sort_order', 'version'], 'поля vehicle');
        eq([$v['name'], $v['plate'], $v['base_id'], $v['status'], $v['default_driver_id'], $v['version']],
            ['ТС Тест-1', 'А123ВС86', $ids['b1'], 'in_service', 'tdb_g1', 1], 'значения');
        ok(strpos($v['id'], 'tv_') === 0, 'id с префиксом tv_');
        eq($vRow($v['id'])['plate'], 'А123ВС86', 'в БД');
        $ids['v1'] = $v['id'];
        $jOne($j, 'vehicle.create', 'vehicle', $v['id'], null, ['name' => 'ТС Тест-1', 'plate' => 'А123ВС86', 'base_id' => $ids['b1'],
            'status' => 'in_service', 'default_driver_id' => 'tdb_g1', 'sort_order' => $v['sort_order']]);
        return $v['id'];
    });

    $run('V2 POST vehicle: status=repair, водитель из пула, явный sort_order; без sort_order — max+1', function () use ($api, &$ids) {
        $r = $api('admin', 'POST', '?entity=vehicle', ['name' => 'ТС Тест-2', 'plate' => 'в456ху77', 'base_id' => $ids['b2'], 'status' => 'repair', 'default_driver_id' => 'tdb_p1', 'sort_order' => 5]);
        eq($r['status'], 201, 'status ' . $r['raw']);
        eq([$r['json']['vehicle']['status'], $r['json']['vehicle']['default_driver_id'], $r['json']['vehicle']['sort_order'], $r['json']['vehicle']['plate']],
            ['repair', 'tdb_p1', 5, 'В456ХУ77'], 'значения');
        $ids['v2'] = $r['json']['vehicle']['id'];
        $r3 = $api('admin', 'POST', '?entity=vehicle', ['name' => 'ТС Тест-3', 'plate' => 'С789ТТ86', 'base_id' => $ids['b1']]);
        eq($r3['status'], 201, 'status ' . $r3['raw']);
        eq($r3['json']['vehicle']['default_driver_id'], null, 'без водителя');
        ok($r3['json']['vehicle']['sort_order'] > 5, 'sort_order = max+1: ' . $r3['json']['vehicle']['sort_order']);
        $ids['v3'] = $r3['json']['vehicle']['id'];
        return 'ok';
    });

    $run('V3 POST vehicle: нет/пустое имя или госномер, госномер >20 символов → 422 invalid_name / invalid_plate', function () use ($api, $state, $err, &$ids) {
        $s = $state();
        $ok = ['name' => 'Х', 'plate' => 'Т001ТТ01', 'base_id' => $ids['b1']];
        $err($api('admin', 'POST', '?entity=vehicle', array_diff_key($ok, ['name' => 1])), 422, 'invalid_name');
        $err($api('admin', 'POST', '?entity=vehicle', ['name' => '  '] + $ok), 422, 'invalid_name');
        $err($api('admin', 'POST', '?entity=vehicle', array_diff_key($ok, ['plate' => 1])), 422, 'invalid_plate');
        $err($api('admin', 'POST', '?entity=vehicle', ['plate' => ' '] + $ok), 422, 'invalid_plate');
        $err($api('admin', 'POST', '?entity=vehicle', ['plate' => str_repeat('А', 21)] + $ok), 422, 'invalid_plate');
        eq($state(), $s, 'не изменилось');
        return '5 вариантов';
    });

    $run('V4 POST vehicle: неизвестная/отсутствующая база → 422 unknown_base; неверный status → 422 invalid_status', function () use ($api, $state, $err, &$ids) {
        $s = $state();
        $ok = ['name' => 'Х', 'plate' => 'Т002ТТ01', 'base_id' => $ids['b1']];
        $err($api('admin', 'POST', '?entity=vehicle', ['base_id' => 'tb_нет'] + $ok), 422, 'unknown_base');
        $err($api('admin', 'POST', '?entity=vehicle', array_diff_key($ok, ['base_id' => 1])), 422, 'unknown_base');
        $err($api('admin', 'POST', '?entity=vehicle', ['status' => 'broken'] + $ok), 422, 'invalid_status');
        eq($state(), $s, 'не изменилось');
        return 'ok';
    });

    $run('V5 POST vehicle: default_driver_id только допустимый водитель (группа «Транспорт» ∪ пул): прочие сотрудники и неизвестные id → 422 driver_not_allowed', function () use ($api, $state, $err, &$ids) {
        $s = $state();
        $ok = ['name' => 'Х', 'plate' => 'Т003ТТ01', 'base_id' => $ids['b1']];
        foreach (['tdb_c1', 'tdb_p2', 'нет_такого'] as $d) {
            $err($api('admin', 'POST', '?entity=vehicle', ['default_driver_id' => $d] + $ok), 422, 'driver_not_allowed');
        }
        eq($state(), $s, 'не изменилось');
        $r = $api('admin', 'POST', '?entity=vehicle', ['default_driver_id' => '', 'plate' => 'Т004ТТ01'] + $ok);
        eq($r['status'], 201, 'пустая строка = без водителя: ' . $r['raw']);
        eq($r['json']['vehicle']['default_driver_id'], null, 'null');
        return 'ok';
    });

    $run('V6 POST vehicle: дубль госномера (точный, другой регистр, с пробелами) → 422 duplicate_plate', function () use ($api, $state, $err, &$ids) {
        $s = $state();
        $ok = ['name' => 'Х', 'base_id' => $ids['b1']];
        foreach (['А123ВС86', 'а123вс86', ' А 123 ВС 86 '] as $pl) {
            $err($api('admin', 'POST', '?entity=vehicle', ['plate' => $pl] + $ok), 422, 'duplicate_plate');
        }
        eq($state(), $s, 'не изменилось');
        return '3 варианта';
    });

    $run('V7 PUT vehicle: без version → 422 version_required; нечисловая version → 422 invalid_version', function () use ($api, $state, $err, &$ids) {
        $s = $state();
        $u = '?entity=vehicle&id=' . rawurlencode($ids['v1']);
        $err($api('admin', 'PUT', $u, ['name' => 'Новое']), 422, 'version_required');
        $err($api('admin', 'PUT', $u, ['name' => 'Новое', 'version' => null]), 422, 'version_required');
        $err($api('admin', 'PUT', $u, ['name' => 'Новое', 'version' => 'abc']), 422, 'invalid_version');
        eq($state(), $s, 'не изменилось');
        return 'ok';
    });

    $run('V8 PUT vehicle: изменение полей → 200, version+1, журнал vehicle.update (только изменённые поля), прочее не тронуто', function () use ($api, $jMax, $jOne, $vRow, &$ids) {
        $j = $jMax();
        $before = $vRow($ids['v1']);
        $r = $api('admin', 'PUT', '?entity=vehicle&id=' . rawurlencode($ids['v1']), ['version' => 1, 'name' => 'ТС Тест-1Б', 'status' => 'repair', 'sort_order' => 7, 'default_driver_id' => 'tdb_p1']);
        eq($r['status'], 200, 'status ' . $r['raw']);
        $v = $r['json']['vehicle'];
        eq([$v['name'], $v['status'], $v['sort_order'], $v['default_driver_id'], $v['version']], ['ТС Тест-1Б', 'repair', 7, 'tdb_p1', 2], 'ответ');
        $after = $vRow($ids['v1']);
        eq([$after['plate'], $after['base_id']], [$before['plate'], $before['base_id']], 'госномер и база не тронуты');
        eq((int) $after['version'], 2, 'version в БД');
        $jOne($j, 'vehicle.update', 'vehicle', $ids['v1'],
            ['name' => 'ТС Тест-1', 'status' => 'in_service', 'sort_order' => (int) $before['sort_order'], 'default_driver_id' => 'tdb_g1'],
            ['name' => 'ТС Тест-1Б', 'status' => 'repair', 'sort_order' => 7, 'default_driver_id' => 'tdb_p1']);
        return 'v2';
    });

    $run('V9 PUT vehicle: смена base_id этим путём запрещена → 422 use_move (ТС не меняется); та же база игнорируется', function () use ($api, $state, $err, $vRow, &$ids) {
        $s = $state();
        $u = '?entity=vehicle&id=' . rawurlencode($ids['v1']);
        $err($api('admin', 'PUT', $u, ['version' => 2, 'base_id' => $ids['b2']]), 422, 'use_move');
        $err($api('admin', 'PUT', $u, ['version' => 2, 'name' => 'Другое имя', 'base_id' => $ids['b2']]), 422, 'use_move');
        eq($state(), $s, 'ничего не изменилось (в т.ч. имя из того же запроса)');
        $r = $api('admin', 'PUT', $u, ['version' => 2, 'base_id' => $ids['b1']]);
        eq($r['status'], 200, 'тот же base_id: ' . $r['raw']);
        eq($state(), $s, 'без изменений — версия и журнал прежние');
        return 'ok';
    });

    $run('V10 PUT vehicle: устаревшая version → 409 VERSION_CONFLICT с current_version и актуальным ТС; ТС и журнал не меняются', function () use ($api, $state, &$ids) {
        $s = $state();
        $r = $api('admin', 'PUT', '?entity=vehicle&id=' . rawurlencode($ids['v1']), ['version' => 1, 'name' => 'Опоздавший']);
        eq($r['status'], 409, 'status ' . $r['raw']);
        eq($r['json']['error'], 'VERSION_CONFLICT', 'error');
        eq($r['json']['current_version'], 2, 'current_version');
        eq($r['json']['vehicle']['id'], $ids['v1'], 'vehicle в ответе');
        eq($r['json']['vehicle']['name'], 'ТС Тест-1Б', 'актуальное имя');
        eq($state(), $s, 'не изменилось');
        return 'ok';
    });

    $run('V11 PUT vehicle: госномер — дубль чужого → 422 duplicate_plate; собственный (в т.ч. другим регистром) допустим и нормализуется', function () use ($api, $state, $err, $vRow, &$ids) {
        $u = '?entity=vehicle&id=' . rawurlencode($ids['v1']);
        $s = $state();
        $err($api('admin', 'PUT', $u, ['version' => 2, 'plate' => 'в456ху77']), 422, 'duplicate_plate');
        $err($api('admin', 'PUT', $u, ['version' => 2, 'plate' => ' ']), 422, 'invalid_plate');
        eq($state(), $s, 'не изменилось');
        $r = $api('admin', 'PUT', $u, ['version' => 2, 'plate' => 'а123вс86']);
        eq($r['status'], 200, 'свой номер: ' . $r['raw']);
        eq($vRow($ids['v1'])['plate'], 'А123ВС86', 'номер нормализован');
        $r = $api('admin', 'PUT', $u, ['version' => 2, 'plate' => 'К321КК86']);
        eq($r['status'], 200, 'новый номер: ' . $r['raw']);
        eq($r['json']['vehicle']['plate'], 'К321КК86', 'plate');
        eq($r['json']['vehicle']['version'], 3, 'version 3');
        return 'ok';
    });

    $run('V12 PUT vehicle: водитель — допустимый или null (очистка), иначе 422 driver_not_allowed; неверный status → 422 invalid_status; неизвестное ТС → 404', function () use ($api, $state, $err, $jMax, $jOne, $vRow, &$ids) {
        $u = '?entity=vehicle&id=' . rawurlencode($ids['v1']);
        $s = $state();
        $err($api('admin', 'PUT', $u, ['version' => 3, 'default_driver_id' => 'tdb_c1']), 422, 'driver_not_allowed');
        $err($api('admin', 'PUT', $u, ['version' => 3, 'status' => 'gone']), 422, 'invalid_status');
        $err($api('admin', 'PUT', '?entity=vehicle&id=' . rawurlencode('tv_нет'), ['version' => 1, 'name' => 'Х']), 404, 'not_found');
        $err($api('admin', 'PUT', '?entity=vehicle', ['version' => 1, 'name' => 'Х']), 422, 'id_required');
        eq($state(), $s, 'не изменилось');
        $j = $jMax();
        $r = $api('admin', 'PUT', $u, ['version' => 3, 'default_driver_id' => null]);
        eq($r['status'], 200, 'очистка: ' . $r['raw']);
        eq($r['json']['vehicle']['default_driver_id'], null, 'null');
        $jOne($j, 'vehicle.update', 'vehicle', $ids['v1'], ['default_driver_id' => 'tdb_p1'], ['default_driver_id' => null]);
        return 'ok';
    });

    $run('V13 PUT vehicle: пустой набор изменений — 200, version не растёт, журнала нет', function () use ($api, $jMax, $jSince, $vRow, &$ids) {
        $j = $jMax();
        $cur = (int) $vRow($ids['v1'])['version'];
        $r = $api('admin', 'PUT', '?entity=vehicle&id=' . rawurlencode($ids['v1']), ['version' => $cur]);
        eq($r['status'], 200, 'status ' . $r['raw']);
        eq((int) $vRow($ids['v1'])['version'], $cur, 'version прежняя');
        eq($jSince($j), [], 'журнал пуст');
        return 'v' . $cur;
    });

    $run('P7 DELETE pool: сотрудник — default_driver_id ТС → 409 driver_in_use (из пула не убирается, журнала нет); после снятия с ТС удаляется', function () use ($api, $state, $err, $vRow, $cnt, &$ids) {
        $s = $state();
        $r = $api('admin', 'DELETE', '?entity=pool&id=tdb_p1');
        $err($r, 409, 'driver_in_use');
        eq($r['json']['vehicle_ids'], [$ids['v2']], 'какие ТС держат водителя');
        eq($state(), $s, 'не изменилось');
        $v2 = $vRow($ids['v2']);
        $c = $api('admin', 'PUT', '?entity=vehicle&id=' . rawurlencode($ids['v2']), ['version' => (int) $v2['version'], 'default_driver_id' => null]);
        eq($c['status'], 200, 'снят с ТС: ' . $c['raw']);
        $d = $api('admin', 'DELETE', '?entity=pool&id=tdb_p1');
        eq($d['status'], 200, 'теперь удаляется: ' . $d['raw']);
        eq($cnt('transport_driver_pool'), 0, 'пул пуст');
        // вернуть для следующих проверок
        eq($api('admin', 'POST', '?entity=pool', ['employee_id' => 'tdb_p1'])['status'], 201, 'возврат в пул');
        return 'ok';
    });

    // =====================================================================
    // Права: таблица CONTRACT.md (запись справочников — только admin; аноним 401, прочие 403)
    // =====================================================================
    $verOf = fn(string $vid): int => (int) $pdo->query("SELECT version FROM vehicles WHERE id = '" . $vid . "'")->fetchColumn();
    $writeCases = [
        'POST base' => fn(string $who) => ['POST', '?entity=base', ['name' => 'Хакерская база ' . $who]],
        'PUT base' => fn(string $who) => ['PUT', '?entity=base&id=' . rawurlencode($ids['b1']), ['name' => 'Хакнутая']],
        'POST vehicle' => fn(string $who) => ['POST', '?entity=vehicle', ['name' => 'Х', 'plate' => 'Н999НН99', 'base_id' => $ids['b1']]],
        'PUT vehicle' => fn(string $who) => ['PUT', '?entity=vehicle&id=' . rawurlencode($ids['v1']), ['version' => $verOf($ids['v1']), 'name' => 'Хак']],
        'POST pool' => fn(string $who) => ['POST', '?entity=pool', ['employee_id' => 'tdb_p2']],
        'DELETE pool' => fn(string $who) => ['DELETE', '?entity=pool&id=tdb_p1', null],
    ];
    foreach (['anon' => [401, 'unauthorized', 'аноним'], 'z0' => [403, 'forbidden', 'supervisor_zone0'], 'z1' => [403, 'forbidden', 'supervisor_zone1'], 'view' => [403, 'forbidden', 'viewer_test']] as $who => [$st, $code, $label]) {
        foreach ($writeCases as $name => $mk) {
            $run("R1 права: $label — $name → $st $code, состояние БД и журнал не меняются", function () use ($api, $state, $err, $who, $st, $code, $mk) {
                $s = $state();
                [$m, $q, $b] = $mk($who);
                $err($api($who, $m, $q, $b), $st, $code);
                eq($state(), $s, 'не изменилось');
                return 'ok';
            });
        }
    }

    // =====================================================================
    // Перенос ТС между базами (admin или viewer)
    // =====================================================================
    foreach (['anon' => [401, 'unauthorized', 'аноним'], 'z0' => [403, 'forbidden', 'supervisor_zone0'], 'z1' => [403, 'forbidden', 'supervisor_zone1']] as $who => [$st, $code, $label]) {
        $run("R2 права: $label — action=move → $st $code, ТС не перенесено, журнала нет", function () use ($api, $state, $err, $vRow, $who, $st, $code, &$ids) {
            $s = $state();
            $v = $vRow($ids['v1']);
            $r = $api($who, 'POST', '?action=move&id=' . rawurlencode($ids['v1']), ['base_id' => $ids['b2'], 'version' => (int) $v['version']]);
            $err($r, $st, $code);
            eq($state(), $s, 'не изменилось');
            eq($vRow($ids['v1'])['base_id'], $ids['b1'], 'база прежняя');
            return 'ok';
        });
    }

    $run('M1 viewer_test переносит ТС: 200 {success, vehicle}, base_id и version+1 в БД, журнал vehicle.move с before/after {base_id}, actor/role viewer', function () use ($api, $jMax, $jOne, $vRow, &$ids) {
        $j = $jMax();
        $before = $vRow($ids['v1']);
        $r = $api('view', 'POST', '?action=move&id=' . rawurlencode($ids['v1']), ['base_id' => $ids['b2'], 'version' => (int) $before['version']]);
        eq($r['status'], 200, 'status ' . $r['raw']);
        eq($r['json']['success'], true, 'success');
        eq($r['json']['vehicle']['base_id'], $ids['b2'], 'vehicle.base_id');
        eq($r['json']['vehicle']['version'], (int) $before['version'] + 1, 'vehicle.version');
        $after = $vRow($ids['v1']);
        eq($after['base_id'], $ids['b2'], 'base_id в БД');
        foreach (['name', 'plate', 'status', 'default_driver_id', 'sort_order'] as $f) {
            eq($after[$f], $before[$f], 'поле не тронуто: ' . $f);
        }
        $jOne($j, 'vehicle.move', 'vehicle', $ids['v1'], ['base_id' => $ids['b1']], ['base_id' => $ids['b2']], 'viewer_test', 'viewer');
        return 'v' . $after['version'];
    });

    $run('M2 admin тоже переносит ТС (обратно): 200, журнал vehicle.move от admin; GET показывает новую базу', function () use ($api, $jMax, $jOne, $vRow, &$ids) {
        $j = $jMax();
        $cur = (int) $vRow($ids['v1'])['version'];
        $r = $api('admin', 'POST', '?action=move&id=' . rawurlencode($ids['v1']), ['base_id' => $ids['b1'], 'version' => $cur]);
        eq($r['status'], 200, 'status ' . $r['raw']);
        $jOne($j, 'vehicle.move', 'vehicle', $ids['v1'], ['base_id' => $ids['b2']], ['base_id' => $ids['b1']]);
        $g = $api('z0', 'GET');
        $row = null;
        foreach ($g['json']['vehicles'] as $v) { if ($v['id'] === $ids['v1']) { $row = $v; } }
        eq($row['base_id'], $ids['b1'], 'GET: база');
        eq($row['version'], $cur + 1, 'GET: версия');
        return 'ok';
    });

    $run('M3 move: неизвестная или отсутствующая база → 422 unknown_base; та же база → 422 same_base; без version → 422 version_required', function () use ($api, $state, $err, $vRow, &$ids) {
        $s = $state();
        $u = '?action=move&id=' . rawurlencode($ids['v1']);
        $cur = (int) $vRow($ids['v1'])['version'];
        $err($api('view', 'POST', $u, ['base_id' => 'tb_нет', 'version' => $cur]), 422, 'unknown_base');
        $err($api('view', 'POST', $u, ['version' => $cur]), 422, 'unknown_base');
        $err($api('view', 'POST', $u, ['base_id' => $ids['b1'], 'version' => $cur]), 422, 'same_base');
        $err($api('view', 'POST', $u, ['base_id' => $ids['b2']]), 422, 'version_required');
        $err($api('view', 'POST', $u, ['base_id' => $ids['b2'], 'version' => 'x']), 422, 'invalid_version');
        eq($state(), $s, 'не изменилось');
        return 'ok';
    });

    $run('M4 move: устаревшая версия → 409 VERSION_CONFLICT (current_version, vehicle); неизвестное ТС → 404; без id → 422 id_required', function () use ($api, $state, $err, $vRow, &$ids) {
        $s = $state();
        $cur = (int) $vRow($ids['v1'])['version'];
        $r = $api('view', 'POST', '?action=move&id=' . rawurlencode($ids['v1']), ['base_id' => $ids['b2'], 'version' => $cur - 1]);
        $err($r, 409, 'VERSION_CONFLICT');
        eq($r['json']['current_version'], $cur, 'current_version');
        eq($r['json']['vehicle']['id'], $ids['v1'], 'vehicle');
        eq($r['json']['vehicle']['base_id'], $ids['b1'], 'актуальная база');
        $err($api('view', 'POST', '?action=move&id=' . rawurlencode('tv_нет'), ['base_id' => $ids['b2'], 'version' => 1]), 404, 'not_found');
        $err($api('view', 'POST', '?action=move', ['base_id' => $ids['b2'], 'version' => 1]), 422, 'id_required');
        eq($state(), $s, 'не изменилось');
        return 'ok';
    });

    $run('M5 два переноса подряд с одной и той же версией: второй — 409 (оптимистичная блокировка), перенос только один', function () use ($api, $jMax, $jSince, $vRow, &$ids) {
        $u = '?action=move&id=' . rawurlencode($ids['v3']);
        $cur = (int) $vRow($ids['v3'])['version'];
        $j = $jMax();
        $a = $api('view', 'POST', $u, ['base_id' => $ids['b2'], 'version' => $cur]);
        $b = $api('admin', 'POST', $u, ['base_id' => $ids['b2'], 'version' => $cur]);
        eq([$a['status'], $b['status']], [200, 409], 'статусы');
        eq(count($jSince($j)), 1, 'одна запись журнала');
        eq($vRow($ids['v3'])['base_id'], $ids['b2'], 'база');
        return 'ok';
    });

    $run('M6 перенос постоянный и не меняет уже созданные назначения (заявка, назначение, бригада, остановки — без изменений)', function () use ($api, $pdo, $vRow, &$ids) {
        $pdo->exec("INSERT INTO transport_requests (id, title, created_by) VALUES ('mv_r', 'Заявка переноса', 'admin')");
        $pdo->exec("INSERT INTO transport_assignments (id, request_id, vehicle_id, driver_id, driver_name_snap, start_at, duration_min, end_at, version)
            VALUES ('mv_a', 'mv_r', '" . $ids['v2'] . "', 'tdb_g1', 'Группов Первый', '2031-06-01T08:00', 120, '2031-06-01T10:00', 1)");
        $pdo->exec("INSERT INTO assignment_crew (assignment_id, employee_id, name_snap) VALUES ('mv_a', 'tdb_c1', 'Бригадов Один')");
        $pdo->exec("INSERT INTO assignment_stops (assignment_id, ord, kind, place, stay_min, leg_min) VALUES ('mv_a', 1, 'departure', 'Тестбаза Юг', 0, 0), ('mv_a', 2, 'arrival', 'Пункт', 15, 60)");
        $snap = fn(): string => md5((string) json_encode([
            $pdo->query('SELECT * FROM transport_requests ORDER BY id')->fetchAll(),
            $pdo->query('SELECT * FROM transport_assignments ORDER BY id')->fetchAll(),
            $pdo->query('SELECT * FROM assignment_crew ORDER BY assignment_id, employee_id')->fetchAll(),
            $pdo->query('SELECT * FROM assignment_stops ORDER BY assignment_id, ord')->fetchAll(),
        ]));
        $s = $snap();
        $baseBefore = $vRow($ids['v2'])['base_id'];
        $target = $baseBefore === $ids['b1'] ? $ids['b2'] : $ids['b1'];
        $r = $api('view', 'POST', '?action=move&id=' . rawurlencode($ids['v2']), ['base_id' => $target, 'version' => (int) $vRow($ids['v2'])['version']]);
        eq($r['status'], 200, 'перенос ТС в ремонте: ' . $r['raw']);
        eq($vRow($ids['v2'])['base_id'], $target, 'база изменена навсегда');
        eq($snap(), $s, 'заявки, назначения, бригада и остановки не изменились');
        eq($api('admin', 'GET')['status'], 200, 'GET после переноса');
        return 'ok';
    });

    // =====================================================================
    // Журнал: набор действий, атомарность, неизменяемость через API-пути
    // =====================================================================
    $run('J6 журнал: все действия контракта встречаются (base.create/update, vehicle.create/update/move, driver_pool.add/remove); у всех ts в +05 и actor', function () use ($pdo) {
        $got = $pdo->query("SELECT DISTINCT action FROM transport_journal WHERE action NOT LIKE 'test.%' AND action NOT LIKE 'unit.%' ORDER BY action")->fetchAll(PDO::FETCH_COLUMN);
        foreach (['base.create', 'base.update', 'vehicle.create', 'vehicle.update', 'vehicle.move', 'driver_pool.add', 'driver_pool.remove'] as $a) {
            ok(in_array($a, $got, true), 'нет действия ' . $a . ' (есть: ' . implode(',', $got) . ')');
        }
        $bad = $pdo->query("SELECT COUNT(*) FROM transport_journal WHERE action NOT LIKE 'test.%' AND action NOT LIKE 'unit.%'
            AND (actor IS NULL OR actor = '' OR role IS NULL OR role = '' OR ts NOT LIKE '____-__-__T__:__:__+05:00')")->fetchColumn();
        eq((int) $bad, 0, 'записей без actor/role или с ts не в +05');
        return implode(', ', $got);
    });

    $run('J7 журнал: UPDATE/DELETE записи, созданной через API, невозможны (триггер), набор записей не меняется', function () use ($pdo) {
        $row = $pdo->query("SELECT id FROM transport_journal WHERE action = 'vehicle.move' ORDER BY id DESC LIMIT 1")->fetch();
        ok($row !== false, 'есть запись vehicle.move');
        $n = (int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn();
        throws($pdo, "UPDATE transport_journal SET after_json = '{\"base_id\":\"hacked\"}' WHERE id = " . $row['id'], 'append-only');
        throws($pdo, "DELETE FROM transport_journal WHERE id = " . $row['id'], 'append-only');
        eq((int) $pdo->query('SELECT COUNT(*) FROM transport_journal')->fetchColumn(), $n, 'число записей');
        return 'id ' . $row['id'];
    });

    $run('J8 атомарность: если запись журнала не удалась — мутация откатывается целиком (500, ТС/база/пул не изменены)', function () use ($api, $pdo, $state, $vRow, &$ids) {
        $pdo->exec("CREATE TRIGGER tdb_boom BEFORE INSERT ON transport_journal BEGIN SELECT RAISE(ABORT, 'boom'); END");
        try {
            $s = $state();
            $v = $vRow($ids['v1']);
            $r1 = $api('admin', 'POST', '?entity=base', ['name' => 'Откатная база']);
            $r2 = $api('admin', 'PUT', '?entity=vehicle&id=' . rawurlencode($ids['v1']), ['version' => (int) $v['version'], 'name' => 'Откат имени']);
            $r3 = $api('view', 'POST', '?action=move&id=' . rawurlencode($ids['v1']), ['base_id' => $ids['b2'], 'version' => (int) $v['version']]);
            $r4 = $api('admin', 'POST', '?entity=pool', ['employee_id' => 'tdb_p2']);
            $r5 = $api('admin', 'DELETE', '?entity=pool&id=tdb_p1');
            $r6 = $api('admin', 'POST', '?entity=vehicle', ['name' => 'Откат', 'plate' => 'О001ОО01', 'base_id' => $ids['b1']]);
            foreach ([$r1, $r2, $r3, $r4, $r5, $r6] as $i => $r) {
                eq($r['status'], 500, 'запрос ' . ($i + 1) . ': ' . substr($r['raw'], 0, 200));
                eq($r['json']['error'] ?? null, 'server_error', 'код ошибки');
                ok(strpos($r['raw'], 'boom') === false && strpos($r['raw'], '.php') === false, 'нет внутренних деталей в ответе');
            }
            eq($state(), $s, 'состояние не изменилось');
        } finally {
            $pdo->exec('DROP TRIGGER IF EXISTS tdb_boom');
        }
        $ok = $api('admin', 'POST', '?entity=base', ['name' => 'Откатная база']);
        eq($ok['status'], 201, 'после снятия сбоя запись проходит: ' . $ok['raw']);
        return 'ok';
    });

    $run('J9 утечки и устойчивость: ответы не содержат путей/SQL; id/параметры со спецсимволами не ломают API (инъекции безвредны)', function () use ($api, $pdo, $state, $err, &$ids) {
        $s = $state();
        foreach (["x' OR '1'='1", 'a"; DROP TABLE vehicles;--', '%', '../../etc/passwd'] as $id) {
            $r = $api('admin', 'PUT', '?entity=vehicle&id=' . rawurlencode($id), ['version' => 1, 'name' => 'Х']);
            $err($r, 404, 'not_found');
            ok(strpos($r['raw'], 'SQLSTATE') === false && strpos($r['raw'], '/home/') === false, 'нет деталей в ответе');
            $r = $api('admin', 'DELETE', '?entity=pool&id=' . rawurlencode($id));
            $err($r, 404, 'not_found');
        }
        $r = $api('admin', 'POST', '?entity=vehicle', ['name' => "<b>'\";--</b>", 'plate' => "О'1\"О01", 'base_id' => $ids['b1']]);
        eq($r['status'], 201, 'спецсимволы в имени/номере сохраняются как текст: ' . $r['raw']);
        eq($r['json']['vehicle']['name'], "<b>'\";--</b>", 'имя как есть');
        ok((int) $pdo->query('SELECT COUNT(*) FROM vehicles')->fetchColumn() >= 4, 'таблица vehicles цела');
        return 'ok';
    });
} finally {
    proc_terminate($proc);
    foreach ($cookies as $c) { @unlink($c); }
    @unlink($serverLog);
}

// Файлы сессии от auth.php (подключён из transport_lib.php) и временные файлы.
if (function_exists('session_id') && session_id() !== '') {
    @unlink(rtrim(session_save_path(), '/') . '/sess_' . session_id());
}
@unlink($migScript);

// Явно закрываем соединение и удаляем копию БД.
unset($pdo, $db);
$rmDb($tmpDb);

$realDbHashAfter = is_file($realDb) ? sha1_file($realDb) : '';
$dbIntact = ($realDbHashBefore === $realDbHashAfter);

out('=== RESULTS: ' . $passed . ' passed, ' . $failed . ' failed out of ' . ($passed + $failed) . ' ===');
out('DB intact: ' . ($dbIntact ? 'YES' : 'NO'));
exit(($failed === 0 && $dbIntact) ? 0 : 1);
