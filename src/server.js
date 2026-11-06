// Local server: serves the landing page, the app and a JSON API. Binds to 127.0.0.1 only.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from './lib/core.js';
import { createApi, err } from './lib/routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const STATIC = {
  '/': [path.join(ROOT, 'index.html'), 'text/html'],
  '/tour': [path.join(ROOT, 'tour.html'), 'text/html'],
  '/app': [path.join(here, 'public', 'app.html'), 'text/html'],
  '/app/': [path.join(here, 'public', 'app.html'), 'text/html'],
  '/app.js': [path.join(here, 'public', 'app.js'), 'text/javascript'],
  '/app.css': [path.join(here, 'public', 'app.css'), 'text/css'],
};

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 12e6) throw err(413, 'Body too large'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw err(400, 'Invalid JSON'); }
}

export function createServer(app = new App()) {
  const handle = createApi(app);
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      // Inbound news webhook: may come through a tunnel (any Host), so it is authorised by its own token instead.
      if (req.method === 'POST' && req.url.split('?')[0] === '/api/news/webhook') {
        const given = String(req.headers['x-kairos-token'] || req.headers['x-agentsia-token'] || new URL(req.url, 'http://x').searchParams.get('token') || '');
        const want = app.config.news.webhookToken;
        const ok = given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
        if (!ok) return send(401, { error: 'Bad or missing token' });
        const body = await readBody(req);
        const items = Array.isArray(body) ? body.slice(0, 20) : [body];
        const added = items.map(it => app.addNews(it, 'webhook')).filter(Boolean);
        return send(200, { ok: true, added: added.length });
      }
      // Reject DNS-rebinding: only accept requests addressed to this machine.
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(403, { error: 'Forbidden host' });
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && /^\/assets\/[\w.-]+\.(webp|png|jpg|svg)$/.test(url.pathname)) {
        const f = path.join(ROOT, 'assets', path.basename(url.pathname));
        const type = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml' }[url.pathname.split('.').pop()];
        if (fs.existsSync(f)) return send(200, fs.readFileSync(f), type);
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(200, fs.readFileSync(file), type);
      }
      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'Not found' });
      // Cross-site pages cannot set custom headers without a CORS preflight, which we never allow.
      if (req.method !== 'GET' && req.headers['x-kairos'] !== '1') return send(403, { error: 'Missing X-Kairos header' });
      const body = req.method === 'GET' ? {} : await readBody(req);
      const r = await handle(req.method, url.pathname, url.searchParams, body);
      send(r.status, r.body);
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
  let newsBusy = false;
  const newsTimer = setInterval(async () => { if (newsBusy) return; newsBusy = true; try { await app.newsTick(); } catch (e) { console.error('news', e.message); } finally { newsBusy = false; } }, 30000);
  setTimeout(() => app.newsTick().catch(() => {}), 1500);
  server.on('close', () => { clearInterval(timer); clearInterval(newsTimer); });
  const addr = server.address();
  console.log(`Kairos running at http://localhost:${addr.port}/app  ·  vault: ${app.vault}`);
  return { server, app, port: addr.port };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.KAIROS_LLM === 'mock') { // development only: fake model answers, no network, no key
    const { setMockLLM } = await import('./lib/llm.js');
    const { getPrice } = await import('./lib/market.js');
    console.log('⚠ KAIROS_LLM=mock: model answers are fake (development only)');
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
