'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../server/config');
const { KioskDriver } = require('../server/kiosk');
const { createApp } = require('../server/app');
const { startMockPco } = require('./helpers/mock-pco');
const { quietLogger } = require('./helpers/util');

const IDLE = 'http://127.0.0.1:3999/nowplaying';

async function startApp(pcoBase) {
  process.env.KIOSK_PCO_API_BASE = pcoBase;
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-pco-')), 'config.json');
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: 1, idleUrl: IDLE, reconnectMs: 100 });
  const { app } = createApp({ config, kiosk, configPath, idleUrl: IDLE, logger: quietLogger });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    config,
    configPath,
    async send(p, method, body) {
      const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    },
    close: () => {
      delete process.env.KIOSK_PCO_API_BASE;
      kiosk.stop();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('PCO import flow: status, key save, plans, import with dedupe, clear', async () => {
  const mock = await startMockPco();
  const ctx = await startApp(`http://127.0.0.1:${mock.port}/services/v2`);

  try {
    // Not configured yet
    let r = await ctx.send('/api/pco/status', 'GET');
    assert.deepEqual(r.body, { configured: false, viaEnv: false });

    // Save the key; verify it persists and is NOT leaked through /api/state
    r = await ctx.send('/api/pco/config', 'PUT', { apiKey: 'pat-abc123' });
    assert.deepEqual(r.body, { configured: true, viaEnv: false });
    const onDisk = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8'));
    assert.equal(onDisk.pco.apiKey, 'pat-abc123');
    r = await ctx.send('/api/state', 'GET');
    assert.equal(r.body.pco.configured, true);
    assert.equal('apiKey' in r.body.pco, false);

    // List upcoming plans
    r = await ctx.send('/api/pco/plans', 'GET');
    assert.equal(r.body.plans.length, 3);
    assert.equal(r.body.plans.some((p) => p.existing), false);

    // Import two plans
    r = await ctx.send('/api/pco/import', 'POST', { planIds: ['90197325', '90211110'] });
    assert.equal(r.body.created.length, 2);
    assert.equal(r.body.skipped.length, 0);

    // They now show as existing
    r = await ctx.send('/api/pco/plans', 'GET');
    const existingIds = r.body.plans.filter((p) => p.existing).map((p) => p.id);
    assert.deepEqual(existingIds, ['90197325', '90211110']);

    // Re-import is a no-op (dedupe)
    r = await ctx.send('/api/pco/import', 'POST', { planIds: ['90197325', '99999999'] });
    assert.equal(r.body.created.length, 0);
    assert.equal(r.body.skipped.length, 2);
    assert.equal(r.body.skipped.some((s) => s.reason === 'already exists'), true);

    // Services landed in the list with a friendly name
    r = await ctx.send('/api/state', 'GET');
    assert.equal(r.body.services.length, 2);
    const first = r.body.services.find((s) => s.serviceId === '90197325');
    assert.equal(first.name, 'Sunday 9am \u00b7 Aug 9, 9:00 AM');

    // Clearing the key disables the feature
    r = await ctx.send('/api/pco/config', 'PUT', { apiKey: '' });
    assert.deepEqual(r.body, { configured: false, viaEnv: false });
    r = await ctx.send('/api/pco/plans', 'GET');
    assert.equal(r.status, 400);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('PCO endpoints surface 401 and 429 through the API', async () => {
  const mock = await startMockPco({ requiredAuth: 'correct', rateLimited: false });
  const ctx = await startApp(`http://127.0.0.1:${mock.port}/services/v2`);
  try {
    await ctx.send('/api/pco/config', 'PUT', { apiKey: 'wrong' });

    let r = await ctx.send('/api/pco/plans', 'GET');
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'unauthorized');

    // rate limited mock
    const limited = await startMockPco({ rateLimited: true });
    await ctx.send('/api/pco/config', 'PUT', { apiKey: 'ok' });
    const oldBase = process.env.KIOSK_PCO_API_BASE;
    process.env.KIOSK_PCO_API_BASE = `http://127.0.0.1:${limited.port}/services/v2`;
    try {
      r = await ctx.send('/api/pco/plans', 'GET');
      assert.equal(r.status, 429);
      assert.equal(r.body.code, 'rate_limited');
    } finally {
      process.env.KIOSK_PCO_API_BASE = oldBase;
      await limited.close();
    }
  } finally {
    await ctx.close();
    await mock.close();
  }
});
