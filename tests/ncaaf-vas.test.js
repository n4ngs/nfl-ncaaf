'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const E = require('../ncaaf/lib/vas-engine');

const R = path.join(__dirname, '../ncaaf/research/data/cache/');
const CFG = { hl: 9.0, k_shrink: 1.0, carry: 0.7, rest_cap: 28, lr_m: 0.4, hfa_m: 2.0, carry_m: 0.95, k_qb: 2.0, fcs_m: -20.0 };

// A tiny hand-made model so the synthetic tests do not depend on the (git-ignored) exported file.
const lin = (features, coef) => ({ features, coef, mean: features.map(() => 0), std: features.map(() => 1), intercept: 0 });
const MODEL = {
  config: CFG,
  stage1: lin(['d_o_pts', 'd_d_pts', 'home'], [0.5, -0.5, 2.5]),
  stage2: { A: lin(['x_gap', 'early'], [0.1, 0.2]), B: lin(['x_gap', 'x_open_vs_cons'], [0.1, 0.5]), C: lin(['x_gap', 'L_d_qb_pepa'], [0.1, 3]) },
  totals: { stage1: lin(['t_pts'], [1]), stage2: { A: lin(['tx_gap'], [0.1]), B: lin(['tx_gap', 'tx_open_vs_cons'], [0.1, 0.5]) } },
  tiers: { spread: { A: { proven: false, diamond: null, lean: 1 }, B: { proven: true, diamond: 1.5, lean: 1 }, C: { proven: false, diamond: null, lean: 1 } },
    totals: { A: { proven: false, diamond: null, lean: 1 }, B: { proven: false, diamond: null, lean: 1 } } },
  preseason: { season: 2024, talent_z: { 1: 1.5, 2: -0.5 }, non_fbs_talent_z: -2, ret_off: { 1: 0.8 }, ret_def: {}, ret_missing: 0.5 },
};

// Team 1 is strong, 2 average, 3 weak (FCS). Weekly Saturday games for two seasons.
function history() {
  const games = []; let gid = 1000;
  const sat = (s, w) => new Date(Date.UTC(s, 7, 31) + w * 7 * 86400000).toISOString().slice(0, 10);
  const stat = (q) => ({ epa: 0.05 * q, repa: 0.04 * q, pepa: 0.08 * q, fdr: 0.25 + 0.02 * q, expl: 0.08 + 0.01 * q, ypp: 5.5 + 0.5 * q, st: q, plays: 70 });
  for (const season of [2023, 2024]) {
    for (let w = 0; w < 10; w++) {
      const pairs = w % 2 ? [[1, 3], [2, 4]] : [[2, 1], [4, 3]];
      for (const [h, a] of pairs) {
        const q = { 1: 2, 2: 0, 3: -2, 4: 0 };
        const g = { gid: gid++, season, start: sat(season, w) + 'T19:30Z', neutral: 0, conf_game: 1, home_id: h, away_id: a,
          home_pts: 28 + 7 * q[h], away_pts: 24 + 7 * q[a], home_fbs: h === 3 ? 0 : 1, away_fbs: a === 3 ? 0 : 1,
          home_qb: 100 + h + (season === 2024 && h === 2 && w > 5 ? 50 : 0), away_qb: 100 + a, close: -(3 + 7 * (q[h] - q[a])) };
        for (const [k, v] of Object.entries(stat(q[h]))) g['home_' + k] = v;
        for (const [k, v] of Object.entries(stat(q[a]))) g['away_' + k] = k === 'pepa' && w === 3 ? null : v;
        games.push(g);
      }
    }
  }
  return { games };
}

test('engine is deterministic and ranks the strong team above the weak one', () => {
  const h = history();
  const g = { season: 2024, day: '2024-12-01', neutral: 0, conf_game: 0, home_id: 1, away_id: 3, home_fbs: 1, away_fbs: 0 };
  const a = E.build(h, CFG).featuresFor(g), b = E.build(h, CFG).featuresFor(g);
  assert.deepEqual(a, b);
  assert.ok(a.d_o_pts > 0 && a.d_d_pts < 0, 'team 1 scores more and allows less than team 3');
  assert.ok(a.d_mkt > 0, 'market rating learned from past closes');
  assert.equal(a._home.rest, 28); assert.equal(a.home_fbs, 1); assert.equal(a.away_fbs, 0);
  assert.ok(E.predict(E.withContext(a, g, { week: 12, seasonType: 2 }, MODEL), MODEL) > 0);
});

