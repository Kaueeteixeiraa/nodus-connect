export const PROTOCOL_VERSION = 1 as const;

export type ProtocolMessageType =
  | "HELLO"
  | "AUTH"
  | "CONNECTION_REQUEST"
  | "CONNECTION_ACCEPT"
  | "CONNECTION_DENY"
  | "SESSION_START"
  | "VIDEO_FRAME"
  | "INPUT_EVENT"
  | "FILE_TRANSFER"
  | "CLIPBOARD"
  | "HEARTBEAT"
  | "DISCONNECT";

export type SessionPermission =
  | "screen:view"
  | "mouse:control"
  | "keyboard:control"
  | "clipboard:sync"
  | "files:transfer"
  | "audio:remote"
  | "admin:actions";

export interface ProtocolEnvelope<TPayload = unknown> {
  protocolVersion: typeof PROTOCOL_VERSION;
  messageType: ProtocolMessageType;
  sessionId?: string;
  timestamp: string;
  payload: TPayload;
}

export interface ConnectionRequestPayload {
  requesterNodusId: string;
  requesterName: string;
  targetNodusId: string;
  requestedPermissions: SessionPermission[];
}

export interface ConnectionDecisionPayload {
  accepted: boolean;
  grantedPermissions: SessionPermission[];
  reason?: string;
}
