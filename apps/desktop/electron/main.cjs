const { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, ipcMain, nativeImage, powerSaveBlocker, safeStorage, screen, session, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
let tray;
let isQuitting = false;
let trayIdentity = { nodusId: "", deviceName: "Nodus Connect", status: "Online" };
let remoteControlActive = false;
let minimizeToTray = true;
let inputHelper;
let captureOptions = { sourceId: "", displayId: "", shareAudio: true };
let powerSaveBlockerId = -1;

const isDev = process.env.NODUS_DESKTOP_DEV === "1";
const devUrl = process.env.NODUS_DESKTOP_URL || "http://127.0.0.1:5173";
const embeddedServerEnabled = process.env.NODUS_EMBEDDED_SERVER === "1";
const nativeCaptureProbe = app.isPackaged
  ? path.join(process.resourcesPath, "native", "nodus-capture-status.exe")
  : path.join(__dirname, "..", "..", "..", "native", "bin", "nodus-capture-status.exe");
const nativeService = app.isPackaged
  ? path.join(process.resourcesPath, "native", "nodus-service.exe")
  : path.join(__dirname, "..", "..", "..", "native", "bin", "nodus-service.exe");
const firebaseApiKey = process.env.NODUS_FIREBASE_API_KEY || "AIzaSyAN-UMMvnJlNFZ-hiiRvJHuCFzPPVmdR-c";
const firebaseAuthUrl = process.env.NODUS_FIREBASE_AUTH_URL || "https://nodus-connect-kau-2026.web.app/google-login.html";
const startMinimized = process.argv.includes("--minimized");
const userDataDir = process.env.NODUS_USER_DATA_DIR;

app.setName("Nodus Connect");
if (userDataDir) app.setPath("userData", userDataDir);
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
if (process.platform === "win32") app.commandLine.appendSwitch("enable-features", [
  "WebRtcAllowWgcScreenCapturer",
  "WebRtcAllowWgcWindowCapturer",
  "MediaFoundationD3DVideoProcessing",
  "MediaFoundationSharedImageEncode",
].join(","));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.on("second-instance", () => showMainWindow());
app.whenReady().then(() => {
  if (!gotLock) return;
  app.setAppUserModelId("com.nodus.connect");
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media" || permission === "display-capture");
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === "media" || permission === "display-capture");
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }).then((sources) => {
      const source = sources.find((item) => item.id === captureOptions.sourceId) || sources[0];
      captureOptions.displayId = captureOptions.displayId || source?.display_id || "";
      callback({ video: source, ...(captureOptions.shareAudio ? { audio: "loopback" } : {}) });
    }).catch(() => callback({}));
  });
  createMainWindow();
  createTray();
  createMenu();
  setupIpc();
  if (embeddedServerEnabled) startEmbeddedCoordination();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (powerSaveBlockerId >= 0 && powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
  inputHelper?.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    title: "Nodus Connect",
    backgroundColor: "#050811",
    icon: createIcon(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.on("close", (event) => {
    if (isQuitting || !minimizeToTray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url !== "about:blank") return { action: "deny" };
    return {
    action: "allow",
    overrideBrowserWindowOptions: {
      width: 1280,
      height: 820,
      minWidth: 860,
      minHeight: 520,
      title: "Nodus Connect - Acesso remoto",
      backgroundColor: "#050811",
      autoHideMenuBar: true,
      icon: createIcon(),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
    };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppUrl(url)) event.preventDefault();
  });

  mainWindow.once("ready-to-show", () => {
    appendLog("ready-to-show");
    if (!startMinimized) mainWindow.show();
  });

  mainWindow.webContents.on("did-finish-load", () => appendLog(`loaded ${mainWindow.webContents.getURL()}`));
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    appendLog(`did-fail-load ${code} ${description} ${url}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    appendLog(`render-process-gone ${JSON.stringify(details)}`);
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) appendLog(`renderer-console ${message} ${sourceId}:${line}`);
  });

  if (isDev) {
    mainWindow.loadURL(devUrl);
  } else {
    const indexPath = path.resolve(__dirname, "../../../dist/desktop/index.html");
    appendLog(`load-file ${indexPath}`);
    mainWindow.loadURL(pathToFileURL(indexPath).toString()).catch((error) => {
      appendLog(`load-file-error ${error.message}`);
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent("<h1>Nodus Connect</h1><p>Falha ao carregar o aplicativo.</p>")}`);
    });
  }
}

