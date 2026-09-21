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
const SEEN_PUSH = 2 * 60e3; // re-push a game whose prices held but whose `seen` moved on, this often

let ctx = null;             // { today: () => Day|null, emit(type, data) }
let cur = null;             // OddsDay for today
const past = new Map();     // date -> OddsDay (read from disk)
const status = { an: {}, an1: {}, pin: {}, espn: {}, vsin: {}, wx: {} };
const pending = new Map();  // pk -> { price: bool }
const sentAt = new Map();   // pk -> ms
let anOnce = false;

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

// ---------------------------------------------------------------- sources
async function pollAN() {
  const D = current();
  if (!D) return;
  const games = dayGames();
  if (!games.length) return;
  const j = await AN.fetchAN(D.date);
  const now = Date.now();
  const parsed = AN.parseAN(j, games);
  const byPk = new Map(games.map((g) => [g.pk, g]));
  for (const [pk, p] of parsed) {
    const g = byPk.get(pk);
    if (!g) continue;
    if (openFor(D, g, 'an')) apply(D, pk, 'an', p.books, now);
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
    if (!p.price && now - last < SEEN_PUSH) continue;
    pending.delete(pk);
    sentAt.set(pk, now);
    const O = D.pub(pk);
    if (O) ctx.emit('odds', O);
  }
}

function start(c) {
  ctx = c;
  const anEvery = () => (dayGames().some((g) => g.state === 'Preview') ? EVERY.an : EVERY.anIdle);
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
  return BOOKS.map(({ key, name, short, nv, sharp, link, ios }) => ({ key, name, short, nv: !!nv, sharp: !!sharp, feed: fed.has(key), site: link || null, ios: ios || null }));
}

// { games, books, moves } for the snapshot (today, or a past day from history).
function snapshot(date) {
  const D = date ? dayFor(date) : current();
  return { games: D ? D.all() : {}, books: bookList(D), moves: D ? D.moves() : [] };
}

function forDate(date) {
  return { date, now: Date.now(), ...snapshot(date) };
}

function game(pk) {
  const D = current();
  if (D?.has(pk)) return { odds: D.pub(pk), hist: D.full(pk) };
  for (const P of past.values()) if (P.has(pk)) return { odds: P.pub(pk), hist: P.full(pk) };
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
  return { status, hosts: health(), games: cur ? Object.keys(cur.games).length : 0, date: cur?.date || null };
}

module.exports = { start, snapshot, forDate, game, closeOf, healthInfo, saveNow, keys };
