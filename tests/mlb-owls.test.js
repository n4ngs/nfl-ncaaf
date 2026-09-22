'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mlb-owls-'));
process.env.DATA_DIR = scratch;
const util = require('../mlb/lib/util');
const { OddsDay } = require('../mlb/lib/lines');
const OWLS = require('../mlb/lib/owls');
const books = require('../mlb/lib/books');
const Q = require('../mlb/lib/quote-evidence');
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const NOW = Date.now();
const copy = value => JSON.parse(JSON.stringify(value));
const game = (state = 'Live', pk = 123) => ({ pk, start: new Date(NOW - 3600000).toISOString(), state,
  home: { full: 'Los Angeles Dodgers', name: 'Dodgers', abbr: 'LAD' }, away: { full: 'San Francisco Giants', name: 'Giants', abbr: 'SF' } });
function line({ clock = NOW - 1000, live = true, spread = -1.5, total = 8.5, ml = [-140, 120] } = {}) {
  const quote = (value, odds) => ({ line_value: value, american_odds: odds, source_observed_at: clock == null ? null : new Date(clock).toISOString(),
    market_status: 'active', is_live: live, provider_event_id: 'owls-123', optionMarketId: 'market-123' });
  return { s: spread, so: [-105, -115], t: total, to: [-110, -110], ml, is_live: live, provider_event_id: 'owls-123', integrityMeta: {
    ...(spread == null ? {} : { s: { home: quote(spread, -105), away: quote(-spread, -115) } }),
    ...(total == null ? {} : { t: { over: quote(total, -110), under: quote(total, -110) } }),
    ...(ml == null ? {} : { ml: { home: quote(null, ml[0]), away: quote(null, ml[1]) } }),
  } };
}
const event = (groups = {}, more = {}) => ({ id: 'owls-123', start: game().start, home: game().home.full, away: game().away.full, books: {}, live: {}, h1: {}, ...groups, ...more });
function engine(state = 'Live') {
  let now = NOW, available = true, nextTimer = 1;
  const events = [], timers = new Map(), day = { date: '2026-09-22', games: new Map([[123, game(state)]]) };
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ module: { exports: {} }, process: { env: {} }, Date: Clock, console,
    setTimeout: (fn, wait) => { const id = nextTimer++; timers.set(id, { fn, at: now + wait }); return id; },
    setInterval: () => 0, clearTimeout: id => timers.delete(id),
    testContext: { today: () => available ? day : null, emit: (type, data) => events.push({ type, data: copy(data) }) },
    require(id) {
      if (id === '../../shared/bet-links') return require('../shared/bet-links');
      if (id === './util') return { ...util, log() {} };
      if (id === './lines') return { OddsDay };
      if (id === './books') return books;
      if (id === './quote-evidence') return Q;
      if (id === './owls' || id === './sharp') return OWLS;
      if (id === './keys') return { keys() {} };
      if (id.startsWith('./')) return {};
      return require(id);
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'mlb/lib/odds.js'), 'utf8'), context);
  vm.runInContext('ctx = testContext', context);
  return { context, day, events, timers, exports: context.module.exports,
    run: code => vm.runInContext(code, context), now: () => now, tick: ms => { now += ms; }, available: value => { available = value; },
    owls: rows => context.applyOwls({ events: rows, receivedAt: now }),
    source: (source, rows) => context.refreshLive(OWLS.match(rows, [...day.games.values()]), [...day.games.values()], now, source),
    fire() { const [id, timer] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] || []; assert.ok(timer, 'expected a pending timer'); timers.delete(id); now = Math.max(now, timer.at); timer.fn(); },
  };
}

test('MLB Owls conversion flips prices and individual metadata, preserving totals and pick-em', () => {
  const raw = line({ spread: 0 });
  const converted = OWLS.convert(raw, true);
  assert.equal(converted.rl.line, -0);
  assert.deepEqual(converted.rl.odds, [-115, -105]);
  assert.deepEqual(converted.ml, [120, -140]);
  assert.equal(converted.quote_meta.rl.home.american_odds, -115);
  assert.equal(converted.quote_meta.ml.home.american_odds, 120);
  assert.equal(converted.quote_meta.t.over.american_odds, -110);
  assert.equal(converted.provider_event_id, 'owls-123');
  assert.equal(raw.integrityMeta.ml.home.american_odds, -140);
});

test('MLB Owls matches doubleheaders by nearest start and rejects ambiguous or duplicate events', () => {
  const early = game(), late = { ...game('Live', 456), start: new Date(Date.parse(game().start) + 3 * 3600000).toISOString() };
  assert.equal(OWLS.match([event()], [early, late]).has(123), true);
  assert.equal(OWLS.match([event()], [early, { ...early, pk: 456 }]).size, 0);
  assert.equal(OWLS.match([event(), event({}, { id: 'duplicate' })], [early]).size, 0);
  assert.equal(OWLS.match([event({}, { start: 'unknown' })], [early]).size, 0);
  assert.equal(OWLS.match([event({}, { home: 'New York Mets' })], [early]).size, 0);
});

