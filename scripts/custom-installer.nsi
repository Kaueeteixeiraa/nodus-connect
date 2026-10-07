Unicode true
!include "FileFunc.nsh"
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
SetCompressor /FINAL lzma
SetCompressorDictSize 8

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\NodusConnectSetup"
  File /r "..\outputs\installer\win-unpacked\*.*"
  ${GetParameters} $R0
  StrCpy $R1 $R0 1
  StrCmp $R1 '"' 0 parse_update
  StrCpy $R1 $R0 1 -1
  StrCmp $R1 '"' 0 parse_update
  StrCpy $R0 $R0 -1 1
  parse_update:
  ${GetOptions} $R0 "/UPDATE=" $R1
  StrCmp $R1 "" normal_update automatic_update
  automatic_update:
    ExecWait '"$PLUGINSDIR\NodusConnectSetup\Nodus Connect Setup.exe" "--auto-update=$R1"' $R2
    Goto update_finished
  normal_update:
    ExecWait '"$PLUGINSDIR\NodusConnectSetup\Nodus Connect Setup.exe"' $R2
  update_finished:
  RMDir /r "$PLUGINSDIR\NodusConnectSetup"
  SetErrorLevel $R2
SectionEnd
