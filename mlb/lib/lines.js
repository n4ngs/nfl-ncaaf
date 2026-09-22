'use strict';
/* Line history for one baseball day. Every source's latest price per book is kept with the time the source last
   confirmed it; the board shows the freshest source per book. Every price change is written down with its time so the
   app can draw how a line moved and call out steam, favorite flips and big moves (MLB rules in the spec).
   The opener comes from Action Network book 30 (else the first price seen); the close is frozen at first pitch.
   Saved to DATA_DIR/odds/YYYY-MM-DD.json with atomic writes. */

const { readJSON, writeJSONAsync, writeJSON } = require('./util');
const { BOOKS, BETTABLE } = require('./books');
const { captureLine, missingLine, decorateLine, mergeMarkets } = require('./quote-evidence');

const STEAM_BOOKS = 3;           // this many books moving the same way…
const STEAM_WINDOW = 10 * 60e3;  // …inside this window is steam
const STEAM_ML_CENTS = 10;       // a moneyline has to move this far at each book
const MOVE_ML_CENTS = 20;        // consensus moneyline this far from the last callout is a move
const MOVE_TOTAL = 0.5;          // consensus total this far from the last callout is a move
const MAX_POINTS = 400;
const MAX_MOVES = 60;

// A moneyline on a straight "cents" scale from the home side: -130 -> 30, -105 -> 5, +105 -> -5, +150 -> -50.
const cents = (o) => (o == null ? null : o < 0 ? -(o + 100) : -(o - 100));
const availability = (L) => JSON.stringify(Object.entries(L?.quote_meta || {}).map(([m, sides]) => [m, Object.entries(sides).map(([s, q]) => [s, q.market_status, q.is_live, !!q.missing_from_source, !!q.conflicted])]));
const prices = (L) => (L ? JSON.stringify([L.ml, L.rl, L.t]) : '');
const favOf = (ml) => (!ml || ml[0] == null || ml[1] == null || ml[0] === ml[1] ? null : ml[0] < ml[1] ? 'home' : 'away');
const strip = (L) => (L ? { ml: L.ml || null, rl: L.rl || null, t: L.t || null, seen: L.seen ?? null, src: L.src || null } : null);

// A complete displayed market must agree with both individual provider observations.
// Receipt time never certifies a market move or supplies a missing source clock.
const hasLive = (L) => L?.is_live === true || Object.values(L?.quote_meta || {}).flatMap(Object.values).some((q) => q?.is_live === true);
const capture = (L, src, seen) => L.quote_meta ? captureLine(L, src, seen) : { ...strip(L), seen, src, freshness: 'UNVERIFIED', reason_code: 'LEGACY_EVIDENCE_MISSING', actionable: false };
const markMissing = (L, src, seen) => L.quote_meta ? missingLine(L, src, seen) : { ...L, missing_from_source: true };
function completeNumbers(L, market) {
  const odds = market === 'ml' ? L?.ml : L?.[market]?.odds;
  return Array.isArray(odds) && odds.length === 2 && odds.every((n) => Number.isFinite(n) && Math.abs(n) >= 100)
    && (market === 'ml' || Number.isFinite(L[market]?.line));
}
function marketEvidence(L, market, now) {
  if (!L?.quote_meta || hasLive(L) || !completeNumbers(L, market)) return null;
  const view = decorateLine(L, L.src, L.seen, now), sides = market === 't' ? ['over', 'under'] : ['home', 'away'];
  const rows = sides.map((side) => view.quote_meta?.[market]?.[side]);
  const odds = market === 'ml' ? L.ml : L[market].odds;
  if (!rows.every((q, i) => q?.freshness === 'FRESH' && q.actionable === true && q.is_live === false
    && q.american_odds === odds[i] && (market === 'ml' || q.line_value === (market === 'rl' && i === 1 ? -L[market].line : L[market].line)))) return null;
  const sources = rows.map((q) => q.source || q.src || L.market_sources?.[market] || L.src);
  if (!sources[0] || sources.some((source) => source !== sources[0])) return null;
  const clocks = rows.map((q) => Date.parse(q.source_observed_at));
  if (!clocks.every(Number.isFinite)) return null;
  return { rows, clocks, at: Math.max(...clocks), source: sources[0] };
}
function eligibleLine(L, now) {
  if (!L) return null;
  const out = { ml: null, rl: null, t: null, quote_meta: {}, seen: L.seen, src: L.src, source_observed_at: null, evidence_status: 'SOURCE_TIMESTAMPED' };
  const clocks = [];
  for (const market of ['ml', 'rl', 't']) {
    const evidence = marketEvidence(L, market, now); if (!evidence) continue;
    out[market] = L[market]; out.quote_meta[market] = Object.fromEntries((market === 't' ? ['over', 'under'] : ['home', 'away']).map((side, i) => [side, evidence.rows[i]]));
    clocks.push(...evidence.clocks);
  }
  if (!clocks.length) return null;
  out.source_observed_at = new Date(Math.min(...clocks)).toISOString();
  return out;
}
function advancedEvidence(prev, next, market, now) {
  const before = marketEvidence(prev, market, now), after = marketEvidence(next, market, now);
  if (!before || !after || before.source !== after.source || after.at <= before.at) return null;
  // Every changed selection needs its own newer timestamp; a refreshed opposite side
  // cannot make an unchanged/stale source timestamp on the changed price current.
  if (after.rows.some((q, i) => (q.american_odds !== before.rows[i].american_odds || q.line_value !== before.rows[i].line_value)
    && after.clocks[i] <= before.clocks[i])) return null;
  return after;
}

