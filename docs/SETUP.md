# Setup guide

Three things to get right on the real device, in order:

1. First-time Chromium login (so the PCO session survives reboots).
2. Find/verify the correct PCO live/countdown URL template.
3. Reach the control panel from a phone/laptop over mDNS.

Assumes Raspberry Pi OS, Debian, or Ubuntu on **arm64 or amd64** (SBCs like
the Orange Pi Zero 3 / Raspberry Pi, or x86 Mini PCs) with a display attached
for the kiosk. Adjust user names and paths to your system.

---

## 0. Prerequisites

`kiosk/install.sh` installs all system packages for you (X server, lightdm,
Chromium, Node.js >= 18, avahi, cec-utils, Caddy, and optionally Tailscale).
The only real requirement is a supported OS and an attached display/TV for the
kiosk browser.

If you prefer to pre-install manually, the packages install.sh needs are:

```bash
sudo apt update
sudo apt install -y nodejs chromium xorg lightdm x11-xserver-utils unclutter \
  matchbox-window-manager xauth avahi-daemon cec-utils
```

Notes:

- **Ubuntu** ships Chromium as a snap wrapper (a poor fit for a kiosk), so
  install.sh uses **Google Chrome** there instead; Debian/Raspberry Pi OS get
  the real `chromium` package. The launcher auto-detects the binary name.
- Node.js needs to be **>= 18**; install.sh upgrades an old distro Node to
  Node 20 LTS automatically.

## 1. Install everything

```bash
cd planningcenter-timer-kiosk
sudo ./kiosk/install.sh
```

This installs to `/opt/kiosk`, creates `/var/lib/kiosk`, installs the X
display stack with a lightdm autologin kiosk session, writes and starts the
two systemd units (control server + kiosk browser), sets up Caddy (HTTPS +
Basic Auth on port 443), prints the panel login, and optionally sets up
Tailscale. When it asks about Tailscale, answer as you like — it's only for
remote access; the panel works on the local network either way.

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

Chromium now runs fullscreen at `http://127.0.0.1:3001/nowplaying` (the idle
page) with CDP on `127.0.0.1:9222`. If it ever crashes, systemd restarts it
and the control server re-navigates it to the right page automatically.

## 5. Reach the control panel from a phone/laptop

`avahi-daemon` (installed in step 0) announces the device over mDNS, so the
panel is at:

```
https://<hostname>.local
```

e.g. `https://orangepizero3.local` or `https://raspberrypi.local`.
Find the hostname with `hostname` on the device. The phone/laptop must be on
the **same Wi-Fi/LAN**.

The panel is served through **Caddy** with HTTPS (self-signed certificate) and
**HTTP Basic Auth**. The username/password were printed at install time
(user/pass shown by `kiosk/install.sh`). On first visit each device will warn
about the self-signed certificate — accept it once, then your browser
remembers both the exception and the login.

On the **Windows single-file app**, the panel password is generated on first
run (`%APPDATA%\Planning Center Kiosk\panel-login.txt`) and can be changed
any time from the panel: **Settings → Change panel password**. (On Linux the
login is the one set up by `install.sh`/Caddy.)

If `.local` doesn't resolve (some Android/iOS edge cases), use the IP directly:
`ip -4 addr show` → open `https://<ip>`.

### Remote access (Tailscale, optional)

The installer can install and set up Tailscale (say yes when it prompts, or
run with `KIOSK_TAILSCALE=yes`). The panel remains available on the local
wifi/ethernet network exactly as above; Tailscale just lets you reach the Pi
remotely. After the installer finishes:

```bash
sudo tailscale up          # open the printed link to authenticate
ssh raspi@<tailnet-ip>     # or add --ssh for Tailscale's managed SSH
```

Once connected, the panel is also reachable from your tailnet at
`https://<machine-name>.ts.net` (same login, self-signed-cert warning).

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

- **Control panel unreachable** → `systemctl status caddy kiosk-control`,
  `journalctl -u caddy -f`, check Caddy on :443 and the `.local` name; the
  control server itself is on 127.0.0.1:3001.
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
