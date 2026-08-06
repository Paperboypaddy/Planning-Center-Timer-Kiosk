#!/usr/bin/env bash
# CI smoke test for kiosk/install.sh on a fresh Ubuntu 24.04 (arm64) image.
#
# Verifies the whole chain the way it happens on a real kiosk: run the
# installer, then confirm lightdm autologin reaches an X session and the kiosk
# software (control server + Chromium over CDP) comes up -- WITHOUT a reboot.
#
# A virtual Xorg (dummy driver) stands in for the TV so lightdm autologin and
# Chromium can run on a headless GitHub runner.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# --- Headless display so lightdm/Xorg + Chromium can run on a VM ------------
echo "==> Setting up headless X (dummy driver)"
apt-get update -qq
apt-get install -y -qq xserver-xorg-video-dummy >/dev/null
mkdir -p /etc/X11/xorg.conf.d
cat > /etc/X11/xorg.conf.d/99-kiosk-headless.conf <<'EOF'
Section "Monitor"
  Identifier "Monitor0"
  HorizSync 28.0-80.0
  VertRefresh 48.0-75.0
EndSection
Section "Device"
  Identifier "Card0"
  Driver "dummy"
  VideoRam 131072
EndSection
Section "Screen"
  Identifier "Screen0"
  Device "Card0"
  Monitor "Monitor0"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "1920x1080"
  EndSubSection
EndSection
EOF

# --- Run the real installer on the fresh image ------------------------------
echo "==> Running kiosk/install.sh"
KIOSK_TAILSCALE=no bash ./kiosk/install.sh

# --- Let the graphical session come up --------------------------------------
sleep 20

# --- Assertions -------------------------------------------------------------
echo "==> Verifying services"
for svc in kiosk-control kiosk-browser lightdm caddy; do
  systemctl is-active --quiet "$svc" || { echo "FAIL: $svc not active"; exit 1; }
done

echo "==> Verifying autologin reached an X session (got past the login screen)"
if ! who | grep -qE '\(:0\)'; then
  echo "FAIL: no X session on :0 (lightdm autologin did not get through)"
  exit 1
fi

echo "==> Verifying the control server"
VERSION="$(curl -s --max-time 5 http://127.0.0.1:3001/api/state \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).version||'')}catch{}})" || true)"
[ -n "$VERSION" ] || { echo "FAIL: control server did not respond"; exit 1; }

echo "==> Waiting for Chromium on CDP :9222"
PAGES=0
for _ in $(seq 1 45); do
  if curl -s --max-time 3 http://127.0.0.1:9222/json/list >/dev/null 2>&1; then
    PAGES="$(curl -s --max-time 3 http://127.0.0.1:9222/json/list \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).filter(x=>x.type==='page').length)}catch{console.log(0)}})")"
    [ "${PAGES:-0}" -ge 1 ] && break
  fi
  sleep 2
done
[ "${PAGES:-0}" -ge 1 ] || { echo "FAIL: no browser page target on CDP :9222"; exit 1; }

echo "==> Verifying the control server sees the kiosk connected"
CONNECTED="$(curl -s --max-time 5 http://127.0.0.1:3001/api/health \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).kiosk.connected)}catch{console.log('false')}})" || echo false)"
[ "$CONNECTED" = "true" ] || { echo "FAIL: control server does not see the kiosk connected"; exit 1; }

echo "==> PASS: install.sh got the kiosk fully running without a reboot (version=$VERSION, browser tabs=$PAGES)"
