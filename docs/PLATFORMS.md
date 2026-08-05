# Platforms

The kiosk control software is platform-agnostic: the core is Node + Chromium
(any Chromium-based browser) talking Chrome DevTools Protocol. What differs is
only the packaging and which platform-specific features are available.

## Feature availability

| Feature | Linux | Windows | macOS |
| --- | --- | --- | --- |
| Control server + panel | ✅ | ✅ | ✅ |
| Kiosk browser (CDP-driven) | ✅ | ✅ | ✅ |
| Display type / theme | ✅ | ✅ | ✅ |
| Remote control / PCO login | ✅ | ✅ | ✅ |
| PCO API importer | ✅ | ✅ | ✅ |
| Daily reboot schedule | ✅ | ✅ | ⚠️ needs privileges |
| TV power (CEC) + auto-on | ✅ | ❌ (USB CEC adapter only) | ❌ |
| mDNS (`https://hostname.local`) | ✅ avahi | ✅ built-in | ✅ Bonjour |

TV power control (HDMI-CEC) is Linux-only for practical purposes: on Windows
it needs a Pulse-Eight USB-CEC adapter (the panel auto-hides the section when
`cec-client` isn't found), and macOS has no common equivalent. Auto-on depends
on CEC, so it's disabled on Windows/macOS too.

## Linux (Raspberry Pi OS / Debian / Ubuntu, arm64 + amd64)

The primary, best-tested target.

```bash
sudo ./kiosk/install.sh
```

Installs everything: system packages, the X/lightdm kiosk session, the control
server, Caddy (HTTPS on :443), and optionally Tailscale. See
[SETUP.md](SETUP.md).

## Windows (Mini PC / dev laptop)

The Windows build is a **single-file Electron app** (`Planning Center Kiosk.exe`):
one program that is the whole kiosk. The control server runs in-process (with
in-server HTTPS on `:443` — no Caddy needed), the kiosk display is
the app's own fullscreen window driven by the same CDP logic, and a **system
tray icon** provides:

- **Start kiosk** / **Stop kiosk** — show/hide the kiosk window (the panel stays
  reachable from phones while stopped).
- **Open control panel** — opens `https://<hostname>.local` (also on
  double-click).
- **Quit** — stop everything and exit.

On first run the app generates a self-signed cert into its user-data folder
(`%APPDATA%\Planning Center Kiosk`). Open the panel and create the **admin
account** on the "Create admin account" screen (username + password); change
it any time from Settings → Change password. Single-instance, restart-on-crash
logging to `kiosk.log`, and it always runs non-elevated — so the
administrator-owned profile bug that plagued the old `run.js` setup can't
recur.

**Build it** (on a Windows box with Node ≥ 18 and Inno Setup 6; the ISCC env var
must point at `iscc.exe` if it's not on PATH):

```powershell
$env:ISCC = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
powershell -ExecutionPolicy Bypass -File installer\windows\build-windows.ps1
```

This produces:
- `app\dist\Planning-Center-Kiosk-<version>.exe` — the portable single-file app
  (self-contained; ~150–200 MB because it embeds a Chromium runtime).
- `installer\windows\output\KioskSetup.exe` — a slim installer that places it in
  Program Files, adds Startup/desktop shortcuts, and opens the firewall for
  `:443`.

Launch the app from the Start menu / desktop shortcut the first time. Create
the admin account on the panel's first-run screen.

For an unattended kiosk, enable Windows **autologon** so the box boots into the
session that runs the Startup shortcut.

## macOS (best-effort)

```bash
./kiosk/install-macos.sh
```

Installs Node + Caddy via Homebrew, copies the app to `/usr/local/
planningcenter-kiosk`, generates a self-signed cert, installs a launchd
agent that keeps `kiosk/run.js` (server + Caddy + browser) alive in your GUI
session, and adds a "Kiosk Control panel" app to /Applications. Allow Caddy in
the macOS firewall when prompted. The daily-reboot schedule needs elevated
privileges, so it's best-effort from a user agent.
