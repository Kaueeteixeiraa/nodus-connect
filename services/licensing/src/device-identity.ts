import { randomUUID } from "node:crypto";
import { LicenseError, type DeviceLicenseIdentity, type IdentityReview, type License, type LicenseDevice, type LicensePolicy, type NodusDeviceIdentity } from "../../../packages/licensing/src/index.js";
import type { LicenseTransaction } from "./store.js";
import { secretHash } from "./security.js";

export function identityAnchors(input: unknown, pepper: string): { anchors: string[]; trusted: boolean } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new LicenseError("INVALID_INPUT");
  const value = input as NodusDeviceIdentity;
  if (value.version !== 1 || typeof value.virtual !== "boolean" || !value.anchors || typeof value.anchors !== "object" || Array.isArray(value.anchors)) throw new LicenseError("INVALID_INPUT");
  const anchors = Object.entries(value.anchors).map(([kind, hash]) => {
    if (!["system", "board", "bios"].includes(kind) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || /^(0+|f+)$/.test(hash)) throw new LicenseError("INVALID_INPUT");
    return `${kind}-${secretHash(`nodus-license-identity-v1:${kind}:${hash}`, pepper)}`;
  }).sort();
  return { anchors, trusted: anchors.length >= 2 && !value.virtual };
}

export async function resolveDeviceIdentity(tx: LicenseTransaction, input: unknown, device: Pick<LicenseDevice, "id" | "uid">, existing: LicenseDevice | null, policy: LicensePolicy, pepper: string, now: number) {
  if (!policy.identityEnabled && !policy.identityEnrollmentEnabled) return { identity: null, review: existing?.identityReview ?? false };
  const proof = input === undefined ? { anchors: [], trusted: false } : identityAnchors(input, pepper);
  const indexes = await Promise.all(proof.anchors.map(anchor => tx.get<{ ids: string[] }>(`license_identity_anchors/${anchor}`)));
  const found = [...new Set(indexes.flatMap(index => index?.ids ?? []))], overflow = found.length > 8;
  const candidates = found.slice(0, 8);
  const records = (await Promise.all(candidates.map(id => tx.get<DeviceLicenseIdentity>(`license_device_identities/${id}`)))).filter((row): row is DeviceLicenseIdentity => Boolean(row));
  const exact = proof.trusted && !overflow ? records.filter(row => proof.anchors.filter(anchor => row.anchors.includes(anchor)).length >= 2) : [];
  const own = existing?.deviceIdentityId ? await tx.get<DeviceLicenseIdentity>(`license_device_identities/${existing.deviceIdentityId}`) : null;
  let identity = own ?? (exact.length === 1 && records.length === 1 ? exact[0] : null);
  const mismatch = own && (!proof.trusted || proof.anchors.filter(anchor => own.anchors.includes(anchor)).length < 2);
  const conflict = overflow || mismatch || records.some(row => row.id !== identity?.id) || exact.length > 1 || Boolean(identity && new Set([...identity.anchors, ...proof.anchors]).size > 12);
  const permittedNew = existing && proof.trusted || policy.allowNewIdentities && proof.trusted;
  const review = Boolean(conflict || !identity && !permittedNew);
  if (review) {
    const previous = await tx.get<IdentityReview>(`license_identity_reviews/${device.id}`);
    if (!previous || previous.status !== "PENDING" || previous.uid !== device.uid || JSON.stringify(previous.anchors) !== JSON.stringify(proof.anchors)) {
      tx.set(`license_identity_reviews/${device.id}`, { deviceId: device.id, uid: device.uid, candidates, anchors: proof.anchors, reason: conflict ? "CONFLICT" : proof.trusted ? "MIGRATION_REVIEW" : "INSUFFICIENT_SIGNALS", status: "PENDING", createdAt: now } satisfies IdentityReview);
    }
    return { identity: own, review: true };
  }
  if (!identity) {
    const id = `hw-${randomUUID()}`;
    identity = { id, freeLicenseId: existing?.freeLicenseId ?? `free-${existing?.id ?? id}`, version: 1, status: "ACTIVE", anchors: proof.anchors, createdAt: existing?.activatedAt ?? now, schemaVersion: 1 };
  }
  if (identity.status !== "ACTIVE") throw new LicenseError("DEVICE_REVOKED");
  if (existing) {
    const legacyId = existing.freeLicenseId ?? `free-${existing.id}`;
    if (legacyId !== identity.freeLicenseId) {
      const marker = await tx.get(`license_identity_migrations/${legacyId}`);
      const old = await tx.get<License>(`license_licenses/${legacyId}`);
      const current = await tx.get<License>(`license_licenses/${identity.freeLicenseId}`);
      if (old && !marker) {
        if (!current || old.plan !== "free" || current.plan !== "free" || Object.values(old.slots).some(slot => slot.established || slot.expiresAt > now)) {
          tx.set(`license_identity_reviews/${device.id}`, { deviceId: device.id, uid: device.uid, candidates: [identity.id], anchors: proof.anchors, reason: "ACTIVE_LEGACY_SESSIONS", status: "PENDING", createdAt: now } satisfies IdentityReview);
          return { identity: own, review: true };
        }
        tx.set(`license_licenses/${current.id}`, { ...current, trialUsed: current.trialUsed + old.trialUsed, trialLimit: Math.max(current.trialLimit, old.trialLimit), updatedAt: now });
        tx.set(`license_identity_migrations/${legacyId}`, { deviceIdentityId: identity.id, freeLicenseId: current.id, used: old.trialUsed, createdAt: now });
      }
    }
  }
  identity = { ...identity, anchors: [...new Set([...identity.anchors, ...proof.anchors])] };
  tx.set(`license_device_identities/${identity.id}`, identity);
  for (const [index, anchor] of proof.anchors.entries()) tx.set(`license_identity_anchors/${anchor}`, { ids: [...new Set([...(indexes[index]?.ids ?? []), identity.id])] });
  const previous = await tx.get<IdentityReview>(`license_identity_reviews/${device.id}`);
  if (previous?.status === "PENDING") tx.set(`license_identity_reviews/${device.id}`, { ...previous, status: "RESOLVED" });
  return { identity, review: false };
}
