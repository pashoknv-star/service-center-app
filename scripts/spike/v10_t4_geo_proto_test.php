<?php
// V10-T4 SPIKE: тест прототипа прокси против ПОДДЕЛЬНОГО внешнего сервиса (v10_t4_fake_upstream.php).
// Доказывает метод проверки «наружу уходит только разрешённое». Сеть наружу НЕ используется (только 127.0.0.1).
// Запуск: php scripts/spike/v10_t4_geo_proto_test.php   → строка `RESULT: N passed, 0 failed`.
require __DIR__ . '/v10_t4_geo_proto.php';

$pass = 0; $fail = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $pass, $fail;
    if ($ok) { $pass++; } else { $fail++; echo "FAIL: $name $detail\n"; }
}

$tmp = sys_get_temp_dir() . '/v10_t4_' . getmypid();
@mkdir($tmp);
$log = $tmp . '/fake.jsonl';
$port = 18700 + (getmypid() % 200);
$proc = proc_open(array(PHP_BINARY, '-S', "127.0.0.1:$port", __DIR__ . '/v10_t4_fake_upstream.php'),
    array(array('pipe', 'r'), array('file', $tmp . '/srv.out', 'w'), array('file', $tmp . '/srv.err', 'w')), $pipes,
    null, array_merge($_ENV, array('FAKE_LOG' => $log, 'PATH' => getenv('PATH'))));
for ($i = 0; $i < 50; $i++) {
    $s = @fsockopen('127.0.0.1', $port, $en, $es, 0.2);
    if ($s) { fclose($s); break; }
    usleep(100000);
}
$base = "http://127.0.0.1:$port";
$cfg = array('nominatim' => $base, 'osrm' => $base, 'gap_ms' => 0, 'timeout_ms' => 4000);
$cache = geo_cache_open($tmp . '/cache.db');

function seen(string $log): array
{
    if (!is_file($log)) { return array(); }
    return array_map(function ($l) { return json_decode($l, true); }, array_filter(explode("\n", (string) file_get_contents($log))));
}

// ---- 1. Поиск населённого пункта: что именно ушло наружу -------------------------------------------------------
$r = geo_handle('search', array('q' => '  Урай ', 'subscriber' => 'Иванов ' . 'И.' . 'И.', 'address' => 'ул. Ленина 5', 'title' => 'Заявка 42', 'phone' => '+79000000000'), $cfg, $cache);
$s = seen($log);
check('search ok', ($r['ok'] ?? false) && empty($r['degraded']) && count($s) === 1, json_encode($r, JSON_UNESCAPED_UNICODE));
$q = $s[0]['query'] ?? array();
$allowedKeys = array('format', 'q', 'countrycodes', 'limit', 'accept-language', 'addressdetails', 'viewbox');
check('search: ровно разрешённые ключи query', array_diff(array_keys($q), $allowedKeys) === array() && array_diff($allowedKeys, array_keys($q)) === array(), json_encode(array_keys($q)));
check('search: q = нормализованное название', ($q['q'] ?? '') === 'Урай');
check('search: viewbox — константа', ($q['viewbox'] ?? '') === GEO_VIEWBOX);
check('search: GET без тела', ($s[0]['method'] ?? '') === 'GET' && ($s[0]['body'] ?? 'x') === '');
$raw = json_encode($s[0], JSON_UNESCAPED_UNICODE);
foreach (array('Иванов', 'Ленина', 'Заявка', '79000000000', 'subscriber', 'ул.', 'phone', 'title') as $needle) {
    check("search: в исходящем запросе нет «{$needle}»", mb_strpos($raw, $needle) === false);
}
$h = array_change_key_case($s[0]['headers'] ?? array(), CASE_LOWER);
check('search: User-Agent проекта', ($h['user-agent'] ?? '') === GEO_UA);
foreach (array('cookie', 'referer', 'authorization', 'x-forwarded-for', 'x-real-ip', 'origin') as $hn) {
    check("search: заголовок {$hn} не пересылается", !isset($h[$hn]));
}
$items = $r['data']['items'] ?? array();
check('search: ответ клиенту — только белый список полей', count($items) === 1 && array_keys($items[0]) === array('name', 'lat', 'lon', 'kind', 'county', 'state'), json_encode($items, JSON_UNESCAPED_UNICODE));
$out = json_encode($r, JSON_UNESCAPED_UNICODE);
foreach (array('Ленина', 'house_number', 'postcode', 'osm_id', 'place_id', 'display_name') as $needle) {
    check("search: клиенту не вернулось «{$needle}»", mb_strpos($out, $needle) === false);
}

