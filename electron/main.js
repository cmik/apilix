'use strict';

const { app, BrowserWindow, shell, ipcMain, dialog, safeStorage } = require('electron');
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
  process.env.APILIX_DATA_DIR = app.getPath('userData');

  if (isDev) {
    const { fork } = require('child_process');
    const serverPath = path.join(__dirname, '..', 'server', 'index.js');
    serverProcess = fork(serverPath, [], {
      env: { ...process.env, PORT: String(port), APILIX_DATA_DIR: app.getPath('userData') },
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

// ─── Workspace / Persistence IPC ─────────────────────────────────────────────

function getUserDataDir() {
  return app.getPath('userData');
}

function assertInsideUserData(filePath) {
  const base = path.resolve(getUserDataDir());
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error('Path traversal detected: path must be inside userData');
  }
}

// Returns the userData directory path
ipcMain.handle('get-data-dir', () => getUserDataDir());

// Read and parse a JSON file from disk (must be inside userData)
ipcMain.handle('read-json-file', async (_event, { filePath }) => {
  assertInsideUserData(filePath);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
});

// Write JSON data to a file (must be inside userData); creates parent directories
ipcMain.handle('write-json-file', async (_event, { filePath, data }) => {
  assertInsideUserData(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
});

// Delete a file (must be inside userData); no-ops if not found
ipcMain.handle('delete-file', async (_event, { filePath }) => {
  assertInsideUserData(filePath);
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
});

// List files in a directory (must be inside userData)
ipcMain.handle('list-dir', async (_event, { dirPath }) => {
  assertInsideUserData(dirPath);
  try {
    return fs.readdirSync(dirPath);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
});

// Open a file picker dialog for import
ipcMain.handle('open-file-dialog', async (_event, { filters } = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open file',
    properties: ['openFile'],
    filters: filters ?? [{ name: 'All Files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Reveal a path in Finder / Explorer
ipcMain.handle('shell-open-path', async (_event, { dirPath }) => {
  assertInsideUserData(dirPath);
  shell.showItemInFolder(dirPath);
});

// Encrypt a string using OS keychain (safeStorage)
ipcMain.handle('encrypt-string', (_event, { value }) => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(value).toString('base64');
});

// Decrypt a base64-encoded string previously encrypted with encrypt-string
ipcMain.handle('decrypt-string', (_event, { encrypted }) => {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return null;
  }
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
