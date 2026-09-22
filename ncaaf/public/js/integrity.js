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
function quoteStatusHTML(L, g, mkt, side) {
  const f = quoteFreshness(L, g, mkt, side);
  return `<small class="integrity-fresh" title="Age is measured from source observation time">${esc(f.status)}</small>`;
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
function integrityGamePanel(g) {
  const rows = [['s','home',`${g.home?.abbr || 'Home'} spread`],['t','over','Total'],['ml','home',`${g.home?.abbr || 'Home'} moneyline`]].map(([m,s,label]) => {
    const r = canonicalResolution(g,m,s);
    if (!r) return '';
    const q = r.current, f = q ? quoteFreshness(q,g).status : 'UNVERIFIED';
    return `<div><b>${esc(label)}</b><div class="note">Open: ${esc(integrityQuoteText(r.open))}<br>${esc(integrityUTC(r.open?.source_observed_at))} · ${esc(r.open?.sportsbook || 'source unavailable')} / ${esc(r.open?.source || 'unverified')}<br>Current: ${esc(integrityQuoteText(q))} · ${esc(f)}<br>${esc(integrityUTC(q?.source_observed_at))} · ${esc(q?.sportsbook || 'source unavailable')} / ${esc(q?.source || 'unverified')}<br>Close: ${esc(integrityQuoteText(r.close))} · ${esc(r.close_status || 'UNAVAILABLE')}<br>${esc(r.kickoff_basis || 'kickoff unverified')} · ${esc(r.reason_code || '')}</div>${r.close ? `<div class="note">${esc(integrityUTC(r.close.source_observed_at))} · ${esc(bookName(r.close.sportsbook))} / ${esc(r.close.source)}</div>` : ''}</div>`;
  }).filter(Boolean);
  return `<div class="card integrity-panel"><h3>Market provenance</h3><p class="note">RETROSPECTIVE MARKET MOVE · Opening-to-current or opening-to-close movement is market history. Earned CLV requires a timestamped entry snapshot.</p>${rows.join('') || '<p class="note">UNVERIFIED · Historical lines have no canonical quote evidence.</p>'}</div>`;
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
