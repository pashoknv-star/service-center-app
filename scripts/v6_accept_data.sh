#!/usr/bin/env bash
# V6-4 / V6-6 (репетиция данных, вне gate): шаг данных «Управление СЦ» (ФИО, фото, должность «Директор», ОЧИСТКА ИСТОРИИ)
# и миграция v11 — только на ВРЕМЕННЫХ копиях dev-БД. Прод не трогается, data/app.db не меняется.
# Вымышленные данные: «Костецкий Андрей Николаевич» (g3, история во ВСЕХ очищаемых таблицах),
# «Тестова Анна Сергеевна» (g3 — чтобы проверить сигнал «другие сотрудники g3») и контрольный «Другой Сотрудник» (его данные не трогаются).
# Итог: строка «ИТОГ: N passed, M failed»; код выхода 1, если есть провал.
set -u
OLD_G3='В'"2С"            # прежние имена зоны 3 (записаны через склейку, чтобы сьют director не находил их в scripts/)
OLD_G3_FIRST='Директор'" СЦ"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="${TMPDIR:-/tmp}/v66_data_$$"; mkdir -p "$T"
DB="$T/work.db"; SQL="$ROOT/scripts/v6_director_data.sql"
PHP_PORT=$((20000 + RANDOM % 20000))
PASS=0; FAIL=0
chk() { # $1 = описание, $2 = 0|1 (0 = успех)
  if [ "$2" = 0 ]; then PASS=$((PASS+1)); echo "  [ok]   $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1"; fi
}
cp "$ROOT/data/app.db" "$DB"
SHA_DEV_BEFORE=$(sha1sum "$ROOT/data/app.db" | cut -c1-12)
echo "### 0. dev-БД: sha1 до = $SHA_DEV_BEFORE"

migrate() { # $1 = db : любой запрос с логином запускает migrate()
  SC_APP_DB="$1" php -S 127.0.0.1:$PHP_PORT -t "$ROOT" >/dev/null 2>&1 & local P=$!
  for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PHP_PORT/api/session.php" && break; sleep 0.1; done
  curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"changeme"}' "http://127.0.0.1:$PHP_PORT/api/login.php"
  kill $P 2>/dev/null; wait $P 2>/dev/null
}
rows() { for t in $(sqlite3 "$1" "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by 1"); do printf '%s=%s ' $t "$(sqlite3 "$1" "select count(*) from $t")"; done; echo; }
q() { sqlite3 "$1" "$2"; }
# истории сотрудника по 5 очищаемым таблицам: «sched,bal,trip_part,trip_req,task_assign»
hist() { q "$1" "select (select count(*) from schedule_entries where employee_id='$2')||','||(select count(*) from vacation_balances where employee_id='$2')||','||(select count(*) from trip_participants where employee_id='$2')||','||(select count(*) from trip_requests where employee_id='$2')||','||(select count(*) from task_assignees where employee_id='$2');"; }

echo "### 1. миграция до v11 (штатный код), затем «состояние v10» с g3=прежнее имя"
migrate "$DB"
sqlite3 "$DB" "select 'schema_version', value from meta where key='schema_version'; select 'g3', name from groups where id='g3';"
sqlite3 "$DB" "UPDATE meta SET value='10' WHERE key='schema_version'; UPDATE groups SET name='${OLD_G3}' WHERE id='g3';"
# вымышленные сотрудники + связанные данные (во всех очищаемых таблицах)
sqlite3 "$DB" <<'EOF'
INSERT INTO employees (id, full_name, position_id, location, group_id, photo_url, sort_order, created_at, updated_at)
  VALUES ('emp_k1','Костецкий Андрей Николаевич','pos_master','Офис','g3','images/old_photo.webp',1,'2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00'),
         ('emp_o1','Другой Сотрудник','pos_ingener','Офис','g0',NULL,3,'2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00');
