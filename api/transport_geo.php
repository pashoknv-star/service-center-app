<?php

declare(strict_types=1);

/**
 * transport_geo.php — геопрокси модуля «Транспорт» (V10-T7). ЕДИНСТВЕННАЯ точка исходящих запросов модуля
 * (кроме тайлов карты, которые браузер грузит сам). Проект — reports/V10/SPIKE_MAP.md §5–§6; тесты — api/transport_geo_test.php
 * (сьют `transportgeo`, поддельный внешний сервис, журнал «что ушло наружу», негативный контроль).
 *
 * POST api/transport_geo.php?action=search|reverse|route   Content-Type: application/json   — admin и supervisor (require_edit()).
 *   search  {q}                      → {success, degraded:false, cached, items:[{name,lat,lon,kind,county,state}]}      (поиск населённого пункта)
 *   reverse {lat, lon}               → {success, degraded:false, cached, place:{name,level,county,state}}               (name/level = null «в поле»)
 *   route   {lat1, lon1, lat2, lon2} → {success, degraded:false, cached, route:{km,sec,min_map}}                         (min_map — минуты вверх до 15)
 *   Любой отказ внешнего сервиса (таймаут, 4xx/5xx, не-JSON, нет связи, лимит частоты, circuit-breaker, нет маршрута) —
 *   HTTP 200 {success:true, degraded:true, reason}: форма продолжает работать вручную, клиент скрывает «Подставить».
 *   reason: timeout | connect_error | too_large | invalid_json | bad_response | http_<код> | rate_limited | circuit_open |
 *           no_route | storage_error | no_provider.
 *   Ошибки запроса (наружу не уходит ничего): 401 unauthorized; 403 forbidden (viewer); 405 method_not_allowed (только POST);
 *   400 invalid_action / invalid_json; 422 bad_place_name / bad_coords; 500 server_error.
 *
 * Что уходит наружу (SPIKE_MAP §6.1): ТОЛЬКО название населённого пункта (прошло белый список) и координаты, округлённые до 3 знаков;
 * метод GET, заголовки — User-Agent проекта (+ e-mail из конфига), Accept; для ORS — ключ приложения в Authorization; для Valhalla —
 * X-Client-Id приложения. Не уходят: Cookie, Referer, Origin, X-Forwarded-For, тело, адрес/заголовок/абонент/телефон заявки.
 * Клиенту возвращается только белый список полей (SPIKE_MAP §6.3): улицы, номера домов, индексы, hint, osm_id, display_name — отбрасываются.
 *
 * Состояние (таблица geo_cache схемы v15, без новых таблиц): кэш ответов (kind search|reverse|route; TTL 90/90/30 суток; «не найдено» — 1 час;
 * сбои не кэшируются), глобальный лимит частоты к сервису (kind=rl, rl:<сервис>; ≥ gap_ms между запросами), пользовательский лимит (rl, ul:<users.id>),
 * circuit-breaker (kind=cb, cb:<сервис>: N сбоев за окно → пауза), метка «предупреждение про e-mail уже выведено» (kind=meta).
 * Каждая запись состояния — короткая транзакция BEGIN IMMEDIATE; сетевой вызов выполняется ВНЕ транзакции.
 *
 * Конфиг: data/transport_geo.config.php (вне git, закрыт data/.htaccess; в .gitignore) — файл возвращает массив
 * (формат и допустимые ключи — transport_geo_default_config()); при отсутствии файла — значения по умолчанию, e-mail — заглушка
 * OWNER_EMAIL_TO_BE_SET с одним предупреждением в error_log. Для тестов путь можно задать env TRANSPORT_GEO_CONFIG.
 * Ключи/e-mail в репозитории не хранятся; ключ ORS нигде не логируется и не отдаётся клиенту.
 *
 * Библиотечный режим: если до подключения определена константа TRANSPORT_GEO_LIB_ONLY — файл только определяет функции
 * (так тесты проверяют чистые функции: округление, проверки ввода, загрузка конфига) и обработчик не запускает.
 * Совместимо с PHP 8.1 (прод) и SQLite без новых возможностей (рекурсивных CTE, RETURNING и т.п. нет).
 */

if (!defined('TRANSPORT_GEO_LIB_ONLY')) {
    require_once __DIR__ . '/helpers.php';
    require_once __DIR__ . '/db.php';
    require_once __DIR__ . '/auth.php';
    require_once __DIR__ . '/transport_lib.php';
}

/** Идентификатор приложения (User-Agent и X-Client-Id для Valhalla). */
const TRANSPORT_GEO_APP_ID = 'ServiceCenterApp-Transport';
/** Заглушка e-mail проекта: владелец подставляет настоящий в data/transport_geo.config.php до деплоя. */
const TRANSPORT_GEO_EMAIL_PLACEHOLDER = 'OWNER_EMAIL_TO_BE_SET';
/** Фиксированная рамка поиска (ХМАО и окрестности) — константа, не данные пользователя. Nominatim: left,top,right,bottom. */
const TRANSPORT_GEO_VIEWBOX = '59.0,65.8,86.0,58.0';
/** Photon: minLon,minLat,maxLon,maxLat (та же рамка). */
const TRANSPORT_GEO_BBOX = '59.0,58.0,86.0,65.8';
/** Максимальный размер ответа внешнего сервиса, байт. */
const TRANSPORT_GEO_MAX_BYTES = 262144;
/** TTL кэша, секунды: поиск и обратный геокод — 90 суток (Nominatim требует кэшировать), маршрут — 30 суток, «не найдено» — 1 час. */
const TRANSPORT_GEO_TTL_PLACE = 90 * 86400;
const TRANSPORT_GEO_TTL_ROUTE = 30 * 86400;
const TRANSPORT_GEO_TTL_EMPTY = 3600;

