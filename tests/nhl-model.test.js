'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Inputs=require('../nhl/lib/model-inputs'),Model=require('../nhl/lib/model'),State=require('../nhl/lib/model-state'),Tool=require('../nhl/tools/validate-model');
const DAY=86400000,T=Date.parse('2025-10-01T23:00:00Z'),iso=t=>new Date(t).toISOString();
const source=at=>({url:'https://example.org/authorized-fixture',availableAt:iso(at),clock:'authorized-import'});
function history(n=35){const results=[],confirmations=[];for(let i=0;i<n;i++){results.push({id:String(2025020000+i),gameType:2,start:iso(T+i*DAY),homeId:1,awayId:2,homeGoals:i%3?4:2,awayGoals:i%3?2:3,goalies:[{id:101,teamId:1,shots:30,saves:28},{id:102,teamId:2,shots:30,saves:27}],source:source(T+i*DAY+3*3600000)});}
 const game={id:'2025021000',gameType:2,state:'pre',start:iso(T+n*DAY),home:{id:1},away:{id:2}};for(const side of ['home','away'])confirmations.push({gameId:game.id,teamId:game[side].id,goalieId:side==='home'?101:102,status:'confirmed',source:source(T+n*DAY-3600000)});return {game,bundle:Inputs.normalize({results,confirmations})};}
