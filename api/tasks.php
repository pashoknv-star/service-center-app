<?php

declare(strict_types=1);

/**
 * tasks.php — блок «Задачи» (T1-1): CRUD задач, закрытие/переоткрытие, архив,
 * сервисный эндпойнт calendar_facts. Отдельно от save.php (sync-delete НЕ расширяем).
 * Правила (FR-10/11) — api/tasks_rules.php.
 *
 * GET    api/tasks.php?from=&to=&employee_id=   — задачи диапазона (без employee_id — все);
 *                                                  опц.: status=open|closed, include_archived=1
 *                                                  { success, tasks: [...], from, to }
 * GET    api/tasks.php?id=...                    — карточка { success, task }
 * POST   api/tasks.php                           — создать (после проверки FR-10)
 *        body: { title, description?, start_at, end_at?, priority?(1..3, def 2), label?,
 *                assignees: [employee_id,...] (>=1), watchers?: [...], checklist?: [{text,done?}] }
 * PUT    api/tasks.php?id=...                    — править/переназначать; body.version ОБЯЗАТЕЛЕН
 *        (проверка FR-10 — только если изменились срок или исполнители)
 * POST   api/tasks.php?id=...&action=close|reopen — сменить статус (version опционален)
 * POST   api/tasks.php?id=...&action=occ_add|occ_move|occ_delete — повторы задачи (V6.3-2, Д-1; version ОБЯЗАТЕЛЕН):
 *        occ_add {start_at} · occ_move {occurrence_id, start_at} · occ_delete {occurrence_id}
 *        Повторы также в теле create/PUT: occurrences: [{start_at}] (полная замена набора; конец = начало +
 *        длительность задачи). В ответе задачи: occurrences: [{id,start_at,end_at}], next_at; days[] включает дни повторов.
 * DELETE api/tasks.php?id=...                    — архив (archived=1; version опционален)
 * GET    api/tasks.php?calendar_facts&employee_id=a[,b]&from=&to=
 *                                                — факты матрицы для n8n; Authorization: Bearer
 *                                                  <meta.external_api_token> (значение не выводится)
 *
 * Права: запись — только admin (supervisor/viewer → 403, аноним → 401); чтение — все
 * авторизованные. Ошибки: 409 VERSION_CONFLICT, 422 TASK_BLOCKED_BY_SICK_OR_TRIP
 * (blocked_days, suggested_start), 403, 401.
 * Ответы не содержат телефонов/фото (из сотрудника отдаются только id и full_name).
 * Все мутации → audit_log: task.create / task.update / task.close / task.reopen / task.archive.
 * V7: в ответе задачи attachments: [{id,name,ext,size,uploaded_by,uploaded_at,inline}] (запись — api/task_files.php);
 *     DELETE (архив) удаляет вложения задачи с сервера (audit task.archive.details.attachments_deleted).
 * Время — локальное +05, ISO без смещения. check_state: 'ok' | 'pending'
 * (n8n, T1-4: см. tasks_check_period_checked() — вердикт tasks-validate, при недоступности
 * PHP-fallback + 'pending'; перепроверка pending — tasks_recheck_pending() после ответа на чтение списка,
 * не чаще раза в 15 мин). Настройка n8n — только окружение (TASKS_*_WEBHOOK_*, TASKS_N8N_WEBHOOK_SECRET).
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/tasks_rules.php';
require_once __DIR__ . '/task_files_lib.php';   // V7: вложения задач

handleOptions();

const TASKS_TITLE_MAX = 200;
const TASKS_DESC_MAX = 5000;
const TASKS_LABEL_MAX = 200;       // V6.2 (W-4): вся строка тегов «тег1, тег2»
const TASKS_LABEL_TAG_MAX = 30;    // V6.2 (W-4): один тег
const TASKS_CHECK_TEXT_MAX = 300;
const TASKS_CHECK_MAX_ITEMS = 50;
const TASKS_MAX_PEOPLE = 50;
const TASKS_LIST_LIMIT = 2000;
const TASKS_FACTS_MAX_EMPLOYEES = 100;

/** Ошибка с кодом и (опционально) телом. */
function tasks_fail(string $code, int $http = 400, array $extra = []): void
{
    sendJson(array_merge(['error' => $code], $extra), $http);
}

/** Валидная дата 'YYYY-MM-DD'. */
function tasks_valid_ymd(mixed $v): bool
{
    $p = tasks_parse_when($v);
    return $p !== null && $p['time'] === null;
}

/**
 * Отправляет JSON-ответ и ЗАВЕРШАЕТ ответ клиенту (Content-Length + close/fastcgi_finish_request),
 * затем выполняет $after (фоновая работа, напр. tasks-recheck с таймаутом 10 с) и выходит.
 * Ошибки $after не влияют на уже отправленный ответ.
 */
function tasks_send_json_then(array $data, callable $after): void
{
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    http_response_code(200);
    header('Content-Type: application/json; charset=utf-8');
    corsHeaders();
    header('Content-Length: ' . strlen((string) $json));
    header('Connection: close');
    ignore_user_abort(true);
    echo $json;
    while (ob_get_level() > 0) {
        @ob_end_flush();
    }
    flush();
    if (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    }
    try {
        $after();
    } catch (Throwable $e) {
        error_log('[tasks] post-response job failed: ' . $e->getMessage());
    }
    exit;
}

/** Аудит мутации (внутри транзакции; сбой аудита откатывает мутацию). */
function tasks_audit(PDO $pdo, string $action, string $taskId, array $details): void
{
    audit($pdo, $action, null, null, 'task', $taskId, $details);
}

// =====================================================================
// Сервисный токен (calendar_facts)
// =====================================================================

function tasks_require_service_token(PDO $pdo): void
{
    $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
    $provided = '';
    if (preg_match('/^Bearer\s+(.+)$/i', (string) $hdr, $m)) {
        $provided = trim($m[1]);
    } elseif ($hdr !== '') {
        $provided = trim((string) $hdr);
    }
    if ($provided === '') {
        tasks_fail('missing_bearer_token', 401);
    }
    $stmt = $pdo->prepare("SELECT value FROM meta WHERE key = 'external_api_token' LIMIT 1");
    $stmt->execute();
    $stored = $stmt->fetch(PDO::FETCH_COLUMN);
    $stored = is_string($stored) ? $stored : '';
    if ($stored === '' || !hash_equals($stored, $provided)) {
        tasks_fail('invalid_token', 401);
    }
}

// =====================================================================
// Чтение / сборка ответа
// =====================================================================

/** @return array<string, mixed>|null сырая строка tasks. */
function tasks_get_row(PDO $pdo, string $id): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM tasks WHERE id = :id LIMIT 1');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

/**
 * T1-7 (D-1): дата удаления сотрудников — ts последней записи audit_log `employee.delete` по id.
 * Записи audit_log старше 7 дней чистятся (E5-4) → для давних удалений null.
 *
 * @param string[] $employeeIds
 * @return array<string, string> employee_id => ts
 */
function tasks_removed_at(PDO $pdo, array $employeeIds): array
{
    $out = [];
    if ($employeeIds === []) {
        return $out;
    }
    $in = implode(',', array_fill(0, count($employeeIds), '?'));
    try {
        $st = $pdo->prepare(
            "SELECT entity_id, MAX(ts) AS ts FROM audit_log
             WHERE action = 'employee.delete' AND entity_type = 'employee' AND entity_id IN ($in)
             GROUP BY entity_id"
        );
        $st->execute(array_values($employeeIds));
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
            if ($r['ts'] !== null) {
                $out[(string) $r['entity_id']] = (string) $r['ts'];
            }
        }
    } catch (Throwable $_e) { /* audit_log ещё не создан → null */ }
    return $out;
}

/**
 * Люди и чек-листы пачкой.
 *
 * @param string[] $ids
 * @return array{0: array<string, array{assignee: array, watcher: array}>, 1: array<string, array>}
 */
