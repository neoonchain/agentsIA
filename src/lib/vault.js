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
max_drawdown_pct: 25
min_adherence_pct: 90
daily_loss_pct: 6
max_risk_per_trade_pct: 3
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
version: 2
rules_engine: dip-buyer
assets: [BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD, ADA-USD, LINK-USD, LTC-USD]
timeframe: 1d
risk_per_trade_pct: 3
hours_utc: "00:00-23:59"
interval_min: 240
max_positions: 4
trend_filter: false
---

# Dip buyer

Buy a sharp one or two day dip in a coin that is in an uptrend, only while the whole market is healthy, and sell the bounce.
Half of the Kairos portfolio; the other half is [[Trend rider]]. Paper test 9 (real daily prices, fees included): about 3 trades in 4 win.
Its paper track is in the journal (tag #dip-buyer) and on the Track record. Rules are fixed in code (src/lib/dipbuyer.js); the AI applies them and reads the news.

## Market first
- Trade only while BTC closes above its 200-day average and has not fallen more than 10% in 3 days. Otherwise hold everything: in 2022 this rule kept the strategy out of the crash.
- Read the latest headlines (Argus). Skip a coin with fresh bad news of its own (a hack, a delisting, a lawsuit, an unlock): that dip is news, not noise.

## Entry
- The coin closes above its own 50-day average (uptrend) and RSI(2) closes under 15 (a sharp dip).
- Buy with a limit order at that close, valid for the next day only. No chasing if it does not fill.
- At most 4 positions open, at most 25% of the account in one coin, 3% of the account at risk.

## Exit
- Sell when a day closes back above the 10-day average (and at least +0.5% above entry), or at the target: 3 x ATR(14) above entry.
- Stop 4 x ATR(14) below entry (between 3% and 20%; in practice usually 20%). The stop is wide on purpose: dips often go further before they bounce.
- Close anything still open after 10 days.

## Discipline
- "Hold" is the usual answer: most days have no dip in an uptrend.
- Never average down and never move the stop lower.
`;

const TREND_STRATEGY = `---
name: Trend rider
status: stopped
version: 1
rules_engine: trend-rider
assets: [BTC-USD, ETH-USD, SOL-USD, XRP-USD, DOGE-USD, ADA-USD, LINK-USD, LTC-USD]
timeframe: 1d
risk_per_trade_pct: 3
hours_utc: "00:00-23:59"
interval_min: 240
max_positions: 5
trend_filter: false
---

# Trend rider

Hold the coins that are trending while the market is strong, and step aside when they turn.
Half of the Kairos portfolio; the other half is [[Dip buyer]]. It loses often and small (about 2 trades in 3) and wins big: that is how trend following works.
Paper test 10 on real daily prices, fees included. Its paper track is in the journal (tag #trend-rider). Rules are fixed in code (src/lib/trendrider.js).

## Market first
- Buy only while BTC closes above its 50-day average. When it doesn't, no new buys; open positions keep their own exit.
- Read the latest headlines (Argus). Skip a coin with fresh bad news of its own.

## Entry
- The coin closes above its 20-day average and is up over the last 20 days. Strongest 20-day return first.
- Buy at the next day's open. At most 5 coins, 20% of the account each. No leverage.

## Exit
- Sell at the next open after a daily close under the 20-day average.
- Safety stop 15% under entry (20% of the account x 15% = 3% at risk).

## Discipline
- Never sell a winner early "to lock it in": the big winners pay for all the small losses.
- Expect drops of 30% or more from the top in a bad year. The 25% drawdown limit in [[rules]] counts both halves together.
`;

const TREND_LESSONS = `---
strategy: Trend rider
tags: [lessons]
---

# Lessons · Trend rider

What paper test 10 taught it (8 coins, daily candles, Jan 2019 to Nov 2026).

- Most trades lose, a few win big: over the last two years about 3 in 10 won, and one ADA trade alone made +11.6R (Nov to Dec 2024).
- The market filter matters less than the exit: selling on a close under the 20-day average is what keeps the losses small.
- A safety stop of 15% almost never triggers before the average exit; tighter stops (8-10%) cut the return in half by selling good trends on normal noise.
- Drops are deep: about 37% from the top in 2026 and 42% in 2022. Running it next to Dip buyer, half each, cut the drop to about 24% over the last two years.
- It needs strong markets. With BTC flat over the last two years it still made money because single coins (ADA, XRP, DOGE) trended hard.
`;

const PULLBACK_STRATEGY = `---
name: Pullback
status: stopped
version: 1
rules_engine: pullback
assets: [XYZ100-XYZ, GOLD-XYZ]
timeframe: 1d
risk_per_trade_pct: 3
hours_utc: "00:00-23:59"
interval_min: 240
max_positions: 2
trend_filter: false
---

# Pullback

Buy a short dip in the Nasdaq 100 or gold while its long trend is up, and sell into the bounce. Paper only (Trade.xyz on Hyperliquid).
Larry Connors' "Double 7s", unchanged, with a safety stop. Picked from 14 classic rule sets (Paul Tudor Jones, Connors, Raschke, the Turtles, AQR's 12-month momentum, the 50/200 cross) tested on 2001-2026 after fees and Hyperliquid funding. Three made money on both markets in both halves; the other two trade once or twice a year and fell 30-41% from the top. This one trades about 15 times a year, wins about 7 in 10 and fell 11-19% at most with its safety stop.
Its paper track is in the journal (tag #pullback). Rules are fixed in code (src/lib/pullback.js).

## Trend first
- Buy only while the market closes above its 200-day average (weekday closes, like the index itself).
- Read the latest headlines (Argus): skip the entry before a Fed decision, CPI or a big earnings week for the Nasdaq.

## Entry
- The market closes at or under its lowest close of the previous 7 days. Buy at the next open.
- Size so the safety stop risks 3% of the account: stop 8% under entry for the Nasdaq 100, 6% for gold.

## Exit
- Sell at the next open after a close at or over the highest close of the previous 7 days.
- Safety stop, intraday. No target, no time stop: the bounce decides.

## Discipline
- Holding costs money: Hyperliquid funding on longs was about 5.4% a year on the Nasdaq 100 and 8.4% on gold in their first year. The trade must bounce within days.
- Expect small wins (about 2% each) and few, larger stops. Most of the edge is the win rate, so never skip the exit rule.
`;

const PULLBACK_LESSONS = `---
strategy: Pullback
tags: [lessons]
---

# Lessons · Pullback

What the research taught it (Nasdaq 100 index and gold futures, daily, 2001-2026, 0.08% costs each way plus funding).

- Funding decides what works. Trend following (200-day rule, Turtles, 12-month momentum, 50/200 cross) makes money on the index itself but holds 65-85% of the time, and 5-8% a year of funding takes most of it.
- Short dips work better than long trends here: in the market only about 30% of the time, so funding stays small.
- Double 7s made money on both markets in 2001-2014 and again in 2015-2026 (profit factor 1.1-1.7, 63-73% of trades won). Every lookback from 6 to 10 days stayed profitable in both periods (6 barely, on gold); 7 is Connors' original, not a tuned number.
- The edge is small: about 1-2% a year at 3% risk with the safety stop (2001-2014: 1.3%, 2015-2026: 2.2%, worst drop 19%). Without a stop and at full size it made about 7% a year with a 26% drop. It is a low-correlation sleeve next to the crypto strategies, not a way to get rich.
- Its first year on Hyperliquid (Oct 2025 to Nov 2026) lost 2.5%: 24 trades, half won, and four stops in March, June and October-November did the damage when both markets broke down. 24 trades is too few to tell luck from a broken edge.
- Gold mean reversion is weaker than the Nasdaq's: the Raschke IBS and RSI(2) rules lost money on gold in both periods.
`;

const DIP_LESSONS = `---
strategy: Dip buyer
tags: [lessons]
---

# Lessons · Dip buyer

What paper test 9 taught it (8 coins, daily candles, Jan 2019 to Nov 2026, 3% risk, conservative fills).

- The market filter carries the strategy: in 2022 "BTC above its 200-day average" kept it out of the crash entirely (no trades), while Trend rider lost 37% that year.
- The win rate is high (73% of 277 trades) because the wins are small: three exits in four are "back above the 10-day average", most often after just 2 days.
- The losses are what decide a year. 30 stops cost about -1R each, and 39 time stops -0.35R on average (-0.85R at worst): a dip that has not bounced in 10 days usually will not.
- Bad years exist: 2019 lost 2.9% and 2024 lost 17.4% (a 26% drop from the top) with 64-67% wins. The win rate alone does not make it profitable.
- When BTC, ETH and SOL dip on the same day it is one bet, not three: in October 2026 all three hit the time stop together.
- Fees matter for small wins: a limit order to buy the dip (0.25%) instead of a market order (0.40% + slippage).
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
    ['Strategies/Trend rider.md', TREND_STRATEGY],
    ['Lessons/Trend rider.md', TREND_LESSONS],
    ['Strategies/Pullback.md', PULLBACK_STRATEGY],
    ['Lessons/Pullback.md', PULLBACK_LESSONS],
  ];
  for (const [rel, content] of seed) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) fs.writeFileSync(f, content);
  }
  // v2 strategies: upgrade a note only if the user never edited the original v1 text (its status is kept)
  for (const [rel, v2text, marks, fromVersion] of [
    ['Strategies/Range breakout.md', STRATEGY, ['Works best during European hours. Big losses come from entering before the candle closes.', 'take profit at 2R.']],
    ['Strategies/Memecoin momentum.md', MEME, ['Enter only with a catalyst: a fresh headline or tweet about the coin (news feed)', 'Never more than one memecoin position at a time.']],
    ['Strategies/Dip buyer.md', DIP_STRATEGY, ['At most 4 positions open, at most 25% of the account in one coin, 1% of the account at risk.'], 1],
  ]) {
    const sf = path.join(root, rel);
    try { const n = parse(fs.readFileSync(sf, 'utf8'));
      if ((n.data.version || 0) === (fromVersion || 0) && marks.every(m => n.body.includes(m))) { const v2 = parse(v2text); fs.writeFileSync(sf, stringify({ ...v2.data, status: n.data.status || 'stopped' }, v2.body)); }
    } catch { /* the user renamed or removed it */ }
  }
  // add rules introduced in later versions to existing vaults, without touching the user's values
  const rf = path.join(root, 'rules.md'), cur = parse(fs.readFileSync(rf, 'utf8')), defaults = parse(RULES).data;
  if (cur.data.max_drawdown_pct === 12 && cur.data.daily_loss_pct === 3 && cur.data.max_risk_per_trade_pct === 2) { // the old defaults, untouched: the portfolio's limits
    Object.assign(cur.data, { max_drawdown_pct: 25, daily_loss_pct: 6, max_risk_per_trade_pct: 3 }); fs.writeFileSync(rf, stringify(cur.data, cur.body));
  }
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
  const entry = num(t.entry) ?? 0, stop = num(t.stop) ?? 0, exit = num(t.exit) ?? 0, size = num(t.size) ?? 0, dir = side === 'long' ? 1 : -1;
  // write the real PnL and R into the note, so Obsidian and Dataview see the same numbers as the app
  const pnl = num(t.pnl) ?? (entry && exit && size ? +((exit - entry) * size * dir).toFixed(2) : 0);
  const r = num(t.r) ?? (entry && stop && exit && entry !== stop ? +(((exit - entry) * dir) / Math.abs(entry - stop)).toFixed(2) : undefined);
  const data = {
    date, asset, side, entry, stop, exit, size,
    pnl, r, strategy: String(t.strategy || ''), emotion: String(t.emotion || ''),
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
