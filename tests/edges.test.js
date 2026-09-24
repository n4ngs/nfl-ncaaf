'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createEdges = require('../edges');
const { buildRows, evidenceFor, render, NV_BOOKS } = createEdges;
const Feed = require('../shared/edges-feed');

const NOW = Date.parse('2026-09-23T18:00:00Z');
const later = (h) => new Date(NOW + h * 3600e3).toISOString();

const nhlFeed = { games: [
  { id: '1', start: later(6), home: { abbr: 'TOR' }, away: { abbr: 'MTL' }, vas: { status: 'OK', tier: 'DIAMOND', side: 'home', pHome: 0.6, market: { prob: 0.55, books: 7 }, goalies: { home: { id: 9, name: 'Woll' } }, confirmed: null },
    books: { mgm: { home: -150, away: 130 }, circa: { home: -140, away: 125 }, czr: { home: -145, away: 128 } } },
  { id: '2', start: later(7), home: { abbr: 'BOS' }, away: { abbr: 'NYR' }, vas: { status: 'OK', tier: 'GOLD', side: 'away' }, books: { mgm: { home: -120, away: 100 } } },
  { id: '3', start: later(-1), home: { abbr: 'EDM' }, away: { abbr: 'CGY' }, vas: { status: 'OK', tier: 'DIAMOND', side: 'home' }, books: { mgm: { home: -200, away: 170 } } },
] };
const mlbFeed = { ready: true, games: [
  { id: '77', start: later(2), matchup: 'NYY @ BOS', read: { tier: 'DIAMOND', side: 'away', gap: -0.34, price: 120 }, books: { stn: { home: -125, away: 110 }, wg: { home: -130, away: 112 } } },
] };
const ncaafFeed = { games: [
  { id: '50', start: later(30), home: { abbr: 'LSU' }, away: { abbr: 'TA&M' }, model: { status: 'OK', reads: [
    { book: 'stn', tier: 'THIN', side: 'away', bookOpen: -9, consensusOpen: -7, price: -115 },
    { book: 'sp', tier: 'THIN', side: 'away', bookOpen: -9, consensusOpen: -7, price: -105 },
    { book: 'wynn', tier: 'THIN', side: 'away', bookOpen: -9, consensusOpen: -7, price: 100 },     // not one of the owner's Nevada books
  ] }, books: {} },
  { id: '51', start: later(30), home: { abbr: 'ISU' }, away: { abbr: 'UTAH' }, model: { status: 'OK', reads: [{ book: 'sp', tier: 'WEAK', side: 'away', bookOpen: 7.5, consensusOpen: 8, price: -110 }] }, books: {} },
] };
const nflFeed = { games: [
  { id: '90', start: later(80), home: { abbr: 'IND' }, away: { abbr: 'HOU' }, model: { status: 'OK', total: { tier: 'PROVEN', direction: 'up', openTotal: 42.5, expected: 43.6, currentTotal: 42.5 } },
    books: { mgm: { t: 42.5, to: [-110, -110] }, stn: { t: 43, to: [-105, -115] }, circa: { t: 42.5, to: [-105, -115] } } },
  { id: '91', start: later(80), home: { abbr: 'WSH' }, away: { abbr: 'SEA' }, model: { status: 'OK', total: { tier: 'LEAN', direction: 'up', openTotal: 40.5, expected: 41.4 } }, books: {} },
] };
const feeds = { nhl: nhlFeed, mlb: mlbFeed, ncaaf: ncaafFeed, nfl: nflFeed };