/** «Адресные» слова: ввод с ними — адрес, а не населённый пункт; наружу не уходит. */
const TRANSPORT_GEO_ADDRESS_WORDS = ['ул', 'улица', 'пр', 'пр-кт', 'проспект', 'пер', 'переулок', 'проезд', 'ш', 'шоссе',
    'бульвар', 'б-р', 'наб', 'набережная', 'д', 'дом', 'корп', 'корпус', 'стр', 'строение', 'кв', 'квартира', 'оф', 'офис'];
/** Допустимые виды населённых пунктов в ответе поиска. */
const TRANSPORT_GEO_PLACE_KINDS = ['city', 'town', 'village', 'hamlet', 'suburb'];

// =====================================================================
// Конфиг
// =====================================================================

/**
 * Конфиг по умолчанию (он же — перечень допустимых ключей data/transport_geo.config.php). Адреса — публичные сервисы из
 * SPIKE_MAP §8: Nominatim (поиск, обратный геокод) + OSRM routing.openstreetmap.de (маршрут); запасные — Photon, ORS (нужен ключ), Valhalla.
 * Пример файла (без ключей): reports/V10/T7_transport_geo.config.example.php.
 *
 * @return array<string,mixed>
 */
function transport_geo_default_config(): array
{
    return [
        'contact_email'     => '',   // обязательно перед деплоем: попадает в User-Agent (требование OSMF/FOSSGIS)
        'nominatim_url'     => 'https://nominatim.openstreetmap.org',
        'photon_url'        => 'https://photon.komoot.io',
        'osrm_url'          => 'https://routing.openstreetmap.de/routed-car',
        'ors_url'           => 'https://api.openrouteservice.org',
        'valhalla_url'      => 'https://valhalla1.openstreetmap.de',
        'ors_key'           => '',   // ключ приложения ORS; пусто — ORS не используется
        'search_providers'  => ['nominatim', 'photon'],
        'route_providers'   => ['osrm', 'ors', 'valhalla'],
        'gap_ms'            => 1100, // минимум между запросами к одному сервису (политика: ≤ 1 запрос/с)
        'timeout_search_ms' => 4000, // общий таймаут поиска/обратного геокода
        'timeout_route_ms'  => 6000, // общий таймаут маршрута
        'user_per_min'      => 30,   // запросов наружу на пользователя в минуту
        'breaker_fails'     => 3,    // сбоев за окно → breaker открывается
        'breaker_window_s'  => 60,
        'breaker_open_s'    => 60,   // сколько секунд ответы degraded без обращения наружу
    ];
}

/**
 * Загрузка конфига: значения по умолчанию + проверенные значения из файла. Неизвестные ключи игнорируются; значение
 * неверного типа/диапазона заменяется значением по умолчанию (ошибка в конфиге не должна открыть путь наружу «куда попало»:
 * адрес принимается только http/https; e-mail — только простой адрес без пробелов/скобок/переводов строки).
 *
 * @return array<string,mixed>
 */
function transport_geo_load_config(?string $file = null): array
{
    $cfg = transport_geo_default_config();
    if ($file === null) {
        $env = getenv('TRANSPORT_GEO_CONFIG');
        $file = (is_string($env) && $env !== '') ? $env : dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'transport_geo.config.php';
    }
    if (!is_file($file)) {
        return $cfg;
    }
    try {
        if (function_exists('opcache_invalidate')) {
            @opcache_invalidate($file, true);   // конфиг правят вручную: изменения должны подхватываться сразу, а не через revalidate_freq
        }
        $raw = (static function (string $f) {
            return include $f;
        })($file);
    } catch (Throwable $e) {
        error_log('transport_geo: config file is broken (' . get_class($e) . '), defaults are used');
        return $cfg;
    }
    if (!is_array($raw)) {
        return $cfg;
    }
    foreach (['nominatim_url', 'photon_url', 'osrm_url', 'ors_url', 'valhalla_url'] as $k) {
        if (isset($raw[$k]) && is_string($raw[$k])) {
            $u = rtrim(trim($raw[$k]), '/');
            if (preg_match('#^https?://[^\s\'"<>\\\\]+$#', $u) === 1) {
                $cfg[$k] = $u;
            }
        }
    }
    $ranges = ['gap_ms' => [0, 60000], 'timeout_search_ms' => [200, 30000], 'timeout_route_ms' => [200, 30000], 'user_per_min' => [1, 100000],
        'breaker_fails' => [1, 1000], 'breaker_window_s' => [1, 3600], 'breaker_open_s' => [1, 86400]];
    foreach ($ranges as $k => [$min, $max]) {
        $v = $raw[$k] ?? null;
        if (is_string($v) && preg_match('/^\d{1,9}$/', $v) === 1) {
            $v = (int) $v;
        }
        if (is_int($v) && $v >= $min && $v <= $max) {
            $cfg[$k] = $v;
        }
    }
    foreach (['search_providers' => ['nominatim', 'photon'], 'route_providers' => ['osrm', 'ors', 'valhalla']] as $k => $allowed) {
        if (isset($raw[$k]) && is_array($raw[$k])) {
            $list = [];
            foreach ($raw[$k] as $p) {
                if (is_string($p) && in_array($p, $allowed, true) && !in_array($p, $list, true)) {
                    $list[] = $p;
                }
            }
            if ($list !== []) {
                $cfg[$k] = $list;
            }
        }
    }
    if (isset($raw['ors_key']) && is_string($raw['ors_key'])) {
        $key = trim($raw['ors_key']);
        $cfg['ors_key'] = preg_match('/^[\x21-\x7E]{1,200}$/', $key) === 1 ? $key : '';
    }
    if (isset($raw['contact_email']) && is_string($raw['contact_email'])) {
        $em = trim($raw['contact_email']);
        $cfg['contact_email'] = (strlen($em) <= 120 && preg_match('/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\z/', $em) === 1) ? $em : '';
    }
    return $cfg;
}

