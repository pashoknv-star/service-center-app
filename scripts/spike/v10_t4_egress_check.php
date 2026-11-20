<?php
// V10-T4 SPIKE: одноразовая проверка исходящего HTTP(S) с хостинга (Hostland) — для владельца. НЕ деплоить в пакет приложения.
// Проверяет то, чего не видно из документов: разрешает ли PHP-окружение ходить наружу через curl и allow_url_fopen,
// резолвится ли DNS и открыт ли 443 до публичных сервисов карты. Отправляет только публичные запросы без каких-либо данных приложения.
//
// Как использовать (на хостинге, SSH или файловый менеджер):
//   1) скопировать файл как ~/host1882970.hostland.pro/htdocs/www/_egress_check.php ;
//   2) в строке TOKEN ниже подставить случайную строку (пока там CHANGE_ME — скрипт ничего не делает);
//   3) открыть в браузере  http://host1882970.hostland.pro/_egress_check.php?k=<ТА_ЖЕ_СТРОКА>   (это именно ВЕБ-PHP 8.1);
//   4) сохранить вывод и СРАЗУ УДАЛИТЬ файл. Вывод не содержит секретов.
// Локально (проверка самого скрипта): php scripts/spike/v10_t4_egress_check.php <TOKEN> [--dry]
const TOKEN = 'CHANGE_ME';
const UA = 'ServiceCenterApp-egress-check/0.1 (one-off connectivity check; contact: OWNER_EMAIL_TO_BE_SET)';

$cli = PHP_SAPI === 'cli';
$k = $cli ? ($argv[1] ?? '') : ($_GET['k'] ?? '');
$dry = $cli ? in_array('--dry', $argv ?? array(), true) : isset($_GET['dry']);
if (!$cli) {
    header('Content-Type: text/plain; charset=utf-8');
}
if (TOKEN === 'CHANGE_ME' && !$cli) {
    http_response_code(403);
    exit("Подставьте TOKEN в файле.\n");
}
if (!$cli && !hash_equals(TOKEN, (string) $k)) {
    http_response_code(403);
    exit("forbidden\n");
}

$targets = array(
    'nominatim /status' => 'https://nominatim.openstreetmap.org/status',
    'osrm route (координаты Урай→Междуреченский)' => 'https://routing.openstreetmap.de/routed-car/route/v1/driving/64.804,60.129;65.909,59.592?overview=false&alternatives=false&steps=false',
);

echo 'time_utc=' . gmdate('c') . "\n";
echo 'sapi=' . PHP_SAPI . ' php=' . PHP_VERSION . "\n";
echo 'ext_curl=' . (function_exists('curl_init') ? 'yes' : 'NO') . ' ext_openssl=' . (extension_loaded('openssl') ? 'yes' : 'NO') . "\n";
if (function_exists('curl_version')) {
    $cv = curl_version();
    echo 'curl=' . $cv['version'] . ' ssl=' . ($cv['ssl_version'] ?? '?') . "\n";
}
echo 'allow_url_fopen=' . var_export((bool) ini_get('allow_url_fopen'), true) . ' disable_functions=' . (ini_get('disable_functions') ?: '(пусто)') . "\n";
echo 'default_socket_timeout=' . ini_get('default_socket_timeout') . ' max_execution_time=' . ini_get('max_execution_time') . "\n";
if ($dry) {
    exit("dry-run: сеть не используется\n");
}
foreach ($targets as $label => $url) {
    $host = parse_url($url, PHP_URL_HOST);
    echo "\n== $label\n";
    $ip = gethostbyname($host);
    echo "dns($host)=" . ($ip === $host ? 'НЕ РЕЗОЛВИТСЯ' : $ip) . "\n";
    usleep(1200000);   // не чаще 1 запроса в секунду к внешним сервисам
    if (function_exists('curl_init')) {
        $t0 = microtime(true);
        $ch = curl_init($url);
        curl_setopt_array($ch, array(CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 8, CURLOPT_CONNECTTIMEOUT => 4,
            CURLOPT_USERAGENT => UA, CURLOPT_FOLLOWLOCATION => false));
        $raw = curl_exec($ch);
        echo 'curl: ' . ($raw === false ? 'ОШИБКА ' . curl_errno($ch) . ' ' . curl_error($ch) : 'HTTP ' . curl_getinfo($ch, CURLINFO_RESPONSE_CODE) . ', ' . strlen((string) $raw) . ' байт')
            . ', ' . round((microtime(true) - $t0) * 1000) . " мс\n";
        curl_close($ch);
    }
    usleep(1200000);
    if (ini_get('allow_url_fopen')) {
        $t0 = microtime(true);
        $ctx = stream_context_create(array('http' => array('timeout' => 8, 'ignore_errors' => true, 'user_agent' => UA, 'follow_location' => 0)));
        $raw = @file_get_contents($url, false, $ctx);
        $code = 0;
        foreach ($http_response_header ?? array() as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) { $code = (int) $m[1]; }
        }
        echo 'fopen: ' . ($raw === false ? 'ОШИБКА' : 'HTTP ' . $code . ', ' . strlen($raw) . ' байт') . ', ' . round((microtime(true) - $t0) * 1000) . " мс\n";
    }
}
echo "\nГотово. Удалите файл _egress_check.php.\n";
