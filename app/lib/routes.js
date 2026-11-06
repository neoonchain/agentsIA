// The JSON API, shared by the local server and the in-browser web app.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { updateConfig, publicConfig } from './config.js';
import * as V from './vault.js';
import * as T from './trading.js';
import { getPrice } from './market.js';
import { removeExamples } from './examples.js';

export const err = (status, message, code) => Object.assign(new Error(message), { status, code });

export function createApi(app) {
  const routes = [
    ['GET', /^\/api\/status$/, async () => {
      const journal = V.listJournal(app.vault);
      const rules = app.rules();
      const strategies = app.strategies().map(s => {
        const acc = app.account(s.name), ev = T.evaluate(acc, rules);
        const lv = app.liveOf(s.name);
        return { name: s.name, status: s.status, draft: !!s.draft, live: lv ? lv.mode : null, assets: s.assets, trades: acc.trades.length, open: Object.keys(acc.positions).length,
          pnl: ev.metrics.totalPnl, eligible: ev.eligible, paused: acc.paused, promotion: app.state.promotions[s.name]?.status || null };
      });
      return { vault: app.vault, mode: app.config.mode, journal: T.metrics(journal, Number(rules.starting_balance) || 10000), journalCount: journal.length, examples: journal.filter(t => t.tags.includes('example')).length, recent: journal.slice(-4).reverse(),
        strategies, activity: app.activity.slice(0, 30), config: publicConfig(app.config) };
    }],
    ['GET', /^\/api\/settings$/, async () => publicConfig(app.config)],
    ['PUT', /^\/api\/settings$/, async (_, b) => { app.setConfig(updateConfig(app.config, b)); return publicConfig(app.config); }],
    ['GET', /^\/api\/journal$/, async () => V.listJournal(app.vault)],
    ['POST', /^\/api\/journal$/, async (_, b) => ({ path: V.createJournalTrade(app.vault, b) })],
    ['POST', /^\/api\/examples\/remove$/, async () => { const removed = removeExamples(app.vault); app.state.examples = 'removed'; app.save(); return { removed }; }],
    ['GET', /^\/api\/note$/, async q => { const n = V.readNote(app.vault, q.get('path')); return { path: n.path, data: n.data, body: n.body }; }],
    ['GET', /^\/api\/news$/, async () => ({ items: app.news.items.slice(0, 120), shocks: app.news.shocks.slice(0, 30), status: app.news.status, watch: app.watchedAssets(),
      guards: Object.fromEntries(Object.entries(app.shockUntil).filter(([, g]) => g.until > Date.now())) })],
    ['GET', /^\/api\/news\/settings$/, async () => ({ ...app.config.news, hasXBearer: !!app.config.xBearer })],
    ['PUT', /^\/api\/news\/settings$/, async (_, b) => {
      const n = { ...app.config.news };
      for (const k of ['tree', 'rss', 'x']) if (typeof b[k] === 'boolean') n[k] = b[k];
      if (typeof b.xQuery === 'string' && b.xQuery.trim()) n.xQuery = b.xQuery.trim().slice(0, 512);
      if (Array.isArray(b.watch)) n.watch = [...new Set(b.watch.map(a => String(a).trim().toUpperCase()).filter(a => /^[A-Z0-9]{2,10}-[A-Z]{3,4}$/.test(a)))].slice(0, 20);
      if (b.rotateToken) n.webhookToken = crypto.randomUUID().replace(/-/g, '');
      const c = { ...app.config, news: n };
      if (typeof b.xBearer === 'string') c.xBearer = b.xBearer.trim();
      app.setConfig(c);
      return { ...app.config.news, hasXBearer: !!app.config.xBearer };
    }],
    ['POST', /^\/api\/news\/test$/, async () => app.addNews({ title: 'Test alert: this is how forwarded news appears (BTC)', source: 'test' }, 'test')],
    ['GET', /^\/api\/image$/, async q => ({ dataUrl: V.readImage(app.vault, q.get('path')) })],
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
    ['POST', /^\/api\/strategies\/([^/]+)\/live$/, async (_, b, m) => {
      if (b.action === 'enable') return app.enableLive(m[1], { mode: b.mode, confirm: b.confirm });
      if (b.action === 'disable') return await app.disableLive(m[1]), { ok: true };
      throw err(400, 'Unknown action');
    }],
    ['PUT', /^\/api\/exchange$/, async (_, b) => { await app.setKraken(b); return publicConfig(app.config); }],
    ['DELETE', /^\/api\/exchange$/, async () => { app.removeKraken(); return publicConfig(app.config); }],
    ['POST', /^\/api\/ask$/, async (_, b) => app.ask(b.question)],
    ['POST', /^\/api\/analyse$/, async () => app.analyse()],
    ['GET', /^\/api\/price$/, async q => ({ asset: q.get('asset'), price: await getPrice(q.get('asset')) })],
  ];


  /** Returns { status, body } for a request; never throws. */
  return async function handle(method, pathname, searchParams, body = {}) {
    try {
      for (const [m, re, fn] of routes) {
        const match = pathname.match(re);
        if (!match || m !== method) continue;
        const params = match.map((x, i) => (i ? decodeURIComponent(x) : x));
        return { status: 200, body: await fn(searchParams, body || {}, params) };
      }
      return { status: 404, body: { error: 'Not found' } };
    } catch (e) {
      const status = e.status || (e.code === 'ENOENT' ? 404 : /escapes the vault|Invalid path|Invalid asset/.test(e.message) ? 400 : 500);
      if (status >= 500) console.error(e);
      return { status, body: { error: e.code === 'ENOENT' ? 'Note not found' : e.message, code: e.code } };
    }
  };
}
