import { normalizeNodusId } from "../../../../packages/common/src/nodusId";
import { apiBase, getCoordinationAuthToken, type SessionRequestRecord, type SignalMessage } from "./api";
import { firebaseConfigured, subscribeCloudRealtime } from "./firebase";

type RealtimeMessage =
  | { type: "ready"; nodusId: string }
  | { type: "incoming-request"; request: SessionRequestRecord }
  | { type: "session-request-update"; request: SessionRequestRecord }
  | { type: "signal"; signal: SignalMessage }
  | { type: "presence" };

interface RealtimeHandlers {
  onIncomingRequest?(request: SessionRequestRecord): void;
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
    socket.onopen = () => handlers.onState?.("online");
    socket.onmessage = (event) => dispatch(JSON.parse(event.data) as RealtimeMessage);
    socket.onclose = reconnect;
    socket.onerror = () => socket?.close();
  }

  function dispatch(message: RealtimeMessage) {
    if (message.type === "incoming-request") handlers.onIncomingRequest?.(message.request);
    if (message.type === "session-request-update") handlers.onRequestUpdate?.(message.request);
    if (message.type === "signal") handlers.onSignal?.(message.signal);
  }

  function reconnect() {
    if (closed) return;
    handlers.onState?.("offline");
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(open, 2_000);
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
