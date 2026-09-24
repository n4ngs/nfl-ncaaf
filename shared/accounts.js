'use strict';
// Optional, first-party accounts. Anonymous sport identities remain untouched.
// This file is the sole writer of accounts.json; run one terminal per data volume.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const SPORTS = ['nfl', 'ncaaf', 'mlb', 'nhl'];
const UID_COOKIES = { nfl: 'ps_uid', ncaaf: 'hl_uid', mlb: 'bbl_uid', nhl: 'nh_uid' };
const COOKIE = 'tb_account';
const CSRF_COOKIE = 'tb_account_csrf';
const DAY = 86400000;
const SESSION_MS = 30 * DAY;
const OWNER_SESSION_MS = 12 * 3600000;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const random = (n = 32) => crypto.randomBytes(n).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && a.length > 0 && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0]));
const short = (s, n = 80) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function appendCookie(res, value) { res.setHeader('set-cookie', [].concat(res.getHeader('set-cookie') || [], value)); }
function cookie(res, name, value, secure, age = SESSION_MS / 1000) { appendCookie(res, `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(age)}${secure ? '; Secure' : ''}`); }
function json(res, code, data) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }); res.end(JSON.stringify(data)); }
async function body(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) fail('Use JSON.', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32768) fail('Request is too large.', 413); chunks.push(chunk); }
  try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!b || Array.isArray(b) || typeof b !== 'object') throw Error(); return b; } catch { fail('Invalid request.'); }
}
function preferences(input) {
  const src = input && typeof input === 'object' ? input : {};
  return { region: /^[A-Z]{2}$/.test(src.region) ? src.region : 'NV',
    books: [...new Set((Array.isArray(src.books) ? src.books : []).filter(x => typeof x === 'string' && /^[a-z0-9_-]{1,48}$/.test(x)))].slice(0, 80),
    sports: [...new Set((Array.isArray(src.sports) ? src.sports : SPORTS).filter(x => SPORTS.includes(x)))],
    focusMode: src.focusMode === true,
    // The book list was chosen on purpose, even if it is now empty (My books "Clear"), so an empty list is not "never set".
    booksSet: src.booksSet === true || (Array.isArray(src.books) && src.books.some(x => typeof x === 'string' && /^[a-z0-9_-]{1,48}$/.test(x))) };
}
module.exports = function createAccounts(options = {}) {
  const now = options.now || Date.now;
  const dir = path.join(options.dataDir || process.env.DATA_DIR || '.', 'accounts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'accounts.json');
  let store;
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); if (store.v !== 1 || !store.accounts || !store.sessions) throw Error('Unsupported account store'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; store = { v: 1, accounts: {}, sessions: {}, secret: random() }; }
  const csrfProof = value => crypto.createHmac('sha256', store.secret).update(value).digest('base64url');
  function save() { const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(store), { mode: 0o600 }); fs.renameSync(temp, file); }
  if (!fs.existsSync(file)) save();
  const buckets = new Map(), challenges = new Map();
  let webauthnPromise;
  let origin = null, rpID = null;
  try { const url = new URL(options.origin || process.env.ACCOUNT_ORIGIN || ''); if (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) { origin = url.origin; rpID = url.hostname; } } catch { /* Password accounts still work without a passkey RP. */ }
  const webauthn = () => options.webauthn ? Promise.resolve(options.webauthn) : (webauthnPromise ||= import('@simplewebauthn/server'));
  const billing = require('./account-billing')({ origin, env: options.billingEnv, stripe: options.stripe, getAccount: id => typeof id === 'string' ? store.accounts[id] : null, updateAccount: (id, values) => { if (!store.accounts[id]) return; Object.assign(store.accounts[id], values); save(); } });
  const ownerId = 'owner';
  function prune() {
    const t = now();
    for (const [key, entry] of buckets) if (entry.exp <= t) buckets.delete(key);
    for (const [key, entry] of challenges) if (entry.exp <= t) challenges.delete(key);
    for (const [key, entry] of Object.entries(store.sessions)) if (entry.expiresAt <= t || !store.accounts[entry.accountId]) delete store.sessions[key];
  }
  function rate(key, max, window) {
    prune(); const entry = buckets.get(key) || { n: 0, exp: now() + window };
    if (entry.n >= max || (!buckets.has(key) && buckets.size >= 10000)) fail('Too many attempts. Please try again later.', 429);
    entry.n++; buckets.set(key, entry);
  }
  function identity(req) {
    const token = cookies(req)[COOKIE]; if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
    const session = store.sessions[hash(token)];
    if (!session || session.expiresAt <= now()) return null;
    const account = store.accounts[session.accountId]; if (!account || account.disabled) return null;
    return { accountId: account.id, sessionId: session.id, role: account.owner ? 'owner' : 'guest', engineIds: { ...account.engineIds }, account, session };
  }
  function owned(req) { const user = identity(req); if (!user) fail('Sign in to your account.', 401); return user; }
  function newAccount(username, name, passwordHash = null, owner = false) {
    const id = owner ? ownerId : random(18);
    return { id, username, name, passwordHash, owner, createdAt: now(), engineIds: Object.fromEntries(SPORTS.map(sp => [sp, crypto.randomBytes(16).toString('hex')])), preferences: preferences({}), passkeys: [], entitlement: { tier: 'free', status: 'inactive', source: 'none', expiresAt: null } };
  }
  function ownerAccount() { if (!store.accounts[ownerId]) { store.accounts[ownerId] = newAccount('board-owner', 'Board owner', null, true); save(); } return store.accounts[ownerId]; }
  function sessionFor(account, req, res, context = {}) {
    const old = identity(req); if (old) { delete store.sessions[hash(cookies(req)[COOKIE])]; }
    prune();
    const existing = Object.entries(store.sessions).filter(([, s]) => s.accountId === account.id).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (existing.length >= 20) delete store.sessions[existing.shift()[0]];
    const token = random(), session = { id: random(18), accountId: account.id, csrf: random(), createdAt: now(), expiresAt: now() + (account.owner ? OWNER_SESSION_MS : SESSION_MS), ua: short(req.headers['user-agent'], 160), deviceId: short(context.deviceId, 80) };
    store.sessions[hash(token)] = session; save();
    options.onSessionCreated?.(req, res, { ...context, role: account.owner ? 'owner' : 'guest' });
    cookie(res, COOKIE, token, !!context.secure, (session.expiresAt - now()) / 1000);
    return { accountId: account.id, role: account.owner ? 'owner' : 'guest', account, session };
  }
  function startOwnerSession(req, res, context = {}) { if (context.role !== 'owner') fail('Owner access required.', 403); return sessionFor(ownerAccount(), req, res, context); }
  function anonymousCsrf(req, res, secure) {
    const current = cookies(req)[CSRF_COOKIE];
    if (validAnonymousCsrf(current)) return current;
    const payload = `${now()}.${random()}`, token = `${payload}.${csrfProof(payload)}`;
    cookie(res, CSRF_COOKIE, token, secure, 3600); return token;
  }
  function validAnonymousCsrf(token) {
    const m = /^(\d{13})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(token || '');
    return !!m && Number(m[1]) <= now() + 5000 && now() - Number(m[1]) < 3600000 && equal(m[3], csrfProof(`${m[1]}.${m[2]}`));
  }
  function sameOrigin(req) {
    if (options.isSameOrigin) return options.isSameOrigin(req);
    return !!origin && req.headers.origin === origin && req.headers['sec-fetch-site'] !== 'cross-site';
  }
  function requireCsrf(req, user) {
    if (!sameOrigin(req)) fail('Request origin not allowed.', 403);
    const supplied = req.headers['x-account-csrf'];
    if (user ? !equal(supplied, user.session.csrf) : !validAnonymousCsrf(cookies(req)[CSRF_COOKIE]) || !equal(supplied, cookies(req)[CSRF_COOKIE])) fail('Reload this page and try again.', 403);
  }
  function entitlement(account) {
    const e = account.entitlement || {}, active = account.owner || (e.tier === 'pro' && ['active', 'trialing'].includes(e.status) && Number.isFinite(e.expiresAt) && e.expiresAt > now());
    return { tier: active ? 'pro' : 'free', active, status: account.owner ? 'owner' : e.status || 'inactive', expiresAt: e.expiresAt || null, checkoutEnabled: billing.configuration().enabled };
  }
  function publicUser(user) { const a = user.account; return { id: a.id, username: a.username, name: a.name, owner: a.owner, createdAt: a.createdAt, preferences: a.preferences, entitlement: entitlement(a) }; }
  function me(req, res, context) {
    const user = identity(req);
    return { account: user ? publicUser(user) : null, csrf: user ? user.session.csrf : anonymousCsrf(req, res, !!context.secure), ownerAccess: context.role === 'owner', passkeysAvailable: !!origin, billing: billing.configuration(), importSports: options.importLog ? ['nfl', 'ncaaf', 'mlb'] : [] };
  }
  function findName(name) { return Object.values(store.accounts).find(a => a.username === name && !a.owner); }
  async function passwordHash(password) {
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) fail('Use a password of 12 to 256 characters.');
    if (password.length > 256) fail('Use a password of 12 to 256 characters.');
    const salt = random(16), key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return { salt, key: key.toString('base64url'), N: 32768, r: 8, p: 1 };
  }
  async function checkPassword(password, account) {
    const p = account?.passwordHash || { salt: 'missing-account-timing-pad', key: Buffer.alloc(64).toString('base64url') };
    const candidate = typeof password === 'string' && password.length <= 256 ? password : '';
    const key = await scrypt(candidate, p.salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return equal(key.toString('base64url'), p.key) && !!account?.passwordHash;
  }
  function passkeyReady() { if (!origin) fail('Passkeys need a configured HTTPS site address.', 503); }
  function challenge(req, mode, data) {
    if (challenges.size >= 2000) fail('Try again shortly.', 429);
    const key = random(); challenges.set(hash(key), { mode, ...data, cookieHash: hash(cookies(req)[COOKIE] || cookies(req)[CSRF_COOKIE] || ''), exp: now() + 300000 }); return key;
  }
  function consumeChallenge(req, key, mode) {
    if (typeof key !== 'string') fail('Restart passkey sign-in.');
    const c = challenges.get(hash(key)); challenges.delete(hash(key));
    if (!c || c.exp <= now() || c.mode !== mode || c.cookieHash !== hash(cookies(req)[COOKIE] || cookies(req)[CSRF_COOKIE] || '')) fail('Passkey request expired. Try again.'); return c;
  }
  function requireRecent(user) { if (now() - user.session.createdAt > 10 * 60000) fail('Sign in again before changing account security.', 401); }
  function forwardCookie(req, sport) {
    const user = identity(req); if (!user || user.role === 'owner' || !UID_COOKIES[sport]) return req.headers.cookie || '';
    const c = cookies(req); c[UID_COOKIES[sport]] = user.engineIds[sport];
    return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  function filterEngineCookies(req, values) {
    const user = identity(req);
    if (!user) return values;
    const hidden = ['ps_code', 'hl_code', 'bbl_access', ...(user.role === 'owner' ? [] : Object.values(UID_COOKIES))];
    return [].concat(values || []).filter(v => !hidden.some(name => String(v).startsWith(name + '=')));
  }
  function setEntitlement(accountId, value) {
    const account = store.accounts[accountId]; if (!account || account.owner) fail('Account not found.', 404);
    if (!value || !['active', 'trialing', 'inactive', 'canceled', 'past_due'].includes(value.status) || !['stripe', 'owner'].includes(value.source)) fail('Invalid entitlement.');
    account.entitlement = { tier: value.tier === 'pro' ? 'pro' : 'free', status: value.status, source: value.source, expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : null, eventId: short(value.eventId, 160), updatedAt: now() }; save();
    return entitlement(account);
  }
  async function handle(req, res, pathname, context = {}) {
    if (pathname === '/account' || pathname === '/account/') {
      if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: 'Method not allowed.' }); return true; }
      const html = fs.readFileSync(path.join(__dirname, '../design/accounts.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); res.end(req.method === 'HEAD' ? '' : html); return true;
    }
    if (!pathname.startsWith('/api/account/')) return false;
    try {
      if (pathname === '/api/account/billing/webhook' && req.method === 'POST') { json(res, 200, await billing.webhook(req)); return true; }
      if (pathname === '/api/account/pricing' && req.method === 'GET') { json(res, 200, await billing.pricing()); return true; }
      if (pathname === '/api/account/me' && req.method === 'GET') { json(res, 200, me(req, res, context)); return true; }
      const user = identity(req);
      if (req.method === 'GET' && pathname === '/api/account/sessions') {
        const current = owned(req); json(res, 200, { sessions: Object.values(store.sessions).filter(s => s.accountId === current.accountId && s.expiresAt > now()).map(s => ({ id: s.id, current: s.id === current.session.id, createdAt: s.createdAt, expiresAt: s.expiresAt, browser: s.ua })) }); return true;
      }
      if (req.method === 'GET' && pathname === '/api/account/passkeys') { const current = owned(req); json(res, 200, { passkeys: current.account.passkeys.map(p => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt || null })) }); return true; }
      if (req.method !== 'POST') fail('Not found.', 404);
      requireCsrf(req, user);
      const ip = options.clientIp ? options.clientIp(req) : req.socket?.remoteAddress || 'unknown';
      rate('request:' + hash(ip), 100, 60000);
      const b = await body(req);
      if (pathname === '/api/account/signup') {
        rate('signup:' + hash(ip), 5, 3600000);
        rate('expensive:global', 100, 60000);
        if (Object.keys(store.accounts).length >= (options.maxAccounts || 10000)) fail('Account capacity reached. Please try again later.', 503);
        const name = short(b.username, 40).toLowerCase();
        if (!/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(name) || name === 'board-owner') fail('Use 3 to 40 letters, numbers, dots, underscores or dashes for your username.');
        if (findName(name)) fail('That username is unavailable.', 409);
        const pw = await passwordHash(b.password);
        if (findName(name)) fail('That username is unavailable.', 409); // Async scrypt must not race uniqueness.
        const account = newAccount(name, short(b.name, 60) || name, pw);
        store.accounts[account.id] = account;
        sessionFor(account, req, res, context);
        json(res, 201, { ok: true }); return true;
      }
      if (pathname === '/api/account/login') {
        const name = short(b.username, 40).toLowerCase();
        rate('login-ip:' + hash(ip), 20, 900000); rate('login-name:' + hash(name), 10, 900000); rate('expensive:global', 100, 60000);
        const account = findName(name);
        if (!(await checkPassword(b.password, account)) || account.disabled) fail('Username or password is incorrect.', 401);
        sessionFor(account, req, res, context); json(res, 200, { ok: true }); return true;
      }
      if (pathname === '/api/account/owner/session') { startOwnerSession(req, res, context); json(res, 200, { ok: true }); return true; }
      if (pathname === '/api/account/logout') { if (user) { delete store.sessions[hash(cookies(req)[COOKIE])]; save(); } cookie(res, COOKIE, '', !!context.secure, 0); json(res, 200, { ok: true }); return true; }
      if (pathname === '/api/account/passkeys/auth/options') {
        passkeyReady(); rate('passkey:' + hash(ip), 20, 900000);
        const w = await webauthn(), opts = await w.generateAuthenticationOptions({ rpID, userVerification: 'required' });
        json(res, 200, { options: opts, requestId: challenge(req, 'authenticate', { challenge: opts.challenge }) }); return true;
      }
      if (pathname === '/api/account/passkeys/auth/verify') {
        passkeyReady(); rate('passkey:' + hash(ip), 20, 900000);
        const c = consumeChallenge(req, b.requestId, 'authenticate');
        const account = Object.values(store.accounts).find(a => !a.disabled && a.passkeys.some(p => p.id === b.response?.id));
        const credential = account?.passkeys.find(p => p.id === b.response?.id);
        if (!credential) fail('Passkey could not be verified.', 401);
        const w = await webauthn(); let result;
        try { result = await w.verifyAuthenticationResponse({ response: b.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, credential: { id: credential.id, publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')), counter: credential.counter, transports: credential.transports } }); } catch { fail('Passkey could not be verified.', 401); }
        if (!result.verified) fail('Passkey could not be verified.', 401);
        credential.counter = result.authenticationInfo.newCounter; credential.lastUsedAt = now();
        sessionFor(account, req, res, context); json(res, 200, { ok: true }); return true;
      }
      const current = owned(req), account = current.account;
      if (pathname === '/api/account/preferences') { account.preferences = preferences(b); save(); json(res, 200, { preferences: account.preferences }); return true; }
      if (pathname === '/api/account/sessions/revoke') {
        if (typeof b.id !== 'string') fail('Choose a session.');
        for (const [key, s] of Object.entries(store.sessions)) if (s.accountId === account.id && (s.id === b.id || (b.id === 'others' && s.id !== current.session.id))) delete store.sessions[key];
        save(); json(res, 200, { ok: true }); return true;
      }
      if (pathname === '/api/account/password') {
        rate('password:' + account.id, 5, 900000);
        if (account.owner) fail('Use your owner code or a passkey to sign in.');
        if (!(await checkPassword(b.currentPassword, account))) fail('Current password is incorrect.', 401);
        account.passwordHash = await passwordHash(b.password);
        for (const [key, s] of Object.entries(store.sessions)) if (s.accountId === account.id) delete store.sessions[key];
        sessionFor(account, req, res, context); json(res, 200, { ok: true }); return true;
      }
      if (pathname === '/api/account/import') {
        if (!options.importLog) fail('Ticket import is unavailable.', 503);
        if (!['nfl', 'ncaaf', 'mlb'].includes(b.sport) || !/^[A-Z2-9]{8}$/.test(b.code || '')) fail('Enter a valid one-time link code.');
        rate('import:' + account.id, 6, 600000);
        // The callback talks directly to the engine and verifies its one-use code.
        // Neither the browser body nor arbitrary UID cookies choose the destination.
        const result = await options.importLog({ accountId: account.id, sport: b.sport, code: b.code, engineUid: account.engineIds[b.sport], req });
        if (!result || !/^[a-f0-9]{32}$/.test(result.engineUid || '')) fail('The link code could not be verified.');
        if (Object.values(store.accounts).some(a => a.id !== account.id && a.engineIds[b.sport] === result.engineUid)) fail('This log already belongs to another account.', 409);
        account.engineIds[b.sport] = result.engineUid; save(); json(res, 200, { ok: true, moved: Math.max(0, Number(result.moved) || 0) }); return true;
      }
      if (pathname === '/api/account/passkeys/register/options') {
        passkeyReady(); requireRecent(current);
        if (account.passkeys.length >= 10) fail('Remove a passkey before adding another.');
        const w = await webauthn(), opts = await w.generateRegistrationOptions({ rpName: 'THE.BOARD', rpID, userName: account.username, userID: new TextEncoder().encode(account.id), userDisplayName: account.name, attestationType: 'none', excludeCredentials: account.passkeys.map(p => ({ id: p.id, transports: p.transports })), authenticatorSelection: { residentKey: 'required', userVerification: 'required' } });
        json(res, 200, { options: opts, requestId: challenge(req, 'register', { challenge: opts.challenge, accountId: account.id }) }); return true;
      }
      if (pathname === '/api/account/passkeys/register/verify') {
        passkeyReady(); requireRecent(current);
        const c = consumeChallenge(req, b.requestId, 'register'); if (c.accountId !== account.id) fail('Sign in again.', 401);
        const w = await webauthn(); let result;
        try { result = await w.verifyRegistrationResponse({ response: b.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }); } catch { fail('Passkey could not be registered.'); }
        if (!result.verified || !result.registrationInfo) fail('Passkey could not be registered.');
        const credential = result.registrationInfo.credential;
        if (Object.values(store.accounts).some(a => a.passkeys.some(p => p.id === credential.id))) fail('This passkey is already registered.', 409);
        account.passkeys.push({ id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter, transports: credential.transports || [], name: short(b.name, 60) || 'Passkey', createdAt: now() });
        save(); json(res, 200, { ok: true }); return true;
      }
      if (pathname === '/api/account/passkeys/remove') { requireRecent(current); account.passkeys = account.passkeys.filter(p => p.id !== b.id); save(); json(res, 200, { ok: true }); return true; }
      if (pathname === '/api/account/checkout') { rate('checkout:' + account.id, 5, 600000); json(res, 200, await billing.checkout(account)); return true; }
      if (pathname === '/api/account/billing/portal') { rate('portal:' + account.id, 10, 600000); json(res, 200, await billing.portal(account)); return true; }
      fail('Not found.', 404);
    } catch (e) { if (!res.headersSent) { if (e.status === 429) res.setHeader('retry-after', '900'); json(res, e.status || 500, { error: e.status ? e.message : 'Account service is unavailable. Try again.' }); } else if (!res.writableEnded) res.end(); }
    return true;
  }
  function revokeDevice(deviceId) { let changed = false; for (const [key, session] of Object.entries(store.sessions)) if (session.deviceId && session.deviceId === deviceId) { delete store.sessions[key]; changed = true; } if (changed) save(); return changed; }
  function signOut(req, res, context = {}) { const token = cookies(req)[COOKIE]; if (token && store.sessions[hash(token)]) { delete store.sessions[hash(token)]; save(); } cookie(res, COOKIE, '', !!context.secure, 0); }
  return { handle, identity, forwardCookie, filterEngineCookies, startOwnerSession, signOut, revokeDevice, setEntitlement, entitlement: req => { const user = identity(req); return user ? entitlement(user.account) : { tier: 'free', active: false, checkoutEnabled: billing.configuration().enabled }; } };
};
module.exports.UID_COOKIES = UID_COOKIES;
module.exports.preferences = preferences;
