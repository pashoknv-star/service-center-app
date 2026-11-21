<?php
// V10-T4 SPIKE: ПОДДЕЛЬНЫЙ внешний сервис (Nominatim + OSRM в одном) для проверки «что уходит наружу».
// Запуск: FAKE_LOG=/path/log.jsonl php -S 127.0.0.1:PORT scripts/spike/v10_t4_fake_upstream.php
// Каждый запрос пишется в FAKE_LOG целиком: метод, путь, query, ВСЕ заголовки, тело. Ответы нарочно содержат лишнее
// (улицы, hint, osm_id, адресные детали), чтобы проверить, что прокси не пересылает это клиенту.
// Режимы: путь /slow/… — пауза 3 с; /err500/… — HTTP 500; /garbage/… — не JSON; иначе — нормальный ответ.

$log = getenv('FAKE_LOG') ?: (sys_get_temp_dir() . '/v10_t4_fake.jsonl');
$uri = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url($uri, PHP_URL_PATH) ?: '/';
$headers = function_exists('getallheaders') ? getallheaders() : array();
file_put_contents($log, json_encode(array(
    'method' => $_SERVER['REQUEST_METHOD'] ?? '', 'path' => $path, 'query_raw' => (string) parse_url($uri, PHP_URL_QUERY),
    'query' => $_GET, 'headers' => $headers, 'body' => file_get_contents('php://input'),
), JSON_UNESCAPED_UNICODE) . "\n", FILE_APPEND | LOCK_EX);

if (strpos($path, '/slow/') === 0) {
    sleep(3);
    $path = substr($path, 5);
} elseif (strpos($path, '/err500/') === 0) {
    http_response_code(500);
    echo '{"error":"boom"}';
    exit;
} elseif (strpos($path, '/garbage/') === 0) {
    echo '<html>not json</html>';
    exit;
}
header('Content-Type: application/json; charset=utf-8');
if (preg_match('#/search$#', $path)) {
    echo json_encode(array(array(
        'place_id' => 1, 'osm_id' => 307089440, 'lat' => '60.1291200', 'lon' => '64.8036270', 'type' => 'town', 'name' => 'Урай',
        'display_name' => 'Урай, ... , 628285, Россия', 'importance' => 0.5,
        'address' => array('town' => 'Урай', 'county' => 'городской округ Урай', 'state' => 'Ханты-Мансийский автономный округ — Югра',
                           'road' => 'улица Ленина', 'house_number' => '5', 'postcode' => '628285'),
    )), JSON_UNESCAPED_UNICODE);
} elseif (preg_match('#/reverse$#', $path)) {
    echo json_encode(array(
        'place_id' => 2, 'osm_id' => 3, 'display_name' => 'улица Ленина, 5, Урай',
        'address' => array('road' => 'улица Ленина', 'house_number' => '5', 'town' => 'Урай', 'county' => 'городской округ Урай',
                           'state' => 'Ханты-Мансийский автономный округ — Югра'),
    ), JSON_UNESCAPED_UNICODE);
} elseif (strpos($path, '/route/v1/driving/') !== false) {
    echo json_encode(array('code' => 'Ok', 'routes' => array(array('distance' => 124331.4, 'duration' => 6620.4,
        'legs' => array(array('summary' => 'улица Ленина', 'steps' => array()))), ),
        'waypoints' => array(array('hint' => 'SECRETHINT', 'name' => 'улица Глинки', 'location' => array(64.8, 60.1)))), JSON_UNESCAPED_UNICODE);
} else {
    http_response_code(404);
    echo '{"error":"not found"}';
}
