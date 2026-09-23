'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createBoard = require('../board');
const ADMIN = '/entry-0123456789abcdef0123456789abcdef';
const ENV = ['RAILWAY_SERVICE_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID'];
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const dev = (n) => String(n).repeat(24).slice(0, 24);
test.beforeEach(t => {
  const previous = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  ENV.forEach(k => { delete process.env[k]; });
  t.after(() => ENV.forEach(k => { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }));
});
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-people-'));
  const uid = 'a'.repeat(32);
  fs.mkdirSync(path.join(dir, 'nfl'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'nfl/group.json'), JSON.stringify({ people: { [uid]: { name: 'Sam' } } }));
  const board = createBoard({ dataDir: dir, adminPath: ADMIN, sports: { nfl: { ck: 'ps', label: 'NFL', dir: 'nfl' } } });
  t.after(() => { board.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const visit = (id, ua, ip, role, extra = '') => {
    const who = board.identify({ method: 'GET', socket: { remoteAddress: ip }, headers: { cookie: `tb_dev=${id}${extra}`, 'user-agent': ua } }, true);
    board.client(who, role, 'nfl', '{"events":[]}');
  };
  const get = (url) => {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    board.handle({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res, url, '', 'owner');
    return JSON.parse(res.body);
  };
  return { board, visit, get, uid };
}

test('people: owner incognito is matched to the owner, same-name and same-browser guests are one person', t => {
  const x = setup(t);
  x.visit(dev(1), MAC, '203.0.113.10', 'owner');                        // owner laptop
  x.visit(dev(2), MAC, '203.0.113.10', 'guest');                        // owner in a private window: new cookie, guest role
  x.visit(dev(3), IPHONE, '198.51.100.7', 'guest', `; ps_uid=${x.uid}`); // Sam typed a name
  x.visit(dev(4), IPHONE, '198.51.100.7', 'guest');                     // Sam again, other browser profile, no name
  x.visit(dev(5), ANDROID, '198.51.100.7', 'guest');                    // someone else on Sam's Wi-Fi
  x.visit(dev(6), IPHONE, '192.0.2.44', 'guest');                       // a stranger with the same iPhone, other network
  const b = x.get(ADMIN + '/api/board');
  const by = Object.fromEntries(b.devices.map(d => [d.id, d]));
  assert.equal(by[dev(1)].role, 'owner'); assert.equal(by[dev(1)].likelyYou, false);
  assert.equal(by[dev(2)].role, 'owner'); assert.equal(by[dev(2)].likelyYou, true);
  assert.equal(by[dev(3)].who, 'Sam'); assert.equal(by[dev(4)].who, 'Sam', 'unnamed profile joined to the named one');
  assert.equal(by[dev(4)].person.devices, 2);
  assert.equal(by[dev(5)].person.named, false); assert.equal(by[dev(6)].person.named, false);
  assert.deepEqual({ people: b.counts.people, named: b.counts.named, unnamed: b.counts.unnamed, you: b.counts.yourProfiles, likely: b.counts.likelyYou, newWeek: b.counts.newWeek },
    { people: 3, named: 1, unnamed: 2, you: 1, likely: 1, newWeek: 3 });
  // "Not me" undoes the automatic match
  const res = { writeHead(s) { this.status = s; }, end(v) { this.body = v; } };
  const req = { method: 'POST', headers: { 'x-board-admin': '1', 'sec-fetch-site': 'same-origin', host: 'x' }, socket: {}, on(ev, fn) { if (ev === 'data') fn(JSON.stringify({ role: 'guest' })); if (ev === 'end') fn(); } };
  x.board.handle(req, res, `${ADMIN}/api/device/${dev(2)}`, '', 'owner');
  return new Promise(r => setTimeout(r, 20)).then(() => {
    const b2 = x.get(ADMIN + '/api/board');
    assert.equal(b2.devices.find(d => d.id === dev(2)).role, 'guest'); assert.equal(b2.counts.people, 4);
  });
});

test('people: the owner mark is sticky, and IPv6 matches on the /64 network', t => {
  const x = setup(t);
  x.visit(dev(1), IPHONE, '2600:1700:abcd:1234::5', 'owner');
  x.visit(dev(1), IPHONE, '2600:1700:abcd:1234::5', 'guest');           // a later request without the owner cookie
  x.visit(dev(7), IPHONE, '2600:1700:abcd:1234:9f00:1:2:3', 'guest');   // private window, rotated IPv6 address
  const b = x.get(ADMIN + '/api/board');
  const by = Object.fromEntries(b.devices.map(d => [d.id, d]));
  assert.equal(by[dev(1)].role, 'owner'); assert.ok(by[dev(1)].ownerAt);
  assert.equal(by[dev(7)].likelyYou, true); assert.equal(by[dev(7)].network, '2600:1700:abcd:1234::/64'); assert.equal(by[dev(7)].ipVersion, 6);
  assert.equal(b.counts.people, 0);
});
