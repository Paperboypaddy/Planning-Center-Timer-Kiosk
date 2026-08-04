#!/usr/bin/env bash
# One-shot installer for the Planning Center kiosk controller.
#
# Targets Raspberry Pi OS, Debian, and Ubuntu on arm64 or amd64 (SBCs and
# Mini PCs). Installs everything: system packages, the X/lightdm kiosk
# session, the control server, Caddy (HTTPS + Basic Auth), and optionally
# Tailscale for remote access.
#
# Usage:  sudo ./kiosk/install.sh
#
# Env overrides:
#   KIOSK_DEST_DIR           install location          (default /opt/kiosk)
#   KIOSK_CONFIG_DIR         config + profile dir      (default /var/lib/kiosk)
#   KIOSK_BROWSER_USER       X session (browser) user  (default kiosk)
#   KIOSK_CONTROL_USER       control server user       (default kiosk)
#   KIOSK_PANEL_USER         panel login username      (default kiosk)
#   KIOSK_PANEL_PASSWORD     panel login password      (default: random)
#   KIOSK_TAILSCALE          "yes"/"no" Tailscale      (default: prompt)
#   KIOSK_TAILSCALE_AUTHKEY  Tailscale auth key        (optional)
#   KIOSK_SKIP_PACKAGES      "1" skip apt installs     (pre-provisioned boxes)
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${KIOSK_DEST_DIR:-/opt/kiosk}"
CONFIG_DIR="${KIOSK_CONFIG_DIR:-/var/lib/kiosk}"
BROWSER_USER="${KIOSK_BROWSER_USER:-kiosk}"
CONTROL_USER="${KIOSK_CONTROL_USER:-kiosk}"
NODE_BIN=""

# --- OS / architecture support ------------------------------------------------
if [[ ! -f /etc/os-release ]]; then
  echo "error: cannot detect the OS (/etc/os-release missing). Debian/Ubuntu only." >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  debian|ubuntu|raspbian) ;;
  *)
    echo "error: only Debian and Ubuntu are supported (found '${ID:-unknown}')." >&2
    exit 1
    ;;
esac
ARCH="$(dpkg --print-architecture 2>/dev/null || echo unknown)"
case "$ARCH" in
  amd64|arm64) ;;
  *)
    echo "error: unsupported architecture '$ARCH' (amd64/arm64 only)." >&2
    exit 1
    ;;
esac
echo "==> Installing on ${PRETTY_NAME:-$ID} ($ARCH)"

# --- System packages ----------------------------------------------------------
if [[ "${KIOSK_SKIP_PACKAGES:-}" != "1" ]]; then
  echo "==> Installing system packages (this can take a while)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates git \
    xorg lightdm xinit x11-xserver-utils unclutter \
    matchbox-window-manager xauth avahi-daemon \
    || { echo "error: failed to install X/kiosk packages" >&2; exit 1; }

  # Node.js (>= 18 required). Use the distro package if it's new enough,
  # otherwise install Node 20 LTS via NodeSource.
  apt-get install -y -qq nodejs 2>/dev/null || true
  if ! node --version 2>/dev/null | grep -qE '^v(1[89]|[2-9][0-9])\.'; then
    echo "==> Distro Node.js too old; installing Node 20 LTS via NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  fi
  NODE_BIN="$(command -v node || true)"

  # Chromium. On Ubuntu the apt 'chromium' is a snap wrapper (poor fit for a
  # kiosk), so use Google Chrome there; Debian/Raspberry Pi OS ship real
  # chromium.
  if [[ "$ID" == "ubuntu" ]]; then
    if ! command -v google-chrome-stable >/dev/null 2>&1; then
      echo "==> Installing Google Chrome ($ARCH)"
      curl -fsSL -o /tmp/google-chrome.deb \
        "https://dl.google.com/linux/direct/google-chrome-stable_current_${ARCH}.deb"
      apt-get install -y -qq /tmp/google-chrome.deb
    fi
  else
    apt-get install -y -qq chromium
  fi

  # HDMI-CEC for TV power control.
  apt-get install -y -qq cec-utils || true
fi

[[ -n "$NODE_BIN" ]] || NODE_BIN="$(command -v node || echo /usr/bin/node)"
if [[ ! -x "$NODE_BIN" ]]; then
  echo "error: Node.js not found after install. Install Node.js >= 18 first." >&2
  exit 1
fi
if ! command -v chromium chromium-browser google-chrome google-chrome-stable >/dev/null 2>&1; then
  echo "error: no Chromium/Chrome browser found after install." >&2
  exit 1
fi

# --- App files -----------------------------------------------------------------
echo "==> Installing app files to $DEST_DIR"
mkdir -p "$DEST_DIR" "$CONFIG_DIR"
cp -r "$SRC_DIR/server" "$SRC_DIR/public" "$SRC_DIR/kiosk" "$SRC_DIR/docs" \
      "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$DEST_DIR"

echo "==> Installing npm dependencies"
( cd "$DEST_DIR" && npm install --omit=dev --no-audit --no-fund )

# --- Users ---------------------------------------------------------------------
# Control server: unprivileged user (never root); reboot is delegated via a
# narrow sudoers entry below.
if ! id -u "$CONTROL_USER" >/dev/null 2>&1; then
  echo "==> Creating control user '$CONTROL_USER'"
  useradd --system --shell /usr/sbin/nologin "$CONTROL_USER"
fi
# Browser / X session user (created with a home so XAUTHORITY paths work).
if ! id -u "$BROWSER_USER" >/dev/null 2>&1; then
  echo "==> Creating browser user '$BROWSER_USER'"
  useradd -m -s /bin/bash "$BROWSER_USER"
fi

