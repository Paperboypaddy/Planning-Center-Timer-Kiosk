'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseFields } = require('../server/wifi');
const { loadConfig } = require('../server/config');
const { KioskDriver } = require('../server/kiosk');
const { createApp } = require('../server/app');
const { quietLogger } = require('./helpers/util');

test('parseFields splits nmcli terse output on unescaped colons', () => {
  assert.deepEqual(parseFields('*:ChurchWiFi:92:WPA2'), ['*', 'ChurchWiFi', '92', 'WPA2']);
  // Colons inside an SSID are backslash-escaped by nmcli.
  assert.deepEqual(parseFields(':My\\:Network:75:WPA2'), ['', 'My:Network', '75', 'WPA2']);
  assert.deepEqual(parseFields(''), ['']);
});

// A fake wifi module so the routes can be exercised without nmcli.
function fakeWifi(overrides = {}) {
  const calls = [];
  const wifi = {
    isAvailable: () => true,
    hardware: () => 'Raspberry Pi 4 Model B Rev 1.5',
    listNetworks: async () => ({
      ok: true,
      networks: [{ inUse: false, ssid: 'ChurchWiFi', signal: 92, security: 'WPA2' }],
    }),
    connectNetwork: async (ssid, password) => {
      calls.push({ ssid, password });
      return { ok: true };
    },
    status: async () => ({ supported: true, connectedSsid: 'ChurchWiFi' }),
  };
  return Object.assign(wifi, overrides, { calls });
}

async function startApp(wifi) {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-wifi-')), 'config.json');
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: -1, idleUrl: 'http://127.0.0.1:3001/nowplaying', reconnectMs: 100 });
  const cec = { isAvailable: () => true, powerOn: async () => ({ ok: true }), powerOff: async () => ({ ok: true }), powerStatus: async () => ({ ok: true, power: null }) };
  const { app } = createApp({ config, kiosk, configPath, idleUrl: 'http://127.0.0.1:3001/nowplaying', logger: quietLogger, cec, wifi });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => {
      kiosk.stop();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('wifi routes list networks, connect, and report status', async () => {
  const wifi = fakeWifi();
  const ctx = await startApp(wifi);
  try {
    let res = await fetch(`${ctx.base}/api/wifi/networks`);
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.networks[0].ssid, 'ChurchWiFi');
    assert.equal(body.networks[0].signal, 92);

    res = await fetch(`${ctx.base}/api/wifi/status`);
    body = await res.json();
    assert.equal(body.supported, true);
    assert.equal(body.connectedSsid, 'ChurchWiFi');

    res = await fetch(`${ctx.base}/api/wifi/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: 'ChurchWiFi', password: 'hunter2' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(wifi.calls, [{ ssid: 'ChurchWiFi', password: 'hunter2' }]);
  } finally {
    await ctx.close();
  }
});

test('state exposes wifi support so the panel can hide the section', async () => {
  const wifi = fakeWifi();
  const ctx = await startApp(wifi);
  try {
    const res = await fetch(`${ctx.base}/api/state`);
    const body = await res.json();
    assert.deepEqual(body.wifi, { supported: true });
  } finally {
    await ctx.close();
  }
});

test('unsupported devices report wifi.supported false and reject connects', async () => {
  const wifi = fakeWifi({
    isAvailable: () => false,
    connectNetwork: async () => ({ ok: false, error: 'wifi is not supported on this device' }),
  });
  const ctx = await startApp(wifi);
  try {
    const state = await (await fetch(`${ctx.base}/api/state`)).json();
    assert.equal(state.wifi.supported, false);

    const res = await fetch(`${ctx.base}/api/wifi/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: 'X', password: 'y' }),
    });
    assert.equal(res.status, 502);
  } finally {
    await ctx.close();
  }
});
