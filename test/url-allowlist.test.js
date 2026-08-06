'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PCO_LOGIN_URL,
  isAllowedAbsoluteUrl,
  isAllowedUrlTemplate,
} = require('../server/url-allowlist');

const IDLE = 'http://127.0.0.1:3001/nowplaying';
const DEFAULT = 'https://services.planningcenteronline.com/live/{serviceId}';

test('allows PCO live and login URLs', () => {
  assert.equal(isAllowedAbsoluteUrl('https://services.planningcenteronline.com/live/123'), true);
  assert.equal(isAllowedAbsoluteUrl(PCO_LOGIN_URL), true);
  assert.equal(isAllowedAbsoluteUrl('https://login.planningcenteronline.com/login'), true);
});

test('allows the local idle and display pages', () => {
  assert.equal(isAllowedAbsoluteUrl(IDLE, { idleUrl: IDLE }), true);
  assert.equal(isAllowedAbsoluteUrl('http://127.0.0.1:3001/nowplaying'), true);
  assert.equal(isAllowedAbsoluteUrl('http://localhost:3001/nowplaying'), true);
  assert.equal(isAllowedAbsoluteUrl('http://127.0.0.1:3001/display'), true);
  assert.equal(isAllowedAbsoluteUrl('http://localhost:3001/display'), true);
});

test('rejects dangerous and off-host URLs', () => {
  assert.equal(isAllowedAbsoluteUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedAbsoluteUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedAbsoluteUrl('https://evil.example/x'), false);
  assert.equal(isAllowedAbsoluteUrl('http://192.168.1.1/'), false);
  assert.equal(isAllowedAbsoluteUrl(''), false);
  assert.equal(isAllowedAbsoluteUrl(null), false);
});

test('allows the default URL template and rejects bad templates', () => {
  assert.equal(isAllowedUrlTemplate(DEFAULT), true);
  assert.equal(
    isAllowedUrlTemplate('https://services.planningcenteronline.com/live/{serviceId}?view={displayType}'),
    true
  );
  assert.equal(isAllowedUrlTemplate('https://evil.example/{serviceId}'), false);
  assert.equal(isAllowedUrlTemplate('file://{serviceId}'), false);
  assert.equal(isAllowedUrlTemplate(''), false);
});
