import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { createContext, runInContext, runInNewContext } from "node:vm";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity, ArrowRight, Gauge, Grid2X2, List, Monitor, Search, UserRound } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { translateText } from "../apps/desktop/src/core/localization";
import { advanceStage, assessQuality, DESKTOP_VIDEO_POLICY, nativeVideoBitrate, nextBitrate, STAGE_LIMITS } from "../apps/desktop/src/core/adaptive-quality";
import { LicenseError, LICENSE_MESSAGES } from "../packages/licensing/src/index";
import { mapVideoPointer } from "../apps/desktop/src/core/remote-cursor";
import { formatNodusId, normalizeNodusId } from "../packages/common/src/nodusId";

const { RemoteWindowsKeys, keyboardInput } = createRequire(import.meta.url)("../apps/desktop/electron/remote-windows-keys.cjs");
const managers: any[] = [];
afterEach(() => { managers.splice(0).forEach((manager) => manager.dispose()); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }), kill: vi.fn() });
  const window = { isFocused: vi.fn(() => true), isDestroyed: vi.fn(() => false), getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), webContents: { isDestroyed: () => false, send: vi.fn() } };
  const launch = vi.fn(() => child), log = vi.fn();
  const manager = new RemoteWindowsKeys({ spawn: launch, executable: "native.exe", log });
  managers.push(manager);
  return { manager, child, window, launch, log };
}

function inputDiagnosticFixture(enabled = true, native = true) {
  vi.useFakeTimers();
  const source = ts.createSourceFile("main.cjs", readFileSync("apps/desktop/electron/main.cjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = source.statements.filter((node) => ts.isFunctionDeclaration(node) && ["measureRemoteInput", "observeInputProbes"].includes(node.name?.text ?? "")).map((node) => node.getText(source)).join("\n");
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { writableLength: 0, write: vi.fn() }), nodusBinaryInput: native });
  const apply = vi.fn(() => ({ ok: true }));
  const context = createContext({ Buffer, performance: { now: () => Date.now() }, setTimeout, clearTimeout,
    performanceDiagnostic: { inputLatency: enabled }, remoteControlActive: true, inputProbes: new Map(), inputProbeSequence: 0,
    ensureInputHelper: () => child, applyRemoteInput: apply, normalizeRemoteInput: (input: any) => input,
    captureOptions: {}, screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ bounds: {} }) },
  });
  runInContext(declarations, context);
  const observe = runInContext("observeInputProbes", context);
  observe(child);
  const measure = runInContext("measureRemoteInput", context);
  return { child, apply, measure, context };
}

test("input sample uses the original injection and waits for the native barrier, not stdin.write", async () => {
  const { child, apply, measure } = inputDiagnosticFixture();
  const input = { type: "mouseMove", x: 4, y: 6 };
  const pending = measure(input);
  expect(apply).toHaveBeenCalledExactlyOnceWith(input);
  const packet = child.stdin.write.mock.calls[0][0];
  expect(packet.length).toBe(16); expect(packet.readUInt8(0)).toBe(7);
  let settled = false;
  pending.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  child.stdout.emit("data", Buffer.from("P 1 1 4"));
  expect(settled).toBe(false);
  child.stdout.emit("data", Buffer.from(" 6\n"));
  await expect(pending).resolves.toMatchObject({ ok: true, positionConfirmed: true, windowsPosition: { x: 4, y: 6 } });
});

test.each(["exit", "error"])("native %s finishes pending measurements without leaving timers", async (event) => {
  const { child, measure, context } = inputDiagnosticFixture();
  const pending = measure({ type: "mouseMove", x: 4, y: 6 });
  child.emit(event, event === "error" ? new Error("helper failed") : 1);
  await expect(pending).resolves.toMatchObject({ ok: false, error: "NATIVE_HELPER_EXITED" });
  expect(context.inputProbes.size).toBe(0);
});

test("measurement backpressure never prevents regular input", async () => {
  const { measure, apply, child } = inputDiagnosticFixture();
  child.stdin.writableLength = 65;
  await expect(measure({ type: "mouseMove", x: 1, y: 2 })).resolves.toMatchObject({ ok: false, error: "INPUT_PROBE_BACKPRESSURE" });
  expect(apply).toHaveBeenCalledOnce();
});

test("missing native ACK expires honestly and does not interrupt input", async () => {
  const { measure, context } = inputDiagnosticFixture();
  const pending = measure({ type: "mouseMove", x: 4, y: 6 });
  await vi.advanceTimersByTimeAsync(2000);
  await expect(pending).resolves.toMatchObject({ ok: false, error: "NATIVE_ACK_TIMEOUT" });
  expect(context.inputProbes.size).toBe(0);
});

test("diagnostics stay disabled by default and preserve the PowerShell fallback", async () => {
  const disabled = inputDiagnosticFixture(false);
  await expect(disabled.measure({ type: "mouseMove", x: 0, y: 0 })).resolves.toMatchObject({ ok: false });
  expect(disabled.apply).not.toHaveBeenCalled();
  const fallback = inputDiagnosticFixture(true, false);
  await expect(fallback.measure({ type: "mouseMove", x: 0, y: 0 })).resolves.toMatchObject({ ok: false, error: "NATIVE_ACK_UNAVAILABLE" });
  expect(fallback.apply).toHaveBeenCalledOnce();
});

test("input-only diagnostic flag does not change FPS, bitrate, resolution or adaptive quality", () => {
  const source = ts.createSourceFile("main.cjs", readFileSync("apps/desktop/electron/main.cjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "getPerformanceDiagnostic")!;
  const context = { diagnosticPresets: {}, getDiagnosticPresetArgument: () => "", process: { env: {}, argv: [] as string[] } };
  const diagnostic = runInNewContext(`${declaration.getText(source)}; getPerformanceDiagnostic`, context);
  expect(diagnostic()).toBeNull();
  context.process.argv.push("--diagnostic-input");
  expect(diagnostic()).toMatchObject({ inputLatency: true, inputOnly: true, fps: undefined, maxFramerate: undefined, bitrate: undefined, resolution: undefined, lockAdaptive: false });
  expect(readFileSync("apps/desktop/src/App.tsx", "utf8")).toContain("performanceDiagnosticRef.current = value?.inputOnly ? null : value;");
});

test("legacy pointer packets retain nine bytes and sampled packets preserve coordinates", () => {
  const encode = uiFunction("encodePointerMessage"), decode = uiFunction("decodePointerMessage");
  const legacy = encode(0.25, 0.75);
  expect(legacy.byteLength).toBe(9);
  expect(decode(legacy)).toEqual({ type: "mouseMove", x: 0.25, y: 0.75 });
  const sample = encode(0.25, 0.75, 42);
  expect(sample.byteLength).toBe(13);
  expect(decode(sample)).toEqual({ type: "mouseMove", x: 0.25, y: 0.75, probeId: 42 });
  expect(decode(new ArrayBuffer(12))).toBeNull();
});

test("Windows key interception starts only for a focused authorized viewer window", () => {
  const { manager, window, launch } = fixture();
  window.isFocused.mockReturnValue(false);
  manager.setActive(window);
  expect(launch).not.toHaveBeenCalled();
  window.isFocused.mockReturnValue(true);
  manager.setActive(window); manager.setActive(window);
  expect(launch).toHaveBeenCalledExactlyOnceWith("native.exe", ["--windows-key-helper", String(process.pid), "1"], expect.anything());
});

test.each([68, 69, 82, 37])("Win shortcut key %s is forwarded once with its extended-key identity", (key) => {
  const { manager, child, window } = fixture();
  manager.setActive(window);
  child.stdout.emit("data", Buffer.from(`K 5 91 1\nK 5 ${key} ${key === 37 ? 1 : 0}\nK 6 ${key} ${key === 37 ? 1 : 0}\nK 6 91 1\n`));
  expect(window.webContents.send.mock.calls.map((call) => call[1])).toEqual(["keyDown", "keyDown", "keyUp", "keyUp"]);
  expect(window.webContents.send.mock.calls[1][2].keyCode).toBe(key);
  expect(window.webContents.send.mock.calls[1][2].code).toBe(key === 37 ? "ArrowLeft" : `Key${String.fromCharCode(key)}`);
});

test("fragmented native output and repeats retain a single modifier state", () => {
  const { manager, child, window } = fixture();
  manager.setActive(window);
  child.stdout.emit("data", Buffer.from("K 5 9"));
  child.stdout.emit("data", Buffer.from("2 1\nK 5 92 1\n"));
  expect(window.webContents.send.mock.calls[0][2]).toMatchObject({ code: "MetaRight", location: 2, repeat: false });
  expect(window.webContents.send.mock.calls[1][2].repeat).toBe(true);
  manager.stop();
  expect(window.webContents.send.mock.calls[2][1]).toBe("keyUp");
});

test("focus loss stops interception and releases all remote Windows keys", async () => {
  const { manager, child, window } = fixture();
  manager.setActive(window);
  child.stdout.emit("data", Buffer.from("K 5 91 1\nK 5 69 0\n"));
  window.isFocused.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(child.stdin.end).toHaveBeenCalledWith("R");
  expect(window.webContents.send.mock.calls.slice(-2).map((call) => call[1])).toEqual(["keyUp", "keyUp"]);
  child.stdout.emit("data", Buffer.from("K 5 91 1\n"));
  expect(window.webContents.send).toHaveBeenCalledTimes(4);
});

test("an inactive window cannot stop another window's active capture", () => {
  const { manager, child, window } = fixture();
  manager.setActive(window);
  manager.stop({});
  expect(child.stdin.end).not.toHaveBeenCalled();
});

test("helper failure releases modifiers without breaking the session", () => {
  const { manager, child, window, log } = fixture();
  manager.setActive(window);
  child.stdout.emit("data", Buffer.from("K 5 91 1\n"));
  expect(() => child.emit("error", new Error("denied"))).not.toThrow();
  expect(window.webContents.send).toHaveBeenLastCalledWith("nodus:remote-key-input", "keyUp", expect.objectContaining({ keyCode: 91 }));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("denied"));
});

test("native code identity distinguishes right modifiers and numpad Enter", () => {
  expect(keyboardInput(17, true).code).toBe("ControlRight");
  expect(keyboardInput(18, true).code).toBe("AltRight");
  expect(keyboardInput(13, true).code).toBe("NumpadEnter");
});

test("remote keyboard preserves modifier sides, ABNT2 keys and intercepts Alt shortcuts", () => {
  const keyFromCode = uiFunction("virtualKeyFromCode");
  expect(["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight"].map(keyFromCode))
    .toEqual([160, 161, 162, 163, 164, 165]);
  expect(keyFromCode("IntlBackslash")).toBe(226);
  const native = readFileSync("native/service/main.cpp", "utf8");
  expect(native).toContain("key.vkCode == VK_LMENU || key.vkCode == VK_RMENU");
  expect(native).toContain("if (!pressedKeys[key]) continue;");
});

test.each(["en-US", "ru-RU", "ja-JP"] as const)("remote and main UI strings are covered in %s", (language) => {
  for (const label of ["Computador ativo", "Perfil de qualidade", "Permissões desta sessão", "Buscar atualizações", "Teclado remoto", "Gargalo", "Escolha o ambiente visual do Nodus Connect."]) {
    expect(translateText(label, language)).not.toBe(label);
  }
  expect(translateText("Nodus Connect", language)).toBe("Nodus Connect");
  expect(translateText("1366 × 768", language)).toBe("1366 × 768");
  expect(translateText("   ", language)).toBe("   ");
});

test("dynamic translation keeps user names, paths, versions and progress intact", () => {
  expect(translateText("Bem-vindo de volta, Kauê.", "en-US")).toBe("Welcome back, Kauê.");
  expect(translateText("Nova versão disponível: 0.4.25", "ja-JP")).toContain("0.4.25");
  expect(translateText("Salvo em C:\\$&\\Documents", "en-US")).toBe("Saved to C:\\$&\\Documents");
  expect(translateText("Enviando 75%", "ru-RU")).toContain("75%");
});

test("header has no release notes while settings retain automatic updates and incoming notifications", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  expect(source).not.toContain("release-notifications");
  expect(source).not.toContain("releaseNotes");
  expect(source).not.toContain('aria-label="Notas das versões"');
  expect(source).toContain("onClick={checkForUpdates}");
  expect(source).toContain("window.nodusDesktop?.checkForUpdates()");
  expect(source).toContain('label="Notificar pedidos recebidos"');
});

test("catalog and favorites use different labels without changing removal callbacks", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  expect(source).toContain('deleteLabel={favorite ? "Remover dos favoritos" : "Remover da lista"}');
  expect(source).toContain('onClick={() => { onDelete(); closeMenu(); }}');
  for (const language of ["en-US", "ru-RU", "ja-JP"] as const) {
    expect(translateText("Remover da lista", language)).not.toBe("Remover da lista");
    expect(translateText("Remover dos favoritos", language)).not.toBe("Remover dos favoritos");
  }
});

test("clipboard labels describe manual sending and receiving in every language", () => {
  for (const language of ["en-US", "ru-RU", "ja-JP"] as const) {
    for (const text of ["Receber texto copiado", "Permitir recebimento de texto copiado", "Enviar manualmente o texto copiado para o computador remoto"]) expect(translateText(text, language)).not.toBe(text);
  }
  expect(readFileSync("apps/desktop/src/App.tsx", "utf8")).toContain('{ permission: "clipboard:sync", label: "Receber texto copiado" }');
});

test("icon actions have accessible names and translated tooltips", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  for (const label of ["Copiar Nodus ID", "Métricas da conexão", "Quadros recebidos por segundo", "Fechar painel", "Exibição em grade", "Exibição em lista"]) {
    expect(source).toContain(`aria-label="${label}"`);
    expect(source).toContain(`title="${label}"`);
    for (const language of ["en-US", "ru-RU", "ja-JP"] as const) expect(translateText(label, language)).not.toBe(label);
  }
});

test("profile display does not sign out and logout has its own action", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  expect(source).toContain('<div className="user-chip" title={currentUser.name}>');
  expect(source).not.toContain('<button className="user-chip" onClick={logout}');
  expect(source).toContain('aria-label="Sair" className="logout-button" onClick={logout} title="Sair"');
});

test("login offers only guest and Google access with the existing callbacks", () => {
  const gate = uiFunction("AccessGate", { React, ArrowRight, UserRound, nodusLogo: "logo.png", googleLogo: "google.png" });
  const onGoogle = vi.fn(), onLocal = vi.fn();
  const element = gate({ error: "", googleReady: true, identity: { deviceName: "Host" }, onGoogle, onLocal });
  const markup = renderToStaticMarkup(element);
  expect(markup.match(/<button\b/g)).toHaveLength(2);
  expect(markup.match(/class="themed-action"/g)).toHaveLength(2);
  expect(markup).toContain("Entrar sem conta");
  expect(markup).toContain("Entrar com o Google");
  expect(markup).toContain('<img src="logo.png" alt=""');
  expect(markup).toContain('<img class="google-signin-logo" src="google.png" alt=""');
  expect(markup).not.toContain('>G</span>');
  expect(markup).toContain('<h1>NODUS<span>Connect</span></h1>');
  expect(markup).not.toMatch(/<input|<form|Criar conta|Lembrar de mim|Recuperação|account-security/);
  const buttons = element.props.children.props.children.filter((child: any) => child?.type === "button");
  buttons[0].props.onClick(); buttons[1].props.onClick();
  expect(onLocal).toHaveBeenCalledExactlyOnceWith("Host");
  expect(onGoogle).toHaveBeenCalledOnce();
});

test("login errors remain accessible without adding sign-in choices", () => {
  const gate = uiFunction("AccessGate", { React, ArrowRight, UserRound, nodusLogo: "logo.png", googleLogo: "google.png" });
  const markup = renderToStaticMarkup(gate({ error: "Google unavailable", googleReady: false, identity: {}, onGoogle: vi.fn(), onLocal: vi.fn() }));
  expect(markup).toContain('role="alert">Google unavailable');
  expect(markup).toContain('title="O login Google requer o aplicativo instalado"');
  expect(markup.match(/<button\b/g)).toHaveLength(2);
});

test.each(["en-US", "ru-RU", "ja-JP"] as const)("simplified login is translated in %s", (language) => {
  for (const text of ["Entrar sem conta", "Entrar com o Google", "Acesso ao Nodus"]) expect(translateText(text, language)).not.toBe(text);
});

test("requested video settings and existing applied metrics have distinct labels", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  for (const label of ["Perfil solicitado", "Resolução solicitada", "FPS solicitado", "Vídeo aplicado", "FPS recebidos", "FPS apresentados", "Aguardando confirmação do host"]) {
    expect(source).toContain(label);
    for (const language of ["en-US", "ru-RU", "ja-JP"] as const) expect(translateText(label, language)).not.toBe(label);
  }
});

