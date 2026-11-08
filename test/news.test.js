process.env.KAIROS_EXAMPLES = '0'; // tests start from an empty journal
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-news-'));
process.env.KAIROS_HOME = path.join(tmp, 'home');
process.env.KAIROS_VAULT = path.join(tmp, 'vault');

const { coinsIn, detectShock, NewsHub } = await import('../src/lib/news.js');
const { App } = await import('../src/lib/core.js');
const { updateConfig } = await import('../src/lib/config.js');
const { setMockLLM } = await import('../src/lib/llm.js');
const { setMockMarket } = await import('../src/lib/market.js');
const { createServer } = await import('../src/server.js');

// 60 quiet one-minute candles, then an optional last-3-minute move
function candles(start, movePct = 0, volMult = 1) {
  const out = []; let p = start;
  for (let i = 0; i < 61; i++) {
    const last3 = i >= 58, step = last3 ? movePct / 300 : (i % 2 ? 0.0004 : -0.0004);
    const open = p; p = p * (1 + step);
    out.push({ t: Date.now() - (61 - i) * 60000, open, high: Math.max(open, p), low: Math.min(open, p), close: p, volume: last3 ? 100 * volMult : 100 });
  }
  return out;
}

test('coins are recognised from headlines without false matches', () => {
  assert.deepEqual(coinsIn('Elon Musk tweets about Dogecoin again').sort(), ['DOGE']);
  assert.deepEqual(coinsIn('$BTC and Ethereum ETFs see record inflows').sort(), ['BTC', 'ETH']);
  assert.deepEqual(coinsIn('A solid quarter for Solana validators').sort(), ['SOL']);
  assert.deepEqual(coinsIn('Pepe and dogwifhat lead memecoins', ['BONK']).sort(), ['BONK', 'PEPE', 'WIF']);
  assert.deepEqual(coinsIn('Fed holds rates steady'), []);
  assert.deepEqual(coinsIn('j7: new $PEPE tweet'), ['PEPE']);
  assert.deepEqual(coinsIn('Trump speaks on tariffs'), []);
  assert.deepEqual(coinsIn('$TRUMP jumps 20%'), ['TRUMP']);
});

test('shock detector: big fast move on volume fires, memecoins need more, noise does not', () => {
  assert.equal(detectShock('BTC-USD', candles(80000, 0)).shock, false);
  const up = detectShock('BTC-USD', candles(80000, 2, 4));
  assert.equal(up.shock, true); assert.equal(up.dir, 'up'); assert.ok(up.volX >= 3);
  assert.equal(detectShock('DOGE-USD', candles(0.16, 2, 1)).shock, false); // 2% is normal for a memecoin
  assert.equal(detectShock('DOGE-USD', candles(0.16, -5, 4)).shock, true);
  assert.equal(detectShock('BTC-USD', candles(80000, 2).slice(0, 10)), null); // not enough data
  // staircase crash: -4% spread over 15 minutes on heavy volume, never 3% in any 3 minutes (Oct 8 2026, DOGE)
  const stairs = candles(0.087, 0).slice(0, 46);
  for (let i = 0; i < 15; i++) { const p = stairs.at(-1).close, q = p * (i % 3 === 2 ? 0.9995 : 0.9965); stairs.push({ t: stairs.at(-1).t + 60000, open: p, high: p, low: q, close: q, volume: 600 }); }
  const s = detectShock('DOGE-USD', stairs);
  assert.equal(s.shock, true); assert.equal(s.mins, 15); assert.equal(s.dir, 'down');
});

test('hub de-duplicates and filters by asset and age', () => {
  const h = new NewsHub();
  assert.equal(h.ingest([{ id: 'a', time: Date.now(), title: 'Bitcoin breaks out' }, { id: 'a', time: Date.now(), title: 'dup' }]).length, 1);
  h.ingest([{ id: 'b', time: Date.now() - 10 * 3600000, title: 'Old bitcoin news' }, { id: 'c', time: Date.now(), title: 'Pepe pumps' }]);
  assert.deepEqual(h.relevant(['BTC-USD']).map(x => x.id), ['a']);
  assert.deepEqual(h.relevant(['PEPE-USD']).map(x => x.id), ['c']);
});

function freshApp(name) {
  process.env.KAIROS_VAULT = path.join(tmp, name); process.env.KAIROS_HOME = path.join(tmp, name + '-home');
  const app = new App();
  app.setConfig(updateConfig({ ...app.config, news: { ...app.config.news, tree: false, rss: false, x: false, relay: false, watch: ['BTC-USD'] } }, { apiKey: 'k' }));
  return app;
}
const prompts = [];
setMockLLM(({ task, user }) => {
  prompts.push({ task, user });
  if (task === 'propose') return JSON.stringify({ action: 'open', asset: user.includes('DOGE-USD price') ? 'DOGE-USD' : 'BTC-USD', side: 'long', stop: user.includes('DOGE-USD price') ? 0.15 : 78000, take_profit: user.includes('DOGE-USD price') ? 0.2 : 84000, risk_pct: 0.5, thesis: 't' });
  if (task === 'review') return '{"agree": true, "reason": "ok"}';
  return '{}';
});

