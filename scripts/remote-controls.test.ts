import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext, runInNewContext } from "node:vm";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Activity, ArrowRight, Gauge, Monitor, UserRound } from "lucide-react";
import { afterEach, expect, test, vi } from "vitest";
import { translateText } from "../apps/desktop/src/core/localization";
import { DESKTOP_VIDEO_POLICY } from "../apps/desktop/src/core/adaptive-quality";
import { LicenseError, LICENSE_MESSAGES } from "../packages/licensing/src/index";
import { mapVideoPointer } from "../apps/desktop/src/core/remote-cursor";

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

test("release notes describe the current main-window session in every language", () => {
  const source = readFileSync("apps/desktop/src/App.tsx", "utf8");
  expect(source).not.toContain('"Acesso remoto aberto em janela própria."');
  for (const language of ["en-US", "ru-RU", "ja-JP"] as const) {
    expect(translateText("A sessão atual utiliza a janela principal do Nodus.", language)).not.toBe("A sessão atual utiliza a janela principal do Nodus.");
  }
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
  return runInNewContext(`${code};${name}`, context);
}

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
  const update = uiFunction("handleRequestUpdate", { outgoingRequestRef, startViewerSession, recordAccess, setOutgoingRequest, setFeedback: vi.fn() });
  update(request); update(request); update({ ...request, status: "pending" });
  expect(startViewerSession).toHaveBeenCalledExactlyOnceWith(request); expect(recordAccess).toHaveBeenCalledOnce(); expect(setOutgoingRequest).toHaveBeenCalledExactlyOnceWith(null);
  expect(outgoingRequestRef.current).toBeNull();
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
  runInNewContext(listener.getText(source), { app: { on }, mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }, showMainWindow: show, getDiagnosticPresetArgument: () => null });
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
  expect(lifecycle.has("session")).toBe(code === "SERVER_UNAVAILABLE");
  vi.clearAllTimers();
});

test("remote input IPC is restricted to the main app and renderer cleanup closes the helper pipe", () => {
  const sender = { getURL: () => "app" }, trusted = uiFunction("isMainAppSender", { mainWindow: { webContents: sender }, isAllowedAppUrl: (url: string) => url === "app" }, "apps/desktop/electron/main.cjs");
  expect(trusted({ sender })).toBe(true); expect(trusted({ sender: { getURL: () => "app" } })).toBe(false);
  sender.getURL = () => "https://external.test"; expect(trusted({ sender })).toBe(false);
  const end = vi.fn(), locks = vi.fn();
  const deactivate = uiFunction("setRemoteControlActive", { remoteControlActive: true, clearTimeout, clearInputLocks: locks, inputHelper: { stdin: { end, writable: true } }, powerSaveBlockerId: -1 }, "apps/desktop/electron/main.cjs");
  deactivate(false); expect(end).toHaveBeenCalledOnce(); expect(locks).toHaveBeenCalledOnce();
  const native = readFileSync("native/service/main.cpp", "utf8");
  expect(native).toContain("if (pressedButtons[button]) sendMouseButton(button, false)");
  expect(native).toContain("extendedKeys[key] ? KEYEVENTF_EXTENDEDKEY : 0");
});

test("admin loads only the active view and reports timeouts in Portuguese", async () => {
  const api = vi.fn(async (path: string) => path === "/admin/dashboard" ? { devices: 2 } : []);
  const setDashboard = vi.fn(), setFeedback = vi.fn(), setVerified = vi.fn();
  const reload = uiFunction("reload", { view: "dashboard", auth: { currentUser: { uid: "owner" } }, api, setDashboard, setFeedback, setVerified, setOrganizations: vi.fn(), setAccessRequests: vi.fn(), setDevices: vi.fn() }, "apps/admin/src/App.tsx");
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
  const send = uiFunction("sendRemoteInputToSession", { pointerChannelsRef, controlChannelsRef: { current: new Map([["s", control]]) }, inputDiagnostic: () => undefined, encodePointerMessage: () => new Uint8Array(9) });
  const input = { type: "mouseMove", x: 0.4, y: 0.5 };
  send("s", input); expect(control.send).toHaveBeenCalledExactlyOnceWith(JSON.stringify(input));
  control.bufferedAmount = 1000; send("s", input); expect(control.send).toHaveBeenCalledTimes(1);
  const pointer = { readyState: "open", bufferedAmount: 0, send: vi.fn() }; pointerChannelsRef.current.set("s", pointer);
  send("s", input); expect(pointer.send).toHaveBeenCalledOnce(); expect(control.send).toHaveBeenCalledTimes(1);
});

test("input rate limiting never strands Ctrl or a held mouse button", () => {
  const apply = vi.fn(), channel: any = {}, updateRuntime = vi.fn();
  const attach = uiFunction("attachHostControl", { controlChannelsRef: { current: new Map() }, hostInputRateRef: { current: new Map([["s", { at: Date.now(), count: 500 }]]) },
    sessionsRef: { current: [{ session: { sessionId: "s", permissions: ["keyboard:control", "mouse:control"] } }] }, settings: { allowRemoteControl: true }, window: { nodusDesktop: { applyRemoteInput: apply } }, updateRuntime });
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

test("adaptive quality preserves 1080p and never requests less than 30 FPS", async () => {
  const quality = await import("../apps/desktop/src/core/adaptive-quality");
  expect(quality.STAGE_LIMITS.every((limit) => limit.height === 1080 && limit.fps >= 30 && limit.fps <= 120)).toBe(true);
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
