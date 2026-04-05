'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  serverPort: process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : null,
  chooseExportFolder: () => ipcRenderer.invoke('choose-export-folder'),
  saveFileToDisk: (filePath, content) =>
    ipcRenderer.invoke('save-file-to-disk', { filePath, content }),
});
