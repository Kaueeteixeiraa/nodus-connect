#define OEMRESOURCE
#include <windows.h>
#include <shellapi.h>
#include <userenv.h>
#include <wtsapi32.h>
#include <cstdint>
#include <cstdio>
#include <fcntl.h>
#include <io.h>
#include <string>
#include <cstring>
#include <atomic>

static std::atomic<ULONGLONG> keyboardHeartbeat{0};
static std::atomic<unsigned> keyboardPending{0};
static HWND keyboardWindow;
static DWORD keyboardOutputThread;
static bool forwardedWindowsKeys[256]{};
static bool forwardedWindowsExtended[256]{};

bool postWindowsKey(UINT key, bool down, bool extended) {
  if (keyboardPending.fetch_add(1) >= 256) { keyboardPending.fetch_sub(1); keyboardHeartbeat = 0; return false; }
  if (!PostThreadMessageW(keyboardOutputThread, WM_APP + 1, key | (down ? 0x100 : 0) | (extended ? 0x200 : 0), 0)) {
    keyboardPending.fetch_sub(1);
    return false;
  }
  return true;
}

LRESULT CALLBACK windowsKeyHook(int code, WPARAM message, LPARAM data) {
  if (code != HC_ACTION) return CallNextHookEx(nullptr, code, message, data);
  const auto& key = *reinterpret_cast<KBDLLHOOKSTRUCT*>(data);
  if (key.vkCode >= 256 || (key.flags & LLKHF_INJECTED)) return CallNextHookEx(nullptr, code, message, data);
  const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
  const bool eligible = keyboardHeartbeat && GetTickCount64() - keyboardHeartbeat.load() < 3000 && GetForegroundWindow() == keyboardWindow;
  if (!eligible) {
    for (UINT i = 0; i < 256; ++i) if (forwardedWindowsKeys[i]) { postWindowsKey(i, false, forwardedWindowsExtended[i]); forwardedWindowsKeys[i] = false; }
    return CallNextHookEx(nullptr, code, message, data);
  }
  const bool shortcutModifier = key.vkCode == VK_LWIN || key.vkCode == VK_RWIN || key.vkCode == VK_LMENU || key.vkCode == VK_RMENU;
  const bool shortcutActive = forwardedWindowsKeys[VK_LWIN] || forwardedWindowsKeys[VK_RWIN]
    || forwardedWindowsKeys[VK_LMENU] || forwardedWindowsKeys[VK_RMENU];
  if (shortcutModifier || shortcutActive || forwardedWindowsKeys[key.vkCode]) {
    if (!postWindowsKey(key.vkCode, down, (key.flags & LLKHF_EXTENDED) != 0)) return CallNextHookEx(nullptr, code, message, data);
    forwardedWindowsKeys[key.vkCode] = down;
    forwardedWindowsExtended[key.vkCode] = (key.flags & LLKHF_EXTENDED) != 0;
    return 1;
  }
  return CallNextHookEx(nullptr, code, message, data);
}

DWORD WINAPI windowsKeyThread(void*) {
  const HHOOK hook = SetWindowsHookExW(WH_KEYBOARD_LL, windowsKeyHook, GetModuleHandleW(nullptr), 0);
  if (!hook) return 1;
  MSG message;
  while (GetMessageW(&message, nullptr, 0, 0) > 0) DispatchMessageW(&message);
  UnhookWindowsHookEx(hook);
  return 0;
}

int runWindowsKeyHelper(DWORD parentPid, HWND target) {
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
  DWORD targetPid = 0;
  GetWindowThreadProcessId(target, &targetPid);
  if (!parent || targetPid != parentPid || !IsWindow(target)) return 1;
  keyboardWindow = target;
  keyboardOutputThread = GetCurrentThreadId();
  MSG message;
  PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
  DWORD threadId;
  HANDLE thread = CreateThread(nullptr, 0, windowsKeyThread, nullptr, 0, &threadId);
  if (!thread) { CloseHandle(parent); return 1; }
  HANDLE living[] = { parent, thread };
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  bool done = false;
  while (!done) {
    const DWORD wake = MsgWaitForMultipleObjects(2, living, FALSE, 20, QS_POSTMESSAGE);
    if (wake != WAIT_TIMEOUT && wake != WAIT_OBJECT_0 + 2) break;
    if (keyboardHeartbeat && GetTickCount64() - keyboardHeartbeat.load() >= 3000) break;
    DWORD available = 0, count = 0;
    if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) break;
    if (available) {
      char commands[64];
      if (!ReadFile(input, commands, available < sizeof(commands) ? available : sizeof(commands), &count, nullptr)) break;
      for (DWORD i = 0; i < count; ++i) {
        if (commands[i] == 'R') { done = true; break; }
        if (commands[i] == 'H') keyboardHeartbeat = GetTickCount64();
      }
    }
    while (PeekMessageW(&message, nullptr, WM_APP + 1, WM_APP + 1, PM_REMOVE)) {
      keyboardPending.fetch_sub(1);
      std::printf("K %u %u %u\n", message.wParam & 0x100 ? 5 : 6, UINT(message.wParam & 0xff), message.wParam & 0x200 ? 1 : 0);
    }
    std::fflush(stdout);
  }
  keyboardHeartbeat = 0;
  PostThreadMessageW(threadId, WM_QUIT, 0, 0);
  WaitForSingleObject(thread, 1000);
  CloseHandle(thread);
  CloseHandle(parent);
  return 0;
}

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "wtsapi32.lib")

