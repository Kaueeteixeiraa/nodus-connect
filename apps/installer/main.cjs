const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("original-fs");
const os = require("node:os");
const path = require("node:path");

const productName = "Nodus Connect";
const localAppData = realPath(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"));
let installDir = path.join(localAppData, "Programs", productName);
const uninstallMode = process.argv.includes("--uninstall");
const installedApp = !uninstallMode && (path.basename(process.execPath).toLowerCase() === "nodus connect.exe" || process.argv.includes("--run-app"));
if (uninstallMode && path.basename(process.execPath).toLowerCase() === "nodus connect.exe") installDir = path.dirname(process.execPath);
let cancelRequested = false;
let installing = false;

let win;

if (installedApp) {
  require("../desktop/electron/main.cjs");
} else {
  app.setName("Nodus Connect Setup");
  app.whenReady().then(() => {
    const updateFile = process.argv.find((arg) => arg.startsWith("--auto-update="));
    if (updateFile) {
      applyAutomaticUpdate(updateFile.slice("--auto-update=".length)).then((ok) => app.exit(ok ? 0 : 1));
      return;
    }
    if (process.argv.includes("--silent-install")) {
      installNodus((message, progress) => console.log(`${progress}% ${message}`)).then((result) => {
        console.log(JSON.stringify(result));
        app.exit(result.ok ? 0 : 1);
      });
      return;
    }

    const workArea = require("electron").screen.getPrimaryDisplay().workAreaSize;
    win = new BrowserWindow({
      width: Math.min(930, workArea.width - 24),
      height: Math.min(600, workArea.height - 24),
      resizable: false,
      maximizable: false,
      center: true,
      frame: false,
      titleBarStyle: "hidden",
      title: uninstallMode ? "Desinstalar Nodus Connect" : "Nodus Connect – Instalação",
      backgroundColor: "#050811",
      icon: path.resolve(__dirname, "../../build/icon.ico"),
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "preload.cjs"),
      },
    });
    win.on("close", (event) => {
      if (!installing) return;
      event.preventDefault();
      cancelRequested = true;
      win.webContents.send("cancel-requested");
    });
    win.loadFile(path.join(__dirname, "index.html"));
    const capturePath = process.argv.find((arg) => arg.startsWith("--capture-installer="))?.slice("--capture-installer=".length);
    if (capturePath) {
      win.webContents.once("did-finish-load", async () => {
        await win.webContents.executeJavaScript("new Promise((resolve) => { const check = () => document.documentElement.dataset.ready ? resolve() : setTimeout(check, 50); check(); })");
        try {
          const image = await win.webContents.capturePage();
          fs.writeFileSync(path.resolve(capturePath), image.toPNG());
        } catch (error) {
          log(`Captura visual: ${error?.stack || error}`);
        } finally {
          app.quit();
        }
      });
    }
  });

  ipcMain.handle("install", async (event, options) => {
    const send = (message, progress, step) => event.sender.send("progress", { message, progress, step });
    return installNodus(send, options);
  });
  ipcMain.handle("cancel-install", () => {
    if (installing) cancelRequested = true;
    return { ok: true };
  });
  ipcMain.handle("uninstall", (_event, options) => uninstallNodus(options));

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
      mode: uninstallMode ? "uninstall" : fs.existsSync(path.join(installDir, "Nodus Connect.exe")) ? "update" : "install",
      previewStage: process.argv.find((arg) => arg.startsWith("--visual-test="))?.split("=")[1] || "",
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
  ipcMain.handle("open-app", async () => {
    await launchInstalledApp();
    return true;
  });
  ipcMain.handle("set-desktop-shortcut", (_event, enabled) => setDesktopShortcut(Boolean(enabled)));

  ipcMain.handle("close", () => app.quit());
}

