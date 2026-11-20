# Сводка маршрутов OSRM/Valhalla из T4_evidence (без сети): км, минуты, отношение к прямой, округление вверх до 15 мин.
import json, math, os

EV = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'reports', 'V10', 'T4_evidence')
PAIRS = {  # lon/lat центров населённых пунктов (Nominatim, T4_evidence/nominatim_search_*.json)
    'uray_mezhd': ((64.80362, 60.12912), (65.90851, 59.59248)),
    'uray_sovetsky': ((64.80362, 60.12912), (63.56218, 61.35802)),
    'uray_kondinskoe': ((64.80362, 60.12912), (67.41181, 59.65179)),
    'mezhd_kondinskoe': ((65.90851, 59.59248), (67.41181, 59.65179)),
    'uray_short': ((64.80362, 60.12912), (64.75999, 60.11925)),
    'uray_khm': ((64.80362, 60.12912), (69.01896, 61.00352)),
}


def haversine_km(a, b):
    r = 6371.0088
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dphi = p2 - p1
    dl = math.radians(b[0] - a[0])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def ceil15(minutes_float):
    """Минуты -> вверх до кратного 15; 0 остаётся 0 (см. SPIKE_MAP §4)."""
    return int(math.ceil(round(minutes_float, 6) / 15.0)) * 15


def load(name):
    p = os.path.join(EV, name)
    if not os.path.exists(p):
        return None
    try:
        return json.load(open(p))
    except Exception:
        return None


print('%-18s %7s | %-22s | %-22s | %-22s' % ('пара', 'прямая', 'OSRM FOSSGIS км/мин', 'OSRM demo км/мин', 'Valhalla км/мин'))
for k, (a, b) in PAIRS.items():
    row = ['%-18s' % k, '%6.1f' % haversine_km(a, b)]
    for kind in ('osrm_fossgis', 'osrm_demo', 'valhalla'):
        d = load('route_%s_%s.json' % (kind, k))
        if not d:
            row.append('%-22s' % '—')
            continue
        if kind.startswith('osrm'):
            r = d['routes'][0]
            km, mins = r['distance'] / 1000.0, r['duration'] / 60.0
        else:
            s = d['trip']['summary']
            km, mins = s['length'], s['time'] / 60.0
        row.append('%6.1f км %6.1f мин (→%3d)' % (km, mins, ceil15(mins)))
    print(' | '.join(row))
