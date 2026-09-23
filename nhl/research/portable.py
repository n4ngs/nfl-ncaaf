"""Portable open-safe model: features computable in the live Node app from MoneyPuck season shot files + NHL results.

Features (home minus away unless noted), all pregame, walk-forward:
  team:   exponentially weighted per-game 5v5 xGF / xGA, high-danger (xG >= 0.2) 5v5 xGF / xGA, PP xGF, PK xGA,
          goals for / against, win rate (shrunk toward league average, half carried over the summer)
  goalie: PROJECTED starter (most starts in last 10, backup if the No.1 started last night): shrunk GSAx per 100
          unblocked shots, log shots faced, start share of last 20, back-to-back
  sched:  rest days, back-to-backs
Starter of a past game = the goalie who faced the most unblocked shots for that team (same rule in Node).
Stage 1 logistic regression (outcome), stage 2 ridge (open->close line move). Exports nhl-vas-model.json.
"""
import json, warnings, numpy as np, pandas as pd
from collections import defaultdict
from scipy import stats
from sklearn.linear_model import LogisticRegression, Ridge
warnings.filterwarnings('ignore'); np.seterr(all='ignore')

CFG = dict(hl_team=30.0, k_team=10.0, carry=0.5, hl_goalie_shots=2500.0, k_goalie=1200.0, hd=0.2, hl_player=40.0, k_player_toi=300.0, prior_f=0.55, prior_d=0.35, assist_w=0.6)
lineups = pd.read_parquet('data/cache/lineups.parquet')
games = pd.read_parquet('data/cache/games.parquet').sort_values(['start', 'gid']).reset_index(drop=True)
import os
PARITY = os.environ.get('PARITY')
if PARITY: games = games[games.season >= int(PARITY)].reset_index(drop=True); lineups = lineups[lineups.gid.isin(games.gid)]
sh = pd.read_parquet('data/cache/shots.parquet')
sh = sh[sh.gid.isin(games.gid)]

# ---------- per team-game observations from shots only
sh['team_side'] = np.where(sh.isHomeTeam == 1, 'home', 'away')
own = np.where(sh.isHomeTeam == 1, sh.homeSkatersOnIce, sh.awaySkatersOnIce)
opp = np.where(sh.isHomeTeam == 1, sh.awaySkatersOnIce, sh.homeSkatersOnIce)
en = sh.shotOnEmptyNet.fillna(0).astype(int) == 1
sh['ev'] = (own == 5) & (opp == 5) & ~en
sh['pp'] = (own > opp) & ~en
sh['hd'] = sh.ev & (sh.xGoal >= CFG['hd'])
agg = defaultdict(lambda: defaultdict(float))
for r in sh[['gid', 'team_side', 'xGoal', 'ev', 'pp', 'hd']].itertuples(index=False):
    a = agg[(r.gid, r.team_side)]; b = agg[(r.gid, 'away' if r.team_side == 'home' else 'home')]
    if r.ev: a['ev_xgf'] += r.xGoal; b['ev_xga'] += r.xGoal
    if r.hd: a['hd_xgf'] += r.xGoal; b['hd_xga'] += r.xGoal
    if r.pp: a['pp_xgf'] += r.xGoal; b['pk_xga'] += r.xGoal
g_ok = sh[~en & sh.goalieIdForShot.fillna(0).gt(0)]
gstat = g_ok.groupby(['gid', 'goalieIdForShot']).agg(xg=('xGoal', 'sum'), ga=('goal', 'sum'), n=('xGoal', 'size')).reset_index()
# the defending team's goalie: shots by the home team are faced by the away goalie
g_ok = g_ok.assign(def_side=np.where(g_ok.isHomeTeam == 1, 'away', 'home'))
faced = g_ok.groupby(['gid', 'def_side', 'goalieIdForShot']).size().reset_index(name='n')
starter_of = faced.sort_values(['n', 'goalieIdForShot'], kind='mergesort').groupby(['gid', 'def_side']).goalieIdForShot.last().to_dict()   # most shots faced, ties -> larger id (same rule in Node)

