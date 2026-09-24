'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-refresh-'));
process.env.DATA_DIR = scratch;
const root = path.resolve(__dirname, '..');
const util = require('../mlb/lib/util');
const evidence = require('../mlb/lib/quote-evidence');
const AN = require('../mlb/lib/action');
const PIN = require('../mlb/lib/pinnacle');
const VSIN = require('../mlb/lib/vsin');
const { OddsDay } = require('../mlb/lib/lines');
const books = require('../mlb/lib/books');
const NOW = Date.now();
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const copy = (x) => JSON.parse(JSON.stringify(x));
const game = (pk = 123, state = 'Preview') => ({ pk, state, start: new Date(NOW + 7200000).toISOString(),
  home: { full: 'Los Angeles Dodgers', name: 'Dodgers', abbr: 'LAD' }, away: { full: 'San Francisco Giants', name: 'Giants', abbr: 'SF' } });
function feed(stamp = NOW - 1000) {
  return { games: [{ id: 777, home_team_id: 1, away_team_id: 2, start_time: game().start,
    teams: [{ id: 1, full_name: game().home.full }, { id: 2, full_name: game().away.full }],
    markets: { 68: { event: { moneyline: [
      { team_id: 1, odds: -120, is_live: false, updated_at: stamp == null ? undefined : new Date(stamp).toISOString(), line_status: 'normal' },
      { team_id: 2, odds: 110, is_live: false, updated_at: stamp == null ? undefined : new Date(stamp).toISOString(), line_status: 'normal' },
    ] } } } }] };
}
function engine(responses = {}) {
  let now = NOW;
  const calls = {}, events = [], day = { date: '2026-09-22', games: new Map([[123, game()]]) };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class MemoryOddsDay extends OddsDay { constructor(date) { super(date); this.games = {}; } save() {} }
  const call = (name, fallback) => async (...args) => { calls[name] = (calls[name] || 0) + 1; return typeof responses[name] === 'function' ? responses[name](...args) : responses[name] ?? fallback; };
  const context = vm.createContext({ module: { exports: {} }, process: { env: {} }, Date: Clock, console,
    setTimeout: () => 0, setInterval: () => 0,
    testContext: { today: () => day, emit: (type, data) => events.push({ type, data: copy(data) }) },
    require(id) {
      if (id === '../../shared/bet-links') return require('../shared/bet-links');
      if (id === './util') return { ...util, log: () => {} };
      if (id === './quote-evidence') return evidence;
      if (id === './lines') return { OddsDay: MemoryOddsDay };
      if (id === './books') return books;
      if (id === './action') return { ...AN, fetchAN: call('an', feed()), fetchAN1: call('an1', { games: [] }) };
      if (id === './pinnacle') return { ...PIN, fetchPinnacle: call('pin', []) };
      if (id === './espn') return { ...require('../mlb/lib/espn'), fetchEspn: call('espn', { events: [] }) };
      if (id === './vsin') return { ...VSIN, fetchVsin: call('vsin', { games: [], stamp: null }) };
      if (id === './keys') return { keys() {} };
      if (id.startsWith('./')) return {};
      return require(id);
    } });
  vm.runInContext(fs.readFileSync(path.join(root, 'mlb/lib/odds.js'), 'utf8'), context);
  vm.runInContext('ctx = testContext', context);
  return { context, day, calls, events, responses, api: context.module.exports,
    run: (code) => vm.runInContext(code, context), tick: (ms) => { now += ms; },
    settle: () => vm.runInContext('Promise.all([...jobs.values()].map((job) => job.promise).filter(Boolean))', context) };
}
function quoteLine(sourceAt, more = {}) {
  return evidence.lineMeta({ ml: [-120, 110] }, { source_observed_at: sourceAt == null ? null : new Date(sourceAt).toISOString(), market_status: 'active', is_live: false, ...more });
}

