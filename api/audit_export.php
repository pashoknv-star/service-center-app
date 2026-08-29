<?php

declare(strict_types=1);

/**
 * api/audit_export.php — GET: экспорт журнала аудита в трёх форматах.
 *
 * Требование E5 (ответ Pavel от 2026-08-26): формат пользователь выбирает сам.
 *
 * Доступ: ТОЛЬКО admin (require_auth + is_admin). Не-admin → 403.
 *
 * Параметры:
 *   ?format=xlsx|csv|md   (по умолчанию xlsx)
 *   ?days=N               горизонт выборки в днях (по умолчанию 7)
 *
 * Выборка: SELECT из audit_log за последние N дней, сортировка по ts DESC.
 * Файл:    audit-log-YYYY-MM-DD.<ext>, Content-Disposition: attachment.
 * Безопасность: Cache-Control: no-store (лог не кэшируется).
 *
 * Форматы:
 *   CSV  — UTF-8 с BOM, разделитель «;» (открывается в Excel RU-локали),
 *          колонки: ts, actor, role, action, entity_type, entity_id, details.
 *   MD   — таблица Markdown с теми же колонками.
 *   XLSX — чистая генерация на PHP (ZipArchive + вручную собранный sheets XML),
 *          без внешних библиотек. Если нет php-zip — graceful fallback:
 *          возвращаем csv с заголовком X-Audit-Export-Fallback: csv.
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

handleOptions();
requireMethod('GET');
require_admin(); // 401 если не залогинен, 403 если не admin

// --- Параметры ---
$format = strtolower((string) ($_GET['format'] ?? 'xlsx'));
if (!in_array($format, ['xlsx', 'csv', 'md'], true)) {
    $format = 'xlsx';
}

$days = (int) ($_GET['days'] ?? 7);
if ($days < 1) {
    $days = 7;
}

$cols = ['ts', 'actor', 'role', 'action', 'entity_type', 'entity_id', 'details'];
$headers = ['ts', 'actor', 'role', 'action', 'entity_type', 'entity_id', 'details'];

try {
    $db  = Database::getInstance();
    $pdo = $db->getPDO();
    $db->migrate();

    // Граница выборки: сейчас минус N дней. ts хранится в ISO 8601 UTC (date('c')),
    // поэтому строковое сравнение с датой в том же формате корректно.
    $cutoff = date('c', time() - $days * 86400);

    $stmt = $pdo->prepare(
        'SELECT ts, actor, role, action, entity_type, entity_id, details' . PHP_EOL .
        'FROM audit_log' . PHP_EOL .
        'WHERE ts >= :cutoff' . PHP_EOL .
        'ORDER BY ts DESC'
    );
    $stmt->execute([':cutoff' => $cutoff]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $filename = 'audit-log-' . date('Y-m-d') . '.' . $format;

    // Безопасность: лог не должен кэшироваться.
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    corsHeaders();

    // --- XLSX: fallback на CSV, если нет php-zip ---
    if ($format === 'xlsx' && !class_exists('ZipArchive')) {
        header('X-Audit-Export-Fallback: csv');
        $format = 'csv';
        $filename = 'audit-log-' . date('Y-m-d') . '.csv';
    }

    switch ($format) {
        case 'csv':
            header('Content-Type: text/csv; charset=utf-8');
            header('Content-Disposition: attachment; filename="' . $filename . '"');
            echo buildCsv($rows, $cols);
            break;

        case 'md':
            header('Content-Type: text/markdown; charset=utf-8');
            header('Content-Disposition: attachment; filename="' . $filename . '"');
            echo buildMd($rows, $headers);
            break;

        case 'xlsx':
        default:
            header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            header('Content-Disposition: attachment; filename="' . $filename . '"');
            echo buildXlsx($rows, $headers);
            break;
    }
    exit;
} catch (Throwable $e) {
    error('Server error: ' . $e->getMessage(), 500);
}

/**
 * Экранирует значение для inline-ячейки XML.
 */
function xmlEsc(string $s): string
{
    return htmlspecialchars($s, ENT_XML1 | ENT_QUOTES, 'UTF-8');
}

/**
 * Формирует CSV: UTF-8 + BOM, разделитель «;», значения в кавычках при необходимости.
 *
 * @param array $rows
 * @param array $cols Порядок колонок для вывода.
 * @return string
 */
