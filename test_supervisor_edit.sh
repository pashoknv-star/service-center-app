#!/bin/bash
set -e

BASE_URL="http://127.0.0.1:8090"
COOKIE_JAR="/tmp/cookies_edit_$$.txt"

# Логин как supervisor zone 0
echo "=== ТЕСТ: Supervisor редактирует обычную запись в своей зоне ==="
echo "Логин supervisor_zone0..."
curl -s -c "$COOKIE_JAR" -X POST "$BASE_URL/api/login.php" \
  -H "Content-Type: application/json" \
  -d '{"username":"supervisor_zone0","password":"test123"}' | jq -r '.user.displayName'

# Проверяем текущий статус записи
echo ""
echo "Текущий статус emp_zone0_1, 2026-08-23:"
php -r '
require "api/db.php";
$pdo = Database::getInstance()->getPDO();
$stmt = $pdo->prepare("SELECT status, approval_status FROM schedule_entries WHERE employee_id = ? AND date = ?");
$stmt->execute(["emp_zone0_1", "2026-08-23"]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);
if ($row) {
    echo "  {$row["status"]}:{$row["approval_status"]}";
} else {
    echo "  NOT_FOUND";
}
echo "\n";
'

# Меняем статус с vacation на trip
echo "Меняем vacation -> trip (обычная запись, не approved)..."
curl -s -b "$COOKIE_JAR" -X PUT "$BASE_URL/api/entries.php?employeeId=emp_zone0_1&date=2026-08-23" \
  -H "Content-Type: application/json" \
  -d '{"status":"trip","comment":"Изменено supervisor"}' | jq '.'

# Проверяем новый статус
echo ""
echo "Новый статус:"
STATUS=$(php -r '
require "api/db.php";
$pdo = Database::getInstance()->getPDO();
$stmt = $pdo->prepare("SELECT status, comment, approval_status FROM schedule_entries WHERE employee_id = ? AND date = ?");
$stmt->execute(["emp_zone0_1", "2026-08-23"]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);
if ($row) {
    echo "{$row["status"]}:{$row["approval_status"]}:{$row["comment"]}";
} else {
    echo "NOT_FOUND";
}
')
echo "  $STATUS"

if [ "$STATUS" = "trip:draft:Изменено supervisor" ]; then
    echo ""
    echo "✓ УСПЕХ: Supervisor успешно изменил обычную запись в своей зоне"
else
    echo ""
    echo "❌ ОШИБКА: Supervisor не смог изменить запись (статус: $STATUS)"
fi

rm -f "$COOKIE_JAR"
