#!/usr/bin/env bash
# test_commit_msg_hook.sh — самотесты IE-2: хук scripts/hooks/commit-msg и scripts/check_commit_tasks.sh.
#
#   bash scripts/test_commit_msg_hook.sh          # итог: RESULT: N passed, M failed
#
# Работает ТОЛЬКО во временном репозитории в $TMPDIR (копии хука и библиотеки) с фикстурой Kanban-БД
# (KANBAN_DB). Основной репозиторий, его git-конфиг и настоящий Kanban не используются; за собой убирает.
set -u
SRC=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/ie2test.XXXXXX") || exit 2
trap 'rm -rf "$T"' EXIT

# Изоляция от окружения (в т.ч. если запущено из git-хука) и от глобального/системного git-конфига.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_EDITOR GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL KANBAN_SQLITE3
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export HOME="$T/home"; mkdir -p "$HOME"   # дефолтный $HOME/.hermes/kanban.db в тестах не существует и не читается

GOOD=t_a1b2c3d4      # есть в фикстуре
GOOD2=t_0f0f0f0f     # есть в фикстуре
NOSUCH=t_deadbeef    # правильный формат, в фикстуре нет
FIX="$T/kanban_fixture.db"
sqlite3 "$FIX" "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT); INSERT INTO tasks VALUES ('$GOOD','fixture 1'),('$GOOD2','fixture 2');" || { echo "нет sqlite3 для фикстуры"; exit 2; }
export KANBAN_DB="$FIX"

PASS=0; FAILN=0
OUT=''; RC=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAILN=$((FAILN+1)); printf 'FAIL  %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1  [условие: $2]"; [ -n "$OUT" ] && printf '%s\n' "$OUT" | sed 's/^/      | /'; fi; }
show() { printf '%s\n' "$OUT" | head -${1:-8} | sed 's/^/      | /'; }   # вывод хука в лог

R=''; N=0
# fresh — новый временной репозиторий с хуком, начальный коммит без хука (включаем hooksPath после него).
fresh() {
  N=$((N+1)); R="$T/r$N"; mkdir -p "$R/scripts/hooks" && cd "$R" || exit 2
  git init -q -b main . && git config core.autocrlf false
  cp "$SRC/scripts/hooks/commit-msg" scripts/hooks/commit-msg
  cp "$SRC/scripts/lib_commit_tasks.sh" scripts/lib_commit_tasks.sh
  cp "$SRC/scripts/check_commit_tasks.sh" scripts/check_commit_tasks.sh
  chmod +x scripts/hooks/commit-msg scripts/check_commit_tasks.sh
  mkdir -p js api reports
  echo 'a' > js/x.js; echo 'a' > api/x.php; echo '# a' > reports/x.md
  git add -A && git commit -q --no-verify -m "base" || exit 2
  git config core.hooksPath scripts/hooks
}
head_sha() { git rev-parse HEAD 2>/dev/null; }
# try <git commit args...> — выполняет git commit; OUT = stdout+stderr, RC = код выхода, MADE=1 если HEAD сдвинулся.
try() { local h0; h0=$(head_sha); OUT=$(git "$@" 2>&1); RC=$?; MADE=0; [ "$(head_sha)" != "$h0" ] && MADE=1; }
chg() { echo "$RANDOM$RANDOM" >> "$1"; git add "$1"; }

echo "== 1. js/x.js изменён, id в сообщении нет -> отказ"
fresh; chg js/x.js; try commit -m "fix: без id"
show; check "1: отказ, exit != 0, коммит не создан" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
check "1: сообщение русское, с файлом кода, примером и запретом --no-verify" 'grep -q "ОТКЛОНЕНО" <<<"$OUT" && grep -q "js/x.js" <<<"$OUT" && grep -q "Пример" <<<"$OUT" && grep -q -- "--no-verify" <<<"$OUT"'

echo "== 2. js/x.js, id правильного формата, но задачи нет в БД -> отказ"
fresh; chg js/x.js; try commit -m "fix ($NOSUCH): задачи нет"
show; check "2: отказ, коммит не создан" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
check "2: в сообщении названо id, которого нет" 'grep -q "$NOSUCH" <<<"$OUT" && grep -q "не найден" <<<"$OUT"'

