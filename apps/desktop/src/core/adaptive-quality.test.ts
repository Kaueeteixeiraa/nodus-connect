import { describe, expect, it } from "vitest";
import { advanceStage, recommendedStage, type QualitySample } from "./adaptive-quality";

const good: QualitySample = { rttMs: 15, jitterMs: 2, lossPct: 0, availableKbps: 20_000, bitrateKbps: 12_000, captureFps: 60, encodedFps: 60, encodeMs: 5, targetFps: 60, activePicture: true, limitation: "none" };

describe("adaptive quality", () => {
  it("lowers resolution before FPS for bandwidth pressure", () => {
    expect(recommendedStage({ ...good, availableKbps: 6000 })).toBe(1);
    expect(recommendedStage({ ...good, availableKbps: 3500 })).toBe(2);
    expect(recommendedStage({ ...good, availableKbps: 2000 })).toBe(3);
    expect(recommendedStage({ ...good, availableKbps: 1000 })).toBe(4);
    expect(recommendedStage({ ...good, availableKbps: 2000, bitrateKbps: 200 })).toBe(0);
  });

  it("responds to slow encoding but ignores an unchanged desktop", () => {
    expect(recommendedStage({ ...good, encodeMs: 24 })).toBe(0);
    expect(recommendedStage({ ...good, encodeMs: 24, encodedFps: 42 })).toBe(2);
    expect(recommendedStage({ ...good, encodeMs: 24, captureFps: 1, encodedFps: 1, activePicture: false })).toBe(0);
  });

  it("responds to sender queues and receiver buffering", () => {
    expect(recommendedStage({ ...good, packetSendDelayMs: 55 })).toBe(2);
    expect(recommendedStage({ ...good, jitterBufferMs: 130 })).toBe(3);
    expect(recommendedStage({ ...good, freezes: 1, jitterBufferMs: 90 })).toBe(3);
    expect(recommendedStage({ ...good, renderFps: 30 })).toBe(2);
  });

  it("does not treat a static desktop as a frozen stream", () => {
    expect(recommendedStage({ ...good, activePicture: false, renderFps: 2, freezes: 1 })).toBe(0);
  });

  it("degrades quickly and only restores after stable samples", () => {
    expect(advanceStage(0, 4, 0)).toEqual({ stage: 2, stableSamples: 0 });
    let state = { stage: 2 as const, stableSamples: 0 };
    for (let index = 0; index < 7; index++) state = advanceStage(state.stage, 0, state.stableSamples) as typeof state;
    expect(state.stage).toBe(2);
    expect(advanceStage(state.stage, 0, state.stableSamples).stage).toBe(1);
  });
});
