const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nodusDesktop", {
  setTrayIdentity(identity) {
    ipcRenderer.send("nodus:tray-identity", identity);
  },
  getIdentity() {
    return ipcRenderer.invoke("nodus:get-identity");
  },
  saveIdentity(identity) {
    return ipcRenderer.invoke("nodus:save-identity", identity);
  },
  getServerInfo() {
    return ipcRenderer.invoke("nodus:get-server-info");
  },
  getAppInfo() {
    return ipcRenderer.invoke("nodus:get-app-info");
  },
  getNativeCaptureStatus() {
    return ipcRenderer.invoke("nodus:get-native-capture-status");
  },
  getServiceStatus() {
    return ipcRenderer.invoke("nodus:get-service-status");
  },
  installService() {
    return ipcRenderer.invoke("nodus:install-service");
  },
  uninstallService() {
    return ipcRenderer.invoke("nodus:uninstall-service");
  },
  startService() {
    return ipcRenderer.invoke("nodus:start-service");
  },
  stopService() {
    return ipcRenderer.invoke("nodus:stop-service");
  },
  setRemoteControlActive(active) {
    return ipcRenderer.invoke("nodus:set-remote-control-active", Boolean(active));
  },
  setStartupOptions(options) {
    return ipcRenderer.invoke("nodus:set-startup-options", options);
  },
  applyRemoteInput(input) {
    ipcRenderer.send("nodus:apply-remote-input", input);
  },
  getCaptureSources() {
    return ipcRenderer.invoke("nodus:get-capture-sources");
  },
  setCaptureOptions(options) {
    return ipcRenderer.invoke("nodus:set-capture-options", options);
  },
  readClipboard() {
    return ipcRenderer.invoke("nodus:read-clipboard");
  },
  writeClipboard(text) {
    return ipcRenderer.invoke("nodus:write-clipboard", text);
  },
  getConnectionPassword(nodusId) {
    return ipcRenderer.invoke("nodus:get-connection-password", nodusId);
  },
  saveConnectionPassword(nodusId, password) {
    return ipcRenderer.invoke("nodus:save-connection-password", nodusId, password);
  },
  openExternal(url) {
    return ipcRenderer.invoke("nodus:open-external", url);
  },
  saveReceivedFile(fileName, data) {
    return ipcRenderer.invoke("nodus:save-received-file", { fileName, data });
  },
  wakeOnLan(macAddress) {
    return ipcRenderer.invoke("nodus:wake-on-lan", macAddress);
  },
  openDiagnostics() {
    return ipcRenderer.invoke("nodus:open-diagnostics");
  },
  writeDiagnostic(message) {
    return ipcRenderer.invoke("nodus:write-diagnostic", message);
  },
  writePerformance(message) {
    return ipcRenderer.invoke("nodus:write-performance", message);
  },
  googleLogin(options) {
    return ipcRenderer.invoke("nodus:google-login", options);
  },
  onGoogleLoginResult(callback) {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("nodus:google-login-result", listener);
    return () => ipcRenderer.removeListener("nodus:google-login-result", listener);
  },
});
