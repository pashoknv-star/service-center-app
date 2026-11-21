<?php

declare(strict_types=1);

/**
 * transport_vehicles.php — модуль «Транспорт» (V10-T1): справочники баз, ТС и пула водителей-совместителей,
 * перенос ТС между базами. Контракт — reports/V10/specs/CONTRACT.md «Часть 1»; библиотека — api/transport_lib.php.
 *
 * GET    api/transport_vehicles.php                      — любой авторизованный
 *        { success, bases:[{id,name,sort_order}],
 *          vehicles:[{id,name,plate,base_id,status,default_driver_id,sort_order,version}],
 *          drivers:[{employee_id,name,source:"group"|"pool"}] }   (drivers: группа «Транспорт» ∪ пул; без телефона/фото)
 * POST   ?entity=base     {name, sort_order?}                      — admin → 201 {success, base}
 * PUT    ?entity=base&id= {name?, sort_order?}                     — admin → {success, base}
 * POST   ?entity=vehicle  {name, plate, base_id, status?, default_driver_id?, sort_order?} — admin → 201 {success, vehicle}
 * PUT    ?entity=vehicle&id= {version (обязательна), name?, plate?, status?, default_driver_id? (null — снять), sort_order?}
 *        — admin → {success, vehicle}; смена base_id этим путём запрещена (422 use_move)
 * POST   ?entity=pool     {employee_id}                            — admin → 201 {success, entry}
 * DELETE ?entity=pool&id=<employee_id>                             — admin → {success}; водитель по умолчанию у ТС → 409 driver_in_use
 * POST   ?action=move&id=<vehicle_id> {base_id, version}           — admin ИЛИ viewer → {success, vehicle}; supervisor → 403
 *
 * Ошибки (формат {"error":"<код>"}): 401 unauthorized; 403 forbidden; 404 not_found; 405 method_not_allowed;
 * 400 invalid_json / invalid_entity / invalid_action; 409 VERSION_CONFLICT (current_version, vehicle) и driver_in_use
 * (vehicle_ids); 422 id_required, invalid_name, invalid_plate, invalid_status, invalid_sort_order, invalid_version,
 * version_required, duplicate_name, duplicate_plate, unknown_base, driver_not_allowed, use_move, same_base,
 * unknown_employee, already_in_pool; 500 server_error (детали — в error_log).
 *
 * Каждая мутация пишет запись в transport_journal В ТОЙ ЖЕ транзакции (BEGIN IMMEDIATE): base.create|update,
 * vehicle.create|update|move, driver_pool.add|remove. Изменение «вхолостую» (ничего не поменялось) — 200 без записи и без
 * увеличения version. Госномер хранится нормализованным (верхний регистр, без пробелов); имя базы уникально без учёта
 * регистра и лишних пробелов. Время — +05 (transport_ts()).
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/transport_lib.php';

handleOptions();

const TV_NAME_MAX = 100;
const TV_PLATE_MAX = 20;

// =====================================================================
// Нормализация и разбор входных данных
// =====================================================================

/** Имя (базы/ТС): строка, пробелы схлопнуты, 1..TV_NAME_MAX символов; иначе null. */
function tv_norm_name(mixed $v): ?string
{
    if (!is_string($v)) {
        return null;
    }
    $s = trim(preg_replace('/\s+/u', ' ', $v) ?? $v);
    if ($s === '' || mb_strlen($s) > TV_NAME_MAX) {
        return null;
    }
    return $s;
}

/** Госномер: без пробелов, верхний регистр (кириллица тоже), 1..TV_PLATE_MAX символов; иначе null. */
function tv_norm_plate(mixed $v): ?string
{
    if (!is_string($v)) {
        return null;
    }
    $s = mb_strtoupper(preg_replace('/\s+/u', '', $v) ?? $v, 'UTF-8');
    if ($s === '' || mb_strlen($s) > TV_PLATE_MAX) {
        return null;
    }
    return $s;
}

