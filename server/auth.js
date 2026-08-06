'use strict';

// Session-based authentication for the control panel.
//
// The panel is a cookie-authenticated login page (not HTTP Basic Auth):
//   - first run on a fresh machine shows a "create admin account" screen
//   - afterwards the panel is a normal username/password login
//   - sessions are HttpOnly cookies holding a server-side random token
//
// Loopback clients (the kiosk's own window and the local control server) skip
// auth entirely, so the TV display and local calls work without a login. LAN
// clients must present a valid session cookie to use the API.
//
// Auth lives in the app itself on every platform; Caddy (Linux/macOS) is just
// a TLS reverse proxy now.

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const SESSION_COOKIE = 'kiosk_session';
const sessions = new Map(); // token -> { username, createdAt }

// Login-attempt limiting. Failures are tracked per client IP so a brute-force
// attempt on the LAN panel can't hammer the login/setup endpoints. In-memory
// is fine here: the process is the only thing enforcing it, and a restart
// simply resets the counters.
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 60 * 1000;
const loginFailures = new Map(); // clientIp -> { count, resetAt }

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// The client's effective address.
//
// The control server binds to loopback only (Linux/macOS), so every request
// arrives with req.socket.remoteAddress === 127.0.0.1 — including LAN clients
// that came through the Caddy TLS reverse proxy. We must NOT treat those as
// loopback or the login page is bypassed for anyone on the network.
//
// Rule: consult X-Forwarded-For only when the direct peer is loopback (i.e.
// the request went through a trusted local proxy such as Caddy), and take the
// RIGHTMOST entry — the address the proxy actually saw, which it appends to
// any client-supplied value. A LAN attacker cannot forge a loopback address
// because Caddy appends their real IP after whatever they send, and the
// Windows HTTPS listener is reached directly (non-loopback peer), so its XFF
// header is never trusted here.
function clientAddress(req) {
  const peer = req.socket.remoteAddress;
  if (isLoopback(peer)) {
    const xff = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (xff.length) return xff[xff.length - 1];
  }
  return peer;
}

// Track a failed login attempt; returns true when the client has reached the
// failure limit and the next attempt will be locked out.
function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count >= LOGIN_MAX_FAILURES;
}

function loginLockedOut(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    loginFailures.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function loginRetryAfter(ip) {
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= Date.now()) return 0;
  return Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
}

function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function sessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE];
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  return token ? sessions.get(token) || null : null;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function setSessionCookie(res, token, secure) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Protect every non-auth /api route: allow loopback, otherwise require a valid
// session cookie. Uses clientAddress() so LAN clients that arrive via the Caddy
// reverse proxy (direct peer is loopback) are not mistaken for local traffic.
function requireAuth(req, res, next) {
  if (isLoopback(clientAddress(req))) return next();
  if (getSession(sessionToken(req))) return next();
  res.status(401).json({ error: 'authentication required' });
}

function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// True when the panel is served over TLS (in-server HTTPS, or behind a proxy
// that forwarded https). Cookies get the Secure flag only then, so the panel
// also works over plain HTTP in development.
function requestIsSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

module.exports = {
  SESSION_COOKIE,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  clearLoginFailures,
  clientAddress,
  createSession,
  destroySession,
  getSession,
  hashPassword,
  isLoopback,
  loginLockedOut,
  loginRetryAfter,
  parseCookies,
  recordLoginFailure,
  requestIsSecure,
  requireAuth,
  sessionToken,
  setSessionCookie,
  clearSessionCookie,
  verifyPassword,
};
