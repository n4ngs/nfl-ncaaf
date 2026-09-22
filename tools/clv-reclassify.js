#!/usr/bin/env node
'use strict';
// Read-only by default. --apply appends classifications to a NEW sidecar only.
// No bet, line-history, signal, snapshot, or account file is modified.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RESOLVER_VERSION, utc, resolveClose, evaluateCLV, configuration, configFromEnv } = require('../shared/clv-integrity');
const stable = (v) => JSON.stringify(order(v));
function order(v) { return Array.isArray(v) ? v.map(order) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, order(v[k])])) : v; }
const hash = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : stable(x)).digest('hex');

function reclassify({ dataDir, sport, apply = false, asOf = new Date().toISOString(), config = {} }) {
  if (!dataDir || !['nfl', 'ncaaf'].includes(sport)) throw new Error('Use an explicit --data-dir and --sport nfl|ncaaf');
  asOf = utc(asOf); if (!asOf) throw new Error('--as-of must be a UTC or timezone-qualified timestamp');
  config = configuration({ ...configFromEnv(), ...config });
  const requested = path.resolve(dataDir);
  const dir = fs.existsSync(path.join(requested, sport)) ? path.join(requested, sport) : requested;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Data directory does not exist');
  const inputs = new Map();
  function read(file, fallback, jsonl = false) {
    const absolute = path.join(dir, file); if (!fs.existsSync(absolute)) return fallback;
    const raw = fs.readFileSync(absolute, 'utf8'); inputs.set(absolute, hash(raw));
    try {
      if (!jsonl) return JSON.parse(raw);
      return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    } catch { throw new Error(`Invalid JSON evidence in ${file}; no classifications written`); }
  }
  const bets = read('bets.json', { bets: [] });
  if (!Array.isArray(bets.bets)) throw new Error('Invalid bets schema; no classifications written');
  const snapshots = read('integrity/snapshots.jsonl', [], true), entries = read('integrity/entries.jsonl', [], true), signals = read('integrity/signals.jsonl', [], true);
  const byId = new Map(), byEntry = new Map();
  for (const q of snapshots) { if (!q.snapshot_id || (byId.has(q.snapshot_id) && stable(byId.get(q.snapshot_id)) !== stable(q))) throw new Error('Conflicting snapshot identities; no classifications written'); byId.set(q.snapshot_id, q); }
  for (const e of entries) { if (!e.entry_id || (byEntry.has(e.entry_id) && stable(byEntry.get(e.entry_id)) !== stable(e))) throw new Error('Conflicting entry identities; no classifications written'); byEntry.set(e.entry_id, e); }
  const records = [];
  function classify(sourceRef, identity, raw, result) {
    const record = { classifier_version: RESOLVER_VERSION, sport, source_ref: sourceRef, record_identity: identity, source_sha256: hash(raw), eligibility_status: result.eligibility_status || result.status, reason_code: result.reason_code, line_clv_points: result.line_clv_points ?? null, clv_fair_probability_pp: result.clv_fair_probability_pp ?? null, clv_ev_pct: result.clv_ev_pct ?? null, price_clv_status: result.price_clv_status || 'UNAVAILABLE', entry_snapshot_id: result.entry?.snapshot_id || null, close_snapshot_id: result.close?.snapshot_id || null, kickoff_basis: result.kickoff_basis || null };
    record.classification_id = hash(record); record.evaluated_as_of = asOf; records.push(record);
  }
  function evaluate(entry, rawEvent) {
    const q = byId.get(entry.entry_snapshot_id), id = String(entry.canonical_event_id || entry.event_id || entry.gid || rawEvent.id || '');
    const event = { ...rawEvent, id, scheduled_start_at: q?.scheduled_start_at || rawEvent.start, actual_start_at: q?.actual_start_at || null, actual_start_verified: q?.actual_start_verified === true, actual_start_source: q?.actual_start_source || null };
    const sameEvent = snapshots.filter((s) => s.canonical_event_id === id);
    // Later verified actual-start evidence may improve a close; legacy close.at is never kickoff evidence.
    const verified = sameEvent.filter((s) => s.actual_start_verified && s.actual_start_source && utc(s.actual_start_at) && utc(s.received_at) && Date.parse(s.received_at) <= Date.parse(asOf));
    const starts = new Set(verified.map((s) => utc(s.actual_start_at)));
    if (starts.size > 1) event.timestamp_conflict = true;
    else if (verified.length) { event.actual_start_at = verified[0].actual_start_at; event.actual_start_verified = true; event.actual_start_source = verified[0].actual_start_source; }
    const rows = q ? sameEvent.filter((s) => s.canonical_market_key === q.canonical_market_key && s.selection === q.selection && s.sportsbook === q.sportsbook && s.source === q.source) : [];
    const resolution = resolveClose(rows, event, config, asOf);
    return evaluateCLV(entry, q, resolution, { snapshots: sameEvent, event, config });
  }
  for (const bet of bets.bets) for (const [index, leg] of (bet.legs || []).entries()) {
    const id = `${bet.id}:${index}`, entry = leg.entry_record || byEntry.get(id) || { bet_id: bet.id, entry_id: id, canonical_event_id: String(leg.gid || ''), market_type: leg.mkt, selection: leg.side, team: leg.team, sportsbook: bet.book, entry_created_at: bet.placed, line_value: leg.line, american_odds: leg.odds, entry_snapshot_id: null };
    classify('bets.json', id, { bet_id: bet.id, placed: bet.placed, book: bet.book, leg }, evaluate(entry, { id: leg.gid, start: leg.start }));
  }
  for (const signal of signals) classify('integrity/signals.jsonl', signal.signal_id, signal, evaluate(signal, { id: signal.event_id || signal.canonical_event_id, start: signal.scheduled_start_at }));
  const weeks = path.join(dir, 'weeks');
  if (fs.existsSync(weeks)) for (const file of fs.readdirSync(weeks).filter((f) => f.endsWith('.json')).sort()) {
    const data = read(`weeks/${file}`, null);
    for (const [gid, game] of Object.entries(data?.games || {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (game.open || game.close || game.b) classify(`weeks/${file}`, gid, game, { eligibility_status: 'RETROSPECTIVE_MARKET_MOVE', reason_code: 'LEGACY_MARKET_HISTORY_HAS_NO_IMMUTABLE_ENTRY' });
    }
  }
  const sidecar = path.join(dir, 'integrity/reclassification-v1.jsonl');
  const existing = new Map();
  if (fs.existsSync(sidecar)) {
    let rows; try { rows = fs.readFileSync(sidecar, 'utf8').split('\n').filter((x) => x.trim()).map(JSON.parse); } catch { throw new Error('Invalid reclassification sidecar; no classifications written'); }
    for (const row of rows) { if (!row.classification_id) throw new Error('Invalid reclassification identity'); existing.set(row.classification_id, row); }
  }
  const pending = records.filter((record) => !existing.has(record.classification_id));
  const counts = {}, reasons = {};
  for (const record of records) { counts[record.eligibility_status] = (counts[record.eligibility_status] || 0) + 1; reasons[record.reason_code] = (reasons[record.reason_code] || 0) + 1; }
  if (apply && pending.length) {
    // Abort instead of racing an actively changing source; retry from fresh evidence.
    for (const [file, originalHash] of inputs) if (hash(fs.readFileSync(file, 'utf8')) !== originalHash) throw new Error('Source data changed during classification; retry without changing raw data');
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    const fd = fs.openSync(sidecar, 'a'); try { fs.writeFileSync(fd, pending.map((r) => stable(r) + '\n').join('')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  return { mode: apply ? 'APPLY_ADDITIVE_SIDECAR' : 'DRY_RUN', sport, data_dir: dir, evaluated_as_of: asOf, thresholds: config, raw_files_modified: 0, records: records.length, new_classifications: pending.length, already_classified: records.length - pending.length, counts, reasons, sidecar: apply ? sidecar : null };
}
function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--apply') args.apply = true;
    else if (value === '--dry-run') args.apply = false;
    else if (['--data-dir', '--sport', '--as-of'].includes(value)) { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${value}`); args[{ '--data-dir': 'dataDir', '--sport': 'sport', '--as-of': 'asOf' }[value]] = argv[++i]; }
    else if (value === '--help') { console.log('Usage: node tools/clv-reclassify.js --data-dir /path/to/data --sport nfl|ncaaf [--as-of 2026-09-22T00:00:00Z] [--apply]\nDefault: dry-run. --apply appends only integrity/reclassification-v1.jsonl; raw files are never rewritten.'); return; }
    else throw new Error(`Unknown argument: ${value}`);
  }
  console.log(JSON.stringify(reclassify(args), null, 2));
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { reclassify, main };
