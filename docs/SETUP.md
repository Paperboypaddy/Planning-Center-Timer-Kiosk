# Setup guide

Three things to get right on the real device, in order:

1. First-time Chromium login (so the PCO session survives reboots).
2. Find/verify the correct PCO live/countdown URL template.
3. Reach the control panel from a phone/laptop over mDNS.

Assumes you are running Armbian (Orange Pi Zero 3) or Raspberry Pi OS /
Debian/Ubuntu, with a graphical session that auto-logs-in a user (e.g.
`lightdm` autologin). Adjust user names and paths to your system.

---

## 0. Prerequisites

```bash
sudo apt update
sudo apt install -y nodejs npm chromium avahi-daemon x11-xserver-utils unclutter
```

Notes:

- Node.js needs to be **>= 18**. If your distro ships an older one, use
  NodeSource (`https://deb.nodesource.com`) or a `.tar.xz` from nodejs.org.
- The Chromium package is named `chromium` on Debian/Ubuntu/Armbian and was
  historically `chromium-browser` on Raspberry Pi OS. `launch-kiosk.sh`
  auto-detects, so the exact name doesn't matter.
- `x11-xserver-utils` provides `xset` (screen blanking control); `unclutter`
  hides the cursor. Both are optional (the launcher degrades gracefully).

## 1. Install the app and start the control server

```bash
cd planningcenter-timer-kiosk
sudo ./kiosk/install.sh
```

This installs to `/opt/kiosk`, creates `/var/lib/kiosk`, writes the two systemd
units, and starts `kiosk-control.service`. It does **not** start the browser
yet — that comes after the login step.

## 2. First-time Chromium login (one-time manual step)

The PCO session is a normal browser login cookie, kept alive in a persistent
Chromium profile. Because the TV has no keyboard or mouse, do it **from the
control panel's remote control** (recommended):

1. On your phone/laptop, open the control panel (step 5) → **Kiosk remote
   control → Start remote control**. The panel shows a live stream of the
   kiosk browser and navigates it to the PCO login page.
2. Tap the username/email field in the stream, then type in the **type bar**
   below the stream. Tap the password field, type, then press **Enter** on
   your keyboard (the type bar forwards it). If PCO uses 2FA, approve it on
   your phone as usual — the kiosk browser follows along.
3. When you reach the Services dashboard, tap **Stop**. The session cookie is
   now stored in the kiosk's own Chromium profile and survives reboots.

Alternative (manual, at the TV): with a keyboard/mouse temporarily attached,
run the login window directly:

```bash
sudo -u kiosk env KIOSK_PROFILE_DIR=/var/lib/kiosk/chromium-profile \
  /opt/kiosk/kiosk/launch-kiosk.sh --login
```

Log in, close the window, verify the cookie persisted:

```bash
sudo ls /var/lib/kiosk/chromium-profile/Default/Cookies
```

Do not log out later — logging out would clear the session. If the PCO session
expires, repeat the remote-control login (it takes 30 seconds).

## 3. Find and verify the correct PCO live/countdown URL template

The kiosk navigates Chromium to the live/countdown page for a specific plan.
The default template in this project is:

```
https://services.planningcenteronline.com/live/{serviceId}
```

It was confirmed against a real PCO account, but **verify it for yours**:

1. In the same browser you logged in with (or any logged-in browser), open the
   **Live** page for one of your upcoming services. In Planning Center
   Services, open a plan → the **Live** link/page.
2. Copy the resulting URL from the address bar. It should look like
   `https://services.planningcenteronline.com/live/90197325` where the number
   is the plan ID.
3. If it matches the default template, you're done. If it differs (different
   path, extra query params, a display-type segment), replace the `…/live/…`
   portion with your pattern and put `{serviceId}` where the plan ID goes.
4. Update it in the control panel (**Settings → URL template**) so it is used
   for new selections.

To confirm a constructed URL actually shows the countdown: create a service in
the control panel, select it, and check the TV. If you get an error page
instead of the countdown, log out and redo step 2 while watching the address
bar for the *exact* final URL.

## 4. Start the kiosk browser

```bash
sudo systemctl enable --now kiosk-browser.service
```

