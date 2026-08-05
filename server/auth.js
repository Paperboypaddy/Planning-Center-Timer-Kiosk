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

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
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
// session cookie.
function requireAuth(req, res, next) {
  if (isLoopback(req.socket.remoteAddress)) return next();
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
  createSession,
  destroySession,
  getSession,
  hashPassword,
  isLoopback,
  parseCookies,
  requestIsSecure,
  requireAuth,
  sessionToken,
  setSessionCookie,
  clearSessionCookie,
  verifyPassword,
};
