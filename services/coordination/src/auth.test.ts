import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { AuthRegistry } from "./auth";

const file = "./.tmp-auth-test.json";
afterEach(() => rmSync(file, { force: true }));

describe("AuthRegistry", () => {
  it("registers, logs in and verifies a signed session", () => {
    const auth = new AuthRegistry(file, "test-secret");
    const created = auth.register("User@Example.com", "uma-senha-segura", "Usuario");
    expect(auth.verify(created.token).email).toBe("user@example.com");
    expect(auth.login("user@example.com", "uma-senha-segura").user.name).toBe("Usuario");
  });

  it("rejects invalid credentials", () => {
    const auth = new AuthRegistry(file, "test-secret");
    auth.register("user@example.com", "uma-senha-segura", "Usuario");
    expect(() => auth.login("user@example.com", "senha-errada")).toThrow("AUTH_INVALID_CREDENTIALS");
  });

  it("limits repeated invalid logins", () => {
    const auth = new AuthRegistry(file, "test-secret");
    auth.register("user@example.com", "uma-senha-segura", "Usuario");
    for (let attempt = 0; attempt < 5; attempt++) expect(() => auth.login("user@example.com", "senha-errada")).toThrow("AUTH_INVALID_CREDENTIALS");
    expect(() => auth.login("user@example.com", "uma-senha-segura")).toThrow("AUTH_RATE_LIMITED");
  });
});
