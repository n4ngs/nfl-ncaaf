/*
 * NFL.NCAAF — the terminal.
 *
 * One Railway service, one origin. This front process:
 *   1. owns the front door: one admin code (full access + Security Center) and one guest code (boards +
 *      own bet tracking, never admin), each unlocking BOTH sports in a single entry;
 *   2. spawns the two sport engines as children on internal ports and reverse-proxies /nfl/* and /ncaaf/*
 *      to them, stripping the sport prefix.
 *
 * The engines still validate the same cookies themselves (defense in depth) and derive owner vs guest from
 * them, so the whole per-sport model — bet ownership, the Security Center, guest tracking — keeps working.
 *
 * Zero dependencies. Node 18+. SSE is piped, never buffered.
 */
'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 4000;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');

// ---- access ---------------------------------------------------------------
// ADMIN = ACCESS_CODE (owner). GUEST_CODE = a guest entrance. Hashes match what the engines compute
// (hashCode = sha256('hl:'+x)), so a cookie the terminal sets is accepted by the engines unchanged.
const ADMIN_CODE = (process.env.ACCESS_CODE || '').trim();
const GUEST_CODE = (process.env.GUEST_CODE || '').trim();
const hashCode = (c) => crypto.createHash('sha256').update(`hl:${c}`).digest('hex');
const OWNER_HASH = ADMIN_CODE ? hashCode(ADMIN_CODE) : '';
const GUEST_HASH = GUEST_CODE ? hashCode('guest:' + GUEST_CODE) : '';
// A stable, unguessable one-tap guest link: share https://host/g/<GUEST_LINK>.
const GUEST_LINK = GUEST_CODE ? crypto.createHash('sha256').update(`guestlink:${GUEST_CODE}`).digest('hex').slice(0, 24) : '';
const OWNER_NAME = (process.env.OWNER_NAME || '').trim().slice(0, 24);
const GATED = !!ADMIN_CODE;

// A single peer secret shared by both children so the Security Center "All apps" toggle reads across the two
// engines over localhost.
const PEER_SECRET = process.env.TELEMETRY_PEER_SECRET || crypto.randomBytes(32).toString('hex');

const SPORTS = {
  nfl:   { dir: 'nfl',   base: '/nfl',   label: 'NFL',   port: 5061, appId: 'pick-six',        sibling: 'ncaaf', ck: 'ps' },
  ncaaf: { dir: 'ncaaf', base: '/ncaaf', label: 'NCAAF', port: 5062, appId: 'hook-and-ladder', sibling: 'nfl',   ck: 'hl' },
};

// ---- brand ----------------------------------------------------------------
const BRAND = 'NFL.NCAAF';
const LOGO = // a terminal caret — the wordmark's icon, favicon and PWA icon
  '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="NFL.NCAAF">'
  + '<rect width="64" height="64" rx="15" fill="#0B0B0D"/>'
  + '<path d="M21 21 L33 32 L21 43" fill="none" stroke="#EE3A2E" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<rect x="34" y="38.5" width="15" height="5" rx="2.5" fill="#F5F5F7"/></svg>';
const MANIFEST = JSON.stringify({
  name: BRAND, short_name: BRAND, start_url: '/', scope: '/', display: 'standalone',
  background_color: '#0B0B0D', theme_color: '#0B0B0D',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
});

function pick(sportKey, name) {
  const up = sportKey.toUpperCase();
  return process.env[`${up}_${name}`] != null ? process.env[`${up}_${name}`] : process.env[name];
}
function childEnv(key) {
  const s = SPORTS[key], sib = SPORTS[s.sibling];
  const env = { ...process.env };
  env.PORT = String(s.port);
  env.BASE_PATH = s.base;
  env.DATA_DIR = path.join(DATA_DIR, s.dir);
  env.APP_ID = s.appId;
  env.TELEMETRY_PEER_SECRET = PEER_SECRET;
  env.TELEMETRY_PEER_URL = `http://127.0.0.1:${sib.port}`;
  env.TELEMETRY_PEER_NAME = sib.appId;
  for (const k of ['ACCESS_CODE', 'GUEST_CODE', 'OWNER_NAME', 'OWNER_CODE']) {
    const v = pick(key, k);
    if (v != null) env[k] = v; else delete env[k];
  }
  return env;
}
const children = {};
function launch(key) {
  const s = SPORTS[key];
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, s.dir), env: childEnv(key), stdio: 'inherit' });
  children[key] = child;
  child.on('exit', (code, sig) => { console.log(`[terminal] ${key} exited (code=${code} sig=${sig}); restarting in 1s`); setTimeout(() => launch(key), 1000); });
  console.log(`[terminal] ${key} -> 127.0.0.1:${s.port} base=${s.base}`);
}
Object.keys(SPORTS).forEach(launch);

