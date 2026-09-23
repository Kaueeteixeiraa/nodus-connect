const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("original-fs");
const os = require("node:os");
const path = require("node:path");

const productName = "Nodus Connect";
const localAppData = realPath(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"));
let installDir = path.join(localAppData, "Programs", productName);
const installedApp = path.basename(process.execPath).toLowerCase() === "nodus connect.exe" || process.argv.includes("--run-app");

let win;

if (installedApp) {
  require("../desktop/electron/main.cjs");
} else {
  app.setName("Nodus Connect Setup");
  app.whenReady().then(() => {
    if (process.argv.includes("--silent-install")) {
      installNodus((message, progress) => console.log(`${progress}% ${message}`)).then((result) => {
        console.log(JSON.stringify(result));
        app.exit(result.ok ? 0 : 1);
      });
      return;
    }

    win = new BrowserWindow({
      width: 700,
      height: 620,
      minWidth: 620,
      minHeight: 560,
      resizable: true,
      frame: false,
      titleBarStyle: "hidden",
      title: "Nodus Connect Setup",
      backgroundColor: "#050811",
      icon: path.resolve(__dirname, "../../build/icon.ico"),
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "preload.cjs"),
      },
    });
    win.loadFile(path.join(__dirname, "index.html"));
  });

  ipcMain.handle("install", async (event, options) => {
    const send = (message, progress) => event.sender.send("progress", { message, progress });
    return installNodus(send, options);
  });

  ipcMain.handle("system-info", async () => {
    let graphics = "Indisponivel";
    try {
      const gpu = await app.getGPUInfo("basic");
      graphics = gpu?.gpuDevice?.[0]?.deviceString || gpu?.gpuDevice?.[0]?.vendorString || graphics;
    } catch {}
    return {
      platform: windowsLabel(),
      architecture: process.arch === "x64" ? "x64 (64 bits)" : process.arch,
      network: hasNetwork() ? "Disponivel" : "Indisponivel",
      graphics,
      disk: formatBytes(getFreeDiskBytes(installDir)),
      required: formatBytes(getPayloadSize(path.dirname(process.execPath))),
      version: app.getVersion(),
      logPath: path.join(os.tmpdir(), "nodus-connect-installer.log"),
      installDir,
    };
  });

  ipcMain.handle("select-install-dir", async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "Selecionar local de instalação",
      defaultPath: path.dirname(installDir),
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, installDir };
    installDir = normalizeInstallDir(result.filePaths[0]);
    return { canceled: false, installDir, disk: formatBytes(getFreeDiskBytes(installDir)) };
  });

  ipcMain.handle("minimize", () => win?.minimize());
  ipcMain.handle("open-app", () => {
    launchInstalledApp();
    return true;
  });

  ipcMain.handle("close", () => app.quit());
}

async function installNodus(send, rawOptions = {}) {
  try {
    const options = {
      desktopShortcut: rawOptions?.desktopShortcut !== false,
      startWithWindows: Boolean(rawOptions?.startWithWindows),
      openAfterInstall: rawOptions?.openAfterInstall !== false,
      installDir: normalizeInstallDir(rawOptions?.installDir || installDir),
    };
    const source = realPath(path.dirname(process.execPath));
    if (!fs.existsSync(path.join(source, "Nodus Connect Setup.exe"))) throw new Error("INSTALLER_SOURCE_NOT_FOUND");

    send("Preparando instalação...", 8);
    assertSafeInstallDir(options.installDir);
    if (isSameOrInside(source, options.installDir) || isSameOrInside(options.installDir, source)) throw new Error("INVALID_INSTALL_TARGET");
    installDir = options.installDir;

    send("Fechando versões abertas...", 16);
    const restartService = stopNodusForUpdate();

    send("Instalando Nodus Connect...", 24);
    removeInstallDir();
    fs.mkdirSync(installDir, { recursive: true });
    copyTree(source, installDir, send, 24, 86);
    renameInstalledExe();

    send("Criando atalhos...", 92);
    createShortcuts(options);
    writeUninstaller();
    if (restartService) restartNodusService();
    if (options.openAfterInstall) {
      send("Abrindo Nodus Connect...", 98);
      launchInstalledApp();
    }
    send("Tudo pronto.", 100);
    return { ok: true, installDir };
  } catch (error) {
    log(error?.stack || error?.message || String(error));
    return { ok: false, error: friendlyError(error), logPath: path.join(os.tmpdir(), "nodus-connect-installer.log") };
  }
}

