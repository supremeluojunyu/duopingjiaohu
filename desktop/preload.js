const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  getSignalingUrl: () => ipcRenderer.invoke('get-signaling-url'),
});
