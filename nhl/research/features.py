"""Walk-forward pregame features for every game. Nothing from a game day is used until that day is over.

Vectors (each side, then home-minus-away diffs):
  TEAM      exponentially weighted, empirically-Bayes-shrunk 5v5 / PP / PK expected-goal rates (score & venue adjusted)
  GOALIE    tonight's starter: shrunk GSAx per 100 unblocked shots, workload, rest, backup flag
  PERSONNEL tonight's dressed lineup value vs the team's recent norm (injuries / returns / call-ups)
  SCHEDULE  rest days and back-to-backs
Lineups and starters are treated as known at puck drop (the same condition the live app enforces).
"""
import numpy as np, pandas as pd
from collections import defaultdict

HL_TEAM, HL_GOALIE_SHOTS, HL_PLAYER = 30, 2500, 40
K_TEAM, K_GOALIE, K_PLAYER_TOI = 10.0, 1200.0, 300.0
SEASON_CARRY = 0.5  # fraction of evidence carried across the summer

games = pd.read_parquet('data/cache/games.parquet')
lineups = pd.read_parquet('data/cache/lineups.parquet')
tl = pd.read_parquet('data/cache/teamlog.parquet')
shots = pd.read_parquet('data/cache/shots.parquet')
shots = shots[(shots.shotOnEmptyNet != 1) & shots.goalieIdForShot.fillna(0).gt(0)]

# ---- per team-game observations from MoneyPuck logs
tl['side'] = np.where(tl.home_or_away == 'HOME', 'home', 'away')
piv = {}
for sit, g in tl.groupby('situation'):
    piv[sit] = g.set_index(['gameId', 'side'])
def obs(gid, side):
    o = {}
    try:
        e = piv['5on5'].loc[(gid, side)]; p = piv['5on4'].loc[(gid, side)]; k = piv['4on5'].loc[(gid, side)]; a = piv['all'].loc[(gid, side)]
    except KeyError:
        return None
    o['ev_toi'] = e.iceTime; o['ev_xgf'] = e.flurryScoreVenueAdjustedxGoalsFor; o['ev_xga'] = e.flurryScoreVenueAdjustedxGoalsAgainst
    o['ev_hdf'] = e.highDangerxGoalsFor; o['ev_hda'] = e.highDangerxGoalsAgainst
    o['ev_gf'] = e.goalsFor; o['ev_ga'] = e.goalsAgainst; o['ev_raw_xgf'] = e.xGoalsFor; o['ev_raw_xga'] = e.xGoalsAgainst
    o['pp_toi'] = p.iceTime; o['pp_xgf'] = p.xGoalsFor; o['pk_toi'] = k.iceTime; o['pk_xga'] = k.xGoalsAgainst
    o['all_gf'] = a.goalsFor; o['all_ga'] = a.goalsAgainst; o['all_xgf'] = a.xGoalsFor; o['all_xga'] = a.xGoalsAgainst
    return o

class EW:
    """Exponentially weighted sums with season carry-over."""
    def __init__(self, hl): self.d = 0.5 ** (1 / hl); self.s = defaultdict(float)
    def add(self, key, vals, w=1.0):
        for k, v in vals.items(): self.s[(key, k)] = self.s[(key, k)] * self.d ** w + v
    def get(self, key, k): return self.s.get((key, k), 0.0)
    def shrink(self, key, f):
        for kk in [kk for kk in self.s if kk[0] == key]: self.s[kk] *= f

team = EW(HL_TEAM); goalie = EW(1); player = EW(HL_PLAYER)
league = defaultdict(lambda: [0.0, 0.0])  # running league totals for priors
def lrate(num, den): n, d = league[num][0], league[den][0]; return n / d if d else np.nan
last_game = {}; last_start = {}; team_starts = defaultdict(list); lineup_norm = {}; team_season = {}; last_lineup = {}
player_pos = {}

def team_feats(t):
    f = {}
    n = team.get(t, 'n')
    def rate(num, den, prior_num, prior_den, per=3600):
        return (team.get(t, num) + K_TEAM * prior_num) / (team.get(t, den) + K_TEAM * prior_den) * per
    ev_toi_pg = lrate('ev_toi', 'games') if league['games'][0] else 2700
    for num, den in [('ev_xgf', 'ev_toi'), ('ev_xga', 'ev_toi'), ('ev_hdf', 'ev_toi'), ('ev_hda', 'ev_toi'),
                     ('pp_xgf', 'pp_toi'), ('pk_xga', 'pk_toi')]:
        pr = lrate(num, den) if league[den][0] else 0.001
        pd_ = lrate(den, 'games') if league['games'][0] else 300
        f[num] = rate(num, den, pr * pd_, pd_)
    for num in ['pp_toi', 'pk_toi', 'all_gf', 'all_ga', 'all_xgf', 'all_xga', 'win']:
        pr = lrate(num, 'games') if league['games'][0] else 0
        f[num + '_pg'] = (team.get(t, num) + K_TEAM * pr) / (team.get(t, 'n') + K_TEAM)
    # finishing & goaltending luck at 5v5, heavily shrunk (PDO-style regression target)
    f['ev_finish'] = (team.get(t, 'ev_gf') - team.get(t, 'ev_raw_xgf')) / (team.get(t, 'ev_toi') + 20 * ev_toi_pg) * 3600
    f['ev_saves'] = (team.get(t, 'ev_raw_xga') - team.get(t, 'ev_ga')) / (team.get(t, 'ev_toi') + 20 * ev_toi_pg) * 3600
    f['ev_xg_share'] = f['ev_xgf'] / (f['ev_xgf'] + f['ev_xga'])
    f['n_games'] = n
    return f

