'use strict';
const {attachLink}=require('../../shared/bet-links');
/* The MLB odds engine: polls Action Network, Pinnacle, ESPN (DraftKings) and VSiN on their own polite cadences,
   maps every game onto today's MLB gamePks, keeps the line history (lib/lines.js), freezes the close at first pitch
   and tells the server what to push. The server passes in the day model and an emitter; nothing here touches HTTP.
   It also prices the next baseball day's slate ahead of time (pregame only, slower): books post tomorrow's lines as
   soon as tonight's games end, and without it the board had nothing to show from the last first pitch until the
   6 AM ET rollover (in the postseason, that was most of the day). */

const fs = require('node:fs');
const path = require('node:path');
const { log, health, DATA } = require('./util');
const { BOOKS } = require('./books');
const { OddsDay } = require('./lines');
const AN = require('./action');
const PIN = require('./pinnacle');
const ESPN = require('./espn');
const VSIN = require('./vsin');
const OWLS = require('./owls');
const SHARP = require('./sharp');
const WX = require('./weather');
const { keys } = require('./keys');
const { SIDES, marketDisplayRank } = require('./quote-evidence');

const EVERY = { an: 20e3, anIdle: 5 * 60e3, an1: 2 * 60e3, pin: 2 * 60e3, espn: 60e3, vsin: 2 * 60e3, wx: 30 * 60e3 };
const PUSH_MIN = 3000;      // at most one odds push per game per 3 s
const configuredLiveAge = Number(process.env.MLB_LIVE_MAX_AGE_MS);
const LIVE_MAX_AGE_MS = Number.isFinite(configuredLiveAge) && configuredLiveAge > 0 ? Math.max(20000, configuredLiveAge) : 50000;
const SEEN_PUSH = 2 * 60e3; // re-push a game whose prices held but whose `seen` moved on, this often

let ctx = null;             // { today: () => Day|null, emit(type, data) }
let cur = null;             // OddsDay for today
const past = new Map();     // date -> OddsDay (read from disk)
const status = { an: {}, an1: {}, pin: {}, espn: {}, vsin: {}, wx: {} };
let owlsFeed = null, owlsCache = null, owlsAppliedKey = null, owlsFlushTimer = null, owlsStatusAt = 0;
let sharpFeed = null, sharpCache = null, sharpAppliedKey = null, sharpStatusAt = 0;
const pending = new Map();  // pk -> { price: bool }
const sentAt = new Map();   // pk -> ms
let anOnce = false;
const jobs = new Map();
const SOURCE_NAMES = ['an', 'an1', 'pin', 'espn', 'vsin'];
const REFRESH_COOLDOWN_MS = 15000;
const refresh = { in_progress: false, requested_at: null, completed_at: null, next_allowed_at: 0, cooldown_ms: REFRESH_COOLDOWN_MS, result: null };

// The next baseball day (ctx.next): its own OddsDay, jobs, source status and manual refresh. Pregame only, so its
// sources run slower than today's; Pinnacle and VSiN list every upcoming game in one response, which both days share.
const NEXT_EVERY = { an: 60e3, an1: 5 * 60e3, pin: 2 * 60e3, espn: 2 * 60e3, vsin: 5 * 60e3 };
const SHARED_MAX_AGE_MS = 90e3;
let nxt = null;             // OddsDay for the next baseball day
const nextJobs = new Map();
const nextStatus = { an: {}, an1: {}, pin: {}, espn: {}, vsin: {} };
const nextRefresh = { in_progress: false, requested_at: null, completed_at: null, next_allowed_at: 0, cooldown_ms: REFRESH_COOLDOWN_MS, result: null };
const shared = new Map();   // source -> { at, promise } for the one-response-for-every-game feeds

// Explicit in-play observations are ephemeral and never written into pregame history or close.
const liveQuotes = new Map(); // pk -> { books, receivedAt }
const knownLivePks = new Set(); // retain an empty public projection when a live-only quote disappears


// ---------------------------------------------------------------- day model
function gamesOf(d) {
  if (!d) return [];
  return [...d.games.values()].map((G) => ({ pk: G.pk, start: G.start, state: G.state, detail: G.detail, home: G.home, away: G.away, venue: G.venue }));
}
function dayGames() { return gamesOf(ctx?.today()); }
// The next baseball day's games, once the server has its schedule. Never the same date as today.
function nextGames() {
  const n = ctx?.next?.(), d = ctx?.today();
  return n && d && n.date > d.date ? gamesOf(n) : [];
}
function current() {
  const d = ctx?.today();
  if (!d) return null;
  if (!cur || cur.date !== d.date) {
    if (cur) {
      cur.save(); remember(cur);
      Object.assign(refresh, { in_progress: false, requested_at: null, completed_at: null, next_allowed_at: 0, result: null });
    }
    // Last night's look-ahead becomes today's history: the same prices, moves and opener carry straight on.
    if (nxt && nxt.date === d.date) { cur = nxt; nxt = null; }
    else cur = past.get(d.date) || new OddsDay(d.date);
    past.delete(d.date);
    anOnce = false;
    for (const job of jobs.values()) if (!job.promise) job.nextAt = 0;
    pending.clear();
    sentAt.clear();
    liveQuotes.clear();
    knownLivePks.clear();
    log('odds: day', d.date, `${Object.keys(cur.games).length} games from history`);
  }
  return cur;
}
// The OddsDay for the next baseball day, or null while there is none (no day model, or the server has no next day).
function nextCurrent() {
  const n = ctx?.next?.(), d = ctx?.today();
  if (!n || !d || !(n.date > d.date)) return null;
  if (!nxt || nxt.date !== n.date) {
    if (nxt) { nxt.save(); remember(nxt); }
    nxt = past.get(n.date) || new OddsDay(n.date);
    past.delete(n.date);
    for (const job of nextJobs.values()) if (!job.promise) job.nextAt = 0;
    for (const name of Object.keys(nextStatus)) nextStatus[name] = {};
    Object.assign(nextRefresh, { in_progress: false, requested_at: null, completed_at: null, next_allowed_at: 0, result: null });
    log('odds: next day', n.date, `${Object.keys(nxt.games).length} games from history`);
  }
  return nxt;
}
function remember(D) {
  past.set(D.date, D);
  while (past.size > 7) past.delete(past.keys().next().value);
}
function dayFor(date) {
  const D = current();
  if (D && D.date === date) return D;
  const N = nextCurrent();
  if (N && N.date === date) return N;
  if (past.has(date)) return past.get(date);
  if (!fs.existsSync(path.join(DATA, 'odds', `${date}.json`))) return null;
  const P = new OddsDay(date);
  remember(P);
  return P;
}

