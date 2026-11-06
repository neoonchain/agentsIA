// Paper broker, metrics, Brake (risk rules in plain code) and the promotion evaluator.

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const DAY = 86400000;

/* ---------------- metrics ---------------- */
export function metrics(trades, startBalance = 10000) {
  const closed = trades.filter(t => typeof t.pnl === 'number');
  const wins = closed.filter(t => t.pnl > 0), losses = closed.filter(t => t.pnl < 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0), gl = -losses.reduce((s, t) => s + t.pnl, 0);
  let eq = startBalance, peak = startBalance, maxDD = 0;
  for (const t of closed) { eq += t.pnl; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak > 0 ? (peak - eq) / peak : 0); }
  const rs = closed.map(t => t.r).filter(r => typeof r === 'number');
  const times = closed.map(t => Date.parse(t.openedAt || t.date)).filter(Number.isFinite);
  const first = times.length ? Math.min(...times) : null;
  return {
    count: closed.length, wins: wins.length, losses: losses.length,
    winRate: closed.length ? round((wins.length / closed.length) * 100, 1) : 0,
    // undefined until there is at least one loss: never report an 'infinite' edge
    profitFactor: gl > 0 ? round(gp / gl) : null,
    totalPnl: round(gp - gl), avgR: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : 0,
    maxDrawdownPct: round(maxDD * 100), firstAt: first ? new Date(first).toISOString() : null,
  };
}

/* ---------------- paper account ---------------- */
export function newAccount(rules) {
  const b = Number(rules.starting_balance) || 10000;
  return { startBalance: b, balance: b, peakEquity: b, positions: {}, trades: [], dayStart: null, paused: null,
    proposals: { total: 0, offStrategy: 0 }, createdAt: new Date().toISOString(), lastDecisionAt: null };
}

export function equity(acc, prices = {}) {
  let e = acc.balance;
  for (const [asset, p] of Object.entries(acc.positions)) {
    const px = prices[asset] ?? p.entry;
    e += (px - p.entry) * p.qty * (p.side === 'long' ? 1 : -1);
  }
  return e;
}

export function openPosition(acc, { asset, side, price, stop, takeProfit, riskPct, rules, meta = {}, now = new Date() }) {
  const slip = (Number(rules.slippage_pct) || 0) / 100, fee = (Number(rules.fee_pct) || 0) / 100;
  const fill = side === 'long' ? price * (1 + slip) : price * (1 - slip);
  const dist = Math.abs(fill - stop);
  if (!(dist > 0)) throw new Error('Stop must differ from entry');
  const eq = equity(acc);
  const riskUsd = eq * (riskPct / 100);
  let qty = riskUsd / dist;
  if (qty * fill > eq) qty = eq / fill; // no leverage on paper
  const feeUsd = qty * fill * fee;
  acc.balance -= feeUsd;
  acc.positions[asset] = { asset, side, qty, entry: fill, stop, takeProfit: takeProfit ?? null, riskUsd: qty * dist, fees: feeUsd, openedAt: now.toISOString(), ...meta };
  return acc.positions[asset];
}

export function closePosition(acc, asset, price, reason, rules, now = new Date()) {
  const p = acc.positions[asset];
  if (!p) return null;
  const slip = (Number(rules.slippage_pct) || 0) / 100, fee = (Number(rules.fee_pct) || 0) / 100;
  const fill = p.side === 'long' ? price * (1 - slip) : price * (1 + slip);
  const dir = p.side === 'long' ? 1 : -1;
  const exitFee = p.qty * fill * fee;
  const gross = (fill - p.entry) * p.qty * dir;
  acc.balance += gross - exitFee;
  const pnl = gross - exitFee - p.fees;
  const trade = { ...p, exit: fill, closedAt: now.toISOString(), reason, fees: p.fees + exitFee,
    pnl: round(pnl), r: p.riskUsd > 0 ? round(pnl / p.riskUsd) : 0 };
  acc.trades.push(trade);
  delete acc.positions[asset];
  acc.peakEquity = Math.max(acc.peakEquity, equity(acc));
  return trade;
}

/** Remember how far each open position went for and against us, in R (used for lessons). */
export function trackExcursion(acc, prices) {
  for (const p of Object.values(acc.positions)) {
    const px = prices[p.asset];
    if (typeof px !== 'number') continue;
    const dist = Math.abs(p.entry - p.stop) || 1, r = ((px - p.entry) * (p.side === 'long' ? 1 : -1)) / dist;
    p.mfeR = Math.max(p.mfeR ?? 0, r); p.maeR = Math.min(p.maeR ?? 0, r);
  }
}

/** Close any position whose stop or take profit the price has reached. */
export function checkExits(acc, prices, rules, now = new Date()) {
  const closed = [];
  for (const p of Object.values({ ...acc.positions })) {
    const px = prices[p.asset];
    if (typeof px !== 'number') continue;
    const long = p.side === 'long';
    if (long ? px <= p.stop : px >= p.stop) closed.push(closePosition(acc, p.asset, p.stop, 'stop', rules, now));
    else if (p.takeProfit && (long ? px >= p.takeProfit : px <= p.takeProfit)) closed.push(closePosition(acc, p.asset, p.takeProfit, 'take profit', rules, now));
  }
  return closed;
}

/* ---------------- Brake ---------------- */
function inHours(spec, now) {
  const m = String(spec || '').match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return true;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}

