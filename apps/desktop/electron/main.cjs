const { app, BrowserWindow, Menu, Tray, clipboard, desktopCapturer, ipcMain, nativeImage, powerSaveBlocker, safeStorage, screen, session, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createDeviceIdentityStore } = require("./device-identity.cjs");
const { createLogWriter } = require("./log-writer.cjs");
const { RemoteCursorVisibility } = require("./remote-cursor-visibility.cjs");
const { RemoteWindowsKeys } = require("./remote-windows-keys.cjs");

let mainWindow;
let tray;
let themedIcon;
let isQuitting = false;
let trayIdentity = { nodusId: "", deviceName: "Nodus Connect", status: "Online" };
let remoteControlActive = false;
let remoteKeyboardCaptureActive = false;
let remoteKeyboardCaptureWebContentsId = 0;
let lastSecureAttentionAt = 0;
let minimizeToTray = true;
let inputHelper;
let inputProbeSequence = 0;
const inputProbes = new Map();
let inputLockHelper;
let inputLockHeartbeat;
const inputLocks = new Map();
let captureOptions = { sourceId: "", displayId: "", shareAudio: true };
let powerSaveBlockerId = -1;
let gpuInfoReady = false;
let deviceIdentityStore;
const nativeMedia = new Map();
const logWriter = createLogWriter(() => path.join(app.getPath("userData"), "logs"));

const isDev = process.env.NODUS_DESKTOP_DEV === "1";
const devUrl = process.env.NODUS_DESKTOP_URL || "http://127.0.0.1:5173";
const embeddedServerEnabled = process.env.NODUS_EMBEDDED_SERVER === "1";
const nativeCaptureProbe = app.isPackaged
  ? path.join(process.resourcesPath, "native", "nodus-capture-status.exe")
  : path.join(__dirname, "..", "..", "..", "native", "bin", "nodus-capture-status.exe");
const nativeService = app.isPackaged
  ? path.join(process.resourcesPath, "native", "nodus-service.exe")
  : path.join(__dirname, "..", "..", "..", "native", "bin", "nodus-service.exe");
const hostCursorVisibility = process.platform === "win32"
  ? new RemoteCursorVisibility({
      spawn,
      executable: nativeService,
      log: (message) => appendLog(message),
      onHostMouseActivity: () => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("nodus:host-mouse-activity");
      },
    })
  : null;
const remoteWindowsKeys = process.platform === "win32"
  ? new RemoteWindowsKeys({ spawn, executable: nativeService, log: (message) => appendLog(message) }) : null;
const nativeMediaExe = app.isPackaged
  ? path.join(process.resourcesPath, "native", "nodus-wgc-media.exe")
  : path.join(__dirname, "..", "..", "..", "native", "bin", "nodus-wgc-media.exe");
const gstreamerRoot = app.isPackaged
  ? path.join(process.resourcesPath, "native", "gstreamer")
  : path.join(__dirname, "..", "..", "..", "work", "gstreamer-runtime-package");
