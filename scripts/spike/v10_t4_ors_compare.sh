#!/usr/bin/env bash
# V10-T4: сравнение OpenRouteService (driving-car) с OSRM на тех же парах. НЕ ЗАПУСКАЛОСЬ в T4: нужен ключ ORS,
# а ключей у исполнителя нет (ключ выдаёт владелец; регистрация бесплатна — https://account.heigit.org/).
# Запуск владельцем/следующим исполнителем:   ORS_KEY='<ключ>' bash scripts/spike/v10_t4_ors_compare.sh
# Ключ берётся ТОЛЬКО из окружения, в файлы/журнал не пишется. Уходят только координаты центров населённых пунктов.
# Бюджет: 5 запросов (лимит Standard: 2000 directions/сутки, 40/мин); пауза 1.2 с; User-Agent проекта.
set -eu
: "${ORS_KEY:?задайте ORS_KEY в окружении}"
UA='ServiceCenterApp-V10-T4-spike/0.1 (internal feasibility study; no personal data; contact: project owner)'
OUT="$(cd "$(dirname "$0")/../.." && pwd)/reports/V10/T4_evidence"
PAIRS=(
  "uray_mezhd:64.80362,60.12912:65.90851,59.59248"
  "uray_sovetsky:64.80362,60.12912:63.56218,61.35802"
  "uray_kondinskoe:64.80362,60.12912:67.41181,59.65179"
  "mezhd_kondinskoe:65.90851,59.59248:67.41181,59.65179"
  "uray_khm:64.80362,60.12912:69.01896,61.00352"
)
for p in "${PAIRS[@]}"; do
  IFS=: read -r name a b <<<"$p"
  sleep 1.2
  code=$(curl -sS -m 25 -A "$UA" -H "Authorization: $ORS_KEY" -H 'Accept: application/json' \
    -o "$OUT/route_ors_${name}.json" -w '%{http_code}' \
    "https://api.openrouteservice.org/v2/directions/driving-car?start=${a}&end=${b}") || code=000
  echo "ors $name -> HTTP $code (ответ: $OUT/route_ors_${name}.json; расстояние — features[0].properties.summary.distance в метрах, время — .duration в секундах)"
done
