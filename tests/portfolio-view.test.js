'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Portfolio = require('../design/portfolio');
const View = require('../design/portfolio-view');
const source = fs.readFileSync(path.join(__dirname, '../design/portfolio-view.js'), 'utf8');
const FUTURE = '2099-09-22T21:00:00Z';
function raw(id = 'one', overrides = {}) {
  return { id, status: 'open', placed: '2026-09-22T18:00:00Z', stake: 25, odds: -110, net: null, book: 'BetMGM', note: '',
    legs: [{ gid: '123', pk: 123, label: 'Home −2.5', matchup: 'Away at Home', mkt: 's', side: 'home', line: -2.5, odds: -110, state: 'open', start: FUTURE }], ...overrides };
}
const normalized = (sport, id, overrides = {}, options = {}) => Portfolio.normalizeTicket(sport, raw(id, overrides), options);
const keys = (tickets) => tickets.map((t) => t.key);
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('filters combine sport, known status, live phase, book/team/note search without mutating input', () => {
  const input = [normalized('nfl', 'live', { book: 'Circa' }, { gameOf: () => ({ state: 'in' }) }),
    normalized('mlb', 'soon', { note: 'Pitcher scratch' }), normalized('ncaaf', 'done', { status: 'won', net: 22.73 }),
    normalized('nfl', 'unknown', { status: 'unknown' }), normalized('nfl', 'void', { status: 'void', net: 0 })];
  const before = keys(input);
  assert.deepEqual(keys(View.select(input, { sport: 'nfl', status: 'live', query: ' CIRCA ' })), ['nfl:live']);
  assert.deepEqual(keys(View.select(input, { status: 'upcoming', query: 'pitcher' })), ['mlb:soon']);
  assert.deepEqual(keys(View.select(input, { sport: 'ncaaf', query: 'home' })), ['ncaaf:done']);
  assert.deepEqual(new Set(keys(View.select(input, { status: 'settled' }))), new Set(['ncaaf:done', 'nfl:void']));
  assert.equal(View.select(input, { status: 'open' }).length, 2);
  assert.deepEqual(keys(input), before);
});

test('live tickets lead upcoming and unknown open tickets, with stable newest-first ties', () => {
  const input = [normalized('nfl', 'settled', { status: 'won' }), normalized('nfl', 'unknown', { legs: [{ gid: '123', state: 'open', start: '2020-01-01T00:00:00Z' }] }),
    normalized('ncaaf', 'later'), normalized('nfl', 'live-b', {}, { gameOf: () => ({ state: 'in' }) }),
    normalized('nfl', 'live-a', {}, { gameOf: () => ({ state: 'in' }) }),
    normalized('mlb', 'newer', { placed: '2026-09-22T19:00:00Z' }, { gameOf: () => ({ state: 'Live' }) })];
  assert.deepEqual(keys(View.select(input)), ['mlb:newer', 'nfl:live-a', 'nfl:live-b', 'ncaaf:later', 'nfl:unknown', 'nfl:settled']);
});

test('summary distinguishes missing money from real zeros and ignores unknown/void results', () => {
  const tickets = [normalized('mlb', 'no-stake', { stake: null }), normalized('nfl', 'risk'),
    normalized('mlb', 'unpriced-win', { status: 'won', stake: null, net: null }),
    normalized('nfl', 'push', { status: 'push', net: 0 }), normalized('nfl', 'win', { status: 'won', net: 20 }),
    normalized('nfl', 'loss', { status: 'lost', net: -10 }), normalized('nfl', 'void', { status: 'void', net: 999 }),
    normalized('nfl', 'unknown', { status: 'unknown', net: 999 })];
  const stats = View.summarize(tickets);
  assert.equal(stats.open, 2); assert.equal(stats.risk, 25); assert.equal(stats.missingStake, 1);
  assert.equal(stats.net, 10); assert.equal(stats.knownNet, 3); assert.equal(stats.missingNet, 1);
  assert.equal(stats.won, 2); assert.equal(stats.lost, 1);
  const onlyMissing = View.summarize([tickets[2]]);
  assert.equal(onlyMissing.knownNet, 0); assert.equal(onlyMissing.missingNet, 1);
});

test('payouts require recorded numeric stake and valid American odds', () => {
  assert.equal(View.toWin({ stake: 100, odds: 150 }), 150);
  assert.equal(View.toWin({ stake: 100, odds: -200 }), 50);
  assert.equal(View.toWin({ stake: 0, odds: 100 }), 0);
  for (const ticket of [{ stake: null, odds: -110 }, { stake: 10, odds: null }, { stake: 10, odds: 0 }, { stake: 10, odds: 99 }, { stake: '10', odds: -110 }]) assert.equal(View.toWin(ticket), null);
});

