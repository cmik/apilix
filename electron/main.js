'use strict';

const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const isDev = !app.isPackaged;

let mainWindow = null;
let serverProcess = null;

function writeLog(msg) {
  try {
    const logPath = path.join(app.getPath('logs'), 'apilix-server.log');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
  console.log(msg);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function startServer(port) {
  process.env.PORT = String(port);
  process.env.API_PORT = String(port);

  if (isDev) {
    const { fork } = require('child_process');
    const serverPath = path.join(__dirname, '..', 'server', 'index.js');
    serverProcess = fork(serverPath, [], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'pipe',
    });
    serverProcess.stdout.on('data', (d) => writeLog('[server] ' + d.toString().trim()));
    serverProcess.stderr.on('data', (d) => writeLog('[server:err] ' + d.toString().trim()));
    serverProcess.on('error', (err) => writeLog('Server process error: ' + err));
  } else {
    const serverPath = path.join(process.resourcesPath, 'server', 'index.js');
    writeLog('Starting server from: ' + serverPath);
    writeLog('Server file exists: ' + fs.existsSync(serverPath));

    if (!fs.existsSync(serverPath)) {
      try {
        const files = fs.readdirSync(process.resourcesPath);
        writeLog('Resources dir contents: ' + files.join(', '));
      } catch (e) {
        writeLog('Could not read resources dir: ' + e.message);
      }
      return;
    }

    try {
      require(serverPath);
      writeLog('Server started on port ' + port);
    } catch (err) {
      writeLog('Failed to start server: ' + err.stack);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Apilix',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Open external http/https links in the default browser.
  // Allow blank/internal window.open() calls (e.g. Console pop-out) to open normally.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  const startURL = isDev
    ? 'http://localhost:5173'
    : `file://${path.join(__dirname, '..', 'client', 'dist', 'index.html')}`;

  // Wait for the server to be ready, then load the UI
  setTimeout(() => {
    mainWindow.loadURL(startURL);
  }, 2000);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC: let the renderer pick an export folder
ipcMain.handle('choose-export-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose export folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// IPC: write a file straight to disk (used after folder is chosen)
ipcMain.handle('save-file-to-disk', async (_event, { filePath, content }) => {
  fs.writeFileSync(filePath, content, 'utf8');
});

app.whenReady().then(async () => {
  // In dev, keep port 3001 so Vite's proxy config stays valid.
  // In production, find a free port dynamically.
  const port = isDev ? 3001 : await findFreePort();
  writeLog('Using port ' + port);
  startServer(port);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
