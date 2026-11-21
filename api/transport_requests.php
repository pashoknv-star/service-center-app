<?php

declare(strict_types=1);

/**
 * transport_requests.php — модуль «Транспорт» (V10-T5): заявки на транспорт. Контракт — reports/V10/specs/CONTRACT.md «Часть 2».
 *
 * GET    api/transport_requests.php?id=<id>                         — любой авторизованный → {success, request}
 * GET    api/transport_requests.php[?from=YYYY-MM-DD&to=YYYY-MM-DD][&status=new|…[,…]] — {success, requests:[…], truncated}
 *          from/to — заявки с назначением, пересекающим диапазон дней (заявки без назначений при from/to не попадают);
 *          без from/to — все заявки (не больше TRQ_LIST_LIMIT, иначе truncated:true).
 * POST   api/transport_requests.php {title, subscriber?, address?, comment?, source?}     — admin, supervisor → 201 {success, request}
 * PUT    api/transport_requests.php?id= {version, title?, subscriber?, address?, comment?} — правка (can_edit) → {success, request}
 * PUT    api/transport_requests.php?id=&action=status {status, version}                     — смена статуса (can_edit) → {success, request}
 * DELETE — не поддержан (отмена — статусом cancelled) → 405.
 *
 * Элемент заявки: {id, display_no, title, subscriber, address, comment, status, source, external_id, created_by, created_by_name,
 * version, created_at, updated_at, assignments:[…], can_edit} (can_edit считает сервер: transport_can_edit_request()).
 *
 * Статусы (new | assigned | in_progress | done | cancelled). Ручные переходы (PUT ?action=status), всё прочее → 422 invalid_transition:
 *   new → cancelled;  assigned → in_progress | done | cancelled;  in_progress → done | cancelled;  done → new;  cancelled → new.
 *   new → assigned — только автоматически (transport_assignments.php: первое назначение); assigned/in_progress → new вручную нельзя
 *   (при удалении последнего назначения сервер возвращает new сам). Назначения при cancelled/done/возврате в new НЕ удаляются.
 *
 * Ошибки ({"error":"<код>"}): 401 unauthorized; 403 forbidden; 404 not_found; 405 method_not_allowed; 400 invalid_json / invalid_action;
 * 409 VERSION_CONFLICT (current_version, request); 422 id_required, version_required, invalid_version, invalid_title, invalid_subscriber,
 * invalid_address, invalid_comment, invalid_source, invalid_status, invalid_range, status_change_forbidden, invalid_transition (from, to);
 * 500 server_error; 503 busy. id, display_no, created_by, status и version — серверные поля: в POST/PUT они игнорируются
 * (кроме явного status ≠ new в POST → 422 invalid_status и status ≠ текущему в PUT → 422 status_change_forbidden).
 *
 * Каждая мутация пишет transport_journal в той же транзакции (BEGIN IMMEDIATE, transport_write()): request.create | request.update |
 * request.status. Изменение «вхолостую» — 200 без записи, version не растёт.
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/transport_lib.php';

handleOptions();

const TRQ_LIST_LIMIT = 2000;
const TRQ_TITLE_MAX = 300;
const TRQ_TEXT_MAX = 2000;
const TRQ_SOURCE_MAX = 50;

/** Ручные переходы статусов: из → [в]. */
const TRQ_TRANSITIONS = [
    'new'         => ['cancelled'],
    'assigned'    => ['in_progress', 'done', 'cancelled'],
    'in_progress' => ['done', 'cancelled'],
    'done'        => ['new'],
    'cancelled'   => ['new'],
];

/** id из запроса (?id=): непустая строка; иначе 422 id_required. */
function trq_require_id(): string
{
    $id = $_GET['id'] ?? '';
    if (!is_string($id) || trim($id) === '') {
        transport_fail('id_required', 422);
    }
    return $id;
}

/** Необязательный текст: null/'' → null; строка ≤ $max после trim; иначе 422 invalid_<поле>. */
function trq_norm_text(mixed $v, int $max, string $field): ?string
{
    if ($v === null) {
        return null;
    }
    if (!is_string($v)) {
        transport_fail('invalid_' . $field, 422);
    }
    $s = trim($v);
    if ($s === '') {
        return null;
    }
    if (mb_strlen($s) > $max) {
        transport_fail('invalid_' . $field, 422);
    }
    return $s;
}

