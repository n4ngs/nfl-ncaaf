'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const NOW = Date.parse('2026-09-22T20:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
function book({ ml = [-110, 100], rl = -1.5, total = 8.5, source = 'an', live = false } = {}) {
  const q = (odds, line = null) => ({ source, source_observed_at: iso(NOW - 1000), received_at: iso(NOW),
    is_live: live, market_status: 'active', freshness: 'FRESH', actionable: true,
    fresh_for_ms: 120000, max_age_ms: 900000, american_odds: odds, line_value: line });
  return { is_live: live, ml, rl: { line: rl, odds: [-115, 105] }, t: { line: total, odds: [-105, -115] }, seen: NOW,
    quote_meta: { ml: { home: q(ml[0]), away: q(ml[1]) },
      rl: { home: q(-115, rl), away: q(105, -rl) }, t: { over: q(-105, total), under: q(-115, total) } } };
}
function fixture() {
  let now = NOW;
  const events = new Map(), opened = [], notices = [], fields = new Map();
  const el = { dataset: {}, open: false, addEventListener() {}, classList: { toggle() {} }, setAttribute() {}, focus() {} };
  const game = { pk: 1, state: 'Preview', detail: '', start: iso(NOW + 3600000),
    home: { id: 1, abbr: 'HOM', name: 'Home' }, away: { id: 2, abbr: 'AWY', name: 'Away' } };
  const O = { pk: 1, books: { mgm: book(), dk: book({ ml: [-120, 110] }), cons: book(), pin: book({ ml: [-130, 120] }) },
    f5: { mgm: book({ ml: [-170, 150], rl: 0, total: 4.5 }), dk: book({ total: 5 }) },
    open: book({ ml: [900, -1000] }), close: book({ ml: [800, -900] }), live: {}, history: [] };
  const context = vm.createContext({ Date, Math, Map, Set, WeakMap, JSON, Number, String, Intl, URLSearchParams,
    store: { get: (key, fallback) => fallback, set() {} }, location: { search: '' }, serverNow: () => now,
    S: { games: new Map([[1, game]]), isToday: true, tab: 'following', dlgKind: null },
    isOff: (g) => /postpon|cancel/i.test(g?.detail || ''), clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    esc: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    document: { hidden: false, addEventListener(type, fn) { const list = events.get(type) || []; list.push(fn); events.set(type, list); }, body: { classList: { toggle() {} } } },
    $: (key) => fields.get(key) || (/^#bets(Line|Odds|Stake|Book|Note)$/.test(key) ? null : el), $$: () => [],
    fetch: async () => { throw new Error('No network in slip tests'); },
    CSS: { escape: (v) => v }, setInterval() {}, setTimeout() {}, clearTimeout() {}, requestAnimationFrame() {},
    openSheet: (...args) => opened.push(args), logo: () => '', ICON: { chev: '' }, gameStatus: () => 'Preview', timeLabel: () => '',
    currentOdds: O, notices,
  });
  for (const name of ['odds', 'bets']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'mlb/public/js', name + '.js'), 'utf8'), context, { filename: name + '.js' });
  const run = (code) => vm.runInContext(code, context);
  run('ODDS.games.set(1,currentOdds); BETS.odds.set(1,currentOdds); betsToast=(message)=>notices.push(message); betsOrigin=()=>null; betsSlipHTML=()=>""; betsPaintSlip=()=>{};');
  return { run, O, game, opened, notices, fields, advance: (ms) => { now += ms; },
    clickBook(key) { const target = { dataset: { betsBook: key }, closest: () => target }; events.get('click').at(-1)({ target, preventDefault() {} }); } };
}
const tile = (html, name) => html.split('<button').find((s) => s.includes(`aria-label="${name}:`))?.split('</button>')[0] || '';

