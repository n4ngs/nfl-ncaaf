'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Capture = require('../nhl/lib/capture');

const START = Date.parse('2026-10-10T23:00:00Z');
const game = { id: '2026020001', start: new Date(START).toISOString(), state: 'pre', final: false };
const books = (h, a) => ({ draftkings: { integrity: { ml: {
  home: { american_odds: h, source_observed_at: '2026-10-10T20:00:00Z', source: 'owls', freshness: 'FRESH' },
  away: { american_odds: a, source_observed_at: '2026-10-10T20:00:00Z', source: 'owls', freshness: 'FRESH' } } } } });
const box = starters => ({ gameState: 'PRE', homeTeam: { id: 10 }, awayTeam: { id: 20 }, playerByGameStats: starters ? {
  homeTeam: { goalies: [{ playerId: 1, starter: starters.home === 1, name: { default: 'A. One' } }, { playerId: 2, starter: starters.home === 2 }] },
  awayTeam: { goalies: [{ playerId: 3, starter: true }] } } : undefined });
const lines = dir => fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));

test('capture logs prices and starter flags only on change, only inside the pregame window, and survives restarts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhl-capture-'));
  let t = START - 9 * 3600e3, raw = box(null), fetches = 0;
  const make = () => Capture.create({ dir, now: () => t, fetchBox: async () => { fetches++; return raw; } });
  let c = make();

  await c.tick([game], () => books(-150, 130));                 // 9h out: outside window
  assert.equal(lines(dir).length, 0); assert.equal(fetches, 0);

  t = START - 6 * 3600e3;
  await c.tick([game], () => books(-150, 130));                 // first price + "no starters yet" for both sides
  let L = lines(dir);
  assert.deepEqual(L.map(r => r.type).sort(), ['goalie', 'goalie', 'ml']);
  assert.equal(L.find(r => r.type === 'ml').books.draftkings.home.o, -150);
  assert.deepEqual(L.filter(r => r.type === 'goalie').map(r => r.starters.length), [0, 0]);

  t += 60e3;
  await c.tick([game], () => books(-150, 130));                 // unchanged price; boxscore not due (5 min cadence far out)
  assert.equal(lines(dir).length, 3); assert.equal(fetches, 1);

  t = START - 40 * 60e3; raw = box({ home: 2 });
  await c.tick([game], () => books(-135, 115));                 // backup confirmed + line moves
  L = lines(dir);
  const g = L.filter(r => r.type === 'goalie' && r.side === 'home').pop();
  assert.deepEqual(g.starters.map(s => s.id), [2]); assert.equal(g.gameState, 'PRE'); assert.equal(g.teamId, 10);
  assert.equal(L.filter(r => r.type === 'ml').pop().books.draftkings.home.o, -135);
  const before = L.length;

  c = make();                                                   // restart: seeded state must not duplicate
  t += 60e3;
  await c.tick([game], () => books(-135, 115));
  assert.equal(lines(dir).length, before);

  t = START + 10 * 60e3;                                        // past the window
  await c.tick([game], () => books(-500, 400));
  assert.equal(lines(dir).length, before);
  assert.equal(c.read('2026-10-10').trim().split('\n').length, before);
  assert.equal(c.read('../etc'), null);
});

test('fetch failures are counted, not thrown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhl-capture-'));
  const c = Capture.create({ dir, now: () => START - 3600e3, fetchBox: async () => { throw new Error('boom'); } });
  await c.tick([game], () => ({}));
  assert.equal(c.status().errors, 1); assert.equal(c.status().written, 0);
});
