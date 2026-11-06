// The vault is a plain folder of Markdown notes that Obsidian can open.
import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from './frontmatter.js';

export const DIRS = ['Trades', 'Strategies', 'Psychology', 'Agents', 'Insights', 'Log', 'Templates', 'Attachments', 'Lessons', 'News', 'Chats'];

/* ---------- images (trade screenshots) ---------- */
export const IMAGE_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const MAX_IMAGE = 8 * 1024 * 1024;
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
function bytesToB64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Save a data: URL image under Attachments/ and return its vault path. */
export function saveImage(root, dataUrl, baseName) {
  const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('The screenshot must be a PNG, JPEG, WebP or GIF image'), { status: 400 });
  const bytes = b64ToBytes(m[2].replace(/\s/g, ''));
  if (bytes.length > MAX_IMAGE) throw Object.assign(new Error('Screenshot is larger than 8 MB'), { status: 413 });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  let rel = `Attachments/${safeName(baseName)}.${ext}`, i = 2;
  while (fs.existsSync(resolveInVault(root, rel))) rel = `Attachments/${safeName(baseName)} ${i++}.${ext}`;
  const full = resolveInVault(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  return rel;
}
/** Read a vault image back as a data: URL (works in the browser build too). */
export function readImage(root, rel) {
  const ext = String(rel).split('.').pop().toLowerCase();
  if (!IMAGE_EXT[ext]) throw Object.assign(new Error('Not an image'), { status: 400 });
  const raw = fs.readFileSync(resolveInVault(root, rel));
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw.buffer ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw);
  return `data:${IMAGE_EXT[ext]};base64,${bytesToB64(bytes)}`;
}

const TEMPLATE_TRADE = `---
date: 2026-01-01 09:00
asset: BTC-USD
side: long
entry: 0
stop: 0
exit: 0
size: 0
pnl: 0
strategy: ""
emotion: ""
tags: []
---

## Thesis


## Psychology


## Went well
-

## Went wrong
-
`;

const RULES = `---
starting_balance: 10000
min_trades: 50
min_days: 30
min_profit_factor: 1.5
max_drawdown_pct: 12
min_adherence_pct: 90
daily_loss_pct: 3
max_risk_per_trade_pct: 2
fee_pct: 0.4
slippage_pct: 0.05
first_tier_usd: 250
min_24h_volume_usd: 1000000
max_spread_pct: 0.5
shock_guard_min: 15
shock_major_pct: 1.2
shock_meme_pct: 3
---

# Marks and limits

Only you edit this file. The agents read it on every decision and the app never lets a model change it.

- **Marks** (min_trades, min_days, min_profit_factor, max_drawdown_pct, min_adherence_pct) decide when a paper strategy may ask for real capital.
- **Limits** (daily_loss_pct, max_risk_per_trade_pct, max_drawdown_pct) are enforced by Brake, which is plain code, not a model.
- **Real money** (Kraken spot, long only): min_24h_volume_usd and max_spread_pct keep the agents out of thin, illiquid markets, which matters most for memecoins.
`;

const STRATEGY = `---
name: Range breakout
status: stopped
version: 2
assets: [BTC-USD, ETH-USD, SOL-USD]
timeframe: 1h
risk_per_trade_pct: 1
hours_utc: "00:00-23:59"
interval_min: 60
max_positions: 2
trend_filter: true
---

# Range breakout

Buy a clean break out of a multi-day range, with the trend, and let the target do the work.
Version 2, rewritten after Kairos's paper tests 1-8 (see [[Lessons/Range breakout]]).

## Entry
- A range of at least 2 days on the 1h chart, between 3% and 12% tall: a real base, not a trend leg.
- An hourly candle CLOSES above the range top, on its own volume of at least 1.5x the 72h average (not the daily average).
- Never chase: skip it if the close is more than 1.5% above the range top, or if the move already ran between decisions.
- Only with the trend: price above its 20-day average, and the 20-day above the 50-day. Brake blocks longs against it.
- At most 2 positions open: BTC, ETH and SOL move together, so a third one adds risk, not diversification.

## Exit
- Stop at structure, at least 3% below entry (the middle of the range or lower). Fees (0.4% each side) make tighter stops cost ~1.4R.
- Target 2.5R or more. No early exit "to be safe".
- Only move the stop after +1.5R, and only under a real swing low with room for normal noise. Pulling it up under the last small dip cut both winners in paper test 4.
- A breakout that goes nowhere for 7 days is closed.

## Discipline
- No trade after 2 losses in a row (see [[Anti-tilt rules]]).
- "Hold" is a decision. Most hours have no setup.
`;


