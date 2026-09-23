'use strict';
const { sourceTime } = require('./owls-schema');
const { BOOK_KEYS } = require('./sharp-books');
const { refForSharp } = require('./bet-links');
const MARKETS = {moneyline:'ml',point_spread:'s',run_line:'s',total_points:'t',total_runs:'t',puck_line:'s',total_goals:'t'};
const norm = v => String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const finite = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
function normalizeBoard(payload, sport) {
  const rows = Array.isArray(payload) ? payload : payload?.data;
  if (!Array.isArray(rows)) return [];
  const events = new Map();
  const drawMarkets=new Set(sport==='nhl'?rows.filter(r=>r.market_type==='moneyline'&&r.selection_type==='draw').map(r=>r.sportsbook+':'+r.event_id):[]);
  for (const row of rows) {
    if (!row || row.league !== sport || !row.id || !row.event_id) continue;
    if(sport==='nhl'&&(drawMarkets.has(row.sportsbook+':'+row.event_id)||/regulation|60.?minute|3.?way/i.test(row.market_name||'')))continue;
    const market = MARKETS[row.market_type], book = BOOK_KEYS[row.sportsbook];
    if (!market || !book || row.is_main_line !== true || row.is_alternate_line === true || row.is_player_prop === true) continue;
    if (row.market_segment && row.market_segment !== 'full_game') continue;
    // Exchange lay and binary contracts have different payout semantics from sportsbook back prices.
    if (row.sportsbook === 'betfair_lay' || row.exchange || /^(polymarket|kalshi|robinhood|fanatics_markets|gemini)$/.test(row.sportsbook)) continue;
    const home = row.home?.name || row.home_team, away = row.away?.name || row.away_team, start = sourceTime(row.event_start_time);
    if (typeof home !== 'string' || typeof away !== 'string' || !norm(home) || !norm(away) || norm(home) === norm(away) || !start) continue;
    const sides = market === 't' ? ['over','under'] : ['home','away'];
    const side = row.selection_type;
    if (!sides.includes(side)) continue;
    const live = typeof row.is_live === 'boolean' ? row.is_live : null;
    const group = live === true ? 'live' : 'books';
    const id = row.event_uuid ? `sharp:${sport}:${row.event_uuid}` : `${sport}:${norm(away)}@${norm(home)}:${start}`;
    const event = events.get(id) || { id,home,away,start,books:{},live:{},h1:{},candidates:new Map(),starts:new Map() };
    // A stable event id does not excuse conflicting home/away attribution.
    if (norm(event.home)!==norm(home) || norm(event.away)!==norm(away)) continue;
    events.set(id,event);
    event.starts.set(start,(event.starts.get(start)||0)+1);
    const line = market === 'ml' ? null : finite(row.line), odds = finite(row.odds_american);
    const homeLine = market === 's' && side === 'away' && line !== null ? -line : line;
    const pair = `${row.event_uuid || row.event_id}:${row.market_type}:${homeLine ?? 'ml'}`;
    const key = `${group}:${book}:${market}:${pair}`;
    const candidate = event.candidates.get(key) || {group,book,market,sides:{},pair,homeLine,eventId:String(row.event_id)};
    event.candidates.set(key,candidate);
    const delivered = sourceTime(row.timestamp);
    let status = row.is_active === false ? 'suspended' : row.is_active == null || row.is_active === true ? 'active' : 'unverified';
    if (row.is_stale_pregame_price === true || row.is_impossible_scoreline === true || !delivered || live === null || odds === null || Math.abs(odds) < 100 || market !== 'ml' && line === null) status = status === 'suspended' ? status : 'unverified';
    const q = {line_value:line,american_odds:odds,source_observed_at:null,
      provider_received_at:delivered,timestamp_kind:'FEED_DELIVERY',market_status:status,is_live:live,
      provider_event_id:String(row.event_id),provider_quote_id:String(row.id),optionMarketId:row.market_id || null,optionId:row.selection_id || null,
      bet_link:refForSharp(row,book),provider_channel:'sharp',pair_id:`sharp:${book}:${pair}`,max_bet:finite(row.max_bet)};
    const prior = candidate.sides[side];
    const at = Date.parse(delivered), previousAt = Date.parse(prior?.provider_received_at);
    if (prior && Number.isFinite(previousAt) && (!Number.isFinite(at) || at < previousAt)) continue;
    if (prior && at === previousAt && (prior.american_odds !== q.american_odds || prior.line_value !== q.line_value)) q.market_status = 'unverified', q.conflicted = true;
    candidate.sides[side] = q;
  }
  for (const event of events.values()) {
    const times=[...event.starts.keys()].map(Date.parse);
    if(Math.max(...times)-Math.min(...times)>3*3600000){events.delete(event.id);continue;}
    event.start=[...event.starts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0];
    delete event.starts;
    const selected = new Map();
    for (const candidate of event.candidates.values()) {
      const key = `${candidate.group}:${candidate.book}:${candidate.market}`;
      const sides = candidate.market === 't' ? ['over','under'] : ['home','away'];
      candidate.complete = sides.every(side => candidate.sides[side]);
      candidate.score = Math.min(...Object.values(candidate.sides).map(q => Date.parse(q.provider_received_at) || -Infinity));
      const prior = selected.get(key);
      if (!prior || candidate.complete && !prior.complete || candidate.complete === prior.complete && candidate.score > prior.score) selected.set(key,candidate);
      else if (candidate.complete === prior.complete && candidate.score === prior.score && candidate.pair !== prior.pair) for (const q of Object.values(prior.sides)) q.market_status='unverified',q.conflicted=true;
    }
    for (const c of selected.values()) {
      const L = event[c.group][c.book] ||= {s:null,so:[null,null],t:null,to:[null,null],ml:[null,null],is_live:c.group === 'live' ? true : Object.values(c.sides)[0].is_live,provider_event_id:c.eventId,integrityMeta:{}};
      L.integrityMeta[c.market] = c.sides;
      if (c.market === 'ml') L.ml = ['home','away'].map(side => c.sides[side]?.american_odds ?? null);
      else {L[c.market] = c.homeLine;L[c.market === 's'?'so':'to'] = (c.market === 's'?['home','away']:['over','under']).map(side=>c.sides[side]?.american_odds ?? null);}
      const all = Object.values(L.integrityMeta).flatMap(Object.values);
      L.provider_received_at = all.every(q=>q.provider_received_at) ? all.map(q=>q.provider_received_at).sort()[0] : null;
      const limits = all.map(q=>q.max_bet).filter(v=>v !== null && v > 0);L.limit = limits.length ? Math.min(...limits) : null;
    }
    delete event.candidates;
  }
  return [...events.values()];
}
module.exports = { normalizeBoard, BOOK_KEYS };
