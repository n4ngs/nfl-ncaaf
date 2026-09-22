'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const repo = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(repo, name), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(sport) {
  const nodes = new Map(), calls = [], timers = new Map(); let timerId = 0;
  const element = () => ({ textContent: '', innerHTML: '', hidden: false, attrs: {}, dataset: {}, setAttribute(k,v) { this.attrs[k]=v; }, remove() {} });
  const $ = key => { if (!nodes.has(key)) nodes.set(key, element()); return nodes.get(key); };
  const cal = [3,4,5].map(week => ({ id: `2026-2-${week}`, type: 2, week, label: `Week ${week}` }));
  const S = { season: 2026, cal, def: cal[0].id, boardWeek: cal[0].id, weeks: new Map(), tracked: [], moves: [], books: [], query: '', filter: 'all', phBook: 'mkt', mkt: 's', liveMs: 5000, connected: true };
  const context = vm.createContext({ S, Map, Set, Date, Number, AbortController,
    $, $$: () => [], ICON: { back:'',chev:'',starOn:'' }, FILTERS: [['all','All']],
    esc: value => String(value??'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),
    plural: (n,label) => `${n} ${label}${n===1?'':'s'}`, withMine: g => g, notePrices() {},
    defWeek: () => S.weeks.get(S.def), boardWeek: () => S.weeks.get(S.boardWeek) || S.weeks.get(S.def),
    syncBoardChoices() {}, matchesQuery: () => false, passes: () => true, visibleBooks: () => [], renderFreshness() {}, bookName:x=>x,
    todayGames: () => [], allGames: () => [], isLive: g=>g.state==='in', isPre:g=>g.state==='pre', isFinal:g=>g.state==='post',
    glanceNumbers: () => ({}), renderMoveCards() {}, renderHero() {}, renderHeroSide() {}, renderLearn() {}, liveCard() {},
    invalidate: () => context.renderBoard(),
    setTimeout(fn,ms) { timers.set(++timerId,{fn,ms}); return timerId; }, clearTimeout(id) { timers.delete(id); },
    fetch(url,options) { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Timeout'),{name:'AbortError'}))); calls.push({url,resolve,reject}); return promise; }
  });
  const live=read(`${sport}/public/js/live.js`), views=read(`${sport}/public/js/views.js`);
  vm.runInContext(live.slice(live.indexOf('function putWeek('),live.indexOf('// ------------------------------------------------------------ price flashes')),context);
  vm.runInContext(views.slice(views.indexOf('function renderLive()'),views.indexOf('function glanceNumbers(')),context);
  vm.runInContext(views.slice(views.indexOf('function renderBoard('),views.indexOf('// What the board shows')),context);
  const reply=(index,id,games=[])=>calls[index].resolve({ok:true,json:async()=>({week:{id,season:2026,type:2,week:Number(id.split('-')[2]),label:`Week ${id.split('-')[2]}`,games},tracked:false})});
  return { S,context,$,calls,timers,reply };
}
for (const sport of ['nfl','ncaaf']) {
  test(`${sport}: failed selected week remains selected and retries without showing the default slate`, async()=>{
    const x=fixture(sport); x.context.putWeek({id:x.S.def,label:'Week 3',games:[]},{tracked:true});
    const first=x.context.openWeek('2026-2-4'), duplicate=x.context.openWeek('2026-2-4');
    assert.equal(x.calls.length,1);assert.equal(x.$('#boardTitle').textContent,'Week 4');assert.equal(x.$('#boardBody').attrs['aria-busy'],'true');
    x.calls[0].reject(new Error('offline'));await Promise.all([first,duplicate]);
    assert.equal(x.S.boardWeek,'2026-2-4');assert.equal(x.S.weekRequests.get('2026-2-4').status,'error');
    assert.equal(x.$('#boardBody').attrs['aria-busy'],'false');assert.match(x.$('#boardBody').innerHTML,/role="status"/);assert.match(x.$('#boardBody').innerHTML,/data-week="2026-2-4">Retry week/);assert.doesNotMatch(x.$('#boardBody').innerHTML,/Loading/);
    const retry=x.context.openWeek('2026-2-4');assert.equal(x.calls.length,2);x.reply(1,'2026-2-4');await retry;
    assert.equal(x.S.weekRequests.get('2026-2-4').status,'ready');assert.match(x.$('#boardBody').innerHTML,/No games scheduled/);assert.doesNotMatch(x.$('#boardBody').innerHTML,/No games match|Loading|Retry week/);
  });
  test(`${sport}: concurrent week requests do not navigate backwards and snapshots preserve the selection`,async()=>{
    const x=fixture(sport);const a=x.context.openWeek('2026-2-4'),b=x.context.openWeek('2026-2-5');
    x.context.loadSnapshot({now:Date.now(),season:2026,cal:x.S.cal,def:x.S.def,cur:x.S.def,tracked:[],week:{id:x.S.def,games:[]}});
    assert.equal(x.S.boardWeek,'2026-2-5');x.reply(0,'2026-2-4');await a;
    assert.equal(x.S.boardWeek,'2026-2-5');assert.equal(x.$('#boardBody').attrs['aria-busy'],'true');x.reply(1,'2026-2-5');await b;
    assert.equal(x.$('#boardTitle').textContent,'Week 5');assert.equal(x.$('#boardBody').attrs['aria-busy'],'false');
  });
  test(`${sport}: request timeout and malformed schedule have explicit recoverable errors`,async()=>{
    const x=fixture(sport);const timeout=x.context.openWeek('2026-2-4');
    const timer=[...x.timers.values()][0];assert.equal(timer.ms,15000);timer.fn();await timeout;
    assert.match(x.$('#boardBody').innerHTML,/took too long/);assert.equal(x.timers.size,0);
    const malformed=x.context.openWeek('2026-2-4');x.reply(1,'wrong-week');await malformed;
    assert.equal(x.S.weeks.has('wrong-week'),false);assert.match(x.$('#boardBody').innerHTML,/Retry week/);
  });
  test(`${sport}: loaded empty, filtered empty, and initial loading remain distinct`,()=>{
    const x=fixture(sport);x.context.renderBoard();assert.match(x.$('#boardBody').innerHTML,/Loading the week/);
    x.S.snapshotLoaded=true;x.context.renderBoard();assert.match(x.$('#boardBody').innerHTML,/No schedule available/);assert.equal(x.$('#boardBody').attrs['aria-busy'],'false');
    x.context.putWeek({id:x.S.def,label:'Week 3',games:[]});x.context.renderBoard();assert.match(x.$('#boardBody').innerHTML,/No games scheduled/);
    x.context.putWeek({id:x.S.def,label:'Week 3',games:[{id:'game',state:'pre'}]});x.context.renderBoard();assert.match(x.$('#boardBody').innerHTML,/No games match/);
  });
  test(`${sport}: Live never calls a received empty schedule loading or invents the next kickoff`,()=>{
    const x=fixture(sport);x.context.renderLive();assert.match(x.$('#subline').textContent,/Loading the schedule/);assert.doesNotMatch(x.$('#strip').innerHTML,/No games today/);
    x.S.connected=false;x.context.renderLive();assert.match(x.$('#subline').textContent,/Connecting/);
    x.S.snapshotLoaded=true;x.context.renderLive();assert.match(x.$('#subline').textContent,/No upcoming games in the loaded schedule/);assert.doesNotMatch(x.$('#subline').textContent,/Loading|Connecting|Next kickoff/);
  });
}
test('MLB desktop/mobile navigation and region use My bets while retaining the Following route',()=>{
  const html=read('mlb/public/index.html');
  const links=[...html.matchAll(/<a data-tab="following" href="#following">(.*?)<\/a>/g)];
  assert.equal(links.length,2);assert.ok(links.every(match=>match[1].endsWith('My bets')));
  assert.match(html,/id="view-following" data-view="following" aria-label="My bets"/);
});
test('loaded portfolio Refresh shows busy feedback and recovers after a failed request',async()=>{
  const Portfolio=require(path.join(repo,'design/portfolio.js'));
  let resolve,reject,calls=0;
  const node=()=>({innerHTML:'',textContent:'',dataset:{},attrs:{},listeners:new Map(),classList:{add(){},remove(){}},querySelectorAll:()=>[],contains:()=>false,setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this.listeners.set(k,fn);}});
  const nodes=Object.fromEntries(['.portfolio-summary','.portfolio-notice','.portfolio-list','.portfolio-sport select','input[type=search]','[data-pf-refresh]'].map(k=>[k,node()]));
  const root={...node(),isConnected:true,parentElement:node(),getClientRects:()=>[{}],querySelector:key=>nodes[key],contains:el=>Object.values(nodes).includes(el)};
  const context={BoardPortfolio:{...Portfolio,invalidate(){},load(){calls++;return new Promise((yes,no)=>{resolve=yes;reject=no;});}},document:{hidden:false,activeElement:null,addEventListener(){}},setInterval(){return 1;},clearInterval(){}};
  vm.runInNewContext(read('design/portfolio-view.js'),context);
  context.BoardPortfolioView.mount(root,{sport:'nfl',currentBets:[]});
  const button=nodes['[data-pf-refresh]'];assert.equal(button.disabled,true);assert.equal(button.attrs['aria-busy'],'true');assert.equal(button.textContent,'Refreshing…');
  resolve({tickets:[],sources:[{sport:'nfl',status:'ok'}]});await turn();assert.equal(button.disabled,false);assert.equal(button.textContent,'Refresh');
  button.hasAttribute=key=>key==='data-pf-refresh';button.closest=()=>button;
  root.listeners.get('click')({target:button});assert.equal(button.disabled,true);assert.equal(button.textContent,'Refreshing…');
  root.listeners.get('click')({target:button});assert.equal(calls,2);
  reject(new Error('offline'));await turn();assert.equal(button.disabled,false);assert.equal(button.attrs['aria-busy'],'false');assert.match(nodes['.portfolio-notice'].textContent,/could not refresh/);
});
