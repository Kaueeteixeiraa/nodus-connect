import { describe, expect, it } from "vitest";
import { classifyDecoderImplementation, classifyEncoderImplementation, contentMotion, counterDelta, cumulativeMeanMs, diagnosePipeline, encoderFallbackReason, rtpJitterMs, smoothPipelineSample, type PipelineSample } from "./performance-monitor";

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