/** sort_order: целое (или строка целого); иначе 422 invalid_sort_order. */
function tv_norm_sort(mixed $v): int
{
    if (is_int($v)) {
        return $v;
    }
    if (is_string($v) && preg_match('/^-?\d{1,9}$/', $v) === 1) {
        return (int) $v;
    }
    transport_fail('invalid_sort_order', 422);
}

/** version из тела: нет/null/'' → null; целое/строка цифр → int; иное → 422 invalid_version. */
function tv_read_version(array $body): ?int
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

/** id из запроса (?id=): непустая строка; иначе 422 id_required. */
function tv_require_id(): string
{
    $id = $_GET['id'] ?? '';
    if (!is_string($id) || trim($id) === '') {
        transport_fail('id_required', 422);
    }
    return $id;
}

// =====================================================================
// Чтение сущностей
// =====================================================================

function tv_base_public(array $r): array
{
    return ['id' => (string) $r['id'], 'name' => (string) $r['name'], 'sort_order' => (int) $r['sort_order']];
}

function tv_vehicle_public(array $r): array
{
    return [
        'id'                => (string) $r['id'],
        'name'              => (string) $r['name'],
        'plate'             => (string) $r['plate'],
        'base_id'           => (string) $r['base_id'],
        'status'            => (string) $r['status'],
        'default_driver_id' => $r['default_driver_id'] === null ? null : (string) $r['default_driver_id'],
        'sort_order'        => (int) $r['sort_order'],
        'version'           => (int) $r['version'],
    ];
}

function tv_fetch_base(PDO $pdo, string $id): ?array
{
    $st = $pdo->prepare('SELECT * FROM transport_bases WHERE id = :id');
    $st->execute([':id' => $id]);
    $r = $st->fetch(PDO::FETCH_ASSOC);
    return $r === false ? null : $r;
}

function tv_fetch_vehicle(PDO $pdo, string $id): ?array
{
    $st = $pdo->prepare('SELECT * FROM vehicles WHERE id = :id');
    $st->execute([':id' => $id]);
    $r = $st->fetch(PDO::FETCH_ASSOC);
    return $r === false ? null : $r;
}

/** 409 VERSION_CONFLICT с актуальным ТС (вкладка перечитает запись) — образец tasks_version_conflict(). */
function tv_version_conflict(PDO $pdo, string $id): never
{
    $cur = tv_fetch_vehicle($pdo, $id);
    transport_fail('VERSION_CONFLICT', 409, [
        'current_version' => $cur !== null ? (int) $cur['version'] : null,
        'vehicle'         => $cur !== null ? tv_vehicle_public($cur) : null,
    ]);
}

/** Есть ли другая база с тем же именем (без учёта регистра и лишних пробелов). */
function tv_base_name_taken(PDO $pdo, string $name, ?string $exceptId): bool
{
    $key = transport_name_key($name);
    foreach ($pdo->query('SELECT id, name FROM transport_bases')->fetchAll(PDO::FETCH_ASSOC) as $r) {
        if ($exceptId !== null && (string) $r['id'] === $exceptId) {
            continue;
        }
        if (transport_name_key((string) $r['name']) === $key) {
            return true;
        }
    }
    return false;
}

/** Госномер занят другим ТС? (plate хранится нормализованным, сравнение точное.) */
function tv_plate_taken(PDO $pdo, string $plate, ?string $exceptId): bool
{
    $st = $pdo->prepare('SELECT id FROM vehicles WHERE plate = :p');
    $st->execute([':p' => $plate]);
    foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $id) {
        if ($exceptId === null || (string) $id !== $exceptId) {
            return true;
        }
    }
    return false;
}

/** default_driver_id из тела: нет/null/'' → null; иначе допустимый водитель (группа «Транспорт» ∪ пул) или 422 driver_not_allowed. */
function tv_norm_driver(PDO $pdo, mixed $v): ?string
{
    if ($v === null || $v === '') {
        return null;
    }
    if (!is_string($v)) {
        transport_fail('driver_not_allowed', 422);
    }
    foreach (transport_allowed_drivers($pdo) as $d) {
        if ($d['employee_id'] === $v) {
            return $v;
        }
    }
    transport_fail('driver_not_allowed', 422);
}

