#!/usr/bin/env bash
# V10-T3: прогоны нагрузочного профиля (ADR_DB.md §3). Одноразовый, в gate не входит. ~20–30 минут, до ~2 ГБ во временном каталоге.
# Из корня репозитория:  bash scripts/spike/v10_t3_run_loadprofile.sh [каталог_вывода]
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
EVD=${1:-reports/V10/T3_evidence}
mkdir -p "$EVD"
L="php scripts/spike/v10_t3_loadprofile.php"
$L --scenario=s1 --years=1,3,5 --out="$EVD/I_load_s1.json" > "$EVD/I_load_s1.txt" 2>&1
$L --scenario=s2 --years=1,3,5 --out="$EVD/I_load_s2.json" > "$EVD/I_load_s2.txt" 2>&1
$L --scenario=s3 --years=1,3   --out="$EVD/I_load_s3.json" > "$EVD/I_load_s3.txt" 2>&1
rm -f "${TMPDIR:-/tmp}"/v10_t3/load_s*.db "${TMPDIR:-/tmp}"/v10_t3/load_s*.db-wal "${TMPDIR:-/tmp}"/v10_t3/load_s*.db-shm
echo "DONE $(date -Is)"
