#!/bin/sh
# Kiosk X session (Raspberry Pi OS / Debian headless): a minimal window
# manager that keeps the X server alive for Chromium.
#
# Chromium itself is launched by the kiosk-browser systemd service. That
# process runs as this same user but outside the lightdm session, so it
# cannot read lightdm's root-owned Xauthority. Granting access by local user
# id here lets it attach to :0 cleanly.
if command -v xhost >/dev/null 2>&1; then
  xhost +SI:localuser:"${USER:-raspi}" >/dev/null 2>&1 || true
fi

exec matchbox-window-manager -use_titlebar no -use_desktop_mode plain
