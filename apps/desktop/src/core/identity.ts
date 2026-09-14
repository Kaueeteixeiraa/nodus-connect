import { generateNodusId } from "../../../../packages/common/src/nodusId";

const IDENTITY_KEY = "nodus.identity.v1";

export interface LocalIdentity {
  nodusId: string;
  deviceName: string;
  deviceNameConfirmed: boolean;
  createdAt: string;
}

export function loadOrCreateIdentity(): LocalIdentity {
  const stored = localStorage.getItem(IDENTITY_KEY);
  if (stored) {
    try {
      return JSON.parse(stored) as LocalIdentity;
    } catch {
      localStorage.removeItem(IDENTITY_KEY);
    }
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  const identity: LocalIdentity = {
    nodusId: generateNodusId(bytes),
    deviceName: defaultDeviceName(),
    deviceNameConfirmed: false,
    createdAt: new Date().toISOString(),
  };

  saveIdentity(identity);
  return identity;
}

export function saveIdentity(identity: LocalIdentity): void {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  window.nodusDesktop?.saveIdentity(identity).catch(() => undefined);
}

export function regenerateNodusId(identity: LocalIdentity): LocalIdentity {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return { ...identity, nodusId: generateNodusId(bytes), createdAt: new Date().toISOString() };
}

export async function loadNativeIdentity(): Promise<LocalIdentity | null> {
  const native = await window.nodusDesktop?.getIdentity().catch(() => null);
  if (!native || typeof native !== "object") return null;
  const identity = native as Partial<LocalIdentity>;
  if (!identity.nodusId || !identity.deviceName || !identity.createdAt) return null;
  return {
    nodusId: identity.nodusId,
    deviceName: identity.deviceName,
    deviceNameConfirmed: Boolean(identity.deviceNameConfirmed),
    createdAt: identity.createdAt,
  };
}

function defaultDeviceName(): string {
  const platform = navigator.platform?.toLowerCase().includes("win") ? "Windows" : "Dispositivo";
  return `PC-${platform}`;
}
