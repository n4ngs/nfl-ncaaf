'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { slimGame, slimQuote, QUOTE_KEYS } = require('../shared/wire-diet');

const quote = (over = {}) => ({
  actual_start_at: null, actual_start_source: null, actual_start_verified: false, american_odds: -110,
  canonical_event_id: '401872954', canonical_market_key: 'nfl:401872954:s:full_game:-', fixtureId: null, is_live: false,
  line_value: -6.5, market_status: 'active', market_type: 's', optionId: '0HC1', optionMarketId: '2_1', pair_id: 'a'.repeat(64),
  period: 'full_game', provenance_hash: 'h'.repeat(64), provider_event_id: '1636886997', reason_code: null,
  received_at: '2026-09-25T01:53:49.109Z', scheduled_start_at: '2026-09-27T17:00:00.000Z', selection: 'home',
  snapshot_id: 's'.repeat(64), source: 'owls', source_observed_at: '2026-09-25T01:52:55.951Z', sport: 'nfl', sportsbook: 'dk',
  team: null, validation_status: 'VALID', freshness: 'FRESH', age_ms: 93874, observed_repeat_of: 's'.repeat(64), ...over,
});

test('slimQuote keeps every field the boards read and drops the rest', () => {
  const q = slimQuote(quote({ bet_link: 'https://x', conflict: true }));
  for (const k of ['snapshot_id', 'pair_id', 'american_odds', 'line_value', 'is_live', 'market_status', 'validation_status',
    'source', 'source_observed_at', 'freshness', 'age_ms', 'canonical_event_id', 'canonical_market_key',
    'market_type', 'selection', 'sportsbook', 'period', 'bet_link', 'conflict']) assert.ok(k in q, k);
  assert.equal(q.is_live, false, 'booleans survive (the client does typeof checks)');
  for (const k of ['provenance_hash', 'optionId', 'optionMarketId', 'fixtureId', 'provider_event_id', 'scheduled_start_at',
    'sport', 'team', 'observed_repeat_of', 'actual_start_source', 'actual_start_verified', 'received_at']) assert.ok(!(k in q), 'dropped ' + k);
  assert.ok(!('reason_code' in q), 'null values are not sent');
  assert.equal(slimQuote(null), null);
  assert.ok(JSON.stringify(q).length < JSON.stringify(quote()).length * 0.7, 'a third lighter even with a bet link');
  assert.equal(q.pair_id, 'a'.repeat(16), 'a 64-hex pair id travels as its first 16 characters');
  assert.equal(slimQuote(quote({ pair_id: 'owls:1636886997:draftkings:spreads' })).pair_id, 'owls:1636886997:draftkings:spreads');
});

test('snapshot_ids travel only when they say something the observations do not', () => {
  const same = { integrity: { s: { home: quote() } }, snapshot_ids: { s: { home: 's'.repeat(64) } } };
  assert.ok(!('snapshot_ids' in require('../shared/wire-diet').slimLine(same)));
  const extra = { integrity: { s: { home: quote() } }, snapshot_ids: { s: { home: 's'.repeat(64), away: 'x'.repeat(64) } } };
  assert.deepEqual(require('../shared/wire-diet').slimLine(extra).snapshot_ids, extra.snapshot_ids);
  const none = { s: -3, snapshot_ids: { s: { home: 'y' } } };
  assert.deepEqual(require('../shared/wire-diet').slimLine(none).snapshot_ids, none.snapshot_ids, 'no observations: keep the ids');
});

test('slimGame trims books, live, first half, team totals and the canonical market resolutions', () => {
  const L = { s: -6.5, so: [-110, -110], t: 45.5, to: [-110, -110], ml: [-250, 210], src: 'owls', freshness: 'FRESH', age_ms: 5,
    integrity: { s: { home: quote(), away: quote({ selection: 'away' }) }, ml: { home: quote({ market_type: 'ml' }) } },
    snapshot_ids: { s: { home: 's'.repeat(64), away: 'a'.repeat(64) } }, market_sources: { s: 'owls' }, integrityMeta: { s: { home: { provider_received_at: 'x' } } } };
  const g = {
    id: '401872954', home: { abbr: 'KC' }, away: { abbr: 'LV' }, model: { status: 'OK', fairMargin: 3.2 },
    books: { dk: L, pin: L }, live: { pin: L }, h1: { dk: L }, tt: { home: L },
    integrity: { thresholds: { pregame_ms: 600000 }, retrospective_status: 'X', markets: { 's:home': {
      close_status: 'PROVISIONAL', kickoff_basis: 'SCHEDULED_START', resolver_version: 'clv-integrity-v1', resolved_at: 'now',
      reason_code: 'R', close: quote(), close_freshness: { status: 'FRESH' }, canonical_event_id: '401872954', market_type: 's',
      selection: 'home', sportsbook: 'dk', source: 'owls', open_snapshot_id: 'o', current_snapshot_id: 'c', actual_start_at: null,
      scheduled_start_at: 'x', resolution_id: 'r'.repeat(64), open: quote(), current: quote(), latest_snapshot: quote(),
      current_freshness: { status: 'FRESH', age_ms: 1 } } } },
  };
  const s = slimGame(g);
  assert.deepEqual(s.model, g.model);
  assert.equal(s.books.dk.s, -6.5); assert.deepEqual(s.books.dk.so, [-110, -110]);
  assert.deepEqual(s.books.dk.snapshot_ids, L.snapshot_ids, 'bet entry ids survive');
  assert.equal(s.books.dk.freshness, 'FRESH');
  assert.ok(!('integrityMeta' in s.books.dk));
  assert.ok(!('provenance_hash' in s.books.dk.integrity.s.home));
  assert.equal(s.books.dk.integrity.s.away.selection, 'away');
  for (const grp of ['live', 'h1', 'tt']) assert.ok(!('provenance_hash' in Object.values(s[grp])[0].integrity.s.home), grp);
  const r = s.integrity.markets['s:home'];
  assert.equal(r.close_status, 'PROVISIONAL'); assert.equal(r.kickoff_basis, 'SCHEDULED_START');
  assert.deepEqual(r.current_freshness, { status: 'FRESH', age_ms: 1 });
  for (const k of ['resolver_version', 'resolved_at', 'open_snapshot_id', 'current_snapshot_id', 'scheduled_start_at', 'resolution_id', 'latest_snapshot']) assert.ok(!(k in r), k);
  assert.equal(r.current.snapshot_id, 's'.repeat(64)); assert.ok(!('provenance_hash' in r.current));
  assert.deepEqual(s.integrity.thresholds, g.integrity.thresholds);
  // the input is not mutated (the engine keeps its own view for change detection and history)
  assert.ok('provenance_hash' in g.books.dk.integrity.s.home);
  assert.ok('latest_snapshot' in g.integrity.markets['s:home']);
  assert.ok(QUOTE_KEYS.includes('snapshot_id'));
});

test('slimGame tolerates games without books or integrity', () => {
  assert.deepEqual(slimGame({ id: 1, books: null, integrity: null }), { id: 1, books: null, integrity: null });
  assert.deepEqual(slimGame({ id: 2 }), { id: 2 });
  assert.equal(slimGame(null), null);
});
