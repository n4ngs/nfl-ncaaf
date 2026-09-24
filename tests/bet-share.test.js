'use strict';
// Sharing a bet: the words that travel with the picture, Mail / Messages links, and the system share sheet fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const View = require('../design/portfolio-view');

test('share text: pick and price, book, game, status, amount only when given, and the board link', () => {
  const t = View.share.text({ pick: 'BUF −3.5', odds: '−110', book: 'BetMGM', matchup: 'Bills @ Chiefs', date: 'Sun, Oct 4 · 1:25 PM', status: '', amount: '', url: 'https://x.test/nfl/' });
  assert.equal(t, 'BUF -3.5 -110 at BetMGM\nBills @ Chiefs · Sun, Oct 4 · 1:25 PM\nhttps://x.test/nfl/');
  assert.match(View.share.text({ pick: 'Over 8.5', odds: '+100', status: 'Won', amount: '$50 to win $50' }), /Over 8\.5 \+100\nWon\n\$50 to win \$50/);
});

test('Email and Message links carry the words (Mail and Messages on a Mac or an iPhone)', () => {
  const t = 'BUF -3.5 -110 at BetMGM\nhttps://x.test/nfl/';
  assert.equal(View.share.mailto(t, 'My bet'), 'mailto:?subject=My%20bet&body=BUF%20-3.5%20-110%20at%20BetMGM%0Ahttps%3A%2F%2Fx.test%2Fnfl%2F');
  assert.equal(View.share.sms(t), 'sms:?&body=BUF%20-3.5%20-110%20at%20BetMGM%0Ahttps%3A%2F%2Fx.test%2Fnfl%2F');
});

test('system share: the image when the browser takes files, else the words and link; cancel is quiet', async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const calls = [];
  const set = (nav) => Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  try {
    set({});
    assert.equal(await View.share.send({ text: 'x' }), 'unsupported');
    set({ share: async (d) => { calls.push(d); }, canShare: (d) => !!d.files });
    assert.equal(await View.share.send({ file: { name: 'bet.png' }, text: 'words', url: 'u', title: 'My bet' }), 'shared');
    assert.deepEqual(calls.at(-1), { files: [{ name: 'bet.png' }], title: 'My bet' });
    set({ share: async (d) => { calls.push(d); } });   // desktop browser with a share sheet but no file sharing
    assert.equal(await View.share.send({ file: { name: 'bet.png' }, text: 'words', url: 'u', title: 'My bet' }), 'shared');
    assert.deepEqual(calls.at(-1), { title: 'My bet', text: 'words', url: 'u' });
    set({ share: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; } });
    assert.equal(await View.share.send({ text: 'w' }), 'aborted');
    set({ share: async () => { throw new Error('nope'); } });
    assert.equal(await View.share.send({ text: 'w' }), 'failed');
    set({ clipboard: { writeText: async (s) => calls.push(s) } });
    assert.equal(View.share.canCopyText(), true); assert.equal(await View.share.copyText('hi'), true); assert.equal(calls.at(-1), 'hi');
  } finally { if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator; }
});

test('every ticket in My bets gets its Share button without opening the details', () => {
  const t = { key: 'nfl:1', sport: 'nfl', status: 'open', phase: 'upcoming', book: 'BetMGM', odds: -110, stake: 10, legs: [{ label: 'BUF -3.5', matchup: 'BUF @ KC' }], placedAt: '2026-10-01T00:00:00Z', raw: { id: 'b1' } };
  const html = View.renderTicket(t, { sport: 'nfl', shareHTML: (x) => `<button data-share-bet="${x.raw.id}">Share</button>` });
  assert.match(html, /<div class="portfolio-actions"><button data-share-bet="b1">Share<\/button><\/div>\s*<details/);
  assert.doesNotMatch(View.renderTicket(t, { sport: 'nfl' }), /portfolio-actions/);
});
