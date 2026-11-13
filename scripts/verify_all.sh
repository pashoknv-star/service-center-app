#!/usr/bin/env bash
# verify_all.sh — единая точка входа Verification gate service-center-app.
#
#   bash scripts/verify_all.sh            # все сьюты (перед закрытием фазы и перед деплоем)
#   bash scripts/verify_all.sh e51 e52    # только перечисленные (во время итераций)
#
# Exit 0 — только если ВСЕ выбранные сьюты зелёные, число тестов не меньше эталона
# и после прогона в рабочем дереве не появилось новых изменений и артефактов.
# Exit 1 — провал gate. Exit 2 — прогон не начат (предусловия).
#
# Эталон (BASELINE) — единственный источник ожидаемого числа тестов. Если тесты
# добавлены, поднять число здесь в том же коммите. Уменьшение = FAIL.

set -u
cd "$(dirname "$0")/.." || exit 2
ROOT=$(pwd)

declare -A BASELINE=( [smoke]=84 [e51]=23 [e52]=41 [hygiene]=19 [trips]=7 [tasks]=66 [tasksui]=296 [tasksmx]=79 [tasksn8n]=27 [taskscal]=220 [director]=101 )
ALL_SUITES=(smoke tasks tasksn8n tasksui tasksmx taskscal director e51 e52 hygiene trips syntax phplint pii)
SUITE_TIMEOUT=600

if [ $# -gt 0 ]; then SUITES=("$@"); else SUITES=("${ALL_SUITES[@]}"); fi
for s in "${SUITES[@]}"; do
  case " ${ALL_SUITES[*]} " in *" $s "*) ;; *) echo "Неизвестный сьют: $s. Доступны: ${ALL_SUITES[*]}"; exit 2;; esac
done

# --- предусловия --------------------------------------------------------------
for bin in php node git timeout; do
  command -v "$bin" >/dev/null || { echo "PRECHECK FAIL: нет $bin"; exit 2; }
done
if ! git diff --quiet -- data/app.db; then
  echo "PRECHECK FAIL: data/app.db изменена и не закоммичена."
  echo "Gate сам выполняет 'git checkout -- data/app.db' и уничтожил бы эти изменения. Разберитесь с файлом и повторите."
  exit 2
fi
STATUS_BEFORE=$(git status --porcelain --untracked-files=all)
LOGDIR=$(mktemp -d "${TMPDIR:-/tmp}/verify_all.XXXXXX")

# --- запуск одного сьюта ------------------------------------------------------
# Каждый сьют заполняет: RES (PASS|FAIL), CNT (сколько прошло, или '-'), NOTE.
restore_db() { git checkout -q -- data/app.db; }

