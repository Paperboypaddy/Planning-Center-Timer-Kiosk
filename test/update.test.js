'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { canApplyUpdate, compareVersions, getUpdateInfo, readUpdateState, updateScriptPath, updateStatePath, writeUpdateState } = require('../server/update');

// handler(req.url) -> { status?, body }
function startMockRelease(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      const out = handler(req.url);
      res.statusCode = out.status || 200;
      res.end(out.status && out.status !== 200 ? '{}' : JSON.stringify(out.body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const REL = (tag, prerelease = false) => ({
  tag_name: tag,
  prerelease,
  html_url: `https://github.com/x/repo/releases/tag/${tag}`,
  published_at: '2026-01-01T00:00:00Z',
});

test('compareVersions orders semver and date-based versions', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('junk', '0.1.0'), 0);
  // date-based scheme (YYYY.M.D)
  assert.equal(compareVersions('2026.8.4', '2026.8.5'), -1);
  assert.equal(compareVersions('2026.8.10', '2026.8.9'), 1);
  assert.equal(compareVersions('2026.9.1', '2026.8.4'), 1);
  assert.equal(compareVersions('2026.8.4', '2026.8.4'), 0);
  assert.equal(compareVersions('2026.8.4', '0.1.0'), 1);
  assert.equal(compareVersions('2026.8.5-beta', '2026.8.4'), 1);
  // Prerelease labels must participate in ordering (beta.2 > beta.1; stable > beta).
  assert.equal(compareVersions('2026.8.5-beta.2', '2026.8.5-beta.1'), 1);
  assert.equal(compareVersions('2026.8.5-beta.1', '2026.8.5-beta.2'), -1);
  assert.equal(compareVersions('2026.8.5', '2026.8.5-beta.2'), 1);
  assert.equal(compareVersions('2026.8.5-beta.2', '2026.8.5'), -1);
  assert.equal(compareVersions('2026.8.5-beta.2', '2026.8.5-beta.2'), 0);
});

test('getUpdateInfo uses the stable release by default', async () => {
  const mock = await startMockRelease((url) => ({ body: REL('v2026.8.4') }));
  try {
    const info = await getUpdateInfo({ repo: 'x/repo', version: '0.1.0', baseUrl: mock.base });
    assert.equal(info.updateAvailable, true);
    assert.equal(info.latestVersion, '2026.8.4');
    assert.equal(info.prerelease, false);
  } finally {
    mock.server.close();
  }
});

test('getUpdateInfo ignores prereleases unless enabled', async () => {
  // A beta exists but the stable /releases/latest endpoint is what's used
  // without the toggle, so only the stable tag is compared.
  const mock = await startMockRelease((url) => ({ body: REL('2026.8.4') }));
  try {
    const info = await getUpdateInfo({ repo: 'x/repo', version: '2026.8.4', baseUrl: mock.base });
    assert.equal(info.updateAvailable, false);
  } finally {
    mock.server.close();
  }
});

test('getUpdateInfo with includePrereleases picks the newest beta', async () => {
  const mock = await startMockRelease(() => ({ body: [REL('2026.8.5-beta', true), REL('2026.8.4')] }));
  try {
    const info = await getUpdateInfo({ repo: 'x/repo', version: '2026.8.4', includePrereleases: true, baseUrl: mock.base });
    assert.equal(info.updateAvailable, true);
    assert.equal(info.latestVersion, '2026.8.5-beta');
    assert.equal(info.prerelease, true);
  } finally {
    mock.server.close();
  }
});

test('getUpdateInfo with includePrereleases offers a newer beta of the same date', async () => {
  const mock = await startMockRelease(() => ({ body: [REL('2026.8.5-beta.2', true), REL('2026.8.4')] }));
  try {
    const info = await getUpdateInfo({
      repo: 'x/repo',
      version: '2026.8.5-beta.1',
      includePrereleases: true,
      baseUrl: mock.base,
    });
    assert.equal(info.updateAvailable, true);
    assert.equal(info.latestVersion, '2026.8.5-beta.2');
  } finally {
    mock.server.close();
  }
});

test('getUpdateInfo handles no releases', async () => {
  const mock = await startMockRelease(() => ({ status: 404 }));
  try {
    const info = await getUpdateInfo({ repo: 'x/repo', version: '2026.8.4', baseUrl: mock.base });
    assert.equal(info.updateAvailable, false);
    assert.equal(info.note, 'no releases published yet');
  } finally {
    mock.server.close();
  }
});

test('getUpdateInfo throws when the API is unreachable', async () => {
  await assert.rejects(() => getUpdateInfo({ repo: 'x/repo', version: '2026.8.4', baseUrl: 'http://127.0.0.1:1' }));
});

test('update state helpers round-trip through the state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-updstate-'));
  const file = path.join(dir, 'update-state.json');
  // Missing file -> idle.
  assert.equal(readUpdateState(file).state, 'idle');
  assert.equal(readUpdateState(file).progress, null);
  // Write + read back.
  writeUpdateState(file, { state: 'downloading', progress: 15, message: 'Downloading release', version: '2026.8.5' });
  const read = readUpdateState(file);
  assert.equal(read.state, 'downloading');
  assert.equal(read.progress, 15);
  assert.equal(read.message, 'Downloading release');
  assert.equal(read.version, '2026.8.5');
  assert.ok(typeof read.updatedAt === 'string' && read.updatedAt.length > 0);
  // Later writes merge over the previous state.
  writeUpdateState(file, { state: 'done', progress: 100, message: 'Update complete' });
  const done = readUpdateState(file);
  assert.equal(done.state, 'done');
  assert.equal(done.progress, 100);
  assert.equal(done.version, '2026.8.5', 'version survives from the previous state');
});

