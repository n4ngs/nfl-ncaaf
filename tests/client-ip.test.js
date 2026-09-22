'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolveClientIp, clientIp, forwardClientIpHeaders, normalizeIp } = require('../shared/client-ip');
const direct = { mode: 'direct' }, railway = { mode: 'railway' };
const secret = 'unit-test-peer-secret';
const internal = { mode: 'internal', secret };
function req(headers = {}, peer = '10.1.2.3', rawHeaders) {
  return { headers, socket: { remoteAddress: peer }, rawHeaders: rawHeaders || Object.entries(headers).flat() };
}
function forwarded(headers = {}, ip = '8.8.8.8', opts = direct) {
  return forwardClientIpHeaders(req(headers, ip), secret, opts);
}

test('Railway documented X-Real-IP wins over a conflicting forwarding chain', () => {
  assert.deepEqual(resolveClientIp(req({ 'x-real-ip': ' 8.8.8.8 ', 'x-forwarded-for': '6.6.6.6, 1.1.1.1' }), railway),
    { ip: '8.8.8.8', source: 'railway-x-real-ip', kind: 'public' });
});
test('Railway fallback uses only the rightmost hop and ignores a spoofed prefix', () => {
  assert.equal(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 8.8.8.8' }), railway), '8.8.8.8');
  assert.equal(resolveClientIp(req({ 'x-forwarded-for': '6.6.6.6, 8.8.8.8' }), railway).source, 'railway-x-forwarded-for');
});
test('an invalid final hop never promotes an earlier attacker-controlled address', () => {
  for (const tail of ['', 'unknown', '__proto__', 'constructor', '1.2.3.999', '8.8.8.8:443']) {
    const resolved = resolveClientIp(req({ 'x-forwarded-for': `1.1.1.1, ${tail}` }), railway);
    assert.equal(resolved.ip, '10.1.2.3');
    assert.equal(resolved.source, 'socket');
    assert.equal(resolved.kind, 'private');
    assert.equal(resolved.reason, 'FORWARDED_ADDRESS_INVALID');
  }
});
test('missing Railway evidence retains and labels the actual private peer', () => {
  assert.deepEqual(resolveClientIp(req(), railway), { ip: '10.1.2.3', source: 'socket', kind: 'private', reason: 'FORWARDED_ADDRESS_MISSING' });
  assert.equal(resolveClientIp(req({ 'x-real-ip': '192.168.1.2' }), railway).kind, 'private');
});
test('malformed or duplicate X-Real-IP may fall back only to an independently valid rightmost XFF', () => {
  const cases = [
    req({ 'x-real-ip': '8.8.8.8, 1.1.1.1', 'x-forwarded-for': '6.6.6.6, 9.9.9.9' }),
    req({ 'x-real-ip': ['8.8.8.8', '1.1.1.1'], 'x-forwarded-for': '9.9.9.9' }),
    req({ 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '9.9.9.9' }, '10.1.2.3', ['X-Real-IP', '8.8.8.8', 'x-real-ip', '1.1.1.1', 'x-forwarded-for', '9.9.9.9']),
  ];
  for (const input of cases) assert.deepEqual(resolveClientIp(input, railway),
    { ip: '9.9.9.9', source: 'railway-x-forwarded-for', kind: 'public', reason: 'REAL_IP_INVALID' });
});
test('duplicate XFF headers are rejected even when Node joined them into one string', () => {
  const input = req({ 'x-forwarded-for': '1.1.1.1, 8.8.8.8' }, '10.1.2.3', ['X-Forwarded-For', '1.1.1.1', 'x-forwarded-for', '8.8.8.8']);
  assert.equal(resolveClientIp(input, railway).source, 'socket');
  assert.equal(clientIp(input, railway), '10.1.2.3');
});
test('direct mode ignores all arbitrary forwarding and internal request markers', () => {
  const input = req({ 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '1.1.1.1', 'x-board-client-address': 'injected', 'railway-service-id': 'not-platform' }, '192.168.1.7');
  assert.deepEqual(resolveClientIp(input, direct), { ip: '192.168.1.7', source: 'socket', kind: 'private', reason: 'FORWARDED_HEADERS_IGNORED' });
});
test('only server-side Railway identifiers choose the default edge mode', () => {
  const input = req({ 'x-real-ip': '8.8.8.8', 'railway-service-id': 'request-input' });
  assert.equal(clientIp(input, { env: {} }), '10.1.2.3');
  assert.equal(clientIp(input, { env: { RAILWAY_PUBLIC_DOMAIN: 'example.test' } }), '10.1.2.3');
  for (const name of ['RAILWAY_SERVICE_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID']) {
    assert.equal(clientIp(input, { env: { [name]: 'platform-id' } }), '8.8.8.8');
  }
});
test('IPv4-mapped IPv6 normalizes to one identity for rate limits', () => {
  for (const input of ['8.8.8.8', '::ffff:8.8.8.8', '0:0:0:0:0:FFFF:0808:0808']) {
    assert.equal(normalizeIp(input), '8.8.8.8');
    assert.equal(clientIp(req({}, input), direct), '8.8.8.8');
  }
  assert.equal(resolveClientIp(req({}, '::ffff:127.0.0.1'), direct).kind, 'loopback');
});
test('IPv6 is canonicalized and private, loopback and public scopes remain distinct', () => {
  assert.equal(normalizeIp('2001:4860:0000:0000:0000:0000:0000:8888'), '2001:4860::8888');
  assert.equal(resolveClientIp(req({}, '2001:4860::8888'), direct).kind, 'public');
  for (const ip of ['fc00::1', 'fd00::1', 'fe80::1', '100.64.1.1', '169.254.1.1', '192.168.1.1', '172.31.1.1']) {
    assert.equal(resolveClientIp(req({}, ip), direct).kind, 'private', ip);
  }
  assert.equal(resolveClientIp(req({}, '0:0:0:0:0:0:0:1'), direct).kind, 'loopback');
});
test('invalid address literals remain unavailable rather than stored as addresses', () => {
  for (const ip of ['__proto__', 'constructor', '[::1]', 'fe80::1%eth0', '8.8.8.8:80', '010.0.0.1', 'https://8.8.8.8', '\u00008.8.8.8', null, 123]) {
    assert.equal(normalizeIp(ip), '', String(ip));
    assert.deepEqual(resolveClientIp(req({}, ip), direct), { ip: '', source: 'unavailable', kind: 'unavailable' });
  }
});
test('terminal forwarding replaces incoming identity headers and preserves ordinary headers', () => {
  const input = req({ cookie: 'test=value', 'x-board-injected': 'bad', 'X-Board-Other': 'bad', 'x-real-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6', forwarded: 'for=6.6.6.6' }, '8.8.8.8');
  const before = JSON.stringify(input);
  const headers = forwardClientIpHeaders(input, secret, direct);
  assert.equal(headers.cookie, 'test=value');
  assert.equal(headers['x-forwarded-for'], '8.8.8.8');
  assert.equal(headers['x-real-ip'], '8.8.8.8');
  assert.equal(headers.forwarded, undefined);
  assert.deepEqual(Object.keys(headers).filter((x) => x.startsWith('x-board-')).sort(), ['x-board-client-address', 'x-board-client-signature']);
  assert.equal(JSON.stringify(input), before, 'ingress request remains unchanged for Board telemetry');
});
test('a signed loopback relay preserves canonical Railway identity and provenance', () => {
  const headers = forwarded({ 'x-real-ip': '2001:4860::8888', 'x-forwarded-for': '6.6.6.6, 9.9.9.9' }, '10.1.2.3', railway);
  assert.deepEqual(resolveClientIp(req(headers, '::ffff:127.0.0.1'), internal),
    { ip: '2001:4860::8888', source: 'railway-x-real-ip', kind: 'public', via: 'terminal' });
});
test('unsigned internal requests ignore even plausible Railway forwarding headers', () => {
  const result = resolveClientIp(req({ 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '1.1.1.1' }, '127.0.0.1'), { ...internal, env: { RAILWAY_SERVICE_ID: 'real-platform' } });
  assert.deepEqual(result, { ip: '127.0.0.1', source: 'socket', kind: 'loopback', reason: 'INTERNAL_ADDRESS_UNVERIFIED' });
});
test('signature tampering, wrong secrets and non-loopback peers cannot assert another address', () => {
  const good = forwarded();
  const changed = { ...good, 'x-board-client-address': Buffer.from(JSON.stringify({ v: 1, ip: '1.1.1.1', source: 'socket', kind: 'public' })).toString('base64url') };
  for (const [input, opts] of [
    [req(changed, '127.0.0.1'), internal],
    [req({ ...good, 'x-board-client-signature': 'a'.repeat(64) }, '127.0.0.1'), internal],
    [req(good, '127.0.0.1'), { mode: 'internal', secret: 'different' }],
    [req(good, '10.0.0.2'), internal],
    [req(good, '8.8.4.4'), internal],
  ]) {
    const result = resolveClientIp(input, opts);
    assert.equal(result.source, 'socket');
    assert.equal(result.ip, normalizeIp(input.socket.remoteAddress));
    assert.equal(result.reason, 'INTERNAL_ADDRESS_UNVERIFIED');
  }
});
test('duplicate internal envelope headers fail closed', () => {
  const headers = forwarded();
  const raw = Object.entries(headers).flat().concat(['X-Board-Client-Address', headers['x-board-client-address']]);
  assert.equal(resolveClientIp(req(headers, '127.0.0.1', raw), internal).source, 'socket');
});
test('unsigned forwarding changes cannot override a valid signed terminal identity', () => {
  const headers = { ...forwarded(), 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '6.6.6.6, 1.1.1.1' };
  assert.equal(clientIp(req(headers, '127.0.0.1'), internal), '8.8.8.8');
});
test('local terminal requests without forwarding retain their real peer through the engine hop', () => {
  const input = req({}, '192.168.1.7');
  const relay = req(forwardClientIpHeaders(input, secret, direct), '127.0.0.1');
  assert.equal(clientIp(relay, internal), clientIp(input, direct));
  assert.equal(resolveClientIp(relay, internal).kind, 'private');
});
test('two clients sharing the terminal-to-engine socket keep separate identities', () => {
  const a = req(forwarded({}, '8.8.8.8'), '127.0.0.1');
  const b = req(forwarded({}, '1.1.1.1'), '127.0.0.1');
  assert.notEqual(clientIp(a, internal), clientIp(b, internal));
});
test('unavailable original addresses are not replaced with a fictitious loopback client', () => {
  const absent = forwardClientIpHeaders({ headers: {}, socket: {} }, secret, direct);
  assert.equal(resolveClientIp(req(absent, '127.0.0.1'), internal).kind, 'unavailable');
  assert.equal(clientIp(req(absent, '127.0.0.1'), internal), '');
});

// Exercise the real sport wrappers and the real MLB limiter, without starting odds-provider loops.
function sportContext(sport, env) {
  const source = fs.readFileSync(path.join(__dirname, '..', sport, 'server.js'), 'utf8');
  const start = source.indexOf('const CLIENT_IP_OPTIONS =');
  const end = source.indexOf('\n', source.indexOf('const clientIp =', start));
  assert.ok(start >= 0 && end > start, `${sport} uses the shared resolver`);
  const context = vm.createContext({ resolvedClientIp: clientIp, process: { env }, Date });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.ipOfRequest = clientIp;', context);
  if (sport === 'mlb') {
    const rateStart = source.indexOf('const hits = new Map();');
    const rateEnd = source.indexOf('// ---------------------------------------------------------------- access code', rateStart);
    vm.runInContext(source.slice(rateStart, rateEnd), context);
  }
  return context;
}
for (const sport of ['nfl', 'ncaaf', 'mlb']) {
  test(`${sport} merged server uses signed terminal identity for all address consumers`, () => {
    const context = sportContext(sport, { BASE_PATH: `/${sport}`, TELEMETRY_PEER_SECRET: secret });
    const relayed = req(forwarded({ 'x-real-ip': '8.8.8.8' }, '10.1.2.3', railway), '127.0.0.1');
    assert.equal(context.ipOfRequest(relayed), '8.8.8.8');
    assert.equal(context.ipOfRequest(req({ 'x-real-ip': '1.1.1.1' }, '127.0.0.1')), '127.0.0.1');
  });
}
test('MLB API limiter cannot be reset by changing an unsigned XFF prefix', () => {
  const context = sportContext('mlb', { BASE_PATH: '/mlb', TELEMETRY_PEER_SECRET: secret });
  const headers = forwarded({}, '8.8.8.8');
  for (let i = 0; i < 240; i++) {
    assert.equal(context.limited(req({ ...headers, 'x-forwarded-for': `6.6.6.${i % 255}, 8.8.8.8` }, '127.0.0.1')), false);
  }
  assert.equal(context.limited(req({ ...headers, 'x-forwarded-for': '1.1.1.1, 8.8.8.8' }, '127.0.0.1')), true);
  assert.equal(context.limited(req(forwarded({}, '9.9.9.9'), '127.0.0.1')), false, 'independent real client retains its budget');
});


test('IANA special-use IPv6 prefixes are labelled non-public at CIDR boundaries', () => {
  for (const ip of ['64:ff9b:1::1', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '100::1', '100:0:0:1::1',
    '2001:2::1', '2001:db8::1', '3fff::1', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', '5f00::1']) {
    assert.equal(resolveClientIp(req({}, ip), direct).kind, 'private', ip);
  }
  for (const ip of ['64:ff9b::808:808', '64:ff9b:2::1', '100:0:0:2::1', '3fff:1000::1',
    '2001:1::1', '2001:1::2', '2001:1::3', '2001:3::1', '2001:4:112::1', '2001:20::1', '2001:30::1']) {
    assert.equal(resolveClientIp(req({}, ip), direct).kind, 'public', ip);
  }
});
test('IANA public IPv4 anycast exceptions are not swallowed by their special-use parent prefix', () => {
  for (const ip of ['192.0.0.9', '192.0.0.10']) assert.equal(resolveClientIp(req({}, ip), direct).kind, 'public', ip);
  for (const ip of ['192.0.0.8', '192.0.0.11', '192.88.99.2']) assert.equal(resolveClientIp(req({}, ip), direct).kind, 'private', ip);
});
