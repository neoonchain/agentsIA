// Hyperliquid (HyperCore) public market data: no key, no account. Used for paper trading on HyperCore perps today,
// and the market the Elysium contracts will trade on later.
// In Kairos a Hyperliquid market is written "<COIN>-PERP": BTC-PERP, WIF-PERP, KPEPE-PERP (kPEPE = 1,000 PEPE, as on Hyperliquid).
const API = 'https://api.hyperliquid.xyz/info';
const IV = { '1m': 60000, '1h': 3600000, '1d': 86400000 };

export const isPerp = a => typeof a === 'string' && /-PERP$/.test(a);

async function info(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return r.json();
}

let names = null, namesAt = 0;
/** Every listed perp as Kairos asset ids, e.g. ['BTC-PERP', 'KPEPE-PERP', ...]. */
export async function listPerps() {
  if (!names || Date.now() - namesAt > 3600000) {
    const meta = await info({ type: 'meta' });
    names = new Map(meta.universe.filter(u => !u.isDelisted).map(u => [u.name.toUpperCase(), u.name]));
    namesAt = Date.now();
  }
  return [...names.keys()].map(n => `${n}-PERP`);
}

/** Hyperliquid's own coin name for a Kairos asset id ("KPEPE-PERP" -> "kPEPE"). */
export async function coinOf(asset) {
  if (!isPerp(asset)) throw new Error(`${asset} is not a Hyperliquid market`);
  await listPerps();
  const coin = names.get(asset.slice(0, -5));
  if (!coin) throw new Error(`${asset} is not listed on Hyperliquid`);
  return coin;
}

export async function price(asset) {
  const coin = await coinOf(asset), mids = await info({ type: 'allMids' }), v = Number(mids[coin]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`No price for ${asset}`);
  return v;
}

const toCandle = r => ({ t: r.t, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v });

/** The last `limit` candles, oldest first (Hyperliquid serves up to 5,000 per request). */
export async function candles(asset, interval = '1h', limit = 48) {
  const coin = await coinOf(asset), end = Date.now();
  const rows = await info({ type: 'candleSnapshot', req: { coin, interval, startTime: end - IV[interval] * (limit + 2), endTime: end } });
  return rows.map(toCandle).slice(-limit);
}

/** Daily candles from `start` (ms) to now. */
export async function dailySince(asset, start) {
  const coin = await coinOf(asset);
  return (await info({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: start, endTime: Date.now() } })).map(toCandle);
}

/** Hourly funding rates since `start` (ms): [{ time, rate }]. Positive: longs pay shorts. */
export async function funding(asset, start) {
  const coin = await coinOf(asset);
  return (await info({ type: 'fundingHistory', coin, startTime: start })).map(f => ({ time: f.time, rate: +f.fundingRate }));
}
