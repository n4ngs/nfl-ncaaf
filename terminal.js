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
// Where everything durable lives: bets, names, share links, line history, the Admin Center log. On Railway
// this MUST be the mounted volume — the container's own disk is wiped on every deploy. DATA_DIR was never
// set on this service, so fall back to the mount path Railway injects rather than silently using ./data.
const DATA_DIR = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'));

// ---- access ---------------------------------------------------------------
// ADMIN = ACCESS_CODE (owner). GUEST_CODE = a guest entrance. Hashes match what the engines compute
// (hashCode = sha256('hl:'+x)), so a cookie the terminal sets is accepted by the engines unchanged.
const ADMIN_CODE = (process.env.ACCESS_CODE || '').trim();
const GUEST_CODE = (process.env.GUEST_CODE || '').trim();
const hashCode = (c) => crypto.createHash('sha256').update(`hl:${c}`).digest('hex');
const OWNER_HASH = ADMIN_CODE ? hashCode(ADMIN_CODE) : '';
const GUEST_HASH = GUEST_CODE ? hashCode('guest:' + GUEST_CODE) : '';
// A stable, unguessable one-tap guest link: share https://host/g/<GUEST_LINK>.
// Bing Bong Live hashes its own way, so mint its token too and one entry covers all three sports.
const bblTok = (x) => crypto.createHash('sha256').update(`bing-bong-live:${x}`).digest('hex').slice(0, 40);
const BBL_OWNER = ADMIN_CODE ? bblTok(ADMIN_CODE) : '';
const BBL_GUEST = GUEST_CODE ? bblTok('guest:' + GUEST_CODE) : '';
const GUEST_LINK = GUEST_CODE ? crypto.createHash('sha256').update(`guestlink:${GUEST_CODE}`).digest('hex').slice(0, 24) : '';
const OWNER_NAME = (process.env.OWNER_NAME || '').trim().slice(0, 24);
const GATED = !!ADMIN_CODE;
/* Open boards (owner's call, 2026-09-21): guests should never meet a sign-in screen. A browser can't carry a
   sign-in to another browser, so anyone opening the site is quietly signed in as a guest; only Admin needs the
   code. OPEN_BOARDS=0 puts the guest lock back (the guest link/code then required again). */
const OPEN_BOARDS = process.env.OPEN_BOARDS !== '0';

// A single peer secret shared by both children so the Security Center "All apps" toggle reads across the two
// engines over localhost.
const PEER_SECRET = process.env.TELEMETRY_PEER_SECRET || crypto.randomBytes(32).toString('hex');

const SPORTS = {
  nfl:   { dir: 'nfl',   base: '/nfl',   label: 'NFL',   port: 5061, appId: 'pick-six',        sibling: 'ncaaf', ck: 'ps' },
  ncaaf: { dir: 'ncaaf', base: '/ncaaf', label: 'NCAAF', port: 5062, appId: 'hook-and-ladder', sibling: 'nfl',   ck: 'hl' },
  mlb:   { dir: 'mlb',   base: '/mlb',   label: 'MLB',   port: 5063, appId: 'bing-bong-live',  sibling: 'nfl',   ck: 'bbl' },
};
// Which Odds API sport each engine resolves its BetMGM links against.
const ODDS_SPORT = { nfl: 'americanfootball_nfl', ncaaf: 'americanfootball_ncaaf', mlb: 'baseball_mlb' };

// ---- brand ----------------------------------------------------------------
const BRAND = 'THE.BOARD';
const LOGO = // a terminal caret — the wordmark's icon, favicon and PWA icon
  '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="THE.BOARD">'
  + '<rect width="64" height="64" rx="15" fill="#0B0B0D"/>'
  + '<path d="M21 21 L33 32 L21 43" fill="none" stroke="#EE3A2E" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>'
  + '<rect x="34" y="38.5" width="15" height="5" rx="2.5" fill="#F5F5F7"/></svg>';
