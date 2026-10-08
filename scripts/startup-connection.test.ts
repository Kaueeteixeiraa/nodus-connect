import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, expect, test, vi } from "vitest";
import { LicenseError } from "../packages/licensing/src/index";
import { normalizeNodusId } from "../packages/common/src/nodusId";
import { RelayLicenseGate } from "../services/coordination/src/license-gate";

function functions(file: string, names: string[], context: object) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const code = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name!.text)).map(node => node.getText(source)).join("\n");
  const scope = createContext(context);
  runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/export /g, ""), scope);
  return Object.fromEntries(names.map(name => [name, runInContext(name, scope)]));
}
afterEach(() => vi.useRealTimers());

test.each(["ok", "cancel", "incomplete", "hash", "exit", "spawn"])("deferred payload validates extraction and never accepts partial data: %s", async mode => {
  const data = Buffer.from("archive");
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const spawn = vi.fn(() => { queueMicrotask(() => mode === "spawn" ? child.emit("error", new Error("spawn failed")) : child.emit("close", mode === "exit" || mode === "cancel" ? 1 : 0)); return child; });
  const { extractPayload } = functions("apps/installer/main.cjs", ["extractPayload"], {
    assertSafeAuxiliaryDir: vi.fn(), payloadWrapper: "C:\\Downloads\\setup.exe", path: path.win32, spawn,
    setInterval, clearInterval, setTimeout, clearTimeout, cancelRequested: mode === "cancel",
    payloadMetadata: { bytes: data.length, fileCount: mode === "incomplete" ? 2 : 1, appAsarSha256: mode === "hash" ? "0".repeat(64) : createHash("sha256").update(data).digest("hex") },
    fs: { existsSync: () => true, statSync: () => ({ size: data.length }), createReadStream: async function* () { yield data; } },
    listFiles: () => ["archive"], crypto: { createHash }, throwIfCancelled: () => {},
  });
  const pending = extractPayload("C:\\Programs\\Nodus Connect.installing", vi.fn());
  if (mode === "ok") await expect(pending).resolves.toBeUndefined();
  else await expect(pending).rejects.toThrow();
  expect(spawn).toHaveBeenCalledWith("C:\\Downloads\\setup.exe", ["/EXTRACT=C:\\Programs\\Nodus Connect.installing"], { windowsHide: true, stdio: "ignore" });
});

test("late IPC from a destroyed window cannot touch webContents", () => {
  const getURL = vi.fn(() => "file:///app.html");
  const { isMainAppSender } = functions("apps/desktop/electron/main.cjs", ["isMainAppSender"], {
    mainWindow: { isDestroyed: () => true, get webContents() { throw new Error("Destroyed"); } }, isAllowedAppUrl: () => true,
  });
  expect(isMainAppSender({ sender: { isDestroyed: () => false, getURL } })).toBe(false);
  expect(getURL).not.toHaveBeenCalled();
});

test("a trickle ICE burst shares authorization, while errors are never cached", async () => {
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("policy") ? { enforced: true } : { allowed: true, enforced: true } })) as any;
  const gate = new RelayLicenseGate("https://license.test", fetcher);
  const body = { kind: "signal" as const, sessionId: "session", from: "123456789", to: "987654321" };
  await Promise.all(Array.from({ length: 20 }, () => gate.authorize("token", body)));
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockResolvedValueOnce({ ok: false, json: async () => ({ code: "FORBIDDEN" }) });
  await expect(gate.authorize("other-token", body)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await gate.authorize("other-token", body); expect(fetcher).toHaveBeenCalledTimes(4);
});

test("native discovery shares one nonblocking probe and retains all capture capabilities", async () => {
  const execFile = vi.fn();
  const { getNativeCaptureStatus } = functions("apps/desktop/electron/main.cjs", ["getNativeCaptureStatus", "getCaptureBackendPolicy"], {
    nativeCaptureStatusPromise: undefined, nativeCaptureStatusExpires: 0, Date, performance, path,
    fs: { existsSync: () => true }, execFile, appendLog: vi.fn(), process: { env: { NODUS_WGC_EXPERIMENTAL: "1" } },
    nativeCaptureProbe: "probe", nativeMediaExe: "media", gstreamerRoot: "gst",
  });
  const first = getNativeCaptureStatus(), second = getNativeCaptureStatus();
  expect(first).toBe(second); expect(execFile).toHaveBeenCalledOnce();
  expect(execFile.mock.calls[0][2]).toMatchObject({ timeout: 5000, windowsHide: true, maxBuffer: 65536 });
  execFile.mock.calls[0][3](null, JSON.stringify({ windowsGraphicsCapture: true, cursorSuppressionSupported: true, d3d11Hardware: true, hardwareH264: true, hardwareH264Encoders: 2, adapter: "GPU" }));
  await expect(first).resolves.toMatchObject({ supported: true, nativeMediaAvailable: true, cursorSuppressionSupported: true, hardwareH264Encoders: 2 });
  await getNativeCaptureStatus(); expect(execFile).toHaveBeenCalledOnce();
});