test('history order does not matter, missing stats are skipped, not zero-filled', () => {
  const h = history(), rev = { games: h.games.slice().reverse() };
  const g = { season: 2024, day: '2024-12-01', neutral: 1, conf_game: 0, home_id: 2, away_id: 4, home_fbs: 1, away_fbs: 1 };
  assert.deepEqual(E.build(h, CFG).featuresFor(g), E.build(rev, CFG).featuresFor(g));
  const st = E.build(h, CFG);
  for (const v of Object.values(st.featured.get(1100) || st.featured.values().next().value)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
});

test('projected QB is the last starter; the late variant flags a confirmed change', () => {
  const st = E.build(history(), CFG);
  const g = { season: 2024, day: '2024-12-01', neutral: 0, conf_game: 1, home_id: 2, away_id: 1, home_fbs: 1, away_fbs: 1 };
  const f = st.featuresFor(g);
  assert.equal(f._home.qb, 152, 'team 2 switched QBs mid 2024; the projection follows the last starter');
  const late = st.featuresFor(g, { late: { homeQb: 102, awayQb: 101 } });
  assert.equal(late.L_home_qb_change, 1); assert.equal(late.L_away_qb_change, 0);
});

test('context: preseason tables, early flag, tiers', () => {
  const g = { neutral: 0, home_id: 1, away_id: 3, home_fbs: 1, away_fbs: 0 };
  const x = E.withContext({}, g, { week: 2, seasonType: 2, homeP5: true, awayP5: false }, MODEL);
  assert.equal(x.home, 1); assert.equal(x.early, 1); assert.equal(x.d_talent, 1.5 - -2); assert.equal(x.talent_early, 3.5);
  assert.equal(x.d_ret_off, 0.8 - 0.5); assert.equal(x.tier_fcs, 1); assert.equal(x.tier_g5, 0);
  const y = E.withContext({}, { ...g, away_id: 2, away_fbs: 1 }, { week: 9, seasonType: 2, homeP5: false, awayP5: false }, MODEL);
  assert.equal(y.early, 0); assert.equal(y.tier_g5, 1); assert.equal(y.tier_fcs, 0);
});

test('signal: CLV direction, unproven tiers never say DIAMOND, variant inputs are required', () => {
  const f = { early: 0 };
  assert.equal(E.signal(f, 10, null, MODEL), null);
  const s = E.signal(f, 20, { open: -3 }, MODEL);            // model says home by 20, book opens home -3 -> gap +17
  assert.equal(s.side, 'home'); assert.ok(Math.abs(s.clv - 1.7) < 1e-12); assert.equal(s.tier, 'LEAN'); assert.equal(s.proven, false);
  assert.equal(E.signal(f, -20, { open: 3 }, MODEL).side, 'away');
  assert.equal(E.signal(f, 20, { open: -3 }, MODEL, 'B'), null, 'B needs the cross-book median open');
  const b = E.signal(f, 20, { open: -3, openCons: -4 }, MODEL, 'B');
  assert.ok(Math.abs(b.clv - 2.2) < 1e-12); assert.equal(b.tier, 'DIAMOND');
  const t = E.totalSignal({}, 60, { total: 50 }, MODEL);
  assert.equal(t.side, 'over'); assert.equal(t.tier, 'LEAN');
});

test('exported model file is well formed (runs when the research export exists)', { skip: !fs.existsSync(R + 'ncaaf-vas-model.json') }, () => {
  const m = JSON.parse(fs.readFileSync(R + 'ncaaf-vas-model.json'));
  for (const st of [m.stage1, m.stage2.A, m.stage2.B, m.stage2.C, m.totals.stage1, m.totals.stage2.A]) {
    assert.equal(st.features.length, st.coef.length); assert.equal(st.features.length, st.mean.length); assert.ok(st.std.every((v) => v > 0));
  }
  assert.deepEqual(Object.keys(m.config).sort(), Object.keys(CFG).sort());
  const h = history(); const g = { season: 2024, day: '2024-12-01', neutral: 0, conf_game: 0, home_id: 1, away_id: 2, home_fbs: 1, away_fbs: 1 };
  const f = E.withContext(E.build(h, m.config).featuresFor(g), g, { week: 12, seasonType: 2 }, m);
  const s = E.signal(f, E.predict(f, m), { open: -7 }, m);
  assert.ok(Number.isFinite(s.clv)); assert.ok(['DIAMOND', 'LEAN', 'PASS'].includes(s.tier));
  if (!m.tiers.spread.A.proven) assert.notEqual(s.tier, 'DIAMOND');
});

test('parity with the Python research features (runs when the local fixture exists)', { skip: !fs.existsSync(R + 'parity/history.json') }, () => {
  const hist = JSON.parse(fs.readFileSync(R + 'parity/history.json')), py = JSON.parse(fs.readFileSync(R + 'parity/features_py.json'));
  const st = E.build(hist, CFG);
  let worst = 0, n = 0;
  for (const r of py) {
    const f = st.featured.get(r.gid); assert.ok(f, 'game ' + r.gid + ' featured');
    for (const [k, a] of Object.entries(r)) {
      if (k === 'gid') continue;
      const sub = k.startsWith('home_') ? f._home[k.slice(5)] : k.startsWith('away_') ? f._away[k.slice(5)] : undefined;
      const b = sub !== undefined ? sub : f[k];
      worst = Math.max(worst, a == null && b == null ? 0 : Math.abs(a - b)); n++;
    }
  }
  assert.ok(n > 100000, 'compared ' + n + ' values');
  assert.ok(worst < 1e-8, 'max feature difference ' + worst);
});

// ------------------------------------------------------------------ data loader (ncaaf/lib/vas-data.js)
const D = require('../ncaaf/lib/vas-data');
const os = require('node:os');
const csv = (rows) => Buffer.from(rows.map((r) => r.join(',')).join('\n') + '\n');
function rawSeason(season, o = 0) {   // o offsets game ids so seasons do not collide
  return {
    schedule: csv([['game_id', 'season', 'week', 'season_type', 'game_date', 'neutral_site', 'conference_competition', 'home_id', 'away_id', 'home_team', 'away_team', 'home_score', 'away_score', 'status'],
      [11 + o, season, 1, 2, `${season}-09-06T19:30Z`, 'false', 'true', 1, 2, '"Team, One"', 'Two', 31, 24, 'STATUS_FINAL'],
      [12 + o, season, 2, 2, `${season}-09-13T19:30Z`, 'true', 'false', 2, 3, 'Two', 'FCS U', 14, 17, 'STATUS_FINAL'],
      [13 + o, season, 2, 2, `${season}-09-13T23:00Z`, 'false', 'false', 3, 4, 'FCS U', 'FCS V', 10, 7, 'STATUS_FINAL'],
      [14 + o, season, 3, 2, `${season}-09-20T19:30Z`, 'false', 'false', 1, 3, 'x', 'y', '', '', 'STATUS_CANCELED']]),
    gamelog: csv([['game_id', 'team_id', 'EPA_per_play', 'EPA_rushing_per_play', 'EPA_passing_per_play', 'first_downs_created_rate', 'EPA_explosive_rate', 'yards_per_play', 'EPA_special_teams', 'scrimmage_plays'],
      [11 + o, 1, 0.2, 0.1, 0.3, 0.3, 0.09, 6.1, 1.5, 70], [11 + o, 1, 9, 9, 9, 9, 9, 9, 9, 9], [11 + o, 2, -0.1, 'NA', 0.0, 0.2, 0.05, 4.9, -1, 64],
      [12 + o, 2, 0.05, 0.02, 0.07, 0.25, 0.07, 5.5, 0, 66]]),
    teams: csv([['team_id', 'pos_team', 'division', 'conference'], [1, 'One', 'fbs', 'SEC'], [2, 'Two', 'fbs', 'Mountain West'], [3, 'FCS U', 'fcs', 'Big Sky']]),
    playerBox: csv([['stat_1', 'category', 'athlete_id', 'team_id', 'game_id', 'completions/passingAttempts'],
      ['', 'passing', 501, 1, 11, '20/30'], ['', 'passing', 502, 1, 11, '2/3'], ['9/40', 'rushing', 503, 1, 11, ''],
      ['5/10', 'passing', 601, 2, 11, ''], ['', 'passing', 602, 2, 11, '4/10'], ['', 'passing', 603, 2, 12, '']]),
  };
}

test('loader: CSV parsing mirrors build_games.py (FBS filter, duplicates, NA, QB rule, booleans)', () => {
  assert.deepEqual(D.splitCsv('a,"b, ""c""",d'), ['a', 'b, "c"', 'd']);
  const s = D.compactSeason(2025, rawSeason(2025));
  assert.deepEqual(s.games.map((g) => g.gid), [11, 12], 'FCS-vs-FCS and non-final games dropped');
  const [g, h] = s.games;
  assert.equal(g.neutral, 0); assert.equal(g.conf_game, 1); assert.equal(h.neutral, 1); assert.equal(h.away_fbs, 0);
  assert.equal(g.home_epa, 0.2, 'first duplicate row kept'); assert.equal(g.away_repa, null, 'NA -> null');
  assert.equal(h.away_epa, null, 'no gamelog row -> null stats');
  assert.equal(g.home_qb, 501); assert.equal(g.away_qb, 602, 'tie on attempts -> larger athlete id, stat_1 fallback');
  assert.equal(h.home_qb, 603, 'zero-attempt passer still counts'); assert.equal(h.away_qb, 0);
  assert.deepEqual(s.teams[1], [1, 'SEC']);
});

test('loader: closing spread filter (live odds, non-books, juice-in-spread) and cross-book openers', () => {
  const j = { items: [{ provider: { name: 'ESPN BET' }, spread: -7, homeTeamOdds: { close: { pointSpread: { american: '+110' } } } },
    { provider: { name: 'DraftKings' }, spread: -6 }, { provider: { name: 'ESPN Bet - Live Odds' }, spread: 20 },
    { provider: { name: 'teamrankings' }, spread: -30 }, { provider: { name: 'MGM' }, spread: null }] };
  assert.equal(D.closeFromOdds(j), -6.5);
  assert.equal(D.closeFromOdds({ items: [] }), null);
  const cb = D.crossBook({ circa: { spread: -3, homePrice: -110, awayPrice: -110, firstSeenAt: '2026-09-20T12:00:00Z' },
    wynn: { spread: -4, firstSeenAt: '2026-09-20T13:00:00Z' }, stn: { spread: -4.5, firstSeenAt: '2026-09-20T15:00:00Z' } }, { asOf: '2026-09-20T14:00:00Z' });
  assert.equal(cb.n, 2, 'openers seen after asOf are ignored'); assert.equal(cb.openCons, -3.5);
  assert.equal(cb.books.circa.x_open_vs_cons, 0.5); assert.equal(cb.books.circa.homePrice, -110);
});

test('loader: caching, 12 h refresh, hourly retry, gradual close backfill, upcoming', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaaf-vas-'));
  let T = Date.parse('2026-09-20T12:00:00Z'), fail = false; const calls = [];
  const v = D.create({ dir, now: () => T, seed: '/nonexistent-seed.json',
    fetchBuffer: async (u) => { calls.push(u); if (fail) throw Error('down'); const s = Number(u.match(/_(\d{4})\.csv$/)[1]); const r = rawSeason(s, (s - 2000) * 100);
      return u.includes('schedules') ? r.schedule : u.includes('gamelog') ? r.gamelog : u.includes('summaries') ? r.teams : r.playerBox; },
    fetchJSON: async (u) => {
      if (u.includes('scoreboard')) return { events: [{ id: '99', date: '2026-09-27T19:30Z', week: { number: 5 }, season: { type: 2 }, competitions: [{ neutralSite: false, conferenceCompetition: true,
        status: { type: { state: 'pre' } }, competitors: [{ homeAway: 'home', team: { id: '1' } }, { homeAway: 'away', team: { id: '2' } }] }] },
      { id: '98', date: '2026-09-20T19:30Z', competitions: [{ status: { type: { state: 'post' } }, competitors: [] }] }] };
      return { items: [{ provider: { name: 'ESPN BET' }, spread: -3 }] }; } });
  const h1 = await v.history(2026, { maxCloses: 3 });
  assert.equal(h1.games.length, 6); assert.equal(h1.complete, false, 'closes still backfilling'); assert.equal(h1.info.closesMissing, 3);
  assert.equal(calls.length, 12);
  const h2 = await v.history(2026, { maxCloses: 3 });
  assert.equal(h2.complete, true); assert.equal(calls.length, 12, 'no refetch within 12 h'); assert.equal(new Set(h2.games.map((g) => g.gid)).size, 6); assert.equal(h2.games[0].close, -3);
  T += 13 * 3600e3; fail = true;
  const h3 = await v.history(2026);
  assert.equal(calls.length, 16, 'current season refetched after 12 h, past seasons never'); assert.equal(h3.games.length, 6, 'old cache kept on failure');
  assert.match(v.status().lastError, /season 2026/);
  await v.history(2026); assert.equal(calls.length, 16, 'failed URL not retried within the hour');
  const up = await v.upcoming(2026, { week: 5 });
  assert.equal(up.length, 1);
  assert.deepEqual({ ...up[0] }, { gid: 99, season: 2026, start: '2026-09-27T19:30Z', day: '2026-09-27', neutral: 0, conf_game: 1, home_id: 1, away_id: 2,
    home_fbs: 1, away_fbs: 1, week: 5, seasonType: 2, homeP5: true, awayP5: false });
  const st = E.build(h3, CFG); assert.ok(Number.isFinite(st.featuresFor(up[0]).d_o_pts));
});

