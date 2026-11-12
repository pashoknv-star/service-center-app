// V6-4 (приёмка, вне gate): общий каркас — php -S на КОПИИ data/app.db, headless Chromium по CDP (без зависимостей).
// Пароли в браузер не вводятся: cookie берётся запросом к api/login.php (dev-учётки, пароль стартовый — только dev-БД).
'use strict';
const fs = require('fs'), os = require('os'), net = require('net'), path = require('path'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME_BIN || path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

class CDP {
  constructor(url) {
    this.id = 0; this.pending = new Map(); this.exceptions = []; this.dialogs = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.method === 'Runtime.exceptionThrown') this.exceptions.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300));
      if (d.method === 'Page.javascriptDialogOpening') { this.dialogs.push(d.params.message); this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); }
      if (d.id && this.pending.has(d.id)) { const p = this.pending.get(d.id); this.pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
    };
  }
  send(method, params, timeout) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('CDP timeout ' + method)); }, timeout || 60000);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async ev(expr, timeout) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
    if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
}

function sql(db, text) {
  const r = cp.spawnSync('sqlite3', [db], { input: '.timeout 8000\n' + text, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('sqlite3: ' + r.stderr);
  return r.stdout;
}

async function startEnv(opts) {
  opts = opts || {};
  const tmpDb = path.join(os.tmpdir(), 'v64_' + process.pid + '_' + Math.floor(Math.random() * 1e6) + '.db');
  fs.copyFileSync(opts.db || path.join(ROOT, 'data/app.db'), tmpDb);
  const port = await freePort(), base = 'http://127.0.0.1:' + port;
  const env = Object.assign({}, process.env, { SC_APP_DB: tmpDb }); delete env.TASKS_VALIDATE_WEBHOOK_URL;
  const srv = cp.spawn('php', ['-S', '127.0.0.1:' + port, '-t', ROOT], { env, cwd: ROOT, stdio: 'ignore' });
  const chromes = [];
  const env_ = { tmpDb, port, base, srv, chromes, ROOT };
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/api/session.php'); if (r.status < 500) break; } catch (e) { /* */ } await sleep(100); }
  env_.cleanup = () => { try { srv.kill(); } catch (e) { /* */ } chromes.forEach((c) => { try { c.proc.kill(); } catch (e) { /* */ } try { fs.rmSync(c.udd, { recursive: true, force: true }); } catch (e) { /* */ } }); try { fs.unlinkSync(tmpDb); } catch (e) { /* */ } };
  env_.openBrowser = async function () {
    const cport = await freePort();
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'v64_chrome_'));
    const proc = cp.spawn(CHROME, ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=' + cport, '--user-data-dir=' + udd, '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' });
    chromes.push({ proc, udd });
    let ws = null;
    for (let i = 0; i < 100 && !ws; i++) { try { const l = await (await fetch('http://127.0.0.1:' + cport + '/json/list')).json(); const p = l.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch (e) { /* */ } if (!ws) await sleep(100); }
    if (!ws) throw new Error('chromium не поднялся');
    const cdp = new CDP(ws); await cdp.ready;
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
    const ver = await (await fetch('http://127.0.0.1:' + cport + '/json/version')).json();
    return { cdp, cport, version: ver.Browser };
  };
  return env_;
}

async function login(base, user) {
  const r = await fetch(base + '/api/login.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: 'changeme' }) });
  if (r.status !== 200) throw new Error('login ' + user + ' → ' + r.status);
  const set = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
  return set.filter(Boolean).map((c) => c.split(';')[0]);
}
async function http(base, cookie, method, url, body) {
  const r = await fetch(base + '/' + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) { /* */ }
  return { status: r.status, json: j || {} };
}

// Страница: обёртка над одним CDP-соединением
function pageKit(cdp, base, outDir) {
  const k = {};
  k.setCookies = async (cookies) => { await cdp.send('Network.clearBrowserCookies'); for (const c of cookies) { const [n, ...v] = c.split('='); await cdp.send('Network.setCookie', { name: n, value: v.join('='), url: base + '/' }); } };
  k.size = (w, h, mobile) => cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile });
  k.shot = async (name) => { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(r.data, 'base64')); console.log('  shot ' + name + '.png'); };
  k.waitFor = async (expr, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 30000)) { try { if (await cdp.ev(expr)) return true; } catch (e) { /* */ } await sleep(150); } return false; };
  k.load = async (cookies, hash) => {
    await k.setCookies(cookies);
    await cdp.send('Page.navigate', { url: base + '/index.html' + (hash || '') });
    const ok = await k.waitFor('!!(window.Tasks && window.Tasks.__t && document.getElementById("tabTasks"))', 60000);
    if (!ok) throw new Error('window.Tasks не появился');
    await sleep(1200);
  };
  // снимок элемента (clip в координатах страницы: viewport-rect + scroll); maxW/maxH — обрезка
  k.shotEl = async (sel, name, o) => {
    o = o || {};
    const r = await cdp.ev('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) return null; e.scrollIntoView({block:"center",inline:"nearest"}); const r = e.getBoundingClientRect(); return {x:r.left+scrollX,y:r.top+scrollY,w:r.width,h:r.height}; })()');
    if (!r) throw new Error('shotEl: нет ' + sel);
    await sleep(500);
    const r2 = await cdp.ev('(() => { const e = document.querySelector(' + JSON.stringify(sel) + '); const r = e.getBoundingClientRect(); return {x:r.left+scrollX,y:r.top+scrollY,w:r.width,h:r.height}; })()');
    const sh = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: r2.x, y: r2.y, width: Math.min(r2.w, o.maxW || 1e5), height: Math.min(r2.h, o.maxH || 1e5), scale: o.scale || 1 } });
    fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(sh.data, 'base64')); console.log('  shot ' + name + '.png');
  };
  // реальный клик мышью по центру элемента (селектор → прокрутка в видимость → mousePressed/Released)
  k.rect = (sel, idx) => cdp.ev('(() => { const e = document.querySelectorAll(' + JSON.stringify(sel) + ')[' + (idx || 0) + ']; if (!e) return null; e.scrollIntoView({block:"center",inline:"center"}); const rs = e.getClientRects(); const r = rs.length ? rs[0] : e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; })()');
  k.clickXY = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  k.click = async (sel, idx) => { const r = await k.rect(sel, idx); if (!r) throw new Error('нет элемента ' + sel); await k.clickXY(r.x, r.y); await sleep(250); return r; };
  k.clickText = async (sel, text) => {
    const r = await cdp.ev('(() => { const es = [...document.querySelectorAll(' + JSON.stringify(sel) + ')].filter(e => e.textContent.trim().indexOf(' + JSON.stringify(text) + ') >= 0 && e.offsetParent !== null); const e = es[0]; if (!e) return null; e.scrollIntoView({block:"center",inline:"center"}); const r = e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()');
    if (!r) throw new Error('нет элемента ' + sel + ' «' + text + '»');
    await k.clickXY(r.x, r.y); await sleep(250); return r;
  };
  return k;
}

function makeChecker(outJson) {
  const res = { checks: [] };
  const c = { passed: 0, failed: 0, res };
  c.check = (name, cond, extra) => {
    res.checks.push({ name, ok: !!cond, extra: cond ? undefined : (extra === undefined ? '' : String(extra).slice(0, 400)) });
    if (cond) { c.passed++; console.log('  PASS  ' + name); } else { c.failed++; console.log('  FAIL  ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 400) : '')); }
  };
  c.note = (k, v) => { res[k] = v; };
  c.save = () => { res.passed = c.passed; res.failed = c.failed; fs.writeFileSync(outJson, JSON.stringify(res, null, 1)); };
  return c;
}

module.exports = { ROOT, sleep, freePort, CDP, sql, startEnv, login, http, pageKit, makeChecker };
