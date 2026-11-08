// "Pullback": buy a short dip in a market that is in a long uptrend, sell into the bounce. Nasdaq 100 and gold on Trade.xyz.
// Larry Connors' "Double 7s" (Short Term Trading Strategies That Work, 2008), unchanged, with a safety stop added.
// One engine for the research, the paper track shipped with the app and the daily update in the app.
//   Trend:  the market closes above its 200-day average (weekdays only, like the index itself).
//   Entry:  it closes at or under its lowest close of the previous 7 days. Bought at the next day's open.
//   Exit:   a close at or over its highest close of the previous 7 days sells at the next open.
//           Safety stop under entry, intraday. Size: 3% of the account at risk to the stop.
// Costs: 0.05% fee + 0.03% slippage each way, and Hyperliquid funding on longs, at the rates measured over the
// markets' first year (Nasdaq 100 5.4%/yr, gold 8.4%/yr).
import { DAY } from './dipbuyer.js';

export const PULLBACK_ASSETS = ['XYZ100-XYZ', 'GOLD-XYZ'];
export const PULLBACK = { trendN: 200, lowN: 7, highN: 7, risk: 0.03, maxWeight: 1, stop: { 'XYZ100-XYZ': 0.08, 'GOLD-XYZ': 0.06 }, fee: 0.0005, slip: 0.0003, funding: { 'XYZ100-XYZ': 0.054, 'GOLD-XYZ': 0.084 } };

const weekday = t => { const d = new Date(t).getUTCDay(); return d !== 0 && d !== 6; };
const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
function indicators(raw) {
  const c = raw.filter(x => weekday(x.t)), cl = c.map(x => x.close);
  const lo = cl.map((_, i) => i < PULLBACK.lowN ? NaN : Math.min(...cl.slice(i - PULLBACK.lowN, i)));
  const hi = cl.map((_, i) => i < PULLBACK.highN ? NaN : Math.max(...cl.slice(i - PULLBACK.highN, i)));
  return { c, cl, avg: sma(cl, PULLBACK.trendN), lo, hi, idx: new Map(c.map((x, i) => [x.t, i])) };
}

export const newPullbackTrack = (startT, balance = 10000) => ({ eq: balance, start: balance, peak: balance, maxDD: 0, pos: {}, pend: null, lastT: startT - DAY });

