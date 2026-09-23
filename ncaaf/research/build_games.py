"""Build the game table and the market table.

games.parquet   one row per completed game involving an FBS team, 2014..2026: ids, date, neutral, conference game,
                FBS/conference/tier of each side, scores, each side's offensive game stats (defense = opponent's
                offense in the same game), the starting QB (most pass attempts), talent composite, returning production.
market.parquet  per game: consensus (median across books) CLOSE and OPEN home spread / total, no-vig close ML,
                one book's actual OPEN price for bet pricing, per-book closes for the leak check.
Every join is printed with counts.
"""
import json, os, numpy as np, pandas as pd, warnings
warnings.filterwarnings('ignore')
SEASONS = range(2014, 2027)
P5 = {'SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12'}
STAT = {'epa': 'EPA_per_play', 'repa': 'EPA_rushing_per_play', 'pepa': 'EPA_passing_per_play', 'fdr': 'first_downs_created_rate',
        'expl': 'EPA_explosive_rate', 'ypp': 'yards_per_play', 'stuff': 'rushing_stuff_rate', 'oppr': 'rushing_opportunity_rate',
        'st': 'EPA_special_teams', 'plays': 'scrimmage_plays', 'passr': 'passes_rate', 'pen': 'penalty_yards'}

G = []
for S in SEASONS:
    sc = pd.read_csv(f'data/sdv/cfb_schedule_{S}.csv'); sc = sc[sc.status == 'STATUS_FINAL']
    ts = pd.read_parquet(f'data/sdv/cfb_team_summaries_{S}.parquet'); ts['team_id'] = ts.team_id.astype(int)
    div = dict(zip(ts.team_id, ts.division)); conf = dict(zip(ts.team_id, ts.conference))
    gl = pd.read_csv(f'data/sdv/adv_team_gamelog_{S}.csv')
    gl = gl.drop_duplicates(['game_id', 'team_id'])
    st = gl.set_index(['game_id', 'team_id'])
    try: tal = pd.read_parquet(f'data/sdv/cfb_team_talent_{S}.parquet'); tal = dict(zip(tal.team_id.astype(int), tal.talent_composite))
    except Exception: tal = {}
    try: rp = pd.read_parquet(f'data/sdv/cfb_returning_production_{S}.parquet'); rp = {int(k): (o, d) for k, o, d in zip(rp.team_id, rp.off_returning, rp.def_returning)}
    except Exception: rp = {}
    pb = pd.read_parquet(f'data/sdv/player_box_{S}.parquet', columns=['category', 'athlete_id', 'athlete_name', 'team_id', 'game_id', 'stat_1', 'completions/passingAttempts'])
    pb = pb[pb.category == 'passing'].copy()
    pb['att'] = pd.to_numeric(pb['completions/passingAttempts'].fillna(pb.stat_1).astype(str).str.split('/').str[1], errors='coerce').fillna(0)   # trap: attempts live in 'completions/passingAttempts', stat_1 is mostly empty
    qb = pb.sort_values(['att', 'athlete_id'], kind='mergesort').groupby(['game_id', 'team_id']).last()
    # first-snap starter (late-news test only): first pass/sack of the game whose passer is in this team's passing box
    first = {}
    if os.path.exists(f'data/pbp/first_passer_{S}.parquet'):
        fp = pd.read_parquet(f'data/pbp/first_passer_{S}.parquet')
        team_of = {(int(g), int(a)): int(t) for g, a, t in zip(pb.game_id, pb.athlete_id, pb.team_id)}
        for gid, qbid in zip(fp.game_id, fp.qb):
            t = team_of.get((int(gid), int(qbid)))
            if t is not None and (int(gid), t) not in first: first[(int(gid), t)] = int(qbid)
    n_gl = n_qb = 0
    for g in sc.itertuples():
        h, a = int(g.home_id), int(g.away_id)
        fh, fa = div.get(h) == 'fbs', div.get(a) == 'fbs'
        if not (fh or fa): continue
        r = {'gid': int(g.game_id), 'season': S, 'week': int(g.week), 'stype': int(g.season_type), 'start': g.game_date,
             'neutral': int(bool(g.neutral_site)), 'conf_game': int(bool(g.conference_competition)), 'home_id': h, 'away_id': a,
             'home': g.home_team, 'away': g.away_team, 'home_pts': int(g.home_score), 'away_pts': int(g.away_score)}
        ok = True
        for side, t in (('home', h), ('away', a)):
            r[f'{side}_fbs'] = int(div.get(t) == 'fbs'); c = conf.get(t, 'FCS') if div.get(t) == 'fbs' else 'FCS'
            r[f'{side}_conf'] = c; r[f'{side}_p5'] = int(c in P5 or t == 87)          # 87 = Notre Dame
            r[f'{side}_talent'] = tal.get(t, np.nan); o, d = rp.get(t, (np.nan, np.nan)); r[f'{side}_ret_off'] = o; r[f'{side}_ret_def'] = d
            try:
                x = st.loc[(g.game_id, t)]
                for k, col in STAT.items(): r[f'{side}_{k}'] = float(x[col]) if pd.notna(x[col]) else np.nan
            except KeyError: ok = False
            try: q = qb.loc[(g.game_id, t)]; r[f'{side}_qb'] = int(q.athlete_id); r[f'{side}_qb_att'] = float(q.att); n_qb += 1
            except KeyError: r[f'{side}_qb'] = 0; r[f'{side}_qb_att'] = 0.0
            r[f'{side}_qb1'] = first.get((int(g.game_id), t), 0)
        r['has_stats'] = int(ok); n_gl += ok
        G.append(r)
    print(f'{S}: games {sum(1 for x in G if x["season"] == S)}  with both sides game stats {n_gl}  team-games with a QB {n_qb}', flush=True)
