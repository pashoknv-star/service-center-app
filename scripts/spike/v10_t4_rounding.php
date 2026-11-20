<?php
// V10-T4 SPIKE: та же формула на PHP (серверная сторона api/transport_geo.php — проект, не код приложения).
// Совместимо с PHP 8.1 (прод) и 5.3-синтаксисом не требуется (web-PHP 8.1, DEPLOY_HOSTLAND.md).
function leg_min_map($durationSec)
{
    if (!is_numeric($durationSec) || !is_finite((float) $durationSec) || $durationSec < 0) {
        return null; // нет оценки
    }
    $sec = (int) round((float) $durationSec);
    if ($sec === 0) {
        return 0;
    }
    return (int) ceil($sec / 900) * 15;
}

$cases = array(0, 60, 840, 900, 960, 1740, 1800, 1860, 2640, 2700, 2760, 3600, 3660, 5400, 5460);
$expect = array(0, 15, 15, 15, 30, 30, 30, 45, 45, 45, 60, 60, 75, 90, 105);
$bad = 0;
foreach ($cases as $i => $s) {
    $got = leg_min_map($s);
    if ($got !== $expect[$i]) {
        $bad++;
        echo "FAIL $s => $got (ожидалось {$expect[$i]})\n";
    }
}
foreach (array(0.4, 0.5, 899.4, 899.5, 900.4, 900.5, 901, 6620.4, 14464.6) as $s) {
    echo "$s с => " . leg_min_map($s) . "\n";
}
foreach (array(-1, NAN, 'abc') as $s) {
    if (leg_min_map($s) !== null) {
        $bad++;
        echo "FAIL: нет оценки\n";
    }
}
echo $bad === 0 ? "ROUNDING-PHP: OK\n" : "ROUNDING-PHP: FAIL $bad\n";
exit($bad === 0 ? 0 : 1);
