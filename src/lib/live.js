// Real-money execution on Kraken spot. Long only, no leverage, every buy protected by an exchange-side stop.
// mode 'validate': Kraken validates every order but executes nothing; fills are simulated at the live bid/ask.
// mode 'real': orders are placed for real.
import * as K from './kraken.js';
import { newAccount, equity } from './trading.js';

const r2 = x => Math.round(x * 100) / 100;
export const fmtPx = x => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toPrecision(7)) : x);
let refSeq = Math.floor(Date.now() / 1000) % 1e8;
const userref = () => (refSeq = (refSeq + 1) % 2e9);

export function newLive({ allocationUsd, mode, rules }) {
  return { enabled: true, mode, allocationUsd, startedAt: new Date().toISOString(),
    account: newAccount({ ...rules, starting_balance: allocationUsd }), pending: null };
}

/** Extra checks before any real-money buy: spot long only, liquid market, tight spread. */
export function liveChecks(p, tk, rules) {
  const reasons = [];
  if (p.side !== 'long') reasons.push('Real money is spot only: no shorting');
  const minVol = Number(rules.min_24h_volume_usd ?? 1000000), maxSpread = Number(rules.max_spread_pct ?? 0.5);
  if (tk.volume24hUsd < minVol) reasons.push(`24h volume $${Math.round(tk.volume24hUsd).toLocaleString('en-US')} < $${minVol.toLocaleString('en-US')}`);
  if (tk.spreadPct > maxSpread) reasons.push(`Spread ${tk.spreadPct.toFixed(2)}% > ${maxSpread}%`);
  if (Number(p.stop) >= tk.bid) reasons.push('Stop must be below the current bid');
  return reasons;
}

/** Size a buy so the loss at the stop is the strategy's risk, capped by the allocation and the Kraken balance. */
export function sizeBuy({ acc, riskPct, ask, stop, pair, quoteAvailable }) {
  const eq = equity(acc);
  const dist = ask - stop;
  if (!(dist > 0)) throw Object.assign(new Error('Stop must be below the entry'), { status: 400 });
  let qty = Math.min((eq * riskPct / 100) / dist, (eq * 0.98) / ask, (quoteAvailable * 0.98) / ask);
  qty = K.floorTo(qty, pair.lotDecimals);
  if (qty < pair.orderMin) throw Object.assign(new Error(`Position ${qty} is below Kraken's minimum ${pair.orderMin} ${pair.altname}`), { status: 400 });
  if (qty * ask < pair.costMin) throw Object.assign(new Error(`Order value below Kraken's minimum $${pair.costMin}`), { status: 400 });
  return qty;
}

export async function openLive({ creds, live, asset, p, rules, meta }) {
  const acc = live.account;
  const tk = await K.ticker(asset);
  const pair = tk.pair;
  const quoteAvailable = live.mode === 'real' ? await K.quoteBalance(creds, 'USD') : Infinity;
  const qty = sizeBuy({ acc, riskPct: Number(p.risk_pct), ask: tk.ask, stop: Number(p.stop), pair, quoteAvailable });
  const stopPx = K.roundPrice(Number(p.stop), pair);
  const ref = userref();
  let entry, fee, entryTxid = null, stopTxid = null;
  if (live.mode === 'validate') {
    await K.addOrder(creds, { pair: pair.altname, side: 'buy', ordertype: 'market', volume: qty, oflags: 'fciq', userref: ref, validate: true });
    await K.addOrder(creds, { pair: pair.altname, side: 'sell', ordertype: 'stop-loss', price: stopPx, volume: qty, userref: ref, validate: true });
    entry = tk.ask; fee = qty * tk.ask * (Number(rules.fee_pct) || 0.4) / 100;
  } else {
    live.pending = { asset, ref, at: new Date().toISOString() }; // recoverable by userref if we crash mid-order
    const res = await K.addOrder(creds, { pair: pair.altname, side: 'buy', ordertype: 'market', volume: qty, oflags: 'fciq', userref: ref });
    entryTxid = res.txid?.[0];
    const fill = await K.waitFilled(creds, entryTxid);
    entry = fill.price; fee = fill.fee;
    try {
      const st = await K.addOrder(creds, { pair: pair.altname, side: 'sell', ordertype: 'stop-loss', price: stopPx, volume: fill.volume, userref: ref });
      stopTxid = st.txid?.[0];
    } catch (e) {
      // never hold an unprotected position: sell straight back
      await K.addOrder(creds, { pair: pair.altname, side: 'sell', ordertype: 'market', volume: fill.volume, userref: ref }).catch(() => {});
      live.pending = null;
      throw Object.assign(new Error(`Stop order failed, position sold back at market: ${e.message}`), { status: 502 });
    }
    live.pending = null;
  }
  acc.balance -= fee;
  const pos = { asset, side: 'long', qty, entry, stop: stopPx, takeProfit: p.take_profit ? Number(p.take_profit) : null, riskUsd: qty * (entry - stopPx),
    fees: fee, openedAt: new Date().toISOString(), pair: pair.altname, entryTxid, stopTxid, ref, mode: live.mode, ...meta };
  acc.positions[asset] = pos;
  return pos;
}

