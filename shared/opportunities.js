'use strict';
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { BOOK_NAMES } = require('./sharp-books');
const { validRef } = require('./bet-links');
const SPORTS = new Set(['nfl', 'ncaaf', 'mlb', 'nhl']);
const REFERENCES = ['pin', 'circa'];
const fairPairs = new Map(), FAIR_PAIR_CACHE_LIMIT = 2048;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const decimal = odds => Number.isFinite(odds) && Math.abs(odds) >= 100 ? odds > 0 ? 1 + odds / 100 : 1 + 100 / -odds : null;
const time = value => typeof value === 'number' ? value : typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
// A two-way, no-push benchmark. This is a market estimate, not a trained forecast.
function fairPair(a, b) {
  const da = decimal(a), db = decimal(b); if (!da || !db) return null;
  const key = a + '|' + b; if (fairPairs.has(key)) return fairPairs.get(key);
  const x = 1 / da, y = 1 / db, margin = x + y;
  if (margin < 1 || margin > 1.18) return null;
  let low = 0.5, high = 3;
  for (let i = 0; i < 48; i++) { const k = (low + high) / 2; if (x ** k + y ** k > 1) low = k; else high = k; }
  const probabilities = Object.freeze([x ** ((low + high) / 2), y ** ((low + high) / 2)]);
  fairPairs.set(key, probabilities); if (fairPairs.size > FAIR_PAIR_CACHE_LIMIT) fairPairs.delete(fairPairs.keys().next().value);
  return probabilities;
}
function deadline(q, live, now) {
  if (!q || q.market_status !== 'active' || q.conflicted || q.conflict || q.missing_from_source || ['STALE','SUSPENDED','CONFLICTED','UNAVAILABLE'].includes(q.freshness) || q.is_live !== live || !decimal(q.american_odds)) return null;
  const observed = time(q.source_observed_at), delivered = time(q.provider_received_at);
  if (q.source_observed_at != null && !Number.isFinite(observed) || q.provider_received_at != null && !Number.isFinite(delivered) || observed > now || delivered > now) return null;
  const clock = Number.isFinite(observed) ? observed : delivered;
  const ttl = Math.min(live ? 15000 : 90000, Number.isFinite(q.max_age_ms) && q.max_age_ms > 0 ? q.max_age_ms : Infinity);
  return Number.isFinite(clock) && clock <= now && clock + ttl > now ? clock + ttl : null;
}
function comparable(q, opposite, market) {
  if (!q || !opposite || !q.pair_id || q.pair_id !== opposite.pair_id || q.provider_quote_id && opposite.provider_quote_id && q.provider_quote_id === opposite.provider_quote_id || q.provider_event_id && opposite.provider_event_id && q.provider_event_id !== opposite.provider_event_id) return false;
  if (market === 'ml') return q.line_value == null && opposite.line_value == null;
  return Number.isFinite(q.line_value) && Number.isFinite(opposite.line_value) &&
    (market === 's' ? q.line_value === -opposite.line_value : q.line_value === opposite.line_value);
}
function scan(provider, sport, frame, now) {
  if (!SPORTS.has(sport)) return [];
  const rows = [];
  for (const event of Array.isArray(frame?.events) ? frame.events : []) {
    if (!event || typeof event !== 'object') continue;
    const start = time(event.start); if (!event.id || typeof event.home !== 'string' || typeof event.away !== 'string' || !event.home.trim() || !event.away.trim() || event.home === event.away || !Number.isFinite(start) || event.final || ['post','final','off'].includes(String(event.state || '').toLowerCase())) continue;
    for (const live of [false, true]) {
      if (live && (frame.status?.streamHealthy !== true || start > now) || !live && (start <= now || event.state === 'in')) continue;
      const books = event[live ? 'live' : 'books'] || {};
      for (const market of ['ml', 's', 't']) {
        // NFL moneyline ties can push; no push model is available for expected return.
        if (sport === 'nfl' && market === 'ml') continue;
        const sides = market === 't' ? ['over', 'under'] : ['home', 'away'];
        for (const [book, line] of Object.entries(books)) {
          for (const [index, side] of sides.entries()) {
            const quote = line?.integrityMeta?.[market]?.[side], opposite = line?.integrityMeta?.[market]?.[sides[1-index]];
            const ownExpiries = [deadline(quote, live, now), deadline(opposite, live, now)];
            const expiry = ownExpiries.every(Boolean) && comparable(quote, opposite, market) ? Math.min(...ownExpiries) : null;
            if (!expiry || market !== 'ml' && (!Number.isFinite(quote.line_value) || !Number.isInteger(Math.abs(quote.line_value) * 2) || Number.isInteger(quote.line_value))) continue;
            const references = [];
            for (const reference of REFERENCES) {
              if (reference === book) continue;
              const pair = sides.map(s => books[reference]?.integrityMeta?.[market]?.[s]);
              const expiries = pair.map(q => deadline(q, live, now));
              if (!expiries.every(Boolean) || !comparable(pair[0], pair[1], market) || (market !== 'ml' && quote.line_value !== pair[index].line_value)) continue;
              const probs = fairPair(pair[0].american_odds, pair[1].american_odds); if (!probs) continue;
              references.push({ book: reference, probability: probs[index], expiresAt: Math.min(...expiries), odds: pair[index].american_odds });
            }
            if (!references.length) continue;
            // Use the least optimistic benchmark when sharp books disagree.
            const probability = Math.min(...references.map(x => x.probability));
            const evPct = 100 * (probability * decimal(quote.american_odds) - 1);
            if (evPct < 0.5 || evPct > 15) continue;
            const id = digest([provider, sport, event.id, live, market, side, book, quote.line_value]);
            const ref = validRef(quote.bet_link), link = ref?.book === book && ref?.provider === provider && (provider !== 'sharp' || ref.id === String(quote.provider_quote_id)) ? ref : null;
            const version = digest([id, event.home, event.away, event.start, quote.american_odds, opposite.american_odds, quote.provider_quote_id, link, references.map(r => [r.book, r.odds, r.probability])]);
            const selection = market === 't' ? `${side === 'over' ? 'Over' : 'Under'} ${quote.line_value}` : `${event[side]}${market === 's' ? ` ${quote.line_value > 0 ? '+' : ''}${quote.line_value}` : ' moneyline'}`;
            rows.push({ id, version, provider, sport, eventId: event.id, book, bookName: BOOK_NAMES[book] || book,
              home: event.home, away: event.away, startsAt: new Date(start).toISOString(), live, market, side,
              label: selection, odds: quote.american_odds, line: quote.line_value ?? null, evPct, probability,
              references, expiresAt: Math.min(expiry, ...references.map(r => r.expiresAt)),
              observedAt: quote.source_observed_at || null, deliveredAt: quote.provider_received_at || null,
              eligible: true, link, handoff: link?.provider === 'sharp', receivedAt: Number.isFinite(time(frame.receivedAt)) ? time(frame.receivedAt) : null, benchmarkKind: 'TWO_WAY_NO_PUSH_MARKET_ESTIMATE', clockKind: quote.source_observed_at ? 'SOURCE_OBSERVATION' : 'PROVIDER_DELIVERY' });
          }
        }
      }
    }
  }
  return rows;
}
class OpportunityService extends EventEmitter {
  constructor({ now = Date.now } = {}) { super(); this.now = now; this.frames = new Map(); this.frameRows = new Map(); this.rows = new Map(); this.revision = 0; this.receivedAt = null; this.trace = null; this.traceSequence = 0; this.timer = setInterval(() => this.rebuild(), 1000); this.timer.unref(); }
  update(provider, sport, frame) { if (!SPORTS.has(sport) || !['sharp', 'owls'].includes(provider)) return; const receivedAt = this.now(); this.frames.set(provider + sport, { provider, sport, frame: frame || {} }); this.rebuild({ provider, sport, receivedAt }); }
  status(provider, status) { for (const f of this.frames.values()) if (f.provider === provider) f.frame = { ...f.frame, status }; this.rebuild({ provider, statusOnly: true }); }
  rebuild(cause = null) {
    const next = new Map(), now = this.now();
    // Rescan only the updated sport/source. The timer and click checks only expire cached rows.
    if (cause) for (const [key, { provider, sport, frame }] of this.frames) if (provider === cause.provider && (cause.statusOnly || sport === cause.sport)) {
      const prior = new Map((this.frameRows.get(key) || []).map(row => [row.id, row]));
      const rows = scan(provider, sport, frame, now);
      for (const row of rows) { const old = prior.get(row.id); if (!old) continue; const { receivedAt: oldReceipt, ...before } = old, { receivedAt, ...after } = row; if (JSON.stringify(before) === JSON.stringify(after)) row.receivedAt = oldReceipt; }
      this.frameRows.set(key, rows);
    }
    for (const rows of this.frameRows.values()) for (const row of rows) if (row.expiresAt > now && (row.live || time(row.startsAt) > now)) next.set(row.id, row);
    const changed = next.size !== this.rows.size || [...next].some(([id, row]) => this.rows.get(id)?.version !== row.version || this.rows.get(id)?.expiresAt !== row.expiresAt);
    const causalChange = cause && !cause.statusOnly && [...next].some(([id, row]) => row.provider === cause.provider && row.sport === cause.sport && (this.rows.get(id)?.version !== row.version || this.rows.get(id)?.expiresAt !== row.expiresAt));
    this.rows = next;
    if (changed) { this.revision++; this.trace = causalChange ? { id: String(++this.traceSequence), provider: cause.provider, sport: cause.sport, receivedAt: cause.receivedAt, clockKind: 'OPPORTUNITY_ENGINE_RECEIPT' } : null; this.receivedAt = this.trace?.receivedAt ?? null; this.emit('update', this.snapshot()); }
  }
  snapshot() { const now = this.now(); return { revision: this.revision, serverAt: now, receivedAt: this.receivedAt, trace: this.trace, rows: [...this.rows.values()].filter(r => r.expiresAt > now).sort((a, b) => b.evPct - a.evPct).slice(0, 400).map(({ link, ...r }) => r) }; }
  validate(id, version) { this.rebuild(); const row = this.rows.get(id); if (!row || row.expiresAt <= this.now()) return { error: 'This opportunity expired. Return to the board for current prices.', status: 410 }; if (row.version !== version) return { error: 'The price or reference market changed. Review the current price before continuing.', status: 409 }; if (!row.link || !row.handoff) return { error: 'A verified selection link is unavailable for this price.', status: 422 }; return { row }; }
  close() { clearInterval(this.timer); this.removeAllListeners(); }
}
module.exports = { OpportunityService, scan, fairPair, decimal, deadline };
