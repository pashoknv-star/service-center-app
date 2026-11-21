<?php

declare(strict_types=1);

/**
 * transport_lib.php — внутренняя библиотека модуля «Транспорт» (V10, схема v15). НЕ HTTP-эндпоинт.
 * Контракт — reports/V10/specs/CONTRACT.md; подключается из api/transport_vehicles.php (T1) и
 * будущих transport_requests.php / transport_assignments.php / transport_board.php / transport_journal.php.
 *
 * Роли и права (решения владельца 2026-11-21, 00_COMMON.md):
 *   transport_role()              — 'admin' | 'supervisor' | 'viewer' | '' (нет пользователя); через user_role() (auth.php).
 *   transport_user_id()           — users.id текущего пользователя ('' — нет).
 *   transport_can_move_vehicle()  — перенос ТС между базами: admin ИЛИ viewer (исключение из «viewer только читает»).
 *   transport_can_edit_request()  — правка заявки: admin — любая; supervisor — свои (created_by = users.id) и заявки
 *                                   пользователей из TRANSPORT_EDIT_DELEGATION; viewer — никогда.
 *   Параметр $user (строка users) необязателен: null — текущий пользователь сессии (current_user()).
 *
 * Допустимые водители: transport_allowed_drivers() — единый источник (группа с названием «Транспорт» ∪ transport_driver_pool).
 * Журнал: transport_journal_write() — вставка в transport_journal ВНУТРИ транзакции вызывающего (откат мутации откатывает запись).
 * Время: transport_now_local() — 'YYYY-MM-DDTHH:MM' в +05; шаг 15 минут — transport_check_step().
 * Ошибки API: TransportApiError / transport_fail() / transport_handle() (формат {"error":"<код>", …}, как tasks.php).
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

/**
 * Карта делегирования правки заявок: ЛОГИН правящего supervisor → логины авторов, чьи заявки он тоже правит.
 * По слову владельца supervisor_zone0 правит свои заявки и заявки supervisor_zone1; обратного права нет; прочих записей нет.
 * Меняется только здесь (код/addendum к контракту), интерфейса для карты нет.
 */
const TRANSPORT_EDIT_DELEGATION = [
    'supervisor_zone0' => ['supervisor_zone1'],
];

/** Название группы допустимых водителей (поиск по НАЗВАНИЮ, не по id g6; регистр и пробелы не важны). */
const TRANSPORT_DRIVER_GROUP_NAME = 'Транспорт';
/** Шаг времени модуля: стоянки, время в пути, длительность назначения — кратны 15 минутам. */
const TRANSPORT_STEP_MIN = 15;
/** Смещение рабочего часового пояса модуля (локальное время +05, без перехода на летнее). */
const TRANSPORT_TZ_OFFSET = '+05:00';

// =====================================================================
// Ошибки API
// =====================================================================

/** Ошибка API с кодом (в JSON — поле error), HTTP-статусом и дополнительными полями ответа. */
final class TransportApiError extends RuntimeException
{
    public string $errorCode;
    public int $http;
    /** @var array<string,mixed> */
    public array $extra;

    /** @param array<string,mixed> $extra */
    public function __construct(string $errorCode, int $http = 400, array $extra = [])
    {
        parent::__construct($errorCode);
        $this->errorCode = $errorCode;
        $this->http = $http;
        $this->extra = $extra;
    }
}

/**
 * Прервать запрос ошибкой {"error": <код>, …extra} с HTTP-статусом. Бросает исключение (а не exit), чтобы
 * открытая транзакция откатилась в transport_tx(); ответ формирует transport_handle().
 *
 * @param array<string,mixed> $extra
 */
function transport_fail(string $code, int $http = 400, array $extra = []): never
{
    throw new TransportApiError($code, $http, $extra);
}

/**
 * Выполнить тело эндпоинта: TransportApiError → JSON-ошибка; любая другая ошибка → 500 {"error":"server_error"}
 * (детали — только в error_log, наружу не отдаются).
 */
function transport_handle(callable $fn): void
{
    try {
        $fn();
    } catch (TransportApiError $e) {
        sendJson(array_merge(['error' => $e->errorCode], $e->extra), $e->http);
    } catch (Throwable $e) {
        error_log('[transport] ' . get_class($e) . ': ' . $e->getMessage());
        sendJson(['error' => 'server_error'], 500);
    }
}