// ---- cookies / auth -------------------------------------------------------
function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => { const i = c.indexOf('='); return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)]; }));
}
const safeEq = (a, b) => { a = String(a || ''); b = String(b || ''); if (!a || a.length !== b.length) return false; try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; } };
function role(req) {
  if (!GATED) return 'owner';
  const c = cookies(req);
  if (safeEq(c.ps_code, OWNER_HASH) || safeEq(c.hl_code, OWNER_HASH)) return 'owner';
  if (GUEST_HASH && (safeEq(c.ps_guest, GUEST_HASH) || safeEq(c.hl_guest, GUEST_HASH))) return 'guest';
  return null;
}
function setAuth(res, kind, isHttps) {
  const opt = `Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
  const val = kind === 'owner' ? OWNER_HASH : GUEST_HASH;
  const name = kind === 'owner' ? 'code' : 'guest';
  // Set the credential for BOTH sports at Path=/, so one entry authenticates NFL and NCAAF together.
  res.setHeader('set-cookie', [`ps_${name}=${val}; ${opt}`, `hl_${name}=${val}; ${opt}`]);
}
function clearAuth(res, isHttps) {
  const gone = `Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
  res.setHeader('set-cookie', ['ps_code=', 'hl_code=', 'ps_guest=', 'hl_guest='].map((k) => `${k}; ${gone}`));
}

