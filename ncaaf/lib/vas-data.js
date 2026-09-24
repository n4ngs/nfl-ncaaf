'use strict';
// Data for the NCAAF VAS engine (ncaaf/lib/vas-engine.js), cached under `dir` so a deploy never re-downloads history.
// Zero dependencies. Mirrors ncaaf/research/build_games.py (games, stats, QB) and market.py (closing spreads) exactly.
//
//   sportsdataverse release CSVs (daily rebuilds), per season S:
//     espn_cfb_schedules/cfb_schedule_{S}.csv             games, scores, neutral, conference game
//     espn_cfb_adv_team_gamelog/adv_team_gamelog_{S}.csv  per team-game offensive stats (defense = the opponent's)
//     espn_cfb_team_summaries/cfb_team_summaries_{S}.csv  division (fbs/fcs) + conference
//     espn_cfb_player_box/player_box_{S}.csv              QB = most pass attempts (ties -> larger athlete id)
//   -> one compact gzipped JSON per season. Past seasons are fetched once; the current season at most every 12 h;
//      a failed URL is retried at most once per hour; on failure the old cache is kept and lastError is recorded.
//   ESPN core odds, per completed game: consensus CLOSING home spread = median of the top-level `spread` over real
//     books (no "... Live Odds" provider = in-game prices; no model/consensus feeds). The top-level `spread` is used
//     because some rows carry the juice in close.pointSpread. Cached per game forever; backfilled a slice per call.
//   ESPN scoreboard (upcoming games; and each week's poll ranks, curatedRank, 99 = unranked, for the letdown read).
// The caller supplies fetchBuffer(url) -> Buffer (following redirects) and fetchJSON(url) -> object, with no custom UA.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');

const REL = 'https://github.com/sportsdataverse/sportsdataverse-data/releases/download';
const URLS = {
  schedule: (s) => `${REL}/espn_cfb_schedules/cfb_schedule_${s}.csv`,
  gamelog: (s) => `${REL}/espn_cfb_adv_team_gamelog/adv_team_gamelog_${s}.csv`,
  teams: (s) => `${REL}/espn_cfb_team_summaries/cfb_team_summaries_${s}.csv`,
  playerBox: (s) => `${REL}/espn_cfb_player_box/player_box_${s}.csv`,
  odds: (gid) => `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/events/${gid}/competitions/${gid}/odds?limit=50`,
  scoreboard: (s, type, week) => `https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=400` +
    (week ? `&dates=${s}&seasontype=${type}&week=${week}` : ''),
};
// gamelog column -> engine stat key (research/build_games.py STAT, minus the unused ones)
const STAT = { epa: 'EPA_per_play', repa: 'EPA_rushing_per_play', pepa: 'EPA_passing_per_play', fdr: 'first_downs_created_rate',
  expl: 'EPA_explosive_rate', ypp: 'yards_per_play', st: 'EPA_special_teams', plays: 'scrimmage_plays' };
const P5 = new Set(['SEC', 'Big Ten', 'Big 12', 'ACC', 'Pac-12']);
const NOTRE_DAME = 87;
const NOT_BOOKS = new Set(['numberfire', 'teamrankings', 'accuscore', 'consensus', 'SportsInsights', 'Opening']);
const CURRENT_TTL = 12 * 3600e3, RETRY = 3600e3;
const CACHE_V = 3;   // bump when the compact season format changes: older season caches are rebuilt once (3: attendance)

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
// Streams rows as {col: string} objects; `keep(line)` is a cheap pre-filter on the raw line.
function* csvRows(buf, keep) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  let pos = text.indexOf('\n'); if (pos < 0) return;
  const head = splitCsv(text.slice(0, pos).replace(/\r$/, '').replace(/^﻿/, ''));
  while (pos < text.length) {
    let next = text.indexOf('\n', pos + 1); if (next < 0) next = text.length;
    const line = text.slice(pos + 1, next).replace(/\r$/, ''); pos = next;
    if (!line || (keep && !keep(line))) continue;
    const f = splitCsv(line), row = {};
    for (let i = 0; i < head.length; i++) row[head[i]] = f[i];
    yield row;
  }
}
// pandas semantics: '', NA, NaN, null -> missing
const num = (v) => { if (v === undefined || v === null) return null; const s = String(v).trim(); if (s === '' || s === 'NA' || s === 'NaN' || s === 'null' || s === 'None') return null; const x = Number(s); return Number.isFinite(x) ? x : null; };
const bool = (v) => (String(v).toLowerCase() === 'true' ? 1 : 0);

