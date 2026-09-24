'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const E = require('../nfl/lib/vas-engine');

const R = path.join(__dirname, '../nfl/research/data/cache/');
const MODEL_PATH = R + 'nfl-vas-model.json';
const REAL = fs.existsSync(MODEL_PATH) ? JSON.parse(fs.readFileSync(MODEL_PATH)) : null;

// ---------------- synthetic league: 4 teams, round robin, deterministic plays and snaps
function history(nWeeks = 8) {
  const teams = ['AAA', 'BBB', 'CCC', 'STL'], games = [], plays = [], snaps = [];
  const day = n => new Date(Date.UTC(2024, 8, 8) + n * 86400000).toISOString().slice(0, 10);
  let w = 0;
  for (let wk = 1; wk <= nWeeks; wk++) {
    const pairs = wk % 3 === 0 ? [[0, 1], [2, 3]] : wk % 3 === 1 ? [[0, 2], [1, 3]] : [[0, 3], [1, 2]];
    for (const [i, j] of pairs) {
      const home = teams[wk % 2 ? i : j], away = teams[wk % 2 ? j : i];
      const gid = `2024_${String(wk).padStart(2, '0')}_${away}_${home}`;
      const hs = 17 + ((i * 7 + wk * 3) % 14), as = 14 + ((j * 5 + wk) % 13);
      games.push({ gid, season: 2024, week: wk, day: day(7 * (wk - 1)), time: wk % 2 ? '13:00' : '16:25', home, away, homeScore: hs, awayScore: as, neutral: false, div: 0, roof: 'outdoors' });
      for (const [off, def] of [[home, away], [away, home]]) {
        const strong = off === 'AAA' ? 0.15 : off === 'STL' ? -0.1 : 0;
        for (let k = 0; k < 60; k++) {
          const kind = k % 10 === 9 ? 's' : k % 2 ? 'p' : 'r';
          const epa = strong + Math.sin(k * 1.7 + wk) * 0.8;
          plays.push([gid, off === 'STL' ? 'LA' : off, def === 'STL' ? 'LA' : def, kind, epa, epa > 0 ? 1 : 0, kind === 'p' ? `QB-${off}-${wk >= 6 && off === 'BBB' ? 2 : 1}` : '', k === 55 ? 0.99 : 0.5]);
        }
        for (let p = 0; p < 22; p++) {
          const pos = ['QB', 'T', 'T', 'G', 'C', 'WR', 'WR', 'TE', 'RB', 'DE', 'DT', 'LB', 'LB', 'CB', 'CB', 'SS', 'FS', 'G', 'WR', 'DE', 'DT', 'OLB'][p];
          const out = off === 'CCC' && p === 5 && wk === nWeeks;       // CCC's WR1 misses the last game
          if (out) continue;
          snaps.push([gid, off, `${off}-P${p}`, pos, p < 9 || p >= 17 && p < 19 ? 1 : 0, p >= 9 && p < 17 || p >= 19 ? 1 : 0, 1]);
        }
      }
    }
    w++;
  }
  return { games, plays, snaps };
}

function syntheticModel() {
  const kd = { sd: 13.5, k_min: -80, w: Array.from({ length: 201 }, (_, i) => (i - 80 === 3 || i - 80 === -3 ? 3 : i - 80 === 7 || i - 80 === -7 ? 2 : 1)) };
  const lin = (features, coef, intercept) => ({ features, mean: features.map(() => 0), std: features.map(() => 1), coef, intercept });
  return {
    config: E.DEFAULT_CONFIG,
    stage1: { margin: lin(['d_op', 'd_dp', 'neutral'], [60, -60, -1.5], 1.8), total: lin(['s_op', 's_dp'], [30, 30], 44) },
    stage2: { spread: lin(['x_gap', 'x_open'], [0.12, 0], 0), total: lin(['xt_gap'], [0.1], 0) },
    keydist: { margin: kd, total: { sd: 13.5, k_min: -80, w: Array(201).fill(1) } },
    tiers: { spread: { proven: 1.0, lean: 0.5 }, total: { proven: null, lean: 1.0 } },
    pmiss: { Out: 1, Doubtful: 0.99, Questionable: 0.35, Probable: 0.06 },
  };
}

