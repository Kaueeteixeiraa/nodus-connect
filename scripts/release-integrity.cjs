const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

function hashFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function payloadManifest(directory) {
  const root = path.resolve(directory);
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error("PAYLOAD_LINK_FORBIDDEN");
    return entry.isDirectory() ? walk(full) : [{ path: path.relative(root, full).replaceAll("\\", "/"), bytes: fs.statSync(full).size, sha256: hashFile(full) }];
  });
  return walk(root).sort((a, b) => a.path.localeCompare(b.path, "en"));
}
function verifyPayload(directory, expected) {
  const actual = payloadManifest(directory);
  if (actual.length !== expected.length) throw new Error("INCOMPLETE_PAYLOAD");
  const byPath = new Map(expected.map(item => [item.path, item]));
  for (const file of actual) {
    const original = byPath.get(file.path);
    if (!original || file.sha256 !== original.sha256 || file.bytes !== original.bytes) throw new Error("PAYLOAD_HASH_MISMATCH");
  }
  return { files: actual.length, bytes: actual.reduce((total, file) => total + file.bytes, 0) };
}

function artifactSignature(file, run = spawnSync) {
  if (process.platform !== "win32") return { status: "Unavailable" };
  const command = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $env:PSModulePath=Join-Path $PSHOME 'Modules'; $s=Get-AuthenticodeSignature -LiteralPath '${path.resolve(file).replaceAll("'", "''")}'; @{status=$s.Status.ToString();thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress`;
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) throw new Error("SIGNATURE_CHECK_FAILED");
  return JSON.parse(result.stdout);
}
function signArtifact(file, { required = process.env.NODUS_REQUIRE_SIGNATURE === "1", env = process.env, run = spawnSync } = {}) {
  const thumbprint = env.NODUS_SIGN_CERT_SHA1;
  if (!thumbprint) { if (required) throw new Error("SIGNING_CERTIFICATE_REQUIRED"); return { status: "NotConfigured" }; }
  const tool = env.NODUS_SIGNTOOL, timestamp = env.NODUS_SIGN_TIMESTAMP_URL;
  if (process.platform !== "win32" || !/^[a-f0-9]{40}$/i.test(thumbprint) || !tool || !path.isAbsolute(tool) || path.basename(tool).toLowerCase() !== "signtool.exe"
    || !timestamp || !/^https:\/\//.test(timestamp)) throw new Error("INVALID_SIGNING_CONFIGURATION");
  const result = run(tool, ["sign", "/sha1", thumbprint, "/fd", "SHA256", "/tr", timestamp, "/td", "SHA256", "/d", "Nodus Connect", path.resolve(file)], { windowsHide: true, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error("ARTIFACT_SIGNING_FAILED");
  const signature = artifactSignature(file, run);
  if (signature.status !== "Valid" || signature.thumbprint?.toLowerCase() !== thumbprint.toLowerCase()) throw new Error("INVALID_ARTIFACT_SIGNATURE");
  return signature;
}
module.exports = Object.assign(async function signElectronOutput(context) {
  if (process.platform !== "win32") return;
  for (const name of fs.readdirSync(context.appOutDir)) if (name.endsWith(".exe")) signArtifact(path.join(context.appOutDir, name));
}, { hashFile, payloadManifest, verifyPayload, artifactSignature, signArtifact });
