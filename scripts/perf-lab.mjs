import { readFile } from "node:fs/promises";
import WebSocket from "ws";

const args = process.argv.slice(2);
if (args[0] === "report") await printReport(args.slice(1));
else await evaluateCdp(args);

async function evaluateCdp([port, expression]) {
  if (!port || !expression) throw new Error("Uso: node scripts/perf-lab.mjs <porta-cdp> <expressao-js> | report <performance.log> [--duration=60] [--session=id]");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((entry) => entry.type === "page");
  if (!target) throw new Error(`Nenhuma pagina na porta ${port}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const receive = (message) => {
      const response = JSON.parse(String(message));
      if (response.id !== requestId) return;
      socket.off("message", receive);
      response.error || response.result?.exceptionDetails
        ? reject(new Error(JSON.stringify(response.error || response.result.exceptionDetails)))
        : resolve(response.result);
    };
    socket.on("message", receive);
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const result = (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
  socket.close();
  console.log(typeof result === "string" ? result : JSON.stringify(result));
}

async function printReport(reportArgs) {
  const path = reportArgs.find((value) => !value.startsWith("--"));
  if (!path) throw new Error("Uso: node scripts/perf-lab.mjs report <performance.log> [--duration=60] [--session=id] [--peer=outro-performance.log]");
  const duration = Number(option(reportArgs, "duration") ?? 60);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("--duration deve ser um numero positivo de segundos.");
  const requestedSession = option(reportArgs, "session");
  const peerPath = option(reportArgs, "peer");
  const primaryRecords = parseRecords(await readFile(path, "utf8"));
  const samples = primaryRecords.filter((item) => !item.event && item.sessionId);
  if (!samples.length) throw new Error("O log nao possui amostras de desempenho.");
  const sessionId = requestedSession ?? samples.at(-1).sessionId;
  const records = peerPath ? [...primaryRecords, ...parseRecords(await readFile(peerPath, "utf8"))] : primaryRecords;
  const sessionSamples = records.filter((item) => !item.event && item.sessionId === sessionId && Number.isFinite(Date.parse(item.at)));
  if (!sessionSamples.length) throw new Error(`Sessao ${sessionId} nao encontrada nos logs.`);
  const latestByRole = Object.fromEntries([...new Set(sessionSamples.map((item) => item.role))].map((role) => [role, Math.max(...sessionSamples.filter((item) => item.role === role).map((item) => Date.parse(item.at)))]));
  const windowSamples = sessionSamples.filter((item) => Date.parse(item.at) >= latestByRole[item.role] - duration * 1000);
  const host = windowSamples.filter((item) => item.role === "host");
  const viewer = windowSamples.filter((item) => item.role === "viewer");
  const sender = host.length ? host : windowSamples;
  const receiver = viewer.length ? viewer : windowSamples;
  const events = records.filter((item) => item.event && item.sessionId === sessionId && Date.parse(item.at) >= (latestByRole[item.role] ?? Infinity) - duration * 1000);
  const bottlenecks = windowSamples.map((item) => item.bottleneck ?? inferBottleneck(item));
  const distribution = Object.fromEntries([...new Set(bottlenecks)].map((name) => [name, bottlenecks.filter((item) => item === name).length]));
  const encoder = mode(sender.map((item) => item.encoder).filter(Boolean)) ?? "unknown";
  const activeRender = viewer.filter((item) => item.activePicture === true && item.renderFps > 0);
  const validPlayout = receiver.filter((item) => item.jitterBufferMsValid !== false);
  const motion = mode(receiver.map((item) => item.contentMotion).filter(Boolean)) ?? "UNKNOWN";
  const profileEvents = events.filter((item) => item.event === "profile-change");
  const lastAdaptation = [...sender].reverse().find((item) => item.adaptationReason);
  const knownLatency = [average(host, "encodeMs"), average(validPlayout, "jitterBufferMs"), average(viewer, "decodeMs")];
  const bottleneckOrder = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  const report = {
    sessionId,
    windowSeconds: Math.round(Math.min(...Object.entries(latestByRole).map(([role, latest]) => (latest - Math.min(...windowSamples.filter((item) => item.role === role).map((item) => Date.parse(item.at)))) / 1000))),
    samples: windowSamples.length,
    roles: [...new Set(windowSamples.map((item) => item.role))],
    fps: Object.fromEntries(["captureFps", "encodedFps", "sentFps", "receivedFps", "decodedFps", "renderFps"].map((key) => [key, round(average(["captureFps", "encodedFps", "sentFps"].includes(key) ? sender : key === "renderFps" ? receiver : viewer, key))])),
    renderFps1PercentLow: activeRender.length >= 20 ? round(percentile(activeRender, "renderFps", 0.01)) : null,
    network: {
      bitrateKbps: round(average(receiver, "bitrateKbps")),
      bitrateKbpsPeak: round(maximum(receiver, "bitrateKbps")),
      rttMsAverage: round(average(receiver, "latencyMs")),
      rttMsP95: round(percentile(receiver, "latencyMs", 0.95)),
      controlRttMsAverage: round(average(viewer, "controlLatencyMs")),
      jitterMs: round(average(receiver, "jitterMs")),
      packetLossPct: round(average(receiver, "packetLossPct")),
      jitterBufferMs: round(average(validPlayout, "jitterBufferMs")),
      rtpJitterMs: round(average(receiver, "jitterMs")),
      availableKbps: round(average(host, "availableKbps")),
      route: mode(receiver.map((item) => item.route).filter(Boolean)) ?? "unknown",
      transport: mode(receiver.map((item) => item.transport).filter(Boolean)) ?? "unknown",
    },
    media: {
      codec: mode(sender.map((item) => item.codec).filter(Boolean)) ?? "unknown",
      codecProfile: mode(sender.map((item) => item.codecProfile).filter(Boolean)) ?? "unknown",
      encoder,
      encoderKind: mode(sender.map((item) => item.encoderKind).filter(Boolean)) ?? classifyEncoder(encoder),
      encoderFallbackReason: mode(host.map((item) => item.encoderFallbackReason).filter(Boolean)) ?? "unknown",
      decoder: mode(viewer.map((item) => item.decoder).filter(Boolean)) ?? "unknown",
      decoderKind: classifyDecoder(mode(viewer.map((item) => item.decoder).filter(Boolean)) ?? ""),
      encodeMs: round(average(sender.filter((item) => item.encodedFps > 0), "encodeMs")),
      encodeMsP95: round(percentile(sender.filter((item) => item.encodedFps > 0), "encodeMs", 0.95)),
      decodeMs: round(average(viewer.filter((item) => item.decodedFps > 0), "decodeMs")),
      decodeMsP95: round(percentile(viewer.filter((item) => item.decodedFps > 0), "decodeMs", 0.95)),
      freezes: sum(receiver, "freezes"),
      freezeDurationMs: numbers(receiver, "freezeDurationMs").length ? sum(receiver, "freezeDurationMs") : null,
      droppedFrames: sum(receiver, "droppedFrames"),
      counters: {
        captured: counterDelta(host, "captured"), encoded: counterDelta(host, "encoded"), sent: counterDelta(host, "sent"),
        received: counterDelta(viewer, "received"), decoded: counterDelta(viewer, "decoded"),
        rendered: counterDelta(viewer, "rendered"), dropped: counterDelta(viewer, "dropped"),
      },
    },
    video: {
      targetFps: round(average(sender, "targetFps")),
      contentMotion: motion,
      fpsInterpretation: motion === "LOW" ? "LOW MOTION INFERRED - FPS NOT SUITABLE FOR CAPACITY ANALYSIS" : motion === "UNKNOWN" ? "MOTION UNAVAILABLE" : "MOTION OBSERVED - COMPARE BOTH PEERS",
      appliedFps: round(average(sender, "appliedFps")),
      appliedResolution: mode(sender.filter((item) => item.appliedWidth && item.appliedHeight).map((item) => `${item.appliedWidth}x${item.appliedHeight}`)) ?? "unknown",
      appliedBitrateKbps: round(average(sender, "appliedBitrateKbps")),
    },
    buffering: {
      webRtcPlayoutMs: round(average(validPlayout, "jitterBufferMs")),
      webRtcPlayoutP95Ms: round(percentile(validPlayout, "jitterBufferMs", 0.95)),
      webRtcTargetMs: round(average(validPlayout, "jitterBufferTargetMs")),
      webRtcMinimumMs: round(average(validPlayout, "jitterBufferMinimumMs")),
      renderQueueMs: null,
      captureQueueMs: null,
      encoderQueueMs: null,
      knownSubtotalMs: knownLatency.every((value) => value !== null) ? round(knownLatency.reduce((total, value) => total + value, 0)) : null,
      estimatedGlassToGlassMs: null,
    },
    adaptation: {
      requestedProfile: mode(sender.map((item) => item.requestedQuality).filter(Boolean)) ?? "unknown",
      appliedProfile: mode(sender.map((item) => item.quality).filter(Boolean)) ?? "unknown",
      profileChanges: profileEvents.length || maximum(sender, "profileChangeCount") || 0,
      timeSinceLastProfileChangeMs: sender.at(-1)?.timeSinceLastProfileChangeMs ?? null,
      lastReason: profileEvents.at(-1)?.reason ?? lastAdaptation?.adaptationReason ?? "unknown",
      controlBufferedBytesPeak: maximum(windowSamples, "controlBufferedBytes"),
      fileBufferedBytesPeak: maximum(windowSamples, "fileBufferedBytes"),
    },
    gpu: {
      host: gpuSummary(host),
      viewer: gpuSummary(viewer),
    },
    warnings: [
      average(viewer, "decodedFps") > 0 && average(viewer, "renderFps") < average(viewer, "decodedFps") * 0.85 ? "POSSIBLE RENDER BOTTLENECK" : null,
      average(validPlayout, "jitterBufferMs") >= 150 ? "HIGH WEBRTC PLAYOUT DELAY (SOURCE UNDETERMINED)" : null,
    ].filter(Boolean),
    bottleneck: { predominant: mode(bottlenecks) ?? "UNKNOWN", secondary: bottleneckOrder[1]?.[0] ?? "UNKNOWN", confidence: round(average(windowSamples, "bottleneckConfidence")), distribution },
    events: events.map(({ at, event, from, to, reason, source }) => ({ at, event, from, to, reason, source })),
  };
  console.log(JSON.stringify(report, null, 2));
}

function parseRecords(contents) {
  return contents.split(/\r?\n/).flatMap((line) => {
    const payload = line.match(/^\[[^\]]+\]\s+(\{.*\})$/)?.[1];
    if (!payload) return [];
    try { return [JSON.parse(payload)]; } catch { return []; }
  });
}

function counterDelta(items, key) {
  const values = items.map((item) => item.counters?.[key]).filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length < 2) return null;
  return values.slice(1).reduce((total, value, index) => total + Math.max(0, value - values[index]), 0);
}

function maximum(items, key) {
  const list = numbers(items, key);
  return list.length ? Math.max(...list) : null;
}

function gpuSummary(items) {
  return {
    adapter: mode(items.map((item) => item.gpu?.adapter).filter(Boolean)) ?? "unknown",
    videoEncode: mode(items.map((item) => item.gpu?.videoEncode).filter(Boolean)) ?? "unknown",
    videoDecode: mode(items.map((item) => item.gpu?.videoDecode).filter(Boolean)) ?? "unknown",
    gpuCompositing: mode(items.map((item) => item.gpu?.gpuCompositing).filter(Boolean)) ?? "unknown",
    gpuProcessAvailable: mode(items.map((item) => item.gpu?.gpuProcessAvailable).filter((value) => typeof value === "boolean")) ?? null,
    hardwareH264Available: mode(items.map((item) => item.gpu?.hardwareH264Available).filter((value) => typeof value === "boolean")) ?? null,
  };
}

function option(values, name) {
  return values.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function numbers(items, key) {
  return items.map((item) => item[key]).filter((value) => typeof value === "number" && Number.isFinite(value));
}

function average(items, key) {
  const list = numbers(items, key);
  return list.length ? list.reduce((total, value) => total + value, 0) / list.length : null;
}

function sum(items, key) {
  return numbers(items, key).reduce((total, value) => total + value, 0);
}

function percentile(items, key, point) {
  const list = numbers(items, key).sort((a, b) => a - b);
  return list[Math.max(0, Math.ceil(list.length * point) - 1)] ?? null;
}

function mode(items) {
  return items.reduce((best, value) => {
    const count = items.filter((item) => item === value).length;
    return !best || count > best.count ? { value, count } : best;
  }, null)?.value;
}

function round(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function classifyEncoder(value) {
  if (/openh264|libvpx|libaom|software/i.test(value)) return "software";
  if (/quick sync|intel|nvenc|nvidia|amd|amf|videotoolbox|hardware/i.test(value)) return "hardware";
  return "unknown";
}

function classifyDecoder(value) {
  if (/d3d11|dxva|nvdec|quick sync|qsv|amf|hardware/i.test(value)) return "hardware";
  if (/software|swdecoder/i.test(value)) return "software";
  return "unknown";
}

function inferBottleneck(item) {
  if (item.activePicture === false || item.contentMotion === "LOW") return "UNKNOWN";
  if ((item.bitrateKbps ?? 0) < 200 && Math.max(item.captureFps ?? 0, item.encodedFps ?? 0, item.receivedFps ?? 0, item.decodedFps ?? 0) < 45) return "UNKNOWN";
  if (item.packetLossPct >= 2 || item.latencyMs >= 120) return "NETWORK";
  if (item.jitterBufferMs >= 60 || item.packetSendDelayMs >= 50) return "BUFFER_QUEUE";
  if (item.captureFps > 0 && item.captureFps < 43) return "CAPTURE";
  if (item.captureFps >= 43 && item.encodedFps < item.captureFps * 0.78) return "ENCODER";
  if (item.receivedFps >= 36 && item.decodedFps < item.receivedFps * 0.78) return "DECODER";
  if (item.decodedFps >= 36 && item.renderFps > 0 && item.renderFps < item.decodedFps * 0.75) return "RENDER";
  return "UNKNOWN";
}
