'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  serverPort: process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : null,
  // ── Existing ──────────────────────────────────────────────────────────────
  chooseExportFolder: () => ipcRenderer.invoke('choose-export-folder'),
  saveFileToDisk: (filePath, content) =>
    ipcRenderer.invoke('save-file-to-disk', { filePath, content }),
  // ── Workspace / Persistence ───────────────────────────────────────────────
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),
  readJsonFile: (filePath) => ipcRenderer.invoke('read-json-file', { filePath }),
  writeJsonFile: (filePath, data) => ipcRenderer.invoke('write-json-file', { filePath, data }),
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', { filePath }),
  listDir: (dirPath) => ipcRenderer.invoke('list-dir', { dirPath }),
  openFileDialog: (filters) => ipcRenderer.invoke('open-file-dialog', { filters }),
  shellOpenPath: (dirPath) => ipcRenderer.invoke('shell-open-path', { dirPath }),
  encryptString: (value) => ipcRenderer.invoke('encrypt-string', { value }),
  decryptString: (encrypted) => ipcRenderer.invoke('decrypt-string', { encrypted }),
});
