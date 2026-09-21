#!/usr/bin/env node
'use strict';
/**
 * Bing Bong Live — live MLB home run, at-bat & Statcast tracker.
 * Zero dependencies. Node 18+.
 *
 * Data sources (all public, no keys):
 *   MLB live feed, current at-bat only   …/feed/live?fields=<currentPlay>   pitch-by-pitch, count, runners (~1 KB), every FEED_MS
 *   MLB live feed, every play            …/feed/live?fields=<allPlays>      Statcast hitData + at-bat log, re-read only when the feed changes
 *   MLB win probability                  …/game/{pk}/winProbability         win % and swing for every plate appearance
 *   Baseball Savant feed                 baseballsavant.mlb.com/gf          xBA, barrels, bat speed, HR-in-N-of-30-parks
 *   MLB game content                     …/game/{pk}/content                highlight clip per play (guid === playId)
 *
 * Odds and bets (lib/): Action Network, Pinnacle, ESPN (DraftKings) and VSiN lines with history, plus a private
 * bet log per device. See lib/odds.js and lib/bets.js.
 *
 * The browser gets everything over one Server-Sent Events stream.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Odds = require('./lib/odds');
const BetMGM = require('./lib/betmgm');
const Manual = require('./lib/manual');
const Bets = require('./lib/bets');
const Group = require('./lib/group');

const PORT = Number(process.env.PORT) || 4747;
const FEED_MS = Math.max(1500, Number(process.env.FEED_MS) || 2000); // live at-bat heartbeat per game
const FULL_MAX_AGE = 15000; // re-read the full play list at least this often, even if the feed looks unchanged
const SAVANT_MS = 25000;   // Savant enrichment cadence per live game
const SAVANT_KICK_MS = 7000; // re-check Savant this long after a new ball in play
const CONTENT_MS = 45000;  // highlight-video cadence while clips are missing
const API = 'https://statsapi.mlb.com';
const SAVANT = 'https://baseballsavant.mlb.com';
const PUBLIC = path.join(__dirname, 'public');
// Optional private access: set ACCESS_CODE and visitors enter it once (or open /?code=...), then a cookie remembers them.
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const ACCESS_TOKEN = ACCESS_CODE ? crypto.createHash('sha256').update(`bing-bong-live:${ACCESS_CODE}`).digest('hex').slice(0, 40) : null;
// A second code for guests: the board and their own tickets, never the owner's view. Same shape as the
// owner token so the terminal can mint it for all three sports in one entry.
const GUEST_CODE = (process.env.GUEST_CODE || '').trim();
const GUEST_TOKEN = GUEST_CODE ? crypto.createHash('sha256').update(`bing-bong-live:guest:${GUEST_CODE}`).digest('hex').slice(0, 40) : null;

const HIT_TYPES = new Set(['single', 'double', 'triple', 'home_run']);

// Whitelist of feed keys. Trims the GUMBO feed from ~800 KB to ~75 KB (~15 KB gzipped).
const FEED_FIELDS = [
  'metaData', 'timeStamp', 'gameData', 'status', 'abstractGameState', 'detailedState',
  'liveData', 'plays', 'allPlays', 'result', 'eventType', 'event', 'description', 'rbi', 'awayScore', 'homeScore',
  'about', 'atBatIndex', 'halfInning', 'inning', 'isComplete', 'startTime', 'endTime',
  'matchup', 'batter', 'id', 'fullName', 'pitcher', 'batSide', 'code',
  'playEvents', 'isPitch', 'hitData', 'launchSpeed', 'launchAngle', 'totalDistance', 'trajectory', 'hardness', 'location',
  'coordinates', 'coordX', 'coordY', 'playId',
  'linescore', 'currentInning', 'inningHalf', 'outs', 'teams', 'home', 'away', 'runs', 'hits', 'innings', 'num',
].join(',');
// Only the at-bat in progress: ~1 KB gzipped, so it can be polled every couple of seconds.
const AB_FIELDS = [
  'metaData', 'timeStamp', 'gameData', 'status', 'abstractGameState', 'detailedState',
  'liveData', 'plays', 'currentPlay', 'result', 'eventType', 'event', 'description', 'rbi', 'awayScore', 'homeScore',
  'about', 'atBatIndex', 'halfInning', 'inning', 'isComplete', 'startTime', 'endTime',
  'count', 'balls', 'strikes', 'outs',
  'matchup', 'batter', 'pitcher', 'id', 'fullName', 'batSide', 'pitchHand', 'code',
  'playEvents', 'details', 'call', 'isInPlay', 'isStrike', 'isBall', 'type', 'isPitch', 'pitchNumber',
  'pitchData', 'startSpeed', 'strikeZoneTop', 'strikeZoneBottom', 'coordinates', 'pX', 'pZ', 'breaks', 'spinRate',
  'hitData', 'launchSpeed', 'launchAngle', 'totalDistance', 'trajectory', 'coordX', 'coordY', 'playId',
  'linescore', 'currentInning', 'inningHalf', 'offense', 'onDeck', 'inHole', 'first', 'second', 'third',
  'teams', 'home', 'away', 'runs', 'hits',
].join(',');
const WP_FIELDS = 'atBatIndex,homeTeamWinProbability,homeTeamWinProbabilityAdded,leverageIndex';
const CONTENT_FIELDS = 'highlights,items,guid,headline,duration,playbacks,name,url,image,cuts,width,src';

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// ---------------------------------------------------------------- fetch
async function getJSON(url, timeout = 12000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': 'BingBongLive/1.0 (personal live MLB tracker)' },
    });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function pool(items, n, fn) {
  const q = [...items];
  const worker = async () => {
    while (q.length) {
      const it = q.shift();
      try { await fn(it); } catch (e) { log('pool', e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, worker));
}

// ---------------------------------------------------------------- dates
// The "baseball day" is the US Eastern date, held until 6 AM ET so late West Coast games finish on the right day.
function baseballToday() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  const d = `${p.year}-${p.month}-${p.day}`;
  return Number(p.hour) < 6 ? shiftDate(d, -1) : d;
}
function shiftDate(s, n) {
  const d = new Date(`${s}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- state
class Day {
  constructor(date) {
    this.date = date;
    this.games = new Map();   // gamePk -> Game
    this.events = new Map();  // playId -> Event
    this.pitches = new Map(); // gamePk -> top pitches
    this.swings = new Map();  // gamePk -> top swings
    this.pending = new Map(); // playId -> ball in play, official result not posted yet
    this.loading = null;
    this.touched = Date.now();
  }
}
const days = new Map();
function getDay(date) {
  if (!days.has(date)) days.set(date, new Day(date));
  const d = days.get(date);
  d.touched = Date.now();
  if (days.size > 14) {
    const old = [...days.values()].filter((x) => x !== today && x !== d).sort((a, b) => a.touched - b.touched)[0];
    if (old) days.delete(old.date);
  }
  return d;
}
let today = null;

const teams = new Map(); // id -> { abbr, name }
const teamAbbr = (id) => teams.get(id)?.abbr || null;

const dead = (G) => /postponed|cancel|suspended/i.test(G.detail || '');

function gameFromSchedule(g) {
  const side = (s) => {
    const t = g.teams[s];
    const ls = g.linescore?.teams?.[s] || {};
    return {
      id: t.team.id,
      abbr: t.team.abbreviation || teamAbbr(t.team.id),
      name: t.team.teamName || t.team.name,
      full: t.team.name,
      score: t.score ?? ls.runs ?? null,
      hits: ls.hits ?? null,
      record: t.leagueRecord ? `${t.leagueRecord.wins}-${t.leagueRecord.losses}` : null,
    };
  };
  return {
    pk: g.gamePk,
    start: g.gameDate,
    state: g.status.abstractGameState,
    detail: g.status.detailedState,
    away: side('away'),
    home: side('home'),
    inning: g.linescore?.currentInning ?? null,
    half: g.linescore?.inningHalf ?? null,
    outs: g.linescore?.outs ?? null,
    venue: { id: g.venue?.id, name: g.venue?.name, field: g.venue?.fieldInfo || null },
    ab: null,         // at-bat in progress
    log: [],          // every completed plate appearance
    wp: [],           // win probability after each plate appearance
    wpNow: null,
    // internal bookkeeping
    feedAt: 0, feedTs: null, nowTs: null, fullAt: 0, loadedOnce: false, finalPasses: 0,
    pitchesDone: {}, doneAbs: new Set(), wpDue: 0, wpAt: 0, wpRetries: 0, appliedTs: null, savantPlan: [],
    savantAt: 0, savantDue: 0, savantFinal: false,
    contentAt: 0, finalAt: 0,
    _feed: false, _sav: false, _con: false, _now: false, _wp: false,
  };
}

function publicGame(G) {
  return {
    pk: G.pk, start: G.start, state: G.state, detail: G.detail,
    away: G.away, home: G.home, inning: G.inning, half: G.half, outs: G.outs,
    venue: G.venue, feedAt: G.feedAt, wp: G.wpNow?.home ?? null,
    logN: G.log.length, wpN: G.wp.length,
  };
}

function topAcross(map, n = 15) {
  return [...map.values()].flat().sort((a, b) => b.mph - a.mph).slice(0, n);
}

// `uid` is the viewer's owner id: the snapshot carries only that owner's bets.
function snapshot(day, uid, role = 'owner') {
  const me = Group.person(uid);
  return {
    // Who you are on this board, and the name a guest is greeted with.
    me: { role, name: me?.name || '', named: !!me?.name, owner: OWNER_NAME || '', shared: !!ACCESS_TOKEN },
    date: day.date,
    today: day === today,
    now: Date.now(),
    feedMs: FEED_MS,
    games: [...day.games.values()].map(publicGame),
    events: [...day.events.values()],
    pitches: topAcross(day.pitches),
    swings: topAcross(day.swings),
    pending: [...day.pending.values()],
    atbats: Object.fromEntries([...day.games.values()].filter((g) => g.ab).map((g) => [g.pk, g.ab])),
    odds: Odds.snapshot(day.date),
    bets: uid ? Bets.list(uid) : [],
  };
}

// ---------------------------------------------------------------- SSE
const clients = new Set();
function emit(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
// Anything with bets in it is written per connection, each to its own owner (res.uid). Never broadcast.
function emitSnapshot() {
  for (const res of clients) res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(today, res.uid, res.role))}\n\n`);
}
function emitBets(owners) {
  for (const res of clients) {
    if (owners && !owners.has(res.uid)) continue;
    res.write(`event: bets\ndata: ${JSON.stringify(Bets.list(res.uid))}\n\n`);
  }
}

// ---------------------------------------------------------------- schedule
async function refreshSchedule(day) {
  const j = await getJSON(
    `${API}/api/v1/schedule?sportId=1&date=${day.date}&hydrate=linescore,team,venue(fieldInfo)&_=${Date.now()}`,
  );
  const list = j.dates?.[0]?.games || [];
  for (const g of list) {
    const fresh = gameFromSchedule(g);
    const G = day.games.get(g.gamePk);
    if (!G) {
      if (fresh.state === 'Final' && !dead(fresh)) {
        fresh.finalPasses = 1;
        fresh.finalAt = Date.now(); // lets late highlight clips still attach
        fresh.savantPlan = [0];
      }
      day.games.set(g.gamePk, fresh);
      if (day === today) emit('game', publicGame(fresh));
      continue;
    }
    // Schedule is slower than the live feed; only let it move a game forward.
    const before = JSON.stringify(publicGame(G));
    // A suspended game can resume (even on another day); let the schedule bring it back.
    if (dead(G) && G.state === 'Live') { G.state = fresh.state; G.detail = fresh.detail; }
    if (G.state === 'Preview' || (G.state === 'Live' && fresh.state === 'Final')) {
      if (fresh.state === 'Final' && G.state !== 'Final') markFinal(G);
      G.state = fresh.state;
      G.detail = fresh.detail;
    }
    if (G.state === 'Preview') G.detail = fresh.detail;
    if (!G.feedAt) {
      Object.assign(G, { away: fresh.away, home: fresh.home, inning: fresh.inning, half: fresh.half, outs: fresh.outs });
    }
    G.start = fresh.start;
    if (fresh.venue.field) G.venue = fresh.venue;
    if (day === today && before !== JSON.stringify(publicGame(G))) emit('game', publicGame(G));
  }
}

function markFinal(G) {
  G.finalPasses = 2;
  G.wpDue = Date.now() + 4000;
  const now = Date.now();
  G.savantPlan = [now + 5000, now + 60e3, now + 300e3]; // Savant can lag the final out
  G.wpRetries = 0;
  G.finalAt = now;
  G.contentAt = 0;
}

// ---------------------------------------------------------------- live feed
// Returns false (and changes nothing) when this response is older than one already applied.
function applyStatus(G, j) {
  const ts = j.metaData?.timeStamp;
  if (ts && G.appliedTs && ts < G.appliedTs) return false;
  if (ts) G.appliedTs = ts;
  const st = j.gameData?.status;
  if (st) {
    if (st.abstractGameState === 'Final' && G.state !== 'Final') markFinal(G);
    G.state = st.abstractGameState;
    G.detail = st.detailedState;
  }
  const ls = j.liveData?.linescore;
  if (ls) {
    G.f5 = fiveInnings(ls);
    G.inning = ls.currentInning ?? G.inning;
    G.half = ls.inningHalf ?? G.half;
    G.outs = ls.outs ?? G.outs;
    for (const s of ['away', 'home']) {
      if (ls.teams?.[s]) {
        G[s].score = ls.teams[s].runs ?? G[s].score ?? 0;
        G[s].hits = ls.teams[s].hits ?? G[s].hits ?? 0;
      }
    }
  }
  return true;
}

const NOT_AB = new Set(['walk', 'intent_walk', 'hit_by_pitch', 'sac_fly', 'sac_bunt', 'catcher_interf', 'sac_fly_double_play', 'sac_bunt_double_play']);
const LINE_TAG = { home_run: 'HR', double: '2B', triple: '3B', walk: 'BB', intent_walk: 'BB', hit_by_pitch: 'HBP', strikeout: 'K', strikeout_double_play: 'K' };
// "2-for-3 · HR · K" from the plate appearances so far.
function lineOf(list, id) {
  const pas = list.filter((x) => x.batter.id === id);
  if (!pas.length) return null;
  let ab = 0, h = 0;
  const tags = {};
  for (const x of pas) {
    if (!NOT_AB.has(x.kind)) ab++;
    if (HIT_TYPES.has(x.kind)) h++;
    const t = LINE_TAG[x.kind];
    if (t) tags[t] = (tags[t] || 0) + 1;
  }
  return [`${h}-for-${ab}`, ...Object.entries(tags).map(([t, n]) => (n > 1 ? `${n} ${t}` : t))].join(' · ');
}

function buildAtBat(G, cp, ls) {
  const pe = cp.playEvents || [];
  const top = cp.about?.halfInning === 'top';
  const bat = top ? G.away : G.home;
  const fld = top ? G.home : G.away;
  const person = (p) => (p?.id ? { id: p.id, name: p.fullName } : null);
  const pitches = [];
  for (const e of pe) {
    if (!e.isPitch) continue;
    const pd = e.pitchData || {};
    const d = e.details || {};
    pitches.push({
      n: e.pitchNumber ?? pitches.length + 1,
      code: d.type?.code || null,
      type: d.type?.description || null,
      mph: num(pd.startSpeed),
      spin: num(pd.breaks?.spinRate),
      call: d.description || d.call?.description || null,
      k: d.isInPlay ? 'X' : d.isStrike ? 'S' : d.isBall ? 'B' : null,
      px: num(pd.coordinates?.pX),
      pz: num(pd.coordinates?.pZ),
      top: num(pd.strikeZoneTop),
      bot: num(pd.strikeZoneBottom),
      count: e.count ? `${e.count.balls}-${e.count.strikes}` : null,
      t: e.startTime || null,
      hit: e.hitData ? { ev: num(e.hitData.launchSpeed), la: num(e.hitData.launchAngle), dist: num(e.hitData.totalDistance) } : null,
    });
  }
  let note = null;
  for (let i = pe.length - 1; i >= 0; i--) if (!pe[i].isPitch && pe[i].details?.description) { note = pe[i].details.description; break; }
  const off = ls?.offense || {};
  const bId = cp.matchup?.batter?.id;
  const pId = cp.matchup?.pitcher?.id;
  const ab = cp.about?.atBatIndex ?? null;
  const counted = cp.about?.isComplete && G.doneAbs.has(ab);
  return {
    ab,
    inning: cp.about?.inning ?? null,
    half: cp.about?.halfInning || null,
    balls: cp.count?.balls ?? 0,
    strikes: cp.count?.strikes ?? 0,
    outs: cp.count?.outs ?? 0,
    batter: { id: bId, name: cp.matchup?.batter?.fullName, side: cp.matchup?.batSide?.code || null, today: lineOf(G.log, bId), season: seasonLine(bId, 'hitting') },
    pitcher: {
      id: pId, name: cp.matchup?.pitcher?.fullName, hand: cp.matchup?.pitchHand?.code || null,
      pitches: (G.pitchesDone[pId] || 0) + (counted ? 0 : pitches.length), season: seasonLine(pId, 'pitching'),
    },
    team: { id: bat.id, abbr: bat.abbr },
    opp: { id: fld.id, abbr: fld.abbr },
    score: { away: G.away.score ?? 0, home: G.home.score ?? 0 },
    onDeck: person(off.onDeck),
    inHole: person(off.inHole),
    bases: { first: person(off.first), second: person(off.second), third: person(off.third) },
    pitches,
    note,
    result: cp.result?.eventType ? { kind: cp.result.eventType, event: cp.result.event, desc: cp.result.description } : null,
  };
}

function setAtBat(day, G, ab) {
  const key = ab ? JSON.stringify(ab) : null;
  if (key === G.abKey) return;
  G.abKey = key;
  G.ab = ab;
  if (day === today) emit('atbat', { pk: G.pk, ab });
}

function extractEvent(G, p) {
  const r = p.result || {};
  const kind = r.eventType;
  if (!kind || !p.about?.isComplete && !p.about?.endTime) return null;
  const pe = p.playEvents || [];
  let hitEv = null;
  for (let i = pe.length - 1; i >= 0; i--) if (pe[i].hitData) { hitEv = pe[i]; break; }
  const isHit = HIT_TYPES.has(kind);
  if (!hitEv && !isHit) return null;
  const h = hitEv?.hitData || {};
  const ev = num(h.launchSpeed);
  const dist = num(h.totalDistance);
  // Keep every hit, plus outs worth talking about (hard-hit or deep).
  if (!isHit && !((ev ?? 0) >= 95 || (dist ?? 0) >= 300)) return null;
  const top = p.about?.halfInning === 'top';
  const bat = top ? G.away : G.home;
  const fld = top ? G.home : G.away;
  const isHR = kind === 'home_run';
  const m = /\((\d+)\)/.exec(r.description || '');
  return {
    id: hitEv?.playId || `${G.pk}-${p.about?.atBatIndex}`,
    pk: G.pk,
    ab: p.about?.atBatIndex ?? null,
    t: p.about?.endTime || null,
    contact: hitEv?.startTime || null,
    inning: p.about?.inning ?? null,
    half: p.about?.halfInning || null,
    kind,
    label: r.event || kind,
    desc: r.description || '',
    rbi: r.rbi ?? 0,
    score: { away: r.awayScore ?? null, home: r.homeScore ?? null },
    batter: { id: p.matchup?.batter?.id, name: p.matchup?.batter?.fullName, side: p.matchup?.batSide?.code || null },
    pitcher: { id: p.matchup?.pitcher?.id, name: p.matchup?.pitcher?.fullName },
    team: { id: bat.id, abbr: bat.abbr },
    opp: { id: fld.id, abbr: fld.abbr },
    ev,
    la: num(h.launchAngle),
    dist,
    traj: h.trajectory || null,
    hard: h.hardness || null,
    cx: num(h.coordinates?.coordX),
    cy: num(h.coordinates?.coordY),
    isHit,
    isHR,
    seasonHR: isHR && m ? Number(m[1]) : null,
    grandSlam: isHR && /grand slam/i.test(r.description || ''),
    inside: isHR && /inside-the-park/i.test(r.description || ''),
    walkoff: false,
  };
}

// The ball is in play and Statcast has measured it, but the scorer hasn't posted the result.
// MLB typically posts the result 5–35 s after the measurement, so this is the earliest signal there is.
function extractPending(G, p) {
  if (p.result?.eventType) return null;
  const pe = p.playEvents || [];
  let hitEv = null;
  for (let i = pe.length - 1; i >= 0; i--) if (pe[i].hitData) { hitEv = pe[i]; break; }
  if (!hitEv?.playId) return null;
  const h = hitEv.hitData;
  const top = p.about?.halfInning === 'top';
  const bat = top ? G.away : G.home;
  const fld = top ? G.home : G.away;
  return {
    id: hitEv.playId,
    pk: G.pk,
    contact: hitEv.startTime || null,
    inning: p.about?.inning ?? null,
    half: p.about?.halfInning || null,
    batter: { id: p.matchup?.batter?.id, name: p.matchup?.batter?.fullName },
    team: { id: bat.id, abbr: bat.abbr },
    opp: { id: fld.id, abbr: fld.abbr },
    ev: num(h.launchSpeed),
    la: num(h.launchAngle),
    dist: num(h.totalDistance),
    traj: h.trajectory || null,
    cx: num(h.coordinates?.coordX),
    cy: num(h.coordinates?.coordY),
  };
}

function upsertPending(day, b) {
  const prev = day.pending.get(b.id);
  b.seenAt = prev ? prev.seenAt : Date.now();
  if (prev && JSON.stringify([prev.ev, prev.la, prev.dist, prev.cx]) === JSON.stringify([b.ev, b.la, b.dist, b.cx])) return;
  day.pending.set(b.id, b);
  if (day === today) emit('pending', b);
}

const ENRICH = ['xba', 'barrel', 'bat', 'parks', 'pitchMph', 'pitchName', 'video', 'wp'];
const coreKey = (e) => JSON.stringify([e.kind, e.desc, e.ev, e.la, e.dist, e.cx, e.cy, e.t, e.score, e.walkoff, e.rbi]);

function upsertEvent(day, e, live) {
  const prev = day.events.get(e.id);
  if (prev) {
    for (const k of ENRICH) if (prev[k] !== undefined) e[k] = prev[k];
    e.seenAt = prev.seenAt;
    e.live = prev.live;
    if (coreKey(prev) === coreKey(e)) return false;
  } else {
    const early = day.pending.get(e.id);
    e.seenAt = early ? early.seenAt : Date.now();
    e.live = !!live || !!early;
  }
  day.pending.delete(e.id);
  day.events.set(e.id, e);
  if (day === today) emit('event', e);
  return !prev;
}

function patchEvent(day, e, patch) {
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) continue;
    if (JSON.stringify(e[k]) !== JSON.stringify(v)) { e[k] = v; changed = true; }
  }
  if (changed && day === today) emit('event', e);
  return changed;
}

async function pollFeed(day, G) {
  if (G._feed) return;
  G._feed = true;
  const started = Date.now();
  try {
    const j = await getJSON(`${API}/api/v1.1/game/${G.pk}/feed/live?fields=${FEED_FIELDS}&_=${Date.now()}`);
    G.feedAt = G.fullAt = Date.now();
    const before = JSON.stringify(publicGame(G));
    if (applyStatus(G, j)) {
      if (day === today && before !== JSON.stringify(publicGame(G))) emit('game', publicGame(G));
      if (G.state === 'Final' && G.ab) setAtBat(day, G, null);
    }

    const ts = j.metaData?.timeStamp;
    if (ts && G.feedTs && ts <= G.feedTs) return; // nothing newer than what we already processed
    G.feedTs = ts;

    const plays = j.liveData?.plays?.allPlays || [];
    const found = [];
    const pend = [];
    const logList = [];
    const pitchesDone = {};
    const doneAbs = new Set();
    for (const p of plays) {
      const e = extractEvent(G, p);
      if (e) found.push(e);
      else if (G.state === 'Live') {
        const b = extractPending(G, p);
        if (b) pend.push(b);
      }
      if (!p.about?.isComplete || !p.result?.eventType) continue;
      const pid = p.matchup?.pitcher?.id;
      doneAbs.add(p.about.atBatIndex);
      if (pid) pitchesDone[pid] = (pitchesDone[pid] || 0) + (p.playEvents || []).filter((x) => x.isPitch).length;
      let hitId = null;
      for (const x of p.playEvents || []) if (x.hitData && x.playId) hitId = x.playId;
      logList.push({
        ab: p.about.atBatIndex, inning: p.about.inning, half: p.about.halfInning,
        batter: { id: p.matchup?.batter?.id, name: p.matchup?.batter?.fullName },
        pitcher: { id: pid, name: p.matchup?.pitcher?.fullName },
        kind: p.result.eventType, event: p.result.event, desc: p.result.description || '',
        rbi: p.result.rbi || 0, score: { away: p.result.awayScore ?? null, home: p.result.homeScore ?? null },
        id: hitId,
      });
    }
    const logGrew = logList.length !== G.log.length;
    if (logGrew) G.wpDue = Date.now() + 1500;
    G.log = logList;
    if (logGrew && day === today) emit('game', publicGame(G));
    G.pitchesDone = pitchesDone;
    G.doneAbs = doneAbs;
    // Walk-off: last play of a final game, home team, took the lead in the 9th or later.
    if (G.state === 'Final' && plays.length) {
      const last = plays[plays.length - 1];
      const r = last.result || {};
      if (last.about?.halfInning === 'bottom' && last.about?.inning >= 9 && r.homeScore > r.awayScore) {
        const e = found.find((x) => x.ab === last.about.atBatIndex);
        if (e && e.isHit) e.walkoff = true;
      }
    }
    const justFinal = G.state === 'Final' && G.finalAt && Date.now() - G.finalAt < 3 * 60e3;
    const live = G.loadedOnce && (G.state === 'Live' || justFinal);
    let newBall = false;
    for (const e of found) if (upsertEvent(day, e, live)) newBall = true;
    const pendIds = new Set();
    for (const b of pend) {
      pendIds.add(b.id);
      upsertPending(day, b);
    }
    for (const [id, b] of day.pending) {
      // Only drop balls this response should have known about; the at-bat heartbeat may have added newer ones.
      if (b.pk === G.pk && !pendIds.has(id) && !day.events.has(id) && b.seenAt < started) {
        day.pending.delete(id);
        if (day === today) emit('unpending', { id });
      }
    }
    // Plays can be reversed on review; drop anything the feed no longer lists.
    const ids = new Set(found.map((e) => e.id));
    for (const [id, e] of day.events) {
      if (e.pk === G.pk && !ids.has(id)) {
        day.events.delete(id);
        if (day === today) emit('remove', { id });
      }
    }
    if (newBall && live) {
      const due = Date.now() + SAVANT_KICK_MS;
      G.savantDue = G.savantDue ? Math.min(G.savantDue, due) : due;
    }
    G.loadedOnce = true;
  } catch (e) {
    log('feed', G.pk, e.message);
  } finally {
    G._feed = false;
  }
}

// The heartbeat: the at-bat in progress, every FEED_MS. It also spots a changed feed
// (new pitch, new play) so the full play list is only re-read when there is something new.
async function pollNow(day, G) {
  if (G._now) return;
  G._now = true;
  try {
    const j = await getJSON(`${API}/api/v1.1/game/${G.pk}/feed/live?fields=${AB_FIELDS}&_=${Date.now()}`, 8000);
    G.feedAt = Date.now();
    G.nowTs = j.metaData?.timeStamp || null;
    const before = JSON.stringify(publicGame(G));
    if (!applyStatus(G, j)) return; // an older response than one we already used
    if (day === today && before !== JSON.stringify(publicGame(G))) emit('game', publicGame(G));
    if (dead(G)) { setAtBat(day, G, null); return; }
    const cp = j.liveData?.plays?.currentPlay;
    setAtBat(day, G, G.state === 'Live' && cp ? buildAtBat(G, cp, j.liveData?.linescore) : null);
    const justFinal = G.state === 'Final' && G.finalAt && Date.now() - G.finalAt < 60e3;
    if (cp && (G.state === 'Live' || justFinal) && G.loadedOnce) {
      const b = extractPending(G, cp);
      if (b && !day.events.has(b.id)) upsertPending(day, b);
    }
  } catch (e) {
    log('now', G.pk, e.message);
  } finally {
    G._now = false;
  }
}

async function pollWP(day, G) {
  if (G._wp) return;
  G._wp = true;
  try {
    const j = await getJSON(`${API}/api/v1/game/${G.pk}/winProbability?fields=${WP_FIELDS}&_=${Date.now()}`);
    G.wpAt = Date.now();
    const list = (Array.isArray(j) ? j : [])
      .map((x) => ({ ab: x.atBatIndex, home: r1(x.homeTeamWinProbability), added: r1(x.homeTeamWinProbabilityAdded), li: x.leverageIndex ?? null }))
      .filter((x) => x.ab != null && x.home != null);
    G.wp = list;
    const lastPA = G.log[G.log.length - 1]?.ab;
    if (lastPA != null && (!list.length || list[list.length - 1].ab < lastPA) && G.wpRetries < 6) {
      G.wpRetries++;
      G.wpDue = Date.now() + 10000; // MLB hasn't scored the latest play yet
    } else G.wpRetries = 0;
    const before = JSON.stringify(publicGame(G));
    const last = list[list.length - 1];
    G.wpNow = last ? { home: last.home, li: last.li } : null;
    if (day === today && before !== JSON.stringify(publicGame(G))) emit('game', publicGame(G));
    const byAb = new Map(list.map((x) => [x.ab, x]));
    for (const e of day.events.values()) {
      if (e.pk !== G.pk) continue;
      const w = byAb.get(e.ab);
      if (!w) continue;
      const top = e.half === 'top';
      patchEvent(day, e, { wp: { after: r1(top ? 100 - w.home : w.home), added: r1(top ? -w.added : w.added) } });
    }
  } catch (e) {
    log('winprob', G.pk, e.message);
    if (G.wpRetries++ < 6) G.wpDue = Date.now() + 10000;
  } finally {
    G._wp = false;
  }
}

// ---------------------------------------------------------------- season lines (batch, cached)
const lines = new Map(); // personId -> { t, name, teamId, hitting, pitching }
const lineQueue = new Set();
let linesPausedUntil = 0;
function seasonLine(id, group) {
  if (!id) return null;
  const c = lines.get(id);
  if (!c || Date.now() - c.t > 15 * 60e3) lineQueue.add(id);
  return c?.[group] || null;
}
async function fetchLines(ids) {
  const season = (today?.date || baseballToday()).slice(0, 4);
  try {
    const j = await getJSON(
      `${API}/api/v1/people?personIds=${ids.join(',')}&hydrate=currentTeam,stats(group=[hitting,pitching],type=[season],season=${season})`,
    );
    for (const id of ids) if (!lines.has(id)) lines.set(id, { t: Date.now(), name: null, teamId: null, hitting: null, pitching: null });
    for (const p of j.people || []) {
      const out = { t: Date.now(), name: p.fullName, teamId: p.currentTeam?.id ?? null, pos: p.primaryPosition?.abbreviation || null, hitting: null, pitching: null };
      for (const s of p.stats || []) {
        const st = s.splits?.[0]?.stat;
        if (!st) continue;
        if (s.group?.displayName === 'hitting') out.hitting = { avg: st.avg, hr: st.homeRuns, ops: st.ops, g: st.gamesPlayed };
        if (s.group?.displayName === 'pitching') out.pitching = { era: st.era, k: st.strikeOuts, ip: st.inningsPitched, whip: st.whip, g: st.gamesPlayed };
      }
      lines.set(p.id, out);
    }
  } catch (e) {
    if (e.status >= 400 && e.status < 500) {
      // One bad id fails the whole batch: split it, and give up on ids that fail alone.
      if (ids.length > 1) {
        const mid = Math.ceil(ids.length / 2);
        await fetchLines(ids.slice(0, mid));
        await fetchLines(ids.slice(mid));
      } else lines.set(ids[0], { t: Date.now(), name: null, teamId: null, hitting: null, pitching: null });
      return;
    }
    log('lines', e.message);
    ids.forEach((i) => lineQueue.add(i));
    linesPausedUntil = Date.now() + 10000;
  }
}
setInterval(() => {
  if (!lineQueue.size || Date.now() < linesPausedUntil) return;
  const ids = [...lineQueue].slice(0, 40);
  ids.forEach((i) => lineQueue.delete(i));
  fetchLines(ids);
}, 700);
async function ensureLines(ids) {
  const missing = ids.filter((id) => !lines.has(id));
  if (!missing.length) return;
  missing.forEach((id) => lineQueue.delete(id));
  await fetchLines(missing);
}

// ---------------------------------------------------------------- Savant enrichment
async function pollSavant(day, G) {
  if (G._sav) return;
  G._sav = true;
  try {
    const j = await getJSON(`${SAVANT}/gf?game_pk=${G.pk}&_=${Date.now()}`, 25000);
    G.savantAt = Date.now();
    for (const r of j.exit_velocity || []) {
      const e = day.events.get(r.play_id);
      if (!e) continue;
      patchEvent(day, e, {
        xba: num(r.xba),
        barrel: r.is_barrel === null || r.is_barrel === undefined ? null : Number(r.is_barrel) === 1,
        bat: num(r.batSpeed) || null,
        parks: num(r.contextMetrics?.homeRunBallparks),
        pitchMph: num(r.start_speed),
        pitchName: r.pitch_name || null,
      });
    }
    const seen = new Set();
    const all = [];
    for (const r of [...(j.team_home || []), ...(j.team_away || [])]) {
      if (!r.play_id || seen.has(r.play_id)) continue;
      seen.add(r.play_id);
      all.push(r);
    }
    const base = (r) => ({ id: r.play_id, pk: G.pk, inning: r.inning, half: r.half_inning });
    const pitches = all
      .filter((r) => num(r.start_speed))
      .sort((a, b) => num(b.start_speed) - num(a.start_speed))
      .slice(0, 15)
      .map((r) => ({
        ...base(r), mph: num(r.start_speed), type: r.pitch_name || r.pitch_type,
        pitcher: { id: r.pitcher, name: r.pitcher_name }, batter: { id: r.batter, name: r.batter_name },
        team: r.team_fielding, result: r.call_name || r.description,
      }));
    const swings = all
      .filter((r) => num(r.batSpeed) > 0)
      .sort((a, b) => num(b.batSpeed) - num(a.batSpeed))
      .slice(0, 15)
      .map((r) => ({
        ...base(r), mph: num(r.batSpeed), batter: { id: r.batter, name: r.batter_name },
        team: r.team_batting, result: r.result || r.description, ev: num(r.launch_speed),
      }));
    const changed = JSON.stringify(day.pitches.get(G.pk)) !== JSON.stringify(pitches)
      || JSON.stringify(day.swings.get(G.pk)) !== JSON.stringify(swings);
    day.pitches.set(G.pk, pitches);
    day.swings.set(G.pk, swings);
    if (changed && day === today) emit('extras', { pitches: topAcross(day.pitches), swings: topAcross(day.swings) });
  } catch (e) {
    log('savant', G.pk, e.message);
  } finally {
    G._sav = false;
  }
}

// ---------------------------------------------------------------- highlight clips
// MLB posts alternate angles of the same play; the broadcast cut is the one to show.
const altView = (title) => /field view|statcast|data viz|angle|breaking down|slow-mo|in slow motion|mic'd|pitch breakdown|recap|condensed/i.test(title || '');
function videoOf(it) {
  const pb = it.playbacks || [];
  const mp4 = (pb.find((p) => p.name === 'mp4Avc') || pb.find((p) => /\.mp4($|\?)/.test(p.url || '')))?.url;
  if (!mp4) return null;
  const cuts = it.image?.cuts || [];
  const thumb = (cuts.find((c) => c.width >= 640 && c.width <= 1280) || cuts[0])?.src || null;
  return { mp4, thumb, title: it.headline || null, dur: it.duration || null };
}

async function pollContent(day, G) {
  if (G._con) return;
  G._con = true;
  try {
    const j = await getJSON(`${API}/api/v1/game/${G.pk}/content?fields=${CONTENT_FIELDS}&_=${Date.now()}`);
    G.contentAt = Date.now();
    for (const it of j.highlights?.highlights?.items || []) {
      const e = it.guid && day.events.get(it.guid);
      const v = e && videoOf(it);
      if (v && (!e.video || altView(e.video.title) || !altView(v.title))) patchEvent(day, e, { video: v });
    }
  } catch (e) {
    log('content', G.pk, e.message);
  } finally {
    G._con = false;
  }
}

// ---------------------------------------------------------------- loops (today only)
async function scheduleLoop() {
  let rolled = false;
  const date = baseballToday();
  if (!today || date !== today.date) {
    today = getDay(date);
    rolled = true;
    log('baseball day', date);
  }
  if (!teams.size) await loadTeams(date.slice(0, 4));
  try {
    await refreshSchedule(today);
  } catch (e) {
    log('schedule', e.message);
  }
  if (rolled) emitSnapshot();
  const soon = [...today.games.values()].some(
    (g) => g.state === 'Live' || (g.state === 'Preview' && Date.parse(g.start) - Date.now() < 20 * 60e3),
  );
  setTimeout(scheduleLoop, soon ? 15000 : 60000);
}

function feedLoop() {
  if (today) {
    const now = Date.now();
    for (const G of today.games.values()) {
      if (dead(G)) {
        if (G.state === 'Live' && now - (G.feedAt || 0) > 30000) pollNow(today, G); // watch for a resumption
        continue;
      }
      if (G.state === 'Live') {
        pollNow(today, G);
        const changed = G.nowTs && G.nowTs !== G.feedTs;
        if (!G._feed && (!G.loadedOnce || changed || now - G.fullAt > FULL_MAX_AGE)) pollFeed(today, G);
      } else if (G.state === 'Final' && G.finalPasses > 0 && !G._feed) {
        G.finalPasses--;
        pollFeed(today, G);
      }
      if (G.wpDue && now >= G.wpDue && !G._wp && G.loadedOnce) {
        G.wpDue = 0;
        pollWP(today, G);
      }
    }
  }
  setTimeout(feedLoop, FEED_MS);
}

function savantLoop() {
  if (today) {
    const now = Date.now();
    let inflight = [...today.games.values()].filter((g) => g._sav).length;
    for (const G of today.games.values()) {
      if (inflight >= 4) break;
      if (dead(G) || !G.loadedOnce || G._sav) continue;
      const due = G.state === 'Live'
        ? now - G.savantAt > SAVANT_MS || (G.savantDue && now >= G.savantDue)
        : G.state === 'Final' && G.savantPlan.length > 0 && now >= G.savantPlan[0];
      if (!due) continue;
      G.savantDue = 0;
      inflight++;
      const wasFinal = G.state === 'Final';
      const prevAt = G.savantAt;
      pollSavant(today, G).then(() => {
        if (!wasFinal) return;
        if (G.savantAt > prevAt) G.savantPlan.shift();
        else G.savantPlan[0] = Date.now() + 30000; // failed; try again later
      });
    }
  }
  setTimeout(savantLoop, 2000);
}

function contentLoop() {
  if (today) {
    const now = Date.now();
    for (const G of today.games.values()) {
      if (dead(G) || !G.loadedOnce || G._con) continue;
      const missing = [...today.events.values()].some((e) => e.pk === G.pk && e.isHR && !e.video);
      if (!missing && G.contentAt) continue;
      const every = G.state === 'Live' ? CONTENT_MS
        : G.state === 'Final' && now - (G.finalAt || 0) < 3 * 3600e3 ? 90000
        : Infinity;
      if (!G.contentAt || now - G.contentAt > every) pollContent(today, G);
    }
  }
  setTimeout(contentLoop, 10000);
}

setInterval(() => {
  if (!today || !clients.size) return;
  const live = [...today.games.values()].filter((g) => g.state === 'Live' && !dead(g));
  emit('tick', { now: Date.now(), live: live.length, feedAt: Math.max(0, ...live.map((g) => g.feedAt)) });
}, 2000);

// ---------------------------------------------------------------- other days, leaders, players
async function loadDay(day) {
  if (day === today) return;
  if (!day.loading) {
    day.loading = (async () => {
      await refreshSchedule(day);
      const gs = [...day.games.values()].filter((g) => g.state !== 'Preview' && !dead(g));
      const load = async (G) => {
        if (!G.loadedOnce) await pollFeed(day, G);
        if (!G.loadedOnce) return;
        await Promise.all([G.savantAt || pollSavant(day, G), G.contentAt || pollContent(day, G), G.wpAt || pollWP(day, G)]);
      };
      const incomplete = () => gs.filter((G) => !G.loadedOnce || !G.savantAt || !G.contentAt || !G.wpAt);
      await pool(gs, 5, load);
      if (incomplete().length) await pool(incomplete(), 5, load); // one retry now
      if (incomplete().length) day.retry = true; // and again on the next request
    })().catch((e) => {
      day.loading = null;
      throw e;
    });
  }
  await day.loading;
  if (day.retry) { day.retry = false; day.loading = null; }
}

const memo = new Map();
async function cached(key, ttl, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fn();
  memo.set(key, { t: Date.now(), v });
  return v;
}

async function loadTeams(season) {
  try {
    const j = await getJSON(`${API}/api/v1/teams?sportId=1&season=${season}`);
    for (const t of j.teams || []) teams.set(t.id, { abbr: t.abbreviation, name: t.teamName });
  } catch (e) {
    log('teams', e.message);
  }
}

const LEADER_CATS = ['homeRuns', 'hits', 'runsBattedIn', 'stolenBases'];
function leaders(season) {
  return cached(`leaders:${season}`, 3 * 60e3, async () => {
    const j = await getJSON(
      `${API}/api/v1/stats/leaders?leaderCategories=${LEADER_CATS.join(',')}&season=${season}&sportId=1&limit=15&statGroup=hitting`,
    );
    const cats = {};
    for (const c of j.leagueLeaders || []) {
      cats[c.leaderCategory] = (c.leaders || []).map((l) => ({
        rank: l.rank, value: Number(l.value), id: l.person?.id, name: l.person?.fullName,
        teamId: l.team?.id, abbr: teamAbbr(l.team?.id),
      }));
    }
    return { season, cats, at: Date.now() };
  });
}

function player(id, season) {
  return cached(`player:${id}:${season}`, 2 * 60e3, async () => {
    const j = await getJSON(
      `${API}/api/v1/people/${id}?hydrate=currentTeam,stats(group=[hitting,pitching],type=[season,gameLog],season=${season})`,
    );
    const p = j.people?.[0];
    if (!p) throw new Error('No such player');
    const stats = p.stats || [];
    const pick = (type, group) => stats.find((s) => s.type?.displayName === type && s.group?.displayName === group);
    const st = pick('season', 'hitting')?.splits?.[0]?.stat || {};
    const logs = pick('gameLog', 'hitting')?.splits || [];
    const ps = pick('season', 'pitching')?.splits?.[0]?.stat || null;
    return {
      id: p.id,
      name: p.fullName,
      pos: p.primaryPosition?.abbreviation || null,
      number: p.primaryNumber || null,
      bats: p.batSide?.code || null,
      age: p.currentAge || null,
      team: { id: p.currentTeam?.id, abbr: teamAbbr(p.currentTeam?.id), name: p.currentTeam?.name },
      season: {
        g: st.gamesPlayed, hr: st.homeRuns, h: st.hits, avg: st.avg, ops: st.ops, rbi: st.rbi,
        sb: st.stolenBases, d: st.doubles, t: st.triples, ab: st.atBats,
      },
      log: logs.map((s) => ({ date: s.date, hr: s.stat?.homeRuns || 0, h: s.stat?.hits || 0, opp: teamAbbr(s.opponent?.id) })),
      pitching: ps && {
        g: ps.gamesPlayed, gs: ps.gamesStarted, w: ps.wins, l: ps.losses, sv: ps.saves, era: ps.era, ip: ps.inningsPitched,
        k: ps.strikeOuts, bb: ps.baseOnBalls, whip: ps.whip, hr: ps.homeRuns, avg: ps.avg,
      },
    };
  });
}

function findGame(pk) {
  for (const d of [today, ...days.values()]) {
    const G = d?.games.get(pk);
    if (G) return { day: d, G };
  }
  return null;
}

function matchup(b, p) {
  return cached(`vs:${b}:${p}`, 6 * 3600e3, async () => {
    const j = await getJSON(`${API}/api/v1/people/${b}/stats?stats=vsPlayer&opposingPlayerId=${p}&group=hitting`);
    const tot = (j.stats || []).find((s) => s.type?.displayName === 'vsPlayerTotal')?.splits?.[0]?.stat;
    if (!tot) return { pa: 0 };
    return {
      pa: tot.plateAppearances ?? 0, ab: tot.atBats ?? 0, h: tot.hits ?? 0, hr: tot.homeRuns ?? 0,
      avg: tot.avg ?? null, ops: tot.ops ?? null, k: tot.strikeOuts ?? 0, bb: tot.baseOnBalls ?? 0,
    };
  });
}

// Everything a follower wants to know about one player today.
function playerToday(id) {
  const c = lines.get(id);
  seasonLine(id, 'hitting');
  let best = null;
  if (today) {
    // A doubleheader means two games; prefer the one being played, then the latest one he played in.
    for (const G of today.games.values()) {
      const mine = G.log.filter((x) => x.batter.id === id);
      const ab = G.state === 'Live' ? G.ab : null;
      const inAb = ab && (ab.batter.id === id || ab.onDeck?.id === id || ab.inHole?.id === id || ab.pitcher.id === id);
      const onTeam = c?.teamId && (G.away.id === c.teamId || G.home.id === c.teamId);
      if (!mine.length && !inAb && !onTeam) continue;
      const rank = (inAb ? 300 : 0) + (G.state === 'Live' ? 200 : 0) + (mine.length ? 100 : 0) + (G.state === 'Preview' ? 50 : 0) + Date.parse(G.start || 0) / 1e13;
      if (!best || rank > best.rank) best = { rank, G, mine, ab, inAb };
    }
  }
  const g = best?.G;
  const game = g ? publicGame(g) : null;
  const pas = best ? best.mine.map((x) => ({ inning: x.inning, half: x.half, kind: x.kind, event: x.event, id: x.id })) : [];
  const ab = best?.inAb ? best.ab : null;
  const status = ab ? (ab.batter.id === id ? 'batting' : ab.onDeck?.id === id ? 'on deck' : ab.inHole?.id === id ? 'in the hole' : 'pitching') : null;
  return {
    id, name: c?.name || null, teamId: c?.teamId ?? null, abbr: teamAbbr(c?.teamId), pos: c?.pos || null,
    season: c?.hitting || null, pitching: c?.pitching || null,
    game, status, pas, line: g ? lineOf(g.log, id) : null,
  };
}

// A player's most recent home run clip, from any game this season.
function latestHrVideo(id, season) {
  return cached(`hrvid:${id}:${season}`, 5 * 60e3, async () => {
    const j = await getJSON(`${API}/api/v1/people/${id}?hydrate=stats(group=[hitting],type=[gameLog],season=${season})`);
    const person = j.people?.[0];
    if (!person) return null;
    const last = (person.lastName || '').toLowerCase();
    const splits = person.stats?.find((x) => x.type?.displayName === 'gameLog')?.splits || [];
    const games = splits.filter((x) => x.stat?.homeRuns > 0 && x.game?.gamePk).reverse().slice(0, 5);
    for (const g of games) {
      let c;
      try { c = await getJSON(`${API}/api/v1/game/${g.game.gamePk}/content?fields=${CONTENT_FIELDS},keywordsAll,type,value,date`); } catch { continue; }
      const items = (c.highlights?.highlights?.items || [])
        .filter((it) => /homer|home run|grand slam/i.test(it.headline || '')
          && (!last || (it.headline || '').toLowerCase().includes(last))
          && (it.keywordsAll || []).some((k) => k.type === 'player_id' && String(k.value) === String(id)))
        .sort((a, b) => !!b.guid - !!a.guid || altView(a.headline) - altView(b.headline) || Date.parse(b.date || 0) - Date.parse(a.date || 0));
      for (const it of items) {
        const v = videoOf(it);
        if (v) return { ...v, date: g.date, pk: g.game.gamePk, playId: it.guid || null, opp: teamAbbr(g.opponent?.id) };
      }
    }
    return null;
  });
}

// The address a phone should open: on Railway the service's own domain, at home this Mac on Wi-Fi.
const PUBLIC_URL = (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/$/, '');
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}

// ---------------------------------------------------------------- bets: grading from any day
// Open tickets on games outside the loaded days (yesterday's late game after a restart, a makeup game) are
// Runs through five innings, for first-five bets. `done` is false until the fifth is complete: a game
// called before that leaves those bets void, which is how the books settle them.
function fiveInnings(ls) {
  const innings = ls?.innings;
  if (!Array.isArray(innings) || !innings.length) return null;
  let h = 0, a = 0, done = false;
  for (const i of innings) {
    if ((i.num ?? 0) > 5) break;
    h += i.home?.runs ?? 0;
    a += i.away?.runs ?? 0;
    if (i.num === 5 && i.home?.runs != null && i.away?.runs != null) done = true;
  }
  return { h, a, done };
}

// graded from MLB's schedule by gamePk.
const strays = new Map(); // pk -> { state, detail, home: { score }, away: { score }, at }
function gameOf(pk) {
  const hit = findGame(Number(pk));
  if (hit) return hit.G;
  return strays.get(Number(pk)) || null;
}
async function pollStrays() {
  const want = Bets.openGamePks().filter((pk) => !findGame(pk));
  if (!want.length) return;
  try {
    const j = await getJSON(`${API}/api/v1/schedule?sportId=1&gamePks=${want.slice(0, 50).join(',')}&hydrate=linescore&_=${Date.now()}`);
    for (const d of j.dates || []) {
      for (const g of d.games || []) {
        const ls = g.linescore?.teams || {};
        // A postponed game can appear twice (the original date and the makeup); the played one wins.
        const prev = strays.get(g.gamePk);
        const next = {
          pk: g.gamePk, state: g.status.abstractGameState, detail: g.status.detailedState,
          home: { score: g.teams.home.score ?? ls.home?.runs ?? null }, away: { score: g.teams.away.score ?? ls.away?.runs ?? null }, at: Date.now(),
        };
        if (prev && prev.at === next.at && /postponed/i.test(next.detail)) continue;
        strays.set(g.gamePk, next);
      }
    }
  } catch (e) {
    log('strays', e.message);
  }
}
function gradeBets() {
  const owners = Bets.refresh(gameOf, (pk, start) => Odds.closeOf(pk, start));
  if (owners.size) emitBets(owners);
}
setInterval(gradeBets, 10000);
setInterval(() => pollStrays().then(gradeBets), 120e3);

// ---------------------------------------------------------------- per-visitor rate limit (public deployments)
const hits = new Map(); // ip -> { n, t }
function limited(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.t > 60e3) { h = { n: 0, t: now }; hits.set(ip, h); }
  if (hits.size > 5000) hits.clear();
  return ++h.n > 240; // 4 API calls a second, sustained, is far beyond what the app itself makes
}

// ---------------------------------------------------------------- access code
const OPEN_PATHS = /^\/(manifest\.webmanifest|sw\.js|icons\/[\w.-]+|favicon\.ico)$/;
function hasAccess(req) {
  if (!ACCESS_TOKEN) return true;
  const ck = (req.headers.cookie || '').split(/;\s*/);
  return ck.includes(`bbl_access=${ACCESS_TOKEN}`) || (!!GUEST_TOKEN && ck.includes(`bbl_guest=${GUEST_TOKEN}`)) || !!guestOf(req);
}
// Two ways in once a code is set: the code makes you the owner of the board, a share link makes a guest, who
// sees the same board and only their own tickets. With no code set the app is open and everyone is the owner.
const guestOf = (req) => Group.byToken(cookieOf(req).bbl_key || '');
function roleOf(req) {
  if (!ACCESS_TOKEN) return 'owner';
  const ck = (req.headers.cookie || '').split(/;\s*/);
  if (ck.includes(`bbl_access=${ACCESS_TOKEN}`)) return 'owner';
  if (GUEST_TOKEN && ck.includes(`bbl_guest=${GUEST_TOKEN}`)) return 'guest';
  return guestOf(req) ? 'guest' : null;
}
// setHeader replaces; a join sets two cookies at once, so they're appended.
function addCookie(res, str) {
  const had = res.getHeader('set-cookie');
  res.setHeader('set-cookie', had ? [].concat(had, str) : [str]);
}
// BASE_PATH: mounted at /mlb behind the terminal. The router strips the prefix, so ROUTING is
// unchanged; only OUTPUT urls carry it. Empty = standalone, exactly as before.
const BASE = process.env.BASE_PATH || '';
const SPORTS_NAV = [['/nfl','NFL'],['/ncaaf','NCAAF'],['/mlb','MLB']];
const SPORTBAR = !BASE ? '' : ('<div id="xsport"><span class="brand"><svg class="xm" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="var(--ink)"/><path d="M21 21 L33 32 L21 43" fill="none" stroke="var(--accent)" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/><rect x="34" y="38.5" width="15" height="5" rx="2.5" fill="var(--surface)"/></svg><span class="wm">THE<b>.</b>BOARD</span></span><nav class="xseg" aria-label="Sport">'
  + SPORTS_NAV.map(function(x){return '<a href="'+x[0]+'/"'+(x[0]===BASE?' class="on" aria-current="page"':'')+'>'+x[1]+'</a>';}).join('')
  + '</nav></div><style>'
  + '#xsport{display:flex;align-items:center;gap:18px;height:62px;padding:0 20px;background:var(--surface);border-bottom:1px solid var(--line);font-family:var(--font)}'
  + '#xsport .brand{display:inline-flex;align-items:center;gap:11px;flex:none}'
  + '#xsport .xm{width:28px;height:28px;border-radius:8px;display:block;flex:none}'
  + '#xsport .wm{font-family:var(--mono);font-size:14px;font-weight:700;letter-spacing:.02em;color:var(--ink);white-space:nowrap}'
  + '#xsport .wm b{color:var(--accent);font-weight:700}'
  + '#xsport .xseg{display:flex;gap:4px;padding:4px;background:var(--fill);border-radius:13px}'
  + '#xsport .xseg a{display:flex;align-items:center;padding:10px 24px;border-radius:9px;font-size:15px;font-weight:600;color:var(--ink-2);text-decoration:none;letter-spacing:-.01em}'
  + '#xsport .xseg a.on{background:var(--surface);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.16),0 0 0 1px var(--line)}'
  + '#xsport .xseg a:not(.on):hover{color:var(--ink)}'
  + '@media (max-width:560px){#xsport{gap:10px;padding:0 14px;height:56px}#xsport .wm{display:none}#xsport .xseg a{padding:9px 16px;font-size:14px}}'
  + '</style>');