class OddsDay {
  constructor(date) {
    this.date = date;
    this.file = `odds/${date}.json`;
    const saved = readJSON(this.file, null);
    this.games = saved?.games || {}; // pk -> G
    for (const G of Object.values(this.games)) G.recent = [];
    this.dirty = false;
  }

  g(pk) {
    return (this.games[pk] ||= { pk: Number(pk), srcs: {}, books: {}, b: {}, open: null, close: null, moves: [], recent: [], at: 0 });
  }

  has(pk) { return !!this.games[pk]; }

  // First five innings, by book and source. A side market: no history, no steam, just the current number.
  setF5(pk, src, books, seen) {
    if (Object.values(books || {}).length && Object.values(books).every((L) => hasLive(L))) return false;
    if (!this.has(pk) && !Object.keys(books || {}).length) return false;
    const G = this.g(pk), F = (G.f5src ||= {});
    const before = JSON.stringify(G.f5 || null);
    const old = F[src] || {};
    F[src] = Object.fromEntries(Object.entries(books || {}).filter(([, L]) => L && !hasLive(L)).map(([key, L]) => [key, capture(L, src, seen)]));
    for (const [key, L] of Object.entries(old)) if (!F[src][key]) F[src][key] = markMissing(L, src, seen);
    G.f5 = this.projectBooks(G, Date.now(), true, true);
    const changed = before !== JSON.stringify(G.f5);
    if (changed) this.dirty = true;
    return changed;
  }

  projectBooks(G, now = Date.now(), five = false, preserveLegacy = false) {
    const sourceBooks = five ? G.f5src || {} : G.srcs;
    const merged = {};
    for (const b of BOOKS) {
      const sources = [...new Set(['you', ...(b.src || []), ...(five ? ['an1'] : [])])];
      const candidates = sources.map((source) => sourceBooks[source]?.[b.key]).filter(Boolean);
      const legacy = (five ? G.f5 : G.books)?.[b.key];
      if (!candidates.length && legacy) candidates.push(legacy);
      const L = mergeMarkets(candidates, now);
      if (L) merged[b.key] = preserveLegacy && candidates.every((candidate) => !candidate.quote_meta)
        ? { ...strip(L), freshness: 'UNVERIFIED', reason_code: 'LEGACY_EVIDENCE_MISSING', actionable: false } : L;
    }
    return merged;
  }

  setTT(pk, tt) {
    if (!tt) return false;
    const G = this.g(pk);
    if (JSON.stringify(G.tt || null) === JSON.stringify(tt)) return false;
    G.tt = tt;
    this.dirty = true;
    return true;
  }

  // The public count, and first-pitch weather. Neither is a price, so neither touches the merge or the history.
  setSplits(pk, splits) {
    if (!splits) return false;
    const G = this.g(pk);
    if (JSON.stringify(G.splits || null) === JSON.stringify(splits)) return false;
    G.splits = splits;
    this.dirty = true;
    return true;
  }