// Four CSV buffers -> compact season {season, teams:{id:[fbs, conf]}, games:[engine games]}
function compactSeason(season, { schedule, gamelog, teams, playerBox }) {
  const T = {};
  for (const r of csvRows(teams)) { const id = num(r.team_id); if (id !== null) T[id] = [r.division === 'fbs' ? 1 : 0, r.conference || null]; }
  const stats = new Map();
  for (const r of csvRows(gamelog)) {
    const k = num(r.game_id) + ':' + num(r.team_id);
    if (stats.has(k)) continue;                       // drop_duplicates(['game_id', 'team_id']) keeps the first
    const o = {}; for (const [key, col] of Object.entries(STAT)) o[key] = num(r[col]); stats.set(k, o);
  }
  const qb = new Map();   // most pass attempts, ties -> larger athlete id (research: stable sort by att, id; last)
  const skill = new Map(); // gid:team -> {rush: {id: [carries, name]}, rec: {id: [catches, name]}, pass: Set(ids)}
  const sk = (k) => { let v = skill.get(k); if (!v) skill.set(k, (v = { rush: {}, rec: {}, pass: new Set() })); return v; };
  for (const r of csvRows(playerBox, (l) => l.includes('passing') || l.includes('rushing') || l.includes('receiving'))) {
    const id0 = num(r.athlete_id), k0 = num(r.game_id) + ':' + num(r.team_id);
    if (id0 !== null && r.category === 'rushing') { const n = num(r.rushingAttempts) ?? num(String(r.stat_1 || '').split('/')[0]); if (n) sk(k0).rush[id0] = [n, r.athlete_name || '']; }
    if (id0 !== null && r.category === 'receiving') { const n = num(r.receptions) ?? num(String(r.stat_1 || '').split('/')[0]); if (n) sk(k0).rec[id0] = [n, r.athlete_name || '']; }
    if (r.category !== 'passing') continue;
    if (id0 !== null) sk(k0).pass.add(id0);
    const raw = (r['completions/passingAttempts'] !== undefined && r['completions/passingAttempts'] !== '') ? r['completions/passingAttempts'] : r.stat_1;
    const att = num(String(raw || '').split('/')[1]) || 0, id = num(r.athlete_id);
    if (id === null) continue;
    const k = num(r.game_id) + ':' + num(r.team_id), cur = qb.get(k);
    if (!cur || att > cur[0] || (att === cur[0] && id > cur[1])) qb.set(k, [att, id]);
  }
  const games = [];
  for (const r of csvRows(schedule)) {
    if (r.status !== 'STATUS_FINAL') continue;
    const h = num(r.home_id), a = num(r.away_id), gid = num(r.game_id);
    const hf = T[h] && T[h][0] === 1 ? 1 : 0, af = T[a] && T[a][0] === 1 ? 1 : 0;
    if (!hf && !af) continue;
    const g = { gid, season, start: r.game_date, neutral: bool(r.neutral_site), conf_game: bool(r.conference_competition),
      home_id: h, away_id: a, home_pts: num(r.home_score), away_pts: num(r.away_score), home_fbs: hf, away_fbs: af,
      week: num(r.week), stype: num(r.season_type), attendance: num(r.attendance) };
    for (const [side, t] of [['home', h], ['away', a]]) {
      const s = stats.get(gid + ':' + t);
      for (const key of Object.keys(STAT)) g[side + '_' + key] = s ? s[key] : null;
      const q = qb.get(gid + ':' + t); g[side + '_qb'] = q ? q[1] : 0;
      // top ball carriers / receivers of this game (passers excluded from carries), for the lead-player read
      const x = skill.get(gid + ':' + t);
      const top = (o, skip) => Object.entries(o || {}).filter(([id]) => !(skip && skip.has(Number(id)))).sort((p, q2) => q2[1][0] - p[1][0]).slice(0, 5).map(([id, v]) => [Number(id), v[0], v[1]]);
      g[side + '_rush'] = x ? top(x.rush, x.pass) : []; g[side + '_rec'] = x ? top(x.rec) : [];
    }
    games.push(g);
  }
  games.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.gid - y.gid));
  return { v: CACHE_V, season, teams: T, games };
}

