"""Walk-forward, open-safe team vectors for FBS football. Pure-Python loops on purpose: ncaaf/lib/vas-engine.js is a
line-for-line port and parity is checked to 1e-8.

State per team (keyed by ESPN team id), updated after each day's games, read before them:
  for each stat k in STATS, offense and defense (defense = what opponents did against this team):
    exponentially weighted (half-life hl games), opponent-adjusted observations, shrunk toward the league mean of
    the team's division (FBS / non-FBS) with k_shrink pseudo-games; sums are multiplied by `carry` at a new season.
    opponent adjustment: off_obs = x - (opp_def_rating - league_mean); def_obs = x - (opp_off_rating - league_mean),
    using the opponent's pre-day rating.
  market rating M: online update from past CLOSING spreads (optional group, only if a close exists).
  schedule: days since last game; QB: last game's starter (most pass attempts) = projected starter, with his starts
    for this team and the shrunk mean passing EPA/play in his starts.
Everything a game's features use is known before that day's games start (the projected QB, not the actual one).
"""
import math

STATS = ['pts', 'epa', 'repa', 'pepa', 'fdr', 'expl', 'ypp', 'st', 'plays']
CFG = dict(hl=9.0, k_shrink=1.0, carry=0.7, rest_cap=28, lr_m=0.4, hfa_m=2.0, carry_m=0.95, k_qb=2.0, fcs_m=-20.0,   # chosen by tune.py on 2017-2022 only
           # why_line.py (2026-09): new-staff carry / learning rate (defaults = no change), venue home-edge decay + shrink
           # new-staff market prior 0.8 / learning rate 0.55: picked on 2017-2022 only (grid in why_line.py), holdout 2023-25
           # stage-1 RMSE 15.671 -> 15.645 (better every season); carry_nc (box-score carry) stayed 0.7
           carry_nc=0.7, carry_m_nc=0.8, lr_m_nc=0.55, dec_v=0.96, k_v=8.0)

def day_of(start):
    return start[:10]

def days_between(a, b):
    import datetime as dt
    return (dt.date.fromisoformat(a) - dt.date.fromisoformat(b)).days

