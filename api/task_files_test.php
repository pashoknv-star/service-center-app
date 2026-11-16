<?php

declare(strict_types=1);

// Служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * task_files_test.php — сьют tasksatt (V7): вложения задач — миграция v13, api/task_files.php
 * (лимиты, белый список по расширению и содержимому, RBAC admin/supervisor/viewer/аноним,
 * скачивание, удаление), удаление вложений при архивации (api/tasks.php DELETE), поле attachments.
 *
 * Usage: php api/task_files_test.php
 * Изоляция: data/app.db копируется во временный каталог (SC_APP_DB), файлы вложений — рядом с копией;
 * data/app.db и data/task_files не трогаются (sha1 до/после). Сервер php -S запускается с лимитами
 * PHP прода (upload_max_filesize/post_max_size = 256M) и второй — с 2M (правило «минимум», Ш0).
 */

$root = realpath(__DIR__ . '/..');
$realDb = $root . '/data/app.db';
$realDbHashBefore = is_file($realDb) ? sha1_file($realDb) : '';
$realFilesBefore = is_dir($root . '/data/task_files') ? count(scandir($root . '/data/task_files')) : -1;

$work = sys_get_temp_dir() . '/sc_tf_' . bin2hex(random_bytes(4));
mkdir($work, 0775, true);
$tmpDb = $work . '/app.db';
copy($realDb, $tmpDb);
putenv('SC_APP_DB=' . $tmpDb);
putenv('TASKS_VALIDATE_WEBHOOK_URL');
$_ENV['SC_APP_DB'] = $tmpDb;

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/task_files_lib.php';

$passed = 0;
$failed = 0;
$testNo = 0;
function out(string $s): void { echo $s, PHP_EOL; }
function ok(bool $c, string $m = 'assert failed'): void { if (!$c) { throw new RuntimeException($m); } }
function eq(mixed $a, mixed $e, string $w = 'value'): void
{
    if ($a !== $e) {
        throw new RuntimeException($w . ': expected ' . json_encode($e, JSON_UNESCAPED_UNICODE) . ', got ' . json_encode($a, JSON_UNESCAPED_UNICODE));
    }
}
$run = function (string $label, callable $fn) use (&$testNo, &$passed, &$failed): void {
    $testNo++;
    try {
        $x = $fn();
        $passed++;
        out(sprintf('[%d] %s: PASS%s', $testNo, $label, $x ? ' — ' . $x : ''));
    } catch (Throwable $e) {
        $failed++;
        out(sprintf('[%d] %s: FAIL — %s', $testNo, $label, $e->getMessage()));
    }
};

out('=== TASK FILES TEST START ===');

// ---------------------------------------------------------------- миграция
$db = Database::getInstance();
$pdo = $db->getPDO();
$pdo->exec('PRAGMA busy_timeout = 5000');
$verBefore = $db->getSchemaVersion();

$run('M1 миграция → v13: таблица task_attachments (колонки, UNIQUE stored_name, FK CASCADE, индекс)', function () use ($db, $pdo, $verBefore) {
    $db->migrate();
    eq($db->getSchemaVersion(), 13, 'schema_version');
    $cols = $pdo->query('PRAGMA table_info(task_attachments)')->fetchAll(PDO::FETCH_COLUMN, 1);
    eq($cols, ['id', 'task_id', 'orig_name', 'stored_name', 'mime', 'size', 'uploaded_by', 'uploaded_at'], 'cols');
    $fk = $pdo->query('PRAGMA foreign_key_list(task_attachments)')->fetchAll(PDO::FETCH_ASSOC);
    eq(array_map(fn($f) => [$f['table'], $f['on_delete']], $fk), [['tasks', 'CASCADE']], 'FK');
    $idx = $pdo->query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_attachments'")->fetchAll(PDO::FETCH_COLUMN);
    ok(in_array('idx_task_attachments_task', $idx, true), 'индекс');
    return 'v' . $verBefore . '→v13';
});