function createTray() {
  tray = new Tray(createIcon());
  tray.setToolTip("Nodus Connect");
  tray.on("click", () => showMainWindow());
  updateTrayMenu();
}

function createMenu() {
  Menu.setApplicationMenu(null);
}

function updateTrayMenu() {
  if (!tray) return;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir Nodus Connect", click: () => showMainWindow() },
      { label: `Status: ${trayIdentity.status}`, enabled: false },
      {
        label: "Copiar Nodus ID",
        enabled: Boolean(trayIdentity.nodusId),
        click: () => clipboard.writeText(trayIdentity.nodusId),
      },
      { label: "Sessoes ativas: 0", enabled: false },
      { type: "separator" },
      { label: "Sair", click: () => quitApp() },
    ]),
  );
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function isAllowedAppUrl(url) {
  if (url === "about:blank") return true;
  if (isDev) return url.startsWith(devUrl);
  return url.startsWith("file:");
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function createIcon() {
  const iconPath = path.resolve(__dirname, "../../../build/icon.ico");
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) return icon;

  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
      <rect width="64" height="64" rx="13" fill="#050811"/>
      <path d="M32 8 56 32 32 56 8 32Z" fill="#07101d" stroke="#6ec5ff" stroke-width="3"/>
      <path d="M19 35 31 25 44 39" fill="none" stroke="#6ec5ff" stroke-width="4" stroke-linecap="round"/>
      <circle cx="19" cy="35" r="5" fill="#25e6ff"/>
      <circle cx="31" cy="25" r="5" fill="#138cff"/>
      <circle cx="44" cy="39" r="5" fill="#6ec5ff"/>
    </svg>
  `);
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${svg}`);
}

function appendLog(message, filename = "desktop.log") {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, filename), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging must never break app startup.
  }
}

require("electron").ipcMain.on("nodus:tray-identity", (_event, identity) => {
  trayIdentity = {
    nodusId: identity?.nodusId || "",
    deviceName: identity?.deviceName || "Nodus Connect",
    status: identity?.status || "Online",
  };
  updateTrayMenu();
});

