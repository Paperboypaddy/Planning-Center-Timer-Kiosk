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

async function startApp(cec) {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-tv-')), 'config.json');
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: -1, idleUrl: IDLE, reconnectMs: 100 });
  const { app } = createApp({ config, kiosk, configPath, idleUrl: IDLE, logger: quietLogger, cec });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    config,
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

test('TV endpoints report status and send on/off via CEC', async () => {
  const cec = {
    isAvailable: () => true,
    powerOnCalls: 0,
    powerOffCalls: 0,
    powerOn: async () => { cec.powerOnCalls += 1; return { ok: true }; },
    powerOff: async () => { cec.powerOffCalls += 1; return { ok: true }; },
    powerStatus: async () => ({ ok: true, power: 'on' }),
  };
  const ctx = await startApp(cec);
  try {
    let r = await ctx.send('/api/tv/status', 'GET');
    assert.equal(r.status, 200);
    assert.equal(r.body.available, true);
    assert.equal(r.body.power, 'on');

    r = await ctx.send('/api/tv/on', 'POST');
    assert.equal(r.status, 200);
    assert.equal(cec.powerOnCalls, 1);

    r = await ctx.send('/api/tv/off', 'POST');
    assert.equal(r.status, 200);
    assert.equal(cec.powerOffCalls, 1);
  } finally {
    await ctx.close();
  }
});

test('TV status shows unavailable when CEC is missing, and off command errors', async () => {
  const cec = {
    isAvailable: () => false,
    powerOn: async () => ({ ok: false, error: 'cec-client not installed' }),
    powerOff: async () => ({ ok: false, error: 'cec-client not installed' }),
    powerStatus: async () => ({ ok: false, power: null, error: 'cec-client not installed' }),
  };
  const ctx = await startApp(cec);
  try {
    const r = await ctx.send('/api/tv/status', 'GET');
    assert.equal(r.body.available, false);
    const on = await ctx.send('/api/tv/on', 'POST');
    assert.equal(on.status, 502);
  } finally {
    await ctx.close();
  }
});

test('settings persist TV auto-on, lead minutes and reboot cron', async () => {
  const cec = { isAvailable: () => true, powerOn: async () => ({ ok: true }), powerOff: async () => ({ ok: true }), powerStatus: async () => ({ ok: true, power: null }) };
  const ctx = await startApp(cec);
  try {
    const r = await ctx.send('/api/settings', 'PUT', { tvAutoOn: true, tvLeadMinutes: 45, rebootCron: '30 4 * * *' });
    assert.equal(r.status, 200);
    assert.equal(r.body.tvAutoOn, true);
    assert.equal(r.body.tvLeadMinutes, 45);
    assert.equal(r.body.rebootCron, '30 4 * * *');
    assert.equal(ctx.config.tv.autoOn, true);
    assert.equal(ctx.config.reboot.cron, '30 4 * * *');

    // The old "HH:MM" rebootAt still works (converted to a daily cron).
    const compat = await ctx.send('/api/settings', 'PUT', { rebootAt: '06:15' });
    assert.equal(compat.body.rebootCron, '15 6 * * *');

    // Invalid cron rejected
    const bad = await ctx.send('/api/settings', 'PUT', { rebootCron: 'not a cron' });
    assert.equal(bad.status, 400);
    const bad2 = await ctx.send('/api/settings', 'PUT', { tvLeadMinutes: -5 });
    assert.equal(bad2.status, 400);

    // Clearing the reboot schedule
    const clear = await ctx.send('/api/settings', 'PUT', { rebootCron: null });
    assert.equal(clear.body.rebootCron, null);
    assert.equal(ctx.config.reboot.cron, null);
  } finally {
    await ctx.close();
  }
});

test('state exposes TV and reboot config', async () => {
  const cec = { isAvailable: () => true, powerOn: async () => ({ ok: true }), powerOff: async () => ({ ok: true }), powerStatus: async () => ({ ok: true, power: 'standby' }) };
  const ctx = await startApp(cec);
  try {
    const r = await ctx.send('/api/state', 'GET');
    assert.equal(r.body.tv.available, true);
    assert.equal(r.body.tv.autoOn, false);
    assert.equal(r.body.tv.leadMinutes, 30);
    assert.equal(r.body.reboot.cron, null);
  } finally {
    await ctx.close();
  }
});
