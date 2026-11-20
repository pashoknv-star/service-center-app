#!/usr/bin/env bash
# V10-T4 SPIKE: расчёт маршрута по 5 парам населённых пунктов ХМАО (только координаты, публичные сервисы).
# Координаты — центры населённых пунктов из ответов Nominatim (T4_evidence/nominatim_search_*.json).
# Каждый запрос идёт через v10_t4_probe.sh (пауза 1.2 с, общий бюджет 50, журнал request_log.tsv).
# Использование: v10_t4_routes.sh osrm_fossgis|osrm_demo|valhalla
set -eu
D="$(cd "$(dirname "$0")" && pwd)"
P="$D/v10_t4_probe.sh"
ENGINE="${1:?osrm_fossgis|osrm_demo|valhalla}"
# имя:lon1,lat1;lon2,lat2
PAIRS=(
  "uray_mezhd:64.80362,60.12912;65.90851,59.59248"
  "uray_sovetsky:64.80362,60.12912;63.56218,61.35802"
  "uray_kondinskoe:64.80362,60.12912;67.41181,59.65179"
  "mezhd_kondinskoe:65.90851,59.59248;67.41181,59.65179"
  "uray_short:64.80362,60.12912;64.75999,60.11925"
)
for p in "${PAIRS[@]}"; do
  name="${p%%:*}"; c="${p#*:}"
  A="${c%%;*}"; B="${c#*;}"
  case "$ENGINE" in
    osrm_fossgis)
      "$P" "route_osrm_fossgis_${name}.json" "https://routing.openstreetmap.de/routed-car/route/v1/driving/${c}?overview=false&alternatives=false&steps=false" ;;
    osrm_demo)
      "$P" "route_osrm_demo_${name}.json" "https://router.project-osrm.org/route/v1/driving/${c}?overview=false&alternatives=false&steps=false" ;;
    valhalla)
      lon1="${A%%,*}"; lat1="${A##*,}"; lon2="${B%%,*}"; lat2="${B##*,}"
      J="{\"locations\":[{\"lat\":${lat1},\"lon\":${lon1}},{\"lat\":${lat2},\"lon\":${lon2}}],\"costing\":\"auto\",\"directions_options\":{\"units\":\"kilometers\"}}"
      "$P" "route_valhalla_${name}.json" "https://valhalla1.openstreetmap.de/route?json=$(printf '%s' "$J" | sed 's/{/%7B/g;s/}/%7D/g;s/\[/%5B/g;s/\]/%5D/g;s/"/%22/g;s/ /%20/g')" ;;
  esac
done
