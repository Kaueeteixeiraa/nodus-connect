import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
import { PresenceRegistry } from "./registry";

describe("PresenceRegistry", () => {
  it("tolerates a delayed 15-second heartbeat but expires abandoned devices", () => {
    vi.useFakeTimers();
    const registry = new PresenceRegistry();
    registry.upsert({ nodusId: "111222333", deviceName: "Notebook" });
    vi.advanceTimersByTime(30_000);
    expect(registry.lookup("111222333")).not.toBeNull();
    registry.heartbeat("111222333");
    vi.advanceTimersByTime(45_001);
    expect(registry.lookup("111222333")).toBeNull();
  });
  it("stores and finds active devices", () => {
    const registry = new PresenceRegistry();
    const record = registry.upsert({
      nodusId: "845 291 637",
      deviceName: "PC-Kaue",
      capabilities: ["presence"],
    });

    expect(record.nodusId).toBe("845291637");
    expect(registry.lookup("845291637")?.deviceName).toBe("PC-Kaue");
  });

  it("prunes expired devices", () => {
    const registry = new PresenceRegistry(1);
    registry.upsert({ nodusId: "111222333", deviceName: "Notebook" });
    registry.pruneExpired(Date.now() + 10);
    expect(registry.lookup("111222333")).toBeNull();
  });

  it("marks a device offline when it closes cleanly", () => {
    const registry = new PresenceRegistry();
    registry.upsert({ nodusId: "111222333", deviceName: "Notebook" });
    expect(registry.offline("111222333").status).toBe("offline");
  });
});
