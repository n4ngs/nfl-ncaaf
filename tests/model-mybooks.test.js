'use strict';
// The boards' Model column (fair-price math, per-tab numbers) and the per-user "My books" highlight.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { create, BoardFair, KEY } = require('../design/mybooks');

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

test('fair price: no-vig American from a win probability, blank past ±2500', () => {
  assert.equal(BoardFair.american(0.5), -100);
  assert.equal(BoardFair.american(0.6), -150);
  assert.equal(BoardFair.american(0.4), 150);
  assert.equal(BoardFair.american(0.75), -300);
  assert.equal(BoardFair.american(0.25), 300);
  assert.equal(BoardFair.american(0.96), -2400);
  assert.equal(BoardFair.american(0.97), null, '-3233 is noise, not a number to read');
  assert.equal(BoardFair.american(0.03), null);
  for (const p of [0, 1, -0.1, 1.2, NaN, null, undefined]) assert.equal(BoardFair.american(p), null);
  // no vig: the two sides' implied probabilities add back to exactly one
  const imp = (a) => (a < 0 ? -a / (100 - a) : 100 / (100 + a));
  for (const p of [0.52, 0.61, 0.7, 0.83]) assert.ok(Math.abs(imp(BoardFair.american(p)) + imp(BoardFair.american(1 - p)) - 1) < 0.004);
  assert.equal(BoardFair.fmtAmerican(150), '+150');
  assert.equal(BoardFair.fmtAmerican(-150), '−150');
});

