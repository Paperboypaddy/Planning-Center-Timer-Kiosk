'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_TEMPLATE = 'https://services.planningcenteronline.com/live/{serviceId}';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaults() {
  return {
    urlTemplate: DEFAULT_TEMPLATE,
    activeServiceId: null,
    services: [],
    // Global defaults applied to every service when selected:
    //   defaultDisplayType - PCO live-controller layout ("" = leave as-is)
    //   defaultTheme        - "light" | "dark" | null (leave as-is)
    defaultDisplayType: null,
    defaultTheme: null,
    // TV (HDMI-CEC) behavior: auto-on before the next service/rehearsal time,
    // leadMinutes before. reboot.at is a "HH:MM" daily reboot (null = off).
    tv: { autoOn: false, leadMinutes: 30 },
    reboot: { at: null },
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
    cfg.urlTemplate = data.urlTemplate.trim();
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

  cfg.tv = {
    autoOn: !!(data.tv && data.tv.autoOn),
    leadMinutes:
      data.tv && typeof data.tv.leadMinutes === 'number' && data.tv.leadMinutes >= 0 ? data.tv.leadMinutes : 30,
  };
  cfg.reboot = {
    at: data.reboot && typeof data.reboot.at === 'string' && /^\d{2}:\d{2}$/.test(data.reboot.at) ? data.reboot.at : null,
  };

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
  fs.renameSync(tmp, filePath);
}

module.exports = { DEFAULT_TEMPLATE, defaults, loadConfig, saveConfig, normalize };
