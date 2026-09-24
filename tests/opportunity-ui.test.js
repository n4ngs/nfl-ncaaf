'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../design/opportunities.js'), 'utf8');
const foundation = fs.readFileSync(path.join(__dirname, '../design/foundation.js'), 'utf8');
const NOW = 1900000000000;
const turn = () => new Promise(r => setImmediate(r));
const quote = (more = {}) => ({ id:'price-one', version:'v1', sport:'nfl', book:'mgm', bookName:'BetMGM', market:'s', live:true, eligible:true, expiresAt:NOW+30000, evPct:5, odds:-110, probability:.55, references:[{book:'pin'}], handoff:true, label:'Home -2.5', home:'Home', away:'Away', provider:'sharp', ...more });
function fixture({ stored = {}, search = '', script = source } = {}) {
  const elements = new Map(), storage = new Map(Object.entries(stored)), raf = [], timers = [], intervals = [], streams = [], fetches = [], docListeners = new Map(); let mono = 0, resolveAccount, accountPromise = new Promise(r => { resolveAccount = r; });
  let document;
  const decode = x => x.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  function node(id, parent = null) {
    const classes = new Set(), attrs = new Map(), listeners = new Map(); let html = '';
    const el = { id, parent, dataset:{}, options:[], value:'', hidden:false, textContent:'', listeners, children:[],
      classList:{ add:x=>classes.add(x), remove:x=>classes.delete(x), contains:x=>classes.has(x), toggle(x, state) { if (state) classes.add(x); else classes.delete(x); } },
      addEventListener(type, fn) { listeners.set(type, fn); }, setAttribute(k,v) { attrs.set(k,String(v)); }, getAttribute:k=>attrs.get(k) ?? null, removeAttribute:k=>attrs.delete(k),
      add(option) { this.options.push(option); }, contains(target) { for (let x=target; x; x=x.parent) if (x===this) return true; return false; },
      closest(selector) { if (selector==='article' || selector==='[data-id]' || selector==='[data-ticket]') return this.article || (this.dataset.id ? this : this.parent?.closest(selector)); return selector==='.op-action' && this.isAction ? this : null; },
      focus() { document.activeElement=this; }, blur() { document.activeElement=document.body; }, scrollIntoView() { this.scrolled=true; }, after(child) { elements.set(child.id,child); }, prepend(child) { elements.set(child.id,child); },
      querySelector(selector) { if(selector==='.op-action')return this.action; if(selector==='button')return this.button; if(selector==='a[href="/account"]')return this.accountLink; return null; },
      querySelectorAll(selector) { if(selector==='[data-id]')return this.children; if(selector==='details')return this.children.map(x=>x.detail); if(selector==='details[open]')return this.children.map(x=>x.detail).filter(x=>x.open); return []; } };
    Object.defineProperty(el,'innerHTML',{ get:()=>html, set(value) { html=value;
      if (id==='op-list') {
        for(const c of el.children)elements.delete(c.id); el.children=[];
        for(const match of value.matchAll(/<article\b([^>]+)>([\s\S]*?)<\/article>/g)) {
          const tag=match[1], inside=match[2], cardId=/id="([^"]+)"/.exec(tag)[1], card=node(cardId,el); card.dataset.id=decode(/data-id="([^"]+)"/.exec(tag)[1]);card.dataset.version=decode(/data-version="([^"]+)"/.exec(tag)[1]); card.article=card;
          const action=node('action',card); action.isAction=true; action.article=card; const a=/<a class="op-action"([^>]*)>/.exec(inside)[1]; const href=/href="([^"]+)"/.exec(a);if(href)action.setAttribute('href',decode(href[1]));if(a.includes('aria-disabled'))action.setAttribute('aria-disabled','true');card.action=action;
          const expiry=node('expiry',card);expiry.article=card;expiry.dataset.expiry=/data-expiry="([^"]+)"/.exec(inside)[1];card.expiry=expiry;card.detail=node('detail',card);card.detail.article=card;card.detail.open=false;el.children.push(card);elements.set(cardId,card);
        }
      }
      if(id==='op-requested' && value.includes('op-show-alert'))elements.set('op-show-alert',node('op-show-alert',el));
      if(value.includes('Account & sync')){ el.button=node('focus-button',el);el.button.setAttribute('aria-pressed','false');el.accountLink=node('account-link',el); }
    }});
    if(id)elements.set(id,el);return el;
  }
  document = { hidden:false, readyState:'complete', activeElement:null, getElementById:id=>elements.get(id)||null, createElement:()=>node(''), addEventListener(type,fn) {docListeners.set(type,fn);},
    querySelectorAll(selector) {const cards=elements.get('op-list')?.children||[];return selector==='[data-expiry]'?cards.map(c=>c.expiry):selector==='.is-selected'?cards.filter(c=>c.classList.contains('is-selected')):[];} };
  document.body=node('body'); document.documentElement=node('html'); document.activeElement=document.body;
  for(const id of ['op-list','op-chart','op-connection','op-held','op-total','op-best','op-count','op-metric-description','op-p50','op-p95','op-samples','op-book','op-sport','op-ev','op-region','op-ev-value','op-chart-note','op-requested','op-notifications','xsport'])node(id);
  elements.get('op-book').options=[{value:'all',text:'All books'}];elements.get('op-region').options=[{value:'nv',text:'Nevada'}];
  class EventSource { constructor(url){this.url=url;this.listeners=new Map();streams.push(this);} addEventListener(type,fn){this.listeners.set(type,fn);} close(){this.closed=true;} emit(value){this.listeners.get('opportunities')?.({data:JSON.stringify(value)});} }
  const handoffCalls=[];let handoffState=JSON.parse(storage.get('board.betting-state')||'"nv"');
  const context = { document, URLSearchParams, Map, Set, Date, Promise, Number, String, Object, Array, Math, JSON, performance:{now:()=>mono}, location:{search}, matchMedia:()=>({matches:true}), Option:class {constructor(text,value){this.text=text;this.value=value;}}, EventSource,
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}, requestAnimationFrame:fn=>raf.push(fn),setTimeout:fn=>timers.push(fn),setInterval:fn=>intervals.push(fn),
    BoardHandoff:{getState:()=>handoffState,setState(state){if(!/^[a-z]{2}$/.test(state||''))return false;handoffState=state;handoffCalls.push(state);storage.set('board.betting-state',JSON.stringify(state));docListeners.get('board:betting-state')?.({detail:{state}});return true;}},
    fetch:(url,opts={})=>{fetches.push({url,opts});if(url==='/api/account/me')return accountPromise;return Promise.resolve({ok:true,json:async()=>({preferences:JSON.parse(opts.body||'{}')})});} };
  context.window=context;vm.runInNewContext(script,context);
  return {elements,document,storage,raf,timers,intervals,streams,fetches,handoffCalls,context,
    node, tick(ms){mono+=ms;}, account(value){resolveAccount({ok:true,json:async()=>value});}, input(id,value){const e=elements.get(id);e.value=value;e.listeners.get('input')();}, fire(type,event={}){docListeners.get(type)?.(event);},
    flushRAF(){const batch=raf.splice(0);batch.forEach(fn=>fn());}, flushTimers(){timers.splice(0).forEach(fn=>fn());}, emit(data){streams.at(-1).emit({revision:1,serverAt:NOW,rows:[quote()],...data});}, acks(){return fetches.filter(x=>x.url.endsWith('/ack'));} };
}

