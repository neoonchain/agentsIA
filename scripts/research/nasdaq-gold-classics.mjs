// Nasdaq 100 and gold: classic rule sets of well-known traders, tested on ~26 years of daily data.
// Signal at the daily close, trade at the next open. 1x notional, long/flat unless noted.
// Costs: 0.05% fee + 0.03% slippage per side, plus Hyperliquid funding on longs (NDX 5.4%/yr, gold 8.4%/yr, measured).
import fs from 'node:fs';
// Data: Yahoo Finance daily candles (^NDX and GC=F), fetched at the start.   node nasdaq-gold-classics.mjs
for (const [sym, f] of [['^NDX', 'ndx.json'], ['GC=F', 'gc.json']]) if (!fs.existsSync(f)) fs.writeFileSync(f, await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=946684800&period2=${Math.floor(Date.now() / 1000)}&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text());
const load = f => { const j = JSON.parse(fs.readFileSync(f)).chart.result[0], q = j.indicators.quote[0];
  return j.timestamp.map((t, i) => ({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter(x => x.o && x.c && x.h && x.l); };
const DATA = { NDX: load('ndx.json'), GOLD: load('gc.json') };
const CARRY = { NDX: 0.054, GOLD: 0.084 }, COST = 0.0008;
const SPLIT = Date.parse('2015-01-01');

const sma = (a, n) => a.map((_, i) => i < n - 1 ? NaN : a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n);
function rsi(a, n) { const o = new Array(a.length).fill(NaN); let g = 0, l = 0;
  for (let i = 1; i < a.length; i++) { const d = a[i] - a[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; o[i] = 100 - 100 / (1 + g / (l || 1e-9)); } } return o; }
const hh = (a, n) => a.map((_, i) => i < n ? NaN : Math.max(...a.slice(i - n, i)));   // previous n, excluding today
const ll = (a, n) => a.map((_, i) => i < n ? NaN : Math.min(...a.slice(i - n, i)));
function atr(c, n) { const tr = c.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)) : x.h - x.l); return sma(tr, n); }

// Each strategy: (candles, ind) => function(i, pos) returning desired position for the NEXT open: 1, 0, -1.
const STRATS = {
  // Paul Tudor Jones: "nothing good happens below the 200-day moving average"
  'PTJ 200-day rule': (c, I) => i => c[i].c > I.s200[i] ? 1 : 0,
  // Larry Connors RSI(2): buy pullbacks in an uptrend, sell into strength (Short Term Trading Strategies That Work)
  'Connors RSI(2) <10, exit >SMA5': (c, I) => (i, p) => p > 0 ? (c[i].c > I.s5[i] ? 0 : 1) : (c[i].c > I.s200[i] && I.r2[i] < 10 ? 1 : 0),
  // Connors cumulative RSI: two-day RSI(2) sum under 35
  'Connors cum-RSI(2) <35': (c, I) => (i, p) => p > 0 ? (I.r2[i] > 65 ? 0 : 1) : (c[i].c > I.s200[i] && I.r2[i] + I.r2[i - 1] < 35 ? 1 : 0),
  // Linda Raschke / IBS: close in the bottom of the day's range in an uptrend, out on the next up close
  'Raschke IBS <0.2 in uptrend': (c, I) => (i, p) => p > 0 ? (c[i].c > c[i - 1].h ? 0 : 1) : (c[i].c > I.s200[i] && I.ibs[i] < 0.2 ? 1 : 0),
  // Richard Dennis Turtles, system 2: 55-day breakout, 20-day exit (long and short)
  'Turtle 55/20 long+short': (c, I) => (i, p) => { if (p > 0 && c[i].c < I.l20[i]) p = 0; if (p < 0 && c[i].c > I.h20[i]) p = 0; if (c[i].c > I.h55[i]) return 1; if (c[i].c < I.l55[i]) return -1; return p; },
  'Turtle 55/20 long only': (c, I) => (i, p) => { if (p > 0 && c[i].c < I.l20[i]) p = 0; return c[i].c > I.h55[i] ? 1 : p; },
  // Moskowitz / AQR time-series momentum: long when the 12-month return is positive
  'TSMOM 12-month': (c, I) => i => c[i].c > c[i - 252]?.c ? 1 : 0,
  // Classic trend followers (Dunn, Chesapeake): 50/200 moving-average cross
  '50/200 cross': (c, I) => i => I.s50[i] > I.s200[i] ? 1 : 0,
  // Combo: trend filter + buy the dip with RSI(2) <10 + hold while above 50d (the "pullback in a trend" of Minervini/Raschke)
  // Connors "Double 7s": close at a 7-day low in an uptrend, sell at a 7-day high close
  'Connors Double 7s': (c, I) => (i, p) => p > 0 ? (c[i].c >= I.h7[i] ? 0 : 1) : (c[i].c > I.s200[i] && c[i].c <= I.l7[i] ? 1 : 0),
  // RSI(2) and IBS together: a weak close at the bottom of the day, exit on a close above yesterday's high
  'RSI(2)<15 + IBS<0.3, exit >prev high': (c, I) => (i, p) => p > 0 ? (c[i].c > c[i - 1].h ? 0 : 1) : (c[i].c > I.s200[i] && I.r2[i] < 15 && I.ibs[i] < 0.3 ? 1 : 0),
  // Same with a 5-day time stop
  'RSI(2)<15 + IBS<0.3, exit >prev high or 5d': (c, I) => { let d = 0; return (i, p) => { if (p > 0) { d++; return c[i].c > c[i - 1].h || d >= 5 ? 0 : 1; } d = 0; return c[i].c > I.s200[i] && I.r2[i] < 15 && I.ibs[i] < 0.3 ? 1 : 0; }; },
  // Shorts that collect funding: overbought in a downtrend
  'Short RSI(2)>90 below SMA200': (c, I) => (i, p) => p < 0 ? (c[i].c < I.s5[i] ? 0 : -1) : (c[i].c < I.s200[i] && I.r2[i] > 90 ? -1 : 0),
  // Turtle long only, only above the 200-day
  'Turtle 55/20 long, above SMA200': (c, I) => (i, p) => { if (p > 0 && c[i].c < I.l20[i]) p = 0; return c[i].c > I.h55[i] && c[i].c > I.s200[i] ? 1 : p; },
  'Trend + RSI(2) dip, hold above SMA50': (c, I) => (i, p) => p > 0 ? (c[i].c < I.s50[i] ? 0 : 1) : (c[i].c > I.s200[i] && I.r2[i] < 10 ? 1 : 0),
};

