# Planning Center Countdown Kiosk Controller

Drives the live Planning Center Services countdown on a wall-mounted TV from a
small computer. Runs on **Debian/Ubuntu Linux (arm64 + amd64 — Raspberry Pi,
Orange Pi Zero 3, x86 Mini PCs), Windows, and macOS** — the core is Node +
Chromium via the Chrome DevTools Protocol, so it's platform-agnostic. See
[docs/PLATFORMS.md](docs/PLATFORMS.md) for per-platform setup and which
features (like TV power control) are available where.

The countdown itself is operated from inside Planning Center by the service
operator. This project just makes the TV reliably show the **right** countdown
for whichever service is happening now, and makes switching between services
trivial from a phone or laptop on the same network — no SSH, no touching the TV.

## How it works

```
┌─────────────┐   HTTPS+Auth   ┌───────────┐  HTTP    ┌──────────────────┐  Chrome DevTools   ┌───────────────┐
│ Phone/laptop│ ─────────────► │ Caddy     │ ───────► │ Control server   │ ────────────────► │ Chromium kiosk │
│ (browser)   │  control panel │ :443      │          │ 127.0.0.1:3001    │  Page.navigate     │  (the TV)      │
└─────────────┘  (login page +  │ (reverse  │          │ (Node.js/Express) │  (true top-level   │   :9222        │
                 self-signed   │  proxy)   │          │  config.json      │  navigation, NOT   │  user-data-dir │
                 TLS)          └───────────┘          └──────────────────┘  an iframe)         └───────────────┘
```

- **Control server** (`server/`) — Express app that stores the list of
  configured services, the URL template, and the currently-active selection in
  a JSON config file, and drives the kiosk tab over CDP.
- **Kiosk launcher** (`kiosk/launch-kiosk.sh`) — starts Chromium in `--kiosk`
  mode with remote debugging on localhost (`127.0.0.1:9222` only) and a
  **persistent** `--user-data-dir` profile so the Planning Center login cookie
  survives reboots. Disables screen blanking/DPMS and hides the cursor.
- **Control panel** (`public/`) — a single mobile-friendly page with one big
  button per service. Tap to switch the TV.
- **Idle page** (`/nowplaying`) — what the TV shows when no service is selected.
- **systemd units** (`kiosk/`) — one for the browser, one for the control
  server; both restart on any exit (`Restart=always`), reusing the same
  profile directory.

### Why CDP and not an iframe?

Planning Center's live page is (very likely) sent with `X-Frame-Options` / CSP
headers that block embedding. Instead of an iframe-swapping kiosk page, we
navigate the actual kiosk browser tab via the Chrome DevTools Protocol. That is
a true top-level navigation, so frame-blocking headers are irrelevant.

## Logging in (PCO session) from the panel

The kiosk needs a logged-in Planning Center session. Because the TV has no
keyboard or mouse, the control panel includes a **remote control** for the
kiosk: it streams the kiosk's Chromium tab (screencast) and forwards your
taps and keystrokes over the LAN (CDP `Page` + `Input` domains). You open the
panel on your phone, tap **Start remote control** (it navigates the kiosk to
the PCO login page), log in right there — the login happens *inside* the
kiosk's own Chromium, so the session cookie is stored in its persistent
profile and survives reboots. The TV never needs any input devices.

This is a one-time setup step (repeat it only if the PCO session expires).
Do not try to automate the PCO credentials themselves — 2FA/SSO make that
fragile, and this way the real login flow (including 2FA on your phone) is
used. The endpoint is `/api/remote/*` plus the SSE stream
`/api/remote/stream`. Note: during remote control, typed credentials cross the
LAN to the panel — fine on a trusted network, which the rest of the panel
already assumes.

## Quick start (development / testing)

Requires Node.js >= 18 and a Chromium browser.

```bash
npm install
npm start                 # control server on http://localhost:3001
```

In development (no Caddy), open `http://localhost:3001` for the control panel
and point a Chromium tab at `http://localhost:3001/nowplaying` with remote
debugging enabled to simulate the kiosk:

```bash
chromium --kiosk --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/kiosk-chromium" \
  http://127.0.0.1:3001/nowplaying
```

On the control panel, add a service (name + PCO plan ID), tap it, and watch the
kiosk tab navigate to
`https://services.planningcenteronline.com/live/<planId>`.

Run the test suite (no browser or network needed):

```bash
npm test
```

## Install on the device

See **[docs/SETUP.md](docs/SETUP.md)** (Linux) and
**[docs/PLATFORMS.md](docs/PLATFORMS.md)** (all platforms) for the full
walkthrough. The short versions:

**Linux** (Raspberry Pi OS, Debian, or Ubuntu, arm64 or amd64):

