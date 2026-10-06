const { app, BrowserWindow, desktopCapturer, screen, session } = require("electron");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PRESETS = {
  "720p60": { name: "720P60", width: 1280, height: 720, fps: 60, bitrate: 10_000_000 },
  "1080p30": { name: "1080P30", width: 1920, height: 1080, fps: 30, bitrate: 14_000_000 },
  "1080p60": { name: "1080P60", width: 1920, height: 1080, fps: 60, bitrate: 14_000_000 },
  "1080p90": { name: "1080P90", width: 1920, height: 1080, fps: 90, bitrate: 18_000_000 },
  "1080p120": { name: "1080P120", width: 1920, height: 1080, fps: 120, bitrate: 24_000_000 },
};
const args = process.argv.slice(2);
const option = (name, fallback) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const durationSeconds = Math.max(5, Number(option("duration", "60")) || 60);
const warmupSeconds = Math.max(0, Number(option("warmup", "5")) || 5);
const requestedPreset = option("preset", "");
const uiMode = option("ui", "normal");
const selected = requestedPreset ? [PRESETS[requestedPreset]].filter(Boolean) : [PRESETS["1080p30"], PRESETS["1080p60"]];
if (!selected.length || !["normal", "video-only", "both"].includes(uiMode)) throw new Error("Uso: pnpm perf:local -- --preset=1080p60 --duration=60 --warmup=5 --ui=normal|video-only|both");

for (const flag of ["enable-zero-copy", "enable-gpu-rasterization", "disable-background-timer-throttling", "disable-renderer-backgrounding", "disable-backgrounding-occluded-windows"]) app.commandLine.appendSwitch(flag);
if (process.platform === "win32") app.commandLine.appendSwitch("enable-features", ["WebRtcAllowWgcScreenCapturer", "WebRtcAllowWgcWindowCapturer", "MediaFoundationD3DVideoProcessing", "MediaFoundationSharedImageEncode"].join(","));

let motionWindow;
let labWindow;
let labOrigin = "";
let labServer;
let completing = false;
const sourceName = "Nodus Local Motion Lab";

function motionMarkup() {
  return `<!doctype html><meta charset="utf-8"><title>${sourceName}</title><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#020713;color:#dff7ff;font-family:Segoe UI,system-ui}#grid{position:fixed;inset:0;background:linear-gradient(#174c7122 1px,transparent 1px),linear-gradient(90deg,#174c7122 1px,transparent 1px);background-size:48px 48px}#orb{position:absolute;width:13vmin;height:13vmin;border-radius:50%;background:#29c8ff;box-shadow:0 0 80px #168cff}#bar{position:absolute;left:8%;right:8%;bottom:14%;height:22px;background:#07345d;border:1px solid #26c9ff}#bar i{display:block;height:100%;width:0;background:#2de5a4}#text{position:absolute;left:8%;top:9%;font-size:clamp(28px,5vw,76px);font-weight:800;letter-spacing:.08em}#meter{position:absolute;right:8%;top:11%;font-size:clamp(18px,2vw,38px);color:#4dd5ff}</style><div id="grid"></div><div id="orb"></div><div id="text">NODUS MOTION LAB</div><div id="meter"></div><div id="bar"><i></i></div><script>const orb=document.querySelector('#orb'),meter=document.querySelector('#meter'),bar=document.querySelector('#bar i');const start=performance.now();function frame(now){const t=(now-start)/1000;orb.style.transform='translate('+(innerWidth*.43+Math.sin(t*2.1)*innerWidth*.31)+'px,'+(innerHeight*.42+Math.cos(t*1.7)*innerHeight*.27)+'px)';bar.style.width=((Math.sin(t*2)+1)*50)+'%';meter.textContent='FRAME '+Math.floor(t*60)+' | '+(60+Math.round(Math.sin(t*3)*8))+' HZ';requestAnimationFrame(frame)}requestAnimationFrame(frame)</script>`;
}