// ---- login page -----------------------------------------------------------
function page(res, code, { wrong = false } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${BRAND}</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0B0B0D">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0B0B0D;--s:#161618;--ink:#F5F5F7;--i2:#9C9CA4;--i3:#6E6E76;--line:rgba(255,255,255,.09);--fill:rgba(255,255,255,.06);--a:#FF453A}
@media (prefers-color-scheme:light){:root{--bg:#F4F4F6;--s:#fff;--ink:#0B0B0D;--i2:#62626B;--i3:#8A8A92;--line:rgba(11,11,13,.09);--fill:rgba(11,11,13,.045);--a:#EE3A2E}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font-family:"Geist",ui-sans-serif,system-ui,sans-serif;padding:24px}
.card{width:100%;max-width:360px}.top{display:flex;align-items:center;gap:12px;margin-bottom:26px}.logo{width:44px;height:44px;border-radius:13px;overflow:hidden;flex:none;box-shadow:0 1px 2px rgba(0,0,0,.3)}.logo svg{display:block;width:100%;height:100%}
.wm{font-family:"Geist Mono",ui-monospace,monospace;font-size:15px;font-weight:600;letter-spacing:.06em}.wm b{color:var(--a);font-weight:600}
h1{font-size:24px;letter-spacing:-.03em;margin:0 0 6px}p{color:var(--i2);font-size:15px;margin:0 0 22px;line-height:1.45}
form{display:flex;flex-direction:column;gap:10px}input{height:52px;border-radius:14px;border:1px solid var(--line);background:var(--s);color:var(--ink);font:inherit;font-size:17px;padding:0 16px}
input:focus{outline:none;border-color:var(--i3)}button{height:52px;border:0;border-radius:999px;background:var(--ink);color:var(--bg);font:inherit;font-weight:600;cursor:pointer}
.e{color:var(--a);font-size:14px;min-height:18px;margin:2px 0 0}.f{color:var(--i3);font-size:12px;margin-top:18px;text-align:center}
</style></head>
<body><div class="card">
<div class="top"><span class="logo">${LOGO}</span><span class="wm">NFL<b>.</b>NCAAF</span></div>
<h1>${OWNER_NAME ? OWNER_NAME + "'s board" : 'Enter your code'}</h1>
<p>NFL and NCAAF, one board. Enter the code you were given.</p>
<form method="post" action="/login" autocomplete="off">
<input name="code" type="password" inputmode="text" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Access code" autofocus required>
<button>Open the board</button>
<div class="e">${wrong ? "That code didn't work. Check it and try again." : ''}</div>
</form>
<div class="f">One board · NFL &amp; NCAAF</div>
</div></body></html>`;
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// ---- rate limit (per ip) --------------------------------------------------
const fails = new Map();
function locked(ip) { const a = (fails.get(ip) || []).filter((t) => t > Date.now() - 15 * 60e3); fails.set(ip, a); return a.length >= 10; }
function bad(ip) { const a = fails.get(ip) || []; a.push(Date.now()); fails.set(ip, a); }
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// Assets that must load even before sign-in (PWA install + uptime checks).
const OPEN = /^\/(nfl|ncaaf)\/(api\/health|manifest\.webmanifest|sw\.js|favicon\.ico|icons\/[\w.\-/]+)$/;

function lastSport(req) { const m = /(?:^|;\s*)sport=(nfl|ncaaf)/.exec(req.headers.cookie || ''); return m ? m[1] : 'nfl'; }

const server = http.createServer((req, res) => {
  const u = req.url || '/';
  const qi = u.indexOf('?');
  const pathname = qi >= 0 ? u.slice(0, qi) : u;
  const qs = qi >= 0 ? u.slice(qi) : '';

  // terminal-owned endpoints -------------------------------------------------
  if (pathname === '/health' || pathname === '/api/health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"ok":true,"app":"nfl.ncaaf"}'); }
  if (pathname === '/icon.svg' || pathname === '/favicon.ico') { res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' }); return res.end(LOGO); }
  if (pathname === '/manifest.webmanifest') { res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' }); return res.end(MANIFEST); }
  if (pathname === '/logout') { clearAuth(res, isHttps(req)); res.writeHead(303, { location: '/' }); return res.end(); }

  if (pathname === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (locked(ip)) { res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '900' }); return res.end('Too many tries. Wait 15 minutes.'); }
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      const code = new URLSearchParams(body).get('code') || '';
      let kind = null;
      if (OWNER_HASH && safeEq(hashCode(code), OWNER_HASH)) kind = 'owner';
      else if (GUEST_HASH && safeEq(hashCode('guest:' + code), GUEST_HASH)) kind = 'guest';
      if (!kind) { bad(ip); return page(res, 401, { wrong: true }); }
      fails.delete(ip);
      setAuth(res, kind, isHttps(req));
      res.writeHead(303, { location: `/${lastSport(req)}/`, 'cache-control': 'no-store' });
      res.end();
    });
    return;
  }

  // one-tap guest link: /g/<token>
  const gm = /^\/g\/([a-f0-9]{16,32})$/.exec(pathname);
  if (gm && req.method === 'GET') {
    if (GUEST_LINK && safeEq(gm[1], GUEST_LINK)) { setAuth(res, 'guest', isHttps(req)); res.writeHead(303, { location: '/nfl/', 'cache-control': 'no-store' }); return res.end(); }
    return page(res, 401, { wrong: true });
  }

  const r = role(req);

  if (pathname === '/') {
    if (GATED && !r) return page(res, 200, {});
    res.writeHead(302, { location: `/${lastSport(req)}/`, 'cache-control': 'no-store' });
    return res.end();
  }

  const m = /^\/(nfl|ncaaf)(\/.*)?$/.exec(pathname);
  if (!m) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  const s = SPORTS[m[1]];
  if (m[2] === undefined) { res.writeHead(301, { location: `${s.base}/` }); return res.end(); }

  // gate the boards
  if (GATED && !r && !OPEN.test(pathname)) {
    if (pathname.startsWith(`/${m[1]}/api/`)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"Sign in"}'); }
    res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); return res.end();
  }

  // proxy to the engine (prefix stripped)
  const forwardPath = (m[2] || '/') + qs;
  const headers = { ...req.headers, host: `127.0.0.1:${s.port}` };
  const pr = http.request({ host: '127.0.0.1', port: s.port, method: req.method, path: forwardPath, headers }, (pres) => {
    const h = { ...pres.headers };
    if ((h['content-type'] || '').includes('text/html')) {
      const sc = h['set-cookie'] ? (Array.isArray(h['set-cookie']) ? h['set-cookie'].slice() : [h['set-cookie']]) : [];
      sc.push(`sport=${m[1]}; Path=/; Max-Age=31536000; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
      h['set-cookie'] = sc;
    }
    res.writeHead(pres.statusCode || 502, h);
    pres.pipe(res);
  });
  pr.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Upstream not ready'); });
  req.pipe(pr);
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 76000;
server.listen(PORT, () => {
  console.log(`[terminal] ${BRAND} on :${PORT}  gated=${GATED} guest=${!!GUEST_HASH}${GUEST_LINK ? `  guest-link=/g/${GUEST_LINK}` : ''}`);
});

let down = false;
function shutdown() { if (down) return; down = true; for (const k of Object.keys(children)) { const c = children[k]; if (c) { c.removeAllListeners('exit'); try { c.kill('SIGTERM'); } catch {} } } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
