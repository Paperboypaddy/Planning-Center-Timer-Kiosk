'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanPathForCommand } = require('../server/cec');

test('scanPathForCommand finds an executable on a Windows-style PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cec-'));
  fs.writeFileSync(path.join(dir, 'cec-client.exe'), '');
  const found = scanPathForCommand('cec-client', dir, 'win32');
  assert.ok(found);
  assert.equal(path.basename(found), 'cec-client.exe');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('scanPathForCommand returns null when missing', () => {
  assert.equal(scanPathForCommand('cec-client', '/nonexistent-path', 'linux'), null);
  assert.equal(scanPathForCommand('cec-client', '/nonexistent-path', 'win32'), null);
});

test('scanPathForCommand splits PATH on the right separator', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cec-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cec-b-'));
  fs.writeFileSync(path.join(dirB, 'cec-client.exe'), '');
  const found = scanPathForCommand('cec-client', `${dirA};${dirB}`, 'win32');
  assert.ok(found && found.startsWith(dirB));
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});
