<?php

declare(strict_types=1);

/**
 * transport_journal.php — модуль «Транспорт» (V10-T6): чтение журнала transport_journal. Только GET, только admin.
 * Контракт — reports/V10/specs/CONTRACT.md, спека — reports/V10/specs/T6_board_journal_api.md. НИЧЕГО НЕ ПИШЕТ
 * (ни в журнал, ни в другие таблицы); append-only триггеры схемы v15 остаются в силе.
 *
 * GET api/transport_journal.php?[from=YYYY-MM-DD][&to=YYYY-MM-DD][&entity_type=][&entity_id=][&actor=][&action=]
 *                              [&limit=1..200][&offset=0..][&format=json|csv]
 *   Фильтры объединяются по И; значения сравниваются точно (без LIKE и масок). from/to — календарные дни по ts (+05),
 *   обе границы включительно.
 *   format=json (по умолчанию):
 *     { success, total, limit, offset, items: [{ id, ts, actor, role, action, entity_type, entity_id, before, after, warnings }] }
 *     before/after/warnings — разобранный JSON (или null). Порядок: новые сверху (id по убыванию). limit по умолчанию 50,
 *     больше 200 — зажимается до 200 (в ответе фактический limit); limit < 1 / не число → 422 invalid_limit; offset < 0 → 422 invalid_offset.
 *   format=csv: выгрузка с теми же фильтрами; UTF-8 с BOM, разделитель «;», CRLF (как api/audit_export.php), колонки
 *     id, ts, actor, role, action, entity_type, entity_id, before_json, after_json, warnings_json. Без limit выгружается всё
 *     (не более TJ_CSV_MAX строк); limit (до TJ_CSV_MAX) и offset поддерживаются. Ячейки, начинающиеся с = + - @ (а также
 *     TAB/CR), получают префикс «'» — защита от выполнения формул в Excel/LibreOffice. Cache-Control: no-store.
 *
 * Ошибки ({"error":"<код>"}): 401 unauthorized; 403 forbidden (не admin); 405 method_not_allowed; 422 invalid_from / invalid_to /
 * invalid_range / invalid_limit / invalid_offset / invalid_format; 500 server_error.
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/transport_lib.php';

const TJ_DEFAULT_LIMIT = 50;
const TJ_MAX_LIMIT = 200;
const TJ_CSV_MAX = 20000;
const TJ_CSV_COLUMNS = ['id', 'ts', 'actor', 'role', 'action', 'entity_type', 'entity_id', 'before_json', 'after_json', 'warnings_json'];

/** Строгая дата YYYY-MM-DD (реальная календарная); иначе null. */
function tj_valid_date(mixed $v): ?string
{
    if (!is_string($v) || preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m) !== 1) {
        return null;
    }
    return checkdate((int) $m[2], (int) $m[3], (int) $m[1]) ? $v : null;
}

/** Целое из параметра запроса: непустая строка цифр; иначе null. */
function tj_int_param(mixed $v): ?int
{
    return (is_string($v) && preg_match('/^\d{1,9}$/', $v) === 1) ? (int) $v : null;
}

/**
 * Условия WHERE и параметры из запроса.
 *
 * @return array{0:string,1:array<string,string>}
 */
function tj_filters(): array
{
    $where = [];
    $params = [];
    $from = $to = null;
    if (isset($_GET['from']) && $_GET['from'] !== '') {
        $from = tj_valid_date($_GET['from']);
        if ($from === null) {
            transport_fail('invalid_from', 422);
        }
        $where[] = 'ts >= :from';
        $params[':from'] = $from;
    }
    if (isset($_GET['to']) && $_GET['to'] !== '') {
        $to = tj_valid_date($_GET['to']);
        if ($to === null) {
            transport_fail('invalid_to', 422);
        }
        // ts — 'YYYY-MM-DDTHH:MM:SS+05:00': «ts < следующий день» включает весь день to.
        $where[] = 'ts < :to_next';
        $params[':to_next'] = (new DateTimeImmutable($to))->modify('+1 day')->format('Y-m-d');
    }
    if ($from !== null && $to !== null && $to < $from) {
        transport_fail('invalid_range', 422);
    }
    foreach (['entity_type', 'entity_id', 'actor', 'action'] as $col) {
        if (isset($_GET[$col]) && $_GET[$col] !== '') {
            if (!is_string($_GET[$col])) {
                transport_fail('invalid_' . $col, 422);
            }
            $where[] = $col . ' = :' . $col;
            $params[':' . $col] = $_GET[$col];
        }
    }
    return [$where === [] ? '' : ' WHERE ' . implode(' AND ', $where), $params];
}

