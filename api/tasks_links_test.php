<?php

declare(strict_types=1);

// Служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * tasks_links_test.php — тесты связанных задач (V9-T1): схема v14 (tasks.links_text, task_links),
 * разбор токенов ((ID|название)), запись/чтение связей в api/tasks.php, ?pick=1, ?related=<id>,
 * права, симметрия, архив, лимиты, VERSION_CONFLICT, неизменность close/reopen/DELETE.
 *
 * Usage:  php api/tasks_links_test.php        (сьют `tasklinks` в scripts/verify_all.sh)
 *
 * Изолированный прогон (как api/tasks_test.php): data/app.db копируется во временный файл, весь тест
 * (CLI-часть и временный `php -S`) работает через env SC_APP_DB на этой копии — data/app.db не изменяется
 * (sha1 до/после). Вывод: «=== RESULTS: N passed, M failed ... ===» и «DB intact: YES».
 */

$root = realpath(__DIR__ . '/..');
if ($root === false) {
    fwrite(STDERR, "Cannot resolve project root\n");
    exit(1);
}
$realDb = $root . '/data/app.db';
$realDbHashBefore = is_file($realDb) ? sha1_file($realDb) : '';

$tmpDir = sys_get_temp_dir();
$tmpDb = tempnam($tmpDir, 'sc_tlinks_db_');
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
// До реализации файла нет — тесты упадут по существу (красный прогон), а не фатальной ошибкой.
if (is_file(__DIR__ . '/tasks_links.php')) {
    require_once __DIR__ . '/tasks_links.php';
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
        $snap[$t] = [count($rows), md5(json_encode($rows))];
    }
    return $snap;
}

/** Каноническая пара (task_a < task_b, побайтово — как BINARY-сравнение SQLite). */
function canon(string $x, string $y): array
{
    return strcmp($x, $y) < 0 ? [$x, $y] : [$y, $x];
}

// ----------------------------------------------------------------------------
// CLI-часть: миграция и парсер
// ----------------------------------------------------------------------------
$db = Database::getInstance();
$pdo = $db->getPDO();
$pdo->exec('PRAGMA busy_timeout = 5000');
$verBefore = $db->getSchemaVersion();

out('=== TASKLINKS TEST START ===');

$run('M1 миграция копии dev-БД (v6) → v15 (v14 — связи, v15 — транспорт): tasks.links_text (последняя колонка), task_links, индекс, CHECK пары; повтор — no-op', function () use ($db, $pdo, $verBefore) {
    ok($verBefore < 9, 'ожидалась исходная схема < 9, а не ' . $verBefore);
    $db->migrate();
    eq($db->getSchemaVersion(), 15, 'schema_version');
    $cols = tcols($pdo, 'tasks');
    eq($cols, ['id', 'title', 'description', 'start_at', 'end_at', 'priority', 'label', 'status',
        'check_state', 'version', 'created_by', 'created_at', 'updated_at', 'closed_at', 'archived', 'links_text'], 'tasks cols');
    eq(tcols($pdo, 'task_links'), ['task_a', 'task_b', 'created_at', 'created_by'], 'task_links cols');
    $idx = $pdo->query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_links' AND name LIKE 'idx_%'")
        ->fetchAll(PDO::FETCH_COLUMN);
    ok(in_array('idx_task_links_b', $idx, true), 'нет индекса idx_task_links_b по task_b');
    // CHECK (task_a < task_b), PK, FK CASCADE.
    $pdo->exec("INSERT INTO tasks (id, title, start_at) VALUES ('ml_a', 'a', '2030-01-01'), ('ml_b', 'b', '2030-01-02')");
    $pdo->exec("INSERT INTO task_links (task_a, task_b) VALUES ('ml_a', 'ml_b')");
    foreach ([
        "INSERT INTO task_links (task_a, task_b) VALUES ('ml_b', 'ml_a')",   // обратная пара нарушает CHECK
        "INSERT INTO task_links (task_a, task_b) VALUES ('ml_a', 'ml_a')",   // самосвязь
        "INSERT INTO task_links (task_a, task_b) VALUES ('ml_a', 'ml_b')",   // дубль PK
        "INSERT INTO task_links (task_a, task_b) VALUES ('ml_a', 'нет_такой')", // FK
    ] as $bad) {
        $threw = false;
        try { $pdo->exec($bad); } catch (Throwable $e) { $threw = true; }
        ok($threw, 'ограничение не сработало: ' . $bad);
    }
    $pdo->exec("DELETE FROM tasks WHERE id = 'ml_a'");
    eq((int) $pdo->query('SELECT COUNT(*) FROM task_links')->fetchColumn(), 0, 'CASCADE по tasks');
    $pdo->exec("DELETE FROM tasks WHERE id = 'ml_b'");
    $snap = snapshotTables($pdo, ['audit_log', 'meta']);
    $db->migrate();
    eq(snapshotTables($pdo, ['audit_log', 'meta']), $snap, 'повторный migrate не меняет данные');
    eq($pdo->query('PRAGMA integrity_check')->fetchColumn(), 'ok', 'integrity_check');
    return 'v' . $verBefore . '→v15';
});

