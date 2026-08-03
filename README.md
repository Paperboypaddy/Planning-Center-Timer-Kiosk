# Planning Center Countdown Kiosk Controller

Drives the live Planning Center Services countdown on a wall-mounted TV from a
small single-board computer (target: Orange Pi Zero 3 / Armbian; developed and
tested on any Debian/Ubuntu system, a Raspberry Pi, or a plain VM).

The countdown itself is operated from inside Planning Center by the service
operator. This project just makes the TV reliably show the **right** countdown
for whichever service is happening now, and makes switching between services
trivial from a phone or laptop on the same network — no SSH, no touching the TV.

## How it works

```
┌─────────────┐   HTTP (JSON)    ┌──────────────────┐   Chrome DevTools Protocol   ┌───────────────┐
│ Phone/laptop│ ───────────────► │ Control server   │ ──────────────────────────► │ Chromium kiosk │
│ (browser)   │   control panel  │ (Node.js/Express)│  Page.navigate (true top-   │  (the TV)      │
│ :3000       │                  │                  │  level navigation, NOT an   │   :9222        │
└─────────────┘                  │   config.json    │  iframe — unaffected by     │   user-data-dir│
                                 └──────────────────┘  X-Frame-Options/CSP)       └───────────────┘
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
  server; the browser restarts on crash with `Restart=on-failure`, reusing the
  same profile directory.

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
npm start                 # control server on http://localhost:3000
```

Open `http://<hostname>:3000` for the control panel, and point a Chromium tab
at `http://localhost:3000/nowplaying` with remote debugging enabled to simulate
the kiosk:

```bash
chromium --kiosk --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.config/kiosk-chromium" \
  http://127.0.0.1:3000/nowplaying
```

On the control panel, add a service (name + PCO plan ID), tap it, and watch the
kiosk tab navigate to
`https://services.planningcenteronline.com/live/<planId>`.

Run the test suite (no browser or network needed):

```bash
npm test
```

## Install on the device

See **[docs/SETUP.md](docs/SETUP.md)** for the full walkthrough, including the
one-time Planning Center login step and how to find/verify the correct live URL
template. The short version:

```bash
sudo apt install nodejs chromium avahi-daemon   # or chromium-browser on some distros
./kiosk/install.sh                               # installs to /opt/kiosk, wires systemd
# one-time login (as the kiosk X-session user):
sudo -u kiosk env KIOSK_PROFILE_DIR=/var/lib/kiosk/chromium-profile \
  /opt/kiosk/kiosk/launch-kiosk.sh --login
systemctl enable --now kiosk-browser.service
```

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
     (it is saved to the config file — protect it: `chmod 600` / root-owned).

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
  "services": [
    { "id": "…", "name": "Sunday 9am", "serviceId": "90197325", "displayType": "" }
  ],
  "pco": { "apiKey": null }
}
```

| Env var | Default | Purpose |
| --- | --- | --- |
| `KIOSK_PORT` | `3000` | Control panel / API port |
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
| `POST` | `/api/services` | Add a service `{name, serviceId, displayType?}` |
| `PUT` | `/api/services/:id` | Update a service |
| `DELETE` | `/api/services/:id` | Delete a service |
| `POST` | `/api/select` | `{id}` → set active + `Page.navigate` the kiosk tab |
| `POST` | `/api/deselect` | Return the kiosk to the idle `/nowplaying` page |
| `GET` | `/api/pco/status` | Is a PCO API key configured? |
| `PUT` | `/api/pco/config` | Save/clear the PCO API key (`{apiKey}`) |
| `GET` | `/api/pco/plans` | Upcoming plans (needs a configured key) |
| `POST` | `/api/pco/import` | `{planIds}` → add plans as services (deduped) |
| `POST` | `/api/remote/start` | Start kiosk screencast; optional `{url}` to navigate first (e.g. the PCO login page) |
| `POST` | `/api/remote/stop` | Stop the screencast |
| `POST` | `/api/remote/input` | Forward `{type:'mouse'|'text'|'key', …}` to the kiosk tab |
| `GET` | `/api/remote/stream` | SSE stream of kiosk screencast frames |

`POST /api/select` returns `200` with `skipped: true` when the kiosk tab is
already on that URL (no unnecessary reload), and `502` when the kiosk browser
is unreachable — the selection is still recorded and the TV self-heals as soon
as Chromium reconnects.

## Resilience

- **Chromium crashes / reboots**: systemd restarts it with `Restart=on-failure`
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
- **mDNS**: install `avahi-daemon` so `http://<hostname>.local:3000` works
  from a phone without remembering an IP.

## Security notes

- CDP is bound to **127.0.0.1** only, so only local processes can drive the
  browser tab.
- The control panel has **no authentication** — it is intended for a trusted,
  internal network only. If you expose it beyond that, put it behind a reverse
  proxy with auth (noted as a possible follow-up).
- The **remote control** streams the kiosk browser and forwards keystrokes, so
  anything typed on the panel (including PCO passwords) travels over the LAN.
  Keep the panel on a trusted network and off the public internet.
- The optional PCO API key is stored in the config file (root-owned under
  systemd) or read from an env var; it is never returned by the API.
