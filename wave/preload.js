const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('waveHost', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSetting: (key, value) => ipcRenderer.invoke('settings:update', { key, value }),
  applyWindowPosition: (mountPosition) => ipcRenderer.invoke('window:apply-position', mountPosition),
  reopenMainWindow: () => ipcRenderer.invoke('window:reopen'),
  openPanelWindow: (panel) => ipcRenderer.invoke('panel:open', panel),
  executeScript: (scriptContent) => ipcRenderer.invoke('execute-script', scriptContent),
  executeScriptOnPort: (scriptContent, targetPort) => ipcRenderer.invoke('execute-script-on-port', scriptContent, targetPort),
  checkPortStatus: () => ipcRenderer.invoke('check-port-status'),
  openScriptsFolder: () => ipcRenderer.invoke('open-scripts-folder'),
  saveScript: (name, content, autoExec = false) => ipcRenderer.invoke('save-script', name, content, autoExec),
  toggleAutoExec: (scriptName, enabled) => ipcRenderer.invoke('toggle-autoexec', scriptName, enabled),
  getLocalScripts: () => ipcRenderer.invoke('get-local-scripts'),
  deleteScript: (scriptName) => ipcRenderer.invoke('delete-script', scriptName),
  renameScript: (oldName, newName) => ipcRenderer.invoke('rename-script', oldName, newName)
});
