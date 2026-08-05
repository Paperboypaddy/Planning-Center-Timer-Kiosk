'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { defaults, normalize, loadConfig, saveConfig, DEFAULT_TEMPLATE } = require('../server/config');

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-')), name);
}

test('defaults has the verified PCO live URL template', () => {
  assert.equal(DEFAULT_TEMPLATE, 'https://services.planningcenteronline.com/live/{serviceId}');
  assert.deepEqual(defaults(), {
    urlTemplate: DEFAULT_TEMPLATE,
    activeServiceId: null,
    services: [],
    defaultDisplayType: null,
    defaultTheme: null,
    tv: { autoOn: false, leadMinutes: 30 },
    reboot: { cron: null },
    admin: { username: null, passwordHash: null },
    pco: { apiKey: null },
  });
});

test('normalize keeps display defaults, TV and reboot settings', () => {
  const cfg = normalize({
    defaultDisplayType: 'Lower Third',
    defaultTheme: 'dark',
    tv: { autoOn: true, leadMinutes: 45 },
    reboot: { cron: '30 4 * * *' },
  });
  assert.equal(cfg.defaultDisplayType, 'Lower Third');
  assert.equal(cfg.defaultTheme, 'dark');
  assert.equal(cfg.tv.autoOn, true);
  assert.equal(cfg.tv.leadMinutes, 45);
  assert.equal(cfg.reboot.cron, '30 4 * * *');
  assert.equal(normalize({ defaultTheme: 'pink' }).defaultTheme, null);
  assert.equal(normalize({ reboot: { cron: 'garbage' } }).reboot.cron, 'garbage');
  assert.equal(normalize({ defaultDisplayType: 42 }).defaultDisplayType, null);
});

test('normalize migrates the old HH:MM reboot.at into a daily cron', () => {
  assert.equal(normalize({ reboot: { at: '04:30' } }).reboot.cron, '30 4 * * *');
  assert.equal(normalize({ reboot: { at: null } }).reboot.cron, null);
});

test('normalize keeps serviceTypeId on services', () => {
  const cfg = normalize({ services: [{ id: 'a', serviceId: '1', serviceTypeId: '100' }] });
  assert.equal(cfg.services[0].serviceTypeId, '100');
  assert.equal(normalize({ services: [{ id: 'a', serviceId: '1' }] }).services[0].serviceTypeId, null);
});

test('normalize keeps the admin account', () => {
  const cfg = normalize({ admin: { username: 'admin', passwordHash: '$2a$10$abc' } });
  assert.equal(cfg.admin.username, 'admin');
  assert.equal(cfg.admin.passwordHash, '$2a$10$abc');
  assert.deepEqual(normalize({}).admin, { username: null, passwordHash: null });
});

test('normalize keeps well-formed services', () => {
  const cfg = normalize({
    urlTemplate: 'https://x/{serviceId}',
    activeServiceId: 'a',
    services: [
      { id: 'a', name: 'Sunday 9am', serviceId: '111', displayType: 'countdown' },
      { id: 'b', name: 'Wed night', serviceId: '222' },
    ],
  });
  assert.equal(cfg.activeServiceId, 'a');
  assert.equal(cfg.services.length, 2);
  assert.equal(cfg.services[0].displayType, 'countdown');
  assert.equal(cfg.services[1].displayType, '');
});

test('normalize drops malformed services and assigns missing ids', () => {
  const cfg = normalize({
    services: [
      { name: 'no id', serviceId: '' },
      { name: 'ok', serviceId: '123' },
      null,
      'junk',
    ],
  });
  assert.equal(cfg.services.length, 1);
  assert.equal(cfg.services[0].name, 'ok');
  assert.ok(cfg.services[0].id);
});

test('normalize clears activeServiceId when it does not match a service', () => {
  const cfg = normalize({ activeServiceId: 'missing', services: [{ id: 'a', serviceId: '1' }] });
  assert.equal(cfg.activeServiceId, null);
});

test('normalize ignores bad urlTemplate', () => {
  assert.equal(normalize({ urlTemplate: 42 }).urlTemplate, DEFAULT_TEMPLATE);
  assert.equal(normalize({ urlTemplate: '   ' }).urlTemplate, DEFAULT_TEMPLATE);
});

test('loadConfig returns defaults when file is missing or corrupt', () => {
  const missing = tmpFile('nope.json');
  assert.deepEqual(loadConfig(missing), defaults());
  const corrupt = tmpFile('corrupt.json');
  fs.writeFileSync(corrupt, 'not json{');
  assert.deepEqual(loadConfig(corrupt), defaults());
});

test('saveConfig then loadConfig round-trips', () => {
  const file = tmpFile('cfg.json');
  const cfg = normalize({
    activeServiceId: 'a',
    services: [{ id: 'a', name: 'Sunday 9am', serviceId: '90197325' }],
  });
  saveConfig(file, cfg);
  const loaded = loadConfig(file);
  assert.deepEqual(loaded, cfg);
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'temp file cleaned up');
});
