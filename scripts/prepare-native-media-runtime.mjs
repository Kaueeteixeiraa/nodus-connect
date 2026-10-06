import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const source = process.env.GSTREAMER_1_0_ROOT_MSVC_X86_64_RUNTIME || join(root, "work", "gstreamer-cache", "runtime", "PFiles64", "gstreamer", "1.0", "msvc_x86_64");
const target = resolve(root, "work", "gstreamer-runtime-package");
const dumpbin = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\dumpbin.exe";
const plugins = ["gstcoreelements", "gstd3d11", "gstmediafoundation", "gstvideoparsersbad", "gstrtp", "gstwebrtc", "gstnice", "gstdtls", "gstsrtp", "gstrsrtp", "gstrtpmanager", "gsttypefindfunctions", "gstwasapi2", "gstaudioconvert", "gstaudioresample", "gstopus"];
if (!existsSync(join(source, "bin", "gstreamer-1.0-0.dll")) || !existsSync(dumpbin)) throw new Error("GStreamer runtime ou dumpbin indisponivel.");
if (!target.startsWith(resolve(root, "work") + sep)) throw new Error("Destino do runtime invalido.");
rmSync(target, { recursive: true, force: true });
const binaries = new Map(readdirSync(join(source, "bin")).map((name) => [name.toLowerCase(), name]));
const queue = [];
function copy(from, relative) {
  const to = join(target, relative);
  mkdirSync(join(to, ".."), { recursive: true });
  copyFileSync(from, to);
  queue.push(from);
}
for (const plugin of plugins) {
  const name = `${plugin}.dll`;
  const from = join(source, "lib", "gstreamer-1.0", name);
  if (!existsSync(from)) throw new Error(`Plugin ausente: ${name}`);
  copy(from, join("lib", "gstreamer-1.0", name));
}
queue.push(join(root, "native", "bin", "nodus-wgc-media.exe"));
const scanner = join(source, "libexec", "gstreamer-1.0", "gst-plugin-scanner.exe");
if (existsSync(scanner)) copy(scanner, join("libexec", "gstreamer-1.0", "gst-plugin-scanner.exe"));
const seen = new Set();
for (let i = 0; i < queue.length; i++) {
  const output = spawnSync(dumpbin, ["/DEPENDENTS", queue[i]], { encoding: "utf8", windowsHide: true });
  if (output.status !== 0) throw new Error(`Dependencias indisponiveis: ${basename(queue[i])}`);
  for (const match of output.stdout.matchAll(/^\s+([\w.-]+\.dll)\s*$/gim)) {
    const key = match[1].toLowerCase();
    if (seen.has(key) || !binaries.has(key)) continue;
    seen.add(key);
    const name = binaries.get(key);
    copy(join(source, "bin", name), join("bin", name));
  }
}
const develRoot = process.env.GSTREAMER_1_0_ROOT_MSVC_X86_64 || join(root, "work", "gstreamer-cache", "devel", "PFiles64", "gstreamer", "1.0", "msvc_x86_64");
const licenses = join(develRoot, "share", "licenses");
if (!existsSync(licenses)) throw new Error("Licencas do GStreamer SDK nao encontradas.");
mkdirSync(join(target, "share"), { recursive: true });
cpSync(licenses, join(target, "share", "licenses"), { recursive: true });
console.log(`GStreamer runtime: ${queue.length} files in ${target}`);