$run('M2 миграция v12 → v13 на БД с задачами: данные задач не тронуты, повтор — no-op', function () use ($db, $pdo) {
    $pdo->exec("INSERT INTO tasks (id, title, start_at, version) VALUES ('tf_m2', 'M2', '2030-01-01', 3)");
    $pdo->exec('DROP TABLE task_attachments');
    $pdo->exec("UPDATE meta SET value = '12' WHERE key = 'schema_version'");
    $snap = md5(json_encode($pdo->query('SELECT * FROM tasks ORDER BY id')->fetchAll(PDO::FETCH_ASSOC)));
    $db->migrate();
    eq($db->getSchemaVersion(), 13, 'v13');
    eq(md5(json_encode($pdo->query('SELECT * FROM tasks ORDER BY id')->fetchAll(PDO::FETCH_ASSOC))), $snap, 'tasks не изменились');
    $pdo->exec("UPDATE meta SET value = '12' WHERE key = 'schema_version'");
    $db->migrate();
    eq((int) $pdo->query("SELECT COUNT(*) FROM sqlite_master WHERE name='task_attachments'")->fetchColumn(), 1, 'повтор');
    $pdo->exec("DELETE FROM tasks WHERE id = 'tf_m2'");
    return 'ok';
});

$run('L1 правило «минимум» (Ш0): tf_ini_bytes и лимит файла = min(5 МБ, лимиты PHP)', function () {
    eq(tf_ini_bytes('256M'), 256 * 1048576, '256M');
    eq(tf_ini_bytes('2M'), 2 * 1048576, '2M');
    eq(tf_ini_bytes('1G'), 1073741824, '1G');
    eq(tf_ini_bytes('512K'), 524288, '512K');
    eq(tf_ini_bytes('0'), PHP_INT_MAX, '0 = без лимита');
    eq(TF_MAX_FILE_BYTES, 5242880, '5 МБ');
    eq(TF_MAX_FILES, 10, '10 файлов');
    eq(TF_MAX_TOTAL_BYTES, 52428800, '50 МБ');
    return 'ok';
});

$run('L2 имя файла: путь отрезается, управляющие символы убираются, ≤ 200 символов, расширение сохраняется', function () {
    eq(tf_clean_name('../../etc/passwd.txt'), 'passwd.txt', 'traversal');
    eq(tf_clean_name('C:\\Users\\x\\Отчёт за ноябрь.pdf'), 'Отчёт за ноябрь.pdf', 'windows path');
    eq(tf_clean_name("a\x00b\x1Fc.txt"), 'abc.txt', 'control');
    eq(tf_clean_name('.htaccess'), 'htaccess', 'leading dot');
    $long = tf_clean_name(str_repeat('я', 300) . '.docx');
    eq(mb_strlen($long), 200, 'len');
    ok(str_ends_with($long, '.docx'), 'ext kept');
    return 'ok';
});

