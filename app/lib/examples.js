// Example journal: real trades from Kairos's own paper tests (see the Track record on the website).
// Seeded into an empty vault so a new user sees what a filled journal looks like: the three annotated trades
// of paper test 4 and the Dip buyer paper track (2 years of rules-based trades on real prices, continued
// every day by the app). All tagged "example" and removable in one click.
import fs from 'node:fs';
import * as V from './vault.js';
import { TRACK, TRACK_STATE, TRACK_DECISIONS } from './examples-dip.js';
import { trackJournalEntry } from './dipbuyer.js';

export const EXAMPLE_TAG = 'example';

export const EXAMPLES = [
  {
    date: '2026-09-18T09:00', asset: 'SOL-USD', chart: 'paper-test-sol.webp', side: 'long', entry: 106.37, stop: 102.4, exit: 108.45, size: 25.1689, pnl: 30.54, r: 0.31,
    strategy: 'Range breakout', emotion: 'calm', tags: 'example, paper-test, breakout, stop-too-tight',
    thesis: 'Paper test 4. SOL closed above its 5-day high (104.90) at 03:00 UTC on 2.4x volume and made a new high at 09:00 on 1.6x. BTC and ETH were both up 2-3% that day, so the move had the market behind it. Entry 106.37, stop 102.40 under the breakout base (3.7%), target 116.20 (2.5R). Risk 1% of a $10,000 paper account: 25.17 SOL, about $2,677.',
    psychology: 'Took the setup as soon as it met the rules instead of waiting for extra confirmation, which runs 2 and 3 had done too often.',
    wentWell: '- Entry on a real close above structure, on volume.\n- Moved the stop above entry at +1.7R, so the trade could not become a loss.',
    wentWrong: '- The stop was pulled up too close (108.50, right under a small dip) and a normal pullback took it out for +0.31R.\n- With the original stop the trade reached the 116.20 target on 21 Sep: about +$226 instead of +$30.\n- Lesson: only move a stop under a real swing low, with room for noise, and not before +1.5R.',
  },
  {
    date: '2026-09-21T09:00', asset: 'BTC-USD', chart: 'paper-test-btc.webp', side: 'long', entry: 84677.81, stop: 81600, exit: 83958, size: 0.0326, pnl: -45.44, r: -0.45,
    strategy: 'Range breakout', emotion: 'confident', tags: 'example, paper-test, breakout, stop-too-tight',
    thesis: 'Paper test 4. BTC closed above its 3-day range top (81,925) at 08:00 UTC on 3.8x volume and again at 09:00 on 4.3x; ETH and SOL confirmed. The breakout was 2 hours old, so not a chase. Entry 84,678, stop 81,600 under the breakout candle (3.6%), target 92,200 (2.6R). 0.0326 BTC, about $2,760.',
    psychology: 'Before two unattended days, raised the stop to 84,000 to limit the damage of a failed breakout.',
    wentWell: '- Clean breakout entry on heavy volume, risk sized to 1%.',
    wentWrong: '- The tighter stop (84,000) was hit by a dip to 82,709 that the original stop would have survived. With it, the trade was still open and roughly flat at the end of the test.\n- Same lesson as the SOL trade: a protective stop needs room for normal noise.',
  },
  {
    date: '2026-11-02T02:00', asset: 'ETH-USD', chart: 'paper-test-eth.webp', side: 'long', entry: 2293.52, stop: 2244, exit: 2244, size: 2.0195, pnl: -138.91, r: -1.39,
    strategy: 'Range breakout', emotion: 'disciplined', tags: 'example, paper-test, breakout, failed-breakout',
    thesis: 'Paper test 1. ETH spent 2.6 days in a base between 2,204 and 2,275. At 01:00 UTC a wide candle closed at 2,286.9, above the base. Entry 2,293.52, stop 2,244 under the last swing low, target 2,388 (2R), where the previous range topped out. Risk 1%: 2.0195 ETH, about $4,632, no leverage.',
    psychology: 'Patient: six holds before this entry, including a false BTC breakout. After the stop, no revenge trade.',
    wentWell: '- Waited for a close outside a 2-day range, not a wick.\n- Stop set before entry and respected.\n- Lost 1.39% while simply holding ETH lost 4.62% over the same days.',
    wentWrong: '- The breakout candle had weekend volume (0.5x average): the rule asks for above-average volume.\n- Fees (0.4% each side) turned a 1R stop into a 1.39R loss: tight stops need bigger targets.',
  },
];

