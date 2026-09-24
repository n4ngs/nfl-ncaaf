'use strict';
const {attachLink}=require('../../shared/bet-links');
// A quote's clock belongs to its provider; a successful HTTP fetch is a different observation.
const SIDES = { ml: ['home', 'away'], rl: ['home', 'away'], t: ['over', 'under'] };
const requestedMax = Number(process.env.MLB_PREGAME_MAX_AGE_MS), requestedFresh = Number(process.env.MLB_PREGAME_FRESH_MS);
const MAX_AGE_MS = Number.isFinite(requestedMax) && requestedMax > 0 ? requestedMax : 15 * 60e3;
const FRESH_FOR_MS = Math.min(MAX_AGE_MS, Number.isFinite(requestedFresh) && requestedFresh > 0 ? requestedFresh : 2 * 60e3);
function sourceTime(value) {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
  if (!numeric && (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))) return null;
  const at = numeric ? Number(value) * (Number(value) < 1e12 ? 1000 : 1) : Date.parse(value);
  return Number.isFinite(new Date(at).getTime()) ? new Date(at).toISOString() : null;
}
function marketState(value, fallback = 'unverified') {
  if (value === 0 || value === '0') return 'active';
  const s = String(value ?? '').toLowerCase();
  if (/^(normal|open|active|available)$/.test(s)) return 'active';
  if (/suspend|lock|pause/.test(s)) return 'suspended';
  if (/remove|closed|settled/.test(s)) return 'removed';
  return s ? 'unverified' : fallback;
}
function lineMeta(L, common = {}) {
  if (!L) return null;
  const quote_meta = {};
  for (const [market, sides] of Object.entries(SIDES)) {
    const supplied = L.quote_meta?.[market];
    const entries = {};
    for (const [i, side] of sides.entries()) {
      const old = supplied?.[side];
      if (supplied && !old) continue;
      const odds = market === 'ml' ? L.ml?.[i] : L[market]?.odds?.[i];
      const line = market === 'ml' ? null : market === 'rl' && i === 1 ? -L.rl?.line : L[market]?.line;
      if (!old && odds == null) continue;
      const q = { ...common, ...(old || {}), line_value: old ? old.line_value ?? null : line ?? null,
        american_odds: old ? old.american_odds ?? null : odds ?? null };
      q.source_observed_at = sourceTime(q.source_observed_at);
      q.market_status ||= 'unverified';
      if (q.is_live !== true && q.is_live !== false) q.is_live = null;
      entries[side] = q;
    }
    if (market !== 'ml') {
      const [a, b] = sides.map((side) => entries[side]);
      if (Number.isFinite(a?.line_value) && Number.isFinite(b?.line_value) && a.line_value !== (market === 'rl' ? -b.line_value : b.line_value)) a.conflicted = b.conflicted = true;
    }
    if (Object.keys(entries).length) quote_meta[market] = entries;
  }
  return { ...L, quote_meta };
}
function flipMeta(L, flipped) {
  if (!L?.quote_meta) return flipped;
  const quote_meta = { ...L.quote_meta };
  for (const market of ['ml', 'rl']) if (quote_meta[market]) quote_meta[market] = Object.fromEntries(Object.entries(quote_meta[market]).map(([side, q]) => [side === 'home' ? 'away' : 'home', q]));
  return { ...flipped, quote_meta };
}
function quoteView(q, market, now, maxAgeMs = MAX_AGE_MS) {
  const sourceAt = Date.parse(q.source_observed_at), receivedAt = Date.parse(q.received_at);
  const age = Number.isFinite(sourceAt) ? now - sourceAt : null;
  let freshness = 'FRESH', reason_code = null;
  if (q.conflicted || (Number.isFinite(sourceAt) && (sourceAt > now || sourceAt > receivedAt))) { freshness = 'CONFLICTED'; reason_code = 'CONFLICTED_QUOTE'; }
  else if (['suspended', 'removed'].includes(q.market_status)) { freshness = 'SUSPENDED'; reason_code = q.market_status === 'removed' ? 'MARKET_REMOVED' : 'MARKET_SUSPENDED'; }
  else if (q.missing_from_source) { freshness = 'UNVERIFIED'; reason_code = 'MISSING_FROM_SOURCE'; }
  else if (q.market_status !== 'active' || q.is_live !== false || !Number.isFinite(receivedAt)) { freshness = 'UNVERIFIED'; reason_code = 'UNVERIFIED_MARKET_STATE'; }
  else if (age == null) { freshness = 'UNVERIFIED'; reason_code = 'MISSING_SOURCE_TIMESTAMP'; }
  else if (!Number.isFinite(q.american_odds) || Math.abs(q.american_odds) < 100 || (market !== 'ml' && !Number.isFinite(q.line_value))) { freshness = 'UNVERIFIED'; reason_code = 'INVALID_PRICE'; }
  else if (age > maxAgeMs) { freshness = 'STALE'; reason_code = 'SOURCE_QUOTE_STALE'; }
  else if (age > FRESH_FOR_MS) { freshness = 'AGING'; reason_code = 'SOURCE_QUOTE_AGING'; }
  // One rule on every board (shared/clv-integrity.js): Fresh and Aging prices can be acted on, Aging with its label.
  return { ...q, freshness, reason_code, age_ms: age, fresh_for_ms: FRESH_FOR_MS, max_age_ms: maxAgeMs, actionable: freshness === 'FRESH' || freshness === 'AGING' };
}
function summarize(L, now = Date.now()) {
  const rows = Object.values(L.quote_meta || {}).flatMap(Object.values);
  const rank = { FRESH: 0, AGING: 1, STALE: 2, UNVERIFIED: 3, SUSPENDED: 4, CONFLICTED: 5 };
  const worst = rows.reduce((a, b) => !a || rank[b.freshness] > rank[a.freshness] ? b : a, null);
  const sourceClocks = rows.map((q) => Date.parse(q.source_observed_at));
  const received = rows.map((q) => Date.parse(q.received_at)).filter(Number.isFinite);
  return { ...L, source: L.src || null, is_live: L.is_live === true || rows.some((q) => q.is_live === true) ? true : rows.length && rows.every((q) => q.is_live === false) ? false : null,
    received_at: received.length ? new Date(Math.max(...received)).toISOString() : null,
    source_observed_at: sourceClocks.length && sourceClocks.every(Number.isFinite) ? new Date(Math.min(...sourceClocks)).toISOString() : null,
    freshness: worst?.freshness || 'UNVERIFIED', reason_code: worst ? worst.reason_code : 'MISSING_SOURCE_TIMESTAMP',
    actionable: !!rows.length && rows.every((q) => q.actionable), fresh_for_ms: FRESH_FOR_MS, max_age_ms: MAX_AGE_MS };
}
function decorateLine(L, src = L?.src, seen = L?.seen, now = Date.now()) {
  if (!L) return null;
  const received = sourceTime(L.received_at) || (Number.isFinite(seen) ? new Date(seen).toISOString() : null);
  const base = lineMeta(L, { source_observed_at: L.source_observed_at || null, market_status: L.market_status || 'unverified', is_live: L.is_live ?? null });
  const quote_meta = Object.fromEntries(Object.entries(base.quote_meta).map(([market, sides]) => [market, Object.fromEntries(Object.entries(sides).map(([side, q]) => [side,
    quoteView({ ...q, src: q.src || src || null, source: q.source || q.src || src || null, received_at: q.received_at || received }, market, now)]))]));
  return summarize({ ...base, quote_meta, src: src || null, seen: seen ?? null }, now);
}
function captureLine(L, src, receivedAt) {
  const base = lineMeta(L, { source_observed_at: L.source_observed_at || null, market_status: L.market_status || 'unverified', is_live: L.is_live ?? null });
  const received_at = new Date(receivedAt).toISOString();
  const quote_meta = Object.fromEntries(Object.entries(base.quote_meta).map(([market, sides]) => [market, Object.fromEntries(Object.entries(sides).map(([side, q]) => [side,
    { ...q, received_at, src, source: src }]))]));
  return { ...base, quote_meta, seen: receivedAt, received_at, src };
}
function missingLine(L, src, receivedAt) {
  const out = captureLine(L, src, receivedAt);
  out.quote_meta = Object.fromEntries(Object.entries(out.quote_meta).map(([market, sides]) => [market, Object.fromEntries(Object.entries(sides).map(([side, q]) => [side,
    { ...q, missing_from_source: true }]))]));
  return out;
}
// Display fallbacks still require a coherent pair; withdrawal is never a preferred source.
function marketDisplayRank(L, market, live = false) {
  const rows = SIDES[market].map(side=>L.quote_meta?.[market]?.[side]);
  if (!rows.every(q=>q && !q.missing_from_source && !q.conflicted && q.is_live===live && Number.isFinite(q.american_odds) && Math.abs(q.american_odds)>=100 && (market==='ml' || Number.isFinite(q.line_value)))) return 90;
  if (market!=='ml' && rows[0].line_value!==(market==='rl'?-rows[1].line_value:rows[1].line_value)) return 90;
  if (rows.every(q=>q.market_status==='active')) return 0;
  if (rows.some(q=>['suspended','removed'].includes(q.market_status))) return 80;
  return 50;
}
function mergeMarkets(candidates, now = Date.now()) {
  const cands = candidates.filter(Boolean).map((L) => decorateLine(L, L.src, L.seen, now));
  if (!cands.length) return null;
  const out = { ml: null, rl: null, t: null, quote_meta: {}, market_sources: {}, seen: 0 };
  for (const market of Object.keys(SIDES)) {
    const available = cands.filter((L) => L[market] || L.quote_meta[market]);
    if (!available.length) continue;
    const eligible = available.filter((L) => L[market] && SIDES[market].every((side) => L.quote_meta[market]?.[side]?.actionable));
    const picked = eligible.sort((a, b) => Math.min(...Object.values(b.quote_meta[market]).map((q) => Date.parse(q.source_observed_at))) - Math.min(...Object.values(a.quote_meta[market]).map((q) => Date.parse(q.source_observed_at))))[0] || available.sort((a,b)=>marketDisplayRank(a,market)-marketDisplayRank(b,market))[0];
    out[market] = picked[market]; out.quote_meta[market] = Object.fromEntries(Object.entries(picked.quote_meta[market] || {}).map(([side,q])=>[side,attachLink(q,available.map(L=>L.quote_meta[market]?.[side]))]));
    out.market_sources[market] = picked.src; out.seen = Math.max(out.seen, picked.seen || 0);
  }
  const sources = [...new Set(Object.values(out.market_sources))]; out.src = sources.length === 1 ? sources[0] : 'mixed';
  return summarize(out, now);
}
module.exports = { SIDES, MAX_AGE_MS, FRESH_FOR_MS, sourceTime, marketState, lineMeta, flipMeta, captureLine, missingLine, decorateLine, mergeMarkets, marketDisplayRank };
