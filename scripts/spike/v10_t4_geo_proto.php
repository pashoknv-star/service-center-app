<?php
// V10-T4 SPIKE (прототип, НЕ код приложения): ядро будущего api/transport_geo.php.
// Показывает схему «белый список на входе → фиксированные параметры наружу → белый список на выходе → кэш → деградация».
// Не подключается к api/*, не трогает data/app.db. Проверяется v10_t4_geo_proto_test.php против ПОДДЕЛЬНОГО внешнего сервиса.
// Совместимо с PHP 8.1 (прод) — без возможностей новее.

const GEO_UA = 'ServiceCenterApp-Transport/0.1 (internal staff-scheduling tool; contact: OWNER_EMAIL_TO_BE_SET)';
// Фиксированная рамка поиска (ХМАО и окрестности) — константа, не данные пользователя: viewbox=left,top,right,bottom.
const GEO_VIEWBOX = '59.0,65.8,86.0,58.0';

/** Слова, по которым ввод считается адресом, а не населённым пунктом (улица/дом/квартира и т.п.). */
const GEO_ADDRESS_WORDS = array('ул', 'улица', 'пр', 'пр-кт', 'проспект', 'пер', 'переулок', 'проезд', 'ш', 'шоссе',
    'бульвар', 'б-р', 'наб', 'набережная', 'д', 'дом', 'корп', 'корпус', 'стр', 'строение', 'кв', 'квартира', 'оф', 'офис');

/**
 * Название населённого пункта: только буквы, пробел, дефис, точка, апостроф; 2..60 знаков; ≤ 3 слов;
 * без цифр и запятых; без «адресных» слов; без формы ФИО (третье слово на -вич/-вна/-ична).
 * Возвращает нормализованную строку или null (отказ ДО любого исходящего запроса).
 */
function geo_place_name(string $s): ?string
{
    $s = trim(preg_replace('/\s+/u', ' ', $s) ?? '');
    $len = mb_strlen($s);
    if ($len < 2 || $len > 60) {
        return null;
    }
    if (!preg_match('/^\p{L}[\p{L} .\'’\-]*$/u', $s)) {
        return null;                       // цифры, запятые, # и т.п. — отказ
    }
    $words = explode(' ', $s);
    if (count($words) > 3) {
        return null;
    }
    foreach ($words as $w) {
        if (in_array(mb_strtolower(rtrim($w, '.')), GEO_ADDRESS_WORDS, true)) {
            return null;
        }
    }
    if (count($words) === 3 && preg_match('/(вич|вна|ична)$/u', mb_strtolower($words[2]))) {
        return null;                       // «Фамилия Имя Отчество»
    }
    return $s;
}

/** Координата: число (или числовая строка) в допустимом диапазоне, округляется до 3 знаков (~100 м). */
function geo_coord($v, float $min, float $max): ?float
{
    if (is_string($v) && !preg_match('/^-?\d{1,3}(\.\d{1,8})?$/', $v)) {
        return null;
    }
    if (!is_int($v) && !is_float($v) && !is_string($v)) {
        return null;
    }
    $f = (float) $v;
    if (!is_finite($f) || $f < $min || $f > $max) {
        return null;
    }
    return round($f, 3);
}

/** @return array{url:string} Все параметры наружу — фиксированный список, значения — только из валидаторов выше. */
function geo_url_search(array $cfg, string $name): string
{
    return $cfg['nominatim'] . '/search?' . http_build_query(array(
        'format' => 'jsonv2', 'q' => $name, 'countrycodes' => 'ru', 'limit' => 5,
        'accept-language' => 'ru', 'addressdetails' => 1, 'viewbox' => GEO_VIEWBOX,
    ), '', '&', PHP_QUERY_RFC3986);
}

function geo_url_reverse(array $cfg, float $lat, float $lon): string
{
    return $cfg['nominatim'] . '/reverse?' . http_build_query(array(
        'format' => 'jsonv2', 'lat' => $lat, 'lon' => $lon, 'zoom' => 14,
        'accept-language' => 'ru', 'addressdetails' => 1,
    ), '', '&', PHP_QUERY_RFC3986);
}

function geo_url_route(array $cfg, float $lat1, float $lon1, float $lat2, float $lon2): string
{
    return $cfg['osrm'] . '/route/v1/driving/' . sprintf('%.3f,%.3f;%.3f,%.3f', $lon1, $lat1, $lon2, $lat2)
        . '?overview=false&alternatives=false&steps=false';
}