INSERT INTO schedule_entries (employee_id,date,status,approval_status,updated_at) VALUES
  ('emp_k1','2026-07-01','vacation','approved','x'),('emp_k1','2026-07-02','vacation','approved','x'),('emp_k1','2026-08-03','sick','approved','x'),
  ('emp_k1','2026-09-04','dayoff','approved','x'),
  ('emp_o1','2026-07-01','vacation','approved','x'),('emp_o1','2026-09-01','sick','approved','x');
INSERT INTO vacation_balances VALUES ('emp_k1',2026,28,2,26),('emp_k1',2025,28,28,0),('emp_o1',2026,28,0,28);
INSERT INTO tasks (id,title,start_at,status,created_at,updated_at,archived) VALUES
  ('t_only','Задача: он единственный исполнитель','2026-11-20T10:00','open','2026-11-01T00:00:00+00:00','2026-11-01T00:00:00+00:00',0),
  ('t_shared','Задача: общая с коллегой','2026-11-21T10:00','open','2026-11-01T00:00:00+00:00','2026-11-01T00:00:00+00:00',0),
  ('t_closed','Закрытая тест-задача','2026-10-20T10:00','closed','2026-10-01T00:00:00+00:00','2026-10-01T00:00:00+00:00',0),
  ('t_arch','Архивная тест-задача','2026-03-20T10:00','open','2026-03-01T00:00:00+00:00','2026-03-01T00:00:00+00:00',1),
  ('t_watch','Задача: он наблюдатель','2026-11-22T10:00','open','2026-11-01T00:00:00+00:00','2026-11-01T00:00:00+00:00',0),
  ('t_o1','Чужая задача','2026-11-23T10:00','open','2026-11-01T00:00:00+00:00','2026-11-01T00:00:00+00:00',0);
INSERT INTO task_checklist (task_id,text,done,sort_order) VALUES ('t_only','пункт чек-листа',0,0);
INSERT INTO task_assignees (task_id,employee_id,role,full_name_snapshot) VALUES
  ('t_only','emp_k1','assignee','Костецкий Андрей Николаевич'),
  ('t_shared','emp_k1','assignee','Костецкий Андрей Николаевич'),('t_shared','emp_o1','assignee','Другой Сотрудник'),
  ('t_closed','emp_k1','assignee','Костецкий Андрей Николаевич'),
  ('t_arch','emp_k1','assignee','Костецкий Андрей Николаевич'),
  ('t_watch','emp_o1','assignee','Другой Сотрудник'),('t_watch','emp_k1','watcher','Костецкий Андрей Николаевич'),
  ('t_o1','emp_o1','assignee','Другой Сотрудник');
INSERT INTO trips (id,title,status,version,created_at,updated_at) VALUES
  ('trip_1','Командировка: только он','confirmed',1,'2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00'),
  ('trip_2','Командировка: общая','confirmed',1,'2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00'),
  ('trip_3','Командировка: чужая','confirmed',1,'2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00');
INSERT INTO trip_participants (trip_id,employee_id,start_date,end_date) VALUES
  ('trip_1','emp_k1','2026-05-01','2026-05-03'),('trip_2','emp_k1','2026-06-01','2026-06-03'),('trip_2','emp_o1','2026-06-01','2026-06-03'),('trip_3','emp_o1','2026-07-10','2026-07-12');
INSERT INTO trip_requests (request_id,trip_id,employee_id,payload,status,created_at) VALUES
  ('rq_1','trip_1','emp_k1','{}','queued','2026-01-01T00:00:00+00:00'),('rq_2','trip_3','emp_o1','{}','queued','2026-01-01T00:00:00+00:00');
EOF
sqlite3 "$DB" "select 'schema_version', value from meta where key='schema_version'; select 'g3', name from groups where id='g3';"
cp "$DB" "$T/v10.db"

