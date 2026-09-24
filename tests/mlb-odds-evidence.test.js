'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-quote-evidence-'));
process.env.DATA_DIR = scratch;
const AN = require('../mlb/lib/action'), ESPN = require('../mlb/lib/espn');
const { OddsDay } = require('../mlb/lib/lines');
const Q = require('../mlb/lib/quote-evidence');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const NOW = Date.now(), iso = (n) => new Date(n).toISOString();
const GAME = { pk: 123, start: '2026-09-22T22:00:00Z', state: 'Preview', home: { full: 'Los Angeles Dodgers', name: 'Dodgers', abbr: 'LAD' }, away: { full: 'San Francisco Giants', name: 'Giants', abbr: 'SF' } };
let dayId = 0;
const day = () => new OddsDay('evidence-' + (++dayId));
function v1(overrides = {}, swap = false) {
  return { games: [{ id: 777, home_team_id: swap ? 2 : 1, away_team_id: swap ? 1 : 2, start_time: GAME.start,
    teams: [{ id: 1, full_name: GAME.home.full }, { id: 2, full_name: GAME.away.full }],
    odds: [{ book_id: 75, type: 'game', inserted: iso(NOW - 1000), is_live: false, ml_home: -140, ml_away: 120,
      spread_home: -1.5, spread_away: 1.5, spread_home_line: 130, spread_away_line: -150,
      total: 8.5, over: -110, under: -110,
      line_status: { ml_home: 'normal', ml_away: 'normal', spread_home: 'normal', spread_away: 'normal', over: 'normal', under: 'normal' }, ...overrides }] }] };
}
const v1Line = (overrides = {}) => AN.parseAN1Full(v1(overrides), [GAME]).get(123)?.mgm;
const viewed = (L, src = 'an1', at = NOW) => Q.decorateLine(Q.captureLine(L, src, at), src, at, at);
const sourceLine = (price = -110, at = NOW - 1000, overrides = {}) => Q.lineMeta({ ml: [price, 120], t: { line: 8.5, odds: [-110, -110] } },
  { source_observed_at: at == null ? null : iso(at), market_status: 'active', is_live: false, ...overrides });
function espnLine(overrides = {}) {
  const o = { provider: { name: 'DraftKings' }, lastUpdated: iso(NOW - 1000),
    pointSpread: { home: { close: { line: '-1.5', odds: '-110' } }, away: { close: { line: '+1.5', odds: '-110' } } },
    total: { over: { close: { line: 'o8.5', odds: '-110' } }, under: { close: { line: 'u8.5', odds: '-110' } } }, ...overrides };
  return ESPN.parseEspn({ events: [{ id: 999, date: GAME.start, competitions: [{ competitors: [
    { homeAway: 'home', team: { displayName: GAME.home.full } }, { homeAway: 'away', team: { displayName: GAME.away.full } }], odds: [o] }] }] }, [GAME]).get(123);
}
const quote = (more = {}) => ({ updated_at: iso(NOW - 1000), is_live: false, status: 'active', odds: -110, ...more });

