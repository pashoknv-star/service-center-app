<?php

declare(strict_types=1);

// Служебный CLI-скрипт — под веб-SAPI отвечаем 404 и ничего не исполняем.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

/**
 * n8n_compare.php — сверка РЕАЛЬНОГО n8n (tasks-validate / tasks-recheck) с PHP-эталоном tasks_rules.php (T1-4, п.5).
 *
 * Usage:  php scripts/n8n_compare.php [--md=путь_к_таблице.md]
 *
 * Требует TASKS_VALIDATE_WEBHOOK_URL / TASKS_RECHECK_WEBHOOK_URL / TASKS_N8N_WEBHOOK_SECRET в окружении
 * или в ~/.config/service-center-app/dev.env (значения НЕ печатаются). Работает на временной копии БД
 * (SC_APP_DB), data/app.db не трогает. Данные — синтетические (ПДн нет).
 * Exit 0 — расхождений 0; exit 1 — есть расхождения/сбои; exit 2 — n8n не настроен.
 *
 * Не входит в verify_all.sh (нужен живой n8n; gate обязан проходить без сети).
 */

$root = realpath(__DIR__ . '/..');
$realDb = $root . '/data/app.db';
$hashBefore = sha1_file($realDb);

// --- конфиг n8n: окружение → dev.env (без вывода значений) -------------------
$cfgKeys = ['TASKS_VALIDATE_WEBHOOK_URL', 'TASKS_RECHECK_WEBHOOK_URL', 'TASKS_N8N_WEBHOOK_SECRET'];
$devEnv = (getenv('HOME') ?: '') . '/.config/service-center-app/dev.env';
$cfg = [];
foreach ($cfgKeys as $k) {
    $v = getenv($k);
    $cfg[$k] = is_string($v) ? trim($v) : '';
}
if (is_file($devEnv)) {
    foreach (file($devEnv, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if ($line[0] === '#' || strpos($line, '=') === false) {
            continue;
        }
        [$k, $v] = explode('=', $line, 2);
        if (in_array($k, $cfgKeys, true) && $cfg[$k] === '') {
            $cfg[$k] = trim($v);
        }
    }
}
foreach ($cfgKeys as $k) {
    if ($cfg[$k] === '') {
        fwrite(STDERR, "n8n не настроен: нет $k (окружение или dev.env)\n");
        exit(2);
    }
    putenv($k);   // приложению эти переменные не нужны: эталон считается чисто на PHP
}
$mdPath = null;
foreach (array_slice($argv, 1) as $a) {
    if (strpos($a, '--md=') === 0) {
        $mdPath = substr($a, 5);
    }
}

$tmpDb = tempnam(sys_get_temp_dir(), 'sc_cmp_db_');
copy($realDb, $tmpDb);
putenv('SC_APP_DB=' . $tmpDb);
$_ENV['SC_APP_DB'] = $tmpDb;
require_once $root . '/api/helpers.php';
require_once $root . '/api/db.php';
require_once $root . '/api/tasks_rules.php';

$db = Database::getInstance();
$pdo = $db->getPDO();
$db->migrate();

// --- фикстуры -----------------------------------------------------------------
$emps = ['cmp_a' => 'Сверка Альфа', 'cmp_b' => 'Сверка Браво', 'cmp_c' => 'Сверка Чарли', 'cmp_d' => 'Сверка Дельта'];
foreach ($emps as $id => $nm) {
    $pdo->prepare("INSERT INTO employees (id, full_name, location, phone, photo_url, sort_order) VALUES (:i, :n, 'QA', '+7 900 000-00-00', 'images/x.jpg', 0)")
        ->execute([':i' => $id, ':n' => $nm]);
}
$entry = function (string $e, string $d, string $s) use ($pdo): void {
    $pdo->prepare("INSERT OR REPLACE INTO schedule_entries (employee_id, date, status, approval_status, version, updated_at) VALUES (:e, :d, :s, 'draft', 1, :t)")
        ->execute([':e' => $e, ':d' => $d, ':s' => $s, ':t' => date('c')]);
};
$range = function (string $e, string $from, string $to, string $s) use ($entry): void {
    foreach (tasks_dates_between($from, $to) as $d) {
        $entry($e, $d, $s);
    }
};
$trip = function (string $e, string $from, string $to) use ($pdo): void {
    $tid = 'trip_cmp_' . bin2hex(random_bytes(3));
    $pdo->prepare("INSERT INTO trips (id, title, status, version, created_by, created_at, updated_at) VALUES (:i, 'cmp trip', 'confirmed', 1, 'cmp', :t, :t)")
        ->execute([':i' => $tid, ':t' => date('c')]);
    $pdo->prepare('INSERT INTO trip_participants (trip_id, employee_id, start_date, end_date) VALUES (:i, :e, :f, :t)')
        ->execute([':i' => $tid, ':e' => $e, ':f' => $from, ':t' => $to]);
};
// A: больничный 2027-03-10..12, затем отпуск 03-20..22, day_off 03-25
$range('cmp_a', '2027-03-10', '2027-03-12', 'sick');
$range('cmp_a', '2027-03-20', '2027-03-22', 'vacation');
$entry('cmp_a', '2027-03-25', 'day_off');
// B: командировка 2027-03-11..15 (по trips), плюс больничный 2027-03-16 (смыкается с командировкой)
$trip('cmp_b', '2027-03-11', '2027-03-15');
$entry('cmp_b', '2027-03-16', 'sick');
// C: только отпуск 2027-05-01..10 (праздники РФ в периоде)
$range('cmp_c', '2027-05-01', '2027-05-10', 'vacation');
// D: два разделённых больничных, «хвост» далеко от периода
$entry('cmp_d', '2027-06-01', 'sick');
$entry('cmp_d', '2027-06-03', 'sick');
$range('cmp_d', '2027-06-04', '2027-06-04', 'trip');
$entry('cmp_d', '2027-12-31', 'sick');

// --- вызов n8n -----------------------------------------------------------------
function n8n_call(string $url, ?string $secret, array $payload): array
{
    $ch = curl_init($url);
    $h = ['Content-Type: application/json', 'Accept: application/json'];
    if ($secret !== null) {
        $h[] = 'X-Tasks-Secret: ' . $secret;
    }
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        CURLOPT_HTTPHEADER => $h, CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10]);
    $t0 = microtime(true);
    $raw = curl_exec($ch);
    $ms = (int) round((microtime(true) - $t0) * 1000);
    $st = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ['status' => $st, 'json' => is_string($raw) ? json_decode($raw, true) : null, 'ms' => $ms, 'bytes' => strlen((string) json_encode($payload))];
}
$VURL = $cfg['TASKS_VALIDATE_WEBHOOK_URL'];
$RURL = $cfg['TASKS_RECHECK_WEBHOOK_URL'];
$SEC = $cfg['TASKS_N8N_WEBHOOK_SECRET'];

