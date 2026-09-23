'use strict';
// MLB VAS engine: a line-for-line port of mlb/research/portable.py (walk-forward features) plus the linear
// stage-1 / stage-2 model exported to mlb/research/data/cache/mlb-vas-model.json.
//
// History input (completed regular-season games; the engine sorts by day, scheduled start, gamePk):
//   games: [{pk, season, day:'YYYY-MM-DD' (officialDate), start:ISO UTC, venue, dn:'day'|'night', home, away (team ids),
//            hs, as (runs), prob:{home, away} (probable pitcher ids), hp (home-plate umpire id), wx:{temp, out, roof},
//            box:{home:{bat:[{id,bo,pa,ab,h,d,t,hr,bb,ibb,hbp,so,sf}], pit:[{id,outs,bf,k,bb,ibb,hbp,hr,np}]}, away:{...}}}]
//            (box = compactBox(statsapi /game/{pk}/boxscore))
//   hands: {pitcherId: 'L'|'R'}  (statsapi /people?personIds=... pitchHand.code)
// build() returns
//   featured             Map pk -> features computed with the pre-day state (parity checks)
//   featuresFor(game)    open-safe features for an upcoming game ({season, day, venue, dn, home, away, prob, hp?, wx?,
//                        lineups?:{home:[ids], away:[ids]} confirmed nine, starters?:{home, away}} actual starters)
// predict / predictTotal / signal / totalSignal: linear model math. No network, no clock, deterministic.

const DEFAULT_CFG = {
  hl_team: 40, carry: 0.5, k_pa: 300, k_g: 15, hl_league: 4000, hl_pit_bf: 700, k_sp: 250, hl_starts: 10,
  k_starts: 3, k_bp: 200, hl_bat_pa: 500, k_bat: 150, hl_park: 400, k_park: 100, hl_ump: 300, k_ump: 60, rest_cap: 3, sp_rest_cap: 10,
};
const LEAGUE0 = { n: 10.0, rf: 45.0, wn: 0.315 * 380, wd: 380.0, bpn: 0.22 * 120, bpb: 120.0, spn: 0.20 * 250, spb: 250.0, spk: 0.22 * 250, spo: 160.0, sps: 10.0 };
const TK = ['n', 'rf', 'ra', 'w', 'wn', 'wd', 'wnL', 'wdL', 'wnR', 'wdR', 'bpn', 'bpb'];
const SIDE_KEYS = ['off', 'offh', 'rf', 'ra', 'win', 'bp', 'sp_fip', 'sp_k', 'sp_ip', 'sp_lbf', 'lu_exp', 'rest'];
const EXTRA_KEYS = ['sp_rest', 'sp_np', 'lu_conf', 'lu_delta', 'spc_fip', 'bp_np1', 'bp_np3', 'sp_chg', 'dan'];

