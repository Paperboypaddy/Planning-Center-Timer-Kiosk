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
  // PCO omits relationship linkage unless include= is requested; without
  // service_types every plan collapses into the Unfiled bucket.
  const [folders, types] = await Promise.all([
    pagingGet('/folders?order=name&include=service_types', { apiKey, signal }),
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

// Service + rehearsal times for one plan (used by the auto-on scheduler and
// the custom display's projected end time).
async function listPlanTimes(planId, serviceTypeId, { apiKey, signal } = {}) {
  const data = await pagingGet(`/service_types/${serviceTypeId}/plans/${planId}/plan_times`, { apiKey, signal });
  return data.map((t) => {
    const a = t.attributes || {};
    return {
      id: t.id,
      timeType: a.time_type || null,
      startsAt: a.starts_at || null,
      endsAt: a.ends_at || null,
    };
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

function includedById(doc, type, id) {
  if (!id) return null;
  return (doc.included || []).find((r) => r.type === type && r.id === id) || null;
}

// Read-only snapshot of Services LIVE for the custom TV display.
// Returns null fields when LIVE has not been started yet.
async function fetchLiveSnapshot(planId, serviceTypeId, { apiKey, signal } = {}) {
  if (!planId || !serviceTypeId) {
    throw new PcoError('planId and serviceTypeId are required for live display', { code: 'bad_request' });
  }
  const base = `/service_types/${encodeURIComponent(serviceTypeId)}/plans/${encodeURIComponent(planId)}`;
  const liveDoc = await pcoFetch(
    `${base}/live?include=current_item_time,next_item_time`,
    { apiKey, signal }
  );

  // Collection or single resource depending on whether LIVE was started.
  const liveRows = Array.isArray(liveDoc.data) ? liveDoc.data : liveDoc.data ? [liveDoc.data] : [];
  const live = liveRows[0] || null;

  let currentItemTime = null;
  let nextItemTime = null;
  if (live) {
    const curRel = live.relationships && live.relationships.current_item_time && live.relationships.current_item_time.data;
    const nextRel = live.relationships && live.relationships.next_item_time && live.relationships.next_item_time.data;
    // Only use current_item_time when the relationship is set — do NOT fall
    // back to the first included ItemTime (that is often next_item_time).
    if (curRel) {
      const curRes = includedById(liveDoc, curRel.type || 'ItemTime', curRel.id);
      if (curRes) {
        const a = curRes.attributes || {};
        const itemRel = curRes.relationships && curRes.relationships.item && curRes.relationships.item.data;
        currentItemTime = {
          id: curRes.id,
          length: Number(a.length) || 0,
          liveStartAt: a.live_start_at || null,
          liveEndAt: a.live_end_at || null,
          itemId: itemRel ? itemRel.id : null,
        };
      }
    }
    if (nextRel) {
      const nextRes = includedById(liveDoc, nextRel.type || 'ItemTime', nextRel.id);
      if (nextRes) {
        const a = nextRes.attributes || {};
        nextItemTime = {
          id: nextRes.id,
          length: Number(a.length) || 0,
          liveStartAt: a.live_start_at || null,
          liveEndAt: a.live_end_at || null,
        };
      }
    }
  }

  // Plan items (for summing lengths after the current item / projected end).
  let items = [];
  try {
    const itemRows = await pagingGet(`${base}/items?order=sequence`, { apiKey, signal, maxPages: 5 });
    items = itemRows.map((row) => {
      const a = row.attributes || {};
      return {
        id: row.id,
        title: a.title || a.description || '',
        sequence: a.sequence != null ? Number(a.sequence) : 0,
        length: Number(a.length) || 0,
        itemType: a.item_type || null,
        servicePosition: a.service_position || null,
      };
    });
  } catch {
    items = [];
  }

  const times = await listPlanTimes(planId, serviceTypeId, { apiKey, signal });
  const serviceTime = pickUpcomingServiceTime(times);

  return {
    liveId: live ? live.id : null,
    liveTitle: live && live.attributes ? live.attributes.title || null : null,
    currentItemTime,
    nextItemTime,
    items,
    serviceEndsAt: serviceTime ? serviceTime.endsAt : null,
    serviceStartsAt: serviceTime ? serviceTime.startsAt : null,
  };
}

function pickUpcomingServiceTime(times, now = Date.now()) {
  const services = (times || []).filter((t) => t.timeType === 'service');
  const parse = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
  };
  const upcoming = services
    .map((t) => ({ t, start: parse(t.startsAt) }))
    .filter((x) => x.start != null && x.start > now)
    .sort((a, b) => a.start - b.start);
  if (upcoming.length) return upcoming[0].t;
  const past = services
    .map((t) => ({ t, start: parse(t.startsAt) }))
    .filter((x) => x.start != null)
    .sort((a, b) => b.start - a.start);
  return (past[0] && past[0].t) || services[0] || times[0] || null;
}

module.exports = {
  PcoError,
  listPlans,
  listPlanGroups,
  listPlanTimes,
  resolveServiceTypeId,
  fetchLiveSnapshot,
};
