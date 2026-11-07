// "Trend rider": while the market is strong, hold the coins that are trending, and step aside when they turn.
// One engine for the research, the paper track shipped with the app and the daily update in the app.
//   Market:  BTC closes above its 50-day average. Otherwise no new buys (open positions keep their own exit).
//   Entry:   a coin closes above its 20-day average with a positive 20-day return. Strongest 20-day return first.
//            Bought at the next day's open. At most 5 coins, 20% of the account each (no leverage).
//   Exit:    a daily close under the 20-day average sells at the next open. Safety stop 15% under entry, intraday.
//            20% of the account x a 15% stop = 3% of the account at risk per coin.
// Fees: market orders, 0.40% + 0.05% slippage each way.
import { DAY } from './dipbuyer.js';

export const TREND_ASSETS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'ADA-USD', 'LINK-USD', 'LTC-USD'];
export const TREND = { btcN: 50, avgN: 20, momN: 20, maxOpen: 5, weight: 0.2, stop: 0.15, fee: 0.004, slip: 0.0005, history: 210 };

const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
function indicators(c) {
  const cl = c.map(x => x.close);
  return { c, cl, avg: sma(cl, TREND.avgN), btcAvg: sma(cl, TREND.btcN), mom: cl.map((v, i) => i >= TREND.momN ? v / cl[i - TREND.momN] - 1 : NaN), idx: new Map(c.map((x, i) => [x.t, i])) };
}

export const newTrendTrack = (startT, balance = 10000) => ({ eq: balance, start: balance, peak: balance, maxDD: 0, pos: {}, pend: null, lastT: startT - DAY });

/** Walk the rules day by day over complete daily candles up to `toT`. Mutates and returns `state`; returns the closed trades. */
export function stepTrend(state, daily, toT, onDay) {
  const IND = Object.fromEntries(Object.entries(daily).map(([a, c]) => [a, indicators(c)])), B = IND['BTC-USD'];
  const trades = [];
  if (!B) return { state, trades };
  const close = (a, p, px, t, why) => {
    const fees = p.feeIn + p.qty * px * TREND.fee, pnl = p.qty * (px - p.entry) - fees;
    state.eq += pnl + p.feeIn; // the entry fee was already taken from equity when the position opened
    const tr = { asset: a, t: p.t, closedT: t, entry: p.entry, stop: p.stop, exit: px, qty: p.qty, pnl, r: pnl / (p.qty * p.entry * TREND.stop), why, fees, days: Math.round((t - p.t) / DAY) + 1, ctx: p.ctx };
    trades.push(tr); delete state.pos[a]; return tr;
  };
  for (const t of B.c.map(x => x.t).filter(t => t > state.lastT && t <= toT)) {
    const bi = B.idx.get(t), day = { t, regime: false, btcVsAvg: null, bought: [], sold: [], stopped: [], buyNext: [], sellNext: [], coins: {} };
    // 1) yesterday's orders, at today's open
    if (state.pend) {
      for (const a of state.pend.sell) { const p = state.pos[a], I = IND[a], i = I?.idx.get(t); if (!p || i == null) continue; day.sold.push(close(a, p, I.c[i].open * (1 - TREND.slip), t, 'close under the 20-day average')); }
      for (const [a, ctx] of state.pend.buy) {
        if (state.pos[a] || Object.keys(state.pos).length >= TREND.maxOpen) continue;
        const I = IND[a], i = I?.idx.get(t); if (i == null) continue;
        const px = I.c[i].open * (1 + TREND.slip), val = state.eq * TREND.weight, qty = val / px, feeIn = val * TREND.fee;
        state.eq -= feeIn; state.pos[a] = { t, entry: px, qty, stop: px * (1 - TREND.stop), feeIn, ctx }; day.bought.push({ asset: a, ...state.pos[a] });
      }
      state.pend = null;
    }
    // 2) safety stops, intraday
    for (const [a, p] of Object.entries(state.pos)) { const I = IND[a], i = I?.idx.get(t); if (i == null) continue; if (I.c[i].low <= p.stop) day.stopped.push(close(a, p, Math.min(p.stop, I.c[i].open) * (1 - TREND.slip), t, 'safety stop')); }
    // 3) mark to market
    let m = state.eq; for (const [a, p] of Object.entries(state.pos)) { const I = IND[a], i = I?.idx.get(t); if (i != null) m += p.qty * (I.cl[i] - p.entry); }
    state.peak = Math.max(state.peak, m); state.maxDD = Math.max(state.maxDD, 1 - m / state.peak); day.equity = m;
    // 4) today's close decides tomorrow's orders
    if (bi >= TREND.btcN) { day.btcVsAvg = B.cl[bi] / B.btcAvg[bi] - 1; day.regime = day.btcVsAvg > 0; }
    const cand = [], sell = [];
    for (const a of TREND_ASSETS) {
      const I = IND[a], i = I?.idx.get(t);
      if (i == null || i < TREND.history || I.c[i].t - I.c[i - 200].t > 205 * DAY) continue;
      const up = I.cl[i] > I.avg[i] && I.mom[i] > 0;
      day.coins[a] = { close: I.cl[i], vsAvg: I.cl[i] / I.avg[i] - 1, mom: I.mom[i] };
      if (state.pos[a] && I.cl[i] < I.avg[i]) sell.push(a);
      else if (!state.pos[a] && day.regime && up) cand.push([a, { signalT: t, btcVsAvg: +day.btcVsAvg.toFixed(4), vsAvg: +(I.cl[i] / I.avg[i] - 1).toFixed(4), mom: +I.mom[i].toFixed(4) }]);
    }
    cand.sort((x, y) => y[1].mom - x[1].mom);
    state.pend = { sell, buy: cand }; day.sellNext = sell; day.buyNext = cand.map(x => x[0]); day.holding = Object.keys(state.pos);
    state.lastT = t;
    onDay?.(day);
  }
  return { state, trades };
}

