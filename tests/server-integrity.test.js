'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { IntegrityStore, freshness } = require('../shared/clv-integrity');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-integrity-'));
process.env.DATA_DIR = temp;
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
let counter = 0;
function store(sport) { return new IntegrityStore({ sport, dataDir: path.join(temp, String(++counter)) }); }
function helpers(sport, integrity) {
  const source = fs.readFileSync(path.join(root, sport, 'server.js'), 'utf8');
  const start = source.indexOf('function retainObservation(');
  const end = source.indexOf('function weekSnapshot(');
  const context = vm.createContext({ integrity, freshness, Date, VSIN_AT: {}, BOOKS: [] });
  vm.runInContext(source.slice(start, end), context);
  return context;
}
for (const sport of ['nfl', 'ncaaf']) {
  const AN = require(`../${sport}/lib/action`);
  test(`${sport}: provider side identity, timestamp and option ID survive ingestion`, () => {
    const at = Date.now() - 1000;
    const L = AN.readMarkets({ spread: [
      { team_id: 1, value: -2.5, odds: -110, updated_at: new Date(at).toISOString(), optionId: 11, optionMarketId: 9, fixtureId: '6:123' },
      { team_id: 2, value: 3, odds: -105, updated_at: new Date(at).toISOString(), optionId: 12, optionMarketId: 9, fixtureId: '6:123' },
    ] }, { 1: 'home', 2: 'away' }, false);
    const ledger = store(sport);
    const ctx = helpers(sport, ledger);
    const G = { id: '123', start: new Date(at + 300000).toISOString(), state: 'pre' };
    const line = ctx.retainObservation(G, 'mgm', L, 'an', at + 100, false, 'full_game', 456);
    const home = line.integrity.s.home, away = line.integrity.s.away;
    assert.equal(home.line_value, -2.5);
    assert.equal(away.line_value, 3, 'do not infer unobserved +2.5 away handicap');
    assert.equal(home.provider_event_id, 456);
    assert.equal(home.fixtureId, '6:123');
    assert.equal(home.optionId, 11);
    assert.equal(home.source_observed_at, new Date(at).toISOString());
    assert.equal(home.canonical_market_key, away.canonical_market_key);
    const changed = AN.readMarkets({ spread: [{ team_id: 1, value: -3.5, odds: -110, updated_at: new Date(at + 200).toISOString(), optionId: 99 }] }, { 1: 'home' }, false);
    const updated = ctx.retainObservation(G, 'mgm', changed, 'an', at + 300, false, 'full_game', 456);
    assert.equal(updated.integrity.s.home.canonical_market_key, home.canonical_market_key);
    assert.equal(updated.integrity.s.home.fixtureId, null, 'Action event ID is not a BetMGM fixtureId');
    assert.equal(updated.integrity.s.away, undefined, 'absent side must not be fabricated');
  });
  test(`${sport}: received timestamp never masquerades as quote freshness`, () => {
    const now = Date.now();
    const ledger = store(sport), ctx = helpers(sport, ledger);
    const L = AN.readMarkets({ total: [{ side: 'over', value: 51, odds: -110 }] }, {}, false);
    const line = ctx.retainObservation({ id: '124', start: new Date(now + 600000).toISOString() }, 'mgm', L, 'an', now);
    const view = ctx.quoteView(line);
    assert.equal(view.freshness, 'UNVERIFIED');
    assert.equal(view.source_observed_at, null);
    assert.equal(view.integrity.t.over.source_observed_at, null);
    assert.equal(view.integrity.t.over.received_at, new Date(now).toISOString());
  });
  test(`${sport}: suspended odds remain transparent but cannot be canonical close`, () => {
    const now = Date.now(), kickoff = now - 1000;
    const G = { id: '125', start: new Date(kickoff).toISOString(), state: 'post' };
    const L = AN.readMarkets({ spread: [{ team_id: 1, value: -3, odds: -110, status: 'suspended', updated_at: new Date(kickoff - 1000).toISOString() }] }, { 1: 'home' }, false);
    const ledger = store(sport), ctx = helpers(sport, ledger);
    const line = ctx.retainObservation(G, 'dk', L, 'an', kickoff - 900);
    assert.equal(ctx.quoteView(line).freshness, 'SUSPENDED');
    assert.equal(ledger.resolve(G, 's', 'home', 'dk', now).close, null);
  });
  test(`${sport}: first-half observations keep period and independent market identity`, () => {
    const now = Date.now(), G = { id: '126', start: new Date(now + 500000).toISOString() };
    const ledger = store(sport), ctx = helpers(sport, ledger);
    const L = { s: -1, so: [-110, -110], t: 24.5, to: [-105, -115], source_observed_at: new Date(now - 2000).toISOString(), market_status: 'active' };
    const half = ctx.retainObservation(G, 'mgm', L, 'an1', now, false, 'first_half');
    assert.equal(half.integrity.h1s.home.period, 'first_half');
    assert.equal(half.integrity.s, undefined);
    assert.equal(half.integrity.h1t.over.line_value, 24.5);
    assert.equal(ledger.resolve(G, 'h1s', 'home', 'mgm').current.snapshot_id, half.integrity.h1s.home.snapshot_id);
  });
  test(`${sport}: legacy close is preserved as raw context and never used as canonical`, () => {
    const now = Date.now(), G = { id: '127', start: new Date(now - 1000).toISOString(), state: 'post' };
    const ledger = store(sport), ctx = helpers(sport, ledger);
    const raw = { close: { s: -2.5, t: 48, at: now }, open: { s: -1.5 } };
    const W = { an: new Map(), a1: new Map(), vs: new Map(), pin: new Map(), at: {}, lines: { full: () => raw } };
    const H = ctx.integrityHistory(G, W);
    assert.equal(H.close, null);
    assert.equal(H.legacy_close.s, -2.5);
    assert.equal(raw.close.s, -2.5);
    assert.equal(H.classification, 'RETROSPECTIVE_MARKET_MOVE');
  });
  test(`${sport}: live and post-kick observations never become a pregame close`, () => {
    const now = Date.now(), G = { id: '128', start: new Date(now - 10000).toISOString(), state: 'in' };
    const ledger = store(sport), ctx = helpers(sport, ledger);
    const L = { s: -14, so: [-110, -110], source_observed_at: new Date(now - 1000).toISOString(), market_status: 'active' };
    ctx.retainObservation(G, 'dk', L, 'an', now, true);
    const resolution = ledger.resolve(G, 's', 'home', 'dk', now);
    assert.equal(resolution.current.line_value, -14);
    assert.equal(resolution.close, null);
    assert.equal(resolution.reason_code, 'POST_KICK_CONTAMINATION');
  });
  test(`${sport}: source-timed fallback survives receipt-only feed precedence`, () => {
    const now = Date.now(), G = { id: '130', start: new Date(now + 500000).toISOString(), state: 'pre' };
    const ledger = store(sport), ctx = helpers(sport, ledger);
    const untimed = ctx.retainObservation(G, 'mgm', { s: -3, so: [-110, -110], market_status: 'active' }, 'an', now);
    const timed = ctx.retainObservation(G, 'mgm', { s: -2.5, so: [-105, -115], market_status: 'active', source_observed_at: new Date(now - 1000).toISOString() }, 'vsin', now);
    const W = { an: new Map([[G.id, { books: { mgm: untimed } }]]), a1: new Map(), vs: new Map([[G.id, { books: { mgm: timed } }]]), pin: new Map(), at: {} };
    const result = ctx.mergedBooks(G, W);
    assert.equal(result.mgm.src, 'vsin');
    assert.equal(result.mgm.s, -2.5);
    assert.equal(result.mgm.integrity.s.home.source, 'vsin');
    assert.equal(result.mgm.integrity.s.away.source, 'vsin');
    assert.equal(ledger.snapshots.size, 4, 'both source observations remain immutable');
  });
  test(`${sport}: live game state cannot relabel provider pregame evidence`, () => {
    const now = Date.now(), G = { id: '131', start: new Date(now - 10000).toISOString(), state: 'in' };
    const ledger = store(sport), ctx = helpers(sport, ledger);
    const L = { s: -3, so: [-110, -110], source_observed_at: new Date(now - 1000).toISOString(), market_status: 'active', is_live: false };
    const observed = ctx.retainObservation(G, 'mgm', L, 'an1', now, true);
    assert.equal(observed.is_live, false, 'provider flag wins over caller game-state inference');
    assert.equal(observed.integrity.s.home.is_live, false);
    const resolved = ledger.resolve(G, 's', 'home', 'mgm', now);
    assert.equal(resolved.current, null, 'pregame quote cannot become live current');
    assert.equal(resolved.close, null, 'post-start quote cannot become close');
  });
  test(`${sport}: canonical arrays never imply a devig pair across books or mismatched lines`, () => {
    const now = Date.now(), ledger = store(sport), ctx = helpers(sport, ledger);
    const G = { id: '132', start: new Date(now + 600000).toISOString() };
    const L = { s: -3, so: [-110, -110], source_observed_at: new Date(now - 1000).toISOString(), market_status: 'active' };
    const a = ctx.retainObservation(G, 'mgm', L, 'an1', now);
    const b = ctx.retainObservation(G, 'dk', L, 'espn', now);
    const mismatched = ctx.canonicalLine({ 's:home': { current: a.integrity.s.home }, 's:away': { current: b.integrity.s.away } }, 'current');
    assert.equal(mismatched.so[0], -110);
    assert.equal(mismatched.so[1], null);
    const paired = ctx.canonicalLine({ 's:home': { current: a.integrity.s.home }, 's:away': { current: a.integrity.s.away } }, 'current');
    assert.equal(paired.so[1], -110);
    assert.equal(ctx.quoteView(a).reason_code, null, 'fresh quotes have no missing timestamp reason');
  });
  test(`${sport}: connected tickets receive CLV transitions without grading or clock churn`, () => {
    const source = fs.readFileSync(path.join(root, sport, 'server.js'), 'utf8');
    const messages = [], response = { uid: 'owner', write: (message) => messages.push(message) };
    const result = { status: 'MISSING_CLOSE', resolution: { resolved_at: '2026-09-22T00:00:00Z', current_freshness: { age_ms: 1000, status: 'FRESH' } } };
    const context = vm.createContext({ clients: new Set([response]), Bets: { byOwner: () => new Map([['owner', [{ id: 'ticket', legs: [{ integrity: result }] }]]]) } });
    vm.runInContext(source.slice(source.indexOf('function emitBets()'), source.indexOf('function emitSnapshot()')), context);
    context.emitBets();
    assert.equal(messages.length, 1);
    result.resolution.resolved_at = '2026-09-22T00:00:01Z'; result.resolution.current_freshness.age_ms = 2000;
    context.emitBets();
    assert.equal(messages.length, 1, 'changing only observation age does not repush tickets');
    result.status = 'PROVISIONAL_CLV';
    context.emitBets();
    assert.equal(messages.length, 2, 'kickoff eligibility change reaches already connected ticket');
    assert.ok(messages[1].includes('PROVISIONAL_CLV'));
  });
  test(`${sport}: canonical close survives current-source staleness and receipt-only fallback`, () => {
    const now = Date.now(), kickoff = now - 20 * 60e3;
    const G = { id: '133', start: new Date(kickoff).toISOString(), state: 'post' };
    const ledger = store(sport), ctx = helpers(sport, ledger);
    const timed = ctx.retainObservation(G, 'mgm', { s: -3, so: [-110, -110], source_observed_at: new Date(kickoff - 1000).toISOString(), market_status: 'active' }, 'vsin', kickoff - 900);
    const untimed = ctx.retainObservation(G, 'mgm', { s: -4, so: [-110, -110], market_status: 'active' }, 'an', now);
    const W = { an: new Map([[G.id, { books: { mgm: untimed } }]]), a1: new Map(), vs: new Map([[G.id, { books: { mgm: timed } }]]), pin: new Map(), at: {} };
    const books = ctx.mergedBooks(G, W);
    assert.equal(books.mgm.src, 'an', 'all source quotes have aged out of present actionability');
    const markets = ctx.resolvedMarkets(G, W, books);
    assert.equal(markets['s:home'].close.line_value, -3);
    assert.equal(markets['s:home'].close.source, 'vsin');
    assert.equal(markets['s:home'].close_status, 'PROVISIONAL');
  });
  test(`${sport}: unchanged games do not flood SSE with resolution/age clock changes`, () => {
    const source = fs.readFileSync(path.join(root, sport, 'server.js'), 'utf8');
    const W = { games: new Map([['134', { id: '134' }]]), sent: new Map() }, events = [];
    const publicGame = { id: '134', integrity: { resolved_at: '2026-09-22T00:00:00Z', current_freshness: { status: 'FRESH', age_ms: 1000 } } };
    const context = vm.createContext({ tracked: () => [W], pub: () => publicGame, clients: new Set([{}]), emit: (...v) => events.push(v) });
    vm.runInContext(source.slice(source.indexOf('function flush(W)'), source.indexOf('// ---------------------------------------------------------------- ESPN')), context);
    context.flush(W); publicGame.integrity.resolved_at = '2026-09-22T00:00:01Z'; publicGame.integrity.current_freshness.age_ms = 2000; context.flush(W);
    assert.equal(events.length, 1);
    publicGame.integrity.current_freshness.status = 'STALE'; context.flush(W);
    assert.equal(events.length, 2, 'meaningful freshness transition still publishes');
  });
  test(`${sport}: no-price suspended provider markets are journaled and veto prior active close`, async () => {
    const now = Date.now(), kickoff = now - 1000;
    const G = { id: '135', start: new Date(kickoff).toISOString(), state: 'post' };
    const source = fs.readFileSync(path.join(root, sport, 'lib/pinnacle.js'), 'utf8');
    const context = vm.createContext({ module: { exports: {} }, require: () => ({
      getBody: async () => [{ id: 135, type: 'matchup', startTime: G.start, isLive: false, participants: [{ alignment: 'home', name: 'Home' }, { alignment: 'away', name: 'Away' }] }],
      getJSON: async () => ({ body: [{ matchupId: 135, type: 'spread', period: 0, status: 'suspended', updatedAt: new Date(kickoff - 500).toISOString(), prices: [] }], headers: { get: () => '0' } }),
      num: (x) => x == null || x === '' ? null : Number(x), nameScore: () => 4, log: () => {},
    }) });
    vm.runInContext(source, context);
    const observations = await context.module.exports.fetchPinnacle();
    assert.equal(observations.length, 1, 'empty-price suspension must not disappear');
    const ledger = store(sport), ctx = helpers(sport, ledger);
    ctx.retainObservation(G, 'pin', { s: -3, so: [-110, -110], source_observed_at: new Date(kickoff - 2000).toISOString(), market_status: 'active' }, 'pin', kickoff - 1900);
    const suspended = ctx.retainObservation(G, 'pin', observations[0].full, 'pin', kickoff - 400);
    assert.equal(suspended.integrity.s.home.market_status, 'suspended');
    assert.equal(suspended.integrity.s.home.american_odds, null);
    assert.equal(ledger.resolve(G, 's', 'home', 'pin', now).close, null);
    const patch = AN.parseV1({ games: [{ id: 136, odds: [{ book_id: 18, type: 'game', status: 'suspended', inserted: new Date(kickoff - 500).toISOString() }] }] }, [], new Map([[136, { id: '135', side: {}, swap: false }]])).get('135');
    assert.ok(patch.books.stn, 'Action v1 empty-price suspension must not disappear');
  });
  const MGM = require(`../${sport}/lib/betmgm`);
  test(`${sport}: BetMGM mapping needs both teams and scheduled event`, async () => {
    const G = { id: '129', start: '2026-09-22T00:00:00Z', home: { name: 'Home Team' }, away: { name: 'Away Team' } };
    assert.equal(MGM.matchEvent([{ home_team: 'Home Team', away_team: 'Other Team', commence_time: G.start }], G), null);
    assert.equal(MGM.matchEvent([{ home_team: 'Home Team', away_team: 'Away Team', commence_time: '2026-09-29T00:00:00Z' }], G), null);
    const link = await MGM.linkFor(G, 'h1s', 'home');
    assert.ok(link.includes('/search?'), 'first-half must never resolve full-game spread');
    assert.ok(!link.includes('options='));
  });
}
