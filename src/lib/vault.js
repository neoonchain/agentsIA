// The vault is a plain folder of Markdown notes that Obsidian can open.
import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from './frontmatter.js';

export const DIRS = ['Trades', 'Strategies', 'Psychology', 'Agents', 'Insights', 'Log', 'Templates'];

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
max_drawdown_pct: 8
min_adherence_pct: 90
daily_loss_pct: 3
max_risk_per_trade_pct: 2
fee_pct: 0.4
slippage_pct: 0.05
first_tier_usd: 250
min_24h_volume_usd: 1000000
max_spread_pct: 0.5
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
assets: [BTC-USD, ETH-USD]
timeframe: 1h
risk_per_trade_pct: 1
hours_utc: "07:00-17:00"
interval_min: 60
---

# Range breakout

## Rules
- Range of at least 2 days on the 1h chart.
- Enter on a candle close outside the range with volume above the 20-candle average.
- Stop on the other side of the last swing; take profit at 2R.
- No trade after 2 losses in a row (see [[Anti-tilt rules]]).

## What the journal says
Works best during European hours. Big losses come from entering before the candle closes.
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
  fs.mkdirSync(path.join(root, '.agentsia'), { recursive: true });
  const seed = [
    ['rules.md', RULES],
    ['Templates/Trade.md', TEMPLATE_TRADE],
    ['Strategies/Range breakout.md', STRATEGY],
    ['Psychology/Anti-tilt rules.md', TILT],
  ];
  for (const [rel, content] of seed) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) fs.writeFileSync(f, content);
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
  return {
    path: note.path, date: String(d.date || ''), asset: String(d.asset || ''), side, entry, stop, exit, size,
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
    pnl: num(t.pnl) ?? 0, strategy: String(t.strategy || ''), emotion: String(t.emotion || ''),
    tags: String(t.tags || '').split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean),
  };
  const body = `## Thesis\n${t.thesis || ''}\n\n## Psychology\n${t.psychology || ''}\n\n## Went well\n${t.wentWell || ''}\n\n## Went wrong\n${t.wentWrong || ''}\n`;
  const rel = uniquePath(root, `Trades/${date.slice(0, 10)} ${asset} ${side}.md`);
  return writeNote(root, rel, data, body);
}
