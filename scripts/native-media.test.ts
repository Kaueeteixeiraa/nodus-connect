import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext, runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { captureBackendPlan, requireLegacyCaptureAllowed } from "../apps/desktop/src/core/remote-cursor";
import { DESKTOP_VIDEO_POLICY } from "../apps/desktop/src/core/adaptive-quality";

const source = ts.createSourceFile("main.cjs", readFileSync("apps/desktop/electron/main.cjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "startNativeMedia")!;
const policyDeclaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "getCaptureBackendPolicy")!;
const stopEntryDeclaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "stopNativeMediaEntry")!;
const stopOwnerDeclaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "stopNativeMediaForOwner")!;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn() }), kill: vi.fn(),
  });
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const log = vi.fn();
  const nativeMedia = new Map();
  const spawn = vi.fn(() => child);
  const start = runInNewContext(`${declaration.getText(source)}; startNativeMedia`, {
    path, process, Buffer, Date, setTimeout, clearTimeout,
    fs: { existsSync: () => true }, spawn,
    nativeMedia, nativeMediaExe: "native.exe", gstreamerRoot: "runtime",
    app: { getPath: () => "profile" }, appendLog: log,
  });
  const pending = start(sender, { sessionId: "3547ca91-60da-4920-8da5-beee681164fe", iceServers: [] });
  return { child, sender, pending, log, nativeMedia, spawn };
}

test("startup error preserves its cause without triggering a concurrent fallback", async () => {
  const { child, sender, pending, log } = fixture();
  child.stdout.emit("data", Buffer.from('E no element "mfh264enc"\n'));
  await expect(pending).rejects.toThrow('WGC_STAGE=PROCESS_STARTED: no element "mfh264enc"');
  child.emit("close", 1);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(sender.send).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('no element "mfh264enc"'));
});

test("close without an error record includes stderr after streams drain", async () => {
  const { child, pending } = fixture();
  child.stderr.emit("data", Buffer.from("plugin unavailable"));
  child.emit("exit", 1);
  child.emit("close", 1);
  await expect(pending).rejects.toThrow("EXIT_CODE=1 plugin unavailable");
});

test("errors after readiness still notify the running session, without exposing TURN credentials", async () => {
  const { child, sender, pending, log } = fixture();
  child.stdout.emit("data", Buffer.from("R STREAM_READY wgc no-cursor h264-hardware\n"));
  await expect(pending).resolves.toMatchObject({ backend: "wgc", cursorCapture: false });
  child.stdout.emit("data", Buffer.from("E rejected turn://secret:password@relay.test\n"));
  expect(sender.send).toHaveBeenCalledWith("nodus:native-media-signal", expect.objectContaining({ type: "error", message: "rejected turn://[redacted]@relay.test" }));
  expect(JSON.stringify(log.mock.calls)).not.toContain("password");
});

test("capture policy defaults to Chromium and allows controlled fallback", () => {
  const policy = runInNewContext(`${policyDeclaration.getText(source)}; getCaptureBackendPolicy()`, { process: { env: {} } });
  expect(policy).toEqual({ requestedBackend: "chromium", allowLegacyFallback: true });
});

test("experimental WGC and no-fallback policy require explicit selection", () => {
  const policy = runInNewContext(`${policyDeclaration.getText(source)}; getCaptureBackendPolicy()`, { process: { env: { NODUS_CAPTURE_BACKEND: "wgc", NODUS_CAPTURE_FALLBACK: "0" } } });
  expect(policy).toEqual({ requestedBackend: "wgc", allowLegacyFallback: false });
});

test("native process receives its setup handshake, but first frame alone is not ready", async () => {
  const { child, pending, spawn } = fixture();
  expect(spawn).toHaveBeenCalledOnce();
  expect(child.stdin.write).toHaveBeenCalledWith("S 0\n");
  const settled = vi.fn();
  pending.then(settled, settled);
  child.stdout.emit("data", Buffer.from("L FIRST_FRAME\n"));
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  child.stdout.emit("data", Buffer.from("L ENCODER_READY\nL STREAM_READY\nR STREAM_READY wgc no-cursor h264-hardware\n"));
  await expect(pending).resolves.toHaveProperty("backend", "wgc");
});

test("unexpected exit after ready emits exit and cleans the native session", async () => {
  const { child, pending, sender, nativeMedia } = fixture();
  child.stdout.emit("data", Buffer.from("R STREAM_READY wgc no-cursor h264-hardware\n"));
  await pending;
  child.emit("close", 1);
  expect(nativeMedia.size).toBe(0);
  expect(sender.send).toHaveBeenCalledWith("nodus:native-media-signal", expect.objectContaining({ type: "exit", code: 1 }));
});