$run('M2 миграция v13 → v14 на копии: колонка и таблица добавлены, данные задач/людей/вложений прежние, повтор и «ложная 13» безопасны', function () use ($tmpDir) {
    // ВАЖНО: основную копию ($tmpDb) здесь не копируем и не открываем второй раз — закрытие любого дескриптора
    // файла в процессе снимает POSIX-блокировки открытого WAL-соединения, и php -S потом «ломает» WAL (split-brain).
    // Берём свежую копию data/app.db (v6) и поднимаем её до v14 отдельным процессом, затем откатываем до состояния v13.
    $v13 = tempnam($tmpDir, 'sc_tlinks_v13_');
    ok($v13 !== false && copy((string) $GLOBALS['realDb'], $v13), 'копия');
    // Миграция — в ОТДЕЛЬНОМ процессе (как на проде: новый процесс php открывает БД и вызывает migrate()).
    $script = tempnam($tmpDir, 'sc_tlinks_mig_');
    file_put_contents($script, '<?php require ' . var_export(__DIR__ . '/db.php', true) . ';'
        . '$d = Database::getInstance(); $mode = $argv[1] ?? "";'
        . 'if ($mode === "again13") { $d->getPDO()->exec("UPDATE meta SET value = \'13\' WHERE key = \'schema_version\'"); }'
        . 'echo $d->getSchemaVersion(), ">"; $d->migrate(); echo $d->getSchemaVersion();');
    $migrate = function (string $mode) use ($script, $v13): string {
        return trim((string) shell_exec('SC_APP_DB=' . escapeshellarg($v13) . ' php ' . escapeshellarg($script) . ' ' . $mode . ' 2>/dev/null'));
    };
    eq($migrate('prep'), '6>15', 'подготовка: копия dev-БД v6 → v15');
    $p13 = new PDO('sqlite:' . $v13, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $p13->exec('PRAGMA journal_mode = DELETE');
    $p13->exec("INSERT INTO employees (id, full_name, location, sort_order) VALUES ('m2_e', 'Миграц Е', 'QA', 0)");
    $p13->exec("INSERT INTO tasks (id, title, start_at, end_at, description, version) VALUES ('m2_t1', 'Старая 1', '2030-03-01', '2030-03-02', 'Описание', 4)");
    $p13->exec("INSERT INTO tasks (id, title, start_at, archived) VALUES ('m2_t2', 'Старая 2 (архив)', '2030-03-05', 1)");
    $p13->exec("INSERT INTO task_assignees (task_id, employee_id, role, full_name_snapshot) VALUES ('m2_t1', 'm2_e', 'assignee', 'Миграц Е')");
    $p13->exec("INSERT INTO task_checklist (task_id, text, done, sort_order) VALUES ('m2_t1', 'шаг', 1, 0)");
    $p13->exec("INSERT INTO task_occurrences (task_id, start_at, end_at) VALUES ('m2_t1', '2030-03-10', '2030-03-11')");
    // Состояние v13: нет task_links и tasks.links_text; версия 13.
    $p13->exec('DROP INDEX IF EXISTS idx_task_links_b');
    $p13->exec('DROP TABLE task_links');
    $p13->exec('ALTER TABLE tasks DROP COLUMN links_text');
    $p13->exec("UPDATE meta SET value = '13' WHERE key = 'schema_version'");
    ok(!in_array('links_text', tcols($p13, 'tasks'), true), 'подготовка: links_text есть');
    $oldCols = 'id, title, description, start_at, end_at, priority, label, status, check_state, version, created_by, created_at, updated_at, closed_at, archived';
    $tasksBefore = $p13->query("SELECT $oldCols FROM tasks ORDER BY id")->fetchAll();
    $snapBefore = snapshotTables($p13, ['audit_log', 'meta', 'tasks']);
    unset($p13);

    try {
        eq($migrate('first'), '13>15', 'первая миграция 13→15 (v14 + v15) (вывод процесса)');
        $q = new PDO('sqlite:' . $v13, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        ok(in_array('links_text', tcols($q, 'tasks'), true), 'links_text добавлена');
        eq(tcols($q, 'task_links'), ['task_a', 'task_b', 'created_at', 'created_by'], 'task_links');
        eq($q->query("SELECT $oldCols FROM tasks ORDER BY id")->fetchAll(), $tasksBefore, 'прежние колонки задач не изменились');
        eq($q->query('SELECT links_text FROM tasks WHERE id = \'m2_t1\'')->fetchColumn(), null, 'links_text у старых задач NULL');
        eq(snapshotTables($q, ['audit_log', 'meta', 'tasks', 'task_links']), $snapBefore, 'прочие таблицы без изменений (кроме новой task_links)');
        eq($q->query("SELECT value FROM meta WHERE key = 'schema_version'")->fetchColumn(), '15', 'meta.schema_version');
        // Повтор на v14 — no-op; «ложная 13» при уже существующих колонке/таблице — без ошибок и потерь.
        $snapV14 = snapshotTables($q, ['audit_log', 'meta']);
        unset($q);
        eq($migrate('again'), '15>15', 'повтор на v15');
        eq($migrate('again13'), '13>15', 'повторное применение с версии 13 (колонка и таблица уже есть)');
        $q = new PDO('sqlite:' . $v13, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        eq(snapshotTables($q, ['audit_log', 'meta']), $snapV14, 'повторы ничего не ломают и не меняют');
        eq($q->query('PRAGMA integrity_check')->fetchColumn(), 'ok', 'integrity_check');
        eq($q->query('PRAGMA foreign_key_check')->fetchAll(), [], 'foreign_key_check');
        // v14-схема принимает связи, каскад по tasks работает на мигрированной копии.
        $q->exec('PRAGMA foreign_keys = ON');
        $q->exec("INSERT INTO task_links (task_a, task_b) VALUES ('m2_t1', 'm2_t2')");
        $q->exec("DELETE FROM tasks WHERE id = 'm2_t2'");
        eq((int) $q->query('SELECT COUNT(*) FROM task_links')->fetchColumn(), 0, 'CASCADE на мигрированной копии');
    } finally {
        unset($q);
        @unlink($script);
        @unlink($v13);
        @unlink($v13 . '-wal');
        @unlink($v13 . '-shm');
    }
    return 'v13→v14, данные равны, повтор — no-op';
});

$ids = static fn(array $tokens): array => array_column($tokens, 'id');
$parse = static function (?string $t): array {
    if (!function_exists('tasks_links_parse')) {
        throw new RuntimeException('tasks_links_parse() не реализована');
    }
    return tasks_links_parse($t);
};

$run('P1 парсер: одиночный токен ((ID|название)); окружающий текст не мешает; ID по реальному генератору id (task_<hex>.<цифры>)', function () use ($parse) {
    $genId = uniqid('task_', true);   // реальный формат: genId('task_') → uniqid($prefix, true)
    $t = $parse('см. ((' . $genId . '|Купить молоко)) и далее');
    eq($t, [['id' => $genId, 'title' => 'Купить молоко']], 'токен с реальным id');
    eq($parse('((tt_a-1|x))')[0]['id'], 'tt_a-1', 'дефис и подчёркивание в id');
    eq($parse('(( tk_1 | Пробелы вокруг ))'), [['id' => 'tk_1', 'title' => 'Пробелы вокруг']], 'пробелы вокруг id/названия');
    return $genId;
});

$run('P2 парсер: несколько токенов — порядок сохранён; дубли по id схлопываются (первое вхождение)', function () use ($parse, $ids) {
    eq($ids($parse('((a1|A)) текст ((b2|B))\n((c3))')), ['a1', 'b2', 'c3'], 'порядок');
    $t = $parse('((a1|Первое)) ((b2|B)) ((a1|Второе название))');
    eq($ids($t), ['a1', 'b2'], 'дубль схлопнут');
    eq($t[0]['title'], 'Первое', 'побеждает первое вхождение');
    return 'ok';
});

$run('P3 парсер: пустое (()) и «пустые» токены игнорируются; null/пустая строка → []', function () use ($parse) {
    foreach (['(())', '(( ))', '((|название))', '((  |x))', 'текст (()) ещё (( )) текст', '', null, '()', '((', '))((', '(( ))((a'] as $t) {
        eq($parse($t), [], 'вход ' . json_encode($t, JSON_UNESCAPED_UNICODE));
    }
    return '11 входов → []';
});

$run('P4 парсер: токен без названия ((ID)); название с мусором (| внутри, скобки) — разбор только по ID; перевод строки в названии → не токен', function () use ($parse) {
    eq($parse('((tk_1))'), [['id' => 'tk_1', 'title' => '']], 'без названия');
    eq($parse('((tk_1|))'), [['id' => 'tk_1', 'title' => '']], 'пустое название');
    eq($parse('((tk_1|a|b|c))')[0], ['id' => 'tk_1', 'title' => 'a|b|c'], 'название с |');
    eq($parse('((tk_1|a (b) c))')[0]['id'], 'tk_1', 'название со скобками — id цел');
    eq($parse('((tk_1|<b>\'"%;</b>))')[0]['id'], 'tk_1', 'название-мусор');
    eq($parse("((tk_1|строка1\nстрока2))"), [], 'перевод строки в названии — не токен');
    eq(array_column($parse('((tk_1|a)) ((tk_2|b))'), 'id'), ['tk_1', 'tk_2'], 'ленивое название: два токена в строке');
    return 'ok';
});

$run('P5 парсер: невалидный ID (пробелы, кириллица, спецсимволы, >64 символов) — не токен, обычный текст', function () use ($parse) {
    foreach (['((не валидный|x))', '((a b))', '((кириллица))', '((a;b))', '((a/b|x))', '((' . str_repeat('x', 65) . '))', "((a\nb))", '((<script>))'] as $t) {
        eq($parse($t), [], 'вход ' . json_encode($t, JSON_UNESCAPED_UNICODE));
    }
    eq(count($parse('((' . str_repeat('x', 64) . '))')), 1, '64 символа — допустимо');
    return '8 невалидных → [], 64 символа ок';
});

// Фикстуры: сотрудники.
foreach ([['tt_a', 'Тестов Альфа'], ['tt_b', 'Тестов Браво']] as [$eid, $nm]) {
    $pdo->prepare('INSERT INTO employees (id, full_name, location, sort_order) VALUES (:i, :n, \'QA\', 0)')->execute([':i' => $eid, ':n' => $nm]);
}

// ----------------------------------------------------------------------------
// HTTP-часть: временный php -S на копии БД
// ----------------------------------------------------------------------------
$host = '127.0.0.1';
$port = null;
for ($attempt = 0; $attempt < 10; $attempt++) {
    $cand = 19900 + random_int(0, 400);
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
$serverLog = tempnam($tmpDir, 'sc_tlinks_srv_');
$cookies = ['admin' => tempnam($tmpDir, 'sc_tl_a_'), 'sup' => tempnam($tmpDir, 'sc_tl_s_'), 'view' => tempnam($tmpDir, 'sc_tl_v_')];
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

/** Создать задачу через API (admin); $over — поля тела. */
$mk = function (array $over = []) use ($A): array {
    $body = $over + ['title' => 'L-' . bin2hex(random_bytes(3)), 'start_at' => '2031-04-05', 'assignees' => ['tt_a']];
    $r = $A('POST', '', $body);
    if ($r['status'] !== 201) {
        throw new RuntimeException('mk failed: ' . $r['status'] . ' ' . substr($r['raw'], 0, 300));
    }
    return $r['json']['task'];
};
/** Токен ссылки на задачу. */
$tok = static fn(array $t): string => '((' . $t['id'] . '|' . str_replace(['(', ')', '|'], '', $t['title']) . '))';
$get = fn(string $id): array => $A('GET', '?id=' . rawurlencode($id))['json']['task'];
$linkRows = fn(): array => $pdo->query('SELECT task_a, task_b FROM task_links ORDER BY task_a, task_b')->fetchAll(PDO::FETCH_NUM);
$pairCount = function (string $x, string $y) use ($pdo): int {
    [$a, $b] = canon($x, $y);
    $st = $pdo->prepare('SELECT COUNT(*) FROM task_links WHERE task_a = :a AND task_b = :b');
    $st->execute([':a' => $a, ':b' => $b]);
    return (int) $st->fetchColumn();
};
$auditN = fn(string $action, ?string $id = null): int => (int) ($id === null
    ? $pdo->query("SELECT COUNT(*) FROM audit_log WHERE action = '$action'")->fetchColumn()
    : $pdo->query("SELECT COUNT(*) FROM audit_log WHERE action = '$action' AND entity_id = '$id'")->fetchColumn());
$taskCount = fn(): int => (int) $pdo->query('SELECT COUNT(*) FROM tasks')->fetchColumn();
/** Из массива links достать [id => direction]. */
$dirs = static function (array $t): array {
    $m = [];
    foreach ($t['links'] as $l) { $m[$l['id']] = $l['direction']; }
    ksort($m);
    return $m;
};
/** Прямая вставка задачи/связи (для объёмных сценариев, без HTTP). */
$rawTask = function (string $id, string $start, string $title = 'raw', int $archived = 0, string $status = 'open') use ($pdo): void {
    $pdo->prepare("INSERT INTO tasks (id, title, start_at, status, check_state, version, created_by, created_at, updated_at, archived)
                   VALUES (:i, :t, :s, :st, 'ok', 1, 'raw', '2031-01-01T00:00:00+05:00', '2031-01-01T00:00:00+05:00', :a)")
        ->execute([':i' => $id, ':t' => $title, ':s' => $start, ':st' => $status, ':a' => $archived]);
};
$rawLink = function (string $x, string $y) use ($pdo): void {
    [$a, $b] = canon($x, $y);
    $pdo->prepare("INSERT INTO task_links (task_a, task_b, created_at, created_by) VALUES (:a, :b, 'x', 'raw')")->execute([':a' => $a, ':b' => $b]);
};

try {
    $login('admin', 'admin');
    $login('sup', 'supervisor_zone0');
    $login('view', 'viewer_test');

    // =====================================================================
    // Запись: симметрия, удаление, правила
    // =====================================================================
    $run('W1 создание задачи со ссылкой: A→B видна у обеих сторон (A: out, B: in); одна строка task_links (каноническая пара); links_text сохранён; аудит link_add', function () use ($A, $mk, $tok, $get, $dirs, $linkRows, $pairCount, $auditN) {
        $b = $mk(['title' => 'Задача Б']);
        $a0 = $auditN('task.link_add');
        $r = $A('POST', '', ['title' => 'Задача А', 'start_at' => '2031-04-06', 'assignees' => ['tt_a'], 'links_text' => 'Связана с ' . $tok($b) . ' — см.']);
        eq($r['status'], 201, 'status ' . $r['raw']);
        $a = $r['json']['task'];
        eq($a['links_text'], 'Связана с ((' . $b['id'] . '|Задача Б)) — см.', 'links_text');
        eq($a['links'], [['id' => $b['id'], 'title' => 'Задача Б', 'status' => 'open', 'archived' => 0, 'direction' => 'out']], 'links у A');
        eq($a['links_n'], 1, 'links_n A');
        $bb = $get($b['id']);
        eq($bb['links'], [['id' => $a['id'], 'title' => 'Задача А', 'status' => 'open', 'archived' => 0, 'direction' => 'in']], 'links у B (входящая)');
        eq($bb['links_text'], null, 'links_text у B не трогали');
        eq($pairCount($a['id'], $b['id']), 1, 'одна строка пары');
        [$ca, $cb] = canon($a['id'], $b['id']);
        $row = $GLOBALS['pdo']->query("SELECT task_a, task_b, created_by FROM task_links WHERE task_a = '$ca' AND task_b = '$cb'")->fetchAll(PDO::FETCH_ASSOC)[0];
        eq([$row['task_a'], $row['task_b'], $row['created_by']], [$ca, $cb, 'admin'], 'каноническая пара, created_by');
        eq($auditN('task.link_add', $a['id']), 1, 'аудит link_add у источника');
        eq($auditN('task.link_add') - $a0, 1, 'ровно одна запись аудита');
        return 'пара ' . $ca . '<' . $cb;
    });

    $run('W2 встречная ссылка B→A при уже существующей A→B не создаёт вторую строку; обе стороны out; аудит link_add не добавляется', function () use ($A, $mk, $tok, $get, $dirs, $linkRows, $pairCount, $auditN) {
        $b = $mk(['title' => 'W2 Б']);
        $a = $mk(['title' => 'W2 А', 'links_text' => $tok($b)]);
        eq($pairCount($a['id'], $b['id']), 1, 'до');
        $n0 = count($linkRows());
        $add0 = $auditN('task.link_add');
        $r = $A('PUT', '?id=' . $b['id'], ['version' => $b['version'], 'links_text' => $tok($a)]);
        eq($r['status'], 200, 'PUT ' . $r['raw']);
        eq($pairCount($a['id'], $b['id']), 1, 'по-прежнему одна строка');
        eq(count($linkRows()), $n0, 'общее число строк не выросло');
        eq($auditN('task.link_add'), $add0, 'новой связи нет — link_add не пишется');
        eq($dirs($get($a['id'])), [$b['id'] => 'out'], 'у A: out');
        eq($dirs($get($b['id'])), [$a['id'] => 'out'], 'у B: out (свой токен)');
        return 'ok';
    });

    $run('W3 удаление токена убирает связь с обеих сторон; при встречном токене связь сохраняется (направление становится in)', function () use ($A, $mk, $tok, $get, $dirs, $pairCount, $auditN) {
        // Односторонняя связь: A→B, токен убран → строки нет, B чист.
        $b = $mk(['title' => 'W3 Б']);
        $a = $mk(['title' => 'W3 А', 'links_text' => 'до ' . $tok($b) . ' после']);
        eq($pairCount($a['id'], $b['id']), 1, 'создана');
        $rm0 = $auditN('task.link_remove');
        $r = $A('PUT', '?id=' . $a['id'], ['version' => $a['version'], 'links_text' => 'до  после']);
        eq($r['status'], 200, 'PUT ' . $r['raw']);
        eq($pairCount($a['id'], $b['id']), 0, 'строка удалена');
        eq($get($a['id'])['links'], [], 'у A пусто');
        eq($get($b['id'])['links'], [], 'у B пусто (связь пропала с обеих сторон)');
        eq($auditN('task.link_remove') - $rm0, 1, 'аудит link_remove');
        // Взаимная связь: A→B и B→A; A убирает токен — связь остаётся (держит токен B), у A теперь in.
        $d = $mk(['title' => 'W3 Д']);
        $c = $mk(['title' => 'W3 С', 'links_text' => $tok($d)]);
        $r = $A('PUT', '?id=' . $d['id'], ['version' => $d['version'], 'links_text' => $tok($c)]);
        eq($r['status'], 200, 'D→C');
        $c1 = $get($c['id']);
        $rm1 = $auditN('task.link_remove');
        $r = $A('PUT', '?id=' . $c['id'], ['version' => $c1['version'], 'links_text' => '']);
        eq($r['status'], 200, 'C убрал токен');
        eq($pairCount($c['id'], $d['id']), 1, 'строка осталась (токен D держит)');
        eq($dirs($get($c['id'])), [$d['id'] => 'in'], 'у C теперь in');
        eq($dirs($get($d['id'])), [$c['id'] => 'out'], 'у D out');
        eq($auditN('task.link_remove'), $rm1, 'связь не удалена — link_remove не пишется');
        // D убирает токен — связь исчезает полностью.
        $d1 = $get($d['id']);
        $r = $A('PUT', '?id=' . $d['id'], ['version' => $d1['version'], 'links_text' => null]);
        eq($r['status'], 200, 'D убрал токен');
        eq($pairCount($c['id'], $d['id']), 0, 'строки нет');
        eq([$get($c['id'])['links'], $get($d['id'])['links']], [[], []], 'пусто у обеих');
        eq($auditN('task.link_remove') - $rm1, 1, 'link_remove при фактическом удалении');
        return 'ok';
    });

    $run('W4 очистка: links_text null и \'\' → NULL в БД, связи сняты; text без токенов — связей нет', function () use ($A, $mk, $tok, $get, $pairCount) {
        $b1 = $mk(['title' => 'W4 б1']);
        $b2 = $mk(['title' => 'W4 б2']);
        foreach ([null, ''] as $clear) {
            $a = $mk(['title' => 'W4 а', 'links_text' => $tok($b1) . $tok($b2)]);
            eq(count($a['links']), 2, 'две связи');
            $r = $A('PUT', '?id=' . $a['id'], ['version' => $a['version'], 'links_text' => $clear]);
            eq($r['status'], 200, 'PUT ' . $r['raw']);
            eq($r['json']['task']['links_text'], null, 'links_text → null');
            eq([$pairCount($a['id'], $b1['id']), $pairCount($a['id'], $b2['id'])], [0, 0], 'строки сняты');
        }
        $t = $mk(['title' => 'W4 текст', 'links_text' => 'просто текст без ссылок']);
        eq([$t['links'], $t['links_n']], [[], 0], 'без токенов связей нет');
        return 'ok';
    });

    $run('W5 самосвязь → 422 link_self (PUT); задача и связи не изменены', function () use ($A, $mk, $tok, $get, $linkRows) {
        $t = $mk(['title' => 'W5']);
        $n0 = count($linkRows());
        $r = $A('PUT', '?id=' . $t['id'], ['version' => $t['version'], 'title' => 'W5 новое', 'links_text' => '((' . $t['id'] . '|я сам))']);
        eq([$r['status'], $r['json']['error']], [422, 'link_self'], 'ответ ' . $r['raw']);
        $cur = $get($t['id']);
        eq([$cur['title'], $cur['version'], $cur['links_text']], ['W5', $t['version'], null], 'задача не изменена');
        eq(count($linkRows()), $n0, 'строк не прибавилось');
        return '422 link_self';
    });

    $run('W6 неизвестный ID → 422 link_unknown (POST и PUT); при отказе POST задача не создаётся', function () use ($A, $mk, $tok, $get, $taskCount, $linkRows) {
        $n0 = $taskCount();
        $r = $A('POST', '', ['title' => 'W6', 'start_at' => '2031-04-05', 'assignees' => ['tt_a'], 'links_text' => '((нет_такого_id_zzz|x)) ((tt_nope.1))']);
        // «нет_такого_id_zzz» — невалидный id (не токен) → игнорируется; tt_nope.1 валиден, но неизвестен.
        eq([$r['status'], $r['json']['error']], [422, 'link_unknown'], 'POST ' . $r['raw']);
        eq($r['json']['link_id'] ?? null, 'tt_nope.1', 'в ответе id');
        eq($taskCount(), $n0, 'задача не создана');
        $t = $mk(['title' => 'W6 б']);
        $r = $A('PUT', '?id=' . $t['id'], ['version' => $t['version'], 'links_text' => '((tt_nope.2|x))']);
        eq([$r['status'], $r['json']['error']], [422, 'link_unknown'], 'PUT ' . $r['raw']);
        eq($get($t['id'])['version'], $t['version'], 'версия прежняя');
        return 'ok';
    });

    $run('W7 новая связь на архивную → 409 link_target_archived (POST и PUT); данные не изменены', function () use ($A, $mk, $tok, $get, $taskCount, $linkRows) {
        $arch = $mk(['title' => 'W7 архив']);
        eq($A('DELETE', '?id=' . $arch['id'], ['version' => $arch['version']])['status'], 200, 'архивация');
        $n0 = $taskCount();
        $r = $A('POST', '', ['title' => 'W7', 'start_at' => '2031-04-05', 'assignees' => ['tt_a'], 'links_text' => $tok($arch)]);
        eq([$r['status'], $r['json']['error']], [409, 'link_target_archived'], 'POST ' . $r['raw']);
        eq($taskCount(), $n0, 'не создана');
        $t = $mk(['title' => 'W7 б']);
        $rows0 = $linkRows();
        $r = $A('PUT', '?id=' . $t['id'], ['version' => $t['version'], 'links_text' => $tok($arch)]);
        eq([$r['status'], $r['json']['error']], [409, 'link_target_archived'], 'PUT ' . $r['raw']);
        eq([$get($t['id'])['version'], $linkRows()], [$t['version'], $rows0], 'без изменений');
        return 'ok';
    });

    $run('W8 существующая связь с позже удалённой (архивной) сохраняется и помечена archived у обеих сторон; PUT с тем же токеном проходит; снять токен можно', function () use ($A, $mk, $tok, $get, $dirs, $pairCount) {
        $b = $mk(['title' => 'W8 Б']);
        $a = $mk(['title' => 'W8 А', 'links_text' => $tok($b)]);
        $x = $mk(['title' => 'W8 Х', 'links_text' => $tok($a)]);   // входящая у A: X→A
        eq($A('DELETE', '?id=' . $b['id'], ['version' => $b['version']])['status'], 200, 'архивация B');
        eq($pairCount($a['id'], $b['id']), 1, 'строка осталась после архива');
        $a1 = $get($a['id']);
        eq($a1['links'][0]['id'] . '|' . $a1['links'][0]['archived'] . '|' . $a1['links'][0]['direction'], $b['id'] . '|1|out', 'у A ссылка на B помечена archived');
        $b1 = $get($b['id']);
        eq([$b1['links'][0]['id'], $b1['links'][0]['archived']], [$a['id'], 0], 'у архивной B ссылка на A (не архивна) видна');
        // PUT A: меняем только название, токен на архивную сохраняем → 200, связь цела.
        $r = $A('PUT', '?id=' . $a['id'], ['version' => $a1['version'], 'title' => 'W8 А2', 'links_text' => $a1['links_text']]);
        eq($r['status'], 200, 'PUT с прежним токеном на архивную: ' . $r['raw']);
        eq($pairCount($a['id'], $b['id']), 1, 'связь сохранена');
        // Архивируем A: у X ссылка на A (архивная) перечёркнута.
        $a2 = $get($a['id']);
        eq($A('DELETE', '?id=' . $a['id'], ['version' => $a2['version']])['status'], 200, 'архивация A');
        $x1 = $get($x['id']);
        eq([$x1['links'][0]['id'], $x1['links'][0]['archived']], [$a['id'], 1], 'у X ссылка на архивную A');
        // Снятие токена на архивную цель разрешено (у X — на архивную A).
        $r = $A('PUT', '?id=' . $x['id'], ['version' => $x1['version'], 'links_text' => '']);
        eq($r['status'], 200, 'снять токен на архивную');
        eq($pairCount($x['id'], $a['id']), 0, 'строка снята');
        return 'ok';
    });

    $run('W9 лимит связей: 50 различных — ок, 51 → 422 links_too_many; дубли токенов считаются один раз', function () use ($A, $mk, $tok, $get, $rawTask, $pairCount, $linkRows) {
        $targets = [];
        for ($i = 1; $i <= 51; $i++) {
            $id = sprintf('lim_t%02d', $i);
            $rawTask($id, '2032-01-01');
            $targets[] = $id;
        }
        $mkText = fn(array $ids) => implode(' ', array_map(fn($i) => '((' . $i . '|т))', $ids));
        $t = $mk(['title' => 'W9 лимит']);
        $r = $A('PUT', '?id=' . $t['id'], ['version' => $t['version'], 'links_text' => $mkText(array_slice($targets, 0, 51))]);
        eq([$r['status'], $r['json']['error']], [422, 'links_too_many'], '51: ' . substr($r['raw'], 0, 200));
        eq($get($t['id'])['links_n'], 0, 'ничего не записано');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => $t['version'], 'links_text' => $mkText(array_slice($targets, 0, 50)) . ' ' . $mkText([$targets[0], $targets[1]])]);
        eq($r['status'], 200, '50 различных + дубли: ' . substr($r['raw'], 0, 200));
        eq($r['json']['task']['links_n'], 50, 'links_n = 50');
        return '50 ок, 51 → 422';
    });

    $run('W10 дубли токенов схлопываются: одна строка, одна запись links[], одна запись аудита', function () use ($A, $mk, $tok, $pairCount, $auditN) {
        $b = $mk(['title' => 'W10 Б']);
        $a0 = $auditN('task.link_add');
        $a = $mk(['title' => 'W10 А', 'links_text' => $tok($b) . ' и ещё ' . $tok($b) . ' ' . $tok($b)]);
        eq($pairCount($a['id'], $b['id']), 1, 'строка');
        eq(count($a['links']), 1, 'links');
        eq($auditN('task.link_add') - $a0, 1, 'аудит');
        return 'ok';
    });

    $run('W11 VERSION_CONFLICT: устаревшая version + links_text → 409, ничего не записано; актуальная задача в ответе', function () use ($A, $mk, $tok, $get, $pairCount) {
        $b = $mk(['title' => 'W11 Б']);
        $a = $mk(['title' => 'W11 А']);
        $r1 = $A('PUT', '?id=' . $a['id'], ['version' => $a['version'], 'title' => 'W11 А (1)']);
        eq($r1['status'], 200, 'первая правка');
        $r = $A('PUT', '?id=' . $a['id'], ['version' => $a['version'], 'links_text' => $tok($b)]);
        eq([$r['status'], $r['json']['error'], $r['json']['current_version']], [409, 'VERSION_CONFLICT', $a['version'] + 1], 'ответ ' . substr($r['raw'], 0, 200));
        eq($pairCount($a['id'], $b['id']), 0, 'связь не записана');
        eq($get($a['id'])['links_text'], null, 'links_text не записан');
        return 'ok';
    });

    $run('W12 валидация links_text: не строка → 400 invalid_links_text; длина > 5000 → 400 (как description); ровно 5000 — ок', function () use ($A, $mk, $get) {
        $t = $mk(['title' => 'W12']);
        foreach ([123, ['a'], true] as $bad) {
            $r = $A('PUT', '?id=' . $t['id'], ['version' => $t['version'], 'links_text' => $bad]);
            eq([$r['status'], $r['json']['error']], [400, 'invalid_links_text'], 'тип ' . json_encode($bad));
        }
        $r = $A('PUT', '?id=' . $t['id'], ['version' => $t['version'], 'links_text' => str_repeat('я', 5001)]);
        eq([$r['status'], $r['json']['error']], [400, 'invalid_links_text'], '5001');
        $r = $A('POST', '', ['title' => 'W12 п', 'start_at' => '2031-04-05', 'assignees' => ['tt_a'], 'links_text' => str_repeat('я', 5001)]);
        eq([$r['status'], $r['json']['error']], [400, 'invalid_links_text'], 'POST 5001');
        $r = $A('PUT', '?id=' . $t['id'], ['version' => $t['version'], 'links_text' => str_repeat('я', 5000)]);
        eq($r['status'], 200, '5000 ок');
        return 'ok';
    });

    $run('W13 PUT без изменений links_text (тот же текст) → unchanged, версия не растёт; только links_text → версия +1, аудит task.update с changed:[links_text]', function () use ($A, $mk, $tok, $get, $pdo) {
        $b = $mk(['title' => 'W13 Б']);
        $a = $mk(['title' => 'W13 А', 'links_text' => $tok($b)]);
        $r = $A('PUT', '?id=' . $a['id'], ['version' => $a['version'], 'links_text' => $a['links_text']]);
        eq([$r['status'], $r['json']['unchanged'] ?? null, $r['json']['task']['version']], [200, true, $a['version']], 'тот же текст');
        $r = $A('PUT', '?id=' . $a['id'], ['version' => $a['version'], 'links_text' => $a['links_text'] . ' + комментарий']);
        eq([$r['status'], $r['json']['task']['version']], [200, $a['version'] + 1], 'изменён только links_text');
        $det = $pdo->query("SELECT details FROM audit_log WHERE action = 'task.update' AND entity_id = '" . $a['id'] . "' ORDER BY id DESC LIMIT 1")->fetchColumn();
        eq(json_decode((string) $det, true)['changed'], ['links_text'], 'changed');
        return 'ok';
    });

    $run('W14 атомарность: PUT с валидным изменением названия и ошибочным токеном → 422, название не изменилось; задача + связи пишутся одной транзакцией', function () use ($A, $mk, $tok, $get, $pairCount) {
        $b = $mk(['title' => 'W14 Б']);
        $a = $mk(['title' => 'W14 А']);
        $r = $A('PUT', '?id=' . $a['id'], ['version' => $a['version'], 'title' => 'W14 новое', 'links_text' => $tok($b) . ' ((tt_nope.9))']);
        eq($r['status'], 422, 'статус');
        $cur = $get($a['id']);
        eq([$cur['title'], $cur['version']], ['W14 А', $a['version']], 'задача не тронута');
        eq($pairCount($a['id'], $b['id']), 0, 'валидная часть токенов не записана');
        // Успех: название и связь вместе, версия +1.
        $r = $A('PUT', '?id=' . $a['id'], ['version' => $a['version'], 'title' => 'W14 А2', 'links_text' => $tok($b)]);
        eq([$r['status'], $r['json']['task']['title'], $r['json']['task']['version'], $r['json']['task']['links_n']], [200, 'W14 А2', $a['version'] + 1, 1], 'одним запросом');
        return 'ok';
    });

    $run('W15 невалидный ID в токене и «пустое (())» не дают связей и ошибок: текст сохраняется как есть', function () use ($A, $mk, $get, $linkRows) {
        $t = $mk(['title' => 'W15']);
        $n0 = count($linkRows());
        $txt = 'пусто (()) и ((не валидный id|x)) и ((a b)) конец';
        $r = $A('PUT', '?id=' . $t['id'], ['version' => $t['version'], 'links_text' => $txt]);
        eq($r['status'], 200, 'PUT ' . $r['raw']);
        eq([$r['json']['task']['links_text'], $r['json']['task']['links'], count($linkRows())], [$txt, [], $n0], 'сохранено, связей нет');
        return 'ok';
    });

    $run('W16 вторая сторона: updated_at обновляется при добавлении/удалении связи, version — нет; своя задача — version +1', function () use ($A, $mk, $tok, $get, $pdo) {
        $b = $mk(['title' => 'W16 Б']);
        $old = '2000-01-01T00:00:00+00:00';
        $setOld = fn() => $pdo->exec("UPDATE tasks SET updated_at = '$old' WHERE id = '" . $b['id'] . "'");
        $setOld();
        $a = $mk(['title' => 'W16 А', 'links_text' => $tok($b)]);
        $b1 = $get($b['id']);
        eq($b1['version'], $b['version'], 'version второй стороны не менялся (add)');
        ok($b1['updated_at'] !== $old, 'updated_at второй стороны обновлён (add)');
        $setOld();
        $r = $A('PUT', '?id=' . $a['id'], ['version' => $a['version'], 'links_text' => '']);
        eq($r['status'], 200, 'снятие');
        $b2 = $get($b['id']);
        eq($b2['version'], $b['version'], 'version второй стороны не менялся (remove)');
        ok($b2['updated_at'] !== $old, 'updated_at второй стороны обновлён (remove)');
        eq($r['json']['task']['version'], $a['version'] + 1, 'у источника version +1');
        return 'ok';
    });

    // =====================================================================
    // Чтение: форма ответов, список, права
    // =====================================================================
    $run('R1 форма: links_text/links/links_n есть в карточке и в строках списка; items ровно {id,title,status,archived,direction}; названия/статусы актуальные', function () use ($A, $mk, $tok, $get) {
        $b = $mk(['title' => 'R1 Б', 'start_at' => '2033-02-01']);
        $a = $mk(['title' => 'R1 А', 'start_at' => '2033-02-02', 'links_text' => $tok($b)]);
        // Переименуем и закроем B — у A должно быть актуальное.
        $b1 = $get($b['id']);
        eq($A('PUT', '?id=' . $b['id'], ['version' => $b1['version'], 'title' => 'R1 Б (новое имя)'])['status'], 200, 'rename');
        $b2 = $get($b['id']);
        eq($A('POST', '?id=' . $b['id'] . '&action=close', ['version' => $b2['version']])['status'], 200, 'close');
        $card = $get($a['id']);
        eq(array_keys($card['links'][0]), ['id', 'title', 'status', 'archived', 'direction'], 'ключи элемента');
        eq([$card['links'][0]['title'], $card['links'][0]['status']], ['R1 Б (новое имя)', 'closed'], 'актуальные название/статус');
        $list = $A('GET', '?from=2033-02-01&to=2033-02-03')['json']['tasks'];
        $byId = [];
        foreach ($list as $t) { $byId[$t['id']] = $t; }
        eq($byId[$a['id']]['links'], $card['links'], 'в списке те же links');
        eq([$byId[$a['id']]['links_n'], $byId[$b['id']]['links_n'], $byId[$a['id']]['links_text'] === $card['links_text']], [1, 1, true], 'links_n / links_text в списке');
        foreach ($list as $t) {
            ok(array_key_exists('links', $t) && array_key_exists('links_n', $t) && array_key_exists('links_text', $t), 'поля в каждой строке списка');
        }
        return count($list) . ' строк списка';
    });

    $run('R2 порядок links: сначала исходящие (в порядке токенов), затем входящие (по названию)', function () use ($A, $mk, $tok, $get) {
        $o1 = $mk(['title' => 'R2 о1']);
        $o2 = $mk(['title' => 'R2 о2']);
        $z = $mk(['title' => 'R2 я-вх']);
        $x = $mk(['title' => 'R2 а-вх']);
        $c = $mk(['title' => 'R2 центр', 'links_text' => $tok($o2) . ' ' . $tok($o1)]);
        foreach ([$z, $x] as $in) {
            $cur = $get($in['id']);
            eq($A('PUT', '?id=' . $in['id'], ['version' => $cur['version'], 'links_text' => $tok($c)])['status'], 200, 'входящая');
        }
        $card = $get($c['id']);
        eq(array_map(fn($l) => $l['id'] . ':' . $l['direction'], $card['links']),
            [$o2['id'] . ':out', $o1['id'] . ':out', $x['id'] . ':in', $z['id'] . ':in'], 'порядок');
        return 'ok';
    });

    $run('R3 права: supervisor/viewer читают links (?id, список), ?pick, ?related → 200; запись с links_text → 403 без изменений; аноним → 401', function () use ($A, $S, $V, $N, $mk, $tok, $get, $pairCount, $linkRows) {
        $b = $mk(['title' => 'R3 Б', 'start_at' => '2034-03-01']);
        $a = $mk(['title' => 'R3 А', 'start_at' => '2034-03-02', 'links_text' => $tok($b)]);
        foreach ([['supervisor', $S], ['viewer', $V]] as [$who, $fn]) {
            $one = $fn('GET', '?id=' . $a['id']);
            eq([$one['status'], $one['json']['task']['links_n'], $one['json']['task']['links'][0]['id']], [200, 1, $b['id']], "$who ?id");
            $lst = $fn('GET', '?from=2034-03-01&to=2034-03-03');
            eq($lst['status'], 200, "$who список");
            $pk = $fn('GET', '?pick=1');
            eq([$pk['status'], $pk['json']['success']], [200, true], "$who ?pick");
            $rl = $fn('GET', '?related=' . $a['id']);
            eq([$rl['status'], $rl['json']['ids']], [200, [$a['id'], $b['id']]], "$who ?related");
            $rows0 = $linkRows();
            $c = $mk(['title' => "R3 $who"]);
            $w = $fn('PUT', '?id=' . $c['id'], ['version' => $c['version'], 'links_text' => $tok($b)]);
            eq($w['status'], 403, "$who PUT");
            $w = $fn('POST', '', ['title' => 'x', 'start_at' => '2034-03-01', 'assignees' => ['tt_a'], 'links_text' => $tok($b)]);
            eq($w['status'], 403, "$who POST");
            eq([$pairCount($c['id'], $b['id']), $linkRows()], [0, $rows0], "$who: связей не появилось");
        }
        foreach ([['GET', '?pick=1'], ['GET', '?related=' . $a['id']], ['GET', '?id=' . $a['id']],
                  ['PUT', '?id=' . $a['id'], ['version' => 1, 'links_text' => '']], ['POST', '', ['title' => 'x', 'start_at' => '2034-03-01', 'assignees' => ['tt_a'], 'links_text' => $tok($b)]]] as $c) {
            eq($N($c[0], $c[1], $c[2] ?? null)['status'], 401, 'аноним ' . $c[0] . ' ' . $c[1]);
        }
        return 'sup/viewer читают, не пишут; anon 401';
    });

    // =====================================================================
    // ?pick=1
    // =====================================================================
    $run('Q1 ?pick=1: {success,tasks:[{id,title,status,start_at}]}; открытые И закрытые; архивных нет; сортировка start_at DESC', function () use ($A, $mk, $get) {
        $open = $mk(['title' => 'Q1 откр', 'start_at' => '2036-05-01']);
        $closed = $mk(['title' => 'Q1 закр', 'start_at' => '2036-06-01']);
        eq($A('POST', '?id=' . $closed['id'] . '&action=close', ['version' => $closed['version']])['status'], 200, 'close');
        $arch = $mk(['title' => 'Q1 арх', 'start_at' => '2036-07-01']);
        eq($A('DELETE', '?id=' . $arch['id'], ['version' => $arch['version']])['status'], 200, 'archive');
        $r = $A('GET', '?pick=1');
        eq($r['status'], 200, 'status');
        eq($r['json']['success'], true, 'success');
        $by = [];
        foreach ($r['json']['tasks'] as $t) { $by[$t['id']] = $t; }
        ok(isset($by[$open['id']]) && isset($by[$closed['id']]), 'открытая и закрытая есть');
        ok(!isset($by[$arch['id']]), 'архивной нет');
        eq(array_keys($by[$open['id']]), ['id', 'title', 'status', 'start_at'], 'ключи');
        eq([$by[$open['id']]['status'], $by[$closed['id']]['status']], ['open', 'closed'], 'статусы');
        $starts = array_column($r['json']['tasks'], 'start_at');
        $sorted = $starts;
        rsort($sorted, SORT_STRING);
        eq($starts, $sorted, 'start_at DESC');
        $pos = array_flip(array_column($r['json']['tasks'], 'id'));
        ok($pos[$closed['id']] < $pos[$open['id']], '2036-06 раньше 2036-05 в выдаче');
        return count($starts) . ' задач в окне';
    });

    // =====================================================================
    // ?related=<id>
    // =====================================================================
    $run('L1 ?related: цепочка 1–2–3 из любой точки — все три, исходная первой, остальные по start_at ASC; tasks[] — полные карточки в том же порядке', function () use ($A, $mk, $tok, $get) {
        // start_at: t3 < t1 < t2 — порядок «не по цепочке».
        $t1 = $mk(['title' => 'L1-1', 'start_at' => '2037-02-10']);
        $t2 = $mk(['title' => 'L1-2', 'start_at' => '2037-02-20', 'links_text' => $tok($t1)]);
        $t3 = $mk(['title' => 'L1-3', 'start_at' => '2037-02-05', 'links_text' => $tok($t2)]);
        $expect = [
            $t1['id'] => [$t1['id'], $t3['id'], $t2['id']],   // сам, затем 02-05 (t3), 02-20 (t2)
            $t2['id'] => [$t2['id'], $t3['id'], $t1['id']],
            $t3['id'] => [$t3['id'], $t1['id'], $t2['id']],
        ];
        foreach ($expect as $from => $want) {
            $r = $A('GET', '?related=' . rawurlencode($from));
            eq($r['status'], 200, 'status ' . $r['raw']);
            eq($r['json']['success'], true, 'success');
            eq($r['json']['ids'], $want, 'ids из ' . $from);
            eq(array_column($r['json']['tasks'], 'id'), $want, 'tasks в том же порядке');
        }
        $r = $A('GET', '?related=' . $t2['id']);
        $card = $r['json']['tasks'][0];
        eq($card, $get($t2['id']), 'карточка в related = карточка из ?id (включая links)');
        eq(array_map(fn($l) => $l['direction'], $card['links']), ['out', 'in'], 'links у t2: out на t1, in от t3');
        return 'ok';
    });

    $run('L2 ?related: цикл 1→2→3→1 — без дублей; изолированная задача — только она сама', function () use ($A, $mk, $tok, $get) {
        $t1 = $mk(['title' => 'L2-1', 'start_at' => '2037-03-01']);
        $t2 = $mk(['title' => 'L2-2', 'start_at' => '2037-03-02', 'links_text' => $tok($t1)]);
        $t3 = $mk(['title' => 'L2-3', 'start_at' => '2037-03-03', 'links_text' => $tok($t2)]);
        $c1 = $get($t1['id']);
        eq($A('PUT', '?id=' . $t1['id'], ['version' => $c1['version'], 'links_text' => $tok($t3)])['status'], 200, 'замыкание');
        foreach ([$t1, $t2, $t3] as $t) {
            $r = $A('GET', '?related=' . $t['id']);
            eq(count($r['json']['ids']), 3, 'три задачи');
            eq(count(array_unique($r['json']['ids'])), 3, 'без дублей');
            eq($r['json']['ids'][0], $t['id'], 'исходная первой');
        }
        $lone = $mk(['title' => 'L2 один']);
        $r = $A('GET', '?related=' . $lone['id']);
        eq([$r['json']['ids'], count($r['json']['tasks'])], [[$lone['id']], 1], 'изолированная');
        return 'ok';
    });

    $run('L3 ?related: разрыв через архивную — не проходит через неё; архивные в список не попадают; id архивной → 409 task_archived; неизвестный → 404', function () use ($A, $mk, $tok, $get) {
        $t1 = $mk(['title' => 'L3-1', 'start_at' => '2037-04-01']);
        $t2 = $mk(['title' => 'L3-2', 'start_at' => '2037-04-02', 'links_text' => $tok($t1)]);
        $t3 = $mk(['title' => 'L3-3', 'start_at' => '2037-04-03', 'links_text' => $tok($t2)]);
        $t4 = $mk(['title' => 'L3-4', 'start_at' => '2037-04-04', 'links_text' => $tok($t1)]);
        eq($A('DELETE', '?id=' . $t2['id'], ['version' => $t2['version']])['status'], 200, 'архивация t2');
        eq($A('GET', '?related=' . $t1['id'])['json']['ids'], [$t1['id'], $t4['id']], 'от t1: t2 не проходит, t3 недостижима');
        eq($A('GET', '?related=' . $t3['id'])['json']['ids'], [$t3['id']], 'от t3: только она');
        $r = $A('GET', '?related=' . $t2['id']);
        eq([$r['status'], $r['json']['error']], [409, 'task_archived'], 'архивная: ' . $r['raw']);
        $r = $A('GET', '?related=tt_no_such_task');
        eq($r['status'], 404, 'неизвестная: ' . $r['raw']);
        return 'ok';
    });

    $run('L4 ?related: лимит 200 задач; исходная первой; truncated=true; ровно 200 — truncated отсутствует/false', function () use ($A, $rawTask, $rawLink) {
        $rawTask('lim_hub', '2038-01-01', 'hub');
        for ($i = 1; $i <= 204; $i++) {
            $id = sprintf('lim_s%03d', $i);
            $rawTask($id, sprintf('2038-02-%02d', 1 + ($i % 27)), 's' . $i);
            $rawLink('lim_hub', $id);
        }
        $r = $A('GET', '?related=lim_hub');
        eq($r['status'], 200, 'status');
        eq(count($r['json']['ids']), 200, 'ровно 200');
        eq($r['json']['ids'][0], 'lim_hub', 'исходная первой');
        eq(count($r['json']['tasks']), 200, 'карточек 200');
        eq($r['json']['truncated'] ?? null, true, 'truncated');
        // Компонент ровно из 200 — без усечения.
        $rawTask('lim2_hub', '2038-01-01', 'hub2');
        for ($i = 1; $i <= 199; $i++) {
            $id = sprintf('lim2_s%03d', $i);
            $rawTask($id, '2038-03-01', 's' . $i);
            $rawLink('lim2_hub', $id);
        }
        $r = $A('GET', '?related=lim2_hub');
        eq([count($r['json']['ids']), (bool) ($r['json']['truncated'] ?? false)], [200, false], 'ровно 200 — не усечено');
        // Из «листа» первого компонента: исходная первой, граф тот же (лимит срабатывает и тут).
        $r = $A('GET', '?related=lim_s001');
        eq([$r['json']['ids'][0], count($r['json']['ids'])], ['lim_s001', 200], 'из листа: первая — сам, всего 200');
        return 'ok';
    });

    // =====================================================================
    // close / reopen / DELETE не трогают связи; повторы/FR-10 как раньше
    // =====================================================================
    $run('C1 close/reopen/DELETE (архив) не создают и не меняют task_links и links_text; version меняется только у самой задачи', function () use ($A, $mk, $tok, $get, $linkRows, $pdo) {
        $b = $mk(['title' => 'C1 Б']);
        $a = $mk(['title' => 'C1 А', 'links_text' => $tok($b)]);
        $rows = $linkRows();
        $bv = $get($b['id'])['version'];
        $r = $A('POST', '?id=' . $a['id'] . '&action=close', ['version' => $a['version']]);
        eq($r['status'], 200, 'close');
        eq([$linkRows(), $r['json']['task']['links_text'], $get($b['id'])['version']], [$rows, $a['links_text'], $bv], 'после close');
        eq($get($b['id'])['links'][0]['status'], 'closed', 'B видит A закрытой (актуальный статус)');
        $a1 = $r['json']['task'];
        $r = $A('POST', '?id=' . $a['id'] . '&action=reopen', ['version' => $a1['version']]);
        eq($r['status'], 200, 'reopen');
        eq([$linkRows(), $r['json']['task']['links_text'], $get($b['id'])['version']], [$rows, $a['links_text'], $bv], 'после reopen');
        $a2 = $r['json']['task'];
        $r = $A('DELETE', '?id=' . $b['id'], ['version' => $bv]);
        eq($r['status'], 200, 'DELETE B (архив)');
        eq($linkRows(), $rows, 'после архива B строки task_links те же');
        eq($get($a['id'])['version'], $a2['version'], 'version у A не менялся архивацией B');
        eq($pdo->query("SELECT links_text FROM tasks WHERE id = '" . $b['id'] . "'")->fetchColumn(), null, 'links_text у B не тронут');
        // Закрытие/переоткрытие/архив не создают связей у задач без токенов.
        $solo = $mk(['title' => 'C1 соло']);
        $A('POST', '?id=' . $solo['id'] . '&action=close', ['version' => $solo['version']]);
        eq($linkRows(), $rows, 'у соло связей не появилось');
        return 'ok';
    });

    $run('C2 повторы (task_occurrences) и FR-10: PUT только links_text не трогает повторы и check_state; PUT с occurrences + links_text работает', function () use ($A, $mk, $tok, $get, $pdo) {
        $b = $mk(['title' => 'C2 Б']);
        $a = $mk(['title' => 'C2 А', 'start_at' => '2039-01-01T13:00', 'end_at' => '2039-01-01T14:00', 'occurrences' => [['start_at' => '2039-01-11T14:30']]]);
        eq(count($a['occurrences']), 1, 'повтор создан');
        $cs = $a['check_state'];
        $r = $A('PUT', '?id=' . $a['id'], ['version' => $a['version'], 'links_text' => $tok($b)]);
        eq($r['status'], 200, 'PUT ' . $r['raw']);
        eq([count($r['json']['task']['occurrences']), $r['json']['task']['check_state'], $r['json']['task']['occurrences'][0]['start_at']], [1, $cs, '2039-01-11T14:30'], 'повтор и check_state прежние');
        $r2 = $A('PUT', '?id=' . $a['id'], ['version' => $r['json']['task']['version'], 'occurrences' => [['start_at' => '2039-01-12T10:00']], 'links_text' => '']);
        eq($r2['status'], 200, 'occurrences + очистка links ' . $r2['raw']);
        eq([$r2['json']['task']['occurrences'][0]['start_at'], $r2['json']['task']['links_n']], ['2039-01-12T10:00', 0], 'оба изменения');
        // Ссылка на задачу с повторами: у цели ничего не меняется в повторах.
        $r3 = $A('PUT', '?id=' . $b['id'], ['version' => $b['version'], 'links_text' => $tok($a)]);
        eq($r3['status'], 200, 'ссылка на задачу с повторами');
        eq(count($get($a['id'])['occurrences']), 1, 'повторы цели не тронуты');
        return 'ok';
    });

    $run('C3 путей копирования задач с переносом связей нет: в api/ нет дублирования задачи (copy/duplicate/clone), tasks.php не копирует links_text', function () use ($root) {
        $src = (string) file_get_contents($root . '/api/tasks.php');
        ok(preg_match('/action\s*===?\s*[\'"](copy|duplicate|clone)[\'"]/i', $src) === 0, 'в tasks.php нет action copy/duplicate/clone');
        ok(preg_match('/in_array\(\$action,\s*\[[^\]]*(copy|duplicate|clone)/i', $src) === 0, 'нет copy в списках действий');
        return 'ok';
    });

    // =====================================================================
    // Объём ответа списка и ?pick: лимит 2000 (в конце — вставка пачкой)
    // =====================================================================
    $run('V1 объём списка: у задач без связей links=[] и links_n=0 (добавка к строке — десятки байт); у связанных — links в строке', function () use ($A, $mk) {
        $r = $A('GET', '?from=2031-04-01&to=2031-04-30');
        ok(count($r['json']['tasks']) > 3, 'в диапазоне есть задачи');
        $plain = 0;
        foreach ($r['json']['tasks'] as $t) {
            ok(is_array($t['links']) && is_int($t['links_n']), 'типы');
            eq($t['links_n'], count($t['links']), 'links_n = count(links)');
            if ($t['links_n'] === 0) { $plain++; }
        }
        ok($plain > 0, 'есть задачи без связей');
        $n = count($r['json']['tasks']);
        $blob = json_encode(array_map(fn($t) => [$t['links'], $t['links_n'], $t['links_text']], $r['json']['tasks']), JSON_UNESCAPED_UNICODE);
        return "$n строк, add-on полей " . strlen((string) $blob) . ' байт всего';
    });

    $run('Q2 ?pick=1: лимит 2000 (вставлено 2105 открытых), самые поздние start_at первыми', function () use ($A, $rawTask) {
        for ($i = 1; $i <= 2105; $i++) {
            $rawTask(sprintf('pk_%04d', $i), sprintf('2090-%02d-%02d', 1 + intdiv($i, 100) % 12, 1 + ($i % 28)), 'pk' . $i);
        }
        $r = $A('GET', '?pick=1');
        eq($r['status'], 200, 'status');
        eq(count($r['json']['tasks']), 2000, 'лимит 2000');
        $starts = array_column($r['json']['tasks'], 'start_at');
        $sorted = $starts;
        rsort($sorted, SORT_STRING);
        eq($starts, $sorted, 'DESC');
        ok(substr($starts[0], 0, 4) === '2090', 'самые поздние — первыми');
        return 'ok';
    });

    $run('G1 нет утечки: ответы ?pick/?related не содержат телефонов/фото/путей; методы/ошибки — как у модуля', function () use ($A) {
        foreach (['?pick=1', '?related=lim_hub'] as $q) {
            $r = $A('GET', $q);
            ok(strpos($r['raw'], 'phone') === false && strpos($r['raw'], 'photo') === false, 'нет phone/photo в ' . $q);
            ok(strpos($r['raw'], '/home/') === false && strpos($r['raw'], '.php') === false, 'нет путей в ' . $q);
        }
        $r = $A('GET', '?related=');
        eq($r['status'], 404, 'пустой related → 404 not_found');
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
