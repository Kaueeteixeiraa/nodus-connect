import { randomUUID } from "node:crypto";
import support from "../../../apps/desktop/electron/quick-support.cjs";
import desktopUpdates from "../../../apps/desktop/electron/desktop-update.cjs";
import type { DesktopUpdatePolicy } from "../../../packages/licensing/src/index.js";
import type { SupportDraft, SupportProfile } from "../../../packages/common/src/quick-support.js";
import { LICENSE_DEFAULTS, LicenseError, effectiveStatus, licenseCode, type License, type LicenseAccessRequest, type LicenseDevice, type LicenseInfo, type LicensePolicy, type LicenseSession } from "../../../packages/licensing/src/index.js";
import type { LicenseStore, LicenseTransaction } from "./store.js";
import { matchesSecret, newDeviceToken, newLicenseKey, secretHash, signLease } from "./security.js";

export interface Actor { uid: string; admin?: boolean; recent?: boolean; ip?: string; }
export interface DeviceCredentials { deviceId: string; deviceToken: string; }
type Claim = { ownerUid: string; deviceId: string; deviceClaim: string; };
const DAY = 86_400_000;
type SupportSession = LicenseSession & { supportProfileId?: string };
export function validId(value: unknown): string { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new LicenseError("INVALID_INPUT"); return value; }
export function text(value: unknown, max = 120): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new LicenseError("INVALID_INPUT"); return value.trim(); }
export function requireAdmin(actor: Actor, sensitive = false): void { if (!actor.admin) throw new LicenseError("FORBIDDEN"); if (sensitive && !actor.recent) throw new LicenseError("REAUTH_REQUIRED"); }
function activeSlots(license: License, now: number) { return Object.entries(license.slots).filter(([, slot]) => slot.established || slot.expiresAt > now); }
function requireCapacity(license: License, now: number, enforced = true) {
  const code = licenseCode(license, now); if (code !== "LICENSE_ACTIVE" && (enforced || code !== "TRIAL_LIMIT_REACHED")) throw new LicenseError(code);
  const slots = activeSlots(license, now);
  if (license.plan === "free") {
    if (enforced && license.trialUsed + slots.filter(([, slot]) => !slot.established).length >= license.trialLimit) throw new LicenseError("TRIAL_LIMIT_REACHED");
  } else {
    if (slots.some(([, slot]) => slot.established && slot.expiresAt <= now)) throw new LicenseError("SESSION_RECONCILIATION_REQUIRED");
    if (slots.length >= license.maxConcurrentSessions) throw new LicenseError("CONCURRENT_LIMIT_REACHED");
  }
}
function audit(tx: LicenseTransaction, actor: Actor, action: string, licenseId: string, before: object | null, after: object, now: number) {
  tx.set(`license_audit/${randomUUID()}`, { adminUserId: actor.uid, action, licenseId, before, after, timestamp: now, ip: actor.ip ?? "" });
}

export class LicenseEngine {
  private desktopUpdateCache?: { expiresAt: number; value: Promise<DesktopUpdatePolicy> };
  private desktopReleasesCache?: { expiresAt: number; value: Promise<string[]> };
  constructor(private readonly store: LicenseStore, private readonly pepper: string, private readonly signingKey: string, private readonly now = () => Date.now()) { secretHash("configuration-check", pepper); }

