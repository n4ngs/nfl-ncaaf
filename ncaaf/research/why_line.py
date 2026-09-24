"""Why did the line move? The factors the bookmakers cited for #4 Ole Miss +3.5 at #21 Florida (2026 week 4), each
tested out of sample on the 2023-25 holdout, on the same rolling origin as portable.py / move.py:

  1 letdown / bounce-back (open-safe): the away team comes off an emotional win (beat a ranked team or won as an
    underdog) and is on the road; the home team comes off one; lost-as-favourite difference.        (features.py)
  2 venue home edge (open-safe): per home team, walk-forward, shrunk (k_v pseudo-games, decay dec_v per game):
    market view (closing-line residuals home vs away), results view (margin residuals), log attendance. (features.py)
  3 new head coach (open-safe): first-year staff flag (Wikipedia coaching-change tables, fetch_context.py), and
    walk variants where the preseason carry-over / in-season market learning rate differ for new staffs.
  4 reverse line movement: NO historical betting splits exist in any free feed (Action Network returns null
    public/money % for past dates), so it cannot be tested; the app starts recording splits (forward-only).
  5 injury severity: no historical status feed (ESPN's college injuries endpoints are empty); the tested term stays
    the box-score "lead back / receiver out" coefficient, applied live as probability x share (forward-only).
  6 base rate: top-5 team as a road underdog vs an unranked / lower-ranked team (context note only).

Reported per factor: (a) fair-line accuracy = stage-1 holdout RMSE vs the final margin and vs the no-vig close,
(b) move variance explained (stage-2 E R^2, baseline 8.2 %), (c) CLV of bets at the open scored against the close,
Bonferroni over every rule ever tried on this holdout. Also: the win-probability sigma calibration for the app.
Writes data/cache/why_line.json."""
import json, numpy as np, pandas as pd, warnings
from scipy import stats
from sklearn.linear_model import Ridge
from common import load, evaluate, fmt, HOLDOUT, GROUPS, LATE
from features import walk, CFG
warnings.filterwarnings('ignore'); np.seterr(all='ignore')

NEW = ['ld_away_road', 'ld_home', 'd_last_bad', 'd_newc', 'x_venue_m', 'x_venue_r', 'x_att']
def prep(F):
    F['tier_g5'] = (F.tier == 'G5').astype(int); F['tier_fcs'] = (F.tier == 'FCS').astype(int)
    F['x_open'] = F.bet_line; F['x_open_abs'] = F.bet_line.abs(); F['clv_home'] = F.bet_line - F.close
    F['d_newc_early'] = F.d_newc * F.early
    for c in NEW + ['d_newc_early']: F[c] = F[c].replace([np.inf, -np.inf], np.nan).fillna(0.0)
    K = pd.read_parquet('data/cache/keyplayers.parquet')
    for side in ('home', 'away'):
        F = F.merge(K.rename(columns={'team': f'{side}_id', 'rb_out': f'{side}_rb_out', 'wr_out': f'{side}_wr_out', 'rb_share': f'{side}_rb_share', 'wr_share': f'{side}_wr_share'}), on=['gid', f'{side}_id'], how='left')
    for c in [f'{s}_{k}' for s in ('home', 'away') for k in ('rb_out', 'wr_out', 'rb_share', 'wr_share')]: F[c] = F[c].fillna(0)
    F['L_d_rb_out'] = F.home_rb_out * F.home_rb_share - F.away_rb_out * F.away_rb_share
    F['L_d_wr_out'] = F.home_wr_out * F.home_wr_share - F.away_wr_out * F.away_wr_share
    return F

F = prep(load())
S1 = sum(GROUPS.values(), [])
SD = float((F.margin + F.close)[F.season < HOLDOUT[0]].std())
CTX2 = ['x_open', 'x_open_abs', 'early', 'home', 'min_n', 'tier_g5', 'tier_fcs', 'conf_game', 'd_mkt', 'd_talent', 'd_qb_pepa', 'd_qb_starts']
REC = ['d_last_ats', 'd_last_upset', 'd_last_blowout']; KEY = ['L_d_rb_out', 'L_d_wr_out']
E_COLS = ['x_gap'] + CTX2 + REC + LATE + KEY
FACT = {'letdown': ['ld_away_road', 'ld_home', 'd_last_bad'], 'venue_market': ['x_venue_m'], 'venue_results': ['x_venue_r'],
        'venue_attendance': ['x_att'], 'new_coach': ['d_newc', 'd_newc_early']}

