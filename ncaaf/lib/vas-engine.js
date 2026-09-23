'use strict';
// NCAAF VAS engine: a line-for-line port of ncaaf/research/features.py + the portable model in portable.py.
//
// Input history (completed games involving an FBS team, any order; sorted internally by day, start, gid):
//   games: [{gid, season, start:'YYYY-MM-DDTHH:MMZ', neutral:0|1, conf_game:0|1, home_id, away_id, home_pts, away_pts,
//            home_fbs:0|1, away_fbs:0|1, home_qb, away_qb (athlete id with the most pass attempts, 0 if unknown),
//            close (consensus closing HOME spread, null if unknown),
//            home_epa, home_repa, home_pepa, home_fdr, home_expl, home_ypp, home_st, home_plays (and away_*): per-game
//            offensive stats, null when missing}]
//   Source of the per-game stats: sportsdataverse espn_cfb_adv_team_gamelog CSV (see research/README.md).
// build(history, cfg) walks the history day by day (state strictly before each day) and returns
//   featuresFor(game) -> open-safe features for an upcoming game (projected QB = last game's starter)
//   featured          -> Map gid -> features computed during the walk (parity checks)
// predict(features, model)                  -> stage-1 predicted home margin (points)
// signal(features, stage1Margin, market, model, variant) -> stage-2 predicted CLV (points) and tier
// No network, no clock: callers pass everything in. Pure and deterministic, so parity with Python is testable.

const STATS = ['pts', 'epa', 'repa', 'pepa', 'fdr', 'expl', 'ypp', 'st', 'plays'];
const DAY = 86400000;
const days = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY);
const ok = (x) => x !== null && x !== undefined && Number.isFinite(x);
const dayOf = (start) => String(start).slice(0, 10);