/**
 * Выполнить $fn в транзакции BEGIN IMMEDIATE (запись блокируется сразу — проверки «прочитал → записал» согласованы
 * между параллельными запросами). Исключение откатывает транзакцию и пробрасывается дальше.
 */
function transport_tx(PDO $pdo, callable $fn): mixed
{
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $result = $fn();
        $pdo->exec('COMMIT');
        return $result;
    } catch (Throwable $e) {
        try {
            $pdo->exec('ROLLBACK');
        } catch (Throwable $_rollback) {
            // транзакция уже закрыта SQLite — нечего откатывать
        }
        throw $e;
    }
}

/** Тело запроса: пустое → []; не JSON-объект/массив → 400 invalid_json. */
function transport_read_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        transport_fail('invalid_json', 400);
    }
    return $data;
}

// =====================================================================
// Пользователь, роли, права
// =====================================================================

/** Строка users: переданная или текущая (сессия). */
function transport_user(?array $user = null): ?array
{
    return $user ?? current_user();
}

/** Роль: 'admin' | 'supervisor' | 'viewer'; '' — пользователя нет (аноним). */
function transport_role(?array $user = null): string
{
    $u = transport_user($user);
    return $u === null ? '' : user_role($u);
}

/** users.id текущего (или переданного) пользователя; '' — нет. */
function transport_user_id(?array $user = null): string
{
    $u = transport_user($user);
    return $u === null ? '' : (string) ($u['id'] ?? '');
}

/** Перенос ТС между базами — admin или viewer (supervisor и аноним — нет). */
function transport_can_move_vehicle(?array $user = null): bool
{
    return in_array(transport_role($user), ['admin', 'viewer'], true);
}

/**
 * Может ли пользователь править заявку (поля, статус, назначения).
 *   admin — любую; supervisor — свою (created_by = users.id пользователя) и заявки авторов из TRANSPORT_EDIT_DELEGATION
 *   (логин правящего → логины авторов; автор определяется по users.id = created_by); viewer и аноним — никогда.
 *
 * @param array $request строка/массив заявки (нужен created_by — users.id автора)
 */
function transport_can_edit_request(array $request, ?array $user = null, ?PDO $pdo = null): bool
{
    $u = transport_user($user);
    if ($u === null) {
        return false;
    }
    $role = user_role($u);
    if ($role === 'admin') {
        return true;
    }
    if ($role !== 'supervisor') {
        return false;
    }
    $author = (string) ($request['created_by'] ?? '');
    if ($author === '') {
        return false;
    }
    if ($author === (string) ($u['id'] ?? '')) {
        return true;
    }
    $delegates = TRANSPORT_EDIT_DELEGATION[(string) ($u['username'] ?? '')] ?? [];
    if ($delegates === []) {
        return false;
    }
    try {
        $pdo ??= Database::getInstance()->getPDO();
        $st = $pdo->prepare('SELECT username FROM users WHERE id = :id LIMIT 1');
        $st->execute([':id' => $author]);
        $authorLogin = $st->fetchColumn();
    } catch (Throwable $e) {
        return false;
    }
    return is_string($authorLogin) && in_array($authorLogin, $delegates, true);
}

// =====================================================================
// Допустимые водители
// =====================================================================

/** Ключ сравнения названий/имён: пробелы схлопнуты, регистр по-кириллице не важен. */
function transport_name_key(string $s): string
{
    $s = preg_replace('/\s+/u', ' ', $s) ?? $s;
    return mb_strtolower(trim($s), 'UTF-8');
}

/**
 * Допустимые водители = сотрудники группы с названием «Транспорт» ∪ transport_driver_pool.
 * Дубликаты схлопываются (приоритет group). Элемент — только employee_id, name, source ('group'|'pool'):
 * телефон и фото не отдаются. Запись пула без сотрудника (удалён из employees) в список не попадает.
 *
 * @return list<array{employee_id:string,name:string,source:string}>
 */