test('updateStatePath defaults next to config, overridable via env', () => {
  assert.equal(updateStatePath('/var/lib/kiosk/config.json'), '/var/lib/kiosk/update-state.json');
  assert.equal(updateStatePath('/tmp/x/config.json', { KIOSK_UPDATE_STATE: '/tmp/custom.json' }), '/tmp/custom.json');
});

test('updateScriptPath defaults on linux and empty env disables apply', () => {
  assert.equal(updateScriptPath({}, 'linux'), '/opt/kiosk/kiosk/update.sh');
  assert.equal(updateScriptPath({ KIOSK_UPDATE_SCRIPT: '' }, 'linux'), null);
  assert.equal(updateScriptPath({ KIOSK_UPDATE_SCRIPT: '/bin/true' }, 'linux'), '/bin/true');
  assert.equal(updateScriptPath({}, 'win32'), null);
});

test('canApplyUpdate is false when script is empty or missing', () => {
  assert.equal(canApplyUpdate({ KIOSK_UPDATE_SCRIPT: '' }, 'linux'), false);
  assert.equal(canApplyUpdate({ KIOSK_UPDATE_SCRIPT: '/nonexistent-kiosk-update' }, 'linux'), false);
  // Prefer a path that exists on both Debian and NixOS test hosts.
  const existing = process.execPath;
  assert.equal(canApplyUpdate({ KIOSK_UPDATE_SCRIPT: existing }, 'linux'), true);
  assert.equal(canApplyUpdate({}, 'darwin'), false);
});

// App-level: /api/update/status reflects the toggle + current version.
const { loadConfig } = require('../server/config');
const { KioskDriver } = require('../server/kiosk');
const { createApp } = require('../server/app');
const { startMockCdp } = require('./helpers/mock-cdp');
const { quietLogger } = require('./helpers/util');

test('GET /api/update/status reports an available update and the version', async () => {
  const mockApi = await startMockRelease(() => ({ body: REL('2026.8.5') }));
  const old = process.env.KIOSK_UPDATE_BASE;
  process.env.KIOSK_UPDATE_BASE = mockApi.base;

  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-upd-')), 'config.json');
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: -1, idleUrl: 'http://127.0.0.1:3001/nowplaying', reconnectMs: 100 });
  const cec = { isAvailable: () => true, powerOn: async () => ({ ok: true }), powerOff: async () => ({ ok: true }), powerStatus: async () => ({ ok: true, power: null }) };
  const { app } = createApp({ config, kiosk, configPath, idleUrl: 'http://127.0.0.1:3001/nowplaying', logger: quietLogger, cec, version: '2026.8.4' });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/update/status`);
    const body = await res.json();
    assert.equal(body.updateAvailable, true);
    assert.equal(body.version, '2026.8.4');
    assert.equal(body.latestVersion, '2026.8.5');
  } finally {
    if (old === undefined) delete process.env.KIOSK_UPDATE_BASE;
    else process.env.KIOSK_UPDATE_BASE = old;
    kiosk.stop();
    await new Promise((resolve) => server.close(resolve));
    mockApi.server.close();
  }
});

test('GET /api/update/progress is public and reflects the state file', async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-upd-')), 'config.json');
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: -1, idleUrl: 'http://127.0.0.1:3001/nowplaying', reconnectMs: 100 });
  const cec = { isAvailable: () => true, powerOn: async () => ({ ok: true }), powerOff: async () => ({ ok: true }), powerStatus: async () => ({ ok: true, power: null }) };
  const { app } = createApp({ config, kiosk, configPath, idleUrl: 'http://127.0.0.1:3001/nowplaying', logger: quietLogger, cec, version: '2026.8.4' });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // No session cookie and no admin configured: the endpoint is public and
    // reports idle until the update starts.
    let res = await fetch(`${base}/api/update/progress`);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.state, 'idle');

    // POST /api/update resolves the tag it offered via the update API, writes
    // a starting state, then spawns the updater. The spawn may succeed or fail
    // depending on whether sudo exists here, but the state write must happen
    // either way. KIOSK_UPDATE_BASE points at a local mock so the resolution
    // never touches the real GitHub API.
    const mockApi = await startMockRelease((url) => ({ body: REL('2026.8.5') }));
    const oldBase = process.env.KIOSK_UPDATE_BASE;
    process.env.KIOSK_UPDATE_BASE = mockApi.base;
    const oldScript = process.env.KIOSK_UPDATE_SCRIPT;
    process.env.KIOSK_UPDATE_SCRIPT = process.execPath;
    try {
      await fetch(`${base}/api/update`, { method: 'POST' });
    } finally {
      if (oldBase === undefined) delete process.env.KIOSK_UPDATE_BASE;
      else process.env.KIOSK_UPDATE_BASE = oldBase;
      if (oldScript === undefined) delete process.env.KIOSK_UPDATE_SCRIPT;
      else process.env.KIOSK_UPDATE_SCRIPT = oldScript;
      mockApi.server.close();
    }
    res = await fetch(`${base}/api/update/progress`);
    body = await res.json();
    assert.ok(['starting', 'error'].includes(body.state), `state was "${body.state}"`);
    assert.equal(body.progress, 0);
  } finally {
    kiosk.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('update.sh downloads the checksummed release asset, not the tag archive', () => {
  const updateSh = fs.readFileSync(path.join(__dirname, '..', 'kiosk', 'update.sh'), 'utf8');
  // The checksum in checksums.txt is computed for the CI-built release asset,
  // which is not byte-identical to GitHub's auto-generated tag archive. The
  // updater must fetch the asset, or verification would always fail.
  assert.match(updateSh, /releases\/download\/\$TAG\/planningcenter-timer-kiosk\.tar\.gz/);
  assert.doesNotMatch(updateSh, /\/archive\/refs\/tags\//);
});