/** User-Agent проекта; без e-mail в конфиге — заглушка, предупреждение в error_log один раз (метка в geo_cache). */
function transport_geo_user_agent(array $cfg, ?PDO $pdo = null): string
{
    $email = (string) ($cfg['contact_email'] ?? '');
    if ($email === '') {
        $email = TRANSPORT_GEO_EMAIL_PLACEHOLDER;
        if ($pdo !== null) {
            try {
                $st = $pdo->prepare("INSERT OR IGNORE INTO geo_cache (key, kind, payload_json, fetched_at) VALUES ('meta:email_warned', 'meta', '{}', :t)");
                $st->execute([':t' => (string) time()]);
                if ($st->rowCount() === 1) {
                    error_log('transport_geo: contact_email is not set in data/transport_geo.config.php — User-Agent uses placeholder ' . TRANSPORT_GEO_EMAIL_PLACEHOLDER);
                }
            } catch (Throwable $e) {
                // метка — удобство, а не условие работы
            }
        }
    }
    return TRANSPORT_GEO_APP_ID . '/0.1 (internal staff-scheduling tool; contact: ' . $email . ')';
}

// =====================================================================
// Белый список входа
// =====================================================================

/**
 * Название населённого пункта: только буквы, пробел, дефис, точка, апостроф; 2..60 знаков; ≤ 3 слов; без цифр и запятых;
 * без «адресных» слов, без инициалов («И.И.») и без формы ФИО (третье слово на -вич/-вна/-ична). Возвращает нормализованную
 * строку или null — отказ ДО любого исходящего запроса. Остаточный риск (SPIKE_MAP §6.2): имя собственное из одного слова пройдёт.
 */
function transport_geo_place_name(string $s): ?string
{
    if (preg_match('//u', $s) !== 1) {
        return null;
    }
    $s = trim(preg_replace('/\s+/u', ' ', $s) ?? '');
    $len = mb_strlen($s);
    if ($len < 2 || $len > 60) {
        return null;
    }
    if (preg_match('/^\p{L}[\p{L} .\'’\-]*$/u', $s) !== 1) {
        return null;
    }
    $words = explode(' ', $s);
    if (count($words) > 3) {
        return null;
    }
    foreach ($words as $w) {
        if (in_array(mb_strtolower(rtrim($w, '.'), 'UTF-8'), TRANSPORT_GEO_ADDRESS_WORDS, true)) {
            return null;
        }
        if (preg_match('/^(\p{L}\.)+$/u', $w) === 1) {
            return null;
        }
    }
    if (count($words) === 3 && preg_match('/(вич|вна|ична)$/u', mb_strtolower($words[2], 'UTF-8')) === 1) {
        return null;
    }
    return $s;
}

/** Координата: число (или числовая строка) в диапазоне; округляется до 3 знаков (≈ 100 м). Иначе null. */
function transport_geo_coord(mixed $v, float $min, float $max): ?float
{
    if (is_string($v)) {
        if (preg_match('/^-?\d{1,3}(\.\d{1,8})?$/', $v) !== 1) {
            return null;
        }
    } elseif (!is_int($v) && !is_float($v)) {
        return null;
    }
    $f = (float) $v;
    if (!is_finite($f) || $f < $min || $f > $max) {
        return null;
    }
    $r = round($f, 3);
    return $r == 0.0 ? 0.0 : $r;   // -0.0 → 0.0
}

// =====================================================================
// Округление времени пути (SPIKE_MAP §5; эквивалент JS — js/transport_geo_round.js)
// =====================================================================

/**
 * Секунды сервиса маршрутов → минуты, кратные 15: сек округляется до целых; 0 → 0; любое положительное → ceil(сек/900)·15
 * (то есть не меньше 15). Не число / отрицательное / нет оценки → null. Целочисленная арифметика — без ошибок плавающей точки на границах.
 */
function transport_geo_leg_min_map(mixed $sec): ?int
{
    if (!is_int($sec) && !is_float($sec)) {
        return null;
    }
    if (!is_finite((float) $sec) || $sec < 0) {
        return null;
    }
    $s = (int) round((float) $sec);
    if ($s === 0) {
        return 0;
    }
    return intdiv($s + 899, 900) * 15;
}

// =====================================================================
// Запросы к провайдерам: URL — фиксированные шаблоны, значения только из валидаторов
// =====================================================================

/**
 * Запрос к провайдеру: [url, дополнительные заголовки]. $args: search — ['name']; reverse — ['lat','lon']; route — ['lat1','lon1','lat2','lon2'].
 *
 * @return array{0:string,1:string[]}
 */