test('ticket rendering preserves missing amounts/times and valid zero results', () => {
  const missing = View.renderTicket(normalized('mlb', 'missing', { stake: null, odds: null, net: null, status: 'won', placed: null }), { sport: 'nfl' });
  assert.match(missing, /<small>Stake<\/small><strong>—<\/strong>/);
  assert.match(missing, /<small>Net result<\/small><strong>—<\/strong>/);
  assert.match(missing, /Time unavailable/);
  assert.match(missing, /href="\/mlb\/\?portfolio=mine#following"/);
  const zero = View.renderTicket(normalized('nfl', 'push', { status: 'push', net: 0 }), { sport: 'nfl' });
  assert.match(zero, /<small>Net result<\/small><strong>\$0\.00<\/strong>/);
  assert.doesNotMatch(zero, /ticket log to manage/);
});

test('ticket text and integrity evidence escape user text; legacy/provisional evidence never says verified CLV', () => {
  const attack = '<img src=x onerror="alert(1)">';
  const record = raw('safe', { book: attack, note: attack });
  record.legs[0].label = attack; record.legs[0].matchup = attack;
  record.legs[0].integrity = { status: 'PROVISIONAL_CLV', reason_code: '<svg/onload=alert(1)>', line_clv_points: null, clv_fair_probability_pp: null, clv_ev_pct: null };
  const html = View.renderTicket(Portfolio.normalizeTicket('nfl', record), { sport: 'nfl', signalText: () => attack });
  assert.doesNotMatch(html, /<img|<svg/); assert.match(html, /&lt;img/); assert.match(html, /&quot;alert/);
  assert.doesNotMatch(html, /leg has verified CLV/);
  assert.match(View.evidence({ clv: { pts: 10, pct: 20 } }), /unavailable/);
  const zero = View.evidence({ integrity: { status: 'VERIFIED_CLV', line_clv_points: 0, clv_fair_probability_pp: 0, clv_ev_pct: 0 } });
  assert.match(zero, />0 pts</); assert.match(zero, />0 pp</); assert.match(zero, />0%</);
});

// A small mount surface exercises the real async refresh flow without a DOM library or network.
function mountFixture(load) {
  const intervals = [], documentListeners = new Map(), callbacks = {};
  const node = () => ({ innerHTML: '', textContent: '', dataset: {}, listeners: new Map(),
    classList: { add() {}, remove() {} }, addEventListener(type, fn) { this.listeners.set(type, fn); },
    querySelectorAll() { return []; }, contains() { return false; }, setAttribute() {} });
  const nodes = Object.fromEntries(['.portfolio-summary', '.portfolio-notice', '.portfolio-list', '.portfolio-sport select', 'input[type=search]', '.portfolio-entry-sport', '.portfolio-analysis'].map((s) => [s, node()]));
  const root = { ...node(), isConnected: true, parentElement: node(), getClientRects: () => [{}],
    querySelector: (selector) => nodes[selector], contains: (el) => Object.values(nodes).includes(el) };
  const context = { Intl, Date, Map, WeakMap, Set, JSON, Number, String, Object, Array,
    BoardPortfolio: { ...Portfolio, load, invalidate() {}, subscribe(options) { Object.assign(callbacks, options); return () => {}; } },
    document: { hidden: false, activeElement: null, addEventListener(type, fn) { documentListeners.set(type, fn); } },
    setInterval(fn) { intervals.push(fn); return intervals.length; }, clearInterval() {}, location: { assign() {} } };
  vm.runInNewContext(source, context);
  return { view: context.BoardPortfolioView, root, nodes, intervals, callbacks, context };
}
function fromOptions(options) {
  return { tickets: Object.entries({ ...options.betsBySport, [options.sport]: options.currentBets }).flatMap(([sport, rows]) => rows.map((r) => Portfolio.normalizeTicket(sport, r))),
    sources: [{ sport: options.sport, status: 'ok' }], updatedAt: Date.now() };
}

test('mounted summary shows unavailable settled net for wins without stakes, but preserves actual zero', async () => {
  const f = mountFixture(async (options) => fromOptions(options));
  f.view.mount(f.root, { sport: 'mlb', currentBets: [raw('missing', { status: 'won', stake: null, net: null })], sports: ['mlb'] });
  await turn();
  assert.match(f.nodes['.portfolio-summary'].innerHTML, /Settled net<\/span><strong class="portfolio-stat-value">—<\/strong>/);
  f.view.mount(f.root, { sport: 'mlb', currentBets: [raw('zero', { status: 'push', stake: 10, net: 0 })], sports: ['mlb'] });
  await turn();
  assert.match(f.nodes['.portfolio-summary'].innerHTML, /Settled net<\/span><strong class="portfolio-stat-value">\$0\.00<\/strong>/);
});

