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

// =====================================================================
// V10-T5: запись в одной транзакции с ограниченным повтором BEGIN IMMEDIATE
// =====================================================================

/** Сколько раз пробуем взять блокировку записи (BEGIN IMMEDIATE) при SQLITE_BUSY — не больше 3 попыток. */
const TRANSPORT_BEGIN_ATTEMPTS = 3;
/** Пауза между попытками BEGIN IMMEDIATE, мкс (умножается на номер попытки). */
const TRANSPORT_BEGIN_PAUSE_US = 40000;

/** Ошибка SQLite «занято» (SQLITE_BUSY=5 / SQLITE_LOCKED=6 / текст «database is locked»). */
function transport_is_busy(Throwable $e): bool
{
    if ($e instanceof PDOException && is_array($e->errorInfo) && in_array($e->errorInfo[1] ?? null, [5, 6], true)) {
        return true;
    }
    $m = $e->getMessage();
    return stripos($m, 'database is locked') !== false || stripos($m, 'database table is locked') !== false;
}

/**
 * Выполнить $fn в транзакции BEGIN IMMEDIATE для писателей модуля (заявки/назначения): «проверил пересечение → записал»
 * без гонки. Повтор — ТОЛЬКО на самом BEGIN IMMEDIATE (≤ TRANSPORT_BEGIN_ATTEMPTS попыток, короткая растущая пауза);
 * тело $fn никогда не перезапускается. Завершение — exec('COMMIT') / exec('ROLLBACK'), не PDO::commit(): PDO::inTransaction()
 * ручной BEGIN не видит (PHP 8.3.6), поэтому состояние ведёт собственный флаг $open. Исключение откатывает транзакцию
 * и пробрасывается; не удалось взять блокировку — 503 busy.
 */
function transport_write(PDO $pdo, callable $fn): mixed
{
    $attempt = 0;
    while (true) {
        $attempt++;
        try {
            $pdo->exec('BEGIN IMMEDIATE');
            break;
        } catch (Throwable $e) {
            if (!transport_is_busy($e)) {
                throw $e;
            }
            if ($attempt >= TRANSPORT_BEGIN_ATTEMPTS) {
                error_log('[transport] BEGIN IMMEDIATE: busy after ' . $attempt . ' attempts: ' . $e->getMessage());
                transport_fail('busy', 503);
            }
            usleep(TRANSPORT_BEGIN_PAUSE_US * $attempt);
        }
    }
    $open = true;
    try {
        $result = $fn();
        $pdo->exec('COMMIT');
        $open = false;
        return $result;
    } catch (Throwable $e) {
        if ($open) {
            try {
                $pdo->exec('ROLLBACK');
            } catch (Throwable $_rollback) {
                // транзакция уже закрыта SQLite — нечего откатывать
            }
        }
        throw $e;
    }
}

/** version из тела: нет/null/'' → null; целое/строка цифр → int; иное → 422 invalid_version. */
function transport_read_version(array $body): ?int
{
    $v = $body['version'] ?? null;
    if ($v === null || $v === '') {
        return null;
    }
    if (is_int($v)) {
        return $v;
    }
    if (is_string($v) && ctype_digit($v)) {
        return (int) $v;
    }
    transport_fail('invalid_version', 422);
}

/** Целое из JSON: int или дробное с целым значением (60.0); иначе null. */
function transport_int(mixed $v): ?int
{
    if (is_int($v)) {
        return $v;
    }
    if (is_float($v) && is_finite($v) && floor($v) === $v && abs($v) < 1.0e9) {
        return (int) $v;
    }
    return null;
}

/** Разбор строгого локального времени 'YYYY-MM-DDTHH:MM' (несуществующая дата/время → null). Арифметика — в UTC без переходов. */
function transport_parse_local(mixed $v): ?DateTimeImmutable
{
    if (!is_string($v) || preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/', $v) !== 1) {
        return null;
    }
    $d = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', $v, new DateTimeZone('UTC'));
    if ($d === false || $d->format('Y-m-d\TH:i') !== $v) {
        return null;
    }
    return $d;
}

/** 'YYYY-MM-DDTHH:MM' + $min минут → 'YYYY-MM-DDTHH:MM' (наивное локальное время +05). */
function transport_add_minutes(DateTimeImmutable $start, int $min): string
{
    return $start->modify(($min >= 0 ? '+' : '') . $min . ' minutes')->format('Y-m-d\TH:i');
}

// =====================================================================
// V10-T5: выборки и представление заявок/назначений (весь SQL — здесь и в transport_warnings.php)
// =====================================================================

const TRANSPORT_REQUEST_STATUSES = ['new', 'assigned', 'in_progress', 'done', 'cancelled'];

/** Строка заявки или null. */
function transport_fetch_request(PDO $pdo, string $id): ?array
{
    $st = $pdo->prepare('SELECT * FROM transport_requests WHERE id = :id');
    $st->execute([':id' => $id]);
    $rows = $st->fetchAll(PDO::FETCH_ASSOC);
    return $rows[0] ?? null;
}

/** Строка назначения или null. */
function transport_fetch_assignment(PDO $pdo, string $id): ?array
{
    $st = $pdo->prepare('SELECT * FROM transport_assignments WHERE id = :id');
    $st->execute([':id' => $id]);
    $rows = $st->fetchAll(PDO::FETCH_ASSOC);
    return $rows[0] ?? null;
}

