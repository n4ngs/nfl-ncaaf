'use strict';
/* The MLB odds engine: polls Action Network, Pinnacle, ESPN (DraftKings) and VSiN on their own polite cadences,
   maps every game onto today's MLB gamePks, keeps the line history (lib/lines.js), freezes the close at first pitch
   and tells the server what to push. The server passes in the day model and an emitter; nothing here touches HTTP. */

const fs = require('node:fs');
const path = require('node:path');
const { log, health, DATA } = require('./util');
const { BOOKS } = require('./books');
const { OddsDay } = require('./lines');
const AN = require('./action');
const PIN = require('./pinnacle');
const ESPN = require('./espn');
const VSIN = require('./vsin');
const WX = require('./weather');
const { keys } = require('./keys');

const EVERY = { an: 20e3, anIdle: 5 * 60e3, an1: 2 * 60e3, pin: 2 * 60e3, espn: 60e3, vsin: 2 * 60e3, wx: 30 * 60e3 };
const PUSH_MIN = 3000;      // at most one odds push per game per 3 s
const configuredLiveAge = Number(process.env.MLB_LIVE_MAX_AGE_MS);
const LIVE_MAX_AGE_MS = Number.isFinite(configuredLiveAge) && configuredLiveAge > 0 ? Math.max(20000, configuredLiveAge) : 50000;
const SEEN_PUSH = 2 * 60e3; // re-push a game whose prices held but whose `seen` moved on, this often

let ctx = null;             // { today: () => Day|null, emit(type, data) }
let cur = null;             // OddsDay for today
const past = new Map();     // date -> OddsDay (read from disk)
const status = { an: {}, an1: {}, pin: {}, espn: {}, vsin: {}, wx: {} };
const pending = new Map();  // pk -> { price: bool }
const sentAt = new Map();   // pk -> ms
let anOnce = false;
// Explicit in-play observations are ephemeral and never written into pregame history or close.
const liveQuotes = new Map(); // pk -> { books, receivedAt }
const knownLivePks = new Set(); // retain an empty public projection when a live-only quote disappears


// ---------------------------------------------------------------- day model
function dayGames() {
  const d = ctx?.today();
  if (!d) return [];
  return [...d.games.values()].map((G) => ({ pk: G.pk, start: G.start, state: G.state, detail: G.detail, home: G.home, away: G.away, venue: G.venue }));
}
function current() {
  const d = ctx?.today();
  if (!d) return null;
  if (!cur || cur.date !== d.date) {
    if (cur) { cur.save(); remember(cur); }
    cur = past.get(d.date) || new OddsDay(d.date);
    past.delete(d.date);
    pending.clear();
    sentAt.clear();
    liveQuotes.clear();
    knownLivePks.clear();
    log('odds: day', d.date, `${Object.keys(cur.games).length} games from history`);
  }
  return cur;
}
function remember(D) {
  past.set(D.date, D);
  while (past.size > 7) past.delete(past.keys().next().value);
}
function dayFor(date) {
  const D = current();
  if (D && D.date === date) return D;
  if (past.has(date)) return past.get(date);
  if (!fs.existsSync(path.join(DATA, 'odds', `${date}.json`))) return null;
  const P = new OddsDay(date);
  remember(P);
  return P;
}