// Which tracked day holds a game's prices: today's, or the next day's slate. A postponed game keeps its gamePk on
// its new date, so when both days list it, the day it is still actually scheduled on wins.
function oddsDayFor(pk) {
  const D = current(), N = nextCurrent();
  if (!N || !N.has(pk)) return D;
  if (!D || (!D.has(pk) && !knownLivePks.has(Number(pk)))) return N;
  const g = ctx?.today()?.games.get(Number(pk));
  return g && !/postpon|cancel/i.test(g.detail || '') ? D : N;
}

// Newly fetched prices after play starts cannot alter the pregame bookspace or close.
function openFor(D, g, src) { return g.state === 'Preview' && !/postpon|cancel|suspend/i.test(g.detail || ''); }

// A tracked day for the pollers: today (live quotes, the close, manual refresh) or the next day (pregame prices only).
const TODAY = { key: 'today', live: true, odds: () => current(), games: () => dayGames(), date: () => ctx?.today()?.date, status, jobs, refresh, every: (name) => sourceInterval(name) };
const NEXT = { key: 'next', live: false, odds: () => nextCurrent(), games: () => nextGames(), date: () => ctx?.next?.()?.date, status: nextStatus, jobs: nextJobs, refresh: nextRefresh, every: (name) => NEXT_EVERY[name] };

// Pinnacle and VSiN answer for every listed game at once. Both days read one response (and its own receipt time)
// instead of asking twice; a failed request is never reused.
function fetchShared(name, fn) {
  const hit = shared.get(name);
  if (hit && Date.now() - hit.at < SHARED_MAX_AGE_MS) return hit.promise;
  const at = Date.now();
  const promise = Promise.resolve().then(fn).then((value) => ({ value, at: Date.now() }));
  shared.set(name, { at, promise });
  promise.catch(() => { if (shared.get(name)?.promise === promise) shared.delete(name); });
  return promise;
}

function apply(D, pk, src, lines, seen) {
  const r = D.ingest(pk, src, lines, seen);
  if (r.changed || r.seenOnly) {
    const p = pending.get(pk) || { price: false };
    if (r.changed) p.price = true;
    pending.set(pk, p);
  }
  for (const m of r.moves) {
    log('odds move', m.kind, pk, m.mkt, m.from, '→', m.to, m.dir, m.books ? `(${m.books.join(', ')})` : '');
    ctx.emit('move', m);
  }
}

