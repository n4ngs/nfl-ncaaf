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

function mgmZero(i,{clock=at,legitimate=false,points=0,book='betmgm'}={}) {
 const e=event(book,clock);e.id=String(i);e.home_team='Home '+i;e.away_team='Away '+i;
 e.bookmakers[0].markets=[{key:'spreads',outcomes:[{name:e.home_team,price:-110,point:points},{name:e.away_team,price:-110,point:-points}]},
  {key:'h2h',outcomes:[{name:e.home_team,price:legitimate?-110:-400},{name:e.away_team,price:legitimate?-110:300}]},
  {key:'totals',outcomes:[{name:'Over',price:-110,point:45.5},{name:'Under',price:-110,point:45.5}]}];return e;
}
test('Owls quarantines contradictory football MGM zero batches without changing moneyline, totals or source time',()=>{
 for(const sport of ['nfl','ncaaf']) {
  const input=Array.from({length:5},(_,i)=>mgmZero(i)),before=JSON.stringify(input),rows=normalizeBoard(input,sport);
  for(const e of rows){const L=e.books.mgm;assert.equal(L.s,null);assert.equal(L.t,45.5);assert.deepEqual(L.ml,[-400,300]);
   for(const q of Object.values(L.integrityMeta.s)){assert.equal(q.line_value,null);assert.equal(Math.abs(q.reported_line_value),0);assert.equal(q.market_status,'unverified');assert.equal(q.reason_code,'UPSTREAM_ZERO_HANDICAP_CONFLICT');assert.equal(q.source_observed_at,'2026-09-22T22:00:00.000Z');}}
  assert.equal(JSON.stringify(input),before);
 }
});
test('Owls preserves real PK prices, other books, first halves and baseball even inside suspect batches',()=>{
 const input=Array.from({length:5},(_,i)=>mgmZero(i));input.push(mgmZero(5,{legitimate:true}),mgmZero(6,{book:'fanduel'}));
 input[0].bookmakers[0].markets.push({...structuredClone(input[0].bookmakers[0].markets[0]),key:'first_half_spreads'});
 const rows=normalizeBoard(input,'nfl');assert.equal(rows[5].books.mgm.s,0);assert.equal(rows[5].books.mgm.integrityMeta.s.home.market_status,'active');assert.equal(rows[6].books.fd.s,0);assert.equal(rows[0].h1.mgm.s,0);
 assert.equal(normalizeBoard(input,'mlb')[0].books.mgm.s,0);
});
test('zero quarantine requires enough distinct contemporaneous games and a corroborating moneyline clock',()=>{
 const five=Array.from({length:5},(_,i)=>mgmZero(i));
 for(const input of [five.slice(0,4),Array(5).fill(five[0]),five.map((e,i)=>mgmZero(i,{clock:i<3?at:'2026-09-22T22:01:00Z'})),[...five,mgmZero(5,{points:-3})]])assert.equal(normalizeBoard(input,'nfl')[0].books.mgm.s,0);
 const differentClock=structuredClone(five);differentClock[0].bookmakers[0].markets[1].last_update='2026-09-22T21:59:00Z';assert.equal(normalizeBoard(differentClock,'nfl')[0].books.mgm.s,0);
 const missing=structuredClone(five);missing[0].bookmakers[0].markets[0].outcomes[0].point=null;assert.equal(normalizeBoard(missing,'nfl')[0].books.mgm.s,null);
});
test('corrected Owls evidence suppresses a previously ingested bad current zero without rewriting history',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {IntegrityStore,freshness}=require('../shared/clv-integrity');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owls-zero-'));try{
  const store=new IntegrityStore({sport:'nfl',dataDir:dir}),raw=Array.from({length:5},(_,i)=>mgmZero(i)),g={id:'game',start:raw[0].commence_time,state:'pre'},received=Date.parse(at)+1000;
  const old=normalizeBoard([raw[0]],'nfl')[0].books.mgm,before=store.observeLine(g,'mgm',old,{source:'owls',received_at:received,is_live:false});
  assert.equal(store.resolve(g,'s','home','mgm',received).current.line_value,0);
  const corrected=normalizeBoard(raw,'nfl')[0].books.mgm,after=store.observeLine(g,'mgm',corrected,{source:'owls',received_at:received+1000,is_live:false});
  assert.equal(store.resolve(g,'s','home','mgm',received+1000).current,null);
  assert.ok(after.filter(q=>q.market_type==='s').every(q=>freshness(q,received+1000).status==='UNVERIFIED'));
  assert.equal(store.snapshot(before.find(q=>q.market_type==='s').snapshot_id).line_value,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