  setWx(pk, wx) {
    if (!wx) return false;
    const G = this.g(pk);
    const same = G.wx && ['temp', 'wind', 'gust', 'dir', 'pop', 'roof'].every((k) => G.wx[k] === wx[k]);
    G.wx = wx;
    if (!same) this.dirty = true;
    return !same;
  }

  // One source's prices for one game. `lines` is { bookKey: L } (L without seen/src); `seen` is when the source confirmed them.
  // Returns { changed, seenOnly, moves }.
  ingest(pk, src, lines, seen, now = Date.now()) {
    if (Object.values(lines || {}).length && Object.values(lines).every((L) => hasLive(L))) return { changed: false, seenOnly: false, moves: [] };
    if (!this.has(pk) && !Object.keys(lines || {}).length) return { changed: false, seenOnly: false, moves: [] };
    const G = this.g(pk), old = G.srcs[src] || {};
    const S = G.srcs[src] = {};
    for (const [k, L] of Object.entries(lines || {})) if (L && !hasLive(L)) S[k] = capture(L, src, seen);
    for (const [k, L] of Object.entries(old)) if (!S[k]) S[k] = markMissing(L, src, seen);
    this.dirty = true;
    return this.remerge(pk, now);
  }

  // Pick each book's line from the freshest preferred source, record changes and look for news.
  remerge(pk, now = Date.now()) {
    const G = this.g(pk);
    const merged = this.projectBooks(G, now, false, true);
    const changes = [];
    let changed = false, seenOnly = false;
    for (const [k, L] of Object.entries(merged)) {
      const prev = G.books[k];
      if (prices(prev) !== prices(L) || availability(prev) !== availability(L)) {
        changed = true;
        if (k !== 'open') this.record(G, k, L, now, prev);
        if (prev && BETTABLE.has(k) || prev && k === 'cons') changes.push(...this.diff(k, prev, L, now));
      } else if ((prev?.seen || 0) !== (L.seen || 0)) seenOnly = true;
    }
    for (const k of Object.keys(G.books)) if (!merged[k]) changed = true;
    G.books = merged;
    // An opening reference must have observed source evidence too. Old saved openers
    // remain historical context, but newly unverified/partial responses cannot create one.
    const opener = eligibleLine(merged.open, now);
    if (opener) {
      if (prices(G.open) !== prices(opener) || G.open?.first) { G.open = opener; changed = true; }
    } else if (!G.open) {
      const first = ['cons', 'pin', 'dk', ...Object.keys(merged)].map((key) => eligibleLine(merged[key], now)).find(Boolean);
      if (first) { G.open = { ...first, first: true }; changed = true; }
    }
    const moves = changes.length ? this.detect(G, changes, now) : [];
    if (changed || moves.length) G.at = now;
    if (changed || seenOnly) this.dirty = true;
    return { changed: changed || moves.length > 0, seenOnly, moves };
  }

  record(G, k, L, now, prev) {
    for (const market of ['ml', 'rl', 't']) {
      const evidence = marketEvidence(L, market, now); if (!evidence) continue;
      const values = market === 'ml' ? L.ml : [L[market].line, ...L[market].odds];
      const H = (G.b[k] ||= { ml: [], rl: [], t: [] }), arr = H[market], last = arr.at(-1);
      if (last && (values.every((v, i) => v === last[i + 1]) || evidence.at <= last[0])) continue;
      const prior = marketEvidence(prev, market, now);
      if (prior && prior.source === evidence.source && !advancedEvidence(prev, L, market, now)) continue;
      arr.push([evidence.at, ...values]);
      if (arr.length > MAX_POINTS) arr.splice(1, 1);
    }
  }

  // Signals require two complete, fresh observations from the same source and a
  // genuinely newer source timestamp. Provider failover is not a sportsbook move.
  diff(k, prev, L, now) {
    const out = [];
    const ml = advancedEvidence(prev, L, 'ml', now);
    if (ml && prev.ml[0] !== L.ml[0]) out.push({ book: k, mkt: 'ml', from: prev.ml[0], to: L.ml[0], fromMl: prev.ml, toMl: L.ml,
      d: cents(L.ml[0]) - cents(prev.ml[0]), t: ml.at, fresh: true });
    const total = advancedEvidence(prev, L, 't', now);
    if (total && prev.t.line !== L.t.line) out.push({ book: k, mkt: 't', from: prev.t.line, to: L.t.line,
      d: L.t.line - prev.t.line, t: total.at, fresh: true });
    return out;
  }

