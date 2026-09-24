'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const I = require('../shared/injuries');

const espn = { injuries: [
  { id: '22', displayName: 'Arizona Cardinals', injuries: [
    { status: 'Questionable', date: '2026-09-24T02:12Z', shortComment: 'Melton (toe) did not participate Wednesday.', athlete: { displayName: 'Max Melton', position: { abbreviation: 'CB' } }, details: { type: 'Toe', returnDate: '2026-09-27' } },
    { status: 'Active', date: '2026-09-20T12:00Z', athlete: { displayName: 'Back Healthy', position: { abbreviation: 'WR' } } } ] },
  { id: '25', displayName: 'San Francisco 49ers', injuries: [
    { status: 'Out', date: '2026-09-23T20:00Z', athlete: { displayName: 'Some Tackle', position: { abbreviation: 'OT' } } } ] } ] };
const res = body => ({ ok: true, status: 200, json: async () => body });

test('ESPN league list parses dated rows per team, newest first', () => {
  const teams = I.parseEspn(espn);
  assert.equal(teams.arizonacardinals.rows[0].name, 'Max Melton');
  assert.equal(teams.arizonacardinals.rows[0].date, '2026-09-24T02:12:00.000Z');
  assert.equal(teams.arizonacardinals.rows[0].returnDate, '2026-09-27');
  assert.equal(teams.sanfrancisco49ers.id, '25');
});

test('MLB transactions keep injured-list moves only', () => {
  const moves = I.parseMlbTransactions({ transactions: [
    { description: 'Texas Rangers placed RHP Cal Quantrill on the 15-day injured list. Right lat strain.', toTeam: { name: 'Texas Rangers' }, person: { fullName: 'Cal Quantrill' }, date: '2026-09-22', effectiveDate: '2026-09-19' },
    { description: 'Texas Rangers optioned RHP X to Round Rock.', toTeam: { name: 'Texas Rangers' }, person: { fullName: 'X' }, date: '2026-09-23' } ] });
  assert.equal(moves.length, 1); assert.equal(moves[0].effective, '2026-09-19');
});

test('service publishes only on change and the engine sees non-Active rows for both teams', async () => {
  const updates = [];
  const svc = I.createInjuries({ fetchImpl: async () => res(espn), onUpdate: (sport, view) => updates.push(view), setTimeout: () => 0, clearTimeout: () => {} });
  await svc._pollLeague('nfl'); await svc._pollLeague('nfl');
  assert.equal(updates.length, 1);
  const child = new EventEmitter(); child.connected = true;
  const engine = new EventEmitter();
  child.send = (m, cb) => { engine.emit('message', m); cb?.(); };
  engine.send = m => child.emit('message', m);
  const relay = I.relayToChild(child, 'nfl', svc);
  const sub = I.subscribe('nfl', null, engine);
  const r = sub.forTeams('San Francisco 49ers', 'Arizona Cardinals');
  assert.deepEqual(r.home.map(x => x.name), ['Max Melton']);
  assert.deepEqual(r.away.map(x => x.status), ['Out']);
  assert.equal(sub.forTeams('Nobody', 'Nowhere'), null);
  relay.close(); sub.close(); svc.stop();
});

test('a failed poll is counted and never throws', async () => {
  const svc = I.createInjuries({ fetchImpl: async () => ({ ok: false, status: 503 }), setTimeout: () => 0, clearTimeout: () => {} });
  await svc._pollLeague('nhl');
  assert.equal(svc.status().nhl.errors, 1); assert.equal(svc.status().nhl.lastError, 'http_503');
});
