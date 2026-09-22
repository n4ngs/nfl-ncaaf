'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {inspectPayload,runBenchmark}=require('../tools/odds-probe');
test('kickoff and receipt fields do not become quote observation timestamps',()=>{
 const x=inspectPayload('draftkings',{events:[{id:1,startEventDate:'2026-01-01T12:00:00Z',fetched_at:'2026-01-01T12:00:00Z'}]});
 assert.equal(x.event_count,1);assert.equal(x.live_count,null);assert.equal(x.live_status_unknown_count,1);
 assert.equal(x.timestamp_candidate_count,0);assert.equal(x.usable_source_quote_timestamp_verified,false);
});
test('Bovada groups retain explicit live flags and candidate-only timestamp evidence',()=>{
 const x=inspectPayload('bovada',[{events:[{id:1,live:true,price:{updatedAt:'2026-01-01T12:00:00Z'}}]},{events:[{id:2,live:false}]}]);
 assert.equal(x.event_count,2);assert.equal(x.live_count,1);assert.deepEqual(x.timestamp_candidate_fields,['updatedAt']);
 assert.equal(x.usable_source_quote_timestamp_verified,false);
 assert.equal(inspectPayload('draftkings',{}).event_count,null);
});
test('403 and 429 each stop that book without alternate endpoints or repeat requests',async()=>{
 const calls=[],waits=[];
 const x=await runBenchmark(3,async s=>{calls.push(s.book);return {http_status:s.book==='draftkings'?403:429};},async n=>waits.push(n));
 assert.equal(calls.length,2);assert.equal(x.results.length,2);assert.deepEqual(waits,[]);
});
test('subsequent rounds are separated by at least 15 seconds and samples are capped',async()=>{
 const waits=[];const x=await runBenchmark(2,async()=>({http_status:200}),async n=>waits.push(n));
 assert.equal(x.results.length,4);assert.deepEqual(waits,[15000]);await assert.rejects(runBenchmark(4));
});
