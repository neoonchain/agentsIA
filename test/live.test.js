import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsia-live-'));
process.env.AGENTSIA_HOME = path.join(tmp, 'home');
process.env.AGENTSIA_VAULT = path.join(tmp, 'vault');

const K = await import('../src/lib/kraken.js');
const V = await import('../src/lib/vault.js');
const { App } = await import('../src/lib/core.js');
const { updateConfig } = await import('../src/lib/config.js');
const { setMockLLM } = await import('../src/lib/llm.js');
const { setMockMarket } = await import('../src/lib/market.js');

/* ---------- fake Kraken: verifies signatures, keeps an order book of our orders ---------- */
const SECRET = Buffer.from('test-secret-for-agentsia').toString('base64');
const ex = { canWithdraw: false, usd: 1000, price: { 'XBTUSD': 100, 'PEPEUSD': 0.0000049 }, vol: 5e6, spread: 0.01, orders: {}, calls: [], seq: 0 };
const PAIRS = {
  XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', lot_decimals: 8, pair_decimals: 1, tick_size: '0.1', ordermin: '0.00005', costmin: '0.5', status: 'online' },
  PEPEUSD: { altname: 'PEPEUSD', wsname: 'PEPE/USD', base: 'PEPE', quote: 'ZUSD', lot_decimals: 5, pair_decimals: 9, tick_size: '0.000000001', ordermin: '1100000', costmin: '0.5', status: 'online' },
};
const kraken = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); let body = ''; for await (const c of req) body += c;
  const ok = result => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: [], result })); };
  const bad = (...e) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e })); };
  if (url.pathname === '/0/public/AssetPairs') return ok(PAIRS);
  if (url.pathname === '/0/public/Ticker') {
    const alt = url.searchParams.get('pair'), p = ex.price[alt], h = p * ex.spread / 200;
    return ok({ [alt]: { a: [String(p + h)], b: [String(p - h)], c: [String(p)], v: ['1', String(ex.vol / p)], p: ['1', String(p)] } });
  }
  if (url.pathname === '/0/public/OHLC') return ok({ X: [], last: 0 });
  // private: check auth exactly like Kraken
  const params = Object.fromEntries(new URLSearchParams(body));
  if (req.headers['api-key'] !== 'KEY' || req.headers['api-sign'] !== K.sign(url.pathname, body, params.nonce, SECRET)) return bad('EAPI:Invalid key');
  const m = url.pathname.split('/').pop();
  ex.calls.push({ m, ...params });
  if (m === 'Balance') return ok({ ZUSD: String(ex.usd) });
  if (m === 'WithdrawInfo') return ex.canWithdraw ? bad('EFunding:Unknown withdraw key') : bad('EGeneral:Permission denied');
  if (m === 'AddOrder') {
    if (params.validate === 'true') return ok({ descr: { order: `${params.type} ${params.volume} ${params.pair} @ ${params.ordertype}` } });
    const id = 'O' + (++ex.seq), px = ex.price[params.pair];
    ex.orders[id] = params.ordertype === 'market'
      ? { status: 'closed', vol_exec: params.volume, price: String(px), cost: String(px * params.volume), fee: String(px * params.volume * 0.004), descr: params }
      : { status: 'open', vol_exec: '0', price: '0', fee: '0', descr: params };
    return ok({ txid: [id] });
  }
  if (m === 'QueryOrders') return ok(Object.fromEntries(params.txid.split(',').map(t => [t, ex.orders[t]])));
  if (m === 'CancelOrder') { if (ex.orders[params.txid]?.status !== 'open') return bad('EOrder:Unknown order'); ex.orders[params.txid].status = 'canceled'; return ok({ count: 1 }); }
  bad('EGeneral:Unknown method');
});

