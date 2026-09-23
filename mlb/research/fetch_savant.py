"""Baseball Savant season leaderboards (Statcast), pitchers and batters, 2017-2025. Used ONLY as previous-season priors
(season S games use season S-1 data), so nothing from the game's own season leaks in.
  https://baseballsavant.mlb.com/leaderboard/custom?year=Y&type=pitcher|batter&filter=&min=1&selections=...&csv=true
Savant 403s the Python default agent; an honest descriptive User-Agent is accepted (no browser impersonation).
Output: data/savant/{type}_{year}.csv (cached; one request each, 2 s apart)."""
import os, time, urllib.request
UA = {'User-Agent': 'theboard-research/1.0 (+statistical research)'}
SEL = {'pitcher': 'pa,k_percent,bb_percent,xwoba,xera,whiff_percent,barrel_batted_rate,hard_hit_percent,woba',
       'batter': 'pa,k_percent,bb_percent,xwoba,woba,barrel_batted_rate,hard_hit_percent,whiff_percent'}
for kind, sel in SEL.items():
    for y in range(2017, 2026):
        f = f'data/savant/{kind}_{y}.csv'
        if os.path.exists(f) and os.path.getsize(f) > 1000: continue
        u = f'https://baseballsavant.mlb.com/leaderboard/custom?year={y}&type={kind}&filter=&min=1&selections={sel}&csv=true'
        with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=90) as r: data = r.read()
        open(f, 'wb').write(data); print(kind, y, len(data), flush=True); time.sleep(2)
print('done')
