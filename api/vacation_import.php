<?php

declare(strict_types=1);

/**
 * vacation_import.php — endpoint-приёмник отпусков из внешней системы.
 *
 * Авторизация: Bearer token (header: Authorization: Bearer <token>).
 * Токен хранится в meta таблице: key='external_api_token'.
 *
 * Резолвинг сотрудника (в порядке приоритета):
 *   1. По employeeId (employee_id) — точное совпадение id (как раньше).
 *   2. Если id пуст ИЛИ не найден — по ФИО:
 *      employeeName | fullName | full_name | fio (нормализованное сравнение).
 *
 * Поддерживаемые форматы запроса:
 *
 * 1. Single:
 *   { "employeeId": "emp_1", "startDate": "2026-07-15", "endDate": "2026-07-28",
 *     "status": "vacation", "comment": "", "approvalStatus": "approved" }
 *   ИЛИ по ФИО:
 *   { "employeeName": "<ФИО сотрудника>",
 *     "startDate": "2026-09-07", "endDate": "2026-09-28" }
 *
 * 2. Batch:
 *   { "vacations": [ {...}, {...} ] }
 *
 * Ответ:
 *   { success: true, imported: N, importedRecords: N, skipped: N, errors: [...] }
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';

handleOptions();

// Разрешаем только POST.
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    sendJson(['error' => 'Method not allowed'], 405);
}

// -------------------------------------------------------------------------
// Авторизация по Bearer token.
// -------------------------------------------------------------------------
$authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
$providedToken = '';

if (preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
    $providedToken = trim($m[1]);
} elseif ($authHeader !== '') {
    $providedToken = trim($authHeader);
}

if ($providedToken === '') {
    sendJson(['error' => 'missing_bearer_token'], 401);
}

try {
    $db  = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    $stmt = $pdo->prepare("SELECT value FROM meta WHERE key = 'external_api_token' LIMIT 1");
    $stmt->execute();
    $row = $stmt->fetch();

    $storedToken = ($row && !empty($row['value'])) ? (string) $row['value'] : '';

    if ($storedToken === '' || !hash_equals($storedToken, $providedToken)) {
        sendJson(['error' => 'invalid_token'], 401);
    }
} catch (Throwable $e) {
    error_log('[vacation_import] auth failure: ' . $e->getMessage());
    error('Server error during authentication', 500);
}

// -------------------------------------------------------------------------
// Разбор тела запроса.
// -------------------------------------------------------------------------
try {
    $body = getJsonBody();
} catch (Throwable $e) {
    sendJson(['error' => 'invalid_json'], 400);
}

// Нормализуем в массив записей vacation.
$vacations = [];
if (isset($body['vacations']) && is_array($body['vacations'])) {
    // Batch формат.
    $vacations = $body['vacations'];
} elseif (
    isset($body['employeeId']) || isset($body['employee_id'])
    || isset($body['employeeName']) || isset($body['fullName'])
    || isset($body['full_name']) || isset($body['fio'])
) {
    // Single формат — обернём в массив из одного элемента.
    $vacations = [$body];
} else {
    sendJson([
        'error'   => 'invalid_payload',
        'message' => 'Expected {employeeId|employeeName,...} or {vacations:[...]}.',
    ], 400);
}

// -------------------------------------------------------------------------
// Справочник сотрудников для резолвинга по ФИО.
// Загружаем один раз в память (список сотрудников невелик).
// -------------------------------------------------------------------------

/**
 * Нормализация ФИО для устойчивого сравнения:
 * - trim, нижний регистр (мультибайтовый),
 * - схлопывание любых пробелов в один,
 * - ё → е.
 */
$normalizeName = static function (?string $s): string {
    if ($s === null) {
        return '';
    }
    $s = trim($s);
    if ($s === '') {
        return '';
    }
    // Мультибайтовый lower, если доступен mbstring.
    if (function_exists('mb_strtolower')) {
        $s = mb_strtolower($s, 'UTF-8');
    } else {
        $s = strtolower($s);
    }
    $s = str_replace('ё', 'е', $s);
    // Любые последовательности пробельных символов → один пробел.
    $s = preg_replace('/\s+/u', ' ', $s);
    return $s === null ? '' : trim($s);
};

/**
 * Карта normalizedName => [ids...] и множество существующих id.
 * Строится лениво (только если реально понадобится матчинг по имени),
 * но безопасно — при ошибке остаётся пустой.
 *
 * @var array<string, array<int, string>> $nameIndex
 * @var array<string, bool> $idSet
 */
$nameIndex = [];
$idSet     = [];
$dictLoaded = false;

