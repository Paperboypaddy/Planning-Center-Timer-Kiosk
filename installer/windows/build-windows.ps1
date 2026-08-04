# Builds the Windows installer (KioskSetup.exe) with Inno Setup.
#
# Prerequisites on the build machine:
#   - Node.js (>= 18)
#   - Inno Setup 6 (https://jrsoftware.org/isdl.php) — iscc.exe must be on
#     PATH, or set the ISCC env var to its full path.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File installer\windows\build-windows.ps1

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Bundle = Join-Path $PSScriptRoot 'bundle'

Write-Host "==> Preparing bundle in $Bundle"
if (Test-Path $Bundle) { Remove-Item -Recurse -Force $Bundle }
New-Item -ItemType Directory -Path $Bundle | Out-Null

Copy-Item -Recurse (Join-Path $Root 'server') (Join-Path $Bundle 'server')
Copy-Item -Recurse (Join-Path $Root 'public') (Join-Path $Bundle 'public')
Copy-Item -Recurse (Join-Path $Root 'kiosk') (Join-Path $Bundle 'kiosk')
Copy-Item (Join-Path $Root 'package.json') (Join-Path $Bundle 'package.json')
Copy-Item (Join-Path $Root 'package-lock.json') (Join-Path $Bundle 'package-lock.json')

Write-Host "==> Installing npm dependencies"
Push-Location $Bundle
try {
  npm install --omit=dev --no-audit --no-fund
} finally {
  Pop-Location
}

Write-Host "==> Bundling portable node.exe"
$NodeVersion = (node --version).TrimStart('v')
$NodeZip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
if (-not (Test-Path $NodeZip)) {
  Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" -OutFile $NodeZip
}
$NodeDir = Join-Path $env:TEMP "node-v$NodeVersion-win-x64"
if (-not (Test-Path (Join-Path $NodeDir 'node.exe'))) {
  Expand-Archive -Path $NodeZip -DestinationPath $env:TEMP -Force
}
Copy-Item (Join-Path $NodeDir 'node.exe') (Join-Path $Bundle 'node.exe')

Write-Host "==> Downloading caddy.exe"
New-Item -ItemType Directory -Path (Join-Path $Bundle 'caddy') -Force | Out-Null
$Caddy = Join-Path $Bundle 'caddy\caddy.exe'
if (-not (Test-Path $Caddy)) {
  Invoke-WebRequest "https://caddyserver.com/api/download?os=windows&arch=amd64" -OutFile $Caddy
}

$iscc = $env:ISCC
if (-not $iscc) { $iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source }
if (-not $iscc) { throw "Inno Setup (iscc.exe) not found. Install it or set the ISCC env var." }

Write-Host "==> Compiling KioskSetup.exe with Inno Setup"
& $iscc (Join-Path $PSScriptRoot 'kiosk.iss')

Write-Host "==> Done. Installer: $(Join-Path $PSScriptRoot 'output\KioskSetup.exe')"
