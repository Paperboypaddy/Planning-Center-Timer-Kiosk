# Setup guide

Get a kiosk running on real hardware in this order:

1. Install
2. Add a Planning Center API key
3. Start the kiosk browser
4. Reach the control panel
5. Add plans and select one for the TV

Assumes Raspberry Pi OS, Debian, or Ubuntu on **arm64 or amd64** with a display
attached. For NixOS (Cage/Wayland), use
[PLATFORMS.md](PLATFORMS.md#nixos-declarative-cagewayland) instead.

---

## Prerequisites

`kiosk/install.sh` installs system packages for you (X, lightdm, Chromium,
Node.js ≥ 18, avahi, cec-utils, Caddy, optional Tailscale). You only need a
supported OS and an attached TV.

To pre-install manually:

```bash
sudo apt update
sudo apt install -y nodejs chromium xorg lightdm x11-xserver-utils unclutter \
  matchbox-window-manager xauth avahi-daemon cec-utils
```

> [!NOTE]
> **Ubuntu** ships Chromium as a snap, so `install.sh` uses **Google Chrome**
> there. Debian / Raspberry Pi OS get the `chromium` package. The launcher
> auto-detects the binary. Node must be ≥ 18; the installer upgrades older
> distro Node to 20 LTS.

---

## 1. Install

```bash
git clone https://github.com/Paperboypaddy/Planning-Center-Timer-Kiosk.git
cd Planning-Center-Timer-Kiosk
sudo ./kiosk/install.sh
```

This installs to `/opt/kiosk`, creates `/var/lib/kiosk`, sets up the lightdm
kiosk session, builds the React control panel, starts the control-server and
browser units, configures Caddy (HTTPS on :443), and optionally Tailscale.
Create the admin account on first panel visit.

---

## 2. Planning Center API key

The TV countdown and plan import use the Services API (and Live endpoints).

1. Create a **read-only** personal access token (or `app_id:secret`) in Planning
   Center with access to Services.
2. Open the control panel → **Planning Center** → paste the key → **Save**,
   or set `KIOSK_PCO_API_KEY` in the service environment (preferred on a
   device). In development, a repo-root `.env` with `KIOSK_PCO_API_KEY=…` is
   loaded automatically when you start the server.
3. Use **Load upcoming plans** to import, or add a plan ID manually.

An operator still starts **LIVE** from their phone in Planning Center Services.
The kiosk only reads Live state for the selected plan.

---

## 3. Start the kiosk browser

```bash
sudo systemctl enable --now kiosk-browser.service
```

Chromium runs fullscreen at `http://127.0.0.1:3001/nowplaying` with CDP on
`127.0.0.1:9222`. On crash, systemd restarts it and the control server
re-navigates automatically. Selecting a plan opens `/display`.

---

## 4. Reach the control panel

With `avahi-daemon` installed, open:

```text
https://<hostname>.local
```

Examples: `https://raspberrypi.local`, `https://orangepizero3.local`. Same
Wi-Fi/LAN required. Accept the self-signed cert warning once per device.

On first visit, **Create admin account** (username + password, 8+ characters).
Afterwards it's a normal login. Change the password under **Account**.

If `.local` does not resolve (some phones), use the IP from `ip -4 addr show`:
`https://<ip>`.

### Optional: Tailscale

Say yes during install, or run with `KIOSK_TAILSCALE=yes`:

```bash
sudo tailscale up          # authenticate via the printed link
```

Then reach the panel from your tailnet at `https://<machine-name>.ts.net`
(same login, same cert warning). Local LAN access is unchanged.

---

## 5. Add plans

| Method | How |
| --- | --- |
| **Import** | API key → **Load upcoming plans** → select → **Add selected** |
| **Manual** | Add a friendly name + PCO plan ID |

Tap a plan to put it on the TV (`/display`). **Show idle page** returns to
`/nowplaying`.

Confirm an operator has started LIVE (or that a future plan time exists) so
the clock has data to show.

---

## Raspberry Pi OS Lite (headless)

Headless images need an X session. Pieces live under `kiosk/lightdm/`:

```bash
sudo apt install -y xorg lightdm matchbox-window-manager x11-xserver-utils

# Autologin into the kiosk session (edit autologin-user to match)
sudo cp kiosk/lightdm/50-kiosk-autologin.conf /etc/lightdm/lightdm.conf.d/

# Minimal session + X access for the systemd Chromium unit
sudo cp kiosk/lightdm/kiosk-session.sh /usr/local/bin/kiosk-session.sh
sudo cp kiosk/lightdm/kiosk.desktop /usr/share/xsessions/kiosk.desktop
sudo chmod +x /usr/local/bin/kiosk-session.sh

sudo systemctl set-default graphical.target
sudo reboot
```

- `launch-kiosk.sh` waits for X before starting Chromium (avoids boot races).
- Keep `User=` / `XAUTHORITY=` in `kiosk-browser.service` aligned with the
  console user.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Panel unreachable | `systemctl status caddy kiosk-control`, `journalctl -u caddy -f`, `.local` name, Caddy on :443 |
| Blank / idle on TV | Select a plan; panel status badge; `systemctl status kiosk-browser.service` |
| Clock stuck / no Live data | API key configured; operator started LIVE; plan `serviceTypeId` matches PCO |
| "kiosk unreachable" on select | Selection is still saved — fix the browser unit; TV catches up on reconnect |

---

## Orange Pi Zero 3 notes

App logic is architecture-agnostic. Only the launch layer needs care:

- Set `KIOSK_BROWSER_USER` when running `install.sh` so it matches the
  graphical autologin user (`orangepi`, custom `kiosk`, …). Keep
  `User=` / `XAUTHORITY=` in sync.
- Prefer GPU drivers + `chrome://gpu` over adding `--disable-gpu` — see README
  platform notes.
