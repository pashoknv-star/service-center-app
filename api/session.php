<?php

declare(strict_types=1);

/**
 * session.php — GET: текущая сессия.
 *
 * Возвращает:
 *   { authenticated: true,  user: { ... } }  — если залогинен
 *   { authenticated: false }                  — если не залогинен
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/auth.php';

handleOptions();
requireMethod('GET');

$user = current_user();

if ($user !== null) {
    sendJson([
        'authenticated' => true,
        'user'          => public_user($user),
    ]);
}

sendJson(['authenticated' => false]);
