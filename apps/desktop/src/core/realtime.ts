import { normalizeNodusId } from "../../../../packages/common/src/nodusId";
import { apiBase, getCoordinationAuthToken, type SessionRequestRecord, type SignalMessage } from "./api";
import { firebaseConfigured, subscribeCloudRealtime } from "./firebase";
import { relayLicenseHeaders, licenseConfigured } from "./licensing";

type RealtimeMessage =
  | { type: "ready"; nodusId: string }
  | { type: "incoming-request"; request: SessionRequestRecord }
  | { type: "session-request-update"; request: SessionRequestRecord }
  | { type: "signal"; signal: SignalMessage }
  | { type: "presence" };

interface RealtimeHandlers {
  onIncomingRequest?(request: SessionRequestRecord): void;
  onIncomingRequests?(requests: SessionRequestRecord[]): void;
  onRequestUpdate?(request: SessionRequestRecord): void;
  onSignal?(signal: SignalMessage): void;
  onState?(state: "connecting" | "online" | "offline"): void;
}

export function connectRealtime(nodusIdInput: string, handlers: RealtimeHandlers) {
  if (firebaseConfigured()) return subscribeCloudRealtime(nodusIdInput, handlers);
  const nodusId = normalizeNodusId(nodusIdInput);
  let closed = false;
  let socket: WebSocket | null = null;
  let retryTimer = 0;
  let retries = 0;

  function open() {
    if (!nodusId || closed) return;
    const base = apiBase();
    if (!base) {
      handlers.onState?.("offline");
      return;
    }
    handlers.onState?.("connecting");
    const url = new URL("/v1/ws", base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("nodusId", nodusId);
    const token = getCoordinationAuthToken();
    if (token) url.searchParams.set("token", token);

    socket = new WebSocket(url);
    const current = socket;
    socket.onopen = async () => {
      if (closed || current !== socket) return;
      if (!licenseConfigured()) { handlers.onState?.("online"); return; }
      try { const headers = await relayLicenseHeaders(); if (!closed && current === socket && current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: "license-auth", token: headers["x-nodus-license-identity"] })); } catch { current.close(); }
    };
    socket.onmessage = (event) => {
      if (closed || current !== socket) return;
      let message: RealtimeMessage;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message && typeof message === "object") dispatch(message);
    };
    socket.onclose = () => { if (current === socket) reconnect(); };
    socket.onerror = () => current.close();
  }

  function dispatch(message: RealtimeMessage) {
    if (message.type === "ready") { retries = 0; handlers.onState?.("online"); }
    if (message.type === "incoming-request") handlers.onIncomingRequest?.(message.request);
    if (message.type === "session-request-update") handlers.onRequestUpdate?.(message.request);
    if (message.type === "signal") handlers.onSignal?.(message.signal);
  }

  function reconnect() {
    if (closed) return;
    handlers.onState?.("offline");
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(open, Math.min(30_000, 2_000 * 2 ** Math.min(retries++, 4)));
  }

  open();
  return {
    close() {
      closed = true;
      window.clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
