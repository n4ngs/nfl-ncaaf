'use strict';
// Residency: the CLV ledger held in memory is bounded by event, while the journal on disk stays complete and append-only.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { IntegrityStore, residencyFromEnv } = require('../shared/clv-integrity');

const H = 3600e3;
const KICK = Date.parse('2026-09-26T19:00:00Z');
const WIN = { pregameMs: 72 * H, liveMs: 12 * H, resolutionMs: 12 * H };
const iso = (t) => new Date(t).toISOString();
const ev = (id, kick = KICK) => ({ id, scheduled_start_at: iso(kick) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'resident-'));
const lines = (dir, kind = 'snapshots') => {
  const f = path.join(dir, 'integrity', `${kind}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
};
function quote(store, event, { book = 'circa', market = 's', selection = 'home', line = 3, odds = -110, at, live = false, source = 'owls' }) {
  return store.ingestObservation({ event, sportsbook: book, source, market_type: market, selection, line_value: line, american_odds: odds,
    source_observed_at: iso(at), received_at: iso(at), is_live: live, market_status: 'active', payload: { at, book, selection, live } });
}
const signal = (store, id, event, book, q, at) => store.recordSignal({ signal_id: id, canonical_event_id: event, event_id: event, market_type: 's', selection: 'home',
  sportsbook: book, line_value: q.line_value, american_odds: q.american_odds, entry_snapshot_id: q.snapshot_id, model_version: 'm', feature_version: 'f',
  prediction_created_at: iso(at), features_as_of: iso(at), predicted_probability: 0.55, signal_direction: 'home', signal_strength: 1 });
const bet = (store, id, event, q, at) => store.recordEntry({ entry_id: id, bet_id: 'b-' + id, canonical_event_id: event, market_type: 's', selection: 'home',
  sportsbook: q.sportsbook, line_value: q.line_value, american_odds: q.american_odds, entry_created_at: iso(at), entry_snapshot_id: q.snapshot_id });

test('load keeps warm, bet and signal evidence in memory and leaves cold rows on disk, unparsed and untouched', () => {
  const dir = tmp(); let clock = KICK - 2 * H;
  const writer = new IntegrityStore({ dataDir: dir, sport: 'ncaaf', now: () => clock });   // residency off: every row resident
  const old = ev('old'), placed = ev('bet'), next = ev('new', KICK + 5 * 24 * H);
  const a = quote(writer, old, { at: KICK - 60 * 60e3 });                          // pregame, circa: cold by the reload
  const b = quote(writer, old, { book: 'dk', at: KICK - 50 * 60e3, odds: -115 });   // pregame, dk: a model signal's entry quote
  const b2 = quote(writer, old, { book: 'dk', at: KICK - 45 * 60e3, odds: -118 });  // the same dk series, not referenced
  const c = quote(writer, old, { at: KICK + 30 * 60e3, live: true, odds: -150 });   // live: cold by the reload
  const d = quote(writer, placed, { at: KICK - 40 * 60e3 });                       // a bet is placed on this event
  const e = quote(writer, next, { at: KICK + 4 * 24 * H });                        // next week's game: warm
  signal(writer, 's1', 'old', 'dk', b, KICK - 49 * 60e3);
  bet(writer, 'e1', 'bet', d, KICK - 39 * 60e3);
  writer.resolve(old, 's', 'home', 'circa', KICK + 60e3);
  assert.equal(lines(dir, 'resolutions').length, 1);
  const before = fs.readFileSync(path.join(dir, 'integrity', 'snapshots.jsonl'), 'utf8');

  clock = KICK + 4 * 24 * H;                                                       // 96 h after kickoff
  const logged = [];
  const s = new IntegrityStore({ dataDir: dir, sport: 'ncaaf', residency: WIN, now: () => clock, log: (m) => logged.push(m), sweepMs: 0 });
  assert.equal(s.health().ok, true);
  assert.ok(!s.snapshots.has(a.snapshot_id), 'cold pregame quote stays on disk only');
  assert.ok(s.snapshots.has(b.snapshot_id), "a model signal keeps its own entry quote resident");
  assert.ok(!s.snapshots.has(b2.snapshot_id), 'signals are scored offline: the rest of their series leaves memory');
  assert.ok(!s.snapshots.has(c.snapshot_id), 'cold live quote stays on disk only');
  assert.ok(s.snapshots.has(d.snapshot_id), 'a bet pins its whole event');
  assert.ok(s.snapshots.has(e.snapshot_id), 'upcoming games stay resident');
  assert.deepEqual([s.residencyStats.skipped_cold_snapshots, s.residencyStats.skipped_cold_resolutions], [3, 1]);
  assert.equal(s.rows(old, 's', 'home', 'circa').length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'integrity', 'snapshots.jsonl'), 'utf8'), before, 'the journal file is never rewritten');
  assert.match(logged[0], /^\[integrity\] ncaaf: 3 snapshots \+ 0 resolutions in memory; 3 \+ 1 cold rows left on disk/);
  const all = new IntegrityStore({ dataDir: dir, sport: 'ncaaf' });                // a full load still sees every row
  assert.equal(all.snapshots.size, 6); assert.equal(all.resolutions.size, 1); assert.equal(all.health().ok, true);
});

test('a cold event leaves memory and is never re-journaled, so a later full load finds no conflicting duplicates', () => {
  const dir = tmp(); let clock = KICK - H;
  const s = new IntegrityStore({ dataDir: dir, sport: 'ncaaf', residency: WIN, now: () => clock, sweepMs: 0 });
  const g = ev('g1');
  const pre = quote(s, g, { at: KICK - 20 * 60e3 });
  clock = KICK + 2 * H;
  const live = quote(s, g, { at: KICK + H, live: true, odds: -200 });
  s.resolve(g, 's', 'home', 'circa', clock);
  assert.equal(lines(dir).length, 2); assert.equal(lines(dir, 'resolutions').length, 1);

  clock = KICK + 13 * H;                                      // live window passed, pregame window not
  assert.deepEqual(s.sweep(), { snapshots: 1, resolutions: 1 });
  assert.ok(s.snapshots.has(pre.snapshot_id) && !s.snapshots.has(live.snapshot_id));
  assert.equal(s.rows(g, 's', 'home', 'circa').length, 1, 'indexes follow the eviction');
  quote(s, g, { at: KICK + H, live: true, odds: -200 });      // a feed re-sends the evicted live quote
  assert.equal(lines(dir).length, 2, 'not journaled again');
  s.resolve(g, 's', 'home', 'circa', clock);
  assert.equal(lines(dir, 'resolutions').length, 1, 'a cold resolution is not journaled again either');

  clock = KICK + 73 * H;                                      // pregame window passed
  assert.equal(s.sweep().snapshots, 1);
  assert.deepEqual([s.snapshots.size, s.byEvent.size, s.byMarket.size, s.lastKept.size], [0, 0, 0, 0]);
  const r = s.health().residency;
  assert.deepEqual([r.evicted_snapshots, r.evicted_resolutions, r.cold_not_journaled, r.cold_resolutions_not_journaled], [2, 1, 1, 1]);
  const reload = new IntegrityStore({ dataDir: dir, sport: 'ncaaf' });
  assert.equal(reload.health().ok, true, 'no duplicate identities on disk');
  assert.equal(reload.snapshots.size, 2); assert.equal(reload.resolutions.size, 1);
});

test('a bet recorded at runtime pins its event; a signal keeps only its entry quote', () => {
  const dir = tmp(); let clock = KICK - H;
  const s = new IntegrityStore({ dataDir: dir, sport: 'ncaaf', residency: WIN, now: () => clock, sweepMs: 0 });
  const g = ev('g2'), h = ev('g3');
  const q = quote(s, g, { at: KICK - 30 * 60e3 });
  const sameEvent = quote(s, g, { book: 'dk', at: KICK - 30 * 60e3, odds: -120 });
  bet(s, 'e9', 'g2', q, KICK - 29 * 60e3);
  const pinned = quote(s, h, { book: 'fd', at: KICK - 30 * 60e3, odds: -105 });
  const later = quote(s, h, { book: 'fd', at: KICK - 20 * 60e3, odds: -112 });
  const loose = quote(s, h, { book: 'mgm', at: KICK - 30 * 60e3, odds: -108 });
  signal(s, 's9', 'g3', 'fd', pinned, KICK - 29 * 60e3);
  clock = KICK + 30 * 24 * H;
  s.sweep();
  assert.ok(s.snapshots.has(q.snapshot_id) && s.snapshots.has(sameEvent.snapshot_id), 'the whole bet event stays');
  assert.ok(s.snapshots.has(pinned.snapshot_id), "the signal's entry quote stays");
  assert.ok(!s.snapshots.has(later.snapshot_id) && !s.snapshots.has(loose.snapshot_id), 'everything else on a signal-only event leaves memory');
  assert.equal(s.health().residency.bet_events, 1);
  assert.equal(s.evaluateEntry(s.entries.get('e9'), g).entry.snapshot_id, q.snapshot_id, 'the bet still grades from its own evidence');
});

test('residency is off unless asked for, and the env windows parse safely', () => {
  const dir = tmp(); let clock = KICK - H;
  const s = new IntegrityStore({ dataDir: dir, sport: 'nfl', now: () => clock });
  const q = quote(s, ev('x'), { at: KICK - 30 * 60e3 });
  clock = KICK + 365 * 24 * H;
  assert.deepEqual(s.sweep(), { snapshots: 0, resolutions: 0 });
  assert.ok(s.snapshots.has(q.snapshot_id)); assert.equal(s.health().residency.enabled, false);
  assert.deepEqual(residencyFromEnv({}), { ...WIN, liveMs: 6 * H });
  assert.deepEqual(residencyFromEnv({ CLV_RESIDENT_PREGAME_HOURS: '0', CLV_RESIDENT_LIVE_HOURS: 'junk', CLV_RESIDENT_RESOLUTION_HOURS: '24' }),
    { pregameMs: 0, liveMs: 6 * H, resolutionMs: 24 * H });
});
