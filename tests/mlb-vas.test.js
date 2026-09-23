'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const E = require('../mlb/lib/vas-engine');

const MODEL_PATH = [path.join(__dirname, '../mlb/lib/mlb-vas-model.json'), path.join(__dirname, '../mlb/research/data/cache/mlb-vas-model.json')].find(f => fs.existsSync(f)) || '/nonexistent';
const PARITY = path.join(__dirname, '../mlb/research/data/cache/parity/');

// A tiny linear model with the real feature names, used when the exported model is not on disk.
function syntheticModel() {
  const st = (features, coef, intercept) => ({ features, mean: features.map(() => 0), std: features.map(() => 1), coef, intercept });
  return {
    config: E.DEFAULT_CFG,
    ml: { stage1: st(['d_sp_fip', 'd_off'], [-0.3, 0.2], 0.1), stage2: st(['x_gap', 'x_open'], [0.25, -0.02], 0), rule: 'gap', proven: false, tiers: { diamond: 0.3, gold: 0.2 } },
    tot: { stage1: st(['s_off', 'park'], [10, 4], 4.8), stage2: st(['t_gap', 'mu_open'], [0.2, 0], 0), nb_size: 8, rule: 'move', proven: false, tiers: { diamond: 0.3, gold: 0.2 } },
  };
}
const MODEL = fs.existsSync(MODEL_PATH) ? JSON.parse(fs.readFileSync(MODEL_PATH)) : syntheticModel();

// roughly MLB-like lines: about one hit and a third of a walk per four trips
function bat(id, bo, k) { const h = k % 4 === 0 ? 2 : 1, bb = k % 3 === 0 ? 1 : 0; return { id, bo, pa: 4, ab: 4 - bb, h, d: k % 5 === 0 ? 1 : 0, t: 0, hr: k % 11 === 0 ? 1 : 0, bb, ibb: 0, hbp: 0, so: 1, sf: 0 }; }
function pit(id, bf, np) { return { id, outs: Math.round(bf * 0.7), bf, k: Math.round(bf / 4), bb: 2, ibb: 0, hbp: 0, hr: bf > 20 ? 1 : 0, np }; }
function history() {
  const games = []; let pk = 700000;
  const day = n => new Date(Date.UTC(2026, 3, 1) + n * 86400000).toISOString().slice(0, 10);
  for (let n = 0; n < 60; n++) {
    const home = n % 2 ? 1 : 2, away = n % 2 ? 2 : 1;
    const box = side => {
      const t = side === 'home' ? home : away, base = t * 1000;
      const nine = Array.from({ length: 9 }, (_, i) => bat(base + i, (i + 1) + '00', (n + i + t) % 4));
      if (n % 7 === 0) nine.push(bat(base + 20, '401', 1));                       // a substitute in slot 4
      return { bat: nine, pit: [pit(base + 50 + (n % 5), 24, 95), pit(base + 60 + (n % 3), 6, 25), pit(base + 70, 4, 18)] };
    };
    const b = { home: box('home'), away: box('away') };
    games.push({ pk: pk++, season: 2026, day: day(n), start: day(n) + 'T23:05:00Z', venue: home === 1 ? 15 : 3289, dn: n % 3 ? 'night' : 'day', home, away,
      hs: 3 + (n % 4), as: 2 + (n % 5), prob: { home: b.home.pit[0].id, away: b.away.pit[0].id }, hp: 400 + (n % 6), wx: { temp: 70, out: n % 2 ? 8 : -5, roof: 0 }, box: b });
  }
  return { games, hands: { 1050: 'L', 2051: 'L' } };
}

