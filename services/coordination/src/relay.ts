import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { PresenceRegistry, type PresenceInput } from "./registry.js";
import { SignalingRegistry, type SignalMessage } from "./signaling.js";
import type { SessionPermission } from "../../../packages/protocol/src/index.js";
import { AuthRegistry } from "./auth.js";

type IceServer = { urls: string | string[]; username?: string; credential?: string };

export function createRelayServer() {
  const registry = new PresenceRegistry();
  const signaling = new SignalingRegistry();
  const clients = new Map<string, Set<WebSocket>>();
  const auth = new AuthRegistry();
  const authRequired = process.env.NODUS_AUTH_REQUIRED === "1";

  const server = createServer(async (request, response) => {
    setCors(response);
    if (request.method === "OPTIONS") return send(response, 204);

    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true, service: "nodus-coordination", realtime: true });
      }

      if (request.method === "POST" && url.pathname === "/v1/auth/register") {
        const body = await readJson(request) as { email?: string; password?: string; name?: string };
        return json(response, 201, auth.register(body.email || "", body.password || "", body.name || ""));
      }

      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        const body = await readJson(request) as { email?: string; password?: string };
        return json(response, 200, auth.login(body.email || "", body.password || ""));
      }

      if (request.method === "GET" && url.pathname === "/v1/auth/me") {
        return json(response, 200, auth.verify(String(request.headers.authorization || "").replace(/^Bearer\s+/i, "")));
      }

      if (authRequired) {
        const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
        if (!token) throw new Error("AUTH_REQUIRED");
        auth.verify(token);
      }

      if (request.method === "GET" && url.pathname === "/v1/ice-servers") {
        return json(response, 200, { iceServers: await getIceServersForClient() });
      }

      if (request.method === "PUT" && url.pathname === "/v1/presence") {
        const record = registry.upsert((await readJson(request)) as PresenceInput);
        notify(clients, record.nodusId, "presence", { device: record });
        return json(response, 200, record);
      }

      const heartbeatMatch = url.pathname.match(/^\/v1\/presence\/(\d{9})\/heartbeat$/);
      if (request.method === "POST" && heartbeatMatch) {
        const record = registry.heartbeat(heartbeatMatch[1]);
        notify(clients, record.nodusId, "presence", { device: record });
        return json(response, 200, record);
      }

      const offlineMatch = url.pathname.match(/^\/v1\/presence\/(\d{9})$/);
      if (request.method === "DELETE" && offlineMatch) {
        const record = registry.offline(offlineMatch[1]);
        notify(clients, record.nodusId, "presence", { device: record });
        return json(response, 200, record);
      }

      const deviceMatch = url.pathname.match(/^\/v1\/devices\/(\d{9})$/);
      if (request.method === "GET" && deviceMatch) {
        const device = registry.lookup(deviceMatch[1]);
        return device ? json(response, 200, device) : json(response, 404, { error: "DEVICE_NOT_FOUND" });
      }

      if (request.method === "GET" && url.pathname === "/v1/devices") {
        return json(response, 200, registry.list());
      }

      if (request.method === "POST" && url.pathname === "/v1/session-requests") {
        const item = signaling.createRequest((await readJson(request)) as Parameters<SignalingRegistry["createRequest"]>[0]);
        notify(clients, item.targetNodusId, "incoming-request", { request: item });
        notify(clients, item.requesterNodusId, "session-request-update", { request: item });
        return json(response, 201, item);
      }

      const pendingMatch = url.pathname.match(/^\/v1\/session-requests\/target\/(\d{9})$/);
      if (request.method === "GET" && pendingMatch) {
        return json(response, 200, signaling.listPending(pendingMatch[1]));
      }

      const requestMatch = url.pathname.match(/^\/v1\/session-requests\/([0-9a-f-]+)$/);
      if (request.method === "GET" && requestMatch) {
        return json(response, 200, signaling.getRequest(requestMatch[1]));
      }

      const acceptMatch = url.pathname.match(/^\/v1\/session-requests\/([0-9a-f-]+)\/accept$/);
      if (request.method === "POST" && acceptMatch) {
        const body = (await readJson(request)) as { targetName?: string; grantedPermissions?: SessionPermission[] };
        const item = signaling.acceptRequest(acceptMatch[1], body.targetName ?? "", body.grantedPermissions);
        notify(clients, item.requesterNodusId, "session-request-update", { request: item });
        notify(clients, item.targetNodusId, "session-request-update", { request: item });
        return json(response, 200, item);
      }

      const denyMatch = url.pathname.match(/^\/v1\/session-requests\/([0-9a-f-]+)\/deny$/);
      if (request.method === "POST" && denyMatch) {
        const item = signaling.denyRequest(denyMatch[1]);
        notify(clients, item.requesterNodusId, "session-request-update", { request: item });
        notify(clients, item.targetNodusId, "session-request-update", { request: item });
        return json(response, 200, item);
      }

      const signalMatch = url.pathname.match(/^\/v1\/sessions\/([0-9a-f-]+)\/signals$/);
      if (signalMatch && request.method === "POST") {
        const body = (await readJson(request)) as Omit<SignalMessage, "seq" | "createdAt" | "sessionId">;
        const item = signaling.addSignal({ ...body, sessionId: signalMatch[1] });
        notify(clients, item.to, "signal", { signal: item });
        return json(response, 201, item);
      }

      if (signalMatch && request.method === "GET") {
        return json(response, 200, signaling.getSignals(signalMatch[1], url.searchParams.get("to") ?? "", url.searchParams.get("after") ?? "0"));
      }

      return json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
      const status = message === "AUTH_REQUIRED" ? 401 : message === "AUTH_RATE_LIMITED" ? 429 : message.startsWith("INVALID") || message.startsWith("AUTH_INVALID") ? 400 : message === "AUTH_EMAIL_EXISTS" ? 409 : message.endsWith("_NOT_FOUND") ? 404 : 500;
      return json(response, status, { error: message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== "/v1/ws") return socket.destroy();
      if (authRequired) {
        try { auth.verify(url.searchParams.get("token") || ""); } catch { return socket.destroy(); }
      }
      const nodusId = normalizeWsId(url.searchParams.get("nodusId"));
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, nodusId));
    } catch {
      socket.destroy();
    }
  });

  wss.on("connection", (socket: WebSocket, _request: IncomingMessage, nodusId: string) => {
    const bucket = clients.get(nodusId) ?? new Set<WebSocket>();
    bucket.add(socket);
    clients.set(nodusId, bucket);
    sendWs(socket, "ready", { nodusId });
    socket.on("close", () => {
      bucket.delete(socket);
      if (bucket.size === 0) clients.delete(nodusId);
    });
  });

  return server;
}

