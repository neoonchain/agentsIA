process.env.KAIROS_EXAMPLES = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-gate-'));
process.env.KAIROS_VAULT = path.join(tmp, 'vault'); process.env.KAIROS_HOME = path.join(tmp, 'home');
const { App } = await import('../src/lib/core.js');
const { createApi } = await import('../src/lib/routes.js');
const W = await import('../src/lib/wallet.js');

const WALLET = '0x90743b3bfc1c047d3eaae33e66af429de058a774', OTHER = '0x1111111111111111111111111111111111111111';
const trade = { date: '2026-11-08T10:00', asset: 'BTC-USD', side: 'long', entry: 100, stop: 95, exit: 110, size: 1 };

test('the gate is off until a KAIROS token and price are configured: everything works as before', async () => {
  const app = new App(), api = createApi(app);
  assert.equal((await api('POST', '/api/journal', new URLSearchParams(), trade)).status, 200);
  assert.deepEqual(await app.gateStatus(), { on: false, access: true, address: null });
});

test('with the gate on, guests can look but not use; a holder with at least $1 of KAIROS can', async () => {
  const app = new App(), api = createApi(app);
  app.config.gate = { ...app.config.gate, token: '0x2222222222222222222222222222222222222222', usdPerToken: 0.5, minUsd: 1 };
  let balance = 1; // 1 KAIROS x $0.50 = $0.50
  app.readBalance = async () => balance;
  app.recoverSigner = async (rpc, message, signature) => signature === 'good' && message.includes(WALLET) ? WALLET : OTHER;
  const q = new URLSearchParams();
  // guest: reading works, changing does not
  assert.equal((await api('GET', '/api/status', q)).status, 200);
  assert.equal((await api('GET', '/api/journal', q)).status, 200);
  const blocked = await api('POST', '/api/journal', q, trade);
  assert.equal(blocked.status, 401); assert.equal(blocked.body.code, 'NEED_WALLET');
  // sign in: a one-time nonce, and the signature must come from that wallet
  const n1 = (await api('POST', '/api/auth/nonce', q)).body;
  assert.equal((await api('POST', '/api/auth/verify', q, { address: WALLET, ...n1, signature: 'forged' })).status, 401);
  assert.equal((await api('POST', '/api/auth/verify', q, { address: WALLET, ...n1, signature: 'good' })).status, 400, 'a nonce works once');
  const n2 = (await api('POST', '/api/auth/nonce', q)).body;
  const ok = await api('POST', '/api/auth/verify', q, { address: WALLET, ...n2, signature: 'good' });
  assert.equal(ok.status, 200); assert.equal(ok.body.address, WALLET); assert.equal(ok.body.usd, 0.5); assert.equal(ok.body.access, false);
  const poor = await api('POST', '/api/journal', q, trade);
  assert.equal(poor.status, 403); assert.equal(poor.body.code, 'NEED_TOKENS'); assert.match(poor.body.error, /\$0\.5 of KAIROS.*at least \$1/);
  balance = 3; await app.gateStatus({ refresh: true }); // they bought more: 3 x $0.50 = $1.50
  assert.equal((await api('POST', '/api/journal', q, trade)).status, 200);
  balance = 0; await app.gateStatus({ refresh: true }); // they sold: access goes with the tokens
  assert.equal((await api('POST', '/api/journal', q, trade)).status, 403);
  await api('POST', '/api/auth/logout', q);
  assert.equal((await api('POST', '/api/journal', q, trade)).status, 401);
});

test('the login message names the wallet and says signing moves no funds', () => {
  const m = W.loginMessage(WALLET, 'abc', '2026-11-08T10:00:00.000Z');
  assert.match(m, new RegExp(WALLET)); assert.match(m, /moves no funds/); assert.match(m, /Nonce: abc/);
  assert.equal(W.isAddress(WALLET), true); assert.equal(W.isAddress('0x12'), false);
});
