'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { packGame, unpackGame, packWeek, packQuote, unpackQuote, VERSION } = require('../design/wire');
const { slimGame } = require('../shared/wire-diet');

const quote = (over = {}) => ({
  snapshot_id: 'a'.repeat(64), pair_id: 'b'.repeat(16), american_odds: -110, line_value: -6.5, is_live: false, market_status: 'active',
  validation_status: 'VALID', source: 'owls', source_observed_at: '2026-09-25T01:52:55.951Z', freshness: 'FRESH', age_ms: 93874,
  canonical_event_id: '401872954', canonical_market_key: 'nfl:401872954:s:full_game:-', market_type: 's', selection: 'home',
  sportsbook: 'dk', period: 'full_game', ...over,
});
const line = (over = {}) => ({ s: -6.5, so: [-110, -110], t: 45.5, to: [-110, -110], ml: [-250, 210], src: 'owls', freshness: 'FRESH', age_ms: 5,
  integrity: { s: { home: quote(), away: quote({ selection: 'away', american_odds: -105 }) }, t: { over: quote({ market_type: 't', selection: 'over', canonical_market_key: 'nfl:401872954:t:full_game:-', line_value: 45.5 }) } }, ...over });
function game() {
  return {
    id: '401872954', wk: '2026-2-03', state: 'pre', home: { abbr: 'KC' }, away: { abbr: 'LV' }, model: { status: 'OK', fairMargin: 3.2 },
    books: { dk: line(), pin: line({ src: 'sharp', integrity: { s: { home: quote({ sportsbook: 'pin', source: 'sharp', validation_status: 'UNVERIFIED', reason_code: 'MISSING_SOURCE_TIMESTAMP', source_observed_at: null, provider_received_at: '2026-09-25T01:00:00.000Z', bet_link: { provider: 'sharp', url: 'https://x' } }) } } }) },
    live: null,
    h1: { dk: line({ integrity: { h1s: { home: quote({ market_type: 'h1s', period: 'first_half', canonical_market_key: 'nfl:401872954:h1s:first_half:-', line_value: -3 }) } } }) },
    tt: { home: line({ integrity: { tt: { over: quote({ market_type: 'tt', selection: 'over', sportsbook: 'cons', canonical_market_key: 'nfl:401872954:tt:full_game:home' }) } } }) },
    mkt: { s: -6.5, so: [-110, -110], at: '2026-09-25T01:53:00.000Z', integrity: { s: { home: quote({ sportsbook: 'dk' }) } } },
    open: null, close: null,
    integrity: { thresholds: { pregame_ms: 600000 }, retrospective_status: 'X', markets: { 's:home': {
      close_status: 'PROVISIONAL', kickoff_basis: 'SCHEDULED_START', reason_code: 'R', close: null, close_freshness: { status: 'FRESH' },
      canonical_event_id: '401872954', market_type: 's', selection: 'home', sportsbook: 'dk', source: 'owls', actual_start_at: null,
      open: quote({ source: 'owls_open' }), current: quote({ market_status: 'suspended' }), current_freshness: { status: 'FRESH', age_ms: 1 } } } },
    spark: { s: [[1, 2]] }, moves: [],
  };
}

test('a packed quote drops what its position implies and restores it exactly', () => {
  const ctx = { sport: 'nfl', event: '401872954', book: 'dk', mkt: 's', side: 'home' };
  const c = packQuote(quote(), ctx);
  for (const k of ['e', 'sb', 'mt', 'sl', 'pd', 'k', 'm', 'v']) assert.ok(!(k in c), 'derived key left out: ' + k);
  assert.equal(c.i, 'a'.repeat(64)); assert.equal(c.o, -110); assert.equal(c.L, false);
  assert.deepEqual(unpackQuote(c, ctx), quote());
  // a value that differs from its position travels; an absent field stays absent
  const odd = quote({ sportsbook: 'cons', market_status: 'suspended' }); delete odd.validation_status; delete odd.canonical_market_key;
  const c2 = packQuote(odd, ctx);
  assert.equal(c2.sb, 'cons'); assert.equal(c2.m, 'suspended'); assert.equal(c2._, 'v,k');
  assert.deepEqual(unpackQuote(c2, ctx), odd);
  assert.ok(JSON.stringify(c).length < JSON.stringify(quote()).length / 2);
});

test('a packed game unpacks to the same game, and unpack is idempotent', () => {
  const g = game();
  const packed = packGame(g, 'nfl');
  assert.equal(packed._w, VERSION); assert.equal(packed._s, 'nfl');
  assert.ok(!('canonical_market_key' in packed.books.dk.integrity.s.home));
  assert.equal(packed.books.pin.integrity.s.home.v, 'UNVERIFIED');
  assert.equal(packed.tt.home.integrity.tt.over.k, 'nfl:401872954:tt:full_game:home', 'a key that does not follow the template travels whole');
  assert.equal(packed.integrity.markets['s:home'].current.m, 'suspended');
  assert.deepEqual(unpackGame(packed), g);
  assert.deepEqual(unpackGame(g), g, 'a plain game passes through');
  assert.deepEqual(unpackGame(unpackGame(packed)), g);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(g).length * 0.6);
  const w = packWeek({ id: 'w', games: [g, g] }, 'nfl');
  assert.equal(w.games.length, 2); assert.deepEqual(unpackGame(w.games[1]), g);
});

test('the diet and the wire format compose', () => {
  const g = game();
  g.books.dk.integrity.s.home.provenance_hash = 'h'.repeat(64);
  const slim = slimGame(g);
  assert.deepEqual(unpackGame(packGame(slim, 'nfl')), slim);
});