test('fair price: win probability is normal on the fair margin with the model SD', () => {
  assert.ok(Math.abs(BoardFair.ncdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(BoardFair.ncdf(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(BoardFair.ncdf(-1) - (1 - BoardFair.ncdf(1))) < 1e-9);
  assert.ok(Math.abs(BoardFair.winFromMargin(0, 13.66) - 0.5) < 1e-8);
  assert.ok(Math.abs(BoardFair.winFromMargin(13.66, 13.66) - 0.841345) < 1e-5);
  assert.equal(BoardFair.winFromMargin(3, 0), null);
  assert.equal(BoardFair.winFromMargin(NaN, 13), null);
  // a 7-point NFL favourite at the model's SD: about 69.5%, fair around -228
  const p = BoardFair.winFromMargin(7, 13.657990892286382);
  assert.ok(p > 0.69 && p < 0.70);
  assert.ok(BoardFair.american(p) <= -225 && BoardFair.american(p) >= -232);
});

test('my books: nothing by default; a toggle adds, saves, repaints and syncs; toggling again removes', () => {
  const storage = memStorage(), events = [];
  const mb = create({ storage, emit: (name, detail) => events.push([name, detail]) });
  assert.equal(mb.size(), 0);
  assert.equal(mb.has('mgm'), false);
  assert.equal(mb.cls('mgm'), '');
  let paints = 0; mb.subscribe(() => paints++);
  assert.equal(mb.toggle('dk'), true);
  assert.equal(mb.toggle('czr'), true);
  assert.deepEqual(mb.list(), ['dk', 'czr']);
  assert.equal(mb.cls('dk'), ' my-bk');
  assert.equal(mb.star('dk'), '★');
  assert.deepEqual(JSON.parse(storage.getItem(KEY)), ['dk', 'czr']);
  assert.equal(paints, 2);
  assert.deepEqual(events.at(-1), ['board:my-books', { books: ['dk', 'czr'] }]);
  assert.equal(mb.toggle('dk'), false, 'changing books takes the formatting away');
  assert.equal(mb.has('dk'), false);
  assert.equal(mb.cls('dk'), '');
  assert.deepEqual(JSON.parse(storage.getItem(KEY)), ['czr']);
  assert.equal(paints, 3);
  assert.equal(mb.toggle('<script>'), false, 'invalid keys are ignored');
  assert.deepEqual(mb.list(), ['czr']);
  // a fresh page on the same device starts from what was saved
  assert.deepEqual(create({ storage }).list(), ['czr']);
});

test('my books: picker chips reflect the selection and escape names', () => {
  const mb = create({ storage: memStorage({ [KEY]: '["mgm"]' }) });
  const html = mb.pickerHTML([{ key: 'mgm', name: 'BetMGM', short: 'BetMGM' }, { key: 'boom', name: "Boomer's", short: "Boomer's" }]);
  assert.match(html, /data-mybook="mgm" aria-pressed="true"/);
  assert.match(html, /data-mybook="boom" aria-pressed="false"/);
  assert.match(html, /Boomer&#39;s/);
  assert.ok(!html.includes("Boomer's"));
});

test('my books: account sync adopts the account list, never wipes device picks, and keeps a fresh change', () => {
  // signed in with a saved list, nothing changed on this page yet: the account's list wins
  let s = memStorage({ [KEY]: '["dk"]' }), ev = [];
  let mb = create({ storage: s, emit: (n, d) => ev.push([n, d]) });
  let paints = 0; mb.subscribe(() => paints++);
  mb.adoptAccount(['mgm', 'circa']);
  assert.deepEqual(mb.list(), ['mgm', 'circa']);
  assert.deepEqual(JSON.parse(s.getItem(KEY)), ['mgm', 'circa']);
  assert.equal(paints, 1);
  assert.equal(ev.length, 0);
  // the account has none yet: this device's picks are pushed up, not erased
  s = memStorage({ [KEY]: '["dk"]' }); ev = [];
  mb = create({ storage: s, emit: (n, d) => ev.push([n, d]) });
  mb.adoptAccount([]);
  assert.deepEqual(mb.list(), ['dk']);
  assert.deepEqual(ev, [['board:my-books', { books: ['dk'] }]]);
  // changed on this page before the account loaded: the change stands and is pushed
  s = memStorage(); ev = [];
  mb = create({ storage: s, emit: (n, d) => ev.push([n, d]) });
  mb.toggle('wynn');
  mb.adoptAccount(['mgm']);
  assert.deepEqual(mb.list(), ['wynn']);
  assert.deepEqual(ev.at(-1), ['board:my-books', { books: ['wynn'] }]);
});

// ------------------------------------------------------------ NFL: the Model column per tab
function nflModel() {
  const src = fs.readFileSync(path.join(__dirname, '../nfl/public/js/views.js'), 'utf8');
  const body = src.slice(src.indexOf('function modelMargin(g)'), src.indexOf('function boardRow(g, mkt)'));
  const c = { isPre: (g) => g.state === 'pre', SIGMA: 13.5, MINUS: '−', BoardFair,
    fmtOdds: (o) => (o == null ? '—' : o > 0 ? `+${o}` : `−${Math.abs(o)}`), ncdf: BoardFair.ncdf };
  vm.createContext(c); vm.runInContext(body + '\nglobalThis.api = { modelSide, modelFair, modelMargin, MODEL_TIP };', c);
  return c.api;
}
test('NFL Model column: fair spread, own total, fair moneyline and a derived first half, one number per side', () => {
  const m = nflModel();
  const g = { state: 'pre', home: { abbr: 'GB' }, away: { abbr: 'ATL' }, model: { status: 'OK', fairMargin: 8.16, fairTotal: 42.66, sd: 13.658 } };
  assert.equal(m.modelSide(g, 'home', 's'), '−8.2');
  assert.equal(m.modelSide(g, 'away', 's'), '+8.2');
  assert.equal(m.modelFair(g, 's'), 'GB −8.2');
  assert.equal(m.modelSide(g, 'over', 't'), 'o42.7');
  assert.equal(m.modelSide(g, 'under', 't'), 'u42.7');
  assert.equal(m.modelFair(g, 't'), 'o/u 42.7');
  const p = BoardFair.winFromMargin(8.16, 13.658);
  assert.equal(m.modelSide(g, 'home', 'ml'), `−${Math.abs(BoardFair.american(p))}`);
  assert.equal(m.modelSide(g, 'away', 'ml'), `+${BoardFair.american(1 - p)}`);
  assert.match(m.modelFair(g, 'ml'), /^GB −\d+$/);
  assert.equal(m.modelSide(g, 'home', 'h1'), '−4.1');
  assert.match(m.MODEL_TIP.h1, /derived/i);
  assert.match(m.MODEL_TIP.s, /not a pick/);
  // no read, a WAIT read, or a game underway: nothing (the column shows a dash)
  assert.equal(m.modelFair({ ...g, state: 'in' }, 's'), '');
  assert.equal(m.modelFair({ ...g, model: { status: 'WAIT', note: 'x' } }, 's'), '');
  assert.equal(m.modelSide({ ...g, model: null }, 'home', 'ml'), '');
});

// ------------------------------------------------------------ MLB: the Model column and My books on the board
function mlbHarness(myBooks) {
  const src = fs.readFileSync(path.join(__dirname, '../mlb/public/js/odds.js'), 'utf8');
  const NOW = Date.parse('2026-09-22T18:00:00Z');
  const saved = new Map();
  const c = { console, Map, Set, Date, AbortController, CSS: { escape: String }, BoardFair, MyBooks: myBooks,
    store: { get: (k, d) => (saved.has(k) ? saved.get(k) : d), set: (k, v) => saved.set(k, v) },
    S: { games: new Map(), date: '2026-09-22', isToday: true, tab: 'games' },
    serverNow: () => NOW, isOff: (g) => !!g.off, isDesk: () => true, chartW: () => 600,
    esc: (v) => String(v ?? '').replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x])),
    timeLabel: () => '7:10 PM', gameStatus: (g) => g.state, logo: () => '<img alt="">', ICON: { chev: '<svg></svg>' },
    $: () => null, clamp: (n, a, b) => Math.max(a, Math.min(b, n)),
    document: { addEventListener: () => {}, getElementById: () => null, querySelectorAll: () => [], hidden: false },
    fetch: async () => ({ ok: true, json: async () => ({}) }), requestAnimationFrame: () => 1, setInterval: () => 1, setTimeout: () => 1, clearTimeout: () => {},
  };
  vm.createContext(c);
  vm.runInContext(src + '\nglobalThis.state = ODDS; globalThis.MLBVAS = { reads: [], ready: true, at: 1 }; globalThis.ODDS_MODEL_TIP = ODDS_MODEL_TIP;', c);
  const g = { pk: 7, state: 'Preview', start: '2026-09-23T02:10:00Z', away: { id: 1, name: 'San Diego Padres', abbr: 'SD' }, home: { id: 2, name: 'Los Angeles Dodgers', abbr: 'LAD' } };
  c.S.games.set(7, g);
  c.state.games.set(7, { pk: 7, books: {} });
  return { c, g };
}
test('MLB Model column: fair moneyline and the model total; run line and first five are a dash with the reason', () => {
  const { c, g } = mlbHarness(create({ storage: memStorage() }));
  c.MLBVAS.reads = [{ pk: 7, status: 'OK', pHome: 0.6, total: 8.734 }]; c.MLBVAS.at = 2;
  assert.equal(c.oddsModelSide(g, 'ml', 'home'), '−150');
  assert.equal(c.oddsModelSide(g, 'ml', 'away'), '+150');
  assert.equal(c.oddsModelFair(g, 'ml'), 'LAD −150');
  assert.equal(c.oddsModelSide(g, 't', 'over'), 'o8.7');
  assert.equal(c.oddsModelFair(g, 't'), 'o/u 8.7');
  assert.equal(c.oddsModelSide(g, 'rl', 'home'), '');
  assert.equal(c.oddsModelSide(g, 'f5', 'home'), '');
  assert.match(c.ODDS_MODEL_TIP.rl, /no fair run line/);
  assert.match(c.ODDS_MODEL_TIP.f5, /full games/);
  const html = c.oddsBoardTable([g], 'rl');
  assert.match(html, /class="odds-bt has-model"/);
  assert.match(html, /<th class="mdl-th" title="No model number/);
  assert.match(c.oddsBoardTable([g], 'ml'), /<span class="odds-px mdl"><span class="num">−150<\/span>/);
  // a game underway or a WAIT read shows no model number
  assert.equal(c.oddsModelSide({ ...g, state: 'Live' }, 'ml', 'home'), '');
  c.MLBVAS.reads = [{ pk: 7, status: 'WAIT', note: 'Waiting for both probable starters.' }]; c.MLBVAS.at = 3;
  assert.equal(c.oddsModelFair(g, 'ml'), '');
});
test('MLB My books: no book lane by default; starred books get the lane; un-starring removes it', () => {
  const mb = create({ storage: memStorage() });
  const { c, g } = mlbHarness(mb);
  const lanes = (html) => [...html.matchAll(/<th class="my-bk" title="([^"]+)"/g)].map((m) => m[1]);
  let html = c.oddsBoardTable([g], 'ml');
  assert.deepEqual(lanes(html), [], 'nothing highlighted by default, BetMGM included');
  assert.ok(!/<td class="my-bk">/.test(html));
  mb.toggle('dk'); mb.toggle('circa');
  html = c.oddsBoardTable([g], 'ml');
  assert.deepEqual(lanes(html), ['Circa Sports · one of my books', 'DraftKings · one of my books']);
  assert.equal((html.match(/<td class="my-bk">/g) || []).length, 2);
  mb.toggle('dk');
  html = c.oddsBoardTable([g], 'ml');
  assert.deepEqual(lanes(html), ['Circa Sports · one of my books']);
  assert.match(c.oddsFilterBar([g]), /data-bets-books[^>]*><span class="mybk-star"/);
});

test('every board loads the shared My books layer and no board keeps a fixed BetMGM lane', () => {
  for (const sport of ['nfl', 'ncaaf', 'mlb', 'nhl']) {
    const html = fs.readFileSync(path.join(__dirname, `../${sport}/public/index.html`), 'utf8');
    assert.match(html, /<script src="\/_board\/mybooks\.js"><\/script>/, sport);
    assert.match(html, /<link rel="stylesheet" href="\/_board\/mybooks\.css">/, sport);
  }
  const css = ['design/broadcast.css', 'nfl/public/app.css', 'ncaaf/public/app.css', 'mlb/public/odds.css', 'mlb/public/app.css', 'nhl/public/app.css']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  assert.ok(!/data-bk="(?:mgm|betmgm)"\]/.test(css), 'no CSS rule singles out the BetMGM column');
  const terminal = fs.readFileSync(path.join(__dirname, '../terminal.js'), 'utf8');
  assert.match(terminal, /'mybooks\.css', 'mybooks\.js'/);
});
