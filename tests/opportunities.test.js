'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {OpportunityService,scan,fairPair,decimal,deadline}=require('../shared/opportunities');
const NOW=Date.parse('2026-10-20T18:00:00Z'),iso=n=>new Date(n).toISOString(),copy=x=>JSON.parse(JSON.stringify(x));
function fixture({market='ml',live=false,sport='mlb'}={}){
 const sides=market==='t'?['over','under']:['home','away'];const line=market==='t'?6.5:market==='s'?-1.5:null;
 const q=(book,side,odds,id)=>({american_odds:odds,line_value:market==='s'&&side==='away'?-line:line,pair_id:book+':'+market,market_status:'active',is_live:live,source_observed_at:null,provider_received_at:iso(NOW-1000),provider_quote_id:String(id),bet_link:book==='mgm'?{provider:'sharp',book,id:String(id)}:null});
 const books={mgm:{integrityMeta:{[market]:{[sides[0]]:q('mgm',sides[0],110,123),[sides[1]]:q('mgm',sides[1],-130,124)}}},pin:{integrityMeta:{[market]:{[sides[0]]:q('pin',sides[0],-110,125),[sides[1]]:q('pin',sides[1],-110,126)}}}};
 return {events:[{id:sport+':event',home:'Home Team',away:'Away Team',start:iso(NOW+(live?-3600000:3600000)),[live?'live':'books']:books}],receivedAt:NOW-100,status:{streamHealthy:true}};
}
const offer=(frame,live=false,market='ml',side='home')=>frame.events[0][live?'live':'books'].mgm.integrityMeta[market][side];
const pin=(frame,live=false,market='ml',side='home')=>frame.events[0][live?'live':'books'].pin.integrityMeta[market][side];
const target=(frame,sport='mlb',now=NOW)=>scan('sharp',sport,frame,now).filter(x=>x.book==='mgm');
test('scanner compares exact two-way prices, strips vig and marks delivery-only benchmark honestly',()=>{const frame=fixture(),row=target(frame)[0];assert.equal(target(frame).length,1);assert.ok(Math.abs(row.probability-.5)<1e-12);assert.ok(Math.abs(row.evPct-5)<1e-10);assert.equal(row.clockKind,'PROVIDER_DELIVERY');assert.equal(row.observedAt,null);assert.equal(row.benchmarkKind,'TWO_WAY_NO_PUSH_MARKET_ESTIMATE');assert.equal(row.handoff,true);assert.ok(Math.abs(fairPair(-110,-110).reduce((s,n)=>s+n,0)-1)<1e-12);assert.equal(decimal('-110'),null);assert.equal(fairPair(500,500),null);assert.equal(fairPair(-500,-500),null);});
test('both reference and offered pairs must be complete, same-pair, exact opposite spread or equal total',()=>{
 for(const market of ['ml','s','t']){
  const base=fixture({market});assert.equal(target(base).length,1);
  const first=market==='t'?'over':'home',second=market==='t'?'under':'away';
  for(const mutate of [f=>delete f.events[0].books.pin.integrityMeta[market][second],f=>delete f.events[0].books.mgm.integrityMeta[market][second],f=>pin(f,false,market,second).pair_id='different',f=>offer(f,false,market,second).pair_id='different',f=>pin(f,false,market,second).line_value=99,f=>offer(f,false,market,second).line_value=99]){const frame=copy(base);mutate(frame);assert.equal(target(frame).length,0,market);}
 }
 const spread=fixture({market:'s'});pin(spread,false,'s').line_value=-2.5;pin(spread,false,'s','away').line_value=2.5;assert.equal(target(spread).length,0);
});
test('integer/quarter-point push exposure and NFL tie-push moneylines are excluded without a push model',()=>{
 for(const market of ['s','t'])for(const line of [0,3,3.25,6]){const f=fixture({market});for(const L of Object.values(f.events[0].books))for(const [side,q]of Object.entries(L.integrityMeta[market]))q.line_value=market==='s'&&side==='away'?-line:line;assert.equal(target(f).length,0);}
 assert.equal(target(fixture(),'nfl').length,0);assert.equal(target(fixture({market:'s'}),'nfl').length,1);assert.equal(target(fixture(),'ncaaf').length,1);assert.equal(target(fixture(),'nhl').length,1);
});
test('freshness fails closed for future/malformed/expired clocks, phase, suspension and every conflict flag',()=>{
 const changes=[{market_status:'suspended'},{conflicted:true},{conflict:true},{missing_from_source:true},{freshness:'STALE'},{freshness:'SUSPENDED'},{freshness:'CONFLICTED'},{is_live:true},{american_odds:null},{source_observed_at:iso(NOW+1)},{provider_received_at:iso(NOW+1)},{source_observed_at:'bad-time'},{provider_received_at:'bad-time'},{provider_received_at:iso(NOW-90000)},{max_age_ms:500}];
 for(const change of changes){for(const select of [offer,pin]){const f=fixture();Object.assign(select(f),change);assert.equal(target(f).length,0,JSON.stringify(change));}}
 const q={...offer(fixture()),source_observed_at:iso(NOW-89000),provider_received_at:iso(NOW-1)};assert.equal(deadline(q,false,NOW),NOW+1000);assert.equal(deadline({...q,source_observed_at:iso(NOW-90001)},false,NOW),null);
});
test('live prices require healthy stream, phase-appropriate start and expire at fifteen seconds; started/final pregame prices disappear',()=>{
 const f=fixture({live:true});assert.equal(target(f).length,1);assert.equal(target(f,'mlb',NOW+14000).length,0);for(const status of [{}, {streamHealthy:false}])assert.equal(target({...f,status}).length,0);
 const future=copy(f);future.events[0].start=iso(NOW+1);assert.equal(target(future).length,0);
 for(const more of [{final:true},{state:'post'},{state:'in'},{start:iso(NOW)}]){const pre=fixture();Object.assign(pre.events[0],more);assert.equal(target(pre).length,0);}
});
test('least optimistic independent sharp reference is used and stale dissent never silently forms a crossed pair',()=>{
 const f=fixture();f.events[0].books.circa=copy(f.events[0].books.pin);for(const q of Object.values(f.events[0].books.circa.integrityMeta.ml))q.pair_id='circa:ml';f.events[0].books.circa.integrityMeta.ml.home.american_odds=-105;f.events[0].books.circa.integrityMeta.ml.away.american_odds=-115;
 const row=target(f)[0],less=fairPair(-105,-115)[0];assert.equal(row.references.length,2);assert.ok(Math.abs(row.probability-less)<1e-12);assert.ok(row.evPct<5);
 offer(f).american_odds=250;assert.equal(target(f).length,0); // implausible gap is quarantined, never promoted.
});
test('book/provider mismatched handoff cannot be actioned and raw ref is absent from public snapshot',()=>{
 let clock=NOW;const s=new OpportunityService({now:()=>clock});try{const f=fixture();offer(f).bet_link.book='czr';s.update('sharp','mlb',f);const row=s.snapshot().rows[0];assert.equal(row.handoff,false);assert.equal('link'in row,false);assert.equal(s.validate(row.id,row.version).status,422);offer(f).bet_link={provider:'owls',book:'mgm',url:'https://sports.nv.betmgm.com/en/sports/events/1'};s.update('sharp','mlb',f);assert.equal(s.snapshot().rows[0].handoff,false);}finally{s.close();}
});
test('revalidation rejects price/reference/selection/identity changes and expiry while unchanged timestamps can refresh',()=>{
 let clock=NOW;const s=new OpportunityService({now:()=>clock});try{
  for(const mutate of [f=>offer(f).american_odds=120,f=>pin(f).american_odds=-115,f=>offer(f).bet_link.id='999',f=>f.events[0].home='Another Team',f=>f.events[0].start=iso(NOW+7200000)]){const f=fixture();s.update('sharp','mlb',f);const old=s.snapshot().rows[0];mutate(f);s.update('sharp','mlb',f);assert.equal(s.validate(old.id,old.version).status,409);}
  const f=fixture();s.update('sharp','mlb',f);const old=s.snapshot().rows[0];clock+=90000;assert.equal(s.validate(old.id,old.version).status,410);assert.equal(s.snapshot().rows.length,0);
 }finally{s.close();}
});
test('causal traces never use another sport receipt, expiry/status events have no trace, and empty service is truthful',()=>{
 let clock=NOW;const s=new OpportunityService({now:()=>clock});try{assert.deepEqual(s.snapshot().rows,[]);assert.equal(s.snapshot().trace,null);s.update('sharp','mlb',fixture());const first=s.snapshot();assert.equal(first.trace.sport,'mlb');assert.equal(first.trace.receivedAt,NOW);assert.equal(first.trace.clockKind,'OPPORTUNITY_ENGINE_RECEIPT');clock+=5;s.update('sharp','nhl',{events:[],receivedAt:clock});assert.deepEqual(s.snapshot().trace,first.trace);
  clock+=90000;s.rebuild();assert.equal(s.snapshot().trace,null);assert.equal(s.snapshot().receivedAt,null);
  const live=fixture({live:true});clock=NOW;s.update('sharp','mlb',live);assert.ok(s.snapshot().trace);s.status('sharp',{streamHealthy:false});assert.equal(s.snapshot().rows.length,0);assert.equal(s.snapshot().trace,null);
 }finally{s.close();}
});
test('expiry checks and unrelated sport updates do not rescan untouched provider event arrays',()=>{
 let reads=0;const f=fixture(),events=f.events;Object.defineProperty(f,'events',{get(){reads++;return events;}});const s=new OpportunityService({now:()=>NOW});try{s.update('sharp','mlb',f);const atUpdate=reads;s.rebuild();s.snapshot();const row=s.snapshot().rows[0];s.validate(row.id,row.version);s.update('sharp','nhl',fixture({sport:'nhl'}));assert.equal(reads,atUpdate);assert.equal(s.snapshot().rows.length,2);}finally{s.close();}
});
test('public opportunity snapshots are bounded and malformed empty frames are harmless',()=>{const s=new OpportunityService({now:()=>NOW});try{const f=fixture(),event=f.events[0];f.events=Array.from({length:430},(_,i)=>({...copy(event),id:'event-'+i}));s.update('sharp','mlb',f);assert.equal(s.snapshot().rows.length,400);s.update('sharp','mlb',null);assert.equal(s.snapshot().rows.length,0);assert.deepEqual(scan('sharp','mlb',{events:[null,{}]},NOW),[]);}finally{s.close();}});
test('identical side IDs and mismatched event IDs cannot be treated as a complete exact market',()=>{for(const mutate of [f=>offer(f,false,'ml','away').provider_quote_id=offer(f).provider_quote_id,f=>{pin(f).provider_event_id='one';pin(f,false,'ml','away').provider_event_id='another';}]){const f=fixture();mutate(f);assert.equal(target(f).length,0);}const f=fixture();offer(f).bet_link.id='999';const row=target(f)[0];assert.equal(row.handoff,false);assert.equal(row.link,null);});
test('clock-only renewal retains version while refreshed deadline and trace are published',()=>{let now=NOW;const s=new OpportunityService({now:()=>now});try{const f=fixture();s.update('sharp','mlb',f);const first=s.snapshot();now+=1000;for(const L of Object.values(f.events[0].books))for(const q of Object.values(L.integrityMeta.ml)){q.provider_received_at=iso(now);q.pair_id+=':new-clock';}s.update('sharp','mlb',f);const second=s.snapshot();assert.equal(second.rows[0].version,first.rows[0].version);assert.ok(second.rows[0].expiresAt>first.rows[0].expiresAt);assert.notEqual(second.trace.id,first.trace.id);assert.ok(s.validate(first.rows[0].id,first.rows[0].version).row);}finally{s.close();}});
test('Owls event links remain visible references but never promise exact outcome execution',()=>{const f=fixture();for(const L of Object.values(f.events[0].books))for(const q of Object.values(L.integrityMeta.ml)){q.source_observed_at=q.provider_received_at;delete q.provider_received_at;q.bet_link={provider:'owls',book:'mgm',url:'https://sports.nv.betmgm.com/en/sports/events/123'};}const rows=scan('owls','mlb',f,NOW).filter(x=>x.book==='mgm');assert.equal(rows.length,1);assert.equal(rows[0].clockKind,'SOURCE_OBSERVATION');assert.equal(rows[0].handoff,false);});
test('unchanged quote rows preserve their receipt metadata when another event in that sport changes',()=>{let now=NOW;const s=new OpportunityService({now:()=>now});try{const f=fixture();f.events.push({...copy(f.events[0]),id:'second'});s.update('sharp','mlb',f);const before=new Map(s.snapshot().rows.map(r=>[r.eventId,r]));now+=200;f.receivedAt=now;offer(f).american_odds=115;s.update('sharp','mlb',f);const after=new Map(s.snapshot().rows.map(r=>[r.eventId,r]));assert.equal(after.get('second').receivedAt,before.get('second').receivedAt);assert.equal(after.get('mlb:event').receivedAt,now);assert.equal(s.snapshot().trace.receivedAt,now);}finally{s.close();}});
test('deterministic fair-pair cache is bounded and immutable so repeated references cannot corrupt other opportunities',()=>{const a=-117.123456,b=-108.654321,first=fairPair(a,b);assert.equal(fairPair(a,b),first);assert.equal(Object.isFrozen(first),true);assert.throws(()=>{first[0]=1;},TypeError);for(let i=0;i<2200;i++)assert.ok(fairPair(-110-i/10000,-109));const refitted=fairPair(a,b);assert.notEqual(refitted,first);assert.deepEqual(refitted,first);assert.equal(fairPair(String(a),b),null);});