$loadDictionary = static function () use (
    &$nameIndex,
    &$idSet,
    &$dictLoaded,
    $pdo,
    $normalizeName
): void {
    if ($dictLoaded) {
        return;
    }
    $dictLoaded = true; // помечаем сразу, чтобы не пытаться повторно при ошибке

    try {
        // Пытаемся выбрать наиболее вероятные колонки с именем.
        // full_name — основной вариант в схеме проекта.
        $rows = $pdo->query('SELECT id, full_name FROM employees')->fetchAll();
    } catch (Throwable $e) {
        error_log('[vacation_import] dictionary load failed: ' . $e->getMessage());
        return;
    }

    foreach ($rows as $r) {
        $id = isset($r['id']) ? (string) $r['id'] : '';
        if ($id === '') {
            continue;
        }
        $idSet[$id] = true;

        $name = isset($r['full_name']) ? (string) $r['full_name'] : '';
        $norm = $normalizeName($name);
        if ($norm !== '') {
            $nameIndex[$norm][] = $id;
        }
    }
};

// -------------------------------------------------------------------------
// Подготовка prepared statements.
// -------------------------------------------------------------------------

$imported        = 0;   // сколько day-entries записано (обратная совместимость)
$importedRecords = 0;   // сколько vacation-записей успешно обработано
$skipped         = 0;
$errors          = [];

$ts = now();

$stmtUpsert = $pdo->prepare(
    'INSERT INTO schedule_entries
        (employee_id, date, status, comment, approval_status, version, updated_at)
     VALUES
        (:employee_id, :date, :status, :comment, :approval_status,
         COALESCE((SELECT version FROM schedule_entries
                   WHERE employee_id = :employee_id AND date = :date), 0) + 1,
         :updated_at)
     ON CONFLICT(employee_id, date) DO UPDATE SET
        status          = excluded.status,
        comment         = excluded.comment,
        approval_status = excluded.approval_status,
        version         = excluded.version,
        updated_at      = excluded.updated_at'
);

$stmtSyncLog = $pdo->prepare(
    'INSERT INTO sync_log (entity_type, entity_id, action, actor, updated_at)
     VALUES (:t, :id, :a, :actor, :ts)'
);

// Проверка существования сотрудника по id (используется как быстрый путь).
$stmtCheckEmp = $pdo->prepare(
    'SELECT id FROM employees WHERE id = :id LIMIT 1'
);

/**
 * Резолвит employeeId по входным данным записи.
 *
 * @param array $v
 * @return array{0: ?string, 1: string} [employeeId|null, matchedBy]
 *         matchedBy ∈ 'id' | 'name' | ''
 *         Возвращает специальные маркеры через исключение? Нет — коды идут в error отдельно.
 */
$resolveEmployee = function (array $v) use (
    $stmtCheckEmp,
    $loadDictionary,
    $normalizeName,
    &$nameIndex,
    &$idSet
): array {
    $empId = $v['employeeId'] ?? $v['employee_id'] ?? null;
    if (is_string($empId)) {
        $empId = trim($empId);
    }

    // 1) Прямой путь по id.
    if ($empId !== null && $empId !== '') {
        try {
            $stmtCheckEmp->execute([':id' => $empId]);
            if ($stmtCheckEmp->fetch()) {
                return [$empId, 'id'];
            }
        } catch (Throwable $e) {
            error_log('[vacation_import] id check failed: ' . $e->getMessage());
        }
        // id передан, но не найден — попробуем по имени (fallback), иначе вернём null.
    }

    // 2) Fallback по ФИО.
    $rawName = $v['employeeName']
        ?? $v['fullName']
        ?? $v['full_name']
        ?? $v['fio']
        ?? null;

    $norm = $normalizeName(is_string($rawName) ? $rawName : null);
    if ($norm === '') {
        // Нет имени для резолвинга.
        return [null, ''];
    }

    $loadDictionary();

    if (!isset($nameIndex[$norm])) {
        return [null, 'name_not_found'];
    }

    $candidates = $nameIndex[$norm];
    if (count($candidates) > 1) {
        // Однофамильцы — не угадываем, чтобы не записать не тому человеку.
        return [null, 'name_ambiguous'];
    }

    return [$candidates[0], 'name'];
};

/**
 * Импортирует одну запись отпуска.
 *
 * @param array $v
 */