test('woba / fip / starting nine helpers', () => {
  const [n, d] = E.woba({ ab: 4, h: 2, d: 1, t: 0, hr: 1, bb: 1, ibb: 0, hbp: 0, sf: 0 });
  assert.equal(d, 5); assert.ok(Math.abs(n - (0.69 + 1.25 + 2.05)) < 1e-12);
  assert.equal(E.fipn({ hr: 1, bb: 2, ibb: 1, hbp: 1, k: 5 }), 13 + 6 - 10);
  assert.deepEqual(E.starters9([{ id: 3, bo: '300' }, { id: 1, bo: '100' }, { id: 9, bo: '101' }, { id: 2, bo: '200' }, { id: 7, bo: null }]), [1, 2, 3]);
});

test('compactBox and parseWeather read the statsapi shapes', () => {
  const box = { teams: {
    home: { batters: [11, 12], pitchers: [21, 22], players: {
      ID11: { battingOrder: '100', stats: { batting: { plateAppearances: 4, atBats: 3, hits: 1, doubles: 0, triples: 0, homeRuns: 1, baseOnBalls: 1, intentionalWalks: 0, hitByPitch: 0, strikeOuts: 1, sacFlies: 0 } } },
      ID12: { stats: { batting: {} } },
      ID21: { stats: { pitching: { inningsPitched: '6.1', battersFaced: 25, strikeOuts: 7, baseOnBalls: 2, intentionalWalks: 0, hitBatsmen: 1, homeRuns: 1, numberOfPitches: 98 } } },
      ID22: { stats: { pitching: { outs: 8, battersFaced: 10, strikeOuts: 3, baseOnBalls: 0, homeRuns: 0, numberOfPitches: 31 } } } } },
    away: { batters: [], pitchers: [31], players: { ID31: { stats: { pitching: { outs: 27, battersFaced: 30 } } } } } } };
  const c = E.compactBox(box);
  assert.equal(c.home.bat.length, 1, 'players with no batting line are skipped');
  assert.equal(c.home.bat[0].bo, '100'); assert.equal(c.home.pit[0].outs, 19); assert.equal(c.home.pit[0].np, 98); assert.equal(c.home.pit[1].outs, 8);
  assert.equal(c.away.pit[0].ibb, 0);
  assert.deepEqual(E.parseWeather('78 degrees, Partly Cloudy.', '12 mph, Out To CF.'), { temp: 78, out: 12, roof: 0 });
  assert.deepEqual(E.parseWeather('72 degrees, Roof Closed.', '0 mph, None.'), { temp: 72, out: 0, roof: 1 });
  assert.equal(E.parseWeather('55 degrees, Cloudy.', '9 mph, In From LF.').out, -9);
  assert.equal(E.parseWeather('', '').temp, null);
});

test('negative binomial totals: probabilities sum to one, implied mean inverts, CLV sign', () => {
  const o = E.nbOver(8.7, 8, 8.5); assert.ok(Math.abs(o.over + o.under - 1) < 1e-6); assert.equal(o.push, 0);
  const i = E.nbOver(8.7, 8, 9); assert.ok(i.push > 0.05 && Math.abs(i.over + i.push + i.under - 1) < 1e-6);
  const mu = E.impliedMu(8.5, 0.55, 8); const back = E.nbOver(mu, 8, 8.5); assert.ok(Math.abs(back.over / (back.over + back.under) - 0.55) < 1e-6);
  assert.ok(E.impliedMu(9.5, 0.5, 8) > E.impliedMu(8.5, 0.5, 8));
  // over 8.5 -110 at the open, close moved to 9.5 even: positive CLV; the under at the same open: negative
  assert.ok(E.clvTotal('over', 8.5, -110, { line: 9.5, over: -110, under: -110 }, 8) > 0.05);
  assert.ok(E.clvTotal('under', 8.5, -110, { line: 9.5, over: -110, under: -110 }, 8) < -0.1);
  assert.ok(Math.abs(E.clvMoneyline('home', 150, 0.4) - 0) < 1e-12);           // +150 is exactly fair at 40%
  assert.ok(Math.abs(E.novig(-110, -110) - 0.5) < 1e-12); assert.equal(E.novig(-110, 50), null);
});

