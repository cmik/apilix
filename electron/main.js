'use strict';

const { app, BrowserWindow, shell, ipcMain, dialog, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const isDev = !app.isPackaged;
// DevTools are always available in dev; can be disabled in production
// builds by setting DISABLE_DEVTOOLS=1 in the environment before packaging.
const devToolsEnabled = isDev || process.env.DISABLE_DEVTOOLS !== '1';

let mainWindow = null;
let serverProcess = null;
let appLoaded = false;
let serverPort = null;
let closeGuardTimeout = null;
let cdpChromeProcess = null;

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
      // Redirect console.error/warn to the log file so server-side errors
      // (e.g. OAuth failures, execute errors) are visible in the log.
      const _origError = console.error.bind(console);
      const _origWarn  = console.warn.bind(console);
      console.error = (...args) => { writeLog('[server:err] ' + args.join(' ')); _origError(...args); };
      console.warn  = (...args) => { writeLog('[server:warn] ' + args.join(' ')); _origWarn(...args);  };

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
      devTools: devToolsEnabled,
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

  // Show splash immediately — eliminates blank window during server startup.
  mainWindow.loadFile(path.join(__dirname, 'splash.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
    appLoaded = false;
  });

  // Intercept close so the renderer can warn about unsaved tabs.
  // If the splash is still showing (app not loaded yet), allow the window to
  // close naturally (no preventDefault).  Once the app is loaded we prevent
  // default, ask the renderer, and set a 5-second safety timeout so that a
  // hung/crashed renderer never leaves the window unclosable.
  mainWindow.on('close', (e) => {
    if (!appLoaded) {
      return; // Let the OS close the window normally during splash.
    }
    e.preventDefault();
    mainWindow.webContents.send('app:will-close');
    // Safety fallback: destroy the window if the renderer never replies.
    if (closeGuardTimeout) clearTimeout(closeGuardTimeout);
    closeGuardTimeout = setTimeout(() => {
      closeGuardTimeout = null;
      if (mainWindow) mainWindow.destroy();
    }, 5000);
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

// Recursively delete a directory (must be inside userData)
ipcMain.handle('delete-directory', async (_event, { dirPath }) => {
  assertInsideUserData(dirPath);
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
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

// Generate short-lived S3 presigned URLs in the main process so credentials
// never need to be exposed to the renderer.
ipcMain.handle('get-presigned-url', async (_event, payload) => {
  const {
    operation,
    bucket,
    region,
    keyId,
    secret,
    objectKey,
    endpoint,
  } = payload ?? {};

  if (!operation || !bucket || !keyId || !secret || !objectKey) {
    throw new Error('Missing required fields for presigned URL generation');
  }
  if (!endpoint && !region) {
    throw new Error('Either region (for AWS S3) or endpoint (for MinIO) is required');
  }

  if (!['GET', 'PUT', 'HEAD'].includes(operation)) {
    throw new Error(`Unsupported S3 operation: ${operation}`);
  }

  const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

  const clientConfig = {
    region: region || 'us-east-1',
    credentials: {
      accessKeyId: keyId,
      secretAccessKey: secret,
    },
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  };

  const client = new S3Client(clientConfig);

  const commandByOperation = {
    GET: new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    PUT: new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: 'application/json' }),
    HEAD: new HeadObjectCommand({ Bucket: bucket, Key: objectKey }),
  };

  return getSignedUrl(client, commandByOperation[operation], { expiresIn: 60 });
});

// Poll the Express health endpoint using Node's built-in http module.
// Returns true as soon as it responds 200, false after 500 ms or on error.
function checkServerReady(port) {
  return new Promise((resolve) => {
    const req = require('http').get(`http://127.0.0.1:${port}/api/health`, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
  });
}

// Poll health endpoint then navigate the window to the real app URL.
async function waitAndLoadApp(port) {
  const startURL = isDev
    ? 'http://localhost:5173'
    : `file://${path.join(__dirname, '..', 'client', 'dist', 'index.html')}`;

  // Run health polling and a minimum splash display time concurrently.
  // The minimum ensures the splash is always visible long enough to be seen,
  // even when the server is already warm (e.g. macOS reopen-from-tray).
  const minDelay = new Promise(r => setTimeout(r, 600));

  const pollReady = async () => {
    for (let i = 0; i < 40; i++) {
      if (await checkServerReady(port)) return;
      await new Promise(r => setTimeout(r, 200));
    }
  };

  await Promise.all([pollReady(), minDelay]);

  if (mainWindow) {
    appLoaded = true;
    mainWindow.loadURL(startURL);
  }
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    // On macOS the first item is always the app menu
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    { role: 'editMenu' },
    devToolsEnabled
      ? { role: 'viewMenu' }
      : {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
        },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Wiki',
          click: () => shell.openExternal('https://github.com/cmik/apilix/wiki'),
        },
        {
          label: 'Check for Update',
          click: () => shell.openExternal('https://github.com/cmik/apilix/releases/latest'),
        },
        { type: 'separator' },
        {
          label: `About Apilix`,
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Apilix',
              message: `Apilix v${app.getVersion()}`,
              detail: 'Alternative Platform for Instant Live API eXecution\nhttps://github.com/cmik/apilix',
              buttons: ['OK'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // In dev, keep port 3001 so Vite's proxy config stays valid.
  // In production, find a free port dynamically.
  const port = isDev ? 3001 : await findFreePort();
  serverPort = port;
  writeLog('Using port ' + port);
  startServer(port);
  createWindow();
  buildAppMenu();
  waitAndLoadApp(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      waitAndLoadApp(serverPort);
    }
  });
});

// IPC: spawn Chrome with remote debugging enabled for CDP capture
ipcMain.handle('cdp-launch-chrome', async (_event, { chromePath, port }) => {
  if (cdpChromeProcess) return { ok: true, alreadyRunning: true };
  const { spawn } = require('child_process');
  cdpChromeProcess = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    '--user-data-dir=/tmp/apilix-cdp',
    '--no-first-run',
    '--no-default-browser-check',
  ], { detached: false });
  cdpChromeProcess.on('exit', () => { cdpChromeProcess = null; });
  cdpChromeProcess.on('error', (err) => { writeLog('CDP Chrome error: ' + err.message); cdpChromeProcess = null; });
  return { ok: true };
});

// IPC: kill the Chrome process launched for CDP capture
ipcMain.handle('cdp-kill-chrome', async () => {
  if (cdpChromeProcess) {
    try { cdpChromeProcess.kill(); } catch (_) {}
    cdpChromeProcess = null;
  }
  return { ok: true };
});

// Renderer confirmed it is safe to close.
ipcMain.on('app:close-response', (_, { confirmed }) => {
  if (closeGuardTimeout) {
    clearTimeout(closeGuardTimeout);
    closeGuardTimeout = null;
  }
  if (confirmed && mainWindow) {
    mainWindow.destroy();
  }
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
  if (cdpChromeProcess) {
    try { cdpChromeProcess.kill(); } catch (_) {}
    cdpChromeProcess = null;
  }
});