const RAW = path.join(__dirname, '../ncaaf/research/data/');
test('loader parity: real 2023-25 raw files -> engine -> 2025 features equal Python (runs when local raw files exist)',
  { skip: !(fs.existsSync(RAW + 'sdv_csv/player_box_2025.csv') && fs.existsSync(RAW + 'espn/odds.jsonl') && fs.existsSync(R + 'parity/features_py_espnclose.json')) }, async () => {
    const odds = new Map();
    for (const l of fs.readFileSync(RAW + 'espn/odds.jsonl', 'utf8').split('\n')) if (l) { const e = JSON.parse(l); odds.set(e.id, e.books); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaaf-vas-par-'));
    const v = D.create({ dir, now: () => Date.parse('2026-01-20T00:00:00Z'), seed: '/nonexistent-seed.json',
      fetchBuffer: async (u) => fs.readFileSync(RAW + 'sdv_csv/' + u.split('/').pop()),
      fetchJSON: async (u) => { const gid = Number(u.split('/events/')[1].split('/')[0]); return { items: (odds.get(gid) || []).map((b) => ({ provider: { name: b.book }, spread: b.spread })) }; } });
    const t0 = process.hrtime.bigint();
    const h = await v.history(2025, { maxCloses: 10000 });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(h.complete, true);
    const st = E.build(h, CFG);
    const py = JSON.parse(fs.readFileSync(R + 'parity/features_py_espnclose.json'));
    const season = new Map(JSON.parse(fs.readFileSync(R + 'parity/history_espnclose.json')).games.map((g) => [g.gid, g.season]));
    let worst = 0, n = 0, games = 0;
    for (const r of py) {
      if (season.get(r.gid) !== 2025) continue;
      const f = st.featured.get(r.gid); assert.ok(f, 'loader has game ' + r.gid); games++;
      for (const [k, a] of Object.entries(r)) {
        if (k === 'gid') continue;
        const sub = k.startsWith('home_') ? f._home[k.slice(5)] : k.startsWith('away_') ? f._away[k.slice(5)] : undefined;
        const b = sub !== undefined ? sub : f[k];
        worst = Math.max(worst, a == null && b == null ? 0 : Math.abs(a - b)); n++;
      }
    }
    assert.equal(games, 934); assert.equal(h.games.length, 2763);
    assert.ok(worst < 1e-8, 'max feature difference ' + worst);
    console.log(`# loader parity: ${games} games, ${n} values, max |diff| ${worst}, load+parse ${ms.toFixed(0)} ms`);
  });

test('loader: shipped close seed fills a fresh cache without overriding cached values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaaf-vas-seed-'));
  const seed = path.join(dir, 'seed.json'); fs.writeFileSync(seed, JSON.stringify({ closes: { 11: -3, 12: null, 13: 7 } }));
  fs.writeFileSync(path.join(dir, 'closes.json'), JSON.stringify({ 13: 2 }));
  const v = D.create({ dir, seed, fetchBuffer: async () => { throw Error('offline'); }, fetchJSON: async () => { throw Error('offline'); } });
  return v.closeSpreads([11, 12, 13], { max: 0 }).then((c) => { assert.deepEqual(c, { 11: -3, 12: null, 13: 2 }); });
});
const SEED = path.join(__dirname, '../ncaaf/lib/ncaaf-vas-closes-seed.json');
test('shipped close seed is well formed', { skip: !fs.existsSync(SEED) }, () => {
  const c = JSON.parse(fs.readFileSync(SEED)).closes; const v = Object.values(c);
  assert.ok(v.length > 2000); assert.ok(v.every((x) => x === null || (Number.isFinite(x) && Math.abs(x) < 80)));
});

