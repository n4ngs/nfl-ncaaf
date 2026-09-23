'use strict';
// Only observations with a known availability time may enter a pregame feature.
// Receipt time is an upper bound on availability, never a provider publication clock.
const MAX_ROWS=8000, MAX_CONFIRMATIONS=MAX_ROWS*2;
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?Date.parse(v):NaN;
const positive=v=>Number.isInteger(v)&&v>0;
const count=v=>Number.isInteger(v)&&v>=0;
const validSource=v=>{try {const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password&&u.href.length<=500;}catch{return false;}};
const iso=v=>new Date(v).toISOString();
const name=v=>typeof v==='string'?v:typeof v?.default==='string'?v.default:'';
function provenance(v){return !!v&&validSource(v.url)&&Number.isFinite(time(v.availableAt))&&['receipt','provider-published','authorized-import'].includes(v.clock);}
function result(v){
 if(!v||!/^\d{10}$/.test(String(v.id))||v.gameType!==2||!positive(v.homeId)||!positive(v.awayId)||v.homeId===v.awayId||!count(v.homeGoals)||!count(v.awayGoals)||v.homeGoals===v.awayGoals||v.homeGoals>25||v.awayGoals>25||!provenance(v.source)||!Number.isFinite(time(v.start))||time(v.source.availableAt)<=time(v.start))return null;
 const clean={id:String(v.id),gameType:2,start:iso(time(v.start)),homeId:v.homeId,awayId:v.awayId,homeGoals:v.homeGoals,awayGoals:v.awayGoals,source:{url:v.source.url,availableAt:iso(time(v.source.availableAt)),clock:v.source.clock},goalies:[]};
 const goalieIds=new Set();for(const g of Array.isArray(v.goalies)?v.goalies:[]){if(!positive(g.id)||![v.homeId,v.awayId].includes(g.teamId)||!count(g.shots)||!count(g.saves)||g.shots>100||g.saves>g.shots)continue;if(goalieIds.has(g.id))return null;goalieIds.add(g.id);clean.goalies.push({id:g.id,teamId:g.teamId,shots:g.shots,saves:g.saves});}
 clean.goalies.sort((a,b)=>a.id-b.id);return clean;
}
function confirmation(v){
 if(!v||!/^\d{10}$/.test(String(v.gameId))||!positive(v.teamId)||!['confirmed','unconfirmed','withdrawn'].includes(v.status)||(v.status==='confirmed'&&!positive(v.goalieId))||!provenance(v.source))return null;
 return {gameId:String(v.gameId),teamId:v.teamId,goalieId:positive(v.goalieId)?v.goalieId:null,name:name(v.name).slice(0,100),status:v.status,source:{url:v.source.url,availableAt:iso(time(v.source.availableAt)),clock:v.source.clock}};
}
function normalize(bundle={}){
 const grouped=new Map(),conflicts=new Set((Array.isArray(bundle.quarantinedIds)?bundle.quarantinedIds:[]).filter(v=>/^\d{10}$/.test(String(v))).slice(-MAX_ROWS));
 for(const raw of Array.isArray(bundle.results)?bundle.results.slice(-MAX_ROWS):[]){const row=result(raw);if(!row)continue;const old=grouped.get(row.id);if(old&&JSON.stringify({...old,source:null})!==JSON.stringify({...row,source:null})){conflicts.add(row.id);continue;}if(!old||time(row.source.availableAt)<time(old.source.availableAt))grouped.set(row.id,row);}
 for(const id of conflicts)grouped.delete(id);
 return {version:1,results:[...grouped.values()].sort((a,b)=>time(a.start)-time(b.start)),confirmations:(Array.isArray(bundle.confirmations)?bundle.confirmations.slice(-MAX_CONFIRMATIONS):[]).map(confirmation).filter(Boolean),conflicts:conflicts.size,quarantinedIds:[...conflicts]};
}
function fromBoxscore(raw,receivedAt=new Date().toISOString()){
 const id=String(raw?.id||''),at=time(receivedAt);if(!/^\d{10}$/.test(id)||!Number.isFinite(at))return {results:[],confirmations:[]};
 const source={url:'https://api-web.nhle.com/v1/gamecenter/'+id+'/boxscore',availableAt:iso(at),clock:'receipt'};
 const homeId=raw.homeTeam?.id,awayId=raw.awayTeam?.id;
 const rows=['home','away'].flatMap(side=>(raw.playerByGameStats?.[side+'Team']?.goalies||[]).map(g=>({id:g.playerId,teamId:raw[side+'Team']?.id,shots:g.shotsAgainst,saves:g.saves,starter:g.starter===true,name:name(g.name)})));
 const final=['OFF','FINAL'].includes(raw.gameState);
 const record=final?result({id,gameType:raw.gameType,start:raw.startTimeUTC,homeId,awayId,homeGoals:raw.homeTeam?.score,awayGoals:raw.awayTeam?.score,goalies:rows,source}):null;
 // A boxscore discovered during/after a game cannot prove a pregame starter was known.
 const pregame=['FUT','PRE'].includes(raw.gameState)&&at<time(raw.startTimeUTC);
 const confirmations=[];if(pregame)for(const side of ['home','away']){const rawRows=raw.playerByGameStats?.[side+'Team']?.goalies||[],known=rawRows.filter(g=>Object.hasOwn(g,'starter'));if(!known.length)continue;const starters=known.filter(g=>g.starter===true);if(starters.length===1){const g=starters[0];confirmations.push(confirmation({gameId:id,teamId:raw[side+'Team']?.id,goalieId:g.playerId,name:g.name,status:'confirmed',source}));}else confirmations.push(confirmation({gameId:id,teamId:raw[side+'Team']?.id,status:'unconfirmed',source}));}
 return {results:record?[record]:[],confirmations:confirmations.filter(Boolean)};
}
function merge(existing,incoming){
 const a=normalize(existing),b=normalize(incoming);
 // Keep initial receipt when a later poll repeats the same fact; conflicting results fail closed.
 const confirmations=new Map();for(const row of [...a.confirmations,...b.confirmations]){const key=[row.gameId,row.teamId,row.goalieId,row.status,row.source.availableAt].join(':');confirmations.set(key,row);}
 return normalize({results:[...a.results,...b.results],confirmations:[...confirmations.values()],quarantinedIds:[...a.quarantinedIds,...b.quarantinedIds]});
}
function starters(game,rows,asOf=Date.now()){
 const cutoff=Math.min(asOf,time(game.start));return Object.fromEntries(['home','away'].map(side=>{
  const list=(rows||[]).filter(v=>v.gameId===String(game.id)&&v.teamId===game[side]?.id&&time(v.source?.availableAt)<=cutoff&&cutoff-time(v.source.availableAt)<=24*3600000).sort((a,b)=>time(b.source.availableAt)-time(a.source.availableAt));
  const newest=list[0];const ties=newest?list.filter(v=>time(v.source.availableAt)===time(newest.source.availableAt)):[];
  return [side,newest&&newest.status==='confirmed'&&ties.every(v=>v.status==='confirmed')&&new Set(ties.map(v=>v.goalieId)).size===1?newest:null];
 }));
}
module.exports={MAX_ROWS,MAX_CONFIRMATIONS,time,provenance,result,confirmation,normalize,fromBoxscore,merge,starters};
