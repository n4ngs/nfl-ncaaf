'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createOwlsFeed } = require('../shared/owls-feed');
const { subscribe, relayToChild } = require('../shared/owls-consumer');
const now = 1800000000000;
const event = (id, price = -110, book = 'pinnacle') => ({ id, home_team: 'Home', away_team: 'Away', commence_time: '2027-01-01T00:00:00Z', bookmakers: [{key: book, markets: [{key: 'h2h',outcomes:[{name:'Home',price}]}]}] });
const response = (data, status = 200, headers = {}) => ({ok: status === 200,status,headers:{get:k => headers[k] ?? null},json: async () => data});
const settle = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
function harness(fetchImpl = async () => response({success:true,data:{}})) {
  const socket = new EventEmitter(); const calls = [], frames = [], timers = new Map(); let num = 0, clock = now;
  socket.connect = () => { socket.connects = (socket.connects || 0) + 1; };
  socket.disconnect = () => { socket.disconnects = (socket.disconnects || 0) + 1; };
  const feed = createOwlsFeed({apiKey:'private-test-key',now:()=>clock,
    ioFactory:(url,opts)=>{socket.options=opts; return socket;},
    normalizeBoard:(payload,sport)=>payload.sports[sport],
    fetchImpl:async (...args)=>{calls.push(args);return fetchImpl(...args);},
    onUpdate:(sport,frame)=>frames.push({sport,...frame}),
    setTimeout:(fn,ms)=>{const id=++num;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
  return {feed,socket,calls,frames,timers,tick:ms=>{clock+=ms}};
}
test('one socket subscribes all sports, all books and exposes no credential in public status',async t=>{
  const h=harness();t.after(()=>h.feed.stop());h.feed.start();h.socket.emit('connect');await settle();
  assert.equal(h.socket.connects,1);assert.equal(h.socket.options.transports[0],'websocket');
  assert.equal(h.calls.length,12);assert.equal(h.calls[0][1].headers.Authorization,'Bearer private-test-key');
  assert.equal(h.calls[0][1].redirect,'error');assert.equal(JSON.stringify(h.feed.status()).includes('private-test-key'),false);
  assert.equal(h.feed.status().connection,'streaming');
});
test('REST fallback bootstraps every sport and sharp channel with bounded cadence',async t=>{
  const h=harness();t.after(()=>h.feed.stop());h.feed.start();await settle();
  assert.equal(h.calls.length,12);assert.ok([...h.timers.values()].some(x=>x.ms===60000));
  h.tick(60000);[...h.timers.values()].find(x=>x.ms===60000).fn();await settle();
  assert.equal(h.calls.length,16);assert.ok(h.calls.slice(12).every(([url])=>url.endsWith('/odds')));
});
test('Pinnacle sparse frames merge events, exact final events evict, PS snapshots replace',async t=>{
  const h=harness();t.after(()=>h.feed.stop());h.feed.start();await settle();
  h.socket.emit('pinnacle-realtime',{nfl:[event('a'),event('b')],timestamp:new Date(now-50).toISOString()});
  h.socket.emit('pinnacle-realtime',{nfl:[event('a',-120)]});
  assert.equal(h.feed.snapshot('nfl').events.length,2);
  assert.equal(h.feed.snapshot('nfl').events.find(e=>e.id==='a').bookmakers[0].markets[0].outcomes[0].price,-120);
  h.socket.emit('pinnacle-realtime',{nfl:[{id:'a',status:'final'}]});
  assert.deepEqual(h.feed.snapshot('nfl').events.map(e=>e.id),['b']);
  h.socket.emit('ps3838-realtime',{nfl:[event('c'),event('d')],snapshot:true});
  h.socket.emit('ps3838-realtime',{nfl:[event('c',-115)],delta:true});
  assert.equal(h.feed.snapshot('nfl').events.length,3);
  h.socket.emit('ps3838-realtime',{nfl:[],snapshot:true});
  assert.deepEqual(h.feed.snapshot('nfl').events.map(e=>e.id),['b']);
});
test('v1 snapshot omissions clear old books and absent sports are unchanged',async t=>{
  const h=harness();t.after(()=>h.feed.stop());h.feed.start();await settle();
  h.socket.emit('odds-update',{sports:{nfl:[event('x',-110,'fanduel')],mlb:[event('m')]}});
  h.socket.emit('odds-update',{sports:{nfl:[]}});
  assert.equal(h.feed.snapshot('nfl').events.length,0);assert.equal(h.feed.snapshot('mlb').events.length,1);
});
test('late REST reconciles missing events while preserving newer sparse Pinnacle events',async t=>{
  let release;const h=harness(url=>url.endsWith('/nfl/realtime')?new Promise(r=>release=r):Promise.resolve(response({success:true,data:{}})));
  t.after(()=>h.feed.stop());h.feed.start();await settle();
  h.socket.emit('pinnacle-realtime',{nfl:[event('a',-150)]});
  release(response({success:true,data:[event('a',-110),event('b')]}));await settle();
  const events=h.feed.snapshot('nfl').events;
  assert.equal(events.length,2);assert.equal(events.find(e=>e.id==='a').bookmakers[0].markets[0].outcomes[0].price,-150);
});
test('rate limit blocks the remaining sport requests globally and respects retry delay',async t=>{
  const h=harness(async()=>response({},429,{'retry-after':'120'}));t.after(()=>h.feed.stop());h.feed.start();await settle();
  assert.equal(h.calls.length,4);assert.equal(h.feed.status().retryAt,now+120000);
  assert.ok([...h.timers.values()].some(x=>x.ms===120000));
});
test('REST authentication failure stops repeated authenticated requests',async t=>{
  const h=harness(async()=>response({},401));t.after(()=>h.feed.stop());h.feed.start();await settle();
  assert.equal(h.calls.length,4);assert.equal(h.feed.status().connection,'unauthorized');
  [...h.timers.values()].find(x=>x.ms===300000).fn();await settle();assert.equal(h.calls.length,4);
});
test('missing WebSocket entitlement disconnects and retries at five minutes, without leaking errors',async t=>{
  const h=harness();t.after(()=>h.feed.stop());h.feed.start();await settle();
  h.socket.emit('connect_error',new Error('WebSocket requires the Hall of Fame plan or a WebSocket add-on. private-test-key'));
  assert.equal(h.socket.disconnects,1);assert.equal(h.feed.status().connection,'polling');
  const retry=[...h.timers.values()].find(x=>x.ms===300000);assert.ok(retry);retry.fn();assert.equal(h.socket.connects,2);
  assert.equal(JSON.stringify(h.feed.status()).includes('private-test-key'),false);
});
test('stream delivery is immediate and measures frame time separately from receive time',async t=>{
  const h=harness();t.after(()=>h.feed.stop());h.feed.start();await settle();
  h.socket.emit('odds-update',{timestamp:new Date(now-75).toISOString(),sports:{nfl:[event('a')]}});
  assert.equal(h.frames.at(-1).receivedAt,now);assert.equal(h.feed.status().transportLatencyMs,75);
  assert.equal(h.feed.status().providerFrameAt,now-75);assert.equal(h.feed.status().frameCounts.odds,1);
});
test('child consumer asks for replay and handles empty authoritative board without upstream access',()=>{
  const peer=new EventEmitter(),sent=[],seen=[];peer.env={OWLS_FEED_IPC:'1'};peer.send=m=>sent.push(m);
  const c=subscribe('nfl',f=>seen.push(f),peer);assert.deepEqual(sent,[{type:'owls:ready',sport:'nfl'}]);
  peer.emit('message',{type:'owls:update',sport:'mlb',events:[event('x')]});assert.equal(seen.length,0);
  peer.emit('message',{type:'owls:update',sport:'nfl',events:[],receivedAt:now,status:{connected:true}});
  assert.equal(seen.length,1);assert.equal(c.status().connected,true);c.close();assert.equal(peer.listenerCount('message'),0);
});
test('child relay bounds backpressure to latest frame and replays on restart',()=>{
  const child=new EventEmitter(),sent=[],callbacks=[];child.connected=true;child.send=(m,cb)=>{sent.push(m);callbacks.push(cb)};
  const relay=relayToChild(child,'nfl',{snapshot:()=>({events:[event('replay')],receivedAt:now})});
  child.emit('message',{type:'owls:ready',sport:'nfl'});relay.update({events:[event('old')]});relay.update({events:[event('latest')]});
  assert.equal(sent.length,1);callbacks.shift()();assert.equal(sent.length,2);assert.equal(sent[1].events[0].id,'latest');
  callbacks.shift()();relay.close();assert.equal(child.listenerCount('message'),0);
});

test('coarse stale and unavailable book flags survive the merged normalization envelope',async t=>{
  const h=harness();t.after(()=>h.feed.stop());h.feed.start();await settle();
  h.socket.emit('odds-update',{sports:{nfl:[event('a')]},bookStatus:{pinnacle:{available:false,stale:true}}});
  const book=h.feed.snapshot('nfl').events[0].bookmakers[0];assert.equal(book.available,false);assert.equal(book.stale,true);
});
test('silent connected stream falls back without a second socket and resumes on valid frames',async t=>{
  const h=harness();t.after(()=>h.feed.stop());h.feed.start();h.socket.emit('connect');
  h.socket.emit('odds-update',{sports:{nfl:[]},timestamp:new Date(now).toISOString()});await settle();
  assert.equal(h.feed.status().streamHealthy,true);assert.equal(h.calls.length,12);
  h.tick(61000);[...h.timers.values()].find(x=>x.ms===15000).fn();await settle();
  assert.equal(h.feed.status().connected,true);assert.equal(h.feed.status().streamHealthy,false);
  assert.equal(h.feed.status().connection,'polling');assert.equal(h.socket.connects,1);
  assert.equal(h.calls.length,16);assert.ok(h.calls.slice(12).every(([url])=>url.endsWith('/odds')));
  h.socket.emit('odds-update',{timestamp:new Date(now+61000).toISOString()});
  assert.equal(h.feed.status().streamHealthy,false);
  h.socket.emit('odds-update',{sports:{nfl:[]},timestamp:new Date(now+61000).toISOString()});
  assert.equal(h.feed.status().streamHealthy,true);assert.equal(h.feed.status().connection,'streaming');
});


test('late REST cannot resurrect an event omitted by a newer empty full WS board',async t=>{
  let hold=false,release;const h=harness(url=>url.endsWith('/nfl/odds')&&hold?new Promise(r=>release=r):Promise.resolve(response({success:true,data:{}})));
  t.after(()=>h.feed.stop());h.feed.start();await settle();
  h.socket.emit('odds-update',{sports:{nfl:[event('a')]}});
  hold=true;h.tick(60000);[...h.timers.values()].find(x=>x.ms===60000).fn();await settle();
  h.socket.emit('odds-update',{sports:{nfl:[]}});
  release(response({success:true,data:{pinnacle:[event('a')]}}));await settle();
  assert.deepEqual(h.feed.snapshot('nfl').events,[]);
});

test('newer folded WS board defeats stale split-book REST rows and removed books',async t=>{
  let release;const h=harness(url=>url.endsWith('/nfl/odds')?new Promise(r=>release=r):Promise.resolve(response({success:true,data:{}})));
  t.after(()=>h.feed.stop());h.feed.start();
  const current=event('folded',-150);current.bookmakers.push(event('unused',-125,'fanduel').bookmakers[0]);
  h.socket.emit('odds-update',{sports:{nfl:[current]}});
  const pin=event('native-pin',-110),fd=event('native-fd',-105,'fanduel'),removed=event('native-dk',-105,'draftkings');
  release(response({success:true,data:{pinnacle:[pin],fanduel:[fd],draftkings:[removed]}}));await settle();
  const rows=h.feed.snapshot('nfl').events;
  assert.equal(rows.length,1);assert.equal(rows[0].id,'folded');
  assert.deepEqual(rows[0].bookmakers.map(b=>b.key),['pinnacle','fanduel']);
  assert.equal(rows[0].bookmakers[0].markets[0].outcomes[0].price,-150);
});

test('PS3838 full snapshot omission stays authoritative over an older REST request',async t=>{
  let release;const h=harness(url=>url.endsWith('/nfl/ps3838-realtime')?new Promise(r=>release=r):Promise.resolve(response({success:true,data:{}})));
  t.after(()=>h.feed.stop());h.feed.start();await settle();
  h.socket.emit('ps3838-realtime',{nfl:[event('a')],delta:true});
  h.socket.emit('ps3838-realtime',{nfl:[],snapshot:true});
  release(response({success:true,data:[event('a')]}));await settle();
  assert.deepEqual(h.feed.snapshot('nfl').events,[]);
});

test('sparse final-event tombstone survives late REST while untouched events bootstrap',async t=>{
  let release;const h=harness(url=>url.endsWith('/nfl/realtime')?new Promise(r=>release=r):Promise.resolve(response({success:true,data:{}})));
  t.after(()=>h.feed.stop());h.feed.start();await settle();
  h.socket.emit('pinnacle-realtime',{nfl:[event('a')]});
  h.socket.emit('pinnacle-realtime',{nfl:[{id:'a',status:'final'}]});
  release(response({success:true,data:[event('a'),event('b')]}));await settle();
  assert.deepEqual(h.feed.snapshot('nfl').events.map(e=>e.id),['b']);
});
