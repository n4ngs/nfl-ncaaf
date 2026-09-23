'use strict';
// NHL VAS engine: a line-for-line port of nhl/research/portable.py (open-safe, portable model).
//
// Input history (all completed regular-season games, oldest first):
//   games:  [{gid, season, day:'YYYY-MM-DD', home, away, homeGoals, awayGoals,
//             lineups:{home:[{pid,pos:'F'|'D',toi,a}], away:[...]}}]
//   shots:  [{gid, home:bool (shooting team is home), xg, goal:0|1, hs, as (skaters home/away), en:bool, goalie, shooter}]
// build() walks the history day by day (state strictly before each day) and returns an object that can
//   featuresFor(upcoming game) -> open-safe features (projected starters, team, goalie, lineup, schedule)
//   predict(features, model)   -> stage-1 home win probability
//   signal(features, pFund, market, model) -> stage-2 predicted line move and VAS tier
// No network, no clock: callers pass everything in. Pure and deterministic, so parity with Python is testable.

const TEAM_KEYS = ['ev_xgf', 'ev_xga', 'hd_xgf', 'hd_xga', 'pp_xgf', 'pk_xga', 'gf', 'ga', 'win'];
const DAY = 86400000;
const days = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY);
const logit = p => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };

// Python's max(reversed(rec), key=rec.count): most frequent, ties resolved toward the most recent entry.
function mostRecentMode(list) {
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null, bestN = -1;
  for (let i = list.length - 1; i >= 0; i--) { const n = counts.get(list[i]); if (n > bestN) { best = list[i]; bestN = n; } }
  return best;
}