/**
 * Назначения заявок в публичном виде: requestId => список назначений (в порядке создания, rowid) с бригадой и маршрутом.
 *
 * @param list<string> $requestIds
 * @return array<string,list<array<string,mixed>>>
 */
function transport_assignments_of(PDO $pdo, array $requestIds): array
{
    $out = [];
    foreach ($requestIds as $rid) {
        $out[(string) $rid] = [];
    }
    foreach (array_chunk(array_values(array_unique(array_map('strval', $requestIds))), 400) as $chunk) {
        if ($chunk === []) {
            continue;
        }
        $in = implode(',', array_fill(0, count($chunk), '?'));
        $st = $pdo->prepare("SELECT * FROM transport_assignments WHERE request_id IN ($in) ORDER BY rowid");
        $st->execute($chunk);
        $rows = $st->fetchAll(PDO::FETCH_ASSOC);
        if ($rows === []) {
            continue;
        }
        $aids = array_map(static fn(array $r): string => (string) $r['id'], $rows);
        $crew = [];
        $stops = [];
        foreach (array_chunk($aids, 400) as $achunk) {
            $ain = implode(',', array_fill(0, count($achunk), '?'));
            $sc = $pdo->prepare("SELECT assignment_id, employee_id, name_snap FROM assignment_crew WHERE assignment_id IN ($ain) ORDER BY name_snap, employee_id");
            $sc->execute($achunk);
            foreach ($sc->fetchAll(PDO::FETCH_ASSOC) as $c) {
                $crew[(string) $c['assignment_id']][] = ['employee_id' => (string) $c['employee_id'], 'name' => (string) ($c['name_snap'] ?? '')];
            }
            $ss = $pdo->prepare("SELECT * FROM assignment_stops WHERE assignment_id IN ($ain) ORDER BY assignment_id, ord");
            $ss->execute($achunk);
            foreach ($ss->fetchAll(PDO::FETCH_ASSOC) as $s) {
                $stops[(string) $s['assignment_id']][] = [
                    'ord'         => (int) $s['ord'],
                    'kind'        => (string) $s['kind'],
                    'place'       => (string) $s['place'],
                    'lat'         => $s['lat'] === null ? null : (float) $s['lat'],
                    'lon'         => $s['lon'] === null ? null : (float) $s['lon'],
                    'stay_min'    => (int) $s['stay_min'],
                    'leg_km'      => $s['leg_km'] === null ? null : (float) $s['leg_km'],
                    'leg_min_map' => $s['leg_min_map'] === null ? null : (int) $s['leg_min_map'],
                    'leg_min'     => (int) $s['leg_min'],
                ];
            }
        }
        foreach ($rows as $r) {
            $id = (string) $r['id'];
            $confirmed = $r['override_json'] === null ? null : json_decode((string) $r['override_json'], true);
            $out[(string) $r['request_id']][] = [
                'id'                 => $id,
                'request_id'         => (string) $r['request_id'],
                'vehicle_id'         => (string) $r['vehicle_id'],
                'driver_id'          => (string) $r['driver_id'],
                'driver_name'        => (string) ($r['driver_name_snap'] ?? ''),
                'start_at'           => (string) $r['start_at'],
                'duration_min'       => (int) $r['duration_min'],
                'end_at'             => (string) $r['end_at'],
                'version'            => (int) $r['version'],
                'crew'               => $crew[$id] ?? [],
                'stops'              => $stops[$id] ?? [],
                'confirmed_warnings' => is_array($confirmed) ? $confirmed : [],
                'created_by'         => $r['created_by'] === null ? null : (string) $r['created_by'],
                'created_at'         => (string) ($r['created_at'] ?? ''),
                'updated_at'         => (string) ($r['updated_at'] ?? ''),
            ];
        }
    }
    return $out;
}

/** Одно назначение в публичном виде или null. */
function transport_assignment_public(PDO $pdo, string $id): ?array
{
    $row = transport_fetch_assignment($pdo, $id);
    if ($row === null) {
        return null;
    }
    foreach (transport_assignments_of($pdo, [(string) $row['request_id']])[(string) $row['request_id']] as $a) {
        if ($a['id'] === $id) {
            return $a;
        }
    }
    return null;
}

/**
 * Заявка в публичном виде.
 *
 * @param list<array<string,mixed>> $assignments из transport_assignments_of()
 */
function transport_request_public(array $r, array $assignments, bool $canEdit): array
{
    return [
        'id'              => (string) $r['id'],
        'display_no'      => $r['display_no'] === null ? null : (int) $r['display_no'],
        'title'           => (string) $r['title'],
        'subscriber'      => $r['subscriber'] === null ? null : (string) $r['subscriber'],
        'address'         => $r['address'] === null ? null : (string) $r['address'],
        'comment'         => $r['comment'] === null ? null : (string) $r['comment'],
        'status'          => (string) $r['status'],
        'source'          => $r['source'] === null ? null : (string) $r['source'],
        'external_id'     => $r['external_id'] === null ? null : (string) $r['external_id'],
        'created_by'      => $r['created_by'] === null ? null : (string) $r['created_by'],
        'created_by_name' => (string) ($r['created_by_name'] ?? ''),
        'version'         => (int) $r['version'],
        'created_at'      => (string) ($r['created_at'] ?? ''),
        'updated_at'      => (string) ($r['updated_at'] ?? ''),
        'assignments'     => $assignments,
        'can_edit'        => $canEdit,
    ];
}
