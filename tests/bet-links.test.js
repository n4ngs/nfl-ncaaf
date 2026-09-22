'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {safeUrl,refForSharp,refForOwls,attachLink,createLinkResolver}=require('../shared/bet-links');
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
 assert.match(html,/^<a /);assert.match(html,/target="_self"/);assert.match(html,/deeplink\/12345\?state=nv/);assert.match(html,/<\/a>$/);assert.equal(u.saved.size,0);assert.equal(u.calls(),0);
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
