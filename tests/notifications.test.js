'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const vm = require('node:vm');
const webPush = require('web-push');
const { NotificationService, validateEndpoint, validateSubscription, validateRules, eligibleOpportunity } = require('../shared/notifications');
const NOW = Date.parse('2026-09-22T20:00:00Z');
const origin = 'https://board.example';
const keys = webPush.generateVAPIDKeys();
const dirs = [];
test.after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function sub(id = 'device', host = 'fcm.googleapis.com') { return { endpoint: `https://${host}/fcm/send/${id}`, expirationTime: null, keys: { p256dh: keys.publicKey, auth: Buffer.alloc(16, 42).toString('base64url') } }; }
const opportunity = (more = {}) => ({ id: 'line-1', sport: 'nfl', book: 'mgm', label: 'Home -2.5', evPct: 5, odds: -110, line: -2.5, expiresAt: NOW + 60000, eligible: true, ...more });
function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-push-')); dirs.push(dir);
  const calls = []; let now = NOW;
  const transport = { generateVAPIDKeys: () => ({ ...keys }), sendNotification: async (...args) => { calls.push(args); } };
  const service = new NotificationService({ dataDir: dir, origin, webPush: transport, now: () => now, ...options });
  return { service, calls, transport, dir, tick: (ms) => { now += ms; } };
}
async function request(service, method, data = {}, ownerId = 'owner', headers = {}) {
  const req = Readable.from([JSON.stringify(data)]); req.method = method; req.headers = { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers };
  let status, value, responseHeaders;
  const res = { writeHead(code, h) { status = code; responseHeaders = h; }, end(body) { value = JSON.parse(body); } };
  await service.handle(req, res, { ownerId }); return { status, value, headers: responseHeaders };
}

test('mount-equivalent read is private, off by default, and has no transport side effects', async () => {
  const f = setup(); const r = await request(f.service, 'GET');
  assert.equal(r.status, 200); assert.equal(r.value.enabled, false); assert.deepEqual(r.value.subscriptions, []);
  assert.deepEqual(r.value.rules.sports, ['nfl', 'ncaaf', 'mlb', 'nhl']);
  assert.equal(r.value.publicKey, keys.publicKey); assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(JSON.stringify(r).includes(keys.privateKey), false); assert.equal(f.calls.length, 0);
  assert.equal((await request(f.service, 'GET', {}, null)).status, 401);
});

