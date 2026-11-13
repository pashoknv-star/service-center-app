#!/usr/bin/env bash
# V6.3-3 (приёмка, вне gate): репетиция миграции схемы v11 → v12 на КОПИИ dev-БД (data/app.db не меняется, прод не трогается).
# Шаги: dev-БД (v6) → код ДО V6.3 (6072f41) доводит до v11 и наполняется задачами → новый код мигрирует v11 → v12.
# Запуск: V63_BEFORE_ROOT=<выгрузка 6072f41> bash scripts/v63_accept_d_migration.sh   (итог: «ИТОГ: N passed, M failed»)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OLD="${V63_BEFORE_ROOT:?нужна выгрузка 6072f41 (git archive 6072f41 | tar -x -C DIR)}"
T="${TMPDIR:-/tmp}/v63_mig_$$"; mkdir -p "$T"
DB="$T/work.db"
PASS=0; FAIL=0
chk() { if [ "$2" = 0 ]; then PASS=$((PASS+1)); echo "  [ok]   $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1"; fi; }
q() { sqlite3 "$1" "$2"; }
PORT=$((21000 + RANDOM % 15000))
serve() { # $1 = code root, $2 = db
  SC_APP_DB="$2" php -S 127.0.0.1:$PORT -t "$1" >/dev/null 2>&1 & SRV=$!
  for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/session.php" && break; sleep 0.1; done
}
stop() { kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; }
login() { curl -s -c "$T/jar" -o /dev/null -X POST -H 'Content-Type: application/json' -d '{"username":"admin","password":"changeme"}' "http://127.0.0.1:$PORT/api/login.php"; }
api() { curl -s -b "$T/jar" -H 'Content-Type: application/json' "$@"; }
rows() { for t in $(sqlite3 "$1" "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by 1"); do printf '%s=%s ' $t "$(sqlite3 "$1" "select count(*) from $t")"; done; echo; }
dumpx() { sqlite3 "$1" ".dump $TABLES" ; }   # только прежние таблицы (без meta/audit_log/sync_log и без task_occurrences)

SHA0=$(sha1sum "$ROOT/data/app.db" | cut -c1-12)
echo "### 0. dev-БД: sha1 до = $SHA0; код ДО: $OLD; код ПОСЛЕ: $ROOT"
cp "$ROOT/data/app.db" "$DB"
echo "dev-БД schema_version: $(q "$DB" "select value from meta where key='schema_version'")"

echo; echo "### 1. старый код (до V6.3) доводит копию до v11 и создаёт задачи"
serve "$OLD" "$DB"; login
EMPS=$(api "http://127.0.0.1:$PORT/api/employees.php" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.data||j.employees||[]);console.log(a.slice(0,3).map(e=>e.id).join(" "))})')
set -- $EMPS; E1=$1; E2=$2; E3=${3:-$2}
echo "сотрудники: $E1 $E2 $E3"
for body in \
  "{\"title\":\"Старая 1\",\"assignees\":[\"$E1\"],\"start_at\":\"2026-11-20T10:00\",\"end_at\":\"2026-11-20T11:00\",\"label\":\"alpha, beta\",\"description\":\"описание\"}" \
  "{\"title\":\"Старая 2 без времени\",\"assignees\":[\"$E1\",\"$E2\"],\"start_at\":\"2026-11-23\",\"end_at\":\"2026-11-24\"}" \
  "{\"title\":\"Старая 3 три исполнителя\",\"assignees\":[\"$E1\",\"$E2\",\"$E3\"],\"start_at\":\"2026-12-01T09:00\",\"end_at\":\"2026-12-01T09:30\",\"priority\":1}" \
  "{\"title\":\"Старая 4 только начало\",\"assignees\":[\"$E2\"],\"start_at\":\"2026-12-02T15:00\"}"; do
  api -X POST "http://127.0.0.1:$PORT/api/tasks.php" -d "$body" -o /dev/null -w '%{http_code} ' ; done; echo
api "http://127.0.0.1:$PORT/api/tasks.php?from=2026-01-01&to=2028-12-31" > "$T/list_old.json"
stop
[ "$(q "$DB" "select value from meta where key='schema_version'")" = 11 ]; chk "старый код: schema_version = 11 ($(q "$DB" "select value from meta where key='schema_version'"))" $?
[ -z "$(q "$DB" "select name from sqlite_master where name='task_occurrences'")" ]; chk "в v11 таблицы task_occurrences нет" $?
NT=$(q "$DB" "select count(*) from tasks"); echo "задач в v11: $NT"; [ "$NT" -ge 4 ]; chk "создано ≥ 4 старых задач" $?
cp "$DB" "$T/v11.db"
TABLES=$(sqlite3 "$T/v11.db" "select group_concat(name,' ') from sqlite_master where type='table' and name not like 'sqlite_%' and name not in ('meta','audit_log','sync_log')")
echo "таблицы для сверки дампа: $TABLES"
echo "ДО:    $(rows "$T/v11.db")"
dumpx "$T/v11.db" > "$T/before.dump"
echo "integrity v11: $(q "$T/v11.db" 'PRAGMA integrity_check') / fk: [$(q "$T/v11.db" 'PRAGMA foreign_key_check')]"

