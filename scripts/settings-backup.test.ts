import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportSettingsBackup, importSettingsBackup, loadSettings, saveSettings } from "../apps/desktop/src/core/storage";

const values = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
});

beforeEach(() => values.clear());

describe("settings backup", () => {
  it("exports preferences without identity, passwords or connection credentials", () => {
    saveSettings({ ...loadSettings(), accessPasswordHash: "secret-hash", coordinationUrl: "https://private", iceServersJson: "[{\"credential\":\"secret\"}]" });
    values.set("nodus.recents.v1", JSON.stringify([{ nodusId: "123456789", deviceName: "PC", lastConnectionAt: new Date().toISOString(), status: "online", favorite: true, macAddress: "AA:BB:CC:DD:EE:FF" }]));
    const backup = JSON.parse(exportSettingsBackup());
    expect(backup.settings).not.toHaveProperty("accessPasswordHash");
    expect(backup.settings).not.toHaveProperty("coordinationUrl");
    expect(backup.settings).not.toHaveProperty("iceServersJson");
    expect(backup.recents[0]).not.toHaveProperty("macAddress");
    expect(JSON.stringify(backup)).not.toContain("secret");
  });

  it("validates and restores safe data without replacing critical local values", () => {
    saveSettings({ ...loadSettings(), accessPasswordHash: "keep-me", coordinationUrl: "https://current" });
    const currentCoordinationUrl = loadSettings().coordinationUrl;
    const restored = importSettingsBackup(JSON.stringify({
      format: "nodus-connect-settings",
      version: 1,
      settings: { theme: "arctic", maxFps: 120, accessPasswordHash: "replace-me", coordinationUrl: "https://attacker" },
      favorites: ["123456789", "invalid"],
      folders: [{ id: "support", name: "Suporte", createdAt: "2026-09-30T00:00:00.000Z" }],
      recents: [{ nodusId: "123456789", deviceName: "Cliente", folderId: "support", status: "online", favorite: true, lastConnectionAt: "2026-09-30T00:00:00.000Z", macAddress: "AA" }],
    }));
    expect(restored.settings).toMatchObject({ theme: "arctic", maxFps: 120, accessPasswordHash: "keep-me", coordinationUrl: currentCoordinationUrl });
    expect(restored.settings.coordinationUrl).not.toBe("https://attacker");
    expect(restored.favorites).toEqual(["123456789"]);
    expect(restored.recents[0]).toMatchObject({ nodusId: "123456789", status: "offline", favorite: true, folderId: "support" });
    expect(restored.recents[0]).not.toHaveProperty("macAddress");
  });

  it.each(["not-json", JSON.stringify({ format: "wrong", version: 1 }), JSON.stringify({ format: "nodus-connect-settings", version: 2 })])("rejects invalid or incompatible files", (raw) => {
    expect(() => importSettingsBackup(raw)).toThrow();
  });
});