/** Walk the rules over complete daily candles up to `toT`. Mutates `state`; returns the closed trades. */
export function stepPullback(state, daily, toT, onDay) {
  const IND = Object.fromEntries(PULLBACK_ASSETS.filter(a => daily[a]?.length).map(a => [a, indicators(daily[a])]));
  const trades = [], times = [...new Set(Object.values(IND).flatMap(I => I.c.map(x => x.t)))].filter(t => t > state.lastT && t <= toT).sort((a, b) => a - b);
  const close = (a, p, px, t, why) => {
    const fund = p.qty * p.entry * PULLBACK.funding[a] * (t + DAY - p.t) / (365 * DAY);
    const fees = p.feeIn + p.qty * px * PULLBACK.fee + fund, pnl = p.qty * (px - p.entry) - fees;
    state.eq += pnl + p.feeIn; // the entry fee was taken from equity when the position opened
    const tr = { asset: a, t: p.t, closedT: t, entry: p.entry, stop: p.stop, exit: px, qty: p.qty, pnl, r: pnl / p.risk, why, fees, funding: fund, days: Math.round((t - p.t) / DAY) + 1, ctx: p.ctx };
    trades.push(tr); delete state.pos[a]; return tr;
  };
  for (const t of times) {
    const day = { t, bought: [], sold: [], stopped: [], buyNext: [], sellNext: [], markets: {} };
    // 1) yesterday's orders, at today's open
    if (state.pend) {
      for (const a of state.pend.sell) { const p = state.pos[a], I = IND[a], i = I?.idx.get(t); if (p && i != null) day.sold.push(close(a, p, I.c[i].open * (1 - PULLBACK.slip), t, 'close at a 7-day high')); }
      for (const [a, ctx] of state.pend.buy) {
        const I = IND[a], i = I?.idx.get(t); if (state.pos[a] || i == null) continue;
        const px = I.c[i].open * (1 + PULLBACK.slip), st = PULLBACK.stop[a], val = Math.min(state.eq * PULLBACK.risk / st, state.eq * PULLBACK.maxWeight);
        const qty = val / px, feeIn = val * PULLBACK.fee;
        state.eq -= feeIn; state.pos[a] = { t, entry: px, qty, stop: px * (1 - st), risk: qty * px * st, feeIn, ctx }; day.bought.push({ asset: a, ...state.pos[a] });
      }
    }
    state.pend = null;
    // 2) safety stops, intraday
    for (const [a, p] of Object.entries(state.pos)) { const I = IND[a], i = I?.idx.get(t); if (i != null && I.c[i].low <= p.stop) day.stopped.push(close(a, p, Math.min(p.stop, I.c[i].open) * (1 - PULLBACK.slip), t, 'safety stop')); }
    // 3) mark to market
    let m = state.eq; for (const [a, p] of Object.entries(state.pos)) { const I = IND[a], i = I?.idx.get(t); if (i != null) m += p.qty * (I.cl[i] - p.entry); else { const k = I.c.findLastIndex(x => x.t < t); if (k >= 0) m += p.qty * (I.cl[k] - p.entry); } }
    state.peak = Math.max(state.peak, m); state.maxDD = Math.max(state.maxDD, 1 - m / state.peak); day.equity = m;
    // 4) today's close decides tomorrow's orders
    const buy = [], sell = [];
    for (const a of PULLBACK_ASSETS) {
      const I = IND[a], i = I?.idx.get(t);
      if (i == null || i < PULLBACK.trendN) continue;
      const v = { close: I.cl[i], vsAvg: I.cl[i] / I.avg[i] - 1, low7: I.lo[i], high7: I.hi[i] };
      day.markets[a] = v;
      if (state.pos[a]) { if (I.cl[i] >= I.hi[i]) sell.push(a); }
      else if (v.vsAvg > 0 && I.cl[i] <= I.lo[i]) buy.push([a, { signalT: t, vsAvg: +v.vsAvg.toFixed(4), low7: +I.lo[i].toPrecision(6), close: +I.cl[i].toPrecision(6), drop: +(I.cl[i] / I.hi[i] - 1).toFixed(4) }]);
    }
    state.pend = { sell, buy }; day.sellNext = sell; day.buyNext = buy.map(x => x[0]); day.holding = Object.keys(state.pos);
    state.lastT = t;
    onDay?.(day);
  }
  // weekends have no signal: once the last day is in, do not ask for it again
  if (PULLBACK_ASSETS.some(a => daily[a]?.some(x => x.t === toT))) state.lastT = Math.max(state.lastT, toT);
  return { state, trades };
}

const pct = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const px = v => v >= 1000 ? Math.round(v).toLocaleString('en-US') : +(+v).toFixed(2);
const NAME = { 'XYZ100-XYZ': 'Nasdaq 100', 'GOLD-XYZ': 'Gold' };

/** A journal entry for one closed Pullback trade. */
export function pullbackJournalEntry(tr, headlines = []) {
  const c = tr.ctx, n = NAME[tr.asset] || tr.asset, win = tr.pnl > 0, r = +tr.r.toFixed(2), pnl = +tr.pnl.toFixed(2);
  return {
    date: new Date(tr.t).toISOString().slice(0, 10) + 'T00:00', asset: tr.asset, side: 'long', entry: +(+tr.entry).toPrecision(6), stop: +(+tr.stop).toPrecision(6), exit: +(+tr.exit).toPrecision(6), size: +tr.qty.toPrecision(5), pnl, r,
    strategy: 'Pullback', emotion: 'rules-based', tags: `example, paper-track, pullback, ${tr.why === 'safety stop' ? 'stop' : 'bounce-exit'}`,
    thesis: [
      `${n} on ${new Date(c.signalT).toISOString().slice(0, 10)}: ${pct(c.vsAvg)} above its 200-day average, so the long trend was up.`,
      `It closed at ${px(c.close)}, at or under its lowest close of the previous 7 days (${px(c.low7)}), ${pct(c.drop)} off its 7-day high: a pullback inside the uptrend.`,
      `Bought at the next open, ${px(tr.entry)}, sized so the safety stop at ${px(tr.stop)} (-${(PULLBACK.stop[tr.asset] * 100).toFixed(0)}%) risks 3% of the account. Exit on a close at a 7-day high.`,
      headlines.length ? `Headlines that day: ${headlines.map(h => `"${h}"`).join('; ')}.` : '',
    ].filter(Boolean).join('\n\n'),
    psychology: 'No discretion: the rules bought the fear inside an uptrend and sold into the bounce. Paper track of the Pullback rules on Hyperliquid (Trade.xyz) prices, funding included.',
    wentWell: win ? `- The bounce came in ${tr.days} days: +${pnl} USD (${r}R) after ${tr.fees.toFixed(2)} USD of fees and funding.` : '- The loss stayed inside the planned risk.',
    wentWrong: win ? '' : `- ${tr.why === 'safety stop' ? 'The dip kept going and hit the safety stop' : 'It bounced, but not above the entry'} after ${tr.days} days: ${pnl} USD (${r}R).`,
  };
}