/** Название: обязательная непустая строка ≤ TRQ_TITLE_MAX; иначе 422 invalid_title. */
function trq_norm_title(mixed $v): string
{
    if (!is_string($v)) {
        transport_fail('invalid_title', 422);
    }
    $s = trim($v);
    if ($s === '' || mb_strlen($s) > TRQ_TITLE_MAX) {
        transport_fail('invalid_title', 422);
    }
    return $s;
}

/** Заявка в публичном виде с назначениями и can_edit для текущего пользователя. */
function trq_view(PDO $pdo, array $row): array
{
    $asg = transport_assignments_of($pdo, [(string) $row['id']])[(string) $row['id']] ?? [];
    return transport_request_public($row, $asg, transport_can_edit_request($row, null, $pdo));
}

/** Поля заявки для журнала. */
function trq_snapshot(array $row): array
{
    return [
        'display_no' => $row['display_no'] === null ? null : (int) $row['display_no'],
        'title'      => (string) $row['title'],
        'subscriber' => $row['subscriber'],
        'address'    => $row['address'],
        'comment'    => $row['comment'],
        'status'     => (string) $row['status'],
        'source'     => $row['source'],
        'created_by' => $row['created_by'],
    ];
}

/** 409 VERSION_CONFLICT с актуальной заявкой — образец tasks_version_conflict(). */
function trq_version_conflict(PDO $pdo, string $id): never
{
    $cur = transport_fetch_request($pdo, $id);
    transport_fail('VERSION_CONFLICT', 409, [
        'current_version' => $cur !== null ? (int) $cur['version'] : null,
        'request'         => $cur !== null ? trq_view($pdo, $cur) : null,
    ]);
}

/** Заявка по ?id= для записи: 404, если нет; 403, если текущий пользователь её не правит. */
function trq_load_editable(PDO $pdo, string $id): array
{
    $row = transport_fetch_request($pdo, $id);
    if ($row === null) {
        transport_fail('not_found', 404);
    }
    if (!transport_can_edit_request($row, null, $pdo)) {
        transport_fail('forbidden', 403);
    }
    return $row;
}

/** Разбор даты YYYY-MM-DD из запроса; null — параметра нет; иначе 422 invalid_range. */
function trq_norm_day(mixed $v): ?string
{
    if ($v === null || $v === '') {
        return null;
    }
    if (!is_string($v) || preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) !== 1) {
        transport_fail('invalid_range', 422);
    }
    $d = DateTimeImmutable::createFromFormat('!Y-m-d', $v, new DateTimeZone('UTC'));
    if ($d === false || $d->format('Y-m-d') !== $v) {
        transport_fail('invalid_range', 422);
    }
    return $v;
}

// =====================================================================
// Операции
// =====================================================================

function trq_get(PDO $pdo): void
{
    if (isset($_GET['id'])) {
        $id = trq_require_id();
        $row = transport_fetch_request($pdo, $id);
        if ($row === null) {
            transport_fail('not_found', 404);
        }
        sendJson(['success' => true, 'request' => trq_view($pdo, $row)]);
    }

    $from = trq_norm_day($_GET['from'] ?? null);
    $to = trq_norm_day($_GET['to'] ?? null);
    if ($from !== null && $to !== null && $from > $to) {
        transport_fail('invalid_range', 422);
    }
    $statuses = [];
    $rawStatus = $_GET['status'] ?? '';
    if (!is_string($rawStatus)) {
        transport_fail('invalid_status', 422);
    }
    if ($rawStatus !== '') {
        foreach (explode(',', $rawStatus) as $s) {
            $s = trim($s);
            if (!in_array($s, TRANSPORT_REQUEST_STATUSES, true)) {
                transport_fail('invalid_status', 422);
            }
            $statuses[$s] = true;
        }
    }

    $where = [];
    $args = [];
    if ($statuses !== []) {
        $ph = [];
        foreach (array_keys($statuses) as $i => $s) {
            $ph[] = ':s' . $i;
            $args[':s' . $i] = $s;
        }
        $where[] = 'r.status IN (' . implode(',', $ph) . ')';
    }
    if ($from !== null || $to !== null) {
        $cond = 'a.request_id = r.id';
        if ($from !== null) {
            $cond .= ' AND a.end_at > :from';
            $args[':from'] = $from . 'T00:00';
        }
        if ($to !== null) {
            $cond .= ' AND a.start_at < :to';
            $args[':to'] = (new DateTimeImmutable($to, new DateTimeZone('UTC')))->modify('+1 day')->format('Y-m-d') . 'T00:00';
        }
        $where[] = "EXISTS (SELECT 1 FROM transport_assignments a WHERE $cond)";
    }
    $sql = 'SELECT r.* FROM transport_requests r' . ($where !== [] ? ' WHERE ' . implode(' AND ', $where) : '')
        . ' ORDER BY r.display_no DESC, r.id LIMIT ' . (TRQ_LIST_LIMIT + 1);
    $st = $pdo->prepare($sql);
    $st->execute($args);
    $rows = $st->fetchAll(PDO::FETCH_ASSOC);
    $truncated = count($rows) > TRQ_LIST_LIMIT;
    if ($truncated) {
        array_pop($rows);
    }
    $asg = transport_assignments_of($pdo, array_map(static fn(array $r): string => (string) $r['id'], $rows));
    $canCache = [];
    $items = [];
    foreach ($rows as $r) {
        $author = (string) ($r['created_by'] ?? '');
        if (!array_key_exists($author, $canCache)) {
            $canCache[$author] = transport_can_edit_request($r, null, $pdo);
        }
        $items[] = transport_request_public($r, $asg[(string) $r['id']] ?? [], $canCache[$author]);
    }
    sendJson(['success' => true, 'requests' => $items, 'truncated' => $truncated]);
}

