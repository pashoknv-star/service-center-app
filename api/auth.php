<?php

declare(strict_types=1);

/**
 * auth.php — middleware авторизации для Service Center App.
 *
 * Сессии: PHP session (cookie PHPSESSID).
 * Роли:   admin (isAdmin=1), supervisor (canEdit=1), viewer (остальные).
 *
 * Функции:
 *   current_user()          — ?array: текущий пользователь или null.
 *   is_logged_in()          — bool.
 *   require_auth()          — void: exit 401 если не залогинен.
 *   require_edit()          — void: exit 403 если нет прав на редактирование.
 *   require_admin()         — void: exit 403 если не admin.
 *   can_edit_group($groupId) — bool: проверка прав на конкретную группу/зону.
 *   require_group_edit($groupId) — void: exit 403 если нельзя редактировать группу.
 *   user_role($row)         — string: 'admin' | 'supervisor' | 'viewer'.
 *   public_user($row)       — array: безопасный публичный профиль пользователя.
 */

require_once __DIR__ . '/helpers.php';

// Запускаем сессию, если ещё не запущена.
if (session_status() !== PHP_SESSION_ACTIVE) {
    // Харденинг session cookie (обязательно ДО session_start()):
    // - httponly=true   — cookie недоступна из JavaScript (защита от кражи сессии через XSS);
    // - samesite='Lax'  — базовая защита от CSRF (cookie не уходит в cross-site POST-запросы);
    // - secure=false    — прод работает по HTTP без SSL: secure=true сломал бы логины;
    // - path='/'        — cookie действует на весь сайт.
    session_set_cookie_params([
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => false,
        'path'     => '/',
    ]);
    session_start();
}

/**
 * Загружает пользователя из БД по id, сохранённому в сессии.
 * Возвращает ассоциативный массив или null.
 *
 * @return array|null
 */
function current_user(): ?array
{
    // Ленивая инициализация — кэшируем результат в статике.
    static $cached = null;
    static $loaded = false;

    if ($loaded) {
        return $cached;
    }
    $loaded = true;

    $userId = $_SESSION['user_id'] ?? null;
    if (!$userId) {
        return null;
    }

    try {
        require_once __DIR__ . '/db.php';
        $pdo = Database::getInstance()->getPDO();
        $stmt = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => $userId]);
        $row = $stmt->fetch();
        $cached = $row ?: null;
        return $cached;
    } catch (Throwable $e) {
        return null;
    }
}

/**
 * Залогинен ли текущий пользователь.
 */
function is_logged_in(): bool
{
    return current_user() !== null;
}

/**
 * Определяет роль по строке БД.
 *
 * @param array $row Строка из users.
 * @return string 'admin' | 'supervisor' | 'viewer'
 */
function user_role(array $row): string
{
    if (!empty($row['is_admin'])) {
        return 'admin';
    }
    if (!empty($row['can_edit'])) {
        return 'supervisor';
    }
    return 'viewer';
}

/**
 * Строит безопасный публичный профиль (без password_hash).
 *
 * @param array $row Строка из users.
 * @return array
 */
function public_user(array $row): array
{
    return [
        'id'            => $row['id'] ?? null,
        'username'      => $row['username'] ?? null,
        'displayName'   => $row['display_name'] ?? null,
        'role'          => user_role($row),
        'canEdit'       => !empty($row['can_edit']),
        'isAdmin'       => !empty($row['is_admin']),
        'scopeGroupId'  => $row['scope_group_id'] ?? null,
    ];
}

/**
 * Требует залогиненного пользователя, иначе 401.
 */
function require_auth(): void
{
    if (!is_logged_in()) {
        sendJson(['error' => 'unauthorized'], 401);
    }
}

/**
 * Требует прав на редактирование (admin или supervisor), иначе 403.
 */
function require_edit(): void
{
    $user = current_user();
    if ($user === null) {
        sendJson(['error' => 'unauthorized'], 401);
    }
    if (empty($user['is_admin']) && empty($user['can_edit'])) {
        sendJson(['error' => 'forbidden'], 403);
    }
}

/**
 * Требует роли admin, иначе 403 (или 401 если не залогинен).
 */
function require_admin(): void
{
    $user = current_user();
    if ($user === null) {
        sendJson(['error' => 'unauthorized'], 401);
    }
    if (empty($user['is_admin'])) {
        sendJson(['error' => 'forbidden'], 403);
    }
}

/**
 * Может ли текущий пользователь редактировать указанную группу/зону?
 *
 * @param string|null $groupId ID группы, или null для "любой группы" (только admin).
 * @return bool
 */
function can_edit_group(?string $groupId): bool
{
    $user = current_user();
    if ($user === null) {
        return false;
    }

    // admin → true всегда
    if (!empty($user['is_admin'])) {
        return true;
    }

    // viewer → false
    if (empty($user['can_edit'])) {
        return false;
    }

    // supervisor → только своя зона
    $scope = $user['scope_group_id'] ?? null;
    if ($scope === null) {
        return false;
    }
    return $groupId !== null && $groupId === $scope;
}

/**
 * Требует прав на редактирование конкретной группы, иначе 403.
 *
 * @param string|null $groupId
 */
function require_group_edit(?string $groupId): void
{
    if (!is_logged_in()) {
        sendJson(['error' => 'unauthorized'], 401);
    }
    if (!can_edit_group($groupId)) {
        sendJson(['error' => 'forbidden'], 403);
    }
}
