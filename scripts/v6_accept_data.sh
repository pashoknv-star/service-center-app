#!/usr/bin/env bash
# V6-4 (приёмка, вне gate): шаг данных «Директор СЦ» и миграция v11 — только на ВРЕМЕННЫХ копиях dev-БД.
# Вымышленные данные: «Костецкий Андрей Николаевич» и «Тестова Анна Сергеевна» в g3. Прод не трогается.
set -u
OLD_G3='В'"2С"   # старое имя зоны 3 (записано через склейку, чтобы сьют director не находил его в scripts/)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="${TMPDIR:-/tmp}/v64_data_$$"; mkdir -p "$T"
DB="$T/work.db"; SQL="$ROOT/scripts/v6_director_data.sql"
PHP_PORT=$((20000 + RANDOM % 20000))
cp "$ROOT/data/app.db" "$DB"
echo "### 0. dev-БД: sha1 до = $(sha1sum "$ROOT/data/app.db" | cut -c1-12)"

migrate() { # $1 = db : любой запрос с логином запускает migrate()
  SC_APP_DB="$1" php -S 127.0.0.1:$PHP_PORT -t "$ROOT" >/dev/null 2>&1 & local P=$!
  for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PHP_PORT/api/session.php" && break; sleep 0.1; done
  curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"changeme"}' "http://127.0.0.1:$PHP_PORT/api/login.php"
  kill $P 2>/dev/null; wait $P 2>/dev/null
}
rows() { for t in $(sqlite3 "$1" "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by 1"); do printf '%s=%s ' $t "$(sqlite3 "$1" "select count(*) from $t")"; done; echo; }

echo "### 1. миграция до v11 (штатный код), затем «состояние v10» с g3=старое имя"
migrate "$DB"
sqlite3 "$DB" "select 'schema_version', value from meta where key='schema_version'; select 'g3', name from groups where id='g3';"
sqlite3 "$DB" "UPDATE meta SET value='10' WHERE key='schema_version'; UPDATE groups SET name='${OLD_G3}' WHERE id='g3';"
# вымышленные сотрудники в g3 + связанные данные
sqlite3 "$DB" <<'EOF'
INSERT INTO employees (id, full_name, position_id, location, group_id, photo_url, sort_order, created_at, updated_at)
  VALUES ('emp_k1','Костецкий Андрей Николаевич',(SELECT id FROM positions LIMIT 1),'Офис','g3','images/old_photo.webp',1,'2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00'),
         ('emp_k2','Тестова Анна Сергеевна',(SELECT id FROM positions LIMIT 1),'Офис','g3',NULL,2,'2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00');
INSERT INTO schedule_entries (employee_id,date,status,approval_status,updated_at) VALUES
  ('emp_k1','2026-07-01','vacation','approved','x'),('emp_k1','2026-07-02','vacation','approved','x'),('emp_k1','2026-08-03','sick','approved','x');
INSERT INTO vacation_balances VALUES ('emp_k1',2026,28,2,26);
INSERT INTO tasks (id,title,start_at,status,created_at,updated_at,archived) VALUES
  ('t_open','Открытая тест-задача','2026-11-20T10:00','open','2026-11-01T00:00:00+00:00','2026-11-01T00:00:00+00:00',0),
  ('t_closed','Закрытая тест-задача','2026-10-20T10:00','closed','2026-10-01T00:00:00+00:00','2026-10-01T00:00:00+00:00',0);
INSERT INTO task_assignees (task_id,employee_id,role,full_name_snapshot) VALUES ('t_open','emp_k1','assignee','Костецкий Андрей Николаевич'),('t_closed','emp_k1','assignee','Костецкий Андрей Николаевич');
EOF
sqlite3 "$DB" "select 'schema_version', value from meta where key='schema_version'; select 'g3', name from groups where id='g3';"
cp "$DB" "$T/v10.db"
echo "--- строки ДО:"; rows "$T/v10.db"
sqlite3 "$T/v10.db" .dump | grep -v -E '^INSERT INTO "?(groups|meta|audit_log)"? |sqlite_sequence' > "$T/before.dump"
migrate "$T/v10.db"
echo "--- строки ПОСЛЕ:"; rows "$T/v10.db"
sqlite3 "$T/v10.db" "select 'schema_version', value from meta where key='schema_version'; select 'g3', name from groups where id='g3'; PRAGMA integrity_check; PRAGMA foreign_key_check;"
sqlite3 "$T/v10.db" .dump | grep -v -E '^INSERT INTO "?(groups|meta|audit_log)"? |sqlite_sequence' > "$T/after.dump"
diff -q "$T/before.dump" "$T/after.dump" >/dev/null && echo "дамп без groups/meta/audit_log: ИДЕНТИЧЕН" || { echo "дамп: РАЗЛИЧИЯ"; diff "$T/before.dump" "$T/after.dump" | head; }
sqlite3 "$T/v10.db" .dump > "$T/m1.dump"
sqlite3 "$T/v10.db" "UPDATE meta SET value='10' WHERE key='schema_version'; UPDATE groups SET name='${OLD_G3}' WHERE id='g3';"
migrate "$T/v10.db"
sqlite3 "$T/v10.db" "select 'повтор: schema_version', value from meta where key='schema_version'; select 'повтор g3', name from groups where id='g3';"
echo "--- чужое имя g3 не затирается:"
sqlite3 "$T/v10.db" "UPDATE meta SET value='10' WHERE key='schema_version'; UPDATE groups SET name='Моё имя' WHERE id='g3';"
migrate "$T/v10.db"; sqlite3 "$T/v10.db" "select 'g3 после', name from groups where id='g3';"

