import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createDeviceIdentityStore, createWindowsIdentityRecovery, normalizeHardware, hardwareIdentity, collectHardwareIdentity } = createRequire(import.meta.url)("../apps/desktop/electron/device-identity.cjs");
const directories: string[] = [];

afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nodus-identity-"));
  directories.push(directory);
  return { directory, store: createDeviceIdentityStore(directory) };
}

function registryFixture() {
  const values = new Map<string, string>();
  const safeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`protected:${value}`)),
    decryptString: vi.fn((value: Buffer) => {
      const text = value.toString();
      if (!text.startsWith("protected:")) throw new Error("DECRYPT_FAILED");
      return text.slice(10);
    }),
  };
  const execute = vi.fn((_file: string, args: string[], options: { input?: string }) => {
    const scope = args[1];
    if (options.input) values.set(scope, options.input);
    return { status: 0, stdout: options.input ? "" : JSON.stringify(values.get(scope) ?? null) };
  });
  const recovery = (scope = "Desktop") => createWindowsIdentityRecovery(safeStorage, scope, "nodus-service.exe", execute);
  return { values, safeStorage, execute, recovery };
}

describe("native device identity", () => {
  it("restores the same ID and device claim after all application data is deleted", () => {
    const { directory } = fixture(), registry = registryFixture();
    const original = createDeviceIdentityStore(directory, { recovery: registry.recovery() }).loadOrCreate(null);
    fs.rmSync(directory, { recursive: true, force: true });
    const recovered = createDeviceIdentityStore(directory, { recovery: registry.recovery() }).loadOrCreate(null);
    expect(recovered).toEqual(original);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "identity.json"), "utf8")).deviceSecret).toBeTruthy();
  });
  it("backs up the existing ID without replacing it during an upgrade", () => {
    const { directory, store } = fixture(), registry = registryFixture();
    const original = store.loadOrCreate(null);
    expect(createDeviceIdentityStore(directory, { recovery: registry.recovery() }).loadOrCreate(null)).toEqual(original);
    fs.rmSync(directory, { recursive: true, force: true });
    expect(createDeviceIdentityStore(directory, { recovery: registry.recovery() }).loadOrCreate(null)).toEqual(original);
  });
  it("recovers both corrupted native files from the protected copy", () => {
    const { directory } = fixture(), registry = registryFixture();
    const store = createDeviceIdentityStore(directory, { recovery: registry.recovery() });
    const original = store.loadOrCreate(null);
    fs.writeFileSync(store.paths.primaryPath, "{invalid");
    fs.writeFileSync(store.paths.backupPath, "{invalid");
    expect(createDeviceIdentityStore(directory, { recovery: registry.recovery() }).loadOrCreate(null)).toEqual(original);
  });
  it("restores a renamed device and never replaces its ID with an old renderer cache", () => {
    const { directory } = fixture(), registry = registryFixture();
    const store = createDeviceIdentityStore(directory, { recovery: registry.recovery() });
    const original = store.loadOrCreate(null);
    const renamed = store.updateMutable({ ...original, deviceName: "Cliente", deviceNameConfirmed: true });
    fs.rmSync(directory, { recursive: true, force: true });
    expect(createDeviceIdentityStore(directory, { recovery: registry.recovery() }).loadOrCreate({ ...original, nodusId: "999 999 999" })).toEqual(renamed);
  });
  it("keeps desktop and different QuickSupport profiles isolated", () => {
    const registry = registryFixture();
    const scopes = ["Desktop", "QuickSupport-profile-a", "QuickSupport-profile-b"];
    const identities = scopes.map(scope => {
      const { directory } = fixture();
      const original = createDeviceIdentityStore(directory, { recovery: registry.recovery(scope) }).loadOrCreate(null);
      fs.rmSync(directory, { recursive: true, force: true });
      expect(createDeviceIdentityStore(directory, { recovery: registry.recovery(scope) }).loadOrCreate(null)).toEqual(original);
      return original.deviceId;
    });
    expect(new Set(identities).size).toBe(3);
  });
  it("does not regenerate identity when recovery is unavailable or cannot be decrypted", () => {
    const { directory } = fixture(), registry = registryFixture();
    registry.values.set("Desktop", Buffer.from("unreadable").toString("base64"));
    expect(() => createDeviceIdentityStore(directory, { recovery: registry.recovery() }).loadOrCreate(null)).toThrow("DECRYPT_FAILED");
    registry.execute.mockReturnValue({ status: 1, stdout: "" });
    expect(() => createDeviceIdentityStore(directory, { recovery: registry.recovery() }).loadOrCreate(null)).toThrow("IDENTITY_RECOVERY_UNAVAILABLE");
    expect(fs.existsSync(path.join(directory, "identity.json"))).toBe(false);
  });
  it("rejects a malformed recovered identity without silently rotating its secret", () => {
    const { directory } = fixture(), registry = registryFixture();
    const original = createDeviceIdentityStore(directory).loadOrCreate(null);
    registry.recovery().save(original);
    fs.rmSync(directory, { recursive: true, force: true });
    expect(() => createDeviceIdentityStore(directory, { recovery: registry.recovery() }).loadOrCreate(null)).toThrow("INVALID_IDENTITY_RECOVERY");
    expect(fs.existsSync(path.join(directory, "identity.json"))).toBe(false);
  });
  it("encrypts recovery data through safeStorage, excludes plaintext arguments and avoids repeated writes", () => {
    const { directory } = fixture(), registry = registryFixture();
    const store = createDeviceIdentityStore(directory, { recovery: registry.recovery() });
    const original = store.loadOrCreate(null), calls = registry.execute.mock.calls.length;
    expect(store.loadOrCreate(null)).toEqual(original);
    expect(registry.execute).toHaveBeenCalledTimes(calls);
    expect(registry.safeStorage.encryptString).toHaveBeenCalledOnce();
    const argumentsUsed = JSON.stringify(registry.execute.mock.calls.map(call => call[1]));
    expect(argumentsUsed).not.toContain(original.deviceClaim);
    expect(argumentsUsed).not.toContain(original.nodusId);
    expect(registry.execute.mock.calls.every(call => call[2].input === undefined || /^[A-Za-z0-9+/]+=*$/.test(call[2].input))).toBe(true);
  });
  it("rejects invalid scopes and never writes unencrypted recovery data", () => {
    const registry = registryFixture();
    expect(() => registry.recovery("Desktop';Remove-Item")).toThrow("INVALID_IDENTITY_SCOPE");
    registry.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    expect(() => registry.recovery().save({})).toThrow("IDENTITY_ENCRYPTION_UNAVAILABLE");
    expect(registry.execute).not.toHaveBeenCalled();
  });
  it.each([JSON.stringify("not-base64"), JSON.stringify("A".repeat(8193)), "{"])("rejects malformed or oversized recovery payload", output => {
    const registry = registryFixture();
    registry.execute.mockReturnValue({ status: 0, stdout: output });
    expect(() => registry.recovery().load()).toThrow();
    expect(registry.safeStorage.decryptString).not.toHaveBeenCalled();
  });
  it("enables Windows recovery only for real packaged profiles, preserving development isolation", () => {
    const source = fs.readFileSync(path.resolve("apps/desktop/electron/main.cjs"), "utf8");
    expect(source).toContain('app.isPackaged && process.platform === "win32" && !userDataDir && !isDev');
    expect(source).toContain('supportProfile ? `QuickSupport-${supportProfile.id}` : "Desktop"');
  });
  it("uses hardware independently of installation, disk, remote ID and Windows account", () => {
    const signals = { system: "c4927a20-b74c-4f36-bfd4-3a38d13205dc", board: "BOARD-ABCDE", boardMaker: "Example", bios: "BIOS-ABCDE", manufacturer: "Physical PC" };
    const first = hardwareIdentity(signals);
    expect(hardwareIdentity({ ...signals, disk: "REPLACED", machineGuid: "NEW", nodusId: "987654321", user: "NEW" })).toEqual(first);
    expect(hardwareIdentity({ ...signals, system: signals.system.toUpperCase(), board: " board-abcde " })).toEqual(first);
    expect(first.anchors).toEqual({ system: expect.stringMatching(/^[a-f0-9]{64}$/), board: expect.stringMatching(/^[a-f0-9]{64}$/), bios: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(first)).not.toContain("ABCDE");
  });
  it.each(["", "Default String", "To be filled by O.E.M.", "00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "System Serial Number", "123456789", "unknown"])("rejects generic hardware %s", value => {
    expect(normalizeHardware(value)).toBe("");
    expect(hardwareIdentity({ system: value, board: value, bios: value }).anchors).toEqual({});
  });
  it("flags virtual systems and does not count a repeated board/BIOS serial twice", () => {
    const result = hardwareIdentity({ board: "BOARD-ABCDE", bios: "BOARD-ABCDE", manufacturer: "Microsoft Corporation Virtual Machine" });
    expect(result.virtual).toBe(true); expect(Object.keys(result.anchors)).toEqual(["board"]);
  });
  it("bounds failed collection asynchronously without generating a fake hardware identifier", async () => {
    const result = await collectHardwareIdentity((_file: string, _args: unknown, options: any, done: Function) => {
      expect(options.windowsHide).toBe(true); expect(options.timeout).toBe(6000);
      done(new Error("WMI_UNAVAILABLE"), "");
    });
    expect(result).toEqual({ version: 1, anchors: {}, virtual: false });
  });
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
    expect(first.deviceClaim).toMatch(/^[a-f0-9]{64}$/);
    expect(first.deviceSecret).toBeUndefined();
  });

  it("allows mutable device fields without accepting identity replacement", () => {
    const { store } = fixture();
    const original = store.loadOrCreate(null);
    const saved = store.updateMutable({ ...original, nodusId: "999 999 999", deviceId: "attacker-device-id", deviceName: "Novo nome", deviceNameConfirmed: true });

    expect(saved.nodusId).toBe(original.nodusId);
    expect(saved.deviceId).toBe(original.deviceId);
    expect(saved.deviceFingerprint).toBe(original.deviceFingerprint);
    expect(saved.deviceClaim).toBe(original.deviceClaim);
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
    expect(recovered.deviceClaim).toBe(original.deviceClaim);
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
    expect(source.match(/async function app[\s\S]*?^}/m)?.[0]).toContain('item.name === "[DEFAULT]"');
    expect(source.match(/async function app[\s\S]*?^}/m)?.[0]).not.toContain("getApps()[0]");
    expect(source).toContain("claimDeviceOwnership(identity, uid)");
  });

  it("allows legacy presence records to acquire their first device claim", () => {
    const rules = fs.readFileSync(path.resolve("firestore.rules"), "utf8");
    expect(rules).toContain("!('deviceId' in get(/databases/$(database)/documents/devices/$(nodusId)).data)");
    expect(rules).toContain("!('deviceFingerprint' in get(/databases/$(database)/documents/devices/$(nodusId)).data)");
    expect(rules).toContain("resource.data.ownerUid == request.auth.uid");
    expect(rules).toContain("!('deviceId' in resource.data)");
  });
});
