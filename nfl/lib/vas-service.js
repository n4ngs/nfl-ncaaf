'use strict';
// Pick Six model read: the NFL research model (nfl/research, parity-tested port in lib/vas-engine.js) run live.
//
// What it says, and what it does not (Pick Six rules: informational, never a pick):
//  - TOTALS ONLY. Spreads did not beat the close in research, so no spread read is shown.
//  - The totals read is PROVISIONAL: it passed the pre-set bar on the 2016 + 2023-25 holdout (+1.96% CLV EV,
//    238 bets, Bonferroni p = 0.036) but on modern book opens alone it is not yet significant (p = 0.07).
//    Replicated, with nothing refit, on the owner's AusSportsBetting openers 2017-22 (+3.47%, 416 bets, Bonferroni
//    p < 0.001, 6/6 seasons; model file external_evidence). Those openers are untimed (Pinnacle to Feb 2018, bet365
//    after), so the open-timing caveat stands. The live record below is what confirms or kills it.
//  - Injury Matrix: display only. ESPN's headline injury list weighted by each player's snap share and the
//    chance that status means a missed game. Never feeds the model.
// Every PROVEN/LEAN totals read is logged at the OPEN price it was computed from and scored at kickoff with the
// same key-number math as the research (pushes counted), via shared/vas-record.
const path = require('node:path'), fs = require('node:fs');
const E = require('./vas-engine'), Data = require('./vas-data'), Record = require('../../shared/vas-record');
let MODEL;
try { MODEL = require('./nfl-vas-model.json'); } catch { MODEL = null; }

const ESPN_TO_NFLVERSE = { LAR: 'LA', WSH: 'WAS' };
const code = t => ESPN_TO_NFLVERSE[t] || t;
const american = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const seasonOf = d => (d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);
const WORDS = { PROVEN: 'Provisional', LEAN: 'Lean' };

