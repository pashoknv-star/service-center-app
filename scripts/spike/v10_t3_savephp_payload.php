<?php

declare(strict_types=1);

/**
 * V10-T3: синтетический payload для api/save.php — ТОЛЬКО чтобы измерить, как долго реальный save.php
 * держит блокировку записи (это «длинный писатель», с которым придётся делить файл БД модулю Транспорт).
 * Реальных данных нет: сотрудники «syn_N», записи графика — тип vacation.
 *
 * Использование: php v10_t3_savephp_payload.php <load.json> <сотрудников> <дней_на_сотрудника> > payload.json
 */

$base = json_decode((string) file_get_contents($argv[1]), true);
$n = (int) ($argv[2] ?? 10);
$days = (int) ($argv[3] ?? 30);
$emps = [];
$entries = [];
$gid = $base['groups'][0]['id'];
for ($i = 0; $i < $n; $i++) {
    $id = 'syn_' . $i;
    $e = $base['employees'][0];
    $e['id'] = $id;
    $e['fullName'] = 'Synthetic ' . $i;
    $e['groupId'] = $gid;
    $emps[] = $e;
    for ($d = 0; $d < $days; $d++) {
        $date = gmdate('Y-m-d', 1767225600 + $d * 86400);   // с 2026-01-01
        $entries[$id . ':' . $date] = ['employeeId' => $id, 'date' => $date, 'status' => 'vacation', 'comment' => '',
                                       'approvalStatus' => 'draft', 'version' => 1];
    }
}
$base['employees'] = $emps;
$base['entries'] = $entries;
echo json_encode($base, JSON_UNESCAPED_UNICODE);