test('mutations require trusted exact origin and JSON, independently of identity', async () => {
  const f = setup();
  for (const headers of [{ origin: undefined }, { origin: 'https://evil.example' }, { origin: origin + '.evil.example' }, { 'sec-fetch-site': 'cross-site' }]) assert.equal((await request(f.service, 'POST', { subscription: sub() }, 'owner', headers)).status, 403);
  assert.equal((await request(f.service, 'POST', { subscription: sub() }, 'owner', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request(f.service, 'POST', { subscription: sub(), padding: 'x'.repeat(20000) })).status, 413);
  assert.equal(f.service.view('owner').enabled, false);
});

test('SSRF endpoints, redirects by hostname trick, ports, queries and malformed encryption keys fail closed', () => {
  for (const value of ['http://fcm.googleapis.com/fcm/send/a', 'https://127.0.0.1/fcm/send/a', 'https://169.254.169.254/latest/meta-data', 'https://fcm.googleapis.com.evil.test/fcm/send/a', 'https://fcm.googleapis.com@evil.test/fcm/send/a', 'https://fcm.googleapis.com:444/fcm/send/a', 'https://fcm.googleapis.com/fcm/send/a?target=http://localhost', 'https://web.push.apple.com/../secret', 'https://updates.push.services.mozilla.com/evil/a']) assert.throws(() => validateEndpoint(value));
  assert.equal(validateEndpoint('https://updates.push.services.mozilla.com/wpush/v2/token_1'), 'https://updates.push.services.mozilla.com/wpush/v2/token_1');
  assert.equal(validateEndpoint('https://web.push.apple.com/token_1'), 'https://web.push.apple.com/token_1');
  assert.throws(() => validateSubscription({ ...sub(), keys: { ...sub().keys, p256dh: Buffer.alloc(65).toString('base64url') } }, NOW));
  assert.throws(() => validateSubscription({ ...sub(), expirationTime: NOW - 1 }, NOW));
});

test('subscription and rules stay owner scoped, and endpoint ownership cannot silently transfer', async () => {
  const f = setup();
  const one = await request(f.service, 'POST', { subscription: sub(), rules: { sports: ['nhl'], books: ['mgm'], minEV: 4, cooldown: 60 } }, 'a');
  assert.equal(one.status, 200); assert.equal(one.value.enabled, true); assert.equal(one.value.subscriptions.length, 1);
  assert.equal(JSON.stringify(one.value).includes('fcm.googleapis.com'), false); assert.equal(JSON.stringify(one.value).includes(sub().keys.auth), false);
  assert.equal((await request(f.service, 'GET', {}, 'b')).value.subscriptions.length, 0);
  assert.equal((await request(f.service, 'POST', { subscription: sub() }, 'b')).status, 409);
  await request(f.service, 'DELETE', { id: one.value.subscriptions[0].id }, 'b');
  assert.equal(f.service.view('a').subscriptions.length, 1);
});

test('subscriptions are bounded, rules reject unsafe values, and bad rules cannot turn alerts on', async () => {
  const f = setup();
  for (let i = 0; i < 5; i++) assert.equal((await request(f.service, 'POST', { subscription: sub(`d${i}`) })).status, 200);
  assert.equal((await request(f.service, 'POST', { subscription: sub('extra') })).status, 409);
  for (const r of [{ minEV: NaN }, { cooldown: 0 }, { sports: [] }, { sports: ['bad'] }, { books: ['private-host'] }, { url: 'https://evil' }]) assert.throws(() => validateRules(r));
  assert.equal((await request(f.service, 'POST', { subscription: sub('new-owner'), rules: { cooldown: 0 } }, 'new')).status, 400);
  assert.equal(f.service.view('new').enabled, false);
});

test('VAPID and settings persist durably with private file permissions', async () => {
  const f = setup(); await request(f.service, 'POST', { subscription: sub() });
  const reload = new NotificationService({ dataDir: f.dir, origin, webPush: { ...f.transport, generateVAPIDKeys() { throw new Error('Must not rotate keys'); } }, now: () => NOW });
  assert.equal(reload.view('owner').publicKey, keys.publicKey); assert.equal(reload.view('owner').enabled, true);
  for (const name of ['notification-vapid.json', 'notifications.json']) assert.equal(fs.statSync(path.join(f.dir, name)).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(f.dir, 'notifications.json'), '{broken');
  assert.throws(() => new NotificationService({ dataDir: f.dir, origin, webPush: f.transport }), /could not be read/);
});

test('only explicitly eligible, future-expiring numeric opportunities pass validation', () => {
  for (const more of [{ eligible: false }, { eligible: undefined }, { expiresAt: null }, { expiresAt: NOW }, { expiresAt: NOW + 86400000 }, { odds: null }, { evPct: null }, { evPct: NaN }, { line: '2.5' }, { book: 'unknown' }]) assert.equal(eligibleOpportunity(opportunity(more), NOW), null);
  assert.ok(eligibleOpportunity(opportunity({ sport: 'nhl' }), NOW));
});

test('publishing filters sports/books/minimum EV and passes a short expiry-bound TTL', async () => {
  const f = setup(); await request(f.service, 'POST', { subscription: sub(), rules: { sports: ['nhl'], books: ['mgm'], minEV: 4, cooldown: 60 } });
  await f.service.publish([opportunity(), opportunity({ sport: 'nhl', book: 'dk' }), opportunity({ sport: 'nhl', evPct: 3 }), opportunity({ sport: 'nhl', eligible: false })]);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.service.publish([opportunity({ sport: 'nhl' })])).sent, 1);
  const [target, raw, options] = f.calls[0], payload = JSON.parse(raw);
  assert.equal(target.endpoint, sub().endpoint); assert.equal(payload.kind, 'board-opportunity');
  assert.equal(payload.expiresAt, NOW + 60000); assert.match(payload.url, /^\/opportunities\?/);
  assert.equal(options.TTL, 60); assert.equal(options.timeout, 5000); assert.equal(options.vapidDetails.publicKey, keys.publicKey);
});