async function applyAutomaticUpdate(file) {
  let options;
  let result;
  try {
    if (!path.isAbsolute(file) || fs.statSync(file).size > 4096) throw new Error("INVALID_UPDATE_OPTIONS");
    options = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof options.installDir !== "string" || !path.isAbsolute(options.installDir) || typeof options.startWithWindows !== "boolean") throw new Error("INVALID_UPDATE_OPTIONS");
    const target = realPath(options.installDir);
    assertSafeInstallDir(target);
    if (!fs.existsSync(path.join(target, "Nodus Connect.exe"))) throw new Error("APP_EXE_NOT_FOUND");
    installDir = target;
    result = await installNodus((message, progress) => log(`Atualizacao ${progress}% ${message}`), {
      installDir, startWithWindows: options.startWithWindows, desktopShortcut: fs.existsSync(desktopShortcutPath()),
    });
    await launchInstalledApp();
    if (!result.ok) throw new Error(result.error);
    return true;
  } catch (error) {
    log(error?.stack || String(error));
    dialog.showErrorBox("Nodus Connect", result?.error || "Não foi possível concluir a atualização. Abra o Nodus ou execute o setup novamente.");
    return false;
  }
}

async function installNodus(send, rawOptions = {}) {
  let stagingDir = "";
  let backupDir = "";
  let backupMoved = false;
  let committed = false;
  let restartService = false;
  installing = true;
  cancelRequested = false;
  try {
    const options = {
      desktopShortcut: rawOptions?.desktopShortcut !== false,
      startWithWindows: Boolean(rawOptions?.startWithWindows),
      openAfterInstall: rawOptions?.openAfterInstall !== false,
      installDir: normalizeInstallDir(rawOptions?.installDir || installDir),
    };
    const source = realPath(path.dirname(process.execPath));
    if (!fs.existsSync(path.join(source, "Nodus Connect Setup.exe"))) throw new Error("INSTALLER_SOURCE_NOT_FOUND");

    send("Preparando arquivos...", 4, "prepare");
    assertSafeInstallDir(options.installDir);
    if (isSameOrInside(source, options.installDir) || isSameOrInside(options.installDir, source)) throw new Error("INVALID_INSTALL_TARGET");
    installDir = options.installDir;
    stagingDir = `${installDir}.installing`;
    backupDir = `${installDir}.backup`;
    assertSafeAuxiliaryDir(stagingDir, ".installing");
    assertSafeAuxiliaryDir(backupDir, ".backup");
    const payloadSize = getPayloadSize(source);
    if (getFreeDiskBytes(installDir) < payloadSize * 1.15) throw new Error("INSUFFICIENT_DISK_SPACE");

    send("Fechando versões abertas...", 10, "prepare");
    restartService = stopNodusForUpdate();
    throwIfCancelled();

    removeDir(stagingDir);
    removeDir(backupDir);
    fs.mkdirSync(stagingDir, { recursive: true });
    await copyTree(source, stagingDir, send, 14, 78);
    renameInstalledExe(stagingDir);
    throwIfCancelled();

    send("Configurando o sistema...", 84, "configure");
    if (fs.existsSync(installDir)) {
      fs.renameSync(installDir, backupDir);
      backupMoved = true;
    }
    fs.renameSync(stagingDir, installDir);
    committed = true;

    send("Criando atalhos...", 92, "shortcuts");
    createShortcuts(options);
    writeUninstaller();
    registerUninstaller();
    if (restartService) restartNodusService();
    if (backupMoved) removeDir(backupDir);
    send("Instalação concluída.", 100, "finish");
    return { ok: true, installDir };
  } catch (error) {
    log(error?.stack || error?.message || String(error));
    try {
      if (committed && fs.existsSync(installDir)) removeDir(installDir);
      if (backupMoved && fs.existsSync(backupDir)) fs.renameSync(backupDir, installDir);
      if (stagingDir && fs.existsSync(stagingDir)) removeDir(stagingDir);
      if (restartService) restartNodusService();
    } catch (rollbackError) {
      log(`Rollback: ${rollbackError?.stack || rollbackError}`);
    }
    return { ok: false, error: friendlyError(error), logPath: path.join(os.tmpdir(), "nodus-connect-installer.log") };
  } finally {
    installing = false;
  }
}

