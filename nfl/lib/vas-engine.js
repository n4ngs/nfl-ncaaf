'use strict';
// NFL VAS engine: a line-for-line port of the portable (open-safe) part of nfl/research/features.py plus the linear
// stage-1 / stage-2 model exported by nfl/research/portable.py (nfl/research/data/cache/nfl-vas-model.json).
//
// Input history (completed games, any order; the engine sorts by day, kickoff time, game id):
//   games: [{gid, season, week, day:'YYYY-MM-DD', time:'HH:MM' (ET), home, away, homeScore, awayScore, neutral:bool, div:0|1, roof}]
//   plays: [[gid, off, def, kind:'p'|'r'|'s', epa, success:0|1, passerId|'' , wp|null]]   (nflverse pbp, see compactPlay)
//   snaps: [[gid, team, pfrId, position, offensePct, defensePct, played:0|1, name?]]     (nflverse snap_counts; name optional)
// build() walks the history day by day (state strictly before each day) and returns
//   featured             Map gid -> features computed with pre-day state (for parity checks and backtests)
//   featuresFor(game)    open-safe features for an upcoming game ({home, away, season, day, time, neutral, div, roof})
//   qb(id) / players(team)  lookups used by the Injury Matrix display
// predict(features, model)              -> stage-1 {margin, total} (home margin, total points)
// signal(features, pred, market, model) -> stage-2 predicted open->close move (points) + tier for spread and total
// No network, no clock: callers pass everything in. Pure and deterministic, so parity with Python is testable.

// Feature config chosen by nfl/research/tune.py on 2009-2013 only; the exported model carries its own copy (model.config).
const DEFAULT_CONFIG = Object.freeze({"hl_team": 16, "carry": 0.25, "league_carry": 0.5, "k_pass": 100, "k_rush": 100, "k_sr": 200, "k_game": 1, "wp_lo": 0.05, "wp_hi": 0.95, "hl_qb": 250, "k_qb": 500, "qb_rep": -0.15, "hl_pl": 4, "pl_carry": 0.3, "min_share": 0.05, "rest_cap": 14, "bye_min": 12, "short_max": 5, "recent_starts": 8});
const FRANCHISE = { STL: 'LA', SD: 'LAC', OAK: 'LV' };
const fr = t => FRANCHISE[t] || t;
const TZ = {};
for (const t of 'ATL BAL BUF CAR CIN CLE DET IND JAX MIA NE NYG NYJ PHI PIT TB WAS'.split(' ')) TZ[t] = -5;
for (const t of 'CHI DAL GB HOU KC MIN NO TEN STL'.split(' ')) TZ[t] = -6;
for (const t of 'DEN ARI'.split(' ')) TZ[t] = -7;
for (const t of 'LA LAC LV OAK SD SEA SF'.split(' ')) TZ[t] = -8;
const GROUPS = { QB: 'QB', T: 'OL', G: 'OL', C: 'OL', OL: 'OL', OT: 'OL', OG: 'OL', WR: 'WR', TE: 'TE', RB: 'RB', FB: 'RB', HB: 'RB',
  DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB', CB: 'DB', S: 'DB', SS: 'DB', FS: 'DB', DB: 'DB' };
const GL = ['QB', 'OL', 'WR', 'TE', 'RB', 'DL', 'LB', 'DB'];
const OFFG = new Set(['QB', 'OL', 'WR', 'TE', 'RB']);
const TEAM_KEYS = ['pe', 'pn', 're', 'rn', 'ps', 'sn', 'dpe', 'dpn', 'dre', 'drn', 'dps', 'dsn', 'st', 'pf', 'pa', 'pl', 'n'];
const SIDE = ['op', 'or', 'dp', 'dr', 'osr', 'dsr', 'st', 'pf', 'pa', 'pace', 'prate', 'qb', 'qbx', 'qbshare', 'rest', 'bye', 'short', ...GL.map(g => 'm_' + g)];
const SUMS = ['op', 'or', 'dp', 'dr', 'osr', 'dsr', 'st', 'pf', 'pa', 'pace', 'prate', 'qb'];
const DAY = 86400000;
const days = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / DAY);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// nflverse pbp row (CSV/parquet column names) -> compact play, or null if the play is not used.
function compactPlay(r) {
  const num = v => (v === '' || v == null || v === 'NA' ? NaN : Number(v));
  const epa = num(r.epa);
  if (!Number.isFinite(epa) || !r.posteam || !r.defteam || r.posteam === 'NA' || r.defteam === 'NA') return null;
  if (num(r.play_deleted) === 1) return null;
  const special = num(r.special) === 1, dropback = num(r.qb_dropback) === 1;
  const scrim = (r.play_type === 'pass' || r.play_type === 'run' || dropback) && num(r.qb_kneel) !== 1 && num(r.qb_spike) !== 1 && !special;
  const st = special && ['kickoff', 'punt', 'field_goal', 'extra_point'].includes(r.play_type);
  if (!scrim && !st) return null;
  const wp = num(r.wp);
  return [r.game_id, r.posteam, r.defteam, st ? 's' : dropback ? 'p' : 'r', epa, num(r.success) === 1 ? 1 : 0,
    r.passer_id && r.passer_id !== 'NA' ? r.passer_id : '', Number.isFinite(wp) ? wp : null];
}