function liveQuoteView(q, market, receivedAt, now, source = 'an') {
  const sourceAt = Date.parse(q.source_observed_at), age = Number.isFinite(sourceAt) ? now - sourceAt : null;
  let freshness = 'FRESH', reason_code = null;
  if (q.conflicted || (Number.isFinite(sourceAt) && sourceAt > receivedAt)) { freshness = 'CONFLICTED'; reason_code = 'CONFLICTED_QUOTE'; }
  else if (['suspended', 'removed'].includes(q.market_status)) { freshness = 'SUSPENDED'; reason_code = q.market_status === 'removed' ? 'MARKET_REMOVED' : 'MARKET_SUSPENDED'; }
  else if (q.market_status !== 'active' || q.is_live !== true) { freshness = 'UNVERIFIED'; reason_code = 'UNVERIFIED_MARKET_STATE'; }
  else if (age == null) { freshness = 'UNVERIFIED'; reason_code = 'MISSING_SOURCE_TIMESTAMP'; }
  else if (!Number.isFinite(q.american_odds) || Math.abs(q.american_odds) < 100 || (market !== 'ml' && !Number.isFinite(q.line_value))) { freshness = 'UNVERIFIED'; reason_code = 'INVALID_PRICE'; }
  else if (age > LIVE_MAX_AGE_MS) { freshness = 'STALE'; reason_code = 'SOURCE_QUOTE_STALE'; }
  return { ...q, src: source, source, received_at: new Date(receivedAt).toISOString(),
    freshness, reason_code, age_ms: age, max_age_ms: LIVE_MAX_AGE_MS, actionable: freshness === 'FRESH' };
}
function liveBookView(L, receivedAt, now, source = 'an') {
  const quote_meta = Object.fromEntries(Object.entries(L.quote_meta || {}).map(([market, sides]) => [market,
    Object.fromEntries(Object.entries(sides).map(([side, q]) => [side, liveQuoteView(q, market, receivedAt, now, source)]))]));
  const rows = Object.values(quote_meta).flatMap(Object.values);
  const rank = { FRESH: 0, STALE: 1, UNVERIFIED: 2, SUSPENDED: 3, CONFLICTED: 4 };
  const worst = rows.reduce((a, b) => !a || rank[b.freshness] > rank[a.freshness] ? b : a, null);
  const clocks = rows.map((q) => Date.parse(q.source_observed_at));
  return { ...L, quote_meta, src: source, source, is_live: true, seen: receivedAt,
    received_at: new Date(receivedAt).toISOString(), source_observed_at: clocks.length && clocks.every(Number.isFinite) ? new Date(Math.min(...clocks)).toISOString() : null,
    market_status: worst?.market_status || 'unverified', freshness: worst?.freshness || 'UNVERIFIED',
    reason_code: worst?.reason_code || null, actionable: !!rows.length && rows.every((q) => q.actionable), max_age_ms: LIVE_MAX_AGE_MS };
}
function refreshLive(parsed, games, receivedAt, source = 'an') {
  const playing = new Set(games.filter((g) => g.state === 'Live').map((g) => Number(g.pk)));
  const next = new Map();
  for (const [pk, patch] of parsed) if (playing.has(Number(pk)) && Object.keys(patch.live || {}).length) next.set(Number(pk), { books: patch.live, receivedAt });
  for (const pk of new Set([...liveQuotes.keys(), ...next.keys()])) {
    const previous = liveQuotes.get(pk);
    const sources = { ...(previous?.sources || (previous ? { an: previous } : {})) };
    if (next.has(pk)) sources[source] = next.get(pk); else delete sources[source];
    if (!playing.has(pk)) for (const key of Object.keys(sources)) delete sources[key];
    const signature = books => JSON.stringify(books, (key,value) => key === 'provider_received_at' ? undefined : value);
    const priorSource = previous?.sources?.[source] || (source === 'an' && previous && !previous.sources ? previous : null);
    const changed = source !== 'sharp' || signature(priorSource?.books) !== signature(next.get(pk)?.books);
    if (changed) pending.set(pk, { ...(pending.get(pk) || {price:false}), live:true, fast:['owls','sharp'].includes(source) || !!pending.get(pk)?.fast });
    if (Object.keys(sources).length) {
      const view = selectLiveBooks(sources, Date.now());
      liveQuotes.set(pk, { sources, books: view, receivedAt: Math.max(...Object.values(sources).map(x=>x.receivedAt)) });
      knownLivePks.add(pk);
    } else liveQuotes.delete(pk);
  }
}
function selectLiveBooks(sources, now) {
  const byBook = {}, out = {};
  for (const [source, row] of Object.entries(sources)) for (const [book,L] of Object.entries(row.books))
    (byBook[book] ||= []).push(liveBookView(L,row.receivedAt,now,source));
  for (const candidates of Object.values(byBook)) candidates.sort((a,b)=>(a.source==='sharp'?-1:0)-(b.source==='sharp'?-1:0));
  for (const [book,candidates] of Object.entries(byBook)) {
    const L={ml:null,rl:null,t:null,quote_meta:{},market_sources:{},is_live:true};
    for(const [market,sides] of Object.entries(SIDES)) {
      const available=candidates.filter(x=>x.quote_meta[market]);
      if(!available.length)continue;
      const eligible=available.filter(x=>sides.every(side=>x.quote_meta[market][side]?.actionable));
      const score=x=>Math.min(...Object.values(x.quote_meta[market]).map(q=>Date.parse(q.source_observed_at)));
      const picked=eligible.sort((a,b)=>score(b)-score(a))[0] || available.sort((a,b)=>marketDisplayRank(a,market,true)-marketDisplayRank(b,market,true))[0];
      L[market]=picked[market];L.quote_meta[market]=Object.fromEntries(Object.entries(picked.quote_meta[market]).map(([side,q])=>[side,attachLink(q,available.map(x=>x.quote_meta[market]?.[side]))]));L.market_sources[market]=picked.source;
    }
    const rows=Object.values(L.quote_meta).flatMap(Object.values), sourceSet=[...new Set(Object.values(L.market_sources))];
    L.source=L.src=sourceSet.length===1?sourceSet[0]:'mixed';L.actionable=!!rows.length&&rows.every(q=>q.actionable);
    L.received_at=rows.map(q=>q.received_at).sort().at(-1)||null;
    L.source_observed_at=rows.length&&rows.every(q=>q.source_observed_at)?rows.map(q=>q.source_observed_at).sort()[0]:null;
    L.freshness=L.actionable?'FRESH':rows.find(q=>!q.actionable)?.freshness || 'UNVERIFIED';
    out[book]=L;
  }
  return out;
}
function publicOdds(D, pk, now = Date.now()) {
  const day = ctx?.today(), game = day?.games.get(Number(pk)) || day?.games.get(String(pk));
  const cached = D?.date === day?.date ? liveQuotes.get(Number(pk)) : null;
  const base = D?.pub(pk) || (D?.date === day?.date && knownLivePks.has(Number(pk)) ? { pk: Number(pk), books: {}, open: null, close: null, moves: [], spark: { ml: [], t: [] }, at: 0 } : null);
  if (!base) return null;
  const live = game?.state === 'Live' && cached ? selectLiveBooks(cached.sources || {an:cached}, now) : {};
  return wireOdds({ ...base, live, live_max_age_ms: LIVE_MAX_AGE_MS });
}
// The wire view of a game's odds. Each quote's metadata carried provider option ids and channel bookkeeping the
// board never reads (audited 2026-09-24: no reader outside the feed adapters); measured at 74% of a 2.1 MB snapshot.
const QUOTE_META_DROP = new Set(['optionMarketId', 'optionId', 'provider_channel', 'max_bet']);
function wireQuote(q) {
  if (!q || typeof q !== 'object') return q;
  const o = {};
  for (const [k, v] of Object.entries(q)) if (!QUOTE_META_DROP.has(k)) o[k] = v;
  return o;
}
function wireLine(L) {
  if (!L || typeof L !== 'object' || !L.quote_meta || typeof L.quote_meta !== 'object') return L;
  const quote_meta = {};
  for (const [m, sides] of Object.entries(L.quote_meta)) quote_meta[m] = sides && typeof sides === 'object' ? Object.fromEntries(Object.entries(sides).map(([s, q]) => [s, wireQuote(q)])) : sides;
  return { ...L, quote_meta };
}
function wireOdds(o) {
  const out = { ...o };
  for (const grp of ['books', 'live', 'f5']) if (out[grp] && typeof out[grp] === 'object') out[grp] = Object.fromEntries(Object.entries(out[grp]).map(([b, L]) => [b, wireLine(L)]));
  return out;
}