// --- кейсы tasks-validate ---------------------------------------------------------
$cases = [
    ['V01 выходной (Сб-Вс) — допустимо',            ['cmp_c'], '2027-06-05', '2027-06-06'],
    ['V02 праздничные дни (1-3 мая) — допустимо',    ['cmp_d'], '2027-05-01', '2027-05-03'],
    ['V03 отпуск внутри периода — notes, допустимо', ['cmp_c'], '2027-05-03', '2027-05-07'],
    ['V04 day_off — notes, допустимо',               ['cmp_a'], '2027-03-24', '2027-03-26'],
    ['V05 sick — блок целиком',                      ['cmp_a'], '2027-03-10', '2027-03-12'],
    ['V06 trip (из trips) — блок',                   ['cmp_b'], '2027-03-12', '2027-03-12'],
    ['V07 частичное пересечение (хвост sick)',       ['cmp_a'], '2027-03-08', '2027-03-11'],
    ['V08 частичное пересечение (начало sick)',      ['cmp_a'], '2027-03-12', '2027-03-18'],
    ['V09 trip+sick подряд — suggested_start за обоими', ['cmp_b'], '2027-03-10', '2027-03-13'],
    ['V10 несколько исполнителей: sick+trip',        ['cmp_a', 'cmp_b'], '2027-03-09', '2027-03-14'],
    ['V11 4 исполнителя, период со всем сразу',      ['cmp_a', 'cmp_b', 'cmp_c', 'cmp_d'], '2027-03-08', '2027-03-26'],
    ['V12 suggested_start в «хвосте» за to',         ['cmp_d'], '2027-06-01', '2027-06-02'],
    ['V13 sick 06-01, ok 06-02, sick 06-03, trip 06-04', ['cmp_d'], '2027-06-01', '2027-06-04'],
    ['V14 день вне блоков — чисто',                  ['cmp_a', 'cmp_d'], '2027-08-02', '2027-08-06'],
    ['V15 один день, на sick',                       ['cmp_d'], '2027-12-31', '2027-12-31'],
    ['V16 максимальный период 366 дн.',              ['cmp_a', 'cmp_b', 'cmp_c', 'cmp_d'], '2027-01-01', '2028-01-01'],
    ['V17 дубли исполнителей',                       ['cmp_a', 'cmp_a'], '2027-03-10', '2027-03-11'],
    ['V18 исполнитель без записей',                  ['cmp_none'], '2027-03-10', '2027-03-12'],
];