test('engine is deterministic, walks forward, and handles late information', () => {
  const h = history();
  const up = { season: 2026, day: '2026-06-05', venue: 15, dn: 'day', home: 1, away: 2, prob: { home: 1050, away: 2051 }, hp: 401, wx: { temp: 85, out: 10, roof: 0 } };
  const a = E.build(h, MODEL.config).featuresFor(up), b = E.build(h, MODEL.config).featuresFor(up);
  assert.deepEqual(a, b);
  assert.equal(a.lu_conf, undefined); assert.equal(a.home_lu_conf, null, 'no confirmed lineup -> late features are null');
  assert.equal(a.home_sp_L, 1); assert.equal(a.away_sp_L, 1);
  assert.ok(a.home_sp_lbf > 0, 'probable starter has history'); assert.equal(a.home_rest, 3);
  assert.ok(a.park > 0.5 && a.park < 1.5); assert.equal(a.night, 0);
  const late = E.build(h, MODEL.config).featuresFor({ ...up, lineups: { home: Array.from({ length: 9 }, (_, i) => 1000 + i), away: Array.from({ length: 9 }, (_, i) => 2000 + i) }, starters: { home: 1099, away: 2051 } });
  assert.ok(Number.isFinite(late.d_lu_delta)); assert.equal(late.home_sp_chg, 1); assert.equal(late.away_sp_chg, 0);
  // unseen teams / pitchers fall back to league priors
  const cold = E.build(h, MODEL.config).featuresFor({ ...up, home: 77, away: 78, prob: { home: 9999, away: null } });
  assert.equal(cold.home_sp_lbf, 0); assert.equal(cold.home_rest, 3); assert.equal(cold.d_off, 0);
  // the walk's pre-day features never see the day's own results: day-0 games equal league priors
  const st = E.build(h, MODEL.config); const f0 = st.featured.get(h.games[0].pk);
  assert.equal(f0._home.off, f0._away.off); assert.equal(f0._home.sp_lbf, 0);
});

test('predict, totals and signals with the exported (or synthetic) model', () => {
  const st = E.build(history(), MODEL.config);
  const f = st.featuresFor({ season: 2026, day: '2026-06-05', venue: 15, dn: 'night', home: 1, away: 2, prob: { home: 1050, away: 2051 } });
  const p = E.predict(f, MODEL); assert.ok(p > 0.05 && p < 0.95);
  const mu = E.predictTotal(f, MODEL); assert.ok(mu > 3 && mu < 16);
  const s = E.signal(f, p, { prob: p }, MODEL);
  assert.ok(['DIAMOND', 'GOLD', 'PASS'].includes(s.tier)); assert.ok(Math.abs(s.gap) < 1e-9);
  const far = E.signal(f, 0.25, { prob: 0.7 }, MODEL);          // model far below the open on the home side
  assert.equal(far.side, 'away'); assert.notEqual(far.tier, 'PASS'); assert.equal(far.proven, !!MODEL.ml.proven);
  assert.equal(E.signal(f, p, null, MODEL), null);
  const t = E.totalSignal(f, mu, { line: 8.5, over: -110, under: -110 }, MODEL);
  assert.ok(t && ['over', 'under'].includes(t.side) && Number.isFinite(t.muOpen));
  const tf = E.totalSignal(f, t.muOpen + 3, { line: 8.5, over: -110, under: -110 }, MODEL);
  assert.equal(tf.side, 'over');
  assert.equal(E.totalSignal(f, mu, { line: 8.5, over: -110, under: 50 }, MODEL), null);
});

test('exported model file is well formed (when present)', { skip: !fs.existsSync(MODEL_PATH) }, () => {
  for (const m of ['ml', 'tot']) {
    for (const s of ['stage1', 'stage2']) {
      const st = MODEL[m][s];
      assert.equal(st.features.length, st.coef.length); assert.equal(st.features.length, st.mean.length); assert.equal(st.features.length, st.std.length);
      assert.ok(st.std.every(x => x > 0)); assert.ok(st.coef.every(Number.isFinite));
    }
    assert.ok(['gap', 'move'].includes(MODEL[m].rule)); assert.equal(typeof MODEL[m].proven, 'boolean');
  }
  assert.ok(MODEL.tot.nb_size > 0);
});

