// Fast news + price-shock detection. Sources: Tree of Alpha (tweets and headlines, seconds old),
// RSS feeds, the official X API (user's own bearer token) and an inbound webhook for anything else
// (j7tracker or Telegram forwarders, TradingView alerts, n8n…). Nothing here trades: it informs the
// agents, triggers early decisions and arms Brake's shock guard.

const ALIASES = {
  BTC: ['bitcoin', 'btc', 'xbt'], ETH: ['ethereum', 'eth', 'ether'], SOL: ['solana', 'sol'], XRP: ['xrp', 'ripple'],
  DOGE: ['dogecoin', 'doge'], SHIB: ['shiba inu', 'shib'], PEPE: ['pepe'], BONK: ['bonk'], WIF: ['dogwifhat', 'wif'],
  FLOKI: ['floki'], TRUMP: ['$trump', 'official trump', 'trump coin', 'trump meme'], PENGU: ['pengu', 'pudgy penguins'], POPCAT: ['popcat'],
};
export const MEMECOINS = new Set(['DOGE', 'SHIB', 'PEPE', 'BONK', 'WIF', 'FLOKI', 'TRUMP', 'PENGU', 'POPCAT']);
// "$PEPE" and "pepe" both count; TRUMP only with the "$" or explicit phrases, so political news is not read as the coin
const esc = w => w.replace(/[$.*+?^()|[\]{}\\]/g, '\\$&');
const RX = Object.fromEntries(Object.entries(ALIASES).map(([c, words]) => [c, new RegExp(`(^|[^a-z0-9$])(${c === 'TRUMP' ? '' : '\\$?'}(?:${words.map(esc).join('|')}))(?![a-z0-9])`, 'i')]));

/** Coins a headline is about, from its text (and any tags the source already gave). */
export function coinsIn(text, tags = []) {
  const out = new Set(tags.map(t => String(t).toUpperCase()).filter(t => ALIASES[t]));
  for (const [c, rx] of Object.entries(RX)) if (rx.test(text)) out.add(c);
  return [...out];
}
export const baseOf = asset => String(asset).split('-')[0].toUpperCase();

/* ---------------- price shocks from 1-minute candles ---------------- */
/**
 * candles: oldest first {t, open, high, low, close, volume}. A shock is a 3-minute move bigger than
 * both a floor (1.2% majors, 3% memecoins) and 4x the coin's own recent 3-minute volatility,
 * or a smaller move (70% of that) on 3x average volume.
 */
export function detectShock(asset, candles, { majorPct = 1.2, memePct = 3 } = {}) {
  if (!candles || candles.length < 25) return null;
  const c = candles.slice(-61), last = c.at(-1), ref = c.at(-4);
  const rets = []; for (let i = 1; i < c.length - 3; i++) rets.push(Math.log(c[i].close / c[i - 1].close));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) || 0;
  const move3 = (last.close / ref.close - 1) * 100;
  const avgVol = c.slice(0, -3).reduce((a, x) => a + x.volume, 0) / Math.max(1, c.length - 3);
  const vol3 = c.slice(-3).reduce((a, x) => a + x.volume, 0) / 3;
  const volX = avgVol > 0 ? vol3 / avgVol : 0;
  const floor = MEMECOINS.has(baseOf(asset)) ? memePct : majorPct;
  const threshold = Math.max(floor, 4 * sd * Math.sqrt(3) * 100);
  const shock = Math.abs(move3) >= threshold || (Math.abs(move3) >= threshold * 0.7 && volX >= 3);
  return { asset, t: last.t, price: last.close, movePct: +move3.toFixed(2), threshold: +threshold.toFixed(2), volX: +volX.toFixed(1), dir: move3 >= 0 ? 'up' : 'down', shock };
}

/* ---------------- sources ---------------- */
async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} ${r.status}`), { status: r.status });
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: typeof window === 'undefined' ? { 'User-Agent': 'agentsia/0.1 (+news reader)' } : {}, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.text();
}
const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();

export const SOURCES = {
  async tree() {
    const rows = await getJSON('https://news.treeofalpha.com/api/news?limit=40');
    return rows.map(x => ({
      id: 'tree:' + x._id, time: Number(x.time) || Date.now(), title: String(x.title || '').replace(/\s+/g, ' ').slice(0, 400), url: x.url || '',
      source: `Tree of Alpha · ${x.source === 'Twitter' ? 'X' : x.sourceName || x.source || 'news'}`,
      tags: (x.suggestions || []).map(s => s.coin).filter(Boolean),
    }));
  },
  async rss(url) {
    const xml = await getText(url), out = [];
    for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
      const it = m[0], title = decode((it.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
      const link = decode((it.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]);
      const date = Date.parse(decode((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1])) || Date.now();
      if (title) out.push({ id: 'rss:' + (link || title), time: date, title: title.slice(0, 400), url: link, source: new URL(url).hostname.replace(/^www\./, ''), tags: [] });
    }
    return out.slice(0, 30);
  },
  /** Official X API v2 recent search with the user's own bearer token. */
  async x(bearer, query) {
    const q = new URLSearchParams({ query, max_results: '25', 'tweet.fields': 'created_at,author_id', expansions: 'author_id', 'user.fields': 'username' });
    const j = await getJSON(`https://api.x.com/2/tweets/search/recent?${q}`, { Authorization: `Bearer ${bearer}` });
    const users = Object.fromEntries((j.includes?.users || []).map(u => [u.id, u.username]));
    return (j.data || []).map(t => ({ id: 'x:' + t.id, time: Date.parse(t.created_at) || Date.now(), title: `@${users[t.author_id] || 'x'}: ${String(t.text).replace(/\s+/g, ' ').slice(0, 400)}`, url: `https://x.com/i/status/${t.id}`, source: 'X API', tags: [] }));
  },
};

export const DEFAULT_RSS = ['https://cointelegraph.com/rss', 'https://www.theblock.co/rss.xml'];

/* ---------------- the hub ---------------- */
export class NewsHub {
  constructor({ max = 400 } = {}) { this.items = []; this.ids = new Set(); this.shocks = []; this.status = {}; this.max = max; }
  /** Add items; returns the ones that were new. */
  ingest(items) {
    const fresh = [];
    for (const it of items) {
      if (!it || !it.title || this.ids.has(it.id)) continue;
      const item = { ...it, coins: coinsIn(it.title, it.tags || []), seenAt: Date.now() };
      this.ids.add(item.id); this.items.push(item); fresh.push(item);
    }
    this.items.sort((a, b) => b.time - a.time);
    if (this.items.length > this.max) for (const x of this.items.splice(this.max)) this.ids.delete(x.id);
    return fresh;
  }
  async poll(name, fn) {
    try { const fresh = this.ingest(await fn()); this.status[name] = { ok: true, at: Date.now(), fresh: fresh.length }; return fresh; }
    catch (e) { this.status[name] = { ok: false, at: Date.now(), error: e.message }; return []; }
  }
  relevant(assets, sinceMs = 6 * 3600000, n = 8) {
    const want = new Set(assets.map(baseOf)), now = Date.now();
    return this.items.filter(i => now - i.time <= sinceMs && i.coins.some(c => want.has(c))).slice(0, n);
  }
  recentShocks(assets, sinceMs = 3600000) {
    const want = new Set(assets), now = Date.now();
    return this.shocks.filter(s => want.has(s.asset) && now - s.t <= sinceMs);
  }
}
