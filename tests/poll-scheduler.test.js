'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { KeyedPoller, retryAfterMs } = require('../shared/poll-scheduler');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise(setImmediate);

function clock(options = {}) {
  let at = 1000;
  return { poller: new KeyedPoller({ now: () => at, ...options }), advance: (ms) => { at += ms; }, now: () => at };
}

test('stalled week does not delay healthy source/week polls or their flushes', async () => {
  const c = clock(), stuck = deferred(), flushed = [];
  let slowCalls = 0, fastCalls = 0;
  const slow = () => { slowCalls++; return stuck.promise.then(() => flushed.push('slow')); };
  const fast = async () => { fastCalls++; flushed.push('fast'); };
  const first = c.poller.run('an slow', slow, { intervalMs: 9000 });
  await c.poller.run('an live', fast, { intervalMs: 9000 });
  c.advance(9000);
  assert.equal(c.poller.run('an slow', slow, { intervalMs: 9000 }), first);
  await c.poller.run('an live', fast, { intervalMs: 9000 });
  assert.equal(slowCalls, 1); assert.equal(fastCalls, 2); assert.deepEqual(flushed, ['fast', 'fast']);
  stuck.resolve(); await first;
  assert.deepEqual(flushed, ['fast', 'fast', 'slow']);
});

test('cadence is based on completion and adjusts to a changed live interval', async () => {
  const c = clock(), response = deferred();
  const pending = c.poller.run('espn week', () => response.promise, { intervalMs: 45000 });
  await settle(); c.advance(12000); response.resolve(); await pending;
  c.advance(7999);
  assert.equal(c.poller.run('espn week', () => {}, { intervalMs: 8000 }), null);
  c.advance(1);
  assert.equal((await c.poller.run('espn week', () => {}, { intervalMs: 8000 })).ok, true);
  assert.equal(c.poller.health()['espn week'].attempts, 2);
});

test('an external successful fetch enforces the source target before a first dispatch', async () => {
  const c = clock(); let calls = 0;
  assert.equal(c.poller.run('an week', () => calls++, { intervalMs: 9000, lastSuccessAt: 900 }), null);
  c.advance(8900);
  await c.poller.run('an week', () => calls++, { intervalMs: 9000, lastSuccessAt: 900 });
  assert.equal(calls, 1);
});

test('failed polls back off independently, honor Retry-After, and recover', async () => {
  const errors = [], c = clock({ onError: (key) => errors.push(key) });
  const fail = () => { throw Object.assign(new Error('rate limited'), { retryAfterMs: 20000 }); };
  assert.equal((await c.poller.run('an week', fail, { intervalMs: 9000 })).ok, false);
  assert.equal(c.poller.health()['an week'].retryAt, 21000);
  await c.poller.run('espn week', () => {});
  c.advance(19999); assert.equal(c.poller.run('an week', fail, { intervalMs: 9000 }), null);
  c.advance(1); await c.poller.run('an week', () => { throw new Error('still failed'); }, { intervalMs: 9000 });
  assert.equal(c.poller.health()['an week'].retryAt, 31000, 'second failure waits at least 10 seconds');
  c.advance(10000); await c.poller.run('an week', () => {}, { intervalMs: 9000 });
  assert.equal(c.poller.health()['an week'].failures, 0); assert.equal(c.poller.health()['an week'].retryAt, 0);
  assert.equal(errors.length, 2);
});

test('first scoreboard failure recovers promptly while global feed retries preserve their cadence', async () => {
  const c = clock(), fail = () => { throw new Error('timeout'); };
  await c.poller.run('espn empty', fail, { intervalMs: 300000 });
  await c.poller.run('pinnacle', fail, { intervalMs: 600000, retryMinMs: 600000 });
  c.advance(5000);
  assert.equal((await c.poller.run('espn empty', () => {}, { intervalMs: 300000 })).ok, true);
  assert.equal(c.poller.run('pinnacle', () => {}, { intervalMs: 600000, retryMinMs: 600000 }), null);
});