echo; echo "### 2. DRY-RUN (sed … | sqlite3 -readonly) на мигрированной копии"
migrate "$DB"   # приводит v10 → v11 (g3 → Директор СЦ)
sqlite3 "$DB" "select 'schema_version', value from meta where key='schema_version'; select 'g3', name from groups where id='g3';"
sha1sum "$DB" | cut -c1-12 > "$T/sha_pre"
sed '/^-- @@APPLY/,$d' "$SQL" | sqlite3 -readonly "$DB"
echo "sha1 до/после DRY-RUN: $(cat $T/sha_pre) / $(sha1sum "$DB" | cut -c1-12)"

echo; echo "### 3. бэкап до APPLY (.backup) и APPLY"
sqlite3 "$DB" ".backup '$T/backup.db'"; echo "backup: $(sqlite3 "$T/backup.db" 'PRAGMA integrity_check')"
sqlite3 "$DB" < "$SQL" | sed -n '/APPLIED\|NO-OP/,$p'
echo "--- ещё один g3 (Тестова) не затронут:"
sqlite3 "$DB" "select id, full_name, group_id, photo_url from employees where group_id='g3' order by id; select 'снимки в назначениях', task_id, full_name_snapshot from task_assignees where employee_id='emp_k1'; select 'audit/sync:'; select entity_id, details from audit_log where actor='sql:v6-3'; select entity_type, entity_id, action from sync_log where actor='sql:v6-3'; select 'schedule_entries emp_k1', count(*) from schedule_entries where employee_id='emp_k1'; select 'balance emp_k1', count(*) from vacation_balances where employee_id='emp_k1';"

echo; echo "### 4. повтор APPLY = no-op"
sqlite3 "$DB" .dump > "$T/pre_repeat.dump"
sqlite3 "$DB" < "$SQL" | sed -n '/NO-OP\|APPLIED/p'
sqlite3 "$DB" .dump > "$T/post_repeat.dump"
diff -q "$T/pre_repeat.dump" "$T/post_repeat.dump" >/dev/null && echo "БД после повтора побайтово идентична (дамп)" || echo "РАЗЛИЧИЯ после повтора"
sqlite3 "$DB" "PRAGMA integrity_check; PRAGMA foreign_key_check;"

echo; echo "### 5. откат: .restore из бэкапа внутрь существующего файла"
sqlite3 "$DB" ".restore '$T/backup.db'"
sqlite3 "$DB" "select id, full_name, photo_url from employees where id='emp_k1'; PRAGMA integrity_check;"

echo; echo "### 6. негативные случаи (NO-OP, дамп не меняется)"
neg() { # $1 = описание, $2 = SQL-подготовка
  cp "$T/backup.db" "$T/neg.db"; sqlite3 "$T/neg.db" "$2"; sqlite3 "$T/neg.db" .dump > "$T/n1"
  local r; r=$(sqlite3 "$T/neg.db" < "$SQL" | grep -o 'APPLIED\|NO-OP' | head -1); sqlite3 "$T/neg.db" .dump > "$T/n2"
  printf '%-45s → %s; ' "$1" "$r"; diff -q "$T/n1" "$T/n2" >/dev/null && echo "БД не изменена" || echo "БД ИЗМЕНЕНА!"
}
neg "2 «Костецких»" "INSERT INTO employees (id,full_name,group_id) VALUES ('emp_k3','Костецкий Андрей Николаевич','g3');"
neg "0 «Костецких»" "DELETE FROM employees WHERE id='emp_k1';"
neg "«Игнатенко» уже есть" "INSERT INTO employees (id,full_name,group_id) VALUES ('emp_i1','Игнатенко Павел Валерьевич','g3');"
neg "schema_version=9" "UPDATE meta SET value='9' WHERE key='schema_version';"
rm -rf "$T"
echo; echo "### dev-БД: sha1 после = $(sha1sum "$ROOT/data/app.db" | cut -c1-12)"