test("probe errors preserve the fallback and can recover after a bounded negative cache", async () => {
  vi.useFakeTimers();
  const execFile = vi.fn((_exe, _args, _options, callback) => callback(null, "invalid JSON"));
  const { getNativeCaptureStatus } = functions("apps/desktop/electron/main.cjs", ["getNativeCaptureStatus", "getCaptureBackendPolicy"], {
    nativeCaptureStatusPromise: undefined, nativeCaptureStatusExpires: 0, Date, performance, path,
    fs: { existsSync: () => true }, execFile, appendLog: vi.fn(), process: { env: {} }, nativeCaptureProbe: "probe",
  });
  await expect(getNativeCaptureStatus()).resolves.toMatchObject({ available: false, allowLegacyFallback: true });
  await getNativeCaptureStatus(); expect(execFile).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30001);
  await getNativeCaptureStatus(); expect(execFile).toHaveBeenCalledTimes(2);
});

test("online reserve uses one authoritative operation and rejects a mismatched reservation", async () => {
  const reserved = new Set();
  const request = vi.fn(async () => ({ sessionId: "session" }));
  const { reserveLicense } = functions("apps/desktop/src/core/licensing.ts", ["reserveLicense"], {
    licenseConfigured: () => true, prepared: new Map(), reserved, crypto: { randomUUID: () => "session" }, request,
    device: async () => ({ deviceId: "device", deviceToken: "token" }), LicenseError,
  });
  await expect(reserveLicense({ deviceId: "device" }, "123456789", "profile", "abc")).resolves.toBe("session");
  expect(request).toHaveBeenCalledExactlyOnceWith("/license/sessions/reserve", { deviceId: "device", deviceToken: "token", sessionId: "session", targetNodusId: "123456789", supportProfileId: "profile", supportPassword: "abc" });
  request.mockResolvedValueOnce({ sessionId: "wrong" });
  await expect(reserveLicense({ deviceId: "device" }, "123456789")).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
  request.mockRejectedValueOnce(new LicenseError("TRIAL_LIMIT_REACHED"));
  await expect(reserveLicense({ deviceId: "device" }, "123456789")).rejects.toMatchObject({ code: "TRIAL_LIMIT_REACHED" });
});

test.each(["fresh", "stale", "wrong-id", "offline", "missing-owner", "absent"])("cloud request reuses only a fresh matching device: %s", async kind => {
  const target: any = { nodusId: "123456789", ownerUid: "host", status: "online", updatedAt: "fresh" };
  const located = kind === "absent" ? undefined : { ...target, ...(kind === "stale" ? { updatedAt: "old" } : kind === "wrong-id" ? { nodusId: "987654321" } : kind === "offline" ? { status: "offline" } : kind === "missing-owner" ? { ownerUid: "" } : {}) };
  const lookup = vi.fn(async () => target), write = vi.fn();
  const { cloudCreateSessionRequest } = functions("apps/desktop/src/core/firebase.ts", ["cloudCreateSessionRequest"], {
    normalizeNodusId, ensureDeviceUid: async () => "viewer", cloudLookupDevice: lookup, isFresh: (at: string) => at === "fresh", DEVICE_ONLINE_TTL_MS: 45000,
    Date, crypto: { randomUUID: () => "session" }, firestoreData: (value: object) => value,
    fire: async () => ({ collection: () => ({}), doc: () => ({ id: "session" }), setDoc: write, store: {} }),
  });
  await expect(cloudCreateSessionRequest({ sessionId: "session", targetNodusId: "123456789", requesterNodusId: "987654321", requesterName: "Viewer" }, located)).resolves.toMatchObject({ targetUid: "host" });
  expect(lookup).toHaveBeenCalledTimes(kind === "fresh" ? 0 : 1); expect(write).toHaveBeenCalledOnce();
});

test("ICE fetch coalesces requests, caches only unexpired declared TURN credentials, and isolates caller mutation", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ iceServers: [{ urls: "turn:relay", username: "test", credential: "secret" }], expiresAt: Date.now() + 120000 }) }));
  const { fetchIceServers } = functions("apps/desktop/src/core/api.ts", ["fetchIceServers", "fetchIceEndpoint"], {
    iceRequests: new Map(), iceCache: new Map(), fetch, Date, AbortController, structuredClone, window: { setTimeout, clearTimeout },
  });
  const [a, b] = await Promise.all([fetchIceServers("https://relay.test"), fetchIceServers("https://relay.test/")]);
  a[0].credential = "changed"; expect(b[0].credential).toBe("secret"); expect(fetch).toHaveBeenCalledOnce();
  await fetchIceServers("https://relay.test"); expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60001); await fetchIceServers("https://relay.test"); expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValue({ ok: true, json: async () => ({ iceServers: [{ urls: "turn:unknown", username: "test", credential: "secret" }], expiresAt: undefined as any }) });
  await fetchIceServers("https://other.test"); await fetchIceServers("https://other.test"); expect(fetch).toHaveBeenCalledTimes(4);
});
