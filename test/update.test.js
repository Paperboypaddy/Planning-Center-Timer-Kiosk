'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { compareVersions, getUpdateInfo } = require('../server/update');

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
