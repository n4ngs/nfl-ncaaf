'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function harness(sport, initial) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clv-bets-'));
  if (initial) fs.writeFileSync(path.join(dataDir, 'bets.json'), JSON.stringify(initial));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  for (const name of ['bets', 'util']) delete require.cache[require.resolve(path.join(ROOT, sport, 'lib', name))];
  const Bets = require(path.join(ROOT, sport, 'lib/bets'));
  if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
  return { Bets, dataDir, clean: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}
const leg = (overrides = {}) => ({ gid: '123', mkt: 's', side: 'home', line: -3, odds: -110,
  start: '2026-09-21T20:00:00Z', ...overrides });
const game = (h, a, extras = {}) => ({ id: '123', state: 'post', final: true, home: { score: h, q: [7, 7, 7, h - 21] }, away: { score: a, q: [3, 7, 3, a - 13] }, ...extras });
for (const sport of ['nfl', 'ncaaf']) {
  test(sport + ': existing grading and settlement regressions', async (t) => {
    for (const [name, legs, games, expected, net] of [
      ['favorite covers', [leg()], { 123: game(24, 17) }, 'won', 90.91],
      ['underdog covers', [leg({ side: 'away', line: 7.5 })], { 123: game(24, 17) }, 'won', 90.91],
      ['spread push', [leg({ line: -7 })], { 123: game(24, 17) }, 'push', 0],
      ['over wins', [leg({ mkt: 't', side: 'over', line: 40.5 })], { 123: game(24, 17) }, 'won', 90.91],
      ['under wins', [leg({ mkt: 't', side: 'under', line: 41.5 })], { 123: game(24, 17) }, 'won', 90.91],
      ['moneyline tie', [leg({ mkt: 'ml', line: null })], { 123: game(20, 20) }, 'push', 0],
      ['cancelled void', [leg()], { 123: game(0, 0, { state: 'off' }) }, 'void', 0],
      ['half settles at halftime', [leg({ mkt: 'h1s' })], { 123: game(14, 10, { state: 'in', final: false, period: 2, half: true }) }, 'won', 90.91],
      ['team total', [leg({ mkt: 'tt', side: 'over', team: 'home', line: 23.5 })], { 123: game(24, 17) }, 'won', 90.91],
      ['parlay push drops leg', [leg(), leg({ gid: '124', line: -7 })], { 123: game(24, 17), 124: game(24, 17) }, 'won', 90.91],
      ['parlay loss immediate', [leg({ line: -10 }), leg({ gid: '124' })], { 123: game(24, 17), 124: game(0, 0, { state: 'pre', final: false }) }, 'lost', -100],
    ]) await t.test(name, () => {
      const h = harness(sport);
      try {
        const b = h.Bets.create({ legs, stake: 100, book: 'BetMGM' }, 'owner');
        h.Bets.refresh((id) => games[id], () => ({ s: -100, t: 999 }));
        const out = h.Bets.list('owner')[0];
        assert.equal(out.status, expected); assert.equal(out.net, net); assert.equal(out.id, b.id);
        assert.equal(out.legs[0].clv, undefined, 'legacy close cannot generate CLV');
        assert.equal(out.legs[0].integrity.eligibility_status, 'MISSING_ENTRY_SNAPSHOT');
      } finally { h.clean(); }
    });
  });

  test(sport + ': immutable bet entry and owner boundaries', () => {
    const h = harness(sport);
    try {
      const b = h.Bets.create({ legs: [leg()], stake: 100, book: 'BetMGM', placed: '2026-01-01T15:00:00-08:00' }, 'owner');
      const before = b.legs[0].entry_record;
      assert.equal(before.entry_created_at, '2026-01-01T23:00:00.000Z');
      assert.equal(before.sportsbook, 'mgm');
      assert.equal(before.line_value, -3); assert.equal(before.american_odds, -110);
      assert.equal(before.entry_snapshot_id, null);
      assert.equal(h.Bets.update(b.id, { book: 'Caesars', stake: 50, line: -10, placed: '2020-01-01T00:00:00Z' }, 'other'), null);
      h.Bets.update(b.id, { book: 'Caesars', stake: 50, line: -10, placed: '2020-01-01T00:00:00Z' }, 'owner');
      assert.deepEqual(h.Bets.list('owner')[0].legs[0].entry_record, before);
      assert.equal(h.Bets.list('other').length, 0);
      assert.deepEqual(h.Bets.byOwner().get('owner')[0], h.Bets.list('owner')[0]);
      const csv = h.Bets.csv('owner');
      assert.match(csv, /clv_status,line_clv_points,clv_fair_probability_pp,clv_ev_pct/);
      assert.match(csv, /MISSING_ENTRY_SNAPSHOT/); assert.doesNotMatch(csv, /clv_pts/);
    } finally { h.clean(); }
  });
  test(sport + ': legacy scalars are preserved on disk and excluded from CLV output', () => {
    const initial = { v: 1, bets: [{ id: 'legacy', owner: 'owner', book: 'BetMGM', placed: '2020-01-01T00:00:00Z', status: 'won', net: 90.91, stake: 100, odds: -110, legs: [{ ...leg(), state: 'won', clv: { pts: 9, pct: 99 } }] }] };
    const h = harness(sport, initial);
    try {
      const before = fs.readFileSync(path.join(h.dataDir, 'bets.json'), 'utf8');
      assert.equal(h.Bets.list('owner')[0].legs[0].clv, undefined);
      assert.equal(h.Bets.list('owner')[0].legs[0].integrity.eligibility_status, 'MISSING_ENTRY_SNAPSHOT');
      h.Bets.refresh(() => game(24, 17), () => ({ s: -99 }));
      assert.equal(fs.readFileSync(path.join(h.dataDir, 'bets.json'), 'utf8'), before);
    } finally { h.clean(); }
  });
  test(sport + ': invalid wager timestamps and numbers rejected', () => {
    const h = harness(sport);
    try {
      for (const placed of ['bad', '2026-01-01T12:00:00', '2099-01-01T00:00:00Z']) assert.throws(() => h.Bets.create({ legs: [leg()], stake: 100, placed }, 'owner'));
      assert.throws(() => h.Bets.create({ legs: [leg({ odds: Infinity })], stake: 100 }, 'owner'));
      assert.throws(() => h.Bets.create({ legs: [leg({ line: Infinity })], stake: 100 }, 'owner'));
      assert.throws(() => h.Bets.create({ legs: [leg({ side: 'over' })], stake: 100 }, 'owner'));
    } finally { h.clean(); }
  });
  test(sport + ': real captured wager binds an observable quote and earns only qualified CLV', () => {
    const h = harness(sport);
    try {
      const { IntegrityStore } = require(path.join(ROOT, 'shared/clv-integrity'));
      const ledger = new IntegrityStore({ dataDir: h.dataDir, sport });
      const g = { id: '123', start: '2026-01-01T20:00:00Z', actual_start_at: '2026-01-01T20:02:00Z', actual_start_verified: true, actual_start_source: 'fixture' };
      const observe = (when, homeLine, homeOdds = -110) => ledger.observeLine(g, 'mgm', { s: homeLine, so: [homeOdds, -110], source_observed_at: when, market_status: 'active', is_live: false }, { source: 'fixture', received_at: when });
      const entry = observe('2026-01-01T19:55:00Z', -2.5)[0];
      observe('2026-01-01T20:01:00Z', -4);
      h.Bets.configureIntegrity(ledger, () => g);
      const bet = h.Bets.create({ legs: [leg({ line: -2.5, entry_snapshot_id: entry.snapshot_id })], book: 'BetMGM', stake: 100, placed: '2026-01-01T19:56:00Z' }, 'owner');
      assert.equal(bet.legs[0].entry_snapshot_id, entry.snapshot_id);
      assert.equal(bet.legs[0].integrity.eligibility_status, 'VERIFIED_CLV');
      assert.equal(bet.legs[0].integrity.line_clv_points, 1.5);
      assert.equal(bet.legs[0].integrity.price_clv_status, 'NOT_COMPARABLE');
      assert.equal(bet.legs[0].integrity.clv_ev_pct, null);
      assert.equal(ledger.entries.size, 1);
      h.Bets.update(bet.id, { book: 'Caesars' }, 'owner');
      assert.equal(h.Bets.list('owner')[0].legs[0].integrity.eligibility_status, 'VERIFIED_CLV');
      const future = h.Bets.create({ legs: [leg({ line: -2.5, entry_snapshot_id: entry.snapshot_id })], book: 'BetMGM', stake: 100, placed: '2026-01-01T19:54:00Z' }, 'owner');
      assert.equal(future.legs[0].entry_snapshot_id, null);
      assert.equal(future.legs[0].integrity.eligibility_status, 'MISSING_ENTRY_SNAPSHOT');
      const wrongBook = h.Bets.create({ legs: [leg({ line: -2.5, entry_snapshot_id: entry.snapshot_id })], book: 'Caesars', stake: 100, placed: '2026-01-01T19:56:00Z' }, 'owner');
      assert.equal(wrongBook.legs[0].entry_snapshot_id, null);
    } finally { h.clean(); }
  });
}
