import { isValidNodusId } from "../../../../packages/common/src/nodusId";

const IDENTITY_KEY = "nodus.identity.v1";

export interface LocalIdentity {
  nodusId: string;
  deviceId: string;
  deviceFingerprint: string;
  deviceClaim: string;
  deviceName: string;
  deviceNameConfirmed: boolean;
  createdAt: string;
  supportProfileId?: string;
}

export async function loadOfficialIdentity(): Promise<LocalIdentity> {
  const bridge = window.nodusDesktop;
  if (!bridge) throw new Error("NODUS_NATIVE_IDENTITY_UNAVAILABLE");
  const identity = parseIdentity(await bridge.getIdentity(readCachedIdentity()));
  if (!identity) throw new Error("NODUS_NATIVE_IDENTITY_INVALID");
  cacheIdentity(identity);
  return identity;
}

export function saveIdentity(identity: LocalIdentity): void {
  cacheIdentity(identity);
  window.nodusDesktop?.saveIdentity(identity).catch(() => undefined);
}

function readCachedIdentity(): Partial<LocalIdentity> | null {
  try {
    const value = JSON.parse(localStorage.getItem(IDENTITY_KEY) || "null") as Partial<LocalIdentity> | null;
    return value && isValidNodusId(String(value.nodusId || "")) ? value : null;
  } catch {
    return null;
  }
}

function cacheIdentity(identity: LocalIdentity): void {
  const { deviceClaim: _deviceClaim, ...safe } = identity;
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(safe));
}

function parseIdentity(value: unknown): LocalIdentity | null {
  if (!value || typeof value !== "object") return null;
  const identity = value as Partial<LocalIdentity>;
  if (!isValidNodusId(String(identity.nodusId || "")) || !identity.deviceId || !identity.deviceFingerprint || !identity.deviceClaim || !identity.deviceName || !identity.createdAt) return null;
  return {
    nodusId: String(identity.nodusId),
    deviceId: String(identity.deviceId),
    deviceFingerprint: String(identity.deviceFingerprint),
    deviceClaim: String(identity.deviceClaim),
    deviceName: String(identity.deviceName),
    deviceNameConfirmed: Boolean(identity.deviceNameConfirmed),
    createdAt: String(identity.createdAt),
  };
}
