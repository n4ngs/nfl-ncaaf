'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const E = require('../nhl/lib/vas-engine'), D = require('../nhl/lib/vas-data'), V = require('../nhl/lib/vas');
const MODEL = V.MODEL;

function history() {
  const games = [], shots = []; let gid = 2024020001;
  const day = n => new Date(Date.UTC(2024, 9, 8) + n * 86400000).toISOString().slice(0, 10);
  for (let n = 0; n < 40; n++) {
    const home = n % 2 ? 'AAA' : 'BBB', away = n % 2 ? 'BBB' : 'AAA';
    const lu = side => Array.from({ length: 18 }, (_, i) => ({ pid: (side === 'home' ? 1000 : 2000) + i + (home === 'AAA' ? 0 : 500) * (side === 'home' ? 1 : -1) + 5000, pos: i < 12 ? 'F' : 'D', toi: 15, a: i % 3 === 0 ? 1 : 0 }));
    games.push({ gid, season: 2024, day: day(n * 2), start: day(n * 2) + 'T23:00:00Z', home, away, homeGoals: 3 + (n % 3 === 0 ? 1 : 0), awayGoals: 2 + (n % 5 === 0 ? 2 : 0), lineups: { home: lu('home'), away: lu('away') } });
    for (let k = 0; k < 30; k++) shots.push({ gid, home: k % 2 === 0, xg: 0.05 + (k % 7) / 50, goal: k % 11 === 0 ? 1 : 0, hs: 5, as: k % 9 === 0 ? 4 : 5, en: false, goalie: k % 2 === 0 ? (home === 'AAA' ? 91 : 92) : (home === 'AAA' ? 81 : 82), shooter: 6000 + k });
    gid++;
  }
  return { games, shots };
}

test('mostRecentMode matches Python max(reversed(list), key=list.count)', () => {
  assert.equal(E.mostRecentMode([1, 2, 1, 2]), 2);
  assert.equal(E.mostRecentMode([1, 1, 2]), 1);
  assert.equal(E.mostRecentMode([3]), 3);
});

test('engine is deterministic, projects starters, and tiers the predicted line move', () => {
  const h = history();
  const a = E.build(h, MODEL.config).featuresFor({ home: 'AAA', away: 'BBB', season: 2024, day: '2024-12-30' });
  const b = E.build(h, MODEL.config).featuresFor({ home: 'AAA', away: 'BBB', season: 2024, day: '2024-12-30' });
  assert.deepEqual(a, b);
  assert.ok(a._home.proj && a._away.proj, 'both sides get a projected starter');
  const p = E.predict(a, MODEL); assert.ok(p > 0 && p < 1);
  const s = E.signal(a, p, { prob: p }, MODEL);
  assert.ok(['DIAMOND', 'GOLD', 'PASS'].includes(s.tier));
  const far = E.signal(a, 0.2, { prob: 0.8 }, MODEL);           // model far below market on home
  assert.equal(far.side, 'away'); assert.equal(far.tier, 'DIAMOND');
  assert.equal(E.signal(a, p, null, MODEL), null);
});

test('back-to-back rule projects the other goalie when the usual starter played yesterday', () => {
  const h = history();
  const st = E.build(h, MODEL.config);
  const last = h.games[h.games.length - 1];
  const next = new Date(Date.parse(last.day) + 86400000).toISOString().slice(0, 10);
  const f = st.featuresFor({ home: last.home, away: last.away, season: 2024, day: next });
  assert.equal(f._home.b2b, 1);
});

