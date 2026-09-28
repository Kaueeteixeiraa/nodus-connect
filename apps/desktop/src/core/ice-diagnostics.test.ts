import { describe, expect, it } from "vitest";
import { holdSelectedRoute, iceServerInfo, iceSignalCandidate, inspectIceStats, withConfiguredStun } from "./ice-diagnostics";

describe("ICE diagnostics", () => {
  const candidates = [
    { id: "lh", type: "local-candidate", candidateType: "host", protocol: "udp", priority: 100 },
    { id: "ls", type: "local-candidate", candidateType: "srflx", protocol: "udp", priority: 90 },
    { id: "rr", type: "remote-candidate", candidateType: "relay", protocol: "udp", relayProtocol: "udp", priority: 10 },
    { id: "rh", type: "remote-candidate", candidateType: "host", protocol: "udp", priority: 100 },
  ];

  it("uses the transport-selected pair, not an arbitrary nominated pair", () => {
    const result = inspectIceStats([...candidates,
      { id: "relay", type: "candidate-pair", localCandidateId: "ls", remoteCandidateId: "rr", state: "succeeded", nominated: true, currentRoundTripTime: 0.287 },
      { id: "direct", type: "candidate-pair", localCandidateId: "lh", remoteCandidateId: "rh", state: "succeeded", nominated: true, currentRoundTripTime: 0.018 },
      { id: "transport", type: "transport", selectedCandidatePairId: "direct" },
    ]);
    expect(result.selected).toMatchObject({ id: "direct", route: "direct", rttMs: 18 });
    expect(result.classification).toBe("DIRECT AVAILABLE");
  });

  it("reports failed direct checks without guessing NAT or firewall cause", () => {
    const result = inspectIceStats([...candidates,
      { id: "direct", type: "candidate-pair", localCandidateId: "lh", remoteCandidateId: "rh", state: "failed" },
      { id: "relay", type: "candidate-pair", localCandidateId: "ls", remoteCandidateId: "rr", state: "succeeded", nominated: true },
      { id: "transport", type: "transport", selectedCandidatePairId: "relay" },
    ]);
    expect(result).toMatchObject({ classification: "DIRECT FAILED", failureReason: "DIRECT_PAIR_CHECKS_FAILED", selected: { route: "relay" } });
  });

  it("never exposes TURN credentials from a server URL", () => {
    expect(iceServerInfo("turn:user:secret@relay.example.com:3478?transport=udp"))
      .toEqual({ type: "turn", host: "relay.example.com", transport: "UDP" });
  });

  it("keeps TURN fallback while retaining configured STUN when provider returns TURN only", () => {
    expect(withConfiguredStun([{ urls: "turn:relay.example.com", username: "user", credential: "secret" }], [{ urls: "stun:stun.example.com" }]))
      .toMatchObject([{ urls: "stun:stun.example.com" }, { urls: "turn:relay.example.com", username: "user" }]);
    expect(iceSignalCandidate("candidate:1 1 udp 2122260223 192.0.2.1 5000 typ srflx"))
      .toEqual({ type: "srflx", protocol: "UDP", priority: 2122260223 });
  });

  it("orders STUN then TURN UDP then TCP/TLS without losing credentials", () => {
    const servers = withConfiguredStun([{ urls: ["turns:relay.example.com", "turn:relay.example.com?transport=tcp", "turn:relay.example.com?transport=udp", "stun:stun.example.com"], username: "u", credential: "p" }], []);
    expect(servers.map((server) => server.urls)).toEqual(["stun:stun.example.com", "turn:relay.example.com?transport=udp", "turn:relay.example.com?transport=tcp", "turns:relay.example.com"]);
    expect(servers.every((server) => server.credential === "p")).toBe(true);
  });

  it("holds a selected route across brief missing stats without masking a real switch", () => {
    const relay = holdSelectedRoute(undefined, "relay", "UDP", 1000);
    expect(holdSelectedRoute(relay ?? undefined, "unknown", "unknown", 5000)?.route).toBe("relay");
    expect(holdSelectedRoute(relay ?? undefined, "direct", "UDP", 5000)?.route).toBe("direct");
    expect(holdSelectedRoute(relay ?? undefined, "unknown", "unknown", 7000)).toBeNull();
  });
});
