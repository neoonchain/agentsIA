// Desktop app: starts the local Kairos server in-process and shows it in a window.
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Packaged: src/ sits next to this file. Development: it is one folder up.
const serverPath = [path.join(__dirname, 'src', 'server.js'), path.join(__dirname, '..', 'src', 'server.js')].find(p => fs.existsSync(p));

if (!app.requestSingleInstanceLock()) app.quit();

let server, win;
async function boot() {
  const mod = await import(pathToFileURL(serverPath).href);
  const started = await mod.start({ port: 0 }); // free port: never clashes with `npm start` in a terminal
  server = started.server;
  const origin = `http://localhost:${started.port}`;
  win = new BrowserWindow({ width: 1320, height: 880, minWidth: 380, title: 'Kairos', backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(origin)) { e.preventDefault(); shell.openExternal(url); } });
  await win.loadURL(`${origin}/app`);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(boot).catch(e => { dialog.showErrorBox('Kairos could not start', String((e && e.stack) || e)); app.quit(); });
app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
