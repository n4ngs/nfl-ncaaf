'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const createBoard = require('../board');
const ADMIN = '/entry-0123456789abcdef0123456789abcdef';
const DEV = '0123456789abcdef01234567';
const SPORTS = { nfl: { ck: 'ps', label: 'NFL', dir: 'nfl' } };

function setup(t, adminPath = ADMIN, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-admin-board-'));
  const board = createBoard({ dataDir: dir, sports: SPORTS, adminPath, ...extra });
  t.after(() => { board.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = (route, { role = 'owner', method = 'GET', headers = {}, body = '' } = {}) => new Promise(resolve => {
    const req = Object.assign(new EventEmitter(), { method, socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'board.test', cookie: `tb_dev=${DEV}`, 'user-agent': 'Mozilla/5.0 Browser', ...headers } });
    req.destroy = () => req.emit('error', new Error('destroyed'));
    const res = {
      writeHead(status, values) { this.status = status; this.headers = values; },
      end(value = '') { this.body = value; resolve({ handled: true, ...this, data: this.headers?.['content-type']?.includes('application/json') ? JSON.parse(value) : null }); }
    };
    const url = new URL(route, 'http://board.test');
    if (!board.handle(req, res, url.pathname, url.search, role)) resolve({ handled: false });
    else { if (body) req.emit('data', body); req.emit('end'); }
  });
  const who = board.identify({ headers: { cookie: `tb_dev=${DEV}`, 'user-agent': 'Mozilla/5.0 Browser' }, socket: { remoteAddress: '127.0.0.1' } }, false);
  board.client(who, 'guest', 'nfl', '{"events":[]}');
  return { board, request, dir };
}
const WRITE = { origin: 'http://board.test', 'sec-fetch-site': 'same-origin', 'x-board-admin': '1' };
function privateHeaders(result) {
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['referrer-policy'], 'no-referrer');
  assert.equal(result.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
}

test('Admin routes are disabled by default and never claim the old or a neighboring route', async t => {
  const disabled = setup(t, '');
  const defaultBoard = createBoard({ dataDir: disabled.dir, sports: SPORTS });
  t.after(() => defaultBoard.close());
  assert.equal(defaultBoard.handle({ method: 'GET', headers: {} }, {}, ADMIN, '', 'owner'), false);
  for (const route of [ADMIN, ADMIN + '/api/board', '/admin', '/admin/api/board']) assert.equal((await disabled.request(route)).handled, false);
  const x = setup(t);
  for (const route of ['/admin', '/admin/', '/admin/api/export?fmt=json', ADMIN + '-other', ADMIN + '-other/api/board']) assert.equal((await x.request(route)).handled, false);
});

test('Direct board configuration rejects short, nested, uppercase or injectable private paths', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-admin-validation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const adminPath of ['/admin', '/entry', 'entry-' + 'a'.repeat(32), '/Entry-' + 'a'.repeat(32), '/' + 'a'.repeat(81), '/entry-' + 'a'.repeat(32) + '/nested', '/entry-' + 'a'.repeat(32) + '?x=1', null, 123]) {
    assert.throws(() => createBoard({ dataDir: dir, sports: SPORTS, adminPath }), /Invalid private admin path/);
  }
});

test('Knowing the private path gives guests no API reads, exports or writes', async t => {
  const x = setup(t);
  for (const role of ['guest', null, 'admin']) {
    for (const route of ['/api/board', '/api/security', '/api/export?fmt=json', '/api/export?fmt=csv', `/api/device/${DEV}`]) {
      const result = await x.request(ADMIN + route, { role });
      assert.equal(result.status, 404); assert.deepEqual(result.data, { error: 'Not found' }); privateHeaders(result);
    }
    for (const method of ['POST', 'DELETE']) {
      const result = await x.request(`${ADMIN}/api/device/${DEV}`, { role, method, headers: WRITE, body: JSON.stringify({ label: 'Unauthorized change' }) });
      assert.equal(result.status, 404); privateHeaders(result);
    }
    const page = await x.request(ADMIN, { role });
    assert.equal(page.status, 302); assert.equal(page.headers.location, ADMIN + '/login'); privateHeaders(page);
    const unknown = await x.request(ADMIN + '/unknown', { role });
    assert.equal(unknown.status, 404); assert.equal(unknown.headers.location, undefined);
  }
  assert.equal((await x.request(`${ADMIN}/api/device/${DEV}`)).data.who, '');
});

test('Owner can read the private dashboard, connection diagnostics, device and security records', async t => {
  const x = setup(t);
  for (const suffix of ['', '/', '/api/board', '/api/security', `/api/device/${DEV}`]) {
    const result = await x.request(ADMIN + suffix);
    assert.equal(result.status, 200); privateHeaders(result);
  }
  assert.equal((await x.request(ADMIN + '/api/board')).data.connection.ip, '127.0.0.1');
});