test('Action v1 rejects explicit live, alternate and contradictory periods for full game and F5', () => {
  for (const fields of [{ is_live: true }, { is_live: 'true' }, { isLive: true }, { live: true }, { is_alt_market: true }, { isAlternate: true }, { period: 'firstinning' }]) {
    assert.equal(v1Line(fields), undefined, JSON.stringify(fields));
    assert.equal(AN.parseAN1(v1({ ...fields, type: 'firstfiveinnings' }), [GAME]).size, 0);
  }
  assert.ok(v1Line({ period: 'event' }));
  assert.equal(AN.parseAN1(v1(), [GAME]).size, 0, 'full-game rows never populate F5');
  assert.equal(AN.parseAN1Full(v1({ type: 'firstfiveinnings' }), [GAME]).size, 0);
});
test('Action v1 parent suspension/removal cannot be overridden by normal per-side flags', () => {
  for (const fields of [{ status: 'suspended' }, { market_status: 'closed' }, { is_suspended: true }]) {
    const L = viewed(v1Line(fields));
    for (const row of Object.values(L.quote_meta).flatMap(Object.values)) assert.equal(row.actionable, false);
    assert.equal(L.freshness, 'SUSPENDED');
  }
  assert.equal(viewed(v1Line({ inserted: null })).source_observed_at, null, 'receipt does not replace absent inserted time');
  assert.equal(viewed(v1Line({ inserted: null })).actionable, false);
});
test('F5 pick-em run lines retain an actual zero and its two recorded sides', () => {
  const L = AN.parseAN1(v1({ type: 'firstfiveinnings', spread_home: 0, spread_away: 0 }), [GAME]).get(123).mgm;
  assert.equal(L.rl.line, 0); assert.equal(L.quote_meta.rl.home.line_value, 0); assert.equal(L.quote_meta.rl.away.line_value, 0);
  assert.equal(viewed(L).quote_meta.rl.home.actionable, true);
  const mismatch = v1Line({ spread_away: 2.5 });
  assert.equal(viewed(mismatch).quote_meta.rl.home.freshness, 'CONFLICTED');
});
test('Action absent markets are null while one-sided provider evidence remains available', () => {
  const L = AN.readMarkets({ moneyline: [quote({ team_id: 1 })] }, 1, 2);
  assert.deepEqual(L.ml, [-110, null]); assert.equal(L.t, null); assert.equal(L.rl, null);
  assert.ok(L.quote_meta.ml.home); assert.equal(L.quote_meta.ml.away, undefined);
});
test('ESPN exact side lines expose mismatches and never fabricate a comparable opposite price', () => {
  const L = espnLine({ pointSpread: { home: { close: { line: '-1.5', odds: '-110' } }, away: { close: { line: '+2.5', odds: '-110' } } },
    total: { over: { close: { line: 'o8.5', odds: '-110' } }, under: { close: { line: 'u9.5', odds: '-110' } } } });
  const result = viewed(L, 'espn');
  assert.equal(result.quote_meta.rl.away.line_value, 2.5); assert.equal(result.quote_meta.t.under.line_value, 9.5);
  for (const q of Object.values(result.quote_meta).flatMap(Object.values)) { assert.equal(q.freshness, 'CONFLICTED'); assert.equal(q.actionable, false); }
  const D = day(); D.ingest(123, 'espn', { dk: L }, NOW, NOW);
  assert.equal(Object.keys(D.games[123].b).length, 0); assert.equal(D.freeze(123, NOW), false);
});
test('ESPN a missing away/under line stays unknown even when opposite-side line and both prices exist', () => {
  const result = viewed(espnLine({ pointSpread: { home: { close: { line: '-1.5', odds: '-110' } }, away: { close: { odds: '-110' } } },
    total: { over: { close: { line: 'o8.5', odds: '-110' } }, under: { close: { odds: '-110' } } } }), 'espn');
  assert.equal(result.quote_meta.rl.away.line_value, null); assert.equal(result.quote_meta.t.under.line_value, null);
  assert.equal(result.quote_meta.rl.away.actionable, false); assert.equal(result.quote_meta.t.under.actionable, false);
});
test('a disappearing total does not append null history, emit an under move or replace the opening reference', () => {
  const D = day(); D.ingest(123, 'an', { cons: sourceLine(-110, NOW - 2000) }, NOW - 1000, NOW - 1000);
  const before = JSON.stringify(D.games[123].b.cons.t), opener = JSON.stringify(D.games[123].open);
  const missing = AN.readMarkets({ moneyline: [quote({ team_id: 1 }), quote({ team_id: 2, odds: 120 })] }, 1, 2);
  const result = D.ingest(123, 'an', { cons: missing }, NOW, NOW);
  assert.deepEqual(result.moves, []); assert.equal(JSON.stringify(D.games[123].b.cons.t), before);
  assert.equal(JSON.stringify(D.games[123].open), opener);
});
test('old, aging, missing-time, future, suspended and conflicted quotes cannot create history or steam', () => {
  for (const [at, fields] of [[NOW - 3600000, {}], [NOW - Q.FRESH_FOR_MS - 1, {}], [null, {}], [NOW + 60000, {}], [NOW - 1000, { market_status: 'suspended' }], [NOW - 1000, { conflicted: true }]]) {
    const D = day(), books = ['czr', 'mgm', 'dk'];
    D.ingest(123, 'an', Object.fromEntries(books.map((book) => [book, sourceLine(-110, at, fields)])), NOW, NOW);
    const result = D.ingest(123, 'an', Object.fromEntries(books.map((book) => [book, sourceLine(-140, at, fields)])), NOW + 1000, NOW + 1000);
    assert.deepEqual(result.moves, [], JSON.stringify({ at, fields }));
    assert.equal(Object.keys(D.games[123].b).length, 0); assert.equal(D.games[123].recent.length, 0);
    assert.equal(D.freeze(123, NOW + 1000), false);
  }
});
test('same-value rechecks and price changes without a newer source clock do not move the history', () => {
  const D = day(); D.ingest(123, 'an', { cons: sourceLine(-110, NOW - 1000) }, NOW, NOW);
  const before = JSON.stringify(D.games[123].b);
  assert.deepEqual(D.ingest(123, 'an', { cons: sourceLine(-110, NOW - 1000) }, NOW + 1000, NOW + 1000).moves, []);
  assert.equal(JSON.stringify(D.games[123].b), before);
  assert.deepEqual(D.ingest(123, 'an', { cons: sourceLine(-150, NOW - 1000) }, NOW + 2000, NOW + 2000).moves, []);
  assert.equal(JSON.stringify(D.games[123].b), before);
});
test('valid newer provider quotes record the source clock and permit genuine multi-book steam across feeds', () => {
  const D = day(), books = ['czr', 'mgm', 'dk'];
  D.ingest(123, 'an', Object.fromEntries(books.map((book) => [book, sourceLine(-110, NOW - 20000)])), NOW - 1000, NOW - 1000);
  // one feed refreshing three books at once is that feed catching up, not steam
  const one = D.ingest(123, 'an', Object.fromEntries(books.map((book) => [book, sourceLine(-140, NOW - 10000)])), NOW, NOW);
  assert.equal(one.moves.find((move) => move.kind === 'steam'), undefined);
  assert.deepEqual(D.games[123].b.mgm.ml.map((row) => row[0]), [NOW - 20000, NOW - 10000]);
  // the same move arriving from two independent feeds is steam
  const E = day();
  E.ingest(123, 'an', { czr: sourceLine(-110, NOW - 20000), mgm: sourceLine(-110, NOW - 20000) }, NOW - 1000, NOW - 1000);
  E.ingest(123, 'vsin', { circa: sourceLine(-110, NOW - 20000) }, NOW - 1000, NOW - 1000);
  E.ingest(123, 'an', { czr: sourceLine(-140, NOW - 10000), mgm: sourceLine(-140, NOW - 10000) }, NOW - 500, NOW - 500);
  const two = E.ingest(123, 'vsin', { circa: sourceLine(-140, NOW - 9000) }, NOW, NOW);
  const steam = two.moves.find((move) => move.kind === 'steam');
  assert.ok(steam); assert.equal(steam.dir, 'home');
});
test('provider failover cannot masquerade as three sportsbooks moving together', () => {
  const D = day(), books = ['czr', 'mgm', 'dk'];
  D.ingest(123, 'an', Object.fromEntries(books.map((book) => [book, sourceLine(-110, NOW - 20000)])), NOW - 1000, NOW - 1000);
  const result = D.ingest(123, 'an1', Object.fromEntries(books.map((book) => [book, sourceLine(-150, NOW - 10000)])), NOW, NOW);
  assert.deepEqual(result.moves, []); assert.equal(D.games[123].recent.length, 0);
});
test('successful source omissions preserve old timestamps as unavailable context without new history', () => {
  const D = day(); D.ingest(123, 'an', { mgm: sourceLine(-110, NOW - 1000) }, NOW, NOW);
  const before = JSON.stringify(D.games[123].b);
  const result = D.ingest(123, 'an', {}, NOW + 1000, NOW + 1000);
  const L = D.projectBooks(D.games[123], NOW + 1000).mgm;
  assert.deepEqual(result.moves, []); assert.equal(JSON.stringify(D.games[123].b), before);
  assert.equal(L.quote_meta.ml.home.source_observed_at, iso(NOW - 1000));
  assert.equal(L.quote_meta.ml.home.reason_code, 'MISSING_FROM_SOURCE');
});
test('close chooses complete fresh evidence over partial consensus and rechecks age at freeze time', () => {
  const D = day(); D.ingest(123, 'pin', { pin: sourceLine(-130, NOW - 1000) }, NOW, NOW);
  D.ingest(123, 'an', { cons: AN.readMarkets({ moneyline: [quote({ team_id: 1, odds: -150 })] }, 1, 2) }, NOW, NOW);
  assert.equal(D.freeze(123, NOW), true); assert.equal(D.closeOf(123).book, 'pin'); assert.deepEqual(D.closeOf(123).ml, [-130, 120]);
  assert.equal(D.closeOf(123).source_observed_at, iso(NOW - 1000)); assert.equal(D.closeOf(123).actionable, false, 'a frozen close is historical context');
  const older = day(); older.ingest(123, 'pin', { pin: sourceLine(-130, NOW - 1000) }, NOW, NOW);
  assert.equal(older.freeze(123, NOW + Q.FRESH_FOR_MS), false);
});
test('explicit live metadata cannot mutate pregame or F5 source storage', () => {
  const D = day(); D.ingest(123, 'an', { mgm: sourceLine() }, NOW, NOW); D.setF5(123, 'an1', { mgm: sourceLine() }, NOW);
  const before = JSON.stringify(D.games);
  const live = sourceLine(); live.quote_meta.ml.home.is_live = true;
  assert.deepEqual(D.ingest(123, 'an', { mgm: live }, NOW + 1000, NOW + 1000).moves, []);
  assert.equal(D.setF5(123, 'an1', { mgm: live }, NOW + 1000), false);
  assert.equal(JSON.stringify(D.games), before);
});
test('bare legacy input remains unmodified evidence-wise, with explicitly unverified frozen context', () => {
  const D = day(), bare = { ml: [-115, -105], rl: { line: -1.5, odds: [130, -150] }, t: { line: 8.5, odds: [-110, -110] } };
  D.ingest(123, 'an', { dk: bare }, NOW - 60000, NOW - 60000); D.freeze(123, NOW);
  assert.equal(JSON.stringify(D.games).includes('quote_meta'), false);
  assert.deepEqual(D.closeOf(123).ml, bare.ml); assert.equal(D.closeOf(123).freshness, 'UNVERIFIED');
  assert.equal(D.closeOf(123).source_observed_at, null); assert.equal(D.closeOf(123).actionable, false);
  assert.equal(D.pub(123).books.dk.actionable, false);
  assert.equal(JSON.stringify(D.games).includes('quote_meta'), false, 'public decoration is read-only');
});

test('opening sparkline timestamps belong to that market and follow both source selections', () => {
  const D = day(), L = sourceLine(-110, NOW - 1000);
  L.quote_meta.ml.home.source_observed_at = iso(NOW - 20000);
  L.quote_meta.ml.away.source_observed_at = iso(NOW - 10000);
  D.ingest(123, 'an', { cons: L }, NOW, NOW);
  const spark = D.spark(D.games[123]);
  assert.equal(spark.ml[0][0], NOW - 10000);
  assert.equal(spark.t[0][0], NOW - 1000);
});
