'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Record = require('../shared/vas-record'), Proof = require('../proof');

test('shared record: first scored sighting is the entry, upgrades replace GOLD, close is the last pre-start market', () => {
  let t = Date.parse('2026-10-08T15:00:00Z');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-')), 'signals.json');
  const r = Record.create({ file, now: () => t });
  assert.equal(r.observe('g1', { tier: 'PASS', side: 'home', entryOdds: -110, sideProb: 0.5 }), null);
  r.observe('g1', { tier: 'GOLD', side: 'away', entryOdds: 150, sideProb: 0.40, matchup: 'A @ B', start: '2026-10-08T23:00:00Z' });
  r.observe('g1', { tier: 'DIAMOND', side: 'away', entryOdds: 145, sideProb: 0.41 });
  assert.equal(r.get('g1').tier, 'DIAMOND'); assert.equal(r.get('g1').entryOdds, 145);
  r.observe('g1', { tier: 'GOLD', side: 'away', entryOdds: 130, sideProb: 0.44 });   // downgrade keeps the entry, updates the market
  assert.equal(r.get('g1').entryOdds, 145); assert.equal(r.get('g1').lastProb, 0.44);
  r.close('g1'); r.observe('g1', { tier: 'DIAMOND', side: 'away', entryOdds: 100, sideProb: 0.9 });
  assert.equal(r.get('g1').closeProb, 0.44, 'nothing changes after the close');
  r.settle('g1', 'won');
  const s = r.summary();
  assert.equal(s.tiers.ALL.bets, 1); assert.equal(s.tiers.DIAMOND.won, 1);
  assert.ok(Math.abs(s.tiers.ALL.clvEvPct - (0.44 * 2.45 - 1) * 100) < 1e-9);
  assert.equal(s.tiers.ALL.beatCloseRate, 1);
  const again = Record.create({ file, now: () => t });
  assert.equal(again.get('g1').result, 'won', 'persisted');
});

test('proof page is owner-only and only claims its own routes', () => {
  const P = Proof({ adminPath: '/owner-path-abcdefghijklmnopqrst', sports: {}, logo: '', ownerCookie: '' });
  const res = () => { const r = { code: 0, body: '', writeHead(c) { r.code = c; }, end(b) { r.body = b || ''; } }; return r; };
  assert.equal(P.handle({ method: 'GET' }, res(), '/nhl/', 'owner'), false);
  const g = res(); assert.equal(P.handle({ method: 'GET' }, g, '/owner-path-abcdefghijklmnopqrst/proof', 'guest'), true); assert.equal(g.code, 404);
  const o = res(); P.handle({ method: 'GET' }, o, '/owner-path-abcdefghijklmnopqrst/proof', 'owner'); assert.equal(o.code, 200); assert.match(o.body, /beat the closing line/);
  assert.equal(Proof({ adminPath: '', sports: {}, logo: '', ownerCookie: '' }).handle({ method: 'GET' }, res(), '/proof', 'owner'), false);
});