  detect(G, changes, now) {
    const out = [];
    G.recent = (G.recent || []).filter((c) => now - c.t < STEAM_WINDOW);
    for (const c of changes) if (c.book !== 'cons' && c.fresh) G.recent.push(c);
    const flagged = (kind, mkt, dir, within) => G.moves.some((m) => m.kind === kind && m.mkt === mkt && (!dir || m.dir === dir) && now - m.t < within);

    // Steam: 3+ books moving the same way inside 10 minutes.
    for (const mkt of ['ml', 't']) {
      const net = new Map(); // book -> { d, first }
      for (const c of G.recent.filter((x) => x.mkt === mkt)) {
        const n = net.get(c.book) || { d: 0, first: c, last: c };
        n.d += c.d; n.last = c;
        net.set(c.book, n);
      }
      const min = mkt === 'ml' ? STEAM_ML_CENTS : 1e-9;
      const up = [...net].filter(([, n]) => n.d >= min), down = [...net].filter(([, n]) => n.d <= -min);
      for (const [set, sign] of [[up, 1], [down, -1]]) {
        if (set.length < STEAM_BOOKS) continue;
        const dir = mkt === 'ml' ? (sign > 0 ? 'home' : 'away') : sign > 0 ? 'over' : 'under';
        if (flagged('steam', mkt, dir, 30 * 60e3)) continue;
        const firsts = set.map(([, n]) => n.first).sort((a, b) => a.t - b.t);
        const cons = marketEvidence(G.books.cons, mkt, now) ? G.books.cons : null;
        const to = mkt === 'ml' ? cons?.ml?.[0] ?? changes.find((c) => c.mkt === mkt)?.to : cons?.t?.line ?? changes.find((c) => c.mkt === mkt)?.to;
        out.push({ kind: 'steam', mkt, from: firsts[0].from, to, dir, books: set.map(([k]) => k), t: Math.max(...set.map(([, n]) => n.last.t)) });
      }
    }

    // The market (consensus): favorite flips and big moves from the last callout.
    for (const c of changes.filter((x) => x.book === 'cons')) {
      if (c.mkt === 'ml') {
        const a = favOf(c.fromMl), b = favOf(c.toMl);
        if (a && b && a !== b) {
          out.push({ kind: 'flip', mkt: 'ml', from: c.from, to: c.to, dir: b, t: c.t });
          continue;
        }
      }
      const last = [...G.moves, ...out].reverse().find((m) => m.mkt === c.mkt && m.kind !== 'steam' && m.source_clock === true);
      const opening = G.open?.evidence_status === 'SOURCE_TIMESTAMPED' ? (c.mkt === 'ml' ? G.open?.ml?.[0] : G.open?.t?.line) : null;
      const base = last ? last.to : opening ?? c.from;
      if (base == null) continue;
      if (c.mkt === 'ml') {
        const d = cents(c.to) - cents(base);
        if (Math.abs(d) >= MOVE_ML_CENTS) out.push({ kind: 'move', mkt: 'ml', from: base, to: c.to, dir: d > 0 ? 'home' : 'away', t: c.t });
      } else if (Math.abs(c.to - base) >= MOVE_TOTAL - 1e-9) {
        out.push({ kind: 'move', mkt: 't', from: base, to: c.to, dir: c.to > base ? 'over' : 'under', t: c.t });
      }
    }
    for (const m of out) {
      m.id = `${G.pk}-${m.kind}-${m.mkt}-${now}`;
      m.pk = G.pk; m.source_clock = true;
      G.moves.push(m);
    }
    if (G.moves.length > MAX_MOVES) G.moves.splice(0, G.moves.length - MAX_MOVES);
    if (out.length) this.dirty = true;
    return out.map((m) => ({ id: m.id, pk: m.pk, kind: m.kind, mkt: m.mkt, from: m.from, to: m.to, dir: m.dir, ...(m.books ? { books: m.books } : {}), t: m.t }));
  }

