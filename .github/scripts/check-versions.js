#!/usr/bin/env node
'use strict';

// Fail CI when package.json / app/package.json / Inno Setup versions diverge.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const rootVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'app', 'package.json'), 'utf8')).version;
const iss = fs.readFileSync(path.join(root, 'installer', 'windows', 'kiosk.iss'), 'utf8');
const m = /#define\s+MyAppVersion\s+"([^"]+)"/.exec(iss);
const issVersion = m ? m[1] : null;

const errors = [];
if (!rootVersion) errors.push('root package.json missing version');
if (appVersion !== rootVersion) {
  errors.push(`app/package.json version "${appVersion}" != root "${rootVersion}"`);
}
if (issVersion !== rootVersion) {
  errors.push(`installer/windows/kiosk.iss MyAppVersion "${issVersion}" != root "${rootVersion}"`);
}

if (errors.length) {
  console.error('Version sync check failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`Versions in sync: ${rootVersion}`);
