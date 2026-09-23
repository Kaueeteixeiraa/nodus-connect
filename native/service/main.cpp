#include <windows.h>
#include <shellapi.h>
#include <userenv.h>
#include <wtsapi32.h>
#include <cstdint>
#include <cstdio>
#include <fcntl.h>
#include <io.h>
#include <string>

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
