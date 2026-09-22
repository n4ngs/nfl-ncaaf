'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Portfolio = require('../design/portfolio');
const NOW = Date.parse('2026-09-22T20:00:00Z');
const future = '2026-09-22T21:00:00Z', past = '2026-09-22T19:00:00Z';
function ticket(overrides = {}) {
  return { id: 'one', status: 'open', placed: '2026-09-22T18:00:00Z', created: NOW - 7200000,
    stake: 25, odds: -110, net: null, book: 'BetMGM', note: 'Native note',
    legs: [{ gid: '123', mkt: 's', side: 'home', line: -2.5, odds: -110, state: 'open', start: future, label: 'Home −2.5', matchup: 'Away at Home' }], ...overrides };
}
const response = (body, status = 200, contentType = 'application/json') => ({ ok: status === 200, status, headers: { get: () => contentType }, json: async () => body });

test('browser global and CommonJS expose the same independent loader API without browser storage', () => {
  const context = { setTimeout, clearTimeout, AbortController, Date };
  Object.defineProperty(context, 'localStorage', { get() { throw new Error('Private tickets must not use storage'); } });
  Object.defineProperty(context, 'sessionStorage', { get() { throw new Error('Private tickets must not use storage'); } });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../design/portfolio.js'), 'utf8'), context);
  assert.equal(typeof context.BoardPortfolio.load, 'function');
  assert.equal(typeof context.BoardPortfolio.invalidate, 'function');
  assert.equal(typeof context.BoardPortfolio.createLoader, 'function');
});

test('owner-scoped reads use sport paths and cookies; active sport reuses its supplied list', async () => {
  const calls = [];
  const loader = Portfolio.createLoader({ now: () => NOW });
  const result = await loader.load({ sport: 'nfl', currentBets: [ticket()], fetchImpl: async (url, options) => {
    calls.push({ url, options }); return response([ticket()]);
  } });
  assert.deepEqual(calls.map((call) => call.url).sort(), ['/mlb/api/bets', '/ncaaf/api/bets']);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
    assert.equal(Object.hasOwn(options, 'body'), false); assert.equal(Object.hasOwn(options.headers, 'cookie'), false);
  }
  assert.equal(result.tickets.length, 3);
  assert.deepEqual(new Set(result.tickets.map((t) => t.id)), new Set(['nfl:one', 'ncaaf:one', 'mlb:one']));
  assert.ok(result.sources.every((source) => source.status === 'ok'));
  assert.equal(result.updatedAt, NOW);
});

test('football integrity and raw records remain unchanged and detached from input', () => {
  const raw = ticket();
  raw.legs[0].integrity = { eligibility_status: 'MISSING_CLOSE', line_clv_points: null, price_clv_status: 'NO_PAIR' };
  raw.legs[0].entry_record = { entry_snapshot_id: null, recorded_at: '2026-09-22T18:00:00Z' };
  const original = JSON.parse(JSON.stringify(raw));
  const normalized = Portfolio.normalizeTicket('nfl', raw, { now: NOW });
  assert.equal(normalized.sourceHref, '/nfl/#bets');
  assert.equal(normalized.nativeId, raw.id); assert.equal(normalized.phase, 'upcoming');
  assert.deepEqual(normalized.legs[0].integrity, raw.legs[0].integrity);
  assert.deepEqual(normalized.raw, original);
  normalized.legs[0].integrity.price_clv_status = 'changed';
  normalized.raw.legs[0].entry_record.entry_snapshot_id = 'changed';
  assert.deepEqual(raw, original);
  assert.equal(Object.hasOwn(normalized, 'probability'), false);
});

