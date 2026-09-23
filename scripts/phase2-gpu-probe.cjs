const { app, BrowserWindow, desktopCapturer, session } = require("electron");
const http = require("node:http");

for (const flag of ["enable-zero-copy", "enable-gpu-rasterization", "disable-background-timer-throttling", "disable-renderer-backgrounding", "disable-backgrounding-occluded-windows"]) app.commandLine.appendSwitch(flag);
if (process.platform === "win32") app.commandLine.appendSwitch("enable-features", [
  "WebRtcAllowWgcScreenCapturer", "WebRtcAllowWgcWindowCapturer",
  "MediaFoundationD3DVideoProcessing", "MediaFoundationSharedImageEncode",
].join(","));

async function runProbe() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: false });
  const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
  const h264Profiles = codecs.filter((item) => item.mimeType.toLowerCase() === "video/h264").map((item) => item.sdpFmtpLine || "default");
  const results = [];
  for (const order of ["previous", "browser", "app-parameters"]) {
    const host = new RTCPeerConnection();
    const viewer = new RTCPeerConnection();
    host.onicecandidate = (event) => event.candidate && viewer.addIceCandidate(event.candidate).catch(() => {});
    viewer.onicecandidate = (event) => event.candidate && host.addIceCandidate(event.candidate).catch(() => {});
    const sender = host.addTrack(stream.getVideoTracks()[0], stream);
    if (order === "app-parameters") {
      sender.track.contentHint = "motion";
      const parameters = sender.getParameters();
      if (!parameters.encodings.length) parameters.encodings = [{}];
      parameters.degradationPreference = "maintain-framerate";
      parameters.encodings[0].maxBitrate = 14_000_000;
      parameters.encodings[0].maxFramerate = 60;
      parameters.encodings[0].scaleResolutionDownBy = 1;
      parameters.encodings[0].priority = "high";
      parameters.encodings[0].networkPriority = "high";
      await sender.setParameters(parameters);
    }
    const rank = (item) => {
      const name = item.mimeType.split("/")[1]?.toLowerCase();
      if (name === "h264") return order === "previous" && /packetization-mode=1/i.test(item.sdpFmtpLine || "") && /profile-level-id=42/i.test(item.sdpFmtpLine || "") ? 0 : order === "previous" ? 1 : 0;
      return ({ vp8: 2, vp9: 3, av1: 4 })[name] ?? 5;
    };
    host.getTransceivers()[0].setCodecPreferences([...codecs].sort((a, b) => rank(a) - rank(b)));
    viewer.addTransceiver("video", { direction: "recvonly" });
    await host.setLocalDescription(await host.createOffer());
    await viewer.setRemoteDescription(host.localDescription);
    await viewer.setLocalDescription(await viewer.createAnswer());
    await host.setRemoteDescription(viewer.localDescription);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const stats = await host.getStats(sender.track);
    const outgoing = [...stats.values()].find((item) => item.type === "outbound-rtp" && item.kind === "video");
    const codec = outgoing && stats.get(outgoing.codecId);
    const receivedStats = await viewer.getStats();
    const inbound = [...receivedStats.values()].find((item) => item.type === "inbound-rtp" && item.kind === "video");
    results.push({ order, connection: host.connectionState, encoder: outgoing?.encoderImplementation || "unknown", decoder: inbound?.decoderImplementation || "unknown", framesEncoded: outgoing?.framesEncoded ?? 0, framesDecoded: inbound?.framesDecoded ?? 0, framesDropped: inbound?.framesDropped ?? 0, codec: codec?.mimeType || "unknown", profile: codec?.sdpFmtpLine || "unknown" });
    host.close();
    viewer.close();
  }
  stream.getTracks().forEach((track) => track.stop());
  return { h264Profiles, results };
}

app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<!doctype html><title>Nodus GPU probe</title>"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media" || permission === "display-capture"));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === "media" || permission === "display-capture");
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    callback({ video: sources[0] });
  });
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const timeout = setTimeout(() => { console.error("GPU probe timed out"); app.exit(1); }, 30000);
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}`);
    const result = await window.webContents.executeJavaScript(`(${runProbe.toString()})()`, true);
    const info = await app.getGPUInfo("basic");
    const adapter = info.gpuDevice?.find((device) => device.active) || info.gpuDevice?.[0];
    console.log(JSON.stringify({ adapter: adapter?.deviceString || "unknown", gpu: app.getGPUFeatureStatus(), ...result }, null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    window.destroy();
    server.close();
    app.quit();
  }
}).catch((error) => { console.error(error); app.exit(1); });
