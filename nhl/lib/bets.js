'use strict';
const crypto=require('node:crypto');
const {readJSON,writeJSON}=require('../../nfl/lib/util');
let data=readJSON('bets.json',{v:1,bets:[]});
const save=()=>writeJSON('bets.json',data),mine=(b,uid)=>!!uid&&b.owner===uid;
function present(b){return {...b,legs:b.legs.map(l=>({...l,integrity:{eligibility_status:'MISSING_ENTRY_SNAPSHOT',reason_code:'NO_IMMUTABLE_ENTRY_SNAPSHOT',line_clv_points:null,clv_fair_probability_pp:null,clv_ev_pct:null}}))};}
const list=uid=>data.bets.filter(b=>mine(b,uid)).map(present);
function create(b,uid){const l=b.legs?.[0],now=Date.now(),placed=Date.parse(b.placed);if(!uid||!l||!/^\d{10}$/.test(l.gid)||!['ml','s','t'].includes(l.mkt)||(l.mkt==='t'?!['over','under'].includes(l.side):!['home','away'].includes(l.side))||l.mkt!=='ml'&&!Number.isFinite(l.line)||!Number.isFinite(b.stake)||b.stake<=0||b.stake>1e8||!Number.isFinite(b.odds)||Math.abs(b.odds)<100||Math.abs(b.odds)>1e7||!/(?:Z|[+-]\d{2}:\d{2})$/.test(b.placed)||!Number.isFinite(placed)||placed>now)throw Error('Check the market, selection, stake, odds and actual wager time.');
 const bet={id:crypto.randomUUID(),owner:uid,created:now,placed:new Date(placed).toISOString(),placed_basis:'USER_REPORTED_WAGER_TIME',book:String(b.book||'').slice(0,40),stake:b.stake,odds:b.odds,status:'open',net:null,settled:null,note:'',legs:[{gid:l.gid,mkt:l.mkt,side:l.side,line:l.mkt==='ml'?null:l.line,odds:b.odds,label:String(l.label||'').slice(0,80),matchup:String(l.matchup||'').slice(0,80),start:l.start,state:'open',entry_snapshot_id:null}]};data.bets.unshift(bet);save();return present(bet);}
function update(id,b,uid){const x=data.bets.find(x=>x.id===id&&mine(x,uid));if(!x)return null;if(b.status&&!['open','won','lost','push','void'].includes(b.status))throw Error('Invalid result');if(b.status){x.status=b.status;x.settled=b.status==='open'?null:Date.now();x.net=b.status==='open'?null:b.status==='won'?Math.round(x.stake*(x.odds>0?x.odds/100:100/-x.odds)*100)/100:b.status==='lost'?-x.stake:0;x.settlement_basis='USER_CONFIRMED_BOOK_RESULT';x.legs[0].state=b.status;}save();return present(x);}
function remove(id,uid){const n=data.bets.length;data.bets=data.bets.filter(x=>!(x.id===id&&mine(x,uid)));if(n!==data.bets.length)save();return n!==data.bets.length;}
function csv(uid){const q=x=>'"'+String(x??'').replace(/"/g,'""')+'"',t=x=>/^[=+\-@\t\r]/.test(String(x))?"'"+x:x;return [['placed','book','selection','odds','stake','status','net','clv_status'],...list(uid).map(x=>[x.placed,t(x.book),t(x.legs[0].label),x.odds,x.stake,x.status,x.net,'MISSING_ENTRY_SNAPSHOT'])].map(r=>r.map(q).join(',')).join('\n');}
const openGameIds=()=>[...new Set(data.bets.filter(b=>b.status==='open').flatMap(b=>b.legs.map(l=>l.gid)))];
module.exports={list,create,update,remove,csv,openGameIds};
