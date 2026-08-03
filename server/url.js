'use strict';

// Tokens accepted inside the URL template. Kept in sync with the control panel docs.
const TOKENS = ['serviceId', 'displayType'];

// Replace every {token} in the template with the value for that service.
// A token with an empty/absent value is replaced with an empty string so a
// template that *optionally* includes {displayType} still produces a usable URL.
function buildUrl(template, { serviceId = '', displayType = '' } = {}) {
  let url = typeof template === 'string' ? template : '';
  const values = { serviceId, displayType: displayType || '' };
  for (const token of TOKENS) {
    url = url.split(`{${token}}`).join(values[token] ?? '');
  }
  return url;
}

module.exports = { buildUrl, TOKENS };