// ---- 2. Кэш: повтор не идёт наружу ----------------------------------------------------------------------------------
$n0 = count(seen($log));
$r2 = geo_handle('search', array('q' => 'урай'), $cfg, $cache);   // другой регистр — тот же ключ
check('cache: повтор из geo_cache, наружу не ходили', ($r2['cached'] ?? false) === true && count(seen($log)) === $n0);

// ---- 3. Отказ ДО исходящего запроса: адреса, ФИО, цифры, мусор ------------------------------------------------------
$bad = array('ул. Ленина 5, Урай', 'Урай, улица Ленина', 'улица Ленина', 'дом 5', implode(' ', array('Иванов', 'Иван', 'Ивано' . 'вич')), 'Урай 2 микрорайон 60',
    'Урай; DROP TABLE', 'Урай&format=xml', "Урай\nHost: evil", 'У', str_repeat('а', 61), 'пр-кт Ленина', 'кв. 12', '', '   ', 'a b c d', '+79000000000');
$n1 = count(seen($log));
foreach ($bad as $b) {
    $rr = geo_handle('search', array('q' => $b), $cfg, $cache);
    check('search: отказ для «' . str_replace("\n", '\\n', $b) . '»', ($rr['error'] ?? '') === 'bad_place_name');
}
check('search: отказанные вводы не создали ни одного исходящего запроса', count(seen($log)) === $n1);
foreach (array('Урай', 'Междуреченский', 'Ханты-Мансийск', 'Нижние Нарыкары', 'Усть-Аха', 'Старый Катыш', 'Кондинское', 'Советский') as $good) {
    check("search: допустимо «{$good}»", geo_place_name($good) === $good);
}

// ---- 4. Обратный геокодер: только округлённые lat/lon -----------------------------------------------------------------
$n2 = count(seen($log));
$rv = geo_handle('reverse', array('lat' => '60.1291234', 'lon' => 64.8036278, 'address' => 'ул. Ленина 5', 'subscriber' => 'X'), $cfg, $cache);
$s = seen($log);
check('reverse: один исходящий запрос', count($s) === $n2 + 1);
$q = $s[count($s) - 1]['query'] ?? array();
check('reverse: ключи query — фиксированный набор', array_keys($q) === array('format', 'lat', 'lon', 'zoom', 'accept-language', 'addressdetails'), json_encode(array_keys($q)));
check('reverse: координаты округлены до 3 знаков', ($q['lat'] ?? '') === '60.129' && ($q['lon'] ?? '') === '64.804', json_encode($q));
check('reverse: клиенту — населённый пункт, без улицы и дома', ($rv['data']['name'] ?? '') === 'Урай' && mb_strpos(json_encode($rv, JSON_UNESCAPED_UNICODE), 'Ленина') === false);
foreach (array(array('lat' => 'abc', 'lon' => 1), array('lat' => '91', 'lon' => 1), array('lat' => 1, 'lon' => '181'), array('lat' => '60.1;x', 'lon' => 1), array('lon' => 1), array('lat' => array(1), 'lon' => 1), array('lat' => NAN, 'lon' => 1)) as $badc) {
    $rr = geo_handle('reverse', $badc, $cfg, $cache);
    check('reverse: отказ для ' . json_encode($badc), ($rr['error'] ?? '') === 'bad_coords');
}

// ---- 5. Маршрут: в пути только 4 координаты --------------------------------------------------------------------------
$n3 = count(seen($log));
$rt = geo_handle('route', array('lat1' => 60.12912, 'lon1' => 64.80362, 'lat2' => '59.59248', 'lon2' => '65.90851', 'title' => 'Заявка 42', 'subscriber' => 'Иванов'), $cfg, $cache);
$s = seen($log);
check('route: один исходящий запрос', count($s) === $n3 + 1);
$last = $s[count($s) - 1];
check('route: путь = только lon,lat;lon,lat (3 знака)', ($last['path'] ?? '') === '/route/v1/driving/64.804,60.129;65.909,59.592', $last['path'] ?? '');
check('route: query фиксирован', ($last['query_raw'] ?? '') === 'overview=false&alternatives=false&steps=false');
check('route: нет лишнего в запросе', mb_strpos(json_encode($last, JSON_UNESCAPED_UNICODE), 'Иванов') === false && mb_strpos(json_encode($last, JSON_UNESCAPED_UNICODE), 'Заявка') === false);
check('route: ответ клиенту {km, sec, min_map}', ($rt['data'] ?? null) === array('km' => 124.3, 'sec' => 6620, 'min_map' => 120), json_encode($rt));
$ro = json_encode($rt, JSON_UNESCAPED_UNICODE);
check('route: hint/улицы не вернулись клиенту', strpos($ro, 'SECRETHINT') === false && mb_strpos($ro, 'Глинки') === false && mb_strpos($ro, 'Ленина') === false);