const pct = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const px = v => v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 1 ? +v.toFixed(2) : +v.toPrecision(4);

/** A journal entry for one closed Trend rider trade. */
export function trendJournalEntry(tr, headlines = []) {
  const c = tr.ctx, coin = tr.asset.split('-')[0], win = tr.pnl > 0, r = +tr.r.toFixed(2), pnl = +tr.pnl.toFixed(2);
  return {
    date: new Date(tr.t).toISOString().slice(0, 10) + 'T00:00', asset: tr.asset, side: 'long', entry: +(+tr.entry).toPrecision(6), stop: +(+tr.stop).toPrecision(6), exit: +(+tr.exit).toPrecision(6), size: +tr.qty.toPrecision(5), pnl, r,
    strategy: 'Trend rider', emotion: 'rules-based', tags: `example, paper-track, trend-rider, ${tr.why === 'safety stop' ? 'stop' : 'trend-exit'}`,
    thesis: [
      `Market on ${new Date(c.signalT).toISOString().slice(0, 10)}: BTC ${pct(c.btcVsAvg)} vs its 50-day average, so the market filter was on.`,
      `${coin} closed ${pct(c.vsAvg)} above its 20-day average, up ${pct(c.mom)} over 20 days: one of the strongest coins that day.`,
      `Bought at the next open, ${px(tr.entry)}, with 20% of the account. Exit on a daily close under the 20-day average; safety stop ${px(tr.stop)} (-15%), so 3% of the account at risk.`,
      headlines.length ? `Headlines that day: ${headlines.map(h => `"${h}"`).join('; ')}.` : '',
    ].filter(Boolean).join('\n\n'),
    psychology: 'No discretion: the rules bought the strength and sold when it faded. Paper track of the Trend rider rules, updated every day on real Coinbase prices.',
    wentWell: win ? `- Rode the move for ${tr.days} days: +${pnl} USD (${r}R).` : '- The exit came early: the loss stayed well under the 15% safety stop.',
    wentWrong: win ? '' : `- ${tr.why === 'safety stop' ? 'The safety stop was hit' : 'The coin closed back under its 20-day average'} after ${tr.days} days: ${pnl} USD (${r}R). Trend following loses often and small; the winners pay for it.`,
  };
}