function trq_create(PDO $pdo, array $body): void
{
    if (!in_array(transport_role(), ['admin', 'supervisor'], true)) {
        transport_fail('forbidden', 403);
    }
    $title = trq_norm_title($body['title'] ?? null);
    $subscriber = trq_norm_text($body['subscriber'] ?? null, TRQ_TEXT_MAX, 'subscriber');
    $address = trq_norm_text($body['address'] ?? null, TRQ_TEXT_MAX, 'address');
    $comment = trq_norm_text($body['comment'] ?? null, TRQ_TEXT_MAX, 'comment');
    $source = trq_norm_text($body['source'] ?? null, TRQ_SOURCE_MAX, 'source');
    if (array_key_exists('status', $body) && $body['status'] !== 'new' && $body['status'] !== null) {
        transport_fail('invalid_status', 422);   // статус при создании всегда new
    }
    $user = current_user() ?? [];
    $uid = transport_user_id();
    $uname = trim((string) ($user['display_name'] ?? '')) !== '' ? trim((string) $user['display_name']) : (string) ($user['username'] ?? $uid);

    $id = transport_write($pdo, function () use ($pdo, $title, $subscriber, $address, $comment, $source, $uid, $uname): string {
        $no = (int) $pdo->query('SELECT COALESCE(MAX(display_no), 0) + 1 FROM transport_requests')->fetchColumn();
        $id = genId('tr_');
        $ts = transport_ts();
        $pdo->prepare(
            "INSERT INTO transport_requests (id, display_no, title, subscriber, address, comment, status, source, external_id, version,
                                             created_by, created_by_name, created_at, updated_at)
             VALUES (:id, :no, :t, :sub, :adr, :com, 'new', :src, NULL, 1, :by, :byn, :ts, :ts)"
        )->execute([':id' => $id, ':no' => $no, ':t' => $title, ':sub' => $subscriber, ':adr' => $address, ':com' => $comment,
                    ':src' => $source, ':by' => $uid, ':byn' => $uname, ':ts' => $ts]);
        $row = transport_fetch_request($pdo, $id) ?? [];
        transport_journal_write($pdo, 'request.create', 'request', $id, null, trq_snapshot($row));
        return $id;
    });
    sendJson(['success' => true, 'request' => trq_view($pdo, transport_fetch_request($pdo, $id) ?? [])], 201);
}