function transport_geo_request(array $cfg, string $svc, string $kind, array $args): array
{
    $h = ['Accept: application/json'];
    if ($svc === 'nominatim' && $kind === 'search') {
        return [$cfg['nominatim_url'] . '/search?' . http_build_query([
            'format' => 'jsonv2', 'q' => $args['name'], 'countrycodes' => 'ru', 'limit' => 5,
            'accept-language' => 'ru', 'addressdetails' => 1, 'viewbox' => TRANSPORT_GEO_VIEWBOX,
        ], '', '&', PHP_QUERY_RFC3986), $h];
    }
    if ($svc === 'nominatim' && $kind === 'reverse') {
        return [$cfg['nominatim_url'] . '/reverse?' . http_build_query([
            'format' => 'jsonv2', 'lat' => sprintf('%.3f', $args['lat']), 'lon' => sprintf('%.3f', $args['lon']), 'zoom' => 14,
            'accept-language' => 'ru', 'addressdetails' => 1,
        ], '', '&', PHP_QUERY_RFC3986), $h];
    }
    if ($svc === 'photon' && $kind === 'search') {
        return [$cfg['photon_url'] . '/api/?' . http_build_query([
            'q' => $args['name'], 'limit' => 5, 'osm_tag' => 'place', 'bbox' => TRANSPORT_GEO_BBOX,
        ], '', '&', PHP_QUERY_RFC3986), $h];
    }
    if ($kind === 'route') {
        $from = sprintf('%.3f,%.3f', $args['lon1'], $args['lat1']);   // lon,lat
        $to = sprintf('%.3f,%.3f', $args['lon2'], $args['lat2']);
        if ($svc === 'osrm') {
            return [$cfg['osrm_url'] . '/route/v1/driving/' . $from . ';' . $to . '?overview=false&alternatives=false&steps=false', $h];
        }
        if ($svc === 'ors') {
            $h[] = 'Authorization: ' . $cfg['ors_key'];
            return [$cfg['ors_url'] . '/v2/directions/driving-car?start=' . $from . '&end=' . $to, $h];
        }
        if ($svc === 'valhalla') {
            $h[] = 'X-Client-Id: ' . TRANSPORT_GEO_APP_ID;
            $json = json_encode([
                'locations' => [['lat' => $args['lat1'], 'lon' => $args['lon1']], ['lat' => $args['lat2'], 'lon' => $args['lon2']]],
                'costing' => 'auto', 'directions_options' => ['units' => 'kilometers'],
            ]);
            return [$cfg['valhalla_url'] . '/route?json=' . rawurlencode((string) $json), $h];
        }
    }
    throw new LogicException('transport_geo: no request template for ' . $svc . '/' . $kind);
}

/**
 * GET без cookie/Referer/редиректов, с жёстким таймаутом и лимитом размера ответа. Ошибок не бросает.
 * reason: timeout | connect_error | too_large | no_transport | http_<код> | invalid_json | null. Тело отдаётся и при не-2xx, если это JSON.
 *
 * @param string[] $headers
 * @return array{ok:bool,status:int,body:?array,ms:int,reason:?string}
 */
function transport_geo_http_get(string $url, int $timeoutMs, array $headers, string $userAgent): array
{
    $t0 = microtime(true);
    $ms = static fn(): int => (int) round((microtime(true) - $t0) * 1000);
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'status' => 0, 'body' => null, 'ms' => 0, 'reason' => 'no_transport'];
    }
    $buf = '';
    $tooLarge = false;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_HTTPGET => true,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_NOSIGNAL => true,
        CURLOPT_CONNECTTIMEOUT_MS => min($timeoutMs, 2000),
        CURLOPT_TIMEOUT_MS => $timeoutMs,
        CURLOPT_USERAGENT => $userAgent,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_MAXFILESIZE => TRANSPORT_GEO_MAX_BYTES,
        CURLOPT_WRITEFUNCTION => static function ($c, string $chunk) use (&$buf, &$tooLarge): int {
            $buf .= $chunk;
            if (strlen($buf) > TRANSPORT_GEO_MAX_BYTES) {
                $tooLarge = true;
                return 0;   // прерываем передачу
            }
            return strlen($chunk);
        },
    ]);
    $okExec = curl_exec($ch);
    $errno = curl_errno($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($tooLarge || $errno === 63) {
        return ['ok' => false, 'status' => $status, 'body' => null, 'ms' => $ms(), 'reason' => 'too_large'];
    }
    if ($okExec === false) {
        return ['ok' => false, 'status' => 0, 'body' => null, 'ms' => $ms(), 'reason' => $errno === 28 ? 'timeout' : 'connect_error'];
    }
    $json = json_decode($buf, true);
    $body = is_array($json) ? $json : null;
    if ($status < 200 || $status >= 300) {
        return ['ok' => false, 'status' => $status, 'body' => $body, 'ms' => $ms(), 'reason' => 'http_' . $status];
    }
    if ($body === null) {
        return ['ok' => false, 'status' => $status, 'body' => null, 'ms' => $ms(), 'reason' => 'invalid_json'];
    }
    return ['ok' => true, 'status' => $status, 'body' => $body, 'ms' => $ms(), 'reason' => null];
}

// =====================================================================
// Белый список выхода: из ответа сервиса берём только разрешённые поля
// =====================================================================

/** Строка из ответа сервиса: без управляющих символов, ≤ $max знаков; не строка → ''. */
function transport_geo_text(mixed $s, int $max = 100): string
{
    if (!is_string($s)) {
        return '';
    }
    $s = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $s) ?? '';
    $s = trim(preg_replace('/\s+/u', ' ', $s) ?? '');
    return mb_substr($s, 0, $max);
}

/** Название населённого пункта без префикса административной единицы («городское поселение Советский» → «Советский»). */
function transport_geo_clean_name(mixed $s): string
{
    $s = transport_geo_text($s);
    $s = preg_replace('/^(городской округ город|городской округ|городское поселение|сельское поселение|муниципальное образование|муниципальный округ|муниципальный район)\s+/iu', '', $s) ?? $s;
    return $s;
}

