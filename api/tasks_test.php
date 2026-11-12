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
$groupsBefore = $pdo->query('SELECT id, name, sort_order FROM groups ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
$metaBefore = $pdo->query("SELECT key, value FROM meta WHERE key != 'schema_version' ORDER BY key")->fetchAll(PDO::FETCH_ASSOC);

out('=== TASKS TEST START ===');

$run('M1 миграция: схема < 9 → 11 (v10 T1-7, v11 V6-3), три таблицы созданы', function () use ($db, $pdo, $verBefore) {
    ok($verBefore < 9, 'ожидалась исходная схема < 9, а не ' . $verBefore);
    $has = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_assignees','task_checklist')")
        ->fetchAll(PDO::FETCH_COLUMN);
    ok(count($has) === 0, 'таблицы задач уже есть до миграции');
    $db->migrate();
    eq($db->getSchemaVersion(), 11, 'schema_version');
    $has = $pdo->query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_assignees','task_checklist') ORDER BY name")
        ->fetchAll(PDO::FETCH_COLUMN);
    eq($has, ['task_assignees', 'task_checklist', 'tasks'], 'tables');
    return 'v' . $verBefore . '→v11';
});

$run('M2 миграция: колонки и индексы по TZ §1', function () use ($pdo) {
    eq(tcols($pdo, 'tasks'), ['id', 'title', 'description', 'start_at', 'end_at', 'priority', 'label', 'status',
        'check_state', 'version', 'created_by', 'created_at', 'updated_at', 'closed_at', 'archived'], 'tasks cols');
    eq(tcols($pdo, 'task_assignees'), ['task_id', 'employee_id', 'role', 'full_name_snapshot'], 'task_assignees cols');
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
        "INSERT INTO task_assignees (task_id, employee_id, role) VALUES ('tt_def', 'nobody', 'boss')",
    ] as $sql) {
        $threw = false;
        try { $pdo->exec($sql); } catch (PDOException $e) { $threw = true; }
        ok($threw, 'ограничение не сработало: ' . $sql);
    }
    // v10 (T1-7): у task_assignees НЕТ FK на employees — назначение несуществующего сотрудника не отвергается
    // (так «исполнитель удалён» переживает удаление сотрудника); FK на tasks (CASCADE) сохранён.
    $pdo->exec("INSERT INTO task_assignees (task_id, employee_id, role, full_name_snapshot) VALUES ('tt_def', 'nobody', 'watcher', 'Снимок')");
    $fks = $pdo->query('PRAGMA foreign_key_list(task_assignees)')->fetchAll(PDO::FETCH_ASSOC);
    eq(array_map(fn($f) => [$f['table'], $f['on_delete']], $fks), [['tasks', 'CASCADE']], 'FK task_assignees');
    $pdo->exec("DELETE FROM tasks WHERE id = 'tt_def'");
    eq((int) $pdo->query("SELECT COUNT(*) FROM task_assignees WHERE task_id = 'tt_def'")->fetchColumn(), 0, 'CASCADE по tasks');
    return 'cols+indexes+CHECK+без FK на employees';
});

$run('M3 миграция: существующие данные не тронуты', function () use ($pdo, $snapBefore, $metaBefore, $groupsBefore) {
    $snapAfter = snapshotTables($pdo, ['audit_log', 'meta', 'tasks', 'task_assignees', 'task_checklist']);
    foreach ($snapBefore as $t => $s) {
        ok(isset($snapAfter[$t]), 'таблица пропала: ' . $t);
        if ($t === 'groups') {
            continue; // v11 (V6-3) переименовывает g3 — проверяется ниже и в M6
        }
        eq($snapAfter[$t], $s, 'таблица ' . $t);
    }
    // groups: изменилась ТОЛЬКО g3 «В2С» → «Директор СЦ» (v11), остальные группы побайтово те же.
    $groupsAfter = $pdo->query('SELECT id, name, sort_order FROM groups ORDER BY id')->fetchAll(PDO::FETCH_ASSOC);
    $expectGroups = array_map(function ($g) {
        if ($g['id'] === 'g3' && $g['name'] === 'В2С') {
            $g['name'] = 'Директор СЦ';
        }
        return $g;
    }, $groupsBefore);
    eq($groupsAfter, $expectGroups, 'groups: только g3 переименована');
    $metaAfter = $pdo->query("SELECT key, value FROM meta WHERE key != 'schema_version' ORDER BY key")->fetchAll(PDO::FETCH_ASSOC);
    eq($metaAfter, $metaBefore, 'meta');
    return count($snapBefore) . ' таблиц побайтово равны';
});