function viewerMarkup(videoOnly) {
  return `<!doctype html><meta charset="utf-8"><title>Nodus Local Viewer</title><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#01050b;color:#dff7ff;font-family:Segoe UI,system-ui}main{height:100%;display:grid;grid-template-columns:minmax(0,1fr) ${videoOnly ? "0px" : "260px"};gap:12px;padding:12px}.surface{position:relative;min-width:0;min-height:0;background:#000;border:1px solid #168ed8}video{width:100%;height:100%;object-fit:contain;background:#000}aside{padding:18px;border:1px solid #124e76;background:#071422}aside h1{font-size:16px;margin:0 0 18px}aside p{font-size:12px;color:#91b8d3;border-top:1px solid #1a4260;padding-top:10px}</style><main><section class="surface"><video autoplay playsinline></video></section>${videoOnly ? "" : "<aside><h1>Nodus Local Viewer</h1><p>Pipeline local WebRTC</p><p>Capture → Encode → Decode → Render</p></aside>"}</main>`;
}

async function wait(ms) { await new Promise((resolve) => setTimeout(resolve, ms)); }
async function runLoopback(config) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const within = (promise, label, ms = 15000) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`LOCAL LOOPBACK LAB timeout: ${label}`); })]);
  const mean = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
  const percentile = (values, point) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * point) - 1)] ?? null;
  };
  const delta = (end, start) => Number.isFinite(end) && Number.isFinite(start) && end >= start ? end - start : null;
  const rate = (end, start, seconds) => { const value = delta(end, start); return value === null ? null : value / seconds; };
  const video = document.querySelector("video");
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("LOCAL LOOPBACK LAB: getDisplayMedia indisponivel neste contexto");
  const stream = await within(navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: config.fps, max: config.fps }, width: { ideal: config.width, max: config.width }, height: { ideal: config.height, max: config.height } },
    audio: false,
  }), "getDisplayMedia");
  const track = stream.getVideoTracks()[0];
  track.contentHint = "motion";
  const host = new RTCPeerConnection();
  const viewer = new RTCPeerConnection();
  const hostCandidates = [];
  const viewerCandidates = [];
  host.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    if (viewer.remoteDescription) viewer.addIceCandidate(candidate).catch(() => {});
    else hostCandidates.push(candidate);
  };
  viewer.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    if (host.remoteDescription) host.addIceCandidate(candidate).catch(() => {});
    else viewerCandidates.push(candidate);
  };
  const sender = host.addTrack(track, stream);
  const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
  const rank = (codec) => {
    const name = codec.mimeType.split("/")[1]?.toLowerCase();
    if (name === "h264") return /packetization-mode=1/i.test(codec.sdpFmtpLine || "") && /profile-level-id=42/i.test(codec.sdpFmtpLine || "") ? 0 : 1;
    return ({ vp8: 2, vp9: 3, av1: 4 })[name] ?? 5;
  };
  host.getTransceivers()[0].setCodecPreferences?.([...codecs].sort((left, right) => rank(left) - rank(right)));
  viewer.addTransceiver("video", { direction: "recvonly" });
  viewer.ontrack = (event) => { video.srcObject = event.streams[0]; video.play().catch(() => undefined); };
  const parameters = sender.getParameters();
  if (!parameters.encodings.length) parameters.encodings = [{}];
  parameters.degradationPreference = "maintain-framerate";
  parameters.encodings[0].maxBitrate = config.bitrate;
  parameters.encodings[0].maxFramerate = config.fps;
  parameters.encodings[0].scaleResolutionDownBy = 1;
  parameters.encodings[0].priority = "high";
  parameters.encodings[0].networkPriority = "high";
  await sender.setParameters(parameters);
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Loopback WebRTC connection timeout")), 15000);
    viewer.onconnectionstatechange = () => {
      if (viewer.connectionState === "connected") { clearTimeout(timer); resolve(); }
      if (viewer.connectionState === "failed") { clearTimeout(timer); reject(new Error("Loopback WebRTC connection failed")); }
    };
  });
  await host.setLocalDescription(await host.createOffer());
  await viewer.setRemoteDescription(host.localDescription);
  await Promise.all(hostCandidates.splice(0).map((candidate) => viewer.addIceCandidate(candidate)));
  await viewer.setLocalDescription(await viewer.createAnswer());
  await host.setRemoteDescription(viewer.localDescription);
  await Promise.all(viewerCandidates.splice(0).map((candidate) => host.addIceCandidate(candidate)));
  if (viewer.connectionState === "connected") await Promise.resolve(); else await connected;
  let presented = 0;
  let callbacks = 0;
  let presentationMetadata = null;
  const frame = (_now, metadata) => { callbacks += 1; presented = metadata.presentedFrames || presented; presentationMetadata = metadata; video.requestVideoFrameCallback(frame); };
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
  const stats = async () => {
    const [hostStats, viewerStats] = await Promise.all([host.getStats(), viewer.getStats()]);
    let source = {}, outbound = {}, inbound = {}, codec = {}, selectedPair = {};
    for (const item of hostStats.values()) {
      if (item.type === "media-source" && item.kind === "video") source = item;
      if (item.type === "outbound-rtp" && item.kind === "video") { outbound = item; codec = hostStats.get(item.codecId) || codec; }
      if (item.type === "candidate-pair" && item.state === "succeeded" && (item.selected || item.nominated)) selectedPair = item;
    }
    for (const item of viewerStats.values()) if (item.type === "inbound-rtp" && item.kind === "video") inbound = item;
    const quality = video.getVideoPlaybackQuality?.();
    return {
      at: performance.now(), track: track.getSettings(), constraints: track.getConstraints(), sender: sender.getParameters(),
      source: { frames: source.frames ?? 0, framesPerSecond: source.framesPerSecond ?? null, width: source.width ?? null, height: source.height ?? null },
      outbound: { framesEncoded: outbound.framesEncoded ?? 0, framesSent: outbound.framesSent ?? 0, totalEncodeTime: outbound.totalEncodeTime ?? 0, framesDropped: outbound.framesDropped ?? 0, encoderImplementation: outbound.encoderImplementation ?? "unknown", qualityLimitationReason: outbound.qualityLimitationReason ?? "unknown", qualityLimitationDurations: outbound.qualityLimitationDurations ?? null, frameWidth: outbound.frameWidth ?? null, frameHeight: outbound.frameHeight ?? null },
      inbound: { framesReceived: inbound.framesReceived ?? 0, framesDecoded: inbound.framesDecoded ?? 0, framesDropped: inbound.framesDropped ?? 0, totalDecodeTime: inbound.totalDecodeTime ?? 0, decoderImplementation: inbound.decoderImplementation ?? "unknown", freezeCount: inbound.freezeCount ?? 0, totalFreezesDuration: inbound.totalFreezesDuration ?? 0, jitterBufferDelay: inbound.jitterBufferDelay ?? 0, jitterBufferTargetDelay: inbound.jitterBufferTargetDelay ?? null, jitterBufferMinimumDelay: inbound.jitterBufferMinimumDelay ?? null, jitterBufferEmittedCount: inbound.jitterBufferEmittedCount ?? 0 },
      codec: { mimeType: codec.mimeType ?? "unknown", profile: codec.sdpFmtpLine ?? "unknown" },
      rendered: (presentationMetadata?.presentedFrames ?? presented) || quality?.totalVideoFrames || 0, callbacks, playbackDropped: quality?.droppedVideoFrames ?? 0,
      localOnly: { currentRoundTripTime: selectedPair.currentRoundTripTime ?? null, availableOutgoingBitrate: selectedPair.availableOutgoingBitrate ?? null },
    };
  };
  await sleep(config.warmupMs);
  const initial = await stats();
  const samples = [];
  const until = performance.now() + config.durationMs;
  while (performance.now() < until) { await sleep(500); samples.push(await stats()); }
  const final = samples.at(-1) || await stats();
  const seconds = Math.max(.001, (final.at - initial.at) / 1000);
  const intervalTimes = (stage, counter, time) => samples.slice(1).map((sample, index) => {
    const previous = samples[index]; const frames = sample[stage][counter] - previous[stage][counter]; const elapsed = sample[stage][time] - previous[stage][time]; return frames > 0 ? elapsed * 1000 / frames : null;
  }).filter(Number.isFinite);
  const result = {
    requested: { resolution: `${config.width}x${config.height}`, fps: config.fps, bitrate: config.bitrate, maxFramerate: config.fps, scaleResolutionDownBy: 1, durationSeconds: Math.round(seconds * 10) / 10, warmupSeconds: config.warmupMs / 1000, ui: config.ui },
    trackSettings: final.track, constraints: final.constraints,
    host: { capture: { width: final.source.width, height: final.source.height, fps: rate(final.source.frames, initial.source.frames, seconds) ?? final.source.framesPerSecond, frames: delta(final.source.frames, initial.source.frames) }, encode: { fps: rate(final.outbound.framesEncoded, initial.outbound.framesEncoded, seconds), frames: delta(final.outbound.framesEncoded, initial.outbound.framesEncoded), averageMs: (() => { const frames = delta(final.outbound.framesEncoded, initial.outbound.framesEncoded); const time = delta(final.outbound.totalEncodeTime, initial.outbound.totalEncodeTime); return frames ? time * 1000 / frames : null; })(), p95Ms: percentile(intervalTimes("outbound", "framesEncoded", "totalEncodeTime"), .95), implementation: final.outbound.encoderImplementation }, send: { fps: rate(final.outbound.framesSent, initial.outbound.framesSent, seconds), frames: delta(final.outbound.framesSent, initial.outbound.framesSent) }, sender: { maxFramerate: final.sender.encodings?.[0]?.maxFramerate ?? null, maxBitrate: final.sender.encodings?.[0]?.maxBitrate ?? null, scaleResolutionDownBy: final.sender.encodings?.[0]?.scaleResolutionDownBy ?? null, degradationPreference: final.sender.degradationPreference ?? null }, qualityLimitation: { reason: final.outbound.qualityLimitationReason, durations: final.outbound.qualityLimitationDurations } },
    viewer: { receive: { fps: rate(final.inbound.framesReceived, initial.inbound.framesReceived, seconds), frames: delta(final.inbound.framesReceived, initial.inbound.framesReceived) }, decode: { fps: rate(final.inbound.framesDecoded, initial.inbound.framesDecoded, seconds), frames: delta(final.inbound.framesDecoded, initial.inbound.framesDecoded), averageMs: (() => { const frames = delta(final.inbound.framesDecoded, initial.inbound.framesDecoded); const time = delta(final.inbound.totalDecodeTime, initial.inbound.totalDecodeTime); return frames ? time * 1000 / frames : null; })(), p95Ms: percentile(intervalTimes("inbound", "framesDecoded", "totalDecodeTime"), .95), implementation: final.inbound.decoderImplementation }, render: { fps: rate(final.rendered, initial.rendered, seconds), frames: delta(final.rendered, initial.rendered), callbacks: delta(final.callbacks, initial.callbacks), dropped: delta(final.playbackDropped, initial.playbackDropped) }, freezes: { count: delta(final.inbound.freezeCount, initial.inbound.freezeCount), durationMs: (delta(final.inbound.totalFreezesDuration, initial.inbound.totalFreezesDuration) ?? 0) * 1000 }, playout: { averageMs: (() => { const delay = delta(final.inbound.jitterBufferDelay, initial.inbound.jitterBufferDelay); const emitted = delta(final.inbound.jitterBufferEmittedCount, initial.inbound.jitterBufferEmittedCount); return emitted ? delay * 1000 / emitted : null; })(), targetMs: (() => { const delay = delta(final.inbound.jitterBufferTargetDelay, initial.inbound.jitterBufferTargetDelay); const emitted = delta(final.inbound.jitterBufferEmittedCount, initial.inbound.jitterBufferEmittedCount); return delay !== null && emitted ? delay * 1000 / emitted : null; })(), minimumMs: (() => { const delay = delta(final.inbound.jitterBufferMinimumDelay, initial.inbound.jitterBufferMinimumDelay); const emitted = delta(final.inbound.jitterBufferEmittedCount, initial.inbound.jitterBufferEmittedCount); return delay !== null && emitted ? delay * 1000 / emitted : null; })() } },
    media: { codec: final.codec }, localOnly: final.localOnly,
  };
  host.close(); viewer.close(); stream.getTracks().forEach((item) => item.stop());
  return result;
}