test("audio availability is read-only and fullscreen does not pretend to know native state", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  expect(source).toContain('hasRemoteAudio={Boolean(remoteStream?.getAudioTracks().some((track) => track.readyState === "live"))}');
  expect(source).toContain('disabled={!audioAvailable} title={audioTooltip} onClick={onToggleRemoteAudio}');
  expect(source).toContain('title="Alternar tela cheia" onClick={enterFullscreen}');
  for (const language of ["en-US", "ru-RU", "ja-JP"] as const) for (const text of ["Áudio indisponível", "O host não autorizou o áudio.", "Áudio indisponível. Nenhuma faixa de áudio recebida.", "Alternar tela cheia"]) expect(translateText(text, language)).not.toBe(text);
});

test("recording can safely select remote audio, microphone, both or no audio", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  for (const mode of ["none", "remote", "microphone", "both"]) expect(source).toContain(`<option value="${mode}">`);
  expect(source).toContain("navigator.mediaDevices.getUserMedia({ video: false, audio:");
  expect(source).toContain("audioContext.createMediaStreamDestination()");
  expect(source).toContain("track.clone()");
  expect(source).toContain("microphone?.getTracks().forEach((track) => track.stop())");
});

test("remote toolbar sends explicit Windows shortcuts through the existing control channel", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  expect(source).toContain('keyCode: 164, code: "AltLeft"');
  expect(source).toContain('keyCode: 9, code: "Tab"');
  expect(source).toContain('keyCode: 91, code: "MetaLeft"');
  for (const language of ["en-US", "ru-RU", "ja-JP"] as const) {
    for (const text of ["Alternar janela no computador remoto", "Abrir menu Iniciar no computador remoto", "Tecla Windows"]) expect(translateText(text, language)).not.toBe(text);
  }
});

function secureAttentionHandler() {
  const source = ts.createSourceFile("main.cjs", readFileSync("apps/desktop/electron/main.cjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let handler = "";
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "ipcMain.handle" && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "nodus:send-secure-attention") handler = node.arguments[1].getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
  const spawn = vi.fn(() => child), sender = {}, context = { mainWindow: { webContents: sender }, remoteControlActive: true, process: { platform: "win32" }, fs: { existsSync: () => true }, nativeService: "native.exe", lastSecureAttentionAt: 0, spawn, setTimeout, clearTimeout, Date };
  return { invoke: () => runInNewContext(`(${handler})`, context), context, child, spawn, sender };
}

test("unavailable controls explain channel and permission states without changing callbacks", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  expect(source).toContain('title={clipboardTooltip} disabled={!controlReady || !session.permissions.includes("clipboard:sync")} onClick={onClipboard}');
  for (const language of ["en-US", "ru-RU", "ja-JP"] as const) {
    for (const text of ["O host não autorizou esta ação.", "Canal de controle indisponível. Aguarde a conexão ou reconecte.", "Transferência indisponível. Verifique a permissão e aguarde o canal de arquivos."]) expect(translateText(text, language)).not.toBe(text);
  }
});

