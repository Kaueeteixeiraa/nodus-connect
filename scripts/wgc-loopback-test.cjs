const { app, BrowserWindow, ipcMain, screen } = require("electron");
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { motionMarkup } = require("./local-performance-lab.cjs");

const root = path.join(__dirname, "..");
const gst = process.env.NODUS_GST_RUNTIME || path.join(root, "work", "gstreamer-runtime-package");
const duration = Math.max(5, Number(process.argv[2]) || 15);
const profile = path.join(root, "work", `wgc-loopback-profile-${process.pid}`);
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
if (process.env.NODUS_TEST_DISABLE_GPU === "1") app.commandLine.appendSwitch("disable-gpu");
if (process.env.NODUS_TEST_DISABLE_HW_DECODE === "1") app.commandLine.appendSwitch("disable-accelerated-video-decode");
let child;
let browser;
let motion;
let ready = false;
let received = false;
let pending = [];
let nativeMetrics = {};
let metricsWaiter;
let initial;
let videoSeen = false;

function viewerStats() {
  return new Promise((resolve, reject) => {
    const listener = (_event, stats) => { clearTimeout(timer); resolve(stats); };
    const timer = setTimeout(() => { ipcMain.removeListener("wgc-stats-result", listener); reject(new Error("viewer-stats-timeout")); }, 5000);
    ipcMain.once("wgc-stats-result", listener);
    browser.webContents.send("wgc-stats");
  });
}

function nativeStats() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { metricsWaiter = null; reject(new Error("native-stats-timeout")); }, 5000);
    metricsWaiter = () => { clearTimeout(timer); resolve({ ...nativeMetrics, at: performance.now() }); };
    child.stdin.write("T\n");
  });
}

async function snapshot() {
  const [host, viewer] = await Promise.all([nativeStats(), viewerStats()]);
  return { host, viewer };
}

