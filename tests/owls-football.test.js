'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { IntegrityStore, freshness } = require('../shared/clv-integrity');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'owls-football-'));
process.env.DATA_DIR = temp;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
let serial = 0;
const root = path.resolve(__dirname, '..');
const at = Date.now() - 10000;
const start = new Date(at + 3600000).toISOString();
const game = (id = 'espn-1') => ({ id, start, state: 'pre', home: { name: 'Home Lions', loc: 'Home', mascot: 'Lions' }, away: { name: 'Away Bears', loc: 'Away', mascot: 'Bears' } });
function rawLine(clock = at, spread = -3, live = false, total = null) {
  const evidence = (line, odds) => ({ line_value: line, american_odds: odds, source_observed_at: clock === null ? null : new Date(clock).toISOString(), market_status: 'active', is_live: live, provider_event_id: 'owls-1' });
  return { s: spread, so: [-110, -105], t: total, to: total === null ? [null, null] : [-115, -105], ml: [null, null], is_live: live,
    integrityMeta: { s: { home: evidence(spread, -110), away: evidence(-spread, -105) },
      ...(total === null ? {} : { t: { over: evidence(total, -115), under: evidence(total, -105) } }) } };
}
const event = (books, other = {}) => ({ id: 'owls-1', start, home: 'Home Lions', away: 'Away Bears', books, live: {}, h1: {}, ...other });
function context(sport, games = [game()]) {
  let clock = at + 1000;
  class Clock extends Date { static now() { return clock; } }
  const ledger = new IntegrityStore({ sport, dataDir: path.join(temp, String(++serial)) });
  const previous = new Map(), detected = [], timers = [], events = [];
  const W = { id: 'week-1', games: new Map(games.map(g => [g.id, g])), an: new Map(), a1: new Map(), vs: new Map(), pin: new Map(), owls: new Map(), at: {}, sent: new Map(),
    lines: { record(id, book, L, t) { const before = previous.get(book); previous.set(book, L); return ['s', 't'].filter(m => L[m] != null && before?.[m] != null && L[m] !== before[m]).map(mkt => ({ mkt, book, from: before[mkt], to: L[mkt], t })); },
      detect(id, changes) { detected.push(...changes); return []; }, full: () => null, spark: () => null } };
  const source = fs.readFileSync(path.join(root, sport, 'server.js'), 'utf8');
  const ctx = vm.createContext({ Date: Clock, attachLink:require('../shared/bet-links').attachLink, structuredClone, integrity: ledger, freshness, BOOKS: [], OWLS: require(`../${sport}/lib/owls`), tracked: () => [W],
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return { unref() {} }; }, clearTimeout() {},
    log() {}, emit: (...args) => events.push(args), emitBets() {}, emitSnapshot: () => events.push(['snapshot']), clients: new Set(),
  });
  vm.runInContext(source.slice(source.indexOf('function retainObservation('), source.indexOf('function weekSnapshot(')) + '\n'
    + source.slice(source.indexOf('function recordBooks('), source.indexOf('// ---------------------------------------------------------------- Vegas windows')) + '\n'
    + source.slice(source.indexOf('const VSIN_AT ='), source.indexOf('// ---------------------------------------------------------------- FPI, weather')) + '\n'
    + source.slice(source.indexOf('function feeds()'), source.indexOf('function snapshot(')), ctx);
  ctx.flushGames = (week, games) => events.push(['flush', week.id, [...games].map(game => game.id)]);
  return { ctx, ledger, W, detected, timers, events, tick: value => { clock = value; } };
}

