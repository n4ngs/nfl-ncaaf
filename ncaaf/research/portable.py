"""Portable (Node, zero-dependency) model: ridge stage 1 + ridge stage 2, same features as features.py computes.

Stage 1  ridge on the home margin from the open-safe team / market-rating / preseason / QB / context features.
Stage 2  ridge on the CLV of a home bet at the bet book's open (open line - consensus close, points), three variants:
           A  open-safe (stage-1 gap vs the open + context)                         <- the production default
           B  A + this book's open minus the median open across books (cross-book)   research: timing caveat
           C  A + the actual (first-snap) starting QB features                       research: late news
Totals   ridge stage 1 on total points, ridge stage 2 on the CLV of an OVER at the open (A and B).
Holdout 2023-2025 re-checked with this exact portable math; tiers are marked PROVEN only if the holdout CLV EV is
positive in every season and significant after Bonferroni over every rule tried on the holdout (proof + ablation + here).
Exports data/cache/ncaaf-vas-model.json fit on all seasons (stage 2 trained on out-of-sample stage-1 gaps).
"""
import json, numpy as np, pandas as pd, warnings, datetime as dt
from sklearn.linear_model import Ridge
from common import load, evaluate, GROUPS, LATE, HOLDOUT, fmt
from features import CFG, STATS
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
F = load()
F['tier_g5'] = (F.tier == 'G5').astype(int); F['tier_fcs'] = (F.tier == 'FCS').astype(int)
F['x_open'] = F.bet_line; F['x_open_abs'] = F.bet_line.abs(); F['x_open_vs_cons'] = (F.bet_line - F.open).fillna(0.0)
F['clv_home'] = F.bet_line - F.close
LD = ['ld_away_road', 'ld_home', 'd_last_bad']   # letdown / bounce-back (why_line.py: improves holdout stage 1 + move R2)
S1 = sum(GROUPS.values(), []) + LD
SD = float((F.margin + F.close)[F.season < HOLDOUT[0]].std()); TSD = float((F.total - F.tclose)[F.season < HOLDOUT[0]].std())
CTX2 = ['x_open', 'x_open_abs', 'early', 'home', 'min_n', 'tier_g5', 'tier_fcs', 'conf_game', 'd_mkt', 'd_talent', 'd_qb_pepa', 'd_qb_starts']
# key skill players (late news): lead back / lead receiver absent, weighted by his share (keyplayers.py)
K = pd.read_parquet('data/cache/keyplayers.parquet')
for side in ('home', 'away'):
    F = F.merge(K.rename(columns={'team': f'{side}_id', 'rb_out': f'{side}_rb_out', 'wr_out': f'{side}_wr_out', 'rb_share': f'{side}_rb_share', 'wr_share': f'{side}_wr_share'}), on=['gid', f'{side}_id'], how='left')
for c in [f'{s}_{k}' for s in ('home', 'away') for k in ('rb_out', 'wr_out', 'rb_share', 'wr_share')]: F[c] = F[c].fillna(0)
F['L_d_rb_out'] = F.home_rb_out * F.home_rb_share - F.away_rb_out * F.away_rb_share
F['L_d_wr_out'] = F.home_wr_out * F.home_wr_share - F.away_wr_out * F.away_wr_share
REC = ['d_last_ats', 'd_last_upset', 'd_last_blowout']
KEY = ['L_d_rb_out', 'L_d_wr_out']
# E = "explain the move": everything known by kickoff (recency + QB + key players). Explanation model, late news.
S2 = {'A': ['x_gap'] + CTX2, 'B': ['x_gap'] + CTX2 + ['x_open_vs_cons'], 'C': ['x_gap'] + CTX2 + LATE, 'E': ['x_gap'] + CTX2 + REC + LATE + KEY + LD}
TOT1 = ['t_pts', 't_plays', 'early', 'min_n', 'neutral', 'home_fbs', 'away_fbs']
TOT2 = {'A': ['tx_gap', 'tx_open', 'early', 'min_n', 'tier_g5', 'tier_fcs', 'x_open_abs'], 'B': ['tx_gap', 'tx_open', 'early', 'min_n', 'tier_g5', 'tier_fcs', 'x_open_abs', 'tx_open_vs_cons']}

def fit(mask, cols, target, alpha=30.0):
    X = F.loc[mask, cols].values.astype(float); mu, sd = X.mean(0), X.std(0) + 1e-9
    r = Ridge(alpha=alpha).fit((X - mu) / sd, F.loc[mask, target].values)
    return {'features': cols, 'mean': mu.tolist(), 'std': sd.tolist(), 'coef': r.coef_.tolist(), 'intercept': float(r.intercept_), 'target': target, 'n': int(mask.sum())}
