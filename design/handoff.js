/* Direct book links are warmed outside the odds pipeline. Opening a link creates a draft, never a wager. */
var BoardHandoff = (() => {
 'use strict';
 const cache=new Map(),quotes=new Map(),identities=new Map(),queue=new Map(),watched=new Set();let timer=null,busy=false,serial=0;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const states='al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy'.split(' ');
 const read=key=>{try{return JSON.parse(localStorage.getItem(key));}catch{return null;}};
 const save=(key,value)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{}};
 let state=states.includes(read('board.betting-state'))?read('board.betting-state'):'nv';
 const mobile=()=>/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1;
 const clock=()=>typeof serverNow==='function'?serverNow():Date.now();
 const keyOf=ref=>[state,ref.provider,ref.book,ref.id||ref.url].join('|');
 function eligible(q) {
  if(!q?.bet_link||q.bet_link.book==='cons'||q.market_status!=='active'||q.conflicted||q.conflict||q.source_conflict||q.timestamp_conflict||q.missing_from_source||typeof q.is_live!=='boolean'||!Number.isFinite(q.american_odds)||Math.abs(q.american_odds)<100)return false;
  if(['SUSPENDED','STALE','CONFLICTED'].includes(q.freshness))return false;
  const t=Date.parse(q.source_observed_at),age=clock()-t;
  if(Number.isFinite(t))return age>=0&&age<=(q.max_age_ms||(q.is_live?30000:600000))&&['FRESH','AGING'].includes(q.freshness);
  const delivered=Date.parse(q.provider_received_at),delay=clock()-delivered;
  return (q.source||q.src)==='sharp'&&q.source_observed_at==null&&delay>=0&&delay<=(q.is_live?30000:120000)&&q.reason_code==='MISSING_SOURCE_TIMESTAMP';
 }
 function result(ref){const item=cache.get(keyOf(ref));return item&&item.until>Date.now()?item.value:undefined;}
 function fallback(ref){return ref.provider==='sharp'?'https://api.sharpapi.io/api/v1/deeplink/'+encodeURIComponent(ref.id)+'?state='+state+(ref.fallback?'&fallback='+encodeURIComponent(ref.fallback):''):ref.url;}
 function destination(ref){const v=result(ref);return (mobile()?v?.appUrl:null)||v?.url||fallback(ref);}
 function caption(value){return value?.type==='outcome'?'Open single bet':value?.type==='event'?'Open game at sportsbook':value?.type==='homepage'?'Open sportsbook':'Open sportsbook · check selection';}
 function enqueue(ref){if(result(ref)!==undefined)return;queue.set(keyOf(ref),ref);if(!timer)timer=setTimeout(flush,40);}
 async function flush(){timer=null;if(busy||document.hidden||!queue.size)return;busy=true;const refs=[...queue.values()].slice(0,24),region=state;for(const ref of refs)queue.delete(keyOf(ref));
  try{const response=await fetch('/'+location.pathname.split('/')[1]+'/api/bet-links',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({state:region,refs}),signal:AbortSignal.timeout(4500)});
   if(response.ok){const data=await response.json();for(const [key,value]of Object.entries(data.links||{})){cache.delete(key);cache.set(key,{value,until:Date.now()+(value?55000:15000)});}while(cache.size>1500)cache.delete(cache.keys().next().value);
    for(const el of document.querySelectorAll('[data-bet-handoff]')){const item=quotes.get(el.dataset.betHandoff);if(!item)continue;const v=result(item.q.bet_link);el.href=destination(item.q.bet_link);el.title=item.context.label+' · '+caption(v);el.setAttribute('aria-label',el.title);el.dataset.linkType=v?.type||'lookup';}
   }
  }catch{/* Keep the public provider redirect as the one-tap fallback. */}finally{busy=false;if(queue.size&&!document.hidden)timer=setTimeout(flush,80);}
 }
 let observer=null;
 function watch(){if(!observer&&typeof IntersectionObserver==='function')observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const item=quotes.get(entry.target.dataset.betHandoff);if(item)enqueue(item.q.bet_link);}},{rootMargin:'80px'});
  for(const el of watched)if(!el.isConnected){observer?.unobserve(el);watched.delete(el);}
  for(const el of document.querySelectorAll('[data-bet-handoff]'))if(!watched.has(el)){watched.add(el);if(observer)observer.observe(el);else{const item=quotes.get(el.dataset.betHandoff);if(item)enqueue(item.q.bet_link);}}
 }
 let watchTimer=null;
 function cell(q,context,html){if(!eligible(q)||context.book!==q.bet_link.book)return html;
  const identity=[context.sport,context.gid,context.market,context.side,context.book,q.line_value,q.american_odds,q.is_live].join('|'),id=identities.get(identity)||String(++serial),ref=q.bet_link;identities.set(identity,id);quotes.set(id,{q,context,identity});while(quotes.size>12000){const old=quotes.keys().next().value;identities.delete(quotes.get(old).identity);quotes.delete(old);}
  if(!watchTimer)watchTimer=setTimeout(()=>{watchTimer=null;watch();},100);
  const value=result(ref),extra=' aria-label="'+esc(context.label+' · '+caption(value))+'" data-bet-handoff="'+id+'" data-link-type="'+(value?.type||'lookup')+'" href="'+esc(destination(ref))+'" target="'+'_blank'+'" rel="noopener noreferrer" title="'+esc(context.label+' · '+caption(value))+'"';
  return html.replace(/^<(button|span|a)\b/, '<a').replace(/\s(?:type|href|target|rel|title|aria-label)="[^"]*"/g,'').replace(/>$/, '>').replace(/<\/(button|span|a)>$/, '</a>').replace(/^<a\b/, '<a'+extra);
 }
 function message(text){if(typeof toastText==='function')toastText(text);else if(typeof betsToast==='function')betsToast(text);}
 function current(item){const c=item.context;try{
  if(c.sport==='nhl')return window.NHLBoard?.quote(c);
  if(c.sport==='mlb'){const g=S.games.get(Number(c.gid)),O=oddsGame(c.gid);if(!g||!O||!S.isToday)return null;const live=g.state==='Live';if(live!==item.q.is_live||!live&&!oddsIsPre(g))return null;return(live?O.live:c.market.startsWith('f5')?O.f5:O.books)?.[c.book]?.quote_meta?.[c.market.replace(/^f5/,'')]?.[c.side];}
  const g=gameById(c.gid);if(!g||isFinal(g)||isLive(g)!==item.q.is_live)return null;const L=(c.market.startsWith('h1')?g.h1:isLive(g)?g.live:g.books)?.[c.book];return quoteEvidence(L,c.market,c.side);
 }catch{return null;}}
 function draftPanel(){let el=document.getElementById('handoff-draft');const draft=read('board.ticket-draft');if(!draft||Date.now()-draft.created>86400000){el?.remove();return;}
  if(!el){el=document.createElement('aside');el.id='handoff-draft';el.className='handoff-draft';el.setAttribute('aria-label','Pending ticket');document.body.appendChild(el);}
  el.innerHTML='<div><small>TICKET DRAFT · NOT PLACED</small><strong>'+esc(draft.label)+'</strong></div><button type="button" data-handoff-review>Review ticket</button><button type="button" class="handoff-dismiss" aria-label="Dismiss ticket draft" data-handoff-dismiss>×</button>';
 }
 function review(){const d=read('board.ticket-draft');if(!d)return;const sport=location.pathname.split('/')[1];if(sport!==d.sport){location.href='/'+d.sport+'/#bets';return;}
  if(d.sport==='nhl'&&window.NHLBoard){window.NHLBoard.ticket(d);return;}
  if(d.sport==='mlb'&&typeof betsOpenSlip==='function'){betsOpenSlip({});BETS.slip.pick=false;BETS.slip.legs=[{pk:Number(d.gid),mkt:d.market,side:d.side,book:d.book,line:d.line,odds:d.odds}];BETS.slip.book=d.book;betsPaintSlip();}
  else if(typeof openSlip==='function'){openSlip({});const sl=S.sheet?.slip;if(sl){sl.pick=false;sl.legs=[{...legFrom(gameById(d.gid),d.market,d.side,d.book),line:d.line,odds:d.odds,entry_snapshot_id:null}];sl.book=d.book;sl.odds=d.odds;sl.placed=null;paintSlip();}}
  message('Check the actual ticket price, stake and wager time before saving.');
 }
 function mountSettings(panel){if(!panel||panel.querySelector('.handoff-settings'))return;const el=document.createElement('div');el.className='handoff-settings';el.innerHTML='<label>Sportsbook region<select aria-label="Sportsbook state">'+states.map(x=>'<option value="'+x+'"'+(x===state?' selected':'')+'>'+x.toUpperCase()+'</option>').join('')+'</select></label><p>Selection links prefill where supported. BetMGM and Caesars use app-compatible links where available. Your phone decides whether to open the installed app or a browser.</p>';panel.appendChild(el);
 el.querySelector('select').addEventListener('change',e=>{state=e.target.value;save('board.betting-state',state);queue.clear();for(const a of document.querySelectorAll('[data-bet-handoff]')){const item=quotes.get(a.dataset.betHandoff);if(item){a.href=destination(item.q.bet_link);enqueue(item.q.bet_link);}}});}
 document.addEventListener('click',e=>{const a=e.target.closest?.('[data-bet-handoff]');if(a){const item=quotes.get(a.dataset.betHandoff),q=item&&current(item);if(!q||!eligible(q)||q.american_odds!==item.q.american_odds||q.line_value!==item.q.line_value){e.preventDefault();e.stopImmediatePropagation();message('This price changed or is unavailable. Select its current price.');return;}
  const value=result(q.bet_link);if(value===undefined && q.bet_link.provider==='owls'){e.preventDefault();e.stopImmediatePropagation();enqueue(q.bet_link);message('Preparing the sportsbook link for '+state.toUpperCase()+'. Tap again in a moment.');return;}
  if(value===null){e.preventDefault();e.stopImmediatePropagation();message('This sportsbook has no link for this selection right now.');return;}
  a.href=destination(q.bet_link);a.target='_blank';save('board.ticket-draft',{...item.context,line:q.line_value,odds:q.american_odds,created:Date.now()});draftPanel();e.stopImmediatePropagation();return;}
  if(e.target.closest?.('[data-handoff-review]')){e.preventDefault();e.stopImmediatePropagation();review();}
  if(e.target.closest?.('[data-handoff-dismiss]')){save('board.ticket-draft',null);draftPanel();}
 },true);
 document.addEventListener('pointerover',e=>{const a=e.target.closest?.('[data-bet-handoff]'),item=a&&quotes.get(a.dataset.betHandoff);if(item)enqueue(item.q.bet_link);},{passive:true});
 document.addEventListener('focusin',e=>{const a=e.target.closest?.('[data-bet-handoff]'),item=a&&quotes.get(a.dataset.betHandoff);if(item)enqueue(item.q.bet_link);});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){draftPanel();if(queue.size&&!busy)flush();}});
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',draftPanel,{once:true});else draftPanel();
 return {cell,eligible,mountSettings};
})();
function betHandoffCell(q,book,gid,market,side,label,html){return BoardHandoff.cell(q,{sport:location.pathname.split('/')[1],book,gid:String(gid),market,side,label},html);}
