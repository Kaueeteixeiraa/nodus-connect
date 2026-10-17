import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { LicenseEngine } from "./engine";
import { firestoreLicenseStore } from "./firestore-store";
import { LICENSE_DEFAULTS } from "../../../packages/licensing/src/index";
import { devicePage } from "./devices";
import { signalingRetention } from "./retention";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";

const projectId = "demo-nodus-licensing";
let environment: RulesTestEnvironment;
const describeRules = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
const requesterUid = "requester", targetUid = "target";
const requesterId = "123456789", targetId = "987654321";
const request = (sessionId: string) => ({ id: sessionId, sessionId, requesterUid, targetUid, requesterNodusId: requesterId, targetNodusId: targetId, requesterName: "Source", status: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

async function seed(enforced: boolean, sessionId?: string, expiresAt = Date.now() + 120_000) {
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await db.doc("license_policy/current").set({ enforced });
    await db.doc(`devices/${requesterId}`).set({ nodusId: requesterId, ownerUid: requesterUid });
    await db.doc(`devices/${targetId}`).set({ nodusId: targetId, ownerUid: targetUid });
    if (sessionId) await db.doc(`license_session_grants/${sessionId}`).set({ sessionId, requesterUid, targetUid, requesterNodusId: requesterId, targetNodusId: targetId, status: "RESERVED", expiresAt });
  });
}

