'use strict';
// The next baseball day's slate is priced ahead: pregame only, its own jobs and status, handed to today at the rollover.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-next-day-'));
process.env.DATA_DIR = scratch;
const root = path.resolve(__dirname, '..');
const util = require('../mlb/lib/util');
const evidence = require('../mlb/lib/quote-evidence');
const AN = require('../mlb/lib/action');
const PIN = require('../mlb/lib/pinnacle');
const VSIN = require('../mlb/lib/vsin');
const { OddsDay } = require('../mlb/lib/lines');
const books = require('../mlb/lib/books');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

// Line evidence is judged against the real clock (lib/lines.js runs outside the sandboxed clock), so times are relative.
const NOW = Date.now();
const TODAY = '2026-10-04', NEXT = '2026-10-05', AFTER = '2026-10-06';
const copy = (x) => JSON.parse(JSON.stringify(x));
const iso = (t) => new Date(t).toISOString();
const DODGERS = { full: 'Los Angeles Dodgers', name: 'Dodgers', abbr: 'LAD' }, BRAVES = { full: 'Atlanta Braves', name: 'Braves', abbr: 'ATL' };
const YANKS = { full: 'New York Yankees', name: 'Yankees', abbr: 'NYY' }, RAYS = { full: 'Tampa Bay Rays', name: 'Rays', abbr: 'TB' };
const game = (pk, start, home, away, state = 'Preview', detail = 'Scheduled') => ({ pk, start, state, detail, home, away });
const tonight = () => game(849823, iso(NOW - 2 * 3600e3), DODGERS, BRAVES, 'Live', 'In Progress');
const tomorrow = () => game(849840, iso(NOW + 20 * 3600e3), RAYS, YANKS);

// One Action Network game: the Rays hosting the Yankees, DraftKings prices with a fresh source clock.
function anFeed(start, { live = false, ml = [-125, 105], stamp = NOW - 20000 } = {}) {
  const q = (more) => ({ is_live: live, updated_at: iso(stamp), line_status: 'normal', ...more });
  return { games: [{ id: 9001, home_team_id: 1, away_team_id: 2, start_time: start,
    teams: [{ id: 1, full_name: RAYS.full, abbr: 'TB' }, { id: 2, full_name: YANKS.full, abbr: 'NYY' }],
    markets: { 68: { event: { moneyline: [q({ team_id: 1, odds: ml[0] }), q({ team_id: 2, odds: ml[1] })],
      total: [q({ side: 'over', value: 7.5, odds: -110 }), q({ side: 'under', value: 7.5, odds: -110 })] } } } }] };
}

function engine({ responses = {}, withNext = true } = {}) {
  let now = NOW;
  const calls = {}, dates = {}, events = [], logs = [];
  const day = { date: TODAY, games: new Map([[849823, tonight()]]) };
  const next = { date: NEXT, games: new Map([[849840, tomorrow()]]) };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class MemoryOddsDay extends OddsDay { constructor(date) { super(date); this.games = {}; } save() {} }
  const call = (name, fallback) => async (...args) => {
    calls[name] = (calls[name] || 0) + 1; (dates[name] ||= []).push(args[0]);
    const r = responses[name];
    return typeof r === 'function' ? r(...args) : r ?? fallback;
  };
  const context = vm.createContext({ module: { exports: {} }, process: { env: {} }, Date: Clock, console,
    setTimeout: () => 0, setInterval: () => 0,
    testContext: { today: () => day, next: () => (withNext ? next : null), emit: (type, data) => events.push({ type, data: copy(data) }) },
    require(id) {
      if (id === '../../shared/bet-links') return require('../shared/bet-links');
      if (id === './util') return { ...util, log: (...a) => logs.push(a.join(' ')) };
      if (id === './quote-evidence') return evidence;
      if (id === './lines') return { OddsDay: MemoryOddsDay };
      if (id === './books') return books;
      if (id === './action') return { ...AN, fetchAN: call('an', { games: [] }), fetchAN1: call('an1', { games: [] }) };
      if (id === './pinnacle') return { ...PIN, fetchPinnacle: call('pin', []) };
      if (id === './espn') return { ...require('../mlb/lib/espn'), fetchEspn: call('espn', { events: [] }) };
      if (id === './vsin') return { ...VSIN, fetchVsin: call('vsin', { games: [], stamp: null }) };
      if (id === './keys') return { keys() {} };
      if (id.startsWith('./')) return {};
      return require(id);
    } });
  vm.runInContext(fs.readFileSync(path.join(root, 'mlb/lib/odds.js'), 'utf8'), context);
  vm.runInContext('ctx = testContext; current()', context);   // as start() does: today's day first
  return { context, day, next, calls, dates, events, logs, responses, api: context.module.exports,
    run: (code) => vm.runInContext(code, context), tick: (ms) => { now += ms; }, now: () => now };
}

