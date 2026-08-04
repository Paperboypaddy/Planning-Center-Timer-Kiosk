'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const { loadConfig, saveConfig } = require('./config');
const { KioskDriver } = require('./kiosk');
const { createApp } = require('./app');
const { basicAuth, writePanelLoginFile } = require('./auth');

// By default the control server binds to localhost only; on Linux/macOS Caddy
// (see kiosk/install.sh) exposes the panel over HTTPS + Basic Auth on the LAN.
//
// In the Windows single-file app (KIOSK_TLS=1) there is no Caddy, so we serve
// the panel ourselves: an HTTPS listener with Basic Auth on 0.0.0.0:443 (the
// LAN panel) plus a plain-HTTP listener on 127.0.0.1:3001 (the kiosk window
// and local control, no auth needed on loopback).
const PORT = Number(process.env.KIOSK_PORT || 3001);
const PANEL_PORT = Number(process.env.KIOSK_PANEL_PORT || 443);
const TLS = process.env.KIOSK_TLS === '1';
const CERT_FILE = process.env.KIOSK_CERT || '';
const KEY_FILE = process.env.KIOSK_KEY || '';
const PANEL_USER = process.env.KIOSK_PANEL_USER || 'kiosk';
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
  const options = {
    key: fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE),
  };
  // First run (or a lost config): generate the panel password, persist it, and
  // note it in panel-login.txt next to the config. The operator can change it
  // from the panel afterwards.
  let panelPassword = process.env.KIOSK_PANEL_PASSWORD || (config.panelPassword || '');
  if (!panelPassword) {
    panelPassword = crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
    config.panelPassword = panelPassword;
    try {
      saveConfig(CONFIG_PATH, config);
      console.log(`[kiosk-control] generated panel password -> ${path.join(path.dirname(CONFIG_PATH), 'panel-login.txt')}`);
    } catch (err) {
      console.error(`[kiosk-control] could not persist panel password: ${err.message}`);
    }
  }
  writePanelLoginFile(CONFIG_PATH, PANEL_USER, panelPassword);
  // Read the password live so a change from the panel applies immediately.
  const auth = basicAuth(PANEL_USER, () => process.env.KIOSK_PANEL_PASSWORD || (config.panelPassword || ''));
  https
    .createServer(options, (req, res) => auth(req, res, () => app(req, res)))
    .listen(PANEL_PORT, '0.0.0.0', () => {
      console.log(`[kiosk-control] panel https://0.0.0.0:${PANEL_PORT} (Basic Auth; loopback exempt)`);
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