// The owner's Admin Center: captures every request at the door, owner and guests kept apart (see board.js).
const Board = require('./board')({ dataDir: DATA_DIR, sports: SPORTS, ownerName: OWNER_NAME, brand: BRAND, logo: LOGO });
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
  if (ODDS_SPORT[key]) env.ODDS_SPORT_KEY = ODDS_SPORT[key];
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
  if (safeEq(c.ps_code, OWNER_HASH) || safeEq(c.hl_code, OWNER_HASH) || (BBL_OWNER && safeEq(c.bbl_access, BBL_OWNER))) return 'owner';
  if ((GUEST_HASH && (safeEq(c.ps_guest, GUEST_HASH) || safeEq(c.hl_guest, GUEST_HASH))) || (BBL_GUEST && safeEq(c.bbl_guest, BBL_GUEST))) return 'guest';
  return null;
}
function setAuth(res, kind, isHttps) {
  const opt = `Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
  const val = kind === 'owner' ? OWNER_HASH : GUEST_HASH;
  const name = kind === 'owner' ? 'code' : 'guest';
  // Set the credential for ALL THREE sports at Path=/, so one entry authenticates the whole board.
  const bbl = kind === 'owner' ? `bbl_access=${BBL_OWNER}` : `bbl_guest=${BBL_GUEST}`;
  addCookies(res, [`ps_${name}=${val}; ${opt}`, `hl_${name}=${val}; ${opt}`, `${bbl}; ${opt}`]);
}
function clearAuth(res, isHttps) {
  const gone = `Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
  addCookies(res, ['ps_code=', 'hl_code=', 'ps_guest=', 'hl_guest=', 'bbl_access=', 'bbl_guest='].map((k) => `${k}; ${gone}`));
}
// Append, never replace: the board's device cookie may already be on this response.
function addCookies(res, list) {
  const had = res.getHeader('set-cookie');
  res.setHeader('set-cookie', [].concat(had || [], list));
}