test('durable dedupe and cooldown prevent duplicates across ticks and restarts', async () => {
  const f = setup(); await request(f.service, 'POST', { subscription: sub(), rules: { cooldown: 60 } });
  await f.service.publish([opportunity()]); await f.service.publish([opportunity({ id: 'new-price' })]);
  assert.equal(f.calls.length, 1);
  f.tick(61000);
  await f.service.publish([opportunity({ expiresAt: NOW + 120000 })]); assert.equal(f.calls.length, 1);
  await f.service.publish([opportunity({ id: 'new-price', expiresAt: NOW + 120000 })]); assert.equal(f.calls.length, 2);
  const reload = new NotificationService({ dataDir: f.dir, origin, webPush: f.transport, now: () => NOW + 122000 });
  await reload.publish([opportunity({ id: 'new-price', expiresAt: NOW + 180000 })]); assert.equal(f.calls.length, 2);
});

test('overlapping publish calls cannot send twice and pause takes effect before further sends', async () => {
  const f = setup(); let finish;
  f.transport.sendNotification = (...args) => { f.calls.push(args); return new Promise((resolve) => { finish = resolve; }); };
  await request(f.service, 'POST', { subscription: sub('one') }); await request(f.service, 'POST', { subscription: sub('two') });
  const first = f.service.publish([opportunity()]);
  assert.deepEqual(await f.service.publish([opportunity()]), { busy: true, sent: 0 });
  await request(f.service, 'PATCH', { enabled: false }); finish(); await first;
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.publish([opportunity({ id: 'later' })])).sent, 0);
});

test('expired subscriptions and gone endpoints are removed; retryable failures are backed off', async () => {
  const f = setup(); await request(f.service, 'POST', { subscription: { ...sub(), expirationTime: NOW + 1 } });
  f.tick(2); await f.service.publish([opportunity()]); assert.equal(f.calls.length, 0); assert.equal(f.service.view('owner').enabled, false);
  await request(f.service, 'POST', { subscription: sub(), rules: { cooldown: 60 } });
  f.transport.sendNotification = async () => { throw Object.assign(new Error('Gone'), { statusCode: 410 }); };
  await f.service.publish([opportunity()]); assert.equal(f.service.view('owner').subscriptions.length, 0);
  await request(f.service, 'POST', { subscription: sub('next') }); f.tick(61000);
  let attempts = 0; f.transport.sendNotification = async () => { attempts++; throw Object.assign(new Error('Busy'), { statusCode: 429 }); };
  await f.service.publish([opportunity({ id: 'retry', expiresAt: NOW + 120000 })]); f.tick(61000);
  await f.service.publish([opportunity({ id: 'other', expiresAt: NOW + 180000 })]); assert.equal(attempts, 1);
});

