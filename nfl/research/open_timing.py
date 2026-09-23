"""When was the ESPN 'open' posted? If it were a look-ahead line (posted before the teams' previous game), the open->close
move would absorb the previous game's result surprise. Diagnostic: corr(move, previous-game ATS surprise diff) by season/source.
Reference: for the offshore 'Opening' line (2014-16, posted Sunday night after the games) the surprise is already in the open."""
import numpy as np, pandas as pd, json
P = pd.read_parquet('data/cache/proof_preds.parquet')
FR = {'STL': 'LA', 'SD': 'LAC', 'OAK': 'LV'}
G = P.sort_values(['gameday', 'gametime', 'gid'])
long = pd.concat([pd.DataFrame({'gid': G.gid, 'day': G.gameday, 'team': G.home.map(lambda t: FR.get(t, t)), 'surp': G.y_margin - G.close_spread, 'side': 'home'}),
                  pd.DataFrame({'gid': G.gid, 'day': G.gameday, 'team': G.away.map(lambda t: FR.get(t, t)), 'surp': -(G.y_margin - G.close_spread), 'side': 'away'})])
long = long.sort_values(['day', 'gid'], kind='mergesort')
long['prev_surp'] = long.groupby('team').surp.shift(1)
long['prev_day'] = long.groupby('team').day.shift(1)
for s in ('home', 'away'):
    x = long[long.side == s].set_index('gid'); P[f'{s}_prev_surp'] = P.gid.map(x.prev_surp); P[f'{s}_gap_days'] = (pd.to_datetime(P.gameday) - pd.to_datetime(P.gid.map(x.prev_day))).dt.days
P['d_prev_surp'] = P.home_prev_surp - P.away_prev_surp
out = {}
mk = P.mu_open.notna() & P.mu_close.notna() & P.d_prev_surp.notna() & (P.home_gap_days <= 8) & (P.away_gap_days <= 8)
for (s, src), g in P[mk].groupby(['season', 'open_src']):
    c = np.corrcoef(g.d_prev_surp, g.move)[0, 1]
    ct = np.corrcoef(g.d_prev_surp, g.mu_open - g.m_fund)[0, 1]
    out[f'{s} {src}'] = {'n': int(len(g)), 'corr_move_prev_surprise': round(float(c), 3)}
    print(f'{s} {src:12s} n={len(g):3d}  corr(open->close move, prev-game ATS surprise diff) = {c:+.3f}')
# reference: a genuine look-ahead would look like corr(close - lagged close, surprise); weekly close-to-close for the same matchup is not
# observable, so the comparison is between sources: offshore Sunday-night openers vs ESPN BET / DraftKings opens.
json.dump(out, open('data/cache/open_timing.json', 'w'), indent=1)

# totals analog + slopes (points of move per point of previous-game surprise)
long = pd.concat([pd.DataFrame({'gid': G.gid, 'day': G.gameday, 'team': G.home.map(lambda t: FR.get(t, t)), 'ts': G.y_total - G.close_total, 'side': 'home'}),
                  pd.DataFrame({'gid': G.gid, 'day': G.gameday, 'team': G.away.map(lambda t: FR.get(t, t)), 'ts': G.y_total - G.close_total, 'side': 'away'})]).sort_values(['day', 'gid'], kind='mergesort')
long['prev_ts'] = long.groupby('team').ts.shift(1)
for s in ('home', 'away'):
    x = long[long.side == s].set_index('gid'); P[f'{s}_prev_ts'] = P.gid.map(x.prev_ts)
P['s_prev_ts'] = P.home_prev_ts + P.away_prev_ts
mkt = P.mu_open_t.notna() & P.mu_close_t.notna() & P.s_prev_ts.notna() & (P.home_gap_days <= 8) & (P.away_gap_days <= 8)
print('\nslopes (points of open->close move per point of previous-game surprise):')
for era, ss in (('2014-16 offshore Opening', [2014, 2015, 2016]), ('2023-25 ESPN BET/DK', [2023, 2024, 2025])):
    g = P[mk & P.season.isin(ss)]; gt = P[mkt & P.season.isin(ss)]
    b = np.polyfit(g.d_prev_surp, g.move, 1)[0]; bt = np.polyfit(gt.s_prev_ts, gt.move_t, 1)[0]
    ct = np.corrcoef(gt.s_prev_ts, gt.move_t)[0, 1]
    out[era] = {'spread_slope': round(float(b), 4), 'total_slope': round(float(bt), 4), 'total_corr': round(float(ct), 3)}
    print(f'  {era:26s} spread slope {b:+.4f} (n={len(g)})  total slope {bt:+.4f} corr {ct:+.3f} (n={len(gt)})')
json.dump(out, open('data/cache/open_timing.json', 'w'), indent=1)
