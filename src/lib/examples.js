// Example journal: the paper tracks of the two strategies Kairos ships with, on real Coinbase daily prices
// (Dip buyer and Trend rider, $5,000 each, the last two years; Pullback on Nasdaq 100 and gold since Hyperliquid listed them;
// continued every day by the app).
// Seeded into an empty vault so a new user sees what a filled journal looks like. All tagged "example",
// removable in one click; every paper test (wins and losses) stays on the Track record.
import fs from 'node:fs';
import * as V from './vault.js';
import { TRACK, TRACK_STATE, TRACK_DECISIONS } from './examples-dip.js';
import { TREND_TRACK, TREND_STATE, TREND_DECISIONS } from './examples-trend.js';
import { PULLBACK_TRACK, PULLBACK_STATE, PULLBACK_DECISIONS } from './examples-pullback.js';
import { trackJournalEntry } from './dipbuyer.js';
import { trendJournalEntry } from './trendrider.js';
import { pullbackJournalEntry } from './pullback.js';

export const EXAMPLE_TAG = 'example';

const isExample = t => (t.tags || []).includes(EXAMPLE_TAG);

/** The two paper tracks shipped with the app (Dip buyer and Trend rider, $5,000 each), as journal entries with their charts. */
export function trackTrades() {
  return TRACK.map(([asset, opened, closed, entry, stop, tp, exit, qty, pnl, r, why, days, ctx], k) => ({
    ...trackJournalEntry({ asset, t: Date.parse(opened), entry, stop, tp, exit, qty, pnl, r, why, days, ctx }), chart: `dip-${String(k + 1).padStart(3, '0')}.webp`,
  }));
}
export function trendTrades() {
  return TREND_TRACK.map(([asset, opened, closed, entry, stop, exit, qty, pnl, r, why, days, ctx], k) => ({
    ...trendJournalEntry({ asset, t: Date.parse(opened), entry, stop, exit, qty, pnl, r, why, days, ctx }), chart: `trend-${String(k + 1).padStart(3, '0')}.webp`,
  }));
}
export function pullbackTrades() {
  return PULLBACK_TRACK.map(([asset, opened, closed, entry, stop, exit, qty, pnl, r, why, days, fees, ctx], k) => ({
    ...pullbackJournalEntry({ asset, t: Date.parse(opened), entry, stop, exit, qty, pnl, r, why, days, fees, ctx }), chart: `pullback-${String(k + 1).padStart(3, '0')}.webp`,
  }));
}
const allTrackTrades = () => [...trackTrades(), ...trendTrades(), ...pullbackTrades()];
const copy = x => JSON.parse(JSON.stringify(x));
function startTracks(state) {
  state.track = copy(TRACK_STATE); state.trend = copy(TREND_STATE);
  const d = state.decisions ||= {};
  d['Dip buyer'] = copy(TRACK_DECISIONS); d['Trend rider'] = copy(TREND_DECISIONS);
  startPullback(state);
}
function startPullback(state) { state.pullback = copy(PULLBACK_STATE); (state.decisions ||= {}).Pullback = copy(PULLBACK_DECISIONS); }

/** Seed the examples once, into a journal that has never had any trades. Vaults seeded by an older version move to v4:
 *  their example trades are replaced by the two tracks (your own trades are never touched). */
export function seedExamples(root, state) {
  if (!state.examples) {
    state.examples = V.listJournal(root).length ? 'skipped' : 'seeded';
    if (state.examples !== 'seeded') return false;
    for (const t of allTrackTrades()) V.createJournalTrade(root, t);
    state.examplesVersion = 5; startTracks(state); return true;
  }
  if (state.examples === 'seeded' && state.examplesVersion === 4) { // v5 adds the Pullback track next to the two others
    for (const t of pullbackTrades()) V.createJournalTrade(root, t);
    state.examplesVersion = 5; startPullback(state); return true;
  }
  if (state.examples === 'seeded' && (state.examplesVersion || 1) < 4) {
    removeExamples(root);
    for (const t of allTrackTrades()) V.createJournalTrade(root, t);
    state.examplesVersion = 5; startTracks(state); return true;
  }
  return false;
}

/** Remove the example trades and stop the tracks, with their example decisions. */
export function removeExampleState(state) {
  delete state.track; delete state.trend; delete state.pullback;
  for (const [k, ds] of Object.entries(state.decisions || {})) { state.decisions[k] = ds.filter(d => !d.example); if (!state.decisions[k].length) delete state.decisions[k]; }
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
    const ex = allTrackTrades().find(e => e.asset === t.asset && e.date.replace('T', ' ') === t.date.slice(0, 16));
    if (!ex || !ex.chart) continue;
    const base = t.path.split('/').pop().replace(/\.md$/, ''), rel = `Attachments/${base}.webp`;
    fs.writeFileSync(V.resolveInVault(root, rel), await loadChart(ex.chart));
    const note = V.readNote(root, t.path);
    V.writeNote(root, t.path, { ...note.data, image: rel }, `![[${base}.webp]]\n\n${note.body.replace(/^\s+/, '')}`);
    n++;
  }
  return n;
}
