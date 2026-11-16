# CGT-1 addendum (coordinator, 2026-11-16): population check of CodeGraph 1.6.2 call edges vs whole-repo rg.
# Run from the indexed copy (HEAD 951f61e, .codegraph/ present): python3 CGT-1_population_check.py
# Result on 2026-11-16: 443 uniquely-named production function/method nodes; production call sites 1641,
# matched by a graph edge 1550 (recall >= 94.5 %, lower bound: >= 12 of 91 misses are rg noise);
# 29 symbols (6.5 %) with >= 1 missed production call site; misses: 44 PHP $obj->method() (class Database),
# 22 inline on*= handler strings, 11 calls from index.html, 14 other. Zero-edge symbols 14, of them 4 with real
# call sites (Database::migrate, maskPhoneField, toggleTransportSelect, saveDraftTrip).
# Not covered: 39 non-uniquely-named functions; anything that is not a graph node; edge precision.
# The CGT-1 report figures (recall 49 %, 14/30, 42 %) are from a purposive sample: blind-spot evidence, not accuracy.
import sqlite3, subprocess, re, collections, json
db = sqlite3.connect('file:.codegraph/codegraph.db?mode=ro', uri=True)
PROD = lambda p: (p in ('js/storage.js','js/tasks.js','js/tasks_matrix.js','js/trips.js')) or (p.startswith('api/') and p.endswith('.php') and 'test' not in p)
nodes = db.execute("select id,kind,name,qualified_name,file_path,start_line,end_line from nodes where kind in ('function','method')").fetchall()
byname = collections.Counter(n[2] for n in nodes)
html = open('index.html', encoding='utf-8', errors='replace').read()
html_defs = set(re.findall(r'function\s+([A-Za-z_$][\w$]*)\s*\(', html))
targets = [n for n in nodes if PROD(n[4]) and byname[n[2]] == 1 and n[2] not in html_defs and len(n[2]) >= 4]
print('prod function/method nodes:', sum(1 for n in nodes if PROD(n[4])), '| uniquely named, not redefined in index.html:', len(targets))
def is_prod_site(p): return p == 'index.html' or PROD(p)
tot = collections.Counter(); persym = []; miss_by = collections.Counter()
for nid, kind, name, qn, fp, sl, el in targets:
    edges = db.execute("select n.file_path, e.line, e.kind from edges e join nodes n on n.id=e.source where e.target=? and e.kind in ('calls','references','instantiates')", (nid,)).fetchall()
    gsites = {(f, l) for f, l, k in edges}
    out = subprocess.run(['rg','-n','--no-heading','-w','-F',name,'--glob','!.codegraph','--glob','!*.md','--glob','!reports/**','--glob','!CODEMAP.md','.'], capture_output=True, text=True).stdout
    sites = set()
    for line in out.splitlines():
        m = re.match(r'\./([^:]+):(\d+):(.*)$', line)
        if not m: continue
        f, l, txt = m.group(1), int(m.group(2)), m.group(3)
        s = txt.strip()
        if s.startswith(('//','*','/*','#')): continue
        if not re.search(r'(?<![\w$])' + re.escape(name) + r'\s*\(', txt): continue   # call syntax only
        if re.search(r'function\s+' + re.escape(name) + r'\s*\(', txt): continue       # definition
        if f == fp and l == sl: continue
        sites.add((f, l))
    prod = {s for s in sites if is_prod_site(s[0])}
    test = sites - prod
    tp = {s for s in prod if s in gsites}
    fn = prod - tp
    for f, l in fn:
        txt = open(f, encoding='utf-8', errors='replace').read().splitlines()[l-1]
        if f == 'index.html': cat = 'call in index.html'
        elif re.search(r'on\w+\s*=\s*\\?["\']', txt): cat = 'inline on*= handler string'
        elif re.search(r'->\s*' + re.escape(name), txt): cat = 'PHP $obj->method()'
        else: cat = 'other'
        miss_by[cat] += 1
    tot['prod_gt'] += len(prod); tot['prod_tp'] += len(tp); tot['prod_fn'] += len(fn)
    tot['test_gt'] += len(test); tot['test_tp'] += len({s for s in test if s in gsites})
    persym.append(dict(name=name, file=fp, line=sl, graph_edges=len(gsites), prod_gt=len(prod), prod_fn=len(fn), test_gt=len(test), fn=sorted(fn)))
print(dict(tot)); print('prod call-site recall: %.1f%%' % (100*tot['prod_tp']/tot['prod_gt']))
print('test call-site recall: %.1f%%' % (100*tot['test_tp']/max(1,tot['test_gt'])))
print('missed prod sites by category:', dict(miss_by))
aff = [p for p in persym if p['prod_fn']]
print('symbols with >=1 missed prod call site: %d of %d (%.1f%%)' % (len(aff), len(persym), 100*len(aff)/len(persym)))
zero = [p for p in persym if p['graph_edges'] == 0]
zfalse = [p for p in zero if p['prod_gt'] or p['test_gt']]
print('graph says 0 incoming edges: %d; of them with real call sites (rg): %d' % (len(zero), len(zfalse)))
for p in zfalse: print('  FALSE-DEAD', p['name'], p['file'], p['line'], 'prod', p['prod_gt'], 'test', p['test_gt'])
print('true zero:', [p['name'] for p in zero if p not in zfalse])
print('--- top missed'); 
for p in sorted(aff, key=lambda p:-p['prod_fn'])[:15]: print(' ', p['name'], p['file'], 'gt', p['prod_gt'], 'missed', p['prod_fn'], p['fn'][:3])
print('--- "other" misses')
for p in aff:
    for f,l in p['fn']:
        txt = open(f, encoding='utf-8', errors='replace').read().splitlines()[l-1]
        if f!='index.html' and not re.search(r'on\w+\s*=\s*\\?["\']', txt) and '->' not in txt: print('  ', p['name'], f, l, txt.strip()[:110])
