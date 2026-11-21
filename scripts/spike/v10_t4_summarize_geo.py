# Сводка ответов Nominatim из T4_evidence (без сети).
import json, glob, os
ev = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'reports', 'V10', 'T4_evidence')
for f in sorted(glob.glob(os.path.join(ev, 'nominatim_search_*.json'))):
    try:
        d = json.load(open(f))
    except Exception as e:
        print(os.path.basename(f), 'ERR', e)
        continue
    print('==', os.path.basename(f), len(d), 'результатов')
    for r in d:
        a = r.get('address', {})
        print('  ', r['lat'][:8], r['lon'][:8], r.get('type'), '|', r.get('name'), '|',
              a.get('county') or a.get('municipality') or '', '|', a.get('state'), '| imp=%.2f' % r.get('importance', 0))
for f in sorted(glob.glob(os.path.join(ev, 'nominatim_reverse_*.json'))):
    d = json.load(open(f))
    print('== REVERSE', os.path.basename(f), '| addresstype =', d.get('addresstype'), '| name =', d.get('name'))
    print('     address =', json.dumps(d.get('address'), ensure_ascii=False))
