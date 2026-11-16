#!/usr/bin/env bash
# IE-2_flows_probe.sh — проверка запуском: вызывается ли хук commit-msg при amend/revert/cherry-pick/rebase/squash
# и что требуется от автора. Работает во временном репозитории в $TMPDIR (копии хука), основной репозиторий и
# настоящий Kanban не трогает. Запуск:  bash reports/IDX_ENFORCE/IE-2_flows_probe.sh
# Хук-обёртка пишет в журнал факт вызова и передаёт управление настоящему хуку.
set -u
SRC=$(cd "$(dirname "$0")/../.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/ie2probe.XXXXXX"); trap 'rm -rf "$T"' EXIT
unset GIT_DIR GIT_INDEX_FILE GIT_EDITOR
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@x GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@x HOME=$T/h
mkdir -p "$HOME"; GOOD=t_a1b2c3d4
sqlite3 "$T/k.db" "create table tasks(id text primary key); insert into tasks values('$GOOD');"; export KANBAN_DB=$T/k.db
export HOOKLOG=$T/hook.calls
n=0
fresh() {  # свежий репозиторий; коммит base создан без хука (--no-verify)
  n=$((n+1)); cd "$T" && rm -rf "r$n" && mkdir "r$n" && cd "r$n" && git init -q -b main . || exit 2
  mkdir -p scripts/hooks js
  cp "$SRC/scripts/hooks/commit-msg" scripts/hooks/commit-msg.real; cp "$SRC/scripts/lib_commit_tasks.sh" "$SRC/scripts/check_commit_tasks.sh" scripts/
  printf '#!/bin/sh\necho "$(head -1 "$1")" >> "$HOOKLOG"\nexec "$(dirname "$0")/commit-msg.real" "$@"\n' > scripts/hooks/commit-msg
  chmod +x scripts/hooks/*; git config core.hooksPath scripts/hooks
  echo a > js/a.js; echo b > js/b.js; echo c > js/c.js; git add -A; git commit -q --no-verify -m base
}
c() { git add -A; git commit -q "$@" >/dev/null 2>&1; }          # подготовка сценария (с хуком, id есть)
cn() { git add -A; git commit -q --no-verify "$@" >/dev/null 2>&1; }   # подготовка: обход хука
# P <команда> — выполнить проверяемую команду, показать её вывод (первые строки), код выхода и число вызовов хука
P() {
  : > "$HOOKLOG"; local out rc
  out=$("$@" 2>&1); rc=$?
  printf '%s\n' "$out" | tr '\r' '\n' | grep -v '^\s*$' | head -${LINES_MAX:-6} | cut -c1-170 | sed 's/^/   | /'
  echo "   => команда: ${*:1:3}…  exit=$rc; хук вызван раз: $(wc -l < "$HOOKLOG"); HEAD: $(git log -1 --format=%s 2>/dev/null)"
}
ed() { printf 'sh -c '"'"'echo "%s" > "$1"'"'"' sh' "$1"; }    # редактор, подставляющий сообщение

echo "##### A. git revert — коммит с id в теме"
fresh; echo 1 >> js/b.js; c -m "main change ($GOOD)"
P git revert --no-edit HEAD
echo "##### A2. git revert — коммит без id (создан --no-verify), затем revert --edit с сообщением без id"
fresh; echo 1 >> js/b.js; cn -m "обход без id"
P git revert --no-edit HEAD
git reset -q --hard HEAD~1
GIT_EDITOR="$(ed 'revert без id')" P git revert -e HEAD
echo "##### B. git cherry-pick — сообщение копируется вместе с id"
fresh; git checkout -q -b side; echo 1 >> js/a.js; c -m "side ($GOOD)"; S=$(git rev-parse HEAD); git checkout -q main
P git cherry-pick "$S"
echo "##### B2. cherry-pick коммита без id (создан --no-verify)"
fresh; git checkout -q -b side; echo 1 >> js/a.js; cn -m "side без id"; S=$(git rev-parse HEAD); git checkout -q main
P git cherry-pick "$S"
echo "##### B3. cherry-pick --edit, редактор подставляет сообщение без id"
fresh; git checkout -q -b side; echo 1 >> js/a.js; c -m "side ($GOOD)"; S=$(git rev-parse HEAD); git checkout -q main
GIT_EDITOR="$(ed 'cherry-pick без id')" P git cherry-pick -e "$S"
echo "##### C. git commit --amend: новое сообщение без id; затем --no-edit (id сохранён)"
fresh; echo 1 >> js/a.js; c -m "code ($GOOD)"
LINES_MAX=2 P git commit --amend -m "amend без id"
P git commit --amend --no-edit
echo "##### D. git rebase main (обычный): переносимые коммиты, в т.ч. без id (создан --no-verify)"
fresh; git checkout -q -b topic; echo 1 >> js/a.js; c -m "t1 ($GOOD)"; echo 2 >> js/c.js; cn -m "t2 без id (--no-verify)"
git checkout -q main; echo 1 >> js/b.js; c -m "main ($GOOD)"; git checkout -q topic
P git rebase main
echo "##### D2. rebase -i: reword с сообщением без id"
fresh; git checkout -q -b topic; echo 1 >> js/a.js; c -m "r1 ($GOOD)"; echo 2 >> js/c.js; c -m "r2 ($GOOD)"
GIT_SEQUENCE_EDITOR="sed -i '1s/^pick/reword/'" GIT_EDITOR="$(ed 'reword без id')" LINES_MAX=3 P git rebase -i main
git rebase --abort >/dev/null 2>&1
echo "##### D3. rebase -i: остановка edit + git commit --amend без id"
fresh; git checkout -q -b topic; echo 1 >> js/a.js; c -m "e1 ($GOOD)"
GIT_SEQUENCE_EDITOR="sed -i '1s/^pick/edit/'" git rebase -i main >/dev/null 2>&1
LINES_MAX=2 P git commit --amend -m "amend в rebase без id"
git rebase --abort >/dev/null 2>&1
echo "##### D4. rebase -i: squash, объединённое сообщение без id"
fresh; git checkout -q -b topic; echo 1 >> js/a.js; c -m "s1 ($GOOD)"; echo 2 >> js/c.js; c -m "s2 ($GOOD)"
GIT_SEQUENCE_EDITOR="sed -i '2s/^pick/squash/'" GIT_EDITOR="$(ed 'squash без id')" P git rebase -i main
echo "##### E. git merge --squash + git commit без id"
fresh; git checkout -q -b side; echo 1 >> js/a.js; c -m "side ($GOOD)"; git checkout -q main; echo 1 >> js/b.js; c -m "main ($GOOD)"
git merge --squash side >/dev/null 2>&1
LINES_MAX=2 P git commit -m "squash-merge без id"
echo "##### F. Gate ловит то, что хук пропустил (revert без id / cherry-pick без id / squash без id)"
fresh; B=$(git rev-parse HEAD); echo 1 >> js/b.js; cn -m "обход без id"
git revert --no-edit HEAD >/dev/null 2>&1
LINES_MAX=12 P bash scripts/check_commit_tasks.sh "$B..HEAD"