function trq_update(PDO $pdo, array $body): void
{
    $id = trq_require_id();
    $row = trq_load_editable($pdo, $id);
    $ver = transport_read_version($body);
    if ($ver === null) {
        transport_fail('version_required', 422);
    }
    $new = [];
    if (array_key_exists('title', $body)) {
        $new['title'] = trq_norm_title($body['title']);
    }
    foreach (['subscriber', 'address', 'comment'] as $f) {
        if (array_key_exists($f, $body)) {
            $new[$f] = trq_norm_text($body[$f], TRQ_TEXT_MAX, $f);
        }
    }
    if (array_key_exists('status', $body) && $body['status'] !== null && $body['status'] !== $row['status']) {
        transport_fail('status_change_forbidden', 422);   // статус меняется только ?action=status
    }

    $out = transport_write($pdo, function () use ($pdo, $id, $ver, $new): array {
        $cur = transport_fetch_request($pdo, $id);
        if ($cur === null) {
            transport_fail('not_found', 404);
        }
        if (!transport_can_edit_request($cur, null, $pdo)) {
            transport_fail('forbidden', 403);
        }
        if ($ver !== (int) $cur['version']) {
            trq_version_conflict($pdo, $id);
        }
        $before = [];
        $after = [];
        foreach ($new as $f => $v) {
            if ($v !== $cur[$f]) {
                $before[$f] = $cur[$f];
                $after[$f] = $v;
            }
        }
        if ($after === []) {
            return $cur;   // ничего не изменилось: без записи, version не растёт, журнала нет
        }
        $upd = $pdo->prepare(
            'UPDATE transport_requests SET title = :t, subscriber = :sub, address = :adr, comment = :com,
                    version = version + 1, updated_at = :ts
             WHERE id = :id AND version = :v'
        );
        $upd->execute([
            ':t'   => $after['title'] ?? $cur['title'],
            ':sub' => array_key_exists('subscriber', $after) ? $after['subscriber'] : $cur['subscriber'],
            ':adr' => array_key_exists('address', $after) ? $after['address'] : $cur['address'],
            ':com' => array_key_exists('comment', $after) ? $after['comment'] : $cur['comment'],
            ':ts'  => transport_ts(),
            ':id'  => $id,
            ':v'   => (int) $cur['version'],
        ]);
        if ($upd->rowCount() !== 1) {
            trq_version_conflict($pdo, $id);
        }
        transport_journal_write($pdo, 'request.update', 'request', $id, $before, $after);
        return transport_fetch_request($pdo, $id) ?? $cur;
    });
    sendJson(['success' => true, 'request' => trq_view($pdo, $out)]);
}

function trq_status(PDO $pdo, array $body): void
{
    $id = trq_require_id();
    trq_load_editable($pdo, $id);
    $ver = transport_read_version($body);
    if ($ver === null) {
        transport_fail('version_required', 422);
    }
    $to = $body['status'] ?? null;
    if (!is_string($to) || !in_array($to, TRANSPORT_REQUEST_STATUSES, true)) {
        transport_fail('invalid_status', 422);
    }

    $out = transport_write($pdo, function () use ($pdo, $id, $ver, $to): array {
        $cur = transport_fetch_request($pdo, $id);
        if ($cur === null) {
            transport_fail('not_found', 404);
        }
        if (!transport_can_edit_request($cur, null, $pdo)) {
            transport_fail('forbidden', 403);
        }
        if ($ver !== (int) $cur['version']) {
            trq_version_conflict($pdo, $id);
        }
        $from = (string) $cur['status'];
        if (!in_array($to, TRQ_TRANSITIONS[$from] ?? [], true)) {
            transport_fail('invalid_transition', 422, ['from' => $from, 'to' => $to]);
        }
        $upd = $pdo->prepare('UPDATE transport_requests SET status = :s, version = version + 1, updated_at = :ts WHERE id = :id AND version = :v');
        $upd->execute([':s' => $to, ':ts' => transport_ts(), ':id' => $id, ':v' => (int) $cur['version']]);
        if ($upd->rowCount() !== 1) {
            trq_version_conflict($pdo, $id);
        }
        transport_journal_write($pdo, 'request.status', 'request', $id, ['status' => $from], ['status' => $to]);
        return transport_fetch_request($pdo, $id) ?? $cur;
    });
    sendJson(['success' => true, 'request' => trq_view($pdo, $out)]);
}

// =====================================================================
// Основной блок
// =====================================================================

transport_handle(function (): void {
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($method, ['GET', 'POST', 'PUT', 'DELETE'], true)) {
        transport_fail('method_not_allowed', 405);
    }
    require_auth();   // аноним → 401

    if ($method === 'DELETE') {
        transport_fail('method_not_allowed', 405);   // отмена — статусом cancelled
    }
    if ($method === 'GET') {
        trq_get($pdo);
        return;
    }

    $body = transport_read_body();
    if ($method === 'POST') {
        trq_create($pdo, $body);
        return;
    }
    // PUT
    $action = $_GET['action'] ?? '';
    if ($action === '') {
        trq_update($pdo, $body);
    } elseif ($action === 'status') {
        trq_status($pdo, $body);
    } else {
        transport_fail('invalid_action', 400);
    }
});