test('MLB optional stakes/profit and legacy CLV remain explicit without invented integrity', () => {
  const raw = ticket({ stake: null, odds: null, net: null, placed: '2026-09-22 18:00:00',
    legs: [{ pk: 777, mkt: 'f5rl', side: 'away', line: 0.5, state: 'open', clv: { pts: 0.5, pct: null }, start: past }] });
  const result = Portfolio.normalizeTicket('mlb', raw, { now: NOW, games: new Map([[777, { pk: 777, state: 'Live' }]]) });
  assert.equal(result.phase, 'live'); assert.equal(result.legs[0].eventId, '777');
  assert.equal(result.stake, null); assert.equal(result.odds, null); assert.equal(result.profit, null); assert.equal(result.placedAt, null);
  assert.equal(result.legs[0].integrity, null); assert.deepEqual(result.legs[0].clv, raw.legs[0].clv);
  assert.equal(result.sourceHref, '/mlb/?portfolio=mine#following');
});

test('time and money normalization never turns missing/invalid values into zero', () => {
  const t = Portfolio.normalizeTicket('ncaaf', ticket({ stake: '', odds: NaN, net: undefined, placed: null, created: null }), { now: NOW });
  assert.equal(t.stake, null); assert.equal(t.odds, null); assert.equal(t.profit, null);
  assert.equal(t.placedAt, null); assert.equal(t.createdAt, null); assert.equal(t.settledAt, null);
  const zero = Portfolio.normalizeTicket('nfl', ticket({ status: 'push', net: 0, stake: 0 }), { now: NOW });
  assert.equal(zero.profit, 0); assert.equal(zero.stake, 0); assert.equal(zero.phase, 'settled');
});

test('past scheduled start never becomes live/upcoming without actual game state', () => {
  const raw = ticket(); raw.legs[0].start = past;
  assert.equal(Portfolio.normalizeTicket('nfl', raw, { now: NOW }).phase, 'unknown');
  assert.equal(Portfolio.normalizeTicket('nfl', raw, { now: NOW, gameOf: () => ({ state: 'in' }) }).phase, 'live');
  assert.equal(Portfolio.normalizeTicket('nfl', raw, { now: NOW, games: { 123: { state: 'pre' } } }).phase, 'upcoming');
  assert.equal(Portfolio.normalizeTicket('nfl', raw, { now: NOW, games: [{ id: '123', state: 'post' }] }).phase, 'unknown');
});

test('suspended, canceled and unknown states stay unknown; ticket settlement is authoritative', () => {
  for (const detail of ['Suspended', 'Postponed', 'Canceled']) {
    assert.equal(Portfolio.normalizeTicket('mlb', ticket({ legs: [{ pk: 7, state: 'open', start: future }] }), { now: NOW, games: { 7: { state: 'Live', detail } } }).phase, 'unknown');
  }
  for (const status of ['won', 'lost', 'void', 'push']) {
    assert.equal(Portfolio.normalizeTicket('nfl', ticket({ status }), { now: NOW, gameOf: () => ({ state: 'in' }) }).phase, 'settled');
  }
  assert.equal(Portfolio.normalizeTicket('nfl', ticket({ status: 'custom' }), { now: NOW }).phase, 'unknown');
});

test('parlays classify remaining legs without computing settlement or probabilities', () => {
  const raw = ticket(); raw.legs.push({ ...raw.legs[0], gid: '456' });
  raw.legs[0].state = 'won';
  assert.equal(Portfolio.normalizeTicket('nfl', raw, { now: NOW }).phase, 'upcoming');
  raw.legs[1].start = past;
  assert.equal(Portfolio.normalizeTicket('nfl', raw, { now: NOW }).phase, 'unknown');
  assert.equal(Portfolio.normalizeTicket('nfl', raw, { now: NOW, games: [{ id: '456', state: 'in' }] }).phase, 'live');
  raw.legs[1].state = 'won';
  assert.equal(Portfolio.normalizeTicket('nfl', raw, { now: NOW }).phase, 'unknown');
});