test('synchronous task or error reporter failures do not strand the in-flight lock', async () => {
  const c = clock({ onError: () => { throw new Error('logger failed'); } });
  assert.equal((await c.poller.run('week', () => { throw new Error('fetch failed'); })).ok, false);
  assert.equal(c.poller.health().week.running, false);
  c.advance(5000); assert.equal((await c.poller.run('week', () => 7)).value, 7);
});

test('diagnostics are bounded without evicting in-flight or backoff state', async () => {
  const c = clock({ maxEntries: 2 }), response = deferred();
  const pending = c.poller.run('slow', () => response.promise);
  await c.poller.run('old', () => {}); c.advance(1);
  await c.poller.run('new', () => {});
  assert.deepEqual(Object.keys(c.poller.health()).sort(), ['new', 'slow']);
  response.resolve(); await pending;
  await c.poller.run('slow', () => { throw new Error('failure'); });
  await c.poller.run('third', () => {});
  assert.ok(c.poller.health().slow, 'backoff is not evicted');
  assert.equal(Object.keys(c.poller.health()).length, 2);
});

test('Retry-After accepts seconds and HTTP dates, rejects unusable values', () => {
  const now = Date.parse('2026-09-22T12:00:00Z');
  assert.equal(retryAfterMs('45', now), 45000);
  assert.equal(retryAfterMs('Tue, 22 Sep 2026 12:01:00 GMT', now), 60000);
  for (const value of [null, '', 'invalid', '1e308', '-2', 'Tue, 22 Sep 2026 11:00:00 GMT']) assert.equal(retryAfterMs(value, now), 0);
});

for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport}: server dispatches fresh weeks and flushes without waiting for a stalled scoreboard`, async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', sport, 'server.js'), 'utf8');
    const fn = source.slice(source.indexOf('function startLoops() {'), source.indexOf('// ---------------------------------------------------------------- other weeks'));
    const c = clock(), slow = deferred(), loops = [], flushed = [], calls = { fast: 0, slow: 0, an: 0, vsin: 0, pin: 0 };
    const make = (id) => ({ id, at: { espn: 0, an: 0, a1: 0, wx: 0 }, games: new Map() });
    const fast = make('fast'), lagging = make('slow');
    const ctx = vm.createContext({
      polls: c.poller, tracked: () => [fast, lagging], LIVE_MS: 8000, ODDS_MS: 15000, HOT_MS: 9000, VSIN_MS: 120000, PIN_MS: 600000,
      liveish: () => true, today: () => true, hot: () => true, OFF: new Set(),
      every: (fn, msFor) => loops.push({ fn, msFor }), setInterval: () => {},
      pollEspn: async (W) => { calls[W.id]++; if (W.id === 'slow') await slow.promise; W.at.espn = c.now(); W.games.set('g', {}); },
      pollAn: async (W) => { calls.an++; W.at.an = c.now(); }, pollAn1: async (W) => { W.at.a1 = c.now(); },
      pollVsin: async () => { calls.vsin++; return true; }, pollPin: async () => { calls.pin++; },
      flush: (W) => flushed.push(W.id), pickDefault: () => {},
      pollFpi: () => {}, pollWx: () => {}, pollStrays: () => {}, refreshCalendar: () => {}, once: () => {},
    });
    vm.runInContext(fn + '\nstartLoops();', ctx);
    loops[4].fn(); loops[5].fn(); await settle();
    assert.equal(calls.vsin, 0); assert.equal(calls.pin, 0, 'global feeds need canonical scoreboard identities');
    loops[0].fn(); await settle();
    assert.deepEqual(flushed, ['fast']); assert.equal(calls.slow, 1);
    loops[1].fn(); loops[4].fn(); loops[5].fn(); await settle();
    assert.equal(calls.an, 1); assert.equal(calls.vsin, 1); assert.equal(calls.pin, 1);
    c.advance(9000); loops[0].fn(); loops[1].fn(); loops[4].fn(); loops[5].fn(); await settle();
    assert.equal(calls.fast, 2); assert.equal(calls.an, 2); assert.equal(calls.slow, 1);
    assert.equal(calls.vsin, 1); assert.equal(calls.pin, 1, 'readiness scan does not increase global fetch frequency');
    slow.resolve(); await settle();
    assert.ok(flushed.includes('slow'));
  });
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'poll-backoff-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport}: HTTP Retry-After pauses that host immediately and later errors cannot shorten it`, async () => {
    const previousDir = process.env.DATA_DIR, previousFetch = global.fetch;
    process.env.DATA_DIR = temp;
    const U = require(`../${sport}/lib/util`);
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return { status: calls === 1 ? 429 : 503, ok: false, headers: new Headers(calls === 1 ? { 'retry-after': '60' } : {}) };
    };
    try {
      const results = await Promise.allSettled([1, 2, 3].map(() => U.getJSON(`https://quota-${sport}.example/odds`)));
      assert.ok(results.every((r) => r.status === 'rejected'));
      assert.ok(U.health()[`quota-${sport}.example`].pausedFor > 59000);
      await assert.rejects(U.getJSON(`https://quota-${sport}.example/odds`), (e) => e.retryAfterMs > 59000);
      assert.equal(calls, 3, 'paused requests never reach fetch');
      global.fetch = async () => ({ status: 200, ok: true, headers: new Headers(), json: async () => ({ ok: true }) });
      assert.equal((await U.getBody(`https://healthy-${sport}.example/odds`)).ok, true);
    } finally {
      global.fetch = previousFetch;
      if (previousDir == null) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDir;
    }
  });
}

