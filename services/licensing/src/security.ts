import { createHmac, randomBytes, sign, verify, timingSafeEqual, createPublicKey } from "node:crypto";
import { LicenseError, type LeaseClaims } from "../../../packages/licensing/src/index.js";

export function secretHash(value: string, pepper: string): string {
  if (pepper.length < 32) throw new Error("LICENSE_PEPPER_NOT_CONFIGURED");
  return createHmac("sha256", pepper).update(value).digest("hex");
}
export function matchesSecret(value: string, hash: string, pepper: string): boolean {
  const actual = Buffer.from(secretHash(value, pepper)); const expected = Buffer.from(hash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function newLicenseKey(): string { return `NODUS-${randomBytes(20).toString("hex").toUpperCase().match(/.{1,8}/g)!.join("-")}`; }
export function newDeviceToken(): string { return randomBytes(32).toString("base64url"); }
export function signLease(claims: LeaseClaims, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  if (createPublicKey(privateKey).asymmetricKeyType !== "ed25519") throw new Error("LICENSE_SIGNING_KEY_INVALID");
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}
export function verifyLease(token: string, publicKey: string, serverTime: number): LeaseClaims {
  try {
    if (token.length > 4096 || !Number.isFinite(serverTime)) throw new Error();
    const parts = token.split("."); if (parts.length !== 3) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (header.alg !== "EdDSA" || header.typ !== "JWT" || createPublicKey(publicKey).asymmetricKeyType !== "ed25519") throw new Error();
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], "base64url"))) throw new Error();
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as LeaseClaims;
    if (claims.iss !== "nodus-license" || claims.aud !== "nodus-session" || !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) || claims.iat > serverTime || claims.exp <= serverTime || !claims.sessionId || !claims.deviceId || !claims.requesterUid || !claims.targetUid) throw new Error();
    return claims;
  } catch { throw new LicenseError("INVALID_LICENSE"); }
}
