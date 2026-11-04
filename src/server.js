// Local server: serves the landing page, the app and a JSON API. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './lib/core.js';
import { updateConfig, publicConfig } from './lib/config.js';
import * as V from './lib/vault.js';
import * as T from './lib/trading.js';
import { getPrice } from './lib/market.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const STATIC = {
  '/': [path.join(ROOT, 'index.html'), 'text/html'],
  '/app': [path.join(here, 'public', 'app.html'), 'text/html'],
  '/app.js': [path.join(here, 'public', 'app.js'), 'text/javascript'],
  '/app.css': [path.join(here, 'public', 'app.css'), 'text/css'],
};

const err = (status, message, code) => Object.assign(new Error(message), { status, code });

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1e6) throw err(413, 'Body too large'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw err(400, 'Invalid JSON'); }
}

export function createServer(app = new App()) {
  const routes = [
    ['GET', /^\/api\/status$/, async () => {
      const journal = V.listJournal(app.vault);
      const rules = app.rules();
      const strategies = app.strategies().map(s => {
        const acc = app.account(s.name), ev = T.evaluate(acc, rules);
        return { name: s.name, status: s.status, draft: !!s.draft, assets: s.assets, trades: acc.trades.length, open: Object.keys(acc.positions).length,
          pnl: ev.metrics.totalPnl, eligible: ev.eligible, paused: acc.paused, promotion: app.state.promotions[s.name]?.status || null };
      });
      return { vault: app.vault, mode: app.config.mode, journal: T.metrics(journal, Number(rules.starting_balance) || 10000), journalCount: journal.length,
        strategies, activity: app.activity.slice(0, 30), config: publicConfig(app.config) };
    }],
    ['GET', /^\/api\/settings$/, async () => publicConfig(app.config)],
    ['PUT', /^\/api\/settings$/, async (_, b) => { app.setConfig(updateConfig(app.config, b)); return publicConfig(app.config); }],
    ['GET', /^\/api\/journal$/, async () => V.listJournal(app.vault)],
    ['POST', /^\/api\/journal$/, async (_, b) => ({ path: V.createJournalTrade(app.vault, b) })],
    ['GET', /^\/api\/note$/, async q => { const n = V.readNote(app.vault, q.get('path')); return { path: n.path, data: n.data, body: n.body }; }],
    ['GET', /^\/api\/notes$/, async q => V.listNotes(app.vault, q.get('dir') || '.')],
    ['GET', /^\/api\/rules$/, async () => app.rules()],
    ['PUT', /^\/api\/rules$/, async (_, b) => {
      const n = V.readNote(app.vault, 'rules.md'); const data = { ...n.data };
      for (const [k, v] of Object.entries(b)) { if (!(k in data)) continue; const x = Number(v); if (!Number.isFinite(x) || x < 0) throw err(400, `${k} must be a non-negative number`); data[k] = x; }
      V.writeNote(app.vault, 'rules.md', data, n.body); app.note('rules.md updated by you'); return data;
    }],
    ['GET', /^\/api\/strategies$/, async () => app.strategies().map(({ body, ...s }) => s)],
    ['POST', /^\/api\/strategies$/, async (_, b) => {
      const name = V.safeName(b.name || '');
      if (!name || name === 'note') throw err(400, 'Give the strategy a name');
      const rel = `Strategies/${name}.md`;
      if (fs.existsSync(V.resolveInVault(app.vault, rel))) throw err(409, 'A strategy with that name exists');
      const assets = String(b.assets || 'BTC-USD').split(',').map(s => s.trim().toUpperCase()).filter(a => /^[A-Z0-9]{2,10}-[A-Z]{3,4}$/.test(a));
      V.writeNote(app.vault, rel, { name, status: 'stopped', assets: assets.length ? assets : ['BTC-USD'], timeframe: '1h',
        risk_per_trade_pct: Math.min(Math.max(Number(b.risk_per_trade_pct) || 1, 0.1), Number(app.rules().max_risk_per_trade_pct) || 2),
        hours_utc: /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(b.hours_utc || '') ? b.hours_utc : '00:00-23:59', interval_min: Math.max(Number(b.interval_min) || 60, 5) },
        `# ${name}\n\n## Rules\n${String(b.rules || '- ').trim()}\n`);
      return { path: rel };
    }],
    ['GET', /^\/api\/strategies\/([^/]+)$/, async (_, __, m) => app.strategyView(m[1])],
    ['POST', /^\/api\/strategies\/([^/]+)\/(start|stop|run|close-all|reset)$/, async (_, __, m) => {
      const [, name, act] = m;
      if (act === 'start') return app.start(name), { ok: true };
      if (act === 'stop') return app.stop(name), { ok: true };
      if (act === 'close-all') return await app.closeAll(name), { ok: true };
      if (act === 'reset') return app.resetAccount(name), { ok: true };
      return app.decide(name, { manual: true });
    }],
    ['POST', /^\/api\/strategies\/([^/]+)\/promotion$/, async (_, b, m) => app.promotion(m[1], b.action)],
    ['POST', /^\/api\/ask$/, async (_, b) => app.ask(b.question)],
    ['POST', /^\/api\/analyse$/, async () => app.analyse()],
    ['GET', /^\/api\/price$/, async q => ({ asset: q.get('asset'), price: await getPrice(q.get('asset')) })],
  ];

  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      // Reject DNS-rebinding: only accept requests addressed to this machine.
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(403, { error: 'Forbidden host' });
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(200, fs.readFileSync(file), type);
      }
      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'Not found' });
      // Cross-site pages cannot set custom headers without a CORS preflight, which we never allow.
      if (req.method !== 'GET' && req.headers['x-agentsia'] !== '1') return send(403, { error: 'Missing X-Agentsia header' });
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (!m || method !== req.method) continue;
        const body = req.method === 'GET' ? {} : await readBody(req);
        const params = m.map((x, i) => (i ? decodeURIComponent(x) : x));
        return send(200, await fn(url.searchParams, body, params));
      }
      send(404, { error: 'Not found' });
    } catch (e) {
      const status = e.status || (e.code === 'ENOENT' ? 404 : /escapes the vault|Invalid path|Invalid asset/.test(e.message) ? 400 : 500);
      if (status >= 500) console.error(e);
      send(status, { error: e.code === 'ENOENT' ? 'Note not found' : e.message, code: e.code });
    }
  });
  return { server, app };
}

