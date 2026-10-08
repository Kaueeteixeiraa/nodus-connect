const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const mode = process.argv.find(value => value.startsWith("--mode="))?.slice(7) || "desktop";
if (["wrapper", "portable"].includes(mode)) {
  const file = process.argv.find(value => value.startsWith("--file="))?.slice(7);
  const log = process.argv.find(value => value.startsWith("--log="))?.slice(6) || path.join(process.env.TEMP || os.tmpdir(), "nodus-connect-installer.log");
  if (!file || process.platform !== "win32") throw new Error("--mode=wrapper|portable --file=<arquivo.exe> requires Windows");
  const script = `
    $ErrorActionPreference = 'Stop'
    $began = [DateTime]::UtcNow
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $parent = Start-Process -FilePath $env:NODUS_LAB_SETUP -WindowStyle Hidden -PassThru
    $child = $null
    try {
      while ($clock.ElapsedMilliseconds -lt 90000 -and !$child) {
        foreach ($candidate in (Get-Process -Name $env:NODUS_LAB_PROCESS -ErrorAction SilentlyContinue)) {
          if ($candidate.StartTime.ToUniversalTime() -lt $began -or $candidate.MainWindowHandle -eq 0) { continue }
          $owner = (Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.Id)").ParentProcessId
          for ($depth = 0; $owner -and $depth -lt 16; $depth++) {
            if ($owner -eq $parent.Id) { $child = $candidate; break }
            $owner = (Get-CimInstance Win32_Process -Filter "ProcessId=$owner").ParentProcessId
          }
          if ($child) { break }
        }
        if (!$child) { Start-Sleep -Milliseconds 50 }
      }
      if (!$child) { throw 'OWNED_WINDOW_TIMEOUT' }
      $windowMs = $clock.ElapsedMilliseconds
      $usableMs = $null
      for ($i = 0; $i -lt 30 -and $null -eq $usableMs; $i++) {
        $log = $env:NODUS_LAB_LOG
        if (Test-Path -LiteralPath $log) {
          foreach ($line in (Get-Content -LiteralPath $log -Tail 40)) {
            if ($line -match '^\\[[^\\]]+\\] (\\{.*\\})$') {
              $record = $matches[1] | ConvertFrom-Json
              if ($record.processId -eq $child.Id -and $record.phase -eq 'ui-ready') { $usableMs = [Math]::Round(([DateTime]::Parse($record.at).ToUniversalTime() - $began).TotalMilliseconds) }
            }
          }
        }
        if ($null -eq $usableMs) { Start-Sleep -Milliseconds 50 }
      }
      @{mode=$env:NODUS_LAB_MODE;kind='real-container-local-no-install';windowMs=$windowMs;usableMs=$usableMs} | ConvertTo-Json -Compress
    } finally {
      if ($child -and !$child.HasExited) { [void]$child.CloseMainWindow(); if (!$child.WaitForExit(10000)) { Stop-Process -Id $child.Id -Force } }
      if (!$parent.WaitForExit(10000)) { Stop-Process -Id $parent.Id -Force }
    }
  `;
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 125000, env: { ...process.env, NODUS_LAB_SETUP: path.resolve(file), NODUS_LAB_PROCESS: mode === "wrapper" ? "Nodus Connect Setup" : "Nodus Connect", NODUS_LAB_MODE: mode, NODUS_LAB_LOG: path.resolve(log) } }, (error, stdout, stderr) => {
    console.log(stdout.trim()); if (error) console.error(stderr || error.message); app.exit(error ? 1 : 0);
  });
  return;
}
if (!["desktop", "installer"].includes(mode)) throw new Error("--mode=desktop|installer");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodus-startup-lab-"));
process.env.NODUS_USER_DATA_DIR = root;
app.setPath("userData", root);
const elapsed = () => Math.round(process.uptime() * 1000);
const result = { mode, kind: "unpacked-local-offline", windowMs: null, readyToShowMs: null, usableMs: null, blockedRequests: 0 };
let done = false;
// The lab never contacts production or closes another Nodus process.
BrowserWindow.prototype.show = function () {};
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => {
  result.blockedRequests++;
  callback({ cancel: true });
}));
function finish(error) {
  if (done) return;
  done = true;
  console.log(JSON.stringify({ ...result, ...(error ? { error: String(error) } : {}) }));
  app.exit(error ? 1 : 0);
}
app.on("browser-window-created", (_event, win) => {
  if (result.windowMs !== null) return;
  result.windowMs = elapsed();
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) console.error(message); });
  win.once("ready-to-show", () => { result.readyToShowMs = elapsed(); });
  win.webContents.once("did-finish-load", async () => {
    try {
      await win.webContents.executeJavaScript(`new Promise(resolve => {
        const check = () => {
          const ready = ${mode === "installer" ? 'document.documentElement.dataset.ready' : 'Array.from(document.querySelectorAll("button")).some(button => !button.disabled && button.getBoundingClientRect().height > 0)'};
          if (ready) resolve();
          else setTimeout(check, 10);
        }; check();
      })`);
      result.usableMs = elapsed();
      finish();
    } catch (error) { finish(error); }
  });
  win.webContents.once("did-fail-load", (_event, code, message) => finish(`${code}: ${message}`));
});
setTimeout(() => finish("STARTUP_TIMEOUT"), 20000).unref();
require(path.resolve(__dirname, mode === "installer" ? "../apps/installer/main.cjs" : "../apps/desktop/electron/main.cjs"));