function uiFunction(name: string, context = {}, file = "apps/desktop/src/App.tsx") {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  let node: ts.FunctionDeclaration | ts.VariableDeclaration | undefined;
  const visit = (current: ts.Node) => {
    if (ts.isFunctionDeclaration(current) && current.name?.text === name) node = current;
    else if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.name.text === name && current.initializer && ts.isArrowFunction(current.initializer)) node = current;
    else ts.forEachChild(current, visit);
  };
  visit(source);
  if (!node) throw new Error(`UI function missing: ${name}`);
  const code = ts.transpileModule(`${ts.isVariableDeclaration(node) ? "const " : ""}${node.getText(source)}`, { fileName: file.endsWith(".cjs") ? "fixture.ts" : file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  for (const [key, value] of Object.entries({ payloadWrapper: "", payloadMetadata: undefined, logConnectionPhase: vi.fn(), connectionTimingsRef: { current: new Map() }, performance: { now: () => Date.now() }, clearTimeout })) {
    if (!(key in context)) Object.assign(context, { [key]: value });
  }
  return runInNewContext(`${code};${name}`, context);
}

test.each([
  ["", "all", ["host", "987654321", "111222333"]],
  ["  cLiEnTe  ", "all", ["987654321"]],
  ["CAIXA", "all", ["987654321"]],
  ["111222", "all", ["111222333"]],
  ["cliente", "online", ["987654321"]],
  ["cliente", "offline", []],
  ["filial", "offline", ["111222333"]],
  ["inexistente", "all", []],
] as const)("device search %s combines name, alias and ID with %s filter", (query, filter, expected) => {
  const state: unknown[] = [filter, "grid", query];
  const Devices = uiFunction("Devices", { React, Grid2X2, List, Search, formatNodusId, currentLocale: () => "pt-BR", navigateUiTabs: vi.fn(),
    useState: () => [state.shift(), vi.fn()], DeviceCard: ({ current, item }: any) => React.createElement("article", { "data-device-id": current ? "host" : item.nodusId }) });
  const markup = renderToStaticMarkup(Devices({ identity: { deviceName: "Tecnico", nodusId: "123456789" }, items: [
    { nodusId: "987654321", deviceName: "Cliente", alias: "Caixa", status: "online" },
    { nodusId: "111222333", deviceName: "Filial", status: "offline" },
  ], favorites: [], onConnect: vi.fn(), onDeleteDevice: vi.fn(), onRenameDevice: vi.fn(), onToggleFavorite: vi.fn() }));
  expect([...markup.matchAll(/data-device-id="([^"]+)"/g)].map(match => match[1])).toEqual(expected);
  expect(markup).toContain('placeholder="Buscar dispositivos..."');
  expect(markup.includes("Nenhum dispositivo encontrado.")).toBe(expected.length === 0);
});

const updateMain = "apps/desktop/electron/main.cjs";
const desktopUpdates = createRequire(import.meta.url)("../apps/desktop/electron/desktop-update.cjs");
function releaseFixture(version = "1.1.11") {
  return { tag_name: `v${version}`, assets: [{ name: `Nodus-Connect-Setup-${version}.exe`,
    browser_download_url: `https://github.com/Kaueeteixeiraa/nodus-connect/releases/download/v${version}/Nodus-Connect-Setup-${version}.exe`,
    digest: `sha256:${"a".repeat(64)}`, size: 100 }] };
}

test("updater compares numeric versions and never installs a downgrade", () => {
  const release = desktopUpdates.updateRelease;
  expect(release(releaseFixture("1.1.10"), "1.1.9").available).toBe(true);
  expect(release(releaseFixture("1.1.9"), "1.1.10").available).toBe(false);
  expect(release(releaseFixture(), "1.1.11").available).toBe(false);
  for (const changed of [{ prerelease: true }, { draft: true }, { tag_name: "v1.2.3-beta" }]) {
    expect(() => release({ ...releaseFixture(), ...changed }, "1.1.10")).toThrow("INVALID_UPDATE");
  }
  for (const changed of [{ digest: null }, { digest: "invalid" }, { size: 0 }, { size: 400 * 1024 * 1024 }, { browser_download_url: "https://example.com/setup.exe" }]) {
    const fixture = releaseFixture(); Object.assign(fixture.assets[0], changed);
    expect(() => release(fixture, "1.1.10")).toThrow("INVALID_UPDATE");
  }
});

test.each(["valid", "hash", "truncated", "oversize", "network"])("verified download handles %s without retaining partial installers", async (mode) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nodus-update-test-"));
  const destination = path.join(directory, "setup.exe"), payload = Buffer.from("official installer");
  const digest = crypto.createHash("sha256").update(payload).digest("hex");
  const context = { fs, crypto, require: createRequire(import.meta.url), AbortController, setTimeout, clearTimeout,
    fetch: async () => mode === "network" ? Promise.reject(new Error("offline")) : new Response(payload),
    hashFile: uiFunction("hashFile", { fs, crypto }, updateMain) };
  const download = uiFunction("downloadVerifiedFile", context, updateMain), progress = vi.fn();
  try {
    const pending = download("https://github.com/test", destination, mode === "hash" ? "0".repeat(64) : digest,
      payload.length + (mode === "truncated" ? 1 : mode === "oversize" ? -1 : 0), progress);
    if (mode === "valid") { await pending; expect(fs.readFileSync(destination)).toEqual(payload); expect(progress).toHaveBeenCalledWith(100); }
    else { await expect(pending).rejects.toThrow(); expect(fs.existsSync(destination)).toBe(false); }
    expect(fs.readdirSync(directory).filter(name => name.endsWith(".tmp"))).toEqual([]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function updateFlowFixture() {
  const context: any = { updateInProgress: false, activeSessionCount: 0, portableSupport: false, isQuitting: false,
    app: { isPackaged: true, getVersion: () => "1.1.10", getPath: () => "C:\\cache", getLoginItemSettings: () => ({ openAtLogin: true }) },
    process: { platform: "win32", execPath: "C:\\Programs\\Nodus Connect\\Nodus Connect.exe" }, path: path.win32, crypto, AbortSignal,
    fs: { mkdirSync: vi.fn(), existsSync: () => false, writeFileSync: vi.fn(), rmSync: vi.fn() },
    fetch: vi.fn(async () => ({ ok: true, json: async () => releaseFixture() })),
    downloadVerifiedFile: vi.fn(async (_url, _file, _sha, _size, progress) => progress(50)),
    updateRelease: desktopUpdates.updateRelease, releasedStartupUpdate: vi.fn(async () => desktopUpdates.updateRelease(releaseFixture(), "1.1.10")), launchUpdate: vi.fn(async () => {}),
    appendLog: vi.fn(), setTimeout: vi.fn(), quitApp: vi.fn() };
  const sender = { isDestroyed: () => false, send: vi.fn() };
  return { context, sender, check: uiFunction("checkAndInstallUpdate", context, updateMain) };
}

test("automatic update checks sessions before and after download and preserves startup options", async () => {
  const { check, context, sender } = updateFlowFixture();
  context.activeSessionCount = 1;
  expect((await check(sender)).ok).toBe(false); expect(context.downloadVerifiedFile).not.toHaveBeenCalled();
  context.activeSessionCount = 0;
  context.downloadVerifiedFile.mockImplementationOnce(async () => { context.activeSessionCount = 1; });
  expect((await check(sender)).ok).toBe(false); expect(context.launchUpdate).not.toHaveBeenCalled();
  context.activeSessionCount = 0;
  expect(await check(sender)).toMatchObject({ ok: true, installing: true });
  expect(JSON.parse(context.fs.writeFileSync.mock.calls[0][1])).toEqual({ installDir: "C:\\Programs\\Nodus Connect", startWithWindows: true });
  expect(context.setTimeout).toHaveBeenCalledWith(context.quitApp, 250);
  expect((await check(sender)).ok).toBe(false); expect(context.launchUpdate).toHaveBeenCalledTimes(1);
});

test.each(["download", "spawn", "current"])("updater keeps the app open after %s and allows retry", async (mode) => {
  const { check, context, sender } = updateFlowFixture();
  if (mode === "download") context.downloadVerifiedFile.mockRejectedValueOnce(new Error("offline"));
  if (mode === "spawn") context.launchUpdate.mockRejectedValueOnce(new Error("denied"));
  if (mode === "current") context.fetch.mockResolvedValueOnce({ ok: true, json: async () => releaseFixture("1.1.10") });
  expect((await check(sender)).ok).toBe(mode === "current");
  expect(context.setTimeout).not.toHaveBeenCalled(); expect(context.updateInProgress).toBe(false);
});

test.each(["approved", "paused", "changed", "offline", "active", "closed", "quitting", "portable", "development", "cooldown"])("startup distribution handles %s without unsafe installation", async mode => {
  const { check, context, sender } = updateFlowFixture();
  if (mode === "paused") context.releasedStartupUpdate.mockResolvedValue({ available: false });
  if (mode === "changed") context.releasedStartupUpdate.mockResolvedValueOnce(desktopUpdates.updateRelease(releaseFixture(), "1.1.10")).mockResolvedValueOnce({ available: false });
  if (mode === "offline") context.releasedStartupUpdate.mockRejectedValue(new Error("offline"));
  if (mode === "active") context.downloadVerifiedFile.mockImplementationOnce(async () => { context.activeSessionCount = 1; });
  if (mode === "closed") sender.isDestroyed = () => true;
  if (mode === "quitting") context.isQuitting = true;
  if (mode === "portable") context.portableSupport = true;
  if (mode === "development") context.app.isPackaged = false;
  if (mode === "cooldown") context.fs.readFileSync = () => JSON.stringify({ sha256: "a".repeat(64), at: Date.now() });
  const result = await check(sender, true);
  expect(context.fetch).not.toHaveBeenCalled();
  expect(context.launchUpdate).toHaveBeenCalledTimes(mode === "approved" ? 1 : 0);
  expect(context.setTimeout).toHaveBeenCalledTimes(mode === "approved" ? 1 : 0);
  expect(result.installing === true).toBe(mode === "approved");
});

test("startup policy verifies the pinned signing key before consulting the installer", async () => {
  const keys = crypto.generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const token = desktopUpdates.signPolicy({ enabled: true, release: releaseFixture(), updatedAt: Date.now() }, keys.privateKey);
  const context = { fetch: vi.fn(async () => new Response(JSON.stringify({ token }))), desktopUpdates, supportKey: keys.publicKey, AbortSignal,
    updateRelease: desktopUpdates.updateRelease, app: { getVersion: () => "1.1.10" } };
  const check = uiFunction("releasedStartupUpdate", context, updateMain);
  expect(await check()).toMatchObject({ available: true, version: "1.1.11" });
  context.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ token: token.replace(/^./, "x") })));
  await expect(check()).rejects.toThrow("INVALID_UPDATE_POLICY");
  context.fetch.mockResolvedValueOnce(new Response("x".repeat(10_001)));
  await expect(check()).rejects.toThrow("INVALID_UPDATE_POLICY");
});

test("only the trusted main renderer starts one update check per application launch", () => {
  const listeners = new Map(), context = { startupUpdateChecked: false, ipcMain: { on: (name: string, handler: unknown) => listeners.set(name, handler), handle: vi.fn() },
    isMainAppSender: (event: any) => event.trusted === true, markStartup: vi.fn(), checkAndInstallUpdate: vi.fn() };
  uiFunction("setupIpc", context, updateMain)();
  const ready = listeners.get("nodus:ui-ready"), sender = {};
  ready({ sender }); expect(context.checkAndInstallUpdate).not.toHaveBeenCalled();
  ready({ sender, trusted: true }); ready({ sender, trusted: true });
  expect(context.checkAndInstallUpdate).toHaveBeenCalledExactlyOnceWith(sender, true);
});

test.each([true, false])("automatic installer reopens installed or rolled-back application (success: %s)", async (ok) => {
  const context: any = { path: path.win32, fs: { statSync: () => ({ size: 100 }), readFileSync: () => JSON.stringify({ installDir: "C:\\Programs\\Nodus Connect", startWithWindows: false }), existsSync: () => true },
    realPath: (value) => value, assertSafeInstallDir: vi.fn(), installDir: "", desktopShortcutPath: () => "desktop.lnk",
    installNodus: vi.fn(async () => ({ ok, error: ok ? undefined : "rollback" })), launchInstalledApp: vi.fn(async () => {}), log: vi.fn(), dialog: { showErrorBox: vi.fn() } };
  const apply = uiFunction("applyAutomaticUpdate", context, "apps/installer/main.cjs");
  expect(await apply("C:\\cache\\update.json")).toBe(ok);
  expect(context.installNodus).toHaveBeenCalledWith(expect.any(Function), { installDir: "C:\\Programs\\Nodus Connect", startWithWindows: false, desktopShortcut: true });
  expect(context.launchInstalledApp).toHaveBeenCalledTimes(1);
  expect(context.dialog.showErrorBox).toHaveBeenCalledTimes(ok ? 0 : 1);
});

test("automatic installer rejects malformed options before modifying an installation", async () => {
  const install = vi.fn();
  const apply = uiFunction("applyAutomaticUpdate", { path: path.win32, fs: { statSync: () => ({ size: 4097 }) }, installNodus: install, log: vi.fn(), dialog: { showErrorBox: vi.fn() } }, "apps/installer/main.cjs");
  expect(await apply("relative.json")).toBe(false); expect(await apply("C:\\cache\\update.json")).toBe(false);
  expect(install).not.toHaveBeenCalled();
});

test.each([true, false])("real staging preserves user data and restores the old executable on failure (success: %s)", async (ok) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodus-install-test-"));
  const source = path.join(root, "payload"), target = path.join(root, "Nodus Connect"), data = path.join(root, "user-data.json");
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, "Nodus Connect Setup.exe"), "new-version");
  fs.writeFileSync(path.join(target, "Nodus Connect.exe"), "old-version"); fs.writeFileSync(data, "identity-license-settings");
  const context: any = { fs, path, os, productName: "Nodus Connect", installDir: target, installing: false, cancelRequested: false,
    process: { execPath: path.join(source, "Nodus Connect Setup.exe") }, realPath: (value) => value,
    getPayloadSize: () => 20, getFreeDiskBytes: () => 1000, stopNodusForUpdate: vi.fn(() => false), restartNodusService: vi.fn(),
    removeDir: (value) => fs.rmSync(value, { recursive: true, force: true }), copyTree: async (from, to) => fs.cpSync(from, to, { recursive: true }),
    createShortcuts: vi.fn(), writeUninstaller: vi.fn(), registerUninstaller: () => { if (!ok) throw new Error("registry failed"); }, log: vi.fn(), friendlyError: (error) => error.message };
  for (const name of ["normalizeInstallDir", "assertSafeInstallDir", "assertSafeAuxiliaryDir", "isSameOrInside", "throwIfCancelled", "renameInstalledExe"]) {
    context[name] = uiFunction(name, context, "apps/installer/main.cjs");
  }
  try {
    const install = uiFunction("installNodus", context, "apps/installer/main.cjs");
    expect((await install(vi.fn(), { installDir: target })).ok).toBe(ok);
    expect(fs.readFileSync(path.join(target, "Nodus Connect.exe"), "utf8")).toBe(ok ? "new-version" : "old-version");
    expect(fs.readFileSync(data, "utf8")).toBe("identity-license-settings");
    expect(fs.existsSync(`${target}.installing`)).toBe(false); expect(fs.existsSync(`${target}.backup`)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("update button preserves unsaved settings and stays busy while installation starts", async () => {
  const invoke = vi.fn(async () => ({ ok: true, installing: true })), busy = vi.fn(), status = vi.fn();
  const context = { checkingUpdates: false, dirty: true, setCheckingUpdates: busy, setUpdateStatus: status, window: { nodusDesktop: { checkForUpdates: invoke } } };
  const check = uiFunction("checkForUpdates", context);
  await check(); expect(invoke).not.toHaveBeenCalled();
  context.dirty = false; await check(); expect(invoke).toHaveBeenCalledTimes(1); expect(busy.mock.calls).toEqual([[true]]);
});

test.each(["launchUpdate", "launchInstalledApp"])("%s waits for spawn and catches a missing or blocked executable", async (name) => {
  for (const failed of [false, true]) {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const spawn = vi.fn(() => { queueMicrotask(() => child.emit(failed ? "error" : "spawn", failed ? new Error("blocked") : undefined)); return child; });
    const launch = uiFunction(name, { spawn, path: path.win32, fs: { existsSync: () => true }, installDir: "C:\\Programs\\Nodus Connect" }, name === "launchUpdate" ? updateMain : "apps/installer/main.cjs");
    const pending = launch("C:\\cache\\setup.exe", "C:\\cache\\update.json");
    if (failed) { await expect(pending).rejects.toThrow("blocked"); expect(child.unref).not.toHaveBeenCalled(); }
    else { await pending; expect(child.unref).toHaveBeenCalledOnce(); }
  }
});

test.each([true, false])("host activity never leaves both viewer cursors hidden (overlay visible: %s)", (visible) => {
  const surface = { style: { cursor: "none" }, dataset: { localCursorOverlay: String(visible), physicalViewerCursorHidden: "true" } };
  const cursor = { style: { opacity: visible ? "1" : "0" } };
  const context = { localCursorRef: { current: cursor }, viewerSurfaceRef: { current: surface } };
  const hideLocalCursor = uiFunction("hideLocalCursor", context);
  const yieldToHost = uiFunction("yieldCursorToHost", { ...context, hideLocalCursor });
  for (let i = 0; i < 3; i++) yieldToHost();
  expect(cursor.style.opacity === "1" || surface.style.cursor === "default").toBe(true);
  expect(cursor.style.opacity).toBe(visible ? "1" : "0");
  expect(surface.dataset.physicalViewerCursorHidden).toBe(String(visible));
});

test("host cursor maps to the video, rejects stale samples and yields back to local movement", () => {
  const video = { videoWidth: 1920, videoHeight: 1080, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) };
  const surface = { style: { cursor: "none" }, dataset: { viewScale: "fit" }, clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: () => video };
  const cursor = { style: { opacity: "0", transform: "" } };
  const videoPoint = uiFunction("videoPoint", { mapVideoPointer });
  const hostCursorPoint = uiFunction("hostCursorPoint", { videoPoint });
  expect(hostCursorPoint(surface, { x: 0.5, y: 0.5 })).toMatchObject({ left: 500, top: 400 });
  expect(hostCursorPoint(surface, { x: Infinity, y: 0.5 })).toBeNull();
  const context = { localCursorRef: { current: cursor }, viewerSurfaceRef: { current: surface }, hostCursorSampleRef: { current: -Infinity }, performance: { now: () => 0 } };
  const hideLocalCursor = uiFunction("hideLocalCursor", context), yieldCursorToHost = uiFunction("yieldCursorToHost", { ...context, hideLocalCursor });
  const show = uiFunction("showHostCursor", { ...context, hostCursorPoint, hideLocalCursor, yieldCursorToHost });
  show({ x: 0.5, y: 0.5, visible: true, sampleAt: 20 });
  expect(cursor.style.transform).toBe("translate3d(500px, 400px, 0)");
  expect(surface.dataset).toMatchObject({ cursorOwner: "host", localCursorOverlay: "false" });
  show({ x: 0.1, y: 0.1, visible: true, sampleAt: 10 });
  expect(cursor.style.transform).toBe("translate3d(500px, 400px, 0)");
  const move = uiFunction("moveLocalCursor", { ...context, videoPoint, hideLocalCursor });
  move(surface, { clientX: 600, clientY: 400, timeStamp: 0 });
  expect(surface.dataset).toMatchObject({ cursorOwner: "viewer", localCursorOverlay: "true" });
  expect(cursor.style.opacity).toBe("1");
  show({ visible: false, sampleAt: 30 });
  expect(cursor.style.opacity).toBe("0");
  expect(hostCursorPoint(surface, { x: -1, y: 0 })).toBeNull();
});

test("host mouse positions use the shared monitor and drop congested telemetry without signaling reads", () => {
  const channel = { readyState: "open", bufferedAmount: 0, send: vi.fn() };
  const broadcast = uiFunction("broadcastHostMouseActivity", { sessionsRef: { current: [{ session: { sessionId: "s", role: "host", permissions: ["screen:view"] } }] },
    auxiliaryChannel: () => channel, nativeHostDisplaysRef: { current: new Map([["s", "secondary"]]) }, settings: { preferredDisplayId: "primary" },
    captureSources: [{ id: "primary", displayId: "1" }, { id: "secondary", displayId: "2" }], pointerSequencesRef: { current: new Map([["s", 12]]) }, performance: { now: () => 100 } });
  const positions = [{ displayId: "1", x: 1.2, y: 0.1, visible: false }, { displayId: "2", x: 0.2, y: 0.3, visible: true }];
  broadcast(positions);
  expect(JSON.parse(channel.send.mock.calls[0][0])).toMatchObject({ type: "host-mouse-activity", x: 0.2, y: 0.3, visible: true, inputSequence: 12 });
  channel.bufferedAmount = 2049;
  broadcast(positions);
  expect(channel.send).toHaveBeenCalledOnce();
});

test("late host cursor telemetry cannot take ownership after a newer viewer movement", () => {
  const dispatchEvent = vi.fn(), channel: any = { label: "telemetry" };
  const context = { telemetryChannelsRef: { current: new Map() }, pointerSequencesRef: { current: new Map([["s", 12]]) },
    window: { dispatchEvent }, CustomEvent: class { constructor(public type: string, public options: any) {} }, updateRuntime: vi.fn() };
  uiFunction("attachViewerControl", context)("s", channel, true);
  channel.onmessage({ data: JSON.stringify({ type: "host-mouse-activity", inputSequence: 11, x: 0.1, y: 0.1 }) });
  expect(dispatchEvent).not.toHaveBeenCalled();
  channel.onmessage({ data: JSON.stringify({ type: "host-mouse-activity", inputSequence: 12, x: 0.4, y: 0.5 }) });
  expect(dispatchEvent).toHaveBeenCalledOnce();
});

test("saved connection passwords are reused from recents without being deleted or clearing the field", async () => {
  const device = { nodusId: "987654321", deviceName: "Cliente", status: "online" };
  const save = vi.fn(async () => ({ ok: true })), reserveLicense = vi.fn(async () => undefined), setTargetPassword = vi.fn();
  const context = { supportProfile: null, normalizeNodusId, formatNodusId, identity: { nodusId: "123456789", deviceName: "Tecnico" },
    crypto, rememberTargetPassword: false, targetPasswordLookupRef: { current: 0 }, window: { nodusDesktop: { getConnectionPassword: vi.fn(async () => "saved-example"), saveConnectionPassword: save } },
    setTargetId: vi.fn(), setTargetPassword, setRememberTargetPassword: vi.fn(), setFeedback: vi.fn(), iceWarmupRef: { current: null }, settings: { coordinationUrl: "", preferredResolution: "native", maxFps: 60 },
    fetchIceServers: async () => [], setServerIceServers: vi.fn(), lookupDevice: async () => device, setRecents: vi.fn(), saveRecent: (value: unknown) => [value], setHiddenCatalogDevices: vi.fn(), loadHiddenCatalogDevices: () => [],
    reserveLicense, createSessionRequest: vi.fn(async () => ({ id: "request", sessionId: "session" })), currentUser: null, hashPassword: async (value: string) => `hash:${value}`, recordAccess: vi.fn(), setOutgoingRequest: vi.fn(),
    LicenseError, licenseFeedback: vi.fn(), licenseEnded: vi.fn(), scheduleConnectionReset: vi.fn() };
  const persistConnectionPassword = uiFunction("persistConnectionPassword", context);
  const connect = uiFunction("connectToDevice", { ...context, persistConnectionPassword });
  await connect("987 654 321");
  expect(reserveLicense).toHaveBeenCalledWith(context.identity, "987654321", undefined, "saved-example");
  expect(context.createSessionRequest.mock.calls[0][0]).toMatchObject({ passwordHash: "hash:saved-example" });
  expect(setTargetPassword).toHaveBeenLastCalledWith("saved-example");
  expect(save).not.toHaveBeenCalledWith("987654321", "");
  await connect("987654321", "typed-example");
  expect(reserveLicense).toHaveBeenLastCalledWith(context.identity, "987654321", undefined, "typed-example");
  expect(save).not.toHaveBeenCalledWith("987654321", "");
  expect(context.scheduleConnectionReset).not.toHaveBeenCalled();
});

test("connection reset clears only temporary fields after five seconds", async () => {
  vi.useFakeTimers();
  const context = { connectionResetTimerRef: { current: null as ReturnType<typeof setTimeout> | null }, targetPasswordLookupRef: { current: 0 }, outgoingRequestRef: { current: null as any },
    window: { setTimeout, clearTimeout }, setTargetId: vi.fn(), setTargetPassword: vi.fn(), setRememberTargetPassword: vi.fn(), setFeedback: vi.fn(), setConnectionFormVersion: vi.fn(), persistConnectionPassword: vi.fn() };
  const reset = uiFunction("scheduleConnectionReset", context);
  reset();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(context.setTargetId).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(context.setTargetId).toHaveBeenCalledExactlyOnceWith("");
  expect(context.setTargetPassword).toHaveBeenCalledExactlyOnceWith("");
  expect(context.setRememberTargetPassword).toHaveBeenCalledExactlyOnceWith(false);
  expect(context.setFeedback).toHaveBeenCalledExactlyOnceWith("");
  expect(context.setConnectionFormVersion.mock.calls[0][0](4)).toBe(5);
  expect(context.persistConnectionPassword).not.toHaveBeenCalled();
  expect(context.targetPasswordLookupRef.current).toBe(1);
});

test("connection reset preserves new edits and pending requests and restarts its deadline", async () => {
  vi.useFakeTimers();
  const context = { connectionResetTimerRef: { current: null as ReturnType<typeof setTimeout> | null }, targetPasswordLookupRef: { current: 0 }, outgoingRequestRef: { current: null as any },
    window: { setTimeout, clearTimeout }, setTargetId: vi.fn(), setTargetPassword: vi.fn(), setRememberTargetPassword: vi.fn(), setFeedback: vi.fn(), setConnectionFormVersion: vi.fn() };
  const reset = uiFunction("scheduleConnectionReset", context);
  reset();
  uiFunction("updateTargetPassword", context)("new-password");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(context.setTargetId).not.toHaveBeenCalled();
  reset(); context.outgoingRequestRef.current = { id: "pending" };
  await vi.advanceTimersByTimeAsync(5_000);
  expect(context.setTargetId).not.toHaveBeenCalled();
  context.outgoingRequestRef.current = null;
  reset(); await vi.advanceTimersByTimeAsync(4_000); reset();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(context.setTargetId).not.toHaveBeenCalled();
  reset(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(context.setTargetId).toHaveBeenCalledExactlyOnceWith("");
});

test.each(["", "123456789", "987654321"])("failed connection %s schedules form cleanup without creating a request", async target => {
  const scheduleConnectionReset = vi.fn(), setFeedback = vi.fn(), createSessionRequest = vi.fn();
  const connect = uiFunction("connectToDevice", { supportProfile: null, targetPasswordLookupRef: { current: 0 }, normalizeNodusId, identity: { nodusId: "123456789" },
    crypto, rememberTargetPassword: false, setFeedback, scheduleConnectionReset, iceWarmupRef: { current: null }, settings: { coordinationUrl: "" },
    fetchIceServers: async () => [], setServerIceServers: vi.fn(), lookupDevice: async () => null, createSessionRequest });
  await connect(target, "");
  expect(setFeedback).toHaveBeenCalled();
  expect(scheduleConnectionReset).toHaveBeenCalledOnce();
  expect(createSessionRequest).not.toHaveBeenCalled();
});

test("disconnect resets its connection form but never another target or an incoming session", () => {
  const context = { sessionsRef: { current: [{ session: { sessionId: "s", role: "viewer", remoteNodusId: "987654321" } }] },
    targetId: "987 654 321", normalizeNodusId, outgoingRequestRef: { current: null }, logDiagnostic: vi.fn(), cleanupSession: vi.fn(), removeRuntime: vi.fn(), scheduleConnectionReset: vi.fn() };
  uiFunction("endSession", context)("s", false);
  expect(context.scheduleConnectionReset).toHaveBeenCalledOnce();
  context.scheduleConnectionReset.mockClear(); context.targetId = "111 222 333";
  uiFunction("endSession", context)("s", false);
  context.targetId = "987 654 321"; context.sessionsRef.current[0].session.role = "host";
  uiFunction("endSession", context)("s", false);
  expect(context.scheduleConnectionReset).not.toHaveBeenCalled();
});

test("editing a target password cancels old lookups and only explicit unchecking removes the saved password", async () => {
  let resolve: (value: string) => void = () => {};
  const loaded = new Promise<string>(done => { resolve = done; }), setTargetPassword = vi.fn(), persistConnectionPassword = vi.fn();
  const context = { targetId: "", targetPassword: "typed-example", targetPasswordLookupRef: { current: 0 }, normalizeNodusId, formatNodusId,
    setTargetId: vi.fn(), setTargetPassword, setRememberTargetPassword: vi.fn(), window: { nodusDesktop: { getConnectionPassword: () => loaded } }, persistConnectionPassword };
  uiFunction("updateTargetId", context)("987654321");
  uiFunction("updateTargetPassword", context)("typed-example");
  resolve("old-saved-example"); await loaded;
  expect(setTargetPassword).toHaveBeenLastCalledWith("typed-example");
  context.targetId = "987 654 321";
  const remember = uiFunction("updateRememberTargetPassword", context);
  remember(true);
  expect(persistConnectionPassword).toHaveBeenLastCalledWith("987654321", "typed-example");
  remember(false);
  expect(persistConnectionPassword).toHaveBeenLastCalledWith("987654321", "");
});

test("unsupported receiver latency hints do not prevent video reception", () => {
  const configure = uiFunction("configureLowLatencyReceiver");
  const receiver = { set jitterBufferTarget(_: number) { throw new Error("unsupported"); } };
  expect(() => configure(receiver)).not.toThrow();
  const supported = { jitterBufferTarget: 0 };
  configure(supported); expect(supported.jitterBufferTarget).toBe(20);
  const fallback = { playoutDelayHint: null, set jitterBufferTarget(_: number) { throw new Error("unsupported"); } };
  configure(fallback); expect(fallback.playoutDelayHint).toBe(0.02);
  const primary = { jitterBufferTarget: 0, set playoutDelayHint(_: number) { throw new Error("unsupported"); } };
  configure(primary); expect(primary.jitterBufferTarget).toBe(20);
  expect(() => configure({})).not.toThrow();
});

test("audio and arriving tracks use the same low latency policy as video", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  expect(source).toContain('configureLowLatencyReceiver(peer.addTransceiver("audio", { direction: "recvonly" }).receiver)');
  expect(source.match(/ontrack = \(event\) => \{\s*configureLowLatencyReceiver\(event.receiver\)/g)).toHaveLength(2);
});

test("realtime retries back off and stale sockets cannot affect the new connection", async () => {
  vi.useFakeTimers();
  const sockets: any[] = [], onState = vi.fn(), onSignal = vi.fn();
  class Socket {
    static OPEN = 1; readyState = 1;
    onopen?: () => Promise<void>; onclose?: () => void; onerror?: () => void; onmessage?: (event: { data: string }) => void;
    close = vi.fn(() => this.onclose?.()); send = vi.fn();
    constructor() { sockets.push(this); }
  }
  const connect = uiFunction("connectRealtime", { exports: {}, URL, WebSocket: Socket, window: { setTimeout, clearTimeout }, firebaseConfigured: () => false,
    normalizeNodusId: () => "123456789", apiBase: () => "https://relay.test", getCoordinationAuthToken: () => "", licenseConfigured: () => false }, "apps/desktop/src/core/realtime.ts");
  const connection = connect("123456789", { onState, onSignal });
  sockets[0].close(); await vi.advanceTimersByTimeAsync(2000);
  sockets[0].onerror(); expect(sockets[1].close).not.toHaveBeenCalled();
  sockets[1].onmessage({ data: "invalid" }); sockets[1].onmessage({ data: "null" });
  sockets[1].close(); await vi.advanceTimersByTimeAsync(3999); expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1); expect(sockets).toHaveLength(3);
  sockets[2].onmessage({ data: JSON.stringify({ type: "ready" }) });
  expect(onState).toHaveBeenLastCalledWith("online");
  connection.close(); sockets[2].onmessage({ data: JSON.stringify({ type: "signal", signal: {} }) });
  await vi.advanceTimersByTimeAsync(30_000); expect(sockets).toHaveLength(3); expect(onSignal).not.toHaveBeenCalled();
});

test("closing realtime during Firestore initialization leaves no listeners or late state updates", async () => {
  let resolveFire!: (value: any) => void;
  const onSnapshot = vi.fn(), onState = vi.fn();
  const connect = uiFunction("subscribeCloudRealtime", { exports: {}, firebaseConfigured: () => true, normalizeNodusId: () => "123456789", ensureDeviceUid: async () => "owner",
    setTimeout, clearTimeout, fire: () => new Promise(resolve => { resolveFire = resolve; }) }, "apps/desktop/src/core/firebase.ts");
  const connection = connect("123456789", { onState });
  await Promise.resolve(); connection.close(); resolveFire({ onSnapshot });
  await Promise.resolve(); expect(onSnapshot).not.toHaveBeenCalled(); expect(onState).toHaveBeenCalledExactlyOnceWith("connecting");
});

test("cloud SDP and ICE use canonical participant IDs under enforced server authorization", async () => {
  const addDoc = vi.fn(async (_path: unknown, message: any) => {
    if (message.from !== "960632279" || message.to !== "823388407") throw Object.assign(new Error("denied"), { code: "permission-denied" });
  });
  const ensureDeviceUid = vi.fn(async () => "requester");
  const send = uiFunction("cloudSendSignal", { exports: {}, normalizeNodusId, ensureDeviceUid, fire: async () => ({ addDoc, collection: (...args: unknown[]) => args, store: {} }), firestoreData: (data: unknown) => data }, "apps/desktop/src/core/firebase.ts");
  for (const type of ["offer", "answer", "ice-candidate"])
    await expect(send("session", { from: "960 632 279", to: "823 388 407", type, payload: {} })).resolves.toMatchObject({ from: "960632279", to: "823388407", type });
  expect(addDoc).toHaveBeenCalledTimes(3);
  addDoc.mockClear(); ensureDeviceUid.mockClear();
  await expect(send("session", { from: "invalid", to: "823388407", type: "offer", payload: {} })).rejects.toThrow();
  expect(addDoc).not.toHaveBeenCalled(); expect(ensureDeviceUid).not.toHaveBeenCalled();
});

function cloudListenerFixture() {
  vi.useFakeTimers();
  const listeners: { next: (snapshot: any) => void; error: (error: any) => void; stop: ReturnType<typeof vi.fn> }[] = [];
  const getDocs = vi.fn(), onSnapshot = vi.fn((_query, ...args) => {
    const index = typeof args[0] === "function" ? 0 : 1;
    const stop = vi.fn(); listeners.push({ next: args[index], error: args[index + 1], stop }); return stop;
  });
  const context = { exports: {}, firebaseConfigured: () => true, normalizeNodusId: (id: string) => id.replace(/\D/g, ""), ensureDeviceUid: async () => "owner",
    setTimeout, clearTimeout, Date, PENDING_REQUEST_TTL_MS: 300_000, isFresh: (at: string, ttl: number) => Date.now() - Date.parse(at) < ttl,
    fire: async () => ({ collection: (_store: any, ...path: string[]) => path, query: (...args: any[]) => args, where: (...args: any[]) => args, store: {}, onSnapshot, getDocs }) };
  const snapshot = (items: { id: string; seq?: number; status?: string; createdAt?: string; type?: string }[], cached = false) => {
    const docs = items.map(item => ({ id: item.id, data: () => item }));
    return { docs, size: docs.length, metadata: { fromCache: cached }, docChanges: () => docs.map(doc => ({ type: "added", doc })) };
  };
  return { context, listeners, getDocs, onSnapshot, snapshot };
}

test("permanent signal denials are surfaced once without four rejected writes", async () => {
  const sendSignal = vi.fn(async () => { throw Object.assign(new Error("denied"), { code: "permission-denied" }); });
  const delay = vi.fn(async () => {}), logDiagnostic = vi.fn();
  const send = uiFunction("sendReliableSignal", { Error, sendSignal, delay, logDiagnostic });
  await expect(send("session", { type: "offer" })).rejects.toMatchObject({ code: "permission-denied" });
  expect(sendSignal).toHaveBeenCalledOnce(); expect(delay).not.toHaveBeenCalled();
  expect(logDiagnostic).toHaveBeenCalledWith(expect.stringContaining("code=permission-denied"));
  sendSignal.mockReset().mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "unavailable" })).mockResolvedValueOnce({} as never);
  await expect(send("session", { type: "offer" })).resolves.toEqual({});
  expect(sendSignal).toHaveBeenCalledTimes(2); expect(delay).toHaveBeenCalledOnce();
});