def fit(D, mask, cols, target, alpha=30.0):
    X = D.loc[mask, cols].values.astype(float); mu, sd = X.mean(0), X.std(0) + 1e-9
    r = Ridge(alpha=alpha).fit((X - mu) / sd, D.loc[mask, target].values)
    return {'features': cols, 'mean': mu.tolist(), 'std': sd.tolist(), 'coef': r.coef_.tolist(), 'intercept': float(r.intercept_)}
def pred(m, D, mask):
    return ((D.loc[mask, m['features']].values.astype(float) - np.array(m['mean'])) / np.array(m['std'])) @ np.array(m['coef']) + m['intercept']

def stage1(D, cols, seasons=range(2017, 2026)):
    out = pd.Series(np.nan, index=D.index)
    for S in seasons:
        tr = D.season.between(2015, S - 1); te = D.season == S
        out[te] = pred(fit(D, tr, cols, 'margin'), D, te)
    return out
def s1_report(D, m):
    H = D.season.isin(HOLDOUT) & m.notna()
    hc = H & D.close.notna()
    return {'rmse_margin': round(float(np.sqrt(((m[H] - D.margin[H]) ** 2).mean())), 4),
            'rmse_vs_close': round(float(np.sqrt(((m[hc] + D.close[hc]) ** 2).mean())), 4),
            'by_season': {int(S): round(float(np.sqrt(((m[H & (D.season == S)] - D.margin[H & (D.season == S)]) ** 2).mean())), 3) for S in HOLDOUT}}

def stage2(D, cols, mfund):
    D = D.assign(x_gap=mfund + D.bet_line)
    mk = (D.bet_line.notna() & D.close.notna() & mfund.notna())
    pm = pd.Series(np.nan, index=D.index)
    for S in HOLDOUT:
        tr = mk & (D.season < S); te = mk & (D.season == S)
        pm[te] = pred(fit(D, tr, cols, 'clv_home'), D, te)
    H = D[D.season.isin(HOLDOUT) & mk].assign(pm=pm)
    y, p = H.clv_home.values, H.pm.values
    return H, {'r2': round(float(1 - np.sum((y - p) ** 2) / np.sum((y - y.mean()) ** 2)), 4), 'corr': round(float(np.corrcoef(p, y)[0, 1]), 3)}

RULES = []   # every CLV rule scored here (Bonferroni)
def rule(name, H, col, thr):
    s = H[H[col].abs() >= thr]; r = evaluate(s, (s[col] > 0).values, SD)
    r['by_season'] = {int(S): evaluate(s[s.season == S], (s[s.season == S][col] > 0).values, SD).get('clv_ev_pct') for S in HOLDOUT}
    RULES.append((name, r)); return r

rep = {'stage1': {}, 'move': {}, 'clv': {}}
base_m = stage1(F, S1); F['m_base'] = base_m
rep['stage1']['baseline (32 inputs)'] = s1_report(F, base_m)
HE, rep['move']['E baseline'] = stage2(F, E_COLS, base_m)
HA, rep['move']['A baseline'] = stage2(F, ['x_gap'] + CTX2, base_m)
print('baseline stage 1', rep['stage1']['baseline (32 inputs)'], '| move E', rep['move']['E baseline'], '| A', rep['move']['A baseline'], flush=True)
for name, cols in FACT.items():
    m = stage1(F, S1 + cols); rep['stage1'][name] = s1_report(F, m)
    H, rep['move'][name] = stage2(F, E_COLS + cols, m)
    HA_, a = stage2(F, ['x_gap'] + CTX2 + cols, m); rep['move'][name + ' (open-safe A)'] = a
    rep['clv'][name] = {'A>=1.0': rule(name + ' A>=1.0', HA_, 'pm', 1.0), 'A>=1.5': rule(name + ' A>=1.5', HA_, 'pm', 1.5), 'E>=1.5': rule(name + ' E>=1.5', H, 'pm', 1.5)}
    print(f"{name:18s} s1 {rep['stage1'][name]} | move E {rep['move'][name]} A {a}", flush=True)
    for k, r in rep['clv'][name].items(): print(f'    {k}: {fmt(r)} seasons {r.get("by_season")}', flush=True)

