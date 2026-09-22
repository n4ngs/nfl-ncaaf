'use strict';
/* Tickets, one private log per person. Every bet carries its owner's id (a random device id from a secure cookie,
   see server.js); the list, edits, deletes and CSV only ever touch the caller's own bets. Bets saved before owners
   existed have no owner: nobody sees them until the app's owner claims them with OWNER_CODE.
   The server grades every leg the moment its game goes final and records closing line value at kickoff. */

const crypto = require('node:crypto');
const { readJSON, writeJSON, num } = require('./util');
const { BOOKS } = require('./books');
let integrityStore = null, integrityGameOf = () => null;
function configureIntegrity(store, gameOf) { integrityStore = store; integrityGameOf = gameOf; }
function bookKey(value) {
  const text = String(value || '').trim().toLowerCase();
  return BOOKS.find((b) => [b.key, b.name, b.short].some((v) => v.toLowerCase() === text))?.key || null;
}
function entryFor(b, l) {
  return l.entry_record || { entry_id: b.id + ':' + b.legs.indexOf(l), canonical_event_id: l.gid,
    market_type: l.mkt, selection: l.side, team: l.team, sportsbook: bookKey(b.book),
    entry_created_at: b.placed, line_value: l.line, american_odds: l.odds,
    entry_snapshot_id: null, entry_kind: 'bet', historical: true };
}
function legIntegrity(b, l) {
  const entry = entryFor(b, l);
  const g = integrityGameOf(l.gid) || { id: l.gid, start: l.start };
  if (integrityStore) return integrityStore.evaluateEntry(entry, g);
  return { eligibility_status: 'MISSING_ENTRY_SNAPSHOT', status: 'MISSING_ENTRY_SNAPSHOT',
    reason_code: 'NO_IMMUTABLE_ENTRY_SNAPSHOT', line_clv_points: null,
    clv_fair_probability_pp: null, clv_ev_pct: null, entry: null, close: null };
}
// A read projection reclassifies legacy CLV without rewriting the original ticket or raw scalar.
function present(b) { return { ...b, legs: b.legs.map((l) => {
  const { clv, ...leg } = l;
  return { ...leg, integrity: legIntegrity(b, l) };
}) }; }

const MARKETS = new Set(['s', 't', 'ml', 'h1s', 'h1t', 'tt']);
const SIDES = new Set(['home', 'away', 'over', 'under']);

const dec = (o) => (o == null ? null : o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));
const imp = (o) => (o == null ? null : o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100));
const toAmerican = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

let store = readJSON('bets.json', { v: 1, bets: [] });
const save = () => writeJSON('bets.json', store);
const mine = (owner) => (b) => !!owner && b.owner === owner;
const list = (owner) => store.bets.filter(mine(owner)).map(present);
// Everyone who owns at least one bet (the server pushes each of them their own list).
const owners = () => new Set(store.bets.map((b) => b.owner).filter(Boolean));
// Every log at once, grouped by owner: one pass for a whole roomful of connected devices.
function byOwner() {
  const out = new Map();
  for (const b of store.bets) { if (!b.owner) continue; const l = out.get(b.owner); if (l) l.push(present(b)); else out.set(b.owner, [present(b)]); }
  return out;
}
const unowned = () => store.bets.filter((b) => !b.owner).length;
// Give every unowned (pre-accounts) bet to this owner. Returns how many moved.
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
    gid: String(l.gid || ''),
    mkt: String(l.mkt || ''),
    side: String(l.side || ''),
    team: l.team === 'home' || l.team === 'away' ? l.team : null,
    line: num(l.line),
    odds: num(l.odds),
    label: String(l.label || '').slice(0, 80),
    matchup: String(l.matchup || '').slice(0, 80),
    start: l.start ? String(l.start) : null,
    state: 'open',
    entry_snapshot_id: typeof l.entry_snapshot_id === 'string' ? l.entry_snapshot_id.slice(0, 160) : null,
  };
  if (!/^\d+$/.test(leg.gid)) throw new Error('Pick a game.');
  if (!MARKETS.has(leg.mkt)) throw new Error('Pick a market.');
  if (!SIDES.has(leg.side)) throw new Error('Pick a side.');
  if (leg.mkt !== 'ml' && !Number.isFinite(leg.line)) throw new Error('Enter the line.');
  if (leg.mkt === 'tt' && !leg.team) throw new Error('Pick the team for the team total.');
  if (!Number.isFinite(leg.odds) || (leg.odds > -100 && leg.odds < 100)) throw new Error('Odds look off. Use American odds like -110 or +150.');
  const teamSide = ['s', 'h1s', 'ml'].includes(leg.mkt);
  if (!(teamSide ? ['home', 'away'] : ['over', 'under']).includes(leg.side)) throw new Error('The selection does not match the market.');
  return leg;
}

