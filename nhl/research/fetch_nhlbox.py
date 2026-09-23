"""Official NHL boxscores for every regular-season game in the shot table. Resumable, gzip per game."""
import gzip, json, os, time, urllib.request, pandas as pd
from concurrent.futures import ThreadPoolExecutor
ids = sorted(pd.read_parquet('data/cache/shots.parquet', columns=['gid']).gid.unique())
todo = [g for g in ids if not os.path.exists(f'data/nhlbox/{g}.json.gz')]
print(len(ids), 'games,', len(todo), 'to fetch', flush=True)
def fetch(g):
    for i in range(5):
        try:
            req = urllib.request.Request(f'https://api-web.nhle.com/v1/gamecenter/{g}/boxscore', headers={'User-Agent': 'THE.BOARD/1.0'})
            with urllib.request.urlopen(req, timeout=25) as r: b = r.read()
            json.loads(b); open(f'data/nhlbox/{g}.json.gz', 'wb').write(gzip.compress(b)); return 1
        except Exception as e:
            time.sleep(2 * (i + 1))
    print('FAIL', g, flush=True); return 0
with ThreadPoolExecutor(6) as ex:
    for n, _ in enumerate(ex.map(fetch, todo), 1):
        if n % 500 == 0: print(n, flush=True)
print('done')
