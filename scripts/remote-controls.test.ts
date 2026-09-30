import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, expect, test, vi } from "vitest";
import { translateText } from "../apps/desktop/src/core/localization";

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

test("password recovery is an explicit notice, not a fake action", () => {
  expect(readFileSync("apps/desktop/src/App.tsx", "utf8")).toContain('<span className="forgot-password" role="note" title="Recuperação de senha ainda não disponível.">Recuperação indisponível</span>');
  for (const language of ["en-US", "ru-RU", "ja-JP"] as const) expect(translateText("Recuperação de senha ainda não disponível.", language)).not.toBe("Recuperação de senha ainda não disponível.");
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

function uiFunction(name: string, context = {}) {
  const source = ts.createSourceFile("App.tsx", readFileSync("apps/desktop/src/App.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!node) throw new Error(`UI function missing: ${name}`);
  const code = ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return runInNewContext(`${code};${name}`, context);
}

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
