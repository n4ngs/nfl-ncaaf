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
  if(ref.provider==='owls')return {url:ref.url,type:'event',book:ref.book};
  const key=refKey(ref,state),old=cache.get(key);if(old&&old.until>now())return old.value|| (ref.fallback?{url:ref.fallback,type:'event',book:ref.book}:null);
  if(pending.has(key))return pending.get(key);
  if(Math.floor(now()/60000)!==minute){minute=Math.floor(now()/60000);count=0;}
  if(++count>240||queue.length>96)return null;
  const task=run(async()=>{let value=null;try {
    const res=await fetchImpl('https://api.sharpapi.io/api/v1/deeplink/'+encodeURIComponent(ref.id)+'?state='+state,{redirect:'manual',signal:AbortSignal.timeout(3000),headers:{accept:'application/json'}});
    const url=safeUrl(res.headers.get('location'),ref.book),type=res.headers.get('x-deep-link-type');
    if(res.status===302&&url&&['outcome','event','homepage'].includes(type))value={url,type,book:ref.book};
    await res.body?.cancel?.();
   }catch{/* A failed resolver must not send a bettor to a guessed selection. */}
   if(!value&&ref.fallback)value={url:ref.fallback,type:'event',book:ref.book};
   cache.delete(key);cache.set(key,{value,until:now()+(value?60000:15000)});while(cache.size>5000)cache.delete(cache.keys().next().value);return value;
  });pending.set(key,task);try{return await task;}finally{pending.delete(key);}
 }
 async function handle(req,res) {
  const send=(code,body)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
  if(req.method!=='POST')return send(405,{error:'POST required'});
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
module.exports={DOMAINS,STATES,safeUrl,refForSharp,refForOwls,validRef,refKey,attachLink,createLinkResolver};