test("cloud signals use one listener with no repeated reads during an idle hour", async () => {
  const f = cloudListenerFixture(), onSignal = vi.fn(async () => undefined);
  const subscribe = uiFunction("subscribeCloudSignals", f.context, "apps/desktop/src/core/firebase.ts");
  const connection = subscribe("session", "123 456 789", onSignal, vi.fn());
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(f.onSnapshot).toHaveBeenCalledOnce(); expect(f.getDocs).not.toHaveBeenCalled(); expect(onSignal).not.toHaveBeenCalled();
  expect(f.onSnapshot.mock.calls[0][0]).toEqual(["sessions", "session", "signals", "123456789", "items"]);
  connection.close(); expect(f.listeners[0].stop).toHaveBeenCalledOnce();
});

test("cloud signals serialize SDP and ICE, ignore replay, and deliver a late lower sequence", async () => {
  const f = cloudListenerFixture(), order: number[] = [];
  let release!: () => void;
  const onSignal = vi.fn(async (signal: any) => { order.push(signal.seq); if (signal.seq === 10) await new Promise<void>(done => { release = done; }); });
  const connection = uiFunction("subscribeCloudSignals", f.context, "apps/desktop/src/core/firebase.ts")("session", "123456789", onSignal, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  f.listeners[0].next(f.snapshot([{ id: "ice", seq: 20 }, { id: "offer", seq: 10 }], true));
  await vi.advanceTimersByTimeAsync(0); expect(order).toEqual([10]);
  f.listeners[0].next(f.snapshot([{ id: "offer", seq: 10 }, { id: "late", seq: 15 }]));
  release(); await vi.advanceTimersByTimeAsync(0); expect(order).toEqual([10, 20, 15]);
  f.listeners[0].next({ docChanges: () => [{ type: "removed", doc: { id: "deleted", data: () => ({ seq: 30 }) } }], metadata: { fromCache: false } });
  await vi.advanceTimersByTimeAsync(0); expect(onSignal).toHaveBeenCalledTimes(3);
  connection.close();
});

test("cloud signal errors back off without replaying delivery or accepting stale listeners", async () => {
  const f = cloudListenerFixture(), onSignal = vi.fn(async () => undefined), onError = vi.fn();
  const connection = uiFunction("subscribeCloudSignals", f.context, "apps/desktop/src/core/firebase.ts")("session", "123456789", onSignal, onError);
  await vi.advanceTimersByTimeAsync(0);
  f.listeners[0].next(f.snapshot([{ id: "offer", seq: 1 }])); await vi.advanceTimersByTimeAsync(0);
  f.listeners[0].error({ code: "resource-exhausted" });
  await vi.advanceTimersByTimeAsync(29_999); expect(f.listeners).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.listeners).toHaveLength(2);
  f.listeners[0].error({ code: "resource-exhausted" }); expect(f.listeners[1].stop).not.toHaveBeenCalled();
  f.listeners[1].next(f.snapshot([{ id: "offer", seq: 1 }, { id: "answer", seq: 2 }]));
  await vi.advanceTimersByTimeAsync(0); expect(onSignal).toHaveBeenCalledTimes(2); expect(onError).toHaveBeenCalledOnce();
  connection.close(); f.listeners[1].next(f.snapshot([{ id: "closed", seq: 3 }]));
  await vi.advanceTimersByTimeAsync(300_000); expect(f.listeners).toHaveLength(2); expect(onSignal).toHaveBeenCalledTimes(2);
});

test.each(["permission-denied", "unauthenticated"])("cloud signaling does not retry or bypass %s", async code => {
  const f = cloudListenerFixture(), onError = vi.fn();
  const connection = uiFunction("subscribeCloudSignals", f.context, "apps/desktop/src/core/firebase.ts")("session", "123456789", vi.fn(), onError);
  await vi.advanceTimersByTimeAsync(0); f.listeners[0].error({ code });
  await vi.advanceTimersByTimeAsync(3_600_000); expect(f.listeners).toHaveLength(1); expect(onError).toHaveBeenCalledOnce();
  connection.close();
});

test("closing cloud signaling discards queued work and deferred initialization", async () => {
  const f = cloudListenerFixture(); let ready!: (value: any) => void;
  const onSignal = vi.fn();
  const connection = uiFunction("subscribeCloudSignals", { ...f.context, fire: () => new Promise(done => { ready = done; }) }, "apps/desktop/src/core/firebase.ts")("session", "123456789", onSignal, vi.fn());
  await vi.advanceTimersByTimeAsync(0); connection.close(); ready(await f.context.fire());
  await vi.advanceTimersByTimeAsync(0); expect(f.listeners).toHaveLength(0);
  const active = uiFunction("subscribeCloudSignals", f.context, "apps/desktop/src/core/firebase.ts")("session", "123456789", onSignal, vi.fn());
  await vi.advanceTimersByTimeAsync(0); f.listeners[0].next(f.snapshot([{ id: "queued", seq: 1 }])); active.close();
  await vi.advanceTimersByTimeAsync(0); expect(onSignal).not.toHaveBeenCalled();
});

test("incoming requests are reconciled by snapshot without polling or stale accepted requests", async () => {
  const f = cloudListenerFixture(), onIncomingRequests = vi.fn(), onRequestUpdate = vi.fn();
  const connection = uiFunction("subscribeCloudRealtime", f.context, "apps/desktop/src/core/firebase.ts")("123456789", { onIncomingRequests, onRequestUpdate });
  await vi.advanceTimersByTimeAsync(0);
  const current = { id: "pending", status: "pending", createdAt: new Date().toISOString() };
  f.listeners[0].next(f.snapshot([current, { ...current, id: "expired", createdAt: new Date(Date.now() - 300_001).toISOString() }]));
  expect(onIncomingRequests).toHaveBeenLastCalledWith([current]);
  f.listeners[0].next(f.snapshot([{ ...current, status: "accepted" }])); expect(onIncomingRequests).toHaveBeenLastCalledWith([]);
  f.listeners[1].next(f.snapshot([{ ...current, status: "accepted" }])); expect(onRequestUpdate).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(3_600_000); expect(f.onSnapshot).toHaveBeenCalledTimes(2); expect(f.getDocs).not.toHaveBeenCalled();
  connection.close(); expect(f.listeners.every(listener => listener.stop.mock.calls.length === 1)).toBe(true);
});

test("request listeners recover together with bounded retry and close cancels reconnection", async () => {
  const f = cloudListenerFixture(), onIncomingRequests = vi.fn(), onState = vi.fn();
  const connection = uiFunction("subscribeCloudRealtime", f.context, "apps/desktop/src/core/firebase.ts")("123456789", { onIncomingRequests, onState });
  await vi.advanceTimersByTimeAsync(0); f.listeners[0].error({ code: "resource-exhausted" });
  f.listeners[1].error({ code: "resource-exhausted" });
  expect(f.listeners.every(listener => listener.stop.mock.calls.length === 1)).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000); expect(f.listeners).toHaveLength(4);
  f.listeners[0].next(f.snapshot([])); expect(onIncomingRequests).not.toHaveBeenCalled();
  f.listeners[2].error({ code: "resource-exhausted" });
  await vi.advanceTimersByTimeAsync(59_999); expect(f.listeners).toHaveLength(4);
  connection.close(); await vi.advanceTimersByTimeAsync(300_000); expect(f.listeners).toHaveLength(4);
});