test('explainMove: parts add up to the variant-E prediction, actual move and what-if per lead player', () => {
  const st = { features: ['x_gap', 'd_last_ats', 'L_d_rb_out', 'early'], coef: [0.3, 0.2, -0.4, 0.1], mean: [0, 0, 0, 0.2], std: [5, 10, 0.1, 0.4], intercept: 0.05 };
  const m = { stage2: { E: st } };
  const e = E.explainMove({ d_last_ats: 14, early: 0 }, 4, { open: -3, now: -5 }, m, { away: { rb: 0.5 } });
  const lin = E.linear(st, { x_gap: 1, d_last_ats: 14, L_d_rb_out: -0.5, early: 0 });
  assert.ok(Math.abs(e.predicted - lin) < 1e-12, 'sum of parts = linear model');
  assert.equal(e.actual, 2, 'open -3 -> now -5 = 2 pts toward home');
  assert.ok(Math.abs(e.unexplained - (2 - lin)) < 1e-12);
  assert.ok(Math.abs(e.parts.find((p) => p.key === 'key').pts - (-0.4 * -0.5 / 0.1)) < 1e-12, 'away lead back out moves it toward home');
  assert.ok(Math.abs(e.perShare.rb - (-4)) < 1e-12);
  assert.equal(E.explainMove({}, 0, { open: -3 }, {}), null, 'no variant E in the model');
});

