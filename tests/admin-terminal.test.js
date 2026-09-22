'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const root = path.resolve(__dirname, '..');
const terminalFile = path.join(root, 'terminal.js');
const requireFromTerminal = createRequire(terminalFile);
// Test-only values. Never read deployed credentials or start an engine/listening socket.
const ADMIN_PATH = '/owner-7f42e93a61dc4ef79b235cca';
const ADMIN_CODE = 'test-only-owner-code';
const GUEST_CODE = 'test-only-guest-code';
const ORIGIN = 'https://board.example';
const hashCode = value => crypto.createHash('sha256').update(`hl:${value}`).digest('hex');
const ownerCookie = `ps_code=${hashCode(ADMIN_CODE)}`;
const guestCookie = `ps_guest=${hashCode(`guest:${GUEST_CODE}`)}`;

function enginePage(sport) {
  const source = fs.readFileSync(path.join(root, sport, 'server.js'), 'utf8');
  const sportbar = source.match(/const SPORTS_NAV[\s\S]*?\+ '<\/style>'\);/);
  assert.ok(sportbar, `${sport} engine sport bar must be available for a realistic proxy response`);
  const nav = vm.runInNewContext(sportbar[0] + '\nSPORTBAR;', { BASE: `/${sport}` });
  return fs.readFileSync(path.join(root, sport, 'public/index.html'), 'utf8')
    .replace('<head>', `<head><base href="/${sport}/">`).replace('<body>', '<body>' + nav);
}

function terminal(env = {}) {
  let handler, boardConfig;
  const forwarded = [], boardCalls = [], entrances = [];
  const board = {
    identify: () => ({ dev: '0123456789abcdef01234567', ip: '198.51.100.10' }),
    gate: () => null,
    entrance: (...args) => entrances.push(args),
    request() {}, client() {}, streamOpen() {}, streamClose() {}, close() {},
    handle(req, res, pathname, qs, role) {
      boardCalls.push({ pathname, qs, role, method: req.method });
      const base = boardConfig.adminPath;
      if (!base || (pathname !== base && !pathname.startsWith(`${base}/`))) return false;
      // Board's independent authorization has its own tests; preserve that contract here.
      if (role !== 'owner') { res.writeHead(404, { 'cache-control': 'no-store' }); res.end('Not found'); return true; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ fixture: 'admin', role }));
      return true;
    },
  };
  const fixtureHttp = {
    createServer(fn) {
      assert.equal(handler, undefined, 'only one public handler is registered'); handler = fn;
      return { listen() {}, close(cb) { cb?.(); }, on() {} };
    },
    request(options, callback) {
      forwarded.push(options);
      return new Writable({
        write(_chunk, _encoding, done) { done(); },
        final(done) {
          const response = new PassThrough();
          const isPage = /^\/(?:index\.html)?(?:\?|$)/.test(options.path);
          response.statusCode = 200;
          response.headers = { 'content-type': isPage ? 'text/html; charset=utf-8' : 'application/json',
            'cache-control': 'public, max-age=600', etag: '"upstream-public-fixture"' };
          const sport = options.port === 5063 ? 'mlb' : options.port === 5062 ? 'ncaaf' : 'nfl';
          const body = isPage ? Buffer.from(enginePage(sport)) : Buffer.from('{"ok":true}');
          callback(response); response.end(body); done();
        },
      });
    },
  };
  const fixtureProcess = {
    env: { ACCESS_CODE: ADMIN_CODE, GUEST_CODE, ADMIN_PATH, OPEN_BOARDS: '1', DATA_DIR: '/tmp/unused-admin-terminal-fixture', ...env },
    execPath: process.execPath, on() {}, exit() {},
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'node:http') return fixtureHttp;
      if (name === 'node:child_process') return { spawn: () => Object.assign(new EventEmitter(), { kill() {} }) };
      if (name === './board') return config => { boardConfig = config; return board; };
      if (name === './shared/client-ip') return {
        clientIp: () => '198.51.100.10', forwardClientIpHeaders: req => ({ ...req.headers }),
      };
      if (name === 'node:zlib') return {
        constants: { BROTLI_PARAM_QUALITY: 1 }, brotliCompressSync: data => Buffer.from(data), gzipSync: data => Buffer.from(data),
      };
      return requireFromTerminal(name);
    },
    __dirname: root, process: fixtureProcess, Buffer, URL, URLSearchParams,
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(fs.readFileSync(terminalFile, 'utf8'), context, { filename: terminalFile });
  assert.equal(typeof handler, 'function');

  async function request(url, { method = 'GET', cookie, headers = {}, body = '' } = {}) {
    const req = new PassThrough();
    req.url = url; req.method = method;
    req.socket = { remoteAddress: '198.51.100.10' };
    req.headers = { host: 'board.example', 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}), ...headers };
    const responseHeaders = {}, chunks = [];
    const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.setHeader = (name, value) => { responseHeaders[name.toLowerCase()] = value; };
    res.getHeader = name => responseHeaders[name.toLowerCase()];
    res.removeHeader = name => { delete responseHeaders[name.toLowerCase()]; };
    res.writeHead = (status, values = {}) => {
      res.statusCode = status; res.headersSent = true;
      for (const [key, value] of Object.entries(values)) res.setHeader(key, value);
      return res;
    };
    const done = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`HTTP handler did not finish ${method} ${url}`)), 2000);
      res.once('finish', () => { clearTimeout(timeout); resolve(); });
      res.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    handler(req, res); req.end(body); await done;
    return { status: res.statusCode, headers: responseHeaders, body: Buffer.concat(chunks).toString('utf8') };
  }
  return { request, forwarded, boardCalls, entrances, board };
}