def pred(mod, mask):
    X = (F.loc[mask, mod['features']].values.astype(float) - np.array(mod['mean'])) / np.array(mod['std']); return X @ np.array(mod['coef']) + mod['intercept']

for S in range(2017, 2026):
    tr = F.season.between(2015, S - 1); te = F.season == S
    F.loc[te, 'm_fund'] = pred(fit(tr, S1, 'margin'), te); F.loc[te, 't_fund'] = pred(fit(tr, TOT1, 'total'), te)
F['x_gap'] = F.m_fund + F.bet_line
F['tx_gap'] = F.t_fund - F.tbet_line; F['tx_open'] = F.tbet_line; F['tclv_over'] = F.tclose - F.tbet_line
F['tx_open_vs_cons'] = (F.tbet_line - F.topen).fillna(0.0); F['x_open_abs'] = F.x_open_abs.fillna(F.x_open_abs.median())
mk = F.bet_line.notna() & F.close.notna() & F.m_fund.notna()
tk = F.tbet_line.notna() & F.tclose.notna() & F.t_fund.notna()
proof = json.load(open('data/cache/proof.json'))
# conservative: every rule ever scored on the holdout during this research, including two earlier exploratory proof.py
# runs (20 + 32 rules) made while the pipeline was being built, + ablate.py (10 configs x 2 thresholds)
n_prior = proof.get('n_rules_spread', 0) + proof.get('n_rules_totals', 0) + 20 + 52 + 10   # + move.py (5 variants x 2)
n_prior += 10 + json.load(open('data/cache/why_line.json'))['bonferroni_factor'] - 136   # move.py (10) + why_line.py rules
THR = (0.5, 1.0, 1.5)
n_here = len(S2) * len(THR) + len(TOT2) * len(THR)
BONF = n_prior + n_here
print(f'margin SD {SD:.2f}  total SD {TSD:.2f}  | Bonferroni factor = {BONF} rules tried on the holdout in total')
report = {'bonferroni_factor': BONF, 'spread': {}, 'totals': {}}
def check(kind, var, col, thr, T, sd):
    s = T[T[col].abs() >= thr]; side = (s[col] > 0).values
    r = evaluate(s, side, sd, kind=kind); r['by_season'] = {int(S): evaluate(s[s.season == S], (s[s.season == S][col] > 0).values, sd, kind=kind) for S in HOLDOUT}
    ok = r.get('bets', 0) >= 30 and all(v.get('clv_ev_pct', -1) > 0 for v in r['by_season'].values())
    r['p_bonferroni'] = min(1.0, r.get('p', 1.0) * BONF) if 'p' in r else None
    r['proven'] = bool(ok and r['p_bonferroni'] is not None and r['p_bonferroni'] < 0.05)
    print(f'{kind:6s} {var} >= {thr}: {fmt(r)} | p_bonf {r["p_bonferroni"] if r["p_bonferroni"] is None else round(r["p_bonferroni"], 4)} | ' +
          ' '.join(f"{S}: {v.get('clv_ev_pct', float('nan')):+.2f}% n={v['bets']}" for S, v in r['by_season'].items()) + ('  PROVEN' if r['proven'] else ''), flush=True)
    return r
for var, cols in S2.items():
    for S in HOLDOUT:
        tr = mk & (F.season < S); te = mk & (F.season == S)
        F.loc[te, 'pm_' + var] = pred(fit(tr, cols, 'clv_home'), te)
    T = F[F.season.isin(HOLDOUT) & mk]
    c = {int(S): round(float(np.corrcoef(T['pm_' + var][T.season == S], T.clv_home[T.season == S])[0, 1]), 3) for S in HOLDOUT}
    print(f'spread stage 2 [{var}] corr by season {c}')
    report['spread'][var] = {'corr': c, 'rules': {str(t): check('spread', var, 'pm_' + var, t, T, SD) for t in THR}}
for var, cols in TOT2.items():
    for S in HOLDOUT:
        tr = tk & (F.season < S); te = tk & (F.season == S)
        F.loc[te, 'tm_' + var] = pred(fit(tr, cols, 'tclv_over'), te)
    T = F[F.season.isin(HOLDOUT) & tk]
    c = {int(S): round(float(np.corrcoef(T['tm_' + var][T.season == S], T.tclv_over[T.season == S])[0, 1]), 3) for S in HOLDOUT}
    print(f'totals stage 2 [{var}] corr by season {c}')
    report['totals'][var] = {'corr': c, 'rules': {str(t): check('total', var, 'tm_' + var, t, T, TSD) for t in THR}}

