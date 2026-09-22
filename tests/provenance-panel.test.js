"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NOW = Date.parse('2026-09-22T21:41:00Z');
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
function load(sport) {
  const el = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, classList: { toggle() {} } };
  const context = vm.createContext({
    console, Date: Clock, Math, Set, Map, WeakMap, JSON, Number, String, Intl, URLSearchParams,
    setTimeout, clearTimeout, location: { hash: '' }, history: { replaceState() {} },
    window: { addEventListener() {} },
    document: { addEventListener() {}, querySelector() { return el; }, querySelectorAll() { return []; } },
    localStorage: { getItem() { return null; } },
    fetch() { throw Error('Network forbidden in tests'); },
  });
  for (const file of ['core', 'integrity']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', sport, 'public/js', `${file}.js`), 'utf8'), context, { filename: `${sport}/${file}.js` });
  }
  vm.runInContext('S.books = [{key:"czr",short:"Caesars",name:"Caesars Sportsbook"},{key:"pin",short:"Pinnacle",name:"Pinnacle"}]', context);
  return game => {
    context.inputGame = game;
    return vm.runInContext('integrityGamePanel(inputGame)', context);
  };
}
function quote(market, stage, values = {}) {
  return {
    snapshot_id: `snapshot-${market}-${stage}`, validation_status: 'VALID',
    market_type: market, selection: market === 't' ? 'over' : 'home',
    market_status: 'ACTIVE', is_live: false, sportsbook: 'czr', source: 'vsin',
    source_observed_at: stage === 'open' ? '2026-09-22T07:00:00Z' : '2026-09-22T21:40:00Z',
    line_value: market === 's' ? -3 : market === 't' ? 40.5 : null,
    american_odds: market === 'ml' ? -193 : -113,
    ...values,
  };
}
function resolution(market, values = {}) {
  return {
    open: quote(market, 'open', { line_value: market === 's' ? -6 : market === 't' ? 42.5 : null, american_odds: market === 'ml' ? -200 : -108 }),
    current: quote(market, 'current'), close: null, close_status: 'UNAVAILABLE',
    kickoff_basis: 'SCHEDULED_START', reason_code: 'EVENT_NOT_STARTED', ...values,
  };
}
function game(markets = { 's:home': resolution('s'), 't:over': resolution('t'), 'ml:home': resolution('ml') }) {
  return { id: 'fixture-game', state: 'pre', home: { abbr: 'NYG' }, away: { abbr: 'TEN' }, integrity: { markets } };
}
function text(html) { return html.replace(/<[^>]*>/g, ' ').replace(/−/g, '-').replace(/\s+/g, ' ').trim(); }
function mainHTML(html) { return html.replace(/<details\b[\s\S]*?<\/details>/gi, ''); }
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function repaint(sport, { open = false, focused = false, beforePanel = true, afterPanel = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', sport, 'public/js/sheets.js'), 'utf8');
  const start = source.indexOf('function paintGame() {');
  const end = source.indexOf('\nfunction gameSheet()', start);
  assert.ok(start >= 0 && end > start, 'Load the complete paintGame function');
  const outsideFocus = { name: 'Outside control' }, focusCalls = [];
  const document = { activeElement: outsideFocus };
  function disclosure(expanded) {
    const summary = { focus(options) { focusCalls.push(options); document.activeElement = this; } };
    return { open: expanded, summary, querySelector(selector) { return selector === 'summary' ? summary : null; } };
  }
  const previous = beforePanel ? disclosure(open) : null;
  let current = previous, writes = 0, chartWires = 0;
  if (focused && previous) document.activeElement = previous.summary;
  const body = {
    querySelector(selector) { return selector === '.provenance-details' ? current : null; },
    set innerHTML(value) {
      assert.equal(value, '<div>Updated game</div>');
      writes++;
      if (document.activeElement === previous?.summary) document.activeElement = body;
      current = afterPanel ? disclosure(false) : null;
    },
  };
  const context = vm.createContext({
    Date: Clock, document, S: { sheet: { kind: 'game' } },
    $(selector) { assert.equal(selector, '#dlgBody'); return body; },
    gameSheet() { return '<div>Updated game</div>'; },
    wireChart() { chartWires++; },
  });
  vm.runInContext(`let lastPaint = 0;\n${source.slice(start, end)}\npaintGame();`, context);
  return { current, previous, document, outsideFocus, focusCalls, writes, chartWires };
}

for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport}: market history preserves each quote and offers complete source evidence`, () => {
    const html = load(sport)(game());
    const visible = text(mainHTML(html));
    assert.match(visible, /Market provenance/);
    assert.match(visible, /Market history/i);
    for (const label of ['NYG spread', 'Total', 'NYG moneyline', 'Opening', 'Current', 'Close', 'Caesars']) assert.ok(visible.includes(label), label);
    for (const value of ['-6', '-3', '42.5', '40.5', '-108', '-113', '-200', '-193']) assert.ok(text(html).includes(value), value);
    assert.match(html, /<details\b[^>]*>[\s\S]*?<summary\b[^>]*>[\s\S]*?Source details[\s\S]*?<\/summary>/i);
    for (const at of ['2026-09-22 07:00:00 UTC', '2026-09-22 21:40:00 UTC']) assert.ok(text(html).includes(at), at);
    for (const m of ['s', 't', 'ml']) for (const stage of ['open', 'current']) assert.ok(html.includes(`snapshot-${m}-${stage}`));
    assert.ok(html.includes('EVENT_NOT_STARTED'));
    assert.ok(html.includes('SCHEDULED_START'));
    assert.doesNotMatch(visible, /EVENT_NOT_STARTED|SCHEDULED_START|RETROSPECTIVE_MARKET_MOVE/);
    assert.match(visible, /earned CLV[\s\S]*(snapshot|entry)/i);
  });

  test(`${sport}: zero spread and even odds are real quoted values`, () => {
    const html = load(sport)(game({ 's:home': resolution('s', {
      open: quote('s', 'open', { line_value: 0, american_odds: 100 }),
      current: quote('s', 'current', { line_value: 0, american_odds: 100 }),
    }) }));
    assert.match(text(html), /(?:0|PK)\s+(?:·\s*)?EV/);
    assert.doesNotMatch(text(mainHTML(html)), /price unavailable/i);
  });

  test(`${sport}: absent canonical provenance never borrows an unverified legacy price`, () => {
    const g = game({});
    g.open = { s: 999, so: [999, 999] };
    g.mkt = { s: 888, so: [888, 888] };
    g.close = { s: 777, so: [777, 777] };
    const html = load(sport)(g);
    assert.match(text(html), /unverified|unavailable|no .*evidence/i);
    assert.doesNotMatch(text(html), /999|888|777|0\s*·/);
  });

  test(`${sport}: missing current quote stays unavailable while opening evidence remains`, () => {
    const html = load(sport)(game({ 's:home': resolution('s', { current: null }) }));
    assert.match(text(mainHTML(html)), /-6/);
    assert.match(text(mainHTML(html)), /Current[\s\S]*unavailable/i);
    assert.doesNotMatch(text(mainHTML(html)), /0\s*·|Fresh/);
  });

  test(`${sport}: incomplete snapshot values cannot become a zero line or zero price`, () => {
    const html = load(sport)(game({ 's:home': resolution('s', {
      open: null,
      current: quote('s', 'current', { line_value: null, american_odds: null }),
    }) }));
    const visible = text(mainHTML(html));
    assert.match(visible, /Line unavailable/);
    assert.match(visible, /Price unavailable/);
    assert.doesNotMatch(visible, /\bPK\b|\bEV\b|\b0\b/);
  });

  test(`${sport}: suppressed current quotes retain their warning and never promote latest snapshot`, () => {
    const render = load(sport);
    for (const status of ['STALE', 'SUSPENDED', 'CONFLICTED']) {
      const html = render(game({ 's:home': resolution('s', {
        current: null, current_freshness: { status },
        latest_snapshot: quote('s', 'latest', { line_value: 999, american_odds: 999 }),
      }) }));
      const visible = text(mainHTML(html));
      assert.match(visible, /Current[\s\S]*Unavailable/);
      assert.match(visible, new RegExp(status === 'CONFLICTED' ? 'Conflict' : status, 'i'));
      assert.doesNotMatch(visible, /999|\bFresh\b/);
    }
  });

  test(`${sport}: old current quotes remain visible and stale`, () => {
    const html = load(sport)(game({ 's:home': resolution('s', {
      current: quote('s', 'current', { line_value: -2.5, american_odds: 115, source_observed_at: '2026-09-22T20:00:00Z' }),
    }) }));
    assert.match(text(mainHTML(html)), /-2\.5/);
    assert.match(text(mainHTML(html)), /\+115/);
    assert.match(text(mainHTML(html)), /Stale/i);
    assert.doesNotMatch(text(mainHTML(html)), /\bFresh\b/i);
    assert.ok(html.includes('2026-09-22 20:00:00 UTC'));
  });

  test(`${sport}: a game that has not started does not claim a closing quote`, () => {
    const html = load(sport)(game({ 's:home': resolution('s') }));
    const visible = text(mainHTML(html));
    assert.match(visible, /Close[\s\S]*(pending|not started|hasn.t started|after kickoff|awaiting)/i);
    assert.doesNotMatch(visible, /Verified close|Provisional close/i);
    assert.ok(html.includes('EVENT_NOT_STARTED'));
  });

  test(`${sport}: verified and provisional closing evidence remain distinct`, () => {
    const render = load(sport);
    for (const status of ['VERIFIED', 'PROVISIONAL']) {
      const r = resolution('s', {
        close: quote('s', 'close', { sportsbook: 'pin', line_value: -4, american_odds: -120 }),
        close_status: status,
        kickoff_basis: status === 'VERIFIED' ? 'VERIFIED_ACTUAL_START' : 'SCHEDULED_START',
        reason_code: status === 'VERIFIED' ? 'VERIFIED_ACTUAL_KICKOFF' : 'ACTUAL_KICKOFF_UNAVAILABLE',
      });
      const html = render(game({ 's:home': r }));
      const visible = text(mainHTML(html));
      assert.match(visible, new RegExp(status, 'i'));
      assert.match(visible, /-4\s+(?:·\s*)?-120/);
      assert.match(text(html), /Pinnacle/);
      assert.ok(html.includes('snapshot-s-close'));
      assert.ok(html.includes(r.reason_code));
      if (status === 'PROVISIONAL') assert.doesNotMatch(visible, /\bVerified\b/i);
      assert.doesNotMatch(visible, /VERIFIED_CLV|PROVISIONAL_CLV/);
    }
  });

  test(`${sport}: provider and audit strings cannot inject markup`, () => {
    const attack = '<img src=x onerror="alert(1)">&';
    const r = resolution('s', {
      open: quote('s', 'open', { sportsbook: attack, source: attack, snapshot_id: attack }),
      current: quote('s', 'current', { sportsbook: attack, source: attack, snapshot_id: attack }),
      close: quote('s', 'close', { sportsbook: attack, source: attack, snapshot_id: attack }),
      close_status: attack, kickoff_basis: attack, reason_code: attack,
    });
    const g = game({ 's:home': r }); g.home.abbr = attack;
    const html = load(sport)(g);
    assert.doesNotMatch(html, /<img\b|<script\b|onerror="alert/);
    assert.match(html, /&lt;img/);
    assert.ok(html.includes('&amp;'));
  });

  test(`${sport}: live repaint preserves an expanded source disclosure and its keyboard focus`, () => {
    const result = repaint(sport, { open: true, focused: true });
    assert.notEqual(result.current, result.previous, 'The game content was replaced');
    assert.equal(result.current.open, true);
    assert.equal(result.document.activeElement, result.current.summary);
    assert.equal(result.focusCalls.length, 1);
    assert.equal(result.focusCalls[0].preventScroll, true);
    assert.equal(result.writes, 1);
    assert.equal(result.chartWires, 1);
  });

  test(`${sport}: repaint keeps the disclosure state without moving focus from another control`, () => {
    for (const open of [false, true]) {
      const result = repaint(sport, { open });
      assert.equal(result.current.open, open);
      assert.equal(result.document.activeElement, result.outsideFocus);
      assert.equal(result.focusCalls.length, 0);
      assert.equal(result.chartWires, 1);
    }
  });

  test(`${sport}: repaint tolerates source evidence appearing or disappearing`, () => {
    for (const [beforePanel, afterPanel] of [[false, false], [false, true], [true, false]]) {
      const result = repaint(sport, { beforePanel, afterPanel, open: true, focused: true });
      assert.equal(result.writes, 1);
      assert.equal(result.chartWires, 1);
      assert.equal(result.focusCalls.length, 0);
      if (afterPanel) assert.equal(result.current.open, false);
      else assert.equal(result.current, null);
    }
  });

  test(`${sport}: rendering cannot alter persisted source evidence or quotes`, () => {
    const g = freeze(game());
    const before = JSON.stringify(g);
    const render = load(sport);
    const first = render(g);
    assert.equal(render(g), first);
    assert.equal(JSON.stringify(g), before);
  });
}