test('data: zip reader, MoneyPuck shot parser and boxscore compactor', () => {
  const csv = Buffer.from('season,game_id,isPlayoffGame,isHomeTeam,xGoal,goal,homeSkatersOnIce,awaySkatersOnIce,shotOnEmptyNet,goalieIdForShot,shooterPlayerId,name\n' +
    '2025,20001,0,1,0.12,0,5,5,0,8475683,8478402,"Doe, J"\n2025,30001,1,1,0.5,1,5,5,0,1,2,x\n2025,20002,0,0,0.3,1,4,5,1,0,8478402,y\n');
  const raw = zlib.deflateRawSync(csv), name = Buffer.from('shots_2025.csv');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(csv.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(csv.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const cdOff = local.length + name.length + raw.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(cdOff, 16);
  const zip = Buffer.concat([local, name, raw, central, name, eocd]);
  const rows = D.parseShots(D.unzipFirst(zip));
  assert.equal(rows.length, 2, 'playoff row dropped');
  assert.deepEqual(rows[0], { gid: 2025020001, home: true, xg: 0.12, goal: 0, hs: 5, as: 5, en: false, goalie: 8475683, shooter: 8478402 });
  assert.equal(rows[1].en, true); assert.equal(rows[1].goalie, 0);
  const box = { id: 2025020001, gameType: 2, gameState: 'OFF', gameDate: '2025-10-07', startTimeUTC: '2025-10-07T23:00:00Z', homeTeam: { abbrev: 'FLA', score: 3 }, awayTeam: { abbrev: 'CHI', score: 2 },
    playerByGameStats: { homeTeam: { forwards: [{ playerId: 1, toi: '15:30', assists: 1 }], defense: [{ playerId: 2, toi: '20:00', assists: 0 }], goalies: [{ playerId: 9, shotsAgainst: 30, name: { default: 'S. Bobrovsky' } }, { playerId: 10, shotsAgainst: 0 }] },
      awayTeam: { forwards: [], defense: [], goalies: [{ playerId: 7, shotsAgainst: 25 }] } } };
  const g = D.compactBox(box);
  assert.equal(g.starters.home, 9); assert.equal(g.lineups.home[0].toi, 15.5); assert.equal(g.goalieNames.home[9], 'S. Bobrovsky');
  assert.equal(D.compactBox({ ...box, gameType: 1 }), null);
});

test('service: market median/no-vig and best price, starter-change void, live record scored against the close', async () => {
  const bk = (h, a, h2 = h - 5, a2 = a + 8) => ({ dk: { integrity: { ml: { home: { american_odds: h, freshness: 'FRESH' }, away: { american_odds: a, freshness: 'FRESH' } } } },
    mgm: { integrity: { ml: { home: { american_odds: h2, freshness: 'FRESH' }, away: { american_odds: a2, freshness: 'FRESH' } } } },
    stale: { integrity: { ml: { home: { american_odds: 500, freshness: 'STALE' }, away: { american_odds: -900, freshness: 'STALE' } } } } });
  const m = V.market(bk(-150, 130));
  assert.equal(m.books, 2); assert.equal(m.best.away.odds, 138); assert.equal(m.best.away.book, 'mgm'); assert.ok(m.prob > 0.55 && m.prob < 0.6);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vas-'));
  const h = history();
  fs.mkdirSync(path.join(dir, 'box'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots_2024.json.gz'), zlib.gzipSync(JSON.stringify(h.shots)));
  for (const g of h.games) fs.writeFileSync(path.join(dir, 'box', g.gid + '.json'), JSON.stringify(g));
  let T = Date.parse('2026-10-08T15:00:00Z');
  const v = V.create({ dir, now: () => T, log: () => {}, getBody: async () => { throw Error('offline'); }, fetchBuffer: async () => { throw Error('offline'); } });
  assert.equal(v.forGame({ id: '1', gameType: 2 }, {}).status, 'LOADING');
  await v.refresh([]);
  const g = { id: '2026020001', gameType: 2, start: '2026-10-08T23:00:00Z', date: '2026-10-08', state: 'pre', home: { abbr: 'AAA' }, away: { abbr: 'BBB' } };
  assert.equal(v.forGame({ ...g, gameType: 1, preseason: true }, bk(-150, 130)).status, 'OFF');
  const o = v.forGame(g, bk(-400, 320));
  assert.equal(o.status, 'OK'); assert.ok(o.goalies.home.id);
  v.observeBox({ id: 2026020001, gameState: 'PRE', playerByGameStats: { homeTeam: { goalies: [{ playerId: 424242, starter: true }] }, awayTeam: { goalies: [] } } });
  const voided = v.forGame(g, bk(-400, 320));
  assert.equal(voided.tier, 'PASS'); assert.match(voided.reason, /different starter/);

  // live record: a signal before puck drop, scored against the last pre-puck market
  const g2 = { ...g, id: '2026020002' };
  const first = v.forGame(g2, bk(-400, 320));
  if (first.tier === 'DIAMOND' || first.tier === 'GOLD') {
    v.forGame(g2, bk(-300, 250));
    T = Date.parse('2026-10-08T23:05:00Z');
    v.forGame({ ...g2, state: 'in' }, bk(-280, 230));
    const s = v.summary();
    assert.equal(s.tiers.ALL.bets, 1); assert.ok(Number.isFinite(s.tiers.ALL.clvEvPct));
    v.forGame({ ...g2, state: 'post', final: true, home: { abbr: 'AAA', score: 1 }, away: { abbr: 'BBB', score: 4 } }, {});
    assert.equal(v.summary().tiers.ALL.settled, 1);
  }
  assert.ok(v.status().history.games >= 40);
});

test('parity with the Python research model (runs when the local fixture exists)', { skip: !fs.existsSync(path.join(__dirname, '../nhl/research/data/cache/parity/history.json')) }, () => {
  const R = path.join(__dirname, '../nhl/research/data/cache/');
  const hist = JSON.parse(fs.readFileSync(R + 'parity/history.json')), py = JSON.parse(fs.readFileSync(R + 'parity/features_py.json'));
  const st = E.build(hist, MODEL.config);
  const keys = ['ev_xgf', 'ev_xga', 'hd_xgf', 'hd_xga', 'pp_xgf', 'pk_xga', 'gf', 'ga', 'win', 'gsax100', 'logshots', 'share20', 'gb2b', 'share10', 'rest', 'b2b', 'lineup'];
  let worst = 0;
  for (const r of py) { const f = st.featured.get(r.gid); for (const side of ['home', 'away']) for (const k of keys) { const a = r[side + '_' + k], b = f['_' + side][k]; worst = Math.max(worst, a == null && b == null ? 0 : Math.abs(a - b)); } }
  assert.ok(worst < 1e-8, 'max feature difference ' + worst);
});
