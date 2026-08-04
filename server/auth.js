'use strict';

// HTTP Basic Auth for the panel. Loopback clients (the kiosk's own window and
// the local control server) skip auth; LAN clients must present the shared
// login so the panel stays usable by the machine itself without credentials.
// This is the in-server alternative to the Caddy proxy used on Linux/macOS.

const crypto = require('crypto');

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function basicAuth(user, pass, { allowLoopback = true } = {}) {
  const expected = Buffer.from(`Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`);
  return function authMiddleware(req, res, next) {
    // Use raw Node response methods only: this middleware runs before Express
    // (wrapping the https server's request handler), so `res` may be a plain
    // ServerResponse without Express's res.set()/res.status().
    if (allowLoopback && isLoopback(req.socket.remoteAddress)) return next();
    const header = Buffer.from(req.headers.authorization || '');
    if (header.length === expected.length && crypto.timingSafeEqual(header, expected)) {
      return next();
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="Planning Center Kiosk"');
    res.statusCode = 401;
    res.end('Unauthorized');
  };
}

module.exports = { basicAuth, isLoopback };