function artifact(at){return {version:Model.VERSION,featureNames:Model.FEATURES,coefficients:[0.1,0.2,0.1,0.15,0],temperature:1,trainedThrough:iso(at-5*DAY),validatedThrough:iso(at-2*DAY),report:{version:Model.VERSION,status:'VALIDATED_BASELINE',counts:{train:500,calibration:200,test:300},metrics:{model:{logLoss:0.64,brier:0.22,calibrationError:0.04},trainingHomeRateBaseline:{logLoss:0.69,brier:0.25}}}};}
test('official boxscore adapter uses receipt availability and never turns roster/appearance/postgame into pregame confirmation',()=>{
 const raw={id:2025020001,gameType:2,startTimeUTC:iso(T),gameState:'FINAL',homeTeam:{id:1,score:4},awayTeam:{id:2,score:2},playerByGameStats:{homeTeam:{goalies:[{playerId:101,starter:true,shotsAgainst:30,saves:28}]},awayTeam:{goalies:[{playerId:102,starter:true,shotsAgainst:30,saves:26}]}}};
 const parsed=Inputs.fromBoxscore(raw,iso(T+3*3600000));assert.equal(parsed.results.length,1);assert.equal(parsed.confirmations.length,0);assert.equal(parsed.results[0].source.clock,'receipt');assert.equal(parsed.results[0].source.availableAt,iso(T+3*3600000));
 const pre={...raw,gameState:'PRE'};assert.equal(Inputs.fromBoxscore(pre,iso(T-3600000)).confirmations.length,2);delete pre.playerByGameStats.homeTeam.goalies[0].starter;assert.equal(Inputs.fromBoxscore(pre,iso(T-3600000)).confirmations.length,1);assert.equal(Inputs.fromBoxscore(pre,iso(T+1000)).confirmations.length,0);
});
test('input normalization rejects missing clocks, invalid source, coercion and quarantines conflicting final records persistently',()=>{
 const {bundle}=history();const row=bundle.results[0];assert.equal(Inputs.result({...row,source:{...row.source,availableAt:null}}),null);assert.equal(Inputs.result({...row,homeGoals:'4'}),null);assert.equal(Inputs.result({...row,source:{...row.source,url:'javascript:alert(1)'}}),null);
 let merged=Inputs.merge({results:[row]},{results:[{...row,homeGoals:20}]});assert.equal(merged.results.length,0);assert.equal(merged.conflicts,1);merged=Inputs.merge(merged,{results:[row]});assert.equal(merged.results.length,0);assert.equal(merged.conflicts,1);
});
test('starter withdrawal, future confirmation, expired confirmation and same-time contradiction all block the feature',()=>{
 const {game,bundle}=history(),asOf=Date.parse(game.start)-500;
 assert.ok(Model.features(game,bundle,asOf).vector);
 for(const modified of [bundle.confirmations.filter(x=>x.teamId!==1),bundle.confirmations.map(x=>x.teamId===1?{...x,source:source(asOf+100)}:x),bundle.confirmations.map(x=>({...x,source:source(asOf-25*3600000)})),[...bundle.confirmations,{...bundle.confirmations[0],goalieId:103}], [...bundle.confirmations,{...bundle.confirmations[0],goalieId:null,status:'withdrawn',source:source(asOf-100)}]]){assert.equal(Model.features(game,{...bundle,confirmations:modified},asOf).vector,null);}
 const raw={id:Number(game.id),gameType:2,startTimeUTC:game.start,gameState:'PRE',homeTeam:{id:1},awayTeam:{id:2},playerByGameStats:{homeTeam:{goalies:[{playerId:101,starter:false}]}}};const withdrawn=Inputs.fromBoxscore(raw,iso(asOf-100));assert.equal(Inputs.starters(game,Inputs.merge(bundle,withdrawn).confirmations,asOf).home,null);
});
test('walk-forward features exclude future or not-yet-received outcomes and never consume this game result',()=>{
 const {game,bundle}=history(),now=Date.parse(game.start)-1000,base=Model.features(game,bundle,now);
 const changed={...bundle,results:[...bundle.results,{...bundle.results[0],id:game.id,homeGoals:20,source:source(now-1)},{...bundle.results[1],id:'2025029999',start:iso(now+DAY),homeGoals:20,source:source(now+2*DAY)},{...bundle.results[2],id:'2025029998',homeGoals:20,source:source(now+1)}]};assert.deepEqual(Model.features(game,changed,now).vector,base.vector);
 assert.equal(Model.features(game,{...bundle,results:bundle.results.slice(0,19)},now).vector,null);
});
test('prediction blocks invalid/unvalidated/future model, preseason and live phases; never fabricates advanced stats, EV or stakes',()=>{
 const {game,bundle}=history(),now=Date.parse(game.start)-500,valid=artifact(now),p=Model.predict(game,bundle,valid,{now});assert.equal(p.status,'VALIDATED_BASELINE');assert.ok(p.homeProbability>0&&p.homeProbability<1);assert.equal(p.homeProbability+p.awayProbability,1);
 for(const a of [null,{...valid,temperature:NaN},{...valid,validatedThrough:iso(now+1)},{...valid,report:{...valid.report,status:'RESEARCH_ONLY'}},{...valid,report:{...valid.report,counts:{}}}])assert.equal(Model.predict(game,bundle,a,{now}).homeProbability,null);
 for(const phase of [{...game,gameType:1,preseason:true},{...game,state:'in'}])assert.equal(Model.predict(phase,bundle,valid,{now}).homeProbability,null);
 const a=State.analysis(game,bundle,valid,now);assert.equal(a.units,0);assert.equal(a.edge,null);assert.equal(a.inputs.xg,null);assert.equal(a.inputs.gsaa,null);assert.equal(a.probabilitySide,'home');
});
test('split partitions are chronological and outcomes observed after the next stage are excluded',()=>{
 const rows=Array.from({length:100},(_,i)=>({start:iso(T+i*DAY),availableAt:iso(T+i*DAY+3*3600000)}));rows[0].availableAt=iso(T+61*DAY);rows[60].availableAt=iso(T+81*DAY);
 const s=Model.split(rows);assert.equal(s.train.length,58);assert.equal(s.calibration.length,18);assert.equal(s.test.length,20);assert.ok(s.train.every(x=>x.start<s.calibration[0].start));assert.ok(s.calibration.every(x=>x.start<s.test[0].start));
});
test('metrics are actual Brier/log loss and populated bins, not a confidence badge',()=>{const m=Model.metrics([{p:0.8,y:1},{p:0.2,y:0}]);assert.equal(m.brier,0.04);assert.equal(m.logLoss,0.223144);assert.equal(m.calibrationError,0.2);assert.equal(m.bins.reduce((s,b)=>s+b.n,0),2);assert.equal(Model.metrics([]),null);});
test('validation tool reports insufficient real data and removes a stale usable artifact',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nhl-model-'));try{const file=path.join(dir,'inputs.json');fs.writeFileSync(file,JSON.stringify({results:[],confirmations:[]}));fs.writeFileSync(path.join(dir,'nhl-model.json'),'old artifact');const report=Tool.run(file,dir);assert.equal(report.status,'INSUFFICIENT_DATA');assert.equal(report.metrics,null);assert.equal(fs.existsSync(path.join(dir,'nhl-model.json')),false);assert.match(report.limitations.join(' '),/profitability/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('state reuses official responses, does no network I/O, caches repeat final results and refreshes imported evidence',()=>{
 let clock=T+3*3600000;const files={},writes=[];const state=State.create({read:(n,f)=>files[n]??f,write:(n,v)=>{files[n]=v;writes.push(n);},now:()=>clock});const raw={id:2025020001,gameType:2,startTimeUTC:iso(T),gameState:'OFF',homeTeam:{id:1,score:3},awayTeam:{id:2,score:2},playerByGameStats:{homeTeam:{goalies:[{playerId:101,shotsAgainst:30,saves:28}]}}};assert.equal(state.observe(raw),true);clock+=1000;assert.equal(state.observe(raw),false);assert.equal(writes.length,1);assert.equal(state.status().results,1);assert.equal(state.status().status,'AWAITING_VALIDATION');files['nhl-model-inputs.json']=history().bundle;clock+=60001;assert.ok(state.status().starterObservations>0);
});
test('complete synthetic pipeline fits on train, calibrates separately, evaluates untouched test and is reproducible (not real-world validation)',()=>{
 const results=[],confirmations=[];let seed=17;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 for(let i=0;i<1800;i++){
  const day=Math.floor(i/10),slot=i%10,homeId=slot+1,awayId=11+(slot+day)%10,at=T+day*DAY,gameId=String(2025020000+i),homeWin=random()<0.5+(homeId-5)*0.04-(awayId-15)*0.04;
  results.push({id:gameId,gameType:2,start:iso(at),homeId,awayId,homeGoals:homeWin?4:2,awayGoals:homeWin?2:4,goalies:[{id:homeId+100,teamId:homeId,shots:30,saves:homeWin?28:26},{id:awayId+100,teamId:awayId,shots:30,saves:homeWin?26:28}],source:source(at+3*3600000)});
  for(const teamId of [homeId,awayId])confirmations.push({gameId,teamId,goalieId:teamId+100,status:'confirmed',source:source(at-3600000)});
 }
 const data={results,confirmations},options={generatedAt:iso(T+190*DAY)},run=Model.validate(data,options);assert.ok(run.artifact);assert.ok(run.report.counts.train>=300);assert.ok(run.report.counts.calibration>=150);assert.ok(run.report.counts.test>=200);assert.equal(run.report.metrics.model.n,run.report.counts.test);assert.equal(run.report.metrics.model.bins.reduce((s,b)=>s+b.n,0),run.report.counts.test);assert.ok(Number.isFinite(run.report.metrics.model.logLoss));assert.deepEqual(Model.validate(data,options),run);
 const changed={results:data.results.map(r=>r.start>=run.report.periods.test.first?{...r,homeGoals:r.awayGoals,awayGoals:r.homeGoals}:r),confirmations};const altered=Model.validate(changed,options);assert.deepEqual(altered.artifact.coefficients,run.artifact.coefficients);assert.equal(altered.artifact.temperature,run.artifact.temperature);assert.notEqual(altered.report.metrics.model.logLoss,run.report.metrics.model.logLoss);
});
test('NHL model summary describes current model gates instead of claiming every model is ready',()=>{
 const vm=require('node:vm'),script=fs.readFileSync(path.join(__dirname,'../nhl/public/app.js'),'utf8');const fn=script.match(/^function modelStatus\(a\)\{.*\}$/m)[0];const context={};vm.runInNewContext(fn,context);
 assert.equal(context.modelStatus({model:{status:'VALIDATED_BASELINE'}}),'Baseline validated');assert.equal(context.modelStatus({reasonCodes:['REGULAR_SEASON_ONLY']}),'Regular season only');assert.equal(context.modelStatus({reasonCodes:['HOME_STARTER_UNCONFIRMED']}),'Starter confirmation needed');assert.equal(context.modelStatus({reasonCodes:['MODEL_ARTIFACT_UNAVAILABLE']}),'Awaiting model validation');assert.equal(context.modelStatus({reasonCodes:['PREGAME_ONLY']}),'Pregame model only');assert.equal(context.modelStatus({}),'Awaiting verified inputs');assert.match(script,/esc\(modelStatus\(a\)\)/);
});
test('goalie ordering is canonical and duplicate goalie performance cannot inflate the sample',()=>{const row=history().bundle.results[0];assert.deepEqual(Inputs.result({...row,goalies:[...row.goalies].reverse()}),row);assert.equal(Inputs.result({...row,goalies:[...row.goalies,row.goalies[0]]}),null);});
