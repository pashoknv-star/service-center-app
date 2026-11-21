# Маневры Valhalla из T4_evidence (без сети): какие дороги выбрал маршрут (для объяснения расхождений).
import json, os, sys

EV = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'reports', 'V10', 'T4_evidence')
names = sys.argv[1:] or ['uray_mezhd', 'uray_sovetsky', 'uray_kondinskoe', 'mezhd_kondinskoe']
for n in names:
    d = json.load(open(os.path.join(EV, 'route_valhalla_%s.json' % n)))
    t = d['trip']
    print('==', n, 'length=%.1f km time=%.1f min' % (t['summary']['length'], t['summary']['time'] / 60.0))
    for leg in t['legs']:
        for m in leg['maneuvers']:
            if m['length'] >= 3:
                print('   %6.1f км %5.1f мин | %s | street_names=%s' % (m['length'], m['time'] / 60.0, m['instruction'][:70], m.get('street_names') or m.get('begin_street_names')))