function assertSafeInstallDir(target) {
  const resolved = path.resolve(target);
  if (!path.isAbsolute(resolved) || path.basename(resolved).toLowerCase() !== productName.toLowerCase()) throw new Error("Pasta de instalacao invalida.");
}

function normalizeInstallDir(value) {
  const resolved = path.resolve(String(value || ""));
  return path.basename(resolved).toLowerCase() === productName.toLowerCase() ? resolved : path.join(resolved, productName);
}

function isSameOrInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function realPath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

function copyTree(source, target, send, startProgress, endProgress) {
  const files = listFiles(source);
  if (files.length === 0) throw new Error("EMPTY_PAYLOAD");
  if (typeof fs.cpSync === "function") {
    send("Copiando arquivos...", Math.round((startProgress + endProgress) / 2));
    fs.cpSync(source, target, { recursive: true, force: true });
    send("Finalizando arquivos...", endProgress);
    return;
  }
  for (let index = 0; index < files.length; index++) {
    const from = files[index];
    const to = path.join(target, path.relative(source, from));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    copyFile(from, to);
    if (index % 10 === 0) send("Copiando arquivos...", startProgress + Math.round((index / files.length) * (endProgress - startProgress)));
  }
}

function copyFile(from, to) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.copyFileSync(from, to);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      wait(120);
    }
  }
}

function waitForAppExit() {
  for (let attempt = 0; attempt < 24; attempt++) {
    const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq Nodus Connect.exe"], { encoding: "utf8", windowsHide: true });
    if (!String(result.stdout || "").toLowerCase().includes("nodus connect.exe")) return;
    wait(160);
  }
}

function stopNodusForUpdate() {
  spawnSync("taskkill.exe", ["/IM", "Nodus Connect.exe", "/F"], { windowsHide: true, stdio: "ignore" });
  const service = getNodusServiceState();
  if (service.running) {
    const result = spawnSync("sc.exe", ["stop", "NodusConnectService"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error("SERVICE_STOP_FAILED");
    waitForServiceStop();
  }
  // The service may have launched the app while it was stopping.
  spawnSync("taskkill.exe", ["/IM", "Nodus Connect.exe", "/F"], { windowsHide: true, stdio: "ignore" });
  waitForAppExit();
  return service.running;
}

function getNodusServiceState() {
  const result = spawnSync("sc.exe", ["query", "NodusConnectService"], { encoding: "utf8", windowsHide: true });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  return { installed: result.status === 0, running: /\bRUNNING\b/i.test(output) };
}

function waitForServiceStop() {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!getNodusServiceState().running) return;
    wait(200);
  }
  throw new Error("SERVICE_STOP_TIMEOUT");
}

function restartNodusService() {
  const result = spawnSync("sc.exe", ["start", "NodusConnectService"], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) log(`Nao foi possivel reiniciar o servico: ${result.stderr || result.stdout || result.status}`);
}

function removeInstallDir() {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      fs.rmSync(installDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 11) throw error;
      wait(220);
    }
  }
}

