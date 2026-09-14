import { describe, expect, it } from "vitest";
import { SignalingRegistry } from "./signaling";

describe("SignalingRegistry", () => {
  it("creates, accepts and exchanges signals", () => {
    const registry = new SignalingRegistry();
    const request = registry.createRequest({
      requesterNodusId: "111 222 333",
      requesterName: "A",
      targetNodusId: "444 555 666",
      requestedPermissions: ["screen:view", "mouse:control", "files:transfer"],
    });

    const accepted = registry.acceptRequest(request.id, "B", ["screen:view", "mouse:control"]);
    registry.addSignal({
      sessionId: accepted.sessionId!,
      from: "444555666",
      to: "111222333",
      type: "offer",
      payload: { type: "offer", sdp: "test" },
    });

    expect(accepted.status).toBe("accepted");
    expect(accepted.grantedPermissions).toEqual(["screen:view", "mouse:control"]);
    expect(registry.getSignals(accepted.sessionId!, "111222333")).toHaveLength(1);
  });

  it("expires pending requests", () => {
    const registry = new SignalingRegistry(1);
    const request = registry.createRequest({
      requesterNodusId: "111222333",
      requesterName: "A",
      targetNodusId: "444555666",
    });

    registry.pruneExpired(Date.parse(request.createdAt) + 10);

    expect(registry.listPending("444555666")).toHaveLength(0);
  });
});
