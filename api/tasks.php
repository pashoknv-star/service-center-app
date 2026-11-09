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
 * Время — локальное +05, ISO без смещения. check_state: 'ok' | 'pending'
 * (n8n, T1-4: см. tasks_check_period_checked() — вердикт tasks-validate, при недоступности
 * PHP-fallback + 'pending'; перепроверка pending — tasks_recheck_pending() после ответа на чтение списка,
 * не чаще раза в 15 мин). Настройка n8n — только окружение (TASKS_*_WEBHOOK_*, TASKS_N8N_WEBHOOK_SECRET).
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/tasks_rules.php';

handleOptions();

const TASKS_TITLE_MAX = 200;
const TASKS_DESC_MAX = 5000;
const TASKS_LABEL_MAX = 50;
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
 * затем выполняет $after (фоновая работа, напр. вызов n8n с таймаутом 3 с) и выходит.
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
        "SELECT ta.task_id, ta.employee_id, ta.role, e.full_name
         FROM task_assignees ta LEFT JOIN employees e ON e.id = ta.employee_id
         WHERE ta.task_id IN ($in)
         ORDER BY e.sort_order, e.full_name, ta.employee_id"
    );
    $stmt->execute($ids);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        // Намеренно ТОЛЬКО id и full_name — без phone/photo_url.
        $people[(string) $r['task_id']][(string) $r['role']][] = [
            'employee_id' => (string) $r['employee_id'],
            'full_name'   => $r['full_name'] !== null ? (string) $r['full_name'] : null,
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
 * Собирает задачу для ответа с вычисляемыми полями:
 * first_day, last_day, days[], conflict (+conflict_days), notes[].
 */
function tasks_build(PDO $pdo, array $row, array $people, array $checks): array
{
    $id = (string) $row['id'];
    $assignees = $people[$id]['assignee'] ?? [];
    $watchers = $people[$id]['watcher'] ?? [];
    $p = tasks_validate_period($row['start_at'], $row['end_at']);
    $days = $p['error'] === null ? $p['days'] : [];
    $first = $p['error'] === null ? $p['first_day'] : substr((string) $row['start_at'], 0, 10);
    $last = $p['error'] === null ? $p['last_day'] : $first;

    $conflictDays = [];
    $notes = [];
    if ($days !== []) {
        $assigneeIds = array_column($assignees, 'employee_id');
        $facts = tasks_matrix_facts($pdo, $assigneeIds, $first, $last);
        // conflict — только у ОТКРЫТОЙ неархивной задачи (AC-4).
        if ($row['status'] === 'open' && (int) $row['archived'] === 0) {
            $conflictDays = tasks_blocked_from_facts($facts, $first, $last);
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
        'status'        => (string) $row['status'],
        'check_state'   => (string) $row['check_state'],
        'version'       => (int) $row['version'],
        'created_by'    => $row['created_by'],
        'created_at'    => $row['created_at'],
        'updated_at'    => $row['updated_at'],
        'closed_at'     => $row['closed_at'],
        'archived'      => (int) $row['archived'],
        'assignees'     => $assignees,
        'watchers'      => $watchers,
        'checklist'     => $checks[$id] ?? [],
        'first_day'     => $first,
        'last_day'      => $last,
        'days'          => $days,
        'conflict'      => $conflictDays !== [],
        'conflict_days' => $conflictDays,
        'notes'         => $notes,
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
function tasks_enforce_fr10(PDO $pdo, array $assigneeIds, string $startAt, ?string $endAt): string
{
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
    tasks_fail('TASK_BLOCKED_BY_SICK_OR_TRIP', 422, [
        'blocked_days'    => $res['blocked_days'],
        'suggested_start' => $sugStart,
        'suggested_end'   => $sugEnd,
    ]);
}

// =====================================================================
// Запись связанных данных
// =====================================================================

function tasks_replace_people(PDO $pdo, string $taskId, array $assignees, array $watchers): void
{
    $pdo->prepare('DELETE FROM task_assignees WHERE task_id = :t')->execute([':t' => $taskId]);
    $ins = $pdo->prepare('INSERT INTO task_assignees (task_id, employee_id, role) VALUES (:t, :e, :r)');
    foreach ($assignees as $e) {
        $ins->execute([':t' => $taskId, ':e' => $e, ':r' => 'assignee']);
    }
    foreach ($watchers as $e) {
        $ins->execute([':t' => $taskId, ':e' => $e, ':r' => 'watcher']);
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
        if ($to !== null && $to !== '') {
            $where[] = 'substr(t.start_at, 1, 10) <= :to';
            $params[':to'] = $to;
        }
        if ($from !== null && $from !== '') {
            $where[] = 'COALESCE(substr(t.end_at, 1, 10), substr(t.start_at, 1, 10)) >= :from';
            $params[':from'] = $from;
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
        $tasks = [];
        foreach ($rows as $r) {
            $tasks[] = tasks_build($pdo, $r, $people, $checks);
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
        $label = tasks_norm_text($body['label'] ?? null, TASKS_LABEL_MAX, 'invalid_label');
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
        tasks_assert_employees($pdo, array_merge($assignees, $watchers));

        $user = current_user();
        $username = is_array($user) && !empty($user['username']) ? (string) $user['username'] : 'api';

        $pdo->beginTransaction();
        try {
            // FR-10 внутри транзакции: проверка и вставка согласованы.
            $checkState = tasks_enforce_fr10($pdo, $assignees, (string) $startAt, $endAt);

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
            tasks_audit($pdo, 'task.create', $newId, [
                'title'       => $title,
                'start_at'    => $startAt,
                'end_at'      => $endAt,
                'assignees'   => $assignees,
                'watchers'    => $watchers,
                'check_state' => $checkState,
            ]);
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
            tasks_audit($pdo, 'task.archive', $id, [
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
        $new['label'] = tasks_norm_text($body['label'], TASKS_LABEL_MAX, 'invalid_label');
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
    tasks_assert_employees($pdo, array_merge(
        array_diff($newAssignees, $curAssignees),
        array_diff($newWatchers, $curWatchers)
    ));
    $newChecklist = array_key_exists('checklist', $body) ? tasks_norm_checklist($body['checklist']) : null;

    // Что изменилось.
    $sameSet = static function (array $a, array $b): bool {
        sort($a);
        sort($b);
        return $a === $b;
    };
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
        $details = [
            'title'        => $new['title'],
            'changed'      => $changed,
            'from_version' => (int) $row['version'],
            'to_version'   => (int) $row['version'] + 1,
        ];
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
