'use strict';
// Share links (shared/share-links.js): a bet card sent like a song, with the card as the link preview.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { create } = require('../shared/share-links');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const req = (method, body) => ({ method, async *[Symbol.asyncIterator]() { if (body != null) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); } });
const res = () => { const r = { code: 0, headers: {}, body: '' }; r.writeHead = (c, h) => { r.code = c; r.headers = h || {}; }; r.end = (b) => { r.body = b == null ? '' : b; }; return r; };
const svc = (now = () => Date.UTC(2026, 8, 24)) => create({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'share-')), origin: 'https://board.test', now });

test('a signed-in board user posts the card once and gets a link whose page previews it', async () => {
  const s = svc(), r = res();
  assert.equal(await s.handle(req('POST', { image: PNG.toString('base64'), sport: 'nfl', title: 'GB −4.5 −110', text: 'GB -4.5 -110 at BetMGM\nFalcons @ Packers · Thu' }), r, '/api/share', { role: 'guest', ip: '1.1.1.1', sameOrigin: true }), true);
  assert.equal(r.code, 200);
  const url = JSON.parse(r.body).url; assert.match(url, /^https:\/\/board\.test\/s\/[A-Za-z0-9_-]{22}$/);
  const id = url.split('/').pop();
  const p = res(); await s.handle(req('GET'), p, `/s/${id}`, {});
  assert.equal(p.code, 200);
  assert.match(p.body, new RegExp(`<meta property="og:image" content="https://board.test/s/${id}.png">`));
  assert.match(p.body, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(p.body, /<meta property="og:title" content="GB −4.5 −110">/);
  assert.match(p.body, /GB -4.5 -110 at BetMGM · Falcons @ Packers · Thu/);
  assert.match(p.body, /href="\/nfl\/">Open the NFL board/);
  assert.match(p.headers['x-robots-tag'], /noindex/);
  const i = res(); await s.handle(req('GET'), i, `/s/${id}.png`, {});
  assert.equal(i.code, 200); assert.equal(i.headers['content-type'], 'image/png'); assert.deepEqual(i.body, PNG);
});

test('creating needs a sign-in from this origin and a real image; viewing unknown or expired links is a 404', async () => {
  let now = Date.UTC(2026, 8, 24); const s = svc(() => now);
  const post = async (body, ctx) => { const r = res(); await s.handle(req('POST', body), r, '/api/share', ctx); return r; };
  assert.equal((await post({ image: PNG.toString('base64') }, { role: null, sameOrigin: true })).code, 401);
  assert.equal((await post({ image: PNG.toString('base64') }, { role: 'guest', sameOrigin: false })).code, 403);
  assert.equal((await post({ image: Buffer.from('<svg onload=alert(1)>').toString('base64') }, { role: 'guest', sameOrigin: true, ip: 'a' })).code, 400);
  assert.equal((await post('not json', { role: 'guest', sameOrigin: true, ip: 'a' })).code, 400);
  const nf = res(); await s.handle(req('GET'), nf, '/s/AAAAAAAAAAAAAAAAAAAAAA', {}); assert.equal(nf.code, 404);
  const ok = await post({ image: PNG.toString('base64'), sport: 'bad', title: '<script>' }, { role: 'owner', sameOrigin: true, ip: 'a' });
  const id = JSON.parse(ok.body).url.split('/').pop();
  const p = res(); await s.handle(req('GET'), p, `/s/${id}`, {}); assert.doesNotMatch(p.body, /<script>/); assert.match(p.body, /href="\/nfl\/"/);
  const wrongExt = res(); await s.handle(req('GET'), wrongExt, `/s/${id}.jpg`, {}); assert.equal(wrongExt.code, 404);
  now += 121 * 86400e3;
  const gone = res(); await s.handle(req('GET'), gone, `/s/${id}`, {}); assert.equal(gone.code, 404);
  assert.equal(await s.handle(req('GET'), res(), '/nfl/', {}), false, 'only its own routes');
});

test('at most 40 links per address per hour', async () => {
  const s = svc();
  const post = async (ip) => { const r = res(); await s.handle(req('POST', { image: PNG.toString('base64') }), r, '/api/share', { role: 'guest', sameOrigin: true, ip }); return r.code; };
  for (let i = 0; i < 40; i++) assert.equal(await post('9.9.9.9'), 200);
  assert.equal(await post('9.9.9.9'), 429);
  assert.equal(await post('8.8.8.8'), 200);
});
