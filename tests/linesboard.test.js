'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const LB = require('../design/linesboard');

const q = (line, price, pHome, at) => ({ line, price, pHome, at });
const data = () => ({ home: 'GB', away: 'ATL', markets: {
  s: { label: 'Spread', rows: [
    { key: 'pin', name: 'pin', open: q(-7.5, 104, null, '2026-09-21T00:25:02Z'), now: q(-4.5, -110), close: null },
    { key: 'dk', name: 'DK', open: q(-7.5, -110, null, '2026-05-14T20:08:22Z'), now: null, close: q(-5.5, -105) },
    { key: 'fd', name: 'FanDuel', open: q(-5.5, -120), now: q(-5.5, -104), close: null } ] },
  ml: { label: 'Moneyline', rows: [{ key: 'dk', name: 'DK', open: q(null, -360, 0.75), now: q(null, -245, 0.68), close: null }] } } });

test('no-vig home win chance from a moneyline pair; malformed pairs are null', () => {
  assert.equal(Math.round(LB.noVig([-110, -110]) * 1000) / 1000, 0.5);
  assert.equal(LB.noVig([-110, null]), null);
  assert.equal(LB.noVig([50, -110]), null);
});

test('moves read as words: spreads toward a side, totals up/down, moneylines in win-chance points', () => {
  assert.equal(LB.moveText('s', 3, 'GB', 'ATL'), '3 toward ATL');
  assert.equal(LB.moveText('s', -1.5, 'GB', 'ATL'), '1.5 toward GB');
  assert.equal(LB.moveText('t', -1, 'GB', 'ATL'), 'Down 1');
  assert.equal(LB.moveText('ml', -7.04, 'GB', 'ATL'), 'GB −7 pts');
  assert.equal(LB.moveText('s', 0, 'GB', 'ATL'), 'No move');
});

test('panel: tiles, a dumbbell row per book in three chart sizes, a table, readable names, escaped text', () => {
  LB._state.market = null; LB._state.wide = false;
  const html = LB.html('g1', data());
  assert.match(html, /class="lb"/);
  assert.match(html, /Market opened<\/div><div class="lb-v">GB −7\.5/);
  assert.match(html, /Pinnacle <small>3 toward ATL<\/small>/);
  assert.equal((html.match(/class="lb-row"/g) || []).length, 9, '3 books x 3 chart sizes');
  assert.match(html, /<th scope="row">Pinnacle<\/th>/, 'a raw key gets its readable name');
  assert.match(html, /class="lb-close"/, 'a frozen close is a diamond');
  assert.match(html, /class="lb-same"/, 'an unchanged book rings its dot');
  assert.match(html, /aria-pressed="true">Spread/);
  const bad = data(); bad.markets.s.rows[0].name = '<img src=x>';
  assert.doesNotMatch(LB.html('g2', bad), /<img src=x>/);
});

test('the board decides the first tab; empty markets are hidden; nothing renders without rows', () => {
  LB._state.market = null;
  const d = data(); d.markets = { ml: d.markets.ml, s: d.markets.s, t: { label: 'Total', rows: [] } };
  const html = LB.html('m1', d);
  assert.match(html, /aria-pressed="true">Moneyline/);
  assert.doesNotMatch(html, />Total</);
  assert.equal(LB.html('m2', { home: 'A', away: 'B', markets: { s: { label: 'Spread', rows: [] } } }), '');
});

test('nice ticks cover the range with round steps', () => {
  assert.deepEqual(LB.niceTicks(-8, -4, 5), [-8, -7, -6, -5, -4]);
  assert.deepEqual(LB.niceTicks(67.1, 76.2, 5), [68, 70, 72, 74, 76]);
});
