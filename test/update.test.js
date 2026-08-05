'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { compareVersions, getUpdateInfo } = require('../server/update');

function startMockRelease(body, status = 200) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = status;
      res.end(status === 200 ? JSON.stringify(body) : '{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('compareVersions orders semver-ish versions', () => {
  assert.equal(compareVersions('v0.2.0', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('0.2.0-beta.1', '0.1.0'), 1);
  assert.equal(compareVersions('junk', '0.1.0'), 0);
});

test('getUpdateInfo flags an available update for a newer release', async () => {
  const mock = await startMockRelease({
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/x/repo/releases/tag/v0.2.0',
    published_at: '2026-01-01T00:00:00Z',
  });
  try {
    const info = await getUpdateInfo({ repo: 'x/repo', version: '0.1.0', baseUrl: mock.base });
    assert.equal(info.updateAvailable, true);
    assert.equal(info.latestVersion, '0.2.0');
    assert.equal(info.releaseUrl, 'https://github.com/x/repo/releases/tag/v0.2.0');
  } finally {
    mock.server.close();
  }
});

test('getUpdateInfo is up to date when versions match, and handles no releases', async () => {
  const same = await startMockRelease({ tag_name: 'v0.1.0' });
  try {
    const info = await getUpdateInfo({ repo: 'x/repo', version: '0.1.0', baseUrl: same.base });
    assert.equal(info.updateAvailable, false);
  } finally {
    same.server.close();
  }

  const none = await startMockRelease({}, 404);
  try {
    const info = await getUpdateInfo({ repo: 'x/repo', version: '0.1.0', baseUrl: none.base });
    assert.equal(info.updateAvailable, false);
    assert.equal(info.note, 'no releases published yet');
  } finally {
    none.server.close();
  }
});

test('getUpdateInfo throws when the API is unreachable', async () => {
  await assert.rejects(() => getUpdateInfo({ repo: 'x/repo', version: '0.1.0', baseUrl: 'http://127.0.0.1:1' }));
});

// App-level: /api/update/status reflects the mock API.
const { loadConfig } = require('../server/config');
const { KioskDriver } = require('../server/kiosk');
const { createApp } = require('../server/app');
const { startMockCdp } = require('./helpers/mock-cdp');
const { quietLogger } = require('./helpers/util');

test('GET /api/update/status reports an available update', async () => {
  const mockApi = await startMockRelease({ tag_name: 'v0.2.0', html_url: 'https://github.com/x/repo/releases/tag/v0.2.0' });
  const old = process.env.KIOSK_UPDATE_BASE;
  process.env.KIOSK_UPDATE_BASE = mockApi.base;

  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-upd-')), 'config.json');
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: -1, idleUrl: 'http://127.0.0.1:3001/nowplaying', reconnectMs: 100 });
  const cec = { isAvailable: () => true, powerOn: async () => ({ ok: true }), powerOff: async () => ({ ok: true }), powerStatus: async () => ({ ok: true, power: null }) };
  const { app } = createApp({ config, kiosk, configPath, idleUrl: 'http://127.0.0.1:3001/nowplaying', logger: quietLogger, cec, version: '0.1.0' });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/update/status`);
    const body = await res.json();
    assert.equal(body.updateAvailable, true);
    assert.equal(body.version, '0.1.0');
    assert.equal(body.latestVersion, '0.2.0');
  } finally {
    if (old === undefined) delete process.env.KIOSK_UPDATE_BASE;
    else process.env.KIOSK_UPDATE_BASE = old;
    kiosk.stop();
    await new Promise((resolve) => server.close(resolve));
    mockApi.server.close();
  }
});
