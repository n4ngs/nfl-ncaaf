'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../mlb/public/js/odds.js'), 'utf8');
const NOW = Date.parse('2026-09-22T18:00:00Z');
function harness() {
  const listeners = {}, nodes = new Map(), saved = new Map();
  const c = { console, Map, Set, Date, AbortController, CSS: { escape: String },
    store: { get: (k, d) => saved.has(k) ? saved.get(k) : d, set: (k, v) => saved.set(k, v) },
    S: { games: new Map(), date: '2026-09-22', isToday: true, tab: 'games' },
    serverNow: () => NOW, isOff: (g) => !!g.off, isDesk: () => true, chartW: () => 600,
    esc: (v) => String(v ?? '').replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x])),
    timeLabel: () => '7:10 PM', gameStatus: (g) => g.state, logo: () => '<img alt="">', ICON: { chev: '<svg></svg>' },
    $: (s) => nodes.get(s) || null, clamp: (n, a, b) => Math.max(a, Math.min(b, n)),
    document: { addEventListener: (k, fn) => (listeners[k] ||= []).push(fn), getElementById: (k) => nodes.get('#' + k) || null, querySelectorAll: () => [], hidden: false },
    fetch: async () => ({ ok: true, json: async () => ({}) }), requestAnimationFrame: () => 1, setInterval: () => 1, setTimeout: () => 1, clearTimeout: () => {},
  };
  vm.createContext(c); vm.runInContext(source + '\nglobalThis.state = ODDS;', c);
  c.state.keys = {};
  c.g = { pk: 1, state: 'Preview', start: '2026-09-23T02:10:00Z', away: { id: 1, name: 'San Diego Padres', abbr: 'SD' }, home: { id: 2, name: 'Los Angeles Dodgers', abbr: 'LAD' } };
  c.S.games.set(1, c.g);
  return { c, nodes, listeners, saved };
}
function book({ age = 1000, source = 'vsin', price = -120 } = {}) {
  const at = new Date(NOW - age).toISOString();
  const q = (line, odds) => ({ source, source_observed_at: at, received_at: new Date(NOW).toISOString(), market_status: 'active', is_live: false, max_age_ms: 60000, freshness: 'FRESH', actionable: true, american_odds: odds, line_value: line });
  return { ml: [price, 110], rl: { line: -1.5, odds: [130, -140] }, t: { line: 8.5, odds: [-105, -115] }, src: source, seen: NOW,
    quote_meta: { ml: { home: q(null, price), away: q(null, 110) }, rl: { home: q(-1.5, 130), away: q(1.5, -140) }, t: { over: q(8.5, -105), under: q(8.5, -115) } } };
}
test('source time, not receipt, controls every pregame price', () => {
  const { c } = harness();
  assert.equal(c.oddsQuote(book(), 'ml', 'home').freshness, 'FRESH');
  assert.equal(c.oddsQuote(book({ age: 61000 }), 'ml', 'home').freshness, 'STALE');
  const legacy = { ml: [-120, 110], seen: NOW };
  assert.equal(c.oddsQuote(legacy, 'ml', 'home').freshness, 'UNVERIFIED');
  const suspended = book(); suspended.quote_meta.ml.home.market_status = 'suspended';
  assert.equal(c.oddsQuote(suspended, 'ml', 'home').freshness, 'SUSPENDED');
  const future = book({ age: -1000 }); assert.equal(c.oddsQuote(future, 'ml', 'home').freshness, 'CONFLICTED');
  const mismatch = book(); mismatch.ml[0] = -110;
  assert.equal(c.oddsQuote(mismatch, 'ml', 'home').actionable, false);
});
test('fresh opposite sides must share source time and matching line for no-vig anchors', () => {
  const { c } = harness(), L = book();
  assert.equal(c.oddsPairFresh(L, 'rl'), true);
  L.quote_meta.rl.away.source = 'an1'; assert.equal(c.oddsPairFresh(L, 'rl'), false);
  L.quote_meta.rl.away.source = 'vsin'; L.quote_meta.rl.away.source_observed_at = new Date(NOW - 2000).toISOString();
  assert.equal(c.oddsPairFresh(L, 'rl'), false);
  L.quote_meta.rl.away.source_observed_at = L.quote_meta.rl.home.source_observed_at; L.quote_meta.rl.away.line_value = 2.5;
  assert.equal(c.oddsPairFresh(L, 'rl'), false);
});
test('best price and ticket handoff exclude attractive stale or unverified quotes', () => {
  const { c } = harness(), O = { pk: 1, books: { pin: book(), dk: book({ age: 70000, price: 150 }), fd: { ml: [200, -220], seen: NOW } } };
  c.state.games.set(1, O);
  assert.equal(c.oddsBest(O, 'ml', 'home').book, 'pin');
  assert.equal(c.oddsPriceAt(1, 'ml', 'home', 'dk'), null);
  assert.equal(c.oddsPriceAt(1, 'ml', 'home', 'fd'), null);
  assert.equal(c.oddsPriceAt(1, 'ml', 'home', 'pin').odds, -120);
  assert.equal(c.oddsEdgePrice(1, 'ml', 'home', null, 150, 'dk'), null);
  O.books.pin.quote_meta.ml.away.source = 'other';
  assert.equal(c.oddsSharp(O, 'ml'), null);
});
test('stale board, F5, every-book and MGM cells are readable non-actions', () => {
  const { c } = harness(), L = book({ age: 70000 }), O = { pk: 1, books: { mgm: L }, f5: { mgm: L } };
  c.state.games.set(1, O);
  const board = c.oddsBookCell(c.g, O, 'ml', 'home', 'mgm', null, true);
  assert.match(board, /Stale/); assert.doesNotMatch(board, /<(button|a)\b|data-mgmbet|data-odds-bet/);
  assert.doesNotMatch(c.oddsFiveHTML(1), /data-odds-bet/);
  assert.doesNotMatch(c.oddsTableHTML(1), /data-odds-bet/);
  assert.match(c.oddsTableHTML(1), /Stale/);
});
test('MGM click revalidates a quote that aged after the render', () => {
  const { c, listeners } = harness();
  c.state.games.set(1, { pk: 1, books: { mgm: book({ age: 70000 }) } });
  let prevented = false, slipped = false; c.betsOpenSlip = () => { slipped = true; };
  const a = { dataset: { mgmbet: '1|ml|home|mgm' } };
  const ev = { target: { closest: (s) => s === '[data-mgmbet]' ? a : null }, preventDefault: () => { prevented = true; } };
  for (const fn of listeners.click) fn(ev);
  assert.equal(prevented, true); assert.equal(slipped, false);
});
test('coverage counts selected market and context without promoting other fresh markets', () => {
  const { c } = harness(), L = book(); L.quote_meta.ml.home.source_observed_at = null; L.quote_meta.ml.away.source_observed_at = null;
  c.state.games.set(1, { pk: 1, books: { dk: L } });
  const ml = c.oddsCoverage([c.g], 'ml'), total = c.oddsCoverage([c.g], 't');
  assert.equal(ml.FRESH, 0); assert.equal(ml.UNVERIFIED, 2); assert.equal(total.FRESH, 2);
  c.g.state = 'Final'; assert.equal(c.oddsCoverage([c.g], 't').FRESH, 0);
});
test('mobile selected book and price-first layout preserve explicit view preferences', () => {
  const { c, listeners, saved } = harness();
  c.state.games.set(1, { pk: 1, books: { pin: book() } });
  for (const fn of listeners.change) fn({ target: { id: 'oddsBookPick', value: 'pin' } });
  assert.equal(saved.get('oddsBook'), 'pin');
  assert.match(c.oddsRowHead('ml', true), /Pinnacle/);
  const html = c.oddsViewHTML();
  assert.match(html, /MLB market board/); assert.match(html, /data-odds-bet="1\|ml\|home\|pin"/);
  assert.ok(html.indexOf('class="odds-boards"') < html.indexOf('id="oddsContext"'));
  assert.match(html, /role="region" aria-label="Every sportsbook/);
  assert.equal(c.state.view, 'odds');
});
test('history rejects invalid points, plots recorded run lines and stops at actual observations', () => {
  const { c } = harness(), h = { b: { pin: { rl: [[NOW - 60000, -1.5, 130, -140], [NOW - 30000, -2.5, 140, -150], [NOW + 1000, -3.5, 150, -160], [null, 0, 110, -120]] } } };
  const series = c.oddsHistorySeries(h, 'rl'); assert.equal(series[0].pts.length, 2); assert.equal(series[0].pts[1].value, -2.5);
  c.state.chartBook = 'pin'; c.state.chartMkt = 'rl'; c.state.chartAt = NOW - 60000; c.state.sheetHist = h;
  assert.equal(c.oddsHistorySelection(series).index, 0);
  const chart = c.oddsChartSVG(h, {}, c.g, 'rl', 600);
  assert.doesNotMatch(chart, />Now</); assert.match(chart, /data-history-point="1"/);
  const d = chart.match(/class="ln t2" d="([^"]+)"/)[1]; assert.match(d, /V[\d.]+$/);
  const block = c.oddsChartBlock(1); assert.match(block, /type="range"/); assert.match(block, /source quote timestamps are unavailable/); assert.match(block, /Observation 1 of 2/);
});
test('local history append cannot invent a receipt time from render time', () => {
  const { c } = harness(), h = { b: {} };
  c.oddsHistAppend(h, { books: { pin: book() } }); assert.equal(Object.keys(h.b).length, 0);
  c.oddsHistAppend(h, { at: NOW - 1000, books: { pin: book() } }); assert.equal(h.b.pin.ml[0][0], NOW - 1000);
});
test('manual refresh deduplicates pending requests and makes failure visible', async () => {
  const { c } = harness(); let calls = 0, finish;
  c.fetch = (url) => { calls++; assert.match(url, /refresh=1/); return new Promise((resolve) => { finish = resolve; }); };
  c.state.fetched.set(c.S.date, { ok: true, at: NOW });
  const request = c.oddsFetchDay(c.S.date, true);
  assert.equal(c.state.fetched.get(c.S.date).busy, true);
  await c.oddsFetchDay(c.S.date, true); assert.equal(calls, 1);
  finish({ ok: false }); await request;
  assert.match(c.state.fetched.get(c.S.date).error, /Existing quote status is unchanged/);
  assert.equal(c.state.fetched.get(c.S.date).ok, true);
});


