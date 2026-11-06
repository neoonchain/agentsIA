process.env.KAIROS_EXAMPLES = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-dip-'));
process.env.KAIROS_VAULT = path.join(tmp, 'vault'); process.env.KAIROS_HOME = path.join(tmp, 'home');
const { stepTrack, newTrack, summary, dailyReadings, DAY, DIP_ASSETS } = await import('../src/lib/dipbuyer.js');
const { setMockMarket } = await import('../src/lib/market.js');
const { App } = await import('../src/lib/core.js');
const { createApi } = await import('../src/lib/routes.js');
const V = await import('../src/lib/vault.js');

// 260 days: BTC climbs steadily; ETH climbs, dips hard for 2 days, the dip fills, then it bounces back above its 10-day average.
const T0 = Date.UTC(2026, 0, 1);
function market(days = 260, dipAt = 250) {
  const out = {};
  for (const a of DIP_ASSETS) {
    let p = a === 'BTC-USD' ? 50000 : 100; out[a] = [];
    for (let i = 0; i < days; i++) {
      const prev = p;
      if (a === 'ETH-USD' && i === dipAt) p *= 0.95;                                       // the sharp dip
      else if (a === 'ETH-USD' && i === dipAt + 1) p *= 0.999;                      // fill day: trades back to the limit
      else if (a === 'ETH-USD' && i > dipAt + 1) p *= 1.03;                         // the bounce
      else p *= 1.003;                                                              // steady uptrend
      const lo = Math.min(prev, p) * (a === 'ETH-USD' && i === dipAt + 1 ? 0.995 : 0.998);
      out[a].push({ t: T0 + i * DAY, open: prev, high: Math.max(prev, p) * 1.002, low: lo, close: p, volume: 1000 });
    }
  }
  return out;
}

test('the Dip buyer rules buy a sharp dip in an uptrend while BTC is healthy, and sell the bounce', () => {
  const d = market(), st = newTrack(T0 + 230 * DAY);
  const days = []; const { trades } = stepTrack(st, d, T0 + 259 * DAY, x => days.push(x));
  const eth = trades.filter(t => t.asset === 'ETH-USD');
  assert.equal(eth.length, 1, JSON.stringify(trades.map(t => [t.asset, t.why])));
  assert.match(eth[0].why, /take profit|back above the 10-day average/); assert.ok(eth[0].pnl > 0);
  assert.ok(eth[0].ctx.rsi < 15 && eth[0].ctx.btcVsAvg > 0, JSON.stringify(eth[0].ctx));
  assert.ok(days.every(x => x.regime)); assert.equal(st.lastT, T0 + 259 * DAY);
  // with BTC under its 200-day average the market filter keeps it out
  const bear = market(); bear['BTC-USD'] = bear['BTC-USD'].map((c, i) => ({ ...c, close: 90000 - i * 100, open: 90000 - i * 100, high: 90000 - i * 100 + 50, low: 90000 - i * 100 - 50 }));
  assert.equal(stepTrack(newTrack(T0 + 230 * DAY), bear, T0 + 259 * DAY).trades.length, 0);
  const r = dailyReadings(Object.fromEntries(Object.entries(d).map(([a, c]) => [a, c.slice(0, 252)])), T0 + 253 * DAY);
  assert.equal(r.market.on, true); assert.equal(r.assets['ETH-USD'].signal, true); assert.equal(r.assets['BTC-USD'].signal, false);
  assert.equal(summary(eth).winRate, 1);
});

