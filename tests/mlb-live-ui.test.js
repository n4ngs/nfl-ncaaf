'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const NOW = Date.parse('2026-09-22T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
function quote(changes = {}) {
  return { source_observed_at: iso(NOW - 1000), received_at: iso(NOW), market_status: 'active', is_live: true,
    line_value: null, american_odds: -110, source: 'an', freshness: 'FRESH', actionable: true, max_age_ms: 50000, ...changes };
}
function fixture(savedSeg) {
  let now = NOW;
  const events = new Map(), opened = [], notices = [];
  const el = { dataset: {}, open: false, addEventListener() {}, classList: { toggle() {} }, setAttribute() {} };
  const game = { pk: 1, state: 'Live', detail: '', inning: 5, half: 'top', outs: 1,
    home: { id: 1, abbr: 'HOM', name: 'Home', score: 2 }, away: { id: 2, abbr: 'AWY', name: 'Away', score: 1 } };
  const closing = { ml: [-150, 130], rl: { line: -1.5, odds: [120, -140] }, t: { line: 8.5, odds: [-110, -110] }, seen: NOW };
  const live = { is_live: true, ml: [-110, 100], rl: { line: -2.5, odds: [-115, 105] }, t: { line: 10.5, odds: [-105, -115] },
    quote_meta: { ml: { home: quote(), away: quote({ american_odds: 100 }) },
      rl: { home: quote({ line_value: -2.5, american_odds: -115 }), away: quote({ line_value: 2.5, american_odds: 105 }) },
      t: { over: quote({ line_value: 10.5, american_odds: -105 }), under: quote({ line_value: 10.5, american_odds: -115 }) } } };
  const O = { pk: 1, books: { mgm: closing, cons: closing, pin: closing }, open: { ...closing }, close: { ...closing },
    f5: { mgm: { ml: [-170, 150], t: { line: 4.5, odds: [-110, -110] }, seen: NOW } }, live: { mgm: live }, history: [] };
  const context = vm.createContext({ Date, Math, Map, Set, WeakMap, JSON, Number, String, Intl, URLSearchParams,
    store: { get: (key, fallback) => key === 'betsSeg' && savedSeg !== undefined ? savedSeg : fallback, set() {} },
    location: { search: '' }, serverNow: () => now,
    S: { games: new Map([[1, game]]), isToday: true, tab: 'following', dlgKind: null },
    isOff: (g) => /postpon|cancel/i.test(g?.detail || ''), clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    document: { hidden: false, addEventListener(type, fn) { const list = events.get(type) || []; list.push(fn); events.set(type, list); }, body: { classList: { toggle() {} } } },
    $: () => el, $$: () => [], fetch: async () => ({ json: async () => ({}) }),
    setInterval() {}, setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {},
    openSheet: (...args) => opened.push(args), logo: () => '', ICON: { chev: '' }, gameStatus: () => 'Top 5', timeLabel: () => '',
  });
  for (const name of ['odds', 'bets']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'mlb/public/js', name + '.js'), 'utf8'), context, { filename: name + '.js' });
  context.currentOdds = O;
  vm.runInContext('ODDS.games.set(1,currentOdds); BETS.odds.set(1,currentOdds); betsToast = (message) => notices.push(message); betsOrigin=()=>null; betsSlipHTML=()=>"";', Object.assign(context, { notices }));
  return { context, game, O, live, events, opened, notices, run: (code) => vm.runInContext(code, context), advance: (ms) => { now += ms; } };
}

test('fresh live price uses exact selection evidence, independent of pregame and opposite-side projection', () => {
  const f = fixture();
  f.live.quote_meta.rl.away.line_value = 3.5;
  assert.equal(f.run("oddsLiveQuote(S.games.get(1),currentOdds,'mgm','rl','away').line"), 3.5);
  assert.equal(f.run("oddsPriceAt(1,'ml','home','mgm').odds"), -110);
  assert.equal(f.run("betsPrice(1,'mgm','rl','away').line"), 3.5);
  assert.equal(f.run("oddsLiveBest(S.games.get(1),currentOdds,'ml','home').book"), 'mgm');
});