function scheduleOwlsFlush() {
  if(!owlsFlushTimer) owlsFlushTimer=setTimeout(()=>{owlsFlushTimer=null;flush();if([...pending.values()].some(p=>p.fast))scheduleOwlsFlush();},50);
}
// Which games a relay frame was last applied to (both days), so a schedule that lands after the frame gets it too.
function owlsGameKey(D) { const key=(gs)=>gs.map(g=>[g.pk,g.state,g.start].join('/')).join('|'); return D.date+':'+key(dayGames())+'#'+(nextCurrent()?.date||'')+':'+key(nextGames()); }
// Tomorrow's slate from the streaming relays: pregame books (and Owls' first five) only, never in-play quotes.
function applyNextRelay(src, cache) {
  const N = nextCurrent(); if (!N) return;
  const games = nextGames(); if (!games.length) return;
  const parsed = (src === 'sharp' ? SHARP : OWLS).match(cache.events, games);
  for (const g of games) if (openFor(N, g, src)) {
    const patch = parsed.get(g.pk);
    apply(N, g.pk, src, patch?.books || {}, cache.receivedAt);
    if (src === 'owls' && N.setF5(g.pk, 'owls', patch?.h1 || {}, cache.receivedAt)) pending.set(g.pk, { price: true });
  }
  nextStatus[src] = { at: cache.receivedAt, received_at: new Date(cache.receivedAt).toISOString(), date: N.date, games: cache.events.length, matched: parsed.size, state: 'ok',
    ...(src === 'sharp' ? { source_observed_at: null, timestamp_kind: 'FEED_DELIVERY' } : {}) };
}
function applyOwls(cache = owlsCache) {
  if(!cache) return;
  owlsCache=cache;
  const D=current(); if(!D) return;
  const games=dayGames(), parsed=OWLS.match(cache.events,games);
  refreshLive(parsed,games,cache.receivedAt,'owls');
  for(const g of games) if(openFor(D,g,'owls')) {
    const patch=parsed.get(g.pk);
    apply(D,g.pk,'owls',patch?.books || {},cache.receivedAt);
    if(D.setF5(g.pk,'owls',patch?.h1 || {},cache.receivedAt)) pending.set(g.pk,{price:true});
    const p=pending.get(g.pk);if(p) p.fast=true;
  }
  applyNextRelay('owls',cache);
  owlsAppliedKey=owlsGameKey(D);
  const clocks=Object.values(cache.events).flatMap(e=>[e.books,e.live,e.h1]).flatMap(books=>Object.values(books||{})).flatMap(L=>Object.values(L.integrityMeta||{}).flatMap(Object.values)).map(q=>Date.parse(q.source_observed_at)).filter(Number.isFinite);
  status.owls={at:cache.receivedAt,received_at:new Date(cache.receivedAt).toISOString(),source_observed_at:clocks.length?new Date(Math.max(...clocks)).toISOString():null,date:D.date,games:cache.events.length,matched:parsed.size,state:'ok'};
  if(Date.now()-owlsStatusAt>5000){owlsStatusAt=Date.now();emitStatus();}
  scheduleOwlsFlush();
}

function applySharp(cache = sharpCache) {
  if (!cache) return;
  sharpCache = cache;
  const D = current(); if (!D) return;
  const games = dayGames(), parsed = SHARP.match(cache.events,games);
  refreshLive(parsed,games,cache.receivedAt,'sharp');
  for (const g of games) if (openFor(D,g,'sharp')) {
    const patch = parsed.get(g.pk);
    apply(D,g.pk,'sharp',patch?.books || {},cache.receivedAt);
    const p = pending.get(g.pk); if (p?.price) p.fast = true;
  }
  applyNextRelay('sharp', cache);
  sharpAppliedKey = owlsGameKey(D);
  status.sharp = {at:cache.receivedAt,received_at:new Date(cache.receivedAt).toISOString(),source_observed_at:null,
    timestamp_kind:'FEED_DELIVERY',date:D.date,games:cache.events.length,matched:parsed.size,state:'ok'};
  if (Date.now()-sharpStatusAt>5000) {sharpStatusAt=Date.now();emitStatus();}
  scheduleOwlsFlush();
}

