"""Late-news variants (NOT open-safe). Does news that arrives after the open explain the open->close move, and would a
bettor who had it early have beaten the close?

Variants added to the open-safe stage-2 inputs (same rolling origin over open-line seasons, same test seasons):
  qb       confirmed starting QB (nflverse starter) rating diff minus the projected one, QB-change flags
  injury   Friday injury report ("Injury Matrix"): sum over listed regulars of expected snap share x P(miss | status),
           by position group, home minus away. P(miss|status) calibrated on 2013-2019 (Out 1.00, Doubtful 0.99, Q 0.35, P 0.06)
  inactive inactives proxy: expected snap share of regulars with zero snaps in THIS game (known ~90 min before kickoff)
  weather  game-time wind, temperature, precipitation flag (forecasts are what the live app would have)
IMPORTANT: bets are still priced at the OPEN, which is an UPPER BOUND - the news is not known at the open. With free data
there is no price series between open and close, so whether the news beats the book's reaction cannot be measured here.
"""
import json, warnings, numpy as np, pandas as pd
from scipy import stats
from sklearn.linear_model import Ridge
from sklearn.ensemble import HistGradientBoostingRegressor
from common import KeyDist
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
F = pd.read_parquet('data/cache/proof_preds.parquet')
kd = json.load(open('data/cache/keydist.json'))
KM = KeyDist(kd['margin']['sd'], kd['margin']['w']); KT = KeyDist(kd['total']['sd'], kd['total']['w'])
GL = ['QB', 'OL', 'WR', 'TE', 'RB', 'DL', 'LB', 'DB']
for x in GL:
    F[f'd_inj_{x}'] = (F[f'home_inj_{x}'] - F[f'away_inj_{x}']).fillna(0.0)
    F[f'd_ina_{x}'] = (F[f'home_ina_{x}'] - F[f'away_ina_{x}']).fillna(0.0)
    F[f's_inj_{x}'] = (F[f'home_inj_{x}'] + F[f'away_inj_{x}']).fillna(0.0)
    F[f's_ina_{x}'] = (F[f'home_ina_{x}'] + F[f'away_ina_{x}']).fillna(0.0)
F['d_qb_news'] = (F.home_qb_act - F.home_qb) - (F.away_qb_act - F.away_qb)
F['s_qb_news'] = (F.home_qb_act - F.home_qb) + (F.away_qb_act - F.away_qb)
F['wind_'] = np.where(F.dome == 1, 0.0, F.wind.fillna(F.wind.median())); F['temp_'] = np.where(F.dome == 1, 70.0, F.temp.fillna(F.temp.median()))
F['precip_'] = np.where(F.dome == 1, 0, F.precip.fillna(0))
F['cold_'] = (F.temp_ < 32).astype(float); F['windy_'] = (F.wind_ >= 15).astype(float)
MOVE = ['x_gap', 'x_open', 'x_absopen', 'x_half', 'd_qb', 'home_qbshare', 'away_qbshare', 'd_m_QB', 'd_m_OL', 'd_m_DB', 'd_rest', 'd_op', 'd_dp', 'd_pf', 'd_pa', 'neutral', 'div']
MOVE_T = ['xt_gap', 'xt_open', 'dome', 's_pace', 's_prate', 's_qb', 's_op', 's_dp', 's_pf', 's_pa', 'neutral']
VAR = {'qb': (['d_qb_news', 'home_qb_change', 'away_qb_change'], ['s_qb_news', 'home_qb_change', 'away_qb_change']),
       'injury': ([f'd_inj_{x}' for x in GL], [f's_inj_{x}' for x in GL]),
       'inactive': ([f'd_ina_{x}' for x in GL], [f's_ina_{x}' for x in GL]),
       'weather': (['wind_', 'precip_'], ['wind_', 'temp_', 'precip_', 'cold_', 'windy_'])}