test('stored filters are validated and region shares the JSON handoff key', () => {
  const f=fixture({stored:{'board.opportunity-filters':JSON.stringify({sport:'garbage',book:'<img>',ev:'NaN',region:'??'}),'board.betting-state':'"az"'}});
  assert.equal(f.elements.get('op-sport').value,'all');assert.equal(f.elements.get('op-book').value,'all');assert.equal(f.elements.get('op-ev').value,1);assert.equal(f.elements.get('op-region').value,'az');
  f.input('op-region','nj');assert.equal(f.storage.get('board.betting-state'),'"nj"');assert.equal(f.storage.has('board.book-region'),false);assert.deepEqual(f.handoffCalls,['nj']);
});

test('server clock advances while a focused price holds updates and cannot rewind on release', () => {
  const f=fixture();f.emit({rows:[quote({expiresAt:NOW+5000})]});const card=f.elements.get('op-price-one');card.action.focus();
  f.tick(1000);f.emit({revision:2,serverAt:NOW+1000,rows:[quote({expiresAt:NOW+5000})]});
  assert.match(f.elements.get('op-held').textContent,/held/);f.tick(5000);f.intervals[0]();assert.equal(card.action.getAttribute('href'),null);assert.equal(card.action.textContent,'Expired');
  card.action.blur();f.fire('pointerup');assert.equal(f.elements.get('op-total').textContent,0);assert.doesNotMatch(f.elements.get('op-list').innerHTML,/<article/);
  f.emit({revision:3,serverAt:NOW+1000,rows:[quote({expiresAt:NOW+5000})]});assert.equal(f.elements.get('op-total').textContent,0);
});

