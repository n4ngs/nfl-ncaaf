'use strict';
// Hook & Ladder opener read: the NCAAF research model (ncaaf/research; parity-tested port in lib/vas-engine.js) live.
//
// Research verdict, and what is shown because of it (app rules: informational, Solid/Thin/Weak with the reason):
//  - Open-safe fundamentals (variant A) did NOT beat the close: no read is shown from them.
//  - Variant B (a book's OPENER sits off the other books' median opener) beat the no-vig close on every 2023-25
//    holdout season (+4.93% CLV EV, 178 games, Bonferroni p = 0.0007 over 123 rules). Historical opener timestamps
//    are unverifiable, so it is labelled THIN until this app's own recorded openers confirm it live.
//  - Variant C (starting-QB change) needs the confirmed starter before books adjust; not shown.
// Every Thin/Weak read is logged at that book's price and scored at kickoff against the market consensus (normal
// margin model, the research's SD) via shared/vas-record, which is what settles the timing question.
const path = require('node:path');
const E = require('./vas-engine'), Data = require('./vas-data'), Record = require('../../shared/vas-record');
let MODEL;
try { MODEL = require('./ncaaf-vas-model.json'); } catch { MODEL = null; }

const american = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const median = x => { const s = x.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const seasonOf = d => (d.getUTCMonth() >= 1 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);
function phi(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }

function create({ dir, fetchBuffer, fetchJSON, now = Date.now, log = () => {}, nevada = [] }) {
  const data = Data.create({ dir, now, log, fetchJSON, fetchBuffer: fetchBuffer || (async url => {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }) });
  const record = Record.create({ file: path.join(dir, 'signals.json'), now, tiers: ['WEAK', 'THIN', 'SOLID'] });
  let state = null, upcoming = new Map(), builtAt = null, building = false, lastError = null, info = null, hist = null;
  const SD = MODEL ? MODEL.sd_margin : 15.8;
  const NV = new Set(nevada);

  async function refresh() {
    if (building || !MODEL) return; building = true;
    try {
      const season = seasonOf(new Date(now()));
      const h = await data.history(season, { maxCloses: 400 });
      state = E.build(h, MODEL.config); hist = h;
      builtAt = new Date(now()).toISOString(); lastError = null;
      // A slow or failed scoreboard call must not throw away a good history build: keep the previous schedule.
      try { const up = await data.upcoming(season); upcoming = new Map(up.map(r => [String(r.gid), r])); }
      catch (e) { lastError = 'upcoming: ' + String(e.message || e).slice(0, 120); }
      info = { season, games: h.games.length, complete: h.complete, upcoming: upcoming.size };
    } catch (e) { lastError = String(e.message || e).slice(0, 160); log('[ncaaf-vas] refresh failed: ' + lastError); }
    finally { building = false; }
  }

  // P(home covers home spread `line`) when the market's fair home margin is mu
  const pHome = (line, mu) => 1 - phi((-line - mu) / SD);

  // G: board game; hist: W.lines.full(G.id) ({b: {book: {s: [[t, spread, homePrice]...], ...}}}); books: merged current lines
  function forGame(G, hist, books) {
    if (!MODEL) return null;
    if (!state) return { status: 'LOADING', note: 'Model history is loading.' };
    const row = upcoming.get(String(G.id));
    const started = G.state === 'in' || G.state === 'post' || Date.parse(G.start) <= now();
    if (started) { closeOut(G, books); return null; }
    if (!row) return { status: 'OFF', note: 'Game not in the model schedule.' };
    // openers: every book's first recorded spread (all books, as in the research consensus), first-seen time
    const openers = {};
    for (const [b, H] of Object.entries((hist && hist.b) || {})) {
      if (b === 'cons') continue;                                   // the app's derived consensus is not a book
      const first = H.s && H.s[0];
      if (first && Number.isFinite(first[1])) openers[b] = { spread: first[1], firstSeenAt: first[0] };
    }
    const cb = Data.crossBook(openers, { asOf: now() });
    const f = state.featuresFor(row, { late: {} });
    const x = E.withContext(f, row, { seasonType: row.seasonType, week: row.week, homeP5: row.homeP5, awayP5: row.awayP5 }, MODEL);
    const margin = E.predict(x, MODEL);
    const move = explain(row, x, margin, cb, books);
    if (!cb || cb.n < 3) return { status: 'OK', note: 'Waiting for at least three books to open.', move };
    const reads = [];
    for (const b of Object.keys(cb.books)) {
      if (NV.size && !NV.has(b)) continue;                          // Nevada books only
      const cur = books && books[b];
      if (!cur || cur.s == null || cur.s !== cb.books[b].open) continue; // only while the book still shows its opener
      const sig = E.signal(x, margin, { open: cb.books[b].open, openCons: cb.openCons }, MODEL, 'B');
      if (!sig || sig.tier === 'PASS') continue;
      const tier = sig.tier === 'DIAMOND' ? 'THIN' : 'WEAK';
      const price = sig.side === 'home' ? cur.so?.[0] : cur.so?.[1];
      reads.push({ book: b, tier, side: sig.side, bookOpen: cb.books[b].open, consensusOpen: cb.openCons, clv: sig.clv, price: Number.isFinite(price) ? price : null });
      track(G, b, sig.side, tier, cb.books[b].open, price, cb.openCons, books);
    }
    reads.sort((a, b) => Math.abs(b.clv) - Math.abs(a.clv));
    return { status: 'OK', model: MODEL.version, books: cb.n, consensusOpen: cb.openCons, reads, move };
  }

  // Why the line moved (model variant E): consensus opener -> consensus now, split into what the model can see.
  // Lead back / receiver status is not published for college football, so each lead player comes back as a
  // "what if he is ruled out" amount instead of being assumed.
  function explain(row, x, margin, cb, books) {
    try {
      if (!cb || !cb.n || !MODEL.stage2 || !MODEL.stage2.E) return null;
      const nowCons = consensusNow(books);
      const e = E.explainMove(x, margin, { open: cb.openCons, now: nowCons }, MODEL);
      if (!e) return null;
      const lead = (team) => (hist ? Data.leads(hist.games, team, row.season) : { rb: null, wr: null });
      const whatIf = [];
      for (const [side, team] of [['home', row.home_id], ['away', row.away_id]]) {
        const L = lead(team);
        for (const k of ['rb', 'wr']) if (L[k]) whatIf.push({ side, role: k === 'rb' ? 'lead back' : 'lead receiver', name: L[k].name, share: L[k].share,
          pts: (side === 'home' ? 1 : -1) * e.perShare[k] * L[k].share });
      }
      return { open: e.open, now: e.now, actual: e.actual, predicted: e.predicted, unexplained: e.unexplained, books: cb.n, margin,
        parts: e.parts.map((p) => ({ key: p.key, label: p.label, pts: p.pts })), whatIf };
    } catch { return null; }
  }

  const consensusNow = books => median(Object.values(books || {}).map(L => L && L.s));
  function track(G, b, side, tier, line, price, openCons, books) {
    const key = `${G.id}:spread:${b}`;
    const sideP = mu => { const ph = pHome(line, mu); return side === 'home' ? ph : 1 - ph; };
    if (!record.get(key) && Number.isFinite(price)) {
      record.observe(key, { tier, side, market: 'spread', line, entryOdds: price, entryBook: b, sideProb: sideP(-openCons), move: null,
        matchup: `${G.away?.abbr} @ ${G.home?.abbr}`, start: G.start });
    }
  }
  function refreshMarks(G, books) {
    const c = consensusNow(books); if (c == null) return;
    for (const r of Object.values(record.summary().signals)) {
      if (!r.gid.startsWith(G.id + ':') || r.closeProb != null) continue;
      const ph = pHome(r.line, -c); record.mark(r.gid, r.side === 'home' ? ph : 1 - ph);
    }
  }
  function closeOut(G, books) {
    for (const r of record.summary().signals) {
      if (!r.gid.startsWith(G.id + ':')) continue;
      record.close(r.gid);
      if (G.state === 'post' && Number.isFinite(G.home?.score) && Number.isFinite(G.away?.score)) {
        const m = G.home.score - G.away.score + r.line;   // home margin plus home spread
        record.settle(r.gid, m === 0 ? 'push' : (m > 0) === (r.side === 'home') ? 'won' : 'lost');
      }
    }
  }

  return {
    refresh, summary: () => record.summary(),
    forGame(G, hist, books) { const out = forGame(G, hist, books); try { refreshMarks(G, books); } catch {} return out; },
    status: () => ({ model: MODEL && MODEL.version, builtAt, building, history: info, data: data.status(), lastError, tiers: { THIN: 'variant B, proven on holdout, opener timing unverified', WEAK: 'lean' },
      proven: MODEL && MODEL.holdout_report ? provenFor(MODEL.holdout_report) : null }),
  };
}

// Proof page format for variant B spreads (whatever thresholds the research exported).
function provenFor(h) {
  const B = h.spread && h.spread.B; if (!B || !B.rules) return null;
  const k = h.bonferroni_factor || 1;
  return Object.fromEntries(Object.entries(B.rules).map(([t, v]) => ['opener off consensus, read ≥ ' + t + ' pts',
    { bets: v.bets, clv_ev_pct: v.clv_ev_pct, p: Math.min(1, v.p * k), beat_close: v.beat_close,
      by_season: Object.fromEntries(Object.entries(v.by_season || {}).map(([s, x]) => [s, x.clv_ev_pct])) }]));
}
module.exports = { create };
