'use strict';
/* Wire diet for a board's public game view.

   Every quote a book sends is retained as a CLV Integrity observation (lib/clv-integrity): ~30 fields including
   three 64-hex hashes, provider ids and the scheduled kickoff. The board pushed every one of them, for every
   book, market and side, on every snapshot and every game patch. Measured 2026-09-24 on the live NCAAF board:
   a 12.1 MB snapshot of which 10.8 MB was `integrity` — and the phone client reads about a third of those fields.

   This trims each observation to the fields the clients actually read (js/integrity.js, js/views.js, js/edge.js,
   js/vas.js, js/tmachine.js, design/*.js — audited by grep, see the commit) and drops resolver bookkeeping the
   client never looks at. The ledger itself is untouched: /api/integrity/* and bet grading still read the full
   observation server-side. Nothing here changes a value, only which keys travel. */

const QUOTE_KEYS = [
  'snapshot_id', 'pair_id', 'american_odds', 'line_value', 'is_live', 'market_status', 'validation_status',
  'reason_code', 'source', 'source_observed_at', 'received_at', 'provider_received_at', 'freshness', 'age_ms',
  'conflict', 'source_conflict', 'timestamp_conflict', 'bet_link', 'canonical_event_id', 'canonical_market_key',
  'market_type', 'selection', 'sportsbook', 'period', 'timestamp_kind',
];
// Resolver bookkeeping on integrity.markets[*]: ids the client never reads, and latest_snapshot (a copy of current).
const MARKET_DROP = new Set(['close_snapshot_id', 'resolver_version', 'resolved_at', 'open_snapshot_id',
  'current_snapshot_id', 'scheduled_start_at', 'resolution_id', 'latest_snapshot']);

// pair_id is only ever compared for equality (both sides of a market must share one); a 64-hex digest
// can travel as its first 16 characters. Provider-native pair ids (short, readable) travel whole.
const HEX64 = /^[0-9a-f]{64}$/;
function slimQuote(q) {
  if (!q || typeof q !== 'object') return q;
  const o = {};
  for (const k of QUOTE_KEYS) { const v = q[k]; if (v !== undefined && v !== null) o[k] = v; }
  if (typeof o.pair_id === 'string' && HEX64.test(o.pair_id)) o.pair_id = o.pair_id.slice(0, 16);
  return o;
}
// A book line: { s, so, t, to, ml, integrity: {mkt: {side: quote}}, snapshot_ids, ... }
// `snapshot_ids` repeats each observation's snapshot_id; the client falls back to it only when the
// observation is missing, so it travels only when it says something the observations do not.
function slimLine(L) {
  if (!L || typeof L !== 'object') return L;
  const { integrityMeta, ...rest } = L;
  if (rest.integrity && typeof rest.integrity === 'object') {
    const m = {};
    let redundant = !!rest.snapshot_ids && typeof rest.snapshot_ids === 'object';
    for (const [mkt, sides] of Object.entries(rest.integrity)) {
      if (!sides || typeof sides !== 'object') continue;
      m[mkt] = {};
      for (const [side, q] of Object.entries(sides)) m[mkt][side] = slimQuote(q);
    }
    if (redundant) {
      for (const [mkt, sides] of Object.entries(rest.snapshot_ids)) {
        for (const [side, id] of Object.entries(sides || {})) if (id != null && m[mkt]?.[side]?.snapshot_id !== id) { redundant = false; break; }
        if (!redundant) break;
      }
    }
    rest.integrity = m;
    if (redundant) delete rest.snapshot_ids;
  }
  return rest;
}
const slimBooks = (books) => (books && typeof books === 'object'
  ? Object.fromEntries(Object.entries(books).map(([k, L]) => [k, slimLine(L)])) : books);

function slimMarket(r) {
  if (!r || typeof r !== 'object') return r;
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (MARKET_DROP.has(k)) continue;
    o[k] = (k === 'open' || k === 'current' || k === 'close') ? slimQuote(v) : v;
  }
  return o;
}

function slimGame(p) {
  if (!p || typeof p !== 'object') return p;
  const g = { ...p };
  for (const k of ['books', 'live', 'h1']) if (g[k]) g[k] = slimBooks(g[k]);
  // canonical market lines (open / now / close) are line-shaped too, with the same observation map
  for (const k of ['mkt', 'open', 'close']) if (g[k]) g[k] = slimLine(g[k]);
  if (g.tt && typeof g.tt === 'object') g.tt = Object.fromEntries(Object.entries(g.tt).map(([k, L]) => [k, slimLine(L)]));
  if (g.integrity && typeof g.integrity === 'object' && g.integrity.markets && typeof g.integrity.markets === 'object') {
    g.integrity = { ...g.integrity, markets: Object.fromEntries(Object.entries(g.integrity.markets).map(([k, r]) => [k, slimMarket(r)])) };
  }
  return g;
}

module.exports = { slimGame, slimLine, slimQuote, slimMarket, QUOTE_KEYS, MARKET_DROP };