test('a shock triggers an immediate decision, the guard blocks chasing, allow-strategies may trade', async () => {
  const app = freshApp('shock');
  const V = await import('../src/lib/vault.js');
  for (const p of ['Strategies/Range breakout.md', 'Strategies/Memecoin momentum.md']) { const n = V.readNote(app.vault, p); V.writeNote(app.vault, p, { ...n.data, hours_utc: '00:00-23:59' }, n.body); }
  app.start('Range breakout'); app.start('Memecoin momentum');
  setMockMarket({ prices: { 'BTC-USD': 81000, 'ETH-USD': 2400, 'SOL-USD': 150, 'DOGE-USD': 0.168, 'PEPE-USD': 0.000005, 'WIF-USD': 0.5, 'BONK-USD': 0.00002, 'SHIB-USD': 0.00001 }, candles: [],
    candles1m: { 'BTC-USD': candles(80000, 2.2, 4), 'DOGE-USD': candles(0.16, 6, 5) } });
  app.addNews({ title: 'BREAKING: Spot bitcoin ETF approvals expanded', source: 'test' });
  const r = await app.newsTick();
  assert.deepEqual(r.shocks.map(s => s.asset).sort(), ['BTC-USD', 'DOGE-USD']);
  const byName = Object.fromEntries(r.decisions.map(d => [d.name, d]));
  assert.match(byName['Range breakout'].verdict.reasons.join(), /Shock guard/);
  assert.equal(byName['Memecoin momentum'].verdict.ok, true, byName['Memecoin momentum'].verdict.reasons.join()); // on_shock: allow
  const p = prompts.filter(x => x.task === 'propose').find(x => x.user.includes('BTC-USD price'));
  assert.match(p.user, /Latest news about these assets/); assert.match(p.user, /Spot bitcoin ETF/); assert.match(p.user, /Price shocks in the last 3h: BTC-USD \+/);
  const again = await app.newsTick(); // same move: no duplicate alert
  assert.equal(again.shocks.length, 0);
});

test('inbound webhook needs its token and feeds the hub', async () => {
  process.env.KAIROS_VAULT = path.join(tmp, 'hook'); process.env.KAIROS_HOME = path.join(tmp, 'hook-home');
  const { server, app } = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port, token = app.config.news.webhookToken;
  const post = (headers, body) => new Promise((ok, ko) => { const rq = http.request({ host: '127.0.0.1', port, path: '/api/news/webhook', method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'abc.trycloudflare.com', ...headers } }, rs => { let d = ''; rs.on('data', c => (d += c)); rs.on('end', () => ok({ status: rs.statusCode, body: d })); }); rq.on('error', ko); rq.end(JSON.stringify(body)); });
  try {
    assert.equal((await post({}, { title: 'x' })).status, 401);
    assert.equal((await post({ 'X-Kairos-Token': 'wrong' }, { title: 'x' })).status, 401);
    const ok = await post({ 'X-Kairos-Token': token }, [{ title: 'j7: new $PEPE tweet from a big account', source: 'j7tracker' }, { text: 'DOGE listed on a new exchange' }]);
    assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).added, 2);
    assert.equal((await post({ 'X-Agentsia-Token': token }, { title: 'legacy header from an old forwarder' })).status, 200); // pre-rename forwarders keep working
    const feed = await (await fetch(`http://127.0.0.1:${port}/api/news`)).json();
    assert.ok(feed.items.some(i => i.source === 'j7tracker' && i.coins.includes('PEPE')));
    const settings = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
    assert.equal(settings.news.webhookToken, undefined); // never exposed in general settings
  } finally { server.close(); }
});

test('an empty vault gets the paper-test examples once; removing them is permanent', async () => {
  const V = await import('../src/lib/vault.js');
  process.env.KAIROS_VAULT = path.join(tmp, 'examples'); process.env.KAIROS_HOME = path.join(tmp, 'examples-home');
  process.env.KAIROS_EXAMPLES = '1';
  try {
    const app = new App();
    const j = V.listJournal(app.vault);
    assert.equal(j.length, 233); assert.ok(j.every(t => t.tags.includes('example'))); // the three paper tracks: 80 Dip buyer + 129 Trend rider + 24 Pullback
    assert.equal(j.filter(t => t.strategy === 'Dip buyer').length, 80); assert.equal(j.filter(t => t.strategy === 'Trend rider').length, 129);
    assert.ok(j.every(t => t.entry > 0 && t.exit > 0 && t.stop > 0), 'prices are numbers in the notes'); // BTC and ETH too
    assert.equal(app.state.examplesVersion, 5); assert.ok(app.state.track.lastT > 0 && app.state.trend.lastT > 0 && app.state.pullback.lastT > 0);
    assert.equal(app.state.decisions['Dip buyer'].length, 30); assert.equal(app.state.decisions['Trend rider'].length, 30);
    const ex = app.state.decisions['Range breakout'];
    assert.equal(ex.length, 10); assert.ok(ex.every(d => d.example)); assert.equal(ex.at(-1).outcome, 'opened'); // paper test 4, newest first
    assert.equal(await app.chartsReady, 233); // every example gets its chart in Attachments/
    const withCharts = V.listJournal(app.vault).filter(t => t.image);
    assert.equal(withCharts.length, 233);
    assert.ok(withCharts.every(t => /^Attachments\/.+\.webp$/.test(t.image)), JSON.stringify(withCharts.map(t => t.image)));
    assert.ok(V.readImage(app.vault, withCharts[0].image));
    const { removeExamples } = await import('../src/lib/examples.js');
    assert.equal(removeExamples(app.vault), 233); app.state.examples = 'removed'; app.save();
    assert.equal(V.listJournal(new App().vault).length, 0); // reopening does not seed again
  } finally { process.env.KAIROS_EXAMPLES = '0'; }
});

