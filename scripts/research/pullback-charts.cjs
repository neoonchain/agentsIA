// One chart per Pullback track trade (1280x720 webp) from Hyperliquid daily candles, into assets/.
//   node pullback-charts.cjs   (after build-pullback.mjs, which saves pullback-daily.json next to this file)
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const DAILY = path.join(__dirname, 'pullback-daily.json'), TRACKJS = path.join(__dirname, '../../src/lib/examples-pullback.js'), OUT = path.join(__dirname, '../../assets');
const raw = JSON.parse(fs.readFileSync(DAILY, 'utf8'));
const daily = Object.fromEntries(Object.entries(raw).map(([a, c]) => [a, c.filter(x => { const d = new Date(x.t).getUTCDay(); return d && d !== 6; })]));
const TRACK = JSON.parse(fs.readFileSync(TRACKJS, 'utf8').match(/export const PULLBACK_TRACK = (\[[\s\S]*?\]);\n/)[1]);
const NAME = { 'XYZ100-XYZ': 'Nasdaq 100', 'GOLD-XYZ': 'Gold' };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await p.setContent('<body style="margin:0;background:#0b1020"><canvas id=c width=1280 height=720></canvas></body>');
  for (let k = 0; k < TRACK.length; k++) {
    const [asset, opened, closed, entry, stop, exit, qty, pnl, r, why, , fees, ctx] = TRACK[k];
    const all = daily[asset], o = Date.parse(opened), c = Date.parse(closed);
    const idx = all.findIndex(x => x.t >= o), ci = all.findIndex(x => x.t >= c);
    const from = Math.max(0, idx - Math.max(40, 70 - (ci - idx))), to = Math.min(all.length, ci + 10);
    const cl = all.map(x => x.close), sma = (i, n) => i >= n - 1 ? cl.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n : null;
    const candles = all.slice(from, to).map((x, j) => ({ ...x, a: sma(from + j, 200) }));
    const cfg = { name: NAME[asset], entry, stop, exit, pnl, r, why, opened, closed, qty, signal: ctx.signalT, vs: ctx.vsAvg, low7: ctx.low7, stopPct: Math.round((1 - stop / entry) * 100), fees };
    const url = await p.evaluate(({ c, cfg }) => {
      const cv = document.getElementById('c'), g = cv.getContext('2d'), W = 1280, H = 720, L = 56, R = 1150, T = 74, B = 630;
      g.fillStyle = '#0b1020'; g.fillRect(0, 0, W, H);
      const lo = Math.min(...c.map(x => x.low), cfg.stop, ...c.map(x => x.a || Infinity)) * .995, hi = Math.max(...c.map(x => x.high), ...c.map(x => x.a || 0)) * 1.005;
      const y = v => B - (v - lo) / (hi - lo) * (B - T), step = (R - L) / c.length, x = i => L + step * (i + .5);
      const fmt = v => v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2);
      g.font = '13px monospace'; g.strokeStyle = 'rgba(255,255,255,.06)';
      const tags = [cfg.stop, cfg.entry].map(y);
      for (let k = 0; k <= 5; k++) { const v = lo + (hi - lo) * k / 5, yy = y(v); g.beginPath(); g.moveTo(L, yy); g.lineTo(R, yy); g.stroke(); if (!tags.some(t => Math.abs(t - yy) < 18)) { g.fillStyle = '#6b7493'; g.fillText(fmt(v), R + 10, yy + 4); } }
      c.forEach((d, i) => { if (i % 10 === 0) { g.fillStyle = '#6b7493'; g.fillText(new Date(d.t).toISOString().slice(5, 10), x(i) - 18, B + 24); } });
      const si = c.findIndex(d => d.t === cfg.signal), ei = c.findIndex(d => d.t >= Date.parse(cfg.opened)), xi = c.findIndex(d => d.t >= Date.parse(cfg.closed));
      g.strokeStyle = 'rgba(159,180,255,.75)'; g.lineWidth = 1.6; g.beginPath(); let st = false; c.forEach((d, i) => { if (d.a == null) return; st ? g.lineTo(x(i), y(d.a)) : g.moveTo(x(i), y(d.a)); st = true; }); g.stroke(); g.lineWidth = 1;
      g.font = '12px sans-serif'; g.fillStyle = 'rgba(159,180,255,.9)'; g.fillRect(L, B + 34, 14, 2); g.fillText('200-day average (buy only above it)', L + 20, B + 39);
      if (si >= 0) { g.fillStyle = 'rgba(0,85,255,.18)'; g.fillRect(x(si) - step / 2, T, step, B - T); g.strokeStyle = 'rgba(222,241,5,.7)'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(x(Math.max(0, si - 7)) - step / 2, y(cfg.low7)); g.lineTo(x(si) + step / 2, y(cfg.low7)); g.stroke(); g.setLineDash([]); g.fillStyle = '#9fb4ff'; g.font = '13px sans-serif'; g.fillText('close at a 7-day low', Math.min(x(si) + 8, R - 150), B - 10); }
      const cw = Math.max(3, step * .62);
      c.forEach((d, i) => { const up = d.close >= d.open; g.strokeStyle = g.fillStyle = up ? '#22c58b' : '#f0503c'; g.beginPath(); g.moveTo(x(i), y(d.high)); g.lineTo(x(i), y(d.low)); g.stroke(); g.fillRect(x(i) - cw / 2, y(Math.max(d.open, d.close)), cw, Math.max(1.2, Math.abs(y(d.open) - y(d.close)))); });
      const line = (v, col, dash, label) => { g.strokeStyle = col; g.setLineDash(dash); g.lineWidth = 1.6; g.beginPath(); g.moveTo(x(ei) - step / 2, y(v)); g.lineTo(R, y(v)); g.stroke(); g.setLineDash([]); g.lineWidth = 1; g.fillStyle = col; g.fillRect(R + 2, y(v) - 10, 120, 20); g.fillStyle = '#0b1020'; g.font = 'bold 12px monospace'; g.fillText(label, R + 7, y(v) + 4); };
      line(cfg.stop, '#f0503c', [], 'STOP ' + fmt(cfg.stop)); line(cfg.entry, '#97e6ff', [3, 5], 'IN ' + fmt(cfg.entry));
      const ring = (i, v, col) => { g.strokeStyle = col; g.lineWidth = 2.2; g.beginPath(); g.arc(x(i), y(v), 9, 0, 6.3); g.stroke(); g.lineWidth = 1; };
      ring(ei, cfg.entry, '#fff'); ring(xi, cfg.exit, cfg.pnl >= 0 ? '#22c58b' : '#f0503c');
      const lab = `${cfg.why}: ${cfg.pnl >= 0 ? '+' : '−'}$${Math.abs(cfg.pnl).toFixed(2)} (${cfg.r >= 0 ? '+' : ''}${cfg.r}R)`;
      g.font = '14px sans-serif'; const tw = g.measureText(lab).width, lx = Math.min(Math.max(L, x(xi) - tw / 2), R - tw - 20), ly = Math.max(T + 40, y(cfg.exit) - 30);
      g.fillStyle = 'rgba(11,16,32,.92)'; g.strokeStyle = cfg.pnl >= 0 ? '#22c58b' : '#f0503c'; g.beginPath(); g.roundRect(lx - 8, ly - 18, tw + 16, 26, 6); g.fill(); g.stroke();
      g.fillStyle = cfg.pnl >= 0 ? '#22c58b' : '#ff8a75'; g.fillText(lab, lx, ly);
      g.fillStyle = '#fff'; g.font = 'bold 17px sans-serif'; const tt = `${cfg.name} · 1d · Hyperliquid (Trade.xyz)`; g.fillText(tt, L, 42); const tw2 = g.measureText(tt).width; g.font = '15px sans-serif'; g.fillStyle = '#c8cde0'; g.fillText('Pullback · paper track (Connors Double 7s, bought at the next open)', L + tw2 + 18, 42);
      g.fillStyle = '#8d93ad'; g.font = '13px sans-serif'; g.fillText(`${cfg.vs >= 0 ? '+' : ''}${(cfg.vs * 100).toFixed(1)}% vs its 200-day average at the signal · size ${cfg.qty} · stop -${cfg.stopPct}%, 3% of the account at risk · fees and funding $${cfg.fees.toFixed(2)}`, L, H - 20);
      return cv.toDataURL('image/webp', 0.7);
    }, { c: candles, cfg });
    fs.writeFileSync(path.join(OUT, `pullback-${String(k + 1).padStart(3, '0')}.webp`), Buffer.from(url.split(',')[1], 'base64'));
  }
  await b.close(); console.log('charts', TRACK.length);
})();
