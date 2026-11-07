// Public crypto prices: Coinbase first, Kraken as fallback (covers memecoins Coinbase lacks). No keys needed.
import * as K from './kraken.js';
const cache = new Map();
const TTL = 15000;
let mock = null; // { prices: {asset: number}, candles?: [...] } for tests

export function setMockMarket(m) { mock = m; cache.clear(); }


async function getJSON(url) {
  const r = await fetch(url, { headers: typeof window === 'undefined' ? { 'User-Agent': 'kairos/0.1' } : {}, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

export function validAsset(a) { return typeof a === 'string' && /^[A-Z0-9]{2,10}-[A-Z]{3,4}$/.test(a); }

export async function getPrice(asset) {
  if (!validAsset(asset)) throw new Error(`Invalid asset ${asset}`);
  if (mock) { if (typeof mock.prices[asset] !== 'number') throw new Error(`No price for ${asset}`); return mock.prices[asset]; }
  const hit = cache.get('p:' + asset);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  let v;
  try {
    v = Number((await getJSON(`https://api.coinbase.com/v2/prices/${asset}/spot`)).data.amount);
  } catch (e) {
    v = (await K.ticker(asset)).last;
  }
  if (!Number.isFinite(v) || v <= 0) throw new Error(`Bad price for ${asset}`);
  cache.set('p:' + asset, { t: Date.now(), v });
  return v;
}

/** Hourly candles, oldest first: {t, open, high, low, close, volume}. */
export async function getCandles(asset, limit = 48) {
  if (!validAsset(asset)) throw new Error(`Invalid asset ${asset}`);
  if (mock) return (mock.candles || []).slice(-limit);
  const hit = cache.get('c:' + asset);
  if (hit && Date.now() - hit.t < 60000) return hit.v.slice(-limit);
  let v;
  try {
    const rows = await getJSON(`https://api.exchange.coinbase.com/products/${asset}/candles?granularity=3600`);
    v = rows.map(([t, low, high, open, close, volume]) => ({ t: t * 1000, open, high, low, close, volume })).sort((a, b) => a.t - b.t);
  } catch { v = await K.ohlc(asset, 60); }
  cache.set('c:' + asset, { t: Date.now(), v });
  return v.slice(-limit);
}

/** Daily candles, oldest first (Coinbase, Kraken fallback). Used for the trend filter. `fresh` skips the cache. */
export async function getDailyCandles(asset, limit = 60, { fresh = false } = {}) {
  if (!validAsset(asset)) throw new Error(`Invalid asset ${asset}`);
  if (mock) return (mock.daily?.[asset] || []).slice(-limit);
  const hit = cache.get('d:' + asset);
  if (!fresh && hit && Date.now() - hit.t < 15 * 60000) return hit.v.slice(-limit);
  let v;
  try {
    const rows = await getJSON(`https://api.exchange.coinbase.com/products/${asset}/candles?granularity=86400`);
    v = rows.map(([t, low, high, open, close, volume]) => ({ t: t * 1000, open, high, low, close, volume })).sort((a, b) => a.t - b.t);
  } catch { v = await K.ohlc(asset, 1440); }
  cache.set('d:' + asset, { t: Date.now(), v });
  return v.slice(-limit);
}

/** Daily candles from `start` (ms) to now, 300 per request (Coinbase only), for catching up after a long gap. */
export async function getDailyRange(asset, start) {
  if (!validAsset(asset)) throw new Error(`Invalid asset ${asset}`);
  if (mock) return (mock.daily?.[asset] || []).filter(c => c.t >= start);
  const rows = new Map(), D = 86400000, end = Date.now();
  for (let t = start; t < end; t += 300 * D) {
    const r = await getJSON(`https://api.exchange.coinbase.com/products/${asset}/candles?granularity=86400&start=${new Date(t).toISOString()}&end=${new Date(Math.min(end, t + 300 * D)).toISOString()}`);
    for (const [ts, low, high, open, close, volume] of r) rows.set(ts * 1000, { t: ts * 1000, open, high, low, close, volume });
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}

/** With the trend: price above its 20-day average, and the 20-day above the 50-day. null without enough data. */
export function dailyTrend(daily, price) {
  if (!daily || daily.length < 51) return null;
  const closes = daily.slice(-51, -1).map(c => c.close); // completed days only
  const avg = n => closes.slice(-n).reduce((s, x) => s + x, 0) / n;
  const s20 = avg(20), s50 = avg(50), p = price ?? daily.at(-1).close;
  return { s20: +s20.toPrecision(6), s50: +s50.toPrecision(6), ok: p > s20 && s20 > s50 };
}

/** 1-minute candles, oldest first (Coinbase, Kraken fallback). Used by the shock detector. */
export async function getCandles1m(asset, limit = 61) {
  if (!validAsset(asset)) throw new Error(`Invalid asset ${asset}`);
  if (mock) return (mock.candles1m?.[asset] || []).slice(-limit);
  let v;
  try {
    const rows = await getJSON(`https://api.exchange.coinbase.com/products/${asset}/candles?granularity=60`);
    v = rows.map(([t, low, high, open, close, volume]) => ({ t: t * 1000, open, high, low, close, volume })).sort((a, b) => a.t - b.t);
  } catch { v = await K.ohlc(asset, 1); }
  return v.slice(-limit);
}

export function candleSummary(c) {
  if (!c.length) return 'No candle data.';
  const hi = Math.max(...c.map(x => x.high)), lo = Math.min(...c.map(x => x.low));
  const avgVol = c.reduce((s, x) => s + x.volume, 0) / c.length;
  const rows = c.slice(-24).map(x => `${new Date(x.t).toISOString().slice(5, 16)} O${x.open} H${x.high} L${x.low} C${x.close} V${Math.round(x.volume)}`);
  return `Last ${c.length}h range ${lo}–${hi}, average volume ${Math.round(avgVol)}.\nLast 24 hourly candles (UTC):\n${rows.join('\n')}`;
}
