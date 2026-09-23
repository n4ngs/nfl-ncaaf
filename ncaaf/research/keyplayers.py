"""Key skill-player availability (LATE NEWS, research only): who is the team's lead back / lead receiver going in,
and did he actually play? Absence is read from the box score (no carry / no catch), which is only certain at kickoff,
so these are late-news features: they test whether knowing an injury explains the open->close line move.

Lead back   = most rushing attempts over the team's previous 3 games this season (share >= 35 % of team carries),
              excluding that game's passer (QB scrambles).
Lead target = most receptions over the previous 3 games (share >= 22 % of team catches).
Output data/cache/keyplayers.parquet: gid, team, rb_share, rb_out, wr_share, wr_out (0 when no qualifying lead)."""
import numpy as np, pandas as pd
rows = []
for S in range(2014, 2027):
    p = pd.read_parquet(f'data/sdv/player_box_{S}.parquet')
    p = p[p.category.isin(['rushing', 'receiving', 'passing'])].copy()
    def num(col, alt):
        v = pd.to_numeric(p[col], errors='coerce') if col in p else pd.Series(np.nan, index=p.index)
        a = pd.to_numeric(p[alt].astype(str).str.split('/').str[0], errors='coerce') if alt in p else np.nan
        return v.fillna(a)
    p['car'] = np.where(p.category == 'rushing', num('rushingAttempts', 'stat_1'), np.nan)
    p['rec'] = np.where(p.category == 'receiving', num('receptions', 'stat_1'), np.nan)
    sch = pd.read_csv(f'data/sdv/cfb_schedule_{S}.csv')[['game_id', 'game_date']].rename(columns={'game_id': 'gid'})
    p = p.rename(columns={'game_id': 'gid'}).merge(sch, on='gid', how='inner')
    qb = set(zip(p[p.category == 'passing'].gid, p[p.category == 'passing'].athlete_id))
    car = p[(p.category == 'rushing') & p.car.notna()]
    car = car[[ (g, a) not in qb for g, a in zip(car.gid, car.athlete_id)]]
    rec = p[(p.category == 'receiving') & p.rec.notna()]
    for team, tg in p.groupby('team_id'):
        games = tg[['gid', 'game_date']].drop_duplicates().sort_values('game_date').gid.tolist()
        C = car[car.team_id == team].groupby(['gid', 'athlete_id']).car.sum()
        R = rec[rec.team_id == team].groupby(['gid', 'athlete_id']).rec.sum()
        for i, gid in enumerate(games):
            r = {'gid': int(gid), 'team': int(team), 'rb_share': 0.0, 'rb_out': 0, 'wr_share': 0.0, 'wr_out': 0}
            prev = games[max(0, i - 3):i]
            if len(prev) >= 2:
                for X, key, thr in ((C, 'rb', 0.35), (R, 'wr', 0.22)):
                    px = X[X.index.get_level_values(0).isin(prev)]
                    if px.sum() <= 0: continue
                    by = px.groupby(level=1).sum(); lead = by.idxmax(); share = by.max() / by.sum()
                    if share >= thr:
                        r[key + '_share'] = float(share)
                        r[key + '_out'] = int((gid, lead) not in X.index)
            rows.append(r)
    print(S, 'done', flush=True)
K = pd.DataFrame(rows)
K.to_parquet('data/cache/keyplayers.parquet')
print(K.groupby(K.gid // 1).size().shape, 'team-games', len(K), 'rb lead', (K.rb_share > 0).mean().round(3), 'rb out rate', K.rb_out[K.rb_share > 0].mean().round(3),
      'wr lead', (K.wr_share > 0).mean().round(3), 'wr out rate', K.wr_out[K.wr_share > 0].mean().round(3))
