"""cfbfastR play-by-play (sportsdataverse GitHub release cfbfastR_cfb_pbp), used ONLY for the late-news test:
the QB who threw the team's first pass / took its first sack = the actual starter (known at kickoff).
Keeps a slim per-season file data/pbp/first_passer_{S}.parquet and deletes the ~100MB raw file. Resumable."""
import os, sys, urllib.request, pandas as pd
BASE = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/cfbfastR_cfb_pbp'
os.makedirs('data/pbp', exist_ok=True)
IDS = ['completion_player_id', 'incompletion_player_id', 'interception_thrown_player_id', 'sack_taken_player_id']
for S in [int(x) for x in (sys.argv[1:] or range(2016, 2026))]:
    out = f'data/pbp/first_passer_{S}.parquet'
    if os.path.exists(out): print(S, 'cached'); continue
    raw = f'data/pbp/play_by_play_{S}.parquet'
    if not os.path.exists(raw):
        urllib.request.urlretrieve(f'{BASE}/play_by_play_{S}.parquet', raw + '.part'); os.replace(raw + '.part', raw)
    d = pd.read_parquet(raw, columns=['game_id', 'game_play_number', 'id_play'] + IDS)
    d['qb'] = d[IDS].bfill(axis=1).iloc[:, 0]
    d = d[d.qb.notna()].copy(); d['qb'] = pd.to_numeric(d.qb, errors='coerce'); d = d[d.qb.notna()]
    d['id_play'] = pd.to_numeric(d.id_play, errors='coerce')
    d = d.sort_values(['game_id', 'id_play', 'game_play_number'])
    d[['game_id', 'id_play', 'qb']].astype({'game_id': 'int64', 'qb': 'int64'}).to_parquet(out)
    os.remove(raw); print(S, len(d), 'passing plays with a passer id', flush=True)
