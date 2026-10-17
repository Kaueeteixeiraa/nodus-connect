import { describe, expect, it } from "vitest";
import { classifyDecoderImplementation, classifyEncoderImplementation, contentMotion, counterDelta, cumulativeMeanMs, diagnosePipeline, encoderFallbackReason, InputLatencyDiagnostic, LatencyWindow, VideoProgressWatchdog, receiverPacketLoss, rtpJitterMs, smoothPipelineSample, videoFrameTiming, type PipelineSample } from "./performance-monitor";
import { assessQuality } from "./adaptive-quality";

describe("bounded latency windows", () => {
  it("calculates p50 and p95 without inventing missing or expired measurements", () => {
    const window = new LatencyWindow(60_000, 100);
    expect(window.add(0, null)).toEqual({ samples: 0, p50: null, p95: null, max: null });
    for (let i = 1; i <= 100; i++) window.add(i, i);
    expect(window.add(101, NaN)).toEqual({ samples: 100, p50: 50, p95: 95, max: 100 });
    expect(window.add(60_101, undefined).samples).toBe(0);
  });
  it("bounds storage and resets on clock regression", () => {
    const window = new LatencyWindow(60_000, 2);
    window.add(1, 1); window.add(2, 2);
    expect(window.add(3, 3)).toEqual({ samples: 2, p50: 2, p95: 3, max: 3 });
    expect(window.add(0, -1).samples).toBe(0);
  });
});
describe("video progress watchdog", () => {
  it("does not classify static desktops, disconnections or counter resets as decoder stalls", () => {
    const watch = new VideoProgressWatchdog();
    for (let now = 0; now < 60_000; now += 500) expect(watch.inspect(now, 1000, 30, true)).toBe(false);
    expect(watch.inspect(60_000, 20, 2, true)).toBe(false);
    expect(watch.inspect(70_000, 40, 2, false)).toBe(false);
  });
  it("detects sustained video arrival without decoding and clears when progress resumes", () => {
    const watch = new VideoProgressWatchdog();
    expect(watch.inspect(0, 10, 1, true)).toBe(false);
    for (let now = 500; now < 8000; now += 500) expect(watch.inspect(now, 10 + now, 1, true)).toBe(false);
    expect(watch.inspect(8000, 8010, 1, true)).toBe(true);
    expect(watch.inspect(8500, 8510, 2, true)).toBe(false);
  });
});

describe("receiver packet loss", () => {
  it("does not invent 100 percent loss when remote-inbound lacks packetsReceived", () => {
    const bogusRemoteLoss = 1 / Math.max(1, 1 + 0) * 100;
    expect(bogusRemoteLoss).toBe(100);
    const measured = receiverPacketLoss({ receivedAt: 900, packetLossPct: 0 }, 1000)!;
    const sample = { ...host, availableKbps: 10000, bitrateKbps: 4000, lossPct: measured };
    expect(assessQuality(sample).stage).toBe(0);
    expect(assessQuality({ ...sample, lossPct: bogusRemoteLoss }).stage).toBe(4);
  });

  it("preserves real measured loss and compatibility with existing viewer feedback", () => {
    expect(receiverPacketLoss({ receivedAt: 900, packetLossPct: 5 }, 1000)).toBe(5);
    expect(receiverPacketLoss({ receivedAt: 900, packetLossPct: 100, packetLossPctValid: true }, 1000)).toBe(100);
  });

  it("keeps missing, stale and invalid feedback unavailable instead of reporting zero loss", () => {
    expect(receiverPacketLoss(undefined, 1000)).toBeNull();
    expect(receiverPacketLoss({ receivedAt: 0, packetLossPct: 0 }, 3000)).toBeNull();
    expect(receiverPacketLoss({ receivedAt: 1001, packetLossPct: 0 }, 1000)).toBeNull();
    expect(receiverPacketLoss({ receivedAt: 900 }, 1000)).toBeNull();
    expect(receiverPacketLoss({ receivedAt: 900, packetLossPct: 0, packetLossPctValid: false }, 1000)).toBeNull();
    for (const packetLossPct of [-1, 101, NaN, Infinity]) expect(receiverPacketLoss({ receivedAt: 900, packetLossPct }, 1000)).toBeNull();
  });
});