test('compactPlay keeps scrimmage + special-teams plays and drops kneels, spikes, no-EPA rows', () => {
  const base = { game_id: 'g', posteam: 'KC', defteam: 'BUF', epa: '0.5', success: '1', qb_dropback: '1', play_type: 'pass', special: '0', qb_kneel: '0', qb_spike: '0', passer_id: '00-1', wp: '0.6' };
  assert.deepEqual(E.compactPlay(base), ['g', 'KC', 'BUF', 'p', 0.5, 1, '00-1', 0.6]);
  assert.equal(E.compactPlay({ ...base, qb_kneel: '1', play_type: 'qb_kneel', qb_dropback: '0' }), null);
  assert.equal(E.compactPlay({ ...base, qb_spike: '1' }), null);
  assert.equal(E.compactPlay({ ...base, epa: 'NA' }), null);
  assert.equal(E.compactPlay({ ...base, play_type: 'run', qb_dropback: '0', passer_id: 'NA', wp: 'NA' })[3], 'r');
  assert.equal(E.compactPlay({ ...base, play_type: 'run', qb_dropback: '0', wp: 'NA' })[7], null);
  assert.equal(E.compactPlay({ ...base, play_type: 'punt', special: '1', qb_dropback: '0' })[3], 's');
  assert.equal(E.compactPlay({ ...base, play_type: 'no_play', qb_dropback: '0' }), null);
});

test('engine is deterministic, walks strictly before each day, and maps relocated franchises', () => {
  const h = history();
  const a = E.build(h), b = E.build(JSON.parse(JSON.stringify({ ...h, games: h.games.slice().reverse() })));
  for (const [gid, f] of a.featured) assert.deepEqual(f, b.featured.get(gid), 'input order must not matter');
  const first = a.featured.get(h.games[0].gid);
  assert.equal(first.d_op, 0, 'no history -> league prior on both sides');
  assert.equal(first._home.rest, E.DEFAULT_CONFIG.rest_cap);
  // STL (games file) and LA (pbp) are one franchise: STL's offense must pick up its (weak) LA-coded plays
  const next = a.featuresFor({ home: 'AAA', away: 'STL', season: 2024, day: '2024-11-10', time: '13:00', neutral: false, div: 0, roof: 'dome' });
  assert.ok(next._away.op < next._home.op, 'weak STL/LA offense rated below AAA');
  assert.equal(next.dome, 1);
  assert.ok(Number.isFinite(next.d_qb) && next._home.proj === 'QB-AAA-1');
});

test('projected QB is last game\'s starter; QB change shows up as a low start share', () => {
  const h = history(), st = E.build(h);
  const f = st.featuresFor({ home: 'BBB', away: 'CCC', season: 2024, day: '2024-11-10', time: '13:00', neutral: false, div: 1, roof: 'outdoors' });
  assert.equal(f._home.proj, 'QB-BBB-2');
  assert.ok(f._home.qbshare < 1 && f._home.qbshare > 0);
  assert.equal(f.div, 1);
});

test('previous-game personnel: a regular who missed the last game counts as missing snap share', () => {
  const h = history(), st = E.build(h);
  const f = st.featuresFor({ home: 'CCC', away: 'AAA', season: 2024, day: '2024-11-10', time: '13:00', neutral: false, div: 0, roof: 'outdoors' });
  assert.ok(f._home.m_WR > 0.5, 'CCC WR1 missing: ' + f._home.m_WR);
  assert.equal(f._away.m_WR, 0);
  const players = st.players('CCC');
  assert.ok(players.length >= 18 && players[0].share >= players[players.length - 1].share);
});

test('schedule: rest, bye, short week, time-zone shift and neutral site', () => {
  const st = E.build(history());
  const short = st.featuresFor({ home: 'AAA', away: 'LAC', season: 2024, day: '2024-10-31', time: '13:00', neutral: false, div: 0, roof: 'outdoors' });
  assert.equal(short._home.short, 1); assert.equal(short.away_tz, 3); assert.equal(short.west_early, 1);
  const neutral = st.featuresFor({ home: 'AAA', away: 'LAC', season: 2024, day: '2024-11-20', time: '09:30', neutral: true, div: 0, roof: 'outdoors' });
  assert.equal(neutral.away_tz, 0); assert.equal(neutral.neutral, 1); assert.equal(neutral._home.bye, 1);
});