test('only the listed signals qualify, each with its best Nevada price', () => {
  const { rows, status } = buildRows(feeds, NOW);
  assert.deepEqual(rows.map((r) => r.id), ['mlb:77', 'nhl:1', 'ncaaf:50', 'nfl:90'], 'sorted by start; GOLD, Weak, Lean and started games excluded');
  const by = Object.fromEntries(rows.map((r) => [r.sig, r]));
  assert.deepEqual(by.nhl.price, { odds: -140, book: 'circa' });
  assert.deepEqual(by.mlb.price, { odds: 112, book: 'wg' });
  assert.match(by.mlb.warn, /shorter than the tested DraftKings number \(\+120\)/);
  assert.equal(by.ncaaf.price.book, 'sp', 'best price among the owner Nevada books (Wynn is not one)');
  assert.equal(by.ncaaf.price.odds, -105);
  assert.equal(by.ncaaf.confidence, 'Thin read');
  assert.equal(by.ncaaf.title, 'South Point opened TA&M +9; the other books opened around TA&M +7.', 'home spread -9 read from the away side');
  assert.equal(by.nfl.price.book, 'circa', 'lowest total for an over read, then the better price');
  assert.equal(by.nfl.pick.text, 'Over 42.5');
  assert.equal(status.ncaaf.count, 1);
  const quiet = buildRows({ ncaaf: { games: [ncaafFeed.games[1]] }, nfl: { games: [nflFeed.games[1]] } }, NOW).status;
  assert.match(quiet.ncaaf.note, /1 smaller opener gap \(Weak reads\)/);
  assert.match(quiet.nfl.note, /1 smaller total read \(Lean\)/);
  for (const r of rows) assert.ok(NV_BOOKS[r.price.book], r.id + ' links a Nevada book');
});

test('green is reserved for proven signals; football rows are market reads with no bet wording', () => {
  const state = { ...buildRows(feeds, NOW), evidence: {}, at: NOW, errors: [] };
  const html = render(state, { owner: false, adminPath: '' });
  const rows = [...html.matchAll(/<article class="row" data-sig="(\w+)">([\s\S]*?)<\/article>/g)];
  assert.equal(rows.length, 4);
  for (const [, sig, body] of rows) {
    const green = /class="mk pv"/.test(body);
    assert.equal(green, sig !== 'nfl', sig + (green ? ' is green' : ' is neutral'));
    if (sig === 'nfl') assert.match(body, /class="mk pr">Provisional/);
    if (sig === 'nfl' || sig === 'ncaaf') {
      assert.match(body, /Market read/); assert.match(body, /class="tag">(Solid|Thin|Weak) read</); assert.match(body, /not advice/);
      assert.doesNotMatch(body, /\bbet (this|now|it)\b|\bstake|\bunits?\b|\block\b|\bhammer\b|\bpick\b/i);
    }
    for (const [, href] of body.matchAll(/href="(https?:[^"]+)"/g)) assert.ok(Object.values(NV_BOOKS).some((b) => b.url === href), 'Nevada-only link: ' + href);
  }
  assert.doesNotMatch(html, /\/proof|\/research/, 'guests get no owner links');
  const owner = render(state, { owner: true, adminPath: '/entry-0123456789abcdef0123456789' });
  assert.match(owner, /href="\/entry-0123456789abcdef0123456789\/proof"/);
  assert.match(owner, /research\?sport=ncaaf/);
  assert.match(owner, /late quarterback change/);
});

test('empty and unreachable boards read quietly', () => {
  const state = { ...buildRows({ nhl: { games: [{ id: '1', start: later(3), vas: { status: 'OFF', reason: 'The model covers regular-season games only.' } }] } }, NOW), evidence: {}, at: NOW, errors: ['MLB'] };
  const html = render(state, { owner: false });
  assert.match(html, /Nothing qualifies right now\./);
  assert.match(html, /regular-season games only/);
  assert.match(html, /Board not reachable right now/);
});

test('evidence picks the holdout row at the live threshold and the live record tier', () => {
  const health = { vas: { proven: { '0.05': { bets: 692, clv_ev_pct: 0.35 }, '0.08': { bets: 229, clv_ev_pct: 1.46, p: 0.001 }, '0.1': { bets: 106 } } } };
  const record = { pending: 2, tiers: { DIAMOND: { bets: 12, clvEvPct: 0.9, beatCloseRate: 0.75 }, GOLD: { bets: 40 } } };
  const e = evidenceFor('nhl', health, record);
  assert.equal(e.holdout.bets, 229); assert.equal(e.live.scored, 12); assert.equal(e.live.pending, 2);
  assert.equal(evidenceFor('ncaaf', { vas: { proven: { 'opener off consensus, read ≥ 1.0 pts': { bets: 424 }, 'opener off consensus, read ≥ 1.5 pts': { bets: 178 } } } }, null).holdout.bets, 178);
  assert.equal(evidenceFor('nfl', { vas: { proven: { 'total ≥ 0.75 pts': { bets: 500 }, 'total ≥ 1.0 pts': { bets: 238 } } } }, null).holdout.bets, 238);
  assert.equal(evidenceFor('mlb', { vas: { proven: { 'model vs DraftKings opener ≥ 0.3 logit': { bets: 482 } } } }, null).holdout.bets, 482);
  assert.equal(evidenceFor('mlb', null, null).holdout, null);
});

