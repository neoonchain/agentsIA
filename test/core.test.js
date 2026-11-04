import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsia-'));
process.env.AGENTSIA_HOME = path.join(tmp, 'home');
process.env.AGENTSIA_VAULT = path.join(tmp, 'vault');

const { parse, stringify } = await import('../src/lib/frontmatter.js');
const V = await import('../src/lib/vault.js');
const T = await import('../src/lib/trading.js');
const { setMockLLM, parseJSON, NeedKeyError } = await import('../src/lib/llm.js');
const { setMockMarket } = await import('../src/lib/market.js');
const { App } = await import('../src/lib/core.js');
const { createServer } = await import('../src/server.js');
const { updateConfig } = await import('../src/lib/config.js');

const RULES = { starting_balance: 10000, fee_pct: 0.1, slippage_pct: 0, max_drawdown_pct: 8, daily_loss_pct: 3, max_risk_per_trade_pct: 2,
  min_trades: 2, min_days: 0, min_profit_factor: 1.5, min_adherence_pct: 90 };

test('frontmatter round-trips scalars, lists and tricky strings', () => {
  const data = { date: '2026-11-03 14:20', n: 1.5, ok: true, tags: ['a', 'b c'], quote: 'say "hi": now', empty: '', num_str: '007' };
  const back = parse(stringify(data, '## Body\ntext')).data;
  assert.deepEqual(back, { ...data, num_str: '007' });
  assert.equal(parse('---\ntags:\n  - x\n  - y\n---\nbody').data.tags.join(), 'x,y');
  assert.deepEqual(parse('no frontmatter').data, {});
});

test('vault rejects paths outside it', () => {
  const root = path.join(tmp, 'v1'); V.initVault(root);
  assert.throws(() => V.readNote(root, '../secret.md'), /escapes/);
  assert.throws(() => V.writeNote(root, 'Trades/x.txt', {}, ''), /\.md/);
  assert.ok(fs.existsSync(path.join(root, 'rules.md')));
});

test('journal trade is written and parsed back with R computed', () => {
  const root = path.join(tmp, 'v2'); V.initVault(root);
  const rel = V.createJournalTrade(root, { date: '2026-11-01T21:05', asset: 'eth-usd', side: 'short', entry: 3410, stop: 3460, exit: 3460, size: 4, pnl: -200, tags: '#tilt, off-plan', thesis: 'It has to turn', wentWrong: '- traded after 2 losses' });
  const [t] = V.listJournal(root);
  assert.equal(t.path, rel);
  assert.equal(t.asset, 'ETH-USD');
  assert.equal(t.r, -1);
  assert.deepEqual(t.tags, ['tilt', 'off-plan']);
  assert.equal(t.thesis, 'It has to turn');
  assert.match(t.wentWrong, /2 losses/);
});

test('metrics: profit factor and drawdown', () => {
  const m = T.metrics([{ pnl: 200, r: 2 }, { pnl: -100, r: -1 }, { pnl: -100, r: -1 }, { pnl: 300, r: 3 }], 1000);
  assert.equal(m.count, 4); assert.equal(m.profitFactor, 2.5); assert.equal(m.winRate, 50);
  assert.equal(m.maxDrawdownPct, 16.67); assert.equal(m.totalPnl, 300);
});

test('paper broker sizes by risk, charges fees and closes at stop', () => {
  const acc = T.newAccount(RULES);
  const p = T.openPosition(acc, { asset: 'BTC-USD', side: 'long', price: 100, stop: 90, takeProfit: 120, riskPct: 1, rules: RULES });
  assert.equal(+p.qty.toFixed(4), 10); // 100 USD risk / 10 distance
  const [t] = T.checkExits(acc, { 'BTC-USD': 89 }, RULES);
  assert.equal(t.reason, 'stop');
  assert.ok(t.pnl < -100 && t.pnl > -103, `pnl ${t.pnl}`); // -100 plus fees
  assert.equal(Object.keys(acc.positions).length, 0);
  const s = T.openPosition(acc, { asset: 'ETH-USD', side: 'short', price: 50, stop: 55, takeProfit: 40, riskPct: 1, rules: RULES });
  const [t2] = T.checkExits(acc, { 'ETH-USD': 39 }, RULES);
  assert.equal(t2.reason, 'take profit'); assert.ok(t2.pnl > 0); assert.ok(s.qty > 0);
});

test('paper broker never uses leverage', () => {
  const acc = T.newAccount(RULES);
  const p = T.openPosition(acc, { asset: 'BTC-USD', side: 'long', price: 100, stop: 99.99, riskPct: 2, rules: RULES });
  assert.ok(p.qty * p.entry <= 10000 + 1e-6);
});

