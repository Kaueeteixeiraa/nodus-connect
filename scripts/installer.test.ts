import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../apps/installer/index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../apps/installer/main.cjs", import.meta.url), "utf8");
const wrapper = readFileSync(new URL("custom-installer.nsi", import.meta.url), "utf8");

describe("custom installer", () => {
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

  it("uses a startup-friendly non-solid installer archive", () => {
    expect(wrapper).toContain("SetCompressor /FINAL lzma");
    expect(wrapper).toContain("SetCompressorDictSize 8");
    expect(wrapper).not.toContain("/SOLID");
    expect(wrapper).toContain("MUI_PAGE_INSTFILES");
    expect(wrapper).toContain("HideWindow");
    expect(wrapper).not.toContain("SilentInstall silent");
  });
});
