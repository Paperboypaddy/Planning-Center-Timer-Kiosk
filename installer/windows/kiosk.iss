; Inno Setup installer for the Planning Center kiosk (Windows).
; Build with:  .\installer\windows\build-windows.ps1   (or iscc kiosk.iss)

#define MyAppName "Planning Center Kiosk"
#define MyAppVersion "0.1.0"
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

[Tasks]
Name: "startup"; Description: "Start the kiosk automatically at logon"; GroupDescription: "Startup:"; Flags: checked
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "bundle\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}\Kiosk"; Filename: "{app}\node.exe"; Parameters: "kiosk\launch-kiosk.js"; WorkingDir: "{app}"
Name: "{autoprograms}\{#MyAppName}\Kiosk Control panel"; Filename: "{app}\node.exe"; Parameters: "kiosk\open-panel.js"; WorkingDir: "{app}"
Name: "{autoprograms}\{#MyAppName}\Uninstall"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Kiosk"; Filename: "{app}\node.exe"; Parameters: "kiosk\launch-kiosk.js"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\Kiosk"; Filename: "{app}\node.exe"; Parameters: "kiosk\run.js"; WorkingDir: "{app}"; Tasks: startup

[Run]
; First-run setup: panel password, self-signed cert, Caddy config, panel-login.txt.
Filename: "{app}\node.exe"; Parameters: "kiosk\setup.js ""{app}"""; WorkingDir: "{app}"; Flags: runhidden; StatusMsg: "Configuring the control panel..."
; Allow inbound HTTPS to Caddy on :443 (installer runs elevated).
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=KioskPanel443 dir=in action=allow protocol=TCP localport=443"; Flags: runhidden; StatusMsg: "Adding the firewall rule..."
; Start everything now (server + Caddy + browser).
Filename: "{app}\node.exe"; Parameters: "kiosk\run.js"; WorkingDir: "{app}"; Flags: runhidden; StatusMsg: "Starting the kiosk..."; Description: "Start the kiosk now"; Tasks: startup

[UninstallRun]
Filename: "{app}\node.exe"; Parameters: "kiosk\run.js --stop"; WorkingDir: "{app}"; RunOnceId: "KioskStop"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=KioskPanel443"; Flags: runhidden