function create(body, owner) {
  if (!owner) throw new Error('Reload the app and try again.');
  const legs = (Array.isArray(body.legs) ? body.legs : []).slice(0, 12).map(cleanLeg);
  if (!legs.length) throw new Error('A bet needs at least one pick.');
  const stake = num(body.stake);
  if (!(stake > 0) || !Number.isFinite(stake)) throw new Error('Enter how much you risked.');
  const parlayDec = legs.reduce((p, l) => p * dec(l.odds), 1);
  const odds = legs.length === 1 ? legs[0].odds : num(body.odds) ?? toAmerican(parlayDec);
  const now = Date.now();
  const supplied = body.placed != null && body.placed !== '';
  if (supplied && (typeof body.placed !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(body.placed))) throw new Error('Bet time must include a timezone.');
  const placedMs = supplied ? Date.parse(body.placed) : now;
  if (!Number.isFinite(placedMs) || placedMs > now) throw new Error('Enter a valid bet time that is not in the future.');
  const bet = {
    id: crypto.randomUUID().slice(0, 8),
    owner,
    created: now,
    placed: new Date(placedMs).toISOString(),
    placed_basis: supplied ? 'USER_REPORTED_WAGER_TIME' : 'RECORDED_AT',
    book: String(body.book || '').slice(0, 30),
    stake,
    odds,
    note: String(body.note || '').slice(0, 200),
    legs,
    status: 'open',
    net: null,
    settled: null,
  };
  for (const [index, leg] of legs.entries()) {
    const entry = { entry_id: bet.id + ':' + index, bet_id: bet.id, leg_index: index, entry_kind: 'bet',
      canonical_event_id: leg.gid, market_type: leg.mkt, selection: leg.side, team: leg.team,
      sportsbook: bookKey(bet.book), entry_created_at: bet.placed, recorded_at: new Date(now).toISOString(),
      timestamp_basis: bet.placed_basis, line_value: leg.line, american_odds: leg.odds,
      entry_snapshot_id: leg.entry_snapshot_id };
    const game = integrityGameOf(leg.gid) || { id: leg.gid, start: leg.start };
    const quote = integrityStore?.findEntry(entry, game);
    entry.entry_snapshot_id = quote?.snapshot_id || null;
    if (!quote && leg.entry_snapshot_id) entry.rejected_snapshot_id = leg.entry_snapshot_id;
    leg.entry_snapshot_id = entry.entry_snapshot_id;
    leg.entry_record = integrityStore?.recordEntry ? integrityStore.recordEntry(entry) : entry;
  }
  store.bets.unshift(bet);
  save();
  return present(bet);
}

function update(id, body, owner) {
  const b = store.bets.find((x) => x.id === id && mine(owner)(x));
  if (!b) return null;
  if (body.stake != null && num(body.stake) > 0) b.stake = num(body.stake);
  if (body.note != null) b.note = String(body.note).slice(0, 200);
  if (body.book != null) b.book = String(body.book).slice(0, 30);
  if (body.status === 'void' || body.status === 'open') { b.status = body.status; b.net = body.status === 'void' ? 0 : null; b.settled = body.status === 'void' ? Date.now() : null; if (body.status === 'open') for (const l of b.legs) l.state = 'open'; }
  save();
  return present(b);
}

// Every bet belonging to one device, in one go. Used when the board's owner clears a person.
function removeOwner(owner) {
  if (!owner) return 0;
  const n = store.bets.length;
  store.bets = store.bets.filter((x) => x.owner !== owner);
  const gone = n - store.bets.length;
  if (gone) save();
  return gone;
}
function remove(id, owner) {
  const n = store.bets.length;
  store.bets = store.bets.filter((x) => !(x.id === id && mine(owner)(x)));
  if (store.bets.length !== n) save();
  return store.bets.length !== n;
}

// ---------------------------------------------------------------- grading
const pts = (t, half) => (half ? (t.q?.[0] ?? 0) + (t.q?.[1] ?? 0) : t.score ?? 0);