const ordinal = day => Math.round(Date.parse(day + 'T00:00:00Z') / 86400000);
const logit = p => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
function woba(b) {
  return [0.69 * (b.bb - b.ibb) + 0.72 * b.hbp + 0.88 * (b.h - b.d - b.t - b.hr) + 1.25 * b.d + 1.59 * b.t + 2.05 * b.hr,
    b.ab + b.bb - b.ibb + b.sf + b.hbp];
}
const fipn = p => 13.0 * p.hr + 3.0 * (p.bb - p.ibb + p.hbp) - 2.0 * p.k;
function starters9(bat) {
  const s = (bat || []).filter(b => b.bo && String(b.bo).endsWith('00'));
  return s.map((b, i) => [b, i]).sort((x, y) => (x[0].bo < y[0].bo ? -1 : x[0].bo > y[0].bo ? 1 : x[1] - y[1])).map(x => x[0].id);
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// statsapi boxscore JSON -> compact per-game lines (same fields as research/fetch_statsapi.py)
function compactBox(b) {
  const N = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const outsOf = ip => { const m = /^(\d+)\.(\d)$/.exec(String(ip || '')); return m ? Number(m[1]) * 3 + Number(m[2]) : 0; };
  const out = {};
  for (const side of ['home', 'away']) {
    const t = b.teams[side], P = t.players || {};
    const bat = [], pit = [];
    for (const pid of t.batters || []) {
      const p = P['ID' + pid] || {}, s = (p.stats || {}).batting || {};
      if (!Object.keys(s).length) continue;
      bat.push({ id: pid, bo: p.battingOrder || null, pa: N(s.plateAppearances), ab: N(s.atBats), h: N(s.hits), d: N(s.doubles), t: N(s.triples),
        hr: N(s.homeRuns), bb: N(s.baseOnBalls), ibb: N(s.intentionalWalks), hbp: N(s.hitByPitch), so: N(s.strikeOuts), sf: N(s.sacFlies) });
    }
    for (const pid of t.pitchers || []) {
      const p = P['ID' + pid] || {}, s = (p.stats || {}).pitching || {};
      pit.push({ id: pid, outs: N(s.outs) || outsOf(s.inningsPitched), bf: N(s.battersFaced), k: N(s.strikeOuts), bb: N(s.baseOnBalls), ibb: N(s.intentionalWalks),
        hbp: N(s.hitBatsmen), hr: N(s.homeRuns), np: N(s.numberOfPitches || s.pitchesThrown) });
    }
    out[side] = { bat, pit };
  }
  return out;
}
// boxscore info 'Weather' / 'Wind' strings (or feed gameData.weather {temp, condition, wind}) -> {temp, out, roof}
function parseWeather(weather, wind) {
  const w = String(weather || ''), wd = String(wind || '');
  let m = /^\s*(-?\d+)\s*degrees/.exec(w); const temp = m ? Number(m[1]) : null;
  const roof = /Roof Closed|Dome/i.test(w) ? 1 : 0;
  m = /^\s*(\d+)\s*mph,?\s*(.*?)\.?\s*$/.exec(wd); const spd = m ? Number(m[1]) : 0; const dir = (m ? m[2] : '').trim().toLowerCase();
  const sign = dir.startsWith('out') ? 1 : dir.startsWith('in') ? -1 : 0;
  return { temp, out: roof ? 0 : sign * spd, roof };
}

function build(history, cfg) {
  const C = { ...DEFAULT_CFG, ...(cfg || {}) };
  const hands = history.hands || {};
  const hand = pid => (pid != null ? hands[pid] : undefined);
  const dTeam = Math.pow(0.5, 1 / C.hl_team), dLg = Math.pow(0.5, 1 / C.hl_league), dSt = Math.pow(0.5, 1 / C.hl_starts);
  const dPark = Math.pow(0.5, 1 / C.hl_park), dUmp = Math.pow(0.5, 1 / C.hl_ump);
  const L = { ...LEAGUE0 }, T = new Map(), P = new Map(), B = new Map(), V = new Map(), U = new Map();
  const seasonOf = new Map(), lastGame = new Map(), lastLineup = new Map(), relief = new Map();
  const team = t => { if (!T.has(t)) { const o = {}; for (const k of TK) o[k] = 0.0; T.set(t, o); } return T.get(t); };
  const bval = (pid, lgw) => { const b = B.get(pid); return b ? (b[0] + C.k_bat * lgw) / (b[1] + C.k_bat) : lgw; };
  const lineupValue = (ids, lgw) => { if (!ids || !ids.length) return lgw; let s = 0; for (const x of ids) s += bval(x, lgw); return s / ids.length; };
  function spFeats(pid, dayO, lg) {
    const p = pid ? P.get(pid) : undefined;
    if (!p) return { sp_fip: lg.sp, sp_k: lg.spk, sp_ip: lg.ip, sp_lbf: 0.0, sp_rest: C.sp_rest_cap, sp_np: 0.0, sp_L: pid && hand(pid) === 'L' ? 1.0 : 0.0 };
    return { sp_fip: (p.fn + C.k_sp * lg.sp) / (p.bf + C.k_sp), sp_k: (p.k + C.k_sp * lg.spk) / (p.bf + C.k_sp),
      sp_ip: (p.so + C.k_starts * lg.ip) / (p.ns + C.k_starts), sp_lbf: Math.log1p(p.bf),
      sp_rest: Math.min(dayO - p.last, C.sp_rest_cap), sp_np: p.np, sp_L: hand(pid) === 'L' ? 1.0 : 0.0 };
  }
  function lgNow() {
    return { woba: L.wn / L.wd, rpg: L.rf / L.n, bp: L.bpn / L.bpb, sp: L.spn / L.spb, spk: L.spk / L.spb, ip: L.spo / L.sps };
  }
  // late = {nine: [ids] | null, act: pitcher id | null}
  function sideFeats(g, side, dayO, lg, late) {
    const t = g[side], other = side === 'home' ? 'away' : 'home';
    if (seasonOf.has(t) && seasonOf.get(t) !== g.season) { const s = team(t); for (const k of TK) s[k] *= C.carry; seasonOf.set(t, g.season); }
    const s = team(t), r = {};
    const off = (s.wn + C.k_pa * lg.woba) / (s.wd + C.k_pa);
    const oppProb = g.prob && g.prob[other]; const oh = oppProb ? hand(oppProb) : undefined;
    r.off = off;
    r.offh = oh === 'L' || oh === 'R' ? (s['wn' + oh] + C.k_pa * off) / (s['wd' + oh] + C.k_pa) : off;
    r.rf = (s.rf + C.k_g * lg.rpg) / (s.n + C.k_g); r.ra = (s.ra + C.k_g * lg.rpg) / (s.n + C.k_g);
    r.win = (s.w + C.k_g * 0.5) / (s.n + C.k_g);
    r.bp = (s.bpn + C.k_bp * lg.bp) / (s.bpb + C.k_bp);
    Object.assign(r, spFeats(g.prob ? g.prob[side] : null, dayO, lg));
    r.lu_exp = lineupValue(lastLineup.get(t), lg.woba);
    const lg_ = lastGame.get(t);
    r.rest = lg_ ? Math.min(dayO - lg_[0], C.rest_cap) : C.rest_cap;
    r.night = g.dn === 'night' ? 1.0 : 0.0;
    r.dan = lg_ && dayO - lg_[0] === 1 && lg_[1] === 'night' && g.dn === 'day' ? 1.0 : 0.0;
    if (late && late.nine) { r.lu_conf = lineupValue(late.nine, lg.woba); r.lu_delta = r.lu_conf - r.lu_exp; } else { r.lu_conf = null; r.lu_delta = null; }
    if (late && late.act != null) { r.sp_chg = late.act !== (g.prob ? g.prob[side] : null) ? 1.0 : 0.0; r.spc_fip = spFeats(late.act, dayO, lg).sp_fip; } else { r.sp_chg = null; r.spc_fip = null; }
    const rl = relief.get(t) || [];
    let n1 = 0, n3 = 0; for (const [d, n] of rl) { if (dayO - d === 1) n1 += n; if (dayO - d >= 1 && dayO - d <= 3) n3 += n; }
    r.bp_np1 = n1; r.bp_np3 = n3;
    return r;
  }
  function gameFeats(g, lg) {
    const r = {};
    const lgT = 2.0 * lg.rpg; const v = V.get(g.venue);
    r.park = v ? ((v[1] + C.k_park * lgT) / (v[0] + C.k_park)) / lgT : 1.0;
    const u = g.hp ? U.get(g.hp) : undefined;
    r.ump = u ? u[1] / (u[0] + C.k_ump) : 0.0;
    const w = g.wx || {};
    r.wx_temp = w.temp != null ? w.temp : 72.0; r.wx_out = w.out != null ? w.out : 0.0; r.wx_roof = w.roof ? 1.0 : 0.0;
    r.lg_rpg = lg.rpg; r.lg_woba = lg.woba;
    return r;
  }
  function flat(h, a, gf) {
    const f = { ...gf };
    for (const [k, v] of Object.entries(h)) f['home_' + k] = v;
    for (const [k, v] of Object.entries(a)) f['away_' + k] = v;
    for (const k of [...SIDE_KEYS, ...EXTRA_KEYS]) {
      const x = h[k], y = a[k];
      f['d_' + k] = x != null && y != null ? x - y : null; f['s_' + k] = x != null && y != null ? x + y : null;
    }
    f.night = h.night;
    f.park_x = (f.park - 1) * f.lg_rpg * 2;
    f.s_sp_lbf = h.sp_lbf + a.sp_lbf;
    return f;
  }

  const games = history.games.slice().sort((x, y) => cmpStr(x.day, y.day) || cmpStr(x.start || '', y.start || '') || x.pk - y.pk);
  const featured = new Map();
  let i = 0;
  while (i < games.length) {
    const day = games[i].day; let j = i;
    while (j < games.length && games[j].day === day) j++;
    const dg = games.slice(i, j); i = j; const dayO = ordinal(day);
    const lg = lgNow();
    for (const g of dg) {
      const lh = { nine: starters9(g.box.home.bat), act: g.box.home.pit[0].id }, la = { nine: starters9(g.box.away.bat), act: g.box.away.pit[0].id };
      const h = sideFeats(g, 'home', dayO, lg, lh), a = sideFeats(g, 'away', dayO, lg, la);
      featured.set(g.pk, { _home: h, _away: a, ...gameFeats(g, lg) });
    }
    for (const g of dg) {
      const runs = { home: g.hs, away: g.as }; const lgT = 2.0 * L.rf / L.n;
      for (const [side, other] of [['home', 'away'], ['away', 'home']]) {
        const t = g[side], s = team(t), bx = g.box[side], ob = g.box[other];
        seasonOf.set(t, g.season); lastGame.set(t, [dayO, g.dn]);
        let wn = 0.0, wd = 0.0;
        for (const b of bx.bat) {
          const [n_, d_] = woba(b); wn += n_; wd += d_;
          if (d_ > 0 || b.pa > 0) { const q = B.get(b.id) || [0.0, 0.0]; const dd = Math.pow(0.5, b.pa / C.hl_bat_pa); B.set(b.id, [q[0] * dd + n_, q[1] * dd + d_]); }
        }
        const oh = hand(ob.pit[0].id);
        let bpn = 0, bpb = 0; for (const p of bx.pit.slice(1)) { bpn += fipn(p); bpb += p.bf; }
        const obs = { n: 1.0, rf: runs[side], ra: runs[other], w: runs[side] > runs[other] ? 1.0 : 0.0, wn, wd, bpn, bpb };
        for (const k of TK) s[k] = s[k] * dTeam + (obs[k] !== undefined ? obs[k] : 0.0);
        if (oh === 'L' || oh === 'R') { s['wn' + oh] += wn; s['wd' + oh] += wd; }
        const sp = bx.pit[0];
        const lo = { n: 1.0, rf: runs[side], wn, wd, bpn, bpb, spn: fipn(sp), spb: sp.bf, spk: sp.k, spo: sp.outs, sps: 1.0 };
        for (const k of Object.keys(LEAGUE0)) L[k] = L[k] * dLg + lo[k];
        bx.pit.forEach((p, n) => {
          let q = P.get(p.id);
          if (!q) { q = { bf: 0.0, fn: 0.0, k: 0.0, so: 0.0, ns: 0.0, last: dayO, np: 0.0 }; P.set(p.id, q); }
          const dd = Math.pow(0.5, p.bf / C.hl_pit_bf);
          q.bf = q.bf * dd + p.bf; q.fn = q.fn * dd + fipn(p); q.k = q.k * dd + p.k;
          if (n === 0) { q.so = q.so * dSt + p.outs; q.ns = q.ns * dSt + 1.0; }
          q.last = dayO; q.np = p.np;
        });
        let rnp = 0; for (const p of bx.pit.slice(1)) rnp += p.np;
        const rl = (relief.get(t) || []).concat([[dayO, rnp]]);
        relief.set(t, rl.filter(x => dayO - x[0] <= 3));
        const nine = starters9(bx.bat);
        if (nine.length >= 9) lastLineup.set(t, nine);
      }
      const tot = g.hs + g.as;
      const v = V.get(g.venue) || [0.0, 0.0]; V.set(g.venue, [v[0] * dPark + 1.0, v[1] * dPark + tot]);
      if (g.hp) { const u = U.get(g.hp) || [0.0, 0.0]; U.set(g.hp, [u[0] * dUmp + 1.0, u[1] * dUmp + (tot - lgT)]); }
    }
  }
  const lastDay = games.length ? games[games.length - 1].day : null;

  return {
    featured,
    lastDay,
    // Features for an upcoming game from the state after all history (history must end before g.day).
    featuresFor(g) {
      const dayO = ordinal(g.day), lg = lgNow();
      const late = side => ({ nine: g.lineups && g.lineups[side] && g.lineups[side].length >= 9 ? g.lineups[side] : null,
        act: g.starters && g.starters[side] != null ? g.starters[side] : null });
      const h = sideFeats(g, 'home', dayO, lg, late('home')), a = sideFeats(g, 'away', dayO, lg, late('away'));
      return flat(h, a, gameFeats(g, lg));
    },
    flatten: pk => { const f = featured.get(pk); return f ? flat(f._home, f._away, f) : null; },
    pitcher(id) { const p = P.get(id); return p ? { id, bf: p.bf, fipPerBf: p.fn / p.bf, lastDay: p.last } : null; },
  };
}

function linear(stage, f) {
  let z = stage.intercept;
  stage.features.forEach((name, i) => { const v = Number.isFinite(f[name]) ? f[name] : stage.mean[i]; z += stage.coef[i] * (v - stage.mean[i]) / stage.std[i]; });
  return z;
}
const predict = (f, model) => 1 / (1 + Math.exp(-linear(model.ml.stage1, f)));
const predictTotal = (f, model) => linear(model.tot.stage1, f);

// ---- negative binomial total-runs model (same as research/market.py)
function nbPmf(mu, R, kmax = 40) {
  const p = [Math.pow(R / (R + mu), R)];
  for (let k = 0; k < kmax; k++) p.push(p[p.length - 1] * (k + R) / (k + 1) * mu / (R + mu));
  return p;
}
function nbOver(mu, R, line) {
  const p = nbPmf(mu, R), fl = Math.floor(line);
  let under = 0, push = 0;
  if (line === fl) { for (let k = 0; k < fl; k++) under += p[k]; push = p[fl]; } else { for (let k = 0; k <= fl; k++) under += p[k]; }
  return { over: 1 - under - push, push, under };
}
function impliedMu(line, pOver, R) {
  let lo = 2.0, hi = 20.0;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2, o = nbOver(mid, R, line); if (o.over / (o.over + o.under) < pOver) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
const implied = a => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));
function novig(h, a) {
  if (!Number.isFinite(h) || !Number.isFinite(a) || Math.abs(h) < 100 || Math.abs(a) < 100) return null;
  const ph = implied(h), pa = implied(a), s = ph + pa;
  return s > 1 && s < 1.15 ? ph / s : null;
}
const decimal = a => 1 + (a > 0 ? a / 100 : 100 / -a);