test("Firebase sessions bypass both request polling effects and dispose signal listeners", () => {
  const source = ts.createSourceFile("App.tsx", readFileSync("apps/desktop/src/App.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const effects: string[] = [];
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect") effects.push(node.getText(source)); ts.forEachChild(node, visit); }; visit(source);
  for (const call of ["listIncomingRequests(identity.nodusId)", "getSessionRequest(outgoingRequest.id)"]) {
    const effect = effects.find(text => text.includes(call))!;
    expect(effect.indexOf("if (firebaseConfigured())")).toBeLessThan(effect.indexOf(call));
    expect(effect).toMatch(/if \(firebaseConfigured\(\)\) \{[\s\S]*return \(\) => (?:\{ disposed = true; )?window.clear(?:Interval|Timeout)\(timer\);(?: \})?\s*\}/);
  }
  expect(readFileSync("apps/desktop/src/App.tsx", "utf8")).toContain("signalConnectionsRef.current.get(sessionId)?.close();");
});

test("acceptance synchronization starts once and a late pending snapshot cannot restore the request", async () => {
  const request = { id: "pending", sessionId: "session", status: "accepted", targetNodusId: "987654321" };
  const outgoingRequestRef = { current: { id: request.id } as any }, startViewerSession = vi.fn(async () => undefined), recordAccess = vi.fn(), setOutgoingRequest = vi.fn();
  const scheduleConnectionReset = vi.fn();
  const update = uiFunction("handleRequestUpdate", { outgoingRequestRef, startViewerSession, recordAccess, setOutgoingRequest, setFeedback: vi.fn(), scheduleConnectionReset });
  update(request); update(request); update({ ...request, status: "pending" });
  expect(startViewerSession).toHaveBeenCalledExactlyOnceWith(request); expect(recordAccess).toHaveBeenCalledOnce(); expect(setOutgoingRequest).toHaveBeenCalledExactlyOnceWith(null);
  expect(outgoingRequestRef.current).toBeNull();
  expect(scheduleConnectionReset).toHaveBeenCalledOnce();
});

test("fallback signal polling never overlaps and ignores a late response after close", async () => {
  vi.useFakeTimers(); let resolve!: (value: any) => void;
  const connections = new Map(), getSignals = vi.fn(() => new Promise(done => { resolve = done; })), handleSignal = vi.fn();
  const listen = uiFunction("startSignalListening", { firebaseConfigured: () => false, signalConnectionsRef: { current: connections }, lastSignalSeqRef: { current: new Map() },
    window: { setInterval, clearInterval }, getSignals, handleSignal, updateRuntime: vi.fn() });
  listen("session", "123456789"); await vi.advanceTimersByTimeAsync(10_000); expect(getSignals).toHaveBeenCalledOnce();
  connections.get("session").close(); resolve([{ seq: 1 }]); await vi.advanceTimersByTimeAsync(0); expect(handleSignal).not.toHaveBeenCalled();
});

test("local cloud counters separate cache, server documents, writes and errors without storing data", async () => {
  const f = cloudListenerFixture();
  const cloudUsage = { readRequests: 0, writeRequests: 0, listenerStarts: 0, serverSnapshots: 0, documentsDelivered: 0, minimumReadEstimate: 0, errors: 0 };
  const api = { onSnapshot: f.onSnapshot, getDoc: vi.fn(async () => ({ metadata: { fromCache: true } })), getDocs: vi.fn(async () => f.snapshot([])), setDoc: vi.fn(async () => undefined), addDoc: vi.fn(async () => ({})) };
  const tracked = uiFunction("instrumentFirestore", { cloudUsage }, "apps/desktop/src/core/firebase.ts")({}, api);
  await tracked.getDoc("cached"); await tracked.getDocs("empty"); await tracked.setDoc("doc", {}); await tracked.addDoc("collection", {});
  const next = vi.fn(), error = vi.fn(); tracked.onSnapshot("query", { includeMetadataChanges: true }, next, error);
  f.listeners[0].next(f.snapshot([{ id: "one" }, { id: "two" }], true));
  f.listeners[0].next(f.snapshot([{ id: "one" }, { id: "two" }]));
  f.listeners[0].next({ ...f.snapshot([]), docChanges: () => [] });
  f.listeners[0].error({ code: "resource-exhausted" });
  expect(cloudUsage).toEqual({ readRequests: 2, writeRequests: 2, listenerStarts: 1, serverSnapshots: 2, documentsDelivered: 2, minimumReadEstimate: 3, errors: 1 });
  expect(next).toHaveBeenCalledTimes(3); expect(error).toHaveBeenCalledOnce();
  api.getDocs.mockRejectedValueOnce(new Error("unavailable")); await expect(tracked.getDocs("failed")).rejects.toThrow("unavailable");
  expect(cloudUsage.errors).toBe(2); expect(cloudUsage.minimumReadEstimate).toBe(3);
});

test("relay restarts re-register the same identity instead of permanently losing presence", async () => {
  const identity = { nodusId: "123456789" }, register = vi.fn(async (value) => value);
  const heartbeat = uiFunction("heartbeat", { exports: {}, firebaseConfigured: () => false, normalizeNodusId: (value: string) => value,
    request: async () => { throw new Error("not-found"); }, formatApiError: () => "not-found", registerPresence: register, Error }, "apps/desktop/src/core/api.ts");
  await expect(heartbeat(identity)).resolves.toEqual(identity); expect(register).toHaveBeenCalledExactlyOnceWith(identity);
  await expect(heartbeat("123456789")).rejects.toThrow("not-found");
});

test("app navigation excludes lookalike dev origins and unrelated local files", () => {
  const allowed = uiFunction("isAllowedAppUrl", { URL, isDev: true, devUrl: "http://127.0.0.1:5173/" }, "apps/desktop/electron/main.cjs");
  expect(allowed("http://127.0.0.1:5173/?test=true")).toBe(true);
  expect(allowed("http://127.0.0.1:51730/")).toBe(false);
  expect(allowed("http://127.0.0.1:5173/foreign")).toBe(false);
  expect(allowed("file:///C:/foreign.html")).toBe(false);
});

test("opening Nodus again creates another workspace without duplicating the service", () => {
  const source = ts.createSourceFile("main.cjs", readFileSync("apps/desktop/electron/main.cjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const listener = source.statements.find(node => ts.isExpressionStatement(node) && node.getText(source).startsWith('app.on("second-instance"'))!;
  const send = vi.fn(), show = vi.fn(), on = vi.fn();
  runInNewContext(listener.getText(source), { app: { on }, portableSupport: false, mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }, showMainWindow: show, getDiagnosticPresetArgument: () => null });
  on.mock.calls[0][1]({}, []);
  expect(show).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledExactlyOnceWith("nodus:open-workspace");
});

test.each([true, false])("session indicators render only when the saved preference is %s", (enabled) => {
  const source = ts.createSourceFile("App.tsx", readFileSync("apps/desktop/src/App.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.JsxExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxExpression(node) && node.getText(source).startsWith('{showConnectionMetrics && <div className="viewer-live-metrics"')) expression = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  const code = ts.transpileModule(`const Indicators = () => <>{${expression!.expression!.getText(source)}}</>;`, { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText;
  const component = runInNewContext(`${code}; Indicators`, { React, Activity, Gauge, Monitor, showConnectionMetrics: enabled, toggleTool: vi.fn(), resolutionLabel: () => "1920 × 1080", remoteResolution: "1920x1080", metrics: { latencyMs: 25, fps: 60 } });
  const markup = renderToStaticMarkup(React.createElement(component));
  expect(markup.includes("viewer-live-metrics")).toBe(enabled);
  expect(markup.includes("60 FPS")).toBe(enabled);
  expect(markup.includes("25 ms")).toBe(enabled);
});

test("licensing authentication stalls expire instead of keeping the panel loading forever", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn();
  const request = uiFunction("request", { base: "https://license.test", URL, AbortController, Promise, setTimeout, clearTimeout, LicenseError, LICENSE_MESSAGES,
    getDeviceAuthToken: () => new Promise(() => {}), fetch }, "apps/desktop/src/core/licensing.ts");
  const result = expect(request("/license/check", {})).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
  await vi.advanceTimersByTimeAsync(8000); await result; expect(fetch).not.toHaveBeenCalled();
});

test("new outgoing sessions reserve accounting even before enforcement is activated", async () => {
  const reserved = new Set(), request = vi.fn(async (path: string) => path === "/license/policy" ? { enforced: false } : { sessionId: "session" });
  const reserve = uiFunction("reserveLicense", { exports: {}, licenseConfigured: () => true, prepared: new Map(), reserved,
    checkLicense: async () => ({ code: "LICENSE_ACTIVE" }), device: async () => ({ deviceId: "source" }), request, crypto: { randomUUID: () => "session" }, LicenseError }, "apps/desktop/src/core/licensing.ts");
  await expect(reserve({}, "987654321")).resolves.toBe("session");
  expect(request).toHaveBeenCalledWith("/license/sessions/reserve", expect.objectContaining({ sessionId: "session", targetNodusId: "987654321" }));
  expect(reserved.has("session")).toBe(true);
});

test("peer preparation preserves the license reservation and final cleanup ends it once", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  const reserved = new Set(["session"]), request = vi.fn(async () => ({}));
  const licenseEnded = uiFunction("licenseEnded", { exports: {}, lifecycle: new Map(), reserved, licenseConfigured: () => true, request, clearTimeout }, "apps/desktop/src/core/licensing.ts");
  const context: Record<string, any> = { licenseEnded, window: { clearTimeout, clearInterval }, syncHostCursorVisibility: vi.fn(), recordingSessionId: null };
  for (const name of new Set(source.match(/\b\w+Ref\b/g))) context[name] = { current: new Map() };
  context.sessionsRef.current = [];
  context.processedSignalsRef.current = new Set();
  context.pressedPointerButtonsRef.current = new Set();
  for (const name of new Set([...source.matchAll(/\b(set[A-Z]\w+)\(/g)].map(match => match[1]))) context[name] = vi.fn();
  const cleanup = uiFunction("cleanupSession", context);
  const prepare = uiFunction("createPeer", { ...context, cleanupSession: cleanup, getEffectiveIceServers: () => [], iceServerUrls: () => [], iceServerInfo: vi.fn(),
    logDiagnostic: vi.fn(), logIceEvent: vi.fn(), performance: { now: () => 0 }, startQualityMonitoring: vi.fn(),
    RTCPeerConnection: class { getConfiguration() { return {}; } close() {} } });
  prepare("session", "123456789", "987654321", "viewer");
  expect(reserved.has("session")).toBe(true);
  expect(request).not.toHaveBeenCalled();
  cleanup("session", true);
  expect(reserved.has("session")).toBe(false);
  expect(request).toHaveBeenCalledExactlyOnceWith("/license/sessions/end", { sessionId: "session" });
  cleanup("session", true);
  expect(request).toHaveBeenCalledTimes(1);
});

test("both peers publish accounting before enforcement and a pending peer retries establishment", async () => {
  vi.useFakeTimers();
  const lifecycle = new Map(), dispatchEvent = vi.fn(), rejected = vi.fn();
  const request = vi.fn(async (path: string) => path === "/license/policy" ? { enforced: false, heartbeatSeconds: 30 } : { status: request.mock.calls.filter(([path]) => path === "/license/sessions/establish").length === 1 ? "RESERVED" : "ESTABLISHED" });
  const establish = uiFunction("licenseEstablished", { exports: {}, licenseConfigured: () => true, lifecycle, reserved: new Set(), LicenseError, setTimeout,
    request, Event, window: { dispatchEvent } }, "apps/desktop/src/core/licensing.ts");
  await establish("session", rejected);
  expect(lifecycle.get("session").connected).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(lifecycle.get("session").connected).toBe(true);
  expect(request.mock.calls.filter(([path]) => path === "/license/sessions/establish")).toHaveLength(2);
  await establish("session", rejected);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(request).toHaveBeenLastCalledWith("/license/sessions/heartbeat", { sessionId: "session" });
  expect(dispatchEvent).toHaveBeenCalledTimes(2);
  expect(rejected).not.toHaveBeenCalled();
  vi.clearAllTimers();
});

test("legacy unreserved sessions do not disconnect or retry forever during accounting rollout", async () => {
  vi.useFakeTimers();
  const lifecycle = new Map(), rejected = vi.fn();
  const establish = uiFunction("licenseEstablished", { exports: {}, licenseConfigured: () => true, lifecycle, reserved: new Set(), LicenseError, setTimeout,
    request: async (path: string) => { if (path === "/license/policy") return { enforced: false }; throw new LicenseError("FORBIDDEN"); } }, "apps/desktop/src/core/licensing.ts");
  await establish("legacy", rejected);
  expect(lifecycle.has("legacy")).toBe(false);
  expect(rejected).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("free deadline closes at ten minutes during an API outage without extra requests", async () => {
  vi.useFakeTimers();
  const lifecycle = new Map(), rejected = vi.fn(), started = Date.now();
  let offline = false;
  const request = vi.fn(async (path: string) => {
    if (offline) throw new LicenseError("SERVER_UNAVAILABLE");
    return path === "/license/policy" ? { heartbeatSeconds: 30 } : { status: "ESTABLISHED", endsAt: started + 600_000, serverTime: Date.now() };
  });
  const establish = uiFunction("licenseEstablished", { exports: {}, licenseConfigured: () => true, lifecycle, reserved: new Set(["limited"]), LicenseError, setTimeout, request, Event, window: { dispatchEvent: vi.fn() } }, "apps/desktop/src/core/licensing.ts");
  await establish("limited", rejected); offline = true;
  await vi.advanceTimersByTimeAsync(599_999); expect(rejected).not.toHaveBeenCalled();
  const calls = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1);
  expect(rejected).toHaveBeenCalledExactlyOnceWith("FREE_SESSION_LIMIT_REACHED");
  expect(request).toHaveBeenCalledTimes(calls);
  expect(lifecycle.has("limited")).toBe(false); expect(vi.getTimerCount()).toBe(0);
});

test("reconnecting after a free timeout creates a new reservation and a fresh ten-minute timer", async () => {
  vi.useFakeTimers();
  const lifecycle = new Map(), reserved = new Set(), endsAt = new Map(), rejected = vi.fn();
  let sequence = 0;
  const request = vi.fn(async (path: string, body?: { sessionId: string }) => {
    if (path === "/license/policy") return { heartbeatSeconds: 120 };
    if (path === "/license/sessions/reserve") return { sessionId: body!.sessionId };
    if (path === "/license/sessions/end") return { ok: true };
    if (!endsAt.has(body!.sessionId)) endsAt.set(body!.sessionId, Date.now() + 600_000);
    return { status: "ESTABLISHED", endsAt: endsAt.get(body!.sessionId), serverTime: Date.now() };
  });
  const context = { exports: {}, licenseConfigured: () => true, lifecycle, reserved, prepared: new Map(), device: async () => ({ deviceId: "source" }), crypto: { randomUUID: () => `session-${++sequence}` }, LicenseError, setTimeout, request, Event, window: { dispatchEvent: vi.fn() } };
  const reserve = uiFunction("reserveLicense", context, "apps/desktop/src/core/licensing.ts");
  const establish = uiFunction("licenseEstablished", context, "apps/desktop/src/core/licensing.ts");
  const end = uiFunction("licenseEnded", context, "apps/desktop/src/core/licensing.ts");
  const first = await reserve({}, "987654321");
  await establish(first, (code: string) => { rejected(code); end(first); });
  await vi.advanceTimersByTimeAsync(600_000);
  expect(rejected).toHaveBeenCalledExactlyOnceWith("FREE_SESSION_LIMIT_REACHED");
  expect(lifecycle.has(first)).toBe(false); expect(reserved.has(first)).toBe(false);
  const next = await reserve({}, "987654321");
  expect(next).not.toBe(first);
  await establish(next, rejected);
  await vi.advanceTimersByTimeAsync(599_999);
  expect(rejected).toHaveBeenCalledTimes(1);
  expect(lifecycle.has(next)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(rejected).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.filter(([path]) => path === "/license/sessions/reserve")).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["renewal", "clock", "manual-end", "business"])("session deadline handles %s without resetting the free timer", async mode => {
  vi.useFakeTimers();
  const lifecycle = new Map(), reserved = new Set(["session"]), rejected = vi.fn();
  let monotonic = 0, serverTime = 1_800_000_000_000;
  const request = vi.fn(async (path: string) => path === "/license/policy" ? { heartbeatSeconds: 120 } : { status: "ESTABLISHED", endsAt: mode === "business" ? 0 : serverTime + 600_000, serverTime });
  const context = { exports: {}, licenseConfigured: () => true, lifecycle, reserved, LicenseError, setTimeout, request, Event, performance: { now: () => monotonic }, window: { dispatchEvent: vi.fn() } };
  const establish = uiFunction("licenseEstablished", context, "apps/desktop/src/core/licensing.ts");
  await establish("session", rejected);
  if (mode === "manual-end") {
    uiFunction("licenseEnded", context, "apps/desktop/src/core/licensing.ts")("session");
    expect(vi.getTimerCount()).toBe(0);
  }
  if (mode === "clock") vi.setSystemTime(Date.now() - 3_600_000);
  for (let minute = 0; minute < 10; minute++) { monotonic += 60_000; await vi.advanceTimersByTimeAsync(60_000); }
  expect(rejected).toHaveBeenCalledTimes(mode === "business" || mode === "manual-end" ? 0 : 1);
  if (mode === "renewal" || mode === "clock") expect(rejected).toHaveBeenCalledWith("FREE_SESSION_LIMIT_REACHED");
  vi.clearAllTimers();
});

test.each(["latest", "click", "stopped", "expired"])("native movement backpressure handles %s without an obsolete queue", async (mode) => {
  vi.useFakeTimers();
  const source = ts.createSourceFile("main.cjs", readFileSync("apps/desktop/electron/main.cjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = source.statements.filter(node => ts.isFunctionDeclaration(node) && ["applyRemoteInput", "flushLatestMouseMove"].includes(node.name?.text ?? "")).map(node => node.getText(source)).join("\n");
  const helper = { stdin: { writable: true, writableLength: 80, write: vi.fn() }, nodusPendingMove: null as any };
  const context = createContext({ Date, setTimeout, clearTimeout, remoteControlActive: true, inputHelper: helper, ensureInputHelper: () => helper,
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ bounds: {} }) }, captureOptions: {}, normalizeRemoteInput: (input: any) => input,
    hostCursorVisibility: { remoteMouseActivity: vi.fn() }, appendLog: vi.fn() });
  const apply = runInContext(`${code}; applyRemoteInput`, context);
  for (let i = 0; i < 20; i++) apply({ type: "mouseMove", x: i, y: i });
  expect(helper.stdin.write).not.toHaveBeenCalled();
  expect(helper.nodusPendingMove.message.x).toBe(19);
  if (mode === "click") apply({ type: "mouseDown", x: 30, y: 30, button: 0 });
  if (mode === "stopped") context.remoteControlActive = false;
  if (mode === "expired") await vi.advanceTimersByTimeAsync(104);
  helper.stdin.writableLength = 0;
  await vi.advanceTimersByTimeAsync(8);
  expect(helper.nodusPendingMove).toBeNull();
  expect(helper.stdin.write).toHaveBeenCalledTimes(mode === "latest" || mode === "click" ? 1 : 0);
  if (mode === "latest" || mode === "click") expect(JSON.parse(helper.stdin.write.mock.calls[0][0])).toMatchObject({ type: mode === "latest" ? "mouseMove" : "mouseDown", x: mode === "latest" ? 19 : 30 });
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["DEVICE_REVOKED", "SESSION_EXPIRED", "SERVER_UNAVAILABLE"])("licensing lifecycle distinguishes %s from a temporary outage", async (code) => {
  vi.useFakeTimers();
  const lifecycle = new Map(), rejected = vi.fn();
  const establish = uiFunction("licenseEstablished", { exports: {}, licenseConfigured: () => true, lifecycle, reserved: new Set(["session"]), LicenseError, setTimeout,
    request: async (path: string) => { if (path === "/license/policy") return { enforced: true, heartbeatSeconds: 30 }; throw new LicenseError(code as any); } }, "apps/desktop/src/core/licensing.ts");
  await establish("session", rejected);
  expect(rejected).toHaveBeenCalledTimes(code === "SERVER_UNAVAILABLE" ? 0 : 1);
  if (code !== "SERVER_UNAVAILABLE") expect(rejected).toHaveBeenCalledWith(code);
  expect(lifecycle.has("session")).toBe(code === "SERVER_UNAVAILABLE");
  vi.clearAllTimers();
});

test("remote input IPC is restricted to the main app and renderer cleanup closes the helper pipe", () => {
  const sender = { getURL: () => "app", isDestroyed: () => false }, trusted = uiFunction("isMainAppSender", { mainWindow: { isDestroyed: () => false, webContents: sender }, isAllowedAppUrl: (url: string) => url === "app" }, "apps/desktop/electron/main.cjs");
  expect(trusted({ sender })).toBe(true); expect(trusted({ sender: { getURL: () => "app", isDestroyed: () => false } })).toBe(false);
  sender.getURL = () => "https://external.test"; expect(trusted({ sender })).toBe(false);
  const end = vi.fn(), locks = vi.fn();
  const deactivate = uiFunction("setRemoteControlActive", { remoteControlActive: true, clearTimeout, clearInputLocks: locks, inputHelper: { stdin: { end, writable: true } }, powerSaveBlockerId: -1 }, "apps/desktop/electron/main.cjs");
  deactivate(false); expect(end).toHaveBeenCalledOnce(); expect(locks).toHaveBeenCalledOnce();
  const native = readFileSync("native/service/main.cpp", "utf8");
  expect(native).toContain("if (pressedButtons[button]) sendMouseButton(button, false)");
  expect(native).toContain("extendedKeys[key] ? KEYEVENTF_EXTENDEDKEY : 0");
});
test("both desktop modes restrict native caption commands to their own Electron process", () => {
  const child = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), nodusBinaryInput: false });
  const spawn = vi.fn(() => child);
  const ensure = uiFunction("ensureInputHelper", { inputHelper: null, process: { platform: "win32", pid: 321 }, fs: { existsSync: () => true },
    nativeService: "nodus-service.exe", spawn, performanceDiagnostic: null, appendLog: vi.fn() }, "apps/desktop/electron/main.cjs");
  expect(ensure()).toBe(child);
  expect(spawn).toHaveBeenCalledWith("nodus-service.exe", ["--input-helper", "321"], expect.objectContaining({ windowsHide: true }));
  expect(child.nodusBinaryInput).toBe(true);
});

test("admin loads only the active view and reports timeouts in Portuguese", async () => {
  const api = vi.fn(async (path: string) => path === "/admin/dashboard" ? { devices: 2 } : []);
  const setDashboard = vi.fn(), setFeedback = vi.fn(), setVerified = vi.fn();
  const reload = uiFunction("reload", { view: "dashboard", auth: { currentUser: { uid: "owner" } }, api, setDashboard, setFeedback, setVerified, setUpdatedAt: vi.fn(), setOrganizations: vi.fn(), setAccessRequests: vi.fn(), setDevices: vi.fn() }, "apps/admin/src/App.tsx");
  await reload();
  expect(api.mock.calls.map(([path]) => path)).toEqual(["/admin/dashboard", "/admin/organizations", "/admin/access-requests", "/admin/devices"]);
  expect(setDashboard).toHaveBeenCalledExactlyOnceWith({ devices: 2 });
  expect(setFeedback).toHaveBeenCalledExactlyOnceWith("");
  expect(setVerified).toHaveBeenCalledExactlyOnceWith(true);
  api.mockClear();
  await reload("dashboard", true);
  expect(api).toHaveBeenCalledExactlyOnceWith("/admin/dashboard");
  for (const [view, path] of [["access", "/admin/access-requests"], ["devices", "/admin/devices"], ["organizations", "/admin/organizations"]]) {
    api.mockClear(); await reload(view); expect(api).toHaveBeenCalledExactlyOnceWith(path);
  }
  const timeout = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
  const request = uiFunction("api", { auth: { currentUser: { getIdToken: async () => "fixture" } }, base: "https://example.test", URL, AbortSignal, Error, LICENSE_MESSAGES: {}, fetch: vi.fn().mockRejectedValue(timeout) }, "apps/admin/src/App.tsx");
  await expect(request("/admin/dashboard")).rejects.toThrow("O serviço de administração demorou para responder. Tente novamente.");
});

test("admin reports a completed mutation even when its follow-up refresh fails", async () => {
  const feedback = vi.fn();
  const mutate = uiFunction("mutate", { api: vi.fn(async () => ({})), reload: vi.fn().mockRejectedValue(new Error("offline")), view: "devices", selected: "", setDetails: vi.fn(), setFeedback: feedback }, "apps/admin/src/App.tsx");
  await mutate("/admin/device", { deviceId: "device", status: "BLOCKED" });
  expect(feedback).toHaveBeenLastCalledWith("Alteração registrada. Use Atualizar para confirmar os dados.");
});

test("admin searches formatted IDs and accented names locally and clamps pagination", () => {
  const matches = uiFunction("matches", {}, "apps/admin/src/App.tsx");
  expect(matches("123 456 789", "123456789")).toBe(true);
  expect(matches("kaue", undefined, "Kauê Tecnologia")).toBe(true);
  expect(matches("ausente", "Empresa")).toBe(false);
  const rows = Array.from({ length: 23 }, (_, index) => index);
  const paginate = uiFunction("pageRows", { page: 9, PAGE_SIZE: 10 }, "apps/admin/src/App.tsx");
  expect(paginate(rows)).toEqual([20, 21, 22]);
  expect(paginate([])).toEqual([]);
});

test("admin preserves the issued company key when its refresh fails", async () => {
  const api = vi.fn().mockResolvedValue({ key: "fixture-key", licenseId: "business-test" });
  const setSecret = vi.fn(), setFeedback = vi.fn(), setCreate = vi.fn();
  const createCompany = uiFunction("createCompany", { api, name: "Empresa", email: "company@example.test", reload: vi.fn().mockRejectedValue(new Error("offline")), setSecret, setFeedback, setCreate, setSelected: vi.fn(), setTab: vi.fn(), setDetails: vi.fn(), setName: vi.fn(), setEmail: vi.fn(), updateQuery: vi.fn(), updateFilter: vi.fn() }, "apps/admin/src/App.tsx");
  await createCompany();
  expect(api).toHaveBeenCalledExactlyOnceWith("/admin/organizations", { name: "Empresa", email: "company@example.test" });
  expect(setSecret).toHaveBeenCalledExactlyOnceWith("fixture-key");
  expect(setCreate).toHaveBeenCalledExactlyOnceWith(false);
  expect(setFeedback).toHaveBeenLastCalledWith("Empresa criada. Guarde a chave emitida e atualize para consultar os detalhes.");
});

test("desktop heartbeat reuses the registered identity without rewriting its ownership claim", async () => {
  const setDoc = vi.fn(async () => undefined), getDoc = vi.fn();
  const heartbeat = uiFunction("cloudHeartbeat", { exports: {}, ensureDeviceUid: async () => "owner", normalizeNodusId: () => "123456789", cloudDevice: () => ({ nodusId: "123456789", status: "online" }), fire: async () => ({ doc: () => "device-ref", getDoc, setDoc, store: {} }) }, "apps/desktop/src/core/firebase.ts");
  await heartbeat({ nodusId: "123 456 789" });
  expect(getDoc).not.toHaveBeenCalled();
  expect(setDoc).toHaveBeenCalledExactlyOnceWith("device-ref", { nodusId: "123456789", status: "online" }, { merge: true });
});

test("Admin polls only the lightweight dashboard and uses live coordination presence", () => {
  const admin = readFileSync("apps/admin/src/App.tsx", "utf8"), server = readFileSync("services/licensing/src/server.ts", "utf8");
  expect(admin).toContain('view !== "dashboard"');
  expect(admin).toContain('reload("dashboard", true)');
  expect(admin).not.toContain("window.setInterval(refresh, 30_000)");
  expect(server).toContain('db.collection("devices").where("updatedAt", ">=", onlineSince)');
  expect(server).toContain("const presence = rows.empty ? [] : await db.getAll");
});

test("Electron forwards punctuation, dead keys, numpad and every viewer virtual key", () => {
  const file = "apps/desktop/electron/main.cjs";
  const remoteVirtualKey = uiFunction("remoteVirtualKey", {}, file);
  const convert = uiFunction("toRemoteKeyboardInput", { remoteVirtualKey }, file);
  const renderer = uiFunction("virtualKeyFromCode");
  const codes = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(letter => `Key${letter}`)
    .concat([..."0123456789"].flatMap(number => [`Digit${number}`, `Numpad${number}`]),
      ["Semicolon", "Equal", "Comma", "Minus", "Period", "Slash", "Backquote", "BracketLeft", "Backslash", "BracketRight", "Quote", "CapsLock", "NumLock", "NumpadEnter", "NumpadDivide", "ShiftLeft", "ControlRight", "AltRight", "IntlBackslash"]);
  for (const code of codes) expect(convert({ code, key: "Dead" })?.keyCode).toBe(renderer(code));
  expect(convert({ code: "Unidentified" })).toBeNull();
});

test("pointer sends immediately, coalesces movement and sends the latest position", () => {
  const sent = vi.fn(), pendingPointerRef = { current: null }, pointerFrameRef = { current: 0 };
  let frame: () => void = () => {};
  const move = uiFunction("sendPointerMove", { activeSession: { role: "viewer", sessionId: "s" }, remotePoint: (_: unknown, event: any) => event.point,
    lastPointerPointRef: { current: null }, inputDiagnostic: () => undefined, pendingPointerRef, pointerFrameRef,
    sendRemoteInputToSession: sent, window: { requestAnimationFrame: (callback: () => void) => { frame = callback; return 1; } } });
  const event = (x: number) => ({ currentTarget: {}, nativeEvent: { point: { x, y: 0.5 } }, timeStamp: x });
  move(event(0.1)); expect(sent).toHaveBeenCalledExactlyOnceWith("s", { type: "mouseMove", x: 0.1, y: 0.5 }, 0.1);
  move(event(0.2)); move(event(0.3)); expect(sent).toHaveBeenCalledTimes(1);
  frame(); expect(sent).toHaveBeenLastCalledWith("s", { type: "mouseMove", x: 0.3, y: 0.5 }, 0.3);
  expect(pendingPointerRef.current).toBeNull();
});

test("legacy control fallback is bounded and never replaces an open pointer channel", () => {
  const control = { readyState: "open", bufferedAmount: 0, send: vi.fn() }, pointerChannelsRef = { current: new Map() };
  const send = uiFunction("sendRemoteInputToSession", { pointerChannelsRef, controlChannelsRef: { current: new Map([["s", control]]) },
    bufferedPointersRef: { current: new Map() }, inputCapabilitiesRef: { current: new Set() }, inputDiagnostic: () => undefined, encodePointerMessage: () => new Uint8Array(9) });
  const input = { type: "mouseMove", x: 0.4, y: 0.5 };
  send("s", input); expect(control.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify(input));
  control.bufferedAmount = 1000; send("s", input); expect(control.send).toHaveBeenCalledTimes(1);
  const pointer = { readyState: "open", bufferedAmount: 0, send: vi.fn() }; pointerChannelsRef.current.set("s", pointer);
  send("s", input); expect(pointer.send).toHaveBeenCalledOnce(); expect(control.send).toHaveBeenCalledTimes(1);
});

function pointerTransportFixture(upgraded = true) {
  const control: any = { readyState: "open", bufferedAmount: 0, send: vi.fn() };
  const pointer: any = { readyState: "open", bufferedAmount: 0, send: vi.fn() };
  const context: any = { controlChannelsRef: { current: new Map([["s", control]]) }, pointerChannelsRef: { current: new Map() },
    auxiliaryChannelsRef: { current: new Map() }, telemetryChannelsRef: { current: new Map() },
    inputCapabilitiesRef: { current: new Set(upgraded ? ["s"] : []) }, pointerSequencesRef: { current: new Map() }, bufferedPointersRef: { current: new Map() },
    inputDiagnostic: () => undefined, encodePointerMessage: uiFunction("encodePointerMessage"), sessionsRef: { current: [{ session: { sessionId: "s", role: "viewer" } }] },
    performance, updateRuntime: vi.fn() };
  context.auxiliaryChannel = uiFunction("auxiliaryChannel", context);
  context.sendRemoteInputToSession = uiFunction("sendRemoteInputToSession", context);
  context.flushBufferedPointer = uiFunction("flushBufferedPointer", context);
  uiFunction("attachViewerPointer", context)("s", pointer);
  return { context, control, pointer, send: context.sendRemoteInputToSession, decode: uiFunction("decodePointerMessage") };
}

test("blocked pointer retains exactly the final position and drains without another mouse event", () => {
  const { context, pointer, send, decode } = pointerTransportFixture();
  pointer.bufferedAmount = 1000;
  for (let i = 0; i < 1000; i++) send("s", { type: "mouseMove", x: i / 1000, y: 0.5 });
  expect(pointer.send).not.toHaveBeenCalled(); expect(context.bufferedPointersRef.current.size).toBe(1);
  pointer.bufferedAmount = 0; pointer.onbufferedamountlow();
  expect(pointer.send).toHaveBeenCalledOnce();
  expect(decode(pointer.send.mock.calls[0][0])).toMatchObject({ x: expect.closeTo(0.999), y: 0.5, sequence: 1 });
  expect(context.bufferedPointersRef.current.size).toBe(0);
});

test("click watermark cancels a blocked movement while keyboard and wheel remain reliable and ordered", () => {
  const { pointer, control, send } = pointerTransportFixture();
  send("s", { type: "mouseMove", x: 0.1, y: 0.1 });
  pointer.bufferedAmount = 1000;
  send("s", { type: "mouseMove", x: 0.2, y: 0.2 });
  send("s", { type: "mouseDown", x: 0.3, y: 0.3, button: 0 });
  send("s", { type: "keyDown", keyCode: 162 }); send("s", { type: "keyUp", keyCode: 162 });
  send("s", { type: "wheel", delta: 120 }); send("s", { type: "mouseUp", x: 0.3, y: 0.3, button: 0 });
  pointer.bufferedAmount = 0; pointer.onbufferedamountlow();
  expect(pointer.send).toHaveBeenCalledOnce();
  const messages = control.send.mock.calls.map(([data]: any[]) => JSON.parse(data));
  expect(messages.map((m: any) => m.type)).toEqual(["mouseDown", "keyDown", "keyUp", "wheel", "mouseUp"]);
  expect(messages[0].sequence).toBe(2); expect(messages[4].sequence).toBe(3);
});

test("legacy clients keep the nine-byte packet until the host advertises version two", () => {
  const { pointer, send } = pointerTransportFixture(false);
  send("s", { type: "mouseMove", x: 0.25, y: 0.75 });
  expect(pointer.send.mock.calls[0][0].byteLength).toBe(9);
  const encode = uiFunction("encodePointerMessage"), decode = uiFunction("decodePointerMessage");
  expect(decode(encode(0.25, 0.75, 42, 6))).toEqual({ type: "mouseMove", x: 0.25, y: 0.75, probeId: 42, sequence: 6 });
});

test("sequence discards replay and reordering, handles wrap, and never discards a button", () => {
  const pointerSequencesRef = { current: new Map() }, accept = uiFunction("acceptPointerSequence", { pointerSequencesRef });
  expect(accept("s", 10)).toBe(true); expect(accept("s", 9)).toBe(false); expect(accept("s", 10)).toBe(false);
  expect(accept("s", 8, false)).toBe(true); expect(pointerSequencesRef.current.get("s")).toBe(10);
  expect(accept("s", 11)).toBe(true); expect(accept("s", NaN)).toBe(false); expect(accept("s", 0)).toBe(false);
  pointerSequencesRef.current.set("s", 0xffffffff); expect(accept("s", 1)).toBe(true);
});

test("clipboard, telemetry and input use separate streams and legacy clipboard keeps its fallback", () => {
  const { context, control, send } = pointerTransportFixture();
  const clipboard: any = { readyState: "open", bufferedAmount: 900_000, send: vi.fn() };
  const telemetry: any = { readyState: "open", bufferedAmount: 0, send: vi.fn() };
  context.auxiliaryChannelsRef.current.set("s", clipboard); context.telemetryChannelsRef.current.set("s", telemetry);
  send("s", { type: "clipboard", text: "a".repeat(100_000) }); send("s", { type: "keyDown", keyCode: 84 });
  expect(clipboard.send).toHaveBeenCalledOnce(); expect(control.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ type: "keyDown", keyCode: 84 }));
  expect(context.auxiliaryChannel("s", true)).toBe(telemetry);
  context.inputCapabilitiesRef.current.clear(); send("s", { type: "clipboard", text: "legacy" });
  expect(control.send).toHaveBeenLastCalledWith(JSON.stringify({ type: "clipboard", text: "legacy" }));
});

test.each([true, false])("auxiliary clipboard preserves permission checks: allowed=%s", (allowed) => {
  const apply = vi.fn(), clipboard = vi.fn(async () => {}), channel: any = { label: "auxiliary" };
  const attach = uiFunction("attachHostControl", { auxiliaryChannelsRef: { current: new Map() }, hostInputRateRef: { current: new Map() },
    sessionsRef: { current: [{ session: { sessionId: "s", permissions: allowed ? ["clipboard:sync"] : [] } }] },
    settings: { allowClipboard: true, allowRemoteControl: true }, window: { nodusDesktop: { applyRemoteInput: apply, writeClipboard: clipboard } }, updateRuntime: vi.fn() });
  attach("s", channel, true); channel.onmessage({ data: JSON.stringify({ type: "clipboard", text: "hello" }) });
  channel.onmessage({ data: JSON.stringify({ type: "keyDown", keyCode: 84 }) });
  expect(clipboard).toHaveBeenCalledTimes(allowed ? 1 : 0); expect(apply).not.toHaveBeenCalled();
});

test.each(["host", "viewer"])("%s telemetry rejects older feedback and cannot alter input readiness", role => {
  const feedback: any = { current: new Map() }, updateRuntime = vi.fn(), apply = vi.fn();
  const context: any = { telemetryChannelsRef: { current: new Map() }, hostInputRateRef: { current: new Map() },
    sessionsRef: { current: [{ session: { sessionId: "s", permissions: ["keyboard:control"] } }] },
    settings: { allowRemoteControl: true }, receiverFeedbackRef: feedback, senderFeedbackRef: feedback,
    window: { nodusDesktop: { applyRemoteInput: apply } }, performance: { now: () => 1000 }, updateRuntime };
  const channel: any = { label: "telemetry" };
  uiFunction(role === "host" ? "attachHostControl" : "attachViewerControl", context)("s", channel, true);
  const type = role === "host" ? "receiver-stats" : "sender-stats";
  const send = (message: any) => channel.onmessage({ data: JSON.stringify(message) });
  send({ type, sampleAt: 20, marker: "latest" }); send({ type, sampleAt: 10, marker: "old" });
  send({ type, sampleAt: 20, marker: "duplicate" }); send({ type: "keyDown", keyCode: 84 });
  expect(feedback.current.get("s").marker).toBe("latest");
  channel.onopen(); channel.onclose(); expect(updateRuntime).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
  feedback.current.clear(); send({ type, marker: "legacy" });
  expect(feedback.current.get("s").marker).toBe("legacy");
});

test.each(["latest", "click", "closed", "permission"])("host burst is bounded and handles %s without replaying old positions", async (mode) => {
  vi.useFakeTimers();
  const apply = vi.fn(), pointerSequencesRef = { current: new Map() }, channel: any = { readyState: "open" };
  let sequence = 0;
  const context: any = { ArrayBuffer, pointerSequencesRef, pointerChannelsRef: { current: new Map() }, inputDiagnostic: () => undefined,
    settings: { allowRemoteControl: true }, sessionsRef: { current: [{ session: { sessionId: "s", permissions: ["mouse:control"] } }] },
    window: { setTimeout, clearTimeout, nodusDesktop: { applyRemoteInput: apply } }, performance: { now: () => Date.now() },
    decodePointerMessage: () => ({ type: "mouseMove", x: sequence / 1000, y: 0.5, sequence }) };
  context.acceptPointerSequence = uiFunction("acceptPointerSequence", context);
  uiFunction("attachHostPointer", context)("s", channel);
  for (sequence = 1; sequence <= 1000; sequence++) channel.onmessage({ data: new ArrayBuffer(17) });
  expect(apply).toHaveBeenCalledOnce();
  if (mode === "click") context.acceptPointerSequence("s", 1001, false);
  if (mode === "closed") { channel.readyState = "closed"; channel.onclose(); }
  if (mode === "permission") context.settings.allowRemoteControl = false;
  await vi.advanceTimersByTimeAsync(5);
  expect(apply).toHaveBeenCalledTimes(mode === "latest" ? 2 : 1);
  if (mode === "latest") expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ x: 1, sequence: 1000 }));
  expect(vi.getTimerCount()).toBe(0);
});

