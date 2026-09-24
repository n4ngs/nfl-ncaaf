'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeBoard } = require('../shared/owls-schema');
const { dropOutliers } = require('../shared/book-outliers');

// The live case: Ole Miss @ Florida, every book 58.5-60 and BetMGM's Owls totals market a -525/+360 rung at 45.5.
function mgmEvent(over = -525, under = 360, point = 45.5, status = 'scheduled') {
  return { id: '1637148840', commence_time: '2026-09-26T19:30:00Z', home_team: 'Florida Gators', away_team: 'Ole Miss Rebels', status,
    bookmakers: [{ key: 'betmgm', last_update: '2026-09-24T00:40:10Z', markets: [
      { key: 'totals', outcomes: [{ name: 'Over', price: over, point }, { name: 'Under', price: under, point }] },
      { key: 'h2h', outcomes: [{ name: 'Florida Gators', price: -160 }, { name: 'Ole Miss Rebels', price: 130 }] },
    ] }] };
}

test('Owls football alt-ladder total is never taken as the main line', () => {
  for (const sport of ['nfl', 'ncaaf']) {
    const L = normalizeBoard([mgmEvent()], sport)[0].books.mgm;
    assert.equal(L.t, null);
    assert.deepEqual(L.ml, [-160, 130]);
    for (const q of Object.values(L.integrityMeta.t)) {
      assert.equal(q.reason_code, 'OFF_MAIN_LINE_PRICE');
      assert.equal(q.reported_line_value, 45.5);
      assert.equal(q.market_status, 'unverified');
    }
  }
  // Main-line prices, live markets and MLB keep their numbers.
  assert.equal(normalizeBoard([mgmEvent(-110, -110, 58.5)], 'ncaaf')[0].books.mgm.t, 58.5);
  assert.equal(normalizeBoard([mgmEvent(-125, 105, 58.5)], 'ncaaf')[0].books.mgm.t, 58.5);
  assert.equal(normalizeBoard([mgmEvent(-525, 360, 45.5, 'live')], 'ncaaf')[0].live.mgm.t, 45.5);
  assert.equal(normalizeBoard([mgmEvent(-300, 240, 8.5)], 'mlb')[0].books.mgm.t, 8.5);
});

const line = (s, t, extra = {}) => ({ s, so: [-110, -110], t, to: [-110, -110], ml: [-160, 130],
  integrity: { s: { home: {}, away: {} }, t: { over: {}, under: {} } }, snapshot_ids: { s: {}, t: {} },
  market_sources: { s: 'owls', t: 'owls', ml: 'owls' }, ...extra });

test('a book far off consensus is dropped from display and move inputs, the rest untouched', () => {
  const books = { circa: line(-3.5, 58.5), dk: line(-3.5, 58.5), fd: line(-3.5, 59), pin: line(-3, 59), wynn: line(-3.5, 60),
    mgm: line(-3, 45.5), czr: line(-12, 58.5), open: line(-1.5, 47) };
  dropOutliers(books);
  assert.equal(books.mgm.t, null);
  assert.deepEqual(books.mgm.to, [null, null]);
  assert.equal(books.mgm.integrity.t, undefined);
  assert.equal(books.mgm.market_sources.t, undefined);
  assert.equal(books.mgm.outliers.t.line, 45.5);
  assert.equal(books.mgm.outliers.t.consensus, 58.75);
  assert.equal(books.mgm.s, -3);                     // its spread is fine and stays
  assert.equal(books.czr.s, null);                   // an 8.5-point spread miss is dropped too
  assert.equal(books.czr.t, 58.5);
  assert.equal(books.wynn.t, 60);                    // 1.5 off is a real market difference
  assert.equal(books.open.t, 47);                    // the opener is never judged
  assert.deepEqual(Object.keys(books.circa.integrity), ['s', 't']);
});

test('too few books to form a consensus leaves every number alone', () => {
  const books = { dk: line(-3.5, 58.5), fd: line(-3.5, 58.5), mgm: line(-3, 45.5) };
  dropOutliers(books);
  assert.equal(books.mgm.t, 45.5);
  assert.equal(books.mgm.outliers, undefined);
});

test('a near-market alt rung is dropped by its price shape; a stale line priced at its own number is kept', () => {
  const peers = () => ({ circa: line(6, 44.5), dk: line(6, 44.5), fd: line(6, 44.5), pin: line(6, 45) });
  // JMU @ ODU: MGM 48.5 with the easy under at -175 is the market's 44.5 re-priced, not a line.
  const alt = { ...peers(), mgm: line(6, 48.5, { to: [135, -175] }) };
  dropOutliers(alt);
  assert.equal(alt.mgm.t, null);
  // Oregon @ USC: home 0 at +140/-190 against a +3 market, the easy away side juiced.
  const spread = { circa: line(3, 62.5), dk: line(3, 62.5), fd: line(3, 62.5), pin: line(3, 62), mgm: line(0, 61.5, { so: [140, -190] }) };
  dropOutliers(spread);
  assert.equal(spread.mgm.s, null);
  // The same 48.5 at -110/-110 is a real off-market number, the edge the board exists to show.
  const stale = { ...peers(), mgm: line(6, 48.5) };
  dropOutliers(stale);
  assert.equal(stale.mgm.t, 48.5);
  // A 2-point gap is never judged on price alone.
  const near = { ...peers(), mgm: line(6, 46.5, { to: [135, -175] }) };
  dropOutliers(near);
  assert.equal(near.mgm.t, 46.5);
});
