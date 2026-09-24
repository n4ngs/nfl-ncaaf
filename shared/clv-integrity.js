'use strict';

// CLV Integrity v1. Append-only evidence; derived answers never rewrite a quote.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const RESOLVER_VERSION = 'clv-integrity-v1';
const DEFAULT_CONFIG = Object.freeze({ pregame_max_age_ms: 10 * 60e3, live_max_age_ms: 30e3, closing_max_age_ms: 10 * 60e3, aging_ratio: 0.5 });
const MARKETS = new Set(['s', 't', 'ml', 'h1s', 'h1t', 'tt']);
const n = (x) => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null;
const stable = (x) => JSON.stringify(sort(x));
function sort(x) { return Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, sort(x[k])])) : x; }
const hash = (x) => crypto.createHash('sha256').update(stable(x)).digest('hex');
const immutable = (x) => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { for (const v of Object.values(x)) immutable(v); Object.freeze(x); } return x; };
function utcSlow(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const t = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) && Math.abs(t) <= 8640000000000000 ? new Date(t).toISOString() : null;
}
// utc()/ms() run hundreds of thousands of times per board build (every market of every book of every game), and were
// the top CPU cost of the NCAAF engine. Same results, memoized for strings and computed directly for numbers.
const UTC_MEMO = new Map();
function utc(value) {
  if (typeof value !== 'string') return utcSlow(value);
  let v = UTC_MEMO.get(value);
  if (v === undefined) {
    v = utcSlow(value);
    if (UTC_MEMO.size >= 20000) UTC_MEMO.clear();
    UTC_MEMO.set(value, v);
  }
  return v;
}
const ms = (x) => {
  if (typeof x === 'number') return Number.isFinite(x) && Math.abs(x) <= 8640000000000000 ? new Date(x).getTime() : null;
  const u = utc(x); return u ? Date.parse(u) : null;
};
function configuration(c = {}) {
  const result = { ...DEFAULT_CONFIG };
  const aliases = { pregameMaxAgeMs: 'pregame_max_age_ms', liveMaxAgeMs: 'live_max_age_ms', closeMaxAgeMs: 'closing_max_age_ms', closingMaxAgeMs: 'closing_max_age_ms' };
  for (const [k, v] of Object.entries(c)) { const key = aliases[k] || k; if (key in result && n(v) !== null && n(v) > 0) result[key] = n(v); }
  return result;
}
function configFromEnv(env = process.env) { return configuration({ pregame_max_age_ms: env.CLV_PREGAME_MAX_AGE_MS, live_max_age_ms: env.CLV_LIVE_MAX_AGE_MS, closing_max_age_ms: env.CLV_CLOSING_MAX_AGE_MS, aging_ratio: env.CLV_AGING_RATIO }); }
function marketType(value) { return ({ spread: 's', total: 't', moneyline: 'ml', first_half_spread: 'h1s', first_half_total: 'h1t', team_total: 'tt' })[value] || value || ''; }
function eventInfo(e = {}) {
  if (typeof e === 'string' || typeof e === 'number') e = { id: String(e) };
  const actual = utc(e.actual_start_at);
  const verified = e.actual_start_verified === true && !!e.actual_start_source && !!actual;
  return { ...e, canonical_event_id: String(e.canonical_event_id || e.event_id || e.gid || e.id || ''), scheduled_start_at: utc(e.scheduled_start_at || e.start), actual_start_at: actual, actual_start_verified: verified, actual_start_source: verified ? String(e.actual_start_source) : null };
}
function canonicalMarketKey(sport, eventId, market, period, team) { return [sport || 'unknown', String(eventId || ''), marketType(market), period || (/^h1/.test(marketType(market)) ? 'first_half' : 'full_game'), team || '-'].join(':'); }
function americanProbability(odds) { odds = n(odds); return odds !== null && Math.abs(odds) >= 100 ? odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100) : null; }
function decimalOdds(odds) { odds = n(odds); return americanProbability(odds) === null ? null : odds < 0 ? 1 + 100 / -odds : 1 + odds / 100; }
function devig(odds) {
  if (!Array.isArray(odds) || odds.length < 2) return null;
  const p = odds.map(americanProbability); if (p.some((x) => x === null)) return null;
  const total = p.reduce((a, b) => a + b, 0); return p.map((x) => x / total);
}
function lineClv(market, selection, entry, close) {
  if (market && typeof market === 'object') { const a = market, b = selection || {}; return lineClv(a.market_type || a.mkt, a.selection || a.side, a.line_value ?? a.line, b.line_value ?? b.line); }
  market = marketType(market); entry = n(entry); close = n(close); if (entry === null || close === null) return null;
  if (market === 's' || market === 'h1s') return entry - close;
  if (market === 't' || market === 'h1t' || market === 'tt') return selection === 'over' ? close - entry : selection === 'under' ? entry - close : null;
  return null;
}
function freshness(q, at = Date.now(), config = {}) {
  const c = configuration(config), time = ms(at), source = ms(q?.source_observed_at), received = ms(q?.received_at);
  if (!q) return { status: 'UNVERIFIED', age_ms: null, reason_code: 'MISSING_SNAPSHOT' };
  if (q.conflict || q.validation_status === 'SOURCE_CONFLICT') return { status: 'UNVERIFIED', age_ms: null, reason_code: 'SOURCE_CONFLICT' };
  if (q.market_status !== 'active') return { status: q.market_status === 'unverified' ? 'UNVERIFIED' : 'SUSPENDED', age_ms: source !== null && time !== null ? time - source : null, reason_code: q.market_status === 'unverified' ? 'UNVERIFIED_MARKET_STATUS' : q.market_status === 'removed' ? 'REMOVED_MARKET' : 'SUSPENDED_MARKET' };
  if (q.validation_status && q.validation_status !== 'VALID') return { status: 'UNVERIFIED', age_ms: null, reason_code: q.reason_code || q.validation_status };
  if (source === null || received === null || time === null) return { status: 'UNVERIFIED', age_ms: null, reason_code: 'MISSING_SOURCE_TIMESTAMP' };
  if (source > received || source > time) return { status: 'UNVERIFIED', age_ms: time - source, reason_code: 'TIMESTAMP_CONFLICT' };
  const age = time - source, limit = q.is_live ? c.live_max_age_ms : c.pregame_max_age_ms;
  return { status: age > limit ? 'STALE' : age >= limit * c.aging_ratio ? 'AGING' : 'FRESH', age_ms: age, reason_code: age > limit ? 'QUOTE_TOO_OLD' : null };
}
function valid(q) { return !!q && (!q.validation_status || q.validation_status === 'VALID') && !q.conflict && q.market_status === 'active' && ms(q.source_observed_at) !== null && ms(q.received_at) !== null && ms(q.source_observed_at) <= ms(q.received_at) && americanProbability(q.american_odds) !== null; }
function kickoff(event) {
  const e = eventInfo(event);
  return { event: e, at: e.actual_start_verified ? ms(e.actual_start_at) : ms(e.scheduled_start_at), basis: e.actual_start_verified ? 'VERIFIED_ACTUAL_START' : 'SCHEDULED_START', verified: e.actual_start_verified };
}
function evidenceConflict(rows) {
  const seen = new Map();
  for (const q of rows) {
    if (q.conflict || q.validation_status === 'SOURCE_CONFLICT') return true;
    const key = [q.canonical_market_key, q.selection, q.sportsbook, q.source, q.source_observed_at].join('|');
    const value = stable([q.line_value, q.american_odds, q.is_live]);
    if (seen.has(key) && seen.get(key) !== value) return true; seen.set(key, value);
  }
  return false;
}
function resolveClose(snapshots, event = {}, config = {}, now = Date.now()) {
  const c = configuration(config), k = kickoff(event), time = ms(now);
  const base = { close_snapshot_id: null, close_status: 'UNAVAILABLE', kickoff_basis: k.basis, resolver_version: RESOLVER_VERSION, resolved_at: utc(now), reason_code: 'MISSING_CLOSE', close: null, close_freshness: { status: 'UNVERIFIED', age_ms: null, reason_code: 'MISSING_CLOSE' } };
  if (time === null) return { ...base, close_status: 'CONFLICTED', reason_code: 'INVALID_RESOLUTION_TIME' };
  if (k.at === null) return { ...base, reason_code: 'MISSING_KICKOFF_TIMESTAMP' };
  if (k.event.timestamp_conflict || k.event.source_conflict || k.event.conflict) return { ...base, close_status: 'CONFLICTED', reason_code: 'SOURCE_CONFLICT' };
  if (time < k.at) return { ...base, reason_code: 'EVENT_NOT_STARTED' };
  const rows = (snapshots || []).filter((q) => q.canonical_event_id === k.event.canonical_event_id && ms(q.received_at) !== null && ms(q.received_at) <= time);
  const pre = rows.filter((q) => q.is_live === false && ms(q.source_observed_at) !== null && ms(q.source_observed_at) < k.at);
  if (evidenceConflict(pre)) return { ...base, close_status: 'CONFLICTED', reason_code: 'SOURCE_CONFLICT' };
  const latestEvidence = rows.filter((q) => q.is_live !== true && (ms(q.source_observed_at) ?? ms(q.received_at)) < k.at).sort((a, b) => (ms(a.source_observed_at) ?? ms(a.received_at)) - (ms(b.source_observed_at) ?? ms(b.received_at))).at(-1);
  if (latestEvidence && !valid(latestEvidence)) return { ...base, reason_code: latestEvidence.market_status !== 'active' ? 'SUSPENDED_MARKET' : latestEvidence.reason_code || 'UNVERIFIED_CLOSING_QUOTE' };
  const usable = pre.filter(valid).sort((a, b) => ms(a.source_observed_at) - ms(b.source_observed_at) || a.snapshot_id.localeCompare(b.snapshot_id));
  const quote = usable.at(-1);
  if (!quote) return { ...base, reason_code: rows.some((q) => q.is_live || ms(q.source_observed_at) >= k.at) ? 'POST_KICK_CONTAMINATION' : rows.some((q) => q.market_status !== 'active') ? 'SUSPENDED_MARKET' : 'MISSING_CLOSE' };
  const age = k.at - ms(quote.source_observed_at);
  const fresh = { status: age > c.closing_max_age_ms ? 'STALE' : age >= c.closing_max_age_ms * c.aging_ratio ? 'AGING' : 'FRESH', age_ms: age, reason_code: age > c.closing_max_age_ms ? 'STALE_CLOSE' : null };
  if (age > c.closing_max_age_ms) return { ...base, reason_code: 'STALE_CLOSE', rejected_snapshot_id: quote.snapshot_id, close_freshness: fresh };
  return { ...base, close_snapshot_id: quote.snapshot_id, close_status: k.verified ? 'VERIFIED' : 'PROVISIONAL', reason_code: k.verified ? 'VERIFIED_ACTUAL_KICKOFF' : 'ACTUAL_KICKOFF_UNAVAILABLE', close: quote, close_freshness: fresh };
}
function entryInfo(entry = {}) {
  return { ...entry, canonical_event_id: String(entry.canonical_event_id || entry.event_id || entry.gid || ''), market_type: marketType(entry.market_type || entry.mkt), selection: entry.selection || entry.side || '', sportsbook: entry.sportsbook || entry.book || '', period: entry.period || (/^h1/.test(marketType(entry.market_type || entry.mkt)) ? 'first_half' : 'full_game'), line_value: n(entry.line_value ?? entry.line), american_odds: n(entry.american_odds ?? entry.odds), entry_created_at: utc(entry.entry_created_at || entry.prediction_created_at || entry.placed || entry.at), entry_snapshot_id: entry.entry_snapshot_id || null };
}
function opposite(selection) { return ({ home: 'away', away: 'home', over: 'under', under: 'over' })[selection]; }
function counterpart(q, rows, observableAt) {
  const candidates = (rows || []).filter((p) => p.snapshot_id !== q.snapshot_id && p.canonical_market_key === q.canonical_market_key && p.sportsbook === q.sportsbook && p.source === q.source && p.source_observed_at === q.source_observed_at && p.pair_id === q.pair_id && p.selection === opposite(q.selection) && (observableAt === undefined || ms(p.received_at) <= observableAt));
  const signatures = new Set(candidates.map((p) => stable([p.line_value, p.american_odds, p.is_live, p.market_status, p.validation_status])));
  if (signatures.size > 1 || candidates.some((p) => p.conflict || p.validation_status === 'SOURCE_CONFLICT')) return { conflict: true, snapshot: null };
  return { conflict: false, snapshot: candidates.find((p) => valid(p) && p.is_live === q.is_live && (q.market_type === 's' || q.market_type === 'h1s' ? p.line_value === -q.line_value : p.line_value === q.line_value)) || null };
}
function evaluateCLV(input = {}, entrySnapshot, resolution, options = {}) {
  const entry = entryInfo(input), c = configuration(options.config), close = resolution?.close || null;
  const result = { resolver_version: RESOLVER_VERSION, eligibility_status: null, status: null, reason_code: null, line_clv_points: null, clv_fair_probability_pp: null, clv_ev_pct: null, price_clv_status: 'UNAVAILABLE', entry: entrySnapshot || null, close, entry_created_at: entry.entry_created_at, entry_freshness: freshness(entrySnapshot, entry.entry_created_at, c), close_freshness: resolution?.close_freshness || { status: 'UNVERIFIED', age_ms: null, reason_code: 'MISSING_CLOSE' }, kickoff_basis: resolution?.kickoff_basis || null, resolution: resolution || null };
  const fail = (status, reason = status) => ({ ...result, eligibility_status: status, status, reason_code: reason });
  if (input.retrospective === true || (!entry.entry_created_at && !input.bet_id && !input.signal_id && !input.entry_id && (input.open || input.close || input.current))) return fail('RETROSPECTIVE_MARKET_MOVE', 'NO_TIMESTAMPED_ENTRY');
  if (!MARKETS.has(entry.market_type) || !['home', 'away', 'over', 'under'].includes(entry.selection)) return fail('UNMAPPED_MARKET');
  if (!entry.entry_created_at || !entry.entry_snapshot_id || !entrySnapshot) return fail('MISSING_ENTRY_SNAPSHOT');
  if (entrySnapshot.snapshot_id !== entry.entry_snapshot_id || entrySnapshot.canonical_event_id !== entry.canonical_event_id || entrySnapshot.market_type !== entry.market_type || entrySnapshot.period !== entry.period || entrySnapshot.selection !== entry.selection || entrySnapshot.sportsbook !== entry.sportsbook || (entry.team || null) !== (entrySnapshot.team || null)) return fail('SOURCE_CONFLICT', 'ENTRY_IDENTITY_MISMATCH');
  const at = ms(entry.entry_created_at), source = ms(entrySnapshot.source_observed_at), received = ms(entrySnapshot.received_at);
  if (source === null || received === null || source > at || received > at) return fail('SOURCE_CONFLICT', 'ENTRY_NOT_OBSERVABLE_AT_ENTRY_TIME');
  if (entry.features_as_of && (ms(entry.features_as_of) === null || ms(entry.features_as_of) > at)) return fail('SOURCE_CONFLICT', 'FEATURE_LOOKAHEAD');
  if (entrySnapshot.is_live) return fail('POST_KICK_CONTAMINATION', 'LIVE_ENTRY');
  const k = options.event ? kickoff(options.event) : kickoff(entrySnapshot);
  if (k.at !== null && at >= k.at) return fail('POST_KICK_CONTAMINATION', k.verified ? 'ENTRY_AT_OR_AFTER_ACTUAL_KICKOFF' : 'ENTRY_AT_OR_AFTER_SCHEDULED_START');
  if (result.entry_freshness.status === 'STALE') return fail('STALE_ENTRY');
  if (!valid(entrySnapshot) || !['FRESH', 'AGING'].includes(result.entry_freshness.status)) return fail('SOURCE_CONFLICT', result.entry_freshness.reason_code || 'INVALID_ENTRY_QUOTE');
  if (entry.american_odds !== entrySnapshot.american_odds || (entry.market_type !== 'ml' && entry.line_value !== entrySnapshot.line_value)) return fail('MISSING_ENTRY_SNAPSHOT', 'CAPTURED_PRICE_DOES_NOT_MATCH_SNAPSHOT');
  if (resolution?.close_status === 'CONFLICTED') return fail('SOURCE_CONFLICT', resolution.reason_code);
  if (!close || !['VERIFIED', 'PROVISIONAL'].includes(resolution?.close_status)) return fail(resolution?.reason_code === 'STALE_CLOSE' ? 'STALE_CLOSE' : resolution?.reason_code === 'POST_KICK_CONTAMINATION' ? 'POST_KICK_CONTAMINATION' : 'MISSING_CLOSE', resolution?.reason_code || 'MISSING_CLOSE');
  if (close.canonical_market_key !== entrySnapshot.canonical_market_key || close.selection !== entry.selection || close.sportsbook !== entry.sportsbook || close.source !== entrySnapshot.source) return fail('SOURCE_CONFLICT', 'CLOSING_MARKET_IDENTITY_MISMATCH');
  if (!valid(close) || close.is_live || (k.at !== null && ms(close.source_observed_at) >= k.at)) return fail('POST_KICK_CONTAMINATION', 'INVALID_CLOSING_QUOTE');
  result.line_clv_points = lineClv(entry.market_type, entry.selection, entry.line_value, close.line_value);
  result.eligibility_status = result.status = resolution.close_status === 'VERIFIED' ? 'VERIFIED_CLV' : 'PROVISIONAL_CLV';
  result.reason_code = resolution.reason_code;
  if (entry.market_type !== 'ml' && entry.line_value !== close.line_value) { result.price_clv_status = 'NOT_COMPARABLE'; return result; }
  const rows = options.snapshots || [], entryPair = counterpart(entrySnapshot, rows, at), closePair = counterpart(close, rows, ms(resolution.resolved_at));
  if (entryPair.conflict || closePair.conflict) { result.eligibility_status = result.status = result.price_clv_status = 'SOURCE_CONFLICT'; result.reason_code = 'OPPOSING_QUOTE_CONFLICT'; return result; }
  const entryOther = entryPair.snapshot, closeOther = closePair.snapshot;
  if (!entryOther || !closeOther) {
    result.price_clv_status = 'INCOMPLETE_MARKET_FOR_DEVIG';
    if (entry.market_type === 'ml') result.eligibility_status = result.status = 'INCOMPLETE_MARKET_FOR_DEVIG';
    return result;
  }
  const entryFair = devig([entrySnapshot.american_odds, entryOther.american_odds]), closeFair = devig([close.american_odds, closeOther.american_odds]);
  if (!entryFair || !closeFair) { result.price_clv_status = 'INCOMPLETE_MARKET_FOR_DEVIG'; return result; }
  result.clv_fair_probability_pp = 100 * (closeFair[0] - entryFair[0]);
  result.clv_ev_pct = 100 * (closeFair[0] * decimalOdds(entry.american_odds) - 1);
  result.price_clv_status = 'COMPARABLE';
  return result;
}

