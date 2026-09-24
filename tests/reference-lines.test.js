'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const R = require('../shared/reference-lines');

const START = '2026-09-25T00:15:00Z';
const res = (body, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => body });
const settle = async () => { for (let i = 0; i < 400; i++) await Promise.resolve(); };
const owlsEvent = { id: 'nfl:atlantafalcons@greenbaypackers:2026-09-25T00:15:00.000Z', away: 'Atlanta Falcons', home: 'Green Bay Packers', start: START, books: { dk: {}, circa: {}, novig: {} }, live: {}, h1: {} };
const sharpEvent = { id: 'sharp:nfl:x', away: 'Atlanta Falcons', home: 'Green Bay Packers', start: START, books: { dk: { provider_event_id: 'nfl_falcons_packers_2026-09-24_b3' } }, live: {} };

function harness(fetchImpl, extra = {}) {
  let clock = Date.parse(START) - 86400e3; const calls = [], updates = [];
  const svc = R.createReferenceLines({ owlsKey: 'owls-secret', sharpKey: 'sharp-secret', now: () => clock, owlsGapMs: 0,
    setTimeout: (fn, ms) => { if (ms <= 2000) Promise.resolve().then(fn); return 1; }, clearTimeout: () => {},
    fetchImpl: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); },
    onUpdate: (sport, snap) => updates.push({ sport, snap }), ...extra });
  return { svc, calls, updates, tick: ms => { clock += ms; }, set: t => { clock = t; } };
}

test('game keys and Owls event ids follow the provider formats', () => {
  assert.equal(R.gameKey('nfl', 'Atlanta Falcons', 'Green Bay Packers', START), 'nfl:atlantafalcons@greenbaypackers:2026-09-25T00:15');
  assert.equal(R.owlsEventId('nfl', 'Atlanta Falcons', 'Green Bay Packers', START), 'nfl:Atlanta Falcons@Green Bay Packers-20260925');
  assert.equal(R.gameKey('nfl', 'A', 'B', 'not a date'), null);
});

test('openers come from Owls history per book/market/side, only for books the event carries, with the credential only in the header', async () => {
  const h = harness(async (url) => {
    const q = new URL(url).searchParams;
    const point = q.get('market') === 'totals' ? '46.5' : q.get('side') === 'home' ? '-7.50' : '7.50';
    return res({ success: true, data: { openingLine: { price: -110, point, timestamp: '2026-05-14T20:08:22.093Z' } } }, 200, { 'x-ratelimit-remaining-month': '290000' });
  });
  h.svc.start(); h.svc.observe('owls', 'nfl', [owlsEvent]); h.svc.sweep(); await settle();
  // dk + circa (novig is not a reference book) x 3 markets x 2 sides
  assert.equal(h.calls.length, 12);
  assert.ok(h.calls.every(c => c.init.headers.Authorization === 'Bearer owls-secret' && !c.url.includes('secret') && c.init.redirect === 'error'));
  assert.ok(h.calls.every(c => new URL(c.url).searchParams.get('eventId') === 'nfl:Atlanta Falcons@Green Bay Packers-20260925'));
  const g = h.svc.snapshot('nfl').games['nfl:atlantafalcons@greenbaypackers:2026-09-25T00:15'];
  assert.deepEqual(g.open.dk.s, { prices: [-110, -110], observed_at: ['2026-05-14T20:08:22.093Z', '2026-05-14T20:08:22.093Z'], source: 'owls_history', line: -7.5 });
  assert.equal(g.open.circa.t.line, 46.5);
  assert.equal(h.svc.status().owls.remainingMonth, 290000);
  assert.equal(JSON.stringify(h.svc.status()).includes('secret'), false);
  // Openers are fetched once: a second sweep costs nothing.
  h.svc.sweep(); await settle(); assert.equal(h.calls.length, 12);
  h.svc.stop();
});

