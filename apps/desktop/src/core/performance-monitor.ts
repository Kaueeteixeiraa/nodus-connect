export type PipelineBottleneck = "CAPTURE" | "ENCODER" | "NETWORK" | "DECODER" | "RENDER" | "BUFFER_QUEUE" | "NONE" | "UNKNOWN";
export type EncoderKind = "hardware" | "software" | "unknown";
export type EncoderVendor = "intel" | "nvidia" | "amd" | "media-foundation" | "apple" | "unknown";

export function receiverPacketLoss(feedback: { receivedAt: number; packetLossPct?: number; packetLossPctValid?: boolean } | undefined, now: number): number | null {
  if (!feedback || !Number.isFinite(feedback.receivedAt) || now < feedback.receivedAt || now - feedback.receivedAt >= 3000
    || feedback.packetLossPctValid === false || typeof feedback.packetLossPct !== "number"
    || !Number.isFinite(feedback.packetLossPct) || feedback.packetLossPct < 0 || feedback.packetLossPct > 100) return null;
  return feedback.packetLossPct;
}

export type InputDiagnosticAck = {
  ok: boolean; error?: string; hostProcessingMs: number; ipcRoundTripMs: number;
  positionConfirmed?: boolean; mainToWindowsAckMs?: number; windowsPosition?: { x: number; y: number };
};

export class InputLatencyDiagnostic {
  hostSupported = false;
  events = 0;
  coalesced = 0;
  sent = 0;
  bufferDrops = 0;
  bufferDeferrals = 0;
  staleDrops = 0;
  received = 0;
  rateDrops = 0;
  timeouts = 0;
  serializationMs = 0;
  eventToSendMs: number | null = null;
  latest: (InputDiagnosticAck & { id: number; eventToSendMs: number | null; commandAckRttMs: number; transportAckRoundTripMs: number | null }) | null = null;
  private sequence = 0;
  private lastProbeAt = -Infinity;
  private pending = new Map<number, { sentAt: number; eventToSendMs: number | null }>();
  private windowAt: number;
  private lastCounts = { events: 0, sent: 0, received: 0 };

  constructor(now: number) { this.windowAt = now; }

  probe(now: number): number | undefined {
    this.expire(now);
    if (!this.hostSupported || now - this.lastProbeAt < 1000 || this.pending.size >= 4) return undefined;
    this.lastProbeAt = now;
    this.sequence = this.sequence % 0xffffffff + 1;
    this.pending.set(this.sequence, { sentAt: now, eventToSendMs: this.eventToSendMs });
    return this.sequence;
  }

  acknowledge(id: number, now: number, result: InputDiagnosticAck) {
    const pending = this.pending.get(id);
    if (!pending || !Number.isFinite(result.hostProcessingMs) || result.hostProcessingMs < 0
      || !Number.isFinite(result.ipcRoundTripMs) || result.ipcRoundTripMs < 0) return;
    this.pending.delete(id);
    const commandAckRttMs = Math.max(0, now - pending.sentAt);
    this.latest = { ...result, id, eventToSendMs: pending.eventToSendMs, commandAckRttMs,
      transportAckRoundTripMs: result.ok ? Math.max(0, commandAckRttMs - result.hostProcessingMs) : null };
  }

  cancel(id: number) { this.pending.delete(id); }

  snapshot(now: number, bufferedAmount: number) {
    this.expire(now);
    const elapsed = Math.max(1, now - this.windowAt);
    const rates = { mouseEventsPerSecond: (this.events - this.lastCounts.events) * 1000 / elapsed,
      sendsPerSecond: (this.sent - this.lastCounts.sent) * 1000 / elapsed,
      receivesPerSecond: (this.received - this.lastCounts.received) * 1000 / elapsed };
    this.windowAt = now;
    this.lastCounts = { events: this.events, sent: this.sent, received: this.received };
    return { ...rates, events: this.events, sent: this.sent, received: this.received, coalesced: this.coalesced,
      bufferDrops: this.bufferDrops, bufferDeferrals: this.bufferDeferrals, staleDrops: this.staleDrops,
      rateDrops: this.rateDrops, bufferedAmount, eventToSendMs: this.eventToSendMs,
      serializationMs: this.serializationMs, hostSupported: this.hostSupported, pendingProbes: this.pending.size,
      probeTimeouts: this.timeouts, latest: this.latest, oneWayTransportMs: null, commandLatencyMs: null,
      visualFeedbackLatencyMs: null, measurement: "native-input-barrier-ack-rtt-not-one-way" };
  }

  private expire(now: number) {
    for (const [id, pending] of this.pending) if (now - pending.sentAt >= 5000) { this.pending.delete(id); this.timeouts++; }
  }
}

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

export function videoFrameTiming(metadata: { captureTime?: number; receiveTime?: number; presentationTime?: number; processingDuration?: number }, now: number) {
  const elapsed = (end: number | undefined, start: number | undefined) => typeof end === "number" && typeof start === "number"
    && Number.isFinite(end) && Number.isFinite(start) && start >= 0 && end >= start ? Math.round((end - start) * 10) / 10 : null;
  return {
    frameAgeMs: elapsed(metadata.presentationTime, metadata.captureTime),
    receiveToPresentMs: elapsed(metadata.presentationTime, metadata.receiveTime),
    frameProcessingMs: elapsed(metadata.processingDuration === undefined ? undefined : metadata.processingDuration * 1000, 0),
    presentationCallbackDelayMs: elapsed(now, metadata.presentationTime),
    measurement: "browser-estimated-capture-to-presentation-not-input-latency" as const,
  };
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
