/* Served inline only by the owner-authorized admin page. */
(function () {
'use strict';
var OWNER=__OWNER_JSON__,SPORT=__SPORT_JSON__;
var S={seg:'all',data:null,sec:null,open:null,det:null,tab:'history',f:'all',bg:false,sess:null,exp:{},armed:false,q:'',aq:'',asport:'',akind:'all',aperiod:'all',hsport:'',hperiod:'all',view:'people'};
try{var saved=localStorage.getItem('adm.seg');if(['guest','owner','none','all'].includes(saved))S.seg=saved}catch(e){}
var $=function(s){return document.querySelector(s)};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function ago(t){if(!t)return'—';var s=Math.max(0,Math.round((Date.now()-t)/1000));if(s<45)return'just now';var m=Math.round(s/60);if(m<60)return m+'m ago';var h=Math.round(m/60);if(h<36)return h+'h ago';return Math.round(h/24)+'d ago'}
function exact(t){if(!t)return'Not recorded';return new Date(t).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'})}
function clock(t){return new Date(t).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})}
function dayL(t){var d=new Date(t),n=new Date(),y=new Date();y.setDate(n.getDate()-1);if(d.toDateString()===n.toDateString())return'Today';if(d.toDateString()===y.toDateString())return'Yesterday';return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}
function dur(ms){var s=Math.max(0,Math.round(ms/1000));if(s<60)return s+'s';var m=Math.floor(s/60);if(m<60)return m+'m '+s%60+'s';return Math.floor(m/60)+'h '+m%60+'m'}
function money(n,sign){if(n==null)return'—';return(n<0?'−':sign&&n>0?'+':'')+'$'+Math.abs(n).toLocaleString(undefined,{maximumFractionDigits:2})}
function odds(o){return o==null?'':(o>0?'+'+o:String(o))}
function ipSource(i){if(!i)return'Source not recorded';if(i.source==='socket'&&i.reason&&i.reason!=='FORWARDED_HEADERS_IGNORED')return'Transport peer · fallback';return {'railway-x-real-ip':'Railway edge','railway-x-forwarded-for':'Forwarded address · fallback',socket:'Direct connection',unavailable:'Address unavailable'}[i.source]||'Source not recorded'}
function ipKind(i){return i&&{public:'Public address',private:'Private / reserved address',loopback:'Local connection',unavailable:'Address unavailable'}[i.kind]||'Historical observation'}
function ipReason(i){return i&&i.reason?{REAL_IP_INVALID:'The edge IP header was invalid; the final forwarded address was used.',FORWARDED_ADDRESS_INVALID:'No valid edge address was supplied; this is the server connection peer.',FORWARDED_ADDRESS_MISSING:'The edge address was missing; this is the server connection peer.',FORWARDED_HEADERS_IGNORED:'Forwarded headers were ignored on a direct connection.',INTERNAL_ADDRESS_UNVERIFIED:'The internal address could not be verified; this is the server connection peer.'}[i.reason]||'Address evidence could not be verified.':''}
function ipLookup(ip,allowed){return allowed?'<a href="https://ipinfo.io/'+encodeURIComponent(ip)+'" target="_blank" rel="noopener noreferrer" title="Approximate network location, not GPS">IP lookup ↗</a>':'<span class="dim">No public lookup</span>'}
function ipCaption(i){return ipSource(i)+(i&&i.kind?' · '+ipKind(i):'')}
function devLine(d){return [d.device,d.os?d.os+' '+(d.osVer||''):''].filter(Boolean).join(' · ')}
function brLine(d){return [(d.browser||'')+' '+(d.bVer||''),d.inApp?'inside '+d.inApp:''].filter(Boolean).join(' · ').trim()||'Not reported'}
function display0(d){if(d.who)return d.who;if(d.role==='owner')return(OWNER?OWNER+"’s ":'Your ')+(d.device||'browser');return(d.device||'Browser')+(d.browser?' · '+d.browser:'')}
var DUP={};function display(d){var n=display0(d);return DUP[n]>1&&!d.who?n+' · '+String(d.id||'').slice(0,4):n}
function segOf(d){return d.role==='owner'?'owner':d.role==='guest'?'guest':'none'}
function source(e){return e.source==='server'||e.k==='req'||e.k==='enter'?'Server record':'Browser-reported'}
function st(k,v,s,c){return '<div class="stat"><k>'+esc(k)+'</k><b class="'+(c||'')+'">'+esc(v)+'</b><s>'+esc(s)+'</s></div>'}
function fx(k,v){return '<div class="fx"><k>'+esc(k)+'</k><v>'+esc(v==null||v===''?'Not reported':v)+'</v></div>'}
function empty(title,note){return '<div class="empty"><b>'+esc(title)+'</b>'+esc(note||'')+'</div>'}
function intro(title,note){return '<div class="d-section-head"><h3>'+esc(title)+'</h3><p>'+esc(note)+'</p></div>'}
function periodMatch(t,p){return p==='all'||Date.now()-t<(p==='day'?86400000:604800000)}
function api(u,o){o=o||{};o.headers=Object.assign({'x-board-admin':'1','content-type':'application/json'},o.headers||{});o.credentials='same-origin';o.cache='no-store';return fetch(u,o).then(function(r){if(r.status===302||r.redirected||(r.status===404&&u==='__ADMIN__/api/board')){location.href='__ADMIN__/login';throw Error('Sign-in required')}return r.json().then(function(d){if(!r.ok)throw Error(d.error||'Request failed');return d})})}

function setView(v){S.view=['activity','security'].includes(v)?v:'people';$('#vPeople').hidden=S.view!=='people';$('#vActivity').hidden=S.view!=='activity';$('#vSec').hidden=S.view!=='security';document.querySelectorAll('#views a').forEach(function(a){a.classList.toggle('on',a.dataset.view===S.view);if(a.dataset.view===S.view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current')});if(S.view==='security')loadSec();else if(S.data){render();renderActivity()}else loadBoard()}
var SEGS=[['all','Everyone'],['guest','Guests'],['owner','Your devices'],['none','Signed out']];
function render(){
 var D=S.data;if(!D)return;
 $('#connection').innerHTML='<strong class="mono">'+esc(D.connection&&D.connection.ip||'Unavailable')+'</strong> · '+esc(ipCaption(D.connection))+(D.connection&&D.connection.kind==='public'?' · '+ipLookup(D.connection.ip,true):'');
 DUP={};D.devices.forEach(function(d){var n=display0(d);DUP[n]=(DUP[n]||0)+1});
 $('#seg').innerHTML=SEGS.map(function(s){var n=s[0]==='all'?D.devices.length:D.devices.filter(function(d){return segOf(d)===s[0]}).length;return '<button data-seg="'+s[0]+'" aria-pressed="'+(S.seg===s[0])+'" class="'+(S.seg===s[0]?'on':'')+'">'+s[1]+'<em>'+n+'</em></button>'}).join('');
 var selected=D.devices.filter(function(d){return S.seg==='all'||segOf(d)===S.seg});
 var list=selected.filter(function(d){return !S.q||[display(d),devLine(d),brLine(d),d.ipLast,d.id].join(' ').toLowerCase().includes(S.q.toLowerCase())});
 var connected=selected.filter(function(d){return d.streaming}).length,sess=selected.reduce(function(n,d){return n+d.sessionsToday},0),pages=selected.reduce(function(n,d){return n+(d.pageViews==null?d.views:d.pageViews)},0);
 $('#stats').innerHTML=st('Browser profiles',selected.length,'Cookie-based · not a person count')+st('Open feed connections',connected,'May include background tabs')+st('Sessions today',sess,'30-minute inactivity boundary')+st('Recorded page views',pages,'Within retained activity');
 $('#listTitle').textContent={all:'All browser profiles',guest:'Guest profiles',owner:'Your browser profiles',none:'Signed-out profiles'}[S.seg];
 $('#listNote').textContent=list.length+' shown'+(S.q?' · matching your search':' · select a profile to inspect');
 $('#rows').innerHTML=list.length?list.map(row).join(''):empty('No matching profiles',S.q?'Try a name, browser or IP address.':'Activity appears here when someone opens the app.');
 var ids={};selected.forEach(function(d){ids[d.id]=1});var byId={};D.devices.forEach(function(d){byId[d.id]=d});
 var feed=D.feed.filter(function(e){return ids[e.dev]}).slice(0,30);
 $('#feed').innerHTML=feed.length?feed.map(function(e){var d=byId[e.dev]||{};return '<button class="feed-event" data-dev="'+esc(e.dev)+'"><span class="feed-event-top"><strong>'+esc(display(d))+'</strong><time>'+ago(e.t)+'</time></span><span>'+esc(e.text)+'</span><small>'+esc([SPORT[e.sp]||'Access',source(e)].join(' · '))+'</small></button>'}).join(''):empty('No recent activity','Page visits and interactions will appear here.');
 $('#sub').textContent='Device details describe a browser profile, not verified personal identity. An open data connection does not prove someone is looking at the screen.';
 renderActivity();
}
function row(d){
 var state=d.blocked?'Blocked':d.streaming?'Feed connected':d.lastInteractionAt&&Date.now()-d.lastInteractionAt<120000?'Recent interaction':'No open feed';
 var last=d.lastView;
 return '<button class="device-row" data-dev="'+esc(d.id)+'" aria-label="Open '+esc(display(d))+'"><span class="device-main"><span class="device-avatar" aria-hidden="true">'+esc((d.device||'BR').slice(0,2).toUpperCase())+'</span><span class="device-name"><strong>'+esc(display(d))+'</strong><small>'+esc(brLine(d))+'</small><small class="connection-state '+(d.blocked?'blocked':'')+'">'+esc(state)+(d.role==='owner'?' · You':'')+'</small></span></span><span class="cell page-cell"><strong>'+esc(last?last.page:'No page report')+'</strong><small>'+esc(last?(SPORT[last.sp]||'')+' · '+ago(last.t):d.lastDo?d.lastDo.text:'Awaiting in-app activity')+'</small></span><span class="cell counts"><strong>'+Number(d.views||0)+' pages</strong><small>'+Number(d.clicks||0)+' interactions</small></span><span class="cell last"><strong>'+ago(d.last)+'</strong><small>'+Number(d.sessions||0)+' sessions</small></span></button>';
}
function renderActivity(){
 if(!S.data)return;var by={};S.data.devices.forEach(function(d){by[d.id]=d});
 var activity=S.data.activity||S.data.feed;var list=activity.filter(function(e){if(S.asport&&e.sp!==S.asport)return false;if(!periodMatch(e.t,S.aperiod))return false;if(S.akind==='pages'&&e.k!=='view'&&!(e.k==='req'&&e.p==='/'))return false;if(S.akind==='clicks'&&!['click','act'].includes(e.k))return false;if(S.akind==='access'&&e.k!=='enter')return false;if(S.akind==='errors'&&!['err','error'].includes(e.k)&&!(e.s>=400))return false;return !S.aq||[e.text,display(by[e.dev]||{}),e.ip,SPORT[e.sp]].join(' ').toLowerCase().includes(S.aq.toLowerCase())});
 $('#activityCount').textContent=list.length+' matching · latest '+activity.length+' activity records';
 $('#activityList').innerHTML=list.length?list.map(function(e){var d=by[e.dev]||{};return '<button class="activity-log-row" data-dev="'+esc(e.dev)+'"><span><time>'+clock(e.t)+'</time><small>'+esc(dayL(e.t))+'</small></span><span><strong>'+esc(display(d))+'</strong><small>'+esc(devLine(d))+'</small></span><span>'+esc(e.text)+'<small>'+esc(SPORT[e.sp]||'Access')+'</small></span><span class="event-source">'+source(e)+'</span></button>'}).join(''):empty('Nothing matches these filters','Try another sport, period or activity type.');
}
function renderSec(){
 var D=S.sec;if(!D)return;var stt=D.stats,dv=D.devices;
 $('#secStats').innerHTML=st('High-priority signals',stt.high,'Review the supporting records',stt.high?'l':'')+st('Entries today',stt.signinsToday,'Includes automatic guest entry')+st('Wrong codes today',stt.wrongToday,'Rejected sign-in attempts',stt.wrongToday?'l':'')+st('New profiles',stt.newDevicesWeek,'First seen in the last 7 days')+st('Failed requests',stt.failsDay,'Errors and refusals · 24 hours')+st('Blocked profiles',stt.blocked,'Browser-cookie access controls');
 var badge=document.querySelector('#views a[data-view="security"]');badge.innerHTML='Security'+(stt.high?'<em>'+stt.high+'</em>':'');
 $('#alerts').innerHTML=D.alerts.length?D.alerts.map(function(a){var d=dv[a.dev]||{};return '<div class="al '+esc(a.sev)+'" role="button" tabindex="0" data-dev="'+esc(a.dev)+'"><span class="sev '+esc(a.sev)+'"></span><div><div class="k">'+esc(a.kind)+'</div><div class="tx">'+esc(a.text)+'</div><div class="aw">'+esc(display(d))+' · '+esc(a.ip||'No IP recorded')+'</div><div class="tm">'+esc(exact(a.t))+'</div></div></div>'}).join(''):empty('No signals to review','No alerts recorded in the last 7 days.');
 $('#door').innerHTML=D.door.length?'<table><thead><tr><th>When</th><th>Event</th><th>Browser profile</th><th>IP</th></tr></thead><tbody>'+D.door.map(function(e){return '<tr><td>'+esc(exact(e.t))+'</td><td>'+esc(e.text)+'</td><td><button class="btn" data-dev="'+esc(e.dev)+'">'+esc(display(dv[e.dev]||{}))+'</button></td><td class="mono">'+esc(e.ip)+'</td></tr>'}).join('')+'</tbody></table>':empty('No access events','Sign-ins and rejected attempts appear here.');
 $('#blocked').innerHTML=D.blocked.length?D.blocked.map(function(b){return '<button class="feed-event" data-dev="'+esc(b.id)+'"><span class="feed-event-top"><strong>'+esc(display(dv[b.id]||{}))+'</strong></span><span>Blocked '+esc(exact(b.at))+'</span></button>'}).join(''):empty('No blocked profiles','Controls are available in each profile’s Access tab.');
 $('#ips').innerHTML=D.ips.length?'<table><thead><tr><th>IP / network</th><th>Profiles</th><th>Last seen</th><th>Lookup</th></tr></thead><tbody>'+D.ips.map(function(x){return '<tr><td class="mono">'+esc(x.ip)+(x.shared?' <span class="tag">shared</span>':'')+'</td><td>'+x.devs.map(function(id){return '<button class="btn" data-dev="'+esc(id)+'">'+esc(display(dv[id]||{}))+'</button>'}).join('<br>')+'</td><td>'+ago(x.last)+'</td><td>'+ipLookup(x.ip,x.lookup)+'</td></tr>'}).join('')+'</tbody></table>':empty('No IP observations','Addresses appear when the app receives requests.');
}
function loadSec(){return api('__ADMIN__/api/security').then(function(d){S.sec=d;renderSec()}).catch(function(){if(!S.sec)$('#alerts').innerHTML=empty('Security data unavailable','Use Refresh to try again.');$('#syncStatus').textContent='Security refresh failed'})}

// Device detail has separate history, activity, metadata, access and ticket surfaces.
var TABS=[['history','Browsing history'],['activity','Activity'],['device','Device details'],['access','Access'],['bets','Bets']];
function openDev(id){S.open=id;S.det=null;S.tab='history';S.sess=null;S.f='all';S.hsport='';S.hperiod='all';S.exp={};S.armed=false;$('#dTitle').textContent='Loading profile…';$('#dSubtitle').textContent='';$('#deviceTabs').innerHTML='';$('#dBody').innerHTML=empty('Loading history','');$('#deviceNotice').hidden=true;if(!$('#drawer').open)$('#drawer').showModal();loadDev()}
function closeDev(){S.open=null;S.det=null;$('#drawer').close()}
function loadDev(){var id=S.open;if(!id)return;return api('__ADMIN__/api/device/'+id).then(function(d){if(S.open!==id)return;S.det=d;if(S.sess&&!(d.sessionList||[]).some(function(s){return s.start===S.sess}))S.sess=null;drawDev()}).catch(function(e){if(S.open!==id)return;$('#deviceNotice').hidden=false;$('#deviceNotice').textContent=e.message||'Profile could not be refreshed.'})}
function drawDev(){
 var d=S.det;if(!d)return;var scroll=$('#dBody').scrollTop;
 $('#dTitle').innerHTML=esc(display(d))+(d.role==='owner'?' <span class="chip you">You</span>':'');
 $('#dSubtitle').textContent=devLine(d)+' · Last request '+ago(d.last);
 $('#deviceTabs').innerHTML=TABS.map(function(t){return '<button data-dtab="'+t[0]+'" class="'+(S.tab===t[0]?'on':'')+'" aria-pressed="'+(S.tab===t[0])+'">'+t[1]+'</button>'}).join('');
 $('#dBody').innerHTML=S.tab==='history'?historyPane(d):S.tab==='activity'?activityPane(d):S.tab==='device'?devicePane(d):S.tab==='access'?accessPane(d):betsPane(d);
 $('#dBody').scrollTop=scroll;
}
function sportOptions(value){return '<option value="">All sports</option>'+Object.keys(SPORT).map(function(k){return '<option value="'+esc(k)+'"'+(value===k?' selected':'')+'>'+esc(SPORT[k])+'</option>'}).join('')}
function sessionFilter(d){return '<label>Session <select id="historySession"><option value="">All sessions</option>'+(d.sessionList||[]).map(function(s){var value=s.start;return '<option value="'+value+'"'+(S.sess===s.start?' selected':'')+'>'+esc(exact(s.start))+'</option>'}).join('')+'</select></label>'}
function inSession(t){if(!S.sess)return true;var session=((S.det&&S.det.sessionList)||[]).find(function(s){return s.start===S.sess});return !!session&&t>=session.start&&t<=session.end}
function historyPane(d){
 var all=d.browsingHistory||[],hist=all.filter(function(e){return (!S.hsport||e.sp===S.hsport)&&periodMatch(e.t,S.hperiod)&&inSession(e.t)});
 var h=intro('Browsing history','Pages opened inside THE.BOARD. New records use server receipt times. Older records keep their original timestamps; reports are labeled by source.');
 h+='<div class="activity-filters"><label>Sport<select id="historySport">'+sportOptions(S.hsport)+'</select></label><label>Period<select id="historyPeriod"><option value="all"'+(S.hperiod==='all'?' selected':'')+'>Retained history</option><option value="day"'+(S.hperiod==='day'?' selected':'')+'>Last 24 hours</option><option value="week"'+(S.hperiod==='week'?' selected':'')+'>Last 7 days</option></select></label>'+sessionFilter(d)+'</div><div class="history-summary">'+hist.length+' page records · '+(d.sessionList||[]).length+' observed sessions</div>';
 if(!hist.length)return h+empty('No pages in this view',all.length?'Adjust the filters to see other visits.':'Page history begins when this browser reports a visit. Earlier activity cannot be reconstructed.');
 var day='';h+='<ol class="history-list">';
 hist.forEach(function(e){var label=dayL(e.t);if(label!==day){day=label;h+='<li class="history-day" style="display:block">'+esc(label)+'</li>'}var path='/'+e.sp+'/' +(e.route?'#'+e.route:'');h+='<li><time title="'+esc(exact(e.t))+'">'+clock(e.t)+'</time><span class="history-dot" aria-hidden="true"></span><div class="history-page"><strong>'+esc(e.page||'Page visit')+'</strong><small>'+esc(path)+'</small><div class="history-source">'+(e.legacy?'Historical timestamp · ':'')+(e.source==='server'?'Server request':'Browser-reported page')+'</div></div><span class="history-sport">'+esc(SPORT[e.sp]||e.sp||'Board')+'</span></li>'});
 h+='</ol><p class="note">Up to 500 recent page records. These are app visits, not browsing history from other sites.</p>';
 return h;
}
var KIND={all:'All',views:'Pages',taps:'Interactions',money:'Bets',errors:'Errors',visits:'Access'};
function match(e){if(!inSession(e.t))return false;if(!S.bg&&S.f!=='errors'&&e.lvl!==1)return false;if(S.f==='taps')return e.k==='click'||e.k==='act';if(S.f==='views')return e.k==='view'||(e.k==='req'&&e.p==='/');if(S.f==='money')return e.k==='req'&&/^\/api\/(bets|betmgm)/.test(e.p)&&e.m!=='GET'||e.k==='req'&&e.p==='/api/betmgm/go';if(S.f==='errors')return e.k==='err'||e.k==='error'||e.s>=400;if(S.f==='visits')return e.k==='visit'||e.k==='enter';return true}
function activityPane(d){
 var tl=(d.timeline||[]).filter(match),h=intro('Activity timeline','Interactions, page visits, access events and app errors. Automatic requests are hidden unless included or you select Errors.');
 h+='<div class="filters"><div class="seg" role="group" aria-label="Activity type">'+Object.keys(KIND).map(function(k){return '<button data-f="'+k+'" class="'+(S.f===k?'on':'')+'" aria-pressed="'+(S.f===k)+'">'+KIND[k]+'</button>'}).join('')+'</div><label><input type="checkbox" id="bg"'+(S.bg?' checked':'')+'> Include automatic requests</label>'+sessionFilter(d)+'</div>';
 h+='<div class="history-summary">'+tl.length+' matching records'+(tl.length>500?' · showing latest 500':'')+'</div><div class="card">';var last='';
 h+=tl.length?tl.slice(0,500).map(function(e){var day=dayL(e.t),prefix='';if(day!==last){last=day;prefix='<div class="tl-day">'+esc(day)+'</div>'}var raw={};Object.keys(e).forEach(function(k){if(k!=='text'&&k!=='lvl')raw[k]=e[k]});return prefix+'<div class="tl'+(e.lvl!==1?' bg':'')+'"><button class="event-toggle" data-ev="'+esc(e.id)+'" aria-expanded="'+!!S.exp[e.id]+'"><time>'+clock(e.t)+'</time><span class="tx">'+esc(e.text)+'<small>'+esc([SPORT[e.sp]||'Access',source(e)].join(' · '))+'</small></span><span class="chevron" aria-hidden="true">'+(S.exp[e.id]?'−':'+')+'</span></button>'+(S.exp[e.id]?'<pre>'+esc(JSON.stringify(raw,null,2))+'</pre>':'')+'</div>'}).join(''):empty('No matching activity','Try a different filter.');
 return h+'</div><p class="note">Open a record to inspect the evidence. Client reports can be altered by the browser; they do not verify someone’s identity.</p>';
}
function devicePane(d){
 var c=d.ctx||{},h=intro('Device details','Device and browser names are inferred from the user agent. Display, language and time-zone values are browser-reported.');
 h+='<div class="facts">'+fx('Device',d.device+(d.model?' · '+d.model:''))+fx('Operating system',[d.os,d.osVer].filter(Boolean).join(' '))+fx('Browser',brLine(d))+fx('Screen',c.sw?c.sw+' × '+c.sh+(c.dpr?' @'+c.dpr+'x':''):'')+fx('Window',c.vw?c.vw+' × '+c.vh:'')+fx('App mode',c.sw?(c.standalone?'Home-screen / installed app':'Browser tab'):'')+'</div>';
 h+='<section class="d-sec"><h3>Network & locale</h3><div class="facts">'+fx('Observed IP',d.ipLast)+fx('IP source',ipSource(d.ipInfo))+fx('Address type',ipKind(d.ipInfo))+fx('Browser time zone',c.tz)+fx('Language',c.langs||c.locale)+fx('IP last observed',d.ipInfo?exact(d.ipInfo.observedAt):'')+'</div><p class="note">'+esc(ipReason(d.ipInfo))+' A time zone describes clock rules, not a city. VPNs and Private Relay can mask the network location; IP lookup is not GPS.</p></section>';
 h+='<section class="d-sec"><h3>Observed IP history <span>'+(d.ipHistory||[]).length+' addresses</span></h3><div class="card scroll"><table><thead><tr><th>Address</th><th>First observed</th><th>Last observed</th><th>Lookup</th></tr></thead><tbody>'+(d.ipHistory||[]).map(function(i){return '<tr><td class="mono">'+esc(i.ip)+'<div class="ip-source">'+esc(ipCaption(i.ipInfo))+'</div></td><td>'+esc(exact(i.first))+'</td><td>'+esc(exact(i.last))+'</td><td>'+ipLookup(i.ip,i.lookup)+'</td></tr>'}).join('')+'</tbody></table></div></section>';
 h+='<details class="technical"><summary>Technical details & browser reports</summary><div class="facts">'+fx('Browser-profile ID',d.id)+fx('First observed',exact(d.first))+fx('Latest request',exact(d.last))+fx('Observed session span',dur(d.timeOn)+' · includes idle/background gaps')+fx('Touch capability',c.touch==null?'':c.touch+' touch points')+fx('Reported network',c.net?c.net+(c.rtt?' · estimated '+c.rtt+' ms':''):'')+fx('Sports used',(d.sports||[]).map(function(s){return SPORT[s]}).join(', '))+fx('Automation heuristic',d.bot?'User agent resembles automation':'No indicator in user agent')+'</div><p class="note">User agent, as reported:</p><div class="raw">'+esc(d.ua||'No user agent reported')+'</div>';
 if((d.uaHistory||[]).length>1)h+='<p class="note">Earlier user-agent observations under this browser cookie:</p>'+(d.uaHistory||[]).map(function(u){return '<div class="raw">'+esc(u.ua)+'\nLast received '+esc(exact(u.last))+'</div>'}).join('');
 return h+'</details>';
}
function accessPane(d){
 var h=intro('Access controls','These controls apply to this browser cookie. Clearing cookies or using another browser creates a different profile.');
 if(d.blocked)h+='<div class="banner">This browser profile is blocked from all sports boards.</div>';
 h+='<div class="ctl"><h3>Name this profile</h3><div class="field-row"><input id="lbl" aria-label="Profile name" maxlength="40" placeholder="e.g. My iPhone" value="'+esc(d.label)+'"><button class="btn pri" data-act="label">Save name</button></div>'+(d.name&&d.label?'<p>In-app name: '+esc(d.name)+'</p>':'')+'</div>';
 h+='<div class="ctl"><h3>Display classification</h3><div class="seg" role="group" aria-label="Profile classification">'+[['auto','Automatic'],['owner','This is me'],['guest','Guest']].map(function(r){var on=(d.roleSet||'auto')===r[0];return '<button data-role="'+r[0]+'" aria-pressed="'+on+'" class="'+(on?'on':'')+'">'+r[1]+'</button>'}).join('')+'</div><p>This label organizes the list. It does not grant admin access. Last authenticated role: '+esc(d.roleSeen||'none')+'.</p></div>';
 h+='<div class="ctl"><h3>Access & records</h3><div class="access-actions">'+(d.role!=='owner'?'<button class="btn danger" data-act="'+(d.blocked?'unblock':'block')+'">'+(d.blocked?'Unblock profile':'Block profile')+'</button><button class="btn" data-act="signout">Sign out profile</button>':'')+'<a class="btn" href="__ADMIN__/api/export?fmt=csv&dev='+esc(d.id)+'">Export CSV</a><a class="btn" href="__ADMIN__/api/export?fmt=json&dev='+esc(d.id)+'">Export JSON</a></div><p>'+(d.role==='owner'?'Owner profiles are protected from blocking and remote sign-out.':'Blocking sends this profile to the sign-in screen. Sign-out is applied on its next request.')+'</p></div>';
 return h+'<div class="ctl"><h3>Clear from this view</h3><p>Hides this profile’s recorded activity from the Admin Center. This does not delete its bets, erase the archived logs, or sign out the browser.</p><div class="access-actions" style="margin-top:14px"><button class="btn danger'+(S.armed?' armed':'')+'" data-act="clear">'+(S.armed?'Confirm clear profile':'Clear profile')+'</button></div></div>';
}
function betsPane(d){
 var list=d.betList||[],h=intro('Logged bets','Tickets linked to this browser profile across sports. Opening a sportsbook does not confirm a wager was placed.');
 if(!list.length)return h+empty('No bets logged','Page visits and interactions are still available in the other tabs.');
 return h+'<div class="card scroll"><table><thead><tr><th>Logged / placed</th><th>Sport</th><th>Selection</th><th>Stake</th><th>Book</th><th>Result</th></tr></thead><tbody>'+list.map(function(b){return '<tr><td>'+esc(exact(Date.parse(b.placed)||b.created))+'</td><td>'+esc(SPORT[b.sp])+'</td><td>'+esc(b.text)+(b.legs>1?' · '+b.legs+' legs':'')+'</td><td>'+esc(money(b.stake))+'<br><span class="dim">'+esc(odds(b.odds))+'</span></td><td>'+esc(b.book||'—')+'</td><td class="'+(b.status==='won'?'w':b.status==='lost'?'l':'')+'">'+esc(b.status)+(b.status!=='open'?'<br>'+esc(money(b.net,true)):'')+'</td></tr>'}).join('')+'</tbody></table></div>';
}

function notice(message){$('#deviceNotice').hidden=false;$('#deviceNotice').textContent=message}
function changeDevice(body,method){var id=S.open;$('#deviceNotice').hidden=true;return api('__ADMIN__/api/device/'+id,{method:method||'POST',body:body?JSON.stringify(body):undefined}).then(function(){if(method==='DELETE')closeDev();else if(S.open===id){notice('Saved.');loadDev()}loadBoard();if(S.view==='security')loadSec()}).catch(function(e){notice(e.message||'Change could not be saved.')})}
document.addEventListener('click',function(ev){
 var view=ev.target.closest('[data-view]');if(view){ev.preventDefault();history.replaceState(null,'','#'+view.dataset.view);setView(view.dataset.view);return}
 var t=ev.target.closest('[data-seg],[data-dev],[data-dtab],[data-f],[data-ev],[data-act],[data-role],#dClose,#refreshAdmin');if(!t)return;
 if(t.id==='dClose'){closeDev();return}if(t.id==='refreshAdmin'){loadBoard();if(S.view==='security')loadSec();if(S.open)loadDev();return}
 if(t.dataset.seg){S.seg=t.dataset.seg;try{localStorage.setItem('adm.seg',S.seg)}catch(e){}render();return}
 if(t.dataset.dev){ev.preventDefault();openDev(t.dataset.dev);return}
 if(t.dataset.dtab){S.tab=t.dataset.dtab;S.armed=false;$('#dBody').scrollTop=0;drawDev();return}
 if(t.dataset.f){S.f=t.dataset.f;drawDev();return}
 if(t.dataset.ev){S.exp[t.dataset.ev]=!S.exp[t.dataset.ev];drawDev();return}
 if(t.dataset.role){changeDevice({role:t.dataset.role});return}
 var action=t.dataset.act;if(action==='label'){changeDevice({label:$('#lbl').value});return}
 if(['block','unblock','signout'].includes(action)){changeDevice({action:action});return}
 if(action==='clear'){if(!S.armed){S.armed=true;drawDev();setTimeout(function(){if(S.armed){S.armed=false;if(S.open)drawDev()}},5000);return}S.armed=false;changeDevice(null,'DELETE')}
});
document.addEventListener('input',function(e){if(e.target.id==='deviceSearch'){S.q=e.target.value;render()}if(e.target.id==='activitySearch'){S.aq=e.target.value;renderActivity()}});
document.addEventListener('change',function(e){var id=e.target.id,v=e.target.value;if(id==='activitySport')S.asport=v;else if(id==='activityKind')S.akind=v;else if(id==='activityPeriod')S.aperiod=v;else if(id==='historySport')S.hsport=v;else if(id==='historyPeriod')S.hperiod=v;else if(id==='historySession')S.sess=v?Number(v):null;else if(id==='bg')S.bg=e.target.checked;else return;if(id.startsWith('activity'))renderActivity();else drawDev()});
document.addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target.id==='lbl'){e.preventDefault();changeDevice({label:e.target.value})}if((e.key==='Enter'||e.key===' ')&&e.target.matches('.al[data-dev]')){e.preventDefault();openDev(e.target.dataset.dev)}});
$('#drawer').addEventListener('cancel',function(e){e.preventDefault();closeDev()});
$('#drawer').addEventListener('click',function(e){if(e.target!==$('#drawer'))return;var rect=e.target.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right)closeDev()});
var loading=false;
function loadBoard(){if(loading)return Promise.resolve();loading=true;$('#refreshAdmin').disabled=true;return api('__ADMIN__/api/board').then(function(d){S.data=d;render();$('#syncStatus').textContent='Updated '+new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}).catch(function(){$('#syncStatus').textContent='Refresh unavailable';if(!S.data)$('#rows').innerHTML=empty('Unable to load devices','Use Refresh to try again.')}).finally(function(){loading=false;$('#refreshAdmin').disabled=false})}
S.view=location.hash==='#security'?'security':location.hash==='#activity'?'activity':'people';setView(S.view);loadBoard();
var timer=setInterval(function(){if(document.visibilityState!=='visible')return;loadBoard();if(S.view==='security')loadSec();if(S.open&&!$('#dBody').contains(document.activeElement))loadDev()},8000);
addEventListener('pagehide',function(){clearInterval(timer)});
addEventListener('hashchange',function(){setView(location.hash.slice(1))});
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')loadBoard()});
})();