echo; echo "### 2. новый код: v11 → v12 (первый запрос выполняет миграцию)"
cp "$T/v11.db" "$T/v12.db"
serve "$ROOT" "$T/v12.db"; login
api "http://127.0.0.1:$PORT/api/tasks.php?from=2026-01-01&to=2028-12-31" > "$T/list_new.json"
stop
echo "ПОСЛЕ: $(rows "$T/v12.db")"
[ "$(q "$T/v12.db" "select value from meta where key='schema_version'")" = 12 ]; chk "schema_version = 12" $?
q "$T/v12.db" "select sql from sqlite_master where name in ('task_occurrences','idx_task_occurrences_task','idx_task_occurrences_start') order by name"
[ "$(q "$T/v12.db" "select count(*) from sqlite_master where name in ('task_occurrences','idx_task_occurrences_task','idx_task_occurrences_start')")" = 3 ]; chk "создана таблица task_occurrences и 2 индекса" $?
q "$T/v12.db" "select group_concat(name||' '||type||(case when \"notnull\" then ' NOT NULL' else '' end), '; ') from pragma_table_info('task_occurrences')"
q "$T/v12.db" "select 'fk: '||\"table\"||'.'||\"from\"||' on_delete='||on_delete from pragma_foreign_key_list('task_occurrences')"
[ "$(q "$T/v12.db" "select on_delete from pragma_foreign_key_list('task_occurrences')")" = CASCADE ]; chk "FK task_id → tasks(id) ON DELETE CASCADE" $?
[ "$(q "$T/v12.db" 'PRAGMA integrity_check')" = ok ]; chk "integrity_check = ok" $?
[ -z "$(q "$T/v12.db" 'PRAGMA foreign_key_check')" ]; chk "foreign_key_check пуст" $?
[ "$(q "$T/v12.db" 'select count(*) from task_occurrences')" = 0 ]; chk "task_occurrences пуста после миграции" $?
dumpx "$T/v12.db" > "$T/after.dump"
diff -q "$T/before.dump" "$T/after.dump" >/dev/null; chk "существующие данные не изменились: дамп всех прежних таблиц (кроме meta/audit_log/sync_log) идентичен" $?
diff "$T/before.dump" "$T/after.dump" | head -5
# счётчики по всем прежним таблицам (audit_log +1 — запись о входе; sync_log не растёт)
rows "$T/v11.db" | sed 's/audit_log=[0-9]* //' > "$T/r11"; rows "$T/v12.db" | sed 's/task_occurrences=0 //; s/audit_log=[0-9]* //' > "$T/r12"
diff -q "$T/r11" "$T/r12" >/dev/null; chk "число строк во всех прежних таблицах не изменилось (audit_log: +запись входа, не считаем)" $?

echo; echo "### 3. повторный запуск = no-op"
cp "$T/v12.db" "$T/v12_first.db"
serve "$ROOT" "$T/v12.db"; login; api "http://127.0.0.1:$PORT/api/tasks.php" >/dev/null; stop
dumpx "$T/v12.db" > "$T/second.dump"; dumpx "$T/v12_first.db" > "$T/first.dump"
diff -q "$T/first.dump" "$T/second.dump" >/dev/null; chk "второй запуск: дамп идентичен (кроме meta/audit/sync)" $?
[ "$(q "$T/v12.db" "select value from meta where key='schema_version'")" = 12 ]; chk "версия по-прежнему 12" $?
# повтор как в отчёте V6.3-2 (CLI): php -r Database::migrate()
cp "$T/v11.db" "$T/v12_cli.db"
OUT1=$(cd "$ROOT" && SC_APP_DB="$T/v12_cli.db" php -r 'require "api/db.php"; $d = Database::getInstance(); $d->migrate(); echo $d->getSchemaVersion();')
OUT2=$(cd "$ROOT" && SC_APP_DB="$T/v12_cli.db" php -r 'require "api/db.php"; $d = Database::getInstance(); $d->migrate(); echo $d->getSchemaVersion();')
[ "$OUT1" = 12 ] && [ "$OUT2" = 12 ]; chk "CLI Database::migrate() (порядок из V6.3-2_REPORT §2): $OUT1, повтор: $OUT2" $?
[ "$(q "$T/v12_cli.db" 'PRAGMA integrity_check')" = ok ] && [ -z "$(q "$T/v12_cli.db" 'PRAGMA foreign_key_check')" ]; chk "CLI-копия: integrity_check ok, foreign_key_check пуст" $?

