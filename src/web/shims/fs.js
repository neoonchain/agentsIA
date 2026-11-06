// Browser stand-in for node:fs. Files live in memory (the engine expects sync calls) and are
// saved in the background to a "mount": a real folder (File System Access API) or IndexedDB.
const files = new Map();       // absolute path -> string
const dirs = new Set(['/']);
const mounts = [];             // { prefix, backend, dirty: Map(path -> 'write'|'delete') }
let timer = null;
const listeners = new Set();

const norm = p => {
  const out = [];
  for (const part of String(p).split('/')) { if (!part || part === '.') continue; if (part === '..') out.pop(); else out.push(part); }
  return '/' + out.join('/');
};
const parent = p => norm(p).replace(/\/[^/]*$/, '') || '/';
function addDirs(p) { for (let d = norm(p); ; d = parent(d)) { dirs.add(d); if (d === '/') break; } }
function enoent(p) { return Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' }); }

function changed(p, kind) {
  for (const m of mounts) if (p === m.prefix || p.startsWith(m.prefix + '/')) m.dirty.set(p, kind);
  clearTimeout(timer); timer = setTimeout(flushAll, 400);
  for (const fn of listeners) fn('dirty');
}

export function existsSync(p) { p = norm(p); return files.has(p) || dirs.has(p); }
export function mkdirSync(p) { addDirs(p); }
export function readFileSync(p) { p = norm(p); if (!files.has(p)) throw enoent(p); return files.get(p); }
export function writeFileSync(p, data) { p = norm(p); addDirs(parent(p)); files.set(p, data instanceof Uint8Array ? data : String(data)); changed(p, 'write'); }
export function appendFileSync(p, data) { p = norm(p); addDirs(parent(p)); files.set(p, (files.get(p) || '') + String(data)); changed(p, 'write'); }
export function renameSync(a, b) {
  a = norm(a); b = norm(b);
  if (!files.has(a)) throw enoent(a);
  addDirs(parent(b)); files.set(b, files.get(a)); files.delete(a);
  changed(b, 'write'); changed(a, 'delete');
}
export function readdirSync(p, opts = {}) {
  p = norm(p); if (!dirs.has(p)) throw enoent(p);
  const pre = p === '/' ? '/' : p + '/', names = new Map();
  for (const f of files.keys()) if (f.startsWith(pre)) { const n = f.slice(pre.length).split('/')[0]; if (!names.has(n)) names.set(n, f.slice(pre.length).includes('/')); }
  for (const d of dirs) if (d.startsWith(pre) && d !== p) names.set(d.slice(pre.length).split('/')[0], true);
  const out = [...names].sort(([a], [b]) => a.localeCompare(b));
  return opts.withFileTypes ? out.map(([name, isDir]) => ({ name, isDirectory: () => isDir, isFile: () => !isDir })) : out.map(([n]) => n);
}

/** Load everything a backend holds under prefix, then keep it in sync. */
export async function mount(prefix, backend) {
  prefix = norm(prefix);
  addDirs(prefix);
  for (const [rel, content] of Object.entries(await backend.load())) { const p = norm(prefix + '/' + rel); addDirs(parent(p)); files.set(p, content); }
  mounts.push({ prefix, backend, dirty: new Map() });
}

export async function flushAll() {
  clearTimeout(timer); timer = null;
  let failed = null;
  for (const m of mounts) {
    const batch = [...m.dirty]; m.dirty.clear();
    for (const [p, kind] of batch) {
      const rel = p.slice(m.prefix.length + 1);
      try { if (kind === 'delete') await m.backend.remove(rel); else await m.backend.save(rel, files.get(p) ?? ''); }
      catch (e) { m.dirty.set(p, kind); failed = e; }
    }
  }
  for (const fn of listeners) fn(failed ? 'error' : 'saved', failed);
  if (failed) { clearTimeout(timer); timer = setTimeout(flushAll, 3000); }
}
export const pending = () => mounts.some(m => m.dirty.size);
export const onStatus = fn => listeners.add(fn);
/** Files under a prefix, relative paths → content (used for the .zip export). */
export function snapshot(prefix) {
  prefix = norm(prefix); const out = {};
  for (const [p, c] of files) if (p.startsWith(prefix + '/')) out[p.slice(prefix.length + 1)] = c;
  return out;
}

/* ---------------- backends ---------------- */
function idb() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open('agentsia', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('files'); r.result.createObjectStore('meta'); };
    r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
  });
}
async function tx(store, mode, fn) {
  const db = await idb();
  return new Promise((ok, ko) => { const t = db.transaction(store, mode); const res = fn(t.objectStore(store)); t.oncomplete = () => ok(res?.result); t.onerror = () => ko(t.error); });
}
export const meta = {
  get: k => tx('meta', 'readonly', s => s.get(k)),
  set: (k, v) => tx('meta', 'readwrite', s => s.put(v, k)),
  del: k => tx('meta', 'readwrite', s => s.delete(k)),
};

/** IndexedDB backend: everything stays inside this browser. */
export function idbBackend(ns) {
  return {
    async load() {
      const db = await idb(); const out = {};
      await new Promise((ok, ko) => {
        const t = db.transaction('files', 'readonly'); const req = t.objectStore('files').openCursor();
        req.onsuccess = () => { const c = req.result; if (!c) return ok(); if (String(c.key).startsWith(ns + ':')) out[String(c.key).slice(ns.length + 1)] = c.value; c.continue(); };
        req.onerror = () => ko(req.error);
      });
      return out;
    },
    save: (rel, content) => tx('files', 'readwrite', s => s.put(content, `${ns}:${rel}`)),
    remove: rel => tx('files', 'readwrite', s => s.delete(`${ns}:${rel}`)),
  };
}

/** Real folder backend (Chrome / Edge): reads and writes the user's Obsidian vault directly. */
export function dirBackend(root) {
  const TEXT = /\.(md|json)$/i, IMG = /\.(png|jpe?g|webp|gif)$/i;
  async function dirFor(rel, create) {
    let d = root;
    for (const part of rel.split('/').slice(0, -1)) d = await d.getDirectoryHandle(part, { create });
    return d;
  }
  return {
    async load() {
      const out = {};
      async function walk(dir, pre) {
        for await (const [name, h] of dir.entries()) {
          if (name.startsWith('.') && name !== '.kairos' && name !== '.agentsia') continue; // skip .obsidian, .git, .trash…
          if (h.kind === 'directory') await walk(h, pre + name + '/');
          else if (TEXT.test(name)) out[pre + name] = await (await h.getFile()).text();
          else if (IMG.test(name)) out[pre + name] = new Uint8Array(await (await h.getFile()).arrayBuffer());
        }
      }
      await walk(root, '');
      return out;
    },
    async save(rel, content) {
      const fh = await (await dirFor(rel, true)).getFileHandle(rel.split('/').pop(), { create: true });
      const w = await fh.createWritable(); await w.write(content); await w.close();
    },
    async remove(rel) { try { await (await dirFor(rel, false)).removeEntry(rel.split('/').pop()); } catch { /* already gone */ } },
  };
}

export default { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, readdirSync };
