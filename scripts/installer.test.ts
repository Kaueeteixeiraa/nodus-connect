import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { prepareSolidPayload } from "./solid-payload.mjs";
import { createRequire } from "node:module";
const { payloadManifest, verifyPayload } = createRequire(import.meta.url)("./release-integrity.cjs");

const html = readFileSync(new URL("../apps/installer/index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../apps/installer/main.cjs", import.meta.url), "utf8");
const wrapper = readFileSync(new URL("custom-installer.nsi", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const makensis = join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "nsis-3.0.4.1", "nsis-3.0.4.1-1mx3n", "makensis.exe");
const installerFunctions = ts.createSourceFile("main.cjs", main, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).statements.filter(ts.isFunctionDeclaration).map(node => node.getText()).join("\n");
const resourcesCache = join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "nsis-resources-3.4.1");
const sevenZipPlugin = existsSync(resourcesCache) ? fs.readdirSync(resourcesCache).map(name => join(resourcesCache, name, "plugins", "x86-unicode")).find(dir => existsSync(join(dir, "nsis7z.dll"))) : undefined;

describe("custom installer", () => {
  it("waits for the bootstrap archive handle to close before compiling", async () => {
    const source = ts.createSourceFile("make-installer.mjs", readFileSync(new URL("make-installer.mjs", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const start = source.statements.findIndex(node => node.getText(source).startsWith("const bootstrapStream ="));
    expect(start).toBeGreaterThan(-1);
    const stream = new Writable({ write(_chunk, _encoding, callback) { callback(); }, destroy(error, callback) { setTimeout(() => callback(error), 20); } });
    const code = source.statements.slice(start, start + 2).map(node => node.getText(source)).join("\n");
    const closed = await runInNewContext(`(async () => { ${code}; return bootstrapStream.closed; })()`, {
      bootstrapSource: "source", bootstrapCandidate: "archive", finished, asar: { createPackage: async () => { stream.end("archive"); return stream; } },
    });
    expect(closed).toBe(true);
  });
  it("shows a minimal bootstrap and extracts the complete application only after install confirmation", () => {
    expect(wrapper).toContain('File /r /x resources');
    expect(wrapper).toContain('bootstrap\\app.asar');
    expect(wrapper).toContain('"--payload-wrapper=$EXEPATH"');
    expect(wrapper).toContain('${GetOptions} $R0 "/EXTRACT=" $R3');
    expect(main).toContain('if (payloadWrapper) await extractPayload(stagingDir, send)');
    expect(main).toContain('payloadMetadata?.bytes || getPayloadSize(source)');
    expect(main).toContain('PAYLOAD_HASH_MISMATCH');
    expect(main).toContain('INCOMPLETE_PAYLOAD');
    expect(html).not.toContain('dataset.ready="true",300');
  });
  it.skipIf(process.platform !== "win32" || !existsSync(makensis) || !sevenZipPlugin)("real compact wrapper launches the bootstrap, preserves Unicode update arguments and extracts every byte", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nodus-solid-wrapper-")), payload = join(directory, "payload"), output = join(directory, "setup.exe"), marker = join(directory, "launched.txt");
    try {
      fs.mkdirSync(join(payload, "resources"), { recursive: true });
      fs.writeFileSync(join(payload, "resources", "app.asar"), "original-application");
      fs.writeFileSync(join(directory, "bootstrap.asar"), "bootstrap");
      fs.writeFileSync(join(directory, "license.txt"), "test-license");
      fs.writeFileSync(join(payload, "probe.nsi"), 'Unicode true\nOutFile "Nodus Connect Setup.exe"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nFileOpen $R0 "$EXEDIR\\resources\\app.asar" r\nFileRead $R0 $R2\nFileClose $R0\nReadEnvStr $R3 "NODUS_INSTALLER_MARKER"\nFileOpen $R0 $R3 w\nFileWriteUTF16LE $R0 "$R2|$CMDLINE"\nFileClose $R0\nSetErrorLevel 0\nSectionEnd\n');
      const probe = spawnSync(makensis, ["probe.nsi"], { cwd: payload, windowsHide: true, encoding: "utf8", timeout: 20_000 });
      expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
      fs.unlinkSync(join(payload, "probe.nsi"));
      const archive = await prepareSolidPayload(payload, join(directory, "bootstrap.asar"), join(directory, "cache"));
      const build = spawnSync(makensis, [`/DSETUP_OUTPUT=${output}`, "/DCOMPACT_INSTALLER", `/DSOLID_PAYLOAD=${archive}`, `/DSEVEN_ZIP_PLUGIN=${sevenZipPlugin}`, `/DCOMPRESSION_LICENSE=${join(directory, "license.txt")}`, path.resolve("scripts/custom-installer.nsi")], { windowsHide: true, encoding: "utf8", timeout: 30_000 });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      for (const update of [null, join(directory, "opcoes com espaco e acento-\u00e7.json")]) {
        const result = spawnSync(output, update ? [`/UPDATE=${update}`] : [], { windowsHide: true, timeout: 20_000, env: { ...process.env, NODUS_INSTALLER_MARKER: marker } });
        expect(result.status).toBe(0);
        const text = readFileSync(marker, "utf16le");
        expect(text).toContain("bootstrap|"); expect(text).toContain("--payload-wrapper=");
        if (update) expect(text).toContain(`--auto-update=${update}`);
      }
      const target = join(directory, "extracao com espacos");
      const extracted = spawnSync(output, [`/EXTRACT=${target}`], { windowsHide: true, timeout: 20_000 });
      expect(extracted.status).toBe(0); expect(verifyPayload(target, payloadManifest(payload)).files).toBe(2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 60_000);
  it.skipIf(process.platform !== "win32" || !existsSync(makensis))("real NSIS parses Node-quoted update arguments with spaces and Unicode", () => {
    const directory = mkdtempSync(join(tmpdir(), "nodus-nsis-test-"));
    const parser = wrapper.slice(wrapper.indexOf("${GetParameters} $R0"), wrapper.indexOf('StrCmp $R1 "" normal_update'));
    try {
      writeFileSync(join(directory, "probe.nsi"), `Unicode true\n!include "FileFunc.nsh"\nOutFile "probe.exe"\nRequestExecutionLevel user\nSilentInstall silent\nSection\n${parser}\nFileOpen $R3 "$EXEDIR\\parsed.txt" w\nFileWriteUTF16LE $R3 $R1\nFileClose $R3\nSectionEnd\n`);
      const build = spawnSync(makensis, ["probe.nsi"], { cwd: directory, windowsHide: true, encoding: "utf8", timeout: 20000 });
      expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
      for (const file of ["C:\\Users\\Kauê\\Nodus Connect\\updates\\id.json", "C:\\cache\\id.json", null]) {
        const run = spawnSync(join(directory, "probe.exe"), file ? [`/UPDATE=${file}`] : [], { windowsHide: true, timeout: 10000 });
        expect(run.status).toBe(0); expect(readFileSync(join(directory, "parsed.txt"), "utf16le")).toBe(file || "");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 40000);
  it("rejects stale packaged code and records hashes without claiming real-machine validation", () => {
    const builder = readFileSync(new URL("make-installer.mjs", import.meta.url), "utf8");
    expect(builder).toContain("packaged.version !== version");
    expect(builder).toContain("hash(asar.extractFile(archive, mainPath))");
    expect(builder).toContain("Binario nativo desatualizado");
    expect(builder).toContain('realTwoPcValidation: "PENDING"');
    expect(builder).toContain("lockfileSha256");
  });
  it("builds and validates the matching QuickSupport before completing a setup", () => {
    const command = packageJson.scripts["installer:build"];
    expect(command).toContain("node scripts/build-quick-support.mjs && electron-builder --win portable --x64 --config quick-support-builder.cjs && node scripts/make-installer.mjs");
    const builder = readFileSync(new URL("make-installer.mjs", import.meta.url), "utf8");
    expect(builder).toContain("!existsSync(supportExe) || !existsSync(supportArchive)");
    expect(builder).toContain('asar.extractFile(supportArchive, "package.json")');
    expect(builder).toContain("Binario QuickSupport desatualizado");
    expect(builder).toContain("sha256: hash(readFileSync(supportExe))");
    expect(builder).toContain("setupSha256, quickSupport,");
  });
  it("rejects missing, mismatched or stale QuickSupport artifacts", () => {
    const source = ts.createSourceFile("make-installer.mjs", readFileSync(new URL("make-installer.mjs", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const start = source.statements.findIndex(node => node.getText(source).startsWith("const supportName ="));
    const end = source.statements.findIndex(node => node.getText(source).startsWith("const quickSupport ="));
    const code = source.statements.slice(start, end + 1).map(node => node.getText(source)).join("\n");
    const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    const run = (failure = "") => runInNewContext(`${code}; quickSupport`, {
      root: "build-test", version: "1.1.14", archive: "installer.asar", trustName: "quick-support-trust.json", join, hash,
      process: { argv: ["--check"] }, signArtifact: vi.fn(),
      nativeHashes: { "nodus-service.exe": hash(Buffer.from("current")) },
      existsSync: (file: string) => !(failure === "missing" && file.endsWith(".exe")),
      readFileSync: (file: string) => Buffer.from(file.endsWith("Nodus-QuickSupport-1.1.14.exe") ? "MZportable" : failure && file.includes(join("outputs", "quick-support")) && file.endsWith(failure) ? "stale" : "current"),
      asar: { extractFile: (file: string, name: string) => Buffer.from(name === "package.json" ? JSON.stringify({ version: failure === "version" ? "1.1.13" : "1.1.14" }) : failure && file !== "installer.asar" && name.endsWith(failure) ? "stale" : "current") },
    });
    expect(run()).toEqual({ fileName: "Nodus-QuickSupport-1.1.14.exe", sha256: hash(Buffer.from("MZportable")) });
    for (const failure of ["missing", "version", "main.cjs", "preload.cjs", "quick-support.cjs", "desktop-update.cjs", "nodus-service.exe", "quick-support-trust.json"]) expect(() => run(failure), failure).toThrow();
  });
  it("keeps every required screen and gates the license step", () => {
    for (const screen of ["welcome", "license", "location", "installing", "complete", "uninstall", "error"]) {
      expect(html).toContain(`data-screen="${screen}"`);
    }
    expect(html).toContain('id="to-location" disabled');
    expect(html).toContain("LEGAL_COPY_PLACEHOLDER");
  });

  it("installs through staging with rollback and real progress stages", () => {
    expect(main).toContain('`${installDir}.installing`');
    expect(main).toContain('`${installDir}.backup`');
    expect(main).toContain('send("Copiando arquivos...", progress, "copy")');
    expect(main).toContain("if (backupMoved && fs.existsSync(backupDir)) fs.renameSync(backupDir, installDir)");
  });
  it.each(["clean", "update", "rollback"])("uses real isolated filesystem staging for %s without touching Windows registration or installed apps", async mode => {
    const directory = mkdtempSync(join(tmpdir(), "nodus-install-flow-")), source = join(directory, "source"), target = join(directory, "Nodus Connect");
    fs.mkdirSync(source); fs.writeFileSync(join(source, "Nodus Connect Setup.exe"), "new-executable"); fs.writeFileSync(join(source, "license.txt"), "retained-license");
    fs.writeFileSync(join(directory, "identity.bin"), "preserved-identity");
    if (mode !== "clean") { fs.mkdirSync(target); fs.writeFileSync(join(target, "Nodus Connect.exe"), "previous-executable"); }
    const shell = vi.fn();
    const isolatedFs = { ...fs, rmSync: (file: string, options: fs.RmOptions) => {
      if (!path.resolve(file).startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error("OUTSIDE_TEST_DIRECTORY");
      fs.rmSync(file, options);
    } };
    const script = `${installerFunctions}\nstopNodusForUpdate=()=>false;getFreeDiskBytes=()=>1e9;createShortcuts=()=>{};writeUninstaller=()=>{};registerUninstaller=()=>{if(failCommit)throw new Error('TEST_CONFIG_FAILURE')};friendlyError=e=>e.message;log=()=>{};installNodus`;
    const context = { fs: isolatedFs, path, process: { execPath: join(source, "Nodus Connect Setup.exe") }, productName: "Nodus Connect", installDir: target,
      payloadWrapper: "", payloadMetadata: undefined, cancelRequested: false, installing: false, setImmediate, failCommit: mode === "rollback", spawn: shell, spawnSync: shell,
      os: { tmpdir: () => directory }, Atomics, Int32Array, SharedArrayBuffer };
    try {
      const install = runInNewContext(script, context), progress = vi.fn();
      const result = await install(progress, { installDir: target, desktopShortcut: false, startWithWindows: false });
      expect(result.ok).toBe(mode !== "rollback");
      expect(fs.readFileSync(join(target, "Nodus Connect.exe"), "utf8")).toBe(mode === "rollback" ? "previous-executable" : "new-executable");
      expect(fs.existsSync(`${target}.installing`)).toBe(false); expect(fs.existsSync(`${target}.backup`)).toBe(false);
      expect(fs.readFileSync(join(directory, "identity.bin"), "utf8")).toBe("preserved-identity");
      expect(shell).not.toHaveBeenCalled();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("registers a custom safe uninstaller", () => {
    expect(main).toContain('"UninstallString"');
    expect(main).toContain('"--uninstall"');
    expect(main).toContain("assertSafeInstallDir(installDir)");
    expect(main).toContain("options.removeUserData");
  });

  it("opens the branded setup without an intermediate extraction window", () => {
    expect(wrapper).toContain("SetCompressor /FINAL zlib");
    expect(wrapper).not.toContain("/SOLID");
    expect(wrapper).toContain("SilentInstall silent");
    expect(wrapper).not.toContain("MUI_PAGE_INSTFILES");
    expect(wrapper).not.toContain("HideWindow");
    expect(wrapper).toContain('${GetOptions} $R0 "/UPDATE=" $R1');
    expect(wrapper).toContain('"--auto-update=$R1"');
    expect(wrapper).toContain("SetErrorLevel $R2");
  });

  it("offers a lossless solid subarchive without replacing the comparison installer", () => {
    expect(wrapper.replace(/\r\n/g, "\n")).toContain("!ifdef COMPACT_INSTALLER\n  SetCompressor /FINAL lzma\n!else\n  SetCompressor /FINAL zlib");
    expect(wrapper).not.toContain("/SOLID");
    expect(wrapper).toContain('OutFile "${SETUP_OUTPUT}"');
    const builder = readFileSync(new URL("make-installer.mjs", import.meta.url), "utf8");
    expect(builder).toContain('process.argv.includes("--compact")');
    expect(builder).toContain('compact && !process.argv.includes("--canonical") ? "-Compact" : ""');
    expect(builder).toContain('prepareSolidPayload(payloadRoot, bootstrapArchive, bootstrap)');
    expect(wrapper).toContain('Nsis7z::Extract');
    expect(builder).toContain('`Nodus-Connect-Setup-${version}${suffix}.exe`');
    expect(builder).toContain('`Nodus-Connect-Setup-${version}${suffix}.json`');
    expect(builder).toContain('`${setupSha256}  ${versionedName}\\n`');
    expect(builder).not.toMatch(/\bupx\b/i);
  });

  it("hides the decorative bar below the welcome logo", () => {
    expect(html).toContain(".welcome .art:after{display:none}");
  });

  it("keeps native binaries and installer resources out of app.asar", () => {
    expect(packageJson.build.files).not.toContain("native/bin/**/*");
    expect(packageJson.build.files).not.toContain("build/**/*");
    expect(packageJson.build.files).toContain("!node_modules/**/*");
    expect(packageJson.build.extraMetadata.dependencies).toEqual({});
    expect(packageJson.build.extraResources[0].from).toBe("native/bin");
    expect(packageJson.build.afterPack).toBe("scripts/prune-electron-output.cjs");
  });
  it("includes the current QuickSupport verifier and public key in the custom setup", () => {
    const config = JSON.parse(readFileSync(new URL("../installer-builder.json", import.meta.url), "utf8"));
    expect(config.files).toContain("apps/desktop/electron/**/*");
    expect(config.extraResources).toContainEqual({ from: "build/quick-support-trust.json", to: "quick-support-trust.json" });
    const builder = readFileSync(new URL("make-installer.mjs", import.meta.url), "utf8");
    expect(builder).toContain('["preload.cjs", "quick-support.cjs", "desktop-update.cjs", "support-report.cjs"]');
    expect(builder).toContain("Chave publica QuickSupport desatualizada.");
  });
});
