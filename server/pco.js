'use strict';

// Optional integration with the Planning Center Services v2 API so the control
// panel can pull upcoming plans straight from the church's account instead of
// typing IDs by hand. Everything here is read-only; we never create/modify
// anything in Planning Center.
//
// Auth: a PCO personal access token ("Bearer <token>") or an OAuth2
// application credential ("<app_id>:<secret>", sent as Basic auth).
// The base URL and endpoints below are from the official OpenAPI description
// (2018-11-01 version) served at /services/v2/open_api/2018-11-01.

// The base URL and endpoints below are from the official OpenAPI description
// (2018-11-01 version) served at /services/v2/open_api/2018-11-01.
const PCO_API_BASE = () => process.env.KIOSK_PCO_API_BASE || 'https://api.planningcenteronline.com/services/v2';

class PcoError extends Error {
  constructor(message, { status = 0, code = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'PcoError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function authHeaders(apiKey) {
  const headers = {
    Accept: 'application/vnd.api+json',
    'User-Agent': 'planningcenter-timer-kiosk',
  };
  if (!apiKey) return headers;
  if (apiKey.includes(':')) {
    headers.Authorization = `Basic ${Buffer.from(apiKey).toString('base64')}`;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function pcoFetch(path, { apiKey, signal } = {}) {
  let res;
  try {
    res = await fetch(`${PCO_API_BASE()}${path}`, { headers: authHeaders(apiKey), signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new PcoError(`Planning Center API unreachable: ${err.message}`, { code: 'unreachable' });
  }
  if (res.status === 401 || res.status === 403) {
    throw new PcoError('Planning Center rejected the API key (401/403)', { status: res.status, code: 'unauthorized' });
  }
  if (res.status === 429) {
    throw new PcoError('Planning Center rate limit reached (429); try again in a moment', {
      status: res.status,
      code: 'rate_limited',
      retryAfter: Number(res.headers.get('retry-after')) || null,
    });
  }
  if (!res.ok) {
    throw new PcoError(`Planning Center API error (HTTP ${res.status})`, { status: res.status });
  }
  return res.json();
}

// Fetch every page of a collection up to maxPages (offset pagination).
async function pagingGet(path, { apiKey, signal, pageSize = 100, maxPages = 3 } = {}) {
  const items = [];
  for (let page = 0; page < maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await pcoFetch(`${path}${sep}per_page=${pageSize}&offset=${page * pageSize}`, { apiKey, signal });
    items.push(...(data.data || []));
    if (!data.meta || !data.meta.next) break;
  }
  return items;
}

// Upcoming plans across all service types, normalized for the control panel.
async function listPlans({ apiKey, signal } = {}) {
  const types = await pagingGet('/service_types', { apiKey, signal });
  const plans = [];
  for (const type of types) {
    const typeName = (type.attributes && type.attributes.name) || 'Service';
    const typePlans = await pagingGet(`/service_types/${type.id}/plans?filter=future&order=sort_date`, {
      apiKey,
      signal,
    });
    for (const plan of typePlans) {
      const attrs = plan.attributes || {};
      plans.push({
        id: plan.id,
        serviceTypeId: type.id,
        serviceTypeName: typeName,
        sortDate: attrs.sort_date || null,
        shortDates: attrs.short_dates || null,
        dates: attrs.dates || null,
        title: attrs.title || '',
      });
    }
  }
  plans.sort((a, b) => String(a.sortDate).localeCompare(String(b.sortDate)));
  return plans;
}

module.exports = { PcoError, listPlans };
