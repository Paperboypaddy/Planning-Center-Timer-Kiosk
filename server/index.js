'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

// Load repo-root `.env` into process.env when present (does not override
// already-set variables). Lets KIOSK_PCO_API_KEY work without manual `source`.
function loadDotEnv(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const { loadConfig } = require('./config');
const { KioskDriver } = require('./kiosk');
const { createApp } = require('./app');

// By default the control server binds to localhost only; on Linux/macOS Caddy
// (see kiosk/install.sh) exposes the panel over HTTPS on the LAN.
//
// In the Windows single-file app (KIOSK_TLS=1) there is no Caddy, so we serve
// the panel ourselves: an HTTPS listener on 0.0.0.0:443 (the LAN panel) plus a
// plain-HTTP listener on 127.0.0.1:3001 (the kiosk window and local control).
// Authentication (a cookie-based login page with a first-run admin setup) is
// handled inside the app on every platform; Caddy is only a TLS proxy.
const PORT = Number(process.env.KIOSK_PORT || 3001);
const PANEL_PORT = Number(process.env.KIOSK_PANEL_PORT || 443);
const TLS = process.env.KIOSK_TLS === '1';
const CERT_FILE = process.env.KIOSK_CERT || '';
const KEY_FILE = process.env.KIOSK_KEY || '';
const CONFIG_PATH = process.env.KIOSK_CONFIG || path.join(__dirname, '..', 'config.json');
const CDP_HOST = process.env.KIOSK_CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.KIOSK_CDP_PORT || 9222);

const config = loadConfig(CONFIG_PATH);
const kiosk = new KioskDriver({
  host: CDP_HOST,
  port: CDP_PORT,
  idleUrl: `http://127.0.0.1:${PORT}/nowplaying`,
});

const { app } = createApp({
  config,
  kiosk,
  configPath: CONFIG_PATH,
  idleUrl: `http://127.0.0.1:${PORT}/nowplaying`,
  runScheduler: true,
});

kiosk.start();

if (TLS) {
  if (!CERT_FILE || !KEY_FILE) {
    console.error('[kiosk-control] KIOSK_TLS=1 requires KIOSK_CERT and KIOSK_KEY');
    process.exit(1);
  }
  https
    .createServer({ key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) }, app)
    .listen(PANEL_PORT, '0.0.0.0', () => {
      console.log(`[kiosk-control] panel https://0.0.0.0:${PANEL_PORT} (login page; loopback exempt)`);
    });
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[kiosk-control] local http://127.0.0.1:${PORT} (kiosk window, no auth)`);
  });
} else {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[kiosk-control] listening on http://127.0.0.1:${PORT} (localhost only)`);
  });
}

console.log(`[kiosk-control] config file: ${CONFIG_PATH}`);
console.log(`[kiosk-control] CDP endpoint: ${CDP_HOST}:${CDP_PORT}`);
console.log(`[kiosk-control] kiosk idle page: http://127.0.0.1:${PORT}/nowplaying`);