test('MLB live sources refresh independently without deleting another provider', () => {
  const E = engine(); E.run('current()');
  E.source('an', [event({ live: { dk: line({ clock: NOW - 2000 }) } })]);
  E.owls([event({ live: { pin: line() } })]);
  let live = E.exports.game(123).odds.live;
  assert.ok(live.dk); assert.ok(live.pin);
  E.source('an', []);
  live = E.exports.game(123).odds.live;
  assert.equal(live.dk, undefined); assert.ok(live.pin);
  E.source('an', [event({ live: { dk: line() } })]);
  E.owls([]);
  live = E.exports.game(123).odds.live;
  assert.ok(live.dk); assert.equal(live.pin, undefined);
});

test('MLB live selection chooses newest complete market from one source and retains other markets', () => {
  const E = engine(); E.run('current()');
  E.source('an', [event({ live: { mgm: line({ clock: NOW - 3000, spread: -1.5, total: 8.5 }) } })]);
  E.owls([event({ live: { mgm: line({ clock: NOW - 1000, spread: -2.5, total: null, ml: null }) } })]);
  const L = E.exports.game(123).odds.live.mgm;
  assert.equal(L.rl.line, -2.5); assert.equal(L.t.line, 8.5); assert.deepEqual([...L.ml], [-140, 120]);
  assert.equal(L.src, 'mixed');
  assert.equal(L.quote_meta.rl.home.source, 'owls'); assert.equal(L.quote_meta.rl.away.source, 'owls');
  assert.equal(L.quote_meta.t.over.source, 'an'); assert.equal(L.quote_meta.t.under.source, 'an');
  assert.equal(L.quote_meta.rl.home.received_at, new Date(NOW).toISOString());
});

test('MLB stale, receipt-only and partial Owls live quotes cannot replace complete fresh alternatives', () => {
  const E = engine(); E.run('current()');
  E.source('an', [event({ live: { pin: line({ clock: NOW - 2000, spread: -1.5 }) } })]);
  const partial = line({ clock: NOW - 1000, spread: -2.5 }); delete partial.integrityMeta.s.away;
  for (const raw of [line({ clock: NOW - 60000 }), line({ clock: null }), partial]) {
    E.owls([event({ live: { pin: raw } })]);
    const L = E.exports.game(123).odds.live.pin;
    assert.equal(L.rl.line, -1.5);
    assert.equal(L.quote_meta.rl.home.source, 'an');
    assert.equal(L.quote_meta.rl.away.source, 'an');
  }
});

test('MLB authoritative Owls absence marks only its pregame source missing and keeps another provider', () => {
  const E = engine('Preview');
  const D = E.run('current()');
  D.ingest(123, 'an', { dk: OWLS.convert(line({ live: false, clock: NOW - 2000, spread: -1.5 })) }, NOW);
  E.owls([event({ books: { dk: line({ live: false, spread: -2.5 }) } })]);
  assert.equal(E.exports.game(123).odds.books.dk.rl.line, -2.5);
  E.owls([event({ books: { dk: line({ live: false }) } }, { home: 'New York Mets' })]);
  const L = E.exports.game(123).odds.books.dk;
  assert.equal(L.rl.line, -1.5);
  assert.equal(L.quote_meta.rl.home.source, 'an');
  assert.equal(D.games[123].srcs.owls.dk.quote_meta.rl.home.missing_from_source, true);
});

test('MLB explicit Owls live evidence cannot alter existing pregame history or frozen close', () => {
  const E = engine(), D = E.run('current()');
  D.ingest(123, 'an', { dk: OWLS.convert(line({ live: false, spread: -1.5 })) }, NOW - 2000);
  D.freeze(123);
  const before = JSON.stringify(D.games);
  E.owls([event({ live: { dk: line({ spread: -5.5 }) } })]);
  assert.equal(JSON.stringify(D.games), before);
  assert.equal(E.exports.game(123).odds.live.dk.rl.line, -5.5);
});

test('MLB Owls bursts publish newest live state once after 50ms', () => {
  const E = engine();
  E.owls([event({ live: { pin: line({ spread: -1.5 }) } })]);
  E.owls([event({ live: { pin: line({ spread: -2.5 }) } })]);
  assert.equal(E.timers.size, 1);
  assert.equal([...E.timers.values()][0].at - NOW, 50);
  E.fire();
  const pushed = E.events.filter(row => row.type === 'odds');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].data.live.pin.rl.line, -2.5);
});

test('MLB trailing Owls update is rescheduled when another push consumed its 50ms budget', () => {
  const E = engine(); E.owls([event({ live: { pin: line() } })]); E.fire();
  E.tick(110); E.owls([event({ live: { pin: line({ spread: -2.5 }) } })]);
  E.tick(40); E.run('flush()');
  E.tick(5); E.owls([event({ live: { pin: line({ spread: -3.5 }) } })]);
  E.fire();
  assert.equal(E.run('pending.size'), 1);
  assert.equal(E.timers.size, 1, 'trailing update must not wait for the one-second polling loop');
  E.fire();
  assert.equal(E.events.filter(row => row.type === 'odds').at(-1).data.live.pin.rl.line, -3.5);
  assert.equal(E.run('pending.size'), 0);
});