test("typing preserves the pending native mouse move and does not wait for its buffer", async () => {
  vi.useFakeTimers();
  const source = readFileSync("apps/desktop/electron/main.cjs", "utf8");
  const helper: any = { stdin: { writable: true, writableLength: 80, write: vi.fn() } };
  const context: any = { Date, setTimeout, clearTimeout, remoteControlActive: true, inputHelper: helper, ensureInputHelper: () => helper,
    screen: { getAllDisplays: () => [], getPrimaryDisplay: () => ({ bounds: {} }) }, captureOptions: {}, normalizeRemoteInput: (input: any) => input,
    hostCursorVisibility: { remoteMouseActivity: vi.fn() }, appendLog: vi.fn() };
  context.flushLatestMouseMove = uiFunction("flushLatestMouseMove", context, "apps/desktop/electron/main.cjs");
  const apply = uiFunction("applyRemoteInput", context, "apps/desktop/electron/main.cjs");
  apply({ type: "mouseMove", x: 50, y: 20 }); apply({ type: "keyDown", keyCode: 84 }); apply({ type: "keyUp", keyCode: 84 });
  expect(helper.nodusPendingMove.message.x).toBe(50); expect(helper.stdin.write).toHaveBeenCalledTimes(2);
  helper.stdin.writableLength = 0; await vi.advanceTimersByTimeAsync(5);
  expect(JSON.parse(helper.stdin.write.mock.calls[2][0])).toMatchObject({ type: "mouseMove", x: 50 });
  expect(vi.getTimerCount()).toBe(0); expect(source).toContain('if (message.type.startsWith("mouse"))');
});

