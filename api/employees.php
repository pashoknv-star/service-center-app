<?php

declare(strict_types=1);

/**
 * employees.php — CRUD сотрудников.
 *
 *   GET ?id=<id>     — один сотрудник (с position и group через JOIN).
 *   GET (без id)     — список всех сотрудников с JOIN к positions и groups,
 *                      отсортированный по sort_order.
 *   POST             — создать (body: Employee), возвращает созданный объект
 *                      с id и timestamp'ами.
 *   PUT ?id=<id>     — обновить (body: поля для апдейта), updated_at = now.
 *   DELETE ?id=<id>  — удалить (каскадно через FK), подтверждение в body:
 *                      { confirm: true }.
 *
 * Схема сотрудника:
 *   { id, full_name, position_id, location, group_id, phone, photo_url,
 *     is_technical, requires_full_profile, sort_order, created_at, updated_at }
 *
 * Для совместимости с фронтендом поддерживаются camelCase алиасы:
 *   fullName, positionId, groupId, photoUrl, isTechnical, requiresFullProfile, sortOrder.
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
                // Один сотрудник с JOIN к position и group.
                $stmt = $pdo->prepare(
                    'SELECT e.id, e.full_name, e.position_id, e.location, e.group_id,
                            e.phone, e.photo_url, e.is_technical, e.requires_full_profile,
                            e.sort_order, e.created_at, e.updated_at,
                            p.name  AS position_name,
                            p.id    AS position_id_fk,
                            g.name  AS group_name,
                            g.id    AS group_id_fk
                     FROM employees e
                     LEFT JOIN positions p ON p.id = e.position_id
                     LEFT JOIN groups    g ON g.id = e.group_id
                     WHERE e.id = :id'
                );
                $stmt->bindValue(':id', $id, PDO::PARAM_STR);
                $stmt->execute();
                $emp = $stmt->fetch(PDO::FETCH_ASSOC);

                if (!$emp) {
                    error('Employee not found', 404);
                }
                sendJson(normalizeEmployee($emp));
            } else {
                // Список всех сотрудников с JOIN, отсортированный по sort_order.
                $rows = $pdo->query(
                    'SELECT e.id, e.full_name, e.position_id, e.location, e.group_id,
                            e.phone, e.photo_url, e.is_technical, e.requires_full_profile,
                            e.sort_order, e.created_at, e.updated_at,
                            p.name AS position_name,
                            g.name AS group_name
                     FROM employees e
                     LEFT JOIN positions p ON p.id = e.position_id
                     LEFT JOIN groups    g ON g.id = e.group_id
                     ORDER BY e.sort_order, e.full_name'
                )->fetchAll(PDO::FETCH_ASSOC);

                sendJson(array_map('normalizeEmployee', $rows));
            }
            break;

        // ===============================================================
        // POST — создать
        // ===============================================================
        case 'POST':
            require_auth();
            require_edit();
            $body = getJsonBody();
            $newId = $body['id'] ?? genId('emp_');
            $ts = now();

            $stmt = $pdo->prepare(
                'INSERT INTO employees
                    (id, full_name, position_id, location, group_id, phone, photo_url,
                     is_technical, requires_full_profile, sort_order, created_at, updated_at)
                 VALUES
                    (:id, :full_name, :position_id, :location, :group_id, :phone, :photo_url,
                     :is_technical, :requires_full_profile, :sort_order, :created_at, :updated_at)'
            );
            $stmt->bindValue(':id', $newId, PDO::PARAM_STR);
            $stmt->bindValue(':full_name', pickStr($body, ['full_name', 'fullName', 'name'], ''), PDO::PARAM_STR);
            $stmt->bindValue(':position_id', pickStr($body, ['position_id', 'positionId'], null), PDO::PARAM_STR);
            $stmt->bindValue(':location', pickStr($body, ['location'], null), PDO::PARAM_STR);
            $stmt->bindValue(':group_id', pickStr($body, ['group_id', 'groupId'], null), PDO::PARAM_STR);
            $stmt->bindValue(':phone', pickStr($body, ['phone'], null), PDO::PARAM_STR);
            $stmt->bindValue(':photo_url', pickStr($body, ['photo_url', 'photoUrl', 'photo'], null), PDO::PARAM_STR);
            $stmt->bindValue(':is_technical', strToBool(pickStr($body, ['is_technical', 'isTechnical'], false)) ? 1 : 0, PDO::PARAM_INT);
            $stmt->bindValue(':requires_full_profile', strToBool(pickStr($body, ['requires_full_profile', 'requiresFullProfile'], false)) ? 1 : 0, PDO::PARAM_INT);
            $stmt->bindValue(':sort_order', pickIntOrNull($body, ['sort_order', 'sortOrder']), PDO::PARAM_INT);
            $stmt->bindValue(':created_at', $ts, PDO::PARAM_STR);
            $stmt->bindValue(':updated_at', $ts, PDO::PARAM_STR);
            $stmt->execute();

            // E5: audit employee create with details
            $empDetails = [];
            foreach (['fullName', 'positionId', 'groupId'] as $k) {
                if (array_key_exists($k, $body)) {
                    $empDetails[$k] = $body[$k];
                }
            }
            try {
                audit($pdo, 'employee.create', null, null, 'employee', $newId, $empDetails ?: null);
            } catch (Throwable $_e) { /* non-critical */ }

            // Возвращаем созданный объект.
            $created = fetchEmployee($pdo, $newId);
            sendJson($created, 201);
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
            $ts = now();

            // Динамически строим SET-часть только для переданных полей.
            $fields = [];
            $params = [':updated_at' => $ts];

            $map = [
                'full_name'             => ['full_name', 'fullName', 'name'],
                'position_id'           => ['position_id', 'positionId'],
                'location'              => ['location'],
                'group_id'              => ['group_id', 'groupId'],
                'phone'                 => ['phone'],
                'photo_url'             => ['photo_url', 'photoUrl', 'photo'],
                'is_technical'          => ['is_technical', 'isTechnical'],
                'requires_full_profile' => ['requires_full_profile', 'requiresFullProfile'],
                'sort_order'            => ['sort_order', 'sortOrder'],
            ];
            foreach ($map as $col => $keys) {
                if (array_any_key_exists($keys, $body)) {
                    $val = pickStr($body, $keys, null);
                    if ($col === 'is_technical' || $col === 'requires_full_profile') {
                        $params[':' . $col] = strToBool($val) ? 1 : 0;
                    } elseif ($col === 'sort_order') {
                        $params[':' . $col] = pickIntOrNull($body, $keys);
                    } else {
                        $params[':' . $col] = $val;
                    }
                    $fields[] = "$col = :$col";
                }
            }

            if (empty($fields)) {
                error('No fields to update');
            }

            // E5: audit employee update — прочитать ДО обновления
            $beforeStmt = $pdo->prepare('SELECT full_name, position_id, group_id, phone, location FROM employees WHERE id = :id');
            $beforeStmt->bindValue(':id', $id, PDO::PARAM_STR);
            $beforeStmt->execute();
            $beforeRow = $beforeStmt->fetch(PDO::FETCH_ASSOC);

            $fields[] = 'updated_at = :updated_at';
            $params[':id'] = $id;

            $sql = 'UPDATE employees SET ' . implode(', ', $fields) . ' WHERE id = :id';
            $upStmt = $pdo->prepare($sql);
            // bindValue с явной типизацией для надёжности.
            foreach ($params as $k => $v) {
                if (is_int($v)) {
                    $upStmt->bindValue($k, $v, PDO::PARAM_INT);
                } else {
                    $upStmt->bindValue($k, $v, PDO::PARAM_STR);
                }
            }
            $upStmt->execute();

            if ($upStmt->rowCount() === 0) {
                // Проверяем, существует ли сотрудник вообще.
                if (!employeeExists($pdo, $id)) {
                    error('Employee not found', 404);
                }
            }

            // Формируем детали аудита по изменениям.
            try {
                if ($beforeRow && is_array($beforeRow)) {
                    $changes = [];
                    // Проверяем только поля, которые реально в payload (исключаем updated_at).
                    foreach ($fields as $field) {
                        $col = explode(' =', $field)[0];
                        if ($col === 'updated_at') {
                            continue;
                        }
                        if (array_key_exists(':' . $col, $params)) {
                            $newValue = $params[':' . $col];
                            $oldValue = $beforeRow[$col] ?? null;
                            if ($oldValue !== $newValue) {
                                $changes[$col] = $newValue;
                            }
                        }
                    }
                    $empDetails = ['changes' => $changes];
                } else {
                    $empDetails = ['changes' => []];
                }

                audit($pdo, 'employee.update', null, null, 'employee', $id, $empDetails ?: null);
            } catch (Throwable $_e) { /* non-critical */ }

            sendJson(fetchEmployee($pdo, $id));
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
            if (!employeeExists($pdo, $id)) {
                error('Employee not found', 404);
            }
            // E5: прочитать сотрудника ДО удаления для деталей аудита
            try {
                $delEmpStmt = $pdo->prepare('SELECT full_name FROM employees WHERE id = :id');
                $delEmpStmt->bindValue(':id', $id, PDO::PARAM_STR);
                $delEmpStmt->execute();
                $delEmpRow = $delEmpStmt->fetch(PDO::FETCH_ASSOC);
            } catch (Throwable $_e) {
                $delEmpRow = null;
            }
            // Каскадное удаление записей и балансов через FK ON DELETE CASCADE.
            $stmt = $pdo->prepare('DELETE FROM employees WHERE id = :id');
            $stmt->bindValue(':id', $id, PDO::PARAM_STR);
            $stmt->execute();

            // E5: audit employee delete с fullName
            $empDetails = [];
            if ($delEmpRow && is_array($delEmpRow) && !empty($delEmpRow['full_name'])) {
                $empDetails['fullName'] = $delEmpRow['full_name'];
            }
            try {
                audit($pdo, 'employee.delete', null, null, 'employee', $id, empty($empDetails) ? null : $empDetails);
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

/**
 * Нормализует строку сотрудника из БД к единому виду (camelCase + bools).
 */
function normalizeEmployee(array $r): array
{
    return [
        'id'                   => $r['id'],
        'fullName'             => $r['full_name'] ?? null,
        'positionId'           => $r['position_id'] ?? null,
        'positionName'         => $r['position_name'] ?? null,
        'location'             => $r['location'] ?? null,
        'groupId'              => $r['group_id'] ?? null,
        'groupName'            => $r['group_name'] ?? null,
        'phone'                => $r['phone'] ?? null,
        'photoUrl'             => $r['photo_url'] ?? null,
        'isTechnical'          => !empty($r['is_technical']),
        'requiresFullProfile'  => !empty($r['requires_full_profile']),
        'sortOrder'            => isset($r['sort_order']) ? (int) $r['sort_order'] : null,
        'createdAt'            => $r['created_at'] ?? null,
        'updatedAt'            => $r['updated_at'] ?? null,
    ];
}

/**
 * Получает сотрудника по id с JOIN.
 */
function fetchEmployee(PDO $pdo, string $id): array
{
    $stmt = $pdo->prepare(
        'SELECT e.id, e.full_name, e.position_id, e.location, e.group_id,
                e.phone, e.photo_url, e.is_technical, e.requires_full_profile,
                e.sort_order, e.created_at, e.updated_at,
                p.name AS position_name,
                g.name AS group_name
         FROM employees e
         LEFT JOIN positions p ON p.id = e.position_id
         LEFT JOIN groups    g ON g.id = e.group_id
         WHERE e.id = :id'
    );
    $stmt->bindValue(':id', $id, PDO::PARAM_STR);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        error('Employee not found after operation', 404);
    }
    return normalizeEmployee($row);
}

function employeeExists(PDO $pdo, string $id): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM employees WHERE id = :id');
    $stmt->bindValue(':id', $id, PDO::PARAM_STR);
    $stmt->execute();
    return (bool) $stmt->fetch();
}

/**
 * Берёт первое существующее строковое значение из массива ключей.
 */
function pickStr(array $body, array $keys, mixed $default = null): mixed
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $body)) {
            return $body[$k];
        }
    }
    return $default;
}

function pickIntOrNull(array $body, array $keys): ?int
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $body) && $body[$k] !== null) {
            return (int) $body[$k];
        }
    }
    return null;
}

function array_any_key_exists(array $keys, array $arr): bool
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $arr)) {
            return true;
        }
    }
    return false;
}