echo "== 3. js/x.js, id существует -> коммит создан"
fresh; chg js/x.js; try commit -m "fix ($GOOD): есть задача"
show 3; check "3: коммит создан, exit 0" '[ $RC -eq 0 ] && [ $MADE = 1 ]'

echo "== 4. только reports/x.md, id нет -> коммит создан"
fresh; chg reports/x.md; try commit -m "docs: без id"
show 3; check "4: коммит создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'

echo "== 5. api/x.php + reports/x.md, id нет -> отказ"
fresh; chg api/x.php; chg reports/x.md; try commit -m "api + docs без id"
show; check "5: отказ" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
check "5: в списке только файл кода (api/x.php), документ не назван кодом" 'grep -q "  - api/x.php" <<<"$OUT" && ! grep -q "  - reports/x.md" <<<"$OUT"'

echo "== 6. merge-коммит без id -> создан"
fresh; git checkout -q -b feat; echo 'f' > js/f.js; git add js/f.js; git commit -q -m "feat ($GOOD): f"
git checkout -q main; echo 'm' > js/m.js; git add js/m.js; git commit -q -m "main ($GOOD): m"
try merge --no-ff -m "Merge feat без id" feat
show 3; check "6: merge-коммит создан без id (2 родителя)" '[ $RC -eq 0 ] && [ $MADE = 1 ] && [ "$(git rev-list --parents -n1 HEAD | wc -w)" = 3 ]'

echo "== 7. KANBAN_DB указывает на несуществующий файл"
fresh; chg js/x.js; KANBAN_DB="$T/нет_такого.db" try commit -m "fix ($GOOD): БД недоступна"
show 3; check "7a: id правильного формата -> коммит создан, в выводе предупреждение" '[ $RC -eq 0 ] && [ $MADE = 1 ] && grep -q "ПРЕДУПРЕЖДЕНИЕ" <<<"$OUT"'
fresh; chg js/x.js; KANBAN_DB="$T/нет_такого.db" try commit -m "fix: БД недоступна и без id"
show 4; check "7b: без id -> отказ" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
fresh; chg js/x.js; KANBAN_DB="$T/нет_такого.db" try commit -m "fix ($NOSUCH): формат верен"
check "7c: БД недоступна, существование не проверяется -> создан (по спецификации)" '[ $RC -eq 0 ] && [ $MADE = 1 ]'
fresh; chg js/x.js; KANBAN_SQLITE3=no_such_sqlite3_binary try commit -m "fix ($GOOD): sqlite3 недоступен"
show 3; check "7d: sqlite3 недоступен -> создан, предупреждение" '[ $RC -eq 0 ] && [ $MADE = 1 ] && grep -q "ПРЕДУПРЕЖДЕНИЕ" <<<"$OUT"'
echo 'not a database' > "$T/corrupt.db"
fresh; chg js/x.js; KANBAN_DB="$T/corrupt.db" try commit -m "fix ($GOOD): БД повреждена"
check "7e: БД не читается как SQLite -> создан, предупреждение" '[ $RC -eq 0 ] && [ $MADE = 1 ] && grep -q "ПРЕДУПРЕЖДЕНИЕ" <<<"$OUT"'

echo "== 8. строка-комментарий '# t_...' не считается id"
fresh; chg js/x.js; try commit -m "$(printf 'fix без id\n\n# %s' "$GOOD")"
check "8a: -m с комментарием '# $GOOD' -> отказ" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
fresh; chg js/x.js
cat > "$T/editor.sh" <<EOS
#!/bin/sh
# имитация редактора: оставляет шаблон (его строки-комментарии) и дописывает тему без id
{ printf 'fix через редактор\n'; cat "\$1"; printf '# %s\n' "$GOOD"; } > "\$1.new" && mv "\$1.new" "\$1"
EOS
chmod +x "$T/editor.sh"
GIT_EDITOR="$T/editor.sh" try commit
show 4; check "8b: комментарий в шаблоне сообщения (через редактор) -> отказ" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
fresh; chg js/x.js; GIT_EDITOR="$T/editor.sh" try commit -m "fix ($GOOD): id в теме + комментарий"
check "8c: id в теме + комментарий-шаблон -> создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'
. "$SRC/scripts/lib_commit_tasks.sh"
msg=$(printf 'fix\n\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n+ %s\n' "$GOOD")
check "8d: id после ножниц (дифф git commit -v) не считается" '[ -z "$(printf "%s" "$msg" | ct_message_ids)" ]'