const firebaseApiKey = process.env.NODUS_FIREBASE_API_KEY || "AIzaSyAN-UMMvnJlNFZ-hiiRvJHuCFzPPVmdR-c";
const firebaseAuthUrl = process.env.NODUS_FIREBASE_AUTH_URL || "https://nodus-connect-kau-2026.web.app/google-login.html";
const startMinimized = process.argv.includes("--minimized");
const userDataDir = process.env.NODUS_USER_DATA_DIR;
const extendedKeyboardCodes = new Set(["AltRight", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ContextMenu", "ControlRight", "Delete", "End", "Home", "Insert", "MetaLeft", "MetaRight", "NumpadDivide", "NumpadEnter", "PageDown", "PageUp", "PrintScreen"]);
const diagnosticPresets = {
  "1080p60": { label: "capture-1080p60", resolution: "1920x1080", fps: 60, bitrate: 14_000_000, maxFramerate: 60, scaleResolutionDownBy: 1, lockAdaptive: true },
  "720p60": { label: "capture-720p60", resolution: "1280x720", fps: 60, bitrate: 10_000_000, maxFramerate: 60, scaleResolutionDownBy: 1, lockAdaptive: true },
  "1080p30": { label: "capture-1080p30", resolution: "1920x1080", fps: 30, bitrate: 14_000_000, maxFramerate: 30, scaleResolutionDownBy: 1, lockAdaptive: true },
  "pixel-perfect-1080p60": { label: "pixel-perfect-1080p60", resolution: "1920x1080", fps: 60, bitrate: 14_000_000, maxFramerate: 60, scaleResolutionDownBy: 1, lockAdaptive: true, nativeResolution: true, contentHint: "detail", degradationPreference: "maintain-resolution" },
  "clean-desktop": { label: "clean-desktop", fps: 60, maxFramerate: 60, scaleResolutionDownBy: 1, nativeResolution: true, contentHint: "detail", degradationPreference: "maintain-resolution" },
};
const performanceDiagnostic = getPerformanceDiagnostic();

app.setName("Nodus Connect");
app.setAppUserModelId("com.nodus.connect.desktop");
app.on("gpu-info-update", () => { gpuInfoReady = true; });
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

app.on("second-instance", (_event, commandLine) => {
  const preset = getDiagnosticPresetArgument(commandLine);
  if (preset) {
    const event = { event: "diagnostic-preset-rejected", preset, reason: "APP_ALREADY_RUNNING" };
    console.error(`[NODUS BENCHMARK] Preset rejected: ${event.reason}`);
    appendLog(JSON.stringify(event), "performance.log");
  }
  showMainWindow();
  if (!preset && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("nodus:open-workspace");
});

function attachRemoteKeyboardForwarding(window) {
  const contents = window.webContents;
  const contentId = contents.id;
  const release = () => {
    remoteWindowsKeys?.stop(window);
    if (!contents.isDestroyed()) contents.setIgnoreMenuShortcuts(false);
    if (remoteKeyboardCaptureWebContentsId === contentId) {
      remoteKeyboardCaptureActive = false;
      remoteKeyboardCaptureWebContentsId = 0;
    }
  };
  window.on("blur", release);
  window.on("closed", release);
  contents.on("render-process-gone", release);
  contents.on("before-input-event", (event, input) => {
    if (!remoteKeyboardCaptureActive || remoteKeyboardCaptureWebContentsId !== contentId || contents.isDestroyed() || (input.type !== "keyDown" && input.type !== "keyUp")) return;
    const remoteInput = toRemoteKeyboardInput(input);
    if (!remoteInput) return;
    // Cancelling keyDown here also suppresses keyUp in Chromium.
    if (input.type === "keyUp") event.preventDefault();
    contents.send("nodus:remote-key-input", input.type, remoteInput);
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  logDiagnosticPresetActivation(performanceDiagnostic);
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
  stopNativeMediaForOwner(null, true);
  hostCursorVisibility?.dispose();
  remoteWindowsKeys?.dispose();
  clearInputLocks();
  setRemoteControlActive(false);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function createMainWindow() {
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1180, workWidth),
    height: Math.min(760, workHeight),
    minWidth: Math.min(820, workWidth),
    minHeight: Math.min(560, workHeight),
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
  const mainWebContentsId = mainWindow.webContents.id;
  const releaseRendererResources = () => {
    setRemoteControlActive(false);
    hostCursorVisibility?.setActive(false);
    stopNativeMediaForOwner(mainWebContentsId, true);
  };
  mainWindow.webContents.on("render-process-gone", releaseRendererResources);
  mainWindow.webContents.on("destroyed", releaseRendererResources);
  mainWindow.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame && !_inPlace) releaseRendererResources();
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
        preload: path.join(__dirname, "preload.cjs"),
        sandbox: true,
      },
    },
    };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppUrl(url)) event.preventDefault();
  });

  mainWindow.webContents.on("did-create-window", (window) => {
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    attachRemoteKeyboardForwarding(window);
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
  attachRemoteKeyboardForwarding(mainWindow);

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
  try {
    const expected = new URL(isDev ? devUrl : pathToFileURL(path.resolve(__dirname, "../../../dist/desktop/index.html")).toString());
    const candidate = new URL(url);
    return candidate.protocol === expected.protocol && candidate.host === expected.host && candidate.pathname === expected.pathname;
  } catch { return false; }
}

function isMainAppSender(event) {
  return event.sender === mainWindow?.webContents && isAllowedAppUrl(event.sender.getURL());
}

function setRemoteControlActive(active) {
  remoteControlActive = Boolean(active);
  if (!remoteControlActive) {
    clearInputLocks();
    const helper = inputHelper;
    inputHelper = null;
    if (helper) { clearTimeout(helper.nodusMoveTimer); helper.nodusPendingMove = null; }
    if (helper?.stdin.writable) helper.stdin.end();
  }
  if (remoteControlActive && powerSaveBlockerId < 0) powerSaveBlockerId = powerSaveBlocker.start("prevent-display-sleep");
  if (!remoteControlActive && powerSaveBlockerId >= 0) {
    if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
    powerSaveBlockerId = -1;
  }
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function createIcon() {
  if (themedIcon) return themedIcon;
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
  return logWriter.append(message, filename);
}

function getDiagnosticPresetArgument(argv = process.argv) {
  const prefix = "--diagnostic-preset=";
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

function getPerformanceDiagnostic() {
  try {
    const cliPreset = getDiagnosticPresetArgument();
    const envPreset = process.env.NODUS_DIAGNOSTIC_1080P60 === "1" ? "1080p60"
      : process.env.NODUS_DIAGNOSTIC_720P60 === "1" ? "720p60"
        : process.env.NODUS_DIAGNOSTIC_1080P30 === "1" ? "1080p30"
          : process.env.NODUS_DIAGNOSTIC_PRESET || "";
    const preset = cliPreset || envPreset;
    const configured = diagnosticPresets[preset] || JSON.parse(process.env.NODUS_PERF_DIAGNOSTIC || "null");
    const inputLatency = process.env.NODUS_INPUT_DIAGNOSTIC === "1" || process.argv.includes("--diagnostic-input");
    const videoOnly = process.env.NODUS_VIDEO_ONLY_DIAGNOSTIC === "1";
    if ((!configured || typeof configured !== "object") && !videoOnly && !inputLatency) return null;
    const input = configured && typeof configured === "object" ? configured : {};
    const bounded = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
    const dimensions = typeof input.resolution === "string" ? input.resolution.match(/^(\d{3,4})x(\d{3,4})$/) : null;
    const resolution = dimensions && bounded(Number(dimensions[1]), 640, 3840) && bounded(Number(dimensions[2]), 480, 2160) ? input.resolution : undefined;
    return {
      label: String(input.label || "diagnostic").slice(0, 60), preset: diagnosticPresets[preset] ? preset : null,
      source: cliPreset || process.argv.includes("--diagnostic-input") ? "cli" : envPreset || inputLatency ? "env" : "json", videoOnly, inputLatency,
      inputOnly: inputLatency && !configured && !videoOnly, resolution,
      fps: bounded(input.fps, 15, 120), bitrate: bounded(input.bitrate, 300_000, 30_000_000),
      maxFramerate: bounded(input.maxFramerate, 15, 120), scaleResolutionDownBy: bounded(input.scaleResolutionDownBy, 1, 4),
      lockAdaptive: input.lockAdaptive === true,
      nativeResolution: input.nativeResolution === true,
      contentHint: input.contentHint === "detail" || input.contentHint === "motion" ? input.contentHint : undefined,
      degradationPreference: input.degradationPreference === "maintain-resolution" || input.degradationPreference === "maintain-framerate" ? input.degradationPreference : undefined,
    };
  } catch { return null; }
}

function logDiagnosticPresetActivation(diagnostic) {
  if (!diagnostic?.preset) return;
  const [requestedWidth, requestedHeight] = diagnostic.resolution?.split("x").map(Number) ?? [null, null];
  const event = {
    event: "diagnostic-preset-activated", preset: diagnostic.preset, source: diagnostic.source,
    requestedWidth, requestedHeight, requestedFps: diagnostic.fps, maxFramerate: diagnostic.maxFramerate,
    bitrateKbps: diagnostic.bitrate ? Math.round(diagnostic.bitrate / 1000) : null, scaleResolutionDownBy: diagnostic.scaleResolutionDownBy,
    adaptiveLocked: diagnostic.lockAdaptive, nativeResolution: diagnostic.nativeResolution, contentHint: diagnostic.contentHint ?? null, degradationPreference: diagnostic.degradationPreference ?? null,
  };
  console.info(`[NODUS BENCHMARK]\nPreset: ${event.preset}\nResolution: ${diagnostic.resolution ?? "native"}\nFPS: ${event.requestedFps}\nBitrate: ${event.bitrateKbps ? `${event.bitrateKbps / 1000} Mbps` : "adaptive"}\nAdaptive: ${event.adaptiveLocked ? "LOCKED" : "UNLOCKED"}`);
  appendLog(JSON.stringify(event), "performance.log");
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
  ipcMain.handle("nodus:get-identity", (_event, legacyIdentity) => identityStore().loadOrCreate(legacyIdentity));
  ipcMain.handle("nodus:save-identity", (_event, identity) => identityStore().updateMutable(identity));
  ipcMain.handle("nodus:get-license-credentials", (event) => licenseCredentials(event));
  ipcMain.handle("nodus:save-license-credentials", (event, value) => licenseCredentials(event, value));
  ipcMain.handle("nodus:get-server-info", () => getServerInfo());
  ipcMain.handle("nodus:get-app-info", () => ({ version: app.getVersion(), googleClientConfigured: Boolean(firebaseApiKey && firebaseAuthUrl) }));
  ipcMain.handle("nodus:set-theme-icon", (_event, theme, dataUrl) => {
    if (!["dark", "japan", "sakura-night", "neo-tokyo", "cosmos", "arctic"].includes(theme)
      || typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,") || dataUrl.length > 500_000) return false;
    try {
      const icon = nativeImage.createFromDataURL(dataUrl);
      const size = icon.getSize();
      if (icon.isEmpty() || size.width !== 256 || size.height !== 256) return false;
      themedIcon = icon;
      BrowserWindow.getAllWindows().forEach((window) => window.setIcon(icon));
      tray?.setImage(icon.resize({ width: 32, height: 32 }));
      return true;
    } catch { return false; }
  });
  ipcMain.handle("nodus:get-performance-diagnostic", () => {
    return performanceDiagnostic;
  });
  ipcMain.handle("nodus:get-native-capture-status", () => getNativeCaptureStatus());
  ipcMain.handle("nodus:start-native-media", (event, input) => startNativeMedia(event.sender, input));
  ipcMain.handle("nodus:signal-native-media", (event, input) => signalNativeMedia(event.sender, input));
  ipcMain.handle("nodus:stop-native-media", (event, sessionId) => stopNativeMedia(event.sender, sessionId));
  ipcMain.handle("nodus:get-service-status", () => getServiceStatus());
  ipcMain.handle("nodus:install-service", () => runServiceCommand("--install"));
  ipcMain.handle("nodus:uninstall-service", () => runServiceCommand("--uninstall"));
  ipcMain.handle("nodus:start-service", () => runServiceControl("start"));
  ipcMain.handle("nodus:stop-service", () => runServiceControl("stop"));
  ipcMain.handle("nodus:set-remote-control-active", (event, active) => {
    if (isMainAppSender(event)) setRemoteControlActive(active === true);
  });
  ipcMain.handle("nodus:set-host-input-lock", (event, input) => {
    if (event.sender !== mainWindow?.webContents || !remoteControlActive || !isAllowedAppUrl(event.sender.getURL())) return { ok: false, error: "Bloqueio indisponível nesta sessão." };
    const sessionId = String(input?.sessionId || "");
    if (!sessionId || sessionId.length > 128) return { ok: false, error: "Sessão inválida." };
    return setHostInputLock(sessionId, Boolean(input?.mouse), Boolean(input?.keyboard));
  });
  ipcMain.handle("nodus:set-host-cursor-active", (event, active) => {
    if (event.sender !== mainWindow?.webContents) return;
    hostCursorVisibility?.setActive(active === true);
  });
  ipcMain.handle("nodus:set-remote-keyboard-capture", (event, active) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target || !isAllowedAppUrl(event.sender.getURL())) return;
    if (active && target.isFocused()) {
      remoteKeyboardCaptureActive = true;
      remoteKeyboardCaptureWebContentsId = event.sender.id;
      event.sender.setIgnoreMenuShortcuts(true);
      remoteWindowsKeys?.setActive(target);
    } else if (remoteKeyboardCaptureWebContentsId === event.sender.id) {
      remoteKeyboardCaptureActive = false;
      remoteKeyboardCaptureWebContentsId = 0;
      event.sender.setIgnoreMenuShortcuts(false);
      remoteWindowsKeys?.stop(target);
    }
  });
  ipcMain.handle("nodus:send-secure-attention", (event) => {
    if (event.sender !== mainWindow?.webContents || !remoteControlActive) return { ok: false, error: "Controle remoto não autorizado." };
    if (process.platform !== "win32" || !fs.existsSync(nativeService)) return { ok: false, error: "Ctrl+Alt+Del indisponível neste sistema." };
    if (Date.now() - lastSecureAttentionAt < 5000) return { ok: false, error: "Aguarde antes de enviar Ctrl+Alt+Del novamente." };
    lastSecureAttentionAt = Date.now();
    return new Promise((resolve) => {
      const child = spawn(nativeService, ["--send-sas"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      const timeout = setTimeout(() => { child.kill(); resolve({ ok: false, error: "O Windows não respondeu ao Ctrl+Alt+Del." }); }, 5000);
      child.stdout.on("data", (data) => { output = (output + data.toString()).slice(-1024); });
      child.on("error", () => { clearTimeout(timeout); resolve({ ok: false, error: "Serviço Nodus indisponível para Ctrl+Alt+Del." }); });
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve(code === 0 && output.includes("SAS_REQUESTED") ? { ok: true } : { ok: false, error: output.includes("SAS_POLICY_REQUIRED")
          ? "O Windows precisa permitir Ctrl+Alt+Del por serviços na política SoftwareSASGeneration."
          : "Ctrl+Alt+Del requer o serviço Nodus atualizado, ativo e autorizado no computador remoto." });
      });
    });
  });
  ipcMain.handle("nodus:toggle-full-screen", (event, enabled) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    if (!targetWindow) return false;
    const next = typeof enabled === "boolean" ? enabled : !targetWindow.isFullScreen();
    targetWindow.setFullScreen(next);
    return next;
  });
  ipcMain.handle("nodus:check-for-updates", async () => {
    try {
      const response = await fetch("https://api.github.com/repos/Kaueeteixeiraa/nodus-connect/releases/latest", { headers: { Accept: "application/vnd.github+json", "User-Agent": "Nodus-Connect" }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("UPDATE_CHECK_FAILED");
      const release = await response.json();
      return { ok: true, version: String(release.tag_name || "").replace(/^v/i, ""), url: String(release.html_url || "") };
    } catch {
      return { ok: false, error: "Não foi possível buscar atualizações agora." };
    }
  });
  ipcMain.handle("nodus:restart-computer", (event) => {
    if (!isMainAppSender(event) || !remoteControlActive) return { ok: false, error: "UNAUTHORIZED" };
    const result = spawnSync("shutdown.exe", ["/r", "/t", "15", "/c", "Reinicialização autorizada pelo Nodus Connect"], { windowsHide: true });
    return result.status === 0 ? { ok: true } : { ok: false, error: "O Windows recusou a reinicialização." };
  });
  ipcMain.handle("nodus:set-startup-options", (_event, options) => {
    minimizeToTray = options?.minimizeToTray !== false;
    app.setLoginItemSettings({
      openAtLogin: Boolean(options?.startWithWindows),
      openAsHidden: Boolean(options?.startMinimized),
      args: options?.startMinimized ? ["--minimized"] : [],
    });
  });
  ipcMain.on("nodus:apply-remote-input", (event, input) => { if (isMainAppSender(event)) applyRemoteInput(input); });
  ipcMain.handle("nodus:measure-remote-input", (event, input) => {
    if (event.sender !== mainWindow?.webContents || !isAllowedAppUrl(event.sender.getURL())) return { ok: false, error: "UNAUTHORIZED" };
    return measureRemoteInput(input);
  });
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
  ipcMain.handle("nodus:write-performance", (_event, message) => appendLog(String(message || "").slice(0, 16_000), "performance.log"));
  ipcMain.handle("nodus:get-gpu-diagnostics", () => getGpuDiagnostics());
  ipcMain.handle("nodus:get-render-display-info", (event, viewport) => getRenderDisplayInfo(event.sender, viewport));
  ipcMain.handle("nodus:google-login", (_event, options) => googleLogin(options));
}

function startNativeMedia(sender, input) {
  const sessionId = String(input?.sessionId || "");
  if (!/^[\da-f-]{36}$/i.test(sessionId) || nativeMedia.has(sessionId)) throw new Error("Sessao nativa invalida.");
  if (!fs.existsSync(nativeMediaExe) || !fs.existsSync(path.join(gstreamerRoot, "lib", "gstreamer-1.0", "gstd3d11.dll"))) {
    throw new Error("Backend WGC indisponivel.");
  }
  const monitor = Number.isInteger(input?.monitor) && input.monitor >= -1 ? input.monitor : -1;
  const width = Number.isInteger(input?.width) && input.width > 0 ? input.width : 0;
  const height = Number.isInteger(input?.height) && input.height > 0 ? input.height : 0;
  const fps = Number.isInteger(input?.fps) ? Math.max(5, Math.min(60, input.fps)) : 60;
  const bitrateKbps = Number.isInteger(input?.bitrateKbps) ? Math.max(1000, Math.min(30000, input.bitrateKbps)) : 14000;
  appendLog(`native-media-start session=${sessionId} monitor=${monitor} resolution=${width}x${height} fps=${fps} audio=${Boolean(input?.shareAudio)}`);
  const child = spawn(nativeMediaExe, [String(monitor), String(fps), String(bitrateKbps), String(width), String(height), input?.shareAudio ? "1" : "0"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PATH: `${path.join(gstreamerRoot, "bin")};${process.env.PATH || ""}`,
      GST_PLUGIN_PATH: path.join(gstreamerRoot, "lib", "gstreamer-1.0"),
      GST_PLUGIN_PATH_1_0: path.join(gstreamerRoot, "lib", "gstreamer-1.0"),
      GST_PLUGIN_SYSTEM_PATH_1_0: "",
      GST_REGISTRY_1_0: path.join(app.getPath("userData"), "gstreamer-registry.bin"),
      GST_PLUGIN_SCANNER: path.join(gstreamerRoot, "libexec", "gstreamer-1.0", "gst-plugin-scanner.exe"),
    },
  });
  const iceUris = [];
  for (const server of Array.isArray(input?.iceServers) ? input.iceServers.slice(0, 12) : []) {
    for (const raw of (Array.isArray(server?.urls) ? server.urls : [server?.urls]).slice(0, 6)) {
      if (typeof raw !== "string" || raw.length > 300) continue;
      if (/^stun:/i.test(raw)) iceUris.push(`stun://${raw.replace(/^stun:(\/\/)?/i, "")}`);
      if (/^turns?:/i.test(raw) && typeof server.username === "string" && typeof server.credential === "string") {
        const scheme = raw.toLowerCase().startsWith("turns:") ? "turns" : "turn";
        const host = raw.replace(/^turns?:(\/\/)?/i, "");
        iceUris.push(`${scheme}://${encodeURIComponent(server.username)}:${encodeURIComponent(server.credential)}@${host}`);
      }
    }
  }
  child.stdin.write(`S ${iceUris.length}\n${iceUris.map((uri) => `${uri}\n`).join("")}`);
  nativeMedia.set(sessionId, { child, owner: sender.id });
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    let stderr = "";
    let encoderInfo = {};
    let stage = "PROCESS_STARTED";
    const startedAt = Date.now();
    const failStartup = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      child.nodusStopped = true;
      if (nativeMedia.get(sessionId)?.child === child) nativeMedia.delete(sessionId);
      child.kill();
      reject(new Error(`WGC_STAGE=${stage}: ${message}`));
    };
    let timer = setTimeout(() => failStartup("CAPTURE_STARTUP_IDLE_TIMEOUT"), 8000);
    const deadline = setTimeout(() => failStartup("CAPTURE_STARTUP_DEADLINE"), 30000);
    const emit = (type, payload) => {
      if (!sender.isDestroyed()) sender.send("nodus:native-media-signal", { sessionId, type, ...payload });
    };
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      let end;
      while ((end = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, end).trim();
        output = output.slice(end + 1);
        const [code, first, second] = line.split(" ");
        if (code === "L") {
          stage = first;
          appendLog(`native-media-stage session=${sessionId} elapsedMs=${Date.now() - startedAt} ${line.slice(2)}`);
          if (!settled) { clearTimeout(timer); timer = setTimeout(() => failStartup("CAPTURE_STARTUP_IDLE_TIMEOUT"), 8000); }
        }
        else if (code === "R" && !settled) {
          if (first !== "STREAM_READY") { failStartup("INVALID_READY_HANDSHAKE"); continue; }
          settled = true; clearTimeout(timer); clearTimeout(deadline);
          appendLog(`native-media-ready session=${sessionId} stage=STREAM_READY elapsedMs=${Date.now() - startedAt}`);
          resolve({ backend: "wgc", cursorCapture: false, ...encoderInfo });
        }
        else if (code === "H") encoderInfo = { encoderImplementation: Buffer.from(first, "base64").toString("utf8"), hardwareEncode: second === "1" };
        else if (code === "O") emit("offer", { sdp: Buffer.from(first, "base64").toString("utf8") });
        else if (code === "I") emit("candidate", { sdpMLineIndex: Number(first), candidate: Buffer.from(second, "base64").toString("utf8") });
        else if (code === "M") {
          const [, captureFrames, encodeFrames, rtpPackets, rtpBytes, encodeTimeUs, encodeSamples, encodeP95Us] = line.split(" ");
          emit("metrics", { captureFrames: Number(captureFrames), encodeFrames: Number(encodeFrames), rtpPackets: Number(rtpPackets), rtpBytes: Number(rtpBytes), encodeTimeUs: Number(encodeTimeUs || 0), encodeSamples: Number(encodeSamples || 0), encodeP95Ms: Number(encodeP95Us || 0) / 1000 });
        }
        else if (code === "V") emit("source", { width: Number(first), height: Number(second) });
        else if (code === "C") emit("connected", {});
        else if (code === "E") {
          const message = line.slice(2).replace(/(turns?:\/\/)[^\s@]+@/gi, "$1[redacted]@").slice(0, 1000);
          appendLog(`native-media-error session=${sessionId} ${message}`);
          if (!settled) failStartup(message);
          else emit("error", { message });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").replace(/(turns?:\/\/)[^\s@]+@/gi, "$1[redacted]@");
      stderr = (stderr + message).slice(-1200);
      appendLog(`native-media ${message.slice(0, 600)}`);
    });
    child.stdin.on("error", (error) => { if (!settled) failStartup(`STDIN_ERROR ${error.message}`); });
    child.on("error", (error) => failStartup(`SPAWN_ERROR ${error.message}`));
    child.on("close", (code) => {
      if (nativeMedia.get(sessionId)?.child === child) nativeMedia.delete(sessionId);
      appendLog(`native-media-close session=${sessionId} stage=${stage} exitCode=${code} stopped=${Boolean(child.nodusStopped)}`);
      if (!settled) failStartup(`EXIT_CODE=${code} ${stderr.trim()}`);
      else if (!child.nodusStopped) emit("exit", { code });
    });
  });
}

