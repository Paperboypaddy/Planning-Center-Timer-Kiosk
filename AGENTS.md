# AGENTS.md — developer guide for the Planning Center Kiosk

This file helps agents (and humans) who are new to the repo understand the
system, the conventions, and the sharp edges before they change things.

## What this is

A kiosk that drives the **Planning Center Services live/countdown page** on a
wall TV. A control panel (reachable from a phone/laptop on the same network)
lets an operator pick which service is showing. The TV tab is **navigated
directly via the Chrome DevTools Protocol (CDP)** — it is NOT an iframe, because
Planning Center sends `X-Frame-Options`/CSP that would block embedding.

Supported platforms: **Debian/Ubuntu Linux** (Raspberry Pi, Orange Pi Zero 3,
x86 Mini PCs), **Windows** (a single-file Electron app), and **macOS**
(launchd). The core is Node + any Chromium-based browser over CDP, so it is
platform-agnostic; only the packaging differs. See `docs/PLATFORMS.md`.

## Architecture

```
Phone/laptop ──HTTPS + login──► Caddy (TLS only) ──► Control server ──CDP──► Kiosk browser
                               (Linux/macOS)         (Node/Express)          (the TV tab)
                                 or in-server TLS   ──panel + API──          (persistent profile)
                                 (Windows Electron)  + scheduler
```

- `server/` — the control server (Express). Cross-platform; the heart of the app.
- `public/` — the control-panel web UI (vanilla JS, no framework, no build step).
- `kiosk/` — launchers, installers, and helpers:
  - `launch-kiosk.js` — cross-platform Chromium/Edge launcher (modes: window /
    `--kiosk` / `--login`; X-only bits only on Linux). `launch-kiosk.sh` is a
    thin bash wrapper that `exec`s it.
  - `run.js` — cross-platform supervisor (server + Caddy + browser); used by
    the Windows/macOS "launch everything" entry. Not used by Linux (systemd).
  - `gen-cert.js` — self-signed cert generator (`selfsigned` package, async).
  - `setup.js` — writes a TLS-only Caddy config (macOS installer).
  - `install.sh` (Linux), `install-macos.sh`, and `installer/windows/`
    (Inno Setup + electron-builder) — per-platform packaging.
  - `lightdm/` — the Raspberry Pi OS Lite headless autologin kiosk session.
- `app/` — the Windows **single-file Electron app** (`main.js` runs the control
  server in-process, owns the kiosk window, and hosts the system-tray icon with
  Start / Stop / Open panel / Quit).
- `.github/workflows/ci.yml` — GitHub Actions: tests (ubuntu), the Windows
  build (portable exe + Inno installer, uploaded as artifacts), and a source
  tarball.

## Key concepts

- **CDP driving**: `server/kiosk.js` (`KioskDriver`) connects to the kiosk tab
  via `chrome-remote-interface`, reconnects on crash, and has a same-URL guard
  on `navigate()`. The display-type/theme setters briefly emulate a desktop
  viewport (the PCO live-controller DOM only renders there), click the option,
  then restore it. The black-loading background is injected into every new
  document via `Page.addScriptToEvaluateOnNewDocument` (`--blink-settings` and
  `--force-dark-mode` cover the browser surfaces).
- **Remote control** (`/api/remote/*`): streams the kiosk tab as JPEG
  screencast frames over SSE and forwards taps/keystrokes back via the `Input`
  domain — this is how the one-time PCO login is done from the panel.
- **Scheduler** (`server/scheduler.js`): auto-on (turn the TV on before the
  next service/rehearsal time via CEC) and the daily reboot (cron, matched
  with `cron-parser`; reboot command is platform-aware).
- **PCO importer** (`server/pco.js`): reads the Services v2 API (read-only)
  to list upcoming plans grouped by folder → service type. Auth is a personal
  access token (`Bearer`) or `app_id:secret` (Basic). `KIOSK_PCO_API_BASE`
  overrides the base URL for tests.

## Authentication (important)

Auth lives **inside the app** on every platform — there is no Basic auth and no
Caddy `basic_auth` anymore. `server/auth.js` provides:

- Cookie sessions (`kiosk_session`, HttpOnly, SameSite=Lax, Secure when the
  request is HTTPS; server-side token Map).
- A **first-run admin setup**: `GET /api/auth/status` returns
  `{ authenticated, setupRequired }`; when no admin exists the panel shows a
  "Create admin account" form (`POST /api/auth/setup`). Afterwards it's a
  normal login (`POST /api/auth/login`) / logout (`POST /api/auth/logout`).
- The admin credentials live in `config.json` as `admin: { username,
  passwordHash }` (bcrypt via `bcryptjs`); `GET /api/state` exposes only
  `adminConfigured` (never the hash).
- `requireAuth` is mounted with `app.use('/api', requireAuth)` AFTER the
  `/api/auth/*` routes, so the auth endpoints are public and everything else is
  protected.
- **Loopback is always allowed** (the kiosk window and local control skip
  auth), so the TV display works without a login. `requireAuth` checks
  `req.socket.remoteAddress`.