test('a book with no opener yet is retried only after six hours; a 429 pauses history calls', async () => {
  let mode = 'empty';
  const h = harness(async () => mode === 'limited' ? res({}, 429, { 'retry-after': '120' }) : res({ success: true, data: { openingLine: null } }));
  h.svc.start(); h.svc.observe('owls', 'nfl', [{ ...owlsEvent, books: { dk: {} } }]); h.svc.sweep(); await settle();
  assert.equal(h.calls.length, 6);
  h.tick(3600e3); h.svc.sweep(); await settle(); assert.equal(h.calls.length, 6);
  h.tick(6 * 3600e3); mode = 'limited'; h.svc.sweep(); await settle();
  assert.equal(h.calls.length, 7); assert.ok(h.svc.status().owls.blockedUntil > 0);
  h.svc.stop();
});

test('closes come from Sharp closing snapshots after the start, keep the balanced main line and capture metadata', async () => {
  const row = (market_type, selection_type, line, odds, at = '2026-09-25T00:14:50Z') => ({ market_type, selection_type, line, odds_american: odds, source_updated_at: at });
  const body = { success: true, data: { event_id: 'nfl_falcons_packers_2026-09-24_b3', books: {
    draftkings: { captured_at: '2026-09-25T00:18:00Z', seconds_before_kickoff: -180, capture_trigger: 'transition', is_final: true, odds: [
      row('point_spread', 'home', -5.5, -105), row('point_spread', 'away', 5.5, -115),
      row('point_spread', 'home', -9.5, 240), row('point_spread', 'away', 9.5, -320),
      row('total_points', 'over', 42.5, -118), row('total_points', 'under', 42.5, -102),
      row('moneyline', 'home', null, -250), row('moneyline', 'away', null, 205),
      row('player_passing_yards', 'over', 250.5, -110) ] },
    prizepicks: { odds: [row('moneyline', 'home', null, -120)] } } } };
  const h = harness(async () => res(body));
  h.svc.start(); h.svc.observe('sharp', 'nfl', [sharpEvent]);
  h.svc.sweep(); await settle(); assert.equal(h.calls.length, 0, 'no close before kickoff');
  h.set(Date.parse(START) + 6 * 60e3); h.svc.sweep(); await settle();
  assert.equal(h.calls.length, 1);
  const u = new URL(h.calls[0].url);
  assert.equal(u.pathname, '/api/v1/odds/closing'); assert.equal(u.searchParams.get('event_id'), 'nfl_falcons_packers_2026-09-24_b3');
  assert.equal(h.calls[0].init.headers['X-API-Key'], 'sharp-secret');
  const close = h.svc.snapshot('nfl').games['nfl:atlantafalcons@greenbaypackers:2026-09-25T00:15'].close;
  assert.deepEqual(Object.keys(close), ['dk']);
  assert.equal(close.dk.s.line, -5.5); assert.deepEqual(close.dk.s.prices, [-105, -115]);
  assert.equal(close.dk.t.line, 42.5); assert.deepEqual(close.dk.ml.prices, [-250, 205]);
  assert.equal(close.dk.capture_trigger, 'transition'); assert.equal(close.dk.seconds_before_kickoff, -180);
  h.svc.sweep(); await settle(); assert.equal(h.calls.length, 1, 'a close is fetched once');
  h.svc.stop();
});

test('an empty closing answer is retried ten minutes later, and never after six hours', async () => {
  const h = harness(async () => res({ success: true, data: { books: {} } }));
  h.svc.start(); h.svc.observe('sharp', 'nfl', [sharpEvent]);
  h.set(Date.parse(START) + 6 * 60e3); h.svc.sweep(); await settle(); assert.equal(h.calls.length, 1);
  h.tick(5 * 60e3); h.svc.sweep(); await settle(); assert.equal(h.calls.length, 1);
  h.tick(6 * 60e3); h.svc.sweep(); await settle(); assert.equal(h.calls.length, 2);
  h.set(Date.parse(START) + 7 * 3600e3); h.svc.sweep(); await settle(); assert.equal(h.calls.length, 2);
  h.svc.stop();
});

