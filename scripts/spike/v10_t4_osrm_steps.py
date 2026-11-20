# Шаги OSRM из T4_evidence (без сети): названия/ref и классы дорог маршрута, длина по участкам.
import json, os, sys

EV = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'reports', 'V10', 'T4_evidence')
d = json.load(open(os.path.join(EV, sys.argv[1] if len(sys.argv) > 1 else 'route_osrm_fossgis_mezhd_kondinskoe_steps.json')))
acc = {}
for leg in d['routes'][0]['legs']:
    for s in leg['steps']:
        key = (s.get('name') or '(без названия)', s.get('ref', ''), s.get('mode'))
        a = acc.setdefault(key, [0.0, 0.0])
        a[0] += s['distance'] / 1000.0
        a[1] += s['duration'] / 60.0
for (n, ref, mode), (km, mi) in sorted(acc.items(), key=lambda kv: -kv[1][0]):
    print('%7.1f км %6.1f мин  %-30s ref=%s mode=%s  ср.скорость=%.0f км/ч' % (km, mi, n, ref, mode, km / (mi / 60.0) if mi else 0))
