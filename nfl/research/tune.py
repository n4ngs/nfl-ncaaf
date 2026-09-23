"""Pick the portable feature hyperparameters on EARLY seasons only (test 2009-2013, fit 2007..S-1): coordinate descent
on out-of-sample margin RMSE (+ total RMSE / 2). No open-line season and no holdout season is touched.
Writes data/cache/cfg_override.json (read by features.py)."""
import json, os, sys, subprocess, warnings, numpy as np, pandas as pd
from sklearn.linear_model import Ridge
warnings.filterwarnings('ignore'); np.seterr(all='ignore')
PY = os.environ.get('PY', sys.executable)
def score(cfg):
    env = {**os.environ, 'CFG_JSON': json.dumps(cfg), 'NO_OVERRIDE': '1'}
    subprocess.run([PY, 'features.py'], env=env, check=True, capture_output=True)
    F = pd.read_parquet('data/cache/features.parquet')
    D = [c for c in F.columns if c.startswith('d_')] + ['neutral', 'div', 'away_tz', 'west_early', 'home_short', 'away_short', 'home_bye', 'away_bye']
    S = [c for c in F.columns if c.startswith('s_')] + ['dome', 'neutral']
    em, et = [], []
    for s in range(2009, 2014):
        tr = F.season.between(2007, s - 1).values; te = (F.season == s).values
        for cols, y, acc in ((D, F.y_margin.values, em), (S, F.y_total.values, et)):
            X = F[cols].values; mu, sd = X[tr].mean(0), X[tr].std(0) + 1e-9
            m = Ridge(alpha=50).fit((X[tr] - mu) / sd, y[tr]); acc.extend(((m.predict((X[te] - mu) / sd) - y[te]) ** 2).tolist())
    return float(np.sqrt(np.mean(em))), float(np.sqrt(np.mean(et)))
grid = {'hl_team': [5.0, 8.0, 12.0, 16.0], 'carry': [0.25, 0.4, 0.6], 'k_pass': [100.0, 250.0, 500.0], 'k_rush': [100.0, 200.0, 400.0],
        'k_qb': [100.0, 250.0, 500.0], 'hl_qb': [250.0, 500.0, 1000.0], 'qb_rep': [0.0, -0.05, -0.10, -0.15], 'k_game': [1.0, 3.0, 6.0]}
cfg = {}; best = score(cfg); obj = lambda s: s[0] + s[1] / 2
print('start', best, flush=True)
for _ in range(2):
    for k, vals in grid.items():
        for v in vals:
            c = {**cfg, k: v}; s = score(c)
            print(f'  {k}={v}: margin {s[0]:.4f} total {s[1]:.4f}', flush=True)
            if obj(s) < obj(best) - 1e-4: best, cfg = s, c
        print('->', cfg, best, flush=True)
json.dump(cfg, open('data/cache/cfg_override.json', 'w'), indent=1)
print('chosen', cfg, best)