function setupIpc() {
  ipcMain.handle("nodus:get-identity", () => readJsonFile(identityPath(), null));
  ipcMain.handle("nodus:save-identity", (_event, identity) => {
    const nodusId = String(identity?.nodusId || "").replace(/\D/g, "");
    if (!identity || typeof identity !== "object" || !/^\d{9}$/.test(nodusId) || !String(identity.deviceName || "").trim()) return;
    writeJsonFile(identityPath(), {
      nodusId: nodusId.replace(/(\d{3})(?=\d)/g, "$1 ").trim(),
      deviceName: String(identity.deviceName).trim().slice(0, 120),
      deviceNameConfirmed: Boolean(identity.deviceNameConfirmed),
      createdAt: String(identity.createdAt || new Date().toISOString()),
    });
  });
  ipcMain.handle("nodus:get-server-info", () => getServerInfo());
  ipcMain.handle("nodus:get-app-info", () => ({ version: app.getVersion(), googleClientConfigured: Boolean(firebaseApiKey && firebaseAuthUrl) }));
  ipcMain.handle("nodus:get-native-capture-status", () => getNativeCaptureStatus());
  ipcMain.handle("nodus:get-service-status", () => getServiceStatus());
  ipcMain.handle("nodus:install-service", () => runServiceCommand("--install"));
  ipcMain.handle("nodus:uninstall-service", () => runServiceCommand("--uninstall"));
  ipcMain.handle("nodus:start-service", () => runServiceControl("start"));
  ipcMain.handle("nodus:stop-service", () => runServiceControl("stop"));
  ipcMain.handle("nodus:set-remote-control-active", (_event, active) => {
    remoteControlActive = Boolean(active);
    if (remoteControlActive && powerSaveBlockerId < 0) powerSaveBlockerId = powerSaveBlocker.start("prevent-display-sleep");
    if (!remoteControlActive && powerSaveBlockerId >= 0) {
      if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
      powerSaveBlockerId = -1;
    }
  });
  ipcMain.handle("nodus:set-startup-options", (_event, options) => {
    minimizeToTray = options?.minimizeToTray !== false;
    app.setLoginItemSettings({
      openAtLogin: Boolean(options?.startWithWindows),
      openAsHidden: Boolean(options?.startMinimized),
      args: options?.startMinimized ? ["--minimized"] : [],
    });
  });
  ipcMain.on("nodus:apply-remote-input", (_event, input) => applyRemoteInput(input));
  ipcMain.handle("nodus:get-capture-sources", async () => {
    const displays = screen.getAllDisplays();
    return (await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })).map((source) => {
      const display = displays.find((item) => String(item.id) === source.display_id);
      return { id: source.id, name: source.name, displayId: source.display_id, width: display?.size.width || 0, height: display?.size.height || 0 };
    });
  });
  ipcMain.handle("nodus:set-capture-options", (_event, options) => {
    captureOptions = {
      sourceId: String(options?.sourceId || "").slice(0, 200),
      displayId: String(options?.displayId || "").slice(0, 200),
      shareAudio: Boolean(options?.shareAudio),
    };
  });
  ipcMain.handle("nodus:read-clipboard", () => clipboard.readText());
  ipcMain.handle("nodus:write-clipboard", (_event, text) => clipboard.writeText(String(text || "").slice(0, 1_000_000)));
  ipcMain.handle("nodus:get-connection-password", (_event, nodusId) => getConnectionPassword(nodusId));
  ipcMain.handle("nodus:save-connection-password", (_event, nodusId, password) => saveConnectionPassword(nodusId, password));
  ipcMain.handle("nodus:open-external", (_event, value) => {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") throw new Error("URL externa invalida.");
    return shell.openExternal(url.toString());
  });
  ipcMain.handle("nodus:save-received-file", (_event, payload) => saveReceivedFile(payload));
  ipcMain.handle("nodus:wake-on-lan", (_event, macAddress) => wakeOnLan(macAddress));
  ipcMain.handle("nodus:open-diagnostics", () => shell.showItemInFolder(path.join(app.getPath("userData"), "logs", "desktop.log")));
  ipcMain.handle("nodus:write-diagnostic", (_event, message) => appendLog(String(message || "").slice(0, 2000)));
  ipcMain.handle("nodus:write-performance", (_event, message) => appendLog(String(message || "").slice(0, 2000), "performance.log"));
  ipcMain.handle("nodus:google-login", (_event, options) => googleLogin(options));
}

function getNativeCaptureStatus() {
  if (!fs.existsSync(nativeCaptureProbe)) return { available: false, supported: false, backend: "chromium-getdisplaymedia" };
  try {
    const result = require("node:child_process").execFileSync(nativeCaptureProbe, [], { encoding: "utf8", timeout: 1500, windowsHide: true });
    const capabilities = JSON.parse(result);
    const supported = capabilities.windowsGraphicsCapture === true;
    return {
      available: true,
      supported,
      backend: supported ? "chromium-wgc-mf" : "chromium-dxgi",
      d3d11Hardware: capabilities.d3d11Hardware === true,
      hardwareH264: capabilities.hardwareH264 === true,
      hardwareH264Encoders: Number(capabilities.hardwareH264Encoders || 0),
      adapter: String(capabilities.adapter || "").slice(0, 200),
    };
  } catch {
    return { available: false, supported: false, backend: "chromium-getdisplaymedia" };
  }
}

function getServiceStatus() {
  const result = spawnSync("sc.exe", ["query", "NodusConnectService"], { encoding: "utf8", windowsHide: true });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/RUNNING/i.test(output)) return { installed: true, running: true };
  if (/STOPPED|START_PENDING|STOP_PENDING/i.test(output)) return { installed: true, running: false };
  return { installed: false, running: false };
}

