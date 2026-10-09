import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const { createDeviceIdentityStore, normalizeHardware, hardwareIdentity, collectHardwareIdentity } = createRequire(import.meta.url)("../apps/desktop/electron/device-identity.cjs");
const directories: string[] = [];

afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nodus-identity-"));
  directories.push(directory);
  return { directory, store: createDeviceIdentityStore(directory) };
}

describe("native device identity", () => {
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