// =====================================================================
// Операции
// =====================================================================

function tv_list(PDO $pdo): void
{
    $bases = array_map(
        'tv_base_public',
        $pdo->query('SELECT * FROM transport_bases ORDER BY sort_order, name, id')->fetchAll(PDO::FETCH_ASSOC)
    );
    $vehicles = array_map(
        'tv_vehicle_public',
        $pdo->query('SELECT * FROM vehicles ORDER BY sort_order, name, id')->fetchAll(PDO::FETCH_ASSOC)
    );
    sendJson(['success' => true, 'bases' => $bases, 'vehicles' => $vehicles, 'drivers' => transport_allowed_drivers($pdo)]);
}

function tv_base_create(PDO $pdo, array $body): void
{
    $name = tv_norm_name($body['name'] ?? null);
    if ($name === null) {
        transport_fail('invalid_name', 422);
    }
    $sort = isset($body['sort_order']) ? tv_norm_sort($body['sort_order']) : null;

    $base = transport_tx($pdo, function () use ($pdo, $name, $sort): array {
        if (tv_base_name_taken($pdo, $name, null)) {
            transport_fail('duplicate_name', 422);
        }
        if ($sort === null) {
            $sort = (int) $pdo->query('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM transport_bases')->fetchColumn();
        }
        $id = genId('tb_');
        $ts = transport_ts();
        $pdo->prepare('INSERT INTO transport_bases (id, name, sort_order, created_at, updated_at) VALUES (:id, :n, :s, :ts, :ts)')
            ->execute([':id' => $id, ':n' => $name, ':s' => $sort, ':ts' => $ts]);
        transport_journal_write($pdo, 'base.create', 'base', $id, null, ['name' => $name, 'sort_order' => $sort]);
        return ['id' => $id, 'name' => $name, 'sort_order' => $sort];
    });
    sendJson(['success' => true, 'base' => $base], 201);
}

function tv_base_update(PDO $pdo, array $body): void
{
    $id = tv_require_id();
    $name = null;
    if (array_key_exists('name', $body)) {
        $name = tv_norm_name($body['name']);
        if ($name === null) {
            transport_fail('invalid_name', 422);
        }
    }
    $sort = array_key_exists('sort_order', $body) ? tv_norm_sort($body['sort_order']) : null;

    $base = transport_tx($pdo, function () use ($pdo, $id, $name, $sort): array {
        $cur = tv_fetch_base($pdo, $id);
        if ($cur === null) {
            transport_fail('not_found', 404);
        }
        $before = [];
        $after = [];
        if ($name !== null && $name !== (string) $cur['name']) {
            if (tv_base_name_taken($pdo, $name, $id)) {
                transport_fail('duplicate_name', 422);
            }
            $before['name'] = (string) $cur['name'];
            $after['name'] = $name;
        }
        if ($sort !== null && $sort !== (int) $cur['sort_order']) {
            $before['sort_order'] = (int) $cur['sort_order'];
            $after['sort_order'] = $sort;
        }
        if ($after === []) {
            return tv_base_public($cur);   // ничего не изменилось: без записи и без журнала
        }
        $pdo->prepare('UPDATE transport_bases SET name = :n, sort_order = :s, updated_at = :ts WHERE id = :id')
            ->execute([
                ':n'  => $after['name'] ?? (string) $cur['name'],
                ':s'  => $after['sort_order'] ?? (int) $cur['sort_order'],
                ':ts' => transport_ts(),
                ':id' => $id,
            ]);
        transport_journal_write($pdo, 'base.update', 'base', $id, $before, $after);
        return tv_base_public(tv_fetch_base($pdo, $id) ?? $cur);
    });
    sendJson(['success' => true, 'base' => $base]);
}

