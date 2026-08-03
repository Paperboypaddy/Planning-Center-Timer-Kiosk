'use strict';

const path = require('path');

const { loadConfig } = require('./config');
const { KioskDriver } = require('./kiosk');
const { createApp } = require('./app');

const PORT = Number(process.env.KIOSK_PORT || 3000);
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

app.listen(PORT, () => {
  console.log(`[kiosk-control] listening on http://0.0.0.0:${PORT}`);
  console.log(`[kiosk-control] config file: ${CONFIG_PATH}`);
  console.log(`[kiosk-control] CDP endpoint: ${CDP_HOST}:${CDP_PORT}`);
  console.log(`[kiosk-control] kiosk idle page: http://127.0.0.1:${PORT}/nowplaying`);
});
