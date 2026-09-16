export type AdaptiveStage = 0 | 1 | 2 | 3 | 4;

export type QualitySample = {
  rttMs: number;
  jitterMs: number;
  lossPct: number;
  availableKbps: number;
  bitrateKbps: number;
  captureFps: number;
  encodedFps: number;
  encodeMs: number;
  targetFps: number;
  activePicture: boolean;
  limitation: string;
};

export const STAGE_LIMITS = [
  { height: 1080, fps: 60, bitrate: 14_000_000 },
  { height: 900, fps: 60, bitrate: 8_000_000 },
  { height: 720, fps: 60, bitrate: 5_000_000 },
  { height: 720, fps: 45, bitrate: 3_000_000 },
  { height: 720, fps: 30, bitrate: 1_600_000 },
] as const;

export function recommendedStage(sample: QualitySample): AdaptiveStage {
  const { rttMs, jitterMs, lossPct, availableKbps } = sample;
  const bandwidthBound = sample.activePicture && availableKbps > 0 && sample.bitrateKbps >= availableKbps * 0.7;
  if (lossPct >= 10 || rttMs >= 320 || jitterMs >= 80 || (bandwidthBound && availableKbps < 1500)) return 4;
  if (lossPct >= 5 || rttMs >= 200 || jitterMs >= 45 || (bandwidthBound && availableKbps < 2500)) return 3;
  let stage = lossPct >= 2 || rttMs >= 120 || jitterMs >= 25 || (bandwidthBound && availableKbps < 4500) ? 2 : 0;
  if (sample.limitation === "bandwidth" || (bandwidthBound && availableKbps < 8000)) stage = Math.max(stage, 1);
  if (sample.limitation === "cpu" || (sample.activePicture && sample.encodeMs > 1000 / sample.targetFps * 1.3 && sample.encodedFps < sample.targetFps * 0.9)) stage = Math.max(stage, 2);
  if (sample.activePicture && sample.captureFps >= sample.targetFps * 0.8 && sample.encodedFps < sample.targetFps * 0.7) stage = Math.max(stage, 2);
  return stage as AdaptiveStage;
}

export function advanceStage(current: AdaptiveStage, recommended: AdaptiveStage, stableSamples: number): { stage: AdaptiveStage; stableSamples: number } {
  if (recommended > current) return { stage: Math.min(recommended, current + (recommended >= 3 ? 2 : 1)) as AdaptiveStage, stableSamples: 0 };
  if (recommended === current) return { stage: current, stableSamples: 0 };
  const nextStable = stableSamples + 1;
  return nextStable >= 8
    ? { stage: (current - 1) as AdaptiveStage, stableSamples: 0 }
    : { stage: current, stableSamples: nextStable };
}
