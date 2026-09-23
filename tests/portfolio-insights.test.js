'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const View = require('../design/portfolio-view');
const Portfolio = require('../design/portfolio');
const record = (id, sport, net, settled, overrides = {}) => ({ id, sport, status: net < 0 ? 'lost' : net === 0 ? 'push' : 'won', net, settled,
  placed: '2026-09-01T12:00:00Z', created: '2026-09-01T12:01:00Z', stake: 25, odds: -110, book: 'mgm',
  legs: [{ gid: id, pk: id, label: 'Test selection', matchup: 'Test away at Test home', state: 'open' }], ...overrides });
const normalized = (row) => Portfolio.normalizeTicket(row.sport, row);
const timeline = () => [record('later', 'nfl', 20, '2026-09-03T18:00:00Z'), record('first', 'mlb', -10, '2026-09-01T20:00:00Z'),
  record('same-day', 'ncaaf', 5, '2026-09-01T22:00:00Z'), record('middle', 'mlb', 0, '2026-09-02T18:00:00Z')];

test('recorded settlement days combine sports, aggregate ties and order independently of ticket placement', () => {
  const input = timeline().map(normalized), before = JSON.stringify(input);
  const model = View.insightData(input);
  assert.deepEqual(model.points, [
    { day: '2026-09-01', net: -5, count: 2, cumulative: -5 },
    { day: '2026-09-02', net: 0, count: 1, cumulative: -5 },
    { day: '2026-09-03', net: 20, count: 1, cumulative: 15 },
  ]);
  assert.equal(model.dated, 4); assert.equal(model.net, 15);
  assert.equal(JSON.stringify(input), before, 'insights never mutate saved or normalized tickets');
});
test('unknown net, missing settlement dates and void tickets never invent a timeline value', () => {
  const input = [record('date-missing', 'nfl', 40, null), record('profit-missing', 'mlb', null, '2026-09-02T01:00:00Z'),
    record('void', 'ncaaf', 999, '2026-09-03T01:00:00Z', { status: 'void' }),
    record('open', 'nfl', 999, '2026-09-04T01:00:00Z', { status: 'open' })].map(normalized);
  const model = View.insightData(input);
  assert.equal(model.points.length, 0); assert.equal(model.missingNet, 1); assert.equal(model.missingDate, 1); assert.equal(model.settled, 2);
  const html = View.renderInsights(model);
  // The scorecard may show a known undated net; it must still be absent from the dated timeline.
  assert.doesNotMatch(html.slice(html.indexOf('<div class="portfolio-insight-grid">')), /<svg|data-pf-day|\+\$40|\+\$999/);
  assert.match(html, /no recorded net result/); assert.match(html, /no settlement time/);
  assert.match(html, /timeline appears/);
});
test('UTC days are explicit and no date-only, local, placed or created time substitutes for settlement', () => {
  const rows = [record('offset', 'nfl', 10, '2026-09-02T23:30:00-07:00'),
    record('bare', 'mlb', 20, '2026-09-02'), record('local', 'ncaaf', 30, '2026-09-02T12:00:00')].map(normalized);
  const model = View.insightData(rows);
  assert.deepEqual(model.points.map((p) => p.day), ['2026-09-03']);
  assert.equal(model.missingDate, 2);
  assert.match(View.renderInsights(model), /Settlement days use UTC/);
});
test('real zero net creates one real point with no fabricated before/after trend', () => {
  const model = View.insightData([normalized(record('push', 'mlb', 0, '2026-09-02T18:00:00Z'))]);
  const html = View.renderInsights(model);
  assert.equal(model.points[0].cumulative, 0);
  assert.match(html, /<svg/); assert.match(html, /<circle/); assert.doesNotMatch(html, /<path/);
  assert.match(html, /One recorded day/); assert.match(html, /\$0\.00/);
});
test('open exposure counts missing and invalid stakes without treating them as real zero wagers', () => {
  const rows = [record('known', 'mlb', null, null, { status: 'open', stake: 40, book: 'mgm' }),
    record('missing', 'nfl', null, null, { status: 'open', stake: null, book: 'BetMGM' }),
    record('zero', 'ncaaf', null, null, { status: 'open', stake: 0, book: 'Circa' }),
    record('negative', 'nfl', null, null, { status: 'open', stake: -10, book: 'Circa Sports' }),
    record('settled', 'mlb', 20, '2026-09-02T18:00:00Z', { stake: 1000 })].map(normalized);
  const model = View.insightData(rows, 'book');
  assert.equal(model.open, 4); assert.equal(model.risk, 40); assert.equal(model.missingStake, 2);
  assert.deepEqual(model.exposure.map((r) => ({ label: r.label, stake: r.stake, count: r.count, missing: r.missing })), [
    { label: 'BetMGM', stake: 40, count: 2, missing: 1 }, { label: 'Circa', stake: 0, count: 2, missing: 1 },
  ]);
  const missing = View.insightData([rows[1]]);
  assert.match(View.renderInsights(missing), /<strong>—<\/strong>/);
  assert.match(View.renderInsights(missing), /Open stake unavailable/);
});
test('sport scope changes insights while ticket status/search filters do not erase the history', () => {
  const rows = timeline().map(normalized);
  const model = View.insightData(View.select(rows, { sport: 'mlb' }));
  assert.equal(model.net, -10); assert.equal(model.points.length, 2);
  assert.equal(model.exposure.length, 0);
});
test('day navigation retains date identity across new points and clamps to available bounds', () => {
  const points = View.insightData(timeline().map(normalized)).points;
  assert.equal(View.chooseInsightDay(points), '2026-09-03');
  assert.equal(View.chooseInsightDay(points, '2026-09-02', 'previous'), '2026-09-01');
  assert.equal(View.chooseInsightDay(points, '2026-09-01', 'previous'), '2026-09-01');
  assert.equal(View.chooseInsightDay(points, '2026-09-03', 'next'), '2026-09-03');
  assert.equal(View.chooseInsightDay([...points, { day: '2026-09-04' }], '2026-09-02'), '2026-09-02');
  assert.equal(View.chooseInsightDay(points, 'missing-date'), '2026-09-03');
  assert.equal(View.chooseInsightDay([], '2026-09-03'), '');
});
test('book text is escaped in bars and readout has keyboard controls plus a real data table', () => {
  const rows = [...timeline(), record('book', 'nfl', null, null, { status: 'open', book: '<img src=x onerror="bad()">' })].map(normalized);
  const html = View.renderInsights(View.insightData(rows, 'book'), { group: 'book' });
  assert.doesNotMatch(html, /<img|onerror="bad/); assert.match(html, /&lt;img/);
  assert.match(html, /aria-label="Settlement day"/); assert.match(html, /type="range"/);
  assert.match(html, /aria-label="Previous settlement day"/); assert.match(html, /aria-live="polite"/);
  assert.match(html, /<table>/); assert.match(html, /scope="row"/); assert.match(html, /aria-pressed="true">By book/);
});

function fixture(records) {
  const listeners = new Map();
  const node = (dataset = {}) => ({ dataset, textContent: '', innerHTML: '', open: false, disabled: false, value: '', attrs: {}, listeners: new Map(),
    classList: { add() {} }, addEventListener(k, fn) { this.listeners.set(k, fn); }, setAttribute(k, v) { this.attrs[k] = v; },
    querySelectorAll() { return []; }, contains() { return false; }, focus() {} });
  const controls = Object.fromEntries(['[data-pf-readout]', '[data-pf-marker]', '[data-pf-day]', '[data-pf-day-step="previous"]', '[data-pf-day-step="next"]', '.portfolio-insight-data'].map((key) => [key, node()]));
  const nodes = Object.fromEntries(['.portfolio-summary', '.portfolio-notice', '.portfolio-list', '.portfolio-sport select', 'input[type=search]', '.portfolio-insights', '.portfolio-insight-body', '[data-pf-insight-brief]'].map((key) => [key, node()]));
  const body = nodes['.portfolio-insight-body']; body.querySelector = (key) => controls[key];
  const root = { ...node(), isConnected: true, parentElement: node(), getClientRects: () => [{}], querySelector: (key) => nodes[key],
    contains: (n) => Object.values(nodes).includes(n), addEventListener: (k, fn) => listeners.set(k, fn) };
  const context = { Intl, Date, Map, WeakMap, Set, JSON, Number, String, Object, Array, matchMedia: () => ({ matches: true }),
    BoardPortfolio: { ...Portfolio, load: async () => ({ tickets: records.map(normalized), sources: ['nfl','ncaaf','mlb'].map((sport) => ({ sport, status: 'ok' })) }), invalidate() {} },
    document: { hidden: false, activeElement: null, addEventListener() {} }, setInterval() {}, clearInterval() {}, location: { assign() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../design/portfolio-view.js'), 'utf8'), context);
  context.BoardPortfolioView.mount(root, { sport: 'nfl', currentBets: records.filter((r) => r.sport === 'nfl') });
  const click = (dataset) => { const button = { dataset }; listeners.get('click')({ target: { closest: (key) => key === 'button' ? button : null } }); };
  return { controls, nodes, listeners, click, root, context };
}
test('mounted slider and step buttons change selected data without rebuilding the slider during input', async () => {
  const f = fixture(timeline()); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.nodes['.portfolio-insights'].open, true, 'desktop overview is visible');
  const body = f.nodes['.portfolio-insight-body'], before = body.innerHTML;
  f.listeners.get('input')({ target: { value: '0', hasAttribute: (key) => key === 'data-pf-day' } });
  assert.equal(body.innerHTML, before, 'slider stays mounted during a drag');
  assert.match(f.controls['[data-pf-readout]'].innerHTML, /-\$5\.00/);
  assert.equal(f.controls['[data-pf-day]'].value, '0');
  assert.equal(f.controls['[data-pf-day-step="previous"]'].disabled, true);
  f.click({ pfDayStep: 'next' });
  assert.equal(f.controls['[data-pf-day]'].value, '1');
  assert.match(f.controls['[data-pf-readout]'].innerHTML, /\$0\.00 that day/);
  assert.match(f.controls['[data-pf-day]'].attrs['aria-valuetext'], /cumulative net/);
  f.click({ pfExposure: 'book' });
  assert.match(body.innerHTML, /aria-pressed="true">By book/);
  assert.match(body.innerHTML, /Through Sep 2, 2026/);
  f.nodes['.portfolio-sport select'].listeners.get('change')({ target: { value: 'mlb' } });
  assert.match(body.innerHTML, /-\$10\.00/);
  assert.match(f.nodes['[data-pf-insight-brief]'].textContent, /MLB/);
});