const isExample = t => (t.tags || []).includes(EXAMPLE_TAG);

/** The Dip buyer paper track shipped with the app, as journal entries (each with its chart). */
export function trackTrades() {
  return TRACK.map(([asset, opened, closed, entry, stop, tp, exit, qty, pnl, r, why, days, ctx], k) => ({
    ...trackJournalEntry({ asset, t: Date.parse(opened), entry, stop, tp, exit, qty, pnl, r, why, days, ctx }), chart: `dip-${String(k + 1).padStart(2, '0')}.webp`,
  }));
}
export const trackState = () => JSON.parse(JSON.stringify(TRACK_STATE));
const startTrack = state => { state.track = trackState(); (state.decisions ||= {})['Dip buyer'] = JSON.parse(JSON.stringify(TRACK_DECISIONS)); };

/** Seed the examples once, into a journal that has never had any trades. Older seeded vaults move to v3:
 *  paper test 6's trades (a strategy that lost) make way for the Dip buyer track, which keeps going day by day. */
export function seedExamples(root, state) {
  if (!state.examples) {
    state.examples = V.listJournal(root).length ? 'skipped' : 'seeded';
    if (state.examples !== 'seeded') return false;
    for (const t of [...EXAMPLES, ...trackTrades()]) V.createJournalTrade(root, t);
    state.examplesVersion = 3; startTrack(state); return true;
  }
  if (state.examples === 'seeded' && (state.examplesVersion || 1) < 3) {
    for (const t of V.listJournal(root).filter(t => isExample(t) && (t.tags || []).includes('paper-test-6'))) {
      fs.unlinkSync(V.resolveInVault(root, t.path));
      if (t.image && t.image.startsWith('Attachments/')) try { fs.unlinkSync(V.resolveInVault(root, t.image)); } catch { /* already gone */ }
    }
    for (const t of trackTrades()) V.createJournalTrade(root, t);
    state.examplesVersion = 3; startTrack(state); return true;
  }
  return false;
}

export function removeExamples(root) {
  let n = 0;
  for (const t of V.listJournal(root).filter(isExample)) {
    fs.unlinkSync(V.resolveInVault(root, t.path)); n++;
    if (t.image && t.image.startsWith('Attachments/')) try { fs.unlinkSync(V.resolveInVault(root, t.image)); } catch { /* already gone */ }
  }
  return n;
}

/** The chart of each example trade ships in the site's assets/ folder (desktop: next to the app). */
async function loadChart(name) {
  if (globalThis.KAIROS_WEB) {
    const r = await fetch(new URL(`../assets/${name}`, location.href));
    if (!r.ok) throw new Error(`chart ${name}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  return new Uint8Array(fs.readFileSync(new URL(`../../assets/${name}`, import.meta.url)));
}

/** Copy each example's chart into Attachments/ and link it from the note (also fixes vaults seeded before charts existed). */
export async function attachExampleCharts(root) {
  let n = 0;
  for (const t of V.listJournal(root).filter(isExample)) {
    if (t.image) continue;
    const ex = [...EXAMPLES, ...trackTrades()].find(e => e.asset === t.asset && e.date.replace('T', ' ') === t.date.slice(0, 16));
    if (!ex || !ex.chart) continue;
    const base = t.path.split('/').pop().replace(/\.md$/, ''), rel = `Attachments/${base}.webp`;
    fs.writeFileSync(V.resolveInVault(root, rel), await loadChart(ex.chart));
    const note = V.readNote(root, t.path);
    V.writeNote(root, t.path, { ...note.data, image: rel }, `![[${base}.webp]]\n\n${note.body.replace(/^\s+/, '')}`);
    n++;
  }
  return n;
}
