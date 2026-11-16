#!/usr/bin/env bash
# check_commit_tasks.sh [<диапазон>] — IE-2: правило «коммит с кодом — только с id Kanban-задачи»
# для каждого не-merge коммита диапазона (по умолчанию origin/main..HEAD). Ловит обход `--no-verify`.
# Exit 0 — нарушений нет (пустой диапазон — тоже PASS); 1 — есть нарушители; 2 — диапазон не разобран.
set -u
cd "$(dirname "$0")/.." || exit 2
# shellcheck source=lib_commit_tasks.sh
. scripts/lib_commit_tasks.sh
RANGE=${1:-origin/main..HEAD}

if ! SHAS=$(git rev-list --no-merges --reverse "$RANGE" -- 2>&1); then
  echo "check_commit_tasks: не удалось разобрать диапазон '$RANGE': $SHAS" >&2
  exit 2
fi
ct_init_db
[ "$CT_DB_OK" = 1 ] || echo "ПРЕДУПРЕЖДЕНИЕ: БД Kanban недоступна (${CT_DB_REASON}); проверяется только формат id." >&2

checked=0; withcode=0; bad=0
for sha in $SHAS; do
  checked=$((checked+1))
  CODE=$(git diff-tree -r --root --no-commit-id --name-only --no-renames -z "$sha" | ct_code_files)
  [ -n "$CODE" ] || continue
  withcode=$((withcode+1))
  msg=$(git log -1 --format=%B "$sha")
  ct_check_message - <<<"$msg"   # не через пайп: переменные CT_* нужны в этом шелле
  case $CT_VERDICT in
    ok) continue ;;
    unverified) continue ;;   # формат верен, но БД недоступна: не нарушение (как в хуке), предупреждение выше
  esac
  bad=$((bad+1))
  case $CT_VERDICT in
    noid)    why="в сообщении нет id Kanban-задачи" ;;
    missing) why="id ${CT_IDS//$'\n'/, } не найден в Kanban" ;;
  esac
  echo "НАРУШЕНИЕ: $(git rev-parse --short=7 "$sha") $(git log -1 --format=%s "$sha") — $why"
  printf '%s\n' "$CODE" | head -20 | sed 's/^/    код: /'
  n=$(printf '%s\n' "$CODE" | wc -l); [ "$n" -gt 20 ] && echo "    код: … и ещё $((n-20))"
done

echo "TASKLINK_SUMMARY range=$RANGE checked=$checked withcode=$withcode violations=$bad dbok=$CT_DB_OK"
if [ $bad -gt 0 ]; then
  echo "FAIL: $bad коммит(ов) с кодом без id существующей Kanban-задачи."
  echo "Что делать: коммит в ещё не отправленной истории переписать (--amend / rebase -i reword) с id задачи, БЕЗ --no-verify;"
  echo "если задачи нет — сначала попросить координатора её создать."
  exit 1
fi
echo "PASS: коммитов в диапазоне $checked, с кодом $withcode, нарушений 0"
exit 0
