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
  jitterBufferMs?: number;
  packetSendDelayMs?: number;
  renderFps?: number;
  freezes?: number;
};

export const STAGE_LIMITS = [
  { height: 1080, fps: 120 },
  { height: 900, fps: 90 },
  { height: 720, fps: 60 },
  { height: 720, fps: 45 },
  { height: 720, fps: 30 },
] as const;

export type QualityPressure = { stage: AdaptiveStage; reason: string; source: "network" | "local" | "none" };

export function assessQuality(sample: QualitySample): QualityPressure {
  const { rttMs, lossPct, availableKbps } = sample;
  const bandwidthBound = sample.activePicture && availableKbps > 0 && sample.bitrateKbps >= availableKbps * 0.7;
  if (lossPct >= 10 || rttMs >= 320) return { stage: 4, reason: `network loss=${lossPct.toFixed(1)}% rtt=${rttMs}ms`, source: "network" };
  if (lossPct >= 5 || rttMs >= 200) return { stage: 3, reason: `network loss=${lossPct.toFixed(1)}% rtt=${rttMs}ms`, source: "network" };
  if (lossPct >= 2 || rttMs >= 120) return { stage: 2, reason: `network loss=${lossPct.toFixed(1)}% rtt=${rttMs}ms`, source: "network" };
  if (sample.activePicture && (sample.limitation === "bandwidth" || (bandwidthBound && availableKbps < 8000))) {
    const stage = availableKbps <= 0 ? 1 : availableKbps < 1500 ? 4 : availableKbps < 2500 ? 3 : availableKbps < 4500 ? 2 : 1;
    return { stage, reason: `bandwidth available=${availableKbps}kbps used=${sample.bitrateKbps}kbps`, source: "network" };
  }
  if (!sample.activePicture) return { stage: 0, reason: "low motion: capacity unknown", source: "none" };
  if ((sample.packetSendDelayMs ?? 0) >= 100) return { stage: 2, reason: `sender queue=${sample.packetSendDelayMs}ms`, source: "local" };
  if (sample.limitation === "cpu" || (sample.encodeMs > 1000 / sample.targetFps * 1.3 && sample.encodedFps < sample.targetFps * 0.9)) {
    return { stage: 2, reason: `encoder time=${sample.encodeMs}ms limitation=${sample.limitation}`, source: "local" };
  }
  if ((sample.jitterBufferMs ?? 0) >= 120 && (sample.freezes ?? 0) > 0) return { stage: 2, reason: `playout=${sample.jitterBufferMs}ms freezes=${sample.freezes}`, source: "local" };
  if ((sample.jitterBufferMs ?? 0) >= 120) return { stage: 1, reason: `playout=${sample.jitterBufferMs}ms`, source: "local" };
  if ((sample.renderFps ?? 0) > 0 && sample.encodedFps >= sample.targetFps * 0.7 && sample.renderFps! < sample.encodedFps * 0.65) {
    return { stage: 1, reason: `render=${sample.renderFps}fps encoded=${sample.encodedFps}fps`, source: "local" };
  }
  return { stage: 0, reason: "stable", source: "none" };
}

export function recommendedStage(sample: QualitySample): AdaptiveStage {
  return assessQuality(sample).stage;
}

export type AdaptiveState = { stage: AdaptiveStage; badSamples: number; stableSamples: number; changedAt: number; changeCount: number };

export function nextBitrate(desired: number, previous?: number): number {
  const capped = previous ? Math.max(previous * 0.8, Math.min(previous * 1.2, desired)) : desired;
  const rounded = Math.round(capped / 50_000) * 50_000;
  return Math.max(300_000, Math.round(previous ? Math.max(previous * 0.8, Math.min(previous * 1.2, rounded)) : rounded));
}

export function advanceStage(current: AdaptiveState, recommended: AdaptiveStage, now: number, critical = false): AdaptiveState {
  const badSamples = recommended > current.stage ? current.badSamples + 1 : 0;
  const stableSamples = recommended < current.stage ? current.stableSamples + 1 : 0;
  const cooldown = now - current.changedAt < 5_000;
  const worsen = recommended > current.stage && (critical || badSamples >= 4) && (!cooldown || critical);
  const improve = recommended < current.stage && stableSamples >= 20 && !cooldown;
  if (worsen || improve) return { stage: (current.stage + (worsen ? 1 : -1)) as AdaptiveStage, badSamples: 0, stableSamples: 0, changedAt: now, changeCount: current.changeCount + 1 };
  return { ...current, badSamples, stableSamples };
}