VAR['all late'] = tuple(sum((VAR[k][i] for k in ('qb', 'injury', 'inactive', 'weather')), []) for i in (0, 1))
mk = F.mu_open.notna() & F.mu_close.notna(); mkt = F.mu_open_t.notna() & F.mu_close_t.notna()
POOL = [2016, 2023, 2024, 2025]

def stage2(cols, y, m_):
    out = pd.Series(np.nan, index=F.index)
    for Sn in POOL:
        tr = (m_ & (F.season < Sn)).values; te = (m_ & (F.season == Sn)).values
        X = F[cols].astype(float).fillna(0.0).values; mu, sd = X[tr].mean(0), X[tr].std(0); sd = np.where(sd < 1e-6, 1.0, sd)
        r = Ridge(alpha=10).fit((X[tr] - mu) / sd, y[tr])
        g = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.03, max_leaf_nodes=8, min_samples_leaf=60, l2_regularization=1.0, random_state=0).fit(X[tr], y[tr])
        out[te] = (r.predict((X[te] - mu) / sd) + g.predict(X[te])) / 2
    return out

def clv(sub, col, market):
    side = (sub[col] > 0).values
    if market == 'spread':
        ev = np.array([KM.ev(m, l, h if s else a, s) for m, l, h, a, s in zip(sub.mu_close, sub.open_spread, sub.open_hso, sub.open_aso, side)])
        pts = np.where(side, sub.close_spread - sub.open_spread, sub.open_spread - sub.close_spread)
    else:
        ev = np.array([KT.ev(m, l, (o if s else u_), s) for m, l, o, u_, s in zip(sub.mu_close_t, sub.open_total, sub.open_over, sub.open_under, side)])
        pts = np.where(side, sub.close_total - sub.open_total, sub.open_total - sub.close_total)
    t = stats.ttest_1samp(ev, 0, alternative='greater')
    return len(ev), ev.mean() * 100, t.pvalue, (pts > 0).sum() / max((pts != 0).sum(), 1), {int(S): round(float(ev[(sub.season == S).values].mean() * 100), 2) for S in POOL if (sub.season == S).any()}

res = {}
for market, base, y, m_, thrs in (('spread', MOVE, F.move.values, mk, (0.5, 0.75, 1.0)), ('total', MOVE_T, F.move_t.values, mkt, (0.75, 1.0, 1.5))):
    print(f'\n{market.upper()} late-news variants (stage 2 = ridge + GBM, test seasons {POOL}; bets priced at the OPEN = upper bound)')
    for name, extra in [('open-safe only', ([], []))] + list(VAR.items()):
        cols = base + (extra[0] if market == 'spread' else extra[1])
        F['pm_' + name] = stage2(cols, y, m_)
        T = F[m_ & F.season.isin(POOL)]
        c = np.corrcoef(T['pm_' + name], T.move if market == 'spread' else T.move_t)[0, 1]
        line = f'  {name:15s} corr(pred, move) {c:.3f}'
        res[f'{market}|{name}'] = {'corr': round(float(c), 3)}
        for thr in thrs:
            s = T[T['pm_' + name].abs() >= thr]
            if len(s) < 5: continue
            n, ev, p, bc, by = clv(s, 'pm_' + name, market)
            res[f'{market}|{name}'][str(thr)] = {'bets': n, 'clv_ev_pct': round(float(ev), 2), 'p': float(p), 'beat_close': round(float(bc), 3), 'by_season': by}
            line += f' | >={thr}: n={n} EV {ev:+.2f}% p={p:.2g} beat {bc:.0%}'
        print(line, flush=True)
# how much of the move does the news explain on its own (in-sample descriptive, all open seasons)
Tm = F[mk]
for name in ('qb', 'injury', 'inactive'):
    X = Tm[VAR[name][0]].fillna(0).values
    r2 = Ridge(alpha=1).fit(X, Tm.move).score(X, Tm.move)
    print(f'descriptive: {name} news alone explains R^2={r2:.3f} of the spread move (all open seasons, in-sample)')
    res[f'r2|{name}'] = round(float(r2), 3)
json.dump(res, open('data/cache/late.json', 'w'), indent=1)
