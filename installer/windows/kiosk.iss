; Inno Setup installer for the Planning Center kiosk (Windows) — wraps the
; single-file Electron app built by build-windows.ps1.
; Build with:  .\installer\windows\build-windows.ps1   (or iscc kiosk.iss)

#define MyAppName "Planning Center Kiosk"
#define MyAppVersion "2026.8.5-beta.2"
#define MyAppPublisher "Planning Center Kiosk"

[Setup]
AppId={{A4F90B3D-06E3-4F21-B383-B6DB22ED16C4}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\Planning Center Kiosk
DisableProgramGroupPage=yes
PrivilegesRequired=admin
OutputDir=output
OutputBaseFilename=KioskSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
; The app is portable (single exe); keep it together with its shortcuts.
UninstallDisplayIcon={app}\Planning Center Kiosk.exe

[Tasks]
Name: "startup"; Description: "Start the kiosk automatically at logon"
Name: "desktopicon"; Description: "Create a &desktop shortcut"

[Files]
Source: "..\..\app\dist\Planning-Center-Kiosk.exe"; DestDir: "{app}"; DestName: "Planning Center Kiosk.exe"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}\Planning Center Kiosk"; Filename: "{app}\Planning Center Kiosk.exe"; WorkingDir: "{app}"
Name: "{autoprograms}\{#MyAppName}\Uninstall"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Planning Center Kiosk"; Filename: "{app}\Planning Center Kiosk.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\Planning Center Kiosk"; Filename: "{app}\Planning Center Kiosk.exe"; WorkingDir: "{app}"; Tasks: startup

[Run]
; Open the firewall for the panel (HTTPS on :443). The app itself should be
; launched by the operator (Start menu / desktop shortcut), NOT from here —
; running it from this elevated context would create the browser profile with
; administrator ownership (the cause of the earlier "new window every 3s"
; loop). The Startup shortcut launches it de-elevated at logon.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=KioskPanel443 dir=in action=allow protocol=TCP localport=443"; Flags: runhidden; StatusMsg: "Opening the firewall for the control panel..."

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=KioskPanel443"; Flags: runhidden