function build(history, cfg) {
  const C = cfg || DEFAULT_CONFIG;
  const dT = Math.pow(0.5, 1 / C.hl_team), dP = Math.pow(0.5, 1 / C.hl_pl);
  // ---------------- per team-game aggregates
  const AGG = new Map(), QBG = new Map();
  const agg = k => { let o = AGG.get(k); if (!o) { o = {}; AGG.set(k, o); } return o; };
  const inc = (o, k, v) => { o[k] = (o[k] || 0) + v; };
  for (const p of history.plays) {
    const [gid, off0, def0, kind, epa, succ, passer, wp] = p;
    const off = fr(off0), dfn = fr(def0);
    const o = agg(gid + '|' + off), d = agg(gid + '|' + dfn);
    if (kind === 's') { inc(o, 'st', epa); inc(d, 'st', -epa); continue; }
    inc(o, 'pl', 1);
    let qm = null;
    if (kind === 'p' && passer) {
      const k = gid + '|' + off; qm = QBG.get(k); if (!qm) { qm = new Map(); QBG.set(k, qm); }
      const q = qm.get(passer) || [0, 0, 0]; q[0] += 1; qm.set(passer, q);
    }
    const neutral = wp == null || !Number.isFinite(wp) || (C.wp_lo <= wp && wp <= C.wp_hi);
    if (!neutral) continue;
    inc(o, 'sn', 1); inc(o, 'ps', succ); inc(d, 'dsn', 1); inc(d, 'dps', succ);
    if (kind === 'p') {
      inc(o, 'pe', epa); inc(o, 'pn', 1); inc(d, 'dpe', epa); inc(d, 'dpn', 1);
      if (passer) { const q = qm.get(passer); q[1] += 1; q[2] += epa; }
    } else { inc(o, 're', epa); inc(o, 'rn', 1); inc(d, 'dre', epa); inc(d, 'drn', 1); }
  }
  const starterOf = (gid, t) => {
    const m = QBG.get(gid + '|' + t); if (!m) return null;
    let best = null, n = -1;
    for (const [pid, v] of m) if (v[0] > n || (v[0] === n && pid > best)) { best = pid; n = v[0]; }
    return best;
  };
  const SN = new Map();
  for (const s of history.snaps || []) { const k = s[0] + '|' + fr(s[1]); if (!SN.has(k)) SN.set(k, []); SN.get(k).push(s); }

  // ---------------- state
  const T = new Map(), L = {}, seasonOf = new Map(), QB = new Map(), starts = new Map(), lastGame = new Map();
  const PS = new Map(), PN = new Map(), lastPlayed = new Map(), names = new Map(), pnames = new Map();
  let leagueSeason = null;
  const team = t => { if (!T.has(t)) T.set(t, {}); return T.get(t); };
  const startsOf = t => { if (!starts.has(t)) starts.set(t, []); return starts.get(t); };
  const psOf = t => { if (!PS.has(t)) PS.set(t, new Map()); return PS.get(t); };
  const g0 = (o, k) => o[k] || 0;
  const lrate = (num, den) => (L[den] || 0) > 0 ? (L[num] || 0) / L[den] : 0;

  function teamRates(t) {
    const s = team(t), out = {};
    const lp = lrate('pe', 'pn'), lr = lrate('re', 'rn'), lsr = lrate('ps', 'sn');
    out.op = (g0(s, 'pe') + C.k_pass * lp) / (g0(s, 'pn') + C.k_pass);
    out.or = (g0(s, 're') + C.k_rush * lr) / (g0(s, 'rn') + C.k_rush);
    out.dp = (g0(s, 'dpe') + C.k_pass * lp) / (g0(s, 'dpn') + C.k_pass);
    out.dr = (g0(s, 'dre') + C.k_rush * lr) / (g0(s, 'drn') + C.k_rush);
    out.osr = (g0(s, 'ps') + C.k_sr * lsr) / (g0(s, 'sn') + C.k_sr);
    out.dsr = (g0(s, 'dps') + C.k_sr * lsr) / (g0(s, 'dsn') + C.k_sr);
    const n = g0(s, 'n'), kg = C.k_game;
    out.st = g0(s, 'st') / (n + kg);
    out.pf = (g0(s, 'pf') + kg * lrate('pf', 'n')) / (n + kg);
    out.pa = (g0(s, 'pa') + kg * lrate('pf', 'n')) / (n + kg);
    out.pace = (g0(s, 'pl') + kg * lrate('pl', 'n')) / (n + kg);
    out.prate = (g0(s, 'pn') + C.k_sr * lrate('pn', 'sn')) / (g0(s, 'sn') + C.k_sr);
    return out;
  }
  function qbFeats(q, t) {
    const [n, e] = q ? (QB.get(q) || [0, 0]) : [0, 0];
    const prior = lrate('pe', 'pn') + C.qb_rep;
    const rec = startsOf(t).slice(-C.recent_starts);
    return { qb: (e + C.k_qb * prior) / (n + C.k_qb), qbx: Math.log1p(n), qbshare: rec.length && q ? rec.filter(x => x === q).length / rec.length : 0 };
  }
  function missing(t, avail) {
    const m = {}; for (const g of GL) m[g] = 0;
    const pn = PN.get(t) || 0; if (pn <= 0) return m;
    const ps = psOf(t);
    for (const pid of [...ps.keys()].sort(cmp)) {
      const v = ps.get(pid), s = v[0] / pn;
      if (s >= C.min_share && !avail.has(pid)) m[v[1]] += s;
    }
    return m;
  }
  function carry(t, season) {
    if (seasonOf.has(t) && seasonOf.get(t) !== season) {
      const s = team(t); for (const k of Object.keys(s)) s[k] *= C.carry;
      for (const v of psOf(t).values()) v[0] *= C.pl_carry;
      PN.set(t, (PN.get(t) || 0) * C.pl_carry);
    }
    seasonOf.set(t, season);
  }
  function sideFeats(teamCode, season, day) {
    const t = fr(teamCode); carry(t, season);
    const r = teamRates(t);
    const st = startsOf(t), proj = st.length ? st[st.length - 1] : null;
    Object.assign(r, qbFeats(proj, t)); r.proj = proj; r.projName = proj ? names.get(proj) || null : null;
    const rest = lastGame.has(t) ? Math.min(days(day, lastGame.get(t)), C.rest_cap) : C.rest_cap;
    r.rest = rest; r.bye = rest >= C.bye_min ? 1 : 0; r.short = rest <= C.short_max ? 1 : 0;
    const lp = lastPlayed.get(t);
    const mm = lp ? missing(t, lp) : Object.fromEntries(GL.map(g => [g, 0]));
    for (const g of GL) r['m_' + g] = mm[g];
    return r;
  }
  function combine(h, a, g) {
    const f = {};
    for (const k of SIDE) f['d_' + k] = h[k] - a[k];
    for (const k of SUMS) f['s_' + k] = h[k] + a[k];
    const neutral = g.neutral ? 1 : 0; f.neutral = neutral; f.div = g.div ? 1 : 0;
    f.dome = g.roof === 'dome' || g.roof === 'closed' ? 1 : 0;
    const tz = neutral ? 0 : (TZ[g.home] ?? -5) - (TZ[g.away] ?? -5);
    f.away_tz = tz;
    const hour = parseInt(String(g.time || '13:00').slice(0, 2), 10);
    f.west_early = tz >= 2 && hour < 14 ? 1 : 0;
    f.home_short = h.short; f.away_short = a.short; f.home_bye = h.bye; f.away_bye = a.bye;
    f.home_qbshare = h.qbshare; f.away_qbshare = a.qbshare;            // stage-2 inputs
    return f;
  }

  // ---------------- walk
  const games = history.games.slice().sort((x, y) => cmp(x.day, y.day) || cmp(x.time || '', y.time || '') || cmp(x.gid, y.gid));
  const byDay = new Map();
  for (const g of games) { if (!byDay.has(g.day)) byDay.set(g.day, []); byDay.get(g.day).push(g); }
  const featured = new Map();
  for (const day of [...byDay.keys()].sort(cmp)) {
    const dg = byDay.get(day);
    if (leagueSeason !== null && dg[0].season !== leagueSeason) for (const k of Object.keys(L)) L[k] *= C.league_carry;
    leagueSeason = dg[0].season;
    for (const g of dg) {
      const h = sideFeats(g.home, g.season, day), a = sideFeats(g.away, g.season, day);
      featured.set(g.gid, { ...combine(h, a, g), _home: h, _away: a });
    }
    const pre = new Map();
    for (const g of dg) for (const tc of [g.home, g.away]) pre.set(fr(tc), teamRates(fr(tc)));
    const lp = lrate('pe', 'pn'), lr = lrate('re', 'rn');
    for (const g of dg) {
      for (const [side, other] of [['home', 'away'], ['away', 'home']]) {
        const t = fr(g[side]), o = fr(g[other]);
        const a = AGG.get(g.gid + '|' + t) || {}, po = pre.get(o);
        const obs = {};
        for (const k of ['pn', 'rn', 'ps', 'sn', 'dpn', 'drn', 'dps', 'dsn', 'st', 'pl']) obs[k] = g0(a, k);
        obs.pe = g0(a, 'pe') - g0(a, 'pn') * (po.dp - lp);
        obs.re = g0(a, 're') - g0(a, 'rn') * (po.dr - lr);
        obs.dpe = g0(a, 'dpe') - g0(a, 'dpn') * (po.op - lp);
        obs.dre = g0(a, 'dre') - g0(a, 'drn') * (po.or - lr);
        obs.pf = Number(g[side + 'Score']); obs.pa = Number(g[other + 'Score']); obs.n = 1;
        const s = team(t);
        for (const k of TEAM_KEYS) s[k] = g0(s, k) * dT + obs[k];
        for (const k of ['pe', 'pn', 're', 'rn', 'ps', 'sn', 'pf', 'pl', 'n']) L[k] = (L[k] || 0) + (k === 'pf' || k === 'n' ? obs[k] : g0(a, k));
        const qm = QBG.get(g.gid + '|' + t);
        if (qm) for (const pid of [...qm.keys()].sort(cmp)) {
          const [, n, e] = qm.get(pid); if (n <= 0) continue;
          const q = QB.get(pid) || [0, 0], d = Math.pow(0.5, n / C.hl_qb);
          QB.set(pid, [q[0] * d + n, q[1] * d + (e - n * (po.dp - lp))]);
        }
        const st = starterOf(g.gid, t); if (st) startsOf(t).push(st);
        lastGame.set(t, g.day);
        const S = SN.get(g.gid + '|' + t);
        if (S) {
          const ps = psOf(t);
          for (const v of ps.values()) v[0] *= dP;
          PN.set(t, (PN.get(t) || 0) * dP + 1);
          const played = new Set();
          for (const [, , pid, pos, oPct, dPct, pl, nm] of S) {
            if (nm) pnames.set(pid, nm);
            const grp = GROUPS[pos]; if (!grp) continue;
            let pct = OFFG.has(grp) ? oPct : dPct; if (!Number.isFinite(pct)) pct = 0;
            if (pl) played.add(pid);
            const v = ps.get(pid); if (!v) ps.set(pid, [pct, grp]); else { v[0] += pct; v[1] = grp; }
          }
          lastPlayed.set(t, played);
        }
      }
    }
    for (const g of dg) for (const [id, nm] of Object.entries(g.qbNames || {})) names.set(id, nm);
  }

  return {
    featured,
    featuresFor(g) {
      const h = sideFeats(g.home, g.season, g.day), a = sideFeats(g.away, g.season, g.day);
      return { ...combine(h, a, g), _home: h, _away: a };
    },
    qb(id) { const [n, e] = QB.get(id) || [0, 0]; const prior = lrate('pe', 'pn') + C.qb_rep; return { id, name: names.get(id) || null, dropbacks: n, epa: (e + C.k_qb * prior) / (n + C.k_qb) }; },
    // regulars of a team with their expected snap share (pre-next-game), for the Injury Matrix display
    players(teamCode) {
      const t = fr(teamCode), pn = PN.get(t) || 0, out = [];
      if (pn > 0) for (const [pid, v] of psOf(t)) { const s = v[0] / pn; if (s >= C.min_share) out.push({ pid, name: pnames.get(pid) || null, group: v[1], share: s }); }
      return out.sort((a, b) => b.share - a.share || cmp(a.pid, b.pid));
    },
  };
}

