'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { basicAuth, isLoopback } = require('../server/auth');

function call(mw, ip, auth) {
  return new Promise((resolve) => {
    const req = { socket: { remoteAddress: ip }, headers: { authorization: auth } };
    const res = {
      statusCode: 200,
      _h: {},
      setHeader(k, v) { this._h[k] = v; },
      end() { resolve({ status: this.statusCode, www: this._h['WWW-Authenticate'] }); },
    };
    let passed = false;
    mw(req, res, () => {
      passed = true;
      resolve({ status: 200, passed: true });
    });
    if (!passed) setTimeout(() => resolve({ status: res._status, www: res._h['WWW-Authenticate'] }), 5);
  });
}

const AUTH = 'Basic ' + Buffer.from('kiosk:secret').toString('base64');
const BAD = 'Basic ' + Buffer.from('kiosk:wrong').toString('base64');

test('isLoopback recognizes loopback addresses', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.5'), false);
});

test('loopback clients skip auth entirely', async () => {
  const mw = basicAuth('kiosk', 'secret');
  const r = await call(mw, '127.0.0.1', undefined);
  assert.equal(r.passed, true);
});

test('LAN clients are challenged without credentials', async () => {
  const mw = basicAuth('kiosk', 'secret');
  const r = await call(mw, '192.168.1.5', undefined);
  assert.equal(r.status, 401);
  assert.equal(r.www, 'Basic realm="Planning Center Kiosk"');
});

test('LAN clients pass with the correct login and are rejected with a wrong one', async () => {
  const mw = basicAuth('kiosk', 'secret');
  assert.equal((await call(mw, '192.168.1.5', AUTH)).passed, true);
  const bad = await call(mw, '192.168.1.5', BAD);
  assert.equal(bad.status, 401);
});

test('a password getter is re-read per request (live changes take effect)', async () => {
  let password = 'firstpass123';
  const mw = basicAuth('kiosk', () => password);
  const ok1 = 'Basic ' + Buffer.from('kiosk:firstpass123').toString('base64');
  assert.equal((await call(mw, '192.168.1.5', ok1)).passed, true);

  password = 'secondpass456';
  const ok2 = 'Basic ' + Buffer.from('kiosk:secondpass456').toString('base64');
  assert.equal((await call(mw, '192.168.1.5', ok2)).passed, true);
  assert.equal((await call(mw, '192.168.1.5', ok1)).status, 401);
});
