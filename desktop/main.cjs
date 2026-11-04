// Desktop wrapper: starts the same local server in-process and opens it in a window.
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let server;
async function boot() {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'server.js')).href);
  // port 0 = pick a free port, so it never clashes with `npm start` running in a terminal
  const started = await mod.start({ port: 0 });
  server = started.server;
  const win = new BrowserWindow({ width: 1320, height: 880, minWidth: 380, title: 'agentsIA', backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://localhost:${started.port}`)) { e.preventDefault(); shell.openExternal(url); } });
  await win.loadURL(`http://localhost:${started.port}/app`);
}

app.whenReady().then(boot).catch(e => { dialog.showErrorBox('agentsIA could not start', String(e && e.message || e)); app.quit(); });
app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
