<?php

declare(strict_types=1);

// HF-2 (S-19/A-12): на проде display_errors=On -> Fatal с путями виден анониму.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
if (!headers_sent()) { header_remove('X-Powered-By'); }

/**
 * helpers.php — общие helper-функции для API Service Center App.
 *
 * Функции:
 *   corsHeaders()      — отправка CORS-заголовков.
 *   sendJson($data, $code) — отправка JSON-ответа с CORS-заголовками.
 *   requireMethod($method)  — проверка HTTP-метода (exit 405 при несоответствии).
 *   getJsonBody()      — чтение и декодирование JSON из тела запроса.
 *   now()              — текущее время в ISO 8601 UTC (date('c')).
 *   genId($prefix)     — генерация уникального ID (uniqid($prefix, true)).
 *   generateRequestId($tripId, $num) — ID заявки RPA-роботу (E12-2).
 *   error($msg, $code) — JSON-ошибка.
 *   strToBool()        — нормализация булевых значений из JSON.
 */

/**
 * Отправляет CORS-заголовки (разрешаем все источники для локальной разработки).
 */
function corsHeaders(): void
{
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
    header('Access-Control-Max-Age: 86400');
}

/**
 * Отправляет JSON-ответ с CORS-заголовками и завершает выполнение.
 *
 * @param mixed $data Данные для кодирования в JSON.
 * @param int   $code HTTP-статус код (по умолчанию 200).
 */
function sendJson(mixed $data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    corsHeaders();

    // JSON_UNESCAPED_UNICODE — чтобы кириллица выводилась как есть.
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

/**
 * Проверяет HTTP-метод запроса. При несоответствии отправляет 405 и завершает.
 *
 * @param string $method Ожидаемый метод (GET, POST, PUT, DELETE).
 */
function requireMethod(string $method): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== strtoupper($method)) {
        sendJson(['error' => 'Method not allowed'], 405);
    }
}

/**
 * Читает и декодирует JSON из тела запроса (php://input).
 *
 * @return array Распарсенный массив тела запроса.
 */
function getJsonBody(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        error('Invalid JSON body');
    }

    return $data;
}

/**
 * Возвращает текущее время в ISO 8601 (date('c')).
 *
 * @return string ISO-8601 timestamp.
 */
function now(): string
{
    return date('c');
}

/**
 * Генерирует уникальный ID с заданным префиксом.
 *
 * @param string $prefix Префикс ID (например 'emp_', 'grp_', 'pos_').
 * @return string Сгенерированный ID.
 */
function genId(string $prefix): string
{
    return uniqid($prefix, true);
}

/**
 * E12-2: ID заявки RPA-роботу (trip_requests.request_id).
 *
 * Формат: "SC-" + первые 4 символа trip id + "-" + номер участника + "-" + unixtime.
 * Пример: trip_6789ab.. -> "SC-trip-2-1759146000".
 *
 * Общая для trips.php (создание заявки при confirm) и trip_relay.php;
 * в trip_relay.php НЕ переопределять.
 *
 * @param string $tripId         ID командировки.
 * @param int    $participantNum Порядковый номер участника (1..N).
 */
function generateRequestId(string $tripId, int $participantNum): string
{
    return 'SC-' . substr($tripId, 0, 4) . '-' . $participantNum . '-' . time();
}

/**
 * Отправляет JSON-ошибку с заданным HTTP-кодом и завершает выполнение.
 *
 * @param string $msg  Сообщение об ошибке.
 * @param int    $code HTTP-статус код (по умолчанию 400).
 */
function error(string $msg, int $code = 400): void
{
    sendJson(['error' => $msg], $code);
}

/**
 * Нормализует значение к bool (принимает true/false/1/0/"1"/"0"/"true"/"false").
 *
 * @param mixed $v
 */
function strToBool(mixed $v): bool
{
    if (is_bool($v)) {
        return $v;
    }
    if (is_int($v)) {
        return $v !== 0;
    }
    if (is_string($v)) {
        return in_array(strtolower($v), ['1', 'true', 'yes', 'on'], true);
    }
    return (bool) $v;
}

// =====================================================================
// Аудит
// =====================================================================

/**
 * Записывает запись в таблицу audit_log.
 * Вызывается ТОЛЬКО внутри транзакции, когда PDO доступен.
 * Безопасно при отсутствующей таблице (CREATE TABLE IF NOT EXISTS).
 *
 * @param PDO   $pdo       Открытое соединение (внутри транзакции).
 * @param string $action    Действие: login / login_failed / logout /
 *                          password_change / entry.upsert / entry.delete /
 *                          employee.create / employee.update / employee.delete /
 *                          photo.upload / import.run / vacation_import.run /
 *                          reset.run / position.upsert / position.delete /
 *                          group.upsert / group.delete / holiday.upsert / holiday.delete
 * @param string $entityType Тип сущности: user / entry / employee / group / position / holiday / system
 * @param string|null $entityId ID сущности или null.
 * @param array|null $details Сопутствующие данные (JSON).
 */
