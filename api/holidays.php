<?php

declare(strict_types=1);

/**
 * holidays.php — CRUD праздников (календарь выходных).
 *
 *   GET ?date=<date>     — один праздник (ключ — date).
 *   GET (без date)       — список всех праздников, отсортированный по date.
 *   POST                 — создать (body: { date, type, label }), возвращает объект.
 *   PUT ?date=<date>     — обновить (body: поля для апдейта).
 *   DELETE ?date=<date>  — удалить, подтверждение в body: { confirm: true }.
 *
 * Схема: { date, type, label }
 *   type: 'weekend' | 'holiday' | 'transferred_day_off' | 'working_weekend'
 *
 * Ключ сущности — date (PRIMARY KEY holidays.date).
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';

handleOptions();

try {
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    // Ключ праздника — date. Принимаем и id, и date для гибкости.
    $date = $_GET['date'] ?? $_GET['id'] ?? null;

    switch ($method) {
        // ===============================================================
        // GET
        // ===============================================================
        case 'GET':
            if ($date !== null) {
                $stmt = $pdo->prepare('SELECT date, type, label FROM holidays WHERE date = :date');
                $stmt->bindValue(':date', $date, PDO::PARAM_STR);
                $stmt->execute();
                $row = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$row) {
                    error('Holiday not found', 404);
                }
                sendJson(normalizeHoliday($row));
            } else {
                $rows = $pdo->query(
                    'SELECT date, type, label FROM holidays ORDER BY date'
                )->fetchAll(PDO::FETCH_ASSOC);
                sendJson(array_map('normalizeHoliday', $rows));
            }
            break;

        // ===============================================================
        // POST — создать
        // ===============================================================
        case 'POST':
            $body = getJsonBody();
            $dateVal = pickHolStr($body, ['date'], null);
            if ($dateVal === null) {
                error('Missing "date" field');
            }

            $stmt = $pdo->prepare(
                'INSERT INTO holidays (date, type, label)
                 VALUES (:date, :type, :label)'
            );
            $stmt->bindValue(':date', $dateVal, PDO::PARAM_STR);
            $stmt->bindValue(':type', pickHolStr($body, ['type'], 'holiday'), PDO::PARAM_STR);
            $stmt->bindValue(':label', pickHolStr($body, ['label'], null), PDO::PARAM_STR);
            $stmt->execute();

            // E5: audit holiday upsert
            try {
                audit($pdo, 'holiday.upsert', null, null, 'holiday', $dateVal);
            } catch (Throwable $_e) { /* non-critical */ }

            sendJson(fetchHoliday($pdo, $dateVal), 201);
            break;

        // ===============================================================
        // PUT — обновить
        // ===============================================================
        case 'PUT':
            if ($date === null) {
                error('Missing date parameter');
            }
            $body = getJsonBody();
            $fields = [];
            $params = [];

            $map = [
                'type'  => ['type'],
                'label' => ['label'],
            ];
            foreach ($map as $col => $keys) {
                if (anyHolKeyExists($keys, $body)) {
                    $params[':' . $col] = pickHolStr($body, $keys, null);
                    $fields[] = "$col = :$col";
                }
            }
            if (empty($fields)) {
                error('No fields to update');
            }
            $params[':date'] = $date;
            $sql = 'UPDATE holidays SET ' . implode(', ', $fields) . ' WHERE date = :date';
            $stmt = $pdo->prepare($sql);
            foreach ($params as $k => $v) {
                $stmt->bindValue($k, $v, PDO::PARAM_STR);
            }
            $stmt->execute();
            if ($stmt->rowCount() === 0 && !holidayExists($pdo, $date)) {
                error('Holiday not found', 404);
            }

            // E5: audit holiday update
            try {
                audit($pdo, 'holiday.upsert', null, null, 'holiday', $date);
            } catch (Throwable $_e) { /* non-critical */ }

            sendJson(fetchHoliday($pdo, $date));
            break;

        // ===============================================================
        // DELETE
        // ===============================================================
        case 'DELETE':
            if ($date === null) {
                error('Missing date parameter');
            }
            $body = getJsonBody();
            if (!strToBool($body['confirm'] ?? false)) {
                error('Confirmation required: pass { "confirm": true } in body');
            }
            if (!holidayExists($pdo, $date)) {
                error('Holiday not found', 404);
            }
            $stmt = $pdo->prepare('DELETE FROM holidays WHERE date = :date');
            $stmt->bindValue(':date', $date, PDO::PARAM_STR);
            $stmt->execute();

            // E5: audit holiday delete
            try {
                audit($pdo, 'holiday.delete', null, null, 'holiday', $date);
            } catch (Throwable $_e) { /* non-critical */ }

            sendJson(['success' => true, 'deletedDate' => $date]);
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

function normalizeHoliday(array $r): array
{
    return [
        'date'  => $r['date'],
        'type'  => $r['type'] ?? null,
        'label' => $r['label'] ?? null,
    ];
}

function fetchHoliday(PDO $pdo, string $date): array
{
    $stmt = $pdo->prepare('SELECT date, type, label FROM holidays WHERE date = :date');
    $stmt->bindValue(':date', $date, PDO::PARAM_STR);
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        error('Holiday not found after operation', 404);
    }
    return normalizeHoliday($row);
}

function holidayExists(PDO $pdo, string $date): bool
{
    $stmt = $pdo->prepare('SELECT 1 FROM holidays WHERE date = :date');
    $stmt->bindValue(':date', $date, PDO::PARAM_STR);
    $stmt->execute();
    return (bool) $stmt->fetch();
}

function pickHolStr(array $body, array $keys, mixed $default = null): mixed
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $body)) {
            return $body[$k];
        }
    }
    return $default;
}

function anyHolKeyExists(array $keys, array $arr): bool
{
    foreach ($keys as $k) {
        if (array_key_exists($k, $arr)) {
            return true;
        }
    }
    return false;
}
