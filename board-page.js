/*
 * THE.BOARD — the Admin Center page. One self-contained HTML document (inline CSS + JS, Geist from Google
 * Fonts), served owner-only by board.js. Everything it shows comes from /admin/api/*.
 *
 * Built to answer, in this order: who is on right now, who is each device really (the full device string,
 * the IP, where it has connected from), and what exactly have they done — every screen, every tap, every
 * bet, with the second it happened. The owner's own devices are a separate lane ("You"), never in "Guests".
 */
'use strict';
module.exports = function page({ brand, logo, ownerName, sports }) {
  const sportLinks = sports.map(([k, l]) => `<a href="/${k}/">${l}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Admin Center · ${brand}</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><meta name="theme-color" content="#0B0B0D">
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#0B0B0D;--s:#141416;--s2:#1C1C1F;--ink:#F5F5F7;--i2:#A1A1AA;--i3:#6E6E76;--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--fill:rgba(255,255,255,.05);--a:#FF453A;--a-bg:rgba(255,69,58,.12);--w:#30D158;
  --font:"Geist",ui-sans-serif,system-ui,-apple-system,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#F4F4F6;--s:#FFFFFF;--s2:#F7F7F9;--ink:#0B0B0D;--i2:#55555E;--i3:#8A8A92;--line:rgba(11,11,13,.08);--line2:rgba(11,11,13,.16);--fill:rgba(11,11,13,.045);--a:#E5352A;--a-bg:rgba(229,53,42,.09);--w:#1F9D46;color-scheme:light}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--ink);font:14px/1.45 var(--font);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit}button{font:inherit;color:inherit}.mono{font-family:var(--mono)}
.top{display:flex;align-items:center;gap:16px;height:60px;padding:0 20px;background:var(--s);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none}.brand svg{width:28px;height:28px;border-radius:8px;display:block}
.brand b{font:600 13px var(--mono);letter-spacing:.06em}.brand b i{font-style:normal;color:var(--a)}.brand span{font-weight:600;font-size:15px;letter-spacing:-.01em;padding-left:10px;border-left:1px solid var(--line2)}
.back{display:flex;gap:4px;padding:3px;background:var(--fill);border-radius:10px}.back a{padding:6px 12px;border-radius:7px;text-decoration:none;font-weight:600;font-size:13px;color:var(--i2)}.back a:hover{color:var(--ink);background:var(--s)}
.sp{flex:1}.dl{display:flex;gap:6px}
.btn{height:32px;padding:0 12px;border-radius:9px;border:1px solid var(--line2);background:transparent;font-weight:600;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;text-decoration:none;white-space:nowrap}
.btn:hover{background:var(--fill)}.btn.pri{background:var(--ink);color:var(--bg);border-color:var(--ink)}.btn.danger{color:var(--a);border-color:var(--a)}.btn.danger.armed{background:var(--a);color:#fff}
main{padding:20px;max-width:1680px;margin:0 auto}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}
h1{font-size:28px;letter-spacing:-.03em;margin:0;line-height:1.1}.sub{color:var(--i2);margin-top:4px;font-size:13px}
.seg{display:flex;gap:3px;padding:3px;background:var(--fill);border-radius:11px}
.seg button{white-space:nowrap;border:0;background:transparent;padding:7px 14px;border-radius:8px;font-weight:600;font-size:13px;color:var(--i2);cursor:pointer;display:flex;gap:7px;align-items:center}
.seg button.on{background:var(--s);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.2),0 0 0 1px var(--line)}.seg button em{font-style:normal;font:500 12px var(--mono);color:var(--i3)}
.stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:16px}
.stat{background:var(--s);padding:12px 14px}.stat k{display:block;color:var(--i3);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.stat b{display:block;font-size:22px;letter-spacing:-.02em;margin-top:2px;font-weight:600}.stat s{text-decoration:none;color:var(--i2);font-size:12px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 370px;gap:16px;align-items:start}
.card{background:var(--s);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.card-h{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border-bottom:1px solid var(--line);font-weight:600;font-size:13px}.card-h small{color:var(--i3);font-weight:500}
.t-h,.row{display:grid;grid-template-columns:minmax(170px,2fr) minmax(130px,1.3fr) minmax(110px,1fr) 92px 74px 74px 90px 84px;gap:12px;align-items:center;padding:0 14px}
.t-h{height:32px;color:var(--i3);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--line);background:var(--s2)}
.row{min-height:58px;border-bottom:1px solid var(--line);cursor:pointer;padding-top:8px;padding-bottom:8px}.row:hover{background:var(--fill)}.row:last-child{border-bottom:0}
.row .c{min-width:0}.row .m-sum{display:none;grid-column:1/-1;color:var(--i2);font-size:12px}.row b{font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row small,.fx small{display:block;color:var(--i3);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who{display:flex;align-items:center;gap:6px;min-width:0}.who b{flex:0 1 auto}
.chip{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;font-size:10.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;border:1px solid var(--line2);color:var(--i2);flex:none}
.chip.you{background:var(--ink);color:var(--bg);border-color:var(--ink)}.chip.live{color:var(--a);border-color:var(--a);gap:5px}.chip.live:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--a);animation:p 1.6s infinite}
.chip.bot{border-style:dashed}.chip.sp{font-family:var(--mono);text-transform:none;letter-spacing:0;font-weight:600;color:var(--ink)}
@keyframes p{50%{opacity:.25}}
.w{color:var(--w)}.l{color:var(--a)}
.feed .it{display:grid;grid-template-columns:64px minmax(0,1fr);gap:10px;padding:9px 14px;border-bottom:1px solid var(--line);cursor:pointer}.feed .it:hover{background:var(--fill)}
.feed .tm{font:500 12px var(--mono);color:var(--i3);padding-top:1px}.feed .tx{font-size:13px}.feed .tx b{font-weight:600}.feed .mt{color:var(--i3);font-size:12px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed-body{max-height:calc(100vh - 290px);overflow:auto}
.empty{padding:28px 16px;color:var(--i2);text-align:center}.empty b{display:block;color:var(--ink);margin-bottom:4px}
/* drawer */
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:20;opacity:0;pointer-events:none;transition:opacity .15s}.scrim.on{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(880px,100vw);background:var(--bg);border-left:1px solid var(--line2);z-index:21;transform:translateX(100%);transition:transform .18s ease;display:flex;flex-direction:column}
.drawer.on{transform:none}
.d-top{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);background:var(--s)}
.d-top h2{margin:0;font-size:20px;letter-spacing:-.02em;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.x{width:32px;height:32px;border-radius:9px;border:1px solid var(--line2);background:transparent;cursor:pointer;font-size:18px;line-height:1}
.d-body{overflow:auto;padding:16px 18px 40px;flex:1}
.d-sec{margin-top:18px}.d-sec>h3{font-size:11px;font-weight:700;color:var(--i3);text-transform:uppercase;letter-spacing:.07em;margin:0 0 8px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.fx{background:var(--s);padding:9px 12px;min-width:0}.fx k{display:block;font-size:11px;color:var(--i3);font-weight:600}.fx v{display:block;font-weight:500;overflow-wrap:anywhere}
.raw{font:12px/1.5 var(--mono);background:var(--s);border:1px solid var(--line);border-radius:10px;padding:10px 12px;user-select:all;overflow-wrap:anywhere;color:var(--i2)}
.ctl{display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:var(--s);border:1px solid var(--line);border-radius:12px;padding:10px}
.ctl input{height:32px;border-radius:9px;border:1px solid var(--line2);background:var(--bg);color:var(--ink);padding:0 10px;font:inherit;min-width:0;flex:1 1 160px}
.seg.sm button{padding:5px 10px;font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font-size:11px;color:var(--i3);font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:7px 10px;background:var(--s2);border-bottom:1px solid var(--line)}
td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}tbody tr.click{cursor:pointer}tbody tr.click:hover td{background:var(--fill)}tr.sel td{background:var(--a-bg)}
.tl-day{position:sticky;top:0;background:var(--s2);padding:6px 12px;font-size:11px;font-weight:700;color:var(--i3);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--line)}
.tl{display:grid;grid-template-columns:76px 58px minmax(0,1fr) auto;gap:10px;padding:7px 12px;border-bottom:1px solid var(--line);cursor:pointer;align-items:baseline}
.tl:hover{background:var(--fill)}.tl .tm{font:500 12px var(--mono);color:var(--i3)}.tl .ip{font:11px var(--mono);color:var(--i3)}.tl.bg .tx{color:var(--i3)}
.tl .k{font:600 10.5px var(--mono);color:var(--i3);text-transform:uppercase}
.tl pre{grid-column:1/-1;margin:4px 0 2px;font:11.5px/1.5 var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--i2)}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}.filters label{display:flex;gap:6px;align-items:center;color:var(--i2);font-size:12px;cursor:pointer}
.note{color:var(--i3);font-size:12px;margin-top:8px}
@media (max-width:1180px){.grid{grid-template-columns:1fr}.feed-body{max-height:420px}.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:860px){
  .top{padding:0 14px;gap:10px}.back,.brand span{display:none}main{padding:14px 16px}
  .t-h{display:none}.row{grid-template-columns:1fr auto;gap:4px 12px;padding:10px 14px}.row .c.who-c{grid-column:1/-1}.row .m-hide{display:none}.row .m-sum{display:block}.seg{overflow-x:auto;max-width:100%}.seg button{padding:7px 11px}
  .facts{grid-template-columns:repeat(2,minmax(0,1fr))}.tl{grid-template-columns:62px minmax(0,1fr);}.tl .k,.tl .ip{display:none}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
}
</style></head><body>
<header class="top">
  <a class="brand" href="/admin">${logo}<b>THE<i>.</i>BOARD</b><span>Admin Center</span></a>
  <nav class="back" aria-label="Back to a board">${sportLinks}</nav>
  <div class="sp"></div>
  <div class="dl"><a class="btn" href="/admin/api/export?fmt=csv" title="Every recorded event, every device">⤓ CSV</a><a class="btn" href="/admin/api/export?fmt=json">⤓ JSON</a></div>
</header>
<main>
  <div class="head">
    <div><h1>Admin Center</h1><div class="sub" id="sub">Loading…</div></div>
    <div class="seg" id="seg" role="tablist"></div>
  </div>
  <section class="stats" id="stats"></section>
  <div class="grid">
    <section class="card"><div class="card-h"><span id="listTitle">Guests</span><small id="listNote"></small></div>
      <div class="t-h"><span>Who</span><span>Device</span><span>IP address</span><span>Last seen</span><span>Sessions</span><span>Activity</span><span>Sports</span><span>Bets</span></div>
      <div id="rows"></div></section>
    <aside class="card feed"><div class="card-h"><span>What they are doing</span><small>newest first · live</small></div><div class="feed-body" id="feed"></div></aside>
  </div>
</main>
<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" aria-label="Device detail"><div class="d-top"><h2 id="dTitle"></h2><button class="x" id="dClose" aria-label="Close">×</button></div><div class="d-body" id="dBody"></div></aside>
<script>
(function(){
var OWNER=${JSON.stringify(ownerName || '')};
var SPORT=${JSON.stringify(Object.fromEntries(sports))};
var S={seg:'guest',data:null,open:null,det:null,f:'all',bg:false,sess:null,exp:{},armed:false};
try{S.seg=localStorage.getItem('adm.seg')||'guest'}catch(e){}
var $=function(s){return document.querySelector(s)};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function ago(t){if(!t)return'—';var s=Math.max(0,Math.round((Date.now()-t)/1000));if(s<45)return'just now';var m=Math.round(s/60);if(m<60)return m+'m ago';var h=Math.round(m/60);if(h<36)return h+'h ago';return Math.round(h/24)+'d ago'}
function exact(t){if(!t)return'';var d=new Date(t);return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit',second:'2-digit'})}
function clock(t){return new Date(t).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}
function dayL(t){var d=new Date(t),n=new Date();var y=new Date(n);y.setDate(n.getDate()-1);if(d.toDateString()===n.toDateString())return'Today';if(d.toDateString()===y.toDateString())return'Yesterday';return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}
function dur(ms){var s=Math.round(ms/1000);if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+'m '+String(s%60).padStart(2,'0')+'s';return Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m'}
function money(n,sign){if(n==null)return'—';var a=Math.abs(n),s=a>=1000?a.toLocaleString(undefined,{maximumFractionDigits:0}):(a%1?a.toFixed(2):String(a));return(n<0?'−':sign&&n>0?'+':'')+'$'+s}
function odds(o){return o==null?'':(o>0?'+'+o:String(o))}
function devLine(d){return [d.device+(d.model?' '+d.model:''),d.os?(d.os+' '+d.osVer).trim():''].filter(Boolean).join(' · ')}
function brLine(d){return [d.browser?(d.browser+' '+d.bVer).trim():'',d.inApp?'inside '+d.inApp:''].filter(Boolean).join(' · ')||'—'}
function display(d){if(d.who)return d.who;if(d.role==='owner')return (OWNER?OWNER+"'s ":'Your ')+d.device;return d.device+(d.browser?' · '+d.browser:'')}
function segOf(d){return d.role==='owner'?'owner':d.role==='guest'?'guest':'none'}
function api(u,o){o=o||{};o.headers=Object.assign({'x-board-admin':'1','content-type':'application/json'},o.headers||{});o.credentials='same-origin';return fetch(u,o).then(function(r){if(r.status===302||r.redirected){location.href='/';throw new Error('signed out')}return r.json()})}

var SEGS=[['guest','Guests'],['owner','You'],['none','Signed out'],['all','Everyone']];
function inSeg(d){return S.seg==='all'||segOf(d)===S.seg}

function render(){
  var D=S.data;if(!D)return;
  var all=D.devices, list=all.filter(inSeg);
  $('#seg').innerHTML=SEGS.map(function(s){var n=s[0]==='all'?all.length:all.filter(function(d){return segOf(d)===s[0]}).length;return '<button role="tab" data-seg="'+s[0]+'" class="'+(S.seg===s[0]?'on':'')+'">'+s[1]+'<em>'+n+'</em></button>'}).join('');
  var live=list.filter(function(d){return d.live}), day0=new Date();day0.setHours(0,0,0,0);
  var sessT=list.reduce(function(a,d){return a+d.sessionsToday},0), taps=list.reduce(function(a,d){return a+d.tapsToday},0);
  var bets=list.reduce(function(a,d){return a+d.bets.n},0), open=list.reduce(function(a,d){return a+d.bets.open},0), net=list.reduce(function(a,d){return a+d.bets.net},0);
  var first=all.reduce(function(a,d){return Math.min(a,d.first||Infinity)},Infinity);
  $('#sub').textContent=(isFinite(first)?'Recording since '+exact(first):'Recording')+' · every device, IP, screen and tap, you and guests kept apart';
  function st(k,v,s,c){return '<div class="stat"><k>'+k+'</k><b class="'+(c||'')+'">'+v+'</b><s>'+s+'</s></div>'}
  var label={guest:'Guests',owner:'Your devices',none:'Signed-out devices',all:'Devices'}[S.seg];
  $('#stats').innerHTML=st(label,list.length,list.filter(function(d){return d.bot}).length?list.filter(function(d){return d.bot}).length+' look automated':'distinct browsers')
    +st('Here now',live.length,live.length?esc(live.map(display).slice(0,2).join(', '))+(live.length>2?' +'+(live.length-2):''):'nobody right now')
    +st('Sessions today',sessT,'30-min gap = new session')
    +st('Taps + screens today',taps,'from the board itself')
    +st('Bets logged',bets,open?open+' still open':'none open')
    +st('Net',money(net,true),'settled bets only',net>0?'w':net<0?'l':'');
  $('#listTitle').textContent=label;
  $('#listNote').textContent=list.length?'tap a row for everything':'';
  $('#rows').innerHTML=list.length?list.map(row).join(''):'<div class="empty"><b>'+(S.seg==='guest'?'No guests yet':'Nothing here yet')+'</b>'+(S.seg==='guest'?'When someone opens your guest link they show up here within seconds, with their device, IP and every tap.':'')+'</div>';
  var ids={};list.forEach(function(d){ids[d.id]=1});
  var feed=D.feed.filter(function(e){return S.seg==='all'||ids[e.dev]}).slice(0,160);
  var byId={};all.forEach(function(d){byId[d.id]=d});
  $('#feed').innerHTML=feed.length?feed.map(function(e){var d=byId[e.dev]||{};return '<div class="it" data-dev="'+e.dev+'"><span class="tm">'+clock(e.t)+'</span><div><div class="tx"><b>'+esc(display(d))+'</b> '+esc(lower(e.text))+'</div><div class="mt">'+[e.sp?SPORT[e.sp]:'',ago(e.t),e.ip,d.device].filter(Boolean).map(esc).join(' · ')+'</div></div></div>'}).join(''):'<div class="empty">No activity yet.</div>';
}
function lower(t){return t&&t.charAt(0).toLowerCase()+t.slice(1)}
function row(d){
  var chips=(d.role==='owner'?'<span class="chip you">You</span>':'')+(d.live?'<span class="chip live">'+(d.streaming?'on now':'here')+'</span>':'')+(d.bot?'<span class="chip bot">bot?</span>':'');
  var extra=d.ipCount>1?'+'+(d.ipCount-1)+' more':'';
  return '<div class="row" data-dev="'+d.id+'">'
   +'<div class="c who-c"><div class="who"><b>'+esc(display(d))+'</b>'+chips+'</div><small>'+(d.lastDo?esc(d.lastDo.text)+(d.lastDo.sp?' · '+SPORT[d.lastDo.sp]:'')+' · '+ago(d.lastDo.t):'no activity recorded')+'</small></div>'
   +'<div class="c"><b>'+esc(devLine(d))+'</b><small>'+esc(brLine(d))+'</small></div>'
   +'<div class="c"><b class="mono" style="font-weight:500">'+esc(d.ipLast||'—')+'</b><small>'+esc(extra||(d.ctx&&d.ctx.tz)||'')+'</small></div>'
   +'<div class="c"><b>'+ago(d.last)+'</b><small>'+esc(exact(d.last))+'</small></div>'
   +'<div class="c m-hide"><b>'+d.sessions+'</b><small>'+dur(d.timeOn)+' total</small></div>'
   +'<div class="c m-hide"><b>'+d.clicks+' taps</b><small>'+d.views+' screens</small></div>'
   +'<div class="c m-hide">'+(d.sports.map(function(s){return '<span class="chip sp">'+SPORT[s]+'</span>'}).join(' ')||'<small>—</small>')+'</div>'
   +'<div class="m-sum">'+[d.sessions+' session'+(d.sessions===1?'':'s')+' · '+dur(d.timeOn),d.clicks+' taps',d.views+' screens',d.sports.map(function(s){return SPORT[s]}).join('/'),d.bets.n+' bet'+(d.bets.n===1?'':'s')].filter(Boolean).join(' · ')+'</div>'
   +'<div class="c m-hide"><b>'+d.bets.n+(d.bets.open?' <small style="display:inline">('+d.bets.open+' open)</small>':'')+'</b><small class="'+(d.bets.net>0?'w':d.bets.net<0?'l':'')+'">'+(d.bets.won+d.bets.lost?money(d.bets.net,true)+' · '+d.bets.won+'-'+d.bets.lost:'no results')+'</small></div>'
   +'</div>';
}

// ---------------------------------------------------------------- the drawer
function openDev(id){S.open=id;S.det=null;S.sess=null;S.f='all';S.exp={};S.armed=false;$('#drawer').classList.add('on');$('#scrim').classList.add('on');$('#dBody').innerHTML='<div class="empty">Loading…</div>';$('#dTitle').textContent='';loadDev()}
function closeDev(){S.open=null;$('#drawer').classList.remove('on');$('#scrim').classList.remove('on')}
function loadDev(){var id=S.open;if(!id)return;api('/admin/api/device/'+id).then(function(d){if(S.open!==id)return;if(d.error){$('#dBody').innerHTML='<div class="empty"><b>That device is gone</b>It was cleared.</div>';return}S.det=d;drawDev()}).catch(function(){})}
function fx(k,v){return '<div class="fx"><k>'+esc(k)+'</k><v>'+(v===''||v==null?'<span style="color:var(--i3)">—</span>':esc(v))+'</v></div>'}
var KIND={all:'Everything',taps:'Taps',views:'Screens',money:'Bets',visits:'Visits & sign-ins'};
function match(e){
  if(S.sess&&(e.t<S.sess[0]||e.t>S.sess[1]))return false;
  if(!S.bg&&e.lvl!==1)return false;
  if(S.f==='taps')return e.k==='click';
  if(S.f==='views')return e.k==='view';
  if(S.f==='money')return e.k==='req'&&/^\\/api\\/(bets|betmgm)/.test(e.p)&&e.m!=='GET'||e.k==='req'&&e.p==='/api/betmgm/go';
  if(S.f==='visits')return e.k==='visit'||e.k==='enter'||(e.k==='req'&&e.p==='/');
  return true;
}
function drawDev(){
  var d=S.det;if(!d)return;
  var sc=$('#dBody').scrollTop;
  $('#dTitle').innerHTML=esc(display(d))+' '+(d.role==='owner'?'<span class="chip you">You</span>':d.role==='guest'?'<span class="chip">Guest</span>':'<span class="chip">Signed out</span>')+(d.live?' <span class="chip live">here now</span>':'');
  var c=d.ctx||{};
  var h='';
  h+='<div class="ctl"><input id="lbl" maxlength="40" placeholder="Name this device (e.g. Hannah\\'s iPhone)" value="'+esc(d.label)+'"><button class="btn pri" data-act="label">Save name</button>'
    +'<div class="seg sm" title="Who this device belongs to">'+[['auto','Auto'],['owner','This is me'],['guest','Guest']].map(function(r){var on=(d.roleSet||'auto')===r[0];return '<button data-role="'+r[0]+'" class="'+(on?'on':'')+'">'+r[1]+'</button>'}).join('')+'</div>'
    +'<a class="btn" href="/admin/api/export?fmt=csv&dev='+d.id+'">⤓ CSV</a><a class="btn" href="/admin/api/export?fmt=json&dev='+d.id+'">⤓ JSON</a>'
    +'<button class="btn danger'+(S.armed?' armed':'')+'" data-act="clear">'+(S.armed?'Tap again to clear':'Clear')+'</button></div>'
    +'<div class="note">Auto uses the code this device signed in with ('+esc(d.roleSeen||'none')+'). Pin it if you test on your own phone with the guest link. Clearing removes it from this view only; the device is not told or signed out.'+(d.name&&d.label?' They call themselves “'+esc(d.name)+'”.':'')+'</div>';
  h+='<div class="d-sec"><h3>Identity</h3><div class="facts">'
    +fx('Device',d.device+(d.model?' · '+d.model:''))+fx('Operating system',(d.os+' '+d.osVer).trim())+fx('Browser',(d.browser+' '+d.bVer).trim()+(d.inApp?' (inside '+d.inApp+')':''))
    +fx('IP address (latest)',d.ipLast)+fx('Screen',c.sw?c.sw+' × '+c.sh+(c.dpr?' @'+c.dpr+'x':''):'')+fx('Window',c.vw?c.vw+' × '+c.vh:'')
    +fx('Time zone',c.tz?c.tz+(c.tzo!=null?' (UTC'+(c.tzo<=0?'+':'−')+Math.abs(c.tzo/60)+')':''):'')+fx('Language',c.langs||c.locale||'')+fx('Touch',c.touch!=null?(c.touch?c.touch+' touch points':'none (mouse)'):'')
    +fx('Opened from',c.standalone?'Home-screen icon (installed)':c.sw?'Browser tab':'')+fx('Connection',c.net?c.net+(c.rtt?' · '+c.rtt+' ms':'')+(c.down?' · '+c.down+' Mb/s':''):'')+fx('Automated?',d.bot?'Looks like a script or bot':'No')
    +fx('First seen',exact(d.first))+fx('Last seen',exact(d.last)+' ('+ago(d.last)+')')+fx('Time on the board',dur(d.timeOn)+' over '+d.sessions+' session'+(d.sessions===1?'':'s'))
    +fx('Board device ID',d.id)+fx('Per-sport IDs',Object.keys(d.links||{}).map(function(k){return SPORT[k]+' '+(d.links[k]||[]).map(function(x){return x.slice(0,8)}).join(',')}).join(' · '))+fx('Sports used',d.sports.map(function(s){return SPORT[s]}).join(', '))
    +'</div></div>';
  h+='<div class="d-sec"><h3>Full user agent <span style="text-transform:none;letter-spacing:0;font-weight:500">exactly as the browser sent it</span></h3><div class="raw">'+esc(d.ua||'(none sent)')+'</div></div>';
  if(d.uaHistory&&d.uaHistory.length>1)h+='<div class="d-sec"><h3>Every browser this device has used <span>'+d.uaHistory.length+'</span></h3><div class="card"><table><thead><tr><th>User agent</th><th>First</th><th>Last</th><th>Hits</th></tr></thead><tbody>'+d.uaHistory.map(function(u){return '<tr><td class="mono" style="font-size:11.5px;overflow-wrap:anywhere">'+esc(u.ua)+'</td><td>'+esc(exact(u.first))+'</td><td>'+esc(exact(u.last))+'</td><td>'+u.n+'</td></tr>'}).join('')+'</tbody></table></div><div class="note">More than one here can mean a second browser on the same phone, or a sign-in copied to another device.</div></div>';
  h+='<div class="d-sec"><h3>IP addresses <span>'+d.ipHistory.length+'</span></h3><div class="card"><table><thead><tr><th>IP</th><th>First</th><th>Last</th><th>Hits</th><th></th></tr></thead><tbody>'
    +d.ipHistory.map(function(i){return '<tr><td class="mono">'+esc(i.ip)+'</td><td>'+esc(exact(i.first))+'</td><td>'+esc(exact(i.last))+'</td><td>'+i.n+'</td><td><a href="https://ipinfo.io/'+encodeURIComponent(i.ip)+'" target="_blank" rel="noopener noreferrer">look up ↗</a></td></tr>'}).join('')+'</tbody></table></div></div>';
  if(d.betList.length){
    h+='<div class="d-sec"><h3>Bets <span>'+d.betList.length+'</span></h3><div class="card"><table><thead><tr><th>When</th><th>Sport</th><th>Pick</th><th>Risk</th><th>Book</th><th>Result</th></tr></thead><tbody>'
     +d.betList.map(function(b){var t=Date.parse(b.placed)||b.created;return '<tr><td>'+esc(exact(t))+'</td><td>'+esc(SPORT[b.sp])+'</td><td>'+esc(b.text)+(b.legs>1?' <small style="color:var(--i3)">('+b.legs+'-leg parlay)</small>':'')+(b.note?'<br><small style="color:var(--i3)">“'+esc(b.note)+'”</small>':'')+'</td><td>'+esc(money(b.stake))+' <small style="color:var(--i3)">'+esc(odds(b.odds))+'</small></td><td>'+esc(b.book||'—')+'</td><td class="'+(b.status==='won'?'w':b.status==='lost'?'l':'')+'">'+(b.status==='open'?'open':esc(b.status)+' '+esc(money(b.net,true)))+'</td></tr>'}).join('')+'</tbody></table></div></div>';
  }
  h+='<div class="d-sec"><h3>Sessions <span>tap one to see just that visit</span></h3><div class="card"><table><thead><tr><th>Started</th><th>Length</th><th>Sports</th><th>Screens</th><th>Taps</th><th>Bets</th><th>IP</th></tr></thead><tbody>'
    +(d.sessionList.length?d.sessionList.map(function(s){var sel=S.sess&&S.sess[0]===s.start;return '<tr class="click'+(sel?' sel':'')+'" data-sess="'+s.start+':'+s.end+'"><td>'+esc(exact(s.start))+'</td><td>'+dur(s.dur)+'</td><td>'+s.sports.map(function(x){return SPORT[x]}).join(', ')+'</td><td>'+s.views+'</td><td>'+s.clicks+'</td><td>'+s.bets+'</td><td class="mono">'+esc(s.ips.join(', '))+'</td></tr>'}).join(''):'<tr><td colspan="7" style="color:var(--i3)">No sessions yet.</td></tr>')+'</tbody></table></div></div>';
  var tl=d.timeline.filter(match);
  h+='<div class="d-sec"><h3>Everything they did <span>'+tl.length+' shown</span></h3><div class="filters"><div class="seg sm">'+Object.keys(KIND).map(function(k){return '<button data-f="'+k+'" class="'+(S.f===k?'on':'')+'">'+KIND[k]+'</button>'}).join('')+'</div>'
    +'<label><input type="checkbox" id="bg"'+(S.bg?' checked':'')+'> include background calls</label>'+(S.sess?'<button class="btn" data-act="allsess">× just this session</button>':'')+'</div><div class="card">';
  var last='';
  h+=tl.length?tl.slice(0,1500).map(function(e){var dl=dayL(e.t),out='';if(dl!==last){last=dl;out+='<div class="tl-day">'+dl+'</div>'}
    var o=S.exp[e.id];var raw={};for(var k in e){if(k!=='text'&&k!=='lvl')raw[k]=e[k]}
    return out+'<div class="tl'+(e.lvl!==1?' bg':'')+'" data-ev="'+esc(e.id)+'"><span class="tm">'+clock(e.t)+'</span><span class="k">'+esc(e.sp?SPORT[e.sp]:'board')+'</span><span class="tx">'+esc(e.text)+'</span><span class="ip">'+esc(e.ip||'')+'</span>'+(o?'<pre>'+esc(JSON.stringify(raw,null,2))+'</pre>':'')+'</div>'}).join(''):'<div class="empty">Nothing matches.</div>';
  h+='</div><div class="note">Tap any line for the raw record. Screens and taps come from the board itself; page loads, bets and BetMGM taps from the server.</div></div>';
  $('#dBody').innerHTML=h;$('#dBody').scrollTop=sc;
}

// ---------------------------------------------------------------- events
document.addEventListener('click',function(ev){
  var t=ev.target.closest('[data-seg],[data-dev],[data-f],[data-sess],[data-ev],[data-act],[data-role],#dClose,#scrim');if(!t)return;
  if(t.id==='dClose'||t.id==='scrim'){closeDev();return}
  if(t.dataset.seg){S.seg=t.dataset.seg;try{localStorage.setItem('adm.seg',S.seg)}catch(e){}render();return}
  if(t.dataset.dev){openDev(t.dataset.dev);return}
  if(t.dataset.f){S.f=t.dataset.f;drawDev();return}
  if(t.dataset.sess){var p=t.dataset.sess.split(':').map(Number);S.sess=S.sess&&S.sess[0]===p[0]?null:p;drawDev();return}
  if(t.dataset.ev){if(ev.target.closest('pre'))return;S.exp[t.dataset.ev]=!S.exp[t.dataset.ev];drawDev();return}
  if(t.dataset.role){api('/admin/api/device/'+S.open,{method:'POST',body:JSON.stringify({role:t.dataset.role})}).then(function(){loadDev();loadBoard()});return}
  var a=t.dataset.act;
  if(a==='allsess'){S.sess=null;drawDev();return}
  if(a==='label'){api('/admin/api/device/'+S.open,{method:'POST',body:JSON.stringify({label:$('#lbl').value})}).then(function(){loadDev();loadBoard()});return}
  if(a==='clear'){if(!S.armed){S.armed=true;drawDev();setTimeout(function(){if(S.armed){S.armed=false;drawDev()}},4000);return}
    S.armed=false;api('/admin/api/device/'+S.open,{method:'DELETE'}).then(function(){closeDev();loadBoard()});return}
});
document.addEventListener('change',function(ev){if(ev.target.id==='bg'){S.bg=ev.target.checked;drawDev()}});
document.addEventListener('keydown',function(ev){if(ev.key==='Escape')closeDev();if(ev.key==='Enter'&&ev.target.id==='lbl'){ev.preventDefault();document.querySelector('[data-act="label"]').click()}});

function loadBoard(){return api('/admin/api/board').then(function(d){S.data=d;render()}).catch(function(){})}
loadBoard();
setInterval(function(){if(document.visibilityState!=='visible')return;loadBoard();if(S.open&&!document.activeElement.matches('#lbl'))loadDev()},8000);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')loadBoard()});
})();
</script></body></html>`;
};
