#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <mfidl.h>
#include <wrl/client.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

using Microsoft::WRL::ComPtr;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;

struct NativeMediaStatus {
  bool wgcSupported = false;
  bool d3d11Hardware = false;
  unsigned int hardwareH264Encoders = 0;
  std::wstring adapter;
};

struct CaptureResult {
  bool attempted = false;
  bool ok = false;
  unsigned int frames = 0;
  int width = 0;
  int height = 0;
  double fps = 0;
  std::string error;
};

std::string utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}

std::string jsonEscape(const std::string& value) {
  std::ostringstream output;
  for (const unsigned char character : value) {
    if (character == '"' || character == '\\') output << '\\' << character;
    else if (character >= 0x20) output << character;
  }
  return output.str();
}

ComPtr<ID3D11Device> createD3DDevice(bool& hardware, std::wstring& adapterName) {
  constexpr D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0 };
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL selected{};
  HRESULT result = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, &device, &selected, &context);
  hardware = SUCCEEDED(result);
  if (FAILED(result)) {
    winrt::check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, &device, &selected, &context));
  }
  ComPtr<IDXGIDevice> dxgiDevice;
  winrt::check_hresult(device.As(&dxgiDevice));
  ComPtr<IDXGIAdapter> adapter;
  winrt::check_hresult(dxgiDevice->GetAdapter(&adapter));
  DXGI_ADAPTER_DESC description{};
  if (SUCCEEDED(adapter->GetDesc(&description))) adapterName = description.Description;
  return device;
}

IDirect3DDevice createWinRtDevice(const ComPtr<ID3D11Device>& device) {
  ComPtr<IDXGIDevice> dxgiDevice;
  winrt::check_hresult(device.As(&dxgiDevice));
  winrt::com_ptr<IInspectable> inspectable;
  winrt::check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), inspectable.put()));
  return inspectable.as<IDirect3DDevice>();
}

GraphicsCaptureItem createPrimaryMonitorItem() {
  const POINT origin{};
  const HMONITOR monitor = MonitorFromPoint(origin, MONITOR_DEFAULTTOPRIMARY);
  auto interop = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
  GraphicsCaptureItem item{ nullptr };
  winrt::check_hresult(interop->CreateForMonitor(monitor, winrt::guid_of<IGraphicsCaptureItem>(), winrt::put_abi(item)));
  return item;
}

unsigned int countHardwareH264Encoders() {
  if (FAILED(MFStartup(MF_VERSION, MFSTARTUP_LITE))) return 0;
  IMFActivate** encoders = nullptr;
  UINT32 count = 0;
  MFT_REGISTER_TYPE_INFO input{ MFMediaType_Video, MFVideoFormat_NV12 };
  MFT_REGISTER_TYPE_INFO output{ MFMediaType_Video, MFVideoFormat_H264 };
  const HRESULT result = MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER,
    MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
    &input, &output, &encoders, &count);
  if (SUCCEEDED(result)) {
    for (UINT32 index = 0; index < count; ++index) encoders[index]->Release();
    CoTaskMemFree(encoders);
  } else {
    count = 0;
  }
  MFShutdown();
  return count;
}

CaptureResult runCaptureTest(const ComPtr<ID3D11Device>& d3dDevice, int durationMs) {
  CaptureResult result;
  result.attempted = true;
  try {
    const auto item = createPrimaryMonitorItem();
    const auto size = item.Size();
    result.width = size.Width;
    result.height = size.Height;
    const auto device = createWinRtDevice(d3dDevice);
    auto framePool = Direct3D11CaptureFramePool::CreateFreeThreaded(
      device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
    auto session = framePool.CreateCaptureSession(item);
    std::atomic<unsigned int> frames = 0;
    std::atomic<long long> firstFrame = 0;
    std::atomic<long long> lastFrame = 0;
    const auto startedAt = std::chrono::steady_clock::now();
    const auto token = framePool.FrameArrived([&](const Direct3D11CaptureFramePool& sender, const winrt::Windows::Foundation::IInspectable&) {
      const auto frame = sender.TryGetNextFrame();
      if (!frame) return;
      const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - startedAt).count();
      if (frames.fetch_add(1) == 0) firstFrame.store(elapsed);
      lastFrame.store(elapsed);
    });
    session.StartCapture();
    std::this_thread::sleep_for(std::chrono::milliseconds(durationMs));
    session.Close();
    framePool.FrameArrived(token);
    framePool.Close();
    result.frames = frames.load();
    const auto activeMicros = std::max<long long>(1, lastFrame.load() - firstFrame.load());
    result.fps = result.frames > 1 ? (result.frames - 1) * 1000000.0 / activeMicros : 0;
    result.ok = result.frames > 0;
  } catch (const winrt::hresult_error& error) {
    result.error = utf8(error.message().c_str());
  } catch (const std::exception& error) {
    result.error = error.what();
  }
  return result;
}

int wmain(int argc, wchar_t** argv) {
  winrt::init_apartment(winrt::apartment_type::multi_threaded);
  NativeMediaStatus status;
  status.wgcSupported = GraphicsCaptureSession::IsSupported();
  ComPtr<ID3D11Device> device;
  try {
    device = createD3DDevice(status.d3d11Hardware, status.adapter);
  } catch (...) {}
  status.hardwareH264Encoders = countHardwareH264Encoders();

  CaptureResult capture;
  if (argc >= 2 && _wcsicmp(argv[1], L"--capture-test") == 0 && status.wgcSupported && device) {
    const int requested = argc >= 3 ? _wtoi(argv[2]) : 1500;
    capture = runCaptureTest(device, std::clamp(requested, 250, 5000));
  }

  std::cout << std::fixed << std::setprecision(1)
    << "{\"windowsGraphicsCapture\":" << (status.wgcSupported ? "true" : "false")
    << ",\"d3d11Hardware\":" << (status.d3d11Hardware ? "true" : "false")
    << ",\"hardwareH264\":" << (status.hardwareH264Encoders > 0 ? "true" : "false")
    << ",\"hardwareH264Encoders\":" << status.hardwareH264Encoders
    << ",\"adapter\":\"" << jsonEscape(utf8(status.adapter)) << "\"";
  if (capture.attempted) {
    std::cout << ",\"captureTest\":{\"ok\":" << (capture.ok ? "true" : "false")
      << ",\"frames\":" << capture.frames
      << ",\"fps\":" << capture.fps
      << ",\"width\":" << capture.width
      << ",\"height\":" << capture.height
      << ",\"error\":\"" << jsonEscape(capture.error) << "\"}";
  }
  std::cout << "}";
  return 0;
}
