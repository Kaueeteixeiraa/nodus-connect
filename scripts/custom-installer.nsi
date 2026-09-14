Unicode true
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.0.0.0"
!endif
Name "Nodus Connect Setup"
OutFile "..\outputs\installer\Nodus-Connect-Setup.exe"
Icon "..\build\icon.ico"
VIProductVersion "${PRODUCT_VERSION}"
VIAddVersionKey "ProductName" "Nodus Connect"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "FileDescription" "Instalador oficial do Nodus Connect"
VIAddVersionKey "CompanyName" "Nodus Connect"
VIAddVersionKey "LegalCopyright" "Nodus Connect"
RequestExecutionLevel user
SilentInstall silent
ShowInstDetails nevershow
SetCompressor /FINAL zlib

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\NodusConnectSetup"
  File /r "..\outputs\installer\win-unpacked\*.*"
  ExecWait '"$PLUGINSDIR\NodusConnectSetup\Nodus Connect Setup.exe"'
  RMDir /r "$PLUGINSDIR\NodusConnectSetup"
SectionEnd