function build(history, cfg) {
  const C = cfg;
  const dTeam = Math.pow(0.5, 1 / C.hl_team), dPl = Math.pow(0.5, 1 / C.hl_player);
  const T = new Map(), league = {}, seasonOf = new Map(), lastGame = new Map();
  const G = new Map(), lastStart = new Map(), starts = new Map(), PL = new Map(), POS = new Map(), lastLineup = new Map();
  const names = new Map();
  const team = t => { if (!T.has(t)) T.set(t, {}); return T.get(t); };
  const startsOf = t => { if (!starts.has(t)) starts.set(t, []); return starts.get(t); };

  // per game aggregates from shots
  const agg = new Map(), gst = new Map(), faced = new Map(), ixg = new Map();
  const A = (gid, side) => { const k = gid + ':' + side; if (!agg.has(k)) agg.set(k, {}); return agg.get(k); };
  const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
  for (const s of history.shots) {
    const side = s.home ? 'home' : 'away', other = s.home ? 'away' : 'home';
    const own = s.home ? s.hs : s.as, opp = s.home ? s.as : s.hs;
    if (!s.en) {
      const a = A(s.gid, side), b = A(s.gid, other);
      if (own === 5 && opp === 5) { add(a, 'ev_xgf', s.xg); add(b, 'ev_xga', s.xg); if (s.xg >= C.hd) { add(a, 'hd_xgf', s.xg); add(b, 'hd_xga', s.xg); } }
      if (own > opp) { add(a, 'pp_xgf', s.xg); add(b, 'pk_xga', s.xg); }
      if (s.shooter) { const k = s.gid + ':' + s.shooter; ixg.set(k, (ixg.get(k) || 0) + s.xg); }
      if (s.goalie > 0) {
        const k = s.gid + ':' + s.goalie; const g = gst.get(k) || { gid: s.gid, goalie: s.goalie, xg: 0, ga: 0, n: 0 };
        g.xg += s.xg; g.ga += s.goal; g.n += 1; gst.set(k, g);
        const f = s.gid + ':' + other; const m = faced.get(f) || new Map(); m.set(s.goalie, (m.get(s.goalie) || 0) + 1); faced.set(f, m);
      }
    }
  }
  const starterOf = (gid, side) => {
    const m = faced.get(gid + ':' + side); if (!m) return null;
    let best = null, n = -1; for (const [g, c] of m) if (c > n || (c === n && g > best)) { best = g; n = c; }   // pandas sort+last ≈ max count
    return best;
  };
  const gstByGame = new Map();
  for (const g of gst.values()) { if (!gstByGame.has(g.gid)) gstByGame.set(g.gid, []); gstByGame.get(g.gid).push(g); }

  function teamFeats(t) {
    const s = team(t), n = s.n || 0, out = {};
    for (const k of TEAM_KEYS) {
      const prior = league.n ? (league[k] || 0) / league.n : 0;
      out[k] = ((s[k] || 0) + C.k_team * prior) / (n + C.k_team);
    }
    return out;
  }
  function goalieFeats(gk, t, day) {
    const [s, x] = G.get(gk) || [0, 0];
    const rec = startsOf(t).slice(-20);
    const rest = lastStart.has(gk) ? Math.min(days(day, lastStart.get(gk)), 10) : 10;
    return { gsax100: x / (s + C.k_goalie) * 100, logshots: Math.log1p(s), share20: rec.length ? rec.filter(v => v === gk).length / rec.length : 0.5, gb2b: rest === 1 ? 1 : 0 };
  }
  function project(t, day) {
    const all = startsOf(t), rec = all.slice(-10);
    if (!rec.length) return [null, 0];
    let p = mostRecentMode(rec);
    if (lastStart.has(p) && days(day, lastStart.get(p)) === 1) {
      const others = all.slice(-30).filter(x => x !== p);
      if (others.length) p = mostRecentMode(others);
    }
    return [p, rec.filter(v => v === p).length / rec.length];
  }
  function pvalue(pid) {
    const [toi, a, x, n] = PL.get(pid) || [0, 0, 0, 0]; const pos = POS.get(pid) || 'F';
    const prior = pos === 'F' ? C.prior_f : C.prior_d;
    const v60 = (x + C.assist_w * a + prior * C.k_player_toi / 60) / (toi + C.k_player_toi) * 60;
    const etoi = n > 0.5 ? toi / n : (pos === 'F' ? 15 : 19);
    return v60 * etoi / 60;
  }
  function sideFeats(t, season, day) {
    const r = {};
    if (seasonOf.has(t) && seasonOf.get(t) !== season) { const s = team(t); for (const k of Object.keys(s)) s[k] *= C.carry; seasonOf.set(t, season); }
    Object.assign(r, teamFeats(t));
    const [p, share10] = project(t, day);
    Object.assign(r, p ? goalieFeats(p, t, day) : { gsax100: 0, logshots: 0, share20: 0, gb2b: 0 });
    r.share10 = share10; r.proj = p; r.projName = p ? names.get(p) || null : null;
    const rest = lastGame.has(t) ? Math.min(days(day, lastGame.get(t)), 5) : 5;
    r.rest = rest; r.b2b = rest === 1 ? 1 : 0;
    const pl = lastLineup.get(t); r.lineup = pl && pl.length ? pl.reduce((s, x) => s + pvalue(x), 0) : null;
    return r;
  }
  // The Python walk applies the season carry-over inside feature computation (once per team per new season).
  // Mirror that exactly: carry-over happens the first time a team is featured in a new season.
  function combine(h, a) {
    const f = {};
    for (const k of [...TEAM_KEYS, 'gsax100', 'logshots']) f['d_' + k] = h[k] - a[k];
    f.d_lineup = h.lineup != null && a.lineup != null ? h.lineup - a.lineup : 0;
    f.d_rest = h.rest - a.rest; f.home_b2b = h.b2b; f.away_b2b = a.b2b;
    f.home_share20 = h.share20; f.away_share20 = a.share20; f.home_share10 = h.share10; f.away_share10 = a.share10;
    f.home_gb2b = h.gb2b; f.away_gb2b = a.gb2b;
    return f;
  }

  const byDay = new Map();
  for (const g of history.games) { if (!byDay.has(g.day)) byDay.set(g.day, []); byDay.get(g.day).push(g); }
  const featured = new Map();   // gid -> features computed with pre-day state (for parity checks)
  for (const day of [...byDay.keys()].sort()) {
    const dg = byDay.get(day).slice().sort((x, y) => (x.start || '').localeCompare(y.start || '') || x.gid - y.gid);
    for (const g of dg) {
      const h = sideFeats(g.home, g.season, day), a = sideFeats(g.away, g.season, day);
      featured.set(g.gid, { ...combine(h, a), _home: h, _away: a });
    }
    for (const g of dg) {
      for (const [side, other] of [['home', 'away'], ['away', 'home']]) {
        const t = g[side]; seasonOf.set(t, g.season); lastGame.set(t, day);
        const a = agg.get(g.gid + ':' + side) || {};
        const obs = { ev_xgf: a.ev_xgf || 0, ev_xga: a.ev_xga || 0, hd_xgf: a.hd_xgf || 0, hd_xga: a.hd_xga || 0, pp_xgf: a.pp_xgf || 0, pk_xga: a.pk_xga || 0 };
        obs.gf = g[side + 'Goals']; obs.ga = g[other + 'Goals']; obs.win = obs.gf > obs.ga ? 1 : 0; obs.n = 1;
        const s = team(t);
        for (const [k, v] of Object.entries(obs)) { s[k] = (s[k] || 0) * dTeam + v; league[k] = (league[k] || 0) + v; }
        const L = g.lineups && g.lineups[side];
        if (L && L.length) {
          lastLineup.set(t, L.map(x => x.pid));
          for (const x of L) {
            POS.set(x.pid, x.pos); const q = PL.get(x.pid) || [0, 0, 0, 0];
            q[0] = q[0] * dPl + x.toi; q[1] = q[1] * dPl + x.a; q[2] = q[2] * dPl + (ixg.get(g.gid + ':' + x.pid) || 0); q[3] = q[3] * dPl + 1;
            PL.set(x.pid, q);
          }
        }
        const st = starterOf(g.gid, side);
        if (st) { startsOf(t).push(st); lastStart.set(st, day); }
        for (const [id, nm] of Object.entries((g.goalieNames && g.goalieNames[side]) || {})) names.set(Number(id), nm);
      }
      for (const x of gstByGame.get(g.gid) || []) {
        const d = Math.pow(0.5, x.n / C.hl_goalie_shots); const s = G.get(x.goalie) || [0, 0];
        G.set(x.goalie, [s[0] * d + x.n, s[1] * d + (x.xg - x.ga)]);
      }
    }
  }

  // Games finished after MoneyPuck's last nightly file: they only move the schedule clocks (rest, back-to-backs,
  // recent starts), never the shot-based ratings, so a same-day refresh cannot mis-state who played last night.
  for (const g of (history.tail || []).slice().sort((x, y) => x.day.localeCompare(y.day))) {
    for (const side of ['home', 'away']) {
      const t = g[side]; if (!lastGame.has(t) || lastGame.get(t) < g.day) lastGame.set(t, g.day);
      const st = g.starters && g.starters[side];
      if (st) { startsOf(t).push(st); lastStart.set(st, g.day); }
      for (const [id, nm] of Object.entries((g.goalieNames && g.goalieNames[side]) || {})) names.set(Number(id), nm);
    }
  }

  return {
    featured,
    // Features for a future game from the state after all history. Does not mutate state beyond the same
    // season carry-over the walk would apply on that team's first game of a new season.
    featuresFor(g) {
      const h = sideFeats(g.home, g.season, g.day), a = sideFeats(g.away, g.season, g.day);
      return { ...combine(h, a), _home: h, _away: a };
    },
    goalie(id) { const [s, x] = G.get(id) || [0, 0]; return { id, name: names.get(id) || null, shots: s, gsax100: x / (s + C.k_goalie) * 100 }; },
  };
}

function linear(stage, f) {
  let z = stage.intercept;
  stage.features.forEach((name, i) => { const v = Number.isFinite(f[name]) ? f[name] : stage.mean[i]; z += stage.coef[i] * (v - stage.mean[i]) / stage.std[i]; });
  return z;
}
const predict = (f, model) => 1 / (1 + Math.exp(-linear(model.stage1, f)));

// market: {prob: no-vig home probability} ; returns predicted move toward home (logit units) and tier.
function signal(f, pFund, market, model) {
  if (!market || !Number.isFinite(market.prob)) return null;
  const x = { ...f, x_gap: logit(pFund) - logit(market.prob), x_open: logit(market.prob) };
  const move = linear(model.stage2, x);
  const side = move > 0 ? 'home' : 'away', size = Math.abs(move);
  const tier = size >= model.tiers.diamond ? 'DIAMOND' : size >= model.tiers.gold ? 'GOLD' : 'PASS';
  return { move, side, tier, gap: x.x_gap };
}

module.exports = { build, predict, signal, logit, mostRecentMode, TEAM_KEYS };
