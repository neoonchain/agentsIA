// KairosGuard on a local EVM (Cancun): roles, every limit, rejections on the record, paper settlement, the drawdown pause,
// the daily-loss reset, and a router receiving accepted orders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VM } from '@ethereumjs/vm';
import { Common, Chain, Hardfork } from '@ethereumjs/common';
import { LegacyTransaction } from '@ethereumjs/tx';
import { Block } from '@ethereumjs/block';
import { Address, Account, hexToBytes, bytesToHex, privateToAddress } from '@ethereumjs/util';
import { Interface, keccak256, toUtf8Bytes } from 'ethers';

const art = JSON.parse(fs.readFileSync(new URL('../out/KairosGuard.json', import.meta.url)));
const G = new Interface(art.abi);
const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const key = n => hexToBytes('0x' + n.toString(16).padStart(64, '0'));
const OWNER = key(1), AGENT = key(2), STRANGER = key(3);
const addr = k => new Address(privateToAddress(k));
const USD = n => BigInt(Math.round(n * 1e6)), PX = n => BigInt(Math.round(n * 1e8));
const BTC = keccak256(toUtf8Bytes('BTC-PERP')), GOLD = keccak256(toUtf8Bytes('GOLD-XYZ')), WIF = keccak256(toUtf8Bytes('WIF-PERP'));
const DAY = 86400n;

async function setup(limits = [300, 600, 2500, 2, USD(5000)], equity = USD(10000)) {
  const vm = await VM.create({ common });
  for (const k of [OWNER, AGENT, STRANGER]) await vm.stateManager.putAccount(addr(k), new Account(0n, 10n ** 21n));
  const nonces = new Map(); let now = 1_800_000_000n;
  const block = () => Block.fromBlockData({ header: { timestamp: now, baseFeePerGas: 7n, gasLimit: 30_000_000n, number: 1n } }, { common });
  async function send(k, data, to) {
    const a = addr(k).toString(), n = nonces.get(a) || 0n; nonces.set(a, n + 1n);
    const tx = LegacyTransaction.fromTxData({ nonce: n, gasPrice: 10n, gasLimit: 6_000_000n, to, data }, { common }).sign(k);
    const r = await vm.runTx({ tx, block: block(), skipBlockGasLimitValidation: true });
    return { r, err: r.execResult.exceptionError, logs: r.receipt.logs.map(([, topics, d]) => { try { return G.parseLog({ topics: topics.map(bytesToHex), data: bytesToHex(d) }); } catch { return null; } }).filter(Boolean) };
  }
  const deploy = await send(OWNER, art.bytecode + G.encodeDeploy([addr(AGENT).toString(), limits, equity]).slice(2));
  assert.equal(deploy.err, undefined, 'deploys');
  const at = deploy.r.createdAddress;
  const call = (k, fn, args = []) => send(k, G.encodeFunctionData(fn, args), at);
  const view = async (fn, args = []) => G.decodeFunctionResult(fn, bytesToHex((await vm.evm.runCall({ to: at, data: hexToBytes(G.encodeFunctionData(fn, args)), block: block() })).execResult.returnValue));
  return { vm, at, call, view, send, advance: s => { now += s; } };
}
const order = (nonce, market, sizeUsd, limitPx, stopPx, { isBuy = true, reduceOnly = false } = {}) => [nonce, market, isBuy, USD(sizeUsd), PX(limitPx), PX(stopPx), reduceOnly, keccak256(toUtf8Bytes('decision ' + nonce))];
const reason = res => res.logs.find(l => l.name === 'OrderRejected')?.args.reason;
const accepted = res => res.logs.some(l => l.name === 'OrderAccepted');

test('only the agent proposes, only the owner changes limits, markets, the agent or unpauses', async () => {
  const g = await setup();
  await g.call(OWNER, 'setMarket', [BTC, true]);
  assert.ok((await g.call(STRANGER, 'submitOrder', order(1, BTC, 1000, 76000, 73000))).err, 'a stranger cannot trade');
  assert.ok((await g.call(AGENT, 'setLimits', [[10000, 10000, 10000, 50, USD(1e9)]])).err, 'the agent cannot loosen the limits');
  assert.ok((await g.call(AGENT, 'setMarket', [WIF, true])).err, 'the agent cannot add markets');
  assert.ok((await g.call(AGENT, 'setRouter', [addr(AGENT).toString()])).err, 'the agent cannot change where orders go');
  assert.ok((await g.call(STRANGER, 'pause', ['nope'])).err, 'a stranger cannot pause');
  assert.equal((await g.call(AGENT, 'pause', ['news shock'])).err, undefined, 'the agent can always stop');
  assert.ok((await g.call(AGENT, 'unpause')).err, 'only the owner resumes');
  assert.equal((await g.call(OWNER, 'unpause')).err, undefined);
});