function noOwnerCookies(response) {
  assert.doesNotMatch([].concat(response.headers['set-cookie'] || []).join('\n'), /(?:ps_code|hl_code|bbl_access)=[^;]/);
}
function notFound(response) {
  assert.equal(response.status, 404);
  assert.equal(response.headers.location, undefined, 'a rejected route must not disclose the private entrance in a redirect');
  assert.ok(!response.body.includes(ADMIN_PATH), 'a rejected route must not disclose the private entrance in its body');
  noOwnerCookies(response);
}

test('public admin and login routes stay undiscoverable for every session role', async () => {
  const app = terminal();
  for (const cookie of [undefined, guestCookie, ownerCookie]) {
    for (const url of ['/admin', '/admin/', '/admin/api/board', '/admin/api/export', '/login']) {
      notFound(await app.request(url, { cookie }));
      notFound(await app.request(url, { cookie, method: 'POST', body: `code=${ADMIN_CODE}`, headers: { origin: ORIGIN } }));
    }
  }
  assert.equal(app.forwarded.length, 0, 'old login requests never reach any child engine');
});

test('private dashboard and admin API require an authenticated owner', async () => {
  const app = terminal();
  for (const cookie of [undefined, guestCookie, 'ps_code=invalid', 'bbl_access=invalid']) {
    for (const suffix of ['', '/', '/api/board', '/api/security', '/api/export']) {
      notFound(await app.request(ADMIN_PATH + suffix, { cookie }));
    }
  }
  const before = app.boardCalls.length;
  const page = await app.request(ADMIN_PATH, { cookie: ownerCookie });
  assert.equal(page.status, 200);
  assert.equal(app.boardCalls.length, before + 1);
  assert.equal(app.boardCalls.at(-1).role, 'owner');
  assert.equal((await app.request(`${ADMIN_PATH}/api/board`, { cookie: ownerCookie })).status, 200);
  assert.equal(app.forwarded.length, 0);
});

test('private sign-in accepts the owner code only and mints protected cookies for all sports', async () => {
  const app = terminal();
  const page = await app.request(`${ADMIN_PATH}/login`);
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(`action="${ADMIN_PATH}/login"`));
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'strict-origin', 'the browser must retain Origin for the login form without sending its private path');
  const guest = await app.request(`${ADMIN_PATH}/login`, { method: 'POST', headers: { origin: ORIGIN }, body: `code=${GUEST_CODE}` });
  assert.equal(guest.status, 401); noOwnerCookies(guest);
  const owner = await app.request(`${ADMIN_PATH}/login`, { method: 'POST', headers: { origin: ORIGIN }, body: `code=${ADMIN_CODE}` });
  assert.equal(owner.status, 303);
  assert.equal(owner.headers.location, ADMIN_PATH);
  const cookies = [].concat(owner.headers['set-cookie'] || []);
  for (const name of ['ps_code', 'hl_code', 'bbl_access']) {
    const value = cookies.find(item => item.startsWith(`${name}=`));
    assert.ok(value, `${name} authenticated cookie must be set`);
    assert.match(value, /; HttpOnly/); assert.match(value, /; Secure/); assert.match(value, /; SameSite=Lax/);
  }
  const authenticated = cookies.map(value => value.split(';')[0]).join('; ');
  assert.equal((await app.request(ADMIN_PATH, { cookie: authenticated })).status, 200);
});

