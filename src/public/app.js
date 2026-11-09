// Kairos workspace UI. Everything model- or vault-generated is escaped before rendering.
import { marketName, marketVenue } from './lib/markets.js';
import { loginMessage } from './lib/wallet.js';
const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// coin logos (assets/coin-*.webp); unknown tickers just show text
const COINS = new Set(['BTC', 'ETH', 'SOL', 'DOGE', 'SHIB', 'PEPE', 'BONK', 'WIF', 'FLOKI', 'TRUMP', 'PENGU', 'POPCAT', 'XRP', 'LTC', 'ADA', 'LINK']);
const coinBase = a => { const b = String(a || '').split('-')[0].toUpperCase(); return /^K[A-Z]{3,}$/.test(b) && COINS.has(b.slice(1)) ? b.slice(1) : b; };
const coin = (a, size = 18) => COINS.has(coinBase(a)) ? `<img class="coin" src="../assets/coin-${coinBase(a).toLowerCase()}.webp" alt="" width="${size}" height="${size}" loading="lazy">` : '';
// the market's real name, with its id small next to it ("Nasdaq 100  XYZ100-XYZ")
const withCoin = a => { const n = marketName(a); return `<span class="wc" title="${esc(a)} · ${esc(marketVenue(a))}">${coin(a)}${esc(n)}${n.toUpperCase() !== String(a).toUpperCase() ? `<small class="wc-id">${esc(a)}</small>` : ''}</span>`; };
const money = n => (n >= 0 ? '+' : '−') + '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fp = x => (typeof x === 'number' && Number.isFinite(x) ? (Math.abs(x) >= 1 ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : Number(x.toPrecision(4)).toString()) : (x ?? '–'));
/** Small samples show counts, not a misleading percentage. */
const MIN_RATE = 10;
const rateCell = (w, l) => (w + l >= MIN_RATE
  ? `<div class="n">${Math.round((w / (w + l)) * 100)}%</div><span class="sub">${w}W · ${l}L</span>`
  : `<div class="n">${w}W · ${l}L</div><span class="sub">${w + l ? `rate after ${MIN_RATE} trades` : 'no trades yet'}</span>`);
/** No losses means the profit factor is not computable yet: never "infinite". */
const pfCell = pf => (pf == null ? `<div class="n">—</div><span class="sub">needs a losing trade</span>` : `<div class="n">${pf}</div>`);
const cls = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const ago = iso => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const agoText = iso => { const a = ago(iso); return a === 'now' ? 'just now' : a + ' ago'; };

let settings = null, current = 'overview', selected = null;
const imgCache = new Map();
async function imageUrl(path) {
  if (!imgCache.has(path)) imgCache.set(path, api('/image?path=' + encodeURIComponent(path)).then(r => r.dataUrl));
  return imgCache.get(path);
}
/** Downscale to 1600px and re-encode, so screenshots stay light in the vault. */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const webp = c.toDataURL('image/webp', 0.86);
    return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.86);
  } finally { URL.revokeObjectURL(url); }
}

async function api(path, opts = {}) {
  if (window.__kairosApi) { // web version: the engine runs in this tab
    const r = await window.__kairosApi(opts.method || 'GET', '/api' + path, opts.body ? JSON.parse(JSON.stringify(opts.body)) : {});
    if (r.status >= 400) { const e = new Error(r.body.error || 'Request failed'); e.code = r.body.code; e.status = r.status; throw e; }
    return JSON.parse(JSON.stringify(r.body));
  }
  const r = await fetch('/api' + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Kairos': '1', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({ error: 'Bad response' }));
  if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.code = j.code; e.status = r.status; throw e; }
  return j;
}

function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = 'toast'), err ? 6000 : 2600);
}
function fail(e) {
  toast(e.message, true);
  if (e.code === 'NEED_KEY') setTimeout(() => go('team'), 600);
  if (e.code === 'NEED_WALLET' || e.code === 'NEED_TOKENS') setTimeout(openWallet, 400);
}

/* ---------- KAIROS holder gate: guests look, holders use ---------- */
let gate = { on: false, access: true };
const short = a => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
async function refreshGate() {
  try { gate = await api('/auth'); } catch { gate = { on: false, access: true }; }
  const btn = $('#walletBtn'), bar = $('#gateBar');
  btn.hidden = !gate.on; bar.hidden = !gate.on || gate.access;
  if (!gate.on) return;
  btn.innerHTML = gate.address ? `<span class="dot ${gate.access ? 'ok' : ''}"></span>${esc(short(gate.address))}<small>$${esc(gate.usd)} ${esc(gate.symbol)}</small>` : 'Connect wallet';
  bar.innerHTML = gate.address
    ? `<div class="banner gate"><span><b>Your wallet holds $${esc(gate.usd)} of ${esc(gate.symbol)}.</b> Kairos needs at least $${esc(gate.minUsd)} to use its features; you can keep browsing as a guest.</span>${gate.buyUrl ? `<a class="btn sm dark" href="${esc(gate.buyUrl)}" target="_blank" rel="noopener noreferrer">Buy ${esc(gate.symbol)}</a>` : ''}</div>`
    : `<div class="banner gate"><span><b>Guest mode.</b> Look around freely. To log trades, ask the team, run strategies or set alerts, connect a wallet holding at least $${esc(gate.minUsd)} of ${esc(gate.symbol)}.</span><button class="btn sm dark" id="gateConnect">Connect wallet</button></div>`;
  const c = $('#gateConnect'); if (c) c.onclick = openWallet;
}
function openWallet() {
  $('#dlgTitle').textContent = gate.address ? 'Your wallet' : 'Connect your wallet';
  const eth = window.ethereum;
  $('#dlgBody').innerHTML = gate.address
    ? `<p>Signed in as <b class="mono">${esc(gate.address)}</b>.</p><p>It holds <b>${esc(gate.balance)} ${esc(gate.symbol)}</b>, about <b>$${esc(gate.usd)}</b>. Kairos needs at least $${esc(gate.minUsd)}.</p><div class="row" style="margin-top:14px"><button class="btn" id="wRefresh">Check again</button>${gate.buyUrl ? `<a class="btn dark" href="${esc(gate.buyUrl)}" target="_blank" rel="noopener noreferrer">Buy ${esc(gate.symbol)}</a>` : ''}<button class="btn" id="wOut">Sign out</button></div>`
    : eth
      ? `<p>Kairos checks that your wallet holds at least <b>$${esc(gate.minUsd)} of ${esc(gate.symbol)}</b> on Elysium.</p><p>You'll sign a message to prove the wallet is yours. <b>It costs nothing, needs no gas and moves no funds.</b></p><div class="row" style="margin-top:14px"><button class="btn dark" id="wGo">Connect and sign</button></div>`
      : `<p>No wallet found in this window.</p><p>Install a browser wallet such as MetaMask or Rabby. In the desktop app, open <b class="mono">${esc(location.origin)}/app</b> in a browser that has your wallet and sign in there: Kairos remembers it here too.</p>`;
  $('#dlg').showModal();
  const go = $('#wGo'); if (go) go.onclick = () => busy(go, async () => {
    const [address] = await eth.request({ method: 'eth_requestAccounts' });
    const { nonce, issuedAt } = await api('/auth/nonce', { method: 'POST' });
    const msg = loginMessage(address, nonce, issuedAt);
    const hex = '0x' + [...new TextEncoder().encode(msg)].map(b => b.toString(16).padStart(2, '0')).join('');
    const signature = await eth.request({ method: 'personal_sign', params: [hex, address] });
    const st = await api('/auth/verify', { method: 'POST', body: { address, nonce, issuedAt, signature } });
    $('#dlg').close(); await refreshGate(); toast(st.access ? 'Wallet connected' : `Connected, but it holds $${st.usd} of ${st.symbol}`, !st.access); render();
  });
  const rf = $('#wRefresh'); if (rf) rf.onclick = () => busy(rf, async () => { await api('/auth/verify-refresh').catch(() => null); await refreshGate(); openWallet(); });
  const out = $('#wOut'); if (out) out.onclick = () => busy(out, async () => { await api('/auth/logout', { method: 'POST' }); $('#dlg').close(); await refreshGate(); render(); });
}
$('#walletBtn').onclick = openWallet;
async function busy(btn, fn) {
  const label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + esc(btn.dataset.busy || 'Working');
  try { return await fn(); } catch (e) { fail(e); } finally { btn.disabled = false; btn.innerHTML = label; }
}

/** Tiny Markdown: headings, bold, lists, [[links]], paragraphs. Input is escaped first. */
function md(text) {
  const lines = esc(text).split('\n'); let out = '', list = false;
  for (const raw of lines) {
    let l = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[\[([^\]]+)\]\]/g, '<span class="lnk">[[$1]]</span>').replace(/`([^`]+)`/g, '<code class="mono">$1</code>');
    const li = l.match(/^\s*[-*]\s+(.*)/);
    if (li) { if (!list) { out += '<ul>'; list = true; } out += `<li>${li[1]}</li>`; continue; }
    if (list) { out += '</ul>'; list = false; }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) out += `<h${Math.min(h[1].length + 2, 4)}>${h[2]}</h${Math.min(h[1].length + 2, 4)}>`;
    else if (l.trim()) out += `<p>${l}</p>`;
  }
  return out + (list ? '</ul>' : '');
}

async function openNote(path) {
  try {
    const n = await api('/note?path=' + encodeURIComponent(path));
    $('#dlgTitle').textContent = path;
    $('#dlgBody').innerHTML = `${n.data.image ? '<img class="dlg-shot" alt="Trade screenshot">' : ''}<dl class="fm">${Object.entries(n.data).filter(([k]) => k !== 'image').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(Array.isArray(v) ? v.join(', ') : v)}</dd>`).join('')}</dl>${md(n.body.replace(/!\[\[[^\]]+\]\]\n*/g, ''))}`;
    if (n.data.image) imageUrl(String(n.data.image)).then(u => { const im = $('#dlgBody .dlg-shot'); if (im) im.src = u; }).catch(() => $('#dlgBody .dlg-shot')?.remove());
    $('#dlg').showModal();
  } catch (e) { fail(e); }
}
$('#dlgClose').onclick = () => $('#dlg').close();

/* ---------- header ---------- */
function renderHeader() {
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === settings.mode));
  const k = $('#keyPill');
  if (settings.hasApiKey) { k.className = 'keypill ok'; k.textContent = 'AI key ' + settings.apiKeyHint; }
  else if (settings.freeAvailable) { const left = Math.max(settings.freeLimit - settings.freeUsed, 0); k.className = 'keypill' + (left ? '' : ' warn'); k.textContent = `${left}/${settings.freeLimit} free left`; }
  else { k.className = 'keypill warn'; k.textContent = 'Connect AI'; }
}
$('#keyPill').onclick = () => go('team');
$('#themeBtn').onclick = () => { const dark = document.documentElement.dataset.theme !== 'dark'; if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme; try { localStorage.setItem('kairos-theme', dark ? 'dark' : 'light'); } catch { /* private mode */ } };
$('#modeSeg').onclick = async e => {
  const m = e.target.closest('button')?.dataset.mode; if (!m || m === settings.mode) return;
  try { settings = await api('/settings', { method: 'PUT', body: { mode: m } }); renderHeader(); toast(m === 'team' ? 'Team mode: models split roles and review each other' : 'Solo mode: one model does everything'); if (current === 'team') render(); }
  catch (er) { fail(er); }
};
$('#tabs').onclick = e => { const v = e.target.closest('button')?.dataset.v; if (v) go(v); };
function go(v) { current = v; location.hash = v; render(true); }