function adaptiveSenderFixture() {
  let now = 1000;
  const parameters: any = { encodings: [{ maxBitrate: 14_000_000 }] };
  const sender = { track: { kind: "video", getSettings: () => ({ width: 1920, height: 1080 }) }, getParameters: () => parameters, setParameters: vi.fn(async () => {}) };
  const context: any = { performance: { now: () => now }, settings: { connectionQuality: "auto", maxFps: 60, preferredResolution: "1920x1080" },
    performanceDiagnosticRef: { current: null }, nativeHostSessionsRef: { current: new Set() }, nativeMediaStatsRef: { current: new Map() },
    requestedQualitiesRef: { current: new Map() }, requestedFpsRef: { current: new Map() }, requestedResolutionsRef: { current: new Map() },
    adaptiveStateRef: { current: new Map([["s", { stage: 0, badSamples: 0, stableSamples: 0, changedAt: 0, changeCount: 0, startedAt: -5000, reason: "initial", source: "none" }]]) },
    smoothedQualityRef: { current: new Map() }, qualityTierRef: { current: new Map() },
    appliedVideoRef: { current: new Map([["s", { fps: 60, width: 1920, height: 1080, bitrate: 14_000_000, at: 0 }]]) },
    window: { nodusDesktop: { writePerformance: vi.fn(async () => {}) } }, logMediaDiagnostic: vi.fn(),
    advanceStage, assessQuality, DESKTOP_VIDEO_POLICY, nativeVideoBitrate, nextBitrate, STAGE_LIMITS,
    boundedFrameRate: uiFunction("boundedFrameRate"), resolutionForSource: uiFunction("resolutionForSource"), smoothQualitySample: uiFunction("smoothQualitySample") };
  const apply = uiFunction("applyAdaptiveQuality", context), peer = { getSenders: () => [sender] };
  const sample = { rttMs: 20, jitterMs: 2, lossPct: 0, availableKbps: 20_000, bitrateKbps: 14_000, captureFps: 60, encodedFps: 60, encodeMs: 5, targetFps: 60, activePicture: true, limitation: "none" };
  return { context, parameters, sender, sample, apply: (value = sample) => apply("s", peer, "host", value), advance: (at: number) => { now = at; } };
}

test("actual sender relieves a 2Mbps queue before its 2s cooldown and only then lowers resolution", async () => {
  const f = adaptiveSenderFixture(), bad = { ...f.sample, availableKbps: 2000, limitation: "bandwidth", packetSendDelayMs: 120 };
  await f.apply(bad);
  expect(f.parameters.encodings[0]).toMatchObject({ maxBitrate: 7_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 });
  f.advance(1500); await f.apply(bad);
  expect(f.parameters.encodings[0]).toMatchObject({ maxBitrate: 3_500_000, maxFramerate: 60, scaleResolutionDownBy: 1 });
  f.advance(2000); await f.apply(bad);
  expect(f.parameters.encodings[0]).toMatchObject({ maxBitrate: 1_750_000, maxFramerate: 45, scaleResolutionDownBy: 1.2 });
  expect(f.sender.setParameters).toHaveBeenCalledTimes(3);
});

test("a healthy 1080p60 sender is not forced to 720p or 30FPS by a high RTT alone", async () => {
  const f = adaptiveSenderFixture(); f.advance(5000);
  await f.apply({ ...f.sample, rttMs: 380 });
  expect(f.parameters.encodings[0]).toMatchObject({ maxBitrate: 14_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 });
});

test("receiver recovery retains the degraded network profile until its gradual step is confirmed", async () => {
  const f = adaptiveSenderFixture();
  f.context.adaptiveStateRef.current.set("s", { stage: 4, badSamples: 0, stableSamples: 19, changedAt: 0, changeCount: 4, startedAt: -5000, source: "network", reason: "loss" });
  f.context.appliedVideoRef.current.set("s", { fps: 30, width: 1280, height: 720, bitrate: 1_000_000, at: 0 });
  f.advance(11000); await f.apply();
  expect(f.context.adaptiveStateRef.current.get("s")).toMatchObject({ stage: 3, source: "network" });
  expect(f.parameters.encodings[0]).toMatchObject({ maxBitrate: 1_100_000, maxFramerate: 45, scaleResolutionDownBy: 1.2 });
});

test("input rate limiting never strands Ctrl or a held mouse button", () => {
  const apply = vi.fn(), channel: any = {}, updateRuntime = vi.fn();
  const attach = uiFunction("attachHostControl", { controlChannelsRef: { current: new Map() }, hostInputRateRef: { current: new Map([["s", { at: Date.now(), count: 500 }]]) },
    sessionsRef: { current: [{ session: { sessionId: "s", permissions: ["keyboard:control", "mouse:control"] } }] }, settings: { allowRemoteControl: true }, window: { nodusDesktop: { applyRemoteInput: apply } }, updateRuntime, acceptPointerSequence: () => true });
  attach("s", channel);
  const send = (type: string) => channel.onmessage({ data: JSON.stringify({ type, keyCode: 162, code: "ControlLeft", button: 0, x: 0.5, y: 0.5 }) });
  send("keyDown"); expect(apply).not.toHaveBeenCalled();
  send("keyUp"); send("mouseUp"); expect(apply.mock.calls.map(([input]) => input.type)).toEqual(["keyUp", "mouseUp"]);
  expect(updateRuntime).not.toHaveBeenCalled();
});

test("licensing loading belongs only to the clicked action and cannot submit a second request", async () => {
  let index = 0; const state: any[] = [{ plan: "free", trialUsed: 0, trialLimit: 200, allowed: true }, "NODUS-preserved", "", null, ""], guard = { current: false };
  let resolve!: (info: any) => void;
  const checkLicense = vi.fn(() => new Promise(done => { resolve = done; })), requestMoreAccesses = vi.fn();
  const icon = () => null;
  const panel = uiFunction("LicensePanel", { exports: {}, React, useEffect: () => {}, useRef: () => guard,
    useState: () => { const slot = index++; return [state[slot], (value: unknown) => { state[slot] = value; }]; }, licenseConfigured: () => true,
    checkLicense, requestMoreAccesses, licenseFeedback: () => "Falha", ShieldCheck: icon, RefreshCw: icon, MailPlus: icon, KeyRound: icon, ExternalLink: icon,
  }, "apps/desktop/src/LicensePanel.tsx");
  const render = () => {
    index = 0; const buttons: React.ReactElement<any>[] = [];
    const visit = (node: any) => { if (!React.isValidElement(node)) return; const element = node as React.ReactElement<any>; if (element.type === "button") buttons.push(element); React.Children.forEach(element.props.children, visit); };
    visit(panel({ identity: {} })); return buttons;
  };
  const pending = render()[0].props.onClick();
  const buttons = render();
  expect(buttons[0].props["aria-busy"]).toBe(true); expect(buttons[0].props.disabled).toBe(true);
  expect(buttons[1].props["aria-busy"]).toBe(false); expect(buttons[1].props.disabled).toBe(false);
  await buttons[1].props.onClick(); expect(requestMoreAccesses).not.toHaveBeenCalled();
  resolve(state[0]); await pending; expect(state[1]).toBe("NODUS-preserved"); expect(render()[0].props["aria-busy"]).toBe(false);
});

test.each(["auto", "high", "balanced", "economy"])("%s desktop profile protects text and native pixels without changing the FPS target", async (connectionQuality) => {
  const track = { contentHint: "motion", getSettings: () => ({ width: 1366, height: 768 }) };
  const parameters = { encodings: [] };
  const sender = { track, getParameters: () => parameters, setParameters: vi.fn(async () => {}) };
  const tune = uiFunction("tuneVideoSender", { settings: { connectionQuality }, performanceDiagnosticRef: { current: null }, DESKTOP_VIDEO_POLICY,
    boundedFrameRate: uiFunction("boundedFrameRate"), resolutionForSource: uiFunction("resolutionForSource") });
  await tune(sender, 60, "native");
  expect(sender.setParameters).toHaveBeenCalledOnce();
  expect(parameters).toMatchObject({ degradationPreference: "maintain-resolution", encodings: [{ maxFramerate: 60, scaleResolutionDownBy: 1 }] });
  expect(track.contentHint).toBe("text");
});

test("desktop policy preserves explicit diagnostic overrides and requested lower resolution", async () => {
  const track = { contentHint: "text", getSettings: () => ({ width: 3840, height: 2160 }) };
  const parameters = { encodings: [] };
  const sender = { track, getParameters: () => parameters, setParameters: vi.fn(async () => {}) };
  const tune = uiFunction("tuneVideoSender", { settings: { connectionQuality: "high" }, performanceDiagnosticRef: { current: { contentHint: "motion", degradationPreference: "maintain-framerate" } }, DESKTOP_VIDEO_POLICY,
    boundedFrameRate: uiFunction("boundedFrameRate"), resolutionForSource: uiFunction("resolutionForSource") });
  await tune(sender, 60, "1920x1080");
  expect(parameters).toMatchObject({ degradationPreference: "maintain-framerate", encodings: [{ scaleResolutionDownBy: 2 }] });
  expect(track.contentHint).toBe("motion");
});

test.each([1, 1.25, 1.5, 2])("original view maps one received pixel to one display pixel at DPI %s", (ratio) => {
  const size = uiFunction("nativeVideoSize")(1920, 1080, ratio);
  expect(parseFloat(size.width) * ratio).toBe(1920);
  expect(parseFloat(size.height) * ratio).toBe(1080);
});

test("original view has a bounded fallback before metadata and for invalid DPI", () => {
  const size = uiFunction("nativeVideoSize");
  expect(size(0, 0, 1)).toEqual({ width: "100%", height: "100%" });
  expect(size(1920, 1080, 0)).toEqual({ width: "1920px", height: "1080px" });
});

test("scrolled original view keeps cursor overlay and remote coordinates aligned and ignores scrollbars", () => {
  const surface = { dataset: { viewScale: "native" }, clientLeft: 1, clientTop: 1, clientWidth: 800, clientHeight: 500, scrollLeft: 300, scrollTop: 100,
    getBoundingClientRect: () => ({ left: 10, top: 20 }), querySelector: () => ({ videoWidth: 1920, videoHeight: 1080,
      getBoundingClientRect: () => ({ left: -289, top: -79, width: 1920, height: 1080 }) }) };
  const point = uiFunction("videoPoint", { mapVideoPointer });
  const mapped = point(surface, { clientX: 211, clientY: 221 });
  expect(mapped).toMatchObject({ x: 500 / 1920, y: 300 / 1080, left: 500, top: 300 });
  expect(point(surface, { clientX: 815, clientY: 221 })).toBeNull();
  expect(point(surface, { clientX: 211, clientY: 525 })).toBeNull();
});

test("fit view retains letterbox rejection and centered pointer mapping", () => {
  const surface = { dataset: { viewScale: "fit" }, clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelector: () => ({ videoWidth: 1920, videoHeight: 1080,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) }) };
  const point = uiFunction("videoPoint", { mapVideoPointer });
  expect(point(surface, { clientX: 500, clientY: 500 })).toMatchObject({ x: 0.5, y: 0.5 });
  expect(point(surface, { clientX: 500, clientY: 100 })).toBeNull();
});