test('key-number distribution: fair mean, push handling and CLV EV', () => {
  const kd = syntheticModel().keydist.margin, flat = syntheticModel().keydist.total;
  assert.ok(Math.abs(E.fairMean(44, 0.5, flat) - 44) < 1e-6, 'symmetric -110/-110 on a flat distribution -> fair mean on the number');
  const m3 = E.fairMean(3, 0.5, kd);
  assert.ok(m3 > 2 && m3 < 5, 'key-number mass on both sides of 3 shifts the fair mean: ' + m3);
  assert.equal(E.noVig(-110, -110), 0.5); assert.equal(E.noVig(0, -110), null); assert.equal(E.noVig(-110, null), null);
  const [over, push] = E.probs(3, 3, kd);
  assert.ok(push > 0.05 && over > 0.4 && over + push < 1, 'a 3 is sticky');
  assert.ok(Math.abs(E.clvEv(44.5, 44.5, -110, true, flat) - (0.5 * (1 + 100 / 110) - 1)) < 1e-6, 'fair half-point line at -110 = -4.5%');
  assert.ok(E.clvEv(4.0, 2.5, -110, true, kd) > 0.03, 'home -2.5 when the close is -4 beats the close');
  assert.ok(E.clvEv(4.0, 2.5, -110, false, kd) < -0.1);
  assert.ok(E.fairMean(3, 0.55, kd) > m3);
});

test('predict and signal: stage-1 margin/total, stage-2 move and tiers', () => {
  const M = syntheticModel(), st = E.build(history());
  const f = st.featuresFor({ home: 'AAA', away: 'STL', season: 2024, day: '2024-11-10', time: '13:00', neutral: false, div: 0, roof: 'outdoors' });
  const p = E.predict(f, M);
  assert.ok(p.margin > 1.8 && Number.isFinite(p.total));
  const s = E.signal(f, p, { spread: p.margin - 12, homePrice: -110, awayPrice: -110, total: p.total + 20, overPrice: -110, underPrice: -110 }, M);
  assert.equal(s.spread.side, 'home'); assert.equal(s.spread.tier, 'PROVEN');
  assert.equal(s.total.side, 'under'); assert.equal(s.total.tier, 'LEAN', 'totals have no proven tier here');
  const flat = E.signal(f, p, { spread: p.margin, homePrice: -110, awayPrice: -110 }, M);
  assert.equal(flat.spread.tier, 'PASS'); assert.equal(flat.total, undefined);
  assert.equal(E.signal(f, p, null, M), null);
});

test('injury matrix sorts the line-movers to the top', () => {
  const M = syntheticModel(), st = E.build(history());
  const rows = E.injuryMatrix(st, 'CCC', [{ pid: 'CCC-P99', name: 'backup', pos: 'DT', status: 'Out' }, { pid: 'CCC-P0', name: 'QB1', pos: 'QB', status: 'Questionable' },
    { pid: 'CCC-P5', name: 'WR1', pos: 'WR', status: 'Doubtful' }, { name: 'unknown', pos: 'LS', status: 'Out' }], M);
  assert.equal(rows[0].name, 'WR1');
  assert.ok(rows[0].weight > rows[1].weight && rows[1].name === 'QB1');
  assert.equal(rows[rows.length - 1].weight, 0);
  assert.equal(rows.find(r => r.name === 'backup').share, 0, 'non-regular carries no weight');
});

test('exported model is well-formed and matches the engine defaults', { skip: !REAL }, () => {
  assert.deepEqual(REAL.config, { ...E.DEFAULT_CONFIG });
  for (const st of [REAL.stage1.margin, REAL.stage1.total, REAL.stage2.spread, REAL.stage2.total]) {
    assert.equal(st.features.length, st.coef.length); assert.equal(st.mean.length, st.std.length);
    assert.ok(st.std.every(x => x > 0));
  }
  assert.equal(REAL.keydist.margin.w.length, 201);
  assert.ok(['PROVEN', 'UNPROVEN'].includes(REAL.status));
});

