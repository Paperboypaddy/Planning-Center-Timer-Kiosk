'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { listPlans, PcoError } = require('../server/pco');
const { startMockPco } = require('./helpers/mock-pco');

const before = beforeEach || ((fn) => fn);

before(() => {
  delete process.env.KIOSK_PCO_API_BASE;
});

test('listPlans returns normalized upcoming plans across service types', async () => {
  const mock = await startMockPco();
  process.env.KIOSK_PCO_API_BASE = `http://127.0.0.1:${mock.port}/services/v2`;
  try {
    const plans = await listPlans({ apiKey: 'token-123' });
    assert.equal(plans.length, 3);
    assert.deepEqual(plans.map((p) => p.id), ['90197325', '90211110', '90197331']);
    assert.equal(plans[0].serviceTypeName, 'Sunday 9am');
    assert.equal(plans[0].shortDates, 'Aug 9, 9:00 AM');
    assert.equal(plans[1].serviceTypeName, 'Wednesday Night');
    // plans are sorted by sort_date
    assert.ok(plans[0].sortDate <= plans[1].sortDate);
  } finally {
    delete process.env.KIOSK_PCO_API_BASE;
    await mock.close();
  }
});

test('listPlans sends Bearer auth for a personal access token', async () => {
  const mock = await startMockPco({ requiredAuth: 'pat-abc123' });
  process.env.KIOSK_PCO_API_BASE = `http://127.0.0.1:${mock.port}/services/v2`;
  try {
    const plans = await listPlans({ apiKey: 'pat-abc123' });
    assert.equal(plans.length, 3);
  } finally {
    delete process.env.KIOSK_PCO_API_BASE;
    await mock.close();
  }
});

test('listPlans sends Basic auth for app_id:secret', async () => {
  const mock = await startMockPco({ requiredAuth: 'app_123:secret_456' });
  process.env.KIOSK_PCO_API_BASE = `http://127.0.0.1:${mock.port}/services/v2`;
  try {
    const plans = await listPlans({ apiKey: 'app_123:secret_456' });
    assert.equal(plans.length, 3);
  } finally {
    delete process.env.KIOSK_PCO_API_BASE;
    await mock.close();
  }
});

test('listPlans throws a PcoError with code unauthorized on 401', async () => {
  const mock = await startMockPco({ requiredAuth: 'correct' });
  process.env.KIOSK_PCO_API_BASE = `http://127.0.0.1:${mock.port}/services/v2`;
  try {
    await assert.rejects(() => listPlans({ apiKey: 'wrong' }), (err) => {
      assert.ok(err instanceof PcoError);
      assert.equal(err.code, 'unauthorized');
      return true;
    });
  } finally {
    delete process.env.KIOSK_PCO_API_BASE;
    await mock.close();
  }
});

test('listPlans throws a PcoError with code rate_limited on 429', async () => {
  const mock = await startMockPco({ rateLimited: true });
  process.env.KIOSK_PCO_API_BASE = `http://127.0.0.1:${mock.port}/services/v2`;
  try {
    await assert.rejects(() => listPlans({ apiKey: 'x' }), (err) => {
      assert.ok(err instanceof PcoError);
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.retryAfter, 10);
      return true;
    });
  } finally {
    delete process.env.KIOSK_PCO_API_BASE;
    await mock.close();
  }
});
