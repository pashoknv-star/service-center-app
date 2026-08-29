<?php
// Debug T43: admin sees all zones
$host = '127.0.0.1';
$port = 19000;
$base = "http://{$host}:{$port}";
$cookieAdmin = tempnam(sys_get_temp_dir(), 'sc_admin_t43_');

// Login as admin
$r = do_curl([
    'method' => 'POST',
    'url' => $base . '/api/login.php',
    'body' => json_encode(['username' => 'admin', 'password' => 'changeme']),
    'cookie' => $cookieAdmin,
]);
echo "Login: " . substr($r, 0, 200) . "\n\n";

// Create test entries
$r = do_curl([
    'method' => 'POST',
    'url' => $base . '/api/save.php',
    'cookie' => $cookieAdmin,
    'body' => json_encode([
        'year' => 2099,
        'entries' => [
            ['employeeId' => 'emp_16', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't43-g0'],
            ['employeeId' => 'emp_1', 'date' => '2099-12-25', 'status' => 'trip', 'comment' => 't43-g1'],
        ],
    ]),
]);
echo "Save: " . substr($r, 0, 200) . "\n\n";

// Get entries
$r = do_curl([
    'method' => 'GET',
    'url' => $base . '/api/entries.php?year=2099',
    'cookie' => $cookieAdmin,
]);
$data = json_decode($r, true);
echo "Entries count: " . count($data) . "\n";
$foundG0 = $foundG1 = false;
foreach ($data as $row) {
    $eid = $row['employeeId'] ?? '';
    $date = $row['date'] ?? '';
    if ($date === '2099-12-25') {
        echo "  $eid - $date - " . ($row['comment'] ?? '') . "\n";
        if (in_array($eid, ['emp_16', 'emp_17', 'emp_18'])) $foundG0 = true;
        if (in_array($eid, ['emp_1', 'emp_2'])) $foundG1 = true;
    }
}
echo "foundG0: " . ($foundG0 ? 'YES' : 'NO') . "\n";
echo "foundG1: " . ($foundG1 ? 'YES' : 'NO') . "\n";

@unlink($cookieAdmin);

function do_curl($opts) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $opts['url']);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    if (isset($opts['method'])) curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $opts['method']);
    if (isset($opts['body'])) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $opts['body']);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    }
    if (isset($opts['cookie'])) {
        curl_setopt($ch, CURLOPT_COOKIEFILE, $opts['cookie']);
        curl_setopt($ch, CURLOPT_COOKIEJAR, $opts['cookie']);
    }
    $r = curl_exec($ch);
    curl_close($ch);
    return $r;
}
