import type { LeaseClaims } from "./index.js";

export class OfflineLeaseAnchor {
  private readonly start: number;
  constructor(readonly claims: LeaseClaims, private readonly serverTime: number, private readonly monotonicNow = () => performance.now()) { this.start = monotonicNow(); }
  valid(sessionId: string, deviceId: string): boolean {
    const elapsed = this.monotonicNow() - this.start;
    return elapsed >= 0 && this.claims.sessionId === sessionId && this.claims.deviceId === deviceId && this.claims.exp > this.serverTime + elapsed && this.claims.iat <= this.serverTime;
  }
}
export async function verifyBrowserLease(token: string, publicKey: string): Promise<LeaseClaims> {
  const parts = token.split("."); if (parts.length !== 3 || token.length > 4096) throw new Error("INVALID_LICENSE");
  const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
  const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
  if (header.alg !== "EdDSA" || header.typ !== "JWT") throw new Error("INVALID_LICENSE");
  const der = publicKey.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("spki", decode(der), "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", key, decode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error("INVALID_LICENSE");
  const claims = JSON.parse(new TextDecoder().decode(decode(parts[1]))) as LeaseClaims;
  if (claims.iss !== "nodus-license" || claims.aud !== "nodus-session" || !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || !claims.sessionId || !claims.deviceId || claims.exp <= claims.iat) throw new Error("INVALID_LICENSE");
  return claims;
}
