import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cache = join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache");
const script = join(root, "scripts", "custom-installer.nsi");
const makensis = find(cache, "makensis.exe");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const productVersion = `${version.split("-")[0]}.0`;
const setup = join(root, "outputs", "installer", "Nodus-Connect-Setup.exe");
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const asar = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
const archive = join(root, "outputs", "installer", "win-unpacked", "resources", "app.asar");
const packaged = JSON.parse(asar.extractFile(archive, "package.json").toString());
if (packaged.version !== version) throw new Error("Versao empacotada desatualizada. Refaca o empacotamento antes de gerar o setup.");
const hash = (data) => createHash("sha256").update(data).digest("hex");
const mainPath = join("apps", "desktop", "electron", "main.cjs");
if (hash(asar.extractFile(archive, mainPath)) !== hash(readFileSync(join(root, mainPath)))) throw new Error("Electron empacotado desatualizado.");
for (const name of ["preload.cjs", "quick-support.cjs", "desktop-update.cjs"]) {
  const relative = join("apps", "desktop", "electron", name);
  if (hash(asar.extractFile(archive, relative)) !== hash(readFileSync(join(root, relative)))) throw new Error(`Modulo Electron desatualizado: ${name}`);
}
for (const name of ["main.cjs", "preload.cjs", "index.html"]) {
  const relative = join("apps", "installer", name);
  if (hash(asar.extractFile(archive, relative)) !== hash(readFileSync(join(root, relative)))) throw new Error(`Instalador empacotado desatualizado: ${name}`);
}
const trustName = "quick-support-trust.json";
if (hash(readFileSync(join(root, "outputs", "installer", "win-unpacked", "resources", trustName))) !== hash(readFileSync(join(root, "build", trustName)))) throw new Error("Chave publica QuickSupport desatualizada.");
const nativeHashes = {};
for (const name of ["nodus-service.exe", "nodus-wgc-media.exe", "nodus-capture-status.exe"]) {
  const data = readFileSync(join(root, "outputs", "installer", "win-unpacked", "resources", "native", name));
  if (hash(data) !== hash(readFileSync(join(root, "native", "bin", name)))) throw new Error(`Binario nativo desatualizado: ${name}`);
  nativeHashes[name] = hash(data);
}
const supportName = `Nodus-QuickSupport-${version}.exe`;
const supportExe = join(root, "outputs", "quick-support", supportName);
const supportResources = join(root, "outputs", "quick-support", "win-unpacked", "resources");
const supportArchive = join(supportResources, "app.asar");
if (!existsSync(supportExe) || !existsSync(supportArchive)) throw new Error("QuickSupport desta versao ausente. Use pnpm installer:build para gerar os dois pacotes juntos.");
if (JSON.parse(asar.extractFile(supportArchive, "package.json").toString()).version !== version) throw new Error("Versao QuickSupport desatualizada.");
for (const name of ["main.cjs", "preload.cjs", "quick-support.cjs", "desktop-update.cjs"]) {
  const relative = join("apps", "desktop", "electron", name);
  if (hash(asar.extractFile(supportArchive, relative)) !== hash(asar.extractFile(archive, relative))) throw new Error(`QuickSupport desatualizado: ${name}`);
}
for (const [name, expected] of Object.entries(nativeHashes)) {
  if (hash(readFileSync(join(supportResources, "native", name))) !== expected) throw new Error(`Binario QuickSupport desatualizado: ${name}`);
}
if (hash(readFileSync(join(supportResources, trustName))) !== hash(readFileSync(join(root, "build", trustName)))) throw new Error("Chave publica QuickSupport desatualizada.");
const quickSupport = { fileName: supportName, sha256: hash(readFileSync(supportExe)) };
writeFileSync(`${supportExe}.sha256`, `${quickSupport.sha256}  ${supportName}\n`);
if (process.argv.includes("--check")) {
  console.log(JSON.stringify({ version, quickSupport, nativeHashes }));
  process.exit(0);
}

if (!makensis) throw new Error("makensis.exe nao encontrado no cache do electron-builder.");
const bootstrap = join(root, "outputs", "installer", "bootstrap");
const bootstrapSource = join(bootstrap, "source");
if (!resolve(bootstrapSource).startsWith(`${resolve(root, "outputs", "installer")}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("Bootstrap fora do diretorio de build.");
rmSync(bootstrapSource, { recursive: true, force: true });
mkdirSync(join(bootstrapSource, "apps"), { recursive: true });
cpSync(join(root, "apps", "installer"), join(bootstrapSource, "apps", "installer"), { recursive: true });
mkdirSync(join(bootstrapSource, "build"), { recursive: true });
for (const name of ["icon.ico", "icon.svg"]) copyFileSync(join(root, "build", name), join(bootstrapSource, "build", name));
const payloadRoot = join(root, "outputs", "installer", "win-unpacked");
const payloadFiles = inventory(payloadRoot);
writeFileSync(join(bootstrapSource, "payload-metadata.json"), JSON.stringify({ version, bytes: payloadFiles.reduce((total, item) => total + item.bytes, 0), fileCount: payloadFiles.length, appAsarSha256: hash(readFileSync(archive)) }));
writeFileSync(join(bootstrapSource, "package.json"), JSON.stringify({ name: "nodus-connect-setup", version, main: "apps/installer/main.cjs" }));
const bootstrapArchive = join(bootstrap, "app.asar");
const bootstrapCandidate = `${bootstrapArchive}.next`;
rmSync(bootstrapCandidate, { force: true });
await asar.createPackage(bootstrapSource, bootstrapCandidate);
if (existsSync(bootstrapArchive) && hash(readFileSync(bootstrapArchive)) === hash(readFileSync(bootstrapCandidate))) rmSync(bootstrapCandidate);
else {
  rmSync(bootstrapArchive, { force: true });
  renameSync(bootstrapCandidate, bootstrapArchive);
}
rmSync(setup, { force: true });
const result = spawnSync(makensis, [`/DPRODUCT_VERSION=${productVersion}`, script], { cwd: root, stdio: "inherit" });
if (result.status === 0) {
  const versionedSetup = join(root, "outputs", "installer", `Nodus-Connect-Setup-${version}.exe`);
  rmSync(versionedSetup, { force: true });
  copyFileSync(setup, versionedSetup);
  const setupSha256 = hash(readFileSync(versionedSetup));
  const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).stdout?.trim() || "";
  writeFileSync(`${versionedSetup}.sha256`, `${setupSha256}  Nodus-Connect-Setup-${version}.exe\n`);
  writeFileSync(join(root, "outputs", "installer", `Nodus-Connect-Setup-${version}.json`), JSON.stringify({ version, builtAt: new Date().toISOString(), gitHead: git("rev-parse", "HEAD"), dirty: Boolean(git("status", "--porcelain")), setupSha256, quickSupport, appAsarSha256: hash(readFileSync(archive)), lockfileSha256: hash(readFileSync(join(root, "pnpm-lock.yaml"))), nativeHashes, realTwoPcValidation: "PENDING" }, null, 2));
}
process.exit(result.status ?? 1);

function inventory(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? inventory(full) : [{ path: full, bytes: statSync(full).size }];
  });
}

function find(dir, name) {
  if (!dir || !existsSync(dir)) return "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const found = find(full, name);
      if (found) return found;
    }
  }
  return "";
}
