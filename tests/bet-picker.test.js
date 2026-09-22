'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const game=(id,state='pre',home='Home')=>({id,state,start:'2026-09-27T17:00:00Z',away:{short:'Away'},home:{short:home}});
function setup(sport,{available=false,cached=false}={}) {
  let resolve,reject;
  const pending=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const calls=[],puts=[];
  const S={season:2026,cal:[{id:'2026-2-3',type:2,week:3,label:'Week 3'},{id:'2026-2-4',type:2,week:4,label:'Week 4'}],def:'2026-2-3',cur:'2026-2-3',boardWeek:'2026-2-3',tab:'bets',tracked:['2026-2-3'],unit:100,parlay:[],sheet:null,weeks:new Map([['2026-2-3',{games:new Map([['old',game('old',available?'pre':'post')]])}]])};
  if(cached)S.weeks.set('2026-2-4',{games:new Map()});
  const elements={ '#dlg':{open:false,addEventListener(){},classList:{toggle(){}},showModal(){this.open=true}},'#dlgBody':{innerHTML:''},'#dlgIn':{scrollTop:0},'#pkSearch':{value:''},'#pkGame':{value:'',innerHTML:'',disabled:false},'#pkStatus':{textContent:'',hidden:false} };
  const context=vm.createContext({S,Map,Set,Date,Number,console,setTimeout,clearTimeout,document:{addEventListener(){}},
    $:key=>elements[key]||null,serverNow:()=>Date.parse('2026-09-22T12:00:00Z'),
    allGames:()=>[...S.weeks.entries()].filter(([id])=>S.tracked.includes(id)).flatMap(([,w])=>[...w.games.values()]),isFinal:g=>g.state==='post',
    dayLabel:()=> 'Sun',timeLabel:()=> '10:00 AM',esc:x=>String(x??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),
    api:url=>{calls.push(url);return pending;},putWeek:(w,m)=>{puts.push([w,m]);S.weeks.set(w.id,{games:new Map(w.games.map(g=>[g.id,g]))});}
  });
  const source=path.join(__dirname,'..',sport,'public/js/sheets.js');
  vm.runInContext(fs.readFileSync(source,'utf8'),context,{filename:source});
  return {S,elements,calls,puts,context,resolve,reject,reply:games=>resolve({week:{id:'2026-2-4',games},tracked:true})};
}
for(const sport of ['nfl','ncaaf']) {
  test(`${sport}: empty manual picker fetches next calendar week without navigation or stake autofill`,async()=>{
    const x=setup(sport);const work=x.context.openSlip();
    assert.deepEqual(x.calls,['/api/week?season=2026&type=2&week=4']);
    assert.equal(x.S.sheet.slip.stake,null);assert.equal(x.S.sheet.slip.book,'');
    assert.match(x.elements['#pkStatus'].textContent,/Loading Week 4/);
    x.reply([game('next')]);await work;
    assert.equal(x.S.boardWeek,'2026-2-3');assert.equal(x.S.tab,'bets');assert.equal(x.puts.length,1);
    assert.match(x.elements['#pkGame'].innerHTML,/value="next"/);assert.equal(x.elements['#pkGame'].disabled,false);
    assert.deepEqual(x.S.tracked,['2026-2-3']);await x.context.openSlip();assert.equal(x.calls.length,1);assert.match(x.elements['#pkGame'].innerHTML,/value="next"/);
  });
  test(`${sport}: repeated openings share one pending request and preserve a typed query`,async()=>{
    const x=setup(sport);const first=x.context.openSlip(),second=x.context.openSlip();
    x.elements['#pkSearch'].value='target';x.reply([game('next','pre','Target'),game('other','pre','Elsewhere')]);await Promise.all([first,second]);
    assert.equal(x.calls.length,1);assert.equal(x.elements['#pkSearch'].value,'target');
    assert.match(x.elements['#pkGame'].innerHTML,/value="other" hidden/);assert.equal(x.puts.length,1);
  });
  test(`${sport}: late responses do not reopen a closed form or replace a selected game`,async()=>{
    const closed=setup(sport);const a=closed.context.openSlip();const original=closed.elements['#pkGame'].innerHTML;
    closed.S.sheet=null;closed.elements['#dlg'].open=false;closed.reply([game('next')]);await a;
    assert.equal(closed.S.sheet,null);assert.equal(closed.elements['#dlg'].open,false);assert.equal(closed.elements['#pkGame'].innerHTML,original);
    const selected=setup(sport);const b=selected.context.openSlip();selected.elements['#pkGame'].value='user-choice';selected.elements['#pkGame'].innerHTML='preserve';selected.reply([game('next')]);await b;
    assert.equal(selected.elements['#pkGame'].value,'user-choice');assert.equal(selected.elements['#pkGame'].innerHTML,'preserve');
  });
  test(`${sport}: chosen side prevents a late picker repaint`,async()=>{
    const x=setup(sport);const work=x.context.openSlip();x.S.sheet.slip.legs=[{gid:'picked',stake:null}];x.elements['#pkGame'].innerHTML='preserve';x.reply([game('next')]);await work;
    assert.equal(x.elements['#pkGame'].innerHTML,'preserve');assert.equal(x.S.sheet.slip.legs[0].gid,'picked');
  });
  test(`${sport}: errors and empty schedules stay explicit without inventing games`,async()=>{
    const x=setup(sport);const work=x.context.openSlip();x.reject(new Error('offline'));await work;
    assert.match(x.elements['#pkStatus'].textContent,/could not be loaded/);assert.equal(x.elements['#pkGame'].disabled,true);assert.equal(x.puts.length,0);
    const y=setup(sport);const p=y.context.openSlip();y.reply([]);await p;
    assert.match(y.elements['#pkStatus'].textContent,/No non-final games/);assert.equal(y.elements['#pkGame'].disabled,true);
  });
  test(`${sport}: loaded games and already loaded next week do not cause another request`,async()=>{
    const available=setup(sport,{available:true});await available.context.openSlip();assert.equal(available.calls.length,0);
    const cached=setup(sport,{cached:true});await cached.context.openSlip();assert.equal(cached.calls.length,0);
    const end=setup(sport);end.S.cal=end.S.cal.slice(0,1);await end.context.openSlip();assert.equal(end.calls.length,0);assert.match(end.elements['#pkStatus'].textContent,/No non-final games/);
  });
}
