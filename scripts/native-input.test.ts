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
  const inputLoop = native.slice(native.indexOf("int runInputHelper"), native.indexOf("static std::atomic<ULONGLONG> inputLockHeartbeat"))
    .replace("std::fread(&packet, sizeof(packet), 1, stdin)", "readPacket(&packet)");
  const directory = mkdtempSync(join(tmpdir(), "nodus-input-test-"));
  const source = join(directory, "caption.cpp"), output = join(directory, "caption.exe");
  try {
    writeFileSync(source, `#include <windows.h>
#include <cstdint>
#include <cstdio>
#include <initializer_list>
#include <io.h>
#include <fcntl.h>
struct InputPacket { std::uint8_t type, button; std::uint16_t keyCode; std::int32_t x, y, delta; };
static HWND selected;
static LRESULT hit = HTCLOSE;
static UINT command = 0;
static bool timeout = false, zoomed = false;
static bool clientPoint = false;
static int dpiScale = 1;
static POINT physicalPoint{-20, 30};
static unsigned packetIndex = 0, rawDown = 0, rawUp = 0;
static bool stalePress = false, drag = false;
static LRESULT captionHit = HTMINBUTTON;
static LRESULT buttonBoundsHit = HTNOWHERE;
static DWORD buttonBoundsState = 0;
static unsigned buttonBoundsQueries = 0;
static size_t readPacket(InputPacket* packet) {
  if (packetIndex >= (stalePress ? 3u : 2u)) return 0;
  hit = (stalePress && packetIndex == 0) || (drag && packetIndex == 0) ? HTCLIENT : captionHit;
  *packet = {static_cast<std::uint8_t>(packetIndex == (stalePress ? 2u : 1u) ? 3 : 2), 0, 0, -20, 30, 0};
  ++packetIndex;
  return 1;
}
static UINT recordInput(UINT count, INPUT* inputs, int) {
  for (UINT i = 0; i < count; ++i) {
    if (inputs[i].type != INPUT_MOUSE) continue;
    if (inputs[i].mi.dwFlags & MOUSEEVENTF_LEFTDOWN) ++rawDown;
    if (inputs[i].mi.dwFlags & MOUSEEVENTF_LEFTUP) ++rawUp;
  }
  return count;
}
static BOOL recordCursor(int x, int y) { physicalPoint = {x * dpiScale, y * dpiScale}; return TRUE; }
static BOOL physicalCursor(POINT* point) { *point = physicalPoint; return TRUE; }
static BOOL logicalPoint(HWND, POINT*) { return TRUE; }
static BOOL clientRect(HWND, RECT* rect) { *rect = {0, 0, 200, 200}; return TRUE; }
static BOOL clientCoordinates(HWND, POINT* point) { *point = clientPoint ? POINT{10, 10} : POINT{-20, 30}; return TRUE; }
static void sendMouseButton(std::uint8_t, bool down) { down ? ++rawDown : ++rawUp; }
static HWND selectedWindow(POINT) { return selected; }
static BOOL isZoomed(HWND) { return zoomed; }
static LRESULT timedHit(HWND w, UINT m, WPARAM p, LPARAM l, UINT f, UINT t, PDWORD_PTR r) {
  if (m == WM_GETTITLEBARINFOEX) {
    ++buttonBoundsQueries;
    if (timeout) return 0;
    if (buttonBoundsHit) {
      auto& bar = *reinterpret_cast<TITLEBARINFOEX*>(l);
      const int index = buttonBoundsHit == HTMINBUTTON ? 2 : buttonBoundsHit == HTMAXBUTTON ? 3 : 5;
      bar.rgrect[index] = {physicalPoint.x - 5, physicalPoint.y - 5, physicalPoint.x + 5, physicalPoint.y + 5};
      bar.rgstate[index] = buttonBoundsState;
    }
    *r = 0; return 1;
  }
  if (dpiScale != 1 && (static_cast<short>(LOWORD(l)) != physicalPoint.x || static_cast<short>(HIWORD(l)) != physicalPoint.y)) { *r = HTCLIENT; return 1; }
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
#define SendInput recordInput
#define SetCursorPos recordCursor
#define GetPhysicalCursorPos physicalCursor
#define PhysicalToLogicalPointForPerMonitorDPI logicalPoint
#define GetClientRect clientRect
#define ScreenToClient clientCoordinates
${routing}
${inputLoop}
static void dispatch() { MSG m; while (PeekMessageW(&m, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&m); }
#define CHECK(value) if (!(value)) { std::printf("caption check failed at %d: hit=%lld command=%u down=%u up=%u scale=%d timeout=%d\\n", __LINE__, hit, command, rawDown, rawUp, dpiScale, timeout); return 1; }
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
    clientPoint = true; buttonBoundsHit = HTMINBUTTON; buttonBoundsQueries = 0;
    CHECK(!click.handle(down)); CHECK(!click.handle(up)); CHECK(buttonBoundsQueries == 0);
    clientPoint = false; buttonBoundsHit = HTNOWHERE;
    for (auto reported : {HTCAPTION, HTCLIENT, HTNOWHERE}) for (auto button : {HTMINBUTTON, HTMAXBUTTON, HTCLOSE}) {
      hit = reported; buttonBoundsHit = button; command = 0; zoomed = false;
      CHECK(click.handle(down)); CHECK(click.handle(up)); dispatch();
      CHECK(command == (button == HTMINBUTTON ? SC_MINIMIZE : button == HTMAXBUTTON ? SC_MAXIMIZE : SC_CLOSE));
    }
    hit = HTCLIENT; buttonBoundsHit = HTMINBUTTON;
    for (auto state : {STATE_SYSTEM_INVISIBLE, STATE_SYSTEM_OFFSCREEN}) {
      buttonBoundsState = state;
      CHECK(!click.handle(down)); CHECK(!click.handle(up));
    }
    buttonBoundsState = STATE_SYSTEM_UNAVAILABLE; command = 0;
    CHECK(click.handle(down)); CHECK(click.handle(up)); dispatch(); CHECK(command == 0);
    buttonBoundsState = 0; buttonBoundsHit = HTNOWHERE;
    hit = HTCLOSE; down.button = up.button = 2; CHECK(!click.handle(down)); CHECK(!click.handle(up)); down.button = up.button = 0;
    command = 0; timeout = true;
    CHECK(click.handle(down)); CHECK(click.handle(up)); dispatch(); CHECK(command == 0);
    clientPoint = true; CHECK(!click.handle(down)); CHECK(!click.handle(up)); clientPoint = false;
    timeout = false;
    hit = HTMINBUTTON; dpiScale = 2; recordCursor(down.x, down.y);
    CHECK(click.handle(down)); CHECK(click.handle(up)); dispatch(); CHECK(command == SC_MINIMIZE);
    dpiScale = 1; recordCursor(down.x, down.y);
    hit = HTCLOSE; command = 0;
    EnableWindow(selected, FALSE); CHECK(!click.handle(down)); EnableWindow(selected, TRUE);
    EnableMenuItem(GetSystemMenu(selected, FALSE), SC_CLOSE, MF_BYCOMMAND | MF_GRAYED);
    CHECK(click.handle(down)); CHECK(click.handle(up)); dispatch(); CHECK(command == 0);
    EnableMenuItem(GetSystemMenu(selected, FALSE), SC_CLOSE, MF_BYCOMMAND | MF_ENABLED);
    zoomed = false;
    for (auto caption : {HTMINBUTTON, HTMAXBUTTON, HTCLOSE}) for (int scenario = 0; scenario < 7; ++scenario) {
      captionHit = caption;
      command = rawDown = rawUp = packetIndex = 0;
      stalePress = scenario == 1; drag = scenario == 2;
      timeout = scenario == 3; dpiScale = scenario == 4 || scenario == 6 ? 2 : 1;
      buttonBoundsHit = scenario >= 5 ? caption : HTNOWHERE;
      if (scenario >= 5) captionHit = HTCAPTION;
      CHECK(runInputHelper(GetCurrentProcessId()) == 0); dispatch();
      CHECK(command == (drag || timeout ? 0u : caption == HTMINBUTTON ? SC_MINIMIZE : caption == HTMAXBUTTON ? SC_MAXIMIZE : SC_CLOSE));
      CHECK(rawDown == (stalePress || drag ? 1u : 0u));
      CHECK(rawUp == rawDown);
    }
    timeout = false; dpiScale = 1; buttonBoundsHit = HTNOWHERE; recordCursor(-20, 30);
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
