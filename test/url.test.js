'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildUrl, TOKENS } = require('../server/url');

test('tokens are serviceId and displayType', () => {
  assert.deepEqual(TOKENS, ['serviceId', 'displayType']);
});

test('buildUrl replaces {serviceId} and {displayType}', () => {
  const url = buildUrl('https://services.planningcenteronline.com/live/{serviceId}?view={displayType}', {
    serviceId: '90197325',
    displayType: 'countdown',
  });
  assert.equal(url, 'https://services.planningcenteronline.com/live/90197325?view=countdown');
});

test('buildUrl leaves displayType token empty when value is absent', () => {
  const url = buildUrl('https://services.planningcenteronline.com/live/{serviceId}?view={displayType}', {
    serviceId: '90197325',
  });
  assert.equal(url, 'https://services.planningcenteronline.com/live/90197325?view=');
});

test('buildUrl replaces every occurrence of a token', () => {
  const url = buildUrl('{serviceId}/x/{serviceId}', { serviceId: '1' });
  assert.equal(url, '1/x/1');
});

test('buildUrl is a no-op for unknown tokens', () => {
  const url = buildUrl('https://x/{bogus}/live/{serviceId}', { serviceId: '42' });
  assert.equal(url, 'https://x/{bogus}/live/42');
});

test('buildUrl handles null/undefined template', () => {
  assert.equal(buildUrl(undefined, { serviceId: '1' }), '');
  assert.equal(buildUrl(null, { serviceId: '1' }), '');
});

test('buildUrl URL-encodes token values', () => {
  const url = buildUrl('https://x/live/{serviceId}?view={displayType}', {
    serviceId: '90197325',
    displayType: 'Countdown Full',
  });
  assert.equal(url, 'https://x/live/90197325?view=Countdown%20Full');
});
