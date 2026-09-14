import { normalizeNodusId } from "../../../../packages/common/src/nodusId";
import {
  cloudAcceptSessionRequest,
  cloudCreateSessionRequest,
  cloudDenySessionRequest,
  cloudGetSessionRequest,
  cloudGetSignals,
  cloudHeartbeat,
  cloudListIncomingRequests,
  cloudLookupDevice,
  cloudRegisterPresence,
  cloudSendSignal,
  firebaseConfigured,
} from "./firebase";
import type { LocalIdentity } from "./identity";
import type { SessionPermission } from "../../../../packages/protocol/src/index";

export type RemoteResolution = "1366x768" | "1280x720" | "1920x1080" | "1024x768";

const DEFAULT_API_BASE = import.meta.env.VITE_NODUS_API ?? "";
const AUTH_TOKEN_KEY = "nodus.coordination.auth-token.v1";
let runtimeApiBase = firstApiBase(DEFAULT_API_BASE);

export type CoordinationAuthSession = { token: string; user: { id: string; email: string; name: string } };

export async function registerCoordinationAccount(email: string, password: string, name: string): Promise<CoordinationAuthSession> {
  const session = await requestJson<CoordinationAuthSession>("/v1/auth/register", { method: "POST", body: JSON.stringify({ email, password, name }) });
  localStorage.setItem(AUTH_TOKEN_KEY, session.token);
  return session;
}