function buildCsv(array $rows, array $cols): string
{
    $out = "\xEF\xBB\xBF"; // UTF-8 BOM
    $out .= implode(';', $cols) . "\r\n";
    foreach ($rows as $row) {
        $line = [];
        foreach ($cols as $c) {
            $v = (string) ($row[$c] ?? '');
            // Кавычка удваивается, поле оборачиваем, если есть ; " \r \n
            if (preg_match('/[;"\r\n]/', $v)) {
                $v = '"' . str_replace('"', '""', $v) . '"';
            }
            $line[] = $v;
        }
        $out .= implode(';', $line) . "\r\n";
    }
    return $out;
}

/**
 * Формирует Markdown-таблицу с заголовком и разделителем.
 *
 * @param array $rows
 * @param array $headers Названия колонок.
 * @return string
 */
function buildMd(array $rows, array $headers): string
{
    $esc = function (string $s): string {
        return str_replace(['|', "\r", "\n"], ['\\|', ' ', ' '], $s);
    };

    $out = '| ' . implode(' | ', array_map($esc, $headers)) . ' |' . "\n";
    $out .= '| ' . implode(' | ', array_fill(0, count($headers), '---')) . ' |' . "\n";
    foreach ($rows as $row) {
        $cells = [];
        foreach ($headers as $h) {
            $cells[] = $esc((string) ($row[$h] ?? ''));
        }
        $out .= '| ' . implode(' | ', $cells) . ' |' . "\n";
    }
    return $out;
}

/**
 * Генерирует минимально валидный XLSX на чистых PHP ZipArchive + XML.
 * Без внешних библиотек. Колонки — inline strings.
 *
 * @param array $rows
 * @param array $headers
 * @return string Содержимое .xlsx файла.
 */
function buildXlsx(array $rows, array $headers): string
{
    $contentTypes = <<<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>
XML;

    $rels = <<<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>
XML;

    $workbook = <<<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Audit" sheetId="1" r:id="rId1"/></sheets>
</workbook>
XML;

    $workbookRels = <<<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
XML;

    $styles = <<<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>
XML;

    // Лист: заголовок (стиль s="1" — жирный) + строки данных (inline string).
    $colLetter = function (int $i): string {
        // 1 => A, 26 => Z, 27 => AA ...
        $s = '';
        $i--; // 0-based
        while ($i >= 0) {
            $s = chr(65 + ($i % 26)) . $s;
            $i = intdiv($i, 26) - 1;
        }
        return $s;
    };

    $sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' . "\n";
    $sheet .= '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';

    // Строка заголовка.
    $sheetRow = '<row r="1">';
    foreach ($headers as $i => $h) {
        $ref = $colLetter($i + 1) . '1';
        $sheetRow .= '<c r="' . $ref . '" t="inlineStr" s="1"><is><t>' . xmlEsc((string) $h) . '</t></is></c>';
    }
    $sheetRow .= '</row>';
    $sheet .= $sheetRow;

    $r = 2;
    foreach ($rows as $row) {
        $sheetRow = '<row r="' . $r . '">';
        foreach ($headers as $i => $h) {
            $ref = $colLetter($i + 1) . $r;
            $cellVal = xmlEsc((string) ($row[$h] ?? ''));
            if ($cellVal === '') {
                // Пустая строка — просто пустая inline-ячейка, чтобы Excel не ругался.
                $cellVal = ' ';
            }
            $sheetRow .= '<c r="' . $ref . '" t="inlineStr"><is><t>' . $cellVal . '</t></is></c>';
        }
        $sheetRow .= '</row>';
        $sheet .= $sheetRow;
        $r++;
    }

    $sheet .= '</sheetData></worksheet>';

    // Собираем ZIP.
    $path = tempnam(sys_get_temp_dir(), 'audit_xlsx_');
    if ($path === false) {
        throw new RuntimeException('Cannot create temp file for xlsx');
    }
    $zip = new ZipArchive();
    if ($zip->open($path, ZipArchive::OVERWRITE) !== true) {
        @unlink($path);
        throw new RuntimeException('Cannot open ZipArchive for xlsx');
    }
    $zip->addFromString('[Content_Types].xml', $contentTypes);
    $zip->addFromString('_rels/.rels', $rels);
    $zip->addFromString('xl/workbook.xml', $workbook);
    $zip->addFromString('xl/_rels/workbook.xml.rels', $workbookRels);
    $zip->addFromString('xl/styles.xml', $styles);
    $zip->addFromString('xl/worksheets/sheet1.xml', $sheet);
    $zip->close();

    $data = file_get_contents($path);
    @unlink($path);
    if ($data === false) {
        throw new RuntimeException('Failed to read generated xlsx');
    }
    return $data;
}