test('delta frames reconstruct unchanged rows, updates and removals before rendering', () => {
  const f=fixture();f.emit({type:'snapshot',rows:[quote(),quote({id:'two',evPct:7})]});
  f.emit({type:'delta',revision:2,serverAt:NOW+1,rows:[quote({id:'three',evPct:6})],removed:['price-one']});
  assert.deepEqual(f.elements.get('op-list').children.map(x=>x.dataset.id),['two','three']);
  f.emit({type:'delta',revision:3,serverAt:NOW+2,rows:[quote({id:'two',version:'v2',evPct:8})],removed:[]});
  assert.equal(f.elements.get('op-two').dataset.version,'v2');assert.ok(f.elements.get('op-three'));
});

test('held removal immediately disables the old click even before the focused card is replaced', () => {
  const f=fixture();f.emit({});const card=f.elements.get('op-price-one');card.action.focus();
  f.emit({type:'delta',revision:2,rows:[],removed:['price-one']});assert.equal(card.action.getAttribute('href'),null);assert.match(card.expiry.textContent,/changed/);
  let prevented=false;f.elements.get('op-list').listeners.get('click')({target:card.action,preventDefault(){prevented=true;}});assert.equal(prevented,true);
});

test('acks require two animation frames of actual visible unsuperseded qualified prices', () => {
  const f=fixture();f.emit({ack:'first'});assert.equal(f.acks().length,0);f.flushRAF();assert.equal(f.acks().length,0);
  f.emit({revision:2,ack:'second',rows:[quote({version:'v2'})]});f.flushRAF();assert.equal(f.acks().length,0);f.flushRAF();assert.equal(f.acks().length,1);assert.equal(JSON.parse(f.acks()[0].opts.body).ack,'second');
  f.tick(6000);f.intervals[0]();f.flushRAF();f.flushRAF();assert.equal(f.acks().length,1,'periodic repaint must not duplicate a measurement');
  f.emit({revision:3,ack:'hidden'});f.document.hidden=true;f.flushRAF();f.flushRAF();assert.equal(f.acks().length,1);
});

test('held frames are acknowledged only after release, and filtered-out delta changes never claim a rendered measurement', () => {
  const f=fixture();f.emit({});const action=f.elements.get('op-price-one').action;action.focus();
  f.emit({revision:2,ack:'held',rows:[quote({version:'v2'})]});f.flushRAF();f.flushRAF();assert.equal(f.acks().length,0);
  action.blur();f.fire('pointerup');f.flushRAF();f.flushRAF();assert.equal(f.acks().length,1);
  f.input('op-sport','nfl');f.emit({type:'delta',revision:3,ack:'only-mlb',rows:[quote({id:'baseball',sport:'mlb'})],removed:[]});f.flushRAF();f.flushRAF();assert.equal(f.acks().length,1);
});

test('stale stream callbacks and lower revisions cannot restore expired prices', () => {
  const f=fixture();f.emit({revision:5,rows:[]});f.emit({revision:4,rows:[quote()]});assert.equal(f.elements.get('op-total').textContent,0);
  const old=f.streams[0];f.fire('visibilitychange');old.emit({revision:9,serverAt:NOW,rows:[quote()]});assert.equal(f.elements.get('op-total').textContent,0);
});

test('notification opportunity is selected on arrival, including when saved filters hid it', () => {
  const f=fixture({search:'?opportunity=price-one',stored:{'board.opportunity-filters':JSON.stringify({sport:'mlb',book:'dk',ev:10})}});
  f.emit({});f.flushRAF();assert.equal(f.document.activeElement.id,'op-price-one');assert.equal(f.elements.get('op-price-one').classList.contains('is-selected'),true);assert.equal(f.elements.get('op-sport').value,'nfl');assert.equal(f.elements.get('op-book').value,'mgm');
});