test("idle startup timeout stops only the native child and removes its session", async () => {
  const { child, pending, nativeMedia, sender } = fixture();
  const rejected = expect(pending).rejects.toThrow("CAPTURE_STARTUP_IDLE_TIMEOUT");
  await vi.advanceTimersByTimeAsync(8000);
  await rejected;
  expect(child.kill).toHaveBeenCalledOnce();
  expect(nativeMedia.size).toBe(0);
  expect(sender.send).not.toHaveBeenCalled();
});

test("startup progress resets idle timeout but cannot extend the hard deadline", async () => {
  const { child, pending } = fixture();
  const rejected = expect(pending).rejects.toThrow("CAPTURE_STARTUP_DEADLINE");
  for (const name of ["HANDSHAKE", "PIPELINE_PARSE", "CAPTURE_START", "FIRST_FRAME"]) {
    await vi.advanceTimersByTimeAsync(7000);
    child.stdout.emit("data", Buffer.from(`L ${name}\n`));
  }
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
});

test("legacy premature ready is rejected", async () => {
  const { child, pending } = fixture();
  child.stdout.emit("data", Buffer.from("R wgc no-cursor h264-hardware\n"));
  await expect(pending).rejects.toThrow("INVALID_READY_HANDSHAKE");
});

test("stdin failure is reported rather than left as an unhandled process error", async () => {
  const { child, pending } = fixture();
  child.stdin.emit("error", new Error("broken pipe"));
  await expect(pending).rejects.toThrow("STDIN_ERROR broken pipe");
});

test("native processes owned by a terminated renderer are stopped immediately", () => {
  const first = { owner: 1, child: { nodusStopped: false, kill: vi.fn() } };
  const second = { owner: 2, child: { nodusStopped: false, kill: vi.fn() } };
  const nativeMedia = new Map([["first", first], ["second", second]]);
  const stopOwner = runInNewContext(`${stopEntryDeclaration.getText(source)}\n${stopOwnerDeclaration.getText(source)}; stopNativeMediaForOwner`, { nativeMedia, setTimeout });
  stopOwner(1, true);
  expect(nativeMedia.has("first")).toBe(false);
  expect(nativeMedia.has("second")).toBe(true);
  expect(first.child.nodusStopped).toBe(true);
  expect(first.child.kill).toHaveBeenCalledOnce();
  expect(second.child.kill).not.toHaveBeenCalled();
});