test('every limit is checked and every rejection is on the record', async () => {
  const g = await setup(); // risk 3%, daily loss 6%, drawdown 25%, 2 positions, $5,000 max order, $10,000 equity
  await g.call(OWNER, 'setMarket', [BTC, true]); await g.call(OWNER, 'setMarket', [GOLD, true]);
  assert.equal(reason(await g.call(AGENT, 'submitOrder', order(1, WIF, 1000, 1, 0.9))), 'market not allowed');
  assert.equal(reason(await g.call(AGENT, 'submitOrder', order(2, BTC, 6000, 76000, 73000))), 'order larger than the max order size');
  assert.equal(reason(await g.call(AGENT, 'submitOrder', order(3, BTC, 1000, 76000, 77000))), 'stop on the wrong side');
  // $5,000 with a 10% stop risks $500 = 5% of equity > 3%
  assert.equal(reason(await g.call(AGENT, 'submitOrder', order(4, BTC, 5000, 76000, 68400))), 'risk per order above the limit');
  const ok = await g.call(AGENT, 'submitOrder', order(5, BTC, 2000, 76000, 72200)); // $2,000 x 5% = $100 = 1%
  assert.ok(accepted(ok)); assert.equal(ok.logs.find(l => l.name === 'OrderAccepted').args.paper, true, 'paper mode until a router is set');
  assert.equal(reason(await g.call(AGENT, 'submitOrder', order(5, GOLD, 1000, 4060, 3900))), 'nonce already used');
  assert.equal(reason(await g.call(AGENT, 'submitOrder', order(6, BTC, 1000, 76000, 72200))), 'position already open in this market');
  assert.ok(accepted(await g.call(AGENT, 'submitOrder', order(7, GOLD, 1000, 4060, 3900))));
  await g.call(OWNER, 'setMarket', [WIF, true]);
  assert.equal(reason(await g.call(AGENT, 'submitOrder', order(8, WIF, 500, 0.16, 0.15))), 'max open positions reached');
  assert.equal(reason(await g.call(AGENT, 'submitOrder', order(9, WIF, 500, 0.16, 0.15, { reduceOnly: true }))), 'no open position to reduce');
  assert.equal((await g.view('openPositions'))[0], 2n);
  const d = await g.call(AGENT, 'logDecision', [keccak256(toUtf8Bytes('hold')), 'Hold: market filter off']);
  assert.equal(d.logs[0].name, 'Decision'); assert.equal(d.logs[0].args.summary, 'Hold: market filter off');
});

test('results settle once; the daily loss limit blocks new orders until the next UTC day; a 25% drawdown pauses the Guard', async () => {
  const g = await setup([300, 600, 2500, 4, USD(5000)]);
  for (const m of [BTC, GOLD, WIF]) await g.call(OWNER, 'setMarket', [m, true]);
  await g.call(AGENT, 'submitOrder', order(1, BTC, 2000, 76000, 72200));
  assert.ok((await g.call(STRANGER, 'settle', [1, -USD(700), true])).err, 'only the router, or the agent in paper mode, reports results');
  const s = await g.call(AGENT, 'settle', [1, -USD(700), true]);
  assert.equal(s.logs[0].name, 'Settled'); assert.equal((await g.view('equityUsd'))[0], USD(9300));
  await g.call(AGENT, 'settle', [1, -USD(700), true]); // a duplicate callback changes nothing
  assert.equal((await g.view('equityUsd'))[0], USD(9300)); assert.equal((await g.view('openPositions'))[0], 0n);
  assert.equal(reason(await g.call(AGENT, 'submitOrder', order(2, GOLD, 1000, 4060, 3900))), 'daily loss limit reached'); // 7% down today
  g.advance(DAY);
  assert.ok(accepted(await g.call(AGENT, 'submitOrder', order(3, GOLD, 1000, 4060, 3900))), 'a new day, a new daily budget');
  await g.call(AGENT, 'settle', [3, -USD(1900), true]); // equity 7,400: 26% below the 10,000 peak
  assert.equal((await g.view('paused'))[0], true, 'the drawdown limit pauses the Guard by itself');
  g.advance(DAY);
  assert.equal(reason(await g.call(AGENT, 'submitOrder', order(4, WIF, 300, 0.16, 0.155))), 'guard is paused');
  await g.call(OWNER, 'unpause');
  assert.ok(accepted(await g.call(AGENT, 'submitOrder', order(5, WIF, 300, 0.16, 0.155))), 'resumes only when the owner decides, from a fresh peak');
});

test('with a router set, accepted orders are routed and only the router can settle them', async () => {
  const g = await setup();
  await g.call(OWNER, 'setMarket', [BTC, true]);
  // a stand-in router: stores the last routed nonce (runtime code below returns nothing and records calldata in storage slot 0)
  // PUSH1 0x04 CALLDATALOAD PUSH1 0x00 SSTORE STOP  -> slot0 = first argument (nonce)
  const runtime = '6004356000' + '55' + '00';
  const initcode = '0x' + '6007' + '600c' + '6000' + '39' + '6007' + '6000' + 'f3' + runtime; // CODECOPY(0, 12, 7) RETURN(0, 7)
  const dep = await g.send(OWNER, initcode); const routerAddr = dep.r.createdAddress;
  await g.call(OWNER, 'setRouter', [routerAddr.toString()]);
  const res = await g.call(AGENT, 'submitOrder', order(42, BTC, 1000, 76000, 72200));
  assert.equal(res.logs.find(l => l.name === 'OrderAccepted').args.paper, false);
  const stored = await g.vm.stateManager.getContractStorage(routerAddr, hexToBytes('0x' + '0'.repeat(64)));
  assert.equal(BigInt(bytesToHex(stored)), 42n, 'the router received the order');
  assert.ok((await g.call(AGENT, 'settle', [42, USD(50), true])).err, 'once a router is set, the agent cannot report results itself');
});
