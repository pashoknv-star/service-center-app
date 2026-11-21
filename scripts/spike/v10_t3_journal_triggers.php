<?php

declare(strict_types=1);

/**
 * V10-T3 (ADR_DB, §5) — достаточно ли триггеров BEFORE UPDATE/DELETE → RAISE(ABORT) для «правка и удаление запрещены».
 * ОДНОРАЗОВЫЙ скрипт, в gate не входит. Работает на временной БД в $TMPDIR (data/app.db не открывается вообще).
 * DDL журнала и триггеров — дословно из reports/V10/specs/CONTRACT.md:41.
 *
 * Запуск:  php scripts/spike/v10_t3_journal_triggers.php
 * Каждая строка вывода: [OK-блок|ОБХОД] проба → фактический результат SQLite.
 */

$tmp = (getenv('TMPDIR') ?: sys_get_temp_dir()) . '/v10_t3';
@mkdir($tmp, 0775, true);

function jt_new(string $tmp, string $name, bool $withInsertGuard = false): PDO
{
    $f = "$tmp/$name.db";
    foreach (['', '-wal', '-shm'] as $s) {
        @unlink($f . $s);
    }
    $pdo = new PDO('sqlite:' . $f, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('CREATE TABLE transport_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, role TEXT, action TEXT, entity_type TEXT, entity_id TEXT,
        before_json TEXT, after_json TEXT, warnings_json TEXT)');
    $pdo->exec('CREATE INDEX idx_tj_ts ON transport_journal (ts)');
    $pdo->exec('CREATE INDEX idx_tj_entity ON transport_journal (entity_type, entity_id)');
    $pdo->exec("CREATE TRIGGER transport_journal_no_update BEFORE UPDATE ON transport_journal BEGIN SELECT RAISE(ABORT, 'transport_journal is append-only'); END");
    $pdo->exec("CREATE TRIGGER transport_journal_no_delete BEFORE DELETE ON transport_journal BEGIN SELECT RAISE(ABORT, 'transport_journal is append-only'); END");
    if ($withInsertGuard) {
        // усиление: явная вставка уже существующего id (INSERT OR REPLACE / REPLACE INTO) запрещена
        $pdo->exec("CREATE TRIGGER transport_journal_no_replace BEFORE INSERT ON transport_journal
            WHEN NEW.id IS NOT NULL AND EXISTS (SELECT 1 FROM transport_journal WHERE id = NEW.id)
            BEGIN SELECT RAISE(ABORT, 'transport_journal is append-only'); END");
    }
    $pdo->exec("INSERT INTO transport_journal (ts, actor, role, action, entity_type, entity_id, after_json)
        VALUES ('2026-12-01T08:00:00+00:00', 'admin', 'admin', 'vehicle.move', 'vehicle', '1', '{\"base_id\":2}')");
    $pdo->exec("INSERT INTO transport_journal (ts, actor, role, action, entity_type, entity_id, after_json)
        VALUES ('2026-12-01T08:05:00+00:00', 'admin', 'admin', 'vehicle.move', 'vehicle', '2', '{\"base_id\":1}')");
    return $pdo;
}

function jt_snap(PDO $pdo): string
{
    try {
        return (string) $pdo->query('SELECT COUNT(*) || \'/\' || IFNULL(SUM(length(IFNULL(after_json,\'\'))),0) || \'/\' || IFNULL(MIN(ts),\'\') FROM transport_journal')->fetchColumn();
    } catch (Throwable $e) {
        return 'таблицы нет';
    }
}

function jt_try(PDO $pdo, string $label, string $sql, string $kind = 'expect-block'): void
{
    $before = jt_snap($pdo);
    try {
        $n = $pdo->exec($sql);
        $res = "ВЫПОЛНЕНО (затронуто строк: $n)";
        $verdict = $kind === 'expect-ok' ? 'OK-штат' : 'ОБХОД';
    } catch (Throwable $e) {
        $res = 'ОШИБКА: ' . $e->getMessage();
        $verdict = 'OK-блок';
    }
    $after = jt_snap($pdo);
    printf("[%-7s] %-62s → %s   (строк/сумма длин after_json/min(ts): %s → %s)\n", $verdict, $label, $res, $before, $after);
}

echo 'php=' . PHP_VERSION . ' sqlite=' . (new PDO('sqlite::memory:'))->query('SELECT sqlite_version()')->fetchColumn() . "\n";
echo "== A. журнал по CONTRACT.md:41 (только BEFORE UPDATE и BEFORE DELETE), recursive_triggers=OFF (умолчание, как в api/db.php:723-726)\n";
$p = jt_new($tmp, 'jt_a');
jt_try($p, 'UPDATE одной записи', "UPDATE transport_journal SET after_json = '{}' WHERE id = 1");
jt_try($p, 'UPDATE всех записей (без WHERE)', "UPDATE transport_journal SET actor = 'x'");
jt_try($p, 'DELETE одной записи', 'DELETE FROM transport_journal WHERE id = 1');
jt_try($p, 'DELETE всех записей (без WHERE, «truncate optimization»)', 'DELETE FROM transport_journal');
jt_try($p, 'INSERT … ON CONFLICT(id) DO UPDATE (upsert = UPDATE)', "INSERT INTO transport_journal (id, ts, actor) VALUES (1, 'x', 'x') ON CONFLICT(id) DO UPDATE SET actor = 'x'");
jt_try($p, 'UPDATE OR REPLACE', "UPDATE OR REPLACE transport_journal SET id = 2 WHERE id = 1");
jt_try($p, 'INSERT OR REPLACE с существующим id (правка записи)', "INSERT OR REPLACE INTO transport_journal (id, ts, actor, after_json) VALUES (1, 'FORGED', 'x', '{}')");
jt_try($p, 'REPLACE INTO с существующим id', "REPLACE INTO transport_journal (id, ts, actor, after_json) VALUES (2, 'FORGED2', 'x', '{}')");
echo "   → после проб REPLACE: " . json_encode($p->query('SELECT id, ts, actor FROM transport_journal ORDER BY id')->fetchAll(PDO::FETCH_NUM), JSON_UNESCAPED_UNICODE) . "\n";

echo "== B. то же при PRAGMA recursive_triggers = ON (проверка: помогает ли это)\n";
$p = jt_new($tmp, 'jt_b');
$p->exec('PRAGMA recursive_triggers = ON');
jt_try($p, 'INSERT OR REPLACE с существующим id (recursive_triggers=ON)', "INSERT OR REPLACE INTO transport_journal (id, ts, actor, after_json) VALUES (1, 'FORGED', 'x', '{}')");

echo "== C. усиление: + BEFORE INSERT … WHEN NEW.id уже существует → RAISE(ABORT)\n";
$p = jt_new($tmp, 'jt_c', true);
jt_try($p, 'INSERT OR REPLACE с существующим id', "INSERT OR REPLACE INTO transport_journal (id, ts, actor, after_json) VALUES (1, 'FORGED', 'x', '{}')");
jt_try($p, 'REPLACE INTO с существующим id', "REPLACE INTO transport_journal (id, ts, actor, after_json) VALUES (2, 'FORGED2', 'x', '{}')");
jt_try($p, 'обычная вставка без id (штатная запись журнала)', "INSERT INTO transport_journal (ts, actor, action) VALUES ('2026-12-01T09:00:00+00:00', 'admin', 'vehicle.move')", 'expect-ok');


echo "== D. остаточные способы обхода (триггеры — часть схемы БД, пользователь с правом записи в файл может её менять)\n";
$p = jt_new($tmp, 'jt_d1');
jt_try($p, 'DROP TRIGGER no_update → затем UPDATE', 'DROP TRIGGER transport_journal_no_update');
jt_try($p, '   … UPDATE после DROP TRIGGER', "UPDATE transport_journal SET after_json = 'FORGED' WHERE id = 1");
$p = jt_new($tmp, 'jt_d2');
jt_try($p, 'DROP TRIGGER no_delete → затем DELETE', 'DROP TRIGGER transport_journal_no_delete');
jt_try($p, '   … DELETE после DROP TRIGGER', 'DELETE FROM transport_journal');
$p = jt_new($tmp, 'jt_d3');
jt_try($p, 'DROP TABLE transport_journal (триггеры DELETE не срабатывают)', 'DROP TABLE transport_journal');
$p = jt_new($tmp, 'jt_d4');
jt_try($p, 'ALTER TABLE … RENAME (подмена таблицы)', 'ALTER TABLE transport_journal RENAME TO transport_journal_old');
$p = jt_new($tmp, 'jt_d5');
jt_try($p, 'PRAGMA writable_schema=ON + DELETE FROM sqlite_master (триггеры)', "PRAGMA writable_schema = ON");
try {
    $p->exec("DELETE FROM sqlite_master WHERE type = 'trigger'");
    echo "[ОБХОД  ] DELETE FROM sqlite_master WHERE type='trigger' → выполнено (SQLite 3.45 без SQLITE_DBCONFIG_DEFENSIVE)\n";
} catch (Throwable $e) {
    echo '[OK-блок] DELETE FROM sqlite_master → ' . $e->getMessage() . "\n";
}
echo "== E. прямой доступ к файлу: sqlite3-CLI и любой другой клиент SQLite ВИДИТ триггеры (они в схеме файла) — проверка\n";
$f = "$tmp/jt_a.db";
$out = trim((string) shell_exec('sqlite3 ' . escapeshellarg($f) . ' "UPDATE transport_journal SET actor=\'cli\' WHERE id=2;" 2>&1'));
echo '[CLI    ] sqlite3 file "UPDATE …" → ' . ($out === '' ? 'ВЫПОЛНЕНО' : $out) . "\n";
$f2 = "$tmp/jt_d1.db";
$out = trim((string) shell_exec('sqlite3 ' . escapeshellarg($f2) . ' "UPDATE transport_journal SET actor=\'cli\' WHERE id=2;" 2>&1'));
echo '[CLI    ] после DROP TRIGGER (jt_d1.db) sqlite3 file "UPDATE …" → ' . ($out === '' ? 'ВЫПОЛНЕНО (обход)' : $out) . "\n";

echo "== F. ОБНАРУЖЕНИЕ подмены (не предотвращение): цепочка хешей row_hash = sha256(prev_hash | ts | actor | action | entity | after_json)\n";
$hashOf = fn(string $prev, array $r): string => hash('sha256', $prev . '|' . implode('|', [$r['ts'], $r['actor'], $r['action'], $r['entity_type'], $r['entity_id'], $r['after_json']]));
$mkChain = function (string $name) use ($tmp, $hashOf): PDO {
    $f = "$tmp/$name.db";
    foreach (['', '-wal', '-shm'] as $s) {
        @unlink($f . $s);
    }
    $p = new PDO('sqlite:' . $f, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $p->exec('CREATE TABLE transport_journal (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, action TEXT, entity_type TEXT, entity_id TEXT, after_json TEXT, prev_hash TEXT, row_hash TEXT)');
    $p->exec("CREATE TRIGGER transport_journal_no_update BEFORE UPDATE ON transport_journal BEGIN SELECT RAISE(ABORT, 'transport_journal is append-only'); END");
    $p->exec("CREATE TRIGGER transport_journal_no_delete BEFORE DELETE ON transport_journal BEGIN SELECT RAISE(ABORT, 'transport_journal is append-only'); END");
    for ($i = 1; $i <= 4; $i++) {
        $r = ['ts' => "2026-12-01T08:0$i:00+00:00", 'actor' => 'admin', 'action' => 'vehicle.move', 'entity_type' => 'vehicle', 'entity_id' => (string) $i, 'after_json' => '{"base_id":' . $i . '}'];
        $p->exec('BEGIN IMMEDIATE');                                  // хеш предыдущей строки читается в той же транзакции записи
        $prev = (string) ($p->query('SELECT row_hash FROM transport_journal ORDER BY id DESC LIMIT 1')->fetchColumn() ?: str_repeat('0', 64));
        $st = $p->prepare('INSERT INTO transport_journal (ts, actor, action, entity_type, entity_id, after_json, prev_hash, row_hash) VALUES (:ts,:a,:ac,:et,:ei,:aj,:ph,:rh)');
        $st->execute([':ts' => $r['ts'], ':a' => $r['actor'], ':ac' => $r['action'], ':et' => $r['entity_type'], ':ei' => $r['entity_id'], ':aj' => $r['after_json'], ':ph' => $prev, ':rh' => $hashOf($prev, $r)]);
        $p->exec('COMMIT');
    }
    return $p;
};
$verify = function (PDO $pdo) use ($hashOf): string {
    $prev = str_repeat('0', 64);
    $n = 0;
    foreach ($pdo->query('SELECT * FROM transport_journal ORDER BY id')->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $n++;
        if ($r['prev_hash'] !== $prev || $r['row_hash'] !== $hashOf($prev, $r)) {
            return 'НАРУШЕНИЕ цепочки на id=' . $r['id'];
        }
        $prev = $r['row_hash'];
    }
    return "цепочка цела ($n строк)";
};
$p = $mkChain('jt_f1');
echo '   исходная цепочка:                              ' . $verify($p) . "\n";
$p->exec('DROP TRIGGER transport_journal_no_update');
$p->exec("UPDATE transport_journal SET after_json = '{\"base_id\":99}' WHERE id = 2");
echo '   DROP TRIGGER + UPDATE id=2:                    ' . $verify($p) . "\n";
$p = $mkChain('jt_f2');
$p->exec('DROP TRIGGER transport_journal_no_delete');
$p->exec('DELETE FROM transport_journal WHERE id = 3');
echo '   DROP TRIGGER + DELETE id=3 (середина):         ' . $verify($p) . "\n";
$p = $mkChain('jt_f3');
$p->exec('DROP TRIGGER transport_journal_no_delete');
$p->exec('DELETE FROM transport_journal WHERE id = 4');
echo '   DROP TRIGGER + DELETE id=4 (ХВОСТ):            ' . $verify($p) . "  ← хвост цепочка не защищает: нужен внешний якорь (последний row_hash вне файла БД)\n";
