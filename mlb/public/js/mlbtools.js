'use strict';
/* Bing Bong Live — Tools: the calculators, your sizing, and where every number on the board comes from.

   Informational by design: nothing here tells you to bet, nothing suggests a stake, and every number that
   comes out of a model says est. The arithmetic ones (converter, parlay, hedge) are exact and say so.
   Odds math is borrowed from odds.js (oddsDec, oddsImp, oddsProbToAm, oddsNoVig) and formatting from
   bets.js (betsFmtOdds, betsFmtMoney, betsFmtPct) so one price never reads two ways.
   Every top-level name here starts with mlbTools / MLBTOOLS_, except the entry point mlbToolsHook. */

// ------------------------------------------------------------ state
const MLBTOOLS = { health: null, healthAt: 0, healthErr: false, nvMkt: 'ml' };

// Where the numbers come from. `host` is the key the server's health record uses, when it keeps one.
const MLBTOOLS_SRC = [
  ['MLB Stats API', 'feed', "Scores, every at-bat pitch by pitch, Statcast and the home run video"],
  ['Action Network', 'api.actionnetwork.com', 'The book list, prices and line moves'],
  ['VSiN line tracker', 'data.vsin.com', "The Nevada counters: Circa, Boomer's, Station, South Point, Westgate and Wynn"],
  ['Pinnacle', 'guest.api.arcadia.pinnacle.com', 'The sharp price, which can be up to 15 minutes old'],
  ['ESPN', 'site.api.espn.com', 'DraftKings prices'],
];

// ------------------------------------------------------------ small helpers
// Read a field defensively: an empty box, a stray "$" or a pasted "−110" all have to land somewhere sane.
function mlbToolsNum(sel) {
  const raw = String($(sel)?.value ?? '').trim().replace(/[−–—]/g, '-').replace(/[^0-9.+-]/g, '');
  if (!raw) return NaN;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}
