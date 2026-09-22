'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeBoard}=require('../shared/sharp-schema');
const row=(side='home',more={})=>({id:side,event_id:'e1',event_uuid:'canonical',league:'mlb',home_team:'Dodgers',away_team:'Giants',event_start_time:'2026-09-23T01:10Z',sportsbook:'pinnacle',market_type:'run_line',selection_type:side,line:side==='home'?-1.5:1.5,odds_american:-110,is_live:false,is_active:true,is_main_line:true,timestamp:'2026-09-22T22:00:00Z',...more});
const normalize=rows=>normalizeBoard({data:rows},'mlb');
test('Sharp prices retain feed delivery without fabricating a source quote clock',()=>{const e=normalize([row(),row('away')])[0],L=e.books.pin;assert.equal(L.s,-1.5);assert.equal(L.integrityMeta.s.home.source_observed_at,null);assert.equal(L.provider_received_at,'2026-09-22T22:00:00.000Z');assert.equal(L.integrityMeta.s.home.timestamp_kind,'FEED_DELIVERY');});
test('Sharp delivery heartbeat never changes quote pair identity',()=>{const a=normalize([row()])[0].books.pin,b=normalize([row('home',{timestamp:'2026-09-22T22:01Z'})])[0].books.pin;assert.equal(a.integrityMeta.s.home.pair_id,b.integrityMeta.s.home.pair_id);});
test('Sharp preserves pick-em and even prices with authoritative canonical sides',()=>{const e=normalize([row('home',{line:0,odds_american:100,selection:'LAD'}),row('away',{line:0})])[0];assert.equal(e.books.pin.s,0);assert.deepEqual(e.books.pin.so,[100,-110]);});
test('Sharp never pairs two different handicap rungs',()=>{const e=normalize([row(),row('away',{line:2.5})])[0];assert.equal(Object.keys(e.books.pin.integrityMeta.s).length,1);});
test('Sharp suspended, stale-pregame, impossible and unknown phase rows retain their restrictions',()=>{for(const more of [{is_active:false},{is_stale_pregame_price:true},{is_impossible_scoreline:true},{is_live:null}]) {const q=normalize([row('home',more)])[0].books.pin.integrityMeta.s.home;assert.notEqual(q.market_status,'active');}});
test('Sharp main period filtering excludes alternates, props, partial periods and exchange contracts',()=>{for(const more of [{is_main_line:false},{is_alternate_line:true},{market_segment:'1st_half'},{is_player_prop:true},{sportsbook:'betfair_lay'},{sportsbook:'kalshi'},{exchange:'kalshi'},{league:'nfl'},{event_start_time:'naive'},{selection_type:'home_over'}])assert.deepEqual(normalize([row('home',more)]),[]);});
test('Sharp live and pregame records stay in independent spaces',()=>{const e=normalize([row(),row('away',{is_live:true})])[0];assert.ok(e.books.pin);assert.ok(e.live.pin);assert.equal(e.books.pin.is_live,false);assert.equal(e.live.pin.is_live,true);});
test('Sharp regional books stay distinct and catalog aliases remain canonical',()=>{const e=normalize([row('home',{sportsbook:'Bet365 US'}),row('home',{sportsbook:'onexbet'})])[0];assert.ok(e.books.bet365_us);assert.ok(e.books['1xbet']);assert.equal(e.books.bet365,undefined);});
test('Sharp same-row old refresh cannot replace newer price, equal-clock conflict blocks evidence',()=>{for(const rows of [[row(),row('home',{timestamp:'2026-09-22T22:01Z',odds_american:-125})],[row('home',{timestamp:'2026-09-22T22:01Z',odds_american:-125}),row()]])assert.equal(normalize(rows)[0].books.pin.so[0],-125);assert.equal(normalize([row(),row('home',{odds_american:-125})])[0].books.pin.integrityMeta.s.home.conflicted,true);});

test('Sharp stable atlas event joins book-specific start drift into one matchup',()=>{
 const rows=[row(),row('away'),row('home',{id:'fd-home',sportsbook:'fanduel',event_start_time:'2026-09-23T02:10Z'}),row('away',{id:'fd-away',sportsbook:'fanduel',event_start_time:'2026-09-23T02:10Z'})];
 const out=normalize(rows);assert.equal(out.length,1);assert.ok(out[0].books.pin);assert.ok(out[0].books.fd);assert.equal(out[0].start,'2026-09-23T01:10:00.000Z');
});
test('Sharp atlas collisions across distant starts cannot merge different fixtures',()=>{assert.deepEqual(normalize([row(),row('away',{event_start_time:'2026-09-24T01:10Z'})]),[]);});

test('Sharp shared event identity cannot reverse team attribution',()=>{const e=normalize([row(),row('away',{sportsbook:'fanduel',home_team:'Giants',away_team:'Dodgers'})])[0];assert.ok(e.books.pin);assert.equal(e.books.fd,undefined);});
