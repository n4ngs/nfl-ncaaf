'use strict';
// Data for the MLB VAS engine (mlb/lib/vas-engine.js), cached on the volume (e.g. DATA_DIR/mlb-vas) so a deploy never
// re-downloads history. Zero dependencies. Every network call goes through the injected fetchJSON(url).
//
// Layout of `dir`:
//   sched/<season>.json     final regular-season games of the season (engine fields, no boxscore), from the statsapi schedule
//   box/<gamePk>.json       compact boxscore of one game (forever); a finished season is sealed into box/<season>.json.gz
//   people.json             {pitcherId: 'L'|'R'} throwing hands (forever)
// Rules: past seasons' schedules are fetched once; the current season is topped up with a small date-range request at
// most every `schedTtlMs` (default 6 h) so yesterday's finals always land; upcoming days are fetched at most every 15 min;
// boxscores are backfilled `maxFetch` per history() call with concurrency 3; a failed URL is retried at most once an hour;
// on any failure the cache is kept and status().lastError is set.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const { compactBox, parseWeather } = require('./vas-engine');

const API = 'https://statsapi.mlb.com/api/v1';
const ESPN_SB = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';
const ESPN_ODDS = id => `https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events/${id}/competitions/${id}/odds?limit=50`;
const HOUR = 3600e3;