$run('M4 миграция идемпотентна (повтор + откат версии на 8 с данными задач)', function () use ($db, $pdo) {
    $db->migrate();
    eq($db->getSchemaVersion(), 11, 'повторная миграция');
    $pdo->exec("INSERT INTO tasks (id, title, start_at) VALUES ('tt_keep', 'keep', '2030-01-02')");
    $pdo->exec("UPDATE meta SET value = '8' WHERE key = 'schema_version'");
    $db->migrate();
    eq($db->getSchemaVersion(), 11, 'миграция с v8');
    eq((int) $pdo->query("SELECT COUNT(*) FROM tasks WHERE id = 'tt_keep'")->fetchColumn(), 1, 'строка задачи сохранена');
    $pdo->exec("DELETE FROM tasks WHERE id = 'tt_keep'");
    return 'v11→v11, v8→v11';
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

// --- Миграция v10 → v11 (V6-3, R-2): g3 «В2С» → «Директор СЦ» -------------------
$run('M6 миграция v10→v11: g3 «В2С»→«Директор СЦ»; прочие группы и данные не тронуты; повтор и чужое имя — no-op', function () use ($db, $pdo) {
    $snapNoGroups = snapshotTables($pdo, ['audit_log', 'meta', 'groups']);
    $others = $pdo->query("SELECT id, name, sort_order FROM groups WHERE id != 'g3' ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);
    // состояние v10: у g3 старое имя
    $pdo->exec("UPDATE groups SET name = 'В2С' WHERE id = 'g3'");
    $pdo->exec("UPDATE meta SET value = '10' WHERE key = 'schema_version'");
    $db->migrate();
    eq($db->getSchemaVersion(), 11, 'schema_version');
    eq($pdo->query("SELECT name FROM groups WHERE id = 'g3'")->fetchColumn(), 'Директор СЦ', 'g3 переименована');
    eq($pdo->query("SELECT COUNT(*) FROM groups WHERE name = 'В2С'")->fetchColumn() + 0, 0, 'старого имени не осталось');
    eq($pdo->query("SELECT id, name, sort_order FROM groups WHERE id != 'g3' ORDER BY id")->fetchAll(PDO::FETCH_ASSOC), $others, 'прочие группы не тронуты');
    eq(snapshotTables($pdo, ['audit_log', 'meta', 'groups']), $snapNoGroups, 'остальные таблицы побайтово равны');
    // повтор (версия снова 10) — no-op
    $pdo->exec("UPDATE meta SET value = '10' WHERE key = 'schema_version'");
    $db->migrate();
    eq($pdo->query("SELECT name FROM groups WHERE id = 'g3'")->fetchColumn(), 'Директор СЦ', 'повтор: имя то же');
    // чужое имя g3 (правка владельца) не перетирается, и «В2С» у другой группы — тоже
    $pdo->exec("UPDATE groups SET name = 'Мой отдел' WHERE id = 'g3'");
    $g4name = $pdo->query("SELECT name FROM groups WHERE id = 'g4'")->fetchColumn();
    $pdo->exec("UPDATE groups SET name = 'В2С' WHERE id = 'g4'");
    $pdo->exec("UPDATE meta SET value = '10' WHERE key = 'schema_version'");
    $db->migrate();
    eq($pdo->query("SELECT name FROM groups WHERE id = 'g3'")->fetchColumn(), 'Мой отдел', 'иное имя g3 не тронуто');
    eq($pdo->query("SELECT name FROM groups WHERE id = 'g4'")->fetchColumn(), 'В2С', 'другая группа не тронута');
    // вернуть как было
    $pdo->exec("UPDATE groups SET name = 'Директор СЦ' WHERE id = 'g3'");
    $pdo->prepare("UPDATE groups SET name = :n WHERE id = 'g4'")->execute([':n' => $g4name]);
    eq($pdo->query('PRAGMA integrity_check')->fetchColumn(), 'ok', 'integrity_check');
    eq($pdo->query('PRAGMA foreign_key_check')->fetchAll(), [], 'foreign_key_check пуст');
    return 'g3 renamed, повтор/чужое имя — no-op';
});

// --- Миграция v9 → v10 (T1-7, D-1) -----------------------------------------
$run('M5 миграция v9→v10: task_assignees без FK на employees + full_name_snapshot; данные на месте; повтор идемпотентен', function () use ($db, $pdo) {
    foreach ([['tt_m1', 'Миграц Первый'], ['tt_m2', 'Миграц Второй']] as [$i, $n]) {
        $pdo->prepare('INSERT INTO employees (id, full_name, location, sort_order) VALUES (:i, :n, \'QA\', 0)')->execute([':i' => $i, ':n' => $n]);
    }
    $pdo->exec("INSERT INTO tasks (id, title, start_at, end_at) VALUES ('tt_m_t1', 'mig1', '2030-02-01', '2030-02-02')");
    $pdo->exec("INSERT INTO tasks (id, title, start_at) VALUES ('tt_m_t2', 'mig2', '2030-02-05')");
    // Состояние v9: таблица с FK на employees (CASCADE), без full_name_snapshot.
    $pdo->exec('DROP TABLE task_assignees');
    $pdo->exec("CREATE TABLE task_assignees (
        task_id TEXT NOT NULL, employee_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('assignee','watcher')),
        PRIMARY KEY (task_id, employee_id, role),
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE)");
    $pdo->exec('CREATE INDEX idx_task_assignees_emp ON task_assignees (employee_id)');
    $pdo->exec("INSERT INTO task_assignees (task_id, employee_id, role) VALUES
        ('tt_m_t1', 'tt_m1', 'assignee'), ('tt_m_t1', 'tt_m2', 'watcher'), ('tt_m_t2', 'tt_m2', 'assignee')");
    $before = $pdo->query('SELECT task_id, employee_id, role FROM task_assignees ORDER BY task_id, employee_id, role')->fetchAll(PDO::FETCH_ASSOC);
    $fkBefore = (int) $pdo->query('PRAGMA foreign_keys')->fetchColumn();
    $pdo->exec("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
    $db->migrate();
    eq($db->getSchemaVersion(), 11, 'schema_version');
    eq(tcols($pdo, 'task_assignees'), ['task_id', 'employee_id', 'role', 'full_name_snapshot'], 'cols');
    $fks = $pdo->query('PRAGMA foreign_key_list(task_assignees)')->fetchAll(PDO::FETCH_ASSOC);
    eq(array_map(fn($f) => [$f['table'], $f['on_delete']], $fks), [['tasks', 'CASCADE']], 'FK только на tasks');
    $after = $pdo->query('SELECT task_id, employee_id, role FROM task_assignees ORDER BY task_id, employee_id, role')->fetchAll(PDO::FETCH_ASSOC);
    eq($after, $before, 'строки назначений сохранены');
    $snap = $pdo->query("SELECT employee_id, full_name_snapshot FROM task_assignees WHERE task_id = 'tt_m_t1' ORDER BY employee_id")->fetchAll(PDO::FETCH_KEY_PAIR);
    eq($snap, ['tt_m1' => 'Миграц Первый', 'tt_m2' => 'Миграц Второй'], 'snapshot заполнен из employees');
    $idx = $pdo->query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_assignees' AND name='idx_task_assignees_emp'")->fetchColumn();
    eq($idx, 'idx_task_assignees_emp', 'индекс по employee_id');
    eq((int) $pdo->query('PRAGMA foreign_keys')->fetchColumn(), $fkBefore, 'PRAGMA foreign_keys возвращён');
    eq($pdo->query('PRAGMA foreign_key_check')->fetchAll(), [], 'foreign_key_check пуст');
    // Повторный запуск (версия снова 9) — таблица уже v10, ничего не меняется.
    $pdo->exec("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
    $db->migrate();
    eq($db->getSchemaVersion(), 11, 'schema_version после повтора');
    $again = $pdo->query('SELECT task_id, employee_id, role, full_name_snapshot FROM task_assignees ORDER BY task_id, employee_id, role')->fetchAll(PDO::FETCH_ASSOC);
    eq(count($again), 3, 'число строк после повтора');
    eq($again[0]['full_name_snapshot'], 'Миграц Первый', 'snapshot после повтора');
    // Удаление сотрудника больше не стирает назначение.
    $pdo->exec("DELETE FROM employees WHERE id = 'tt_m1'");
    eq((int) $pdo->query("SELECT COUNT(*) FROM task_assignees WHERE employee_id = 'tt_m1'")->fetchColumn(), 1, 'назначение пережило удаление сотрудника');
    // Каскад по tasks сохранён.
    $pdo->exec("DELETE FROM tasks WHERE id IN ('tt_m_t1', 'tt_m_t2')");
    eq((int) $pdo->query("SELECT COUNT(*) FROM task_assignees WHERE task_id IN ('tt_m_t1', 'tt_m_t2')")->fetchColumn(), 0, 'CASCADE по tasks');
    $pdo->exec("DELETE FROM employees WHERE id = 'tt_m2'");
    return '3 назначения, snapshot, FK только на tasks, повтор — no-op';
});

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
    $body = $over + ['title' => 'T-' . bin2hex(random_bytes(3)), 'start_at' => '2027-04-05', 'end_at' => isset($over['start_at']) ? null : '2027-04-07', 'assignees' => ['tt_a']];
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

    // =====================================================================
    // T1-7 (D-1): исполнитель переживает удаление сотрудника
    // =====================================================================
    $ctx = new stdClass();
    $mkEmp = function (string $id, string $name) use ($pdo, $PHONE, $PHOTO): void {
        $pdo->prepare('INSERT OR REPLACE INTO employees (id, full_name, location, phone, photo_url, sort_order) VALUES (:i, :n, \'QA\', :p, :ph, 0)')
            ->execute([':i' => $id, ':n' => $name, ':p' => $PHONE, ':ph' => $PHOTO]);
    };
    $delHttp = fn(string $id): array => req('DELETE', $base . '/api/employees.php?id=' . rawurlencode($id), ['cookie' => $cookies['admin'], 'body' => ['confirm' => true]]);
    // Полное состояние для sync-save: все сотрудники из БД (значения не меняются), опционально без $drop и с переименованием.
    $syncSave = function (?string $drop = null, array $rename = []) use ($pdo, $base, $cookies): array {
        $list = [];
        foreach ($pdo->query('SELECT * FROM employees ORDER BY sort_order, id')->fetchAll(PDO::FETCH_ASSOC) as $e) {
            if ($e['id'] === $drop) {
                continue;
            }
            $list[] = [
                'id' => $e['id'], 'fullName' => $rename[$e['id']] ?? $e['full_name'], 'position_id' => $e['position_id'],
                'location' => $e['location'], 'group_id' => $e['group_id'], 'phone' => $e['phone'], 'photo_url' => $e['photo_url'],
                'is_technical' => (int) $e['is_technical'], 'requires_full_profile' => (int) $e['requires_full_profile'],
                'sort_order' => $e['sort_order'], 'created_at' => $e['created_at'],
            ];
        }
        return req('POST', $base . '/api/save.php', ['cookie' => $cookies['admin'], 'body' => ['employees' => $list]]);
    };
    $snapOf = fn(string $taskId, string $emp, string $role = 'assignee') => $pdo->query(
        "SELECT full_name_snapshot FROM task_assignees WHERE task_id = '$taskId' AND employee_id = '$emp' AND role = '$role'")->fetchColumn();
    $lastDelete = function (string $emp) use ($pdo): ?array {
        $d = $pdo->query("SELECT ts, details FROM audit_log WHERE action = 'employee.delete' AND entity_id = '$emp' ORDER BY id DESC LIMIT 1")->fetch(PDO::FETCH_ASSOC);
        return $d ? ['ts' => $d['ts'], 'details' => json_decode((string) $d['details'], true)] : null;
    };

    $run('D1 snapshot пишется при POST/PUT назначения; форма assignees[] = {employee_id, full_name, removed:false, removed_at:null}', function () use ($mkEmp, $mk, $A, $snapOf) {
        $mkEmp('tt_s1', 'Снимок Первый');
        $mkEmp('tt_s2', 'Снимок Второй');
        $t = $mk(['title' => 'D1', 'assignees' => ['tt_s1'], 'watchers' => ['tt_s2'], 'start_at' => '2029-02-05']);
        eq($t['assignees'], [['employee_id' => 'tt_s1', 'full_name' => 'Снимок Первый', 'removed' => false, 'removed_at' => null]], 'assignees');
        eq($t['watchers'][0]['removed'], false, 'watcher removed');
        eq($t['orphan'], false, 'orphan');
        eq($snapOf($t['id'], 'tt_s1'), 'Снимок Первый', 'snapshot assignee (POST)');
        eq($snapOf($t['id'], 'tt_s2', 'watcher'), 'Снимок Второй', 'snapshot watcher (POST)');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => $t['version'], 'assignees' => ['tt_s2']]);
        eq($r['status'], 200, 'PUT');
        eq($snapOf($t['id'], 'tt_s2'), 'Снимок Второй', 'snapshot после переназначения (PUT)');
        eq($r['json']['task']['assignees'][0]['full_name'], 'Снимок Второй', 'full_name');
        return 'POST+PUT пишут snapshot';
    });

    $run('D2 DELETE employees.php: задача жива, orphan:true, removed:true, ФИО из snapshot, removed_at; audit open_tasks только открытые неархивные', function () use ($mkEmp, $mk, $A, $delHttp, $pdo, $lastDelete, $ctx) {
        $mkEmp('tt_x1', 'Икс Первый');
        $open = $mk(['title' => 'D2 open', 'assignees' => ['tt_x1'], 'start_at' => '2029-03-05', 'end_at' => '2029-03-06']);
        $closed = $mk(['title' => 'D2 closed', 'assignees' => ['tt_x1'], 'start_at' => '2029-03-05']);
        $arch = $mk(['title' => 'D2 archived', 'assignees' => ['tt_x1'], 'start_at' => '2029-03-05']);
        eq($A('POST', '?id=' . $closed['id'] . '&action=close', [])['status'], 200, 'close');
        eq($A('DELETE', '?id=' . $arch['id'])['status'], 200, 'archive');
        eq($delHttp('tt_x1')['status'], 200, 'DELETE employee');
        eq((int) $pdo->query("SELECT COUNT(*) FROM employees WHERE id = 'tt_x1'")->fetchColumn(), 0, 'сотрудник удалён');
        $t = $A('GET', '?id=' . $open['id'])['json']['task'];
        eq([$t['status'], $t['archived'], $t['orphan']], ['open', 0, true], 'жива и orphan');
        eq(count($t['assignees']), 1, 'исполнитель остался в ответе');
        eq([$t['assignees'][0]['employee_id'], $t['assignees'][0]['full_name'], $t['assignees'][0]['removed']], ['tt_x1', 'Икс Первый', true], 'removed + snapshot');
        $del = $lastDelete('tt_x1');
        ok($del !== null && $del['ts'] !== null, 'есть audit employee.delete');
        eq($t['assignees'][0]['removed_at'], $del['ts'], 'removed_at = ts audit');
        eq($t['conflict'], false, 'conflict у orphan');
        eq($del['details']['open_tasks'], [$open['id']], 'audit open_tasks: только открытая неархивная');
        eq($del['details']['fullName'], 'Икс Первый', 'audit fullName');
        // Список: те же поля.
        $list = $A('GET', '?from=2029-03-01&to=2029-03-31')['json']['tasks'];
        $in = array_values(array_filter($list, fn($x) => $x['id'] === $open['id']));
        eq([$in[0]['orphan'], $in[0]['assignees'][0]['removed']], [true, true], 'list: orphan/removed');
        $ctx->orphOpen = $open['id'];
        $ctx->orphClosed = $closed['id'];
        $ctx->orphArch = $arch['id'];
        return 'orphan, removed_at=' . $del['ts'];
    });

    $run('D3 sync-delete (save.php): 2 исполнителя → orphan:false; затем второй удалён → orphan:true; audit open_tasks в sync-пути', function () use ($mkEmp, $mk, $A, $syncSave, $pdo, $lastDelete) {
        $mkEmp('tt_x2', 'Икс Второй');
        $mkEmp('tt_x3', 'Икс Третий');
        $t = $mk(['title' => 'D3', 'assignees' => ['tt_x2', 'tt_x3'], 'start_at' => '2029-03-12']);
        $r = $syncSave('tt_x2');
        eq($r['status'], 200, 'sync status ' . substr($r['raw'], 0, 150));
        eq((int) $pdo->query("SELECT COUNT(*) FROM employees WHERE id = 'tt_x2'")->fetchColumn(), 0, 'tt_x2 удалён sync-ом');
        $c = $A('GET', '?id=' . $t['id'])['json']['task'];
        eq($c['orphan'], false, 'есть действующий исполнитель → orphan:false');
        $by = [];
        foreach ($c['assignees'] as $a) { $by[$a['employee_id']] = $a; }
        eq([$by['tt_x2']['removed'], $by['tt_x2']['full_name']], [true, 'Икс Второй'], 'удалённый: snapshot');
        eq([$by['tt_x3']['removed'], $by['tt_x3']['full_name'], $by['tt_x3']['removed_at']], [false, 'Икс Третий', null], 'действующий');
        eq($c['assignees'][0]['employee_id'], 'tt_x3', 'действующие идут первыми');
        $d = $lastDelete('tt_x2');
        eq($d['details']['open_tasks'], [$t['id']], 'audit open_tasks (save.php)');
        eq($by['tt_x2']['removed_at'], $d['ts'], 'removed_at');
        eq($syncSave('tt_x3')['status'], 200, 'sync 2');
        $c = $A('GET', '?id=' . $t['id'])['json']['task'];
        eq([$c['orphan'], count($c['assignees']), $c['assignees'][0]['removed'], $c['assignees'][1]['removed']], [true, 2, true, true], 'оба удалены → orphan:true');
        return 'orphan false → true';
    });

    $run('D4 переименование обновляет snapshot (employees.php PUT и sync save.php); удалённый показывается по новому ФИО', function () use ($mkEmp, $mk, $A, $syncSave, $delHttp, $snapOf, $base, $cookies) {
        $mkEmp('tt_x4', 'Икс Старый Четвёртый');
        $mkEmp('tt_x5', 'Икс Старый Пятый');
        $t = $mk(['title' => 'D4', 'assignees' => ['tt_x4', 'tt_x5'], 'start_at' => '2029-03-19']);
        $r = req('PUT', $base . '/api/employees.php?id=tt_x4', ['cookie' => $cookies['admin'], 'body' => ['fullName' => 'Икс Новый Четвёртый']]);
        eq($r['status'], 200, 'PUT employee');
        eq($snapOf($t['id'], 'tt_x4'), 'Икс Новый Четвёртый', 'snapshot (employees.php)');
        eq($syncSave(null, ['tt_x5' => 'Икс Новый Пятый'])['status'], 200, 'sync rename');
        eq($snapOf($t['id'], 'tt_x5'), 'Икс Новый Пятый', 'snapshot (save.php)');
        eq($delHttp('tt_x4')['status'], 200, 'delete 4');
        eq($delHttp('tt_x5')['status'], 200, 'delete 5');
        $c = $A('GET', '?id=' . $t['id'])['json']['task'];
        $names = array_column($c['assignees'], 'full_name');
        sort($names);
        eq($names, ['Икс Новый Пятый', 'Икс Новый Четвёртый'], 'ФИО из обновлённых snapshot');
        return 'snapshot обновляется в обоих путях';
    });

    $run('D5 GET ?orphans=1: открытые неархивные orphan, без фильтра периода; закрытые/архивные/с исполнителем — нет', function () use ($A, $mk, $ctx) {
        $live = $mk(['title' => 'D5 live', 'assignees' => ['tt_a'], 'start_at' => '2029-03-05']);
        $r = $A('GET', '?orphans=1');
        eq($r['status'], 200, 'status');
        $ids = array_column($r['json']['tasks'], 'id');
        ok(in_array($ctx->orphOpen, $ids, true), 'открытая orphan есть');
        ok(!in_array($ctx->orphClosed, $ids, true), 'закрытая не в списке');
        ok(!in_array($ctx->orphArch, $ids, true), 'архивная не в списке');
        ok(!in_array($live['id'], $ids, true), 'задача с исполнителем не в списке');
        foreach ($r['json']['tasks'] as $t) {
            eq([$t['orphan'], $t['status'], $t['archived']], [true, 'open', 0], 'каждая: orphan/open/неархивная');
        }
        eq($r['json']['count'], count($r['json']['tasks']), 'count');
        // Период не фильтрует: from/to вне срока задачи на выдачу не влияют.
        $r2 = $A('GET', '?orphans=1&from=2035-01-01&to=2035-01-02');
        ok(in_array($ctx->orphOpen, array_column($r2['json']['tasks'], 'id'), true), 'период игнорируется');
        // Обычный список не затронут: без ?orphans — по-прежнему период и все задачи.
        $all = $A('GET', '?from=2029-03-01&to=2029-03-31');
        ok(in_array($live['id'], array_column($all['json']['tasks'], 'id'), true), 'обычный список работает');
        return count($ids) . ' orphan-задач';
    });

    $run('D6 GET ?open_for=<id>: {count, tasks:[{id,title,start_at,end_at,version}]} — открытые неархивные, действующий исполнитель (не наблюдатель, не удалённый)', function () use ($A, $mk, $mkEmp) {
        $mkEmp('tt_o6', 'Открытый Шестой');
        $o1 = $mk(['title' => 'D6 a', 'assignees' => ['tt_o6'], 'start_at' => '2029-04-02', 'end_at' => '2029-04-03']);
        $o2 = $mk(['title' => 'D6 b', 'assignees' => ['tt_o6', 'tt_c'], 'start_at' => '2029-04-01']);
        $watch = $mk(['title' => 'D6 w', 'assignees' => ['tt_c'], 'watchers' => ['tt_o6'], 'start_at' => '2029-04-04']);
        $cl = $mk(['title' => 'D6 closed', 'assignees' => ['tt_o6'], 'start_at' => '2029-04-05']);
        $A('POST', '?id=' . $cl['id'] . '&action=close', []);
        $ar = $mk(['title' => 'D6 arch', 'assignees' => ['tt_o6'], 'start_at' => '2029-04-06']);
        $A('DELETE', '?id=' . $ar['id']);
        $r = $A('GET', '?open_for=tt_o6');
        eq($r['status'], 200, 'status');
        eq($r['json']['count'], 2, 'count');
        eq(array_column($r['json']['tasks'], 'id'), [$o2['id'], $o1['id']], 'порядок по start_at');
        eq(array_keys($r['json']['tasks'][0]), ['id', 'title', 'start_at', 'end_at', 'version'], 'ключи');
        eq($r['json']['tasks'][1], ['id' => $o1['id'], 'title' => 'D6 a', 'start_at' => '2029-04-02', 'end_at' => '2029-04-03', 'version' => 1], 'элемент');
        $none = $A('GET', '?open_for=tt_x1');   // удалён — действующим исполнителем не является
        eq([$none['status'], $none['json']['count'], $none['json']['tasks']], [200, 0, []], 'удалённый сотрудник → 0');
        $unk = $A('GET', '?open_for=no_such');
        eq([$unk['status'], $unk['json']['count']], [200, 0], 'неизвестный id → 0');
        return 'count=2, порядок/ключи';
    });

    $run('D7 RBAC новых GET: anon 401, supervisor/viewer 200; запись по-прежнему только admin', function () use ($N, $S, $V, $ctx) {
        foreach (['?orphans=1', '?open_for=tt_a'] as $q) {
            eq($N('GET', $q)['status'], 401, "anon $q");
            foreach ([['sup', $S], ['viewer', $V]] as [$who, $fn]) {
                $r = $fn('GET', $q);
                eq($r['status'], 200, "$who $q");
                ok(is_array($r['json']['tasks'] ?? null) && isset($r['json']['count']), "$who $q shape");
            }
        }
        $r = $V('PUT', '?id=' . $ctx->orphOpen, ['version' => 1, 'title' => 'hack']);
        eq($r['status'], 403, 'viewer PUT orphan');
        return '2 GET × 3 роли';
    });

    $run('D8 orphan-задача: close/reopen/archive → 200; PUT текста/приоритета/срока → 200 (удалённый исполнитель остаётся); PUT watchers → 200 со snapshot', function () use ($mkEmp, $mk, $A, $delHttp, $snapOf, $pdo) {
        $mkEmp('tt_x8', 'Икс Восьмой');
        $w = $mk(['title' => 'D8 a', 'assignees' => ['tt_x8'], 'start_at' => '2029-05-07', 'end_at' => '2029-05-08']);
        $b = $mk(['title' => 'D8 b', 'assignees' => ['tt_x8'], 'start_at' => '2029-05-07']);
        $c = $mk(['title' => 'D8 c', 'assignees' => ['tt_x8'], 'start_at' => '2029-05-07']);
        eq($delHttp('tt_x8')['status'], 200, 'delete emp');
        // close / reopen
        $r = $A('POST', '?id=' . $w['id'] . '&action=close', ['version' => 1]);
        eq([$r['status'], $r['json']['task']['status'], $r['json']['task']['orphan']], [200, 'closed', true], 'close');
        $r = $A('POST', '?id=' . $w['id'] . '&action=reopen', ['version' => 2]);
        eq([$r['status'], $r['json']['task']['status']], [200, 'open'], 'reopen');
        // archive
        $r = $A('DELETE', '?id=' . $c['id']);
        eq([$r['status'], $r['json']['archived']], [200, true], 'archive');
        // PUT без assignees
        $r = $A('PUT', '?id=' . $b['id'], ['version' => 1, 'title' => 'D8 b — правка', 'priority' => 3, 'description' => 'текст']);
        eq($r['status'], 200, 'PUT текст ' . $r['raw']);
        $t = $r['json']['task'];
        eq([$t['title'], $t['priority'], $t['version'], $t['orphan'], $t['assignees'][0]['removed'], $t['assignees'][0]['full_name']], ['D8 b — правка', 3, 2, true, true, 'Икс Восьмой'], 'удалённый остаётся');
        // PUT срока (FR-10 без действующих исполнителей → ok)
        $r = $A('PUT', '?id=' . $b['id'], ['version' => 2, 'start_at' => '2029-05-14', 'end_at' => '2029-05-15']);
        eq([$r['status'], $r['json']['task']['start_at'], $r['json']['task']['check_state']], [200, '2029-05-14', 'ok'], 'PUT срок');
        // тот же набор исполнителей в теле — это не переназначение
        $r = $A('PUT', '?id=' . $b['id'], ['version' => 3, 'assignees' => ['tt_x8'], 'title' => 'D8 b — правка']);
        eq([$r['status'], $r['json']['unchanged'] ?? null], [200, true], 'тот же набор → unchanged');
        // watchers: удалённый исполнитель переписывается вместе со snapshot
        $r = $A('PUT', '?id=' . $b['id'], ['version' => 3, 'watchers' => ['tt_b']]);
        eq($r['status'], 200, 'PUT watchers');
        eq($snapOf($b['id'], 'tt_x8'), 'Икс Восьмой', 'snapshot удалённого сохранён при перезаписи');
        eq($r['json']['task']['assignees'][0]['full_name'], 'Икс Восьмой', 'full_name');
        // пустой список — по-прежнему ошибка
        $r = $A('PUT', '?id=' . $b['id'], ['version' => 4, 'assignees' => []]);
        eq([$r['status'], $r['json']['error']], [400, 'assignees_required'], 'пустые исполнители');
        return 'close/reopen/archive/PUT 200';
    });

    $run('D9 переназначение: PUT assignees с удалённым id → 400 employee_not_found; замена удалённого на нового → 200, orphan:false, snapshot, audit task.update', function () use ($mkEmp, $mk, $A, $delHttp, $snapOf, $pdo) {
        $mkEmp('tt_x9', 'Икс Девятый');
        $t = $mk(['title' => 'D9', 'assignees' => ['tt_x9'], 'start_at' => '2029-06-04']);
        $delHttp('tt_x9');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => 1, 'assignees' => ['tt_x9', 'tt_b']]);
        eq([$r['status'], $r['json']['error'], $r['json']['employee_id']], [400, 'employee_not_found', 'tt_x9'], 'удалённый id');
        $c = $A('GET', '?id=' . $t['id'])['json']['task'];
        eq([$c['version'], $c['orphan']], [1, true], 'задача не изменилась');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => 1, 'assignees' => ['tt_c']]);
        eq($r['status'], 200, 'замена ' . $r['raw']);
        $n = $r['json']['task'];
        eq([$n['orphan'], count($n['assignees']), $n['assignees'][0]['employee_id'], $n['assignees'][0]['removed'], $n['assignees'][0]['full_name'], $n['version']],
            [false, 1, 'tt_c', false, 'Тестов Чарли', 2], 'после замены');
        eq($snapOf($t['id'], 'tt_c'), 'Тестов Чарли', 'snapshot нового');
        eq((int) $pdo->query("SELECT COUNT(*) FROM task_assignees WHERE task_id = '{$t['id']}' AND employee_id = 'tt_x9'")->fetchColumn(), 0, 'удалённый исполнитель заменён');
        $a = $pdo->query("SELECT details FROM audit_log WHERE action = 'task.update' AND entity_id = '{$t['id']}' ORDER BY id DESC LIMIT 1")->fetchColumn();
        $d = json_decode((string) $a, true);
        eq([$d['assignees_before'], $d['assignees_after']], [['tt_x9'], ['tt_c']], 'audit task.update');
        // Больше не orphan: в ?orphans=1 её нет.
        ok(!in_array($t['id'], array_column($A('GET', '?orphans=1')['json']['tasks'], 'id'), true), 'вышла из ?orphans=1');
        return 'tt_x9 → tt_c';
    });

    $run('D10 переназначение на сотрудника с больничным → 422 + suggested_start; удалённый исполнитель в blocked_days не участвует', function () use ($mkEmp, $mk, $A, $delHttp, $addEntry) {
        $mkEmp('tt_x10', 'Икс Десятый');
        $addEntry('tt_b', '2029-07-10', 'sick');
        $t = $mk(['title' => 'D10', 'assignees' => ['tt_x10'], 'start_at' => '2029-07-10', 'end_at' => '2029-07-11']);
        $delHttp('tt_x10');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => 1, 'assignees' => ['tt_b']]);
        eq($r['status'], 422, 'status');
        eq($r['json']['error'], 'TASK_BLOCKED_BY_SICK_OR_TRIP', 'error');
        eq(array_unique(array_column($r['json']['blocked_days'], 'employee_id')), ['tt_b'], 'только tt_b');
        eq($r['json']['suggested_start'], '2029-07-11', 'suggested_start');
        $c = $A('GET', '?id=' . $t['id'])['json']['task'];
        eq([$c['version'], $c['orphan']], [1, true], 'не записано');
        // Смешанный случай: [удалённый, действующий] — период на больничный действующего → блок только по нему.
        $mkEmp('tt_x11', 'Икс Одиннадцатый');
        $t2 = $mk(['title' => 'D10b', 'assignees' => ['tt_x11', 'tt_c'], 'start_at' => '2029-07-20']);
        $delHttp('tt_x11');
        $addEntry('tt_c', '2029-07-24', 'sick');
        $r = $A('PUT', '?id=' . $t2['id'], ['version' => 1, 'start_at' => '2029-07-24']);
        eq($r['status'], 422, 'смешанный: status');
        eq(array_unique(array_column($r['json']['blocked_days'], 'employee_id')), ['tt_c'], 'смешанный: только действующий');
        // Задача [удалённый, действующий] с больничным у действующего на сроке: conflict считается только по нему.
        $c2 = $A('GET', '?id=' . $t2['id'])['json']['task'];
        eq([$c2['orphan'], $c2['conflict']], [false, false], 'смешанный: orphan:false, conflict:false (период до больничного)');
        return '422 + suggested_start=2029-07-11';
    });

    $run('D11 import.php с тем же id: назначение восстанавливается (orphan:false, ФИО из employees); задачи не теряются при полной очистке', function () use ($mkEmp, $mk, $A, $delHttp, $pdo, $base, $cookies, $snapOf) {
        $mkEmp('tt_x12', 'Икс Двенадцатый');
        $mkEmp('tt_x13', 'Икс Тринадцатый');
        $t = $mk(['title' => 'D11', 'assignees' => ['tt_x12'], 'start_at' => '2029-08-06']);
        $t13 = $mk(['title' => 'D11b', 'assignees' => ['tt_x13'], 'start_at' => '2029-08-06']);
        $delHttp('tt_x12');
        eq($A('GET', '?id=' . $t['id'])['json']['task']['orphan'], true, 'до импорта orphan');
        $payload = [
            'groups' => $pdo->query('SELECT id, name, sort_order FROM groups')->fetchAll(PDO::FETCH_ASSOC),
            'positions' => $pdo->query('SELECT id, name, sort_order FROM positions')->fetchAll(PDO::FETCH_ASSOC),
            'holidays' => $pdo->query('SELECT date, type, label FROM holidays')->fetchAll(PDO::FETCH_ASSOC),
            'employees' => [],
        ];
        foreach ($pdo->query("SELECT * FROM employees WHERE id != 'tt_x13' ORDER BY sort_order, id")->fetchAll(PDO::FETCH_ASSOC) as $e) {
            $payload['employees'][] = ['id' => $e['id'], 'fullName' => $e['full_name'], 'positionId' => $e['position_id'], 'location' => $e['location'],
                'groupId' => $e['group_id'], 'phone' => $e['phone'], 'photoUrl' => $e['photo_url'], 'sortOrder' => $e['sort_order']];
        }
        // tt_x12 возвращается с тем же id и новым ФИО; tt_x13 в импорте нет.
        $payload['employees'][] = ['id' => 'tt_x12', 'fullName' => 'Икс Двенадцатый Вернулся', 'location' => 'QA', 'sortOrder' => 0];
        $r = req('POST', $base . '/api/import.php', ['cookie' => $cookies['admin'], 'body' => $payload]);
        eq($r['status'], 200, 'import ' . substr($r['raw'], 0, 200));
        $c = $A('GET', '?id=' . $t['id'])['json']['task'];
        eq([$c['orphan'], $c['assignees'][0]['removed'], $c['assignees'][0]['full_name'], $c['assignees'][0]['removed_at']], [false, false, 'Икс Двенадцатый Вернулся', null], 'восстановлено');
        eq($snapOf($t['id'], 'tt_x12'), 'Икс Двенадцатый Вернулся', 'snapshot освежён импортом');
        $c13 = $A('GET', '?id=' . $t13['id'])['json']['task'];
        eq([$c13['orphan'], $c13['assignees'][0]['removed'], $c13['assignees'][0]['full_name']], [true, true, 'Икс Тринадцатый'], 'не вернувшийся — «удалён», задача цела');
        return 'import вернул tt_x12; tt_x13 — orphan';
    });

    $run('D12 приватность: ответы с удалёнными исполнителями без phone/photo; в ?orphans=1 и ?open_for нет персональных данных', function () use ($A, $PHONE, $PHOTO) {
        $raws = [$A('GET', '?orphans=1')['raw'], $A('GET', '?open_for=tt_a')['raw'], $A('GET', '?from=2029-01-01&to=2029-12-31')['raw']];
        foreach ($raws as $i => $raw) {
            ok(strlen($raw) > 30, "ответ $i непустой");
            foreach (['phone', 'photo', $PHONE, $PHOTO, 'tt_photo_secret'] as $needle) {
                ok(stripos($raw, (string) $needle) === false, "ответ $i содержит '$needle'");
            }
        }
        return count($raws) . ' ответов чисты';
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
