#!/usr/bin/env node
'use strict';
// Manual, read-only endpoint availability probe. Never imported by the server.
// Endpoints reviewed from oddswrap source; no third-party code, browser impersonation,
// cookies, tokens, or credentials are used. HTTP timing is NOT quote-update latency.
const https = require('node:https');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');
const SOURCES = Object.freeze([
  { book: 'draftkings', sport: 'NFL', url: 'https://sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues/88808/categories/493' },
  { book: 'bovada', sport: 'NFL', url: 'https://www.bovada.lv/services/sports/event/coupon/events/A/description/football/nfl?lang=en' },
]);
const LIMIT_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const INTERVAL_MS = 15000;
const TIME_FIELDS = new Set(['source_observed_at','updatedAt','updated_at','lastUpdated','last_updated','lastModified','lastModifiedDate','updateTime','timestamp']);
function timestamp(value) {
  if (value === null || value === '' || typeof value === 'boolean') return null;
  const t = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(t) && t >= Date.UTC(2000,0,1) && t <= Date.now()+86400000 ? t : null;
}
function liveFlag(event) {
  for (const key of ['live','isLive','inPlay','isInPlay']) if (typeof event[key] === 'boolean') return event[key];
  const s = String(event.eventStatus || event.status || '').toUpperCase();
  if (['LIVE','INPLAY','IN_PLAY','IN_PROGRESS'].includes(s)) return true;
  if (['PRE_GAME','PREGAME','PREMATCH','NOT_STARTED','SCHEDULED','FINISHED','FINAL','ENDED'].includes(s)) return false;
  return null;
}
function inspectPayload(book, payload) {
  let events = null;
  if (book === 'draftkings' && Array.isArray(payload?.events)) events = payload.events;
  if (book === 'bovada' && Array.isArray(payload) && payload.every(x => x && Array.isArray(x.events))) events = payload.flatMap(x => x.events);
  const fields = new Set(); let count = 0, nodes = 0;
  function visit(x, depth) {
    if (!x || typeof x !== 'object' || depth > 16 || ++nodes > 100000) return;
    for (const [k,v] of Object.entries(x)) {
      if (TIME_FIELDS.has(k) && timestamp(v) !== null) { fields.add(k); count++; }
      if (v && typeof v === 'object') visit(v, depth+1);
    }
  }
  visit(payload,0);
  const flags = events?.map(liveFlag) || [];
  return { schema_recognized: events !== null, event_count: events?.length ?? null,
    live_count: events && flags.every(x => x !== null) ? flags.filter(Boolean).length : null,
    live_count_confirmed_minimum: events ? flags.filter(x => x === true).length : null,
    live_status_unknown_count: events ? flags.filter(x => x === null).length : null,
    timestamp_candidate_fields: [...fields].sort(), timestamp_candidate_count: count,
    usable_source_quote_timestamp_verified: false,
    timestamp_note: 'Candidate update fields are not validated quote observation times; event start times are excluded.' };
}
function requestStats(source) {
  return new Promise(resolve => {
    const start = performance.now(), requested_at = new Date().toISOString();
    let done = false, timer, res, bytes = 0, headMs = null;
    const finish = extra => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ book:source.book, sport:source.sport, endpoint:source.url, requested_at,
        http_status:res?.statusCode ?? null, headers_ms:headMs, transport_ms:Math.round(performance.now()-start), bytes,
        cache_age_seconds:res?.headers.age && /^\d+$/.test(res.headers.age) ? Number(res.headers.age) : null,
        http_date:res?.headers.date || null, content_type:res?.headers['content-type'] || null, ...extra });
    };
    const req = https.get(source.url, { headers: { Accept:'application/json', 'User-Agent':'THE.BOARD-availability-probe/1.0' } }, response => {
      res=response; headMs=Math.round(performance.now()-start);
      if (response.statusCode !== 200) { response.destroy(); finish({error:'HTTP_STATUS',stop_reason:[403,429].includes(response.statusCode)?'ACCESS_OR_RATE_LIMIT':'NON_200'}); return; }
      const chunks=[];
      response.on('data',chunk => { bytes += chunk.length; if (bytes > LIMIT_BYTES) { response.destroy(); finish({error:'BYTE_LIMIT'}); } else chunks.push(chunk); });
      response.on('end',() => {
        const body=Buffer.concat(chunks);
        try { const payload=JSON.parse(body.toString('utf8')); finish({body_sha256:crypto.createHash('sha256').update(body).digest('hex'),...inspectPayload(source.book,payload)}); }
        catch { finish({error:'INVALID_JSON'}); }
      });
      response.on('error',e=>finish({error:e.code || 'RESPONSE_ERROR'}));
    });
    timer=setTimeout(()=>{ req.destroy(); finish({error:'TIMEOUT'}); },TIMEOUT_MS);
    req.on('error',e=>finish({error:e.code || 'NETWORK_ERROR'}));
  });
}
async function runBenchmark(samples=2, request=requestStats, wait=sleep) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 3) throw Error('Samples must be 1–3');
  const results=[], stopped=new Set();
  for (let round=0;round<samples;round++) {
    if (round) await wait(INTERVAL_MS);
    for (const source of SOURCES) {
      if (stopped.has(source.book)) continue;
      const result=await request(source); results.push({...result,sample:round+1});
      if (result.http_status !== 200 || result.error) stopped.add(source.book);
    }
    if (stopped.size===SOURCES.length) break;
  }
  return { measured_at:new Date().toISOString(), method:'Manual plain HTTPS GET; no redirect, authentication, browser impersonation, or application integration',
    interval_ms:INTERVAL_MS, timeout_ms:TIMEOUT_MS, limit_bytes:LIMIT_BYTES,
    warning:'Transport timings are not true quote latency. No source is promoted to actionable status by this probe.',
    skipped:[{book:'fanduel',reason:'Reference adapter requires an API-key query parameter; credential URLs excluded.'}], results };
}
module.exports={inspectPayload,runBenchmark};
if (require.main===module) {
  const args=process.argv.slice(2);
  if (args.some(x=>!/^--samples=[123]$/.test(x)) || args.length>1) { console.error('Usage: node tools/odds-probe.js [--samples=1|2|3]'); process.exitCode=1; }
  else runBenchmark(args.length?Number(args[0].split('=')[1]):2).then(x=>process.stdout.write(JSON.stringify(x,null,2)+'\n')).catch(()=>{console.error('Probe failed');process.exitCode=1;});
}