test('Owner exports preserve records and restrictive headers in CSV and JSON', async t => {
  const x = setup(t);
  const json = await x.request(ADMIN + '/api/export?fmt=json');
  assert.equal(json.status, 200); assert.equal(json.data.devices[DEV].role, 'guest');
  assert.match(json.headers['content-disposition'], /attachment; filename="board-all-.*\.json"/); privateHeaders(json);
  const csv = await x.request(ADMIN + '/api/export?fmt=csv');
  assert.equal(csv.status, 200); assert.match(csv.body, /^time_iso,device,who,role,/);
  assert.match(csv.headers['content-disposition'], /\.csv"$/); privateHeaders(csv);
});

test('Privileged writes require an explicit admin header and matching origin evidence', async t => {
  const x = setup(t), url = `${ADMIN}/api/device/${DEV}`;
  for (const headers of [{}, { 'x-board-admin': '1' }, { ...WRITE, origin: 'https://attacker.test' }, { ...WRITE, 'sec-fetch-site': 'cross-site' }, { origin: WRITE.origin, 'sec-fetch-site': 'same-origin' }]) {
    for (const method of ['POST', 'DELETE']) {
      const result = await x.request(url, { method, headers, body: JSON.stringify({ label: 'Rejected' }) });
      assert.equal(result.status, 403); privateHeaders(result);
    }
  }
  assert.equal((await x.request(url)).data.who, '');
  const changed = await x.request(url, { method: 'POST', headers: WRITE, body: JSON.stringify({ label: 'Owner-approved fixture' }) });
  assert.equal(changed.status, 200); assert.deepEqual(changed.data, { ok: true }); privateHeaders(changed);
  assert.equal((await x.request(url)).data.who, 'Owner-approved fixture');
  const removed = await x.request(url, { method: 'DELETE', headers: WRITE });
  assert.equal(removed.status, 200); privateHeaders(removed);
  assert.equal((await x.request(url)).status, 404);
});

test('A device display role never confers authorization to a guest request', async t => {
  const x = setup(t), url = `${ADMIN}/api/device/${DEV}`;
  assert.equal((await x.request(url, { method: 'POST', headers: WRITE, body: JSON.stringify({ role: 'owner' }) })).status, 200);
  assert.equal((await x.request(url)).data.role, 'owner');
  assert.equal((await x.request(ADMIN + '/api/board', { role: 'guest' })).status, 404);
  assert.equal((await x.request(url, { role: 'guest', method: 'DELETE', headers: WRITE })).status, 404);
});

test('Rendered private admin page uses only the configured base and suppresses external referrers', async t => {
  const x = setup(t), html = (await x.request(ADMIN)).body;
  assert.doesNotMatch(html, /\/admin(?:[/'"?]|$)/);
  assert.match(html, new RegExp(`href="${ADMIN}/api/export\\?fmt=csv"`));
  assert.match(html, new RegExp(`api\\('${ADMIN}/api/board'\\)`));
  assert.ok(html.includes("location.href='" + ADMIN + "/login'"));
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotThrow(() => new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
});


test('owner, brand and sport display labels cannot escape generated HTML or its inline script', () => {
  const render = require('../board-page');
  const ownerName = '</script><script>globalThis.labelAttack=true</script><!--\u2028\u2029__SCRIPT__';
  const brand = '</title><img src=x onerror="globalThis.brandAttack=true">&\"\'';
  const sportKey = '\"><svg onload="globalThis.keyAttack=true">';
  const sportLabel = '</option></select><img src=x onerror="globalThis.sportAttack=true"></script>';
  const html = render({ brand, ownerName, sports: [[sportKey, sportLabel]], logo: '', adminPath: ADMIN });
  // A browser must encounter exactly the real script, with no injected executable HTML elements.
  assert.equal((html.match(/<script(?:\s|>)/gi) || []).length, 1);
  assert.equal((html.match(/<\/script\s*>/gi) || []).length, 1);
  assert.doesNotMatch(html, /<(?:img|svg)\b/i);
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.equal((html.match(/<\/title>/g) || []).length, 1);
  assert.match(html, /&lt;\/title&gt;&lt;img src=x onerror=&quot;globalThis\.brandAttack=true&quot;&gt;/);
  assert.match(html, /option value="&quot;&gt;&lt;svg onload=&quot;globalThis\.keyAttack=true&quot;&gt;"/);
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(inline));
  assert.doesNotMatch(inline, /[\u2028\u2029]/);
  // Interpret the generated declaration, rather than merely checking for an escaping substring.
  const declaration = inline.match(/^var OWNER=.*;$/m)[0];
  const context = {}; vm.runInNewContext(declaration + ';globalThis.displayValues={OWNER,SPORT};', context);
  assert.equal(context.labelAttack, undefined);
  assert.equal(context.displayValues.OWNER, ownerName);
  assert.equal(context.displayValues.SPORT[sportKey], sportLabel);
});


test('blocking or signing out a device revokes its linked account sessions; cosmetic changes do not', async t => {
  const revoked = [], x = setup(t, ADMIN, { onRevokeDevice: id => revoked.push(id) });
  for (const action of ['block', 'unblock', 'signout']) {
    const result = await x.request(`${ADMIN}/api/device/${DEV}`, { method: 'POST', headers: WRITE, body: JSON.stringify({ action }) });
    assert.equal(result.status, 200);
  }
  await x.request(`${ADMIN}/api/device/${DEV}`, { method: 'POST', headers: WRITE, body: JSON.stringify({ label: 'My friend' }) });
  assert.deepEqual(revoked, [DEV, DEV]);
});
