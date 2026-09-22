'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createSharpFeed} = require('../shared/sharp-feed');
const {subscribe,relayToChild} = require('../shared/sharp-consumer');
const NOW=1800000000000;
const row=(id,odds=-110,more={})=>({id,league:'nfl',sportsbook:'pinnacle',market_type:'moneyline',is_main_line:true,is_alternate_line:false,odds_american:odds,is_live:false,...more});
const response=(data=[],more={},status=200,headers={})=>({ok:status===200,status,headers:{get:k=>headers[k]??null},json:async()=>({data,pagination:{has_more:false},updated_at:new Date(NOW).toISOString(),...more})});
const settle=async()=>{for(let i=0;i<150;i++)await Promise.resolve();};
function harness(fetch=async()=>response()){
  let clock=NOW,num=0;const sockets=[],urls=[],timers=new Map(),frames=[],calls=[];
  const feed=createSharpFeed({apiKey:'test-secret',now:()=>clock,normalizeBoard:(p,s)=>p.data.filter(r=>r.league===s),
    wsFactory:(url,options)=>{urls.push(url);const ws=new EventEmitter();ws.options=options;ws.readyState=1;ws.send=x=>(ws.sent||=[]).push(JSON.parse(x));ws.terminate=()=>{ws.terminated=true;ws.readyState=3;};sockets.push(ws);return ws;},
    fetchImpl:async(...args)=>{calls.push(args);return fetch(...args);},onUpdate:(sport,frame)=>frames.push({sport,...frame}),
    setTimeout:(fn,ms)=>{const id=++num;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
  const emit=(message,which=sockets.at(-1))=>which.emit('message',JSON.stringify(message));
  const run=ms=>{const entry=[...timers].find(([,t])=>t.ms===ms);assert.ok(entry,`timer ${ms}`);timers.delete(entry[0]);entry[1].fn();};
  return {feed,sockets,urls,timers,frames,calls,emit,run,tick:ms=>{clock+=ms},begin(data=[row('a')],seq='9007199254740993'){feed.start();emit({type:'connected',global_seq:seq,books:{max:25,allowed:['pinnacle']},filter_hash:'scope',features:{client_resync:true}});emit({type:'initial',data});emit({type:'snapshot:complete',total_odds:data.length});}};
}
test('one key-owned native socket, all allowed books and leagues, WS bootstrap before REST',t=>{
 const h=harness();t.after(()=>h.feed.stop());h.begin();assert.equal(h.sockets.length,1);assert.equal(h.calls.length,0);
 const u=new URL(h.urls[0]);assert.equal(u.searchParams.get('league'),'nfl,ncaaf,mlb');assert.equal(u.searchParams.has('sportsbook'),false);assert.equal(u.searchParams.get('channels'),'odds');
 assert.equal(h.feed.status().connection,'streaming');assert.equal(JSON.stringify(h.feed.status()).includes('test-secret'),false);assert.equal(h.feed.snapshot('nfl').events.length,1);
});
test('initial chunks atomically replace prior snapshot only at completion',t=>{
 const h=harness();t.after(()=>h.feed.stop());h.begin();h.sockets[0].emit('close',1006);h.run(1000);
 h.emit({type:'connected',global_seq:'10000',resumed:false});h.emit({type:'initial',book:'pinnacle',data:[row('b')]});h.emit({type:'initial',book:'pinnacle',data:[row('c')]});assert.deepEqual(h.feed.snapshot('nfl').events.map(r=>r.id),['a']);
 h.emit({type:'snapshot:complete',total_odds:2});assert.deepEqual(h.feed.snapshot('nfl').events.map(r=>r.id),['b','c']);
});
test('sparse changes coalesce in25ms, line moves replace id, locks and removals clear active rows',t=>{
 const h=harness();t.after(()=>h.feed.stop());h.begin([row('a'),row('b')]);
 h.emit({type:'odds:update',global_seq:'10000',data:[row('a',120,{line:3})]});h.emit({type:'odds:locked',global_seq:'10001',data:[row('b')]});h.run(25);
 assert.equal(h.feed.snapshot('nfl').events.length,2);assert.equal(h.feed.snapshot('nfl').events.find(r=>r.id==='a').odds_american,120);assert.equal(h.feed.snapshot('nfl').events.find(r=>r.id==='b').is_active,false);
 h.emit({type:'odds:removed',global_seq:'10002',ids:['a']});h.run(25);assert.deepEqual(h.feed.snapshot('nfl').events.map(r=>r.id),['b']);
});
test('cross-book global sequence reordering is not a gap; same-id old replay cannot resurrect removal',t=>{
 const h=harness();t.after(()=>h.feed.stop());h.begin();
 h.emit({type:'odds:update',global_seq:'101',data:[row('b')]});h.emit({type:'odds:update',global_seq:'100',data:[row('c')]});h.emit({type:'odds:removed',global_seq:'103',ids:['a']});h.emit({type:'odds:update',global_seq:'102',data:[row('a')]});h.run(25);
 assert.deepEqual(h.feed.snapshot('nfl').events.map(r=>r.id),['b','c']);assert.equal(h.feed.status().resyncs,0);
});
test('resume cursor comes only from completed server receipts and preserves unsafe-size strings',t=>{
 const h=harness();t.after(()=>h.feed.stop());h.begin();h.emit({type:'odds:update',global_seq:'99999999999999999',data:[row('a',125)]});h.emit({type:'heartbeat',global_seq:'999999999999999999'});
 h.sockets[0].emit('close',1006);h.run(1000);assert.equal(new URL(h.urls[1]).searchParams.get('from_seq'),'9007199254740993');
 h.emit({type:'connected',global_seq:'999999999999999999',resumed:true,filter_hash:'scope'});h.emit({type:'odds:update',global_seq:'99999999999999998',data:[row('a',100)],replay:true});
 h.emit({type:'snapshot:complete',mode:'resume',gap_detected:false,last_seq:'99999999999999999'});assert.equal(h.feed.snapshot('nfl').events[0].odds_american,125);
 h.sockets[1].emit('close',1006);h.run(1000);assert.equal(new URL(h.urls[2]).searchParams.get('from_seq'),'99999999999999999');
});
test('gap reports and incomplete initial row counts demand fresh baseline',t=>{
 const h=harness();t.after(()=>h.feed.stop());h.begin();h.emit({type:'resync_required',dropped:4});h.run(1000);assert.equal(new URL(h.urls[1]).searchParams.has('from_seq'),false);
 h.emit({type:'connected',global_seq:'1000'});h.emit({type:'initial',data:[row('b')]});h.emit({type:'snapshot:complete',total_odds:2});assert.equal(h.feed.status().resyncs,2);assert.deepEqual(h.feed.snapshot('nfl').events.map(r=>r.id),['a']);
});
test('demoting a main line evicts its prior displayed price',t=>{
 const h=harness();t.after(()=>h.feed.stop());h.begin();h.emit({type:'odds:update',global_seq:'100',data:[row('a',120,{is_main_line:false,is_alternate_line:true})]});h.run(25);assert.deepEqual(h.feed.snapshot('nfl').events,[]);
});
test('socket displacement stops reconnecting and keeps REST fallback possible',async t=>{
 const h=harness();t.after(()=>h.feed.stop());h.begin();h.sockets[0].emit('close',4001,Buffer.from('displaced by newer session'));assert.equal(h.feed.status().lastError,'stream_displaced');assert.equal([...h.timers.values()].some(x=>x.ms===1000),false);h.run(0);await settle();assert.equal(h.calls.length,2);
});
test('watchdog uses advertised heartbeat/pong budget and does not reconnect quiet heartbeats',t=>{
 const h=harness();t.after(()=>h.feed.stop());h.begin();h.tick(75000);h.emit({type:'heartbeat',global_seq:'9007199254740993'});h.run(25000);assert.equal(h.sockets[0].terminated,undefined);
 h.tick(90000);h.run(25000);assert.equal(h.sockets[0].terminated,true);assert.equal(h.feed.status().streamHealthy,false);
});
test('REST fallback cursor pagination never publishes partial pages and covers live plus pregame',async t=>{
 let resolve;const later=new Promise(r=>resolve=r);const h=harness(async url=>{const u=new URL(url);if(u.searchParams.get('is_live')==='true')return response([row('live',110,{is_live:true})]);if(!u.searchParams.has('cursor'))return response([row('a')],{pagination:{has_more:true,next_cursor:'opaque'}});return later;});t.after(()=>h.feed.stop());h.feed.start();h.run(20000);await settle();assert.equal(h.feed.snapshot('nfl').events.length,0);resolve(response([row('b')]));await settle();
 assert.deepEqual(h.feed.snapshot('nfl').events.map(r=>r.id).sort(),['a','b','live']);assert.equal(h.calls.length,3);assert.ok(h.calls.every(([,p])=>p.headers['X-API-Key']==='test-secret'&&p.redirect==='error'));
});
test('REST cannot resurrect a row omitted by a newer authoritative WS snapshot',async t=>{
 let resolve;const pending=new Promise(r=>resolve=r);const h=harness(()=>pending);t.after(()=>h.feed.stop());h.feed.start();h.run(20000);await settle();h.emit({type:'connected',global_seq:'100'});h.emit({type:'initial',data:[]});h.emit({type:'snapshot:complete',total_odds:0});resolve(response([row('old')]));await settle();assert.deepEqual(h.feed.snapshot('nfl').events,[]);assert.equal(h.feed.status().connection,'streaming');
});
test('warming and broken cursor pages preserve baseline, never accept incomplete missing rows',async t=>{
 const h=harness(async()=>response([],{meta:{store:{reason:'warming'}}}));t.after(()=>h.feed.stop());h.begin();h.sockets[0].emit('close',4001);h.run(0);await settle();assert.deepEqual(h.feed.snapshot('nfl').events.map(r=>r.id),['a']);assert.equal(h.feed.status().lastError,'rest_store_warming');
});
test('REST delta retains fixed since through pagination, advances only terminal receipt, applies removals',async t=>{
 const since=new Date(NOW).toISOString(),end=new Date(NOW+4000).toISOString();const h=harness(async url=>{const u=new URL(url);if(u.pathname.endsWith('/odds'))return response(u.searchParams.get('is_live')==='false'?[row('a')]:[]);
 if(u.searchParams.get('is_live')==='true')return response([],{meta:{server_time:end}});
 if(u.searchParams.get('offset')==='0')return response([row('b')],{pagination:{has_more:true,next_offset:500},meta:{server_time:since}});
 return response([],{removed:[{id:'a'}],meta:{server_time:end}});});t.after(()=>h.feed.stop());h.feed.start();h.run(20000);await settle();h.tick(5000);h.run(5000);await settle();assert.deepEqual(h.feed.snapshot('nfl').events.map(r=>r.id),['b']);
 const delta=h.calls.map(([u])=>new URL(u)).filter(u=>u.pathname.endsWith('/delta'));assert.equal(delta.length,3);assert.ok(delta.every(u=>u.searchParams.get('since')===since));assert.ok(delta.every(u=>!u.searchParams.has('is_main_line')));
});
test('429 honors global retry delay, credential-bearing provider errors stay private',async t=>{
 const h=harness(async()=>response([],{},429,{'retry-after':'60'}));t.after(()=>h.feed.stop());h.feed.start();h.run(20000);await settle();assert.ok([...h.timers.values()].some(x=>x.ms===60000));assert.equal(h.feed.status().lastError,'rest_http_429');assert.equal(JSON.stringify(h.feed.status()).includes('test-secret'),false);
});
test('IPC is credential-free and coalesces slow child snapshots, child resubscribe replays latest',()=>{
 const peer=new EventEmitter();peer.env={SHARP_FEED_IPC:'1'};peer.connected=true;const sent=[],pending=[];peer.send=(m,cb)=>{sent.push(m);pending.push(cb);};let frame={events:[row('a')],receivedAt:'stamp',status:{enabled:true}};
 const feed={snapshot:()=>frame};const relay=relayToChild(peer,'nfl',feed);peer.emit('message',{type:'sharp:ready',sport:'nfl'});relay.update({...frame,events:[row('b')]});relay.update({...frame,events:[row('c')]});assert.equal(sent.length,1);pending.shift()();assert.equal(sent[1].events[0].id,'c');relay.close();
 const processPeer=new EventEmitter();processPeer.env={SHARP_FEED_IPC:'1'};processPeer.send=()=>{};const got=[];const sub=subscribe('nfl',f=>got.push(f),processPeer);processPeer.emit('message',{type:'sharp:update',sport:'nfl',...frame});assert.equal(got[0].events[0].id,'a');sub.close();
});
for(const flag of ['since_clamped','removed_truncated','overflow'])test(`REST ${flag} cannot advance an incomplete window`,async t=>{
 let snapshots=0;const h=harness(async url=>{if(new URL(url).pathname.endsWith('/odds')){snapshots++;return response([row('a')]);}return response([row('bad')],{[flag]:true});});t.after(()=>h.feed.stop());h.feed.start();h.run(20000);await settle();h.tick(5000);h.run(5000);await settle();assert.equal(h.feed.status().lastError,'rest_rebaseline');assert.deepEqual(h.feed.snapshot('nfl').events.map(r=>r.id),['a']);h.tick(10000);h.run(10000);await settle();assert.equal(snapshots,4);
});
test('REST overflowing intermediate page still drains valid offset before committing terminal watermark',async t=>{
 const h=harness(async url=>{const u=new URL(url);if(u.pathname.endsWith('/odds'))return response([row('a')]);if(u.searchParams.get('offset')==='0')return response([row('b')],{overflow:true,pagination:{has_more:true,next_offset:500}});return response([],{removed:[{id:'a'}],overflow:false});});t.after(()=>h.feed.stop());h.feed.start();h.run(20000);await settle();h.tick(5000);h.run(5000);await settle();assert.deepEqual(h.feed.snapshot('nfl').events.map(r=>r.id),['b']);assert.equal(h.feed.status().lastError,null);
});
test('public receipts use numeric engine contract and disclose delivery-only latency with per-sport coverage',t=>{
 const h=harness();t.after(()=>h.feed.stop());h.begin([row('a'),row('b',110,{league:'mlb',sportsbook:'draftkings'})]);h.emit({type:'odds:update',source:'pinnacle',timestamp:new Date(NOW-130).toISOString(),global_seq:'100',data:[row('a',125)]});h.run(25);const status=h.feed.status();assert.equal(h.feed.snapshot('nfl').receivedAt,NOW);assert.equal(status.lastReceivedAt,NOW);assert.equal(status.transportLatencyMs,130);assert.equal(status.latencyKind,'PROVIDER_DELIVERY');assert.deepEqual(status.books.nfl,['pinnacle']);assert.deepEqual(status.books.mlb,['draftkings']);
});
test('failed REST phase waits for the other request to drain before scheduling another crawl',async t=>{
 let resolve;const pending=new Promise(r=>resolve=r);const h=harness(async url=>new URL(url).searchParams.get('is_live')==='true'?response([],{},503):pending);t.after(()=>h.feed.stop());h.feed.start();h.run(20000);await settle();assert.equal([...h.timers.values()].some(timer=>timer.ms===10000),false);resolve(response());await settle();assert.ok([...h.timers.values()].some(timer=>timer.ms===10000));
});
