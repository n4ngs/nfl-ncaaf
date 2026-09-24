'use strict';
const { refForOwls } = require('./bet-links');
// Provider clocks, sides and periods survive normalization. Transport receipt is never a quote clock.
const BOOK_KEYS = Object.freeze({ pinnacle:'pin', ps3838:'ps3838', fanduel:'fd', draftkings:'dk', betmgm:'mgm', caesars:'czr', stations:'stn', south_point:'sp', westgate:'wg', circa:'circa', wynn:'wynn', hardrock:'hardrock', betr:'betr', bovada:'bovada', novig:'novig', '1xbet':'1xbet', bet365:'bet365', betonline:'betonline', betrivers:'betrivers', betus:'betus', bet105:'bet105', bookmaker:'bookmaker', lowvig:'lowvig', mybookie:'mybookie', stake:'stake', thescore:'thescore', thunderpick:'thunderpick', versus:'versus' });
const MARKETS = Object.freeze({h2h:['ml','books'],spreads:['s','books'],totals:['t','books'],first_half_h2h:['ml','h1'],first_half_spreads:['s','h1'],first_half_totals:['t','h1']});
const num = (x) => x === null || x === undefined || x === '' || typeof x === 'boolean' ? null : Number.isFinite(Number(x)) ? Number(x) : null;
function sourceTime(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const numeric = typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
  if (!numeric && (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))) return null;
  const at = numeric ? Number(value)*(Number(value)<1e12?1000:1) : Date.parse(value);
  return Number.isFinite(new Date(at).getTime()) ? new Date(at).toISOString() : null;
}
const norm = (v) => String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function phase(e) {
  const explicit = [e.isLive,e.is_live].filter((x)=>typeof x==='boolean');
  if (explicit.length && explicit.some((x)=>x!==explicit[0])) return null;
  const status = String(e.status || '').toLowerCase();
  const inferred = /^(live|in_progress|inprogress|in-play|in_play)$/.test(status) ? true : /^(scheduled|pregame|pre|not_started|notstarted)$/.test(status) ? false : null;
  if (explicit.length) return inferred!==null && explicit[0]!==inferred ? null : explicit[0];
  return inferred;
}
function state(...scopes) {
  for (const x of scopes) {
    if (!x) continue;
    if (x.suspended===true || x.is_suspended===true) return 'suspended';
    if (x.removed===true || x.available===false) return 'removed';
    const s=String(x.market_status ?? x.status ?? '').toLowerCase();
    if (/suspend|lock|pause/.test(s)) return 'suspended';
    if (/^(closed|settled|removed|ended|finished|final|cancelled|canceled|postponed)$/.test(s)) return 'removed';
  }
  if (scopes.some(x=>x?.stale===true)) return 'unverified';
  return 'active';
}
function rawEvents(payload,sport) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.sports?.[sport])) return payload.sports[sport];
  if (Array.isArray(payload?.[sport])) return payload[sport];
  if (Array.isArray(payload?.data)) return payload.data;
  if (payload?.data && typeof payload.data==='object') return Object.entries(payload.data).flatMap(([book,rows])=>Array.isArray(rows) ? rows.map(e=>({...e,__owlsBook:book})) : []);
  return [];
}
function emptyLine(e,live) { return {s:null,so:[null,null],t:null,to:[null,null],ml:[null,null],is_live:live,provider_event_id:String(e.id ?? e.eventId ?? ''),integrityMeta:{}}; }
function marketScore(sides) {
  const rows=Object.values(sides), clocks=rows.map(q=>Date.parse(q.source_observed_at));
  return clocks.length && clocks.every(Number.isFinite) ? Math.min(...clocks) : -Infinity;
}
function suspectZeroSpreads(events,sport) {
  const suspect=new Set(), cohorts=new Map();
  if(!['nfl','ncaaf'].includes(sport))return suspect;
  const probability=odds=>odds<0?-odds/(100-odds):100/(100+odds);
  for(const e of events) {
    if(phase(e)!==false || e.__owlsChannel==='ps3838-realtime' || !sourceTime(e.commence_time)
      || typeof e.home_team!=='string' || typeof e.away_team!=='string' || !norm(e.home_team) || !norm(e.away_team)
      || norm(e.home_team)===norm(e.away_team) || e.market_type==='outright')continue;
    for(const b of e.bookmakers || []) {
      if((b.key||e.__owlsBook)!=='betmgm')continue;
      const pair=m=>{
        if(!m || state(m,b,e)!=='active' || m.outcomes?.length!==2)return null;
        const rows=[e.home_team,e.away_team].map(name=>m.outcomes.find(o=>norm(o.name)===norm(name)));
        if(rows.some(o=>!o || num(o.price)===null || Math.abs(num(o.price))<100))return null;
        const clocks=rows.map(o=>sourceTime(o.last_update??m.last_update??b.last_update??e.lastUpdate));
        if(!clocks[0] || clocks[0]!==clocks[1])return null;
        const probabilities=rows.map(o=>probability(num(o.price)));
        return {rows,clock:clocks[0],homeProbability:probabilities[0]/(probabilities[0]+probabilities[1])};
      };
      const market=b.markets?.find(m=>m.key==='spreads'),spread=pair(market);
      if(!spread || spread.rows.some(o=>num(o.point)===null))continue;
      const moneyline=pair(b.markets?.find(m=>m.key==='h2h'));
      const zero=spread.rows.every(o=>num(o.point)===0),key=spread.clock.slice(0,16);
      const cohort=cohorts.get(key)||{games:new Map(),rows:[]};cohorts.set(key,cohort);
      const row={market,spread,moneyline,zero};cohort.rows.push(row);
      const game=`${norm(e.away_team)}@${norm(e.home_team)}:${sourceTime(e.commence_time)}`;
      const prior=cohort.games.get(game);if(!prior || prior.spread.clock<=spread.clock)cohort.games.set(game,row);
    }
  }
  // Observed upstream failure: an entire current BetMGM batch reports 0 handicap.
  // Require a >=5-game, >=90%-zero source-minute cohort AND a >=8pp same-clock
  // ML disagreement per game. Genuine PK prices, other periods/books and clocks survive.
  for(const {games,rows} of cohorts.values()) {
    if(games.size<5 || [...games.values()].filter(r=>r.zero).length/games.size<0.9)continue;
    for(const {market,spread,moneyline,zero} of rows)if(zero && moneyline?.clock===spread.clock
      && Math.abs(spread.homeProbability-moneyline.homeProbability)>=0.08)suspect.add(market);
  }
  return suspect;
}
// Observed upstream failure: Owls' BetMGM football `totals` market sometimes carries an alternate-ladder
// rung (45.5 at -525/+360 on a 58.5 game) with nothing marking it as an alternate. A pregame main spread or
// total is priced near even money on both sides; a -300 or +250 side means this is not the main line.
// Football pregame only: MLB run lines and live markets legitimately carry long prices.
function offMainLine(sport,market,live,candidates) {
  if(market==='ml' || live===true || !['nfl','ncaaf'].includes(sport))return false;
  return Object.values(candidates).some(q=>q.american_odds!==null && (q.american_odds<=-300 || q.american_odds>=250));
}
function normalizeBoard(payload,sport,options={}) {
  const grouped=new Map(),events=rawEvents(payload,sport),suspectZeros=suspectZeroSpreads(events,sport);
  for (const e of events) {
    const start=sourceTime(e.commence_time), home=e.home_team, away=e.away_team;
    if (!start || typeof home!=='string' || typeof away!=='string' || !norm(home) || !norm(away) || norm(home)===norm(away) || e.market_type==='outright') continue;
    const live=phase(e), id=`${sport}:${norm(away)}@${norm(home)}:${start}`;
    let event=grouped.get(id); if(!event) {event={id,home,away,start,books:{},live:{},h1:{}};grouped.set(id,event);}
    for (const b of e.bookmakers || []) {
      const rawBook=e.__owlsChannel==='ps3838-realtime' ? 'ps3838' : (b.key || e.__owlsBook);
      const book=BOOK_KEYS[rawBook]; if(!book) continue;
      for(const m of b.markets || []) {
        const spec=MARKETS[m.key]; if(!spec) continue;
        const [market,periodGroup]=spec;
        // Live first-half/F5 periods need their own live-period UI; never relabel as a full game.
        if (live===true && periodGroup==='h1') continue;
        const group=periodGroup==='h1'?'h1':live===true?'live':'books';
        const sides=market==='t'?['over','under']:['home','away'];
        const candidates={};
        for(const o of m.outcomes || []) {
          const side=market==='t'?(/^(over|under)$/i.test(o.name||'')?String(o.name).toLowerCase():null):norm(o.name)===norm(home)?'home':norm(o.name)===norm(away)?'away':null;
          if(!side) continue;
          const price=num(o.price), reportedLine=market==='ml'?null:num(o.point), quarantined=suspectZeros.has(m),line=quarantined?null:reportedLine;
          const q={line_value:line,american_odds:price,source_observed_at:sourceTime(o.last_update ?? m.last_update ?? b.last_update ?? e.lastUpdate),market_status:state(o,m,b,e,e.freshness,payload?.bookStatus?.[b.key]),is_live:live,
            provider_event_id:String(e.id ?? e.eventId ?? ''),provider_quote_id:o.selectionId ?? o.id ?? null,
            optionMarketId:o.marketId ?? m.id ?? null,optionId:o.selectionId ?? null,
            bet_link:refForOwls(b.event_link,book),provider_channel:e.__owlsChannel || options.channel || 'odds',
            pair_id:`owls:${e.id ?? id}:${b.key}:${m.key}:${m.last_update ?? b.last_update ?? e.lastUpdate ?? 'untimed'}`};
          if(price===null || Math.abs(price)<100 || (market!=='ml' && line===null)) q.market_status=q.market_status==='active'?'unverified':q.market_status;
          if(quarantined)Object.assign(q,{reported_line_value:reportedLine,reason_code:'UPSTREAM_ZERO_HANDICAP_CONFLICT'});
          if(candidates[side]) { candidates[side].market_status='unverified'; candidates[side].conflicted=true; continue; }
          candidates[side]=q;
        }
        // A suspended market can have no priced outcomes; preserve its explicit withdrawal evidence.
        if(!Object.keys(candidates).length && state(m,b,e)!=='active') for(const side of sides) candidates[side]={line_value:null,american_odds:null,source_observed_at:sourceTime(m.last_update ?? b.last_update ?? e.lastUpdate),market_status:state(m,b,e),is_live:live,provider_event_id:String(e.id ?? ''),provider_channel:e.__owlsChannel || options.channel || 'odds'};
        if(!Object.keys(candidates).length) continue;
        if(offMainLine(sport,market,live,candidates)) for(const q of Object.values(candidates))
          Object.assign(q,{reported_line_value:q.reported_line_value ?? q.line_value,line_value:null,market_status:q.market_status==='active'?'unverified':q.market_status,reason_code:'OFF_MAIN_LINE_PRICE'});
        const L=event[group][book] ||= emptyLine(e,live), old=L.integrityMeta[market];
        const candidateScore=marketScore(candidates), oldScore=old?marketScore(old):-Infinity;
        if(old && candidateScore<oldScore) continue;
        if(old && candidateScore===oldScore && JSON.stringify(old)!==JSON.stringify(candidates)) {
          // Same clock, different prices has no reliable ordering; don't manufacture a current line.
          const conflicting=sides.some(side=>old[side] && candidates[side] && (old[side].american_odds!==candidates[side].american_odds || old[side].line_value!==candidates[side].line_value));
          if(conflicting) for(const q of Object.values(candidates)) {q.market_status='unverified';q.conflicted=true;}
        }
        L.integrityMeta[market]=candidates;
        if(market==='ml') L.ml=sides.map(side=>candidates[side]?.american_odds ?? null);
        else {L[market]=candidates[market==='t'?'over':'home']?.line_value ?? null;L[market==='s'?'so':'to']=sides.map(side=>candidates[side]?.american_odds ?? null);}
        if(Array.isArray(m.limits)) L.limit=Math.max(0,...m.limits.map(x=>num(x.amount)||0)) || null;
      }
    }
  }
  return [...grouped.values()];
}
module.exports={BOOK_KEYS,normalizeBoard,sourceTime,phase,rawEvents};
