'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createResolver,selectSource,validClip,cacheTTL,ACCOUNT,CONFIG_URL,PLAYBACK_URL}=require('../nhl/public/replays');
const CLIP='6405450361112',KEY='public-player-policy';
const media='https://fastly-signed-us-east-1-prod.brightcovecdn.com/media/v1/pmp4/static/clear/'+ACCOUNT+'/asset/variant/main.mp4?fastly_token=opaque';
const mp4=(height=720,more={})=>({src:media,height,width:height*16/9,container:'MP4',codec:'H264',avg_bitrate:2100000,...more});
const hls={src:'https://manifest.prod.boltdns.net/manifest/v1/hls/v4/clear/'+ACCOUNT+'/asset/6s/master.m3u8?fastly_token=opaque',type:'application/x-mpegURL'};
const metadata=(sources=[mp4()])=>({id:CLIP,account_id:ACCOUNT,name:'Gaucher sends in a wrister',poster:media.replace('main.mp4','poster.jpg'),sources,manifest_url_ttl:3600});
const response=(data,status=200,control='no-store')=>({ok:status===200,status,headers:new Headers({'cache-control':control}),json:async()=>data});
const config=()=>response({account_id:ACCOUNT,ad_config_id:null,video_cloud:{policy_key:KEY}},200,'public, max-age=300');
const native=type=>type==='video/mp4'?'probably':'';
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
test('native source chooses clear H264 at most 720p and preserves signed URL exactly',()=>{
 const result=selectSource(metadata([mp4(1080),mp4(360),mp4(720)]),{canPlayType:native});
 assert.deepEqual(result,{src:media,type:'video/mp4',poster:media.replace('main.mp4','poster.jpg'),title:'Gaucher sends in a wrister'});
});
test('HLS is a fallback only when the browser declares native support',()=>{
 assert.equal(selectSource(metadata([hls]),{canPlayType:()=> 'maybe'}).type,'application/vnd.apple.mpegurl');
 assert.throws(()=>selectSource(metadata([hls]),{canPlayType:native}),{code:'UNSUPPORTED_MEDIA'});
 assert.throws(()=>selectSource(metadata([mp4(1080)]),{canPlayType:native}),{code:'UNSUPPORTED_MEDIA'});
});
test('DRM, SSAI and foreign or unsafe sources fail cleanly without modifying URLs',()=>{
 for(const source of [mp4(720,{key_systems:{}}),mp4(720,{key_systems:{'com.widevine.alpha':{}}}),mp4(720,{ssai:{}}),
  mp4(720,{src:'https://evil.example/main.mp4'}),mp4(720,{src:'https://brightcovecdn.com.evil.example/main.mp4'}),
  mp4(720,{src:'http://fastly.brightcovecdn.com/main.mp4'}),mp4(720,{src:'https://user@fastly.brightcovecdn.com/main.mp4'}),
  mp4(720,{src:media.replace('/clear/','/ssai/')}),mp4(720,{codec:'HEVC'})])
  assert.throws(()=>selectSource(metadata([source]),{canPlayType:native}),{code:'UNSUPPORTED_MEDIA'});
 assert.throws(()=>selectSource({...metadata(),ad_config_id:'required'},{canPlayType:native}),{code:'RESTRICTED_PLAYBACK'});
});
test('strict video IDs reject URLs, coercion and unsafe values before network access',async()=>{
 let requests=0;const resolver=createResolver({fetchImpl:async()=>{requests++;},canPlayType:native});
 for(const clip of ['',null,undefined,6405450361112,'../../clip','ref:clip','6405450361112?x=1','0000000000000','1'.repeat(17)]){
  assert.equal(validClip(clip),false);await assert.rejects(resolver.resolve(clip),{code:'INVALID_CLIP'});
 }assert.equal(requests,0);
});
test('browser requests use public policy, viewer CORS and no credential or origin spoofing',async()=>{
 const calls=[];const resolver=createResolver({fetchImpl:async(url,options)=>{calls.push({url,options});return url===CONFIG_URL?config():response(metadata());},canPlayType:native});
 await resolver.resolve(CLIP);assert.deepEqual(calls.map(x=>x.url),[CONFIG_URL,PLAYBACK_URL+CLIP]);
 assert.equal(calls[1].options.headers.Accept,'application/json;pk='+KEY);
 for(const {options}of calls){assert.equal(options.credentials,'omit');assert.equal(options.mode,'cors');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.method,'GET');assert.equal(options.headers.Origin,undefined);assert.equal(options.referrer,undefined);}
});
test('concurrent requests share metadata but completed no-store responses never cache signed media URLs',async()=>{
 let configs=0,videos=0;const gate=deferred();const resolver=createResolver({canPlayType:native,fetchImpl:async url=>{if(url===CONFIG_URL){configs++;return config();}videos++;await gate.promise;return response(metadata());}});
 const a=resolver.resolve(CLIP),b=resolver.resolve(CLIP);gate.resolve();assert.deepEqual(await a,await b);assert.equal(configs,1);assert.equal(videos,1);
 await resolver.resolve(CLIP);assert.equal(configs,1);assert.equal(videos,2);
});
test('one aborted dialog does not abort or poison the shared metadata request',async()=>{
 const gate=deferred();let sharedSignal;const resolver=createResolver({canPlayType:native,fetchImpl:async(url,options)=>{if(url===CONFIG_URL)return config();sharedSignal=options.signal;await gate.promise;return response(metadata());}});
 const controller=new AbortController(),cancelled=resolver.resolve(CLIP,{signal:controller.signal}),other=resolver.resolve(CLIP);
 controller.abort();await assert.rejects(cancelled,{name:'AbortError'});gate.resolve();assert.equal((await other).type,'video/mp4');assert.equal(sharedSignal.aborted,false);
});
test('an already aborted caller performs no network request',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;const resolver=createResolver({fetchImpl:async()=>{calls++;}});
 await assert.rejects(resolver.resolve(CLIP,{signal:controller.signal}),{name:'AbortError'});assert.equal(calls,0);
});
test('transient API errors are retryable and restricted responses never search another policy or proxy',async()=>{
 for(const status of [403,500]){let calls=0;const resolver=createResolver({canPlayType:native,fetchImpl:async url=>{if(url===CONFIG_URL)return config();calls++;return calls===1?response([{error_code:'ACCESS_DENIED'}],status):response(metadata());}});
  await assert.rejects(resolver.resolve(CLIP),{code:status===403?'ACCESS_DENIED':'UNAVAILABLE'});assert.equal(calls,1);assert.equal((await resolver.resolve(CLIP)).type,'video/mp4');assert.equal(calls,2);}
});
test('config errors, expired cache, no-store and SSAI configuration are honored',async()=>{
 assert.equal(cacheTTL(new Headers({'cache-control':'no-store, max-age=300'})),0);assert.equal(cacheTTL(new Headers({'cache-control':'max-age=300','age':'200'})),100000);
 let now=0,configs=0;const resolver=createResolver({now:()=>now,canPlayType:native,fetchImpl:async url=>{if(url!==CONFIG_URL)return response(metadata());configs++;return configs===1?response({},500):config();}});
 await assert.rejects(resolver.resolve(CLIP),{code:'UNAVAILABLE'});await resolver.resolve(CLIP);now=300001;await resolver.resolve(CLIP);assert.equal(configs,3);
 const restricted=createResolver({fetchImpl:async()=>response({account_id:ACCOUNT,ad_config_id:'required',video_cloud:{policy_key:KEY}})});
 await assert.rejects(restricted.resolve(CLIP),{code:'RESTRICTED_PLAYBACK'});
});
test('response identity must match the requested NHL clip and account',async()=>{
 for(const change of [{id:'6405450361113'},{account_id:'another-account'}]){
  const resolver=createResolver({canPlayType:native,fetchImpl:async url=>url===CONFIG_URL?config():response({...metadata(),...change})});
  await assert.rejects(resolver.resolve(CLIP),{code:'UNAVAILABLE'});
 }
});
test('metadata concurrency is bounded and capacity is released after failures',async()=>{
 const gate=deferred();const resolver=createResolver({fetchImpl:async url=>{if(url===CONFIG_URL)return config();await gate.promise;return response({},500);}});
 const active=Array.from({length:8},(_,i)=>resolver.resolve(String(6405450361100+i)));const results=Promise.allSettled(active);
 await assert.rejects(resolver.resolve(CLIP),{code:'BUSY'});gate.resolve();await results;await assert.rejects(resolver.resolve(CLIP),{code:'UNAVAILABLE'});
});