describe("input latency measurement", () => {
  it("negotiates probes and samples at most once per second", () => {
    const diagnostic = new InputLatencyDiagnostic(0);
    expect(diagnostic.probe(0)).toBeUndefined();
    diagnostic.hostSupported = true;
    expect(diagnostic.probe(0)).toBe(1);
    expect(diagnostic.probe(999)).toBeUndefined();
    expect(diagnostic.probe(1000)).toBe(2);
  });

  it("measures ACK RTT without pretending it is one-way command or visual latency", () => {
    const diagnostic = new InputLatencyDiagnostic(0);
    diagnostic.hostSupported = true;
    diagnostic.eventToSendMs = 7;
    const id = diagnostic.probe(10)!;
    diagnostic.acknowledge(id, 70, { ok: true, positionConfirmed: true, hostProcessingMs: 12, ipcRoundTripMs: 8, mainToWindowsAckMs: 5 });
    expect(diagnostic.snapshot(1000, 27)).toMatchObject({ bufferedAmount: 27, commandLatencyMs: null, visualFeedbackLatencyMs: null,
      latest: { commandAckRttMs: 60, transportAckRoundTripMs: 48, eventToSendMs: 7, mainToWindowsAckMs: 5 } });
    diagnostic.acknowledge(id, 900, { ok: true, hostProcessingMs: 0, ipcRoundTripMs: 0 });
    expect(diagnostic.latest?.commandAckRttMs).toBe(60);
  });

  it("bounds pending probes, expires losses and does not turn timeouts into success", () => {
    const diagnostic = new InputLatencyDiagnostic(0);
    diagnostic.hostSupported = true;
    for (let at = 0; at < 4000; at += 1000) diagnostic.probe(at);
    expect(diagnostic.probe(4000)).toBeUndefined();
    expect(diagnostic.snapshot(5000, 0)).toMatchObject({ pendingProbes: 3, probeTimeouts: 1, latest: null });
    expect(diagnostic.probe(5000)).toBe(5);
  });

  it("records window rates and cumulative coalescing without React updates", () => {
    const diagnostic = new InputLatencyDiagnostic(0);
    diagnostic.events = 1000; diagnostic.sent = 60; diagnostic.received = 58; diagnostic.coalesced = 940;
    diagnostic.bufferDeferrals = 5; diagnostic.staleDrops = 3;
    expect(diagnostic.snapshot(1000, 18)).toMatchObject({ mouseEventsPerSecond: 1000, sendsPerSecond: 60, receivesPerSecond: 58, coalesced: 940, bufferDeferrals: 5, staleDrops: 3 });
    expect(diagnostic.snapshot(2000, 0).mouseEventsPerSecond).toBe(0);
  });
});

describe("browser video frame timing", () => {
  it("keeps browser estimates separate from input latency", () => {
    expect(videoFrameTiming({ captureTime: 10, receiveTime: 80, presentationTime: 100, processingDuration: .007 }, 103)).toEqual({
      frameAgeMs: 90, receiveToPresentMs: 20, frameProcessingMs: 7, presentationCallbackDelayMs: 3,
      measurement: "browser-estimated-capture-to-presentation-not-input-latency",
    });
  });

  it("does not invent capture or presentation timestamps", () => {
    expect(videoFrameTiming({}, 100)).toMatchObject({ frameAgeMs: null, receiveToPresentMs: null, frameProcessingMs: null, presentationCallbackDelayMs: null });
  });

  it.each([NaN, Infinity, -1, 101])("rejects invalid or future capture timestamps: %s", captureTime => {
    expect(videoFrameTiming({ captureTime, receiveTime: captureTime, presentationTime: 100, processingDuration: -1 }, 99)).toMatchObject({
      frameAgeMs: null, receiveToPresentMs: null, frameProcessingMs: null, presentationCallbackDelayMs: null,
    });
  });
});

