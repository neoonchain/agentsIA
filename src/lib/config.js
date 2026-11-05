// App settings live outside the vault (the vault may be synced or shared; API keys must not be).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const MODELS = {
  opus:   { label: 'Claude Opus 5.5',   id: 'anthropic/claude-opus-5.5' },
  fable:  { label: 'Claude Fable 5.1',  id: 'anthropic/claude-fable-5.1' },
  sonnet: { label: 'Claude Sonnet 5.5', id: 'anthropic/claude-sonnet-5.5' },
  gpt:    { label: 'GPT-6.1 Terra',     id: 'openai/gpt-6.1-terra' },
  astra:  { label: 'GPT-6 Astra',       id: 'openai/gpt-6-astra' },
  gemini: { label: 'Gemini Pro (latest)', id: '~google/gemini-pro-latest' },
  grok:   { label: 'Grok (latest)',     id: '~x-ai/grok-latest' },
};

export const ROLES = {
  lead:       { label: 'Lead analyst',   desc: 'Reads the vault, finds patterns, proposes trades and strategies' },
  psychology: { label: 'Psychology',     desc: 'Reads emotion and tilt notes, turns behaviour patterns into rules' },
  scribe:     { label: 'Scribe',         desc: 'Writes clean, templated notes for every trade' },
  reviewer:   { label: 'Second opinion', desc: 'Reviews every proposal; no agreement, no trade' },
  charts:     { label: 'Charts',         desc: 'Reads price candles and marks levels and trend' },
  context:    { label: 'Market context', desc: 'Macro and news around the asset (needs web search)' },
  sentiment:  { label: 'Sentiment',      desc: 'Social and news sentiment (needs web search)' },
};

export const FREE_LIMIT = 2;
// Set this to your deployed proxy before distributing the app (or use AGENTSIA_FREE_PROXY).
export const DEFAULT_FREE_PROXY = '';
export const freeProxyUrl = c => (process.env.AGENTSIA_FREE_PROXY ?? c.freeProxyUrl ?? DEFAULT_FREE_PROXY).replace(/\/+$/, '');

const DEFAULTS = {
  vaultPath: path.join(os.homedir(), 'TradingVault'),
  apiKey: '',
  mode: 'team',            // 'team' | 'solo'
  soloModel: 'opus',
  models: Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, v.id])),
  roles: { lead: 'opus', psychology: 'fable', scribe: 'sonnet', reviewer: 'gpt', charts: 'astra', context: 'gemini', sentiment: 'grok' },
  enabledRoles: { lead: true, psychology: true, scribe: true, reviewer: true, charts: true, context: false, sentiment: false },
  webSearch: false,
  freeRemaining: null,     // last value reported by the free-trial proxy
  installId: '',
};

export function configDir() {
  return process.env.AGENTSIA_HOME || path.join(os.homedir(), '.agentsia');
}
const file = () => path.join(configDir(), 'config.json');

export function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { /* first run */ }
  const c = { ...DEFAULTS, ...saved };
  c.models = { ...DEFAULTS.models, ...(saved.models || {}) };
  c.roles = { ...DEFAULTS.roles, ...(saved.roles || {}) };
  c.enabledRoles = { ...DEFAULTS.enabledRoles, ...(saved.enabledRoles || {}) };
  if (process.env.AGENTSIA_VAULT) c.vaultPath = process.env.AGENTSIA_VAULT;
  if (!c.installId) { c.installId = crypto.randomUUID(); try { saveConfig(c); } catch { /* read-only home: id stays per session */ } }
  return c;
}

export function saveConfig(c) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

/** Apply a partial update coming from the UI, validating every field. */
export function updateConfig(c, patch) {
  const n = structuredClone(c);
  if (typeof patch.vaultPath === 'string' && patch.vaultPath.trim()) n.vaultPath = path.resolve(patch.vaultPath.trim().replace(/^~(?=$|[\\/])/, os.homedir()));
  if (typeof patch.apiKey === 'string') n.apiKey = patch.apiKey.trim();
  if (patch.mode === 'team' || patch.mode === 'solo') n.mode = patch.mode;
  if (patch.soloModel && MODELS[patch.soloModel]) n.soloModel = patch.soloModel;
  if (typeof patch.webSearch === 'boolean') n.webSearch = patch.webSearch;
  for (const [k, v] of Object.entries(patch.models || {})) {
    if (MODELS[k] && typeof v === 'string' && /^~?[\w.\-]+\/[\w.:\-]+$/.test(v.trim())) n.models[k] = v.trim();
  }
  for (const [r, m] of Object.entries(patch.roles || {})) if (ROLES[r] && MODELS[m]) n.roles[r] = m;
  for (const [r, on] of Object.entries(patch.enabledRoles || {})) if (ROLES[r] && typeof on === 'boolean') n.enabledRoles[r] = on;
  n.enabledRoles.lead = true; // the team always needs a lead
  return n;
}

export function publicConfig(c) {
  const { apiKey, installId, kraken, ...rest } = c;
  const left = c.freeRemaining ?? FREE_LIMIT;
  return { ...rest, hasApiKey: !!apiKey, apiKeyHint: apiKey ? '…' + apiKey.slice(-4) : '', freeLimit: FREE_LIMIT, freeUsed: Math.max(FREE_LIMIT - left, 0),
    freeAvailable: !!freeProxyUrl(c), web: !!globalThis.AGENTSIA_WEB, vaultLabel: globalThis.AGENTSIA_VAULT_LABEL || c.vaultPath, hasKraken: !!kraken, krakenHint: kraken ? '…' + kraken.key.slice(-4) : '', krakenCheckedAt: kraken?.checkedAt || null, catalog: { models: MODELS, roles: ROLES } };
}
