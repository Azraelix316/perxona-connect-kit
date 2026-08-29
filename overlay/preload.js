const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  setDraggable: (draggable) => ipcRenderer.send('set-draggable', draggable),

  // Highlighting
  showHighlight: (rect) => ipcRenderer.send('show-highlight', rect),
  hideHighlight: () => ipcRenderer.send('hide-highlight'),
  onHighlight: (callback) => ipcRenderer.on('highlight', (_e, data) => callback(data)),
  onHideHighlight: (callback) => ipcRenderer.on('hide-highlight', () => callback()),

  // Screen capture & proactive prediction
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  getLatestPrediction: () => ipcRenderer.invoke('get-latest-prediction'),
  setLatestPrediction: (pred) => ipcRenderer.invoke('set-latest-prediction', pred),

  // Memory bank
  getMemory: () => ipcRenderer.invoke('get-memory'),
  saveMemory: (data) => ipcRenderer.invoke('save-memory', data),

  // Activity events
  onActiveStatus: (callback) => ipcRenderer.on('active-status', (_e, status) => callback(status)),
});