test.each(["en-US", "ru-RU", "ja-JP"] as const)("viewer scaling controls are translated in %s", (language) => {
  for (const label of ["Visualização", "Ajustar à janela"]) expect(translateText(label, language)).not.toBe(label);
  expect(translateText("Original (1:1)", language)).toBe(({ "en-US": "Original (1:1)", "ru-RU": "Исходный размер (1:1)", "ja-JP": "元のサイズ (1:1)" })[language]);
});

function viewerKeyboardFixture(nativeCapture = true) {
  const source = ts.createSourceFile("App.tsx", readFileSync("apps/desktop/src/App.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const panel = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "RemoteSessionPanel") as ts.FunctionDeclaration;
  const effect = panel.body!.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "useEffect" && node.expression.arguments[0].getText(source).includes("const releasePressedKeys")) as ts.ExpressionStatement;
  const callback = (effect.expression as ts.CallExpression).arguments[0].getText(source);
  const events = () => {
    const listeners = new Map<string, Set<(event: Event) => void>>();
    return {
      addEventListener: (type: string, listener: (event: Event) => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
      removeEventListener: (type: string, listener: (event: Event) => void) => listeners.get(type)?.delete(listener),
      dispatchEvent: (event: Event) => { listeners.get(event.type)?.forEach((listener) => listener(event)); },
    };
  };
  const surface = { contains: (target: unknown) => target === surface }, toolbar = {};
  const document = Object.assign(events(), { activeElement: surface as unknown, visibilityState: "visible" });
  const send = vi.fn(), capture = vi.fn(async () => undefined), removeNative = vi.fn();
  let native: (type: string, input: any) => void;
  const window = Object.assign(events(), { nodusDesktop: { setRemoteKeyboardCapture: capture, onRemoteKeyInput: nativeCapture ? (listener: typeof native) => { native = listener; return removeNative; } : undefined } });
  const virtualKeyFromCode = uiFunction("virtualKeyFromCode");
  const code = ts.transpileModule(`const effect = ${callback};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const cleanup = runInNewContext(`${code}; effect()`, { window, document, isViewer: true, canControlKeyboard: true, viewerSurfaceRef: { current: surface }, pressedKeysRef: { current: new Map() }, onKeyInputRef: { current: send }, virtualKeyFromCode, toRemoteKeyInput: uiFunction("toRemoteKeyInput", { virtualKeyFromCode }) });
  const key = (type: string, keyCode = 162, code = "ControlLeft", repeat = false) => {
    if (nativeCapture) native(type === "keydown" ? "keyDown" : "keyUp", { keyCode, code, location: 1, repeat });
    return window.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { keyCode, code, location: 1, repeat }));
  };
  const blurSurface = () => {
    document.activeElement = toolbar;
    const event = Object.assign(new Event("focusout"), { relatedTarget: toolbar });
    Object.defineProperty(event, "target", { value: surface });
    document.dispatchEvent(event);
  };
  return { window, document, send, capture, removeNative, key, blurSurface, native: (type: string, input: any) => native(type, input), cleanup };
}

test("Electron interception keeps keyDown uncancelled so Chromium emits keyUp", () => {
  const window = Object.assign(new EventEmitter(), { webContents: Object.assign(new EventEmitter(), {
    id: 7, isDestroyed: () => false, setIgnoreMenuShortcuts: vi.fn(), send: vi.fn(),
  }) });
  const attach = uiFunction("attachRemoteKeyboardForwarding", {
    remoteWindowsKeys: null, remoteKeyboardCaptureActive: true, remoteKeyboardCaptureWebContentsId: 7,
    toRemoteKeyboardInput: uiFunction("toRemoteKeyboardInput", { remoteVirtualKey: uiFunction("remoteVirtualKey", {}, "apps/desktop/electron/main.cjs") }, "apps/desktop/electron/main.cjs"),
  }, "apps/desktop/electron/main.cjs");
  attach(window);
  for (const type of ["keyDown", "keyUp"]) {
    const event = { preventDefault: vi.fn() };
    window.webContents.emit("before-input-event", event, { type, code: "KeyT", isAutoRepeat: false });
    expect(event.preventDefault).toHaveBeenCalledTimes(type === "keyDown" ? 0 : 1);
  }
  expect(window.webContents.send.mock.calls.map(([, type]) => type)).toEqual(["keyDown", "keyUp"]);
  window.emit("blur");
  expect(window.webContents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
});

test.each([true, false])("closing Electron windows releases keyboard capture without reading a destroyed window (contents destroyed: %s)", (contentsDestroyed) => {
  let destroyed = false;
  const contents = Object.assign(new EventEmitter(), { id: 7,
    isDestroyed: () => destroyed && contentsDestroyed, setIgnoreMenuShortcuts: vi.fn(), send: vi.fn() });
  const window = new EventEmitter();
  Object.defineProperty(window, "webContents", { get() {
    if (destroyed) throw new TypeError("Object has been destroyed");
    return contents;
  } });
  const context = { remoteWindowsKeys: { stop: vi.fn() }, remoteKeyboardCaptureActive: true, remoteKeyboardCaptureWebContentsId: 7 };
  const attach = uiFunction("attachRemoteKeyboardForwarding", context, "apps/desktop/electron/main.cjs");
  attach(window);
  destroyed = true;
  expect(() => window.emit("closed")).not.toThrow();
  expect(() => contents.emit("render-process-gone")).not.toThrow();
  expect(context.remoteWindowsKeys.stop.mock.calls[0][0] === window).toBe(true);
  expect(context.remoteKeyboardCaptureActive).toBe(false);
  expect(context.remoteKeyboardCaptureWebContentsId).toBe(0);
  expect(contents.setIgnoreMenuShortcuts).toHaveBeenCalledTimes(contentsDestroyed ? 0 : 2);
});

test.each([true, false])("repeated letters in teste remain usable with native capture %s", (nativeCapture) => {
  const f = viewerKeyboardFixture(nativeCapture);
  for (const letter of "TESTE TESTE AAA") {
    const keyCode = letter.charCodeAt(0), code = letter === " " ? "Space" : `Key${letter}`;
    f.key("keydown", keyCode, code); f.key("keyup", keyCode, code);
  }
  expect(f.send.mock.calls.filter(([type]) => type === "keyDown").map(([, input]) => String.fromCharCode(input.keyCode)).join("")).toBe("TESTE TESTE AAA");
  expect(f.send.mock.calls.map(([type]) => type)).toEqual(Array.from({ length: 15 }, () => ["keyDown", "keyUp"]).flat());
  f.cleanup();
  expect(f.send).toHaveBeenCalledTimes(30);
});

test("native auto-repeat is not sent twice by the DOM fallback", () => {
  const f = viewerKeyboardFixture();
  f.key("keydown", 84, "KeyT");
  f.key("keydown", 84, "KeyT", true);
  f.key("keydown", 84, "KeyT", true);
  f.key("keyup", 84, "KeyT");
  expect(f.send.mock.calls.map(([type, input]) => [type, input.repeat])).toEqual([["keyDown", false], ["keyDown", true], ["keyDown", true], ["keyUp", false]]);
  f.cleanup();
});

test("leaving the remote image releases Ctrl and disables capture immediately", () => {
  const f = viewerKeyboardFixture();
  f.key("keydown"); f.blurSurface();
  expect(f.send.mock.calls.map(([type]) => type)).toEqual(["keyDown", "keyUp"]);
  expect(f.send.mock.calls[1][1]).toMatchObject({ keyCode: 162, code: "ControlLeft", repeat: false });
  expect(f.capture).toHaveBeenLastCalledWith(false);
  f.key("keyup");
  expect(f.send).toHaveBeenCalledTimes(2);
  f.cleanup();
});

test("native generic Ctrl and browser left Ctrl use the same down/up identity", () => {
  const f = viewerKeyboardFixture();
  f.native("keyDown", { keyCode: 17, code: "ControlLeft", location: 0, repeat: false });
  f.key("keydown"); f.key("keyup");
  expect(f.send.mock.calls.map(([type, input]) => [type, input.keyCode])).toEqual([["keyDown", 162], ["keyUp", 162]]);
  f.cleanup();
});

test("late native keydowns cannot control the host after focus leaves the image", () => {
  const f = viewerKeyboardFixture();
  f.blurSurface();
  f.native("keyDown", { keyCode: 162, code: "ControlLeft", location: 1, repeat: false });
  expect(f.send).not.toHaveBeenCalled();
  f.cleanup();
});

test("hidden viewer releases held modifiers and ignores new native keydowns", () => {
  const f = viewerKeyboardFixture();
  f.key("keydown");
  f.document.visibilityState = "hidden";
  f.document.dispatchEvent(new Event("visibilitychange"));
  f.native("keyDown", { keyCode: 162, code: "ControlLeft", location: 1, repeat: false });
  expect(f.send.mock.calls.map(([type]) => type)).toEqual(["keyDown", "keyUp"]);
  f.cleanup();
});

test("Ctrl combinations retain ordering and repeat while cleanup releases each held key once", () => {
  const f = viewerKeyboardFixture();
  f.key("keydown"); f.key("keydown", 67, "KeyC"); f.key("keydown", 67, "KeyC", true);
  f.window.dispatchEvent(new Event("blur"));
  f.cleanup();
  expect(f.send.mock.calls.map(([type, input]) => [type, input.keyCode])).toEqual([["keyDown", 162], ["keyDown", 67], ["keyDown", 67], ["keyUp", 162], ["keyUp", 67]]);
  expect(f.removeNative).toHaveBeenCalledOnce();
  f.key("keydown");
  expect(f.send).toHaveBeenCalledTimes(5);
});

test.each([["ControlRight", 17, 163], ["ShiftLeft", 16, 160], ["ShiftRight", 16, 161], ["AltRight", 18, 165]])("%s retains its side across generic native and browser events", (code, generic, canonical) => {
  const f = viewerKeyboardFixture();
  f.native("keyDown", { keyCode: generic, code, location: 0, repeat: false });
  f.key("keyup", canonical as number, code as string);
  expect(f.send.mock.calls.map(([type, input]) => [type, input.keyCode])).toEqual([["keyDown", canonical], ["keyUp", canonical]]);
  f.cleanup();
});

test("Ctrl+C and Ctrl+V release Ctrl before ordinary typing", () => {
  const f = viewerKeyboardFixture();
  for (const code of ["KeyC", "KeyV"]) {
    f.key("keydown"); f.key("keydown", code.charCodeAt(3), code);
    f.key("keyup", code.charCodeAt(3), code); f.key("keyup");
  }
  f.key("keydown", 65, "KeyA"); f.key("keyup", 65, "KeyA");
  expect(f.send.mock.calls.map(([type, input]) => [type, input.keyCode])).toEqual([["keyDown", 162], ["keyDown", 67], ["keyUp", 67], ["keyUp", 162], ["keyDown", 162], ["keyDown", 86], ["keyUp", 86], ["keyUp", 162], ["keyDown", 65], ["keyUp", 65]]);
  f.cleanup();
  expect(f.send).toHaveBeenCalledTimes(10);
});

test("window blur ignores delayed keys and refocusing restores remote shortcuts", () => {
  const f = viewerKeyboardFixture();
  f.key("keydown"); f.window.dispatchEvent(new Event("blur"));
  f.native("keyDown", { keyCode: 162, code: "ControlLeft", location: 1, repeat: false });
  expect(f.send).toHaveBeenCalledTimes(2);
  f.window.dispatchEvent(new Event("focus"));
  f.key("keydown"); f.key("keyup"); f.cleanup();
  f.native("keyDown", { keyCode: 162, code: "ControlLeft", location: 1, repeat: false });
  expect(f.send.mock.calls.map(([type]) => type)).toEqual(["keyDown", "keyUp", "keyDown", "keyUp"]);
});

test("UI tab arrows stay inside their own focused controls", () => {
  const navigate = uiFunction("navigateUiTabs");
  const tabs = [0, 1, 2].map(() => ({ focus: vi.fn(), click: vi.fn(), getAttribute: () => "tab" }));
  const event = { key: "ArrowRight", target: tabs[0], currentTarget: { querySelectorAll: () => tabs }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  navigate(event);
  expect(tabs[1].click).toHaveBeenCalledOnce();
  navigate({ ...event, key: "End" });
  expect(tabs[2].focus).toHaveBeenCalledOnce();
  navigate({ ...event, key: "ArrowLeft", target: tabs[0] });
  expect(tabs[2].click).toHaveBeenCalledTimes(2);
  navigate({ ...event, ctrlKey: true });
  navigate({ ...event, target: { getAttribute: () => null } });
  expect(tabs[1].click).toHaveBeenCalledOnce();
});

test("feedback classifies only known acknowledgements and never hides unknown errors", () => {
  const kind = uiFunction("sessionFeedbackKind");
  expect(kind("Texto copiado enviado.")).toBe("success");
  expect(kind("Serviço do Windows autorizado localmente.")).toBe("success");
  expect(kind("Solicitação Ctrl+Alt+Del enviada ao Windows.")).toBe("info");
  expect(kind("Pedido enviado. O proprietário precisa aprovar localmente no Windows.")).toBe("info");
  expect(kind("Reconectando... tentativa 2 de 5")).toBe("warning");
  expect(kind("O proprietário recusou a reinicialização.")).toBe("warning");
  expect(kind("CURSOR_SUPPRESSION_FAILED")).toBe("error");
  expect(kind("Falha: Texto copiado enviado.")).toBe("error");
  expect(kind("Ctrl+Alt+Del indisponível neste sistema.")).toBe("error");
  expect(kind("Novo erro não catalogado.")).toBe("error");
});

test("secure attention requires host authorization and the trusted renderer", () => {
  const fixture = secureAttentionHandler();
  expect(fixture.invoke()({ sender: {} }).ok).toBe(false);
  fixture.context.remoteControlActive = false;
  expect(fixture.invoke()({ sender: fixture.sender }).ok).toBe(false);
  expect(fixture.spawn).not.toHaveBeenCalled();
});

test("secure attention reports Windows policy refusal instead of fake success", async () => {
  const fixture = secureAttentionHandler();
  const result = fixture.invoke()({ sender: fixture.sender });
  fixture.child.stdout.emit("data", Buffer.from("SAS_POLICY_REQUIRED\n"));
  fixture.child.emit("close", 1);
  expect(await result).toMatchObject({ ok: false, error: expect.stringContaining("SoftwareSASGeneration") });
  expect(fixture.spawn).toHaveBeenCalledWith("native.exe", ["--send-sas"], expect.anything());
});

test("secure attention acknowledgement means requested, not visually confirmed", async () => {
  const fixture = secureAttentionHandler();
  const result = fixture.invoke()({ sender: fixture.sender });
  fixture.child.stdout.emit("data", Buffer.from("SAS_REQUESTED\n")); fixture.child.emit("close", 0);
  expect(await result).toMatchObject({ ok: true });
});

test("adaptive quality keeps healthy stages at 1080p and all requested rates within 30-120 FPS", async () => {
  const quality = await import("../apps/desktop/src/core/adaptive-quality");
  expect(quality.STAGE_LIMITS.slice(0, 3).every(limit => limit.height === 1080)).toBe(true);
  expect(quality.STAGE_LIMITS.map(limit => limit.height)).toEqual([1080, 1080, 1080, 900, 720]);
  expect(quality.STAGE_LIMITS.every(limit => limit.fps >= 30 && limit.fps <= 120)).toBe(true);
  expect(quality.nativeVideoBitrate(1080, 30, 4)).toBeGreaterThanOrEqual(6_000_000);
});

test("host input lock blocks only physical events and has automatic recovery", () => {
  const native = readFileSync("native/service/main.cpp", "utf8");
  const main = readFileSync("apps/desktop/electron/main.cjs", "utf8");
  expect(native).toContain("--input-lock-helper");
  expect(native).toContain("!(key.flags & LLKHF_INJECTED)");
  expect(native).toContain("!(mouse.flags & LLMHF_INJECTED)");
  expect(native).toContain("GetTickCount64() - inputLockHeartbeat.load() >= 3000");
  expect(main).toContain('ipcMain.handle("nodus:set-host-input-lock"');
  expect(main).toContain("clearInputLocks();");
});

test("resolution controls use native display defaults and confirm host application", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  expect(source).toContain('type: "resolution-applied"');
  expect(source).toContain("resolutionOptions(remoteDisplays, remoteResolution)");
  expect(source).toContain("resolutionForSource");
  expect(readFileSync("apps/desktop/src/core/storage.ts", "utf8")).toContain('preferredResolution: "native"');
});

test("workspace and remote video remain fluid across display sizes and DPI", () => {
  const css = readFileSync("apps/desktop/src/styles.css", "utf8");
  expect(css).not.toContain("grid-template-rows: 88px minmax(0, 1fr)");
  expect(css).toContain("grid-template-rows: auto minmax(0, 1fr)");
  expect(css).toContain(".viewer-session-v2 .remote-viewer-surface video { width:100%; height:100%; object-fit:contain;");
});