for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport}: late scoreboard identities reuse global odds without refetching or restamping`, async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', sport, 'server.js'), 'utf8');
    const globals = source.slice(source.indexOf('const VSIN_AT ='), source.indexOf('// ---------------------------------------------------------------- FPI, weather'));
    const espn = source.slice(source.indexOf('async function pollEspn(W) {'), source.indexOf('function onKickoff(W, g) {'));
    let at = 1000, vsCalls = 0, pinCalls = 0;
    class Clock extends Date { static now() { return at; } }
    const mkWeek = (games) => ({ k: {}, games: new Map(games.map(g=>[g.id,g])), vs: new Map(), pin: new Map(), at: {}, lines: { full: () => ({ close: {} }) } });
    const fast = mkWeek([{ id:'fast',state:'pre' }]), late = mkWeek([]);
    const raw = { s:-2.5, source_observed_at:'1970-01-01T00:00:00.900Z' };
    const ctx = vm.createContext({
      Date: Clock, structuredClone, tracked: () => [fast,late], integrity:{batch: fn=>fn()},
      VSIN:{fetchVsin:async()=>{vsCalls++;return {games:[raw],stamp:'stamp'};},stampTime:()=>900,matchAll:(rows,games)=>new Map(games.map(g=>[g.id,{books:{circa:rows[0]}}]))},
      PIN:{fetchPinnacle:async()=>{pinCalls++;return [raw];},matchPinnacle:(rows,games)=>new Map(games.map(g=>[g.id,{line:rows[0]}]))},
      retainBooks:(G,books,src,received)=>Object.fromEntries(Object.entries(books||{}).map(([key,L])=>[key,{...L,received_at:received}])),
      retainObservation:(G,key,L,src,received)=>({...L,received_at:received}),recordBooks:()=>{},
      ESPN:{fetchScoreboard:async()=>({events:[{id:'late',state:'pre'}]}),gameFromEvent:e=>e},
      Bets:{refresh:()=>{}},gameById:()=>{},closeById:()=>{},emitBets:()=>{},onKickoff:()=>{},
    });
    vm.runInContext(globals+'\n'+espn,ctx);
    await ctx.pollVsin(); await ctx.pollPin();
    assert.equal(late.pin.size,0);
    at=6000; await ctx.pollEspn(late);
    assert.equal(vsCalls,1); assert.equal(pinCalls,1);
    assert.equal(late.pin.get('late').line.received_at,1000);
    assert.equal(late.vs.get('late').books.circa.received_at,1000);
    assert.equal(late.pin.get('late').line.source_observed_at,raw.source_observed_at);
    assert.equal(late.at.pin,1000); assert.equal(late.at.vsin,1000);
  });
}
