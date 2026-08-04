'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  browserCandidates,
  buildFlags,
  buildCommandLine,
  defaultProfileDir,
} = require('../kiosk/launch-kiosk');

const HOME = '/home/test';
const ENV = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };

test('windows browser candidates prefer Edge then Chrome', () => {
  const c = browserCandidates('win32', ENV);
  assert.ok(c[0].endsWith('msedge.exe'));
  assert.ok(c.some((p) => p.includes('Google') && p.endsWith('chrome.exe')));
});

test('linux browser candidates are command names', () => {
  const c = browserCandidates('linux', ENV);
  assert.deepEqual(c, ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']);
});

test('mac browser candidates are app bundle paths', () => {
  const c = browserCandidates('darwin', ENV);
  assert.ok(c[0].includes('Google Chrome.app'));
});

test('default profile dir is per-platform', () => {
  const winLocal = 'C:\\Users\\x\\AppData\\Local';
  assert.equal(
    defaultProfileDir('win32', { LOCALAPPDATA: winLocal }, HOME),
    path.join(winLocal, 'kiosk-chromium')
  );
  assert.equal(defaultProfileDir('linux', {}, HOME), '/home/test/.config/kiosk-chromium');
  assert.equal(defaultProfileDir('darwin', {}, HOME), '/home/test/Library/Application Support/kiosk-chromium');
});

test('flags always include the dark background + CDP port', () => {
  const flags = buildFlags({ profileDir: '/p', debugPort: '9222' });
  assert.ok(flags.includes('--remote-debugging-port=9222'));
  assert.ok(flags.includes('--user-data-dir=/p'));
  assert.ok(flags.includes('--blink-settings=backgroundcolor=FF000000'));
  assert.ok(flags.includes('--force-dark-mode'));
});

test('window mode opens the URL in a normal window', () => {
  const line = buildCommandLine({ chrome: 'chrome', profileDir: '/p', debugPort: '9222', url: 'http://u', mode: 'window' });
  assert.equal(line[0], 'chrome');
  assert.deepEqual(line.slice(-1), ['http://u']);
  assert.ok(!line.includes('--kiosk'));
});

test('kiosk mode adds --kiosk and the URL', () => {
  const line = buildCommandLine({ chrome: 'chrome', profileDir: '/p', debugPort: '9222', url: 'http://u', mode: 'kiosk' });
  const k = line.indexOf('--kiosk');
  assert.ok(k >= 0);
  assert.equal(line[k + 1], 'http://u');
});

test('login mode is a maximized window with no URL', () => {
  const line = buildCommandLine({ chrome: 'chrome', profileDir: '/p', debugPort: '9222', url: 'http://u', mode: 'login' });
  assert.ok(line.includes('--start-maximized'));
  assert.ok(!line.includes('--kiosk'));
  assert.ok(!line.includes('http://u'));
});