test('parity with the Python research features (runs when the local fixture exists)', { skip: !fs.existsSync(R + 'parity/history.json') }, () => {
  const hist = JSON.parse(fs.readFileSync(R + 'parity/history.json')), py = JSON.parse(fs.readFileSync(R + 'parity/features_py.json'));
  const cfg = REAL ? REAL.config : E.DEFAULT_CONFIG;
  const st = E.build(hist, cfg);
  let worst = 0, checked = 0;
  for (const r of py) {
    const f = st.featured.get(r.gid); assert.ok(f, 'missing game ' + r.gid);
    for (const [k, a] of Object.entries(r)) {
      if (k === 'gid') continue;
      const b = k in f ? f[k] : k.startsWith('home_') ? f._home[k.slice(5)] : f._away[k.slice(5)];
      if (typeof a === 'string' || a === null || typeof b === 'string' || b === null) { assert.equal(b, a, `${r.gid} ${k}`); continue; }
      worst = Math.max(worst, Math.abs(a - b)); checked++;
    }
  }
  assert.ok(checked > 50000, 'checked ' + checked);
  assert.ok(worst < 1e-8, 'max feature difference ' + worst);
  if (fs.existsSync(R + 'parity/model_py.json') && REAL) {                 // stage-1/2 predictions + fair means
    const mp = JSON.parse(fs.readFileSync(R + 'parity/model_py.json'));
    let w2 = 0;
    for (const r of mp) {
      const f = st.featured.get(r.gid), p = E.predict(f, REAL);
      w2 = Math.max(w2, Math.abs(p.margin - r.margin), Math.abs(p.total - r.total));
      if (r.spread != null) {
        const s = E.signal(f, p, { spread: r.spread, homePrice: r.hp, awayPrice: r.ap, total: r.tot, overPrice: r.op, underPrice: r.up }, REAL);
        w2 = Math.max(w2, Math.abs(s.spread.fair - r.fair), Math.abs(s.spread.move - r.move));
        if (r.move_t != null) w2 = Math.max(w2, Math.abs(s.total.move - r.move_t));
      }
    }
    assert.ok(w2 < 1e-8, 'max model difference ' + w2);
  }
});

test('injury matrix resolves ESPN rows by normalized name, position group breaking ties', () => {
  const h = history();
  const names = { 'CCC-P0': 'Patrick Mahomes II', 'CCC-P5': "Ja'Marr Chase", 'CCC-P6': 'José Ramírez Jr.', 'CCC-P13': 'Chris Jones', 'CCC-P10': 'Chris Jones' };
  h.snaps = h.snaps.map(s => [...s, names[s[2]] || null]);
  const st = E.build(h), M = syntheticModel();
  assert.equal(E.normName('Odell Beckham Jr.'), 'odell beckham'); assert.equal(E.normName('A.J. Brown'), 'aj brown'); assert.equal(E.normName('  José  Ramírez III '), 'jose ramirez');
  const rows = E.injuryMatrix(st, 'CCC', [
    { id: '3139477', name: 'Patrick Mahomes', pos: 'QB', status: 'Questionable' },     // suffix dropped
    { id: '4362628', name: 'JaMarr Chase', pos: 'WR', status: 'Doubtful' },            // punctuation dropped (WR1 who missed the last game)
    { id: '1', name: 'jose ramirez', pos: 'WR', status: 'Out' },                       // accents + case
    { id: '2', name: 'Chris Jones', pos: 'DT', status: 'Out' },                        // two regulars share the name -> the DT
    { id: '3', name: 'Nobody Here', pos: 'LS', status: 'Out' }], M);
  const by = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.equal(by['Patrick Mahomes'].pid, 'CCC-P0'); assert.ok(by['Patrick Mahomes'].share > 0.9);
  assert.equal(by['JaMarr Chase'].pid, 'CCC-P5');
  assert.equal(by['jose ramirez'].pid, 'CCC-P6');
  assert.equal(by['Chris Jones'].pid, 'CCC-P10'); assert.equal(by['Chris Jones'].group, 'DL');
  assert.equal(by['Nobody Here'].pid, null); assert.equal(by['Nobody Here'].weight, 0);
  const cb = E.injuryMatrix(st, 'CCC', [{ name: 'Chris Jones', pos: 'CB', status: 'Out' }], M)[0];
  assert.equal(cb.pid, 'CCC-P13', 'position group breaks the tie the other way');
});

// ---------------- loader (nfl/lib/vas-data.js)
const zlib = require('node:zlib'), os = require('node:os');
const Dl = require('../nfl/lib/vas-data');
const gz = s => zlib.gzipSync(Buffer.from(s));