test('parity with the Python research features (runs when the local fixture exists)', { skip: !fs.existsSync(PARITY + 'history.json') }, () => {
  const hist = JSON.parse(fs.readFileSync(PARITY + 'history.json')), py = JSON.parse(fs.readFileSync(PARITY + 'features_py.json'));
  const st = E.build(hist, MODEL.config);
  let worst = 0, n = 0;
  for (const r of py) {
    const f = st.featured.get(r.pk); assert.ok(f, 'game ' + r.pk);
    for (const [k, v] of Object.entries(r)) {
      if (k === 'pk') continue;
      const js = k.startsWith('home_') ? f._home[k.slice(5)] : k.startsWith('away_') ? f._away[k.slice(5)] : f[k];
      const d = v == null && js == null ? 0 : Math.abs(v - js); n++;
      if (!(d <= worst)) worst = d;
    }
  }
  assert.ok(n > 100000, 'compared ' + n); assert.ok(worst < 1e-8, 'max feature difference ' + worst);
});

test('prediction parity: Node predict / predictTotal == Python final model (runs when the local fixture exists)', { skip: !fs.existsSync(PARITY + 'preds_py.json') || !fs.existsSync(MODEL_PATH) }, () => {
  const hist = JSON.parse(fs.readFileSync(PARITY + 'history.json')), py = JSON.parse(fs.readFileSync(PARITY + 'preds_py.json'));
  const st = E.build(hist, MODEL.config);
  let worst = 0;
  for (const r of py) { const f = st.flatten(r.pk); worst = Math.max(worst, Math.abs(E.predict(f, MODEL) - r.p), Math.abs(E.predictTotal(f, MODEL) - r.mu)); }
  assert.ok(py.length > 4000); assert.ok(worst < 1e-8, 'max prediction difference ' + worst);
});

// ---------------------------------------------------------------- data loader (mlb/lib/vas-data.js)
const D = require('../mlb/lib/vas-data');
const RAW = path.join(__dirname, '../mlb/research/data/');

// statsapi-shaped boxscore rebuilt from the research compaction (fetch_statsapi.py keeps every field compactBox reads)
function rawBoxscore(c) {
  const team = t => {
    const players = {};
    for (const b of t.bat) players['ID' + b.id] = { battingOrder: b.bo || undefined, stats: { batting: { plateAppearances: b.pa, atBats: b.ab, hits: b.h, doubles: b.d, triples: b.t,
      homeRuns: b.hr, baseOnBalls: b.bb, intentionalWalks: b.ibb, hitByPitch: b.hbp, strikeOuts: b.so, sacFlies: b.sf } } };
    for (const p of t.pit) {
      const q = players['ID' + p.id] || {};
      q.stats = { ...(q.stats || {}), pitching: { outs: p.outs, battersFaced: p.bf, strikeOuts: p.k, baseOnBalls: p.bb, intentionalWalks: p.ibb, hitBatsmen: p.hbp, homeRuns: p.hr, numberOfPitches: p.np } };
      players['ID' + p.id] = q;
    }
    return { batters: t.bat.map(b => b.id), pitchers: t.pit.map(p => p.id), players };
  };
  return { teams: { home: team(c.teams.home), away: team(c.teams.away) },
    info: [{ label: 'Weather', value: c.info.Weather || '' }, { label: 'Wind', value: c.info.Wind || '' }],
    officials: c.hp ? [{ officialType: 'Home Plate', official: { id: c.hp } }] : [] };
}
function rawFetcher() {
  const boxes = new Map(), people = JSON.parse(fs.readFileSync(RAW + 'people.json')); let calls = 0;
  for (const f of fs.readdirSync(RAW + 'box')) for (const l of fs.readFileSync(RAW + 'box/' + f, 'utf8').split('\n')) if (l) { const c = JSON.parse(l); boxes.set(c.pk, c); }
  const fetchJSON = async url => {
    calls++;
    let m = /\/schedule\?.*startDate=(\d{4})-/.exec(url);
    if (m) return JSON.parse(fs.readFileSync(RAW + `sched/${m[1]}.json`));
    m = /\/game\/(\d+)\/boxscore$/.exec(url);
    if (m) { const c = boxes.get(Number(m[1])); if (!c) throw Error('404'); return rawBoxscore(c); }
    m = /\/people\?personIds=([\d,]+)/.exec(url);
    if (m) return { people: m[1].split(',').filter(id => people[id]).map(id => ({ id: Number(id), pitchHand: { code: people[id].p } })) };
    throw Error('unexpected url ' + url);
  };
  return { fetchJSON, calls: () => calls };
}

