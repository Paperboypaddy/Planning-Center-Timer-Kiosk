#!/usr/bin/env bash
# macOS installer for the Planning Center kiosk. Same cross-platform code as
# Linux/Windows; Caddy serves the panel (HTTPS + Basic Auth), launchd keeps
# the supervisor alive in your GUI session.
#
# Prerequisites: Google Chrome, and Homebrew (used to install Node + Caddy).
# Note: the panel needs Caddy to bind :443 — allow it in macOS Firewall when
# prompted. The daily-reboot schedule needs an admin-privileged Caddy/control
# process, so it's best-effort on a user launchd agent.
#
# Usage:  ./kiosk/install-macos.sh
# Env:    KIOSK_PANEL_USER, KIOSK_PANEL_PASSWORD
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="/usr/local/planningcenter-kiosk"
CONFIG_DIR="/usr/local/var/lib/kiosk"

if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js via Homebrew"
  brew install node
fi
NODE_BIN="$(command -v node)"

if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy via Homebrew"
  brew install caddy
fi

if ! [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  echo "error: install Google Chrome first (/Applications/Google Chrome.app)" >&2
  exit 1
fi

echo "==> Copying app to $DEST_DIR"
sudo mkdir -p "$DEST_DIR" "$CONFIG_DIR"
sudo cp -R "$SRC_DIR/server" "$SRC_DIR/public" "$SRC_DIR/kiosk" \
  "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$DEST_DIR/"
( cd "$DEST_DIR" && sudo npm install --omit=dev --no-audit --no-fund )

echo "==> Configuring the panel (password + cert + Caddy config)"
sudo "$NODE_BIN" "$DEST_DIR/kiosk/setup.js" "$DEST_DIR"

echo "==> Installing launchd agent (runs server + Caddy + browser, always-restart)"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.planningcenter.kiosk.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.planningcenter.kiosk</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DEST_DIR/kiosk/run.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KIOSK_PORT</key><string>3001</string>
    <key>KIOSK_CONFIG</key><string>$CONFIG_DIR/config.json</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
EOF
launchctl unload "$LAUNCH_AGENT" 2>/dev/null || true
launchctl load "$LAUNCH_AGENT"

echo "==> Installing the 'Kiosk Control panel' app in /Applications"
APP="/Applications/Planning Center Kiosk.app"
sudo mkdir -p "$APP/Contents/MacOS"
sudo cp "$DEST_DIR/kiosk/open-panel.js" "$APP/Contents/MacOS/Kiosk"
sudo tee "$APP/Contents/Info.plist" >/dev/null <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Kiosk Control panel</string>
  <key>CFBundleIdentifier</key><string>com.planningcenter.kiosk.panel</string>
  <key>CFBundleExecutable</key><string>Kiosk</string>
</dict></plist>
PLIST
sudo chmod +x "$APP/Contents/MacOS/Kiosk"

echo
echo "==> Done."
echo "    Panel:      https://$(hostname).local   (login printed during setup;"
echo "                also saved to $DEST_DIR/panel-login.txt)"
echo "    Control:    /Applications/Planning Center Kiosk.app"
echo "    Note:       allow Caddy in the macOS firewall when prompted."