test('a slow peer request cannot resurrect a current ticket deleted during refresh', async () => {
  let finish, calls = 0;
  const f = mountFixture((options) => { calls++; return calls === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(fromOptions(options)); });
  const old = raw('deleted');
  f.view.mount(f.root, { sport: 'nfl', currentBets: [old] });
  f.view.mount(f.root, { sport: 'nfl', currentBets: [] });
  assert.doesNotMatch(f.nodes['.portfolio-list'].innerHTML, /data-ticket="nfl:deleted"/);
  finish({ tickets: [Portfolio.normalizeTicket('nfl', old)], sources: [{ sport: 'nfl', status: 'ok' }], updatedAt: Date.now() });
  await turn();
  assert.doesNotMatch(f.nodes['.portfolio-list'].innerHTML, /data-ticket="nfl:deleted"/);
  assert.equal(calls, 2, 'a refresh arriving during a request is replayed once');
});

test('latest peer SSE ticket replaces older HTTP result before the next request finishes', async () => {
  let finish, calls = 0;
  const f = mountFixture(() => { calls++; return calls === 1 ? new Promise((resolve) => { finish = resolve; }) : new Promise(() => {}); });
  f.view.mount(f.root, { sport: 'nfl', currentBets: [] });
  f.intervals[0]();
  f.callbacks.onBets('mlb', [raw('stream-new')]);
  f.callbacks.onGames('mlb', new Map([['123', { pk: 123, state: 'Live' }]]));
  finish({ tickets: [normalized('mlb', 'http-old')], sources: [{ sport: 'mlb', status: 'ok' }], updatedAt: Date.now() });
  await turn();
  assert.match(f.nodes['.portfolio-list'].innerHTML, /data-ticket="mlb:stream-new"/);
  assert.match(f.nodes['.portfolio-list'].innerHTML, /data-phase="live"/);
  assert.doesNotMatch(f.nodes['.portfolio-list'].innerHTML, /data-ticket="mlb:http-old"/);
});

test('live repaint preserves an expanded ticket and focused action, with summary fallback', () => {
  const f = mountFixture(() => new Promise(() => {}));
  f.view.mount(f.root, { sport: 'nfl', currentBets: [raw()] });
  let focused = null;
  const markup = '<button type="button" data-void="one">Void</button>';
  const oldAction = { outerHTML: markup, closest: () => ({ dataset: { ticket: 'nfl:one' } }) };
  const action = { outerHTML: markup, focus() { focused = this; } };
  const summary = { focus() { focused = this; } };
  const details = { dataset: { details: 'nfl:one' }, open: false };
  const article = { dataset: { ticket: 'nfl:one' }, querySelectorAll: () => [action], querySelector: () => summary };
  const list = f.nodes['.portfolio-list'];
  list.contains = (element) => element === oldAction;
  list.querySelectorAll = (selector) => selector === '[data-ticket]' ? [article] : selector === 'details[open]' || selector === 'details[data-details]' ? [details] : [];
  f.context.document.activeElement = oldAction;
  f.view.mount(f.root, { sport: 'nfl', currentBets: [raw('one', { note: 'Updated score context' })] });
  assert.equal(focused, action); assert.equal(details.open, true);
  action.outerHTML = '<button type="button" data-void="one" disabled>Void</button>';
  f.view.mount(f.root, { sport: 'nfl', currentBets: [raw('one', { note: 'Changed available action' })] });
  assert.equal(focused, summary);
});

