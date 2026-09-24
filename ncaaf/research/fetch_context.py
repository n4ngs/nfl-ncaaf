"""Context the line-move research needs that the sportsdataverse files do not carry (resumable, cached):
  ranks   : ESPN scoreboard per season/week -> each team's poll rank at kickoff (curatedRank; 99 = unranked)
            -> data/cache/ranks.parquet (gid, home_rank, away_rank)
  coaches : ESPN core API head coach per FBS team-season -> first-year head coach flag
            -> data/cache/coaches.parquet (team, season, coach, new_coach)
Venue and attendance come from the schedule CSV itself (cfb_schedule_{S}.csv: venue, attendance).
Checked and NOT available historically (so those factors are forward-only): betting splits (Action Network returns
null public/money % for past dates), college injury status (ESPN CFB injuries endpoints are empty)."""
import json, os, urllib.request, concurrent.futures as cf, pandas as pd
os.makedirs('data/cache', exist_ok=True)
SB = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?dates={S}&week={W}&seasontype={T}&groups=80&limit=400'
CO = 'https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/{S}/teams/{T}/coaches'
def get(url):
    for _ in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as r: return json.load(r)
        except Exception: pass
    return None

def ranks():
    out = 'data/cache/ranks.parquet'
    if os.path.exists(out): return
    jobs = [(S, W, 2) for S in range(2014, 2027) for W in range(1, 17)] + [(S, 1, 3) for S in range(2014, 2026)]
    rows = []
    with cf.ThreadPoolExecutor(8) as ex:
        for (S, W, T), d in zip(jobs, ex.map(lambda j: get(SB.format(S=j[0], W=j[1], T=j[2])), jobs)):
            for e in (d or {}).get('events', []):
                if not e.get('competitions'): continue
                c = e['competitions'][0]; r = {'gid': int(e['id'])}
                for x in c['competitors']:
                    r[x['homeAway'] + '_rank'] = int((x.get('curatedRank') or {}).get('current', 99) or 99)
                rows.append(r)
    R = pd.DataFrame(rows).drop_duplicates('gid'); R.to_parquet(out); print('ranks', len(R), 'games,', ((R.home_rank < 26) | (R.away_rank < 26)).sum(), 'with a ranked team')

WIKI = 'https://en.wikipedia.org/w/api.php?action=parse&page={Y}_NCAA_Division_I_FBS_football_season&prop=wikitext&format=json&formatversion=2'
TEAMS = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=1000&groups=80'
ALIAS = {'miami (fl)': 'miami', 'miami (oh)': 'miami (oh)', 'hawaii': "hawai'i", 'hawai{{okina}}i': "hawai'i", 'southern mississippi': 'southern miss', 'utsa': 'utsa', 'ul monroe': 'louisiana monroe',
         'louisiana–monroe': 'ul monroe', 'southern miss': 'southern miss', 'louisiana-monroe': 'louisiana monroe', 'ulm': 'louisiana monroe', 'louisiana–lafayette': 'louisiana', 'louisiana-lafayette': 'louisiana',
         'usf': 'south florida', 'utsa': 'ut san antonio', 'uab': 'uab', 'fiu': 'florida international', 'fau': 'florida atlantic', 'smu': 'smu', 'tcu': 'tcu', 'byu': 'byu',
         'ucf': 'ucf', 'unlv': 'unlv', 'utep': 'utep', 'app state': 'app state', 'appalachian state': 'app state', 'sam houston state': 'sam houston', 'nc state': 'nc state',
         'massachusetts': 'massachusetts', 'umass': 'massachusetts', 'san jose state': 'san josé state', 'connecticut': 'uconn', 'pittsburgh': 'pittsburgh', 'southern california': 'usc',
         'texas a&m–commerce': None}
def coaches():
    """First-year head coach per team-season from Wikipedia's per-season FBS "Coaching changes" tables (ESPN's coach
    endpoints ignore the season and return today's coach for every year). A change dated Sep 1 of Y-1 .. Aug 31 of Y
    makes Y the team's first season under a new staff (interim hires included; they are new staff too)."""
    out = 'data/cache/coaches.parquet'
    if os.path.exists(out): return
    import re, urllib.parse, datetime as dt
    tm = {}
    d = get(TEAMS)
    for t in d['sports'][0]['leagues'][0]['teams']:
        t = t['team']
        for k in ('location', 'shortDisplayName', 'abbreviation', 'displayName'):
            if t.get(k): tm.setdefault(t[k].lower(), int(t['id']))
    rows, miss = [], set()
    os.makedirs('data/wiki', exist_ok=True)
    for Y in range(2013, 2027):
        f = f'data/wiki/{Y}.json'
        if not os.path.exists(f):   # cached; Wikipedia rate-limits bursts (429), so fetch slowly
            import time; time.sleep(3)
            req = urllib.request.Request(WIKI.format(Y=Y), headers={'User-Agent': 'nfl-ncaaf-research/1.0'})
            with urllib.request.urlopen(req, timeout=30) as r: open(f, 'wb').write(r.read())
        txt = json.load(open(f))['parse']['wikitext']
        i = txt.find('==Coaching changes==')
        if i < 0: print('no table', Y); continue
        m2 = re.search(r'\n==[^=]', txt[i + 25:]); sec = txt[i: i + 25 + m2.start()] if m2 else txt[i:]
        sec = re.sub(r'<ref[^>]*/>', '', sec); sec = re.sub(r'<ref.*?</ref>', '', sec, flags=re.S)
        for row in sec.split('|-')[1:]:
            cells = [c.strip() for c in re.split(r'\n\||\|\|', '\n' + row.strip()) if c.strip() and not c.strip().startswith('!')]
            cells = [c for c in cells if not c.startswith('}')]
            if len(cells) < 4: continue
            m = re.search(r'\[\[(?:[^|\]]*\|)?([^\]]+)\]\]', cells[0]); school = (m.group(1) if m else cells[0]).strip().strip("'")
            rest = ' | '.join(cells[1:]); date = None
            dm = re.search(r'([A-Z][a-z]+ \d{1,2}, \d{4})', rest); dd = re.search(r'\{\{dts\|(\d{4})\|(\d{1,2})\|(\d{1,2})', rest)
            dn = re.search(r'(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2})\b', rest)
            try:
                if dd: date = dt.date(int(dd.group(1)), int(dd.group(2)), int(dd.group(3)))
                elif dm: date = dt.datetime.strptime(dm.group(1), '%B %d, %Y').date()
                elif dn:   # no year: the page covers May of Y .. January of Y+1
                    mo = dt.datetime.strptime(dn.group(1), '%B').month; date = dt.date(Y if mo >= 5 else Y + 1, mo, int(dn.group(2)))
            except ValueError: date = None
            if date is None: continue
            season = date.year if date.month < 9 else date.year + 1
            key = school.lower(); key = ALIAS.get(key, key)
            tid = tm.get(key) if key else None
            if tid is None: miss.add(school); continue
            rows.append({'team': tid, 'season': season, 'date': str(date), 'school': school, 'interim': int('interim' in cells[-1].lower())})
    C = pd.DataFrame(rows).drop_duplicates(['team', 'season'])
    C['new_coach'] = 1; C.to_parquet(out)
    print('coaching changes', len(C), 'team-seasons', C.groupby('season').size().to_dict(), '| unmatched schools', sorted(miss))

if __name__ == '__main__':
    ranks(); coaches()
