'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createScheduler } = require('../server/scheduler');
const { waitFor, quietLogger } = require('./helpers/util');

const nowISO = () => new Date(Date.now()).toISOString();
const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();

function baseConfig() {
  return {
    services: [{ id: 's1', name: 'Sun', serviceId: '90197325', serviceTypeId: null }],
    tv: { autoOn: false, leadMinutes: 10 },
    reboot: { at: null },
  };
}

test('auto-on fires once within the lead window and does not repeat', async () => {
  const config = baseConfig();
  config.tv.autoOn = true;
  config.tv.leadMinutes = 10;
  const pco = {
    listPlanTimes: async () => [
      { timeType: 'service', startsAt: inMinutes(5) },
      { timeType: 'rehearsal', startsAt: inMinutes(90) },
    ],
    resolveServiceTypeId: async () => '10',
  };
  const cec = { calls: 0, powerOn: async () => { cec.calls += 1; return { ok: true }; } };
  let persisted = 0;
  const scheduler = createScheduler({
    config,
    persist: () => { persisted += 1; },
    pco,
    cec,
    apiKey: () => 'key',
    logger: quietLogger,
    intervalMs: 40,
    cacheMs: 1000,
  });
  scheduler.start();
  try {
    await waitFor(() => cec.calls >= 1);
    assert.equal(config.services[0].serviceTypeId, '10', 'serviceTypeId backfilled');
    assert.ok(persisted >= 1, 'persisted after backfill');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(cec.calls, 1, 'does not re-fire for the same event');
  } finally {
    scheduler.stop();
  }
});

test('auto-on is skipped when autoOn is disabled', async () => {
  const config = baseConfig(); // autoOn false
  const pco = {
    listPlanTimes: async () => [{ timeType: 'service', startsAt: inMinutes(5) }],
    resolveServiceTypeId: async () => '10',
  };
  const cec = { calls: 0, powerOn: async () => { cec.calls += 1; return { ok: true }; } };
  const scheduler = createScheduler({
    config,
    persist: () => {},
    pco,
    cec,
    apiKey: () => 'key',
    logger: quietLogger,
    intervalMs: 40,
    cacheMs: 1000,
  });
  scheduler.start();
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(cec.calls, 0);
  } finally {
    scheduler.stop();
  }
});

test('daily reboot fires once at the configured cron time', async () => {
  const config = baseConfig();
  const d = new Date();
  config.reboot.cron = `${d.getMinutes()} ${d.getHours()} * * *`;
  let reboots = 0;
  const scheduler = createScheduler({
    config,
    persist: () => {},
    pco: { listPlanTimes: async () => [], resolveServiceTypeId: async () => null },
    cec: { powerOn: async () => ({ ok: true }) },
    apiKey: () => 'key',
    logger: quietLogger,
    rebootFn: () => { reboots += 1; },
    intervalMs: 40,
    cacheMs: 1000,
  });
  scheduler.start();
  try {
    await waitFor(() => reboots >= 1);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reboots, 1, 'reboots once per cron occurrence');
  } finally {
    scheduler.stop();
  }
});

test('no reboot when no cron is configured or the cron is invalid', async () => {
  const config = baseConfig(); // reboot.cron null
  let reboots = 0;
  const scheduler = createScheduler({
    config,
    persist: () => {},
    pco: { listPlanTimes: async () => [], resolveServiceTypeId: async () => null },
    cec: { powerOn: async () => ({ ok: true }) },
    apiKey: () => 'key',
    logger: quietLogger,
    rebootFn: () => { reboots += 1; },
    intervalMs: 40,
    cacheMs: 1000,
  });
  scheduler.start();
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reboots, 0);
  } finally {
    scheduler.stop();
  }

  config.reboot.cron = '99 99 * * *'; // invalid
  reboots = 0;
  const s2 = createScheduler({
    config,
    persist: () => {},
    pco: { listPlanTimes: async () => [], resolveServiceTypeId: async () => null },
    cec: { powerOn: async () => ({ ok: true }) },
    apiKey: () => 'key',
    logger: quietLogger,
    rebootFn: () => { reboots += 1; },
    intervalMs: 40,
    cacheMs: 1000,
  });
  s2.start();
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reboots, 0, 'invalid cron does not reboot');
  } finally {
    s2.stop();
  }
});

void nowISO;