/** GET без cookie/Referer/редиректов, с жёстким таймаутом и лимитом размера ответа. */
function geo_http_get(string $url, int $timeoutMs): array
{
    $t0 = microtime(true);
    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_NOSIGNAL => true,
        CURLOPT_CONNECTTIMEOUT_MS => min($timeoutMs, 2000), CURLOPT_TIMEOUT_MS => $timeoutMs,
        CURLOPT_USERAGENT => GEO_UA, CURLOPT_HTTPHEADER => array('Accept: application/json'),
        CURLOPT_MAXFILESIZE => 262144, CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
    ));
    $raw = curl_exec($ch);
    $errno = curl_errno($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    $ms = (int) round((microtime(true) - $t0) * 1000);
    if ($raw === false) {
        return array('ok' => false, 'status' => 0, 'body' => null, 'ms' => $ms, 'reason' => $errno === 28 ? 'timeout' : 'connect_error');
    }
    if ($status < 200 || $status >= 300) {
        return array('ok' => false, 'status' => $status, 'body' => null, 'ms' => $ms, 'reason' => 'http_' . $status);
    }
    $json = json_decode((string) $raw, true);
    if (!is_array($json)) {
        return array('ok' => false, 'status' => $status, 'body' => null, 'ms' => $ms, 'reason' => 'invalid_json');
    }
    return array('ok' => true, 'status' => $status, 'body' => $json, 'ms' => $ms, 'reason' => null);
}

/** Ответ клиенту — только эти поля (улицы, hint, osm_id, адресные детали не пересылаются). */
function geo_out_search(array $rows): array
{
    $out = array();
    foreach ($rows as $r) {
        if (!is_array($r) || !isset($r['lat'], $r['lon'])) {
            continue;
        }
        $a = is_array($r['address'] ?? null) ? $r['address'] : array();
        $out[] = array(
            'name' => (string) ($r['name'] ?? ''), 'lat' => round((float) $r['lat'], 5), 'lon' => round((float) $r['lon'], 5),
            'kind' => (string) ($r['type'] ?? ''), 'county' => (string) ($a['county'] ?? ''), 'state' => (string) ($a['state'] ?? ''),
        );
    }
    return $out;
}

function geo_out_reverse(array $r): array
{
    $a = is_array($r['address'] ?? null) ? $r['address'] : array();
    foreach (array('city', 'town', 'village', 'hamlet', 'municipality') as $k) {   // населённый пункт, не улица
        if (!empty($a[$k])) {
            return array('name' => (string) $a[$k], 'level' => $k, 'county' => (string) ($a['county'] ?? ''), 'state' => (string) ($a['state'] ?? ''));
        }
    }
    return array('name' => null, 'level' => null, 'county' => (string) ($a['county'] ?? ''), 'state' => (string) ($a['state'] ?? ''));
}

/** Формула из SPIKE_MAP §4 (то же, что v10_t4_rounding.php): секунды → минуты, кратные 15. */
function geo_leg_min_map($sec): ?int
{
    if (!is_numeric($sec) || !is_finite((float) $sec) || $sec < 0) {
        return null;
    }
    $s = (int) round((float) $sec);
    return $s === 0 ? 0 : (int) ceil($s / 900) * 15;
}

function geo_out_route(array $r): ?array
{
    $rt = $r['routes'][0] ?? null;
    if (!is_array($rt) || ($r['code'] ?? '') !== 'Ok' || !isset($rt['distance'], $rt['duration'])) {
        return null;
    }
    return array('km' => round($rt['distance'] / 1000, 1), 'sec' => (int) round($rt['duration']), 'min_map' => geo_leg_min_map($rt['duration']));
}

/** Кэш geo_cache(key, kind, payload_json, fetched_at) в SQLite (в прототипе — временная БД, не data/app.db). */
function geo_cache_open(string $path): PDO
{
    $pdo = new PDO('sqlite:' . $path);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('CREATE TABLE IF NOT EXISTS geo_cache (key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL)');
    return $pdo;
}

function geo_cache_get(PDO $pdo, string $key, int $ttlSec): ?array
{
    $st = $pdo->prepare('SELECT payload_json, fetched_at FROM geo_cache WHERE key = ?');
    $st->execute(array($key));
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row || time() - (int) $row['fetched_at'] > $ttlSec) {
        return null;
    }
    $v = json_decode($row['payload_json'], true);
    return is_array($v) ? $v : null;
}