function run(name, asset, from = 0, to = Infinity) {
  const c = DATA[asset], cl = c.map(x => x.c);
  const I = { s5: sma(cl, 5), s50: sma(cl, 50), s200: sma(cl, 200), r2: rsi(cl, 2), ibs: c.map(x => (x.c - x.l) / ((x.h - x.l) || 1e-9)), h55: hh(cl, 55), l55: ll(cl, 55), h20: hh(cl, 20), l20: ll(cl, 20), h7: hh(cl, 7), l7: ll(cl, 7) };
  const sig = STRATS[name](c, I);
  let eq = 1, peak = 1, dd = 0, pos = 0, entry = 0, entryT = 0, trades = [], daysIn = 0, days = 0; const curve = [], monthly = {};
  for (let i = 260; i < c.length - 1; i++) {
    if (c[i + 1].t < from || c[i + 1].t >= to) continue;
    const want = sig(i, pos), nx = c[i + 1];
    // mark today's close->next open, then switch at next open, then hold to next close
    let r = 0;
    if (pos !== want) {
      if (pos) { const ret = pos * (nx.o / entry - 1) - COST; trades.push({ t: entryT, ret: ret - (pos > 0 ? CARRY[asset] * (nx.t - entryT) / 31536e6 : 0), side: pos }); }
      r += pos * (nx.o / c[i].c - 1) - (pos ? COST : 0) - (want ? COST : 0) + want * (nx.c / nx.o - 1);
      if (want) { entry = nx.o; entryT = nx.t; }
    } else r += pos * (nx.c / c[i].c - 1);
    const held = pos || want; if (held > 0) r -= CARRY[asset] / 365 * (nx.t - c[i].t) / 864e5;
    pos = want; eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); days++; if (pos) daysIn++;
    const m = new Date(nx.t).toISOString().slice(0, 7); monthly[m] = (monthly[m] || 1) * (1 + r); curve.push(r);
  }
  const yrs = days / 252, w = trades.filter(t => t.ret > 0), l = trades.filter(t => t.ret <= 0);
  const mean = curve.reduce((a, b) => a + b, 0) / curve.length, sd = Math.sqrt(curve.reduce((a, b) => a + (b - mean) ** 2, 0) / curve.length);
  const mv = Object.values(monthly);
  return { name, asset, cagr: eq ** (1 / yrs) - 1, dd, sharpe: mean / sd * Math.sqrt(252), trades: trades.length, perYr: trades.length / yrs, win: w.length / (trades.length || 1),
    pf: w.reduce((a, t) => a + t.ret, 0) / -(l.reduce((a, t) => a + t.ret, 0) || -1e-9), avgW: w.reduce((a, t) => a + t.ret, 0) / (w.length || 1), avgL: l.reduce((a, t) => a + t.ret, 0) / (l.length || 1),
    expo: daysIn / days, greenM: mv.filter(x => x > 1).length / mv.length };
}
const pct = x => (x * 100).toFixed(1).padStart(6) + '%';
const row = r => `${r.name.padEnd(38)} CAGR${pct(r.cagr)} DD${pct(r.dd)} Sh ${r.sharpe.toFixed(2).padStart(5)} n${String(r.trades).padStart(4)} (${r.perYr.toFixed(1)}/yr) win${pct(r.win)} PF ${r.pf.toFixed(2).padStart(5)} avgW${pct(r.avgW)} avgL${pct(r.avgL)} in-mkt${pct(r.expo)} green-mo${pct(r.greenM)}`;
const bh = (asset, from, to) => { const c = DATA[asset].filter(x => x.t >= from && x.t < to); const yrs = c.length / 252; let pk = 0, dd = 0; for (const x of c) { pk = Math.max(pk, x.c); dd = Math.max(dd, 1 - x.c / pk); } return `Buy & hold: CAGR ${pct((c.at(-1).c / c[0].c) ** (1 / yrs) - 1)} DD ${pct(dd)} (before funding)`; };

const out = {};
for (const asset of ['NDX', 'GOLD']) {
  for (const [lab, f, t] of [['IN-SAMPLE 2001-2014', 0, SPLIT], ['OUT-OF-SAMPLE 2015-2026', SPLIT, Infinity], ['LAST 12 MONTHS', Date.parse('2025-11-01'), Infinity]]) {
    console.log(`\n=== ${asset} · ${lab} · ${bh(asset, Math.max(f, DATA[asset][260].t), t)}`);
    for (const n of Object.keys(STRATS)) { const r = run(n, asset, f, t); console.log(row(r)); (out[asset] ||= {})[lab + '|' + n] = r; }
  }
}