// Where a leg stands right now. margin > 0 is winning, 0 is a push, < 0 is losing.
function legMargin(l, g) {
  const half = l.mkt === 'h1s' || l.mkt === 'h1t';
  const h = pts(g.home, half), a = pts(g.away, half);
  if (l.mkt === 's' || l.mkt === 'h1s') return (l.side === 'home' ? h - a : a - h) + l.line;
  if (l.mkt === 'ml') return l.side === 'home' ? h - a : a - h;
  if (l.mkt === 't' || l.mkt === 'h1t') return l.side === 'over' ? h + a - l.line : l.line - (h + a);
  if (l.mkt === 'tt') { const s = pts(g[l.team], false); return l.side === 'over' ? s - l.line : l.line - s; }
  return null;
}

function legDone(l, g) {
  if (g.state === 'off') return 'void';
  const half = l.mkt === 'h1s' || l.mkt === 'h1t';
  const done = g.final || (half && (g.period > 2 || (g.period === 2 && g.half)));
  if (!done) return null;
  const m = legMargin(l, g);
  if (m == null) return null;
  // Moneyline ties (rare, but overtime can't end tied in college) grade as a push.
  return m > 0 ? 'won' : m < 0 ? 'lost' : 'push';
}

function settle(b) {
  const states = b.legs.map((l) => l.state);
  if (states.includes('lost')) return { status: 'lost', net: -b.stake };
  if (states.includes('open')) return null;
  const live = b.legs.filter((l) => l.state === 'won');
  if (!live.length) return { status: states.every((s) => s === 'void') ? 'void' : 'push', net: 0 };
  // A pushed or voided leg drops out of a parlay; the rest pay at their own prices.
  const d = b.legs.length === 1 ? dec(b.odds) : b.legs.every((l) => l.state === 'won') ? dec(b.odds) : live.reduce((p, l) => p * dec(l.odds), 1);
  return { status: 'won', net: Math.round(b.stake * (d - 1) * 100) / 100 };
}

// CLV is resolved from immutable provenance in the read projection above.

// Called whenever games update. Returns true if anything changed.
function refresh(gameOf, _legacyCloseOf) {
  let changed = false;
  for (const b of store.bets) {
    if (b.status !== 'open') continue;
    for (const l of b.legs) {
      const g = gameOf(l.gid);
      if (!g) continue;
      if (l.state === 'open') {
        const s = legDone(l, g);
        if (s) { l.state = s; l.final = { h: g.home.score, a: g.away.score }; changed = true; }
      }
    }
    const r = settle(b);
    if (r) { Object.assign(b, r, { settled: Date.now() }); changed = true; }
  }
  if (changed) save();
  return changed;
}

function openGameIds() {
  return [...new Set(store.bets.filter((b) => b.status === 'open').flatMap((b) => b.legs.filter((l) => l.state === 'open').map((l) => l.gid)))];
}

function csv(owner) {
  const head = ['placed', 'book', 'type', 'picks', 'odds', 'stake', 'status', 'net', 'clv_status', 'line_clv_points', 'clv_fair_probability_pp', 'clv_ev_pct', 'price_clv_status', 'entry_snapshot_id', 'close_snapshot_id', 'kickoff_basis', 'clv_reason', 'note'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  // Typed text can't start a spreadsheet formula.
  const t = (v) => (/^[=+\-@\t\r]/.test(String(v ?? '')) ? `'${v}` : v);
  const rows = list(owner).map((b) => [
    b.placed, t(b.book), b.legs.length > 1 ? `${b.legs.length}-leg parlay` : 'straight',
    t(b.legs.map((l) => `${l.label} (${l.matchup})`).join(' + ')), b.odds, b.stake, b.status, b.net ?? '',
    ...['eligibility_status', 'line_clv_points', 'clv_fair_probability_pp', 'clv_ev_pct', 'price_clv_status'].map((k) => b.legs.length === 1 ? b.legs[0].integrity?.[k] ?? '' : ''),
    b.legs.length === 1 ? b.legs[0].entry_snapshot_id ?? '' : '',
    b.legs.length === 1 ? b.legs[0].integrity?.close?.snapshot_id ?? '' : '',
    b.legs.length === 1 ? b.legs[0].integrity?.resolution?.kickoff_basis ?? '' : '',
    b.legs.length === 1 ? b.legs[0].integrity?.reason_code ?? '' : '', t(b.note),
  ].map(q).join(','));
  return [head.join(','), ...rows].join('\n');
}

module.exports = {
  configureIntegrity, byOwner, list, owners, unowned, claimUnowned, merge, create, update, remove, removeOwner, refresh, openGameIds, csv, legMargin, dec, imp };
