'use strict';
/* Tickets, one private log per person. Every bet carries its owner's id (a random device id from an HttpOnly cookie,
   see server.js); list, edit, delete and CSV only ever touch the caller's own bets. Bets saved before owners existed
   have no owner: nobody sees them until the app's owner claims them with OWNER_CODE.
   The server grades each leg from the MLB final score (runs) and records closing line value at first pitch.
   Saved to DATA_DIR/bets.json. */

const crypto = require('node:crypto');
const { readJSON, writeJSONAsync, num } = require('./util');

const MARKETS = { ml: ['home', 'away'], rl: ['home', 'away'], t: ['over', 'under'], f5ml: ['home', 'away'], f5rl: ['home', 'away'], f5t: ['over', 'under'] };
const isF5 = (mkt) => mkt.startsWith('f5');

const dec = (o) => (o == null ? null : o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));
const imp = (o) => (o == null ? null : o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100));
const toAmerican = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const money = (v) => Math.round(v * 100) / 100;

let store = readJSON('bets.json', { v: 1, bets: [] });
if (!Array.isArray(store.bets)) store = { v: 1, bets: [] };
const save = () => writeJSONAsync('bets.json', store);

// The owner id never leaves the server: the client gets a short one-way tag of it instead.
const tag = (owner) => (owner ? crypto.createHash('sha256').update(`bbl-owner:${owner}`).digest('hex').slice(0, 12) : null);
const pub = ({ manual, ...b }) => ({ ...b, owner: tag(b.owner), legs: b.legs.map((l) => ({ ...l })) });

const mine = (owner) => (b) => !!owner && b.owner === owner;
const list = (owner) => store.bets.filter(mine(owner)).map(pub);
// Every log at once, grouped by owner: one pass for a whole roomful of devices.
function byOwner() {
  const out = new Map();
  for (const b of store.bets) { if (!b.owner) continue; const l = out.get(b.owner); if (l) l.push(pub(b)); else out.set(b.owner, [pub(b)]); }
  return out;
}
const count = (owner) => store.bets.filter(mine(owner)).length;
const unowned = () => store.bets.filter((b) => !b.owner).length;

// Give every unowned (pre-private) bet to this owner. Returns how many moved.
function claimUnowned(owner) {
  let n = 0;
  for (const b of store.bets) if (!b.owner) { b.owner = owner; n++; }
  if (n) save();
  return n;
}
// Move all of one owner's bets to another (linking a second device to the same log).
function merge(from, to) {
  let n = 0;
  for (const b of store.bets) if (b.owner === from) { b.owner = to; n++; }
  if (n) save();
  return n;
}

// ---------------------------------------------------------------- validation
function cleanLeg(l) {
  const leg = {
    pk: num(l.pk),
    mkt: String(l.mkt || ''),
    side: String(l.side || ''),
    line: num(l.line),
    odds: num(l.odds),
    label: String(l.label || '').slice(0, 80),
    matchup: String(l.matchup || '').slice(0, 80),
    start: l.start ? String(l.start).slice(0, 40) : null,
    state: 'open',
  };
  if (!Number.isInteger(leg.pk) || leg.pk <= 0) throw new Error('Pick a game.');
  if (!MARKETS[leg.mkt]) throw new Error('Pick a market.');
  if (!MARKETS[leg.mkt].includes(leg.side)) throw new Error('Pick a side.');
  if (leg.mkt === 'ml' || leg.mkt === 'f5ml') leg.line = null;
  else if (leg.line == null || Math.abs(leg.line) > 50) throw new Error('Enter the line.');
  if (leg.odds == null || (leg.odds > -100 && leg.odds < 100) || Math.abs(leg.odds) > 100000) throw new Error('Odds look off. Use American odds like -110 or +150.');
  return leg;
}