function runServiceCommand(command) {
  if (!app.isPackaged || !fs.existsSync(nativeService)) return { ok: false, error: "Servico nativo indisponivel nesta versao." };
  const appPath = process.execPath;
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const args = command === "--install" ? `@(${quote(command)}, ${quote(appPath)})` : `@(${quote(command)})`;
  const script = `$p = Start-Process -FilePath ${quote(nativeService)} -ArgumentList ${args} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? { ok: true } : { ok: false, error: "Nao foi possivel alterar o servico do Windows." };
}

function runServiceControl(command) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const script = `$p = Start-Process -FilePath ${quote("sc.exe")} -ArgumentList @(${quote(command)}, ${quote("NodusConnectService")}) -Verb RunAs -Wait -PassThru; exit $p.ExitCode`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? { ok: true } : { ok: false, error: "Nao foi possivel alterar o estado do servico." };
}

function wakeOnLan(macAddress) {
  return new Promise((resolve) => {
    const normalized = String(macAddress || "").replace(/[^0-9a-f]/gi, "");
    if (normalized.length !== 12) return resolve({ ok: false, error: "Endereco do computador invalido." });
    const mac = Buffer.from(normalized, "hex");
    const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => mac)]);
    const socket = dgram.createSocket("udp4");
    socket.once("error", () => { socket.close(); resolve({ ok: false, error: "Nao foi possivel enviar o sinal." }); });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 9, "255.255.255.255", (error) => {
        socket.close();
        resolve(error ? { ok: false, error: "Nao foi possivel enviar o sinal." } : { ok: true });
      });
    });
  });
}

function getServerInfo() {
  if (!embeddedServerEnabled) return { port: 8787, urls: [] };
  const urls = Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:8787`);
  return { port: 8787, urls };
}

function identityPath() {
  return path.join(app.getPath("userData"), "identity.json");
}

function connectionPasswordsPath() {
  return path.join(app.getPath("userData"), "connection-passwords.json");
}

function getConnectionPassword(value) {
  const nodusId = String(value || "").replace(/\D/g, "");
  if (!/^\d{9}$/.test(nodusId) || !safeStorage.isEncryptionAvailable()) return "";
  try {
    const encrypted = readJsonFile(connectionPasswordsPath(), {})[nodusId];
    return encrypted ? safeStorage.decryptString(Buffer.from(encrypted, "base64")) : "";
  } catch {
    return "";
  }
}