test('receipt-only source cannot mask a fresh source of the same sportsbook market', () => {
  const an = evidence.captureLine(quoteLine(null), 'an', NOW);
  const vsin = evidence.captureLine(quoteLine(NOW - 30000), 'vsin', NOW - 5000);
  const selected = evidence.mergeMarkets([an, vsin], NOW);
  assert.equal(selected.market_sources.ml, 'vsin');
  assert.equal(selected.quote_meta.ml.home.actionable, true);
  assert.equal(an.quote_meta.ml.home.source_observed_at, null);
});
test('markets can choose independent eligible sources without mixing a two-sided pair', () => {
  const a = evidence.captureLine(quoteLine(NOW - 10000), 'an1', NOW);
  const b = evidence.captureLine(evidence.lineMeta({ t: { line: 8.5, odds: [-110, -110] } }, { source_observed_at: new Date(NOW - 5000).toISOString(), market_status: 'active', is_live: false }), 'vsin', NOW);
  const merged = evidence.mergeMarkets([a, b], NOW);
  assert.equal(merged.src, 'mixed');
  assert.equal(merged.market_sources.ml, 'an1');
  assert.equal(merged.market_sources.t, 'vsin');
  assert.equal(merged.quote_meta.t.over.source, merged.quote_meta.t.under.source);
});
test('fresh, aging and stale use the unchanged provider clock, never a later fetch receipt', () => {
  const raw = evidence.captureLine(quoteLine(NOW - 1000), 'vsin', NOW);
  assert.equal(evidence.decorateLine(raw, 'vsin', NOW, NOW).freshness, 'FRESH');
  const aging = evidence.decorateLine(raw, 'vsin', NOW, NOW + evidence.FRESH_FOR_MS);
  assert.equal(aging.freshness, 'AGING'); assert.equal(aging.actionable, true, 'aging is usable, labelled, on every board');
  const stale = evidence.decorateLine(raw, 'vsin', NOW, NOW + evidence.MAX_AGE_MS);
  assert.equal(stale.freshness, 'STALE'); assert.equal(stale.actionable, false);
  const checkedAgain = evidence.captureLine(raw, 'vsin', NOW + evidence.MAX_AGE_MS);
  assert.equal(evidence.decorateLine(checkedAgain, 'vsin', checkedAgain.seen, NOW + evidence.MAX_AGE_MS).freshness, 'STALE');
});
test('explicit live and missing phase context cannot become actionable pregame evidence', () => {
  for (const is_live of [true, null]) {
    const L = evidence.lineMeta({ ml: [-120, 110], is_live }, { source_observed_at: new Date(NOW - 1000).toISOString(), market_status: 'active', is_live });
    const viewed = evidence.decorateLine(evidence.captureLine(L, 'an1', NOW), 'an1', NOW, NOW);
    assert.equal(viewed.actionable, false);
    assert.equal(viewed.quote_meta.ml.home.is_live, is_live);
  }
});
test('a source response omitting a previously quoted market revokes it without deleting raw price', () => {
  const L = evidence.captureLine(quoteLine(NOW - 1000), 'vsin', NOW);
  const missing = evidence.decorateLine(evidence.missingLine(L, 'vsin', NOW + 1000), 'vsin', NOW + 1000, NOW + 1000);
  assert.deepEqual(missing.ml, L.ml);
  assert.equal(missing.actionable, false);
  assert.equal(missing.quote_meta.ml.home.reason_code, 'MISSING_FROM_SOURCE');
});
test('Pinnacle main first-five pick’em is retained as run line zero, never relabelled moneyline', () => {
  const parsed = PIN.parsePinnacle([{ id: 77, type: 'matchup', isLive: false, units: 'Regular', startTime: game().start,
    participants: [{ alignment: 'home', name: game().home.full }, { alignment: 'away', name: game().away.full }] }],
  [{ matchupId: 77, period: 1, type: 'spread', status: 'open', isAlternate: false, cutoffAt: game().start, version: 12345,
    prices: [{ designation: 'home', points: 0, price: -140 }, { designation: 'away', points: 0, price: 120 }] }]);
  assert.equal(parsed[0].F5.rl.line, 0);
  assert.equal(parsed[0].F5.ml, null);
  assert.equal(parsed[0].F5.quote_meta.rl.home.source_observed_at, null, 'cutoff and version are not quote clocks');
  const mapped = PIN.matchPinnacle(parsed, [game()]).get(123);
  assert.equal(mapped.f5.rl.line, 0);
});
test('duplicate automatic and manual requests share one provider call and status completes honestly', async () => {
  let finish;
  const E = engine({ an: () => new Promise((resolve) => { finish = resolve; }) });
  const first = E.run("runSource('an')");
  await Promise.resolve();
  const refresh = E.api.requestRefresh();
  E.api.requestRefresh();
  assert.equal(refresh.in_progress, true);
  assert.equal(E.calls.an, 1);
  finish(feed()); await first; await E.settle(); await Promise.resolve();
  assert.equal(E.api.snapshot().refresh.in_progress, false);
  assert.equal(E.api.snapshot().refresh.result, 'complete');
  assert.equal(E.api.snapshot().sources.an.state, 'ok');
  assert.equal(E.api.snapshot().sources.an.matched_games, 1);
});
test('manual cooldown does not postpone the ordinary automatic source cadence', async () => {
  const E = engine(); E.api.requestRefresh(); await E.settle(); await Promise.resolve();
  E.tick(16000);
  assert.equal(E.api.requestRefresh().result, 'scheduled');
  assert.equal(E.calls.an, 1);
  E.tick(5000); await E.run("runSource('an')");
  assert.equal(E.calls.an, 2, 'automatic due work is independent of manual request cooldown');
  assert.equal(E.api.requestRefresh().result, 'cooldown');
});
test('provider Retry-After cannot be bypassed by manual refresh and failed checks are not successes', async () => {
  let fail = true;
  const E = engine({ an: () => { if (fail) { const error = new Error('HTTP 429'); error.retryAfterMs = 60000; throw error; } return feed(); } });
  await E.run("runSource('an')");
  let info = E.api.snapshot().sources.an;
  assert.equal(info.state, 'error'); assert.equal(info.last_success_at, null); assert.equal(info.checked_at, null);
  assert.equal(info.next_refresh_at, NOW + 60000);
  E.tick(21000); E.api.requestRefresh(); await E.settle(); await Promise.resolve();
  assert.equal(E.calls.an, 1);
  E.tick(40000); fail = false; await E.run("runSource('an')");
  info = E.api.snapshot().sources.an;
  assert.equal(E.calls.an, 2); assert.equal(info.last_error, null); assert.equal(info.state, 'ok');
});
test('baseball-day rollover discards old source responses and makes the new day immediately eligible', async () => {
  let finish;
  const E = engine({ an: () => new Promise((resolve) => { finish = resolve; }) });
  const work = E.run("runSource('an')"); await Promise.resolve();
  E.day.date = '2026-09-23'; finish(feed()); await work;
  assert.equal(Object.keys(E.api.snapshot().games).length, 0);
  E.responses.an = feed(); await E.run("runSource('an')");
  assert.equal(E.calls.an, 2); assert.equal(E.api.snapshot().sources.an.date, '2026-09-23');
});
test('historical date refresh is read-only and cannot trigger current-day provider calls', () => {
  const E = engine(); assert.equal(E.api.requestRefresh('2026-09-21').result, 'historical');
  assert.deepEqual(E.calls, {});
});
test('coverage excludes finished games, exposes missing Westgate and keeps receipt-only odds unverified', async () => {
  const E = engine({ an: feed(null) }); E.day.games.set(999, game(999, 'Final'));
  await E.run("runSource('an')");
  const data = E.api.snapshot();
  assert.equal(data.coverage.active_games, 1); assert.equal(data.coverage.games_with_prices, 1);
  assert.equal(data.coverage.markets.ml.available, 1); assert.equal(data.coverage.markets.ml.fresh, 0);
  assert.equal(data.coverage.unverified_selections, 2);
  assert.ok(data.coverage.missing.some((row) => row.pk === 123 && row.book === 'wg' && row.market === 'ml'));
  assert.equal(data.coverage.missing.some((row) => row.pk === 999), false);
  assert.equal(data.sources.an.source_clock_quotes, 0); assert.equal(data.sources.an.source_observed_at, null);
  assert.ok(data.sources.an.checked_at);
  assert.ok(E.events.some((ev) => ev.type === 'odds_status' && ev.data.date === E.day.date));
});
test('host Retry-After is preserved on first failure and prevents repeated HTTP requests', async () => {
  let now = NOW, calls = 0;
  class Clock extends Date { static now() { return now; } }
  const ctx = vm.createContext({ module: { exports: {} }, process: { env: { DATA_DIR: scratch } }, console, Date: Clock, AbortController, setTimeout, clearTimeout,
    fetch: async () => { calls++; return calls === 1 ? { ok: false, status: 429, headers: { get: () => '90' } } : { ok: true, json: async () => ({ ok: true }) }; },
    require: (id) => id === '../../shared/poll-scheduler' ? require('../shared/poll-scheduler') : require(id) });
  vm.runInContext(fs.readFileSync(path.join(root, 'mlb/lib/util.js'), 'utf8'), ctx);
  await assert.rejects(ctx.module.exports.getJSON('https://provider.example/odds'), (e) => e.retryAfterMs === 90000);
  await assert.rejects(ctx.module.exports.getJSON('https://provider.example/odds'), /paused/);
  assert.equal(calls, 1);
  now += 90001; await ctx.module.exports.getJSON('https://provider.example/odds'); assert.equal(calls, 2);
});


test('historical snapshots cannot inherit current source activity or a manual refresh run', async () => {
  let finish;
  const E = engine({ an: () => new Promise((resolve) => { finish = resolve; }) });
  E.api.requestRefresh(); await Promise.resolve();
  assert.equal(E.api.snapshot().refresh.in_progress, true);
  const past = E.api.forDate('2026-09-21');
  assert.deepEqual(copy(past.sources), {});
  assert.equal(past.refresh.in_progress, false);
  assert.equal(past.refresh.result, 'historical');
  assert.equal(past.refresh.requested_at, null);
  assert.equal(past.refresh.next_allowed_at, 0);
  finish(feed()); await E.settle();
});


test('a refresh crossing day rollover cannot publish a completed run for the new day', async () => {
  let finish;
  const E = engine({ an: () => new Promise((resolve) => { finish = resolve; }) });
  E.api.requestRefresh(); await Promise.resolve();
  E.day.date = '2026-09-23'; finish(feed()); await E.settle(); await Promise.resolve();
  const current = E.api.snapshot();
  assert.equal(current.refresh.in_progress, false);
  assert.equal(current.refresh.requested_at, null);
  assert.equal(current.refresh.result, null);
});
