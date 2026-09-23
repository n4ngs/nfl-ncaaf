'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {safeUrl,refForSharp,refForOwls,attachLink,createLinkResolver,destinationFor}=require('../shared/bet-links');
const ref={provider:'sharp',id:'12345',book:'dk'};
const q={sportsbook:'dk',source:'owls',market_status:'active',is_live:false,line_value:-3.5,american_odds:-110};
test('book link allowlist rejects foreign, deceptive, script and credentialed destinations',()=>{
 assert.equal(safeUrl('https://sportsbook.draftkings.com/event/1','dk'),'https://sportsbook.draftkings.com/event/1');
 for(const url of ['https://draftkings.com.evil.test/','https://evil.test/?draftkings.com','javascript:alert(1)','https://user@draftkings.com/','http://draftkings.com/'])assert.equal(safeUrl(url,'dk'),null);
 assert.equal(safeUrl('https://sportsbook.fanduel.com/','dk'),null);
 assert.equal(refForSharp({id:'123'},'circa'),null);assert.equal(refForSharp({id:'../../x'},'dk'),null);
 assert.equal(refForOwls('https://sportsbook.draftkings.com/event/1','dk').provider,'owls');
});
test('handoff enrichment binds identical side, line, price, phase and book',()=>{
 const candidate={...q,source:'sharp',bet_link:ref};assert.deepEqual(attachLink(q,[candidate]).bet_link,ref);
 for(const change of [{line_value:3.5},{american_odds:-115},{is_live:true},{market_status:'suspended'},{conflicted:true},{missing_from_source:true},{bet_link:{...ref,book:'fd'}}])assert.equal(attachLink(q,[{...candidate,...change}]).bet_link,undefined);
 assert.equal(attachLink({...q,market_status:'removed'},[candidate]).bet_link,undefined);
 assert.equal(attachLink(q,[candidate]).source,'owls');
});
test('resolver returns final sportsbook URL, preserves specificity and deduplicates concurrent calls',async()=>{
 let calls=0;const resolver=createLinkResolver({fetchImpl:async(url,opts)=>{calls++;assert.equal(opts.redirect,'manual');assert.equal(new URL(url).searchParams.get('state'),'nv');assert.equal(opts.headers.authorization,undefined);return {status:302,headers:new Headers({location:'https://sportsbook.draftkings.com/event/1?outcomes=exact','x-deep-link-type':'outcome'})};}});
 const [a,b]=await Promise.all([resolver.resolve(ref,'nv'),resolver.resolve(ref,'nv')]);assert.deepEqual(a,b);assert.equal(a.type,'outcome');assert.match(a.url,/outcomes=exact/);assert.equal(calls,1);await resolver.resolve(ref,'nv');assert.equal(calls,1);
});
test('resolver does not promote event links, follow untrusted redirects or default a bad state',async()=>{
 let calls=0;const resolver=createLinkResolver({fetchImpl:async()=>{calls++;return {status:302,headers:new Headers({location:'https://www.pinnacle.com/en/all-sports/matchup/1','x-deep-link-type':'event'})};}});
 assert.equal((await resolver.resolve({...ref,book:'pin'},'nv')).type,'event');assert.equal(await resolver.resolve(ref,'nv'),null);assert.equal(await resolver.resolve(ref,'on'),null);assert.equal(calls,2);
});
function ui(){const listeners={},saved=new Map(),els=[];let calls=0;const doc={readyState:'loading',hidden:false,addEventListener:(name,fn)=>{(listeners[name]||=[]).push(fn);},querySelectorAll:()=>els,getElementById:()=>null,createElement:()=>({setAttribute(){},innerHTML:''}),body:{appendChild(){}}};
 const ctx=vm.createContext({document:doc,location:{pathname:'/nfl/'},navigator:{userAgent:'iPhone',platform:'iPhone',maxTouchPoints:1},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},Date,Map,Set,WeakSet,Number,JSON,String,AbortSignal,setTimeout:()=>1,fetch:async()=>{calls++;throw Error('unexpected');},serverNow:()=>Date.parse('2026-09-22T20:00:00Z')});
 vm.runInContext(fs.readFileSync(require.resolve('../design/handoff.js'),'utf8'),ctx);return {ctx,listeners,saved,doc,els,calls:()=>calls};}