for (const sport of ['nfl', 'ncaaf']) {
  const adapter = require(`../${sport}/lib/owls`);
  test(`${sport}: Owls identity matching rejects ambiguous teams and invalid starts`, () => {
    assert.equal(adapter.matchAll([event({ pin: rawLine() })], [game()]).size, 1);
    assert.equal(adapter.matchAll([event({ pin: rawLine() })], [game(), game('espn-2')]).size, 0);
    assert.equal(adapter.matchAll([event({}, { start: 'invalid' })], [game()]).size, 0);
    assert.equal(adapter.matchAll([event({}, { start: new Date(at + 9 * 3600000).toISOString() })], [game()]).size, 0);
    assert.equal(adapter.matchAll([event({}, { home: 'Other Lions' })], [game()]).size, 0);
    assert.equal(adapter.matchAll([event({}), event({}, { id: 'duplicate' })], [game()]).size, 0);
  });
  test(`${sport}: Owls swaps sides and provenance without mutating input or total directions`, () => {
    const source = event({ pin: rawLine(at, -3, false, 45.5) }, { home: 'Away Bears', away: 'Home Lions' });
    const patch = adapter.matchAll([source], [game()]).get('espn-1');
    assert.equal(patch.books.pin.s, 3);
    assert.deepEqual(patch.books.pin.so, [-105, -110]);
    assert.equal(patch.books.pin.integrityMeta.s.home.line_value, 3);
    assert.equal(patch.books.pin.integrityMeta.s.home.american_odds, -105);
    assert.equal(patch.books.pin.integrityMeta.t.over.american_odds, -115);
    assert.equal(source.books.pin.s, -3);
  });
  test(`${sport}: Owls source clocks win over receipt-only fallback and preserve even spreads`, () => {
    const { ctx, W, ledger } = context(sport);
    const G = W.games.get('espn-1');
    W.an.set(G.id, { books: { pin: ctx.retainObservation(G, 'pin', rawLine(null, -4), 'an', at + 1000, false) } });
    ctx.applyOwls({ events: [event({ pin: rawLine(at, 0) })], receivedAt: at + 1000 });
    const line = ctx.mergedBooks(G, W).pin;
    assert.equal(line.src, 'owls');
    assert.equal(line.s, 0);
    assert.equal(line.integrity.s.home.source_observed_at, new Date(at).toISOString());
    assert.equal(line.integrity.s.home.received_at, new Date(at + 1000).toISOString());
    const count = ledger.snapshots.size;
    ctx.applyOwls({ events: [event({ pin: rawLine(at, 0) })], receivedAt: at + 2000 });
    assert.equal(ledger.snapshots.size, count);
  });
  test(`${sport}: Owls live prices and first half are separate from pregame closing evidence`, () => {
    const { ctx, W, ledger } = context(sport);
    const G = W.games.get('espn-1');
    ctx.applyOwls({ events: [event({ pin: rawLine() }, { live: { pin: rawLine(at, -7, true) }, h1: { pin: rawLine(at, -1) } })], receivedAt: at + 1000 });
    assert.equal(ctx.mergedBooks(G, W).pin.s, -3);
    assert.equal(ctx.mergedLive(G, W).pin.s, -7);
    assert.equal(ctx.livePinnacle(G, W).age, 1000);
    assert.equal(ctx.livePinnacle(G, W).limit, null);
    assert.equal(ctx.mergedHalf(G, W).pin.integrity.h1s.home.period, 'first_half');
    assert.ok([...ledger.snapshots.values()].some(q => q.is_live));
    assert.equal(ledger.resolve(G, 's', 'home', 'pin', at + 1000).current.is_live, false);
  });
  test(`${sport}: Owls withdrawals block old current with no fabricated source time`, () => {
    const { ctx, W, ledger, tick } = context(sport);
    const G = W.games.get('espn-1');
    ctx.applyOwls({ events: [event({ pin: rawLine() })], receivedAt: at + 1000 });
    tick(at + 2000);
    ctx.applyOwls({ events: [], receivedAt: at + 2000 });
    const line = ctx.mergedBooks(G, W).pin;
    assert.equal(line.freshness, 'SUSPENDED');
    assert.equal(line.integrity.s.home.source_observed_at, null);
    assert.equal(line.integrity.s.home.market_status, 'removed');
    assert.equal(ledger.resolve({ ...G, quote_source: 'owls' }, 's', 'home', 'pin', at + 2000).current, null);
    tick(at + 3000);
    ctx.applyOwls({ events: [event({ pin: rawLine(at + 2500, -4) })], receivedAt: at + 3000 });
    assert.equal(ledger.resolve({ ...G, quote_source: 'owls' }, 's', 'home', 'pin', at + 3000).current.line_value, -4);
    tick(at + 4000);
    ctx.applyOwls({ events: [], receivedAt: at + 4000 });
    assert.equal(ledger.resolve({ ...G, quote_source: 'owls' }, 's', 'home', 'pin', at + 4000).current, null);
  });
  test(`${sport}: missing Owls markets cannot resurrect a prior market beside a changed one`, () => {
    const { ctx, W, ledger, tick } = context(sport);
    const G = W.games.get('espn-1');
    ctx.applyOwls({ events: [event({ pin: rawLine(at, -3, false, 45.5) })], receivedAt: at + 1000 });
    tick(at + 2000);
    ctx.applyOwls({ events: [event({ pin: rawLine(at + 1500, -4) })], receivedAt: at + 2000 });
    assert.equal(ctx.mergedBooks(G, W).pin.t, null);
    assert.equal(ledger.resolve({ ...G, quote_source: 'owls' }, 't', 'over', 'pin', at + 2000).current, null);
    assert.equal(ledger.resolve({ ...G, quote_source: 'owls' }, 's', 'home', 'pin', at + 2000).current.line_value, -4);
  });
  test(`${sport}: Owls transition to live retains its pregame close unmodified`, () => {
    const { ctx, W, ledger, tick } = context(sport);
    const G = W.games.get('espn-1');
    G.start = new Date(at + 1500).toISOString();
    ctx.applyOwls({ events: [event({ pin: rawLine() }, { start: G.start })], receivedAt: at + 1000 });
    const before = W.owls.get(G.id).books.pin.integrity.s.home.snapshot_id;
    G.state = 'in'; tick(at + 2000);
    ctx.applyOwls({ events: [event({}, { start: G.start, live: { pin: rawLine(at + 1800, -7, true) } })], receivedAt: at + 2000 });
    const result = ledger.resolve({ ...G, quote_source: 'owls' }, 's', 'home', 'pin', at + 2000);
    assert.equal(result.close.snapshot_id, before);
    assert.equal(result.current.line_value, -7);
    assert.equal(result.close_status, 'PROVISIONAL');
  });
  test(`${sport}: Owls movements require fresh same-source pair baselines`, () => {
    const { ctx, W, detected, tick } = context(sport);
    const G = W.games.get('espn-1');
    W.an.set(G.id, { books: { pin: ctx.retainObservation(G, 'pin', rawLine(at - 1000, -2), 'an', at, false) } });
    ctx.recordBooks(W, G, at + 1000);
    ctx.applyOwls({ events: [event({ pin: rawLine(at, -3) })], receivedAt: at + 1000 });
    assert.equal(detected.length, 0, 'provider switch must establish a baseline');
    tick(at + 2000);
    ctx.applyOwls({ events: [event({ pin: rawLine(at + 1500, -4) })], receivedAt: at + 2000 });
    assert.equal(detected.length, 1);
    assert.equal(detected[0].from, -3);
    tick(at + 700000);
    ctx.recordBooks(W, G, at + 700000);
    ctx.applyOwls({ events: [event({ pin: rawLine(at + 700100, -5) })], receivedAt: at + 700200 });
    assert.equal(detected.length, 1, 'recovery from stale must not become steam');
  });
  test(`${sport}: Owls batches browser publication and replays unchanged clocks to a late scoreboard`, () => {
    const { ctx, W, timers, events } = context(sport, []);
    ctx.receiveOwls({ events: [event({ pin: rawLine() })], receivedAt: at + 1000 });
    assert.equal(timers.length, 0);
    W.games.set('espn-1', game());
    W.games.set('untouched', { ...game('untouched'), home: { name: 'Third Hawks' }, away: { name: 'Fourth Eagles' } });
    ctx.replayGlobalQuotes(W);
    assert.equal(W.owls.get('espn-1').books.pin.integrity.s.home.received_at, new Date(at + 1000).toISOString());
    ctx.receiveOwls({ events: [event({ pin: rawLine(at + 100, -4) })], receivedAt: at + 1000 });
    ctx.receiveOwls({ events: [event({ pin: rawLine(at + 200, -5) })], receivedAt: at + 1000 });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 50);
    timers[0].fn();
    assert.equal(events.filter(([type]) => type === 'flush').length, 1);
    assert.deepEqual(events.find(([type]) => type === 'flush')[2], ['espn-1'], 'streaming projects only changed games');
    assert.equal(events.filter(([type]) => type === 'snapshot').length, 1);
    assert.equal(ctx.mergedBooks(game(), W).pin.s, -5);
  });
  test(`${sport}: Owls book registry exposes supported reference books without inventing Nevada links`, () => {
    const { BOOKS } = require(`../${sport}/lib/books`);
    assert.equal(new Set(BOOKS.map(book => book.key)).size, BOOKS.length);
    for (const key of ['ps3838', 'bet365', 'betonline', 'hardrock', 'betr', 'bovada', 'novig', '1xbet', 'betrivers', 'betus', 'bet105', 'bookmaker', 'lowvig', 'mybookie', 'stake', 'thescore', 'thunderpick', 'versus']) {
      const book = BOOKS.find(book => book.key === key);
      assert.ok(book);
      assert.equal(book.vegas, undefined);
      assert.equal(book.site, undefined);
      assert.equal(book.ios, undefined);
    }
  });
  test(`${sport}: partial Owls updates preserve other providers' complete markets and each side pair`, () => {
    const { ctx, W } = context(sport);
    const G = W.games.get('espn-1');
    const older = rawLine(at - 1000, -2, false, 45.5);
    older.ml = [-130, 120];
    older.integrityMeta.ml = {
      home: { ...older.integrityMeta.s.home, line_value: null, american_odds: -130 },
      away: { ...older.integrityMeta.s.away, line_value: null, american_odds: 120 },
    };
    W.an.set(G.id, { books: { mgm: ctx.retainObservation(G, 'mgm', older, 'an', at, false) } });
    ctx.applyOwls({ events: [event({ mgm: rawLine(at, -3) })], receivedAt: at + 1000 });
    const L = ctx.mergedBooks(G, W).mgm;
    assert.equal(L.s, -3);
    assert.equal(L.t, 45.5);
    assert.deepEqual([...L.ml], [-130, 120]);
    assert.equal(L.src, 'mixed');
    assert.equal(L.integrity.s.home.source, 'owls');
    assert.equal(L.integrity.s.away.source, 'owls');
    assert.equal(L.integrity.t.over.source, 'an');
    assert.equal(L.integrity.t.under.source, 'an');
    const incomplete = rawLine(at + 100, -4);
    delete incomplete.integrityMeta.s.away;
    ctx.applyOwls({ events: [event({ mgm: incomplete })], receivedAt: at + 1000 });
    const paired = ctx.mergedBooks(G, W).mgm;
    assert.equal(paired.s, -2, 'fresh whole AN pair beats partial Owls observation');
    assert.equal(paired.integrity.s.home.source, 'an');
    assert.equal(paired.integrity.s.away.source, 'an');
  });
  test(`${sport}: live and first-half source selection retain complete independent markets`, () => {
    const { ctx, W } = context(sport);
    const G = W.games.get('espn-1');
    W.an.set(G.id, { live: { pin: ctx.retainObservation(G, 'pin', rawLine(at - 1000, -6, true, 42), 'an', at, true) } });
    W.a1.set(G.id, { h1: { pin: ctx.retainObservation(G, 'pin', rawLine(at - 1000, -1, false, 21), 'an1', at, false, 'first_half') } });
    ctx.applyOwls({ events: [event({}, { live: { pin: rawLine(at, -7, true) }, h1: { pin: rawLine(at, -2) } })], receivedAt: at + 1000 });
    const live = ctx.mergedLive(G, W).pin, half = ctx.mergedHalf(G, W).pin;
    assert.equal(live.s, -7);
    assert.equal(live.t, 42);
    assert.equal(live.integrity.t.over.source, 'an');
    assert.equal(half.s, -2);
    assert.equal(half.t, 21);
    assert.equal(half.integrity.h1t.over.source, 'an1');
    assert.equal(ctx.livePinnacle(G, W).age, 2000, 'mixed sharp evidence age is its oldest selected quote');
    assert.equal(ctx.livePinnacle(G, W).limit, null);
  });
  test(`${sport}: source switches remove old recent steam contributions for the switched market`, () => {
    const { ctx, W } = context(sport);
    const G = W.games.get('espn-1');
    const history = { recent: [{ book: 'pin', mkt: 's', from: -1, to: -2, t: at }] };
    W.lines.full = () => history;
    W.an.set(G.id, { books: { pin: ctx.retainObservation(G, 'pin', rawLine(at - 1000, -2), 'an', at, false) } });
    ctx.recordBooks(W, G, at + 1000);
    history.recent.push({ book: 'pin', mkt: 's', from: -1, to: -2, t: at });
    ctx.applyOwls({ events: [event({ pin: rawLine(at, -3) })], receivedAt: at + 1000 });
    assert.equal(history.recent.length, 0);
  });
}
