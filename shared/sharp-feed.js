'use strict';
// One server-owned Sharp stream. Provider delivery timestamps are never quote-observation clocks.
const SPORTS = ['nfl', 'ncaaf', 'mlb', 'nhl'];
const MARKETS = ['moneyline', 'point_spread', 'run_line', 'total_points', 'total_runs', 'puck_line', 'total_goals'];
const seqOf = frame => typeof frame.global_seq === 'string' && /^\d+$/.test(frame.global_seq) ? frame.global_seq : Number.isSafeInteger(frame.seq) ? String(frame.seq) : null;
const compareSeq = (a, b) => a.length - b.length || a.localeCompare(b);
const iso = value => Number.isFinite(Date.parse(value)) ? value : null;
const keepRow = row => row && row.id != null && SPORTS.includes(row.league) && MARKETS.includes(row.market_type) && row.is_main_line === true && row.is_alternate_line !== true;

function createSharpFeed(options = {}) {
  const key = String(options.apiKey || '').trim();
  const now = options.now || Date.now, later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
  const normalize = options.normalizeBoard || require('./sharp-schema').normalizeBoard;
  const fetcher = options.fetchImpl || globalThis.fetch;
  const factory = options.wsFactory || ((url, settings) => new (require('ws'))(url, settings));
  const timers = new Map(), snapshots = new Map(), controllers = new Set();
  let rows = new Map(), versions = new Map(), touched = new Map(), stage = null, stageVersions = null;
  let socket = null, started = false, stopped = false, wsBlocked = false, restBlocked = false;
  let initialRows = 0;
  let revision = 0, fullRevision = 0, checkpoint = null, pendingFloor = null, filterHash = null;
  let lastMessage = 0, heartbeatMs = 30000, pongMs = 120000, reconnects = 0, dirty = new Set();
  let restRunning = false, restUntil = 0, restSince = {true:null,false:null}, lastRestBaseline = 0;
  const state = {provider:'sharp',enabled:!!key,connection:key?'idle':'disabled',connected:false,streamHealthy:false,
    snapshotComplete:false,websocketAccess:'unknown',tier:null,booksAllowed:[],bookLimit:null,books:[],rows:0,
    receivedAt:null,lastFrameAt:null,lastOddsAt:null,providerDeliveredAt:null,deliveryLatencyMs:null,dispatchLatencyMs:null,
    frames:0,oddsFrames:0,reconnects:0,resyncs:0,restRequests:0,restDelaySeconds:null,restRateLimit:null,lastError:null};
  const bookReceived = new Map();
  let booksBySport = Object.fromEntries(SPORTS.map(s=>[s,[]]));
  function schedule(name, fn, ms) {
    if (timers.has(name)) cancel(timers.get(name));
    const timer = later(() => {timers.delete(name); if (!stopped) fn();}, Math.max(0, ms));
    timer?.unref?.(); timers.set(name,timer);
  }
  function clear(name) { if (timers.has(name)) cancel(timers.get(name)); timers.delete(name); }
  function status() { return {...state,lastReceivedAt:state.receivedAt?Date.parse(state.receivedAt):null,transportLatencyMs:state.deliveryLatencyMs,latencyKind:'PROVIDER_DELIVERY',books:Object.fromEntries(SPORTS.map(s=>[s,[...booksBySport[s]]])),allBooks:[...state.books],booksAllowed:[...state.booksAllowed],bookReceivedAt:Object.fromEntries(bookReceived)}; }
  function report() { options.onStatus?.(status()); }
  function publish() {
    clear('publish');
    if (!dirty.size || stopped) return;
    const data = [...rows.values()], receivedAt = state.receivedAt ? Date.parse(state.receivedAt) : null;
    state.rows = rows.size; state.books = [...new Set(data.map(row=>row.sportsbook).filter(Boolean))].sort();
    booksBySport = Object.fromEntries(SPORTS.map(s=>[s,[...new Set(data.filter(r=>r.league===s).map(r=>r.sportsbook).filter(Boolean))].sort()]));
    for (const sport of dirty) {
      const began = now();
      const events = normalize({data:data.filter(row=>row.league===sport)},sport);
      state.dispatchLatencyMs = Math.max(0, now() - (receivedAt || began));
      const frame = {events,receivedAt,status:status()}; snapshots.set(sport,frame); options.onUpdate?.(sport,frame);
    }
    dirty.clear();
  }
  function changed(sports = SPORTS, immediate = false) {
    for (const sport of sports) dirty.add(sport);
    state.receivedAt = new Date(now()).toISOString();
    if (immediate) publish(); else if (!timers.has('publish')) schedule('publish',publish,25);
  }
  function snapshot(sport) { return {...(snapshots.get(sport) || {events:[],receivedAt:null}),status:status()}; }
  function upsert(target, stamps, row, sequence, locked = false, touch = false) {
    if (!row || row.id == null) return;
    const id = String(row.id), previous = target.get(id), priorSeq = stamps.get(id);
    if (sequence && priorSeq && compareSeq(sequence,priorSeq) <= 0) return;
    if (sequence) stamps.set(id,sequence);
    if (keepRow(row)) target.set(id,locked?{...row,is_active:false}:row); else target.delete(id);
    if (touch) touched.set(id,++revision);
    if (previous?.league) dirty.add(previous.league);
    if (keepRow(row)) dirty.add(row.league);
  }
  function remove(target, stamps, idValue, sequence, touch = false) {
    const id = String(idValue), previous = target.get(id), priorSeq = stamps.get(id);
    if (sequence && priorSeq && compareSeq(sequence,priorSeq) <= 0) return;
    if (sequence) stamps.set(id,sequence);
    target.delete(id); if (touch) touched.set(id,++revision);
    if (previous?.league) dirty.add(previous.league);
  }
  function closeSocket() { const previous = socket; socket = null; if (previous) {try {previous.terminate();} catch {try {previous.close();} catch {}}} }
  function reconnect(fresh = false, delay) {
    if (fresh) checkpoint = null;
    clear('snapshot'); state.connected = false; state.streamHealthy = false; state.connection = 'recovering'; stage = null; stageVersions = null;
    closeSocket(); report(); schedule('rest',poll,0);
    if (!wsBlocked && !stopped) schedule('reconnect',connect,delay ?? Math.min(30000,1000 * 2 ** Math.min(reconnects++,5)));
  }
  function resync() {
    checkpoint = null; state.snapshotComplete = false; state.streamHealthy = false; state.lastError = 'stream_resync_required'; state.resyncs++;
    // A fresh connection is the documented fallback when client resync is unavailable.
    // Reconnecting also supplies a new conservative connected.global_seq baseline.
    reconnect(true,1000);
  }
  function onFrame(frame) {
    if (!frame || typeof frame.type !== 'string') return;
    lastMessage = now(); state.lastFrameAt = new Date(lastMessage).toISOString(); state.frames++;
    if (iso(frame.timestamp)) {
      state.providerDeliveredAt = frame.timestamp;
      const latency = now() - Date.parse(frame.timestamp); state.deliveryLatencyMs = latency >= 0 ? latency : null;
    }
    if (frame.type === 'connected') {
      state.connected = true; state.connection = 'snapshot'; state.websocketAccess = 'enabled'; state.lastError = null;
      state.tier = typeof frame.tier === 'string' ? frame.tier : null;
      state.booksAllowed = Array.isArray(frame.books?.allowed) ? frame.books.allowed.filter(x=>typeof x==='string') : [];
      state.bookLimit = Number.isFinite(frame.books?.max) ? frame.books.max : null;
      heartbeatMs = Math.max(1000,Number(frame.heartbeat_interval_ms)||30000); pongMs = Math.max(heartbeatMs*2,Number(frame.pong_timeout_ms)||120000);
      pendingFloor = seqOf(frame); filterHash = typeof frame.filter_hash === 'string' ? frame.filter_hash : null;
      const resumed = frame.resumed === true && checkpoint !== null;
      initialRows = 0; schedule('snapshot',()=>{state.lastError='snapshot_timeout';reconnect(true);},30000);
      stage = resumed ? new Map(rows) : new Map(); stageVersions = resumed ? new Map(versions) : new Map();
      if (!resumed) checkpoint = null;
      reconnects = 0; report(); return;
    }
    if (frame.type === 'initial') {
      if (!stage || !Array.isArray(frame.data)) return resync();
      initialRows += frame.data.length;
      const book = frame.source || frame.book; if(typeof book==='string')bookReceived.set(book,new Date(now()).toISOString());
      for (const row of frame.data) upsert(stage,stageVersions,row,null);
      return;
    }
    if (frame.type === 'snapshot:complete') {
      if (frame.mode !== 'resume' && Number.isInteger(frame.total_odds) && frame.total_odds !== initialRows) return resync();
      if (!stage || frame.gap_detected === true || frame.mode === 'resume' && !seqOf({global_seq:frame.last_seq})) return resync();
      clear('snapshot'); rows = stage; versions = stageVersions; stage = null; stageVersions = null;
      touched = new Map(); fullRevision = ++revision;
      // Never advance this from live data or heartbeat. Global delivery can reorder across books.
      checkpoint = frame.mode === 'resume' ? frame.last_seq : pendingFloor;
      state.snapshotComplete = true; state.streamHealthy = true; state.connection = 'streaming'; state.lastError = null;
      restSince = {true:null,false:null}; clear('rest'); changed(SPORTS,true); report(); return;
    }
    if (frame.type === 'resync_required') return resync();
    if (frame.type === 'error') {
      const code = frame.code;
      if (['invalid_api_key','tier_restricted','too_many_streams','not_authenticated'].includes(code)) {
        wsBlocked = true; state.websocketAccess = code === 'tier_restricted' ? 'not_included' : 'denied'; state.lastError = code;
        return reconnect(true);
      }
      return;
    }
    if (['odds:update','odds:locked','odds:removed'].includes(frame.type)) {
      const target = stage || rows, stamps = stageVersions || versions, sequence = seqOf(frame);
      if (frame.type === 'odds:removed') {
        if (!Array.isArray(frame.ids)) return resync();
        for (const id of frame.ids) remove(target,stamps,id,sequence,!stage);
      } else {
        if (!Array.isArray(frame.data)) return resync();
        for (const row of frame.data) upsert(target,stamps,row,sequence,frame.type==='odds:locked',!stage);
      }
      state.oddsFrames++; state.lastOddsAt = new Date(now()).toISOString();
      const book = frame.source || frame.book; if(typeof book==='string')bookReceived.set(book,state.lastOddsAt);
      if (!stage && state.snapshotComplete) changed([],false);
    }
  }
  function connect() {
    if (stopped || !key || wsBlocked || socket) return;
    state.connection = 'connecting'; state.reconnects++; report();
    const url = new URL('wss://ws.sharpapi.io');
    url.search = new URLSearchParams({api_key:key,channels:'odds',league:SPORTS.join(','),market:MARKETS.join(','),...(checkpoint?{from_seq:checkpoint,...(filterHash?{filter_hash:filterHash}:{})}:{})}).toString();
    let peer;
    try { peer = factory(url.toString(),{handshakeTimeout:15000,maxPayload:4*1024*1024,perMessageDeflate:false}); } catch { state.lastError = 'connection_failed'; return reconnect(); }
    socket = peer; lastMessage = now();
    peer.on('message',raw=>{if(socket!==peer||stopped)return;let frame;try {frame=JSON.parse(String(raw));}catch{return resync();}onFrame(frame);});
    peer.on('error',()=>{if(socket===peer&&!stopped){state.lastError='connection_failed';reconnect();}});
    peer.on('unexpected-response',(_request,response)=>{
      response?.resume?.(); if(socket!==peer||stopped)return;
      if ([401,403].includes(response?.statusCode)) {wsBlocked=true;state.websocketAccess=response.statusCode===403?'not_included':'denied';}
      state.lastError = `websocket_http_${Number(response?.statusCode)||0}`; reconnect(true);
    });
    peer.on('close',(code,reason)=>{
      if(socket!==peer||stopped)return;
      if(code===4001){wsBlocked=true;state.lastError=String(reason).includes('displaced')?'stream_displaced':'websocket_auth_failed';}
      else state.lastError=`websocket_closed_${code}`;
      reconnect(code===1008||code===1012||code===4003);
    });
  }
  function watchdog() {
    const threshold = Math.min(3*heartbeatMs,pongMs-heartbeatMs);
    if(socket && now()-lastMessage>=threshold){state.lastError='stream_silent';reconnect();}
    else if(socket?.readyState===1){try {socket.send(JSON.stringify({type:'ping'}));}catch{reconnect();}}
    schedule('watchdog',watchdog,Math.min(25000,heartbeatMs));
  }
  async function request(path, params) {
    if (restBlocked || now()<restUntil || stopped) throw new Error('rest_backoff');
    const controller = new AbortController(); controllers.add(controller);
    const timeout = later(()=>controller.abort(),15000); timeout?.unref?.();
    try {
      state.restRequests++;
      const response = await fetcher(`https://api.sharpapi.io/api/v1/${path}?${new URLSearchParams(params)}`,{headers:{'X-API-Key':key,Accept:'application/json','User-Agent':'THE.BOARD/1.0'},signal:controller.signal,redirect:'error'});
      const limit = Number(response.headers.get('x-ratelimit-limit')), remaining = Number(response.headers.get('x-ratelimit-remaining')), reset = Number(response.headers.get('x-ratelimit-reset'));
      if(limit>0)state.restRateLimit=limit;
      const delay = response.headers.get('x-data-delay'); if(delay!==null&&Number.isFinite(Number(delay)))state.restDelaySeconds=Number(delay);
      if(remaining===0&&reset>0)restUntil=Math.max(restUntil,reset*1000+1000);
      if(!response.ok){
        if(response.status===401||response.status===403)restBlocked=true;
        if(response.status===429){const retry=response.headers.get('retry-after');const seconds=Number(retry);restUntil=Math.max(restUntil,now()+(Number.isFinite(seconds)&&seconds>0?seconds*1000:60000));}
        throw new Error(`rest_http_${response.status}`);
      }
      const payload = await response.json();
      if(!Array.isArray(payload.data)||!payload.pagination||typeof payload.pagination.has_more!=='boolean')throw new Error('rest_invalid_payload');
      return payload;
    } finally {cancel(timeout);controllers.delete(controller);}
  }
  const params = live => ({league:SPORTS.join(','),market:MARKETS.join(','),is_live:String(live)});
  async function restSnapshot(live) {
    const result = new Map(), seen = new Set(); let cursor = null, since = null;
    for(let page=0;page<1000;page++){
      const payload = await request('odds',{...params(live),is_main_line:'true',limit:'200',...(cursor?{cursor}:{})});
      if(!since)since=iso(payload.updated_at);
      if(['warming','store_empty'].includes(payload.meta?.store?.reason))throw new Error('rest_store_warming');
      for(const row of payload.data)if(keepRow(row))result.set(String(row.id),row);
      if(!payload.pagination.has_more){if(!since)throw new Error('rest_missing_watermark');return {rows:result,since};}
      cursor=payload.pagination.next_cursor;if(typeof cursor!=='string'||!cursor||seen.has(cursor))throw new Error('rest_incomplete_snapshot');seen.add(cursor);
    }
    throw new Error('rest_snapshot_too_large');
  }
  async function restDelta(live,since) {
    const changes=[],removed=[];let offset=0;
    for(let page=0;page<1000;page++){
      const payload=await request('odds/delta',{...params(live),since,limit:'500',offset:String(offset)});
      if(payload.since_clamped || payload.meta?.since_clamped || payload.removed_truncated || payload.meta?.removed_truncated)throw new Error('rest_rebaseline');
      if((payload.overflow || payload.meta?.overflow) && !payload.pagination.has_more)throw new Error('rest_rebaseline');
      changes.push(...payload.data);removed.push(...(Array.isArray(payload.removed)?payload.removed:[]));
      if(!payload.pagination.has_more){const end=iso(payload.meta?.server_time||payload.updated_at);if(!end)throw new Error('rest_missing_watermark');return {changes,removed,since:end};}
      const next=payload.pagination.next_offset;if(!Number.isInteger(next)||next<=offset||next>500)throw new Error('rest_rebaseline');offset=next;
    }
    throw new Error('rest_rebaseline');
  }
  async function poll() {
    if(stopped||restBlocked||!key||state.streamHealthy||restRunning)return;
    if(now()<restUntil)return schedule('rest',poll,restUntil-now());
    restRunning=true;const requested=revision,fullAtStart=fullRevision;
    try{
      const baseline=!restSince.true||!restSince.false||now()-lastRestBaseline>5*60e3;
      const outcomes=await Promise.allSettled([true,false].map(live=>baseline?restSnapshot(live):restDelta(live,restSince[String(live)])));
      const failed=outcomes.find(result=>result.status==='rejected');if(failed)throw failed.reason;
      const results=outcomes.map(result=>result.value);
      if(stopped||state.streamHealthy||fullAtStart!==fullRevision)return;
      if(baseline){
        const replacement=new Map([...results[0].rows,...results[1].rows]);
        for(const [id,version]of touched)if(version>requested){if(rows.has(id))replacement.set(id,rows.get(id));else replacement.delete(id);}
        rows=replacement;lastRestBaseline=now();dirty=new Set(SPORTS);
      }else{
        for(const result of results){
          for(const row of result.changes)if((touched.get(String(row.id))||0)<=requested)upsert(rows,versions,row,null);
          for(const removed of result.removed){const id=typeof removed==='string'?removed:removed?.id;if(id!=null&&(touched.get(String(id))||0)<=requested)remove(rows,versions,id,null);}
        }
      }
      restSince={true:results[0].since,false:results[1].since};state.connection='polling';state.snapshotComplete=true;state.lastError=null;changed(SPORTS,true);report();
    }catch(error){
      const safe = /^rest_[a-z_0-9]+$/.test(error.message)?error.message:'rest_connection_failed';state.lastError=safe;
      if(safe==='rest_rebaseline')restSince={true:null,false:null};
      if(now()>=restUntil)restUntil=now()+10000;report();
    }finally{restRunning=false;if(!stopped&&!restBlocked&&!state.streamHealthy)schedule('rest',poll,Math.max(5000,restUntil-now()));}
  }
  return {start(){if(started||!key)return;started=true;stopped=false;connect();schedule('watchdog',watchdog,25000);schedule('rest',poll,20000);},
    stop(){stopped=true;for(const timer of timers.values())cancel(timer);timers.clear();for(const controller of controllers)controller.abort();closeSocket();state.connected=false;state.streamHealthy=false;state.connection='stopped';},
    status,snapshot};
}
module.exports = {createSharpFeed,SPORTS,MARKETS};