TEAM_KEYS = ['ev_xgf', 'ev_xga', 'hd_xgf', 'hd_xga', 'pp_xgf', 'pk_xga', 'gf', 'ga', 'win']
d_team = 0.5 ** (1 / CFG['hl_team'])
T = defaultdict(lambda: defaultdict(float)); league = defaultdict(float); season_of = {}
G = defaultdict(lambda: [0.0, 0.0]); last_start = {}; starts = defaultdict(list); last_game = {}

def team_feats(t):
    n = T[t]['n']; out = {}
    for k in TEAM_KEYS:
        prior = league[k] / league['n'] if league['n'] else 0.0
        out[k] = (T[t][k] + CFG['k_team'] * prior) / (n + CFG['k_team'])
    return out
def goalie_feats(gk, t, day):
    s, x = G[gk]
    rec = starts[t][-20:]
    rest = min((day - last_start[gk]).days, 10) if gk in last_start else 10
    return {'gsax100': x / (s + CFG['k_goalie']) * 100, 'logshots': np.log1p(s), 'share20': rec.count(gk) / len(rec) if rec else 0.5, 'gb2b': int(rest == 1)}
def project(t, day):
    rec = starts[t][-10:]
    if not rec: return None, 0.0
    p = max(reversed(rec), key=rec.count)
    if p in last_start and (day - last_start[p]).days == 1:
        others = [x for x in starts[t][-30:] if x != p]
        if others: p = max(reversed(others), key=others.count)
    return p, rec.count(p) / len(rec)

# ---------- player values for the lineup feature (NHL boxscore TOI/assists + MoneyPuck individual xG)
ixg = sh[~en].groupby(['gid', 'shooterPlayerId']).xGoal.sum().to_dict()
LU = {k: v for k, v in lineups.groupby(['gid', 'side'])}
d_pl = 0.5 ** (1 / CFG['hl_player']); PL = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0]); POS = {}; last_lineup = {}
def pvalue(pid):
    toi, a, x, n = PL[pid]; pos = POS.get(pid, 'F'); prior = CFG['prior_f'] if pos == 'F' else CFG['prior_d']
    v60 = (x + CFG['assist_w'] * a + prior * CFG['k_player_toi'] / 60) / (toi + CFG['k_player_toi']) * 60
    etoi = toi / n if n > 0.5 else (15.0 if pos == 'F' else 19.0)
    return v60 * etoi / 60
rows = []
games['day'] = pd.to_datetime(games.date)
for day, dg in games.groupby('day', sort=True):
    for g in dg.itertuples():
        r = {'gid': g.gid}
        for side in ('home', 'away'):
            t = getattr(g, side)
            if season_of.get(t) not in (None, g.season):
                for k in list(T[t]): T[t][k] *= CFG['carry']
            for k, v in team_feats(t).items(): r[f'{side}_{k}'] = v
            p, share10 = project(t, day)
            gf = goalie_feats(p, t, day) if p else {'gsax100': 0.0, 'logshots': 0.0, 'share20': 0.0, 'gb2b': 0}
            for k, v in gf.items(): r[f'{side}_{k}'] = v
            r[f'{side}_share10'] = share10; r[f'{side}_proj'] = p
            rest = min((day - last_game[t]).days, 5) if t in last_game else 5
            r[f'{side}_rest'] = rest; r[f'{side}_b2b'] = int(rest == 1)
            pl = last_lineup.get(t); r[f'{side}_lineup'] = sum(pvalue(x) for x in pl) if pl else np.nan
        rows.append(r)
    for g in dg.itertuples():
        for side, o in (('home', 'away'), ('away', 'home')):
            t = getattr(g, side); season_of[t] = g.season; last_game[t] = day
            a = agg[(g.gid, side)]
            obs = {k: a.get(k, 0.0) for k in TEAM_KEYS[:6]}
            obs['gf'] = getattr(g, side + '_goals'); obs['ga'] = getattr(g, o + '_goals'); obs['win'] = float(obs['gf'] > obs['ga']); obs['n'] = 1.0
            for k, v in obs.items():
                T[t][k] = T[t][k] * d_team + v; league[k] += v
            L = LU.get((g.gid, side))
            if L is not None:
                last_lineup[t] = list(L.pid)
                for x in L.itertuples():
                    POS[x.pid] = x.pos; q = PL[x.pid]
                    q[0] = q[0] * d_pl + x.toi; q[1] = q[1] * d_pl + x.a; q[2] = q[2] * d_pl + ixg.get((g.gid, x.pid), 0.0); q[3] = q[3] * d_pl + 1
            st = starter_of.get((g.gid, side))
            if st: starts[t].append(int(st)); last_start[int(st)] = day
    for x in gstat[gstat.gid.isin(dg.gid)].itertuples():
        d = 0.5 ** (x.n / CFG['hl_goalie_shots']); s = G[int(x.goalieIdForShot)]
        s[0] = s[0] * d + x.n; s[1] = s[1] * d + (x.xg - x.ga)