// ---------------------------------------------------------------- sources
// Each poller prices one tracked day (`S`, today unless the next day's slate is asked for).
async function pollAN(S = TODAY) {
  const D = S.odds();
  if (!D) return;
  const games = S.games();
  if (!games.length) return;
  const j = await AN.fetchAN(D.date);
  if (S.date() !== D.date) return; // discard a response crossing the baseball-day rollover
  const now = Date.now();
  const parsed = AN.parseAN(j, games);
  if (S.live) refreshLive(parsed, dayGames(), now);
  for (const g of S.games()) {
    const pk = g.pk, p = parsed.get(pk) || {};
    if (openFor(D, g, 'an')) apply(D, pk, 'an', p.books || {}, now);
    if (p.splits && D.setSplits(pk, p.splits)) pending.set(pk, pending.get(pk) || { price: false });
    if (p.tt && D.setTT(pk, p.tt)) pending.set(pk, pending.get(pk) || { price: false });
  }
  S.status.an = { at: now, date: D.date, games: (j.games || []).length, matched: parsed.size };
  return true;
}

// First five innings, from Action Network's public-betting feed.
async function pollAN1(S = TODAY) {
  const D = S.odds();
  if (!D) return;
  const games = S.games().filter((g) => g.state === 'Preview');
  if (!games.length) return;
  const j = await AN.fetchAN1(D.date);
  if (S.date() !== D.date) return false;
  const now = Date.now();
  const m = AN.parseAN1(j, games);
  const full = AN.parseAN1Full(j, games);
  for (const g of S.games().filter((g) => openFor(D, g, 'an1'))) {
    if (D.setF5(g.pk, 'an1', m.get(g.pk) || {}, now)) pending.set(g.pk, { price: true });
    apply(D, g.pk, 'an1', full.get(g.pk) || {}, now);
  }
  S.status.an1 = { at: now, date: D.date, games: (j.games || []).length, matched: m.size, full_matched: full.size };
  return true;
}

async function pollPin(S = TODAY) {
  const D = S.odds();
  if (!D) return;
  const games = S.games().filter((g) => g.state === 'Preview');
  if (!games.length) return;
  const got = await fetchShared('pin', () => PIN.fetchPinnacle());
  if (S.date() !== D.date) return false;
  const pg = got.value, now = got.at;
  const m = PIN.matchPinnacle(pg, games);
  // `seen` = when Pinnacle last listed the game. A game it drops keeps its old stamp and goes stale.
  for (const g of S.games().filter((g) => openFor(D, g, 'pin'))) {
    const r = m.get(g.pk);
    apply(D, g.pk, 'pin', r?.L ? { pin: r.L } : {}, now);
    if (D.setF5(g.pk, 'pin', r?.f5 ? { pin: r.f5 } : {}, now)) pending.set(g.pk, { price: true });
  }
  S.status.pin = { at: now, date: D.date, games: pg.length, matched: m.size };
  return true;
}

async function pollEspn(S = TODAY) {
  const D = S.odds();
  if (!D) return;
  const games = S.games().filter((g) => g.state === 'Preview');
  if (!games.length) return;
  const j = await ESPN.fetchEspn(D.date);
  if (S.date() !== D.date) return false;
  const now = Date.now();
  const m = ESPN.parseEspn(j, games);
  for (const g of S.games().filter((g) => openFor(D, g, 'espn'))) apply(D, g.pk, 'espn', m.has(g.pk) ? { dk: m.get(g.pk) } : {}, now);
  S.status.espn = { at: now, date: D.date, games: (j.events || []).length, matched: m.size };
  return true;
}

async function pollVsin(S = TODAY) {
  const D = S.odds();
  if (!D) return;
  const games = S.games().filter((g) => g.state === 'Preview');
  if (!games.length) return;
  const got = await fetchShared('vsin', () => VSIN.fetchVsin());
  if (S.date() !== D.date) return false;
  const v = got.value, now = got.at;
  // Reuse the parsed table when its stamp holds, but never replace that source clock with this receipt.
  const m = VSIN.matchVsin(v.games, games, D.date);
  for (const g of S.games().filter((g) => openFor(D, g, 'vsin'))) {
    const r = m.get(g.pk);
    apply(D, g.pk, 'vsin', r?.books || {}, now);
    if (D.setF5(g.pk, 'vsin', r?.f5 || {}, now)) pending.set(g.pk, { price: true });
  }
  S.status.vsin = { at: now, checked: now, stamp: v.stamp, date: D.date, games: v.games.length, matched: m.size };
  return true;
}

// Freeze the close for every game that has left Preview.
// First-pitch weather, for the games that haven't started.
async function pollWx() {
  const D = current();
  if (!D) return;
  const soon = dayGames().filter((g) => g.state === 'Preview');
  if (!soon.length) return;
  const got = await WX.forecast(soon);
  for (const [pk, wx] of got) if (D.setWx(pk, wx)) pending.set(pk, pending.get(pk) || { price: false });
  status.wx = { at: Date.now(), parks: got.size };
}

function freezeStarted() {
  const D = current();
  if (!D || !anOnce) return;
  for (const g of dayGames()) {
    if (g.state === 'Preview' || D.closeOf(g.pk) || !D.has(g.pk)) continue;
    if (D.freeze(g.pk)) {
      const c = D.closeOf(g.pk);
      log('odds close', g.pk, `${g.away.abbr} @ ${g.home.abbr}`, c.book, c.ml?.join('/'), c.t?.line);
      pending.set(g.pk, { price: true });
    }
  }
}

function loop(name, fn, every) {
  const run = async () => {
    let wait = typeof every === 'function' ? every() : every;
    try { await fn(); } catch (e) { status[name] = { ...status[name], err: e.message, errAt: Date.now() }; log(`odds ${name}:`, e.message); }
    if (name === 'an') { anOnce = true; freezeStarted(); }
    wait = typeof every === 'function' ? every() : wait;
    setTimeout(run, wait + Math.round(Math.random() * 2000));
  };
  return run;
}