# direct rule: the move itself. Does the line move against a road team in a letdown spot (bet HOME at the open)?
L = F[F.season.isin(HOLDOUT) & F.bet_line.notna() & F.close.notna() & (F.ld_away_road == 1)]
rep['clv']['letdown direct'] = {'fade road letdown team at open': rule('letdown direct', L.assign(pm=1.0), 'pm', 0.5),
                                'mean move toward home (pts)': round(float(L.clv_home.mean()), 3), 'all games': round(float(F[F.season.isin(HOLDOUT)].clv_home.mean()), 3), 'n': int(len(L))}
print('letdown direct', fmt(rep['clv']['letdown direct']['fade road letdown team at open']), 'mean move', rep['clv']['letdown direct']['mean move toward home (pts)'], 'vs all', rep['clv']['letdown direct']['all games'])

# new-staff walk variants (carry / learning rate); config picked on 2017-2022 only, then the holdout
recs = json.load(open('data/cache/walk_recs.json'))
WALKC = GROUPS['team'] + ['d_mkt', 'd_qb_starts', 'd_qb_pepa', 'd_rest', 'min_n']
def walk_feats(cfg):
    fx, _ = walk(recs, cfg)
    X = pd.DataFrame([{'gid': g, **{k: f[k] for k in WALKC}} for g, f in fx.items()])
    D = F.drop(columns=WALKC).merge(X, on='gid', how='left')
    for c in WALKC: D[c] = D[c].replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return D
grid = [dict(carry_nc=c, carry_m_nc=cm, lr_m_nc=lr) for c in (0.7, 0.5, 0.3) for cm in (0.95, 0.8) for lr in (0.4, 0.55)]
pre = []
for g in grid:
    D = walk_feats({**CFG, **g}); m = stage1(D, S1, seasons=range(2017, 2023)); mm = m.notna() & D.season.between(2017, 2022)
    pre.append((float(np.sqrt(((m[mm] - D.margin[mm]) ** 2).mean())), g)); print('pre-holdout', round(pre[-1][0], 4), g, flush=True)
best = min(pre, key=lambda x: x[0])[1]
D = walk_feats({**CFG, **best}); m = stage1(D, S1); rep['stage1']['new_coach carry/lr ' + json.dumps(best)] = s1_report(D, m)
HN, rep['move']['new_coach carry/lr'] = stage2(D, E_COLS, m)
rep['clv']['new_coach carry/lr'] = {'E>=1.5': rule('new_coach walk E>=1.5', HN, 'pm', 1.5)}
rep['new_coach_grid'] = [{'rmse_2017_22': round(r, 4), **g} for r, g in pre]
print('new-coach walk best', best, rep['stage1']['new_coach carry/lr ' + json.dumps(best)], rep['move']['new_coach carry/lr'], flush=True)

# all open-safe factors that helped stage 1, together (the shipped candidate)
ALL = ['ld_away_road', 'ld_home', 'd_last_bad', 'x_venue_m', 'x_venue_r', 'x_att', 'd_newc', 'd_newc_early']
m = stage1(F, S1 + ALL); rep['stage1']['all new'] = s1_report(F, m); F['m_all'] = m
H, rep['move']['all new'] = stage2(F, E_COLS + ALL, m)
rep['clv']['all new'] = {'E>=1.5': rule('all new E>=1.5', H, 'pm', 1.5), 'E>=1.0': rule('all new E>=1.0', H, 'pm', 1.0)}
HA_, rep['move']['all new (open-safe A)'] = stage2(F, ['x_gap'] + CTX2 + ALL, m)
rep['clv']['all new']['A>=1.0'] = rule('all new A>=1.0', HA_, 'pm', 1.0); rep['clv']['all new']['A>=1.5'] = rule('all new A>=1.5', HA_, 'pm', 1.5)
print('ALL new', rep['stage1']['all new'], rep['move']['all new'], rep['move']['all new (open-safe A)'])

