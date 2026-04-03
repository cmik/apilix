'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  serverPort: process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : null,
});
