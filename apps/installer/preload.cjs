const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nodusInstaller", {
  install: (options) => ipcRenderer.invoke("install", options),
  cancelInstall: () => ipcRenderer.invoke("cancel-install"),
  uninstall: (options) => ipcRenderer.invoke("uninstall", options),
  getSystemInfo: () => ipcRenderer.invoke("system-info"),
  markUiReady: () => ipcRenderer.send("ui-ready"),
  selectInstallDir: () => ipcRenderer.invoke("select-install-dir"),
  openApp: () => ipcRenderer.invoke("open-app"),
  setDesktopShortcut: (enabled) => ipcRenderer.invoke("set-desktop-shortcut", enabled),
  minimize: () => ipcRenderer.invoke("minimize"),
  close: () => ipcRenderer.invoke("close"),
  onProgress(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("progress", listener);
    return () => ipcRenderer.removeListener("progress", listener);
  },
  onCancelRequested(callback) {
    const listener = () => callback();
    ipcRenderer.on("cancel-requested", listener);
    return () => ipcRenderer.removeListener("cancel-requested", listener);
  },
});
