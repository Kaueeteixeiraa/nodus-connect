import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createContext, runInContext, runInNewContext } from "node:vm";
import ts from "typescript";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import support from "../apps/desktop/electron/quick-support.cjs";
import type { SupportProfile } from "../packages/common/src/quick-support";
import { QuickSupportView, supportSettings } from "../apps/desktop/src/QuickSupport";
import type { LocalSettings } from "../apps/desktop/src/core/storage";
import { LicenseError, LICENSE_MESSAGES } from "../packages/licensing/src/index";
vi.mock("../apps/desktop/src/core/licensing", () => ({ checkLicense: vi.fn(), createSupportProfile: vi.fn(), licenseFeedback: vi.fn() }));

const keys = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => {
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("nodus-support-test-")) throw new Error("UNSAFE_TEST_CLEANUP");
  fs.rmSync(resolved, { recursive: true, force: true });
}));
function directory() { const value = fs.mkdtempSync(path.join(os.tmpdir(), "nodus-support-test-")); directories.push(value); return value; }
async function profile(): Promise<SupportProfile> {
  return { version: 1, id: "profile-example", organizationId: "example", licenseId: "business-example", name: "Example Support", company: "Example", message: "Atendimento autorizado", logo: "", permissions: ["screen:view", "mouse:control"], confirmation: true, createdAt: Date.now(), passwordVerifier: await support.passwordVerifier("Example-support-2026!") };
}
test("salted verifier validates passwords but never embeds plaintext or a weak SHA256 password", async () => {
  const first = await profile(), second = await profile();
  expect(first.passwordVerifier.salt).not.toBe(second.passwordVerifier.salt);
  await expect(support.verifyPassword("Example-support-2026!", first.passwordVerifier)).resolves.toBe(true);
  await expect(support.verifyPassword("wrong", first.passwordVerifier)).resolves.toBe(false);
  const short = await support.passwordVerifier("abc");
  await expect(support.verifyPassword("abc", short)).resolves.toBe(true);
  await expect(support.verifyPassword("abd", short)).resolves.toBe(false);
  for (const password of ["", "ab", "x".repeat(129)]) await expect(support.passwordVerifier(password)).rejects.toThrow();
  expect(JSON.stringify(first)).not.toContain("Example-support-2026!");
}, 15000);
test("generator validates locally, accepts three characters and retains inputs after failure or cancellation", async () => {
  const source = ts.createSourceFile("QuickSupport.tsx", fs.readFileSync("apps/desktop/src/QuickSupport.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "SupportGenerator") as ts.FunctionDeclaration;
  const generate = component.body!.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "generate")!.getText(source);
  const code = ts.transpileModule(generate, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const draft = { name: "Support", company: "Example", password: "abc", confirmation: true };
  const checkLicense = vi.fn(async () => ({ allowed: true, plan: "business" })), createSupportProfile = vi.fn(async () => ({ token: "signed", template: null }));
  const save = vi.fn(), patch = vi.fn(), setConfirm = vi.fn(), setStatus = vi.fn(), packageFile = vi.fn(async () => ({ path: "Support.exe", canceled: false }));
  const context = { STORE: "nodus.support-profile.v1", busy: false, draft, confirm: "abc", identity: {}, savedProfile: () => ({}), checkLicense, createSupportProfile, setBusy: vi.fn(), setStatus, patch, setConfirm, localStorage: { setItem: save }, window: { nodusDesktop: { getAppInfo: async () => ({ version: "1.1.8" }), generateSupportPackage: packageFile } }, licenseFeedback: () => "Unavailable" };
  const run = (changes: object = {}) => runInNewContext(`${code}; generate`, { ...context, ...changes })({ preventDefault() {} });
  await run({ draft: { ...draft, password: "ab" } }); expect(checkLicense).not.toHaveBeenCalled(); expect(setStatus).toHaveBeenLastCalledWith("Defina uma senha de pelo menos 3 caracteres.");
  await run({ confirm: "abd" }); expect(checkLicense).not.toHaveBeenCalled(); expect(setStatus).toHaveBeenLastCalledWith("As senhas nao coincidem.");
  packageFile.mockRejectedValueOnce(new Error("Download failed")); await run(); expect(save).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled(); expect(setConfirm).not.toHaveBeenCalled();
  packageFile.mockResolvedValueOnce({ canceled: true, path: "" }); await run(); expect(save).not.toHaveBeenCalled(); expect(patch).not.toHaveBeenCalled();
  await run(); expect(createSupportProfile).toHaveBeenLastCalledWith(context.identity, draft); expect(save).toHaveBeenCalledOnce(); expect(patch).toHaveBeenCalledOnce(); expect(setConfirm).toHaveBeenLastCalledWith("");
  expect(save.mock.calls[0][1]).not.toContain("abc");
  const { password, ...safe } = draft;
  createSupportProfile.mockClear();
  await run({ draft: { ...draft, password: "" }, savedProfile: () => ({ draft: safe, token: "old", version: "1.1.7" }) });
  expect(setStatus).toHaveBeenLastCalledWith("Defina uma senha de pelo menos 3 caracteres.");
  expect(createSupportProfile).not.toHaveBeenCalled();
  await run({ draft: { ...draft, password: "" }, savedProfile: () => ({ draft: safe, token: "signed", version: "1.1.8" }) });
  expect(packageFile).toHaveBeenLastCalledWith({ token: "signed", template: null });
  expect(createSupportProfile).not.toHaveBeenCalled();
});
test("an unpublished API route reports service unavailable, not invalid form data", async () => {
  const source = ts.createSourceFile("licensing.ts", fs.readFileSync("apps/desktop/src/core/licensing.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const request = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "request")!.getText(source);
  const code = ts.transpileModule(request, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const status of [404, 409]) {
    const run = runInNewContext(`${code}; request`, { base: "https://example.test", URL, AbortController, setTimeout, clearTimeout, LicenseError, LICENSE_MESSAGES, getDeviceAuthToken: async () => "test", fetch: async () => ({ ok: false, status, json: async () => ({ code: "INVALID_INPUT" }) }) });
    await expect(run("/license/support/profiles", {})).rejects.toMatchObject({ code: status === 404 ? "SERVER_UNAVAILABLE" : "INVALID_INPUT" });
  }
});
test("first-run presence, request listeners and licensing share one restored device login", async () => {
  const source = ts.createSourceFile("firebase.ts", fs.readFileSync("apps/desktop/src/core/firebase.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ensureDeviceUid")!.getText(source);
  const auth: any = { currentUser: null, authStateReady: vi.fn(async () => undefined) };
  const signInAnonymously = vi.fn(async () => {
    const uid = `device-${signInAnonymously.mock.calls.length}`;
    await Promise.resolve(); auth.currentUser = { uid, getIdToken: vi.fn(async () => "test") };
    return { user: auth.currentUser };
  });
  const context = createContext({ deviceUidPromise: null, firebaseConfigured: () => true, modules: async () => ({ auth: { signInAnonymously } }), deviceAuth: async () => auth });
  const ensure = runInContext(`${ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; ensureDeviceUid`, context);
  const ids = await Promise.all([ensure(), ensure(), ensure(), ensure()]);
  expect(new Set(ids).size).toBe(1); expect(signInAnonymously).toHaveBeenCalledOnce();
  await ensure(); expect(signInAnonymously).toHaveBeenCalledOnce();
  auth.currentUser = null; signInAnonymously.mockRejectedValueOnce(new Error("offline"));
  await expect(ensure()).rejects.toThrow("offline"); await ensure(); expect(signInAnonymously).toHaveBeenCalledTimes(3);
  auth.currentUser = null;
  auth.authStateReady.mockImplementationOnce(async () => { auth.currentUser = { uid: "restored", getIdToken: async () => "restored-token" }; });
  await expect(ensure()).resolves.toBe("restored"); expect(signInAnonymously).toHaveBeenCalledTimes(3);
});
test("signature rejects edited permissions, company, confirmation, verifier and unrelated keys", async () => {
  const original = await profile(), token = support.signProfile(original, keys.privateKey);
  expect(support.verifyProfile(token, keys.publicKey)).toEqual(original);
  for (const patch of [{ company: "Other" }, { permissions: ["screen:view", "admin:actions"] }, { confirmation: false }, { passwordVerifier: { ...original.passwordVerifier, hash: "0".repeat(64) } }]) {
    const payload = Buffer.from(JSON.stringify({ purpose: "nodus-quicksupport", profile: { ...original, ...patch } })).toString("base64url");
    expect(() => support.verifyProfile(`${payload}.${token.split(".")[1]}`, keys.publicKey)).toThrow();
  }
  expect(() => support.verifyProfile(token + ".extra", keys.publicKey)).toThrow();
  expect(() => support.verifyProfile(token, generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString())).toThrow();
  expect(() => support.validateProfile({ ...original, permissions: ["screen:view", "admin:actions"] })).toThrow();
});
test("single-file packaging preserves the executable and rejects absent, malformed or tampered profiles", async () => {
  const root = directory(), source = path.join(root, "template.exe"), output = path.join(root, "Example.exe");
  fs.writeFileSync(source, Buffer.from("MZtest executable"));
  const original = await profile(), token = support.signProfile(original, keys.privateKey);
  support.appendProfile(source, output, token, keys.publicKey);
  expect(fs.readFileSync(output).subarray(0, fs.statSync(source).size)).toEqual(fs.readFileSync(source));
  expect(support.readProfile(output, keys.publicKey)).toEqual(original);
  expect(() => support.readProfile(source, keys.publicKey)).toThrow("SUPPORT_PROFILE_MISSING");
  expect(() => support.appendProfile(source, output, token, keys.publicKey)).toThrow();
  const bad = Buffer.from(fs.readFileSync(output)); bad[fs.statSync(source).size] ^= 1; fs.writeFileSync(output, bad);
  expect(() => support.readProfile(output, keys.publicKey)).toThrow();
  bad.writeUInt32LE(0xffffffff, bad.length - Buffer.byteLength("NODUS-QUICKSUPPORT-V1") - 4); fs.writeFileSync(output, bad);
  expect(() => support.readProfile(output, keys.publicKey)).toThrow("INVALID_SUPPORT_PROFILE");
});
test("the existing native save flow generates, verifies and cancels without another runtime", async () => {
  const root = directory(), output = path.join(root, "Customer.exe"), template = path.join(root, "outputs/quick-support/Nodus-QuickSupport-1.1.7.exe");
  fs.mkdirSync(path.dirname(template), { recursive: true }); fs.writeFileSync(template, "MZtest");
  const source = ts.createSourceFile("main.cjs", fs.readFileSync("apps/desktop/electron/main.cjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "generateSupportPackage")!.getText(source);
  const dialog = { showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: output })) };
  const generate = runInNewContext(`${code}; generateSupportPackage`, { fs, path, crypto: { randomUUID: () => "test-temporary" }, supportPackages: support, supportKey: keys.publicKey, app: { isPackaged: false, getVersion: () => "1.1.7" }, __dirname: path.join(root, "apps/desktop/electron"), dialog, mainWindow: {} });
  const original = await profile(), token = support.signProfile(original, keys.privateKey);
  await expect(generate({ token })).resolves.toEqual({ path: output });
  expect(support.readProfile(output, keys.publicKey)).toEqual(original);
  expect(fs.existsSync(output + ".test-temporary.tmp")).toBe(false);
  dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: "" });
  await expect(generate({ token })).resolves.toEqual({ canceled: true });
  await expect(generate({ token: token + "bad" })).rejects.toThrow();
  expect(dialog.showSaveDialog).toHaveBeenCalledTimes(2);
});
test("installed generator uses only the signed matching template and rejects corrupt downloads", async () => {
  const root = directory(), output = path.join(root, "Customer.exe"), template = Buffer.from("MZportable fixture");
  const sha256 = createHash("sha256").update(template).digest("hex");
  const original = { ...await profile(), template: { version: "1.1.14", sha256 } };
  const token = support.signProfile(original, keys.privateKey);
  const source = ts.createSourceFile("main.cjs", fs.readFileSync("apps/desktop/electron/main.cjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = source.statements.filter(node => ts.isFunctionDeclaration(node) && ["hashFile", "downloadVerifiedFile", "generateSupportPackage"].includes(node.name?.text || "")).map(node => node.getText(source)).join("\n");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(template));
  const generate = runInNewContext(`${code}; generateSupportPackage`, { fs, path, crypto: { createHash, randomUUID }, Readable, fetch, AbortController, setTimeout, clearTimeout, require: createRequire(import.meta.url), supportPackages: support, supportKey: keys.publicKey, app: { isPackaged: true, getVersion: () => "1.1.14", getPath: () => root }, __dirname: root, dialog: { showSaveDialog: async () => ({ canceled: false, filePath: output }) }, mainWindow: {} });
  await expect(generate({ token })).resolves.toEqual({ path: output });
  expect(fetch.mock.calls[0][0]).toBe("https://github.com/Kaueeteixeiraa/nodus-connect/releases/download/v1.1.14/Nodus-QuickSupport-1.1.14.exe");
  expect(support.readProfile(output, keys.publicKey)).toEqual(original);
  fs.rmSync(output);
  await generate({ token }); expect(fetch).toHaveBeenCalledOnce();
  fs.rmSync(output);
  fs.writeFileSync(path.join(root, "support-cache", `${sha256}.exe`), "corrupted cache");
  fetch.mockResolvedValueOnce(new Response("corrupted download"));
  await expect(generate({ token })).rejects.toThrow("DOWNLOAD_INTEGRITY_FAILED");
  expect(fs.existsSync(output)).toBe(false);
  expect(fs.readdirSync(path.join(root, "support-cache")).some(name => name.endsWith(".tmp"))).toBe(false);
  const oldToken = support.signProfile({ ...original, template: { version: "1.1.13", sha256 } }, keys.privateKey);
  await expect(generate({ token: oldToken })).rejects.toThrow("O template portatil desta versao ainda nao foi publicado.");
  expect(fetch).toHaveBeenCalledTimes(2);
});
test("copying only a branded executable creates a distinct identity; renaming and restarting preserve it", async () => {
  const root = directory(), config = await profile();
  const { createDeviceIdentityStore } = createRequire(import.meta.url)("../apps/desktop/electron/device-identity.cjs");
  const firstPath = path.join(root, "pc-one", config.id), secondPath = path.join(root, "pc-two", config.id);
  const first = createDeviceIdentityStore(firstPath).loadOrCreate(null), second = createDeviceIdentityStore(secondPath).loadOrCreate(null);
  expect(first.nodusId).not.toBe(second.nodusId);
  expect(first.deviceClaim).not.toBe(second.deviceClaim);
  expect(createDeviceIdentityStore(firstPath).loadOrCreate(null)).toEqual(first);
  const source = ts.createSourceFile("main.tsx", fs.readFileSync("apps/desktop/src/main.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let boot: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => { if (ts.isIfStatement(node) && node.expression.getText(source) === "supportProfile") boot = node; else ts.forEachChild(node, visit); };
  visit(source);
  const code = ts.transpileModule(boot!.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const initialize = (identity: unknown) => runInNewContext(`${code}; identity`, { identity, supportProfile: config });
  expect(initialize(first).deviceName).toBe(config.name);
  const renamed = createDeviceIdentityStore(firstPath).updateMutable({ ...first, deviceName: "Recepcao", deviceNameConfirmed: true });
  expect(renamed.nodusId).toBe(first.nodusId); expect(renamed.deviceClaim).toBe(first.deviceClaim);
  expect(initialize(createDeviceIdentityStore(firstPath).loadOrCreate(null))).toMatchObject({ deviceName: "Recepcao", supportProfileId: config.id });
});
test("receiver settings and active view expose no installer, login, history or license administration", async () => {
  const config = await profile(), settings = { startWithWindows: true, startMinimized: true, minimizeToTray: true, shareAudio: true, allowClipboard: true, allowFileTransfer: true, accessPasswordHash: "legacy", coordinationUrl: "unchanged", maxFps: 60 } as LocalSettings;
  expect(supportSettings(settings, config)).toMatchObject({ startWithWindows: false, startMinimized: false, minimizeToTray: false, accessPasswordHash: "", allowRemoteControl: true, shareAudio: false, allowClipboard: false, allowFileTransfer: false, coordinationUrl: "unchanged", maxFps: 60 });
  const props = { profile: config, nodusId: "123 456 789", deviceName: "Recepcao", onRename: vi.fn(), ready: true, sessions: [{ id: "s", name: "Technician", status: "Conectado", connected: true }], error: "", onEnd: vi.fn(), onQuit: vi.fn() };
  const markup = renderToStaticMarkup(React.createElement(QuickSupportView, props));
  expect(markup).toContain("Suporte em andamento"); expect(markup).toContain("Encerrar suporte"); expect(markup).toContain("123 456 789");
  expect(markup).not.toMatch(/Entrar com|Google|historico|Configuracoes|Admin|Gerar QuickSupport/);
  expect(markup).toContain("Recepcao"); expect(markup).toContain('aria-label="Alterar nome"');
  const pending = renderToStaticMarkup(React.createElement(QuickSupportView, { ...props, sessions: [{ id: "s", name: "Technician", status: "Compartilhando sua tela", connected: false, error: "Falha temporaria na conexao." }] }));
  expect(pending).not.toContain("Suporte em andamento"); expect(pending).toContain("Estabelecendo conexao"); expect(pending).toContain('role="alert"');
  const source = fs.readFileSync("apps/desktop/electron/main.cjs", "utf8");
  expect(source).toContain('if (!portableSupport) createTray()');
  expect(source).toContain('if (portableSupport) { minimizeToTray = false; return; }');
  expect(source).toContain('if (portableSupport || !isMainAppSender(event))');
  expect(source).toContain('if (supportBootError)');
  expect(source).toContain('const startMinimized = !portableSupport');
});
test("portable packaging inherits the existing file exclusions and native resources, not the whole repository", () => {
  const require = createRequire(import.meta.url), base = require("../package.json").build, portable = require("../quick-support-builder.cjs");
  expect(portable.files).toEqual([...base.files, "!dist/desktop/assets/theme-*.png", "!dist/desktop/assets/nodus-nightscape-*.png", "!dist/desktop/assets/nodus-future-grid-*.png", "!dist/desktop/assets/Standby3D-*.js"]);
  expect(portable.compression).toBe("maximum");
  expect(portable.extraResources).toEqual(base.extraResources);
  expect(portable.afterPack).toBe(base.afterPack);
  expect(portable.portable.requestExecutionLevel).toBe("user");
  expect(portable.win.target).toEqual([{ target: "portable", arch: ["x64"] }]);
});
test("closing the portable uses the existing app cleanup and only its trusted main frame can quit", () => {
  const source = ts.createSourceFile("main.cjs", fs.readFileSync("apps/desktop/electron/main.cjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const setup = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "setupIpc") as ts.FunctionDeclaration;
  const handler = setup.body!.statements.find(node => node.getText(source).includes('"nodus:quit"'))!.getText(source);
  const handle = vi.fn(), quit = vi.fn();
  runInNewContext(handler, { ipcMain: { handle }, quitApp: quit, isMainAppSender: (sender: string) => sender === "trusted" });
  handle.mock.calls[0][1]("foreign"); expect(quit).not.toHaveBeenCalled();
  handle.mock.calls[0][1]("trusted"); expect(quit).toHaveBeenCalledOnce();
  const listener = source.statements.find(node => ts.isExpressionStatement(node) && node.getText(source).startsWith('app.on("before-quit"'))!.getText(source);
  const on = vi.fn(), stop = vi.fn(), cursor = vi.fn(), keyboard = vi.fn(), locks = vi.fn(), control = vi.fn();
  runInNewContext(listener, { app: { on }, isQuitting: false, stopNativeMediaForOwner: stop, hostCursorVisibility: { dispose: cursor }, remoteWindowsKeys: { dispose: keyboard }, clearInputLocks: locks, setRemoteControlActive: control });
  on.mock.calls[0][1](); expect(stop).toHaveBeenCalledExactlyOnceWith(null, true);
  expect(cursor).toHaveBeenCalledOnce(); expect(keyboard).toHaveBeenCalledOnce(); expect(locks).toHaveBeenCalledOnce(); expect(control).toHaveBeenCalledExactlyOnceWith(false);
});