$rows = [];
$diffs = 0;
$maxMs = 0;
foreach ($cases as [$label, $ids, $from, $to]) {
    $php = tasks_check_period($pdo, $ids, $from, $to);
    $uids = array_values(array_unique($ids));
    $facts = tasks_n8n_validate_facts($pdo, $uids, $php['first_day'], $php['last_day']);
    $r = n8n_call($VURL, $SEC, ['employee_ids' => $ids, 'from' => $from, 'to' => $to, 'facts' => (object) $facts]);
    $maxMs = max($maxMs, $r['ms']);
    $expect = ['blocked_days' => $php['blocked_days'], 'notes' => $php['notes'], 'suggested_start' => $php['suggested_start']];
    $got = $r['status'] === 200 && is_array($r['json']) ? tasks_n8n_normalize_verdict($r['json']) : null;
    $same = $got !== null && $got === $expect;
    if (!$same) {
        $diffs++;
    }
    $rows[] = [$label, count($uids) . ' исп.', "$from..$to",
        count($php['blocked_days']) . '/' . count($php['notes']) . '/' . ($php['suggested_start'] ?? '—'),
        $got === null ? 'HTTP ' . $r['status'] : count($got['blocked_days']) . '/' . count($got['notes']) . '/' . ($got['suggested_start'] ?? '—'),
        $r['ms'] . ' мс', $same ? 'совпало' : 'РАСХОЖДЕНИЕ'];
    if (!$same) {
        fwrite(STDERR, "DIFF $label\n  php=" . json_encode($expect, JSON_UNESCAPED_UNICODE) . "\n  n8n=" . json_encode($r['json'], JSON_UNESCAPED_UNICODE) . "\n");
    }
}