test('the next day is polled for its own date and its prices reach the board, the game sheet and the push', async () => {
  const E = engine({ responses: { an: (date) => (date === NEXT ? anFeed(tomorrow().start) : { games: [] }) } });
  await E.run("runSource('an', NEXT)");
  assert.deepEqual(E.dates.an, [NEXT], 'the next-day job asks Action Network for the next date');
  const board = E.api.forDate(NEXT);
  const O = board.games[849840];
  assert.deepEqual(O.books.dk.ml, [-125, 105]);
  assert.equal(O.books.dk.quote_meta.ml.home.actionable, true, 'same evidence rules as today: a fresh source clock is usable');
  assert.deepEqual(copy(O.live), {}, 'the next day never carries in-play quotes');
  assert.equal(board.sources.an.state, 'ok', 'the next day has its own source status, not the historical empty one');
  assert.equal(board.sources.an.date, NEXT);
  assert.notEqual(board.refresh.result, 'historical');
  assert.equal(board.coverage.active_games, 1);
  assert.deepEqual(E.api.game(849840).odds.books.dk.ml, [-125, 105], 'the game sheet (/api/odds/:pk) finds tomorrow’s game');
  assert.deepEqual(copy(E.api.snapshot().next), { date: NEXT, games: 1, priced: 1 }, "today's odds say how much of tomorrow is priced");
  assert.equal(E.api.snapshot().games[849840], undefined, "tomorrow's game stays out of today's board");
  E.run('flush()');
  const pushed = E.events.filter((ev) => ev.type === 'odds' && ev.data.pk === 849840);
  assert.equal(pushed.length, 1); assert.deepEqual(pushed[0].data.books.dk.ml, [-125, 105]);
  const status = E.events.filter((ev) => ev.type === 'odds_status' && ev.data.date === NEXT);
  assert.ok(status.length, 'its status is published under its own date');
  assert.deepEqual(status.at(-1).data.next, { date: NEXT, games: 1, priced: 1 }, 'and says how much of the slate is priced');
});

test('explicit live rows for a next-day game are ignored and nothing freezes a close for it', async () => {
  const E = engine({ responses: { an: anFeed(tomorrow().start, { live: true }) } });
  await E.run("runSource('an', NEXT)");
  const O = E.api.forDate(NEXT).games[849840];
  assert.equal(O, undefined, 'live-only rows never create pregame history');
  E.run('freezeStarted()');
  assert.equal(E.api.closeOf(849840), null);
});

test('without a next day model nothing extra is polled and today is unchanged', async () => {
  const E = engine({ withNext: false, responses: { an: anFeed(tonight().start) } });
  assert.equal(E.run("runSource('an', NEXT)"), null);
  E.run('tickSources()'); await Promise.resolve();
  assert.deepEqual(E.dates.an, [TODAY], 'only today is asked for');
  assert.equal(E.api.snapshot().next, null);
  assert.equal(E.api.requestRefresh(NEXT).result, 'historical');
});

test('at the rollover the next day becomes today with its prices and opener intact, and the following day starts fresh', async () => {
  const E = engine({ responses: { an: (date) => (date === NEXT ? anFeed(tomorrow().start) : { games: [] }) } });
  await E.run("runSource('an', NEXT)");
  const ahead = E.run('nxt');
  assert.ok(ahead.has(849840));
  const opener = copy(ahead.games[849840].open);
  assert.ok(opener, 'the first fresh price observed tonight is the recorded opener');
  // 6 AM ET: the server's day model moves on.
  E.tick(8 * 3600e3);
  E.day.date = NEXT; E.day.games = new Map([[849840, tomorrow()]]);
  E.next.date = AFTER; E.next.games = new Map();
  assert.equal(E.run('current()'), ahead, 'the same line history carries on as today');
  assert.deepEqual(copy(E.run('current()').games[849840].open), opener);
  assert.equal(E.run('nextCurrent()').date, AFTER);
  assert.equal(E.run('nextCurrent()').has(849840), false);
  assert.deepEqual(E.api.snapshot().games[849840].books.dk.ml, [-125, 105]);
});

