"""Raw downloads -> compact cached tables in data/cache. Regular season only, 2015-16 .. 2025-26."""
import glob, os, pandas as pd, numpy as np, pyarrow.parquet as pq
os.makedirs('data/cache', exist_ok=True)
SEASONS = range(2015, 2026)                       # season start year (MoneyPuck convention)

# 1) shots: every unblocked attempt with goalie, xG, coordinates, strength
cols = ['season','game_id','isPlayoffGame','isHomeTeam','teamCode','homeTeamCode','awayTeamCode','goalieIdForShot',
        'xGoal','goal','event','homeSkatersOnIce','awaySkatersOnIce','xCordAdjusted','yCordAdjusted','shooterPlayerId',
        'shotOnEmptyNet','period','time']
parts = []
for s in SEASONS:
    d = pd.read_csv(f'data/mp/shots_{s}.csv', usecols=cols, low_memory=False)
    d = d[d.isPlayoffGame == 0]
    d['gid'] = s * 1000000 + d.game_id.astype(int)
    parts.append(d.drop(columns=['isPlayoffGame', 'game_id']))
shots = pd.concat(parts, ignore_index=True)
shots.to_parquet('data/cache/shots.parquet'); print('shots', len(shots), shots.gid.nunique(), 'games')

# 2) team game logs by situation
tl = pd.read_csv('data/mp/all_teams.csv', low_memory=False)
tl = tl[(tl.season >= 2015) & tl.situation.isin(['5on5','5on4','4on5','all']) & (tl.gameId.astype(str).str[4:6] == '02')]
keep = ['season','gameId','home_or_away','situation','iceTime','xGoalsFor','xGoalsAgainst','goalsFor','goalsAgainst',
        'flurryScoreVenueAdjustedxGoalsFor','flurryScoreVenueAdjustedxGoalsAgainst','highDangerxGoalsFor','highDangerxGoalsAgainst',
        'unblockedShotAttemptsFor','unblockedShotAttemptsAgainst','penaltiesFor','penaltiesAgainst','playerTeam']
tl[keep].to_parquet('data/cache/teamlog.parquet'); print('teamlog', len(tl))

# 3) games, starters, results from goalie box; lineups from skater box
G = pd.concat([pq.read_table(f).to_pandas() for f in sorted(glob.glob('data/gbox/*.parquet'))])
S = pd.concat([pq.read_table(f).to_pandas() for f in sorted(glob.glob('data/sbox/*.parquet'))])
for X in (G, S):
    X['game_id'] = X.game_id.astype(int)
    X.drop(X[X.game_id.astype(str).str[4:6] != '02'].index, inplace=True)
def toi(v):
    try: m, s = str(v).split(':'); return int(m) + int(s) / 60
    except Exception: return np.nan
G['toi_m'] = G.toi.map(toi); S['toi_m'] = S.toi.map(toi)
G.to_parquet('data/cache/goalies.parquet'); S.to_parquet('data/cache/skaters.parquet')
rows = []
for gid, g in G.groupby('game_id'):
    r = {'gid': gid, 'date': g.game_date.iloc[0], 'season': int(str(gid)[:4])}
    for side in ('home', 'away'):
        t = g[g.home_away == side]
        if t.empty: break
        st = t[t.starter == True]
        r[side] = t.team_abbrev.iloc[0]; r[side + '_tid'] = int(t.team_id.iloc[0])
        r[side + '_starter'] = int(st.player_id.iloc[0]) if len(st) == 1 else int(t.sort_values('toi_m').player_id.iloc[-1])
        r[side + '_ga'] = int(t.goals_against.fillna(0).sum()); r[side + '_win'] = bool((t.decision == 'W').any())
    else:
        rows.append(r)
games = pd.DataFrame(rows)
games = games[games.home_win ^ games.away_win].copy()     # exactly one winner (incl. OT/SO)
games['home_goals'] = games.away_ga; games['away_goals'] = games.home_ga
games['y'] = games.home_win.astype(int)
games = games.sort_values(['date', 'gid']).reset_index(drop=True)
games.to_parquet('data/cache/games.parquet')
print('games', len(games), games.groupby('season').size().to_dict(), 'home win %.3f' % games.y.mean())
