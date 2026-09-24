'use strict';
// "Steam" only when the market moves across independent feeds: several books landing in one aggregator refresh is
// that feed catching up (the owner found calling it steam misleading).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-'));

for (const sport of ['nfl', 'ncaaf']) {
  test(`${sport}: three books from one feed are not steam; the same move from two feeds is`, () => {
    const { Week } = require(`../${sport}/lib/lines`);
    const W = new Week({ season: 2026, type: 2, week: 3 }), t = Date.now();
    const move = (w, book, src, dt) => w.record('g', book, { t: 39.5, to: [-110, -110], src }, t - 60e3).concat(w.record('g', book, { t: 38.5, to: [-110, -110], src }, t + dt));
    let ch = ['dk', 'fd', 'czr'].flatMap((b, i) => move(W, b, 'owls', i * 1000));
    assert.equal(W.detect('g', ch, null, t + 3000).filter((m) => m.kind === 'steam').length, 0);
    const W2 = new Week({ season: 2026, type: 2, week: 4 });
    ch = [move(W2, 'dk', 'owls', 0), move(W2, 'fd', 'owls', 1000), move(W2, 'circa', 'vsin', 2000)].flat();
    const s = W2.detect('g', ch, null, t + 3000).filter((m) => m.kind === 'steam');
    assert.equal(s.length, 1); assert.equal(s[0].verified, true); assert.deepEqual(s[0].sources.sort(), ['owls', 'vsin']);
  });

  test(`${sport}: the move card says Steam only for a verified move, and where the market is now`, () => {
    const src = fs.readFileSync(path.join(__dirname, `../${sport}/public/js/core.js`), 'utf8');
    const body = src.slice(src.indexOf("const moveWord = {"), src.indexOf('function moveText('));
    const c = { quoteCanAct: () => true, fmtTot: String, fmtPts: (v) => (v > 0 ? '+' + v : String(v)), bookName: (k) => ({ pin: 'Pinnacle', circa: 'Circa' }[k] || k) };
    vm.createContext(c); vm.runInContext(body + '\nglobalThis.api = { moveKicker, moveNow, isSteam };', c);
    assert.equal(c.api.moveKicker({ kind: 'steam', books: ['dk', 'fd', 'czr'] }), 'Line move · 3 books');
    assert.match(c.api.moveKicker({ kind: 'steam', books: ['dk', 'fd', 'circa'], verified: true, sources: ['owls', 'vsin'] }), /^Steam · 3 books, 2 feeds$/);
    const g = { books: { dk: { t: 38.5 }, fd: { t: 38.5 }, czr: { t: 38.5 }, stn: { t: 39.5 }, sp: { t: 39.5 }, wynn: { t: 39.5 }, betr: { t: 39.5 }, pin: { t: 38.5 }, circa: { t: 38.5 }, cons: { t: 39.5 } } };
    const now = c.api.moveNow({ mkt: 't', to: 38.5 }, g);
    assert.equal(now.at, 5); assert.equal(now.of, 9); assert.equal(now.holds, true);
    assert.match(now.text, /^Now 38\.5 at 5 of 9 books · Pinnacle 38\.5, Circa 38\.5$/);
    const split = c.api.moveNow({ mkt: 't', to: 38.5 }, { books: { dk: { t: 38.5 }, fd: { t: 38.5 }, stn: { t: 39.5 }, sp: { t: 39.5 }, wynn: { t: 39.5 } } });
    assert.equal(split.holds, false); assert.match(split.text, /most at 39\.5/);
  });
}
