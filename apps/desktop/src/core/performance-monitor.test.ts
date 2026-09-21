import { describe, expect, it } from "vitest";
import { classifyEncoderImplementation, diagnosePipeline, smoothPipelineSample, type PipelineSample } from "./performance-monitor";

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
    const viewer = { ...host, role: "viewer" as const, captureFps: 0, encodedFps: 0, sentFps: 0, receivedFps: 60, decodedFps: 60, renderFps: 60 };
    expect(diagnosePipeline({ ...viewer, decodedFps: 35, decodeMs: 24 }).bottleneck).toBe("DECODER");
    expect(diagnosePipeline({ ...viewer, renderFps: 35 }).bottleneck).toBe("RENDER");
    expect(diagnosePipeline(viewer).bottleneck).toBe("NONE");
  });

  it("does not diagnose an unchanged desktop", () => {
    expect(diagnosePipeline({ ...host, captureFps: 1, encodedFps: 1, activePicture: false }).bottleneck).toBe("UNKNOWN");
  });

  it("classifies common hardware and software encoders", () => {
    expect(classifyEncoderImplementation("Intel Quick Sync")).toEqual({ encoderKind: "hardware", encoderVendor: "intel" });
    expect(classifyEncoderImplementation("OpenH264")).toEqual({ encoderKind: "software", encoderVendor: "unknown" });
  });

  it("smooths noisy samples", () => {
    expect(smoothPipelineSample(host, { ...host, captureFps: 30 }, 0.25).captureFps).toBe(52.5);
  });
});
