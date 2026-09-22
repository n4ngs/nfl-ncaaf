'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(sport, extra = []) {
  const el = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, classList: { toggle() {} } };
  const context = vm.createContext({ console, Date, Math, Set, Map, WeakMap, JSON, Number, String, Intl, URLSearchParams, setTimeout, clearTimeout, location: {hash:''}, history:{replaceState(){}}, window:{addEventListener(){}}, document:{addEventListener(){},querySelector(){return el;},querySelectorAll(){return[];}}, localStorage:{getItem(){return null;}}, fetch(){throw Error('Network forbidden in tests');} });
  for (const file of ['core','integrity','clv',...extra]) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',sport,'public/js',file+'.js'),'utf8'), context, {filename:file+'.js'});
  return expression => vm.runInContext(expression,context);
}
for (const sport of ['nfl','ncaaf']) {
  test(`${sport}: source age, missing evidence, suspension and live context fail closed`,()=>{
    const run=load(sport);
    assert.equal(run('quoteFreshness({seen:serverNow(),market_status:"ACTIVE",snapshot_id:"snap-test",validation_status:"VALID",market_type:"s",selection:"home"}).status'),'UNVERIFIED');
    assert.equal(run('quoteFreshness({source_observed_at:new Date(serverNow()-700000).toISOString(),seen:serverNow(),market_status:"ACTIVE",snapshot_id:"snap-test",validation_status:"VALID",market_type:"s",selection:"home"}).status'),'STALE');
    assert.equal(run('quoteCanAct({source_observed_at:new Date(serverNow()).toISOString(),market_status:"SUSPENDED"})'),false);
    assert.equal(run('quoteCanAct({source_observed_at:new Date(serverNow()).toISOString(),market_status:"ACTIVE",snapshot_id:"snap-test",validation_status:"VALID",market_type:"s",selection:"home",freshness:"SOURCE_CONFLICT"})'),false);
    assert.equal(run('quoteCanAct({source_observed_at:new Date(serverNow()).toISOString(),market_status:"ACTIVE",snapshot_id:"snap-test",validation_status:"VALID",market_type:"s",selection:"home",is_live:false},{state:"in"})'),false);
    assert.equal(run('quoteFreshness({source_observed_at:new Date(serverNow()-30000).toISOString(),market_status:"ACTIVE",snapshot_id:"snap-test",validation_status:"VALID",market_type:"s",selection:"home",is_live:true},{state:"in",integrity:{thresholds:{live_ms:20000}}}).status'),'STALE');
    assert.equal(run('quoteFreshness({source_observed_at:new Date(serverNow()+100000).toISOString(),market_status:"ACTIVE",snapshot_id:"snap-test",validation_status:"VALID",market_type:"s",selection:"home"}).status'),'UNVERIFIED');
  });
  test(`${sport}: current and legacy close cannot masquerade as canonical close`,()=>{
    const run=load(sport);
    assert.equal(run('closeOf({mkt:{s:-4}})'),null);
    assert.equal(run('closeOf({close:{s:-4}})'),null);
    assert.equal(run('closeOf({integrity:{},close:{s:-4}}).s'),-4);
  });
  test(`${sport}: retrospective, provisional and missing CLV cannot enter verified summaries`,()=>{
    const run=load(sport);
    assert.equal(run('integrityMetric({clv:{pts:4,pct:5}},"line_clv_points",true)'),null);
    assert.equal(run('integrityMetric({integrity:{status:"PROVISIONAL_CLV",line_clv_points:2}},"line_clv_points",true)'),null);
    assert.equal(run('integrityMetric({integrity:{status:"RETROSPECTIVE_MARKET_MOVE",line_clv_points:2}},"line_clv_points")'),null);
    assert.equal(run('integrityMetric({integrity:{status:"VERIFIED_CLV",line_clv_points:0}},"line_clv_points",true)'),0);
    assert.equal(run('clvSigned(null," pts")'),'—');
    const html=run('clvLegHTML({line:-2.5,odds:-110,clv:{pts:20,pct:20}}, {placed:"2026-09-20T23:59:00Z"})');
    assert.match(html,/MISSING ENTRY SNAPSHOT/);assert.match(html,/No-vig probability CLV/);assert.match(html,/CLV-EV/);assert.doesNotMatch(html,/20 pts/);
  });
  test(`${sport}: best-price ranking excludes unverified and stale quotes`,()=>{
    const run=load(sport);
    run('S.books=[{key:"a"},{key:"b"}]');
    assert.equal(run('bestOf({a:{s:4,so:[100,100],seen:serverNow()},b:{s:3,so:[-110,-110],source_observed_at:new Date(serverNow()).toISOString(),market_status:"ACTIVE",snapshot_id:"snap-test",validation_status:"VALID",market_type:"s",selection:"home"}},"s","home").book'),'b');
  });
  test(`${sport}: board and detail preserve stale quote, remove betting action`,()=>{
    const run=load(sport,['views']);
    run('function flashAttr(){return {cls:"",style:"",label:""}}; var testGame={id:"g",state:"pre",home:{abbr:"H",short:"Home"},away:{abbr:"A",short:"Away"},books:{mgm:{s:-3,so:[-110,-110],source_observed_at:new Date(serverNow()-700000).toISOString(),market_status:"ACTIVE",snapshot_id:"snap-test",validation_status:"VALID",market_type:"s",selection:"home"}}}');
    const html=run('pxCell(testGame,"s","home","mgm",null)');
    assert.match(html,/STALE/);assert.match(html,/−3/);assert.doesNotMatch(html,/data-bet|data-mgmbet|href=/);
  });
  test(`${sport}: direct edge pricing rejects missing or stale target snapshot`,()=>{
    const run=load(sport,['edge']);
    assert.equal(run('edgePrice({books:{mgm:{s:3,so:[-110,-110]}}},"s","home",3,-110,"mgm")'),null);
    assert.equal(run('edgePrice({books:{mgm:{s:3,so:[-110,-110],source_observed_at:new Date(serverNow()).toISOString(),market_status:"ACTIVE"}}},"s","home",3,-110,"mgm")'),null);
  });
  test(`${sport}: displayed signals bind observed quote and deduplicate identical renders`,()=>{
    const run=load(sport);
    run('var sent=[]; function api(url,req){sent.push({url,body:JSON.parse(req.body)});return Promise.resolve({});}; var signalGame={id:"g",state:"pre",books:{mgm:{s:3,so:[-110,-110],source_observed_at:new Date(serverNow()-1000).toISOString(),market_status:"ACTIVE",snapshot_id:"snap-test",validation_status:"VALID",market_type:"s",selection:"home",snapshot_ids:{s:{home:"snap-1"}}}}}; var signalEdge={book:"mgm",mkt:"s",side:"home",line:3,odds:-110,p:.55,ev:.05}');
    run('recordDisplayedSignal(signalGame,signalEdge);recordDisplayedSignal(signalGame,signalEdge)');
    assert.equal(run('sent.length'),1);assert.equal(run('sent[0].body.entry_snapshot_id'),'snap-test');
    assert.ok(run('Date.parse(sent[0].body.features_as_of)<=Date.parse(sent[0].body.prediction_created_at)'));
    run('recordDisplayedSignal(signalGame,{...signalEdge,odds:100})');assert.equal(run('sent.length'),1);
  });
  test(`${sport}: unjournaled and invalid snapshots cannot become fresh`,()=>{
    const run=load(sport);
    assert.equal(run('quoteCanAct({source_observed_at:new Date(serverNow()).toISOString(),market_status:"ACTIVE"})'),false);
    assert.equal(run('quoteCanAct({snapshot_id:"bad",validation_status:"MALFORMED_QUOTE",source_observed_at:new Date(serverNow()).toISOString(),market_status:"ACTIVE"})'),false);
    assert.equal(run('quoteCanAct({snapshot_id:"half",validation_status:"VALID",market_type:"s",selection:"home",source_observed_at:new Date(serverNow()).toISOString(),market_status:"ACTIVE"},null,"h1s","home")'),false);
    assert.equal(run('integrityLocalInput(null)'), '');
  });
  test(`${sport}: failed signal persistence remains visibly unavailable`,async()=>{
    const run=load(sport);
    run('function api(){return Promise.reject(new Error("offline"))}; var g={id:"g",state:"pre",books:{mgm:{s:3,so:[-110,-110],snapshot_id:"s",validation_status:"VALID",market_type:"s",selection:"home",source_observed_at:new Date(serverNow()-1000).toISOString(),market_status:"ACTIVE"}}};var e={book:"mgm",mkt:"s",side:"home",line:3,odds:-110,p:.55,ev:.05}');
    assert.equal(run('recordDisplayedSignal(g,e)'), 'PENDING');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(run('recordDisplayedSignal(g,e)'), 'UNAVAILABLE');
    assert.match(run('signalEvidenceMessage("UNAVAILABLE")'), /could not be saved/);
  });
  test(`${sport}: no-vig pairing rejects contradictory source, time or opposing number`,()=>{
    const run=load(sport);
    run('var base={snapshot_id:"home",validation_status:"VALID",market_type:"s",period:"full_game",canonical_market_key:"g:s",canonical_event_id:"g",selection:"home",source:"provider",sportsbook:"book",source_observed_at:new Date(serverNow()-1000).toISOString(),market_status:"active",is_live:false,pair_id:"pair",line_value:-3,american_odds:-110};var L={s:-3,so:[-110,-110],integrity:{s:{home:{...base},away:{...base,snapshot_id:"away",selection:"away",line_value:3}}}}');
    assert.equal(run('quotePairCanDevig(L,{state:"pre"},"s")'),true);
    run('L.integrity.s.away.line_value=4');assert.equal(run('quotePairCanDevig(L,{state:"pre"},"s")'),false);
    run('L.integrity.s.away.line_value=3;L.integrity.s.away.source="other"');assert.equal(run('quotePairCanDevig(L,{state:"pre"},"s")'),false);
    run('L.integrity.s.away.source="provider";L.integrity.s.away.source_observed_at=new Date(serverNow()-5000).toISOString()');assert.equal(run('quotePairCanDevig(L,{state:"pre"},"s")'),false);
  });
  test(`${sport}: first-half and team-total panels cannot bypass freshness or final gates`,()=>{
    const run=load(sport,['sheets']);
    run('var g={id:"g",state:"post",home:{abbr:"H",short:"Home"},away:{abbr:"A",short:"Away"},h1:{cons:{s:-3,so:[-120,100],t:20,to:[-110,-110]}},tt:{home:{pts:21.5,over:-110,under:-110}}}');
    let html=run('halfPanel(g)');assert.doesNotMatch(html,/data-bet=/);assert.match(html,/UNVERIFIED/);assert.match(html,/−3/);
    run('g.state="pre"');html=run('halfPanel(g)');assert.doesNotMatch(html,/data-bet=/);
  });
  test(`${sport}: UTC provenance survives timezone boundaries`,()=>{
    const run=load(sport);assert.equal(run('integrityUTC("2026-09-20T23:30:00-07:00")'),'2026-09-21 06:30:00 UTC');
  });
}
