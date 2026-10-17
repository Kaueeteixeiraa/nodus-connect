import { createRequire } from "node:module";
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder"));
const lib = createRequire(builder.resolve("app-builder-lib"));
const { archive } = lib("app-builder-lib/out/targets/archive");
const { hashFile, payloadManifest } = require("./release-integrity.cjs");

export async function prepareSolidPayload(payloadRoot, bootstrapArchive, outputDirectory) {
  const manifest = payloadManifest(payloadRoot), bootstrapHash = hashFile(bootstrapArchive);
  if (manifest.some(file => file.path.startsWith("_nodus_setup/"))) throw new Error("RESERVED_PAYLOAD_PATH");
  const fingerprint = createHash("sha256").update(JSON.stringify({ manifest, bootstrapHash, compression: "7z-maximum-solid-v1" })).digest("hex");
  mkdirSync(outputDirectory, { recursive: true });
  const file = resolve(outputDirectory, `payload-${fingerprint}.7z`), metadataFile = `${file}.json`;
  let cached;
  try { cached = JSON.parse(readFileSync(metadataFile, "utf8")); } catch {}
  if (existsSync(file) && cached?.sha256 === hashFile(file)) return file;
  const staging = mkdtempSync(join(resolve(outputDirectory), "solid-source-"));
  cpSync(payloadRoot, staging, { recursive: true });
  mkdirSync(join(staging, "_nodus_setup"));
  copyFileSync(bootstrapArchive, join(staging, "_nodus_setup", "app.asar"));
  await archive("7z", file, staging, { withoutDir: true, compression: "maximum", solid: true });
  writeFileSync(metadataFile, JSON.stringify({ fingerprint, sha256: hashFile(file), files: manifest.length, bootstrapHash }));
  return file;
}