static SERVICE_STATUS_HANDLE statusHandle;
static SERVICE_STATUS status{};
static HANDLE stopEvent;
static HANDLE launchedProcess;
static std::wstring appPath;

#pragma pack(push, 1)
struct InputPacket {
  std::uint8_t type;
  std::uint8_t button;
  std::uint16_t keyCode;
  std::int32_t x;
  std::int32_t y;
  std::int32_t delta;
};
#pragma pack(pop)

static_assert(sizeof(InputPacket) == 16);

void sendMouseButton(std::uint8_t button, bool down) {
  INPUT input{};
  input.type = INPUT_MOUSE;
  if (button == 2) input.mi.dwFlags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
  else if (button == 1) input.mi.dwFlags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
  else input.mi.dwFlags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  SendInput(1, &input, sizeof(input));
}

int runInputHelper() {
  _setmode(_fileno(stdin), _O_BINARY);
  InputPacket packet{};
  bool pressedKeys[256]{};
  bool extendedKeys[256]{};
  bool pressedButtons[3]{};
  while (std::fread(&packet, sizeof(packet), 1, stdin) == 1) {
    if (packet.type == 7) {
      POINT point{};
      const bool ok = GetCursorPos(&point) != FALSE;
      std::printf("P %d %d %ld %ld\n", packet.delta, ok ? 1 : 0, point.x, point.y);
      std::fflush(stdout);
      continue;
    }
    if (packet.type == 1) {
      SetCursorPos(packet.x, packet.y);
    } else if (packet.type == 2 || packet.type == 3) {
      SetCursorPos(packet.x, packet.y);
      sendMouseButton(packet.button, packet.type == 2);
      if (packet.button < 3) pressedButtons[packet.button] = packet.type == 2;
    } else if (packet.type == 4) {
      INPUT input{};
      input.type = INPUT_MOUSE;
      input.mi.dwFlags = MOUSEEVENTF_WHEEL;
      input.mi.mouseData = static_cast<DWORD>(packet.delta);
      SendInput(1, &input, sizeof(input));
    } else if ((packet.type == 5 || packet.type == 6) && packet.keyCode > 0 && packet.keyCode < 256) {
      INPUT input{};
      input.type = INPUT_KEYBOARD;
      input.ki.wVk = static_cast<WORD>(packet.keyCode);
      input.ki.dwFlags = packet.button & 1 ? KEYEVENTF_EXTENDEDKEY : 0;
      if (packet.type == 6) input.ki.dwFlags |= KEYEVENTF_KEYUP;
      SendInput(1, &input, sizeof(input));
      pressedKeys[packet.keyCode] = packet.type == 5;
      extendedKeys[packet.keyCode] = (packet.button & 1) != 0;
    }
  }
  for (WORD key = 1; key < 256; ++key) {
    if (!pressedKeys[key]) continue;
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = key;
    input.ki.dwFlags = KEYEVENTF_KEYUP | (extendedKeys[key] ? KEYEVENTF_EXTENDEDKEY : 0);
    SendInput(1, &input, sizeof(input));
  }
  for (std::uint8_t button = 0; button < 3; ++button) {
    if (pressedButtons[button]) sendMouseButton(button, false);
  }
  return 0;
}

static std::atomic<ULONGLONG> inputLockHeartbeat{0};
static std::atomic<bool> blockPhysicalMouse{false};
static std::atomic<bool> blockPhysicalKeyboard{false};

