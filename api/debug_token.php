<?php

/**
 * debug_token.php — диагностика Bearer token авторизации.
 *
 * Используйте для проверки, что токен работает и заголовок передаётся.
 */

header('Content-Type: application/json');

$authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '(not set)';
$providedToken = '';
$valid = false;
$error = null;

if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
    $providedToken = trim($m[1]);
} elseif ($authHeader !== '' && $authHeader !== '(not set)') {
    $providedToken = trim($authHeader);
}

$response = [
    'auth_header_raw' => $authHeader,
    'provided_token' => $providedToken,
    'provided_token_len' => strlen($providedToken),
];

if ($providedToken === '') {
    $response['valid'] = false;
    $response['error'] = 'missing_bearer_token';
    echo json_encode($response, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
    http_response_code(401);
    exit(0);
}

// Проверяем токен в БД
try {
    require_once __DIR__ . '/db.php';
    $db = Database::getInstance();
    $pdo = $db->getPDO();

    $stmt = $pdo->prepare("SELECT value FROM meta WHERE key = 'external_api_token' LIMIT 1");
    $stmt->execute();
    $row = $stmt->fetch();

    $storedToken = ($row && !empty($row['value'])) ? (string) $row['value'] : '';

    $response['stored_token_preview'] = substr($storedToken, 0, 8) . '...' . substr($storedToken, -8);
    $response['stored_token_len'] = strlen($storedToken);

    if ($storedToken === '' || !hash_equals($storedToken, $providedToken)) {
        $response['valid'] = false;
        $response['error'] = 'invalid_token';
        http_response_code(401);
    } else {
        $response['valid'] = true;
        $response['message'] = 'Token is valid';
        http_response_code(200);
    }
} catch (Throwable $e) {
    $response['valid'] = false;
    $response['error'] = 'database_error';
    $response['exception'] = $e->getMessage();
    http_response_code(500);
}

echo json_encode($response, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
