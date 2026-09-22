'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-live-odds-'));
process.env.DATA_DIR = scratch;
const util = require('../mlb/lib/util');
const AN = require('../mlb/lib/action');
const { OddsDay } = require('../mlb/lib/lines');
const books = require('../mlb/lib/books');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const NOW = Date.parse('2026-09-22T02:00:00Z');
const copy = (x) => JSON.parse(JSON.stringify(x));
const q = (more = {}) => ({ is_live: true, period: 'event', updated_at: new Date(NOW - 5000).toISOString(), odds: -110, ...more });
const game = (state = 'Live') => ({ pk: 123, start: '2026-09-22T01:00:00Z', state,
  home: { full: 'Los Angeles Dodgers', name: 'Dodgers', abbr: 'LAD' },
  away: { full: 'San Francisco Giants', name: 'Giants', abbr: 'SF' } });
const market = (more = {}) => ({ moneyline: [q({ team_id: 1, odds: -140 }), q({ team_id: 2, odds: 120 })],
  spread: [q({ team_id: 1, value: -2.5 }), q({ team_id: 2, value: 2.5 })],
  total: [q({ side: 'over', value: 7.5 }), q({ side: 'under', value: 7.5 })], ...more });
function feed(ev = market(), swap = false) {
  return { games: [{ id: 777, home_team_id: swap ? 2 : 1, away_team_id: swap ? 1 : 2,
    start_time: game().start, teams: [{ id: 1, full_name: game().home.full, abbr: 'LAD' }, { id: 2, full_name: game().away.full, abbr: 'SF' }],
    markets: { 68: { event: ev } } }] };
}
function engine(initial = feed()) {
  let now = NOW, response = initial;
  const events = [], day = { date: '2026-09-21', games: new Map([[123, game()]]) };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ module: { exports: {} }, process: { env: {} }, Date: Clock,
    console, setTimeout: () => 0, setInterval: () => 0,
    testContext: { today: () => day, emit: (type, data) => events.push({ type, data: copy(data) }) },
    require(id) {
      if (id === './util') return { ...util, log: () => {} };
      if (id === './lines') return { OddsDay };
      if (id === './books') return books;
      if (id === './action') return { ...AN, fetchAN: async () => typeof response === 'function' ? response() : response };
      if (id === './keys') return { keys: () => {} };
      if (id.startsWith('./')) return {};
      return require(id);
    } });
  vm.runInContext(fs.readFileSync(path.join(root, 'mlb/lib/odds.js'), 'utf8'), context);
  vm.runInContext('ctx = testContext', context);
  return { context, day, events, exports: context.module.exports, run: (code) => vm.runInContext(code, context),
    tick: (ms) => { now += ms; }, setResponse: (r) => { response = r; } };
}

test('Action keeps explicit live rows apart from pregame and never offers the opener live', () => {
  const ev = market({ moneyline: [...market().moneyline, q({ is_live: false, team_id: 1, odds: -115 }), q({ is_live: false, team_id: 2, odds: -105 }), q({ is_live: 'true', team_id: 1, odds: -999 })] });
  const f = feed(ev); f.games[0].markets[30] = { event: ev };
  const parsed = AN.parseAN(f, [game()]).get(123);
  assert.deepEqual(parsed.books.dk.ml, [-115, -105]);
  assert.deepEqual(parsed.live.dk.ml, [-140, 120]);
  assert.equal(parsed.live.open, undefined);
  assert.equal(parsed.live.dk.rl.line, -2.5);
  assert.equal(parsed.live.dk.provider_event_id, 777);
});

test('Action orients reversed teams and their individual source lines together', () => {
  const parsed = AN.parseAN(feed(market(), true), [game()]).get(123);
  assert.equal(parsed.swap, true);
  assert.deepEqual(parsed.live.dk.ml, [-140, 120]);
  assert.equal(parsed.live.dk.rl.line, -2.5);
  assert.equal(parsed.live.dk.quote_meta.rl.home.line_value, -2.5);
  assert.equal(parsed.live.dk.quote_meta.rl.away.line_value, 2.5);
});

test('live parser preserves one-sided suspended and removed observations with no price', () => {
  const L = AN.readMarkets({ moneyline: [q({ team_id: 1, odds: null, status: 'suspended' })],
    total: [q({ side: 'under', odds: null, value: null, status: 'removed' })] }, 1, 2, true);
  assert.equal(L.quote_meta.ml.home.market_status, 'suspended');
  assert.equal(L.quote_meta.ml.away, undefined);
  assert.equal(L.quote_meta.t.under.market_status, 'removed');
  assert.deepEqual(L.ml, [null, null]);
});

test('conflicting per-side lines and duplicate prices remain conflicted', () => {
  const L = AN.readMarkets(market({ moneyline: [q({ team_id: 1, odds: -110 }), q({ team_id: 1, odds: -115 }), q({ team_id: 1, odds: -115 })],
    total: [q({ side: 'over', value: 7.5 }), q({ side: 'under', value: 8.5 })] }), 1, 2, true);
  assert.equal(L.quote_meta.ml.home.conflicted, true);
  assert.equal(L.quote_meta.t.over.conflicted, true);
  assert.equal(L.quote_meta.t.under.conflicted, true);
  const oddClock = AN.readMarkets({ moneyline: [q({ team_id: 1, updated_at: 1e30 })] }, 1, 2, true);
  assert.equal(oddClock.quote_meta.ml.home.source_observed_at, null);
});

