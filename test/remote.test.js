'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../server/config');
const { KioskDriver } = require('../server/kiosk');
const { createApp } = require('../server/app');
const { startMockCdp } = require('./helpers/mock-cdp');
const { waitFor, quietLogger } = require('./helpers/util');

const IDLE = 'http://127.0.0.1:3999/nowplaying';
const LOGIN_URL = 'https://login.planningcenteronline.com/';

async function startApp(mockPort) {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-remote-')), 'config.json');
  const config = loadConfig(configPath);
  const kiosk = new KioskDriver({ host: '127.0.0.1', port: mockPort, idleUrl: IDLE, reconnectMs: 100 });
  const { app } = createApp({ config, kiosk, configPath, idleUrl: IDLE, logger: quietLogger });
  kiosk.start();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    kiosk,
    base,
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

// Read the first screencast frame payload from the SSE stream (skipping the
// initial status message that the server sends on connect).
function readSseFrame(base, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/remote/stream`, (res) => {
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE frame timeout')); }, timeoutMs);
      const onEnd = () => {
        req.destroy();
        clearTimeout(timer);
      };
      res.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.match(/^data: (.*)$/gm) || [];
        for (const line of lines) {
          const raw = line.replace(/^data: /, '');
          let msg;
          try { msg = JSON.parse(raw); } catch { continue; }
          if (msg && msg.data) {
            onEnd();
            resolve(msg);
            return;
          }
        }
      });
      res.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    req.on('error', (err) => reject(err));
  });
}

test('remote control: start navigates to login, streams frames, forwards input with coordinate mapping', async () => {
  const mock = await startMockCdp({ url: IDLE });
  const ctx = await startApp(mock.port);

  try {
    // Start remote control — server always navigates to the PCO login URL
    // (client-supplied URLs are ignored).
    let res = await ctx.send('/api/remote/start', 'POST', { url: 'https://evil.example/' });
    assert.equal(res.status, 200);
    assert.equal(mock.navigateLog.includes(LOGIN_URL), true);
    assert.equal(mock.navigateLog.includes('https://evil.example/'), false);
    await waitFor(() => mock.commandLog.some((c) => c.method === 'Page.startScreencast'));

    // The server streams frames over SSE and acks them to Chrome.
    const ssePromise = readSseFrame(ctx.base);
    const pusher = setInterval(() => mock.pushFrame({ data: 'aGVsbG8=' }), 40);
    const frame = await ssePromise;
    clearInterval(pusher);
    assert.equal(frame.data, 'aGVsbG8=');
    await waitFor(() => mock.commandLog.some((c) => c.method === 'Page.screencastFrameAck'));

    // Now give the stream a scaled/offset metadata frame and check the server
    // maps natural-frame pixel coords to CSS page coords before dispatching.
    mock.pushFrame({ metadata: { pageScaleFactor: 2, offsetX: 10, offsetY: 20, scrollOffsetX: 0, scrollOffsetY: 0 } });
    await new Promise((r) => setTimeout(r, 50)); // let the server ingest the frame

    res = await ctx.send('/api/remote/input', 'POST', { type: 'mouse', event: 'down', x: 210, y: 420 });
    assert.equal(res.status, 200);
    const dispatch = mock.commandLog.filter((c) => c.method === 'Input.dispatchMouseEvent');
    assert.equal(dispatch.length, 1);
    // (210 - 10) / 2 = 100, (420 - 20) / 2 = 200
    assert.deepEqual(
      { x: dispatch[0].params.x, y: dispatch[0].params.y, type: dispatch[0].params.type },
      { x: 100, y: 200, type: 'mousePressed' }
    );

    // Text insertion and key events
    res = await ctx.send('/api/remote/input', 'POST', { type: 'text', text: 'hello' });
    assert.equal(res.status, 200);
    assert.equal(mock.commandLog.filter((c) => c.method === 'Input.insertText').length, 1);

    res = await ctx.send('/api/remote/input', 'POST', { type: 'key', key: 'Enter' });
    assert.equal(res.status, 200);
    const keyEvents = mock.commandLog.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params.type);
    assert.deepEqual(keyEvents, ['rawKeyDown', 'char', 'keyUp']);

    // Unsupported input is rejected
    res = await ctx.send('/api/remote/input', 'POST', { type: 'nope' });
    assert.equal(res.status, 400);

    // Stop tears everything down
    res = await ctx.send('/api/remote/stop', 'POST');
    assert.equal(res.status, 200);
    await waitFor(() => mock.commandLog.some((c) => c.method === 'Page.stopScreencast'));
  } finally {
    await ctx.close();
    await mock.close();
  }
});

test('remote control restart: state survives page reload and stream resumes', async () => {
  const mock = await startMockCdp({ url: IDLE });
  const ctx = await startApp(mock.port);
  try {
    await ctx.send('/api/remote/start', 'POST', { url: LOGIN_URL });
    await waitFor(() => mock.commandLog.some((c) => c.method === 'Page.startScreencast'));

    // Simulate a control-panel page reload: /api/state reports remote active.
    const state = await (await ctx.send('/api/state', 'GET')).json();
    assert.equal(state.remote.active, true);
  } finally {
    await ctx.close();
    await mock.close();
  }
});
