'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { IntegrityStore, freshness } = require('../shared/clv-integrity');
const { slimGame } = require('../shared/wire-diet');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sharp-football-'));
process.env.DATA_DIR = scratch;
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const root = path.resolve(__dirname, '..'), NOW = Date.now() - 10000;
let serial = 0;
const iso = at => new Date(at).toISOString();
const game = (id = 'espn-1') => ({ id, state: 'pre', start: iso(NOW + 3600000), home: { name: 'Home Lions', loc: 'Home', mascot: 'Lions' }, away: { name: 'Away Bears', loc: 'Away', mascot: 'Bears' } });
function line({ observed = null, delivered = NOW, spread = -3, total = 45.5, live = false, status = 'active' } = {}) {
  const quote = (value, odds) => ({ line_value: value, american_odds: odds, source_observed_at: observed == null ? null : iso(observed), provider_received_at: iso(delivered),
    market_status: status, is_live: live, provider_event_id: 'provider-1', pair_id: 'provider-1:market' });
  return { s: spread, so: [-110, -105], t: total, to: [-115, -105], ml: [null, null], provider_received_at: iso(delivered), is_live: live,
    integrityMeta: { s: { home: quote(spread, -110), away: quote(-spread, -105) }, ...(total == null ? {} : { t: { over: quote(total, -115), under: quote(total, -105) } }) } };
}
const event = (books, more = {}) => ({ id: 'provider-1', home: 'Home Lions', away: 'Away Bears', start: game().start, books, live: {}, h1: {}, ...more });
function harness(sport, games = [game()]) {
  let now = NOW + 1000;
  class Clock extends Date { static now() { return now; } }
  const ledger = new IntegrityStore({ sport, dataDir: path.join(scratch, String(++serial)) });
  const timers = [], emissions = [], moves = [], previous = new Map();
  const W = { id: 'week-1', games: new Map(games.map(g => [g.id, g])), an: new Map(), a1: new Map(), vs: new Map(), pin: new Map(), owls: new Map(), sharp: new Map(), at: {}, sent: new Map(),
    lines: { full: () => null, record(id, book, row, t) { const prior = previous.get(book); previous.set(book, row); return ['s', 't'].filter(m => row[m] != null && prior?.[m] != null && row[m] !== prior[m]).map(mkt => ({ mkt, book, from: prior[mkt], to: row[mkt], t })); }, detect(id, changes) { moves.push(...changes); return []; } } };
  const source = fs.readFileSync(path.join(root, sport, 'server.js'), 'utf8');
  const ctx = vm.createContext({ Date: Clock, attachLink:require('../shared/bet-links').attachLink, dropOutliers:require('../shared/book-outliers').dropOutliers, structuredClone, integrity: ledger, freshness,
    OWLS: require(`../${sport}/lib/owls`), SHARP: require(`../${sport}/lib/sharp`), BOOKS: [], tracked: () => [W], clients: new Set([{}]),
    emit: (type, data) => emissions.push({ type, data }), emitBets() {}, emitSnapshot: () => emissions.push({ type: 'snapshot' }), log() {},
    setTimeout: (fn, delay) => { const timer = { fn, delay, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {},
  });
  vm.runInContext(source.slice(source.indexOf('function retainObservation('), source.indexOf('function weekSnapshot(')) + '\n'
    + source.slice(source.indexOf('function recordBooks('), source.indexOf('// ---------------------------------------------------------------- Vegas windows')) + '\n'
    + source.slice(source.indexOf('const VSIN_AT ='), source.indexOf('// ---------------------------------------------------------------- FPI, weather')) + '\n'
    + source.slice(source.indexOf('function feeds()'), source.indexOf('function snapshot(')) + '\n'
    + source.slice(source.indexOf('function flush(W)'), source.indexOf('// ---------------------------------------------------------------- ESPN')), ctx);
  // the wire view, as production publishes it (shared/wire-diet.js)
  ctx.pub = G => slimGame({ id: G.id, books: ctx.mergedBooks(G, W), live: ctx.mergedLive(G, W), h1: ctx.mergedHalf(G, W) });
  return { ctx, W, ledger, timers, emissions, moves, tick: at => { now = at; },
    sharp: rows => ctx.receiveSharp({ events: rows, receivedAt: now }), owls: rows => ctx.receiveOwls({ events: rows, receivedAt: now }),
    fire: () => { const timer = timers.shift(); assert.ok(timer); timer.fn(); } };
}

for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport}: Sharp reuses strict identities and swaps delivery metadata with its selection`, () => {
    const adapter = require(`../${sport}/lib/sharp`);
    const row = event({ pin: line() }, { home: 'Away Bears', away: 'Home Lions' });
    const mapped = adapter.matchAll([row], [game()]).get('espn-1').books.pin;
    assert.equal(mapped.s, 3); assert.deepEqual(mapped.so, [-105, -110]);
    assert.equal(mapped.integrityMeta.s.home.american_odds, -105);
    assert.equal(mapped.integrityMeta.s.home.provider_received_at, iso(NOW));
    assert.equal(adapter.matchAll([row], [game(), game('ambiguous')]).size, 0);
    assert.equal(adapter.matchAll([event({}, { start: 'invalid' })], [game()]).size, 0);
  });
  test(`${sport}: Sharp is first among unverified display candidates while delivery stays separate`, () => {
    const E = harness(sport); E.owls([event({ pin: line({ spread: -2 }) })]); E.sharp([event({ pin: line({ spread: -3 }) })]);
    const L = E.ctx.mergedBooks(game(), E.W).pin;
    assert.equal(L.s, -3); assert.equal(L.src, 'sharp');
    assert.equal(L.freshness, 'UNVERIFIED'); assert.equal(L.source_observed_at, null);
    assert.equal(L.provider_received_at, iso(NOW));
    assert.equal(L.integrity.s.home.provider_received_at, iso(NOW));
    assert.equal(E.ledger.resolve({ ...game(), quote_source: 'sharp' }, 's', 'home', 'pin', NOW + 1000).current, null);
    assert.equal(Object.hasOwn(E.ledger.snapshot(L.integrity.s.home.snapshot_id), 'provider_received_at'), false);
  });
  test(`${sport}: newer Sharp delivery cannot displace a verified fresh Owls pair`, () => {
    const E = harness(sport); E.owls([event({ pin: line({ observed: NOW - 1000, spread: -2 }) })]);
    E.sharp([event({ pin: line({ delivered: NOW + 1000, spread: -4 }) })]);
    const L = E.ctx.mergedBooks(game(), E.W).pin;
    assert.equal(L.src, 'owls'); assert.equal(L.s, -2); assert.equal(L.freshness, 'FRESH');
    assert.equal(E.W.sharp.get('espn-1').books.pin.integrity.s.home.source_observed_at, null);
  });
  test(`${sport}: Sharp preference never crosses markets or combines different-source sides`, () => {
    const E = harness(sport);
    E.owls([event({ pin: line({ observed: NOW - 1000, spread: -2, total: 45.5 }) })]);
    E.sharp([event({ bet365_us: line({ spread: -4, total: null }) })]);
    const books = E.ctx.mergedBooks(game(), E.W);
    assert.equal(books.pin.t, 45.5); assert.equal(books.bet365_us.s, -4); assert.equal(books.bet365_us.t, null);
    assert.equal(books.pin.integrity.s.home.source, 'owls'); assert.equal(books.pin.integrity.s.away.source, 'owls');
    assert.equal(books.bet365_us.integrity.s.home.source, 'sharp'); assert.equal(books.bet365_us.integrity.s.away.source, 'sharp');
  });
  test(`${sport}: Sharp withdrawal falls back independently without restamping Owls`, () => {
    const E = harness(sport); E.owls([event({ pin: line({ spread: -2 }) })]); E.sharp([event({ pin: line({ spread: -4 }) })]);
    const before = E.W.owls.get('espn-1').books.pin.integrity.s.home;
    E.tick(NOW + 2000); E.sharp([]);
    const L = E.ctx.mergedBooks(game(), E.W).pin;
    assert.equal(L.src, 'owls'); assert.equal(L.s, -2);
    assert.equal(L.integrity.s.home.received_at, before.received_at);
    assert.equal(E.W.sharp.get('espn-1').books.pin.integrity.s.home.market_status, 'removed');
    E.owls([]); E.sharp([event({ pin: line({ spread: -5 }) })]);
    assert.equal(E.ctx.mergedBooks(game(), E.W).pin.src, 'sharp');
    assert.equal(E.W.at.owls, NOW + 2000); assert.equal(E.W.at.sharp, NOW + 2000);
  });
  test(`${sport}: Sharp delivery changes do not mint source-verified steam or closing value`, () => {
    const E = harness(sport); E.sharp([event({ pin: line({ spread: -2 }) })]);
    E.tick(NOW + 2000); E.sharp([event({ pin: line({ spread: -3, delivered: NOW + 2000 }) })]);
    assert.equal(E.moves.length, 0);
    const G = { ...game(), start: iso(NOW + 3000), state: 'post' };
    const result = E.ledger.resolve({ ...G, quote_source: 'sharp' }, 's', 'home', 'pin', NOW + 4000);
    assert.equal(result.close, null); assert.equal(result.current, null);
  });
  test(`${sport}: Sharp live and first-half prices stay separate from pregame evidence`, () => {
    const E = harness(sport); E.sharp([event({ pin: line({ spread: -2 }) }, { live: { pin: line({ live: true, spread: -7 }) }, h1: { pin: line({ spread: -1 }) } })]);
    assert.equal(E.ctx.mergedBooks(game(), E.W).pin.s, -2);
    assert.equal(E.ctx.mergedLive(game(), E.W).pin.s, -7);
    assert.equal(E.ctx.mergedHalf(game(), E.W).pin.s, -1);
    assert.equal(E.ctx.mergedHalf(game(), E.W).pin.integrity.h1s.home.period, 'first_half');
    assert.equal(E.ctx.livePinnacle(game(), E.W).age, null);
    assert.equal(E.ctx.mergedLive(game(), E.W).pin.freshness, 'UNVERIFIED');
  });
  test(`${sport}: delivery-only Sharp refreshes neither duplicate evidence nor repaint games`, () => {
    const E = harness(sport); E.sharp([event({ pin: line() })]); E.fire();
    const size = E.ledger.snapshots.size, firstPushes = E.emissions.filter(row => row.type === 'game').length;
    E.tick(NOW + 2000); E.sharp([event({ pin: line({ delivered: NOW + 2000 }) })]); E.fire();
    assert.equal(E.ledger.snapshots.size, size);
    assert.equal(E.emissions.filter(row => row.type === 'game').length, firstPushes);
    assert.equal(E.ctx.mergedBooks(game(), E.W).pin.provider_received_at, iso(NOW + 2000));
  });
  test(`${sport}: a re-observed price with a newer clock is a touch, not a whole-game patch`, () => {
    const E = harness(sport); E.owls([event({ pin: line({ observed: NOW, spread: -2 }) })]); E.fire();
    const games = E.emissions.filter(row => row.type === 'game').length;
    assert.equal(games, 1); assert.equal(E.emissions.filter(row => row.type === 'touch').length, 0);
    E.tick(NOW + 20000); E.owls([event({ pin: line({ observed: NOW + 15000, spread: -2 }) })]); E.fire();
    assert.equal(E.emissions.filter(row => row.type === 'game').length, games, 'same price: no whole-game patch');
    const touches = E.emissions.filter(row => row.type === 'touch');
    assert.equal(touches.length, 1);
    const t = touches[0].data;
    assert.equal(t.id, 'espn-1');
    assert.equal(t.books.pin.integrity.s.home.source_observed_at, iso(NOW + 15000));
    assert.equal(t.books.pin.source_observed_at, iso(NOW + 15000));
    assert.ok(!('line_value' in t.books.pin.integrity.s.home), 'a touch carries clocks only');
    assert.ok(!('s' in t.books.pin), 'a touch carries clocks only');
    assert.ok(!('age_ms' in t.books.pin), 'age is derived on the client');
    // the same clocks again: nothing to say
    E.tick(NOW + 21000); E.owls([event({ pin: line({ observed: NOW + 15000, spread: -2 }) })]); if (E.timers.length) E.fire();
    assert.equal(E.emissions.filter(row => row.type === 'touch').length, 1);
    // a price change still goes out whole
    E.tick(NOW + 22000); E.owls([event({ pin: line({ observed: NOW + 21000, spread: -2.5 }) })]); E.fire();
    assert.equal(E.emissions.filter(row => row.type === 'game').length, games + 1);
  });
  test(`${sport}: Sharp and Owls bursts share one 50ms dirty-game publication`, () => {
    const E = harness(sport, [game(), { ...game('untouched'), home: { name: 'Third Hawks' }, away: { name: 'Fourth Eagles' } }]);
    E.sharp([event({ pin: line({ spread: -3 }) })]); E.owls([event({ pin: line({ observed: NOW, spread: -2 }) })]);
    assert.equal(E.timers.length, 1); assert.equal(E.timers[0].delay, 50); E.fire();
    const updates = E.emissions.filter(row => row.type === 'game');
    assert.equal(updates.length, 1); assert.equal(updates[0].data.id, 'espn-1'); assert.equal(updates[0].data.books.pin.src, 'owls');
  });
  test(`${sport}: both provider caches replay original clocks after a late scoreboard`, () => {
    const E = harness(sport, []); E.sharp([event({ bet365_us: line() })]); E.owls([event({ pin: line({ observed: NOW }) })]);
    assert.equal(E.timers.length, 0); E.W.games.set('espn-1', game()); E.tick(NOW + 5000); E.ctx.replayGlobalQuotes(E.W);
    assert.equal(E.W.sharp.get('espn-1').books.bet365_us.integrity.s.home.received_at, iso(NOW + 1000));
    assert.equal(E.W.sharp.get('espn-1').books.bet365_us.integrity.s.home.provider_received_at, iso(NOW));
    assert.equal(E.W.owls.get('espn-1').books.pin.integrity.s.home.source_observed_at, iso(NOW));
  });
  test(`${sport}: Sharp catalog keeps regional products distinct and adds no unsupported betting links`, () => {
    const { BOOKS } = require(`../${sport}/lib/books`), { BOOK_NAMES } = require('../shared/sharp-books');
    const byKey = new Map(BOOKS.map(book => [book.key, book]));
    assert.equal(byKey.size, BOOKS.length);
    for (const key of Object.keys(BOOK_NAMES)) assert.ok(byKey.get(key)?.src?.includes('sharp'));
    assert.notEqual(byKey.get('bet365'), byKey.get('bet365_us'));
    for (const key of ['bet365_us', 'polymarket', 'betfair_lay', 'unibet_ca']) {
      assert.equal(byKey.get(key).vegas, undefined); assert.equal(byKey.get(key).site, undefined); assert.equal(byKey.get(key).ios, undefined);
    }
  });
  test(`${sport}: newly catalog-only book columns wait for observed availability`, () => {
    const { BOOKS } = require(`../${sport}/lib/books`);
    const source = fs.readFileSync(path.join(root, sport, 'server.js'), 'utf8');
    const fed = new Set(['bet365_us']);
    const ctx = vm.createContext({ BOOKS, weeks: new Map(), defId: null, curId: null, cal: { season: 2026, weeks: [] },
      Group: { person: () => null }, Bets: { list: () => [] }, tracked: () => [], feeds: () => fed,
      LIVE_MS: 8000, OWNER_NAME: '', ACCESS_CODE: '' });
    vm.runInContext(source.slice(source.indexOf('function snapshot('), source.indexOf('// ---------------------------------------------------------------- SSE')), ctx);
    const first = ctx.snapshot('owner').books;
    assert.equal(first.find(book => book.key === 'bet365_us').feed, true);
    assert.equal(first.some(book => book.key === 'polymarket'), false);
    assert.ok(first.some(book => book.key === 'bet365'));
    assert.ok(first.some(book => book.key === 'circa'));
    fed.add('polymarket');
    assert.equal(ctx.snapshot('owner').books.find(book => book.key === 'polymarket').feed, true);
  });
}

function uiHarness(sport) {
  const el = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, classList: { toggle() {} } };
  const ctx = vm.createContext({ console, Date, Math, Set, Map, WeakMap, JSON, Number, String, Intl, URLSearchParams, setTimeout, clearTimeout,
    location: { hash: '' }, history: { replaceState() {} }, window: { addEventListener() {} },
    document: { addEventListener() {}, querySelector() { return el; }, querySelectorAll() { return []; } }, localStorage: { getItem() { return null; } },
    fetch() { throw Error('Network forbidden in tests'); } });
  for (const file of ['core', 'integrity']) vm.runInContext(fs.readFileSync(path.join(root, sport, 'public/js', file + '.js'), 'utf8'), ctx);
  return ctx;
}
for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport}: delivery-only Sharp prices have an honest label without enabling actions or devig`, () => {
    const E = harness(sport); E.sharp([event({ pin: line() })]);
    const L = E.ctx.mergedBooks(game(), E.W).pin, ui = uiHarness(sport);
    const html = ui.quoteStatusHTML(L, game(), 's', 'home');
    assert.match(html, />Feed quote<\/small>/);
    assert.match(html, /Provider delivery time is known; sportsbook observation time is unavailable/);
    assert.equal(ui.quoteFreshness(L, game(), 's', 'home').status, 'UNVERIFIED');
    assert.equal(ui.quoteCanAct(L, game(), 's', 'home'), false);
    assert.equal(ui.quotePairCanDevig(L, game(), 's'), false);
    assert.equal(ui.provenanceSource('sharp'), 'WebSocket API');
  });
  test(`${sport}: delivery label does not conceal other invalidity or conflict`, () => {
    const E = harness(sport); E.sharp([event({ pin: line() })]);
    const L = E.ctx.mergedBooks(game(), E.W).pin, ui = uiHarness(sport);
    for (const patch of [
      { reason_code: 'MISSING_QUOTE_PROVENANCE' }, { source: 'owls' }, { snapshot_id: null },
      { source_observed_at: iso(NOW + 1000000) }, { provider_received_at: 'invalid' },
      { provider_received_at: iso(Date.now() + 1000000) }, { provider_received_at: '2026-09-22T12:00:00' },
      { market_status: 'suspended' }, { market_status: 'removed' }, { conflict: true }, { source_conflict: true },
      { american_odds: null }, { american_odds: -99 }, { line_value: null }, { is_live: null }, { is_live: true },
      { line_value: -9 }, { american_odds: -115 }, { selection: 'away' },
    ]) {
      const changed = structuredClone(L); Object.assign(changed.integrity.s.home, patch);
      assert.doesNotMatch(ui.quoteStatusHTML(changed, game(), 's', 'home'), /Feed quote/, JSON.stringify(patch));
      assert.equal(ui.quoteCanAct(changed, game(), 's', 'home'), false);
    }
    assert.doesNotMatch(ui.quoteStatusHTML({ ...L, m: true }, game(), 's', 'home'), /Feed quote/);
  });
  test(`${sport}: the Sharp label leaves verified provider quotes and suppressed canonical current unchanged`, () => {
    const E = harness(sport); E.owls([event({ pin: line({ observed: NOW }) })]);
    const ui = uiHarness(sport), L = E.ctx.mergedBooks(game(), E.W).pin;
    assert.match(ui.quoteStatusHTML(L, game(), 's', 'home'), /aria-label="Recent source quote"/);
    assert.equal(ui.quoteCanAct(L, game(), 's', 'home'), true);
    E.sharp([event({ bet365_us: line() })]);
    const Q = E.W.sharp.get('espn-1').books.bet365_us.integrity.s.home;
    const G = { ...game(), integrity: { markets: { 's:home': { current: null, latest_snapshot: Q, current_freshness: 'UNVERIFIED', reason_code: 'EVENT_NOT_STARTED' } } } };
    const panel = ui.integrityGamePanel(G);
    assert.doesNotMatch(panel, /Feed quote/);
    assert.match(panel, /No eligible quote/);
  });
}
