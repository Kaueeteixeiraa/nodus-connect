import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const { hashFile, payloadManifest, verifyPayload, artifactSignature } = createRequire(import.meta.url)("./release-integrity.cjs");

export const validationCases = ["install-clean", "update-existing", "uninstall-reinstall-identity", "installer-rollback", "desktop-lan-both-directions", "desktop-internet-direct", "desktop-internet-turn", "quicksupport-lan", "quicksupport-internet", "first-remote-minimize", "minimize-restore-40-times", "keyboard-teste-teste-shortcuts", "file-clipboard-viewer-to-host-sha256", "file-clipboard-host-to-viewer-sha256", "network-loss-recovery", "personal-10-minute-reconnect", "receiver-no-access-charge", "admin-block-unblock", "pilot-update-exclusion", "theme-mobile-layout"];

export function assertValidation(evidence, version, setupSha256) {
  if (evidence?.version !== version || evidence.setupSha256 !== setupSha256 || evidence.environment !== "TWO_WINDOWS_PCS"
    || !Array.isArray(evidence.pcAliases) || evidence.pcAliases.length !== 2 || evidence.pcAliases.some(value => typeof value !== "string" || !value.trim())
    || new Set(evidence.pcAliases).size !== 2 || typeof evidence.validatedBy !== "string" || !evidence.validatedBy.trim()) throw new Error("REAL_VALIDATION_REQUIRED");
  for (const id of validationCases) if (evidence.cases?.[id]?.status !== "PASSED" || !evidence.cases[id].note?.trim()) throw new Error(`VALIDATION_PENDING:${id}`);
}

async function main(args) {
  const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = resolve(import.meta.dirname, ".."), version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const setup = resolve(option("setup") || join(root, "outputs", "installer", `Nodus-Connect-Setup-${version}.exe`));
  const metadata = JSON.parse(readFileSync(setup.replace(/\.exe$/i, ".json"), "utf8"));
  if (metadata.version !== version || metadata.setupSha256 !== hashFile(setup)) throw new Error("SETUP_HASH_OR_VERSION_MISMATCH");
  if (readFileSync(`${setup}.sha256`, "utf8").trim() !== `${metadata.setupSha256}  ${basename(setup)}`) throw new Error("SETUP_CHECKSUM_FILE_MISMATCH");
  const supportName = `Nodus-QuickSupport-${version}.exe`;
  if (metadata.quickSupport?.fileName !== supportName) throw new Error("QUICKSUPPORT_VERSION_MISMATCH");
  const support = join(root, "outputs", "quick-support", supportName);
  if (hashFile(support) !== metadata.quickSupport.sha256) throw new Error("QUICKSUPPORT_HASH_MISMATCH");
  if (readFileSync(`${support}.sha256`, "utf8").trim() !== `${metadata.quickSupport.sha256}  ${supportName}`) throw new Error("QUICKSUPPORT_CHECKSUM_FILE_MISMATCH");
  const check = spawnSync(process.execPath, [join(root, "scripts", "make-installer.mjs"), "--check"], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 60_000 });
  if (check.status !== 0) throw new Error("PACKAGED_SOURCE_MISMATCH");
  const checked = JSON.parse(check.stdout);
  if (checked.quickSupport.sha256 !== metadata.quickSupport.sha256 || JSON.stringify(checked.nativeHashes) !== JSON.stringify(metadata.nativeHashes)
    || metadata.appAsarSha256 !== hashFile(join(dirname(setup), "win-unpacked", "resources", "app.asar")) || metadata.lockfileSha256 !== hashFile(join(root, "pnpm-lock.yaml"))) throw new Error("RELEASE_METADATA_MISMATCH");
  const signature = artifactSignature(setup);
  if (args.includes("--require-signature") && (signature.status !== "Valid" || artifactSignature(support).status !== "Valid")) throw new Error("VALID_SIGNATURE_REQUIRED");
  const output = { version, setup: basename(setup), bytes: readFileSync(setup).length, sha256: metadata.setupSha256, signature, quickSupport: metadata.quickSupport, extraction: null, realTwoPcValidation: "PENDING" };
  mkdirSync(join(root, "work"), { recursive: true });
  if (args.includes("--extract")) {
    const target = mkdtempSync(join(root, "work", `installer-validation-${version}-`)), started = performance.now();
    const unpack = spawnSync(setup, [`/EXTRACT=${target}`], { windowsHide: true, encoding: "utf8", timeout: 300_000 });
    if (unpack.status !== 0) throw new Error("INSTALLER_EXTRACTION_FAILED");
    output.extraction = { ...verifyPayload(target, payloadManifest(join(dirname(setup), "win-unpacked"))), ms: Math.round(performance.now() - started), directory: target };
  }
  const validationFile = resolve(option("validation") || join(root, "work", `release-validation-${version}.json`));
  if (args.includes("--init-validation") && !existsSync(validationFile)) writeFileSync(validationFile, JSON.stringify({ version, setupSha256: metadata.setupSha256, environment: "TWO_WINDOWS_PCS", pcAliases: ["PC-A", "PC-B"], validatedBy: "", cases: Object.fromEntries(validationCases.map(id => [id, { status: "PENDING", note: "" }])) }, null, 2));
  if (args.includes("--release")) {
    if (!output.extraction) throw new Error("RELEASE_EXTRACTION_REQUIRED");
    assertValidation(JSON.parse(readFileSync(validationFile, "utf8")), version, metadata.setupSha256);
    output.realTwoPcValidation = "PASSED";
  }
  writeFileSync(join(root, "work", `release-integrity-${version}.json`), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main(process.argv.slice(2));