function hostFixture(native: boolean, fallback: boolean, ready = false, startupEvent?: "connected" | "error" | "exit") {
  const source = ts.createSourceFile("App.tsx", readFileSync("apps/desktop/src/App.tsx", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && ["acceptIncoming", "startHostSession", ...(startupEvent ? ["startHostNativeMedia"] : [])].includes(node.name?.text ?? "")) functions.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  const ref = () => ({ current: new Map() });
  const peer = { addTrack: vi.fn(() => ({})), getTransceivers: () => [], getConfiguration: () => ({ iceServers: [] }) };
  const lease = { stream: { getTracks: () => [{ kind: "video", readyState: "live" }] }, release: vi.fn() };
  const acquire = vi.fn(async () => lease);
  const nativeStart = vi.fn(async () => ready);
  const peers = ref(), policies = ref();
  const timers = ref(), nativeSessions = { current: new Set() };
  const unsubscribe = vi.fn(), stopNative = vi.fn(async () => {}), fallbackNative = vi.fn(async () => {});
  let signal: (event: any) => void;
  const runtime: { value?: any } = {};
  const cleanup = vi.fn(() => { peers.current.clear(); policies.current.clear(); });
  const context = createContext({
    Error, performance, captureBackendPlan, requireLegacyCaptureAllowed,
    captureCleanupRef: ref(), peersRef: peers, nativeFallbackAllowedRef: policies,
    requestedResolutionsRef: ref(), requestedFpsRef: ref(),
    requestedQualitiesRef: ref(), appliedVideoRef: ref(),
    nativeMediaListenersRef: ref(), nativeMediaStatsRef: ref(), nativeHostTimersRef: timers,
    nativeHostDisplaysRef: ref(), nativeHostSessionsRef: nativeSessions,
    captureSources: [{ id: "display", width: 1920, height: 1080 }], nativeVideoBitrate: () => 14000000,
    logMediaDiagnostic: vi.fn(), fallbackHostNativeMedia: fallbackNative, sendReliableSignal: async () => {},
    settings: { preferredResolution: "1920x1080", maxFps: 60, allowRemoteControl: true },
    identity: { deviceName: "host", nodusId: "123456789" },
    performanceDiagnosticRef: { current: null }, iceWarmupRef: { current: null }, DESKTOP_VIDEO_POLICY,
    createPeer: () => { cleanup(); peers.current.set("session", peer); return peer; },
    ensureSessionIceServers: async () => [],
    startHostNativeMedia: nativeStart, acquireHostCapture: acquire,
    allowedPermissions: () => ["screen:view"], acceptSessionRequest: async () => ({ id: "request", sessionId: "session", requesterNodusId: "987654321", requesterName: "viewer" }),
    recordAccess: vi.fn(), setIncomingRequests: vi.fn(), setFeedback: vi.fn(),
    fetchIceServers: async () => [], setServerIceServers: vi.fn(),
    upsertRuntime: (value: any) => { runtime.value = value; },
    updateRuntime: (_id: string, patch: any) => { runtime.value = { ...runtime.value, ...patch }; },
    setSessionResolutions: vi.fn(), tuneVideoSender: async () => {},
    logDiagnostic: vi.fn(), emptyMetrics: () => ({}), startSignalListening: vi.fn(),
    cleanupSession: cleanup, removeRuntime: () => { runtime.value = undefined; }, sendSignal: async () => {},
    window: { setTimeout, clearTimeout, nodusDesktop: {
      onNativeMediaSignal: (listener: typeof signal) => { signal = listener; return unsubscribe; },
      startNativeMedia: async () => { signal({ sessionId: "session", type: startupEvent, message: "early native failure" }); return { encoderImplementation: "test" }; },
      stopNativeMedia: stopNative,
      getNativeCaptureStatus: async () => ({ requestedBackend: native ? "wgc" : "chromium", allowLegacyFallback: fallback, nativeMediaAvailable: true, supported: true, cursorSuppressionSupported: true, d3d11Hardware: true, hardwareH264: true }),
      setRemoteControlActive: async () => {},
    } },
  });
  const code = ts.transpile(functions.join("\n"), { target: ts.ScriptTarget.ES2022 });
  runInContext(code, context);
  const accept = runInContext("acceptIncoming", context);
  return { accept: () => accept({ id: "request", requesterNodusId: "987654321" }), acquire, nativeStart, lease, runtime, peers, policies, timers, nativeSessions, stopNative, unsubscribe, fallbackNative };
}

test("baseline Chromium starts without activating WGC", async () => {
  const host = hostFixture(false, true);
  await expect(host.accept()).resolves.toBeNull();
  expect(host.nativeStart).not.toHaveBeenCalled();
  expect(host.acquire).toHaveBeenCalledOnce();
  expect(host.runtime.value.shareStream).toBe(host.lease.stream);
});

test("WGC startup failure falls back once and leaves a usable host session", async () => {
  const host = hostFixture(true, true);
  await expect(host.accept()).resolves.toBeNull();
  expect(host.acquire).toHaveBeenCalledOnce();
  expect(host.peers.current.size).toBe(1);
  expect(host.policies.current.get("session")).toBe(true);
  expect(host.runtime.value.error).toContain("Captura legada");
});

test("prohibited fallback does not capture Chromium and cleans the failed session", async () => {
  const host = hostFixture(true, false);
  await expect(host.accept()).resolves.toContain("FALLBACK_PROHIBITED");
  expect(host.acquire).not.toHaveBeenCalled();
  expect(host.peers.current.size).toBe(0);
  expect(host.policies.current.size).toBe(0);
  expect(host.runtime.value).toBeUndefined();
});

test("successful WGC startup does not acquire legacy capture", async () => {
  const host = hostFixture(true, true, true);
  await expect(host.accept()).resolves.toBeNull();
  expect(host.acquire).not.toHaveBeenCalled();
  expect(host.runtime.value.error).toBe("");
});

test("native connected before IPC ready does not schedule a false connection timeout", async () => {
  const host = hostFixture(true, true, true, "connected");
  await expect(host.accept()).resolves.toBeNull();
  expect(host.acquire).not.toHaveBeenCalled();
  expect(host.nativeSessions.current.has("session")).toBe(true);
  expect(host.timers.current.size).toBe(0);
  await vi.advanceTimersByTimeAsync(20000);
  expect(host.fallbackNative).not.toHaveBeenCalled();
});

test.each(["error", "exit"] as const)("native %s before IPC ready falls back once rather than keeping a dead native session", async (event) => {
  const host = hostFixture(true, true, true, event);
  await expect(host.accept()).resolves.toBeNull();
  expect(host.acquire).toHaveBeenCalledOnce();
  expect(host.stopNative).toHaveBeenCalledOnce();
  expect(host.unsubscribe).toHaveBeenCalledOnce();
  expect(host.nativeSessions.current.size).toBe(0);
  expect(host.timers.current.size).toBe(0);
  expect(host.fallbackNative).not.toHaveBeenCalled();
  expect(host.runtime.value.shareStream).toBe(host.lease.stream);
});