let app, vn = 0;
const freshVault = () => { process.env.AGENTSIA_VAULT = path.join(tmp, 'vault' + (++vn)); };
const RULES = { min_trades: 0, min_days: 0, min_profit_factor: 0, max_drawdown_pct: 8, daily_loss_pct: 3, min_adherence_pct: 0, max_risk_per_trade_pct: 2 };
function proposal(over = {}) {
  setMockLLM(({ task }) => {
    if (task === 'propose') return JSON.stringify({ action: 'open', asset: 'BTC-USD', side: 'long', stop: 95, take_profit: 110, risk_pct: 1, thesis: 'breakout', ...over });
    if (task === 'review') return '{"agree": true, "reason": "ok"}';
    return '{}';
  });
}
async function approvedLiveApp(mode = 'real') {
  ex.orders = {}; ex.calls = []; ex.usd = 1000; ex.price.XBTUSD = 100;
  freshVault(); app = new App();
  app.setConfig(updateConfig(app.config, { apiKey: 'or-key', mode: 'solo' }));
  const n = V.readNote(app.vault, 'rules.md'); V.writeNote(app.vault, 'rules.md', { ...n.data, ...RULES }, n.body);
  const s = V.readNote(app.vault, 'Strategies/Range breakout.md'); V.writeNote(app.vault, 'Strategies/Range breakout.md', { ...s.data, assets: ['BTC-USD', 'PEPE-USD'], hours_utc: '00:00-23:59' }, s.body);
  const acc = app.account('Range breakout'); acc.trades = [{ pnl: 20, r: 2 }, { pnl: -5, r: -0.5 }]; acc.proposals = { total: 1, offStrategy: 0 };
  app.promotion('Range breakout', 'request'); app.promotion('Range breakout', 'approve');
  await app.setKraken({ key: 'KEY', secret: SECRET });
  await app.enableLive('Range breakout', { mode, confirm: 'Range breakout' });
  return app;
}

before(() => new Promise(r => kraken.listen(0, '127.0.0.1', () => { process.env.KRAKEN_URL = `http://127.0.0.1:${kraken.address().port}`; K.clearPairCache(); r(); })));
after(() => kraken.close());
setMockMarket({ prices: { 'BTC-USD': 100, 'PEPE-USD': 0.0000049 }, candles: [] });