class IntegrityStore {
  /* Repeat compaction (2026-09-23). Feeds re-send an UNCHANGED price every ~2 minutes; journaling each one grew the
     NCAAF journal to 5.4M rows / 4.8 GB in two days (97% exact repeats), held entirely in memory, and starved the
     engine. A repeat of the same series (event, market, period, selection, book, source, pregame) with identical
     values is now journaled only as a heartbeat every `repeatHeartbeatMs` (6 min), and always inside the final
     `closeWindowMs` (15 min) before scheduled kickoff, so open, close (10 min budget) and freshness evidence keep
     their meaning. The newest unjournaled sighting is kept in memory and overlaid on the current quote, so live
     freshness is unchanged. Live quotes and any change of value are never compacted. The same rule collapses repeats
     already on disk at load (the file itself is never rewritten), and any snapshot referenced by an entry, signal or
     resolution is always kept. `repeatHeartbeatMs: 0` disables compaction. */
  constructor({ dataDir, sport, config = {}, repeatHeartbeatMs = 6 * 60e3, closeWindowMs = 15 * 60e3 }) {
    if (!dataDir) throw new Error('IntegrityStore requires a dataDir');
    this.sport = sport || 'unknown'; this.config = configuration(config); this.dir = path.join(dataDir, 'integrity');
    fs.mkdirSync(this.dir, { recursive: true });
    this.snapshots = new Map(); this.signals = new Map(); this.entries = new Map(); this.resolutions = new Map(); this.errors = []; this.byEvent = new Map(); this.byMarket = new Map();
    this.heartbeatMs = n(repeatHeartbeatMs) || 0; this.closeWindowMs = n(closeWindowMs) || 0;
    this.lastKept = new Map(); this.seen = new Map(); this.compaction = { loaded_repeats_skipped: 0, repeats_not_journaled: 0 };
    const referenced = new Set(); let loadingSnapshots = false;
    for (const [kind, map, id] of [['entries', this.entries, 'entry_id'], ['signals', this.signals, 'signal_id'], ['resolutions', this.resolutions, 'resolution_id'], ['snapshots', this.snapshots, 'snapshot_id']]) {
      if (kind === 'snapshots') {
        loadingSnapshots = true;
        for (const r of [...this.entries.values(), ...this.signals.values()]) if (r.entry_snapshot_id) referenced.add(r.entry_snapshot_id);
        for (const r of this.resolutions.values()) for (const k of ['open_snapshot_id', 'close_snapshot_id', 'current_snapshot_id', 'latest_snapshot_id', 'rejected_snapshot_id']) if (r[k]) referenced.add(r[k]);
      }
      const file = path.join(this.dir, `${kind}.jsonl`); if (!fs.existsSync(file)) continue;
      // Journals can exceed V8's single-string limit. Decode bounded chunks while
      // preserving every record, UTF-8 boundaries and original line numbers.
      const fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(64 * 1024), decoder = new StringDecoder('utf8');
      let pending = '', line = 0;
      const accept = (text) => {
        line++; if (!text.trim()) return;
        try {
          const row = JSON.parse(text);
          if (!row[id] || (map.has(row[id]) && stable(map.get(row[id])) !== stable(row))) throw new Error('duplicate or missing identity');
          if (loadingSnapshots && !map.has(row[id]) && !referenced.has(row[id]) && this.redundant(row)) { this.noteRepeat(row); this.compaction.loaded_repeats_skipped++; return; }
          if (!map.has(row[id])) { map.set(row[id], immutable(row)); if (loadingSnapshots) this.keep(row); }
        } catch { this.errors.push({ journal: kind, line, reason_code: 'INVALID_JOURNAL_RECORD' }); }
      };
      try {
        let bytes;
        while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
          pending += decoder.write(buffer.subarray(0, bytes));
          let start = 0, end;
          while ((end = pending.indexOf('\n', start)) !== -1) { accept(pending.slice(start, end)); start = end + 1; }
          pending = pending.slice(start);
        }
        pending += decoder.end(); if (pending.length) accept(pending);
      } finally { fs.closeSync(fd); }
    }
    for (const q of this.snapshots.values()) this.index(q);
  }
  index(q) { const key = [q.canonical_event_id, q.market_type, q.selection, q.sportsbook, q.team || '-'].join('|'); if (!this.byEvent.has(q.canonical_event_id)) this.byEvent.set(q.canonical_event_id, []); this.byEvent.get(q.canonical_event_id).push(q); if (!this.byMarket.has(key)) this.byMarket.set(key, []); this.byMarket.get(key).push(q); }
  seriesKey(q) { return [q.canonical_market_key || [q.canonical_event_id, q.market_type, q.period].join(':'), q.selection, q.sportsbook, q.source, q.is_live, q.team || '-'].join('|'); }
  valueSig(q) { return stable([q.line_value, q.american_odds, q.market_status, q.validation_status, q.reason_code, !!q.conflict, q.fixtureId ?? null, q.optionId ?? null, q.optionMarketId ?? null, q.provider_event_id ?? null, q.scheduled_start_at ?? null, q.actual_start_at ?? null, q.actual_start_verified ?? null]); }
  // True when q only re-observes the last journaled value of its series inside the heartbeat, away from kickoff.
  redundant(q) {
    if (!this.heartbeatMs || q.is_live !== false) return false;
    const last = this.lastKept.get(this.seriesKey(q)); if (!last || last.sig !== this.valueSig(q)) return false;
    const t = ms(q.source_observed_at), t0 = ms(last.q.source_observed_at), r = ms(q.received_at);
    if (t === null || t0 === null || r === null || t < t0 || t - t0 >= this.heartbeatMs) return false;
    const kick = ms(q.scheduled_start_at);
    if (kick !== null && this.closeWindowMs && t >= kick - this.closeWindowMs) return false;
    return true;
  }
  keep(q) { this.lastKept.set(this.seriesKey(q), { q, sig: this.valueSig(q) }); this.seen.delete(this.seriesKey(q)); }
  noteRepeat(q) {
    const k = this.seriesKey(q), prev = this.seen.get(k);
    if (!prev || ms(q.source_observed_at) >= ms(prev.source_observed_at)) this.seen.set(k, { source_observed_at: q.source_observed_at, received_at: q.received_at });
  }
  // The kept (journaled) snapshot with the times of its newest identical, unjournaled sighting.
  overlay(q) {
    if (!q) return q;
    const k = this.seriesKey(q), s = this.seen.get(k), last = this.lastKept.get(k);
    if (!s || !last || last.q.snapshot_id !== q.snapshot_id || ms(s.source_observed_at) <= ms(q.source_observed_at)) return q;
    return { ...q, source_observed_at: s.source_observed_at, received_at: s.received_at, observed_repeat_of: q.snapshot_id };
  }
  append(kind, value) {
    if (this.errors.length) throw new Error('Integrity journal requires repair; refusing to append to ambiguous evidence');
    if (this.pendingBatch) { if (!this.pendingBatch.has(kind)) this.pendingBatch.set(kind, []); this.pendingBatch.get(kind).push(value); return immutable(value); }
    this.writeBatch(kind, [value]);
    return immutable(value);
  }
  writeBatch(kind, values) {
    const fd = fs.openSync(path.join(this.dir, `${kind}.jsonl`), 'a');
    try { fs.writeFileSync(fd, values.map((v) => stable(v) + '\n').join('')); if (kind !== 'resolutions') fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  batch(fn) {
    if (this.pendingBatch) return fn();
    this.pendingBatch = new Map();
    let result;
    try { result = fn(); if (result && typeof result.then === 'function') throw new Error('Integrity batches must be synchronous'); }
    finally { const batch = this.pendingBatch; this.pendingBatch = null; try { for (const [kind, values] of batch) this.writeBatch(kind, values); } catch (error) { this.errors.push({ journal: 'batch', reason_code: 'JOURNAL_WRITE_FAILED' }); throw error; } }
    return result;
  }
  ingestObservation(input = {}) {
    const event = eventInfo(input.event || input), market = marketType(input.market_type || input.mkt), selection = input.selection || input.side || '';
    const source = String(input.source || ''), book = String(input.sportsbook || input.book || ''), period = input.period || (/^h1/.test(market) ? 'first_half' : 'full_game'), team = input.team || null;
    const observed = utc(input.source_observed_at), received = utc(input.received_at ?? Date.now());
    const key = canonicalMarketKey(this.sport, event.canonical_event_id, market, period, team);
    const active = input.market_status === undefined ? 'unverified' : String(input.market_status).toLowerCase();
    const status = ['active', 'open', 'trading'].includes(active) ? 'active' : ['suspended', 'closed', 'removed'].includes(active) ? active : 'unverified';
    const q = { snapshot_id: null, canonical_event_id: event.canonical_event_id, provider_event_id: input.provider_event_id ?? input.fixtureId ?? null, fixtureId: input.fixtureId ?? null, sport: this.sport, sportsbook: book, source, market_type: market, period, team, canonical_market_key: key, selection, line_value: market === 'ml' ? null : n(Object.hasOwn(input, 'line_value') ? input.line_value : input.line), american_odds: n(Object.hasOwn(input, 'american_odds') ? input.american_odds : input.odds), optionMarketId: input.optionMarketId ?? null, optionId: input.optionId ?? null, source_observed_at: observed, received_at: received, scheduled_start_at: event.scheduled_start_at, actual_start_at: event.actual_start_at, actual_start_verified: event.actual_start_verified, actual_start_source: event.actual_start_source, market_status: status, is_live: typeof input.is_live === 'boolean' ? input.is_live : null, pair_id: input.pair_id || input.observation_id || null, validation_status: 'VALID', reason_code: null };
    const declaredId = input.canonical_event_id || input.event_id || input.gid;
    if (input.conflict || input.source_conflict || input.timestamp_conflict || (declaredId && input.event && String(declaredId) !== event.canonical_event_id) || (input.canonical_market_key && input.canonical_market_key !== key) || (observed && received && ms(observed) > ms(received))) { q.validation_status = 'SOURCE_CONFLICT'; q.reason_code = 'SOURCE_CONFLICT'; }
    else if (!event.canonical_event_id || !MARKETS.has(market) || !['home', 'away', 'over', 'under'].includes(selection) || ((market === 's' || market === 'h1s' || market === 'ml') && !['home', 'away'].includes(selection)) || ((market === 't' || market === 'h1t' || market === 'tt') && !['over', 'under'].includes(selection)) || (market === 'tt' && !['home', 'away'].includes(team))) { q.validation_status = 'UNMAPPED_MARKET'; q.reason_code = 'UNMAPPED_MARKET'; }
    else if (!source || !book || !observed || !received || q.is_live === null || status === 'unverified') { q.validation_status = 'UNVERIFIED'; q.reason_code = !observed ? 'MISSING_SOURCE_TIMESTAMP' : 'MISSING_QUOTE_PROVENANCE'; }
    else if (americanProbability(q.american_odds) === null || (market !== 'ml' && q.line_value === null)) { q.validation_status = 'MALFORMED_QUOTE'; q.reason_code = 'MALFORMED_QUOTE'; }
    if (!q.pair_id) q.pair_id = hash([key, book, source, observed, market === 's' || market === 'h1s' ? Math.abs(q.line_value) : q.line_value]);
    const { snapshot_id, received_at, ...identity } = q;
    q.provenance_hash = input.provenance_hash || input.payload_fingerprint || hash(input.payload || identity);
    q.snapshot_id = hash({ ...identity, provenance_hash: q.provenance_hash });
    if (this.snapshots.has(q.snapshot_id)) return this.snapshots.get(q.snapshot_id);
    if (this.redundant(q)) { this.noteRepeat(q); this.compaction.repeats_not_journaled++; const kept = this.lastKept.get(this.seriesKey(q)).q; return immutable(this.overlay(kept)); }
    const saved = this.append('snapshots', q); this.snapshots.set(q.snapshot_id, saved); this.index(saved); this.keep(saved); return saved;
  }
  snapshot(id) { return this.snapshots.get(id) || null; }
  observeLine(event, book, L, metadata = {}) {
    if (!this.pendingBatch) return this.batch(() => this.observeLine(event, book, L, metadata));
    if (!L) return [];
    const out = [], received = metadata.received_at ?? Date.now();
    const add = (market, selection, line, odds) => {
      const metaMarket = L.integrityMeta?.[market] || L.integrityMeta?.[market.replace(/^h1/, '')];
      if (metaMarket && !Object.hasOwn(metaMarket, selection)) return;
      const side = metaMarket?.[selection] || {};
      if (line === null && odds === null && !Object.keys(side).length) return;
      out.push(this.ingestObservation({ ...metadata, event, sportsbook: book, source: metadata.source || L.source || '', market_type: market, selection, line_value: line, american_odds: odds, source_observed_at: metadata.source_observed_at ?? L.source_observed_at ?? L.sourceObservedAt ?? null, received_at: received, market_status: metadata.market_status ?? L.market_status ?? 'unverified', is_live: metadata.is_live ?? L.is_live ?? null, ...side }));
    };
    const allowed = metadata.market_type ? new Set([marketType(metadata.market_type)]) : metadata.period === 'first_half' ? new Set(['h1s', 'h1t']) : new Set(['s', 't', 'ml']);
    if (allowed.has('s') || allowed.has('h1s')) { const m = allowed.has('h1s') ? 'h1s' : 's'; add(m, 'home', n(L.s), n(L.so?.[0])); add(m, 'away', n(L.s) === null ? null : -n(L.s), n(L.so?.[1])); }
    if (allowed.has('t') || allowed.has('h1t') || allowed.has('tt')) { const m = allowed.has('tt') ? 'tt' : allowed.has('h1t') ? 'h1t' : 't'; add(m, 'over', n(L.t), n(L.to?.[0])); add(m, 'under', n(L.t), n(L.to?.[1])); }
    if (allowed.has('ml')) { add('ml', 'home', null, n(L.ml?.[0])); add('ml', 'away', null, n(L.ml?.[1])); }
    return out;
  }
  rows(event, market, selection, book, team) {
    const e = eventInfo(event); if (selection && book) return this.byMarket.get([e.canonical_event_id, marketType(market), selection, book, team || '-'].join('|')) || [];
    return (this.byEvent.get(e.canonical_event_id) || []).filter((q) => q.market_type === marketType(market) && (!selection || q.selection === selection) && (!book || q.sportsbook === book) && (team === undefined || q.team === team));
  }
  resolve(event, market, selection, book, now = Date.now()) {
    const e = eventInfo(event), all = this.rows(e, market, selection, book, e.team), k = kickoff(e), time = ms(now);
    const live = e.is_live === true || e.state === 'in';
    // Journals are append-only, so a series whose row count has not changed has nothing new. Cache the filtered and
    // sorted views per query and reuse them while no row is added and `now` is past every row's timestamps (then the
    // time filters exclude nothing, exactly as when the cache was built). Before this, every board refresh re-sorted
    // every market's full history.
    const ck = [e.canonical_event_id, marketType(market), selection, book, e.team || '-', e.quote_source || '', k.at, live].join('|');
    let c = this.resolveCache && this.resolveCache.get(ck);
    if (!c || c.n !== all.length || c.source !== all || time === null || time < c.maxT) {
      const rows = all.filter((q) => !e.quote_source || q.source === e.quote_source);
      const usableAll = rows.filter((q) => valid(q) && ms(q.source_observed_at) <= time && ms(q.received_at) <= time).sort((a, b) => ms(a.source_observed_at) - ms(b.source_observed_at) || a.snapshot_id.localeCompare(b.snapshot_id));
      const latestAll = rows.filter((q) => q.is_live === live && ms(q.received_at) <= time).sort((a, b) => (ms(a.source_observed_at) ?? ms(a.received_at)) - (ms(b.source_observed_at) ?? ms(b.received_at))).at(-1) || null;
      let maxT = -Infinity; for (const q of rows) maxT = Math.max(maxT, ms(q.source_observed_at) ?? -Infinity, ms(q.received_at) ?? -Infinity);
      c = { n: all.length, source: all, rows, usable: usableAll, latestRow: latestAll, maxT };
      if (time !== null && time >= maxT) { if (!this.resolveCache) this.resolveCache = new Map(); this.resolveCache.set(ck, c); }
    }
    const rows = c.rows, usable = c.usable;
    const pre = usable.filter((q) => q.is_live === false && (k.at === null || ms(q.source_observed_at) < k.at));
    const latestRow = c.latestRow;
    const overlaid = this.overlay(latestRow);
    const latest = overlaid && ms(overlaid.received_at) <= time ? overlaid : latestRow;
    const currentFreshness = freshness(latest, now, this.config);
    const currentConflict = latest && evidenceConflict(rows.filter((q) => q.source_observed_at === latest.source_observed_at && q.is_live === live));
    if (currentConflict) { currentFreshness.status = 'UNVERIFIED'; currentFreshness.reason_code = 'SOURCE_CONFLICT'; }
    let current = latest && !currentConflict && valid(latest) && ['FRESH', 'AGING'].includes(currentFreshness.status) ? latest : null;
    let close = resolveClose(rows, e, this.config, now); let open = pre[0] || null;
    if (this.errors.length) close = { ...close, close: null, close_snapshot_id: null, close_status: 'CONFLICTED', reason_code: 'INVALID_INTEGRITY_JOURNAL' };
    if (this.errors.length) { open = null; current = null; currentFreshness.status = 'UNVERIFIED'; currentFreshness.reason_code = 'INVALID_INTEGRITY_JOURNAL'; }
    const record = { ...close, close: undefined, canonical_event_id: e.canonical_event_id, market_type: marketType(market), selection, sportsbook: book, source: e.quote_source || null, open_snapshot_id: open?.snapshot_id || null, current_snapshot_id: current?.snapshot_id || null, actual_start_at: e.actual_start_at, scheduled_start_at: e.scheduled_start_at };
    const { resolved_at, ...identity } = record; record.resolution_id = hash(identity);
    let saved = this.resolutions.get(record.resolution_id);
    if (!saved && rows.length && close.reason_code !== 'EVENT_NOT_STARTED' && !this.errors.length) { saved = this.append('resolutions', record); this.resolutions.set(record.resolution_id, saved); }
    return { ...(saved || record), resolved_at: utc(now), open, current, latest_snapshot: latest, close: close.close, current_freshness: currentFreshness };
  }
  findEntry(input, event = {}) {
    const e = entryInfo(input), at = ms(e.entry_created_at), candidates = e.entry_snapshot_id ? [this.snapshot(e.entry_snapshot_id)] : this.rows({ ...event, id: e.canonical_event_id }, e.market_type, e.selection, e.sportsbook, e.team || null);
    if (at === null || !e.sportsbook) return null;
    return candidates.filter((q) => q && valid(q) && q.canonical_event_id === e.canonical_event_id && q.market_type === e.market_type && q.period === e.period && q.selection === e.selection && q.sportsbook === e.sportsbook && q.team === (e.team || null) && ms(q.source_observed_at) <= at && ms(q.received_at) <= at && q.american_odds === e.american_odds && (e.market_type === 'ml' || q.line_value === e.line_value)).sort((a, b) => ms(a.source_observed_at) - ms(b.source_observed_at)).at(-1) || null;
  }
  evaluateEntry(input, event = {}) {
    const entry = entryInfo(input), resolved = this.resolve({ ...event, id: entry.canonical_event_id, team: entry.team, quote_source: this.snapshot(entry.entry_snapshot_id)?.source }, entry.market_type, entry.selection, entry.sportsbook);
    if (this.errors.length) return { ...evaluateCLV(entry, this.snapshot(entry.entry_snapshot_id), resolved, { config: this.config, event, snapshots: this.byEvent.get(entry.canonical_event_id) || [] }), eligibility_status: 'SOURCE_CONFLICT', status: 'SOURCE_CONFLICT', reason_code: 'INVALID_INTEGRITY_JOURNAL', line_clv_points: null, clv_fair_probability_pp: null, clv_ev_pct: null };
    return evaluateCLV(entry, this.snapshot(entry.entry_snapshot_id), resolved, { config: this.config, event: { ...event, id: entry.canonical_event_id }, snapshots: this.byEvent.get(entry.canonical_event_id) || [] });
  }
  evaluate(input, close) { return close ? evaluateCLV(input, this.snapshot(input.entry_snapshot_id), close, { config: this.config, snapshots: this.byEvent.get(entryInfo(input).canonical_event_id) || [] }) : this.evaluateEntry(input, input.event || input); }
  recordEntry(input) {
    const entry = entryInfo(input); if (!entry.entry_id || !entry.entry_created_at || !entry.bet_id) throw new Error('An immutable entry requires entry_id, bet_id and a UTC entry time');
    const record = { ...entry, resolver_version: RESOLVER_VERSION };
    const old = this.entries.get(entry.entry_id); if (old) { if (stable(old) !== stable(record)) throw new Error('Cannot mutate an immutable bet entry'); return old; }
    if (entry.entry_snapshot_id && !this.findEntry(entry)) throw new Error('Entry snapshot is not observable at the captured wager time and price');
    const saved = this.append('entries', record); this.entries.set(entry.entry_id, saved); return saved;
  }
  recordSignal(input = {}) {
    const entry = entryInfo(input), prediction = utc(input.prediction_created_at), features = utc(input.features_as_of);
    if (!input.model_version || !input.feature_version || !prediction || !features || ms(features) > ms(prediction)) throw new Error('Signal requires model/feature versions and non-look-ahead UTC timestamps');
    const quote = entry.entry_snapshot_id && this.findEntry({ ...entry, entry_created_at: prediction });
    if (!quote) throw new Error('Signal entry quote must be observable at prediction time');
    if (!['FRESH', 'AGING'].includes(freshness(quote, prediction, this.config).status)) throw new Error('Signal entry quote must be fresh at prediction time');
    if (evidenceConflict(this.rows({ id: entry.canonical_event_id }, entry.market_type, entry.selection, entry.sportsbook, entry.team || null).filter((q) => q.source === quote.source && q.source_observed_at === quote.source_observed_at && ms(q.received_at) <= ms(prediction)))) throw new Error('Signal entry evidence is conflicted');
    const probability = n(input.predicted_probability), line = n(input.predicted_line);
    if ((probability === null && line === null) || (probability !== null && (probability < 0 || probability > 1)) || !input.signal_direction || input.signal_strength === undefined) throw new Error('Signal requires a prediction, direction and strength');
    const record = { ...entry, event_id: entry.canonical_event_id, model_version: String(input.model_version), feature_version: String(input.feature_version), prediction_created_at: prediction, features_as_of: features, predicted_probability: probability, predicted_line: line, signal_direction: input.signal_direction, signal_strength: input.signal_strength, resolver_version: RESOLVER_VERSION };
    record.signal_id = input.signal_id || hash(record);
    const old = this.signals.get(record.signal_id); if (old) { if (stable(old) !== stable(record)) throw new Error('Cannot mutate an immutable signal'); return old; }
    const saved = this.append('signals', record); this.signals.set(record.signal_id, saved); return saved;
  }
  health() { return { ok: !this.errors.length, resolver_version: RESOLVER_VERSION, sport: this.sport, snapshots: this.snapshots.size, signals: this.signals.size, entries: this.entries.size, resolutions: this.resolutions.size, journal_errors: this.errors, thresholds: { ...this.config } }; }
}

module.exports = { IntegrityStore, RESOLVER_VERSION, DEFAULT_CONFIG, configuration, configFromEnv, utc, canonicalMarketKey, americanProbability, decimalOdds, devig, lineClv, freshness, resolveClose, evaluateCLV };
