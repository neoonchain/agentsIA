// "Dip buyer": buy a sharp 1-2 day dip in a coin that is in an uptrend, only while the whole market (BTC) is healthy.
// One engine for the research backtest, the paper track shipped with the app, and the daily update in the app.
//   Market:  BTC closes above its 200-day average and has not fallen more than 10% in 3 days.
//   Coin:    closes above its own 50-day average, and RSI(2) closes under 15 (a sharp dip).
//   Entry:   a buy limit at that close, valid the next day only (maker fee).
//   Exits:   close back above the 10-day average (with at least +0.5%), target 3 x ATR(14), stop 4 x ATR(14)
//            (3% to 20%), or 10 days. Stop and target the same day count as the stop.
//   Size:    1% of equity at risk, at most 25% of equity in one coin, at most 4 open at once.
// Fees: entries, targets and average exits are limit orders (0.25%); stops and time stops pay 0.40% + 0.05% slippage.
export const DIP_ASSETS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'ADA-USD', 'LINK-USD', 'LTC-USD'];
export const DIP = { rsiN: 2, rsiMax: 15, trendN: 50, exitN: 10, btcN: 200, btcCrash: 0.10, atrN: 14, stopATR: 4, minStop: 0.03, maxStop: 0.2, targetATR: 3, minGain: 0.005, timeD: 10, risk: 0.01, maxAlloc: 0.25, maxOpen: 4, maker: 0.0025, taker: 0.004, slip: 0.0005 };
export const DAY = 86400000;

const sma = (a, n) => { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; };
function rsi(cl, n) {
  const o = new Array(cl.length).fill(NaN); let g = 0, l = 0;
  for (let i = 1; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    if (i >= n) o[i] = 100 - 100 / (1 + g / (l || 1e-9));
  }
  return o;
}
const atr = (c, n) => sma(c.map((x, i) => i ? Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)) : x.high - x.low), n);

/** Indicators for one coin's daily candles (oldest first, complete days only). */
export function indicators(c) {
  const cl = c.map(x => x.close);
  return { c, cl, trend: sma(cl, DIP.trendN), exit: sma(cl, DIP.exitN), long: sma(cl, DIP.btcN), rsi: rsi(cl, DIP.rsiN), atr: atr(c, DIP.atrN), idx: new Map(c.map((x, i) => [x.t, i])) };
}

export const newTrack = (startT, balance = 10000) => ({ eq: balance, start: balance, peak: balance, maxDD: 0, pos: {}, pend: {}, lastT: startT - DAY });

/**
 * Walk the rules day by day over complete daily candles, from the day after state.lastT up to `toT` (inclusive).
 * Returns the closed trades and the decisions of each day; mutates and returns `state` so the track can resume tomorrow.
 */