function tv_vehicle_create(PDO $pdo, array $body): void
{
    $name = tv_norm_name($body['name'] ?? null);
    if ($name === null) {
        transport_fail('invalid_name', 422);
    }
    $plate = tv_norm_plate($body['plate'] ?? null);
    if ($plate === null) {
        transport_fail('invalid_plate', 422);
    }
    $status = $body['status'] ?? 'in_service';
    if (!is_string($status) || !in_array($status, ['in_service', 'repair'], true)) {
        transport_fail('invalid_status', 422);
    }
    $baseId = $body['base_id'] ?? null;
    $sort = isset($body['sort_order']) ? tv_norm_sort($body['sort_order']) : null;

    $vehicle = transport_tx($pdo, function () use ($pdo, $body, $name, $plate, $status, $baseId, $sort): array {
        if (!is_string($baseId) || $baseId === '' || tv_fetch_base($pdo, $baseId) === null) {
            transport_fail('unknown_base', 422);
        }
        $driver = tv_norm_driver($pdo, $body['default_driver_id'] ?? null);
        if (tv_plate_taken($pdo, $plate, null)) {
            transport_fail('duplicate_plate', 422);
        }
        if ($sort === null) {
            $sort = (int) $pdo->query('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM vehicles')->fetchColumn();
        }
        $id = genId('tv_');
        $ts = transport_ts();
        $pdo->prepare(
            'INSERT INTO vehicles (id, name, plate, base_id, status, default_driver_id, sort_order, version, created_at, updated_at)
             VALUES (:id, :n, :p, :b, :st, :d, :s, 1, :ts, :ts)'
        )->execute([':id' => $id, ':n' => $name, ':p' => $plate, ':b' => $baseId, ':st' => $status, ':d' => $driver, ':s' => $sort, ':ts' => $ts]);
        transport_journal_write($pdo, 'vehicle.create', 'vehicle', $id, null, [
            'name' => $name, 'plate' => $plate, 'base_id' => $baseId, 'status' => $status,
            'default_driver_id' => $driver, 'sort_order' => $sort,
        ]);
        return tv_vehicle_public(tv_fetch_vehicle($pdo, $id) ?? []);
    });
    sendJson(['success' => true, 'vehicle' => $vehicle], 201);
}

function tv_vehicle_update(PDO $pdo, array $body): void
{
    $id = tv_require_id();
    $row = tv_fetch_vehicle($pdo, $id);
    if ($row === null) {
        transport_fail('not_found', 404);
    }
    $ver = tv_read_version($body);
    if ($ver === null) {
        transport_fail('version_required', 422);
    }
    // База меняется только переносом (action=move): постоянное изменение с журналом vehicle.move.
    if (array_key_exists('base_id', $body) && $body['base_id'] !== (string) $row['base_id']) {
        transport_fail('use_move', 422);
    }
    $name = null;
    if (array_key_exists('name', $body)) {
        $name = tv_norm_name($body['name']);
        if ($name === null) {
            transport_fail('invalid_name', 422);
        }
    }
    $plate = null;
    if (array_key_exists('plate', $body)) {
        $plate = tv_norm_plate($body['plate']);
        if ($plate === null) {
            transport_fail('invalid_plate', 422);
        }
    }
    $status = null;
    if (array_key_exists('status', $body)) {
        $status = $body['status'];
        if (!is_string($status) || !in_array($status, ['in_service', 'repair'], true)) {
            transport_fail('invalid_status', 422);
        }
    }
    $sort = array_key_exists('sort_order', $body) ? tv_norm_sort($body['sort_order']) : null;

    $vehicle = transport_tx($pdo, function () use ($pdo, $id, $ver, $body, $name, $plate, $status, $sort): array {
        $cur = tv_fetch_vehicle($pdo, $id);
        if ($cur === null) {
            transport_fail('not_found', 404);
        }
        if ($ver !== (int) $cur['version']) {
            tv_version_conflict($pdo, $id);
        }
        $before = [];
        $after = [];
        if ($name !== null && $name !== (string) $cur['name']) {
            $before['name'] = (string) $cur['name'];
            $after['name'] = $name;
        }
        if ($plate !== null && $plate !== (string) $cur['plate']) {
            if (tv_plate_taken($pdo, $plate, $id)) {
                transport_fail('duplicate_plate', 422);
            }
            $before['plate'] = (string) $cur['plate'];
            $after['plate'] = $plate;
        }
        if ($status !== null && $status !== (string) $cur['status']) {
            $before['status'] = (string) $cur['status'];
            $after['status'] = $status;
        }
        if ($sort !== null && $sort !== (int) $cur['sort_order']) {
            $before['sort_order'] = (int) $cur['sort_order'];
            $after['sort_order'] = $sort;
        }
        if (array_key_exists('default_driver_id', $body)) {
            $curDriver = $cur['default_driver_id'] === null ? null : (string) $cur['default_driver_id'];
            $newDriver = $body['default_driver_id'] === '' ? null : $body['default_driver_id'];
            if ($newDriver !== $curDriver) {
                $newDriver = tv_norm_driver($pdo, $newDriver);   // null — снять водителя; иначе допустимый водитель или 422
                $before['default_driver_id'] = $curDriver;
                $after['default_driver_id'] = $newDriver;
            }
        }
        if ($after === []) {
            return tv_vehicle_public($cur);   // ничего не изменилось: version не растёт, журнала нет
        }
        $upd = $pdo->prepare(
            'UPDATE vehicles SET name = :n, plate = :p, status = :st, default_driver_id = :d, sort_order = :s,
                    version = version + 1, updated_at = :ts
             WHERE id = :id AND version = :v'
        );
        $upd->execute([
            ':n'  => $after['name'] ?? (string) $cur['name'],
            ':p'  => $after['plate'] ?? (string) $cur['plate'],
            ':st' => $after['status'] ?? (string) $cur['status'],
            ':d'  => array_key_exists('default_driver_id', $after) ? $after['default_driver_id'] : $cur['default_driver_id'],
            ':s'  => $after['sort_order'] ?? (int) $cur['sort_order'],
            ':ts' => transport_ts(),
            ':id' => $id,
            ':v'  => (int) $cur['version'],
        ]);
        if ($upd->rowCount() !== 1) {
            tv_version_conflict($pdo, $id);
        }
        transport_journal_write($pdo, 'vehicle.update', 'vehicle', $id, $before, $after);
        return tv_vehicle_public(tv_fetch_vehicle($pdo, $id) ?? $cur);
    });
    sendJson(['success' => true, 'vehicle' => $vehicle]);
}

