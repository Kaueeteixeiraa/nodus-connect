import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] || "outputs/quick-support/win-unpacked");
const files = inventory(root).sort((a, b) => b.bytes - a.bytes);
const folders = new Map();
for (const file of files) {
  const parts = file.path.split("/");
  for (let count = 1; count < parts.length; count++) {
    const dir = parts.slice(0, count).join("/");
    folders.set(dir, (folders.get(dir) || 0) + file.bytes);
  }
}
const report = { root, bytes: files.reduce((total, file) => total + file.bytes, 0), files: files.slice(0, 30),
  directories: [...folders].map(([path, bytes]) => ({ path, bytes, classification: classify(path) })).sort((a, b) => b.bytes - a.bytes).slice(0, 30) };
if (process.argv.includes("--compression")) {
  const require = createRequire(import.meta.url);
  const builder = createRequire(require.resolve("electron-builder"));
  const lib = createRequire(builder.resolve("app-builder-lib"));
  const { archive } = lib("app-builder-lib/out/targets/archive");
  const sevenZip = process.env.NODUS_LAB_7ZIP;
  if (!sevenZip) throw new Error("Defina NODUS_LAB_7ZIP com o 7za.exe existente.");
  const scratch = mkdtempSync(join(tmpdir(), "nodus-packaging-lab-"));
  report.compression = [];
  for (const [format, compression] of process.argv.includes("--normal-only") ? [["7z", "normal"]] : [["7z", "maximum"], ["zip", "normal"]]) {
    const file = join(scratch, `payload-${compression}.${format}`), started = performance.now();
    await archive(format, file, root, { withoutDir: true, compression });
    const buildMs = Math.round(performance.now() - started), extractMs = [];
    for (let run = 0; run < 3; run++) {
      const target = join(scratch, `${format}-${run}`); mkdirSync(target);
      const start = performance.now();
      execFileSync(sevenZip, ["x", file, `-o${target}`, "-y", "-bso0", "-bsp0"], { windowsHide: true, timeout: 120000 });
      extractMs.push(Math.round(performance.now() - start));
      const unpacked = inventory(target);
      if (unpacked.length !== files.length || unpacked.reduce((total, item) => total + item.bytes, 0) !== report.bytes) throw new Error("INCOMPLETE_EXTRACTION");
    }
    report.compression.push({ format, compression, bytes: statSync(file).size, buildMs, extractMs });
  }
  report.scratch = scratch;
}
const output = process.argv.find(value => value.startsWith("--output="))?.slice(9);
if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

function inventory(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? inventory(full) : [{ path: relative(root, full).replaceAll("\\", "/"), bytes: statSync(full).size, classification: classify(full) }];
  });
}
function classify(file) {
  if (/LICENSE|licenses/i.test(file)) return "redistribution license; required";
  if (/gstreamer/i.test(file)) return "WGC-only; retain for native video/audio and fallback";
  if (/nodus-service/i.test(file)) return "connection input/admin; required";
  if (/nodus-(wgc-media|capture-status)/i.test(file)) return "native capture; required";
  if (/app\.asar/i.test(file)) return "application; candidate for lazy modules and external assets";
  return "Electron runtime; required until proven otherwise";
}
