'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { KioskDriver } = require('../server/kiosk');
const { startMockCdp } = require('./helpers/mock-cdp');

const IDLE = 'http://127.0.0.1:3001/nowplaying';
const SERVICE_URL = 'https://services.planningcenteronline.com/live/90197325';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeout = 5000, interval = 25 } = {}) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await delay(interval);
  }
}

test('connects to the tab, navigates, and skips same-URL navigation', async () => {
  const mock = await startMockCdp({ url: IDLE });
  const driver = new KioskDriver({ host: '127.0.0.1', port: mock.port, idleUrl: IDLE, reconnectMs: 100 });

  const r1 = await driver.navigate(SERVICE_URL);
  assert.equal(r1.skipped, false);
  assert.deepEqual(mock.navigateLog, [SERVICE_URL]);
  assert.equal(driver.connected, true);
  assert.equal(mock.targets[0].url, SERVICE_URL);

  const r2 = await driver.navigate(SERVICE_URL);
  assert.equal(r2.skipped, true, 'already on URL, should skip');
  assert.equal(mock.navigateLog.length, 1, 'no second navigation');

  driver.stop();
  await mock.close();
});

test('reconnects after the websocket drops and navigates again', async () => {
  const mock = await startMockCdp({ url: IDLE });
  const driver = new KioskDriver({ host: '127.0.0.1', port: mock.port, idleUrl: IDLE, reconnectMs: 100 });
  driver.start();

  let connects = 0;
  driver.on('connect', () => connects++);
  await waitFor(() => connects >= 1);

  mock.dropConnections();
  await waitFor(() => !driver.connected);

  await waitFor(() => connects >= 2);
  const r = await driver.navigate(SERVICE_URL);
  assert.equal(r.skipped, false);
  assert.deepEqual(mock.navigateLog, [SERVICE_URL]);

  driver.stop();
  await mock.close();
});

test('keeps retrying while there are no page targets, then connects', async () => {
  const mock = await startMockCdp({ empty: true });
  const driver = new KioskDriver({ host: '127.0.0.1', port: mock.port, idleUrl: IDLE, reconnectMs: 100 });
  driver.start();

  await assert.rejects(() => driver.navigate('http://x/'), /no page targets/);

  let connects = 0;
  driver.on('connect', () => connects++);
  mock.addTarget(IDLE);
  await waitFor(() => connects >= 1);

  const r = await driver.navigate(SERVICE_URL);
  assert.equal(r.skipped, false);

  driver.stop();
  await mock.close();
});

test('runExclusive serializes overlapping mutations', async () => {
  const mock = await startMockCdp({ url: IDLE });
  const driver = new KioskDriver({ host: '127.0.0.1', port: mock.port, idleUrl: IDLE, reconnectMs: 100 });
  const order = [];
  const a = driver.runExclusive(async () => {
    order.push('a-start');
    await delay(40);
    order.push('a-end');
  });
  const b = driver.runExclusive(async () => {
    order.push('b-start');
    await delay(10);
    order.push('b-end');
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  driver.stop();
  await mock.close();
});

test('stop aborts an in-flight connect before assigning client', async () => {
  const mock = await startMockCdp({ url: IDLE });
  const driver = new KioskDriver({ host: '127.0.0.1', port: mock.port, idleUrl: IDLE, reconnectMs: 100 });
  const connectPromise = driver.connect();
  driver.stop();
  await assert.rejects(() => connectPromise, /stopped/);
  assert.equal(driver.connected, false);
  await mock.close();
});
