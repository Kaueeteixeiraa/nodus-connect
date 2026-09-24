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

  it("keeps requested video separate from runtime capture and sender parameters", () => {
    const host = report("host", [{
      diagnosticLabel: "resolution-1080", lightweightMode: true,
      configuredVideo: { resolution: "1920x1080", fps: 60, bitrate: 10000000 },
      actualVideo: { capture: { width: 1280, height: 720, frameRate: 59 }, sender: { maxBitrate: 8000000, maxFramerate: 60, scaleResolutionDownBy: 1.5 } },
      captureFps: 49, encodedFps: 48, encoder: "Intel Quick Sync", limitation: "none",
    }]);
    const result = JSON.parse(execFileSync(process.execPath, [resolve("scripts/perf-lab.mjs"), "report", host], { encoding: "utf8" }));
    expect(result.diagnostic).toMatchObject({ label: "resolution-1080", lightweightMode: { host: true, viewer: null }, pixelsPerSecond: 54374400 });
    expect(result.diagnostic.configured.resolution).toBe("1920x1080");
    expect(result.diagnostic.actual.capture.width).toBe(1280);
    expect(result.diagnostic.actual.sender.maxBitrate).toBe(8000000);
  });
});