test('live gate rejects stale, future, missing, conflicting, inactive and invalid evidence', () => {
  const variants = [
    { source_observed_at: iso(NOW - 50001) }, { source_observed_at: iso(NOW + 1) }, { source_observed_at: null },
    { source_observed_at: '2026-09-22T19:59:59' }, { received_at: iso(NOW - 2000) }, { received_at: null },
    { conflicted: true }, { freshness: 'CONFLICTED' }, { actionable: false }, { actionable: undefined },
    { is_live: false }, { market_status: 'unverified' }, { market_status: 'suspended' }, { market_status: 'removed' },
    { max_age_ms: null }, { american_odds: 0 }, { american_odds: null }, { freshness: 'UNVERIFIED' },
  ];
  for (const variant of variants) {
    const f = fixture(); Object.assign(f.live.quote_meta.ml.home, variant);
    assert.equal(f.run("oddsLiveQuote(S.games.get(1),currentOdds,'mgm','ml','home').actionable"), false, JSON.stringify(variant));
    assert.equal(f.run("betsPrice(1,'mgm','ml','home')"), null);
    assert.equal(f.run("oddsPriceAt(1,'ml','home','mgm')"), null);
    assert.equal(f.run("oddsLiveBest(S.games.get(1),currentOdds,'ml','home')"), null);
  }
});

test('age is recalculated at action time even when server freshness and receipt remain recent', () => {
  const f = fixture();
  assert.ok(f.run("betsPrice(1,'mgm','ml','home')"));
  f.advance(49000); assert.ok(f.run("betsPrice(1,'mgm','ml','home')"), 'the exact age limit is allowed');
  f.advance(1); assert.equal(f.run("betsPrice(1,'mgm','ml','home')"), null);
  assert.equal(f.live.quote_meta.ml.home.actionable, true, 'input server projection is immutable');
});

test('one stale selection does not suppress its independently fresh opposite selection', () => {
  const f = fixture(); f.live.quote_meta.ml.home.source_observed_at = iso(NOW - 60000);
  f.live.actionable = false; f.live.freshness = 'STALE';
  assert.equal(f.run("betsPrice(1,'mgm','ml','home')"), null);
  assert.equal(f.run("betsPrice(1,'mgm','ml','away').odds"), 100);
  assert.match(f.run("oddsBookCell(S.games.get(1),currentOdds,'ml','away','mgm',null,false)"), /data-odds-bet=/);
});

test('live action requires actual playing state; suspended game and first-five have no live prefill', () => {
  const f = fixture();
  assert.equal(f.run("oddsPriceAt(1,'f5ml','home','mgm')"), null);
  assert.equal(f.run("betsPrice(1,'mgm','f5ml','home')"), null);
  assert.doesNotMatch(f.run('oddsFiveHTML(1)'), /data-odds-bet=/);
  f.game.detail = 'Suspended'; assert.equal(f.run("betsPrice(1,'mgm','ml','home')"), null);
  f.game.detail = ''; f.game.state = 'Final'; assert.equal(f.run("oddsPriceAt(1,'ml','home','mgm')"), null);
  f.game.state = 'Preview';
  assert.equal(f.run("oddsPriceAt(1,'ml','home','mgm').odds"), -150);
  assert.equal(f.run("betsPrice(1,'mgm','f5ml','home').odds"), -170);
});

test('stale and suspended quotes remain labeled without buttons or best ranking', () => {
  const f = fixture();
  f.live.quote_meta.ml.home.source_observed_at = iso(NOW - 60000);
  const stale = f.run("oddsBookCell(S.games.get(1),currentOdds,'ml','home','mgm',null,false)");
  assert.match(stale, /Stale/); assert.match(stale, /110/); assert.doesNotMatch(stale, /<button|<a /);
  const tiles = f.run("betsSlipBooksHTML({pk:1,mkt:'ml',side:'home'},'mgm')");
  assert.match(tiles, /STALE/); assert.doesNotMatch(tiles, /data-bets-book="mgm"/); assert.match(tiles, /disabled/);
  f.live.quote_meta.ml.home.market_status = 'suspended';
  assert.match(f.run("oddsBookCell(S.games.get(1),currentOdds,'ml','home','mgm',null,false)"), /Suspended/);
});