const sourceTasks = { an: pollAN, an1: pollAN1, pin: pollPin, espn: pollEspn, vsin: pollVsin };
function sourceInterval(name) { return name === 'an' ? anInterval(dayGames()) : EVERY[name]; }
function runSource(name, S = TODAY) {
  const D = S.odds();
  if (!D) return null;
  let job = S.jobs.get(name);
  if (!job) { job = { promise: null, nextAt: 0, failures: 0 }; S.jobs.set(name, job); }
  if (job.promise) return job.promise;
  if (Date.now() < job.nextAt) return null;
  const eligible = S.games().some((g) => name === 'an' && S.live ? (openFor(D, g, name) || g.state === 'Live') : openFor(D, g, name));
  if (!eligible) { S.status[name] = { ...S.status[name], state: 'idle' }; job.nextAt = Date.now() + S.every(name); return null; }
  const date = D.date, startedAt = Date.now();
  S.status[name] = { ...S.status[name], state: 'loading', requested_at: startedAt };
  job.promise = Promise.resolve().then(() => sourceTasks[name](S)).then((ok) => {
    if (!ok) { S.status[name] = { ...S.status[name], state: 'waiting' }; return { ok: false, skipped: true }; }
    job.failures = 0;
    S.status[name] = { ...S.status[name], state: 'ok', requested_at: startedAt, last_success_at: Date.now(), err: null, errAt: null };
    if (name === 'an' && S.live) { anOnce = true; freezeStarted(); }
    return { ok: true };
  }, (error) => {
    job.failures++;
    job.retryAfterMs = Math.max(0, Number(error?.retryAfterMs) || 0);
    S.status[name] = { ...S.status[name], state: 'error', err: String(error.message || error).slice(0, 300), errAt: Date.now() };
    log(`odds ${name}${S.live ? '' : ' (next day)'}:`, error.message);
    return { ok: false, error: true };
  }).finally(() => {
    const backoff = job.failures ? Math.min(300000, 5000 * 2 ** Math.min(10, job.failures - 1)) : 0;
    job.nextAt = S.date() === date ? Date.now() + Math.max(S.every(name), backoff, job.retryAfterMs || 0) : 0;
    job.retryAfterMs = 0; job.promise = null;
    emitStatus(S);
  });
  return job.promise;
}
function tickSources() {
  for (const name of SOURCE_NAMES) runSource(name);
  if (nextCurrent()) for (const name of SOURCE_NAMES) runSource(name, NEXT);
  const D=current(); if(owlsCache && D && owlsGameKey(D)!==owlsAppliedKey) applyOwls(); if(sharpCache && D && owlsGameKey(D)!==sharpAppliedKey) applySharp();
}
function requestRefresh(date = ctx?.today()?.date) {
  current();
  const S = date === ctx?.today()?.date ? TODAY : nextCurrent() && date === nxt.date ? NEXT : null;
  if (!S) return { in_progress: false, requested_at: null, completed_at: null, next_allowed_at: 0, cooldown_ms: REFRESH_COOLDOWN_MS, result: 'historical' };
  const R = S.refresh, now = Date.now();
  if (R.in_progress) return { ...R };
  if (now < R.next_allowed_at) return { ...R, result: 'cooldown' };
  Object.assign(R, { in_progress: true, requested_at: now, completed_at: null, next_allowed_at: now + REFRESH_COOLDOWN_MS, result: 'running' });
  const work = SOURCE_NAMES.map((name) => runSource(name, S)).filter(Boolean);
  if (!work.length) {
    const next = Math.min(...[...S.jobs.values()].map((job) => job.nextAt).filter((at) => at > now));
    if (Number.isFinite(next)) R.next_allowed_at = Math.max(R.next_allowed_at, next);
    Object.assign(R, { in_progress: false, completed_at: now, result: 'scheduled' });
  } else Promise.all(work).then((outcomes) => {
    if (S.date() !== date || R.requested_at !== now) return;
    const failures = outcomes.filter((x) => x.error).length;
    Object.assign(R, { in_progress: false, completed_at: Date.now(), result: failures === outcomes.length ? 'error' : failures ? 'partial' : 'complete' });
    flush(); emitStatus(S);
  });
  emitStatus(S);
  return { ...R };
}

// Push changed games, at most once per PUSH_MIN each.
function flush() {
  const D = current();
  if (!D) return;
  const now = Date.now();
  for (const [pk, p] of pending) {
    const last = sentAt.get(pk) || 0;
    if (now - last < (p.fast ? 50 : PUSH_MIN)) continue;
    if (!p.fast && !p.price && !p.live && now - last < SEEN_PUSH) continue;
    pending.delete(pk);
    sentAt.set(pk, now);
    const O = publicOdds(oddsDayFor(pk), pk);
    if (O) ctx.emit('odds', O);
  }
}

function anInterval(games) { return games.some((g) => g.state === 'Preview' || g.state === 'Live') ? EVERY.an : EVERY.anIdle; }

