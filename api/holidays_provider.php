<?php

declare(strict_types=1);

/**
 * holidays_provider.php — возвращает производственный календарь РФ за год.
 *
 * Метод: GET
 * Параметр: ?year=2026 (необязательный; по умолчанию — текущий год).
 *
 * Ответ:
 *   {
 *     "year": 2026,
 *     "holidays": {
 *       "2026-01-01": { "type": "holiday", "label": "Новый год" },
 *       "2026-01-02": { "type": "weekend", "label": null },
 *       ...
 *     }
 *   }
 *
 * Логика:
 *   1. Читает предсгенерированный файл data/holidays/{year}.json.
 *   2. Если файл отсутствует — генерирует базовый календарь на лету
 *      (только выходные субботы/воскресенья + стандартные праздники,
 *      без переносов).
 *
 * Типы дней:
 *   holiday             — официальный праздник.
 *   weekend             — обычный выходной (суббота/воскресенье).
 *   transferred_day_off — будний день, ставший выходным из-за переноса.
 *   working_weekend     — суббота/воскресенье, ставшая рабочим днём.
 */

require_once __DIR__ . '/helpers.php';

// T1-1: файл можно подключить как библиотеку (api/tasks_rules.php) —
// define('HOLIDAYS_PROVIDER_AS_LIB', true) ДО require: тогда endpoint-часть
// не исполняется, доступны только функции holidays_provider_year() и
// generateFallbackHolidays(). Поведение HTTP-endpoint не меняется.
if (!defined('HOLIDAYS_PROVIDER_AS_LIB')) {
    handleOptions();
    requireMethod('GET');

    $year = isset($_GET['year']) ? (int) $_GET['year'] : (int) date('Y');

    // Диапазон разумных лет (защита от мусорного ввода).
    if ($year < 2000 || $year > 2100) {
        error('Year out of supported range', 400);
    }

    sendJson(holidays_provider_year($year));
}

/**
 * Производственный календарь за год: data/holidays/{year}.json, а при
 * отсутствии/повреждении файла — базовый fallback (выходные + праздники без переносов).
 *
 * @return array{year: int, holidays: array<string, array{type: string, label: string|null}>}
 */
function holidays_provider_year(int $year): array
{
    $jsonFile = dirname(__DIR__) . '/data/holidays/' . $year . '.json';

    if (is_readable($jsonFile)) {
        $raw = file_get_contents($jsonFile);
        $data = json_decode((string) $raw, true);
        if (is_array($data) && isset($data['holidays']) && is_array($data['holidays'])) {
            return $data;
        }
        // Если файл повреждён — падаем в fallback.
    }

    // Fallback: генерация базового календаря на лету (без официальных переносов).
    return [
        'year'     => $year,
        'holidays' => generateFallbackHolidays($year),
    ];
}

/**
 * Генерирует базовый производственный календарь:
 * все субботы/воскресенья + официальные праздники (без переносов).
 *
 * @param int $year
 * @return array<string, array{type: string, label: string|null}>
 */
function generateFallbackHolidays(int $year): array
{
    $result = [];

    // Официальные нерабочие праздничные дни (ст. 112 ТК РФ).
    $fixed = [
        '01-01' => 'Новый год',
        '01-02' => 'Новогодние каникулы',
        '01-03' => 'Новогодние каникулы',
        '01-04' => 'Новогодние каникулы',
        '01-05' => 'Новогодние каникулы',
        '01-06' => 'Новогодние каникулы',
        '01-07' => 'Рождество Христово',
        '01-08' => 'Новогодние каникулы',
        '02-23' => 'День защитника Отечества',
        '03-08' => 'Международный женский день',
        '05-01' => 'Праздник Весны и Труда',
        '05-09' => 'День Победы',
        '06-12' => 'День России',
        '11-04' => 'День народного единства',
    ];

    // 1. Добавляем праздники.
    foreach ($fixed as $md => $label) {
        $key = sprintf('%d-%s', $year, $md);
        $result[$key] = ['type' => 'holiday', 'label' => $label];
    }

    // 2. Добавляем все субботы и воскресенья года.
    $start = new DateTime(sprintf('%04d-01-01', $year));
    $end   = new DateTime(sprintf('%04d-12-31', $year));
    $interval = new DateInterval('P1D');
    $period   = new DatePeriod($start, $interval, $end->modify('+1 day'));

    foreach ($period as $dt) {
        $dow = (int) $dt->format('N'); // 1=Пн ... 7=Вс
        if ($dow === 6 || $dow === 7) {
            $key = $dt->format('Y-m-d');
            if (!isset($result[$key])) {
                $result[$key] = ['type' => 'weekend', 'label' => null];
            }
        }
    }

    // Сортируем по дате.
    ksort($result);

    return $result;
}