run_suite() {
  local s=$1 log="$LOGDIR/$1.log" rc out p f
  RES=FAIL; CNT='-'; NOTE=''
  case $s in
    smoke)   timeout $SUITE_TIMEOUT php api/smoke_test.php >"$log" 2>&1; rc=$?; restore_db
             out=$(grep -Eo 'RESULTS: [0-9]+ passed, [0-9]+ failed' "$log" | tail -1)
             p=$(echo "$out" | awk '{print $2}'); f=$(echo "$out" | awk '{print $4}')
             CNT=${p:-'-'}
             if [ $rc -eq 0 ] && [ "${f:-x}" = 0 ] && grep -q 'DB intact: YES' "$log"; then RES=PASS; else NOTE="rc=$rc failed=${f:-?}"; fi ;;
    tasks|tasksn8n)   # T1-1 / T1-4: блок «Задачи» (tasksn8n — интеграция с n8n на mock-webhook, без сети) — на временной копии БД (SC_APP_DB), data/app.db не трогает.
             local php_t=api/tasks_test.php; [ "$s" = tasksn8n ] && php_t=api/tasks_n8n_test.php
             timeout $SUITE_TIMEOUT php "$php_t" >"$log" 2>&1; rc=$?
             out=$(grep -Eo 'RESULTS: [0-9]+ passed, [0-9]+ failed' "$log" | tail -1)
             p=$(echo "$out" | awk '{print $2}'); f=$(echo "$out" | awk '{print $4}')
             CNT=${p:-'-'}
             if [ $rc -eq 0 ] && [ "${f:-x}" = 0 ] && grep -q 'DB intact: YES' "$log"; then RES=PASS; else NOTE="rc=$rc failed=${f:-?}"; fi ;;
    e51|e52|hygiene|tasksui|tasksmx|taskscal|director)
             local js; case $s in e51) js=scripts/test_e51_pick_geometry.js;; e52) js=scripts/test_e52_pick_semantics.js;; hygiene) js=scripts/test_r4_hygiene.js;; tasksui) js=scripts/test_tasks_frontend.js;; tasksmx) js=scripts/test_tasks_matrix.js;; taskscal) js=scripts/test_tasks_calendar.js;; director) js=scripts/test_v6_director.js;; esac
             timeout $SUITE_TIMEOUT node "$js" >"$log" 2>&1; rc=$?
             out=$(grep -Eo 'RESULT: [0-9]+ passed, [0-9]+ failed' "$log" | tail -1)
             p=$(echo "$out" | awk '{print $2}'); f=$(echo "$out" | awk '{print $4}')
             CNT=${p:-'-'}
             if [ $rc -eq 0 ] && [ "${f:-x}" = 0 ]; then RES=PASS; else NOTE="rc=$rc failed=${f:-?}"; fi ;;
    trips)   timeout $SUITE_TIMEOUT bash scripts/test_trips_frontend.sh >"$log" 2>&1; rc=$?; restore_db; rm -f test_cookies.jar
             out=$(grep -Eo 'Pass rate: [0-9]+/[0-9]+' "$log" | tail -1)
             CNT=$(echo "$out" | sed -E 's#.* ([0-9]+)/.*#\1#'); CNT=${CNT:-'-'}
             if [ $rc -eq 0 ] && grep -q 'ALL TESTS PASSED' "$log"; then RES=PASS; else NOTE="rc=$rc"; fi
             grep -q 'Skipping' "$log" && NOTE="$NOTE есть SKIP" ;;
    syntax)  timeout $SUITE_TIMEOUT node scripts/check_syntax.js >"$log" 2>&1; rc=$?
             if [ $rc -eq 0 ] && grep -q 'failed: 0' "$log"; then RES=PASS; else NOTE="rc=$rc"; fi ;;
    phplint) : >"$log"; local bad=0 n=0 file
             for file in api/*.php upload.php router.php; do
               [ -f "$file" ] || continue; n=$((n+1))
               php -l "$file" >>"$log" 2>&1 || bad=$((bad+1))
             done
             CNT=$((n-bad)); if [ $bad -eq 0 ]; then RES=PASS; else NOTE="ошибок: $bad из $n"; fi ;;
    pii)     timeout $SUITE_TIMEOUT bash scripts/check_no_pii.sh >"$log" 2>&1; rc=$?
             if [ $rc -eq 0 ]; then RES=PASS; else NOTE="rc=$rc"; fi ;;
  esac
  # проверка эталона
  if [ -n "${BASELINE[$s]:-}" ] && [ "$RES" = PASS ]; then
    if ! [[ "$CNT" =~ ^[0-9]+$ ]]; then RES=FAIL; NOTE="не удалось прочитать число тестов";
    elif [ "$CNT" -lt "${BASELINE[$s]}" ]; then RES=FAIL; NOTE="тестов меньше эталона (${BASELINE[$s]})";
    elif [ "$CNT" -gt "${BASELINE[$s]}" ]; then NOTE="тестов больше эталона — поднять BASELINE"; fi
  fi
}

# --- прогон -------------------------------------------------------------------
echo "verify_all: $(git rev-parse --short HEAD) $(date '+%F %T') suites: ${SUITES[*]}"
FAILED=0; ROWS=()
for s in "${SUITES[@]}"; do
  t0=$(date +%s); run_suite "$s"; dt=$(( $(date +%s) - t0 ))
  exp=${BASELINE[$s]:-'-'}
  ROWS+=("$(printf '%-8s %-4s %6s %6s %5ss  %s' "$s" "$RES" "$CNT" "$exp" "$dt" "$NOTE")")
  [ "$RES" = PASS ] || FAILED=$((FAILED+1))
done

# --- чистое состояние ---------------------------------------------------------
restore_db; rm -f test_cookies.jar
STATUS_AFTER=$(git status --porcelain --untracked-files=all)
CLEAN=PASS; NEW=''
if [ "$STATUS_BEFORE" != "$STATUS_AFTER" ]; then
  CLEAN=FAIL; FAILED=$((FAILED+1))
  NEW=$(diff <(echo "$STATUS_BEFORE") <(echo "$STATUS_AFTER") | grep '^>' | sed 's/^> //')
fi

echo
printf '%-8s %-4s %6s %6s %6s  %s\n' SUITE RES PASSED EXPECT TIME NOTE
printf '%s\n' "${ROWS[@]}"
printf '%-8s %-4s\n' clean "$CLEAN"
[ -n "$NEW" ] && { echo "Новые изменения после прогона:"; echo "$NEW"; }
echo
if [ $FAILED -eq 0 ]; then
  echo "GATE: PASS (${#SUITES[@]} suites)"; rm -rf "$LOGDIR"; exit 0
else
  echo "GATE: FAIL ($FAILED). Логи: $LOGDIR"
  for s in "${SUITES[@]}"; do
    if grep -q "^$s *FAIL" <(printf '%s\n' "${ROWS[@]}"); then echo "--- $s (хвост)"; tail -15 "$LOGDIR/$s.log"; fi
  done
  exit 1
fi
