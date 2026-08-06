'use strict';

// Software update check: compares the running version against the latest
// GitHub release for the repo, so the panel can offer an update. Checking is
// cross-platform; applying is platform-specific (Linux can auto-reinstall,
// Windows/macOS point at the release download).

const fs = require('fs');
const path = require('path');

const DEFAULT_REPO = 'Paperboypaddy/Planning-Center-Timer-Kiosk';
const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_UPDATE_SCRIPT = '/opt/kiosk/kiosk/update.sh';

const IDLE_UPDATE_STATE = {
  state: 'idle',
  progress: null,
  message: '',
  version: null,
  updatedAt: null,
};

// Linux Debian/Ubuntu install uses update.sh; NixOS (and other immutable
// installs) set KIOSK_UPDATE_SCRIPT to empty to disable in-panel apply.
function updateScriptPath(env = process.env, platform = process.platform) {
  if (platform !== 'linux') return null;
  if (Object.prototype.hasOwnProperty.call(env, 'KIOSK_UPDATE_SCRIPT')) {
    return env.KIOSK_UPDATE_SCRIPT || null;
  }
  return DEFAULT_UPDATE_SCRIPT;
}

function canApplyUpdate(env = process.env, platform = process.platform) {
  const script = updateScriptPath(env, platform);
  return !!(script && fs.existsSync(script));
}

// The update script (kiosk/update.sh) and the control server both write/read a
// small JSON state file so the panel can show live progress. The file lives
// next to config.json (owned by the control user; root's update.sh can write
// there too). KIOSK_UPDATE_STATE overrides the location.
function updateStatePath(configPath, env = process.env) {
  return env.KIOSK_UPDATE_STATE || path.join(path.dirname(configPath), 'update-state.json');
}

function readUpdateState(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Object.assign({}, IDLE_UPDATE_STATE, data);
  } catch {
    return { ...IDLE_UPDATE_STATE };
  }
}

function writeUpdateState(filePath, patch) {
  try {
    const next = Object.assign({}, readUpdateState(filePath), patch, { updatedAt: new Date().toISOString() });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n');
    return next;
  } catch {
    return null;
  }
}

// Parse YYYY.M.D or semver, including optional prerelease (e.g. 2026.8.5-beta.2).
// Stable (no prerelease) sorts above any prerelease of the same Y.M.D.
function parseVersion(v) {
  // Keep the prerelease label (e.g. beta.2) so date-based betas compare correctly.
  const m = /v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] || null };
}

// SemVer prerelease ordering for identifiers separated by '.'.
function comparePrerelease(a, b) {
  const as = String(a).split('.');
  const bs = String(b).split('.');
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const dx = Number(x) - Number(y);
      if (dx) return dx < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// -1 if a < b, 0 if equal/unparseable, 1 if a > b.
// Stable (no prerelease) ranks above any prerelease of the same core version.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  if (!pa.prerelease && !pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

// Fetch the latest release from GitHub and compare with the running version.
// includePrereleases picks the newest release even if it's a beta (the
// /releases list, newest first); otherwise /releases/latest (stable only) is
// used, so betas never auto-offer unless the panel enables them.
// Throws on network/HTTP errors; a 404 (no releases yet) returns a "none" shape.
async function getUpdateInfo({
  repo = process.env.KIOSK_UPDATE_REPO || DEFAULT_REPO,
  version,
  includePrereleases = false,
  baseUrl = process.env.KIOSK_UPDATE_BASE || DEFAULT_API_BASE,
  signal,
} = {}) {
  const path = includePrereleases ? `/repos/${repo}/releases?per_page=20` : `/repos/${repo}/releases/latest`;
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'planningcenter-timer-kiosk' },
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`update check failed: ${err.message}`);
  }
  if (res.status === 404) {
    return { version, latestVersion: null, updateAvailable: false, releaseUrl: null, publishedAt: null, note: 'no releases published yet' };
  }
  if (!res.ok) throw new Error(`update check failed (HTTP ${res.status})`);
  const json = await res.json();
  const data = Array.isArray(json) ? json[0] || null : json;
  if (!data) {
    return { version, latestVersion: null, updateAvailable: false, releaseUrl: null, publishedAt: null, note: 'no releases published yet' };
  }
  const latest = String(data.tag_name || '').replace(/^v/, '');
  return {
    version,
    latestVersion: latest || null,
    updateAvailable: !!(latest && compareVersions(latest, version) > 0),
    releaseUrl: data.html_url || null,
    publishedAt: data.published_at || null,
    prerelease: !!data.prerelease,
  };
}

function releasesUrl(repo = process.env.KIOSK_UPDATE_REPO || DEFAULT_REPO) {
  return `https://github.com/${repo}/releases`;
}

module.exports = {
  IDLE_UPDATE_STATE,
  canApplyUpdate,
  compareVersions,
  getUpdateInfo,
  parseVersion,
  readUpdateState,
  releasesUrl,
  updateScriptPath,
  updateStatePath,
  writeUpdateState,
};
