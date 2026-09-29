<?php

declare(strict_types=1);

/**
 * trip_relay.php — relay-механизм E12-2: очередь заявок для RPA-робота (HelpMe).
 *
 * Аутентификация робота — ТОЛЬКО заголовок X-Auth-Token (D3: у робота нет
 * PHP-сессии, require_auth для poll/callback НЕ используется). Токен хранится
 * в meta['rpa_relay_token'] и создаётся лениво при первом обращении (D2).
 * Владелец видит токен через GET ?action=reveal под сессией admin/supervisor
 * (require_auth + require_edit); в обычных ответах relay токен НЕ возвращается.
 *
 * GET  api/trip_relay.php            — poll: старейшая queued-заявка ->
 *                                      status='delivered' + claimed_at,
 *                                      ответ 200 {requestId, payload}.
 *                                      Очередь пуста -> 200 {"requestId": null}.
 *                                      Каждая задача выдаётся ровно один раз.
 * POST api/trip_relay.php            — callback робота:
 *                                      body {requestId,
 *                                            status: 'created'|'validation_error'|'failed',
 *                                            ticketId?, reason?, attempt?}
 *                                      -> обновить (status, ticket_id,
 *                                      last_error, attempts, done_at),
 *                                      last-write-wins, 200 {"success":true}.
 * GET  api/trip_relay.php?action=reveal — токен под сессией admin/supervisor.
 *
 * Коды ошибок:
 *   401 {error: 'missing_token'}  — заголовка X-Auth-Token нет;
 *   401 {error: 'invalid_token'}  — токен не совпал;
 *   404 {error: 'request_not_found'} — requestId не существует;
 *   400 {error: 'invalid_status'} — статус callback не из допустимого набора.
 *
 * Payload — JSON-контракт v1.2 (HelpMe), замораживается в trips.php
 * PUT ?action=confirm (trips_build_rpa_payload()); request_id генерирует
 * generateRequestId() из helpers.php (здесь НЕ переопределяется).
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();

/**
 * Лениво создаёт и возвращает токен робота из meta['rpa_relay_token'] (D2).
 *
 * @param PDO $pdo
 */
function relay_ensure_token(PDO $pdo): string
{
    $stmt = $pdo->prepare(
        "INSERT OR IGNORE INTO meta (key, value)
         VALUES ('rpa_relay_token', :token)"
    );
    $stmt->bindValue(':token', bin2hex(random_bytes(32)), PDO::PARAM_STR);
    $stmt->execute();

    $row = $pdo->query(
        "SELECT value FROM meta WHERE key = 'rpa_relay_token' LIMIT 1"
    )->fetch(PDO::FETCH_ASSOC);

    return is_array($row) && isset($row['value']) ? (string) $row['value'] : '';
}

/**
 * Проверяет X-Auth-Token робота (единственная аутентификация poll/callback).
 * При отсутствии/несовпадении отправляет 401 и завершает выполнение.
 *
 * @param PDO $pdo
 */
function relay_check_token(PDO $pdo): void
{
    $token = $_SERVER['HTTP_X_AUTH_TOKEN'] ?? '';
    if (!is_string($token) || $token === '') {
        sendJson(['error' => 'missing_token'], 401);
    }
    $stmt = $pdo->prepare(
        "SELECT value FROM meta WHERE key = 'rpa_relay_token' LIMIT 1"
    );
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $expected = is_array($row) && isset($row['value']) ? (string) $row['value'] : '';
    // Токена в meta ещё нет — любой предъявленный токен неверен (создание
    // токена по требованию владельца: reveal под сессией).
    if ($expected === '' || !hash_equals($expected, $token)) {
        sendJson(['error' => 'invalid_token'], 401);
    }
}

try {
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    // Схема v8 (trip_requests) — идемпотентная миграция v7 -> v8.
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $action = isset($_GET['action']) ? (string) $_GET['action'] : '';

    // -----------------------------------------------------------------
    // reveal: показать токен владельцу (только сессия admin/supervisor).
    // -----------------------------------------------------------------
    if ($action === 'reveal') {
        require_auth();
        require_edit();
        sendJson([
            'success' => true,
            'token'   => relay_ensure_token($pdo),
        ]);
    }

    // -----------------------------------------------------------------
    // GET (poll): выдача старейшей queued-заявки, ровно один раз.
    // -----------------------------------------------------------------
    if ($method === 'GET') {
        relay_check_token($pdo);

        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare(
                "SELECT request_id, payload FROM trip_requests
                 WHERE status = 'queued'
                 ORDER BY created_at ASC, request_id ASC
                 LIMIT 1"
            );
            $stmt->execute();
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row === false) {
                $pdo->commit();
                sendJson(['requestId' => null]);
            }

            $upd = $pdo->prepare(
                "UPDATE trip_requests
                 SET status = 'delivered', claimed_at = :ts
                 WHERE request_id = :rid"
            );
            $upd->bindValue(':ts', now(), PDO::PARAM_STR);
            $upd->bindValue(':rid', (string) $row['request_id'], PDO::PARAM_STR);
            $upd->execute();

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        $payload = json_decode((string) $row['payload'], true);
        sendJson([
            'requestId' => (string) $row['request_id'],
            'payload'   => is_array($payload) ? $payload : null,
        ]);
    }

    // -----------------------------------------------------------------
    // POST (callback): результат обработки заявки роботом.
    // -----------------------------------------------------------------
    if ($method === 'POST') {
        relay_check_token($pdo);

        $body = getJsonBody();
        $requestId = isset($body['requestId']) ? trim((string) $body['requestId']) : '';
        if ($requestId === '') {
            sendJson(['error' => 'request_not_found'], 404);
        }

        $status = $body['status'] ?? null;
        if (!is_string($status)
            || !in_array($status, ['created', 'validation_error', 'failed'], true)) {
            sendJson(['error' => 'invalid_status'], 400);
        }

        // Заявка должна существовать.
        $stmt = $pdo->prepare(
            'SELECT request_id FROM trip_requests WHERE request_id = :rid LIMIT 1'
        );
        $stmt->bindValue(':rid', $requestId, PDO::PARAM_STR);
        $stmt->execute();
        if ($stmt->fetch(PDO::FETCH_COLUMN) === false) {
            sendJson(['error' => 'request_not_found'], 404);
        }

        $ticketId = isset($body['ticketId']) && $body['ticketId'] !== null
            ? (string) $body['ticketId'] : null;
        $reason = isset($body['reason']) && $body['reason'] !== null
            ? (string) $body['reason'] : null;
        $attempt = isset($body['attempt']) && is_int($body['attempt'])
            ? $body['attempt']
            : (is_string($body['attempt'] ?? null) && preg_match('/^\d+$/', (string) $body['attempt']) === 1
                ? (int) $body['attempt'] : 0);

        $upd = $pdo->prepare(
            'UPDATE trip_requests
             SET status = :status, ticket_id = :ticket_id, last_error = :last_error,
                 attempts = :attempts, done_at = :done_at
             WHERE request_id = :rid'
        );
        $upd->bindValue(':status', $status, PDO::PARAM_STR);
        $upd->bindValue(':ticket_id', $ticketId, PDO::PARAM_STR);
        $upd->bindValue(':last_error', $reason, PDO::PARAM_STR);
        $upd->bindValue(':attempts', $attempt, PDO::PARAM_INT);
        $upd->bindValue(':done_at', now(), PDO::PARAM_STR);
        $upd->bindValue(':rid', $requestId, PDO::PARAM_STR);
        $upd->execute();

        sendJson(['success' => true]);
    }

    sendJson(['error' => 'Method not allowed'], 405);
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}
