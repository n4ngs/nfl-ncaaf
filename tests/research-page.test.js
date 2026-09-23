'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createResearch = require('../research');
const ADMIN = '/entry-0123456789abcdef0123456789abcdef';
const SPORTS = { nfl: { dir: 'nfl', label: 'NFL' }, ncaaf: { dir: 'ncaaf', label: 'NCAAF' }, mlb: { dir: 'mlb', label: 'MLB' }, nhl: { dir: 'nhl', label: 'NHL' } };
const R = createResearch({ adminPath: ADMIN, sports: SPORTS, logo: '' });
const call = (p, qs, role) => { const res = { writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } }; const handled = R.handle({ method: 'GET' }, res, p, qs, role); return { handled, ...res }; };

test('research page renders every sport write-up for the owner only', () => {
  assert.equal(call('/other', '', 'owner').handled, false);
  assert.equal(call(ADMIN + '/research', '', 'guest').status, 404);
  assert.equal(call(ADMIN + '/research', '', null).status, 404);
  for (const k of Object.keys(SPORTS)) {
    const r = call(ADMIN + '/research', '?sport=' + k, 'owner');
    assert.equal(r.status, 200); assert.equal(r.headers['cache-control'], 'no-store');
    assert.match(r.body, /<table>/, k + ' has tables'); assert.match(r.body, new RegExp(`${k}/research/README.md`));
    assert.doesNotMatch(r.body, /<script/i);
  }
});

test('markdown renderer escapes raw HTML and handles tables, lists, code and links', () => {
  const { html, toc } = R.markdown('# T\n## Sec `a|b`\ntext <img src=x onerror=alert(1)> **bold** [l](https://x.y) [bad](javascript:alert(1))\n\n| a | b \\| c |\n|---|---|\n| `x` | 2 |\n\n- one\n  cont\n- two\n\n```\n<b>raw</b>\n```\n');
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
  assert.match(html, /<strong>bold<\/strong>/); assert.match(html, /href="https:\/\/x.y"/); assert.doesNotMatch(html, /href="javascript/);
  assert.match(html, /<th>b \| c<\/th>/); assert.match(html, /<li>one cont<\/li>/); assert.match(html, /&lt;b&gt;raw&lt;\/b&gt;/);
  assert.equal(toc.length, 2);
});
