import { randomUUID } from "node:crypto";
import { normalizeNodusId } from "../../../packages/common/src/nodusId.js";
import type { SessionPermission } from "../../../packages/protocol/src/index.js";
import type { RemoteFrameRate, RemoteResolution } from "../../../apps/desktop/src/core/api";

export type SessionRequestStatus = "pending" | "accepted" | "denied";
export type SignalType = "offer" | "answer" | "ice-candidate" | "disconnect";

export interface SessionRequest {
  id: string;
  sessionId?: string;
  requesterNodusId: string;
  requesterName: string;
  targetNodusId: string;
  targetName?: string;
  status: SessionRequestStatus;
  createdAt: string;
  updatedAt: string;
  requestedPermissions?: SessionPermission[];
  grantedPermissions?: SessionPermission[];
  passwordHash?: string;
  preferredResolution?: RemoteResolution;
  preferredFps?: RemoteFrameRate;
}

export interface SignalMessage {
  seq: number;
  sessionId: string;
  from: string;
  to: string;
  type: SignalType;
  payload: unknown;
  createdAt: string;
}

export class SignalingRegistry {
  private seq = 0;
  private readonly requests = new Map<string, SessionRequest>();
  private readonly signals = new Map<string, SignalMessage[]>();

  constructor(private readonly pendingTtlMs = 5 * 60_000) {}

  createRequest(input: { requesterNodusId: string; requesterName: string; targetNodusId: string; requestedPermissions?: SessionPermission[]; passwordHash?: string; preferredResolution?: RemoteResolution; preferredFps?: RemoteFrameRate }): SessionRequest {
    const requesterNodusId = normalizeNodusId(input.requesterNodusId);
    const targetNodusId = normalizeNodusId(input.targetNodusId);
    if (!requesterNodusId || !targetNodusId) throw new Error("INVALID_NODUS_ID");
    if (requesterNodusId === targetNodusId) throw new Error("INVALID_TARGET");
    if (!input.requesterName.trim()) throw new Error("INVALID_DEVICE_NAME");

    const now = new Date().toISOString();
    const request: SessionRequest = {
      id: randomUUID(),
      requesterNodusId,
      requesterName: input.requesterName.trim(),
      targetNodusId,
      status: "pending",
      requestedPermissions: input.requestedPermissions ?? ["screen:view"],
      passwordHash: input.passwordHash,
      preferredResolution: input.preferredResolution,
      preferredFps: input.preferredFps,
      createdAt: now,
      updatedAt: now,
    };
    this.requests.set(request.id, request);
    return request;
  }

  listPending(targetNodusIdInput: string): SessionRequest[] {
    this.pruneExpired();
    const targetNodusId = normalizeNodusId(targetNodusIdInput);
    if (!targetNodusId) throw new Error("INVALID_NODUS_ID");
    return [...this.requests.values()].filter((request) => request.targetNodusId === targetNodusId && request.status === "pending");
  }

  getRequest(id: string): SessionRequest {
    this.pruneExpired();
    const request = this.requests.get(id);
    if (!request) throw new Error("REQUEST_NOT_FOUND");
    return request;
  }

  acceptRequest(id: string, targetName: string, grantedPermissions: SessionPermission[] = ["screen:view"]): SessionRequest {
    const request = this.getRequest(id);
    const next = {
      ...request,
      sessionId: request.sessionId ?? randomUUID(),
      targetName: targetName.trim() || "Dispositivo remoto",
      grantedPermissions,
      status: "accepted" as const,
      updatedAt: new Date().toISOString(),
    };
    this.requests.set(id, next);
    return next;
  }

  denyRequest(id: string): SessionRequest {
    const request = this.getRequest(id);
    const next = { ...request, status: "denied" as const, updatedAt: new Date().toISOString() };
    this.requests.set(id, next);
    return next;
  }

  addSignal(input: Omit<SignalMessage, "seq" | "createdAt">): SignalMessage {
    const from = normalizeNodusId(input.from);
    const to = normalizeNodusId(input.to);
    if (!from || !to) throw new Error("INVALID_NODUS_ID");

    const message: SignalMessage = {
      ...input,
      from,
      to,
      seq: ++this.seq,
      createdAt: new Date().toISOString(),
    };
    const current = this.signals.get(input.sessionId) ?? [];
    this.signals.set(input.sessionId, [...current, message].slice(-200));
    return message;
  }

  getSignals(sessionId: string, toInput: string, afterInput = "0"): SignalMessage[] {
    const to = normalizeNodusId(toInput);
    if (!to) throw new Error("INVALID_NODUS_ID");
    const after = Number(afterInput) || 0;
    return (this.signals.get(sessionId) ?? []).filter((message) => message.to === to && message.seq > after);
  }

  pruneExpired(now = Date.now()): void {
    for (const [id, request] of this.requests) {
      if (request.status === "pending" && now - Date.parse(request.createdAt) > this.pendingTtlMs) this.requests.delete(id);
    }
  }
}
