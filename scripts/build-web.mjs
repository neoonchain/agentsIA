// Builds the static site for Netlify (or any static host) into ./site:
//   /            landing page
//   /app/        the web app: same UI and engine as the desktop app, running in the browser
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'site');
const freeProxy = process.env.KAIROS_FREE_PROXY || '';
fs.rmSync(out, { recursive: true, force: true });
const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true }); fs.copyFileSync(path.join(root, from), path.join(out, to)); };

copy('index.html', 'index.html');
copy('tour.html', 'tour.html');
copy('manifest.webmanifest', 'manifest.webmanifest');
copy('sw.js', 'sw.js');
for (const f of fs.existsSync(path.join(root, 'assets')) ? fs.readdirSync(path.join(root, 'assets')) : []) copy(`assets/${f}`, `assets/${f}`);
for (const f of fs.readdirSync(path.join(root, 'src/lib'))) if (f.endsWith('.js')) copy(`src/lib/${f}`, `app/lib/${f}`);
for (const f of fs.readdirSync(path.join(root, 'src/web/shims'))) copy(`src/web/shims/${f}`, `app/shims/${f}`);
copy('src/web/boot.js', 'app/boot.js');
copy('src/web/zip.js', 'app/zip.js');
copy('src/public/app.js', 'app/app.js');
copy('src/public/app.css', 'app/app.css');

const importMap = { imports: Object.fromEntries(['fs', 'path', 'os', 'crypto', 'url'].map(m => [`node:${m}`, `./shims/${m}.js`])) };
let html = fs.readFileSync(path.join(root, 'src/public/app.html'), 'utf8')
  .replace('href="/app.css"', 'href="./app.css"')
  .replace('<script src="/app.js" type="module"></script>',
    `<script type="importmap">${JSON.stringify(importMap)}</script>\n<script>window.KAIROS_FREE_PROXY = ${JSON.stringify(freeProxy)};</script>\n<script src="./boot.js" type="module"></script>`);
if (html.includes('/app.js')) throw new Error('app.html script tag not found');
fs.writeFileSync(path.join(out, 'app/index.html'), html);
// precache the web app's own files (not the example charts: those are fetched once when the vault is seeded)
const appFiles = []; (function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name), `${rel}${e.name}/`) : appFiles.push(`${rel}${e.name}`); })(path.join(out, 'app'), 'app/');
const pre = ['./', 'tour', 'manifest.webmanifest', 'app/', ...appFiles.filter(f => f !== 'app/index.html'), 'assets/ia.jpg', 'assets/favicon.svg', 'assets/icon-192.png'];
const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
if (!sw.includes('const PRECACHE = [];')) throw new Error('sw.js PRECACHE placeholder not found');
fs.writeFileSync(path.join(out, 'sw.js'), sw.replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(pre)};`));
console.log(`Built ${out} (free-trial proxy: ${freeProxy || 'none'})`);
