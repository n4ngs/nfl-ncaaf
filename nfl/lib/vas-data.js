'use strict';
// Data for the NFL VAS engine (nfl/lib/vas-engine.js), cached on the volume so a restart never re-parses the big files.
//   schedules/games.csv.gz            every game (scores, kickoff, roof, division, neutral site): at most every 12 h
//   pbp/play_by_play_<season>.csv.gz  ~19 MB gz / ~100 MB CSV per season -> compact play rows (engine.compactPlay)
//   snap_counts/snap_counts_<season>.csv.gz  -> compact snap rows
// Past seasons are fetched once (again only if the cached copy predates that season's end); the current season at
// most every 12 h. A failed URL is retried at most once per hour; on failure the cache is kept and lastError recorded.
// Zero dependencies: node:zlib streams the gunzip, a quote-aware splitter parses one line at a time, and only the needed
// columns of each row are materialised, so peak memory is roughly the gz buffer plus the compact rows.
// Filters match nfl/research/prep.py + features.py exactly: completed games (home score present) of every game type,
// plays kept by compactPlay (the same scrimmage / special-teams rule), plays and snaps only for those games.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const { compactPlay } = require('./vas-engine');

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const URLS = {
  games: () => `${BASE}/schedules/games.csv.gz`,
  pbp: s => `${BASE}/pbp/play_by_play_${s}.csv.gz`,
  snaps: s => `${BASE}/snap_counts/snap_counts_${s}.csv.gz`,
};
const PBP_COLS = ['game_id', 'posteam', 'defteam', 'play_type', 'epa', 'success', 'qb_dropback', 'special', 'qb_kneel', 'qb_spike', 'passer_id', 'wp', 'play_deleted'];
const SNAP_COLS = ['game_id', 'team', 'pfr_player_id', 'position', 'offense_pct', 'defense_pct', 'offense_snaps', 'defense_snaps', 'player'];
const GAME_COLS = ['game_id', 'season', 'game_type', 'week', 'gameday', 'gametime', 'away_team', 'away_score', 'home_team', 'home_score', 'location', 'div_game', 'roof', 'spread_line', 'total_line'];
// Columns a file may lack (older exports, test fixtures): read as empty instead of rejecting the file.
const OPTIONAL_COLS = new Set(['play_deleted', 'player', 'spread_line', 'total_line']);
const REFRESH_MS = 12 * 3600e3, RETRY_MS = 3600e3;

// NFL season of a date: the calendar year from March onward, else the previous year.
const seasonFor = ms => { const d = new Date(ms); return d.getUTCMonth() >= 2 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; };
// a season's data can still change until its Super Bowl is played (mid-February of season+1)
const seasonOver = (season, ms) => ms >= Date.UTC(season + 1, 2, 1);

