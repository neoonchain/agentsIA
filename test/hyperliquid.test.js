process.env.KAIROS_EXAMPLES = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-hl-'));
process.env.KAIROS_VAULT = path.join(tmp, 'vault'); process.env.KAIROS_HOME = path.join(tmp, 'home');
const HL = await import('../src/lib/hyperliquid.js');
const M = await import('../src/lib/market.js');
const { App } = await import('../src/lib/core.js');

// a stand-in for api.hyperliquid.xyz/info
const calls = [];
const realFetch = globalThis.fetch;
function fakeHyperliquid() {
  globalThis.fetch = async (url, opts) => {
    if (!String(url).includes('hyperliquid')) return realFetch(url, opts);
    const body = JSON.parse(opts.body); calls.push(body.type);
    const json = body.type === 'meta' ? { universe: [{ name: 'BTC' }, { name: 'kPEPE' }, { name: 'OLD', isDelisted: true }] }
      : body.type === 'allMids' ? { BTC: '76000.5', kPEPE: '0.00507' }
      : body.type === 'candleSnapshot' ? Array.from({ length: 10 }, (_, i) => ({ t: 1000 + i, o: '1', h: '2', l: '0.5', c: String(1 + i / 10), v: '100' }))
      : body.type === 'fundingHistory' ? [{ time: 1, fundingRate: '0.0000125' }] : null;
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('Hyperliquid perps: COIN-PERP ids map to Hyperliquid coins, prices and candles come from its public API', async () => {
  fakeHyperliquid();
  try {
    assert.equal(HL.isPerp('BTC-PERP'), true); assert.equal(HL.isPerp('BTC-USD'), false);
    assert.deepEqual(await HL.listPerps(), ['BTC-PERP', 'KPEPE-PERP']); // delisted markets are left out
    assert.equal(await HL.coinOf('KPEPE-PERP'), 'kPEPE');
    await assert.rejects(HL.coinOf('NOPE-PERP'), /not listed on Hyperliquid/);
    assert.equal(await M.getPrice('KPEPE-PERP'), 0.00507);
    const c = await M.getCandles('BTC-PERP', 5);
    assert.equal(c.length, 5); assert.deepEqual(Object.keys(c[0]), ['t', 'open', 'high', 'low', 'close', 'volume']); assert.equal(typeof c[0].close, 'number');
    assert.equal((await HL.funding('BTC-PERP', 0))[0].rate, 0.0000125);
    assert.ok(calls.includes('candleSnapshot') && calls.includes('allMids'));
  } finally { globalThis.fetch = realFetch; }
});

test('Hyperliquid markets are paper-only until Kairos trades HyperCore through Elysium', async () => {
  const app = new App(), V = await import('../src/lib/vault.js');
  V.writeNote(app.vault, 'Strategies/Perp test.md', { name: 'Perp test', status: 'stopped', assets: ['BTC-PERP'], timeframe: '1h', risk_per_trade_pct: 1 }, '# Perp test\n');
  app.state.promotions['Perp test'] = { status: 'approved', tierUsd: 250 };
  app.config.kraken = { key: 'k', secret: 's' }; app.config.apiKey = 'x';
  await assert.rejects(app.enableLive('Perp test', { mode: 'validate' }), e => e.code === 'PAPER_ONLY' && /paper-only/.test(e.message));
});
