'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { computeDisplayState, formatClock, createLiveDisplay } = require('../server/live-display');
const { fetchLiveSnapshot } = require('../server/pco');
const { loadConfig } = require('../server/config');
const { KioskDriver } = require('../server/kiosk');
const { createApp } = require('../server/app');
const { startMockCdp } = require('./helpers/mock-cdp');
const { startMockPco } = require('./helpers/mock-pco');
const { quietLogger } = require('./helpers/util');

test('formatClock pads minutes and marks overtime', () => {
  assert.deepEqual(formatClock(65_000), { text: '1:05', overtime: false });
  assert.deepEqual(formatClock(3_661_000), { text: '1:01:01', overtime: false });
  assert.deepEqual(formatClock(-5_000), { text: '-0:05', overtime: true });
});

test('computeDisplayState waiting without LIVE / without current item', () => {
  const waiting = computeDisplayState(null);
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.waitingMessage, /Waiting for Services LIVE/);

  const open = computeDisplayState({
    liveId: 'L1',
    currentItemTime: null,
    items: [],
    // no serviceStartsAt → nothing to count
  });
  assert.equal(open.status, 'waiting');
  assert.match(open.waitingMessage, /advance to an item/i);
});

test('computeDisplayState pre-service countdown to start + end-on-time caption', () => {
  const now = Date.parse('2026-08-06T18:00:00Z');
  const snap = {
    liveId: '89986844',
    currentItemTime: null,
    items: [
      { id: 'pre', sequence: 1, length: 360, servicePosition: 'pre', itemType: 'item' },
      { id: 'a', sequence: 2, length: 360, servicePosition: 'during', itemType: 'item' },
      { id: 'b', sequence: 3, length: 5347, servicePosition: 'during', itemType: 'item' },
      { id: 'h', sequence: 0, length: 100, servicePosition: 'during', itemType: 'header' },
    ],
    serviceStartsAt: '2026-08-09T16:15:00Z',
    serviceEndsAt: '2026-08-09T17:15:00Z',
  };
  const state = computeDisplayState(snap, { now });
  assert.equal(state.status, 'live');
  assert.equal(state.mode, 'scheduled');
  assert.ok(state.remainingMs > 2 * 86400 * 1000);
  assert.match(state.clockText, /^2:/);
  assert.equal(state.overtime, false);
  assert.match(state.caption, /Service should end on time at/);
  assert.equal(Date.parse(state.projectedEndAt), Date.parse('2026-08-09T16:15:00Z') + (360 + 5347) * 1000);
});

test('computeDisplayState scheduled overtime after service start', () => {
  const now = Date.parse('2026-08-09T16:20:00Z');
  const state = computeDisplayState({
    liveId: '1',
    currentItemTime: null,
    items: [{ id: 'a', sequence: 1, length: 600, servicePosition: 'during', itemType: 'item' }],
    serviceStartsAt: '2026-08-09T16:15:00Z',
  }, { now });
  assert.equal(state.status, 'live');
  assert.equal(state.mode, 'scheduled');
  assert.equal(state.remainingMs, -5 * 60 * 1000);
  assert.equal(state.overtime, true);
  assert.equal(state.clockText, '-5:00');
});

test('computeDisplayState item overtime from live_start + plan length when live_end_at null', () => {
  const now = Date.parse('2026-08-06T04:00:00Z');
  const state = computeDisplayState({
    liveId: '90197325',
    currentItemTime: {
      id: 'it1',
      itemId: 'item-sg',
      length: 0,
      liveStartAt: '2026-08-06T03:09:54Z',
      liveEndAt: null,
    },
    items: [{ id: 'item-sg', sequence: 12, length: 2100, servicePosition: 'during', itemType: 'item' }],
    serviceStartsAt: '2026-08-06T02:30:00Z',
  }, { now });
  // deadline = 03:09:54 + 2100s = 03:44:54 → 15m 6s overdue at 04:00
  assert.equal(state.status, 'live');
  assert.equal(state.mode, 'item');
  assert.equal(state.overtime, true);
  assert.equal(state.remainingMs, Date.parse('2026-08-06T03:44:54Z') - now);
  assert.match(state.clockText, /^-/);
});

test('formatClock includes days for long countdowns', () => {
  assert.deepEqual(formatClock(3 * 86400 * 1000 + 5 * 1000), { text: '3:00:00:05', overtime: false });
});

test('computeDisplayState remaining + caption from later item lengths', () => {
  const now = Date.parse('2026-08-09T09:02:00-05:00');
  const snap = {
    liveId: 'L1',
    currentItemTime: {
      id: 'it1',
      itemId: 'item-a',
      liveEndAt: '2026-08-09T09:05:00-05:00',
      length: 300,
    },
    items: [
      { id: 'item-a', sequence: 1, length: 300 },
      { id: 'item-b', sequence: 2, length: 1800 },
      { id: 'item-c', sequence: 3, length: 300 },
    ],
    serviceEndsAt: '2026-08-09T10:50:00-05:00',
  };
  const state = computeDisplayState(snap, { now, displayType: 'Countdown Full', theme: 'dark' });
  assert.equal(state.status, 'live');
  assert.equal(state.remainingMs, 3 * 60 * 1000);
  assert.equal(state.clockText, '3:00');
  assert.equal(state.overtime, false);
  // now + 3m remaining + 1800s + 300s = 09:02 + 3m + 35m = 09:40
  assert.match(state.caption, /Service should end on time at/);
  assert.equal(Date.parse(state.projectedEndAt), Date.parse('2026-08-09T09:40:00-05:00'));
});

