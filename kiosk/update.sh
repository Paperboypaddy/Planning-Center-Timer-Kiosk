#!/usr/bin/env bash
# Apply a software update from the latest GitHub release: download the source
# tarball for the newest release tag, extract it, and re-run install.sh.
#
# Run as root (the control server invokes it via a narrow sudoers entry; it
# can also be run manually). Keeps /var/lib/kiosk (config, profile, certs).
# Publish a release on GitHub (tag vX.Y.Z) to make updates available.
set -euo pipefail

REPO="${KIOSK_UPDATE_REPO:-Paperboypaddy/Planning-Center-Timer-Kiosk}"
CONFIG_DIR="${KIOSK_CONFIG_DIR:-/var/lib/kiosk}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Checking for the latest release of $REPO"
TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.tag_name||'')}catch{}})" \
  || true)"
if [[ -z "$TAG" ]]; then
  echo "error: no release found. Publish a release on GitHub (or set KIOSK_UPDATE_REPO)." >&2
  exit 1
fi
echo "==> Downloading $TAG"
curl -fsSL -o "$WORK/kiosk.tar.gz" "https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"
tar xzf "$WORK/kiosk.tar.gz" -C "$WORK"
NEW_SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [[ -z "$NEW_SRC" ]]; then
  echo "error: could not find the extracted source" >&2
  exit 1
fi

# Re-run install.sh with the same user choices as the original install, so the
# units/autologin keep matching the existing box.
if [[ -f "$CONFIG_DIR/.install-env" ]]; then
  # shellcheck disable=SC1091
  set -a; . "$CONFIG_DIR/.install-env"; set +a
fi

echo "==> Reinstalling from $NEW_SRC"
"$NEW_SRC/kiosk/install.sh"
