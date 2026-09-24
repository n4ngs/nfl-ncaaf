'use strict';
// SheetNav (design/linesboard.js): the game sheet's jump bar and folding sections.
const test = require('node:test');
const assert = require('node:assert/strict');
const { SheetNav } = require('../design/linesboard');

test('long reference sections start folded; a saved choice wins either way', () => {
  for (const t of ['Injury report', 'Injury Matrix', 'Where the money is', 'Key numbers', 'First half & team totals']) assert.equal(SheetNav.isOpen({}, t), false, t);
  for (const t of ['VAS', 'Model read', 'Line movement', 'The numbers', 'Every book', 'Your bets here']) assert.equal(SheetNav.isOpen({}, t), true, t);
  assert.equal(SheetNav.isOpen({ 'Injury report': true }, 'Injury report'), true);
  assert.equal(SheetNav.isOpen({ 'Every book': false }, 'Every book'), false);
});

test('chips use short names, and an unknown heading is trimmed to fit', () => {
  assert.equal(SheetNav.shortOf('Every book'), 'Books');
  assert.equal(SheetNav.shortOf('First half & team totals'), '1st half');
  assert.equal(SheetNav.shortOf('Weather'), 'Weather');
  assert.equal(SheetNav.shortOf('A very long section heading'), 'A very long s…');
});

test('BoardFX: freezes past 3000 px, and only a real number-to-number change flashes', () => {
  const { BoardFX } = require('../design/linesboard');
  assert.equal(BoardFX.FREEZE_AT, 3000);
  assert.equal(BoardFX.FROZEN, 3);
  for (const t of ['+8.2', '−3.5', 'o42.7', 'GB −8.2', '+323']) assert.equal(BoardFX.isNum(t), true, t);
  for (const t of ['—', '', '–']) assert.equal(BoardFX.isNum(t), false, t);
  assert.equal(BoardFX.isNum('PK'), true, 'a move to or from a pick is a change');
});
