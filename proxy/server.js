// agentsIA free-trial proxy. Holds the operator's OpenRouter key so it never ships inside the app.
// Each install gets FREE_PER_INSTALL instructions; one instruction = a short-lived ticket allowing a few model calls.
// No dependencies. Run: OPENROUTER_API_KEY=sk-or-... node proxy/server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const env = (k, d) => process.env[k] ?? d;
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) && process.env[k] !== '' && process.env[k] !== undefined ? v : d; };

export function loadSettings() {
  return {
    apiKey: env('OPENROUTER_API_KEY', ''),
    upstream: env('OPENROUTER_URL', 'https://openrouter.ai/api/v1/chat/completions'),
    port: num('PORT', 8787),
    host: env('HOST', '0.0.0.0'),
    dataFile: env('DATA_FILE', path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'usage.json')),
    salt: env('IP_SALT', ''),
    perInstall: num('FREE_PER_INSTALL', 2),
    perIp: num('FREE_PER_IP', 6),                 // per IP per window, so wiping the install id is not enough
    ipWindowDays: num('IP_WINDOW_DAYS', 30),
    dailyInstructions: num('DAILY_INSTRUCTIONS', 300),
    dailyBudgetUsd: num('DAILY_BUDGET_USD', 15),
    callsPerTicket: num('CALLS_PER_TICKET', 6),
    ticketTtlMs: num('TICKET_TTL_SEC', 600) * 1000,
    maxTokens: num('MAX_TOKENS', 2000),
    maxPromptChars: num('MAX_PROMPT_CHARS', 60000),
    reqPerMin: num('REQ_PER_MIN', 40),
    trustProxy: env('TRUST_PROXY', '') === '1',
    models: env('FREE_MODELS', 'anthropic/claude-opus-5.5,anthropic/claude-fable-5.1,anthropic/claude-sonnet-5.5,openai/gpt-6.1-terra,openai/gpt-6-astra,~google/gemini-pro-latest,~x-ai/grok-latest')
      .split(',').map(s => s.trim()).filter(Boolean),
  };
}

const DAY = 86400000;
const today = () => new Date().toISOString().slice(0, 10);

class Store {
  constructor(file) {
    this.file = file;
    try { this.d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.d = {}; }
    this.d.installs ||= {}; this.d.ips ||= {}; this.d.days ||= {};
    this.dirty = false;
    this.timer = setInterval(() => this.flush(), 2000); this.timer.unref();
  }
  flush() {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.d)); fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
  install(id) { return (this.d.installs[id] ||= { used: 0, first: Date.now() }); }
  ip(h, windowMs) {
    const r = (this.d.ips[h] ||= { used: 0, since: Date.now() });
    if (Date.now() - r.since > windowMs) { r.used = 0; r.since = Date.now(); }
    return r;
  }
  day() {
    const k = today();
    for (const d of Object.keys(this.d.days)) if (d < new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10)) delete this.d.days[d];
    return (this.d.days[k] ||= { instructions: 0, costUsd: 0 });
  }
}

