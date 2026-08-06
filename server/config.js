'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CronExpressionParser } = require('cron-parser');
const { isAllowedUrlTemplate } = require('./url-allowlist');

const DEFAULT_TEMPLATE = 'https://services.planningcenteronline.com/live/{serviceId}';
const LEAD_MINUTES_MAX = 600;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaults() {
  return {
    urlTemplate: DEFAULT_TEMPLATE,
    activeServiceId: null,
    services: [],
    // Global defaults applied to every service when selected:
    //   defaultDisplayType - layout label for the local /display page
    //   defaultTheme        - "light" | "dark" | null (leave as-is)
    defaultDisplayType: null,
    defaultTheme: null,
    // TV (HDMI-CEC) behavior: auto-on before the next service/rehearsal time,
    // leadMinutes before. reboot.cron is a 5-field cron expression for the
    // daily reboot (null = off).
    tv: { autoOn: false, leadMinutes: 30 },
    reboot: { cron: null },
    // Admin account (created from the panel's first-run setup screen).
    admin: { username: null, passwordHash: null },
    // Software updates: also offer pre-release (beta) builds.
    update: { includePrereleases: false },
    // Optional Planning Center API credentials (personal access token, or
    // "<app_id>:<secret>"). Never exposed back through the API; the effective
    // key is env KIOSK_PCO_API_KEY first, then this.
    pco: { apiKey: null },
  };
}

// Merge persisted data over defaults, cleaning up anything malformed so a
// hand-edited config file can never crash the server.
function normalize(data) {
  const cfg = clone(defaults());
  if (!data || typeof data !== 'object') return cfg;

  if (typeof data.urlTemplate === 'string' && data.urlTemplate.trim()) {
    const tpl = data.urlTemplate.trim();
    if (isAllowedUrlTemplate(tpl)) cfg.urlTemplate = tpl;
  }

  if (Array.isArray(data.services)) {
    cfg.services = data.services
      .filter((s) => s && typeof s.serviceId === 'string' && s.serviceId.trim())
      .map((s) => ({
        id: typeof s.id === 'string' && s.id ? s.id : crypto.randomUUID(),
        name: (typeof s.name === 'string' && s.name.trim()) || s.serviceId.trim(),
        serviceId: s.serviceId.trim(),
        displayType: typeof s.displayType === 'string' ? s.displayType.trim() : '',
        serviceTypeId: typeof s.serviceTypeId === 'string' && s.serviceTypeId ? s.serviceTypeId : null,
      }));
  }

  const active = cfg.services.find((s) => s.id === data.activeServiceId);
  cfg.activeServiceId = active ? active.id : null;

  cfg.defaultDisplayType = (typeof data.defaultDisplayType === 'string' && data.defaultDisplayType) || null;
  cfg.defaultTheme = data.defaultTheme === 'light' || data.defaultTheme === 'dark' ? data.defaultTheme : null;

  let leadMinutes = 30;
  if (data.tv && typeof data.tv.leadMinutes === 'number' && Number.isFinite(data.tv.leadMinutes)) {
    leadMinutes = Math.min(LEAD_MINUTES_MAX, Math.max(0, Math.floor(data.tv.leadMinutes)));
  }
  cfg.tv = {
    autoOn: !!(data.tv && data.tv.autoOn),
    leadMinutes,
  };
  // Reboot cron. Backwards-compatible with the old "HH:MM" daily `at` field.
  let rebootCron = data.reboot && typeof data.reboot.cron === 'string' ? data.reboot.cron.trim() : null;
  if (!rebootCron && data.reboot && typeof data.reboot.at === 'string' && /^\d{2}:\d{2}$/.test(data.reboot.at)) {
    rebootCron = `${Number(data.reboot.at.slice(3))} ${Number(data.reboot.at.slice(0, 2))} * * *`;
  }
  if (rebootCron) {
    try {
      CronExpressionParser.parse(rebootCron);
    } catch {
      rebootCron = null;
    }
  } else {
    rebootCron = null;
  }
  cfg.reboot = { cron: rebootCron };
  cfg.admin = {
    username: data.admin && typeof data.admin.username === 'string' && data.admin.username ? data.admin.username : null,
    passwordHash: data.admin && typeof data.admin.passwordHash === 'string' && data.admin.passwordHash ? data.admin.passwordHash : null,
  };
  cfg.update = { includePrereleases: !!(data.update && data.update.includePrereleases) };

  if (data.pco && typeof data.pco === 'object') {
    cfg.pco = {
      apiKey: typeof data.pco.apiKey === 'string' && data.pco.apiKey ? data.pco.apiKey : null,
    };
  }
  return cfg;
}

function loadConfig(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalize(data);
  } catch {
    return clone(defaults());
  }
}

function saveConfig(filePath, config) {
  const tmp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  // The config holds the PCO API key and the admin bcrypt hash, so keep it
  // owner-readable only (the control-server user). Best-effort on Windows,
  // where chmod is not meaningful.
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* Windows / filesystems without POSIX perms */
  }
  fs.renameSync(tmp, filePath);
}

module.exports = { DEFAULT_TEMPLATE, LEAD_MINUTES_MAX, defaults, loadConfig, saveConfig, normalize };
