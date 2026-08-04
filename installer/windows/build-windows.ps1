# Builds the Windows single-file app with electron-builder (portable) and then
# compiles a small Inno Setup installer that wraps it (Program Files install,
# Startup/desktop shortcuts, and the firewall rule for the panel on :443).
#
# Prerequisites on the build machine:
#   - Node.js (>= 18)
#   - Inno Setup 6 (https://jrsoftware.org/isdl.php) — iscc.exe on PATH or the
#     ISCC env var set to its full path.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File installer\windows\build-windows.ps1

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$App = Join-Path $Root 'app'

Write-Host "==> Bundling shared code into $App"
Copy-Item -Recurse -Force (Join-Path $Root 'server') (Join-Path $App 'server')
Copy-Item -Recurse -Force (Join-Path $Root 'public') (Join-Path $App 'public')
New-Item -ItemType Directory -Force (Join-Path $App 'kiosk') | Out-Null
Copy-Item -Force (Join-Path $Root 'kiosk\gen-cert.js') (Join-Path $App 'kiosk\gen-cert.js')

Write-Host "==> Generating the app/tray icon"
& node (Join-Path $App 'gen-icon.js') (Join-Path $App 'build\icon.ico')

Write-Host "==> Installing Electron + server dependencies"
Push-Location $App
try {
  npm install
} finally {
  Pop-Location
}

Write-Host "==> Building the portable single exe"
Push-Location $App
try {
  npx electron-builder --win portable
} finally {
  Pop-Location
}

Write-Host "==> Compiling KioskSetup.exe with Inno Setup"
$iscc = $env:ISCC
if (-not $iscc) { $iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source }
if (-not $iscc) { throw "Inno Setup (iscc.exe) not found. Install it or set the ISCC env var." }
& $iscc (Join-Path $PSScriptRoot 'kiosk.iss')

Write-Host "==> Done."
Write-Host "    Portable app:  $(Join-Path $App 'dist\Planning-Center-Kiosk-*.exe')"
Write-Host "    Installer:     $(Join-Path $PSScriptRoot 'output\KioskSetup.exe')"
