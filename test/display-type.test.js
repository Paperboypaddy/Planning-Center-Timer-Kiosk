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
const DISPLAY = 'http://127.0.0.1:3999/display';

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

test('POST /api/kiosk/display-type updates local layout without CDP toolbar clicks', async () => {
  const mock = await startMockCdp({ url: IDLE });
  const ctx = await startApp(mock.port);
  try {
    const res = await ctx.send('/api/kiosk/display-type', 'POST', { value: 'Countdown Full' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.value, 'Countdown Full');
    const methods = mock.commandLog.map((c) => c.method);
    assert.ok(!methods.includes('Runtime.evaluate'), 'no PCO DOM clicks');
    assert.ok(!methods.includes('Emulation.setDeviceMetricsOverride'));

    const bad = await ctx.send('/api/kiosk/display-type', 'POST', { value: 'Nope' });
    assert.equal(bad.status, 502);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('select reports display type and navigates to /display (no PCO DOM)', async () => {
  const mock = await startMockCdp({ url: IDLE });
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
    assert.equal(sel.body.url, DISPLAY);
    assert.equal(sel.body.displayType.value, 'Lower Third');
    assert.equal(sel.body.displayType.applied, true);
    assert.equal(sel.body.displayType.source, 'service');
    assert.ok(mock.navigateLog.includes(DISPLAY));
    assert.ok(!mock.commandLog.some((c) => c.method === 'Runtime.evaluate'));

    const res2 = await ctx.send('/api/services', 'POST', { name: 'Wed', serviceId: '456' });
    const sel2 = await ctx.send('/api/select', 'POST', { id: res2.body.service.id });
    assert.equal(sel2.body.displayType.value, 'Countdown Full');
    assert.equal(sel2.body.displayType.source, 'default');
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('select applies the global default display type from settings', async () => {
  const mock = await startMockCdp({ url: IDLE });
  const ctx = await startApp(mock.port);
  try {
    const setRes = await ctx.send('/api/settings', 'PUT', {
      defaultDisplayType: 'Countdown Full',
      defaultTheme: 'light',
    });
    assert.equal(setRes.status, 200);
    assert.equal(setRes.body.defaultDisplayType, 'Countdown Full');
    assert.equal(setRes.body.defaultTheme, 'light');

    const res = await ctx.send('/api/services', 'POST', { name: 'Sun', serviceId: '777' });
    const sel = await ctx.send('/api/select', 'POST', { id: res.body.service.id });
    assert.equal(sel.status, 200);
    assert.equal(sel.body.displayType.value, 'Countdown Full');
    assert.equal(sel.body.displayType.applied, true);
    assert.equal(sel.body.displayType.source, 'default');

    const res2 = await ctx.send('/api/services', 'POST', { name: 'Sat', serviceId: '888', displayType: 'Lower Third' });
    const sel2 = await ctx.send('/api/select', 'POST', { id: res2.body.service.id });
    assert.equal(sel2.body.displayType.value, 'Lower Third');
    assert.equal(sel2.body.displayType.source, 'service');

    const bad = await ctx.send('/api/settings', 'PUT', { defaultTheme: 'pink' });
    assert.equal(bad.status, 400);
    const bad2 = await ctx.send('/api/settings', 'PUT', { defaultDisplayType: 'Nope' });
    assert.equal(bad2.status, 400);
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('POST /api/kiosk/settings/apply returns saved defaults without CDP', async () => {
  const mock = await startMockCdp({ url: IDLE });
  const ctx = await startApp(mock.port);
  try {
    let r = await ctx.send('/api/kiosk/settings/apply', 'POST');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.applied, { displayType: null, theme: null });

    await ctx.send('/api/settings', 'PUT', { defaultDisplayType: 'Countdown Full', defaultTheme: 'dark' });
    r = await ctx.send('/api/kiosk/settings/apply', 'POST');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.applied, { displayType: 'Countdown Full', theme: 'dark' });
    assert.ok(!mock.commandLog.some((c) => c.method === 'Runtime.evaluate'));
  } finally {
    await ctx.close();
    await mock.close();
  }
});