async function finish() {
  const final = await snapshot();
  const seconds = (final.viewer.at - initial.viewer.at) / 1000;
  const nativeSeconds = (final.host.at - initial.host.at) / 1000;
  const delta = (section, key) => Number.isFinite(final[section][key]) && Number.isFinite(initial[section][key]) ? Math.max(0, final[section][key] - initial[section][key]) : null;
  const round = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const rate = (section, key) => delta(section, key) === null ? null : round(delta(section, key) / (section === "host" ? nativeSeconds : seconds));
  const captureFps = rate("host", "captureFrames"), encodeFps = rate("host", "encodeFrames");
  const receiveFps = rate("viewer", "framesReceived"), decodeFps = rate("viewer", "framesDecoded"), renderFps = rate("viewer", "framesPresented");
  const intervals = final.viewer.frameIntervals;
  const sorted = [...intervals].sort((a,b) => a-b);
  const mean = values => values.length ? values.reduce((a,b) => a+b,0) / values.length : null;
  const emitted = delta("viewer", "jitterBufferEmittedCount");
  const loss = delta("viewer", "packetsLost"), packets = delta("viewer", "packetsReceived");
  const encodeUs = delta("host", "encodeTimeUs"), timedFrames = delta("host", "encodeSamples");
  const decodeSeconds = delta("viewer", "totalDecodeTime"), decodedFrames = delta("viewer", "framesDecoded");
  const bytesReceived = delta("viewer", "bytesReceived"), freezeSeconds = delta("viewer", "totalFreezesDuration");
  const display = screen.getPrimaryDisplay();
  const result = { backend: "WGC", seconds: round(seconds), warmupSeconds: 5,
    sourceResolution: `${final.host.sourceWidth}x${final.host.sourceHeight}`, encodedResolution: `${final.viewer.videoWidth}x${final.viewer.videoHeight}`,
    displayRefreshHz: display.displayFrequency || null, captureFps, encodeFps, sendFps: null, receiveFps, decodeFps, renderFps,
    retention: { captureToEncode: round(encodeFps / captureFps * 100), encodeToSend: null, sendToReceive: null, receiveToDecode: round(decodeFps / receiveFps * 100), decodeToRender: round(renderFps / decodeFps * 100) },
    frameIntervalAvgMs: round(mean(intervals)), frameIntervalP95Ms: round(sorted[Math.ceil(sorted.length * .95)-1]), frameCallbackGaps: final.viewer.frameCallbackGaps,
    encodeTimeAvgMs: timedFrames && encodeUs !== null ? round(encodeUs / timedFrames / 1000) : null, encodeTimeP95Ms: final.host.encodeP95Us ? round(final.host.encodeP95Us / 1000) : null, decodeTimeAvgMs: decodedFrames && decodeSeconds !== null ? round(decodeSeconds * 1000 / decodedFrames) : null,
    receivedBitrateKbps: bytesReceived === null ? null : round(bytesReceived * 8 / seconds / 1000), packetLossPct: loss === null || packets === null ? null : round(loss / Math.max(1, packets + loss) * 100),
    jitterMs: final.viewer.jitter === null ? null : round(final.viewer.jitter * 1000), networkRttMs: round(final.viewer.rtt === null ? null : final.viewer.rtt * 1000),
    playoutDelayMs: emitted ? round(delta("viewer", "jitterBufferDelay") * 1000 / emitted) : null,
    freezes: delta("viewer", "freezeCount"), totalFreezeDurationMs: freezeSeconds === null ? null : round(freezeSeconds * 1000),
    codec: final.viewer.codec, encoder: final.host.encoder, hardwareEncode: final.host.hardwareEncode, decoder: final.viewer.decoder, powerEfficientDecoder: final.viewer.powerEfficientDecoder ?? null,
    hardwareDecode: /d3d11|hardware/i.test(final.viewer.decoder ?? "") ? true : /ffmpeg|openh264/i.test(final.viewer.decoder ?? "") ? false : null,
    gpu: app.getGPUFeatureStatus(), cursorCaptureRequested: false, cursorCount: null,
    primaryBottleneck: captureFps < 54 ? "CAPTURE" : encodeFps < captureFps * .95 ? "ENCODER" : decodeFps < receiveFps * .95 ? "DECODER" : renderFps < decodeFps * .95 ? "RENDER" : "NONE",
    limitations: ["LOCAL ONLY: host e viewer compartilham CPU/GPU.", "Send FPS e cursor unico ainda nao foram comprovados.", "Frame intervals usam callbacks contiguos; gaps sao registrados separadamente."] };
  const file = path.join(root, "work", `wgc-loopback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ file, ...result }, null, 2));
  child?.stdin.end("Q\n");
  motion?.destroy();
  setTimeout(() => app.quit(), 500).unref();
}

app.whenReady().then(async () => {
  if (process.env.NODUS_TEST_HEARTBEAT === "1") setInterval(() => console.log("main-heartbeat"), 1000);
  motion = new BrowserWindow({ show: true, width: 1366, height: 768, webPreferences: { backgroundThrottling: false } });
  await motion.loadURL(`data:text/html,${encodeURIComponent(motionMarkup())}`);
  motion.setFullScreen(true);
  browser = new BrowserWindow({ show: process.env.NODUS_TEST_VISIBLE !== "0", width: 720, height: 480, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  const html = `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}video{width:100%;height:100%;object-fit:contain}</style><video id="video" autoplay muted playsinline></video><script>
    const { ipcRenderer } = require('electron');
    window.framesPresented = 0;
    window.frameIntervals = []; window.frameCallbackGaps = 0;
    let lastFrame = null, videoReady = false;
    ipcRenderer.on('wgc-start', () => { frameIntervals = []; frameCallbackGaps = 0; lastFrame = null; });
    ipcRenderer.on('wgc-offer', async (_event, sdp) => {
      try {
        ipcRenderer.send('wgc-stage', 'offer-received');
        window.testPeer = new RTCPeerConnection({ iceServers: [] });
        testPeer.onicecandidate = e => { if (e.candidate) ipcRenderer.send('wgc-viewer-candidate', e.candidate.toJSON()); };
        testPeer.ontrack = e => {
          const stream = video.srcObject || new MediaStream();
          stream.addTrack(e.track);
          video.srcObject = stream;
          if (e.track.kind === 'video') {
            if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 20;
            const count = (_now, metadata) => {
              framesPresented = metadata.presentedFrames;
              if (lastFrame) {
                const gap = metadata.presentedFrames - lastFrame.presentedFrames;
                if (gap === 1) frameIntervals.push(metadata.expectedDisplayTime - lastFrame.expectedDisplayTime);
                else frameCallbackGaps += Math.max(0, gap - 1);
              }
              lastFrame = metadata;
              if (!videoReady) { videoReady = true; ipcRenderer.send('wgc-video-ready'); }
              video.requestVideoFrameCallback(count);
            };
            video.requestVideoFrameCallback(count);
          }
        };
        await testPeer.setRemoteDescription({ type: 'offer', sdp });
        ipcRenderer.send('wgc-stage', 'remote-set');
        await testPeer.setLocalDescription(await testPeer.createAnswer());
        ipcRenderer.send('wgc-stage', 'answer-created');
        ipcRenderer.send('wgc-answer', testPeer.localDescription.sdp);
      } catch (error) { ipcRenderer.send('wgc-error', error.message); }
    });
    ipcRenderer.on('wgc-candidate', (_event, candidate) => testPeer.addIceCandidate(candidate).catch(() => undefined));
    ipcRenderer.on('wgc-stats', async () => {
      const stats = await testPeer.getStats();
      const inbound = [...stats.values()].find(x => x.type === 'inbound-rtp' && x.kind === 'video');
      const pair = [...stats.values()].find(x => x.type === 'candidate-pair' && x.state === 'succeeded' && x.nominated);
      const counters = ['bytesReceived','packetsLost','packetsReceived','jitter','jitterBufferDelay','jitterBufferEmittedCount','freezeCount','totalFreezesDuration','totalDecodeTime'];
      ipcRenderer.send('wgc-stats-result', { at: performance.now(), ...Object.fromEntries(counters.map(key => [key,inbound?.[key] ?? null])), framesReceived: inbound?.framesReceived ?? 0, framesDecoded: inbound?.framesDecoded ?? 0,
        framesPresented: window.framesPresented, videoWidth: video.videoWidth, videoHeight: video.videoHeight,
        frameIntervals, frameCallbackGaps, decoder: inbound?.decoderImplementation ?? null, powerEfficientDecoder: inbound?.powerEfficientDecoder ?? null, rtt: pair?.currentRoundTripTime ?? null,
        audioTracks: video.srcObject?.getAudioTracks().length ?? 0, codec: stats.get(inbound?.codecId)?.mimeType ?? null,
        connectionState: testPeer.connectionState });
    });
  </script>`;
  await browser.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  ipcMain.on("wgc-stage", (_event, stage) => console.log(`viewer-stage=${stage}`));
  ipcMain.on("wgc-error", (_event, error) => { console.error(`viewer-error=${error}`); app.exit(1); });
  ipcMain.on("wgc-answer", (_event, answer) => {
    if (process.env.NODUS_TEST_SDP_ONLY === "1") { console.log(`sdp-answer-length=${answer.length}`); app.quit(); return; }
    received = true;
    child.stdin.write(`A ${Buffer.from(answer).toString("base64")}\n`);
    for (const candidate of pending) browser.webContents.send("wgc-candidate", candidate);
    pending = [];
  });
  ipcMain.once("wgc-video-ready", async () => {
    videoSeen = true;
    await new Promise(resolve => setTimeout(resolve, 5000));
    try {
      initial = await snapshot();
      child.stdin.write("Z\n");
      browser.webContents.send("wgc-start");
      setTimeout(() => finish().catch(error => { console.error(error); child.kill(); app.exit(1); }), duration * 1000);
    } catch (error) { console.error(error); child.kill(); app.exit(1); }
  });
  ipcMain.on("wgc-viewer-candidate", (_event, candidate) => child?.stdin.write(`I ${candidate.sdpMLineIndex} ${Buffer.from(candidate.candidate).toString("base64")}\n`));
  const env = { ...process.env, PATH: `${path.join(gst, "bin")};${process.env.PATH || ""}`, GST_PLUGIN_PATH_1_0: path.join(gst, "lib", "gstreamer-1.0"), GST_PLUGIN_SYSTEM_PATH_1_0: "", GST_REGISTRY_1_0: path.join(root, "work", "wgc-registry.bin"), GST_PLUGIN_SCANNER: path.join(gst, "libexec", "gstreamer-1.0", "gst-plugin-scanner.exe") };
  child = spawn(path.join(root, "native", "bin", "nodus-wgc-media.exe"), ["-1", process.env.NODUS_TEST_FPS || "60", "14000", "0", "0", process.env.NODUS_TEST_AUDIO === "0" ? "0" : "1"], { env, windowsHide: true });
  child.stdin.write("S 0\n");
  child.stderr.on("data", (chunk) => console.error(`native-stderr=${chunk.toString().slice(0, 180)}`));
  child.on("exit", (code) => { if (!received) { console.error(`native-exit=${code}`); app.quit(); } });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      const [type, first, second] = line.split(" ");
      if (type !== "I") console.log(`native-line=${type}`);
      if (type === "R") { ready = true; console.log(`native-ready=${line.slice(2)}`); }
      else if (type === "H") nativeMetrics = { ...nativeMetrics, encoder: Buffer.from(first, "base64").toString(), hardwareEncode: second === "1" };
      else if (type === "M") {
        const [, captureFrames, encodeFrames, rtpPackets, rtpBytes, encodeTimeUs, encodeSamples, encodeP95Us] = line.split(" ");
        nativeMetrics = { ...nativeMetrics, captureFrames: Number(captureFrames), encodeFrames: Number(encodeFrames), rtpPackets: Number(rtpPackets), rtpBytes: Number(rtpBytes), encodeTimeUs: Number(encodeTimeUs), encodeSamples: Number(encodeSamples), encodeP95Us: Number(encodeP95Us) };
        metricsWaiter?.(); metricsWaiter = null;
      }
      else if (type === "V") nativeMetrics = { ...nativeMetrics, sourceWidth: Number(first), sourceHeight: Number(second) };
      else if (type === "E") console.error(`native-error=${line.slice(2)}`);
      else if (type === "I") {
        const candidate = { sdpMLineIndex: Number(first), candidate: Buffer.from(second, "base64").toString() };
        if (!received) pending.push(candidate);
        else browser.webContents.send("wgc-candidate", candidate);
      } else if (type === "O") {
        const sdp = Buffer.from(first, "base64").toString();
        console.log(`offer-length=${sdp.length} media=${[...sdp.matchAll(/^m=/gm)].length}`);
        const sdpOnly = process.env.NODUS_TEST_SDP_ONLY === "1";
        if (sdpOnly) { received = true; child.removeAllListeners("exit"); child.kill(); setTimeout(() => app.exit(1), 10000); }
        browser.webContents.send("wgc-offer", sdp);
        console.log("offer-dispatched");
      }
    }
  });
  setTimeout(() => { if (!ready || !received || !videoSeen) { console.error("WGC negotiation timed out"); child.kill(); app.exit(1); } }, 60000);
});

app.on("before-quit", () => child?.kill());