const fresh={...q,bet_link:ref,source_observed_at:'2026-09-22T19:59:50Z',freshness:'FRESH'};
const context={sport:'nfl',gid:'1',book:'dk',market:'s',side:'home',label:'DraftKings home −3.5 −110'};
test('price renderer makes a direct mobile anchor without changing source verification or adding a wager',()=>{
 const u=ui();const html=u.ctx.BoardHandoff.cell(fresh,context,'<button type="button" class="px" data-bet="1|s|home|dk">−3.5<small>−110</small></button>');
 assert.match(html,/^<a /);assert.match(html,/target="_blank"/);assert.match(html,/href="\/nfl\/api\/bet-links\?state=nv&amp;ref=/);assert.doesNotMatch(html,/href="https:/);assert.match(html,/<\/a>$/);assert.equal(u.saved.size,0);assert.equal(u.calls(),0);
 const repeat=u.ctx.BoardHandoff.cell({...fresh},context,'<button>−3.5</button>');assert.equal(html.match(/data-bet-handoff="(\d+)"/)[1],repeat.match(/data-bet-handoff="(\d+)"/)[1]);
});
test('stale/suspended and wrong-book prices remain non-navigable; recent feed quotes can open without EV eligibility',()=>{
 const u=ui();for(const change of [{market_status:'suspended'},{freshness:'STALE'},{conflicted:true},{source_observed_at:'2026-09-22T18:00:00Z'},{bet_link:{...ref,book:'fd'}}])assert.equal(u.ctx.BoardHandoff.cell({...fresh,...change},context,'<span>Price</span>'),'<span>Price</span>');
 const feed={...fresh,source:'sharp',freshness:'UNVERIFIED',source_observed_at:null,provider_received_at:'2026-09-22T19:59:55Z',reason_code:'MISSING_SOURCE_TIMESTAMP'};assert.match(u.ctx.BoardHandoff.cell(feed,context,'<span>Feed quote</span>'),/^<a /);assert.equal(feed.freshness,'UNVERIFIED');
 assert.equal(u.ctx.BoardHandoff.eligible({...feed,provider_received_at:'2026-09-22T19:50:00Z'}),false);
});
test('click rechecks current quote and never records a wager',()=>{
 const u=ui();u.ctx.currentQuote={...fresh};u.ctx.gameById=()=>({id:'1'});u.ctx.isFinal=()=>false;u.ctx.isLive=()=>false;u.ctx.quoteEvidence=()=>u.ctx.currentQuote;u.ctx.toastText=()=>{};
 u.ctx.BoardHandoff.cell(fresh,context,'<button>Price</button>');let prevented=false;const anchor={dataset:{betHandoff:'1'}};const event={target:{closest:()=>anchor},preventDefault(){prevented=true;},stopImmediatePropagation(){}};
 u.ctx.currentQuote={...fresh,american_odds:-120};u.listeners.click[0](event);assert.equal(prevented,true);assert.equal(u.saved.size,0);assert.equal(u.calls(),0);
});

test('expired selection links fall back only to the same book event and remain labeled event',async()=>{const fallback='https://sportsbook.draftkings.com/event/1';const linked=attachLink(q,[{...q,bet_link:ref},{...q,bet_link:{provider:'owls',book:'dk',url:fallback}}]);assert.equal(linked.bet_link.fallback,fallback);const resolver=createLinkResolver({fetchImpl:async()=>({status:404,headers:new Headers()})});assert.deepEqual(await resolver.resolve(linked.bet_link,'nv'),{url:fallback,type:'event',book:'dk'});});

