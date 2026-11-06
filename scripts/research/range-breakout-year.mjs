// Paper test 5 (see the Track record). Needs BTC-USD.json, ETH-USD.json, SOL-USD.json (Coinbase hourly candles) next to it.
// Rules-based paper test of "Range breakout" + the lessons from paper tests 1-4, on Kairos's own engine
// (fees 0.4%/side, slippage 0.05%, Brake, daily-loss pause, max-drawdown stop, evaluator marks).
// No lookahead: a signal on the close of candle i is filled at the open of candle i+1.
//   node backtest.mjs <from ISO> <to ISO> [--trades]
import fs from 'node:fs';
import * as T from '../../src/lib/trading.js';

const ASSETS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const RULES = { starting_balance: 10000, fee_pct: 0.4, slippage_pct: 0.05, max_drawdown_pct: 8, daily_loss_pct: 3, max_risk_per_trade_pct: 2,
  min_trades: 50, min_days: 30, min_profit_factor: 1.5, min_adherence_pct: 90 };
const STRATEGY = { assets: ASSETS, hours_utc: '00:00-23:59', risk_per_trade_pct: 1 };

// ---- the rules, fixed before looking at the results ----
const P = {
  rangeH: 48,          // a base of at least 2 days (lesson: run 1)
  minWidth: 0.03, maxWidth: 0.12, // a real base, not a trend leg or a flat line
  volX: 1.5,           // the breakout candle's own volume ≥ 1.5x its 72h average (lessons: runs 1 and 2)
  maxChase: 0.015,     // close no more than 1.5% above the range top (lesson: never chase)
  minStop: 0.03, maxStop: 0.08, // stop at structure, at least 3% away (lesson: fees on tight stops)
  targetR: 2.5,        // target ≥ 2.5R (lesson: fees)
  protectAtR: 1.5,     // only protect after +1.5R, under a real swing low (lesson: run 4)
  timeStopH: 168,      // a breakout that goes nowhere for 7 days is closed
  riskPct: 1,
  trend: process.env.NO_TREND ? 0 : 1, // v2: only with the trend: price > 20-day average > 50-day average (lesson: run 3)
  maxOpen: process.env.NO_TREND ? 3 : 2, // v2: BTC/ETH/SOL move together: at most 2 open, 1 new entry per hour
};

const [, , FROM, TO, flag] = process.argv;
const from = Date.parse(FROM), to = Date.parse(TO);
const data = Object.fromEntries(ASSETS.map(a => [a, JSON.parse(fs.readFileSync(new URL(`./${a}.json`, import.meta.url)))]));
const times = data[ASSETS[0]].map(c => c.t).filter(t => t >= from && t < to);
const idx = Object.fromEntries(ASSETS.map(a => [a, new Map(data[a].map((c, i) => [c.t, i]))]));

const acc = T.newAccount(RULES); acc.createdAt = new Date(times[0]).toISOString();
let stopped = null, blocked = 0; const pending = {}; const log = [];

