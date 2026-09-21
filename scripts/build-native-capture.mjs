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
  join(sdkRoot, "Include", sdkVersion, "winrt"),
  sdk,
];
const lib = [
  join(msvcRoot, "lib", "x64"),
  join(sdkRoot, "Lib", sdkVersion, "ucrt", "x64"),
  join(sdkRoot, "Lib", sdkVersion, "um", "x64"),
];
const result = spawnSync(compiler, ["/nologo", "/std:c++17", "/EHsc", "/utf-8", ...include.map((item) => `/I${item}`), source, `/Fe${output}`, "/link", ...lib.map((item) => `/LIBPATH:${item}`), "windowsapp.lib", "d3d11.lib", "dxgi.lib", "mf.lib", "mfplat.lib", "mfuuid.lib", "ole32.lib", "user32.lib"], { cwd: root, stdio: "inherit", windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Native capture probe: ${output}`);

if (process.argv.includes("--test")) {
  const benchmark = spawnSync(output, ["--capture-test", "1500"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (benchmark.status !== 0) process.exit(benchmark.status ?? 1);
  const status = JSON.parse(benchmark.stdout);
  if (!status.windowsGraphicsCapture || !status.d3d11Hardware || !status.captureTest?.ok) {
    throw new Error(`Pipeline nativo indisponivel: ${benchmark.stdout}`);
  }
  console.log(`Native WGC: ${status.captureTest.width}x${status.captureTest.height} @ ${status.captureTest.fps} FPS; H264 hardware encoders: ${status.hardwareH264Encoders}`);
}