F = games.merge(pd.DataFrame(rows), on='gid')
if PARITY:
    os.makedirs('data/cache/parity', exist_ok=True)
    LUg = lineups.groupby(['gid', 'side'])
    hist = {'games': [], 'shots': []}
    for g in games.itertuples():
        lu = {}
        for side in ('home', 'away'):
            try: L = LUg.get_group((g.gid, side)); lu[side] = [{'pid': int(x.pid), 'pos': x.pos, 'toi': float(x.toi), 'a': int(x.a)} for x in L.itertuples()]
            except KeyError: lu[side] = []
        hist['games'].append({'gid': int(g.gid), 'season': int(g.season), 'day': g.date, 'start': g.start, 'home': g.home, 'away': g.away,
                              'homeGoals': int(g.home_goals), 'awayGoals': int(g.away_goals), 'lineups': lu})
    for x in sh.itertuples():
        hist['shots'].append({'gid': int(x.gid), 'home': bool(x.isHomeTeam == 1), 'xg': float(x.xGoal), 'goal': int(x.goal), 'hs': int(x.homeSkatersOnIce),
                              'as': int(x.awaySkatersOnIce), 'en': bool(x.shotOnEmptyNet == 1), 'goalie': int(x.goalieIdForShot) if x.goalieIdForShot == x.goalieIdForShot else 0,
                              'shooter': int(x.shooterPlayerId) if x.shooterPlayerId == x.shooterPlayerId else 0})
    json.dump(hist, open('data/cache/parity/history.json', 'w'))
    F.drop(columns=[c for c in F.columns if c.endswith('_proj')] ).to_json('data/cache/parity/features_py.json', orient='records')
    print('parity fixture written', len(hist['games']), 'games', len(hist['shots']), 'shots'); raise SystemExit
S1 = []
for k in TEAM_KEYS + ['gsax100', 'logshots']:
    F['d_' + k] = F['home_' + k] - F['away_' + k]; S1.append('d_' + k)
F['d_rest'] = F.home_rest - F.away_rest
F['d_lineup'] = (F.home_lineup - F.away_lineup).fillna(0.0)
S1 += ['d_lineup', 'd_rest', 'home_b2b', 'away_b2b', 'home_share20', 'away_share20', 'home_share10', 'away_share10', 'home_gb2b', 'away_gb2b']
M = pd.read_parquet('data/cache/predictions.parquet')[['gid', 'mkt_open', 'mkt_close', 'bet_open_h', 'bet_open_a']]
F = F.merge(M, on='gid', how='left')
F = F[F.season >= 2016].reset_index(drop=True)
logit = lambda p: np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
ll = lambda p, y: float(-np.mean(y * np.log(np.clip(p, 1e-6, 1 - 1e-6)) + (1 - y) * np.log(1 - np.clip(p, 1e-6, 1 - 1e-6))))

def fit_s1(tr):
    X = F.loc[tr, S1].values; mu, sd = X.mean(0), X.std(0) + 1e-9
    m = LogisticRegression(C=0.3, max_iter=4000).fit((X - mu) / sd, F.y[tr])
    return {'features': S1, 'mean': mu.tolist(), 'std': sd.tolist(), 'coef': m.coef_[0].tolist(), 'intercept': float(m.intercept_[0])}
