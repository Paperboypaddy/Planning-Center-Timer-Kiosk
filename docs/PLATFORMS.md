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
server, Caddy (HTTPS + Basic Auth on :443), and optionally Tailscale. See
[SETUP.md](SETUP.md).

## Windows (Mini PC / dev laptop)

The browser is Edge (preinstalled) or Chrome; by default it runs as a **normal
window** (pass `--kiosk` to `kiosk\launch-kiosk.js` for fullscreen). The
control server stays on `127.0.0.1:3001`; Caddy.exe serves the panel on
`:443` with the same HTTPS + Basic Auth.

**Build the installer** (on a Windows box with Node + Inno Setup 6):

```powershell
powershell -ExecutionPolicy Bypass -File installer\windows\build-windows.ps1
```

This produces `installer\windows\output\KioskSetup.exe` — a self-contained
installer (bundles `node.exe`, `caddy.exe`, and the app; no prerequisites).
It installs to `C:\Program Files\Planning Center Kiosk`, adds itself to
**Startup** (so `kiosk\run.js` starts the server + Caddy + browser at logon),
writes the panel password to `panel-login.txt` in the install dir, and opens
the firewall for `:443`. A desktop/start-menu "Kiosk" icon launches the
browser windowed.

For an unattended kiosk, enable Windows **autologon** (netplwiz / registry)
so the box boots into the session that runs the Startup entry.

Dev / test on a Windows laptop without the installer:

```powershell
npm install
npm start             # server on http://127.0.0.1:3001
npm run kiosk         # opens the kiosk browser window (Edge/Chrome)
```

## macOS (best-effort)

```bash
./kiosk/install-macos.sh
```

Installs Node + Caddy via Homebrew, copies the app to `/usr/local/
planningcenter-kiosk`, generates the panel password/cert, installs a launchd
agent that keeps `kiosk/run.js` (server + Caddy + browser) alive in your GUI
session, and adds a "Kiosk Control panel" app to /Applications. Allow Caddy in
the macOS firewall when prompted. The daily-reboot schedule needs elevated
privileges, so it's best-effort from a user agent.
