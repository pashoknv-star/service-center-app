#!/usr/bin/env bash
# V10-T4 SPIKE: одноразовый зонд публичных сервисов карты.
# Правила: только публичные запросы по названиям населённых пунктов и координатам;
# не чаще 1 запроса в секунду (пауза 1.2 с); явный User-Agent проекта;
# общий бюджет — не более 50 запросов (счётчик в T4_evidence/request_log.tsv).
# Использование: v10_t4_probe.sh <имя_файла_ответа> <URL>
# Ответ (тело) -> reports/V10/T4_evidence/<имя_файла_ответа>; строка журнала -> request_log.tsv.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EV="$ROOT/reports/V10/T4_evidence"
LOG="$EV/request_log.tsv"
UA='ServiceCenterApp-V10-T4-spike/0.1 (internal feasibility study of a staff-scheduling app; no personal data; contact: project owner)'
BUDGET=50
mkdir -p "$EV"
[ -f "$LOG" ] || printf 'n\tutc\thttp_code\ttime_s\tsaved_as\turl\n' > "$LOG"
n=$(($(wc -l < "$LOG") - 1))
if [ "$n" -ge "$BUDGET" ]; then echo "BUDGET EXHAUSTED ($n/$BUDGET)" >&2; exit 3; fi
name="$1"; url="$2"
sleep 1.2
out="$EV/$name"
meta=$(curl -sS -m 25 -A "$UA" -H 'Accept-Language: ru' -D "$out.headers" -o "$out" \
        -w '%{http_code}\t%{time_total}' "$url") || meta="000\t0"
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$((n+1))" "$(date -u +%FT%TZ)" "$(printf '%b' "$meta" | cut -f1)" \
  "$(printf '%b' "$meta" | cut -f2)" "$name" "$url" >> "$LOG"
printf 'req %s/%s -> %s\n' "$((n+1))" "$BUDGET" "$(printf '%b' "$meta")"