def pred_s1(mod, idx):
    X = (F.loc[idx, mod['features']].values - np.array(mod['mean'])) / np.array(mod['std'])
    return 1 / (1 + np.exp(-(X @ np.array(mod['coef']) + mod['intercept'])))
for S in range(2018, 2026):
    tr = F.season.between(2016, S - 1); te = F.season == S
    F.loc[te, 'p_fund'] = pred_s1(fit_s1(tr), te)
    print(f'stage1 {S}: logloss {ll(F.p_fund[te], F.y[te]):.4f}', flush=True)

S2 = ['x_gap', 'x_open', 'home_share10', 'away_share10', 'home_gb2b', 'away_gb2b', 'home_b2b', 'away_b2b', 'd_gsax100', 'd_ev_xgf', 'd_ev_xga']
F['x_gap'] = logit(F.p_fund) - logit(F.mkt_open); F['x_open'] = logit(F.mkt_open); F['move'] = logit(F.mkt_close) - logit(F.mkt_open)
mk = F.mkt_open.notna() & F.mkt_close.notna()
def fit_s2(tr):
    X = F.loc[tr, S2].values; mu, sd = X.mean(0), X.std(0) + 1e-9
    r = Ridge(alpha=10).fit((X - mu) / sd, F.move[tr])
    return {'features': S2, 'mean': mu.tolist(), 'std': sd.tolist(), 'coef': r.coef_.tolist(), 'intercept': float(r.intercept_)}
def pred_s2(mod, idx):
    X = (F.loc[idx, mod['features']].values - np.array(mod['mean'])) / np.array(mod['std']); return X @ np.array(mod['coef']) + mod['intercept']
for S in (2024, 2025):
    tr = mk & F.season.between(2023, S - 1); te = mk & (F.season == S)
    F.loc[te, 'pred_move'] = pred_s2(fit_s2(tr), te)
    print(f'stage2 {S}: corr {np.corrcoef(F.pred_move[te], F.move[te])[0,1]:.3f}', flush=True)

dec = lambda a: 1 + (a / 100 if a > 0 else 100 / -a)
H = F[F.season.isin([2024, 2025]) & mk & F.bet_open_h.notna()].copy()
report = {}
for thr in (0.05, 0.08, 0.10):
    s = H[H.pred_move.abs() >= thr]; side = (s.pred_move > 0).values
    po = np.where(side, s.bet_open_h, s.bet_open_a).astype(float); pc = np.where(side, s.mkt_close, 1 - s.mkt_close)
    ev = pc * np.array([dec(a) for a in po]) - 1; clv = np.where(side, s.mkt_close - s.mkt_open, s.mkt_open - s.mkt_close)
    t = stats.ttest_1samp(ev, 0, alternative='greater'); per = {int(S): round(float(ev[(s.season == S).values].mean() * 100), 2) for S in (2024, 2025)}
    report[thr] = {'bets': int(len(ev)), 'clv_ev_pct': round(float(ev.mean() * 100), 2), 't': round(float(t.statistic), 2), 'p': float(t.pvalue), 'beat_close': round(float((clv > 0).mean()), 3), 'by_season': per}
    print(f'portable pred_move >= {thr}: {report[thr]}', flush=True)

# ---------- production export: fit on everything available
final = {'version': 'nhl-vas-portable-v1', 'trained_at': pd.Timestamp.utcnow().isoformat(), 'config': CFG,
         'stage1': fit_s1(F.season.between(2016, 2025)), 'stage2': fit_s2(mk & F.season.between(2023, 2025)),
         'tiers': {'diamond': 0.08, 'gold': 0.05}, 'holdout_report': {str(k): v for k, v in report.items()},
         'notes': 'diamond threshold is the tier that beat the no-vig close on the 2024-26 holdout; gold is a lean, not proven.'}
json.dump(final, open('data/cache/nhl-vas-model.json', 'w'), indent=1)
F[['gid', 'season', 'home', 'away', 'p_fund', 'pred_move'] + S1 + ['home_proj', 'away_proj']].to_parquet('data/cache/portable_feats.parquet')
print('exported data/cache/nhl-vas-model.json')