function tasks_load_related(PDO $pdo, array $ids): array
{
    $people = [];
    $checks = [];
    if ($ids === []) {
        return [$people, $checks];
    }
    $in = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $pdo->prepare(
        "SELECT ta.task_id, ta.employee_id, ta.role, e.id AS emp_id, e.full_name, ta.full_name_snapshot
         FROM task_assignees ta LEFT JOIN employees e ON e.id = ta.employee_id
         WHERE ta.task_id IN ($in)
         ORDER BY (e.id IS NULL), e.sort_order, COALESCE(e.full_name, ta.full_name_snapshot), ta.employee_id"
    );
    $stmt->execute($ids);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    // T1-7 (D-1): «удалён» вычисляется при чтении (employee_id нет в employees); дата — из audit_log.
    $removedIds = [];
    foreach ($rows as $r) {
        if ($r['emp_id'] === null) {
            $removedIds[(string) $r['employee_id']] = true;
        }
    }
    $removedAt = tasks_removed_at($pdo, array_keys($removedIds));
    foreach ($rows as $r) {
        // Намеренно ТОЛЬКО id и full_name — без phone/photo_url.
        $eid = (string) $r['employee_id'];
        $removed = $r['emp_id'] === null;
        $name = $removed ? $r['full_name_snapshot'] : $r['full_name'];
        $people[(string) $r['task_id']][(string) $r['role']][] = [
            'employee_id' => $eid,
            'full_name'   => $name !== null ? (string) $name : null,
            'removed'     => $removed,
            'removed_at'  => $removed ? ($removedAt[$eid] ?? null) : null,
        ];
    }
    $stmt = $pdo->prepare(
        "SELECT id, task_id, text, done, sort_order FROM task_checklist
         WHERE task_id IN ($in) ORDER BY sort_order, id"
    );
    $stmt->execute($ids);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $checks[(string) $r['task_id']][] = [
            'id'         => (int) $r['id'],
            'text'       => (string) $r['text'],
            'done'       => (int) $r['done'] === 1,
            'sort_order' => (int) $r['sort_order'],
        ];
    }
    return [$people, $checks];
}

/**
 * V6.3-2 (Д-1): повторы задач пачкой.
 *
 * @param string[] $ids
 * @return array<string, array<int, array{id: int, start_at: string, end_at: ?string}>> task_id => повторы по возрастанию
 */
function tasks_load_occurrences(PDO $pdo, array $ids): array
{
    $out = [];
    if ($ids === []) {
        return $out;
    }
    $in = implode(',', array_fill(0, count($ids), '?'));
    $stmt = $pdo->prepare(
        "SELECT id, task_id, start_at, end_at FROM task_occurrences WHERE task_id IN ($in) ORDER BY start_at, id"
    );
    $stmt->execute(array_values($ids));
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $out[(string) $r['task_id']][] = [
            'id'       => (int) $r['id'],
            'start_at' => (string) $r['start_at'],
            'end_at'   => $r['end_at'] !== null ? (string) $r['end_at'] : null,
        ];
    }
    return $out;
}

/**
 * Собирает задачу для ответа с вычисляемыми полями:
 * first_day, last_day, days[], conflict (+conflict_days), notes[].
 * V6.3-2: occurrences[], next_at; days[]/conflict/notes учитывают дни всех повторов
 * (first_day/last_day — по-прежнему основной срок задачи).
 *
 * @param array<string, array>|null $occMap task_id => повторы (tasks_load_occurrences); null — загрузить для этой задачи
 */
function tasks_build(PDO $pdo, array $row, array $people, array $checks, ?array $occMap = null, ?array $attMap = null): array
{
    $id = (string) $row['id'];
    $attachments = $attMap !== null ? ($attMap[$id] ?? []) : (tf_load($pdo, [$id])[$id] ?? []);   // V7
    $assignees = $people[$id]['assignee'] ?? [];
    $watchers = $people[$id]['watcher'] ?? [];
    $occurrences = $occMap !== null ? ($occMap[$id] ?? []) : (tasks_load_occurrences($pdo, [$id])[$id] ?? []);
    $p = tasks_validate_period($row['start_at'], $row['end_at']);
    $mainDays = $p['error'] === null ? $p['days'] : [];
    $first = $p['error'] === null ? $p['first_day'] : substr((string) $row['start_at'], 0, 10);
    $last = $p['error'] === null ? $p['last_day'] : $first;
    $days = $mainDays;
    foreach ($occurrences as $o) {
        $days = array_merge($days, tasks_occurrence_days($o['start_at'], $o['end_at']));
    }
    $days = array_values(array_unique($days));
    sort($days);

    $conflictDays = [];
    $notes = [];
    if ($days !== []) {
        // Удалённые исполнители фактов не имеют и в проверках не участвуют.
        $assigneeIds = array_column(array_filter($assignees, static fn($a) => !$a['removed']), 'employee_id');
        $facts = tasks_matrix_facts($pdo, $assigneeIds, $days[0], $days[count($days) - 1]);
        // conflict — только у ОТКРЫТОЙ неархивной задачи (AC-4).
        if ($row['status'] === 'open' && (int) $row['archived'] === 0) {
            $set = array_flip($days);
            $conflictDays = array_values(array_filter(
                tasks_blocked_from_facts($facts, $days[0], $days[count($days) - 1]),
                static fn(array $b): bool => isset($set[$b['date']])
            ));
        }
        $notes = tasks_notes_from_facts($pdo, $facts, $days);
    }

    return [
        'id'            => $id,
        'title'         => (string) $row['title'],
        'description'   => $row['description'],
        'start_at'      => (string) $row['start_at'],
        'end_at'        => $row['end_at'],
        'priority'      => (int) $row['priority'],
        'label'         => $row['label'],
        'labels'        => tasks_label_tags($row['label'] !== null ? (string) $row['label'] : null),   // V6.2 (W-4)
        'status'        => (string) $row['status'],
        'check_state'   => (string) $row['check_state'],
        'version'       => (int) $row['version'],
        'created_by'    => $row['created_by'],
        'created_at'    => $row['created_at'],
        'updated_at'    => $row['updated_at'],
        'closed_at'     => $row['closed_at'],
        'archived'      => (int) $row['archived'],
        'assignees'     => $assignees,
        // orphan: нет ни одного действующего исполнителя (все удалены из employees).
        'orphan'        => array_filter($assignees, static fn($a) => !$a['removed']) === [],
        'watchers'      => $watchers,
        'checklist'     => $checks[$id] ?? [],
        'first_day'     => $first,
        'last_day'      => $last,
        'days'          => $days,
        'conflict'      => $conflictDays !== [],
        'conflict_days' => $conflictDays,
        'notes'         => $notes,
        'occurrences'   => $occurrences,                                                              // V6.3-2 (Д-1)
        'next_at'       => tasks_next_at((string) $row['start_at'], $row['end_at'], $occurrences),    // V6.3-2 (Д-1)
        'attachments'   => $attachments,                                                              // V7: вложения (метаданные)
    ];
}

function tasks_fetch(PDO $pdo, string $id): ?array
{
    $row = tasks_get_row($pdo, $id);
    if ($row === null) {
        return null;
    }
    [$people, $checks] = tasks_load_related($pdo, [$id]);
    return tasks_build($pdo, $row, $people, $checks);
}

// =====================================================================
// Валидация тела
// =====================================================================

/**
 * Список id сотрудников (массив строк или объектов {employee_id|id}) → уникальные строки.
 * Ошибка формата → 400 invalid_<field>.
 *
 * @return string[]
 */
function tasks_norm_ids(mixed $raw, string $field): array
{
    if (!is_array($raw)) {
        tasks_fail('invalid_' . $field);
    }
    $out = [];
    foreach ($raw as $v) {
        if (is_array($v)) {
            $v = $v['employee_id'] ?? $v['id'] ?? null;
        }
        if (!is_string($v) || trim($v) === '') {
            tasks_fail('invalid_' . $field);
        }
        $out[trim($v)] = true;
    }
    $out = array_keys($out);
    if (count($out) > TASKS_MAX_PEOPLE) {
        tasks_fail($field . '_too_many');
    }
    return $out;
}

/** Все id сотрудников существуют; иначе 400 employee_not_found. */
function tasks_assert_employees(PDO $pdo, array $ids): void
{
    $stmt = $pdo->prepare('SELECT 1 FROM employees WHERE id = :id LIMIT 1');
    foreach ($ids as $id) {
        $stmt->execute([':id' => (string) $id]);
        if (!$stmt->fetch()) {
            tasks_fail('employee_not_found', 400, ['employee_id' => (string) $id]);
        }
    }
}

/**
 * Подмножество id, которые есть в employees (порядок сохраняется).
 *
 * @param string[] $ids
 * @return string[]
 */
