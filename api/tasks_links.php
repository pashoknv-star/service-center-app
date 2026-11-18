<?php

declare(strict_types=1);

/**
 * tasks_links.php — связанные задачи (V9-T1, schema v14).
 *
 * Модель (решения владельца/координатора — reports/V9/specs/00_COMMON.md):
 *  - Один симметричный тип связи. Источник истины связей ИСХОДЯЩЕЙ задачи — токены `((ID|название))` в
 *    tasks.links_text; входящие связи строятся из таблицы task_links (каноническая пара task_a < task_b).
 *  - Токен парсится ТОЛЬКО по ID; название — снимок для читаемости (на сервере не используется).
 *  - Строка task_links существует, пока токен на другую сторону остался хотя бы в одном из двух links_text.
 *  - Самосвязь → 422 link_self; неизвестный ID → 422 link_unknown; НОВАЯ связь на архивную задачу →
 *    409 link_target_archived (существующая сохраняется и читается с archived=1); дубли схлопываются;
 *    ≤ TASKS_LINKS_MAX различных связей → иначе 422 links_too_many.
 *  - close/reopen/DELETE(архив) связей не создают и не меняют.
 *  - Компонент связности (?related) — BFS в PHP, не проходит через архивные задачи, лимит TASKS_RELATED_LIMIT.
 *
 * Функции чтения/записи вызываются из api/tasks.php (там же tasks_fail/tasks_audit); парсер — чистая функция.
 */

const TASKS_LINKS_MAX = 50;          // различных связей на задачу
const TASKS_LINKS_ID_RE = '[A-Za-z0-9_.\-]{1,64}';   // id задач: genId('task_') = uniqid('task_', true) → «task_<13 hex>.<8 цифр>»
const TASKS_RELATED_LIMIT = 200;     // задач в компоненте связности (?related)
const TASKS_PICK_LIMIT = 2000;       // задач в окне выбора (?pick=1)
const TASKS_LINKS_CHUNK = 400;       // размер пачки id в IN (...) — запас под SQLITE_MAX_VARIABLE_NUMBER=999 старых SQLite

/**
 * Токены ((ID|название)) из текста → [['id' => ..., 'title' => ...], ...] в порядке появления,
 * дубли по id схлопываются (побеждает первое вхождение).
 *
 * Не токены (игнорируются, остаются обычным текстом): `(())`, `(( ))`, `((|x))`, ID с недопустимыми символами
 * (пробелы, кириллица, `;`, `/` …) или длиннее 64, название с переводом строки. Название — любые символы
 * до первых `))` (в т.ч. `|` и одиночные скобки): разбор идёт только по ID.
 *
 * @return array<int, array{id: string, title: string}>
 */
function tasks_links_parse(?string $text): array
{
    if ($text === null || $text === '') {
        return [];
    }
    $n = preg_match_all('/\(\(\s*(' . TASKS_LINKS_ID_RE . ')\s*(?:\|([^\r\n]*?))?\)\)/', $text, $m, PREG_SET_ORDER);
    if ($n === false || $n === 0) {
        return [];
    }
    $out = [];
    $seen = [];
    foreach ($m as $t) {
        $id = $t[1];
        if (isset($seen[$id])) {
            continue;
        }
        $seen[$id] = true;
        $out[] = ['id' => $id, 'title' => trim($t[2] ?? '')];
    }
    return $out;
}

/** Каноническая пара (task_a < task_b побайтово — как BINARY-сравнение SQLite; strcmp, а не `<`: «числовые» строки). */
function tasks_links_canon(string $x, string $y): array
{
    return strcmp($x, $y) < 0 ? [$x, $y] : [$y, $x];
}

/** @return string "?,?,?" */
function tasks_links_in(int $n): string
{
    return implode(',', array_fill(0, $n, '?'));
}

/**
 * Краткие данные задач пачкой: id => [id,title,status,archived,start_at].
 *
 * @param string[] $ids
 * @return array<string, array{id: string, title: string, status: string, archived: int, start_at: string}>
 */
function tasks_links_info(PDO $pdo, array $ids): array
{
    $out = [];
    foreach (array_chunk(array_values(array_unique($ids)), TASKS_LINKS_CHUNK) as $chunk) {
        $st = $pdo->prepare('SELECT id, title, status, archived, start_at FROM tasks WHERE id IN (' . tasks_links_in(count($chunk)) . ')');
        $st->execute($chunk);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $out[(string) $r['id']] = [
                'id'       => (string) $r['id'],
                'title'    => (string) $r['title'],
                'status'   => (string) $r['status'],
                'archived' => (int) $r['archived'],
                'start_at' => (string) $r['start_at'],
            ];
        }
    }
    return $out;
}

/**
 * Соседи по таблице: id => [другая сторона => true] (обе стороны пары) для заданных задач.
 *
 * @param string[] $ids
 * @return array<string, array<string, bool>>
 */