LRESULT CALLBACK inputLockHook(int code, WPARAM message, LPARAM data) {
  if (code != HC_ACTION) return CallNextHookEx(nullptr, code, message, data);
  if (message == WM_KEYDOWN || message == WM_KEYUP || message == WM_SYSKEYDOWN || message == WM_SYSKEYUP) {
    const auto& key = *reinterpret_cast<KBDLLHOOKSTRUCT*>(data);
    if (blockPhysicalKeyboard && !(key.flags & LLKHF_INJECTED)) return 1;
  } else if (message >= WM_MOUSEMOVE && message <= WM_MOUSEHWHEEL) {
    const auto& mouse = *reinterpret_cast<MSLLHOOKSTRUCT*>(data);
    if (blockPhysicalMouse && !(mouse.flags & LLMHF_INJECTED)) return 1;
  }
  return CallNextHookEx(nullptr, code, message, data);
}

int runInputLockHelper(DWORD parentPid) {
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
  if (!parent) return 1;
  const HHOOK keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, inputLockHook, GetModuleHandleW(nullptr), 0);
  const HHOOK mouseHook = SetWindowsHookExW(WH_MOUSE_LL, inputLockHook, GetModuleHandleW(nullptr), 0);
  if (!keyboardHook || !mouseHook) {
    if (keyboardHook) UnhookWindowsHookEx(keyboardHook);
    if (mouseHook) UnhookWindowsHookEx(mouseHook);
    CloseHandle(parent);
    return 1;
  }
  MSG message;
  PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
  const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  bool running = true;
  while (running && WaitForSingleObject(parent, 20) == WAIT_TIMEOUT) {
    if (inputLockHeartbeat && GetTickCount64() - inputLockHeartbeat.load() >= 3000) break;
    DWORD available = 0, count = 0;
    if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) break;
    if (available) {
      char commands[64];
      if (!ReadFile(input, commands, available < sizeof(commands) ? available : sizeof(commands), &count, nullptr)) break;
      for (DWORD i = 0; i < count; ++i) {
        if (commands[i] == 'H') inputLockHeartbeat = GetTickCount64();
        else if (commands[i] == 'M') blockPhysicalMouse = true;
        else if (commands[i] == 'm') blockPhysicalMouse = false;
        else if (commands[i] == 'K') blockPhysicalKeyboard = true;
        else if (commands[i] == 'k') blockPhysicalKeyboard = false;
        else if (commands[i] == 'R') { running = false; break; }
      }
    }
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
  }
  blockPhysicalMouse = false;
  blockPhysicalKeyboard = false;
  UnhookWindowsHookEx(mouseHook);
  UnhookWindowsHookEx(keyboardHook);
  CloseHandle(parent);
  return 0;
}

bool restoreSystemCursors(bool dryRun) {
  std::puts("[CURSOR] Restoring local host cursor");
  if (!dryRun && !SystemParametersInfoW(SPI_SETCURSORS, 0, nullptr, 0)) {
    std::printf("[CURSOR] Failed to restore local host cursor: Windows error %lu\n", GetLastError());
    std::fflush(stdout);
    return false;
  }
  std::puts(dryRun ? "[CURSOR] Local host cursor restored (dry run)" : "[CURSOR] Local host cursor restored");
  std::fflush(stdout);
  return true;
}

class HostOnlyPointer {
  HWND window = nullptr;
  HCURSOR arrow = nullptr;
  POINT hotspot{}, previous{};
  bool attempted = false, visible = false;