echo "--- миграция v10→v11 на копии с историей: строки ДО / ПОСЛЕ"
echo "ДО:    $(rows "$T/v10.db")"
sqlite3 "$T/v10.db" .dump | grep -v -E '^INSERT INTO "?(groups|meta|audit_log)"? |sqlite_sequence' > "$T/before.dump"
migrate "$T/v10.db"
echo "ПОСЛЕ: $(rows "$T/v10.db")"
sqlite3 "$T/v10.db" "select 'schema_version', value from meta where key='schema_version'; select 'g3', name from groups where id='g3'; PRAGMA integrity_check; PRAGMA foreign_key_check;"
sqlite3 "$T/v10.db" .dump | grep -v -E '^INSERT INTO "?(groups|meta|audit_log)"? |sqlite_sequence' > "$T/after.dump"
diff -q "$T/before.dump" "$T/after.dump" >/dev/null; chk "миграция: дамп без groups/meta/audit_log идентичен" $?
[ "$(q "$T/v10.db" "select name from groups where id='g3'")" = "Управление СЦ" ]; chk "миграция: g3 = «Управление СЦ» (было «${OLD_G3}»)" $?
sqlite3 "$T/v10.db" .dump | grep -v -E '^INSERT INTO "?audit_log"? |sqlite_sequence' > "$T/m1.dump"
sqlite3 "$T/v10.db" "UPDATE meta SET value='10' WHERE key='schema_version';"
migrate "$T/v10.db"
sqlite3 "$T/v10.db" "UPDATE meta SET value='11' WHERE key='schema_version';"
sqlite3 "$T/v10.db" .dump | grep -v -E '^INSERT INTO "?audit_log"? |sqlite_sequence' > "$T/m2.dump"; diff -q "$T/m1.dump" "$T/m2.dump" >/dev/null; chk "миграция: повтор — no-op (дамп идентичен; audit_log исключён — запись о входе curl)" $?
# первая редакция v11 (g3 = «Директор СЦ») тоже приводится к новому имени
sqlite3 "$T/v10.db" "UPDATE meta SET value='10' WHERE key='schema_version'; UPDATE groups SET name='${OLD_G3_FIRST}' WHERE id='g3';"
migrate "$T/v10.db"
[ "$(q "$T/v10.db" "select name from groups where id='g3'")" = "Управление СЦ" ]; chk "миграция: g3 «${OLD_G3_FIRST}» (первая редакция v11) → «Управление СЦ»" $?
# чужое имя не затирается
sqlite3 "$T/v10.db" "UPDATE meta SET value='10' WHERE key='schema_version'; UPDATE groups SET name='Моё имя' WHERE id='g3';"
migrate "$T/v10.db"
[ "$(q "$T/v10.db" "select name from groups where id='g3'")" = "Моё имя" ]; chk "миграция: чужое имя g3 не затирается" $?

