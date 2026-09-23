(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root?.document)root.NHLReplay=api.createResolver({fetchImpl:root.fetch.bind(root),canPlayType:type=>root.document.createElement('video').canPlayType(type)});
})(typeof window==='undefined'?null:window,function(){
  'use strict';
  // Public, read-only Playback API; browser requests retain viewer Origin/geo enforcement.
  // https://player.support.brightcove.com/publish/using-non-brightcove-player.html
  // https://apis.support.brightcove.com/playback/getting-started/overview-playback-api.html
  const ACCOUNT='6415718365001';
  const CONFIG_URL='https://players.brightcove.net/'+ACCOUNT+'/default_default/config.json';
  const PLAYBACK_URL='https://edge.api.brightcove.com/playback/v1/accounts/'+ACCOUNT+'/videos/';
  const MAX_PENDING=8,TIMEOUT_MS=10000;
  class ReplayError extends Error {constructor(code,message){super(message);this.name='NHLReplayError';this.code=code;}}
  const abortError=()=>{const error=new Error('Replay request cancelled.');error.name='AbortError';return error;};
  const validClip=value=>typeof value==='string'&&/^[1-9][0-9]{9,15}$/.test(value);
  function safeMedia(value){
    try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||url.href.length>12000)return null;
      if(!['brightcovecdn.com','boltdns.net'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))return null;
      return url.href;
    }catch{return null;}
  }
  const requiresSSAI=data=>!!(data?.ad_config_id||data?.ssai||data?.ssai_metadata||data?.vmap);
  function selectSource(data,{canPlayType=()=>''}={}){
    if(requiresSSAI(data))throw new ReplayError('RESTRICTED_PLAYBACK','This clip requires the official NHL player.');
    const sources=(Array.isArray(data?.sources)?data.sources:[]).slice(0,100).filter(source=>{
      const src=safeMedia(source?.src);
      return src&&source.key_systems==null&&!source.drm&&!requiresSSAI(source)
        && !/\/(?:ssai|vmap|aes128|widevine|fairplay)(?:\/|\.)/i.test(new URL(src).pathname)
        && !/ssai|vmap/i.test(source.type||'');
    });
    const mp4=canPlayType('video/mp4')?sources.filter(source=>(source.container==='MP4'||source.type==='video/mp4')
      && (!source.codec||source.codec==='H264')&&Number.isFinite(source.height)&&source.height>0&&source.height<=720
      && /\.mp4$/i.test(new URL(source.src).pathname)).sort((a,b)=>b.height-a.height||(a.avg_bitrate||Infinity)-(b.avg_bitrate||Infinity))[0]:null;
    const hls=canPlayType('application/vnd.apple.mpegurl')?sources.find(source=>/^(?:application\/x-mpegurl|application\/vnd\.apple\.mpegurl)$/i.test(source.type)
      && /\.m3u8$/i.test(new URL(source.src).pathname)):null;
    const selected=mp4||hls;
    if(!selected)throw new ReplayError('UNSUPPORTED_MEDIA','A native replay is unavailable. Open the NHL original.');
    return {src:safeMedia(selected.src),type:mp4?'video/mp4':'application/vnd.apple.mpegurl',poster:safeMedia(data.poster),title:typeof data.name==='string'?data.name.slice(0,256):'NHL replay'};
  }
  function cacheTTL(headers){
    const control=headers?.get?.('cache-control')||'';
    if(/(?:^|,)\s*(?:no-store|no-cache)\b/i.test(control))return 0;
    const match=/(?:^|,)\s*max-age=(\d+)\b/i.exec(control);if(!match)return 0;
    const age=Math.max(0,Number(headers?.get?.('age'))||0);
    return Math.min(300000,Math.max(0,Number(match[1])-age)*1000);
  }
  function observe(task,signal){
    if(!signal)return task.then(value=>({...value}));
    if(signal.aborted)return Promise.reject(abortError());
    return new Promise((resolve,reject)=>{
      const aborted=()=>{signal.removeEventListener('abort',aborted);reject(abortError());};
      signal.addEventListener('abort',aborted,{once:true});
      task.then(value=>{signal.removeEventListener('abort',aborted);resolve({...value});},error=>{signal.removeEventListener('abort',aborted);reject(error);});
    });
  }
  function createResolver({fetchImpl=globalThis.fetch?.bind(globalThis),now=Date.now,canPlayType=()=>'',setTimer=setTimeout,clearTimer=clearTimeout}={}){
    let config=null,configTask=null;
    const pending=new Map();
    async function jsonRequest(url,headers){
      const controller=new AbortController(),timer=setTimer(()=>controller.abort(),TIMEOUT_MS);
      try{
        const response=await fetchImpl(url,{method:'GET',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',headers,signal:controller.signal});
        if(!response.ok)throw new ReplayError(response.status===401||response.status===403?'ACCESS_DENIED':response.status===404?'NOT_FOUND':'UNAVAILABLE',
          response.status===401||response.status===403?'This replay is unavailable for this viewer.':'Replay metadata is temporarily unavailable.');
        return {data:await response.json(),headers:response.headers};
      }catch(error){if(error instanceof ReplayError)throw error;throw new ReplayError('UNAVAILABLE','Replay metadata is temporarily unavailable.');}
      finally{clearTimer(timer);}
    }
    function policy(){
      if(config&&config.until>now())return Promise.resolve(config.key);
      if(configTask)return configTask;
      configTask=(async()=>{
        const {data,headers}=await jsonRequest(CONFIG_URL,{Accept:'application/json'});
        if(String(data?.account_id)!==ACCOUNT||requiresSSAI(data)||typeof data.video_cloud?.policy_key!=='string'||!data.video_cloud.policy_key||data.video_cloud.policy_key.length>4096)
          throw new ReplayError('RESTRICTED_PLAYBACK','This clip requires the official NHL player.');
        config={key:data.video_cloud.policy_key,until:now()+cacheTTL(headers)};return config.key;
      })().finally(()=>{configTask=null;});
      return configTask;
    }
    async function load(clip){
      const key=await policy();
      const {data}=await jsonRequest(PLAYBACK_URL+clip,{Accept:'application/json;pk='+key});
      if(String(data?.id)!==clip||String(data?.account_id)!==ACCOUNT)throw new ReplayError('UNAVAILABLE','The requested replay is unavailable.');
      return selectSource(data,{canPlayType});
    }
    function resolve(clip,{signal}={}){
      if(!validClip(clip))return Promise.reject(new ReplayError('INVALID_CLIP','Invalid NHL replay.'));
      if(signal?.aborted)return Promise.reject(abortError());
      let task=pending.get(clip);
      if(!task){
        if(pending.size>=MAX_PENDING)return Promise.reject(new ReplayError('BUSY','Replay requests are busy. Try again shortly.'));
        // Keep only in-flight metadata. Playback responses use no-store and signed
        // URLs expire; a completed/error response is never cached or persisted.
        task=load(clip).finally(()=>pending.delete(clip));pending.set(clip,task);
      }
      // Cancelling one dialog only cancels its wait, never another viewer's shared fetch.
      return observe(task,signal);
    }
    return Object.freeze({resolve});
  }
  return {createResolver,selectSource,validClip,cacheTTL,ACCOUNT,CONFIG_URL,PLAYBACK_URL};
});