test('requests are served from the cache: engines are read once per refresh, never per request', async () => {
  let calls = 0;
  const data = { '/api/edges': (port) => ({ 5064: nhlFeed, 5063: mlbFeed, 5062: ncaafFeed, 5061: nflFeed })[port], '/api/health': () => null, '/api/vas/record': () => null };
  const E = createEdges({ sports: { nhl: { port: 5064 }, mlb: { port: 5063 }, ncaaf: { port: 5062 }, nfl: { port: 5061 } }, ownerCookie: 'x', adminPath: '/entry-0123456789abcdef0123456789',
    now: () => NOW, get: async (port, p) => { calls++; return data[p](port); }, log: () => {} });
  const call = (role, qs = '', method = 'GET', p = '/edges') => { const res = { writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } }; const handled = E.handle({ method }, res, p, qs, role); return { handled, ...res }; };
  assert.match(call('guest').body, /Checking the boards/, 'before the first refresh: a loading state, not a blocking compute');
  await E.refresh();
  const after = calls;
  assert.equal(after, 12, 'one feed + health + record per sport on the first refresh');
  for (let i = 0; i < 25; i++) call(i % 2 ? 'owner' : 'guest');
  assert.equal(calls, after, 'no engine call per request');
  await E.refresh();
  assert.equal(calls, after + 4, 'later refreshes read only the feeds; evidence is on its own slower clock');
  const g = call('guest');
  assert.equal(g.status, 200); assert.match(g.headers['content-security-policy'], /frame-ancestors 'none'/); assert.equal(g.headers['cache-control'], 'no-store');
  assert.match(g.body, /<!doctype html>/); assert.match(g.body, /aria-current="page">Edges/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(g.headers['content-security-policy'])[1];
  assert.match(g.body, new RegExp('<script nonce="' + nonce.replace(/[+/=]/g, '\\$&') + '">'));
  const part = call('guest', '?part=main');
  assert.match(part.body, /^<main class="ed" id="ed">/); assert.doesNotMatch(part.body, /<!doctype/);
  assert.equal(call(null).status, 302, 'locked boards send strangers to the door');
  assert.equal(call('guest', '', 'POST').status, 405);
  assert.equal(call('guest', '', 'GET', '/edges-x').handled, false);
});

test('engine feed: upcoming games only, owner Nevada books only, stale lines dropped, views reused', () => {
  const G = (id, h, state = 'pre') => ({ id, start: new Date(NOW + h * 3600e3).toISOString(), state, home: { abbr: 'A' }, away: { abbr: 'B' } });
  const W = { games: new Map([['1', G('1', 5)], ['2', G('2', -1, 'in')], ['3', G('3', 24 * 10)], ['4', G('4', 6)]]) };
  const seen = [];
  const view = (g) => { seen.push(g.id); return g.id === '4' ? { model: { status: 'OFF' } } : { model: { status: 'OK', total: { tier: 'PROVEN' } },
    books: { mgm: { s: -3, so: [-110, -110], t: 44, to: [-110, -110], ml: [-150, 130], freshness: 'FRESH', market_status: 'active' }, circa: { t: 44, freshness: 'STALE' }, wynn: { t: 44 }, dk: { t: 43 } } }; };
  const out = Feed.football({ weeks: [W, W], view, now: NOW });
  assert.deepEqual(seen, ['1', '4'], 'started and far-off games are never built; a week listed twice is read once');
  assert.equal(out.games.length, 1);
  assert.deepEqual(Object.keys(out.games[0].books), ['mgm']);
  assert.deepEqual(Feed.NEVADA, ['mgm', 'czr', 'circa', 'stn', 'wg', 'sp']);
});
