'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../server/config');
const { KioskDriver } = require('../server/kiosk');
const { createApp } = require('../server/app');
const { startMockCdp } = require('./helpers/mock-cdp');
const { quietLogger } = require('./helpers/util');

const IDLE = 'http://127.0.0.1:3999/nowplaying';

async function startApp(mockPort) {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-dt-')), 'config.json');
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: mockPort, idleUrl: IDLE, reconnectMs: 100 });
  const { app } = createApp({ config, kiosk, configPath, idleUrl: IDLE, logger: quietLogger });
  kiosk.start();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    send: async (p, method, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() };
    },
    close: () => {
      kiosk.stop();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('POST /api/kiosk/display-type sets the layout via a desktop viewport then restores it', async () => {
  const mock = await startMockCdp({ url: IDLE });
  mock.setEvaluateResult({ state: 'done' });
  const ctx = await startApp(mock.port);
  try {
    const res = await ctx.send('/api/kiosk/display-type', 'POST', { value: 'Countdown Full' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const methods = mock.commandLog.map((c) => c.method);
    assert.ok(methods.includes('Emulation.setDeviceMetricsOverride'), 'desktop viewport emulated');
    assert.ok(methods.includes('Emulation.clearDeviceMetricsOverride'), 'native viewport restored');
    assert.ok(methods.includes('Runtime.evaluate'), 'DOM script ran');

    // Unknown display type is rejected before touching the browser.
    mock.commandLog.length = 0;
    const bad = await ctx.send('/api/kiosk/display-type', 'POST', { value: 'Nope' });
    assert.equal(bad.status, 502);
    assert.equal(mock.commandLog.length, 0);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('select applies the service display type and reports it', async () => {
  const mock = await startMockCdp({ url: IDLE });
  mock.setEvaluateResult({ state: 'done' });
  const ctx = await startApp(mock.port);
  try {
    const res = await ctx.send('/api/services', 'POST', {
      name: 'Sunday',
      serviceId: '123',
      displayType: 'Lower Third',
    });
    const service = res.body.service;

    const sel = await ctx.send('/api/select', 'POST', { id: service.id });
    assert.equal(sel.status, 200);
    assert.equal(sel.body.displayType.value, 'Lower Third');
    assert.equal(sel.body.displayType.applied, true);

    // A service without a display type leaves the PCO setting untouched.
    const res2 = await ctx.send('/api/services', 'POST', { name: 'Wed', serviceId: '456' });
    const sel2 = await ctx.send('/api/select', 'POST', { id: res2.body.service.id });
    assert.equal(sel2.body.displayType, null);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('select applies the global default display type and default theme', async () => {
  const mock = await startMockCdp({ url: IDLE });
  mock.setEvaluateResult({ state: 'done' });
  const ctx = await startApp(mock.port);
  try {
    // Save defaults.
    const setRes = await ctx.send('/api/settings', 'PUT', {
      defaultDisplayType: 'Countdown Full',
      defaultTheme: 'light',
    });
    assert.equal(setRes.status, 200);
    assert.equal(setRes.body.defaultDisplayType, 'Countdown Full');
    assert.equal(setRes.body.defaultTheme, 'light');

    // A service with no displayType picks up the default.
    const res = await ctx.send('/api/services', 'POST', { name: 'Sun', serviceId: '777' });
    const sel = await ctx.send('/api/select', 'POST', { id: res.body.service.id });
    assert.equal(sel.status, 200);
    assert.equal(sel.body.displayType.value, 'Countdown Full');
    assert.equal(sel.body.displayType.applied, true);
    assert.equal(sel.body.displayType.source, 'default');

    // The default theme was applied too (Runtime.evaluate calls for theme).
    const evaluateCalls = mock.commandLog.filter((c) => c.method === 'Runtime.evaluate').length;
    assert.ok(evaluateCalls >= 2, 'display type + theme both evaluated');

    // A per-service displayType overrides the default.
    const res2 = await ctx.send('/api/services', 'POST', { name: 'Sat', serviceId: '888', displayType: 'Lower Third' });
    const sel2 = await ctx.send('/api/select', 'POST', { id: res2.body.service.id });
    assert.equal(sel2.body.displayType.value, 'Lower Third');
    assert.equal(sel2.body.displayType.source, 'service');

    // Invalid settings are rejected.
    const bad = await ctx.send('/api/settings', 'PUT', { defaultTheme: 'pink' });
    assert.equal(bad.status, 400);
    const bad2 = await ctx.send('/api/settings', 'PUT', { defaultDisplayType: 'Nope' });
    assert.equal(bad2.status, 400);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('POST /api/kiosk/settings/apply applies saved defaults to the current page', async () => {
  const mock = await startMockCdp({ url: IDLE });
  mock.setEvaluateResult({ state: 'done' });
  const ctx = await startApp(mock.port);
  try {
    // Nothing configured: no-op.
    let r = await ctx.send('/api/kiosk/settings/apply', 'POST');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.applied, { displayType: null, theme: null });

    await ctx.send('/api/settings', 'PUT', { defaultDisplayType: 'Countdown Full', defaultTheme: 'dark' });
    r = await ctx.send('/api/kiosk/settings/apply', 'POST');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.applied, { displayType: 'Countdown Full', theme: 'dark' });
  } finally {
    await ctx.close();
    await mock.close();
  }
});