function create(body, owner) {
  if (!owner) throw new Error('Reload the app and try again.');
  const legs = (Array.isArray(body?.legs) ? body.legs : []).slice(0, 12).map(cleanLeg);
  if (!legs.length) throw new Error('A bet needs at least one pick.');
  const stake = num(body.stake);
  if (stake != null && !(stake >= 0 && stake < 1e7)) throw new Error('Enter how much you risked.');
  const parlayDec = legs.reduce((p, l) => p * dec(l.odds), 1);
  let odds = legs.length === 1 ? legs[0].odds : num(body.odds) ?? toAmerican(parlayDec);
  if (odds == null || (odds > -100 && odds < 100)) odds = toAmerican(parlayDec);
  const bet = {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 10),
    owner,
    created: Date.now(),
    placed: body.placed ? String(body.placed).slice(0, 40) : new Date().toISOString(),
    book: String(body.book || '').slice(0, 30),
    stake: stake > 0 ? stake : null,
    odds,
    note: String(body.note || '').slice(0, 200),
    status: 'open',
    net: null,
    settled: null,
    legs,
  };
  store.bets.unshift(bet);
  if (store.bets.length > 20000) store.bets.length = 20000;
  save();
  return bet;
}

function update(id, body, owner) {
  const b = store.bets.find((x) => x.id === id && mine(owner)(x));
  if (!b) return null;
  if (body.stake !== undefined) {
    const s = num(body.stake);
    if (s == null || s === 0) b.stake = null; else if (s > 0 && s < 1e7) b.stake = s;
    if (b.status !== 'open' && b.status !== 'void') Object.assign(b, settle(b) || {});
  }
  if (body.note != null) b.note = String(body.note).slice(0, 200);
  if (body.book != null) b.book = String(body.book).slice(0, 30);
  if (body.status === 'void') { b.status = 'void'; b.net = 0; b.settled = Date.now(); }
  if (body.status === 'open') { b.status = 'open'; b.net = null; b.settled = null; b.manual = false; for (const l of b.legs) { l.state = 'open'; delete l.final; } }
  if (body.status === 'void') b.manual = true;
  save();
  return b;
}

function remove(id, owner) {
  const i = store.bets.findIndex((x) => x.id === id && mine(owner)(x));
  if (i < 0) return false;
  store.bets.splice(i, 1);
  save();
  return true;
}

// ---------------------------------------------------------------- grading
// Where a leg stands for a score. margin > 0 wins, 0 pushes, < 0 loses.
function legMargin(l, h, a) {
  if (l.mkt === 'ml' || l.mkt === 'f5ml') return l.side === 'home' ? h - a : a - h;
  if (l.mkt === 'rl' || l.mkt === 'f5rl') return (l.side === 'home' ? h - a : a - h) + l.line;
  if (l.mkt === 't' || l.mkt === 'f5t') return l.side === 'over' ? h + a - l.line : l.line - (h + a);
  return null;
}

// g: { state: 'Preview'|'Live'|'Final', detail, home: { score }, away: { score } }
function legResult(l, g) {
  if (/postponed|cancel/i.test(g.detail || '')) return 'void';
  if (g.state !== 'Final' || /suspended/i.test(g.detail || '')) return null;
  // First five innings settles on the first five, and only if all five were played.
  if (isF5(l.mkt)) {
    if (!g.f5) return null;
    if (!g.f5.done) return 'void';
    const m5 = legMargin(l, num(g.f5.h), num(g.f5.a));
    return m5 == null ? null : m5 > 0 ? 'won' : m5 < 0 ? 'lost' : 'push';
  }
  const h = num(g.home?.score), a = num(g.away?.score);
  if (h == null || a == null) return null;
  const m = legMargin(l, h, a);
  if (m == null) return null;
  return m > 0 ? 'won' : m < 0 ? 'lost' : 'push';
}

// A parlay drops push and void legs and pays the rest at their own prices.
function settle(b) {
  const states = b.legs.map((l) => l.state);
  const stake = b.stake || 0;
  if (states.includes('lost')) return { status: 'lost', net: b.stake ? -stake : null };
  if (states.includes('open')) return null;
  const won = b.legs.filter((l) => l.state === 'won');
  if (!won.length) return { status: states.every((s) => s === 'void') ? 'void' : 'push', net: 0 };
  const d = b.legs.length === 1 || won.length === b.legs.length ? dec(b.odds) : won.reduce((p, l) => p * dec(l.odds), 1);
  return { status: 'won', net: b.stake ? money(stake * (d - 1)) : null };
}

