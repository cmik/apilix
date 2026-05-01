'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  serverPort: process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : null,
  // ── Existing ──────────────────────────────────────────────────────────────
  chooseExportFolder: () => ipcRenderer.invoke('choose-export-folder'),
  saveFileToDisk: (filePath, content) =>
    ipcRenderer.invoke('save-file-to-disk', { filePath, content }),
  saveResponseFile: (defaultPath, content) =>
    ipcRenderer.invoke('save-response-file', { defaultPath, content }),
  // ── Workspace / Persistence ───────────────────────────────────────────────
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  readJsonFile: (filePath) => ipcRenderer.invoke('read-json-file', { filePath }),
  writeJsonFile: (filePath, data) => ipcRenderer.invoke('write-json-file', { filePath, data }),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', { filePath }),
  deleteDirectory: (dirPath) => ipcRenderer.invoke('delete-directory', { dirPath }),
  listDir: (dirPath) => ipcRenderer.invoke('list-dir', { dirPath }),
  openFileDialog: (filters) => ipcRenderer.invoke('open-file-dialog', { filters }),
  readTextFile: (filePath) => ipcRenderer.invoke('read-text-file', { filePath }),
  shellOpenPath: (dirPath) => ipcRenderer.invoke('shell-open-path', { dirPath }),
  encryptString: (value) => ipcRenderer.invoke('encrypt-string', { value }),
  decryptString: (encrypted) => ipcRenderer.invoke('decrypt-string', { encrypted }),
  getPresignedUrl: (payload) => ipcRenderer.invoke('get-presigned-url', payload),
  // ── CDP Browser Capture ───────────────────────────────────────────────────
  cdpLaunchChrome: (chromePath, port) => ipcRenderer.invoke('cdp-launch-chrome', { chromePath, port }),
  cdpKillChrome: () => ipcRenderer.invoke('cdp-kill-chrome'),
  // ── DevTools ──────────────────────────────────────────────────────────────
  openDevTools: () => ipcRenderer.invoke('open-devtools'),
  // Close guard: main process notifies renderer before closing the window.
  onWillClose: (cb) => ipcRenderer.on('app:will-close', () => cb()),
  respondClose: (confirmed) => ipcRenderer.send('app:close-response', { confirmed }),
});
