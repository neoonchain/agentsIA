process.env.KAIROS_EXAMPLES = '0'; // tests start from an empty journal
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-proxy-'));
process.env.KAIROS_HOME = path.join(tmp, 'home');
process.env.KAIROS_VAULT = path.join(tmp, 'vault');

const { createProxy, loadSettings } = await import('../proxy/server.js');
const { App } = await import('../src/lib/core.js');
const { updateConfig } = await import('../src/lib/config.js');
const { NeedKeyError, setMockLLM } = await import('../src/lib/llm.js');
setMockLLM(null);

// Fake OpenRouter: records what the proxy sends, answers with a cost.
const seen = [];
let upstreamFail = false;
const upstream = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  seen.push({ auth: req.headers.authorization, body: JSON.parse(b) });
  if (upstreamFail) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"boom"}}'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '{"agree": true, "issues": []}' } }], usage: { cost: 0.01 } }));
});

let proxy, base, S;
const OPERATOR = 'sk-or-operator-SECRET';
function startProxy(over = {}) {
  S = { ...loadSettings(), apiKey: OPERATOR, upstream: `http://127.0.0.1:${upstream.address().port}`, dataFile: path.join(tmp, 'usage-' + Math.random() + '.json'), host: '127.0.0.1', ...over };
  proxy = createProxy(S);
  return new Promise(r => proxy.server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${proxy.server.address().port}`; r(); }));
}
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, j: await r.json() }));
const id = n => `install-${String(n).padStart(12, '0')}`;
const msg = [{ role: 'user', content: 'hi' }];

before(() => new Promise(r => upstream.listen(0, '127.0.0.1', r)));
after(() => { upstream.close(); proxy?.server.close(); });

test('2 instructions per install, each with several calls, then 429', async () => {
  await startProxy();
  for (let k = 0; k < 2; k++) {
    const s = await post('/v1/free/start', { installId: id(1) });
    assert.equal(s.status, 200); assert.ok(s.j.ticket);
    for (let c = 0; c < 3; c++) assert.equal((await post('/v1/free/chat', { ticket: s.j.ticket, model: 'anthropic/claude-opus-5.5', messages: msg })).status, 200);
  }
  const third = await post('/v1/free/start', { installId: id(1) });
  assert.equal(third.status, 429); assert.equal(third.j.code, 'FREE_USED');
  assert.ok(seen.every(x => x.auth === `Bearer ${OPERATOR}`));
  proxy.server.close();
});

test('operator key never appears in responses; requests are sanitised', async () => {
  seen.length = 0; await startProxy();
  const s = await post('/v1/free/start', { installId: id(2) });
  const r = await fetch(base + '/v1/free/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: s.j.ticket, model: 'openai/gpt-6.1-terra', max_tokens: 999999, plugins: [{ id: 'web' }], tools: [{}], messages: [{ role: 'user', content: 'x', extra: 1 }] }) });
  const text = await r.text();
  assert.equal(r.status, 200); assert.ok(!text.includes(OPERATOR));
  const sent = seen.at(-1).body;
  assert.equal(sent.max_tokens, S.maxTokens); assert.equal(sent.plugins, undefined); assert.equal(sent.tools, undefined);
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'x' }]);
  proxy.server.close();
});

test('model allowlist, ticket call cap, bad tickets, bad install ids', async () => {
  await startProxy({ callsPerTicket: 2 });
  assert.equal((await post('/v1/free/start', { installId: 'short' })).status, 400);
  const s = await post('/v1/free/start', { installId: id(3) });
  assert.equal((await post('/v1/free/chat', { ticket: s.j.ticket, model: 'openai/o99-expensive', messages: msg })).status, 400);
  assert.equal((await post('/v1/free/chat', { ticket: 'forged', model: 'anthropic/claude-opus-5.5', messages: msg })).status, 401);
  for (let c = 0; c < 2; c++) assert.equal((await post('/v1/free/chat', { ticket: s.j.ticket, model: 'anthropic/claude-opus-5.5', messages: msg })).status, 200);
  const over = await post('/v1/free/chat', { ticket: s.j.ticket, model: 'anthropic/claude-opus-5.5', messages: msg });
  assert.equal(over.status, 429); assert.equal(over.j.code, 'TICKET_CALLS');
  proxy.server.close();
});

test('unused tickets reserve a slot (no parallel bypass) and expire; upstream errors do not count', async () => {
  await startProxy({ ticketTtlMs: 300 });
  const a = await post('/v1/free/start', { installId: id(4) });
  const b = await post('/v1/free/start', { installId: id(4) });
  assert.equal(b.status, 200);
  assert.equal((await post('/v1/free/start', { installId: id(4) })).status, 429); // 2 pending reservations
  upstreamFail = true;
  assert.equal((await post('/v1/free/chat', { ticket: a.j.ticket, model: 'anthropic/claude-opus-5.5', messages: msg })).status, 502);
  upstreamFail = false;
  await new Promise(r => setTimeout(r, 400)); // both tickets expire unused
  const st = await fetch(`${base}/v1/free/status?installId=${id(4)}`).then(r => r.json());
  assert.equal(st.remaining, 2);
  proxy.server.close();
});

test('per-IP limit stops new install ids; daily budget pauses everyone; usage survives restart', async () => {
  const file = path.join(tmp, 'persist.json');
  await startProxy({ perIp: 3, dataFile: file });
  const use = async n => { const s = await post('/v1/free/start', { installId: id(n) }); if (s.status !== 200) return s; return post('/v1/free/chat', { ticket: s.j.ticket, model: 'anthropic/claude-opus-5.5', messages: msg }); };
  assert.equal((await use(10)).status, 200); assert.equal((await use(10)).status, 200); assert.equal((await use(11)).status, 200);
  const blocked = await use(12);
  assert.equal(blocked.status, 429);
  proxy.server.close(); await new Promise(r => setTimeout(r, 50));
  await startProxy({ perIp: 100, dataFile: file });
  assert.equal((await use(10)).status, 429); // install 10 still used up after restart
  proxy.server.close();
  await startProxy({ dailyBudgetUsd: 0.015 });
  assert.equal((await use(20)).status, 200); assert.equal((await use(21)).status, 200); // 0.02 spent now
  const paused = await use(22);
  assert.equal(paused.status, 503); assert.equal(paused.j.code, 'FREE_PAUSED');
  proxy.server.close();
});

test('the app uses the proxy for Ask, counts down, then asks for a key; trading never uses it', async () => {
  await startProxy();
  process.env.KAIROS_FREE_PROXY = base;
  const app = new App();
  upstreamFail = true;
  await assert.rejects(app.ask('fails upstream'));
  upstreamFail = false;
  assert.equal((await fetch(`${base}/v1/free/status?installId=${app.config.installId}`).then(r => r.json())).remaining, 2); // released, not lost
  const r1 = await app.ask('How am I doing?');
  assert.ok(r1.steps.length >= 2); // lead + reviewer, both through the proxy
  assert.equal(app.config.freeRemaining, 1);
  await app.ask('again');
  assert.equal(app.config.freeRemaining, 0);
  await assert.rejects(app.ask('third'), e => e instanceof NeedKeyError);
  await assert.rejects(app.decide('Range breakout', { manual: true }), e => e.code === 'NEED_KEY');
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.KAIROS_HOME, 'config.json'), 'utf8'));
  assert.ok(!JSON.stringify(cfg).includes(OPERATOR));
  app.setConfig(updateConfig(app.config, { apiKey: 'sk-or-user' })); // own key bypasses the proxy entirely
  delete process.env.KAIROS_FREE_PROXY;
  proxy.server.close();
});
