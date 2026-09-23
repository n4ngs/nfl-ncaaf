'use strict';
// First-party, in-app activity only. Browser reports are untrusted product signals, not security proof.
const ROUTES = Object.freeze({ board:'Board',live:'Live',bets:'My bets',tools:'Tools',games:'Games',homers:'Home runs',following:'My bets',mine:'My bets',odds:'Odds',edges:'Edges',week:'Schedule',game:'Game room',replays:'Goal replays' });
const ACTIONS = new Set(['APP_FOREGROUND','APP_BACKGROUND','PAGE_EXIT','ONLINE','OFFLINE']);
const CLICKS = new Set(['OPEN_GAME','OPEN_REPLAYS','PLAY_REPLAY','REPLAY_SPEED','OPEN_TICKET','OPEN_SPORTSBOOK','CLOSE_DIALOG','CHANGE_MARKET','CHANGE_FILTER','CHANGE_WEEK','CHANGE_THEME','CHANGE_ALERTS','OPEN_PHONE','OPEN_SUPPORT','OPEN_RESULTS']);
const CLICK_LABELS = Object.freeze({OPEN_GAME:'Opened a game room',OPEN_REPLAYS:'Opened goal replays',PLAY_REPLAY:'Played a goal replay',REPLAY_SPEED:'Changed replay speed',OPEN_TICKET:'Opened a bet ticket',OPEN_SPORTSBOOK:'Opened a sportsbook',CLOSE_DIALOG:'Closed a detail window',CHANGE_MARKET:'Changed market',CHANGE_FILTER:'Changed a board filter',CHANGE_WEEK:'Changed the week',CHANGE_THEME:'Changed appearance',CHANGE_ALERTS:'Opened alert settings',OPEN_PHONE:'Opened phone access',OPEN_SUPPORT:'Opened creator support',OPEN_RESULTS:'Opened results'});
const GAP = 30 * 60e3;
const route = value => typeof value === 'string' && Object.hasOwn(ROUTES,value) ? value : '';
const visitId = value => typeof value === 'string' && /^v_[a-z0-9_-]{8,48}$/i.test(value) ? value : null;
function context(value) {
  const c = value && typeof value === 'object' && !Array.isArray(value) ? value : {}, out = {};
  const ranges = { vw:[1,20000],vh:[1,20000],sw:[1,20000],sh:[1,20000],dpr:[0.1,10],tzo:[-840,840],touch:[0,20] };
  for (const [key,[min,max]] of Object.entries(ranges)) if (Number.isFinite(c[key]) && c[key]>=min && c[key]<=max) out[key]=c[key];
  if (typeof c.tz==='string' && c.tz.length<=64 && /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+){0,3}$/.test(c.tz)) out.tz=c.tz;
  if (typeof c.locale==='string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(c.locale)) out.locale=c.locale;
  if (typeof c.langs==='string') out.langs=c.langs.split(',').slice(0,4).filter(v=>/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(v)).join(',');
  out.standalone=c.standalone===true;
  if (typeof c.visible==='boolean') out.visible=c.visible;
  return out;
}
function sanitizeEvent(it,now) {
  if (!it || typeof it!=='object' || Array.isArray(it)) return null;
  const data=it.data && typeof it.data==='object' && !Array.isArray(it.data) ? it.data : {};
  const r=route(it.route), base={t:now,receivedAt:now,r,visitId:visitId(it.vid)};
  if (Number.isFinite(it.t) && Math.abs(it.t-now)<=10*60e3) base.clientAt=it.t;
  if (it.kind==='page_view') return r ? {...base,k:'view'} : null;
  if (it.kind==='visit_open') return {...base,k:'visit',ctx:context(data.ctx)};
  if (it.kind==='app_action') return ACTIONS.has(data.action) ? {...base,k:'act',a:data.action} : null;
  if (it.kind==='click') {
    const label=typeof data.label==='string' ? data.label : '';
    if (CLICKS.has(label) || (label.startsWith('tab:') && route(label.slice(4)))) return {...base,k:'click',l:label};
  }
  // Old collectors may still report errors; never retain arbitrary messages, URLs, or source paths.
  if (it.kind==='client_error') return {...base,k:'err',msg:'Browser reported an application error'};
  return null;
}
// Re-encode only normalized, admitted events for the football engines' older telemetry counters.
function legacyEvent(event) {
  const kind = {view:'page_view',visit:'visit_open',click:'click',act:'app_action',err:'client_error'}[event.k];
  const out = {kind,t:event.receivedAt,route:event.r};
  if (event.visitId) out.vid=event.visitId;
  if (event.k==='visit') out.data={ctx:event.ctx};
  if (event.k==='click') out.data={label:event.l};
  if (event.k==='act') out.data={action:event.a};
  return out;
}
const eventTime = e => Number.isFinite(e.receivedAt) ? e.receivedAt : Number.isFinite(e.t) ? e.t : 0;
function sessionData(events,dev='') {
  const ordered=events.slice().sort((a,b)=>eventTime(a)-eventTime(b)), sessions=[], membership=new Map();
  let current=null;
  for (const e of ordered) {
    const at=eventTime(e);
    if (!current || at-current.end>GAP) {
      current={id:'s_'+String(dev).slice(0,8)+'_'+String(e.id||at.toString(36)),start:at,end:at,n:0,views:0,clicks:0,bets:0,sports:new Set(),ips:new Set(),visits:new Set()};
      sessions.push(current);
    }
    membership.set(e,current.id);current.end=Math.max(current.end,at);current.n++;
    if(e.k==='view')current.views++;
    if(e.k==='click')current.clicks++;
    if(e.k==='req'&&e.m==='POST'&&e.p==='/api/bets'&&e.s>=200&&e.s<300)current.bets++;
    if(e.sp)current.sports.add(e.sp);if(e.ip)current.ips.add(e.ip);if(visitId(e.visitId||e.vid))current.visits.add(e.visitId||e.vid);
  }
  return {ordered,membership,sessions:sessions.map(({visits,...s})=>({...s,dur:s.end-s.start,durationKind:'observed_span',sports:[...s.sports],ips:[...s.ips],visitCount:visits.size})).reverse()};
}
function browsingHistory(events,dev,limit=500,prepared) {
  const data=prepared||sessionData(events,dev), history=[], nextClient=new Map();
  for(let i=data.ordered.length-1;i>=0&&history.length<Math.min(500,Math.max(1,limit));i--){
    const e=data.ordered[i],r=route(e.r),at=eventTime(e);
    let source='',page='';
    if(e.k==='view'&&r){source='client';page=ROUTES[r];nextClient.set(e.sp,at);}
    else if(e.k==='req'&&e.m==='GET'&&(e.p==='/'||e.p==='/index.html')&&e.s>=200&&e.s<300){
      // A page response is a fallback only when a subsequent client view did not describe it.
      if(nextClient.has(e.sp)&&nextClient.get(e.sp)-at<=10000)continue;
      source='server';page='App page loaded';
    } else continue;
    history.push({id:e.id||'legacy_'+i,t:at,receivedAt:Number.isFinite(e.receivedAt)?e.receivedAt:null,sp:e.sp||'',route:source==='server'?'':r,page,visitId:visitId(e.visitId||e.vid),sessionId:data.membership.get(e),source,legacy:!Number.isFinite(e.receivedAt)});
  }
  return history;
}
module.exports={ROUTES,ACTIONS,CLICKS,CLICK_LABELS,GAP,route,visitId,context,sanitizeEvent,legacyEvent,eventTime,sessionData,browsingHistory};