/** Перенос ТС в другую базу (admin или viewer). Постоянный; на созданные назначения не влияет (их не трогаем). */
function tv_vehicle_move(PDO $pdo, array $body): void
{
    if (!transport_can_move_vehicle()) {
        transport_fail('forbidden', 403);
    }
    $id = tv_require_id();
    if (tv_fetch_vehicle($pdo, $id) === null) {
        transport_fail('not_found', 404);
    }
    $ver = tv_read_version($body);
    if ($ver === null) {
        transport_fail('version_required', 422);
    }
    $baseId = $body['base_id'] ?? null;
    if (!is_string($baseId) || $baseId === '' || tv_fetch_base($pdo, $baseId) === null) {
        transport_fail('unknown_base', 422);
    }

    $vehicle = transport_tx($pdo, function () use ($pdo, $id, $ver, $baseId): array {
        $cur = tv_fetch_vehicle($pdo, $id);
        if ($cur === null) {
            transport_fail('not_found', 404);
        }
        if ($ver !== (int) $cur['version']) {
            tv_version_conflict($pdo, $id);
        }
        if ((string) $cur['base_id'] === $baseId) {
            transport_fail('same_base', 422);
        }
        $upd = $pdo->prepare('UPDATE vehicles SET base_id = :b, version = version + 1, updated_at = :ts WHERE id = :id AND version = :v');
        $upd->execute([':b' => $baseId, ':ts' => transport_ts(), ':id' => $id, ':v' => (int) $cur['version']]);
        if ($upd->rowCount() !== 1) {
            tv_version_conflict($pdo, $id);
        }
        transport_journal_write($pdo, 'vehicle.move', 'vehicle', $id, ['base_id' => (string) $cur['base_id']], ['base_id' => $baseId]);
        return tv_vehicle_public(tv_fetch_vehicle($pdo, $id) ?? $cur);
    });
    sendJson(['success' => true, 'vehicle' => $vehicle]);
}

