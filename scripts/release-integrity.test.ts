import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { assertValidation, validationCases } from "./verify-release.mjs";
const require = createRequire(import.meta.url);
const { payloadManifest, verifyPayload, signArtifact } = require("./release-integrity.cjs");
const { supportReport, readPerformanceTail } = require("../apps/desktop/electron/support-report.cjs");

describe("release integrity", () => {
  it("cannot promote skipped, incomplete or unrelated physical validation to a release", () => {
    const evidence = { version: "1.1.28", setupSha256: "abc", environment: "TWO_WINDOWS_PCS", pcAliases: ["A", "B"], validatedBy: "tester", cases: Object.fromEntries(validationCases.map(id => [id, { status: "PASSED", note: "human test evidence" }])) };
    expect(() => assertValidation(evidence, "1.1.28", "abc")).not.toThrow();
    expect(() => assertValidation(evidence, "1.1.29", "abc")).toThrow("REAL_VALIDATION_REQUIRED");
    evidence.cases[validationCases[0]].status = "PENDING";
    expect(() => assertValidation(evidence, "1.1.28", "abc")).toThrow("VALIDATION_PENDING");
  });
  it("verifies every file and detects equal-length corruption outside app.asar", () => {
    const directory = mkdtempSync(join(tmpdir(), "nodus-release-"));
    try {
      mkdirSync(join(directory, "resources"));
      writeFileSync(join(directory, "resources", "app.asar"), "application");
      writeFileSync(join(directory, "native.dll"), "1234");
      const manifest = payloadManifest(directory);
      expect(verifyPayload(directory, manifest)).toEqual({ files: 2, bytes: 15 });
      writeFileSync(join(directory, "native.dll"), "4321");
      expect(() => verifyPayload(directory, manifest)).toThrow("PAYLOAD_HASH_MISMATCH");
      writeFileSync(join(directory, "extra.txt"), "unexpected");
      expect(() => verifyPayload(directory, manifest)).toThrow("INCOMPLETE_PAYLOAD");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("never pretends a release is signed when no certificate exists", () => {
    const run = vi.fn();
    expect(signArtifact("setup.exe", { env: {}, required: false, run })).toEqual({ status: "NotConfigured" });
    expect(() => signArtifact("setup.exe", { env: {}, required: true, run })).toThrow("SIGNING_CERTIFICATE_REQUIRED");
    expect(() => signArtifact("setup.exe", { env: { NODUS_SIGN_CERT_SHA1: "invalid" }, run })).toThrow("INVALID_SIGNING_CONFIGURATION");
    expect(run).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform !== "win32")("uses SHA256, timestamp and the expected certificate without exposing private credentials", () => {
    const thumbprint = "a".repeat(40), run = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ status: "Valid", thumbprint }) });
    expect(signArtifact("setup.exe", { env: { NODUS_SIGN_CERT_SHA1: thumbprint, NODUS_SIGNTOOL: "C:\\SDK\\signtool.exe", NODUS_SIGN_TIMESTAMP_URL: "https://timestamp.example.test" }, run })).toMatchObject({ status: "Valid" });
    expect(run.mock.calls[0][1]).toContain("SHA256"); expect(run.mock.calls[0][1]).toContain("/tr");
  });
});

describe("private support diagnostics", () => {
  it("exports only allowed measurements, never identifiers, files, copied data, tokens or raw strings", () => {
    const privateData = "PRIVATE-SECRET-C:/Users/Private/a.txt-user@example.test";
    const sample = { role: "host", latencyMs: 12, encodeMs: 3, fps: NaN, sessionId: privateData, text: privateData, deviceName: privateData, encoder: privateData, error: privateData,
      latencyWindow: { rttMs: { samples: 2, p50: 12, p95: 20, privateData } } };
    const report = supportReport({ version: "1.1.28", platform: "win32", arch: "x64", usage: { readRequests: 2, tokens: privateData }, sessions: [sample], samples: [sample],
      processes: [{ cpu: { percentCPUUsage: 5 }, memory: { workingSetSize: 100 }, name: privateData }] });
    expect(JSON.stringify(report)).not.toContain(privateData);
    expect(report.sessions[0]).toEqual({ role: "host", latencyMs: 12, encodeMs: 3, latencyWindow: { rttMs: { samples: 2, p50: 12, p95: 20 } } });
    expect(report.resources).toEqual({ processes: 1, cpuPercent: 5, workingSetKB: 100 });
    expect(report.cloudUsage).toMatchObject({ readRequests: 2, includesSecurityRuleReads: false });
  });
  it("reads a bounded tail, skips events and malformed records, and strips log metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nodus-diagnostic-"));
    try {
      const file = join(directory, "performance.log");
      writeFileSync(file, `not-json\n${"x".repeat(1_048_576)}\n[log] {"role":"viewer","latencyMs":4,"sessionId":"private"}\n{"event":"startup","role":"host"}\n`);
      expect(await readPerformanceTail(file)).toEqual([{ role: "viewer", latencyMs: 4 }]);
      expect(await readPerformanceTail(join(directory, "missing.log"))).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("keeps the native save dialog behind the trusted main-app IPC boundary", () => {
    const main = readFileSync(new URL("../apps/desktop/electron/main.cjs", import.meta.url), "utf8");
    expect(main.replaceAll("\r\n", "\n")).toContain('ipcMain.handle("nodus:export-diagnostics", async (event, snapshot) => {\n    if (!isMainAppSender(event))');
  });
});