const DIP_STRATEGY = `---
name: Dip buyer
status: stopped
version: 1
assets: [BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD, ADA-USD, LINK-USD, LTC-USD]
timeframe: 1d
risk_per_trade_pct: 1
hours_utc: "00:00-23:59"
interval_min: 240
max_positions: 4
trend_filter: false
---

# Dip buyer

Buy a sharp one or two day dip in a coin that is in an uptrend, only while the whole market is healthy, and sell the bounce.
Paper test 9 (2019 to today, real daily prices, fees included): about 3 trades in 4 win. The wins are small, so the losses must stay small too.
Its paper track is in the journal (tag #paper-track) and on the Track record. Rules are fixed in code (src/lib/dipbuyer.js); the AI applies them and reads the news.

## Market first
- Trade only while BTC closes above its 200-day average and has not fallen more than 10% in 3 days. Otherwise hold everything: in 2022 this rule kept the strategy out of the crash.
- Read the latest headlines (Argus). Skip a coin with fresh bad news of its own (a hack, a delisting, a lawsuit, an unlock): that dip is news, not noise.

## Entry
- The coin closes above its own 50-day average (uptrend) and RSI(2) closes under 15 (a sharp dip).
- Buy with a limit order at that close, valid for the next day only. No chasing if it does not fill.
- At most 4 positions open, at most 25% of the account in one coin, 1% of the account at risk.

## Exit
- Sell when a day closes back above the 10-day average (and at least +0.5% above entry), or at the target: 3 x ATR(14) above entry.
- Stop 4 x ATR(14) below entry (between 3% and 20%). The stop is wide on purpose: dips often go a little further before they bounce.
- Close anything still open after 10 days.

## Discipline
- "Hold" is the usual answer: most days have no dip in an uptrend.
- Never average down and never move the stop lower.
`;

const DIP_LESSONS = `---
strategy: Dip buyer
tags: [lessons]
---

# Lessons · Dip buyer

What paper test 9 taught it (8 coins, daily candles, Jan 2019 to Nov 2026).

- The market filter carries the strategy. Without "BTC above its 200-day average" the same dips earned far less (profit factor 1.09 instead of 1.32, drawdown 11% instead of 8%) and lost 7% in 2022; with it, 2022 had no trades at all.
- A high win rate needs small targets, so fees matter: limit orders for entries and exits (0.25%), not market orders (0.4%).
- Three exits in four are "back above the 10-day average", most often after just 2 days. A dip that has not bounced after 10 days usually will not: the time stop cut those for -0.3R on average (-0.85R at worst).
- Bad years exist: 2019 and 2024 lost money (63-67% wins, but the losses were bigger than the wins). The win rate alone does not make it profitable.
- When BTC, ETH and SOL dip on the same day it is one bet, not three: in October 2026 all three hit the time stop together.
`;