function tasks_links_neighbours(PDO $pdo, array $ids): array
{
    $out = [];
    $want = array_flip($ids);
    foreach (array_chunk(array_values(array_unique($ids)), TASKS_LINKS_CHUNK) as $chunk) {
        $in = tasks_links_in(count($chunk));
        $st = $pdo->prepare("SELECT task_a, task_b FROM task_links WHERE task_a IN ($in) OR task_b IN ($in)");
        $st->execute(array_merge($chunk, $chunk));
        foreach ($st->fetchAll(PDO::FETCH_NUM) as [$a, $b]) {
            $a = (string) $a;
            $b = (string) $b;
            if (isset($want[$a])) {
                $out[$a][$b] = true;
            }
            if (isset($want[$b])) {
                $out[$b][$a] = true;
            }
        }
    }
    return $out;
}

/**
 * Проверка токенов ДО записи (чтение, без изменений). Возвращает список различных id целей.
 * Ошибки: link_self / links_too_many (422), link_unknown (422), link_target_archived (409, только для НОВОЙ связи).
 *
 * @param string $selfId id редактируемой задачи ('' при создании — своих связей ещё нет)
 * @return string[]
 */
function tasks_links_validate(PDO $pdo, string $selfId, string $text): array
{
    $ids = array_column(tasks_links_parse($text), 'id');
    if ($selfId !== '' && in_array($selfId, $ids, true)) {
        tasks_fail('link_self', 422, ['link_id' => $selfId, 'message' => 'Задачу нельзя связать саму с собой.']);
    }
    if (count($ids) > TASKS_LINKS_MAX) {
        tasks_fail('links_too_many', 422, ['max' => TASKS_LINKS_MAX, 'message' => 'Не более ' . TASKS_LINKS_MAX . ' связанных задач.']);
    }
    if ($ids === []) {
        return [];
    }
    $info = tasks_links_info($pdo, $ids);
    foreach ($ids as $id) {
        if (!isset($info[$id])) {
            tasks_fail('link_unknown', 422, ['link_id' => $id, 'message' => 'Связанная задача не найдена.']);
        }
    }
    $existing = [];
    if ($selfId !== '') {
        $existing = tasks_links_neighbours($pdo, [$selfId])[$selfId] ?? [];
    }
    foreach ($ids as $id) {
        if ($info[$id]['archived'] === 1 && !isset($existing[$id])) {
            tasks_fail('link_target_archived', 409, ['link_id' => $id, 'message' => 'Нельзя связать с удалённой задачей.']);
        }
    }
    return $ids;
}

/**
 * Пересборка строк task_links задачи $selfId по её новому тексту (внутри транзакции вызывающего).
 * Диф: добавить новые пары, удалить пары, чей токен пропал (если встречный токен другой стороны не держит связь).
 * Вторая сторона получает свежий updated_at (version НЕ меняется — открытая у неё форма не получает ложный конфликт).
 * Аудит: task.link_add / task.link_remove — по записи на каждую фактически созданную/удалённую связь.
 *
 * @param string[] $newIds различные id из tasks_links_validate()
 * @return array{added: string[], removed: string[]}
 */
function tasks_links_apply(PDO $pdo, string $selfId, string $selfTitle, ?string $oldText, array $newIds, string $ts, string $actor): array
{
    $existing = tasks_links_neighbours($pdo, [$selfId])[$selfId] ?? [];
    $added = array_values(array_diff($newIds, array_keys($existing)));

    $removed = [];
    $oldOwn = array_column(tasks_links_parse($oldText), 'id');
    $txtSt = $pdo->prepare('SELECT links_text FROM tasks WHERE id = :id');
    foreach (array_diff($oldOwn, $newIds) as $other) {
        if (!isset($existing[$other])) {
            continue;
        }
        $txtSt->execute([':id' => $other]);
        $otherText = $txtSt->fetchColumn();
        // Связь держит и встречный токен другой стороны — строку не трогаем (направление просто сменится на «входящую»).
        if (in_array($selfId, array_column(tasks_links_parse(is_string($otherText) ? $otherText : null), 'id'), true)) {
            continue;
        }
        $removed[] = $other;
    }

    $ins = $pdo->prepare('INSERT OR IGNORE INTO task_links (task_a, task_b, created_at, created_by) VALUES (:a, :b, :ts, :by)');
    $del = $pdo->prepare('DELETE FROM task_links WHERE task_a = :a AND task_b = :b');
    $touch = $pdo->prepare('UPDATE tasks SET updated_at = :ts WHERE id = :id');
    foreach ($added as $other) {
        [$a, $b] = tasks_links_canon($selfId, $other);
        $ins->execute([':a' => $a, ':b' => $b, ':ts' => $ts, ':by' => $actor]);
        $touch->execute([':ts' => $ts, ':id' => $other]);
        tasks_audit($pdo, 'task.link_add', $selfId, ['title' => $selfTitle, 'target' => $other]);
    }
    foreach ($removed as $other) {
        [$a, $b] = tasks_links_canon($selfId, $other);
        $del->execute([':a' => $a, ':b' => $b]);
        $touch->execute([':ts' => $ts, ':id' => $other]);
        tasks_audit($pdo, 'task.link_remove', $selfId, ['title' => $selfTitle, 'target' => $other]);
    }
    return ['added' => $added, 'removed' => $removed];
}