/** Roll the day, apply the daily-loss pause and the drawdown stop. Returns events that happened. */
export function riskTick(acc, prices, rules, now = new Date()) {
  const events = [];
  const day = now.toISOString().slice(0, 10);
  const eq = equity(acc, prices);
  acc.peakEquity = Math.max(acc.peakEquity, eq);
  if (!acc.dayStart || acc.dayStart.date !== day) acc.dayStart = { date: day, equity: eq };
  if (acc.paused && Date.parse(acc.paused.until) <= now.getTime()) { events.push({ type: 'resumed' }); acc.paused = null; }
  const dayLoss = (acc.dayStart.equity - eq) / acc.dayStart.equity * 100;
  const dd = (acc.peakEquity - eq) / acc.peakEquity * 100;
  const maxDD = Number(rules.max_drawdown_pct) || 12, maxDay = Number(rules.daily_loss_pct) || 3;
  if (dd >= maxDD) {
    for (const a of Object.keys(acc.positions)) events.push({ type: 'closed', trade: closePosition(acc, a, prices[a] ?? acc.positions[a].entry, 'max drawdown', rules, now) });
    events.push({ type: 'stop', reason: `Max drawdown ${round(dd)}% ≥ ${maxDD}%` });
  } else if (!acc.paused && dayLoss >= maxDay) {
    for (const a of Object.keys(acc.positions)) events.push({ type: 'closed', trade: closePosition(acc, a, prices[a] ?? acc.positions[a].entry, 'daily loss limit', rules, now) });
    const until = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    acc.paused = { until: until.toISOString(), reason: `Daily loss ${round(dayLoss)}% ≥ ${maxDay}%` };
    events.push({ type: 'paused', reason: acc.paused.reason });
  }
  return events;
}

/**
 * Check a model's proposal against the strategy and your rules.
 * offStrategy marks violations of the strategy itself (they count against adherence).
 */
export function brake(proposal, { strategy, rules, acc, price, now = new Date(), mode, reviewerAgreed }) {
  const reasons = []; let offStrategy = false;
  const action = proposal?.action;
  if (action === 'hold') return { ok: true, reasons, offStrategy };
  if (action === 'close') {
    if (!acc.positions[proposal.asset]) reasons.push('No open position to close');
    return { ok: !reasons.length, reasons, offStrategy };
  }
  if (action !== 'open') return { ok: false, reasons: ['Unknown action'], offStrategy: true };
  const assets = (strategy.assets || []).map(String);
  if (!assets.includes(proposal.asset)) { reasons.push(`${proposal.asset} is not in the strategy`); offStrategy = true; }
  if (!inHours(strategy.hours_utc, now)) { reasons.push(`Outside strategy hours ${strategy.hours_utc} UTC`); offStrategy = true; }
  if (proposal.side !== 'long' && proposal.side !== 'short') { reasons.push('Side must be long or short'); offStrategy = true; }
  const stop = Number(proposal.stop);
  if (!Number.isFinite(stop) || stop <= 0) { reasons.push('A stop is required'); offStrategy = true; }
  else if (proposal.side === 'long' ? stop >= price : stop <= price) { reasons.push('Stop is on the wrong side of the price'); offStrategy = true; }
  const tp = proposal.take_profit == null ? null : Number(proposal.take_profit);
  if (tp !== null && (!Number.isFinite(tp) || (proposal.side === 'long' ? tp <= price : tp >= price))) { reasons.push('Take profit is on the wrong side of the price'); offStrategy = true; }
  const maxRisk = Math.min(Number(strategy.risk_per_trade_pct) || 1, Number(rules.max_risk_per_trade_pct) || 2);
  if (!(Number(proposal.risk_pct) > 0) || Number(proposal.risk_pct) > maxRisk) { reasons.push(`Risk must be >0 and ≤ ${maxRisk}%`); offStrategy = true; }
  if (acc.positions[proposal.asset]) reasons.push(`Already in a ${proposal.asset} position`);
  if (acc.paused) reasons.push(`Paused: ${acc.paused.reason}`);
  if (mode === 'team' && reviewerAgreed === false) reasons.push('The reviewing model did not agree');
  return { ok: !reasons.length, reasons, offStrategy };
}

/* ---------------- evaluator ---------------- */
export function evaluate(acc, rules, now = new Date()) {
  const m = metrics(acc.trades, acc.startBalance);
  const start = Date.parse(acc.createdAt);
  const days = Number.isFinite(start) ? Math.floor((now.getTime() - start) / DAY) : 0;
  const adherence = acc.proposals.total ? round((1 - acc.proposals.offStrategy / acc.proposals.total) * 100, 1) : 100;
  const R = k => Number(rules[k]);
  const checks = [
    { key: 'min_trades', label: `Paper trades ≥ ${R('min_trades')}`, value: m.count, pass: m.count >= R('min_trades') },
    { key: 'min_days', label: `Days on paper ≥ ${R('min_days')}`, value: days, pass: days >= R('min_days') },
    { key: 'min_profit_factor', label: `Profit factor ≥ ${R('min_profit_factor')}`, value: m.profitFactor ?? 'n/a (no losses yet)', pass: m.profitFactor !== null && m.profitFactor >= R('min_profit_factor') },
    { key: 'max_drawdown_pct', label: `Max drawdown ≤ ${R('max_drawdown_pct')}%`, value: m.maxDrawdownPct + '%', pass: m.maxDrawdownPct <= R('max_drawdown_pct') },
    { key: 'min_adherence_pct', label: `Follows strategy ≥ ${R('min_adherence_pct')}%`, value: adherence + '%', pass: adherence >= R('min_adherence_pct') },
    { key: 'net_profit', label: 'Net profit > 0', value: m.totalPnl, pass: m.totalPnl > 0 },
  ];
  return { metrics: m, days, adherence, checks, eligible: checks.every(c => c.pass) };
}
