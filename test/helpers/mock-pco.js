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

    if (url.pathname === '/services/v2/service_types') {
      const data = serviceTypes
        .filter((t) => !t.archived_at)
        .map(({ id, name, sequence }) => ({ type: 'ServiceType', id, attributes: { name, sequence } }));
      return api({ data, meta: { total_count: data.length } });
    }

    const m = /^\/services\/v2\/service_types\/([^/]+)\/plans$/.exec(url.pathname);
    if (m) {
      const plans = (plansByType[m[1]] || []).map((p) => ({
        type: 'Plan',
        id: p.id,
        attributes: { sort_date: p.sort_date, short_dates: p.short_dates, title: p.title },
      }));
      return api({ data: plans, meta: { total_count: plans.length } });
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
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

module.exports = { startMockPco };