echo "== 9. check_commit_tasks.sh: диапазон с кодом без id (--no-verify)"
fresh; B=$(head_sha)
chg js/x.js; git commit -q --no-verify -m "обход хука: код без id"; BAD=$(git rev-parse --short=7 HEAD)
OUT=$(bash scripts/check_commit_tasks.sh "$B..HEAD" 2>&1); RC=$?; show 6
check "9a: exit 1 и sha нарушителя в выводе" '[ $RC -eq 1 ] && grep -q "$BAD" <<<"$OUT" && grep -q "js/x.js" <<<"$OUT"'
fresh; B=$(head_sha)
chg js/x.js; git commit -q -m "ok ($GOOD): код"; chg reports/x.md; git commit -q -m "docs без id"
OUT=$(bash scripts/check_commit_tasks.sh "$B..HEAD" 2>&1); RC=$?; show 3
check "9b: диапазон без нарушений -> exit 0" '[ $RC -eq 0 ] && grep -q "^PASS" <<<"$OUT"'
OUT=$(bash scripts/check_commit_tasks.sh "HEAD..HEAD" 2>&1); RC=$?
check "9c: пустой диапазон -> exit 0" '[ $RC -eq 0 ] && grep -q "checked=0" <<<"$OUT"'
OUT=$(bash scripts/check_commit_tasks.sh "нет_такого..HEAD" 2>&1); RC=$?
check "9d: нечитаемый диапазон -> exit 2" '[ $RC -eq 2 ]'
fresh; B=$(head_sha); chg js/x.js; git commit -q --no-verify -m "обход ($NOSUCH): id несуществующий"; BAD=$(git rev-parse --short=7 HEAD)
OUT=$(bash scripts/check_commit_tasks.sh "$B..HEAD" 2>&1); RC=$?
check "9e: id правильного формата, но задачи нет -> exit 1" '[ $RC -eq 1 ] && grep -q "$BAD" <<<"$OUT" && grep -q "не найден" <<<"$OUT"'
OUT=$(KANBAN_DB="$T/нет_такого.db" bash scripts/check_commit_tasks.sh "$B..HEAD" 2>&1); RC=$?
check "9f: БД недоступна, id формата верен -> exit 0 с предупреждением" '[ $RC -eq 0 ] && grep -q "ПРЕДУПРЕЖДЕНИЕ" <<<"$OUT"'
fresh; B=$(head_sha); git checkout -q -b feat; chg js/x.js; git commit -q -m "feat ($GOOD)"; git checkout -q main; chg api/x.php; git commit -q -m "main ($GOOD)"
git merge -q --no-ff -m "Merge без id" feat
OUT=$(bash scripts/check_commit_tasks.sh "$B..HEAD" 2>&1); RC=$?
check "9g: merge-коммит без id не считается нарушением" '[ $RC -eq 0 ] && grep -q "checked=2" <<<"$OUT"'

echo "== 10. связанный worktree"
fresh; git worktree add -q "$T/wt$N" -b wtbranch 2>&1 | head -2; cd "$T/wt$N" || exit 2
chg js/x.js; try commit -m "worktree без id"
show 4; check "10a: worktree, код без id -> отказ" '[ $RC -ne 0 ] && [ $MADE = 0 ] && grep -q "ОТКЛОНЕНО" <<<"$OUT"'
try commit -m "worktree ($GOOD)"
check "10b: worktree, код с id -> создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'
chg reports/x.md; try commit -m "worktree docs"
check "10c: worktree, документ без id -> создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'
cd "$R" && git worktree remove --force "$T/wt$N" 2>/dev/null