// ---------------- model
function linear(stage, f) {
  let z = stage.intercept;
  stage.features.forEach((name, i) => { const v = Number.isFinite(f[name]) ? f[name] : stage.mean[i]; z += stage.coef[i] * (v - stage.mean[i]) / stage.std[i]; });
  return z;
}
const predict = (f, model) => ({ margin: linear(model.stage1.margin, f), total: linear(model.stage1.total, f) });

// key-number-aware discrete outcome distribution (common.KeyDist in the research code)
function pmf(mu, kd) {
  const out = new Array(kd.w.length); let s = 0;
  for (let i = 0; i < kd.w.length; i++) { const z = (kd.k_min + i - mu) / kd.sd; out[i] = Math.exp(-0.5 * z * z) * kd.w[i]; s += out[i]; }
  for (let i = 0; i < out.length; i++) out[i] /= s;
  return out;
}
function probs(mu, line, kd) {       // [P(outcome > line), P(outcome == line)]
  const p = pmf(mu, kd); let over = 0, push = 0;
  for (let i = 0; i < p.length; i++) { const k = kd.k_min + i; if (k > line) over += p[i]; else if (k === line) push += p[i]; }
  return [over, push];
}
const american = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
function noVig(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) < 100 || Math.abs(b) < 100) return null;
  const p = 1 / american(a), q = 1 / american(b), s = p + q;
  return s > 0.98 && s < 1.15 ? p / s : null;
}
// mean such that P(>line)/(P(>line)+P(<line)) equals the no-vig probability of the over/home side (bisection)
function fairMean(line, pOver, kd) {
  if (pOver == null || !Number.isFinite(pOver)) return line;
  const f = mu => { const [a, b] = probs(mu, line, kd); return a / Math.max(1 - b, 1e-12) - pOver; };
  let lo = line - 25, hi = line + 25, flo = f(lo);
  if (flo * f(hi) > 0) return line;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) { const m = (lo + hi) / 2, fm = f(m); if ((fm > 0) === (flo > 0)) { lo = m; flo = fm; } else hi = m; }
  return (lo + hi) / 2;
}
// Win chance (home) for a fair spread `spread` (home-favoured > 0), for the board's fair moneyline: the distribution whose
// -110/-110 number is that spread (fairMean at 50%), then P(margin > 0) + half a tie. A discrete distribution only
// resolves lines to the half point, so a spread between two half points is interpolated linearly between them.
// Display only: nothing in the signal or CLV scoring uses it. Checked on TeamRankings closes 2003-25 (6,232 favorites).
function winFromSpread(spread, kd) {
  if (!Number.isFinite(spread) || !kd) return null;
  const at = s => { const [o, p] = probs(fairMean(s, 0.5, kd), 0, kd); return o + p / 2; };
  const lo = Math.floor(spread * 2) / 2, f = (spread - lo) * 2;
  return f < 1e-9 ? at(lo) : (1 - f) * at(lo) + f * at(lo + 0.5);
}
// expected ROI of a bet at `line`/`price` if a distribution centred on muClose is the truth (pushes refund)
function clvEv(muClose, line, price, sideOver, kd) {
  let [w, p] = probs(muClose, line, kd);
  if (!sideOver) w = 1 - w - p;
  return w * american(price) + p - 1;
}

