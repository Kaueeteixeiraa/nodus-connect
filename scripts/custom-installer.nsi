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
SetCompressor /FINAL zlib

Section
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
    Goto prepare_bootstrap
  normal_update:
    ${GetOptions} $R0 "/EXTRACT=" $R3
    StrCmp $R3 "" prepare_bootstrap extract_payload
  prepare_bootstrap:
    InitPluginsDir
    SetOutPath "$PLUGINSDIR\NodusConnectSetup\resources"
    File /oname=app.asar "..\outputs\installer\bootstrap\app.asar"
    SetOutPath "$PLUGINSDIR\NodusConnectSetup"
    File /r /x resources "..\outputs\installer\win-unpacked\*.*"
    StrCmp $R1 "" launch_manual launch_update
  launch_update:
    ExecWait '"$PLUGINSDIR\NodusConnectSetup\Nodus Connect Setup.exe" "--payload-wrapper=$EXEPATH" "--auto-update=$R1"' $R2
    Goto update_finished
  launch_manual:
    ExecWait '"$PLUGINSDIR\NodusConnectSetup\Nodus Connect Setup.exe" "--payload-wrapper=$EXEPATH"' $R2
  update_finished:
    RMDir /r "$PLUGINSDIR\NodusConnectSetup"
    SetErrorLevel $R2
    Goto finished
  extract_payload:
    SetOutPath "$R3"
    File /r "..\outputs\installer\win-unpacked\*.*"
    SetErrorLevel 0
  finished:
SectionEnd