function splitCsv(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
// Extract only the fields at `want` (index -> slot) without splitting the whole 372-column pbp line.
function pickCsv(line, want, out) {
  let i = 0, col = 0; const n = line.length;
  while (i <= n) {
    let v;
    if (line.charCodeAt(i) === 34) {                         // quoted field
      let j = i + 1, buf = null, from = j;
      for (;;) {
        const q = line.indexOf('"', j);
        if (q < 0) { j = n; break; }
        if (line.charCodeAt(q + 1) === 34) { buf = (buf || '') + line.slice(from, q + 1); j = from = q + 2; continue; }
        if (want.has(col)) v = (buf || '') + line.slice(from, q);
        j = q + 1; break;
      }
      i = j;                                                 // now at the comma (or end)
    } else {
      let c = line.indexOf(',', i); if (c < 0) c = n;
      if (want.has(col)) v = line.slice(i, c);
      i = c;
    }
    if (v !== undefined) out[want.get(col)] = v;
    col++; i++;                                              // skip the comma
  }
  return out;
}
const quotes = s => { let n = 0; for (let i = s.indexOf('"'); i >= 0; i = s.indexOf('"', i + 1)) n++; return n; };

// Stream-parse a gzipped CSV buffer. onRow(get) is called per record; get(col) returns that column's raw string.
// Records may contain quoted newlines (pbp `desc`): a line with an odd quote count is joined with the next one.
function parseCsvGz(buf, cols, onRow) {
  return new Promise((resolve, reject) => {
    const gz = zlib.createGunzip({ chunkSize: 1 << 20 });
    let rest = '', head = null, ix = null, pending = null, rows = 0;
    const want = new Map(), slot = {}, vals = new Array(cols.length).fill('');
    const record = line => {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (pending !== null) { line = pending + '\n' + line; pending = null; }
      if (quotes(line) % 2) { pending = line; return; }
      if (!head) {
        head = splitCsv(line); ix = {};
        for (const c of cols) { ix[c] = head.indexOf(c); }
        cols.forEach((c, k) => { slot[c] = k; if (ix[c] >= 0) want.set(ix[c], k); });
        const miss = cols.filter(c => ix[c] < 0 && !OPTIONAL_COLS.has(c));
        if (miss.length) throw Error('csv missing columns ' + miss.join(','));
        return;
      }
      if (!line) return;
      vals.fill(''); pickCsv(line, want, vals); rows++;
      onRow(c => vals[slot[c]]);
    };
    gz.on('data', chunk => {
      try {
        const text = rest + chunk.toString('utf8'); let start = 0, nl;
        while ((nl = text.indexOf('\n', start)) >= 0) { record(text.slice(start, nl)); start = nl + 1; }
        rest = text.slice(start);
      } catch (e) { gz.destroy(); reject(e); }
    });
    gz.on('end', () => { try { if (rest || pending !== null) record(rest); resolve(rows); } catch (e) { reject(e); } });
    gz.on('error', reject);
    gz.end(buf);
  });
}

// V8 substrings keep their 1 MB parent chunk alive; every string we KEEP is interned as a flat copy (and deduplicated),
// otherwise the compact rows would pin the whole decoded CSV in memory.
function interner() {
  const m = new Map();
  return v => { if (v == null || v === '') return v; let x = m.get(v); if (x === undefined) { x = Buffer.from(v, 'utf8').toString('utf8'); m.set(x, x); } return x; };
}
const num = v => (v === '' || v == null || v === 'NA' ? NaN : Number(v));

async function parseGames(buf) {
  const games = [], I = interner();
  await parseCsvGz(buf, GAME_COLS, g => {
    const season = num(g('season')); if (!Number.isInteger(season)) return;
    const hs = num(g('home_score')), as = num(g('away_score'));
    games.push({ gid: I(g('game_id')), season, week: num(g('week')), gameType: I(g('game_type')), day: I(g('gameday')), time: I(g('gametime')) || null,
      home: I(g('home_team')), away: I(g('away_team')), homeScore: Number.isFinite(hs) ? hs : null, awayScore: Number.isFinite(as) ? as : null,
      neutral: g('location') === 'Neutral', div: num(g('div_game')) === 1 ? 1 : 0, roof: I(g('roof')) || null,
      // nflverse closing lines: spread_line > 0 means the home team was favoured by that many points.
      close: num(g('spread_line')), closeTotal: num(g('total_line')) });
  });
  return games;
}
async function parsePbp(buf) {
  const plays = [], r = {}, I = interner();
  await parseCsvGz(buf, PBP_COLS, g => {
    for (const c of PBP_COLS) r[c] = g(c);
    const p = compactPlay(r);
    if (p) { p[0] = I(p[0]); p[1] = I(p[1]); p[2] = I(p[2]); p[3] = I(p[3]); p[6] = I(p[6]); plays.push(p); }
  });
  return plays;
}
async function parseSnaps(buf) {
  const snaps = [], I = interner();
  await parseCsvGz(buf, SNAP_COLS, g => {
    const o = num(g('offense_pct')), d = num(g('defense_pct'));
    snaps.push([I(g('game_id')), I(g('team')), I(g('pfr_player_id')), I(g('position')), Number.isFinite(o) ? o : 0, Number.isFinite(d) ? d : 0,
      num(g('offense_snaps')) > 0 || num(g('defense_snaps')) > 0 ? 1 : 0, I(g('player')) || null]);
  });
  return snaps;
}

function create({ dir, fetchBuffer, now = Date.now, log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const status = { sources: {}, lastRefresh: null, lastError: null };
  const tried = new Map();                     // url -> last failed attempt
  const file = key => path.join(dir, key + '.json.gz');
  const readGz = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
  const writeGz = (f, v) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(v))); fs.renameSync(tmp, f); };

  // cached compact data for `key`; `current` = may still change (refresh at most every 12 h)
  async function load(key, url, parse, season) {
    const f = file(key), t = now();
    let cached = null;
    if (fs.existsSync(f)) { try { cached = readGz(f); } catch (e) { cached = null; } }
    const stale = !cached || (season == null ? t - cached.fetchedAt > REFRESH_MS
      : !cached.final && (seasonOver(season, t) || t - cached.fetchedAt > REFRESH_MS));
    if (stale && t - (tried.get(url) || 0) > RETRY_MS) {
      try {
        const t0 = Date.now(), buf = await fetchBuffer(url);
        const rows = await parse(buf);
        if (!rows.length) throw Error('no rows parsed');
        cached = { url, fetchedAt: t, final: season != null && seasonOver(season, t), bytesGz: buf.length, parseMs: Date.now() - t0, rows };
        writeGz(f, cached); tried.delete(url);
        log(`[nfl-vas] ${key}: ${rows.length} rows from ${url} (${(buf.length / 1e6).toFixed(1)} MB gz, ${cached.parseMs} ms)`);
      } catch (e) {
        tried.set(url, t); status.lastError = `${key}: ${String(e.message || e).slice(0, 160)}`;
        log(`[nfl-vas] ${key} failed: ${status.lastError}`);
      }
    }
    if (cached) status.sources[key] = { url, rows: cached.rows.length, fetchedAt: new Date(cached.fetchedAt).toISOString(), final: cached.final,
      parseMs: cached.parseMs, bytesGz: cached.bytesGz, cacheBytes: fs.existsSync(f) ? fs.statSync(f).size : null };
    return cached ? cached.rows : null;
  }

  const schedule = () => load('games', URLS.games(), parseGames, null);
  const toEngine = g => ({ gid: g.gid, season: g.season, week: g.week, day: g.day, time: g.time, home: g.home, away: g.away,
    homeScore: g.homeScore, awayScore: g.awayScore, neutral: g.neutral, div: g.div, roof: g.roof,
    ...(Number.isFinite(g.close) ? { close: g.close } : {}), ...(Number.isFinite(g.closeTotal) ? { closeTotal: g.closeTotal } : {}) });

  // {games, plays, snaps} for seasons S-2..S, exactly the rows the research walk used.
  async function history(season = seasonFor(now())) {
    const seasons = [season - 2, season - 1, season];
    const sched = (await schedule()) || [];
    const games = sched.filter(g => seasons.includes(g.season) && g.homeScore != null && g.awayScore != null).map(toEngine);
    const gids = new Set(games.map(g => g.gid));
    const plays = [], snaps = [], info = { seasons, missing: [] };
    for (const s of seasons) {
      const p = await load(`pbp_${s}`, URLS.pbp(s), parsePbp, s);
      const n = await load(`snaps_${s}`, URLS.snaps(s), parseSnaps, s);
      if (!p) info.missing.push(`pbp_${s}`); else for (const r of p) if (gids.has(r[0])) plays.push(r);
      if (!n) info.missing.push(`snaps_${s}`); else for (const r of n) if (gids.has(r[0])) snaps.push(r);
    }
    const withPlays = new Set(plays.map(r => r[0])), withSnaps = new Set(snaps.map(r => r[0]));
    info.gamesWithoutPlays = games.filter(g => !withPlays.has(g.gid)).map(g => g.gid);
    info.gamesWithoutSnaps = games.filter(g => !withSnaps.has(g.gid)).map(g => g.gid);
    info.counts = { games: games.length, plays: plays.length, snaps: snaps.length };
    status.lastRefresh = new Date(now()).toISOString();
    const complete = !info.missing.length && !info.gamesWithoutPlays.length;
    return { games, plays, snaps, complete, info };
  }

  // not-yet-played games of a season, in the engine's game format (for featuresFor)
  async function upcoming(season = seasonFor(now())) {
    const sched = (await schedule()) || [];
    return sched.filter(g => g.season === season && (g.homeScore == null || g.awayScore == null)).map(toEngine)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : a.gid < b.gid ? -1 : 1));
  }

  return { history, upcoming, status: () => JSON.parse(JSON.stringify(status)) };
}

module.exports = { create, splitCsv, pickCsv, parseCsvGz, parseGames, parsePbp, parseSnaps, seasonFor, URLS };