/* ---------- views ---------- */
const views = {
  /** Notice shown while the example trades are in the journal. */
  examplesBanner(n, own = 0) {
    return n ? `<div class="banner info ex-banner"><span>${own ? `<b>Your numbers.</b> The stats count your ${own} trade${own > 1 ? 's' : ''} only; the ${n} example trades stay in the list below until you remove them.` : `<b>${n} example trades:</b> the paper tracks of Dip buyer and Trend rider (crypto, the last two years) and Pullback (Nasdaq 100 and gold on Hyperliquid, since they listed), $5,000 each, their rules on real daily prices and updated every day. Once you log a trade, the stats count yours only.`}</span><button class="btn sm" id="rmExamples">Remove examples</button></div>` : '';
  },

  async overview() {
    const s = await api('/status'); const j = s.journal;
    const free = !settings.hasApiKey;
    view.innerHTML = `
      <div class="head"><div><h1>Overview</h1><p>${settings.web ? `Vault: ${esc(settings.vaultLabel)}.` : `Vault: <span class="mono">${esc(s.vault)}</span> · open it in Obsidian as a vault.`}</p></div>
        <div class="row"><button class="btn" data-go="journal">Log a trade</button><button class="btn dark" data-go="ask">Ask the ${settings.mode === 'team' ? 'team' : 'model'}</button></div></div>
      ${settings.web ? `<div class="banner info">Web version: running strategies trade on paper while this tab is open. For 24/7 paper trading and real money on Kraken, use the <a href="../tour#get">desktop app</a>.</div>` : ''}
      ${free ? `<div class="banner ${settings.freeAvailable ? 'info' : ''}">${settings.freeAvailable ? `You have <b>${Math.max(settings.freeLimit - settings.freeUsed, 0)} of ${settings.freeLimit}</b> free instructions (Ask or Analyse). After that, and for paper trading, add your own AI key in <a href="#team">Team</a>.` : `Connect your AI key in <a href="#team">Team</a> to use the models. Journaling works without it.`}</div>` : ''}
      ${views.examplesBanner(s.examples, s.statsFrom === 'own' ? s.journalCount : 0)}
      <div class="grid g4">
        <div class="card stat"><span class="eyebrow">Journal trades</span><div class="n">${s.journalCount}</div></div>
        <div class="card stat"><span class="eyebrow">Win rate</span>${rateCell(j.wins, j.losses)}</div>
        <div class="card stat"><span class="eyebrow">Profit factor</span>${pfCell(j.profitFactor)}</div>
        <div class="card stat"><span class="eyebrow">Journal PnL</span><div class="n ${cls(j.totalPnl)}">${money(j.totalPnl)}</div></div>
      </div>
      <div class="grid g2" style="margin-top:16px">
        <div class="card"><div class="head" style="margin-bottom:8px"><h2>Paper strategies</h2><button class="btn sm" data-go="strategies">Open</button></div>
          ${s.strategies.length ? `<table><tr><th>Strategy</th><th>Status</th><th>Trades</th><th>PnL</th><th>Marks</th></tr>${s.strategies.map(x => `<tr class="click" data-strat="${esc(x.name)}"><td>${esc(x.name)}</td><td>${chip(x)}</td><td class="num">${x.trades}${x.open ? ` (+${x.open} open)` : ''}</td><td class="num ${cls(x.pnl)}">${money(x.pnl)}</td><td>${x.eligible ? '<span class="chip ok">beaten</span>' : '<span class="chip">not yet</span>'}</td></tr>`).join('')}</table>` : '<p class="empty">No strategies yet.</p>'}
        </div>
        <div class="card"><div class="head" style="margin-bottom:8px"><h2>Latest trades</h2><button class="btn sm" data-go="journal">Journal</button></div>
          ${s.recent.length ? `<div class="lt">${s.recent.map(t => `<div class="lt-row click" data-note="${esc(t.path)}"><span class="lt-a">${withCoin(t.asset)} <span class="sub">${esc(t.side)} · ${esc(String(t.date).slice(0, 10))}</span></span><span class="num ${cls(t.pnl)}">${money(t.pnl)}${t.r != null ? ` · ${t.r > 0 ? '+' : ''}${t.r}R` : ''}</span></div>`).join('')}</div>` : '<p class="empty">No trades yet. Log your first one in the Journal.</p>'}</div>
      </div>
      <div class="grid g2" style="margin-top:16px">
        <div class="card"><div class="head" style="margin-bottom:6px"><h2>Road to real money</h2><button class="btn sm" data-go="rules">Marks</button></div>
          <p class="sub" style="margin-bottom:14px">A strategy only asks for real money when every mark is beaten on paper. No shortcuts.</p>
          ${s.strategies.map(x => { const n = (x.checks || []).filter(c => c.pass).length, tot = (x.checks || []).length || 6; return `<div class="road click" data-strat="${esc(x.name)}">
            <div class="road-h"><b>${esc(x.name)}</b><span class="mono">${n}/${tot} marks</span></div>
            <div class="road-bar"><i style="width:${Math.round(n / tot * 100)}%"></i></div>
            <div class="road-c">${(x.checks || []).map(c => `<span class="${c.pass ? 'ok' : ''}">${c.pass ? '✓' : '·'} ${esc(c.label.replace(/ [≥≤>].*/, ''))}</span>`).join('')}</div>
            ${x.lesson ? `<p class="sub road-l">Latest lesson: ${esc(x.lesson.lines[0] || x.lesson.title)}</p>` : ''}</div>`; }).join('')}
        </div>
        <div class="card"><div class="head" style="margin-bottom:8px"><h2>Argus · latest</h2><button class="btn sm" data-go="news">Argus</button></div>
          ${s.headlines.length ? `<div class="heads">${s.headlines.map(h => `<a ${h.url ? `href="${esc(h.url)}" target="_blank" rel="noopener noreferrer"` : ''}><span class="mono sub">${ago(new Date(h.time).toISOString())}</span><span>${esc(h.title.slice(0, 140))}</span><span class="hc">${h.coins.slice(0, 2).map(c => coin(c)).join('')}</span></a>`).join('')}</div>` : '<p class="empty">Argus is warming up. Headlines about your coins land here within a minute.</p>'}
        </div>
      </div>
      <div class="grid g2" style="margin-top:16px">
        <div class="card"><h2 style="margin-bottom:12px">By coin</h2>
          ${s.byAsset.length ? `<table><tr><th>Coin</th><th>Trades</th><th>Win rate</th><th>PnL</th></tr>${s.byAsset.map(a => `<tr><td>${withCoin(a.asset)}</td><td class="num">${a.n}</td><td class="num">${a.n >= 10 ? Math.round(a.wins / a.n * 100) + '%' : `${a.wins}W · ${a.n - a.wins}L`}</td><td class="num ${cls(a.pnl)}">${money(a.pnl)}</td></tr>`).join('')}</table>` : '<p class="empty">Log a trade to see this.</p>'}
        </div>
        <div class="card"><h2 style="margin-bottom:12px">How trades ended</h2>
          ${Object.keys(s.exits).length ? (() => { const tot = Object.values(s.exits).reduce((x, y) => x + y, 0); return `<div class="bars">${Object.entries(s.exits).sort((x, y) => y[1] - x[1]).map(([k, v]) => `<div><span>${esc(k)}</span><i><b class="${/take|win/.test(k) ? 'g' : /^stop|loss|drawdown/.test(k) ? 'r' : ''}" style="width:${Math.round(v / tot * 100)}%"></b></i><span class="mono">${v}</span></div>`).join('')}</div>`; })() : '<p class="empty">Nothing closed yet.</p>'}
          <p class="sub" style="margin-top:14px">A healthy strategy loses small and often, and wins big sometimes. Lots of stops is normal; stops bigger than 1R are not.</p>
        </div>
      </div>
      ${s.activity.length ? `<div class="card" style="margin-top:16px">        <h2 style="margin-bottom:8px">Activity</h2><div class="feed">${s.activity.length ? s.activity.map(a => `<div><time>${ago(a.at)}</time><span>${md(a.msg).replace(/<\/?p>/g, '')}</span></div>`).join('') : '<p class="empty">Nothing yet this session. Full history is in the vault\'s Log folder.</p>'}</div></div>` : ''}`;
  },

  async journal() {
    const [listed, track] = await Promise.all([api('/journal'), api('/track').catch(() => null)]), own = listed.filter(t => !t.tags.includes('example'));
    const trades = own.length ? own : listed; // stats, curve and calendar: your trades once you have any
    const filt = views.journal.filter || 'all';
    const sum = (a, f) => a.reduce((x, t) => x + f(t), 0);
    const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
    const gp = sum(wins, t => t.pnl), gl = -sum(losses, t => t.pnl), rs = trades.map(t => t.r).filter(r => typeof r === 'number');
    const pf = gl > 0 ? +(gp / gl).toFixed(2) : null;
    // cumulative PnL curve
    let acc = 0; const pts = [0, ...trades.map(t => (acc += t.pnl))];
    const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1, W = 560, H = 120;
    const xy = pts.map((v, k) => [pts.length > 1 ? (k / (pts.length - 1)) * W : 0, H - 8 - ((v - lo) / span) * (H - 16)]);
    const line = xy.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
    const zeroY = H - 8 - ((0 - lo) / span) * (H - 16);
    const shown = listed.slice().reverse().filter(t => filt === 'all' || (filt === 'wins' ? t.pnl > 0 : filt === 'losses' ? t.pnl < 0 : !!t.image));
    view.innerHTML = `
      <div class="head"><div><h1>Journal</h1><p>Every trade is a note in <span class="mono">Trades/</span> with its screenshot in <span class="mono">Attachments/</span>. Obsidian shows both; Analyse lets the models look at your charts.</p></div>
        <div class="row">${trades.length ? '<button class="btn" id="sharePnl">Share PnL ↗</button>' : ''}<button class="btn dark" id="newTrade">${trades.length ? 'Log a trade' : 'Log your first trade'}</button></div></div>
      ${views.examplesBanner(listed.length - own.length, own.length)}
      ${(track || []).map(tr => `<div class="banner track-line"><span class="dot ${tr.outcome === 'hold' ? '' : 'on'}"></span><span><b>${esc(tr.name)} paper track</b> · checked every daily close, last on ${esc(new Date(tr.lastDay + 'T00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }))}: ${esc(tr.why)}${tr.holding.length ? ` Holding ${esc(tr.holding.map(a => marketName(a)).join(', '))}.` : ''} <span class="lnk" role="link" tabindex="0" data-strat="${esc(tr.name)}">See every day →</span></span></div>`).join('')}
      <div class="jstats">
        <div class="jcurve card"><div class="row" style="justify-content:space-between"><span class="eyebrow">Cumulative PnL</span><span class="num ${cls(acc)}">${money(acc)}</span></div>
          ${trades.length > 1 ? `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><defs><linearGradient id="jg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${acc >= 0 ? '#0055ff' : '#ef4423'}" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
            <line x1="0" x2="${W}" y1="${zeroY}" y2="${zeroY}" stroke="#d3d6de" stroke-dasharray="3 4"/><path d="${line} L${W} ${H} L0 ${H}Z" fill="url(#jg)"/><path d="${line}" fill="none" stroke="${acc >= 0 ? '#0055ff' : '#ef4423'}" stroke-width="2.2" vector-effect="non-scaling-stroke"/></svg>`
            : '<p class="empty">The curve appears after two trades.</p>'}</div>
        <div class="jnums">
          <div class="card stat"><span class="eyebrow">Trades</span><div class="n">${trades.length}</div></div>
          <div class="card stat"><span class="eyebrow">Win rate</span>${rateCell(wins.length, losses.length)}</div>
          <div class="card stat"><span class="eyebrow">Profit factor</span>${pfCell(pf)}</div>
          <div class="card stat"><span class="eyebrow">Avg R</span><div class="n ${cls(rs.length ? sum(rs, r => r) : 0)}">${rs.length ? (sum(rs, r => r) / rs.length).toFixed(2) : '–'}</div></div>
        </div>
      </div>
      ${trades.length ? pnlCalendar(trades, views.journal.month, (track || []).map(tr => `${tr.name}: ${tr.why}`)) : ''}
      <form class="card soft jform" id="tradeForm" ${trades.length ? 'hidden' : ''}>
        <label class="drop" id="drop" tabindex="0"><input type="file" accept="image/*" id="shot" hidden>
          <div class="drop-empty"><b>Chart screenshot</b><span>Paste (Ctrl/⌘ V), drop an image here, or click to choose</span></div>
          <img id="shotPrev" alt="" hidden><button type="button" class="x" id="shotClear" hidden aria-label="Remove screenshot">×</button></label>
        <div class="form">
          <label>Date<input name="date" type="datetime-local" required></label>
          <label>Asset<input name="asset" placeholder="BTC-USD" required></label>
          <label>Side<select name="side"><option>long</option><option>short</option></select></label>
          <label>Strategy<input name="strategy" placeholder="Range breakout"></label>
          <label>Entry<input name="entry" type="number" step="any" required></label>
          <label>Stop<input name="stop" type="number" step="any"></label>
          <label>Exit<input name="exit" type="number" step="any"></label>
          <label>Size (units)<input name="size" type="number" step="any"></label>
          <label>PnL (USD, optional)<input name="pnl" type="number" step="any" placeholder="computed from size"></label>
          <label>Emotion<input name="emotion" placeholder="calm · confidence 7/10"></label>
          <label class="w2">Tags<input name="tags" placeholder="breakout, followed-plan"></label>
          <label class="w2">Thesis<textarea name="thesis"></textarea></label>
          <label class="w2">Psychology<textarea name="psychology"></textarea></label>
          <label class="w2">Went well<textarea name="wentWell" placeholder="- "></textarea></label>
          <label class="w2">Went wrong<textarea name="wentWrong" placeholder="- "></textarea></label>
          <div class="w4 row"><button class="btn dark" data-busy="Saving">Save trade note</button><button type="button" class="btn" id="cancelTrade">Cancel</button><span class="sub">R is computed from entry, stop and exit.</span></div>
        </div>
      </form>
      ${trades.length ? `<div class="row jfilter" id="jfilter">${[['all', 'All'], ['wins', `Wins · ${listed.filter(t => t.pnl > 0).length}`], ['losses', `Losses · ${listed.filter(t => t.pnl < 0).length}`], ['shots', 'With screenshot']].map(([k, l]) => `<button class="chipbtn ${filt === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>` : ''}
      <div class="jgrid ${views.journal.more ? 'open' : ''}">${shown.slice(0, views.journal.more ? shown.length : 12).map(t => `
        <article class="jcard ${t.pnl > 0 ? 'win' : t.pnl < 0 ? 'loss' : ''}" data-note="${esc(t.path)}">
          <div class="jthumb" ${t.image ? `data-img="${esc(t.image)}"` : ''}>${t.image ? '' : `<span class="jph">${coin(t.asset, 56) || esc(t.asset.split('-')[0] || '—')}</span>`}
            <span class="jside ${t.side}">${esc(t.side)}</span></div>
          <div class="jbody">
            <div class="row" style="justify-content:space-between"><b>${withCoin(t.asset)}</b><span class="num ${cls(t.pnl)}">${money(t.pnl)}${t.r != null ? ` · ${t.r > 0 ? '+' : ''}${t.r}R` : ''}</span></div>
            <p class="sub">${esc(t.date)}${t.strategy ? ` · ${esc(t.strategy)}` : ''}</p>
            ${t.thesis ? (views.journal.more ? `<div class="jthesis full">${md(t.thesis)}</div>` : `<p class="jthesis">${esc(t.thesis.slice(0, 120))}${t.thesis.length > 120 ? '…' : ''}</p>`) : ''}
            <div class="row" style="gap:6px">${t.emotion ? `<span class="chip">${esc(t.emotion.slice(0, 28))}</span>` : ''}${t.tags.slice(0, 3).map(x => `<span class="chip">#${esc(x)}</span>`).join('')}</div>
          </div>
        </article>`).join('') || (trades.length ? '<p class="empty">No trades match this filter.</p>' : '')}</div>
      ${shown.length > 12 ? `<div class="jmore"><button class="btn" id="jMore">${views.journal.more ? 'Show less' : `See all ${shown.length} trades with their full thesis`}</button></div>` : ''}`;

    // thumbnails load after the grid is on screen
    view.querySelectorAll('.jthumb[data-img]').forEach(async el => { try { el.style.backgroundImage = `url("${await imageUrl(el.dataset.img)}")`; el.classList.add('has'); } catch { /* moved or deleted */ } });
    const f = $('#tradeForm');
    f.date.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('#newTrade').onclick = () => { f.hidden = false; f.scrollIntoView({ behavior: 'smooth', block: 'start' }); f.asset.focus(); };
    $('#cancelTrade').onclick = () => { f.hidden = true; };
    view.querySelectorAll('[data-month]').forEach(b => (b.onclick = () => { views.journal.month = b.dataset.month; render(); }));
    if ($('#sharePnl')) $('#sharePnl').onclick = () => openShare(trades, views.journal.month || new Date().toISOString().slice(0, 7)); // the month on screen
    if ($('#jMore')) $('#jMore').onclick = () => { const was = views.journal.more; views.journal.more = !was; render(); if (was) $('#jfilter')?.scrollIntoView({ block: 'start' }); };
    if ($('#jfilter')) $('#jfilter').onclick = e => { const b = e.target.closest('[data-f]'); if (b) { views.journal.filter = b.dataset.f; render(); } };
    // screenshot: click, drop or paste; compressed in the browser before upload
    let shot = null;
    const setShot = async file => {
      if (!file || !file.type.startsWith('image/')) return toast('That is not an image', true);
      try { shot = await compressImage(file); $('#shotPrev').src = shot; $('#shotPrev').hidden = false; $('#shotClear').hidden = false; $('#drop').classList.add('filled'); }
      catch { toast('Could not read that image', true); }
    };
    const drop = $('#drop');
    drop.onclick = e => { if (e.target.id !== 'shotClear') $('#shot').click(); };
    $('#shot').onchange = e => setShot(e.target.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); setShot(e.dataTransfer.files[0]); };
    $('#shotClear').onclick = e => { e.preventDefault(); e.stopPropagation(); shot = null; $('#shotPrev').hidden = true; $('#shotClear').hidden = true; drop.classList.remove('filled'); $('#shot').value = ''; };
    f.onpaste = e => { const item = [...(e.clipboardData?.items || [])].find(x => x.type.startsWith('image/')); if (item) { e.preventDefault(); setShot(item.getAsFile()); } };
    document.onpaste = e => { if (current === 'journal' && !f.hidden && !e.target.closest('#tradeForm')) f.onpaste(e); };
    f.onsubmit = e => { e.preventDefault(); busy(f.querySelector('button.dark'), async () => {
      const body = Object.fromEntries(new FormData(f)); body.asset = body.asset.toUpperCase();
      if (shot) body.image = shot;
      const r = await api('/journal', { method: 'POST', body }); toast('Saved ' + r.path); render();
    }); };
  },

  async ask() {
    const team = settings.mode === 'team', M = settings.catalog.models;
    const who = team ? `Lead: ${M[settings.roles.lead].label}${settings.enabledRoles.reviewer ? ` · checked by ${M[settings.roles.reviewer].label}` : ''}` : `Solo: ${M[settings.soloModel].label}`;
    const chats = await api('/chats');
    const st = views.ask ||= {};
    if (st.chat && !chats.some(c => c.path === st.chat)) st.chat = null;
    const cur = st.chat ? await api('/chat?path=' + encodeURIComponent(st.chat)) : { title: '', messages: [] };
    const SUGGEST = ['Where do I lose the most money?', 'What do my losing trades have in common?', 'Which coin should I stop trading?', 'Write anti-tilt rules from my journal', 'Am I moving my stops?', 'What is my best setup?'];
    const msg = m => m.role === 'user' ? `<div class="msg you"><div class="bub">${esc(m.text)}</div></div>`
      : `<div class="msg ai"><span class="eyebrow who">${esc(m.model || 'Kairos')}</span><div class="md">${md(m.text)}</div>${m.steps ? `<div class="steps">${m.steps.map(x => `<details><summary>${esc(x.role)} · ${esc(x.model)}</summary><pre>${esc(x.text)}</pre></details>`).join('')}</div>` : ''}</div>`;
    view.innerHTML = `
      <div class="chat-wrap">
        <aside class="chat-side">
          <button class="btn dark new-chat" id="newChat">+ New chat</button>
          <span class="eyebrow side-l">Your chats</span>
          <div class="chat-list">${chats.length ? chats.map(c => `<div class="ci ${c.path === st.chat ? 'on' : ''}" data-chat="${esc(c.path)}"><b>${esc(c.title)}</b><span class="eyebrow">${c.updated ? agoText(c.updated) : ''} · ${c.messages / 2 | 0} ${c.messages / 2 === 1 ? 'question' : 'questions'}</span><button class="x" data-del="${esc(c.path)}" aria-label="Delete chat">×</button></div>`).join('') : '<p class="sub empty-s">Your conversations are saved here, and in <span class="mono">Chats/</span> in your vault.</p>'}</div>
        </aside>
        <section class="chat-main">
          <div class="chat-head"><div><span class="eyebrow">${esc(who)}</span><h1>${cur.messages.length ? esc(cur.title) : 'Ask Kairos'}</h1></div>
            <button class="btn" id="anBtn" data-busy="Analysing">Analyse my whole journal</button></div>
          <div class="thread" id="thread">${cur.messages.length ? cur.messages.map(msg).join('') : `
            <div class="hello"><h2>What do you want to know<br>about your trading?</h2><p class="sub">Answers come from your journal. ${team ? 'A second model checks every answer before you see it.' : 'Switch to Team at the top for a second opinion on every answer.'}</p>
            <div class="sugg">${SUGGEST.map(q => `<button class="chipbtn" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div></div>`}</div>
          <div class="composer"><textarea id="q" rows="1" placeholder="${cur.messages.length ? 'Ask a follow-up…' : 'Ask anything about your trades…'}"></textarea><button class="btn dark send" id="askBtn" data-busy="Thinking">Ask ↗</button></div>
          <p class="sub hint-s">Enter to send · Shift + Enter for a new line · Analyse writes an insight note and a draft strategy into your vault.</p>
        </section>
      </div>`;
    const q = $('#q'), thread = $('#thread');
    const grow = () => { q.style.height = 'auto'; q.style.height = Math.min(220, q.scrollHeight) + 'px'; }; q.oninput = grow;
    thread.scrollTop = thread.scrollHeight;
    const send = async text => {
      text = (text ?? q.value).trim(); if (!text) return toast('Write a question first', true);
      if (!cur.messages.length) thread.innerHTML = '';
      thread.insertAdjacentHTML('beforeend', msg({ role: 'user', text }) + '<div class="msg ai pending"><span class="eyebrow who">Thinking</span><div class="dots"><i></i><i></i><i></i></div></div>');
      q.value = ''; grow(); thread.scrollTop = thread.scrollHeight;
      await busy($('#askBtn'), async () => {
        try { const r = await api('/ask', { method: 'POST', body: { question: text, chat: st.chat } }); st.chat = r.chat; await refreshSettings(); render(); }
        catch (e) { thread.querySelector('.pending')?.remove(); throw e; }
      });
    };
    $('#askBtn').onclick = () => send();
    q.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    view.querySelectorAll('[data-q]').forEach(b => (b.onclick = () => send(b.dataset.q)));
    $('#newChat').onclick = () => { st.chat = null; render(); };
    view.querySelectorAll('[data-chat]').forEach(el => (el.onclick = e => { if (e.target.closest('[data-del]')) return; st.chat = el.dataset.chat; render(); }));
    view.querySelectorAll('[data-del]').forEach(b => (b.onclick = async () => { if (!confirm('Delete this chat? The note in Chats/ is removed too.')) return; await api('/chat?path=' + encodeURIComponent(b.dataset.del), { method: 'DELETE' }); if (st.chat === b.dataset.del) st.chat = null; render(); }));
    $('#anBtn').onclick = e => busy(e.currentTarget, async () => { const r = await api('/analyse', { method: 'POST' });
      thread.insertAdjacentHTML('beforeend', `<div class="msg ai"><span class="eyebrow who">Journal analysis</span><div class="md">${md(`Saved to **${r.insight}**.${r.strategy ? ` A draft strategy is in **${r.strategy}**: review it before starting it on paper.` : ''}`)}</div><div class="row" style="margin-top:10px"><button class="btn sm" data-note="${esc(r.insight)}">Open insight note</button>${r.strategy ? `<button class="btn sm" data-note="${esc(r.strategy)}">Open draft strategy</button>` : ''}</div></div>`);
      thread.scrollTop = thread.scrollHeight; await refreshSettings(); });
  },

  async strategies() {
    const list = await api('/strategies');
    if (!selected || !list.some(s => s.name === selected)) selected = list[0]?.name || null;
    view.innerHTML = `
      <div class="head"><div><h1>Strategies</h1><p>Each strategy is a note in <span class="mono">Strategies/</span>. Running ones are decided by the ${settings.mode === 'team' ? 'team' : 'solo model'} on their interval; Brake checks every order and closes stops every minute.</p></div></div>
      <div class="split"><div><div class="list" id="slist">${list.map(s => `<button data-s="${esc(s.name)}" class="${s.name === selected ? 'on' : ''}"><span>${esc(s.name)}</span>${chip(s)}</button>`).join('')}</div>
        <details class="card soft" style="margin-top:14px"><summary style="cursor:pointer;font-weight:600">New strategy</summary>
          <form id="newS" class="grid" style="margin-top:12px"><label>Name<input name="name" required></label><label>Assets<input name="assets" value="BTC-USD, ETH-USD"></label>
          <label>Hours (UTC)<input name="hours_utc" value="00:00-23:59"></label><label>Risk per trade %<input name="risk_per_trade_pct" type="number" step="0.1" value="1"></label>
          <label>Decide every (min)<input name="interval_min" type="number" value="60"></label><label>Rules<textarea name="rules" placeholder="- Enter on ...&#10;- Stop at ..."></textarea></label>
          <button class="btn dark">Create</button></form></details></div>
        <div id="sdetail">${selected ? '<p class="empty"><span class="spin"></span></p>' : '<p class="empty">No strategies. Create one, or run Analyse on the Ask tab.</p>'}</div></div>`;
    $('#slist').onclick = e => { const b = e.target.closest('button'); if (b) { selected = b.dataset.s; render(); } };
    $('#newS').onsubmit = async e => { e.preventDefault(); try { const b = Object.fromEntries(new FormData(e.target)); await api('/strategies', { method: 'POST', body: b }); selected = b.name.trim(); toast('Strategy note created'); render(); } catch (er) { fail(er); } };
    if (selected) await renderStrategy(selected);
  },

  async news() {
    const [d, ns] = await Promise.all([api('/news'), api('/news/settings')]);
    const watch = new Set(d.watch.map(a => a.split('-')[0]));
    const onlyWatched = views.news.only !== false;
    const items = d.items.filter(i => !onlyWatched || i.coins.some(c => watch.has(c)));
    const agoS = t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
    const hookUrl = `${location.origin}/api/news/webhook`;
    const web = settings.web;
    view.innerHTML = `
      <div class="head"><div><h1>Argus</h1><p>The watcher with a hundred eyes: news and price shocks, checked every 30 seconds. A shock (a fast move on heavy volume) makes running strategies decide right away, and Brake blocks new entries on that coin for ${esc(d.guardMin || 15)} minutes so the agents don't chase it.</p></div>
        <button class="btn" id="notify">${typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'Notifications on' : 'Turn on notifications'}</button></div>
      <div class="grid g2">
        <div class="card"><h3>Shocks</h3>${d.shocks.length ? `<div class="shocks">${d.shocks.slice(0, 8).map(s => `<div class="shock ${s.dir}"><b class="mono">${withCoin(s.asset)}</b><span class="num ${s.movePct > 0 ? 'pos' : 'neg'}">${s.movePct > 0 ? '+' : ''}${s.movePct}% in ${s.mins || 3} min</span><span class="sub">volume ${s.volX}× · ${agoS(s.t)} ago</span></div>`).join('')}</div>` : '<p class="empty">No shocks yet. The watched coins are calm.</p>'}
          ${Object.keys(d.guards).length ? `<p class="sub" style="margin-top:10px">Guard active: ${Object.entries(d.guards).map(([a, g]) => `${esc(a)} until ${new Date(g.until).toLocaleTimeString()}`).join(' · ')}</p>` : ''}
          <p class="sub" style="margin-top:12px">Watching: ${d.watch.map(a => `<span class="chip">${withCoin(a)}</span>`).join(' ')}</p></div>
        <div class="card"><h3>Sources</h3><div class="srcs">${Object.entries(d.status).map(([k, s]) => `<div><span class="dot ${s.ok ? 'ok' : 'bad'}"></span><b>${esc(k)}</b><span class="sub">${s.ok ? `checked ${agoS(s.at)} ago` : esc(s.error)}</span></div>`).join('') || '<p class="empty">Starting…</p>'}</div></div>
      </div>
      <div class="row jfilter" style="margin-top:18px" id="nfilter"><button class="chipbtn ${onlyWatched ? 'on' : ''}" data-o="1">Watched coins</button><button class="chipbtn ${onlyWatched ? '' : 'on'}" data-o="0">Everything</button><span class="sub">${items.length} items</span></div>
      <div class="feedlist">${items.slice(0, 80).map(i => `<a class="nitem" ${i.url ? `href="${esc(i.url)}" target="_blank" rel="noopener noreferrer"` : ''}><span class="t mono">${agoS(i.time)}</span><span class="s">${esc(i.source)}</span><span class="h">${esc(i.title)}</span><span class="c">${i.coins.map(c => `<span class="chip ${watch.has(c) ? 'ok' : ''}">${withCoin(c)}</span>`).join('')}</span></a>`).join('') || '<p class="empty">Nothing about the watched coins yet.</p>'}</div>
      <div class="grid g2" style="margin-top:22px">
        <div class="card"><h3>Price alerts</h3><p class="sub" style="margin:6px 0 14px">Checked every 30 seconds. Each alert fires once, writes a line in the Log and notifies you; re-arm it to use it again.</p>
          <form class="al-form" id="alForm"><input name="asset" list="alCoins" placeholder="BTC-USD" class="mono" required><datalist id="alCoins">${d.watch.map(a => `<option value="${esc(a)}">`).join('')}</datalist>
            <select name="op"><option value="above">goes above</option><option value="below">goes below</option></select><input name="price" type="number" step="any" min="0" placeholder="Price" required><button class="btn dark">Add</button>
            <input name="note" placeholder="Note (optional), e.g. breakout of the weekly range" class="al-note"></form>
          <div class="al-list">${(ns.alerts || []).length ? ns.alerts.slice().reverse().map(a => `<div class="al ${a.firedAt ? 'fired' : ''}"><span>${withCoin(a.asset)}</span><span class="mono">${a.op === 'above' ? '≥' : '≤'} ${esc(a.price)}</span><span class="sub">${a.firedAt ? `fired ${agoText(a.firedAt)} at ${esc(a.firedPrice)}` : 'armed'}${a.note ? ' · ' + esc(a.note) : ''}</span><span class="al-b">${a.firedAt ? `<button class="btn sm" data-rearm="${esc(a.id)}">Re-arm</button>` : ''}<button class="x" data-rm="${esc(a.id)}" aria-label="Remove alert">×</button></span></div>`).join('') : '<p class="empty">No alerts yet. Add one above: a level you care about, and Argus watches it for you.</p>'}</div>
          <h3 style="margin-top:22px">Notify me about</h3>
          <div class="toggles">
            <label class="tg"><input type="checkbox" data-n="shocks" ${ns.notify?.shocks !== false ? 'checked' : ''}><span></span><b>Shocks</b><em>Fast moves on heavy volume</em></label>
            <label class="tg"><input type="checkbox" data-n="headlines" ${ns.notify?.headlines !== false ? 'checked' : ''}><span></span><b>Headlines</b><em>News about the coins you watch</em></label>
            <label class="tg"><input type="checkbox" data-n="alerts" ${ns.notify?.alerts !== false ? 'checked' : ''}><span></span><b>Price alerts</b><em>When one of your levels is hit</em></label>
          </div>
          <p class="sub" style="margin-top:10px">${typeof Notification !== 'undefined' && Notification.permission === 'granted' ? 'Browser notifications are on.' : 'Turn on browser notifications at the top of this page to get them outside the tab.'}</p>
        </div>
        <div class="card"><h3>Forward alerts from anywhere</h3>
          <p class="sub" style="margin:6px 0 14px">j7tracker through a Telegram or Discord bot, TradingView, n8n, Zapier or a script: anything that can send a web request can feed the agents. Kairos reads your private address every 30 seconds, ${web ? 'right here in the browser.' : 'with no tunnel needed.'}</p>
          <label class="tg"><input type="checkbox" id="nRelay" ${ns.relay !== false ? 'checked' : ''}><span></span><b>Receive forwarded alerts</b><em>Through ntfy.sh, a free public relay</em></label>
          <label style="margin-top:12px">Your private address<div class="copyrow"><input readonly value="https://ntfy.sh/${esc(ns.relayTopic)}" class="mono" id="relayUrl"><button class="btn sm" data-copy="#relayUrl">Copy</button></div></label>
          <pre class="curl">curl -d "$PEPE: big account just tweeted" \
  -H "Title: j7tracker" -H "Tags: j7" \
  https://ntfy.sh/${esc(ns.relayTopic)}</pre>
          <p class="sub">In TradingView: alert → Notifications → Webhook URL = your address, message = the alert text. Keep the address private: anyone with it can send alerts (they inform the agents; Brake still checks every order). Free relay limit: about 250 messages a day per network.</p>
          <div class="row" style="margin-top:12px"><button class="btn sm" id="nTest">Show a test alert</button><button class="btn sm" id="nRotateRelay">New address</button></div>
          ${web ? '' : `<details style="margin-top:16px"><summary class="sub" style="cursor:pointer">Desktop only: local webhook with a token</summary>
            <label style="margin-top:10px">URL<input readonly value="${esc(hookUrl)}" class="mono"></label>
            <label>Token (header X-Kairos-Token)<input readonly value="${esc(ns.webhookToken)}" class="mono"></label>
            <pre class="curl">curl -X POST ${esc(hookUrl)} \
  -H "Content-Type: application/json" \
  -H "X-Kairos-Token: ${esc(ns.webhookToken)}" \
  -d '{"title":"$PEPE: big account just tweeted","source":"j7tracker"}'</pre>
            <div class="row"><button class="btn sm" id="nRotate">New token</button></div></details>`}
        </div>
      </div>
      <div class="card" style="margin-top:16px"><h3>Sources and watchlist</h3>
        <div class="src-grid">
          <div class="toggles">
            <label class="tg"><input type="checkbox" id="nTree" ${ns.tree ? 'checked' : ''}><span></span><b>Tree of Alpha</b><em>Tweets and headlines, seconds old, free</em></label>
            <label class="tg"><input type="checkbox" id="nRss" ${ns.rss ? 'checked' : ''} ${web ? 'disabled' : ''}><span></span><b>RSS</b><em>Cointelegraph, The Block${web ? ' · desktop app only' : ''}</em></label>
            <label class="tg"><input type="checkbox" id="nX" ${ns.x ? 'checked' : ''} ${web ? 'disabled' : ''}><span></span><b>X API</b><em>${web ? 'Browsers block X\'s API · desktop app only' : 'Your own key, every 60 seconds'}</em></label>
          </div>
          <div class="form1">
            <label>Watch these coins (besides running strategies)<input id="nWatch" value="${esc(ns.watch.join(', '))}" class="mono"></label>
            ${web ? '' : `<label>X bearer token ${ns.hasXBearer ? '(saved)' : ''}<input id="nXKey" type="password" placeholder="${ns.hasXBearer ? '•••••••• saved' : 'AAAA…'}" autocomplete="off"></label>
            <label>X search query<input id="nXQ" value="${esc(ns.xQuery)}" class="mono"></label>`}
            <div class="row"><button class="btn dark" id="nSave">Save</button></div>
          </div>
        </div>
      </div>`;
    $('#nfilter').onclick = e => { const b = e.target.closest('[data-o]'); if (b) { views.news.only = b.dataset.o === '1'; render(); } };
    $('#notify').onclick = async () => { if (typeof Notification === 'undefined') return toast('This browser has no notifications', true); toast((await Notification.requestPermission()) === 'granted' ? 'Notifications on' : 'Notifications blocked', false); render(); };
    const put = async (body, msg) => { await api('/news/settings', { method: 'PUT', body }); if (msg) toast(msg); render(); };
    $('#nSave').onclick = () => busy($('#nSave'), async () => {
      const body = { tree: $('#nTree').checked, rss: $('#nRss').checked, x: $('#nX').checked, watch: $('#nWatch').value.split(',') };
      if ($('#nXQ')) body.xQuery = $('#nXQ').value;
      if ($('#nXKey')?.value.trim()) body.xBearer = $('#nXKey').value.trim();
      await put(body, 'Sources saved');
    });
    $('#alForm').onsubmit = e => { e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); put({ addAlert: { asset: f.asset, op: f.op, price: Number(f.price), note: f.note } }, `Alert set: ${f.asset.toUpperCase()} ${f.op} ${f.price}`).catch(fail); };
    view.querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => put({ removeAlert: b.dataset.rm }, 'Alert removed')));
    view.querySelectorAll('[data-rearm]').forEach(b => (b.onclick = () => put({ rearmAlert: b.dataset.rearm }, 'Alert re-armed')));
    view.querySelectorAll('[data-n]').forEach(c => (c.onchange = () => put({ notify: Object.fromEntries([...view.querySelectorAll('[data-n]')].map(x => [x.dataset.n, x.checked])) }, 'Notifications updated')));
    $('#nRelay').onchange = e => put({ relay: e.target.checked }, e.target.checked ? 'Receiving forwarded alerts' : 'Forwarded alerts off');
    view.querySelectorAll('[data-copy]').forEach(b => (b.onclick = async () => { const v = $(b.dataset.copy).value; try { await navigator.clipboard.writeText(v); } catch { $(b.dataset.copy).select(); document.execCommand('copy'); } toast('Copied'); }));
    $('#nTest').onclick = async () => { await api('/news/test', { method: 'POST' }); toast('Test alert added to the feed'); render(); };
    $('#nRotateRelay').onclick = async () => { if (!confirm('Make a new address? Forwarders using the old one stop reaching Kairos.')) return; await put({ rotateRelay: true }, 'New address ready'); };
    if ($('#nRotate')) $('#nRotate').onclick = async () => { if (!confirm('Make a new token? Forwarders using the old one stop working.')) return; await put({ rotateToken: true }); };
  },

  async rules() {
    const [r, st] = await Promise.all([api('/rules'), api('/status')]);
    const G = [
      ['Marks to unlock real money', 'A paper strategy may only ask for real money when it beats every one of these. You approve it; nothing goes live on its own.', [
        ['min_trades', 'Paper trades', 'trades', 'Enough trades to tell skill from luck. Fewer than 50 says very little.'],
        ['min_days', 'Days on paper', 'days', 'Live time on paper, so it has seen more than one kind of market.'],
        ['min_profit_factor', 'Profit factor', '×', 'Money won divided by money lost. 1.5 means $1.50 back for every $1 lost.'],
        ['max_drawdown_pct', 'Max drawdown', '%', 'The deepest fall from a peak. Also a hard limit: Brake stops the strategy if it is crossed.'],
        ['min_adherence_pct', 'Follows its strategy', '%', 'Share of proposals that respect the strategy note. Off-strategy ideas count against it.']]],
      ['Limits Brake enforces', 'Plain code, not a model: these are checked on every order and every minute.', [
        ['daily_loss_pct', 'Daily loss', '%', 'Lose this much in a day and the strategy pauses until tomorrow.'],
        ['max_risk_per_trade_pct', 'Max risk per trade', '%', 'The most of the account one stop can cost. Strategies can ask for less, never more.'],
        ['shock_guard_min', 'Shock guard', 'min', 'After a sudden move, no new entries on that coin for this long. Nobody chases the candle.']]],
      ['Paper simulation', 'How realistic paper trading is. Kraken-level costs keep the results honest.', [
        ['starting_balance', 'Starting balance', 'USD', 'The paper account each strategy starts with.'],
        ['fee_pct', 'Fee per side', '%', 'Charged on entry and on exit. Kraken charges 0.25-0.40% at the lowest tier.'],
        ['slippage_pct', 'Slippage', '%', 'How much worse than the quote each market order fills.']]],
      ['Real money', 'Only in the desktop app, only after your approval, and only on Kraken spot with keys that cannot withdraw.', [
        ['first_tier_usd', 'First tier', 'USD', 'How much a newly approved strategy gets to start with.'],
        ['min_24h_volume_usd', 'Minimum 24h volume', 'USD', 'Coins that trade less than this are refused: thin markets eat stops.'],
        ['max_spread_pct', 'Maximum spread', '%', 'If the gap between buy and sell prices is wider, the order is refused.']]],
      ['Argus · shock detection', 'How big a fast move must be before Argus calls it a shock.', [
        ['shock_major_pct', 'Shock threshold · majors', '%', 'BTC, ETH, SOL and similar.'],
        ['shock_meme_pct', 'Shock threshold · memecoins', '%', 'Memecoins move more, so the bar is higher.']]],
    ];
    const known = new Set(G.flatMap(g => g[2].map(x => x[0]))), other = Object.keys(r).filter(k => !known.has(k));
    if (other.length) G.push(['Other', 'Keys found in your rules.md.', other.map(k => [k, k, '', ''])]);
    const stand = k => st.strategies.map(x => { const c = (x.checks || []).find(c => c.label.toLowerCase().includes({ min_trades: 'paper trades', min_days: 'days on paper', min_profit_factor: 'profit factor', max_drawdown_pct: 'max drawdown', min_adherence_pct: 'follows strategy' }[k] || '~')); return c ? `<span class="${c.pass ? 'ok' : ''}" title="${esc(x.name)}">${esc(x.name.split(' ')[0])}: ${esc(c.value)}</span>` : ''; }).join('');
    view.innerHTML = `<div class="head"><div><h1>Marks and limits</h1><p>Stored in <span class="mono">rules.md</span> in your vault. The models read it but can never change it, and Brake enforces the limits in code.</p></div><button class="btn sm" data-note="rules.md">Open rules.md</button></div>
      <form id="rf">${G.map(([title, desc, rows]) => `<section class="card rg"><div class="rg-h"><h2>${esc(title)}</h2><p class="sub">${esc(desc)}</p></div>
        ${rows.filter(([k]) => k in r).map(([k, name, unit, help]) => `<div class="rr"><div><b>${esc(name)}</b><p class="sub">${esc(help)}</p>${title.startsWith('Marks') ? `<div class="stand">${stand(k)}</div>` : ''}</div>
          <label class="ri"><input name="${esc(k)}" type="number" step="any" min="0" value="${esc(r[k])}"><span>${esc(unit)}</span></label></div>`).join('')}</section>`).join('')}
        <div class="rf-bar"><span class="sub">Changes apply to every strategy from the next check.</span><button class="btn dark">Save rules</button></div></form>`;
    $('#rf').onsubmit = async e => { e.preventDefault(); try { await api('/rules', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('Rules saved'); render(); } catch (er) { fail(er); } };
  },

  async team() {
    const c = settings, M = c.catalog.models, R = c.catalog.roles;
    const opts = sel => Object.entries(M).map(([k, m]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
    view.innerHTML = `<div class="head"><div><h1>Team settings</h1><p>One key connects every model. Choose whether they work as a team or one model works alone.</p></div></div>
      <div class="grid g2">
        <div class="card"><h2>How the models work</h2>
          <div class="row" style="margin:14px 0"><label class="check"><input type="radio" name="mode" value="team" ${c.mode === 'team' ? 'checked' : ''}> <b>Team</b>: each model takes a role and a second model reviews every trade</label></div>
          <div class="row"><label class="check"><input type="radio" name="mode" value="solo" ${c.mode === 'solo' ? 'checked' : ''}> <b>Solo</b>: one model does everything</label><span class="mpick"><img class="mlogo" src="../assets/model-${esc(M[c.soloModel]?.logo || 'claude')}.webp" alt="" width="24" height="24"><select id="soloModel" style="width:auto">${opts(c.soloModel)}</select></span></div>
          <label class="check" style="margin-top:16px"><input type="checkbox" id="web" ${c.webSearch ? 'checked' : ''}> Allow web search for Market context and Sentiment (extra model cost)</label>
        </div>
        <div class="card"><h2>AI key</h2><p class="sub" style="margin:8px 0 12px">${c.hasApiKey ? `Saved (${esc(c.apiKeyHint)}). Stored only on this computer in <span class="mono">~/.kairos/config.json</span>, never in the vault.` : c.freeAvailable ? `You are on the free trial: ${Math.max(c.freeLimit - c.freeUsed, 0)} of ${c.freeLimit} instructions left. Paper trading needs your own key.` : 'Needed to use the models.'}</p>
          <p class="sub" style="margin:-4px 0 12px">Kairos connects to every model through <b>OpenRouter</b>, so one key covers Claude, GPT, Gemini, Astra and Grok. Get yours at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">openrouter.ai/keys</a> and paste it here.</p>
          <div class="row"><input id="key" type="password" placeholder="sk-or-..." autocomplete="off" style="flex:1"><button class="btn dark" id="saveKey">Save key</button>${c.hasApiKey ? '<button class="btn red" id="delKey">Remove</button>' : ''}</div>
          ${c.web ? `<p class="sub" style="margin-top:16px">Vault: <b>${esc(c.vaultLabel)}</b></p><div class="row" style="margin-top:8px"><button class="btn sm" id="zipVault">Export vault (.zip)</button><button class="btn sm" id="switchVault">Use another place</button></div>`
            : `<label style="margin-top:16px">Vault folder<input id="vault" value="${esc(c.vaultPath)}"></label><button class="btn sm" id="saveVault" style="margin-top:8px">Change vault</button>`}</div>
      </div>
      ${c.web ? `<div class="card" style="margin-top:16px"><h2>Kraken · real money</h2><p class="sub" style="margin-top:8px">Real money runs only in the <a href="../tour#get">desktop app</a>, so your Kraken key never sits in a web page.</p></div>` : `<div class="card" style="margin-top:16px"><h2>Kraken · real money</h2>
        <p class="sub" style="margin:8px 0 12px">${c.hasKraken ? `Connected (${esc(c.krakenHint)}), checked ${esc(String(c.krakenCheckedAt).slice(0, 10))}: can trade, cannot withdraw.` : 'On Kraken: Settings → API → Create key. Enable only <b>Query Funds</b>, <b>Query Open/Closed Orders & Trades</b>, <b>Create & Modify Orders</b> and <b>Cancel/Close Orders</b>. Never enable Withdraw: the app refuses keys that can.'} Keys stay on this computer only.</p>
        <div class="row"><input id="krKey" placeholder="API key" autocomplete="off" style="flex:1"><input id="krSecret" type="password" placeholder="Private key" autocomplete="off" style="flex:1"><button class="btn dark" id="saveKr" data-busy="Checking key">Connect</button>${c.hasKraken ? '<button class="btn red" id="delKr">Remove</button>' : ''}</div></div>`}
      <div class="card" style="margin-top:16px"><h2>Roles</h2><p class="sub" style="margin:6px 0 12px">Used in Team mode. Lead is always on. Brake (risk) is code, not a model.</p>
        <div class="tblwrap"><table><tr><th>On</th><th>Role</th><th>What it does</th><th>Model</th></tr>
        ${Object.entries(R).map(([k, r]) => `<tr><td><input type="checkbox" data-role-on="${k}" ${c.enabledRoles[k] ? 'checked' : ''} ${k === 'lead' ? 'disabled' : ''} style="width:auto"></td><td><b>${esc(r.label)}</b></td><td class="sub">${esc(r.desc)}</td><td><span class="mpick"><img class="mlogo" src="../assets/model-${esc(M[c.roles[k]]?.logo || 'claude')}.webp" alt="" width="24" height="24"><select data-role="${k}">${opts(c.roles[k])}</select></span></td></tr>`).join('')}</table></div></div>
      <details class="card soft" style="margin-top:16px"><summary style="cursor:pointer;font-weight:600">Advanced: model IDs</summary><div class="form" style="margin-top:12px">
        ${Object.entries(M).map(([k, m]) => `<label>${esc(m.label)}<input data-model="${k}" value="${esc(c.models[k])}" class="mono"></label>`).join('')}</div>
        <button class="btn sm" id="saveIds" style="margin-top:12px">Save model IDs</button></details>`;
    const save = async (patch, msg) => { try { settings = await api('/settings', { method: 'PUT', body: patch }); renderHeader(); toast(msg); render(); } catch (e) { fail(e); } };
    view.querySelectorAll('input[name=mode]').forEach(i => (i.onchange = () => save({ mode: i.value }, 'Mode saved')));
    $('#soloModel').onchange = e => save({ soloModel: e.target.value }, 'Solo model saved');
    $('#web').onchange = e => save({ webSearch: e.target.checked }, 'Saved');
    view.querySelectorAll('[data-role]').forEach(s => (s.onchange = () => save({ roles: { [s.dataset.role]: s.value } }, 'Role saved')));
    view.querySelectorAll('[data-role-on]').forEach(s => (s.onchange = () => save({ enabledRoles: { [s.dataset.roleOn]: s.checked } }, 'Role saved')));
    $('#saveKey').onclick = () => { const k = $('#key').value.trim(); if (!k) return toast('Paste a key first', true); save({ apiKey: k }, 'Key saved'); };
    if ($('#delKey')) $('#delKey').onclick = () => save({ apiKey: '' }, 'Key removed');
    if ($('#zipVault')) { $('#zipVault').onclick = () => window.__kairosWeb.exportZip(); $('#switchVault').onclick = () => { if (confirm('Switch to another vault? This one stays where it is.')) window.__kairosWeb.switchVault(); }; }
    if ($('#saveKr')) $('#saveKr').onclick = e => busy(e.currentTarget, async () => { settings = await api('/exchange', { method: 'PUT', body: { key: $('#krKey').value, secret: $('#krSecret').value } }); renderHeader(); toast('Kraken connected: trade only, no withdrawals'); render(); });
    if ($('#delKr')) $('#delKr').onclick = async () => { try { settings = await api('/exchange', { method: 'DELETE' }); toast('Kraken key removed'); render(); } catch (er) { fail(er); } };
    if ($('#saveVault')) $('#saveVault').onclick = () => save({ vaultPath: $('#vault').value }, 'Vault changed');
    $('#saveIds').onclick = () => save({ models: Object.fromEntries([...view.querySelectorAll('[data-model]')].map(i => [i.dataset.model, i.value])) }, 'Model IDs saved');
  },

  async log() {
    const s = await api('/status');
    const files = (await api('/notes?dir=Log')).reverse().slice(0, 14);
    view.innerHTML = `<div class="head"><div><h1>Log</h1><p>Every order, block, pause and promotion is written to <span class="mono">Log/</span> in your vault.</p></div></div>
      <div class="split"><div class="list">${files.map(f => `<button data-note="${esc(f)}"><span class="mono">${esc(f.replace('Log/', ''))}</span></button>`).join('') || '<p class="empty">No log files yet.</p>'}</div>
      <div class="card"><h2 style="margin-bottom:8px">This session</h2><div class="feed">${s.activity.map(a => `<div><time>${ago(a.at)}</time><span>${esc(a.msg)}</span></div>`).join('') || '<p class="empty">Nothing yet.</p>'}</div></div></div>`;
  },
};

function chip(s) {
  if (s.live === 'real') return '<span class="chip ok">live · real</span>';
  if (s.live === 'validate') return '<span class="chip run">live · validate</span>';
  if (s.draft) return '<span class="chip">draft</span>';
  if (s.paused) return '<span class="chip bad">paused</span>';
  if (s.promotion === 'approved') return '<span class="chip ok">approved</span>';
  return s.status === 'running' ? '<span class="chip run">running</span>' : '<span class="chip">stopped</span>';
}

/* ---------- the strategy chart (TradingView Lightweight Charts) with the agent's trades, its logic and its decisions ---------- */
const chartPick = {}; // per strategy: { asset, tf, tab }
function chartCard(s) {
  const pick = chartPick[s.name] ||= { asset: s.assets[0], tf: s.timeframe === '1d' ? '1d' : '1h', tab: 'logic' };
  if (!s.assets.includes(pick.asset)) pick.asset = s.assets[0];
  const logic = String(s.body || '').replace(/^#\s+.*\n/, '').trim();
  return `<div class="card chartcard" style="margin-top:16px">
    <div class="cc-chart"><div class="row cc-bar"><div class="cc-assets">${s.assets.map(a => `<button class="chip cc-a ${a === pick.asset ? 'on' : ''}" data-asset="${esc(a)}">${withCoin(a)}</button>`).join('')}</div>
      <div class="cc-tf">${['1h', '1d'].map(t => `<button class="chip ${t === pick.tf ? 'on' : ''}" data-tf="${t}">${t}</button>`).join('')}</div></div>
      <div id="tvchart" class="cc-canvas"></div>
      <p class="sub cc-legend">▲ entry: <span class="win">won</span> / <span class="sell">lost</span> / <span class="buy">open</span> · ▼ exit with its result · <span class="lim">●</span> buy limit placed · dashed lines: entry, stop and target of an open position · chart by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a></p></div>
    <div class="cc-side"><div class="row cc-tabs"><button class="chip ${pick.tab === 'logic' ? 'on' : ''}" data-tab="logic">Logic</button><button class="chip ${pick.tab === 'dec' ? 'on' : ''}" data-tab="dec">Decisions</button></div>
      <div class="cc-pane md" ${pick.tab === 'logic' ? '' : 'hidden'} data-pane="logic">${md(logic || 'This strategy has no written rules yet.')}</div>
      <div class="cc-pane" ${pick.tab === 'dec' ? '' : 'hidden'} data-pane="dec">${(s.decisions || []).length ? s.decisions.map(d => `<div class="cc-d ${esc(d.outcome)}" data-at="${esc(d.at)}" data-asset="${esc(d.asset || '')}"><span class="mono">${esc(new Date(d.at).toISOString().slice(0, 10))}</span><b>${esc(({ opened: 'Bought', closed: 'Sold', order: 'Buy limit', hold: 'Hold', blocked: 'Blocked', 'stop moved': 'Stop moved' })[d.outcome] || d.outcome)}${d.asset && d.outcome !== 'hold' ? ' · ' + esc(d.asset.split('-')[0]) : ''}</b><p>${esc(String(d.thesis || '').split('\n')[0].slice(0, 170))}</p></div>`).join('') : '<p class="empty">No decisions yet. Start the strategy on paper, or run one decision.</p>'}</div></div></div>`;
}
async function mountChart(s) {
  const el = document.getElementById('tvchart'), card = el && el.closest('.chartcard'), LW = window.LightweightCharts;
  if (!el || !LW) { if (el) el.innerHTML = '<p class="empty">Chart unavailable.</p>'; return; }
  const pick = chartPick[s.name];
  card.querySelectorAll('[data-asset].cc-a').forEach(b => b.onclick = () => { pick.asset = b.dataset.asset; renderStrategy(s.name); });
  card.querySelectorAll('[data-tf]').forEach(b => b.onclick = () => { pick.tf = b.dataset.tf; renderStrategy(s.name); });
  card.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { pick.tab = b.dataset.tab; card.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b)); card.querySelectorAll('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== pick.tab); });
  const dark = document.documentElement.dataset.theme === 'dark', css = getComputedStyle(document.documentElement);
  const chart = LW.createChart(el, { autoSize: true, layout: { background: { color: 'transparent' }, textColor: dark ? '#b6bac4' : '#40455f', fontFamily: 'Geist, sans-serif' },
    grid: { vertLines: { color: dark ? '#33363c' : '#eef0f3' }, horzLines: { color: dark ? '#33363c' : '#eef0f3' } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: pick.tf === '1h' } });
  const series = chart.addCandlestickSeries({ upColor: '#22c58b', downColor: '#f0503c', wickUpColor: '#22c58b', wickDownColor: '#f0503c', borderVisible: false });
  let candles = [];
  try { candles = (await api(`/candles?asset=${encodeURIComponent(pick.asset)}&tf=${pick.tf}&limit=300`)).candles; } catch (e) { el.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  if (!candles.length) { el.innerHTML = '<p class="empty">No candles for this market yet.</p>'; return; }
  const step = pick.tf === '1h' ? 3600 : 86400, bucket = ms => Math.floor(ms / 1000 / step) * step, first = bucket(candles[0].t), last = bucket(candles.at(-1).t);
  series.setData(candles.map(c => ({ time: bucket(c.t), open: c.open, high: c.high, low: c.low, close: c.close })));
  // the agent's trades on this market: paper account, the paper track in the journal, and its recent decisions
  const marks = [], seen = new Set(), add = (ms, kind, text) => { const t = bucket(ms); if (t < first || t > last) return; const k = t + kind; if (seen.has(k)) return; seen.add(k);
    // entries: an arrow coloured by how the trade ended (blue while open or unknown); exits carry the result
    marks.push(kind === 'buy' ? { time: t, position: 'belowBar', color: text === 'win' ? '#22c58b' : text === 'loss' ? '#f0503c' : '#0055ff', shape: 'arrowUp', text: '' } : kind === 'sell' ? { time: t, position: 'aboveBar', color: text.startsWith('+') ? '#22c58b' : '#f0503c', shape: 'arrowDown', text } : { time: t, position: 'belowBar', color: '#2a9dc4', shape: 'circle', text: '' }); };
  const short = n => (n >= 0 ? '+' : '−') + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
  for (const t of s.account.trades.filter(t => t.asset === pick.asset)) { add(Date.parse(t.openedAt), 'buy', t.pnl > 0 ? 'win' : 'loss'); add(Date.parse(t.closedAt), 'sell', short(t.pnl)); }
  for (const d of (s.decisions || []).filter(d => d.asset === pick.asset)) { const at = Date.parse(d.at) - (pick.tf === '1d' ? 86400000 : 0); if (d.outcome === 'opened') add(at, 'buy', 'open'); else if (d.outcome === 'closed') add(at, 'sell', d.pnl != null ? short(d.pnl) : 'Sell'); else if (d.outcome === 'order') add(at, 'limit', ''); }
  try { for (const t of (await api('/journal')).filter(t => t.strategy === s.name && t.asset === pick.asset)) { const ds = String(t.date); add(Date.parse(/T|Z$/.test(ds) ? ds : ds.replace(' ', 'T') + 'Z'), 'buy', t.pnl > 0 ? 'win' : 'loss'); } } catch { /* journal unavailable */ }
  series.setMarkers(marks.sort((a, b) => a.time - b.time));
  const open = s.account.positions[pick.asset];
  if (open) [['Entry', open.entry, '#0055ff'], ['Stop', open.stop, '#f0503c'], ['Target', open.takeProfit, '#22c58b']].forEach(([title, price, color]) => { if (Number.isFinite(price)) series.createPriceLine({ price, color, lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title }); });
  chart.timeScale().fitContent();
  // clicking a decision moves the chart to that day
  card.querySelectorAll('.cc-d').forEach(d => d.onclick = () => { if (d.dataset.asset && d.dataset.asset !== pick.asset && s.assets.includes(d.dataset.asset)) { pick.asset = d.dataset.asset; pick.tab = 'dec'; return renderStrategy(s.name); }
    const t = bucket(Date.parse(d.dataset.at)), span = step * 40; chart.timeScale().setVisibleRange({ from: t - span, to: t + span / 2 }); card.querySelectorAll('.cc-d').forEach(x => x.classList.toggle('on', x === d)); });
}

/* ---------- how the AI decided: every decision, step by step ---------- */
const openDecisions = new Set();
function decisionsCard(s, running) {
  const ds = s.decisions || [], ex = ds.length > 0 && ds.every(d => d.example);
  const title = d => ({ opened: `Opened ${d.side || ''} ${d.asset}`, hold: 'Hold', order: `Buy limit · ${d.asset}`, blocked: `Blocked · ${d.asset}`, closed: `Closed ${d.asset}`, 'stop moved': `Stop moved · ${d.asset}` })[d.outcome] || d.outcome;
  const tone = d => ({ opened: 'go', closed: 'go', 'stop moved': 'go', order: 'go', blocked: 'no', hold: 'wait' })[d.outcome] || 'wait';
  const step = (n, h, body) => `<div class="ds"><span class="ds-n">${n}</span><div><b class="ds-h">${h}</b>${body}</div></div>`;
  const when = d => new Date(d.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  const item = d => {
    const st = r => (d.steps || []).find(x => x.role === r), c = d.context || {}, lead = st('lead'), chart = st('charts'), rev = st('reviewer'), scribe = st('scribe');
    const seen = [
      c.prices ? `<div class="ds-chips">${Object.entries(c.prices).map(([a, v]) => `<span class="chip">${withCoin(a)} ${fp(v)}</span>`).join('')}</div>` : '',
      c.trend && Object.keys(c.trend).length ? `<p class="sub">Daily trend: ${Object.entries(c.trend).map(([a, t]) => `${esc(a.split('-')[0])} ${t.ok ? '<span class="pos">with the trend</span>' : '<span class="neg">against the trend</span>'}`).join(' · ')}</p>` : '',
      c.shocks?.length ? `<p class="sub">Shocks: ${c.shocks.map(esc).join(' · ')}</p>` : '',
      c.headlines?.length ? `<ul class="ds-news">${c.headlines.slice(0, 4).map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : '',
      c.lessons ? `<p class="sub">Read ${c.lessons} lessons from earlier trades.</p>` : ''].join('') || `<p class="sub">${d.track ? 'Daily candles of the 8 coins and BTC\'s long average.' : 'Hourly candles of the strategy\'s coins.'}</p>`;
    const prop = d.outcome === 'hold' ? '<p class="ds-v">Proposed: <b>hold</b>, no order.</p>'
      : `<p class="ds-v">Proposed: <b>${esc(d.action === 'move_stop' ? 'move the stop' : d.action)} ${esc(d.side || '')} ${esc(d.asset || '')}</b>${d.stop != null ? ` · stop ${fp(d.stop)}` : ''}${d.takeProfit != null ? ` · target ${fp(d.takeProfit)}` : ''}${d.riskPct != null ? ` · risk ${esc(d.riskPct)}%` : ''}</p>`;
    const steps = [
      step(1, 'What it looked at', seen),
      chart ? step(2, `Chart reading · ${esc(chart.model)}`, `<div class="md ds-t">${md(chart.text.slice(0, 900))}</div>`) : '',
      step(chart ? 3 : 2, `The decision · ${esc(lead ? lead.model : 'lead')}`, `${prop}<div class="md ds-t">${md(d.thesis || '')}</div>`),
      step(chart ? 4 : 3, 'Second opinion', d.outcome === 'hold' && d.reviewerAgreed == null ? '<p class="sub">Not needed: a hold places no order.</p>' : d.reviewerAgreed == null ? `<p class="sub">${d.track ? 'Rules only: the paper track has no model and no reviewer. When the AI runs this strategy, it adds the news and a second opinion.' : d.mode === 'solo' || d.example ? 'Solo: one model decides alone.' : 'No reviewer on.'}</p>` : `<p class="ds-v">${d.reviewerAgreed ? '<span class="pos">Agreed</span>' : '<span class="neg">Disagreed</span>'}${rev ? ` · ${esc(rev.model)}` : ''}</p>${d.reviewReason ? `<p class="sub">${esc(d.reviewReason)}</p>` : ''}`),
      step(chart ? 5 : 4, 'Brake', d.outcome === 'blocked' ? `<ul class="ds-no">${d.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : d.outcome === 'hold' ? '<p class="sub">Nothing to check: no order.</p>' : d.track ? '<p class="sub">The paper track sizes every order inside the 3% risk rule by construction. When the AI trades this strategy, Brake checks each order.</p>' : '<p class="sub"><span class="pos">Passed</span>: in the strategy, stop on the right side, risk within your limit, trend and position checks.</p>'),
      step(chart ? 6 : 5, 'Result', `<p class="ds-v">${d.outcome === 'opened' ? `Opened on paper${d.entry ? ` at ${fp(d.entry)}` : ''}.` : d.outcome === 'closed' ? `Closed${d.pnl != null ? `: ${money(d.pnl)}` : ''}.` : d.outcome === 'stop moved' ? `Stop moved to ${fp(d.stop)}.` : d.outcome === 'blocked' ? 'Nothing sent: Brake said no.' : d.outcome === 'order' ? 'Buy limit placed for the next day.' : 'Waited for a better moment.'}</p>${scribe ? `<p class="sub">The scribe wrote the journal note (${esc(scribe.model)}).</p>` : ''}`)].join('');
    return `<details class="dec ${tone(d)}" data-at="${esc(d.at)}"><summary><span class="dec-t mono">${when(d)}</span><span class="dec-b">${esc(title(d))}</span><span class="dec-w">${esc(String(d.thesis || '').split('\n\n')[0].slice(0, 150))}${String(d.thesis || '').split('\n\n')[0].length > 150 ? '…' : ''}</span><span class="dec-x">+</span></summary><div class="dec-steps">${steps}</div></details>`;
  };
  const guide = ex || !ds.length ? `<div class="dec-guide"><div><b>${ex && ds[0].track ? `The ${esc(s.name)} paper track: the rules decide once a day on real prices.` : ex ? 'These are examples: the 10 decisions of paper test 4.' : 'No decisions yet.'}</b><p class="sub">${ex && ds[0].track ? 'A new day appears after every daily close, holds included. Start the strategy and the AI makes these decisions itself, reading the news too.' : 'Start the strategy on paper and every decision it makes appears here, step by step, replacing the examples.'}</p></div>
    <div class="row">${s.hasKey ? '' : '<button class="btn" data-go="team">1 · Connect your AI key</button>'}${running ? '' : `<button class="btn dark" data-act="start">${s.hasKey ? '1' : '2'} · Start on paper</button>`}<button class="btn" data-act="run" data-busy="Deciding">Run one decision now</button></div></div>` : '';
  return `<div class="card decs" style="margin-top:16px"><div class="row" style="justify-content:space-between;align-items:flex-end"><div><h3>How the AI decided</h3><p class="sub">What it looked at, what it proposed, who checked it, and why it acted. Newest first${running ? ' · refreshes every minute' : ''}.</p></div>${ds.length ? `<span class="sub">${ds.length} decision${ds.length === 1 ? '' : 's'}</span>` : ''}</div>
    ${guide}<div class="dec-list">${ds.map(item).join('')}</div></div>`;
}

async function renderStrategy(name) {
  const box = $('#sdetail');
  let s; try { s = await api('/strategies/' + encodeURIComponent(name)); } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  const a = s.account, ev = s.evaluation, m = ev.metrics, running = s.status === 'running', p = s.promotion;
  const pos = Object.values(a.positions);
  box.innerHTML = `
    <div class="card"><div class="head" style="margin-bottom:12px"><div><h2>${esc(s.name)} ${chip({ ...s, paused: a.paused, promotion: p?.status })}</h2>
      <div class="s-coins">${s.assets.map(a => `<span class="chip">${withCoin(a)}</span>`).join('')}</div>
      <div class="s-meta">
        <div><span class="eyebrow">Hours (UTC)</span><b>${esc(s.hours_utc || 'any')}</b></div>
        <div><span class="eyebrow">Risk per trade</span><b>${esc(s.risk_per_trade_pct)}%</b></div>
        <div><span class="eyebrow">Decides every</span><b>${esc(s.interval_min || 60)} min</b></div>
        <div><span class="eyebrow">Max open</span><b>${Number(s.max_positions) > 0 ? esc(s.max_positions) : 'no limit'}</b></div>
        <div><span class="eyebrow">Trend filter</span><b>${s.trend_filter === true ? 'On' : 'Off'}</b></div>
        <div><span class="eyebrow">Last decision</span><b>${a.lastDecisionAt ? agoText(a.lastDecisionAt) : 'never'}</b></div>
      </div>
      ${a.paused ? `<p class="sub neg" style="margin-top:4px">Paused: ${esc(a.paused.reason)}</p>` : ''}</div>
      <div class="row">${running ? '<button class="btn" data-act="stop">Stop</button>' : `<button class="btn dark" data-act="start" ${s.draft ? 'disabled title="Draft: set draft: false in the note first"' : ''}>Start on paper</button>`}
        <button class="btn" data-act="run" data-busy="Deciding">Run a decision now</button>${pos.length ? '<button class="btn red" data-act="close-all">Close all & stop</button>' : '<button class="btn sm" data-act="reset">Reset account</button>'}
        <button class="btn sm" data-note="${esc(s.path)}">Open note</button><button class="btn sm" onclick="document.querySelector('.decs').scrollIntoView({behavior:'smooth'})">How the AI decided ↓</button></div></div>
      <div class="grid g4">
        <div class="stat"><span class="eyebrow">Paper equity</span><div class="n">$${s.equity.toLocaleString('en-US')}</div></div>
        <div class="stat"><span class="eyebrow">Closed trades</span><div class="n">${m.count}</div></div>
        <div class="stat"><span class="eyebrow">PnL</span><div class="n ${cls(m.totalPnl)}">${money(m.totalPnl)}</div></div>
        <div class="stat"><span class="eyebrow">Max drawdown</span><div class="n">${m.maxDrawdownPct}%</div></div></div></div>
    ${chartCard(s)}
    <div id="decision"></div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3>Your marks</h3><div class="checks" style="margin-top:8px">${ev.checks.map(c => `<div class="c ${c.pass ? 'pass' : 'fail'}"><span>${esc(c.label)}</span><span>${esc(c.value)} ${c.pass ? '✓' : '✗'}</span></div>`).join('')}</div>
        <div class="row" style="margin-top:14px">${p?.status === 'requested' ? `<span class="sub">Requested $${esc(p.tierUsd)} of real capital.</span><button class="btn dark sm" data-promo="approve">Approve</button><button class="btn sm" data-promo="reject">Reject</button>`
          : p?.status === 'approved' ? `<span class="chip ok">approved</span><span class="sub">$${esc(p.tierUsd)} tier approved. Go live in the Real money panel below.</span>`
          : `<button class="btn sm" data-promo="request" ${ev.eligible ? '' : 'disabled'}>Request real capital</button><span class="sub">${ev.eligible ? 'All marks beaten.' : 'Available once every mark is beaten.'}</span>`}</div></div>
      <div class="card"><h3>Open positions</h3>${pos.length ? `<table style="margin-top:8px"><tr><th>Asset</th><th>Side</th><th>Entry</th><th>Stop</th><th>TP</th><th>Now</th></tr>${pos.map(x => `<tr class="click" data-note="${esc(x.notePath)}"><td>${withCoin(x.asset)}</td><td>${esc(x.side)}</td><td class="num">${fp(x.entry)}</td><td class="num">${fp(x.stop)}</td><td class="num">${fp(x.takeProfit)}</td><td class="num">${fp(s.prices[x.asset])}</td></tr>`).join('')}</table>` : '<p class="empty">No open positions.</p>'}</div>
    </div>
    ${p?.status === 'approved' || s.live ? liveCard(s) : ''}
    ${decisionsCard(s, running)}
    <div class="card lessons" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h3>Lessons learned</h3><span class="sub">Written after every close · read before every decision · <a href="#" data-note="${esc('Lessons/' + s.name + '.md')}">open note</a></span></div>
      ${s.lessons?.length ? s.lessons.map(l => `<div class="lesson ${/· -/.test(l.title) ? 'loss' : 'win'}"><b class="mono">${esc(l.title)}</b><ul>${l.lines.filter(x => !x.startsWith('Thesis')).map(x => `<li>${md(x).replace(/<\/?p>/g, '')}</li>`).join('')}</ul></div>`).join('') : '<p class="empty">No closed trades yet. Each one will leave a lesson here.</p>'}</div>
    <div class="card" style="margin-top:16px"><h3>Closed paper trades</h3>${a.trades.length ? `<div class="tblwrap"><table style="margin-top:8px"><tr><th>Closed</th><th>Asset</th><th>Side</th><th>Entry</th><th>Exit</th><th>PnL</th><th>R</th><th>Reason</th><th>Models</th></tr>
      ${a.trades.slice().reverse().map(t => `<tr class="click" data-note="${esc(t.notePath || '')}"><td class="num">${esc(String(t.closedAt).slice(0, 16).replace('T', ' '))}</td><td>${withCoin(t.asset)}</td><td>${esc(t.side)}</td><td class="num">${fp(t.entry)}</td><td class="num">${fp(t.exit)}</td><td class="num ${cls(t.pnl)}">${money(t.pnl)}</td><td class="num ${cls(t.r)}">${t.r}</td><td>${esc(t.reason)}</td><td class="sub">${esc([t.proposer, t.reviewer].filter(Boolean).join(' + '))}</td></tr>`).join('')}</table></div>` : '<p class="empty">No closed trades yet.</p>'}</div>`;
  mountChart(s);
  // keep opened decisions open across refreshes; refresh every minute while the strategy runs
  box.querySelectorAll('details.dec').forEach(d => { if (openDecisions.has(d.dataset.at)) d.open = true; d.ontoggle = () => { d.open ? openDecisions.add(d.dataset.at) : openDecisions.delete(d.dataset.at); }; });
  clearInterval(window.__decTimer);
  if (running) window.__decTimer = setInterval(() => { if (current === 'strategies' && selected === name && !document.querySelector('dialog[open]')) renderStrategy(name); }, 60000);
  box.querySelectorAll('[data-act]').forEach(b => (b.onclick = () => busy(b, async () => {
    const act = b.dataset.act;
    if ((act === 'close-all' || act === 'reset') && !confirm(act === 'reset' ? 'Reset this paper account? Its trades and evaluation start from zero.' : 'Close every open paper position at market and stop the strategy?')) return;
    const r = await api(`/strategies/${encodeURIComponent(name)}/${act}`, { method: 'POST' });
    if (act === 'run') { await renderStrategy(name); showDecision(r); } else { toast('Done'); render(); }
  })));
  box.querySelectorAll('[data-live]').forEach(b => (b.onclick = () => busy(b, async () => {
    const act = b.dataset.live;
    const body = { action: act === 'off' ? 'disable' : 'enable', mode: act };
    if (act === 'real') {
      const typed = prompt(`REAL MONEY on Kraken.\n\nThe agents will place real spot orders with up to $${s.promotion?.tierUsd} of your Kraken USD balance. Every buy gets a stop-loss on Kraken, but you can still lose this money.\n\nType the strategy name to confirm:\n${name}`);
      if (typed === null) return;
      body.confirm = typed.trim();
    }
    if (act === 'off' && !confirm('Close every live position at market on Kraken and send this strategy back to paper?')) return;
    await api(`/strategies/${encodeURIComponent(name)}/live`, { method: 'POST', body });
    toast(act === 'off' ? 'Back to paper' : act === 'real' ? 'Real money enabled' : 'Validate mode enabled'); render();
  })));
  box.querySelectorAll('[data-promo]').forEach(b => (b.onclick = () => busy(b, async () => { await api(`/strategies/${encodeURIComponent(name)}/promotion`, { method: 'POST', body: { action: b.dataset.promo } }); toast('Saved'); render(); })));
}

function liveCard(s) {
  const l = s.live, on = l && l.enabled;
  const head = `<div class="head" style="margin-bottom:10px"><div><h3>Real money · Kraken spot ${on ? (l.mode === 'real' ? '<span class="chip ok">live · real</span>' : '<span class="chip run">validate mode</span>') : ''}</h3>
    <p class="sub" style="margin-top:6px">Long only, no leverage. Every buy gets a stop-loss order on Kraken. Brake checks liquidity and spread before each buy; memecoins included if Kraken lists them.</p></div>`;
  if (settings.web) return `<div class="card" style="margin-top:16px">${head}</div><div class="banner info">Approved. Real money runs only in the <a href="../tour#get">desktop app</a>: open this vault there to go live on Kraken.</div></div>`;
  if (!s.exchange.connected) return `<div class="card" style="margin-top:16px">${head}</div><div class="banner info">Connect a Kraken API key in <a href="#team">Team</a> first (trade-only, no withdrawals).</div></div>`;
  if (!on) return `<div class="card" style="margin-top:16px">${head}<div class="row"><button class="btn" data-live="validate" data-busy="Checking">Go live · validate mode</button><button class="btn dark" data-live="real" data-busy="Checking">Go live · real money</button></div></div>
    <p class="sub">${l?.stoppedReason ? `Last live run stopped: ${esc(l.stoppedReason)}. ` : ''}Validate mode sends every order to Kraken for checking but executes nothing. Start there.</p></div>`;
  const m = l.metrics, pos = Object.values(l.account.positions);
  return `<div class="card" style="margin-top:16px;border-color:${l.mode === 'real' ? 'var(--lime-ink)' : 'var(--blue)'}">${head}<button class="btn red" data-live="off" data-busy="Closing">Back to paper</button></div>
    ${l.account.paused ? `<div class="banner">Paused until tomorrow: ${esc(l.account.paused.reason)}</div>` : ''}
    <div class="grid g4"><div class="stat"><span class="eyebrow">Allocation</span><div class="n">$${esc(l.allocationUsd)}</div></div><div class="stat"><span class="eyebrow">Live equity</span><div class="n">$${l.equity.toLocaleString('en-US')}</div></div>
      <div class="stat"><span class="eyebrow">Live PnL</span><div class="n ${cls(m.totalPnl)}">${money(m.totalPnl)}</div></div><div class="stat"><span class="eyebrow">Live trades</span><div class="n">${m.count}</div></div></div>
    ${pos.length ? `<table style="margin-top:14px"><tr><th>Asset</th><th>Qty</th><th>Entry</th><th>Stop on Kraken</th><th>TP</th><th>Bid</th></tr>${pos.map(x => `<tr class="click" data-note="${esc(x.notePath)}"><td>${withCoin(x.asset)}</td><td class="num">${fp(x.qty)}</td><td class="num">${fp(x.entry)}</td><td class="num">${fp(x.stop)} <span class="sub">${esc(x.stopTxid || (x.mode === 'validate' ? 'simulated' : ''))}</span></td><td class="num">${fp(x.takeProfit)}</td><td class="num">${fp(l.prices[x.asset])}</td></tr>`).join('')}</table>` : '<p class="empty">No live positions.</p>'}
    ${l.account.trades.length ? `<div class="tblwrap"><table style="margin-top:10px"><tr><th>Closed</th><th>Asset</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Reason</th></tr>${l.account.trades.slice().reverse().map(t => `<tr class="click" data-note="${esc(t.notePath || '')}"><td class="num">${esc(String(t.closedAt).slice(0, 16).replace('T', ' '))}</td><td>${withCoin(t.asset)}</td><td class="num">${fp(t.entry)}</td><td class="num">${fp(t.exit)}</td><td class="num ${cls(t.pnl)}">${money(t.pnl)}</td><td>${esc(t.reason)}</td></tr>`).join('')}</table></div>` : ''}</div>`;
}

function showDecision(r) {
  const el = $('#decision'); if (!el) return;
  if (r.action === 'skip') { el.innerHTML = `<div class="banner" style="margin-top:16px">Skipped: ${esc(r.reason)}</div>`; return; }
  const p = r.proposal || {}, v = r.verdict || { ok: true, reasons: [] };
  const what = p.action === 'hold' ? 'Hold' : `${p.action} ${p.side || ''} ${p.asset || ''}`;
  el.innerHTML = `<div class="card ${v.ok ? 'soft' : ''}" style="margin-top:16px;${v.ok ? '' : 'border-color:var(--red)'}"><span class="eyebrow">Decision · ${esc(r.mode)} mode</span>
    <h3 style="margin:8px 0">${esc(what)} ${p.action !== 'hold' ? (v.ok ? `<span class="chip ok">${r.live === 'real' ? 'executed on Kraken · real money' : r.live === 'validate' ? 'validated by Kraken · simulated fill' : 'executed on paper'}</span>` : '<span class="chip bad">blocked</span>') : ''}</h3>
    <p class="md">${esc(p.thesis || '')}</p>${v.reasons.length ? `<ul class="md">${v.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${r.reviewReason ? `<p class="sub">Second opinion: ${esc(r.reviewReason)}</p>` : ''}
    <div class="steps">${(r.steps || []).map(s => `<details><summary>${esc(s.role)} · ${esc(s.model)}</summary><pre>${esc(s.text)}</pre></details>`).join('')}</div></div>`;
}

document.addEventListener('click', e => {
  const rx = e.target.closest('#rmExamples'); if (rx) { busy(rx, async () => { const r = await api('/examples/remove', { method: 'POST' }); toast(`Removed ${r.removed} example trades`); render(); }); return; }
  const n = e.target.closest('[data-note]'); if (n && n.dataset.note) { e.preventDefault(); openNote(n.dataset.note); return; }
  const g = e.target.closest('[data-go]'); if (g) { go(g.dataset.go); return; }
  const st = e.target.closest('[data-strat]'); if (st) { selected = st.dataset.strat; go('strategies'); }
});
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (views[v] && v !== current) { current = v; render(); } });

/* ---------- PnL calendar ---------- */
function pnlCalendar(trades, month, why = []){
  const now = new Date().toISOString().slice(0, 7), months = [];
  const first0 = [...trades.map(t => String(t.date).slice(0, 7))].sort()[0] || now;
  for (let [y, mo] = first0.split('-').map(Number); `${y}-${String(mo).padStart(2, '0')}` <= (now > first0 ? now : first0); mo === 12 ? (y++, mo = 1) : mo++) months.push(`${y}-${String(mo).padStart(2, '0')}`);
  const m = months.includes(month) ? month : months.at(-1), i = months.indexOf(m);
  const [y, mo] = m.split('-').map(Number), first = new Date(Date.UTC(y, mo - 1, 1)), days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const byDay = {}; for (const t of trades) { const d = String(t.date).slice(0, 10); if (d.startsWith(m)) { const x = byDay[d] ||= { pnl: 0, n: 0 }; x.pnl += t.pnl; x.n++; } }
  const vals = Object.values(byDay), maxAbs = Math.max(1, ...vals.map(v => Math.abs(v.pnl))), tot = vals.reduce((a, v) => a + v.pnl, 0), n = vals.reduce((a, v) => a + v.n, 0);
  const lead = (first.getUTCDay() + 6) % 7, cells = [];
  for (let k = 0; k < lead; k++) cells.push('<div class="cd empty"></div>');
  for (let d = 1; d <= days; d++) {
    const key = `${m}-${String(d).padStart(2, '0')}`, v = byDay[key], a = v ? .18 + .62 * Math.min(1, Math.abs(v.pnl) / maxAbs) : 0;
    cells.push(`<div class="cd ${v ? (v.pnl >= 0 ? 'up' : 'dn') : ''}" style="${v ? `--a:${a.toFixed(2)}` : ''}"><span class="dn-n">${d}</span>${v ? `<b>${v.pnl >= 0 ? '+' : '−'}$${Math.abs(v.pnl) >= 1000 ? (Math.abs(v.pnl) / 1000).toFixed(1) + 'k' : Math.abs(v.pnl).toFixed(0)}</b><span class="cn">${v.n} trade${v.n > 1 ? 's' : ''}</span>` : ''}</div>`);
  }
  const label = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `<section class="card pcal"><div class="pcal-h"><div><span class="eyebrow">PnL calendar</span><h2>${label}</h2></div>
    <div class="pcal-sum"><span class="num ${cls(tot)}">${money(tot)}</span><span class="sub">${n} trade${n === 1 ? "" : "s"} · ${vals.length} trading day${vals.length === 1 ? "" : "s"}</span></div>
    <div class="row"><button class="btn sm" ${i > 0 ? `data-month="${months[i - 1]}"` : 'disabled'} aria-label="Previous month">←</button><button class="btn sm" ${i < months.length - 1 ? `data-month="${months[i + 1]}"` : 'disabled'} aria-label="Next month">→</button></div></div>
    ${n ? '' : `<p class="pcal-note">No trades closed this month: the rules stayed in cash.${why.length ? ' ' + why.map(esc).join(' ') : ''}</p>`}
    <div class="pcal-g">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="cw">${d}</div>`).join('')}${cells.join('')}</div></section>`;
}

/* ---------- shareable PnL card: counts from 0 to the PnL; PNG or video; your own image or video behind ---------- */
function openShare(trades, month){
  const months = [...new Set(trades.map(t => String(t.date).slice(0, 7)))].sort();
  const st = { period: months.includes(month) ? month : 'all', unit: 'usd', bg: null, bgKind: null, rec: false };
  // % of what: your starting balance, or $5,000 per paper track for the example trades
  let base = 10000; const ex = trades.length && trades.every(t => (t.tags || []).includes('example'));
  if (ex) base = 5000 * new Set(trades.map(t => t.strategy)).size; else api('/rules').then(r => { base = Number(r.starting_balance) || 10000; }).catch(() => {});
  $('#dlgTitle').textContent = 'Share your PnL';
  $('#dlgBody').innerHTML = `<div class="share">
    <canvas id="shareCv" width="1080" height="1350"></canvas>
    <div class="share-c">
      <label>Period<select id="shP"><option value="all">All time</option>${months.slice().reverse().map(m => `<option value="${m}" ${m === st.period ? 'selected' : ''}>${new Date(m + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</option>`).join('')}</select></label>
      <label>Show<select id="shU"><option value="usd">PnL in dollars</option><option value="r">PnL in R</option><option value="pct">Return in %</option></select></label>
      <label>Background<select id="shB"><option value="kairos">Kairos pixels</option><option value="granite">Granite</option><option value="file">My image or video…</option></select></label>
      <input type="file" id="shF" accept="image/*,video/*" hidden>
      <p class="sub" id="shNote">The number counts up from $0. Export a still image, or a video of the count.</p>
      <div class="row"><button class="btn dark" id="shPng">Download image</button><button class="btn" id="shVid">Record video</button></div>
      <button class="btn sm" id="shReplay">Replay</button>
    </div></div>`;
  $('#dlg').showModal();
  const cv = $('#shareCv'), ctx = cv.getContext('2d'), W = 1080, H = 1350;
  const vb = document.querySelector('#kaiVector')?.getAttribute('viewBox')?.split(' ').map(Number) || [0, 0, 32, 32];
  const markD = document.querySelector('#kaiVector path')?.getAttribute('d');
  const kaiImg = new Image(); kaiImg.src = '../assets/kai-mark.png'; // the gradient logo, on a white tile so its navy half stays visible on the dark card
  const data = () => { const ts = trades.filter(t => st.period === 'all' || String(t.date).startsWith(st.period)).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const pnl = ts.reduce((a, t) => a + t.pnl, 0), r = ts.reduce((a, t) => a + (+t.r || 0), 0), w = ts.filter(t => t.pnl > 0).length, gl = -ts.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0), gp = ts.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    let c = 0; const curve = [0, ...ts.map(t => (c += t.pnl))];
    return { ts, pnl, r, pct: pnl / base * 100, wins: w, n: ts.length, pf: gl > 0 ? gp / gl : null, curve }; };
  const ease = t => 1 - Math.pow(1 - t, 3);
  function cover(src, w, h){ const sr = w / h, dr = W / H; let sw = w, sh = h, sx = 0, sy = 0; if (sr > dr) { sw = h * dr; sx = (w - sw) / 2; } else { sh = w / dr; sy = (h - sh) / 2; } ctx.drawImage(src, sx, sy, sw, sh, 0, 0, W, H); }
  function bg(t){
    if (st.bg) { const el = st.bg; if (st.bgKind === 'video') cover(el, el.videoWidth || 1, el.videoHeight || 1); else cover(el, el.naturalWidth, el.naturalHeight);
      const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, 'rgba(10,12,18,.45)'); g.addColorStop(.55, 'rgba(10,12,18,.55)'); g.addColorStop(1, 'rgba(10,12,18,.85)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); return; }
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#2b2e33'); g.addColorStop(1, '#1d1f23'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if ($('#shB').value === 'kairos') { const C = 30; for (let i = 0; i < W / C; i++) for (let j = 0; j < H / C; j++) { const u = i / (W / C), cy = (.3 - u * .16 + .05 * Math.sin(u * 8 + t * 2)) * H, d = Math.abs(j * C - cy) / (H * .1), n = Math.abs(Math.sin(i * 127.1 + j * 311.7) * 43758.5) % 1, v = 1 - d + (n - .5) * .6;
      if (v > .55) { ctx.fillStyle = u > .5 ? '#0055ff' : '#1d3cb0'; ctx.fillRect(i * C + 4, j * C + 4, 20, 20); } else if (v > .3 && n > .45) { ctx.fillStyle = '#97e6ff'; ctx.fillRect(i * C + 9, j * C + 9, 10, 10); } else { ctx.fillStyle = 'rgba(151,230,255,.10)'; ctx.fillRect(i * C + 13, j * C + 13, 3, 3); } } }
  }
  function frame(p){ // p: 0..1 count progress
    const d = data(), k = ease(Math.min(1, p)); bg(p);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic';
    if (kaiImg.complete && kaiImg.naturalWidth) { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(74, 80, 68, 68, 16); ctx.fill(); ctx.drawImage(kaiImg, 84, 90, 48, 48); ctx.fillStyle = '#fff'; }
    else if (markD) { ctx.save(); ctx.translate(80, 86); ctx.scale(56 / vb[2], 56 / vb[3]); ctx.translate(-vb[0], -vb[1]); ctx.fill(new Path2D(markD), 'evenodd'); ctx.restore(); }
    ctx.font = '600 46px Geist, system-ui, sans-serif'; ctx.fillText('kairos', 160, 130);
    ctx.font = '500 26px "Geist Mono", monospace'; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.fillText((st.period === 'all' ? 'ALL TIME' : new Date(st.period + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase()) + ' · PNL', W - 80, 126); ctx.textAlign = 'left';
    const val = st.unit === 'usd' ? d.pnl : st.unit === 'r' ? d.r : d.pct, cur = val * k;
    const txt = st.unit === 'usd' ? `${cur >= 0 ? '+' : '−'}$${Math.abs(cur).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : st.unit === 'r' ? `${cur >= 0 ? '+' : '−'}${Math.abs(cur).toFixed(2)}R` : `${cur >= 0 ? '+' : '−'}${Math.abs(cur).toFixed(2)}%`;
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = '500 30px "Geist Mono", monospace'; ctx.fillText(st.unit === 'pct' ? 'RETURN' : 'PROFIT AND LOSS', 80, 640);
    let fs = 190; ctx.font = `500 ${fs}px Geist, system-ui, sans-serif`; while (ctx.measureText(txt).width > W - 160 && fs > 80) { fs -= 8; ctx.font = `500 ${fs}px Geist, system-ui, sans-serif`; }
    ctx.fillStyle = val >= 0 ? '#5ee39b' : '#ff6b57'; ctx.fillText(txt, 72, 640 + fs * .95);
    // curve drawn as the number counts
    const cx = 80, cy = 940, cw = W - 160, ch = 190, c = d.curve, lo = Math.min(...c), hi = Math.max(...c), span = hi - lo || 1, upto = Math.max(1, Math.round((c.length - 1) * k));
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.setLineDash([6, 8]); ctx.beginPath(); const zy = cy + ch - (0 - lo) / span * ch; ctx.moveTo(cx, zy); ctx.lineTo(cx + cw, zy); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = val >= 0 ? '#5ee39b' : '#ff6b57'; ctx.lineWidth = 5; ctx.lineJoin = 'round'; ctx.beginPath();
    for (let i = 0; i <= upto; i++) { const x = cx + (c.length > 1 ? i / (c.length - 1) : 0) * cw, y = cy + ch - (c[i] - lo) / span * ch; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke();
    // stats
    ctx.globalAlpha = Math.min(1, Math.max(0, (p - .55) / .3));
    const stats = [['TRADES', String(d.n)], ['WIN RATE', d.n ? Math.round(d.wins / d.n * 100) + '%' : '—'], ['PROFIT FACTOR', d.pf == null || !d.wins ? '—' : d.pf.toFixed(2)]];
    stats.forEach(([l, v], i) => { const x = 80 + i * 320; ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.font = '500 24px "Geist Mono", monospace'; ctx.fillText(l, x, 1205); ctx.fillStyle = '#fff'; ctx.font = '500 58px Geist, system-ui, sans-serif'; ctx.fillText(v, x, 1270); });
    ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = '500 22px "Geist Mono", monospace'; ctx.fillText('@KairosELY · journal, paper first', 80, 1316);
  }
  let raf = 0, t0 = 0;
  const play = (dur = 2400) => new Promise(done => { cancelAnimationFrame(raf); t0 = performance.now(); const tick = now => { const p = (now - t0 - 300) / dur; frame(Math.max(0, p)); if (p < 1.6) raf = requestAnimationFrame(tick); else { frame(1); done(); } }; raf = requestAnimationFrame(tick); });
  const redraw = () => { cancelAnimationFrame(raf); frame(1); };
  play();
  $('#shP').onchange = e => { st.period = e.target.value; play(); };
  $('#shU').onchange = e => { st.unit = e.target.value; play(); };
  $('#shB').onchange = e => { if (e.target.value === 'file') { $('#shF').click(); return; } st.bg = null; st.bgKind = null; redraw(); };
  $('#shF').onchange = e => { const f = e.target.files[0]; if (!f) return; const url = URL.createObjectURL(f);
    if (f.type.startsWith('video/')) { const v = document.createElement('video'); v.src = url; v.muted = true; v.loop = true; v.playsInline = true; v.oncanplay = () => { st.bg = v; st.bgKind = 'video'; v.play(); play(); }; }
    else { const im = new Image(); im.onload = () => { st.bg = im; st.bgKind = 'image'; play(); }; im.src = url; } };
  $('#shReplay').onclick = () => play();
  const save = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  $('#shPng').onclick = () => { frame(1); cv.toBlob(b => save(b, `kairos-pnl-${st.period}.png`), 'image/png'); };
  $('#shVid').onclick = async e => {
    if (!window.MediaRecorder || !cv.captureStream) return toast('This browser cannot record video. Try Chrome or Edge, or download the image.', true);
    const type = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(x => MediaRecorder.isTypeSupported(x)) || '';
    const rec = new MediaRecorder(cv.captureStream(30), type ? { mimeType: type, videoBitsPerSecond: 6e6 } : undefined), chunks = [];
    rec.ondataavailable = ev => ev.data.size && chunks.push(ev.data);
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Recording…';
    rec.start(); await play(2600); await new Promise(r => setTimeout(r, 900)); rec.stop();
    await new Promise(r => (rec.onstop = r));
    btn.disabled = false; btn.textContent = 'Record video';
    save(new Blob(chunks, { type: type.split(';')[0] || 'video/webm' }), `kairos-pnl-${st.period}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
  };
  $('#dlg').addEventListener('close', () => cancelAnimationFrame(raf), { once: true });
}

let newsSeen = null;
async function watchNews() {
  try {
    const d = await api('/news'), watch = new Set(d.watch.map(a => a.split('-')[0]));
    const nf = d.notify || {}, alerts = d.alerts || [];
    const latest = Math.max(0, ...d.shocks.map(s => s.t), ...alerts.map(a => a.t), ...d.items.filter(i => i.coins.some(c => watch.has(c))).map(i => i.seenAt || 0));
    if (newsSeen === null) { newsSeen = latest; return; }
    const fresh = [
      ...(nf.alerts !== false ? alerts.filter(a => a.t > newsSeen).map(a => `Alert: ${a.asset} ${a.op} ${a.price} (now ${a.firedPrice})${a.note ? ' · ' + a.note : ''}`) : []),
      ...(nf.shocks !== false ? d.shocks.filter(s => s.t > newsSeen).map(s => `Shock ${s.asset} ${s.movePct > 0 ? '+' : ''}${s.movePct}% in ${s.mins || 3} min`) : []),
      ...(nf.headlines !== false ? d.items.filter(i => (i.seenAt || 0) > newsSeen && i.coins.some(c => watch.has(c))).slice(0, 3).map(i => i.title.slice(0, 120)) : [])];
    newsSeen = Math.max(newsSeen, latest);
    for (const msg of fresh) {
      toast(msg);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('Argus · Kairos', { body: msg });
    }
    if (fresh.length && current === 'news') render();
  } catch { /* server restarting */ }
}
setInterval(watchNews, 30000); setTimeout(watchNews, 4000);

async function refreshSettings() { settings = await api('/settings'); renderHeader(); }
async function render(enter = false) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === current));
  view.classList.remove('enter');
  try { await views[current](); if (enter) { void view.offsetWidth; view.classList.add('enter'); } } catch (e) { view.innerHTML = `<div class="banner">${esc(e.message)}</div>`; }
}

(async () => {
  try { await refreshSettings(); } catch (e) { view.innerHTML = `<div class="banner">Cannot reach the local server: ${esc(e.message)}</div>`; return; }
  await refreshGate();
  const h = location.hash.slice(1); if (views[h]) current = h;
  render();
  setInterval(() => { if (current === 'overview' && !document.hidden) render(); }, 30000);
})();