// American odds are only American odds from ±100 out.
const mlbToolsAm = (n) => (Number.isFinite(n) && Math.abs(n) >= 100 ? Math.round(n) : null);
const mlbToolsOdds = (sel) => mlbToolsAm(mlbToolsNum(sel));
const mlbToolsCents = (n) => Math.round(n * 100) / 100;
const mlbToolsMoney = (n) => betsFmtMoney(mlbToolsCents(n));
const mlbToolsOddsTxt = (o) => (o == null ? '—' : betsFmtOdds(o));
// One output tile, the same shape in every card.
const mlbToolsTile = (k, v, sub = '', small = false) => `<div><div class="k">${esc(k)}</div><div class="v num${small ? ' sm' : ''}">${esc(v)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
const mlbToolsHint = (msg) => `<div class="mlbt-hint">${esc(msg)}</div>`;
// Paint only when something actually changed: this runs on every render while the tab is open.
function mlbToolsSet(sel, html) {
  const el = $(sel);
  if (!el || el.dataset.key === html) return;
  el.dataset.key = html;
  el.innerHTML = html;
}

// ------------------------------------------------------------ entry point
function mlbToolsHook() {
  const body = $('#toolsBody');
  if (!body) return;
  if (!body.dataset.built) {
    body.dataset.built = '1';
    body.innerHTML = mlbToolsHTML();
    body.addEventListener('input', mlbToolsUpdate);
    body.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-mlbt-nv]');
      if (!t) return;
      MLBTOOLS.nvMkt = t.dataset.mlbtNv === 't' ? 't' : 'ml';
      mlbToolsUpdate();
    });
  }
  mlbToolsLoadHealth();
  mlbToolsUpdate();
  if (typeof grpToolsPaint === 'function') grpToolsPaint();
}

// ------------------------------------------------------------ the cards
function mlbToolsHTML() {
  return `<div class="mlbt-tools">
    ${typeof grpToolsCard === 'function' && S.me?.role !== 'guest' ? grpToolsCard() : ''}
    <section class="card mlbt-card" aria-labelledby="mlbtConvH">
      <h3 id="mlbtConvH">Odds converter</h3>
      <p>American odds as a decimal price, the chance they imply, and what a stake wins.</p>
      <div class="mlbt-fgrid">
        <label class="mlbt-fld">American odds<input class="mlbt-inp" id="mlbtOdds" inputmode="text" autocomplete="off" spellcheck="false" value="-110"></label>
        <label class="mlbt-fld">Stake ($)<input class="mlbt-inp" id="mlbtStake" inputmode="decimal" autocomplete="off" value="100"></label>
      </div>
      <div class="mlbt-out" id="mlbtConvOut" aria-live="polite"></div>
      <p class="mlbt-note" id="mlbtConvNote"></p>
    </section>

    <section class="card mlbt-card" aria-labelledby="mlbtNvH">
      <h3 id="mlbtNvH">No-vig fair price</h3>
      <p>Both sides of the same market, with the book's cut taken back out. Pinnacle or Circa gives the sharpest read, because their price is the one other books follow.</p>
      <div class="mlbt-chips" role="group" aria-label="Which market">
        <button type="button" class="mlbt-chip" data-mlbt-nv="ml" id="mlbtNvMl">Money line</button>
        <button type="button" class="mlbt-chip" data-mlbt-nv="t" id="mlbtNvT">Run line or total</button>
      </div>
      <div class="mlbt-fgrid">
        <label class="mlbt-fld">Side A<input class="mlbt-inp" id="mlbtNvA" inputmode="text" autocomplete="off" spellcheck="false" value="-140"></label>
        <label class="mlbt-fld">Side B<input class="mlbt-inp" id="mlbtNvB" inputmode="text" autocomplete="off" spellcheck="false" value="+120"></label>
      </div>
      <div class="mlbt-out" id="mlbtNvOut" aria-live="polite"></div>
      <p class="mlbt-note">Fair prices and chances are estimates (est.). Money lines use the power method, the same one the odds board uses; run lines and totals are split straight down the middle.</p>
    </section>

    <section class="card mlbt-card" aria-labelledby="mlbtParH">
      <h3 id="mlbtParH">Parlay</h3>
      <p>Every leg's odds, separated by spaces or commas. The legs are treated as unrelated, which is the same assumption the book's own price makes.</p>
      <div class="mlbt-fgrid">
        <label class="mlbt-fld full">Leg odds<input class="mlbt-inp" id="mlbtParLegs" inputmode="text" autocomplete="off" spellcheck="false" value="-110, -110, +150"></label>
        <label class="mlbt-fld">Stake ($)<input class="mlbt-inp" id="mlbtParStake" inputmode="decimal" autocomplete="off" value="100"></label>
      </div>
      <div class="mlbt-out" id="mlbtParOut" aria-live="polite"></div>
      <p class="mlbt-note" id="mlbtParNote"></p>
    </section>

    <section class="card mlbt-card" aria-labelledby="mlbtHedgeH">
      <h3 id="mlbtHedgeH">Hedge</h3>
      <p>What the other side costs if you want the same result either way. Useful on a live sweat or a parlay's last leg.</p>
      <div class="mlbt-fgrid">
        <label class="mlbt-fld">Original win ($)<input class="mlbt-inp" id="mlbtHedgePay" inputmode="decimal" autocomplete="off" value="500"></label>
        <label class="mlbt-fld">Original stake ($)<input class="mlbt-inp" id="mlbtHedgeStake" inputmode="decimal" autocomplete="off" value="100"></label>
        <label class="mlbt-fld full">Odds on the other side<input class="mlbt-inp" id="mlbtHedgeOdds" inputmode="text" autocomplete="off" spellcheck="false" value="-150"></label>
      </div>
      <div class="mlbt-out" id="mlbtHedgeOut" aria-live="polite"></div>
      <p class="mlbt-note" id="mlbtHedgeNote"></p>
    </section>

    <section class="card mlbt-card" aria-labelledby="mlbtKellyH">
      <h3 id="mlbtKellyH">Bet sizing · Kelly</h3>
      <p>Kelly turns a win chance and a price into a share of a bankroll. It is only as good as the win chance behind it: a chance that is a little too high sizes a bet that is a lot too big. Your settings live on this device.</p>
      <div class="mlbt-kv" id="mlbtKellyOut" aria-live="polite"></div>
      <button type="button" class="mlbt-link" data-bets-kelly-settings>Open the sizing settings in Results</button>
      <p class="mlbt-note">Any dollar figure Kelly produces is an estimate (est.), not advice, and nothing is sized in dollars until you enter a bankroll yourself.</p>
    </section>

    <section class="card mlbt-card" aria-labelledby="mlbtBetsH">
      <h3 id="mlbtBetsH">Your bets on this device</h3>
      <p id="mlbtBetsP">Your bet log is private. It lives on this device and nobody else sees it, not even on your own phone, until you link the two.</p>
      <p class="mlbt-note">Linking lives in <b>Mine → Results → Your bets</b>: one device shows an 8-character code, the other enters it. The button above opens the same settings block.</p>
    </section>

    <section class="card mlbt-card" aria-labelledby="mlbtSrcH">
      <h3 id="mlbtSrcH">Where the numbers come from</h3>
      <p>Five feeds, all public. Prices can lag the counter by a few minutes, so check the ticket before you bet.</p>
      <div class="mlbt-srcs" id="mlbtSrcOut" aria-live="polite"></div>
    </section>

    <section class="card mlbt-card" aria-labelledby="mlbtKeyH">
      <h3 id="mlbtKeyH">Baseball numbers worth knowing</h3>
      <p>Football has key numbers. Baseball has three habits instead, and they explain most of what the board does.</p>
      <dl class="mlbt-defs">
        <div><dt>The run line is 1.5</dt><dd>Almost every game is posted at −1.5 and +1.5 rather than a moving spread. The favorite at −1.5 has to win by two; the underdog at +1.5 is fine losing by one.</dd></div>
        <div><dt>Why those prices swing so hard</dt><dd>Baseball games end by one run often enough that the whole difference between −1.5 and the money line sits in that single run. A team can be a heavy money-line favorite and close to even money on the run line, and the two prices move together: when the money line shortens, −1.5 shortens with it.</dd></div>
        <div><dt>Half a run on the total</dt><dd>Totals are hung in half-run steps, mostly in the 7 to 10 range. The half run matters because it removes the push: at a whole number the game can land exactly on it and the bet comes back.${typeof ODDS_PUSH_T === 'number' ? ` This app prices that push at roughly ${esc((ODDS_PUSH_T * 100).toFixed(0))}% on a whole-number total (est.).` : ''} Buying the half run either buys that push out or sells it, which is why the price changes so much for so little line.</dd></div>
        <div><dt>Money lines move on the pitcher</dt><dd>Lines go up with the probable starters, so a confirmation, a scratch or a late change re-prices the game before anything else does. A number that looks off is usually a number posted against a different starter.</dd></div>
      </dl>
      <p class="mlbt-note">No projections here, only how the market is shaped. Anything the app estimates is labelled est. wherever it is shown.</p>
    </section>
    ${typeof grpToolsCard === 'function' && S.me?.role === 'guest' ? grpToolsCard() : ''}
  </div>`;
}

// ------------------------------------------------------------ paint
function mlbToolsUpdate() {
  mlbToolsConvert();
  mlbToolsNoVig();
  mlbToolsParlay();
  mlbToolsHedge();
  mlbToolsKelly();
  mlbToolsBets();
  mlbToolsSources();
}

// 1. Odds converter
function mlbToolsConvert() {
  const o = mlbToolsOdds('#mlbtOdds');
  const stake = mlbToolsNum('#mlbtStake');
  if (o == null) {
    mlbToolsSet('#mlbtConvOut', mlbToolsHint('Enter odds like −110 or +150.'));
    mlbToolsSet('#mlbtConvNote', '');
    return;
  }
  const d = oddsDec(o);
  const win = stake > 0 ? stake * (d - 1) : null;
  mlbToolsSet('#mlbtConvOut', mlbToolsTile('Decimal', d.toFixed(3))
    + mlbToolsTile('Implied', betsFmtPct(oddsImp(o), 1))
    + mlbToolsTile('Wins', win == null ? '—' : mlbToolsMoney(win)));
  mlbToolsSet('#mlbtConvNote', win == null
    ? 'Add a stake to see what it wins.'
    : `${esc(mlbToolsMoney(stake))} at ${esc(betsFmtOdds(o))} wins ${esc(mlbToolsMoney(win))} and returns ${esc(mlbToolsMoney(stake + win))}. Exact, not an estimate.`);
}

// 2. No-vig fair price
function mlbToolsNoVig() {
  const mkt = MLBTOOLS.nvMkt === 't' ? 't' : 'ml';
  for (const [id, key] of [['#mlbtNvMl', 'ml'], ['#mlbtNvT', 't']]) $(id)?.setAttribute('aria-pressed', String(mkt === key));
  const a = mlbToolsOdds('#mlbtNvA');
  const b = mlbToolsOdds('#mlbtNvB');
  if (a == null || b == null) {
    mlbToolsSet('#mlbtNvOut', mlbToolsHint('Enter both sides, like −140 and +120.'));
    return;
  }
  const pa = oddsNoVig(mkt, a, b);
  if (pa == null) { mlbToolsSet('#mlbtNvOut', mlbToolsHint('Those two prices do not make a market. Check both sides.')); return; }
  const pb = 1 - pa;
  const hold = oddsImp(a) + oddsImp(b) - 1;
  mlbToolsSet('#mlbtNvOut', mlbToolsTile('Side A fair, est.', mlbToolsOddsTxt(oddsProbToAm(pa)), betsFmtPct(pa, 1))
    + mlbToolsTile('Side B fair, est.', mlbToolsOddsTxt(oddsProbToAm(pb)), betsFmtPct(pb, 1))
    + mlbToolsTile("Book's cut", `${(hold * 100).toFixed(1)}%`, hold < 0 ? 'both sides beatable' : 'of the two prices'));
}

// 3. Parlay
function mlbToolsParlay() {
  const raw = String($('#mlbtParLegs')?.value ?? '').replace(/[−–—]/g, '-');
  const parts = raw.split(/[\s,]+/).filter(Boolean);
  const legs = parts.map((p) => mlbToolsAm(Number(p.replace(/[^0-9.+-]/g, '')))).filter((o) => o != null);
  const stake = mlbToolsNum('#mlbtParStake');
  if (!legs.length) {
    mlbToolsSet('#mlbtParOut', mlbToolsHint('Enter two or more prices, like −110, −110, +150.'));
    mlbToolsSet('#mlbtParNote', '');
    return;
  }
  const d = legs.reduce((p, o) => p * oddsDec(o), 1);
  const pays = stake > 0 ? stake * (d - 1) : null;
  mlbToolsSet('#mlbtParOut', mlbToolsTile('Odds', mlbToolsOddsTxt(betsToAm(d)))
    + mlbToolsTile('Implied', betsFmtPct(1 / d, 1))
    + mlbToolsTile('Pays', pays == null ? '—' : mlbToolsMoney(pays)));
  const skipped = parts.length - legs.length;
  mlbToolsSet('#mlbtParNote', `${legs.length === 1 ? 'One leg read' : `${legs.length} legs read`}, decimal ${esc(d.toFixed(3))}.${skipped > 0 ? ` ${skipped} entr${skipped === 1 ? 'y was' : 'ies were'} not odds and ${skipped === 1 ? 'was' : 'were'} skipped.` : ''}${pays == null ? ' Add a stake to see the payout.' : ''}`);
}

// 4. Hedge — stake h on the other side so both outcomes land the same: pay − h = h·(dec − 1) − stake.
function mlbToolsHedge() {
  const pay = mlbToolsNum('#mlbtHedgePay');
  const stake = mlbToolsNum('#mlbtHedgeStake');
  const o = mlbToolsOdds('#mlbtHedgeOdds');
  if (!(pay > 0) || o == null) {
    mlbToolsSet('#mlbtHedgeOut', mlbToolsHint('Enter what the open bet wins and the price on the other side.'));
    mlbToolsSet('#mlbtHedgeNote', '');
    return;
  }
  const risk = stake > 0 ? stake : 0;
  const h = (pay + risk) / oddsDec(o);
  const lock = pay - h;
  mlbToolsSet('#mlbtHedgeOut', mlbToolsTile('Hedge stake', mlbToolsMoney(h))
    + mlbToolsTile('Locks in', betsFmtMoney(mlbToolsCents(lock), true))
    + mlbToolsTile('Instead of', `${mlbToolsMoney(pay)} or ${betsFmtMoney(-risk)}`, '', true));
  mlbToolsSet('#mlbtHedgeNote', `${esc(mlbToolsMoney(h))} at ${esc(betsFmtOdds(o))} leaves ${esc(betsFmtMoney(mlbToolsCents(lock), true))} whichever way the game goes, against ${esc(mlbToolsMoney(pay))} if the open bet wins or ${esc(betsFmtMoney(-risk))} if it loses.${lock < 0 ? ' Here that locks in a loss rather than a profit.' : ''}`);
}

// 5. Kelly — bets.js owns the setting and the editor; this only reports what is saved.
function mlbToolsKelly() {
  if (typeof betsKellyCfg !== 'function') { mlbToolsSet('#mlbtKellyOut', mlbToolsHint('Sizing settings live in Mine → Results.')); return; }
  const c = betsKellyCfg();
  const rows = [
    ['Bankroll', c.bankroll ? betsFmtMoney(c.bankroll) : 'Not set'],
    ['How much of Kelly', typeof betsKellyName === 'function' ? betsKellyName(c.frac) : `${Math.round(c.frac * 100)}%`],
    ['Most on one bet', c.bankroll ? `${c.capPct}% · ${betsFmtMoney(Math.round((c.capPct / 100) * c.bankroll))}` : `${c.capPct}% of bankroll`],
    ['Stakes rounded to', betsFmtMoney(c.round)],
  ];
  mlbToolsSet('#mlbtKellyOut', rows.map(([k, v]) => `<div><span>${esc(k)}</span><b class="num">${esc(v)}</b></div>`).join('')
    + `<p class="mlbt-kv-p">${c.bankroll ? 'With a bankroll saved, the bet slip can show a size in dollars next to a price (est.).' : 'With no bankroll saved, nothing is sized in dollars anywhere in the app. No default is invented for you.'}</p>`);
}

// 6. Your bets on this device
function mlbToolsBets() {
  const n = typeof BETS === 'object' && Array.isArray(BETS?.list) ? BETS.list.length : null;
  mlbToolsSet('#mlbtBetsP', `Your bet log is private. It lives on this device and nobody else sees it, not even your own phone, until you link the two.${n ? ` ${esc(typeof betsPlural === 'function' ? betsPlural(n, 'bet') : `${n} bets`)} in the log here.` : ''}`);
}

// 7. Where the numbers come from
function mlbToolsLoadHealth() {
  if (Date.now() - MLBTOOLS.healthAt < 60e3) return;
  MLBTOOLS.healthAt = Date.now();
  const get = typeof betsApi === 'function' ? betsApi('/api/health') : fetch('api/health').then((r) => (r.ok ? r.json() : Promise.reject(new Error('health'))));
  get.then((h) => { MLBTOOLS.health = h && typeof h === 'object' ? h : null; MLBTOOLS.healthErr = !MLBTOOLS.health; })
    .catch(() => { MLBTOOLS.health = null; MLBTOOLS.healthErr = true; })
    .then(() => { if (S.tab === 'tools') mlbToolsSources(); });
}
function mlbToolsSources() {
  const h = MLBTOOLS.health;
  const hosts = h?.odds?.hosts || null;
  const rows = MLBTOOLS_SRC.map(([name, key, what]) => {
    let state = 'wait';   // wait = nothing reported yet, never a guess
    let when = '';
    if (key === 'feed') {
      if (h) { state = h.ok ? 'ok' : 'bad'; when = Array.isArray(h.games) ? `${h.games.length} games today` : ''; }
    } else if (hosts) {
      const s = hosts[key];
      if (s?.lastErr) { state = 'bad'; when = s.lastOk ? `last ok ${ago(new Date(s.lastOk).toISOString())}` : 'no reply yet'; }
      else if (s?.lastOk) { state = 'ok'; when = ago(new Date(s.lastOk).toISOString()); }
      else if (s) { state = 'wait'; when = 'not called yet'; }
      else { state = 'wait'; when = 'not called yet'; }
    } else if (h) { when = 'status not reported'; }
    const tag = { ok: 'OK', bad: 'Error', wait: '…' }[state];
    return `<div class="mlbt-src"><span class="mlbt-tag ${state}">${esc(tag)}</span><div><div class="mlbt-src-n">${esc(name)}</div><div class="mlbt-src-w">${esc(what)}</div></div><div class="mlbt-src-t">${esc(when)}</div></div>`;
  }).join('');
  const foot = MLBTOOLS.healthErr
    ? '<p class="mlbt-note">The status check did not answer, so these say nothing rather than guess.</p>'
    : h && !h.odds
      ? '<p class="mlbt-note">This server does not report per-feed status, so only the live MLB feed shows one.</p>'
      : '<p class="mlbt-note">Status comes from the server\'s own health check, refreshed about once a minute.</p>';
  mlbToolsSet('#mlbtSrcOut', rows + foot);
}