/** Ячейка CSV: защита от формул (= + - @ TAB CR → префикс «'»), кавычки/разделитель/переводы строк — по RFC 4180 с «;». */
function tj_csv_cell(mixed $v): string
{
    $s = $v === null ? '' : (string) $v;
    if ($s !== '' && strpbrk($s[0], "=+-@\t\r") !== false) {
        $s = "'" . $s;
    }
    if (preg_match('/[;"\r\n]/', $s) === 1) {
        $s = '"' . str_replace('"', '""', $s) . '"';
    }
    return $s;
}

/** Разобранный JSON-столбец журнала (null/битый → null). */
function tj_json_col(mixed $raw): mixed
{
    if ($raw === null || $raw === '') {
        return null;
    }
    $v = json_decode((string) $raw, true);
    return json_last_error() === JSON_ERROR_NONE ? $v : null;
}

if (!defined('TRANSPORT_JOURNAL_LIB_ONLY')) {
    handleOptions();
    transport_handle(function (): void {
        $db = Database::getInstance();
        $pdo = $db->getPDO();
        $db->migrate();

        require_admin();   // аноним → 401, не admin → 403 (раньше проверки метода)
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
            transport_fail('method_not_allowed', 405);
        }

        $format = $_GET['format'] ?? 'json';
        if (!is_string($format) || !in_array($format, ['json', 'csv'], true)) {
            transport_fail('invalid_format', 422);
        }
        [$where, $params] = tj_filters();

        $offset = 0;
        if (isset($_GET['offset']) && $_GET['offset'] !== '') {
            $offset = tj_int_param($_GET['offset']);
            if ($offset === null) {
                transport_fail('invalid_offset', 422);
            }
        }
        $max = $format === 'csv' ? TJ_CSV_MAX : TJ_MAX_LIMIT;
        $limit = $format === 'csv' ? TJ_CSV_MAX : TJ_DEFAULT_LIMIT;
        if (isset($_GET['limit']) && $_GET['limit'] !== '') {
            $limit = tj_int_param($_GET['limit']);
            if ($limit === null || $limit < 1) {
                transport_fail('invalid_limit', 422);
            }
            $limit = min($limit, $max);
        }

        $sql = 'SELECT id, ts, actor, role, action, entity_type, entity_id, before_json, after_json, warnings_json FROM transport_journal'
            . $where . ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        $st = $pdo->prepare($sql);
        $st->execute($params);
        $rows = $st->fetchAll(PDO::FETCH_ASSOC);

        if ($format === 'csv') {
            header('Content-Type: text/csv; charset=utf-8');
            header('Content-Disposition: attachment; filename="transport-journal-' . date('Y-m-d') . '.csv"');
            header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
            header('Pragma: no-cache');
            corsHeaders();
            echo "\xEF\xBB\xBF" . implode(';', TJ_CSV_COLUMNS) . "\r\n";
            foreach ($rows as $r) {
                $line = [];
                foreach (TJ_CSV_COLUMNS as $c) {
                    $line[] = tj_csv_cell($r[$c] ?? null);
                }
                echo implode(';', $line) . "\r\n";
            }
            exit;
        }

        $cst = $pdo->prepare('SELECT COUNT(*) FROM transport_journal' . $where);
        $cst->execute($params);
        $items = [];
        foreach ($rows as $r) {
            $items[] = [
                'id'          => (int) $r['id'],
                'ts'          => (string) $r['ts'],
                'actor'       => $r['actor'],
                'role'        => $r['role'],
                'action'      => (string) $r['action'],
                'entity_type' => $r['entity_type'],
                'entity_id'   => $r['entity_id'],
                'before'      => tj_json_col($r['before_json']),
                'after'       => tj_json_col($r['after_json']),
                'warnings'    => tj_json_col($r['warnings_json']),
            ];
        }
        header('Cache-Control: no-store');
        sendJson(['success' => true, 'total' => (int) $cst->fetchColumn(), 'limit' => $limit, 'offset' => $offset, 'items' => $items]);
    });
}
