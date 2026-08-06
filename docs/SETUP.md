# Setup guide

Get a kiosk running on real hardware in this order:

1. Install
2. Log in to Planning Center (once)
3. Verify the live URL template
4. Reach the control panel
5. Add services

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
> **Ubuntu** ships Chromium as a snap (awkward for kiosks), so `install.sh`
> uses **Google Chrome** there. Debian / Raspberry Pi OS get the real
> `chromium` package. The launcher auto-detects the binary. Node must be ≥ 18;
> the installer upgrades older distro Node to 20 LTS.

---

## 1. Install

```bash
git clone https://github.com/Paperboypaddy/Planning-Center-Timer-Kiosk.git
cd Planning-Center-Timer-Kiosk
sudo ./kiosk/install.sh
```

This installs to `/opt/kiosk`, creates `/var/lib/kiosk`, sets up the lightdm
kiosk session, starts the control-server and browser units, configures Caddy
(HTTPS on :443), and optionally Tailscale. Create the admin account on first
panel visit.

---

## 2. First-time Planning Center login

The PCO session is a normal browser cookie in a persistent Chromium profile.
Because the TV has no keyboard, use the panel's **remote control**:

1. Open the control panel (step 5) → **Kiosk remote control** → **Start remote
   control**.
2. Tap fields in the stream and type in the **type bar** below it. Use
   **Enter** on your keyboard when ready. Approve 2FA on your phone as usual.
3. When you reach the Services dashboard, tap **Stop**. The cookie is now in
   the kiosk profile and survives reboots.

<details>
<summary>Alternative: log in at the TV with a temporary keyboard</summary>

```bash
sudo -u kiosk env KIOSK_PROFILE_DIR=/var/lib/kiosk/chromium-profile \
  /opt/kiosk/kiosk/launch-kiosk.sh --login
```

Log in, close the window, then verify:

```bash
sudo ls /var/lib/kiosk/chromium-profile/Default/Cookies
```

</details>

> [!WARNING]
> Do not log out of Planning Center in the kiosk browser — that clears the
> session. If it expires, repeat the remote-control login (~30 seconds).

---

## 3. Verify the live URL template

Default template:

```text
https://services.planningcenteronline.com/live/{serviceId}
```

Confirm it for your account:

1. Open the **Live** page for an upcoming plan in Planning Center Services.
2. Copy the URL — e.g. `https://services.planningcenteronline.com/live/90197325`.
3. If it matches the default, you're done. Otherwise put `{serviceId}` where
   the plan ID goes and update **Settings → URL template**.
4. Create a service in the panel, select it, and confirm the TV shows the
   countdown.

> [!NOTE]
> Display type / theme application clicks Planning Center's live-controller
> DOM (`.LiveToolbar-control`, `.theme-toggle-switch`). Those selectors can
> change without notice. Failures are best-effort — selection still succeeds.
> See `setDisplayType` / `setTheme` in `server/kiosk.js`.

---

## 4. Start the kiosk browser

```bash
sudo systemctl enable --now kiosk-browser.service
```

Chromium runs fullscreen at `http://127.0.0.1:3001/nowplaying` with CDP on
`127.0.0.1:9222`. On crash, systemd restarts it and the control server
re-navigates automatically.

---

## 5. Reach the control panel

With `avahi-daemon` installed, open:

```text
https://<hostname>.local
```

Examples: `https://raspberrypi.local`, `https://orangepizero3.local`. Same
Wi-Fi/LAN required. Accept the self-signed cert warning once per device.

On first visit, **Create admin account** (username + password, 8+ characters).
Afterwards it's a normal login. Change the password under **Settings → Change
password**.

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

## 6. Add services

| Method | How |
| --- | --- |
| **Manual** | **+ Add service** → friendly name + PCO plan ID |
| **Import** | Paste a PCO API key → **Load upcoming plans** → select |

Tap a service to put it on the TV. **Show idle page** returns to `/nowplaying`.

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
- Do **not** pass `-use_corner` to `matchbox-window-manager` (invalid; ends
  the session).
- Keep `User=` / `XAUTHORITY=` in `kiosk-browser.service` aligned with the
  console user.

---

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Panel unreachable | `systemctl status caddy kiosk-control`, `journalctl -u caddy -f`, `.local` name, Caddy on :443 |
| Blank / error on TV | Panel status badge; `systemctl status kiosk-browser.service`; `pgrep -a chromium` |
| PCO session gone after reboot | Redo step 2; confirm the same `KIOSK_PROFILE_DIR` |
| "kiosk unreachable" on select | Selection is still saved — fix the browser unit; TV catches up on reconnect |

---

## Orange Pi Zero 3 notes

App logic is architecture-agnostic. Only the launch layer needs care:

- Set `KIOSK_BROWSER_USER` when running `install.sh` so it matches the
  graphical autologin user (`orangepi`, custom `kiosk`, …). Keep
  `User=` / `XAUTHORITY=` in sync.
- Prefer GPU drivers + `chrome://gpu` over adding `--disable-gpu` — see README
  platform notes.