test('source clock naturally transitions into Aging and remains non-actionable', () => {
  const { c } = harness(), L = book({ age: 20000 });
  L.quote_meta.ml.home.fresh_for_ms = 10000;
  assert.equal(c.oddsQuote(L, 'ml', 'home').freshness, 'AGING');
  assert.equal(c.oddsQuote(L, 'ml', 'home').actionable, false);
  L.quote_meta.ml.home.freshness = 'AGING'; L.quote_meta.ml.home.actionable = false;
  assert.match(c.oddsQuoteNote(c.oddsQuote(L, 'ml', 'home')), /^Aging/);
});
test('source status events are stored per day and distinguish receipt from source time', () => {
  const { c, listeners } = harness();
  const date = c.S.date, prior = '2026-09-21';
  c.state.status.set(prior, { sources: { pin: { state: 'ok', received_at: new Date(NOW).toISOString(), source_observed_at: null } } });
  for (const fn of listeners['bbl:odds_status']) fn({ detail: { date, sources: { vsin: { state: 'ok' } }, refresh: { in_progress: true } } });
  c.S.date = prior;
  const html = c.oddsSourceStatus();
  assert.match(html, /Pinnacle/); assert.doesNotMatch(html, /VSiN/);
  assert.match(html, /Last check:/); assert.match(html, /Newest source quote: time unavailable/);
});