export function stepTrack(state, daily, toT, onDay) {
  const IND = Object.fromEntries(Object.entries(daily).map(([a, c]) => [a, indicators(c)])), B = IND['BTC-USD'];
  const trades = [];
  if (!B) return { state, trades };
  for (const t of B.c.map(x => x.t).filter(t => t > state.lastT && t <= toT)) {
    const bi = B.idx.get(t);
    if (!(bi >= DIP.btcN)) { state.lastT = t; continue; }
    const btcUp = B.cl[bi] > B.long[bi], btc3d = B.cl[bi] / B.cl[bi - 3] - 1, regime = btcUp && btc3d > -DIP.btcCrash;
    const day = { t, btcVsAvg: B.cl[bi] / B.long[bi] - 1, btc3d, regime, signals: [], fills: [], exits: [], coins: {} };
    for (const a of DIP_ASSETS) {
      const I = IND[a], i = I?.idx.get(t);
      if (i == null || i < 60 || I.c[i].t - I.c[i - 60].t > 62 * DAY) continue; // need 60 days without a gap
      const bar = I.c[i], p = state.pos[a];
      day.coins[a] = { close: I.cl[i], up: I.cl[i] > I.trend[i], rsi: +I.rsi[i].toFixed(1) };
      if (p) {
        let exit = null, why;
        if (bar.low <= p.stop) { exit = Math.min(p.stop, bar.open) * (1 - DIP.slip); why = 'stop'; }
        else if (bar.high >= p.tp) { exit = Math.max(p.tp, bar.open); why = 'take profit'; }
        else if (bar.close > I.exit[i] && bar.close > p.entry * (1 + DIP.minGain)) { exit = bar.close; why = 'back above the 10-day average'; }
        else if (Math.round((t - p.t) / DAY) >= DIP.timeD) { exit = bar.close * (1 - DIP.slip); why = 'time stop'; }
        if (exit) {
          const taker = why === 'stop' || why === 'time stop';
          const fees = p.qty * p.entry * DIP.maker + p.qty * exit * (taker ? DIP.taker : DIP.maker), pnl = p.qty * (exit - p.entry) - fees;
          state.eq += pnl; state.peak = Math.max(state.peak, state.eq); state.maxDD = Math.max(state.maxDD, 1 - state.eq / state.peak);
          const tr = { ...p, asset: a, closedT: t, exit, pnl, r: pnl / p.risk, why, fees, days: Math.round((t - p.t) / DAY) + 1 };
          trades.push(tr); day.exits.push(tr); delete state.pos[a];
        }
        continue;
      }
      const o = state.pend[a];
      if (o) {
        delete state.pend[a];
        if (bar.low <= o.limit && Object.keys(state.pos).length < DIP.maxOpen) {
          const entry = Math.min(o.limit, bar.open), stop = entry * (1 - o.sl), tp = entry * (1 + o.tp);
          const qty = Math.min(state.eq * DIP.risk / (entry - stop), state.eq * DIP.maxAlloc / entry);
          state.pos[a] = { t, entry, stop, tp, qty, risk: qty * (entry - stop), ctx: o.ctx };
          day.fills.push({ asset: a, ...state.pos[a] });
        }
        continue;
      }
      if (!regime || !(I.cl[i] > I.trend[i]) || !(I.rsi[i] < DIP.rsiMax)) continue;
      const sl = Math.min(DIP.maxStop, Math.max(DIP.minStop, DIP.stopATR * I.atr[i] / I.cl[i])), tp = DIP.targetATR * I.atr[i] / I.cl[i];
      const ctx = { signalT: t, btcVsAvg: +day.btcVsAvg.toFixed(4), btc3d: +btc3d.toFixed(4), vsTrend: +(I.cl[i] / I.trend[i] - 1).toFixed(4), rsi: +I.rsi[i].toFixed(1), drop3d: +(I.cl[i] / I.cl[i - 3] - 1).toFixed(4), atrPct: +(I.atr[i] / I.cl[i]).toFixed(4) };
      state.pend[a] = { limit: I.cl[i], sl, tp, ctx }; day.signals.push({ asset: a, ...state.pend[a] });
    }
    state.lastT = t; day.holding = Object.keys(state.pos);
    onDay?.(day);
  }
  return { state, trades };
}

export function summary(trades) {
  const w = trades.filter(x => x.pnl > 0), gw = w.reduce((s, x) => s + x.pnl, 0), gl = -trades.filter(x => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0);
  return { n: trades.length, wins: w.length, winRate: trades.length ? w.length / trades.length : 0, profitFactor: gl ? gw / gl : null, pnl: gw - gl };
}

const pct = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const px = v => v >= 1000 ? Math.round(v).toLocaleString('en-US') : v >= 1 ? +v.toFixed(2) : +v.toPrecision(4);