- Linux/macOS: Caddy is a **TLS-only** reverse proxy to `127.0.0.1:3001`
  (no auth config). Windows: in-server HTTPS on `0.0.0.0:443` (`KIOSK_TLS=1`),
  plus a plain-HTTP listener on `127.0.0.1:3001` for the kiosk window.
- `app.set('trust proxy', 1)` so `req.secure` reflects TLS behind Caddy (Secure
  cookie handling).

**When adding a new `/api/*` endpoint**: it is automatically behind
`requireAuth` (loopback exempt) — that's usually what you want. If it must be
public, put it under `/api/auth/` or register it before the middleware.

## Config (`config.json`)

Everything the server persists lives in one JSON file (`KIOSK_CONFIG`, default
`./config.json`; `app/` uses `%APPDATA%\Planning Center Kiosk\config.json`):

```json
{
  "urlTemplate": "https://services.planningcenteronline.com/live/{serviceId}",
  "activeServiceId": null,
  "defaultDisplayType": null,
  "defaultTheme": null,
  "tv": { "autoOn": false, "leadMinutes": 30 },
  "reboot": { "cron": null },
  "admin": { "username": null, "passwordHash": null },
  "services": [{ "id": "", "name": "", "serviceId": "", "displayType": "", "serviceTypeId": null }],
  "pco": { "apiKey": null }
}
```

- `server/config.js` has a single `normalize()` that validates/migrates every
  field — **when you add a config field, add it to `defaults()` and
  `normalize()`** so hand-edited or old files never crash the server. Saving is
  atomic (write `.tmp` + rename).
- The URL template substitutes `{serviceId}` and `{displayType}` (URL-encoded)
  via `server/url.js`.

## Commands

```bash
npm install          # install server deps (dev deps needed for tests; NODE_ENV=production
                     # in some environments OMITS devDeps — run `npm install --include=dev`)
npm start            # control server on http://127.0.0.1:3001
npm run kiosk        # open a kiosk browser window (Edge/Chrome/chromium) at the idle page
npm test             # node --test (mock CDP + mock PCO; no browser/network needed)
```

## Tests

`test/` uses `node:test` (no framework). It never talks to a real browser or
network:

- `helpers/mock-cdp.js` — a fake Chromium DevTools endpoint (HTTP `/json/list`
  + a WebSocket) so `KioskDriver` can be exercised (navigate, screencast,
  input, emulation). `mock.setEvaluateResult()` controls `Runtime.evaluate`
  responses.
- `helpers/mock-pco.js` — a fake Planning Center API (folders, service types,
  plans, plan times).
- `server/app.js` is built by `createApp()` with injectable `kiosk`, `cec`, and
  `logger`, so integration-style tests spin up a real Express app on an
  ephemeral port with mocked dependencies. `runScheduler` stays false in tests.
- Tests hit `127.0.0.1`, so `requireAuth` (loopback-exempt) never blocks them;
  the session/auth logic is tested directly via `test/auth.test.js` and
  `test/auth-api.test.js`.

**Adding a route or feature**: add tests alongside; the mock CDP/PCO helpers
are the way to test CDP/API interactions without a browser.

## Sharp edges / gotchas

- `selfsigned` v5 is **async** (`await selfsigned.generate(...)`).
- The auth middleware previously ran *before* Express and used Express-only
  `res.set()/res.status()` on a raw Node response — that crashed the HTTPS
  handler. It now uses raw Node methods (`res.setHeader`/`res.statusCode`).
- The Windows kiosk profile must never be created by an **elevated** process —
  an admin-owned profile makes Edge exit immediately and `run.js`/the tray
  restart it in a loop (the original "new window every 3s" bug). The Electron
  app and the Windows installer deliberately never run the app elevated.
- Electron's data folder name comes from `app.setName('Planning Center Kiosk')`
  (set in `app/main.js`); without it Electron uses the package `name`.
- `npm install` inside this environment omits devDeps when `NODE_ENV=production`
  is set — run `npm install --include=dev` before `npm test`.
- The Windows build via electron-builder needs symlink privilege on a dev box
  (enable Developer Mode or run the build elevated); GitHub Actions runners are
  already elevated, so CI is unaffected.

## Packaging quick reference

- **Linux**: `sudo ./kiosk/install.sh` — installs packages, the lightdm kiosk
  session, the control server (unprivileged user), a TLS-only Caddy, and
  optionally Tailscale. systemd units in `kiosk/*.service` (placeholders
  `@DEST@`, `@NODE_BIN@`, `@CONFIG_DIR@`, `@CONTROL_USER@`, `@BROWSER_USER@`
  are resolved by install.sh).
- **Windows**: `installer/windows/build-windows.ps1` bundles `server/`,
  `public/`, and `kiosk/gen-cert.js` into `app/`, builds the portable exe with
  electron-builder, then Inno Setup wraps it. The app is `app/main.js`
  (server in-process + tray + kiosk window).
- **macOS**: `kiosk/install-macos.sh` (Homebrew Node/Caddy + launchd + a panel
  app).