  // The last pregame market number, frozen at first pitch. Closing line value is measured against it.
  freeze(pk, now = Date.now()) {
    const G = this.games[pk];
    if (!G || G.close) return false;
    const B = this.projectBooks(G, now, false, true);
    const keys = [...new Set(['cons', 'pin', 'circa', 'dk', 'fd', 'czr', 'mgm', ...Object.keys(B)])].filter((key) => key !== 'open');
    const entry = keys.map((book) => ({ book, line: eligibleLine(B[book], now) })).find((row) => row.line);
    if (entry) G.close = { ...entry.line, book: entry.book, at: now, actionable: false };
    else {
      // Preserve legacy closes as explicitly unverified historical context. A live
      // update must neither migrate that saved schema nor invent provider evidence.
      const book = keys.find((key) => B[key] && !B[key].quote_meta && ['ml', 'rl', 't'].some((market) => completeNumbers(B[key], market)));
      if (!book) return false;
      G.close = { ...strip(B[book]), book, at: now, source_observed_at: null,
        freshness: 'UNVERIFIED', reason_code: 'LEGACY_EVIDENCE_MISSING', actionable: false };
    }
    G.at = now;
    this.dirty = true;
    return true;
  }

  closeOf(pk) { return this.games[pk]?.close || null; }

  // A small, even sample of the market line for sparklines on the board.
  spark(G, n = 24) {
    const H = G.b.cons || G.b.pin || G.b.dk || {};
    const sample = (pts) => {
      if (pts.length <= n) return pts;
      const out = [pts[0]];
      for (let i = 1; i < n - 1; i++) out.push(pts[Math.round((i * (pts.length - 1)) / (n - 1))]);
      out.push(pts.at(-1));
      return out;
    };
    const ml = [], t = [];
    const o = G.open;
    const openingTime = (market) => {
      const sides = market === 'ml' ? ['home', 'away'] : ['over', 'under'];
      const clocks = sides.map((side) => Date.parse(o?.quote_meta?.[market]?.[side]?.source_observed_at));
      return clocks.every(Number.isFinite) ? Math.max(...clocks) : null;
    };
    const mlAt = openingTime('ml'), totalAt = openingTime('t');
    if (o?.ml?.[0] != null && mlAt != null) ml.push([mlAt, o.ml[0]]);
    if (o?.t?.line != null && totalAt != null) t.push([totalAt, o.t.line]);
    for (const p of H.ml || []) ml.push([p[0], p[1]]);
    for (const p of H.t || []) t.push([p[0], p[1]]);
    return { ml: sample(ml), t: sample(t) };
  }

  pub(pk) {
    const G = this.games[pk];
    if (!G) return null;
    return { pk: G.pk, books: this.projectBooks(G), open: G.open ? strip(G.open) : null, close: G.close, moves: G.moves.map(pubMove), spark: this.spark(G), splits: G.splits || null, wx: G.wx || null, f5: G.f5 || G.f5src ? this.projectBooks(G, Date.now(), true) : null, tt: G.tt || null, at: G.at };
  }

  all() {
    return Object.fromEntries(Object.keys(this.games).map((pk) => [pk, this.pub(pk)]));
  }

  full(pk) {
    const G = this.games[pk];
    if (!G) return null;
    return { b: G.b, open: G.open, close: G.close, moves: G.moves.map(pubMove) };
  }

  moves(limit = 100) {
    return Object.values(this.games).flatMap((G) => G.moves.map(pubMove)).sort((a, b) => b.t - a.t).slice(0, limit);
  }

  toJSON() {
    const games = {};
    for (const [pk, G] of Object.entries(this.games)) { const { recent, ...rest } = G; games[pk] = rest; }
    return { v: 1, date: this.date, saved: Date.now(), games };
  }

  save(sync = false) {
    if (!this.dirty) return null;
    this.dirty = false;
    if (sync) return writeJSON(this.file, this.toJSON());
    return writeJSONAsync(this.file, this.toJSON());
  }
}

function pubMove(m) {
  return { id: m.id, pk: m.pk, kind: m.kind, mkt: m.mkt, from: m.from, to: m.to, dir: m.dir, ...(m.books ? { books: m.books } : {}), t: m.t };
}

module.exports = { OddsDay, cents };
