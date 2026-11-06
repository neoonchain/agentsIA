// Web app boot: choose where the vault lives, mount it, run the same engine in this tab.
import * as vfs from 'node:fs';
import { zip } from './zip.js';

globalThis.KAIROS_WEB = true;
globalThis.process ??= { env: {}, argv: [] };
Object.assign(globalThis.process.env, { KAIROS_VAULT: '/vault', KAIROS_HOME: '/config' });
if (globalThis.KAIROS_FREE_PROXY) globalThis.process.env.KAIROS_FREE_PROXY = globalThis.KAIROS_FREE_PROXY;

const canPickFolder = 'showDirectoryPicker' in window;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function screen(html) {
  let el = document.getElementById('boot');
  if (!el) { el = document.createElement('div'); el.id = 'boot'; document.body.appendChild(el); }
  el.innerHTML = `<div class="wrap" style="max-width:760px;padding-top:70px">${html}</div>`;
  return el;
}

async function choose() {
  return new Promise(resolve => {
    const el = screen(`
      <span class="eyebrow">Kairos · web</span>
      <h1 style="margin:14px 0 12px">Where should your journal live?</h1>
      <p class="sub" style="margin-bottom:22px">Everything stays on your device: there is no Kairos server, and your notes and keys never leave this browser except to call the AI models you choose.</p>
      <div class="grid g2">
        <div class="card"><h2>Your Obsidian folder</h2><p class="sub" style="margin:8px 0 16px">Pick (or create) a folder; every trade is saved there as a Markdown note you can open in Obsidian.${canPickFolder ? '' : '<br><b>Needs Chrome, Edge or Brave on a computer.</b>'}</p>
          <button class="btn dark" id="pickDir" ${canPickFolder ? '' : 'disabled'}>Choose a folder</button></div>
        <div class="card"><h2>Keep it in this browser</h2><p class="sub" style="margin:8px 0 16px">Works in every browser. Export it as a .zip any time to open it in Obsidian. Clearing site data deletes it.</p>
          <button class="btn" id="useBrowser">Use this browser</button></div>
      </div>
      <p class="sub" style="margin-top:22px">Real-money trading on Kraken is only in the <a href="../tour#get">desktop app</a>.</p>`);
    el.querySelector('#useBrowser').onclick = async () => { await vfs.meta.set('vault', { kind: 'browser' }); resolve({ kind: 'browser' }); };
    if (canPickFolder) el.querySelector('#pickDir').onclick = async () => {
      try {
        const handle = await window.showDirectoryPicker({ id: 'kairos-vault', mode: 'readwrite' });
        await vfs.meta.set('vault', { kind: 'dir', handle, name: handle.name });
        resolve({ kind: 'dir', handle, name: handle.name });
      } catch { /* cancelled */ }
    };
  });
}

/** Folder handles survive reloads, but the browser asks again for permission after a restart. */
async function reconnect(v) {
  if ((await v.handle.queryPermission({ mode: 'readwrite' })) === 'granted') return v;
  return new Promise(resolve => {
    const el = screen(`<span class="eyebrow">Kairos · web</span><h1 style="margin:14px 0 12px">Reconnect your vault</h1>
      <p class="sub" style="margin-bottom:20px">Your browser needs your OK again to read and write <b>${esc(v.name)}</b>.</p>
      <div class="row"><button class="btn dark" id="grant">Allow access to ${esc(v.name)}</button><button class="btn" id="other">Choose another place</button></div>`);
    el.querySelector('#grant').onclick = async () => { if ((await v.handle.requestPermission({ mode: 'readwrite' })) === 'granted') resolve(v); };
    el.querySelector('#other').onclick = async () => { await vfs.meta.del('vault'); resolve(await choose()); };
  });
}

async function boot() {
  let v = await vfs.meta.get('vault');
  if (!v) v = await choose();
  else if (v.kind === 'dir') v = await reconnect(v);
  screen('<p class="empty"><span class="spin"></span> Opening your vault…</p>');
  await vfs.mount('/config', vfs.idbBackend('config'));
  await vfs.mount('/vault', v.kind === 'dir' ? vfs.dirBackend(v.handle) : vfs.idbBackend('vault'));
  globalThis.KAIROS_VAULT_LABEL = v.kind === 'dir' ? `Folder “${v.name}” on this computer` : 'This browser (export to open in Obsidian)';

  const { App } = await import('./lib/core.js');
  const { createApi } = await import('./lib/routes.js');
  const app = new App();
  const handle = createApi(app);
  window.__kairosApi = (method, url, body) => { const u = new URL(url, location.origin); return handle(method, u.pathname, u.searchParams, body); };
  window.__kairosWeb = {
    kind: v.kind, label: globalThis.KAIROS_VAULT_LABEL,
    exportZip() {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(zip(vfs.snapshot('/vault')));
      a.download = `TradingVault-${new Date().toISOString().slice(0, 10)}.zip`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
    async switchVault() { await vfs.flushAll(); await vfs.meta.del('vault'); location.reload(); },
    onStatus: vfs.onStatus,
  };
  // Paper trading: same scheduler as the desktop app, while this tab is open.
  let busy = false;
  setInterval(async () => { if (busy) return; busy = true; try { await app.tick(); } finally { busy = false; } }, 60000);
  let newsBusy = false;
  setInterval(async () => { if (newsBusy) return; newsBusy = true; try { await app.newsTick(); } finally { newsBusy = false; } }, 30000);
  setTimeout(() => app.newsTick().catch(() => {}), 1500);
  addEventListener('pagehide', () => { vfs.flushAll(); });
  addEventListener('beforeunload', e => { if (vfs.pending()) { vfs.flushAll(); e.preventDefault(); } });

  document.getElementById('boot')?.remove();
  document.body.classList.remove('booting');
  await import('./app.js');
}

boot().catch(e => screen(`<div class="banner">Kairos could not start: ${esc(e.message)}</div>`));