function audit(PDO $pdo, string $action, ?string $actor = null, ?string $role = null, string $entityType = 'system', ?string $entityId = null, ?array $details = null): void
{
    // idempotent: создаём таблицу если нет
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS audit_log (" . PHP_EOL .
        "  id          INTEGER PRIMARY KEY AUTOINCREMENT," . PHP_EOL .
        "  ts          TEXT," . PHP_EOL .
        "  actor       TEXT," . PHP_EOL .
        "  role        TEXT," . PHP_EOL .
        "  action      TEXT," . PHP_EOL .
        "  entity_type TEXT," . PHP_EOL .
        "  entity_id   TEXT," . PHP_EOL .
        "  details     TEXT" . PHP_EOL .
        ")"
    );

    // Если actor не передан — берём из текущей сессии (если загружен auth).
    if ($actor === null || $actor === '') {
        try {
            $fnAvailable = function_exists('current_user');
            if ($fnAvailable) {
                $u = current_user();
                if (is_array($u) && !empty($u['username'])) {
                    $actor = (string) $u['username'];
                } else {
                    $actor = 'api';
                }
            } else {
                $actor = 'api';
            }
        } catch (Throwable $_e) {
            $actor = 'api';
        }
    }
    // Если роль не передана — определяем из текущего пользователя (если загружен auth).
    if ($role === null || $role === '') {
        try {
            $fnAvailable = function_exists('current_user') && function_exists('user_role');
            if ($fnAvailable) {
                $userForRole = current_user();
                if (is_array($userForRole)) {
                    $role = user_role($userForRole);
                } else {
                    $role = 'anonymous';
                }
            } else {
                $role = 'anonymous';
            }
        } catch (Throwable $_e) {
            $role = 'anonymous';
        }
    }
    $detailsJson = json_encode($details ?? [], JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    if ($detailsJson === false) {
        $detailsJson = '';
    }

    $ts = now();
    static $stmtAudit = null;
    if ($stmtAudit === null) {
        $stmtAudit = $pdo->prepare(
            'INSERT INTO audit_log (ts, actor, role, action, entity_type, entity_id, details)' . PHP_EOL .
            'VALUES (:ts, :actor, :role, :action, :entityType, :entityId, :details)'
        );
    }
    $stmtAudit->bindValue(':ts', $ts, PDO::PARAM_STR);
    $stmtAudit->bindValue(':actor', $actor, PDO::PARAM_STR);
    $stmtAudit->bindValue(':role', $role, PDO::PARAM_STR);
    $stmtAudit->bindValue(':action', $action, PDO::PARAM_STR);
    $stmtAudit->bindValue(':entityType', $entityType, PDO::PARAM_STR);
    $stmtAudit->bindValue(':entityId', $entityId, PDO::PARAM_STR);
    $stmtAudit->bindValue(':details', $detailsJson, PDO::PARAM_STR);
    $stmtAudit->execute();
    
    // Периодическая очистка audit_log с вероятностью 5%
    if (random_int(1, 20) === 1) {
        audit_cleanup($pdo);
    }
}

/**
 * Обработанный preflight CORS-запрос (OPTIONS) — отправляет заголовки и завершает.
 */
function handleOptions(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        corsHeaders();
        http_response_code(204);
        exit;
    }
}

/**
 * T1-7 (D-1): id открытых неархивных задач, где сотрудник — исполнитель (роль assignee).
 * Для аудита employee.delete (details.open_tasks) и GET tasks.php?open_for. Не бросает исключений
 * (нет таблиц задач / старая схема → пусто).
 *
 * @return string[]
 */
function tasks_open_ids_for_employee(PDO $pdo, string $employeeId): array
{
    try {
        $st = $pdo->prepare(
            "SELECT DISTINCT t.id FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id
             WHERE ta.employee_id = :e AND ta.role = 'assignee' AND t.status = 'open' AND t.archived = 0
             ORDER BY t.start_at, t.id"
        );
        $st->execute([':e' => $employeeId]);
        return array_map('strval', $st->fetchAll(PDO::FETCH_COLUMN));
    } catch (Throwable $_e) {
        return [];
    }
}

/**
 * T1-7 (D-1): обновить full_name_snapshot назначений сотрудника (переименование). Не бросает исключений.
 */
function tasks_refresh_name_snapshot(PDO $pdo, string $employeeId, string $fullName): void
{
    try {
        $pdo->prepare('UPDATE task_assignees SET full_name_snapshot = :n WHERE employee_id = :e')
            ->execute([':n' => $fullName, ':e' => $employeeId]);
    } catch (Throwable $_e) { /* non-critical */ }
}

/**
 * Очистка audit_log старше 7 дней — выполняется при каждом вызове.
 * Вызывается из audit() функции по случаю (5% мутаций).
 *
 * @param PDO $pdo Открытое соединение (внутри транзакции).
 */
function audit_cleanup(PDO $pdo): void
{
    try {
        $cutoffDate = gmdate('Y-m-d\TH:i:s+00:00', time() - 7*86400);
        $stmt = $pdo->prepare(
            "DELETE FROM audit_log WHERE ts < :cutoff"
        );
        $stmt->bindValue(':cutoff', $cutoffDate);
        $stmt->execute();

        // Логируем очистку для отладки
        error_log("E5-4: audit_cleanup удалено " . $stmt->rowCount() . " записей старше {$cutoffDate}");
    } catch (Throwable $e) {
        // Не прерываем основную операцию из-за ошибки очистки
        error_log("E5-4: audit_cleanup error: " . $e->getMessage());
    }
}
