const fs = require("node:fs/promises");

const numericFields = ["bitrateKbps", "fps", "captureFps", "encodedFps", "sentFps", "receivedFps", "decodedFps", "renderFps", "latencyMs", "controlLatencyMs", "packetLossPct", "jitterMs", "jitterBufferMs", "packetSendDelayMs", "encodeMs", "decodeMs", "freezes", "droppedFrames", "rendererCpuPercent"];
const enums = { role: ["host", "viewer"], route: ["direct", "relay", "unknown"], transport: ["udp", "tcp", "unknown"], quality: ["high", "balanced", "economy", "recovering"], bottleneck: ["CAPTURE", "ENCODER", "NETWORK", "DECODER", "RENDER", "BUFFER_QUEUE", "NONE", "UNKNOWN"] };
const usageFields = ["readRequests", "writeRequests", "listenerStarts", "activeListeners", "serverSnapshots", "documentsDelivered", "minimumReadEstimate", "errors", "quotaErrors", "permissionErrors", "unavailableErrors"];
const numeric = (value, keys) => Object.fromEntries(keys.filter(key => typeof value?.[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0).map(key => [key, value[key]]));

// An allowlist, not redaction: raw logs, names, clipboard contents and identifiers never leave the app.
function sanitizeSample(value) {
  const result = numeric(value, numericFields);
  for (const [key, choices] of Object.entries(enums)) if (choices.includes(value?.[key])) result[key] = value[key];
  if (value?.latencyWindow && typeof value.latencyWindow === "object") result.latencyWindow = Object.fromEntries(
    ["rttMs", "encodeMs", "decodeMs", "queueMs", "frameAgeMs"].flatMap(key => value.latencyWindow[key] ? [[key, numeric(value.latencyWindow[key], ["samples", "p50", "p95", "max"])]] : []));
  return result;
}

async function readPerformanceTail(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat(), length = Math.min(size, 1_048_576), buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    if (size > length) lines.shift();
    return lines.flatMap(line => {
      try { const value = JSON.parse(line.slice(line.indexOf("{"))); return value.event || !value.role ? [] : [sanitizeSample(value)]; }
      catch { return []; }
    }).slice(-120);
  } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  finally { await handle?.close(); }
}

function supportReport({ version, platform, arch, mode, usage, sessions = [], processes = [], samples = [] }) {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), version: /^\d+\.\d+\.\d+$/.test(version) ? version : "unknown",
    platform: ["win32", "linux", "darwin"].includes(platform) ? platform : "unknown", arch: ["x64", "arm64", "ia32"].includes(arch) ? arch : "unknown",
    mode: mode === "quicksupport" ? mode : "desktop", latencyWindowMeasurement: "percentiles-of-stats-interval-averages-not-per-frame-or-input-latency", cloudUsage: { ...numeric(usage, usageFields), includesSecurityRuleReads: false, billingEstimateOnly: true },
    resources: { processes: processes.length, cpuPercent: processes.reduce((sum, item) => sum + (numeric(item.cpu, ["percentCPUUsage"]).percentCPUUsage || 0), 0),
      workingSetKB: processes.reduce((sum, item) => sum + (numeric(item.memory, ["workingSetSize"]).workingSetSize || 0), 0) },
    sessions: Array.isArray(sessions) ? sessions.slice(0, 20).map(sanitizeSample) : [], samples: samples.slice(-120).map(sanitizeSample) };
}

module.exports = { supportReport, sanitizeSample, readPerformanceTail };
