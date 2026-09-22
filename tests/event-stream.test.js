'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {PassThrough}=require('node:stream');
const {pipeEventStream,acceptsGzip}=require('../shared/event-stream');
test('SSE gzip delivers complete events without waiting for connection close',async()=>{
 const upstream=new PassThrough(),response=new PassThrough(),decoder=zlib.createGunzip();let headers,code,text='';
 response.writeHead=(status,value)=>{code=status;headers=value;};response.pipe(decoder);
 const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('SSE buffered the event')),1000);decoder.on('data',chunk=>{text+=chunk;if(text.includes('\n\n')){clearTimeout(timer);resolve();}});decoder.on('error',reject);});
 assert.equal(pipeEventStream(upstream,response,{'accept-encoding':'br, gzip'},{'content-type':'text/event-stream','content-length':'999',vary:'cookie'},200),true);
 upstream.write('event: odds\ndata: {"price":-110}\n\n');await ready;
 assert.equal(upstream.writableEnded,false);assert.equal(code,200);assert.equal(headers['content-encoding'],'gzip');assert.equal(headers['content-length'],undefined);assert.match(headers.vary,/cookie/);assert.match(headers.vary,/accept-encoding/);
 upstream.end();response.destroy();decoder.destroy();
});
test('SSE compression respects negotiation and does not double encode',()=>{
 assert.equal(acceptsGzip('gzip;q=0, br'),false);assert.equal(acceptsGzip('br, gzip;q=0.5'),true);
 for(const [accept,headers] of [['br',{'content-type':'text/event-stream'}],['gzip',{'content-type':'application/json'}],['gzip',{'content-type':'text/event-stream','content-encoding':'br'}]]) {
  const upstream=new PassThrough(),response=new PassThrough();response.writeHead=()=>assert.fail('should leave ordinary proxy untouched');
  assert.equal(pipeEventStream(upstream,response,{'accept-encoding':accept},headers,200),false);upstream.destroy();response.destroy();
 }
});