// --- негативные: валидация входа и защита webhook ----------------------------------------
$neg = [];
$check = function (string $label, bool $okc, string $detail) use (&$neg, &$diffs): void {
    $neg[] = [$label, $detail, $okc ? 'ожидаемо' : 'РАСХОЖДЕНИЕ'];
    if (!$okc) {
        $diffs++;
    }
};
$none = n8n_call($VURL, null, ['employee_ids' => ['cmp_a'], 'from' => '2027-03-10', 'to' => '2027-03-10', 'facts' => (object) []]);
$check('N01 без заголовка-секрета', $none['status'] === 403, 'HTTP ' . $none['status']);
$bad = n8n_call($VURL, 'wrong-secret', ['employee_ids' => ['cmp_a'], 'from' => '2027-03-10', 'to' => '2027-03-10', 'facts' => (object) []]);
$check('N02 неверный секрет', $bad['status'] === 403, 'HTTP ' . $bad['status']);
$noneR = n8n_call($RURL, null, ['tasks' => [], 'facts' => (object) []]);
$check('N03 recheck без секрета', $noneR['status'] === 403, 'HTTP ' . $noneR['status']);
foreach ([
    'N04 from > to (PHP: end_before_start)'       => ['employee_ids' => ['cmp_a'], 'from' => '2027-03-12', 'to' => '2027-03-10', 'facts' => (object) []],
    'N05 период 367 дн. (PHP: period_too_long)'   => ['employee_ids' => ['cmp_a'], 'from' => '2027-01-01', 'to' => '2028-01-02', 'facts' => (object) []],
    'N06 пустой employee_ids'                     => ['employee_ids' => [], 'from' => '2027-03-10', 'to' => '2027-03-10', 'facts' => (object) []],
    'N07 невалидная дата 2027-02-30'              => ['employee_ids' => ['cmp_a'], 'from' => '2027-02-30', 'to' => '2027-03-01', 'facts' => (object) []],
    'N08 facts не объект'                         => ['employee_ids' => ['cmp_a'], 'from' => '2027-03-10', 'to' => '2027-03-10', 'facts' => 'x'],
] as $label => $payload) {
    $r = n8n_call($VURL, $SEC, $payload);
    $check($label, $r['status'] === 400 && is_string($r['json']['error'] ?? null), 'HTTP ' . $r['status'] . ' ' . json_encode($r['json']['error'] ?? null));
}
// PHP на те же входы тоже отвергает
$check('N04/N05 PHP-эталон отвергает так же',
    isset(tasks_check_period($pdo, ['cmp_a'], '2027-03-12', '2027-03-10')['error']) && isset(tasks_check_period($pdo, ['cmp_a'], '2027-01-01', '2028-01-02')['error']), 'error');

// --- tasks-recheck: пакетом -------------------------------------------------------------
$tasks = [
    ['id' => 't_ok_weekend', 'employee_ids' => ['cmp_c'], 'from' => '2027-06-05', 'to' => '2027-06-06'],
    ['id' => 't_sick', 'employee_ids' => ['cmp_a'], 'from' => '2027-03-08', 'to' => '2027-03-11'],
    ['id' => 't_trip', 'employee_ids' => ['cmp_b'], 'from' => '2027-03-14', 'to' => '2027-03-18'],
    ['id' => 't_multi', 'employee_ids' => ['cmp_a', 'cmp_b', 'cmp_d'], 'from' => '2027-03-01', 'to' => '2027-03-31'],
    ['id' => 't_vac', 'employee_ids' => ['cmp_c'], 'from' => '2027-05-03', 'to' => '2027-05-07'],
    ['id' => 't_clean', 'employee_ids' => ['cmp_a', 'cmp_d'], 'from' => '2027-08-02', 'to' => '2027-08-06'],
    ['id' => 't_tail', 'employee_ids' => ['cmp_d'], 'from' => '2027-12-31', 'to' => '2027-12-31'],
];
$allIds = array_values(array_unique(array_merge(...array_column($tasks, 'employee_ids'))));
$min = min(array_column($tasks, 'from'));
$max = max(array_column($tasks, 'to'));
$matrix = tasks_matrix_facts($pdo, $allIds, $min, $max);
$sparse = tasks_sparse_rows_from_matrix($pdo, $matrix, $min, $max);
$rr = n8n_call($RURL, $SEC, ['tasks' => $tasks, 'facts' => (object) $sparse]);
$maxMs = max($maxMs, $rr['ms']);
$rrows = [];
$byId = [];
foreach (($rr['json']['results'] ?? []) as $res) {
    $byId[$res['id']] = $res;
}
if ($rr['status'] !== 200 || count($byId) !== count($tasks)) {
    $diffs++;
    fwrite(STDERR, 'recheck: HTTP ' . $rr['status'] . ', results ' . count($byId) . "\n");
}
foreach ($tasks as $t) {
    $php = array_values(array_filter(tasks_blocked_from_facts($matrix, $t['from'], $t['to']), fn($x) => in_array($x['employee_id'], $t['employee_ids'], true)));
    $n = $byId[$t['id']] ?? null;
    $same = $n !== null && ($n['conflict'] ?? null) === ($php !== []) && ($n['blocked_days'] ?? null) === $php;
    if (!$same) {
        $diffs++;
        fwrite(STDERR, 'DIFF recheck ' . $t['id'] . ' n8n=' . json_encode($n) . ' php=' . json_encode($php) . "\n");
    }
    $rrows[] = [$t['id'], count($t['employee_ids']) . ' исп.', $t['from'] . '..' . $t['to'],
        ($php !== [] ? 'conflict' : 'ok') . '/' . count($php), $n === null ? '—' : (($n['conflict'] ? 'conflict' : 'ok') . '/' . count($n['blocked_days'] ?? [])),
        $same ? 'совпало' : 'РАСХОЖДЕНИЕ'];
}
// recheck: некорректная задача в пакете → error только по ней, остальные не страдают
$mix = n8n_call($RURL, $SEC, ['tasks' => [['id' => 'bad', 'employee_ids' => [], 'from' => '2027-03-01', 'to' => '2027-03-02'], $tasks[1]], 'facts' => (object) $sparse]);
$mixOk = $mix['status'] === 200 && isset($mix['json']['results'][0]['error']) && ($mix['json']['results'][1]['conflict'] ?? null) === true;
$check('N09 recheck: плохая задача в пакете → error только по ней', $mixOk, 'HTTP ' . $mix['status']);

