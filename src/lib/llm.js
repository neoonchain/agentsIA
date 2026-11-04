// OpenRouter client. One endpoint for Claude, GPT, Astra, Gemini and Grok.
import { FREE_LIMIT, saveConfig } from './config.js';

export class NeedKeyError extends Error {
  constructor(msg) { super(msg); this.code = 'NEED_KEY'; this.status = 402; }
}

let mockFn = null;
/** Tests replace the network with fn({task, role, modelId, system, user}) → string. */
export function setMockLLM(fn) { mockFn = fn; }

/**
 * Decide which key pays for an instruction. Users get FREE_LIMIT instructions
 * (ask / analyse) on the operator's key; after that, and for all autonomous
 * trading, they need their own OpenRouter key.
 */
export function openInstruction(config, kind) {
  if (config.apiKey) return { key: config.apiKey, free: false, kind, calls: 0 };
  const freeKey = process.env.AGENTSIA_FREE_KEY;
  if (!freeKey) throw new NeedKeyError('Add your OpenRouter API key in Team settings to use the models.');
  if (kind === 'trade') throw new NeedKeyError('Paper trading runs on its own schedule, so it needs your own OpenRouter API key.');
  if ((config.freeUsed || 0) >= FREE_LIMIT) throw new NeedKeyError(`You have used your ${FREE_LIMIT} free instructions. Add your own OpenRouter API key to keep going.`);
  return { key: freeKey, free: true, kind, calls: 0 };
}

export function closeInstruction(config, ins) {
  if (ins.free && ins.calls > 0) { config.freeUsed = (config.freeUsed || 0) + 1; saveConfig(config); }
}

export async function chat(ins, { modelId, system, user, task, role, maxTokens = 1500, web = false }) {
  ins.calls++;
  if (mockFn) return mockFn({ task, role, modelId, system, user });
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
