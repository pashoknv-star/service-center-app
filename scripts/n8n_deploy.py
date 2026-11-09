#!/usr/bin/env python3
"""n8n_deploy.py — сборка и выкладка workflow блока «Задачи» (T1-4) через REST API n8n.

  python3 scripts/n8n_deploy.py build     # только собрать n8n/tasks-validate.json и n8n/tasks-recheck.json
  python3 scripts/n8n_deploy.py deploy    # build + создать/обновить workflow в n8n + активировать

Источник правды по логике — n8n/code/*.js (common.js вставляется в оба workflow).
Секреты:
  - N8N_API_KEY — из окружения или /etc/service-center-app/secrets.env (значение не печатается);
  - секрет вебхука генерируется при первом deploy, создаётся как credential httpHeaderAuth
    (заголовок X-Tasks-Secret) в n8n, а для приложения пишется в ~/.config/service-center-app/dev.env
    (chmod 600, вне репозитория). В репозиторий/stdout он не попадает.
JSON-экспорты в n8n/ НЕ содержат credentials (id) и секретов — после импорта вручную выберите
credential httpHeaderAuth «tasks-webhook-secret» на узлах Webhook.
Деплой приложения/прод-переменные — зона владельца; здесь только n8n и dev.env.
"""
import json
import os
import secrets
import stat
import sys
import urllib.error
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.environ.get('N8N_BASE_URL', 'https://n8n.domenforjob.ru').rstrip('/')
CFG_DIR = os.path.expanduser('~/.config/service-center-app')
DEV_ENV = os.path.join(CFG_DIR, 'dev.env')
STATE = os.path.join(CFG_DIR, 'n8n_state.json')
CRED_NAME = 'tasks-webhook-secret'
HEADER_NAME = 'X-Tasks-Secret'
NS = uuid.UUID('6f1b1d1e-0a53-4a43-9a38-7b0c5e0b7a10')

WORKFLOWS = [
    {'name': 'tasks-validate', 'path': 'tasks-validate', 'file': 'tasks-validate.json', 'code': 'tasks_validate.js',
     'env': 'TASKS_VALIDATE_WEBHOOK_URL'},
    {'name': 'tasks-recheck', 'path': 'tasks-recheck', 'file': 'tasks-recheck.json', 'code': 'tasks_recheck.js',
     'env': 'TASKS_RECHECK_WEBHOOK_URL'},
]


def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