/** One day of the Pullback track as an entry for "How the AI decided". */
export function pullbackDecision(day) {
  const n = a => NAME[a] || a, list = xs => xs.map(n).join(', ');
  const lines = [
    ...Object.entries(day.markets).map(([a, v]) => `${n(a)} ${px(v.close)}: ${pct(v.vsAvg)} vs its 200-day average (${v.vsAvg > 0 ? 'uptrend' : 'downtrend: no buys'}), 7-day low ${px(v.low7)}, 7-day high ${px(v.high7)}.`),
    ...day.bought.map(x => `Bought ${n(x.asset)} at the open, ${px(x.entry)}, safety stop ${px(x.stop)}.`),
    ...[...day.sold, ...day.stopped].map(x => `Sold ${n(x.asset)} (${x.why}) at ${px(x.exit)} after ${x.days} days: ${x.pnl >= 0 ? '+' : ''}${x.pnl.toFixed(2)} USD.`),
    day.buyNext.length ? `Buy at tomorrow's open: ${list(day.buyNext)} (closed at a 7-day low in an uptrend).` : '',
    day.sellNext.length ? `Sell at tomorrow's open: ${list(day.sellNext)} (closed at a 7-day high).` : '',
    day.holding.length ? `Holding: ${list(day.holding)}.` : '',
  ].filter(Boolean);
  const done = [...day.sold, ...day.stopped], ev = done[0] || day.bought[0];
  const outcome = done.length ? 'closed' : day.bought.length ? 'opened' : day.buyNext.length ? 'order' : 'hold';
  const up = Object.values(day.markets).some(v => v.vsAvg > 0);
  const why = outcome === 'hold' ? (day.holding.length ? 'Holding: waiting for a close at a 7-day high.' : up ? 'No pullback today: waiting for a close at a 7-day low.' : 'Both markets are under their 200-day average: no buys.') : lines.find(l => /^(Bought|Sold|Buy at)/.test(l));
  return {
    at: new Date(day.t + DAY).toISOString(), example: true, track: true, mode: 'rules', live: false,
    action: outcome === 'closed' ? 'close' : outcome === 'hold' ? 'hold' : 'open', asset: ev?.asset || (day.buyNext[0] ?? null), side: 'long', outcome,
    stop: ev?.stop ?? null, takeProfit: null, entry: day.bought[0]?.entry ?? null, pnl: done.length ? +done.reduce((s, x) => s + x.pnl, 0).toFixed(2) : null,
    riskPct: day.bought.length ? 3 : null, thesis: `${why}\n\n${lines.map(l => `- ${l}`).join('\n')}`, reasons: [],
    context: { prices: Object.fromEntries(Object.entries(day.markets).map(([a, v]) => [a, +v.close.toPrecision(6)])) },
    steps: [{ role: 'lead', model: 'Pullback rules · paper track', text: lines.join('\n') }],
  };
}

/** Today's readings for the AI (completed weekdays only). */
export function pullbackReadings(daily, now = Date.now()) {
  return PULLBACK_ASSETS.filter(a => daily[a]).map(a => {
    const I = indicators(daily[a].filter(x => x.t + DAY <= now)), i = I.c.length - 1;
    if (i < PULLBACK.trendN) return null;
    const up = I.cl[i] > I.avg[i];
    return `- ${NAME[a]} (${a}, ${new Date(I.c[i].t).toISOString().slice(0, 10)} close ${px(I.cl[i])}): 200-day avg ${px(I.avg[i])} (${up ? 'above' : 'below'}), 7-day low ${px(I.lo[i])}, 7-day high ${px(I.hi[i])}${up && I.cl[i] <= I.lo[i] ? ' → PULLBACK: may be bought' : I.cl[i] >= I.hi[i] ? ' → 7-day high: sell if held' : ''}`;
  }).filter(Boolean).join('\n');
}
