#!/usr/bin/env bash
# V10-T3: сколько занимает реальный api/save.php (полное сохранение графика) на копии БД.
# Нужно, чтобы оценить «длинного писателя», делящего файл БД с модулем Транспорт. Одноразовый, в gate не входит.
# Использование (из корня репозитория):  bash scripts/spike/v10_t3_savephp_timing.sh [src_db] [port]
# data/app.db НЕ меняется: работаем на копии через SC_APP_DB; sha1 источника печатается до и после.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SRC=${1:-$ROOT/data/app.db}
PORT=${2:-8123}
T=${TMPDIR:-/tmp}/v10_t3_save
rm -rf "$T"; mkdir -p "$T"
echo "# $(php -v | head -1)   src sha1 before: $(sha1sum "$SRC" | cut -d' ' -f1)"
cp "$SRC" "$T/app.db"
SC_APP_DB="$T/app.db" php -S 127.0.0.1:$PORT "$ROOT/router.php" >"$T/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$PORT/api/session.php" && break; sleep 0.1; done
JAR="$T/jar"
curl -s -c "$JAR" -H 'Content-Type: application/json' -d '{"username":"admin","password":"changeme"}' \
  "http://127.0.0.1:$PORT/api/login.php" >/dev/null
curl -s -b "$JAR" -o "$T/load.json" "http://127.0.0.1:$PORT/api/load.php"
printf '%-12s %-12s %-10s %-s\n' employees entries payload_KB "save.php, мс (5 прогонов, p50 / max)"
for cfg in "4 1" "50 30" "50 365" "150 365"; do
  set -- $cfg
  php "$ROOT/scripts/spike/v10_t3_savephp_payload.php" "$T/load.json" "$1" "$2" > "$T/payload.json"
  KB=$(( $(stat -c %s "$T/payload.json") / 1024 ))
  ts=()
  for r in 1 2 3 4 5; do
    t=$(curl -s -b "$JAR" -o "$T/resp.json" -w '%{time_total}' -H 'Content-Type: application/json' \
        --data-binary @"$T/payload.json" "http://127.0.0.1:$PORT/api/save.php")
    ok=$(grep -c '"success": *true' "$T/resp.json" || true)
    [ "$ok" = "1" ] || { echo "save.php FAIL: $(head -c 200 "$T/resp.json")"; exit 1; }
    ts+=("$t")
  done
  sorted=($(printf '%s\n' "${ts[@]}" | sort -n))
  printf '%-12s %-12s %-10s %s / %s\n' "$1" "$(( $1 * $2 ))" "$KB" \
    "$(awk -v x="${sorted[2]}" 'BEGIN{printf "%.0f", x*1000}')" "$(awk -v x="${sorted[4]}" 'BEGIN{printf "%.0f", x*1000}')"
done
echo "# src sha1 after:  $(sha1sum "$SRC" | cut -d' ' -f1)"