export function createProxy(S = loadSettings()) {
  if (!S.apiKey) throw new Error('OPENROUTER_API_KEY is required');
  const store = new Store(S.dataFile);
  const tickets = new Map();   // token → ticket
  const hits = new Map();      // ip → {n, reset}
  const hashIp = ip => crypto.createHash('sha256').update(S.salt + ip).digest('hex').slice(0, 32);

  const pending = (field, value) => [...tickets.values()].filter(t => !t.counted && t.expires > Date.now() && t[field] === value).length;
  const sweep = () => { for (const [k, t] of tickets) if (t.expires <= Date.now()) tickets.delete(k); };
  const sweeper = setInterval(sweep, 30000); sweeper.unref();

  function remaining(installId, ipHash) {
    const inst = store.d.installs[installId]?.used || 0;
    const ipr = store.d.ips[ipHash];
    const ipUsed = ipr && Date.now() - ipr.since <= S.ipWindowDays * DAY ? ipr.used : 0;
    return Math.max(0, Math.min(S.perInstall - inst - pending('installId', installId), S.perIp - ipUsed - pending('ipHash', ipHash)));
  }

  function countTicket(t) {
    if (t.counted) return;
    t.counted = true;
    store.install(t.installId).used++;
    store.ip(t.ipHash, S.ipWindowDays * DAY).used++;
    store.day().instructions++;
    store.dirty = true;
  }

  async function start(body, ipHash) {
    const installId = String(body.installId || '');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(installId)) throw err(400, 'Invalid installId');
    sweep();
    const day = store.day();
    if (day.costUsd >= S.dailyBudgetUsd || day.instructions + pending('counted', false) >= S.dailyInstructions)
      throw err(503, 'The free trial is paused for today. Add your own OpenRouter key to keep going.', 'FREE_PAUSED');
    if (remaining(installId, ipHash) <= 0) throw err(429, `You have used your ${S.perInstall} free instructions. Add your own OpenRouter API key to keep going.`, 'FREE_USED');
    const token = crypto.randomBytes(24).toString('base64url');
    tickets.set(token, { installId, ipHash, calls: 0, counted: false, expires: Date.now() + S.ticketTtlMs, kind: String(body.kind || '') });
    return { ticket: token, expiresInSec: Math.round(S.ticketTtlMs / 1000), callsAllowed: S.callsPerTicket, remainingAfter: remaining(installId, ipHash) };
  }

  async function chat(body, ipHash) {
    const t = tickets.get(String(body.ticket || ''));
    if (!t || t.expires <= Date.now()) throw err(401, 'Free-trial ticket expired or invalid', 'TICKET');
    if (t.calls >= S.callsPerTicket) throw err(429, 'This instruction used all its model calls', 'TICKET_CALLS');
    if (!S.models.includes(body.model)) throw err(400, `Model not available on the free trial: ${body.model}`);
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 6) throw err(400, 'messages must be 1-6 items');
    let chars = 0;
    const messages = body.messages.map(m => {
      if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw err(400, 'Only text messages are allowed');
      chars += m.content.length;
      return { role: m.role, content: m.content };
    });
    if (chars > S.maxPromptChars) throw err(413, 'Prompt too long for the free trial');
    const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 1000, 1), S.maxTokens);
    t.calls++;
    let r;
    try {
      r = await fetch(S.upstream, {
        method: 'POST', signal: AbortSignal.timeout(120000),
        headers: { Authorization: `Bearer ${S.apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/neoonchain/agentsIA', 'X-Title': 'agentsIA free trial' },
        // no plugins (web search costs extra), no tools, capped tokens; ask OpenRouter to report the cost
        body: JSON.stringify({ model: body.model, messages, max_tokens: maxTokens, usage: { include: true } }),
      });
    } catch (e) { t.calls--; throw err(502, 'Could not reach OpenRouter'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { t.calls--; throw err(502, `Upstream error: ${j.error?.message || r.status}`); }
    const cost = Number(j.usage?.cost);
    const day = store.day();
    day.costUsd += Number.isFinite(cost) ? cost : 0.05; // unknown cost → assume a conservative amount
    countTicket(t);
    store.dirty = true;
    return { choices: [{ message: { content: j.choices?.[0]?.message?.content ?? '' } }], usage: { cost: Number.isFinite(cost) ? cost : null },
      remaining: remaining(t.installId, t.ipHash) };
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); };
    try {
      const ip = (S.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
      const ipHash = hashIp(ip);
      const h = hits.get(ipHash);
      if (!h || h.reset < Date.now()) hits.set(ipHash, { n: 1, reset: Date.now() + 60000 });
      else if (++h.n > S.reqPerMin) return send(429, { error: 'Too many requests, slow down' });
      if (hits.size > 50000) hits.clear();
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/v1/free/status') {
        const id = String(url.searchParams.get('installId') || '');
        if (!/^[A-Za-z0-9-]{16,64}$/.test(id)) return send(400, { error: 'Invalid installId' });
        return send(200, { limit: S.perInstall, remaining: remaining(id, ipHash) });
      }
      if (req.method !== 'POST') return send(404, { error: 'Not found' });
      let size = 0; const chunks = [];
      for await (const c of req) { size += c.length; if (size > S.maxPromptChars * 2 + 10000) return send(413, { error: 'Body too large' }); chunks.push(c); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return send(400, { error: 'Invalid JSON' }); }
      if (url.pathname === '/v1/free/start') return send(200, await start(body, ipHash));
      if (url.pathname === '/v1/free/chat') return send(200, await chat(body, ipHash));
      if (url.pathname === '/v1/free/release') { // give back a ticket that never got a successful answer
        const t = tickets.get(String(body.ticket || ''));
        if (t && !t.counted) tickets.delete(String(body.ticket));
        return send(200, { ok: true });
      }
      send(404, { error: 'Not found' });
    } catch (e) {
      if (!e.status) console.error(e);
      send(e.status || 500, { error: e.status ? e.message : 'Internal error', code: e.code });
    }
  });
  server.on('close', () => { clearInterval(sweeper); clearInterval(store.timer); store.flush(); });
  return { server, store, tickets, settings: S };
}

function err(status, message, code) { return Object.assign(new Error(message), { status, code }); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, store, settings } = createProxy();
  server.listen(settings.port, settings.host, () => console.log(`agentsIA free-trial proxy on ${settings.host}:${settings.port} · ${settings.perInstall}/install, ${settings.perIp}/IP, $${settings.dailyBudgetUsd}/day`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { store.flush(); process.exit(0); });
}