function signalNativeMedia(sender, input) {
  const entry = nativeMedia.get(String(input?.sessionId || ""));
  if (!entry || entry.owner !== sender.id) return false;
  if (input.type === "answer" && typeof input.sdp === "string" && input.sdp.length < 100_000) {
    entry.child.stdin.write(`A ${Buffer.from(input.sdp).toString("base64")}\n`);
    return true;
  }
  if (input.type === "candidate" && typeof input.candidate === "string" && input.candidate.length < 4096) {
    const index = Number(input.sdpMLineIndex);
    if (!Number.isInteger(index) || index < 0 || index > 16) return false;
    entry.child.stdin.write(`I ${index} ${Buffer.from(input.candidate).toString("base64")}\n`);
    return true;
  }
  if (input.type === "bitrate" && Number.isInteger(input.bitrateKbps) && input.bitrateKbps >= 1000 && input.bitrateKbps <= 50000) {
    entry.child.stdin.write(`B ${input.bitrateKbps}\n`);
    return true;
  }
  return false;
}

function stopNativeMediaEntry(sessionId, entry, immediate = false) {
  if (nativeMedia.get(sessionId)?.child !== entry.child) return;
  nativeMedia.delete(sessionId);
  entry.child.nodusStopped = true;
  if (immediate) {
    entry.child.kill();
    return;
  }
  entry.child.stdin.end("Q\n");
  setTimeout(() => { if (entry.child.exitCode === null) entry.child.kill(); }, 1500).unref();
}