# CEC (cec-utils) reads /dev/cec0, usually 660 root:video.
usermod -aG video "$CONTROL_USER" 2>/dev/null || true

# Narrow sudo grant so the scheduler can reboot, and nothing else.
printf '%s\n' "$CONTROL_USER ALL=(root) NOPASSWD: /usr/bin/systemctl reboot" \
  > /etc/sudoers.d/kiosk-reboot
chmod 440 /etc/sudoers.d/kiosk-reboot
visudo -c >/dev/null 2>&1 && echo "==> sudoers entry for '$CONTROL_USER' reboot validated"

# --- systemd units -------------------------------------------------------------
echo "==> Writing systemd units"
sed -e "s|@DEST@|$DEST_DIR|g" -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" -e "s|@CONTROL_USER@|$CONTROL_USER|g" \
    "$SRC_DIR/kiosk/kiosk-control.service" > /etc/systemd/system/kiosk-control.service

sed -e "s|@DEST@|$DEST_DIR|g" -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
    -e "s|@BROWSER_USER@|$BROWSER_USER|g" \
    "$SRC_DIR/kiosk/kiosk-browser.service" > /etc/systemd/system/kiosk-browser.service

# Config file belongs to the control user; the browser profile to the browser
# (X session) user.
chown -R "$CONTROL_USER":"$CONTROL_USER" "$CONFIG_DIR" 2>/dev/null || true
if [[ "$BROWSER_USER" != "$CONTROL_USER" ]]; then
  chown -R "$BROWSER_USER":"$BROWSER_USER" "$CONFIG_DIR/chromium-profile" 2>/dev/null || true
fi

# --- X / lightdm autologin kiosk session ---------------------------------------
echo "==> Setting up the lightdm kiosk session"
mkdir -p /usr/local/bin /usr/share/xsessions /etc/lightdm/lightdm.conf.d
cp "$SRC_DIR/kiosk/lightdm/kiosk-session.sh" /usr/local/bin/kiosk-session.sh
chmod +x /usr/local/bin/kiosk-session.sh
cp "$SRC_DIR/kiosk/lightdm/kiosk.desktop" /usr/share/xsessions/kiosk.desktop
sed "s/autologin-user=kiosk/autologin-user=$BROWSER_USER/" \
  "$SRC_DIR/kiosk/lightdm/50-kiosk-autologin.conf" \
  > /etc/lightdm/lightdm.conf.d/50-kiosk-autologin.conf
systemctl set-default graphical.target

systemctl daemon-reload
systemctl enable kiosk-control.service
# Always (re)start so a fresh unit (e.g. a new User=) takes effect even when
# the service was already running.
systemctl restart kiosk-control.service
systemctl enable kiosk-browser.service
# launch-kiosk.sh's wait_for_x handles the boot race with lightdm.
systemctl restart kiosk-browser.service

# --- Panel access: Caddy reverse proxy with HTTPS + Basic Auth ------------------
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
# and the current LAN IP. Generated cross-platform via Node (selfsigned); a
# bare ":443" site with `tls internal` does not get automatic HTTPS, so we
# provide explicit cert files.
PANEL_HOST="$(hostname).local"
"$NODE_BIN" "$DEST_DIR/kiosk/gen-cert.js" /etc/caddy "$PANEL_HOST" \
  || { echo "error: failed to generate the panel certificate" >&2; exit 1; }
# Caddy runs as its own unprivileged user — make the certs readable by it.
chown caddy:caddy /etc/caddy/kiosk-cert.pem /etc/caddy/kiosk-key.pem
chmod 644 /etc/caddy/kiosk-cert.pem
chmod 600 /etc/caddy/kiosk-key.pem

cat > /etc/caddy/Caddyfile <<EOF
:443 {
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

# --- Tailscale (optional, for remote access) -----------------------------------
# The panel stays available on the local wifi/ethernet network; Tailscale is
# just for reaching the Pi remotely. Prompt unless KIOSK_TAILSCALE is set.
if [[ -z "${KIOSK_TAILSCALE:-}" && -t 0 ]]; then
  read -r -p "Install and set up Tailscale for remote access? [y/N] " KIOSK_TAILSCALE
fi
case "${KIOSK_TAILSCALE:-no}" in
  y|Y|yes|YES|1)
    if ! command -v tailscale >/dev/null 2>&1; then
      echo "==> Installing Tailscale"
      curl -fsSL https://tailscale.com/install.sh | sh
    fi
    systemctl enable --now tailscaled
    if [[ -n "${KIOSK_TAILSCALE_AUTHKEY:-}" ]]; then
      echo "==> Connecting to the tailnet"
      tailscale up --authkey "$KIOSK_TAILSCALE_AUTHKEY"
    else
      echo "==> Tailscale installed. Connect it to your tailnet with:"
      echo "    sudo tailscale up"
      echo "    (open the printed link to authenticate; add --ssh for Tailscale's"
      echo "     managed SSH). The panel stays on this network at"
      echo "     https://$(hostname).local AND becomes reachable from your tailnet."
    fi
    ;;
esac

echo
echo "==> Done. Kiosk is installed and the services are running."
echo "    Control panel:   https://$(hostname).local"
echo "    Panel login:     user: $PANEL_USER"
echo "    Panel password:  $PANEL_PASSWORD"
echo "    (standard HTTPS port 443; self-signed certificate - accept the"
echo "     browser warning once per device, and your browser remembers the login)"
echo
echo "==> Remaining manual step (see $DEST_DIR/docs/SETUP.md):"
echo "   First-time PCO login. Easiest from the panel: open the control panel,"
echo "   then 'Kiosk remote control -> Start remote control' and log in to"
echo "   Planning Center there. (Alternative: attach a keyboard/mouse to the"
echo "   Pi and run the --login window.)"
echo
echo "   Then add your services at the control panel."