function build(history, cfg) {
  const C = cfg;
  const dec = Math.pow(0.5, 1 / C.hl);
  const S = new Map(), league = new Map(), seasonOf = new Map(), lastDay = new Map(), fbsOf = new Map();
  const M = new Map(), qbLast = new Map(), QB = new Map();
  const st = (t) => { let s = S.get(t); if (!s) { s = {}; S.set(t, s); } return s; };
  const mean = (key) => { const v = league.get(key); return v && v[1] > 0 ? v[0] / v[1] : 0; };
  const lg = (key) => { let v = league.get(key); if (!v) { v = [0, 0]; league.set(key, v); } return v; };

  function rating(t, side, k) {
    const s = st(t); const div = (fbsOf.has(t) ? fbsOf.get(t) : 1) ? 'fbs' : 'fcs';
    const prior = mean(div + ':' + side + '_' + k);
    return ((s[side + '_' + k] || 0) + C.k_shrink * prior) / ((s[side + 'w_' + k] || 0) + C.k_shrink);
  }
  function carry(t, season) {
    if (seasonOf.has(t) && seasonOf.get(t) !== season) {
      const s = st(t); for (const key of Object.keys(s)) s[key] = s[key] * C.carry;
      if (M.has(t)) M.set(t, M.get(t) * C.carry_m);
      seasonOf.set(t, season);
    }
  }
  function side(t, season, day, fbs) {
    fbsOf.set(t, fbs);
    carry(t, season);
    const r = {};
    for (const k of STATS) { r['o_' + k] = rating(t, 'o', k); r['d_' + k] = rating(t, 'd', k); }
    const s = st(t);
    r.n = s.ow_pts || 0;
    r.rest = lastDay.has(t) ? Math.min(days(day, lastDay.get(t)), C.rest_cap) : C.rest_cap;
    r.mkt = M.has(t) ? M.get(t) : (fbs ? 0 : C.fcs_m);
    const q = qbLast.get(t) || 0;
    const qs = q ? (QB.get(t + ':' + q) || [0, 0]) : [0, 0];
    const prior = mean('all:qb_pepa');
    r.qb_starts = Math.log1p(qs[0]);
    r.qb_pepa = (qs[1] + C.k_qb * prior) / (qs[0] + C.k_qb);
    r.qb = q;
    return r;
  }
  // research-only: an arbitrary (e.g. the confirmed) starter's history for this team
  function qbFeats(t, q) {
    const qs = q ? (QB.get(t + ':' + q) || [0, 0]) : [0, 0];
    return [Math.log1p(qs[0]), (qs[1] + C.k_qb * mean('all:qb_pepa')) / (qs[0] + C.k_qb)];
  }
  function updateDay(games) {
    const adj = [];
    for (const g of games) {
      for (const [sd, other] of [['home', 'away'], ['away', 'home']]) {
        const t = g[sd + '_id'], o = g[other + '_id'];
        const obs = [];
        for (const k of STATS) {
          const x = k === 'pts' ? g[sd + '_pts'] : g[sd + '_' + k];
          const y = k === 'pts' ? g[other + '_pts'] : g[other + '_' + k];
          const mu = mean('all:o_' + k);
          if (ok(x)) obs.push(['o', k, x, x - (rating(o, 'd', k) - mu)]);
          if (ok(y)) obs.push(['d', k, y, y - (rating(o, 'o', k) - mu)]);
        }
        adj.push([t, obs, g, sd]);
      }
    }
    for (const [t, obs, g, sd] of adj) {
      const s = st(t); const div = g[sd + '_fbs'] ? 'fbs' : 'fcs';
      for (const [side, k, raw, a] of obs) {
        const key = side + '_' + k;
        s[key] = (s[key] || 0) * dec + a;
        s[side + 'w_' + k] = (s[side + 'w_' + k] || 0) * dec + 1;
        for (const lk of [div + ':' + key, 'all:' + key]) { const v = lg(lk); v[0] += raw; v[1] += 1; }
      }
    }
    for (const g of games) {
      const d = dayOf(g.start);
      for (const sd of ['home', 'away']) {
        const t = g[sd + '_id'];
        seasonOf.set(t, g.season); lastDay.set(t, d); fbsOf.set(t, g[sd + '_fbs']);
        const q = g[sd + '_qb'] || 0;
        if (q) {
          qbLast.set(t, q);
          const pe = g[sd + '_pepa'];
          let e = QB.get(t + ':' + q); if (!e) { e = [0, 0]; QB.set(t + ':' + q, e); }
          if (ok(pe)) { e[0] += 1; e[1] += pe; const v = lg('all:qb_pepa'); v[0] += pe; v[1] += 1; }
        }
      }
      const c = g.close;
      if (ok(c)) {
        const h = g.home_id, a = g.away_id;
        const mh = M.has(h) ? M.get(h) : (g.home_fbs ? 0 : C.fcs_m), ma = M.has(a) ? M.get(a) : (g.away_fbs ? 0 : C.fcs_m);
        const err = -c - (mh - ma + C.hfa_m * (1 - g.neutral));
        M.set(h, mh + C.lr_m * err); M.set(a, ma - C.lr_m * err);
      }
    }
  }

  const byDay = new Map();
  for (const g of history.games) { const d = dayOf(g.start); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(g); }
  const featured = new Map();
  for (const d of [...byDay.keys()].sort()) {
    const dg = byDay.get(d).slice().sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.gid - y.gid));
    for (const g of dg) {
      const h = side(g.home_id, g.season, d, g.home_fbs), a = side(g.away_id, g.season, d, g.away_fbs);
      featured.set(g.gid, { ...combine(h, a, g), _home: h, _away: a });
    }
    updateDay(dg);
  }
  return {
    featured,
    // game: {season, start|day, neutral, conf_game, home_id, away_id, home_fbs, away_fbs}; opts.late = {homeQb, awayQb}
    featuresFor(g, opts = {}) {
      const d = g.day || dayOf(g.start);
      const h = side(g.home_id, g.season, d, g.home_fbs), a = side(g.away_id, g.season, d, g.away_fbs);
      const f = { ...combine(h, a, g), _home: h, _away: a };
      if (opts.late) {
        const hq = opts.late.homeQb || h.qb, aq = opts.late.awayQb || a.qb;
        const [hs, hp] = qbFeats(g.home_id, hq), [as, ap] = qbFeats(g.away_id, aq);
        f.L_d_qb_starts = hs - as; f.L_d_qb_pepa = hp - ap;
        f.L_home_qb_change = h.qb && hq !== h.qb ? 1 : 0; f.L_away_qb_change = a.qb && aq !== a.qb ? 1 : 0;
      }
      return f;
    },
    marketRating: (t) => M.get(t),
  };
}

