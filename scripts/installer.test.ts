import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../apps/installer/index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../apps/installer/main.cjs", import.meta.url), "utf8");
const wrapper = readFileSync(new URL("custom-installer.nsi", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("custom installer", () => {
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
});
