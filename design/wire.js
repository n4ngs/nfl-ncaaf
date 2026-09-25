/* THE.BOARD wire format for a football game's public view (NFL, NCAAF). Runs in Node (the engines pack) and in
   the browser (js/live.js unpacks), one file so both sides always agree.

   After shared/wire-diet.js trimmed each quote observation to the fields the boards read, the remaining bytes were
   the field NAMES and the fields every quote repeats from its position: the event id (the game's id), the sportsbook
   (the map key), market_type and selection (the map keys), period (full_game, or first_half for h1 markets) and
   canonical_market_key (`sport:event:market:period:-`). This packs each quote to short keys and drops those
   derivable fields; unpack restores them from context. Lossless for every field the diet keeps — a packed then
   unpacked game deep-equals its input (tests/wire-format.test.js, and the offline check on live snapshots).

   Only the live stream is packed (snapshot week + game events). /api/week and /api/game stay plain; unpack is
   idempotent (it keys on `_w`), so the client runs it on every game it receives. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoardWire = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = 2;
  // full key -> short key. Absent stays absent; null travels as null.
  const KEYS = [
    ['snapshot_id', 'i'], ['pair_id', 'p'], ['american_odds', 'o'], ['line_value', 'l'], ['is_live', 'L'],
    ['market_status', 'm'], ['validation_status', 'v'], ['reason_code', 'r'], ['source', 's'],
    ['source_observed_at', 't'], ['provider_received_at', 'd'], ['freshness', 'f'], ['age_ms', 'a'],
    ['conflict', 'c'], ['source_conflict', 'C'], ['timestamp_conflict', 'T'], ['bet_link', 'b'],
    ['canonical_event_id', 'e'], ['canonical_market_key', 'k'], ['market_type', 'mt'], ['selection', 'sl'],
    ['sportsbook', 'sb'], ['period', 'pd'], ['timestamp_kind', 'tk'],
  ];
  const SHORT = new Map(KEYS), LONG = new Map(KEYS.map(([a, b]) => [b, a]));
  // fields whose value usually follows from the quote's position; when it does, the key is left out and
  // restored on unpack. A different value travels; an absent field travels as an explicit null marker (`_`).
  const DERIVED = ['canonical_event_id', 'sportsbook', 'market_type', 'selection', 'period', 'canonical_market_key', 'market_status', 'validation_status'];
  const periodOf = (mkt) => (typeof mkt === 'string' && mkt.startsWith('h1') ? 'first_half' : 'full_game');
  function expected(ctx, q) {
    const market_type = q && q.market_type !== undefined ? q.market_type : ctx.mkt;
    const period = q && q.period !== undefined ? q.period : periodOf(market_type);
    return { canonical_event_id: ctx.event, sportsbook: ctx.book, market_type: ctx.mkt, selection: ctx.side, period: periodOf(ctx.mkt),
      canonical_market_key: `${ctx.sport}:${ctx.event}:${market_type}:${period}:-`, market_status: 'active', validation_status: 'VALID' };
  }
  function packQuote(q, ctx) {
    if (!q || typeof q !== 'object') return q;
    const exp = expected(ctx, q), o = {};
    let missing = '';
    for (const [long, short] of KEYS) {
      if (DERIVED.includes(long)) {
        if (!(long in q)) { missing += short + ','; continue; }
        if (q[long] === exp[long]) continue;
      } else if (!(long in q)) continue;
      o[short] = q[long];
    }
    if (missing) o._ = missing.slice(0, -1);
    return o;
  }
  function unpackQuote(c, ctx) {
    if (!c || typeof c !== 'object') return c;
    const q = {};
    const missing = new Set(typeof c._ === 'string' ? c._.split(',') : []);
    for (const [long, short] of KEYS) {
      if (short in c) { q[long] = c[short]; continue; }
      if (DERIVED.includes(long) && !missing.has(short)) q[long] = null;   // placeholder, filled below in order
    }
    // derived values depend on each other (the market key on market_type and period), so resolve in order
    const exp = expected(ctx, { market_type: 'mt' in c ? c.mt : undefined, period: 'pd' in c ? c.pd : undefined });
    for (const long of DERIVED) if (!(SHORT.get(long) in c) && !missing.has(SHORT.get(long))) q[long] = exp[long];
    // keep the diet's key order (cosmetic, but deep-equal in tests compares values only)
    return q;
  }
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  function mapLine(L, fn, ctx) {
    if (!isObj(L) || !isObj(L.integrity)) return L;
    const integrity = {};
    for (const [mkt, sides] of Object.entries(L.integrity)) {
      if (!isObj(sides)) { integrity[mkt] = sides; continue; }
      integrity[mkt] = {};
      for (const [side, q] of Object.entries(sides)) integrity[mkt][side] = fn(q, { ...ctx, mkt, side });
    }
    return { ...L, integrity };
  }
  function mapMarket(r, fn, ctx) {
    if (!isObj(r)) return r;
    const o = { ...r };
    const c = { ...ctx, book: r.sportsbook, mkt: r.market_type, side: r.selection };
    for (const k of ['open', 'current', 'close']) if (isObj(o[k])) o[k] = fn(o[k], c);
    return o;
  }
  function mapGame(g, fn, sport) {
    const out = { ...g };
    const ctx = { sport, event: String(g.id) };
    for (const grp of ['books', 'live', 'h1', 'tt']) {
      if (!isObj(out[grp])) continue;
      out[grp] = Object.fromEntries(Object.entries(out[grp]).map(([book, L]) => [book, mapLine(L, fn, { ...ctx, book })]));
    }
    for (const k of ['mkt', 'open', 'close']) if (isObj(out[k])) out[k] = mapLine(out[k], fn, { ...ctx, book: out[k].sportsbook || out[k].src || 'cons' });
    if (isObj(out.integrity) && isObj(out.integrity.markets)) {
      out.integrity = { ...out.integrity, markets: Object.fromEntries(Object.entries(out.integrity.markets).map(([k, r]) => [k, mapMarket(r, fn, ctx)])) };
    }
    return out;
  }
  function packGame(g, sport) {
    if (!isObj(g) || g._w === VERSION) return g;
    const out = mapGame(g, packQuote, sport);
    out._w = VERSION; out._s = sport;
    return out;
  }
  function unpackGame(g) {
    if (!isObj(g) || g._w !== VERSION) return g;
    const { _w, _s, ...rest } = g;
    return mapGame(rest, unpackQuote, _s);
  }
  const packWeek = (w, sport) => (isObj(w) && Array.isArray(w.games) ? { ...w, games: w.games.map((g) => packGame(g, sport)) } : w);
  return { VERSION, packGame, unpackGame, packWeek, packQuote, unpackQuote };
});
