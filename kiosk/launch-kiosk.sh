#!/usr/bin/env bash
# Launches Chromium for the kiosk, in kiosk mode, with remote debugging
# enabled on localhost so the control server can drive the tab via CDP.
#
# Usage:
#   launch-kiosk.sh            launch the kiosk (fullscreen) at $KIOSK_URL
#   launch-kiosk.sh --login    launch a normal window (no --kiosk) using the
#                              SAME profile dir, for the one-time Planning
#                              Center login step (see docs/SETUP.md)
#
# Environment:
#   KIOSK_CHROMIUM       full path to a Chromium binary (default: auto-detect
#                        chromium / chromium-browser / google-chrome*)
#   KIOSK_PROFILE_DIR    persistent profile dir (must be identical for the
#                        --login step and kiosk mode, and across reboots)
#   KIOSK_URL            initial URL shown on the TV (default: the control
#                        server's idle page)
#   KIOSK_DEBUG_PORT     CDP port (default 9222, localhost only)
set -euo pipefail

find_chromium() {
  if [[ -n "${KIOSK_CHROMIUM:-}" && -x "${KIOSK_CHROMIUM}" ]]; then
    printf '%s\n' "${KIOSK_CHROMIUM}"
    return
  fi
  # Package name differs by distro/arch: Debian/Ubuntu/Armbian ship
  # "chromium" (on Ubuntu it may be a snap wrapper), Raspberry Pi OS used to
  # ship "chromium-browser". Never assume a single name.
  for c in chromium chromium-browser google-chrome google-chrome-stable; do
    if command -v "$c" >/dev/null 2>&1; then
      printf '%s\n' "$c"
      return
    fi
  done
  printf 'chromium\n' # fall back; exec will fail with a clear error
}

CHROME="$(find_chromium)"
PROFILE_DIR="${KIOSK_PROFILE_DIR:-$HOME/.config/kiosk-chromium}"
DEBUG_PORT="${KIOSK_DEBUG_PORT:-9222}"
URL="${KIOSK_URL:-http://127.0.0.1:3000/nowplaying}"

mkdir -p "$PROFILE_DIR"

# Wait for the X server to be up before launching Chromium. The kiosk systemd
# service can start before the display manager has finished bringing up :0 on
# autologin sessions, so we poll instead of crashing and relying on Restart.
# Fail (non-zero) if the display never appears so systemd retries cleanly.
wait_for_x() {
  local display="${DISPLAY:-:0}"
  local socket="/tmp/.X11-unix/X${display#:}"
  local deadline=$(( $(date +%s) + ${KIOSK_X_TIMEOUT:-60} ))
  while [ ! -S "$socket" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "error: X server not ready ($socket missing after ${KIOSK_X_TIMEOUT:-60}s)" >&2
      exit 1
    fi
    sleep 1
  done
  if command -v xset >/dev/null 2>&1; then
    local tries=0
    until xset -display "$display" q >/dev/null 2>&1; do
      tries=$((tries + 1))
      if [ "$tries" -ge 10 ]; then
        echo "error: X server on $display not accepting connections" >&2
        exit 1
      fi
      sleep 1
    done
  fi
}

wait_for_x

# Disable screen blanking / DPMS so the countdown never sleeps. Best-effort:
# only meaningful inside an X session, and xset may not be installed.
if [[ -n "${DISPLAY:-}" ]]; then
  xset s off   >/dev/null 2>&1 || true
  xset s noblank >/dev/null 2>&1 || true
  xset -dpms   >/dev/null 2>&1 || true
fi

# Hide the cursor while idle (best effort; unclutter may be absent).
unclutter_pid=""
if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 0.5 -root &
  unclutter_pid=$!
fi
cleanup() { [[ -n "$unclutter_pid" ]] && kill "$unclutter_pid" 2>/dev/null || true; }
trap cleanup EXIT

# Conservative flags. Notably we do NOT pass --disable-gpu or similar:
# let the system pick the graphics backend. On a low-power Orange Pi Zero 3
# this avoids assumptions about GPU/compositing capabilities.
FLAGS=(
  --remote-debugging-port="${DEBUG_PORT}"
  --remote-debugging-address=127.0.0.1
  --user-data-dir="${PROFILE_DIR}"
  --no-first-run
  --no-default-browser-check
  --noerrdialogs
  --disable-session-crashed-bubble
  --password-store=basic
  --disable-features=TranslateUI,MediaRouter
)

if [[ "${1:-}" == "--login" ]]; then
  shift
  exec "$CHROME" --start-maximized "${FLAGS[@]}" "$@"
fi

# Run Chromium in the foreground so systemd tracks it and Restart=on-failure
# works. The trap cleans up unclutter when Chromium exits.
"$CHROME" --kiosk "${FLAGS[@]}" "$URL" &
chrome_pid=$!
wait "$chrome_pid"
exit $?
