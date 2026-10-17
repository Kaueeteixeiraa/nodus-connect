Unicode true
!include "FileFunc.nsh"
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.0.0.0"
!endif
Name "Nodus Connect Setup"
!ifndef SETUP_OUTPUT
  !define SETUP_OUTPUT "..\outputs\installer\Nodus-Connect-Setup.exe"
!endif
OutFile "${SETUP_OUTPUT}"
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
!ifdef COMPACT_INSTALLER
  SetCompressor /FINAL lzma
!else
  SetCompressor /FINAL zlib
!endif

!ifdef SOLID_PAYLOAD
  !addplugindir /x86-unicode "${SEVEN_ZIP_PLUGIN}"
  Function unpack_solid
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    SetCompress off
    File /oname=payload.7z "${SOLID_PAYLOAD}"
    SetCompress auto
    File /oname=compression-license.txt "${COMPRESSION_LICENSE}"
    SetOutPath "$R3"
    ClearErrors
    Nsis7z::Extract "$PLUGINSDIR\payload.7z"
    IfErrors unpack_failed
    IfFileExists "$R3\resources\app.asar" 0 unpack_failed
    IfFileExists "$R3\_nodus_setup\app.asar" 0 unpack_failed
    StrCpy $R2 0
    Return
    unpack_failed:
      StrCpy $R2 1
  FunctionEnd
!endif

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
!ifdef SOLID_PAYLOAD
    StrCpy $R3 "$PLUGINSDIR\NodusConnectSetup"
    Call unpack_solid
    StrCmp $R2 0 0 extraction_failed
    ClearErrors
    CopyFiles /SILENT "$R3\_nodus_setup\app.asar" "$R3\resources\app.asar"
    IfErrors extraction_failed
!else
    SetOutPath "$PLUGINSDIR\NodusConnectSetup\resources"
    File /oname=app.asar "..\outputs\installer\bootstrap\app.asar"
    SetOutPath "$PLUGINSDIR\NodusConnectSetup"
    File /r /x resources "..\outputs\installer\win-unpacked\*.*"
!endif
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
!ifdef SOLID_PAYLOAD
    Call unpack_solid
    StrCmp $R2 0 0 extraction_failed
    Delete "$R3\_nodus_setup\app.asar"
    RMDir "$R3\_nodus_setup"
!else
    SetOutPath "$R3"
    File /r "..\outputs\installer\win-unpacked\*.*"
!endif
    SetErrorLevel 0
    Goto finished
  extraction_failed:
    SetErrorLevel 1
  finished:
SectionEnd