def goalie_feats(g, t, date):
    sh = goalie.get(g, 'shots'); gsax = goalie.get(g, 'gsax')
    f = {'g_gsax100': gsax / (sh + K_GOALIE) * 100, 'g_shots': sh,
         'g_rest': min((date - last_start[g]).days, 10) if g in last_start else 10}
    f['g_b2b'] = int(f['g_rest'] == 1)
    recent = team_starts[t][-20:]
    f['g_share20'] = (recent.count(g) / len(recent)) if recent else 0.5
    return f

def player_value(p):
    toi = player.get(p, 'toi'); pos = player_pos.get(p, 'F')
    prior = 0.55 if pos == 'F' else 0.35  # league-ish (ixG + 0.6*A) per 60 by position
    v60 = (player.get(p, 'ixg') + 0.6 * player.get(p, 'a') + prior * K_PLAYER_TOI / 60) / (toi + K_PLAYER_TOI) * 60
    n = player.get(p, 'n'); etoi = toi / n if n > 0.5 else (15.0 if pos == 'F' else 19.0)
    return v60, etoi

ixg = shots.groupby(['gid', 'shooterPlayerId']).xGoal.sum()
gsh = shots.groupby(['gid', 'goalieIdForShot']).agg(xg=('xGoal', 'sum'), ga=('goal', 'sum'), n=('xGoal', 'size'))
lu = {k: v for k, v in lineups.groupby(['gid', 'side'])}

rows = []
games['d'] = pd.to_datetime(games.date)
for date, day in games.groupby('d', sort=True):
    # ---------- features (state is strictly pre-day)
    for g in day.itertuples():
        r = {'gid': g.gid}
        for side in ('home', 'away'):
            t = getattr(g, side); st = getattr(g, side + '_starter')
            if team_season.get(t) not in (None, g.season):   # new season: carry only part of the evidence
                team.shrink(t, SEASON_CARRY)
            for k, v in team_feats(t).items(): r[f'{side}_{k}'] = v
            for k, v in goalie_feats(st, t, date).items(): r[f'{side}_{k}'] = v
            # OPEN-SAFE: projected starter = most starts in the team's last 10 games (ties -> most recent), no confirmation used
            rec = team_starts[t][-10:]
            proj = max(reversed(rec), key=rec.count) if rec else st
            if rec and proj in last_start and (date - last_start[proj]).days == 1:   # started last night -> backup projected
                others = [x for x in team_starts[t][-30:] if x != proj]
                if others: proj = max(reversed(others), key=others.count)
            for k, v in goalie_feats(proj, t, date).items(): r[f'{side}_o{k}'] = v
            r[f'{side}_o_proj_share10'] = rec.count(proj) / len(rec) if rec else 0.0
            r[f'{side}_starter_is_proj'] = int(proj == st)
            pl = last_lineup.get(t)
            r[f'{side}_o_lineup'] = sum(v * e for v, e in (player_value(p) for p in pl)) / 60 if pl is not None else np.nan
            r[f'{side}_rest'] = min((date - last_game[t]).days, 5) if t in last_game else 5
            r[f'{side}_b2b'] = int(r[f'{side}_rest'] == 1)
            L = lu.get((g.gid, side))
            if L is not None:
                vals = [player_value(p) for p in L.pid]
                strength = sum(v * e for v, e in vals) / 60
                r[f'{side}_lineup'] = strength
                r[f'{side}_lineup_shock'] = strength - lineup_norm.get(t, strength)
            else:
                r[f'{side}_lineup'] = np.nan; r[f'{side}_lineup_shock'] = 0.0
        rows.append(r)
    # ---------- update state with the day's results
    for g in day.itertuples():
        for side, opp in (('home', 'away'), ('away', 'home')):
            t = getattr(g, side); team_season[t] = g.season
            o = obs(g.gid, side)
            if o is not None:
                o['win'] = float(getattr(g, side + '_goals') > getattr(g, opp + '_goals')); o['n'] = 1.0
                team.add(t, o)
                for k, v in o.items(): league[k][0] += v
                league['games'][0] += 1
            last_game[t] = date
            st = getattr(g, side + '_starter'); last_start[st] = date; team_starts[t].append(st)
            L = lu.get((g.gid, side))
            if L is not None:
                vals = [player_value(p) for p in L.pid]
                s = sum(v * e for v, e in vals) / 60
                lineup_norm[t] = s if t not in lineup_norm else 0.85 * lineup_norm[t] + 0.15 * s
                last_lineup[t] = list(L.pid)
                for x in L.itertuples():
                    player_pos[x.pid] = x.pos
                    player.add(x.pid, {'toi': x.toi, 'a': float(x.a), 'ixg': float(ixg.get((g.gid, x.pid), 0.0)), 'n': 1.0})
        # goalies: decay per shot faced
        for (gid, gk), s in gsh.loc[[g.gid]].iterrows() if g.gid in gsh.index.get_level_values(0) else []:
            d = 0.5 ** (s.n / HL_GOALIE_SHOTS)
            goalie.s[(gk, 'shots')] = goalie.get(gk, 'shots') * d + s.n
            goalie.s[(gk, 'gsax')] = goalie.get(gk, 'gsax') * d + (s.xg - s.ga)

F = games.merge(pd.DataFrame(rows), on='gid')
for c in [c[5:] for c in F.columns if c.startswith('home_') and 'away_' + c[5:] in F.columns
          and F[c].dtype.kind in 'fi' and c[5:] not in ('tid', 'goals', 'sog', 'starter', 'pulled')]:
    F['d_' + c] = F['home_' + c] - F['away_' + c]
F.to_parquet('data/cache/features.parquet')
print(F.shape); print(F.filter(like='d_').describe().T[['mean', 'std']].round(3))