const host: PipelineSample = {
  role: "host", targetFps: 60, captureFps: 60, encodedFps: 60, sentFps: 60, receivedFps: 0,
  decodedFps: 0, renderFps: 0, encodeMs: 5, decodeMs: 0, rttMs: 20, jitterMs: 2, lossPct: 0,
  jitterBufferMs: 10, packetSendDelayMs: 3, limitation: "none", encoder: "Intel Quick Sync", activePicture: true,
};

describe("performance monitor", () => {
  it("identifies each local pipeline bottleneck", () => {
    expect(diagnosePipeline({ ...host, captureFps: 35, encodedFps: 35 }).bottleneck).toBe("CAPTURE");
    expect(diagnosePipeline({ ...host, encodedFps: 35, encodeMs: 24 }).bottleneck).toBe("ENCODER");
    expect(diagnosePipeline({ ...host, lossPct: 4 }).bottleneck).toBe("NETWORK");
    expect(diagnosePipeline({ ...host, jitterMs: 168, jitterBufferMs: 326, rttMs: 8, lossPct: 0 }).bottleneck).toBe("BUFFER_QUEUE");
    const viewer = { ...host, role: "viewer" as const, captureFps: 0, encodedFps: 0, sentFps: 0, receivedFps: 60, decodedFps: 60, renderFps: 60 };
    expect(diagnosePipeline({ ...viewer, decodedFps: 35, decodeMs: 24 }).bottleneck).toBe("DECODER");
    expect(diagnosePipeline({ ...viewer, renderFps: 35 }).bottleneck).toBe("RENDER");
    expect(diagnosePipeline({ ...viewer, renderFps: 35, jitterBufferMs: 326 }).bottleneck).toBe("RENDER");
    expect(diagnosePipeline(viewer).bottleneck).toBe("NONE");
  });

  it("does not diagnose an unchanged desktop", () => {
    expect(diagnosePipeline({ ...host, captureFps: 1, encodedFps: 1, activePicture: false }).bottleneck).toBe("UNKNOWN");
  });

  it("computes RTP jitter in milliseconds and per-frame cumulative deltas", () => {
    expect(rtpJitterMs(0.1682)).toBe(168.2);
    expect(rtpJitterMs(-1)).toBeNull();
    expect(cumulativeMeanMs(1.326, 1, 110, 109)).toBe(326);
    expect(cumulativeMeanMs(1.326, 1, 110, 110)).toBeNull();
    expect(cumulativeMeanMs(0.2, 1, 2, 109)).toBeNull();
    expect(counterDelta(24, 1)).toBe(23);
    expect(counterDelta(1, 24)).toBeNull();
  });

  it("labels sparse desktop frames without claiming measured capacity", () => {
    expect(contentMotion(3, 120)).toBe("LOW");
    expect(contentMotion(40, 120)).toBe("MEDIUM");
    expect(contentMotion(90, 120)).toBe("HIGH");
  });

  it("classifies common hardware and software encoders", () => {
    expect(classifyEncoderImplementation("Intel Quick Sync")).toEqual({ encoderKind: "hardware", encoderVendor: "intel" });
    expect(classifyEncoderImplementation("OpenH264")).toEqual({ encoderKind: "software", encoderVendor: "unknown" });
    expect(classifyEncoderImplementation("MediaFoundation").encoderKind).toBe("unknown");
    expect(classifyDecoderImplementation("D3D11VideoDecoder")).toBe("hardware");
    expect(classifyDecoderImplementation("FFmpegVideoDecoder")).toBe("unknown");
  });

  it("explains software fallback only when evidence supports a cause", () => {
    expect(encoderFallbackReason("OpenH264", { gpuProcessAvailable: false })).toContain("GPU");
    expect(encoderFallbackReason("OpenH264", { videoEncode: "disabled_software" })).toContain("disabled_software");
    expect(encoderFallbackReason("OpenH264", { hardwareH264: false })).toContain("não encontrou");
    expect(encoderFallbackReason("OpenH264", { hardwareH264: true })).toContain("desconhecida");
    expect(encoderFallbackReason("Intel Quick Sync", { gpuProcessAvailable: false })).toBe("");
  });

  it("smooths noisy samples", () => {
    expect(smoothPipelineSample(host, { ...host, captureFps: 30 }, 0.25).captureFps).toBe(52.5);
  });
});
