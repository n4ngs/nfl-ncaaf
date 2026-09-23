'use strict';
// NHL VAS service: Goalie Matrix + open-safe line-movement signal + live closing-line record.
//
// Model: nhl/lib/nhl-vas-model.json (trained offline by nhl/research/portable.py; Node parity verified to 1e-10).
// Holdout 2024-26 at one book's opening price: DIAMOND tier (predicted move >= 0.08) beat the no-vig close by
// +1.46% EV over 229 bets (p=0.001), positive in both seasons. GOLD (>= 0.05) is a lean, not proven.
//
// Honest runtime rules:
//  - Regular season only. Starters are PROJECTED (the model was proven on projections, not confirmations).
//  - When the NHL's own pregame boxscore confirms a different starter, the signal is voided (PASS).
//  - The market is the median no-vig price across fresh, active books; the entry is the best available price.
//  - Every GOLD/DIAMOND signal is logged with its entry price and scored against the last pre-puck market, so the
//    live record proves or disproves the edge on its own. Nothing here places bets or changes displayed prices.
const fs = require('node:fs'), path = require('node:path');
const E = require('./vas-engine'), Data = require('./vas-data');
const MODEL = require('./nhl-vas-model.json');

const dec = a => 1 + (a > 0 ? a / 100 : 100 / -a);
const implied = a => 1 / dec(a);
const median = x => { const s = x.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// books: THE.BOARD combined book object -> {prob (no-vig home), books, best:{home,away}}
function market(books) {
  const probs = [], best = { home: null, away: null };
  for (const [book, L] of Object.entries(books || {})) {
    const ml = L && L.integrity && L.integrity.ml; if (!ml) continue;
    const q = { home: ml.home, away: ml.away };
    const ok = s => q[s] && q[s].market_status !== 'suspended' && q[s].freshness !== 'STALE' && q[s].freshness !== 'SUSPENDED' && Number.isFinite(Number(q[s].american_odds)) && Number(q[s].american_odds) !== 0;
    if (!ok('home') || !ok('away')) continue;
    const h = Number(q.home.american_odds), a = Number(q.away.american_odds), sum = implied(h) + implied(a);
    if (!(sum > 1.0 && sum < 1.12)) continue;
    probs.push(implied(h) / sum);
    for (const [s, o] of [['home', h], ['away', a]]) if (!best[s] || dec(o) > dec(best[s].odds)) best[s] = { odds: o, book, link: q[s].bet_link || null };
  }
  return probs.length ? { prob: median(probs), books: probs.length, best } : null;
}

const seasonOf = (d = new Date()) => d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;

function create({ dir, getBody, now = Date.now, log = console.log, fetchBuffer }) {
  fs.mkdirSync(dir, { recursive: true });
  const data = Data.create({
    dir, now, log,
    fetchJSON: url => getBody(url, { timeout: 15000 }),
    fetchBuffer: fetchBuffer || (async url => {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw Error('HTTP ' + r.status);
      const b = Buffer.from(await r.arrayBuffer());
      if (b.readUInt32LE(0) !== 0x04034b50) throw Error('not a zip');
      return b;
    }),
  });
  let state = null, builtAt = null, building = false, historyInfo = null, lastError = null;
  const confirmed = new Map();                 // gid -> {home: id, away: id} from NHL pregame boxscores
  const recFile = path.join(dir, 'signals.json');
  let record = {};
  try { record = JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch {}
  const saveRecord = () => { const t = recFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(record)); fs.renameSync(t, recFile); };

  async function refresh(tailGames = []) {
    if (building) return; building = true;
    try {
      const season = seasonOf(new Date(now()));
      const h = await data.history(season);
      const inHistory = new Set(h.games.map(g => g.gid));
      h.tail = [];
      for (const g of tailGames) if (!inHistory.has(Number(g.id))) { const b = await data.box(Number(g.id)); if (b) h.tail.push(b); }
      state = E.build(h, MODEL.config); builtAt = new Date(now()).toISOString();
      historyInfo = { season, games: h.games.length, tail: h.tail.length, complete: h.complete };
      lastError = null;
    } catch (e) { lastError = String(e.message || e).slice(0, 160); log('[vas] refresh failed: ' + lastError); }
    finally { building = false; }
  }

  function observeBox(raw) {
    if (!raw || !raw.id || !['FUT', 'PRE'].includes(raw.gameState)) return;
    const c = {};
    for (const side of ['home', 'away']) {
      const st = ((raw.playerByGameStats && raw.playerByGameStats[side + 'Team'] || {}).goalies || []).filter(g => g.starter === true);
      if (st.length === 1) c[side] = st[0].playerId;
    }
    if (c.home || c.away) confirmed.set(String(raw.id), { ...(confirmed.get(String(raw.id)) || {}), ...c });
  }

  function goalieCard(side, f) {
    const s = f['_' + side];
    return { id: s.proj, name: s.projName, gsax100: Math.round(s.gsax100 * 100) / 100, share10: s.share10, share20: s.share20,
      backToBack: !!s.gb2b, teamBackToBack: !!s.b2b, rest: s.rest };
  }

  // Board game -> VAS object (or a reason it is withheld)
  function forGame(g, books) {
    if (!state) return { status: 'LOADING', reason: 'Model history is loading.' };
    if (g.gameType !== 2 && !(g.gameType == null && !g.preseason)) return { status: 'OFF', reason: 'The model covers regular-season games only.' };
    const home = g.home && (g.home.abbr || g.home.abbrev), away = g.away && (g.away.abbr || g.away.abbrev);
    if (!home || !away || !g.start) return { status: 'OFF', reason: 'Teams or start time unavailable.' };
    const day = g.date || String(g.start).slice(0, 10);
    const f = state.featuresFor({ home, away, season: Math.floor(Number(g.id) / 1e6) || seasonOf(new Date(g.start)), day });
    const p = E.predict(f, MODEL);
    const out = { status: 'OK', model: MODEL.version, pHome: p, goalies: { home: goalieCard('home', f), away: goalieCard('away', f) },
      goalieEdge: Math.round((f._home.gsax100 - f._away.gsax100) * 100) / 100, lineupEdge: f.d_lineup, confirmed: confirmed.get(String(g.id)) || null };
    const started = g.state === 'in' || g.final || Date.parse(g.start) <= now();
    const m = market(books);
    out.market = m;
    if (started) closeOut(g);
    if (!m) { out.tier = 'PASS'; out.reason = 'No fresh two-way moneyline yet.'; return out; }
    const sig = E.signal(f, p, m, MODEL);
    Object.assign(out, { move: sig.move, side: sig.side, tier: sig.tier, gap: sig.gap, entry: m.best[sig.side] });
    const c = out.confirmed;
    for (const side of ['home', 'away']) {
      if (c && c[side] && out.goalies[side].id && c[side] !== out.goalies[side].id) {
        out.tier = 'PASS'; out.reason = `${side === 'home' ? home : away} confirmed a different starter than projected; signal voided.`;
      }
    }
    if (!started) track(g, out, m);
    return out;
  }

  // Live record: first GOLD/DIAMOND sighting is the entry; the last pre-puck market is the close.
  function track(g, v, m) {
    const id = String(g.id), r = record[id];
    if (v.tier === 'GOLD' || v.tier === 'DIAMOND') {
      if (!r || (r.tier === 'GOLD' && v.tier === 'DIAMOND')) {
        record[id] = { gid: id, start: g.start, matchup: `${g.away.abbr} @ ${g.home.abbr}`, tier: v.tier, side: v.side, move: v.move,
          entryAt: new Date(now()).toISOString(), entryOdds: v.entry && v.entry.odds, entryBook: v.entry && v.entry.book,
          entryProb: m.prob, lastProb: m.prob, lastAt: new Date(now()).toISOString(), closeProb: null, result: null };
        saveRecord();
      }
    }
    if (record[id] && !record[id].closeProb) { record[id].lastProb = m.prob; record[id].lastAt = new Date(now()).toISOString(); }
  }
  function closeOut(g) {
    const r = record[String(g.id)]; if (!r) return;
    let dirty = false;
    if (r.closeProb == null && r.lastProb != null) { r.closeProb = r.lastProb; dirty = true; }
    if (g.final && r.result == null && Number.isFinite(g.home?.score) && Number.isFinite(g.away?.score)) {
      r.result = (g.home.score > g.away.score ? 'home' : 'away') === r.side ? 'won' : 'lost'; dirty = true;
    }
    if (dirty) saveRecord();
  }
  function summary() {
    const rows = Object.values(record).filter(r => r.closeProb != null && Number.isFinite(r.entryOdds));
    const by = {};
    for (const r of rows) {
      const pc = r.side === 'home' ? r.closeProb : 1 - r.closeProb, ev = pc * dec(r.entryOdds) - 1;
      const moved = r.side === 'home' ? r.closeProb - r.entryProb : r.entryProb - r.closeProb;
      for (const k of [r.tier, 'ALL']) {
        const b = by[k] || (by[k] = { bets: 0, ev: 0, beat: 0, won: 0, settled: 0, profit: 0 });
        b.bets++; b.ev += ev; b.beat += moved > 0 ? 1 : 0;
        if (r.result) { b.settled++; if (r.result === 'won') { b.won++; b.profit += dec(r.entryOdds) - 1; } else b.profit -= 1; }
      }
    }
    for (const b of Object.values(by)) { b.clvEvPct = b.bets ? b.ev / b.bets * 100 : null; b.beatCloseRate = b.bets ? b.beat / b.bets : null; b.roiPct = b.settled ? b.profit / b.settled * 100 : null; delete b.ev; delete b.beat; delete b.profit; }
    return { tiers: by, open: Object.values(record).filter(r => r.closeProb == null).length, signals: Object.values(record).sort((a, b) => b.entryAt.localeCompare(a.entryAt)).slice(0, 200) };
  }

  return {
    refresh, observeBox, forGame, summary, market,
    ready: () => !!state,
    status: () => ({ model: MODEL.version, builtAt, building, history: historyInfo, data: data.status(), lastError, record: Object.keys(record).length,
      proven: MODEL.holdout_report, tiers: MODEL.tiers }),
  };
}

module.exports = { create, market, seasonOf, MODEL };
