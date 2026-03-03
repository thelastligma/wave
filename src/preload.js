
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openEditor: () => ipcRenderer.send("open-editor"),
  openTab: (tabKey) => ipcRenderer.invoke("toggle-tab", tabKey),
  killWave: () => ipcRenderer.invoke("kill-wave"),
  setTopMost: (enabled) => ipcRenderer.invoke("set-top-most", enabled),
  setBarMode: (mode) => ipcRenderer.invoke("set-bar-mode", mode),
  macAttach: (port) => ipcRenderer.invoke("macsploit-attach", port),
  macDetach: () => ipcRenderer.invoke("macsploit-detach"),
  macExecute: (script) => ipcRenderer.invoke("macsploit-execute", script),
  macUpdateSetting: (key, value) => ipcRenderer.invoke("macsploit-setting", key, value),
  macStatus: () => ipcRenderer.invoke("macsploit-status"),
  onMacMessage: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("macsploit-message", handler);
    return () => ipcRenderer.removeListener("macsploit-message", handler);
  },
  onMacError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("macsploit-error", handler);
    return () => ipcRenderer.removeListener("macsploit-error", handler);
  },
  onMacClose: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("macsploit-close", handler);
    return () => ipcRenderer.removeListener("macsploit-close", handler);
  },
  onMacStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("macsploit-status", handler);
    return () => ipcRenderer.removeListener("macsploit-status", handler);
  }
});