test('loader: schedule parsing, ESPN mapping and opener parsing', () => {
  const sched = { dates: [{ games: [
    { gamePk: 1, gameType: 'R', season: '2026', officialDate: '2026-09-20', gameDate: '2026-09-20T17:05:00Z', dayNight: 'day', venue: { id: 3 }, status: { abstractGameState: 'Final', codedGameState: 'D' },
      teams: { home: { team: { id: 10 }, score: 0 }, away: { team: { id: 20 }, score: 0 } } },
    { gamePk: 1, gameType: 'R', season: '2026', officialDate: '2026-09-21', gameDate: '2026-09-21T17:05:00Z', dayNight: 'day', venue: { id: 3 }, status: { abstractGameState: 'Final', codedGameState: 'F' },
      teams: { home: { team: { id: 10 }, score: 5, probablePitcher: { id: 7 } }, away: { team: { id: 20 }, score: 2 } } },
    { gamePk: 2, gameType: 'R', season: '2026', officialDate: '2026-09-24', gameDate: '2026-09-24T23:05:00Z', dayNight: 'night', venue: { id: 3 }, status: { abstractGameState: 'Preview', codedGameState: 'S' },
      teams: { home: { team: { id: 10, name: 'Cleveland Guardians', abbreviation: 'CLE' }, probablePitcher: { id: 7, fullName: 'A B' } }, away: { team: { id: 20, name: 'Athletics', abbreviation: 'ATH' } } } }] }] };
  const fin = D.scheduleFinals(sched);
  assert.equal(fin.size, 1); assert.deepEqual(fin.get(1).prob, { home: 7, away: null }); assert.equal(fin.get(1).day, '2026-09-21');
  const up = D.scheduleUpcoming(sched); assert.equal(up.length, 1); assert.equal(up[0].abbr.home, 'CLE'); assert.equal(up[0].prob.home, 7);
  const ev = [{ id: 'e2', start: '2026-09-24T23:05Z', homeName: 'Cleveland Guardians', awayName: 'Oakland Athletics' }];
  assert.equal(D.mapEspn(up, ev).get(2), 'e2');
  const odds = { items: [
    { provider: { id: '100', name: 'DraftKings' }, homeTeamOdds: { moneyLine: -140, open: { moneyLine: { american: '-125' } }, current: { moneyLine: { american: '-140' } } },
      awayTeamOdds: { moneyLine: 120, open: { moneyLine: { american: '+105' } }, current: { moneyLine: { american: '+120' } } },
      open: { total: { american: '8.5' }, over: { american: '-110' }, under: { american: '-110' } } },
    { provider: { id: '59', name: 'ESPN BET - Live Odds' }, homeTeamOdds: {}, awayTeamOdds: {} }] };
  const b = D.parseOdds(odds); assert.equal(b.length, 1); assert.equal(b[0].home.open, -125); assert.equal(b[0].away.current, 120); assert.equal(b[0].totalOpen.line, 8.5);
});

