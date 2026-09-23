'use strict';
// Book-specific destinations only. A selection link never promises the offered price is still available.
const DOMAINS = Object.freeze({dk:['draftkings.com'],fd:['fanduel.com'],mgm:['betmgm.com'],czr:['caesars.com'],
 ballybet:['ballybet.com'],betparx:['betparx.com'],betrivers:['betrivers.com'],betway:['betway.com'],bovada:['bovada.lv'],bwin:['bwin.com'],
 hardrock:['hardrock.bet'],unibet:['unibet.com'],pin:['pinnacle.com'],betonline:['betonline.ag'], '1xbet':['1xbet.com'],
 betano:['betano.com'],ladbrokes:['ladbrokes.com'],novig:['novig.us','novig.com'],prophetx:['prophetx.co','prophetx.com'],
 sportzino:['sportzino.com'],stake:['stake.com'],sbobet:['sbobet.com'],thescore:['thescore.bet','thescorebet.com']});
const STATES = new Set('al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy'.split(' '));
function safeUrl(value,book) {
 try {const u=new URL(value); if(u.protocol!=='https:'||u.username||u.password||u.port||String(value).length>3000) return null;
 if(!(DOMAINS[book]||[]).some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))return null;return u.href;}catch{return null;}
}
// Official Nevada landing pages; cross-state selection IDs are not interchangeable evidence.
const NEVADA_HOME = Object.freeze({mgm:'https://www.nv.betmgm.com/en/engage/lan/sports/nevada',czr:'https://www.caesars.com/sportsbook-and-casino/nv'});
const nevadaFallback=book=>({url:NEVADA_HOME[book],type:'homepage',book,state:'nv',reason:'REGION_SELECTION_UNAVAILABLE',selectionVerified:false});
function regionsIn(u) {
 const regions=new Set();let text=u.href.toLowerCase();
 try{text=decodeURIComponent(text);}catch{}
 for(const pattern of [/(?:^|[./])([a-z]{2})\.betmgm\.com\b/g,/\/(?:us|sportsbook-and-casino)\/([a-z]{2})(?:[/?#]|$)/g,/[?&](?:state|statecode|region|jurisdiction|jurisdictioncode)=([a-z]{2})(?:[&#]|$)/g])
  for(const match of text.matchAll(pattern))if(STATES.has(match[1]))regions.add(match[1]);
 return regions;
}
// Preserve a provider's already-regional selection; never manufacture an NV selection by rewriting NJ.
function destinationFor(value, book, state, type) {
 const safe=safeUrl(value,book);if(!safe||!STATES.has(state))return null;
 const u=new URL(safe);
 if(state==='nv'&&safe===NEVADA_HOME[book])return nevadaFallback(book);
 if(book==='mgm'||book==='czr') {
  const regions=regionsIn(u),regional=book==='mgm'?new RegExp('^(?:www\\.|sports\\.)?'+state+'\\.betmgm\\.com$').test(u.hostname)
   : u.hostname==='sportsbook.caesars.com'&&new RegExp('^/us/'+state+'(?:/|$)','i').test(u.pathname);
  if([...regions].some(region=>region!==state)||!regional)return state==='nv'?nevadaFallback(book):null;
 }
 let appUrl=null;
 if(book==='mgm' && u.hostname==='sports.'+state+'.betmgm.com' && /^\/en\/sports\//.test(u.pathname)) {const app=new URL(u);app.pathname=app.pathname.replace('/en/sports/','/en/sportsapp/');appUrl=app.href;}
 if(book==='czr' && u.hostname==='sportsbook.caesars.com' && u.pathname.startsWith('/us/'+state+'/bet/')) appUrl=u.href;
 return {url:u.href,type,book,...(appUrl?{appUrl}:{}),...(book==='mgm'||book==='czr'?{state}:{})};
}
function refForSharp(row,book) {return DOMAINS[book] && /^([0-9]{1,30}|[a-f0-9]{16})$/.test(String(row.id)) ? {provider:'sharp',id:String(row.id),book}:null;}
function refForOwls(url,book) {const safe=safeUrl(url,book);return safe?{provider:'owls',url:safe,book}:null;}
function validRef(ref) {if(!ref||typeof ref!=='object')return null;if(ref.provider==='sharp'){const base=refForSharp({id:ref.id},ref.book),fallback=safeUrl(ref.fallback,ref.book);return base&&fallback?{...base,fallback}:base;}if(ref.provider==='owls')return refForOwls(ref.url,ref.book);return null;}
function refKey(ref,state='nv'){return [state,ref.provider,ref.book,ref.id||ref.url].join('|');}
function attachLink(q,candidates,book=q?.sportsbook||q?.bet_link?.book) {
 if(!q || q.market_status!=='active' || q.conflicted || q.conflict || q.missing_from_source)return q;
 const matches=[q,...candidates].filter(c=>c&&c.market_status==='active'&&!c.conflicted&&!c.conflict&&!c.missing_from_source&&c.is_live===q.is_live&&c.line_value===q.line_value&&c.american_odds===q.american_odds&&validRef(c.bet_link)&&(!book||c.bet_link.book===book));
 const linked=matches.find(c=>c.bet_link.provider==='sharp')||matches[0];
 if(!linked)return q;const ref=validRef(linked.bet_link);const event=[q,...candidates].map(c=>validRef(c?.bet_link)).find(r=>r?.provider==='owls'&&r.book===ref.book);
 return {...q,bet_link:ref.provider==='sharp'&&event?{...ref,fallback:event.url}:ref};
}
function createLinkResolver({fetchImpl=globalThis.fetch,now=Date.now}={}) {
 const cache=new Map(),pending=new Map();let active=0,minute=0,count=0;const queue=[];
 const run=async fn=>{if(active>=4)await new Promise(resolve=>queue.push(resolve));active++;try{return await fn();}finally{active--;queue.shift()?.();}};
 async function resolve(raw,state='nv') {
  const ref=validRef(raw);if(!ref||!STATES.has(state))return null;
  if(ref.provider==='owls')return destinationFor(ref.url,ref.book,state,'event');
  const key=refKey(ref,state),old=cache.get(key);if(old&&old.until>now())return old.value|| (ref.fallback?destinationFor(ref.fallback,ref.book,state,'event'):null);
  if(pending.has(key))return pending.get(key);
  if(Math.floor(now()/60000)!==minute){minute=Math.floor(now()/60000);count=0;}
  if(++count>240||queue.length>96)return null;
  const task=run(async()=>{let value=null;try {
    const res=await fetchImpl('https://api.sharpapi.io/api/v1/deeplink/'+encodeURIComponent(ref.id)+'?state='+state,{redirect:'manual',signal:AbortSignal.timeout(3000),headers:{accept:'application/json'}});
    const url=safeUrl(res.headers.get('location'),ref.book),type=res.headers.get('x-deep-link-type');
    if(res.status===302&&url&&['outcome','event','homepage'].includes(type))value=destinationFor(url,ref.book,state,type);
    await res.body?.cancel?.();
   }catch{/* A failed resolver must not send a bettor to a guessed selection. */}
   if(!value&&ref.fallback)value=destinationFor(ref.fallback,ref.book,state,'event');
   if(!value&&state==='nv'&&NEVADA_HOME[ref.book])value=nevadaFallback(ref.book);
   cache.delete(key);cache.set(key,{value,until:now()+(value?60000:15000)});while(cache.size>5000)cache.delete(cache.keys().next().value);return value;
  });pending.set(key,task);try{return await task;}finally{pending.delete(key);}
 }
 async function handle(req,res) {
  const send=(code,body)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
  // Unwarmed anchors, including middle-click and context-menu opens, resolve here
  // rather than exposing a provider redirect with an unchecked regional fallback.
  if(req.method==='GET') {
   if(String(req.url).length>7000)return send(414,{error:'Link request too large'});
   let query,ref;try{query=new URL(req.url,'https://local.invalid').searchParams;ref=JSON.parse(query.get('ref'));}catch{return send(400,{error:'Invalid link request'});}
   if(!STATES.has(query.get('state'))||!validRef(ref))return send(400,{error:'Invalid link request'});
   const value=await resolve(ref,query.get('state'));if(!value)return send(404,{error:'This sportsbook has no verified destination for this selection and state.'});
   res.writeHead(302,{location:query.get('app')==='1'&&value.appUrl?value.appUrl:value.url,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});return res.end();
  }
  if(req.method!=='POST')return send(405,{error:'GET or POST required'});
  let body='',tooLarge=false;req.setEncoding('utf8');
  for await(const chunk of req){body+=chunk;if(body.length>24000){tooLarge=true;break;}}
  if(tooLarge)return send(413,{error:'Request too large'});
  let input;try{input=JSON.parse(body);}catch{return send(400,{error:'Invalid JSON'});}
  if(!STATES.has(input?.state)||!Array.isArray(input.refs)||input.refs.length>24)return send(400,{error:'Invalid link request'});
  const entries=await Promise.all(input.refs.map(async raw=>{const ref=validRef(raw);return ref?[refKey(ref,input.state),await resolve(ref,input.state)]:null;}));
  send(200,{links:Object.fromEntries(entries.filter(Boolean))});
 }
 return {resolve,handle};
}
module.exports={destinationFor,DOMAINS,STATES,safeUrl,refForSharp,refForOwls,validRef,refKey,attachLink,createLinkResolver};
