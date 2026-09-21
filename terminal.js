/*
 * NFL.NCAAF — the terminal.
 *
 * One Railway service, one origin. This front process spawns the two sport engines as children on
 * internal ports and reverse-proxies to them by path:
 *
 *     /nfl/*    -> the Pick Six engine       (child, BASE_PATH=/nfl,   DATA_DIR=<data>/nfl)
 *     /ncaaf/*  -> the Hook & Ladder engine   (child, BASE_PATH=/ncaaf, DATA_DIR=<data>/ncaaf)
 *
 * The proxy strips the /nfl or /ncaaf prefix before forwarding, so each engine routes exactly as it
 * does standalone; it only emits its own prefix on OUTPUT urls (cookies, redirects, manifest, the
 * injected <base href> and the sport switcher). Same origin means cookies, auth and the SSE live feed
 * all just work, and a bet placed on either tab writes to that sport's own volume.
 *
 * Zero dependencies. Node 18+. Streaming is native (SSE is piped, never buffered).
 */
'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.PORT) || 4000;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');

// A single peer secret shared by both children so the Security Center "All apps" toggle can read across
// the two sport engines over localhost. If one is provided in the environment it wins (so it can match a
// value set elsewhere); otherwise a per-boot secret is fine — the peer endpoint is localhost-only here.
const PEER_SECRET = process.env.TELEMETRY_PEER_SECRET || crypto.randomBytes(32).toString('hex');

const SPORTS = {
  nfl:   { dir: 'nfl',   base: '/nfl',   label: 'NFL',   port: 5061, appId: 'pick-six',       sibling: 'ncaaf' },
  ncaaf: { dir: 'ncaaf', base: '/ncaaf', label: 'NCAAF', port: 5062, appId: 'hook-and-ladder', sibling: 'nfl' },
};

// Per-sport env overrides: NFL_ACCESS_CODE / NCAAF_ACCESS_CODE fall back to a shared ACCESS_CODE, etc.
// Keeps a single knob simple while allowing a different code per sport if ever wanted.
function pick(sportKey, name) {
  const up = sportKey.toUpperCase();
  return process.env[`${up}_${name}`] != null ? process.env[`${up}_${name}`] : process.env[name];
}

function childEnv(key) {
  const s = SPORTS[key];
  const sib = SPORTS[s.sibling];
  const env = { ...process.env };
  env.PORT = String(s.port);
  env.BASE_PATH = s.base;
  env.DATA_DIR = path.join(DATA_DIR, s.dir);
  env.APP_ID = s.appId;
  // Cross-sport Security Center aggregation, over localhost, between the two engines.
  env.TELEMETRY_PEER_SECRET = PEER_SECRET;
  env.TELEMETRY_PEER_URL = `http://127.0.0.1:${sib.port}`;
  env.TELEMETRY_PEER_NAME = sib.appId;
  // Optional per-sport overrides for a handful of knobs.
  for (const k of ['ACCESS_CODE', 'OWNER_NAME', 'OWNER_CODE']) {
    const v = pick(key, k);
    if (v != null) env[k] = v; else delete env[k];
  }
  return env;
}

const children = {};
function launch(key) {
  const s = SPORTS[key];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, s.dir),
    env: childEnv(key),
    stdio: 'inherit',
  });
  children[key] = child;
  child.on('exit', (code, sig) => {
    console.log(`[terminal] ${key} engine exited (code=${code} sig=${sig}); restarting in 1s`);
    setTimeout(() => launch(key), 1000);
  });
  console.log(`[terminal] ${key} engine -> 127.0.0.1:${s.port}  base=${s.base}  data=${path.join(DATA_DIR, s.dir)}`);
}
Object.keys(SPORTS).forEach(launch);

function lastSport(req) {
  const m = /(?:^|;\s*)sport=(nfl|ncaaf)/.exec(req.headers.cookie || '');
  return m ? m[1] : 'nfl';
}

const server = http.createServer((req, res) => {
  const u = req.url || '/';
  const qi = u.indexOf('?');
  const pathname = qi >= 0 ? u.slice(0, qi) : u;
  const qs = qi >= 0 ? u.slice(qi) : '';

  // Health: the terminal is up once it is serving; the engines self-restart if they fall over.
  if (pathname === '/health' || pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('{"ok":true,"app":"nfl.ncaaf"}');
  }

  // Root -> the sport this browser last used (default NFL).
  if (pathname === '/') {
    res.writeHead(302, { location: `/${lastSport(req)}/`, 'cache-control': 'no-store' });
    return res.end();
  }

  const m = /^\/(nfl|ncaaf)(\/.*)?$/.exec(pathname);
  if (!m) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
  const key = m[1];
  const s = SPORTS[key];

  // Bare /nfl -> /nfl/ so the page url matches its <base href> and in-page #hash links stay same-document.
  if (m[2] === undefined) { res.writeHead(301, { location: `${s.base}/` }); return res.end(); }

  const forwardPath = (m[2] || '/') + qs;                    // prefix stripped: the engine sees itself at root
  const isHttps = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const headers = { ...req.headers, host: `127.0.0.1:${s.port}` };

  const pr = http.request(
    { host: '127.0.0.1', port: s.port, method: req.method, path: forwardPath, headers },
    (pres) => {
      const h = { ...pres.headers };
      // Remember the sport on page loads, so a bare visit to / returns here next time.
      if ((h['content-type'] || '').includes('text/html')) {
        const sc = h['set-cookie'] ? (Array.isArray(h['set-cookie']) ? h['set-cookie'].slice() : [h['set-cookie']]) : [];
        sc.push(`sport=${key}; Path=/; Max-Age=31536000; SameSite=Lax${isHttps ? '; Secure' : ''}`);
        h['set-cookie'] = sc;
      }
      res.writeHead(pres.statusCode || 502, h);
      pres.pipe(res);                                         // native streaming — SSE flows through untouched
    }
  );
  pr.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Upstream not ready'); });
  req.pipe(pr);
});

// SSE connections are long-lived; don't let the server time them out.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 76000;

server.listen(PORT, () => {
  console.log(`[terminal] NFL.NCAAF listening on :${PORT}  (data root ${DATA_DIR})`);
});

// Take the engines down with the terminal so a redeploy or a local Ctrl-C never leaves an orphan holding
// an internal port (which would make the next boot's children crash-loop on EADDRINUSE).
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const key of Object.keys(children)) {
    const c = children[key];
    if (c) { c.removeAllListeners('exit'); try { c.kill('SIGTERM'); } catch { /* already gone */ } }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));
