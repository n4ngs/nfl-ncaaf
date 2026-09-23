"""Vector models, market stack, VAS tiers, and an honest out-of-sample report.

Rolling origin everywhere: anything used to predict season S was fit only on seasons < S.
Test seasons: 2024-25 and 2025-26 (MoneyPuck years 2024, 2025). Market = sportsbook moneylines from ESPN.
"""
import json, warnings, numpy as np, pandas as pd
warnings.filterwarnings('ignore')
np.seterr(all='ignore')
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
rng = np.random.default_rng(11)
F = pd.read_parquet('data/cache/features.parquet').merge(pd.read_parquet('data/cache/cnn.parquet'), on='gid', how='left')
F['cnn_logit'] = np.log(F.cnn_share / (1 - F.cnn_share))
F['h_share20'] = F.home_g_share20; F['a_share20'] = F.away_g_share20
F['h_gb2b'] = F.home_g_b2b; F['a_gb2b'] = F.away_g_b2b
F['h_b2b'] = F.home_b2b; F['a_b2b'] = F.away_b2b
F['d_glogshots'] = np.log1p(F.home_g_shots) - np.log1p(F.away_g_shots)

VECTORS = {
    'team': ['d_ev_xgf', 'd_ev_xga', 'd_ev_hdf', 'd_ev_hda', 'd_pp_xgf', 'd_pk_xga', 'd_pp_toi_pg', 'd_pk_toi_pg',
             'd_ev_finish', 'd_ev_saves', 'd_win_pg', 'd_all_gf_pg', 'd_all_ga_pg'],
    'goalie': ['d_g_gsax100', 'h_share20', 'a_share20', 'h_gb2b', 'a_gb2b', 'd_glogshots'],
    'personnel': ['d_lineup', 'd_lineup_shock', 'h_b2b', 'a_b2b', 'd_rest'],
    'cnn': ['cnn_logit'],
}
ALL = sum(VECTORS.values(), [])
F = F[F.season >= 2016].copy()
F[ALL] = F[ALL].replace([np.inf, -np.inf], np.nan)
for c in ALL: F[c] = F[c].fillna(F[c].median())

def logit(p): p = np.clip(p, 1e-6, 1 - 1e-6); return np.log(p / (1 - p))
def ll(p, y): p = np.clip(p, 1e-6, 1 - 1e-6); return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
def brier(p, y): return float(np.mean((p - y) ** 2))

# ------------------------------------------------------------------ fundamentals, rolling origin
for S in range(2018, 2026):
    tr = F.season.between(2016, S - 1); te = F.season == S
    base = LogisticRegression(C=1e6).fit(np.ones((tr.sum(), 1)), F.y[tr])
    F.loc[te, 'p_home_only'] = base.predict_proba(np.ones((te.sum(), 1)))[:, 1]
    for v, cols in VECTORS.items():
        m = make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=2000)).fit(F.loc[tr, cols], F.y[tr])
        F.loc[te, 'p_' + v] = m.predict_proba(F.loc[te, cols])[:, 1]
    lr = make_pipeline(StandardScaler(), LogisticRegression(C=0.3, max_iter=4000)).fit(F.loc[tr, ALL], F.y[tr])
    F.loc[te, 'p_lr'] = lr.predict_proba(F.loc[te, ALL])[:, 1]
    lr_nocnn = make_pipeline(StandardScaler(), LogisticRegression(C=0.3, max_iter=4000)).fit(F.loc[tr, [c for c in ALL if c != 'cnn_logit']], F.y[tr])
    F.loc[te, 'p_lr_nocnn'] = lr_nocnn.predict_proba(F.loc[te, [c for c in ALL if c != 'cnn_logit']])[:, 1]
    gb = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.03, max_leaf_nodes=15, min_samples_leaf=80,
                                        l2_regularization=1.0, random_state=0).fit(F.loc[tr, ALL], F.y[tr])
    F.loc[te, 'p_gbm'] = gb.predict_proba(F.loc[te, ALL])[:, 1]
    F.loc[te, 'p_model'] = 0.5 * (F.loc[te, 'p_lr'] + F.loc[te, 'p_gbm'])
    if S == 2025:
        coef = dict(zip(ALL, lr[-1].coef_[0].round(4)))

