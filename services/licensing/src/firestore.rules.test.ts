import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { LicenseEngine } from "./engine";
import { firestoreLicenseStore } from "./firestore-store";
import { LICENSE_DEFAULTS } from "../../../packages/licensing/src/index";
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

  test("real Firestore transactions preserve a reinstalled device and serialize its last free access", async () => {
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
      await db.doc("license_licenses/free-original").update({ trialUsed: 199 });
      await db.doc("license_policy/current").update({ identityEnabled: true, allowNewIdentities: false });
      const licenseIdentity = { version: 1 as const, anchors: { system: "a".repeat(64), board: "b".repeat(64) }, virtual: false };
      const original = await engine.enroll({ uid: requesterUid }, { ...originalInput, licenseIdentity });
      const restored = await engine.enroll({ uid: "reinstalled-user" }, { deviceId: "reinstalled", nodusId: "111222333", deviceName: "Restored", deviceClaim: "claim-reinstalled", licenseIdentity });
      expect(await engine.info({ uid: "reinstalled-user" }, restored)).toMatchObject({ trialUsed: 199, trialLimit: 200 });
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
      expect(await engine.info({ uid: requesterUid }, original)).toMatchObject({ trialUsed: 200, allowed: false, code: "TRIAL_LIMIT_REACHED" });
      await expect(engine.reserve({ uid: "reinstalled-user" }, restored, { sessionId: "access-201", targetNodusId: targetId })).rejects.toMatchObject({ code: "TRIAL_LIMIT_REACHED" });
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