/** One day of the Trend rider track as an entry for "How the AI decided". */
export function trendDecision(day) {
  const coin = a => a.split('-')[0], list = xs => xs.map(coin).join(', ');
  const strong = Object.entries(day.coins).filter(([, c]) => c.vsAvg > 0 && c.mom > 0).map(([a]) => a), weak = Object.keys(day.coins).filter(a => !strong.includes(a));
  const lines = [
    day.btcVsAvg == null ? 'Market filter unknown.' : `Market filter ${day.regime ? 'ON' : 'OFF'}: BTC ${pct(day.btcVsAvg)} vs its 50-day average${day.regime ? '.' : ': no new buys.'}`,
    ...day.bought.map(x => `Bought ${coin(x.asset)} at the open, ${px(x.entry)}: ${+x.qty.toPrecision(4)} ${coin(x.asset)}, safety stop ${px(x.stop)}.`),
    ...[...day.sold, ...day.stopped].map(x => `Sold ${coin(x.asset)} (${x.why}) at ${px(x.exit)} after ${x.days} days: ${x.pnl >= 0 ? '+' : ''}${x.pnl.toFixed(2)} USD.`),
    strong.length ? `Trending (above the 20-day average, up over 20 days): ${list(strong)}.` : 'No coin is trending.',
    weak.length ? `Not trending: ${list(weak)}.` : '',
    day.buyNext.length ? `Buy at tomorrow's open: ${list(day.buyNext.slice(0, Math.max(0, TREND.maxOpen - (day.holding.length - day.sellNext.length))))}${day.buyNext.length > TREND.maxOpen - (day.holding.length - day.sellNext.length) ? ' (the rest wait: at most 5 coins)' : ''}.` : '',
    day.sellNext.length ? `Sell at tomorrow's open: ${list(day.sellNext)} (closed under the 20-day average).` : '',
    day.holding.length ? `Holding: ${list(day.holding)}.` : '',
  ].filter(Boolean);
  const done = [...day.sold, ...day.stopped], ev = done[0] || day.bought[0];
  const outcome = done.length ? 'closed' : day.bought.length ? 'opened' : day.buyNext.length ? 'order' : 'hold';
  const why = outcome === 'hold' ? (day.regime ? (day.holding.length ? 'Holding the trend; nothing to change today.' : 'No coin is trending today.') : day.holding.length ? 'Market filter off: holding what is still trending, no new buys.' : 'Market filter off: no new buys.') : lines.find(l => /^(Bought|Sold|Buy at)/.test(l));
  return {
    at: new Date(day.t + DAY).toISOString(), example: true, track: true, mode: 'rules', live: false,
    action: outcome === 'closed' ? 'close' : outcome === 'hold' ? 'hold' : 'open', asset: ev?.asset || (day.buyNext[0] ?? null), side: 'long', outcome,
    stop: ev?.stop ?? null, takeProfit: null, entry: day.bought[0]?.entry ?? null, pnl: done.length ? +done.reduce((s, x) => s + x.pnl, 0).toFixed(2) : null,
    riskPct: day.bought.length ? 3 : null, thesis: `${why}\n\n${lines.map(l => `- ${l}`).join('\n')}`, reasons: [],
    context: { prices: Object.fromEntries(Object.entries(day.coins).map(([a, c]) => [a, +c.close.toPrecision(6)])) },
    steps: [{ role: 'lead', model: 'Trend rider rules · paper track', text: lines.join('\n') }],
  };
}

/** Today's readings for the AI (completed days only). */
export function trendReadings(daily, now = Date.now()) {
  const done = Object.fromEntries(Object.entries(daily).map(([a, c]) => [a, c.filter(x => x.t + DAY <= now)]));
  const B = done['BTC-USD'] && indicators(done['BTC-USD']), bi = B ? B.c.length - 1 : -1;
  const market = bi >= TREND.btcN ? { btcVsAvg: B.cl[bi] / B.btcAvg[bi] - 1 } : null;
  const rows = Object.entries(done).map(([a, c]) => { const I = indicators(c), i = c.length - 1; return i < TREND.momN + 1 ? null : `- ${a} (${new Date(c[i].t).toISOString().slice(0, 10)} close ${px(I.cl[i])}): 20-day avg ${px(I.avg[i])} (${I.cl[i] > I.avg[i] ? 'above' : 'below'}), 20-day return ${pct(I.mom[i])}${market && market.btcVsAvg > 0 && I.cl[i] > I.avg[i] && I.mom[i] > 0 ? ' → TRENDING: may be bought' : I.cl[i] < I.avg[i] ? ' → under its average: sell if held' : ''}`; }).filter(Boolean);
  return `${market ? `Market filter ${market.btcVsAvg > 0 ? 'ON' : 'OFF'}: BTC ${pct(market.btcVsAvg)} vs its 50-day average.` : 'Market filter unknown.'}\n${rows.join('\n')}`;
}