test('pregame prefills require current source evidence for the exact selection', () => {
  const variants = [
    { source_observed_at: iso(NOW - 900001) },
    { source_observed_at: null }, { source_observed_at: '2026-09-22T19:59:59' }, { received_at: null },
    { source_observed_at: iso(NOW + 1) }, { received_at: iso(NOW - 2000) },
    { freshness: 'STALE' }, { freshness: 'UNVERIFIED' }, { freshness: 'CONFLICTED' },
    { actionable: false }, { market_status: 'suspended' }, { market_status: 'removed' },
    { is_live: true }, { american_odds: -125 },
  ];
  for (const change of variants) {
    const f = fixture(); Object.assign(f.O.books.mgm.quote_meta.ml.home, change);
    assert.equal(f.run("betsPrice(1,'mgm','ml','home')"), null, JSON.stringify(change));
    assert.equal(f.run("betsPrice(1,'mgm','ml','away').odds"), 100, 'opposite fresh selection remains available');
    assert.equal(f.O.books.mgm.seen, NOW, 'recent receipt cannot rescue source evidence');
  }
  // an aging price (past 2 minutes, inside 15) is usable, labelled, as on every board
  const a = fixture(); a.O.books.mgm.quote_meta.ml.home.source_observed_at = iso(NOW - 120001);
  assert.equal(a.run("betsPrice(1,'mgm','ml','home').freshness"), 'AGING');
  const f = fixture(); delete f.O.books.mgm.quote_meta;
  assert.equal(f.run("betsPrice(1,'mgm','ml','home')"), null);
  assert.equal(f.run("betsQuote(1,'mgm','ml','home').freshness"), 'UNVERIFIED');
});

test('prefills reject wrong side, reference prices, manually overlaid prices and wrong game phase', () => {
  const f = fixture();
  for (const args of ["'mgm','ml','over'", "'mgm','rl','under'", "'mgm','t','home'", "'open','ml','home'", "'close','ml','home'"]) {
    assert.equal(f.run(`betsPrice(1,${args})`), null);
  }
  f.O.books.mgm.m = true; assert.equal(f.run("betsPrice(1,'mgm','ml','home')"), null); delete f.O.books.mgm.m;
  f.O.books.mgm.is_live = true; assert.equal(f.run("betsPrice(1,'mgm','ml','home')"), null); f.O.books.mgm.is_live = false;
  for (const [state, detail] of [['Final', ''], ['Preview', 'Postponed'], ['Preview', 'Suspended'], ['Live', '']]) {
    Object.assign(f.game, { state, detail });
    assert.equal(f.run("betsPrice(1,'mgm','ml','home')"), null);
    assert.doesNotMatch(f.run("betsSlipBooksHTML({pk:1,mkt:'ml',side:'home'},'')"), /data-bets-book="mgm"/);
  }
  f.run('S.games.clear()'); assert.equal(f.run("betsPrice(1,'mgm','ml','home')"), null);
  assert.equal(f.run("betsSlipBooksHTML({pk:1,mkt:'ml',side:'home'},'')"), '');
  assert.equal(f.run("oddsSide(currentOdds.close,'ml','home').odds"), 800, 'historical reference reader remains unchanged');
});

test('F5 has independent evidence, exact side lines and a real zero run line', () => {
  const f = fixture();
  assert.equal(f.run("betsPrice(1,'mgm','f5ml','home').odds"), -170);
  assert.equal(f.run("betsPrice(1,'mgm','f5rl','home').line"), 0);
  f.O.f5.mgm.quote_meta.rl.away.line_value = 1;
  assert.equal(f.run("betsPrice(1,'mgm','f5rl','away')"), null);
  delete f.O.f5.mgm.ml;
  assert.equal(f.run("betsPrice(1,'mgm','f5ml','home')"), null, 'RL 0 does not invent F5 moneyline');
  assert.ok(f.run("betsPrice(1,'mgm','ml','home')"), 'full game remains independent');
  delete f.O.books;
  assert.match(f.run("betsSlipBooksHTML({pk:1,mkt:'f5rl',side:'home'},'')"), /data-bets-book="mgm"/);
});

test('named-book leg never substitutes consensus and quoted handoff cannot restore stale opts', () => {
  const f = fixture(); f.O.books.mgm.quote_meta.ml.home.freshness = 'STALE';
  assert.ok(Number.isNaN(f.run("betsLegFrom(1,'ml','home','mgm').odds")));
  assert.equal(f.run("betsLegFrom(1,'ml','home','mgm').book"), 'mgm');
  f.run("betsOpenSlip({pk:1,mkt:'ml',side:'home',book:'mgm',odds:900})");
  assert.equal(f.opened.length, 0); assert.match(f.notices.at(-1), /unavailable/);
  f.run("betsOpenSlip({pk:1,mkt:'rl',side:'away',book:'dk',line:99,odds:900})");
  assert.equal(f.run('BETS.slip.legs[0].line'), 1.5);
  assert.equal(f.run('BETS.slip.legs[0].odds'), 105);
});

