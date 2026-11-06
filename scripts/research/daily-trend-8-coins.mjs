// Paper test 7: daily trend-following (a classic 20/10-day channel breakout) on Kraken-listed majors,
// on Kairos's own engine: fees 0.4%/side + 0.05% slippage (market orders), Brake, daily-loss pause, 8% drawdown stop.
// Rules fixed before the first run. No lookahead: signals on a daily close fill at the next day's open.
//   node daily-trend.mjs <from ISO> <to ISO> [--trades]
import fs from 'node:fs';
import * as T from '../../src/lib/trading.js';

const ASSETS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'ADA-USD', 'LINK-USD', 'LTC-USD'];
const RULES = { starting_balance: 10000, fee_pct: 0.4, slippage_pct: 0.05, max_drawdown_pct: Number(process.env.DD) || 8, daily_loss_pct: 3, max_risk_per_trade_pct: 2,
  min_trades: 50, min_days: 30, min_profit_factor: 1.5, min_adherence_pct: 90 };
const STRATEGY = { assets: ASSETS, hours_utc: '00:00-23:59', risk_per_trade_pct: 1 };
const P = { entryN: 20, exitN: 10, atrN: 20, atrStop: 2, riskPct: 1, maxOpen: 4 };

const [, , FROM, TO, flag] = process.argv;
const from = Date.parse(FROM), to = Date.parse(TO), DAY = 86400000;
const all = JSON.parse(fs.readFileSync(new URL('./daily.json', import.meta.url)));
const at = Object.fromEntries(ASSETS.map(a => [a, new Map(all[a].map((c, i) => [c.t, i]))]));
const days = all['BTC-USD'].map(c => c.t).filter(t => t >= from && t < to);

const atr = (d, i, n) => { let s = 0; for (let k = i - n + 1; k <= i; k++) s += Math.max(d[k].high - d[k].low, Math.abs(d[k].high - d[k - 1].close), Math.abs(d[k].low - d[k - 1].close)); return s / n; };
const acc = T.newAccount(RULES); acc.createdAt = new Date(days[0]).toISOString();
let stopped = null, blocked = 0; let orders = {}, exits = new Set();

for (const t of days) {
  const now = new Date(t + DAY);
  const bar = a => { const i = at[a].get(t); return i === undefined ? null : all[a][i]; };
  const live = ASSETS.filter(a => bar(a));
  const opens = Object.fromEntries(live.map(a => [a, bar(a).open]));

  // 1) orders from yesterday's close, filled at today's open
  for (const a of exits) if (acc.positions[a] && bar(a)) T.closePosition(acc, a, bar(a).open, '10-day low', RULES, new Date(t));
  exits = new Set();
  for (const [a, o] of Object.entries(orders)) {
    if (stopped || acc.positions[a] || !bar(a) || Object.keys(acc.positions).length >= P.maxOpen) continue;
    const price = bar(a).open, stop = price - o.stopDist;
    const prop = { action: 'open', asset: a, side: 'long', stop, take_profit: null, risk_pct: P.riskPct };
    acc.proposals.total++;
    const v = T.brake(prop, { strategy: STRATEGY, rules: RULES, acc, price, now: new Date(t), mode: 'solo' });
    if (v.offStrategy) acc.proposals.offStrategy++;
    if (!v.ok) { blocked++; continue; }
    const eq = T.equity(acc, opens), used = Object.values(acc.positions).reduce((s, p) => s + p.qty * (opens[p.asset] ?? p.entry), 0);
    if (eq - used < eq * 0.05) { blocked++; continue; }
    const pos = T.openPosition(acc, { asset: a, side: 'long', price, stop, riskPct: P.riskPct, rules: RULES, now: new Date(t) });
    const room = eq - used; if (pos.qty * pos.entry > room) { const k = room / (pos.qty * pos.entry); acc.balance += pos.fees * (1 - k); pos.fees *= k; pos.qty *= k; pos.riskUsd *= k; }
  }
  orders = {};

  // 2) intraday: the protective stop (stop-market on the exchange)
  for (const p of Object.values({ ...acc.positions })) { const c = bar(p.asset); if (c && c.low <= p.stop) T.closePosition(acc, p.asset, Math.min(p.stop, c.open), 'stop', RULES, now); }

  // 3) Brake at the daily close
  const closes = Object.fromEntries(live.map(a => [a, bar(a).close]));
  for (const ev of T.riskTick(acc, closes, RULES, now)) if (ev.type === 'stop') stopped = { at: now.toISOString().slice(0, 10), reason: ev.reason };
  if (stopped) break;

  // 4) signals on today's close
  const cands = [];
  for (const a of live) {
    const d = all[a], i = at[a].get(t); if (i < P.entryN + 2) continue;
    const c = d[i];
    if (acc.positions[a]) { if (c.close < Math.min(...d.slice(i - P.exitN, i).map(x => x.low))) exits.add(a); continue; }
    const hi = Math.max(...d.slice(i - P.entryN, i).map(x => x.high));
    if (c.close > hi && !acc.paused) cands.push({ a, stopDist: P.atrStop * atr(d, i, P.atrN), strength: c.close / hi });
  }
  const room = P.maxOpen - Object.keys(acc.positions).length + exits.size;
  for (const x of cands.sort((m, n) => n.strength - m.strength).slice(0, Math.max(0, room))) orders[x.a] = x;
}

const lastT = days.at(-1), endNow = new Date(lastT + DAY);
for (const a of Object.keys(acc.positions)) T.closePosition(acc, a, all[a][at[a].get(lastT)].close, 'end of test', RULES, endNow);
const ev = T.evaluate(acc, RULES, endNow);
const hold = Object.fromEntries(['BTC-USD', 'ETH-USD', 'SOL-USD'].map(a => { const c = all[a].filter(x => x.t >= from && x.t < to); return [a, ((c.at(-1).close / c[0].open - 1) * 100).toFixed(1) + '%']; }));
const fees = acc.trades.reduce((s, x) => s + x.fees, 0);
console.log(JSON.stringify({ period: `${FROM.slice(0, 10)} → ${TO.slice(0, 10)}`, equity: +acc.balance.toFixed(2), returnPct: +((acc.balance / 10000 - 1) * 100).toFixed(2), fees: +fees.toFixed(0),
  metrics: ev.metrics, stopped, blocked, buyAndHold: hold, best: acc.trades.slice().sort((x, y) => y.pnl - x.pnl).slice(0, 3).map(x => `${x.asset} ${x.openedAt.slice(0, 10)} ${x.r}R`),
  marks: ev.checks.map(c => `${c.label}: ${c.value} ${c.pass ? '✓' : '✗'}`), eligible: ev.eligible }, null, 1));
if (flag === '--trades') for (const x of acc.trades) console.log(`${x.openedAt.slice(0, 10)} → ${x.closedAt.slice(0, 10)} ${x.asset.padEnd(9)} ${x.reason.padEnd(12)} ${x.pnl.toFixed(0).padStart(6)} ${x.r}R`);
fs.writeFileSync(new URL(`./result-trend-${FROM.slice(0, 10)}.json`, import.meta.url), JSON.stringify({ trades: acc.trades, ev, stopped }, null, 1));
