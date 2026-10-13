const crypto = require("node:crypto");

function updateRelease(release, currentVersion) {
  const version = String(release?.tag_name || "").replace(/^v/i, "");
  const validVersion = value => /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value);
  if (!release || release.draft || release.prerelease || !validVersion(version) || !validVersion(currentVersion)) throw new Error("INVALID_UPDATE");
  const next = version.split(".").map(Number), current = currentVersion.split(".").map(Number);
  const differing = next.findIndex((part, index) => part !== current[index]);
  const name = `Nodus-Connect-Setup-${version}.exe`;
  const url = `https://github.com/Kaueeteixeiraa/nodus-connect/releases/download/v${version}/${name}`;
  const asset = release.assets?.find(item => item.name === name);
  if (!asset || asset.browser_download_url !== url || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 350 * 1024 * 1024) throw new Error("INVALID_UPDATE");
  return { version, available: differing >= 0 && next[differing] > current[differing], url, sha256: asset.digest.slice(7), size: asset.size };
}

function signPolicy(policy, key, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ kind: "nodus-desktop-update", ...policy, issuedAt: now })).toString("base64url");
  return `${payload}.${crypto.sign(null, Buffer.from(payload), key).toString("base64url")}`;
}

function verifyPolicy(token, key, now = Date.now()) {
  try {
    if (typeof token !== "string" || token.length > 8192 || !Number.isFinite(now)) throw new Error();
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined || crypto.createPublicKey(key).asymmetricKeyType !== "ed25519"
      || !crypto.verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64url"))) throw new Error();
    const policy = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (policy.kind !== "nodus-desktop-update" || typeof policy.enabled !== "boolean"
      || !Number.isSafeInteger(policy.issuedAt) || policy.issuedAt > now + 60_000 || now - policy.issuedAt > 300_000) throw new Error();
    if (policy.enabled) updateRelease(policy.release, "0.0.0");
    return policy;
  } catch { throw new Error("INVALID_UPDATE_POLICY"); }
}

async function pruneCache(directory, protectedName) {
  const fs = require("node:fs/promises"), path = require("node:path");
  const root = path.resolve(directory);
  if (root === path.parse(root).root) throw new Error("INVALID_CACHE_DIRECTORY");
  const executables = [];
  for (const name of await fs.readdir(root).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
    const file = path.resolve(root, name);
    if (path.dirname(file) !== root || name === protectedName) continue;
    const entry = await fs.lstat(file).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink()) continue;
    if (/^[a-f0-9]{64}\.exe$/.test(name)) executables.push({ file, modified: entry.mtimeMs });
    else if (/^[a-f0-9]{64}\.exe\.[a-f0-9-]{36}\.tmp$/.test(name) && Date.now() - entry.mtimeMs > 86_400_000) await fs.unlink(file).catch(() => undefined);
  }
  executables.sort((a, b) => b.modified - a.modified);
  for (const entry of executables.slice(protectedName ? 1 : 2)) {
    if (Date.now() - entry.modified >= 3_600_000) await fs.unlink(entry.file).catch(() => undefined);
  }
}

module.exports = { updateRelease, signPolicy, verifyPolicy, pruneCache };