test('reference lines persist to disk and reach an engine over IPC without credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-')); const file = path.join(dir, 'reference-lines.json');
  const h = harness(async () => res({ success: true, data: { openingLine: { price: -110, point: '-7.5', timestamp: '2026-05-14T20:08:22Z' } } }), { file });
  h.svc.start(); h.svc.observe('owls', 'nfl', [{ ...owlsEvent, books: { dk: {} } }]); h.svc.sweep(); await settle(); await settle();
  assert.ok(fs.existsSync(file)); assert.equal(fs.readFileSync(file, 'utf8').includes('secret'), false);
  const again = R.createReferenceLines({ file, owlsKey: 'k' });
  assert.equal(again.snapshot('nfl').games['nfl:atlantafalcons@greenbaypackers:2026-09-25T00:15'].open.dk.s.line, -7.5);

  const child = new EventEmitter(); child.connected = true; const sent = [];
  child.send = (m, cb) => { sent.push(m); cb?.(); };
  const relay = R.relayToChild(child, 'nfl', h.svc);
  const engine = new EventEmitter(); engine.send = (m) => child.emit('message', m);
  child.on('newListener', () => {});
  // Engine side listens on its own process object; wire the child's outbound messages to it.
  child.send = (m, cb) => { sent.push(m); engine.emit('message', m); cb?.(); };
  const sub = R.subscribe('nfl', null, engine);
  assert.equal(sent.length, 1); assert.equal(sent[0].type, 'ref:update');
  assert.equal(JSON.stringify(sent).includes('secret'), false);
  assert.equal(sub.lookup('Atlanta Falcons', 'Green Bay Packers', START).open.dk.s.line, -7.5);
  assert.equal(sub.lookup('Atlanta Falcons', 'Green Bay Packers', '2026-09-26T00:15:00Z'), null);
  relay.close(); sub.close(); h.svc.stop();
});

test('disabled without credentials: no timers, no calls', () => {
  const svc = R.createReferenceLines({ fetchImpl: () => { throw new Error('no'); } });
  svc.start(); assert.equal(svc.status().enabled, false); svc.stop();
});

test('a football spread opener at 0 with lopsided prices (upstream BetMGM fault) and half-fetched openers are withheld', async () => {
  const h = harness(async (url) => {
    const q = new URL(url).searchParams;
    if (q.get('market') === 'h2h' && q.get('side') === 'away') return res({ success: true, data: { openingLine: null } });
    const price = q.get('market') === 'spreads' ? (q.get('side') === 'home' ? 110 : -145) : -110;
    return res({ success: true, data: { openingLine: { price, point: q.get('market') === 'spreads' ? '0' : '44.5', timestamp: '2026-09-22T22:34:29Z' } } });
  });
  h.svc.start(); h.svc.observe('owls', 'nfl', [{ ...owlsEvent, books: { mgm: {} } }]); h.svc.sweep(); await settle();
  const g = h.svc.snapshot('nfl').games['nfl:atlantafalcons@greenbaypackers:2026-09-25T00:15'];
  assert.deepEqual(Object.keys(g.open.mgm), ['t']);
  h.svc.stop();
});

test('engine lookup tolerates provider spelling differences only when exactly one game matches', () => {
  const peer = new EventEmitter(); peer.send = () => {};
  const sub = R.subscribe('ncaaf', null, peer);
  peer.emit('message', { type: 'ref:update', sport: 'ncaaf', games: {
    'ncaaf:miamiohredhawks@toledorockets:2026-09-26T19:00': { open: { dk: {} }, close: null },
    'ncaaf:houstoncougars@georgiasoutherneagles:2026-09-26T19:00': { open: { circa: {} }, close: null } } });
  assert.deepEqual(Object.keys(sub.lookup('Miami (OH) RedHawks', 'Toledo Rockets', '2026-09-26T19:00:00Z').open), ['dk']);
  assert.deepEqual(Object.keys(sub.lookup('Houston', 'Georgia Southern', '2026-09-26T19:00:00Z').open), ['circa']);
  assert.equal(sub.lookup('Houston', 'Georgia Southern', '2026-09-26T20:00:00Z'), null);
  sub.close();
});