function tv_pool_add(PDO $pdo, array $body): void
{
    $eid = $body['employee_id'] ?? null;
    if (!is_string($eid) || trim($eid) === '') {
        transport_fail('unknown_employee', 422);
    }
    $entry = transport_tx($pdo, function () use ($pdo, $eid): array {
        $st = $pdo->prepare('SELECT full_name FROM employees WHERE id = :id');
        $st->execute([':id' => $eid]);
        $name = $st->fetchColumn();
        if (!is_string($name)) {
            transport_fail('unknown_employee', 422);
        }
        $st = $pdo->prepare('SELECT 1 FROM transport_driver_pool WHERE employee_id = :id');
        $st->execute([':id' => $eid]);
        if ($st->fetchColumn() !== false) {
            transport_fail('already_in_pool', 422);
        }
        $ts = transport_ts();
        $pdo->prepare('INSERT INTO transport_driver_pool (employee_id, added_by, added_at) VALUES (:e, :by, :ts)')
            ->execute([':e' => $eid, ':by' => transport_user_id(), ':ts' => $ts]);
        transport_journal_write($pdo, 'driver_pool.add', 'driver_pool', $eid, null, ['employee_id' => $eid]);
        return ['employee_id' => $eid, 'name' => $name, 'added_at' => $ts];
    });
    sendJson(['success' => true, 'entry' => $entry], 201);
}

function tv_pool_remove(PDO $pdo): void
{
    $eid = tv_require_id();
    transport_tx($pdo, function () use ($pdo, $eid): void {
        $st = $pdo->prepare('SELECT 1 FROM transport_driver_pool WHERE employee_id = :id');
        $st->execute([':id' => $eid]);
        if ($st->fetchColumn() === false) {
            transport_fail('not_found', 404);
        }
        $st = $pdo->prepare('SELECT id FROM vehicles WHERE default_driver_id = :id ORDER BY sort_order, name, id');
        $st->execute([':id' => $eid]);
        $used = array_map('strval', $st->fetchAll(PDO::FETCH_COLUMN));
        if ($used !== []) {
            transport_fail('driver_in_use', 409, ['vehicle_ids' => $used]);
        }
        $pdo->prepare('DELETE FROM transport_driver_pool WHERE employee_id = :id')->execute([':id' => $eid]);
        transport_journal_write($pdo, 'driver_pool.remove', 'driver_pool', $eid, ['employee_id' => $eid], null);
    });
    sendJson(['success' => true]);
}

// =====================================================================
// Основной блок
// =====================================================================

transport_handle(function (): void {
    $db = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($method, ['GET', 'POST', 'PUT', 'DELETE'], true)) {
        transport_fail('method_not_allowed', 405);
    }
    require_auth();   // аноним → 401

    if ($method === 'GET') {
        tv_list($pdo);
        return;
    }

    $action = $_GET['action'] ?? '';
    $entity = $_GET['entity'] ?? '';

    // Перенос ТС — единственная запись, доступная viewer (проверка «admin или viewer» внутри tv_vehicle_move).
    if ($action !== '') {
        if ($method === 'POST' && $action === 'move') {
            tv_vehicle_move($pdo, transport_read_body());
            return;
        }
        transport_fail('invalid_action', 400);
    }

    // Остальная запись — справочники: только admin (supervisor и viewer → 403).
    require_admin();
    $body = $method === 'DELETE' ? [] : transport_read_body();

    switch ($entity) {
        case 'base':
            if ($method === 'POST') { tv_base_create($pdo, $body); return; }
            if ($method === 'PUT') { tv_base_update($pdo, $body); return; }
            break;
        case 'vehicle':
            if ($method === 'POST') { tv_vehicle_create($pdo, $body); return; }
            if ($method === 'PUT') { tv_vehicle_update($pdo, $body); return; }
            break;
        case 'pool':
            if ($method === 'POST') { tv_pool_add($pdo, $body); return; }
            if ($method === 'DELETE') { tv_pool_remove($pdo); return; }
            break;
        default:
            transport_fail('invalid_entity', 400);
    }
    transport_fail('method_not_allowed', 405);
});
