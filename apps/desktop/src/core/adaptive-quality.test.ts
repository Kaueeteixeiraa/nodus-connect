import { describe, expect, it } from "vitest";
import { advanceStage, assessQuality, nextBitrate, recommendedStage, type AdaptiveState, type QualitySample } from "./adaptive-quality";

const good: QualitySample = { rttMs: 15, jitterMs: 2, lossPct: 0, availableKbps: 20_000, bitrateKbps: 12_000, captureFps: 60, encodedFps: 60, encodeMs: 5, targetFps: 60, activePicture: true, limitation: "none" };

describe("adaptive quality", () => {
  it("responds to confirmed bandwidth pressure", () => {
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
    expect(recommendedStage({ ...good, packetSendDelayMs: 110 })).toBe(2);
    expect(recommendedStage({ ...good, jitterBufferMs: 130 })).toBe(1);
    expect(recommendedStage({ ...good, freezes: 1, jitterBufferMs: 130 })).toBe(2);
    expect(recommendedStage({ ...good, renderFps: 30 })).toBe(1);
  });

  it("does not treat a static desktop as a frozen stream", () => {
    expect(recommendedStage({ ...good, activePicture: false, renderFps: 2, freezes: 1, jitterMs: 168, jitterBufferMs: 326 })).toBe(0);
    expect(assessQuality({ ...good, jitterMs: 168, jitterBufferMs: 326, activePicture: false }).source).toBe("none");
  });

  it("steps down after persistent pressure and recovers slowly with cooldown", () => {
    let state: AdaptiveState = { stage: 0, badSamples: 0, stableSamples: 0, changedAt: 0, changeCount: 0 };
    for (let index = 0; index < 3; index++) state = advanceStage(state, 4, 6000 + index * 500);
    expect(state.stage).toBe(0);
    state = advanceStage(state, 4, 7500);
    expect(state.stage).toBe(1);
    for (let index = 0; index < 9; index++) state = advanceStage(state, 4, 8000 + index * 500);
    expect(state.stage).toBe(1);
    state = advanceStage(state, 4, 12500);
    expect(state.stage).toBe(2);
    for (let index = 0; index < 19; index++) state = advanceStage(state, 0, 13000 + index * 500);
    expect(state.stage).toBe(2);
    expect(advanceStage(state, 0, 22500).stage).toBe(1);
  });

  it("does not flap after isolated bad and good samples", () => {
    let state: AdaptiveState = { stage: 1, badSamples: 0, stableSamples: 0, changedAt: 0, changeCount: 0 };
    for (let index = 0; index < 20; index++) state = advanceStage(state, index % 2 ? 0 : 3, 6000 + index * 500);
    expect(state.stage).toBe(1);
    expect(state.changeCount).toBe(0);
  });

  it("moves bitrate gradually even near the minimum", () => {
    expect(nextBitrate(14_000_000, 500_000)).toBe(600_000);
    expect(nextBitrate(300_000, 5_000_000)).toBe(4_000_000);
    expect(nextBitrate(14_000_000, 650_000)).toBeLessThanOrEqual(780_000);
  });
});