export async function loginCoordinationAccount(email: string, password: string): Promise<CoordinationAuthSession> {
  const session = await requestJson<CoordinationAuthSession>("/v1/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  localStorage.setItem(AUTH_TOKEN_KEY, session.token);
  return session;
}

export function logoutCoordinationAccount(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

export function getCoordinationAuthToken(): string {
  return localStorage.getItem(AUTH_TOKEN_KEY) || "";
}

export interface SessionRequestRecord {
  id: string;
  sessionId?: string;
  requesterUid?: string;
  requesterNodusId: string;
  requesterName: string;
  targetUid?: string;
  targetNodusId: string;
  targetName?: string;
  status: "pending" | "accepted" | "denied";
  createdAt: string;
  updatedAt: string;
  requestedPermissions?: SessionPermission[];
  grantedPermissions?: SessionPermission[];
  passwordHash?: string;
  preferredResolution?: RemoteResolution;
}

export interface SignalMessage {
  seq: number;
  sessionId: string;
  from: string;
  to: string;
  type: "offer" | "answer" | "ice-candidate" | "disconnect";
  payload: unknown;
  createdAt: string;
}

export interface CoordinationDevice {
  nodusId: string;
  ownerUid?: string;
  deviceName: string;
  status: "online" | "offline" | "connecting" | "in_session" | "error";
  updatedAt: string;
  capabilities: string[];
}

export interface IceRouteCheck {
  ok: boolean;
  relayAvailable: boolean;
  urls: string[];
  elapsedMs: number;
  candidateTypes: Record<"host" | "srflx" | "relay" | "prflx" | "unknown", number>;
  error?: string;
}

export async function fetchIceServers(baseOverride: string = apiBase()): Promise<RTCIceServer[]> {
  const bases = baseOverride.split(/[\n,]+/).map((base) => base.trim().replace(/\/$/, "")).filter(Boolean);
  if (!bases.length) return [];
  try {
    return await Promise.any(bases.map(fetchIceEndpoint));
  } catch {
    return [];
  }
}

async function fetchIceEndpoint(base: string): Promise<RTCIceServer[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(`${base}/v1/ice-servers`, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error("Servidor indisponivel");
    const data = await response.json() as { iceServers?: RTCIceServer[] };
    if (!Array.isArray(data.iceServers) || !data.iceServers.length) throw new Error("Servidor sem rota");
    return data.iceServers;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function testIceServers(iceServers: RTCIceServer[], timeoutMs = 6500): Promise<IceRouteCheck> {
  const startedAt = performance.now();
  const urls = iceServerUrls(iceServers);
  const candidateTypes = { host: 0, srflx: 0, relay: 0, prflx: 0, unknown: 0 };
  if (!iceServers.length) return iceCheckResult(false, urls, startedAt, candidateTypes, "Nenhum servidor ICE configurado.");

  let peer: RTCPeerConnection | null = null;
  try {
    peer = new RTCPeerConnection({ iceServers });
    peer.createDataChannel("ice-check");
    return await new Promise<IceRouteCheck>((resolve) => {
      let settled = false;
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        peer?.close();
        resolve(iceCheckResult(candidateTypes.host + candidateTypes.srflx + candidateTypes.relay + candidateTypes.prflx > 0, urls, startedAt, candidateTypes, error));
      };
      const timer = window.setTimeout(() => finish(candidateTypes.relay ? undefined : "Tempo esgotado sem candidato TURN."), timeoutMs);
      peer!.onicecandidate = (event) => {
        if (!event.candidate) return finish();
        const type = candidateType(event.candidate.candidate);
        candidateTypes[type] += 1;
        if (type === "relay") finish();
      };
      peer!.onicegatheringstatechange = () => {
        if (peer?.iceGatheringState === "complete") finish();
      };
      peer!.createOffer()
        .then((offer) => peer?.setLocalDescription(offer))
        .catch((error) => finish(error instanceof Error ? error.message : "Falha ao testar ICE."));
    });
  } catch (error) {
    peer?.close();
    return iceCheckResult(false, urls, startedAt, candidateTypes, error instanceof Error ? error.message : "Falha ao testar ICE.");
  }
}

export async function registerPresence(identity: LocalIdentity): Promise<CoordinationDevice> {
  if (firebaseConfigured()) return cloudRegisterPresence(identity);
  return request("/v1/presence", {
    method: "PUT",
    body: JSON.stringify({
      nodusId: identity.nodusId,
      deviceName: identity.deviceName,
      status: "online",
      capabilities: ["desktop-shell", "presence", "screen-share", "remote-control", "realtime"],
    }),
  });
}

export async function heartbeat(identity: LocalIdentity | string): Promise<CoordinationDevice> {
  if (firebaseConfigured()) return cloudHeartbeat(identity);
  const nodusId = typeof identity === "string" ? identity : identity.nodusId;
  const normalized = normalizeNodusId(nodusId);
  if (!normalized) throw new Error("Nodus ID invalido");
  return request(`/v1/presence/${normalized}/heartbeat`, { method: "POST" });
}

export async function lookupDevice(nodusId: string): Promise<CoordinationDevice | null> {
  if (firebaseConfigured()) return cloudLookupDevice(nodusId);
  const normalized = normalizeNodusId(nodusId);
  if (!normalized) throw new Error("Nodus ID invalido");

  const base = apiBase();
  if (!base) throw new Error("Configure a central de conexao.");
  const response = await fetch(`${base}/v1/devices/${normalized}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Nao foi possivel consultar o dispositivo.");
  return response.json();
}

export async function createSessionRequest(input: {
  requesterNodusId: string;
  requesterName: string;
  targetNodusId: string;
  requestedPermissions?: SessionPermission[];
  passwordHash?: string;
  preferredResolution?: RemoteResolution;
}): Promise<SessionRequestRecord> {
  if (firebaseConfigured()) return cloudCreateSessionRequest(input);
  return requestJson("/v1/session-requests", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listIncomingRequests(nodusId: string): Promise<SessionRequestRecord[]> {
  if (firebaseConfigured()) return cloudListIncomingRequests(nodusId);
  const normalized = normalizeNodusId(nodusId);
  if (!normalized) throw new Error("Nodus ID invalido");
  return requestJson(`/v1/session-requests/target/${normalized}`);
}

export async function getSessionRequest(id: string): Promise<SessionRequestRecord> {
  if (firebaseConfigured()) return cloudGetSessionRequest(id);
  return requestJson(`/v1/session-requests/${id}`);
}

export async function acceptSessionRequest(id: string, targetName: string, grantedPermissions: SessionPermission[] = ["screen:view"]): Promise<SessionRequestRecord> {
  if (firebaseConfigured()) return cloudAcceptSessionRequest(id, targetName, grantedPermissions);
  return requestJson(`/v1/session-requests/${id}/accept`, {
    method: "POST",
    body: JSON.stringify({ targetName, grantedPermissions }),
  });
}

export async function denySessionRequest(id: string): Promise<SessionRequestRecord> {
  if (firebaseConfigured()) return cloudDenySessionRequest(id);
  return requestJson(`/v1/session-requests/${id}/deny`, { method: "POST" });
}

export async function sendSignal(
  sessionId: string,
  signal: Omit<SignalMessage, "seq" | "sessionId" | "createdAt">,
): Promise<SignalMessage> {
  if (firebaseConfigured()) return cloudSendSignal(sessionId, signal);
  return requestJson(`/v1/sessions/${sessionId}/signals`, {
    method: "POST",
    body: JSON.stringify(signal),
  });
}

export async function getSignals(sessionId: string, to: string, after = 0): Promise<SignalMessage[]> {
  if (firebaseConfigured()) return cloudGetSignals(sessionId, to, after);
  const normalized = normalizeNodusId(to);
  if (!normalized) throw new Error("Nodus ID invalido");
  return requestJson(`/v1/sessions/${sessionId}/signals?to=${normalized}&after=${after}`);
}

async function request(path: string, init: RequestInit): Promise<CoordinationDevice> {
  return requestJson(path, init);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = apiBase();
  if (!base) throw new Error("Configure a central de conexao.");
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(getCoordinationAuthToken() ? { authorization: `Bearer ${getCoordinationAuthToken()}` } : {}),
      ...init.headers,
    },
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(formatApiError((data as { error?: string } | null)?.error, response.status));
  return data as T;
}

function formatApiError(error?: string, status = 0): string {
  if (error === "AUTH_NOT_CONFIGURED") return "A autenticacao propria nao esta configurada no servidor.";
  if (error === "AUTH_INVALID_CREDENTIALS") return "E-mail ou senha incorretos.";
  if (error === "AUTH_EMAIL_EXISTS") return "Este e-mail ja possui uma conta Nodus.";
  if (error === "INVALID_AUTH_DATA") return "Use um nome, e-mail valido e senha com pelo menos 10 caracteres.";
  if (error === "AUTH_INVALID_TOKEN" || error === "AUTH_EXPIRED_TOKEN") return "Sua sessao expirou. Entre novamente.";
  if (error === "AUTH_REQUIRED") return "Entre na conta Nodus antes de usar esta central.";
  if (error === "AUTH_RATE_LIMITED") return "Muitas tentativas. Aguarde um minuto e tente novamente.";
  if (error === "INVALID_TARGET") return "Digite o Nodus ID de outro computador.";
  if (error === "INVALID_NODUS_ID") return "Nodus ID invalido.";
  if (error === "DEVICE_NOT_FOUND") return "Dispositivo nao encontrado ou offline.";
  if (error === "REQUEST_NOT_FOUND") return "Solicitacao expirada. Tente novamente.";
  if (status >= 500) return "Central de conexao indisponivel.";
  return "Nao foi possivel concluir a solicitacao.";
}

export function configureApiBase(value: string): void {
  runtimeApiBase = firstApiBase(value);
}

export function apiBase(): string {
  return runtimeApiBase;
}

function firstApiBase(value: string): string {
  return value.split(/[\n,]+/).map((base) => base.trim().replace(/\/$/, "")).find(Boolean) ?? "";
}

function iceServerUrls(iceServers: RTCIceServer[]): string[] {
  return iceServers.flatMap((server) => Array.isArray(server.urls) ? server.urls : [server.urls]).filter(Boolean);
}

function candidateType(candidate: string): keyof IceRouteCheck["candidateTypes"] {
  const type = candidate.match(/\btyp\s+([a-z0-9-]+)/i)?.[1] ?? "unknown";
  return type === "host" || type === "srflx" || type === "relay" || type === "prflx" ? type : "unknown";
}

function iceCheckResult(
  ok: boolean,
  urls: string[],
  startedAt: number,
  candidateTypes: IceRouteCheck["candidateTypes"],
  error?: string,
): IceRouteCheck {
  return {
    ok,
    relayAvailable: candidateTypes.relay > 0,
    urls,
    elapsedMs: Math.round(performance.now() - startedAt),
    candidateTypes,
    error,
  };
}