const iso = d => d.toISOString().slice(0, 10);
const addDays = (day, n) => iso(new Date(Date.parse(day + 'T00:00:00Z') + n * 86400e3));
const ymd = s => (/^\d{8}$/.test(String(s)) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6, 8)}` : String(s));
const isFinal = g => g.gameType === 'R' && g.status && g.status.abstractGameState === 'Final' && ['F', 'O'].includes(g.status.codedGameState);

// statsapi schedule JSON -> {pk: engine game fields} for final regular-season games (later entries win, as in research)
function scheduleFinals(d) {
  const out = new Map();
  for (const day of (d && d.dates) || []) for (const g of day.games || []) {
    if (!isFinal(g)) continue;
    const h = g.teams.home, a = g.teams.away;
    out.set(g.gamePk, { pk: g.gamePk, season: Number(g.season), day: g.officialDate, start: g.gameDate, venue: g.venue ? g.venue.id : null, dn: g.dayNight,
      home: h.team.id, away: a.team.id, hs: h.score, as: a.score,
      prob: { home: h.probablePitcher ? h.probablePitcher.id : null, away: a.probablePitcher ? a.probablePitcher.id : null } });
  }
  return out;
}
// statsapi boxscore JSON -> what the history needs besides the schedule: compact lines, home-plate umpire, weather
function boxRecord(b) {
  const info = {};
  for (const x of b.info || []) if (x && x.label) info[x.label] = x.value || '';
  const hp = (b.officials || []).find(o => o.officialType === 'Home Plate');
  return { box: compactBox(b), hp: hp && hp.official ? hp.official.id : null, wx: parseWeather(info.Weather, info.Wind) };
}
// statsapi schedule (hydrate=probablePitcher,team) -> upcoming games in engine format + mapping fields
function scheduleUpcoming(d) {
  const out = [];
  for (const day of (d && d.dates) || []) for (const g of day.games || []) {
    if (g.gameType !== 'R' || !g.status || g.status.abstractGameState === 'Final' || ['D', 'C'].includes(g.status.codedGameState)) continue;
    const h = g.teams.home, a = g.teams.away;
    out.push({ pk: g.gamePk, season: Number(g.season), day: g.officialDate, start: g.gameDate, venue: g.venue ? g.venue.id : null, dn: g.dayNight,
      home: h.team.id, away: a.team.id, prob: { home: h.probablePitcher ? h.probablePitcher.id : null, away: a.probablePitcher ? a.probablePitcher.id : null },
      probNames: { home: h.probablePitcher ? h.probablePitcher.fullName : null, away: a.probablePitcher ? a.probablePitcher.fullName : null },
      names: { home: h.team.name, away: a.team.name }, abbr: { home: h.team.abbreviation || null, away: a.team.abbreviation || null },
      state: g.status.abstractGameState, detailed: g.status.detailedState, gameNumber: g.gameNumber || 1, doubleHeader: g.doubleHeader || 'N', tbd: !!g.status.startTimeTBD });
  }
  return out.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.pk - y.pk));
}
// ESPN scoreboard events <-> statsapi games: same home/away team names, same US-local day (start - 10 h), paired by start order.
const norm = s => String(s || '').toLowerCase().replace(/\./g, '').replace(/^(oakland|sacramento) /, '').replace('cleveland indians', 'cleveland guardians').trim();
function mapEspn(games, events) {
  const key = (h, a, start) => `${norm(h)}|${norm(a)}|${iso(new Date(Date.parse(start) - 10 * HOUR))}`;
  const byKey = new Map();
  for (const e of [...events].sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0))) {
    const k = key(e.homeName, e.awayName, e.start); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(e);
  }
  const used = new Map(), out = new Map();
  for (const g of [...games].sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.pk - y.pk))) {
    const k = key(g.names && g.names.home, g.names && g.names.away, g.start), list = byKey.get(k) || [], n = used.get(k) || 0;
    if (list[n]) { out.set(g.pk, list[n].id); used.set(k, n + 1); }
  }
  return out;
}
const amer = x => { if (x == null || x === '' || x === 'OFF') return null; if (x === 'EVEN') return 100; const v = Number(String(x).replace('+', '')); return Number.isFinite(v) ? v : null; };
const dig = (o, ...ks) => ks.reduce((v, k) => (v == null ? v : v[k]), o);
// ESPN core odds JSON -> per-book opener / current prices. "- Live Odds" providers are in-game prices and are dropped.
function parseOdds(d) {
  const books = [];
  for (const it of (d && d.items) || []) {
    const name = it.provider && it.provider.name;
    if (!name || /Live Odds|consensus|teamrankings|numberfire/i.test(name)) continue;
    const side = o => ({ open: amer(dig(o, 'open', 'moneyLine', 'american')), close: amer(dig(o, 'close', 'moneyLine', 'american')),
      current: amer(dig(o, 'current', 'moneyLine', 'american')) ?? (Number.isFinite(o && o.moneyLine) ? o.moneyLine : null) });
    const tot = o => (o ? { line: amer(dig(o, 'total', 'american')), over: amer(dig(o, 'over', 'american')), under: amer(dig(o, 'under', 'american')) } : null);
    books.push({ book: name, id: it.provider.id, home: side(it.homeTeamOdds || {}), away: side(it.awayTeamOdds || {}),
      totalOpen: tot(it.open), totalCurrent: tot(it.current), totalClose: tot(it.close) });
  }
  return books;
}

function create({ dir, fetchJSON, now = Date.now, log = () => {}, firstSeason = 2018, schedTtlMs = 6 * HOUR, upcomingTtlMs = 15 * 60e3, retryMs = HOUR }) {
  for (const d of ['sched', 'box']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const status = { seasons: {}, games: 0, boxes: 0, missingBoxes: 0, hands: 0, lastRefresh: null, lastError: null, fetches: 0, failures: 0 };
  const failedAt = new Map();                      // url -> last failure time (retry at most once per retryMs)
  const memo = new Map();                          // url -> {t, v} for short-TTL requests
  const writeAtomic = (f, data) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); };
  const readJSON = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
  async function get(url) {
    const f = failedAt.get(url);
    if (f && now() - f < retryMs) throw Error('retry later: ' + url);
    try { status.fetches++; const v = await fetchJSON(url); failedAt.delete(url); return v; }
    catch (e) { status.failures++; failedAt.set(url, now()); status.lastError = `${url.replace(/^https:\/\//, '').slice(0, 90)}: ${String(e.message || e).slice(0, 120)}`; throw e; }
  }
  async function cached(url, ttl) {
    const m = memo.get(url);
    if (m && now() - m.t < ttl) return m.v;
    try { const v = await get(url); memo.set(url, { t: now(), v }); return v; } catch (e) { if (m) return m.v; throw e; }
  }
  const today = () => iso(new Date(now() - 10 * HOUR));           // US-local baseball day
  const currentSeason = () => { const d = new Date(now()); return d.getUTCMonth() < 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); };

  // ---------------- people (throwing hand), forever
  const peopleFile = path.join(dir, 'people.json');
  const hands = readJSON(peopleFile, {});
  async function ensureHands(ids) {
    const todo = [...new Set(ids.filter(x => x && !(x in hands)))];
    let changed = false;
    for (let i = 0; i < todo.length; i += 150) {
      try {
        const ids = todo.slice(i, i + 150), d = await get(`${API}/people?personIds=${ids.join(',')}`);
        for (const id of ids) hands[id] = null;                     // unknown to the API: do not ask again
        for (const p of d.people || []) hands[p.id] = (p.pitchHand && p.pitchHand.code) || null;
        changed = true;
      } catch { /* keep going; retried later */ }
    }
    if (changed) writeAtomic(peopleFile, JSON.stringify(hands));
    status.hands = Object.keys(hands).length;
  }

  // ---------------- season schedules
  const schedFile = s => path.join(dir, 'sched', s + '.json');
  const schedMeta = new Map();                     // season -> {games: Map, checked}
  async function season(s) {
    const cur = currentSeason(), f = schedFile(s);
    let m = schedMeta.get(s);
    if (!m) {
      const disk = readJSON(f, null);
      m = { games: new Map(disk ? disk.games.map(g => [g.pk, g]) : []), checked: disk ? disk.checked : 0, sealed: !!(disk && disk.sealed) };
      schedMeta.set(s, m);
    }
    const stale = !m.sealed && (s < cur ? true : now() - m.checked > schedTtlMs);
    if (stale) {
      try {
        let range = [`${s}-02-15`, `${s}-11-30`];
        if (s === cur && m.games.size) {                    // top-up: a few days back to catch late finals and resumed games
          let last = ''; for (const g of m.games.values()) if (g.day > last) last = g.day;
          range = [addDays(last, -3), today() < `${s}-11-30` ? today() : `${s}-11-30`];
        }
        const d = await get(`${API}/schedule?sportId=1&gameType=R&startDate=${range[0]}&endDate=${range[1]}&hydrate=probablePitcher`);
        for (const [pk, g] of scheduleFinals(d)) m.games.set(pk, g);
        m.checked = now(); m.sealed = s < cur;
        writeAtomic(f, JSON.stringify({ season: s, checked: m.checked, sealed: m.sealed, games: [...m.games.values()] }));
      } catch { /* keep the cached season */ }
    }
    status.seasons[s] = { games: m.games.size, sealed: m.sealed, checked: m.checked ? new Date(m.checked).toISOString() : null };
    return m.games;
  }

  // ---------------- boxscores, forever
  const boxFile = pk => path.join(dir, 'box', pk + '.json');
  const sealFile = s => path.join(dir, 'box', s + '.json.gz');
  const sealed = new Map();                        // season -> {pk: record} (loaded lazily)
  function sealedOf(s) {
    if (!sealed.has(s)) sealed.set(s, fs.existsSync(sealFile(s)) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(sealFile(s))).toString('utf8')) : null);
    return sealed.get(s);
  }
  function readBox(s, pk) {
    const z = sealedOf(s); if (z && z[pk]) return z[pk];
    const f = boxFile(pk); return fs.existsSync(f) ? readJSON(f, null) : null;
  }
  async function fetchBox(pk) {
    try {
      const r = boxRecord(await get(`${API}/game/${pk}/boxscore`));
      if (r.box.home.pit.length && r.box.away.pit.length) { writeAtomic(boxFile(pk), JSON.stringify(r)); return r; }
    } catch { /* retried later */ }
    return null;
  }
  function trySeal(s, games) {
    if (s >= currentSeason() || sealedOf(s)) return;
    const all = {};
    for (const pk of games.keys()) { const r = readBox(s, pk); if (!r) return; all[pk] = r; }
    writeAtomic(sealFile(s), zlib.gzipSync(JSON.stringify(all))); sealed.set(s, all);
    for (const pk of games.keys()) { try { fs.unlinkSync(boxFile(pk)); } catch { /* already gone */ } }
    log(`[mlb-vas] sealed ${s}: ${games.size} boxscores`);
  }

  // Engine history: every final regular-season game from firstSeason whose boxscore we have. Missing boxscores are fetched
  // oldest first, maxFetch per call, so the first build is gradual. complete=true once nothing is missing.
  async function history({ maxFetch = 400, concurrency = 3, fromSeason = firstSeason } = {}) {
    const seasons = []; for (let s = fromSeason; s <= currentSeason(); s++) seasons.push(s);
    const bySeason = new Map();
    for (const s of seasons) bySeason.set(s, await season(s));
    const todo = [];
    for (const s of seasons) for (const pk of bySeason.get(s).keys()) if (!readBox(s, pk)) todo.push(pk);
    todo.sort((a, b) => a - b);
    const slice = todo.slice(0, maxFetch); let i = 0, got = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => { while (i < slice.length) { if (await fetchBox(slice[i++])) got++; } }));
    const games = [], pitchers = [];
    for (const s of seasons) {
      const gs = bySeason.get(s);
      trySeal(s, gs);
      for (const g of gs.values()) {
        const r = readBox(s, g.pk);
        if (!r || g.hs == null || g.as == null) continue;
        games.push({ ...g, box: r.box, hp: r.hp, wx: r.wx });
        for (const side of ['home', 'away']) { pitchers.push(r.box[side].pit[0].id); if (g.prob[side]) pitchers.push(g.prob[side]); }
      }
    }
    await ensureHands(pitchers);
    games.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : x.start < y.start ? -1 : x.start > y.start ? 1 : x.pk - y.pk));
    const missing = todo.length - got;
    Object.assign(status, { games: games.length, boxes: games.length, missingBoxes: missing, lastRefresh: new Date(now()).toISOString() });
    if (got) log(`[mlb-vas] fetched ${got} boxscores, ${missing} still missing`);
    return { games, hands, complete: missing === 0, info: { fromSeason, seasons: seasons.length, games: games.length, fetched: got, missing, lastDay: games.length ? games[games.length - 1].day : null } };
  }

  // Upcoming (not final) regular-season games with probable starters. arg: 'YYYYMMDD' | 'YYYY-MM-DD' | {from, to}
  async function upcoming(arg = today()) {
    const from = ymd(typeof arg === 'object' ? arg.from : arg), to = ymd(typeof arg === 'object' ? arg.to || arg.from : arg);
    const d = await cached(`${API}/schedule?sportId=1&gameType=R&startDate=${from}&endDate=${to}&hydrate=probablePitcher,team`, upcomingTtlMs);
    const games = scheduleUpcoming(d);
    await ensureHands(games.flatMap(g => [g.prob.home, g.prob.away]));
    return games;
  }
  async function espnEvents(arg = today()) {
    const day = ymd(arg).replace(/-/g, '');
    const d = await cached(`${ESPN_SB}?dates=${day}&limit=50`, upcomingTtlMs);
    return ((d && d.events) || []).filter(e => e.season && e.season.type === 2).map(e => {
      const c = e.competitions[0], t = Object.fromEntries(c.competitors.map(x => [x.homeAway, x]));
      return { id: e.id, start: c.date || e.date, homeName: t.home.team.displayName, awayName: t.away.team.displayName, state: c.status && c.status.type && c.status.type.state };
    });
  }
  // Per-book opener and current prices for one ESPN event (cached 5 min).
  async function openers(espnId) { return parseOdds(await cached(ESPN_ODDS(espnId), 5 * 60e3)); }

  return { history, upcoming, espnEvents, openers, mapEspn, hands, status: () => ({ ...status, seasons: { ...status.seasons } }) };
}

module.exports = { create, scheduleFinals, scheduleUpcoming, boxRecord, mapEspn, parseOdds, API };