function worker() {
  const handlers = {}, notices = [], opened = [], focused = []; let now = NOW;
  class Clock extends Date { static now() { return now; } }
  const self = { location: { origin }, addEventListener(type, fn) { handlers[type] = fn; }, skipWaiting: async () => {},
    registration: { showNotification: async (...args) => notices.push(args) }, clients: { claim: async () => {}, matchAll: async () => [], openWindow: async (url) => opened.push(url) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../shared/board-sw.js'), 'utf8'), { self, Date: Clock, URL });
  async function fire(type, data) { let pending; handlers[type]({ data: { json: () => data }, notification: { data, close() {} }, waitUntil(p) { pending = p; } }); await pending; }
  return { self, handlers, notices, opened, focused, fire, tick: (ms) => { now += ms; } };
}
test('worker rejects expired/untrusted push payloads and never caches odds', async () => {
  const f = worker(); assert.equal(f.handlers.fetch, undefined);
  const payload = { kind: 'board-opportunity', id: 'id', title: 'NFL', body: 'A current price', url: '/opportunities?opportunity=id', expiresAt: NOW + 30000 };
  for (const more of [{ expiresAt: NOW }, { url: 'https://evil.example/path' }, { url: '/api/private' }, { kind: 'other' }]) await f.fire('push', { ...payload, ...more });
  assert.equal(f.notices.length, 0); await f.fire('push', payload); assert.equal(f.notices.length, 1);
  f.tick(31000); await f.fire('notificationclick', f.notices[0][1].data);
  assert.deepEqual(f.opened, [origin + '/opportunities']);
  await f.fire('notificationclick', { kind: 'board-opportunity', url: 'https://evil.example', expiresAt: NOW + 60000 }); assert.equal(f.opened.length, 1);
  await f.fire('notificationclick', { kind: 'legacy-mlb' }); assert.equal(f.opened[1], '/mlb/');
});

test('client mounting reads settings without requesting permission or creating subscriptions', async () => {
  let permissionRequests = 0, registrations = 0, fetches = 0;
  const listeners = {}, el = { innerHTML: '', addEventListener(type, fn) { listeners[type] = fn; } };
  const context = { URL, Uint8Array, TextEncoder, WeakMap, location: { origin }, isSecureContext: true, PushManager: function () {},
    navigator: { serviceWorker: { register() { registrations++; } } }, Notification: { permission: 'default', requestPermission() { permissionRequests++; } },
    fetch: async (url, opts) => { fetches++; assert.equal(url, '/api/notifications'); assert.equal(opts.method, 'GET'); return { ok: true, json: async () => ({ enabled: false, rules: validateRules(), subscriptions: [], supportedBooks: ['mgm'], publicKey: keys.publicKey }) }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../design/notifications.js'), 'utf8'), context);
  await context.BoardNotifications.mount(el);
  assert.equal(fetches, 1); assert.equal(permissionRequests, 0); assert.equal(registrations, 0);
  assert.match(el.innerHTML, /Enable on this browser/); assert.match(el.innerHTML, /NHL/);
  await assert.rejects(() => context.BoardNotifications.mount({ ...el }, { api: 'https://evil.example/api' }), /same-origin/);
});

test('client enables only after a deliberate click and stores the browser subscription through the private API', async () => {
  const actions = [], listeners = {}, subscription = { ...sub(), toJSON() { return sub(); } };
  const form = { querySelectorAll(selector) { return selector.includes('sports') ? [{ value: 'nhl' }] : [{ value: 'mgm' }]; }, elements: { minEV: { value: '5' }, cooldown: { value: '900' } } };
  const el = { innerHTML: '', addEventListener(type, fn) { listeners[type] = fn; }, querySelector() { return form; } };
  const value = { enabled: false, rules: validateRules(), subscriptions: [], supportedBooks: ['mgm'], publicKey: keys.publicKey };
  const context = { URL, Uint8Array, TextEncoder, WeakMap, location: { origin }, isSecureContext: true, PushManager: function () {}, atob: (v) => Buffer.from(v, 'base64').toString('binary'),
    navigator: { serviceWorker: { async register(url, opts) { actions.push(['register', url, opts]); return { active: true, pushManager: { getSubscription: async () => null, async subscribe(opts) { actions.push(['subscribe', opts]); return subscription; } } }; } } },
    Notification: { permission: 'default', async requestPermission() { actions.push(['permission']); return 'granted'; } },
    fetch: async (url, options) => { actions.push(['fetch', options.method]); if (options.method === 'POST') { const data = JSON.parse(options.body); assert.equal(data.subscription.endpoint, sub().endpoint); assert.deepEqual(data.rules, { sports: ['nhl'], books: ['mgm'], minEV: 5, cooldown: 900 }); } return { ok: true, json: async () => ({ ...value, enabled: options.method === 'POST' }) }; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../design/notifications.js'), 'utf8'), context);
  await context.BoardNotifications.mount(el);
  assert.deepEqual(actions, [['fetch', 'GET']]);
  listeners.click({ target: { closest: () => ({ disabled: false, hasAttribute: (attr) => attr === 'data-bn-enable' }) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(actions.map((a) => a[0]), ['fetch', 'permission', 'register', 'subscribe', 'fetch']);
  assert.equal(actions.at(-1)[1], 'POST'); assert.match(el.innerHTML, /Alerts enabled on this browser/);
});
