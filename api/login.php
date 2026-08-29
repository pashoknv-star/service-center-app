<?php

declare(strict_types=1);

/**
 * login.php — POST: аутентификация пользователя.
 *
 * Тело: { "username": string, "password": string }
 *
 * При успехе:
 *   { success: true, user: { id, username, displayName, role, canEdit, isAdmin, scopeGroupId } }
 *
 * При неудаче (HTTP 401):
 *   { success: false, error: "invalid_credentials" }
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();
requireMethod('POST');

try {
    $body = getJsonBody();

    $username = trim((string)($body['username'] ?? ''));
    $password = (string)($body['password'] ?? '');

    if ($username === '' || $password === '') {
        sendJson(['success' => false, 'error' => 'invalid_credentials'], 401);
    }

    $db  = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $stmt = $pdo->prepare('SELECT * FROM users WHERE username = :username LIMIT 1');
    $stmt->execute([':username' => $username]);
    $row = $stmt->fetch();

    // Нет пользователя или неверный пароль.
    if (!$row || !password_verify($password, $row['password_hash'])) {
        // E5: audit login failed
        audit($pdo, 'auth.login_failed', null, null, 'user', $username, ['ip' => $_SERVER['REMOTE_ADDR'] ?? '']);
        sendJson(['success' => false, 'error' => 'invalid_credentials'], 401);
    }

    // Устанавливаем сессию.
    session_regenerate_id(true);
    $_SESSION['user_id'] = $row['id'];

    // E5: audit successful login
    audit($pdo, 'auth.login', null, null, 'user', $username);

    sendJson([
        'success' => true,
        'user'    => public_user($row),
    ]);
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}
