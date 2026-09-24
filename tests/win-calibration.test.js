'use strict';
// Spread -> win chance, checked against real results: TeamRankings closing lines 2003-25 (favorite's win rate by
// closing spread; 18,601 FBS and 6,232 NFL favorites; ties count half). Win% only; cover math keeps its own SDs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// [closing spread, games, favorite wins] for the 7-9.5 point band
const BAND = {
  ncaaf: [[7, 834, 564], [7.5, 557, 401], [8, 220, 162], [8.5, 273, 191], [9, 237, 187], [9.5, 348, 254]],
  nfl: [[7, 446, 337], [7.5, 216, 157], [8, 75, 55], [8.5, 65, 49], [9, 164, 123], [9.5, 132, 115.5]],
};
// isotonic (monotone) empirical rate at exactly 7
const AT7 = { ncaaf: 0.6788, nfl: 0.7449 };

function core(sport) {
  const src = fs.readFileSync(path.join(__dirname, `../${sport}/public/js/core.js`), 'utf8');
  const body = src.slice(src.indexOf('function ncdf(x)'), src.indexOf('// ------------------------------------------------------------ lines'));
  const c = { clamp: (v, a, b) => Math.max(a, Math.min(b, v)) };
  vm.createContext(c);
  vm.runInContext(body + '\nglobalThis.api = { ncdf, SIGMA, WIN_SIGMA, winFromSpread, spreadFromWin };', c);
  return c.api;
}
const bandRate = (rows) => rows.reduce((s, r) => s + r[2], 0) / rows.reduce((s, r) => s + r[1], 0);
const bandPred = (rows, f) => rows.reduce((s, r) => s + r[1] * f(r[0]), 0) / rows.reduce((s, r) => s + r[1], 0);

for (const sport of ['ncaaf', 'nfl']) {
  test(`${sport}: win chance at a 7-point spread matches the TeamRankings band within 2 points`, () => {
    const C = core(sport);
    assert.equal(C.WIN_SIGMA, sport === 'ncaaf' ? 14.4 : 11.3);
    assert.equal(C.SIGMA, sport === 'ncaaf' ? 16 : 13.5, 'cover SD unchanged');
    assert.ok(Math.abs(C.winFromSpread(7) - AT7[sport]) < 0.02, `${C.winFromSpread(7)} vs ${AT7[sport]}`);
    const emp = bandRate(BAND[sport]), now = bandPred(BAND[sport], C.winFromSpread), was = bandPred(BAND[sport], (s) => C.ncdf(s / C.SIGMA));
    assert.ok(Math.abs(now - emp) < 0.02, `7-9.5 band: ${now} vs ${emp}`);
    assert.ok(Math.abs(now - emp) < Math.abs(was - emp), 'closer than the cover SD was');
    // symmetric, and spreadFromWin inverts it (home favored = negative spread)
    assert.ok(Math.abs(C.winFromSpread(-7) - (1 - C.winFromSpread(7))) < 1e-7);
    assert.equal(C.spreadFromWin(C.winFromSpread(7)), -7);
    assert.equal(C.winFromSpread(NaN), null);
  });
}

test('nfl: the model key-number distribution matches the TeamRankings 7-9.5 band within 2 points', { skip: !fs.existsSync(path.join(__dirname, '../nfl/lib/nfl-vas-model.json')) }, () => {
  const E = require('../nfl/lib/vas-engine');
  const kd = require('../nfl/lib/nfl-vas-model.json').keydist.margin;
  const win = (s) => E.winFromSpread(s, kd);
  const emp = bandRate(BAND.nfl), pred = bandPred(BAND.nfl, win);
  assert.ok(Math.abs(pred - emp) < 0.02, `${pred} vs ${emp}`);
  assert.ok(Math.abs(win(7) - AT7.nfl) < 0.02, `${win(7)} vs ${AT7.nfl}`);
  // at a half point it is the distribution itself; between half points it interpolates, rising with the spread
  const [o, p] = E.probs(E.fairMean(3, 0.5, kd), 0, kd);
  assert.ok(Math.abs(win(3) - (o + p / 2)) < 1e-12);
  let prev = 0.5;
  for (let s = 0.1; s <= 14; s += 0.1) { const w = win(s); assert.ok(w >= prev - 1e-9, `monotone at ${s}`); prev = w; }
  assert.ok(win(4.4) > win(4.0) && win(4.4) < win(4.5));
  assert.ok(Math.abs(win(-7) - (1 - win(7))) < 0.02, 'close to symmetric (home margins are not exactly)');
});

test('ncaaf: 17, 21 and 28 are key numbers whose bump comes from last season\'s margins', () => {
  const src = fs.readFileSync(path.join(__dirname, '../ncaaf/public/js/edge.js'), 'utf8');
  const keys = JSON.parse(src.match(/const EDGE_KEYS = (\[[^\]]*\])/)[1]);
  assert.deepEqual(keys, [3, 7, 10, 14, 17, 21, 28]);
  const body = src.slice(src.indexOf('function edgeLumpOf(hist)'), src.indexOf('function edgeLumps()'));
  const c = { EDGE_KEYS: keys, clamp: (v, a, b) => Math.max(a, Math.min(b, v)) };
  vm.createContext(c); vm.runInContext(body + '\nglobalThis.f = edgeLumpOf;', c);
  // a season where 28 lands 3x its neighbours gets a 28 bump; a flat one gets none worth the name
  const hist = {}; for (let m = 1; m <= 40; m++) hist[m] = 10; hist[28] = 30; hist[17] = 20;
  const L = c.f(hist);
  assert.ok(L.get(28) > 2.3 && L.get(17) > 1.6 && Math.abs(L.get(21) - 1) < 0.1);
});
