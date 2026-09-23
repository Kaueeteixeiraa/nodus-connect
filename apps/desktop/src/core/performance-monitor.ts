export type PipelineBottleneck = "CAPTURE" | "ENCODER" | "NETWORK" | "DECODER" | "RENDER" | "BUFFER_QUEUE" | "NONE" | "UNKNOWN";
export type EncoderKind = "hardware" | "software" | "unknown";
export type EncoderVendor = "intel" | "nvidia" | "amd" | "media-foundation" | "apple" | "unknown";

export type PipelineSample = {
  role: "host" | "viewer";
  targetFps: number;
  captureFps: number;
  encodedFps: number;
  sentFps: number;
  receivedFps: number;
  decodedFps: number;
  renderFps: number;
  encodeMs: number;
  decodeMs: number;
  rttMs: number;
  jitterMs: number;
  lossPct: number;
  jitterBufferMs: number;
  packetSendDelayMs: number;
  limitation: string;
  encoder: string;
  activePicture: boolean;
};

export type PipelineDiagnosis = {
  bottleneck: PipelineBottleneck;
  confidence: number;
  encoderKind: EncoderKind;
  encoderVendor: EncoderVendor;
};

export function counterDelta(current: number, previous: number | undefined): number | null {
  return previous === undefined || !Number.isFinite(current) || !Number.isFinite(previous) || current < previous ? null : current - previous;
}

export function cumulativeMeanMs(totalSeconds: number, previousSeconds: number | undefined, count: number, previousCount: number | undefined): number | null {
  const elapsed = counterDelta(totalSeconds, previousSeconds);
  const items = counterDelta(count, previousCount);
  return elapsed === null || items === null || items <= 0 ? null : Math.round(elapsed * 10000 / items) / 10;
}

export function rtpJitterMs(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000 * 10) / 10 : null;
}

export function contentMotion(fps: number, targetFps: number): "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN" {
  if (targetFps <= 0 || fps < 0) return "UNKNOWN";
  if (fps < Math.min(15, targetFps * 0.25)) return "LOW";
  return fps < targetFps * 0.6 ? "MEDIUM" : "HIGH";
}

const numericKeys: (keyof PipelineSample)[] = [
  "targetFps", "captureFps", "encodedFps", "sentFps", "receivedFps", "decodedFps", "renderFps",
  "encodeMs", "decodeMs", "rttMs", "jitterMs", "lossPct", "jitterBufferMs", "packetSendDelayMs",
];

export function smoothPipelineSample(previous: PipelineSample | undefined, current: PipelineSample, alpha = 0.3): PipelineSample {
  if (!previous) return current;
  const smoothed = { ...current };
  for (const key of numericKeys) {
    const next = current[key] as number;
    const prior = previous[key] as number;
    (smoothed[key] as number) = prior === 0 ? next : prior + (next - prior) * alpha;
  }
  return smoothed;
}

export function classifyEncoderImplementation(value: string): Pick<PipelineDiagnosis, "encoderKind" | "encoderVendor"> {
  const name = value.toLowerCase();
  const encoderKind: EncoderKind = /openh264|libvpx|libaom|software/.test(name)
    ? "software"
    : /quick sync|intel|nvenc|nvidia|amd|amf|videotoolbox|hardware/.test(name) ? "hardware" : "unknown";
  const encoderVendor: EncoderVendor = /quick sync|intel/.test(name) ? "intel"
    : /nvenc|nvidia/.test(name) ? "nvidia"
      : /amd|amf/.test(name) ? "amd"
        : /videotoolbox|apple/.test(name) ? "apple"
          : /media.?foundation/.test(name) ? "media-foundation" : "unknown";
  return { encoderKind, encoderVendor };
}

export function classifyDecoderImplementation(value: string): EncoderKind {
  if (/d3d11|dxva|nvdec|quick sync|qsv|amf|hardware/i.test(value)) return "hardware";
  if (/software|swdecoder/i.test(value)) return "software";
  return "unknown";
}

export function encoderFallbackReason(implementation: string, diagnostic: { gpuProcessAvailable?: boolean; videoEncode?: string; hardwareH264?: boolean }): string {
  if (classifyEncoderImplementation(implementation).encoderKind !== "software") return "";
  if (diagnostic.gpuProcessAvailable === false) return "Processo GPU indisponível";
  if (/^(disabled|unavailable)/.test(diagnostic.videoEncode ?? "")) return `Codificação de vídeo no Chromium: ${diagnostic.videoEncode}`;
  if (diagnostic.hardwareH264 === false) return "Windows não encontrou encoder H.264 de hardware";
  return "Chromium escolheu software; causa exata desconhecida";
}

export function diagnosePipeline(sample: PipelineSample): PipelineDiagnosis {
  const encoder = classifyEncoderImplementation(sample.encoder);
  const result = (bottleneck: PipelineBottleneck, confidence: number): PipelineDiagnosis => ({ bottleneck, confidence, ...encoder });
  if (!sample.activePicture || sample.targetFps <= 0) return result("UNKNOWN", 0);

  const budgetMs = 1000 / sample.targetFps;
  const networkPressure = sample.limitation === "bandwidth" || sample.lossPct >= 2 || sample.rttMs >= 120
    || (sample.sentFps >= sample.targetFps * 0.6 && sample.receivedFps > 0 && sample.receivedFps < sample.sentFps * 0.75);
  if (networkPressure) return result("NETWORK", sample.lossPct >= 5 || sample.rttMs >= 200 ? 0.95 : 0.8);

  if (sample.captureFps > 0) {
    if (sample.captureFps > 0 && sample.captureFps < sample.targetFps * 0.72) return result("CAPTURE", 0.85);
    if (sample.limitation === "cpu" || sample.encodeMs > budgetMs * 1.15
      || (sample.captureFps >= sample.targetFps * 0.72 && sample.encodedFps < sample.captureFps * 0.78)) {
      return result("ENCODER", sample.limitation === "cpu" ? 0.95 : 0.85);
    }
  }
  if (sample.role === "viewer") {
    if (sample.receivedFps >= sample.targetFps * 0.6 && (sample.decodeMs > budgetMs * 1.2 || sample.decodedFps < sample.receivedFps * 0.78)) {
      return result("DECODER", 0.85);
    }
    if (sample.decodedFps >= sample.targetFps * 0.6 && sample.renderFps > 0 && sample.renderFps < sample.decodedFps * 0.75) {
      return result("RENDER", 0.85);
    }
    if (sample.jitterBufferMs >= 60 || sample.packetSendDelayMs >= 50) return result("BUFFER_QUEUE", 0.65);
    if (sample.receivedFps >= sample.targetFps * 0.6 && sample.decodedFps >= sample.receivedFps * 0.78
      && (sample.renderFps === 0 || sample.renderFps >= sample.decodedFps * 0.75)) return result("NONE", 0.75);
  } else if (sample.jitterBufferMs >= 60 || sample.packetSendDelayMs >= 50) return result("BUFFER_QUEUE", 0.65);
  else if (sample.captureFps >= sample.targetFps * 0.72 && sample.encodedFps >= sample.captureFps * 0.78) {
    return result("NONE", 0.75);
  }
  return result("UNKNOWN", 0.25);
}
