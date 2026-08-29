<?php

declare(strict_types=1);

/**
 * change_password.php — POST: смена собственного пароля.
 *
 * Требует авторизации: любой залогиненный пользователь меняет СВОЙ пароль.
 *
 * Тело: { "currentPassword": string, "newPassword": string }
 *
 * Валидация:
 *   - currentPassword обязателен и должен совпадать с текущим паролем;
 *   - newPassword минимум 8 символов;
 *   - newPassword не должен совпадать с currentPassword.
 *
 * Ошибки:
 *   401 unauthorized       — не залогинен (require_auth);
 *   400 invalid_input      — currentPassword или newPassword не переданы;
 *   401 wrong_password     — текущий пароль неверен;
 *   400 password_too_short — новый пароль короче 8 символов;
 *   400 same_password      — новый пароль совпадает с текущим.
 *
 * При успехе:
 *   { success: true }
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();
requireMethod('POST');
require_auth();

try {
    $body = getJsonBody();

    $currentPassword = (string)($body['currentPassword'] ?? '');
    $newPassword     = (string)($body['newPassword'] ?? '');

    if ($currentPassword === '' || $newPassword === '') {
        sendJson(['success' => false, 'error' => 'invalid_input'], 400);
    }

    $user = current_user();

    // Текущий пароль должен совпадать.
    if (!password_verify($currentPassword, $user['password_hash'])) {
        sendJson(['success' => false, 'error' => 'wrong_password'], 401);
    }

    if (mb_strlen($newPassword) < 8) {
        sendJson(['success' => false, 'error' => 'password_too_short'], 400);
    }

    if ($newPassword === $currentPassword) {
        sendJson(['success' => false, 'error' => 'same_password'], 400);
    }

    $db  = Database::getInstance();
    $pdo = $db->getPDO();

    $hash = password_hash($newPassword, PASSWORD_DEFAULT);

    $stmt = $pdo->prepare('UPDATE users SET password_hash = :hash WHERE id = :id');
    $stmt->execute([':hash' => $hash, ':id' => $user['id']]);

    // E5: audit password change
    $username = $user['username'] ?? '';
    $role = user_role($user);
    audit($pdo, 'auth.password_change', null, null, 'user', $username);

    sendJson(['success' => true]);
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}
