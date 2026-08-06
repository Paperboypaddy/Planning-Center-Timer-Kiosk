'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  clientAddress,
  createSession,
  destroySession,
  getSession,
  isLoopback,
  loginLockedOut,
  loginRetryAfter,
  recordLoginFailure,
  requireAuth,
  sessionToken,
} = require('../server/auth');

function call(mw, ip, cookie, headers = {}) {
  return new Promise((resolve) => {
    const req = { socket: { remoteAddress: ip }, headers: Object.assign({}, headers, cookie ? { cookie } : {}) };
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

test('clientAddress trusts the proxy only for loopback peers', () => {
  const mk = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  // Direct local request (kiosk window / local control): no proxy header.
  assert.equal(clientAddress(mk('127.0.0.1')), '127.0.0.1');
  // LAN client behind Caddy: peer is loopback, rightmost XFF is the client.
  assert.equal(clientAddress(mk('127.0.0.1', '192.168.1.50')), '192.168.1.50');
  assert.equal(clientAddress(mk('::1', '10.0.0.7')), '10.0.0.7');
  // Chain: the proxy appends the real client last, so the rightmost wins even
  // when the caller sent a forged left-hand value.
  assert.equal(clientAddress(mk('127.0.0.1', '127.0.0.1, 192.168.1.50')), '192.168.1.50');
  // Direct LAN client (Windows :443 listener): peer is not loopback, XFF is
  // never consulted.
  assert.equal(clientAddress(mk('192.168.1.50', '127.0.0.1')), '192.168.1.50');
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

test('requireAuth does not mistake proxied LAN clients for loopback', async () => {
  // A LAN request arriving through Caddy has a loopback peer but an
  // X-Forwarded-For header carrying the real client IP — it must NOT bypass.
  const proxied = await call(requireAuth, '127.0.0.1', undefined, { 'x-forwarded-for': '192.168.1.50' });
  assert.equal(proxied.status, 401);

  // Forging a loopback address in X-Forwarded-For must not help: the proxy
  // appends the real client IP last, so the rightmost entry is non-loopback.
  const forged = await call(requireAuth, '127.0.0.1', undefined, { 'x-forwarded-for': '127.0.0.1, 192.168.1.50' });
  assert.equal(forged.status, 401);

  // A proxied request with a valid session cookie is accepted.
  const token = createSession('admin');
  const ok = await call(requireAuth, '127.0.0.1', `kiosk_session=${token}`, { 'x-forwarded-for': '192.168.1.50' });
  assert.equal(ok.passed, true);
  destroySession(token);
});

test('requireAuth ignores X-Forwarded-For on direct non-loopback peers', async () => {
  // Windows-style direct HTTPS listener: the client connects straight to the
  // app, so a forged XFF header must not grant loopback access.
  const r = await call(requireAuth, '192.168.1.50', undefined, { 'x-forwarded-for': '127.0.0.1' });
  assert.equal(r.status, 401);
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

test('login failure limiter locks out after too many attempts', () => {
  const ip = '10.0.0.9';
  for (let i = 0; i < 4; i += 1) {
    assert.equal(recordLoginFailure(ip), false, `attempt ${i + 1} under the limit`);
  }
  assert.equal(loginLockedOut(ip), false, 'not yet at the limit');
  assert.equal(recordLoginFailure(ip), true, '5th failure reaches the limit');
  assert.ok(loginLockedOut(ip));
  assert.ok(loginRetryAfter(ip) >= 1);
  assert.equal(loginLockedOut('192.168.1.5'), false, 'other IPs unaffected');
});
