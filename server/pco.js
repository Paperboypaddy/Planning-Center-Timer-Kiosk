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

// Build the catalog the importer UI browses: Service Folders -> Service Types
// -> upcoming plans, plus an "Unfiled" bucket for service types that are not
// in any folder. Plans are ordered by sort date; archived/deleted service
// types are excluded. This maps the PCO hierarchy so the operator can segment
// picks by folder and service type instead of one flat list.
async function listPlanGroups({ apiKey, signal } = {}) {
  const [folders, types] = await Promise.all([
    pagingGet('/folders?order=name', { apiKey, signal }),
    pagingGet('/service_types', { apiKey, signal }),
  ]);

  const typeById = new Map(types.map((t) => [t.id, t]));
  const isActive = (t) => {
    const a = t.attributes || {};
    return !a.archived_at && !a.deleted_at;
  };
  const typeName = (t) => (t.attributes && t.attributes.name) || 'Service';

  // Fetch upcoming plans for every active service type, in parallel.
  const activeTypes = types.filter(isActive);
  const plansByType = new Map();
  await Promise.all(activeTypes.map(async (type) => {
    const typePlans = await pagingGet(`/service_types/${type.id}/plans?filter=future&order=sort_date`, {
      apiKey,
      signal,
    });
    plansByType.set(type.id, typePlans.map((plan) => {
      const attrs = plan.attributes || {};
      return {
        id: plan.id,
        serviceTypeId: type.id,
        serviceTypeName: typeName(type),
        sortDate: attrs.sort_date || null,
        shortDates: attrs.short_dates || null,
        dates: attrs.dates || null,
        title: attrs.title || '',
      };
    }));
  }));

  const assigned = new Set();
  const groups = [];

  for (const folder of folders) {
    const folderId = folder.id;
    const folderName = (folder.attributes && folder.attributes.name) || 'Folder';
    const typeIds = ((folder.relationships && folder.relationships.service_types && folder.relationships.service_types.data) || [])
      .map((r) => r.id);
    const serviceTypes = [];
    for (const typeId of typeIds) {
      const type = typeById.get(typeId);
      if (!type || !isActive(type)) continue;
      assigned.add(typeId);
      const plans = (plansByType.get(typeId) || []).map((p) => ({ ...p, folderName }));
      if (plans.length) serviceTypes.push({ id: typeId, name: typeName(type), plans });
    }
    if (serviceTypes.length) groups.push({ id: `folder_${folderId}`, name: folderName, isFolder: true, serviceTypes });
  }

  // Service types that belong to no folder, or to a folder we dropped.
  const unfiled = [];
  for (const type of activeTypes) {
    if (assigned.has(type.id)) continue;
    const plans = plansByType.get(type.id) || [];
    if (plans.length) unfiled.push({ id: type.id, name: typeName(type), plans });
  }
  if (unfiled.length) groups.push({ id: 'unfiled', name: 'Unfiled', isFolder: false, serviceTypes: unfiled });

  return groups;
}

// Flat list of upcoming plans ordered by sort date (used by the import
// action). Includes folderName on each plan so names/context survive.
async function listPlans(opts = {}) {
  const groups = await listPlanGroups(opts);
  return groups
    .flatMap((g) => g.serviceTypes.flatMap((st) => st.plans))
    .sort((a, b) => String(a.sortDate).localeCompare(String(b.sortDate)));
}

// Service + rehearsal times for one plan (used by the auto-on scheduler).
async function listPlanTimes(planId, serviceTypeId, { apiKey, signal } = {}) {
  const data = await pagingGet(`/service_types/${serviceTypeId}/plans/${planId}/plan_times`, { apiKey, signal });
  return data.map((t) => {
    const a = t.attributes || {};
    return { id: t.id, timeType: a.time_type || null, startsAt: a.starts_at || null };
  });
}

// Find which service type a plan belongs to (searches each service type's
// plans). Used to backfill serviceTypeId for manually-added services.
async function resolveServiceTypeId(planId, { apiKey, signal } = {}) {
  const types = await pagingGet('/service_types', { apiKey, signal });
  for (const type of types) {
    const found = await pagingGet(
      `/service_types/${type.id}/plans?where[id]=${encodeURIComponent(planId)}&per_page=1`,
      { apiKey, signal }
    );
    if (found.length) return type.id;
  }
  return null;
}

module.exports = { PcoError, listPlans, listPlanGroups, listPlanTimes, resolveServiceTypeId };