/**
 * links[] для набора задач пачкой (карточка, строки списка, ?related).
 * Элемент: {id, title, status, archived(0|1), direction: 'out'|'in'}; название/статус — актуальные.
 * 'out' — в links_text ЭТОЙ задачи есть токен на неё (порядок — как в тексте), 'in' — связь держит только другая
 * сторона (по названию). Строки без соседей → [].
 *
 * @param array<int, array<string, mixed>> $rows строки tasks (нужны id и links_text)
 * @return array<string, array<int, array{id: string, title: string, status: string, archived: int, direction: string}>>
 */
function tasks_links_load(PDO $pdo, array $rows): array
{
    $out = [];
    $texts = [];
    foreach ($rows as $r) {
        $id = (string) $r['id'];
        $out[$id] = [];
        $texts[$id] = isset($r['links_text']) && is_string($r['links_text']) ? $r['links_text'] : null;
    }
    if ($out === []) {
        return $out;
    }
    $nb = tasks_links_neighbours($pdo, array_map('strval', array_keys($out)));
    if ($nb === []) {
        return $out;
    }
    $others = [];
    foreach ($nb as $set) {
        foreach ($set as $o => $_) {
            $others[(string) $o] = true;
        }
    }
    $info = tasks_links_info($pdo, array_map('strval', array_keys($others)));
    foreach ($nb as $id => $set) {
        $list = [];
        $done = [];
        foreach (tasks_links_parse($texts[$id] ?? null) as $t) {
            $o = $t['id'];
            if (isset($set[$o]) && isset($info[$o])) {
                $list[] = tasks_links_item($info[$o], 'out');
                $done[$o] = true;
            }
        }
        $in = [];
        foreach ($set as $o => $_) {
            if (!isset($done[$o]) && isset($info[$o])) {
                $in[] = tasks_links_item($info[$o], 'in');
            }
        }
        usort($in, static fn(array $x, array $y): int => strcmp($x['title'], $y['title']) ?: strcmp($x['id'], $y['id']));
        $out[$id] = array_merge($list, $in);
    }
    return $out;
}

/** @param array{id: string, title: string, status: string, archived: int} $i */
function tasks_links_item(array $i, string $direction): array
{
    return [
        'id'        => $i['id'],
        'title'     => $i['title'],
        'status'    => $i['status'],
        'archived'  => $i['archived'],
        'direction' => $direction,
    ];
}

/**
 * Компонент связности задачи (BFS по task_links в обе стороны). Не проходит через архивные задачи и не включает
 * их; ограничение TASKS_RELATED_LIMIT задач (ближайшие по BFS, внутри уровня — по id). Исходная задача — первая,
 * остальные — по start_at (затем id).
 *
 * @return array{ids: string[], truncated: bool}
 */
function tasks_links_component(PDO $pdo, string $startId): array
{
    $seen = [$startId => true];       // посещённые (в т.ч. архивные — чтобы не опрашивать повторно)
    $members = [$startId];
    $frontier = [$startId];
    $truncated = false;
    while ($frontier !== [] && !$truncated) {
        $cand = [];
        foreach (tasks_links_neighbours($pdo, $frontier) as $set) {
            foreach ($set as $o => $_) {
                if (!isset($seen[$o])) {
                    $cand[$o] = true;
                }
            }
        }
        if ($cand === []) {
            break;
        }
        $candIds = array_map('strval', array_keys($cand));
        sort($candIds, SORT_STRING);
        $info = tasks_links_info($pdo, $candIds);
        $frontier = [];
        foreach ($candIds as $o) {
            $seen[$o] = true;
            if (!isset($info[$o]) || $info[$o]['archived'] === 1) {
                continue;
            }
            if (count($members) >= TASKS_RELATED_LIMIT) {
                $truncated = true;
                break;
            }
            $members[] = $o;
            $frontier[] = $o;
        }
    }
    $info = tasks_links_info($pdo, $members);
    $rest = array_values(array_diff($members, [$startId]));
    usort($rest, static fn(string $x, string $y): int => strcmp($info[$x]['start_at'], $info[$y]['start_at']) ?: strcmp($x, $y));
    return ['ids' => array_merge([$startId], $rest), 'truncated' => $truncated];
}
