'use strict';

const http = require('http');
const { URL } = require('url');

// A small fake of the Planning Center Services v2 API (the subset the kiosk
// uses), for exercising server/pco.js and the /api/pco/* endpoints.
//
// Behavior is configurable:
//   requiredAuth  - if set, reject requests unless the Authorization header
//                   matches ("Bearer <token>" or "Basic <b64(app_id:secret)>")
//   rateLimited   - always answer 429
function startMockPco({ requiredAuth, rateLimited = false } = {}) {
  const serviceTypes = [
    { id: '10', name: 'Sunday 9am', sequence: 0 },
    { id: '20', name: 'Wednesday Night', sequence: 1 },
    { id: '30', name: 'Archived Type', sequence: 2, archived_at: '2020-01-01T00:00:00Z' },
    { id: '40', name: 'Unfiled Service', sequence: 3 },
  ];

  // Service Folders -> the service types inside them (via relationships).
  const folders = [
    { id: 'f1', name: 'Weekend', serviceTypeIds: ['10'] },
    { id: 'f2', name: 'Midweek', serviceTypeIds: ['20'] },
  ];

  const plansByType = {
    10: [
      { id: '90197325', sort_date: '2026-08-09T09:00:00-05:00', short_dates: 'Aug 9, 9:00 AM', title: '' },
      { id: '90197331', sort_date: '2026-08-16T09:00:00-05:00', short_dates: 'Aug 16, 9:00 AM', title: 'Series 2' },
    ],
    20: [
      { id: '90211110', sort_date: '2026-08-12T19:00:00-05:00', short_dates: 'Aug 12, 7:00 PM', title: '' },
    ],
    30: [],
    40: [
      { id: '90444444', sort_date: '2026-08-22T10:00:00-05:00', short_dates: 'Aug 22, 10:00 AM', title: '' },
    ],
  };

  const planTimesByPlan = {
    '90197325': [
      { id: 't1', time_type: 'rehearsal', starts_at: '2026-08-08T18:00:00-05:00', ends_at: '2026-08-08T19:00:00-05:00' },
      { id: 't2', time_type: 'service', starts_at: '2026-08-09T09:00:00-05:00', ends_at: '2026-08-09T10:50:00-05:00' },
    ],
    '90211110': [
      { id: 't3', time_type: 'service', starts_at: '2026-08-12T19:00:00-05:00', ends_at: '2026-08-12T20:30:00-05:00' },
    ],
  };

  // Mutable Live session fixtures (tests can patch via returned handle).
  const livesByPlan = {
    '90197325': {
      id: 'live-90197325',
      title: 'Sunday Live',
      currentItemTime: {
        id: 'it1',
        length: 300,
        live_start_at: '2026-08-09T09:00:00-05:00',
        live_end_at: '2026-08-09T09:05:00-05:00',
        itemId: 'item-a',
      },
    },
  };

  const itemsByPlan = {
    '90197325': [
      { id: 'item-a', title: 'Welcome', sequence: 1, length: 300 },
      { id: 'item-b', title: 'Message', sequence: 2, length: 1800 },
      { id: 'item-c', title: 'Closing', sequence: 3, length: 300 },
    ],
  };

  const requestedPaths = [];

  const server = http.createServer((req, res) => {
    requestedPaths.push(req.url);
    const url = new URL(req.url, 'http://localhost');

    if (rateLimited) {
      res.statusCode = 429;
      res.setHeader('retry-after', '10');
      res.end('rate limited');
      return;
    }

    if (requiredAuth) {
      const auth = req.headers.authorization || '';
      const expected = requiredAuth.includes(':')
        ? `Basic ${Buffer.from(requiredAuth).toString('base64')}`
        : `Bearer ${requiredAuth}`;
      if (auth !== expected) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
    }

    const api = (body) => {
      res.setHeader('Content-Type', 'application/vnd.api+json');
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/services/v2/folders') {
      // Mirror real PCO: service_types linkage only appears when include=service_types.
      const include = String(url.searchParams.get('include') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const withTypes = include.includes('service_types');
      const data = folders.map(({ id, name, serviceTypeIds }) => {
        const relationships = {};
        if (withTypes) {
          relationships.service_types = {
            data: serviceTypeIds.map((sid) => ({ type: 'ServiceType', id: sid })),
          };
        }
        return { type: 'Folder', id, attributes: { name }, relationships };
      });
      return api({ data, meta: { total_count: data.length } });
    }

    if (url.pathname === '/services/v2/service_types') {
      const data = serviceTypes
        .filter((t) => !t.archived_at)
        .map(({ id, name, sequence }) => ({ type: 'ServiceType', id, attributes: { name, sequence } }));
      return api({ data, meta: { total_count: data.length } });
    }

    const m = /^\/services\/v2\/service_types\/([^/]+)\/plans$/.exec(url.pathname);
    if (m) {
      let plans = (plansByType[m[1]] || []).map((p) => ({
        type: 'Plan',
        id: p.id,
        attributes: { sort_date: p.sort_date, short_dates: p.short_dates, title: p.title },
      }));
      const whereId = url.searchParams.get('where[id]');
      if (whereId) plans = plans.filter((p) => p.id === whereId);
      return api({ data: plans, meta: { total_count: plans.length } });
    }

    const pm = /^\/services\/v2\/service_types\/([^/]+)\/plans\/([^/]+)\/plan_times$/.exec(url.pathname);
    if (pm) {
      const times = (planTimesByPlan[pm[2]] || []).map((t) => ({
        type: 'PlanTime',
        id: t.id,
        attributes: {
          time_type: t.time_type,
          starts_at: t.starts_at,
          ends_at: t.ends_at || null,
        },
      }));
      return api({ data: times, meta: { total_count: times.length } });
    }

    const liveM = /^\/services\/v2\/service_types\/([^/]+)\/plans\/([^/]+)\/live$/.exec(url.pathname);
    if (liveM) {
      const planId = liveM[2];
      const live = livesByPlan[planId];
      if (!live) {
        return api({ data: [], meta: { total_count: 0 } });
      }
      const included = [];
      const relationships = {};
      if (live.currentItemTime) {
        included.push({
          type: 'ItemTime',
          id: live.currentItemTime.id,
          attributes: {
            length: live.currentItemTime.length,
            live_start_at: live.currentItemTime.live_start_at,
            live_end_at: live.currentItemTime.live_end_at,
          },
          relationships: live.currentItemTime.itemId
            ? { item: { data: { type: 'Item', id: live.currentItemTime.itemId } } }
            : {},
        });
        relationships.current_item_time = { data: { type: 'ItemTime', id: live.currentItemTime.id } };
      }
      return api({
        data: {
          type: 'Live',
          id: live.id,
          attributes: { title: live.title || null },
          relationships,
        },
        included,
      });
    }

    const itemsM = /^\/services\/v2\/service_types\/([^/]+)\/plans\/([^/]+)\/items$/.exec(url.pathname);
    if (itemsM) {
      const items = (itemsByPlan[itemsM[2]] || []).map((it) => ({
        type: 'Item',
        id: it.id,
        attributes: {
          title: it.title,
          sequence: it.sequence,
          length: it.length,
        },
      }));
      return api({ data: items, meta: { total_count: items.length } });
    }

    res.statusCode = 404;
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        server,
        requestedPaths,
        livesByPlan,
        itemsByPlan,
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

module.exports = { startMockPco };
