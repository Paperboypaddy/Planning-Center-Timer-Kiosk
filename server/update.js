'use strict';

// Software update check: compares the running version against the latest
// GitHub release for the repo, so the panel can offer an update. Checking is
// cross-platform; applying is platform-specific (Linux can auto-reinstall,
// Windows/macOS point at the release download).

const DEFAULT_REPO = 'Paperboypaddy/Planning-Center-Timer-Kiosk';
const DEFAULT_API_BASE = 'https://api.github.com';

function parseVersion(v) {
  const m = /v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// -1 if a < b, 0 if equal/unparseable, 1 if a > b.
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return 0;
}

// Fetch the latest release from GitHub and compare with the running version.
// Throws on network/HTTP errors; a 404 (no releases yet) returns a "none" shape.
async function getUpdateInfo({
  repo = process.env.KIOSK_UPDATE_REPO || DEFAULT_REPO,
  version,
  baseUrl = process.env.KIOSK_UPDATE_BASE || DEFAULT_API_BASE,
  signal,
} = {}) {
  let res;
  try {
    res = await fetch(`${baseUrl}/repos/${repo}/releases/latest`, {
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
  const data = await res.json();
  const latest = String(data.tag_name || '').replace(/^v/, '');
  return {
    version,
    latestVersion: latest || null,
    updateAvailable: !!(latest && compareVersions(latest, version) > 0),
    releaseUrl: data.html_url || null,
    publishedAt: data.published_at || null,
  };
}

function releasesUrl(repo = process.env.KIOSK_UPDATE_REPO || DEFAULT_REPO) {
  return `https://github.com/${repo}/releases`;
}

module.exports = { compareVersions, getUpdateInfo, parseVersion, releasesUrl };