// ---------------------------------------------------------------- фикстуры
$fx = $work . '/fx';
mkdir($fx);
function fx_zip(string $path, array $files): void
{
    $z = new ZipArchive();
    $z->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE);
    foreach ($files as $n => $c) {
        $z->addFromString($n, $c);
    }
    $z->close();
}
function fx_img(string $path, string $kind): void
{
    $im = imagecreatetruecolor(8, 8);
    imagefill($im, 0, 0, imagecolorallocate($im, 119, 0, 255));
    match ($kind) {
        'png' => imagepng($im, $path),
        'jpg' => imagejpeg($im, $path),
        'gif' => imagegif($im, $path),
        'webp' => imagewebp($im, $path),
    };
    imagedestroy($im);
}
$ct = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
$F = [];
file_put_contents($F['pdf'] = "$fx/Отчёт.pdf", "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
fx_zip($F['docx'] = "$fx/a.docx", ['[Content_Types].xml' => $ct, 'word/document.xml' => '<w:document/>']);
fx_zip($F['xlsx'] = "$fx/a.xlsx", ['[Content_Types].xml' => $ct, 'xl/workbook.xml' => '<workbook/>']);
fx_zip($F['pptx'] = "$fx/a.pptx", ['[Content_Types].xml' => $ct, 'ppt/presentation.xml' => '<p/>']);
foreach (['odt' => 'text', 'ods' => 'spreadsheet', 'odp' => 'presentation'] as $e => $k) {
    $z = new ZipArchive();
    $z->open($F[$e] = "$fx/a.$e", ZipArchive::CREATE | ZipArchive::OVERWRITE);
    $z->addFromString('mimetype', 'application/vnd.oasis.opendocument.' . $k);
    $z->setCompressionName('mimetype', ZipArchive::CM_STORE);
    $z->addFromString('content.xml', '<x/>');
    $z->close();
}
copy($root . '/scripts/fixtures/ole_sample.xls', $F['xls'] = "$fx/a.xls");
copy($root . '/scripts/fixtures/ole_sample.xls', $F['doc'] = "$fx/a.doc");
copy($root . '/scripts/fixtures/ole_sample.xls', $F['ppt'] = "$fx/a.ppt");
file_put_contents($F['txt'] = "$fx/a.txt", "Привет, задача\n");
file_put_contents($F['csv'] = "$fx/a.csv", "a;b;c\n1;2;3\n");
file_put_contents($F['rtf'] = "$fx/a.rtf", "{\\rtf1\\ansi hello}");
foreach (['png', 'jpg', 'gif', 'webp'] as $e) {
    fx_img($F[$e] = "$fx/a.$e", $e);
}
copy($F['jpg'], $F['jpeg'] = "$fx/b.jpeg");
file_put_contents($F['heic'] = "$fx/a.heic", "\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" . str_repeat("\0", 64));
copy($F['heic'], $F['heif'] = "$fx/a.heif");
fx_zip($F['zip'] = "$fx/a.zip", ['x.txt' => 'x']);
file_put_contents($F['7z'] = "$fx/a.7z", "7z\xBC\xAF\x27\x1C\x00\x04" . str_repeat("\0", 64));
file_put_contents($F['rar'] = "$fx/a.rar", "Rar!\x1A\x07\x00" . str_repeat("\0", 64));

$run('L3 белый список: все 23 расширения принимаются по своему содержимому', function () use ($F) {
    eq(count(tf_types()), 23, 'число расширений');
    foreach (tf_types() as $ext => $_) {
        ok(isset($F[$ext]), 'нет фикстуры ' . $ext);
        [$err] = tf_check_type('x.' . $ext, $F[$ext]);
        eq($err, null, $ext);
    }
    return '23/23';
});

$run('L4 отказ: не из списка (exe/svg/html/php/js/bat) и подмена содержимого', function () use ($F, $fx) {
    foreach (['exe', 'svg', 'html', 'php', 'js', 'bat', 'msi', 'sh', 'docm', ''] as $e) {
        [$err] = tf_check_type('x' . ($e !== '' ? '.' . $e : ''), $F['txt']);
        eq($err, 'unsupported_format', 'ext ' . $e);
    }
    file_put_contents("$fx/h.txt", "<html><body><script>alert(1)</script></body></html>");
    $cases = [['x.pdf', $F['png']], ['x.png', $F['pdf']], ['x.txt', "$fx/h.txt"], ['x.docx', $F['txt']], ['x.zip', $F['rar']],
        ['x.heic', $F['txt']], ['x.xls', $F['zip']], ['x.jpg', $F['gif']]];
    foreach ($cases as [$n, $p]) {
        [$err] = tf_check_type($n, $p);
        eq($err, 'content_mismatch', $n . ' ← ' . basename($p));
    }
    return '10 + ' . count($cases);
});

// ---------------------------------------------------------------- HTTP
foreach ([['tf_a', 'Файлов Альфа']] as [$i, $n]) {
    $pdo->prepare("INSERT OR IGNORE INTO employees (id, full_name, location, sort_order) VALUES (:i, :n, 'QA', 0)")->execute([':i' => $i, ':n' => $n]);
}
function free_port(): int
{
    for ($a = 0; $a < 20; $a++) {
        $c = 19100 + random_int(0, 380);
        $fp = @fsockopen('127.0.0.1', $c, $e1, $e2, 0.2);
        if ($fp) { fclose($fp); continue; }
        return $c;
    }
    throw new RuntimeException('no port');
}
function start_srv(string $root, string $db, int $port, string $log, array $ini)
{
    $env = getenv();
    $env['SC_APP_DB'] = $db;
    unset($env['TASKS_VALIDATE_WEBHOOK_URL']);
    $d = '';
    foreach ($ini as $k => $v) {
        $d .= ' -d ' . $k . '=' . $v;
    }
    $p = proc_open(sprintf('exec php%s -S 127.0.0.1:%d -t %s > %s 2>&1', $d, $port, escapeshellarg($root), escapeshellarg($log)),
        [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $root, $env);
    foreach ($pipes as $x) { fclose($x); }
    for ($i = 0; $i < 50; $i++) {
        usleep(150000);
        $fp = @fsockopen('127.0.0.1', $port, $e1, $e2, 0.2);
        if ($fp) { fclose($fp); return $p; }
    }
    throw new RuntimeException('server did not start');
}
function req(string $m, string $url, array $o = []): array
{
    $ch = curl_init($url);
    $hdr = [];
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 60, CURLOPT_CUSTOMREQUEST => $m, CURLOPT_HEADER => true]);
    if (!empty($o['cookie'])) {
        curl_setopt($ch, CURLOPT_COOKIEJAR, $o['cookie']);
        curl_setopt($ch, CURLOPT_COOKIEFILE, $o['cookie']);
    }
    if (isset($o['file'])) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, ['file' => new CURLFile($o['file'], 'application/octet-stream', $o['name'] ?? basename($o['file']))]);
    } elseif (array_key_exists('body', $o)) {
        $hdr[] = 'Content-Type: application/json';
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($o['body'], JSON_UNESCAPED_UNICODE));
    }
    if ($hdr) {
        curl_setopt($ch, CURLOPT_HTTPHEADER, $hdr);
    }
    $raw = curl_exec($ch);
    if ($raw === false) {
        throw new RuntimeException('curl: ' . curl_error($ch));
    }
    $st = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $hs = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);
    $head = substr((string) $raw, 0, $hs);
    $body = substr((string) $raw, $hs);
    return ['status' => $st, 'head' => $head, 'raw' => $body, 'json' => json_decode($body, true)];
}

