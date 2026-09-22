/* Shared feed monitor. Delivery timings never stand in for sportsbook quote age. */
(function () {
  'use strict';
  function mount() {
    const bar = document.getElementById('xsport');
    if (!bar || document.getElementById('feed-monitor')) return;
    const sport = location.pathname.split('/')[1];
    if (!['nfl','ncaaf','mlb'].includes(sport)) return;
    const root = document.createElement('details');root.id='feed-monitor';root.className='feed-monitor';
    root.innerHTML='<summary aria-label="Market feed status"><span class="feed-dot"></span><span class="feed-summary">Connecting</span><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></summary>'
      +'<section class="feed-panel" aria-label="Market connection"><div class="feed-panel-heading"><span class="feed-eyebrow">THE.BOARD · CONNECTION</span><strong>Every update, in view.</strong></div>'
      +'<div class="feed-provider" data-provider="sharp"><div><b>Sharp API</b><span class="feed-provider-role">Streaming feed</span></div><span class="feed-state">Connecting</span></div>'
      +'<div class="feed-metrics"><div><span>Latest feed delivery</span><strong class="feed-latency">—</strong></div><div><span>Books observed</span><strong class="feed-books">—</strong></div></div>'
      +'<div class="feed-provider" data-provider="owls"><div><b>Owls Insight</b><span class="feed-provider-role">Additional coverage</span></div><span class="feed-state">Connecting</span></div>'
      +'<div class="feed-updated">Waiting for connection data</div><p class="feed-note">Delivery speed and price freshness are different. Each price keeps its own source and verification.</p></section>';
    if(typeof BoardHandoff!=='undefined')BoardHandoff.mountSettings(root.querySelector('.feed-panel'));
    const admin=bar.querySelector('.xadm');bar.insertBefore(root,admin || null);
    const summary=root.querySelector('.feed-summary'),latency=root.querySelector('.feed-latency'),books=root.querySelector('.feed-books'),updated=root.querySelector('.feed-updated');
    let pending=false,timer=null;
    function label(feed) {
      if (!feed?.enabled) return 'Not connected';
      if (feed.streamHealthy) return 'Streaming';
      if (feed.connection === 'polling') return 'Polling';
      if (feed.connection === 'displaced') return 'Connection in use';
      return 'Reconnecting';
    }
    function write(el,value) { if (el.textContent!==value) el.textContent=value; }
    async function refresh() {
      if (document.hidden || pending) return;
      pending=true;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),4000);
      try {
        const response=await fetch('/health',{cache:'no-store',signal:controller.signal});
        if (!response.ok) throw new Error('unavailable');
        const status=await response.json(),feeds=status.feeds || {owls:status.oddsFeed};
        const sharp=feeds.sharp || {},owls=feeds.owls || {};
        const live=!!(sharp.streamHealthy || owls.streamHealthy);
        root.dataset.state=live?'live':sharp.enabled || owls.enabled?'fallback':'offline';
        write(summary,live?'Live stream':sharp.enabled || owls.enabled?'Polling':'Offline');
        for (const name of ['sharp','owls']) {
          const row=root.querySelector('[data-provider="'+name+'"]'),feed=feeds[name] || {};
          row.dataset.state=feed.streamHealthy?'live':'fallback';write(row.querySelector('.feed-state'),label(feed));
        }
        const value=sharp.transportLatencyMs;
        write(latency,sharp.streamHealthy && typeof value==='number' && value>=0 ? (value<1000?Math.round(value)+' ms':(value/1000).toFixed(1)+' s'):'—');
        // Provider book spellings differ; report each count instead of a misleading merged total.
        const a=Array.isArray(sharp.books?.[sport])?sharp.books[sport].length:null,b=Array.isArray(owls.books?.[sport])?owls.books[sport].length:null;
        write(books,a!==null?String(a)+' Sharp':b!==null?String(b)+' Owls':'—');
        const stamp=Math.max(Number(sharp.lastReceivedAt)||0,Number(owls.lastReceivedAt)||0);
        const age=stamp?Math.max(0,Math.floor((Date.now()-stamp)/1000)):null;
        write(updated,age===null?'Waiting for first update':age<2?'Latest update just received':'Latest update '+age+'s ago');
      } catch {
        root.dataset.state='offline';write(summary,'Reconnecting');write(latency,'—');for(const row of root.querySelectorAll('.feed-provider')){row.dataset.state='fallback';write(row.querySelector('.feed-state'),'Checking');}write(updated,'Checking the connection. Existing price timestamps still apply.');
      } finally {clearTimeout(timeout);pending=false;}
    }
    root.addEventListener('keydown',event=>{if(event.key==='Escape'){root.open=false;root.querySelector('summary').focus();}});
    document.addEventListener('click',event=>{if(root.open&&!root.contains(event.target))root.open=false;});
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
    refresh();timer=setInterval(refresh,5000);
    window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
})();
