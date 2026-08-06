'use strict';

// Restricts where the kiosk Chromium tab may be pointed. Authenticated panel
// operators previously could set an arbitrary urlTemplate or remote-start URL;
// that is an open navigation vector (file:, javascript:, arbitrary LAN/cloud).

const { buildUrl, TOKENS } = require('./url');

const PCO_LOGIN_URL = 'https://login.planningcenteronline.com/';

const ALLOWED_HOSTS = new Set([
  'services.planningcenteronline.com',
  'login.planningcenteronline.com',
]);

function isIdleUrl(url, idleUrl) {
  if (!idleUrl) return false;
  try {
    const u = new URL(url);
    const idle = new URL(idleUrl);
    return (
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
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
  // Idle page is always loopback HTTP even when idleUrl was not passed.
  if (
    u.protocol === 'http:' &&
    (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
    (u.pathname === '/nowplaying' || u.pathname.startsWith('/nowplaying/'))
  ) {
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