```bash
git clone https://github.com/Paperboypaddy/Planning-Center-Timer-Kiosk.git
cd Planning-Center-Timer-Kiosk
sudo ./kiosk/install.sh   # system packages, X kiosk session, control server,
                          # Caddy HTTPS+Auth, and optionally Tailscale
```

**Windows** — build the single-file Electron app with `installer\windows\build-windows.ps1` (a portable exe + slim installer; see PLATFORMS.md). It's one program with a system-tray icon for Start/Stop/Quit.

**macOS** — `./kiosk/install-macos.sh` (Homebrew Node + Caddy + launchd).

Then do the one-time PCO login from the panel's **Kiosk remote control** and
add your services.

## URL template

Each saved service stores only the two things that change:

- `serviceId` — the PCO plan/service ID (the `90197325` in the live URL).
- `displayType` — optional; only used if your template contains `{displayType}`.

The target URL is built from a configurable template. The shipped default is
the pattern verified against a real PCO account:

```
https://services.planningcenteronline.com/live/{serviceId}
```

Edit the template from the control panel's **Settings** section. Supported
tokens: `{serviceId}` (required for most setups) and `{displayType}` (optional;
replaced with an empty string when unset). Verify the pattern against your own
account before relying on it — see [docs/SETUP.md](docs/SETUP.md#2-find-and-verify-the-correct-pco-live-url-template).

## Display type & theme (defaults)

Each service can carry a `displayType`, and the panel has global defaults
(`defaultDisplayType`, `defaultTheme`) that apply to **every** service you load
(a per-service display type overrides the default). On selection — or via the
panel's **Apply to kiosk now** button — the control server sets the Planning
Center **live-controller layout** and **light/dark theme** via CDP (it briefly
emulates a desktop viewport, since those controls only render there, clicks
the option, then restores the native viewport). Planning Center saves both per
plan, so they persist on the TV's presentation.

Known display-type values (from the PCO live controller toolbar):

```
Normal Layout · Countdown Full · Countdown Lower · Lower Third · Fullscreen Overview
```

Theme values: `light` / `dark`. Application is best-effort and never blocks the
selection — failures are reported in the response (`displayType.applied: false`).

## TV power (HDMI-CEC), auto-on, and reboot schedule

Since the TV is a wall display with no buttons, the panel can control it over
HDMI-CEC (`cec-client`, from `cec-utils`):

- **Manual**: TV on / TV off / status from the panel's **TV & reboot** section.
- **Auto-on**: turn the TV on a set number of minutes before the next **service
  or rehearsal** time of any saved service (from `plan_times` via the PCO API —
  needs a configured API key). Services imported from PCO carry their service
  type id automatically; manually-added services get it backfilled in the
  background when an API key is present.
- **Reboot schedule**: its own panel section. Pick a simple option (**Every
  day**, **Weekdays**, **Weekly on** a day) plus a time, and the panel writes
  the cron for you — or paste a full 5-field cron expression (e.g.
  `30 4 * * *` for 4:30 AM daily). The scheduler runs inside the control
  server and calls `systemctl reboot` when the cron matches.

The TV must have CEC enabled, and the Pi needs `sudo apt install cec-utils`.
CEC commands are best-effort: if no CEC device is present the panel shows
"unavailable" and nothing breaks.

## Wi-Fi setup (Raspberry Pi)

On **Raspberry Pi** boards (the only SBCs validated so far) the panel's
**Wi-Fi** section scans for nearby networks, lets you pick one, and connects to
it. Enter the password there — it is passed straight to NetworkManager and is
**not** stored by the kiosk or shown again. The **Show/Hide** toggle reveals the
password once typed. The section is hidden on Windows/macOS and on unsupported
boards.

Requires **NetworkManager** (`nmcli`) on the Pi, which is the default on
Raspberry Pi OS Bookworm+. If the section is hidden, install it:
`sudo apt install network-manager`.

## Optional: import services from the Planning Center API

Instead of typing plan IDs, you can connect the control panel to your Planning
Center account and pull upcoming plans straight into the service list. This is
**read-only** — the kiosk never creates or modifies anything in PCO.

1. Create a personal access token in PCO
   (`https://api.planningcenteronline.com/oauth/applications` → "Create
   personal access token") with **Services** access, or use an OAuth2
   `app_id:secret`.
2. Either:
   - set `KIOSK_PCO_API_KEY` in the environment (recommended — see the
     `[Service]` `Environment`/`EnvironmentFile` in the systemd unit), **or**
   - paste the key into the control panel's **Planning Center import** section
     (it is saved to the config file — owned by the kiosk control user).

The importer calls:

- `GET /services/v2/service_types` — list service types
- `GET /services/v2/service_types/{id}/plans?filter=future&order=sort_date` —
  upcoming plans per type

(Endpoints and shapes from the official Services API 2018-11-01 OpenAPI
description.) Imported plans become service entries named e.g.
`Sunday 9am · Aug 9, 9:00 AM`, deduped by PCO plan ID.

## Configuration

Everything the server needs lives in one JSON file (default `config.json` next
to `package.json`, or `KIOSK_CONFIG`, or `/var/lib/kiosk/config.json` under
systemd):

```json
{
  "urlTemplate": "https://services.planningcenteronline.com/live/{serviceId}",
  "activeServiceId": "…",
  "defaultDisplayType": null,
  "defaultTheme": null,
  "tv": { "autoOn": false, "leadMinutes": 30 },
  "reboot": { "cron": null },
  "services": [
    { "id": "…", "name": "Sunday 9am", "serviceId": "90197325", "displayType": "", "serviceTypeId": "…" }
  ],
  "pco": { "apiKey": null }
}
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `KIOSK_PORT` | `3001` | Local control-server port (localhost only; the panel is exposed via Caddy on :443) |
| `KIOSK_PANEL_PORT` | `443` | HTTPS port the installer/Caddy serves the panel on (Linux/macOS installers) |
| `KIOSK_CONFIG` | `./config.json` | Path to the JSON config file |
| `KIOSK_CDP_HOST` | `127.0.0.1` | Host Chromium's CDP listens on |
| `KIOSK_CDP_PORT` | `9222` | Chromium's remote-debugging port |
| `KIOSK_PCO_API_KEY` | — | PCO personal access token (or `app_id:secret`); overrides the config-file key |

## REST API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Full state: template, services, active selection, kiosk/PCO status |
| `GET` | `/api/health` | Liveness + kiosk connection |
| `PUT` | `/api/url-template` | Set the URL template (kept for compat; use `/api/settings`) |
| `PUT` | `/api/settings` | Set `{urlTemplate?, defaultDisplayType?, defaultTheme?}` |
| `POST` | `/api/kiosk/settings/apply` | Apply saved defaults to the kiosk's current page |
| `POST` | `/api/kiosk/display-type` | `{value}` — set the live page's display type on the kiosk tab now |
| `GET` | `/api/tv/status` | HDMI-CEC availability + TV power state |
| `POST` | `/api/tv/on` | Turn the TV on over CEC |
| `POST` | `/api/tv/off` | Put the TV in standby over CEC |
| `POST` | `/api/services` | Add a service `{name, serviceId, displayType?}` |
| `PUT` | `/api/services/:id` | Update a service |
| `DELETE` | `/api/services/:id` | Delete a service |
| `POST` | `/api/select` | `{id}` → set active + `Page.navigate` the kiosk tab |
| `POST` | `/api/deselect` | Return the kiosk to the idle `/nowplaying` page |
| `GET` | `/api/pco/status` | Is a PCO API key configured? |
| `PUT` | `/api/pco/config` | Save/clear the PCO API key (`{apiKey}`) |
| `GET` | `/api/pco/plans` | Upcoming plans (needs a configured key) |
| `POST` | `/api/pco/import` | `{planIds}` → add plans as services (deduped) |
| `GET` | `/api/wifi/status` | Wi-Fi support + current network (supported SBCs only) |
| `GET` | `/api/wifi/networks` | Scan for nearby networks (SBCs only) |
| `POST` | `/api/wifi/connect` | `{ssid, password?}` → connect via NetworkManager (never stored) |
| `GET` | `/api/update/progress` | Current update progress (public, so the panel can poll across restarts) |
| `POST` | `/api/remote/start` | Start kiosk screencast; optional `{url}` to navigate first (e.g. the PCO login page) |
| `POST` | `/api/remote/stop` | Stop the screencast |
| `POST` | `/api/remote/input` | Forward `{type:'mouse'|'text'|'key', …}` to the kiosk tab |
| `GET` | `/api/remote/stream` | SSE stream of kiosk screencast frames |

`POST /api/select` returns `200` with `skipped: true` when the kiosk tab is
already on that URL (no unnecessary reload), and `502` when the kiosk browser
is unreachable — the selection is still recorded and the TV self-heals as soon
as Chromium reconnects.

## Resilience

- **Chromium crashes / reboots**: systemd restarts it with `Restart=always`
  using the same profile dir (session survives). The control server watches the
  CDP websocket, reconnects on its own, and re-navigates the tab to whatever
  should be showing (active service or idle page). No manual steps.
- **Server restarts**: state is re-read from `config.json`; on the next CDP
  connect the kiosk is re-synced.
- **Reconnect loop**: if Chromium is down, the server retries silently every
  few seconds (`KIOSK_CDP` reconnect interval is `5s`).

## Platform notes

- **Chromium package name** differs across distros/arches: `chromium`,
  `chromium-browser`, `google-chrome`… `launch-kiosk.sh` auto-detects (or use
  `KIOSK_CHROMIUM=/path/to/chromium`). The `install.sh`/unit docs call out the
  differences; no architecture-specific code lives in the app itself.
- **Screen blanking/cursor**: `launch-kiosk.sh` calls `xset s off` /
  `xset -dpms` and starts `unclutter` when present — both best-effort and only
  inside an X session, so the script is harmless on headless setups.
- **Low-power ARM**: Chromium is launched with conservative flags. In
  particular we do **not** pass `--disable-gpu` or force compositing, so
  Chromium picks a graphics backend suitable for the hardware (e.g. the Orange
  Pi Zero 3's GPU via `dri3` on Armbian).
- **Dark TV**: page loads should never flash white. Chromium gets
  `--force-dark-mode` and `--blink-settings=backgroundcolor=FF000000` (they
  cover the browser's own surfaces), and the control server injects
  `html,body{background-color:#000}` into every new document via CDP
  (`Page.addScriptToEvaluateOnNewDocument`), which covers sites that paint a
  white shell before their theme loads (e.g. the PCO SPA).
- **mDNS**: install `avahi-daemon` so the panel is reachable at
  `https://<hostname>.local` (login page over HTTPS via Caddy on :443) from a phone
  without remembering an IP.

## Continuous integration

`.github/workflows/ci.yml` runs on every push/PR:

- **Test** (ubuntu) — the full Node test suite.
- **Windows build** (windows) — builds the single-file Electron app and the
  Inno installer, uploaded as GitHub Actions artifacts (GitHub's runners are
  elevated, so the WinCodeSign symlink step needs no Developer Mode).
- **Package** (ubuntu) — a source tarball for copying to a Linux kiosk.

Trigger the Windows build manually any time from the Actions tab
(*workflow_dispatch*), and the artifacts are ready to download from the run.

## Software updates

The panel's **Software update** section shows the running version and checks
GitHub for a newer release. Releases are **manual** — they never happen on a
push or commit; you create one from the GitHub Releases page when you want to
cut it:

- **Stable release:** tag `YYYY.M.D` (e.g. `2026.8.4`), published normally.
- **Beta/pre-release:** tag `YYYY.M.D-beta` (e.g. `2026.8.5-beta`) with the
  "pre-release" checkbox — these only show up if the panel's **Include
  prereleases (beta/unstable)** toggle is on, so stable panels auto-update and
  betas stay opt-in.

> **Before tagging, bump `package.json` (and `app/package.json`) to the release
> version.** The updater verifies that the tarball's version matches the tag,
> so a beta tagged `2026.8.5-beta` must ship a `package.json` that also says
> `2026.8.5-beta`, or the update is refused as a downgrade guard.

Publishing a release triggers the `release` workflow, which builds the Windows
app and **attaches** the portable exe, the installer, a source tarball, and a
`checksums.txt` (SHA-256 of the tarball) to the release automatically. On
Linux the panel can apply an update itself (it downloads the release's source
**asset**, verifies the checksum against `checksums.txt`, re-runs
`install.sh`, and restarts the services); on Windows/macOS it links to the
release for a manual reinstall.

## Security notes

- CDP is bound to **127.0.0.1** only, so only local processes can drive the
  browser tab.
- The control server itself binds to **127.0.0.1** only. `install.sh` sets up
  a **Caddy** reverse proxy that exposes the panel on the LAN over **HTTPS**
  (self-signed certificate); on Windows the Electron app serves in-server
  HTTPS on `:443`. Either way the panel is fronted by HTTPS.
- The panel is protected by **cookie-based sessions with a login page**. On
  first run a "Create admin account" screen sets up the admin username +
  password (stored in `config.json` as a bcrypt hash); afterwards it's a
  normal login. The admin password can be changed from the panel (Settings →
  Change password). Loopback clients (the kiosk window, local control) skip
  auth; LAN clients need a valid session cookie. Sessions live in memory, so a
  control-server restart (e.g. applying an update) logs everyone out — the
  panel shows the login page again.
- The control server runs as an **unprivileged** user (`kiosk` by default).
  Its only elevated permission is a narrow sudoers entry that allows exactly
  `systemctl reboot` (for the reboot schedule) — see `kiosk/install.sh`.
- The **remote control** streams the kiosk browser and forwards keystrokes —
  over HTTPS, so it is encrypted on the wire. The panel remains LAN-only and
  is protected by the session login.
- The optional PCO API key is stored in the config file, owned by the kiosk
  control user (not root); it is never returned by the API. It can also be
  supplied via the `KIOSK_PCO_API_KEY` env var.