/** Из ХМАО ли пункт (их показываем первыми). */
function transport_geo_is_khm(string $state, string $iso): bool
{
    return $iso === 'RU-KHM' || mb_strpos($state, 'Ханты-Мансийск') !== false;
}

/**
 * Поиск → список пунктов; null — ответ не той формы. Элемент: name, lat, lon (5 знаков), kind, county, state.
 * Nominatim — список объектов; Photon — GeoJSON FeatureCollection. Оставляем только населённые пункты, ХМАО — первыми.
 *
 * @return array<int,array<string,mixed>>|null
 */
function transport_geo_parse_search(string $svc, array $body): ?array
{
    $rows = [];
    if ($svc === 'nominatim') {
        if (!array_is_list($body)) {
            return null;
        }
        foreach ($body as $r) {
            if (!is_array($r) || !isset($r['lat'], $r['lon']) || !is_numeric($r['lat']) || !is_numeric($r['lon'])) {
                continue;
            }
            $a = is_array($r['address'] ?? null) ? $r['address'] : [];
            $kind = transport_geo_text($r['type'] ?? '', 30);
            $name = transport_geo_clean_name($r['name'] ?? '');
            if ($name === '' && isset($a[$kind])) {
                $name = transport_geo_clean_name($a[$kind]);
            }
            $rows[] = ['name' => $name, 'lat' => (float) $r['lat'], 'lon' => (float) $r['lon'], 'kind' => $kind,
                'county' => transport_geo_text($a['county'] ?? ''), 'state' => transport_geo_text($a['state'] ?? ''),
                'iso' => transport_geo_text($a['ISO3166-2-lvl4'] ?? '', 20)];
        }
    } elseif ($svc === 'photon') {
        if (!isset($body['features']) || !is_array($body['features']) || !array_is_list($body['features'])) {
            return null;
        }
        foreach ($body['features'] as $f) {
            $p = is_array($f) ? ($f['properties'] ?? null) : null;
            $c = is_array($f) ? ($f['geometry']['coordinates'] ?? null) : null;
            if (!is_array($p) || !is_array($c) || count($c) < 2 || !is_numeric($c[0]) || !is_numeric($c[1]) || ($p['osm_key'] ?? '') !== 'place') {
                continue;
            }
            $rows[] = ['name' => transport_geo_clean_name($p['name'] ?? ''), 'lat' => (float) $c[1], 'lon' => (float) $c[0],
                'kind' => transport_geo_text($p['osm_value'] ?? '', 30), 'county' => transport_geo_text($p['county'] ?? ''),
                'state' => transport_geo_text($p['state'] ?? ''), 'iso' => ''];
        }
    } else {
        return null;
    }
    $items = [];
    foreach ($rows as $r) {
        if ($r['name'] === '' || !in_array($r['kind'], TRANSPORT_GEO_PLACE_KINDS, true) || abs($r['lat']) > 90 || abs($r['lon']) > 180) {
            continue;
        }
        $items[] = $r;
    }
    usort($items, static fn(array $x, array $y): int => (int) transport_geo_is_khm($y['state'], $y['iso']) <=> (int) transport_geo_is_khm($x['state'], $x['iso']));
    $out = [];
    foreach (array_slice($items, 0, 5) as $r) {
        $out[] = ['name' => $r['name'], 'lat' => round($r['lat'], 5), 'lon' => round($r['lon'], 5), 'kind' => $r['kind'], 'county' => $r['county'], 'state' => $r['state']];
    }
    return $out;
}

/**
 * Обратный геокод → {name, level, county, state}; null — ответ не той формы. Берём city|town|village|hamlet, иначе municipality
 * (без префикса); улица, дом, индекс, osm_id и display_name отбрасываются. «Не найдено» (поле error) и «в поле» — name/level = null.
 *
 * @return array<string,mixed>|null
 */
function transport_geo_parse_reverse(array $r): ?array
{
    if (isset($r['error']) && !isset($r['address'])) {
        return ['name' => null, 'level' => null, 'county' => '', 'state' => ''];
    }
    if (!isset($r['address']) || !is_array($r['address'])) {
        return null;
    }
    $a = $r['address'];
    $county = transport_geo_text($a['county'] ?? '');
    $state = transport_geo_text($a['state'] ?? '');
    foreach (['city', 'town', 'village', 'hamlet', 'municipality'] as $k) {
        $name = transport_geo_clean_name($a[$k] ?? '');
        if ($name !== '') {
            return ['name' => $name, 'level' => $k, 'county' => $county, 'state' => $state];
        }
    }
    return ['name' => null, 'level' => null, 'county' => $county, 'state' => $state];
}

/**
 * Маршрут → {km (0,1), sec, min_map}; строка 'no_route' — сервис ответил, что маршрута нет; null — ответ не той формы.
 *
 * @return array<string,mixed>|string|null
 */
