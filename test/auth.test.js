'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createSession,
  destroySession,
  getSession,
  isLoopback,
  requireAuth,
  sessionToken,
} = require('../server/auth');

function call(mw, ip, cookie) {
  return new Promise((resolve) => {
    const req = { socket: { remoteAddress: ip }, headers: { cookie } };
    const res = {
      statusCode: 200,
      _json: null,
      json(obj) { this._json = obj; },
      status(code) { this.statusCode = code; return this; },
    };
    let passed = false;
    mw(req, res, () => {
      passed = true;
      resolve({ passed: true });
    });
    if (!passed) setTimeout(() => resolve({ status: res.statusCode, body: res._json }), 5);
  });
}

test('isLoopback recognizes loopback addresses', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.5'), false);
});

test('sessions create, retrieve, and destroy', () => {
  const token = createSession('admin');
  assert.ok(token);
  assert.equal(getSession(token).username, 'admin');
  destroySession(token);
  assert.equal(getSession(token), null);
});

test('sessionToken parses the kiosk_session cookie', () => {
  assert.equal(sessionToken({ headers: { cookie: 'other=1; kiosk_session=abc123; x=2' } }), 'abc123');
  assert.equal(sessionToken({ headers: {} }), undefined);
});

test('requireAuth lets loopback through without a session', async () => {
  const r = await call(requireAuth, '127.0.0.1', undefined);
  assert.equal(r.passed, true);
});

test('requireAuth rejects non-loopback clients without a valid session', async () => {
  const noCookie = await call(requireAuth, '192.168.1.5', undefined);
  assert.equal(noCookie.status, 401);

  const badCookie = await call(requireAuth, '192.168.1.5', 'kiosk_session=nonsense');
  assert.equal(badCookie.status, 401);
});

test('requireAuth accepts a non-loopback client with a valid session', async () => {
  const token = createSession('admin');
  const r = await call(requireAuth, '192.168.1.5', `kiosk_session=${token}`);
  assert.equal(r.passed, true);
  destroySession(token);
  const after = await call(requireAuth, '192.168.1.5', `kiosk_session=${token}`);
  assert.equal(after.status, 401);
});
