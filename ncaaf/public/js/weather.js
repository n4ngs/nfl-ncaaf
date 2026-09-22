'use strict';
/* Hook & Ladder — Weather watch (Board tab). Pre-game outdoor games in the week on the board with strong wind
   (15+ mph sustained or 25+ mph gusts, averaged kickoff through the second half; lib/weather.js), with the total's
   move since it opened. Informational only: what the forecast says and what the number did, no advice. The card
   is hidden when no game is windy. The summary stays visible for affected games; details expand on demand.
   renderBoard (views.js) calls wxBoard(week) on every paint. */

const WX_WIND = 15;  // sustained, mph
const WX_GUST = 25;  // gusts, mph

const wxWindy = (g) => isPre(g) && !!g.wx && !g.wx.dome && ((g.wx.wind ?? 0) >= WX_WIND || (g.wx.gust ?? 0) >= WX_GUST);

// "Wind 18 mph from the NW, gusts 27"
function wxWindTxt(w) {
  return `Wind ${w.wind ?? '—'} mph${w.dir ? ` from the ${w.dir}` : ''}${w.gust != null ? `, gusts ${w.gust}` : ''}`;
}
// "Total 52.5 → 50.5 since open", "Total 52.5, same as the open", "Total 52.5"
function wxTotalTxt(g) {
  const now = g.mkt?.t, open = g.open?.t;
  if (now == null) return open != null ? `Total opened ${fmtTot(open)}` : 'No total posted yet';
  if (open == null) return `Total ${fmtTot(now)}`;
  if (now === open) return `Total ${fmtTot(now)}, same as the open`;
  return `Total ${fmtTot(open)} → ${fmtTot(now)} since open`;
}

function wxRow(g) {
  const w = g.wx;
  const extra = [w.temp != null ? `${w.temp}°F` : null, w.pop != null ? `${w.pop}% rain` : null].filter(Boolean).join(' · ');
  const when = `${dayLabel(g.start)} ${g.tbd ? 'TBA' : timeLabel(g.start)}`;
  const label = `${g.away.short} at ${g.home.short}, ${when}. ${wxWindTxt(w)}. ${extra}. ${wxTotalTxt(g)}. Open the game.`;
  return `<button type="button" class="wx-row" data-open="${esc(g.id)}" aria-label="${esc(label.replace(/→/g, 'to').replace(MINUS, 'minus '))}">
    <span class="wx-top"><b>${esc(g.away.short)} @ ${esc(g.home.short)}</b><span class="num">${esc(when)}</span></span>
    <span class="wx-l num">${esc(wxWindTxt(w))}${extra ? ` <span class="wx-x">· ${esc(extra)}</span>` : ''}</span>
    <span class="wx-l wx-t num">${esc(wxTotalTxt(g))}</span>
  </button>`;
}

function wxBoard(W) {
  let sec = $('#wxWatch');
  if (!sec) {
    sec = document.createElement('details');
    sec.id = 'wxWatch';
    sec.className = 'card wx';
    sec.setAttribute('aria-labelledby', 'wxTitle');
    sec.innerHTML = `<summary class="wx-h"><h3 id="wxTitle">${ICON.wind}Weather watch</h3><span class="wx-count"></span></summary>
      <div class="wx-list"></div>
      <p class="wx-note">Strong wind has tended to lower scoring. It’s one factor among many. Forecast from Open-Meteo, kickoff through the second half.</p>`;
    const body = $('#boardBody');
    if (!body?.parentNode) return;
    body.parentNode.insertBefore(sec, body);
  }
  const games = W ? [...W.games.values()].filter(wxWindy).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) : [];
  const summary = sec.querySelector('.wx-h'), count = sec.querySelector('.wx-count'), list = sec.querySelector('.wx-list');
  const label = `${plural(games.length, 'game')} affected · wind ${WX_WIND}+ mph / gusts ${WX_GUST}+ mph`;
  if (count.textContent !== label) count.textContent = label;
  const html = games.map(wxRow).join('');
  const activeRow = document.activeElement?.closest?.('.wx-row');
  const focusedGame = activeRow && sec.contains(activeRow) ? activeRow.dataset.open : null;
  sec.hidden = !games.length;
  // Keep the disclosure and summary stable; restore a focused game after changed forecast rows.
  if (list.dataset.html !== html) {
    list.innerHTML = html;
    list.dataset.html = html;
    if (focusedGame && !sec.hidden) {
      const target = [...list.querySelectorAll('.wx-row')].find((row) => row.dataset.open === focusedGame) || summary;
      target.focus({ preventScroll: true });
    }
  }
}