function transport_geo_parse_route(string $svc, array $b): array|string|null
{
    $m = null;
    $s = null;
    if ($svc === 'osrm') {
        if (!isset($b['code'])) {
            return null;
        }
        if ($b['code'] !== 'Ok') {
            return 'no_route';
        }
        $rt = $b['routes'][0] ?? null;
        if (!is_array($rt)) {
            return null;
        }
        $m = $rt['distance'] ?? null;
        $s = $rt['duration'] ?? null;
    } elseif ($svc === 'ors') {
        $sum = $b['features'][0]['properties']['summary'] ?? null;
        if (!is_array($sum)) {
            return isset($b['error']) ? 'no_route' : null;
        }
        $m = $sum['distance'] ?? null;
        $s = $sum['duration'] ?? null;
    } elseif ($svc === 'valhalla') {
        $trip = $b['trip'] ?? null;
        if (!is_array($trip)) {
            return isset($b['error_code']) || isset($b['error']) ? 'no_route' : null;
        }
        if (($trip['status'] ?? null) !== 0) {
            return 'no_route';
        }
        $km = $trip['summary']['length'] ?? null;
        $m = is_int($km) || is_float($km) ? $km * 1000 : null;
        $s = $trip['summary']['time'] ?? null;
    } else {
        return null;
    }
    foreach ([$m, $s] as $n) {
        if ((!is_int($n) && !is_float($n)) || !is_finite((float) $n) || $n < 0 || $n > 1e9) {
            return null;
        }
    }
    $sec = (int) round((float) $s);
    return ['km' => round((float) $m / 1000, 1), 'sec' => $sec, 'min_map' => transport_geo_leg_min_map($sec)];
}

// =====================================================================
// Состояние в geo_cache: кэш, лимиты частоты, circuit-breaker
// =====================================================================

/** @return array<string,mixed>|null */
function transport_geo_cache_get(PDO $pdo, string $key, int $ttl): ?array
{
    $st = $pdo->prepare('SELECT payload_json, fetched_at FROM geo_cache WHERE key = ?');
    $st->execute([$key]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }
    $v = json_decode((string) $row['payload_json'], true);
    if (!is_array($v)) {
        return null;
    }
    $empty = (array_key_exists('items', $v) && $v['items'] === []) || (isset($v['place']) && is_array($v['place']) && ($v['place']['name'] ?? 1) === null);
    $age = time() - (int) $row['fetched_at'];
    return $age > ($empty ? min($ttl, TRANSPORT_GEO_TTL_EMPTY) : $ttl) ? null : $v;
}

function transport_geo_cache_put(PDO $pdo, string $key, string $kind, array $payload): void
{
    $st = $pdo->prepare('INSERT OR REPLACE INTO geo_cache (key, kind, payload_json, fetched_at) VALUES (?, ?, ?, ?)');
    $st->execute([$key, $kind, (string) json_encode($payload, JSON_UNESCAPED_UNICODE), (string) time()]);
    if (random_int(1, 25) === 1) {   // изредка — уборка просроченного и старых счётчиков
        $pdo->prepare("DELETE FROM geo_cache WHERE kind IN ('search','reverse','route') AND CAST(fetched_at AS INTEGER) < ?")->execute([time() - TRANSPORT_GEO_TTL_PLACE - 86400]);
        $pdo->prepare("DELETE FROM geo_cache WHERE kind = 'rl' AND key LIKE 'ul:%' AND CAST(fetched_at AS INTEGER) < ?")->execute([time() - 3600]);
    }
}

/**
 * Глобальный лимит исходящих: не чаще 1 запроса в $minGapMs мс на один внешний сервис. Строка geo_cache(key='rl:<сервис>'),
 * проверка и запись — под BEGIN IMMEDIATE. true — можно идти наружу (метка времени уже записана).
 */
function transport_geo_rate_ok(PDO $pdo, string $service, int $minGapMs, ?int $nowMs = null): bool
{
    $nowMs ??= (int) round(microtime(true) * 1000);
    return (bool) transport_tx($pdo, static function () use ($pdo, $service, $minGapMs, $nowMs): bool {
        $st = $pdo->prepare('SELECT payload_json FROM geo_cache WHERE key = ?');
        $st->execute(['rl:' . $service]);
        $last = (int) ((json_decode((string) $st->fetchColumn(), true)['t'] ?? 0));
        if ($nowMs - $last < $minGapMs) {
            return false;
        }
        $up = $pdo->prepare("INSERT OR REPLACE INTO geo_cache (key, kind, payload_json, fetched_at) VALUES (?, 'rl', ?, ?)");
        $up->execute(['rl:' . $service, json_encode(['t' => $nowMs]), (string) intdiv($nowMs, 1000)]);
        return true;
    });
}

/** Пользовательский лимит: не больше $limit запросов наружу за окно 60 с (счётчик в geo_cache, key='ul:<users.id>'). */
function transport_geo_user_ok(PDO $pdo, string $userId, int $limit, ?int $now = null): bool
{
    $now ??= time();
    return (bool) transport_tx($pdo, static function () use ($pdo, $userId, $limit, $now): bool {
        $st = $pdo->prepare('SELECT payload_json FROM geo_cache WHERE key = ?');
        $st->execute(['ul:' . $userId]);
        $v = json_decode((string) $st->fetchColumn(), true);
        $w = (int) ($v['w'] ?? 0);
        $n = (int) ($v['n'] ?? 0);
        if ($now - $w >= 60) {
            $w = $now;
            $n = 0;
        }
        if ($n >= $limit) {
            return false;
        }
        $up = $pdo->prepare("INSERT OR REPLACE INTO geo_cache (key, kind, payload_json, fetched_at) VALUES (?, 'rl', ?, ?)");
        $up->execute(['ul:' . $userId, json_encode(['w' => $w, 'n' => $n + 1]), (string) $now]);
        return true;
    });
}

/** Открыт ли breaker сервиса (ответы degraded без обращения наружу). */
function transport_geo_breaker_open(PDO $pdo, string $service, ?int $now = null): bool
{
    $st = $pdo->prepare('SELECT payload_json FROM geo_cache WHERE key = ?');
    $st->execute(['cb:' . $service]);
    $v = json_decode((string) $st->fetchColumn(), true);
    return is_array($v) && (int) ($v['u'] ?? 0) > ($now ?? time());
}