test('Brake blocks off-strategy, wrong stops, too much risk and missing agreement', () => {
  const acc = T.newAccount(RULES);
  const strategy = { assets: ['BTC-USD'], hours_utc: '00:00-23:59', risk_per_trade_pct: 1 };
  const ok = { action: 'open', asset: 'BTC-USD', side: 'long', stop: 90, take_profit: 120, risk_pct: 1 };
  const ctx = { strategy, rules: RULES, acc, price: 100, mode: 'team', reviewerAgreed: true };
  assert.equal(T.brake(ok, ctx).ok, true);
  assert.equal(T.brake({ ...ok, asset: 'DOGE-USD' }, ctx).offStrategy, true);
  assert.equal(T.brake({ ...ok, stop: 110 }, ctx).ok, false);
  assert.equal(T.brake({ ...ok, risk_pct: 1.5 }, ctx).ok, false);
  assert.equal(T.brake({ ...ok, take_profit: 95 }, ctx).ok, false);
  const nr = T.brake(ok, { ...ctx, reviewerAgreed: false });
  assert.equal(nr.ok, false); assert.equal(nr.offStrategy, false);
  assert.equal(T.brake(ok, { ...ctx, mode: 'solo', reviewerAgreed: undefined }).ok, true);
  assert.equal(T.brake(ok, { ...ctx, strategy: { ...strategy, hours_utc: '01:00-02:00' }, now: new Date('2026-01-01T05:00:00Z') }).ok, false);
});

test('daily loss pauses and closes; max drawdown stops', () => {
  const acc = T.newAccount(RULES);
  const now = new Date('2026-11-04T10:00:00Z');
  T.riskTick(acc, {}, RULES, now);
  T.openPosition(acc, { asset: 'BTC-USD', side: 'long', price: 100, stop: 99, riskPct: 2, rules: RULES, now }); // capped at 100 units
  const ev = T.riskTick(acc, { 'BTC-USD': 96.5 }, RULES, now); // ~ -3.6%
  assert.ok(ev.some(e => e.type === 'paused')); assert.ok(acc.paused);
  assert.equal(Object.keys(acc.positions).length, 0);
  const ev2 = T.riskTick(acc, {}, RULES, new Date('2026-11-05T00:01:00Z'));
  assert.ok(ev2.some(e => e.type === 'resumed')); assert.equal(acc.paused, null);
  acc.balance = acc.peakEquity * 0.9;
  assert.ok(T.riskTick(acc, {}, RULES, new Date('2026-11-05T01:00:00Z')).some(e => e.type === 'stop'));
});

test('evaluator requires every mark', () => {
  const acc = T.newAccount(RULES);
  acc.trades = [{ pnl: 300, r: 3 }, { pnl: -100, r: -1 }];
  acc.proposals = { total: 2, offStrategy: 0 };
  assert.equal(T.evaluate(acc, RULES).eligible, true);
  acc.proposals.offStrategy = 1;
  assert.equal(T.evaluate(acc, RULES).eligible, false);
});

test('parseJSON handles fences, prose and braces inside strings', () => {
  assert.deepEqual(parseJSON('Sure!\n```json\n{"a": "x } y", "b": {"c": 1}}\n```'), { a: 'x } y', b: { c: 1 } });
  assert.throws(() => parseJSON('no json here'));
});

/* ---------- full app with mocked models and prices ---------- */
function freshApp(name) {
  process.env.AGENTSIA_VAULT = path.join(tmp, name);
  process.env.AGENTSIA_HOME = path.join(tmp, name + '-home');
  const app = new App();
  const n = V.readNote(app.vault, 'Strategies/Range breakout.md');
  V.writeNote(app.vault, 'Strategies/Range breakout.md', { ...n.data, hours_utc: '00:00-23:59' }, n.body);
  return app;
}
const calls = [];
function mock({ propose = { action: 'open', asset: 'BTC-USD', side: 'long', stop: 95, take_profit: 110, risk_pct: 1, thesis: 'breakout', links: ['2026-11-03 BTC long'] }, agree = true } = {}) {
  calls.length = 0;
  setMockLLM(({ task, role, modelId }) => {
    calls.push({ task, role, modelId });
    if (task === 'propose') return JSON.stringify(propose);
    if (task === 'review') return `Here you go: {"agree": ${agree}, "reason": "checked", "issues": ${agree ? '[]' : '["thesis rests on one candle"]'}}`;
    if (task === 'chart') return '{"assets": {"BTC-USD": {"trend": "up", "support": 95, "resistance": 105, "setup": "breakout"}}}';
    if (task === 'analyse') return JSON.stringify({ summary: 'You win on breakouts.', strengths: ['patience'], weaknesses: ['tilt'], psychology: { patterns: ['revenge'], rules: ['stop after 2 losses'] }, strategy: { name: 'Euro breakout', assets: ['BTC-USD', 'bad'], risk_per_trade_pct: 9, hours_utc: '07:00-17:00', rules: ['wait for close'] } });
    if (task === 'psychology') return '{"patterns": ["revenge trades"], "rules": ["2 losses = done"]}';
    if (task === 'revise') return 'Revised answer';
    if (task === 'scribe') return 'Clean scribe thesis.';
    return 'Draft answer';
  });
}
setMockMarket({ prices: { 'BTC-USD': 100, 'ETH-USD': 50 }, candles: [{ t: Date.now(), open: 99, high: 101, low: 98, close: 100, volume: 10 }] });

