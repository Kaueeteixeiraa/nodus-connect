import type { IncomingMessage, ServerResponse } from "node:http";
import { LicenseError, type LicenseAccessRequest, type LicenseSession } from "../../../packages/licensing/src/index.js";
import { LicenseEngine, requireAdmin, text, validId, type Actor, type DeviceCredentials } from "./engine.js";
import type { LicenseStore } from "./store.js";
import type { PaymentProvider } from "./payments.js";

type Body = Record<string, unknown>;
export interface HttpDependencies { engine: LicenseEngine; store: LicenseStore; authenticate(token: string): Promise<Actor>; admin(actor: Actor, path: string, body: Body): Promise<unknown>; origins: string[]; providers?: ReadonlyMap<string, PaymentProvider>; notifyAccessRequest?(request: LicenseAccessRequest): Promise<boolean>; }
async function rawBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > limit) throw new LicenseError("INVALID_INPUT"); chunks.push(buffer); }
  return Buffer.concat(chunks);
}
async function body(request: IncomingMessage): Promise<Body> {
  const raw = await rawBody(request, 16_384); if (!raw.length) return {};
  try { const value = JSON.parse(raw.toString()); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value as Body; } catch { throw new LicenseError("INVALID_INPUT"); }
}
function credentials(input: Body): DeviceCredentials { return { deviceId: validId(input.deviceId), deviceToken: text(input.deviceToken, 128) }; }
export function createLicenseHandler(deps: HttpDependencies) {
  const checkLimits = new Map<string, { minute: number; count: number }>();
  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff"); response.setHeader("referrer-policy", "no-referrer");
    const send = (status: number, value: unknown) => { response.statusCode = status; response.end(JSON.stringify(value)); };
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const origin = request.headers.origin;
      if (origin && !deps.origins.includes(origin)) throw new LicenseError("FORBIDDEN");
      if (origin) { response.setHeader("access-control-allow-origin", origin); response.setHeader("vary", "Origin"); }
      if (request.method === "OPTIONS") { response.setHeader("access-control-allow-methods", "GET, POST"); response.setHeader("access-control-allow-headers", "Authorization, Content-Type"); return send(204, null); }
      if (request.method === "GET" && path === "/health") return send(200, { ok: true, service: "nodus-license" });
      if (request.method === "GET" && path === "/license/policy") return send(200, await deps.engine.policy());
      const webhook = path.match(/^\/webhooks\/([a-zA-Z0-9_-]+)$/);
      if (request.method === "POST" && webhook) {
        const provider = deps.providers?.get(webhook[1]); if (!provider || provider.name !== webhook[1]) throw new LicenseError("FORBIDDEN");
        let verified;
        try { verified = await provider.verifyWebhook(await rawBody(request, 65_536), request.headers); } catch { throw new LicenseError("FORBIDDEN"); }
        return send(200, await deps.engine.payment({ uid: `webhook-${provider.name}`, admin: true, recent: true }, { licenseId: validId(verified.licenseId), paymentId: validId(verified.paymentId), amountCents: verified.amountCents }, provider.name, validId(verified.eventId)));
      }
      const token = String(request.headers.authorization ?? "").match(/^Bearer ([^\s]+)$/)?.[1]; if (!token || token.length > 16_384) throw new LicenseError("UNAUTHORIZED");
      const actor = await deps.authenticate(token);
      actor.ip = request.socket.remoteAddress;
      const licenseCheck = request.method === "POST" && path === "/license/check";
      // Read-only checks have a bounded per-instance limiter; mutations retain the distributed limiter.
      if (licenseCheck) {
        const minute = Math.floor(Date.now() / 60_000), uid = validId(actor.uid);
        for (const [key, limit] of checkLimits) if (limit.minute !== minute) checkLimits.delete(key);
        const current = checkLimits.get(uid), count = (current?.count ?? 0) + 1;
        if (count > 180 || (!current && checkLimits.size >= 2048)) throw new LicenseError("FORBIDDEN");
        checkLimits.set(uid, { minute, count });
      }
      if (!licenseCheck && !(actor.admin && request.method === "GET" && path.startsWith("/admin/"))) await deps.store.transaction(async tx => {
        const minute = Math.floor(Date.now() / 60_000); const key = `license_rate_limits/${validId(actor.uid)}`;
        const current = await tx.get<{ minute: number; count: number }>(key);
        const count = current?.minute === minute ? current.count + 1 : 1;
        if (count > 180) throw new LicenseError("FORBIDDEN"); tx.set(key, { minute, count });
      });
      const input = request.method === "POST" ? await body(request) : {};
      if (path.startsWith("/admin/")) { requireAdmin(actor, request.method !== "GET" && path !== "/admin/details"); return send(200, await deps.admin(actor, `${request.method} ${path}`, input)); }
      if (request.method !== "POST") return send(404, { code: "INVALID_INPUT" });
      if (path === "/license/enroll") return send(200, await deps.engine.enroll(actor, { deviceId: validId(input.deviceId), nodusId: text(input.nodusId, 9), deviceName: text(input.deviceName), deviceClaim: text(input.deviceClaim, 128) }));
      if (path === "/license/check") return send(200, await deps.engine.info(actor, credentials(input)));
      if (path === "/license/activate") return send(200, await deps.engine.activate(actor, credentials(input), text(input.key, 128)));
      if (path === "/license/access-requests") {
        const result = await deps.engine.requestAccesses(actor, credentials(input));
        let notificationStatus = result.request.notificationStatus;
        if (!result.duplicate || notificationStatus === "FAILED") {
          const sent = await deps.notifyAccessRequest?.(result.request).catch(() => false) ?? false;
          notificationStatus = sent ? "SENT" : "FAILED";
          await deps.store.transaction(async tx => {
            const current = await tx.get<LicenseAccessRequest>(`license_access_requests/${result.request.id}`);
            if (current?.status === "PENDING") tx.set(`license_access_requests/${current.id}`, { ...current, notificationStatus: sent ? "SENT" : "FAILED", updatedAt: Date.now() });
          });
        }
        return send(200, { requestId: result.request.id, duplicate: result.duplicate, notificationStatus });
      }
      if (path === "/license/sessions/reserve") return send(200, await deps.engine.reserve(actor, credentials(input), { sessionId: validId(input.sessionId), targetNodusId: text(input.targetNodusId, 9), offline: input.offline === true }));
      const lifecycle = path.match(/^\/license\/sessions\/(establish|heartbeat|end)$/);
      if (lifecycle) return send(200, await deps.engine.lifecycle(actor, validId(input.sessionId), lifecycle[1] as "establish" | "heartbeat" | "end"));
      if (path === "/license/transport/identity") {
        if (!/^\d{9}$/.test(String(input.nodusId))) throw new LicenseError("INVALID_INPUT");
        const device = await deps.store.transaction(tx => tx.get<{ ownerUid: string }>(`devices/${input.nodusId}`));
        if (device?.ownerUid !== actor.uid) throw new LicenseError("FORBIDDEN");
        return send(200, { allowed: true, enforced: (await deps.engine.policy()).enforced });
      }
      if (path === "/license/transport/authorize") {
        if (input.kind === "request") await deps.store.transaction(async tx => {
          const from = text(input.from, 9);
          const device = await tx.get<{ ownerUid: string }>(`devices/${from}`);
          if (device?.ownerUid !== actor.uid) throw new LicenseError("FORBIDDEN");
          const block = await tx.get<{ blocked: boolean }>(`license_access_blocks/${from}`);
          if (block?.blocked) throw new LicenseError("DEVICE_REVOKED");
        });
        const policy = await deps.engine.policy(); if (!policy.enforced) return send(200, { allowed: true, enforced: false });
        await deps.store.transaction(async tx => {
          const id = validId(input.sessionId);
          const session = await tx.get<LicenseSession>(`license_sessions/${id}`);
          const source = session?.requesterUid === actor.uid && input.from === session.requesterNodusId && input.to === session.targetNodusId;
          const target = session?.targetUid === actor.uid && input.from === session.targetNodusId && input.to === session.requesterNodusId;
          if (!session || session.status === "ENDED" || (!source && !target) || (session.status === "RESERVED" && session.expiresAt <= Date.now()) || (input.kind === "request" && !source) || (input.kind === "accept" && !target) || !["request", "accept", "signal"].includes(String(input.kind))) throw new LicenseError("FORBIDDEN");
          if (input.kind === "request") {
            if (session.status !== "RESERVED" || await tx.get(`license_transport_admissions/${id}`) || await tx.get(`sessionRequests/${id}`) || await tx.get(`sessions/${id}`)) throw new LicenseError("FORBIDDEN");
            tx.set(`license_transport_admissions/${id}`, { sessionId: id, transport: "relay", createdAt: Date.now() });
          } else if (!await tx.get(`license_transport_admissions/${id}`)) throw new LicenseError("FORBIDDEN");
        });
        return send(200, { allowed: true, enforced: true });
      }
      return send(404, { code: "INVALID_INPUT" });
    } catch (error) {
      const code = error instanceof LicenseError ? error.code : "SERVER_UNAVAILABLE";
      // No exception messages, request bodies, Firebase tokens or keys enter logs/responses.
      console.warn(JSON.stringify({ event: "LICENSE_API_DENIED", code }));
      return send(code === "UNAUTHORIZED" ? 401 : ["FORBIDDEN", "REAUTH_REQUIRED"].includes(code) ? 403 : code === "SERVER_UNAVAILABLE" ? 503 : 409, { code });
    }
  };
}