G = pd.DataFrame(G).sort_values(['start', 'gid']).reset_index(drop=True)
G['tier'] = np.select([(G.home_p5 == 1) & (G.away_p5 == 1), (G.home_fbs == 1) & (G.away_fbs == 1) & (G.home_p5 == 0) & (G.away_p5 == 0),
                       (G.home_fbs == 0) | (G.away_fbs == 0)], ['P5', 'G5', 'FCS'], 'MIX')
G.to_parquet('data/cache/games.parquet')
print('tiers', G.groupby(['season', 'tier']).size().unstack().to_string())

# ------------------------------------------------------------------ market (sportsdataverse line file)
L = pd.read_parquet('data/sdv/cfb_line_odds.parquet').drop(columns=['id']).drop_duplicates()
L = L[(L.season >= 2014) & L.game_id.notna()]; L['game_id'] = L.game_id.astype(int)
gids = set(G.gid); print('line rows', len(L), 'games in line file', L.game_id.nunique(), 'of which in game table', L.game_id.isin(gids).sum() and L[L.game_id.isin(gids)].game_id.nunique())
# the file labels team rows by a book abbreviation, not an id: learn abbr -> team id per season as the team common to every game
# that abbreviation appears in (verified below by requiring exactly one home and one away row per game/book).
gh = G.set_index('gid')[['home_id', 'away_id']]
sp = L[(L.market_type == 'spread') & L.game_id.isin(gids)].copy()
amap = {}
for (S, ab), grp in sp.groupby(['season', 'abbr']):
    common = None
    for gid in grp.game_id.unique():
        ids = set(gh.loc[gid])
        common = ids if common is None else common & ids
    if common and len(common) == 1: amap[(S, ab)] = common.pop()
sp['team'] = [amap.get((s, a)) for s, a in zip(sp.season, sp.abbr)]
# single-game abbreviations (e.g. an FCS opponent seen once): the other row of the same game/book fixes it
for (gid, bk), grp in sp[sp.team.isna()].groupby(['game_id', 'book']):
    other = sp[(sp.game_id == gid) & (sp.book == bk) & sp.team.notna()]
    if len(other):
        known = set(other.team); rest = set(gh.loc[gid]) - known
        if len(rest) == 1: sp.loc[grp.index, 'team'] = rest.pop()
print('spread rows mapped to a team:', round(sp.team.notna().mean(), 4), 'unmapped rows', int(sp.team.isna().sum()))
sp = sp[sp.team.notna()]
sp['side'] = np.where(sp.team == gh.reindex(sp.game_id).home_id.values, 'home', 'away')
chk = sp.groupby(['game_id', 'book']).side.agg(lambda s: ''.join(sorted(s)))
print('game/book spread pairs:', chk.value_counts().head(5).to_dict())
good = chk[chk == 'awayhome'].index
sp = sp.set_index(['game_id', 'book']).loc[good].reset_index()
# home-perspective spread. sanity: home line == -away line
H = sp[sp.side == 'home'].set_index(['game_id', 'book']); A = sp[sp.side == 'away'].set_index(['game_id', 'book'])
bk = pd.DataFrame({'h_close': H.lines, 'a_close': A.lines, 'h_close_odds': H.odds, 'a_close_odds': A.odds,
                   'h_open': H.opening_lines, 'a_open': A.opening_lines, 'h_open_odds': H.opening_odds, 'a_open_odds': A.opening_odds}).reset_index()
bad = (bk.h_close + bk.a_close).abs() > 0.01
print('books where home line != -away line (dropped):', int(bad.sum()), 'of', len(bk)); bk = bk[~bad]
tt = L[(L.market_type == 'total') & L.game_id.isin(gids)]
O = tt[tt.abbr == 'over'].drop_duplicates(['game_id', 'book']).set_index(['game_id', 'book']); U = tt[tt.abbr == 'under'].drop_duplicates(['game_id', 'book']).set_index(['game_id', 'book'])
tot = pd.DataFrame({'t_close': O.lines, 'o_close_odds': O.odds, 'u_close_odds': U.odds, 't_open': O.opening_lines, 'o_open_odds': O.opening_odds, 'u_open_odds': U.opening_odds}).reset_index()
ml = L[(L.market_type == 'money_line') & L.game_id.isin(gids)].copy()
ml['team'] = [amap.get((s, a)) for s, a in zip(ml.season, ml.abbr)]
ml = ml[ml.team.notna()]; ml['side'] = np.where(ml.team == gh.reindex(ml.game_id).home_id.values, 'home', 'away')
ml = ml.drop_duplicates(['game_id', 'book', 'side']).pivot_table(index=['game_id', 'book'], columns='side', values='odds', aggfunc='first').reset_index().rename(columns={'home': 'h_ml', 'away': 'a_ml'})
BK = bk.merge(tot, on=['game_id', 'book'], how='outer').merge(ml, on=['game_id', 'book'], how='outer')
BK['source'] = 'sdv'
BK.to_parquet('data/cache/books_sdv.parquet')
print('per-book rows', len(BK), 'games', BK.game_id.nunique())