test('fresh live MGM opens only local logging controls; historical detail remains non-actionable', () => {
  const f = fixture();
  const cell = f.run("oddsBookCell(S.games.get(1),currentOdds,'ml','home','mgm',null,false)");
  assert.match(cell, /data-odds-bet="1\|ml\|home\|mgm"/); assert.match(cell, /Live/);
  assert.doesNotMatch(cell, /betmgm\/go|data-mgmbet|<a /);
  const table = f.run('oddsTableHTML(1)');
  assert.match(table, /Live prices/); assert.match(table, /Pregame closing context/);
  const historical = table.slice(table.indexOf('Pregame closing context'));
  assert.doesNotMatch(historical, /data-odds-bet=/); assert.match(historical, /150/);
});

test('live quote changes never alter close, opener, history, pregame market helpers or model inputs', () => {
  const f = fixture(), original = JSON.stringify({ books: f.O.books, open: f.O.open, close: f.O.close, history: f.O.history });
  const modelBefore = f.run('JSON.stringify([...betsLiveDist(S.games.get(1)).margin])');
  f.live.quote_meta.ml.home.american_odds = -900;
  f.live.t.line = 99; f.live.ml = [-900, 700];
  f.run("oddsBookCell(S.games.get(1),currentOdds,'ml','home','mgm',null,false)");
  assert.equal(f.run('JSON.stringify([...betsLiveDist(S.games.get(1)).margin])'), modelBefore);
  assert.equal(f.run("oddsSide(oddsMktLine(currentOdds,false).L,'ml','home').odds"), -150);
  assert.equal(f.run("oddsEdgePrice(1,'ml','home',null,-900,'mgm')"), null);
  assert.equal(f.run("betsFair({pk:1,mkt:'ml',side:'home',odds:-900})"), null);
  assert.match(f.run('oddsMoveBits(S.games.get(1),currentOdds,false)'), /closing history/);
  assert.equal(JSON.stringify({ books: f.O.books, open: f.O.open, close: f.O.close, history: f.O.history }), original);
});

test('click-time recheck rejects aged board and slip book controls without stale prefills', () => {
  const f = fixture(); f.advance(51000);
  const target = { dataset: { oddsBet: '1|ml|home|mgm' }, closest: () => target };
  f.events.get('click')[0]({ target, preventDefault() {} });
  assert.equal(f.opened.length, 0); assert.match(f.notices.at(-1), /no longer available/);
  f.run("BETS.slip={legs:[{pk:1,mkt:'ml',side:'home',odds:125,book:'dk'}],book:'dk'}; betsReadSlip=()=>{}; betsPaintSlip=()=>{};");
  const tile = { dataset: { betsBook: 'mgm' }, closest: () => tile };
  f.events.get('click').at(-1)({ target: tile, preventDefault() {} });
  assert.equal(f.run('BETS.slip.book'), 'dk'); assert.equal(f.run('BETS.slip.legs[0].odds'), 125);
});

test('a pregame MGM anchor clicked after first pitch cannot navigate or prefill', () => {
  const f = fixture(); let prevented = false;
  const anchor = { dataset: { mgmbet: '1|ml|home|mgm' }, closest: () => anchor };
  f.events.get('click')[1]({ target: anchor, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.opened.length, 0);
});

test('live slip re-reads fresh price and cannot substitute stale book with pregame consensus', () => {
  const f = fixture();
  f.run("betsOpenSlip({pk:1,mkt:'rl',side:'away',book:'mgm',line:99,odds:900})");
  assert.equal(f.run('BETS.slip.legs[0].line'), 2.5); assert.equal(f.run('BETS.slip.legs[0].odds'), 105);
  f.advance(51000);
  assert.ok(Number.isNaN(f.run("betsLegFrom(1,'ml','home','mgm').odds")));
  f.run("betsOpenSlip({pk:1,mkt:'ml',side:'home',book:'mgm',odds:900})");
  assert.equal(f.opened.length, 1); assert.match(f.notices.at(-1), /unavailable/);
});

test('manual live entry stays available with blank price when no verified market price exists', () => {
  const f = fixture();
  f.run("betsOpenSlip({pk:1,mkt:'ml',side:'home',book:'cons',odds:-999})");
  assert.equal(f.opened.length, 1); assert.ok(Number.isNaN(f.run('BETS.slip.legs[0].odds')));
  assert.equal(f.run('BETS.slip.book'), '');
});

test('MLB opens My bets by default while preserving saved explicit sections', () => {
  assert.equal(fixture().run('BETS.seg'), 'mine');
  assert.equal(fixture('follow').run('BETS.seg'), 'follow');
  assert.equal(fixture('results').run('BETS.seg'), 'results');
});