test('public live quotes age at read time and source timestamps never become receipt timestamps', async () => {
  const E = engine(); await E.run('pollAN()');
  let O = E.exports.snapshot().games[123];
  assert.equal(O.live.dk.quote_meta.ml.home.freshness, 'FRESH');
  assert.equal(O.live.dk.quote_meta.ml.home.actionable, true);
  assert.equal(O.live.dk.quote_meta.ml.home.received_at, new Date(NOW).toISOString());
  E.tick(46000);
  O = E.exports.game(123).odds;
  assert.equal(O.live.dk.quote_meta.ml.home.freshness, 'STALE');
  assert.equal(O.live.dk.quote_meta.ml.home.actionable, false);
  E.setResponse(feed(market({ moneyline: [q({ team_id: 1, updated_at: undefined })] })));
  await E.run('pollAN()');
  const Q = E.exports.snapshot().games[123].live.dk.quote_meta.ml.home;
  assert.equal(Q.source_observed_at, null);
  assert.equal(Q.freshness, 'UNVERIFIED');
  assert.equal(Q.reason_code, 'MISSING_SOURCE_TIMESTAMP');
  assert.equal(Q.actionable, false);
});

test('future source clocks, invalid prices and suspended market states cannot be actionable', async () => {
  const E = engine(feed(market({ moneyline: [q({ team_id: 1, updated_at: new Date(NOW + 1).toISOString() }), q({ team_id: 2, odds: 0 })],
    spread: [q({ team_id: 1, value: -1.5, status: 'suspended' })], total: [q({ side: 'over', value: 7.5, status: 'removed' })] })));
  await E.run('pollAN()');
  const M = E.exports.snapshot().games[123].live.dk.quote_meta;
  assert.equal(M.ml.home.freshness, 'CONFLICTED');
  assert.equal(M.ml.away.reason_code, 'INVALID_PRICE');
  assert.equal(M.rl.home.reason_code, 'MARKET_SUSPENDED');
  assert.equal(M.t.over.reason_code, 'MARKET_REMOVED');
  for (const sides of Object.values(M)) for (const quote of Object.values(sides)) assert.equal(quote.actionable, false);
});

test('live quotes cannot alter pregame price history or a frozen close', async () => {
  const E = engine();
  const D = E.run('current()');
  D.ingest(123, 'an', { dk: { ml: [-115, -105], rl: { line: -1.5, odds: [130, -150] }, t: { line: 8.5, odds: [-110, -110] } } }, NOW - 60000, NOW - 60000);
  D.freeze(123);
  const before = JSON.stringify(D.games);
  await E.run('pollAN()');
  assert.equal(JSON.stringify(D.games), before);
  const O = E.exports.snapshot().games[123];
  assert.deepEqual(O.books.dk.ml, [-115, -105]);
  assert.deepEqual(O.close.ml, [-115, -105]);
  assert.deepEqual(O.live.dk.ml, [-140, 120]);
  assert.equal(JSON.stringify(D.games).includes('quote_meta'), false);
});

test('live-only quote removal emits an empty live projection and does not revive cached prices', async () => {
  const E = engine(); await E.run('pollAN()'); E.run('flush()');
  assert.equal(E.run('current().has(123)'), false);
  assert.equal(E.exports.closeOf(123), null);
  assert.equal(E.events.filter((e) => e.type === 'odds').at(-1).data.live.dk.is_live, true);
  E.tick(20000); E.setResponse({ games: [] }); await E.run('pollAN()'); E.run('flush()');
  assert.deepEqual(E.events.filter((e) => e.type === 'odds').at(-1).data.live, {});
  assert.deepEqual(copy(E.exports.game(123).odds.live), {});
  assert.deepEqual(copy(E.exports.snapshot().games[123].live), {});
});

test('pregame and finished canonical states never expose explicit in-play quotes', async () => {
  const E = engine(); E.day.games.get(123).state = 'Preview'; await E.run('pollAN()');
  assert.equal(Object.values(E.exports.snapshot().games).some((O) => Object.keys(O.live).length), false);
  E.day.games.get(123).state = 'Live'; await E.run('pollAN()');
  assert.ok(E.exports.game(123).odds.live.dk);
  E.day.games.get(123).state = 'Final';
  assert.deepEqual(copy(E.exports.game(123).odds.live), {});
});

test('successful live refreshes bypass the unchanged-pregame two-minute push throttle', async () => {
  const E = engine(); await E.run('pollAN()'); E.run('flush()');
  E.tick(20000); await E.run('pollAN()'); E.run('flush()');
  assert.equal(E.events.filter((e) => e.type === 'odds').length, 2);
});

test('Action retains the existing twenty-second target throughout live-only schedules', () => {
  const E = engine();
  assert.equal(E.run("anInterval([{state:'Live'}])"), 20000);
  assert.equal(E.run("anInterval([{state:'Preview'}])"), 20000);
  assert.equal(E.run("anInterval([{state:'Final'}])"), 300000);
  assert.equal(E.run('anInterval([])'), 300000);
});

test('a response crossing the baseball-day rollover cannot enter the next day live view', async () => {
  const E = engine(); let finish;
  E.setResponse(() => new Promise((resolve) => { finish = resolve; }));
  const loading = E.run('pollAN()'); E.day.date = '2026-09-22'; finish(feed()); await loading;
  assert.deepEqual(copy(E.exports.snapshot().games), {});
});