test('F5 quoted handoff re-reads current data and rejects an expired source clock', () => {
  const f = fixture();
  f.run("betsOpenSlip({pk:1,mkt:'f5t',side:'over',book:'mgm',line:99,odds:900})");
  assert.equal(f.run('BETS.slip.legs[0].line'), 4.5);
  assert.equal(f.run('BETS.slip.legs[0].odds'), -105);
  f.advance(900000);
  f.run("betsOpenSlip({pk:1,mkt:'f5t',side:'over',book:'mgm',line:4.5,odds:-105})");
  assert.equal(f.opened.length, 1); assert.match(f.notices.at(-1), /unavailable/);
});

test('manual picker opens with blank prices when evidence is unavailable; typed entry remains valid', () => {
  const f = fixture(); delete f.O.books.cons.quote_meta;
  f.run("betsOpenSlip({pk:1,mkt:'rl',side:'away',book:'cons',line:99,odds:900})");
  assert.equal(f.opened.length, 1);
  assert.ok(Number.isNaN(f.run('BETS.slip.legs[0].line')));
  assert.ok(Number.isNaN(f.run('BETS.slip.legs[0].odds')));
  assert.equal(f.run('BETS.slip.book'), '');
  f.fields.set('#betsLine', { value: '+1.5' }); f.fields.set('#betsOdds', { value: '+125' });
  f.fields.set('#betsBook', { value: 'other' }); f.fields.set('#betsStake', { value: '25' });
  f.run('betsReadSlip()');
  assert.equal(f.run('betsProblems().length'), 0);
  assert.equal(f.run('BETS.slip.legs[0].odds'), 125);
  assert.equal(f.run('BETS.slip.legs[0].line'), 1.5);
});

test('comparison tiles label stale and missing evidence but only fresh rows receive Best or select controls', () => {
  const f = fixture(); f.O.books.mgm.ml[0] = 900; f.O.books.mgm.quote_meta.ml.home.american_odds = 900;
  f.O.books.mgm.quote_meta.ml.home.source_observed_at = iso(NOW - 900001);
  delete f.O.books.pin.quote_meta;
  const html = f.run("betsSlipBooksHTML({pk:1,mkt:'ml',side:'home'},'mgm')");
  const stale = tile(html, 'BetMGM'), unknown = tile(html, 'Pinnacle'), fresh = tile(html, 'DraftKings');
  assert.match(stale, /disabled/); assert.match(stale, /Stale/); assert.doesNotMatch(stale, /Best|data-bets-book=/);
  assert.match(unknown, /Unavailable/); assert.match(unknown, /disabled/);
  assert.match(fresh, /data-bets-book="dk"/); assert.match(fresh, /Fresh · Best/);
  f.O.books.dk.quote_meta.ml.home.actionable = false;
  assert.doesNotMatch(f.run("betsSlipBooksHTML({pk:1,mkt:'ml',side:'home'},'')"), /Best/);
});

test('F5 total comparisons normalize the market and rank lower totals for over, higher for under', () => {
  const f = fixture();
  const over = f.run("betsSlipBooksHTML({pk:1,mkt:'f5t',side:'over'},'')");
  assert.match(tile(over, 'BetMGM'), /Fresh · Best/); assert.match(tile(over, 'BetMGM'), /o4.5/);
  assert.doesNotMatch(tile(over, 'DraftKings'), /Best/);
  const under = f.run("betsSlipBooksHTML({pk:1,mkt:'f5t',side:'under'},'')");
  assert.match(tile(under, 'DraftKings'), /Fresh · Best/); assert.match(tile(under, 'DraftKings'), /u5/);
  assert.doesNotMatch(tile(f.run("betsSlipBooksHTML({pk:1,mkt:'f5ml',side:'home'},'')"), 'BetMGM'), /PK|−?170 −?170/);
});