// market: {spread, homePrice, awayPrice, total, overPrice, underPrice} for the current (open-time) line; home-favoured spread > 0
function signal(f, pred, market, model) {
  if (!market) return null;
  const out = {};
  const tier = (size, t) => (t.proven && size >= t.proven ? 'PROVEN' : t.lean && size >= t.lean ? 'LEAN' : 'PASS');
  if (Number.isFinite(market.spread)) {
    const mu = fairMean(market.spread, noVig(market.homePrice, market.awayPrice), model.keydist.margin);
    const x = { ...f, x_gap: pred.margin - mu, x_open: mu, x_absopen: Math.abs(mu), x_half: market.spread % 1 !== 0 ? 1 : 0 };
    const move = linear(model.stage2.spread, x);
    out.spread = { move, side: move > 0 ? 'home' : 'away', gap: x.x_gap, fair: mu, tier: tier(Math.abs(move), model.tiers.spread) };
  }
  if (Number.isFinite(market.total) && model.stage2.total) {
    const mu = fairMean(market.total, noVig(market.overPrice, market.underPrice), model.keydist.total);
    const x = { ...f, xt_gap: pred.total - mu, xt_open: mu };
    const move = linear(model.stage2.total, x);
    out.total = { move, side: move > 0 ? 'over' : 'under', gap: x.xt_gap, fair: mu, tier: tier(Math.abs(move), model.tiers.total) };
  }
  return out;
}

