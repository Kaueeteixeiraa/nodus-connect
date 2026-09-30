Unicode true
!include "MUI2.nsh"
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
Caption "Nodus Connect - Preparando instalação"
BrandingText "Nodus Connect"
AutoCloseWindow true
ShowInstDetails nevershow
SetCompressor /FINAL lzma
SetCompressorDictSize 8
!define MUI_ICON "..\build\icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "..\build\installer-header.bmp"
!define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "Abrindo o Nodus Connect"
!define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "O instalador está pronto para continuar."
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

Section
  InitPluginsDir
  DetailPrint "Preparando os arquivos do instalador..."
  SetOutPath "$PLUGINSDIR\NodusConnectSetup"
  File /r "..\outputs\installer\win-unpacked\*.*"
  DetailPrint "Abrindo o instalador..."
  HideWindow
  ExecWait '"$PLUGINSDIR\NodusConnectSetup\Nodus Connect Setup.exe"'
  RMDir /r "$PLUGINSDIR\NodusConnectSetup"
SectionEnd