Chromium now runs fullscreen at `http://127.0.0.1:3000/nowplaying` (the idle
page) with CDP on `127.0.0.1:9222`. If it ever crashes, systemd restarts it
and the control server re-navigates it to the right page automatically.

## 5. Reach the control panel from a phone/laptop

`avahi-daemon` (installed in step 0) announces the device over mDNS, so the
panel is at:

```
http://<hostname>.local:3000
```

e.g. `http://orangepizero3.local:3000` or `http://raspberrypi.local:3000`.
Find the hostname with `hostname` on the device. The phone/laptop must be on
the **same Wi-Fi/LAN**.

If `.local` doesn't resolve (some Android/iOS edge cases), use the IP directly:
`ip -4 addr show` → open `http://<ip>:3000`.

## 6. Add services

Two ways:

**Manually** — on the control panel tap **+ Add service**, enter a friendly
name (e.g. "Sunday 9am") and the PCO plan ID (the number in the live URL for
that service). Display type is optional.

**Import from Planning Center (optional)** — paste your PCO API key in the
**Planning Center import** section, then *Load upcoming plans* and select the
ones to add. See the README for how to create the key.

To put a service on the TV: tap its button. To send the TV back to the idle
page: **Show idle page**.

## Raspberry Pi OS Lite (headless) setup

On a headless image there is no desktop to autologin into, so you must provide
an X server plus a bare session. The pieces we use (all in `kiosk/lightdm/`):

```bash
# Dependencies (add these to the apt line in step 0)
sudo apt install -y xorg lightdm matchbox-window-manager x11-xserver-utils

# 1) Autologin into a "kiosk" session as your console user
sudo cp kiosk/lightdm/50-kiosk-autologin.conf /etc/lightdm/lightdm.conf.d/
#    …and edit autologin-user to match your username (pi, raspi, …)

# 2) The session: a minimal window manager that keeps X alive. It also grants
#    the kiosk user X access so the systemd-launched Chromium can attach to :0
#    without lightdm's root-only Xauthority cookie.
sudo cp kiosk/lightdm/kiosk-session.sh /usr/local/bin/kiosk-session.sh
sudo cp kiosk/lightdm/kiosk.desktop /usr/share/xsessions/kiosk.desktop
sudo chmod +x /usr/local/bin/kiosk-session.sh

# 3) Boot into graphical mode so lightdm (and the browser unit) start
sudo systemctl set-default graphical.target
sudo reboot
```

Notes:

- `launch-kiosk.sh` now waits for the X server (`wait_for_x`) before starting
  Chromium, so `kiosk-browser.service` handles the boot race with lightdm
  cleanly instead of crash-looping.
- `matchbox-window-manager` keeps the X session alive; do **not** pass
  `-use_corner` to it (invalid option — it prints usage and exits, which ends
  the session and drops X back to the greeter).
- The `kiosk-browser.service` unit already sets `User=`/`XAUTHORITY=` — keep
  them pointing at your console user (see "Platform-specific tweaks").



## Troubleshooting

- **Control panel unreachable** → `systemctl status kiosk-control.service`,
  `journalctl -u kiosk-control -f`, check port 3000 and the `.local` name.
- **Kiosk shows blank/error** → the panel's status badge shows "kiosk offline"
  if CDP is disconnected. Check `systemctl status kiosk-browser.service` and
  that Chromium is running (`pgrep -a chromium`).
- **PCO session lost after reboot** → redo step 2, and make sure the kiosk is
  always launched with the same `KIOSK_PROFILE_DIR`.
- **"kiosk unreachable" when selecting** → the selection is still saved; the TV
  switches as soon as the browser reconnects. Fix the browser unit first.

## Platform-specific tweaks for the Orange Pi Zero 3

- The app logic itself is architecture-agnostic. Only the **launch layer**
  needs attention:
  - On Armbian the graphical autologin user is often `orangepi` or a custom
    `kiosk` user — set `KIOSK_BROWSER_USER` when running `install.sh` and keep
    `User=`/`XAUTHORITY=` in `kiosk-browser.service` in sync with your X session.
  - If Chromium renders via software rendering and you want the GPU, ensure the
    ARM GPU drivers are installed and check `chrome://gpu`; do not add
    `--disable-gpu` or other GPU-specific flags (see README "Platform notes").
