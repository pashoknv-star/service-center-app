#!/usr/bin/env bash
# V10-T3 (ADR_DB §1.5): сколько мест в коде завязано на SQLite-специфику. Одноразовый, в gate не входит.
# Из корня репозитория:  bash scripts/spike/v10_t3_sqlite_coupling.sh
# Считает СТРОКИ и ФАЙЛЫ по категориям; делит на «прод-код» (api/*.php без *_test.php и smoke/init/seed/debug) и «тесты/скрипты».
# Это регулярки (ripgrep), а не разбор SQL: верхняя оценка/ориентир, перед миграцией каждое место читать глазами.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
command -v rg >/dev/null || { echo "нужен ripgrep (rg)"; exit 2; }

PROD_GLOB=(-g 'api/*.php' -g 'api/schema.sql' -g '!api/*_test.php' -g '!api/smoke_test.php' -g '!api/init_db.php' -g '!api/seed_positions.php' -g '!api/debug_token.php')
TEST_GLOB=(-g 'api/*_test.php' -g 'api/smoke_test.php' -g 'api/init_db.php' -g 'api/seed_positions.php' -g 'api/debug_token.php' -g 'scripts/**' -g '!scripts/spike/**')

declare -A CAT
CAT[pragma]='PRAGMA'
CAT[sqlite_master]='sqlite_master|sqlite_schema|sqlite_version\(|dbstat'
CAT[or_ignore_replace]='INSERT OR (IGNORE|REPLACE)|REPLACE INTO|UPDATE OR '
CAT[upsert]='ON CONFLICT'
CAT[autoincrement_rowid]='AUTOINCREMENT|\browid\b|WITHOUT ROWID'
CAT[lastInsertId]='lastInsertId'
CAT[sqlite_dsn]="sqlite:"
CAT[datetime_fn]="datetime\(|strftime\(|julianday\(|date\('now|'now'"
CAT[ifnull_glob_collate]='IFNULL\(|GLOB |COLLATE NOCASE|COLLATE BINARY'
CAT[like_ci]=' LIKE '
CAT[group_concat]='GROUP_CONCAT|group_concat'
CAT[current_timestamp]='CURRENT_TIMESTAMP|CURRENT_DATE'
CAT[triggers]='CREATE TRIGGER|RAISE\('
CAT[begin_immediate]='BEGIN IMMEDIATE|BEGIN EXCLUSIVE'
CAT[transactions_pdo]='beginTransaction\(|->commit\(|->rollBack\('
CAT[sqlite_cli_backup]='sqlite3 .*\.(backup|restore)|\.backup|\.restore'
CAT[table_info_migrations]='PRAGMA table_info|PRAGMA user_version|schema_version'

printf '%-22s | %-18s | %-22s\n' "категория" "прод-код ф/стр" "тесты+скрипты ф/стр"
printf -- '---------------------------------------------------------------\n'
tp=0; tt=0
for k in pragma sqlite_master or_ignore_replace upsert autoincrement_rowid lastInsertId sqlite_dsn datetime_fn ifnull_glob_collate like_ci group_concat current_timestamp triggers begin_immediate transactions_pdo sqlite_cli_backup table_info_migrations; do
  re=${CAT[$k]}
  pl=$(rg -n -e "$re" "${PROD_GLOB[@]}" . 2>/dev/null | wc -l); pf=$(rg -l -e "$re" "${PROD_GLOB[@]}" . 2>/dev/null | wc -l)
  tl=$(rg -n -e "$re" "${TEST_GLOB[@]}" . 2>/dev/null | wc -l); tf=$(rg -l -e "$re" "${TEST_GLOB[@]}" . 2>/dev/null | wc -l)
  printf '%-22s | %6s / %-9s | %6s / %-9s\n' "$k" "$pf" "$pl" "$tf" "$tl"
done
echo
echo "--- Масштаб (для знаменателя) ---"
echo "прод-файлов api/*.php: $(ls api/*.php | grep -vE '_test\.php$|smoke_test|init_db|seed_positions|debug_token' | wc -l), строк: $(ls api/*.php | grep -vE '_test\.php$|smoke_test|init_db|seed_positions|debug_token' | xargs cat | wc -l)"
echo "api/db.php строк: $(wc -l < api/db.php); api/schema.sql строк: $(wc -l < api/schema.sql)"
echo "прод: вызовов ->prepare( : $(rg -c -e '->prepare\(' "${PROD_GLOB[@]}" . 2>/dev/null | awk -F: '{s+=$2} END{print s+0}'), ->query( : $(rg -c -e '->query\(' "${PROD_GLOB[@]}" . 2>/dev/null | awk -F: '{s+=$2} END{print s+0}'), ->exec( : $(rg -c -e '->exec\(' "${PROD_GLOB[@]}" . 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')"
echo "файлов прод-кода, где есть PDO вообще (->prepare|->query|->exec): $(rg -l -e '->(prepare|query|exec)\(' "${PROD_GLOB[@]}" . 2>/dev/null | wc -l)"
echo "тестовых PHP/JS/sh, открывающих БД напрямую (new PDO|sqlite3 |SC_APP_DB): $(rg -l -e 'new PDO|sqlite3 |SC_APP_DB' "${TEST_GLOB[@]}" . 2>/dev/null | wc -l)"
echo
echo "--- Файлы прод-кода с PRAGMA / sqlite_master / OR IGNORE|REPLACE / ON CONFLICT / SQLite-функциями даты ---"
rg -c -e 'PRAGMA|sqlite_master|INSERT OR (IGNORE|REPLACE)|REPLACE INTO|ON CONFLICT|datetime\(|strftime\(|julianday\(|IFNULL\(|AUTOINCREMENT|lastInsertId' "${PROD_GLOB[@]}" . 2>/dev/null | sort -t: -k2 -n -r