test('loader: streaming CSV with quoted commas and newlines, compact rows, schedule split, upcoming', async () => {
  const games = 'game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,div_game,roof\n' +
    '2025_01_KC_BUF,2025,REG,1,2025-09-07,Sunday,13:00,KC,20,BUF,24,Home,0,outdoors\n' +
    '2025_02_BUF_KC,2025,REG,2,2025-09-14,Sunday,16:25,BUF,,KC,,Neutral,1,dome\n';
  const pbp = 'game_id,posteam,defteam,desc,play_type,epa,success,qb_dropback,special,qb_kneel,qb_spike,passer_id,wp,play_deleted\n' +
    '2025_01_KC_BUF,BUF,KC,"J.Allen pass, short ""right""\nto K.Coleman",pass,0.52,1,1,0,0,0,00-0034857,0.51,0\n' +
    '2025_01_KC_BUF,BUF,KC,kneel,qb_kneel,-0.3,0,0,0,1,0,,0.99,0\n' +
    '2025_01_KC_BUF,KC,BUF,punt,punt,0.1,0,0,1,0,0,,,0\n' +
    '2025_01_KC_BUF,,,"end of quarter",,,,,,,,,,\n';
  const snaps = 'game_id,pfr_game_id,season,game_type,week,player,pfr_player_id,position,team,opponent,offense_snaps,offense_pct,defense_snaps,defense_pct,st_snaps,st_pct\n' +
    '2025_01_KC_BUF,x,2025,REG,1,"Allen, Josh",AlleJo02,QB,BUF,KC,70,1,0,0,0,0\n2025_01_KC_BUF,x,2025,REG,1,Some Backup,BackSo00,CB,KC,BUF,0,0,0,0,10,0.4\n';
  const files = { [Dl.URLS.games()]: gz(games), [Dl.URLS.pbp(2025)]: gz(pbp), [Dl.URLS.snaps(2025)]: gz(snaps) };
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nflvas-'));
  let T = Date.UTC(2025, 8, 20);
  const L = Dl.create({ dir, now: () => T, fetchBuffer: async u => { calls.push(u); if (!files[u]) throw Error('404 ' + u); return files[u]; } });
  const h = await L.history(2025);
  assert.deepEqual(h.games.map(g => g.gid), ['2025_01_KC_BUF'], 'only completed games');
  assert.deepEqual(h.plays, [['2025_01_KC_BUF', 'BUF', 'KC', 'p', 0.52, 1, '00-0034857', 0.51], ['2025_01_KC_BUF', 'KC', 'BUF', 's', 0.1, 0, '', null]]);
  assert.deepEqual(h.snaps[0], ['2025_01_KC_BUF', 'BUF', 'AlleJo02', 'QB', 1, 0, 1, 'Allen, Josh']);
  assert.equal(h.snaps[1][6], 0, 'special-teams-only player did not play offense/defense');
  assert.equal(h.complete, false, '2023/2024 files missing'); assert.deepEqual(h.info.missing.sort(), ['pbp_2023', 'pbp_2024', 'snaps_2023', 'snaps_2024']);
  assert.ok(L.status().lastError);
  const up = await L.upcoming(2025);
  assert.deepEqual(up, [{ gid: '2025_02_BUF_KC', season: 2025, week: 2, day: '2025-09-14', time: '16:25', home: 'KC', away: 'BUF', homeScore: null, awayScore: null, neutral: true, div: 1, roof: 'dome' }]);
  // refresh policy: cached current season not refetched within 12 h, failed URLs not retried within the hour
  const n0 = calls.length; T += 30 * 60e3; await L.history(2025); assert.equal(calls.length, n0, 'nothing refetched after 30 min');
  T += 2 * 3600e3; await L.history(2025);
  assert.ok(calls.length > n0 && calls.slice(n0).every(u => /2023|2024/.test(u)), 'only the failed URLs are retried after an hour');
  T += 12 * 3600e3; const n1 = calls.length; await L.history(2025);
  assert.ok(calls.slice(n1).includes(Dl.URLS.pbp(2025)), 'current season refreshed after 12 h');
  // a restart reads the compact cache without downloading
  const L2 = Dl.create({ dir, now: () => T, fetchBuffer: async () => { throw Error('offline'); } });
  assert.equal((await L2.history(2025)).plays.length, 2);
  assert.equal(Dl.seasonFor(Date.UTC(2026, 1, 8)), 2025); assert.equal(Dl.seasonFor(Date.UTC(2026, 2, 1)), 2026);
});