function assertSafeInstallDir(target) {
  const resolved = path.resolve(target);
  if (!path.isAbsolute(resolved) || path.basename(resolved).toLowerCase() !== productName.toLowerCase()) throw new Error("Pasta de instalacao invalida.");
}

function assertSafeAuxiliaryDir(target, suffix) {
  const resolved = path.resolve(target);
  if (!resolved.toLowerCase().endsWith(`${productName}${suffix}`.toLowerCase())) throw new Error("Pasta auxiliar invalida.");
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

async function copyTree(source, target, send, startProgress, endProgress) {
  const files = listFiles(source);
  if (files.length === 0) throw new Error("EMPTY_PAYLOAD");
  const totalBytes = files.reduce((total, file) => total + fs.statSync(file).size, 0);
  let copiedBytes = 0;
  for (let index = 0; index < files.length; index++) {
    throwIfCancelled();
    const from = files[index];
    const to = path.join(target, path.relative(source, from));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    copyFile(from, to);
    copiedBytes += fs.statSync(from).size;
    if (index % 8 === 0 || index === files.length - 1) {
      const progress = startProgress + Math.round((copiedBytes / totalBytes) * (endProgress - startProgress));
      send("Copiando arquivos...", progress, "copy");
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

function throwIfCancelled() {
  if (cancelRequested) throw new Error("INSTALL_CANCELLED");
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

function removeDir(target) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 11) throw error;
      wait(220);
    }
  }
}

function renameInstalledExe(target = installDir) {
  const setupExe = path.join(target, "Nodus Connect Setup.exe");
  const appExe = path.join(target, "Nodus Connect.exe");
  if (fs.existsSync(appExe)) fs.rmSync(appExe, { force: true });
  if (fs.existsSync(setupExe)) fs.renameSync(setupExe, appExe);
  if (!fs.existsSync(appExe)) throw new Error("APP_EXE_NOT_FOUND");
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createShortcuts(options) {
  const exe = path.join(installDir, "Nodus Connect.exe");
  const programsDir = programsPath();
  const desktop = desktopShortcutPath();
  const startDir = path.join(programsDir, "Nodus Connect");
  const startupDir = path.join(programsDir, "Startup");
  fs.rmSync(path.join(programsDir, "Nodus Connect Setup.lnk"), { force: true });
  if (options.desktopShortcut) fs.mkdirSync(path.dirname(desktop), { recursive: true });
  fs.mkdirSync(startDir, { recursive: true });
  if (options.desktopShortcut) createShortcut(desktop, exe);
  createShortcut(path.join(startDir, "Nodus Connect.lnk"), exe);
  createShortcut(path.join(startDir, "Desinstalar Nodus Connect.lnk"), exe, "--uninstall");
  if (options.startWithWindows) {
    fs.mkdirSync(startupDir, { recursive: true });
    createShortcut(path.join(startupDir, "Nodus Connect.lnk"), exe);
  } else fs.rmSync(path.join(startupDir, "Nodus Connect.lnk"), { force: true });
}

function createShortcut(shortcutPath, targetPath, args = "") {
  const script = [
    "$w = New-Object -ComObject WScript.Shell",
    `$s = $w.CreateShortcut(${ps(shortcutPath)})`,
    `$s.TargetPath = ${ps(targetPath)}`,
    `$s.Arguments = ${ps(args)}`,
    `$s.WorkingDirectory = ${ps(installDir)}`,
    `$s.IconLocation = ${ps(targetPath)}`,
    "$s.Save()",
  ].join("; ");
  spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, stdio: "ignore" });
}

function writeUninstaller() {
  const file = path.join(installDir, "Desinstalar Nodus Connect.cmd");
  fs.writeFileSync(file, `@echo off\r\nstart "" "${path.join(installDir, "Nodus Connect.exe")}" --uninstall\r\n`);
}

function setDesktopShortcut(enabled) {
  const shortcut = desktopShortcutPath();
  if (!enabled) {
    fs.rmSync(shortcut, { force: true });
    return { ok: true };
  }
  fs.mkdirSync(path.dirname(shortcut), { recursive: true });
  createShortcut(shortcut, path.join(installDir, "Nodus Connect.exe"));
  return { ok: true };
}

