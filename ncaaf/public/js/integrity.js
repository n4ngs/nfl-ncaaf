'use strict';
/* CLV Integrity v1. Poll/receipt time is never proof of quote freshness. */
const INTEGRITY_DEFAULTS = { pregame_ms: 600000, live_ms: 30000, aging_ratio: 0.5 };
function quoteEvidence(L, mkt, side) {
  if (mkt && side) return L?.integrity?.[mkt]?.[side] || (L?.snapshot_id && L.market_type === mkt && L.selection === side ? L : null);
  return L || null;
}
function quoteFreshness(L, g = null, mkt = null, side = null) {
  const q = quoteEvidence(L, mkt, side);
  const raw = q?.freshness ?? L?.freshness;
  const related = q === L && !mkt ? Object.values(L?.integrity || {}).flatMap(sides => Object.values(sides)) : [];
  const hasEvidence = q?.snapshot_id && q.validation_status === 'VALID' || related.length > 0 && related.every(row => row.snapshot_id && row.validation_status === 'VALID');
  const supplied = typeof raw === 'string' ? raw : raw?.status;
  const status = String(q?.market_status || L?.market_status || '').toUpperCase();
  if (['SUSPENDED', 'REMOVED', 'CLOSED', 'INACTIVE'].includes(status) || supplied === 'SUSPENDED') return { status: 'SUSPENDED', age_ms: null };
  if (q?.conflict || q?.validation_status === 'SOURCE_CONFLICT' || ['CONFLICTED', 'SOURCE_CONFLICT'].includes(supplied)) return { status: 'CONFLICTED', age_ms: null };
  const at = typeof q?.source_observed_at === 'number' ? q.source_observed_at : Date.parse(q?.source_observed_at);
  if (!q || !hasEvidence || L?.m || !Number.isFinite(at) || at > serverNow() || !['ACTIVE', 'OPEN', 'TRADING'].includes(status) || supplied === 'UNVERIFIED') return { status: 'UNVERIFIED', age_ms: null };
  if (g && !isFinal(g) && typeof q.is_live === 'boolean' && q.is_live !== isLive(g)) return { status: 'UNVERIFIED', age_ms: null };
  const cfg = { ...INTEGRITY_DEFAULTS, ...g?.integrity?.thresholds };
  const age = Math.max(0, serverNow() - at);
  const limit = (g ? isLive(g) : q.is_live) ? cfg.live_ms : cfg.pregame_ms;
  return { status: age > limit || supplied === 'STALE' ? 'STALE' : age >= limit * cfg.aging_ratio ? 'AGING' : 'FRESH', age_ms: age };
}
function quoteCanAct(L, g = null, mkt = null, side = null) {
  return ['FRESH', 'AGING'].includes(quoteFreshness(L, g, mkt, side).status);
}
function quotePairCanDevig(L, g, mkt) {
  const [a,b] = ['t','h1t','tt'].includes(mkt) ? ['over','under'] : ['home','away'];
  const qa = quoteEvidence(L,mkt,a), qb = quoteEvidence(L,mkt,b);
  if (!quoteCanAct(L,g,mkt,a) || !quoteCanAct(L,g,mkt,b) || !qa || !qb) return false;
  for (const key of ['canonical_event_id','canonical_market_key','market_type','period','sportsbook','source','source_observed_at']) {
    if (!qa[key] || qa[key] !== qb[key]) return false;
  }
  if (qa.pair_id !== qb.pair_id || qa.is_live !== qb.is_live) return false;
  const pa=sideOf(L,mkt,a), pb=sideOf(L,mkt,b);
  if (!pa || !pb || pa.odds !== qa.american_odds || pb.odds !== qb.american_odds) return false;
  if (mkt === 'ml') return qa.line_value == null && qb.line_value == null;
  if (pa.line !== qa.line_value || pb.line !== qb.line_value) return false;
  return ['s','h1s'].includes(mkt) ? qa.line_value === -qb.line_value : qa.line_value === qb.line_value;
}
function quoteSnapshotId(L, mkt, side) {
  return quoteEvidence(L, mkt, side)?.snapshot_id || L?.snapshot_ids?.[mkt]?.[side] || null;
}
function quoteIsDeliveryOnly(L, g, mkt, side) {
  const q = quoteEvidence(L, mkt, side);
  if (!q || L?.m || q.source !== 'sharp' || !q.snapshot_id || q.validation_status !== 'UNVERIFIED'
      || q.reason_code !== 'MISSING_SOURCE_TIMESTAMP' || q.source_observed_at != null
      || q.market_status !== 'active' || q.conflict || q.source_conflict || q.timestamp_conflict
      || typeof q.is_live !== 'boolean' || g && q.is_live !== isLive(g)) return false;
  const delivered = typeof q.provider_received_at === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(q.provider_received_at)
    ? Date.parse(q.provider_received_at) : NaN;
  if (!Number.isFinite(delivered) || delivered > serverNow() || !Number.isFinite(q.american_odds)
      || Math.abs(q.american_odds) < 100 || q.market_type !== 'ml' && !Number.isFinite(q.line_value)) return false;
  if (mkt && side && q !== L) {
    const price = sideOf(L, mkt, side);
    if (q.market_type !== mkt || q.selection !== side || !price || price.odds !== q.american_odds
        || mkt !== 'ml' && price.line !== q.line_value) return false;
  }
  return true;
}
function quoteStatusHTML(L, g, mkt, side) {
  const f = quoteFreshness(L, g, mkt, side);
  const feedOnly = f.status === 'UNVERIFIED' && quoteIsDeliveryOnly(L, g, mkt, side);
  const title = feedOnly ? 'Provider delivery time is known; sportsbook observation time is unavailable. Not eligible for verified CLV.' : 'Age is measured from source observation time';
  if(f.status==='FRESH')return '<small class="quote-status-dot" aria-label="Recent source quote" title="Recently observed by the source. Open source details for the exact time."></small>';
  return `<small class="integrity-fresh" data-state="${esc(f.status)}" title="${esc(title)}">${esc(feedOnly ? 'Feed quote' : ({AGING:'Aging',STALE:'Stale',SUSPENDED:'Suspended',CONFLICTED:'Conflict',UNVERIFIED:'Unverified'}[f.status] || f.status))}</small>`;
}
function canonicalResolution(g, mkt, side) {
  return g?.integrity?.markets?.[`${mkt}:${side}`] || g?.integrity?.markets?.[mkt]?.[side] || null;
}
function canonicalClose(g) {
  // g.close is only published by the canonical resolver. Old cached payloads have no evidence.
  if (!g?.integrity) return null;
  return g.close || null;
}
function integrityStatus(l) {
  return l?.integrity?.eligibility_status || l?.integrity?.status || 'MISSING_ENTRY_SNAPSHOT';
}
function integrityVerified(l) { return integrityStatus(l) === 'VERIFIED_CLV'; }
function integrityMetric(l, key, verifiedOnly = false) {
  if (!(verifiedOnly ? integrityVerified(l) : ['VERIFIED_CLV', 'PROVISIONAL_CLV'].includes(integrityStatus(l)))) return null;
  const v = l?.integrity?.[key];
  return Number.isFinite(v) ? v : null;
}
function integrityLocalInput(value) {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at - new Date(at).getTimezoneOffset() * 60000).toISOString().slice(0,19) : '';
}
function integrityUTC(value) {
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(n) ? new Date(n).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'timestamp unavailable';
}
function integrityQuoteText(q, fallback = null) {
  if (!q && !fallback) return 'Unavailable';
  const row = q || fallback;
  const value = row.line_value ?? row.line;
  const odds = row.american_odds ?? row.odds;
  return [value != null ? String(value) : null, odds != null ? fmtOdds(odds) : 'price unavailable'].filter(Boolean).join(' · ');
}
function integrityShort(l) {
  const status = integrityStatus(l), pts = integrityMetric(l, 'line_clv_points');
  return `${status.replace(/_/g, ' ')}${pts == null ? '' : ` · ${pts > 0 ? '+' : ''}${pts} pts line CLV`}`;
}
function provenanceLabel(value, fallback = 'Unavailable') {
  const labels = {
    FRESH: 'Fresh', AGING: 'Aging', STALE: 'Stale', SUSPENDED: 'Suspended', UNVERIFIED: 'Unverified',
    CONFLICTED: 'Conflicting evidence', VERIFIED: 'Verified close', PROVISIONAL: 'Provisional close', UNAVAILABLE: 'Unavailable',
    EVENT_NOT_STARTED: 'Awaiting kickoff', VERIFIED_ACTUAL_START: 'Verified kickoff', SCHEDULED_START: 'Scheduled kickoff',
    ACTUAL_KICKOFF_UNAVAILABLE: 'Actual kickoff unverified', VERIFIED_ACTUAL_KICKOFF: 'Verified actual kickoff',
    SOURCE_CONFLICT: 'Conflicting evidence', STALE_CLOSE: 'Closing quote too old', MISSING_CLOSE: 'Closing quote unavailable',
    POST_KICK_CONTAMINATION: 'Only post-kickoff quotes available', MISSING_KICKOFF_TIMESTAMP: 'Kickoff time unavailable',
    SUSPENDED_MARKET: 'Market suspended', REMOVED_MARKET: 'Market removed', MISSING_SOURCE_TIMESTAMP: 'Source time unavailable',
    INVALID_INTEGRITY_JOURNAL: 'Evidence history could not be verified', TIMESTAMP_CONFLICT: 'Conflicting timestamps'
  };
  return labels[value] || fallback;
}
function provenanceBook(key) {
  const known = { czr: 'Caesars', mgm: 'BetMGM', pin: 'Pinnacle', dk: 'DraftKings', fd: 'FanDuel', stn: 'Station', sp: 'South Point', wg: 'Westgate', circa: 'Circa', wynn: 'Wynn', cons: 'Market consensus' };
  return known[key] || (key ? bookName(key) : 'Sportsbook unavailable');
}
function provenanceSource(key) {
  return { sharp: 'Sharp API', owls: 'Owls Insight', vsin: 'VSiN', an: 'Action Network', an1: 'Action Network', pin: 'Pinnacle', espn: 'ESPN', manual: 'Manual entry' }[key] || key || 'Source unavailable';
}
function provenanceTime(value) {
  const n = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(n)) return '<span class="provenance-time">Time unavailable</span>';
  const d = new Date(n), iso = d.toISOString();
  const day = d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return `<time class="provenance-time" datetime="${esc(iso)}" title="${esc(integrityUTC(value))}"><span>${esc(day)}</span><span>${iso.slice(11,16)} UTC</span></time>`;
}
function provenancePrice(q, market) {
  if (!q) return '<span class="provenance-missing">Unavailable</span>';
  const line = q.line_value ?? q.line, odds = q.american_odds ?? q.odds;
  const price = Number.isFinite(odds) ? fmtOdds(odds) : 'Price unavailable';
  if (market === 'ml') return `<span class="provenance-value">${esc(price)}</span>`;
  const number = !Number.isFinite(line) ? 'Line unavailable' : market === 's' && line === 0 ? 'PK' : market === 's' && line > 0 ? '+' + line : String(line).replace('-', '−');
  return `<span class="provenance-value">${esc(number)}</span><span class="provenance-price">${esc(price)}</span>`;
}
function provenanceQuote(q, market, phase, status, emptyLabel = 'Unavailable') {
  const tone = ['FRESH','VERIFIED'].includes(status) ? 'good' : ['AGING','PROVISIONAL'].includes(status) ? 'caution' : ['STALE','SUSPENDED','CONFLICTED'].includes(status) ? 'warn' : 'neutral';
  return `<div class="provenance-quote${phase === 'Current' ? ' provenance-current' : ''}"><span class="provenance-phase">${phase}</span><div class="provenance-amount">${q ? provenancePrice(q, market) : `<span class="provenance-missing">${esc(emptyLabel)}</span>`}</div>${q ? `<span class="provenance-book">${esc(provenanceBook(q.sportsbook))}</span>` : ''}${status ? `<span class="provenance-status provenance-${tone}" data-status="${esc(status)}">${esc(provenanceLabel(status))}</span>` : ''}</div>`;
}
function integrityGamePanel(g) {
  const audit = [], rows = [['s','home',`${g.home?.abbr || 'Home'} spread`],['t','over','Total · Over'],['ml','home',`${g.home?.abbr || 'Home'} moneyline`]].map(([m,s,label]) => {
    const r = canonicalResolution(g,m,s);
    if (!r) return '';
    const rawFresh = typeof r.current_freshness === 'string' ? r.current_freshness : r.current_freshness?.status;
    // A suppressed current quote stays suppressed; retain its reason without promoting latest_snapshot.
    const fresh = r.current ? quoteFreshness(r.current,g).status : ['STALE','SUSPENDED','CONFLICTED'].includes(rawFresh) ? rawFresh : 'UNVERIFIED';
    const closeStatus = r.close_status || 'UNAVAILABLE';
    const pending = !r.close && r.reason_code === 'EVENT_NOT_STARTED';
    const reason = provenanceLabel(r.reason_code, 'Closing evidence unavailable');
    const basis = provenanceLabel(r.kickoff_basis, 'Kickoff unverified');
    const currentSource = r.current ? `<div class="provenance-current-meta"><span>Current quote via ${esc(provenanceSource(r.current.source))}</span>${provenanceTime(r.current.source_observed_at)}</div>` : '';
    audit.push(`<div class="provenance-audit-market"><h4>${esc(label)}</h4><dl>${[['Opening',r.open],['Current',r.current],['Close',r.close]].map(([phase,q]) => `<div><dt>${phase}</dt><dd>${q ? `${esc(integrityUTC(q.source_observed_at))}<br>${esc(provenanceBook(q.sportsbook))} · ${esc(provenanceSource(q.source))}<br><span class="provenance-id">Snapshot: ${esc(q.snapshot_id || 'unavailable')}</span>` : 'No eligible quote'}</dd></div>`).join('')}<div><dt>Closing check</dt><dd>${esc(basis)} · ${esc(reason)}<br><code>${esc(closeStatus)} · ${esc(r.kickoff_basis || 'UNAVAILABLE')} · ${esc(r.reason_code || 'MISSING_CLOSE')}</code></dd></div></dl></div>`);
    return `<article class="provenance-market"><h4>${esc(label)}</h4><div class="provenance-quotes">${provenanceQuote(r.open,m,'Opening',null)}${provenanceQuote(r.current,m,'Current',fresh)}${provenanceQuote(r.close,m,'Close',pending ? null : closeStatus,pending ? 'Awaiting kickoff' : provenanceLabel(closeStatus))}</div>${currentSource}${pending ? '' : `<p class="provenance-close-note">${esc(r.close ? closeStatus === 'VERIFIED' ? basis : basis + ' · ' + reason : reason)}</p>`}</article>`;
  }).filter(Boolean);
  return `<section class="card integrity-panel provenance-panel" aria-label="Market provenance"><header class="provenance-head"><div><p class="provenance-eyebrow">Quote history</p><h3>Market provenance</h3></div><span class="provenance-kind">Market history</span></header><p class="provenance-intro">Earliest recorded prices, current quotes and closing evidence. Earned CLV requires a timestamped entry snapshot.</p>${rows.length ? `<div class="provenance-markets">${rows.join('')}</div><details class="provenance-details"><summary>Source details<span aria-hidden="true">+</span></summary><div class="provenance-audit"><p>RETROSPECTIVE MARKET MOVE · Opening-to-current or opening-to-close movement describes market history. It is not earned CLV.</p>${audit.join('')}</div></details>` : '<div class="provenance-empty"><b>Quote history unavailable</b><p>These historical lines have no canonical quote evidence. Source, timing and closing status remain unverified.</p></div>'}</section>`;
}
const integritySignals = new Map();
function recordDisplayedSignal(g, e, model = 'edge-existing-v1') {
  if (!g || !e || !e.book || !e.mkt || !e.side) return 'UNAVAILABLE';
  const books = e.mkt.startsWith('h1') ? g.h1 : isLive(g) ? g.live : g.books;
  const L = books?.[e.book], q = quoteEvidence(L,e.mkt,e.side);
  const id = quoteSnapshotId(L,e.mkt,e.side);
  if (!id || !quoteCanAct(L,g,e.mkt,e.side)) return 'UNAVAILABLE';
  const px = sideOf(L,e.mkt,e.side);
  if (!px || px.odds !== e.odds || (e.mkt !== 'ml' && px.line !== e.line)) return 'UNAVAILABLE';
  const src = books?.[e.src], anchor = quoteEvidence(src,e.mkt,e.side);
  const featureAt = Math.max(Date.parse(q.source_observed_at) || 0, Date.parse(anchor?.source_observed_at) || 0);
  const at = serverNow();
  if (!featureAt || featureAt > at || !Number.isFinite(e.p)) return 'UNAVAILABLE';
  const key = `${model}|${id}|${e.p}|${e.ev}`;
  if (integritySignals.has(key)) return integritySignals.get(key);
  integritySignals.set(key, 'PENDING');
  // This timestamp records the feature set observed when the recommendation is displayed.
  // Original source timestamps remain on the referenced immutable quote.
  const body = { event_id: g.id, model_version: model, feature_version: 'observed-quotes-and-historical-keys-v1', prediction_created_at: new Date(at).toISOString(), features_as_of: new Date(at).toISOString(), entry_snapshot_id: id, predicted_probability: e.p, predicted_line: null, direction: e.side, strength: e.ev ?? null };
  api('/api/integrity/signals', { method: 'POST', body: JSON.stringify(body) }).then(result => {
    integritySignals.set(key, result?.signal?.signal_id ? 'RECORDED' : 'UNAVAILABLE');
    if (typeof invalidate === 'function') invalidate();
    if (S.sheet?.kind === 'slip' && typeof updateSlipCalc === 'function') updateSlipCalc();
  }).catch(() => {
    integritySignals.set(key, 'UNAVAILABLE');
    if (typeof invalidate === 'function') invalidate();
    if (S.sheet?.kind === 'slip' && typeof updateSlipCalc === 'function') updateSlipCalc();
  });
  return 'PENDING';
}

function signalEvidenceMessage(status) { return status === 'PENDING' ? 'Recommendation pending: saving immutable entry evidence.' : 'Recommendation unavailable: immutable signal evidence could not be saved.'; }

function sportsbookPrice(g,L,mkt,side,book,label,html) {
 if(typeof betHandoffCell!=='function'||!g||isFinal(g)||L?.m)return html;
 const q=quoteEvidence(L,mkt,side);if(!q||q.is_live!==isLive(g))return html;
 return betHandoffCell({...q,freshness:quoteFreshness(L,g,mkt,side).status},book,g.id,mkt,side,label,html);
}
