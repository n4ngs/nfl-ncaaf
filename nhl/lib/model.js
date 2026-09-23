'use strict';
const crypto=require('node:crypto');
const I=require('./model-inputs');
const VERSION='nhl-pregame-logit-v1',FEATURES=['intercept','goalDifferential','winRate','goalieSaveRate','rest'],DAY=86400000;
const POLICY=Object.freeze({teamGames:20,goalieShots:200,lookbackDays:365,teamWindow:60,minTrain:300,minCalibration:150,minTest:200,maxCalibrationError:0.08,maxArtifactDays:365});
const sigmoid=z=>1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const bounded=(v,a,b)=>Math.max(a,Math.min(b,v));
const round=v=>Math.round(v*1e6)/1e6;
function features(game,bundle,asOf=Date.parse(game.start)){
 const reasons=[],at=Math.min(asOf,Date.parse(game.start)),confirmed=I.starters(game,bundle.confirmations,at);
 if(game.gameType!==2||game.preseason)reasons.push('REGULAR_SEASON_ONLY');
 if(!Number.isFinite(at))reasons.push('INVALID_START');
 for(const side of ['home','away'])if(!confirmed[side])reasons.push(side.toUpperCase()+'_STARTER_UNCONFIRMED');
 const rows=(bundle.results||[]).filter(r=>r.id!==String(game.id)&&Date.parse(r.source.availableAt)<=at&&Date.parse(r.start)<at&&at-Date.parse(r.start)<=POLICY.lookbackDays*DAY);
 const teams={};
 for(const side of ['home','away']){
  const id=game[side]?.id,history=rows.filter(r=>[r.homeId,r.awayId].includes(id)).sort((a,b)=>Date.parse(b.start)-Date.parse(a.start)).slice(0,POLICY.teamWindow);
  const goalie=confirmed[side]?.goalieId,goalieRows=rows.flatMap(r=>r.goalies||[]).filter(g=>g.id===goalie);
  const shots=goalieRows.reduce((s,g)=>s+g.shots,0),saves=goalieRows.reduce((s,g)=>s+g.saves,0);
  if(history.length<POLICY.teamGames)reasons.push(side.toUpperCase()+'_TEAM_SAMPLE_SMALL');
  if(shots<POLICY.goalieShots)reasons.push(side.toUpperCase()+'_GOALIE_SAMPLE_SMALL');
  let wins=0,goalsFor=0,goalsAgainst=0;for(const r of history){const home=r.homeId===id;const gf=home?r.homeGoals:r.awayGoals,ga=home?r.awayGoals:r.homeGoals;wins+=gf>ga?1:0;goalsFor+=gf;goalsAgainst+=ga;}
  teams[side]={games:history.length,goalDifferential:history.length?(goalsFor-goalsAgainst)/history.length:null,winRate:history.length?wins/history.length:null,goalieId:goalie||null,goalieShots:shots,goalieSaveRate:shots?saves/shots:null,restDays:history.length?bounded((at-Date.parse(history[0].start))/DAY-1,0,7):null};
 }
 if(reasons.length)return {vector:null,reasons,teams,starters:confirmed};
 const h=teams.home,a=teams.away;
 // Scaling only. Coefficients, home advantage and calibration are learned from the supplied data.
 return {vector:[1,(h.goalDifferential-a.goalDifferential)/3,h.winRate-a.winRate,(h.goalieSaveRate-a.goalieSaveRate)*10,(h.restDays-a.restDays)/7],reasons,teams,starters:confirmed};
}
function fit(rows,{ridge=0.05,iterations=1800}={}){
 const coefficients=FEATURES.map(()=>0);
 for(let step=0;step<iterations;step++){
  const gradient=FEATURES.map(()=>0);
  for(const row of rows){const error=sigmoid(dot(coefficients,row.x))-row.y;for(let i=0;i<gradient.length;i++)gradient[i]+=error*row.x[i];}
  for(let i=0;i<coefficients.length;i++)coefficients[i]-=0.4*(gradient[i]/rows.length+(i?ridge*coefficients[i]:0));
 }
 return coefficients;
}
function metrics(predictions){
 if(!predictions.length)return null;
 const bins=Array.from({length:10},(_,i)=>({lower:i/10,upper:(i+1)/10,n:0,predicted:0,observed:0}));let logLoss=0,brier=0;
 for(const row of predictions){const p=bounded(row.p,1e-9,1-1e-9);logLoss-=row.y*Math.log(p)+(1-row.y)*Math.log(1-p);brier+=(p-row.y)**2;const b=bins[Math.min(9,Math.floor(p*10))];b.n++;b.predicted+=p;b.observed+=row.y;}
 let ece=0;for(const b of bins){if(b.n){b.predicted=round(b.predicted/b.n);b.observed=round(b.observed/b.n);ece+=b.n*Math.abs(b.predicted-b.observed)/predictions.length;}else{b.predicted=null;b.observed=null;}}
 return {n:predictions.length,logLoss:round(logLoss/predictions.length),brier:round(brier/predictions.length),calibrationError:round(ece),bins};
}
function calibrate(coefficients,rows){
 let best={temperature:1,loss:Infinity};
 // Prespecified bounded grid, chosen only on the calibration partition.
 for(let n=5;n<=40;n++){const temperature=n/10;const loss=metrics(rows.map(r=>({y:r.y,p:sigmoid(dot(coefficients,r.x)/temperature)}))).logLoss;if(loss<best.loss)best={temperature,loss};}
 return best.temperature;
}
function split(rows){
 const n=rows.length,first=rows[Math.floor(n*0.6)]?.start?.slice(0,10),second=rows[Math.floor(n*0.8)]?.start?.slice(0,10);
 if(!first||!second||first===second)return {train:[],calibration:[],test:[]};
 const calibrationStart=Date.parse(first+'T00:00:00Z'),testStart=Date.parse(second+'T00:00:00Z');
 // Outcomes must have been available before the next fitting/evaluation stage.
 return {train:rows.filter(r=>Date.parse(r.start)<calibrationStart&&Date.parse(r.availableAt)<calibrationStart),calibration:rows.filter(r=>Date.parse(r.start)>=calibrationStart&&Date.parse(r.start)<testStart&&Date.parse(r.availableAt)<testStart),test:rows.filter(r=>Date.parse(r.start)>=testStart)};
}
function validate(bundle,{generatedAt=new Date().toISOString()}={}){
 const clean=I.normalize(bundle),rejected={},examples=[];
 for(const row of clean.results){if(Date.parse(row.source.availableAt)>Date.parse(generatedAt)){rejected.FUTURE_OUTCOME=(rejected.FUTURE_OUTCOME||0)+1;continue;}const game={id:row.id,start:row.start,gameType:2,home:{id:row.homeId},away:{id:row.awayId}};const f=features(game,clean);if(!f.vector){for(const reason of f.reasons)rejected[reason]=(rejected[reason]||0)+1;continue;}examples.push({id:row.id,start:row.start,availableAt:row.source.availableAt,x:f.vector,y:row.homeGoals>row.awayGoals?1:0});}
 const partitions=split(examples),counts=Object.fromEntries(Object.entries(partitions).map(([k,v])=>[k,v.length]));
 const report={version:VERSION,generatedAt,dataSha256:crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex'),status:'INSUFFICIENT_DATA',method:'Chronological walk-forward features; frozen train / calibration / test partitions by UTC date. No random split.',sourceRows:clean.results.length,conflictingRows:clean.conflicts,eligible:examples.length,rejected,counts,policy:POLICY,metrics:null,limitations:['Historical starter confirmations require evidence available before kickoff. Postgame boxscores cannot reconstruct them.','Result/goalie statistics use all situations, include overtime and shootout game outcomes, and are not 5v5 xG, high-danger chances or GSAA.','No archived executable odds: ROI, CLV, expected value calibration and betting profitability are not evaluated.','This is a regular-season pregame two-way moneyline model; no live, puck-line, totals, playoff or preseason estimates.']};
 if(counts.train<POLICY.minTrain||counts.calibration<POLICY.minCalibration||counts.test<POLICY.minTest)return {report,artifact:null};
 const coefficients=fit(partitions.train).map(round),temperature=calibrate(coefficients,partitions.calibration),baseline=partitions.train.reduce((s,r)=>s+r.y,0)/counts.train;
 const scores=metrics(partitions.test.map(r=>({y:r.y,p:sigmoid(dot(coefficients,r.x)/temperature)}))),control=metrics(partitions.test.map(r=>({y:r.y,p:baseline})));
 report.metrics={model:scores,trainingHomeRateBaseline:control,baselineProbability:round(baseline)};
 report.status=scores.logLoss<control.logLoss&&scores.brier<=control.brier&&scores.calibrationError<=POLICY.maxCalibrationError?'VALIDATED_BASELINE':'RESEARCH_ONLY';
 report.periods=Object.fromEntries(Object.entries(partitions).map(([k,v])=>[k,{first:v[0].start,last:v.at(-1).start,outcomesAvailableThrough:new Date(Math.max(...v.map(r=>Date.parse(r.availableAt)))).toISOString()}]));
 const artifact={version:VERSION,featureNames:FEATURES,coefficients:coefficients.map(round),temperature,trainedThrough:report.periods.calibration.outcomesAvailableThrough,validatedThrough:report.periods.test.outcomesAvailableThrough,report};
 return {report,artifact};
}
function artifactProblems(a,asOf=Date.now()){
 const bad=[];
 if(!a||a.version!==VERSION||JSON.stringify(a.featureNames)!==JSON.stringify(FEATURES)||!Array.isArray(a.coefficients)||a.coefficients.length!==FEATURES.length||!a.coefficients.every(v=>typeof v==='number'&&Number.isFinite(v))||!Number.isFinite(a.temperature)||a.temperature<0.5||a.temperature>4)return ['MODEL_ARTIFACT_UNAVAILABLE'];
 const r=a.report,m=r?.metrics?.model,b=r?.metrics?.trainingHomeRateBaseline;
 if(r?.version!==VERSION||r.status!=='VALIDATED_BASELINE'||!Number.isInteger(r.counts?.train)||r.counts.train<POLICY.minTrain||!Number.isInteger(r.counts?.calibration)||r.counts.calibration<POLICY.minCalibration||!Number.isInteger(r.counts?.test)||r.counts.test<POLICY.minTest||!m||!b||!Number.isFinite(m.logLoss)||!Number.isFinite(m.brier)||!Number.isFinite(m.calibrationError)||!(m.logLoss<b.logLoss)||!(m.brier<=b.brier)||m.calibrationError>POLICY.maxCalibrationError)bad.push('MODEL_NOT_VALIDATED');
 const latest=Date.parse(a.validatedThrough),trained=Date.parse(a.trainedThrough);
 if(!Number.isFinite(latest)||!Number.isFinite(trained)||trained>latest||latest>=asOf)bad.push('MODEL_LOOKAHEAD');
 else if(asOf-latest>POLICY.maxArtifactDays*DAY)bad.push('MODEL_VALIDATION_EXPIRED');
 return bad;
}
function predict(game,bundle,artifact,{now=Date.now()}={}){
 const f=features(game,bundle,now),reasons=[...f.reasons,...artifactProblems(artifact,Math.min(now,Date.parse(game.start)))];
 if(game.state!=='pre'||now>=Date.parse(game.start))reasons.push('PREGAME_ONLY');
 if(reasons.length)return {version:VERSION,status:'BLOCKED',homeProbability:null,awayProbability:null,reasons:[...new Set(reasons)],inputs:f};
 const home=sigmoid(dot(artifact.coefficients,f.vector)/artifact.temperature);
 return {version:VERSION,status:'VALIDATED_BASELINE',homeProbability:round(home),awayProbability:round(1-home),reasons:[],inputs:f,validatedThrough:artifact.validatedThrough,validation:artifact.report.metrics};
}
module.exports={VERSION,FEATURES,POLICY,features,fit,metrics,calibrate,split,validate,artifactProblems,predict};