export async function start({ port = Number(process.env.PORT) || 4317, tickMs = 60000 } = {}) {
  const { server, app } = createServer();
  await new Promise((ok, ko) => { server.once('error', ko); server.listen(port, '127.0.0.1', ok); });
  let busy = false;
  const timer = setInterval(async () => { if (busy) return; busy = true; try { await app.tick(); } finally { busy = false; } }, tickMs);
  server.on('close', () => clearInterval(timer));
  const addr = server.address();
  console.log(`agentsIA running at http://localhost:${addr.port}/app  ·  vault: ${app.vault}`);
  return { server, app, port: addr.port };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.AGENTSIA_LLM === 'mock') { // development only: fake model answers, no network, no key
    const { setMockLLM } = await import('./lib/llm.js');
    const { getPrice } = await import('./lib/market.js');
    console.log('⚠ AGENTSIA_LLM=mock: model answers are fake (development only)');
    setMockLLM(async ({ task, user }) => {
      const m = user.match(/## ([A-Z]+-[A-Z]+) price ([\d.]+)/); const asset = m?.[1] || 'BTC-USD'; const px = m ? Number(m[2]) : await getPrice(asset);
      if (task === 'propose') return JSON.stringify({ action: 'open', asset, side: 'long', stop: +(px * 0.99).toFixed(2), take_profit: +(px * 1.02).toFixed(2), risk_pct: 1, thesis: 'Mock: breakout above the range.', links: [] });
      if (task === 'review') return '{"agree": true, "reason": "Mock reviewer agrees", "issues": []}';
      if (task === 'chart') return '{"assets": {}}';
      if (task === 'psychology') return '{"patterns": ["Mock pattern"], "rules": ["Mock rule"]}';
      if (task === 'analyse') return JSON.stringify({ summary: 'Mock analysis.', strengths: ['Mock strength'], weaknesses: ['Mock weakness'], strategy: { name: 'Mock strategy', assets: ['BTC-USD'], risk_per_trade_pct: 1, hours_utc: '00:00-23:59', rules: ['Mock rule'] } });
      return 'Mock answer from the **lead**. See [[Anti-tilt rules]].';
    });
  }
  start().catch(e => { console.error(e.message); process.exit(1); });
}
