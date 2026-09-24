'use strict';
// Edge Finder: both sides of the same number showing a gap are the books disagreeing, not a lean.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport} Edge Finder: both sides of the same number are marked, and say it is a coin flip alone`, () => {
    const src = fs.readFileSync(path.join(__dirname, `../${sport}/public/js/edge.js`), 'utf8');
    const body = src.slice(src.indexOf('function edgeRows('), src.indexOf('const edgeAll'));
    const cav = src.slice(src.indexOf('function edgeCaveats(e)'), src.indexOf('function edgeLabel(e)'));
    const g = { id: 'g1', start: '2026-10-01T17:00:00Z', home: { abbr: 'KC' }, away: { abbr: 'BUF' }, moves: [] };
    const row = (side, book, line, odds, ev) => ({ g, gid: 'g1', mkt: side === 'over' || side === 'under' ? 't' : 's', side, book, line, odds, ev, conf: 'thin', onlyBook: false, mktN: 3, est: false });
    const list = [row('over', 'mgm', 45.5, 105, 0.017), row('under', 'dk', 45.5, 105, 0.017), row('home', 'mgm', -3.5, 110, 0.02), row('away', 'czr', 3.5, 110, 0.02), row('over', 'wynn', 44.5, 110, 0.01)];
    const c = { allGames: () => [g], isPre: () => true, edgesFor: () => list, dec: (o) => (o > 0 ? 1 + o / 100 : 1 + 100 / -o), fmtOdds: (o) => (o > 0 ? '+' + o : String(o)), fmtTot: String, fmtPts: (v) => (v > 0 ? '+' + v : String(v)),
      bookName: (k) => k.toUpperCase(), serverNow: () => 0, trim: String, Map };
    c.edgePick = (e) => (e.mkt === 't' ? `${e.side === 'over' ? 'Over' : 'Under'} ${e.line}` : `${e.g[e.side].abbr} ${e.line}`);
    vm.createContext(c); vm.runInContext('var edgeLeftOut = 0;\n' + body.replace('let edgeLeftOut = 0;', '') + cav + '\nglobalThis.api = { edgeRows, edgeCaveats };', c);
    const rows = c.api.edgeRows();
    const by = (side, line) => rows.find((r) => r.side === side && r.line === line);
    assert.equal(by('over', 45.5), undefined, 'both sides of 45.5 are left out');
    assert.equal(by('under', 45.5), undefined);
    assert.equal(by('home', -3.5), undefined, 'a spread pairs with the opposite number, and is left out');
    assert.equal(by('over', 44.5).twoWay, null, 'a different number is not the same coin flip, and stays');
    assert.equal(vm.runInContext('edgeLeftOut', c), 2);
  });
}

test('MLB Edge Finder: both sides of the same number are marked, and say it is a coin flip alone', () => {
  const src = fs.readFileSync(path.join(__dirname, '../mlb/public/js/odds.js'), 'utf8');
  const body = src.slice(src.indexOf('function oddsEdgeRows('), src.indexOf('const oddsEdgePct'));
  const cav = src.slice(src.indexOf('function oddsEdgeCaveats(e)'), src.indexOf('const oddsEdgeWhen'));
  const g = { pk: 1, start: '2026-09-24T17:00:00Z', home: { abbr: 'NYY' }, away: { abbr: 'BOS' } };
  const row = (mkt, side, book, line, odds, ev) => ({ g, pk: 1, mkt, side, book, line, odds, ev, conf: 'thin', onlyBook: false, age: null });
  const list = [row('t', 'over', 'mgm', 8.5, 105, 0.017), row('t', 'under', 'dk', 8.5, 105, 0.017), row('ml', 'home', 'mgm', null, 110, 0.02), row('rl', 'away', 'czr', 1.5, 150, 0.02)];
  const c = { oddsDayGames: () => [g], oddsIsPre: () => true, oddsEdgeScore: () => list, oddsShowWeak: () => true, oddsFmt: (o) => (o > 0 ? '+' + o : String(o)),
    oddsBookName: (k) => k.toUpperCase(), oddsGame: () => null, ODDS: { moves: new Map() }, serverNow: () => 0, Map, Set };
  c.oddsPick = (gg, mkt, side, line) => (mkt === 't' ? `${side === 'over' ? 'Over' : 'Under'} ${line}` : `${gg[side].abbr}${line == null ? ' ML' : ' ' + line}`);
  vm.createContext(c); vm.runInContext(body + cav + '\nglobalThis.api = { oddsEdgeRows, oddsEdgeCaveats };', c);
  const rows = c.api.oddsEdgeRows();
  assert.equal(rows.find((r) => r.mkt === 't'), undefined, 'both sides of 8.5 are left out');
  assert.equal(rows.find((r) => r.mkt === 'ml').twoWay, null);
  assert.equal(rows.find((r) => r.mkt === 'rl').twoWay, null);
});
