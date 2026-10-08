import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { exportSettingsBackup, hideDeviceFromCatalog, importSettingsBackup, loadFavorites, loadHiddenCatalogDevices, loadRecents, loadSettings, renameDevice, saveRecent, saveSettings, toggleFavorite, updateDevicePresence } from "../apps/desktop/src/core/storage";

const values = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
});

beforeEach(() => values.clear());

describe("device catalog", () => {
  it("restores a removed device on reconnect without restoring other devices or losing metadata", () => {
    const device = { nodusId: "123456789", deviceName: "Cliente", status: "online" as const, updatedAt: new Date().toISOString(), capabilities: [] };
    saveRecent(device);
    renameDevice(device.nodusId, "Suporte");
    toggleFavorite(device.nodusId);
    hideDeviceFromCatalog(device.nodusId);
    hideDeviceFromCatalog("987654321");
    updateDevicePresence(device.nodusId, device);
    expect(loadHiddenCatalogDevices()).toContain(device.nodusId);

    const visible = saveRecent(device).filter(item => !loadHiddenCatalogDevices().includes(item.nodusId));
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ nodusId: device.nodusId, alias: "Suporte", favorite: true });
    expect(loadHiddenCatalogDevices()).toEqual(["987654321"]);
    expect(loadFavorites()).toEqual([device.nodusId]);
    expect(loadRecents()).toEqual(visible);

    hideDeviceFromCatalog(device.nodusId);
    saveRecent(device);
    expect(loadHiddenCatalogDevices()).toEqual(["987654321"]);
    expect(loadRecents()).toHaveLength(1);
  });
});

describe("settings backup", () => {
  it("dark feudal Japan uses its own footer palette without changing the online indicator", () => {
    const css = readFileSync("apps/desktop/src/styles.css", "utf8");
    expect(css).toContain(':root[data-theme="japan-dark"] .workspace-footer { background: var(--theme-panel); border-color: var(--theme-line); color: var(--text-soft); }');
    expect(css).toContain(':root[data-theme="japan-dark"] .workspace-footer svg { color: var(--theme-accent); }');
    expect(css).not.toContain(':root[data-theme="japan-dark"] .footer-online');
  });
  it("preserves dark feudal Japan across save, reload and backup restore", () => {
    saveSettings({ ...loadSettings(), theme: "japan-dark" });
    expect(loadSettings().theme).toBe("japan-dark");
    const backup = exportSettingsBackup();
    saveSettings({ ...loadSettings(), theme: "dark" });
    expect(importSettingsBackup(backup).settings.theme).toBe("japan-dark");
    expect(loadSettings().theme).toBe("japan-dark");
  });
  it("keeps session indicators enabled for old settings and persists the toggle in backups", () => {
    values.set("nodus.settings.v1", JSON.stringify({ theme: "dark" }));
    expect(loadSettings().showConnectionMetrics).toBe(true);
    saveSettings({ ...loadSettings(), showConnectionMetrics: false });
    expect(loadSettings().showConnectionMetrics).toBe(false);
    const backup = exportSettingsBackup();
    saveSettings({ ...loadSettings(), showConnectionMetrics: true });
    expect(importSettingsBackup(backup).settings.showConnectionMetrics).toBe(false);
    values.set("nodus.settings.v1", JSON.stringify({ showConnectionMetrics: "false" }));
    expect(loadSettings().showConnectionMetrics).toBe(true);
  });
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