$importOne = function (array $v) use (
    &$imported,
    &$importedRecords,
    &$skipped,
    &$errors,
    $stmtUpsert,
    $stmtSyncLog,
    $resolveEmployee,
    $ts
): void {
    $startDateRaw   = $v['startDate']      ?? $v['start_date']      ?? null;
    $endDateRaw     = $v['endDate']        ?? $v['end_date']        ?? null;
    $status         = $v['status']         ?? 'vacation';
    $comment        = $v['comment']        ?? '';
    $approvalStatus = $v['approvalStatus'] ?? $v['approval_status'] ?? 'approved';

    // "Человекочитаемая" метка сотрудника для сообщений об ошибке.
    $rawEmpLabel = $v['employeeId']
        ?? $v['employee_id']
        ?? $v['employeeName']
        ?? $v['fullName']
        ?? $v['full_name']
        ?? $v['fio']
        ?? null;

    // Валидация дат (не зависит от резолвинга сотрудника).
    if ($startDateRaw === null || $endDateRaw === null) {
        $errors[] = ['employee' => $rawEmpLabel, 'error' => 'missing_dates'];
        return;
    }

    // Резолвим сотрудника (id → name fallback).
    [$empId, $matchedBy] = $resolveEmployee($v);

    if ($empId === null) {
        // Нет ни id, ни валидного имени.
        if ($matchedBy === '') {
            // Совсем нет идентификатора.
            $noIdentifier = ($rawEmpLabel === null || $rawEmpLabel === '');
            $errors[] = [
                'employee' => $rawEmpLabel,
                'error'    => $noIdentifier ? 'missing_employeeId' : 'employee_not_found',
            ];
        } elseif ($matchedBy === 'name_ambiguous') {
            $errors[] = ['employee' => $rawEmpLabel, 'error' => 'employee_name_ambiguous'];
        } else {
            // name_not_found и любые прочие случаи.
            $errors[] = ['employee' => $rawEmpLabel, 'error' => 'employee_not_found'];
        }
        $skipped++;
        return;
    }

    // Парсим даты (YYYY-MM-DD).
    $start = date_create((string) $startDateRaw);
    $end   = date_create((string) $endDateRaw);

    if ($start === false || $end === false) {
        $errors[] = ['employee' => $rawEmpLabel, 'employeeId' => $empId, 'error' => 'invalid_date_format'];
        return;
    }

    $start->setTime(0, 0, 0);
    $end->setTime(0, 0, 0);

    if ($end < $start) {
        $errors[] = ['employee' => $rawEmpLabel, 'employeeId' => $empId, 'error' => 'end_before_start'];
        return;
    }

    $interval  = $start->diff($end);
    $totalDays = (int) $interval->days + 1; // включительно
    if ($totalDays > 366 * 3) {
        $errors[] = [
            'employee'   => $rawEmpLabel,
            'employeeId' => $empId,
            'error'      => 'range_too_large',
            'days'       => $totalDays,
        ];
        return;
    }

    // Создаём по одной schedule_entry на каждый день.
    $cursor = clone $start;
    $oneDay = new DateInterval('P1D');
    $localImported = 0;

    while ($cursor <= $end) {
        $dateStr = $cursor->format('Y-m-d');

        try {
            $stmtUpsert->bindValue(':employee_id', $empId, PDO::PARAM_STR);
            $stmtUpsert->bindValue(':date', $dateStr, PDO::PARAM_STR);
            $stmtUpsert->bindValue(':status', $status, PDO::PARAM_STR);
            $stmtUpsert->bindValue(':comment', $comment, PDO::PARAM_STR);
            $stmtUpsert->bindValue(':approval_status', $approvalStatus, PDO::PARAM_STR);
            $stmtUpsert->bindValue(':updated_at', $ts, PDO::PARAM_STR);
            $stmtUpsert->execute();

            $stmtSyncLog->bindValue(':t', 'entry', PDO::PARAM_STR);
            $stmtSyncLog->bindValue(':id', $empId . ':' . $dateStr, PDO::PARAM_STR);
            $stmtSyncLog->bindValue(':a', 'upsert', PDO::PARAM_STR);
            $stmtSyncLog->bindValue(':actor', 'external_api', PDO::PARAM_STR);
            $stmtSyncLog->bindValue(':ts', $ts, PDO::PARAM_STR);
            $stmtSyncLog->execute();

            $localImported++;
        } catch (Throwable $e) {
            $errors[] = [
                'employeeId' => $empId,
                'date'       => $dateStr,
                'error'      => 'db_error: ' . $e->getMessage(),
            ];
        }

        $cursor->add($oneDay);
    }

    $imported += $localImported;
    if ($localImported > 0) {
        $importedRecords++;
    }

    error_log(sprintf(
        '[vacation_import] imported %d day-entries for employee=%s (matchedBy=%s) from %s to %s (status=%s)',
        $localImported,
        $empId,
        $matchedBy,
        $start->format('Y-m-d'),
        $end->format('Y-m-d'),
        $status
    ));
};

// -------------------------------------------------------------------------
// Транзакционный импорт.
// -------------------------------------------------------------------------
try {
    $pdo->beginTransaction();
    foreach ($vacations as $v) {
        if (!is_array($v)) {
            $errors[] = ['error' => 'invalid_entry', 'entry' => $v];
            continue;
        }
        $importOne($v);
    }
    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('[vacation_import] transaction failure: ' . $e->getMessage());
    error('Server error during import: ' . $e->getMessage(), 500);
}

// E5: audit vacation import
try {
    audit($pdo, 'vacation_import.run', null, null, 'system', null, [
        'importedRecords' => $importedRecords,
        'imported' => $imported,
        'skipped' => $skipped,
        'errorsCount' => count($errors),
    ]);
} catch (Throwable $_e) { /* non-critical */ }

sendJson([
    'success'         => true,
    'imported'        => $imported,         // кол-во day-entries (как раньше)
    'importedRecords' => $importedRecords,  // кол-во vacation-записей
    'skipped'         => $skipped,
    'errors'          => $errors,
]);