echo "== дополнительные случаи"
fresh; echo 'zz' >> js/x.js; try commit -a -m "commit -a без id"
check "11a: commit -a (изменён js/x.js, не в индексе) без id -> отказ" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
fresh; echo 'zz' >> js/x.js; try commit -a -m "commit -a ($GOOD)"
check "11b: commit -a с id -> создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'
fresh; echo 'zz' >> js/x.js; echo 'dd' >> reports/x.md; git add reports/x.md; try commit -m "только документ в индексе" reports/x.md
check "11c: commit <path> документа при изменённом js в рабочем дереве -> создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'
fresh; git mv js/x.js reports/x.md.moved 2>/dev/null; try commit -m "переименование кода в reports без id"
check "12a: переименование js/x.js -> reports/... без id -> отказ (старый путь — код)" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
fresh; git rm -q js/x.js; try commit -m "удаление кода без id"
check "12b: удаление файла кода без id -> отказ" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
fresh; chg js/x.js; try commit -m "at_a1b2c3d4 и T_a1b2c3d4 и t_a1b2c3d45 и t_a1b2c3"
check "13: подстроки/регистр/9 hex/6 hex не считаются id" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
fresh; chg js/x.js; try commit -m "fix: $NOSUCH,$GOOD2; см. также ($GOOD)"
check "14: несколько id, часть существует -> создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'
fresh; echo 'q' > "scripts/with space.sh"; echo 'n' > n8n_x.json; mkdir -p n8n static; echo 'w' > n8n/w.json; echo r > router.php; echo h > .htaccess
git add -A; try commit -m "прочие пути кода без id"
check "15: scripts/, n8n/, router.php, .htaccess — это код -> отказ" '[ $RC -ne 0 ] && grep -q "scripts/with space.sh" <<<"$OUT" && grep -q "router.php" <<<"$OUT" && grep -q ".htaccess" <<<"$OUT"'
fresh; mkdir -p staff_project/a x/y; echo 's' > "staff_project/а б.xlsx"; echo 'd' > x/y/README.md; echo 'r' > reports/z.py; git add -A; try commit -m "документы: staff_project, любой *.md, reports/** без id"
check "16: staff_project/**, любой *.md, reports/** — документы -> создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'
# root-коммит (в репозитории ещё нет HEAD)
N=$((N+1)); R="$T/r$N"; mkdir -p "$R/scripts/hooks" && cd "$R" && git init -q -b main . && cp "$SRC/scripts/hooks/commit-msg" scripts/hooks/ && cp "$SRC/scripts/lib_commit_tasks.sh" scripts/ && git config core.hooksPath scripts/hooks
echo a > a.js; git add a.js; try commit -m "root без id"
check "17a: первый коммит репозитория с кодом без id -> отказ" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
try commit -m "root ($GOOD)"
check "17b: первый коммит с id -> создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'

echo "== git commit --amend"
fresh; chg js/x.js; git commit -q -m "code ($GOOD)"
chg reports/x.md; try commit --amend -m "amend: убрали id"
show 3; check "18a: --amend кода (docs добавлены в индекс), новое сообщение без id -> отказ" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
try commit --amend -m "amend ($GOOD): с id"
check "18b: --amend с id -> создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'
fresh; chg reports/x.md; git commit -q -m "docs"; chg js/x.js; try commit --amend --no-edit
check "18c: --amend --no-edit докидывает код в docs-коммит без id -> отказ" '[ $RC -ne 0 ] && [ $MADE = 0 ]'
fresh; chg js/x.js; git commit -q -m "code ($GOOD)"; chg reports/x.md; try commit --amend --no-edit
check "18d: --amend --no-edit коммита с id (добавлен документ) -> создан" '[ $RC -eq 0 ] && [ $MADE = 1 ]'

echo
echo "RESULT: $PASS passed, $FAILN failed"
[ $FAILN -eq 0 ]