test('loader: lead back / receiver from the last 3 games (passers excluded upstream), share thresholds', () => {
  const g = (n, rush, rec) => ({ season: 2026, start: `2026-09-0${n}T19:00Z`, home_id: 1, away_id: 2, home_rush: rush, home_rec: rec, away_rush: [], away_rec: [] });
  const games = [g(1, [[10, 20, 'Lacy'], [11, 5, 'B']], [[20, 3, 'W1'], [21, 3, 'W2'], [22, 3, 'W3'], [23, 3, 'W4'], [24, 3, 'W5']]),
    g(2, [[10, 18, 'Lacy'], [11, 6, 'B']], [[20, 2, 'W1']]), g(3, [[11, 12, 'B']], [])];
  const L = D.leads(games, 1, 2026);
  assert.equal(L.rb.name, 'Lacy'); assert.ok(Math.abs(L.rb.share - 38 / 61) < 1e-12);
  assert.equal(L.wr.name, 'W1'); assert.ok(Math.abs(L.wr.share - 5 / 17) < 1e-12);
  assert.equal(D.leads([g(1, [], [[20, 3, 'W1'], [21, 3, 'W2'], [22, 3, 'W3'], [23, 3, 'W4'], [24, 3, 'W5']]), g(2, [], [[25, 3, 'W6']])], 1, 2026).wr, null, 'no receiver reaches 22 % of catches');
  assert.equal(D.leads(games.slice(0, 1), 1, 2026).rb, null, 'needs two games');
});
