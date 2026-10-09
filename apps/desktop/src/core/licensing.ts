import { LICENSE_MESSAGES, LicenseError, type LicenseInfo, type LicensePolicy } from "../../../../packages/licensing/src/index";
import { OfflineLeaseAnchor, verifyBrowserLease } from "../../../../packages/licensing/src/offline";
import { getDeviceAuthToken } from "./firebase";
import type { LocalIdentity } from "./identity";
import type { SupportDraft, SupportPermission } from "../../../../packages/common/src/quick-support";

const base = String(import.meta.env.VITE_NODUS_LICENSE_API ?? "").replace(/\/$/, "");
const pinnedKey = String(import.meta.env.VITE_NODUS_LICENSE_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");
type Credentials = { deviceId: string; deviceToken: string; identityVersion?: number };
let credentials: Credentials | null = null;
let credentialPromise: Promise<Credentials> | null = null;
const prepared = new Map<string, { sessionId: string; anchor: OfflineLeaseAnchor; deviceId: string }>();
type SessionLifecycle = { stopped: boolean; connected: boolean; enforced: boolean; timer?: ReturnType<typeof setTimeout>; confirmationTimer?: ReturnType<typeof setTimeout>; limitTimer?: ReturnType<typeof setTimeout>; deadline?: number };
const lifecycle = new Map<string, SessionLifecycle>();
const reserved = new Set<string>();
const offlineReserved = new Set<string>();
export function licenseConfigured() { return Boolean(base); }
export function licenseFeedback(error: unknown): string { return error instanceof LicenseError ? LICENSE_MESSAGES[error.code] : LICENSE_MESSAGES.SERVER_UNAVAILABLE; }
async function request<T>(path: string, body?: object, authenticated = true): Promise<T> {
  if (!base) throw new LicenseError("SERVER_UNAVAILABLE");
  const url = new URL(base); if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new LicenseError("SERVER_UNAVAILABLE");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new LicenseError("SERVER_UNAVAILABLE")); }, 8000); });
  try {
    const token = await Promise.race([authenticated ? getDeviceAuthToken() : Promise.resolve(""), expired]);
    const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, cache: "no-store" });
    const value = await response.json();
    if (!response.ok) throw new LicenseError(response.status === 404 ? "SERVER_UNAVAILABLE" : Object.hasOwn(LICENSE_MESSAGES, value.code) ? value.code : "SERVER_UNAVAILABLE");
    return value as T;
  } catch (error) { throw error instanceof LicenseError ? error : new LicenseError("SERVER_UNAVAILABLE"); } finally { clearTimeout(timer!); }
}
async function device(identity: LocalIdentity, force = false) {
  if (!force && credentials?.deviceId === identity.deviceId) return credentials;
  credentialPromise ??= (async () => {
    const saved = await window.nodusDesktop?.getLicenseCredentials();
    if (!force && saved?.deviceId === identity.deviceId && saved.identityVersion === 1) return credentials = saved;
    const policy = await request<LicensePolicy>("/license/policy", undefined, false);
    const collectIdentity = policy.identityEnabled || policy.identityEnrollmentEnabled;
    if (!force && saved?.deviceId === identity.deviceId && !collectIdentity) return credentials = saved;
    const licenseIdentity = collectIdentity ? await window.nodusDesktop?.getLicenseIdentity() : undefined;
    const enrolled = await request<Credentials>("/license/enroll", { deviceId: identity.deviceId, nodusId: identity.nodusId.replace(/\D/g, ""), deviceName: identity.deviceName, deviceClaim: identity.deviceClaim, ...(saved?.deviceId === identity.deviceId ? { previousDeviceToken: saved.deviceToken } : {}), ...(licenseIdentity ? { licenseIdentity } : {}) });
    if (enrolled.deviceId !== identity.deviceId || !/^[A-Za-z0-9_-]{40,128}$/.test(enrolled.deviceToken)) throw new LicenseError("SERVER_UNAVAILABLE");
    if (!await window.nodusDesktop?.saveLicenseCredentials(enrolled)) throw new LicenseError("SERVER_UNAVAILABLE");
    return credentials = enrolled;
  })();
  try { const result = await credentialPromise; if (!result) throw new LicenseError("SERVER_UNAVAILABLE"); return result; } finally { credentialPromise = null; }
}
async function deviceRequest<T>(identity: LocalIdentity, path: string, body: object = {}): Promise<T> {
  try { return await request<T>(path, { ...await device(identity), ...body }); }
  catch (error) {
    if (!(error instanceof LicenseError) || error.code !== "UNAUTHORIZED") throw error;
    return request<T>(path, { ...await device(identity, true), ...body });
  }
}
export async function checkLicense(identity: LocalIdentity): Promise<LicenseInfo> {
  const info = await deviceRequest<LicenseInfo>(identity, "/license/check");
  if (typeof info.allowed !== "boolean" || typeof info.enforced !== "boolean" || !["free", "business"].includes(info.plan) || !Number.isSafeInteger(info.trialUsed) || !Number.isSafeInteger(info.trialLimit)) throw new LicenseError("SERVER_UNAVAILABLE");
  return info;
}
export async function activateLicense(identity: LocalIdentity, key: string) { await deviceRequest(identity, "/license/activate", { key }); return checkLicense(identity); }
export async function requestMoreAccesses(identity: LocalIdentity) { return deviceRequest<{ requestId: string; duplicate: boolean; notificationStatus: "PENDING" | "SENT" | "FAILED" }>(identity, "/license/access-requests"); }
export async function createSupportProfile(identity: LocalIdentity, profile: SupportDraft) {
  return deviceRequest<{ token: string; template: { version: string; sha256: string } | null }>(identity, "/license/support/profiles", { profile });
}
export async function supportAdmission(profileId: string, sessionId: string, targetNodusId: string, requesterNodusId: string) {
  return request<{ permissions: SupportPermission[]; confirmation: boolean }>("/license/support/admit", { profileId, sessionId, targetNodusId, requesterNodusId });
}
export async function prepareOfflineLicense(identity: LocalIdentity, targetNodusId: string) {
  if (!pinnedKey) throw new LicenseError("INVALID_LICENSE");
  const info = await checkLicense(identity); if (info.plan !== "business") throw new LicenseError("FORBIDDEN");
  const sessionId = crypto.randomUUID();
  const reservation = await deviceRequest<{ lease: string; serverTime: number }>(identity, "/license/sessions/reserve", { sessionId, targetNodusId, offline: true, eventDriven: true });
  const claims = await verifyBrowserLease(reservation.lease, pinnedKey);
  if (claims.targetNodusId !== targetNodusId || claims.exp - claims.iat > 24 * 3600000 || !Number.isFinite(reservation.serverTime)) throw new LicenseError("INVALID_LICENSE");
  const anchor = new OfflineLeaseAnchor(claims, reservation.serverTime);
  if (!anchor.valid(sessionId, identity.deviceId)) throw new LicenseError("INVALID_LICENSE");
  prepared.set(targetNodusId, { sessionId, anchor, deviceId: identity.deviceId });
  return sessionId;
}
export async function reserveLicense(identity: LocalIdentity, targetNodusId: string, supportProfileId?: string, supportPassword?: string): Promise<string | undefined> {
  if (!licenseConfigured()) { if (supportProfileId) throw new LicenseError("SERVER_UNAVAILABLE"); return; }
  const offline = prepared.get(targetNodusId);
  if (!supportProfileId && offline?.anchor.valid(offline.sessionId, identity.deviceId)) { prepared.delete(targetNodusId); reserved.add(offline.sessionId); offlineReserved.add(offline.sessionId); return offline.sessionId; }
  prepared.delete(targetNodusId);
  const sessionId = crypto.randomUUID();
  const reservation = await deviceRequest<{ sessionId: string }>(identity, "/license/sessions/reserve", { sessionId, targetNodusId, eventDriven: true, ...(supportProfileId ? { supportProfileId, supportPassword } : {}) });
  if (reservation.sessionId !== sessionId) throw new LicenseError("SERVER_UNAVAILABLE"); reserved.add(sessionId); return sessionId;
}
export async function licenseEstablished(sessionId: string, onRejected?: (code: string) => void) {
  if (!licenseConfigured() || lifecycle.has(sessionId)) return;
  const state: SessionLifecycle = { stopped: false, connected: false, enforced: reserved.has(sessionId) };
  lifecycle.set(sessionId, state);
  function reject(code: string) {
    if (state.stopped) return;
    state.stopped = true;
    clearTimeout(state.timer); clearTimeout(state.confirmationTimer); clearTimeout(state.limitTimer);
    onRejected?.(code);
    lifecycle.delete(sessionId);
  }
  if (state.enforced && !offlineReserved.has(sessionId)) state.confirmationTimer = setTimeout(() => reject("SERVER_UNAVAILABLE"), 120_000);
  async function publish() {
    let delay = 30_000;
    try {
      const establishing = !state.connected;
      const started = performance.now();
      const result = await request<{ status: string; endsAt?: number; serverTime?: number; eventDriven?: boolean }>(`/license/sessions/${establishing ? "establish" : "heartbeat"}`, { sessionId });
      if (state.stopped) return;
      clearTimeout(state.confirmationTimer);
      state.enforced = true;
      state.connected = result.status === "ESTABLISHED";
      if (Number.isSafeInteger(result.endsAt) && result.endsAt! > 0 && Number.isSafeInteger(result.serverTime)) {
        const deadline = started + Math.max(0, result.endsAt! - result.serverTime!);
        if (state.deadline === undefined || deadline < state.deadline) {
          state.deadline = deadline;
          clearTimeout(state.limitTimer);
          state.limitTimer = setTimeout(() => reject("FREE_SESSION_LIMIT_REACHED"), Math.max(0, deadline - performance.now()));
        }
      }
      if (establishing) window.dispatchEvent(new Event("nodus:license-changed"));
      if (result.eventDriven) delay = 0;
    } catch (error) {
      if (!state.enforced && error instanceof LicenseError && error.code === "FORBIDDEN") { state.stopped = true; lifecycle.delete(sessionId); return; }
      if (!state.stopped && error instanceof LicenseError && ["DEVICE_REVOKED", "SESSION_EXPIRED"].includes(error.code)) {
        reject(error.code);
      }
      // Temporary licensing outages do not interrupt existing video sessions.
    }
    finally { if (!state.stopped && delay) state.timer = setTimeout(publish, delay); }
  }
  await publish();
}
export function licenseEnded(sessionId: string) {
  const state = lifecycle.get(sessionId);
  if (state) { state.stopped = true; clearTimeout(state.timer); clearTimeout(state.confirmationTimer); clearTimeout(state.limitTimer); lifecycle.delete(sessionId); }
  offlineReserved.delete(sessionId);
  const wasReserved = reserved.delete(sessionId);
  if (licenseConfigured() && (state?.enforced || wasReserved)) request("/license/sessions/end", { sessionId }).catch(() => undefined);
  if (typeof window !== "undefined" && window.dispatchEvent) window.dispatchEvent(new Event("nodus:license-changed"));
}
export async function relayLicenseHeaders(): Promise<Record<string, string>> { return licenseConfigured() ? { "x-nodus-license-identity": await getDeviceAuthToken() } : {}; }
