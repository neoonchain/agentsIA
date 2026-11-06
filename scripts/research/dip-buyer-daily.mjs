// Paper test 9: "Dip buyer" on 8 majors, real Coinbase daily candles (src/lib/dipbuyer.js is the engine).
// How the rules were chosen, and checked:
//   1. Tuned on Aug 2023 - Nov 2025 (a grid of RSI level, trend average, BTC filter, exit average, stop, target, time stop).
//   2. The unseen year Nov 2025 - Nov 2026 was used to pick the rule family that held up there (a soft look-ahead, said openly).
//   3. Those rules were then frozen and run once on Jan 2019 - Jul 2023, data never used before (it includes the 2022 crash).
//   node dip-buyer-daily.mjs <daily-long.json> [from] [to] [--trades out.json]
import fs from 'node:fs';
import { stepTrack, newTrack, summary, DAY } from '../../src/lib/dipbuyer.js';

const [, , file, from = '2019-01-01', to = '2026-11-05', flag, out] = process.argv;
const daily = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const a of Object.keys(daily)) daily[a] = daily[a].filter(c => c.t <= Date.parse(to)); // complete days only
const st = newTrack(Date.parse(from)), { trades } = stepTrack(st, daily, Date.parse(to));
const s = summary(trades), d = x => new Date(x).toISOString().slice(0, 10);
console.log(`${from} → ${to}: ${s.n} trades, win ${(s.winRate * 100).toFixed(1)}%, profit factor ${s.profitFactor?.toFixed(2)}, return ${((st.eq / st.start - 1) * 100).toFixed(2)}%, max drawdown ${(st.maxDD * 100).toFixed(1)}%, open ${Object.keys(st.pos).join(', ') || 'none'}`);
const byYear = {}; for (const t of trades) (byYear[d(t.closedT).slice(0, 4)] ||= []).push(t);
for (const [y, ts] of Object.entries(byYear)) { const k = summary(ts); console.log(`  ${y}: ${k.n} trades, win ${(k.winRate * 100).toFixed(0)}%, PF ${k.profitFactor?.toFixed(2) ?? '-'}, ${k.pnl >= 0 ? '+' : ''}${k.pnl.toFixed(0)} USD`); }
if (flag === '--trades') fs.writeFileSync(out, JSON.stringify({ state: st, trades }, null, 1));
void DAY;