function tasks_existing_employee_ids(PDO $pdo, array $ids): array
{
    $stmt = $pdo->prepare('SELECT 1 FROM employees WHERE id = :id LIMIT 1');
    $out = [];
    foreach ($ids as $id) {
        $stmt->execute([':id' => (string) $id]);
        if ($stmt->fetch()) {
            $out[] = (string) $id;
        }
    }
    return $out;
}

/** Нормализация чек-листа → [{id?:int, text:string, done:int}]. */
function tasks_norm_checklist(mixed $raw): array
{
    if (!is_array($raw)) {
        tasks_fail('invalid_checklist');
    }
    if (count($raw) > TASKS_CHECK_MAX_ITEMS) {
        tasks_fail('checklist_too_many');
    }
    $out = [];
    foreach ($raw as $it) {
        if (is_string($it)) {
            $it = ['text' => $it];
        }
        if (!is_array($it) || !isset($it['text']) || !is_string($it['text'])) {
            tasks_fail('invalid_checklist');
        }
        $text = trim($it['text']);
        if ($text === '' || mb_strlen($text) > TASKS_CHECK_TEXT_MAX) {
            tasks_fail('invalid_checklist');
        }
        $item = ['text' => $text, 'done' => !empty($it['done']) ? 1 : 0];
        if (isset($it['id']) && (is_int($it['id']) || (is_string($it['id']) && ctype_digit($it['id'])))) {
            $item['id'] = (int) $it['id'];
        }
        $out[] = $item;
    }
    return $out;
}

function tasks_norm_text(mixed $v, int $max, string $errCode): ?string
{
    if ($v === null) {
        return null;
    }
    if (!is_string($v)) {
        tasks_fail($errCode);
    }
    $v = trim($v);
    if (mb_strlen($v) > $max) {
        tasks_fail($errCode);
    }
    return $v === '' ? null : $v;
}

/**
 * V6.2 (W-4): метка = теги через запятую. Нормализация: split по «,», trim, схлопнуть пробелы,
 * убрать пустые и дубли (без учёта регистра, первая форма побеждает). Каждый тег ≤ 30 символов,
 * вся строка «тег1, тег2» ≤ 200. Пусто → NULL. Ошибка — invalid_label с понятным message.
 *
 * @return string[]
 */
function tasks_label_tags(?string $v): array
{
    if ($v === null) {
        return [];
    }
    $out = [];
    $seen = [];
    foreach (explode(',', $v) as $part) {
        $tag = trim((string) preg_replace('/\s+/u', ' ', $part));
        if ($tag === '') {
            continue;
        }
        $key = mb_strtolower($tag);
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $out[] = $tag;
    }
    return $out;
}

function tasks_norm_label(mixed $v): ?string
{
    if ($v === null) {
        return null;
    }
    if (!is_string($v)) {
        tasks_fail('invalid_label', 400, ['message' => 'Метка должна быть строкой: теги через запятую.']);
    }
    $tags = tasks_label_tags($v);
    foreach ($tags as $tag) {
        if (mb_strlen($tag) > TASKS_LABEL_TAG_MAX) {
            tasks_fail('invalid_label', 400, [
                'message' => 'Тег «' . mb_substr($tag, 0, 20) . '…» длиннее ' . TASKS_LABEL_TAG_MAX . ' символов.',
            ]);
        }
    }
    $joined = implode(', ', $tags);
    if (mb_strlen($joined) > TASKS_LABEL_MAX) {
        tasks_fail('invalid_label', 400, ['message' => 'Все теги вместе длиннее ' . TASKS_LABEL_MAX . ' символов — уберите лишние.']);
    }
    return $joined === '' ? null : $joined;
}

function tasks_norm_priority(mixed $v): int
{
    if (is_string($v) && ctype_digit($v)) {
        $v = (int) $v;
    }
    if (!is_int($v) || $v < 1 || $v > 3) {
        tasks_fail('invalid_priority');
    }
    return $v;
}

/** version из тела/запроса → int|null. */
function tasks_read_version(array $body): ?int
{
    $v = $body['version'] ?? ($_GET['version'] ?? null);
    if ($v === null || $v === '') {
        return null;
    }
    if (is_string($v) && ctype_digit($v)) {
        return (int) $v;
    }
    if (is_int($v)) {
        return $v;
    }
    tasks_fail('invalid_version');
    return null;
}

/** 409 VERSION_CONFLICT (с актуальной карточкой, чтобы вкладка могла перечитать). */
function tasks_version_conflict(PDO $pdo, string $id): void
{
    $cur = tasks_fetch($pdo, $id);
    tasks_fail('VERSION_CONFLICT', 409, [
        'current_version' => $cur !== null ? $cur['version'] : null,
        'task'            => $cur,
    ]);
}

/**
 * Проверка FR-10; при блоке — 422 TASK_BLOCKED_BY_SICK_OR_TRIP.
 * Правила исполняет n8n (если настроен и отвечает ≤ 3 с), иначе PHP-эталон.
 *
 * @param string[] $assigneeIds
 * @return string check_state для сохраняемой задачи: 'ok' | 'pending' (n8n настроен, но недоступен — AC-8)
 */
function tasks_enforce_fr10(PDO $pdo, array $assigneeIds, string $startAt, ?string $endAt, ?array $occ = null): string
{
    // T1-7 (D-1): удалённые исполнители фактов не имеют — в проверке (и n8n) не участвуют.
    $assigneeIds = tasks_existing_employee_ids($pdo, $assigneeIds);
    if ($assigneeIds === []) {
        return 'ok';
    }
    $res = tasks_check_period_checked($pdo, $assigneeIds, $startAt, $endAt);
    if (isset($res['error'])) {
        tasks_fail($res['error']);
    }
    if ($res['ok']) {
        return $res['check_state'];
    }
    $sug = $res['suggested_start'];
    $sugStart = null;
    $sugEnd = null;
    if ($sug !== null) {
        $s = tasks_parse_when($startAt);
        $sugStart = $sug . ($s['time'] !== null ? 'T' . $s['time'] : '');
        if ($endAt !== null && $endAt !== '') {
            $e = tasks_parse_when($endAt);
            $shift = tasks_date_diff($res['first_day'], $sug);
            $sugEnd = tasks_date_add($e['date'], $shift) . ($e['time'] !== null ? 'T' . $e['time'] : '');
        }
    }
    $extra = [
        'blocked_days'    => $res['blocked_days'],
        'suggested_start' => $sugStart,
        'suggested_end'   => $sugEnd,
    ];
    if ($occ !== null) {
        // V6.3-2 (Д-1): блок на повторе — указываем, какой именно (index — позиция в присланном списке; null — точечное действие).
        $extra['occurrence_index'] = $occ['index'] ?? null;
        $extra['occurrence_start_at'] = $startAt;
        $extra['message'] = tasks_occurrence_blocked_message($pdo, $startAt, $res['blocked_days']);
    }
    tasks_fail('TASK_BLOCKED_BY_SICK_OR_TRIP', 422, $extra);
}

/** Понятное сообщение о блоке повтора: «Повтор 11.01.2027 14:30: Иванов — больничный (11.01.2027)». */
function tasks_occurrence_blocked_message(PDO $pdo, string $occStart, array $blocked): string
{
    $names = [];
    $parts = [];
    foreach (array_slice($blocked, 0, 3) as $b) {
        $eid = (string) $b['employee_id'];
        if (!isset($names[$eid])) {
            $st = $pdo->prepare('SELECT full_name FROM employees WHERE id = :id');
            $st->execute([':id' => $eid]);
            $n = $st->fetchColumn();
            $names[$eid] = $n !== false && $n !== null ? (string) $n : $eid;
        }
        $parts[] = $names[$eid] . ' — ' . ($b['reason'] === 'sick' ? 'больничный' : 'командировка') . ' (' . tasks_fmt_when((string) $b['date']) . ')';
    }
    return 'Повтор ' . tasks_fmt_when($occStart) . ' нельзя поставить: ' . implode('; ', $parts)
        . (count($blocked) > 3 ? ' и ещё ' . (count($blocked) - 3) : '') . '. Выберите другую дату.';
}

