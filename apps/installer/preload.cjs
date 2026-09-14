const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nodusInstaller", {
  install: (options) => ipcRenderer.invoke("install", options),
  getSystemInfo: () => ipcRenderer.invoke("system-info"),
  selectInstallDir: () => ipcRenderer.invoke("select-install-dir"),
  openApp: () => ipcRenderer.invoke("open-app"),
  minimize: () => ipcRenderer.invoke("minimize"),
  close: () => ipcRenderer.invoke("close"),
  onProgress(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("progress", listener);
    return () => ipcRenderer.removeListener("progress", listener);
  },
});