test('click-time source expiry preserves typed values and selected book without adopting a stale price', () => {
  const f = fixture();
  f.run("betsOpenSlip({pk:1,mkt:'rl',side:'away',book:'dk'})");
  assert.match(f.run("betsSlipBooksHTML(BETS.slip.legs[0],'dk')"), /data-bets-book="mgm"/);
  f.fields.set('#betsLine', { value: '+2.5' }); f.fields.set('#betsOdds', { value: '+125' });
  f.fields.set('#betsBook', { value: 'dk' }); f.advance(900000);
  f.clickBook('mgm');
  assert.equal(f.run('BETS.slip.book'), 'dk'); assert.equal(f.run('BETS.slip.legs[0].book'), 'dk');
  assert.equal(f.run('BETS.slip.legs[0].line'), 2.5); assert.equal(f.run('BETS.slip.legs[0].odds'), 125);
  assert.match(f.notices.at(-1), /no longer available/);
});

test('click-time re-read takes the current exact F5 quote, and Other keeps manually entered values', () => {
  const f = fixture(); f.run("betsOpenSlip({pk:1,mkt:'f5t',side:'over',book:'dk'})");
  f.O.f5.mgm.t.line = 4; f.O.f5.mgm.t.odds[0] = 125;
  Object.assign(f.O.f5.mgm.quote_meta.t.over, { line_value: 4, american_odds: 125 });
  f.clickBook('mgm');
  assert.equal(f.run('BETS.slip.book'), 'mgm'); assert.equal(f.run('BETS.slip.legs[0].line'), 4);
  assert.equal(f.run('BETS.slip.legs[0].odds'), 125);
  f.fields.set('#betsLine', { value: '3.5' }); f.fields.set('#betsOdds', { value: '+140' });
  f.advance(900000); f.clickBook('other');
  assert.equal(f.run('BETS.slip.book'), 'other'); assert.equal(f.run('BETS.slip.legs[0].book'), '');
  assert.equal(f.run('BETS.slip.legs[0].line'), 3.5); assert.equal(f.run('BETS.slip.legs[0].odds'), 140);
});

test('a game changing phase cannot reuse pregame or F5 prices on click', () => {
  const f = fixture(); f.run("betsOpenSlip({pk:1,mkt:'ml',side:'home',book:'dk'})");
  f.game.state = 'Live'; f.clickBook('mgm');
  assert.equal(f.run('BETS.slip.book'), 'dk'); assert.equal(f.run('BETS.slip.legs[0].odds'), -120);
  f.O.live.mgm = book({ live: true, ml: [140, -160] }); f.clickBook('mgm');
  assert.equal(f.run('BETS.slip.legs[0].odds'), 140, 'only separately evidenced live quote can be used');
  assert.equal(f.run("betsPrice(1,'mgm','f5ml','home')"), null);
  f.game.state = 'Final'; f.clickBook('dk'); assert.equal(f.run('BETS.slip.book'), 'mgm');
});

test('current price gating never blanks saved tickets or copied parlay legs', () => {
  const f = fixture();
  f.run("BETS.list=[{id:'saved',status:'open',created:serverNow(),odds:155,stake:25,book:'BetMGM',legs:[{pk:1,mkt:'ml',side:'home',line:null,odds:155,label:'HOM ML',matchup:'AWY @ HOM',state:'open'}]}]; BETS.parlay=BETS.list[0].legs.map(l=>({...l,book:'mgm'}));");
  const original = f.run('JSON.stringify(BETS.list)'), parlay = f.run('JSON.stringify(BETS.parlay)');
  f.advance(900000);
  const html = f.run('betsCard(BETS.list[0])');
  assert.match(html, /\+155/); assert.doesNotMatch(html, /market now/);
  f.run('betsOpenSlip({parlay:true})'); assert.equal(f.run('BETS.slip.legs[0].odds'), 155);
  f.run('BETS.slip.legs[0].odds=110');
  assert.equal(f.run('JSON.stringify(BETS.list)'), original);
  assert.equal(f.run('JSON.stringify(BETS.parlay)'), parlay);
});