/**
 * V6.3-2 (Д-1): нормализация повторов из тела запроса.
 * Вход: [{start_at}|"start_at", …] (end_at из тела игнорируется — конец считается по длительности задачи).
 * Проверки: формат (и «вид» — со временем/без, как у задачи), ≤ 100, не совпадает с основной датой
 * и с другим повтором (дата+время до минуты). Ошибки: 400 invalid_occurrence / occurrence_duplicate
 * / occurrences_too_many с `index` (позиция в присланном списке) и понятным `message`.
 *
 * @return array<int, array{start_at: string, end_at: ?string, index: int}> по возрастанию начала
 */
function tasks_norm_occurrences(mixed $raw, string $taskStart, ?string $taskEnd): array
{
    if (!is_array($raw)) {
        tasks_fail('invalid_occurrences', 400, ['message' => 'Повторы должны быть списком.']);
    }
    if (count($raw) > TASKS_MAX_OCCURRENCES) {
        tasks_fail('occurrences_too_many', 400, ['message' => 'Повторов не больше ' . TASKS_MAX_OCCURRENCES . '.']);
    }
    $taskKind = tasks_parse_when($taskStart);
    $mainKey = tasks_when_key($taskStart);
    $seen = [$mainKey => -1];
    $out = [];
    foreach (array_values($raw) as $i => $it) {
        $s = is_array($it) ? ($it['start_at'] ?? null) : $it;
        $n = $i + 1;
        $p = tasks_parse_when($s);
        if ($p === null) {
            tasks_fail('invalid_occurrence', 400, ['index' => $i, 'message' => 'Повтор ' . $n . ': неверная дата или время.']);
        }
        if ($taskKind !== null && $taskKind['time'] === null && $p['time'] !== null) {
            tasks_fail('invalid_occurrence', 400, ['index' => $i, 'message' => 'Повтор ' . $n . ': у задачи без времени повтор задаётся только датой.']);
        }
        if ($taskKind !== null && $taskKind['time'] !== null && $p['time'] === null) {
            tasks_fail('invalid_occurrence', 400, ['index' => $i, 'message' => 'Повтор ' . $n . ': укажите время начала повтора.']);
        }
        $start = (string) $s;
        $key = tasks_when_key($start);
        if (isset($seen[$key])) {
            tasks_fail('occurrence_duplicate', 400, [
                'index'   => $i,
                'message' => $seen[$key] === -1
                    ? 'Повтор ' . $n . ' (' . tasks_fmt_when($start) . ') совпадает с основной датой задачи.'
                    : 'Повтор ' . $n . ' (' . tasks_fmt_when($start) . ') совпадает с повтором ' . ($seen[$key] + 1) . '.',
            ]);
        }
        $seen[$key] = $i;
        $end = tasks_occurrence_end($taskStart, $taskEnd, $start);
        $per = tasks_validate_period($start, $end);
        if ($per['error'] !== null) {
            tasks_fail('invalid_occurrence', 400, ['index' => $i, 'message' => 'Повтор ' . $n . ': ' . $per['error']]);
        }
        $out[] = ['start_at' => $start, 'end_at' => $end, 'index' => $i];
    }
    usort($out, static fn(array $a, array $b): int => strcmp(tasks_when_key($a['start_at']), tasks_when_key($b['start_at'])));
    return $out;
}

/**
 * V6.3-2: уже сохранённые повторы после смены срока задачи — вид приводится к виду задачи
 * (время добавляется/убирается), концы пересчитываются по новой длительности.
 * Совпадение с основной датой/другим повтором после пересчёта → 400 occurrence_duplicate.
 *
 * @param array<int, array{id: int, start_at: string, end_at: ?string}> $stored
 * @return array<int, array{start_at: string, end_at: ?string, index: int, id: int}>
 */
function tasks_recompute_occurrences(array $stored, string $taskStart, ?string $taskEnd): array
{
    $mainKey = tasks_when_key($taskStart);
    $seen = [$mainKey => -1];
    $out = [];
    foreach (array_values($stored) as $i => $o) {
        $start = tasks_occurrence_conform($taskStart, $o['start_at']) ?? $o['start_at'];
        $key = tasks_when_key($start);
        if (isset($seen[$key])) {
            tasks_fail('occurrence_duplicate', 400, [
                'index'   => $i,
                'message' => 'После изменения срока повтор ' . tasks_fmt_when($start) . ' совпал с '
                    . ($seen[$key] === -1 ? 'основной датой задачи' : 'другим повтором') . ' — измените или удалите повтор.',
            ]);
        }
        $seen[$key] = $i;
        $out[] = ['id' => $o['id'], 'start_at' => $start, 'end_at' => tasks_occurrence_end($taskStart, $taskEnd, $start), 'index' => $i];
    }
    usort($out, static fn(array $a, array $b): int => strcmp(tasks_when_key($a['start_at']), tasks_when_key($b['start_at'])));
    return $out;
}

/**
 * FR-10 для повторов: тем же tasks_enforce_fr10 (n8n/PHP) по каждому повтору.
 * $only — ключи (tasks_when_key + '|' + end) повторов, которые надо проверить (null — все).
 *
 * @param array<int, array{start_at: string, end_at: ?string, index: int}> $occ
 * @return string 'ok' | 'pending' (pending, если хотя бы одна проверка ушла в fallback)
 */
function tasks_enforce_occurrences(PDO $pdo, array $assigneeIds, array $occ, ?array $only = null): string
{
    $state = 'ok';
    foreach ($occ as $o) {
        if ($only !== null && !isset($only[tasks_when_key($o['start_at']) . '|' . (string) $o['end_at']])) {
            continue;
        }
        if (tasks_enforce_fr10($pdo, $assigneeIds, $o['start_at'], $o['end_at'], ['index' => $o['index']]) === 'pending') {
            $state = 'pending';
        }
    }
    return $state;
}

/** Ключи повторов (начало+конец) — для сравнения наборов. @return array<string, true> */
function tasks_occurrence_keys(array $occ): array
{
    $k = [];
    foreach ($occ as $o) {
        $k[tasks_when_key($o['start_at']) . '|' . (string) $o['end_at']] = true;
    }
    return $k;
}

/**
 * V6.3-2: проверка ОДНОГО повтора для точечных действий календаря (добавить/перенести).
 * Начало приводится к виду задачи (у задачи со временем без времени — берётся время начала задачи;
 * у задачи без времени — только дата). Совпадение с основной датой или другим повтором —
 * 400 occurrence_duplicate; формат — 400 invalid_occurrence.
 *
 * @param array<int, array{id: int, start_at: string, end_at: ?string}> $stored
 * @return array{start_at: string, end_at: ?string}
 */
function tasks_single_occurrence(array $row, array $stored, mixed $start, ?int $selfId): array
{
    if (tasks_parse_when($start) === null) {
        tasks_fail('invalid_occurrence', 400, ['index' => null, 'message' => 'Неверная дата или время повтора.']);
    }
    $start = tasks_occurrence_conform((string) $row['start_at'], (string) $start);
    $key = tasks_when_key((string) $start);
    if ($key === tasks_when_key((string) $row['start_at'])) {
        tasks_fail('occurrence_duplicate', 400, [
            'index' => null, 'message' => 'Повтор ' . tasks_fmt_when((string) $start) . ' совпадает с основной датой задачи.',
        ]);
    }
    foreach ($stored as $o) {
        if ($o['id'] !== $selfId && tasks_when_key($o['start_at']) === $key) {
            tasks_fail('occurrence_duplicate', 400, [
                'index' => null, 'message' => 'Повтор на ' . tasks_fmt_when((string) $start) . ' у этой задачи уже есть.',
            ]);
        }
    }
    return ['start_at' => (string) $start, 'end_at' => tasks_occurrence_end((string) $row['start_at'], $row['end_at'], (string) $start)];
}

/** Записывает набор повторов: совпавшие по началу строки сохраняют id (обновляется конец),
 * лишние удаляются, новые добавляются.
 *
 * @param array<int, array{start_at: string, end_at: ?string}> $occ
 */