test('peer game contexts apply by sport without ID collisions', async () => {
  const loader = Portfolio.createLoader({ now: () => NOW, fetchImpl: async () => response([ticket()]) });
  const out = await loader.load({ sport: 'nfl', currentBets: [ticket()], gameOf: () => ({ state: 'in' }),
    gamesBySport: { ncaaf: { 123: { state: 'pre' } }, mlb: () => ({ state: 'Live' }) } });
  assert.equal(out.tickets.find((t) => t.sport === 'nfl').phase, 'live');
  assert.equal(out.tickets.find((t) => t.sport === 'ncaaf').phase, 'upcoming');
  assert.equal(out.tickets.find((t) => t.sport === 'mlb').phase, 'upcoming'); // no pk: cannot borrow a football id
});

test('partial failures differ from a successfully empty sport and never reuse stale private records', async () => {
  const loader = Portfolio.createLoader({ now: () => NOW });
  const out = await loader.load({ sport: 'nfl', currentBets: [ticket()], fetchImpl: async (url) => url.includes('mlb') ? response([], 403) : response([]) });
  assert.equal(out.tickets.length, 1);
  assert.deepEqual(out.sources.map((s) => [s.sport, s.status]), [['nfl', 'ok'], ['ncaaf', 'ok'], ['mlb', 'error']]);
  assert.match(out.sources[2].error, /sign in/); assert.equal(out.sources[2].updatedAt, null);
});

test('HTML, invalid records, conflicting IDs and network failures are errors, not empty successes', async () => {
  for (const fetchImpl of [async () => response([], 200, 'text/html'), async () => response({ bets: [] }),
    async () => response([{ id: 'bad' }]), async () => response([ticket(), ticket({ stake: 50 })]),
    async () => { throw new Error('Secret server details must not be displayed'); }]) {
    const loader = Portfolio.createLoader({ now: () => NOW, fetchImpl });
    const out = await loader.load({ sports: ['nfl'] });
    assert.equal(out.sources[0].status, 'error'); assert.deepEqual(out.tickets, []);
    assert.doesNotMatch(out.sources[0].error, /Secret/);
  }
  const out = await Portfolio.createLoader({ fetchImpl: async () => response([ticket(), ticket()]) }).load({ sports: ['nfl'] });
  assert.equal(out.sources[0].status, 'ok'); assert.equal(out.tickets.length, 1);
});

test('concurrent loads share requests; TTL uses detached values and re-normalizes live context', async () => {
  let now = NOW, calls = 0;
  const loader = Portfolio.createLoader({ now: () => now, ttlMs: 5000, fetchImpl: async () => { calls++; return response([ticket()]); } });
  const options = { sports: ['nfl'], sport: 'nfl' };
  const [first, second] = await Promise.all([loader.load(options), loader.load(options)]);
  assert.equal(calls, 1); assert.deepEqual(first, second);
  first.tickets[0].raw.note = 'changed'; first.tickets[0].legs[0].line = 99;
  now += 1000;
  const cached = await loader.load({ ...options, gameOf: () => ({ state: 'in' }) });
  assert.equal(calls, 1); assert.equal(cached.sources[0].cached, true); assert.equal(cached.sources[0].updatedAt, NOW);
  assert.equal(cached.tickets[0].phase, 'live'); assert.equal(cached.tickets[0].raw.note, 'Native note'); assert.equal(cached.tickets[0].legs[0].line, -2.5);
  now += 5000; await loader.load(options); assert.equal(calls, 2);
  loader.invalidate('nfl'); await loader.load(options); assert.equal(calls, 3);
});

test('new current-sport SSE lists always override fetched cache and supplied empty list is authoritative', async () => {
  let calls = 0;
  const loader = Portfolio.createLoader({ fetchImpl: async () => { calls++; return response([ticket()]); } });
  await loader.load({ sports: ['nfl'] });
  const empty = await loader.load({ sports: ['nfl'], sport: 'nfl', currentBets: [] });
  assert.deepEqual(empty.tickets, []); assert.equal(empty.sources[0].status, 'ok'); assert.equal(calls, 1);
  const invalid = await loader.load({ sports: ['nfl'], sport: 'nfl', currentBets: null });
  assert.equal(invalid.sources[0].status, 'error'); assert.equal(calls, 1);
});