const cookieOpts = (req) => `Path=${BASE || '/'}; Max-Age=63072000; HttpOnly; SameSite=Lax${(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : ''}`;
function codeMatches(code) {
  const a = Buffer.from(String(code || '').trim().toLowerCase());
  const b = Buffer.from(ACCESS_CODE.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function grantAccess(req, res, to = `${BASE}/`) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.writeHead(303, { 'set-cookie': `bbl_access=${ACCESS_TOKEN}; Max-Age=31536000; Path=${BASE || '/'}; HttpOnly; SameSite=Lax${secure}`, location: to, 'cache-control': 'no-store' });
  res.end();
}
function accessPage(res, wrong) {
  res.writeHead(wrong ? 401 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Bing Bong Live</title><link rel="manifest" href="${BASE}/manifest.webmanifest"><link rel="apple-touch-icon" href="${BASE}/icons/apple-touch-icon.png">
<meta name="theme-color" content="#000000"><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600;700&display=swap" rel="stylesheet">
<style>:root{--bg:#F4F4F6;--s:#fff;--ink:#0B0B0D;--i2:#62626B;--a:#EE3A2E}@media (prefers-color-scheme:dark){:root{--bg:#000;--s:#161618;--ink:#F5F5F7;--i2:#9C9CA4;--a:#FF453A}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.4 Geist,system-ui,sans-serif;padding:24px}
form{width:100%;max-width:360px;background:var(--s);border-radius:28px;padding:32px 24px}.m{width:40px;height:40px;border-radius:12px;background:var(--ink);display:grid;place-items:center;margin-bottom:24px}.m i{width:15px;height:15px;border-radius:50%;background:var(--s)}
h1{font-size:28px;letter-spacing:-.03em;margin:0 0 6px}p{margin:0 0 24px;color:var(--i2);font-size:15px}input{width:100%;height:52px;border-radius:14px;border:1px solid rgba(128,128,128,.3);background:var(--bg);color:var(--ink);font:inherit;font-size:17px;padding:0 16px}
button{width:100%;height:52px;border:0;border-radius:999px;background:var(--ink);color:var(--s);font:inherit;font-weight:600;margin-top:12px;cursor:pointer}.e{color:var(--a);font-size:14px;margin:10px 0 0}</style></head>
<body><form method="post" action="${BASE}/access"><div class="m"><i></i></div><h1>Bing Bong Live</h1><p>Enter the access code you were given.</p>
<input name="code" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" aria-label="Access code" autofocus required>
${wrong ? '<p class="e">That code didn\'t work. Check it and try again.</p>' : ''}<button>Open</button></form></body></html>`);
}

// ---------------------------------------------------------------- whose bets
// Every device gets a random id in an HttpOnly cookie, set silently on its first request past the access code, so
// nobody signs up and nobody is signed out. Bets belong to that id. A second device joins the same log with a
// short-lived link code. OWNER_CODE lets the app's owner claim bets saved before logs were private.
const OWNER_CODE = (process.env.OWNER_CODE || '').trim();
// Whose board this is, for the wording a guest reads ("Chris's board"). Only a display name.
const OWNER_NAME = (process.env.OWNER_NAME || '').trim().slice(0, 24);
const UID_RE = /^[a-f0-9]{32}$/;
const cookieOf = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim()).filter(Boolean).map((c) => { const i = c.indexOf('='); return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)]; }));
const uidOf = (req) => { const v = cookieOf(req).bbl_uid || ''; return UID_RE.test(v) ? v : ''; };
function setUid(req, res, uid) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  res.setHeader('set-cookie', `bbl_uid=${uid}; Path=${BASE || '/'}; Max-Age=63072000; HttpOnly; SameSite=Lax${secure}`);
}
function ensureUid(req, res) {
  let uid = uidOf(req);
  if (!uid) { uid = crypto.randomBytes(16).toString('hex'); setUid(req, res, uid); }
  return uid;
}
// Link codes: 8 characters without look-alikes (no 0/O, 1/I/L), good for 10 minutes and one use.
const LINK_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const links = new Map(); // code -> { uid, exp }
function newLink(uid) {
  const now = Date.now();
  for (const [k, v] of links) if (v.exp < now || v.uid === uid) links.delete(k);
  let code = '';
  do {
    code = '';
    for (const b of crypto.randomBytes(8)) code += LINK_ABC[b % LINK_ABC.length];
  } while (links.has(code));
  const exp = now + 10 * 60e3;
  links.set(code, { uid, exp });
  return { code, exp };
}
// Join and claim share a failure limit: 5 wrong codes per address in 15 minutes, and 100 from anywhere
// (a backstop against address rotation). Only the LAST X-Forwarded-For entry is real (the proxy appends it).
const TRY_WINDOW = 15 * 60e3;
const tryFails = new Map(); // ip -> [timestamps]
let allTryFails = [];
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '?';
function lockedOut(ip) {
  const now = Date.now();
  allTryFails = allTryFails.filter((t) => now - t < TRY_WINDOW);
  const recent = (tryFails.get(ip) || []).filter((t) => now - t < TRY_WINDOW);
  if (recent.length) tryFails.set(ip, recent); else tryFails.delete(ip);
  if (tryFails.size > 5000) for (const [k, v] of tryFails) if (!v.length || now - v.at(-1) >= TRY_WINDOW) tryFails.delete(k);
  return recent.length >= 5 || allTryFails.length >= 100;
}
function noteFail(ip) {
  const now = Date.now();
  tryFails.set(ip, [...(tryFails.get(ip) || []), now]);
  allTryFails.push(now);
}
const sameText = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

async function readBody(req, max = 20000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) throw Object.assign(new Error('Too large'), { status: 413 });
  }
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}

// The odds and bets API. Returns true when it handled the request.
async function oddsRoutes(req, res, url, uid) {
  const p = url.pathname, M = req.method;
  /* BetMGM Nevada: one tap from a price on the board into BetMGM with the bet already in the slip.
     Resolved server-side (The Odds API hands over BetMGM's own fixture/market/option ids), so the link
     can improve without touching the board. Nevada's BetMGM only, by design. */
  if (p === '/api/betmgm/go' && M === 'GET') {
    const pk = String(url.searchParams.get('g') || '');
    const to = await BetMGM.linkFor(gameOf(pk), String(url.searchParams.get('m') || 'ml'),
      String(url.searchParams.get('s') || 'home'), Number(url.searchParams.get('stake')) || 0, pk);
    res.writeHead(302, { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
    return true;
  }
  if (p === '/api/odds' && M === 'GET') {
    const date = url.searchParams.get('date') || today?.date || baseballToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) { sendJSON(res, 400, { error: 'Use ?date=YYYY-MM-DD' }); return true; }
    sendJSON(res, 200, Odds.forDate(date));
    return true;
  }
  const om = /^\/api\/odds\/(\d+)$/.exec(p);
  if (om && M === 'GET') {
    const o = Odds.game(Number(om[1]));
    if (!o) sendJSON(res, 404, { error: 'No odds for that game.' }); else sendJSON(res, 200, o);
    return true;
  }
  if (p === '/api/keys' && M === 'GET') {
    const k = await Odds.keys(new Date().getFullYear() - 1);
    sendJSON(res, 200, k || { n: 0 });
    return true;
  }
  // Numbers typed in at a window. Private to the device that entered them.
  if (p === '/api/manual' && M === 'GET') { sendJSON(res, 200, Manual.list(uid)); return true; }
  if (p === '/api/manual' && M === 'POST') {
    const body = await readBody(req);
    try {
      const L = Manual.set(uid, String(body.pk || ''), String(body.book || ''), body);
      sendJSON(res, 200, { pk: Number(body.pk), book: body.book, line: L });
    } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return true;
  }
  if (p === '/api/manual' && M === 'DELETE') {
    const ok = Manual.clear(uid, String(url.searchParams.get('pk') || ''), String(url.searchParams.get('book') || ''));
    sendJSON(res, ok ? 200 : 404, { ok });
    return true;
  }
  // ---- the group: share links, who's here, and what they've got running (the owner's side)
  const role = roleOf(req);
  const ownerOnly = () => { sendJSON(res, 403, { error: 'Only the person who runs this board can do that.' }); return true; };
  if (p === '/api/invites') {
    if (role !== 'owner') return ownerOnly();
    if (M === 'GET') { sendJSON(res, 200, { base: PUBLIC_URL || lanUrls()[0] || '', links: Group.invites() }); return true; }
    if (M === 'POST') {
      const inv = Group.makeInvite((await readBody(req)).label);
      log(`share link made for ${inv.label}`);
      sendJSON(res, 200, inv);
      return true;
    }
  }
  const im = /^\/api\/invites\/([a-f0-9]{12})$/.exec(p);
  if (im && M === 'DELETE') {
    if (role !== 'owner') return ownerOnly();
    const gone = Group.revoke(im[1]);
    if (gone) log('share link turned off');
    sendJSON(res, gone ? 200 : 404, { ok: gone });
    return true;
  }
  if (p === '/api/group' && M === 'GET') {
    if (role !== 'owner') return ownerOnly();
    const labels = Object.fromEntries(Group.invites().map((i) => [i.id, i.label]));
    const by = Bets.byOwner();
    sendJSON(res, 200, {
      people: Group.people(uid).map((P) => {
        const bets = by.get(P.uid) || [];
        const done = bets.filter((b) => b.status === 'won' || b.status === 'lost' || b.status === 'push');
        return {
          ...P,
          via: labels[P.via] || null,
          n: bets.length,
          won: done.filter((b) => b.status === 'won').length,
          lost: done.filter((b) => b.status === 'lost').length,
          net: done.reduce((t, b) => t + (b.net || 0), 0),
          risk: done.reduce((t, b) => t + (b.stake || 0), 0),
          open: bets.filter((b) => b.status === 'open'),
        };
      }),
    });
    return true;
  }
  const pm = /^\/api\/group\/([a-f0-9]{32})$/.exec(p);
  if (pm && M === 'GET') {
    if (role !== 'owner') return ownerOnly();
    const P = Group.person(pm[1]);
    if (!P) { sendJSON(res, 404, { error: 'Nobody by that id.' }); return true; }
    sendJSON(res, 200, { name: P.name || '', bets: Bets.list(pm[1]) });
    return true;
  }
  if (p === '/api/me/name' && M === 'POST') {
    try { sendJSON(res, 200, { name: Group.setName(uid, (await readBody(req)).name) }); } catch (e) { sendJSON(res, 400, { error: e.message }); }
    return true;
  }
  if (p === '/api/me' && M === 'GET') {
    sendJSON(res, 200, { role, name: Group.person(uid)?.name || '', bets: Bets.count(uid), claimable: OWNER_CODE ? Bets.unowned() : 0 });
    return true;
  }
  if (p === '/api/me/link' && M === 'POST') { sendJSON(res, 200, newLink(uid)); return true; }
  if ((p === '/api/me/join' || p === '/api/me/claim') && M === 'POST') {
    const ip = clientIp(req);
    if (lockedOut(ip)) { sendJSON(res, 429, { error: 'Too many tries. Wait 15 minutes.' }); return true; }
    const raw = String((await readBody(req)).code || '').trim();
    const fail = (msg) => { noteFail(ip); sendJSON(res, 400, { error: msg }); return true; };
    if (p === '/api/me/join') {
      const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const L = links.get(code);
      if (!L || L.exp < Date.now()) return fail('That code didn’t work. Codes last 10 minutes; make a new one on your other device.');
      links.delete(code);
      const moved = L.uid === uid ? 0 : Bets.merge(uid, L.uid); // bring this device's bets along
      Group.merge(uid, L.uid); // and one row on the board, not two
      setUid(req, res, L.uid);
      for (const c of clients) if (c.uid === uid) c.uid = L.uid;
      emitBets(new Set([L.uid]));
      sendJSON(res, 200, { ok: true, moved, bets: Bets.count(L.uid) });
      return true;
    }
    if (!OWNER_CODE || !raw || !sameText(raw.toLowerCase(), OWNER_CODE.toLowerCase())) return fail('That isn’t the owner code.');
    const claimed = Bets.claimUnowned(uid);
    emitBets(new Set([uid]));
    sendJSON(res, 200, { ok: true, claimed });
    return true;
  }
  if (p === '/api/bets' && M === 'GET') { sendJSON(res, 200, Bets.list(uid)); return true; }
  if (p === '/api/bets' && M === 'POST') {
    let b;
    try { b = Bets.create(await readBody(req), uid); } catch (e) { sendJSON(res, e.status || 400, { error: e.message }); return true; }
    gradeBets();
    emitBets(new Set([uid]));
    sendJSON(res, 200, Bets.pub(b));
    return true;
  }
  if (p === '/api/bets.csv' && M === 'GET') {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="bing-bong-bets.csv"', 'cache-control': 'no-store' });
    res.end(Bets.csv(uid));
    return true;
  }
  const bm = /^\/api\/bets\/([\w-]{1,40})$/.exec(p);
  if (bm && M === 'PATCH') {
    const b = Bets.update(bm[1], await readBody(req), uid);
    if (!b) { sendJSON(res, 404, { error: 'No such bet' }); return true; }
    gradeBets();
    emitBets(new Set([uid]));
    sendJSON(res, 200, Bets.pub(b));
    return true;
  }
  if (bm && M === 'DELETE') {
    const ok = Bets.remove(bm[1], uid);
    if (ok) emitBets(new Set([uid]));
    sendJSON(res, ok ? 200 : 404, ok ? { ok } : { ok, error: 'No such bet' });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- HTTP
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

function sendJSON(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return sendJSON(res, 400, { error: 'Bad request' }); }
  const p = url.pathname;
  try {
    // A share link: /j/<token>. Opening it lets this phone in and remembers it, so a friend never types a code.
    const jm = /^\/j\/([a-f0-9]{24})$/.exec(p);
    if (jm && (req.method === 'GET' || req.method === 'HEAD')) {
      const inv = Group.byToken(jm[1]);
      if (!inv) return accessPage(res, false);
      if (roleOf(req) === 'owner' && ACCESS_TOKEN) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bing Bong Live</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#F5F5F7;font:16px/1.5 ui-sans-serif,system-ui;text-align:center;padding:24px}div{max-width:380px}h1{font-size:24px;margin:0 0 10px;letter-spacing:-.02em}p{color:#9C9CA4;margin:0 0 20px}a{color:#F5F5F7}</style>
<div><h1>That's your own link</h1><p>You're signed in as the owner on this device, so this link changes nothing here. To see what a friend sees, open it in a private window.</p><a href="${BASE}/">Back to the board</a></div>`);
      }
      const juid = ensureUid(req, res);
      addCookie(res, `bbl_key=${inv.token}; ${cookieOpts(req)}`);
      Group.useInvite(inv.token, juid);
      log(`join: ${inv.label}`);
      res.writeHead(303, { location: `${BASE}/` });
      return res.end();
    }
    if (ACCESS_TOKEN && !hasAccess(req) && !OPEN_PATHS.test(p) && p !== '/api/health') {
      if (p === '/access' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 2000) break; }
        return codeMatches(new URLSearchParams(body).get('code')) ? grantAccess(req, res) : accessPage(res, true);
      }
      if (url.searchParams.has('code') && codeMatches(url.searchParams.get('code'))) {
        url.searchParams.delete('code');
        return grantAccess(req, res, `${url.pathname}${url.search}`);
      }
      if (p.startsWith('/api/')) return sendJSON(res, 401, { error: 'Access code required' });
      return accessPage(res, false);
    }
    if (p.startsWith('/api/') && p !== '/api/stream' && p !== '/api/health' && limited(req)) {
      return sendJSON(res, 429, { error: 'Too many requests. Try again in a minute.' });
    }
    const uid = ensureUid(req, res);
    Group.note(uid, guestOf(req)?.id || null, roleOf(req) === 'guest');
    if (p.startsWith('/api/') && await oddsRoutes(req, res, url, uid)) return;
    if (p === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.uid = uid;
      res.role = roleOf(req);
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot(today, uid, res.role))}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (p === '/api/day') {
      const date = url.searchParams.get('date');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || Number.isNaN(Date.parse(date))) return sendJSON(res, 400, { error: 'Use ?date=YYYY-MM-DD' });
      const yr = Number(date.slice(0, 4)), now = Number(baseballToday().slice(0, 4));
      if (yr < 2015 || yr > now + 1) return sendJSON(res, 400, { error: 'Pick a date from 2015 on.' });
      if (date === today.date) return sendJSON(res, 200, snapshot(today, uid, roleOf(req)));
      const day = getDay(date);
      await loadDay(day);
      return sendJSON(res, 200, snapshot(day, uid, roleOf(req)));
    }
    if (p === '/api/leaders') {
      const season = url.searchParams.get('season') || (today?.date || baseballToday()).slice(0, 4);
      return sendJSON(res, 200, await leaders(season));
    }
    const gm = /^\/api\/game\/(\d+)$/.exec(p);
    if (gm) {
      const hit = findGame(Number(gm[1]));
      if (!hit) return sendJSON(res, 404, { error: 'That game is not loaded. Open its day first.' });
      const { G } = hit;
      return sendJSON(res, 200, { now: Date.now(), game: publicGame(G), ab: G.ab, log: G.log, wp: G.wp });
    }
    if (p === '/api/matchup') {
      const b = url.searchParams.get('b'), pi = url.searchParams.get('p');
      if (!/^\d+$/.test(b || '') || !/^\d+$/.test(pi || '')) return sendJSON(res, 400, { error: 'Use ?b=<batterId>&p=<pitcherId>' });
      return sendJSON(res, 200, await matchup(b, pi));
    }
    if (p === '/api/players/today') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter((x) => /^\d{1,9}$/.test(x)).slice(0, 60).map(Number);
      await ensureLines(ids);
      return sendJSON(res, 200, { now: Date.now(), players: ids.map(playerToday) });
    }
    if (p === '/api/lan') return sendJSON(res, 200, { urls: PUBLIC_URL ? [PUBLIC_URL] : lanUrls(), public: !!PUBLIC_URL, port: PORT });
    if (p === '/api/teams') {
      if (!teams.size) await loadTeams((today?.date || baseballToday()).slice(0, 4));
      if (!teams.size) return sendJSON(res, 503, { error: 'Team list unavailable. Try again shortly.' });
      return sendJSON(res, 200, [...teams].map(([id, t]) => ({ id, abbr: t.abbr, name: t.name })).sort((x, y) => x.abbr.localeCompare(y.abbr)));
    }
    const vm = /^\/api\/player\/(\d+)\/hr-video$/.exec(p);
    if (vm) {
      const season = url.searchParams.get('season') || (today?.date || baseballToday()).slice(0, 4);
      return sendJSON(res, 200, { video: await latestHrVideo(vm[1], season) });
    }
    const pm = /^\/api\/player\/(\d+)$/.exec(p);
    if (pm) {
      const season = url.searchParams.get('season') || (today?.date || baseballToday()).slice(0, 4);
      return sendJSON(res, 200, await player(pm[1], season));
    }
    if (p === '/api/health') {
      return sendJSON(res, 200, {
        ok: true, date: today?.date, clients: clients.size, feedMs: FEED_MS,
        games: [...(today?.games.values() || [])].map((g) => ({ pk: g.pk, state: g.state, feedAge: g.feedAt ? Date.now() - g.feedAt : null })),
        ...(hasAccess(req) ? { odds: Odds.healthInfo() } : {}),
      });
    }
    // The board page, with the terminal's <base href> and sport switcher folded in when mounted.
    if (BASE && (p === '/' || p === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
          .replace('<head>', `<head><base href="${BASE}/">`)
          .replace('<body>', '<body>' + SPORTBAR);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? '' : html);
      } catch { /* fall through to the plain file */ }
    }
    // static
    const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : decodeURIComponent(p)));
    if (!file.startsWith(PUBLIC)) return sendJSON(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return sendJSON(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(buf);
    });
  } catch (e) {
    log('http', p, e.message);
    if (res.headersSent) return res.end();
    sendJSON(res, e.status || 502, { error: e.message });
  }
});

// One bad request or upstream hiccup must never take the live loops down.
process.on('unhandledRejection', (e) => log('unhandled', e?.message || e));
process.on('uncaughtException', (e) => log('uncaught', e?.message || e));
// Save the line history before exiting (bets are written as they change).
function shutdown() { Odds.saveNow(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  const date = baseballToday();
  await loadTeams(date.slice(0, 4));
  await scheduleLoop();
  feedLoop();
  savantLoop();
  contentLoop();
  Odds.start({ today: () => today, emit });
  pollStrays().then(gradeBets);
  server.listen(PORT, () => {
    log(`Bing Bong Live is up → http://localhost:${PORT}   (live at-bats every ${FEED_MS / 1000}s)${ACCESS_TOKEN ? '   [access code on]' : ''}`);
    for (const u of lanUrls()) log(`  on your phone (same Wi-Fi) → ${u}`);
  });
})();