function saveConnectionPassword(value, password) {
  const nodusId = String(value || "").replace(/\D/g, "");
  if (!/^\d{9}$/.test(nodusId) || !safeStorage.isEncryptionAvailable()) return { ok: false };
  const saved = readJsonFile(connectionPasswordsPath(), {});
  if (!password) delete saved[nodusId];
  else saved[nodusId] = safeStorage.encryptString(String(password).slice(0, 512)).toString("base64");
  writeJsonFile(connectionPasswordsPath(), saved);
  return { ok: true };
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function saveReceivedFile(payload) {
  const data = payload?.data;
  const buffer = data instanceof ArrayBuffer
    ? Buffer.from(data)
    : ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : null;
  if (!buffer || buffer.byteLength > 256 * 1024 * 1024) return { ok: false, error: "INVALID_FILE" };
  let original = path.basename(String(payload?.fileName || "arquivo")).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/, "").slice(0, 180) || "arquivo";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(original)) original = `_${original}`;
  const parsed = path.parse(original);
  const documents = app.getPath("documents");
  await fs.promises.mkdir(documents, { recursive: true });
  let destination = "";
  for (let index = 0; index < 10_000; index++) {
    const candidate = path.join(documents, index ? `${parsed.name} (${index})${parsed.ext}` : original);
    try {
      await fs.promises.writeFile(candidate, buffer, { flag: "wx" });
      destination = candidate;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  if (!destination) return { ok: false, error: "FILE_NAME_EXHAUSTED" };
  appendLog(`file-received name=${path.basename(destination)} bytes=${buffer.byteLength}`);
  return { ok: true, path: destination, name: path.basename(destination) };
}

function applyRemoteInput(input) {
  if (!remoteControlActive) return { ok: false, error: "REMOTE_CONTROL_DISABLED" };
  try {
    const display = screen.getAllDisplays().find((item) => String(item.id) === captureOptions.displayId) || screen.getPrimaryDisplay();
    const bounds = display.bounds;
    const message = normalizeRemoteInput(input, bounds);
    if (!message) return { ok: false, error: "INVALID_INPUT" };
    const helper = ensureInputHelper();
    if (message.type === "mouseMove" && helper.stdin.writableLength > 64) return { ok: true };
    helper.stdin.write(helper.nodusBinaryInput ? encodeRemoteInput(message) : `${JSON.stringify(message)}\n`);
    return { ok: true };
  } catch (error) {
    appendLog(`remote-input-error ${error.message}`);
    return { ok: false, error: error.message };
  }
}

function encodeRemoteInput(input) {
  const packet = Buffer.allocUnsafe(16);
  const type = { mouseMove: 1, mouseDown: 2, mouseUp: 3, wheel: 4, keyDown: 5, keyUp: 6 }[input.type] || 0;
  const button = input.button === "right" ? 2 : input.button === "middle" ? 1 : 0;
  packet.writeUInt8(type, 0);
  packet.writeUInt8(button, 1);
  packet.writeUInt16LE(input.keyCode || 0, 2);
  packet.writeInt32LE(input.x || 0, 4);
  packet.writeInt32LE(input.y || 0, 8);
  packet.writeInt32LE(input.delta || 0, 12);
  return packet;
}

function normalizeRemoteInput(input, bounds) {
  if (!input || typeof input !== "object") return null;
  if (input.type === "mouseMove") {
    return {
      type: "mouseMove",
      x: Math.round(bounds.x + clamp(Number(input.x)) * bounds.width),
      y: Math.round(bounds.y + clamp(Number(input.y)) * bounds.height),
    };
  }
  if (input.type === "mouseDown" || input.type === "mouseUp") {
    return {
      type: input.type,
      button: input.button === 2 ? "right" : input.button === 1 ? "middle" : "left",
      x: Math.round(bounds.x + clamp(Number(input.x)) * bounds.width),
      y: Math.round(bounds.y + clamp(Number(input.y)) * bounds.height),
    };
  }
  if (input.type === "wheel") return { type: "wheel", delta: Math.max(-1200, Math.min(1200, Number(input.delta) || 0)) };
  if (input.type === "keyDown" || input.type === "keyUp") {
    const keyCode = Number(input.keyCode);
    return keyCode > 0 && keyCode < 256 ? { type: input.type, keyCode } : null;
  }
  return null;
}

function ensureInputHelper() {
  if (inputHelper && !inputHelper.killed) return inputHelper;
  if (fs.existsSync(nativeService)) {
    inputHelper = spawn(nativeService, ["--input-helper"], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    inputHelper.nodusBinaryInput = true;
    inputHelper.on("exit", () => { inputHelper = null; });
    return inputHelper;
  }
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NodusInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
$map = @{ left=@(0x0002,0x0004); right=@(0x0008,0x0010); middle=@(0x0020,0x0040) }
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $m = $line | ConvertFrom-Json
    if ($m.type -eq "mouseMove") { [NodusInput]::SetCursorPos([int]$m.x, [int]$m.y) | Out-Null }
    elseif ($m.type -eq "mouseDown") { $b = $map[$m.button]; [NodusInput]::mouse_event([uint32]$b[0], 0, 0, 0, [UIntPtr]::Zero) }
    elseif ($m.type -eq "mouseUp") { $b = $map[$m.button]; [NodusInput]::mouse_event([uint32]$b[1], 0, 0, 0, [UIntPtr]::Zero) }
    elseif ($m.type -eq "wheel") { [NodusInput]::mouse_event(0x0800, 0, 0, [int]$m.delta, [UIntPtr]::Zero) }
    elseif ($m.type -eq "keyDown") { [NodusInput]::keybd_event([byte]$m.keyCode, 0, 0, [UIntPtr]::Zero) }
    elseif ($m.type -eq "keyUp") { [NodusInput]::keybd_event([byte]$m.keyCode, 0, 2, [UIntPtr]::Zero) }
  } catch {}
}
`;
  inputHelper = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  inputHelper.on("exit", () => {
    inputHelper = null;
  });
  return inputHelper;
}

function clamp(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

async function googleLogin() {
  if (!firebaseApiKey || !firebaseAuthUrl) {
    return { ok: false, error: "Entrada com Google indisponivel neste computador." };
  }
  return googleWebLogin();
}

async function googleWebLogin() {
  const state = base64Url(crypto.randomBytes(24));

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      server.close();
      resolve(result);
    };
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== "/google-web-result") return response.end("Nodus Connect");

      try {
        if (url.searchParams.get("state") !== state) throw new Error("Nao foi possivel confirmar a entrada pelo Google.");
        const googleError = url.searchParams.get("error");
        if (googleError) throw new Error(url.searchParams.get("message") || googleError);
        const firebaseToken = url.searchParams.get("firebase_id_token");
        if (!firebaseToken) throw new Error("O Firebase nao retornou sua conta.");
        const profile = await verifyFirebaseAuthToken(firebaseToken);
        const result = firebaseProfileResult(profile, {
          accessToken: url.searchParams.get("access_token") || undefined,
          idToken: url.searchParams.get("google_id_token") || undefined,
        });
        emitGoogleLoginResult(result);
        response.end(renderGoogleLoginPage(true, "Entrada concluida", "Pode voltar para o Nodus Connect. Sua conta ja foi reconhecida."));
        showMainWindow();
        finish(result);
      } catch (error) {
        const result = { ok: false, error: error.message || "Nao foi possivel entrar com Google." };
        emitGoogleLoginResult(result);
        response.end(renderGoogleLoginPage(false, "Entrada nao concluida", result.error));
        showMainWindow();
        finish(result);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const returnTo = `http://127.0.0.1:${server.address().port}/google-web-result`;
      const authUrl = new URL(firebaseAuthUrl);
      authUrl.searchParams.set("return_to", returnTo);
      authUrl.searchParams.set("state", state);
      shell.openExternal(authUrl.toString());
    });

    server.on("error", () => finish({ ok: false, error: "Nao foi possivel abrir a entrada pelo Google." }));
    const timeout = setTimeout(() => finish({ ok: false, error: "Tempo esgotado. Tente entrar com Google novamente." }), 120_000);
    server.on("close", () => clearTimeout(timeout));
  });
}

