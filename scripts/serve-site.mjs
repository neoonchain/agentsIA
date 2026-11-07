// Serves the static web build (./site) for hosts like Railway: the landing page, the tour and the web app,
// which runs entirely in the visitor's browser. It never starts the local Kairos server (src/server.js):
// that one holds a vault and keys and must only ever listen on your own machine.
//   node scripts/serve-site.mjs        (PORT from the environment, default 8080; builds ./site first if missing)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
if (!fs.existsSync(path.join(site, 'index.html'))) execFileSync(process.execPath, [path.join(root, 'scripts/build-web.mjs')], { stdio: 'inherit' });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };

function resolve(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  const full = path.resolve(site, '.' + p);
  if (full !== site && !full.startsWith(site + path.sep)) return null; // no escaping the site folder
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return fs.existsSync(path.join(full, 'index.html')) ? path.join(full, 'index.html') : null;
  if (fs.existsSync(full)) return full;
  if (fs.existsSync(full + '.html')) return full + '.html'; // /tour -> tour.html
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  const u = req.url || '/';
  if (u === '/app' || u.startsWith('/app?')) { res.writeHead(301, { Location: '/app/' + u.slice(4) }); return res.end(); } // relative paths need the slash
  const file = resolve(u);
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
  const ext = path.extname(file).toLowerCase(), name = path.basename(file);
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin',
    // pages and the service worker always revalidate; images and the rest may be cached for an hour
    'Cache-Control': ext === '.html' || name === 'sw.js' || ext === '.webmanifest' ? 'no-cache' : 'public, max-age=3600',
  };
  if (name === 'sw.js') headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT) || 8080;
server.listen(port, '0.0.0.0', () => console.log(`Kairos site on port ${port} (static web build: ${site})`));
