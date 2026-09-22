'use strict';
const {teamScore,flipLine}=require('./util');
const {lineMeta,flipMeta}=require('./quote-evidence');
function convert(L,swap=false) {
  const quote_meta={};
  for(const [key,sides] of Object.entries(L.integrityMeta || {})) quote_meta[key==='s'?'rl':key]=structuredClone(sides);
  const converted=lineMeta({ml:L.ml || null,rl:L.s!=null?{line:L.s,odds:L.so}:null,t:L.t!=null?{line:L.t,odds:L.to}:null,
    quote_meta,provider_event_id:L.provider_event_id,is_live:L.is_live});
  return swap?flipMeta(converted,flipLine(converted)):converted;
}
function match(events,games) {
  const out=new Map(), used=new Set();
  for(const e of events || []) {
    const start=Date.parse(e.start);if(!Number.isFinite(start))continue;
    const candidates=[];
    for(const g of games) {
      const dt=Math.abs(start-Date.parse(g.start));if(!Number.isFinite(dt)||dt>3*3600e3)continue;
      const straight=Math.min(teamScore(e.home,g.home),teamScore(e.away,g.away));
      const reverse=Math.min(teamScore(e.home,g.away),teamScore(e.away,g.home));
      if(Math.max(straight,reverse)<2 || straight===reverse)continue;
      candidates.push({g,dt,score:Math.max(straight,reverse),swap:reverse>straight});
    }
    candidates.sort((a,b)=>b.score-a.score||a.dt-b.dt);
    const best=candidates[0];if(!best || candidates[1]?.score===best.score && candidates[1]?.dt===best.dt)continue;
    if(used.has(best.g.pk)) {out.delete(best.g.pk);continue;}
    used.add(best.g.pk);
    out.set(best.g.pk,Object.fromEntries(['books','live','h1'].map(group=>[group,Object.fromEntries(Object.entries(e[group]||{}).map(([book,L])=>[book,convert(L,best.swap)]))])));
  }
  return out;
}
function subscribe(sport,cb) {return require('../../shared/owls-consumer').subscribe(sport,cb);}
module.exports={match,convert,subscribe};
