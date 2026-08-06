# Deployment & security checklist

A practical, pre-flight guide for putting the kiosk on a church's wall. Run
through both checklists before handing a device to a congregation — and again
on the *exact* hardware (SBC + TV) you intend to support. This project is
suited to a controlled pilot, not an unattended public deployment, until you
have validated it on your target hardware.

Related: [SETUP.md](SETUP.md) (step-by-step install), [PLATFORMS.md](PLATFORMS.md)
(per-platform feature matrix).

---

## Security checklist

**Authentication**

- [ ] Confirm a LAN client **cannot** use the panel without logging in. Behind
      the Caddy/HTTPS proxy the app correctly treats proxied requests as LAN
      traffic (it only trusts `X-Forwarded-For` from a loopback peer and takes
      the rightmost entry the proxy saw). The kiosk window and local control
      remain loopback-exempt on purpose.
- [ ] Create the admin account on first run with a **strong** password
      (8+ characters; change it later under **Settings → Change password**).
- [ ] Login is rate-limited (5 failures / 60 s per client IP → HTTP 429).
      Lockouts clear themselves after the window expires.
- [ ] Choose a password that is not shared with any other system.

**Secrets & data at rest**

- [ ] `config.json` is written `0600` and owned by the control user (not
      root). Verify: `sudo ls -l /var/lib/kiosk/config.json`.
- [ ] The **PCO API key is stored in plaintext** in `config.json` — the device
      is the trust boundary. Prefer the `KIOSK_PCO_API_KEY` environment
      variable, create a personal access token scoped to **read-only**
      Services, and treat the key like any on-device credential. It is never
      returned by the API.
- [ ] Back up `config.json` and the Chromium profile directory (services,
      admin hash, PCO session) — e.g. a nightly copy to a trusted location.

**Network exposure**

- [ ] The panel is LAN-only behind HTTPS. The control server itself binds to
      `127.0.0.1:3001`; CDP binds to `127.0.0.1:9222` only.
- [ ] The certificate is self-signed — users must accept a browser warning
      once per device. Do not rely on this for a public/cloud deployment.
- [ ] If the panel must be reachable beyond the building, use **Tailscale**
      (an ACL-isolated tailnet) rather than port-forwarding.
- [ ] Consider restricting `:443` at the network level (router/guest VLAN) so
      only trusted devices can reach the panel.

**Privileges**

- [ ] The control server runs as an unprivileged user. Its only sudo grants
      (in `/etc/sudoers.d/kiosk-reboot`) are `systemctl reboot` and the update
      script. Verify after install: `sudo visudo -c` and review the file.
- [ ] The **update script runs as root** (`kiosk/update.sh`). It now verifies
      the release tarball's SHA-256 checksum and its version tag before
      extracting/reinstalling, but it still downloads and executes code from
      GitHub — review what the installer fetches (NodeSource, Google Chrome,
      Tailscale) and treat the repository as trusted.

**Platform ownership**

- [ ] The installer binds HTTPS on **port 443** by default and sets up the
      lightdm autologin kiosk session — it takes over that port and the
      display. Use `KIOSK_PANEL_PORT` if 443 is taken, and reserve this device
      for the kiosk.

**Wi-Fi (Raspberry Pi only)**

- [ ] The panel's **Wi-Fi** section only appears on Raspberry Pi hardware with
      **NetworkManager** (`nmcli`) installed — the default on Raspberry Pi OS
      Bookworm+. On other boards, Windows, and macOS it is hidden.
- [ ] Wi-Fi passwords are passed straight to NetworkManager and are never
      stored by the kiosk or echoed back. Connecting can drop the panel's own
      network (e.g. switching from Ethernet to Wi-Fi) — the operator should be
      on-site or on a device that follows the kiosk's new network.

**Updates**

- [ ] Applying an update shows a **progress bar** fed by the update script's
      state file (`update-state.json` next to `config.json`). The control
      server restarts mid-update, so you'll be asked to sign in again when it
      finishes — sessions are in-memory and do not survive the restart.
- [ ] If an update fails, the bar turns red with the reason and the panel
      returns to normal (no half-applied state is left behind).

---

## Hardware acceptance checklist (pilot)

Run on the *exact* Raspberry Pi/SBC/Mini PC and TV you will deploy, after a
fresh install:

1. **Fresh install** — `sudo ./kiosk/install.sh` completes; both systemd
   units are `active`; panel reachable at `https://<hostname>.local`.
2. **Admin setup** — first-run "Create admin account" works; the panel
   requires login from a phone (not just localhost).
3. **PCO login** — "Kiosk remote control → Start" streams the kiosk; complete
   the PCO login from the phone.
4. **Session persistence** — reboot the device; the kiosk is still logged in
   to Planning Center.
5. **Service selection** — add a service, tap it, confirm the TV navigates to
   the live/countdown page.
6. **Display type & theme** — apply a display type and a dark theme; confirm
   they stick on the TV and persist for the plan.
7. **TV power (CEC)** — TV on / TV off / status all work from the panel.
8. **Auto-on** — with a PCO API key, confirm the TV powers on before the next
   service/rehearsal time.
9. **Reboot schedule** — set a cron a few minutes ahead; confirm the device
   reboots at the scheduled time.
9b. **Wi-Fi** (Pi with NetworkManager) — the section appears; a scan finds
   networks; connecting to a WPA2 network with the password works and the
   Show/Hide toggle behaves; the section is hidden on Windows/macOS.
10. **Crash recovery** — kill the Chromium process; confirm systemd restarts it
    and the TV returns to the active service without manual steps.
11. **Server restart** — restart `kiosk-control`; the kiosk re-syncs from
    `config.json`.
12. **Software update** — on a staging box, publish a release and confirm
    `update.sh` downloads, verifies the checksum, reinstalls, and comes back
    healthy, with the panel showing a live progress bar throughout.

Log the results for each device you commission so future pilots start from a
known-good baseline.

---

## Support boundaries for a pilot

- The kiosk depends on **Planning Center's live URL pattern and live-controller
  DOM** (layout/theme selectors) — both can change without notice. Monitor the
  panel's best-effort "apply" warnings.
- CEC behavior varies by TV/HDMI adapter; test on the actual TV.
- Treat the first deployments as **supported pilots** with explicit on-call
  boundaries, and collect logs (`journalctl -u kiosk-control`,
  `journalctl -u kiosk-browser`) before adding more sites.