test('Memecoin momentum v2: never buys into a crash, one position, unedited v1 is upgraded', async () => {
  const V = await import('../src/lib/vault.js');
  const app = freshApp('meme-v2');
  const n = V.readNote(app.vault, 'Strategies/Memecoin momentum.md');
  assert.equal(n.data.version, 2); assert.equal(n.data.max_positions, 1); assert.equal(n.data.trend_filter, true);
  assert.ok(app.lessons('Memecoin momentum').length >= 2);
  app.start('Memecoin momentum');
  setMockMarket({ prices: { 'BTC-USD': 81000, 'ETH-USD': 2400, 'SOL-USD': 150, 'DOGE-USD': 0.168, 'PEPE-USD': 0.000005, 'WIF-USD': 0.5, 'BONK-USD': 0.00002, 'SHIB-USD': 0.00001 }, candles: [] });
  app.shockUntil['DOGE-USD'] = { until: Date.now() + 15 * 60000, movePct: -6, mins: 15 };
  const down = await app.decide('Memecoin momentum', { manual: true });
  assert.equal(down.verdict.ok, false); assert.match(down.verdict.reasons.join(), /Shock guard/);
  app.shockUntil['DOGE-USD'] = { until: Date.now() + 15 * 60000, movePct: 6, mins: 3 };
  const up = await app.decide('Memecoin momentum', { manual: true });
  assert.equal(up.verdict.ok, true, up.verdict.reasons.join());
  // an untouched v1 note is upgraded and keeps its status
  const dir = path.join(tmp, 'meme-v1'); V.initVault(dir);
  const f = path.join(dir, 'Strategies/Memecoin momentum.md');
  fs.writeFileSync(f, '---\nname: Memecoin momentum\nstatus: running\non_shock: allow\n---\n\n## Rules\n- Enter only with a catalyst: a fresh headline or tweet about the coin (news feed) AND a price shock.\n- Never more than one memecoin position at a time.\n');
  V.initVault(dir);
  const m = V.readNote(dir, 'Strategies/Memecoin momentum.md');
  assert.equal(m.data.version, 2); assert.equal(m.data.status, 'running');
});

test('Argus alerts: price alerts fire once, forwarded alerts arrive through the relay', async () => {
  const relay = http.createServer((req, res) => {
    assert.match(req.url, /^\/kairos-[a-f0-9]+\/json\?poll=1&since=/);
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.end(['{"id":"a1","time":1790000000,"event":"open"}', '{"id":"m1","time":1790000000,"event":"message","title":"j7tracker","message":"$PEPE big account just tweeted","tags":["j7"]}', ''].join('\n'));
  });
  await new Promise(r => relay.listen(0, '127.0.0.1', r));
  process.env.KAIROS_RELAY = `http://127.0.0.1:${relay.address().port}`;
  try {
    const app = freshApp('alerts');
    app.setConfig({ ...app.config, news: { ...app.config.news, relay: true, alerts: [{ id: 'x1', asset: 'BTC-USD', op: 'above', price: 80000 }, { id: 'x2', asset: 'BTC-USD', op: 'below', price: 70000 }] } });
    setMockMarket({ prices: { 'BTC-USD': 81000 }, candles: [] });
    await app.newsTick();
    assert.ok(app.news.items.some(i => i.source === 'Forwarded · j7' && i.coins.includes('PEPE')), 'relay item ingested');
    assert.equal(app.firedAlerts.length, 1); assert.equal(app.firedAlerts[0].id, 'x1');
    assert.ok(app.config.news.alerts.find(a => a.id === 'x1').firedAt); assert.ok(!app.config.news.alerts.find(a => a.id === 'x2').firedAt);
    app.newsAt = {}; await app.newsTick();
    assert.equal(app.firedAlerts.length, 1); // fires once, until re-armed
  } finally { delete process.env.KAIROS_RELAY; relay.close(); }
});