  static LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_NCCREATE) SetWindowLongPtrW(hwnd, GWLP_USERDATA,
      reinterpret_cast<LONG_PTR>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams));
    auto* pointer = reinterpret_cast<HostOnlyPointer*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (message == WM_NCHITTEST) return HTTRANSPARENT;
    if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
    if (message == WM_ERASEBKGND) return 1;
    if (message == WM_PAINT && pointer) {
      PAINTSTRUCT paint;
      HDC dc = BeginPaint(hwnd, &paint);
      RECT rect;
      GetClientRect(hwnd, &rect);
      SetDCBrushColor(dc, RGB(255, 0, 255));
      FillRect(dc, &rect, static_cast<HBRUSH>(GetStockObject(DC_BRUSH)));
      DrawIconEx(dc, 0, 0, pointer->arrow, GetSystemMetrics(SM_CXCURSOR),
        GetSystemMetrics(SM_CYCURSOR), 0, nullptr, DI_NORMAL);
      EndPaint(hwnd, &paint);
      return 0;
    }
    return DefWindowProcW(hwnd, message, wparam, lparam);
  }

  bool start() {
    if (attempted) return window != nullptr;
    attempted = true;
    // Older Windows treats EXCLUDEFROMCAPTURE as a black rectangle, not exclusion.
    using VersionFunction = LONG (WINAPI*)(OSVERSIONINFOW*);
    auto versionFunction = reinterpret_cast<VersionFunction>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
    OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof(version);
    if (!versionFunction || versionFunction(&version) || version.dwBuildNumber < 19041) {
      std::puts("[CURSOR] Host-only pointer unavailable: capture exclusion requires Windows build 19041+");
      return false;
    }
    arrow = static_cast<HCURSOR>(CopyIcon(LoadCursorW(nullptr, MAKEINTRESOURCEW(OCR_NORMAL))));
    if (!arrow) return false;
    ICONINFO icon{};
    if (GetIconInfo(arrow, &icon)) {
      hotspot = { static_cast<LONG>(icon.xHotspot), static_cast<LONG>(icon.yHotspot) };
      if (icon.hbmMask) DeleteObject(icon.hbmMask);
      if (icon.hbmColor) DeleteObject(icon.hbmColor);
    }
    WNDCLASSW cls{};
    cls.lpfnWndProc = windowProc;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = L"NodusHostOnlyPointer";
    if (!RegisterClassW(&cls)) return false;
    window = CreateWindowExW(WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
      cls.lpszClassName, L"", WS_POPUP, 0, 0, GetSystemMetrics(SM_CXCURSOR), GetSystemMetrics(SM_CYCURSOR),
      nullptr, nullptr, cls.hInstance, this);
    DWORD affinity = 0;
    if (!window || !SetLayeredWindowAttributes(window, RGB(255, 0, 255), 255, LWA_COLORKEY)
      || !SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE)
      || !GetWindowDisplayAffinity(window, &affinity) || affinity != WDA_EXCLUDEFROMCAPTURE) {
      std::printf("[CURSOR] Host-only pointer unavailable: capture exclusion failed, Windows error %lu\n", GetLastError());
      if (window) DestroyWindow(window);
      window = nullptr;
      return false;
    }
    std::puts("[CURSOR] Host-only pointer ready: capture exclusion affinity=17 (visual validation required)");
    std::fflush(stdout);
    return true;
  }
public:
  ~HostOnlyPointer() {
    if (window) DestroyWindow(window);
    if (arrow) DestroyCursor(arrow);
  }
  bool prepare() { return start(); }
  void hide() {
    if (window && visible) ShowWindow(window, SW_HIDE);
    visible = false;
  }
  void update() {
    if (!start()) return;
    POINT point;
    if (!GetCursorPos(&point) || (visible && point.x == previous.x && point.y == previous.y)) return;
    SetWindowPos(window, HWND_TOPMOST, point.x - hotspot.x, point.y - hotspot.y, 0, 0,
      SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    if (!visible) { InvalidateRect(window, nullptr, FALSE); UpdateWindow(window); }
    previous = point;
    visible = true;
  }
};

class RemoteCursorVisibility {
  bool hidden = false;
  bool remoteOwner = false;
  bool dryRun;
  HANDLE armed;
  HostOnlyPointer pointer;
public:
  RemoteCursorVisibility(bool dryRun, HANDLE armed) : dryRun(dryRun), armed(armed) {}
  ~RemoteCursorVisibility() { restore(); }

  bool isHidden() const { return hidden; }
  bool isRemoteOwner() const { return remoteOwner; }

  bool hide() {
    remoteOwner = true;
    if (hidden) return true;
    if (!dryRun) pointer.prepare();
    std::puts("[CURSOR] Hiding local host cursor");
    // Arm recovery before the first desktop-wide change; never write the cursor scheme.
    if (!SetEvent(armed)) {
      std::printf("[CURSOR] Failed to hide local host cursor: recovery arm, Windows error %lu\n", GetLastError());
      std::fflush(stdout);
      return false;
    }
    hidden = true;
    const DWORD ids[] = { OCR_NORMAL, OCR_IBEAM, OCR_WAIT, OCR_CROSS, OCR_UP,
      OCR_SIZENWSE, OCR_SIZENESW, OCR_SIZEWE, OCR_SIZENS, OCR_SIZEALL,
      OCR_NO, OCR_HAND, OCR_APPSTARTING };
    unsigned char andMask[128], xorMask[128]{};
    std::memset(andMask, 0xff, sizeof(andMask));
    for (DWORD id : ids) {
      if (dryRun) continue;
      HCURSOR cursor = CreateCursor(GetModuleHandleW(nullptr), 0, 0, 32, 32, andMask, xorMask);
      if (!cursor || !SetSystemCursor(cursor, id)) {
        const DWORD error = GetLastError();
        std::printf("[CURSOR] Failed to hide local host cursor: cursor %lu, Windows error %lu\n", id, error);
        restore();
        return false;
      }
    }
    std::puts(dryRun ? "[CURSOR] Local host cursor hidden (dry run)" : "[CURSOR] Local host cursor hidden");
    std::fflush(stdout);
    update();
    return true;
  }