function stopNativeMediaForOwner(owner, immediate = false) {
  for (const [sessionId, entry] of nativeMedia) {
    if (owner === null || entry.owner === owner) stopNativeMediaEntry(sessionId, entry, immediate);
  }
}

function stopNativeMedia(sender, sessionId) {
  const key = String(sessionId || "");
  const entry = nativeMedia.get(key);
  if (!entry || entry.owner !== sender.id) return;
  stopNativeMediaEntry(key, entry);
}

function getNativeCaptureStatus() {
  const policy = getCaptureBackendPolicy();
  if (!fs.existsSync(nativeCaptureProbe)) return { ...policy, available: false, supported: false, backend: "chromium-getdisplaymedia" };
  try {
    const result = require("node:child_process").execFileSync(nativeCaptureProbe, [], { encoding: "utf8", timeout: 5000, windowsHide: true });
    const capabilities = JSON.parse(result);
    const supported = capabilities.windowsGraphicsCapture === true;
    return {
      ...policy,
      available: true,
      supported,
      nativeMediaExperimental: process.env.NODUS_WGC_EXPERIMENTAL === "1",
      nativeMediaAvailable: fs.existsSync(nativeMediaExe) && fs.existsSync(path.join(gstreamerRoot, "lib", "gstreamer-1.0", "gstd3d11.dll")),
      cursorSuppressionSupported: capabilities.cursorSuppressionSupported === true,
      backend: "chromium-getdisplaymedia",
      d3d11Hardware: capabilities.d3d11Hardware === true,
      hardwareH264: capabilities.hardwareH264 === true,
      hardwareH264Encoders: Number(capabilities.hardwareH264Encoders || 0),
      adapter: String(capabilities.adapter || "").slice(0, 200),
    };
  } catch (error) {
    appendLog(`native-capture-discovery-failed ${error.message}`);
    return { ...policy, available: false, supported: false, backend: "chromium-getdisplaymedia" };
  }
}