test('signature matches the example in Kraken\'s docs', () => {
  assert.equal(K.sign('/0/private/AddOrder', 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25', 1616492376594,
    'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg=='),
  '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
});

test('pairs resolve BTC→XBT, memecoins keep tiny precision', async () => {
  assert.equal((await K.resolvePair('BTC-USD')).altname, 'XBTUSD');
  const p = await K.resolvePair('PEPE-USD');
  assert.equal(K.roundPrice(0.00000468123, p), 0.000004681);
  await assert.rejects(K.resolvePair('NOPE-USD'), /not tradable/);
});

test('keys that can withdraw are refused; wrong secret is refused', async () => {
  freshVault(); app = new App();
  ex.canWithdraw = true;
  await assert.rejects(app.setKraken({ key: 'KEY', secret: SECRET }), /can withdraw/);
  ex.canWithdraw = false;
  await assert.rejects(app.setKraken({ key: 'KEY', secret: Buffer.from('wrong').toString('base64') }), /Invalid key/);
  await app.setKraken({ key: 'KEY', secret: SECRET });
  assert.ok(app.config.kraken.checkedAt);
});

test('going live needs an approved promotion and typed confirmation for real money', async () => {
  freshVault(); app = new App(); app.setConfig(updateConfig(app.config, { apiKey: 'or-key' }));
  await assert.rejects(app.enableLive('Range breakout', { mode: 'real' }), /Approve the promotion/);
  await approvedLiveApp('validate');
  await assert.rejects(app.enableLive('Range breakout', { mode: 'real', confirm: 'yes' }), /Type the strategy name/);
});

test('real mode: market buy, then an exchange-side stop for the filled volume', async () => {
  await approvedLiveApp('real'); proposal();
  const r = await app.decide('Range breakout', { manual: true });
  assert.equal(r.verdict.ok, true, r.verdict.reasons.join());
  const live = app.liveOf('Range breakout'), pos = live.account.positions['BTC-USD'];
  const buy = ex.calls.find(c => c.m === 'AddOrder' && c.type === 'buy'), stop = ex.calls.find(c => c.m === 'AddOrder' && c.ordertype === 'stop-loss');
  assert.equal(buy.ordertype, 'market'); assert.equal(buy.oflags, 'fciq'); assert.equal(buy.validate, undefined);
  assert.ok(Math.abs(Number(buy.volume) - 2.5 / (100.005 - 95)) < 1e-7, buy.volume); // $250 × 1% = $2.50 risk ÷ distance from ask to stop
  assert.equal(stop.type, 'sell'); assert.equal(stop.price, '95'); assert.equal(stop.volume, buy.volume);
  assert.ok(pos.stopTxid && pos.entryTxid);
  assert.ok(!ex.calls.some(c => c.leverage)); // never margin
  const note = V.readNote(app.vault, pos.notePath).data;
  assert.equal(note.account, 'kraken-real'); assert.equal(note.kraken_stop, pos.stopTxid);
});

test('stop filled on Kraken is detected; take profit cancels the stop and sells', async () => {
  await approvedLiveApp('real'); proposal();
  await app.decide('Range breakout', { manual: true });
  let live = app.liveOf('Range breakout'); let pos = live.account.positions['BTC-USD'];
  Object.assign(ex.orders[pos.stopTxid], { status: 'closed', price: '95', vol_exec: String(pos.qty), fee: '0.1' });
  live.account.lastDecisionAt = new Date().toISOString();
  await app.tick();
  assert.equal(Object.keys(live.account.positions).length, 0);
  assert.equal(live.account.trades.at(-1).reason, 'stop'); assert.ok(live.account.trades.at(-1).pnl < 0);
  // take profit
  live.account.paused = null; await app.decide('Range breakout', { manual: true });
  pos = live.account.positions['BTC-USD'];
  ex.price.XBTUSD = 111;
  await app.tick();
  assert.equal(ex.orders[pos.stopTxid].status, 'canceled');
  assert.equal(live.account.trades.at(-1).reason, 'take profit'); assert.ok(live.account.trades.at(-1).pnl > 0);
});

test('a stop removed on Kraken is never left unprotected: position is sold', async () => {
  await approvedLiveApp('real'); proposal();
  await app.decide('Range breakout', { manual: true });
  const live = app.liveOf('Range breakout'), pos = live.account.positions['BTC-USD'];
  ex.orders[pos.stopTxid].status = 'canceled';
  live.account.lastDecisionAt = new Date().toISOString();
  await app.tick();
  assert.equal(live.account.trades.at(-1).reason, 'stop missing on Kraken');
});

test('live Brake: no shorts, no illiquid or wide-spread memecoins', async () => {
  await approvedLiveApp('real');
  proposal({ side: 'short', stop: 105, take_profit: 90 });
  assert.match((await app.decide('Range breakout', { manual: true })).verdict.reasons.join(), /no shorting/);
  ex.vol = 1000; proposal({ asset: 'PEPE-USD', stop: 0.0000045, take_profit: 0.0000055 });
  assert.match((await app.decide('Range breakout', { manual: true })).verdict.reasons.join(), /24h volume/);
  ex.vol = 5e6; ex.spread = 2;
  assert.match((await app.decide('Range breakout', { manual: true })).verdict.reasons.join(), /Spread/);
  ex.spread = 0.01;
  assert.equal(ex.calls.filter(c => c.m === 'AddOrder').length, 0);
});

test('validate mode: Kraken validates, nothing is placed', async () => {
  await approvedLiveApp('validate'); proposal();
  const r = await app.decide('Range breakout', { manual: true });
  assert.equal(r.verdict.ok, true);
  const adds = ex.calls.filter(c => c.m === 'AddOrder');
  assert.equal(adds.length, 2); assert.ok(adds.every(c => c.validate === 'true'));
  assert.equal(Object.keys(ex.orders).length, 0);
});

test('live drawdown stop sells everything and sends the strategy back to paper', async () => {
  await approvedLiveApp('real'); proposal();
  await app.decide('Range breakout', { manual: true });
  const live = app.state.live['Range breakout'];
  live.account.balance -= 30; // a 12% hit on a $250 allocation
  live.account.lastDecisionAt = new Date().toISOString();
  await app.tick();
  assert.equal(live.enabled, false); assert.match(live.stoppedReason, /drawdown/);
  assert.equal(Object.keys(live.account.positions).length, 0);
  assert.equal(app.strategy('Range breakout').status, 'stopped');
});

test('back to paper by you closes real positions; insufficient USD blocks going live', async () => {
  await approvedLiveApp('real'); proposal();
  await app.decide('Range breakout', { manual: true });
  await app.disableLive('Range breakout');
  assert.equal(app.liveOf('Range breakout'), null);
  assert.ok(ex.calls.some(c => c.m === 'AddOrder' && c.type === 'sell' && c.ordertype === 'market'));
  ex.usd = 100;
  await assert.rejects(app.enableLive('Range breakout', { mode: 'real', confirm: 'Range breakout' }), /below the \$250/);
});