export function getIceServers(): IceServer[] {
  const fromJson = parseIceServers(process.env.NODUS_ICE_SERVERS_JSON);
  if (fromJson.length > 0) return fromJson;

  const stunUrls = splitUrls(process.env.NODUS_STUN_URLS || "stun:stun.l.google.com:19302");
  const turnUrls = splitUrls(process.env.NODUS_TURN_URLS || process.env.NODUS_TURN_URL);
  const iceServers: IceServer[] = stunUrls.length > 0 ? [{ urls: stunUrls }] : [];

  if (turnUrls.length > 0) {
    const credentials = getTurnCredentials();
    iceServers.push({
      urls: turnUrls,
      username: credentials.username,
      credential: credentials.credential,
    });
  }

  return iceServers.filter((server) => Boolean(server.urls) && (!String(server.urls).startsWith("turn") || (server.username && server.credential)));
}

async function getIceServersForClient(): Promise<IceServer[]> {
  const meteredApp = process.env.METERED_APP_NAME;
  const meteredApiKey = process.env.METERED_TURN_API_KEY;
  if (meteredApp && meteredApiKey) {
    try {
      const response = await fetch(`https://${encodeURIComponent(meteredApp)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(meteredApiKey)}`);
      if (response.ok) {
        const iceServers = await response.json() as IceServer[];
        if (Array.isArray(iceServers) && iceServers.length > 0) return iceServers.filter((server) => Boolean(server?.urls));
      }
    } catch {
      // Keep the configured fallback when the provider is temporarily unavailable.
    }
  }

  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !apiToken) return getIceServers();

  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ttl: 3600 }),
    });
    if (!response.ok) return getIceServers();
    const data = await response.json() as { iceServers?: IceServer[] };
    const iceServers = data.iceServers?.filter((server) => Boolean(server?.urls)) ?? [];
    return iceServers.length > 0 ? iceServers : getIceServers();
  } catch {
    return getIceServers();
  }
}

function getTurnCredentials(): { username?: string; credential?: string } {
  const secret = process.env.NODUS_TURN_SECRET;
  if (!secret) return { username: process.env.NODUS_TURN_USERNAME, credential: process.env.NODUS_TURN_CREDENTIAL };

  const username = `${Math.floor(Date.now() / 1000) + 3600}:nodus`;
  return {
    username,
    credential: createHmac("sha1", secret).update(username).digest("base64"),
  };
}

function parseIceServers(value?: string): IceServer[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as IceServer[];
    return Array.isArray(parsed) ? parsed.filter((server) => Boolean(server?.urls)) : [];
  } catch {
    return [];
  }
}

function splitUrls(value?: string): string[] {
  return value?.split(/[\s,]+/).map((url) => url.trim()).filter(Boolean) ?? [];
}

function setCors(response: ServerResponse) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,PUT,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, authorization");
}

function send(response: ServerResponse, status: number, body = "") {
  response.writeHead(status);
  response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  send(response, status, JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function notify(clients: Map<string, Set<WebSocket>>, nodusId: string, type: string, payload: Record<string, unknown>) {
  for (const socket of clients.get(nodusId) ?? []) sendWs(socket, type, payload);
}

function sendWs(socket: WebSocket, type: string, payload: Record<string, unknown>) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...payload }));
}

function normalizeWsId(input: string | null): string {
  const id = input?.replace(/\D/g, "") ?? "";
  if (id.length !== 9) throw new Error("INVALID_NODUS_ID");
  return id;
}
