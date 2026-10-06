import { createServer } from "node:http";
import { createPrivateKey } from "node:crypto";
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, AggregateField, type QueryDocumentSnapshot, type Transaction } from "firebase-admin/firestore";
import { LicenseError, effectiveStatus, type License, type LicenseAccessRequest, type LicenseDevice, type LicensePolicy } from "../../../packages/licensing/src/index.js";
import { LicenseEngine, validId, text, requireAdmin, type Actor } from "./engine.js";
import { configureFirestore, firestoreLicenseStore } from "./firestore-store.js";
import { createLicenseHandler } from "./http.js";
import { paymentProviders } from "./payments.js";
import { notifyAccessRequest } from "./email.js";

const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
if (!projectId) throw new Error("LICENSE_PROJECT_NOT_CONFIGURED");
if (process.env.NODE_ENV === "production" && (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST)) throw new Error("PRODUCTION_EMULATOR_FORBIDDEN");
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) : null;
if (serviceAccount && serviceAccount.project_id !== projectId) throw new Error("LICENSE_SERVICE_ACCOUNT_PROJECT_MISMATCH");
initializeApp({ projectId, ...(process.env.FIRESTORE_EMULATOR_HOST ? {} : { credential: serviceAccount ? cert(serviceAccount) : applicationDefault() }) });
const db = configureFirestore(getFirestore()), auth = getAuth(), store = firestoreLicenseStore(db);
const PRESENCE_TTL_MS = 45_000;
const engine = new LicenseEngine(store, process.env.LICENSE_KEY_PEPPER ?? "", (process.env.LICENSE_SIGNING_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"));
if (createPrivateKey((process.env.LICENSE_SIGNING_PRIVATE_KEY ?? "").replace(/\\n/g, "\n")).asymmetricKeyType !== "ed25519") throw new Error("LICENSE_SIGNING_KEY_INVALID");
async function authenticate(token: string): Promise<Actor> {
  let decoded;
  try { decoded = await auth.verifyIdToken(token, true); } catch { throw new LicenseError("UNAUTHORIZED"); }
  const owner = decoded.email_verified === true && decoded.email === process.env.LICENSE_ADMIN_EMAIL && decoded.firebase?.sign_in_provider === "google.com";
  if (owner && decoded.role !== "SUPER_ADMIN") {
    const user = await auth.getUser(decoded.uid);
    const ref = db.doc(`license_admins/${decoded.uid}`);
    const active = await db.runTransaction(async (tx: Transaction) => {
      const existing = await tx.get(ref);
      if (existing.exists) return existing.data()?.status === "ACTIVE" && existing.data()?.role === "SUPER_ADMIN";
      tx.create(ref, { role: "SUPER_ADMIN", status: "ACTIVE", email: decoded.email, updatedAt: Date.now() }); return true;
    });
    if (active) await auth.setCustomUserClaims(decoded.uid, { ...user.customClaims, role: "SUPER_ADMIN" });
  }
  const admin = owner || decoded.role === "SUPER_ADMIN" ? (await db.doc(`license_admins/${decoded.uid}`).get()).data() : null;
  const mfa = process.env.LICENSE_ADMIN_REQUIRE_MFA !== "true" || Boolean(decoded.firebase?.sign_in_second_factor);
  return { uid: decoded.uid, admin: admin?.status === "ACTIVE" && admin.role === "SUPER_ADMIN" && mfa, recent: Date.now() / 1000 - decoded.auth_time >= 0 && Date.now() / 1000 - decoded.auth_time < 300 };
}
async function admin(actor: Actor, path: string, input: Record<string, unknown>): Promise<unknown> {
  if (path === "POST /admin/organizations") return engine.createBusiness(actor, { name: text(input.name), email: text(input.email, 254) });
  if (path === "POST /admin/license") return engine.modify(actor, validId(input.licenseId), input.patch as Parameters<LicenseEngine["modify"]>[2]);
  if (path === "POST /admin/device") return engine.deviceStatus(actor, validId(input.deviceId), input.status as Parameters<LicenseEngine["deviceStatus"]>[2]);
  if (path === "POST /admin/access-request") return engine.resolveAccessRequest(actor, validId(input.requestId), input.approve === true);
  if (path === "POST /admin/free-accesses") return engine.grantAccesses(actor, validId(input.licenseId), validId(input.operationId));
  if (path === "POST /admin/key") return engine.rotateKey(actor, validId(input.licenseId), input.revoke === true);
  if (path === "POST /admin/payment") return engine.payment(actor, { licenseId: validId(input.licenseId), paymentId: validId(input.paymentId), amountCents: Number(input.amountCents) });
  if (path === "POST /admin/policy") {
    requireAdmin(actor, true);
    if (input.enforced === true && process.env.LICENSE_ENFORCEMENT_READY !== "true") throw new LicenseError("ROLLOUT_NOT_READY");
    return store.transaction(async tx => {
      const previous = await tx.get<LicensePolicy>("license_policy/current");
      if (typeof input.enforced !== "boolean") throw new LicenseError("INVALID_INPUT");
      tx.set("license_policy/current", { ...previous, enforced: input.enforced });
      tx.set(`license_audit/policy-${Date.now()}-${actor.uid}`, { adminUserId: actor.uid, action: "ROLLOUT_POLICY_CHANGED", before: { enforced: previous?.enforced === true }, after: { enforced: input.enforced }, timestamp: Date.now() }); return { ok: true };
    });
  }
  if (path === "GET /admin/organizations") {
    const rows = await db.collection("license_organizations").orderBy("createdAt", "desc").limit(100).get();
    return Promise.all(rows.docs.map(async (organization: QueryDocumentSnapshot) => {
      const data = organization.data(); const license = (await db.doc(`license_licenses/${data.licenseId}`).get()).data() as License;
      const { keyHash: _hash, ...publicLicense } = license;
      return { ...data, license: { ...publicLicense, status: effectiveStatus(license, Date.now()) } };
    }));
  }
  if (path === "POST /admin/details") {
    const id = validId(input.licenseId);
    const [devices, payments, audits] = await Promise.all([db.collection("license_devices").where("licenseId", "==", id).limit(1000).get(), db.collection("license_payments").where("licenseId", "==", id).limit(100).get(), db.collection("license_audit").where("licenseId", "==", id).limit(100).get()]);
    return { devices: devices.docs.map((doc: QueryDocumentSnapshot) => { const { tokenHash: _token, claimHash: _claim, ...data } = doc.data(); return data; }), payments: payments.docs.map((doc: QueryDocumentSnapshot) => doc.data()), audits: audits.docs.map((doc: QueryDocumentSnapshot) => doc.data()) };
  }
  if (path === "GET /admin/dashboard") {
    const licenses = db.collection("license_licenses");
    const onlineSince = new Date(Date.now() - PRESENCE_TTL_MS).toISOString();
    const [active, suspended, trials, devices, presence, pending, organizations, revenue] = await Promise.all([licenses.where("plan", "==", "business").where("status", "==", "ACTIVE").count().get(), licenses.where("status", "==", "SUSPENDED").count().get(), licenses.where("plan", "==", "free").count().get(), db.collection("license_devices").where("status", "==", "ACTIVE").count().get(), db.collection("devices").where("updatedAt", ">=", onlineSince).limit(1000).get(), db.collection("license_access_requests").where("status", "==", "PENDING").count().get(), db.collection("license_organizations").count().get(), db.collection("license_subscriptions").where("status", "==", "ACTIVE").aggregate({ amount: AggregateField.sum("amountCents") }).get()]);
    return { active: active.data().count, suspended: suspended.data().count, trials: trials.data().count, devices: devices.data().count, online: presence.docs.filter((row: QueryDocumentSnapshot) => row.data().status === "online").length, pendingRequests: pending.data().count, organizations: organizations.data().count, mrrCents: revenue.data().amount };
  }
  if (path === "GET /admin/access-requests") {
    const rows = await db.collection("license_access_requests").orderBy("createdAt", "desc").limit(200).get();
    return rows.docs.map((doc: QueryDocumentSnapshot) => doc.data() as LicenseAccessRequest);
  }
  if (path === "GET /admin/devices") {
    const rows = await db.collection("license_devices").orderBy("lastSeenAt", "desc").limit(200).get();
    const presence = rows.empty ? [] : await db.getAll(...rows.docs.map((row: QueryDocumentSnapshot) => db.doc(`devices/${(row.data() as LicenseDevice).nodusId}`)));
    return rows.docs.map((doc: QueryDocumentSnapshot, index: number) => {
      const { tokenHash: _token, claimHash: _claim, ...device } = doc.data() as LicenseDevice;
      const live = presence[index]?.data(), seenAt = Date.parse(String(live?.updatedAt ?? ""));
      const online = live?.status === "online" && Number.isFinite(seenAt) && Date.now() - seenAt < PRESENCE_TTL_MS;
      return { ...device, lastSeenAt: Number.isFinite(seenAt) ? Math.max(device.lastSeenAt, seenAt) : device.lastSeenAt, online };
    });
  }
  throw new LicenseError("INVALID_INPUT");
}
const origins = (process.env.LICENSE_ALLOWED_ORIGINS ?? "").split(",").map(value => value.trim()).filter(Boolean);
if (!origins.length || origins.includes("*")) throw new Error("LICENSE_ORIGINS_NOT_CONFIGURED");
export const licenseHandler = createLicenseHandler({ engine, store, authenticate, admin, origins, providers: paymentProviders, notifyAccessRequest });
// Authorization computes expiry immediately; this bounded sweep persists states for administrative aggregates.
let sweeping = false;
const startSweep = () => setInterval(async () => {
  if (sweeping) return; sweeping = true;
  try {
    const [due, expired] = await Promise.all([db.collection("license_licenses").where("status", "in", ["ACTIVE", "PAST_DUE"]).where("expiresAt", "<=", Date.now()).limit(200).get(), db.collection("license_licenses").where("status", "==", "GRACE_PERIOD").where("graceUntil", "<=", Date.now()).limit(200).get()]);
    for (const row of [...due.docs, ...expired.docs]) await store.transaction(async tx => {
      const license = await tx.get<License>(row.ref.path); if (!license) return;
      const status = effectiveStatus(license, Date.now()); const subscription = await tx.get<Record<string, unknown>>(`license_subscriptions/${license.id}`);
      if (status !== license.status) { tx.set(row.ref.path, { ...license, status, updatedAt: Date.now() }); if (subscription) tx.set(`license_subscriptions/${license.id}`, { ...subscription, status }); }
    });
  } catch { console.warn(JSON.stringify({ event: "LICENSE_SWEEP_FAILED", code: "SERVER_UNAVAILABLE" })); } finally { sweeping = false; }
}, 60_000);
if (!process.env.FUNCTION_TARGET && !process.env.VERCEL) {
  const sweep = startSweep(); sweep.unref();
  const server = createServer(licenseHandler);
  server.listen(Number(process.env.PORT ?? 8790), process.env.HOST ?? "127.0.0.1", () => console.log("Nodus License API ready"));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { clearInterval(sweep); server.close(); });
}
