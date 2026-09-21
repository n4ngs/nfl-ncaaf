'use strict';
/* Line history for one baseball day. Every source's latest price per book is kept with the time the source last
   confirmed it; the board shows the freshest source per book. Every price change is written down with its time so the
   app can draw how a line moved and call out steam, favorite flips and big moves (MLB rules in the spec).
   The opener comes from Action Network book 30 (else the first price seen); the close is frozen at first pitch.
   Saved to DATA_DIR/odds/YYYY-MM-DD.json with atomic writes. */

const { readJSON, writeJSONAsync, writeJSON } = require('./util');
const { BOOKS, BETTABLE } = require('./books');

const STEAM_BOOKS = 3;           // this many books moving the same way…
const STEAM_WINDOW = 10 * 60e3;  // …inside this window is steam
const STEAM_ML_CENTS = 10;       // a moneyline has to move this far at each book
const MOVE_ML_CENTS = 20;        // consensus moneyline this far from the last callout is a move
const MOVE_TOTAL = 0.5;          // consensus total this far from the last callout is a move
const FRESH = 10 * 60e3;         // a source's price older than this loses to a fresher source
const MAX_POINTS = 400;
const MAX_MOVES = 60;

// A moneyline on a straight "cents" scale from the home side: -130 -> 30, -105 -> 5, +105 -> -5, +150 -> -50.
const cents = (o) => (o == null ? null : o < 0 ? -(o + 100) : -(o - 100));
const prices = (L) => (L ? JSON.stringify([L.ml, L.rl, L.t]) : '');
const favOf = (ml) => (!ml || ml[0] == null || ml[1] == null || ml[0] === ml[1] ? null : ml[0] < ml[1] ? 'home' : 'away');
const strip = (L) => (L ? { ml: L.ml || null, rl: L.rl || null, t: L.t || null, seen: L.seen ?? null, src: L.src || null } : null);

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
    if (!books || !Object.keys(books).length) return false;
    const G = this.g(pk);
    const F = (G.f5src ||= {});
    F[src] = Object.fromEntries(Object.entries(books).map(([k, L]) => [k, { ...L, seen, src }]));
    const merged = {};
    for (const b of BOOKS) {
      for (const source of ['you', ...(b.src || []), 'an1']) {
        const L = F[source]?.[b.key];
        if (L && !merged[b.key]) merged[b.key] = L;
      }
    }
    for (const source of Object.keys(F)) if (F[source].cons && !merged.cons) merged.cons = F[source].cons;
    const before = JSON.stringify(G.f5 || null);
    G.f5 = Object.keys(merged).length ? merged : null;
    const changed = before !== JSON.stringify(G.f5);
    if (changed) this.dirty = true;
    return changed;
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
    const G = this.g(pk);
    const S = (G.srcs[src] ||= {});
    for (const [k, L] of Object.entries(lines || {})) if (L) S[k] = { ml: L.ml || null, rl: L.rl || null, t: L.t || null, seen, src };
    this.dirty = true;
    return this.remerge(pk, now);
  }

  // Pick each book's line from the freshest preferred source, record changes and look for news.
  remerge(pk, now = Date.now()) {
    const G = this.g(pk);
    const merged = {};
    for (const b of BOOKS) {
      // 'you' is a number typed in at the counter: it holds until a feed reports a fresher one.
      const cands = ['you', ...(b.src || [])].map((s) => G.srcs[s]?.[b.key]).filter(Boolean);
      if (!cands.length) continue;
      merged[b.key] = cands.find((L) => now - (L.seen || 0) < FRESH) || cands.reduce((x, y) => ((y.seen || 0) > (x.seen || 0) ? y : x));
    }
    const changes = [];
    let changed = false, seenOnly = false;
    for (const [k, L] of Object.entries(merged)) {
      const prev = G.books[k];
      if (prices(prev) !== prices(L)) {
        changed = true;
        if (k !== 'open') this.record(G, k, L, now);
        if (prev && BETTABLE.has(k) || prev && k === 'cons') changes.push(...this.diff(k, prev, L, now));
      } else if ((prev?.seen || 0) !== (L.seen || 0)) seenOnly = true;
    }
    for (const k of Object.keys(G.books)) if (!merged[k]) changed = true;
    G.books = Object.fromEntries(Object.entries(merged).map(([k, L]) => [k, strip(L)]));
    // The opener: Action Network's book 30, else the first market price seen.
    if (merged.open) {
      if (prices(G.open) !== prices(merged.open) || G.open?.first) { G.open = strip(merged.open); changed = true; }
    } else if (!G.open) {
      const first = merged.cons || merged.pin || merged.dk || Object.values(merged)[0];
      if (first) { G.open = { ...strip(first), first: true }; changed = true; }
    }
    const moves = changes.length ? this.detect(G, changes, now) : [];
    if (changed || moves.length) G.at = now;
    if (changed || seenOnly) this.dirty = true;
    return { changed: changed || moves.length > 0, seenOnly, moves };
  }

  record(G, k, L, t) {
    const H = (G.b[k] ||= { ml: [], rl: [], t: [] });
    const push = (arr, pt) => { arr.push(pt); if (arr.length > MAX_POINTS) arr.splice(1, 1); };
    const lm = H.ml.at(-1), lr = H.rl.at(-1), lt = H.t.at(-1);
    if (L.ml && (!lm || lm[1] !== L.ml[0] || lm[2] !== L.ml[1])) push(H.ml, [t, L.ml[0], L.ml[1]]);
    if (L.rl && (!lr || lr[1] !== L.rl.line || lr[2] !== L.rl.odds[0] || lr[3] !== L.rl.odds[1])) push(H.rl, [t, L.rl.line, L.rl.odds[0], L.rl.odds[1]]);
    if (L.t && (!lt || lt[1] !== L.t.line || lt[2] !== L.t.odds[0] || lt[3] !== L.t.odds[1])) push(H.t, [t, L.t.line, L.t.odds[0], L.t.odds[1]]);
  }

  // What changed at one book, in the terms the move rules use.
  diff(k, prev, L, now) {
    const out = [];
    // A jump from a stale price (a restart, a feed that was down) isn't a move inside the steam window.
    const fresh = now - (prev.seen || 0) < STEAM_WINDOW;
    if (prev.ml && L.ml && prev.ml[0] !== L.ml[0]) {
      out.push({ book: k, mkt: 'ml', from: prev.ml[0], to: L.ml[0], fromMl: prev.ml, toMl: L.ml, d: cents(L.ml[0]) - cents(prev.ml[0]), t: now, fresh });
    }
    if (prev.t && L.t && prev.t.line !== L.t.line) {
      out.push({ book: k, mkt: 't', from: prev.t.line, to: L.t.line, d: L.t.line - prev.t.line, t: now, fresh });
    }
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
        const n = net.get(c.book) || { d: 0, first: c };
        n.d += c.d;
        net.set(c.book, n);
      }
      const min = mkt === 'ml' ? STEAM_ML_CENTS : 1e-9;
      const up = [...net].filter(([, n]) => n.d >= min), down = [...net].filter(([, n]) => n.d <= -min);
      for (const [set, sign] of [[up, 1], [down, -1]]) {
        if (set.length < STEAM_BOOKS) continue;
        const dir = mkt === 'ml' ? (sign > 0 ? 'home' : 'away') : sign > 0 ? 'over' : 'under';
        if (flagged('steam', mkt, dir, 30 * 60e3)) continue;
        const firsts = set.map(([, n]) => n.first).sort((a, b) => a.t - b.t);
        const cons = G.books.cons;
        const to = mkt === 'ml' ? cons?.ml?.[0] ?? changes.find((c) => c.mkt === mkt)?.to : cons?.t?.line ?? changes.find((c) => c.mkt === mkt)?.to;
        out.push({ kind: 'steam', mkt, from: firsts[0].from, to, dir, books: set.map(([k]) => k), t: now });
      }
    }

    // The market (consensus): favorite flips and big moves from the last callout.
    for (const c of changes.filter((x) => x.book === 'cons')) {
      if (c.mkt === 'ml') {
        const a = favOf(c.fromMl), b = favOf(c.toMl);
        if (a && b && a !== b) {
          out.push({ kind: 'flip', mkt: 'ml', from: c.from, to: c.to, dir: b, t: now });
          continue;
        }
      }
      const last = [...G.moves, ...out].reverse().find((m) => m.mkt === c.mkt && m.kind !== 'steam');
      const base = last ? last.to : c.mkt === 'ml' ? G.open?.ml?.[0] : G.open?.t?.line;
      if (base == null) continue;
      if (c.mkt === 'ml') {
        const d = cents(c.to) - cents(base);
        if (Math.abs(d) >= MOVE_ML_CENTS) out.push({ kind: 'move', mkt: 'ml', from: base, to: c.to, dir: d > 0 ? 'home' : 'away', t: now });
      } else if (Math.abs(c.to - base) >= MOVE_TOTAL - 1e-9) {
        out.push({ kind: 'move', mkt: 't', from: base, to: c.to, dir: c.to > base ? 'over' : 'under', t: now });
      }
    }
    for (const m of out) {
      m.id = `${G.pk}-${m.kind}-${m.mkt}-${now}`;
      m.pk = G.pk;
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
    const B = G.books;
    const key = ['cons', 'pin', 'circa', 'dk', 'fd', 'czr', 'mgm'].find((k) => B[k]) || Object.keys(B).find((k) => k !== 'open');
    if (!key) return false;
    G.close = { ...strip(B[key]), book: key, at: now };
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
    if (o?.ml?.[0] != null) ml.push([o.seen || 0, o.ml[0]]);
    if (o?.t?.line != null) t.push([o.seen || 0, o.t.line]);
    for (const p of H.ml || []) ml.push([p[0], p[1]]);
    for (const p of H.t || []) t.push([p[0], p[1]]);
    return { ml: sample(ml), t: sample(t) };
  }

  pub(pk) {
    const G = this.games[pk];
    if (!G) return null;
    return { pk: G.pk, books: G.books, open: G.open ? strip(G.open) : null, close: G.close, moves: G.moves.map(pubMove), spark: this.spark(G), splits: G.splits || null, wx: G.wx || null, f5: G.f5 || null, tt: G.tt || null, at: G.at };
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
    for (const [pk, G] of Object.entries(this.games)) { const { recent, f5src, ...rest } = G; games[pk] = rest; }
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
