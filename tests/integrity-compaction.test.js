'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { IntegrityStore, freshness } = require('../shared/clv-integrity');

const KICK = Date.parse('2026-09-26T19:00:00Z');
const event = { id: 'g1', scheduled_start_at: new Date(KICK).toISOString() };
const at = (min) => new Date(KICK + min * 60e3).toISOString();
function obs(store, min, odds = -110, line = 3) {
  return store.ingestObservation({ event, sportsbook: 'circa', source: 'owls', market_type: 's', selection: 'home', line_value: line, american_odds: odds,
    source_observed_at: at(min), received_at: at(min), is_live: false, market_status: 'active', payload: { t: min } });
}
const rows = (dir) => fs.readFileSync(path.join(dir, 'integrity', 'snapshots.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('unchanged repeats are journaled only as a heartbeat, stay fresh, and are always journaled near kickoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-'));
  const s = new IntegrityStore({ dataDir: dir, sport: 'ncaaf' });
  obs(s, -120);                                   // journaled (first)
  const rep = obs(s, -118);                       // same value, 2 min later: not journaled
  assert.equal(rows(dir).length, 1);
  assert.equal(rep.source_observed_at, at(-118), 'overlay carries the newest sighting');
  assert.equal(freshness(rep, Date.parse(at(-117)), s.config).status, 'FRESH');
  const r = s.resolve(event, 's', 'home', 'circa', Date.parse(at(-117)));
  assert.equal(r.current_freshness.status, 'FRESH', 'current quote freshness uses the newest sighting');
  obs(s, -113);                                   // 7 min after the kept row: heartbeat journaled
  assert.equal(rows(dir).length, 2);
  obs(s, -112, -120);                             // value change: journaled immediately
  assert.equal(rows(dir).length, 3);
  obs(s, -10, -120); obs(s, -8, -120); obs(s, -6, -120);   // inside the 15-min close window: every sighting journaled
  assert.equal(rows(dir).length, 6);
  const close = s.resolve(event, 's', 'home', 'circa', KICK + 60e3);
  assert.equal(close.close_snapshot_id, rows(dir).at(-1).snapshot_id, 'close is the last sighting before kickoff');
  assert.equal(s.compaction.repeats_not_journaled, 1);
});

test('startup collapses repeats already on disk without dropping referenced snapshots; compaction can be disabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-'));
  const raw = new IntegrityStore({ dataDir: dir, sport: 'ncaaf', repeatHeartbeatMs: 0 });
  for (let m = -200; m < -150; m += 2) obs(raw, m);     // 25 identical sightings, all journaled with compaction off
  assert.equal(rows(dir).length, 25);
  const ref = rows(dir)[5].snapshot_id;
  fs.appendFileSync(path.join(dir, 'integrity', 'entries.jsonl'), JSON.stringify({ entry_id: 'e1', entry_snapshot_id: ref, bet_id: 'b1' }) + '\n');
  const s = new IntegrityStore({ dataDir: dir, sport: 'ncaaf' });
  assert.ok(s.snapshots.has(ref), 'a snapshot an entry points to is always kept');
  assert.ok(s.snapshots.size < 25 && s.snapshots.size >= 9, 'repeats collapsed to heartbeats: ' + s.snapshots.size);
  assert.equal(rows(dir).length, 25, 'the journal file is never rewritten');
  assert.equal(new IntegrityStore({ dataDir: dir, sport: 'ncaaf', repeatHeartbeatMs: 0 }).snapshots.size, 25);
});
