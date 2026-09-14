import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const source = join(root, "native", "capture-status", "main.cpp");
const outputDir = join(root, "native", "bin");
const output = join(outputDir, "nodus-capture-status.exe");
const sdkRoot = "C:\\Program Files (x86)\\Windows Kits\\10";
const sdkVersion = "10.0.26100.0";
const sdk = join(sdkRoot, "Include", sdkVersion, "cppwinrt");
const msvcRoot = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\MSVC\\14.44.35207";
const compiler = join(msvcRoot, "bin", "Hostx64", "x64", "cl.exe");

if (!existsSync(sdk) || !existsSync(compiler)) throw new Error("Toolchain nativo do Windows nao encontrado.");
mkdirSync(outputDir, { recursive: true });

const include = [
  join(msvcRoot, "include"),
  "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\VS\\include",
  join(sdkRoot, "Include", sdkVersion, "ucrt"),
  join(sdkRoot, "Include", sdkVersion, "shared"),
  join(sdkRoot, "Include", sdkVersion, "um"),
  sdk,
];
const lib = [
  join(msvcRoot, "lib", "x64"),
  join(sdkRoot, "Lib", sdkVersion, "ucrt", "x64"),
  join(sdkRoot, "Lib", sdkVersion, "um", "x64"),
];
const result = spawnSync(compiler, ["/nologo", "/std:c++17", "/EHsc", "/utf-8", ...include.map((item) => `/I${item}`), source, `/Fe${output}`, "/link", ...lib.map((item) => `/LIBPATH:${item}`), "windowsapp.lib"], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Native capture probe: ${output}`);
