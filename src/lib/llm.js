// OpenRouter client. One endpoint for Claude, GPT, Astra, Gemini and Grok.
import { saveConfig, freeProxyUrl } from './config.js';

export class NeedKeyError extends Error {
  constructor(msg) { super(msg); this.code = 'NEED_KEY'; this.status = 402; }
}

let mockFn = null;
/** Tests replace the network with fn({task, role, modelId, system, user}) → string. */
export function setMockLLM(fn) { mockFn = fn; }

/**
 * Decide who pays for an instruction. With the user's own key, calls go straight to OpenRouter.
 * Without it, Ask/Analyse can use the free-trial proxy (which holds the operator key and counts
 * instructions server-side). Autonomous paper trading always needs the user's own key.
 */
export async function openInstruction(config, kind) {
  if (config.apiKey) return { key: config.apiKey, free: false, kind, calls: 0 };
  const proxy = freeProxyUrl(config);
  if (!proxy) throw new NeedKeyError('Add your OpenRouter API key in Team settings to use the models.');
  if (kind === 'trade') throw new NeedKeyError('Paper trading runs on its own schedule, so it needs your own OpenRouter API key.');
  if (mockFn) return { free: true, kind, calls: 0, mock: true };
  let r, j;
  try {
    r = await fetch(`${proxy}/v1/free/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ installId: config.installId, kind }), signal: AbortSignal.timeout(15000) });
    j = await r.json().catch(() => ({}));
  } catch (e) { throw new Error(`The free trial server is unreachable (${e.message}). Add your own OpenRouter key to keep going.`); }
  if (r.status === 429 || r.status === 503) { config.freeRemaining = r.status === 429 ? 0 : config.freeRemaining; saveConfig(config); throw new NeedKeyError(j.error || 'Free trial used up.'); }
  if (!r.ok || !j.ticket) throw new Error(`Free trial: ${j.error || 'HTTP ' + r.status}`);
  return { proxy, ticket: j.ticket, free: true, kind, calls: 0 };
}

export async function closeInstruction(config, ins) {
  if (ins.free && typeof ins.remaining === 'number') { config.freeRemaining = ins.remaining; saveConfig(config); }
  if (ins.ticket && typeof ins.remaining !== 'number') { // nothing succeeded: release the reserved slot
    await fetch(`${ins.proxy}/v1/free/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: ins.ticket }), signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}

export async function chat(ins, { modelId, system, user, task, role, maxTokens = 1500, web = false }) {
  ins.calls++;
  if (mockFn) return mockFn({ task, role, modelId, system, user });
  if (ins.ticket) return proxyChat(ins, { modelId, system, user, maxTokens });
  const body = { model: modelId, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (web) body.plugins = [{ id: 'web', max_results: 3 }];
  let r;
  try {
    r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ins.key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/yasmekkk-glitch/agentsIA', 'X-Title': 'agentsIA' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
  } catch (e) { ins.calls--; throw new Error(`Could not reach OpenRouter: ${e.message}`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    ins.calls--;
    const msg = j.error?.message || `HTTP ${r.status}`;
    if (r.status === 401) throw new NeedKeyError(`OpenRouter rejected the API key (${msg}).`);
    if (r.status === 402) throw new NeedKeyError(`OpenRouter: not enough credits (${msg}).`);
    throw new Error(`${modelId}: ${msg}`);
  }
  const text = j.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${modelId} returned an empty answer`);
  return text;
}

async function proxyChat(ins, { modelId, system, user, maxTokens }) {
  let r, j;
  try {
    r = await fetch(`${ins.proxy}/v1/free/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(130000),
      body: JSON.stringify({ ticket: ins.ticket, model: modelId, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
    j = await r.json().catch(() => ({}));
  } catch (e) { ins.calls--; throw new Error(`The free trial server is unreachable (${e.message}).`); }
  if (!r.ok) {
    ins.calls--;
    if (r.status === 429 && j.code !== 'TICKET_CALLS') throw new NeedKeyError(j.error || 'Free trial used up.');
    throw new Error(`Free trial: ${j.error || 'HTTP ' + r.status}`);
  }
  if (typeof j.remaining === 'number') ins.remaining = j.remaining;
  const text = j.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${modelId} returned an empty answer`);
  return text;
}

/** Pull the first JSON object out of a model answer (handles ``` fences and prose around it). */
export function parseJSON(text) {
  const s = String(text).replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) throw new Error('Model did not return JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(s.slice(start, i + 1));
  }
  throw new Error('Model returned incomplete JSON');
}