// Which games may still take prices: pregame, or started without a close yet (Action Network's pregame lines only).
function openFor(D, g, src) {
  if (g.state === 'Preview') return true;
  return src === 'an' && !D.closeOf(g.pk);
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

function liveQuoteView(q, market, receivedAt, now) {
  const sourceAt = Date.parse(q.source_observed_at), age = Number.isFinite(sourceAt) ? now - sourceAt : null;
  let freshness = 'FRESH', reason_code = null;
  if (q.conflicted || (Number.isFinite(sourceAt) && sourceAt > receivedAt)) { freshness = 'CONFLICTED'; reason_code = 'CONFLICTED_QUOTE'; }
  else if (['suspended', 'removed'].includes(q.market_status)) { freshness = 'SUSPENDED'; reason_code = q.market_status === 'removed' ? 'MARKET_REMOVED' : 'MARKET_SUSPENDED'; }
  else if (q.market_status !== 'active' || q.is_live !== true) { freshness = 'UNVERIFIED'; reason_code = 'UNVERIFIED_MARKET_STATE'; }
  else if (age == null) { freshness = 'UNVERIFIED'; reason_code = 'MISSING_SOURCE_TIMESTAMP'; }
  else if (!Number.isFinite(q.american_odds) || Math.abs(q.american_odds) < 100 || (market !== 'ml' && !Number.isFinite(q.line_value))) { freshness = 'UNVERIFIED'; reason_code = 'INVALID_PRICE'; }
  else if (age > LIVE_MAX_AGE_MS) { freshness = 'STALE'; reason_code = 'SOURCE_QUOTE_STALE'; }
  return { ...q, src: 'an', source: 'an', received_at: new Date(receivedAt).toISOString(),
    freshness, reason_code, age_ms: age, max_age_ms: LIVE_MAX_AGE_MS, actionable: freshness === 'FRESH' };
}
function liveBookView(L, receivedAt, now) {
  const quote_meta = Object.fromEntries(Object.entries(L.quote_meta || {}).map(([market, sides]) => [market,
    Object.fromEntries(Object.entries(sides).map(([side, q]) => [side, liveQuoteView(q, market, receivedAt, now)]))]));
  const rows = Object.values(quote_meta).flatMap(Object.values);
  const rank = { FRESH: 0, STALE: 1, UNVERIFIED: 2, SUSPENDED: 3, CONFLICTED: 4 };
  const worst = rows.reduce((a, b) => !a || rank[b.freshness] > rank[a.freshness] ? b : a, null);
  const clocks = rows.map((q) => Date.parse(q.source_observed_at));
  return { ...L, quote_meta, src: 'an', source: 'an', is_live: true, seen: receivedAt,
    received_at: new Date(receivedAt).toISOString(), source_observed_at: clocks.length && clocks.every(Number.isFinite) ? new Date(Math.min(...clocks)).toISOString() : null,
    market_status: worst?.market_status || 'unverified', freshness: worst?.freshness || 'UNVERIFIED',
    reason_code: worst?.reason_code || null, actionable: !!rows.length && rows.every((q) => q.actionable), max_age_ms: LIVE_MAX_AGE_MS };
}
function refreshLive(parsed, games, receivedAt) {
  const playing = new Set(games.filter((g) => g.state === 'Live').map((g) => Number(g.pk)));
  const next = new Map();
  for (const [pk, patch] of parsed) if (playing.has(Number(pk)) && Object.keys(patch.live || {}).length) next.set(Number(pk), { books: patch.live, receivedAt });
  for (const pk of new Set([...liveQuotes.keys(), ...next.keys()])) {
    const p = pending.get(pk) || { price: false };
    pending.set(pk, { ...p, live: true }); // includes explicit removal updates
  }
  liveQuotes.clear();
  for (const [pk, row] of next) { liveQuotes.set(pk, row); knownLivePks.add(pk); }
}
function publicOdds(D, pk, now = Date.now()) {
  const day = ctx?.today(), game = day?.games.get(Number(pk)) || day?.games.get(String(pk));
  const cached = D?.date === day?.date ? liveQuotes.get(Number(pk)) : null;
  const base = D?.pub(pk) || (D?.date === day?.date && knownLivePks.has(Number(pk)) ? { pk: Number(pk), books: {}, open: null, close: null, moves: [], spark: { ml: [], t: [] }, at: 0 } : null);
  if (!base) return null;
  const live = game?.state === 'Live' && cached ? Object.fromEntries(Object.entries(cached.books).map(([key, L]) => [key, liveBookView(L, cached.receivedAt, now)])) : {};
  return { ...base, live, live_max_age_ms: LIVE_MAX_AGE_MS };
}

// ---------------------------------------------------------------- sources
async function pollAN() {
  const D = current();
  if (!D) return;
  const games = dayGames();
  if (!games.length) return;
  const j = await AN.fetchAN(D.date);
  if (ctx?.today()?.date !== D.date) return; // discard a response crossing the baseball-day rollover
  const now = Date.now();
  const parsed = AN.parseAN(j, games);
  refreshLive(parsed, dayGames(), now);
  const byPk = new Map(games.map((g) => [g.pk, g]));
  for (const [pk, p] of parsed) {
    const g = byPk.get(pk);
    if (!g) continue;
    if (openFor(D, g, 'an') && Object.keys(p.books || {}).length) apply(D, pk, 'an', p.books, now);
    if (p.splits && D.setSplits(pk, p.splits)) pending.set(pk, pending.get(pk) || { price: false });
    if (p.tt && D.setTT(pk, p.tt)) pending.set(pk, pending.get(pk) || { price: false });
  }
  status.an = { at: now, games: (j.games || []).length, matched: parsed.size };
}

// First five innings, from Action Network's public-betting feed.
async function pollAN1() {
  const D = current();
  if (!D) return;
  const games = dayGames().filter((g) => g.state === 'Preview');
  if (!games.length) return;
  const j = await AN.fetchAN1(D.date);
  const now = Date.now();
  const m = AN.parseAN1(j, games);
  for (const [pk, books] of m) if (D.setF5(pk, 'an1', books, now)) pending.set(pk, pending.get(pk) || { price: false });
  status.an1 = { at: now, games: (j.games || []).length, matched: m.size };
}

async function pollPin() {
  const D = current();
  if (!D) return;
  const games = dayGames().filter((g) => g.state === 'Preview');
  if (!games.length) return;
  const pg = await PIN.fetchPinnacle();
  const now = Date.now();
  const m = PIN.matchPinnacle(pg, games);
  // `seen` = when Pinnacle last listed the game. A game it drops keeps its old stamp and goes stale.
  for (const [pk, r] of m) {
    if (r.L) apply(D, pk, 'pin', { pin: r.L }, now);
    if (r.f5 && D.setF5(pk, 'pin', { pin: r.f5 }, now)) pending.set(pk, pending.get(pk) || { price: false });
  }
  status.pin = { at: now, games: pg.length, matched: m.size };
}

async function pollEspn() {
  const D = current();
  if (!D) return;
  const games = dayGames().filter((g) => g.state === 'Preview');
  if (!games.length) return;
  const j = await ESPN.fetchEspn(D.date);
  const now = Date.now();
  const m = ESPN.parseEspn(j, games);
  for (const [pk, L] of m) apply(D, pk, 'espn', { dk: L }, now);
  status.espn = { at: now, games: (j.events || []).length, matched: m.size };
}

async function pollVsin() {
  const D = current();
  if (!D) return;
  const games = dayGames().filter((g) => g.state === 'Preview');
  if (!games.length) return;
  const v = await VSIN.fetchVsin();
  const now = Date.now();
  if (v.same && status.vsin.stamp === v.stamp && status.vsin.date === D.date) { status.vsin.checked = now; return; }
  // VSiN confirms its prices as of its "Odds updated" stamp.
  const seen = Math.min(now, v.t || now);
  const m = VSIN.matchVsin(v.games, games, D.date);
  for (const [pk, r] of m) {
    if (Object.keys(r.books || {}).length) apply(D, pk, 'vsin', r.books, seen);
    if (r.f5 && Object.keys(r.f5).length && D.setF5(pk, 'vsin', r.f5, seen)) pending.set(pk, pending.get(pk) || { price: false });
  }
  status.vsin = { at: now, checked: now, stamp: v.stamp, date: D.date, games: v.games.length, matched: m.size };
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

// Push changed games, at most once per PUSH_MIN each.
function flush() {
  const D = current();
  if (!D) return;
  const now = Date.now();
  for (const [pk, p] of pending) {
    const last = sentAt.get(pk) || 0;
    if (now - last < PUSH_MIN) continue;
    if (!p.price && !p.live && now - last < SEEN_PUSH) continue;
    pending.delete(pk);
    sentAt.set(pk, now);
    const O = publicOdds(D, pk);
    if (O) ctx.emit('odds', O);
  }
}

function anInterval(games) { return games.some((g) => g.state === 'Preview' || g.state === 'Live') ? EVERY.an : EVERY.anIdle; }

function start(c) {
  ctx = c;
  const anEvery = () => anInterval(dayGames());
  loop('an', pollAN, anEvery)();
  setTimeout(loop('espn', pollEspn, EVERY.espn), 3000);
  setTimeout(loop('pin', pollPin, EVERY.pin), 5000);
  setTimeout(loop('vsin', pollVsin, EVERY.vsin), 8000);
  setTimeout(loop('an1', pollAN1, EVERY.an1), 6000);
  setTimeout(loop('wx', pollWx, EVERY.wx), 11000);
  keys(new Date().getFullYear() - 1); // warm the key-number table in the background
  setInterval(freezeStarted, 5000);
  setInterval(flush, 1000);
  setInterval(() => cur?.save(), 30e3);
}

function saveNow() { try { cur?.save(true); } catch (e) { log('odds save', e.message); } }

// ---------------------------------------------------------------- views
function bookList(D) {
  const fed = new Set();
  for (const G of Object.values(D?.games || {})) for (const k of Object.keys(G.books || {})) fed.add(k);
  if (D?.date === ctx?.today()?.date) for (const row of liveQuotes.values()) for (const key of Object.keys(row.books)) fed.add(key);
  return BOOKS.map(({ key, name, short, nv, sharp, link, ios }) => ({ key, name, short, nv: !!nv, sharp: !!sharp, feed: fed.has(key), site: link || null, ios: ios || null }));
}

// { games, books, moves } for the snapshot (today, or a past day from history).
function snapshot(date) {
  const D = date ? dayFor(date) : current();
  const pks = new Set(Object.keys(D?.games || {}));
  if (D?.date === ctx?.today()?.date) for (const pk of knownLivePks) pks.add(String(pk));
  return { games: Object.fromEntries([...pks].map((pk) => [pk, publicOdds(D, pk)])), books: bookList(D), moves: D ? D.moves() : [] };
}

function forDate(date) {
  return { date, now: Date.now(), ...snapshot(date) };
}

function game(pk) {
  const D = current();
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
  return { status, hosts: health(), liveGames: liveQuotes.size, liveMaxAgeMs: LIVE_MAX_AGE_MS, games: cur ? Object.keys(cur.games).length : 0, date: cur?.date || null };
}

module.exports = { start, snapshot, forDate, game, closeOf, healthInfo, saveNow, keys };
