import { describe, expect, it } from "vitest";
import { PresenceRegistry } from "./registry";

describe("PresenceRegistry", () => {
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
});