test('unsupported exchange and contract books cannot qualify across providers, phases and markets',()=>{
 const excluded=['novig','prophetx','betfair','betfair_lay','matchbook','smarkets','sx_bet','polymarket','kalshi','robinhood','fanatics_markets','gemini'];
 for(const live of [false,true])for(const provider of ['sharp','owls'])for(const market of ['ml','s','t']){
  const frame=fixture({live,market}),books=frame.events[0][live?'live':'books'];
  for(const book of [...excluded,'fd','fanatics']){
   books[book]=copy(books.mgm);
   for(const q of Object.values(books[book].integrityMeta[market])){
    q.pair_id=book+':'+market;q.max_bet=1000;
    // Complete, current pairs and an exact selection link cannot bypass execution policy.
    q.bet_link={provider:'sharp',book,id:q.provider_quote_id};
   }
  }
  const before=copy(frame),service=new OpportunityService({now:()=>NOW});
  try{
   service.update(provider,'mlb',frame);
   const rows=service.snapshot().rows,context=`${provider} ${live?'live':'pregame'} ${market}`;
   for(const book of ['mgm','fd','fanatics'])assert.ok(rows.some(r=>r.book===book&&r.eligible===true),`${context} ${book} remains eligible`);
   for(const book of excluded)assert.equal(rows.some(r=>r.book===book),false,`${context} ${book} is absent from qualified rows/alerts`);
   assert.deepEqual(frame,before,'scanner quarantine must not remove or mutate raw board quotes');
  }finally{service.close();}
 }
});
test('both sides of the same number at different books are marked two-way, with what taking both returns',()=>{
 for(const market of ['ml','s','t']){
  const f=fixture({market}),sides=market==='t'?['over','under']:['home','away'],B=f.events[0].books,m=B.mgm.integrityMeta[market];
  B.dk={integrityMeta:{[market]:{[sides[0]]:{...copy(m[sides[0]]),pair_id:'dk:'+market,american_odds:-130,provider_quote_id:'201',bet_link:null},[sides[1]]:{...copy(m[sides[1]]),pair_id:'dk:'+market,american_odds:110,provider_quote_id:'202',bet_link:null}}}};
  const rows=scan('sharp','mlb',f,NOW),a=rows.find(r=>r.book==='mgm'&&r.side===sides[0]),b=rows.find(r=>r.book==='dk'&&r.side===sides[1]);
  assert.ok(a&&b,market);assert.equal(a.twoWay.id,b.id);assert.equal(b.twoWay.id,a.id);assert.equal(a.twoWay.book,'dk');
  assert.ok(Math.abs(a.twoWay.bothPct-(100/(2/2.1)-100))<1e-9,'+110 both sides returns 5% either way');
  // one side alone: no two-way mark
  delete B.dk;assert.equal(scan('sharp','mlb',f,NOW).find(r=>r.book==='mgm').twoWay,undefined);
 }
});