const RAW = path.join(__dirname, '../nfl/research/data/nflverse/csv/');
test('loader parity: nflverse CSVs -> loader -> engine equals the Python features for 2025 games', { skip: !fs.existsSync(RAW + 'play_by_play_2025.csv.gz') || !fs.existsSync(R + 'parity/features_py.json') }, async () => {
  const local = u => RAW + u.split('/').pop();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nflvas-raw-'));
  const L = Dl.create({ dir, now: () => Date.UTC(2026, 1, 20), fetchBuffer: async u => fs.readFileSync(local(u)) });
  const h = await L.history(2025);
  assert.equal(h.complete, true, JSON.stringify(h.info.missing));
  const st = E.build(h, REAL ? REAL.config : E.DEFAULT_CONFIG);
  const py = JSON.parse(fs.readFileSync(R + 'parity/features_py.json')).filter(r => r.gid.startsWith('2025_'));
  let worst = 0, checked = 0;
  for (const r of py) {
    const f = st.featured.get(r.gid); assert.ok(f, 'missing ' + r.gid);
    for (const [k, a] of Object.entries(r)) {
      if (k === 'gid') continue;
      const b = k in f ? f[k] : k.startsWith('home_') ? f._home[k.slice(5)] : f._away[k.slice(5)];
      if (typeof a === 'string' || a === null || typeof b === 'string' || b === null) { assert.equal(b, a, `${r.gid} ${k}`); continue; }
      worst = Math.max(worst, Math.abs(a - b)); checked++;
    }
  }
  assert.ok(py.length >= 280 && checked > 20000, `games ${py.length} values ${checked}`);
  assert.ok(worst < 1e-8, 'max feature difference ' + worst);
  const s = L.status().sources;
  console.log('# loader cache', Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { rows: v.rows, gzMB: +(v.bytesGz / 1e6).toFixed(2), cacheKB: Math.round(v.cacheBytes / 1024), parseMs: v.parseMs }])));
});

test('service: a completed game keeps its Model column read, from the pre-day features (no result leakage)', { skip: !fs.existsSync(path.join(__dirname, '../nfl/lib/nfl-vas-model.json')) }, async () => {
  const Svc = require('../nfl/lib/vas-service');
  const MODEL = require('../nfl/lib/nfl-vas-model.json');
  const games = 'game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,div_game,roof\n' +
    '2025_01_KC_BUF,2025,REG,1,2025-09-07,Sunday,13:00,KC,20,BUF,24,Home,0,outdoors\n' +
    '2025_02_BUF_KC,2025,REG,2,2025-09-14,Sunday,16:25,BUF,,KC,,Home,1,dome\n';
  const pbp = 'game_id,posteam,defteam,desc,play_type,epa,success,qb_dropback,special,qb_kneel,qb_spike,passer_id,wp,play_deleted\n' +
    '2025_01_KC_BUF,BUF,KC,pass,pass,0.52,1,1,0,0,0,00-0034857,0.51,0\n';
  const snaps = 'game_id,pfr_game_id,season,game_type,week,player,pfr_player_id,position,team,opponent,offense_snaps,offense_pct,defense_snaps,defense_pct,st_snaps,st_pct\n' +
    '2025_01_KC_BUF,x,2025,REG,1,"Allen, Josh",AlleJo02,QB,BUF,KC,70,1,0,0,0,0\n';
  const files = { [Dl.URLS.games()]: gz(games), [Dl.URLS.pbp(2025)]: gz(pbp), [Dl.URLS.snaps(2025)]: gz(snaps) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nflvas-svc-'));
  const svc = Svc.create({ dir, now: () => Date.UTC(2025, 8, 12), fetchBuffer: async u => { if (!files[u]) throw Error('404'); return files[u]; } });
  await svc.refresh();
  const past = { id: '401', state: 'post', start: '2025-09-07T17:00:00Z', seasonType: 2, home: { abbr: 'BUF', score: 24 }, away: { abbr: 'KC', score: 20 } };
  const read = svc.forGame(past, null, null);
  assert.equal(read.status, 'OK');
  // Recompute independently: the history walk's features for that game use only state before its day.
  const Dl2 = Dl.create({ dir, now: () => Date.UTC(2025, 8, 12), fetchBuffer: async u => files[u] });
  const st = E.build(await Dl2.history(2025), MODEL.config);
  const expected = E.predict(st.featured.get('2025_01_KC_BUF'), MODEL);
  assert.equal(read.fairMargin, expected.margin); assert.equal(read.fairTotal, expected.total);
  // The upcoming game still reads from today's team state.
  const next = svc.forGame({ id: '402', state: 'pre', start: '2025-09-14T20:25:00Z', seasonType: 2, home: { abbr: 'KC' }, away: { abbr: 'BUF' } }, null, null);
  assert.equal(next.status, 'OK');
});
