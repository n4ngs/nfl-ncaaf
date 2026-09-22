'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeBoard,sourceTime}=require('../shared/owls-schema');
const at='2026-09-22T22:00:00Z';
function event(book='pinnacle',time=at){return {id:'1',commence_time:'2026-09-23T00:00:00Z',home_team:'Home',away_team:'Away',status:'scheduled',bookmakers:[{key:book,last_update:time,markets:[{key:'spreads',outcomes:[{name:'Away',price:100,point:0},{name:'Home',price:-110,point:0}]}]}]};}
test('Owls REST all-book entries merge without dropping correct sides or PK/EV',()=>{const [e]=normalizeBoard({data:{pinnacle:[event()],fanduel:[event('fanduel')]}},'nfl');assert.equal(e.books.pin.s,0);assert.deepEqual(e.books.pin.so,[-110,100]);assert.ok(e.books.fd);assert.equal(e.books.pin.integrityMeta.s.home.source_observed_at,'2026-09-22T22:00:00.000Z');});
test('Owls heartbeat cannot supply a missing quote clock',()=>{const e=event();delete e.bookmakers[0].last_update;const [row]=normalizeBoard({timestamp:at,last_odds_change:at,sports:{nfl:[e]}},'nfl');assert.equal(row.books.pin.integrityMeta.s.home.source_observed_at,null);});
test('Owls granular market timestamp wins over newer book timestamp',()=>{const e=event();e.bookmakers[0].markets[0].last_update='2026-09-22T20:00:00Z';const [row]=normalizeBoard([e],'nfl');assert.equal(row.books.pin.integrityMeta.s.home.source_observed_at,'2026-09-22T20:00:00.000Z');});
test('Owls live and half prices never contaminate pregame full-game',()=>{const e=event();e.status='live';const h=event('fanduel');h.bookmakers[0].markets[0].key='first_half_spreads';const [row]=normalizeBoard([e,h],'nfl');assert.equal(row.books.pin,undefined);assert.ok(row.live.pin);assert.ok(row.h1.fd);});
test('Owls explicit phase conflicts stay unverified',()=>{const e=event();e.isLive=true;const [row]=normalizeBoard([e],'nfl');assert.equal(row.books.pin.is_live,null);});
test('Owls suspended empty markets preserve removal instead of fresh prices',()=>{const e=event();e.bookmakers[0].markets[0].suspended=true;e.bookmakers[0].markets[0].outcomes=[];const q=normalizeBoard([e],'nfl')[0].books.pin.integrityMeta.s.home;assert.equal(q.market_status,'suspended');assert.equal(q.american_odds,null);});
test('Owls newest same-book market wins independent of frame order',()=>{const newer=event('pinnacle','2026-09-22T22:01:00Z');newer.bookmakers[0].markets[0].outcomes[1].price=-120;for(const list of [[event(),newer],[newer,event()]])assert.equal(normalizeBoard(list,'nfl')[0].books.pin.so[0],-120);});
test('Owls equal-clock conflicting quotes cannot be actionable',()=>{const e=event();e.bookmakers[0].markets[0].outcomes[1].price=-120;assert.equal(normalizeBoard([event(),e],'nfl')[0].books.pin.integrityMeta.s.home.market_status,'unverified');});
test('Owls malformed identities, alternate markets and naive timestamps are rejected',()=>{assert.equal(sourceTime('2026-09-22 22:00:00'),null);const e=event();e.commence_time='bad';assert.deepEqual(normalizeBoard([e],'nfl'),[]);const alt=event();alt.bookmakers[0].markets[0].key='alternate_spreads';assert.deepEqual(normalizeBoard([alt],'nfl')[0].books,{});});
test('Owls realtime stale warning and missing phase remain non-actionable evidence',()=>{const e=event();e.status='live';e.isLive=true;e.freshness={stale:true};assert.equal(normalizeBoard([e],'nfl')[0].live.pin.integrityMeta.s.home.market_status,'unverified');delete e.status;delete e.isLive;assert.equal(normalizeBoard([e],'nfl')[0].books.pin.is_live,null);});

test('PS3838 channel cannot masquerade as Pinnacle even if nested provider key says pinnacle',()=>{const e=event();e.__owlsChannel='ps3838-realtime';const row=normalizeBoard([e],'mlb')[0];assert.ok(row.books.ps3838);assert.equal(row.books.pin,undefined);});

test('Owls event freshness blocks stale prices across phase representations',()=>{
 for(const fields of [{status:'live'},{status:'scheduled'},{status:undefined,is_live:true},{status:undefined}]) {
  const e=Object.assign(event(),fields,{freshness:{stale:true}}), row=normalizeBoard([e],'nfl')[0];
  const line=row.live.pin || row.books.pin;
  assert.equal(line.integrityMeta.s.home.market_status,'unverified');
  assert.equal(line.integrityMeta.s.away.market_status,'unverified');
 }
});