/**
 * Итог вызова сервиса для breaker: успех обнуляет счётчик сбоев; сбой добавляет метку, и при $fails сбоях за $windowS секунд
 * breaker открывается на $openS секунд. Возвращает true, если этим вызовом breaker открылся.
 */
function transport_geo_breaker_record(PDO $pdo, string $service, bool $success, int $fails, int $windowS, int $openS, ?int $now = null): bool
{
    $now ??= time();
    return (bool) transport_tx($pdo, static function () use ($pdo, $service, $success, $fails, $windowS, $openS, $now): bool {
        $st = $pdo->prepare('SELECT payload_json FROM geo_cache WHERE key = ?');
        $st->execute(['cb:' . $service]);
        $raw = $st->fetchColumn();
        if ($success) {
            if ($raw !== false) {
                $pdo->prepare('DELETE FROM geo_cache WHERE key = ?')->execute(['cb:' . $service]);
            }
            return false;
        }
        $v = $raw === false ? [] : (json_decode((string) $raw, true) ?: []);
        $f = [];
        foreach ((array) ($v['f'] ?? []) as $ts) {
            if (is_int($ts) && $ts > $now - $windowS) {
                $f[] = $ts;
            }
        }
        $f[] = $now;
        $u = (int) ($v['u'] ?? 0);
        $opened = false;
        if (count($f) >= $fails) {
            $u = $now + $openS;
            $f = [];
            $opened = true;
        }
        $up = $pdo->prepare("INSERT OR REPLACE INTO geo_cache (key, kind, payload_json, fetched_at) VALUES (?, 'cb', ?, ?)");
        $up->execute(['cb:' . $service, json_encode(['f' => $f, 'u' => $u]), (string) $now]);
        return $opened;
    });
}

// =====================================================================
// Цепочка провайдеров
// =====================================================================

/**
 * Идёт по провайдерам в порядке конфига: breaker → лимит частоты → запрос → разбор. Успех — {ok:true, data}; отказ — {ok:false, reason},
 * где reason — причина основного (первого) провайдера. «Нет маршрута» — окончательный ответ (другие провайдеры не опрашиваются).
 *
 * @param string[] $providers
 * @return array{ok:bool,data?:array<string,mixed>,reason?:string}
 */
function transport_geo_call_chain(PDO $pdo, array $cfg, string $userAgent, string $kind, array $args, array $providers, int $timeoutMs): array
{
    $first = null;
    foreach ($providers as $svc) {
        if ($svc === 'ors' && (string) $cfg['ors_key'] === '') {
            continue;   // ключа нет — ORS не используется
        }
        $reason = null;
        try {
            if (transport_geo_breaker_open($pdo, $svc)) {
                $reason = 'circuit_open';
            } elseif (!transport_geo_rate_ok($pdo, $svc, (int) $cfg['gap_ms'])) {
                $reason = 'rate_limited';
            }
        } catch (Throwable $e) {
            error_log('transport_geo: state store failed (' . get_class($e) . ') service=' . $svc);
            $reason = 'storage_error';
        }
        if ($reason === null) {
            [$url, $headers] = transport_geo_request($cfg, $svc, $kind, $args);
            $r = transport_geo_http_get($url, $timeoutMs, $headers, $userAgent);
            $status = (int) $r['status'];
            $parsed = null;
            $badAnswer = false;   // сервис ответил «нет маршрута» кодом 400/404 — это ответ, а не сбой
            if ($r['ok']) {
                if ($kind === 'search') {
                    $parsed = transport_geo_parse_search($svc, $r['body']);
                    $parsed = $parsed === null ? null : ['items' => $parsed];
                } elseif ($kind === 'reverse') {
                    $p = transport_geo_parse_reverse($r['body']);
                    $parsed = $p === null ? null : ['place' => $p];
                } else {
                    $p = transport_geo_parse_route($svc, $r['body']);
                    if ($p === 'no_route') {
                        transport_geo_note($pdo, $cfg, $svc, true);
                        return ['ok' => false, 'reason' => 'no_route'];
                    }
                    $parsed = $p === null ? null : ['route' => $p];
                }
                if ($parsed === null) {
                    $reason = 'bad_response';
                }
            } else {
                $reason = (string) $r['reason'];
                if ($kind === 'route' && in_array($status, [400, 404], true) && is_array($r['body'])) {
                    $badAnswer = true;
                }
            }
            if ($badAnswer) {
                transport_geo_note($pdo, $cfg, $svc, true);
                return ['ok' => false, 'reason' => 'no_route'];
            }
            if ($reason === null) {
                transport_geo_note($pdo, $cfg, $svc, true);
                return ['ok' => true, 'data' => $parsed];
            }
            // Сбой сервиса. Клиентские 4xx (кроме 401/403/408/429) — не повод закрывать сервис; всё остальное считается.
            $client4xx = $status >= 400 && $status < 500 && !in_array($status, [401, 403, 408, 429], true);
            error_log('transport_geo: degraded service=' . $svc . ' reason=' . $reason . ' ms=' . (int) $r['ms']);
            if (!$client4xx) {
                transport_geo_note($pdo, $cfg, $svc, false);
            }
        }
        $first ??= $reason;
    }
    return ['ok' => false, 'reason' => $first ?? 'no_provider'];
}