/** A journal entry for one closed track trade: what the market looked like, why it bought, how it ended. */
export function trackJournalEntry(tr, headlines = []) {
  const c = tr.ctx, coin = tr.asset.split('-')[0], win = tr.pnl > 0;
  const day = new Date(c.signalT).toISOString().slice(0, 10);
  const r = +tr.r.toFixed(2), pnl = +tr.pnl.toFixed(2);
  return {
    date: new Date(tr.t).toISOString().slice(0, 10) + 'T00:00', asset: tr.asset, side: 'long', entry: +px(tr.entry), stop: +px(tr.stop), exit: +px(tr.exit), size: +tr.qty.toPrecision(5), pnl, r,
    strategy: 'Dip buyer', emotion: 'rules-based', tags: `example, paper-track, dip-buyer, ${tr.why === 'take profit' ? 'take-profit' : tr.why === 'stop' ? 'stop' : tr.why === 'time stop' ? 'time-stop' : 'average-exit'}`,
    thesis: [
      `Market on ${day}: BTC ${pct(c.btcVsAvg)} vs its 200-day average and ${pct(c.btc3d)} over 3 days, so the market filter was on.`,
      `${coin} was ${pct(c.vsTrend)} above its 50-day average (uptrend) and ${c.drop3d < 0 ? `fell ${(-c.drop3d * 100).toFixed(1)}%` : `moved ${pct(c.drop3d)}`} in 3 days: RSI(2) ${c.rsi}, a sharp dip.`,
      `Buy limit at that close, filled the next day at ${px(tr.entry)}. Stop ${px(tr.stop)} (4 x ATR, ${pct(tr.stop / tr.entry - 1)}), target ${px(tr.tp)} (3 x ATR). Risk 1% of the paper account.`,
      headlines.length ? `Headlines that day: ${headlines.map(h => `"${h}"`).join('; ')}.` : '',
    ].filter(Boolean).join('\n\n'),
    psychology: 'No discretion: the rules bought, sized at 1% risk and sold. Paper track of the Dip buyer rules, updated every day on real Coinbase prices.',
    wentWell: win ? `- Closed ${tr.why} after ${tr.days} day${tr.days > 1 ? 's' : ''}: +${pnl} USD (${r}R).` : '- The loss stayed inside the planned risk.',
    wentWrong: win ? (r < 0.2 ? '- A small win: the bounce was short, and fees took part of it.' : '') : `- Closed by ${tr.why} after ${tr.days} days: ${pnl} USD (${r}R). The dip kept going instead of bouncing.`,
  };
}

/** Today's readings for the AI (completed days only): the same numbers the rules use, so the model does not have to guess them. */
export function dailyReadings(daily, now = Date.now()) {
  const done = Object.fromEntries(Object.entries(daily).map(([a, c]) => [a, c.filter(x => x.t + DAY <= now)]));
  const out = {}, B = done['BTC-USD'] && indicators(done['BTC-USD']), bi = B ? B.c.length - 1 : -1;
  const market = B && bi >= DIP.btcN ? { btcVsAvg: B.cl[bi] / B.long[bi] - 1, btc3d: B.cl[bi] / B.cl[bi - 3] - 1 } : null;
  if (market) market.on = market.btcVsAvg > 0 && market.btc3d > -DIP.btcCrash;
  for (const [a, c] of Object.entries(done)) {
    const I = indicators(c), i = c.length - 1; if (i < 60) continue;
    const signal = !!market?.on && I.cl[i] > I.trend[i] && I.rsi[i] < DIP.rsiMax;
    const sl = Math.min(DIP.maxStop, Math.max(DIP.minStop, DIP.stopATR * I.atr[i] / I.cl[i]));
    out[a] = { day: new Date(c[i].t).toISOString().slice(0, 10), close: I.cl[i], avg50: I.trend[i], avg10: I.exit[i], rsi2: I.rsi[i], atr: I.atr[i], signal, limit: I.cl[i], stop: I.cl[i] * (1 - sl), target: I.cl[i] * (1 + DIP.targetATR * I.atr[i] / I.cl[i]) };
  }
  return { market, assets: out };
}

export function readingsText(r) {
  const f = v => px(v);
  const m = r.market ? `Market filter ${r.market.on ? 'ON' : 'OFF'}: BTC ${pct(r.market.btcVsAvg)} vs its 200-day average, ${pct(r.market.btc3d)} over 3 days.` : 'Market filter unknown (not enough BTC history).';
  return [m, ...Object.entries(r.assets).map(([a, x]) => `- ${a} (${x.day} close ${f(x.close)}): 50-day avg ${f(x.avg50)} (${x.close > x.avg50 ? 'above' : 'below'}), 10-day avg ${f(x.avg10)}, RSI(2) ${x.rsi2.toFixed(1)}, ATR ${f(x.atr)}${x.signal ? ` → RULES SIGNAL: buy limit ${f(x.limit)}, stop ${f(x.stop)}, target ${f(x.target)}` : ''}`)].join('\n');
}