test('loader: gradual backfill, per-hour retry, cache kept on failure', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mlbvas-'));
  let T = Date.parse('2026-09-23T15:00:00Z'), fail = false; const urls = [];
  const sched = { dates: [{ games: Array.from({ length: 5 }, (_, i) => ({ gamePk: 100 + i, gameType: 'R', season: '2026', officialDate: '2026-09-2' + i, gameDate: `2026-09-2${i}T23:05:00Z`,
    dayNight: 'night', venue: { id: 3 }, status: { abstractGameState: 'Final', codedGameState: 'F' }, teams: { home: { team: { id: 1 }, score: 3, probablePitcher: { id: 50 } }, away: { team: { id: 2 }, score: 1, probablePitcher: { id: 60 } } } })) }] };
  const box = { teams: { home: { batters: [], pitchers: [50], players: { ID50: { stats: { pitching: { outs: 27, battersFaced: 30 } } } } },
    away: { batters: [], pitchers: [60], players: { ID60: { stats: { pitching: { outs: 24, battersFaced: 28 } } } } } }, info: [], officials: [] };
  const fetchJSON = async url => { urls.push(url); if (fail) throw Error('down'); if (url.includes('/schedule')) return sched; if (url.includes('/people')) return { people: [{ id: 50, pitchHand: { code: 'L' } }] }; return box; };
  const L = D.create({ dir, fetchJSON, now: () => T, firstSeason: 2026 });
  let h = await L.history({ maxFetch: 2 });
  assert.equal(h.games.length, 2); assert.equal(h.complete, false); assert.equal(h.hands[50], 'L');
  h = await L.history({ maxFetch: 10 }); assert.equal(h.games.length, 5); assert.equal(h.complete, true);
  assert.ok(!urls.slice(urls.findIndex(u => u.includes('/people')) + 1).some(u => u.includes('/people')), 'hands asked once, unknown ids cached');
  fail = true; T += 7 * 3600e3; const n = urls.length;
  h = await L.history(); assert.equal(h.games.length, 5, 'cache kept on failure'); assert.ok(L.status().lastError);
  assert.equal(urls.length, n + 1, 'one schedule top-up attempt');
  await L.history(); assert.equal(urls.length, n + 1, 'failed URL not retried within the hour');
  T += 3600e3 + 1; await L.history(); assert.equal(urls.length, n + 2, 'retried after an hour');
  // a fresh loader on the same dir reads everything from disk without the network
  const L2 = D.create({ dir, fetchJSON: async () => { throw Error('offline'); }, now: () => T, firstSeason: 2026 });
  assert.equal((await L2.history()).games.length, 5);
});

test('loader parity: history built by vas-data.js from raw statsapi data reproduces the Python 2026 features', {
  skip: !fs.existsSync(RAW + 'box/2026.jsonl') || !fs.existsSync(PARITY + 'features_full_2026.json'), timeout: 600000 }, async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mlbvas-raw-'));
  const F = rawFetcher();
  const L = D.create({ dir, fetchJSON: F.fetchJSON, now: () => Date.parse('2026-09-23T16:00:00Z'), firstSeason: 2018 });
  const h = await L.history({ maxFetch: 50000 });
  assert.equal(h.complete, true); assert.equal(h.games.length, 20263);
  const st = E.build(h, MODEL.config), py = JSON.parse(fs.readFileSync(PARITY + 'features_full_2026.json'));
  let worst = 0, n = 0;
  for (const r of py) {
    const f = st.featured.get(r.pk); assert.ok(f, 'game ' + r.pk);
    for (const [k, v] of Object.entries(r)) {
      if (k === 'pk') continue;
      const js = k.startsWith('home_') ? f._home[k.slice(5)] : k.startsWith('away_') ? f._away[k.slice(5)] : f[k];
      const d = v == null && js == null ? 0 : Math.abs(v - js); n++; if (!(d <= worst)) worst = d;
    }
  }
  assert.equal(py.length, 2357); assert.ok(worst < 1e-8, 'max feature difference ' + worst + ' over ' + n);
  const again = await L.history(); assert.equal(again.games.length, 20263); assert.equal(again.info.fetched, 0, 'no refetch once cached');
});