  bool restore() {
    pointer.hide();
    if (!hidden) return true;
    if (!restoreSystemCursors(dryRun)) return false;
    hidden = false;
    remoteOwner = false;
    ResetEvent(armed);
    return true;
  }
  bool yieldToHost() {
    remoteOwner = false;
    if (!dryRun && pointer.prepare()) { pointer.update(); return true; }
    return restore();
  }
  void update() { if (hidden && !dryRun) pointer.update(); }
};

class PhysicalMouseActivity {
  static constexpr unsigned movementThreshold = 8;
  static constexpr ULONGLONG movementWindowMs = 150;
  HWND window = nullptr;
  unsigned movement = 0;
  ULONGLONG lastMovementAt = 0;
  bool buttonPending = false;

  void record(LONG x, LONG y, USHORT buttons) {
    if (buttons) buttonPending = true;
    const std::uint64_t distance = (x < 0 ? -static_cast<std::int64_t>(x) : x)
      + (y < 0 ? -static_cast<std::int64_t>(y) : y);
    if (!distance) return;
    const ULONGLONG now = GetTickCount64();
    if (!lastMovementAt || now - lastMovementAt > movementWindowMs) movement = 0;
    const std::uint64_t total = movement + distance;
    movement = static_cast<unsigned>(total > 1000 ? 1000 : total);
    lastMovementAt = now;
  }

  static LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_NCCREATE) {
      SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams));
    }
    auto* activity = reinterpret_cast<PhysicalMouseActivity*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
    if (message == WM_INPUT && activity) {
      RAWINPUT input{};
      UINT size = sizeof(input);
      if (GetRawInputData(reinterpret_cast<HRAWINPUT>(lparam), RID_INPUT, &input, &size, sizeof(RAWINPUTHEADER)) != UINT(-1)
        && input.header.dwType == RIM_TYPEMOUSE) {
        activity->record(input.data.mouse.lLastX, input.data.mouse.lLastY, input.data.mouse.usButtonFlags);
      }
    }
    return DefWindowProcW(hwnd, message, wparam, lparam);
  }
public:
  ~PhysicalMouseActivity() {
    if (window) {
      RAWINPUTDEVICE device{ 0x01, 0x02, RIDEV_REMOVE, nullptr };
      RegisterRawInputDevices(&device, 1, sizeof(device));
      DestroyWindow(window);
    }
  }
  bool start() {
    WNDCLASSW cls{};
    cls.lpfnWndProc = windowProc;
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = L"NodusPhysicalMouseActivity";
    if (!RegisterClassW(&cls)) return false;
    window = CreateWindowExW(0, cls.lpszClassName, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, cls.hInstance, this);
    RAWINPUTDEVICE device{ 0x01, 0x02, RIDEV_INPUTSINK, window };
    return window && RegisterRawInputDevices(&device, 1, sizeof(device));
  }
  bool take() {
    MSG message;
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
    const ULONGLONG now = GetTickCount64();
    const bool moved = buttonPending || movement >= movementThreshold;
    if (moved || (lastMovementAt && now - lastMovementAt > movementWindowMs)) {
      movement = 0;
      lastMovementAt = 0;
    }
    buttonPending = false;
    return moved;
  }

  void simulateMovement(LONG distance) { record(distance, 0, 0); }
};

int runCursorWatchdog(DWORD helperPid, DWORD parentPid, const std::wstring& name, bool dryRun) {
  HANDLE helper = OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, FALSE, helperPid);
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
  HANDLE ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, (name + L"-ready").c_str());
  HANDLE armed = OpenEventW(SYNCHRONIZE, FALSE, (name + L"-armed").c_str());
  HANDLE pulse = OpenEventW(SYNCHRONIZE, FALSE, (name + L"-pulse").c_str());
  const std::wstring mutexName = dryRun ? name + L"-test-lock" : L"Local\\NodusConnectCursorVisibility";
  HANDLE mutex = CreateMutexW(nullptr, FALSE, mutexName.c_str());
  if (!helper || !parent || !ready || !armed || !pulse || !mutex) return 1;
  const DWORD lock = WaitForSingleObject(mutex, 0);
  if (lock != WAIT_OBJECT_0 && lock != WAIT_ABANDONED) return 1;
  if (lock == WAIT_ABANDONED && !dryRun) {
    while (!restoreSystemCursors(false)) Sleep(1000);
  }
  if (!SetEvent(ready)) return 1;
  HANDLE handles[] = { helper, parent, pulse };
  DWORD result;
  do { result = WaitForMultipleObjects(3, handles, FALSE, 5000); }
  while (result == WAIT_OBJECT_0 + 2);
  if (WaitForSingleObject(helper, 0) == WAIT_TIMEOUT) {
    TerminateProcess(helper, 1);
    WaitForSingleObject(helper, 1000);
  }
  // This process survives Electron/helper failure and owns the lock until recovery.
  if (WaitForSingleObject(armed, 0) == WAIT_OBJECT_0) {
    while (!restoreSystemCursors(dryRun)) Sleep(1000);
  }
  ReleaseMutex(mutex);
  for (HANDLE handle : { helper, parent, ready, armed, pulse, mutex }) CloseHandle(handle);
  return 0;
}