test('reference observations enter the integrity ledger: a months-old opener is the open, a kickoff-frozen close is the close received after kickoff', (t) => {
  const { IntegrityStore } = require('../shared/clv-integrity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-clv-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new IntegrityStore({ dataDir: dir, sport: 'nfl' });
  const kick = Date.parse(START), at = ms => new Date(kick + ms).toISOString();
  const event = { id: '401872948', start: START };
  const meta = (market, clocks) => ({ [market]: Object.fromEntries((market === 't' ? ['over', 'under'] : ['home', 'away']).map((s, i) => [s, { source_observed_at: clocks[i], market_status: 'active' }])) });
  // Opener: observed 2026-05-14, received now (before kickoff).
  store.observeLine(event, 'dk', { s: -7.5, so: [-110, -110], integrityMeta: meta('s', ['2026-05-14T20:08:22.093Z', '2026-05-14T20:08:22.093Z']) }, { source: 'owls_open', received_at: at(-86400e3), is_live: false, market_type: 's' });
  // Close: observed 8 s before kickoff, received 6 minutes after kickoff.
  store.observeLine(event, 'dk', { s: -5.5, so: [-105, -115], integrityMeta: meta('s', [at(-8000), at(-8000)]) }, { source: 'sharp_close', received_at: at(360e3), is_live: false, market_type: 's' });
  const open = store.resolve({ ...event, quote_source: 'owls_open' }, 's', 'home', 'dk', kick + 400e3);
  assert.equal(open.open.line_value, -7.5); assert.equal(open.open.source_observed_at, '2026-05-14T20:08:22.093Z');
  assert.equal(open.close, null, 'a months-old opener is never a close');
  const close = store.resolve({ ...event, quote_source: 'sharp_close' }, 's', 'home', 'dk', kick + 400e3);
  assert.equal(close.close.line_value, -5.5); assert.equal(close.close.american_odds, -105);
  assert.equal(close.close_status, 'PROVISIONAL');
  // Before the close was received it does not exist (no look-ahead).
  assert.equal(store.resolve({ ...event, quote_source: 'sharp_close' }, 's', 'home', 'dk', kick + 60e3).close, null);
});

test('line history: the home/over side of each opener read is saved (changes only), refreshed once after kickoff, readable by the engine', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refhist-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hist = [{ timestamp: '2026-05-14T20:08:22Z', price: -110, point: '-7.5' }, { timestamp: '2026-05-15T20:08:22Z', price: -110, point: '-7.5' },
    { timestamp: '2026-09-21T20:00:00Z', price: -112, point: '-6.5' }, { timestamp: '2026-09-25T00:20:00Z', price: -300, point: '-3.5' }];
  const h = harness(async (url) => res({ success: true, data: { openingLine: { price: -110, point: '-7.5', timestamp: '2026-05-14T20:08:22Z' }, history: hist } }), { histDir: dir });
  h.svc.start(); h.svc.observe('owls', 'nfl', [{ ...owlsEvent, books: { dk: {} } }]); h.svc.sweep(); await settle();
  const key = 'nfl:atlantafalcons@greenbaypackers:2026-09-25T00:15';
  const saved = R.readHistory(dir, 'nfl', key);
  assert.deepEqual(saved.dk.s.map(p => p[1]), [-7.5, -6.5, -3.5], 'consecutive duplicates dropped');
  const calls0 = h.calls.length;
  h.set(Date.parse(START) + 6 * 60e3); h.svc.sweep(); await settle();
  assert.equal(h.calls.length - calls0, 3, 'one history read per book/market after kickoff');
  assert.deepEqual(R.readHistory(dir, 'nfl', key).dk.s.map(p => p[1]), [-7.5, -6.5], 'the post-kickoff read keeps pregame points only');
  h.svc.sweep(); await settle(); assert.equal(h.calls.length - calls0, 3, 'never twice');
  const peer = new EventEmitter(); peer.send = () => {}; peer.env = { REFERENCE_HISTORY_DIR: dir };
  const sub = R.subscribe('nfl', null, peer);
  peer.emit('message', { type: 'ref:update', sport: 'nfl', games: { [key]: { open: {}, close: null } } });
  assert.deepEqual(sub.history('Atlanta Falcons', 'Green Bay Packers', START).dk.s.length, 2);
  h.svc.stop(); sub.close();
});
