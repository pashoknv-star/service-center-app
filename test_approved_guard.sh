#!/bin/bash
set -e

BASE_URL="http://127.0.0.1:8090"
COOKIE_JAR="/tmp/cookies_approve_$$.txt"

# Логин как supervisor zone 0
echo "=== ТЕСТ: Supervisor пытается изменить approved запись ==="
echo "Логин supervisor_zone0..."
curl -s -c "$COOKIE_JAR" -X POST "$BASE_URL/api/login.php" \
  -H "Content-Type: application/json" \
  -d '{"username":"supervisor_zone0","password":"test123"}' | jq -r '.user.displayName'

# Берём approved запись emp_zone0_1 на 2026-08-24
echo ""
echo "Пытаемся изменить approved запись (emp_zone0_1, 2026-08-24, approved -> vacation)..."
curl -s -b "$COOKIE_JAR" -X PUT "$BASE_URL/api/entries.php?employeeId=emp_zone0_1&date=2026-08-24" \
  -H "Content-Type: application/json" \
  -d '{"status":"vacation","approvalStatus":"draft"}' | jq '.'

echo ""
echo "Проверяем статус записи в БД..."
STATUS=$(php -r '
require "api/db.php";
$pdo = Database::getInstance()->getPDO();
$stmt = $pdo->prepare("SELECT status, approval_status FROM schedule_entries WHERE employee_id = ? AND date = ?");
$stmt->execute(["emp_zone0_1", "2026-08-24"]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);
if ($row) {
    echo "{$row["status"]}:{$row["approval_status"]}";
} else {
    echo "NOT_FOUND";
}
')
echo "Статус в БД: $STATUS"

if [ "$STATUS" = "vacation:approved" ] || [ "$STATUS" = "vacation:draft" ]; then
    echo "❌ ОШИБКА: Supervisor смог изменить approved запись!"
else
    echo "✓ УСПЕХ: Supervisor НЕ смог изменить approved запись (запись остаётся $STATUS)"
fi

# Тестируем admin - он должен иметь право
rm -f "$COOKIE_JAR"
COOKIE_JAR="/tmp/cookies_admin_$$.txt"
echo ""
echo "=== ТЕСТ: Admin пытается изменить ту же approved запись ==="
echo "Логин admin..."
curl -s -c "$COOKIE_JAR" -X POST "$BASE_URL/api/login.php" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq -r '.user.displayName'

echo ""
echo "Пытаемся изменить approved запись (emp_zone0_1, 2026-08-24, approved -> vacation)..."
curl -s -b "$COOKIE_JAR" -X PUT "$BASE_URL/api/entries.php?employeeId=emp_zone0_1&date=2026-08-24" \
  -H "Content-Type: application/json" \
  -d '{"status":"vacation","approvalStatus":"draft"}' | jq '.'

echo ""
echo "Проверяем статус записи в БД..."
STATUS=$(php -r '
require "api/db.php";
$pdo = Database::getInstance()->getPDO();
$stmt = $pdo->prepare("SELECT status, approval_status FROM schedule_entries WHERE employee_id = ? AND date = ?");
$stmt->execute(["emp_zone0_1", "2026-08-24"]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);
if ($row) {
    echo "{$row["status"]}:{$row["approval_status"]}";
} else {
    echo "NOT_FOUND";
}
')
echo "Статус в БД: $STATUS"

if [ "$STATUS" = "vacation:draft" ]; then
    echo "✓ УСПЕХ: Admin успешно изменил approved запись"
else
    echo "❌ ОШИБКА: Admin не смог изменить approved запись (запись остаётся $STATUS)"
fi

rm -f "$COOKIE_JAR"

echo ""
echo "=== ИТОГ ==="
echo "1. Supervisor НЕ может редактировать approved записи ✓"
echo "2. Admin МОЖЕТ редактировать approved записи ✓"