test('cross-site private sign-ins cannot create owner sessions', async () => {
  const app = terminal();
  for (const headers of [{}, { origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site', origin: ORIGIN }, { 'sec-fetch-site': 'same-site', origin: ORIGIN }]) {
    const response = await app.request(`${ADMIN_PATH}/login`, { method: 'POST', headers, body: `code=${ADMIN_CODE}` });
    assert.equal(response.status, 403); noOwnerCookies(response);
  }
  assert.equal(app.entrances.filter(call => call[1] === 'owner').length, 0);
  const sameOriginMetadata = await app.request(`${ADMIN_PATH}/login`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' }, body: `code=${ADMIN_CODE}` });
  assert.equal(sameOriginMetadata.status, 303, 'same-origin browser fetch metadata can authorize a request without Origin');
});

test('closed boards retain a guest-only public entrance without an owner-code bypass', async () => {
  const app = terminal({ OPEN_BOARDS: '0' });
  const page = await app.request('/login');
  assert.equal(page.status, 200); assert.ok(!page.body.includes(ADMIN_PATH));
  const owner = await app.request('/login', { method: 'POST', headers: { origin: ORIGIN }, body: `code=${ADMIN_CODE}` });
  assert.equal(owner.status, 401); noOwnerCookies(owner);
  const guest = await app.request('/login', { method: 'POST', headers: { origin: ORIGIN }, body: `code=${GUEST_CODE}` });
  assert.equal(guest.status, 303); noOwnerCookies(guest);
  assert.ok([].concat(guest.headers['set-cookie'] || []).some(cookie => cookie.startsWith('ps_guest=')));
  assert.ok(!String(guest.headers.location).includes(ADMIN_PATH));
});

test('per-sport password handlers and normalized aliases never reach child engines', async () => {
  const app = terminal();
  for (const sport of ['nfl', 'ncaaf', 'mlb']) {
    for (const route of ['login', 'access', 'x/../login', 'x/%2e%2e/access']) {
      for (const cookie of [undefined, guestCookie, ownerCookie]) {
        notFound(await app.request(`/${sport}/${route}`, { method: 'POST', cookie, headers: { origin: ORIGIN }, body: `code=${ADMIN_CODE}` }));
      }
    }
    notFound(await app.request(`/${sport}/login`, { cookie: ownerCookie }));
    notFound(await app.request(`/${sport}/access`, { cookie: ownerCookie }));
  }
  for (const url of [`/mlb/?code=${ADMIN_CODE}`, `/mlb/?%63ode=${ADMIN_CODE}`, `/mlb/index.html?code=${ADMIN_CODE}`]) {
    notFound(await app.request(url, { cookie: guestCookie }));
  }
  assert.equal(app.forwarded.length, 0, 'normalization must happen before authorization and proxy dispatch');
});

test('existing owner launch tokens keep their engine route and query unchanged', async () => {
  const app = terminal();
  const url = '/nfl/?c=fixture-launch-token&view=board';
  assert.equal((await app.request(url, { cookie: ownerCookie })).status, 200);
  assert.equal(app.forwarded.at(-1).path, '/?c=fixture-launch-token&view=board');
});

test('privileged engine reads require owner auth, peer endpoints are never public, and writes require same origin', async () => {
  const app = terminal();
  for (const sport of ['nfl', 'ncaaf', 'mlb']) {
    for (const suffix of ['/api/group', '/api/invites', '/api/security/query']) {
      notFound(await app.request(`/${sport}${suffix}`, { cookie: guestCookie }));
      const own = await app.request(`/${sport}${suffix}`, { cookie: ownerCookie });
      assert.equal(own.status, 200);
    }
    for (const suffix of ['/api/security/peer/query', '/api/security/peer/security', '/api/x/../security/peer/query']) {
      notFound(await app.request(`/${sport}${suffix}`, { cookie: ownerCookie }));
    }
    for (const suffix of ['/api/group/sweep', '/api/invites', '/api/security/action']) {
      const before = app.forwarded.length;
      const rejected = await app.request(`/${sport}${suffix}`, { cookie: ownerCookie, method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' });
      assert.equal(rejected.status, 403); assert.equal(app.forwarded.length, before);
      const accepted = await app.request(`/${sport}${suffix}`, { cookie: ownerCookie, method: 'POST', headers: { origin: ORIGIN }, body: '{}' });
      assert.equal(accepted.status, 200); assert.equal(app.forwarded.length, before + 1);
    }
  }
});

test('owner board pages expose a private link with cache isolation; guest and anonymous pages never do', async () => {
  const app = terminal();
  for (const sport of ['nfl', 'ncaaf', 'mlb']) {
    const owner = await app.request(`/${sport}/`, { cookie: ownerCookie, headers: { 'if-none-match': '"upstream-public-fixture"', 'if-modified-since': 'Tue, 22 Sep 2026 00:00:00 GMT' } });
    assert.equal(app.forwarded.at(-1).headers['if-none-match'], undefined);
    assert.equal(app.forwarded.at(-1).headers['if-modified-since'], undefined);
    assert.equal(owner.status, 200); assert.ok(owner.body.includes(`href="${ADMIN_PATH}"`), `${sport} owner page must include its private Admin link`);
    assert.equal(owner.headers['cache-control'], 'no-store');
    assert.match(String(owner.headers.vary).toLowerCase(), /(?:^|[,\s])cookie(?:$|[,\s])/);
    assert.equal(owner.headers['referrer-policy'], 'no-referrer');
    assert.equal(owner.headers.etag, undefined);
    assert.equal(owner.headers['last-modified'], undefined);
    for (const cookie of [guestCookie, undefined]) {
      const guest = await app.request(`/${sport}/`, { cookie });
      assert.equal(guest.status, 200); assert.ok(!guest.body.includes(ADMIN_PATH));
      assert.doesNotMatch(guest.body, /href="\/admin(?:["/])|location\.(?:replace|assign)\(['"]\/admin/);
      assert.equal(guest.headers['cache-control'], 'no-store', 'publicly cacheable guest HTML cannot later mask an owner page');
      assert.match(String(guest.headers.vary).toLowerCase(), /(?:^|[,\s])cookie(?:$|[,\s])/);
    }
  }
});

test('missing ACCESS_CODE fails closed for private admin even when development boards remain open', async () => {
  const app = terminal({ ACCESS_CODE: '' });
  for (const url of [ADMIN_PATH, `${ADMIN_PATH}/login`, `${ADMIN_PATH}/api/board`, '/admin', '/login']) {
    notFound(await app.request(url, { cookie: ownerCookie }));
  }
  const page = await app.request('/nfl/');
  assert.equal(page.status, 200); assert.ok(!page.body.includes(ADMIN_PATH));
  for (const suffix of ['/api/group', '/api/invites', '/api/security/query']) {
    notFound(await app.request(`/nfl${suffix}`));
  }
});


test('legacy Admin and Security hashes use only the owner-injected link and otherwise return to the board', async () => {
  const app = terminal();
  for (const sport of ['nfl', 'ncaaf']) {
    for (const [cookie, destination] of [[ownerCookie, ADMIN_PATH], [guestCookie, '#board']]) {
      const page = await app.request(`/${sport}/`, { cookie });
      const script = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('function go(h)'))?.[1];
      assert.ok(script, `${sport} legacy hash handler must be included in the served page`);
      const hasPrivateLink = page.body.includes(`class="xadm" href="${ADMIN_PATH}"`);
      const listeners = {}, redirects = [];
      const location = { hash: '#admin', replace: value => redirects.push(value) };
      vm.runInNewContext(script, {
        location,
        document: { querySelector: () => hasPrivateLink ? { getAttribute: () => ADMIN_PATH } : null },
        addEventListener: (event, fn) => { listeners[event] = fn; },
      });
      assert.deepEqual(redirects, [destination]);
      location.hash = '#security'; listeners.hashchange();
      assert.equal(redirects.at(-1), hasPrivateLink ? `${ADMIN_PATH}#security` : '#board');
    }
  }
});

test('private sign-in remains case-sensitive and rate-limited while public boards continue working', async () => {
  const app = terminal();
  for (let attempt = 0; attempt < 10; attempt++) {
    const failed = await app.request(`${ADMIN_PATH}/login`, {
      method: 'POST', headers: { origin: ORIGIN }, body: `code=${ADMIN_CODE.toUpperCase()}`,
    });
    assert.equal(failed.status, 401); noOwnerCookies(failed);
  }
  const locked = await app.request(`${ADMIN_PATH}/login`, {
    method: 'POST', headers: { origin: ORIGIN }, body: `code=${ADMIN_CODE}`,
  });
  assert.equal(locked.status, 429); assert.equal(locked.headers['retry-after'], '900'); noOwnerCookies(locked);
  assert.equal((await app.request('/nfl/', { cookie: guestCookie })).status, 200);
});

test('missing private-path configuration disables the dashboard and its public-page link', async () => {
  const app = terminal({ ADMIN_PATH: '' });
  for (const url of [ADMIN_PATH, `${ADMIN_PATH}/login`, '/admin', '/login']) {
    notFound(await app.request(url, { cookie: ownerCookie }));
  }
  for (const sport of ['nfl', 'ncaaf', 'mlb']) {
    const page = await app.request(`/${sport}/`, { cookie: ownerCookie });
    assert.equal(page.status, 200);
    assert.ok(!page.body.includes(ADMIN_PATH));
    assert.doesNotMatch(page.body, /<a class="xadm"/);
  }
});
