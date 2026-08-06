'use strict';

// Restricts where the kiosk Chromium tab may be pointed. Authenticated panel
// operators previously could set an arbitrary urlTemplate or remote-start URL;
// that is an open navigation vector (file:, javascript:, arbitrary LAN/cloud).
// This flavor also allows the local /display countdown page.

const { buildUrl, TOKENS } = require('./url');

const PCO_LOGIN_URL = 'https://login.planningcenteronline.com/';

const ALLOWED_HOSTS = new Set([
  'services.planningcenteronline.com',
  'login.planningcenteronline.com',
]);

function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

function isLocalKioskPath(pathname) {
  return (
    pathname === '/nowplaying' ||
    pathname.startsWith('/nowplaying/') ||
    pathname === '/display' ||
    pathname.startsWith('/display/')
  );
}

function isIdleUrl(url, idleUrl) {
  if (!idleUrl) return false;
  try {
    const u = new URL(url);
    const idle = new URL(idleUrl);
    return (
      isLoopbackHost(u.hostname) &&
      u.protocol === idle.protocol &&
      u.pathname === idle.pathname
    );
  } catch {
    return false;
  }
}

function isAllowedAbsoluteUrl(url, { idleUrl } = {}) {
  if (typeof url !== 'string' || !url.trim()) return false;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  if (u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname)) return true;
  if (isIdleUrl(u.toString(), idleUrl)) return true;
  // Local idle + countdown pages (loopback HTTP).
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname) && isLocalKioskPath(u.pathname)) {
    return true;
  }
  return false;
}

// Validate a URL template by substituting placeholder token values, then
// checking the resulting absolute URL against the allowlist.
function isAllowedUrlTemplate(template, { idleUrl } = {}) {
  if (typeof template !== 'string' || !template.trim()) return false;
  const placeholders = {};
  for (const token of TOKENS) placeholders[token] = 'placeholder';
  const built = buildUrl(template.trim(), placeholders);
  // Templates must still contain a scheme after substitution (no relative URLs).
  if (!/^https?:\/\//i.test(built)) return false;
  return isAllowedAbsoluteUrl(built, { idleUrl });
}

module.exports = {
  ALLOWED_HOSTS,
  PCO_LOGIN_URL,
  isAllowedAbsoluteUrl,
  isAllowedUrlTemplate,
};
