#!/usr/bin/env bash
# Apply a software update from the latest GitHub release: download the source
# tarball for the newest release tag, verify its SHA-256 checksum, extract it,
# and re-run install.sh.
#
# Run as root (the control server invokes it via a narrow sudoers entry; it
# can also be run manually). Keeps /var/lib/kiosk (config, profile, certs).
# Publish a release on GitHub (tag vX.Y.Z) to make updates available.
#
# Progress is written to a small JSON state file (next to the config, or
# KIOSK_UPDATE_STATE) that the control server streams to the panel as a
# progress bar. The server restart inside install.sh makes out-of-band state
# the only reliable channel.
set -euo pipefail

REPO="${KIOSK_UPDATE_REPO:-Paperboypaddy/Planning-Center-Timer-Kiosk}"
CONFIG_DIR="${KIOSK_CONFIG_DIR:-/var/lib/kiosk}"
STATE_FILE="${KIOSK_UPDATE_STATE:-$CONFIG_DIR/update-state.json}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CUR_PROGRESS=0
update_state() {
  # usage: update_state <state> <progress> <message>
  CUR_PROGRESS="$2"
  ST="$1" PR="$2" MSG="$3" STATE_FILE="$STATE_FILE" node -e '
    const fs = require("fs");
    const path = require("path");
    const file = process.env.STATE_FILE;
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const next = Object.assign({}, cur, {
      state: process.env.ST,
      progress: Number(process.env.PR),
      message: process.env.MSG,
      updatedAt: new Date().toISOString(),
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  ' 2>/dev/null || true
}

err_state() {
  update_state error "${CUR_PROGRESS:-0}" "Update failed"
}
trap err_state ERR

# Report a handled failure to the state file and exit non-zero. (The ERR trap
# only fires for unexpected command failures, not for an explicit exit 1.)
fail() {
  local msg="$1"
  update_state error "${CUR_PROGRESS:-0}" "$msg"
  echo "error: $msg" >&2
  exit 1
}

update_state starting 5 "Checking for the latest release"
# A target tag may be passed by the control server (which knows what it offered
# the panel, including prereleases). Without one, resolve the latest stable.
TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "==> Checking for the latest release of $REPO"
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.tag_name||'')}catch{}})" \
    || true)"
fi
if [[ -z "$TAG" ]]; then
  fail "no release found. Publish a release on GitHub (or set KIOSK_UPDATE_REPO)."
fi
update_state downloading 15 "Downloading release $TAG"
echo "==> Downloading $TAG"
# Download the release ASSET, not GitHub's auto-generated tag archive: the
# checksum in checksums.txt is computed for this exact file in the release
# workflow, and the two archives are not byte-for-byte identical.
curl -fsSL -o "$WORK/planningcenter-timer-kiosk.tar.gz" "https://github.com/$REPO/releases/download/$TAG/planningcenter-timer-kiosk.tar.gz"

# Integrity check: the release ships a SHA-256 checksums.txt. We refuse to
# extract or run anything that does not match. (Both files come from the same
# GitHub release over HTTPS, so this protects against tampering in transit /
# a swapped or mismatched tarball — not against a fully compromised repository.)
update_state verifying 55 "Verifying the SHA-256 checksum"
echo "==> Verifying the SHA-256 checksum"
if ! curl -fsSL -o "$WORK/checksums.txt" "https://github.com/$REPO/releases/download/$TAG/checksums.txt" 2>/dev/null; then
  fail "release $TAG has no checksums.txt; refusing to update. Update manually (e.g. re-run ./kiosk/install.sh from a fresh copy)."
fi
( cd "$WORK" && sha256sum -c checksums.txt ) || {
  fail "checksum verification failed for $TAG; aborting update."
}

update_state extracting 65 "Extracting source"
tar xzf "$WORK/planningcenter-timer-kiosk.tar.gz" -C "$WORK"
# The CI-built asset (git archive) has no top-level wrapper directory, so the
# repo files land directly in $WORK; GitHub's own archives wrap them in one.
# Detect either layout.
if [[ -f "$WORK/package.json" ]]; then
  NEW_SRC="$WORK"
else
  NEW_SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
fi
if [[ -z "$NEW_SRC" || ! -f "$NEW_SRC/package.json" ]]; then
  fail "could not find the extracted source"
fi

# Sanity check: the tarball's own version must match the release tag we picked,
# so a stale or misnamed release can never silently downgrade the device.
PKG_VERSION="$(node -e "try{console.log(require('$NEW_SRC/package.json').version||'')}catch{}" 2>/dev/null || true)"
if [[ -n "$PKG_VERSION" && "$PKG_VERSION" != "$(echo "$TAG" | sed 's/^v//')" ]]; then
  fail "release tag is $TAG but the tarball reports version $PKG_VERSION; aborting update."
fi

# Re-run install.sh with the same user choices as the original install, so the
# units/autologin keep matching the existing box.
if [[ -f "$CONFIG_DIR/.install-env" ]]; then
  # shellcheck disable=SC1091
  set -a; . "$CONFIG_DIR/.install-env"; set +a
fi

# This is the long phase (npm install + apt), so report it as indeterminate-ish
# but growing; the server restarts mid-way and comes back to 'done'.
update_state installing 75 "Reinstalling and restarting services (this takes a few minutes)"
echo "==> Reinstalling from $NEW_SRC"
"$NEW_SRC/kiosk/install.sh"
update_state done 100 "Update complete"
