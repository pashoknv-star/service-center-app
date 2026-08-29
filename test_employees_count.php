<?php
// Тест: сколько сотрудников видит supervisor_zone0
$cookieFile = tempnam(sys_get_temp_dir(), 'sc_test_');

// Логин как supervisor_zone0
$ch = curl_init('http://127.0.0.1:8090/api/login.php');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(['username' => 'supervisor_zone0', 'password' => 'changeme']));
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_COOKIEJAR, $cookieFile);
curl_exec($ch);
curl_close($ch);

// Загрузка данных
$ch = curl_init('http://127.0.0.1:8090/api/load.php');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_COOKIEFILE, $cookieFile);
$response = curl_exec($ch);
curl_close($ch);

$data = json_decode($response, true);
$empCount = isset($data['employees']) ? count($data['employees']) : 0;
$entryCount = isset($data['entries']) ? count($data['entries']) : 0;

echo "supervisor_zone0 видит:\n";
echo "  Сотрудников: $empCount\n";
echo "  Записей: $entryCount\n";

// Логин как admin для сравнения
$cookieFile2 = tempnam(sys_get_temp_dir(), 'sc_test2_');
$ch = curl_init('http://127.0.0.1:8090/api/login.php');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(['username' => 'admin', 'password' => 'changeme']));
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_COOKIEJAR, $cookieFile2);
curl_exec($ch);
curl_close($ch);

$ch = curl_init('http://127.0.0.1:8090/api/load.php');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_COOKIEFILE, $cookieFile2);
$response = curl_exec($ch);
curl_close($ch);

$data = json_decode($response, true);
$empCount2 = isset($data['employees']) ? count($data['employees']) : 0;

echo "\nadmin видит:\n";
echo "  Сотрудников: $empCount2\n";

unlink($cookieFile);
unlink($cookieFile2);
