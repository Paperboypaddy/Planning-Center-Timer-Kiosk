#!/usr/bin/env bash
# Install the kiosk control stack to /opt/kiosk and wire up the systemd units.
#
# Prerequisites (see docs/SETUP.md):
#   - Node.js >= 18
#   - a Chromium browser (chromium / chromium-browser / google-chrome)
#   - an X session with autologin for the kiosk (ARM boards often use lightdm
#     autologin; a headless VM needs an X server for the browser unit)
#   - avahi-daemon (for http://<hostname>.local:3000)
#
# Adjust with env vars:
#   KIOSK_DEST_DIR       install location        (default /opt/kiosk)
#   KIOSK_CONFIG_DIR     config + profile dir    (default /var/lib/kiosk)
#   KIOSK_BROWSER_USER   user owning X session   (default kiosk)
#   KIOSK_CONTROL_USER   control server user     (default kiosk)
set -euo pipefail

# Project root (parent of this script's directory: .../kiosk/install.sh).
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${KIOSK_DEST_DIR:-/opt/kiosk}"
CONFIG_DIR="${KIOSK_CONFIG_DIR:-/var/lib/kiosk}"
BROWSER_USER="${KIOSK_BROWSER_USER:-kiosk}"
CONTROL_USER="${KIOSK_CONTROL_USER:-kiosk}"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "error: Node.js not found. Install Node.js >= 18 first." >&2
  exit 1
fi

echo "==> Installing app files to $DEST_DIR"
mkdir -p "$DEST_DIR" "$CONFIG_DIR"
cp -r "$SRC_DIR/server" "$SRC_DIR/public" "$SRC_DIR/kiosk" "$SRC_DIR/docs" \
      "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$DEST_DIR"

echo "==> Installing npm dependencies"
( cd "$DEST_DIR" && npm install --omit=dev --no-audit --no-fund )

# The control server must run as an unprivileged user (never root). Create it
# if it doesn't exist and grant exactly the permissions it needs.
if ! id -u "$CONTROL_USER" >/dev/null 2>&1; then
  echo "==> Creating control user '$CONTROL_USER'"
  useradd --system --shell /usr/sbin/nologin "$CONTROL_USER"
fi

# CEC (cec-utils) reads /dev/cec0, usually 660 root:video.
usermod -aG video "$CONTROL_USER" 2>/dev/null || true

# Narrow sudo grant so the scheduler can reboot, and nothing else.
printf '%s\n' "$CONTROL_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot" \
  > /etc/sudoers.d/kiosk-reboot
chmod 440 /etc/sudoers.d/kiosk-reboot
visudo -c >/dev/null 2>&1 && echo "==> sudoers entry for '$CONTROL_USER' reboot validated"

echo "==> Writing systemd units"
sed -e "s|@DEST@|$DEST_DIR|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
    -e "s|@CONTROL_USER@|$CONTROL_USER|g" \
    "$SRC_DIR/kiosk/kiosk-control.service" > /etc/systemd/system/kiosk-control.service

sed -e "s|@DEST@|$DEST_DIR|g" \
    -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
    -e "s|@BROWSER_USER@|$BROWSER_USER|g" \
    "$SRC_DIR/kiosk/kiosk-browser.service" > /etc/systemd/system/kiosk-browser.service

# The config file belongs to the control user; the browser profile belongs to
# the browser (X session) user.
chown -R "$CONTROL_USER":"$CONTROL_USER" "$CONFIG_DIR" 2>/dev/null || true
if [[ "$BROWSER_USER" != "$CONTROL_USER" ]]; then
  if id "$BROWSER_USER" >/dev/null 2>&1; then
    chown -R "$BROWSER_USER":"$BROWSER_USER" "$CONFIG_DIR/chromium-profile" 2>/dev/null || true
  fi
fi

systemctl daemon-reload
systemctl enable kiosk-control.service
# Always (re)start so a fresh unit (e.g. a new User=) takes effect even when
# the service was already running.
systemctl restart kiosk-control.service

# --- Panel access: Caddy reverse proxy with HTTPS + Basic Auth ---
# The control server binds to 127.0.0.1 only, so the panel is NOT exposed in
# the clear. Caddy serves it on the LAN over HTTPS with a shared login.
# The kiosk browser keeps using http://127.0.0.1:3001 directly (localhost,
# no proxy, no auth).
PANEL_USER="${KIOSK_PANEL_USER:-kiosk}"
if [[ -z "${KIOSK_PANEL_PASSWORD:-}" ]]; then
  PANEL_PASSWORD="$(openssl rand -base64 18 2>/dev/null | tr -d '/+=' | head -c 20 || true)"
fi
PANEL_PASSWORD="${KIOSK_PANEL_PASSWORD:-${PANEL_PASSWORD:-changeme}}"

if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy"
  curl -fsSL -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    https://dl.cloudsmith.io/public/caddy/stable/gpg.key
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

PANEL_HASH="$(caddy hash-password --plaintext "$PANEL_PASSWORD")"

# Self-signed certificate (valid 10 years) covering the mDNS name, localhost,
# and the current LAN IP. A bare ":3000" site with `tls internal` does not get
# automatic HTTPS, so we provide explicit cert files.
PANEL_HOST="$(hostname).local"
PANEL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout /etc/caddy/kiosk-key.pem -out /etc/caddy/kiosk-cert.pem \
  -subj "/CN=$PANEL_HOST" \
  -addext "subjectAltName=DNS:$PANEL_HOST,DNS:localhost,IP:127.0.0.1,IP:$PANEL_IP" \
  >/dev/null 2>&1

cat > /etc/caddy/Caddyfile <<EOF
:3000 {
    tls /etc/caddy/kiosk-cert.pem /etc/caddy/kiosk-key.pem
    basic_auth {
        $PANEL_USER $PANEL_HASH
    }
    reverse_proxy 127.0.0.1:3001 {
        flush_interval -1
    }
}
EOF
systemctl enable caddy
systemctl restart caddy

echo
echo "==> Done. Control server is running (localhost only)."
echo "    Control panel:   https://$(hostname).local:3000"
echo "    Panel login:     user: $PANEL_USER"
echo "    Panel password:  $PANEL_PASSWORD"
echo "    (the panel uses a self-signed certificate - accept the browser"
echo "     warning once per device, and your browser remembers the login)"
echo
echo "==> Next steps (see $DEST_DIR/docs/SETUP.md for details):"
echo
echo "  1) One-time PCO login (as the $BROWSER_USER user, in the X session):"
echo "     sudo -u $BROWSER_USER env KIOSK_PROFILE_DIR=$CONFIG_DIR/chromium-profile \\"
echo "          $DEST_DIR/kiosk/launch-kiosk.sh --login"
echo "     Log in to Planning Center in the window, then close it."
echo
echo "  2) Start the kiosk browser:"
echo "     systemctl enable --now kiosk-browser.service"
echo
echo "  3) Add your services at the control panel."