int runCursorVisibilityHelper(DWORD parentPid, bool dryRun) {
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentPid);
  if (!parent || WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) return 1;
  const std::wstring name = L"Local\\NodusCursor-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
  HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, (name + L"-ready").c_str());
  HANDLE armed = CreateEventW(nullptr, TRUE, FALSE, (name + L"-armed").c_str());
  HANDLE pulse = CreateEventW(nullptr, FALSE, FALSE, (name + L"-pulse").c_str());
  if (!ready || !armed || !pulse) return 1;
  wchar_t exe[32768];
  if (!GetModuleFileNameW(nullptr, exe, 32768)) return 1;
  std::wstring command = L"\"" + std::wstring(exe) + L"\" --cursor-restore-watchdog "
    + std::to_wstring(GetCurrentProcessId()) + L" " + std::to_wstring(parentPid) + L" " + name + (dryRun ? L" --dry-run" : L"");
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = INVALID_HANDLE_VALUE;
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  // Do not inherit stdin: closing Electron's pipe must reach the visibility worker.
  SetHandleInformation(GetStdHandle(STD_INPUT_HANDLE), HANDLE_FLAG_INHERIT, 0);
  PROCESS_INFORMATION watchdog{};
  if (!CreateProcessW(exe, command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB, nullptr, nullptr, &startup, &watchdog)) {
    std::printf("[CURSOR] Failed to hide local host cursor: watchdog launch, Windows error %lu\n", GetLastError());
    return 1;
  }
  CloseHandle(watchdog.hThread);
  HANDLE starting[] = { ready, watchdog.hProcess };
  int result = 1;
  if (WaitForMultipleObjects(2, starting, FALSE, 3000) == WAIT_OBJECT_0) {
    std::printf("[CURSOR] Restoration watchdog armed pid=%lu\n", watchdog.dwProcessId);
    std::fflush(stdout);
    RemoteCursorVisibility cursor(dryRun, armed);
    PhysicalMouseActivity physicalMouse;
    if (!physicalMouse.start()) {
      std::printf("[CURSOR] Physical mouse monitor unavailable: Windows error %lu; no cursors changed\n", GetLastError());
      std::fflush(stdout);
    } else {
      std::puts("[CURSOR] Physical mouse monitor ready");
      std::fflush(stdout);
      HANDLE living[] = { parent, watchdog.hProcess };
      const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
      while (true) {
        const DWORD wake = MsgWaitForMultipleObjects(2, living, FALSE, 10, QS_RAWINPUT);
        if (wake != WAIT_TIMEOUT && wake != WAIT_OBJECT_0 + 2) break;
        // Raw device input distinguishes the host's mouse from Nodus SetCursorPos/SendInput.
        const bool localActivity = physicalMouse.take();
        if (!dryRun && localActivity && cursor.isRemoteOwner()) {
          std::puts("[CURSOR] Physical host mouse active");
          std::fflush(stdout);
          if (!cursor.yieldToHost()) break;
        }
        cursor.update();
        DWORD available = 0, count = 0;
        if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) break;
        if (!available) continue;
        char commands[64];
        if (!ReadFile(input, commands, available < sizeof(commands) ? available : sizeof(commands), &count, nullptr)) break;
        bool done = false;
        for (DWORD i = 0; i < count; ++i) {
          if (commands[i] == 'R') { result = cursor.restore() ? 0 : 1; done = true; break; }
          if (commands[i] == 'H') {
            if (!SetEvent(pulse)) { done = true; break; }
          }
          if (commands[i] == 'M' && !cursor.hide()) { done = true; break; }
          if (commands[i] == 'L' && dryRun && !cursor.restore()) { done = true; break; }
          if ((commands[i] == 'N' || commands[i] == 'P') && dryRun) {
            physicalMouse.simulateMovement(commands[i] == 'P' ? 8 : 1);
            if (physicalMouse.take() && cursor.isHidden()) {
              std::puts("[CURSOR] Physical host mouse active");
              std::fflush(stdout);
              if (!cursor.restore()) { done = true; break; }
            }
          }
        }
        if (done) break;
      }
    }
  } else {
    std::puts("[CURSOR] Failed to hide local host cursor: watchdog not ready; no cursors changed");
    std::fflush(stdout);
  }
  for (HANDLE handle : { parent, ready, armed, pulse, watchdog.hProcess }) CloseHandle(handle);
  return result;
}

