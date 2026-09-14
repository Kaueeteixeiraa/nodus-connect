import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cache = join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache");
const script = join(root, "scripts", "custom-installer.nsi");
const makensis = find(cache, "makensis.exe");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const productVersion = `${version}.0`;
const setup = join(root, "outputs", "installer", "Nodus-Connect-Setup.exe");

if (!makensis) throw new Error("makensis.exe nao encontrado no cache do electron-builder.");
rmSync(setup, { force: true });
const result = spawnSync(makensis, [`/DPRODUCT_VERSION=${productVersion}`, script], { cwd: root, stdio: "inherit" });
if (result.status === 0) {
  const versionedSetup = join(root, "outputs", "installer", `Nodus-Connect-Setup-${version}.exe`);
  rmSync(versionedSetup, { force: true });
  copyFileSync(setup, versionedSetup);
}
process.exit(result.status ?? 1);

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