test('account region arriving late preserves a newer user choice and syncs it without clobbering unrelated preferences', async () => {
  const f=fixture();f.input('op-region','az');f.account({csrf:'token',account:{preferences:{region:'NJ',focusMode:true,books:['mgm'],sports:['nfl']}}});await turn();await turn();
  assert.equal(f.elements.get('op-region').value,'az');const save=f.fetches.find(x=>x.url==='/api/account/preferences');const body=JSON.parse(save.opts.body);assert.equal(body.region,'AZ');assert.equal(body.focusMode,true);assert.deepEqual(body.books,['mgm']);
  const g=fixture();g.input('op-sport','mlb');g.account({csrf:'token',account:{preferences:{region:'CO'}}});await turn();assert.equal(g.elements.get('op-region').value,'co','changing another filter must not reject account region');assert.equal(g.storage.get('board.betting-state'),'"co"');
});

test('invalid numerical quote fields never enter HTML or become actionable', () => {
  const f=fixture();f.emit({rows:[quote({odds:'<img onerror=alert(1)>'}),quote({id:'bad',evPct:NaN}),quote({id:'missing',eligible:false})]});
  assert.equal(f.elements.get('op-total').textContent,0);assert.doesNotMatch(f.elements.get('op-list').innerHTML,/<img|<article/);
});

test('foundation preserves focus and handoff changes made while account preferences load', async () => {
  const f=fixture({script:foundation});const nav=f.elements.get('board-workspace-nav'),button=nav.button;
  button.listeners.get('click')();f.context.BoardHandoff.setState('az');f.account({csrf:'token',account:{preferences:{region:'NJ',focusMode:false,books:['dk'],sports:['nhl']}}});await turn();await turn();
  assert.equal(button.getAttribute('aria-pressed'),'true');assert.equal(f.storage.get('board.focus'),'1');assert.equal(f.context.BoardHandoff.getState(),'az');
  const saved=JSON.parse(f.fetches.filter(x=>x.url==='/api/account/preferences').at(-1).opts.body);assert.equal(saved.focusMode,true);assert.equal(saved.region,'AZ');assert.deepEqual(saved.books,['dk']);
});

test('foundation applies account preference through exposed handoff API without treating that as a user edit', async () => {
  const f=fixture({script:foundation});f.account({csrf:'token',account:{preferences:{region:'CO',focusMode:true}}});await turn();
  assert.deepEqual(f.handoffCalls,['co']);assert.equal(f.storage.get('board.betting-state'),'"co"');assert.equal(f.storage.get('board.focus'),'1');assert.equal(f.fetches.filter(x=>x.url==='/api/account/preferences').length,0);
});


test('a held handoff uses the latest region when activated', () => {
  const f=fixture();f.emit({});const card=f.elements.get('op-price-one');card.action.focus();
  f.context.BoardHandoff.setState('nj');assert.match(card.action.getAttribute('href'),/state=nv/);
  let prevented=false;f.elements.get('op-list').listeners.get('click')({target:card.action,preventDefault(){prevented=true;}});
  assert.equal(prevented,false);assert.match(card.action.getAttribute('href'),/state=nj/);
});


test('provider keys beginning with a digit survive saved filters and quote validation', () => {
  const f=fixture({stored:{'board.opportunity-filters':JSON.stringify({sport:'all',book:'1xbet',ev:1})}});
  assert.equal(f.elements.get('op-book').value,'1xbet');f.emit({rows:[quote({book:'1xbet',bookName:'1xBet'})]});
  assert.equal(f.elements.get('op-total').textContent,1);assert.ok(f.elements.get('op-price-one'));
});

test('the page says how many markets were left out because both sides beat the reference', () => {
  const f=fixture(); f.emit({rows:[quote()],disagreements:2});
  assert.match(f.elements.get('op-held').textContent,/2 left out: both sides beat the reference/);
  f.emit({revision:2,rows:[quote()],disagreements:0}); assert.equal(f.elements.get('op-held').textContent,'Sorted by estimated EV');
});