function transport_allowed_drivers(PDO $pdo): array
{
    $want = transport_name_key(TRANSPORT_DRIVER_GROUP_NAME);
    $groupIds = [];
    foreach ($pdo->query('SELECT id, name FROM groups')->fetchAll(PDO::FETCH_ASSOC) as $g) {
        if (transport_name_key((string) ($g['name'] ?? '')) === $want) {
            $groupIds[] = (string) $g['id'];
        }
    }
    $out = [];
    $seen = [];
    if ($groupIds !== []) {
        $in = implode(',', array_fill(0, count($groupIds), '?'));
        $st = $pdo->prepare(
            "SELECT id, full_name FROM employees WHERE group_id IN ($in) ORDER BY COALESCE(sort_order, 0), full_name, id"
        );
        $st->execute($groupIds);
        foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $e) {
            $id = (string) $e['id'];
            if (!isset($seen[$id])) {
                $seen[$id] = true;
                $out[] = ['employee_id' => $id, 'name' => (string) $e['full_name'], 'source' => 'group'];
            }
        }
    }
    $st = $pdo->query(
        'SELECT e.id, e.full_name FROM transport_driver_pool p JOIN employees e ON e.id = p.employee_id
         ORDER BY e.full_name, e.id'
    );
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $e) {
        $id = (string) $e['id'];
        if (!isset($seen[$id])) {
            $seen[$id] = true;
            $out[] = ['employee_id' => $id, 'name' => (string) $e['full_name'], 'source' => 'pool'];
        }
    }
    return $out;
}

// =====================================================================
// Время (+05) и шаг 15 минут
// =====================================================================

/** Локальное «сейчас» модуля: 'YYYY-MM-DDTHH:MM' в +05 (не UTC и не часовой пояс сервера). */
function transport_now_local(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone(TRANSPORT_TZ_OFFSET)))->format('Y-m-d\TH:i');
}

/** Метка времени журнала/служебных полей: 'YYYY-MM-DDTHH:MM:SS+05:00'. */
function transport_ts(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone(TRANSPORT_TZ_OFFSET)))->format('Y-m-d\TH:i:sP');
}

/** Шаг 15 минут: неотрицательное целое, кратное 15 (положительность длительности проверяет вызывающий). */
function transport_check_step(int $min): bool
{
    return $min >= 0 && $min % TRANSPORT_STEP_MIN === 0;
}

// =====================================================================
// Журнал transport_journal (append-only; запись — в транзакции вызывающего)
// =====================================================================

/** JSON для журнала: кириллица как есть; сбой кодирования — исключение (журнал не должен молча теряться). */
function transport_journal_json(?array $data): ?string
{
    if ($data === null) {
        return null;
    }
    $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
    if ($json === false) {
        throw new RuntimeException('transport_journal: json_encode failed: ' . json_last_error_msg());
    }
    return $json;
}

/**
 * Записать событие в transport_journal. Вызывать ВНУТРИ транзакции, которая меняет сущность: тогда сбой записи журнала
 * (или откат) отменяет и саму мутацию. actor/role берутся из текущей сессии ('api'/'anonymous' — вне HTTP).
 * Имена и телефоны сотрудников в before/after не кладём — только идентификаторы (журнал не очищается).
 *
 * @param array|null $before состояние до (NULL у создания)
 * @param array|null $after  состояние после (NULL у удаления)
 * @param array|null $warnings подтверждённые предупреждения (назначения; у справочников — NULL)
 */
function transport_journal_write(
    PDO $pdo,
    string $action,
    string $entityType,
    string $entityId,
    ?array $before,
    ?array $after,
    ?array $warnings = null
): void {
    $user = current_user();
    $actor = is_array($user) && !empty($user['username']) ? (string) $user['username'] : 'api';
    $role = is_array($user) ? user_role($user) : 'anonymous';
    $st = $pdo->prepare(
        'INSERT INTO transport_journal (ts, actor, role, action, entity_type, entity_id, before_json, after_json, warnings_json)
         VALUES (:ts, :actor, :role, :action, :etype, :eid, :before, :after, :warnings)'
    );
    $st->execute([
        ':ts'       => transport_ts(),
        ':actor'    => $actor,
        ':role'     => $role,
        ':action'   => $action,
        ':etype'    => $entityType,
        ':eid'      => $entityId,
        ':before'   => transport_journal_json($before),
        ':after'    => transport_journal_json($after),
        ':warnings' => transport_journal_json($warnings),
    ]);
}
