// 只把需要的功能暴露给页面，页面拿不到 API Key 和文件系统
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (payload) => ipcRenderer.invoke('data:save', payload),
  getAI: () => ipcRenderer.invoke('ai:get'),
  saveAI: (input) => ipcRenderer.invoke('ai:save', input),
  testAI: () => ipcRenderer.invoke('ai:test'),
  recognize: (req) => ipcRenderer.invoke('ai:recognize', req),
  saveCsv: (name, data) => ipcRenderer.invoke('file:saveCsv', { name, data }),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  info: () => ipcRenderer.invoke('app:info'),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdate: (url) => ipcRenderer.invoke('update:open', url),
  onUpdate: (cb) => { ipcRenderer.on('update', (_e, d) => cb(d)); },
  mailGet: () => ipcRenderer.invoke('mail:get'),
  mailSave: (input) => ipcRenderer.invoke('mail:save', input),
  mailTest: () => ipcRenderer.invoke('mail:test'),
  mailScan: (opts) => ipcRenderer.invoke('mail:scan', opts),
  mailImport: (scanId, ids) => ipcRenderer.invoke('mail:import', { scanId, ids }),
  mailOpenLink: (url) => ipcRenderer.invoke('mail:openLink', url),
  onMailProgress: (cb) => { ipcRenderer.on('mail-progress', (_e, t) => cb(t)); }
});
