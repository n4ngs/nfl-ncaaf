"""Download the free sportsdataverse CFB files (GitHub releases, no key) into data/sdv/. Resumable: skips files present.

Sources (all public GitHub release assets, https://github.com/sportsdataverse/sportsdataverse-data/releases):
  espn_cfb_adv_team_gamelog/adv_team_gamelog_{S}.csv   per team-game EPA, rushing/passing splits, points (ESPN pbp based)
  espn_cfb_schedules/cfb_schedule_{S}.csv              games: ids, dates, neutral site, conference game, FBS flags
  espn_cfb_player_box/player_box_{S}.parquet           player box scores (starting QB = most pass attempts)
  cfb_team_talent/cfb_team_talent_{S}.parquet          247 talent composite (preseason, open-safe)
  cfb_returning_production/cfb_returning_production_{S}.parquet  returning production share (preseason, open-safe)
  espn_cfb_team_summaries/cfb_team_summaries_{S}.parquet  season team table: division (fbs/fcs) + conference
  https://github.com/sportsdataverse/cfbfastR-data/raw/main/betting/parquet/cfb_line_odds.parquet
                                                       lines per book: opening + latest spread/total/moneyline
"""
import os, sys, time, urllib.request
BASE = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download'
OUT = 'data/sdv'; os.makedirs(OUT, exist_ok=True)
SEASONS = range(2014, 2027)
FILES = []
for S in SEASONS:
    FILES += [('espn_cfb_adv_team_gamelog', f'adv_team_gamelog_{S}.csv'), ('espn_cfb_schedules', f'cfb_schedule_{S}.csv'),
              ('espn_cfb_player_box', f'player_box_{S}.parquet'), ('cfb_team_talent', f'cfb_team_talent_{S}.parquet'),
              ('cfb_returning_production', f'cfb_returning_production_{S}.parquet'),
              ('espn_cfb_team_summaries', f'cfb_team_summaries_{S}.parquet')]
def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0 and '2026' not in dest: return 'cached'
    for i in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r: b = r.read()
            open(dest + '.part', 'wb').write(b); os.replace(dest + '.part', dest); return f'{len(b)} bytes'
        except Exception as e:
            if i == 3: return f'FAILED {e}'
            time.sleep(3 * (i + 1))
for tag, name in FILES:
    print(name, fetch(f'{BASE}/{tag}/{name}', f'{OUT}/{name}'), flush=True)
print('cfb_line_odds', fetch('https://github.com/sportsdataverse/cfbfastR-data/raw/main/betting/parquet/cfb_line_odds.parquet', f'{OUT}/cfb_line_odds.parquet'))
