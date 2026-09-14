#include <iostream>
#include <winrt/base.h>
#include <winrt/Windows.Graphics.Capture.h>

int wmain() {
  winrt::init_apartment();
  const bool supported = winrt::Windows::Graphics::Capture::GraphicsCaptureSession::IsSupported();
  std::cout << "{\"windowsGraphicsCapture\":" << (supported ? "true" : "false") << "}";
  return 0;
}