test('invalidation aborts in-flight requests and prevents a late response repopulating cache', async () => {
  let release, calls = 0, signal;
  const loader = Portfolio.createLoader({ fetchImpl: (url, options) => {
    calls++; signal = options.signal;
    return calls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(response([]));
  } });
  const pending = loader.load({ sports: ['nfl'] });
  await Promise.resolve();
  loader.invalidate(); assert.equal(signal.aborted, true);
  assert.equal((await pending).sources[0].status, 'error');
  release(response([ticket()])); await Promise.resolve();
  const next = await loader.load({ sports: ['nfl'] });
  assert.equal(calls, 2); assert.deepEqual(next.tickets, []);
});

test('timeouts produce a source error even for a fetch implementation that ignores abort', async () => {
  const loader = Portfolio.createLoader({ timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  const out = await loader.load({ sports: ['nfl'] });
  assert.equal(out.sources[0].status, 'error'); assert.match(out.sources[0].error, /timed out/);
});

test('standalone base paths only read selected sport and reject external or traversal destinations', async () => {
  const urls = [];
  const loader = Portfolio.createLoader({ fetchImpl: async (url) => { urls.push(url); return response([ticket()]); } });
  const out = await loader.load({ sports: ['nfl'], basePaths: { nfl: '' } });
  assert.deepEqual(urls, ['/api/bets']); assert.equal(out.tickets[0].sourceHref, '/#bets');
  for (const base of ['https://elsewhere.test', '//elsewhere.test', '/nfl/../mlb', '/nfl?x=y', '/%2f%2fevil']) {
    const failed = await loader.load({ sports: ['nfl'], basePaths: { nfl: base } });
    assert.equal(failed.sources[0].status, 'error'); assert.equal(urls.length, 1);
  }
});

test('different fetch implementations and base paths do not share private cache entries', async () => {
  const loader = Portfolio.createLoader();
  const first = async () => response([ticket({ id: 'person-a' })]);
  const second = async () => response([ticket({ id: 'person-b' })]);
  assert.equal((await loader.load({ sports: ['nfl'], fetchImpl: first })).tickets[0].nativeId, 'person-a');
  assert.equal((await loader.load({ sports: ['nfl'], fetchImpl: second })).tickets[0].nativeId, 'person-b');
  let count = 0;
  const byPath = async () => { count++; return response([]); };
  await loader.load({ sports: ['nfl'], fetchImpl: byPath });
  await loader.load({ sports: ['nfl'], basePaths: { nfl: '' }, fetchImpl: byPath });
  assert.equal(count, 2);
});

test('supplied peer stream lists skip fetch, including empty lists, and current list wins', async () => {
  let calls = 0;
  const result = await Portfolio.load({ sport: 'nfl', currentBets: [ticket({ id: 'current' })],
    betsBySport: { nfl: [ticket({ id: 'old' })], ncaaf: [], mlb: [ticket({ id: 'baseball' })] },
    fetchImpl: async () => { calls++; throw new Error('Should not fetch known lists'); } });
  assert.equal(calls, 0);
  assert.deepEqual(new Set(result.tickets.map((t) => t.id)), new Set(['nfl:current', 'mlb:baseball']));
  assert.ok(result.sources.every((s) => s.status === 'ok'));
});

function streamFixture() {
  const streams = [], bets = [], games = [], statuses = [];
  class FakeEventSource {
    constructor(url, options) { this.url = url; this.options = options; this.listeners = new Map(); this.closed = 0; streams.push(this); }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
    close() { this.closed++; }
  }
  const subscribe = (more = {}) => Portfolio.subscribe({ sports: ['nfl', 'mlb'], EventSourceImpl: FakeEventSource,
    onBets(sport, rows) { bets.push({ sport, rows }); }, onGames(sport, rows) { games.push({ sport, rows }); },
    onStatus(sport, status) { statuses.push({ sport, ...status }); }, ...more });
  return { streams, bets, games, statuses, subscribe, FakeEventSource };
}

test('peer streams decode sport snapshots and game updates while preserving owner-filtered lists', () => {
  const f = streamFixture(), stop = f.subscribe();
  assert.deepEqual(f.streams.map((s) => s.url), ['/nfl/api/stream', '/mlb/api/stream']);
  assert.ok(f.streams.every((s) => s.options.withCredentials === true));
  f.streams[0].emit('snapshot', { bets: [ticket()], week: { games: [{ id: '123', state: 'pre' }] } });
  f.streams[1].emit('snapshot', { bets: [ticket({ id: 'baseball' })], games: [{ pk: 77, state: 'Live' }] });
  assert.deepEqual(f.bets.map((b) => [b.sport, b.rows[0].id]), [['nfl', 'one'], ['mlb', 'baseball']]);
  assert.equal(f.games[0].rows.get('123').state, 'pre'); assert.equal(f.games[1].rows.get('77').state, 'Live');
  f.games[0].rows.get('123').state = 'mutated';
  f.streams[0].emit('game', { id: '456', state: 'in' });
  assert.equal(f.games.at(-1).rows.get('123').state, 'pre'); assert.equal(f.games.at(-1).rows.get('456').state, 'in');
  f.streams[1].emit('bets', []); assert.deepEqual(f.bets.at(-1).rows, []);
  assert.ok(f.statuses.some((s) => s.sport === 'mlb' && s.status === 'connected'));
  stop();
});

test('disconnect clears game evidence; reconnect requires and replaces its complete snapshot', () => {
  const f = streamFixture(), stop = f.subscribe({ sports: ['ncaaf'] }), stream = f.streams[0];
  stream.emit('snapshot', { bets: [ticket()], week: { games: [{ id: '123', state: 'in' }] } });
  stream.onerror();
  assert.equal(f.games.at(-1).rows.size, 0); assert.equal(f.statuses.at(-1).status, 'reconnecting');
  const callbacks = f.games.length;
  stream.emit('game', { id: 'old', state: 'in' }); stream.emit('bets', []);
  assert.equal(f.games.length, callbacks); assert.equal(f.bets.length, 1);
  stream.onopen(); assert.equal(f.statuses.at(-1).status, 'connecting');
  stream.emit('snapshot', { bets: [], week: { games: [{ id: '456', state: 'pre' }] } });
  assert.equal(f.games.at(-1).rows.has('123'), false); assert.equal(f.games.at(-1).rows.get('456').state, 'pre');
  assert.deepEqual(f.bets.at(-1).rows, []); assert.equal(f.statuses.at(-1).status, 'connected');
  stop();
});

test('stopping peer streams is idempotent and prevents callbacks from late events', () => {
  const f = streamFixture(), stop = f.subscribe();
  stop(); stop();
  assert.ok(f.streams.every((s) => s.closed === 1));
  const count = f.statuses.length;
  for (const stream of f.streams) {
    stream.onopen(); stream.onerror();
    stream.emit('snapshot', { bets: [], games: [], week: null }); stream.emit('game', { pk: 99, id: '99' });
  }
  assert.equal(f.statuses.length, count); assert.equal(f.games.length, 0); assert.equal(f.bets.length, 0);
});

test('invalid peer updates fail closed without replacing a valid bet list with empty success', () => {
  const f = streamFixture(), stop = f.subscribe({ sports: ['mlb'] }), stream = f.streams[0];
  stream.emit('snapshot', { bets: [ticket()], games: [{ pk: 77, state: 'Live' }] });
  stream.emit('bets', { error: 'not a list' });
  assert.equal(f.statuses.at(-1).status, 'error'); assert.equal(f.games.at(-1).rows.size, 0);
  assert.equal(f.bets.length, 1); assert.equal(stream.closed, 1);
  stop();
});

test('peer subscriptions cap connections and validate all destinations before opening any', () => {
  const f = streamFixture();
  assert.throws(() => f.subscribe({ sports: ['nfl', 'ncaaf', 'mlb'] }), /at most two/);
  assert.throws(() => f.subscribe({ basePaths: { mlb: '//elsewhere.test' } }), /same-origin/);
  assert.equal(f.streams.length, 0);
  const stop = f.subscribe({ sports: ['mlb'], basePaths: { mlb: '' } });
  assert.equal(f.streams[0].url, '/api/stream'); stop();
});

test('football live context uses actual scores, period and clock while preserving missing scores', () => {
  const record = ticket();
  const live = Portfolio.normalizeTicket('nfl', record, { now: NOW, gameOf: () => ({ state: 'in', away: { abbr: 'LV', score: 0 }, home: { abbr: 'KC', score: 7 }, period: 2, clock: '04:32' }) });
  assert.equal(live.legs[0].liveText, 'LV 0 · KC 7 · Q2 04:32');
  const missing = Portfolio.normalizeTicket('ncaaf', record, { now: NOW, gameOf: () => ({ state: 'in', away: { abbr: 'UNLV', score: null }, home: { abbr: 'USC', score: 0 }, half: true }) });
  assert.equal(missing.legs[0].liveText, 'UNLV — · USC 0 · Halftime');
  const overtime = Portfolio.normalizeTicket('ncaaf', record, { now: NOW, gameOf: () => ({ state: 'in', period: 6 }) });
  assert.equal(overtime.legs[0].liveText, '2OT');
});

test('MLB live context keeps actual inning, half and outs distinct from pregame or final status', () => {
  const record = ticket({ legs: [{ pk: 77, state: 'open', start: past }] });
  const game = { pk: 77, state: 'Live', away: { abbr: 'SF', score: 1 }, home: { abbr: 'LAD', score: 0 }, inning: 6, half: 'Bottom', outs: 1 };
  const normalize = (more = {}) => Portfolio.normalizeTicket('mlb', record, { now: NOW, games: { 77: { ...game, ...more } } }).legs[0].liveText;
  assert.equal(normalize(), 'SF 1 · LAD 0 · Bottom 6 · 1 out');
  assert.equal(normalize({ half: 'Top', outs: 3 }), 'SF 1 · LAD 0 · Mid 6');
  assert.equal(normalize({ detail: 'Delayed: Rain' }), 'SF 1 · LAD 0 · Delayed');
  assert.equal(normalize({ detail: 'Suspended' }), null);
  assert.equal(normalize({ state: 'Final' }), null);
  assert.equal(normalize({ state: 'Preview' }), null);
});

test('re-normalizing without current game evidence clears both live phase and score context', () => {
  const record = ticket({ legs: [{ gid: '123', state: 'open', start: past, liveText: 'Saved spoofed score' }] });
  const game = { state: 'in', away: { abbr: 'LV', score: 10 }, home: { abbr: 'KC', score: 7 }, period: 3, clock: '10:00' };
  const live = Portfolio.normalizeTicket('nfl', record, { now: NOW, gameOf: () => game });
  assert.equal(live.phase, 'live'); assert.match(live.legs[0].liveText, /LV 10/);
  const disconnected = Portfolio.normalizeTicket('nfl', live.raw, { now: NOW });
  assert.equal(disconnected.phase, 'unknown'); assert.equal(disconnected.legs[0].liveText, null);
  const settled = Portfolio.normalizeTicket('nfl', { ...record, status: 'won' }, { now: NOW, gameOf: () => game });
  assert.equal(settled.legs[0].liveText, null);
});
