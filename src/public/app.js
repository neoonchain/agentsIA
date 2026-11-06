// Kairos workspace UI. Everything model- or vault-generated is escaped before rendering.
const $ = s => document.querySelector(s);
const view = $('#view');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
}
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
  if (settings.hasApiKey) { k.className = 'keypill ok'; k.textContent = 'OpenRouter ' + settings.apiKeyHint; }
  else if (settings.freeAvailable) { const left = Math.max(settings.freeLimit - settings.freeUsed, 0); k.className = 'keypill' + (left ? '' : ' warn'); k.textContent = `${left}/${settings.freeLimit} free left`; }
  else { k.className = 'keypill warn'; k.textContent = 'Add API key'; }
}
$('#keyPill').onclick = () => go('team');
$('#modeSeg').onclick = async e => {
  const m = e.target.closest('button')?.dataset.mode; if (!m || m === settings.mode) return;
  try { settings = await api('/settings', { method: 'PUT', body: { mode: m } }); renderHeader(); toast(m === 'team' ? 'Team mode: models split roles and review each other' : 'Solo mode: one model does everything'); if (current === 'team') render(); }
  catch (er) { fail(er); }
};
$('#tabs').onclick = e => { const v = e.target.closest('button')?.dataset.v; if (v) go(v); };
function go(v) { current = v; location.hash = v; render(true); }