test('the paper track continues day by day in the app and writes its trades into the example journal', async () => {
  const app = new App(); app.state.examples = 'seeded'; app.state.track = newTrack(T0 + 230 * DAY);
  const d = market(); setMockMarket({ prices: {}, daily: d });
  try {
    const now = T0 + 260 * DAY + 3600000; // an hour after the last daily candle closed
    const added = await app.trackTick(now);
    assert.ok(added.length >= 1); assert.equal(app.state.track.lastT, T0 + 259 * DAY);
    const n = V.readNote(app.vault, added.find(p => p.includes('ETH')));
    assert.equal(n.data.strategy, 'Dip buyer'); assert.ok(n.data.tags.includes('example') && n.data.tags.includes('paper-track'));
    assert.match(n.body, /Market on .*BTC .* 200-day average/); assert.match(n.body, /RSI\(2\)/);
    const dec = app.state.decisions['Dip buyer']; // one decision per day, newest first, holds included
    assert.equal(dec.length, 30); assert.ok(dec.every(d => d.track && d.example)); assert.ok(dec[0].at > dec[1].at);
    assert.ok(dec.some(d => d.outcome === 'order' && d.asset === 'ETH-USD') && dec.some(d => d.outcome === 'hold'));
    assert.match(dec.find(d => d.outcome === 'hold').thesis, /Market filter ON/);
    assert.deepEqual(await app.trackTick(now + 600000), []); // nothing new until the next daily close
    app.state.examples = 'removed'; app.state.track.lastT = T0;
    assert.deepEqual(await app.trackTick(now + 2 * DAY), []); // removing the examples stops the track
  } finally { setMockMarket(null); }
});

test('the stats count your own trades once you have any; the examples stay listed', async () => {
  process.env.KAIROS_VAULT = path.join(tmp, 'own');
  const app = new App(), api = createApi(app);
  V.createJournalTrade(app.vault, { date: '2026-11-01T10:00', asset: 'BTC-USD', side: 'long', entry: 1, stop: 0.9, exit: 1.1, size: 1, pnl: -50, tags: 'example' });
  V.createJournalTrade(app.vault, { date: '2026-11-02T10:00', asset: 'BTC-USD', side: 'long', entry: 1, stop: 0.9, exit: 1.1, size: 1, pnl: 20, tags: 'example' });
  let s = (await api('GET', '/api/status', new URLSearchParams())).body;
  assert.equal(s.statsFrom, 'examples'); assert.equal(s.journalCount, 2); assert.equal(s.examples, 2);
  V.createJournalTrade(app.vault, { date: '2026-11-03T10:00', asset: 'ETH-USD', side: 'long', entry: 1, stop: 0.9, exit: 1.2, size: 1, pnl: 30 });
  s = (await api('GET', '/api/status', new URLSearchParams())).body;
  assert.equal(s.statsFrom, 'own'); assert.equal(s.journalCount, 1); assert.equal(s.journal.totalPnl, 30); assert.equal(s.examples, 2);
});

test('a vault seeded with paper test 6 moves to the Dip buyer track, keeping your own trades', async () => {
  const { seedExamples } = await import('../src/lib/examples.js');
  const dir = path.join(tmp, 'v2'); V.initVault(dir);
  V.createJournalTrade(dir, { date: '2025-01-02T10:00', asset: 'BTC-USD', pnl: -10, tags: 'example, paper-test-6, breakout' });
  V.createJournalTrade(dir, { date: '2025-01-03T10:00', asset: 'ETH-USD', pnl: 12, tags: 'example, paper-test, breakout' });
  V.createJournalTrade(dir, { date: '2025-01-04T10:00', asset: 'SOL-USD', pnl: 5, tags: 'mine' });
  const state = { examples: 'seeded', examplesVersion: 2 };
  assert.equal(seedExamples(dir, state), true);
  const j = V.listJournal(dir);
  assert.equal(j.filter(t => t.tags.includes('paper-test-6')).length, 0);
  assert.equal(j.filter(t => t.tags.includes('paper-track')).length, 80);
  assert.ok(j.some(t => t.tags.includes('mine')) && j.some(t => t.tags.includes('paper-test')));
  assert.equal(state.examplesVersion, 3); assert.ok(state.track); assert.equal(state.decisions['Dip buyer'].length, 30);
  assert.equal(seedExamples(dir, state), false); // only once
  assert.ok(fs.existsSync(path.join(dir, 'Strategies', 'Dip buyer.md')) && fs.existsSync(path.join(dir, 'Lessons', 'Dip buyer.md')));
});