function getCaptureBackendPolicy() {
  return { requestedBackend: process.env.NODUS_CAPTURE_BACKEND === "wgc" ? "wgc" : "chromium", allowLegacyFallback: process.env.NODUS_CAPTURE_FALLBACK !== "0" };
}

async function getGpuDiagnostics() {
  const info = await app.getGPUInfo("basic").catch(() => null);
  const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
  const device = devices.find((entry) => entry.active) || devices[0];
  const features = gpuInfoReady ? app.getGPUFeatureStatus() : {};
  return {
    adapter: String(device?.deviceString || "").slice(0, 200),
    videoEncode: features.video_encode || "unknown",
    videoDecode: features.video_decode || "unknown",
    gpuCompositing: features.gpu_compositing || "unknown",
    gpuProcessAvailable: app.getAppMetrics().some((metric) => metric.type === "GPU"),
  };
}

function getRenderDisplayInfo(webContents, viewport) {
  const window = BrowserWindow.fromWebContents(webContents);
  const display = window ? screen.getDisplayMatching(window.getBounds()) : screen.getPrimaryDisplay();
  const metric = app.getAppMetrics().find((item) => item.pid === webContents.getOSProcessId());
  return {
    displayId: String(display.id),
    displayWidth: display.size.width,
    displayHeight: display.size.height,
    refreshRateHz: Number(display.displayFrequency) || null,
    scaleFactor: display.scaleFactor,
    devicePixelRatio: Number(viewport?.devicePixelRatio) || 1,
    viewportWidth: Number(viewport?.viewportWidth) || 0,
    viewportHeight: Number(viewport?.viewportHeight) || 0,
    fullscreen: Boolean(window?.isFullScreen()),
    rendererCpuPercent: typeof metric?.cpu?.percentCPUUsage === "number" ? metric.cpu.percentCPUUsage : null,
  };
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

function identityStore() {
  deviceIdentityStore ??= createDeviceIdentityStore(app.getPath("userData"));
  return deviceIdentityStore;
}

function licenseCredentials(event, value) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame || !safeStorage.isEncryptionAvailable()) return value === undefined ? null : false;
  const filename = path.join(app.getPath("userData"), "license-device.bin");
  const valid = (data) => data?.deviceId === identityStore().loadOrCreate().deviceId && typeof data.deviceToken === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(data.deviceToken);
  try {
    if (value === undefined) {
      if (!fs.existsSync(filename) || fs.statSync(filename).size > 4096) return null;
      const saved = JSON.parse(safeStorage.decryptString(fs.readFileSync(filename)));
      return valid(saved) ? { deviceId: saved.deviceId, deviceToken: saved.deviceToken } : null;
    }
    if (!valid(value)) return false;
    fs.writeFileSync(`${filename}.tmp`, safeStorage.encryptString(JSON.stringify({ deviceId: value.deviceId, deviceToken: value.deviceToken })), { mode: 0o600 });
    fs.renameSync(`${filename}.tmp`, filename);
    return true;
  } catch { return value === undefined ? null : false; }
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
    if (message.type === "mouseMove" && helper.stdin.writableLength > 64) {
      helper.nodusPendingMove = { message, at: Date.now() };
      if (!helper.nodusMoveTimer) helper.nodusMoveTimer = setTimeout(() => flushLatestMouseMove(helper), 4);
      return { ok: true };
    }
    clearTimeout(helper.nodusMoveTimer);
    helper.nodusMoveTimer = null;
    helper.nodusPendingMove = null;
    helper.stdin.write(helper.nodusBinaryInput ? encodeRemoteInput(message) : `${JSON.stringify(message)}\n`);
    hostCursorVisibility?.remoteMouseActivity(message);
    return { ok: true };
  } catch (error) {
    appendLog(`remote-input-error ${error.message}`);
    return { ok: false, error: error.message };
  }
}