$port = free_port();
$log = $work . '/srv.log';
$proc = start_srv($root, $tmpDb, $port, $log, ['upload_max_filesize' => '256M', 'post_max_size' => '256M']);
$port2 = free_port();
while ($port2 === $port) { $port2 = free_port(); }
$proc2 = start_srv($root, $tmpDb, $port2, $work . '/srv2.log', ['upload_max_filesize' => '2M', 'post_max_size' => '8M']);
$B = "http://127.0.0.1:$port";
$B2 = "http://127.0.0.1:$port2";
$ck = ['admin' => "$work/ck_a", 'sup' => "$work/ck_s", 'view' => "$work/ck_v", 'sup2' => "$work/ck_s2"];
$login = function (string $base, string $who, string $u) use ($ck): void {
    $r = req('POST', $base . '/api/login.php', ['cookie' => $ck[$who], 'body' => ['username' => $u, 'password' => 'changeme']]);
    if ($r['status'] !== 200) {
        throw new RuntimeException("login $u: " . $r['status']);
    }
};
$TF = $B . '/api/task_files.php';
$TK = $B . '/api/tasks.php';
$up = fn(string $who, string $taskId, string $file, ?string $name = null, ?string $base = null) =>
    req('POST', ($base ?? $B) . '/api/task_files.php?task_id=' . rawurlencode($taskId), ['cookie' => $ck[$who], 'file' => $file] + ($name !== null ? ['name' => $name] : []));
$as = fn(string $who, string $m, string $url, ?array $body = null) => req($m, $url, ['cookie' => $ck[$who]] + ($body !== null ? ['body' => $body] : []));
$mkTask = function (array $over = []) use ($as, $TK): array {
    $r = $as('admin', 'POST', $TK, $over + ['title' => 'TF-' . bin2hex(random_bytes(3)), 'start_at' => '2031-03-03', 'assignees' => ['tf_a']]);
    if ($r['status'] !== 201) {
        throw new RuntimeException('mk: ' . $r['status'] . ' ' . substr($r['raw'], 0, 200));
    }
    return $r['json']['task'];
};
$filesDir = $work . '/task_files';
$diskCount = fn(): int => is_dir($filesDir) ? count(array_filter(scandir($filesDir), fn($f) => preg_match('/^[0-9a-f]{32}$/', $f))) : 0;
$audit = fn(string $a, string $id): int => (int) $pdo->query("SELECT COUNT(*) FROM audit_log WHERE action = '$a' AND entity_id = " . $pdo->quote($id))->fetchColumn();

