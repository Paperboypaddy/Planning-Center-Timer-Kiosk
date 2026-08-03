'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../server/config');
const { KioskDriver } = require('../server/kiosk');
const { createApp } = require('../server/app');
const { startMockCdp } = require('./helpers/mock-cdp');
const { waitFor, quietLogger } = require('./helpers/util');

const IDLE = 'http://127.0.0.1:3999/nowplaying';
const DEFAULT_TEMPLATE = 'https://services.planningcenteronline.com/live/{serviceId}';

async function startApp(cdpPort) {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-int-')), 'config.json');
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: cdpPort, idleUrl: IDLE, reconnectMs: 100 });
  const { app } = createApp({ config, kiosk, configPath, idleUrl: IDLE, logger: quietLogger });
  kiosk.start();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    config,
    kiosk,
    configPath,
    base,
    get: (p) => fetch(base + p).then((r) => r.json()),
    send: (p, method, body) =>
      fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }),
    close: () => {
      kiosk.stop();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('services CRUD, template, select/deselect drive the kiosk tab', async () => {
  const mock = await startMockCdp({ url: IDLE });
  const appCtx = await startApp(mock.port);

  try {
    let state = await appCtx.get('/api/state');
    assert.equal(state.services.length, 0);
    assert.equal(state.urlTemplate, DEFAULT_TEMPLATE);

    // Add a service
    let res = await appCtx.send('/api/services', 'POST', { name: 'Sunday 9am', serviceId: '90197325' });
    assert.equal(res.status, 201);
    const service = (await res.json()).service;
    assert.ok(service.id);

    // Update the URL template
    res = await appCtx.send('/api/url-template', 'PUT', {
      urlTemplate: 'https://services.planningcenteronline.com/live/{serviceId}?view={displayType}',
    });
    assert.equal(res.status, 200);

    // Select -> kiosk navigated to the rendered URL, active recorded + persisted
    res = await appCtx.send('/api/select', 'POST', { id: service.id });
    assert.equal(res.status, 200);
    const expected = 'https://services.planningcenteronline.com/live/90197325?view=';
    assert.deepEqual(mock.navigateLog, [expected]);

    state = await appCtx.get('/api/state');
    assert.equal(state.activeServiceId, service.id);
    const onDisk = JSON.parse(fs.readFileSync(appCtx.configPath, 'utf8'));
    assert.equal(onDisk.activeServiceId, service.id);
    assert.equal(onDisk.services.length, 1);

    // Selecting the already-active service skips the navigation round-trip
    res = await appCtx.send('/api/select', 'POST', { id: service.id });
    assert.equal((await res.json()).skipped, true);
    assert.equal(mock.navigateLog.length, 1);

    // Update the service
    res = await appCtx.send(`/api/services/${service.id}`, 'PUT', { name: 'Sunday 11am', displayType: 'countdown' });
    assert.equal(res.status, 200);
    state = await appCtx.get('/api/state');
    assert.equal(state.services[0].name, 'Sunday 11am');
    assert.equal(state.services[0].displayType, 'countdown');

    // Deselect -> back to idle page
    res = await appCtx.send('/api/deselect', 'POST');
    assert.equal(res.status, 200);
    assert.equal(mock.navigateLog[mock.navigateLog.length - 1], IDLE);
    state = await appCtx.get('/api/state');
    assert.equal(state.activeServiceId, null);

    // Delete the service
    res = await appCtx.send(`/api/services/${service.id}`, 'DELETE');
    assert.equal(res.status, 200);
    state = await appCtx.get('/api/state');
    assert.equal(state.services.length, 0);

    // Validation
    res = await appCtx.send('/api/services', 'POST', { name: 'x', serviceId: '  ' });
    assert.equal(res.status, 400);
    res = await appCtx.send('/api/url-template', 'PUT', { urlTemplate: '' });
    assert.equal(res.status, 400);
  } finally {
    await appCtx.close();
    await mock.close();
  }
});

test('select while kiosk is down returns 502, records the selection, and self-heals on reconnect', async () => {
  // Reserve then free a port so nothing is listening there yet.
  const holder = http.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const deadPort = holder.address().port;
  await new Promise((resolve) => holder.close(resolve));

  const appCtx = await startApp(deadPort);

  try {
    const res = await appCtx.send('/api/services', 'POST', { name: 'Wednesday', serviceId: '555123' });
    const service = (await res.json()).service;

    const sel = await appCtx.send('/api/select', 'POST', { id: service.id });
    assert.equal(sel.status, 502);
    assert.equal((await sel.json()).activeServiceId, service.id);

    // Chromium "comes up" on the same port; the driver reconnects and the
    // server re-navigates the tab to the recorded active service.
    const mock = await startMockCdp({ url: IDLE, port: deadPort });
    try {
      await waitFor(() => mock.navigateLog.length >= 1);
      assert.equal(mock.navigateLog[0], 'https://services.planningcenteronline.com/live/555123');
    } finally {
      await mock.close();
    }
  } finally {
    await appCtx.close();
  }
});