# ------------------------------------------------------------------ market (ESPN books)
TEAM = {'NJ': 'NJD', 'TB': 'TBL', 'LA': 'LAK', 'SJ': 'SJS', 'UTAH': 'UTA', 'WSH': 'WSH', 'MON': 'MTL', 'NAS': 'NSH'}
def novig(h, a):
    if h is None or a is None: return None
    ph = 100 / (h + 100) if h > 0 else -h / (-h + 100); pa = 100 / (a + 100) if a > 0 else -a / (-a + 100)
    s = ph + pa
    return ph / s if 1.0 < s < 1.12 else None
# Two-way pregame books only. ESPN's DraftKings/Unibet/Bet365/Titanbets/Holland rows before 2025-26 are 60-minute 3-way
# lines, and any "Live Odds" provider is an in-game price (it "knows" the result). Both are excluded.
TWO_WAY = ['ESPN BET', 'Draft Kings', 'MGM', 'Caesars Sportsbook (New Jersey)', 'Caesars Sportsbook (Colorado)',
           'Caesars Sportsbook', 'Caesars Sportsbook (Tennessee)', 'Caesars Sportsbook (Pennsylvania)', 'PointsBet',
           'SugarHouse', 'BetfairSportsbook', 'Westgate']
mk = []
for line in open('data/espn/games.jsonl'):
    e = json.loads(line); books = {b['book']: b for b in (e.get('books') or []) if b['book'] in TWO_WAY}
    rec = {'home': TEAM.get(e['home'], e['home']), 'away': TEAM.get(e['away'], e['away']), 'day': e['date'][:10]}
    close, opn = [], []
    for name in TWO_WAY:
        b = books.get(name)
        if not b: continue
        h, a = b['home'], b['away']
        hc = h['close'] if h['close'] is not None else h['ml']; ac = a['close'] if a['close'] is not None else a['ml']
        pc = novig(hc, ac); po = novig(h['open'], a['open'])
        if pc is not None:
            close.append(pc)
            if 'bet_close_h' not in rec: rec.update(bet_book=name, bet_close_h=hc, bet_close_a=ac)
        if po is not None:
            opn.append(po)
            if 'bet_open_h' not in rec: rec.update(bet_open_book=name, bet_open_h=h['open'], bet_open_a=a['open'])
    if close: rec['mkt_close'] = float(np.median(close)); rec['n_books'] = len(close)
    if opn: rec['mkt_open'] = float(np.median(opn))
    mk.append(rec)
M = pd.DataFrame(mk).dropna(subset=['mkt_close'])
F['day'] = pd.to_datetime(F.start).dt.strftime('%Y-%m-%d')
F = F.merge(M, on=['home', 'away', 'day'], how='left')
print('market coverage by season:', F.groupby('season').mkt_close.apply(lambda s: round(s.notna().mean(), 3)).to_dict())

# ------------------------------------------------------------------ market stack (fit on earlier seasons only)
F['x_mkt'] = logit(F.mkt_close); F['x_edge'] = logit(F.p_model) - F.x_mkt
for S in (2023, 2024, 2025):
    tr = F.season.between(2021, S - 1) & F.mkt_close.notna(); te = (F.season == S) & F.mkt_close.notna()
    st = LogisticRegression(C=1e6).fit(F.loc[tr, ['x_mkt', 'x_edge']], F.y[tr])
    F.loc[te, 'p_stack'] = st.predict_proba(F.loc[te, ['x_mkt', 'x_edge']])[:, 1]
    to = te & F.mkt_open.notna()   # same frozen weights, fed ONLY the opening line (no closing info)
    xo = pd.DataFrame({'x_mkt': logit(F.loc[to, 'mkt_open']), 'x_edge': logit(F.loc[to, 'p_model']) - logit(F.loc[to, 'mkt_open'])})
    F.loc[to, 'p_stack_open'] = st.predict_proba(xo)[:, 1]
    if S == 2025: stack_coef = dict(zip(['intercept', 'market', 'model_edge'], [round(float(st.intercept_[0]), 4)] + list(st.coef_[0].round(4))))

# ------------------------------------------------------------------ report
def payout(american): return american / 100 if american > 0 else 100 / -american
def roi(sub, side_col, price_h, price_a):
    r = []
    for x in sub.itertuples():
        side = getattr(x, side_col); pr = getattr(x, price_h) if side == 1 else getattr(x, price_a)
        if pr is None or pd.isna(pr): continue
        win = x.y == 1 if side == 1 else x.y == 0
        r.append(payout(pr) if win else -1.0)
    r = np.array(r)
    if len(r) == 0: return 0, np.nan, (np.nan, np.nan)
    bs = [rng.choice(r, len(r)).mean() for _ in range(2000)]
    return len(r), r.mean(), (np.percentile(bs, 5), np.percentile(bs, 95))