function tasks_write_occurrences(PDO $pdo, string $taskId, array $occ): void
{
    $st = $pdo->prepare('SELECT id, start_at FROM task_occurrences WHERE task_id = :t');
    $st->execute([':t' => $taskId]);
    $byKey = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $byKey[tasks_when_key((string) $r['start_at'])] = (int) $r['id'];
    }
    $keep = [];
    $upd = $pdo->prepare('UPDATE task_occurrences SET start_at = :s, end_at = :e WHERE id = :id AND task_id = :t');
    $ins = $pdo->prepare('INSERT INTO task_occurrences (task_id, start_at, end_at) VALUES (:t, :s, :e)');
    foreach ($occ as $o) {
        $key = tasks_when_key($o['start_at']);
        if (isset($byKey[$key])) {
            $upd->execute([':s' => $o['start_at'], ':e' => $o['end_at'], ':id' => $byKey[$key], ':t' => $taskId]);
            $keep[$byKey[$key]] = true;
        } else {
            $ins->execute([':t' => $taskId, ':s' => $o['start_at'], ':e' => $o['end_at']]);
        }
    }
    $del = $pdo->prepare('DELETE FROM task_occurrences WHERE id = :id AND task_id = :t');
    foreach ($byKey as $id) {
        if (!isset($keep[$id])) {
            $del->execute([':id' => $id, ':t' => $taskId]);
        }
    }
}

// =====================================================================
// Запись связанных данных
// =====================================================================

function tasks_replace_people(PDO $pdo, string $taskId, array $assignees, array $watchers): void
{
    // T1-7 (D-1): ФИО-снимок — из employees; для уже удалённых сохраняется прежний снимок.
    $st = $pdo->prepare('SELECT employee_id, full_name_snapshot FROM task_assignees WHERE task_id = :t');
    $st->execute([':t' => $taskId]);
    $oldSnap = [];
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) {
        if ($r['full_name_snapshot'] !== null) {
            $oldSnap[(string) $r['employee_id']] = (string) $r['full_name_snapshot'];
        }
    }
    $nameSt = $pdo->prepare('SELECT full_name FROM employees WHERE id = :id');
    $snapOf = static function (string $e) use ($nameSt, $oldSnap): ?string {
        $nameSt->execute([':id' => $e]);
        $n = $nameSt->fetchColumn();
        return $n !== false && $n !== null ? (string) $n : ($oldSnap[$e] ?? null);
    };
    $pdo->prepare('DELETE FROM task_assignees WHERE task_id = :t')->execute([':t' => $taskId]);
    $ins = $pdo->prepare(
        'INSERT INTO task_assignees (task_id, employee_id, role, full_name_snapshot) VALUES (:t, :e, :r, :n)'
    );
    foreach ($assignees as $e) {
        $ins->execute([':t' => $taskId, ':e' => $e, ':r' => 'assignee', ':n' => $snapOf((string) $e)]);
    }
    foreach ($watchers as $e) {
        $ins->execute([':t' => $taskId, ':e' => $e, ':r' => 'watcher', ':n' => $snapOf((string) $e)]);
    }
}

/** Синхронизация чек-листа: пункты с известным id обновляются, прочие создаются, отсутствующие удаляются. */
function tasks_sync_checklist(PDO $pdo, string $taskId, array $items): void
{
    $st = $pdo->prepare('SELECT id FROM task_checklist WHERE task_id = :t');
    $st->execute([':t' => $taskId]);
    $existing = array_flip(array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN)));
    $keep = [];
    $upd = $pdo->prepare('UPDATE task_checklist SET text = :x, done = :d, sort_order = :s WHERE id = :id AND task_id = :t');
    $ins = $pdo->prepare('INSERT INTO task_checklist (task_id, text, done, sort_order) VALUES (:t, :x, :d, :s)');
    foreach ($items as $i => $it) {
        if (isset($it['id']) && isset($existing[$it['id']]) && !isset($keep[$it['id']])) {
            $upd->execute([':x' => $it['text'], ':d' => $it['done'], ':s' => $i, ':id' => $it['id'], ':t' => $taskId]);
            $keep[$it['id']] = true;
        } else {
            $ins->execute([':t' => $taskId, ':x' => $it['text'], ':d' => $it['done'], ':s' => $i]);
        }
    }
    $del = $pdo->prepare('DELETE FROM task_checklist WHERE id = :id AND task_id = :t');
    foreach ($existing as $id => $_) {
        if (!isset($keep[$id])) {
            $del->execute([':id' => $id, ':t' => $taskId]);
        }
    }
}

// =====================================================================
// Основной блок
// =====================================================================