function retention(previous, next) {
  return previous > 0 && next !== null ? Math.round(next / previous * 1000) / 10 : null;
}

function classify(result) {
  const capture = result.host.capture.fps ?? 0;
  const encode = result.host.encode.fps ?? 0;
  const receive = result.viewer.receive.fps ?? 0;
  const decode = result.viewer.decode.fps ?? 0;
  const render = result.viewer.render.fps ?? 0;
  const target = result.requested.fps;
  if ((result.trackSettings.frameRate ?? 0) < target * .72) return { primary: "CAPTURE TRACK LIMITED", confidence: .9 };
  if (capture < target * .72) return { primary: "POSSIBLE CAPTURE BOTTLENECK", confidence: .85 };
  if (encode < capture * .78) return { primary: "POSSIBLE ENCODER BOTTLENECK", confidence: .85 };
  if (decode < receive * .78) return { primary: "POSSIBLE DECODER BOTTLENECK", confidence: .85 };
  if (render > 0 && render < decode * .75) return { primary: "POSSIBLE RENDER BOTTLENECK", confidence: .85 };
  return { primary: "NO LOCAL STAGE BOTTLENECK DETECTED", confidence: .7 };
}

async function createWindows(preset, videoOnly) {
  motionWindow = new BrowserWindow({ title: sourceName, width: preset.width, height: preset.height, useContentSize: true, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  labWindow = new BrowserWindow({ title: "Nodus Local Performance Lab", width: 1280, height: 760, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  await Promise.all([motionWindow.loadURL(`${labOrigin}/motion`), labWindow.loadURL(`${labOrigin}/viewer?videoOnly=${videoOnly ? "1" : "0"}`)]);
  motionWindow.setFullScreen(true);
  await wait(750);
  motionWindow.focus();
}

async function runPreset(preset, videoOnly) {
  await createWindows(preset, videoOnly);
  const result = await labWindow.webContents.executeJavaScript(`(${runLoopback.toString()})(${JSON.stringify({ ...preset, durationMs: durationSeconds * 1000, warmupMs: warmupSeconds * 1000, ui: videoOnly ? "video-only" : "normal" })})`, true);
  const gpu = await app.getGPUInfo("basic").catch(() => null);
  const adapter = gpu?.gpuDevice?.find((device) => device.active) || gpu?.gpuDevice?.[0];
  const metrics = app.getAppMetrics();
  const cpuFor = (window) => {
    const value = metrics.find((item) => item.pid === window.webContents.getOSProcessId())?.cpu?.percentCPUUsage;
    return typeof value === "number" && value > 0 ? value : null;
  };
  const summary = { ...result, retention: { captureToEncodePct: retention(result.host.capture.fps, result.host.encode.fps), encodeToSendPct: retention(result.host.encode.fps, result.host.send.fps), sendToReceivePct: retention(result.host.send.fps, result.viewer.receive.fps), receiveToDecodePct: retention(result.viewer.receive.fps, result.viewer.decode.fps), decodeToRenderPct: retention(result.viewer.decode.fps, result.viewer.render.fps) }, bottleneck: classify(result), resources: { hostRendererCpuPercent: cpuFor(motionWindow), viewerRendererCpuPercent: cpuFor(labWindow), gpu: { adapter: adapter?.deviceString || "unknown", features: app.getGPUFeatureStatus() } } };
  motionWindow.destroy(); labWindow.destroy(); motionWindow = null; labWindow = null;
  await wait(1000);
  return summary;
}

module.exports = { motionMarkup };

if (require.main === module) app.whenReady().then(async () => {
  app.on("window-all-closed", (event) => { if (!completing) event.preventDefault(); });
  labServer = http.createServer((request, response) => {
    const url = new URL(request.url || "/", labOrigin || "http://127.0.0.1");
    const body = url.pathname === "/motion" ? motionMarkup() : url.pathname === "/viewer" ? viewerMarkup(url.searchParams.get("videoOnly") === "1") : "Not found";
    response.writeHead(url.pathname === "/motion" || url.pathname === "/viewer" ? 200 : 404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(body);
  });
  await new Promise((resolve) => labServer.listen(0, "127.0.0.1", resolve));
  labOrigin = `http://127.0.0.1:${labServer.address().port}`;
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media" || permission === "display-capture"));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === "media" || permission === "display-capture");
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const source = sources[0];
    callback(source ? { video: source } : {});
  });
  const modes = uiMode === "both" ? [false, true] : [uiMode === "video-only"];
  const tests = [];
  for (const preset of selected) for (const videoOnly of modes) tests.push(await runPreset(preset, videoOnly));
  const display = screen.getPrimaryDisplay();
  const output = { label: "LOCAL LOOPBACK LAB", createdAt: new Date().toISOString(), machine: { cpu: os.cpus()[0]?.model || "unknown", logicalCores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 1024 ** 3), display: { width: display.size.width, height: display.size.height, refreshRateHz: display.displayFrequency || null, scaleFactor: display.scaleFactor } }, limitations: ["LOCAL ONLY: não valida internet, Wi-Fi, TURN, relay, WAN ou latência entre computadores.", "A fonte e o viewer compartilham CPU e GPU; resultados são evidência local, não prova de sessão remota.", "A fonte é o monitor primário em tela cheia; em monitor menor que o preset, trackSettings registra a resolução real disponível."], tests };
  const directory = path.join(process.cwd(), "work", "local-performance-lab");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `local-loopback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ file, ...output }, null, 2));
}).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { completing = true; labServer?.close(); app.quit(); });