function flushLatestMouseMove(helper) {
  helper.nodusMoveTimer = null;
  const pending = helper.nodusPendingMove;
  if (!pending) return;
  if (!remoteControlActive || inputHelper !== helper || helper.killed || helper.stdin.writable === false || Date.now() - pending.at > 100) { helper.nodusPendingMove = null; return; }
  if (helper.stdin.writableLength > 64) { helper.nodusMoveTimer = setTimeout(() => flushLatestMouseMove(helper), 4); return; }
  helper.nodusPendingMove = null;
  try {
    helper.stdin.write(helper.nodusBinaryInput ? encodeRemoteInput(pending.message) : `${JSON.stringify(pending.message)}\n`);
    hostCursorVisibility?.remoteMouseActivity(pending.message);
  } catch (error) { appendLog(`remote-input-error ${error.message}`); }
}

function measureRemoteInput(input) {
  if (!performanceDiagnostic?.inputLatency || !remoteControlActive || input?.type !== "mouseMove"
    || !Number.isFinite(input.x) || !Number.isFinite(input.y)) return Promise.resolve({ ok: false, error: "DIAGNOSTIC_DISABLED_OR_INVALID" });
  try {
    const helper = ensureInputHelper();
    if (!helper.nodusBinaryInput) {
      applyRemoteInput(input);
      return Promise.resolve({ ok: false, error: "NATIVE_ACK_UNAVAILABLE" });
    }
    if (helper.stdin.writableLength > 64 || inputProbes.size >= 4) {
      applyRemoteInput(input);
      return Promise.resolve({ ok: false, error: "INPUT_PROBE_BACKPRESSURE" });
    }
    const display = screen.getAllDisplays().find((item) => String(item.id) === captureOptions.displayId) || screen.getPrimaryDisplay();
    const expected = normalizeRemoteInput(input, display.bounds);
    const start = performance.now();
    const result = applyRemoteInput(input);
    if (!result.ok) return Promise.resolve(result);
    const id = inputProbeSequence = inputProbeSequence % 2147483647 + 1;
    const packet = Buffer.alloc(16);
    packet.writeUInt8(7, 0);
    packet.writeInt32LE(id, 12);
    return new Promise((resolve) => {
      const finish = (response) => {
        clearTimeout(timer);
        inputProbes.delete(id);
        const position = response.windowsPosition;
        resolve({ ...response, positionConfirmed: Boolean(response.ok && position && Math.abs(position.x - expected.x) <= 1 && Math.abs(position.y - expected.y) <= 1),
          mainToWindowsAckMs: performance.now() - start });
      };
      const timer = setTimeout(() => finish({ ok: false, error: "NATIVE_ACK_TIMEOUT" }), 2000);
      inputProbes.set(id, { helper, finish });
      try { helper.stdin.write(packet); } catch { finish({ ok: false, error: "NATIVE_WRITE_FAILED" }); }
    });
  } catch { return Promise.resolve({ ok: false, error: "NATIVE_PROBE_FAILED" }); }
}