def api_key():
    key = os.environ.get('N8N_API_KEY')
    if not key and os.path.exists('/etc/service-center-app/secrets.env'):
        for line in read('/etc/service-center-app/secrets.env').splitlines():
            if line.startswith('N8N_API_KEY='):
                key = line.split('=', 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit('N8N_API_KEY не найден (окружение или /etc/service-center-app/secrets.env)')
    return key


def api(method, path, body=None):
    req = urllib.request.Request(
        BASE + '/api/v1' + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'X-N8N-API-KEY': api_key(), 'Content-Type': 'application/json', 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw[:300]


def nid(wf, what):
    return str(uuid.uuid5(NS, wf + ':' + what))


def build_workflow(spec, cred_id=None):
    js = read(os.path.join(ROOT, 'n8n', 'code', 'common.js')) + '\n' + read(os.path.join(ROOT, 'n8n', 'code', spec['code']))
    cred = {'httpHeaderAuth': {'name': CRED_NAME}}
    if cred_id:
        cred['httpHeaderAuth']['id'] = cred_id
    nodes = [
        {'parameters': {'httpMethod': 'POST', 'path': spec['path'], 'authentication': 'headerAuth',
                        'responseMode': 'responseNode', 'options': {}},
         'id': nid(spec['name'], 'webhook'), 'name': 'Webhook', 'type': 'n8n-nodes-base.webhook', 'typeVersion': 2,
         'position': [0, 0], 'webhookId': nid(spec['name'], 'webhookId'), 'credentials': cred},
        {'parameters': {'mode': 'runOnceForAllItems', 'language': 'javaScript', 'jsCode': js},
         'id': nid(spec['name'], 'code'), 'name': 'Rules', 'type': 'n8n-nodes-base.code', 'typeVersion': 2,
         'position': [260, 0]},
        {'parameters': {'respondWith': 'firstIncomingItem',
                        'options': {'responseCode': '={{ $json.error ? 400 : 200 }}'}},
         'id': nid(spec['name'], 'respond'), 'name': 'Respond', 'type': 'n8n-nodes-base.respondToWebhook',
         'typeVersion': 1.1, 'position': [520, 0]},
    ]
    return {
        'name': spec['name'],
        'nodes': nodes,
        'connections': {'Webhook': {'main': [[{'node': 'Rules', 'type': 'main', 'index': 0}]]},
                        'Rules': {'main': [[{'node': 'Respond', 'type': 'main', 'index': 0}]]}},
        'settings': {'executionOrder': 'v1', 'saveDataSuccessExecution': 'none', 'saveDataErrorExecution': 'all',
                     'executionTimeout': 10},
    }


def export(spec):
    """JSON-экспорт без credential id/секретов."""
    wf = build_workflow(spec)
    path = os.path.join(ROOT, 'n8n', spec['file'])
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(wf, f, ensure_ascii=False, indent=2)
        f.write('\n')
    return path


def load_state():
    try:
        return json.loads(read(STATE))
    except (OSError, ValueError):
        return {}


def ensure_credential():
    """Возвращает (credential_id, secret|None). Секрет возвращается только при создании."""
    state = load_state()
    if state.get('credential_id') and os.path.exists(DEV_ENV) and 'TASKS_N8N_WEBHOOK_SECRET=' in read(DEV_ENV):
        return state['credential_id'], None
    secret = secrets.token_urlsafe(32)
    st, d = api('POST', '/credentials', {'name': CRED_NAME, 'type': 'httpHeaderAuth',
                                         'data': {'name': HEADER_NAME, 'value': secret}})
    if st not in (200, 201):
        sys.exit('создание credential не удалось: HTTP %s %s' % (st, str(d)[:200]))
    os.makedirs(CFG_DIR, mode=0o700, exist_ok=True)
    with open(STATE, 'w') as f:
        json.dump({'credential_id': d['id'], 'credential_name': CRED_NAME}, f)
    os.chmod(STATE, stat.S_IRUSR | stat.S_IWUSR)
    return d['id'], secret


def write_dev_env(urls, secret):
    os.makedirs(CFG_DIR, mode=0o700, exist_ok=True)
    lines = ['# сгенерировано scripts/n8n_deploy.py; вне репозитория, не коммитить',
             'TASKS_VALIDATE_WEBHOOK_URL=' + urls['TASKS_VALIDATE_WEBHOOK_URL'],
             'TASKS_RECHECK_WEBHOOK_URL=' + urls['TASKS_RECHECK_WEBHOOK_URL'],
             'TASKS_N8N_WEBHOOK_SECRET=' + secret]
    fd = os.open(DEV_ENV, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    os.chmod(DEV_ENV, 0o600)


def deploy():
    cred_id, secret = ensure_credential()
    st, d = api('GET', '/workflows?limit=250')
    if st != 200:
        sys.exit('GET /workflows: HTTP %s' % st)
    existing = {w['name']: w['id'] for w in d['data']}
    urls = {}
    for spec in WORKFLOWS:
        export(spec)
        wf = build_workflow(spec, cred_id)
        if spec['name'] in existing:
            wid = existing[spec['name']]
            st, r = api('PUT', '/workflows/' + wid, wf)
            action = 'updated'
        else:
            st, r = api('POST', '/workflows', wf)
            action = 'created'
            wid = r.get('id') if isinstance(r, dict) else None
        if st not in (200, 201) or not wid:
            sys.exit('%s: HTTP %s %s' % (spec['name'], st, str(r)[:300]))
        st, r = api('POST', '/workflows/%s/activate' % wid)
        if st != 200:
            sys.exit('activate %s: HTTP %s %s' % (spec['name'], st, str(r)[:300]))
        urls[spec['env']] = '%s/webhook/%s' % (BASE, spec['path'])
        print('%s %s id=%s active=%s' % (action, spec['name'], wid, r.get('active') if isinstance(r, dict) else '?'))
    if secret is not None:
        write_dev_env(urls, secret)
        print('dev.env записан: %s (secret не выводится)' % DEV_ENV)
    else:
        print('credential и dev.env уже есть — секрет не менялся')
    for k, v in urls.items():
        print(k + '=' + v)


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'build'
    if cmd == 'build':
        for s in WORKFLOWS:
            print('exported', export(s))
    elif cmd == 'deploy':
        deploy()
    else:
        sys.exit(__doc__)