function create({ dir, fetchBuffer, now = Date.now, log = () => {} }) {
  const data = Data.create({ dir, now, log, fetchBuffer: fetchBuffer || (async url => {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
    if (!r.ok) throw Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  }) });
  const record = Record.create({ file: path.join(dir, 'signals.json'), now });
  let state = null, upcoming = [], played = [], builtAt = null, building = false, lastError = null, info = null;
  // Stage-1 read per game, computed once per history build (the board reads it on every publish, never recomputes).
  const predCache = new Map();
  // The research scored the FIRST line seen after both teams' previous games were final. That line is this game's
  // anchor: captured once, persisted, and used for the read and the live record (never the week-ahead opener).
  const anchorFile = path.join(dir, 'anchors.json');
  let anchors = {}; try { anchors = JSON.parse(fs.readFileSync(anchorFile, 'utf8')); } catch {}
  const saveAnchors = () => { try { const t = anchorFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(anchors)); fs.renameSync(t, anchorFile); } catch {} };

  async function refresh() {
    if (building || !MODEL) return; building = true;
    try {
      const season = seasonOf(new Date(now()));
      const h = await data.history(season);
      state = E.build(h, MODEL.config);
      upcoming = await data.upcoming(season);
      // This season's completed games, so earlier weeks keep their Model column. Their read is the one the engine
      // computed with the state strictly before that game day (build().featured), never with the result in it.
      played = h.games.filter(g => g.season === season);
      predCache.clear();
      builtAt = new Date(now()).toISOString(); info = { season, games: h.games.length, complete: h.complete, ...(h.info || {}) }; lastError = null;
    } catch (e) { lastError = String(e.message || e).slice(0, 160); log('[nfl-vas] refresh failed: ' + lastError); }
    finally { building = false; }
  }

  function schedRow(G) {
    const h = code(G.home?.abbr), a = code(G.away?.abbr), day = String(G.start || '').slice(0, 10);
    const t = Date.parse(G.start);
    const near = r => r.home === h && r.away === a && Math.abs(Date.parse(r.day + 'T12:00:00Z') - t) < 2.5 * 86400e3;
    return upcoming.find(near) || played.find(near) || null;
  }
  const marketOf = L => L ? { spread: L.s == null ? null : -L.s, homePrice: L.so?.[0], awayPrice: L.so?.[1], total: L.t, overPrice: L.to?.[0], underPrice: L.to?.[1] } : null;
  // probability the recorded side wins at `line`, push-adjusted so that CLV EV = p * decimal - 1 matches the research
  function sideProb(line, sideOver, total, overPrice, underPrice, entryOdds) {
    const kd = MODEL.keydist.total, pOver = E.noVig(overPrice, underPrice);
    if (pOver == null || !Number.isFinite(total)) return null;
    const mu = E.fairMean(total, pOver, kd);
    let [w, p] = E.probs(mu, line, kd); if (!sideOver) w = 1 - w - p;
    return w + p / american(entryOdds);
  }

  // Win chance for a fair spread of `margin` (home minus away) through the key-number distribution (E.winFromSpread).
  // On TeamRankings closes 2003-25 (6,232 NFL favorites) it tracks real win rates (a 7-9.5 point favorite: 75.2% vs
  // 76.2% won), where a normal on the model's margin SD (13.66) read favorites 3-6 points low. Display only.
  const winHome = margin => E.winFromSpread(margin, MODEL.keydist?.margin);

  // G: board game, open/cur: canonical lines ({s, so, t, to, integrity})
  function forGame(G, open, cur) {
    if (!MODEL) return null;
    if (!state) return { status: 'LOADING', note: 'Model history is loading.' };
    if (G.seasonType != null && ![2, 3].includes(Number(G.seasonType))) return { status: 'OFF', note: 'Regular season and playoffs only.' };
    const row = schedRow(G);
    if (!row) return { status: 'OFF', note: 'Game not in the model schedule yet.' };
    // Reads wait until neither team has an unplayed game before this one (history must include their last game).
    const pending = upcoming.some(r => r.gid !== row.gid && r.day < row.day && [r.home, r.away].some(t => t === row.home || t === row.away));
    if (pending) return { status: 'WAIT', note: 'Reads start once both teams have played their previous game, the way the model was tested.' };
    let c = predCache.get(row.gid);
    if (!c) {
      // A completed game uses its pre-day features from the history walk; an upcoming one, today's team state.
      const f0 = state.featured.get(row.gid) || state.featuresFor(row);
      c = { f: f0, pred: E.predict(f0, MODEL) }; predCache.set(row.gid, c);
    }
    const f = c.f, pred = c.pred;
    // fairMargin (home minus away) and fairTotal feed the board's Model column. winHome is the fair moneyline's win
    // chance: fairMargin read as a fair spread, through the key-number margin distribution (winHome below).
    const out = { status: 'OK', model: MODEL.version, fairTotal: pred.total, fairMargin: pred.margin, sd: MODEL.keydist?.margin?.sd ?? null,
      winHome: winHome(pred.margin),
      spread: { status: MODEL.status_by_market?.spread || 'UNPROVEN' } };
    const started = G.state === 'in' || G.state === 'post' || Date.parse(G.start) <= now();
    if (!anchors[G.id] && !started && cur && Number.isFinite(cur.t) && Number.isFinite(cur.to?.[0]) && Number.isFinite(cur.to?.[1])) {
      anchors[G.id] = { at: new Date(now()).toISOString(), s: cur.s, so: cur.so, t: cur.t, to: cur.to }; saveAnchors();
    }
    const m = marketOf(anchors[G.id]);
    if (!m || !Number.isFinite(m.total)) { out.total = { tier: 'PASS', note: 'No total posted since both teams last played.' }; return out; }
    const sig = E.signal(f, pred, m, MODEL)?.total;
    if (!sig) return out;
    out.total = { tier: sig.tier, label: WORDS[sig.tier] || null, move: sig.move, direction: sig.side === 'over' ? 'up' : 'down', openTotal: m.total, fairOpen: sig.fair,
      expected: m.total + sig.move, currentTotal: cur?.t ?? null, anchoredAt: anchors[G.id].at };
    track(G, sig, m, cur);
    return out;
  }

  function track(G, sig, m, cur) {
    const key = G.id + ':total', started = G.state === 'in' || G.state === 'post' || Date.parse(G.start) <= now();
    if (started) { record.close(key); settle(G, key); return; }
    const over = sig.side === 'over', odds = over ? m.overPrice : m.underPrice;
    if (!Number.isFinite(odds)) return;
    const r = record.get(key);
    if (!r) {
      if (sig.tier !== 'PROVEN' && sig.tier !== 'LEAN') return;
      const p = sideProb(m.total, over, m.total, m.overPrice, m.underPrice, odds);
      record.observe(key, { tier: sig.tier, side: sig.side, market: 'total', line: m.total, entryOdds: odds, entryBook: null, sideProb: p, move: sig.move,
        matchup: `${G.away?.abbr} @ ${G.home?.abbr}`, start: G.start });
      return;
    }
    if (cur && Number.isFinite(cur.t)) {
      const p = sideProb(r.line, r.side === 'over', cur.t, cur.to?.[0], cur.to?.[1], r.entryOdds);
      if (p != null) record.mark(key, p);
    }
  }
  function settle(G, key) {
    const r = record.get(key);
    if (!r || G.state !== 'post' || !Number.isFinite(G.home?.score) || !Number.isFinite(G.away?.score)) return;
    const t = G.home.score + G.away.score;
    record.settle(key, t === r.line ? 'push' : (t > r.line) === (r.side === 'over') ? 'won' : 'lost');
  }

  // ESPN summary injuries -> Injury Matrix rows per side (display only)
  function injuries(G, inj) {
    if (!state || !MODEL || !Array.isArray(inj)) return null;
    const out = {};
    for (const side of ['home', 'away']) {
      const team = G[side]; const t = inj.find(x => String(x.team) === String(team?.id));
      if (!t) continue;
      try { out[side] = E.injuryMatrix(state, code(team.abbr), t.rows.map(r => ({ name: r.name, pos: r.pos, status: r.status })), MODEL).slice(0, 8); } catch { /* display only */ }
    }
    return out;
  }

  // Proof page / Edges evidence: the out-of-sample replication on the owner's openers, same row format as `proven`.
  function external() {
    const x = MODEL && MODEL.external_evidence; if (!x || !x.total) return null;
    const row = (v) => v && { bets: v.bets, clv_ev_pct: v.clv_ev_pct, p: v.bonf_p, raw_p: v.p, beat_close: v.beat_close, by_season: v.by_season, seasons_pos: v.seasons_pos };
    const rows = {}, add = (label, v) => { if (v) rows[label] = row(v); };
    for (const k of ['0.75', '1.0', '1.5']) add(`AusSB 2017-22 · total ≥ ${k} pts`, x.total.strict_2017_22 && x.total.strict_2017_22[k]);
    add('AusSB holdout 2019+2021 · total ≥ 1.0 pts', x.total.holdout_2019_2021 && x.total.holdout_2019_2021['1.0']);
    add('SBRO 2017-21 (at -110) · total ≥ 1.0 pts', x.total.sbro_2017_21 && x.total.sbro_2017_21['1.0']);
    return { what: x.what, source: x.source, caveats: x.caveats || [], rows };
  }

  return {
    // Model vs market vs result for this season's completed games: the model's fair margin/total (pre-day features),
    // the closing line (nflverse) and what happened. For the owner's proof page; nothing here is a pick.
    season: () => {
      if (!state || !MODEL) return { ready: false, rows: [] };
      const rows = [];
      for (const g of played) {
        if (!Number.isFinite(g.homeScore) || !Number.isFinite(g.awayScore)) continue;
        const f = state.featured.get(g.gid); if (!f) continue;
        const pred = E.predict(f, MODEL);
        rows.push({ gid: g.gid, week: g.week, day: g.day, home: g.home, away: g.away, fair: pred.margin, market: Number.isFinite(g.close) ? g.close : null,
          fairTotal: pred.total, marketTotal: Number.isFinite(g.closeTotal) ? g.closeTotal : null, result: g.homeScore - g.awayScore, total: g.homeScore + g.awayScore });
      }
      return { ready: true, unit: 'pts', rows };
    },
    refresh, forGame, injuries, summary: () => record.summary(),
    status: () => ({ model: MODEL && MODEL.version, builtAt, building, history: info, data: data.status(), lastError,
      // Proof page format: totals thresholds with Bonferroni-adjusted p (the research's own pass/fail bar)
      proven: MODEL && MODEL.holdout_report && MODEL.holdout_report.total ? Object.fromEntries(Object.entries(MODEL.holdout_report.total.thresholds).map(([k, v]) =>
        ['total ≥ ' + k + ' pts', { bets: v.bets, clv_ev_pct: v.clv_ev_pct, p: v.bonferroni_p, beat_close: v.beat_close,
          by_season: Object.fromEntries(Object.entries(v.by_season || {}).map(([s, x]) => [s, x.clv_ev_pct])) }])) : null,
      tiers: MODEL && MODEL.tiers, statusByMarket: MODEL && MODEL.status_by_market, external: external() }),
  };
}
module.exports = { create, code };