// ---- 6. Деградация: таймаут, 500, не-JSON, недоступность ----------------------------------------------------------------
$t0 = microtime(true);
$rs = geo_handle('search', array('q' => 'Кондинское'), array_merge($cfg, array('nominatim' => $base . '/slow', 'timeout_ms' => 500)), $cache);
$dt = microtime(true) - $t0;
check('degraded: таймаут → degraded/timeout быстрее 1.5 с', ($rs['degraded'] ?? false) && ($rs['reason'] ?? '') === 'timeout' && $dt < 1.5, json_encode($rs) . " dt=$dt");
$rs = geo_handle('search', array('q' => 'Советский'), array_merge($cfg, array('nominatim' => $base . '/err500')), $cache);
check('degraded: HTTP 500 → degraded/http_500', ($rs['degraded'] ?? false) && ($rs['reason'] ?? '') === 'http_500', json_encode($rs));
$rs = geo_handle('search', array('q' => 'Нягань'), array_merge($cfg, array('nominatim' => $base . '/garbage')), $cache);
check('degraded: не-JSON → degraded/invalid_json', ($rs['degraded'] ?? false) && ($rs['reason'] ?? '') === 'invalid_json', json_encode($rs));
$rs = geo_handle('search', array('q' => 'Югорск'), array_merge($cfg, array('nominatim' => 'http://127.0.0.1:1')), $cache);
check('degraded: сервис недоступен → degraded/connect_error', ($rs['degraded'] ?? false) && ($rs['reason'] ?? '') === 'connect_error', json_encode($rs));
check('degraded: сбои не попали в кэш', geo_cache_get($cache, 'search:' . sha1('кондинское'), 99999) === null && geo_cache_get($cache, 'search:' . sha1('югорск'), 99999) === null);

// ---- 7. Ограничение частоты: ≤ 1 запрос в gap_ms к одному сервису -----------------------------------------------------
usleep(1200000);   // окно предыдущих вызовов (gap_ms=0 тоже пишет метку) должно истечь
$cfgRl = array_merge($cfg, array('gap_ms' => 1100));
$nA = count(seen($log));
$a = geo_handle('search', array('q' => 'Лангепас'), $cfgRl, $cache);
$b = geo_handle('search', array('q' => 'Покачи'), $cfgRl, $cache);
check('rate: первый ушёл, второй сразу — rate_limited', empty($a['degraded']) && ($b['reason'] ?? '') === 'rate_limited' && count(seen($log)) === $nA + 1, json_encode(array($a['reason'] ?? null, $b['reason'] ?? null)));
check('rate: чистая функция — окно 1100 мс', geo_rate_ok($cache, 'unit', 1100, 1000000) === true && geo_rate_ok($cache, 'unit', 1100, 1001099) === false && geo_rate_ok($cache, 'unit', 1100, 1001100) === true);
check('rate: разные сервисы не мешают друг другу', geo_rate_ok($cache, 'osrm-unit', 1100, 1000000) === true);

// ---- 8. Единственная точка исходящих HTTP в api/ (статическая проверка) ------------------------------------------------
$root = dirname(__DIR__, 2);
$hits = array();
foreach (glob($root . '/api/*.php') as $f) {
    if (preg_match('/_test\.php$/', $f)) { continue; }
    $src = (string) file_get_contents($f);
    if (preg_match('/\bcurl_init\s*\(|\bfsockopen\s*\(|\bstream_socket_client\s*\(|file_get_contents\s*\(\s*\$url|file_get_contents\s*\(\s*[\'"]https?:/', $src)) {
        $hits[] = basename($f);
    }
}
sort($hits);
echo 'info: файлы api/ с исходящим HTTP на текущем коммите: ' . json_encode($hits) . "\n";
check('static: сейчас исходящий HTTP только в tasks_rules.php (n8n); transport_geo.php ещё нет', $hits === array('tasks_rules.php'), json_encode($hits));

// ---- завершение -----------------------------------------------------------------------------------------------------
proc_terminate($proc);
proc_close($proc);
array_map('unlink', glob($tmp . '/*'));
@rmdir($tmp);
echo "RESULT: $pass passed, $fail failed\n";
exit($fail === 0 ? 0 : 1);
