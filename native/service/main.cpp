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
  while (std::fread(&packet, sizeof(packet), 1, stdin) == 1) {
    if (packet.type == 1) {
      SetCursorPos(packet.x, packet.y);
    } else if (packet.type == 2 || packet.type == 3) {
      SetCursorPos(packet.x, packet.y);
      sendMouseButton(packet.button, packet.type == 2);
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
    }
  }
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

class RemoteCursorVisibility {
  bool hidden = false;
  bool dryRun;
  HANDLE armed;
public:
  RemoteCursorVisibility(bool dryRun, HANDLE armed) : dryRun(dryRun), armed(armed) {}
  ~RemoteCursorVisibility() { restore(); }

  bool hide() {
    if (hidden) return true;
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
    return true;
  }

  bool restore() {
    if (!hidden) return true;
    if (!restoreSystemCursors(dryRun)) return false;
    hidden = false;
    ResetEvent(armed);
    return true;
  }
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
    HANDLE living[] = { parent, watchdog.hProcess };
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    while (WaitForMultipleObjects(2, living, FALSE, 100) == WAIT_TIMEOUT) {
      DWORD available = 0, count = 0;
      if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) break;
      if (!available) continue;
      char commands[64];
      if (!ReadFile(input, commands, available < sizeof(commands) ? available : sizeof(commands), &count, nullptr)) break;
      bool done = false;
      for (DWORD i = 0; i < count; ++i) {
        if (commands[i] == 'R') { result = cursor.restore() ? 0 : 1; done = true; break; }
        if (commands[i] == 'H' && (!SetEvent(pulse) || !cursor.hide())) { done = true; break; }
      }
      if (done) break;
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

void WINAPI controlHandler(DWORD control) {
  if (control == SERVICE_CONTROL_STOP || control == SERVICE_CONTROL_SHUTDOWN) SetEvent(stopEvent);
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
  statusHandle = RegisterServiceCtrlHandlerW(L"NodusConnectService", controlHandler);
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
  if (argc >= 3 && _wcsicmp(argv[1], L"--cursor-visibility-helper") == 0)
    return runCursorVisibilityHelper(std::wcstoul(argv[2], nullptr, 10), argc >= 4 && _wcsicmp(argv[3], L"--dry-run") == 0);
  if (argc >= 5 && _wcsicmp(argv[1], L"--cursor-restore-watchdog") == 0)
    return runCursorWatchdog(std::wcstoul(argv[2], nullptr, 10), std::wcstoul(argv[3], nullptr, 10), argv[4], argc >= 6 && _wcsicmp(argv[5], L"--dry-run") == 0);
  if (argc >= 2 && _wcsicmp(argv[1], L"--input-helper") == 0) return runInputHelper();
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
