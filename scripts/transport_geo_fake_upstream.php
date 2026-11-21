<?php
// V10-T7: ПОДДЕЛЬНЫЙ внешний сервис для сьюта transportgeo (api/transport_geo_test.php). Основа — scripts/spike/v10_t4_fake_upstream.php.
// Изображает ВСЕ провайдеры прокси сразу: Nominatim (/search, /reverse), OSRM (/route/v1/driving/…), Photon (/api/),
// OpenRouteService (/v2/directions/driving-car, нужен заголовок Authorization = FAKE_ORS_KEY), Valhalla (/route?json=…).
// Запуск: FAKE_LOG=/path/log.jsonl php -S 127.0.0.1:PORT scripts/transport_geo_fake_upstream.php  (в тесте — с PHP_CLI_SERVER_WORKERS).
// Каждый входящий запрос пишется в FAKE_LOG целиком: метод, путь, query, ВСЕ заголовки, тело. Ответы нарочно «грязные»:
// улицы, номера домов, индексы, hint, osm_id — чтобы проверить, что прокси не пересылает это клиенту.
// Режимы — префиксом пути (стрипается перед маршрутизацией; можно складывать, напр. /dur900/…):
//   /slow/…        — пауза 3 с;            /err500/… — HTTP 500;        /err429/… — HTTP 429;      /err403/… — HTTP 403;
//   /garbage/…     — 200, но не JSON;      /shape/…  — 200, JSON «не той формы» ({"unexpected":true});
//   /big/…         — 200, ответ > 256 КБ;
//   /redirect/…    — 302 на /search (редиректы прокси не должны выполняться);
//   /dur<сек>/…    — длительность маршрута (в т.ч. дробная: /dur899.5/);   /dist<м>/… — расстояние маршрута, м;
//   /noroute/…     — OSRM: 200 {"code":"NoRoute"};   /nosegment/… — OSRM: HTTP 400 {"code":"NoSegment"}.
// Сеть наружу не используется.

