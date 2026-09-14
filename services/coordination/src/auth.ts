import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type StoredAccount = { id: string; email: string; name: string; salt: string; passwordHash: string; createdAt: string };
type AuthPayload = { sub: string; email: string; exp: number };

export class AuthRegistry {
  private accounts = new Map<string, StoredAccount>();
  private failures = new Map<string, { count: number; blockedUntil: number }>();
  private readonly secret: string;
  private readonly file: string;

  constructor(file = process.env.NODUS_AUTH_FILE || "data/auth.json", secret = process.env.NODUS_AUTH_SECRET || "") {
    this.file = file;
    this.secret = secret;
    this.load();
  }

  register(emailInput: string, password: string, nameInput: string) {
    const email = normalizeEmail(emailInput);
    const name = nameInput.trim().slice(0, 120);
    if (!email || !name || password.length < 10) throw new Error("INVALID_AUTH_DATA");
    if (!this.secret) throw new Error("AUTH_NOT_CONFIGURED");
    if (this.accounts.has(email)) throw new Error("AUTH_EMAIL_EXISTS");
    const salt = randomBytes(16).toString("hex");
    const account: StoredAccount = { id: randomBytes(16).toString("hex"), email, name, salt, passwordHash: hashPassword(password, salt), createdAt: new Date().toISOString() };
    this.accounts.set(email, account);
    this.save();
    return this.session(account);
  }

  login(emailInput: string, password: string) {
    const email = normalizeEmail(emailInput);
    const attempt = this.failures.get(email);
    if (attempt?.blockedUntil && attempt.blockedUntil > Date.now()) throw new Error("AUTH_RATE_LIMITED");
    const account = this.accounts.get(email);
    if (!account || !verifyPassword(password, account.salt, account.passwordHash)) {
      const next = { count: (attempt?.count || 0) + 1, blockedUntil: 0 };
      if (next.count >= 5) next.blockedUntil = Date.now() + 60_000;
      this.failures.set(email, next);
      throw new Error("AUTH_INVALID_CREDENTIALS");
    }
    this.failures.delete(email);
    return this.session(account);
  }

  verify(token: string): AuthPayload {
    if (!this.secret) throw new Error("AUTH_NOT_CONFIGURED");
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) throw new Error("AUTH_INVALID_TOKEN");
    const expected = sign(encoded, this.secret);
    if (!safeEqual(signature, expected)) throw new Error("AUTH_INVALID_TOKEN");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AuthPayload;
    if (!payload.sub || !payload.email || payload.exp < Date.now()) throw new Error("AUTH_EXPIRED_TOKEN");
    return payload;
  }

  private session(account: StoredAccount) {
    const payload: AuthPayload = { sub: account.id, email: account.email, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return { token: `${encoded}.${sign(encoded, this.secret)}`, user: { id: account.id, email: account.email, name: account.name } };
  }

  private load() {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as StoredAccount[];
      for (const account of value) if (account.email && account.passwordHash) this.accounts.set(account.email, account);
    } catch {}
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.accounts.values()], null, 2), "utf8");
  }
}

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password: string, salt: string, expected: string) {
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