  async desktopReleases(actor: Actor, fetchReleases = fetch): Promise<string[]> {
    requireAdmin(actor);
    if (this.desktopReleasesCache && this.desktopReleasesCache.expiresAt > this.now()) return this.desktopReleasesCache.value;
    const value = (async () => {
      try {
        const response = await fetchReleases("https://api.github.com/repos/Kaueeteixeiraa/nodus-connect/releases?per_page=100", { headers: { Accept: "application/vnd.github+json", "User-Agent": "Nodus-Connect" }, signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error("RELEASES_UNAVAILABLE");
        const releases = await response.json();
        if (!Array.isArray(releases)) throw new Error("INVALID_RELEASES");
        const versions = new Set<string>();
        for (const release of releases) {
          try { const update = desktopUpdates.updateRelease(release, "0.0.0"); if (update.available) versions.add(update.version); } catch { /* Ignore releases without a verified stable installer. */ }
        }
        return [...versions].sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
      } catch { throw new LicenseError("SERVER_UNAVAILABLE"); }
    })();
    const entry = { expiresAt: this.now() + 60_000, value };
    this.desktopReleasesCache = entry;
    value.catch(() => { if (this.desktopReleasesCache === entry) this.desktopReleasesCache = undefined; });
    return value;
  }

  async desktopUpdatePolicy(cached = false): Promise<DesktopUpdatePolicy> {
    if (cached && this.desktopUpdateCache && this.desktopUpdateCache.expiresAt > this.now()) return this.desktopUpdateCache.value;
    const value = this.store.transaction(async tx => await tx.get<DesktopUpdatePolicy>("license_desktop_updates/current") ?? { enabled: false, release: null, updatedAt: 0 }, { readOnly: true });
    if (cached) {
      const entry = { expiresAt: this.now() + 60_000, value };
      this.desktopUpdateCache = entry;
      value.catch(() => { if (this.desktopUpdateCache === entry) this.desktopUpdateCache = undefined; });
    }
    return value;
  }

  async signedDesktopUpdate() {
    return { token: desktopUpdates.signPolicy(await this.desktopUpdatePolicy(true), this.signingKey, this.now()) };
  }

  async publishDesktopUpdate(actor: Actor, enabled: unknown, version: unknown, fetchRelease = fetch): Promise<DesktopUpdatePolicy> {
    requireAdmin(actor, true);
    if (typeof enabled !== "boolean" || (enabled && (typeof version !== "string" || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(version)))) throw new LicenseError("INVALID_INPUT");
    let release: DesktopUpdatePolicy["release"] = null;
    if (enabled) {
      const response = await fetchRelease(`https://api.github.com/repos/Kaueeteixeiraa/nodus-connect/releases/tags/v${version}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Nodus-Connect" }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new LicenseError("INVALID_INPUT");
      const published = await response.json();
      let update;
      try { update = desktopUpdates.updateRelease(published, "0.0.0"); } catch { throw new LicenseError("INVALID_INPUT"); }
      if (update.version !== version || !update.available) throw new LicenseError("INVALID_INPUT");
      release = { tag_name: `v${version}`, assets: [{ name: `Nodus-Connect-Setup-${version}.exe`, browser_download_url: update.url, digest: `sha256:${update.sha256}`, size: update.size }] };
    }
    const policy = await this.store.transaction(async tx => {
      const before = await tx.get<DesktopUpdatePolicy>("license_desktop_updates/current"), now = this.now();
      const next = { enabled, release: release ?? before?.release ?? null, updatedAt: now };
      tx.set("license_desktop_updates/current", next);
      audit(tx, actor, "DESKTOP_UPDATE_CHANGED", "desktop-update", before, next, now);
      return next;
    });
    this.desktopUpdateCache = undefined;
    return policy;
  }

  async policy(): Promise<LicensePolicy> { return this.store.transaction(tx => this.readPolicy(tx)); }
  private async readPolicy(tx: LicenseTransaction): Promise<LicensePolicy> {
    const stored = await tx.get<Partial<LicensePolicy>>("license_policy/current");
    const policy: LicensePolicy = { ...LICENSE_DEFAULTS, enforced: stored?.enforced === true };
    for (const key of Object.keys(LICENSE_DEFAULTS) as Array<keyof typeof LICENSE_DEFAULTS>) {
      const value = stored?.[key]; if (value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= (key === "businessPriceCents" ? 100_000_000 : 1000)) policy[key] = value;
    }
    return policy;
  }
  private async device(tx: LicenseTransaction, actor: Actor, credentials: DeviceCredentials): Promise<LicenseDevice> {
    const device = await tx.get<LicenseDevice>(`license_devices/${validId(credentials.deviceId)}`);
    if (!device || device.uid !== actor.uid || typeof credentials.deviceToken !== "string" || !matchesSecret(credentials.deviceToken, device.tokenHash, this.pepper)) throw new LicenseError("UNAUTHORIZED");
    return device;
  }
  private async license(tx: LicenseTransaction, id: string): Promise<License> { const license = await tx.get<License>(`license_licenses/${validId(id)}`); if (!license) throw new LicenseError("INVALID_LICENSE"); return license; }

  async enroll(actor: Actor, input: { deviceId: string; nodusId: string; deviceName: string; deviceClaim: string }) {
    validId(input.deviceId); if (!/^\d{9}$/.test(input.nodusId)) throw new LicenseError("INVALID_INPUT"); text(input.deviceName); text(input.deviceClaim, 128);
    const deviceToken = newDeviceToken(); const now = this.now();
    return this.store.transaction(async tx => {
      const claim = await tx.get<Claim>(`deviceClaims/${input.nodusId}`);
      if (!claim || claim.ownerUid !== actor.uid || claim.deviceId !== input.deviceId || claim.deviceClaim !== input.deviceClaim) throw new LicenseError("FORBIDDEN");
      const existing = await tx.get<LicenseDevice>(`license_devices/${input.deviceId}`);
      if (existing && (!matchesSecret(input.deviceClaim, existing.claimHash, this.pepper) || existing.nodusId !== input.nodusId)) throw new LicenseError("FORBIDDEN");
      if (existing && existing.status !== "ACTIVE") throw new LicenseError("DEVICE_REVOKED");
      const policy = await this.readPolicy(tx); const id = existing?.licenseId ?? `free-${input.deviceId}`;
      const oldLicense = await tx.get<License>(`license_licenses/${id}`);
      if (!oldLicense) tx.set(`license_licenses/${id}`, { id, organizationId: "", plan: "free", status: "TRIAL", maxDevices: 1, maxConcurrentSessions: policy.freeAccessLimit, trialLimit: policy.freeAccessLimit, trialUsed: 0, expiresAt: 0, graceUntil: 0, deviceIds: [input.deviceId], slots: {}, keyLast4: "", keyHash: "", keyRevoked: false, createdAt: now, updatedAt: now } satisfies License);
      tx.set(`license_devices/${input.deviceId}`, { id: input.deviceId, licenseId: id, uid: actor.uid, nodusId: input.nodusId, deviceName: input.deviceName.trim(), claimHash: secretHash(input.deviceClaim, this.pepper), tokenHash: secretHash(deviceToken, this.pepper), status: "ACTIVE", activatedAt: existing?.activatedAt ?? now, lastSeenAt: now } satisfies LicenseDevice);
      return { deviceId: input.deviceId, deviceToken };
    });
  }

  async info(actor: Actor, credentials: DeviceCredentials): Promise<LicenseInfo> {
    return this.store.transaction(async tx => {
      const device = await this.device(tx, actor, credentials); const license = await this.license(tx, device.licenseId); const policy = await this.readPolicy(tx);
      const organization = license.organizationId ? await tx.get<{ name: string }>(`license_organizations/${license.organizationId}`) : null;
      const now = this.now(); const code = device.status !== "ACTIVE" ? "DEVICE_REVOKED" : licenseCode(license, now);
      return { allowed: code === "LICENSE_ACTIVE", code, enforced: policy.enforced, plan: license.plan, status: effectiveStatus(license, now), organization: organization?.name ?? "", trialUsed: license.trialUsed, trialLimit: license.trialLimit, devices: license.deviceIds.length, maxDevices: license.maxDevices, sessions: activeSlots(license, now).length, maxConcurrentSessions: license.maxConcurrentSessions, expiresAt: license.expiresAt, keyMasked: license.keyLast4 ? `NODUS-••••-••••-${license.keyLast4}` : "", serverTime: now };
    }, { readOnly: true });
  }

  async requestAccesses(actor: Actor, credentials: DeviceCredentials) {
    const now = this.now();
    return this.store.transaction(async tx => {
      const device = await this.device(tx, actor, credentials); if (device.status !== "ACTIVE") throw new LicenseError("DEVICE_REVOKED");
      const license = await this.license(tx, device.licenseId); if (license.plan !== "free") throw new LicenseError("FORBIDDEN");
      const pointerPath = `license_access_request_pending/${license.id}`;
      const pointer = await tx.get<{ requestId: string }>(pointerPath);
      const pending = pointer ? await tx.get<LicenseAccessRequest>(`license_access_requests/${pointer.requestId}`) : null;
      if (pending?.status === "PENDING") return { request: pending, duplicate: true };
      const request: LicenseAccessRequest = { id: randomUUID(), licenseId: license.id, deviceId: device.id, uid: actor.uid, amount: LICENSE_DEFAULTS.freeAccessLimit, status: "PENDING", notificationStatus: "PENDING", createdAt: now, updatedAt: now, resolvedAt: 0, adminUserId: "" };
      tx.set(`license_access_requests/${request.id}`, request); tx.set(pointerPath, { requestId: request.id });
      audit(tx, actor, "ACCESS_INCREASE_REQUESTED", license.id, null, { requestId: request.id, amount: request.amount }, now);
      return { request, duplicate: false };
    });
  }

  async resolveAccessRequest(actor: Actor, requestId: string, approve: boolean) {
    requireAdmin(actor, true); validId(requestId); const now = this.now();
    return this.store.transaction(async tx => {
      const request = await tx.get<LicenseAccessRequest>(`license_access_requests/${requestId}`); if (!request) throw new LicenseError("INVALID_INPUT");
      if (request.status !== "PENDING") return { ok: true, duplicate: true, status: request.status };
      const license = await this.license(tx, request.licenseId); if (license.plan !== "free") throw new LicenseError("FORBIDDEN");
      if (approve) tx.set(`license_licenses/${license.id}`, { ...license, trialLimit: license.trialLimit + request.amount, updatedAt: now });
      const status = approve ? "APPROVED" : "DENIED";
      tx.set(`license_access_requests/${request.id}`, { ...request, status, updatedAt: now, resolvedAt: now, adminUserId: actor.uid });
      tx.set(`license_access_request_pending/${license.id}`, { requestId: request.id, status });
      audit(tx, actor, approve ? "ACCESS_INCREASE_APPROVED" : "ACCESS_INCREASE_DENIED", license.id, { trialLimit: license.trialLimit }, { requestId: request.id, amount: request.amount, trialLimit: approve ? license.trialLimit + request.amount : license.trialLimit }, now);
      return { ok: true, duplicate: false, status, trialLimit: approve ? license.trialLimit + request.amount : license.trialLimit };
    });
  }

  async grantAccesses(actor: Actor, licenseId: string, operationId: string) {
    requireAdmin(actor, true); validId(operationId); const now = this.now();
    return this.store.transaction(async tx => {
      const operationPath = `license_admin_operations/${operationId}`;
      const previous = await tx.get<{ uid: string; licenseId: string; trialLimit: number }>(operationPath);
      if (previous) {
        if (previous.uid !== actor.uid || previous.licenseId !== licenseId) throw new LicenseError("FORBIDDEN");
        return { ok: true, duplicate: true, trialLimit: previous.trialLimit };
      }
      const license = await this.license(tx, licenseId); if (license.plan !== "free") throw new LicenseError("FORBIDDEN");
      const trialLimit = license.trialLimit + LICENSE_DEFAULTS.freeAccessLimit;
      tx.set(`license_licenses/${license.id}`, { ...license, trialLimit, updatedAt: now });
      tx.set(operationPath, { uid: actor.uid, licenseId, trialLimit });
      audit(tx, actor, "ACCESS_INCREASE_GRANTED", license.id, { trialLimit: license.trialLimit }, { amount: LICENSE_DEFAULTS.freeAccessLimit, trialLimit }, now);
      return { ok: true, duplicate: false, trialLimit };
    });
  }

  async createBusiness(actor: Actor, input: { name: string; email: string }) {
    requireAdmin(actor, true); text(input.name); text(input.email, 254); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new LicenseError("INVALID_INPUT");
    const organizationId = randomUUID(), licenseId = randomUUID(), key = newLicenseKey(); const now = this.now();
    return this.store.transaction(async tx => {
      const policy = await this.readPolicy(tx); const hash = secretHash(key, this.pepper);
      const license: License = { id: licenseId, organizationId, plan: "business", status: "SUSPENDED", maxDevices: policy.maxDevices, maxConcurrentSessions: policy.maxConcurrentSessions, trialLimit: 0, trialUsed: 0, expiresAt: now, graceUntil: now, deviceIds: [], slots: {}, keyHash: hash, keyLast4: key.slice(-4), keyRevoked: false, createdAt: now, updatedAt: now };
      tx.set(`license_organizations/${organizationId}`, { id: organizationId, name: input.name.trim(), email: input.email.trim(), status: "ACTIVE", licenseId, createdAt: now, updatedAt: now });
      tx.set(`license_licenses/${licenseId}`, license); tx.set(`license_keys/${hash}`, { licenseId, active: true });
      tx.set(`license_subscriptions/${licenseId}`, { organizationId, licenseId, amountCents: policy.businessPriceCents, currency: "BRL", billingCycle: "monthly", status: "SUSPENDED", currentPeriodStart: now, currentPeriodEnd: now, paymentProvider: "manual" });
      audit(tx, actor, "LICENSE_CREATED", licenseId, null, { organizationId, status: license.status }, now);
      return { organizationId, licenseId, key };
    });
  }

  async activate(actor: Actor, credentials: DeviceCredentials, keyInput: string) {
    const key = text(keyInput, 128).toUpperCase(); const now = this.now();
    return this.store.transaction(async tx => {
      const device = await this.device(tx, actor, credentials); if (device.status !== "ACTIVE") throw new LicenseError("DEVICE_REVOKED");
      const index = await tx.get<{ licenseId: string; active: boolean }>(`license_keys/${secretHash(key, this.pepper)}`);
      if (!index?.active) throw new LicenseError("INVALID_LICENSE");
      const license = await this.license(tx, index.licenseId); const previous = await this.license(tx, device.licenseId);
      const code = licenseCode(license, now); if (code !== "LICENSE_ACTIVE") throw new LicenseError(code);
      if (previous.id === license.id) return { ok: true };
      if (previous.plan === "business" && previous.id !== license.id) throw new LicenseError("FORBIDDEN");
      if (activeSlots(previous, now).some(([, slot]) => slot.deviceId === device.id)) throw new LicenseError("CONCURRENT_LIMIT_REACHED");
      if (!license.deviceIds.includes(device.id) && license.deviceIds.length >= license.maxDevices) throw new LicenseError("DEVICE_LIMIT_REACHED");
      license.deviceIds = [...new Set([...license.deviceIds, device.id])]; license.updatedAt = now;
      tx.set(`license_licenses/${license.id}`, license); tx.set(`license_devices/${device.id}`, { ...device, licenseId: license.id, activatedAt: now, lastSeenAt: now });
      audit(tx, actor, "DEVICE_ACTIVATED", license.id, null, { deviceId: device.id }, now);
      return { ok: true };
    });
  }

  async createSupportProfile(actor: Actor, credentials: DeviceCredentials, draft: SupportDraft) {
    if (!draft || typeof draft.password !== "string" || draft.password.length < 3 || draft.password.length > 128) throw new LicenseError("INVALID_INPUT");
    const info = await this.info(actor, credentials);
    if (!info.allowed || info.plan !== "business") throw new LicenseError("FORBIDDEN");
    const verifier = await support.passwordVerifier(draft.password);
    return this.store.transaction(async tx => {
      const device = await this.device(tx, actor, credentials), license = await this.license(tx, device.licenseId);
      if (device.status !== "ACTIVE" || license.plan !== "business" || license.keyRevoked || licenseCode(license, this.now()) !== "LICENSE_ACTIVE") throw new LicenseError("FORBIDDEN");
      const profile: SupportProfile = { version: 1, id: randomUUID(), organizationId: license.organizationId, licenseId: license.id,
        name: text(draft.name, 80), company: text(draft.company, 120), message: draft.message ?? "", logo: draft.logo ?? "",
        permissions: draft.permissions, confirmation: draft.confirmation, passwordVerifier: verifier, createdAt: this.now() };
      if (process.env.NODUS_SUPPORT_TEMPLATE_SHA256 && process.env.NODUS_SUPPORT_TEMPLATE_VERSION) profile.template = { sha256: process.env.NODUS_SUPPORT_TEMPLATE_SHA256, version: process.env.NODUS_SUPPORT_TEMPLATE_VERSION };
      support.validateProfile(profile);
      const token: string = support.signProfile(profile, this.signingKey);
      tx.set(`license_support_profiles/${profile.id}`, { profile, token, revoked: false });
      return { token, template: process.env.NODUS_SUPPORT_TEMPLATE_SHA256 ? { sha256: process.env.NODUS_SUPPORT_TEMPLATE_SHA256, version: process.env.NODUS_SUPPORT_TEMPLATE_VERSION } : null };
    });
  }

  private async supportAuthentication(actor: Actor, credentials: DeviceCredentials, targetNodusId: string, password?: string): Promise<string | undefined> {
    const profile = await this.store.transaction(async tx => {
      const device = await this.device(tx, actor, credentials), license = await this.license(tx, device.licenseId);
      const target = await tx.get<{ supportProfileId?: string }>(`devices/${targetNodusId}`);
      if (!target?.supportProfileId) return null;
      const stored = await tx.get<{ profile: SupportProfile; revoked: boolean }>(`license_support_profiles/${validId(target.supportProfileId)}`);
      if (!stored || stored.revoked || device.status !== "ACTIVE" || license.plan !== "business" || license.keyRevoked
        || license.id !== stored.profile.licenseId || licenseCode(license, this.now()) !== "LICENSE_ACTIVE") throw new LicenseError("FORBIDDEN");
      if (!stored.profile.confirmation) {
        const path = `license_support_attempts/${stored.profile.id}-${targetNodusId}`, now = this.now();
        const old = await tx.get<{ startedAt: number; count: number }>(path);
        const attempts = old && now - old.startedAt < 60_000 ? old : { startedAt: now, count: 0 };
        if (attempts.count >= 5) throw new LicenseError("FORBIDDEN");
        tx.set(path, { ...attempts, count: attempts.count + 1 });
      }
      return stored.profile;
    });
    if (profile && !profile.confirmation && !await support.verifyPassword(password, profile.passwordVerifier)) throw new LicenseError("UNAUTHORIZED");
    return profile?.id;
  }

  async supportAdmission(actor: Actor, input: { profileId: string; sessionId: string; targetNodusId: string; requesterNodusId: string }) {
    return this.store.transaction(async tx => {
      const session = await tx.get<SupportSession>(`license_sessions/${validId(input.sessionId)}`);
      const stored = await tx.get<{ profile: SupportProfile; revoked: boolean }>(`license_support_profiles/${validId(input.profileId)}`);
      if (!session || !stored || stored.revoked || session.supportProfileId !== stored.profile.id || session.targetUid !== actor.uid
        || session.targetNodusId !== input.targetNodusId || session.requesterNodusId !== input.requesterNodusId
        || session.status !== "RESERVED" || session.expiresAt <= this.now()) throw new LicenseError("FORBIDDEN");
      const license = await this.license(tx, session.licenseId), device = await tx.get<LicenseDevice>(`license_devices/${session.deviceId}`);
      if (license.id !== stored.profile.licenseId || license.keyRevoked || licenseCode(license, this.now()) !== "LICENSE_ACTIVE" || device?.status !== "ACTIVE") throw new LicenseError("FORBIDDEN");
      return { permissions: stored.profile.permissions, confirmation: stored.profile.confirmation };
    }, { readOnly: true });
  }

  async reserve(actor: Actor, credentials: DeviceCredentials, input: { sessionId: string; targetNodusId: string; offline?: boolean; supportProfileId?: string; supportPassword?: string }) {
    validId(input.sessionId); if (!/^\d{9}$/.test(input.targetNodusId)) throw new LicenseError("INVALID_INPUT"); const now = this.now();
    const supportProfileId = input.supportProfileId ? await this.supportAuthentication(actor, credentials, input.targetNodusId, input.supportPassword) : undefined;
    if (input.supportProfileId && input.supportProfileId !== supportProfileId) throw new LicenseError("FORBIDDEN");
    return this.store.transaction(async tx => {
      const device = await this.device(tx, actor, credentials); if (device.status !== "ACTIVE") throw new LicenseError("DEVICE_REVOKED");
      const license = await this.license(tx, device.licenseId), policy = await this.readPolicy(tx);
      const target = await tx.get<{ ownerUid: string; nodusId: string; supportProfileId?: string }>(`devices/${input.targetNodusId}`);
      if (!target?.ownerUid || target.ownerUid === actor.uid || input.targetNodusId === device.nodusId) throw new LicenseError("INVALID_INPUT");
      if (target.supportProfileId !== supportProfileId || supportProfileId && input.offline) throw new LicenseError("FORBIDDEN");
      if (supportProfileId) {
        const stored = await tx.get<{ profile: SupportProfile; revoked: boolean }>(`license_support_profiles/${supportProfileId}`);
        if (!stored || stored.revoked || license.plan !== "business" || license.id !== stored.profile.licenseId || license.keyRevoked || licenseCode(license, now) !== "LICENSE_ACTIVE") throw new LicenseError("FORBIDDEN");
      }
      const existing = await tx.get<LicenseSession>(`license_sessions/${input.sessionId}`);
      if (existing) {
        if (existing.requesterUid !== actor.uid || existing.deviceId !== device.id || existing.targetNodusId !== input.targetNodusId || existing.status === "ENDED" || (existing.status === "RESERVED" && existing.expiresAt <= now)) throw new LicenseError("SESSION_EXPIRED");
        return this.reservation(existing, now);
      }
      requireCapacity(license, now, policy.enforced);
      const offline = input.offline === true && license.plan === "business";
      const expiresAt = offline ? Math.min(now + policy.offlineGraceHours * 3_600_000, license.graceUntil) : now + policy.reservationSeconds * 1000;
      if (expiresAt <= now) throw new LicenseError("LICENSE_EXPIRED");
      license.slots = Object.fromEntries(activeSlots(license, now)); license.slots[input.sessionId] = { deviceId: device.id, expiresAt, established: false, offline };
      const session: LicenseSession = { id: input.sessionId, licenseId: license.id, deviceId: device.id, requesterUid: actor.uid, targetUid: target.ownerUid, requesterNodusId: device.nodusId, targetNodusId: input.targetNodusId, status: "RESERVED", connectedUids: [], consumed: false, createdAt: now, establishedAt: 0, lastHeartbeatAt: now, endedAt: 0, expiresAt, offline };
      if (supportProfileId) (session as SupportSession).supportProfileId = supportProfileId;
      tx.set(`license_licenses/${license.id}`, license); tx.set(`license_sessions/${session.id}`, session);
      tx.set(`license_session_grants/${session.id}`, { sessionId: session.id, requesterUid: session.requesterUid, targetUid: session.targetUid, requesterNodusId: session.requesterNodusId, targetNodusId: session.targetNodusId, status: "RESERVED", expiresAt });
      return this.reservation(session, now);
    });
  }
  private reservation(session: LicenseSession, now: number) {
    const lease = signLease({ iss: "nodus-license", aud: "nodus-session", sessionId: session.id, deviceId: session.deviceId, requesterUid: session.requesterUid, targetUid: session.targetUid, requesterNodusId: session.requesterNodusId, targetNodusId: session.targetNodusId, iat: now, exp: session.expiresAt }, this.signingKey);
    return { sessionId: session.id, lease, expiresAt: session.expiresAt, offline: session.offline, serverTime: now };
  }

  async lifecycle(actor: Actor, id: string, action: "establish" | "heartbeat" | "end") {
    validId(id); const now = this.now();
    return this.store.transaction(async tx => {
      const session = await tx.get<LicenseSession>(`license_sessions/${id}`);
      if (!session || ![session.requesterUid, session.targetUid].includes(actor.uid)) throw new LicenseError("FORBIDDEN");
      const license = await this.license(tx, session.licenseId); const policy = await this.readPolicy(tx);
      if (session.status === "ENDED") { if (action === "end") return { ok: true, consumed: session.consumed }; throw new LicenseError("SESSION_EXPIRED"); }
      const slot = license.slots[id];
      if (action === "end") {
        session.status = "ENDED"; session.endedAt = now;
        // Offline leases cannot be returned early: their signed permission may still be in use.
        if (!session.offline) delete license.slots[id];
        else if (slot) slot.established = false;
      } else {
        const requester = await tx.get<LicenseDevice>(`license_devices/${session.deviceId}`);
        if (!requester || requester.status !== "ACTIVE") throw new LicenseError("DEVICE_REVOKED");
        if ((session as SupportSession).supportProfileId) {
          const stored = await tx.get<{ revoked: boolean }>(`license_support_profiles/${(session as SupportSession).supportProfileId}`);
          if (!stored || stored.revoked || license.keyRevoked || licenseCode(license, now) !== "LICENSE_ACTIVE") throw new LicenseError("SESSION_EXPIRED");
        }
        if (!slot || (session.status !== "ESTABLISHED" && session.expiresAt <= now)) throw new LicenseError("SESSION_EXPIRED");
        if (action === "establish") {
          session.connectedUids = [...new Set([...session.connectedUids, actor.uid])];
          if (session.connectedUids.length === 2 && session.status !== "ESTABLISHED") {
            session.status = "ESTABLISHED"; session.establishedAt = now; slot.established = true;
            if (license.plan === "free" && !session.consumed) { if (policy.enforced && license.trialUsed >= license.trialLimit) throw new LicenseError("TRIAL_LIMIT_REACHED"); license.trialUsed += 1; session.consumed = true; }
          }
        }
        if (session.status === "ESTABLISHED") {
          session.lastHeartbeatAt = now;
          if (!session.offline) { session.expiresAt = now + policy.reservationSeconds * 1000; slot.expiresAt = session.expiresAt; }
        }
      }
      license.updatedAt = now;
      tx.set(`license_sessions/${id}`, session); tx.set(`license_licenses/${license.id}`, license);
      tx.set(`license_session_grants/${id}`, { sessionId: id, requesterUid: session.requesterUid, targetUid: session.targetUid, requesterNodusId: session.requesterNodusId, targetNodusId: session.targetNodusId, status: session.status, expiresAt: session.expiresAt });
      return { ok: true, consumed: session.consumed, status: session.status };
    });
  }

  async modify(actor: Actor, licenseId: string, patch: { status?: License["status"]; maxDevices?: number; maxConcurrentSessions?: number; expiresAt?: number }) {
    requireAdmin(actor, true);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new LicenseError("INVALID_INPUT");
    for (const key of Object.keys(patch)) if (!["status", "maxDevices", "maxConcurrentSessions", "expiresAt"].includes(key)) throw new LicenseError("INVALID_INPUT");
    if (patch.status && !["ACTIVE", "PAST_DUE", "GRACE_PERIOD", "SUSPENDED", "CANCELED", "EXPIRED"].includes(patch.status)) throw new LicenseError("INVALID_INPUT");
    for (const limit of [patch.maxDevices, patch.maxConcurrentSessions]) if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) throw new LicenseError("INVALID_INPUT");
    if (patch.expiresAt !== undefined && (!Number.isSafeInteger(patch.expiresAt) || patch.expiresAt <= 0)) throw new LicenseError("INVALID_INPUT");
    return this.store.transaction(async tx => {
      const license = await this.license(tx, licenseId); if (license.plan !== "business") throw new LicenseError("FORBIDDEN"); const now = this.now(); const policy = await this.readPolicy(tx);
      const subscription = await tx.get<Record<string, unknown>>(`license_subscriptions/${licenseId}`);
      if ((patch.maxDevices ?? license.maxDevices) < license.deviceIds.length || (patch.maxConcurrentSessions ?? license.maxConcurrentSessions) < activeSlots(license, now).length) throw new LicenseError("INVALID_INPUT");
      const next = { ...license, ...patch, updatedAt: now, graceUntil: patch.expiresAt === undefined ? license.graceUntil : patch.expiresAt + policy.gracePeriodDays * DAY };
      tx.set(`license_licenses/${licenseId}`, next); audit(tx, actor, "LICENSE_UPDATED", licenseId, { status: license.status, maxDevices: license.maxDevices, maxConcurrentSessions: license.maxConcurrentSessions, expiresAt: license.expiresAt }, patch, now);
      if (subscription) tx.set(`license_subscriptions/${licenseId}`, { ...subscription, status: effectiveStatus(next, now), currentPeriodEnd: next.expiresAt });
      return { ok: true };
    });
  }
  async deviceStatus(actor: Actor, deviceId: string, status: LicenseDevice["status"]) {
    requireAdmin(actor, true); if (!["ACTIVE", "REVOKED", "BLOCKED"].includes(status)) throw new LicenseError("INVALID_INPUT");
    return this.store.transaction(async tx => {
      const device = await tx.get<LicenseDevice>(`license_devices/${validId(deviceId)}`); if (!device) throw new LicenseError("INVALID_INPUT"); const license = await this.license(tx, device.licenseId);
      if (status === "ACTIVE" && !license.deviceIds.includes(device.id) && license.deviceIds.length >= license.maxDevices) throw new LicenseError("DEVICE_LIMIT_REACHED");
      license.deviceIds = status === "ACTIVE" ? [...new Set([...license.deviceIds, device.id])] : license.deviceIds.filter(id => id !== device.id);
      tx.set(`license_devices/${device.id}`, { ...device, status }); tx.set(`license_licenses/${license.id}`, license);
      tx.set(`license_access_blocks/${device.nodusId}`, { uid: device.uid, deviceId: device.id, blocked: status !== "ACTIVE", updatedAt: this.now() });
      audit(tx, actor, "DEVICE_STATUS_CHANGED", license.id, { deviceId, status: device.status }, { deviceId, status }, this.now()); return { ok: true };
    });
  }
  async rotateKey(actor: Actor, licenseId: string, revoke = false) {
    requireAdmin(actor, true); const key = newLicenseKey();
    return this.store.transaction(async tx => {
      const license = await this.license(tx, licenseId); if (license.plan !== "business") throw new LicenseError("FORBIDDEN");
      const hash = secretHash(key, this.pepper); tx.set(`license_keys/${license.keyHash}`, { licenseId, active: false });
      if (!revoke) tx.set(`license_keys/${hash}`, { licenseId, active: true });
      tx.set(`license_licenses/${licenseId}`, { ...license, keyHash: revoke ? license.keyHash : hash, keyLast4: revoke ? license.keyLast4 : key.slice(-4), keyRevoked: revoke, updatedAt: this.now() });
      audit(tx, actor, revoke ? "LICENSE_KEY_REVOKED" : "LICENSE_KEY_ROTATED", licenseId, null, { keyLast4: revoke ? license.keyLast4 : key.slice(-4) }, this.now()); return { key: revoke ? "" : key };
    });
  }
  async payment(actor: Actor, input: { licenseId: string; paymentId: string; amountCents: number }, provider = "manual", verifiedEventId?: string) {
    requireAdmin(actor, true); validId(input.paymentId); const now = this.now();
    return this.store.transaction(async tx => {
      const license = await this.license(tx, input.licenseId), policy = await this.readPolicy(tx);
      if (license.plan !== "business" || input.amountCents !== policy.businessPriceCents) throw new LicenseError("INVALID_INPUT");
      const path = `license_payments/${validId(provider)}-${input.paymentId}`; const existing = await tx.get<{ licenseId: string; amountCents: number }>(path);
      const eventPath = verifiedEventId ? `license_webhook_events/${provider}-${validId(verifiedEventId)}` : null;
      const event = eventPath ? await tx.get<{ paymentId: string; licenseId: string }>(eventPath) : null;
      if (event) { if (event.paymentId !== input.paymentId || event.licenseId !== license.id) throw new LicenseError("INVALID_INPUT"); return { ok: true, duplicate: true }; }
      if (existing) {
        if (existing.licenseId !== license.id || existing.amountCents !== input.amountCents) throw new LicenseError("INVALID_INPUT");
        if (eventPath) tx.set(eventPath, { provider, providerEventId: verifiedEventId, paymentId: input.paymentId, licenseId: license.id, processed: true, createdAt: now });
        return { ok: true, duplicate: true };
      }
      if (license.status === "CANCELED") throw new LicenseError("LICENSE_REVOKED");
      const startsAt = Math.max(now, license.expiresAt), expiresAt = startsAt + 30 * DAY;
      tx.set(path, { ...input, organizationId: license.organizationId, currency: "BRL", status: "CONFIRMED", provider, paidAt: now, createdAt: now });
      if (eventPath) tx.set(eventPath, { provider, providerEventId: verifiedEventId, paymentId: input.paymentId, licenseId: license.id, processed: true, createdAt: now });
      tx.set(`license_subscriptions/${license.id}`, { licenseId: license.id, organizationId: license.organizationId, amountCents: input.amountCents, currency: "BRL", billingCycle: "monthly", status: "ACTIVE", currentPeriodStart: startsAt, currentPeriodEnd: expiresAt, paymentProvider: provider });
      tx.set(`license_licenses/${license.id}`, { ...license, status: "ACTIVE", expiresAt, graceUntil: expiresAt + policy.gracePeriodDays * DAY, updatedAt: now });
      audit(tx, actor, "PAYMENT_CONFIRMED", license.id, { expiresAt: license.expiresAt, status: license.status }, { expiresAt, paymentId: input.paymentId, amountCents: input.amountCents }, now); return { ok: true, duplicate: false };
    });
  }
}