class Walk:
    def __init__(self, cfg=CFG):
        self.c = cfg
        self.dec = 0.5 ** (1.0 / cfg['hl'])
        self.S = {}        # team -> {'o_k': sum, 'ow_k': weight, 'd_k': .., 'dw_k': ..}
        self.league = {}   # 'div:o_k' -> [sum, n]  raw observations by division, plus 'all:o_k'
        self.season_of = {}; self.last_day = {}; self.fbs = {}
        self.M = {}        # market rating
        self.qb_last = {}  # team -> qb id of last game
        self.qb = {}       # (team, qb) -> [starts, pepa_sum]
        self.recent = {}   # team -> [season, last-game ATS margin (clipped), won as underdog, won by 21+, emotional win, lost as favourite]
        self.newc = {}     # (team, season) -> 1 if it is the team's first season under a new head coach
        self.V = {}        # team -> [home sum, home w, away sum, away w] of market residuals (venue home edge, market view)
        self.R = {}        # team -> same, of result residuals (venue home edge, results view)
        self.A = {}        # team -> [sum log attendance, w] over its past home games

    def _st(self, t):
        s = self.S.get(t)
        if s is None:
            s = {}
            self.S[t] = s
        return s

    def _mean(self, key):
        v = self.league.get(key)
        return v[0] / v[1] if v and v[1] > 0 else 0.0

    def rating(self, t, side, k):
        s = self._st(t); div = 'fbs' if self.fbs.get(t, 1) else 'fcs'
        prior = self._mean(div + ':' + side + '_' + k)
        return (s.get(side + '_' + k, 0.0) + self.c['k_shrink'] * prior) / (s.get(side + 'w_' + k, 0.0) + self.c['k_shrink'])

    def _carry(self, t, season):
        if t in self.season_of and self.season_of[t] != season:
            nc = self.newc.get((t, season), 0)
            s = self._st(t)
            for key in list(s.keys()):
                s[key] = s[key] * (self.c['carry_nc'] if nc else self.c['carry'])
            if t in self.M:
                self.M[t] = self.M[t] * (self.c['carry_m_nc'] if nc else self.c['carry_m'])
            self.season_of[t] = season

    def _vdev(self, D, t):
        v = D.get(t)
        if v is None: return 0.0
        k = self.c['k_v']
        return v[0] / (v[1] + k) - v[2] / (v[3] + k)

    def side(self, t, season, day, fbs):
        """features of one team before a game on `day` (applies the season carry-over once, like the Python walk)."""
        self.fbs[t] = fbs
        self._carry(t, season)
        r = {}
        for k in STATS:
            r['o_' + k] = self.rating(t, 'o', k); r['d_' + k] = self.rating(t, 'd', k)
        s = self._st(t)
        r['n'] = s.get('ow_pts', 0.0)
        r['rest'] = min(days_between(day, self.last_day[t]), self.c['rest_cap']) if t in self.last_day else self.c['rest_cap']
        r['mkt'] = self.M.get(t, 0.0 if fbs else self.c['fcs_m'])
        q = self.qb_last.get(t, 0)
        st = self.qb.get((t, q), [0.0, 0.0]) if q else [0.0, 0.0]
        prior = self._mean('all:qb_pepa')
        r['qb_starts'] = math.log1p(st[0])
        r['qb_pepa'] = (st[1] + self.c['k_qb'] * prior) / (st[0] + self.c['k_qb'])
        r['qb'] = q
        L = self.recent.get(t)
        same = L is not None and L[0] == season
        r['last_ats'] = L[1] if same else 0.0
        r['last_upset'] = L[2] if same else 0
        r['last_blowout'] = L[3] if same else 0
        r['last_emo'] = L[4] if same else 0
        r['last_bad'] = L[5] if same else 0
        r['newc'] = self.newc.get((t, season), 0)
        r['venue_m'] = self._vdev(self.V, t); r['venue_r'] = self._vdev(self.R, t)
        a = self.A.get(t); lm = self._mean('all:att')
        r['att'] = ((a[0] + 3.0 * lm) / (a[1] + 3.0) - lm) if a else 0.0
        return r

    def _vadd(self, D, h, a, x):
        d = self.c['dec_v']
        for t, i, y in ((h, 0, x), (a, 2, -x)):
            v = D.get(t)
            if v is None:
                v = [0.0, 0.0, 0.0, 0.0]
                D[t] = v
            v[i] = v[i] * d + y; v[i + 1] = v[i + 1] * d + 1.0

    def update_day(self, games):
        """games: list of dicts completed on one day. Pre-day ratings are used for every adjustment."""
        adj = []
        pre = {}
        for g in games:
            h, a = g['home_id'], g['away_id']
            pre[g['gid']] = (self.rating(h, 'o', 'pts') - self.rating(h, 'd', 'pts')) - (self.rating(a, 'o', 'pts') - self.rating(a, 'd', 'pts'))
        for g in games:
            for side, other in (('home', 'away'), ('away', 'home')):
                t, o = g[side + '_id'], g[other + '_id']
                obs = {}
                for k in STATS:
                    x = g[side + '_pts'] if k == 'pts' else g.get(side + '_' + k)
                    y = g[other + '_pts'] if k == 'pts' else g.get(other + '_' + k)
                    mu = self._mean('all:o_' + k)
                    if x is not None and x == x:
                        obs['o_' + k] = (x, x - (self.rating(o, 'd', k) - mu))
                    if y is not None and y == y:
                        obs['d_' + k] = (y, y - (self.rating(o, 'o', k) - mu))
                adj.append((t, obs, g, side))
        for t, obs, g, side in adj:
            s = self._st(t); div = 'fbs' if g[side + '_fbs'] else 'fcs'
            for key, (raw, a) in obs.items():
                sd, k = key.split('_', 1)
                s[key] = s.get(key, 0.0) * self.dec + a
                s[sd + 'w_' + k] = s.get(sd + 'w_' + k, 0.0) * self.dec + 1.0
                for lk in (div + ':' + key, 'all:' + key):
                    v = self.league.get(lk)
                    if v is None:
                        v = [0.0, 0]
                        self.league[lk] = v
                    v[0] += raw; v[1] += 1
        for g in games:
            d = day_of(g['start'])
            if not g['neutral']:
                h, a = g['home_id'], g['away_id']
                self._vadd(self.R, h, a, float(g['home_pts'] - g['away_pts']) - pre[g['gid']])
                att = g.get('attendance')
                if att is not None and att == att and att > 0:
                    la = math.log(att); v = self.A.get(h)
                    if v is None:
                        v = [0.0, 0.0]
                        self.A[h] = v
                    v[0] += la; v[1] += 1.0
                    w = self.league.get('all:att')
                    if w is None:
                        w = [0.0, 0]
                        self.league['all:att'] = w
                    w[0] += la; w[1] += 1
            for side in ('home', 'away'):
                t = g[side + '_id']
                self.season_of[t] = g['season']; self.last_day[t] = d; self.fbs[t] = g[side + '_fbs']
                q = g.get(side + '_qb') or 0
                if q:
                    self.qb_last[t] = q
                    pe = g.get(side + '_pepa')
                    st = self.qb.get((t, q))
                    if st is None:
                        st = [0.0, 0.0]
                        self.qb[(t, q)] = st
                    if pe is not None and pe == pe:
                        st[0] += 1.0; st[1] += pe
                        v = self.league.get('all:qb_pepa')
                        if v is None:
                            v = [0.0, 0]
                            self.league['all:qb_pepa'] = v
                        v[0] += pe; v[1] += 1
            c = g.get('close')
            if c is not None and c == c:
                h, a = g['home_id'], g['away_id']
                mh = self.M.get(h, 0.0 if g['home_fbs'] else self.c['fcs_m']); ma = self.M.get(a, 0.0 if g['away_fbs'] else self.c['fcs_m'])
                err = -c - (mh - ma + self.c['hfa_m'] * (1 - g['neutral']))
                lh = self.c['lr_m_nc'] if self.newc.get((h, g['season']), 0) else self.c['lr_m']
                la_ = self.c['lr_m_nc'] if self.newc.get((a, g['season']), 0) else self.c['lr_m']
                self.M[h] = mh + lh * err; self.M[a] = ma - la_ * err
                if not g['neutral']:
                    self._vadd(self.V, h, a, float(err))
                # recency (open-safe): last game against its own closing spread, from each team's side
                m = g['home_pts'] - g['away_pts']
                hr, ar = g.get('home_rank') or 99, g.get('away_rank') or 99
                # emotional win = beat a ranked team or won as an underdog; bad loss = lost as the favourite
                self.recent[h] = [g['season'], max(-28.0, min(28.0, float(m + c))), int(m > 0 and c > 0), int(m > 21),
                                  int(m > 0 and (ar <= 25 or c > 0)), int(m < 0 and c < 0)]
                self.recent[a] = [g['season'], max(-28.0, min(28.0, float(-m - c))), int(m < 0 and c < 0), int(-m > 21),
                                  int(m < 0 and (hr <= 25 or c < 0)), int(m > 0 and c > 0)]