// ---- login page -----------------------------------------------------------
function page(res, code, { wrong = false } = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${BRAND}</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#0B0B0D">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@600&display=swap" rel="stylesheet">
<style>
:root{--bg:#060A13;--s:#0E1524;--ink:#F2F5FB;--i2:#9BA6BD;--i3:#7C88A1;--line:rgba(150,172,222,.14);--fill:rgba(150,172,222,.08);--a:#FF453A;--b:#FFB020}
@media (prefers-color-scheme:light){:root{--bg:#EDF1F7;--s:#fff;--ink:#0A1224;--i2:#4B5670;--i3:#6B7690;--line:rgba(10,18,36,.1);--fill:rgba(10,18,36,.05);--a:#EE3A2E;--b:#E39A00}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(900px 420px at 15% -10%,rgba(56,104,255,.2),transparent 62%),radial-gradient(700px 380px at 100% -10%,rgba(255,176,32,.1),transparent 60%),var(--bg);color:var(--ink);font-family:"Geist",ui-sans-serif,system-ui,sans-serif;padding:24px}
.card{width:100%;max-width:360px}.top{display:flex;align-items:center;gap:12px;margin-bottom:26px}.logo{width:44px;height:44px;border-radius:13px;overflow:hidden;flex:none;box-shadow:0 1px 2px rgba(0,0,0,.3)}.logo svg{display:block;width:100%;height:100%}
.wm{font-family:"Geist Mono",ui-monospace,monospace;font-size:15px;font-weight:600;letter-spacing:.06em}.wm b{color:var(--b);font-weight:600}
h1{font-size:24px;letter-spacing:-.03em;margin:0 0 6px}p{color:var(--i2);font-size:15px;margin:0 0 22px;line-height:1.45}
form{display:flex;flex-direction:column;gap:10px}input{height:52px;border-radius:14px;border:1px solid var(--line);background:var(--s);color:var(--ink);font:inherit;font-size:17px;padding:0 16px}
input:focus{outline:none;border-color:var(--i3)}button{height:52px;border:0;border-radius:999px;background:var(--b);color:#1B1200;font:inherit;font-weight:600;cursor:pointer}
.e{color:var(--a);font-size:14px;min-height:18px;margin:2px 0 0}.f{color:var(--i3);font-size:12px;margin-top:18px;text-align:center}
</style></head>
<body><div class="card">
<div class="top"><span class="logo">${LOGO}</span><span class="wm">THE<b>.</b>BOARD</span></div>
<h1>${OPEN_BOARDS ? 'Admin sign-in' : OWNER_NAME ? OWNER_NAME + "'s board" : 'Enter your code'}</h1>
<p>${OPEN_BOARDS ? 'The boards are open to everyone. This is only for the admin code.' : 'NFL, college football and MLB on one board. Enter your code, or paste the link you were sent.'}</p>
<form method="post" action="/login" autocomplete="off">
<input name="code" type="password" inputmode="text" autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Code or link" placeholder="Code or link" autofocus required>
<button>${OPEN_BOARDS ? 'Sign in' : 'Open the board'}</button>
<div class="e">${wrong ? (OPEN_BOARDS ? "That code didn't work." : "That didn't work. Try opening the link you were sent in this browser.") : ''}</div>
</form>
<div class="f">${OPEN_BOARDS ? '<a href="/" style="color:inherit">Just here for the boards? Go to the board &rsaquo;</a>' : 'One board · NFL · NCAAF · MLB'}</div>
</div></body></html>`;
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// ---- the shared broadcast design layer (design/), loaded by all three boards -------------
// Read once at boot; an ETag lets phones revalidate cheaply instead of holding a stale copy.
const fs = require('node:fs');
const DESIGN = {};
for (const f of ['broadcast.css', 'broadcast.js']) {
  const body = fs.readFileSync(path.join(__dirname, 'design', f));
  DESIGN[f] = { body, etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
}
function serveDesign(req, res, name, ext) {
  const d = DESIGN[name];
  const h = { 'content-type': ext === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag: d.etag };
  if (req.headers['if-none-match'] === d.etag) { res.writeHead(304, h); return res.end(); }
  res.writeHead(200, h); res.end(d.body);
}

// ---- rate limit (per ip) --------------------------------------------------
const fails = new Map();
function locked(ip) { const a = (fails.get(ip) || []).filter((t) => t > Date.now() - 15 * 60e3); fails.set(ip, a); return a.length >= 10; }
function bad(ip) { const a = fails.get(ip) || []; a.push(Date.now()); fails.set(ip, a); }
// Railway appends the real client address LAST; earlier entries can be typed by the client (and would let
// anyone dodge the login rate limit). Same rule the engines use.
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '';
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// Assets that must load even before sign-in (PWA install + uptime checks).
const OPEN = /^\/(nfl|ncaaf|mlb)\/(api\/health|manifest\.webmanifest|sw\.js|favicon\.ico|icons\/[\w.\-/]+)$/;

function lastSport(req) { const m = /(?:^|;\s*)sport=(nfl|ncaaf|mlb)/.exec(req.headers.cookie || ''); return m ? m[1] : 'nfl'; }

const server = http.createServer((req, res) => {
  const u = req.url || '/';
  const qi = u.indexOf('?');
  const pathname = qi >= 0 ? u.slice(0, qi) : u;
  const qs = qi >= 0 ? u.slice(qi) : '';

  // terminal-owned endpoints -------------------------------------------------
  if (pathname === '/health' || pathname === '/api/health') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"ok":true,"app":"nfl.ncaaf"}'); }
  if (pathname === '/icon.svg' || pathname === '/favicon.ico') { res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' }); return res.end(LOGO); }
  const dm = /^\/_board\/(broadcast\.(css|js))$/.exec(pathname);
  if (dm) return serveDesign(req, res, dm[1], dm[2]);
  if (pathname === '/manifest.webmanifest') { res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' }); return res.end(MANIFEST); }

  // One device id for the whole board, minted silently on first sight (no prompt, no sign-out).
  const who = Board.identify(req, isHttps(req));
  if (who.cookie) res.setHeader('set-cookie', [who.cookie]);
  // A device the owner blocked or signed out from the Admin Center. Silent: it just gets the ordinary
  // sign-in screen (a blocked one keeps getting it, whatever code it tries).
  const verdict = Board.gate(who);
  if (verdict) {
    clearAuth(res, isHttps(req));
    if (/^\/(nfl|ncaaf|mlb)\/api\//.test(pathname) || pathname.startsWith('/admin/api/')) { res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end('{"error":"Sign in"}'); }
    if (verdict === 'signout' && pathname !== '/') { res.writeHead(303, { location: '/', 'cache-control': 'no-store' }); return res.end(); }
    return page(res, 200, {});
  }

  if (pathname === '/logout') { Board.entrance(who, role(req), 'logout'); clearAuth(res, isHttps(req)); res.writeHead(303, { location: '/' }); return res.end(); }

  if (pathname === '/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (locked(ip)) { res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '900' }); return res.end('Too many tries. Wait 15 minutes.'); }
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      const raw = new URLSearchParams(body).get('code') || '';
      /* Forgiving on purpose: guests are handed a LINK, not a code, and when they land here in a second
         browser they paste that link or type the code with a phone's auto-capital or a trailing space.
         Accept the code as typed, trimmed, or lower-cased, and the guest link (whole URL or its token). */
      const tries = [...new Set([raw, raw.trim(), raw.trim().toLowerCase()])].filter(Boolean);
      const tok = (/(?:\/g\/)?([a-f0-9]{24})\b/i.exec(raw.trim()) || [])[1];
      let kind = null;
      if (OWNER_HASH && tries.some((c) => safeEq(hashCode(c), OWNER_HASH))) kind = 'owner';
      else if (GUEST_HASH && tries.some((c) => safeEq(hashCode('guest:' + c), GUEST_HASH))) kind = 'guest';
      else if (GUEST_LINK && tok && safeEq(tok.toLowerCase(), GUEST_LINK)) kind = 'guest';
      if (!kind) { bad(ip); Board.entrance(who, null, 'wrong'); return page(res, 401, { wrong: true }); }
      fails.delete(ip);
      Board.entrance(who, kind, kind === 'owner' ? 'code' : 'guest-code');
      setAuth(res, kind, isHttps(req));
      res.writeHead(303, { location: `/${lastSport(req)}/`, 'cache-control': 'no-store' });
      res.end();
    });
    return;
  }

  // one-tap guest link: /g/<token>
  const gm = /^\/g\/([a-f0-9]{16,32})$/.exec(pathname);
  if (gm && req.method === 'GET') {
    if (GUEST_LINK && safeEq(gm[1], GUEST_LINK)) { Board.entrance(who, 'guest', 'guest-link'); setAuth(res, 'guest', isHttps(req)); res.writeHead(303, { location: '/nfl/', 'cache-control': 'no-store' }); return res.end(); }
    Board.entrance(who, null, 'bad-link');
    return page(res, 401, { wrong: true });
  }

  let r = role(req);
  if (Board.handle(req, res, pathname, qs, r)) return;

  // Open boards: a browser with no sign-in becomes a guest on the spot — cookies set on this response and
  // added to this request, so the engine sees a guest now, not after a reload. Admin is never granted here.
  if (GATED && !r && OPEN_BOARDS && GUEST_HASH && (pathname === '/' || /^\/(nfl|ncaaf|mlb)(\/|$)/.test(pathname))) {
    setAuth(res, 'guest', isHttps(req));
    req.headers.cookie = `${req.headers.cookie ? req.headers.cookie + '; ' : ''}ps_guest=${GUEST_HASH}; hl_guest=${GUEST_HASH}; bbl_guest=${BBL_GUEST}`;
    r = 'guest';
    Board.entrance(who, 'guest', 'open');
  }
  // Admin's own way in. Also where a blocked device ends up.
  if (pathname === '/login' && req.method === 'GET') return page(res, 200, {});

  if (pathname === '/') {
    // A device we already know landing on the sign-in screen is worth a line; a stranger's first hit is not
    // (scanners would fill the list).
    if (GATED && !r) { if (!who.cookie) Board.entrance(who, null, 'gate'); return page(res, 200, {}); }
    res.writeHead(302, { location: `/${lastSport(req)}/`, 'cache-control': 'no-store' });
    return res.end();
  }

  const m = /^\/(nfl|ncaaf|mlb)(\/.*)?$/.exec(pathname);
  if (!m) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  const s = SPORTS[m[1]];
  if (m[2] === undefined) { res.writeHead(301, { location: `${s.base}/` }); return res.end(); }

  // gate the boards
  if (GATED && !r && !OPEN.test(pathname)) {
    if (pathname.startsWith(`/${m[1]}/api/`)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"Sign in"}'); }
    res.writeHead(302, { location: '/', 'cache-control': 'no-store' }); return res.end();
  }

  // proxy to the engine (prefix stripped)
  const sp = m[1];
  const enginePath = m[2] || '/';
  const forwardPath = enginePath + qs;
  const headers = { ...req.headers, host: `127.0.0.1:${s.port}` };
  const t0 = Date.now();
  const isStream = enginePath === '/api/stream';
  // The owner's copy of a board page gets an Admin Center link in the sport bar; ask for it uncompressed so
  // it can be edited in flight. Guests' pages pass through untouched.
  const adminLink = r === 'owner' && req.method === 'GET' && (enginePath === '/' || enginePath === '/index.html');
  if (adminLink) headers['accept-encoding'] = 'identity';
  const send = (body) => {
    const pr = http.request({ host: '127.0.0.1', port: s.port, method: req.method, path: forwardPath, headers }, (pres) => {
      const h = { ...pres.headers };
      const sc = [].concat(res.getHeader('set-cookie') || [], h['set-cookie'] || []);
      if ((h['content-type'] || '').includes('text/html')) sc.push(`sport=${sp}; Path=/; Max-Age=31536000; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
      if (sc.length) h['set-cookie'] = sc;
      Board.request(who, r, sp, req.method, enginePath, pres.statusCode, Date.now() - t0);
      if (isStream && pres.statusCode === 200) { Board.streamOpen(who.dev); res.on('close', () => Board.streamClose(who.dev)); }
      if (adminLink && (h['content-type'] || '').includes('text/html') && !h['content-encoding']) {
        const parts = [];
        pres.on('data', (c) => parts.push(c));
        pres.on('end', () => {
          const html = Buffer.concat(parts).toString('utf8').replace('</nav></div><style>', `</nav>${ADMIN_PILL}</div><style>`);
          const buf = Buffer.from(html);
          h['content-length'] = String(buf.length);
          res.writeHead(pres.statusCode || 200, h);
          res.end(buf);
        });
        return;
      }
      res.writeHead(pres.statusCode || 502, h);
      pres.pipe(res);
    });
    pr.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Upstream not ready'); });
    if (body) pr.end(body); else req.pipe(pr);
  };

  // The board's own screen/tap log (js/tel.js) passes through here: read it for the Admin Center, then hand
  // it on unchanged. MLB's engine has no endpoint for it, so the terminal answers that one itself.
  if (enginePath === '/api/telemetry' && req.method === 'POST' && r) {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n <= 65536) parts.push(c); });
    req.on('end', () => {
      const body = Buffer.concat(parts);
      Board.client(who, r, sp, body.toString('utf8'));
      if (sp === 'mlb') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
      headers['content-length'] = String(body.length);
      send(body);
    });
    return;
  }
  send(null);
});

