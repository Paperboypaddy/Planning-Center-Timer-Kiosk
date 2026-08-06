# Deployment & security checklist

Pre-flight guide before putting a kiosk on a church wall. Run both checklists
on the *exact* hardware (SBC + TV) you will support. Treat early installs as a
controlled pilot until that hardware is validated.

Related: [SETUP.md](SETUP.md) · [PLATFORMS.md](PLATFORMS.md)

---

## Security checklist

### Authentication

- [ ] A LAN client must log in to use the panel. Behind Caddy/HTTPS the app
      treats proxied requests as LAN traffic (trusts `X-Forwarded-For` only from
      a loopback peer; uses the rightmost entry). The kiosk window stays
      loopback-exempt on purpose.
- [ ] A forged `X-Forwarded-For: 127.0.0.1` from a LAN device is rejected for
      auth bypass (the proxy appends the real client IP last).
- [ ] Admin account created on first run with a **strong** password (8+ chars;
      change later under **Account**).
- [ ] Login rate limit works (5 failures / 60 s per IP → HTTP 429). Counters
      are in-memory and reset on server restart.
- [ ] Sessions are in-memory — every restart logs everyone out. Apply software
      updates over the LAN, from a separate device.
- [ ] Password is unique to this kiosk.

### Secrets & data at rest

- [ ] `config.json` is mode `0600` and owned by the control user (not root):
      `sudo ls -l /var/lib/kiosk/config.json`.
- [ ] PCO API key is treated as an on-device credential. Prefer
      `KIOSK_PCO_API_KEY`; use a **read-only** Services token. The key is never
      returned by the API. (Stored in plaintext in `config.json` when saved
      from the panel — the device is the trust boundary.)
- [ ] Backup `config.json` to a trusted location (services, admin hash, settings).

### Network exposure

- [ ] Panel is LAN-only behind HTTPS. Control server: `127.0.0.1:3001`. CDP:
      `127.0.0.1:9222`.
- [ ] Self-signed cert encrypts traffic; users accept a warning once per
      device. Pin/distribute the cert for stronger guarantees.
- [ ] Remote access uses **Tailscale** (ACL-isolated).
- [ ] Consider restricting `:443` at the router/guest VLAN to trusted devices.

### Privileges

- [ ] Control server runs unprivileged. Sudoers
      (`/etc/sudoers.d/kiosk-reboot`) only allow `systemctl reboot` and the
      update script. Verify: `sudo visudo -c` and review the file.
- [ ] Understand that **`kiosk/update.sh` runs as root**. It verifies SHA-256
      and version before install; a compromised GitHub
      account/repo/workflow remains the residual trust boundary.
- [ ] Review third-party installers used at setup (NodeSource apt key, optional
      Google Chrome / Tailscale vendor installs).

### Platform ownership

- [ ] Device is reserved for the kiosk. Installer binds `:443` and takes over
      the display (lightdm autologin). Use `KIOSK_PANEL_PORT` if 443 is taken.

### Wi-Fi (Raspberry Pi only)

- [ ] Wi-Fi section appears only on Pi hardware with NetworkManager (`nmcli`) —
      default on Raspberry Pi OS Bookworm+. Hidden elsewhere.
- [ ] Passwords go to NetworkManager only; nmcli errors are scrubbed. Note:
      password is briefly visible in `ps` while `nmcli` runs. Connecting can
      drop the panel's network — operator should be on-site or follow the new
      network.

### Updates

- [ ] Update progress bar works across the control-server restart
      (`update-state.json`); you must sign in again when it finishes.
- [ ] Failed updates turn the bar red and leave no half-applied state.

---

## Hardware acceptance checklist (pilot)

Run on the exact Raspberry Pi / SBC / Mini PC and TV after a fresh install:

- [ ] **Fresh install** — `sudo ./kiosk/install.sh` completes; both systemd
      units `active`; panel at `https://<hostname>.local`
- [ ] **Admin setup** — first-run account works; panel requires login from a
      phone (not only localhost)
- [ ] **Auth through the proxy** — from a LAN device, `/api/state` returns
      **401** before login; session cookie works through Caddy; forged
      `X-Forwarded-For: 127.0.0.1` cannot bypass auth
- [ ] **API key** — Planning Center section shows connected; load upcoming
      plans succeeds
- [ ] **Plan selection** — add/import a plan, tap it, TV shows `/display`
- [ ] **Live countdown** — with LIVE running (or a future plan time), clock
      matches expected remaining/scheduled time
- [ ] **TV power (CEC)** — on / off / status work from the panel
- [ ] **Auto-on** — with a PCO API key, TV powers on before the next
      service/rehearsal
- [ ] **Reboot schedule** — cron a few minutes ahead; device reboots on time
- [ ] **Wi-Fi** (Pi + NetworkManager) — section appears; scan + WPA2 connect
      works; Show/Hide behaves
- [ ] **Crash recovery** — kill Chromium; systemd restarts it; TV returns to
      the active plan display
- [ ] **Server restart** — restart `kiosk-control`; kiosk re-syncs from
      `config.json`
- [ ] **Software update** — on staging, publish a release; `update.sh`
      downloads, verifies checksum, reinstalls; live progress bar; with
      **Include prereleases** on, applying a beta installs that beta

Log results per commissioned device so future pilots start from a known-good
baseline.

---

## Support boundaries for a pilot

> [!IMPORTANT]
> The countdown depends on Planning Center's **Services Live API** and plan
> timing fields. Watch for API or LIVE workflow changes when validating a new
> season.

- CEC behavior varies by TV / HDMI adapter; test on the actual display.
- Treat first deployments as **supported pilots** with clear on-call
  boundaries.
- Collect logs before expanding sites:
  `journalctl -u kiosk-control` · `journalctl -u kiosk-browser`
