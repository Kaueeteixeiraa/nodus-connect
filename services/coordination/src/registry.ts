import { normalizeNodusId } from "../../../packages/common/src/nodusId.js";

export type DeviceStatus = "online" | "offline" | "connecting" | "in_session" | "error";

export interface PresenceRecord {
  nodusId: string;
  deviceName: string;
  status: DeviceStatus;
  updatedAt: string;
  capabilities: string[];
}

export interface PresenceInput {
  nodusId: string;
  deviceName: string;
  status?: DeviceStatus;
  capabilities?: string[];
}

export class PresenceRegistry {
  private readonly records = new Map<string, PresenceRecord>();

  constructor(private readonly ttlMs = 45_000) {}

  upsert(input: PresenceInput): PresenceRecord {
    const nodusId = normalizeNodusId(input.nodusId);
    if (!nodusId) throw new Error("INVALID_NODUS_ID");
    if (!input.deviceName.trim()) throw new Error("INVALID_DEVICE_NAME");

    const record: PresenceRecord = {
      nodusId,
      deviceName: input.deviceName.trim(),
      status: input.status ?? "online",
      updatedAt: new Date().toISOString(),
      capabilities: input.capabilities ?? [],
    };

    this.records.set(nodusId, record);
    return record;
  }

  heartbeat(nodusIdInput: string): PresenceRecord {
    const nodusId = normalizeNodusId(nodusIdInput);
    if (!nodusId) throw new Error("INVALID_NODUS_ID");

    const current = this.records.get(nodusId);
    if (!current) throw new Error("DEVICE_NOT_FOUND");

    const next = { ...current, status: "online" as const, updatedAt: new Date().toISOString() };
    this.records.set(nodusId, next);
    return next;
  }

  lookup(nodusIdInput: string): PresenceRecord | null {
    this.pruneExpired();
    const nodusId = normalizeNodusId(nodusIdInput);
    return nodusId ? (this.records.get(nodusId) ?? null) : null;
  }

  list(): PresenceRecord[] {
    this.pruneExpired();
    return [...this.records.values()];
  }

  pruneExpired(now = Date.now()): void {
    for (const [nodusId, record] of this.records) {
      if (now - Date.parse(record.updatedAt) > this.ttlMs) {
        this.records.delete(nodusId);
      }
    }
  }
}