/** The lessons Range breakout starts with: what Kairos's own paper tests taught it. */
const STRATEGY_LESSONS = `---
strategy: Range breakout
tags: [lessons]
---
# Lessons · Range breakout

Seeded from Kairos's paper tests 1-8 (the Track record on the website). New lessons are added after every closed trade.

## 2026-11-05 Paper test 1 · ETH long · -1.39R · stop
- A wide candle on weekend volume (0.5x) closed above the base and failed: demand the breakout candle's own volume above average.
- Fees of 0.4% each side took 39% of the planned risk on a 2.1% stop: stops of at least 3%, targets of at least 2.5R.

## 2026-11-05 Paper tests 2 and 3 · 0 trades
- Strict filters avoided every trap but caught nothing: when a setup meets the rules, take it; do not stack extra conditions on top.

## 2026-11-06 Paper test 4 · SOL +0.31R, BTC -0.45R
- Both entries were right; both stops were pulled up under the latest small dip. Left alone, SOL hit its 2.5R target.
- Only protect after +1.5R, under a real swing low with room for noise.

## 2026-11-06 Paper test 5 · a year of rules · 29 trades
- Buying breakouts in a downtrend failed (8 losses of 9): only trade with the trend (price > 20-day average > 50-day).
- BTC, ETH and SOL broke out in the same hour and tripled the risk: at most 2 positions open.

## 2026-11-06 Paper tests 6-8 · limit orders, daily trend, 12% limit
- Limit orders cut fees by a third but did not create an edge. Looser drawdown limits only lost more before Brake stopped the strategy.
- None of the tested versions has beaten the marks yet: live paper trading is the real test.
`;

const MEME = `---
name: Memecoin momentum
status: stopped
version: 2
assets: [DOGE-USD, PEPE-USD, WIF-USD, BONK-USD, SHIB-USD]
timeframe: 1h
risk_per_trade_pct: 0.5
hours_utc: "00:00-23:59"
interval_min: 30
on_shock: allow
max_positions: 1
trend_filter: true
---

# Memecoin momentum

Memecoins move on attention. This strategy only trades coins Kraken lists against USD, never tokens that live only on a DEX (pump.fun and similar).
Version 2, after Kairos's paper test 3 and the 8 Oct crash (see [[Lessons/Memecoin momentum]]). Not proven yet: paper trading decides.

## Entry
- Only with a catalyst: a fresh headline or tweet about the coin (Argus) AND an upward price shock, or a breakout candle with at least 3x its 72h volume.
- Only with the trend: price above its 20-day average, and the 20-day above the 50-day. Brake blocks longs against it.
- Never buy the bounce after a crash. Brake blocks entries for 15 minutes after a downward shock; after that, wait for a higher low on real volume.
- Do not enter if the coin is already up more than 8% from where the catalyst started: that is chasing.
- One memecoin position at a time (Brake enforces it).

## Exit
- Stop below the level where the move started (usually 4-8% away); target 3R; risk 0.5% (half the usual).
- Close after 6 hours if the target has not been reached: memecoin moves fade.

## Why the risk is smaller
Spreads widen and volume vanishes fast, and crashes come in steps. Brake also checks Kraken's 24h volume and spread before any real-money buy.
`;

/** The lessons Memecoin momentum starts with. */
const MEME_LESSONS = `---
strategy: Memecoin momentum
tags: [lessons]
---
# Lessons · Memecoin momentum

Seeded from Kairos's paper test 3 (DOGE, PEPE, WIF, 8-15 Oct 2026) and the replay of the 8 Oct crash. New lessons are added after every closed trade.

## 2026-11-05 Paper test 3 · 0 trades · holding lost up to 14%
- All three coins were in a 5-day downtrend: the only 3x volume candles were flushes down, not breakouts. No longs without the trend.
- After the market-wide crash at 15:00 UTC the bounce came on below-average volume: a dead-cat bounce, not an entry.
- WIF crossed its trigger on 1.2-1.7x volume and fell back a day later: the volume rule refused a losing chase.

## 2026-11-05 8 Oct crash · replayed on 1-minute candles
- The crash came down in steps (-4% over 25 minutes, never 3% in any 3 minutes) and kept falling 3-5.5% after the alert.
- A shock down is a warning, never a buy signal.
`;

const TILT = `---
tags: [psychology, rules]
---

# Anti-tilt rules

- After 2 losses in a row, the day is over.
- No trades outside my hours.
- If the thesis says "it has to turn", I don't enter.
`;

export function resolveInVault(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new Error('Invalid path');
  const full = path.resolve(root, rel);
  const r = path.resolve(root);
  if (full !== r && !full.startsWith(r + path.sep)) throw new Error('Path escapes the vault');
  return full;
}

