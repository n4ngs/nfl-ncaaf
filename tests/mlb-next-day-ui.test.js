'use strict';
// Once today has nothing left to bet pregame, the odds board points at the next day's slate (priced ahead).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../mlb/public/js/odds.js'), 'utf8');
const NOW = Date.parse('2026-10-05T02:30:00Z');
function harness() {
  const nodes = new Map(), saved = new Map(), listeners = {};
  const c = { console, Map, Set, Date, AbortController, CSS: { escape: String },
    store: { get: (k, d) => saved.has(k) ? saved.get(k) : d, set: (k, v) => saved.set(k, v) },
    S: { games: new Map(), date: '2026-10-04', today: '2026-10-04', isToday: true, tab: 'odds' },
    serverNow: () => NOW, isOff: (g) => !!g.off, isDesk: () => true, chartW: () => 600,
    esc: (v) => String(v ?? '').replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x])),
    timeLabel: () => '7:10 PM', gameStatus: (g) => g.state, logo: () => '<img alt="">', ICON: { chev: '<svg></svg>' },
    dayLabel: (d) => `Day ${d}`,
    $: (s) => nodes.get(s) || null, clamp: (n, a, b) => Math.max(a, Math.min(b, n)),
    document: { addEventListener: (k, fn) => (listeners[k] ||= []).push(fn), getElementById: (k) => nodes.get('#' + k) || null, querySelectorAll: () => [], hidden: false },
    fetch: async () => ({ ok: true, json: async () => ({}) }), requestAnimationFrame: () => 1, setInterval: () => 1, setTimeout: () => 1, clearTimeout: () => {},
  };
  vm.createContext(c); vm.runInContext(source + '\nglobalThis.state = ODDS;', c);
  c.state.keys = {};
  c.fire = (type, detail) => (listeners[type] || []).forEach((fn) => fn({ detail }));
  return c;
}
const team = (id, name, abbr) => ({ id, name, abbr });
const final = { pk: 1, state: 'Final', start: '2026-10-04T19:38:00Z', away: team(1, 'San Diego Padres', 'SD'), home: team(2, 'Milwaukee Brewers', 'MIL') };
const live = { pk: 2, state: 'Live', detail: 'In Progress', start: '2026-10-05T00:38:00Z', away: team(3, 'Atlanta Braves', 'ATL'), home: team(4, 'Los Angeles Dodgers', 'LAD') };
const later = { pk: 3, state: 'Preview', start: '2026-10-05T03:10:00Z', away: team(5, 'New York Yankees', 'NYY'), home: team(6, 'Tampa Bay Rays', 'TB') };

test('today’s odds carry the next slate; other days’ odds never overwrite it', () => {
  const c = harness();
  c.oddsLoad({ games: {}, books: [], next: { date: '2026-10-05', games: 4, priced: 4 } });
  assert.deepEqual({ ...c.state.next }, { date: '2026-10-05', games: 4, priced: 4 });
  c.oddsLoad({ date: '2026-10-05', games: {}, books: [] });
  assert.equal(c.state.next.date, '2026-10-05', 'a payload without `next` leaves it alone');
  c.oddsLoad({ games: {}, books: [], next: null });
  assert.equal(c.state.next, null);
  c.fire('bbl:odds_status', { date: '2026-10-04', sources: {}, coverage: {}, refresh: {}, next: { date: '2026-10-05', games: 4, priced: 2 } });
  assert.equal(c.state.next.priced, 2, 'status pushes keep the count current between snapshots');
  c.fire('bbl:odds_status', { date: '2026-10-03', sources: {}, coverage: {}, refresh: {} });
  assert.equal(c.state.next.priced, 2);
});

test('with every game under way or final, the board points at the next day with how much of it is priced', () => {
  const c = harness();
  c.S.games.set(1, final); c.S.games.set(2, live);
  c.state.next = { date: '2026-10-05', games: 4, priced: 4 };
  let html = c.oddsViewHTML();
  assert.match(html, /Next up · Day 2026-10-05/);
  assert.match(html, /4 games priced/);
  assert.match(html, /data-day="2026-10-05" data-to="odds"/);
  c.state.next = { date: '2026-10-05', games: 4, priced: 1 };
  assert.match(c.oddsViewHTML(), /1 of 4 games priced/);
  c.state.next = { date: '2026-10-05', games: 1, priced: 0 };
  assert.match(c.oddsViewHTML(), /1 game · lines not posted yet/);
});

test('no prompt while today still has a game to bet pregame, on another day, or with no next slate', () => {
  const c = harness();
  c.S.games.set(1, final); c.S.games.set(3, later);
  c.state.next = { date: '2026-10-05', games: 4, priced: 4 };
  assert.doesNotMatch(c.oddsViewHTML(), /Next up/, 'a game still to start today comes first');
  c.S.games.delete(3);
  c.S.isToday = false; c.S.date = '2026-10-03';
  assert.doesNotMatch(c.oddsViewHTML(), /Next up/);
  c.S.isToday = true; c.S.date = '2026-10-04';
  c.state.next = { date: '2026-10-05', games: 0, priced: 0 };
  assert.doesNotMatch(c.oddsViewHTML(), /Next up/, 'an off day tomorrow has nothing to point at');
});

test('an off day today still points at the next slate', () => {
  const c = harness();
  c.state.next = { date: '2026-10-05', games: 2, priced: 2 };
  const html = c.oddsViewHTML();
  assert.match(html, /No games today/);
  assert.match(html, /Next up · Day 2026-10-05/);
});

test('price comparisons are offered on the next day’s board too', () => {
  const c = harness();
  c.state.next = { date: '2026-10-05', games: 1, priced: 1 };
  c.S.isToday = false; c.S.date = '2026-10-05'; c.S.games.set(3, { ...later, start: '2026-10-05T22:08:00Z' });
  let called = 0; c.oddsEdgeEntry = () => { called++; return '<i data-edge-entry></i>'; };
  assert.match(c.oddsViewHTML(), /data-edge-entry/);
  c.S.date = '2026-10-03';
  assert.doesNotMatch(c.oddsViewHTML(), /data-edge-entry/, 'historical days still have none');
  assert.equal(called, 1);
});