// Lead back / lead receiver going into a team's next game: most carries (catches) over its last 3 games this
// season, if that is >= 35 % (22 %) of the team's total - the same rule as research/keyplayers.py. Needs >= 2 games.
function leads(games, teamId, season) {
  const mine = games.filter((g) => g.season === season && (g.home_id === teamId || g.away_id === teamId)).sort((a, b) => (a.start < b.start ? -1 : 1)).slice(-3);
  const out = { rb: null, wr: null, games: mine.length };
  if (mine.length < 2) return out;
  for (const [key, field, thr] of [['rb', 'rush', 0.35], ['wr', 'rec', 0.22]]) {
    const tot = new Map(), names = new Map(); let all = 0;
    for (const g of mine) {
      const side = g.home_id === teamId ? 'home' : 'away';
      for (const [id, n, name] of g[side + '_' + field] || []) { tot.set(id, (tot.get(id) || 0) + n); names.set(id, name); all += n; }
    }
    let best = null, bn = 0;
    for (const [id, n] of tot) if (n > bn || (n === bn && id > best)) { best = id; bn = n; }
    if (best !== null && all > 0 && bn / all >= thr) out[key] = { id: best, name: names.get(best) || '', share: bn / all };
  }
  return out;
}

// ESPN core odds JSON -> consensus closing home spread (null if no real book has one)
function closeFromOdds(j) {
  const v = [];
  for (const it of (j && j.items) || []) {
    const name = it.provider && it.provider.name;
    if (!name || NOT_BOOKS.has(name) || name.includes('Live')) continue;
    const s = num(it.spread); if (s !== null) v.push(s);
  }
  return median(v);
}
function median(v) {
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Variant-B inputs from per-book OPENING spreads, exactly as the research did: consensus = median of every book's
// opening HOME spread (the betting book included); x_open_vs_cons = that book's open - consensus. Only openers first
// seen at or before `asOf` count (never use an opener you could not have seen when betting).
// openers: {book: {spread, homePrice, awayPrice, firstSeenAt, total?, overPrice?, underPrice?}}
function crossBook(openers, { asOf = Infinity } = {}) {
  const t = (x) => (x === undefined || x === null ? -Infinity : typeof x === 'number' ? x : Date.parse(x));
  const lim = t(asOf);
  const live = Object.entries(openers || {}).filter(([, o]) => o && Number.isFinite(o.spread) && t(o.firstSeenAt) <= lim);
  const cons = median(live.map(([, o]) => o.spread));
  const tl = live.filter(([, o]) => Number.isFinite(o.total));
  const tcons = median(tl.map(([, o]) => o.total));
  const books = {};
  for (const [b, o] of live) {
    books[b] = { open: o.spread, openCons: cons, x_open_vs_cons: o.spread - cons, homePrice: o.homePrice, awayPrice: o.awayPrice,
      total: Number.isFinite(o.total) ? o.total : null, totalCons: Number.isFinite(o.total) ? tcons : null, overPrice: o.overPrice, underPrice: o.underPrice };
  }
  return { n: live.length, openCons: cons, totalCons: tcons, books };
}

function create({ dir, fetchBuffer, fetchJSON, now = Date.now, log = () => {}, seed = path.join(__dirname, 'ncaaf-vas-closes-seed.json') }) {
  fs.mkdirSync(dir, { recursive: true });
  const status = { seasons: {}, closes: { cached: 0, missing: 0 }, lastRefresh: null, lastError: null };
  const tried = new Map();   // url -> last failed attempt
  const seasonFile = (s) => path.join(dir, `season_${s}.json.gz`), closeFile = path.join(dir, 'closes.json');
  const readGz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
  const writeAtomic = (f, data) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); };
  let closes = null;
  // Closes cached on the volume, topped up from the seed shipped with the code (ncaaf-vas-closes-seed.json, built from
  // the research odds + ESPN with the same closeFromOdds rule) so a fresh volume starts complete. Cached values win.
  const loadCloses = () => {
    if (closes) return closes;
    try { closes = JSON.parse(fs.readFileSync(closeFile, 'utf8')); } catch { closes = {}; }
    let added = 0;
    try { for (const [k, v] of Object.entries(require(seed).closes || {})) if (!(k in closes)) { closes[k] = v; added++; } }
    catch { /* no seed shipped */ }
    if (added) { log(`[ncaaf-vas] seeded ${added} closing spreads`); writeAtomic(closeFile, JSON.stringify(closes)); }
    return closes;
  };
  const mem = new Map();     // season -> {mtime, data}

  async function get(url) {
    const last = tried.get(url);
    if (last && now() - last < RETRY) throw Error('retry later: ' + url);
    try { const b = await fetchBuffer(url); tried.delete(url); return b; }
    catch (e) { tried.set(url, now()); throw e; }
  }
  const load = (s) => {
    const f = seasonFile(s); if (!fs.existsSync(f)) return null;
    const mtime = fs.statSync(f).mtimeMs, c = mem.get(s);
    if (c && c.mtime === mtime) return c.data;
    const d = readGz(f); mem.set(s, { mtime, data: d }); return d;
  };
  async function season(s, current) {
    let d = load(s);
    // age from the fetch time stored in the file (the injected clock), not the file mtime
    if (!d || d.v !== CACHE_V || (current && !(now() - (d.fetchedAt || 0) <= CURRENT_TTL))) {
      try {
        const t0 = Date.now();
        const [schedule, gamelog, teams, playerBox] = await Promise.all([URLS.schedule(s), URLS.gamelog(s), URLS.teams(s), URLS.playerBox(s)].map(get));
        const n = { ...compactSeason(s, { schedule, gamelog, teams, playerBox }), fetchedAt: now() };
        writeAtomic(seasonFile(s), zlib.gzipSync(JSON.stringify(n)));
        mem.delete(s); d = load(s);
        log(`[ncaaf-vas] ${s}: ${n.games.length} games parsed in ${Date.now() - t0} ms`);
      } catch (e) { status.lastError = `season ${s}: ${String(e.message || e).slice(0, 160)}`; }
    }
    if (!d) return null;
    status.seasons[s] = { games: d.games.length, fetchedAt: new Date(d.fetchedAt || 0).toISOString(), bytes: fs.statSync(seasonFile(s)).size };
    return d;
  }

  // Fetch missing closing spreads for these (completed) game ids, at most `max` per call. Returns {gid: close|null}.
  async function closeSpreads(gids, { max = 100, concurrency = 4 } = {}) {
    const C = loadCloses();
    const todo = gids.filter((g) => !(String(g) in C)).slice(0, max);
    let i = 0, changed = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (i < todo.length) {
        const gid = todo[i++], url = URLS.odds(gid);
        const last = tried.get(url); if (last && now() - last < RETRY) continue;
        try { C[String(gid)] = closeFromOdds(await fetchJSON(url)); changed++; tried.delete(url); }
        catch (e) { tried.set(url, now()); status.lastError = `odds ${gid}: ${String(e.message || e).slice(0, 120)}`; }
      }
    }));
    if (changed) writeAtomic(closeFile, JSON.stringify(C));
    const out = {}; for (const g of gids) out[g] = String(g) in C ? C[String(g)] : null;
    return out;
  }

  // Poll rank at kickoff per game (ESPN scoreboard curatedRank), one request per week, cached per season
  // (ranks_{S}.json): past seasons once, the current season every 12 h. A failed week keeps what was cached.
  async function ranks(s, current) {
    const f = path.join(dir, `ranks_${s}.json`);
    let c = null; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { c = null; }
    if (c && (!current || now() - (c.fetchedAt || 0) <= CURRENT_TTL)) return c.r;
    const r = (c && c.r) || {}; let okN = 0;
    const jobs = []; for (let w = 1; w <= 16; w++) jobs.push([2, w]); jobs.push([3, 1]);
    let i = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < jobs.length) {
        const [type, week] = jobs[i++], url = URLS.scoreboard(s, type, week);
        const last = tried.get(url); if (last && now() - last < RETRY) continue;
        try {
          const j = await fetchJSON(url); okN++; tried.delete(url);
          for (const e of (j && j.events) || []) {
            const cc = e.competitions && e.competitions[0]; if (!cc) continue;
            const side = Object.fromEntries((cc.competitors || []).map((x) => [x.homeAway, x]));
            const rk = (x) => { const v = x && x.curatedRank && x.curatedRank.current; return Number.isFinite(v) && v > 0 ? v : 99; };
            if (side.home && side.away) r[String(e.id)] = [rk(side.home), rk(side.away)];
          }
        } catch (e) { tried.set(url, now()); status.lastError = `ranks ${s}: ${String(e.message || e).slice(0, 120)}`; }
      }
    }));
    if (okN) writeAtomic(f, JSON.stringify({ fetchedAt: now(), r }));
    return r;
  }

  // The engine's history for `current` season: seasons current-2 .. current (walk warm-up = 2 full seasons).
  // Missing closes are backfilled newest-first, maxCloses per call; complete = every season + every close present.
  async function history(current, { maxCloses = 150, warmup = 2 } = {}) {
    const seasons = []; for (let s = current - warmup; s <= current; s++) seasons.push(s);
    const data = [];
    for (const s of seasons) { const d = await season(s, s === current); if (d) data.push(d); }
    const games = data.flatMap((d) => d.games);
    const RK = {}; for (const d of data) Object.assign(RK, await ranks(d.season, d.season === current));
    const C = loadCloses();
    const missing = games.filter((g) => !(String(g.gid) in C)).sort((a, b) => (a.start < b.start ? 1 : -1)).map((g) => g.gid);
    if (missing.length && maxCloses > 0) await closeSpreads(missing, { max: maxCloses });
    let noClose = 0;
    const out = games.map((g) => { const k = String(g.gid); if (!(k in C)) noClose++; const rk = RK[k] || [99, 99];
      return { ...g, close: k in C ? C[k] : null, home_rank: rk[0], away_rank: rk[1] }; });
    status.closes = { cached: Object.keys(C).length, missing: noClose };
    status.lastRefresh = new Date(now()).toISOString();
    const complete = data.length === seasons.length && noClose === 0;
    return { games: out, complete, info: { seasons: data.map((d) => d.season), games: out.length, closesMissing: noClose, lastError: status.lastError } };
  }

  // Not-yet-played games in the engine's input format (+ week / seasonType / P5 flags for withContext).
  // Uses this season's team table (previous season's as a fallback for FBS/conference).
  async function upcoming(s, { week, seasonType = 2 } = {}) {
    const d = (await season(s, true)) || (await season(s - 1, false));
    const prev = await season(s - 1, false);
    const team = (id) => (d && d.teams[id]) || (prev && prev.teams[id]) || [0, null];
    const j = await fetchJSON(URLS.scoreboard(s, seasonType, week));
    const out = [];
    for (const e of (j && j.events) || []) {
      const c = e.competitions && e.competitions[0]; if (!c) continue;
      if ((c.status && c.status.type && c.status.type.state) !== 'pre') continue;
      const side = Object.fromEntries((c.competitors || []).map((x) => [x.homeAway, x]));
      if (!side.home || !side.away) continue;
      const h = Number(side.home.team.id), a = Number(side.away.team.id);
      const th = team(h), ta = team(a);
      if (!th[0] && !ta[0]) continue;
      const start = String(e.date || c.date || '').replace(/(T\d{2}:\d{2}):\d{2}(\.\d+)?Z$/, '$1Z');   // schedule CSV format

      out.push({ gid: Number(e.id), season: s, start, day: start.slice(0, 10), neutral: c.neutralSite ? 1 : 0, conf_game: c.conferenceCompetition ? 1 : 0,
        home_id: h, away_id: a, home_fbs: th[0], away_fbs: ta[0], week: e.week ? e.week.number : week || null,
        seasonType: e.season ? e.season.type : seasonType,
        homeP5: th[0] === 1 && (P5.has(th[1]) || h === NOTRE_DAME), awayP5: ta[0] === 1 && (P5.has(ta[1]) || a === NOTRE_DAME) });
    }
    return out;
  }

  return { history, closeSpreads, upcoming, season, status: () => JSON.parse(JSON.stringify(status)) };
}

module.exports = { create, compactSeason, closeFromOdds, crossBook, leads, median, splitCsv, csvRows, URLS, STAT };
