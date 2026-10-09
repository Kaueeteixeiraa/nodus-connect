import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, test } from "vitest";
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
    for (const [collection, id] of [["license_licenses", "license"], ["license_payments", "payment"], ["license_admins", requesterUid], ["license_policy", "current"]]) {
      await assertFails(db.doc(`${collection}/${id}`).set({ status: "ACTIVE", role: "SUPER_ADMIN", enforced: false }));
    }
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