void setStatus(DWORD state, DWORD exitCode = NO_ERROR) {
  status.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  status.dwCurrentState = state;
  status.dwWin32ExitCode = exitCode;
  status.dwControlsAccepted = state == SERVICE_RUNNING ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN : 0;
  SetServiceStatus(statusHandle, &status);
}

bool servicesCanSendSas() {
  DWORD value = 0, size = sizeof(value);
  return RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
    L"SoftwareSASGeneration", RRF_RT_REG_DWORD, nullptr, &value, &size) == ERROR_SUCCESS && (value == 1 || value == 3);
}

DWORD sendServiceSas() {
  if (!servicesCanSendSas()) return ERROR_ACCESS_DISABLED_BY_POLICY;
  HANDLE token = nullptr;
  if (!WTSQueryUserToken(WTSGetActiveConsoleSessionId(), &token)) return GetLastError();
  const BOOL impersonated = ImpersonateLoggedOnUser(token);
  CloseHandle(token);
  if (!impersonated) return GetLastError();
  HMODULE module = LoadLibraryExW(L"sas.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  auto send = module ? reinterpret_cast<void(WINAPI*)(BOOL)>(GetProcAddress(module, "SendSAS")) : nullptr;
  const DWORD error = send ? ERROR_SUCCESS : ERROR_PROC_NOT_FOUND;
  if (send) send(FALSE);
  RevertToSelf();
  if (module) FreeLibrary(module);
  return error;
}

int requestServiceSas() {
  if (!servicesCanSendSas()) { std::puts("SAS_POLICY_REQUIRED"); return 1; }
  DWORD sessionId = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &sessionId) || sessionId != WTSGetActiveConsoleSessionId()) {
    std::puts("SAS_SESSION_UNAVAILABLE"); return 1;
  }
  const std::wstring name = L"Global\\NodusConnectSas-" + std::to_wstring(sessionId);
  HANDLE acknowledged = CreateEventW(nullptr, TRUE, FALSE, name.c_str());
  if (!acknowledged || GetLastError() == ERROR_ALREADY_EXISTS) {
    if (acknowledged) CloseHandle(acknowledged);
    std::puts("SAS_SERVICE_UNAVAILABLE"); return 1;
  }
  SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  SC_HANDLE service = manager ? OpenServiceW(manager, L"NodusConnectService", SERVICE_USER_DEFINED_CONTROL) : nullptr;
  SERVICE_STATUS current{};
  const bool ok = service && ControlService(service, 128, &current) && WaitForSingleObject(acknowledged, 1500) == WAIT_OBJECT_0;
  if (service) CloseServiceHandle(service);
  if (manager) CloseServiceHandle(manager);
  CloseHandle(acknowledged);
  std::puts(ok ? "SAS_REQUESTED" : "SAS_SERVICE_UNAVAILABLE");
  return ok ? 0 : 1;
}

void WINAPI controlHandler(DWORD control) {
  if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) SetEvent(stopEvent);
}

DWORD WINAPI serviceControlHandler(DWORD control, DWORD, void*, void*) {
  if (control == 128) {
    const std::wstring name = L"Global\\NodusConnectSas-" + std::to_wstring(WTSGetActiveConsoleSessionId());
    HANDLE acknowledged = OpenEventW(EVENT_MODIFY_STATE, FALSE, name.c_str());
    if (!acknowledged) return ERROR_INVALID_HANDLE;
    const DWORD result = sendServiceSas();
    if (result == ERROR_SUCCESS) SetEvent(acknowledged);
    CloseHandle(acknowledged);
    return result;
  }
  controlHandler(control);
  return NO_ERROR;
}