# ---------------------------------------------------------------- production export (all seasons)
allS = F.season.between(2015, 2025)
def tiers(rep):
    proven = [float(t) for t, r in rep['rules'].items() if r['proven']]
    return {'proven': bool(proven), 'diamond': min(proven) if proven else None, 'lean': 1.0,
            'note': 'PROVEN on the 2023-25 holdout' if proven else 'UNPROVEN: no threshold beat the no-vig close after Bonferroni in every holdout season; lean = research candidate only'}
pre = json.load(open('data/cache/talent_z.json'))
rp = pd.read_parquet('data/sdv/cfb_returning_production_2026.parquet')
model = {
    'version': 'ncaaf-vas-portable-v1', 'trained_at': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
    'config': CFG, 'stats': STATS, 'sd_margin': SD, 'sd_total': TSD,
    'stage1': fit(allS, S1, 'margin'),
    'stage2': {v: fit(mk & allS, cols, 'clv_home') for v, cols in S2.items()},
    'totals': {'stage1': fit(allS, TOT1, 'total'), 'stage2': {v: fit(tk & allS, cols, 'tclv_over') for v, cols in TOT2.items()}},
    'tiers': {'spread': {v: tiers(report['spread'][v]) for v in S2}, 'totals': {v: tiers(report['totals'][v]) for v in TOT2}},
    'variant_notes': {
        'A': 'open-safe: features known when the line opens. Production default.',
        'B': 'needs the median OPEN across several books, captured before the bet book moves (the app must record openers itself); '
             'historical opens come from different feeds whose open timestamps are not published, so the edge is statistically proven '
             'on the holdout but its real-time availability is NOT verified -> forward-test before trusting.',
        'C': 'late news: needs the confirmed starting QB (first snap) before the books adjust; only actionable on early QB news.',
        'E': 'explains the open->close move with everything known by kickoff: model gap, last-week result vs the spread (recency), '
             'letdown / bounce-back spot, starting-QB change, lead back / lead receiver out (share-weighted). Used to EXPLAIN a move; late news, not a bet by itself.'},
    # first-year head coach per season (Wikipedia coaching-change tables, fetch_context.py): the walk regresses these
    # teams' market rating harder (carry_m_nc) and updates it faster in season (lr_m_nc)
    'new_coach': {str(int(S)): sorted(int(t) for t in g.team) for S, g in pd.read_parquet('data/cache/coaches.parquet').groupby('season') if S >= 2020},
    'win_prob': {'sigma': 16.0, 'note': 'P(win) = Phi(stage-1 margin / sigma). sigma 16 (the app constant): pre-holdout log loss picks 16.5, '
                 'the 2023-25 holdout prefers 16 over 16.5 (see why_line.json); informational, fundamentals-only.'},
    'why_line': {k: json.load(open('data/cache/why_line.json'))[k] for k in ('stage1', 'move', 'base_rate', 'win_prob', 'new_coach_grid', 'bonferroni_factor')},
    'preseason': {'season': 2026, 'talent_z': pre.get('2026', {}), 'non_fbs_talent_z': -2.0,
                  'ret_off': {str(int(t)): float(o) for t, o in zip(rp.team_id, rp.off_returning) if pd.notna(o)},
                  'ret_def': {str(int(t)): float(d) for t, d in zip(rp.team_id, rp.def_returning) if pd.notna(d)}, 'ret_missing': 0.5},
    'feature_notes': {
        'd_*': 'home minus away of features.py side ratings (o_* offense, d_* defense allowed), mkt = market rating',
        'home': '1 - neutral site', 'early': 'regular-season week <= 4', 'talent_early': 'd_talent * early',
        'tier_g5': 'both FBS, neither Power-5 (SEC, Big Ten, Big 12, ACC, Pac-12, Notre Dame)', 'tier_fcs': 'one side not FBS',
        'x_open': 'bet book OPEN home spread', 'x_open_abs': '|x_open|', 'x_gap': 'stage-1 margin + x_open (points)',
        'x_open_vs_cons': 'bet book open minus median open across books', 'L_*': 'actual first-snap starter (late news)',
        'tx_gap': 'stage-1 total - open total', 'tx_open': 'open total', 'tx_open_vs_cons': 'open total minus median open total',
        'stage2 target': 'open line - consensus close (points); > 0 = market moves toward HOME (spread) / OVER (totals)'},
    'holdout_report': report,
}
json.dump(model, open('data/cache/ncaaf-vas-model.json', 'w'), indent=1, default=float)
F[['gid', 'season', 'm_fund', 'x_gap', 'pm_A', 'pm_B', 'pm_C', 'clv_home']].to_parquet('data/cache/portable_preds.parquet')
print('exported data/cache/ncaaf-vas-model.json', {k: v for k, v in model['tiers'].items()})