describeRules("candidate Firestore licensing rules", () => {
  beforeAll(async () => {
    environment = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: 8088, rules: readFileSync(fileURLToPath(new URL("../firestore.candidate.rules", import.meta.url)), "utf8") } });
  });
  beforeEach(() => environment.clearFirestore());
  afterAll(() => environment?.cleanup());

  test("block watchers use stable claims, deny former owners and preserve legacy ownership", async () => {
    await seed(true);
    await environment.withSecurityRulesDisabled(async context => {
      await context.firestore().doc(`deviceClaims/${requesterId}`).set({ ownerUid: requesterUid });
      await context.firestore().doc(`license_access_blocks/${requesterId}`).set({ blocked: false });
    });
    const owner = environment.authenticatedContext(requesterUid).firestore(), nextOwner = environment.authenticatedContext("new-owner").firestore();
    const path = `license_access_blocks/${requesterId}`;
    await assertSucceeds(owner.doc(path).get()); await assertFails(nextOwner.doc(path).get());
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc(`deviceClaims/${requesterId}`).update({ ownerUid: "new-owner" }));
    await assertFails(owner.doc(path).get()); await assertSucceeds(nextOwner.doc(path).get());
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc(`deviceClaims/${requesterId}`).delete());
    await assertSucceeds(owner.doc(path).get()); await assertFails(nextOwner.doc(path).get());
    await assertFails(environment.unauthenticatedContext().firestore().doc(path).get());
  });

  test.each(["block", "hardware", "ownership", "end"])("live business grants enforce %s on the receiving peer without heartbeat polling", async change => {
    const sessionId = "business-live"; await seed(true, sessionId);
    const path = `license_session_grants/${sessionId}`, controlPath = "license_session_controls/hw-physical-source";
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await db.doc(`deviceClaims/${requesterId}`).set({ ownerUid: requesterUid });
      await db.doc(`license_access_blocks/${requesterId}`).set({ blocked: false });
      await db.doc(`license_identity_bindings/${requesterId}`).set({ deviceIdentityId: "physical-source" });
      await db.doc("license_device_identities/physical-source").set({ id: "physical-source", status: "ACTIVE" });
      await db.doc("license_licenses/business-license").set({ id: "business-license", plan: "business", deviceIds: ["physical-source"], maxDevices: 20 });
      await db.doc("license_devices/source").set({ id: "source", licenseId: "business-license", uid: requesterUid, nodusId: requesterId, deviceIdentityId: "physical-source", status: "ACTIVE" });
      await db.doc("license_devices/alias").set({ id: "alias", licenseId: "business-license", uid: "alias-owner", nodusId: "111222333", deviceIdentityId: "physical-source", status: "ACTIVE" });
      await db.doc(controlPath).set({ blocked: false, ownerUid: requesterUid });
      await db.doc(path).update({ status: "ESTABLISHED", liveAuthorization: true, authorizationControlId: "hw-physical-source", expiresAt: Number.MAX_SAFE_INTEGER });
    });
    const host = environment.authenticatedContext(targetUid).firestore();
    await assertFails(environment.authenticatedContext("outsider").firestore().doc(path).get());
    await assertFails(host.doc(controlPath).set({ blocked: false, ownerUid: targetUid }));
    await assertFails(host.collection("license_session_controls").get());
    await assertFails(environment.unauthenticatedContext().firestore().doc(controlPath).get());
    const next = vi.fn(), controls = vi.fn(), error = vi.fn(), stop = host.doc(path).onSnapshot(next, error), stopControls = host.doc(controlPath).onSnapshot(controls, error);
    const app = initializeApp({ projectId }, `live-controls-${change}`), db = getFirestore(app);
    const keys = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const engine = new LicenseEngine(firestoreLicenseStore(db), "test-pepper-only-".repeat(3), keys.privateKey);
    try {
      await vi.waitFor(() => expect(next.mock.calls.some(([snapshot]) => !snapshot.metadata.fromCache)).toBe(true));
      await vi.waitFor(() => expect(controls.mock.calls.some(([snapshot]) => !snapshot.metadata.fromCache)).toBe(true));
      if (change === "block" || change === "hardware") await engine.deviceStatus({ uid: "admin", admin: true, recent: true }, change === "block" ? "source" : "alias", "BLOCKED");
      await environment.withSecurityRulesDisabled(async context => {
        const db = context.firestore();
        if (change === "ownership") await db.doc(controlPath).update({ ownerUid: "reinstalled" });
        if (change === "end") await db.doc(path).update({ status: "ENDED" });
      });
      if (change === "end") await vi.waitFor(() => expect(next.mock.calls.some(([snapshot]) => snapshot.data()?.status === "ENDED")).toBe(true));
      else await vi.waitFor(() => expect(controls.mock.calls.some(([snapshot]) => change === "ownership" ? snapshot.data()?.ownerUid === "reinstalled" : snapshot.data()?.blocked === true && snapshot.data()?.ownerUid === requesterUid)).toBe(true));
      expect(error).not.toHaveBeenCalled();
    } finally { stop(); stopControls(); await deleteApp(app); }
  }, 30_000);

  test("20 unchanged ICE documents share a batch without weakening admission or direction checks", async () => {
    const sessionId = "ice-batch"; await seed(true, sessionId);
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc(`sessions/${sessionId}`).set({ participantUids: [requesterUid, targetUid] }));
    const source = environment.authenticatedContext(requesterUid).firestore();
    const commit = (to: string) => {
      const batch = source.batch();
      for (let index = 0; index < 20; index++) batch.set(source.doc(`sessions/${sessionId}/signals/${to}/items/ice-${index}`), { sessionId, from: requesterId, to, type: "ice-candidate", payload: { candidate: `candidate-${index}` }, seq: index });
      return batch.commit();
    };
    await assertSucceeds(commit(targetId)); await assertFails(commit(requesterId));
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc(`license_session_grants/${sessionId}`).update({ status: "ENDED" }));
    await assertFails(commit(targetId));
  });

  test("device pagination searches beyond 200 records and preserves cursor ordering and hardware blocks", async () => {
    const app = initializeApp({ projectId }, "device-pagination-test");
    try {
      const db = getFirestore(app), now = Date.now();
      for (let offset = 0; offset < 300; offset += 100) {
        const batch = db.batch();
        for (let index = offset; index < offset + 100; index++) {
          const id = `device-${String(index).padStart(3, "0")}`, nodusId = String(100_000_000 + index);
          batch.set(db.doc(`license_devices/${id}`), { id, nodusId, deviceName: `Estação ${index}`, uid: "owner", licenseId: `free-${id}`, status: "ACTIVE", activatedAt: now, lastSeenAt: now - index, tokenHash: "private", claimHash: "private", ...(index === 260 ? { deviceIdentityId: "blocked-hardware" } : {}) });
          batch.set(db.doc(`devices/${nodusId}`), { status: "online", updatedAt: new Date(now).toISOString() });
        }
        await batch.commit();
      }
      await db.doc("license_device_identities/blocked-hardware").set({ status: "BLOCKED" });
      await db.doc("devices/100000001").set({ appVersion: "1.1.28", updateState: "failed", activeSessions: 2 }, { merge: true });
      await db.doc("devices/100000002").set({ appVersion: "private-invalid-version", updateState: "secret-text", activeSessions: -1 }, { merge: true });
      const first = await devicePage(db, { query: "", filter: "all" });
      expect(first.items).toHaveLength(10); expect(first.nextCursor).toBeTruthy();
      expect(first.items[1]).toMatchObject({ appVersion: "1.1.28", updateState: "failed", activeSessions: 2 });
      expect(first.items[2]).toMatchObject({ appVersion: null, updateState: null, activeSessions: null });
      const hydration = vi.spyOn(db, "getAll");
      const runtime = await devicePage(db, { runtimeOnly: "1" });
      expect(runtime.items).toHaveLength(10);
      expect(hydration).toHaveBeenCalledTimes(1);
      expect(hydration.mock.calls[0]).toHaveLength(10);
      expect(hydration.mock.calls[0].every(ref => "path" in ref && typeof ref.path === "string" && ref.path.startsWith("devices/"))).toBe(true);
      hydration.mockRestore();
      await expect(devicePage(db, { runtimeOnly: "1", filter: "BLOCKED" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const second = await devicePage(db, { cursor: first.nextCursor });
      expect(second.items).toHaveLength(10);
      expect(second.items.some(device => first.items.some(first => first.id === device.id))).toBe(false);
      const old = await devicePage(db, { query: "estacao260", filter: "BLOCKED" });
      expect(old.items).toHaveLength(1); expect(old.items[0]).toMatchObject({ id: "device-260", status: "BLOCKED" });
      expect(old.items[0]).not.toHaveProperty("tokenHash"); expect(old.items[0]).not.toHaveProperty("claimHash");
      expect(old.nextCursor).toBeNull();
      const exact = await devicePage(db, { query: "100 000 260", filter: "BLOCKED" });
      expect(exact.items.map(device => device.id)).toEqual(["device-260"]);
      expect(exact.nextCursor).toBeNull();
      await expect(devicePage(db, { cursor: "invalid" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    } finally { await deleteApp(app); }
  }, 30_000);

  test("bounded retention removes only old signaling and requests and coalesces cleanup between instances", async () => {
    const app = initializeApp({ projectId }, "signaling-retention-test");
    try {
      const db = getFirestore(app), now = Date.now(), old = new Date(now - 86_400_001).toISOString(), fresh = new Date(now).toISOString();
      const paths = ["sessionRequests/old", "sessions/old/signals/123456789/items/old"];
      for (const path of paths) await db.doc(path).set({ createdAt: old });
      for (const path of ["sessionRequests/fresh", "sessions/fresh/signals/123456789/items/fresh"]) await db.doc(path).set({ createdAt: fresh });
      await db.doc("license_licenses/free-original").set({ trialUsed: 85, trialLimit: 10_000 });
      await db.doc("license_access_blocks/123456789").set({ blocked: true });
      const clean = signalingRetention(db, () => now);
      await Promise.all([clean(), clean(), signalingRetention(db, () => now)()]);
      for (const path of paths) expect((await db.doc(path).get()).exists).toBe(false);
      expect((await db.doc("sessionRequests/fresh").get()).exists).toBe(true);
      expect((await db.doc("sessions/fresh/signals/123456789/items/fresh").get()).exists).toBe(true);
      expect((await db.doc("license_licenses/free-original").get()).data()).toEqual({ trialUsed: 85, trialLimit: 10_000 });
      expect((await db.doc("license_access_blocks/123456789").get()).get("blocked")).toBe(true);
      await clean();
    } finally { await deleteApp(app); }
  }, 30_000);

  test("real Firestore transactions preserve reinstall quotas, serialize final access and detach cancelled company aliases", async () => {
    const app = initializeApp({ projectId }, "identity-transaction-test");
    try {
      const db = getFirestore(app);
      const keys = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
      const engine = new LicenseEngine(firestoreLicenseStore(db), "emulator-only-pepper".repeat(3), keys.privateKey);
      await db.doc("license_policy/current").set({ ...LICENSE_DEFAULTS, enforced: true });
      for (const [nodusId, uid, deviceId] of [[requesterId, requesterUid, "original"], ["111222333", "reinstalled-user", "reinstalled"]]) {
        await db.doc(`deviceClaims/${nodusId}`).set({ ownerUid: uid, deviceId, deviceClaim: `claim-${deviceId}` });
        await db.doc(`devices/${nodusId}`).set({ ownerUid: uid, nodusId });
      }
      await db.doc(`devices/${targetId}`).set({ ownerUid: targetUid, nodusId: targetId });
      const originalInput = { deviceId: "original", nodusId: requesterId, deviceName: "Original", deviceClaim: "claim-original" };
      await engine.enroll({ uid: requesterUid }, originalInput);
      await db.doc("license_licenses/free-original").update({ trialUsed: 9_999 });
      await db.doc("license_policy/current").update({ identityEnabled: true, allowNewIdentities: false });
      const licenseIdentity = { version: 1 as const, anchors: { system: "a".repeat(64), board: "b".repeat(64) }, virtual: false };
      const original = await engine.enroll({ uid: requesterUid }, { ...originalInput, licenseIdentity });
      const restored = await engine.enroll({ uid: "reinstalled-user" }, { deviceId: "reinstalled", nodusId: "111222333", deviceName: "Restored", deviceClaim: "claim-reinstalled", licenseIdentity });
      expect(await engine.info({ uid: "reinstalled-user" }, restored)).toMatchObject({ trialUsed: 9_999, trialLimit: 10_000 });
      const attempts = await Promise.allSettled([
        engine.reserve({ uid: requesterUid }, original, { sessionId: "last-original", targetNodusId: targetId, eventDriven: true }),
        engine.reserve({ uid: "reinstalled-user" }, restored, { sessionId: "last-restored", targetNodusId: targetId, eventDriven: true }),
      ]);
      expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
      const index = attempts.findIndex(attempt => attempt.status === "fulfilled"), session = index ? "last-restored" : "last-original";
      const actor = { uid: index ? "reinstalled-user" : requesterUid };
      await engine.lifecycle(actor, session, "establish");
      await engine.lifecycle({ uid: targetUid }, session, "establish");
      await engine.lifecycle(actor, session, "establish");
      expect(await engine.info({ uid: requesterUid }, original)).toMatchObject({ trialUsed: 10_000, allowed: false, code: "TRIAL_LIMIT_REACHED" });
      await expect(engine.reserve({ uid: "reinstalled-user" }, restored, { sessionId: "access-10001", targetNodusId: targetId })).rejects.toMatchObject({ code: "TRIAL_LIMIT_REACHED" });
      await engine.lifecycle(actor, session, "end");
      const admin = { uid: "owner", admin: true, recent: true };
      const company = await engine.createBusiness(admin, { name: "Archived Company", email: "owner@example.test" });
      await engine.payment(admin, { licenseId: company.licenseId, paymentId: "initial", amountCents: 20_000 });
      await engine.activate({ uid: requesterUid }, original, company.key);
      await engine.activate({ uid: "reinstalled-user" }, restored, company.key);
      const personal = (await db.doc("license_licenses/free-original").get()).data();
      await engine.modify(admin, company.licenseId, { status: "CANCELED" });
      expect(await engine.archiveOrganization(admin, company.organizationId)).toMatchObject({ detachedDevices: 2 });
      expect((await db.collection("license_devices").where("licenseId", "==", company.licenseId).get()).empty).toBe(true);
      expect((await db.doc("license_licenses/free-original").get()).data()).toEqual(personal);
      for (const [actor, credentials] of [[{ uid: requesterUid }, original], [{ uid: "reinstalled-user" }, restored]] as const) {
        expect(await engine.info(actor, credentials)).toMatchObject({ plan: "free", organization: "", keyMasked: "", trialUsed: 10_000, code: "TRIAL_LIMIT_REACHED" });
      }
      expect(await engine.archiveOrganization(admin, company.organizationId)).toMatchObject({ duplicate: true, detachedDevices: 0 });
    } finally { await deleteApp(app); }
  }, 30_000);

  test("rollout disabled preserves the existing request path", async () => {
    await seed(false);
    const db = environment.authenticatedContext(requesterUid).firestore();
    const { sessionId: _sessionId, ...legacy } = request("legacy");
    await assertSucceeds(db.doc("sessionRequests/legacy").set(legacy));
  });

  test("admin blocks outgoing access independently of quotas without blocking reception", async () => {
    await seed(false);
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc(`license_access_blocks/${requesterId}`).set({ blocked: true, uid: requesterUid }));
    const source = environment.authenticatedContext(requesterUid).firestore(), host = environment.authenticatedContext(targetUid).firestore();
    await assertFails(source.doc("sessionRequests/blocked").set(request("blocked")));
    await assertSucceeds(source.doc(`license_access_blocks/${requesterId}`).get());
    await assertFails(host.doc(`license_access_blocks/${requesterId}`).get());
    await assertFails(source.doc(`license_access_blocks/${requesterId}`).set({ blocked: false }));
    await assertSucceeds(host.doc("sessionRequests/incoming").set({ ...request("incoming"), requesterUid: targetUid, targetUid: requesterUid, requesterNodusId: targetId, targetNodusId: requesterId }));
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc(`license_access_blocks/${requesterId}`).update({ blocked: false }));
    await assertSucceeds(source.doc("sessionRequests/unblocked").set(request("unblocked")));
  });

  test("enforcement denies unreserved, expired and forged admissions", async () => {
    await seed(true, "expired", Date.now() - 1);
    const db = environment.authenticatedContext(requesterUid).firestore();
    await assertFails(db.doc("sessionRequests/missing").set(request("missing")));
    await assertFails(db.doc("sessionRequests/expired").set(request("expired")));
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc("license_session_grants/forged").set({ sessionId: "forged", requesterUid: "other", targetUid, requesterNodusId: requesterId, targetNodusId: targetId, status: "RESERVED", expiresAt: Date.now() + 120_000 }));
    await assertFails(db.doc("sessionRequests/forged").set(request("forged")));
  });

  test("reserved request and matching session work; outsiders and spoofed signals fail", async () => {
    const sessionId = "reserved"; await seed(true, sessionId);
    const source = environment.authenticatedContext(requesterUid).firestore();
    const target = environment.authenticatedContext(targetUid).firestore();
    const outsider = environment.authenticatedContext("outsider").firestore();
    await assertSucceeds(source.doc(`sessionRequests/${sessionId}`).set(request(sessionId)));
    const session = { sessionId, requesterNodusId: requesterId, targetNodusId: targetId, participantUids: [requesterUid, targetUid], updatedAt: new Date().toISOString() };
    await assertSucceeds(target.doc(`sessions/${sessionId}`).set(session));
    await assertSucceeds(target.doc(`sessionRequests/${sessionId}`).update({ status: "accepted", updatedAt: new Date().toISOString() }));
    const signalPath = (id: string) => source.doc(`sessions/${sessionId}/signals/${targetId}/items/${id}`);
    await assertSucceeds(signalPath("valid").set({ sessionId, from: requesterId, to: targetId, type: "offer", payload: {}, seq: 1, createdAt: new Date().toISOString() }));
    await assertFails(signalPath("spoofed").set({ sessionId, from: targetId, to: targetId, type: "offer", payload: {}, seq: 2, createdAt: new Date().toISOString() }));
    await assertFails(outsider.doc(`sessions/${sessionId}/signals/${targetId}/items/outsider`).set({ sessionId, from: requesterId, to: targetId, type: "offer", payload: {}, seq: 3, createdAt: new Date().toISOString() }));
  });

  test("desktop clients cannot alter licenses, payments, roles or policy", async () => {
    const db = environment.authenticatedContext(requesterUid).firestore();
    for (const [collection, id] of [["license_licenses", "license"], ["license_payments", "payment"], ["license_admins", requesterUid], ["license_policy", "current"], ["license_device_identities", "hardware"], ["license_identity_anchors", "anchor"], ["license_identity_bindings", requesterId], ["license_identity_reviews", "device"], ["license_identity_migrations", "legacy"]]) {
      await assertFails(db.doc(`${collection}/${id}`).set({ status: "ACTIVE", role: "SUPER_ADMIN", enforced: false }));
    }
  });

  test("hardware rollout requires a server grant even if the old quota switch is off", async () => {
    await seed(false);
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc("license_policy/current").update({ identityEnabled: true }));
    const source = environment.authenticatedContext(requesterUid).firestore();
    await assertFails(source.doc("sessionRequests/unreserved").set(request("unreserved")));
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc("license_session_grants/reserved").set({ ...request("reserved"), status: "RESERVED", expiresAt: Date.now() + 120_000 }));
    await assertSucceeds(source.doc("sessionRequests/reserved").set(request("reserved")));
  });

  test("an active hardware-bound device creates a reserved request with an existing cleared block", async () => {
    const sessionId = "bound-request";
    await seed(true, sessionId);
    await environment.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await db.doc("license_policy/current").update({ identityEnabled: true });
      await db.doc(`license_access_blocks/${requesterId}`).set({ blocked: false, uid: requesterUid });
      await db.doc(`license_identity_bindings/${requesterId}`).set({ deviceIdentityId: "physical" });
      await db.doc("license_device_identities/physical").set({ status: "ACTIVE" });
    });
    const source = environment.authenticatedContext(requesterUid).firestore();
    await assertSucceeds(source.doc(`sessionRequests/${sessionId}`).set({ ...request(sessionId), requestedPermissions: ["screen:view", "mouse:control", "keyboard:control"], passwordHash: "", preferredResolution: "native", preferredFps: 60 }));
    await environment.withSecurityRulesDisabled(async context => {
      await context.firestore().doc(`sessionRequests/${sessionId}`).delete();
      await context.firestore().doc(`license_access_blocks/${requesterId}`).set({ blocked: true });
    });
    await assertFails(source.doc(`sessionRequests/${sessionId}`).set(request(sessionId)));
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc(`license_access_blocks/${requesterId}`).set({ uid: requesterUid }));
    await assertFails(source.doc(`sessionRequests/${sessionId}`).set(request(sessionId)));
    await environment.withSecurityRulesDisabled(async context => {
      await context.firestore().doc(`license_access_blocks/${requesterId}`).set({ blocked: false });
      await context.firestore().doc("license_device_identities/physical").set({ status: "BLOCKED" });
    });
    await assertFails(source.doc(`sessionRequests/${sessionId}`).set(request(sessionId)));
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc("license_device_identities/physical").delete());
    await assertFails(source.doc(`sessionRequests/${sessionId}`).set(request(sessionId)));
  });

  test("a physical block follows the trusted binding without blocking incoming support", async () => {
    await seed(false);
    await environment.withSecurityRulesDisabled(async context => {
      await context.firestore().doc(`license_identity_bindings/${requesterId}`).set({ deviceIdentityId: "physical" });
      await context.firestore().doc("license_device_identities/physical").set({ status: "BLOCKED" });
    });
    const source = environment.authenticatedContext(requesterUid).firestore(), host = environment.authenticatedContext(targetUid).firestore();
    await assertFails(source.doc("sessionRequests/outgoing").set(request("outgoing")));
    await assertSucceeds(host.doc("sessionRequests/incoming").set({ ...request("incoming"), requesterUid: targetUid, targetUid: requesterUid, requesterNodusId: targetId, targetNodusId: requesterId }));
  });

  test("free session deadlines deny signaling while unlimited business grants remain usable", async () => {
    const sessionId = "timed"; await seed(true, sessionId);
    const source = environment.authenticatedContext(requesterUid).firestore();
    await environment.withSecurityRulesDisabled(async context => {
      await context.firestore().doc(`sessions/${sessionId}`).set({ participantUids: [requesterUid, targetUid] });
      await context.firestore().doc(`license_session_grants/${sessionId}`).update({ status: "ESTABLISHED", endsAt: Date.now() + 600_000 });
    });
    const signal = { sessionId, from: requesterId, to: targetId, type: "ice-candidate", payload: {}, seq: 1, createdAt: new Date().toISOString() };
    const path = `sessions/${sessionId}/signals/${targetId}/items`;
    await assertSucceeds(source.doc(`${path}/active`).set(signal));
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc(`license_session_grants/${sessionId}`).update({ endsAt: Date.now() - 1 }));
    await assertFails(source.doc(`${path}/expired`).set(signal));
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc(`license_session_grants/${sessionId}`).update({ endsAt: 0 }));
    await assertSucceeds(source.doc(`${path}/business`).set(signal));
  });

  test("event listeners retain participant authorization and reject ended grants", async () => {
    const sessionId = "watched"; await seed(true, sessionId);
    await environment.withSecurityRulesDisabled(async context => {
      await context.firestore().doc(`sessions/${sessionId}`).set({ participantUids: [requesterUid, targetUid] });
      await context.firestore().doc(`sessionRequests/${sessionId}`).set(request(sessionId));
    });
    const source = environment.authenticatedContext(requesterUid).firestore(), host = environment.authenticatedContext(targetUid).firestore();
    const outsider = environment.authenticatedContext("outsider").firestore();
    const path = `sessions/${sessionId}/signals/${targetId}/items`;
    for (const query of [source.collection(path), host.collection(path),
      source.collection("sessionRequests").where("requesterNodusId", "==", requesterId).where("requesterUid", "==", requesterUid),
      host.collection("sessionRequests").where("targetNodusId", "==", targetId).where("targetUid", "==", targetUid)]) {
      await assertSucceeds(new Promise<void>((resolve, reject) => {
        const stop = query.onSnapshot(snapshot => { if (!snapshot.metadata.fromCache) { stop(); resolve(); } }, reject);
      }));
    }
    await assertFails(new Promise<void>((resolve, reject) => {
      const stop = outsider.collection(path).onSnapshot(snapshot => { if (!snapshot.metadata.fromCache) { stop(); resolve(); } }, reject);
    }));
    await environment.withSecurityRulesDisabled(async context => context.firestore().doc(`license_session_grants/${sessionId}`).update({ status: "ENDED" }));
    await assertFails(new Promise<void>((resolve, reject) => {
      const stop = source.collection(path).onSnapshot(snapshot => { if (!snapshot.metadata.fromCache) { stop(); resolve(); } }, reject);
    }));
  });
});
