import { generateKeyPairSync, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { LICENSE_DEFAULTS, LicenseError, effectiveStatus, type License } from "../../../packages/licensing/src/index";
import { LicenseEngine, type Actor } from "./engine";
import type { LicenseStore, LicenseTransaction } from "./store";
import { signLease, verifyLease } from "./security";
import { createLicenseHandler } from "./http";
import type { PaymentProvider } from "./payments";
import { RelayLicenseGate } from "../../coordination/src/license-gate";
import { createRelayServer } from "../../coordination/src/relay";
import { OfflineLeaseAnchor, verifyBrowserLease } from "../../../packages/licensing/src/offline";
import { FIRESTORE_CLIENT_CONFIG } from "./firestore-store";
import support from "../../../apps/desktop/electron/quick-support.cjs";
import desktopUpdates from "../../../apps/desktop/electron/desktop-update.cjs";
import type { SupportDraft } from "../../../packages/common/src/quick-support";

// Only tests use this store; production always uses Firestore transactions.
export class TestStore implements LicenseStore {
  data = new Map<string, object>(); private tail: Promise<unknown> = Promise.resolve();
  async transaction<T>(operation: (tx: LicenseTransaction) => Promise<T>, options?: { readOnly: boolean }): Promise<T> {
    const run = this.tail.then(async () => {
      const next = new Map([...this.data].map(([key, value]) => [key, structuredClone(value)]));
      const result = await operation({ async get<T>(key: string) { return (structuredClone(next.get(key)) as T) ?? null; }, set(key, value) { if (options?.readOnly) throw new Error("READ_ONLY_TRANSACTION"); next.set(key, structuredClone(value)); } });
      this.data = next; return result;
    }); this.tail = run.catch(() => undefined); return run;
  }
}
const keys = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const admin: Actor = { uid: "owner", admin: true, recent: true };
async function fixture() {
  const store = new TestStore(); let time = 1_800_000_000_000;
  store.data.set("license_policy/current", { ...LICENSE_DEFAULTS, enforced: true });
  const engine = new LicenseEngine(store, "test-pepper-only-".repeat(3), keys.privateKey, () => time);
  const actor = { uid: "source" }, host = { uid: "host" };
  store.data.set("deviceClaims/123456789", { ownerUid: actor.uid, deviceId: "device-source", deviceClaim: "claim-source" });
  store.data.set("devices/123456789", { ownerUid: actor.uid, nodusId: "123456789" });
  store.data.set("devices/987654321", { ownerUid: host.uid, nodusId: "987654321" });
  const credentials = await engine.enroll(actor, { deviceId: "device-source", nodusId: "123456789", deviceName: "Source", deviceClaim: "claim-source" });
  const reserve = (sessionId: string, offline = false) => engine.reserve(actor, credentials, { sessionId, targetNodusId: "987654321", offline });
  const establish = async (id: string) => { await engine.lifecycle(actor, id, "establish"); await engine.lifecycle(host, id, "establish"); };
  const business = async () => { const created = await engine.createBusiness(admin, { name: "Example", email: "owner@example.test" }); await engine.payment(admin, { licenseId: created.licenseId, paymentId: "initial-payment", amountCents: 20000 }); await engine.activate(actor, credentials, created.key); return created; };
  return { store, engine, actor, host, credentials, reserve, establish, business, time: () => time, advance: (ms: number) => time += ms };
}
describe("desktop update distribution", () => {
  const version = "1.1.16";
  const release = { tag_name: `v${version}`, assets: [{ name: `Nodus-Connect-Setup-${version}.exe`, browser_download_url: `https://github.com/Kaueeteixeiraa/nodus-connect/releases/download/v${version}/Nodus-Connect-Setup-${version}.exe`, digest: `sha256:${"a".repeat(64)}`, size: 100 }] };
  const fetchRelease = () => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(release)));
  test("only a recently authenticated admin can release a verified official installer", async () => {
    const f = await fixture(), network = fetchRelease();
    await expect(f.engine.publishDesktopUpdate(f.actor, true, version, network)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.engine.publishDesktopUpdate({ ...admin, recent: false }, true, version, network)).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(network).not.toHaveBeenCalled();
    await f.engine.signedDesktopUpdate();
    expect(await f.engine.publishDesktopUpdate(admin, true, version, network)).toMatchObject({ enabled: true, release });
    const signed = await f.engine.signedDesktopUpdate();
    expect(desktopUpdates.verifyPolicy(signed.token, keys.publicKey, f.time())).toMatchObject({ enabled: true, release });
    expect([...f.store.data.values()].some((row: any) => row.action === "DESKTOP_UPDATE_CHANGED" && row.adminUserId === admin.uid)).toBe(true);
    expect(await f.engine.publishDesktopUpdate(admin, false, undefined, network)).toMatchObject({ enabled: false, release });
    expect(network).toHaveBeenCalledTimes(1);
    expect(desktopUpdates.verifyPolicy((await f.engine.signedDesktopUpdate()).token, keys.publicKey, f.time()).enabled).toBe(false);
  });
  test.each(["draft", "prerelease", "missing", "hash", "url", "version", "not-found"])("rejects %s releases without changing distribution", async mode => {
    const f = await fixture(), published = structuredClone(release);
    if (mode === "draft" || mode === "prerelease") Object.assign(published, { [mode]: true });
    if (mode === "missing") published.assets = [];
    if (mode === "hash") published.assets[0].digest = "invalid";
    if (mode === "url") published.assets[0].browser_download_url = "https://example.com/setup.exe";
    const network = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(published), { status: mode === "not-found" ? 404 : 200 }));
    await expect(f.engine.publishDesktopUpdate(admin, true, mode === "version" ? "../../malicious" : version, network)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(f.store.data.has("license_desktop_updates/current")).toBe(false);
  });
  test("signature, audience and expiry prevent replay of unrelated or stale authorizations", () => {
    const policy = { enabled: true, release, updatedAt: 1000 }, token = desktopUpdates.signPolicy(policy, keys.privateKey, 1000);
    expect(() => desktopUpdates.verifyPolicy(token.replace(/^./, "x"), keys.publicKey, 1000)).toThrow();
    expect(() => desktopUpdates.verifyPolicy(token, keys.publicKey, 301_001)).toThrow();
    expect(() => desktopUpdates.verifyPolicy(token, keys.publicKey, -60_000)).toThrow();
    const unrelated = desktopUpdates.signPolicy({ ...policy, kind: "nodus-support" } as any, keys.privateKey, 1000);
    expect(() => desktopUpdates.verifyPolicy(unrelated, keys.publicKey, 1000)).toThrow();
  });
  test("cached reads refresh after one minute and recover after database failures", async () => {
    const f = await fixture(), transaction = vi.spyOn(f.store, "transaction");
    await Promise.all([f.engine.signedDesktopUpdate(), f.engine.signedDesktopUpdate()]);
    expect(transaction).toHaveBeenCalledTimes(1);
    f.advance(60_001); await f.engine.signedDesktopUpdate(); expect(transaction).toHaveBeenCalledTimes(2);
    f.advance(60_001); transaction.mockRejectedValueOnce(new Error("offline"));
    await expect(f.engine.signedDesktopUpdate()).rejects.toThrow("offline");
    await expect(f.engine.signedDesktopUpdate()).resolves.toHaveProperty("token");
  });
});

