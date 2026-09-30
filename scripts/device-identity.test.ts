import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const { createDeviceIdentityStore } = createRequire(import.meta.url)("../apps/desktop/electron/device-identity.cjs");
const directories: string[] = [];

afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nodus-identity-"));
  directories.push(directory);
  return { directory, store: createDeviceIdentityStore(directory) };
}

describe("native device identity", () => {
  it("migrates the legacy cache once and remains stable after restart, logout and cache clearing", () => {
    const { directory, store } = fixture();
    const legacy = { nodusId: "123 456 789", deviceName: "PC-Teste", deviceNameConfirmed: true, createdAt: "2026-01-01T00:00:00.000Z" };
    const first = store.loadOrCreate(legacy);
    const restarted = createDeviceIdentityStore(directory).loadOrCreate(null);
    const afterAccountChange = createDeviceIdentityStore(directory).loadOrCreate({ ...legacy, nodusId: "987 654 321" });

    expect(first.nodusId).toBe(legacy.nodusId);
    expect(restarted).toEqual(first);
    expect(afterAccountChange).toEqual(first);
    expect(first.deviceId).toBeTruthy();
    expect(first.deviceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.deviceSecret).toBeUndefined();
  });

  it("allows mutable device fields without accepting identity replacement", () => {
    const { store } = fixture();
    const original = store.loadOrCreate(null);
    const saved = store.updateMutable({ ...original, nodusId: "999 999 999", deviceId: "attacker-device-id", deviceName: "Novo nome", deviceNameConfirmed: true });

    expect(saved.nodusId).toBe(original.nodusId);
    expect(saved.deviceId).toBe(original.deviceId);
    expect(saved.deviceFingerprint).toBe(original.deviceFingerprint);
    expect(saved.deviceName).toBe("Novo nome");
    expect(saved.deviceNameConfirmed).toBe(true);
  });

  it("recovers a corrupted primary identity from the native backup", () => {
    const { store } = fixture();
    const original = store.loadOrCreate(null);
    fs.writeFileSync(store.paths.primaryPath, "{corrompido");

    const recovered = store.loadOrCreate(null);
    expect(recovered).toEqual(original);
    expect(JSON.parse(fs.readFileSync(store.paths.primaryPath, "utf8")).nodusId).toBe(original.nodusId);
  });

  it("preserves device cryptography when recovering an interrupted legacy migration", () => {
    const { store } = fixture();
    const original = store.loadOrCreate(null);
    fs.writeFileSync(store.paths.primaryPath, JSON.stringify({
      nodusId: original.nodusId,
      deviceName: original.deviceName,
      deviceNameConfirmed: false,
      createdAt: original.createdAt,
    }));

    const recovered = store.loadOrCreate(null);
    expect(recovered.deviceId).toBe(original.deviceId);
    expect(recovered.deviceFingerprint).toBe(original.deviceFingerprint);
  });

  it("does not generate a new identity after a temporary native read failure", () => {
    const { directory } = fixture();
    const io = { ...fs, readFileSync: () => { throw Object.assign(new Error("temporarily unavailable"), { code: "EACCES" }); } };
    const store = createDeviceIdentityStore(directory, { fs: io });

    expect(() => store.loadOrCreate(null)).toThrow("temporarily unavailable");
    expect(fs.existsSync(store.paths.primaryPath)).toBe(false);
  });

  it("keeps separate installations isolated by their native user-data directory", () => {
    const first = fixture().store.loadOrCreate(null);
    const second = fixture().store.loadOrCreate(null);
    expect(second.nodusId).not.toBe(first.nodusId);
    expect(second.deviceId).not.toBe(first.deviceId);
  });

  it("never regenerates identity when online registration reports a conflict", () => {
    const appSource = fs.readFileSync(path.resolve("apps/desktop/src/App.tsx"), "utf8");
    expect(appSource).not.toContain("regenerateNodusId");
    expect(appSource).toContain("identity-conflict nodusId=${identity.nodusId} preserved=true");
  });

  it("keeps Google account authentication separate from device coordination", () => {
    const source = fs.readFileSync(path.resolve("apps/desktop/src/core/firebase.ts"), "utf8");
    expect(source.match(/export async function signInFirebaseWithGoogle[\s\S]*?^}/m)?.[0]).toContain("accountAuth()");
    expect(source.match(/async function ensureDeviceUid[\s\S]*?^}/m)?.[0]).toContain("signInAnonymously");
  });
});