export function initVault(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const d of DIRS) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.mkdirSync(path.join(root, '.kairos'), { recursive: true });
  const oldState = path.join(root, '.agentsia', 'state.json'), state = path.join(root, '.kairos', 'state.json'); // vaults made as agentsIA
  if (!fs.existsSync(state) && fs.existsSync(oldState)) fs.renameSync(oldState, state);
  const seed = [
    ['rules.md', RULES],
    ['Templates/Trade.md', TEMPLATE_TRADE],
    ['Strategies/Range breakout.md', STRATEGY],
    ['Lessons/Range breakout.md', STRATEGY_LESSONS],
    ['Psychology/Anti-tilt rules.md', TILT],
    ['Strategies/Memecoin momentum.md', MEME],
    ['Lessons/Memecoin momentum.md', MEME_LESSONS],
    ['Strategies/Dip buyer.md', DIP_STRATEGY],
    ['Lessons/Dip buyer.md', DIP_LESSONS],
  ];
  for (const [rel, content] of seed) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) fs.writeFileSync(f, content);
  }
  // v2 strategies: upgrade a note only if the user never edited the original v1 text (its status is kept)
  for (const [rel, v2text, marks] of [
    ['Strategies/Range breakout.md', STRATEGY, ['Works best during European hours. Big losses come from entering before the candle closes.', 'take profit at 2R.']],
    ['Strategies/Memecoin momentum.md', MEME, ['Enter only with a catalyst: a fresh headline or tweet about the coin (news feed)', 'Never more than one memecoin position at a time.']],
  ]) {
    const sf = path.join(root, rel);
    try { const n = parse(fs.readFileSync(sf, 'utf8'));
      if (!n.data.version && marks.every(m => n.body.includes(m))) { const v2 = parse(v2text); fs.writeFileSync(sf, stringify({ ...v2.data, status: n.data.status || 'stopped' }, v2.body)); }
    } catch { /* the user renamed or removed it */ }
  }
  // add rules introduced in later versions to existing vaults, without touching the user's values
  const rf = path.join(root, 'rules.md'), cur = parse(fs.readFileSync(rf, 'utf8')), defaults = parse(RULES).data;
  const missing = Object.keys(defaults).filter(k => !(k in cur.data));
  if (missing.length) fs.writeFileSync(rf, stringify({ ...cur.data, ...Object.fromEntries(missing.map(k => [k, defaults[k]])) }, cur.body));
}

export function readNote(root, rel) {
  const text = fs.readFileSync(resolveInVault(root, rel), 'utf8');
  return { path: rel, ...parse(text), raw: text };
}

export function writeNote(root, rel, data, body) {
  const full = resolveInVault(root, rel);
  if (!full.endsWith('.md')) throw new Error('Notes must be .md files');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, stringify(data, body));
  return rel;
}

export function listNotes(root, dir) {
  const base = resolveInVault(root, dir);
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.md')) out.push(path.relative(root, f).split(path.sep).join('/'));
    }
  };
  walk(base);
  return out.sort();
}

