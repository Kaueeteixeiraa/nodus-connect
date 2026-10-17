import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ getDoc: vi.fn(), setDoc: vi.fn(), addDoc: vi.fn(), batchSet: vi.fn(), commit: vi.fn(), sequence: 0, next: null as null | ((snapshot: unknown) => void), error: null as null | ((error: unknown) => void), stop: vi.fn() }));
vi.mock("firebase/app", () => ({ getApps: () => [], initializeApp: () => ({}) }));
vi.mock("firebase/auth", () => ({ getAuth: () => ({ authStateReady: async () => {}, currentUser: { uid: "fixture-user", getIdToken: async () => "fixture-token" } }) }));
vi.mock("firebase/firestore", () => ({ getFirestore: () => ({}), collection: (...args: unknown[]) => args.slice(1).join("/"), doc: (...args: unknown[]) => args.length === 1 ? `${args[0]}/${++fake.sequence}` : args.slice(1).join("/"), getDoc: fake.getDoc, setDoc: fake.setDoc, addDoc: fake.addDoc,
  writeBatch: () => ({ set: fake.batchSet, commit: fake.commit }),
  onSnapshot: (_ref: unknown, ...args: any[]) => { const index = typeof args[0] === "function" ? 0 : 1; fake.next = args[index]; fake.error = args[index + 1]; return fake.stop; } }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); fake.next = null; fake.error = null;
  fake.commit.mockReset().mockResolvedValue(undefined); fake.sequence = 0;
  for (const key of ["API_KEY", "AUTH_DOMAIN", "PROJECT_ID", "APP_ID"]) vi.stubEnv(`VITE_FIREBASE_${key}`, "fixture");
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const live = () => ({ nodusId: "123456789", ownerUid: "fixture-owner", status: "online", updatedAt: new Date().toISOString(), deviceName: "Fixture", capabilities: [] });

describe("cloud read economy", () => {
  it.each(["", undefined, null, "invalid/control"])("rejects an authorization missing a valid server control: %j", async authorizationControlId => {
    const cloud = await import("./firebase"), rejected = vi.fn();
    const watch = cloud.subscribeCloudSessionAuthorization("session", vi.fn(), rejected);
    await vi.waitFor(() => expect(fake.next).not.toBeNull());
    fake.next!({ exists: () => true, metadata: { fromCache: false }, data: () => ({ liveAuthorization: true, status: "ESTABLISHED", requesterUid: "source", authorizationControlId }) });
    expect(rejected).toHaveBeenCalledOnce(); watch.close();
  });
  it("authorization watchers ignore cache, forward server events and reject revoked access", async () => {
    const cloud = await import("./firebase"), onStatus = vi.fn(), denied = vi.fn();
    const watch = cloud.subscribeCloudSessionAuthorization("session", onStatus, denied);
    await vi.waitFor(() => expect(fake.next).not.toBeNull());
    const snapshot = (fromCache: boolean) => ({ exists: () => true, metadata: { fromCache }, data: () => ({ liveAuthorization: true, status: "ESTABLISHED", authorizationControlId: "hw-fixture", requesterUid: "source" }) });
    fake.next!(snapshot(true)); expect(onStatus).not.toHaveBeenCalled();
    fake.next!(snapshot(false)); expect(onStatus).toHaveBeenCalledExactlyOnceWith("ESTABLISHED");
    fake.error!({ code: "permission-denied" }); expect(denied).toHaveBeenCalledOnce();
    watch.close(); expect(cloud.getCloudUsageDiagnostics().activeListeners).toBe(0);
  });
  it.each([{ blocked: true, ownerUid: "source" }, { blocked: false, ownerUid: "changed" }])("direct control updates revoke the receiving peer: %j", async control => {
    const cloud = await import("./firebase"), rejected = vi.fn();
    const watch = cloud.subscribeCloudSessionAuthorization("session", vi.fn(), rejected);
    await vi.waitFor(() => expect(fake.next).not.toBeNull());
    fake.next!({ exists: () => true, metadata: { fromCache: false }, data: () => ({ liveAuthorization: true, status: "ESTABLISHED", authorizationControlId: "hw-fixture", requesterUid: "source" }) });
    fake.next!({ exists: () => true, metadata: { fromCache: false }, data: () => control });
    expect(rejected).toHaveBeenCalledOnce(); watch.close(); expect(cloud.getCloudUsageDiagnostics().activeListeners).toBe(0);
  });
  it("authorization initialization and transient retry cannot survive cleanup", async () => {
    const cloud = await import("./firebase"), denied = vi.fn();
    const cancelled = cloud.subscribeCloudSessionAuthorization("cancelled", vi.fn(), denied);
    cancelled.close(); await new Promise(resolve => setTimeout(resolve, 0)); expect(fake.next).toBeNull();
    const watch = cloud.subscribeCloudSessionAuthorization("session", vi.fn(), denied);
    await vi.waitFor(() => expect(fake.next).not.toBeNull()); vi.useFakeTimers();
    fake.error!({ code: "resource-exhausted" }); watch.close(); await vi.advanceTimersByTimeAsync(300_000);
    expect(cloud.getCloudUsageDiagnostics().listenerStarts).toBe(1); expect(denied).not.toHaveBeenCalled();
  });
  it("suspends catalog listeners only when every window is hidden and resumes once", async () => {
    const cloud = await import("./firebase");
    const documents = [Object.assign(new EventTarget(), { visibilityState: "visible" }), Object.assign(new EventTarget(), { visibilityState: "hidden" })];
    const watch = cloud.subscribeCloudVisiblePresence(["123456789", "123456789"], vi.fn(), documents as Document[]);
    await vi.waitFor(() => expect(cloud.getCloudUsageDiagnostics().activeListeners).toBe(1));
    documents[1].visibilityState = "visible"; documents[1].dispatchEvent(new Event("visibilitychange"));
    documents[0].visibilityState = "hidden"; documents[0].dispatchEvent(new Event("visibilitychange"));
    expect(fake.stop).not.toHaveBeenCalled();
    documents[1].visibilityState = "hidden"; documents[1].dispatchEvent(new Event("visibilitychange"));
    expect(fake.stop).toHaveBeenCalledOnce(); expect(cloud.getCloudUsageDiagnostics().activeListeners).toBe(0);
    documents[0].visibilityState = "visible"; documents[0].dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(cloud.getCloudUsageDiagnostics().activeListeners).toBe(1));
    watch.close(); watch.close(); documents[0].dispatchEvent(new Event("visibilitychange"));
    expect(cloud.getCloudUsageDiagnostics().activeListeners).toBe(0);
    expect(cloud.getCloudUsageDiagnostics().listenerStarts).toBe(2);
  });
  it("publishes offline presence without a redundant read when identity is available", async () => {
    const cloud = await import("./firebase");
    expect(await cloud.cloudUnregisterPresence({ nodusId: "123456789", deviceName: "Fixture" } as any)).toMatchObject({ status: "offline", ownerUid: "fixture-user" });
    expect(fake.getDoc).not.toHaveBeenCalled(); expect(fake.setDoc).toHaveBeenCalledOnce();
  });
  it("microbatches ICE without changing signal documents, exceeding 20 writes or delaying SDP", async () => {
    const cloud = await import("./firebase");
    const messages = Array.from({ length: 40 }, (_, index) => cloud.cloudSendSignal("session", { from: "123456789", to: "987654321", type: "ice-candidate", payload: { candidate: `candidate-${index}` } }));
    const result = await Promise.all(messages);
    expect(fake.commit).toHaveBeenCalledTimes(2); expect(fake.batchSet).toHaveBeenCalledTimes(40);
    expect(result.map(item => item.payload)).toEqual(Array.from({ length: 40 }, (_, index) => ({ candidate: `candidate-${index}` })));
    expect(new Set(fake.batchSet.mock.calls.map(([ref]) => ref)).size).toBe(40);
    expect(cloud.getCloudUsageDiagnostics().writeRequests).toBe(40);
    const tail = cloud.cloudSendSignal("session", { from: "123456789", to: "987654321", type: "ice-candidate", payload: {} });
    await cloud.cloudSendSignal("session", { from: "123456789", to: "987654321", type: "offer", payload: {} });
    expect(fake.addDoc).toHaveBeenCalledOnce(); await tail;
  });
  it("rejects every failed batch message, records failure and allows a clean retry", async () => {
    const cloud = await import("./firebase"), signal = { from: "123456789", to: "987654321", type: "ice-candidate" as const, payload: {} };
    fake.commit.mockRejectedValueOnce({ code: "permission-denied" });
    const failures = await Promise.allSettled([cloud.cloudSendSignal("session", signal), cloud.cloudSendSignal("session", signal)]);
    expect(failures.every(item => item.status === "rejected")).toBe(true);
    expect(cloud.getCloudUsageDiagnostics()).toMatchObject({ writeRequests: 2, permissionErrors: 1 });
    await expect(cloud.cloudSendSignal("session", signal)).resolves.toMatchObject(signal);
    expect(fake.commit).toHaveBeenCalledTimes(2);
  });
  it("coalesces simultaneous device lookups without caching offline or failed responses", async () => {
    const cloud = await import("./firebase");
    let done!: (value: unknown) => void;
    fake.getDoc.mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const one = cloud.cloudLookupDevice("123456789"), two = cloud.cloudLookupDevice("123 456 789");
    await vi.waitFor(() => expect(fake.getDoc).toHaveBeenCalledTimes(1));
    done({ metadata: { fromCache: false }, exists: () => true, data: live });
    expect(await one).toEqual(await two);
    fake.getDoc.mockRejectedValueOnce({ code: "resource-exhausted" });
    await expect(cloud.cloudLookupDevice("123456789")).rejects.toMatchObject({ code: "resource-exhausted" });
    fake.getDoc.mockResolvedValueOnce({ metadata: { fromCache: false }, exists: () => false });
    expect(await cloud.cloudLookupDevice("123456789")).toBeNull();
    expect(cloud.getCloudUsageDiagnostics()).toMatchObject({ readRequests: 3, quotaErrors: 1 });
  });
  it("reuses fresh presence already delivered by a listener and invalidates deletions and closures", async () => {
    const cloud = await import("./firebase"), onPresence = vi.fn();
    const watch = cloud.subscribeCloudDevicePresence("123456789", onPresence);
    await vi.waitFor(() => expect(fake.next).not.toBeNull());
    fake.next!({ metadata: { fromCache: false }, exists: () => true, data: live });
    expect(await cloud.cloudLookupDevice("123456789")).toMatchObject({ status: "online" });
    expect(fake.getDoc).not.toHaveBeenCalled();
    fake.next!({ metadata: { fromCache: false }, exists: () => false });
    fake.getDoc.mockResolvedValue({ metadata: { fromCache: false }, exists: () => false });
    expect(await cloud.cloudLookupDevice("123456789")).toBeNull();
    expect(fake.getDoc).toHaveBeenCalledTimes(1);
    watch.close(); watch.close();
    expect(cloud.getCloudUsageDiagnostics().activeListeners).toBe(0);
  });
  it("reports closed listeners and categorized failures without recording tokens or user data", async () => {
    const cloud = await import("./firebase");
    const watch = cloud.subscribeCloudDevicePresence("123456789", vi.fn());
    await vi.waitFor(() => expect(fake.error).not.toBeNull());
    expect(cloud.getCloudUsageDiagnostics().activeListeners).toBe(1);
    fake.error!({ code: "permission-denied", message: "PRIVATE-TOKEN" }); watch.close();
    expect(cloud.getCloudUsageDiagnostics()).toMatchObject({ activeListeners: 0, permissionErrors: 1, errors: 1 });
    expect(JSON.stringify(cloud.getCloudUsageDiagnostics())).not.toContain("PRIVATE-TOKEN");
  });
});
