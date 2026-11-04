// Minimal YAML frontmatter for Obsidian notes: flat keys, scalars and lists.

function parseScalar(raw) {
  const v = raw.trim();
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitList(inner).map(parseScalar);
  }
  return v;
}

function splitList(s) {
  const out = []; let cur = ''; let q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(x => x !== '');
}

export function parse(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: src };
  const data = {}; let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) { data[listKey].push(parseScalar(item[1])); continue; }
    const kv = line.match(/^([A-Za-z0-9_\- ]+):\s?(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    if (kv[2].trim() === '') { data[key] = []; listKey = key; continue; }
    listKey = null;
    data[key] = parseScalar(kv[2]);
  }
  return { data, body: m[2] };
}

function fmtScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s === '' || /^[\s\-?:,\[\]{}#&*!|>'"%@`]|[:#]\s|\s$|^(true|false|null|~)$|^-?\d+(\.\d+)?$|\n/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ') + '"';
  }
  return s;
}

export function stringify(data, body = '') {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${Array.isArray(v) ? '[' + v.map(fmtScalar).join(', ') + ']' : fmtScalar(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n') + String(body).replace(/^\n+/, '');
}
