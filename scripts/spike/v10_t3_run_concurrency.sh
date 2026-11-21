#!/usr/bin/env bash
# V10-T3: полный набор замеров параллельной записи (все прогоны из ADR_DB.md §2). Одноразовый, в gate не входит.
# Из корня репозитория:  bash scripts/spike/v10_t3_run_concurrency.sh [каталог_вывода]
# Всё идёт на КОПИЯХ data/app.db (во временном каталоге); sha1 источника печатается до и после.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
EVD=${1:-reports/V10/T3_evidence}
mkdir -p "$EVD"
S="php scripts/spike/v10_t3_concurrency.php"

{
  echo "== date: $(date -Is)   git: $(git rev-parse --short HEAD)"
  php -v | head -1
  echo "sqlite_version: $($S probe | sed -n 2p)"
  echo "nproc: $(nproc)   $(grep -m1 'model name' /proc/cpuinfo)"
  echo "uname: $(uname -srm)"
  echo "tmp fs: $(df -T "${TMPDIR:-/tmp}" | tail -1)"
  echo "data/app.db sha1 (до): $(sha1sum data/app.db | cut -d' ' -f1)   bytes: $(stat -c %s data/app.db)"
} > "$EVD/env.txt" 2>&1
$S probe > "$EVD/probe.txt" 2>&1

echo ">> A: основной матрикс (proc, work 3 мс, без повторов)"
$S matrix --writers=1,2,4,8 --modes=wal,delete --tx=none,deferred,immediate --ops=150 --work-ms=3 \
   --out="$EVD/A_main.json" > "$EVD/A_main.txt" 2>&1
echo ">> B: те же, но 3 повтора после BUSY (deferred/immediate)"
$S matrix --writers=1,2,4,8 --modes=wal,delete --tx=deferred,immediate --ops=150 --work-ms=3 --retries=3 \
   --out="$EVD/B_retries3.json" > "$EVD/B_retries3.txt" 2>&1
echo ">> C: через php -S + PHP_CLI_SERVER_WORKERS (http)"
$S matrix --transport=http --writers=1,4,8 --modes=wal,delete --tx=none,deferred,immediate --ops=100 --work-ms=3 \
   --out="$EVD/C_http.json" > "$EVD/C_http.txt" 2>&1
echo ">> D: тяжёлая транзакция (work 25 мс ~ много проверок T5)"
$S matrix --writers=1,2,4,8 --modes=wal,delete --tx=immediate --ops=60 --work-ms=25 \
   --out="$EVD/D_work25.json" > "$EVD/D_work25.txt" 2>&1
echo ">> E: фоновый «save.php»: держит блокировку записи 1300 мс каждые ~1 с"
$S matrix --writers=1,4,8 --modes=wal,delete --tx=deferred,immediate --ops=40 --work-ms=3 --bg-hold-ms=1300 --bg-period-ms=1000 \
   --out="$EVD/E_bg_save.json" > "$EVD/E_bg_save.txt" 2>&1
echo ">> F: ловушка fetchColumn() без closeCursor()"
$S matrix --writers=1,4 --modes=wal,delete --tx=none,immediate --ops=100 --work-ms=3 --no-close-cursor=1 \
   --out="$EVD/F_no_close_cursor.json" > "$EVD/F_no_close_cursor.txt" 2>&1
echo ">> G: время реального api/save.php"
bash scripts/spike/v10_t3_savephp_timing.sh data/app.db 8131 > "$EVD/G_savephp_timing.txt" 2>&1
echo "data/app.db sha1 (после): $(sha1sum data/app.db | cut -d' ' -f1)" >> "$EVD/env.txt"
echo "DONE $(date -Is)"
