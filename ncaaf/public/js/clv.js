'use strict';
/* Only independently eligible entries contribute to earned CLV summaries. */
const clvAvg = (a) => a.length ? a.reduce((s,v)=>s+v,0)/a.length : null;
const clvSigned = (v,unit,d=1) => Number.isFinite(v) ? `${v>0?'+':v<0?MINUS:''}${Math.abs(v).toFixed(d)}${unit}` : '—';
function clvLegs() {
  return S.bets.filter(b=>b.status!=='void').flatMap(b=>b.legs.map(l=>({b,l,t:Date.parse(b.placed)||b.created||0}))).sort((a,b)=>a.t-b.t);
}
function clvLegHTML(l,b) {
  const I=l.integrity||{}, status=integrityStatus(l), entry=I.entry, close=I.close;
  const ef=I.entry_freshness?.status||'UNVERIFIED', cf=I.close_freshness?.status||'UNVERIFIED';
  const reason=I.reason_code || (status==='MISSING_ENTRY_SNAPSHOT'?'No immutable quote captured at wager time':'');
  const qrow=(label,q,fallback,stamp,fresh)=>`<div><b>${label}</b> ${esc(integrityQuoteText(q,fallback))}<small>${esc(integrityUTC(q?.source_observed_at||stamp))} · ${esc(q?.sportsbook?bookName(q.sportsbook):l.entry_record?.sportsbook||l.book||b?.book||'source unavailable')} / ${esc(q?.source||'unavailable')} · ${esc(fresh)}</small></div>`;
  return `<details class="integrity-leg"><summary>${esc(integrityShort(l))}</summary><div class="integrity-detail"><div><b>Wager placed</b> ${esc(integrityUTC(l.entry_record?.entry_created_at || b?.placed))}</div>${qrow('Entry quote',entry,l.entry_record||l,b?.placed,ef)}${qrow('Close',close,null,null,cf)}<div><b>Line CLV</b> ${clvSigned(integrityMetric(l,'line_clv_points'),' pts')}</div><div><b>No-vig probability CLV</b> ${clvSigned(integrityMetric(l,'clv_fair_probability_pp'),' pp',2)}</div><div><b>CLV-EV</b> ${clvSigned(integrityMetric(l,'clv_ev_pct'),'%',2)}</div><div class="note">${esc(I.kickoff_basis||I.resolution?.kickoff_basis||'Kickoff basis unavailable')} · ${esc(reason)}${I.price_clv_status&&!['VERIFIED_CLV','PROVISIONAL_CLV','COMPARABLE','AVAILABLE'].includes(I.price_clv_status)?` · Price CLV: ${esc(I.price_clv_status)}`:''}</div></div></details>`;
}
function clvCard() {
  const all=clvLegs(), verified=all.filter(x=>integrityVerified(x.l));
  const values=k=>verified.map(x=>integrityMetric(x.l,k,true)).filter(Number.isFinite);
  const labels={s:'Spread',t:'Total',h1s:'First-half spread',h1t:'First-half total',tt:'Team total'};
  const lineGroups=Object.entries(labels).map(([m,label])=>({label,legs:verified.filter(x=>x.l.mkt===m)}));
  const pts=values('line_clv_points'), pp=values('clv_fair_probability_pp'), ev=values('clv_ev_pct');
  const trends=lineGroups.map(({label,legs})=>{let sum=0;const series=legs.map(x=>integrityMetric(x.l,'line_clv_points',true)).filter(Number.isFinite).map((v,i)=>(sum+=v)/(i+1));return series.length>=3?`<h4>${esc(label)} CLV</h4>${clvSpark(series)}`:'';}).join('');
  const breakdown=(title,key)=>{
    const groups=new Map();for(const x of verified){const k=key(x);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x.l);}
    return `<table class="brk clv-t"><thead><tr><th>${esc(title)}</th><th>Verified</th><th>Line CLV (pts)</th><th>Probability (pp)</th><th>CLV-EV (%)</th></tr></thead><tbody>${[...groups].map(([k,legs])=>`<tr><td>${esc(k)}</td><td>${legs.length}</td>${['line_clv_points','clv_fair_probability_pp','clv_ev_pct'].map(m=>`<td>${clvSigned(clvAvg(legs.map(l=>integrityMetric(l,m,true)).filter(Number.isFinite)),'',2)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  };
  const counts=new Map();for(const {l} of all){const s=integrityStatus(l);counts.set(s,(counts.get(s)||0)+1);}
  return `<div class="card clv"><h3>Closing line value</h3><p class="clv-lede">Verified entries and actual-kickoff closes only in these averages. Provisional results and unavailable evidence are listed separately.</p><div class="clv-sum">${lineGroups.map(({label,legs})=>{const points=legs.map(x=>integrityMetric(x.l,'line_clv_points',true)).filter(Number.isFinite);return `<div><b class="num">${clvSigned(clvAvg(points),'')}</b><span>${esc(label)} line CLV · pts (${points.length})</span></div>`;}).join('')}<div><b class="num">${clvSigned(clvAvg(pp),' pp',2)}</b><span>no-vig probability CLV (${pp.length})</span></div><div><b class="num">${clvSigned(clvAvg(ev),'%',2)}</b><span>CLV-EV (${ev.length})</span></div></div><p class="note">${all.length?[...counts].map(([s,n])=>`${esc(s.replace(/_/g,' '))}: ${n}`).join(' · '):'No timestamped entries with closing evidence yet.'}</p>${trends}${breakdown('Market',x=>x.l.mkt)}${breakdown('Book / market',x=>`${x.b.book||'Unknown'} · ${labels[x.l.mkt]||x.l.mkt}`)}<p class="note">Price CLV requires the same market number and both opposing prices. Missing values remain unavailable.</p></div>`;
}

function clvSpark(series) {
  const W = 640, H = 120, P = 8;
  const lo = Math.min(0, ...series), hi = Math.max(0, ...series);
  const X = (i) => P + (i / Math.max(1, series.length - 1)) * (W - 2 * P);
  const Y = (v) => P + ((hi - v) / (hi - lo || 1)) * (H - 2 * P);
  return `<div class="clv-chart"><div class="sub-h">Running average<span>verified points vs the close, over time</span></div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running average closing line value, now ${clvSigned(series.at(-1), ' points')}">
      <line class="z" x1="${P}" x2="${W - P}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>
      <polyline class="ln" points="${series.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>
      <circle class="end" cx="${X(series.length - 1).toFixed(1)}" cy="${Y(series.at(-1)).toFixed(1)}" r="4"/>
    </svg></div>`;
}