test('a next-day response crossing the rollover is discarded', async () => {
  let finish;
  const E = engine({ responses: { an: (date) => (date === NEXT ? new Promise((resolve) => { finish = resolve; }) : { games: [] }) } });
  const work = E.run("runSource('an', NEXT)"); await Promise.resolve(); await Promise.resolve();
  E.day.date = NEXT; E.day.games = new Map([[849840, tomorrow()]]);
  E.next.date = AFTER; E.next.games = new Map();
  finish(anFeed(tomorrow().start)); await work;
  assert.equal(E.run('current()').has(849840), false, 'the old next-day promise cannot write into the new days');
  assert.equal(E.run('nextCurrent()').has(849840), false);
});

test('Pinnacle and VSiN answer both days with one request and keep its receipt time', async () => {
  const E = engine({ responses: { pin: [], vsin: { games: [], stamp: null } } });
  E.day.games.set(849830, game(849830, iso(NOW + 3600e3), DODGERS, BRAVES));   // a late game still to start today
  const fetchedAt = E.now();
  await E.run("runSource('pin')"); await E.run("runSource('vsin')");
  E.tick(30000);
  await E.run("runSource('pin', NEXT)"); await E.run("runSource('vsin', NEXT)");
  assert.equal(E.calls.pin, 1); assert.equal(E.calls.vsin, 1);
  assert.equal(E.api.forDate(NEXT).sources.pin.checked_at, fetchedAt, 'the shared response keeps the time it was actually received');
  E.tick(120000);
  await E.run("runSource('pin', NEXT)");
  assert.equal(E.calls.pin, 2, 'an old shared response is not reused');
});

test('a failed shared request is not reused by the other day', async () => {
  let fail = true;
  const E = engine({ responses: { pin: () => { if (fail) throw new Error('HTTP 503'); return []; } } });
  E.day.games.set(849830, game(849830, iso(NOW + 3600e3), DODGERS, BRAVES));
  await E.run("runSource('pin')");
  fail = false;
  await E.run("runSource('pin', NEXT)");
  assert.equal(E.calls.pin, 2);
  assert.equal(E.api.forDate(NEXT).sources.pin.state, 'ok');
});

test('the next day has its own manual refresh; past days stay read-only', async () => {
  const E = engine({ responses: { an: (date) => (date === NEXT ? anFeed(tomorrow().start) : { games: [] }) } });
  const r = E.api.requestRefresh(NEXT);
  assert.equal(r.result, 'running');
  await E.run('Promise.all([...nextJobs.values()].map((job) => job.promise).filter(Boolean))'); await Promise.resolve();
  assert.equal(E.api.forDate(NEXT).refresh.result, 'complete');
  assert.ok(E.dates.an.includes(NEXT));
  assert.equal(E.api.forDate(TODAY).refresh.result, null, "today's refresh state is untouched");
  assert.equal(E.api.requestRefresh('2026-10-01').result, 'historical');
});

test('a postponed game listed on both days is priced and shown on the day it is actually scheduled', async () => {
  const moved = game(849840, iso(NOW - 3 * 3600e3), RAYS, YANKS, 'Preview', 'Postponed');
  const E = engine({ responses: { an: (date) => (date === NEXT ? anFeed(tomorrow().start) : { games: [] }) } });
  E.day.games.set(849840, moved);
  await E.run("runSource('an')"); await E.run("runSource('an', NEXT)");
  assert.equal(E.run('current()').has(849840), false, 'a postponed game takes no prices today');
  assert.equal(E.run('oddsDayFor(849840)'), E.run('nxt'));
  assert.deepEqual(E.api.game(849840).odds.books.dk.ml, [-125, 105]);
});

test('the half-hourly summary line names each feed, live coverage and how much of the next day is priced', async () => {
  const E = engine({ responses: { an: (date) => (date === NEXT ? anFeed(tomorrow().start) : { games: [] }) } });
  await E.run("runSource('an')"); await E.run("runSource('an', NEXT)");
  E.run('logSummary()');
  const line = E.logs.find((l) => l.startsWith('odds summary'));
  assert.ok(line, 'a summary line is logged');
  assert.match(line, new RegExp(`^odds summary ${TODAY} an:ok/0 `));
  assert.match(line, /in play 1, live quotes 0/);
  assert.match(line, new RegExp(`next ${NEXT}: 1/1 priced, an:ok/1 `));
  assert.doesNotMatch(line, /-125|105/, 'counts only, never prices');
});
