'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reclassify } = require('../tools/clv-reclassify');
const { IntegrityStore } = require('../shared/clv-integrity');
const AS_OF = '2026-09-22T00:00:00.000Z';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clv-reclassify-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'nfl'); fs.mkdirSync(path.join(dir, 'weeks'), { recursive: true });
  const bets = { v: 1, bets: [{ id: 'legacy-bet', owner: 'unchanged-owner', stake: 50, placed: '2026-09-21T12:00:00.000Z', book: 'BetMGM', status: 'won', net: 45.45, legs: [{ gid: '123', mkt: 's', side: 'home', line: -2.5, odds: -110, start: '2026-09-21T13:00:00.000Z', state: 'won', clv: { pts: 1.5 } }] }] };
  fs.writeFileSync(path.join(dir, 'bets.json'), JSON.stringify(bets));
  fs.writeFileSync(path.join(dir, 'weeks/2026-2-03.json'), JSON.stringify({ v: 1, games: { 123: { open: { s: -2.5 }, close: { s: -4, at: 1770000000000 } } } }));
  return { root, dir, bets, run: (extras = {}) => reclassify({ dataDir: root, sport: 'nfl', asOf: AS_OF, ...extras }) };
}
test('dry-run default never creates integrity directory or changes raw files', (t) => { const f = fixture(t); const before = fs.readFileSync(path.join(f.dir, 'bets.json')); const r = f.run(); assert.equal(r.mode, 'DRY_RUN'); assert.equal(r.raw_files_modified, 0); assert.equal(r.counts.MISSING_ENTRY_SNAPSHOT, 1); assert.equal(r.counts.RETROSPECTIVE_MARKET_MOVE, 1); assert.deepEqual(fs.readFileSync(path.join(f.dir, 'bets.json')), before); assert.equal(fs.existsSync(path.join(f.dir, 'integrity')), false); });
test('reclassification is deterministic for a fixed as-of and input', (t) => { const f = fixture(t); assert.deepEqual(f.run(), f.run()); });
test('apply is additive, preserves original legacy CLV, and is restartable/idempotent', (t) => { const f = fixture(t); const before = fs.readFileSync(path.join(f.dir, 'bets.json')); const first = f.run({ apply: true }); const content = fs.readFileSync(first.sidecar, 'utf8'); assert.equal(first.new_classifications, 2); const second = f.run({ apply: true }); assert.equal(second.new_classifications, 0); assert.equal(second.already_classified, 2); assert.equal(fs.readFileSync(first.sidecar, 'utf8'), content); assert.deepEqual(fs.readFileSync(path.join(f.dir, 'bets.json')), before); assert.equal(JSON.parse(before).bets[0].legs[0].clv.pts, 1.5); });
test('same semantic classifications are deduped at a later invocation time', (t) => { const f = fixture(t); f.run({ apply: true }); assert.equal(f.run({ apply: true, asOf: '2026-09-23T00:00:00Z' }).new_classifications, 0); });
test('malformed source fails closed without a sidecar', (t) => { const f = fixture(t); fs.writeFileSync(path.join(f.dir, 'bets.json'), '{broken'); assert.throws(() => f.run({ apply: true }), /Invalid JSON evidence/); assert.equal(fs.existsSync(path.join(f.dir, 'integrity')), false); });
test('malformed snapshot journal cannot silently grant CLV', (t) => { const f = fixture(t); fs.mkdirSync(path.join(f.dir, 'integrity')); fs.writeFileSync(path.join(f.dir, 'integrity/snapshots.jsonl'), '{truncated'); assert.throws(() => f.run({ apply: true }), /Invalid JSON evidence/); assert.equal(fs.existsSync(path.join(f.dir, 'integrity/reclassification-v1.jsonl')), false); });
test('existing immutable entry evidence may resolve provisional CLV without fabricating kickoff', (t) => {
  const f = fixture(t), store = new IntegrityStore({ dataDir: f.dir, sport: 'nfl' });
  const base = { canonical_event_id: '123', sportsbook: 'mgm', source: 'betmgm', market_type: 's', selection: 'home', market_status: 'active', is_live: false, scheduled_start_at: '2026-09-21T13:00:00Z', american_odds: -110 };
  const entryQuote = store.ingestObservation({ ...base, line_value: -2.5, source_observed_at: '2026-09-21T11:59:00Z', received_at: '2026-09-21T11:59:01Z' });
  store.ingestObservation({ ...base, line_value: -4, source_observed_at: '2026-09-21T12:59:00Z', received_at: '2026-09-21T12:59:01Z' });
  f.bets.bets[0].legs[0].entry_record = store.recordEntry({ entry_id: 'legacy-bet:0', bet_id: 'legacy-bet', canonical_event_id: '123', market_type: 's', selection: 'home', sportsbook: 'mgm', entry_created_at: f.bets.bets[0].placed, line_value: -2.5, american_odds: -110, entry_snapshot_id: entryQuote.snapshot_id });
  fs.writeFileSync(path.join(f.dir, 'bets.json'), JSON.stringify(f.bets)); const result = f.run({ apply: true });
  assert.equal(result.counts.PROVISIONAL_CLV, 1); const row = fs.readFileSync(result.sidecar, 'utf8').trim().split('\n').map(JSON.parse).find((x) => x.record_identity === 'legacy-bet:0'); assert.equal(row.line_clv_points, 1.5); assert.equal(row.price_clv_status, 'NOT_COMPARABLE'); assert.equal(row.kickoff_basis, 'SCHEDULED_START');
});
test('invalid sport or ambiguous timestamp is rejected', (t) => { const f = fixture(t); assert.throws(() => f.run({ sport: 'mlb' }), /explicit/); assert.throws(() => f.run({ asOf: '2026-09-22T00:00:00' }), /timezone/); });
test('as-of replay excludes later-received actual-start evidence', (t) => {
  const f = fixture(t), store = new IntegrityStore({ dataDir: f.dir, sport: 'nfl' });
  const base = { canonical_event_id: '123', sportsbook: 'mgm', source: 'betmgm', market_type: 's', selection: 'home', market_status: 'active', is_live: false, scheduled_start_at: '2026-09-21T13:00:00Z', american_odds: -110 };
  const q = store.ingestObservation({ ...base, line_value: -2.5, source_observed_at: '2026-09-21T11:59:00Z', received_at: '2026-09-21T11:59:01Z' });
  store.ingestObservation({ ...base, line_value: -4, source_observed_at: '2026-09-21T12:59:00Z', received_at: '2026-09-21T12:59:01Z' });
  store.ingestObservation({ ...base, line_value: -4, source_observed_at: '2026-09-21T13:04:00Z', received_at: '2026-09-21T13:06:00Z', actual_start_at: '2026-09-21T13:05:00Z', actual_start_verified: true, actual_start_source: 'official-play-clock' });
  f.bets.bets[0].legs[0].entry_record = store.recordEntry({ entry_id: 'legacy-bet:0', bet_id: 'legacy-bet', canonical_event_id: '123', market_type: 's', selection: 'home', sportsbook: 'mgm', entry_created_at: f.bets.bets[0].placed, line_value: -2.5, american_odds: -110, entry_snapshot_id: q.snapshot_id });
  fs.writeFileSync(path.join(f.dir, 'bets.json'), JSON.stringify(f.bets));
  const before = f.run({ asOf: '2026-09-21T13:02:00Z' }); assert.equal(before.counts.PROVISIONAL_CLV, 1); assert.equal(before.counts.VERIFIED_CLV, undefined);
  const after = f.run({ asOf: '2026-09-21T13:07:00Z' }); assert.equal(after.counts.VERIFIED_CLV, 1);
});
test('reclassification honors configured runtime freshness limits', (t) => {
  const f = fixture(t); const result = f.run({ config: { pregame_max_age_ms: 12345, live_max_age_ms: 1000, closing_max_age_ms: 67890 } });
  assert.equal(result.thresholds.pregame_max_age_ms, 12345); assert.equal(result.thresholds.live_max_age_ms, 1000); assert.equal(result.thresholds.closing_max_age_ms, 67890);
});