out = {'coefficients_lr_2025': coef, 'stack_coefficients_2025': stack_coef}
T = F[F.season.isin([2024, 2025]) & F.mkt_close.notna()].copy()
print(f'\nTEST 2024-25 + 2025-26: {len(T)} games with a market line')
tab = {}
for name, col in [('home rate only', 'p_home_only'), ('team vector', 'p_team'), ('goalie vector', 'p_goalie'),
                  ('personnel vector', 'p_personnel'), ('CNN vector', 'p_cnn'), ('all vectors, no CNN (LR)', 'p_lr_nocnn'),
                  ('all vectors LR', 'p_lr'), ('all vectors GBM', 'p_gbm'), ('MODEL (LR+GBM)', 'p_model'),
                  ('MARKET close (no-vig median)', 'mkt_close'), ('STACK model+market', 'p_stack')]:
    tab[name] = {'logloss': round(ll(T[col].values, T.y.values), 5), 'brier': round(brier(T[col].values, T.y.values), 5)}
    print(f'  {name:32s} logloss {tab[name]["logloss"]:.5f}  brier {tab[name]["brier"]:.5f}')
out['test_scores'] = tab

# VAS: each vector's lean relative to the home-only baseline; price edge = stack vs market close
for v in VECTORS: T['lean_' + v] = np.sign(logit(T['p_' + v]) - logit(T.p_home_only))
T['edge'] = T.p_stack - T.mkt_close
T['side'] = np.where(T.edge > 0, 1, 0)
T['aligned'] = sum((T['lean_' + v] == np.where(T.side == 1, 1, -1)).astype(int) for v in VECTORS)
print('\nBets at one book CLOSING price, ESPN BET first (edge = stack minus market):')
res = []
for thr in (0.0, 0.01, 0.02, 0.03, 0.05):
    for amin in (0, 2, 3, 4):
        sub = T[(T.edge.abs() >= thr) & (T.aligned >= amin) & T.bet_close_h.notna()]
        n, m, ci = roi(sub, 'side', 'bet_close_h', 'bet_close_a')
        res.append({'edge_min': thr, 'aligned_min': amin, 'bets': n, 'roi': None if np.isnan(m) else round(m, 4), 'ci90': [round(ci[0], 4), round(ci[1], 4)]})
        print(f'  edge>={thr:.2f} aligned>={amin}: bets {n:5d}  ROI {m:+.3%}  90% CI [{ci[0]:+.2%}, {ci[1]:+.2%}]')
out['roi_close'] = res
# open-line bets + closing line value
O = T[T.mkt_open.notna() & T.bet_open_h.notna()].copy()
O['edge_o'] = O.p_stack_open - O.mkt_open
O['side_o'] = np.where(O.edge_o > 0, 1, 0)
O['clv'] = np.where(O.side_o == 1, O.mkt_close - O.mkt_open, O.mkt_open - O.mkt_close)
print('\nBets at one book OPENING price + closing line value (market moved toward us = +CLV):')
res = []
for thr in (0.02, 0.03, 0.05):
    sub = O[O.edge_o.abs() >= thr]
    n, m, ci = roi(sub, 'side_o', 'bet_open_h', 'bet_open_a')
    res.append({'edge_min': thr, 'bets': n, 'roi': round(m, 4), 'ci90': [round(ci[0], 4), round(ci[1], 4)], 'mean_clv_prob': round(float(sub.clv.mean()), 5), 'clv_positive_rate': round(float((sub.clv > 0).mean()), 3)})
    print(f'  edge>={thr:.2f}: bets {n:5d}  ROI {m:+.3%}  CI [{ci[0]:+.2%}, {ci[1]:+.2%}]  mean CLV {sub.clv.mean()*100:+.2f} pts  +CLV rate {(sub.clv>0).mean():.1%}')
out['roi_open'] = res
out['games'] = {'train_seasons': '2016-17..(S-1)', 'test_games': int(len(T))}
json.dump(out, open('data/cache/report.json', 'w'), indent=1, default=float)
F.to_parquet('data/cache/predictions.parquet')