function observeInputProbes(helper) {
  let buffer = "";
  helper.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    if (buffer.length > 4096) { buffer = ""; return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const record = buffer.slice(0, end).trim().match(/^P (\d+) ([01]) (-?\d+) (-?\d+)$/);
      buffer = buffer.slice(end + 1);
      if (!record) continue;
      const probe = inputProbes.get(Number(record[1]));
      if (probe?.helper === helper) probe.finish({ ok: record[2] === "1", windowsPosition: { x: Number(record[3]), y: Number(record[4]) } });
    }
  });
  const fail = () => {
    for (const probe of inputProbes.values()) if (probe.helper === helper) probe.finish({ ok: false, error: "NATIVE_HELPER_EXITED" });
  };
  helper.once("exit", fail);
  helper.once("error", fail);
  helper.stdin.on("error", fail);
}

function encodeRemoteInput(input) {
  const packet = Buffer.allocUnsafe(16);
  const type = { mouseMove: 1, mouseDown: 2, mouseUp: 3, wheel: 4, keyDown: 5, keyUp: 6 }[input.type] || 0;
  const button = type === 5 || type === 6 ? (input.extended ? 1 : 0) : input.button === "right" ? 2 : input.button === "middle" ? 1 : 0;
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
    return keyCode > 0 && keyCode < 256 ? { type: input.type, keyCode, extended: extendedKeyboardCodes.has(String(input.code)) } : null;
  }
  return null;
}

function toRemoteKeyboardInput(input) {
  const code = String(input.code || input.key || "");
  const keyCode = remoteVirtualKey(code) || Number(input.keyCode);
  if (!Number.isInteger(keyCode) || keyCode <= 0 || keyCode >= 256) return null;
  return { keyCode, code, location: Number(input.location) || 0, repeat: Boolean(input.isAutoRepeat) };
}

function remoteVirtualKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(-1));
  if (/^[A-Z]$/.test(code)) return code.charCodeAt(0);
  if (/^[0-9]$/.test(code)) return code.charCodeAt(0);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return 111 + Number(code.slice(1));
  return { Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 160, ShiftRight: 161, ControlLeft: 162, ControlRight: 163, AltLeft: 164, AltRight: 165, Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46, Meta: 91, MetaLeft: 91, MetaRight: 92, ContextMenu: 93, PrintScreen: 44, NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111, NumLock: 144, ScrollLock: 145, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222, IntlBackslash: 226, IntlRo: 226, NumpadComma: 110 }[code] || 0;
}

function clearInputLocks() {
  inputLocks.clear();
  if (inputLockHeartbeat) clearInterval(inputLockHeartbeat);
  inputLockHeartbeat = undefined;
  if (inputLockHelper && !inputLockHelper.killed) {
    inputLockHelper.stdin?.write("mkR");
    inputLockHelper.kill();
  }
  inputLockHelper = undefined;
}

function setHostInputLock(sessionId, mouse, keyboard) {
  if (!fs.existsSync(nativeService)) return { ok: false, error: "Bloqueio de entrada não disponível neste computador." };
  if (!mouse && !keyboard) inputLocks.delete(sessionId);
  else inputLocks.set(sessionId, { mouse, keyboard });
  const active = [...inputLocks.values()].reduce((current, lock) => ({ mouse: current.mouse || lock.mouse, keyboard: current.keyboard || lock.keyboard }), { mouse: false, keyboard: false });
  if (!active.mouse && !active.keyboard) {
    clearInputLocks();
    return { ok: true, ...active };
  }
  if (!inputLockHelper || inputLockHelper.killed) {
    inputLockHelper = spawn(nativeService, ["--input-lock-helper", String(process.pid)], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    inputLockHelper.on("exit", () => { inputLockHelper = undefined; });
  }
  inputLockHelper.stdin?.write(`${active.mouse ? "M" : "m"}${active.keyboard ? "K" : "k"}H`);
  if (!inputLockHeartbeat) inputLockHeartbeat = setInterval(() => inputLockHelper?.stdin?.write("H"), 1000);
  return { ok: true, ...active };
}

function ensureInputHelper() {
  if (inputHelper && !inputHelper.killed) return inputHelper;
  if (fs.existsSync(nativeService)) {
    inputHelper = spawn(nativeService, ["--input-helper"], { windowsHide: true, stdio: ["pipe", performanceDiagnostic?.inputLatency ? "pipe" : "ignore", "ignore"] });
    inputHelper.nodusBinaryInput = true;
    inputHelper.stdin.on("error", (error) => appendLog(`remote-input-pipe-error ${error.message}`));
    if (performanceDiagnostic?.inputLatency) observeInputProbes(inputHelper);
    const helper = inputHelper;
    inputHelper.on("exit", () => { if (inputHelper === helper) inputHelper = null; });
    inputHelper.on("error", (error) => { if (inputHelper === helper) inputHelper = null; appendLog(`remote-input-error ${error.message}`); });
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
    elseif ($m.type -eq "keyDown") { $flags = if ($m.extended) { 1 } else { 0 }; [NodusInput]::keybd_event([byte]$m.keyCode, 0, [uint32]$flags, [UIntPtr]::Zero) }
    elseif ($m.type -eq "keyUp") { $flags = if ($m.extended) { 3 } else { 2 }; [NodusInput]::keybd_event([byte]$m.keyCode, 0, [uint32]$flags, [UIntPtr]::Zero) }
  } catch {}
}
`;
  inputHelper = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  inputHelper.stdin.on("error", (error) => appendLog(`remote-input-pipe-error ${error.message}`));
  const helper = inputHelper;
  inputHelper.on("exit", () => { if (inputHelper === helper) inputHelper = null; });
  inputHelper.on("error", (error) => { if (inputHelper === helper) inputHelper = null; appendLog(`remote-input-error ${error.message}`); });
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
  const logo = fs.readFileSync(path.resolve(__dirname, "../../../build/icon.svg"), "utf8");
  const logoUrl = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Nodus Connect</title><style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050811;color:#f4f8ff;font-family:Inter,Segoe UI,Arial,sans-serif}
    body:before{content:"";position:fixed;inset:0;background:linear-gradient(115deg,rgba(20,145,255,.2),transparent 52%),radial-gradient(circle at 75% 35%,rgba(37,230,255,.18),transparent 32%);pointer-events:none}
    .card{position:relative;width:min(460px,calc(100vw - 36px));padding:28px;border:1px solid rgba(75,160,255,.28);border-radius:18px;background:rgba(6,12,24,.86);box-shadow:0 24px 80px rgba(0,0,0,.42)}
    .mark{width:46px;height:46px;display:grid;place-items:center;border:1px solid #2d9bff;border-radius:12px;background:#0a1729;margin-bottom:18px}.mark img{width:88%;height:88%;object-fit:contain}
    .pill{display:inline-flex;gap:8px;align-items:center;color:${ok ? "#25e6ff" : "#ff9aac"};font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.12em}
    .pill:before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 14px currentColor}
    h1{margin:10px 0 8px;font-size:28px}p{margin:0;color:#9fb0c7;line-height:1.5}.hint{margin-top:18px;color:#58b7ff;font-weight:800}
  </style></head><body><main class="card"><div class="mark"><img src="${logoUrl}" alt=""></div><span class="pill">${ok ? "Deu certo" : "Nao deu certo"}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p class="hint">Esta aba pode ser fechada.</p></main><script>${script || (ok ? "setTimeout(function(){window.close()},1200)" : "")}</script></body></html>`;
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
