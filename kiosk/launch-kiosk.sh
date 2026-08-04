#!/usr/bin/env bash
# Thin wrapper: delegates to the cross-platform Node launcher so the existing
# systemd unit and docs keep working on Linux.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/launch-kiosk.js" "$@"
