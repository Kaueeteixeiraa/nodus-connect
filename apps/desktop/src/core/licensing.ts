import { LICENSE_MESSAGES, LicenseError, type LicenseInfo, type LicensePolicy } from "../../../../packages/licensing/src/index";
import { OfflineLeaseAnchor, verifyBrowserLease } from "../../../../packages/licensing/src/offline";
import { getDeviceAuthToken } from "./firebase";
import type { LocalIdentity } from "./identity";
import type { SupportDraft, SupportPermission } from "../../../../packages/common/src/quick-support";

const base = String(import.meta.env.VITE_NODUS_LICENSE_API ?? "").replace(/\/$/, "");
const pinnedKey = String(import.meta.env.VITE_NODUS_LICENSE_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");
type Credentials = { deviceId: string; deviceToken: string };
let credentials: Credentials | null = null;
let credentialPromise: Promise<Credentials> | null = null;
const prepared = new Map<string, { sessionId: string; anchor: OfflineLeaseAnchor; deviceId: string }>();
const lifecycle = new Map<string, { stopped: boolean; connected: boolean; enforced: boolean; timer?: ReturnType<typeof setTimeout> }>();
const reserved = new Set<string>();
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
async function device(identity: LocalIdentity) {
  if (credentials?.deviceId === identity.deviceId) return credentials;
  credentialPromise ??= (async () => {
    const saved = await window.nodusDesktop?.getLicenseCredentials();
    if (saved?.deviceId === identity.deviceId) return credentials = saved;
    const enrolled = await request<Credentials>("/license/enroll", { deviceId: identity.deviceId, nodusId: identity.nodusId.replace(/\D/g, ""), deviceName: identity.deviceName, deviceClaim: identity.deviceClaim });
    if (enrolled.deviceId !== identity.deviceId || !/^[A-Za-z0-9_-]{40,128}$/.test(enrolled.deviceToken)) throw new LicenseError("SERVER_UNAVAILABLE");
    if (!await window.nodusDesktop?.saveLicenseCredentials(enrolled)) throw new LicenseError("SERVER_UNAVAILABLE");
    return credentials = enrolled;
  })();
  try { const result = await credentialPromise; if (!result) throw new LicenseError("SERVER_UNAVAILABLE"); return result; } finally { credentialPromise = null; }
}
export async function checkLicense(identity: LocalIdentity): Promise<LicenseInfo> {
  const info = await request<LicenseInfo>("/license/check", await device(identity));
  if (typeof info.allowed !== "boolean" || typeof info.enforced !== "boolean" || !["free", "business"].includes(info.plan) || !Number.isSafeInteger(info.trialUsed) || !Number.isSafeInteger(info.trialLimit)) throw new LicenseError("SERVER_UNAVAILABLE");
  return info;
}
export async function activateLicense(identity: LocalIdentity, key: string) { await request("/license/activate", { ...await device(identity), key }); return checkLicense(identity); }
export async function requestMoreAccesses(identity: LocalIdentity) { return request<{ requestId: string; duplicate: boolean; notificationStatus: "PENDING" | "SENT" | "FAILED" }>("/license/access-requests", await device(identity)); }
export async function createSupportProfile(identity: LocalIdentity, profile: SupportDraft) {
  return request<{ token: string; template: { version: string; sha256: string } | null }>("/license/support/profiles", { ...await device(identity), profile });
}
export async function supportAdmission(profileId: string, sessionId: string, targetNodusId: string, requesterNodusId: string) {
  return request<{ permissions: SupportPermission[]; confirmation: boolean }>("/license/support/admit", { profileId, sessionId, targetNodusId, requesterNodusId });
}
export async function prepareOfflineLicense(identity: LocalIdentity, targetNodusId: string) {
  if (!pinnedKey) throw new LicenseError("INVALID_LICENSE");
  const info = await checkLicense(identity); if (info.plan !== "business") throw new LicenseError("FORBIDDEN");
  const sessionId = crypto.randomUUID();
  const reservation = await request<{ lease: string; serverTime: number }>("/license/sessions/reserve", { ...await device(identity), sessionId, targetNodusId, offline: true });
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
  if (!supportProfileId && offline?.anchor.valid(offline.sessionId, identity.deviceId)) { prepared.delete(targetNodusId); reserved.add(offline.sessionId); return offline.sessionId; }
  prepared.delete(targetNodusId);
  const info = await checkLicense(identity);
  if (info.code === "DEVICE_REVOKED") throw new LicenseError("DEVICE_REVOKED");
  const policy = await request<LicensePolicy>("/license/policy", undefined, false);
  if (typeof policy.enforced !== "boolean") throw new LicenseError("SERVER_UNAVAILABLE");
  const sessionId = crypto.randomUUID();
  const reservation = await request<{ sessionId: string }>("/license/sessions/reserve", { ...await device(identity), sessionId, targetNodusId, ...(supportProfileId ? { supportProfileId, supportPassword } : {}) });
  if (reservation.sessionId !== sessionId) throw new LicenseError("SERVER_UNAVAILABLE"); reserved.add(sessionId); return sessionId;
}
export async function licenseEstablished(sessionId: string, onRejected?: (code: string) => void) {
  if (!licenseConfigured() || lifecycle.has(sessionId)) return;
  const state = { stopped: false, connected: false, enforced: reserved.has(sessionId), timer: undefined as ReturnType<typeof setTimeout> | undefined };
  lifecycle.set(sessionId, state);
  async function publish() {
    let delay = 30_000;
    try {
      const policy = await request<LicensePolicy>("/license/policy", undefined, false);
      if (state.stopped) return;
      if (Number.isSafeInteger(policy.heartbeatSeconds) && policy.heartbeatSeconds >= 5 && policy.heartbeatSeconds <= 120) delay = policy.heartbeatSeconds * 1000;
      const establishing = !state.connected;
      const result = await request<{ status: string }>(`/license/sessions/${establishing ? "establish" : "heartbeat"}`, { sessionId });
      if (state.stopped) return;
      state.enforced = true;
      state.connected = result.status === "ESTABLISHED";
      if (establishing) window.dispatchEvent(new Event("nodus:license-changed"));
    } catch (error) {
      if (!state.enforced && error instanceof LicenseError && error.code === "FORBIDDEN") { state.stopped = true; lifecycle.delete(sessionId); return; }
      if (!state.stopped && error instanceof LicenseError && ["DEVICE_REVOKED", "SESSION_EXPIRED"].includes(error.code)) {
        state.stopped = true;
        onRejected?.(error.code);
        lifecycle.delete(sessionId);
      }
      // Temporary licensing outages do not interrupt existing video sessions.
    }
    finally { if (!state.stopped) state.timer = setTimeout(publish, delay); }
  }
  await publish();
}
export function licenseEnded(sessionId: string) {
  const state = lifecycle.get(sessionId);
  if (state) { state.stopped = true; clearTimeout(state.timer); lifecycle.delete(sessionId); }
  const wasReserved = reserved.delete(sessionId);
  if (licenseConfigured() && (state?.enforced || wasReserved)) request("/license/sessions/end", { sessionId }).catch(() => undefined);
}
export async function relayLicenseHeaders(): Promise<Record<string, string>> { return licenseConfigured() ? { "x-nodus-license-identity": await getDeviceAuthToken() } : {}; }