function combine(h, a, g) {
  const f = {};
  for (const k of STATS) { f['d_o_' + k] = h['o_' + k] - a['o_' + k]; f['d_d_' + k] = h['d_' + k] - a['d_' + k]; }
  f.t_pts = h.o_pts + a.d_pts + a.o_pts + h.d_pts;
  f.t_plays = h.o_plays + a.d_plays + a.o_plays + h.d_plays;
  f.d_mkt = h.mkt - a.mkt;
  f.d_rest = h.rest - a.rest;
  f.min_n = Math.min(h.n, a.n);
  f.d_qb_starts = h.qb_starts - a.qb_starts; f.d_qb_pepa = h.qb_pepa - a.qb_pepa;
  f.neutral = g.neutral; f.conf_game = g.conf_game; f.home_fbs = g.home_fbs; f.away_fbs = g.away_fbs;
  return f;
}

// Preseason + calendar context (model.preseason is exported for the current season by portable.py).
// ctx: {week, seasonType (2 regular, 3 post), homeP5, awayP5}
function withContext(f, g, ctx, model) {
  const P = model.preseason;
  const tz = (id, fbs) => (fbs && P.talent_z[String(id)] != null ? P.talent_z[String(id)] : P.non_fbs_talent_z);
  const ro = (id) => (P.ret_off[String(id)] != null ? P.ret_off[String(id)] : P.ret_missing);
  const rd = (id) => (P.ret_def[String(id)] != null ? P.ret_def[String(id)] : P.ret_missing);
  const x = { ...f };
  x.home = 1 - g.neutral;
  x.early = ctx.seasonType === 2 && ctx.week <= 4 ? 1 : 0;
  x.d_talent = tz(g.home_id, g.home_fbs) - tz(g.away_id, g.away_fbs);
  x.talent_early = x.d_talent * x.early;
  x.d_ret_off = ro(g.home_id) - ro(g.away_id); x.d_ret_def = rd(g.home_id) - rd(g.away_id);
  x.tier_fcs = g.home_fbs && g.away_fbs ? 0 : 1;
  x.tier_g5 = !x.tier_fcs && !ctx.homeP5 && !ctx.awayP5 ? 1 : 0;
  return x;
}

function linear(stage, f) {
  let z = stage.intercept;
  stage.features.forEach((name, i) => { const v = Number.isFinite(f[name]) ? f[name] : stage.mean[i]; z += stage.coef[i] * (v - stage.mean[i]) / stage.std[i]; });
  return z;
}
const predict = (f, model) => linear(model.stage1, f);            // predicted home margin, points
const predictTotal = (f, model) => linear(model.totals.stage1, f); // predicted total points

// market: {open: bet book OPEN home spread, openCons?: median open across books, total?: open total, totalCons?}
// variant: 'A' (open-safe, default) | 'B' (needs openCons) | 'C' (needs features from featuresFor(g, {late}))
function signal(f, margin, market, model, variant = 'A') {
  if (!market || !Number.isFinite(market.open)) return null;
  if (variant === 'B' && !Number.isFinite(market.openCons)) return null;
  const x = { ...f, x_gap: margin + market.open, x_open: market.open, x_open_abs: Math.abs(market.open),
    x_open_vs_cons: Number.isFinite(market.openCons) ? market.open - market.openCons : 0 };
  const clv = linear(model.stage2[variant], x);
  const t = model.tiers.spread[variant];
  const size = Math.abs(clv);
  const tier = t.proven && size >= t.diamond ? 'DIAMOND' : size >= t.lean ? 'LEAN' : 'PASS';
  return { clv, side: clv > 0 ? 'home' : 'away', tier, proven: !!t.proven, gap: x.x_gap };
}
function totalSignal(f, total, market, model, variant = 'A') {
  if (!market || !Number.isFinite(market.total)) return null;
  const x = { ...f, x_open_abs: Number.isFinite(market.open) ? Math.abs(market.open) : undefined, tx_gap: total - market.total, tx_open: market.total,
    tx_open_vs_cons: Number.isFinite(market.totalCons) ? market.total - market.totalCons : 0 };
  if (variant === 'B' && !Number.isFinite(market.totalCons)) return null;
  const clv = linear(model.totals.stage2[variant], x);
  const t = model.tiers.totals[variant];
  const size = Math.abs(clv);
  const tier = t.proven && size >= t.diamond ? 'DIAMOND' : size >= t.lean ? 'LEAN' : 'PASS';
  return { clv, side: clv > 0 ? 'over' : 'under', tier, proven: !!t.proven, gap: x.tx_gap };
}

module.exports = { build, combine, withContext, predict, predictTotal, signal, totalSignal, linear, STATS };