// Player-name key for matching ESPN injury rows to snap-count regulars: case, accents, punctuation and suffixes removed.
const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
function normName(n) {
  return String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.'`\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ')
    .trim().split(' ').filter(w => w && !SUFFIX.has(w)).join(' ');
}
// ESPN position labels that nflverse spells differently (tie-breaker only)
const ESPN_POS = { OT: 'OL', G: 'OL', C: 'OL', OL: 'OL', OG: 'OL', DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', EDGE: 'LB', LB: 'LB', OLB: 'LB', ILB: 'LB', MLB: 'LB',
  CB: 'DB', S: 'DB', SS: 'DB', FS: 'DB', DB: 'DB', QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE' };
// resolve one report row to a regular: pfr id first, else normalized name (+ position group, then larger share)
function matchRegular(regs, r) {
  if (r.pid) { const hit = regs.find(x => x.pid === r.pid); if (hit) return hit; }
  const key = normName(r.name); if (!key) return null;
  const cands = regs.filter(x => x.name && normName(x.name) === key);
  if (cands.length <= 1) return cands[0] || null;
  const grp = ESPN_POS[r.pos] || GROUPS[r.pos];
  const same = cands.filter(x => x.group === grp);
  return (same.length ? same : cands).slice().sort((a, b) => b.share - a.share || cmp(a.pid, b.pid))[0];
}

// Injury Matrix rows: report = [{pid? (pfr id), id? (ESPN id), name, pos, status}] for one team; sorted by weight (display only).
function injuryMatrix(state, teamCode, report, model) {
  const regs = state.players(teamCode);
  const pmiss = model.pmiss || { Out: 1, Doubtful: 0.99, Questionable: 0.35, Probable: 0.06 };
  const w = (model.injury_weights || {});
  return report.map(r => {
    const reg = matchRegular(regs, r);
    const group = (reg && reg.group) || ESPN_POS[r.pos] || GROUPS[r.pos] || null;
    const share = reg ? reg.share : 0;
    const pm = pmiss[r.status] ?? 0;
    const weight = share * pm;
    return { name: r.name || r.pid, pos: r.pos, status: r.status, group, pid: reg ? reg.pid : null, share, pMiss: pm, weight,
      effect: group && w[group] != null ? weight * w[group] : null };
  }).sort((a, b) => b.weight - a.weight || cmp(String(a.name), String(b.name)));
}

module.exports = { DEFAULT_CONFIG, build, predict, signal, compactPlay, fairMean, clvEv, probs, winFromSpread, noVig, injuryMatrix, normName, matchRegular, linear, fr, TEAM_KEYS, SIDE, GL };
