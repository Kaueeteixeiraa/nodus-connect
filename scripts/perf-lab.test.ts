import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "nodus-perf-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function report(role: "host" | "viewer", samples: Record<string, unknown>[]) {
  const file = join(directory, `${role}.log`);
  writeFileSync(file, samples.map((sample, index) => {
    const at = `2026-09-23T12:00:0${index}.000Z`;
    return `[${at}] ${JSON.stringify({ at, sessionId: "test-session", role, ...sample })}`;
  }).join("\n"));
  return file;
}

describe("performance report", () => {
  it("uses an explicit cutoff on both peers and excludes unknown packet loss", () => {
    const host = report("host", [{ captureFps: 60 }, { captureFps: 40 }, { captureFps: 1 }]);
    const viewer = report("viewer", [{ decodedFps: 60, packetLossPct: 1 }, { decodedFps: 40, packetLossPct: 0, packetLossPctValid: false }, { decodedFps: 1, packetLossPct: 100 }]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", host, `--peer=${viewer}`, "--end=2026-09-23T12:00:01.000Z"], { encoding: "utf8" }));
    expect(result.samples).toBe(4);
    expect(result.fps).toMatchObject({ captureFps: 50, decodedFps: 50 });
    expect(result.network.packetLossPct).toBe(1);
  });

  it("deduplicates native ACK samples and leaves one-way and visual input latency unmeasured", () => {
    const first = { id: 1, ok: true, positionConfirmed: true, eventToSendMs: 5, commandAckRttMs: 20,
      hostProcessingMs: 4, ipcRoundTripMs: 3, mainToWindowsAckMs: 2, transportAckRoundTripMs: 16 };
    const viewer = report("viewer", [
      { inputDiagnostic: { hostSupported: true, latest: first, mouseEventsPerSecond: 1000, sendsPerSecond: 60, bufferedAmount: 9, coalesced: 940, bufferDeferrals: 4 } },
      { inputDiagnostic: { hostSupported: true, latest: first, mouseEventsPerSecond: 1000, sendsPerSecond: 60, bufferedAmount: 18, coalesced: 940 } },
      { inputDiagnostic: { hostSupported: true, latest: { ...first, id: 2, commandAckRttMs: 40 }, coalesced: 1000 } },
    ]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", viewer], { encoding: "utf8" }));
    expect(result.input).toMatchObject({ enabled: true, samples: 2, windowsPositionConfirmedSamples: 2,
      nativeAckRttMsAverage: 30, nativeAckRttMsP95: 40, nativeAckRttMsP99: 40, nativeAckRttMsMax: 40, nativeAckOver500MsSamples: 0,
      commandLatencyMs: null, oneWayTransportMs: null, visualFeedbackLatencyMs: null,
      mouseEventsPerSecond: 1000, sendsPerSecond: 60, bufferedAmountPeak: 18, bufferDeferrals: 4, hostStaleDrops: null });
  });

  it("joins both peers without inventing unavailable counters", () => {
    const host = report("host", [
      { captureFps: 60, encodedFps: 58, sentFps: 58, encoder: "OpenH264", codec: "H264", codecProfile: "profile-level-id=42e01f", encoderFallbackReason: "Chromium escolheu software", gpu: { adapter: "Intel GPU", videoEncode: "enabled", hardwareH264Available: true }, encodeMs: 7, counters: { captured: 100, encoded: 98, sent: 98 } },
      { captureFps: 60, encodedFps: 59, sentFps: 59, encoder: "OpenH264", codec: "H264", codecProfile: "profile-level-id=42e01f", gpu: { adapter: "Intel GPU", videoEncode: "enabled", hardwareH264Available: true }, encodeMs: 9, counters: { captured: 160, encoded: 157, sent: 157 } },
    ]);
    const viewer = report("viewer", [
      { receivedFps: 58, decodedFps: 57, renderFps: 56, bitrateKbps: 4000, latencyMs: 12, transport: "UDP", route: "direct", decoder: "FFmpeg", decodeMs: 3, counters: { received: 98, decoded: 97, rendered: 96, dropped: 1 } },
      { receivedFps: 59, decodedFps: 58, renderFps: 57, bitrateKbps: 4200, latencyMs: 14, transport: "UDP", route: "direct", decoder: "FFmpeg", decodeMs: 4, counters: { received: 157, decoded: 155, rendered: 153, dropped: 2 } },
    ]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", host, "--duration=60", `--peer=${viewer}`], { encoding: "utf8" }));
    expect(result.roles).toEqual(["host", "viewer"]);
    expect(result.fps).toMatchObject({ captureFps: 60, encodedFps: 58.5, decodedFps: 57.5, renderFps: 57, renderCallbacksFps: 56.5 });
    expect(result.network).toMatchObject({ transport: "UDP", route: "direct", bitrateKbpsPeak: 4200 });
    expect(result.media).toMatchObject({ encoder: "OpenH264", encoderKind: "software", decoder: "FFmpeg", encodeMsP95: 9 });
    expect(result.media.codecProfile).toBe("profile-level-id=42e01f");
    expect(result.gpu.host).toMatchObject({ adapter: "Intel GPU", videoEncode: "enabled", hardwareH264Available: true });
    expect(result.media.counters).toEqual({ captured: 60, encoded: 59, sent: 59, received: 59, decoded: 58, rendered: 57, dropped: 1 });
    expect(result.renderFps1PercentLow).toBeNull();
  });

  it("flags render and buffering gaps independently of encoder availability", () => {
    const viewer = report("viewer", [{ decodedFps: 60, renderFps: 40, jitterBufferMs: 180, encoder: "OpenH264", gpu: { videoEncode: "enabled" } }]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", viewer], { encoding: "utf8" }));
    expect(result.warnings).toEqual(["POSSIBLE RENDER BOTTLENECK", "HIGH WEBRTC PLAYOUT DELAY (SOURCE UNDETERMINED)"]);
    expect(result.buffering).toMatchObject({ webRtcPlayoutMs: 180, renderQueueMs: null, estimatedGlassToGlassMs: null });
    expect(result.media.encoderKind).toBe("software");
  });

  it("uses presented-frame counters when callbacks undercount rendering", () => {
    const viewer = report("viewer", [
      { decodedFps: 50, renderFps: 35, counters: { rendered: 100 } },
      { decodedFps: 50, renderFps: 35, counters: { rendered: 150 } },
    ]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", viewer], { encoding: "utf8" }));
    expect(result.fps).toMatchObject({ renderFps: 50, renderCallbacksFps: 35 });
    expect(result.video.renderFpsSource).toBe("presentedFrames counter");
    expect(result.warnings).toContain("FRAME CALLBACKS UNDERCOUNT PRESENTED FRAMES");
    expect(result.warnings).not.toContain("POSSIBLE RENDER BOTTLENECK");
  });

  it("marks missing peer metrics as unavailable", () => {
    const host = report("host", [{ captureFps: 30, encodedFps: 29, renderFps: 20, encoder: "OpenH264" }]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", host], { encoding: "utf8" }));
    expect(result.fps.decodedFps).toBeNull();
    expect(result.network.transport).toBe("unknown");
    expect(result.media.counters.rendered).toBeNull();
    expect(result.gpu.host.hardwareH264Available).toBeNull();
    expect(result.rendering.frameTiming).toEqual({ frameAgeMs: null, receiveToPresentMs: null, frameProcessingMs: null, presentationCallbackDelayMs: null });
    expect(result.media.rtpReliability).toEqual({ host: null, viewer: null });
    expect(result.adaptation.channelBuffersPeak).toEqual({ control: null, pointer: null, clipboard: null, telemetry: null });
  });

  it("reports channel pressure and fresh presentation estimates without treating them as input latency", () => {
    const viewer = report("viewer", [
      { renderSampleAgeMs: 0, frameTiming: { frameAgeMs: 80, receiveToPresentMs: 10, frameProcessingMs: 4, presentationCallbackDelayMs: 2 },
        channelBuffers: { control: 8, pointer: 17, clipboard: 65536, telemetry: 40 }, pendingPointerPositions: 1,
        rtpReliability: { nackCount: 2, pliCount: 1, measurement: "cumulative-rtp-counters" } },
      { renderSampleAgeMs: 3000, frameTiming: { frameAgeMs: 900, receiveToPresentMs: 500 } },
    ]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", viewer], { encoding: "utf8" }));
    expect(result.rendering.frameTiming).toEqual({ frameAgeMs: 80, receiveToPresentMs: 10, frameProcessingMs: 4, presentationCallbackDelayMs: 2 });
    expect(result.input.visualFeedbackLatencyMs).toBeNull();
    expect(result.adaptation).toMatchObject({ channelBuffersPeak: { control: 8, pointer: 17, clipboard: 65536, telemetry: 40 }, pendingPointerPositionsPeak: 1 });
  });

  it("keeps both roles when computer clocks differ", () => {
    const host = report("host", [{ captureFps: 60 }]);
    const viewer = report("viewer", [{ at: "2026-09-23T13:00:00.000Z", decodedFps: 58 }]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", host, `--peer=${viewer}`], { encoding: "utf8" }));
    expect(result.roles).toEqual(["host", "viewer"]);
    expect(result.fps).toMatchObject({ captureFps: 60, decodedFps: 58 });
  });

  it("excludes missing buffer intervals and reports adaptation separately from requested quality", () => {
    const viewer = report("viewer", [
      { jitterBufferMs: 0, jitterBufferMsValid: false, contentMotion: "LOW", targetFps: 120, requestedQuality: "high", quality: "high" },
      { jitterBufferMs: 326, jitterBufferMsValid: true, jitterBufferTargetMs: 300, jitterBufferMinimumMs: 25, contentMotion: "LOW", targetFps: 120, requestedQuality: "high", quality: "high", appliedFps: 90, appliedWidth: 1920, appliedHeight: 1080, appliedBitrateKbps: 12000, profileChangeCount: 1, adaptationReason: "playout=326ms" },
    ]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", viewer], { encoding: "utf8" }));
    expect(result.buffering).toMatchObject({ webRtcPlayoutMs: 326, webRtcTargetMs: 300, webRtcMinimumMs: 25 });
    expect(result.video).toMatchObject({ targetFps: 120, contentMotion: "LOW", appliedResolution: "1920x1080" });
    expect(result.adaptation).toMatchObject({ requestedProfile: "high", appliedProfile: "high", profileChanges: 1, lastReason: "playout=326ms" });
    expect(result.network.availableKbps).toBeNull();
    expect(result.bottleneck.predominant).toBe("UNKNOWN");
  });

  it("reports local phase deltas without claiming synchronized cross-PC timing", () => {
    const viewer = report("viewer", [
      { event: "startup", phase: "ui-ready", elapsedMs: 300 },
      ...[["connect-click", 0], ["device-located", 40], ["license-reserved", 90], ["request-created", 120], ["webrtc-started", 150], ["ice-connected", 250], ["first-frame", 280]].map(([phase, elapsedMs]) => ({ event: "connection-phase", phase, elapsedMs })),
    ]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "timings", viewer], { encoding: "utf8" }));
    expect(result.startup).toHaveLength(1);
    expect(result.sessions[0].roles.viewer).toMatchObject({ deviceLookupMs: 40, licenseReserveMs: 50, requestWriteMs: 30, acceptToPeerMs: null, iceMs: 100, iceToFirstPresentedFrameMs: 30 });
    expect(result.requestDeliveryOneWayMs).toBeNull();
  });

  it("keeps requested video separate from runtime capture and sender parameters", () => {
    const host = report("host", [{
      event: "diagnostic-preset-activated", preset: "1080p60", requestedWidth: 1920, requestedHeight: 1080, requestedFps: 60,
      maxFramerate: 60, bitrateKbps: 14000, scaleResolutionDownBy: 1, adaptiveLocked: true,
    }, {
      diagnosticLabel: "capture-1080p60", lightweightMode: true,
      configuredVideo: { resolution: "1920x1080", fps: 60, bitrate: 14000000, diagnostic: { preset: "1080p60", maxFramerate: 60, scaleResolutionDownBy: 1, lockAdaptive: true } },
      actualVideo: { capture: { width: 1280, height: 720, frameRate: 59 }, sender: { maxBitrate: 8000000, maxFramerate: 60, scaleResolutionDownBy: 1.5 } },
      captureFps: 49, encodedFps: 48, encoder: "Intel Quick Sync", limitation: "none",
    }]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", host], { encoding: "utf8" }));
    expect(result.diagnostic).toMatchObject({ label: "capture-1080p60", lightweightMode: { host: true, viewer: null }, pixelsPerSecond: 54374400 });
    expect(result.diagnostic.configured.resolution).toBe("1920x1080");
    expect(result.diagnostic.actual.capture.width).toBe(1280);
    expect(result.diagnostic.actual.sender.maxBitrate).toBe(8000000);
    expect(result.validation).toMatchObject({
      requested: { resolution: "1920x1080", fps: 60, bitrate: 14000000 },
      trackSettings: { width: 1280, height: 720, frameRate: 59 },
      sender: { maxBitrate: 8000000, maxFramerate: 60, scaleResolutionDownBy: 1.5 },
    });
    expect(result.validation.benchmark).toMatchObject({ status: "FAIL", activationValid: true, senderValid: false, trackValid: false, abortReason: "SENDER_PARAMETERS_MISMATCH" });
  });

  it("reports double scaling only when a reduced stream is enlarged by the viewer", () => {
    const host = report("host", [{
      bitrateKbps: 9000,
      actualVideo: {
        source: { width: 1366, height: 768 },
        capture: { width: 1366, height: 768, frameRate: 60 },
        cursorCapture: { requested: "never", applied: "never", supported: ["always", "motion", "never"] },
        sender: { scaleResolutionDownBy: 1.5, degradationPreference: "maintain-framerate" },
        outbound: { width: 910, height: 512, averageQp: 24 },
      },
    }]);
    const viewer = report("viewer", [{
      inboundVideo: { width: 910, height: 512 },
      presentation: { videoWidth: 910, videoHeight: 512, renderedWidth: 1366, renderedHeight: 768, physicalWidth: 1366, physicalHeight: 768, devicePixelRatio: 1, objectFit: "contain" },
    }]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", host, `--peer=${viewer}`], { encoding: "utf8" }));
    expect(result.imageQuality).toMatchObject({ doubleScaling: "YES", contentHint: null, actualOutgoingBitrateKbps: 9000, averageQp: 24 });
    expect(result.imageQuality.resolutionPipeline).toMatchObject({ source: { width: 1366, height: 768 }, outbound: { width: 910, height: 512 }, inbound: { width: 910, height: 512 } });
    expect(result.cursor).toMatchObject({ requested: "never", applied: "never" });
  });

  it.each([
    ["always", "CURSOR_SUPPRESSION_FAILED; HOST CURSOR STILL CAPTURED; CURSOR DUPLICATION RISK"],
    [null, "CURSOR DUPLICATION RISK (CAPTURE CURSOR UNVERIFIED)"],
  ])("flags capture cursor applied=%s without claiming exclusion", (applied, warning) => {
    const host = report("host", [{ actualVideo: { cursorCapture: { requested: "never", applied, supported: null } } }]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", host], { encoding: "utf8" }));
    expect(result.warnings).toContain(warning);
  });

  it("reports both ICE peers and the selected pair without inventing TURN segment RTT", () => {
    const ice = { counts: { local: { host: 1, srflx: 1, relay: 0 }, remote: { host: 0, srflx: 0, relay: 1 } },
      selected: { id: "pair-1", route: "relay", state: "succeeded", rttMs: 287, local: { type: "srflx", protocol: "UDP" }, remote: { type: "relay", protocol: "UDP" } },
      classification: "UNKNOWN", failureReason: "NO_DIRECT_PAIR_STATS" };
    const host = report("host", [{ ice, iceStates: { gathering: "complete" }, iceTransportPolicy: "all", iceRestartCount: 0,
      actualVideo: { cursorCapture: { requested: "never", applied: "never" } } }]);
    const viewer = report("viewer", [
      { event: "ice-started", elapsedMs: 0, servers: [{ type: "turn", host: "relay.example.com", credential: "secret" }] },
      { ice, iceStates: { gathering: "complete" }, route: "relay", transport: "UDP", latencyMs: 287, iceTransportPolicy: "all", iceRestartCount: 0 },
    ]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", host, `--peer=${viewer}`], { encoding: "utf8" }));
    expect(result.ice).toMatchObject({ policy: "all", classification: "UNKNOWN", directFailureReason: "NO_DIRECT_PAIR_STATS",
      selectedPair: { id: "pair-1", route: "relay" }, stun: { host: "SUCCESS", viewer: "SUCCESS" },
      turn: { used: true, segmentRttMs: null }, timeline: [{ event: "ice-started", elapsedMs: 0 }] });
    expect(JSON.stringify(result.ice)).not.toContain("secret");
  });
});
