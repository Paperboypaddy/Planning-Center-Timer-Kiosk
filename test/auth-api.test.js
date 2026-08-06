'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

const { loadConfig } = require('../server/config');
const { KioskDriver } = require('../server/kiosk');
const { createApp } = require('../server/app');
const { startMockCdp } = require('./helpers/mock-cdp');
const { quietLogger } = require('./helpers/util');

const IDLE = 'http://127.0.0.1:3001/nowplaying';

async function startApp(initial) {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-auth-')), 'config.json');
  if (initial) fs.writeFileSync(configPath, JSON.stringify(initial));
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: -1, idleUrl: IDLE, reconnectMs: 100 });
  const cec = { isAvailable: () => true, powerOn: async () => ({ ok: true }), powerOff: async () => ({ ok: true }), powerStatus: async () => ({ ok: true, power: null }) };
  const { app } = createApp({ config, kiosk, configPath, idleUrl: IDLE, logger: quietLogger, cec });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  return {
    config,
    configPath,
    send: async (p, method, body, extraHeaders = {}) => {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, extraHeaders);
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: res.status, body: await res.json() };
    },
    close: () => {
      kiosk.stop();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('first-run setup creates the admin account and logs in', async () => {
  const ctx = await startApp({});
  try {
    let r = await ctx.send('/api/auth/status', 'GET');
    assert.deepEqual(r.body, { authenticated: false, setupRequired: true });

    r = await ctx.send('/api/auth/setup', 'POST', { username: 'admin', password: 'short' });
    assert.equal(r.status, 400, 'password too short');

    r = await ctx.send('/api/auth/setup', 'POST', { username: 'admin', password: 'correcthorse' });
    assert.equal(r.status, 200);
    assert.equal(r.body.authenticated, true);
    assert.equal(ctx.config.admin.username, 'admin');
    assert.ok(ctx.config.admin.passwordHash.startsWith('$2'));

    // A second setup attempt is rejected.
    r = await ctx.send('/api/auth/setup', 'POST', { username: 'other', password: 'anotherpass' });
    assert.equal(r.status, 400);
  } finally {
    await ctx.close();
  }
});

test('login/logout round-trip with a session cookie', async () => {
  const hash = bcrypt.hashSync('mypassword1', 10);
  const ctx = await startApp({ admin: { username: 'admin', passwordHash: hash } });
  try {
    let r = await ctx.send('/api/auth/status', 'GET');
    assert.deepEqual(r.body, { authenticated: false, setupRequired: false });

    r = await ctx.send('/api/auth/login', 'POST', { username: 'admin', password: 'wrong' });
    assert.equal(r.status, 401);

    r = await ctx.send('/api/auth/login', 'POST', { username: 'admin', password: 'mypassword1' });
    assert.equal(r.status, 200);

    r = await ctx.send('/api/auth/status', 'GET');
    assert.equal(r.body.authenticated, true);

    r = await ctx.send('/api/auth/logout', 'POST');
    assert.equal(r.status, 200);

    r = await ctx.send('/api/auth/status', 'GET');
    assert.equal(r.body.authenticated, false);
  } finally {
    await ctx.close();
  }
});

test('proxied LAN clients are not treated as loopback', async () => {
  const hash = bcrypt.hashSync('mypassword1', 10);
  const ctx = await startApp({ admin: { username: 'admin', passwordHash: hash } });
  try {
    // Behind Caddy the app sees a loopback peer plus an X-Forwarded-For header
    // with the real client IP. Without a session cookie this must be rejected.
    const r = await ctx.send('/api/state', 'GET', null, { 'X-Forwarded-For': '192.168.1.50' });
    assert.equal(r.status, 401);
    // The same client can still log in normally.
    const login = await ctx.send('/api/auth/login', 'POST', { username: 'admin', password: 'mypassword1' }, { 'X-Forwarded-For': '192.168.1.50' });
    assert.equal(login.status, 200);
  } finally {
    await ctx.close();
  }
});

test('login endpoint rate-limits repeated failures per client', async () => {
  const hash = bcrypt.hashSync('mypassword1', 10);
  const ctx = await startApp({ admin: { username: 'admin', passwordHash: hash } });
  try {
    const lan = { 'X-Forwarded-For': '192.168.1.50' };
    for (let i = 0; i < 5; i += 1) {
      const r = await ctx.send('/api/auth/login', 'POST', { username: 'admin', password: 'wrong' }, lan);
      assert.equal(r.status, 401);
    }
    const locked = await ctx.send('/api/auth/login', 'POST', { username: 'admin', password: 'mypassword1' }, lan);
    assert.equal(locked.status, 429, 'correct password also refused while locked out');
    // A different client IP is unaffected.
    const other = await ctx.send('/api/auth/login', 'POST', { username: 'admin', password: 'mypassword1' }, { 'X-Forwarded-For': '192.168.1.99' });
    assert.equal(other.status, 200);
  } finally {
    await ctx.close();
  }
});

test('admin password change verifies the current password and persists a new hash', async () => {
  const hash = bcrypt.hashSync('oldpass123', 10);
  const ctx = await startApp({ admin: { username: 'admin', passwordHash: hash } });
  try {
    let r = await ctx.send('/api/panel/password', 'PUT', { currentPassword: 'wrong', newPassword: 'newpass123' });
    assert.equal(r.status, 401);

    r = await ctx.send('/api/panel/password', 'PUT', { currentPassword: 'oldpass123', newPassword: 'short' });
    assert.equal(r.status, 400);

    r = await ctx.send('/api/panel/password', 'PUT', { currentPassword: 'oldpass123', newPassword: 'newpass123' });
    assert.equal(r.status, 200);
    assert.ok(bcrypt.compareSync('newpass123', ctx.config.admin.passwordHash));
  } finally {
    await ctx.close();
  }
});

test('state reports whether an admin account is configured', async () => {
  const ctx = await startApp({ admin: { username: 'admin', passwordHash: bcrypt.hashSync('x'.repeat(8), 10) } });
  try {
    const r = await ctx.send('/api/state', 'GET');
    assert.equal(r.body.adminConfigured, true);
  } finally {
    await ctx.close();
  }
});

test('settings persist the prerelease update toggle', async () => {
  const ctx = await startApp({});
  try {
    let r = await ctx.send('/api/settings', 'PUT', { updatePrereleases: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.updatePrereleases, true);
    assert.equal(ctx.config.update.includePrereleases, true);

    const state = await ctx.send('/api/state', 'GET');
    assert.equal(state.body.updatePrereleases, true);
  } finally {
    await ctx.close();
  }
});