function settle(acc, pos, exitPx, exitFee, reason) {
  const gross = (exitPx - pos.entry) * pos.qty;
  acc.balance += gross - exitFee;
  const pnl = gross - exitFee - pos.fees;
  const t = { ...pos, exit: exitPx, closedAt: new Date().toISOString(), reason, fees: pos.fees + exitFee, pnl: r2(pnl), r: pos.riskUsd > 0 ? r2(pnl / pos.riskUsd) : 0 };
  acc.trades.push(t); delete acc.positions[pos.asset];
  acc.peakEquity = Math.max(acc.peakEquity, equity(acc));
  return t;
}

export async function closeLive({ creds, live, asset, reason, rules }) {
  const acc = live.account, pos = acc.positions[asset];
  if (!pos) return null;
  if (pos.mode === 'validate') {
    const tk = await K.ticker(asset);
    await K.addOrder(creds, { pair: pos.pair, side: 'sell', ordertype: 'market', volume: pos.qty, validate: true });
    return settle(acc, pos, tk.bid, pos.qty * tk.bid * (Number(rules.fee_pct) || 0.4) / 100, reason);
  }
  if (pos.stopTxid) {
    try { await K.cancelOrder(creds, pos.stopTxid); }
    catch (e) {
      const o = (await K.queryOrders(creds, pos.stopTxid))[pos.stopTxid];
      if (o?.status === 'closed') return settle(acc, pos, Number(o.price), Number(o.fee), 'stop'); // stop filled first
      throw e;
    }
  }
  const res = await K.addOrder(creds, { pair: pos.pair, side: 'sell', ordertype: 'market', volume: pos.qty, userref: pos.ref });
  const fill = await K.waitFilled(creds, res.txid?.[0]);
  return settle(acc, pos, fill.price, fill.fee, reason);
}

/** Every tick: detect exchange-side stop fills, missing stops, take profits. */
export async function syncLive({ creds, live, rules, prices }) {
  const out = [];
  for (const pos of Object.values({ ...live.account.positions })) {
    const px = prices[pos.asset];
    if (pos.mode === 'validate') {
      if (typeof px === 'number' && px <= pos.stop) out.push(settle(live.account, pos, pos.stop, pos.qty * pos.stop * (Number(rules.fee_pct) || 0.4) / 100, 'stop'));
      else if (pos.takeProfit && px >= pos.takeProfit) out.push(await closeLive({ creds, live, asset: pos.asset, reason: 'take profit', rules }));
      continue;
    }
    const o = pos.stopTxid ? (await K.queryOrders(creds, pos.stopTxid))[pos.stopTxid] : null;
    if (o?.status === 'closed') out.push(settle(live.account, pos, Number(o.price), Number(o.fee), 'stop'));
    else if (!o || o.status === 'canceled' || o.status === 'expired') {
      pos.stopTxid = null; // stop removed outside the app: do not stay unprotected
      out.push(await closeLive({ creds, live, asset: pos.asset, reason: 'stop missing on Kraken', rules }));
    } else if (pos.takeProfit && typeof px === 'number' && px >= pos.takeProfit) out.push(await closeLive({ creds, live, asset: pos.asset, reason: 'take profit', rules }));
  }
  return out;
}

/** Daily-loss pause and drawdown stop on the live allocation. Returns 'paused' | 'stop' | null. */
export function liveRiskState(live, prices, rules, now = new Date()) {
  const acc = live.account, eq = equity(acc, prices), day = now.toISOString().slice(0, 10);
  acc.peakEquity = Math.max(acc.peakEquity, eq);
  if (!acc.dayStart || acc.dayStart.date !== day) acc.dayStart = { date: day, equity: eq };
  if (acc.paused && Date.parse(acc.paused.until) <= now.getTime()) acc.paused = null;
  const dd = (acc.peakEquity - eq) / acc.peakEquity * 100, dayLoss = (acc.dayStart.equity - eq) / acc.dayStart.equity * 100;
  if (dd >= (Number(rules.max_drawdown_pct) || 12)) return { action: 'stop', reason: `Live drawdown ${r2(dd)}% ≥ ${rules.max_drawdown_pct}%` };
  if (!acc.paused && dayLoss >= (Number(rules.daily_loss_pct) || 3)) {
    acc.paused = { until: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString(), reason: `Live daily loss ${r2(dayLoss)}% ≥ ${rules.daily_loss_pct}%` };
    return { action: 'paused', reason: acc.paused.reason };
  }
  return null;
}