test('MLB Action refresh cannot downgrade an already queued Owls fast update', () => {
  const E = engine(); E.owls([event({ live: { pin: line() } })]);
  E.source('an', [event({ live: { dk: line() } })]);
  assert.equal(E.run('pending.get(123).fast'), true);
});

test('MLB live coverage includes streaming-only books with no Action book ID', () => {
  const E = engine(); E.owls([event({ live: { pin: line(), ps3838: line() } })]);
  const coverage = E.exports.snapshot().coverage;
  assert.equal(coverage.by_book.pin.available_markets, 3);
  assert.equal(coverage.by_book.ps3838.available_markets, 3);
  assert.equal(coverage.books_with_prices, 2);
});

test('MLB retains initial Owls state until a delayed day model can match it', () => {
  const E = engine(); E.available(false);
  E.owls([event({ live: { pin: line() } })]);
  E.available(true); E.context.applyOwls();
  const result = E.exports.game(123);
  assert.ok(result?.odds.live.pin);
  assert.equal(result.odds.live.pin.quote_meta.rl.home.received_at, new Date(NOW).toISOString());
});


test('MLB Sharp stream preserves primary feed prices without creating source-clock evidence', () => {
  const E=engine(); const raw=line({clock:null});
  for(const sides of Object.values(raw.integrityMeta)) for(const q of Object.values(sides)) q.provider_received_at=new Date(NOW).toISOString();
  E.context.applySharp({events:[event({live:{bet365_us:raw}})],receivedAt:NOW}); E.fire();
  const L=E.exports.game(123).odds.live.bet365_us;
  assert.equal(L.src,'sharp');assert.equal(L.quote_meta.rl.home.source_observed_at,null);
  assert.equal(L.quote_meta.rl.home.provider_received_at,new Date(NOW).toISOString());
  assert.equal(L.actionable,false);assert.equal(E.events.filter(r=>r.type==='odds').length,1);
});
test('MLB Sharp delivery-only quotes cannot replace verified Owls or fabricate movement', () => {
  const E=engine();E.owls([event({live:{pin:line({spread:-1.5})}})]);
  E.context.applySharp({events:[event({live:{pin:line({clock:null,spread:-2.5})}})],receivedAt:NOW});
  assert.equal(E.exports.game(123).odds.live.pin.rl.line,-1.5);
  assert.equal(E.exports.game(123).odds.live.pin.quote_meta.rl.home.source,'owls');
  E.owls([]);assert.equal(E.exports.game(123).odds.live.pin.rl.line,-2.5);
  assert.equal(E.events.filter(r=>r.type==='move').length,0);
  E.context.applySharp({events:[],receivedAt:NOW});assert.equal(E.exports.game(123).odds.live.pin,undefined);
});
test('MLB Sharp refresh-only clocks do not trigger another price redraw', () => {
  const E=engine();const raw=line({clock:null});
  for(const sides of Object.values(raw.integrityMeta))for(const q of Object.values(sides))q.provider_received_at=new Date(NOW).toISOString();
  E.context.applySharp({events:[event({live:{pin:raw}})],receivedAt:NOW});E.fire();
  E.tick(1000);for(const sides of Object.values(raw.integrityMeta))for(const q of Object.values(sides))q.provider_received_at=new Date(NOW+1000).toISOString();
  E.context.applySharp({events:[event({live:{pin:raw}})],receivedAt:NOW+1000});
  assert.equal(E.run('pending.size'),0);
});
test('MLB book list shows active added books without catalog-only columns', () => {
  const E=engine();E.context.applySharp({events:[event({live:{bet365_us:line({clock:null})}})],receivedAt:NOW});
  const books=E.exports.snapshot().books.map(b=>b.key);
  assert.ok(books.includes('bet365_us'));assert.ok(books.includes('circa'));assert.ok(!books.includes('goldrush'));
});

test('MLB unavailable Sharp pair yields to an active untimed fallback pregame and live',()=>{
 for(const state of ['Preview','Live']) {
  const E=engine(state),live=state==='Live',group=live?'live':'books';const active=line({live,clock:null,ml:[-140,120]}),closed=line({live,clock:null,ml:[-150,130]});
  for(const sides of Object.values(closed.integrityMeta))for(const q of Object.values(sides))q.market_status='suspended';
  E.owls([event({[group]:{pin:active}})]);E.context.applySharp({events:[event({[group]:{pin:closed}})],receivedAt:NOW});
  assert.equal(E.exports.game(123).odds[group].pin.ml[0],-140);
  assert.equal(E.exports.game(123).odds[group].pin.quote_meta.ml.home.source,'owls');
 }
});
