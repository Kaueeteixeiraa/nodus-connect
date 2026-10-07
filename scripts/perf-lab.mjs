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
  if (!path) throw new Error("Uso: node scripts/perf-lab.mjs report <performance.log> [--duration=60] [--session=id] [--peer=outro-performance.log] [--end=data-ISO]");
  const duration = Number(option(reportArgs, "duration") ?? 60);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("--duration deve ser um numero positivo de segundos.");
  const requestedSession = option(reportArgs, "session");
  const peerPath = option(reportArgs, "peer");
  const endOption = option(reportArgs, "end");
  const end = endOption === undefined ? Infinity : Date.parse(endOption);
  if (!Number.isFinite(end) && end !== Infinity) throw new Error("--end deve ser uma data ISO valida.");
  const beforeEnd = (item) => Date.parse(item.at) <= end;
  const primaryRecords = parseRecords(await readFile(path, "utf8")).filter(beforeEnd);
  const samples = primaryRecords.filter((item) => !item.event && item.sessionId);
  if (!samples.length) throw new Error("O log nao possui amostras de desempenho.");
  const sessionId = requestedSession ?? samples.at(-1).sessionId;
  const records = peerPath ? [...primaryRecords, ...parseRecords(await readFile(peerPath, "utf8")).filter(beforeEnd)] : primaryRecords;
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
  const presentedFps = counterRate(viewer, "rendered");
  const callbackFps = round(average(viewer, "renderCallbacksFps")) ?? round(average(viewer, "renderFps"));
  const validPlayout = receiver.filter((item) => item.jitterBufferMsValid !== false);
  const motion = mode(receiver.map((item) => item.contentMotion).filter(Boolean)) ?? "UNKNOWN";
  const profileEvents = events.filter((item) => item.event === "profile-change");
  const lastAdaptation = [...sender].reverse().find((item) => item.adaptationReason);
  const knownLatency = [average(host, "encodeMs"), average(validPlayout, "jitterBufferMs"), average(viewer, "decodeMs")];
  const bottleneckOrder = Object.entries(distribution).sort((a, b) => b[1] - a[1]);
  const renderDisplay = [...viewer].reverse().find((item) => item.renderDisplay)?.renderDisplay ?? null;
  const hostDisplay = [...host].reverse().find((item) => item.renderDisplay)?.renderDisplay ?? null;
  const configuredVideo = [...host].reverse().find((item) => item.configuredVideo)?.configuredVideo ?? null;
  const actualVideo = [...host].reverse().find((item) => item.actualVideo)?.actualVideo ?? null;
  const hostIce = [...host].reverse().find((item) => item.ice)?.ice ?? null;
  const viewerIce = [...viewer].reverse().find((item) => item.ice)?.ice ?? null;
  const iceEvents = records.filter((item) => item.sessionId === sessionId && (item.event?.startsWith("ice-") || item.event === "selected-candidate-pair" || item.event === "direct-failed"))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const selectedIce = viewerIce?.selected ?? hostIce?.selected ?? null;
  const inboundVideo = [...viewer].reverse().find((item) => item.inboundVideo)?.inboundVideo ?? null;
  const presentation = [...viewer].reverse().find((item) => item.presentation)?.presentation ?? null;
  const resolutionPipeline = inspectResolutionPipeline(actualVideo, inboundVideo, presentation);
  const preset = configuredVideo?.diagnostic?.preset ?? null;
  const activation = preset ? [...records].reverse().find((item) => item.event === "diagnostic-preset-activated" && item.preset === preset) ?? null : null;
  const expectedBenchmark = preset ? {
    resolution: configuredVideo?.resolution, fps: configuredVideo?.fps, bitrate: configuredVideo?.bitrate,
    maxFramerate: configuredVideo?.diagnostic?.maxFramerate, scaleResolutionDownBy: configuredVideo?.diagnostic?.scaleResolutionDownBy,
    nativeResolution: configuredVideo?.diagnostic?.nativeResolution === true,
    contentHint: configuredVideo?.diagnostic?.contentHint ?? null,
    degradationPreference: configuredVideo?.diagnostic?.degradationPreference ?? null,
  } : null;
  const activationValid = !expectedBenchmark ? null : Boolean(activation
    && `${activation.requestedWidth}x${activation.requestedHeight}` === expectedBenchmark.resolution
    && activation.requestedFps === expectedBenchmark.fps
    && activation.maxFramerate === expectedBenchmark.maxFramerate
    && activation.bitrateKbps === Math.round(expectedBenchmark.bitrate / 1000)
    && activation.scaleResolutionDownBy === expectedBenchmark.scaleResolutionDownBy
    && activation.adaptiveLocked === true
    && (!expectedBenchmark.nativeResolution || activation.nativeResolution === true)
    && (!expectedBenchmark.contentHint || activation.contentHint === expectedBenchmark.contentHint)
    && (!expectedBenchmark.degradationPreference || activation.degradationPreference === expectedBenchmark.degradationPreference));
  const actualSender = actualVideo?.sender ?? null;
  const track = actualVideo?.capture ?? null;
  const senderValid = !expectedBenchmark || !actualSender ? null : actualSender.maxFramerate === expectedBenchmark.maxFramerate
    && actualSender.scaleResolutionDownBy === expectedBenchmark.scaleResolutionDownBy
    && actualSender.maxBitrate === expectedBenchmark.bitrate
    && (!expectedBenchmark.degradationPreference || actualSender.degradationPreference === expectedBenchmark.degradationPreference)
    && (!expectedBenchmark.contentHint || actualVideo.contentHint === expectedBenchmark.contentHint);
  const trackValid = !expectedBenchmark || !track ? null : expectedBenchmark.nativeResolution
    ? track.width > 0 && track.height > 0 && track.frameRate === expectedBenchmark.fps
    : track.width === Number(expectedBenchmark.resolution?.split("x")[0]) && track.height === Number(expectedBenchmark.resolution?.split("x")[1]) && track.frameRate === expectedBenchmark.fps;
  const adaptiveChanges = maximum(host, "profileChangeCount") ?? 0;
  const inputWindows = viewer.map((sample) => sample.inputDiagnostic).filter(Boolean);
  const inputAcks = [...new Map(inputWindows.filter((sample) => sample.latest).map((sample) => [sample.latest.id, sample.latest])).values()];
  const confirmedInput = inputAcks.filter((sample) => sample.ok && sample.positionConfirmed === true);
  const report = {
    sessionId,
    diagnostic: {
      label: mode(windowSamples.map((item) => item.diagnosticLabel).filter(Boolean)) ?? null,
      lightweightMode: Object.fromEntries(["host", "viewer"].map((role) => [role, mode(windowSamples.filter((item) => item.role === role).map((item) => item.lightweightMode).filter((value) => typeof value === "boolean")) ?? null])),
      configured: configuredVideo,
      actual: actualVideo,
      pixelsPerSecond: (() => {
        const capture = [...host].reverse().find((item) => item.actualVideo?.capture)?.actualVideo.capture;
        return capture?.width && capture?.height && capture?.frameRate ? Math.round(capture.width * capture.height * capture.frameRate) : null;
      })(),
    },
    windowSeconds: Math.round(Math.min(...Object.entries(latestByRole).map(([role, latest]) => (latest - Math.min(...windowSamples.filter((item) => item.role === role).map((item) => Date.parse(item.at)))) / 1000))),
    samples: windowSamples.length,
    roles: [...new Set(windowSamples.map((item) => item.role))],
    input: {
      enabled: inputWindows.length > 0, hostSupported: inputWindows.some((sample) => sample.hostSupported === true),
      samples: inputAcks.length, windowsPositionConfirmedSamples: confirmedInput.length,
      failedSamples: inputAcks.filter((sample) => !sample.ok).length,
      mouseEventsPerSecond: round(average(inputWindows, "mouseEventsPerSecond")),
      sendsPerSecond: round(average(inputWindows, "sendsPerSecond")),
      coalesced: maximum(inputWindows, "coalesced"), bufferDrops: maximum(inputWindows, "bufferDrops"),
      bufferDeferrals: maximum(inputWindows, "bufferDeferrals"),
      hostStaleDrops: maximum(host.map((sample) => sample.inputDiagnostic).filter(Boolean), "staleDrops"),
      hostRateDrops: maximum(host.map((sample) => sample.inputDiagnostic).filter(Boolean), "rateDrops"),
      bufferedAmountPeak: maximum(inputWindows, "bufferedAmount"), probeTimeouts: maximum(inputWindows, "probeTimeouts"),
      eventToSendMsAverage: round(average(inputAcks, "eventToSendMs")),
      nativeAckRttMsAverage: round(average(confirmedInput, "commandAckRttMs")),
      nativeAckRttMsP95: round(percentile(confirmedInput, "commandAckRttMs", 0.95)),
      nativeAckRttMsP99: round(percentile(confirmedInput, "commandAckRttMs", 0.99)),
      nativeAckRttMsMax: round(maximum(confirmedInput, "commandAckRttMs")),
      nativeAckOver500MsSamples: confirmedInput.filter((sample) => sample.commandAckRttMs >= 500).length,
      unconfirmedPositionSamples: inputAcks.filter((sample) => sample.ok && sample.positionConfirmed === false).length,
      hostProcessingMsAverage: round(average(confirmedInput, "hostProcessingMs")),
      ipcRoundTripMsAverage: round(average(confirmedInput, "ipcRoundTripMs")),
      mainToWindowsAckMsAverage: round(average(confirmedInput, "mainToWindowsAckMs")),
      transportAckRoundTripMsAverage: round(average(confirmedInput, "transportAckRoundTripMs")),
      oneWayTransportMs: null, commandLatencyMs: null, visualFeedbackLatencyMs: null,
      measurement: "native-input-barrier-ack-rtt-not-one-way",
    },
    fps: { ...Object.fromEntries(["captureFps", "encodedFps", "sentFps", "receivedFps", "decodedFps"].map((key) => [key, round(average(["captureFps", "encodedFps", "sentFps"].includes(key) ? sender : viewer, key))])), renderFps: presentedFps ?? callbackFps, renderCallbacksFps: callbackFps },
    renderFps1PercentLow: activeRender.length >= 20 && activeRender.every((item) => item.renderMeasurement === "presentedFrames") ? round(percentile(activeRender, "renderFps", 0.01)) : null,
    network: {
      bitrateKbps: round(average(receiver, "bitrateKbps")),
      bitrateKbpsPeak: round(maximum(receiver, "bitrateKbps")),
      rttMsAverage: round(average(receiver, "latencyMs")),
      rttMsP95: round(percentile(receiver, "latencyMs", 0.95)),
      controlRttMsAverage: round(average(viewer, "controlLatencyMs")),
      jitterMs: round(average(receiver, "jitterMs")),
      packetLossPct: round(average(receiver.filter((item) => item.packetLossPctValid !== false), "packetLossPct")),
      jitterBufferMs: round(average(validPlayout, "jitterBufferMs")),
      rtpJitterMs: round(average(receiver, "jitterMs")),
      availableKbps: round(average(host, "availableKbps")),
      outgoingBitrateKbps: round(average(host, "bitrateKbps")),
      route: mode(receiver.map((item) => item.route).filter(Boolean)) ?? "unknown",
      transport: mode(receiver.map((item) => item.transport).filter(Boolean)) ?? "unknown",
    },
    media: {
      codec: mode(sender.map((item) => item.codec).filter(Boolean)) ?? "unknown",
      codecProfile: mode(sender.map((item) => item.codecProfile).filter(Boolean)) ?? "unknown",
      encoder,
      encoderKind: mode(sender.map((item) => item.encoderKind).filter(Boolean)) ?? classifyEncoder(encoder),
      encoderFallbackReason: mode(host.map((item) => item.encoderFallbackReason).filter(Boolean)) ?? "unknown",
      qualityLimitation: mode(host.map((item) => item.limitation).filter(Boolean)) ?? "unknown",
      decoder: mode(viewer.map((item) => item.decoder).filter(Boolean)) ?? "unknown",
      decoderKind: classifyDecoder(mode(viewer.map((item) => item.decoder).filter(Boolean)) ?? ""),
      rtpReliability: { host: host.at(-1)?.rtpReliability ?? null, viewer: viewer.at(-1)?.rtpReliability ?? null },
      encodeMs: round(average(sender.filter((item) => item.encodedFps > 0), "encodeMs")),
      encodeMsP95: round(percentile(sender.filter((item) => item.encodedFps > 0), "encodeMs", 0.95)),
      decodeMs: round(average(viewer.filter((item) => item.decodedFps > 0), "decodeMs")),
      decodeMsP95: round(percentile(viewer.filter((item) => item.decodedFps > 0), "decodeMs", 0.95)),
      averageQp: round(averageNested(host, "actualVideo", "outbound", "averageQp")),
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
      renderFpsSource: presentedFps !== null ? "presentedFrames counter" : "video frame callback rate",
      appliedFps: round(average(sender, "appliedFps")),
      appliedResolution: mode(sender.filter((item) => item.appliedWidth && item.appliedHeight).map((item) => `${item.appliedWidth}x${item.appliedHeight}`)) ?? "unknown",
      appliedBitrateKbps: round(average(sender, "appliedBitrateKbps")),
    },
    rendering: {
      display: renderDisplay,
      refreshRateHz: renderDisplay?.refreshRateHz ?? null,
      devicePixelRatio: renderDisplay?.devicePixelRatio ?? null,
      fullscreen: renderDisplay?.fullscreen ?? null,
      rendererCpuPercent: renderDisplay?.rendererCpuPercent ?? null,
      frameTiming: Object.fromEntries(["frameAgeMs", "receiveToPresentMs", "frameProcessingMs", "presentationCallbackDelayMs"]
        .map(key => [key, round(averageNested(viewer.filter(item => item.renderSampleAgeMs >= 0 && item.renderSampleAgeMs < 3000), "frameTiming", key))])),
      frameTimingMeasurement: "browser-estimated-capture-to-presentation-not-input-latency",
    },
    imageQuality: {
      resolutionPipeline,
      doubleScaling: resolutionPipeline.doubleScaling,
      contentHint: actualVideo?.contentHint ?? null,
      degradationPreference: actualSender?.degradationPreference ?? null,
      actualOutgoingBitrateKbps: round(average(host, "bitrateKbps")),
      availableOutgoingBitrateKbps: round(average(host, "availableKbps")),
      averageQp: round(averageNested(host, "actualVideo", "outbound", "averageQp")),
    },
    cursor: actualVideo?.cursorCapture ?? null,
    cursorValidation: { localOverlayObserved: viewer.some((item) => item.localCursorOverlay === true),
      hostCursorExcludedFromVideo: actualVideo?.cursorCapture?.applied === "never" ? "SETTINGS_CONFIRMED_VISUAL_UNVERIFIED" : actualVideo?.cursorCapture?.applied ? "NO" : "INCONCLUSIVE" },
    ice: {
      policy: [...windowSamples].reverse().find((item) => item.iceTransportPolicy)?.iceTransportPolicy ?? null,
      configuredServers: iceEvents.filter((item) => item.event === "ice-started").map(({ role, servers }) => ({ role,
        servers: Array.isArray(servers) ? servers.map(({ type, host, transport }) => ({ type, host, transport })) : [] })),
      states: { host: host.at(-1)?.iceStates ?? null, viewer: viewer.at(-1)?.iceStates ?? null },
      host: hostIce, viewer: viewerIce, selectedPair: selectedIce,
      classification: viewerIce?.classification ?? hostIce?.classification ?? "UNKNOWN",
      directFailureReason: viewerIce?.failureReason ?? hostIce?.failureReason ?? null,
      directAttempted: viewerIce?.directPairs?.attempted ?? hostIce?.directPairs?.attempted ?? null,
      stun: { host: stunResult(hostIce, host.at(-1)?.iceStates), viewer: stunResult(viewerIce, viewer.at(-1)?.iceStates) },
      turn: { used: selectedIce?.route === "relay", server: [hostIce?.selected?.local, viewerIce?.selected?.local].find((candidate) => candidate?.type === "relay" && candidate.server)?.server ?? null,
        region: null, transport: [hostIce?.selected?.local, viewerIce?.selected?.local].find((candidate) => candidate?.type === "relay")?.relayProtocol ?? null,
        segmentRttMs: null },
      restarts: { host: host.at(-1)?.iceRestartCount ?? null, viewer: viewer.at(-1)?.iceRestartCount ?? null,
        viewerReason: viewer.at(-1)?.iceRestartReason ?? null, viewerTimeSinceLastMs: viewer.at(-1)?.timeSinceLastIceRestartMs ?? null },
      timeline: iceEvents.map(({ at, role, event, elapsedMs, side, type, protocol, priority, state, pair, reason, count, server, code }) =>
        ({ at, role, event, elapsedMs, side, type, protocol, priority, state, pair, reason, count, server, code })),
    },
    validation: {
      requested: configuredVideo ? { resolution: configuredVideo.resolution ?? null, fps: configuredVideo.fps ?? null, bitrate: configuredVideo.bitrate ?? null, lockAdaptive: configuredVideo.diagnostic?.lockAdaptive ?? null, nativeResolution: configuredVideo.diagnostic?.nativeResolution ?? false, contentHint: configuredVideo.diagnostic?.contentHint ?? null, degradationPreference: configuredVideo.diagnostic?.degradationPreference ?? null } : null,
      trackSettings: actualVideo?.capture ?? null,
      constraints: actualVideo?.constraints ?? null,
      sender: actualVideo?.sender ?? null,
      qualityLimitationDurations: actualVideo?.outbound?.qualityLimitationDurations ?? null,
      rendererCpuPercent: { host: hostDisplay?.rendererCpuPercent ?? null, viewer: renderDisplay?.rendererCpuPercent ?? null },
      benchmark: !expectedBenchmark ? { status: "NOT_REQUESTED" } : {
        status: activationValid && senderValid && trackValid && adaptiveChanges === 0 ? "PASS" : "FAIL",
        activation, activationValid, senderValid, trackValid, adaptiveChanges,
        abortReason: activationValid ? senderValid === false ? "SENDER_PARAMETERS_MISMATCH" : trackValid === false ? "TRACK_SETTINGS_MISMATCH" : adaptiveChanges > 0 ? "ADAPTIVE_PROFILE_CHANGED" : null : "DIAGNOSTIC_PRESET_NOT_CONFIRMED",
      },
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
      channelBuffersPeak: Object.fromEntries(["control", "pointer", "clipboard", "telemetry"].map(key => [key, maximum(windowSamples.map(item => item.channelBuffers ?? {}), key)])),
      pendingPointerPositionsPeak: maximum(windowSamples, "pendingPointerPositions"),
    },
    gpu: {
      host: gpuSummary(host),
      viewer: gpuSummary(viewer),
    },
    warnings: [
      average(viewer, "decodedFps") > 0 && (presentedFps ?? average(viewer, "renderFps")) < average(viewer, "decodedFps") * 0.85 ? "POSSIBLE RENDER BOTTLENECK" : null,
      actualVideo?.cursorCapture?.applied && actualVideo.cursorCapture.applied !== "never" ? "CURSOR_SUPPRESSION_FAILED; HOST CURSOR STILL CAPTURED; CURSOR DUPLICATION RISK" : null,
      actualVideo?.cursorCapture && !actualVideo.cursorCapture.applied ? "CURSOR DUPLICATION RISK (CAPTURE CURSOR UNVERIFIED)" : null,
      presentedFps !== null && callbackFps !== null && callbackFps < presentedFps * 0.85 ? "FRAME CALLBACKS UNDERCOUNT PRESENTED FRAMES" : null,
      average(validPlayout, "jitterBufferMs") >= 150 ? "HIGH WEBRTC PLAYOUT DELAY (SOURCE UNDETERMINED)" : null,
    ].filter(Boolean),
    bottleneck: { predominant: mode(bottlenecks) ?? "UNKNOWN", secondary: bottleneckOrder[1]?.[0] ?? "UNKNOWN", confidence: round(average(windowSamples, "bottleneckConfidence")), distribution },
    events: events.map(({ at, event, from, to, reason, source, before, after }) => ({ at, event, from, to, reason, source, before, after })),
  };
  console.log(JSON.stringify(report, null, 2));
}

