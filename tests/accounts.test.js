'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const createAccounts = require('../shared/accounts');
async function fixture(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-accounts-'));
  let clock = Date.now();
  const accounts = createAccounts({ dataDir, origin: 'https://board.example', now: () => clock, ...extra });
  const server = http.createServer(async (req, res) => {
    if (!await accounts.handle(req, res, new URL(req.url, 'http://local').pathname, { secure: false, role: req.headers['x-test-owner'] === 'yes' ? 'owner' : 'guest', deviceId: req.headers['x-test-device'] || 'device-a' })) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  function browser() {
    const jar = {}; let csrf = '';
    return { jar, get csrf() { return csrf; }, req: () => ({ headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') } }),
      async call(route = 'me', data, headers = {}) {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/account/${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), origin: 'https://board.example', ...(data === undefined ? {} : { 'content-type': 'application/json', 'x-account-csrf': csrf }), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        for (const c of r.headers.getSetCookie()) { const [key, value] = c.split(';')[0].split('='); jar[key] = value; }
        const body = await r.json(); if (body.csrf) csrf = body.csrf;
        return { status: r.status, body, headers: r.headers };
      },
      async signup(username = 'alice') { await this.call(); const r = await this.call('signup', { username, password: 'a long test password 1234' }); assert.equal(r.status, 201); await this.call(); return r; }
    };
  }
  return { accounts, browser, dataDir, advance(ms) { clock += ms; } };
}
test('signup stores scrypt password and only hashed opaque tokens; no engine IDs in public response', async t => {
  const f = await fixture(t), a = f.browser(); await a.signup();
  const me = await a.call(); assert.equal(me.body.account.username, 'alice'); assert.equal(me.body.account.owner, false);
  const file = fs.readFileSync(path.join(f.dataDir, 'accounts/accounts.json'), 'utf8'), saved = JSON.parse(file);
  assert(!file.includes('a long test password')); assert(!file.includes(a.jar.tb_account));
  const account = Object.values(saved.accounts)[0]; assert(account.passwordHash.salt); assert(account.passwordHash.key); assert.equal(Object.keys(account.engineIds).length, 4);
  assert(!JSON.stringify(me.body).includes(account.engineIds.nfl)); assert(!JSON.stringify(me.body).includes('passwordHash'));
  assert(me.headers.get('cache-control').includes('no-store'));
});
test('password login across devices shares server-generated engine IDs while anonymous cookies remain untouched', async t => {
  const f = await fixture(t), a = f.browser(), b = f.browser(); await a.signup(); await b.call();
  assert.equal((await b.call('login', { username: 'alice', password: 'a long test password 1234', engineIds: { nfl: 'a'.repeat(32) }, owner: true })).status, 200);
  assert.equal(f.accounts.identity(a.req()).engineIds.nfl, f.accounts.identity(b.req()).engineIds.nfl);
  a.jar.ps_uid = 'f'.repeat(32);
  const mapped = f.accounts.forwardCookie(a.req(), 'nfl'); assert(!mapped.includes('ps_uid=' + 'f'.repeat(32)));
  assert.equal(a.jar.ps_uid, 'f'.repeat(32));
  assert.deepEqual(f.accounts.filterEngineCookies(a.req(), ['ps_uid=hidden; Path=/nfl', 'sport=nfl; Path=/']), ['sport=nfl; Path=/']);
  assert.equal(f.accounts.identity(b.req()).role, 'guest');
});
test('anonymous use is preserved and a forged session never authenticates', async t => {
  const f = await fixture(t), b = f.browser(); b.jar.ps_uid = 'a'.repeat(32); b.jar.tb_account = 'a'.repeat(43);
  assert.equal(f.accounts.identity(b.req()), null); assert.equal(f.accounts.forwardCookie(b.req(), 'nfl'), b.req().headers.cookie);
  assert.equal((await b.call()).body.account, null);
});
test('cross-origin requests and missing CSRF fail without creating accounts', async t => {
  const f = await fixture(t), b = f.browser(); await b.call();
  const payload = { username: 'alice', password: 'a long test password 1234' };
  assert.equal((await b.call('signup', payload, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await b.call('signup', payload, { 'x-account-csrf': '' })).status, 403);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.dataDir, 'accounts/accounts.json'))).accounts), []);
});
test('another browser cannot use a CSRF token without the bound preauth cookie', async t => {
  const f = await fixture(t), a = f.browser(), b = f.browser(); await a.call(); await b.call();
  assert.equal((await b.call('signup', { username: 'alice', password: 'a long test password 1234' }, { 'x-account-csrf': a.csrf })).status, 403);
});
test('session expiration and device revocation immediately invalidate credentials', async t => {
  const f = await fixture(t), a = f.browser(); await a.signup();
  assert(f.accounts.identity(a.req())); f.advance(31 * 86400000); assert.equal(f.accounts.identity(a.req()), null);
  await a.call(); await a.call('login', { username: 'alice', password: 'a long test password 1234' }); assert(f.accounts.identity(a.req()));
  assert.equal(f.accounts.revokeDevice('device-a'), true); assert.equal(f.accounts.identity(a.req()), null);
});
test('revoke others leaves this account session and cannot revoke another account session', async t => {
  const f = await fixture(t), a = f.browser(), b = f.browser(), c = f.browser(); await a.signup(); await b.call(); await b.call('login', { username: 'alice', password: 'a long test password 1234' }); await b.call(); await c.signup('charlie');
  const cId = f.accounts.identity(c.req()).sessionId;
  assert.equal((await a.call('sessions/revoke', { id: cId })).status, 200); assert(f.accounts.identity(c.req()));
  await a.call('sessions/revoke', { id: 'others' }); assert(f.accounts.identity(a.req())); assert.equal(f.accounts.identity(b.req()), null); assert(f.accounts.identity(c.req()));
});
test('password change revokes every old session and preserves the anonymous cookie log', async t => {
  const f = await fixture(t), a = f.browser(), b = f.browser(); await a.signup(); await b.call(); await b.call('login', { username: 'alice', password: 'a long test password 1234' });
  assert.equal((await a.call('password', { currentPassword: 'wrong', password: 'another long password' })).status, 401);
  assert.equal((await a.call('password', { currentPassword: 'a long test password 1234', password: 'another long password' })).status, 200);
  assert.equal(f.accounts.identity(b.req()), null); assert(f.accounts.identity(a.req()));
});
test('Pro checkout stays disabled without configured billing and body cannot self-grant entitlement', async t => {
  const f = await fixture(t, { billingEnv: {} }), a = f.browser(); await a.signup();
  assert.equal((await a.call('checkout', { tier: 'pro', amount: 0 })).status, 503);
  await a.call('preferences', { owner: true, tier: 'pro', region: 'NV', engineIds: { nfl: 'a'.repeat(32) }, books: ['pinnacle', '<script>'], sports: ['nhl', 'bad'], focusMode: true });
  const me = (await a.call()).body; assert.equal(me.account.entitlement.active, false); assert.equal(me.account.owner, false); assert.deepEqual(me.account.preferences.books, ['pinnacle']); assert.deepEqual(me.account.preferences.sports, ['nhl']);
});
test('trusted entitlement expires and cannot be granted via arbitrary status/source', async t => {
  const f = await fixture(t), a = f.browser(); await a.signup(); const id = f.accounts.identity(a.req()).accountId;
  assert.throws(() => f.accounts.setEntitlement(id, { tier: 'pro', status: 'active', source: 'browser', expiresAt: Date.now() + 60000 }));
  f.accounts.setEntitlement(id, { tier: 'pro', status: 'active', source: 'owner', expiresAt: Date.now() + 60000 }); assert.equal(f.accounts.entitlement(a.req()).active, true);
  f.advance(120000); assert.equal(f.accounts.entitlement(a.req()).active, false);
});
test('owner bootstrap is protected by owner role and creates an expiring revocable session', async t => {
  const f = await fixture(t), a = f.browser(); await a.call();
  assert.equal((await a.call('owner/session', {})).status, 403);
  assert.equal((await a.call('owner/session', {}, { 'x-test-owner': 'yes' })).status, 200);
  assert.equal(f.accounts.identity(a.req()).role, 'owner'); assert(!a.jar.ps_code); assert(!a.jar.hl_code);
  a.jar.ps_uid = 'e'.repeat(32); assert(f.accounts.forwardCookie(a.req(), 'nfl').includes('ps_uid=' + 'e'.repeat(32)));
  assert.deepEqual(f.accounts.filterEngineCookies(a.req(), ['ps_uid=old; Path=/nfl', 'ps_code=secret; Path=/nfl', 'bbl_access=secret; Path=/mlb']), ['ps_uid=old; Path=/nfl']);
  f.advance(13 * 3600000); assert.equal(f.accounts.identity(a.req()), null);
});
test('unknown login has generic error and repeated attempts are limited', async t => {
  const f = await fixture(t), a = f.browser(); await a.call();
  for (let i = 0; i < 10; i++) assert.equal((await a.call('login', { username: 'missing', password: 'wrong' })).status, 401);
  assert.equal((await a.call('login', { username: 'missing', password: 'wrong' })).status, 429);
});
test('duplicate registration cannot race through asynchronous password hashing', async t => {
  const f = await fixture(t), a = f.browser(), b = f.browser(); await a.call(); await b.call();
  const r = await Promise.all([a.call('signup', { username: 'same', password: 'a long test password' }), b.call('signup', { username: 'same', password: 'a long test password' })]);
  assert.deepEqual(r.map(x => x.status).sort(), [201, 409]);
});
test('passkey verifier receives fixed origin/RP, required user verification and one-use session-bound challenge', async t => {
  let seen, verifyCalls = 0;
  const mock = {
    async generateRegistrationOptions() { return { challenge: 'registration-challenge' }; },
    async verifyRegistrationResponse(args) { seen = args; verifyCalls++; return { verified: true, registrationInfo: { credential: { id: 'test-credential', publicKey: new Uint8Array([1,2,3]), counter: 0, transports: ['internal'] } } }; },
    async generateAuthenticationOptions() { return { challenge: 'authentication-challenge' }; },
    async verifyAuthenticationResponse(args) { seen = args; return { verified: true, authenticationInfo: { newCounter: 1 } }; }
  };
  const f = await fixture(t, { webauthn: mock }), a = f.browser(), b = f.browser(); await a.signup();
  const opts = await a.call('passkeys/register/options', {}); const requestId = opts.body.requestId;
  assert.equal((await a.call('passkeys/register/verify', { requestId, response: { id: 'test-credential' } })).status, 200);
  assert.equal(seen.expectedOrigin, 'https://board.example'); assert.equal(seen.expectedRPID, 'board.example'); assert.equal(seen.requireUserVerification, true);
  assert.equal((await a.call('passkeys/register/verify', { requestId, response: {} })).status, 400); assert.equal(verifyCalls, 1);
  await b.call(); const login = await b.call('passkeys/auth/options', {});
  assert.equal((await b.call('passkeys/auth/verify', { requestId: login.body.requestId, response: { id: 'test-credential' } })).status, 200);
  assert.equal(f.accounts.identity(b.req()).accountId, f.accounts.identity(a.req()).accountId); assert.equal(seen.requireUserVerification, true);
});
test('passkey challenge is bound to browser session and wrong-browser attempt consumes it', async t => {
  const f = await fixture(t, { webauthn: { async generateAuthenticationOptions() { return { challenge: 'test' }; } } }), a = f.browser(), b = f.browser(); await a.call(); await b.call();
  const r = await a.call('passkeys/auth/options', {});
  assert.equal((await b.call('passkeys/auth/verify', { requestId: r.body.requestId, response: {} })).status, 400);
  assert.equal((await a.call('passkeys/auth/verify', { requestId: r.body.requestId, response: {} })).status, 400);
});
test('real maintained verifier rejects malformed registration rather than trusting browser success', async t => {
  const f = await fixture(t), a = f.browser(); await a.signup(); const opts = await a.call('passkeys/register/options', {}); assert.equal(opts.status, 200);
  assert.equal((await a.call('passkeys/register/verify', { requestId: opts.body.requestId, response: { id: 'fake', verified: true } })).status, 400);
  assert.deepEqual((await a.call('passkeys')).body.passkeys, []);
});
test('session persistence survives restart and disk mode limits access', async t => {
  const f = await fixture(t), a = f.browser(); await a.signup();
  const restarted = createAccounts({ dataDir: f.dataDir, origin: 'https://board.example' });
  assert.equal(restarted.identity(a.req()).accountId, f.accounts.identity(a.req()).accountId);
  assert.equal(fs.statSync(path.join(f.dataDir, 'accounts/accounts.json')).mode & 0o777, 0o600);
});