for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport}: editing actual entry identity clears snapshots, while note/stake edits retain them`, () => {
    const sheets = fs.readFileSync(path.join(__dirname, '..', sport, 'public/js/sheets.js'), 'utf8');
    const code = sheets.slice(sheets.indexOf('function readSlip()'), sheets.indexOf('// Returns a list of [fieldId'));
    const fields = {};
    const slip = { legs: [{ line: -2.5, odds: -110, entry_snapshot_id: 'captured' }], odds: -110, book: 'mgm', stake: 25, note: '' };
    const ctx = vm.createContext({ S: { sheet: { slip } }, MINUS: '−', $: (id) => fields[id] });
    vm.runInContext(code, ctx);
    fields['#slStake'] = { value: '50' }; fields['#slNote'] = { value: 'Updated note' };
    ctx.readSlip(); assert.equal(slip.legs[0].entry_snapshot_id, 'captured'); assert.equal(slip.stake, 50);
    fields['#slLine'] = { value: '−3' };
    ctx.readSlip(); assert.equal(slip.legs[0].entry_snapshot_id, null); assert.equal(slip.legs[0].line, -3);
    slip.legs[0].entry_snapshot_id = 'second'; fields['#slOdds'] = { value: '+105' };
    ctx.readSlip(); assert.equal(slip.legs[0].entry_snapshot_id, null); assert.equal(slip.legs[0].odds, 105);
    slip.legs.push({ line: 50, odds: -110, entry_snapshot_id: 'other-leg' }); slip.legs[0].entry_snapshot_id = 'first-leg';
    fields['#slBook'] = { value: 'dk' };
    ctx.readSlip(); assert.ok(slip.legs.every((leg) => leg.entry_snapshot_id === null)); assert.equal(slip.book, 'dk');
  });
}

test('peer disconnect immediately clears live score context and a slow refresh cannot restore it', async () => {
  const record = raw('peer', { legs: [{ pk: 123, state: 'open', start: '2020-01-01T00:00:00Z' }] });
  const live = Portfolio.normalizeTicket('mlb', record, { gameOf: () => ({ state: 'Live', away: { abbr: 'SF', score: 2 }, home: { abbr: 'LAD', score: 1 }, inning: 6, half: 'Bottom', outs: 1 }) });
  let finish, calls = 0;
  const f = mountFixture(() => {
    calls++;
    if (calls === 1) return Promise.resolve({ tickets: [], sources: [{ sport: 'nfl', status: 'ok' }] });
    if (calls === 2) return new Promise((resolve) => { finish = resolve; });
    return new Promise(() => {});
  });
  f.view.mount(f.root, { sport: 'nfl', currentBets: [] }); await turn();
  f.intervals[0]();
  f.callbacks.onGames('mlb', new Map([['123', { state: 'Live', away: { abbr: 'SF', score: 2 }, home: { abbr: 'LAD', score: 1 }, inning: 6, half: 'Bottom', outs: 1 }]]));
  f.callbacks.onBets('mlb', [record]);
  finish({ tickets: [live], sources: [{ sport: 'mlb', status: 'ok' }] }); await turn();
  assert.match(f.nodes['.portfolio-list'].innerHTML, /data-phase="live"/);
  assert.match(f.nodes['.portfolio-list'].innerHTML, /SF 2 · LAD 1 · Bottom 6 · 1 out/);
  f.callbacks.onStatus('mlb', { status: 'reconnecting' });
  assert.doesNotMatch(f.nodes['.portfolio-list'].innerHTML, /data-phase="live"|SF 2 · LAD 1/);
  assert.match(f.nodes['.portfolio-notice'].textContent, /reconnecting/);
});

test('a disconnected peer cannot regain Live from a pre-disconnect multi-sport HTTP result', async () => {
  const record = raw('peer-old', { legs: [{ pk: 123, state: 'open', start: '2020-01-01T00:00:00Z' }] });
  const live = Portfolio.normalizeTicket('mlb', record, { gameOf: () => ({ state: 'Live', away: { abbr: 'SF', score: 2 }, home: { abbr: 'LAD', score: 1 }, inning: 6, half: 'Bottom' }) });
  let finish, calls = 0;
  const f = mountFixture(() => {
    calls++;
    if (calls === 1) return Promise.resolve({ tickets: [], sources: [] });
    if (calls === 2) return new Promise((resolve) => { finish = resolve; });
    return new Promise(() => {});
  });
  f.view.mount(f.root, { sport: 'nfl', currentBets: [] }); await turn();
  f.intervals[0](); // pending load already normalized an old peer while a different sport stalls
  f.callbacks.onGames('mlb', new Map());
  f.callbacks.onStatus('mlb', { status: 'reconnecting' });
  finish({ tickets: [live], sources: [{ sport: 'mlb', status: 'ok' }] }); await turn();
  assert.match(f.nodes['.portfolio-list'].innerHTML, /data-ticket="mlb:peer-old"/);
  assert.doesNotMatch(f.nodes['.portfolio-list'].innerHTML, /data-phase="live"|SF 2 · LAD 1/);
  assert.match(f.nodes['.portfolio-list'].innerHTML, /awaiting update/);
});

test('default peer live score text is escaped and never leaks onto settled tickets', () => {
  const live = normalized('mlb', 'scores', {}, { gameOf: () => ({ state: 'Live', away: { abbr: '<img src=x>', score: 0 }, home: { abbr: 'LAD', score: 1 }, inning: 2, half: 'Top', outs: 0 }) });
  const html = View.renderTicket(live, { sport: 'nfl' });
  assert.match(html, /&lt;img src=x&gt; 0 · LAD 1 · Top 2 · 0 outs/);
  assert.doesNotMatch(html, /<img/);
  const settled = { ...live, status: 'won', phase: 'settled' };
  assert.doesNotMatch(View.renderTicket(settled, { sport: 'nfl' }), /Top 2 · 0 outs/);
});