// The owner-only way in, placed at the end of the sport bar. Styled from the board's own tokens.
const ADMIN_PILL = '<a class="xadm" href="/admin" aria-label="Admin Center">Admin</a>'
  + '<style>#xsport .xadm{margin-left:auto;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 14px;border-radius:10px;border:1px solid var(--line);'
  + 'font-size:13px;font-weight:600;color:var(--ink);text-decoration:none;background:var(--fill)}#xsport .xadm:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent)}'
  + '#xsport .xadm:hover{border-color:var(--ink-3,var(--line))}@media (max-width:560px){#xsport .xadm{padding:0 10px}}</style>';

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 76000;
server.listen(PORT, () => {
  console.log(`[terminal] data -> ${DATA_DIR}${process.env.RAILWAY_VOLUME_MOUNT_PATH && !DATA_DIR.startsWith(path.resolve(process.env.RAILWAY_VOLUME_MOUNT_PATH)) ? '  (WARNING: not on the volume)' : ''}`);
  console.log(`[terminal] ${BRAND} on :${PORT}  gated=${GATED} guest=${!!GUEST_HASH}${GUEST_LINK ? `  guest-link=/g/${GUEST_LINK}` : ''}`);
});

let down = false;
function shutdown() { if (down) return; down = true; Board.close(); for (const k of Object.keys(children)) { const c = children[k]; if (c) { c.removeAllListeners('exit'); try { c.kill('SIGTERM'); } catch {} } } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