try {
    $login($B, 'admin', 'admin');
    $login($B, 'sup', 'supervisor_zone0');
    $login($B, 'view', 'viewer_test');
    $login($B2, 'sup2', 'admin');
    $T1 = $mkTask(['title' => 'Задача с файлами']);
    $t1 = $T1['id'];

    $run('A1 аноним: limits/list/download/upload/delete → 401', function () use ($TF, $t1, $F) {
        foreach ([['GET', '?limits=1'], ['GET', '?task_id=' . $t1], ['GET', '?id=1'], ['DELETE', '?id=1']] as [$m, $q]) {
            eq(req($m, $TF . $q)['status'], 401, "$m $q");
        }
        eq(req('POST', $TF . '?task_id=' . $t1, ['file' => $F['pdf']])['status'], 401, 'POST');
        return '5 → 401';
    });

    $run('A2 лимиты: при PHP 256M (как на проде) — 5 МБ; при upload_max_filesize=2M — 2 МБ (минимум)', function () use ($as, $TF, $B2, $ck) {
        $l = $as('view', 'GET', $TF . '?limits=1')['json']['limits'];
        eq([$l['max_file_bytes'], $l['max_files'], $l['max_total_bytes'], count($l['extensions'])], [5242880, 10, 52428800, 23], 'prod-like');
        $l2 = req('GET', $B2 . '/api/task_files.php?limits=1', ['cookie' => $ck['sup2']])['json']['limits'];
        eq($l2['max_file_bytes'], 2097152, 'min(5M, 2M)');
        return '5242880 / 2097152';
    });

    $run('U1 admin загружает PDF с кириллицей: 201, файл на диске под hex-именем, аудит task.attach, версия задачи не меняется', function () use ($up, $t1, $F, $pdo, $filesDir, $audit, $as, $TK) {
        $v0 = (int) $as('admin', 'GET', $TK . '?id=' . $t1)['json']['task']['version'];
        $r = $up('admin', $t1, $F['pdf']);
        eq($r['status'], 201, 'status ' . $r['raw']);
        $a = $r['json']['attachment'];
        eq([$a['name'], $a['ext'], $a['size'], $a['uploaded_by'], $a['inline']], ['Отчёт.pdf', 'pdf', filesize($F['pdf']), 'admin', true], 'attachment');
        eq(count($r['json']['attachments']), 1, 'list');
        $row = $pdo->query('SELECT * FROM task_attachments WHERE id = ' . (int) $a['id'])->fetch(PDO::FETCH_ASSOC);
        ok((bool) preg_match('/^[0-9a-f]{32}$/', $row['stored_name']), 'stored hex');
        eq(sha1_file($filesDir . '/' . $row['stored_name']), sha1_file($F['pdf']), 'содержимое на диске');
        ok(is_file($filesDir . '/.htaccess') && str_contains((string) file_get_contents($filesDir . '/.htaccess'), 'Require all denied'), '.htaccess-запрет');
        eq($audit('task.attach', $t1), 1, 'audit');
        eq((int) $as('admin', 'GET', $TK . '?id=' . $t1)['json']['task']['version'], $v0, 'version');
        return 'id=' . $a['id'];
    });

    $run('U2 все форматы белого списка проходят через HTTP (23 расширения, по 9 на задачу)', function () use ($up, $mkTask, $F) {
        $n = 0;
        $chunks = array_chunk(array_keys(tf_types()), 9);
        foreach ($chunks as $ch) {
            $t = $mkTask();
            foreach ($ch as $e) {
                $r = $up('admin', $t['id'], $F[$e], 'файл.' . $e);
                eq($r['status'], 201, $e . ' ' . $r['raw']);
                $n++;
            }
        }
        return $n . ' загрузок';
    });

    $run('U3 отказы через HTTP: exe/svg/html → 415 unsupported_format; подмена → 415 content_mismatch; пустой → 400; без поля → 400', function () use ($up, $t1, $F, $fx, $as, $TF, $diskCount) {
        $d0 = $diskCount();
        foreach (['virus.exe', 'pic.svg', 'page.html', 'x.php'] as $n) {
            $r = $up('admin', $t1, $F['txt'], $n);
            eq([$r['status'], $r['json']['error'] ?? null], [415, 'unsupported_format'], $n);
        }
        $r = $up('admin', $t1, $F['png'], 'doc.pdf');
        eq([$r['status'], $r['json']['error'] ?? null], [415, 'content_mismatch'], 'png→pdf');
        file_put_contents("$fx/empty.txt", '');
        $r = $up('admin', $t1, "$fx/empty.txt");
        eq([$r['status'], $r['json']['error'] ?? null], [400, 'empty_file'], 'empty');
        $r = $as('admin', 'POST', $TF . '?task_id=' . $t1, ['x' => 1]);
        eq([$r['status'], $r['json']['error'] ?? null], [400, 'no_file'], 'no file');
        eq($diskCount(), $d0, 'на диске ничего не осталось');
        return 'ok';
    });

    $run('U4 размер: ровно 5 МБ — 201; 5 МБ + 1 байт — 413; при лимите PHP 2M файл 3 МБ — 413 (минимум)', function () use ($up, $mkTask, $fx, $B2) {
        $t = $mkTask();
        $f5 = "$fx/big5.txt";
        file_put_contents($f5, str_repeat("a\n", 5 * 1048576 / 2));
        eq(filesize($f5), 5242880, 'size');
        eq($up('admin', $t['id'], $f5)['status'], 201, '5 МБ');
        $f6 = "$fx/big5p.txt";
        file_put_contents($f6, str_repeat("a\n", 5 * 1048576 / 2) . 'b');
        $r = $up('admin', $t['id'], $f6);
        eq([$r['status'], $r['json']['error'] ?? null, $r['json']['max_file_bytes'] ?? null], [413, 'file_too_large', 5242880], '5 МБ + 1');
        $f3 = "$fx/big3.txt";
        file_put_contents($f3, str_repeat("a\n", 3 * 1048576 / 2));
        $r = $up('sup2', $t['id'], $f3, null, $B2);
        eq([$r['status'], $r['json']['error'] ?? null], [413, 'file_too_large'], '3 МБ при 2M');
        return 'ok';
    });

    $run('U5 квота: 10 файлов — ок, 11-й → 422 too_many_files', function () use ($up, $mkTask, $F) {
        $t = $mkTask();
        for ($i = 1; $i <= 10; $i++) {
            eq($up('admin', $t['id'], $F['txt'], "f$i.txt")['status'], 201, "файл $i");
        }
        $r = $up('admin', $t['id'], $F['txt'], 'f11.txt');
        eq([$r['status'], $r['json']['error'] ?? null, $r['json']['max_files'] ?? null], [422, 'too_many_files', 10], '11-й');
        return 'ok';
    });

    // supervisor: «своя» задача = tasks.created_by = его логин (создавать задачи через API supervisor не может —
    // ставим created_by напрямую в копии БД)
    $T2 = $mkTask(['title' => 'Задача руководителя']);
    $t2 = $T2['id'];
    $pdo->prepare("UPDATE tasks SET created_by = 'supervisor_zone0' WHERE id = :i")->execute([':i' => $t2]);

    $run('R1 прикрепить: viewer → 403; supervisor к чужой задаче → 403; к своей → 201; admin к любой → 201', function () use ($up, $t1, $t2, $F) {
        eq($up('view', $t1, $F['txt'])['status'], 403, 'viewer');
        eq($up('view', $t2, $F['txt'])['status'], 403, 'viewer свою?');
        eq($up('sup', $t1, $F['txt'])['status'], 403, 'supervisor чужая');
        $r = $up('sup', $t2, $F['txt'], 'от руководителя.txt');
        eq($r['status'], 201, 'supervisor своя');
        eq($r['json']['attachment']['uploaded_by'], 'supervisor_zone0', 'uploaded_by');
        eq($up('admin', $t2, $F['png'], 'от админа.png')['status'], 201, 'admin в задачу руководителя');
        return 'ok';
    });

    $run('R2 can_upload в списке: admin true; supervisor true только в своей; viewer false', function () use ($as, $TF, $t1, $t2) {
        eq($as('admin', 'GET', $TF . '?task_id=' . $t1)['json']['can_upload'], true, 'admin');
        eq($as('sup', 'GET', $TF . '?task_id=' . $t1)['json']['can_upload'], false, 'sup чужая');
        eq($as('sup', 'GET', $TF . '?task_id=' . $t2)['json']['can_upload'], true, 'sup своя');
        eq($as('view', 'GET', $TF . '?task_id=' . $t2)['json']['can_upload'], false, 'viewer');
        return 'ok';
    });

    $run('R3 удалить: viewer → 403; supervisor чужой файл в своей задаче → 403; свой → 200 и файл стёрт; admin любой → 200; аудит task.detach', function () use ($as, $TF, $t1, $t2, $filesDir, $pdo, $audit) {
        $list = $as('admin', 'GET', $TF . '?task_id=' . $t2)['json']['attachments'];
        $mine = array_values(array_filter($list, fn($a) => $a['uploaded_by'] === 'supervisor_zone0'))[0];
        $adm = array_values(array_filter($list, fn($a) => $a['uploaded_by'] === 'admin'))[0];
        $l1 = $as('admin', 'GET', $TF . '?task_id=' . $t1)['json']['attachments'][0];
        eq($as('view', 'DELETE', $TF . '?id=' . $mine['id'])['status'], 403, 'viewer');
        eq($as('sup', 'DELETE', $TF . '?id=' . $adm['id'])['status'], 403, 'sup чужой файл');
        eq($as('sup', 'DELETE', $TF . '?id=' . $l1['id'])['status'], 403, 'sup файл в чужой задаче');
        $stored = $pdo->query('SELECT stored_name FROM task_attachments WHERE id = ' . (int) $mine['id'])->fetchColumn();
        $r = $as('sup', 'DELETE', $TF . '?id=' . $mine['id']);
        eq($r['status'], 200, 'sup свой');
        ok(!is_file($filesDir . '/' . $stored), 'файл удалён с диска');
        eq(count($r['json']['attachments']), 1, 'остался файл админа');
        eq($as('admin', 'DELETE', $TF . '?id=' . $adm['id'])['status'], 200, 'admin');
        eq($as('admin', 'DELETE', $TF . '?id=' . $adm['id'])['status'], 404, 'повтор → 404');
        eq($audit('task.detach', $t2), 2, 'audit');
        return 'ok';
    });

    $run('D1 скачивание: viewer получает тот же файл; attachment + filename* (UTF-8); nosniff', function () use ($as, $TF, $t1, $F) {
        $a = $as('view', 'GET', $TF . '?task_id=' . $t1)['json']['attachments'][0];
        $r = $as('view', 'GET', $TF . '?id=' . $a['id']);
        eq($r['status'], 200, 'status');
        eq(sha1($r['raw']), sha1_file($F['pdf']), 'содержимое');
        ok((bool) preg_match('/Content-Disposition: attachment; filename="[^"]*"; filename\*=UTF-8\'\'' . preg_quote(rawurlencode('Отчёт.pdf'), '/') . '/i', $r['head']), 'disposition: ' . $r['head']);
        ok(stripos($r['head'], 'X-Content-Type-Options: nosniff') !== false, 'nosniff');
        ok(stripos($r['head'], 'Content-Type: application/pdf') !== false, 'ctype');
        return 'ok';
    });

    $run('D2 inline=1: PDF/картинка — inline (картинка с CSP sandbox); docx/txt — всё равно attachment', function () use ($as, $TF, $up, $mkTask, $F) {
        $t = $mkTask();
        $ids = [];
        foreach (['png', 'docx', 'txt'] as $e) {
            $ids[$e] = $up('admin', $t['id'], $F[$e], 'f.' . $e)['json']['attachment']['id'];
        }
        $r = $as('view', 'GET', $TF . '?inline=1&id=' . $ids['png']);
        ok(stripos($r['head'], 'Content-Disposition: inline') !== false, 'png inline');
        ok(stripos($r['head'], 'sandbox') !== false, 'png CSP');
        foreach (['docx', 'txt'] as $e) {
            $r = $as('view', 'GET', $TF . '?inline=1&id=' . $ids[$e]);
            ok(stripos($r['head'], 'Content-Disposition: attachment') !== false, $e . ' attachment');
        }
        return 'ok';
    });

    $run('D3 нет утечек: id не число/не существует → 404; файл с именем ../../ сохраняется как basename; lib напрямую → 404', function () use ($as, $TF, $up, $t1, $F, $B) {
        eq($as('view', 'GET', $TF . '?id=../../data/app.db')['status'], 404, 'traversal id');
        eq($as('view', 'GET', $TF . '?id=999999')['status'], 404, 'нет id');
        $r = $up('admin', $t1, $F['txt'], '../../etc/passwd.txt');
        eq($r['json']['attachment']['name'], 'passwd.txt', 'basename');
        eq(req('GET', $B . '/api/task_files_lib.php')['status'], 404, 'lib direct');
        ok(strpos($as('admin', 'POST', $TF . '?task_id=nope', ['x' => 1])['raw'], '/home/') === false, 'нет путей');
        return 'ok';
    });

    $run('T1 api/tasks.php: attachments в карточке и в списке (поля id,name,ext,size,uploaded_by,uploaded_at,inline)', function () use ($as, $TK, $t1) {
        $c = $as('view', 'GET', $TK . '?id=' . $t1)['json']['task'];
        ok(count($c['attachments']) >= 2, 'card');
        eq(array_keys($c['attachments'][0]), ['id', 'task_id', 'name', 'ext', 'size', 'uploaded_by', 'uploaded_at', 'inline'], 'fields');
        $l = $as('view', 'GET', $TK . '?from=2031-03-01&to=2031-03-31')['json']['tasks'];
        $x = array_values(array_filter($l, fn($t) => $t['id'] === $t1))[0];
        eq(count($x['attachments']), count($c['attachments']), 'list');
        return count($c['attachments']) . ' вложений';
    });

    $run('AR1 архивация удаляет вложения с сервера: записи и файлы, аудит attachments_deleted; потом загрузка → 409', function () use ($as, $TK, $TF, $up, $mkTask, $F, $pdo, $filesDir) {
        $t = $mkTask();
        $up('admin', $t['id'], $F['pdf'], 'a.pdf');
        $up('admin', $t['id'], $F['png'], 'b.png');
        $stored = $pdo->query('SELECT stored_name FROM task_attachments WHERE task_id = ' . $pdo->quote($t['id']))->fetchAll(PDO::FETCH_COLUMN);
        eq(count($stored), 2, 'до');
        $r = $as('admin', 'DELETE', $TK . '?id=' . $t['id']);
        eq($r['status'], 200, 'archive');
        eq($r['json']['task']['attachments'], [], 'в ответе пусто');
        eq((int) $pdo->query('SELECT COUNT(*) FROM task_attachments WHERE task_id = ' . $pdo->quote($t['id']))->fetchColumn(), 0, 'rows');
        foreach ($stored as $s) {
            ok(!is_file($filesDir . '/' . $s), 'файл остался: ' . $s);
        }
        $d = json_decode((string) $pdo->query("SELECT details FROM audit_log WHERE action='task.archive' AND entity_id = " . $pdo->quote($t['id']))->fetchColumn(), true);
        eq($d['attachments_deleted'] ?? null, ['a.pdf', 'b.png'], 'audit');
        eq($up('admin', $t['id'], $F['txt'])['status'], 409, 'upload в архивную');
        return 'ok';
    });

    $run('AR2 архивация задачи без вложений — как раньше (в аудите нет attachments_deleted)', function () use ($as, $TK, $mkTask, $pdo) {
        $t = $mkTask();
        eq($as('admin', 'DELETE', $TK . '?id=' . $t['id'])['status'], 200, 'archive');
        $d = json_decode((string) $pdo->query("SELECT details FROM audit_log WHERE action='task.archive' AND entity_id = " . $pdo->quote($t['id']))->fetchColumn(), true);
        ok(!array_key_exists('attachments_deleted', $d), 'нет ключа');
        return 'ok';
    });

    $run('X1 файлы на диске = записи в БД (нет сирот после отказов, удалений и архивации)', function () use ($pdo, $diskCount) {
        eq($diskCount(), (int) $pdo->query('SELECT COUNT(*) FROM task_attachments')->fetchColumn(), 'disk = db');
        return $diskCount() . ' файлов';
    });
} finally {
    proc_terminate($proc);
    proc_terminate($proc2);
}

unset($pdo, $db);
exec('rm -rf ' . escapeshellarg($work));
$intact = (is_file($realDb) ? sha1_file($realDb) : '') === $realDbHashBefore
    && (is_dir($root . '/data/task_files') ? count(scandir($root . '/data/task_files')) : -1) === $realFilesBefore;
out('=== RESULTS: ' . $passed . ' passed, ' . $failed . ' failed out of ' . ($passed + $failed) . ' ===');
out('DB intact: ' . ($intact ? 'YES' : 'NO'));
exit(($failed === 0 && $intact) ? 0 : 1);