/** Итог вызова сервиса → breaker (ошибки хранилища не прерывают ответ пользователю). */
function transport_geo_note(PDO $pdo, array $cfg, string $svc, bool $success): void
{
    try {
        $opened = transport_geo_breaker_record($pdo, $svc, $success, (int) $cfg['breaker_fails'], (int) $cfg['breaker_window_s'], (int) $cfg['breaker_open_s']);
        if ($opened) {
            error_log('transport_geo: breaker opened service=' . $svc . ' fails=' . (int) $cfg['breaker_fails'] . ' open_s=' . (int) $cfg['breaker_open_s']);
        }
    } catch (Throwable $e) {
        error_log('transport_geo: breaker store failed (' . get_class($e) . ') service=' . $svc);
    }
}

/** Ответ клиенту: успех (в т.ч. из кэша) — success, degraded:false, cached, <items|place|route>. */
function transport_geo_ok(array $payload, bool $cached): array
{
    return ['success' => true, 'degraded' => false, 'cached' => $cached] + $payload;
}

/** Деградация: HTTP 200, форма продолжает работать вручную. */
function transport_geo_degraded(string $reason): array
{
    return ['success' => true, 'degraded' => true, 'reason' => $reason];
}

// =====================================================================
// Обработчик
// =====================================================================

function transport_geo_main(): void
{
    handleOptions();
    transport_handle(static function (): void {
        $db = Database::getInstance();
        $pdo = $db->getPDO();
        $db->migrate();

        require_edit();   // аноним → 401; viewer → 403; admin и supervisor — дальше
        $user = current_user();
        $userId = (string) ($user['id'] ?? '');
        // Сессия — файловая и блокируется на время запроса: отпускаем ДО исходящего вызова, иначе параллельные запросы пользователя встанут в очередь.
        session_write_close();

        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
            transport_fail('method_not_allowed', 405);
        }
        $action = (string) ($_GET['action'] ?? '');
        if (!in_array($action, ['search', 'reverse', 'route'], true)) {
            transport_fail('invalid_action', 400);
        }
        $in = transport_read_body();
        $cfg = transport_geo_load_config();

        // 1. Белый список входа: всё, что не прошло, наружу не уходит. Лишние поля тела игнорируются.
        if ($action === 'search') {
            $name = transport_geo_place_name(is_string($in['q'] ?? null) ? $in['q'] : '');
            if ($name === null) {
                transport_fail('bad_place_name', 422);
            }
            $key = 'search:' . sha1(mb_strtolower($name, 'UTF-8'));
            $args = ['name' => $name];
            $ttl = TRANSPORT_GEO_TTL_PLACE;
            $providers = $cfg['search_providers'];
            $timeout = (int) $cfg['timeout_search_ms'];
        } elseif ($action === 'reverse') {
            $lat = transport_geo_coord($in['lat'] ?? null, -90.0, 90.0);
            $lon = transport_geo_coord($in['lon'] ?? null, -180.0, 180.0);
            if ($lat === null || $lon === null) {
                transport_fail('bad_coords', 422);
            }
            $key = 'reverse:' . sprintf('%.3f,%.3f', $lat, $lon);
            $args = ['lat' => $lat, 'lon' => $lon];
            $ttl = TRANSPORT_GEO_TTL_PLACE;
            $providers = ['nominatim'];
            $timeout = (int) $cfg['timeout_search_ms'];
        } else {
            $c = [transport_geo_coord($in['lat1'] ?? null, -90.0, 90.0), transport_geo_coord($in['lon1'] ?? null, -180.0, 180.0),
                transport_geo_coord($in['lat2'] ?? null, -90.0, 90.0), transport_geo_coord($in['lon2'] ?? null, -180.0, 180.0)];
            if (in_array(null, $c, true)) {
                transport_fail('bad_coords', 422);
            }
            $key = 'route:' . sprintf('%.3f,%.3f;%.3f,%.3f', $c[1], $c[0], $c[3], $c[2]);
            $args = ['lat1' => $c[0], 'lon1' => $c[1], 'lat2' => $c[2], 'lon2' => $c[3]];
            $ttl = TRANSPORT_GEO_TTL_ROUTE;
            $providers = $cfg['route_providers'];
            $timeout = (int) $cfg['timeout_route_ms'];
        }

        // 2. Кэш (ответ из кэша — без обращения наружу и без учёта в лимитах).
        $hit = transport_geo_cache_get($pdo, $key, $ttl);
        if ($hit !== null) {
            sendJson(transport_geo_ok($hit, true));
        }

        // 3. Пользовательский лимит (считаются только запросы, идущие наружу).
        try {
            $allowed = transport_geo_user_ok($pdo, $userId, (int) $cfg['user_per_min']);
        } catch (Throwable $e) {
            error_log('transport_geo: state store failed (' . get_class($e) . ')');
            sendJson(transport_geo_degraded('storage_error'));
        }
        if (!$allowed) {
            sendJson(transport_geo_degraded('rate_limited'));
        }

        // 4. Исходящий вызов по цепочке провайдеров; сбои не кэшируются.
        $ua = transport_geo_user_agent($cfg, $pdo);
        $res = transport_geo_call_chain($pdo, $cfg, $ua, $action, $args, $providers, $timeout);
        if (!$res['ok']) {
            sendJson(transport_geo_degraded((string) $res['reason']));
        }
        try {
            transport_geo_cache_put($pdo, $key, $action, $res['data']);
        } catch (Throwable $e) {
            error_log('transport_geo: cache write failed (' . get_class($e) . ')');
        }
        sendJson(transport_geo_ok($res['data'], false));
    });
}

if (!defined('TRANSPORT_GEO_LIB_ONLY')) {
    transport_geo_main();
}