// Closing line value for one leg against the frozen consensus close (L shape).
function clvOf(l, close) {
  if (!close) return null;
  if (l.mkt === 'ml') {
    if (close.ml?.[0] == null || close.ml?.[1] == null) return null;
    const [co, other] = l.side === 'home' ? close.ml : [close.ml[1], close.ml[0]];
    return { odds: co, pct: edge(l.odds, co, other) };
  }
  if (l.mkt === 'rl') {
    if (!close.rl || close.rl.line == null) return null;
    const c = l.side === 'home' ? close.rl.line : -close.rl.line;
    const out = { line: c, pts: Math.round((l.line - c) * 10) / 10 };
    const [co, other] = l.side === 'home' ? close.rl.odds : [close.rl.odds[1], close.rl.odds[0]];
    if (out.pts === 0 && co != null && other != null) { out.odds = co; out.pct = edge(l.odds, co, other); }
    return out;
  }
  if (l.mkt === 't') {
    if (!close.t || close.t.line == null) return null;
    const out = { line: close.t.line, pts: Math.round((l.side === 'over' ? close.t.line - l.line : l.line - close.t.line) * 10) / 10 };
    const [co, other] = l.side === 'over' ? close.t.odds : [close.t.odds[1], close.t.odds[0]];
    if (out.pts === 0 && co != null && other != null) { out.odds = co; out.pct = edge(l.odds, co, other); }
    return out;
  }
  return null;
}
// Expected return of the price you got if the no-vig closing price is the truth, in percent.
function edge(mine, close, other) {
  const p = imp(close) / (imp(close) + imp(other));
  return Math.round((dec(mine) * p - 1) * 1000) / 10;
}

// Called as games update. gameOf(pk) -> game or null; closeOf(pk) -> close L or null.
// Returns the set of owners whose bets changed.
function refresh(gameOf, closeOf) {
  const touched = new Set();
  for (const b of store.bets) {
    if (b.status !== 'open' || b.manual) continue;
    let changed = false;
    for (const l of b.legs) {
      const g = gameOf(l.pk);
      if (!g) continue;
      const started = g.state !== 'Preview' && !/postponed|cancel/i.test(g.detail || '');
      if (!l.clv && started) {
        const v = clvOf(l, closeOf(l.pk, l.start));
        if (v) { l.clv = v; changed = true; }
      }
      if (l.state === 'open') {
        const s = legResult(l, g);
        if (s) {
          l.state = s;
          if (s !== 'void') l.final = isF5(l.mkt) && g.f5 ? { h: num(g.f5.h), a: num(g.f5.a), f5: true } : { h: num(g.home.score), a: num(g.away.score) };
          changed = true;
        }
      }
    }
    const r = settle(b);
    if (r) { Object.assign(b, r, { settled: Date.now() }); changed = true; }
    if (changed) touched.add(b.owner);
  }
  if (touched.size) save();
  return touched;
}

// Games that still matter to an open ticket (to grade, or to take CLV).
function openGamePks() {
  return [...new Set(store.bets.filter((b) => b.status === 'open').flatMap((b) => b.legs.filter((l) => l.state === 'open' || !l.clv).map((l) => l.pk)))];
}

function csv(owner) {
  const head = ['placed', 'book', 'type', 'picks', 'odds', 'stake', 'status', 'net', 'clv', 'note'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  // Typed text can't start a spreadsheet formula.
  const t = (v) => (/^[=+\-@\t\r|%]/.test(String(v ?? '')) ? `'${v}` : v ?? '');
  const clv = (b) => {
    if (b.legs.length !== 1 || !b.legs[0].clv) return '';
    const c = b.legs[0].clv;
    return c.pts != null && c.pts !== 0 ? `${c.pts > 0 ? '+' : ''}${c.pts} runs` : c.pct != null ? `${c.pct > 0 ? '+' : ''}${c.pct}%` : '';
  };
  const rows = store.bets.filter(mine(owner)).map((b) => [
    t(b.placed), t(b.book), b.legs.length > 1 ? `${b.legs.length}-leg parlay` : 'straight',
    t(b.legs.map((l) => `${l.label} (${l.matchup})`).join(' + ')), b.odds, b.stake ?? '', b.status, b.net ?? '', t(clv(b)), t(b.note),
  ].map(q).join(','));
  return [head.join(','), ...rows].join('\n');
}

// For tests: swap the store.
function _reset(bets = []) { store = { v: 1, bets }; }

module.exports = { list, byOwner, count, unowned, claimUnowned, merge, create, update, remove, refresh, openGamePks, csv, pub, legResult, legMargin, settle, clvOf, edge, dec, imp, tag, _reset };