async function verifyFirebaseAuthToken(firebaseToken) {
  const tokenResponse = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idToken: firebaseToken }),
  });
  const data = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok) throw new Error(data.error?.message || "Nao foi possivel confirmar sua conta.");
  const profile = data.users?.[0];
  if (!profile?.localId) throw new Error("Conta nao reconhecida pelo Firebase.");
  return profile;
}

function firebaseProfileResult(profile, tokens) {
  return {
    ok: true,
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    user: {
      id: profile.localId,
      name: profile.displayName || profile.email || "Usuario Google",
      email: profile.email,
      picture: profile.photoUrl,
      provider: "google",
      loggedAt: new Date().toISOString(),
    },
  };
}

function emitGoogleLoginResult(result) {
  mainWindow?.webContents.send("nodus:google-login-result", result);
  mainWindow?.webContents
    .executeJavaScript(`window.dispatchEvent(new CustomEvent("nodus-google-login-result",{detail:${JSON.stringify(result)}}))`)
    .catch(() => undefined);
}

function renderGoogleLoginPage(ok, title, message, script = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Nodus Connect</title><style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050811;color:#f4f8ff;font-family:Inter,Segoe UI,Arial,sans-serif}
    body:before{content:"";position:fixed;inset:0;background:linear-gradient(115deg,rgba(20,145,255,.2),transparent 52%),radial-gradient(circle at 75% 35%,rgba(37,230,255,.18),transparent 32%);pointer-events:none}
    .card{position:relative;width:min(460px,calc(100vw - 36px));padding:28px;border:1px solid rgba(75,160,255,.28);border-radius:18px;background:rgba(6,12,24,.86);box-shadow:0 24px 80px rgba(0,0,0,.42)}
    .mark{width:46px;height:46px;display:grid;place-items:center;border:1px solid #2d9bff;border-radius:12px;color:#25e6ff;font-weight:900;margin-bottom:18px}
    .pill{display:inline-flex;gap:8px;align-items:center;color:${ok ? "#25e6ff" : "#ff9aac"};font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.12em}
    .pill:before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 14px currentColor}
    h1{margin:10px 0 8px;font-size:28px}p{margin:0;color:#9fb0c7;line-height:1.5}.hint{margin-top:18px;color:#58b7ff;font-weight:800}
  </style></head><body><main class="card"><div class="mark">N</div><span class="pill">${ok ? "Deu certo" : "Nao deu certo"}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p class="hint">Esta aba pode ser fechada.</p></main><script>${script || (ok ? "setTimeout(function(){window.close()},1200)" : "")}</script></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function base64Url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function startEmbeddedCoordination() {
  const records = new Map();
  const requests = new Map();
  const signals = new Map();
  let seq = 0;

  const server = http.createServer(async (request, response) => {
    setCors(response);
    if (request.method === "OPTIONS") return send(response, 204);

    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, service: "nodus-embedded" });
      if (request.method === "PUT" && url.pathname === "/v1/presence") {
        const body = await readBody(request);
        const nodusId = normalizeId(body.nodusId);
        const record = { nodusId, deviceName: String(body.deviceName || "Dispositivo"), status: "online", updatedAt: new Date().toISOString(), capabilities: body.capabilities || [] };
        records.set(nodusId, record);
        return json(response, 200, record);
      }
      const heartbeat = url.pathname.match(/^\/v1\/presence\/(\d{9})\/heartbeat$/);
      if (request.method === "POST" && heartbeat) return json(response, 200, records.get(heartbeat[1]) || { nodusId: heartbeat[1], status: "online" });
      const device = url.pathname.match(/^\/v1\/devices\/(\d{9})$/);
      if (request.method === "GET" && device) return records.has(device[1]) ? json(response, 200, records.get(device[1])) : json(response, 404, { error: "DEVICE_NOT_FOUND" });
      if (request.method === "POST" && url.pathname === "/v1/session-requests") {
        const body = await readBody(request);
        const id = crypto.randomUUID();
        const item = { id, requesterNodusId: normalizeId(body.requesterNodusId), requesterName: body.requesterName, targetNodusId: normalizeId(body.targetNodusId), requestedPermissions: body.requestedPermissions || ["screen:view"], preferredResolution: body.preferredResolution, preferredFps: body.preferredFps, status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        requests.set(id, item);
        return json(response, 201, item);
      }
      const pending = url.pathname.match(/^\/v1\/session-requests\/target\/(\d{9})$/);
      if (request.method === "GET" && pending) return json(response, 200, [...requests.values()].filter((item) => item.targetNodusId === pending[1] && item.status === "pending"));
      const req = url.pathname.match(/^\/v1\/session-requests\/([0-9a-f-]+)$/);
      if (request.method === "GET" && req) return requests.has(req[1]) ? json(response, 200, requests.get(req[1])) : json(response, 404, { error: "REQUEST_NOT_FOUND" });
      const accept = url.pathname.match(/^\/v1\/session-requests\/([0-9a-f-]+)\/accept$/);
      if (request.method === "POST" && accept) {
        const body = await readBody(request);
        const current = requests.get(accept[1]);
        const next = { ...current, sessionId: current.sessionId || crypto.randomUUID(), targetName: body.targetName, grantedPermissions: body.grantedPermissions || ["screen:view"], status: "accepted", updatedAt: new Date().toISOString() };
        requests.set(accept[1], next);
        return json(response, 200, next);
      }
      const deny = url.pathname.match(/^\/v1\/session-requests\/([0-9a-f-]+)\/deny$/);
      if (request.method === "POST" && deny) {
        const next = { ...requests.get(deny[1]), status: "denied", updatedAt: new Date().toISOString() };
        requests.set(deny[1], next);
        return json(response, 200, next);
      }
      const signal = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/signals$/);
      if (signal && request.method === "POST") {
        const body = await readBody(request);
        const item = { ...body, sessionId: signal[1], seq: ++seq, createdAt: new Date().toISOString() };
        signals.set(signal[1], [...(signals.get(signal[1]) || []), item].slice(-200));
        return json(response, 201, item);
      }
      if (signal && request.method === "GET") {
        const to = normalizeId(url.searchParams.get("to"));
        const after = Number(url.searchParams.get("after")) || 0;
        return json(response, 200, (signals.get(signal[1]) || []).filter((item) => item.to === to && item.seq > after));
      }
      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      return json(response, 500, { error: error.message || "INTERNAL_ERROR" });
    }
  });

  server.listen(8787, "0.0.0.0", () => appendLog("embedded-coordination http://0.0.0.0:8787"));
  server.on("error", (error) => appendLog(`embedded-coordination-error ${error.message}`));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function normalizeId(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 9) throw new Error("INVALID_NODUS_ID");
  return digits;
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,PUT,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function send(response, status, body = "") {
  response.writeHead(status);
  response.end(body);
}

function json(response, status, body) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  send(response, status, JSON.stringify(body));
}
