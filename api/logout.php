<?php

declare(strict_types=1);

/**
 * logout.php — POST: выход из системы.
 *
 * Уничтожает сессию, очищает $_SESSION.
 *
 * Возвращает: { success: true }
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/auth.php';

handleOptions();
requireMethod('POST');

// Очищаем сессию.
$_SESSION = [];

$oldUser = current_user();
$actorName = is_array($oldUser) && !empty($oldUser['username']) ? $oldUser['username'] : 'api';
$actorRole = is_array($oldUser) ? user_role($oldUser) : 'anonymous';

// Удаляем сессионную cookie, если она есть.
if (ini_get('session.use_cookies')) {
    $params = session_get_cookie_params();
    setcookie(
        session_name(),
        '',
        time() - 42000,
        $params['path'] ?? '/',
        $params['domain'] ?? '',
        $params['secure'] ?? false,
        $params['httponly'] ?? false
    );
}

// Уничтожаем сессию.
session_destroy();

// E5: audit logout
try {
    if (class_exists('Database', false)) {
        // Already required; get PDO to write audit
        $db = Database::getInstance();
        $pdo = $db->getPDO();
        audit($pdo, 'auth.logout', $actorName, $actorRole);
    }
} catch (Throwable $_e) {
    // Non-critical — don't break logout
}

sendJson(['success' => true]);