echo; echo "### 4. старые задачи выглядят как раньше (API до/после)"
node -e '
const fs=require("fs"); const a=JSON.parse(fs.readFileSync(process.argv[1])), b=JSON.parse(fs.readFileSync(process.argv[2]));
const A=a.tasks||[], B=b.tasks||[]; let ok=A.length===B.length&&A.length>=4, bad=[]; let hasNew=true;
B.forEach(t=>{ if(!Array.isArray(t.occurrences)||t.occurrences.length!==0||t.next_at!==t.start_at) hasNew=false; });
A.forEach(t=>{ const u=B.find(x=>x.id===t.id); if(!u){ok=false;bad.push("нет "+t.id);return;} const c=Object.assign({},u); delete c.occurrences; delete c.next_at; const strip=(o)=>JSON.stringify(Object.keys(o).sort().map(k=>[k,o[k]])); if(strip(c)!==strip(t)){ok=false;bad.push(t.title+": "+Object.keys(t).filter(k=>JSON.stringify(t[k])!==JSON.stringify(c[k])).join(","));} });
const extra=Object.keys(B[0]||{}).filter(k=>!(k in (A[0]||{})));
console.log("задач до/после: "+A.length+"/"+B.length+"; новые поля: "+extra.join(",")+"; различия: "+(bad.join("; ")||"нет"));
process.exit(ok&&hasNew?0:1);' "$T/list_old.json" "$T/list_new.json"; chk "ответ API старых задач = прежний + occurrences:[] + next_at=start_at (иных отличий нет)" $?

echo; echo "### 5. каскад: удаление задачи удаляет повторы"
serve "$ROOT" "$T/v12.db"; login
TID=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(j.tasks[0].id)' "$T/list_new.json")
VER=$(api "http://127.0.0.1:$PORT/api/tasks.php?id=$TID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).task.version))')
api -X POST "http://127.0.0.1:$PORT/api/tasks.php?id=$TID&action=occ_add" -d "{\"version\":$VER,\"start_at\":\"2027-05-05T10:00\"}" -o /dev/null -w 'occ_add → %{http_code}\n'
VER=$((VER+1))
api -X POST "http://127.0.0.1:$PORT/api/tasks.php?id=$TID&action=occ_add" -d "{\"version\":$VER,\"start_at\":\"2027-05-06T10:00\"}" -o /dev/null -w 'occ_add → %{http_code}\n'
stop
[ "$(q "$T/v12.db" "select count(*) from task_occurrences where task_id='$TID'")" = 2 ]; chk "у задачи $TID 2 повтора" $?
sqlite3 "$T/v12.db" "PRAGMA foreign_keys=ON; DELETE FROM tasks WHERE id='$TID';"
[ "$(q "$T/v12.db" "select count(*) from task_occurrences where task_id='$TID'")" = 0 ]; chk "DELETE FROM tasks (foreign_keys=ON) → повторы удалены каскадом" $?
[ "$(q "$T/v12.db" 'select count(*) from task_occurrences where task_id not in (select id from tasks)')" = 0 ] && [ -z "$(q "$T/v12.db" 'PRAGMA foreign_key_check')" ] && [ "$(q "$T/v12.db" 'PRAGMA integrity_check')" = ok ]; chk "после каскада: сирот нет, foreign_key_check пуст, integrity_check ok" $?

echo; echo "### 6. откат кода: СТАРЫЙ код на v12-БД (с повторами) работает"
cp "$T/v12.db" "$T/v12_rb.db"
serve "$ROOT" "$T/v12_rb.db"; login
TID2=$(api "http://127.0.0.1:$PORT/api/tasks.php?from=2026-01-01&to=2028-12-31" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tasks[0].id))')
V2=$(api "http://127.0.0.1:$PORT/api/tasks.php?id=$TID2" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).task.version))')
api -X POST "http://127.0.0.1:$PORT/api/tasks.php?id=$TID2&action=occ_add" -d "{\"version\":$V2,\"start_at\":\"2027-06-06T10:00\"}" -o /dev/null
stop
serve "$OLD" "$T/v12_rb.db"; login
CODE=$(api -o "$T/rb_list.json" -w '%{http_code}' "http://127.0.0.1:$PORT/api/tasks.php?from=2026-01-01&to=2028-12-31")
N_RB=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).tasks.length)' "$T/rb_list.json")
stop
[ "$CODE" = 200 ] && [ "$N_RB" -ge 3 ]; chk "старый код на v12-БД: GET api/tasks.php → $CODE, задач $N_RB (таблицу повторов игнорирует)" $?
[ "$(q "$T/v12_rb.db" "select value from meta where key='schema_version'")" = 12 ]; chk "версия схемы после отката кода остаётся 12 (БД не понижается)" $?

echo; echo "### 7. data/app.db не тронута"
SHA1=$(sha1sum "$ROOT/data/app.db" | cut -c1-12)
[ "$SHA0" = "$SHA1" ]; chk "sha1 data/app.db: $SHA0 → $SHA1" $?
( cd "$ROOT" && git status --porcelain -- data/app.db | wc -l | grep -q '^0$' ); chk "git status data/app.db чист" $?
rm -rf "$T"
echo; echo "ИТОГ: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
