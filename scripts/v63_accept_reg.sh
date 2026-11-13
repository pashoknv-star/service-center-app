#!/usr/bin/env bash
# V6.3-3 (приёмка, вне gate): регрессионный прогон ранее написанных приёмочных harness-скриптов V6.2/V6 на слитом main.
# Копии скриптов создаются во временной папке с подменой каталога скриншотов (reports/V6_3/V6.3-3_screens/regress/…),
# чтобы НЕ перезаписывать артефакты прошлых приёмок. Исходные скрипты не меняются.
# Запуск: bash scripts/v63_accept_reg.sh [v62a v62b v62c1 v62c2 v62d v62e v62f v6a v6b v6c v65 v66]  → итог по каждому harness.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCR="$ROOT/scripts"
OUTD="$ROOT/reports/V6_3/V6.3-3_screens/regress"
TMP="${TMPDIR:-/tmp}/v63_reg_$$"; mkdir -p "$TMP" "$OUTD"
ALL="v62a v62b v62c1 v62c2 v62d v62e v62f v6a v6b v6c v65 v66"
WANT="${*:-$ALL}"
declare -A SRC=( [v62a]=v62_accept_a_list_tags.js [v62b]=v62_accept_b_calendar.js [v62c1]=v62_accept_c1_v6_tasks.js [v62c2]=v62_accept_c2_t1_roles.js
  [v62d]=v62_accept_d_matrix_board.js [v62e]=v62_accept_e_edges.js [v62f]=v62_accept_f_reject.js
  [v6a]=v6_accept_a_director.js [v6b]=v6_accept_b_tasks.js [v6c]=v6_accept_c_regress.js [v65]=v6_accept_v65.js [v66]=v6_accept_v66.js )
for k in $WANT; do
  f="${SRC[$k]}"; [ -z "$f" ] && { echo "неизвестный harness $k"; continue; }
  d="$OUTD/$k"; mkdir -p "$d"
  # абсолютные require и каталог артефактов — в regress/<k>
  sed -e "s#require('\./#require('$SCR/#g" \
      -e "s#path.join(L.ROOT, 'reports/[A-Za-z0-9_./-]*')#'$d'#g" \
      -e "s#path.join(__dirname, '\.\./reports/[A-Za-z0-9_./-]*')#'$d'#g" "$SCR/$f" > "$TMP/$k.js"
  # v62-lib: каталог артефактов — через копию lib
  sed -e "s#reports/V6_2/V6.2-3_screens#reports/V6_3/V6.3-3_screens/regress/$k#" -e "s#require('\./#require('$SCR/#g" "$SCR/v62_accept_lib.js" > "$TMP/v62_accept_lib.js"
  sed -i "s#$SCR/v62_accept_lib.js#$TMP/v62_accept_lib.js#" "$TMP/$k.js"
  if [ "$k" = v62b ]; then   # сценарий W-6 «Вставить = копия-задача» заменён V6.3-2 (вставка = повтор): его падение не должно скрывать остальные проверки (R-10/R-11, роли, 375)
    sed -i -e '185s/^/try { /' -e '314a\    } catch (e) { console.log("W-6/СТЫК (сценарий V6.2 устарел после V6.3-2, вставка = повтор): " + e.message); cdp.exceptions.length = 0; C.failed = C.failed; }' "$TMP/$k.js"
  fi
  echo "=== $k ($f) → $d"
  ( cd "$ROOT" && timeout 1500 node "$TMP/$k.js" > "$d/run.log" 2>&1; echo "exit=$?" >> "$d/run.log" )
  grep -E "FAIL|passed|failed|ИТОГ|RESULT|ОШИБКА|exit=" "$d/run.log" | cut -c1-260 | tail -25
done
rm -rf "$TMP"