// One line every half hour in the deploy log: which feeds are answering, how many games each matched, which live
// feeds cover games in play, and how much of the next day is priced. Counts only, never prices.
function logSummary() {
  const D = current();
  if (!D) return;
  const feeds = (S) => SOURCE_NAMES.map((name) => { const s = S.status[name] || {}; return `${name}:${s.state || (s.at ? 'ok' : '-')}${s.matched != null ? '/' + s.matched : ''}`; }).join(' ');
  const playing = dayGames().filter((g) => g.state === 'Live').length;
  const live = [...liveQuotes.values()].map((row) => Object.keys(row.sources || {}).sort().join('+') || 'none');
  const N = nextCurrent(), n = nextSummary();
  log('odds summary', D.date, feeds(TODAY), `| in play ${playing}, live quotes ${live.length}${live.length ? ' (' + live.join(', ') + ')' : ''}`,
    N ? `| next ${N.date}: ${n.priced}/${n.games} priced, ${feeds(NEXT)}` : '| no next day');
}

function start(c) {
  ctx = c;
  current();
  nextCurrent();
  const now = Date.now();
  for (const [name, delay] of Object.entries({ an: 0, espn: 3000, pin: 5000, an1: 6000, vsin: 8000 })) jobs.set(name, { nextAt: now + delay, promise: null, failures: 0 });
  // The next day's slate starts after today's first round (Pinnacle and VSiN then reuse today's response).
  for (const [name, delay] of Object.entries({ an: 12000, espn: 15000, pin: 18000, an1: 21000, vsin: 24000 })) nextJobs.set(name, { nextAt: now + delay, promise: null, failures: 0 });
  owlsFeed = OWLS.subscribe?.('mlb',applyOwls) || null;
  sharpFeed = SHARP.subscribe?.('mlb',applySharp) || null;
  tickSources();
  setInterval(tickSources, 1000);
  setTimeout(loop('wx', pollWx, EVERY.wx), 11000);
  keys(new Date().getFullYear() - 1); // warm the key-number table in the background
  setInterval(freezeStarted, 5000);
  setInterval(flush, 1000);
  setInterval(() => { cur?.save(); nxt?.save(); }, 30e3);
  setTimeout(logSummary, 90e3); setInterval(logSummary, 30 * 60e3);
}

function saveNow() { try { cur?.save(true); nxt?.save(true); } catch (e) { log('odds save', e.message); } }

// ---------------------------------------------------------------- views
function bookList(D) {
  const fed = new Set();
  for (const G of Object.values(D?.games || {})) for (const k of Object.keys(G.books || {})) fed.add(k);
  if (D?.date === ctx?.today()?.date) for (const row of liveQuotes.values()) for (const key of Object.keys(row.books)) fed.add(key);
  // Every sportsbook column the football boards show (owner: "just as many as football"), a dash where a book has no
  // MLB price; catalog-only books appear once they carry one.
  return BOOKS.filter(b=>fed.has(b.key) || !b.catalogOnly).map(({ key, name, short, nv, sharp, link, ios }) => ({ key, name, short, nv: !!nv, sharp: !!sharp, feed: fed.has(key), site: link || null, ios: ios || null }));
}

function sourceInfo(S = TODAY) {
  const D = S.odds();
  return Object.fromEntries([...SOURCE_NAMES, 'owls', 'sharp'].map((name) => {
    if(name==='sharp') return [name,{...(S.status.sharp || {}),...(sharpFeed?.status() || {state:'disabled'})}];
    if(name==='owls') return [name,{...(S.status.owls || {}),...(owlsFeed?.status() || {state:'disabled'})}];
    const s = S.status[name] || {}, job = S.jobs.get(name), rows = [];
    for (const G of Object.values(D?.games || {})) for (const group of [G.srcs?.[name], G.f5src?.[name]]) for (const L of Object.values(group || {})) rows.push(...Object.values(L.quote_meta || {}).flatMap(Object.values));
    if (name === 'an' && S.live) for (const live of liveQuotes.values()) for (const L of Object.values(live.books)) rows.push(...Object.values(L.quote_meta || {}).flatMap(Object.values));
    const clocks = rows.map((q) => Date.parse(q.source_observed_at)).filter(Number.isFinite);
    return [name, { state: job?.promise ? 'loading' : s.date && s.date !== D?.date ? 'waiting' : s.state || (s.at ? 'ok' : 'waiting'), date: s.date || null, requested_date: D?.date || null,
      checked_at: s.at || null, received_at: s.at ? new Date(s.at).toISOString() : null, last_success_at: s.last_success_at || s.at || null,
      source_observed_at: clocks.length ? new Date(Math.max(...clocks)).toISOString() : null,
      source_clock_quotes: clocks.length, observed_quotes: rows.length,
      last_error: s.err || null, last_error_at: s.errAt || null, next_refresh_at: job?.promise ? null : job?.nextAt || null,
      matched_games: s.matched ?? null, provider_games: s.games ?? null }];
  }));
}
function coverageFor(D, projected) {
  const today = D?.date === ctx?.today()?.date, next = !today && !!D && D === nxt && D.date === ctx?.next?.()?.date;
  const active = today ? dayGames().filter((g) => openFor(D, g, 'an') || g.state === 'Live') : next ? nextGames().filter((g) => openFor(D, g, 'an')) : [];
  const out = { active_games: active.length, games_with_prices: 0, books_with_prices: 0, markets: {}, missing: [],
    fresh_selections: 0, aging_selections: 0, stale_selections: 0, unverified_selections: 0, suspended_selections: 0, conflicted_selections: 0, by_book: {} };
  const gamesWithPrices = new Set(), booksWithPrices = new Set();
  for (const g of active) for (const b of bookList(D).filter((b) => !['cons', 'open'].includes(b.key))) {

    const O = projected[g.pk], groups = g.state === 'Live' ? [['', O?.live]] : [['', O?.books], ['f5_', O?.f5]];
    const book = out.by_book[b.key] ||= { expected_markets: 0, available_markets: 0, fresh_markets: 0 };
    for (const [prefix, books] of groups) for (const market of ['ml', 'rl', 't']) {
      const key = prefix + market, L = books?.[b.key];
      const cell = out.markets[key] ||= { expected: 0, available: 0, fresh: 0, missing: 0 };
      cell.expected++; book.expected_markets++;
      const quotes = SIDES[market].map((side) => L?.quote_meta?.[market]?.[side]);
      const available = quotes.every((q) => Number.isFinite(q?.american_odds) && Math.abs(q.american_odds) >= 100 && (market === 'ml' || Number.isFinite(q.line_value)) && !q.missing_from_source);
      if (available) { cell.available++; book.available_markets++; gamesWithPrices.add(g.pk); booksWithPrices.add(b.key); }
      else { cell.missing++; out.missing.push({ pk: g.pk, book: b.key, market: key, reason: 'NO_COMPLETE_QUOTE' }); }
      if (available && quotes.every((q) => q.actionable)) { cell.fresh++; book.fresh_markets++; }
      for (const q of quotes.filter(Boolean)) {
        const field = ({ FRESH: 'fresh_selections', AGING: 'aging_selections', STALE: 'stale_selections', UNVERIFIED: 'unverified_selections', SUSPENDED: 'suspended_selections', CONFLICTED: 'conflicted_selections' })[q.freshness] || 'unverified_selections';
        out[field]++;
      }
    }
  }
  out.games_with_prices = gamesWithPrices.size; out.books_with_prices = booksWithPrices.size;
  return out;
}
// Status for one tracked day. Both carry the next-day summary, so "how much of tomorrow is priced" stays current.
function emitStatus(S = TODAY) {
  if (!ctx?.emit) return;
  if (S === NEXT) {
    const N = nextCurrent();
    if (!N) return;
    const data = snapshot(N.date);
    ctx.emit('odds_status', { date: N.date, now: Date.now(), sources: data.sources, coverage: data.coverage, refresh: data.refresh, next: nextSummary() });
    return;
  }
  const data = snapshot();
  ctx.emit('odds_status', { date: ctx?.today()?.date || null, now: Date.now(), sources: data.sources, coverage: data.coverage, refresh: data.refresh, next: data.next });
}

