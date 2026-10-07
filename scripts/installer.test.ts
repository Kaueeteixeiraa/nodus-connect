import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../apps/installer/index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../apps/installer/main.cjs", import.meta.url), "utf8");
const wrapper = readFileSync(new URL("custom-installer.nsi", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const makensis = join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "nsis-3.0.4.1", "nsis-3.0.4.1-1mx3n", "makensis.exe");

describe("custom installer", () => {
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

  it("registers a custom safe uninstaller", () => {
    expect(main).toContain('"UninstallString"');
    expect(main).toContain('"--uninstall"');
    expect(main).toContain("assertSafeInstallDir(installDir)");
    expect(main).toContain("options.removeUserData");
  });

  it("opens the branded setup without an intermediate extraction window", () => {
    expect(wrapper).toContain("SetCompressor /FINAL lzma");
    expect(wrapper).toContain("SetCompressorDictSize 8");
    expect(wrapper).not.toContain("/SOLID");
    expect(wrapper).toContain("SilentInstall silent");
    expect(wrapper).not.toContain("MUI_PAGE_INSTFILES");
    expect(wrapper).not.toContain("HideWindow");
    expect(wrapper).toContain('${GetOptions} $R0 "/UPDATE=" $R1');
    expect(wrapper).toContain('"--auto-update=$R1"');
    expect(wrapper).toContain("SetErrorLevel $R2");
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
    expect(builder).toContain('["preload.cjs", "quick-support.cjs"]');
    expect(builder).toContain("Chave publica QuickSupport desatualizada.");
  });
});