try {
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // -----------------------------------------------------------------
    // GET ?calendar_facts — сервисный токен, сессия не нужна.
    // -----------------------------------------------------------------
    if ($method === 'GET' && array_key_exists('calendar_facts', $_GET)) {
        tasks_require_service_token($pdo);
        $from = $_GET['from'] ?? null;
        $to = $_GET['to'] ?? null;
        if (!tasks_valid_ymd($from)) {
            tasks_fail('invalid_from');
        }
        if (!tasks_valid_ymd($to)) {
            tasks_fail('invalid_to');
        }
        if (tasks_date_diff($from, $to) < 0) {
            tasks_fail('date_range_invalid');
        }
        if (tasks_date_diff($from, $to) + 1 > TASKS_MAX_PERIOD_DAYS) {
            tasks_fail('period_too_long');
        }
        $empRaw = (string) ($_GET['employee_id'] ?? '');
        $empIds = array_values(array_unique(array_filter(array_map('trim', explode(',', $empRaw)), static fn($v) => $v !== '')));
        if ($empIds === []) {
            tasks_fail('employee_id_required');
        }
        if (count($empIds) > TASKS_FACTS_MAX_EMPLOYEES) {
            tasks_fail('employee_id_too_many');
        }
        tasks_assert_employees($pdo, $empIds);
        sendJson([
            'success' => true,
            'from'    => $from,
            'to'      => $to,
            'facts'   => tasks_calendar_facts($pdo, $empIds, $from, $to),
        ]);
    }

    // -----------------------------------------------------------------
    // GET: чтение — любой авторизованный.
    // -----------------------------------------------------------------
    if ($method === 'GET') {
        require_auth();

        if (isset($_GET['id']) && $_GET['id'] !== '') {
            $task = tasks_fetch($pdo, (string) $_GET['id']);
            if ($task === null) {
                tasks_fail('not_found', 404);
            }
            sendJson(['success' => true, 'task' => $task]);
        }

        // T1-7 (D-1): открытые неархивные задачи без действующего исполнителя (без фильтра периода).
        if (isset($_GET['orphans']) && strToBool($_GET['orphans'])) {
            $stmt = $pdo->prepare(
                "SELECT t.* FROM tasks t
                 WHERE t.archived = 0 AND t.status = 'open'
                   AND NOT EXISTS (SELECT 1 FROM task_assignees ta JOIN employees e ON e.id = ta.employee_id
                                   WHERE ta.task_id = t.id AND ta.role = 'assignee')
                 ORDER BY t.start_at, t.id LIMIT " . TASKS_LIST_LIMIT
            );
            $stmt->execute();
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            [$people, $checks] = tasks_load_related($pdo, array_map(static fn($r) => (string) $r['id'], $rows));
            $occMap = tasks_load_occurrences($pdo, array_map(static fn($r) => (string) $r['id'], $rows));
            $attMap = tf_load($pdo, array_map(static fn($r) => (string) $r['id'], $rows));   // V7
            $tasks = [];
            foreach ($rows as $r) {
                $tasks[] = tasks_build($pdo, $r, $people, $checks, $occMap, $attMap);
            }
            sendJson(['success' => true, 'count' => count($tasks), 'tasks' => $tasks]);
        }

        // T1-7 (D-1): открытые неархивные задачи, где сотрудник — действующий исполнитель
        // (подтверждение удаления и окно замены ДО удаления).
        if (isset($_GET['open_for']) && $_GET['open_for'] !== '') {
            $stmt = $pdo->prepare(
                "SELECT t.id, t.title, t.start_at, t.end_at, t.version FROM tasks t
                 WHERE t.archived = 0 AND t.status = 'open'
                   AND EXISTS (SELECT 1 FROM task_assignees ta JOIN employees e ON e.id = ta.employee_id
                               WHERE ta.task_id = t.id AND ta.role = 'assignee' AND ta.employee_id = :emp)
                 ORDER BY t.start_at, t.id LIMIT " . TASKS_LIST_LIMIT
            );
            $stmt->execute([':emp' => (string) $_GET['open_for']]);
            $list = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
                $list[] = [
                    'id'       => (string) $r['id'],
                    'title'    => (string) $r['title'],
                    'start_at' => (string) $r['start_at'],
                    'end_at'   => $r['end_at'],
                    'version'  => (int) $r['version'],
                ];
            }
            sendJson(['success' => true, 'count' => count($list), 'tasks' => $list]);
        }

        $from = $_GET['from'] ?? null;
        $to = $_GET['to'] ?? null;
        if ($from !== null && $from !== '' && !tasks_valid_ymd($from)) {
            tasks_fail('invalid_from');
        }
        if ($to !== null && $to !== '' && !tasks_valid_ymd($to)) {
            tasks_fail('invalid_to');
        }
        $where = [];
        $params = [];
        if (!(isset($_GET['include_archived']) && strToBool($_GET['include_archived']))) {
            $where[] = 't.archived = 0';
        }
        // V6.3-2: задача попадает в диапазон, если в него попадает основной срок ИЛИ любой повтор.
        $mainRange = [];
        $occRange = [];
        if ($to !== null && $to !== '') {
            $mainRange[] = 'substr(t.start_at, 1, 10) <= :to';
            $occRange[] = 'substr(o.start_at, 1, 10) <= :to';
            $params[':to'] = $to;
        }
        if ($from !== null && $from !== '') {
            $mainRange[] = 'COALESCE(substr(t.end_at, 1, 10), substr(t.start_at, 1, 10)) >= :from';
            $occRange[] = 'COALESCE(substr(o.end_at, 1, 10), substr(o.start_at, 1, 10)) >= :from';
            $params[':from'] = $from;
        }
        if ($mainRange !== []) {
            $where[] = '((' . implode(' AND ', $mainRange) . ') OR EXISTS (SELECT 1 FROM task_occurrences o WHERE o.task_id = t.id AND '
                . implode(' AND ', $occRange) . '))';
        }
        if (isset($_GET['status']) && $_GET['status'] !== '') {
            if (!in_array($_GET['status'], ['open', 'closed'], true)) {
                tasks_fail('invalid_status');
            }
            $where[] = 't.status = :status';
            $params[':status'] = (string) $_GET['status'];
        }
        $empFilter = $_GET['employee_id'] ?? null;
        if ($empFilter !== null && $empFilter !== '') {
            $where[] = 't.id IN (SELECT task_id FROM task_assignees WHERE employee_id = :emp)';
            $params[':emp'] = (string) $empFilter;
        }
        $sql = 'SELECT t.* FROM tasks t'
            . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
            . ' ORDER BY t.start_at, t.id LIMIT ' . TASKS_LIST_LIMIT;
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        [$people, $checks] = tasks_load_related($pdo, array_map(static fn($r) => (string) $r['id'], $rows));
        $occMap = tasks_load_occurrences($pdo, array_map(static fn($r) => (string) $r['id'], $rows));
        $attMap = tf_load($pdo, array_map(static fn($r) => (string) $r['id'], $rows));   // V7
        $tasks = [];
        foreach ($rows as $r) {
            $tasks[] = tasks_build($pdo, $r, $people, $checks, $occMap, $attMap);
        }
        $listPayload = [
            'success' => true,
            'tasks'   => $tasks,
            'from'    => ($from !== '' ? $from : null),
            'to'      => ($to !== '' ? $to : null),
        ];
        // n8n tasks-recheck: pending → после ответа пользователю, раз в 15 мин (метка в meta).
        if (tasks_recheck_claim($pdo)) {
            tasks_send_json_then($listPayload, static function () use ($pdo): void {
                tasks_recheck_pending($pdo);
            });
        }
        sendJson($listPayload);
    }

    if (!in_array($method, ['POST', 'PUT', 'DELETE'], true)) {
        tasks_fail('method_not_allowed', 405);
    }

    // Любая запись — только admin (anon → 401, supervisor/viewer → 403).
    require_admin();

    $id = isset($_GET['id']) ? (string) $_GET['id'] : '';
    $action = isset($_GET['action']) ? (string) $_GET['action'] : '';

    // -----------------------------------------------------------------
    // POST без id: создание.
    // -----------------------------------------------------------------
    if ($method === 'POST' && $id === '') {
        $body = getJsonBody();
        $title = tasks_norm_text($body['title'] ?? null, TASKS_TITLE_MAX, 'invalid_title');
        if ($title === null) {
            tasks_fail('title_required');
        }
        $description = tasks_norm_text($body['description'] ?? null, TASKS_DESC_MAX, 'invalid_description');
        $label = tasks_norm_label($body['label'] ?? null);
        $priority = array_key_exists('priority', $body) && $body['priority'] !== null
            ? tasks_norm_priority($body['priority']) : 2;
        $startAt = $body['start_at'] ?? null;
        $endAt = $body['end_at'] ?? null;
        if ($endAt === '') {
            $endAt = null;
        }
        $period = tasks_validate_period($startAt, $endAt);
        if ($period['error'] !== null) {
            tasks_fail($period['error']);
        }
        if (!isset($body['assignees'])) {
            tasks_fail('assignees_required');
        }
        $assignees = tasks_norm_ids($body['assignees'], 'assignees');
        if ($assignees === []) {
            tasks_fail('assignees_required');
        }
        $watchers = array_key_exists('watchers', $body) ? tasks_norm_ids($body['watchers'], 'watchers') : [];
        $watchers = array_values(array_diff($watchers, $assignees));
        $checklist = array_key_exists('checklist', $body) ? tasks_norm_checklist($body['checklist']) : [];
        $occurrences = array_key_exists('occurrences', $body)
            ? tasks_norm_occurrences($body['occurrences'], (string) $startAt, $endAt) : [];   // V6.3-2 (Д-1)
        tasks_assert_employees($pdo, array_merge($assignees, $watchers));

        $user = current_user();
        $username = is_array($user) && !empty($user['username']) ? (string) $user['username'] : 'api';

        $pdo->beginTransaction();
        try {
            // FR-10 внутри транзакции: проверка и вставка согласованы.
            $checkState = tasks_enforce_fr10($pdo, $assignees, (string) $startAt, $endAt);
            // V6.3-2: тем же правилом — каждый повтор (ошибка указывает, какой).
            if (tasks_enforce_occurrences($pdo, $assignees, $occurrences) === 'pending') {
                $checkState = 'pending';
            }

            $newId = genId('task_');
            $ts = now();
            $pdo->prepare(
                'INSERT INTO tasks (id, title, description, start_at, end_at, priority, label, status,
                                    check_state, version, created_by, created_at, updated_at, archived)
                 VALUES (:id, :title, :desc, :s, :e, :p, :label, \'open\', :cs, 1, :by, :ts, :ts, 0)'
            )->execute([
                ':id' => $newId, ':title' => $title, ':desc' => $description, ':s' => $startAt, ':e' => $endAt,
                ':p' => $priority, ':label' => $label, ':cs' => $checkState, ':by' => $username, ':ts' => $ts,
            ]);
            tasks_replace_people($pdo, $newId, $assignees, $watchers);
            tasks_sync_checklist($pdo, $newId, $checklist);
            tasks_write_occurrences($pdo, $newId, $occurrences);
            $auditDetails = [
                'title'       => $title,
                'start_at'    => $startAt,
                'end_at'      => $endAt,
                'assignees'   => $assignees,
                'watchers'    => $watchers,
                'check_state' => $checkState,
            ];
            if ($occurrences !== []) {
                $auditDetails['occurrences'] = array_column($occurrences, 'start_at');
            }
            tasks_audit($pdo, 'task.create', $newId, $auditDetails);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        sendJson(['success' => true, 'task' => tasks_fetch($pdo, $newId)], 201);
    }

    // -----------------------------------------------------------------
    // Остальное требует id.
    // -----------------------------------------------------------------
    if ($id === '') {
        tasks_fail('missing_id');
    }
    $row = tasks_get_row($pdo, $id);
    if ($row === null) {
        tasks_fail('not_found', 404);
    }
    $username = (string) ((current_user()['username'] ?? null) ?: 'api');

    // -----------------------------------------------------------------
    // POST ?id&action=occ_add|occ_move|occ_delete — точечные действия с повторами (календарь, V6.3-2).
    // version ОБЯЗАТЕЛЕН (409 при расхождении); версия задачи растёт на 1; только admin (require_admin выше).
    //   occ_add    {version, start_at}                    → { task, occurrence }
    //   occ_move   {version, occurrence_id, start_at}     → { task, occurrence }
    //   occ_delete {version, occurrence_id}               → { task, deleted }
    // -----------------------------------------------------------------
    if ($method === 'POST' && in_array($action, ['occ_add', 'occ_move', 'occ_delete'], true)) {
        $body = getJsonBody();
        $ver = tasks_read_version($body);
        if ($ver === null) {
            tasks_fail('version_required');
        }
        if ($ver !== (int) $row['version']) {
            tasks_version_conflict($pdo, $id);
        }
        if ((int) $row['archived'] === 1) {
            tasks_fail('task_archived', 409);
        }
        $stored = tasks_load_occurrences($pdo, [$id])[$id] ?? [];
        [$peopleOcc] = tasks_load_related($pdo, [$id]);
        $assigneesOcc = array_column($peopleOcc[$id]['assignee'] ?? [], 'employee_id');

        $occId = null;
        $target = null;
        if ($action !== 'occ_add') {
            $rawId = $body['occurrence_id'] ?? null;
            if (is_string($rawId) && ctype_digit($rawId)) {
                $rawId = (int) $rawId;
            }
            if (!is_int($rawId)) {
                tasks_fail('invalid_occurrence_id');
            }
            foreach ($stored as $o) {
                if ($o['id'] === $rawId) {
                    $target = $o;
                }
            }
            if ($target === null) {
                tasks_fail('occurrence_not_found', 404);
            }
            $occId = $rawId;
        }
        $newOne = null;
        if ($action !== 'occ_delete') {
            if (!array_key_exists('start_at', $body)) {
                tasks_fail('invalid_occurrence', 400, ['index' => null, 'message' => 'Не указана дата повтора.']);
            }
            if ($action === 'occ_add' && count($stored) >= TASKS_MAX_OCCURRENCES) {
                tasks_fail('occurrences_too_many', 400, ['message' => 'Повторов не больше ' . TASKS_MAX_OCCURRENCES . '.']);
            }
            $newOne = tasks_single_occurrence($row, $stored, $body['start_at'], $occId);
            if ($action === 'occ_move' && tasks_when_key($newOne['start_at']) === tasks_when_key($target['start_at'])
                && $newOne['end_at'] === $target['end_at']) {
                sendJson(['success' => true, 'unchanged' => true, 'task' => tasks_fetch($pdo, $id), 'occurrence' => $target]);
            }
        }

        $pdo->beginTransaction();
        try {
            $checkState = (string) $row['check_state'];
            if ($newOne !== null) {
                // Тем же правилом, что и задача (больничный/командировка → 422 с указанием повтора).
                $st = tasks_enforce_fr10($pdo, $assigneesOcc, $newOne['start_at'], $newOne['end_at'], ['index' => null]);
                if ($st === 'pending') {
                    $checkState = 'pending';
                }
            }
            $ts = now();
            $upd = $pdo->prepare(
                'UPDATE tasks SET check_state = :cs, version = version + 1, updated_at = :ts WHERE id = :id AND version = :v'
            );
            $upd->execute([':cs' => $checkState, ':ts' => $ts, ':id' => $id, ':v' => (int) $row['version']]);
            if ($upd->rowCount() !== 1) {
                $pdo->rollBack();
                tasks_version_conflict($pdo, $id);
            }
            $details = ['title' => $row['title'], 'from_version' => (int) $row['version'], 'to_version' => (int) $row['version'] + 1];
            $result = [];
            if ($action === 'occ_add') {
                $pdo->prepare('INSERT INTO task_occurrences (task_id, start_at, end_at) VALUES (:t, :s, :e)')
                    ->execute([':t' => $id, ':s' => $newOne['start_at'], ':e' => $newOne['end_at']]);
                $result['occurrence'] = ['id' => (int) $pdo->lastInsertId(), 'start_at' => $newOne['start_at'], 'end_at' => $newOne['end_at']];
                $details['occurrence'] = $newOne['start_at'];
            } elseif ($action === 'occ_move') {
                $pdo->prepare('UPDATE task_occurrences SET start_at = :s, end_at = :e WHERE id = :oid AND task_id = :t')
                    ->execute([':s' => $newOne['start_at'], ':e' => $newOne['end_at'], ':oid' => $occId, ':t' => $id]);
                $result['occurrence'] = ['id' => $occId, 'start_at' => $newOne['start_at'], 'end_at' => $newOne['end_at']];
                $details['occurrence_before'] = $target['start_at'];
                $details['occurrence_after'] = $newOne['start_at'];
            } else {
                $pdo->prepare('DELETE FROM task_occurrences WHERE id = :oid AND task_id = :t')->execute([':oid' => $occId, ':t' => $id]);
                $result['deleted'] = $occId;
                $details['occurrence'] = $target['start_at'];
            }
            tasks_audit($pdo, 'task.' . $action, $id, $details);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        sendJson(['success' => true, 'task' => tasks_fetch($pdo, $id)] + $result);
    }

    // -----------------------------------------------------------------
    // POST ?id&action=close|reopen
    // -----------------------------------------------------------------
    if ($method === 'POST') {
        if (!in_array($action, ['close', 'reopen'], true)) {
            tasks_fail('invalid_action');
        }
        $body = getJsonBody();
        $ver = tasks_read_version($body);
        if ($ver !== null && $ver !== (int) $row['version']) {
            tasks_version_conflict($pdo, $id);
        }
        if ((int) $row['archived'] === 1) {
            tasks_fail('task_archived', 409);
        }
        $target = $action === 'close' ? 'closed' : 'open';
        if ($row['status'] === $target) {
            // Уже в нужном состоянии — идемпотентно, без версии и аудита.
            sendJson(['success' => true, 'unchanged' => true, 'task' => tasks_fetch($pdo, $id)]);
        }
        $pdo->beginTransaction();
        try {
            $ts = now();
            $upd = $pdo->prepare(
                'UPDATE tasks SET status = :st, closed_at = :ca, version = version + 1, updated_at = :ts
                 WHERE id = :id AND version = :v'
            );
            $upd->execute([
                ':st' => $target, ':ca' => $target === 'closed' ? $ts : null, ':ts' => $ts,
                ':id' => $id, ':v' => (int) $row['version'],
            ]);
            if ($upd->rowCount() !== 1) {
                $pdo->rollBack();
                tasks_version_conflict($pdo, $id);
            }
            tasks_audit($pdo, $action === 'close' ? 'task.close' : 'task.reopen', $id, [
                'title'        => $row['title'],
                'from_version' => (int) $row['version'],
                'to_version'   => (int) $row['version'] + 1,
            ]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        sendJson(['success' => true, 'task' => tasks_fetch($pdo, $id)]);
    }

    // -----------------------------------------------------------------
    // DELETE = архив
    // -----------------------------------------------------------------
    if ($method === 'DELETE') {
        $body = [];
        $raw = file_get_contents('php://input');
        if ($raw !== false && $raw !== '') {
            $body = getJsonBody();
        }
        $ver = tasks_read_version($body);
        if ($ver !== null && $ver !== (int) $row['version']) {
            tasks_version_conflict($pdo, $id);
        }
        if ((int) $row['archived'] === 1) {
            sendJson(['success' => true, 'unchanged' => true, 'task' => tasks_fetch($pdo, $id)]);
        }
        $pdo->beginTransaction();
        try {
            $upd = $pdo->prepare(
                'UPDATE tasks SET archived = 1, version = version + 1, updated_at = :ts
                 WHERE id = :id AND version = :v'
            );
            $upd->execute([':ts' => now(), ':id' => $id, ':v' => (int) $row['version']]);
            if ($upd->rowCount() !== 1) {
                $pdo->rollBack();
                tasks_version_conflict($pdo, $id);
            }
            // V7 (решение владельца): при архивации вложения удаляются с сервера — записи здесь, файлы после commit.
            $gone = tf_delete_rows_for_task($pdo, $id);
            tasks_audit($pdo, 'task.archive', $id, [
                'title'        => $row['title'],
                'from_version' => (int) $row['version'],
                'to_version'   => (int) $row['version'] + 1,
            ] + ($gone['names'] !== [] ? ['attachments_deleted' => $gone['names']] : []));
            $pdo->commit();
            tf_unlink_all($gone['stored']);
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        sendJson(['success' => true, 'archived' => true, 'task' => tasks_fetch($pdo, $id)]);
    }

    // -----------------------------------------------------------------
    // PUT: правка / переназначение (version обязателен).
    // -----------------------------------------------------------------
    $body = getJsonBody();
    $ver = tasks_read_version($body);
    if ($ver === null) {
        tasks_fail('version_required');
    }
    if ($ver !== (int) $row['version']) {
        tasks_version_conflict($pdo, $id);
    }
    if ((int) $row['archived'] === 1) {
        tasks_fail('task_archived', 409);
    }

    [$people, $checks] = tasks_load_related($pdo, [$id]);
    $curAssignees = array_column($people[$id]['assignee'] ?? [], 'employee_id');
    $curWatchers = array_column($people[$id]['watcher'] ?? [], 'employee_id');

    $new = [
        'title'       => (string) $row['title'],
        'description' => $row['description'],
        'start_at'    => (string) $row['start_at'],
        'end_at'      => $row['end_at'],
        'priority'    => (int) $row['priority'],
        'label'       => $row['label'],
    ];
    if (array_key_exists('title', $body)) {
        $t = tasks_norm_text($body['title'], TASKS_TITLE_MAX, 'invalid_title');
        if ($t === null) {
            tasks_fail('title_required');
        }
        $new['title'] = $t;
    }
    if (array_key_exists('description', $body)) {
        $new['description'] = tasks_norm_text($body['description'], TASKS_DESC_MAX, 'invalid_description');
    }
    if (array_key_exists('label', $body)) {
        $new['label'] = tasks_norm_label($body['label']);
    }
    if (array_key_exists('priority', $body)) {
        $new['priority'] = tasks_norm_priority($body['priority']);
    }
    if (array_key_exists('start_at', $body)) {
        $new['start_at'] = $body['start_at'];
    }
    if (array_key_exists('end_at', $body)) {
        $new['end_at'] = ($body['end_at'] === '' ? null : $body['end_at']);
    }
    $period = tasks_validate_period($new['start_at'], $new['end_at']);
    if ($period['error'] !== null) {
        tasks_fail($period['error']);
    }

    $newAssignees = $curAssignees;
    $newWatchers = $curWatchers;
    if (array_key_exists('assignees', $body)) {
        $newAssignees = tasks_norm_ids($body['assignees'], 'assignees');
        if ($newAssignees === []) {
            tasks_fail('assignees_required');
        }
    }
    if (array_key_exists('watchers', $body)) {
        $newWatchers = tasks_norm_ids($body['watchers'], 'watchers');
    }
    $newWatchers = array_values(array_diff($newWatchers, $newAssignees));
    $sameSet = static function (array $a, array $b): bool {
        sort($a);
        sort($b);
        return $a === $b;
    };
    // T1-7 (D-1): при ИЗМЕНЕНИИ исполнителей все новые id должны существовать (удалённый id → 400
    // employee_not_found; переназначение = замена удалённого на нового). Без изменения набора
    // исполнителей удалённые остаются как есть.
    tasks_assert_employees($pdo, array_merge(
        $sameSet($newAssignees, $curAssignees) ? [] : $newAssignees,
        array_diff($newWatchers, $curWatchers)
    ));
    $newChecklist = array_key_exists('checklist', $body) ? tasks_norm_checklist($body['checklist']) : null;

    // V6.3-2 (Д-1): повторы. С телом `occurrences` — полная замена набора; без него — сохранённые повторы
    // пересчитываются под новый срок (вид «со временем/без», концы по новой длительности).
    $storedOcc = tasks_load_occurrences($pdo, [$id])[$id] ?? [];
    if (array_key_exists('occurrences', $body)) {
        $newOcc = tasks_norm_occurrences($body['occurrences'], (string) $new['start_at'], $new['end_at']);
    } else {
        $newOcc = $storedOcc === [] ? [] : tasks_recompute_occurrences($storedOcc, (string) $new['start_at'], $new['end_at']);
    }
    $occBeforeKeys = tasks_occurrence_keys($storedOcc);
    $occAfterKeys = tasks_occurrence_keys($newOcc);
    ksort($occBeforeKeys);
    ksort($occAfterKeys);
    $occChanged = $occBeforeKeys !== $occAfterKeys;

    // Что изменилось.
    $changed = [];
    foreach ($new as $k => $v) {
        $old = $k === 'priority' ? (int) $row[$k] : $row[$k];
        if ($v !== $old) {
            $changed[] = $k;
        }
    }
    $periodChanged = in_array('start_at', $changed, true) || in_array('end_at', $changed, true);
    $assigneesChanged = !$sameSet($newAssignees, $curAssignees);
    if ($assigneesChanged) {
        $changed[] = 'assignees';
    }
    if (!$sameSet($newWatchers, $curWatchers)) {
        $changed[] = 'watchers';
    }
    if ($newChecklist !== null) {
        $before = array_map(static fn($c) => [$c['text'], $c['done'] ? 1 : 0], $checks[$id] ?? []);
        $after = array_map(static fn($c) => [$c['text'], $c['done']], $newChecklist);
        if ($before !== $after) {
            $changed[] = 'checklist';
        }
    }
    if ($occChanged) {
        $changed[] = 'occurrences';
    }
    if ($changed === []) {
        sendJson(['success' => true, 'unchanged' => true, 'task' => tasks_fetch($pdo, $id)]);
    }

    $pdo->beginTransaction();
    try {
        $checkState = (string) $row['check_state'];
        if ($periodChanged || $assigneesChanged) {
            // FR-10 — только при смене срока/исполнителей: правка текста задачи,
            // у которой позже появился больничный (conflict), не блокируется.
            $checkState = tasks_enforce_fr10($pdo, $newAssignees, (string) $new['start_at'], $new['end_at']);
            // Смена исполнителей — проверяются все повторы; смена срока — те, у кого изменились начало/конец.
            $onlyNew = $assigneesChanged ? null : array_diff_key($occAfterKeys, $occBeforeKeys);
            if (tasks_enforce_occurrences($pdo, $newAssignees, $newOcc, $onlyNew) === 'pending') {
                $checkState = 'pending';
            }
        } elseif ($occChanged) {
            // Только повторы: проверяются новые/изменённые (прочие уже проходили проверку при сохранении).
            $onlyNew = array_diff_key($occAfterKeys, $occBeforeKeys);
            if (tasks_enforce_occurrences($pdo, $newAssignees, $newOcc, $onlyNew) === 'pending') {
                $checkState = 'pending';
            }
        }
        $ts = now();
        $upd = $pdo->prepare(
            'UPDATE tasks SET title = :title, description = :desc, start_at = :s, end_at = :e,
                    priority = :p, label = :label, check_state = :cs,
                    version = version + 1, updated_at = :ts
             WHERE id = :id AND version = :v'
        );
        $upd->execute([
            ':title' => $new['title'], ':desc' => $new['description'], ':s' => $new['start_at'],
            ':e' => $new['end_at'], ':p' => $new['priority'], ':label' => $new['label'],
            ':cs' => $checkState, ':ts' => $ts, ':id' => $id, ':v' => (int) $row['version'],
        ]);
        if ($upd->rowCount() !== 1) {
            $pdo->rollBack();
            tasks_version_conflict($pdo, $id);
        }
        if ($assigneesChanged || in_array('watchers', $changed, true)) {
            tasks_replace_people($pdo, $id, $newAssignees, $newWatchers);
        }
        if (in_array('checklist', $changed, true)) {
            tasks_sync_checklist($pdo, $id, $newChecklist);
        }
        if ($occChanged) {
            tasks_write_occurrences($pdo, $id, $newOcc);
        }
        $details = [
            'title'        => $new['title'],
            'changed'      => $changed,
            'from_version' => (int) $row['version'],
            'to_version'   => (int) $row['version'] + 1,
        ];
        if ($occChanged) {
            $details['occurrences_before'] = array_column($storedOcc, 'start_at');
            $details['occurrences_after'] = array_column($newOcc, 'start_at');
        }
        if ($assigneesChanged) {
            $details['assignees_before'] = $curAssignees;
            $details['assignees_after'] = $newAssignees;
        }
        if ($periodChanged) {
            $details['period_before'] = [$row['start_at'], $row['end_at']];
            $details['period_after'] = [$new['start_at'], $new['end_at']];
        }
        tasks_audit($pdo, 'task.update', $id, $details);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }
    sendJson(['success' => true, 'task' => tasks_fetch($pdo, $id)]);
} catch (Throwable $e) {
    error_log('[tasks] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    sendJson(['error' => 'server_error'], 500);
}
