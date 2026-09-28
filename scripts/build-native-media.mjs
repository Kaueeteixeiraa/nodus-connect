import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const sdkRoot = "C:\\Program Files (x86)\\Windows Kits\\10";
const sdkVersion = "10.0.26100.0";
const msvcRoot = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207";
const gstRoot = process.env.GSTREAMER_1_0_ROOT_MSVC_X86_64 || join(root, "work", "gstreamer-cache", "devel", "PFiles64", "gstreamer", "1.0", "msvc_x86_64");
const compiler = join(msvcRoot, "bin", "Hostx64", "x64", "cl.exe");
const outputDir = join(root, "native", "bin");
if (!existsSync(join(gstRoot, "include", "gstreamer-1.0", "gst", "gst.h"))) throw new Error("GStreamer MSVC x64 development SDK nao encontrado.");
mkdirSync(outputDir, { recursive: true });
const include = [
  join(msvcRoot, "include"),
  join(sdkRoot, "Include", sdkVersion, "ucrt"),
  join(sdkRoot, "Include", sdkVersion, "shared"),
  join(sdkRoot, "Include", sdkVersion, "um"),
  join(gstRoot, "include", "gstreamer-1.0"),
  join(gstRoot, "include", "glib-2.0"),
  join(gstRoot, "lib", "glib-2.0", "include"),
];
const libs = [join(msvcRoot, "lib", "x64"), join(sdkRoot, "Lib", sdkVersion, "ucrt", "x64"), join(sdkRoot, "Lib", sdkVersion, "um", "x64"), join(gstRoot, "lib")];
const output = join(outputDir, "nodus-wgc-media.exe");
const result = spawnSync(compiler, ["/nologo", "/std:c++17", "/EHsc", "/MD", "/utf-8", ...include.map((path) => `/I${path}`), join(root, "native", "wgc-media", "main.cpp"), `/Fe${output}`, "/link", ...libs.map((path) => `/LIBPATH:${path}`), "gstreamer-1.0.lib", "gstwebrtc-1.0.lib", "gstsdp-1.0.lib", "gobject-2.0.lib", "glib-2.0.lib"], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Native WGC media: ${output}`);