/* ---------- views ---------- */
const views = {
  async overview() {
    const s = await api('/status'); const j = s.journal;
    const free = !settings.hasApiKey;
    view.innerHTML = `
      <div class="head"><div><h1>Overview</h1><p>${settings.web ? `Vault: ${esc(settings.vaultLabel)}.` : `Vault: <span class="mono">${esc(s.vault)}</span> · open it in Obsidian as a vault.`}</p></div>
        <div class="row"><button class="btn" data-go="journal">Log a trade</button><button class="btn dark" data-go="ask">Ask the ${settings.mode === 'team' ? 'team' : 'model'}</button></div></div>
      ${settings.web ? `<div class="banner info">Web version: running strategies trade on paper while this tab is open. For 24/7 paper trading and real money on Kraken, use the <a href="/#get">desktop app</a>.</div>` : ''}
      ${free ? `<div class="banner ${settings.freeAvailable ? 'info' : ''}">${settings.freeAvailable ? `You have <b>${Math.max(settings.freeLimit - settings.freeUsed, 0)} of ${settings.freeLimit}</b> free instructions (Ask or Analyse). After that, and for paper trading, add your own OpenRouter API key in <a href="#team">Team</a>.` : `Add your OpenRouter API key in <a href="#team">Team</a> to use the models. Journaling works without it.`}</div>` : ''}
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
        <div class="card"><h2 style="margin-bottom:8px">Activity</h2><div class="feed">${s.activity.length ? s.activity.map(a => `<div><time>${ago(a.at)}</time><span>${md(a.msg).replace(/<\/?p>/g, '')}</span></div>`).join('') : '<p class="empty">Nothing yet this session. Full history is in the vault\'s Log folder.</p>'}</div></div>
      </div>`;
  },

  async journal() {
    const trades = await api('/journal');
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
    const shown = trades.slice().reverse().filter(t => filt === 'all' || (filt === 'wins' ? t.pnl > 0 : filt === 'losses' ? t.pnl < 0 : !!t.image));
    view.innerHTML = `
      <div class="head"><div><h1>Journal</h1><p>Every trade is a note in <span class="mono">Trades/</span> with its screenshot in <span class="mono">Attachments/</span>. Obsidian shows both; Analyse lets the models look at your charts.</p></div>
        <button class="btn dark" id="newTrade">${trades.length ? 'Log a trade' : 'Log your first trade'}</button></div>
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
      ${trades.length ? `<div class="row jfilter" id="jfilter">${[['all', 'All'], ['wins', `Wins · ${wins.length}`], ['losses', `Losses · ${losses.length}`], ['shots', 'With screenshot']].map(([k, l]) => `<button class="chipbtn ${filt === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>` : ''}
      <div class="jgrid">${shown.map(t => `
        <article class="jcard ${t.pnl > 0 ? 'win' : t.pnl < 0 ? 'loss' : ''}" data-note="${esc(t.path)}">
          <div class="jthumb" ${t.image ? `data-img="${esc(t.image)}"` : ''}>${t.image ? '' : `<span class="jph">${esc(t.asset.split('-')[0] || '—')}</span>`}
            <span class="jside ${t.side}">${esc(t.side)}</span></div>
          <div class="jbody">
            <div class="row" style="justify-content:space-between"><b>${esc(t.asset)}</b><span class="num ${cls(t.pnl)}">${money(t.pnl)}${t.r != null ? ` · ${t.r > 0 ? '+' : ''}${t.r}R` : ''}</span></div>
            <p class="sub">${esc(t.date)}${t.strategy ? ` · ${esc(t.strategy)}` : ''}</p>
            ${t.thesis ? `<p class="jthesis">${esc(t.thesis.slice(0, 120))}${t.thesis.length > 120 ? '…' : ''}</p>` : ''}
            <div class="row" style="gap:6px">${t.emotion ? `<span class="chip">${esc(t.emotion.slice(0, 28))}</span>` : ''}${t.tags.slice(0, 3).map(x => `<span class="chip">#${esc(x)}</span>`).join('')}</div>
          </div>
        </article>`).join('') || (trades.length ? '<p class="empty">No trades match this filter.</p>' : '')}</div>`;

    // thumbnails load after the grid is on screen
    view.querySelectorAll('.jthumb[data-img]').forEach(async el => { try { el.style.backgroundImage = `url("${await imageUrl(el.dataset.img)}")`; el.classList.add('has'); } catch { /* moved or deleted */ } });
    const f = $('#tradeForm');
    f.date.value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    $('#newTrade').onclick = () => { f.hidden = false; f.scrollIntoView({ behavior: 'smooth', block: 'start' }); f.asset.focus(); };
    $('#cancelTrade').onclick = () => { f.hidden = true; };
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
    const team = settings.mode === 'team';
    view.innerHTML = `
      <div class="head"><div><h1>Ask the ${team ? 'team' : 'model'}</h1><p>${team ? `The lead (${esc(settings.catalog.models[settings.roles.lead].label)}) answers from your journal and ${settings.enabledRoles.reviewer ? `${esc(settings.catalog.models[settings.roles.reviewer].label)} checks it; if it disagrees, the answer is revised.` : 'no reviewer is enabled.'}` : `${esc(settings.catalog.models[settings.soloModel].label)} answers on its own.`} Switch Team / Solo at the top.</p></div></div>
      <div class="card soft"><textarea id="q" placeholder="Where do I lose the most money? What should my rules be after two losses?" style="min-height:96px"></textarea>
        <div class="row" style="margin-top:12px"><button class="btn dark" id="askBtn" data-busy="Thinking">Ask</button><button class="btn" id="anBtn" data-busy="Analysing">Analyse my whole journal</button>
        <span class="sub">Analyse writes an insight note and a draft strategy into your vault.</span></div></div>
      <div id="out"></div>`;
    const show = r => {
      $('#out').innerHTML = `<div class="answer"><span class="eyebrow">${r.mode === 'team' ? 'Team answer' : 'Solo answer'}</span><div class="md" style="margin-top:8px">${md(r.answer || '')}</div>
        ${r.insight ? `<div class="row" style="margin-top:14px"><button class="btn sm" data-note="${esc(r.insight)}">Open insight note</button>${r.strategy ? `<button class="btn sm" data-note="${esc(r.strategy)}">Open draft strategy</button>` : ''}</div>` : ''}
        <div class="steps">${r.steps.map(s => `<details><summary>${esc(s.role)} · ${esc(s.model)}</summary><pre>${esc(s.text)}</pre></details>`).join('')}</div></div>`;
    };
    $('#askBtn').onclick = e => busy(e.currentTarget, async () => { const q = $('#q').value.trim(); if (!q) return toast('Write a question first', true); show(await api('/ask', { method: 'POST', body: { question: q } })); await refreshSettings(); });
    $('#anBtn').onclick = e => busy(e.currentTarget, async () => { const r = await api('/analyse', { method: 'POST' }); r.answer = `Analysis saved to **${r.insight}**.${r.strategy ? ` A draft strategy was written to **${r.strategy}**: review it, set \`draft: false\`, then start it on paper.` : ''}${r.review ? `\n\nSecond opinion: ${r.review.agree ? 'agrees' : 'disagrees'}.${(r.review.issues || []).map(i => '\n- ' + i).join('')}` : ''}`; show(r); await refreshSettings(); });
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
        <div class="card"><h3>Shocks</h3>${d.shocks.length ? `<div class="shocks">${d.shocks.slice(0, 8).map(s => `<div class="shock ${s.dir}"><b class="mono">${esc(s.asset)}</b><span class="num ${s.movePct > 0 ? 'pos' : 'neg'}">${s.movePct > 0 ? '+' : ''}${s.movePct}% in ${s.mins || 3} min</span><span class="sub">volume ${s.volX}× · ${agoS(s.t)} ago</span></div>`).join('')}</div>` : '<p class="empty">No shocks yet. The watched coins are calm.</p>'}
          ${Object.keys(d.guards).length ? `<p class="sub" style="margin-top:10px">Guard active: ${Object.entries(d.guards).map(([a, g]) => `${esc(a)} until ${new Date(g.until).toLocaleTimeString()}`).join(' · ')}</p>` : ''}
          <p class="sub" style="margin-top:12px">Watching: ${d.watch.map(a => `<span class="chip">${esc(a)}</span>`).join(' ')}</p></div>
        <div class="card"><h3>Sources</h3><div class="srcs">${Object.entries(d.status).map(([k, s]) => `<div><span class="dot ${s.ok ? 'ok' : 'bad'}"></span><b>${esc(k)}</b><span class="sub">${s.ok ? `checked ${agoS(s.at)} ago` : esc(s.error)}</span></div>`).join('') || '<p class="empty">Starting…</p>'}</div></div>
      </div>
      <div class="row jfilter" style="margin-top:18px" id="nfilter"><button class="chipbtn ${onlyWatched ? 'on' : ''}" data-o="1">Watched coins</button><button class="chipbtn ${onlyWatched ? '' : 'on'}" data-o="0">Everything</button><span class="sub">${items.length} items</span></div>
      <div class="feedlist">${items.slice(0, 80).map(i => `<a class="nitem" ${i.url ? `href="${esc(i.url)}" target="_blank" rel="noopener noreferrer"` : ''}><span class="t mono">${agoS(i.time)}</span><span class="s">${esc(i.source)}</span><span class="h">${esc(i.title)}</span><span class="c">${i.coins.map(c => `<span class="chip ${watch.has(c) ? 'ok' : ''}">${esc(c)}</span>`).join('')}</span></a>`).join('') || '<p class="empty">Nothing about the watched coins yet.</p>'}</div>
      <div class="grid g2" style="margin-top:22px">
        <div class="card"><h3>Settings</h3>
          <label class="check" style="margin-top:10px"><input type="checkbox" id="nTree" ${ns.tree ? 'checked' : ''}> Tree of Alpha: tweets and headlines, seconds old, free</label>
          <label class="check"><input type="checkbox" id="nRss" ${ns.rss ? 'checked' : ''} ${web ? 'disabled' : ''}> RSS: Cointelegraph, The Block ${web ? '(desktop app only)' : ''}</label>
          <label class="check"><input type="checkbox" id="nX" ${ns.x ? 'checked' : ''}> X API (your key, every 60 s)</label>
          <label style="margin-top:10px">X bearer token ${ns.hasXBearer ? '(saved)' : ''}<input id="nXKey" type="password" placeholder="${ns.hasXBearer ? '•••••••• saved' : 'AAAA…'}" autocomplete="off"></label>
          <label>X search query<input id="nXQ" value="${esc(ns.xQuery)}" class="mono"></label>
          <label>Watch these coins (besides running strategies)<input id="nWatch" value="${esc(ns.watch.join(', '))}" class="mono"></label>
          <div class="row" style="margin-top:12px"><button class="btn dark" id="nSave">Save</button></div></div>
        <div class="card"><h3>Forward any alert here</h3>
          ${web ? '<p class="sub" style="margin-top:8px">The web version has no server to receive alerts. Use the desktop app for the incoming URL.</p>' : `
          <p class="sub" style="margin:8px 0 12px">Anything that can call a URL can feed the agents: a j7tracker → Telegram/Discord forwarder, TradingView alerts, n8n, Zapier. To receive from the internet, expose this computer with a tunnel (for example <span class="mono">cloudflared tunnel --url http://localhost:4317</span>) and use that address.</p>
          <label>URL<input readonly value="${esc(hookUrl)}" class="mono"></label>
          <label>Token (header X-Kairos-Token)<input readonly value="${esc(ns.webhookToken)}" class="mono"></label>
          <pre class="curl">curl -X POST ${esc(hookUrl)} \\
  -H "Content-Type: application/json" \\
  -H "X-Kairos-Token: ${esc(ns.webhookToken)}" \\
  -d '{"title":"$PEPE: big account just tweeted","source":"j7tracker"}'</pre>
          <div class="row"><button class="btn sm" id="nTest">Send a test alert</button><button class="btn sm" id="nRotate">New token</button></div>`}</div>
      </div>`;
    $('#nfilter').onclick = e => { const b = e.target.closest('[data-o]'); if (b) { views.news.only = b.dataset.o === '1'; render(); } };
    $('#notify').onclick = async () => { if (typeof Notification === 'undefined') return toast('This browser has no notifications', true); toast((await Notification.requestPermission()) === 'granted' ? 'Notifications on' : 'Notifications blocked', false); render(); };
    $('#nSave').onclick = () => busy($('#nSave'), async () => {
      const body = { tree: $('#nTree').checked, rss: $('#nRss').checked, x: $('#nX').checked, xQuery: $('#nXQ').value, watch: $('#nWatch').value.split(',') };
      if ($('#nXKey').value.trim()) body.xBearer = $('#nXKey').value.trim();
      await api('/news/settings', { method: 'PUT', body }); toast('News settings saved'); render();
    });
    if ($('#nTest')) $('#nTest').onclick = async () => { await api('/news/test', { method: 'POST' }); toast('Test alert added'); render(); };
    if ($('#nRotate')) $('#nRotate').onclick = async () => { if (!confirm('Make a new token? Forwarders using the old one stop working.')) return; await api('/news/settings', { method: 'PUT', body: { rotateToken: true } }); render(); };
  },

  async rules() {
    const r = await api('/rules');
    const label = { starting_balance: 'Paper starting balance (USD)', min_trades: 'Mark · minimum paper trades', min_days: 'Mark · minimum days on paper', min_profit_factor: 'Mark · minimum profit factor',
      max_drawdown_pct: 'Mark & limit · max drawdown %', min_adherence_pct: 'Mark · follows strategy %', daily_loss_pct: 'Limit · daily loss %', max_risk_per_trade_pct: 'Limit · max risk per trade %',
      fee_pct: 'Paper fee % per side', slippage_pct: 'Paper slippage %', first_tier_usd: 'First real-money tier (USD)', min_24h_volume_usd: 'Real money · min 24h volume (USD)', max_spread_pct: 'Real money · max spread %' };
    view.innerHTML = `<div class="head"><div><h1>Marks and limits</h1><p>Stored in <span class="mono">rules.md</span> in your vault. Models read it but can never change it. Brake enforces the limits in code.</p></div></div>
      <form class="card soft form" id="rf">${Object.entries(r).map(([k, v]) => `<label>${esc(label[k] || k)}<input name="${esc(k)}" type="number" step="any" min="0" value="${esc(v)}"></label>`).join('')}
      <div class="w4"><button class="btn dark">Save rules</button></div></form>`;
    $('#rf').onsubmit = async e => { e.preventDefault(); try { await api('/rules', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('Rules saved'); } catch (er) { fail(er); } };
  },

  async team() {
    const c = settings, M = c.catalog.models, R = c.catalog.roles;
    const opts = sel => Object.entries(M).map(([k, m]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
    view.innerHTML = `<div class="head"><div><h1>Team settings</h1><p>All models go through OpenRouter with one key. Choose whether they work as a team or one model works alone.</p></div></div>
      <div class="grid g2">
        <div class="card"><h2>How the models work</h2>
          <div class="row" style="margin:14px 0"><label class="check"><input type="radio" name="mode" value="team" ${c.mode === 'team' ? 'checked' : ''}> <b>Team</b>: each model takes a role and a second model reviews every trade</label></div>
          <div class="row"><label class="check"><input type="radio" name="mode" value="solo" ${c.mode === 'solo' ? 'checked' : ''}> <b>Solo</b>: one model does everything</label><select id="soloModel" style="width:auto">${opts(c.soloModel)}</select></div>
          <label class="check" style="margin-top:16px"><input type="checkbox" id="web" ${c.webSearch ? 'checked' : ''}> Allow web search for Market context and Sentiment (extra OpenRouter cost)</label>
        </div>
        <div class="card"><h2>OpenRouter API key</h2><p class="sub" style="margin:8px 0 12px">${c.hasApiKey ? `Saved (${esc(c.apiKeyHint)}). Stored only on this computer in <span class="mono">~/.kairos/config.json</span>, never in the vault.` : c.freeAvailable ? `You are on the free trial: ${Math.max(c.freeLimit - c.freeUsed, 0)} of ${c.freeLimit} instructions left. Paper trading needs your own key.` : 'Needed to use the models. Get one at openrouter.ai/keys.'}</p>
          <div class="row"><input id="key" type="password" placeholder="sk-or-..." autocomplete="off" style="flex:1"><button class="btn dark" id="saveKey">Save key</button>${c.hasApiKey ? '<button class="btn red" id="delKey">Remove</button>' : ''}</div>
          ${c.web ? `<p class="sub" style="margin-top:16px">Vault: <b>${esc(c.vaultLabel)}</b></p><div class="row" style="margin-top:8px"><button class="btn sm" id="zipVault">Export vault (.zip)</button><button class="btn sm" id="switchVault">Use another place</button></div>`
            : `<label style="margin-top:16px">Vault folder<input id="vault" value="${esc(c.vaultPath)}"></label><button class="btn sm" id="saveVault" style="margin-top:8px">Change vault</button>`}</div>
      </div>
      ${c.web ? `<div class="card" style="margin-top:16px"><h2>Kraken · real money</h2><p class="sub" style="margin-top:8px">Real money runs only in the <a href="/#get">desktop app</a>, so your Kraken key never sits in a web page.</p></div>` : `<div class="card" style="margin-top:16px"><h2>Kraken · real money</h2>
        <p class="sub" style="margin:8px 0 12px">${c.hasKraken ? `Connected (${esc(c.krakenHint)}), checked ${esc(String(c.krakenCheckedAt).slice(0, 10))}: can trade, cannot withdraw.` : 'On Kraken: Settings → API → Create key. Enable only <b>Query Funds</b>, <b>Query Open/Closed Orders & Trades</b>, <b>Create & Modify Orders</b> and <b>Cancel/Close Orders</b>. Never enable Withdraw: the app refuses keys that can.'} Keys stay on this computer only.</p>
        <div class="row"><input id="krKey" placeholder="API key" autocomplete="off" style="flex:1"><input id="krSecret" type="password" placeholder="Private key" autocomplete="off" style="flex:1"><button class="btn dark" id="saveKr" data-busy="Checking key">Connect</button>${c.hasKraken ? '<button class="btn red" id="delKr">Remove</button>' : ''}</div></div>`}
      <div class="card" style="margin-top:16px"><h2>Roles</h2><p class="sub" style="margin:6px 0 12px">Used in Team mode. Lead is always on. Brake (risk) is code, not a model.</p>
        <div class="tblwrap"><table><tr><th>On</th><th>Role</th><th>What it does</th><th>Model</th></tr>
        ${Object.entries(R).map(([k, r]) => `<tr><td><input type="checkbox" data-role-on="${k}" ${c.enabledRoles[k] ? 'checked' : ''} ${k === 'lead' ? 'disabled' : ''} style="width:auto"></td><td><b>${esc(r.label)}</b></td><td class="sub">${esc(r.desc)}</td><td><select data-role="${k}">${opts(c.roles[k])}</select></td></tr>`).join('')}</table></div></div>
      <details class="card soft" style="margin-top:16px"><summary style="cursor:pointer;font-weight:600">OpenRouter model IDs</summary><div class="form" style="margin-top:12px">
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

async function renderStrategy(name) {
  const box = $('#sdetail');
  let s; try { s = await api('/strategies/' + encodeURIComponent(name)); } catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }
  const a = s.account, ev = s.evaluation, m = ev.metrics, running = s.status === 'running', p = s.promotion;
  const pos = Object.values(a.positions);
  box.innerHTML = `
    <div class="card"><div class="head" style="margin-bottom:12px"><div><h2>${esc(s.name)} ${chip({ ...s, paused: a.paused, promotion: p?.status })}</h2>
      <p class="sub" style="margin-top:6px">${esc(s.assets.join(', '))} · hours ${esc(s.hours_utc || 'any')} UTC · risk ${esc(s.risk_per_trade_pct)}% · decides every ${esc(s.interval_min || 60)} min${a.lastDecisionAt ? ` · last decision ${agoText(a.lastDecisionAt)}` : ''}</p>
      ${a.paused ? `<p class="sub neg" style="margin-top:4px">Paused: ${esc(a.paused.reason)}</p>` : ''}</div>
      <div class="row">${running ? '<button class="btn" data-act="stop">Stop</button>' : `<button class="btn dark" data-act="start" ${s.draft ? 'disabled title="Draft: set draft: false in the note first"' : ''}>Start on paper</button>`}
        <button class="btn" data-act="run" data-busy="Deciding">Run a decision now</button>${pos.length ? '<button class="btn red" data-act="close-all">Close all & stop</button>' : '<button class="btn sm" data-act="reset">Reset account</button>'}
        <button class="btn sm" data-note="${esc(s.path)}">Open note</button></div></div>
      <div class="grid g4">
        <div class="stat"><span class="eyebrow">Paper equity</span><div class="n">$${s.equity.toLocaleString('en-US')}</div></div>
        <div class="stat"><span class="eyebrow">Closed trades</span><div class="n">${m.count}</div></div>
        <div class="stat"><span class="eyebrow">PnL</span><div class="n ${cls(m.totalPnl)}">${money(m.totalPnl)}</div></div>
        <div class="stat"><span class="eyebrow">Max drawdown</span><div class="n">${m.maxDrawdownPct}%</div></div></div></div>
    <div id="decision"></div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h3>Your marks</h3><div class="checks" style="margin-top:8px">${ev.checks.map(c => `<div class="c ${c.pass ? 'pass' : 'fail'}"><span>${esc(c.label)}</span><span>${esc(c.value)} ${c.pass ? '✓' : '✗'}</span></div>`).join('')}</div>
        <div class="row" style="margin-top:14px">${p?.status === 'requested' ? `<span class="sub">Requested $${esc(p.tierUsd)} of real capital.</span><button class="btn dark sm" data-promo="approve">Approve</button><button class="btn sm" data-promo="reject">Reject</button>`
          : p?.status === 'approved' ? `<span class="chip ok">approved</span><span class="sub">$${esc(p.tierUsd)} tier approved. Go live in the Real money panel below.</span>`
          : `<button class="btn sm" data-promo="request" ${ev.eligible ? '' : 'disabled'}>Request real capital</button><span class="sub">${ev.eligible ? 'All marks beaten.' : 'Available once every mark is beaten.'}</span>`}</div></div>
      <div class="card"><h3>Open positions</h3>${pos.length ? `<table style="margin-top:8px"><tr><th>Asset</th><th>Side</th><th>Entry</th><th>Stop</th><th>TP</th><th>Now</th></tr>${pos.map(x => `<tr class="click" data-note="${esc(x.notePath)}"><td>${esc(x.asset)}</td><td>${esc(x.side)}</td><td class="num">${fp(x.entry)}</td><td class="num">${fp(x.stop)}</td><td class="num">${fp(x.takeProfit)}</td><td class="num">${fp(s.prices[x.asset])}</td></tr>`).join('')}</table>` : '<p class="empty">No open positions.</p>'}</div>
    </div>
    ${p?.status === 'approved' || s.live ? liveCard(s) : ''}
    <div class="card lessons" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h3>Lessons learned</h3><span class="sub">Written after every close · read before every decision · <a href="#" data-note="${esc('Lessons/' + s.name + '.md')}">open note</a></span></div>
      ${s.lessons?.length ? s.lessons.map(l => `<div class="lesson ${/· -/.test(l.title) ? 'loss' : 'win'}"><b class="mono">${esc(l.title)}</b><ul>${l.lines.filter(x => !x.startsWith('Thesis')).map(x => `<li>${md(x).replace(/<\/?p>/g, '')}</li>`).join('')}</ul></div>`).join('') : '<p class="empty">No closed trades yet. Each one will leave a lesson here.</p>'}</div>
    <div class="card" style="margin-top:16px"><h3>Closed paper trades</h3>${a.trades.length ? `<div class="tblwrap"><table style="margin-top:8px"><tr><th>Closed</th><th>Asset</th><th>Side</th><th>Entry</th><th>Exit</th><th>PnL</th><th>R</th><th>Reason</th><th>Models</th></tr>
      ${a.trades.slice().reverse().map(t => `<tr class="click" data-note="${esc(t.notePath || '')}"><td class="num">${esc(String(t.closedAt).slice(0, 16).replace('T', ' '))}</td><td>${esc(t.asset)}</td><td>${esc(t.side)}</td><td class="num">${fp(t.entry)}</td><td class="num">${fp(t.exit)}</td><td class="num ${cls(t.pnl)}">${money(t.pnl)}</td><td class="num ${cls(t.r)}">${t.r}</td><td>${esc(t.reason)}</td><td class="sub">${esc([t.proposer, t.reviewer].filter(Boolean).join(' + '))}</td></tr>`).join('')}</table></div>` : '<p class="empty">No closed trades yet.</p>'}</div>`;
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
  if (settings.web) return `<div class="card" style="margin-top:16px">${head}</div><div class="banner info">Approved. Real money runs only in the <a href="/#get">desktop app</a>: open this vault there to go live on Kraken.</div></div>`;
  if (!s.exchange.connected) return `<div class="card" style="margin-top:16px">${head}</div><div class="banner info">Connect a Kraken API key in <a href="#team">Team</a> first (trade-only, no withdrawals).</div></div>`;
  if (!on) return `<div class="card" style="margin-top:16px">${head}<div class="row"><button class="btn" data-live="validate" data-busy="Checking">Go live · validate mode</button><button class="btn dark" data-live="real" data-busy="Checking">Go live · real money</button></div></div>
    <p class="sub">${l?.stoppedReason ? `Last live run stopped: ${esc(l.stoppedReason)}. ` : ''}Validate mode sends every order to Kraken for checking but executes nothing. Start there.</p></div>`;
  const m = l.metrics, pos = Object.values(l.account.positions);
  return `<div class="card" style="margin-top:16px;border-color:${l.mode === 'real' ? 'var(--lime-ink)' : 'var(--blue)'}">${head}<button class="btn red" data-live="off" data-busy="Closing">Back to paper</button></div>
    ${l.account.paused ? `<div class="banner">Paused until tomorrow: ${esc(l.account.paused.reason)}</div>` : ''}
    <div class="grid g4"><div class="stat"><span class="eyebrow">Allocation</span><div class="n">$${esc(l.allocationUsd)}</div></div><div class="stat"><span class="eyebrow">Live equity</span><div class="n">$${l.equity.toLocaleString('en-US')}</div></div>
      <div class="stat"><span class="eyebrow">Live PnL</span><div class="n ${cls(m.totalPnl)}">${money(m.totalPnl)}</div></div><div class="stat"><span class="eyebrow">Live trades</span><div class="n">${m.count}</div></div></div>
    ${pos.length ? `<table style="margin-top:14px"><tr><th>Asset</th><th>Qty</th><th>Entry</th><th>Stop on Kraken</th><th>TP</th><th>Bid</th></tr>${pos.map(x => `<tr class="click" data-note="${esc(x.notePath)}"><td>${esc(x.asset)}</td><td class="num">${fp(x.qty)}</td><td class="num">${fp(x.entry)}</td><td class="num">${fp(x.stop)} <span class="sub">${esc(x.stopTxid || (x.mode === 'validate' ? 'simulated' : ''))}</span></td><td class="num">${fp(x.takeProfit)}</td><td class="num">${fp(l.prices[x.asset])}</td></tr>`).join('')}</table>` : '<p class="empty">No live positions.</p>'}
    ${l.account.trades.length ? `<div class="tblwrap"><table style="margin-top:10px"><tr><th>Closed</th><th>Asset</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Reason</th></tr>${l.account.trades.slice().reverse().map(t => `<tr class="click" data-note="${esc(t.notePath || '')}"><td class="num">${esc(String(t.closedAt).slice(0, 16).replace('T', ' '))}</td><td>${esc(t.asset)}</td><td class="num">${fp(t.entry)}</td><td class="num">${fp(t.exit)}</td><td class="num ${cls(t.pnl)}">${money(t.pnl)}</td><td>${esc(t.reason)}</td></tr>`).join('')}</table></div>` : ''}</div>`;
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
  const n = e.target.closest('[data-note]'); if (n && n.dataset.note) { e.preventDefault(); openNote(n.dataset.note); return; }
  const g = e.target.closest('[data-go]'); if (g) { go(g.dataset.go); return; }
  const st = e.target.closest('[data-strat]'); if (st) { selected = st.dataset.strat; go('strategies'); }
});
window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (views[v] && v !== current) { current = v; render(); } });

let newsSeen = null;
async function watchNews() {
  try {
    const d = await api('/news'), watch = new Set(d.watch.map(a => a.split('-')[0]));
    const latest = Math.max(0, ...d.shocks.map(s => s.t), ...d.items.filter(i => i.coins.some(c => watch.has(c))).map(i => i.seenAt || 0));
    if (newsSeen === null) { newsSeen = latest; return; }
    const fresh = [...d.shocks.filter(s => s.t > newsSeen).map(s => `Shock ${s.asset} ${s.movePct > 0 ? '+' : ''}${s.movePct}% in ${s.mins || 3} min`),
      ...d.items.filter(i => (i.seenAt || 0) > newsSeen && i.coins.some(c => watch.has(c))).slice(0, 3).map(i => i.title.slice(0, 120))];
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
  const h = location.hash.slice(1); if (views[h]) current = h;
  render();
  setInterval(() => { if (current === 'overview' && !document.hidden) render(); }, 30000);
})();