function tierOf(size, tiers) {
  if (!tiers) return 'PASS';
  if (tiers.diamond != null && size >= tiers.diamond) return 'DIAMOND';
  if (tiers.gold != null && size >= tiers.gold) return 'GOLD';
  return 'PASS';
}
// Moneyline. market: {prob: no-vig home probability from ONE book's OPEN prices}. Tier is only a bet when model.ml.proven;
// an unproven tier is a paper-tracking candidate.
function signal(f, pFund, market, model) {
  if (!market || !Number.isFinite(market.prob)) return null;
  const x = { ...f, x_gap: logit(pFund) - logit(market.prob), x_open: logit(market.prob), src_tr: 0 };
  const move = linear(model.ml.stage2, x);
  const key = model.ml.rule === 'gap' ? x.x_gap : move;          // the exported rule decides what is tiered
  return { move, gap: x.x_gap, side: key > 0 ? 'home' : 'away', tier: tierOf(Math.abs(key), model.ml.tiers), rule: model.ml.rule || 'move', proven: !!model.ml.proven };
}
// Totals. market: {line, over, under} american prices at the open. Returns predicted move of the implied mean (runs).
function totalSignal(f, muFund, market, model) {
  if (!market || !Number.isFinite(market.line)) return null;
  const pOver = novig(market.over, market.under); if (pOver == null) return null;
  const muOpen = impliedMu(market.line, pOver, model.tot.nb_size);
  const x = { ...f, t_gap: muFund - muOpen, mu_open: muOpen, tsrc_tr: 0 };
  const move = linear(model.tot.stage2, x);
  const key = model.tot.rule === 'gap' ? x.t_gap : move;
  return { move, gap: x.t_gap, muOpen, side: key > 0 ? 'over' : 'under', tier: tierOf(Math.abs(key), model.tot.tiers), rule: model.tot.rule || 'move', proven: !!model.tot.proven };
}
// CLV of a bet at an open price scored against the no-vig close.
function clvMoneyline(side, openAmerican, closeProbHome) {
  const pc = side === 'home' ? closeProbHome : 1 - closeProbHome;
  return pc * decimal(openAmerican) - 1;
}
function clvTotal(side, openLine, openAmerican, close, R) {
  const pOver = novig(close.over, close.under); if (pOver == null) return null;
  const mu = impliedMu(close.line, pOver, R), o = nbOver(mu, R, openLine);
  return (side === 'over' ? o.over : o.under) * decimal(openAmerican) + o.push - 1;
}

module.exports = { build, predict, predictTotal, signal, totalSignal, clvMoneyline, clvTotal, compactBox, parseWeather, starters9, woba, fipn,
  nbPmf, nbOver, impliedMu, novig, decimal, logit, linear, DEFAULT_CFG, SIDE_KEYS };