// How much of the next day's slate has prices yet: today's board uses it to point there once today's games are under way.
function nextSummary() {
  const N = nextCurrent();
  if (!N) return null;
  const games = nextGames();
  const priced = games.filter((g) => Object.entries(N.games[g.pk]?.books || {}).some(([k, L]) => k !== 'open' && (L?.ml?.[0] != null || L?.t?.line != null))).length;
  return { date: N.date, games: games.length, priced };
}

// { games, books, moves } for the snapshot (today, the next day's slate, or a past day from history).
function snapshot(date) {
  const D = date ? dayFor(date) : current();
  const S = !date || date === ctx?.today()?.date ? TODAY : D && D === nxt && date === ctx?.next?.()?.date ? NEXT : null;
  const pks = new Set(Object.keys(D?.games || {}));
  if (D?.date === ctx?.today()?.date) for (const pk of knownLivePks) pks.add(String(pk));
  const games = Object.fromEntries([...pks].map((pk) => [pk, publicOdds(D, pk)]));
  return { games, books: bookList(D), moves: D ? D.moves() : [], sources: S ? sourceInfo(S) : {}, coverage: coverageFor(D, games),
    refresh: S ? { ...S.refresh } : { in_progress: false, requested_at: null, completed_at: null, next_allowed_at: 0, cooldown_ms: REFRESH_COOLDOWN_MS, result: 'historical' },
    ...(S === TODAY ? { next: nextSummary() } : {}) };
}

function forDate(date) {
  return { date, now: Date.now(), ...snapshot(date) };
}

function game(pk) {
  const D = current(), H = oddsDayFor(pk);
  if (H && H !== D && H.has(pk)) return { odds: publicOdds(H, pk), hist: H.full(pk) };
  if (D && (D.has(pk) || knownLivePks.has(Number(pk)))) return { odds: publicOdds(D, pk), hist: D.full(pk) };
  for (const P of past.values()) if (P.has(pk)) return { odds: publicOdds(P, pk), hist: P.full(pk) };
  return null;
}

// The frozen close for a game. `start` (ISO) helps find a game from another day on disk.
function closeOf(pk, start) {
  const D = current();
  if (D?.closeOf(pk)) return D.closeOf(pk);
  for (const P of past.values()) if (P.closeOf(pk)) return P.closeOf(pk);
  if (start) {
    const t = Date.parse(start);
    if (!Number.isNaN(t)) {
      for (const off of [0, -1]) {
        const date = new Date(t - 6 * 3600e3 + off * 86400e3).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const P = dayFor(date);
        if (P?.closeOf(pk)) return P.closeOf(pk);
      }
    }
  }
  return null;
}

function healthInfo() {
  const N = nextCurrent();
  return { status, sources: sourceInfo(), coverage: snapshot().coverage, refresh: { ...refresh }, hosts: health(), liveGames: liveQuotes.size, liveMaxAgeMs: LIVE_MAX_AGE_MS, games: cur ? Object.keys(cur.games).length : 0, date: cur?.date || null,
    next: N ? { date: N.date, scheduled: nextGames().length, games: Object.keys(N.games).length, summary: nextSummary(), status: nextStatus, sources: sourceInfo(NEXT), coverage: snapshot(N.date).coverage, refresh: { ...nextRefresh } } : null };
}

module.exports = { start, snapshot, forDate, game, closeOf, healthInfo, saveNow, keys, requestRefresh };
