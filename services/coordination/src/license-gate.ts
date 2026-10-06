import { createHash } from "node:crypto";
import { LicenseError, LICENSE_MESSAGES } from "../../../packages/licensing/src/index.js";

export class RelayLicenseGate {
  private policy?: { enforced: boolean; until: number };
  private policyRequest?: Promise<boolean>;
  private cache = new Map<string, number>();
  constructor(private readonly base = process.env.NODUS_LICENSE_API ?? "", private readonly fetcher = fetch) {
    if (base) { const url = new URL(base); if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("INVALID_LICENSE_API"); }
  }
  private async call(path: string, token?: string, body?: object) {
    try {
      const response = await this.fetcher(`${this.base.replace(/\/$/, "")}${path}`, { method: body ? "POST" : "GET", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
      const value = await response.json() as { allowed?: boolean; enforced?: boolean; code?: string };
      if (!response.ok) throw new LicenseError(value.code && Object.hasOwn(LICENSE_MESSAGES, value.code) ? value.code as keyof typeof LICENSE_MESSAGES : "SERVER_UNAVAILABLE");
      return value;
    } catch (error) { throw error instanceof LicenseError ? error : new LicenseError("SERVER_UNAVAILABLE"); }
  }
  async enforced(): Promise<boolean> {
    if (!this.base) return false;
    if (this.policy && this.policy.until > Date.now()) return this.policy.enforced;
    this.policyRequest ??= this.call("/license/policy").then(value => {
      if (typeof value.enforced !== "boolean") throw new LicenseError("SERVER_UNAVAILABLE");
      this.policy = { enforced: value.enforced, until: Date.now() + 2000 }; return value.enforced;
    });
    try { return await this.policyRequest; } finally { this.policyRequest = undefined; }
  }
  async authorize(token: string, body: { kind: "identity"; nodusId: string } | { kind: "request" | "accept" | "signal"; sessionId?: string; from: string; to: string }) {
    const enforced = await this.enforced();
    if (!enforced && (!this.base || body.kind !== "request")) return;
    if (!token || token.length > 16_384) throw new LicenseError("UNAUTHORIZED");
    const cacheable = body.kind === "identity" || body.kind === "signal";
    const key = createHash("sha256").update(token).update(JSON.stringify(body)).digest("hex");
    if (cacheable && (this.cache.get(key) ?? 0) > Date.now()) return;
    const value = await this.call(body.kind === "identity" ? "/license/transport/identity" : "/license/transport/authorize", token, body);
    if (!value.allowed || (enforced && !value.enforced)) throw new LicenseError("FORBIDDEN");
    if (cacheable) {
      if (this.cache.size > 10_000) for (const [id, until] of this.cache) if (until <= Date.now()) this.cache.delete(id);
      if (this.cache.size >= 10_000) throw new LicenseError("SERVER_UNAVAILABLE");
      this.cache.set(key, Date.now() + (body.kind === "identity" ? 5000 : 30_000));
    }
  }
}
