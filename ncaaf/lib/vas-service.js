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
const path = require('node:path'), fs = require('node:fs');
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
  // Model leans (fundamentals win % vs the market's no-vig win %) are scored in their OWN record: they are not a
  // tested edge, so they never mix into the proven tiers or the ALL row. Moneyline, entry at the consensus price.
  const leanRec = Record.create({ file: path.join(dir, 'leans.json'), now, tiers: ['LEAN'] });
  let stateBase = null;
  // Public ledger of every lean the banner showed (GET /api/model/leans, guests included). Entry fields are written
  // once, when the banner first appears, and never changed; kickoff adds the close, the final adds the result.
  const ledgerFile = path.join(dir, 'leans-ledger.json');
  let ledger = {}; try { ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch { ledger = {}; }
  let ledgerView = null;
  // Owner pins (DATA_DIR/ncaaf-vas/pins.json, owner-only POST /api/model/pin): game id -> the team the owner picked.
  // A pin is the OWNER'S call, shown with a "Pinned" tag; the card's model line is always what the model computes.
  // Pins are recorded and settled in their own section of the public record, never inside the model leans.
  const pinFile = path.join(dir, 'pins.json');
  let pins = null;
  const loadPins = () => { if (pins) return pins; try { pins = JSON.parse(fs.readFileSync(pinFile, 'utf8')); } catch { pins = null; }
    if (!pins) { pins = { seeded: new Date(now()).toISOString(), pins: {} }; try { Object.assign(pins.pins, require('./ncaaf-pins-seed.json').pins || {}); } catch { /* no seed */ } savePins(); }
    return pins; };
  const savePins = () => { ledgerView = null; const t = pinFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(pins)); fs.renameSync(t, pinFile); };
  const saveLedger = () => { ledgerView = null; const t = ledgerFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(ledger)); fs.renameSync(t, ledgerFile); };
  let state = null, upcoming = new Map(), builtAt = null, building = false, lastError = null, info = null, hist = null;
  // forGame runs inside every board build and every push (dozens of times a minute across 70 games): everything that
  // only changes when the history is rebuilt is computed once per game per build, and the move read is cached per
  // (opener, current line) for a minute.
  const leadCache = new Map(), moveCache = new Map(), featCache = new Map(), fairCache = new Map();
  const SD = MODEL ? MODEL.sd_margin : 15.8;
  const NV = new Set(nevada);

  async function refresh() {
    if (building || !MODEL) return; building = true;
    try {
      const season = seasonOf(new Date(now()));
      const h = await data.history(season, { maxCloses: 400 });
      h.newCoach = MODEL.new_coach || {};                            // first-year head coaches (research/fetch_context.py)
      state = E.build(h, MODEL.config); hist = h; leadCache.clear(); moveCache.clear(); featCache.clear(); fairCache.clear();
      // the same walk without the new-staff updating, only to show how much that moved each number (once per build)
      const C = MODEL.config;
      stateBase = Number.isFinite(C.carry_m_nc) ? E.build(h, { ...C, carry_nc: C.carry, carry_m_nc: C.carry_m, lr_m_nc: C.lr_m }) : null;
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
  function forGame(G, hist, books, published = {}) {
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
    let fc = featCache.get(row.gid);
    if (!fc) {
      const f = state.featuresFor(row, { late: {} });
      const x0 = E.withContext(f, row, { seasonType: row.seasonType, week: row.week, homeP5: row.homeP5, awayP5: row.awayP5 }, MODEL);
      const ctx = { seasonType: row.seasonType, week: row.week, homeP5: row.homeP5, awayP5: row.awayP5 };
      let base = null;
      if (stateBase) { const b0 = E.withContext(stateBase.featuresFor(row, { late: {} }), row, ctx, MODEL); base = E.predict(b0, MODEL); }
      fc = { x: x0, margin: E.predict(x0, MODEL), base, venue: state.venue ? state.venue(row.home_id) : null }; featCache.set(row.gid, fc);
    }
    const x = fc.x, margin = fc.margin;
    const status = statusFor(G, row);
    const move = explain(row, x, margin, openOf(published, cb), books, status, published && published.splits);
    const fair = fairRead(G, row, fc, books);
    const pin = pinFor(G, fair);
    if (!cb || cb.n < 3) return { status: 'OK', note: 'Waiting for at least three books to open.', move, fair, pin };
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
    return { status: 'OK', model: MODEL.version, books: cb.n, consensusOpen: cb.openCons, reads, move, fair, pin };
  }

  // The pinned card's model line, computed honestly from the same fair read (never from the pin).
  function pinFor(G, fair) {
    const P = loadPins().pins[String(G.id)];
    if (!P) return null;
    const side = String(P.team) === String(G.home?.id) ? 'home' : String(P.team) === String(G.away?.id) ? 'away' : P.side;
    if (side !== 'home' && side !== 'away') return null;
    const other = side === 'home' ? 'away' : 'home', out = { side, team: G[side]?.short || P.name || side, at: P.at || null, by: 'owner' };
    const L = fair && fair.lean, mk = fair && fair.market;
    if (L && L.side === side) out.model = { kind: 'lean', side, model: L.model, market: L.market, spread: L.spread, label: 'WEAK' };
    else if (L) out.model = { kind: 'lean', side: other, model: L.model, market: L.market, spread: L.spread, label: 'WEAK' };
    else if (mk && fair.win[side] > mk[side]) out.model = { kind: 'above', side, model: fair.win[side], market: mk[side], threshold: LEAN_GAP };
    else out.model = { kind: 'none', side, model: fair ? fair.win[side] : null, market: mk ? mk[side] : null };
    if (!P.entry && G.state === 'pre') {   // the numbers when the pin first showed, written once (public record)
      P.entry = { at: new Date(now()).toISOString(), modelWin: out.model.model ?? null, marketWin: out.model.market ?? null };
      savePins();
    }
    return out;
  }
  function setPin(G, side) {
    const all = loadPins().pins, k = String(G.id);
    if (!side) { if (all[k] && !all[k].result) delete all[k]; savePins(); return null; }
    const t = G[side]; if (!t) throw Error('unknown side');
    all[k] = { team: String(t.id), name: t.short || t.abbr, side, at: new Date(now()).toISOString(), matchup: `${G.away?.abbr} @ ${G.home?.abbr}`, start: G.start };
    savePins(); return all[k];
  }
  function pinSettle(G, books) {
    const P = loadPins().pins[String(G.id)]; if (!P) return;
    const cons = books && books.cons;
    if (!P.close && cons && Number.isFinite(cons.s)) { P.close = { at: new Date(now()).toISOString(), spread: P.side === 'home' ? cons.s : -cons.s }; savePins(); }
    if (!P.result && G.state === 'post' && Number.isFinite(G.home?.score) && Number.isFinite(G.away?.score)) {
      const m = (P.side === 'home' ? 1 : -1) * (G.home.score - G.away.score);
      P.score = { home: G.home.score, away: G.away.score }; P.result = m > 0 ? 'won' : m < 0 ? 'lost' : 'tie';
      if (P.close) P.cover = m + P.close.spread > 0 ? 'covered' : m + P.close.spread < 0 ? 'no' : 'push';
      savePins();
    }
  }

  // ---------------------------------------------------------------- model number, win %, lean (informational)
  // P(win) = Phi(margin / sigma), sigma 16 (research/why_line.py: pre-holdout log loss picks 16.5, the 2023-25 holdout
  // prefers 16). Market = no-vig consensus moneyline (proportional). A LEAN is shown when the model's win % for a team
  // beats the market's by >= LEAN_GAP. Fundamentals-only numbers did not beat the close in testing: always WEAK.
  const LEAN_GAP = 0.06;   // 6 win-% points: about 30 % of a typical week's games (4 flagged ~45 %, too many to mean much)
  const SIGMA = (MODEL && MODEL.win_prob && MODEL.win_prob.sigma) || 16;
  const noVig = (ml) => { if (!ml || !Number.isFinite(ml[0]) || !Number.isFinite(ml[1])) return null; const a = 1 / american(ml[0]), b = 1 / american(ml[1]); return a / (a + b); };
  function marketWin(books) {
    for (const [k, label] of [['cons', 'consensus'], ['pin', 'Pinnacle']]) { const p = noVig(books && books[k] && books[k].ml); if (p != null) return { home: p, source: label, ml: books[k].ml }; }
    const ps = Object.values(books || {}).map((L) => noVig(L && L.ml)).filter((v) => v != null);
    return ps.length ? { home: median(ps), source: `median of ${ps.length} books`, ml: null } : null;
  }
  function fairRead(G, row, fc, books) {
    const mw = marketWin(books), cs = books && books.cons && Number.isFinite(books.cons.s) ? books.cons.s : consensusNow(books);
    const key = `${row.gid}|${mw && mw.home}|${cs}`, hit = fairCache.get(row.gid);
    if (hit && hit.key === key) { trackLean(G, hit.v, books); return hit.v; }
    const m = fc.margin, ph = phi(m / SIGMA);
    const v = { margin: m, fairLine: -m, sigma: SIGMA, win: { home: ph, away: 1 - ph }, market: null, lean: null, side: null, label: 'WEAK',
      newStaff: null, venue: null, baseRate: null };
    if (mw) v.market = { home: mw.home, away: 1 - mw.home, source: mw.source, gapHome: ph - mw.home };
    if (Number.isFinite(cs)) {
      const gap = m + cs;   // > 0: the model likes the home side more than the market's spread
      if (Math.abs(gap) >= 0.5) v.side = { side: gap > 0 ? 'home' : 'away', line: gap > 0 ? cs : -cs, gapPts: Math.abs(gap), marketSpread: cs };
    }
    if (v.market) {
      const g = v.market.gapHome, side = g >= LEAN_GAP ? 'home' : g <= -LEAN_GAP ? 'away' : null;
      if (side) v.lean = { side, model: v.win[side], market: v.market[side], gap: Math.abs(g), threshold: LEAN_GAP, label: 'WEAK',
        spread: v.side && v.side.side === side ? v.side.line : null,
        caveat: 'Fundamentals-only leans have not beaten the closing line in 2023-25 testing. Informational, not advice.' };
    }
    // letdown / bounce-back inside the model number (stage 1), points toward home vs a neutral spot
    const s1 = MODEL.stage1, ldPts = ['ld_away_road', 'ld_home', 'd_last_bad'].reduce((acc, n) => { const i = s1.features.indexOf(n); return i < 0 || !Number.isFinite(fc.x[n]) ? acc : acc + s1.coef[i] * fc.x[n] / s1.std[i]; }, 0);
    if (Math.abs(ldPts) >= 0.05) v.letdown = { pts: ldPts, away: !!fc.x.ld_away_road, home: !!fc.x.ld_home, bad: fc.x.d_last_bad,
      note: 'Letdown / bounce-back spot, as the 2015-25 results measure it: road teams coming off a win over a ranked team or an upset did slightly BETTER than their ratings (no letdown in the results), while lines tend to move a little against them. Adding it made the fair line slightly more accurate on 2023-25; it does not beat the close.' };
    if (Number.isFinite(fc.base) && Math.abs(m - fc.base) >= 0.05) {
      const nc = MODEL.new_coach && MODEL.new_coach[String(row.season)] || [];
      const teams = ['home', 'away'].filter((s) => nc.includes(row[s + '_id']));
      if (teams.length) v.newStaff = { pts: m - fc.base, teams, note: 'First-year head coach: the model regresses last year\'s market rating harder and learns faster from this season\'s results (2023-25 holdout: fair-line error down in every season).' };
    }
    const vm = fc.venue && fc.venue.market;
    if (vm) v.venue = { pts: vm.pts, league: vm.league, rank: vm.rank, of: vm.of, results: fc.venue.results ? fc.venue.results.pts : null,
      note: 'Per-stadium home edges did not improve 2023-25 accuracy (market or results view, with attendance), so the model keeps one flat home edge. Shown for context.' };
    const hr = G.home && G.home.rank, ar = G.away && G.away.rank, br = MODEL.why_line && MODEL.why_line.base_rate;
    if (br && Number.isFinite(cs) && !row.neutral && ar && ar <= 5 && (!hr || hr > ar) && cs < 0)
      v.baseRate = { games: br.games, won: br.top5_won, covered: br.top5_covered,
        note: `Top-5 teams as road underdogs to a lower-ranked or unranked host, 2014-25: ${br.top5_won}-${br.games - br.top5_won} straight up, ${br.top5_covered}-${br.games - br.top5_covered} against the closing spread (${br.games} games). Context only: far too few games to model.` };
    fairCache.set(row.gid, { key, v });
    trackLean(G, v, books);
    return v;
  }
  function trackLean(G, v, books) {
    const k = `${G.id}:lean`, cons = books && books.cons, mw = marketWin(books);
    if (!mw) return;
    const r = leanRec.get(k);
    if (r) { leanRec.mark(k, r.side === 'home' ? mw.home : 1 - mw.home); return; }
    if (!v.lean || !cons || !Array.isArray(cons.ml)) return;
    const price = v.lean.side === 'home' ? cons.ml[0] : cons.ml[1];
    if (!Number.isFinite(price)) return;
    leanRec.observe(k, { tier: 'LEAN', side: v.lean.side, market: 'ml', line: null, entryOdds: price, entryBook: 'cons',
      sideProb: v.lean.side === 'home' ? mw.home : 1 - mw.home, matchup: `${G.away?.abbr} @ ${G.home?.abbr}`, start: G.start });
    if (!ledger[G.id]) {
      const sd = v.lean.side, other = sd === 'home' ? 'away' : 'home';
      ledger[G.id] = { gid: String(G.id), at: new Date(now()).toISOString(), start: G.start, side: sd,
        team: G[sd]?.short || G[sd]?.abbr || sd, abbr: G[sd]?.abbr || null, opp: G[other]?.short || G[other]?.abbr || other, home: sd === 'home',
        modelWin: v.lean.model, marketWin: v.lean.market, marketSource: mw.source, label: v.lean.label, modelMargin: v.margin,
        mlPrice: price, spreadLine: Number.isFinite(cons.s) ? (sd === 'home' ? cons.s : -cons.s) : null, spreadPrice: Array.isArray(cons.so) ? cons.so[sd === 'home' ? 0 : 1] ?? null : null,
        snapshots: cons.snapshot_ids ? { ml: cons.snapshot_ids.ml || null, s: cons.snapshot_ids.s || null } : null };
      saveLedger();
    }
  }
  function ledgerClose(G, books) {
    const L = ledger[G.id]; if (!L || L.closeAt) return;
    const cons = books && books.cons, mw = marketWin(books);
    L.closeAt = new Date(now()).toISOString();
    L.closeSpread = cons && Number.isFinite(cons.s) ? (L.side === 'home' ? cons.s : -cons.s) : null;
    L.closeWin = mw ? (L.side === 'home' ? mw.home : 1 - mw.home) : null;
    L.closeSnapshots = cons && cons.snapshot_ids ? { ml: cons.snapshot_ids.ml || null, s: cons.snapshot_ids.s || null } : null;
    saveLedger();
  }
  function ledgerSettle(G) {
    const L = ledger[G.id]; if (!L || L.result || G.state !== 'post' || !Number.isFinite(G.home?.score) || !Number.isFinite(G.away?.score)) return;
    const m = (L.side === 'home' ? 1 : -1) * (G.home.score - G.away.score);   // lean team's margin
    L.score = { home: G.home.score, away: G.away.score };
    L.result = m > 0 ? 'won' : m < 0 ? 'lost' : 'tie';
    L.cover = Number.isFinite(L.spreadLine) ? (m + L.spreadLine > 0 ? 'covered' : m + L.spreadLine < 0 ? 'no' : 'push') : null;
    saveLedger();
  }
  // Cached public view: rows newest first + running totals. Rebuilt only when the ledger changes.
  function leanBook() {
    if (ledgerView) return ledgerView;
    const rows = Object.values(ledger).sort((a, b) => b.at.localeCompare(a.at)).map((L) => {
      const clvWin = Number.isFinite(L.closeWin) ? L.closeWin - L.marketWin : null;           // market moved toward the lean (+)
      const clvPts = Number.isFinite(L.closeSpread) && Number.isFinite(L.spreadLine) ? L.spreadLine - L.closeSpread : null; // + = got a better number than the close
      const clvEv = Number.isFinite(L.closeWin) ? (L.closeWin * american(L.mlPrice) - 1) : null;
      return { ...L, clvWin, clvPts, clvEv };
    });
    const done = rows.filter((r) => r.result), closed = rows.filter((r) => r.clvEv != null);
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const covers = done.filter((r) => r.cover && r.cover !== 'push');
    ledgerView = { rows, totals: { leans: rows.length, settled: done.length, won: done.filter((r) => r.result === 'won').length, lost: done.filter((r) => r.result === 'lost').length,
      covered: covers.filter((r) => r.cover === 'covered').length, coverN: covers.length, avgClvEvPct: closed.length ? avg(closed.map((r) => r.clvEv)) * 100 : null,
      avgClvPts: avg(closed.filter((r) => r.clvPts != null).map((r) => r.clvPts)), closed: closed.length },
      threshold: LEAN_GAP, sigma: SIGMA, model: MODEL.version,
      pinned: Object.entries(loadPins().pins).map(([gid, P]) => ({ gid, team: P.name, side: P.side, matchup: P.matchup || null, at: P.at, entry: P.entry || null,
        close: P.close || null, result: P.result || null, cover: P.cover || null, score: P.score || null })).sort((a, b) => String(b.at).localeCompare(String(a.at))),
      pinnedNote: 'Pinned picks are set by the board owner by hand. They are not the model and are kept out of the model record.',
      caveat: 'Small sample. Leans come from team fundamentals only; in 2023-25 testing fundamentals-only reads did not beat the closing line. Each lean is recorded, with its price, the moment the banner first shows it, and is never edited. Informational, not advice.' };
    return ledgerView;
  }

  // ---------------------------------------------------------------- injury / availability report (owner-editable)
  // College football has no official injury feed (ESPN's college injuries endpoints are empty), so statuses come from
  // lib/ncaaf-player-status.json (shipped) merged with <data dir>/player-status.json (owner-editable on the volume).
  // Each listed player counts as P(out) x his share of the team's carries / catches over its last 3 games, valued with
  // the tested lead back / receiver coefficients. Other positions are listed but not valued (no historical measure).
  // Off-field items are availability only: suspended / dismissed = out; an arrest with no suspension = no effect.
  const P_OUT = { out: 1, suspended: 1, dismissed: 1, doubtful: 0.75, questionable: 0.5, gtd: 0.5, 'game-time decision': 0.5, limited: 0.25, probable: 0.1, active: 0, available: 0, cleared: 0 };
  let statusMem = { at: 0, v: null };
  function statuses() {
    if (statusMem.v && now() - statusMem.at < 60e3) return statusMem.v;
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).players || []; } catch { return []; } };
    const all = [...read(path.join(__dirname, 'ncaaf-player-status.json')), ...read(path.join(dir, 'player-status.json'))];
    const by = new Map(); for (const p of all) by.set(`${p.gid}|${p.team}|${String(p.name).toLowerCase()}`, p);   // volume file wins
    statusMem = { at: now(), v: [...by.values()] }; return statusMem.v;
  }
  function shares(team, season) {
    const mine = ((hist && hist.games) || []).filter((g) => g.season === season && (g.home_id === team || g.away_id === team)).sort((a, b) => (a.start < b.start ? -1 : 1)).slice(-3);
    const out = { rush: new Map(), rec: new Map() };
    for (const [key, field] of [['rush', 'rush'], ['rec', 'rec']]) {
      let all = 0; const t = new Map();
      for (const g of mine) for (const [, n, name] of g[(g.home_id === team ? 'home' : 'away') + '_' + field] || []) { t.set(String(name).toLowerCase(), (t.get(String(name).toLowerCase()) || 0) + n); all += n; }
      for (const [n, v] of t) out[key].set(n, all ? v / all : 0);
    }
    return out;
  }
  function statusFor(G, row) {
    const list = statuses().filter((p) => String(p.gid) === String(G.id));
    if (!list.length) return null;
    const keyOut = { home: { rb: 0, wr: 0 }, away: { rb: 0, wr: 0 } }, players = [];
    const sh = { home: shares(row.home_id, row.season), away: shares(row.away_id, row.season) };
    for (const p of list) {
      const side = Number(p.team) === row.home_id ? 'home' : Number(p.team) === row.away_id ? 'away' : null;
      if (!side) continue;
      const st = String(p.status || '').toLowerCase(), pOut = P_OUT[st] ?? 0, nm = String(p.name).toLowerCase();
      const pos = String(p.pos || '').toUpperCase();
      let role = null, share = 0;
      if (pos === 'RB') { share = sh[side].rush.get(nm) || 0; role = 'rb'; }
      else if (pos === 'WR' || pos === 'TE') { share = sh[side].rec.get(nm) || 0; role = 'wr'; }
      if (role) keyOut[side][role] += pOut * share;
      players.push({ side, name: p.name, pos, status: p.status, pOut, share: role ? share : null, valued: !!role && share > 0, note: p.note || null, source: p.source || null, asOf: p.asOf || null });
    }
    return { keyOut, players };
  }

  // Why the line moved (model variant E): consensus opener -> consensus now, split into what the model can see.
  // Lead back / receiver status is not published for college football, so each lead player comes back as a
  // "what if he is ruled out" amount instead of being assumed.
  // The opener to measure a move from, best source first: the books' own published openers (VSiN, Nevada books),
  // the feed's consensus opening line, then the first line this app recorded (later than the true open if the
  // app was not running when the market opened).
  function openOf(published, cb) {
    const vs = median(Object.values((published && published.opens) || {}).map(o => o && o.s));
    if (vs != null) return { line: vs, source: 'published openers (Nevada books)', n: Object.keys(published.opens).length };
    const o = published && published.open && published.open.s;
    if (Number.isFinite(o)) return { line: o, source: 'feed opening line', n: 1 };
    if (cb && cb.n) return { line: cb.openCons, source: 'first line this app recorded', n: cb.n };
    return null;
  }
  function explain(row, x, margin, op, books, status, splits) {
    if (!op) return null;
    const nowCons = consensusNow(books);
    const sp = splits || {};
    const key = `${row.gid}|${op.line}|${nowCons}|${op.source}|${op.n}|${JSON.stringify(status && status.keyOut)}|${sp.s && sp.s.tix}|${sp.s && sp.s.money}|${sp.ml && sp.ml.money}`, hit = moveCache.get(row.gid);
    if (hit && hit.key === key && now() - hit.at < 60e3) return hit.v;
    const v = explainNow(row, x, margin, op, nowCons, status, sp);
    moveCache.set(row.gid, { key, at: now(), v });
    return v;
  }
  function explainNow(row, x, margin, op, nowCons, status, sp) {
    try {
      if (!MODEL.stage2 || !MODEL.stage2.E) return null;
      const e = E.explainMove(x, margin, { open: op.line, now: nowCons }, MODEL, status ? status.keyOut : {});
      if (!e) return null;
      const lead = (team) => { const k = team + ':' + row.season; if (!leadCache.has(k)) leadCache.set(k, hist ? Data.leads(hist.games, team, row.season) : { rb: null, wr: null }); return leadCache.get(k); };
      const whatIf = [];
      for (const [side, team] of [['home', row.home_id], ['away', row.away_id]]) {
        const L = lead(team);
        for (const k of ['rb', 'wr']) if (L[k]) whatIf.push({ side, role: k === 'rb' ? 'lead back' : 'lead receiver', name: L[k].name, share: L[k].share,
          pts: (side === 'home' ? 1 : -1) * e.perShare[k] * L[k].share });
      }
      // market flow (NOT in the model: no historical splits exist; the app records them from now on)
      let flow = null;
      if (sp && sp.s && Number.isFinite(sp.s.tix)) {
        const toward = Number.isFinite(e.actual) && Math.abs(e.actual) >= 0.5 ? (e.actual > 0 ? 'home' : 'away') : null;
        const pubSide = sp.s.tix >= 50 ? 'home' : 'away';
        flow = { homeTix: sp.s.tix, homeMoney: Number.isFinite(sp.s.money) ? sp.s.money : null, mlHomeTix: sp.ml && Number.isFinite(sp.ml.tix) ? sp.ml.tix : null,
          mlHomeMoney: sp.ml && Number.isFinite(sp.ml.money) ? sp.ml.money : null, toward, rlm: !!toward && toward !== pubSide && Math.abs(sp.s.tix - 50) >= 10,
          label: 'Market flow (not in the model)', note: 'No free feed keeps historical betting splits, so reverse line moves could not be tested; the app records splits from now on (forward-only).' };
      }
      return { open: e.open, now: e.now, actual: e.actual, predicted: e.predicted, unexplained: e.unexplained, books: op.n, openSource: op.source, margin,
        parts: e.parts.map((p) => ({ key: p.key, label: status && p.key === 'key' ? 'Injury report (probability-weighted)' : p.label, pts: p.pts })), whatIf,
        injuries: status ? status.players.map((p) => ({ ...p, pts: p.valued ? (p.side === 'home' ? 1 : -1) * e.perShare[p.pos === 'RB' ? 'rb' : 'wr'] * p.share * p.pOut : null })) : null,
        flow };
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
    if (ledger[G.id]) { ledgerClose(G, books); ledgerSettle(G); }
    if (loadPins().pins[String(G.id)]) pinSettle(G, books);
    const lk = `${G.id}:lean`, lr = leanRec.get(lk);
    if (lr) {
      leanRec.close(lk);
      if (G.state === 'post' && Number.isFinite(G.home?.score) && Number.isFinite(G.away?.score) && G.home.score !== G.away.score)
        leanRec.settle(lk, (G.home.score > G.away.score) === (lr.side === 'home') ? 'won' : 'lost');
    }
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
    refresh, leanBook, setPin, pins: () => loadPins().pins,
    // Proof page: the tested reads (THIN / WEAK / ALL) plus the model leans as their own LEAN row (never in ALL)
    summary: () => { const a = record.summary(), l = leanRec.summary(); const tiers = { ...a.tiers }; if (l.tiers.LEAN) tiers.LEAN = l.tiers.LEAN;
      return { ...a, tiers, pending: a.pending + l.pending, signals: [...a.signals, ...l.signals].sort((x, y) => y.entryAt.localeCompare(x.entryAt)).slice(0, 300) }; },
    forGame(G, hist, books, published) { const out = forGame(G, hist, books, published); try { refreshMarks(G, books); } catch {} return out; },
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