test('Nevada BetMGM app URL follows its published iOS sportsapp path and preserves single selection',async()=>{const r=createLinkResolver({fetchImpl:async()=>({status:302,headers:new Headers({location:'https://sports.nv.betmgm.com/en/sports/events/123?options=123-4-5&type=Single','x-deep-link-type':'outcome'})})});const d=await r.resolve({...ref,book:'mgm'},'nv');assert.equal(d.appUrl,'https://sports.nv.betmgm.com/en/sportsapp/events/123?options=123-4-5&type=Single');assert.equal(d.state,'nv');assert.match(d.url,/\/en\/sports\/events/);});
const nvHome={mgm:'https://www.nv.betmgm.com/en/engage/lan/sports/nevada',czr:'https://www.caesars.com/sportsbook-and-casino/nv'};
test('NJ event and selection IDs are never transplanted into invented Nevada links',async()=>{
 const r=createLinkResolver({fetchImpl:async()=>{throw Error('Unexpected network');}});
 for(const [book,url]of [['mgm','https://sports.nj.betmgm.com/en/sports/events/123?options=NJ-selection'],['czr','https://sportsbook.caesars.com/us/nj/bet/event/123']]){
  const value=await r.resolve({provider:'owls',book,url},'nv');assert.equal(value.url,nvHome[book]);assert.equal(value.appUrl,undefined);
  assert.equal(value.type,'homepage');assert.equal(value.reason,'REGION_SELECTION_UNAVAILABLE');assert.equal(value.selectionVerified,false);
 }
});
test('regional validation catches path boundaries, generic hosts and conflicting query destinations',()=>{
 for(const [book,url]of [
  ['mgm','https://nj.betmgm.com/'],['mgm','https://www.nj.betmgm.com/en/sports'],['mgm','https://sports.betmgm.com/en/sports/events/123'],
  ['mgm','https://sports.nv.betmgm.com/en/sports/events/123?state=NJ'],
  ['mgm','https://sports.nv.betmgm.com/en/sports/events/123?redirect=https%3A%2F%2Fsports.nj.betmgm.com%2Fen%2Fsports'],
  ['czr','https://sportsbook.caesars.com/us/nj'],['czr','https://sportsbook.caesars.com/US/NJ?event=123'],
  ['czr','https://sportsbook.caesars.com/us/nv/bet/event/123?jurisdiction=nj'],['czr','https://sportsbook.caesars.com/'],
 ])assert.equal(destinationFor(url,book,'nv','outcome').url,nvHome[book],url);
 assert.equal(destinationFor('https://sports.nj.betmgm.com/en/sports/events/123','mgm','invalid','outcome'),null);
});
test('already-Nevada Caesars selections keep exact outcome IDs and specificity',()=>{
 const url='https://sportsbook.caesars.com/us/nv/bet/event/123?selectionIds=NV-abc';
 const value=destinationFor(url,'czr','nv','outcome');assert.equal(value.url,url);assert.equal(value.appUrl,url);assert.equal(value.type,'outcome');
});
test('Sharp missing or mismatched regional links use honest NV homepages, including cached fallback',async()=>{
 for(const [book,fallback]of [['mgm','https://sports.nj.betmgm.com/en/sports/events/123'],['czr','https://sportsbook.caesars.com/us/nj/bet/event/123']]){
  for(const status of [302,404]){
   let calls=0;const r=createLinkResolver({fetchImpl:async(url)=>{calls++;assert.equal(new URL(url).searchParams.has('fallback'),false);return {status,headers:new Headers(status===302?{location:fallback,'x-deep-link-type':'outcome'}:{})};}});
   const input={...ref,book,fallback};for(let i=0;i<2;i++){const value=await r.resolve(input,'nv');assert.equal(value.url,nvHome[book]);assert.equal(value.type,'homepage');}assert.equal(calls,1);
  }
 }
});
test('expired MGM or Caesars selections without another provider link still offer the official Nevada homepage',async()=>{
 const r=createLinkResolver({fetchImpl:async()=>({status:404,headers:new Headers()})});
 for(const book of ['mgm','czr']){const value=await r.resolve({...ref,book},'nv');assert.equal(value.url,nvHome[book]);assert.equal(value.type,'homepage');assert.equal(value.selectionVerified,false);assert.equal(value.appUrl,undefined);}
});
async function requestLink(resolver,input,state='nv',app=true){let status,headers,body;const req={method:'GET',url:'/nfl/api/bet-links?state='+state+'&ref='+encodeURIComponent(JSON.stringify(input))+(app?'&app=1':'')};
 await resolver.handle(req,{writeHead:(s,h)=>{status=s;headers=h;},end:b=>{body=b;}});return{status,headers,body};}
test('unwarmed normal, middle and context-menu links resolve on server before any external redirect',async()=>{
 for(const [book,fallback]of [['mgm','https://sports.nj.betmgm.com/en/sports/events/123'],['czr','https://sportsbook.caesars.com/us/nj/bet/event/123']]){
  const r=createLinkResolver({fetchImpl:async()=>({status:404,headers:new Headers()})});
  for(const input of [{...ref,book,fallback},{provider:'owls',book,url:fallback}]){const result=await requestLink(r,input);assert.equal(result.status,302);assert.equal(result.headers.location,nvHome[book]);assert.equal(result.headers['cache-control'],'no-store');}
 }
 const r=createLinkResolver({fetchImpl:async()=>({status:404,headers:new Headers()})});assert.equal((await requestLink(r,ref)).status,404);assert.equal((await requestLink(r,ref,'invalid')).status,400);
});
test('unresolved Sharp and Owls clicks keep navigation inside the state-validating endpoint',()=>{
 for(const [provider,book,url]of [['sharp','mgm','https://sports.nj.betmgm.com/en/sports/events/123'],['owls','czr','https://sportsbook.caesars.com/us/nj/bet/event/123']]){
  const u=ui(),link=provider==='sharp'?{...ref,book,fallback:url}:{provider,book,url},quote={...fresh,sportsbook:book,bet_link:link},c={...context,book};
  u.ctx.gameById=()=>({id:'1'});u.ctx.isFinal=()=>false;u.ctx.isLive=()=>false;u.ctx.quoteEvidence=()=>quote;
  const html=u.ctx.BoardHandoff.cell(quote,c,'<button>Price</button>');const href=html.match(/href="([^"]+)"/)[1].replace(/&amp;/g,'&');
  assert.equal(new URL(href,'https://board.example').pathname,'/nfl/api/bet-links');assert.equal(new URL(href,'https://board.example').searchParams.get('state'),'nv');
  let prevented=false;const anchor={dataset:{betHandoff:'1'}};u.listeners.click[0]({target:{closest:()=>anchor},preventDefault(){prevented=true;},stopImmediatePropagation(){}});
  assert.equal(prevented,false);assert.match(anchor.href,/^\/nfl\/api\/bet-links\?state=nv&ref=/);assert.equal(u.calls(),0);
 }
});
