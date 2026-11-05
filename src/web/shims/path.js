// Browser stand-in for node:path (POSIX only).
const norm = p => {
  const abs = String(p).startsWith('/'), out = [];
  for (const part of String(p).split('/')) { if (!part || part === '.') continue; if (part === '..') { if (out.length && out.at(-1) !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(part); }
  return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
};
export const sep = '/';
export const normalize = norm;
export const isAbsolute = p => String(p).startsWith('/');
export const join = (...p) => norm(p.filter(x => x !== '').join('/'));
export function resolve(...p) { let r = ''; for (const x of p) r = isAbsolute(x) ? x : (r ? r + '/' + x : x); return norm(isAbsolute(r) ? r : '/' + r); }
export const dirname = p => { const n = norm(p); const i = n.lastIndexOf('/'); return i <= 0 ? (isAbsolute(n) ? '/' : '.') : n.slice(0, i); };
export const basename = (p, ext) => { const b = norm(p).split('/').pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; };
export function relative(from, to) {
  const a = resolve(from).split('/').filter(Boolean), b = resolve(to).split('/').filter(Boolean);
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}
export default { sep, normalize, isAbsolute, join, resolve, dirname, basename, relative };
