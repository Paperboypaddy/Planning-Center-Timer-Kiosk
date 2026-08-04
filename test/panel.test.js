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

const IDLE = 'http://127.0.0.1:3001/nowplaying';

async function startApp(initial) {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-pw-')), 'config.json');
  if (initial) fs.writeFileSync(configPath, JSON.stringify(initial));
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: -1, idleUrl: IDLE, reconnectMs: 100 });
  const cec = { isAvailable: () => true, powerOn: async () => ({ ok: true }), powerOff: async () => ({ ok: true }), powerStatus: async () => ({ ok: true, power: null }) };
  const { app } = createApp({ config, kiosk, configPath, idleUrl: IDLE, logger: quietLogger, cec });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    config,
    configPath,
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

test('panel password change requires the current one and persists', async () => {
  const ctx = await startApp({ panelPassword: 'oldpass123' });
  try {
    let r = await ctx.send('/api/panel/password', 'PUT', { currentPassword: 'wrong', newPassword: 'newpass123' });
    assert.equal(r.status, 401);

    r = await ctx.send('/api/panel/password', 'PUT', { currentPassword: 'oldpass123', newPassword: 'short' });
    assert.equal(r.status, 400);

    r = await ctx.send('/api/panel/password', 'PUT', { currentPassword: 'oldpass123', newPassword: 'newpass123' });
    assert.equal(r.status, 200);
    assert.equal(ctx.config.panelPassword, 'newpass123');
    const onDisk = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8'));
    assert.equal(onDisk.panelPassword, 'newpass123');
  } finally {
    await ctx.close();
  }
});

test('panel password cannot be changed when managed by the environment', async () => {
  const old = process.env.KIOSK_PANEL_PASSWORD;
  process.env.KIOSK_PANEL_PASSWORD = 'envpass123';
  const ctx = await startApp({});
  try {
    const r = await ctx.send('/api/panel/password', 'PUT', { currentPassword: 'envpass123', newPassword: 'newpass123' });
    assert.equal(r.status, 400);
  } finally {
    if (old === undefined) delete process.env.KIOSK_PANEL_PASSWORD;
    else process.env.KIOSK_PANEL_PASSWORD = old;
    await ctx.close();
  }
});

test('state reports whether a panel password is set', async () => {
  const ctx = await startApp({ panelPassword: 'somepass123' });
  try {
    const r = await ctx.send('/api/state', 'GET');
    assert.equal(r.body.panelPasswordSet, true);
  } finally {
    await ctx.close();
  }
});