function renameInstalledExe() {
  const setupExe = path.join(installDir, "Nodus Connect Setup.exe");
  const appExe = path.join(installDir, "Nodus Connect.exe");
  if (fs.existsSync(appExe)) fs.rmSync(appExe, { force: true });
  if (fs.existsSync(setupExe)) fs.renameSync(setupExe, appExe);
  if (!fs.existsSync(appExe)) throw new Error("APP_EXE_NOT_FOUND");
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createShortcuts(options) {
  const exe = path.join(installDir, "Nodus Connect.exe");
  const programsDir = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
  const desktop = path.join(os.homedir(), "Desktop", "Nodus Connect.lnk");
  const startDir = path.join(programsDir, "Nodus Connect");
  const startupDir = path.join(programsDir, "Startup");
  fs.rmSync(path.join(programsDir, "Nodus Connect Setup.lnk"), { force: true });
  if (options.desktopShortcut) fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.mkdirSync(startDir, { recursive: true });
  if (options.desktopShortcut) createShortcut(desktop, exe);
  createShortcut(path.join(startDir, "Nodus Connect.lnk"), exe);
  if (options.startWithWindows) {
    fs.mkdirSync(startupDir, { recursive: true });
    createShortcut(path.join(startupDir, "Nodus Connect.lnk"), exe);
  }
}

function createShortcut(shortcutPath, targetPath) {
  const script = [
    "$w = New-Object -ComObject WScript.Shell",
    `$s = $w.CreateShortcut(${ps(shortcutPath)})`,
    `$s.TargetPath = ${ps(targetPath)}`,
    `$s.WorkingDirectory = ${ps(installDir)}`,
    `$s.IconLocation = ${ps(targetPath)}`,
    "$s.Save()",
  ].join("; ");
  spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, stdio: "ignore" });
}

function writeUninstaller() {
  const file = path.join(installDir, "Desinstalar Nodus Connect.cmd");
  const desktop = path.join(os.homedir(), "Desktop", "Nodus Connect.lnk");
  const startup = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Nodus Connect.lnk");
  const parent = path.dirname(installDir);
  const folder = path.basename(installDir);
  fs.writeFileSync(
    file,
    `@echo off\r\ntaskkill /IM "Nodus Connect.exe" /F >nul 2>nul\r\ndel "${desktop}" >nul 2>nul\r\ndel "${startup}" >nul 2>nul\r\ncd /d "${parent}"\r\nrmdir /s /q "${folder}"\r\n`,
  );
}

function launchInstalledApp() {
  const exe = path.join(installDir, "Nodus Connect.exe");
  if (!fs.existsSync(exe)) throw new Error("APP_EXE_NOT_FOUND");
  const child = spawn(exe, [], { cwd: installDir, detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}

function ps(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function friendlyError(error) {
  const message = error?.message || "";
  if (message.includes("ENOENT") || message === "EMPTY_PAYLOAD" || message === "INSTALLER_SOURCE_NOT_FOUND" || message === "APP_EXE_NOT_FOUND") {
    return "Não foi possível ler os arquivos do instalador. Feche esta janela e abra o setup novamente.";
  }
  if (message === "INVALID_INSTALL_TARGET") return "Escolha uma pasta diferente da pasta onde o setup está aberto.";
  if (message.includes("Pasta de instalacao")) return "Não foi possível preparar a pasta de instalação.";
  if (message.startsWith("SERVICE_STOP")) return "Não foi possível interromper o serviço do Nodus. Feche o Nodus e execute o setup novamente.";
  return "Não foi possível concluir a instalação. Feche o Nodus e tente novamente.";
}

function log(message) {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), "nodus-connect-installer.log"), `[${new Date().toISOString()}] ${message}\n`);
  } catch {}
}

function hasNetwork() {
  return Object.values(os.networkInterfaces()).flat().some((item) => item && !item.internal && item.address);
}

function windowsLabel() {
  const build = Number(os.release().split(".").pop());
  return `Windows ${build >= 22000 ? "11" : "10"}`;
}

function getFreeDiskBytes(target = installDir) {
  try {
    const stats = fs.statfsSync(existingParent(target));
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return 0;
  }
}

function existingParent(value) {
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function getPayloadSize(dir) {
  try {
    return listFiles(dir).reduce((total, file) => total + fs.statSync(file).size, 0);
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "Indisponivel";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
