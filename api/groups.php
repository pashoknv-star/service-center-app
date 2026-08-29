<?php

declare(strict_types=1);

/**
 * groups.php — CRUD групп (подразделений).
 *
 *   GET ?id=<id>     — одна группа.
 *   GET (без id)     — список всех групп, отсортированный по sort_order.
 *   POST             — создать (body: { name, sort_order }), возвращает созданный объект.
 *   PUT ?id=<id>     — обновить (body: поля для апдейта).
 *   DELETE ?id=<id>  — удалить, подтверждение в body: { confirm: true }.
 *
 * Схема: { id, name, sort_order }
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();

try {
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $id = $_GET['id'] ?? null;

    switch ($method) {
        // ===============================================================
        // GET
        // ===============================================================
        case 'GET':
            require_auth();
            if ($id !== null) {
                $stmt = $pdo->prepare('SELECT id, name, sort_order FROM groups WHERE id = :id');
                $stmt->bindValue(':id', $id, PDO::PARAM_STR);
                $stmt->execute();
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) {
                    error('Group not found', 404);
                }
                sendJson(normalizeGroup($row));
            } else {
                $rows = $pdo->query(
                    'SELECT id, name, sort_order FROM groups ORDER BY sort_order, name'
                )->fetchAll(PDO::FETCH_ASSOC);
                sendJson(array_map('normalizeGroup', $rows));
            }
            break;

        // ===============================================================
        // POST — создать
        // ===============================================================
        case 'POST':
            require_auth();
            require_edit();
            $body = getJsonBody();
            $newId = $body['id'] ?? genId('grp_');

            $stmt = $pdo->prepare(
                'INSERT INTO groups (id, name, sort_order)
                 VALUES (:id, :name, :sort_order)'
            );
            $stmt->bindValue(':id', $newId, PDO::PARAM_STR);
            $stmt->bindValue(':name', pickGroupStr($body, ['name'], ''), PDO::PARAM_STR);
            $stmt->bindValue(':sort_order', pickGroupIntOrNull($body, ['sort_order', 'sortOrder']), PDO::PARAM_INT);
            $stmt->execute();

            // E5: audit group upsert
            try {
                audit($pdo, 'group.upsert', null, null, 'group', $newId);
            } catch (Throwable $_e) { /* non-critical */ }

            sendJson(fetchGroup($pdo, $newId), 201);
            break;

        // ===============================================================
        // PUT — обновить
        // ===============================================================
        case 'PUT':
            require_auth();
            require_edit();
            if ($id === null) {
                error('Missing id parameter');
            }
            $body = getJsonBody();
            $fields = [];
            $params = [];

            $map = [
                'name'       => ['name'],
                'sort_order' => ['sort_order', 'sortOrder'],
            ];
            foreach ($map as $col => $keys) {
                if (anyGroupKeyExists($keys, $body)) {
                    if ($col === 'sort_order') {
                        $params[':' . $col] = pickGroupIntOrNull($body, $keys);
                    } else {
                        $params[':' . $col] = pickGroupStr($body, $keys, null);
                    }
                    $fields[] = "$col = :$col";
                }
            }
            if (empty($fields)) {
                error('No fields to update');
            }
            $params[':id'] = $id;
            $sql = 'UPDATE groups SET ' . implode(', ', $fields) . ' WHERE id = :id';
            $stmt = $pdo->prepare($sql);
            foreach ($params as $k => $v) {
                $stmt->bindValue($k, $v, is_int($v) ? PDO::PARAM_INT : PDO::PARAM_STR);
            }
            $stmt->execute();
            if ($stmt->rowCount() === 0 && !groupExists($pdo, $id)) {
                error('Group not found', 404);
            }

            // E5: audit group update
            try {
                audit($pdo, 'group.upsert', null, null, 'group', $id);
            } catch (Throwable $_e) { /* non-critical */ }

            sendJson(fetchGroup($pdo, $id));
            break;

        // ===============================================================
        // DELETE
        // ===============================================================
        case 'DELETE':
            require_auth();
            require_edit();
            if ($id === null) {
                error('Missing id parameter');
            }
            $body = getJsonBody();
            if (!strToBool($body['confirm'] ?? false)) {
                error('Confirmation required: pass { "confirm": true } in body');
            }
            if (!groupExists($pdo, $id)) {
                error('Group not found', 404);
            }
            // employees.group_id ON DELETE SET NULL — сотрудники останутся.
            $stmt = $pdo->prepare('DELETE FROM groups WHERE id = :id');
            $stmt->bindValue(':id', $id, PDO::PARAM_STR);
            $stmt->execute();

            // E5: audit group delete
            try {
                audit($pdo, 'group.delete', null, null, 'group', $id);
            } catch (Throwable $_e) { /* non-critical */ }

            sendJson(['success' => true, 'deletedId' => $id]);
            break;

        default:
            error('Method not allowed', 405);
    }
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}

// =====================================================================
// Helpers (локальные)
// =====================================================================

function normalizeGroup(array $r): array
{
    return [
        'id'        => $r['id'],
        'name'      => $r['name'] ?? null,
        'sortOrder' => isset($r['sort_order']) ? (int) $r['sort_order'] : null,
    ];
}

function fetchGroup(PDO $pdo, string $id): array
{
    $stmt = $pdo->prepare('SELECT id, name, sort_order FROM groups WHERE id = :id');
    $stmt->bindValue(':id', $id, PDO::PARAM_STR);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        error('Group not found after operation', 404);
    }
    return normalizeGroup($row);
}

function groupExists(PDO $pdo, string $id): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM groups WHERE id = :id');
    $stmt->bindValue(':id', $id, PDO::PARAM_STR);
    $stmt->execute();
    return (bool) $stmt->fetch();
}

function pickGroupStr(array $body, array $keys, mixed $default = null): mixed
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $body)) {
            return $body[$k];
        }
    }
    return $default;
}

function pickGroupIntOrNull(array $body, array $keys): ?int
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $body) && $body[$k] !== null) {
            return (int) $body[$k];
        }
    }
    return null;
}

function anyGroupKeyExists(array $keys, array $arr): bool
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $arr)) {
            return true;
        }
    }
    return false;
}
