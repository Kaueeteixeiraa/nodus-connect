import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, test, vi } from "vitest";

test.skipIf(process.platform !== "win32")("Nodus caption clicks are paired, owner-scoped and preserve native window commands", () => {
  const builder = ts.createSourceFile("build-native-service.mjs", readFileSync("scripts/build-native-service.mjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const compile = vi.fn(() => ({ status: 0 }));
  runInNewContext(builder.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(builder)).join("\n"), {
    process: { cwd: () => process.cwd(), exit: () => { throw new Error("Native build failed"); } }, join, existsSync,
    mkdirSync: () => {}, spawnSync: compile, console: { log: () => {} },
  });
  const [compiler, arguments_] = compile.mock.calls[0] as unknown as [string, string[]];
  const native = readFileSync("native/service/main.cpp", "utf8");
  const routing = native.slice(native.indexOf("class OwnWindowCaptionClick"), native.indexOf("int runInputHelper"));
  const directory = mkdtempSync(join(tmpdir(), "nodus-input-test-"));
  const source = join(directory, "caption.cpp"), output = join(directory, "caption.exe");
  try {
    writeFileSync(source, `#include <windows.h>
#include <cstdint>
#include <cstdio>
#include <initializer_list>
struct InputPacket { std::uint8_t type, button; std::uint16_t keyCode; std::int32_t x, y, delta; };
static HWND selected;
static LRESULT hit = HTCLOSE;
static UINT command = 0;
static bool timeout = false, zoomed = false;
static HWND selectedWindow(POINT) { return selected; }
static BOOL isZoomed(HWND) { return zoomed; }
static LRESULT timedHit(HWND w, UINT m, WPARAM p, LPARAM l, UINT f, UINT t, PDWORD_PTR r) {
  return timeout ? 0 : SendMessageTimeoutW(w, m, p, l, f, t, r);
}
static LRESULT CALLBACK procedure(HWND w, UINT m, WPARAM p, LPARAM l) {
  if (m == WM_NCHITTEST) return hit;
  if (m == WM_SYSCOMMAND) { command = UINT(p); return 0; }
  return DefWindowProcW(w, m, p, l);
}
#define WindowFromPoint selectedWindow
#define SendMessageTimeoutW timedHit
#define IsZoomed isZoomed
${routing}
static void dispatch() { MSG m; while (PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&m); }
#define CHECK(value) if (!(value)) { std::printf("caption check failed at %d\\n", __LINE__); return 1; }
int main() {
  WNDCLASSW cls{}; cls.lpfnWndProc = procedure; cls.hInstance = GetModuleHandleW(nullptr); cls.lpszClassName = L"NodusCaptionTest";
  CHECK(RegisterClassW(&cls));
  for (const wchar_t* name : {L"Nodus Connect", L"Nodus QuickSupport"}) {
    selected = CreateWindowW(cls.lpszClassName, name, WS_OVERLAPPEDWINDOW, 0, 0, 520, 680, nullptr, nullptr, cls.hInstance, nullptr);
    CHECK(selected);
    OwnWindowCaptionClick click(GetCurrentProcessId());
    InputPacket down{2, 0, 0, -20, 30, 0}, up{3, 0, 0, -20, 30, 0};
    CHECK(!click.handle(up));
    for (auto code : {HTCLOSE, HTMINBUTTON, HTMAXBUTTON}) {
      hit = code; zoomed = false; command = 0;
      CHECK(click.handle(down)); dispatch(); CHECK(command == 0);
      CHECK(click.handle(up)); dispatch();
      CHECK(command == (code == HTCLOSE ? SC_CLOSE : code == HTMINBUTTON ? SC_MINIMIZE : SC_MAXIMIZE));
      CHECK(!click.handle(up));
    }
    hit = HTMAXBUTTON; zoomed = true;
    CHECK(click.handle(down)); CHECK(click.handle(up)); dispatch(); CHECK(command == SC_RESTORE);
    command = 0; hit = HTCLOSE; CHECK(click.handle(down)); hit = HTMINBUTTON;
    CHECK(click.handle(up)); dispatch(); CHECK(command == 0);
    hit = HTCLOSE; OwnWindowCaptionClick foreign(GetCurrentProcessId() + 1);
    CHECK(!foreign.handle(down)); CHECK(!foreign.handle(up));
    OwnWindowCaptionClick legacy(0); CHECK(!legacy.handle(down));
    hit = HTCLIENT; CHECK(!click.handle(down)); CHECK(!click.handle(up));
    hit = HTCLOSE; down.button = up.button = 2; CHECK(!click.handle(down)); CHECK(!click.handle(up)); down.button = up.button = 0;
    timeout = true; CHECK(!click.handle(down)); timeout = false;
    EnableWindow(selected, FALSE); CHECK(!click.handle(down)); EnableWindow(selected, TRUE);
    EnableMenuItem(GetSystemMenu(selected, FALSE), SC_CLOSE, MF_BYCOMMAND | MF_GRAYED);
    CHECK(click.handle(down)); CHECK(click.handle(up)); dispatch(); CHECK(command == 0);
    DestroyWindow(selected);
  }
  std::puts("Nodus/QuickSupport caption routing passed"); return 0;
}`);
    const args = arguments_.map(value => value.endsWith("main.cpp") ? source : value.startsWith("/Fe") ? `/Fe${output}` : value);
    const build = spawnSync(compiler, args, { cwd: directory, encoding: "utf8", windowsHide: true, timeout: 30000 });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const run = spawnSync(output, [], { cwd: directory, encoding: "utf8", windowsHide: true, timeout: 10000 });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    expect(run.stdout).toContain("Nodus/QuickSupport caption routing passed");
  } finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + "\\") || !directory.includes("nodus-input-test-")) throw new Error("UNSAFE_TEST_CLEANUP");
    rmSync(directory, { recursive: true, force: true });
  }
}, 45000);