function registerUninstaller() {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nodus Connect";
  const exe = path.join(installDir, "Nodus Connect.exe");
  const values = [
    ["DisplayName", "REG_SZ", productName],
    ["DisplayVersion", "REG_SZ", app.getVersion()],
    ["Publisher", "REG_SZ", productName],
    ["DisplayIcon", "REG_SZ", exe],
    ["InstallLocation", "REG_SZ", installDir],
    ["UninstallString", "REG_SZ", `\"${exe}\" --uninstall`],
    ["NoModify", "REG_DWORD", "1"],
    ["NoRepair", "REG_DWORD", "1"],
    ["EstimatedSize", "REG_DWORD", String(Math.ceil(getPayloadSize(installDir) / 1024))],
  ];
  spawnSync("reg.exe", ["ADD", key, "/f"], { windowsHide: true, stdio: "ignore" });
  for (const [name, type, value] of values) {
    const result = spawnSync("reg.exe", ["ADD", key, "/v", name, "/t", type, "/d", value, "/f"], { windowsHide: true, stdio: "ignore" });
    if (result.status !== 0) throw new Error("UNINSTALL_REGISTRATION_FAILED");
  }
}

function unregisterUninstaller() {
  spawnSync("reg.exe", ["DELETE", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nodus Connect", "/f"], { windowsHide: true, stdio: "ignore" });
}

function removeShortcuts() {
  fs.rmSync(desktopShortcutPath(), { force: true });
  fs.rmSync(path.join(programsPath(), "Startup", "Nodus Connect.lnk"), { force: true });
  fs.rmSync(path.join(programsPath(), "Nodus Connect"), { recursive: true, force: true });
}

function uninstallNodus(options = {}) {
  try {
    assertSafeInstallDir(installDir);
    const exe = path.join(installDir, "Nodus Connect.exe");
    if (!fs.existsSync(exe)) throw new Error("APP_EXE_NOT_FOUND");
    const serviceExe = path.join(installDir, "resources", "native", "nodus-service.exe");
    if (fs.existsSync(serviceExe)) spawnSync(serviceExe, ["--uninstall"], { windowsHide: true, stdio: "ignore" });
    removeShortcuts();
    unregisterUninstaller();

    const scriptPath = path.join(os.tmpdir(), `nodus-uninstall-${Date.now()}.ps1`);
    const userData = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), productName);
    const lines = [
      `$target = ${ps(installDir)}`,
      `$currentPid = ${process.pid}`,
      `Get-Process -Name 'Nodus Connect' -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $currentPid } | Stop-Process -Force -ErrorAction SilentlyContinue`,
      `Wait-Process -Id $currentPid -Timeout 30 -ErrorAction SilentlyContinue`,
      `Start-Sleep -Milliseconds 500`,
      `Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue`,
    ];
    if (options.removeUserData) lines.push(`Remove-Item -LiteralPath ${ps(userData)} -Recurse -Force -ErrorAction SilentlyContinue`);
    lines.push(`Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue`);
    fs.writeFileSync(scriptPath, lines.join("\r\n"));
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    setTimeout(() => app.quit(), 900);
    return { ok: true };
  } catch (error) {
    log(error?.stack || error?.message || String(error));
    return { ok: false, error: "Não foi possível remover o Nodus Connect. Feche o programa e tente novamente." };
  }
}

function programsPath() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs");
}

function desktopShortcutPath() {
  return path.join(app.getPath("desktop"), "Nodus Connect.lnk");
}

function launchInstalledApp() {
  const exe = path.join(installDir, "Nodus Connect.exe");
  if (!fs.existsSync(exe)) throw new Error("APP_EXE_NOT_FOUND");
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { cwd: installDir, detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
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
  if (message === "INSTALL_CANCELLED") return "Instalação cancelada. Nenhuma alteração incompleta foi mantida.";
  if (message === "INSUFFICIENT_DISK_SPACE") return "Não há espaço suficiente para instalar o Nodus Connect nesta unidade.";
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