// --- вывод ---------------------------------------------------------------------------------
$out = [];
$tbl = function (array $head, array $data) use (&$out): void {
    $out[] = '| ' . implode(' | ', $head) . ' |';
    $out[] = '|' . str_repeat('---|', count($head));
    foreach ($data as $r) {
        $out[] = '| ' . implode(' | ', array_map(fn($c) => str_replace('|', '\\|', (string) $c), $r)) . ' |';
    }
};
$out[] = 'tasks-validate: PHP-эталон vs n8n (blocked/notes/suggested_start; значения = число блок-дней / число notes / suggested_start)';
$out[] = '';
$tbl(['Кейс', 'Исполнители', 'Период', 'PHP', 'n8n', 'Время', 'Итог'], $rows);
$out[] = '';
$out[] = 'tasks-recheck: пакет из ' . count($tasks) . ' задач (conflict / число блок-дней)';
$out[] = '';
$tbl(['Задача', 'Исполнители', 'Период', 'PHP', 'n8n', 'Итог'], $rrows);
$out[] = '';
$out[] = 'Негативные кейсы и защита webhook';
$out[] = '';
$tbl(['Кейс', 'Ответ', 'Итог'], $neg);
$out[] = '';
$out[] = sprintf('Всего кейсов: validate %d, recheck %d, негативных %d. Макс. время ответа n8n: %d мс (лимит 3000). РАСХОЖДЕНИЙ: %d',
    count($rows), count($rrows), count($neg), $maxMs, $diffs);
$text = implode("\n", $out) . "\n";
echo $text;
if ($mdPath !== null) {
    file_put_contents($mdPath, $text);
}
if ($maxMs > 3000) {
    fwrite(STDERR, "ВНИМАНИЕ: ответ n8n > 3 с\n");
}

@unlink($tmpDb);
$intact = sha1_file($realDb) === $hashBefore;
echo 'DB intact: ' . ($intact ? 'YES' : 'NO') . PHP_EOL;
exit($diffs === 0 && $intact && $maxMs <= 3000 ? 0 : 1);