function geo_cache_put(PDO $pdo, string $key, string $kind, array $payload): void
{
    $st = $pdo->prepare('INSERT OR REPLACE INTO geo_cache (key, kind, payload_json, fetched_at) VALUES (?, ?, ?, ?)');
    $st->execute(array($key, $kind, json_encode($payload, JSON_UNESCAPED_UNICODE), time()));
}

/**
 * Глобальный лимит исходящих: не чаще 1 запроса в $minGapMs мс на один внешний сервис (политика: ≤ 1 запрос/с).
 * Состояние — строка geo_cache(key='rl:<сервис>'), обновляется под BEGIN IMMEDIATE. true — можно идти наружу.
 */
function geo_rate_ok(PDO $pdo, string $service, int $minGapMs, ?int $nowMs = null): bool
{
    $nowMs = $nowMs ?? (int) round(microtime(true) * 1000);
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $st = $pdo->prepare('SELECT payload_json FROM geo_cache WHERE key = ?');
        $st->execute(array('rl:' . $service));
        $last = (int) (json_decode((string) $st->fetchColumn(), true)['t'] ?? 0);
        $ok = $nowMs - $last >= $minGapMs;
        if ($ok) {
            $up = $pdo->prepare("INSERT OR REPLACE INTO geo_cache (key, kind, payload_json, fetched_at) VALUES (?, 'rl', ?, ?)");
            $up->execute(array('rl:' . $service, json_encode(array('t' => $nowMs)), (int) ($nowMs / 1000)));
        }
        $pdo->exec('COMMIT');
        return $ok;
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

/**
 * Единая точка: kind = search|reverse|route; $in — «сырой» вход клиента (любые поля!). Возвращает ответ клиенту.
 * Любая проблема внешнего сервиса → {degraded:true, reason} (форма работает вручную), HTTP-код 200.
 */
function geo_handle(string $kind, array $in, array $cfg, PDO $cache): array
{
    $gapMs = $cfg['gap_ms'] ?? 1100;
    if ($kind === 'search') {
        $name = geo_place_name((string) ($in['q'] ?? ''));
        if ($name === null) {
            return array('ok' => false, 'error' => 'bad_place_name');
        }
        $key = 'search:' . sha1(mb_strtolower($name));
        $url = geo_url_search($cfg, $name);
        $service = 'nominatim'; $ttl = 90 * 86400; $filter = 'geo_out_search';
    } elseif ($kind === 'reverse') {
        $lat = geo_coord($in['lat'] ?? null, -90, 90);
        $lon = geo_coord($in['lon'] ?? null, -180, 180);
        if ($lat === null || $lon === null) {
            return array('ok' => false, 'error' => 'bad_coords');
        }
        $key = 'reverse:' . sprintf('%.3f,%.3f', $lat, $lon);
        $url = geo_url_reverse($cfg, $lat, $lon);
        $service = 'nominatim'; $ttl = 90 * 86400; $filter = 'geo_out_reverse';
    } elseif ($kind === 'route') {
        $c = array(geo_coord($in['lat1'] ?? null, -90, 90), geo_coord($in['lon1'] ?? null, -180, 180),
                   geo_coord($in['lat2'] ?? null, -90, 90), geo_coord($in['lon2'] ?? null, -180, 180));
        if (in_array(null, $c, true)) {
            return array('ok' => false, 'error' => 'bad_coords');
        }
        $key = 'route:' . sprintf('%.3f,%.3f;%.3f,%.3f', $c[1], $c[0], $c[3], $c[2]);
        $url = geo_url_route($cfg, $c[0], $c[1], $c[2], $c[3]);
        $service = 'osrm'; $ttl = 30 * 86400; $filter = 'geo_out_route';
    } else {
        return array('ok' => false, 'error' => 'bad_kind');
    }

    $hit = geo_cache_get($cache, $key, $ttl);
    if ($hit !== null) {
        return array('ok' => true, 'cached' => true, 'data' => $hit);
    }
    if (!geo_rate_ok($cache, $service, $gapMs)) {
        return array('ok' => true, 'degraded' => true, 'reason' => 'rate_limited');
    }
    $r = geo_http_get($url, $cfg['timeout_ms'] ?? 4000);
    if (!$r['ok']) {
        return array('ok' => true, 'degraded' => true, 'reason' => $r['reason']);
    }
    $data = $filter($r['body']);
    if ($data === null) {
        return array('ok' => true, 'degraded' => true, 'reason' => 'no_route');
    }
    $payload = $kind === 'search' ? array('items' => $data) : $data;
    geo_cache_put($cache, $key, $kind, $payload);
    return array('ok' => true, 'cached' => false, 'data' => $payload);
}