bool launchForActiveUser() {
  if (launchedProcess && WaitForSingleObject(launchedProcess, 0) == WAIT_TIMEOUT) return true;
  if (launchedProcess) {
    CloseHandle(launchedProcess);
    launchedProcess = nullptr;
  }
  const DWORD session = WTSGetActiveConsoleSessionId();
  if (session == 0xFFFFFFFF) return false;
  HANDLE token = nullptr;
  if (!WTSQueryUserToken(session, &token)) return false;
  LPVOID environment = nullptr;
  CreateEnvironmentBlock(&environment, token, FALSE);
  std::wstring command = L"\"" + appPath + L"\" --service-launched";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.lpDesktop = const_cast<wchar_t*>(L"winsta0\\default");
  PROCESS_INFORMATION process{};
  const BOOL launched = CreateProcessAsUserW(token, nullptr, command.data(), nullptr, nullptr, FALSE,
    CREATE_UNICODE_ENVIRONMENT, environment, nullptr, &startup, &process);
  if (environment) DestroyEnvironmentBlock(environment);
  CloseHandle(token);
  if (!launched) return false;
  CloseHandle(process.hThread);
  launchedProcess = process.hProcess;
  return true;
}

void WINAPI serviceMain(DWORD argc, LPWSTR* argv) {
  statusHandle = RegisterServiceCtrlHandlerExW(L"NodusConnectService", serviceControlHandler, nullptr);
  if (!statusHandle) return;
  stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (argc > 2 && _wcsicmp(argv[1], L"--service") == 0) appPath = argv[2];
  setStatus(SERVICE_RUNNING);
  while (WaitForSingleObject(stopEvent, 5000) == WAIT_TIMEOUT) {
    if (!appPath.empty()) launchForActiveUser();
  }
  setStatus(SERVICE_STOPPED);
  if (launchedProcess) {
    CloseHandle(launchedProcess);
    launchedProcess = nullptr;
  }
  CloseHandle(stopEvent);
}

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && _wcsicmp(argv[1], L"--cursor-overlay-probe") == 0) {
    HostOnlyPointer pointer;
    return pointer.prepare() ? 0 : 1;
  }
  if (argc >= 2 && _wcsicmp(argv[1], L"--send-sas") == 0) return requestServiceSas();
  if (argc >= 4 && _wcsicmp(argv[1], L"--windows-key-helper") == 0)
    return runWindowsKeyHelper(std::wcstoul(argv[2], nullptr, 10), reinterpret_cast<HWND>(std::wcstoull(argv[3], nullptr, 10)));
  if (argc >= 3 && _wcsicmp(argv[1], L"--cursor-visibility-helper") == 0)
    return runCursorVisibilityHelper(std::wcstoul(argv[2], nullptr, 10), argc >= 4 && _wcsicmp(argv[3], L"--dry-run") == 0);
  if (argc >= 5 && _wcsicmp(argv[1], L"--cursor-restore-watchdog") == 0)
    return runCursorWatchdog(std::wcstoul(argv[2], nullptr, 10), std::wcstoul(argv[3], nullptr, 10), argv[4], argc >= 6 && _wcsicmp(argv[5], L"--dry-run") == 0);
  if (argc >= 2 && _wcsicmp(argv[1], L"--input-helper") == 0) return runInputHelper();
  if (argc >= 3 && _wcsicmp(argv[1], L"--input-lock-helper") == 0) return runInputLockHelper(std::wcstoul(argv[2], nullptr, 10));
  if (argc >= 3 && _wcsicmp(argv[1], L"--install") == 0) {
    SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CREATE_SERVICE);
    if (!manager) return 1;
    std::wstring command = L"\"" + std::wstring(argv[0]) + L"\" --service \"" + argv[2] + L"\"";
    SC_HANDLE service = CreateServiceW(manager, L"NodusConnectService", L"Nodus Connect Service",
      SERVICE_CHANGE_CONFIG | SERVICE_START | DELETE, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START,
      SERVICE_ERROR_NORMAL, command.c_str(), nullptr, nullptr, nullptr, nullptr, nullptr);
    const bool ok = service != nullptr;
    if (service) CloseServiceHandle(service);
    CloseServiceHandle(manager);
    return ok ? 0 : 1;
  }
  if (argc >= 2 && _wcsicmp(argv[1], L"--uninstall") == 0) {
    SC_HANDLE manager = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
    if (!manager) return 1;
    SC_HANDLE service = OpenServiceW(manager, L"NodusConnectService", SERVICE_STOP | DELETE);
    const bool ok = service && DeleteService(service);
    if (service) CloseServiceHandle(service);
    CloseServiceHandle(manager);
    return ok ? 0 : 1;
  }
  SERVICE_TABLE_ENTRYW table[] = {{ const_cast<LPWSTR>(L"NodusConnectService"), serviceMain }, { nullptr, nullptr }};
  return StartServiceCtrlDispatcherW(table) ? 0 : 1;
}