/** Every name a [[link]] or ![[embed]] can resolve to in this vault (Obsidian matches by file name or path). */
export function vaultNames(root) {
  const names = new Set();
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else { const rel = path.relative(root, f).split(path.sep).join('/'); for (const n of [e.name, rel]) { names.add(n.toLowerCase()); names.add(n.replace(/\.md$/, '').toLowerCase()); } } } };
  walk(root); return names;
}
/** Model-written text: links to notes that do not exist become plain text, so Obsidian shows no broken links. */
export function unlinkMissing(root, text, extra = []) {
  if (!String(text).includes('[[')) return text;
  const names = vaultNames(root); for (const n of extra) { names.add(n.toLowerCase()); names.add(n.replace(/\.md$/, '').toLowerCase()); }
  return String(text).replace(/(!?)\[\[([^\]|#]+)((?:#[^\]|]*)?)(?:\|([^\]]*))?\]\]/g, (all, bang, target, head, alias) => {
    const t = target.trim().toLowerCase(), base = t.split('/').pop();
    return names.has(t) || names.has(base) ? all : (alias || target).trim();
  });
}

/** File-name safe slug that keeps the note readable in Obsidian. */
export function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'note';
}

export function uniquePath(root, rel) {
  let p = rel, i = 2;
  while (fs.existsSync(resolveInVault(root, p))) p = rel.replace(/\.md$/, ` ${i++}.md`);
  return p;
}

export function appendLog(root, line, when = new Date()) {
  const day = when.toISOString().slice(0, 10);
  const f = path.join(root, 'Log', `${day}.md`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, `# Log ${day}\n\n`);
  fs.appendFileSync(f, `- ${when.toISOString().slice(11, 19)} UTC · ${String(line).replace(/\n/g, ' ')}\n`);
}

const num = v => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/** Normalise a journal trade note into numbers the metrics can use. */
export function toTrade(note) {
  const d = note.data;
  const side = String(d.side || '').toLowerCase() === 'short' ? 'short' : 'long';
  const entry = num(d.entry), stop = num(d.stop), exit = num(d.exit), size = num(d.size);
  const dir = side === 'long' ? 1 : -1;
  let pnl = num(d.pnl);
  if ((pnl === null || pnl === 0) && entry && exit && size) pnl = (exit - entry) * size * dir;
  let r = num(d.r);
  if (r === null && entry && stop && exit && entry !== stop) r = ((exit - entry) * dir) / Math.abs(entry - stop);
  const sections = {};
  for (const m of note.body.matchAll(/^##\s+(.+)\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm)) sections[m[1].trim().toLowerCase()] = m[2].trim();
  let image = d.image ? String(d.image) : null;
  if (!image) { const em = note.body.match(/!\[\[([^\]|]+\.(?:png|jpe?g|webp|gif))(?:\|[^\]]*)?\]\]/i); if (em) image = em[1].includes('/') ? em[1] : `Attachments/${em[1]}`; }
  return {
    image, path: note.path, date: String(d.date || ''), asset: String(d.asset || ''), side, entry, stop, exit, size,
    pnl: pnl ?? 0, r: r === null ? null : Math.round(r * 100) / 100, strategy: String(d.strategy || ''),
    emotion: String(d.emotion || ''), tags: Array.isArray(d.tags) ? d.tags.map(String) : (d.tags ? [String(d.tags)] : []),
    thesis: sections.thesis || '', psychology: sections.psychology || '',
    wentWell: sections['went well'] || '', wentWrong: sections['went wrong'] || '',
  };
}

export function listJournal(root) {
  return listNotes(root, 'Trades').map(p => { try { return toTrade(readNote(root, p)); } catch { return null; } }).filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function createJournalTrade(root, t) {
  const side = t.side === 'short' ? 'short' : 'long';
  const date = /^\d{4}-\d{2}-\d{2}/.test(t.date || '') ? String(t.date).slice(0, 16).replace('T', ' ') : new Date().toISOString().slice(0, 16).replace('T', ' ');
  const asset = safeName(t.asset || 'ASSET').toUpperCase();
  const data = {
    date, asset, side, entry: num(t.entry) ?? 0, stop: num(t.stop) ?? 0, exit: num(t.exit) ?? 0, size: num(t.size) ?? 0,
    pnl: num(t.pnl) ?? 0, r: num(t.r) ?? undefined, strategy: String(t.strategy || ''), emotion: String(t.emotion || ''),
    tags: String(t.tags || '').split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean),
  };
  const body = `## Thesis\n${t.thesis || ''}\n\n## Psychology\n${t.psychology || ''}\n\n## Went well\n${t.wentWell || ''}\n\n## Went wrong\n${t.wentWrong || ''}\n`;
  const rel = uniquePath(root, `Trades/${date.slice(0, 10)} ${asset} ${side}.md`);
  if (t.image) {
    const img = saveImage(root, t.image, path.basename(rel, '.md'));
    data.image = img;
    return writeNote(root, rel, data, `![[${path.basename(img)}]]\n\n` + body);
  }
  return writeNote(root, rel, data, body);
}
