<?php

declare(strict_types=1);

/**
 * positions.php — CRUD должностей.
 *
 *   GET ?id=<id>     — одна должность.
 *   GET (без id)     — список всех должностей, отсортированный по sort_order.
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
                $stmt = $pdo->prepare('SELECT id, name, sort_order FROM positions WHERE id = :id');
                $stmt->bindValue(':id', $id, PDO::PARAM_STR);
                $stmt->execute();
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) {
                    error('Position not found', 404);
                }
                sendJson(normalizePosition($row));
            } else {
                $rows = $pdo->query(
                    'SELECT id, name, sort_order FROM positions ORDER BY sort_order, name'
                )->fetchAll(PDO::FETCH_ASSOC);
                sendJson(array_map('normalizePosition', $rows));
            }
            break;

        // ===============================================================
        // POST — создать
        // ===============================================================
        case 'POST':
            require_auth();
            require_edit();
            $body = getJsonBody();
            $newId = $body['id'] ?? genId('pos_');

            $stmt = $pdo->prepare(
                'INSERT INTO positions (id, name, sort_order)
                 VALUES (:id, :name, :sort_order)'
            );
            $stmt->bindValue(':id', $newId, PDO::PARAM_STR);
            $stmt->bindValue(':name', pickPosStr($body, ['name'], ''), PDO::PARAM_STR);
            $stmt->bindValue(':sort_order', pickPosIntOrNull($body, ['sort_order', 'sortOrder']), PDO::PARAM_INT);
            $stmt->execute();

            // E5: audit position upsert
            try {
                audit($pdo, 'position.upsert', null, null, 'position', $newId);
            } catch (Throwable $_e) { /* non-critical */ }

            sendJson(['success' => true, 'position' => fetchPosition($pdo, $newId)], 201);
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
                if (anyPosKeyExists($keys, $body)) {
                    if ($col === 'sort_order') {
                        $params[':' . $col] = pickPosIntOrNull($body, $keys);
                    } else {
                        $params[':' . $col] = pickPosStr($body, $keys, null);
                    }
                    $fields[] = "$col = :$col";
                }
            }
            if (empty($fields)) {
                error('No fields to update');
            }
            $params[':id'] = $id;
            $sql = 'UPDATE positions SET ' . implode(', ', $fields) . ' WHERE id = :id';
            $stmt = $pdo->prepare($sql);
            foreach ($params as $k => $v) {
                $stmt->bindValue($k, $v, is_int($v) ? PDO::PARAM_INT : PDO::PARAM_STR);
            }
            $stmt->execute();
            if ($stmt->rowCount() === 0 && !positionExists($pdo, $id)) {
                error('Position not found', 404);
            }

            // E5: audit position update
            try {
                audit($pdo, 'position.upsert', null, null, 'position', $id);
            } catch (Throwable $_e) { /* non-critical */ }

            sendJson(fetchPosition($pdo, $id));
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
            if (!positionExists($pdo, $id)) {
                error('Position not found', 404);
            }
            // employees.position_id ON DELETE SET NULL — сотрудники останутся.
            $stmt = $pdo->prepare('DELETE FROM positions WHERE id = :id');
            $stmt->bindValue(':id', $id, PDO::PARAM_STR);
            $stmt->execute();

            // E5: audit position delete
            try {
                audit($pdo, 'position.delete', null, null, 'position', $id);
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

function normalizePosition(array $r): array
{
    return [
        'id'        => $r['id'],
        'name'      => $r['name'] ?? null,
        'sortOrder' => isset($r['sort_order']) ? (int) $r['sort_order'] : null,
    ];
}

function fetchPosition(PDO $pdo, string $id): array
{
    $stmt = $pdo->prepare('SELECT id, name, sort_order FROM positions WHERE id = :id');
    $stmt->bindValue(':id', $id, PDO::PARAM_STR);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        error('Position not found after operation', 404);
    }
    return normalizePosition($row);
}

function positionExists(PDO $pdo, string $id): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM positions WHERE id = :id');
    $stmt->bindValue(':id', $id, PDO::PARAM_STR);
    $stmt->execute();
    return (bool) $stmt->fetch();
}

function pickPosStr(array $body, array $keys, mixed $default = null): mixed
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $body)) {
            return $body[$k];
        }
    }
    return $default;
}

function pickPosIntOrNull(array $body, array $keys): ?int
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $body) && $body[$k] !== null) {
            return (int) $body[$k];
        }
    }
    return null;
}

function anyPosKeyExists(array $keys, array $arr): bool
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $arr)) {
            return true;
        }
    }
    return false;
}