$log = getenv('FAKE_LOG') ?: (sys_get_temp_dir() . '/transport_geo_fake.jsonl');
$uri = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url($uri, PHP_URL_PATH) ?: '/';
$headers = function_exists('getallheaders') ? getallheaders() : array();
file_put_contents($log, json_encode(array(
    'method' => $_SERVER['REQUEST_METHOD'] ?? '', 'path' => $path, 'query_raw' => (string) parse_url($uri, PHP_URL_QUERY),
    'query' => $_GET, 'headers' => $headers, 'body' => file_get_contents('php://input'), 't' => microtime(true),
), JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);

$dur = 6620.4;
$dist = 124331.4;
$mode = array();
while (preg_match('#^/(slow|err500|err429|err403|garbage|shape|big|redirect|noroute|nosegment|dur[0-9.]+|dist[0-9.]+)(/.*)$#', $path, $m)) {
    $mode[] = $m[1];
    $path = $m[2];
    if (strpos($m[1], 'dur') === 0) { $dur = (float) substr($m[1], 3); }
    if (strpos($m[1], 'dist') === 0) { $dist = (float) substr($m[1], 4); }
}
foreach ($mode as $md) {
    if ($md === 'slow') { sleep(3); }
    if ($md === 'err500') { http_response_code(500); echo '{"error":"boom"}'; exit; }
    if ($md === 'err429') { http_response_code(429); echo '{"error":"too many"}'; exit; }
    if ($md === 'err403') { http_response_code(403); echo '{"error":"blocked"}'; exit; }
    if ($md === 'garbage') { echo '<html>not json</html>'; exit; }
    if ($md === 'shape') { header('Content-Type: application/json'); echo '{"unexpected":true}'; exit; }
    if ($md === 'big') { header('Content-Type: application/json'); echo '{"pad":"' . str_repeat('x', 300000) . '"}'; exit; }
    if ($md === 'redirect') { http_response_code(302); header('Location: /search?q=redirected'); exit; }
}
header('Content-Type: application/json; charset=utf-8');
$J = JSON_UNESCAPED_UNICODE;
$KHM = 'Ханты-Мансийский автономный округ — Югра';

if (preg_match('#/search$#', $path)) {
    $q = mb_strtolower((string) ($_GET['q'] ?? ''));
    if ($q === 'урай') {
        echo json_encode(array(
            array('place_id' => 11, 'osm_id' => 1111, 'lat' => '57.9500000', 'lon' => '49.0000000', 'type' => 'village', 'name' => 'Урай',
                'display_name' => 'Урай, Кировская область, Россия', 'importance' => 0.1,
                'address' => array('village' => 'Урай', 'county' => 'Кировский район', 'state' => 'Кировская область', 'ISO3166-2-lvl4' => 'RU-KIR',
                    'road' => 'улица Кировская', 'house_number' => '9', 'postcode' => '613000')),
            array('place_id' => 12, 'osm_id' => 307089440, 'lat' => '60.1291200', 'lon' => '64.8036270', 'type' => 'town', 'name' => 'Урай',
                'display_name' => 'Урай, ... , 628285, Россия', 'importance' => 0.5,
                'address' => array('town' => 'Урай', 'county' => 'городской округ Урай', 'state' => $KHM, 'ISO3166-2-lvl4' => 'RU-KHM',
                    'road' => 'улица Ленина', 'house_number' => '5', 'postcode' => '628285')),
            array('place_id' => 13, 'osm_id' => 1313, 'lat' => '60.1300000', 'lon' => '64.8000000', 'type' => 'administrative', 'name' => 'городской округ Урай',
                'display_name' => 'городской округ Урай, Россия', 'importance' => 0.3,
                'address' => array('county' => 'городской округ Урай', 'state' => $KHM, 'ISO3166-2-lvl4' => 'RU-KHM')),
        ), $J);
    } elseif ($q === 'советский') {
        echo json_encode(array(
            array('place_id' => 21, 'osm_id' => 2121, 'lat' => '61.3580200', 'lon' => '63.5621800', 'type' => 'town', 'name' => 'Советский',
                'display_name' => 'Советский, ХМАО', 'address' => array('town' => 'Советский', 'county' => 'Советский район', 'state' => $KHM, 'ISO3166-2-lvl4' => 'RU-KHM')),
            array('place_id' => 22, 'osm_id' => 2222, 'lat' => '61.3620900', 'lon' => '63.5735400', 'type' => 'administrative', 'name' => 'городское поселение Советский',
                'display_name' => 'городское поселение Советский', 'address' => array('municipality' => 'городское поселение Советский', 'county' => 'Советский район', 'state' => $KHM)),
        ), $J);
    } elseif ($q === 'сельцо') {   // населённый пункт, у которого name — с префиксом «сельское поселение»
        echo json_encode(array(
            array('place_id' => 31, 'osm_id' => 3131, 'lat' => '60.5000000', 'lon' => '66.5000000', 'type' => 'hamlet', 'name' => 'сельское поселение Сельцо',
                'display_name' => 'Сельцо', 'address' => array('hamlet' => 'Сельцо', 'county' => 'Кондинский район', 'state' => $KHM, 'ISO3166-2-lvl4' => 'RU-KHM')),
        ), $J);
    } elseif ($q === 'нигдевия') {
        echo '[]';
    } else {
        echo json_encode(array(array(
            'place_id' => 1, 'osm_id' => 307089440, 'lat' => '60.1291200', 'lon' => '64.8036270', 'type' => 'town', 'name' => 'Урай',
            'display_name' => 'Урай, ... , 628285, Россия', 'importance' => 0.5,
            'address' => array('town' => 'Урай', 'county' => 'городской округ Урай', 'state' => $KHM, 'ISO3166-2-lvl4' => 'RU-KHM',
                'road' => 'улица Ленина', 'house_number' => '5', 'postcode' => '628285'),
        )), $J);
    }
} elseif (preg_match('#/reverse$#', $path)) {
    $lat = (float) ($_GET['lat'] ?? 0);
    if ($lat < 10) {   // «в поле»: населённого пункта нет, только район
        echo json_encode(array('place_id' => 3, 'osm_id' => 4, 'display_name' => 'Кондинский район, Россия',
            'address' => array('county' => 'Кондинский район', 'state' => $KHM)), $J);
    } elseif ($lat > 61.0 && $lat < 61.2) {   // только «муниципальное образование»
        echo json_encode(array('place_id' => 5, 'osm_id' => 6, 'display_name' => 'городское поселение Советский',
            'address' => array('municipality' => 'городское поселение Советский', 'county' => 'Советский район', 'state' => $KHM, 'road' => 'улица Гастелло')), $J);
    } else {
        echo json_encode(array(
            'place_id' => 2, 'osm_id' => 3, 'display_name' => 'улица Ленина, 5, Урай',
            'address' => array('road' => 'улица Ленина', 'house_number' => '5', 'town' => 'Урай', 'county' => 'городской округ Урай', 'state' => $KHM, 'postcode' => '628285'),
        ), $J);
    }
} elseif (strpos($path, '/route/v1/driving/') !== false) {
    if (in_array('noroute', $mode, true)) { echo json_encode(array('code' => 'NoRoute', 'message' => 'No route found'), $J); exit; }
    if (in_array('nosegment', $mode, true)) { http_response_code(400); echo json_encode(array('code' => 'NoSegment', 'message' => 'Could not find a matching segment'), $J); exit; }
    echo json_encode(array('code' => 'Ok', 'routes' => array(array('distance' => $dist, 'duration' => $dur,
        'legs' => array(array('summary' => 'улица Ленина', 'steps' => array())))),
        'waypoints' => array(array('hint' => 'SECRETHINT', 'name' => 'улица Глинки', 'location' => array(64.8, 60.1)))), $J);
} elseif (preg_match('#/api/?$#', $path)) {   // Photon
    echo json_encode(array('type' => 'FeatureCollection', 'features' => array(
        array('type' => 'Feature', 'geometry' => array('type' => 'Point', 'coordinates' => array(64.8036270, 60.1291200)),
            'properties' => array('osm_id' => 307089440, 'osm_type' => 'N', 'osm_key' => 'place', 'osm_value' => 'town', 'name' => 'Урай',
                'county' => 'городской округ Урай', 'state' => $KHM, 'countrycode' => 'RU', 'street' => 'улица Ленина', 'housenumber' => '5', 'postcode' => '628285')),
        array('type' => 'Feature', 'geometry' => array('type' => 'Point', 'coordinates' => array(64.8, 60.1)),
            'properties' => array('osm_id' => 9, 'osm_key' => 'highway', 'osm_value' => 'residential', 'name' => 'улица Ленина', 'state' => $KHM)),
    )), $J);
} elseif (preg_match('#/v2/directions/driving-car$#', $path)) {   // OpenRouteService
    $auth = $headers['Authorization'] ?? ($headers['authorization'] ?? '');
    if ($auth !== (getenv('FAKE_ORS_KEY') ?: 'TESTKEY123')) { http_response_code(401); echo '{"error":"Authorization field missing"}'; exit; }
    echo json_encode(array('type' => 'FeatureCollection', 'features' => array(array('type' => 'Feature',
        'properties' => array('segments' => array(array('steps' => array(array('name' => 'улица Ленина')))), 'summary' => array('distance' => $dist, 'duration' => $dur),
            'way_points' => array(0, 3))))), $J);
} elseif (preg_match('#/route$#', $path)) {   // Valhalla
    echo json_encode(array('trip' => array('status' => 0, 'status_message' => 'Found route between points',
        'locations' => array(array('lat' => 60.129, 'lon' => 64.804, 'name' => 'улица Ленина')),
        'summary' => array('length' => round($dist / 1000, 3), 'time' => $dur), 'legs' => array(array('summary' => array('length' => 1, 'time' => 1))))), $J);
} else {
    http_response_code(404);
    echo '{"error":"not found"}';
}