test('team ask: reviewer disagreement triggers a revision; solo uses one model', async () => {
  const app = freshApp('ask'); app.setConfig(updateConfig(app.config, { apiKey: 'k' }));
  mock({ agree: false });
  const r = await app.ask('What do I do wrong?');
  assert.equal(r.answer, 'Revised answer');
  assert.deepEqual(calls.map(c => c.role), ['lead', 'reviewer', 'lead']);
  assert.ok(calls[1].modelId.startsWith('openai/'));
  app.setConfig(updateConfig(app.config, { mode: 'solo', soloModel: 'grok' }));
  mock({ agree: false });
  const s = await app.ask('Solo?');
  assert.equal(s.answer, 'Draft answer'); assert.equal(calls.length, 1); assert.equal(calls[0].modelId, '~x-ai/grok-latest');
});

test('analyse writes an insight and a clamped draft strategy that cannot start', async () => {
  const app = freshApp('analyse'); app.setConfig(updateConfig(app.config, { apiKey: 'k' })); mock();
  const r = await app.analyse();
  assert.ok(fs.existsSync(path.join(app.vault, r.insight)));
  const s = V.readNote(app.vault, r.strategy).data;
  assert.deepEqual(s.assets, ['BTC-USD']); assert.equal(s.risk_per_trade_pct, 2); assert.equal(s.draft, true);
  assert.deepEqual([...new Set(calls.map(c => c.role))], ['lead', 'psychology', 'reviewer']);
  assert.throws(() => app.start(s.name), /draft/);
});

test('team decision: opens a paper trade with a note when the reviewer agrees', async () => {
  const app = freshApp('team'); app.setConfig(updateConfig(app.config, { apiKey: 'k' })); mock();
  app.start('Range breakout');
  const r = await app.decide('Range breakout');
  assert.equal(r.verdict.ok, true, r.verdict.reasons.join());
  assert.deepEqual(calls.map(c => c.role), ['charts', 'lead', 'reviewer', 'scribe']);
  const pos = app.account('Range breakout').positions['BTC-USD'];
  assert.ok(pos);
  const note = V.readNote(app.vault, pos.notePath);
  assert.equal(note.data.status, 'open'); assert.match(note.body, /\[\[2026-11-03 BTC long\]\]/);
  assert.match(note.body, /Clean scribe thesis/);
  // price hits the stop on the next tick → closed, note updated
  setMockMarket({ prices: { 'BTC-USD': 94, 'ETH-USD': 50 }, candles: [] });
  app.account('Range breakout').lastDecisionAt = new Date().toISOString();
  await app.tick();
  const closed = V.readNote(app.vault, pos.notePath).data;
  assert.equal(closed.status, 'closed'); assert.ok(closed.pnl < 0);
  setMockMarket({ prices: { 'BTC-USD': 100, 'ETH-USD': 50 }, candles: [] });
});

test('team decision: no agreement, no order; solo skips the reviewer', async () => {
  const app = freshApp('disagree'); app.setConfig(updateConfig(app.config, { apiKey: 'k' })); mock({ agree: false });
  const r = await app.decide('Range breakout', { manual: true });
  assert.equal(r.verdict.ok, false);
  assert.equal(Object.keys(app.account('Range breakout').positions).length, 0);
  assert.equal(app.account('Range breakout').proposals.offStrategy, 0);
  app.setConfig(updateConfig(app.config, { mode: 'solo' })); mock({ agree: false });
  const s = await app.decide('Range breakout', { manual: true });
  assert.equal(s.verdict.ok, true); assert.deepEqual(calls.map(c => c.role), ['lead']);
});

test('off-strategy proposals count against adherence; garbage proposals hold', async () => {
  const app = freshApp('off'); app.setConfig(updateConfig(app.config, { apiKey: 'k' }));
  mock({ propose: { action: 'open', asset: 'DOGE-USD', side: 'long', stop: 1, risk_pct: 1 } });
  const r = await app.decide('Range breakout', { manual: true });
  assert.equal(r.verdict.ok, false);
  assert.equal(app.account('Range breakout').proposals.offStrategy, 1);
  setMockLLM(() => 'I think we should buy!');
  const g = await app.decide('Range breakout', { manual: true });
  assert.equal(g.action, 'hold');
});

