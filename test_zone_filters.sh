#!/bin/bash
set -e

BASE_URL="http://127.0.0.1:8090"
COOKIE_JAR="/tmp/cookies_$$.txt"

# Логин как supervisor zone 0
echo "=== Логин supervisor_zone0 ==="
curl -s -c "$COOKIE_JAR" -X POST "$BASE_URL/api/login.php" \
  -H "Content-Type: application/json" \
  -d '{"username":"supervisor_zone0","password":"test123"}' | jq -r '.success, .user.displayName'

echo ""
echo "=== Supervisor zone 0 загружает данные ==="
RESPONSE=$(curl -s -b "$COOKIE_JAR" "$BASE_URL/api/load.php")
echo "$RESPONSE" | jq '.entries | keys | length' > /tmp/zone0_count.txt
ZONE0_COUNT=$(cat /tmp/zone0_count.txt)
echo "Получено записей: $ZONE0_COUNT"

# Проверяем зоны в записях
echo "$RESPONSE" | jq -r '.entries | to_entries[] | "\(.key): \(.value.employeeId)"' | while read LINE; do
  EMP_ID=$(echo "$LINE" | cut -d':' -f2- | tr -d ' ')
  # Получаем зону сотрудника через прямой SQL запрос
  ZONE=$(php -r 'require "api/db.php"; $pdo = Database::getInstance()->getPDO(); $stmt = $pdo->prepare("SELECT group_id FROM employees WHERE id = ?"); $stmt->execute(["'${EMP_ID}'"]); echo $stmt->fetchColumn() ?: "unknown";')
  if [ "$ZONE" != "g0" ]; then
    echo "  ОШИБКА: видит чужую зону! $EMP_ID в зоне $ZONE"
  else
    echo "  ✓ $EMP_ID (zone $ZONE)"
  fi
done

rm -f "$COOKIE_JAR"

# Создаём новую сессию для supervisor zone 1
COOKIE_JAR="/tmp/cookies2_$$.txt"
echo ""
echo "=== Логин supervisor_zone1 ==="
curl -s -c "$COOKIE_JAR" -X POST "$BASE_URL/api/login.php" \
  -H "Content-Type: application/json" \
  -d '{"username":"supervisor_zone1","password":"test123"}' | jq -r '.success, .user.displayName'

echo ""
echo "=== Supervisor zone 1 загружает данные ==="
RESPONSE=$(curl -s -b "$COOKIE_JAR" "$BASE_URL/api/load.php")
echo "$RESPONSE" | jq '.entries | keys | length' > /tmp/zone1_count.txt
ZONE1_COUNT=$(cat /tmp/zone1_count.txt)
echo "Получено записей: $ZONE1_COUNT"

echo "$RESPONSE" | jq -r '.entries | to_entries[] | "\(.key): \(.value.employeeId)"' | while read LINE; do
  EMP_ID=$(echo "$LINE" | cut -d':' -f2- | tr -d ' ')
  ZONE=$(php -r 'require "api/db.php"; $pdo = Database::getInstance()->getPDO(); $stmt = $pdo->prepare("SELECT group_id FROM employees WHERE id = ?"); $stmt->execute(["'${EMP_ID}'"]); echo $stmt->fetchColumn() ?: "unknown";')
  if [ "$ZONE" != "g1" ]; then
    echo "  ОШИБКА: видит чужую зону! $EMP_ID в зоне $ZONE"
  else
    echo "  ✓ $EMP_ID (zone $ZONE)"
  fi
done

rm -f "$COOKIE_JAR"

# Логин как admin
COOKIE_JAR="/tmp/cookies3_$$.txt"
echo ""
echo "=== Логин admin ==="
curl -s -c "$COOKIE_JAR" -X POST "$BASE_URL/api/login.php" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq -r '.success, .user.displayName'

echo ""
echo "=== Admin загружает данные ==="
RESPONSE=$(curl -s -b "$COOKIE_JAR" "$BASE_URL/api/load.php")
ADMIN_COUNT=$(echo "$RESPONSE" | jq '.entries | keys | length')
echo "Получено записей: $ADMIN_COUNT"

TOTAL_IN_DB=$(php -r 'require "api/db.php"; $pdo = Database::getInstance()->getPDO(); echo $pdo->query("SELECT COUNT(*) FROM schedule_entries")->fetchColumn();')
echo "Всего в БД: $TOTAL_IN_DB"

if [ "$ADMIN_COUNT" -eq "$TOTAL_IN_DB" ]; then
  echo "✓ Admin видит все записи"
else
  echo "ОШИБКА: Admin не видит все записи! ($ADMIN_COUNT vs $TOTAL_IN_DB)"
fi

rm -f "$COOKIE_JAR" /tmp/zone0_count.txt /tmp/zone1_count.txt

echo ""
echo "=== ИТОГ ==="
echo "Zone 0 видит: $ZONE0_COUNT записей"
echo "Zone 1 видит: $ZONE1_COUNT записей"
echo "Admin видит: $ADMIN_COUNT записей (всего в БД: $TOTAL_IN_DB)"