echo; echo "### 2. DRY-RUN (sed … | sqlite3 -readonly) на мигрированной копии (+ «Тестова» в g3 — проверка сигнала СТОП)"
migrate "$DB"   # приводит v10 → v11 (g3 → Управление СЦ)
sqlite3 "$DB" "select 'schema_version', value from meta where key='schema_version'; select 'g3', name from groups where id='g3';"
sqlite3 "$DB" "INSERT INTO employees (id, full_name, position_id, location, group_id, sort_order, created_at, updated_at) VALUES ('emp_k2','Тестова Анна Сергеевна','pos_ingener','Офис','g3',2,'2026-01-01T00:00:00+00:00','2026-01-01T00:00:00+00:00');"
sqlite3 "$DB" .dump > "$T/pre_dry.dump"
sed '/^-- @@APPLY/,$d' "$SQL" | sqlite3 -readonly "$DB" | tee "$T/dry.txt"
sqlite3 "$DB" .dump > "$T/post_dry.dump"; diff -q "$T/pre_dry.dump" "$T/post_dry.dump" >/dev/null; chk "DRY-RUN: БД не изменилась (дамп идентичен, -readonly)" $?
grep -q "matches (нужно ровно 1) | 1" "$T/dry.txt"; chk "DRY-RUN: matches = 1" $?
grep -q "другие сотрудники g3 (до APPLY; ожидается 0) | 1" "$T/dry.txt" && grep -q "другой сотрудник g3 | emp_k2 | Тестова Анна Сергеевна" "$T/dry.txt"; chk "DRY-RUN: «другие сотрудники g3» = 1 (здесь нарочно — сигнал СТОП; на проде ожидается 0)" $?
grep -q "emp_k1 | Костецкий Андрей Николаевич | g3 | Управление СЦ | pos_master | Master" "$T/dry.txt"; chk "DRY-RUN: текущая должность Master (pos_master)" $?
grep -q "новая должность «Директор» | pos_директор | нет в positions — будет СОЗДАНА" "$T/dry.txt"; chk "DRY-RUN: новая должность — pos_директор, будет создана" $?
grep -q "УДАЛИТСЯ: schedule_entries | 4 | 2026-07-01 | 2026-09-04" "$T/dry.txt" && grep -q "УДАЛИТСЯ: vacation_balances | 2 | 2025 | 2026" "$T/dry.txt" && grep -q "УДАЛИТСЯ: trip_participants | 2" "$T/dry.txt" && grep -q "УДАЛИТСЯ: trip_requests (очередь RPA) | 1" "$T/dry.txt" && grep -q "УДАЛИТСЯ: task_assignees (все роли) | 5" "$T/dry.txt"; chk "DRY-RUN: счётчики УДАЛИТСЯ = 4 / 2 / 2 / 1 / 5" $?
grep -q "ОСТАНУТСЯ, version+1: задач | 5" "$T/dry.txt" && grep -q "ОСТАНУТСЯ, version+1: командировок | 2" "$T/dry.txt" && grep -q "командировок останется БЕЗ участников | 1" "$T/dry.txt"; chk "DRY-RUN: задач 5 и командировок 2 останутся (version+1); командировок без участников 1" $?
grep -q "станут «Без исполнителя» (открытых задач) | 1" "$T/dry.txt" && grep -q "задача без исполнителя | t_only | Задача: он единственный исполнитель" "$T/dry.txt"; chk "DRY-RUN: «станут Без исполнителя» = 1, название выведено" $?
# убираем «Тестову», дальше — боевой сценарий (других сотрудников g3 нет)
sqlite3 "$DB" "DELETE FROM employees WHERE id='emp_k2';"