def combine(h, a, g):
    f = {}
    for k in STATS:
        f['d_o_' + k] = h['o_' + k] - a['o_' + k]; f['d_d_' + k] = h['d_' + k] - a['d_' + k]
    f['t_pts'] = h['o_pts'] + a['d_pts'] + a['o_pts'] + h['d_pts']
    f['t_plays'] = h['o_plays'] + a['d_plays'] + a['o_plays'] + h['d_plays']
    f['d_mkt'] = h['mkt'] - a['mkt']
    f['d_rest'] = h['rest'] - a['rest']
    f['min_n'] = min(h['n'], a['n'])
    f['d_qb_starts'] = h['qb_starts'] - a['qb_starts']; f['d_qb_pepa'] = h['qb_pepa'] - a['qb_pepa']
    f['d_last_ats'] = h['last_ats'] - a['last_ats']; f['d_last_upset'] = h['last_upset'] - a['last_upset']
    f['d_last_blowout'] = h['last_blowout'] - a['last_blowout']
    road = 1 - g['neutral']
    # letdown: the AWAY team comes off an emotional win and is on the road; the home team off one (it hosts); bounce-back diff
    f['ld_away_road'] = a['last_emo'] * road; f['ld_home'] = h['last_emo']; f['d_last_bad'] = h['last_bad'] - a['last_bad']
    f['d_newc'] = h['newc'] - a['newc']
    f['x_venue_m'] = h['venue_m'] * road; f['x_venue_r'] = h['venue_r'] * road; f['x_att'] = h['att'] * road
    f['neutral'] = g['neutral']; f['conf_game'] = g['conf_game']
    f['home_fbs'] = g['home_fbs']; f['away_fbs'] = g['away_fbs']
    return f

def late_qb(W, t, actual):
    """research only (NOT open-safe): the actual starter, known late in the week / at kickoff."""
    st = W.qb.get((t, actual), [0.0, 0.0]) if actual else [0.0, 0.0]
    prior = W._mean('all:qb_pepa')
    return math.log1p(st[0]), (st[1] + W.c['k_qb'] * prior) / (st[0] + W.c['k_qb'])

def walk(games, cfg=CFG, keep_sides=False, late=False):
    """games: list of dicts sorted by (start, gid). Returns {gid: features} computed with pre-day state."""
    W = Walk(cfg); out = {}
    by_day = {}
    for g in games:
        by_day.setdefault(day_of(g['start']), []).append(g)
        for side in ('home', 'away'):
            if g.get(side + '_newc'): W.newc[(g[side + '_id'], g['season'])] = 1
    for d in sorted(by_day):
        dg = sorted(by_day[d], key=lambda g: (g['start'], g['gid']))
        for g in dg:
            h = W.side(g['home_id'], g['season'], d, g['home_fbs']); a = W.side(g['away_id'], g['season'], d, g['away_fbs'])
            f = combine(h, a, g)
            if late:
                # actual starter = first-snap passer (pbp); missing -> no late information (use the projection)
                hq = g.get('home_qb1') or h['qb']; aq = g.get('away_qb1') or a['qb']
                hs, hp = late_qb(W, g['home_id'], hq); as_, ap = late_qb(W, g['away_id'], aq)
                f['L_d_qb_starts'] = hs - as_; f['L_d_qb_pepa'] = hp - ap
                f['L_home_qb_change'] = int(bool(h['qb']) and hq != h['qb']); f['L_away_qb_change'] = int(bool(a['qb']) and aq != a['qb'])
            if keep_sides:
                f['_home'] = h; f['_away'] = a
            out[g['gid']] = f
        W.update_day(dg)
    return out, W