for (const t of times) {
  const now = new Date(t + 3600000); // decisions happen at the close of the candle that opened at t
  const bars = Object.fromEntries(ASSETS.map(a => [a, data[a][idx[a].get(t)]]));
  if (ASSETS.some(a => !bars[a])) continue;

  // 1) fill entries signalled on the previous close, at this candle's open
  for (const a of Object.keys(pending)) {
    const s = pending[a]; delete pending[a];
    if (stopped || acc.positions[a]) continue;
    const price = bars[a].open, stop = s.stop;
    if (!(stop < price * (1 - P.minStop * 0.8))) continue; // the gap ate the room
    const prop = { action: 'open', asset: a, side: 'long', stop, take_profit: price + P.targetR * (price - stop), risk_pct: P.riskPct };
    acc.proposals.total++;
    const v = T.brake(prop, { strategy: STRATEGY, rules: RULES, acc, price, now: new Date(t), mode: 'solo' });
    if (v.offStrategy) acc.proposals.offStrategy++;
    if (!v.ok) { blocked++; continue; }
    // spot: total exposure can't exceed equity
    const eq = T.equity(acc, Object.fromEntries(ASSETS.map(x => [x, bars[x].open])));
    const used = Object.values(acc.positions).reduce((sum, p) => sum + p.qty * bars[p.asset].open, 0);
    if (eq - used < eq * 0.05) { blocked++; continue; }
    const pos = T.openPosition(acc, { asset: a, side: 'long', price, stop, takeProfit: prop.take_profit, riskPct: P.riskPct, rules: RULES, now: new Date(t) });
    const room = eq - used; if (pos.qty * pos.entry > room) { const k = room / (pos.qty * pos.entry); acc.balance += pos.fees * (1 - k); pos.fees *= k; pos.qty *= k; pos.riskUsd *= k; }
    pos.r0 = pos.entry - stop; pos.openT = t;
  }

  // 2) exits inside this candle: stop first (conservative), then target
  for (const p of Object.values({ ...acc.positions })) {
    const c = bars[p.asset];
    if (c.low <= p.stop) log.push(T.closePosition(acc, p.asset, Math.min(p.stop, c.open), p.stop > p.entry - p.r0 ? 'protected stop' : 'stop', RULES, now));
    else if (c.high >= p.takeProfit) log.push(T.closePosition(acc, p.asset, Math.max(p.takeProfit, c.open), 'take profit', RULES, now));
    else if (t - p.openT >= P.timeStopH * 3600000) log.push(T.closePosition(acc, p.asset, c.close, 'time stop', RULES, now));
    else if (c.high >= p.entry + P.protectAtR * p.r0) {
      const i = idx[p.asset].get(t), swing = Math.min(...data[p.asset].slice(i - 23, i + 1).map(x => x.low)) * 0.995;
      if (swing > p.stop && swing < c.close) p.stop = swing;
    }
  }

  // 3) Brake: daily loss pause, max drawdown stop
  const prices = Object.fromEntries(ASSETS.map(a => [a, bars[a].close]));
  for (const ev of T.riskTick(acc, prices, RULES, now)) {
    if (ev.type === 'closed' && ev.trade) log.push(ev.trade);
    if (ev.type === 'stop') { stopped = { at: now.toISOString(), reason: ev.reason }; }
  }
  if (stopped) break;

  // 4) signals on this close
  const cands = [];
  for (const a of ASSETS) {
    if (acc.positions[a] || acc.paused) continue;
    const i = idx[a].get(t), d = data[a]; if (i < 1210) continue;
    const base = d.slice(i - P.rangeH, i), hi = Math.max(...base.map(x => x.high)), lo = Math.min(...base.map(x => x.low));
    const width = (hi - lo) / hi, c = d[i];
    const vol72 = d.slice(i - 72, i).reduce((s, x) => s + x.volume, 0) / 72;
    if (width < P.minWidth || width > P.maxWidth) continue;
    if (P.trend) { const sma = n => d.slice(i - n, i).reduce((s2, x) => s2 + x.close, 0) / n; const s20 = sma(480), s50 = sma(1200); if (!(d[i].close > s20 && s20 > s50)) continue; }
    if (!(c.close > hi && c.close > c.open && c.volume >= P.volX * vol72 && c.close <= hi * (1 + P.maxChase))) continue;
    const stop = Math.min((hi + lo) / 2, c.close * (1 - P.minStop));
    if ((c.close - stop) / c.close > P.maxStop) continue;
    cands.push({ a, stop, strength: c.volume / vol72 });
  }
  const room = P.maxOpen - Object.keys(acc.positions).length - Object.keys(pending).length;
  for (const x of cands.sort((m, n) => n.strength - m.strength).slice(0, Math.max(0, Math.min(room, P.maxOpen === 3 ? 3 : 1)))) pending[x.a] = { stop: x.stop };
}

// mark open positions to market at the end
const last = times.at(-1), endNow = new Date(last + 3600000);
for (const a of Object.keys(acc.positions)) log.push(T.closePosition(acc, a, data[a][idx[a].get(last)].close, 'end of test', RULES, endNow));
const ev = T.evaluate(acc, RULES, endNow);
const hold = Object.fromEntries(ASSETS.map(a => { const c = data[a].filter(x => x.t >= from && x.t < to); return [a, ((c.at(-1).close / c[0].open - 1) * 100).toFixed(1) + '%']; }));
const byAsset = Object.fromEntries(ASSETS.map(a => { const ts = acc.trades.filter(x => x.asset === a); return [a, `${ts.length} trades, ${ts.reduce((s, x) => s + x.pnl, 0).toFixed(0)}$`]; }));
const reasons = acc.trades.reduce((m, x) => (m[x.reason] = (m[x.reason] || 0) + 1, m), {});
console.log(JSON.stringify({ period: `${FROM.slice(0, 10)} → ${TO.slice(0, 10)}`, equity: +acc.balance.toFixed(2), returnPct: +((acc.balance / 10000 - 1) * 100).toFixed(2),
  metrics: ev.metrics, adherence: ev.adherence, stopped, blocked, byAsset, exits: reasons, buyAndHold: hold,
  marks: ev.checks.map(c => `${c.label}: ${c.value} ${c.pass ? '✓' : '✗'}`), eligible: ev.eligible }, null, 1));
if (flag === '--trades') for (const x of acc.trades) console.log(`${x.openedAt.slice(0, 16)} ${x.asset} ${x.entry.toFixed(2)} → ${x.exit.toFixed(2)} ${x.reason.padEnd(14)} ${x.pnl.toFixed(2).padStart(8)} ${x.r}R`);
fs.writeFileSync(new URL(`./result-${FROM.slice(0, 10)}.json`, import.meta.url), JSON.stringify({ trades: acc.trades, ev, stopped }, null, 1));