function parseRecords(contents) {
  return contents.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\[([^\]]+)\]\s+(\{.*\})$/);
    if (!match) return [];
    try { const record = JSON.parse(match[2]); return [{ ...record, at: record.at ?? match[1] }]; } catch { return []; }
  });
}

function stunResult(ice, states) {
  if (!ice) return "UNVERIFIED";
  if (ice.counts?.local?.srflx > 0) return "SUCCESS";
  return states?.gathering === "complete" ? "NO_SRFLX_OBSERVED" : "PENDING";
}

function counterDelta(items, key) {
  const values = items.map((item) => item.counters?.[key]).filter((value) => typeof value === "number" && Number.isFinite(value));
  if (values.length < 2) return null;
  return values.slice(1).reduce((total, value, index) => total + Math.max(0, value - values[index]), 0);
}

function counterRate(items, key) {
  const valid = items.filter((item) => typeof item.counters?.[key] === "number" && Number.isFinite(Date.parse(item.at)));
  if (valid.length < 2 || valid.some((item, index) => index > 0 && item.counters[key] < valid[index - 1].counters[key])) return null;
  const seconds = (Date.parse(valid.at(-1).at) - Date.parse(valid[0].at)) / 1000;
  return seconds > 0 ? round((valid.at(-1).counters[key] - valid[0].counters[key]) / seconds) : null;
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

function averageNested(items, ...path) {
  const values = items.map((item) => path.reduce((value, key) => value?.[key], item)).filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function inspectResolutionPipeline(actualVideo, inboundVideo, presentation) {
  const source = actualVideo?.source ?? null;
  const capture = actualVideo?.capture ?? null;
  const outbound = actualVideo?.outbound ?? null;
  const scale = actualVideo?.sender?.scaleResolutionDownBy ?? null;
  const streamWidth = inboundVideo?.width ?? outbound?.width ?? null;
  const streamHeight = inboundVideo?.height ?? outbound?.height ?? null;
  const presentationUpscaled = Boolean(streamWidth && streamHeight && presentation?.physicalWidth && presentation?.physicalHeight
    && (presentation.physicalWidth > streamWidth * 1.05 || presentation.physicalHeight > streamHeight * 1.05));
  const senderDownscaled = Boolean(scale && scale > 1.01) || Boolean(capture?.width && capture?.height && outbound?.width && outbound?.height
    && (outbound.width < capture.width * .99 || outbound.height < capture.height * .99));
  return {
    source,
    track: capture ? { width: capture.width ?? null, height: capture.height ?? null, frameRate: capture.frameRate ?? null } : null,
    sender: { scaleResolutionDownBy: scale, degradationPreference: actualVideo?.sender?.degradationPreference ?? null },
    outbound: outbound ? { width: outbound.width ?? null, height: outbound.height ?? null } : null,
    inbound: inboundVideo,
    presentation,
    doubleScaling: !capture || !outbound || !inboundVideo || !presentation ? "UNKNOWN"
      : senderDownscaled && presentationUpscaled ? "YES" : "NO",
  };
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