test('stops are still watched on a stopped strategy; bad vault path is rolled back', async () => {
  const app = freshApp('watch'); app.setConfig(updateConfig(app.config, { apiKey: 'k' })); mock();
  await app.decide('Range breakout', { manual: true }); // strategy is stopped, manual decision opens a position
  assert.ok(app.account('Range breakout').positions['BTC-USD']);
  setMockMarket({ prices: { 'BTC-USD': 90, 'ETH-USD': 50 }, candles: [] });
  await app.tick();
  assert.equal(Object.keys(app.account('Range breakout').positions).length, 0);
  assert.equal(calls.filter(c => c.task === 'propose').length, 1); // no new decision for a stopped strategy
  setMockMarket({ prices: { 'BTC-USD': 100, 'ETH-USD': 50 }, candles: [] });
  const before = app.vault;
  fs.writeFileSync(path.join(tmp, 'afile'), 'x');
  assert.throws(() => app.setConfig(updateConfig(app.config, { vaultPath: path.join(tmp, 'afile', 'sub') })), /Cannot use/);
  assert.equal(app.vault, before);
});

test('promotion: request only when eligible, then approve', async () => {
  const app = freshApp('promo');
  assert.throws(() => app.promotion('Range breakout', 'request'), /not beaten/);
  const n = V.readNote(app.vault, 'rules.md');
  V.writeNote(app.vault, 'rules.md', { ...n.data, min_trades: 2, min_days: 0 }, n.body);
  const acc = app.account('Range breakout');
  acc.trades = [{ pnl: 300, r: 3 }, { pnl: -100, r: -1 }]; acc.proposals = { total: 2, offStrategy: 0 };
  assert.throws(() => app.promotion('Range breakout', 'approve'), /Nothing/);
  assert.equal(app.promotion('Range breakout', 'request').status, 'requested');
  assert.equal(app.promotion('Range breakout', 'approve').status, 'approved');
});

test('HTTP API: host check, header check, journal round trip, errors', async () => {
  process.env.AGENTSIA_VAULT = path.join(tmp, 'http'); process.env.AGENTSIA_HOME = path.join(tmp, 'http-home');
  const { server } = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'Content-Type': 'application/json', 'X-Agentsia': '1' };
  try {
    assert.equal((await fetch(base + '/api/status')).status, 200);
    assert.equal((await fetch(base + '/app')).status, 200);
    assert.equal((await fetch(base + '/')).status, 200);
    assert.equal((await fetch(base + '/api/journal', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })).status, 403);
    const http = await import('node:http');
    const badStatus = await new Promise((ok, ko) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/status', headers: { Host: 'evil.example' } }, r => { r.resume(); ok(r.statusCode); }).on('error', ko));
    assert.equal(badStatus, 403);
    const c = await fetch(base + '/api/journal', { method: 'POST', headers: H, body: JSON.stringify({ asset: 'BTC-USD', side: 'long', entry: 1, stop: 0.5, exit: 2, size: 1 }) });
    assert.equal(c.status, 200);
    const list = await (await fetch(base + '/api/journal')).json();
    assert.equal(list.length, 1); assert.equal(list[0].pnl, 1);
    assert.equal((await fetch(base + '/api/note?path=' + encodeURIComponent('../../etc/passwd'))).status, 400);
    assert.equal((await fetch(base + '/api/note?path=Trades/nope.md')).status, 404);
    const st = await fetch(base + '/api/strategies/Range%20breakout/start', { method: 'POST', headers: H });
    assert.equal(st.status, 402);
    const rules = await fetch(base + '/api/rules', { method: 'PUT', headers: H, body: JSON.stringify({ min_trades: -1 }) });
    assert.equal(rules.status, 400);
    const s = await (await fetch(base + '/api/settings', { method: 'PUT', headers: H, body: JSON.stringify({ apiKey: 'sk-or-secret-1234', mode: 'solo' }) })).json();
    assert.equal(s.apiKey, undefined); assert.equal(s.apiKeyHint, '…1234'); assert.equal(s.mode, 'solo');
    const mk = await fetch(base + '/api/strategies', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Test strat', assets: 'btc-usd, nope' }) });
    assert.equal(mk.status, 200);
    const view = await (await fetch(base + '/api/strategies/Test%20strat')).json();
    assert.deepEqual(view.assets, ['BTC-USD']);
  } finally { server.close(); }
});