/** One day of the track as an entry for "How the AI decided": what the rules looked at, what they did and why. */
export function trackDecision(day) {
  const coin = a => a.split('-')[0], list = xs => xs.map(coin).join(', ');
  const coins = Object.entries(day.coins || {}), busy = new Set([...(day.holding || []), ...[...day.fills, ...day.exits, ...day.signals].map(x => x.asset)]);
  const free = coins.filter(([a]) => !busy.has(a)), down = free.filter(([, c]) => !c.up).map(([a]) => a), calm = free.filter(([, c]) => c.up && c.rsi >= DIP.rsiMax).map(([a]) => a);
  const lines = [
    `Market filter ${day.regime ? 'ON' : 'OFF'}: BTC ${pct(day.btcVsAvg)} vs its 200-day average, ${pct(day.btc3d)} over 3 days${day.regime ? '.' : day.btcVsAvg <= 0 ? ': BTC is under its 200-day average, no new buys.' : ': BTC fell more than 10% in 3 days, no new buys.'}`,
    down.length ? `Under their 50-day average (downtrend, not bought): ${list(down)}.` : '',
    calm.length ? `In an uptrend but no sharp dip (RSI(2) 15 or more): ${list(calm)}.` : '',
    ...day.signals.map(x => `${coin(x.asset)} dipped in an uptrend (RSI(2) ${x.ctx.rsi}, ${pct(x.ctx.vsTrend)} above its 50-day average): buy limit ${px(x.limit)} for tomorrow, stop ${px(x.limit * (1 - x.sl))}, target ${px(x.limit * (1 + x.tp))}.`),
    ...day.fills.map(x => `${coin(x.asset)} buy limit filled at ${px(x.entry)}: ${+x.qty.toPrecision(4)} ${coin(x.asset)}, stop ${px(x.stop)}, target ${px(x.tp)}, 1% of the account at risk.`),
    ...day.exits.map(x => `${coin(x.asset)} closed (${x.why}) at ${px(x.exit)} after ${x.days} day${x.days > 1 ? 's' : ''}: ${x.pnl >= 0 ? '+' : ''}${x.pnl.toFixed(2)} USD (${x.r >= 0 ? '+' : ''}${x.r.toFixed(2)}R).`),
    day.holding?.length ? `Still holding: ${list(day.holding)}.` : '',
  ].filter(Boolean);
  const ev = day.exits[0] || day.fills[0] || day.signals[0];
  const outcome = day.exits.length ? 'closed' : day.fills.length ? 'opened' : day.signals.length ? 'order' : 'hold';
  const why = outcome === 'hold' ? (!day.regime ? 'Market filter off: no new buys.' : !coins.length ? 'No data.' : `No dip in an uptrend today${down.length === coins.length ? ': every coin is under its 50-day average' : ''}.`) : lines.slice(1).find(l => ev && l.startsWith(coin(ev.asset))) || lines[0];
  return {
    at: new Date(day.t + DAY).toISOString(), example: true, track: true, mode: 'rules', live: false,
    action: outcome === 'closed' ? 'close' : outcome === 'hold' ? 'hold' : 'open', asset: ev?.asset || null, side: ev ? 'long' : null, outcome,
    stop: ev?.stop ?? null, takeProfit: ev?.tp ?? null, entry: day.fills[0]?.entry ?? null, pnl: day.exits.length ? +day.exits.reduce((s, x) => s + x.pnl, 0).toFixed(2) : null,
    riskPct: day.fills.length ? 1 : null, thesis: `${why}\n\n${lines.map(l => `- ${l}`).join('\n')}`, reasons: [],
    context: { prices: Object.fromEntries(coins.map(([a, c]) => [a, +c.close.toPrecision(6)])) },
    steps: [{ role: 'lead', model: 'Dip buyer rules · paper track', text: lines.join('\n') }],
  };
}
