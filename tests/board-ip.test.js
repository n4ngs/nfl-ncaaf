'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const createBoard = require('../board');
const DEV = '0123456789abcdef01234567';
const ADMIN = '/entry-0123456789abcdef0123456789abcdef';
const ENV = ['RAILWAY_SERVICE_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID'];
test.beforeEach(t => {
  const previous = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  ENV.forEach(k => { delete process.env[k]; });
  t.after(() => ENV.forEach(k => { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }));
});
function setup(t, legacy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-ip-'));
  if (legacy) {
    fs.mkdirSync(path.join(dir, 'board'));
    fs.writeFileSync(path.join(dir, 'board/devices.json'), JSON.stringify({ v: 1, devices: { [DEV]: legacy } }));
  }
  const board = createBoard({ dataDir: dir, adminPath: ADMIN, sports: { nfl: { ck: 'ps', label: 'NFL', dir: 'nfl' } } });
  t.after(() => { board.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const req = (ip, headers = {}) => ({ method: 'GET', socket: { remoteAddress: ip }, headers: { cookie: `tb_dev=${DEV}`, 'user-agent': 'Mozilla/5.0 Test', ...headers } });
  const get = (url, role = 'owner', request = req('127.0.0.1')) => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    assert.equal(board.handle(request, res, url, '', role), true);
    return { ...res, data: res.body && res.headers['content-type']?.includes('application/json') ? JSON.parse(res.body) : null };
  };
  const observe = request => { const who = board.identify(request, true); board.client(who, 'guest', 'nfl', '{"events":[]}'); return who; };
  return { board, req, get, observe, dir };
}
test('Admin records the canonical observed IP with type/source, shared with the current connection response', t => {
  process.env.RAILWAY_SERVICE_ID = 'test-service';
  const x = setup(t), request = x.req('100.64.0.2', { 'x-real-ip': '::ffff:8.8.4.4', 'x-forwarded-for': '198.51.100.1, 203.0.113.1' });
  const who = x.observe(request);
  assert.equal(who.ip, '8.8.4.4');
  const result = x.get(ADMIN + '/api/board', 'owner', request);
  assert.equal(result.status, 200); assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.data.connection.ip, who.ip); assert.equal(result.data.connection.source, 'railway-x-real-ip');
  const detail = x.get(`${ADMIN}/api/device/${DEV}`).data;
  assert.equal(detail.ipLast, who.ip); assert.equal(detail.ipInfo.kind, 'public');
  assert.equal(detail.ipInfo.source, 'railway-x-real-ip'); assert.equal(detail.ipHistory[0].lookup, true); assert.ok(detail.ipInfo.observedAt > 0);
  assert.equal(detail.ipHistory[0].ipInfo.source, 'railway-x-real-ip');
  x.board.close();
  const saved = JSON.parse(fs.readFileSync(path.join(x.dir, 'board/devices.json'), 'utf8')).devices[DEV];
  assert.deepEqual(saved.ipInfo, detail.ipInfo);
});
test('Direct connections ignore spoofed/prototype IP headers and explicitly identify local addresses', t => {
  const x = setup(t), who = x.observe(x.req('::ffff:127.0.0.1', { 'x-real-ip': '__proto__', 'x-forwarded-for': '__proto__' }));
  assert.equal(who.ip, '127.0.0.1');
  const detail = x.get(`${ADMIN}/api/device/${DEV}`).data;
  assert.equal(detail.ipInfo.source, 'socket'); assert.equal(detail.ipInfo.kind, 'loopback');
  assert.deepEqual(detail.ipHistory.map(i => i.ip), ['127.0.0.1']); assert.equal(detail.ipHistory[0].lookup, false); assert.equal(x.get(ADMIN + '/api/security').data.ips[0].lookup, false); assert.equal(Object.prototype.n, undefined);
});
test('Historical IP values are preserved without inventing provenance, and newly unavailable IP does not look current', t => {
  const legacy = { first: 1, last: 2, role: 'guest', ua: '', ips: { '203.0.113.7': { first: 1, last: 2, n: 4 } }, ipLast: '203.0.113.7', links: {}, sports: {} };
  const x = setup(t, legacy);
  const before = x.get(`${ADMIN}/api/device/${DEV}`).data;
  assert.equal(before.ipLast, '203.0.113.7'); assert.equal(before.ipInfo, null); assert.equal(before.ipHistory[0].ipInfo, undefined);
  x.observe(x.req(undefined, { 'x-forwarded-for': '203.0.113.99' }));
  const after = x.get(`${ADMIN}/api/device/${DEV}`).data;
  assert.equal(after.ipLast, ''); assert.equal(after.ipInfo.kind, 'unavailable');
  assert.equal(after.ipHistory[0].ip, '203.0.113.7'); assert.equal(after.ipHistory[0].n, 4); assert.equal(after.ipHistory[0].ipInfo, undefined);
});
test('IP diagnostics and device metadata remain owner-only', t => {
  const x = setup(t); x.observe(x.req('192.168.1.2'));
  for (const role of ['guest', null]) {
    for (const url of [ADMIN + '/api/board', `${ADMIN}/api/device/${DEV}`, ADMIN + '/api/security']) {
      const response = x.get(url, role); assert.equal(response.status, 404); assert.deepEqual(response.data, { error: 'Not found' });
    }
    const page = x.get(ADMIN, role); assert.equal(page.status, 302); assert.equal(page.headers.location, ADMIN + '/login');
  }
});
test('Admin page has valid inline JavaScript and truthful current/historical address labels', t => {
  const x = setup(t), html = x.get(ADMIN).body;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /aria-label="Your observed connection"/);
  assert.match(script, /fx\('Observed IP',d\.ipLast\)/);
  assert.match(html, /Source not recorded/); assert.match(html, /Local connection/);
  assert.match(html, /Private Relay/); assert.match(html, /Browser time zone/);
  assert.match(html, /Browser time zone is not a city/);
  const rowStart = script.indexOf('function row(d){'), rowEnd = script.indexOf('\nfunction ', rowStart + 1);
  assert.ok(rowStart >= 0 && rowEnd > rowStart, 'device summary renderer is present');
  assert.doesNotMatch(script.slice(rowStart, rowEnd), /d\.ctx/, 'a summary must not present browser locale as IP location');
  assert.match(html, /Observed IP history/);
});
