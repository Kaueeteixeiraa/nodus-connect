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
  if (!path) throw new Error("Uso: node scripts/perf-lab.mjs report <performance.log> [--duration=60] [--session=id]");
  const duration = Number(option(reportArgs, "duration") ?? 60);
  const requestedSession = option(reportArgs, "session");
  const records = (await readFile(path, "utf8")).split(/\r?\n/).flatMap((line) => {
    const payload = line.match(/^\[[^\]]+\]\s+(\{.*\})$/)?.[1];
    if (!payload) return [];
    try { return [JSON.parse(payload)]; } catch { return []; }
  });
  const samples = records.filter((item) => !item.event && item.sessionId);
  if (!samples.length) throw new Error("O log nao possui amostras de desempenho.");
  const sessionId = requestedSession ?? samples.at(-1).sessionId;
  const sessionSamples = samples.filter((item) => item.sessionId === sessionId);
  const latestAt = Math.max(...sessionSamples.map((item) => Date.parse(item.at)).filter(Number.isFinite));
  const startAt = latestAt - duration * 1000;
  const windowSamples = sessionSamples.filter((item) => Date.parse(item.at) >= startAt);
  const events = records.filter((item) => item.event && item.sessionId === sessionId && Date.parse(item.at) >= startAt);
  const bottlenecks = windowSamples.map((item) => item.bottleneck ?? inferBottleneck(item));
  const distribution = Object.fromEntries([...new Set(bottlenecks)].map((name) => [name, bottlenecks.filter((item) => item === name).length]));
  const report = {
    sessionId,
    windowSeconds: Math.round((latestAt - Math.min(...windowSamples.map((item) => Date.parse(item.at)))) / 1000),
    samples: windowSamples.length,
    roles: [...new Set(windowSamples.map((item) => item.role))],
    fps: Object.fromEntries(["captureFps", "encodedFps", "sentFps", "receivedFps", "decodedFps", "renderFps"].map((key) => [key, round(average(windowSamples, key))])),
    network: {
      bitrateKbps: round(average(windowSamples, "bitrateKbps")),
      rttMsAverage: round(average(windowSamples, "latencyMs")),
      rttMsP95: round(percentile(windowSamples, "latencyMs", 0.95)),
      jitterMs: round(average(windowSamples, "jitterMs")),
      packetLossPct: round(average(windowSamples, "packetLossPct")),
      jitterBufferMs: round(average(windowSamples, "jitterBufferMs")),
      route: mode(windowSamples.map((item) => item.route).filter(Boolean)) ?? "unknown",
    },
    media: {
      codec: mode(windowSamples.map((item) => item.codec).filter(Boolean)) ?? "unknown",
      encoder: mode(windowSamples.map((item) => item.encoder).filter(Boolean)) ?? "unknown",
      encoderKind: mode(windowSamples.map((item) => item.encoderKind).filter(Boolean)) ?? classifyEncoder(mode(windowSamples.map((item) => item.encoder).filter(Boolean)) ?? ""),
      encodeMs: round(average(windowSamples, "encodeMs")),
      decodeMs: round(average(windowSamples, "decodeMs")),
      freezes: sum(windowSamples, "freezes"),
      droppedFrames: sum(windowSamples, "droppedFrames"),
    },
    bottleneck: { predominant: mode(bottlenecks) ?? "UNKNOWN", distribution },
    events: events.map(({ at, event, from, to }) => ({ at, event, from, to })),
  };
  console.log(JSON.stringify(report, null, 2));
}

function option(values, name) {
  return values.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function numbers(items, key) {
  return items.map((item) => Number(item[key])).filter(Number.isFinite);
}

function average(items, key) {
  const list = numbers(items, key);
  return list.length ? list.reduce((total, value) => total + value, 0) / list.length : 0;
}

function sum(items, key) {
  return numbers(items, key).reduce((total, value) => total + value, 0);
}

function percentile(items, key, point) {
  const list = numbers(items, key).sort((a, b) => a - b);
  return list[Math.max(0, Math.ceil(list.length * point) - 1)] ?? 0;
}

function mode(items) {
  return items.reduce((best, value) => {
    const count = items.filter((item) => item === value).length;
    return !best || count > best.count ? { value, count } : best;
  }, null)?.value;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function classifyEncoder(value) {
  if (/openh264|libvpx|libaom|software/i.test(value)) return "software";
  if (/quick sync|intel|nvenc|nvidia|amd|amf|videotoolbox|media.?foundation|hardware/i.test(value)) return "hardware";
  return "unknown";
}

function inferBottleneck(item) {
  if ((item.bitrateKbps ?? 0) < 200 && Math.max(item.captureFps ?? 0, item.encodedFps ?? 0, item.receivedFps ?? 0, item.decodedFps ?? 0) < 45) return "UNKNOWN";
  if (item.packetLossPct >= 2 || item.latencyMs >= 120 || item.jitterMs >= 25 || item.jitterBufferMs >= 60) return "NETWORK";
  if (item.captureFps > 0 && item.captureFps < 43) return "CAPTURE";
  if (item.captureFps >= 43 && item.encodedFps < item.captureFps * 0.78) return "ENCODER";
  if (item.receivedFps >= 36 && item.decodedFps < item.receivedFps * 0.78) return "DECODER";
  if (item.decodedFps >= 36 && item.renderFps > 0 && item.renderFps < item.decodedFps * 0.75) return "RENDER";
  return "UNKNOWN";
}