describe("QuickSupport licensing", { timeout: 15000 }, () => {
  const draft: SupportDraft = { name: "Suporte Example", company: "Example", message: "Atendimento autorizado", logo: "", permissions: ["screen:view", "mouse:control"], confirmation: false, password: "Example-support-2026!" };
  async function portable(confirmation = false) {
    const f = await fixture(), business = await f.business();
    const result = await f.engine.createSupportProfile(f.actor, f.credentials, { ...draft, confirmation });
    const profile = support.verifyProfile(result.token, keys.publicKey);
    f.store.data.set("devices/987654321", { ownerUid: f.host.uid, nodusId: "987654321", supportProfileId: profile.id });
    const reserve = (sessionId: string, password = draft.password, offline = false) => f.engine.reserve(f.actor, f.credentials, { sessionId, targetNodusId: "987654321", supportProfileId: profile.id, supportPassword: password, offline });
    const admit = (sessionId: string, actor = f.host) => f.engine.supportAdmission(actor, { profileId: profile.id, sessionId, targetNodusId: "987654321", requesterNodusId: "123456789" });
    return { ...f, business, profile, result, supportReserve: reserve, admit };
  }
  test("only active Business can issue signed profiles, without plaintext password", async () => {
    const free = await fixture();
    await expect(free.engine.createSupportProfile(free.actor, free.credentials, draft)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const f = await portable();
    expect(f.profile.licenseId).toBe(f.business.licenseId);
    expect(JSON.stringify([...f.store.data])).not.toContain(draft.password);
    expect(f.profile.passwordVerifier.hash).toHaveLength(64);
    expect(() => support.verifyProfile(`${f.result.token}x`, keys.publicKey)).toThrow();
  });
  test("profile issuance accepts three characters but rejects shorter and oversized passwords", async () => {
    const f = await fixture(); await f.business();
    for (const password of ["", "ab", "x".repeat(129)]) await expect(f.engine.createSupportProfile(f.actor, f.credentials, { ...draft, password })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const result = await f.engine.createSupportProfile(f.actor, f.credentials, { ...draft, password: "abc" });
    const profile = support.verifyProfile(result.token, keys.publicKey);
    await expect(support.verifyPassword("abc", profile.passwordVerifier)).resolves.toBe(true);
  });
  test("issued profiles sign the configured release version and template hash", async () => {
    const template = { version: "1.1.14", sha256: "a".repeat(64) };
    vi.stubEnv("NODUS_SUPPORT_TEMPLATE_VERSION", template.version);
    vi.stubEnv("NODUS_SUPPORT_TEMPLATE_SHA256", template.sha256);
    try {
      const f = await portable();
      expect(f.profile.template).toEqual(template);
      expect(f.result.template).toEqual(template);
    } finally { vi.unstubAllEnvs(); }
  });
  test("password is validated server-side even when free enforcement is off; receiver uses no company slot", async () => {
    const f = await portable();
    f.store.data.set("license_policy/current", { ...LICENSE_DEFAULTS, enforced: false });
    await expect(f.supportReserve("wrong", "wrong-password")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(f.reserve("omitted-profile")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.supportReserve("offline", draft.password, true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await f.supportReserve("supported");
    await expect(f.admit("supported")).resolves.toEqual({ permissions: draft.permissions, confirmation: false });
    await f.establish("supported");
    const license = f.store.data.get(`license_licenses/${f.business.licenseId}`) as License;
    expect(license.deviceIds).toEqual([f.credentials.deviceId]);
    expect(license.trialUsed).toBe(0);
    await f.engine.lifecycle(f.host, "supported", "end");
    expect(Object.keys((f.store.data.get(`license_licenses/${license.id}`) as License).slots)).toHaveLength(0);
  });
  test("five password attempts are persisted and blocked before deriving the sixth", async () => {
    const f = await portable();
    for (let i = 0; i < 5; i++) await expect(f.supportReserve(`bad-${i}`, "wrong")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(f.supportReserve("blocked")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.store.data.get(`license_support_attempts/${f.profile.id}-987654321`)).toMatchObject({ count: 5 });
    f.advance(60_001);
    await expect(f.supportReserve("after-window")).resolves.toMatchObject({ sessionId: "after-window" });
  });
  test("confirmation mode requires an authenticated reservation, exact host and requested identity", async () => {
    const f = await portable(true);
    await expect(f.admit("unreserved")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await f.supportReserve("confirmed", "");
    await expect(f.admit("confirmed", f.actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.engine.supportAdmission(f.host, { profileId: f.profile.id, sessionId: "confirmed", targetNodusId: "111111111", requesterNodusId: "123456789" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.admit("confirmed")).resolves.toMatchObject({ confirmation: true });
    expect([...f.store.data.keys()].some(key => key.startsWith("license_support_attempts/"))).toBe(false);
  });
  test.each(["profile", "license", "expiry"])("%s revocation blocks admission, renewal and future support without preventing cleanup", async kind => {
    const f = await portable(true);
    await f.supportReserve("active"); await f.establish("active");
    if (kind === "profile") (f.store.data.get(`license_support_profiles/${f.profile.id}`) as { revoked: boolean }).revoked = true;
    else if (kind === "license") (f.store.data.get(`license_licenses/${f.business.licenseId}`) as License).keyRevoked = true;
    else f.advance(34 * 86_400_000);
    await expect(f.supportReserve("later", "")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.engine.lifecycle(f.host, "active", "heartbeat")).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(f.engine.lifecycle(f.host, "active", "end")).resolves.toMatchObject({ ok: true });
  });
  test("another company and exceeding simultaneous capacity cannot use the package", async () => {
    const f = await portable(true);
    const other = await f.engine.createBusiness(admin, { name: "Other", email: "other@example.test" });
    (f.store.data.get(`license_support_profiles/${f.profile.id}`) as { profile: { licenseId: string } }).profile.licenseId = other.licenseId;
    await expect(f.supportReserve("foreign", "")).rejects.toMatchObject({ code: "FORBIDDEN" });
    (f.store.data.get(`license_support_profiles/${f.profile.id}`) as { profile: { licenseId: string } }).profile.licenseId = f.business.licenseId;
    (f.store.data.get(`license_licenses/${f.business.licenseId}`) as License).maxConcurrentSessions = 1;
    await f.supportReserve("first", "");
    await expect(f.supportReserve("second", "")).rejects.toMatchObject({ code: "CONCURRENT_LIMIT_REACHED" });
  });
});

describe("server licensing", () => {
  test("tracking continues before enforcement, counts once and blocks only after rollout", async () => {
    const f = await fixture();
    f.store.data.set("license_policy/current", { ...LICENSE_DEFAULTS, enforced: false });
    (f.store.data.get("license_licenses/free-device-source") as License).trialUsed = 200;
    await f.reserve("tracked");
    await f.establish("tracked");
    await f.establish("tracked");
    expect((await f.engine.info(f.actor, f.credentials)).trialUsed).toBe(201);
    expect((await f.engine.info(f.actor, f.credentials)).enforced).toBe(false);
    f.store.data.set("license_policy/current", { ...LICENSE_DEFAULTS, enforced: true });
    await expect(f.reserve("blocked")).rejects.toMatchObject({ code: "TRIAL_LIMIT_REACHED" });
    await expect(f.engine.lifecycle(f.actor, "tracked", "heartbeat")).resolves.toMatchObject({ consumed: true });
  });
  test("blocking the initiator stops session renewal but still permits ending and receiving", async () => {
    const f = await fixture();
    await f.reserve("active"); await f.establish("active");
    await f.engine.deviceStatus(admin, f.credentials.deviceId, "BLOCKED");
    await expect(f.engine.lifecycle(f.actor, "active", "heartbeat")).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    await expect(f.engine.lifecycle(f.host, "active", "heartbeat")).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
    await expect(f.engine.lifecycle(f.actor, "active", "end")).resolves.toMatchObject({ ok: true });
    f.store.data.set("deviceClaims/987654321", { ownerUid: f.host.uid, deviceId: "host-device", deviceClaim: "host-claim" });
    const hostCredentials = await f.engine.enroll(f.host, { deviceId: "host-device", deviceName: "Host", nodusId: "987654321", deviceClaim: "host-claim" });
    await expect(f.engine.reserve(f.host, hostCredentials, { sessionId: "incoming", targetNodusId: "123456789" })).resolves.toMatchObject({ sessionId: "incoming" });
  });
  test("the 200th outgoing access stays usable and reception does not consume the host quota", async () => {
    const f = await fixture();
    const license = f.store.data.get("license_licenses/free-device-source") as License;
    license.trialUsed = 199;
    await f.reserve("last"); await f.establish("last");
    await expect(f.engine.lifecycle(f.actor, "last", "heartbeat")).resolves.toMatchObject({ consumed: true });
    await expect(f.reserve("extra")).rejects.toMatchObject({ code: "TRIAL_LIMIT_REACHED" });
    expect((await f.engine.info(f.actor, f.credentials)).trialUsed).toBe(200);
  });
  test("Firestore write failures return before the Admin timeout without retrying exhausted quota", () => {
    const config = FIRESTORE_CLIENT_CONFIG.interfaces["google.firestore.v1.Firestore"];
    expect(config.retry_codes.nodus_write).toEqual(["UNAVAILABLE"]);
    expect(config.methods.Commit.timeout_millis).toBeLessThan(8_000);
    expect(config.retry_params.nodus_write.total_timeout_millis).toBeLessThan(8_000);
  });
  test("manual grant retries add only 200 and cannot reuse another grant", async () => {
    const f = await fixture(); const id = "free-device-source";
    await f.engine.grantAccesses(admin, id, "grant-1");
    expect((await f.engine.grantAccesses(admin, id, "grant-1")).duplicate).toBe(true);
    expect((await f.engine.info(f.actor, f.credentials)).trialLimit).toBe(400);
    await expect(f.engine.grantAccesses(admin, "another-license", "grant-1")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  test("rollout defaults to disabled without granting unlimited commercial licenses", async () => { const f = await fixture(); f.store.data.delete("license_policy/current"); expect((await f.engine.policy()).enforced).toBe(false); });
  test("Free 0/200 and reservations, acceptance or one peer do not consume trial", async () => { const f = await fixture(); await f.reserve("s1"); await f.engine.lifecycle(f.actor, "s1", "establish"); expect((await f.engine.info(f.actor, f.credentials)).trialUsed).toBe(0); });
  test("both participants establish once; duplicate ACK, heartbeat and ICE restart never count again", async () => { const f = await fixture(); await f.reserve("s1"); await f.establish("s1"); await f.establish("s1"); await f.engine.lifecycle(f.actor, "s1", "heartbeat"); expect((await f.engine.info(f.actor, f.credentials)).trialUsed).toBe(1); });
  test("host participation does not create or consume a Free license", async () => { const f = await fixture(); await f.reserve("s1"); await f.establish("s1"); expect([...f.store.data.values()].filter((r: any) => r.plan === "free")).toHaveLength(1); });
  test("a capped receiver can keep receiving sessions because only the initiator is charged", async () => { const f = await fixture(); f.store.data.set("deviceClaims/987654321", { ownerUid: f.host.uid, deviceId: "device-host", deviceClaim: "claim-host" }); const hostCredentials = await f.engine.enroll(f.host, { deviceId: "device-host", nodusId: "987654321", deviceName: "Host", deviceClaim: "claim-host" }); (f.store.data.get("license_licenses/free-device-host") as License).trialUsed = 200; await f.reserve("s1"); await f.establish("s1"); expect((await f.engine.info(f.host, hostCredentials)).trialUsed).toBe(200); expect((await f.engine.info(f.actor, f.credentials)).trialUsed).toBe(1); });
  test("an approved request adds exactly 200 accesses and duplicate approval is idempotent", async () => { const f = await fixture(); const first = await f.engine.requestAccesses(f.actor, f.credentials); const duplicate = await f.engine.requestAccesses(f.actor, f.credentials); expect(duplicate.request.id).toBe(first.request.id); await f.engine.resolveAccessRequest(admin, first.request.id, true); await f.engine.resolveAccessRequest(admin, first.request.id, true); expect((await f.engine.info(f.actor, f.credentials)).trialLimit).toBe(400); });
  test("invalid target and outsider cannot reserve or commit", async () => { const f = await fixture(); await expect(f.engine.reserve(f.actor, f.credentials, { sessionId: "s1", targetNodusId: "bad" })).rejects.toMatchObject({ code: "INVALID_INPUT" }); await f.reserve("s1"); await expect(f.engine.lifecycle({ uid: "other" }, "s1", "establish")).rejects.toMatchObject({ code: "FORBIDDEN" }); });
  test("Free 199/200 permits exactly one concurrent reservation and 200 blocks new sessions", async () => { const f = await fixture(); (f.store.data.get("license_licenses/free-device-source") as License).trialUsed = 199; const results = await Promise.allSettled([f.reserve("s1"), f.reserve("s2")]); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); const id = results[0].status === "fulfilled" ? "s1" : "s2"; await f.establish(id); expect((await f.engine.info(f.actor, f.credentials)).trialUsed).toBe(200); await expect(f.reserve("s3")).rejects.toMatchObject({ code: "TRIAL_LIMIT_REACHED" }); await f.engine.lifecycle(f.actor, id, "heartbeat"); });
  test("failed or abandoned pending reservation frees capacity without counting", async () => { const f = await fixture(); (f.store.data.get("license_licenses/free-device-source") as License).trialUsed = 199; await f.reserve("s1"); await f.engine.lifecycle(f.actor, "s1", "end"); await f.reserve("s2"); f.advance(121000); await f.reserve("s3"); expect((await f.engine.info(f.actor, f.credentials)).trialUsed).toBe(199); });
  test("re-enrollment preserves device and trial history instead of resetting it", async () => { const f = await fixture(); await f.reserve("s1"); await f.establish("s1"); const rotated = await f.engine.enroll(f.actor, { deviceId: "device-source", nodusId: "123456789", deviceName: "Renamed", deviceClaim: "claim-source" }); expect((await f.engine.info(f.actor, rotated)).trialUsed).toBe(1); await expect(f.engine.info(f.actor, f.credentials)).rejects.toMatchObject({ code: "UNAUTHORIZED" }); });
  test("19/20 plus concurrent activations cannot create 21/20", async () => { const f = await fixture(); const b = await f.business(); const license = f.store.data.get(`license_licenses/${b.licenseId}`) as License; license.deviceIds = Array.from({ length: 19 }, (_, i) => `existing-${i}`); const devices = await Promise.all(["new-a", "new-b"].map(async (id, i) => { const actor = { uid: id }; const nodusId = `12345678${i}`; f.store.data.set(`deviceClaims/${nodusId}`, { ownerUid: id, deviceId: id, deviceClaim: id }); return { actor, credentials: await f.engine.enroll(actor, { deviceId: id, nodusId, deviceName: id, deviceClaim: id }) }; })); const results = await Promise.allSettled(devices.map(d => f.engine.activate(d.actor, d.credentials, b.key))); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect((f.store.data.get(`license_licenses/${b.licenseId}`) as License).deviceIds).toHaveLength(20); });
  test("4/5 plus concurrent requests never allocates 6/5; end is idempotent", async () => { const f = await fixture(); const b = await f.business(); for (let i = 0; i < 4; i++) await f.reserve(`s${i}`); const results = await Promise.allSettled([f.reserve("s4"), f.reserve("s5")]); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(Object.keys((f.store.data.get(`license_licenses/${b.licenseId}`) as License).slots)).toHaveLength(5); await f.engine.lifecycle(f.actor, "s0", "end"); await f.engine.lifecycle(f.actor, "s0", "end"); await f.reserve("s6"); });
  test("expiry blocks new admissions but does not stop an established session", async () => { const f = await fixture(); await f.business(); await f.reserve("s1"); await f.establish("s1"); f.advance(33 * 86400000); await expect(f.reserve("s2")).rejects.toMatchObject({ code: "LICENSE_SUSPENDED" }); await expect(f.engine.lifecycle(f.actor, "s1", "heartbeat")).resolves.toMatchObject({ ok: true }); });
  test("signed Business lease is bounded by grace and continues occupying a slot after end", async () => { const f = await fixture(); const b = await f.business(); const lease = await f.reserve("s1", true); const claims = verifyLease(lease.lease, keys.publicKey, f.time()); expect(claims.exp - claims.iat).toBe(24 * 3600000); await f.engine.lifecycle(f.actor, "s1", "end"); expect(Object.keys((f.store.data.get(`license_licenses/${b.licenseId}`) as License).slots)).toHaveLength(1); await expect(f.reserve("s1", true)).rejects.toMatchObject({ code: "SESSION_EXPIRED" }); f.advance(24 * 3600000 + 1); await f.reserve("s2"); expect(Object.keys((f.store.data.get(`license_licenses/${b.licenseId}`) as License).slots)).toHaveLength(1); });
  test("stale established sessions block admission rather than allocating phantom capacity", async () => { const f = await fixture(); await f.business(); await f.reserve("s1"); await f.establish("s1"); f.advance(121000); await expect(f.reserve("s2")).rejects.toMatchObject({ code: "SESSION_RECONCILIATION_REQUIRED" }); await f.engine.lifecycle(f.actor, "s1", "heartbeat"); await f.reserve("s2"); });
  test("revocation frees device capacity, preserves history and denies future enrollment", async () => { const f = await fixture(); const b = await f.business(); await f.engine.deviceStatus(admin, f.credentials.deviceId, "REVOKED"); await f.engine.deviceStatus(admin, f.credentials.deviceId, "REVOKED"); expect((f.store.data.get(`license_licenses/${b.licenseId}`) as License).deviceIds).toHaveLength(0); await expect(f.reserve("s1")).rejects.toMatchObject({ code: "DEVICE_REVOKED" }); });
  test("rotating or revoking activation key does not revoke existing devices", async () => { const f = await fixture(); const b = await f.business(); const rotated = await f.engine.rotateKey(admin, b.licenseId); expect(rotated.key).not.toBe(b.key); await f.engine.rotateKey(admin, b.licenseId, true); expect((await f.engine.info(f.actor, f.credentials)).allowed).toBe(true); await expect(f.engine.activate(f.actor, f.credentials, b.key)).rejects.toMatchObject({ code: "INVALID_LICENSE" }); });
  test("manual payment and duplicate webhook never extend twice and reactivate suspension", async () => { const f = await fixture(); const b = await f.business(); await f.engine.modify(admin, b.licenseId, { status: "SUSPENDED" }); await f.engine.payment(admin, { licenseId: b.licenseId, paymentId: "renewal", amountCents: 20000 }, "verified-provider", "event1"); const expiresAt = (f.store.data.get(`license_licenses/${b.licenseId}`) as License).expiresAt; await f.engine.payment(admin, { licenseId: b.licenseId, paymentId: "renewal", amountCents: 20000 }, "verified-provider", "event1"); expect((f.store.data.get(`license_licenses/${b.licenseId}`) as License).expiresAt).toBe(expiresAt); expect((await f.engine.info(f.actor, f.credentials)).allowed).toBe(true); });
  test("roles in a request body do not authorize engine administration; sensitive calls require recent auth", async () => { const f = await fixture(); await expect(f.engine.createBusiness(f.actor, { name: "X", email: "x@example.test" })).rejects.toMatchObject({ code: "FORBIDDEN" }); await expect(f.engine.createBusiness({ ...admin, recent: false }, { name: "X", email: "x@example.test" })).rejects.toMatchObject({ code: "REAUTH_REQUIRED" }); });
  test.each(["ACTIVE", "PAST_DUE", "GRACE_PERIOD"] as const)("%s transitions by server period, not a client clock", status => { const license = { plan: "business", status, expiresAt: 1000, graceUntil: 2000 } as License; expect(effectiveStatus(license, 500)).toBe("ACTIVE"); expect(effectiveStatus(license, 1500)).toBe("GRACE_PERIOD"); expect(effectiveStatus(license, 2500)).toBe("SUSPENDED"); });
  test("signed token rejects tampering and expiry", () => { const claims = { iss: "nodus-license", aud: "nodus-session", sessionId: "s", deviceId: "d", requesterUid: "a", targetUid: "b", requesterNodusId: "123456789", targetNodusId: "987654321", iat: 1000, exp: 2000 } as const; const token = signLease(claims, keys.privateKey); expect(verifyLease(token, keys.publicKey, 1500)).toEqual(claims); expect(() => verifyLease(token, keys.publicKey, 2000)).toThrow(); expect(() => verifyLease(token.replace(/^./, "x"), keys.publicKey, 1500)).toThrow(); });
});

async function httpFixture() {
  const f = await fixture();
  const providers = new Map<string, PaymentProvider>();
  const notifyAccessRequest = vi.fn(async () => true);
  const server = createServer(createLicenseHandler({ engine: f.engine, store: f.store, origins: ["http://localhost:5190"], providers,
    authenticate: async token => {
      if (token === "source-token") return f.actor;
      if (token === "host-token") return f.host;
      if (token === "admin-token") return admin;
      if (token === "old-admin-token") return { ...admin, recent: false };
      throw new LicenseError("UNAUTHORIZED");
    },
    admin: async (actor, path, input) => path === "POST /admin/organizations" ? f.engine.createBusiness(actor, input as any) : { ok: true }, notifyAccessRequest,
  }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: object, token = "source-token", extra: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
  return { ...f, base, post, providers, notifyAccessRequest, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
describe("licensing HTTP and relay enforcement", () => {
  test("public startup update checks coalesce reads and bypass authentication and writes", async () => {
    const f = await httpFixture();
    try {
      const transaction = vi.spyOn(f.store, "transaction"), before = structuredClone([...f.store.data]);
      const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(`${f.base}/license/desktop-update`)));
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction.mock.calls[0][1]).toEqual({ readOnly: true });
      for (const response of responses) {
        expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("s-maxage=60");
        expect(desktopUpdates.verifyPolicy((await response.json()).token, keys.publicKey, 1_800_000_000_000)).toMatchObject({ enabled: false });
      }
      expect([...f.store.data]).toEqual(before);
      expect((await f.post("/admin/desktop-update", { enabled: true, version: "1.1.16" }, "source-token")).status).toBe(403);
      expect((await f.post("/admin/desktop-update", { enabled: false }, "old-admin-token")).status).toBe(403);
    } finally { await f.close(); }
  });
  test("license checks retain counts and authentication when database writes are unavailable", async () => {
    const f = await httpFixture();
    try {
      await f.reserve("used-access"); await f.establish("used-access");
      const before = structuredClone([...f.store.data]);
      const transaction = f.store.transaction.bind(f.store);
      vi.spyOn(f.store, "transaction").mockImplementation(<T>(operation: (tx: LicenseTransaction) => Promise<T>, options?: { readOnly: boolean }) => {
        if (!options?.readOnly) throw new LicenseError("SERVER_UNAVAILABLE");
        return transaction(tx => operation({ get: tx.get, set: () => { throw new Error("WRITE_QUOTA_EXHAUSTED"); } }));
      });
      const response = await f.post("/license/check", f.credentials);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ trialUsed: 1, trialLimit: 200, plan: "free" });
      expect([...f.store.data]).toEqual(before);
      expect((await f.post("/license/check", f.credentials, "host-token")).status).toBe(401);
      expect((await f.post("/license/check", { ...f.credentials, deviceToken: "forged" })).status).toBe(401);
      expect((await f.post("/license/check", f.credentials, "forged-token")).status).toBe(401);
      expect((await f.post("/license/access-requests", f.credentials)).status).toBe(503);
    } finally { await f.close(); }
  });
  test("read-only license checks remain rate limited per authenticated user", async () => {
    const f = await httpFixture();
    try {
      for (let i = 0; i < 180; i++) expect((await f.post("/license/check", f.credentials)).status).toBe(200);
      expect((await f.post("/license/check", f.credentials)).status).toBe(403);
      expect(f.store.data.has("license_rate_limits/source")).toBe(false);
    } finally { await f.close(); }
  });
  test("verified admin reads do not require writes, but mutations and ordinary users remain rate limited", async () => {
    const f = await httpFixture();
    try {
      const transaction = vi.spyOn(f.store, "transaction").mockRejectedValue(new LicenseError("SERVER_UNAVAILABLE"));
      expect((await fetch(`${f.base}/admin/dashboard`, { headers: { authorization: "Bearer admin-token" } })).status).toBe(200);
      expect(transaction).not.toHaveBeenCalled();
      expect((await f.post("/admin/device", { deviceId: f.credentials.deviceId, status: "BLOCKED" }, "admin-token")).status).toBe(503);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect((await fetch(`${f.base}/admin/dashboard`, { headers: { authorization: "Bearer source-token" } })).status).toBe(503);
      expect(transaction).toHaveBeenCalledTimes(2);
      expect((await fetch(`${f.base}/admin/dashboard`, { headers: { authorization: "Bearer forged-token" } })).status).toBe(401);
      expect(transaction).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });
  test("admin blocking denies relay requests with quota rollout off and unblocking restores admission", async () => {
    const f = await httpFixture();
    try {
      f.store.data.set("license_policy/current", { ...LICENSE_DEFAULTS, enforced: false });
      const gate = new RelayLicenseGate(f.base), request = { kind: "request" as const, from: "123456789", to: "987654321" };
      await gate.authorize("source-token", request);
      await f.engine.deviceStatus(admin, f.credentials.deviceId, "BLOCKED");
      expect((await f.engine.info(f.actor, f.credentials)).code).toBe("DEVICE_REVOKED");
      await expect(gate.authorize("source-token", request)).rejects.toMatchObject({ code: "DEVICE_REVOKED" });
      await expect(gate.authorize("host-token", request)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await f.engine.deviceStatus(admin, f.credentials.deviceId, "ACTIVE");
      await gate.authorize("source-token", request);
      expect((f.store.data.get("license_access_blocks/123456789") as any).blocked).toBe(false);
    } finally { await f.close(); }
  });
  test("failed notification is reported and retry uses the same access request", async () => {
    const f = await httpFixture(); f.notifyAccessRequest.mockResolvedValueOnce(false);
    try {
      const first = await (await f.post("/license/access-requests", f.credentials)).json();
      const second = await (await f.post("/license/access-requests", f.credentials)).json();
      expect(first.notificationStatus).toBe("FAILED"); expect(second.notificationStatus).toBe("SENT");
      expect(second.requestId).toBe(first.requestId); expect(f.notifyAccessRequest).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });
  test("access increase request notifies once and reuses the pending request", async () => {
    const f = await httpFixture();
    try {
      const first = await f.post("/license/access-requests", f.credentials); expect(first.status).toBe(200);
      const second = await f.post("/license/access-requests", f.credentials); expect(second.status).toBe(200);
      expect((await first.json()).requestId).toBe((await second.json()).requestId);
      expect(f.notifyAccessRequest).toHaveBeenCalledOnce();
    } finally { await f.close(); }
  });
  test("untrusted roles, stale admin login and origin cannot authorize administration", async () => {
    const f = await httpFixture();
    try {
      expect((await f.post("/admin/organizations", { name: "X", email: "x@example.test", admin: true, role: "SUPER_ADMIN" })).status).toBe(403);
      expect((await f.post("/admin/organizations", { name: "X", email: "x@example.test" }, "old-admin-token")).status).toBe(403);
      expect((await f.post("/admin/organizations", { name: "X", email: "x@example.test" }, "admin-token", { origin: "https://evil.test" })).status).toBe(403);
      expect((await f.post("/admin/organizations", { name: "X", email: "x@example.test" }, "admin-token")).status).toBe(200);
      expect((await f.post("/license/check", { ...f.credentials, allowed: true, trialUsed: -200 }, "forged-token")).status).toBe(401);
    } finally { await f.close(); }
  });
  test("relay admission binds identity and participants, rejects reuse even across restarts", async () => {
    const f = await httpFixture();
    try {
      const gate = new RelayLicenseGate(f.base);
      await f.reserve("relay-s1");
      await expect(gate.authorize("host-token", { kind: "request", sessionId: "relay-s1", from: "123456789", to: "987654321" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await gate.authorize("source-token", { kind: "request", sessionId: "relay-s1", from: "123456789", to: "987654321" });
      await expect(gate.authorize("source-token", { kind: "request", sessionId: "relay-s1", from: "123456789", to: "987654321" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await gate.authorize("host-token", { kind: "accept", sessionId: "relay-s1", from: "987654321", to: "123456789" });
      await expect(gate.authorize("source-token", { kind: "identity", nodusId: "987654321" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await f.establish("relay-s1");
      await gate.authorize("source-token", { kind: "signal", sessionId: "relay-s1", from: "123456789", to: "987654321" });
      await expect(gate.authorize("host-token", { kind: "signal", sessionId: "relay-s1", from: "123456789", to: "987654321" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally { await f.close(); }
  });
  test("relay policy off preserves legacy; unavailable API never creates new capacity", async () => {
    const failed = vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch;
    await expect(new RelayLicenseGate("", failed).authorize("", { kind: "request", from: "123456789", to: "987654321" })).resolves.toBeUndefined();
    expect(failed).not.toHaveBeenCalled();
    await expect(new RelayLicenseGate("http://127.0.0.1:1", failed).authorize("", { kind: "request", from: "123456789", to: "987654321" })).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(() => new RelayLicenseGate("http://unsafe.test")).toThrow("INVALID_LICENSE_API");
  });
  test("verified webhooks are idempotent; forged signatures and manual public adapter are denied", async () => {
    const f = await httpFixture();
    try {
      const business = await f.business();
      f.providers.set("test-provider", { name: "test-provider", createSubscription: async () => ({ id: "test" }), cancelSubscription: async () => {}, getSubscription: async () => ({ status: "ACTIVE", currentPeriodEnd: 0 }), verifyWebhook: async (raw, headers) => {
        if (headers["x-signature"] !== createHmac("sha256", "test-only-webhook-secret").update(raw).digest("hex")) throw new Error();
        return JSON.parse(raw.toString());
      } });
      const payment = { licenseId: business.licenseId, paymentId: "webhook-payment", amountCents: 20_000, eventId: "event1" };
      expect((await f.post("/webhooks/test-provider", payment, "")).status).toBe(403);
      expect((await f.post("/webhooks/manual", payment, "")).status).toBe(403);
      const signature = createHmac("sha256", "test-only-webhook-secret").update(JSON.stringify(payment)).digest("hex");
      expect((await f.post("/webhooks/test-provider", payment, "", { "x-signature": signature })).status).toBe(200);
      const expiresAt = (f.store.data.get(`license_licenses/${business.licenseId}`) as License).expiresAt;
      expect((await (await f.post("/webhooks/test-provider", payment, "", { "x-signature": signature })).json()).duplicate).toBe(true);
      expect((f.store.data.get(`license_licenses/${business.licenseId}`) as License).expiresAt).toBe(expiresAt);
      expect(JSON.stringify([...f.store.data].filter(([id]) => id.startsWith("license_audit/")))).not.toContain(business.key);
    } finally { await f.close(); }
  });
  test("real relay rejects unreserved requests and accepts a server-reserved request", async () => {
    const f = await httpFixture();
    const previous = process.env.NODUS_LICENSE_API; process.env.NODUS_LICENSE_API = f.base;
    const relay = createRelayServer(); relay.listen(0, "127.0.0.1"); await once(relay, "listening");
    const url = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
    const send = (path: string, input: object, token: string) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-nodus-license-identity": token }, body: JSON.stringify(input) });
    try {
      const input = { sessionId: randomUUID(), requesterNodusId: "123456789", requesterName: "Source", targetNodusId: "987654321" };
      expect((await send("/v1/session-requests", input, "source-token")).status).toBe(403);
      await f.reserve(input.sessionId);
      expect((await send("/v1/session-requests", input, "host-token")).status).toBe(403);
      const created = await send("/v1/session-requests", input, "source-token"); expect(created.status).toBe(201);
      const item = await created.json();
      expect((await send(`/v1/session-requests/${item.id}/accept`, {}, "source-token")).status).toBe(403);
      expect((await send(`/v1/session-requests/${item.id}/accept`, {}, "host-token")).status).toBe(200);
      expect((await send("/v1/session-requests", input, "source-token")).status).toBe(403);
    } finally {
      relay.closeAllConnections(); await new Promise<void>(resolve => relay.close(() => resolve())); await f.close();
      if (previous === undefined) delete process.env.NODUS_LICENSE_API; else process.env.NODUS_LICENSE_API = previous;
    }
  });
});
describe("offline signed leases", () => {
  test("monotonic anchor ignores Windows clock changes and expires without permitting new capacity", async () => {
    let monotonic = 500;
    const claims = { iss: "nodus-license", aud: "nodus-session", sessionId: "s", deviceId: "d", requesterUid: "a", targetUid: "b", requesterNodusId: "123456789", targetNodusId: "987654321", iat: 1000, exp: 2000 } as const;
    const token = signLease(claims, keys.privateKey);
    expect(await verifyBrowserLease(token, keys.publicKey)).toEqual(claims);
    const anchor = new OfflineLeaseAnchor(claims, 1200, () => monotonic);
    const clock = vi.spyOn(Date, "now").mockReturnValue(-1_000_000);
    try {
      expect(anchor.valid("s", "d")).toBe(true);
      expect(anchor.valid("other", "d")).toBe(false);
      expect(anchor.valid("s", "other")).toBe(false);
      monotonic += 801; expect(anchor.valid("s", "d")).toBe(false);
      monotonic = 499; expect(anchor.valid("s", "d")).toBe(false);
    } finally { clock.mockRestore(); }
    await expect(verifyBrowserLease(token.replace(/^./, "x"), keys.publicKey)).rejects.toThrow();
  });
});