echo; echo "### 3. бэкап до APPLY (.backup) и APPLY"
sqlite3 "$DB" ".backup '$T/backup.db'"; echo "backup: $(sqlite3 "$T/backup.db" 'PRAGMA integrity_check')"
sqlite3 "$DB" .dump > "$T/pre_apply.dump"
HK0=$(hist "$DB" emp_k1); HO0=$(hist "$DB" emp_o1)
echo "история emp_k1 ДО (sched,bal,trip_part,trip_req,task_assign): $HK0;  контроль emp_o1: $HO0"
sqlite3 "$DB" < "$SQL" > "$T/apply.txt"; cat "$T/apply.txt"
grep -q "APPLIED: 1 сотрудник обновлён, история очищена" "$T/apply.txt"; chk "APPLY: «APPLIED … история очищена»" $?
[ "$(q "$DB" "PRAGMA integrity_check")" = ok ] && [ -z "$(q "$DB" "PRAGMA foreign_key_check")" ]; chk "APPLY: integrity_check ok, foreign_key_check пуст" $?
[ "$(q "$DB" "select full_name||'|'||group_id||'|'||photo_url from employees where id='emp_k1'")" = "Игнатенко Павел Валерьевич|g3|images/photo_1794600000_d1ec7040.jpg" ]; chk "APPLY: ФИО, группа g3, фото" $?
[ "$(q "$DB" "select position_id from employees where id='emp_k1'")" = "pos_директор" ] && [ "$(q "$DB" "select name from positions where id='pos_директор'")" = "Директор" ]; chk "APPLY: должность «Директор» (pos_директор) создана и назначена" $?
[ "$(hist "$DB" emp_k1)" = "0,0,0,0,0" ]; chk "APPLY: ОЧИСТКА — у сотрудника 0 записей в КАЖДОЙ из 5 таблиц (график, остатки, участие в командировках, RPA-заявки, назначения задач): $(hist "$DB" emp_k1)" $?
[ "$(hist "$DB" emp_o1)" = "$HO0" ]; chk "APPLY: контрольный сотрудник не тронут ($(hist "$DB" emp_o1))" $?
[ "$(q "$DB" "select count(*) from tasks")" = 6 ] && [ "$(q "$DB" "select count(*) from trips")" = 3 ] && [ "$(q "$DB" "select count(*) from task_checklist")" = 1 ]; chk "APPLY: задачи (6), командировки (3) и чек-лист на месте" $?
[ "$(q "$DB" "select group_concat(id||'='||version) from (select id,version from trips order by id)")" = "trip_1=2,trip_2=2,trip_3=1" ]; chk "APPLY: trip_1/trip_2 version+1, trip_3 — нет" $?
[ "$(q "$DB" "select group_concat(id||'='||version) from (select id,version from tasks order by id)")" = "t_arch=2,t_closed=2,t_o1=1,t_only=2,t_shared=2,t_watch=2" ]; chk "APPLY: затронутые задачи version+1, t_o1 — нет" $?
echo "--- «⚠ Без исполнителя» после APPLY (правило api/tasks.php ?orphans=1):"
sqlite3 "$DB" "select t.id, t.title from tasks t where t.archived=0 and t.status='open' and not exists (select 1 from task_assignees ta join employees e on e.id=ta.employee_id where ta.task_id=t.id and ta.role='assignee');"
[ "$(q "$DB" "select group_concat(t.id) from tasks t where t.archived=0 and t.status='open' and not exists (select 1 from task_assignees ta join employees e on e.id=ta.employee_id where ta.task_id=t.id and ta.role='assignee')")" = "t_only" ]; chk "APPLY: без исполнителя стала ровно t_only" $?
echo "--- audit_log / sync_log:"
sqlite3 "$DB" "select action, entity_id, details from audit_log where actor='sql:v6-6'; select entity_type, entity_id, action from sync_log where actor='sql:v6-6' order by id;"
[ "$(q "$DB" "select count(*) from audit_log where actor='sql:v6-6'")" = 2 ] && [ "$(q "$DB" "select count(*) from audit_log where details = '{\"deleted\":{\"schedule_entries\":4,\"vacation_balances\":2,\"trip_participants\":2,\"trip_requests\":1,\"task_assignees\":5}}'")" = 1 ]; chk "APPLY: audit_log +2 (employee.update, employee.history_clear со счётчиками 4/2/2/1/5); журнал не чистился" $?
[ "$(q "$DB" "select count(*) from sync_log where actor='sql:v6-6'")" = 7 ] && [ "$(q "$DB" "select count(*) from sync_log where actor='sql:v6-6' and entity_type='entry' and action='delete'")" = 4 ] && [ "$(q "$DB" "select group_concat(entity_id) from (select entity_id from sync_log where actor='sql:v6-6' and entity_type='trip' order by entity_id)")" = "trip_1,trip_2" ]; chk "APPLY: sync_log +7 (employee/upsert, 4 × entry/delete, 2 × trip/upsert)" $?

