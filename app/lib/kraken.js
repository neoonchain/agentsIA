// Kraken spot REST client: public market data + signed private calls. No dependencies.
import crypto from 'node:crypto';

const base = () => (process.env.KRAKEN_URL || 'https://api.kraken.com').replace(/\/+$/, '');
const ALIAS = { BTC: 'XBT', DOGE: 'XDG' }; // Kraken's own names for these bases

export class KrakenError extends Error {
  constructor(msg, errors = []) { super(msg); this.errors = errors; this.status = 502; }
}

/** API-Sign = base64(HMAC-SHA512(base64decode(secret), path + SHA256(nonce + postdata))) */
export function sign(path, postData, nonce, secret) {
  const sha = crypto.createHash('sha256').update(String(nonce) + postData).digest();
  return crypto.createHmac('sha512', Buffer.from(secret, 'base64')).update(Buffer.concat([Buffer.from(path), sha])).digest('base64');
}

let lastNonce = 0;
const nextNonce = () => (lastNonce = Math.max(Date.now() * 1000, lastNonce + 1));

async function publicGet(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${base()}/0/public/${path}${qs ? '?' + qs : ''}`, { signal: AbortSignal.timeout(10000) });
  const j = await r.json().catch(() => ({}));
  if (j.error?.length) throw new KrakenError(`Kraken: ${j.error.join(', ')}`, j.error);
  if (!r.ok || !j.result) throw new KrakenError(`Kraken HTTP ${r.status}`);
  return j.result;
}

export async function privatePost(creds, method, params = {}) {
  if (!creds?.key || !creds?.secret) throw Object.assign(new Error('Add your Kraken API key in Team settings'), { status: 400, code: 'NEED_EXCHANGE' });
  const path = `/0/private/${method}`;
  const nonce = nextNonce();
  const body = new URLSearchParams({ nonce: String(nonce), ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) }).toString();
  const r = await fetch(base() + path, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'API-Key': creds.key, 'API-Sign': sign(path, body, nonce, creds.secret), 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'User-Agent': 'kairos/0.1' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (j.error?.length) throw new KrakenError(`Kraken: ${j.error.join(', ')}`, j.error);
  if (!r.ok || j.result === undefined) throw new KrakenError(`Kraken HTTP ${r.status}`);
  return j.result;
}

/* ---------- pairs (cached) ---------- */
let pairsCache = null;
export function clearPairCache() { pairsCache = null; }
async function pairs() {
  if (pairsCache && Date.now() - pairsCache.t < 3600000) return pairsCache.v;
  const v = await publicGet('AssetPairs');
  pairsCache = { t: Date.now(), v };
  return v;
}

/** 'DOGE-USD' → Kraken pair info with precision and minimums. */
export async function resolvePair(asset) {
  const [b, q] = String(asset).split('-');
  const all = await pairs();
  const want = [`${b}/${q}`, `${ALIAS[b] || b}/${q}`];
  for (const [key, p] of Object.entries(all)) {
    if (want.includes(p.wsname) && p.status !== 'delisted') {
      return { key, altname: p.altname, base: p.base, quote: p.quote, lotDecimals: p.lot_decimals, priceDecimals: p.pair_decimals,
        orderMin: Number(p.ordermin) || 0, costMin: Number(p.costmin) || 0, tickSize: Number(p.tick_size) || 10 ** -p.pair_decimals, status: p.status };
    }
  }
  throw Object.assign(new Error(`${asset} is not tradable on Kraken`), { status: 400 });
}

export async function ticker(asset) {
  const p = await resolvePair(asset);
  const t = Object.values(await publicGet('Ticker', { pair: p.altname }))[0];
  const ask = Number(t.a[0]), bid = Number(t.b[0]), last = Number(t.c[0]);
  return { pair: p, ask, bid, last, mid: (ask + bid) / 2, spreadPct: ((ask - bid) / ((ask + bid) / 2)) * 100, volume24hUsd: Number(t.v[1]) * Number(t.p[1]) };
}

export async function ohlc(asset, intervalMin = 60) {
  const p = await resolvePair(asset);
  const r = await publicGet('OHLC', { pair: p.altname, interval: intervalMin });
  const rows = Object.entries(r).find(([k]) => k !== 'last')?.[1] || [];
  return rows.map(([t, open, high, low, close, , volume]) => ({ t: t * 1000, open: +open, high: +high, low: +low, close: +close, volume: +volume }));
}

/* ---------- precision ---------- */
export const floorTo = (x, d) => Math.floor(x * 10 ** d + 1e-9) / 10 ** d;
export function roundPrice(x, p) { return Number((Math.round(x / p.tickSize) * p.tickSize).toFixed(p.priceDecimals)); }

/* ---------- account ---------- */
const QUOTE_KEYS = { USD: ['ZUSD', 'USD'], EUR: ['ZEUR', 'EUR'] };
export async function balances(creds) { return privatePost(creds, 'Balance'); }
export async function quoteBalance(creds, quote = 'USD') {
  const b = await balances(creds);
  return (QUOTE_KEYS[quote] || [quote]).reduce((s, k) => s + (Number(b[k]) || 0), 0);
}

/**
 * Check a key before trusting it: it must read balances and trade,
 * and it must NOT be allowed to withdraw. WithdrawInfo with a fake key name
 * returns "Permission denied" for keys without withdrawal rights and a funding
 * error for keys that have them. Nothing is withdrawn either way.
 */
export async function checkKey(creds) {
  await balances(creds);
  try {
    await privatePost(creds, 'WithdrawInfo', { asset: 'XBT', key: 'kairos-permission-probe-does-not-exist', amount: '0.0001' });
    return { ok: false, reason: 'This key can withdraw funds. Create a new Kraken key with only Query Funds, Query/Create/Cancel Orders.' };
  } catch (e) {
    const errs = (e.errors || []).join(' ');
    if (/Permission denied/i.test(errs)) return { ok: true };
    if (/EFunding|Unknown withdraw key|Invalid key/i.test(errs)) return { ok: false, reason: 'This key can withdraw funds. Create a new Kraken key without the Withdraw permission.' };
    throw e;
  }
}

/* ---------- orders ---------- */
export async function addOrder(creds, o) {
  return privatePost(creds, 'AddOrder', {
    pair: o.pair, type: o.side, ordertype: o.ordertype, volume: o.volume, price: o.price,
    oflags: o.oflags, userref: o.userref, validate: o.validate ? 'true' : undefined,
  });
}
export async function queryOrders(creds, txids) { return privatePost(creds, 'QueryOrders', { txid: [].concat(txids).join(','), trades: 'false' }); }
export async function cancelOrder(creds, txid) { return privatePost(creds, 'CancelOrder', { txid }); }

/** Poll a just-placed market order until it is closed (or give up). */
export async function waitFilled(creds, txid, { tries = 10, delayMs = 700 } = {}) {
  for (let i = 0; i < tries; i++) {
    const o = (await queryOrders(creds, txid))[txid];
    if (o?.status === 'closed') return { volume: Number(o.vol_exec), price: Number(o.price), cost: Number(o.cost), fee: Number(o.fee) };
    if (o?.status === 'canceled' || o?.status === 'expired') throw new KrakenError(`Order ${txid} ${o.status}: ${o.reason || ''}`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new KrakenError(`Order ${txid} did not fill in time; check it on Kraken`);
}