test('computeDisplayState overtime counts up in red-friendly form', () => {
  const now = Date.parse('2026-08-09T09:06:00-05:00');
  const snap = {
    liveId: 'L1',
    currentItemTime: {
      id: 'it1',
      itemId: 'item-a',
      liveEndAt: '2026-08-09T09:05:00-05:00',
    },
    items: [{ id: 'item-a', sequence: 1, length: 300 }],
  };
  const state = computeDisplayState(snap, { now });
  assert.equal(state.overtime, true);
  assert.equal(state.clockText, '-1:00');
  assert.equal(state.remainingMs, -60_000);
});

test('fetchLiveSnapshot reads mock Live + items', async () => {
  const mock = await startMockPco();
  const prev = process.env.KIOSK_PCO_API_BASE;
  process.env.KIOSK_PCO_API_BASE = `http://127.0.0.1:${mock.port}/services/v2`;
  try {
    const snap = await fetchLiveSnapshot('90197325', '10', { apiKey: 'tok' });
    assert.equal(snap.liveId, 'live-90197325');
    assert.equal(snap.currentItemTime.itemId, 'item-a');
    assert.equal(snap.items.length, 3);
    assert.equal(snap.serviceEndsAt, '2026-08-09T10:50:00-05:00');
  } finally {
    if (prev === undefined) delete process.env.KIOSK_PCO_API_BASE;
    else process.env.KIOSK_PCO_API_BASE = prev;
    await mock.close();
  }
});

test('GET /display and /api/display/state; select navigates to /display', async () => {
  const mockCdp = await startMockCdp({ url: 'http://127.0.0.1:3999/nowplaying' });
  const mockPco = await startMockPco();
  const prev = process.env.KIOSK_PCO_API_BASE;
  process.env.KIOSK_PCO_API_BASE = `http://127.0.0.1:${mockPco.port}/services/v2`;

  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-disp-')), 'config.json');
  const config = loadConfig(configPath);
  config.pco.apiKey = 'test-key';
  const idle = 'http://127.0.0.1:3999/nowplaying';
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: mockCdp.port, idleUrl: idle, reconnectMs: 100 });
  const liveDisplay = createLiveDisplay({
    getApiKey: () => 'test-key',
    logger: quietLogger,
    pollMs: 50,
  });
  const { app } = createApp({
    config,
    kiosk,
    configPath,
    idleUrl: idle,
    logger: quietLogger,
    liveDisplay,
  });
  kiosk.start();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const page = await fetch(`${base}/display`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /display\.js/);

    const snap = await fetch(`${base}/api/display/state`).then((r) => r.json());
    assert.equal(snap.status, 'waiting');

    const created = await fetch(`${base}/api/services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Sunday', serviceId: '90197325' }),
    }).then((r) => r.json());
    // Seed serviceTypeId so the poller can hit Live without resolve race.
    config.services[0].serviceTypeId = '10';

    const sel = await fetch(`${base}/api/select`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: created.service.id }),
    });
    assert.equal(sel.status, 200);
    const body = await sel.json();
    assert.equal(body.url, 'http://127.0.0.1:3999/display');
    assert.ok(mockCdp.navigateLog.includes('http://127.0.0.1:3999/display'));

    // Wait for a poll tick with Live data.
    let liveState = null;
    for (let i = 0; i < 40; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 50));
      liveState = liveDisplay.getState();
      if (liveState.status === 'live') break;
    }
    assert.equal(liveState.status, 'live');
    assert.ok(liveState.clockText);
    assert.match(liveState.caption, /Service should end on time at/);

    await fetch(`${base}/api/deselect`, { method: 'POST' });
    assert.equal(liveDisplay.getState().status, 'waiting');
    assert.equal(mockCdp.navigateLog[mockCdp.navigateLog.length - 1], idle);
  } finally {
    liveDisplay.stop();
    kiosk.stop();
    await new Promise((r) => server.close(r));
    await mockCdp.close();
    await mockPco.close();
    if (prev === undefined) delete process.env.KIOSK_PCO_API_BASE;
    else process.env.KIOSK_PCO_API_BASE = prev;
  }
});

test('tick after stop does not throw when an in-flight poll rejects', async () => {
  let rejectFetch;
  const fetchSnapshot = () => new Promise((_, reject) => { rejectFetch = reject; });
  const live = createLiveDisplay({
    getApiKey: () => 'key',
    logger: quietLogger,
    pollMs: 60_000,
    fetchSnapshot,
  });
  live.start({
    planId: '1',
    serviceTypeId: '2',
    displayType: 'Countdown Full',
    theme: 'dark',
    serviceName: 'Test',
  });
  // Let the first tick capture target and start the fetch.
  await new Promise((r) => setImmediate(r));
  live.stop();
  rejectFetch(Object.assign(new Error('Planning Center API error (HTTP 404)'), { code: 'error' }));
  await new Promise((r) => setImmediate(r));
  assert.equal(live.getState().status, 'waiting');
  live.stop();
});
