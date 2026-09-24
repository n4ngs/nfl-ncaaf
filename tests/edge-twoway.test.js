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
    vm.createContext(c); vm.runInContext(body + cav + '\nglobalThis.api = { edgeRows, edgeCaveats };', c);
    const rows = c.api.edgeRows();
    const by = (side, line) => rows.find((r) => r.side === side && r.line === line);
    assert.equal(by('over', 45.5).twoWay.pick, 'Under 45.5');
    assert.equal(by('home', -3.5).twoWay.pick, 'BUF 3.5', 'a spread pairs with the opposite number');
    assert.equal(by('over', 44.5).twoWay, null, 'a different number is not the same coin flip');
    assert.ok(Math.abs(by('under', 45.5).twoWay.both - (1 / (2 / 2.05) - 1)) < 1e-12);
    assert.match(c.api.edgeCaveats(by('over', 45.5))[0], /^Other side too: Under 45\.5 \+105 at DK, books disagree, a coin flip alone$/);
  });
}