# SHIPPED candidate: new-staff walk (best config above) + letdown / bounce-back in stage 1 and in the move model E
LD = FACT['letdown']
DS = walk_feats({**CFG, **best}); m = stage1(DS, S1 + LD); rep['stage1']['shipped: new-staff walk + letdown'] = s1_report(DS, m); F['m_ship'] = m.values
HS, rep['move']['shipped: new-staff walk + letdown'] = stage2(DS, E_COLS + LD, m)
rep['clv']['shipped'] = {'E>=1.5': rule('shipped E>=1.5', HS, 'pm', 1.5)}
HSA, rep['move']['shipped (open-safe A)'] = stage2(DS, ['x_gap'] + CTX2 + LD, m)
rep['clv']['shipped']['A>=1.0'] = rule('shipped A>=1.0', HSA, 'pm', 1.0); rep['clv']['shipped']['A>=1.5'] = rule('shipped A>=1.5', HSA, 'pm', 1.5)
print('SHIPPED', rep['stage1']['shipped: new-staff walk + letdown'], rep['move']['shipped: new-staff walk + letdown'], rep['move']['shipped (open-safe A)'], flush=True)

# Bonferroni over every rule ever scored on this holdout (136 before this file)
BONF = 136 + len(RULES); rep['bonferroni_factor'] = BONF
for name, r in RULES:
    ok = r.get('bets', 0) >= 30 and all((v or -1) > 0 for v in r['by_season'].values())
    r['p_bonferroni'] = min(1.0, r['p'] * BONF) if 'p' in r else None
    r['proven'] = bool(ok and r['p_bonferroni'] is not None and r['p_bonferroni'] < 0.05)
    print(f'{name:28s} {fmt(r)} p_bonf {r["p_bonferroni"]} seasons {r["by_season"]} {"PROVEN" if r["proven"] else ""}')

# base rate: top-5 team as a ROAD underdog vs an unranked / lower-ranked home team (closing line)
B = F[(F.neutral == 0) & F.close.notna() & (F.away_rank <= 5) & (F.home_rank > F.away_rank) & (F.close < 0)] if 'away_rank' in F else F.iloc[:0]
rep['base_rate'] = {'games': int(len(B)), 'top5_won': int((B.margin < 0).sum()), 'top5_covered': int((B.margin + B.close < 0).sum()),
                    'list': [f"{int(r.season)} {int(r.gid)} rank {int(r.away_rank)} at {int(r.home_rank)}: close {r.close:+.1f}, margin {int(r.margin):+d}" for r in B.itertuples()]}
print('base rate', rep['base_rate'])

# win probability: P(home wins) = Phi(margin / sigma). sigma chosen on 2017-2022 (log loss), checked on the holdout
def ll(p, y): p = np.clip(p, 1e-6, 1 - 1e-6); return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
W = F[F.m_ship.notna() & (F.margin != 0)].assign(m_all=lambda d: d.m_ship)
pre_ = W[W.season.between(2017, 2022)]; hold = W[W.season.isin(HOLDOUT)]
sig_h = min(np.arange(10, 26, 0.25), key=lambda s: ll(stats.norm.cdf(hold.m_all / s), (hold.margin > 0).values))
sig = min(np.arange(10, 26, 0.25), key=lambda s: ll(stats.norm.cdf(pre_.m_all / s), (pre_.margin > 0).values))
wp = {}
for s in (16.0, float(sig)):
    p = stats.norm.cdf(hold.m_all / s); y = (hold.margin > 0).values
    bins = pd.cut(p, [0, .1, .2, .3, .4, .5, .6, .7, .8, .9, 1])
    rel = pd.DataFrame({'p': p, 'y': y, 'b': bins}).groupby('b').agg(n=('y', 'size'), pred=('p', 'mean'), won=('y', 'mean')).round(3)
    wp[str(round(s, 2))] = {'logloss': round(ll(p, y), 4), 'brier': round(float(np.mean((p - y) ** 2)), 4), 'n': int(len(y)),
                            'reliability': rel.reset_index().astype(str).to_dict('records')}
rep['win_prob'] = {'sigma_pre_holdout': round(float(sig), 2), 'sigma_holdout_best': round(float(sig_h), 2), 'holdout': wp}
print('win prob sigma (2017-22 log loss)', sig, {k: (v['logloss'], v['brier']) for k, v in wp.items()})
json.dump(rep, open('data/cache/why_line.json', 'w'), indent=1, default=str)