test('F5 zero run lines stay run lines, are visible and retain the fresh-only gate', () => {
  const { c } = harness(), L = book();
  L.ml = null; L.quote_meta.ml = {}; L.rl.line = 0;
  L.quote_meta.rl.home.line_value = 0; L.quote_meta.rl.away.line_value = -0;
  c.state.games.set(1, { pk: 1, books: {}, f5: { pin: L } });
  assert.equal(c.oddsPriceAt(1, 'f5rl', 'home', 'pin').line, 0);
  assert.equal(c.oddsPriceAt(1, 'f5ml', 'home', 'pin'), null);
  assert.match(c.oddsFiveHTML(1), /SD RL/);
  assert.match(c.oddsFiveHTML(1), /data-odds-bet="1\|f5rl\|home\|pin"/);
  assert.doesNotMatch(c.oddsFiveHTML(1), /data-odds-bet="1\|f5ml/);
  L.quote_meta.rl.home.freshness = 'AGING'; L.quote_meta.rl.home.actionable = false;
  assert.equal(c.oddsPriceAt(1, 'f5rl', 'home', 'pin'), null);
  assert.doesNotMatch(c.oddsFiveHTML(1), /data-odds-bet="1\|f5rl\|home\|pin"/);
});
test('HTTP200 refresh outcomes communicate errors, partial responses and scheduled polling', () => {
  const { c } = harness();
  assert.match(c.oddsRefreshFeedback({ result: 'error' }), /could not refresh/);
  assert.match(c.oddsRefreshFeedback({ result: 'partial' }), /Some feeds/);
  assert.match(c.oddsRefreshFeedback({ result: 'scheduled' }), /No feed was due yet/);
  assert.match(c.oddsRefreshFeedback({ result: 'historical' }), /do not request new quotes/);
  assert.equal(c.oddsRefreshFeedback({ result: 'error', in_progress: true }), '');
  c.state.status.set(c.S.date, { sources: { pin: { state: 'idle' } } });
  assert.match(c.oddsSourceStatus(), /Idle/); assert.doesNotMatch(c.oddsSourceStatus(), />Unavailable</);
});


test('startup waits for day data and disables refresh while genuine loaded empty days stay empty', () => {
  const { c } = harness();
  c.S.games.clear(); c.S.date = null; c.S.today = '2026-09-22'; c.S.me={role:'owner'}; c.S.loading = null;
  const initial = c.oddsViewHTML();
  assert.match(initial, /role="status"><b>Loading this day’s games/);
  assert.match(initial, /data-odds-refresh[^>]*disabled aria-busy="true"/);
  assert.doesNotMatch(initial, /No games|Choose another day/);
  c.S.date = '2026-09-22';
  const emptyToday = c.oddsViewHTML();
  assert.match(emptyToday, /No games today/); assert.doesNotMatch(emptyToday, /Loading this day/);
  assert.doesNotMatch(emptyToday, /data-odds-refresh[^>]*disabled/);
  c.S.loading = '2026-09-21'; c.S.isToday = false;
  const switching = c.oddsViewHTML();
  assert.match(switching, /Loading this day’s games/); assert.doesNotMatch(switching, /No games/);
  c.S.loading = null; c.S.date = '2026-09-21';
  assert.match(c.oddsViewHTML(), /No games on this day/);
});
