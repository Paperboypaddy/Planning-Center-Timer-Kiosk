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
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${KIOSK_DEST_DIR:-/opt/kiosk}"
CONFIG_DIR="${KIOSK_CONFIG_DIR:-/var/lib/kiosk}"
BROWSER_USER="${KIOSK_BROWSER_USER:-kiosk}"
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

echo "==> Writing systemd units"
sed -e "s|@DEST@|$DEST_DIR|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
    "$SRC_DIR/kiosk/kiosk-control.service" > /etc/systemd/system/kiosk-control.service

sed -e "s|@DEST@|$DEST_DIR|g" \
    -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
    -e "s|@BROWSER_USER@|$BROWSER_USER|g" \
    "$SRC_DIR/kiosk/kiosk-browser.service" > /etc/systemd/system/kiosk-browser.service

# The browser profile dir must be writable by the X session user.
if id "$BROWSER_USER" >/dev/null 2>&1; then
  chown -R "$BROWSER_USER":"$BROWSER_USER" "$CONFIG_DIR/chromium-profile" 2>/dev/null || true
fi

systemctl daemon-reload
systemctl enable --now kiosk-control.service

echo
echo "==> Done. Control server is running."
echo "    Control panel:   http://$(hostname).local:3000"
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
