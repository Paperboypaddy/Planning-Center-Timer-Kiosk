'use strict';

// HTTP Basic Auth for the panel. Loopback clients (the kiosk's own window and
// the local control server) skip auth; LAN clients must present the shared
// login so the panel stays usable by the machine itself without credentials.
// This is the in-server alternative to the Caddy proxy used on Linux/macOS.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// getPassword may be a string or a function returning the current password, so
// a change made from the panel takes effect immediately without a restart.
function basicAuth(user, getPassword, { allowLoopback = true } = {}) {
  return function authMiddleware(req, res, next) {
    // Use raw Node response methods only: this middleware runs before Express
    // (wrapping the https server's request handler), so `res` may be a plain
    // ServerResponse without Express's res.set()/res.status().
    if (allowLoopback && isLoopback(req.socket.remoteAddress)) return next();
    const pass = typeof getPassword === 'function' ? getPassword() : getPassword;
    const expected = Buffer.from(`Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`);
    const header = Buffer.from(req.headers.authorization || '');
    if (header.length === expected.length && crypto.timingSafeEqual(header, expected)) {
      return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Planning Center Kiosk"');
    res.statusCode = 401;
    res.end('Unauthorized');
  };
}

// Keep a human-readable note of the panel login next to the config file.
function writePanelLoginFile(configPath, user, password) {
  try {
    const host = `${os.hostname()}.local`;
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'panel-login.txt'),
      `Planning Center Kiosk control panel\nURL: https://${host}\nUser: ${user}\nPassword: ${password}\n`
    );
  } catch {
    /* best effort */
  }
}

module.exports = { basicAuth, isLoopback, writePanelLoginFile };