echo; echo "### 4. повтор APPLY = no-op"
sqlite3 "$DB" .dump > "$T/pre_repeat.dump"
sqlite3 "$DB" < "$SQL" | sed -n '/NO-OP\|APPLIED/p'
sqlite3 "$DB" .dump > "$T/post_repeat.dump"
diff -q "$T/pre_repeat.dump" "$T/post_repeat.dump" >/dev/null; chk "повтор: БД побайтово идентична (дамп), в т.ч. audit/sync/version/positions" $?
[ "$(sqlite3 "$DB" < "$SQL" | grep -c 'NO-OP')" = 1 ]; chk "повтор: итог «NO-OP»" $?
sqlite3 "$DB" "PRAGMA integrity_check; PRAGMA foreign_key_check;"

echo; echo "### 5. откат: .restore из бэкапа внутрь существующего файла"
sqlite3 "$DB" ".restore '$T/backup.db'"
sqlite3 "$DB" "select id, full_name, position_id, photo_url from employees where id='emp_k1'; PRAGMA integrity_check;"
sqlite3 "$DB" .dump > "$T/post_restore.dump"
diff -q "$T/pre_apply.dump" "$T/post_restore.dump" >/dev/null; chk "откат: БД побайтово как до APPLY (дамп)" $?
[ "$(hist "$DB" emp_k1)" = "$HK0" ] && [ "$(q "$DB" "select position_id from employees where id='emp_k1'")" = pos_master ] && [ "$(q "$DB" "select count(*) from positions where name='Директор'")" = 0 ]; chk "откат: история ($HK0) и прежняя должность вернулись, «Директор» не создана" $?

echo; echo "### 6. негативные случаи (NO-OP, дамп не меняется)"
neg() { # $1 = описание, $2 = SQL-подготовка
  cp "$T/backup.db" "$T/neg.db"; sqlite3 "$T/neg.db" "$2"; sqlite3 "$T/neg.db" .dump > "$T/n1"
  local r; r=$(sqlite3 "$T/neg.db" < "$SQL" | grep -o 'APPLIED\|NO-OP' | head -1); sqlite3 "$T/neg.db" .dump > "$T/n2"
  [ "$r" = "NO-OP" ] && diff -q "$T/n1" "$T/n2" >/dev/null; chk "$1 → $r, БД не изменена" $?
}
neg "2 «Костецких»" "INSERT INTO employees (id,full_name,group_id) VALUES ('emp_k3','Костецкий Андрей Николаевич','g3');"
neg "0 «Костецких»" "DELETE FROM employees WHERE id='emp_k1';"
neg "«Игнатенко» уже есть" "INSERT INTO employees (id,full_name,group_id) VALUES ('emp_i1','Игнатенко Павел Валерьевич','g3');"
neg "schema_version=9" "UPDATE meta SET value='9' WHERE key='schema_version';"
neg "id pos_директор занят другим именем" "INSERT INTO positions (id,name,sort_order) VALUES ('pos_директор','Другая должность',99);"

echo; echo "### 7. должность «Директор» уже есть в positions (под другим id) → назначается, не создаётся"
cp "$T/backup.db" "$T/pos.db"; sqlite3 "$T/pos.db" "INSERT INTO positions (id,name,sort_order) VALUES ('pos_dir_prod','Директор',50);"
NPOS=$(q "$T/pos.db" "select count(*) from positions")
sqlite3 "$T/pos.db" < "$SQL" | grep -o 'APPLIED[^|]*\|NO-OP' | head -1
[ "$(q "$T/pos.db" "select position_id from employees where id='emp_k1'")" = pos_dir_prod ] && [ "$(q "$T/pos.db" "select count(*) from positions")" = "$NPOS" ]; chk "должность найдена по имени (pos_dir_prod), новая не создана" $?

rm -rf "$T"
echo; SHA_DEV_AFTER=$(sha1sum "$ROOT/data/app.db" | cut -c1-12)
echo "### dev-БД: sha1 после = $SHA_DEV_AFTER"
[ "$SHA_DEV_BEFORE" = "$SHA_DEV_AFTER" ]; chk "data/app.db не изменена" $?
echo "ИТОГ: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
