'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { spawn } = require('child_process');

const { saveConfig } = require('./config');
const { buildUrl } = require('./url');
const { listPlans, listPlanGroups, listPlanTimes, resolveServiceTypeId, PcoError } = require('./pco');
const { DISPLAY_TYPES, THEMES } = require('./kiosk');
const { CronExpressionParser } = require('cron-parser');
const {
  canApplyUpdate,
  getUpdateInfo,
  readUpdateState,
  releasesUrl,
  updateScriptPath,
  updateStatePath,
  writeUpdateState,
} = require('./update');
const {
  clearLoginFailures,
  clientAddress,
  createSession,
  destroySession,
  getSession,
  hashPassword,
  isLoopback,
  loginLockedOut,
  loginRetryAfter,
  parseCookies,
  recordLoginFailure,
  requestIsSecure,
  requireAuth,
  sessionToken,
  setSessionCookie,
  clearSessionCookie,
  verifyPassword,
} = require('./auth');
const cecModule = require('./cec');
const wifiModule = require('./wifi');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ config, kiosk, configPath, idleUrl, logger = console, cec = cecModule, wifi = wifiModule, runScheduler = false, rebootFn = null, version = require('../package.json').version }) {
  kiosk.idleUrl = idleUrl || `http://127.0.0.1:3001/nowplaying`;

  function persist() {
    try {
      saveConfig(configPath, config);
      return true;
    } catch (err) {
      logger.error(`[config] save failed: ${err.message}`);
      return false;
    }
  }

  // Point the kiosk tab at whatever should be showing right now: the active
  // service's countdown page, or the idle "now playing" page when nothing is
  // selected. Runs on startup and after every (re)connection so the TV self-
  // heals after a Chromium crash/restart.
  function syncKiosk() {
    const active = config.services.find((s) => s.id === config.activeServiceId);
    const url = active ? buildUrl(config.urlTemplate, active) : kiosk.idleUrl;
    return kiosk.navigate(url).catch((err) => {
      logger.error(`[kiosk] sync failed: ${err.message}`);
    });
  }

  kiosk.on('connect', () => {
    syncKiosk();
    // If we were streaming the kiosk when it restarted, resume the screencast
    // on the fresh connection once the tab has settled.
    if (remoteActive) {
      setTimeout(() => {
        kiosk.startScreencast().catch((err) => logger.warn(`[remote] auto-restart failed: ${err.message}`));
      }, 750);
    }
  });

  function state() {
    return {
      urlTemplate: config.urlTemplate,
      activeServiceId: config.activeServiceId,
      services: config.services,
      kiosk: { connected: kiosk.connected, idleUrl: kiosk.idleUrl },
      pco: { configured: !!pcoApiKey(), viaEnv: !!process.env.KIOSK_PCO_API_KEY },
      remote: { active: remoteActive },
      displayTypes: DISPLAY_TYPES,
      themes: THEMES,
      defaultDisplayType: config.defaultDisplayType,
      defaultTheme: config.defaultTheme,
      tv: { available: cec.isAvailable(), autoOn: config.tv.autoOn, leadMinutes: config.tv.leadMinutes },
      reboot: { cron: config.reboot.cron },
      platform: { os: process.platform },
      wifi: { supported: wifi.isAvailable() },
      adminConfigured: adminConfigured(),
      version,
      updatePrereleases: config.update.includePrereleases,
      canApplyUpdate: canApplyUpdate(),
    };
  }

  function findService(id) {
    return config.services.find((s) => s.id === id);
  }

  // Effective PCO credentials: env var wins, then the GUI-saved config value.
  function pcoApiKey() {
    return process.env.KIOSK_PCO_API_KEY || (config.pco && config.pco.apiKey) || '';
  }

  function adminConfigured() {
    return !!(config.admin && config.admin.passwordHash);
  }

  function handlePcoError(err, res) {
    if (err instanceof PcoError) {
      const status = err.code === 'unauthorized' ? 401 : err.code === 'rate_limited' ? 429 : 502;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    logger.error(`[pco] request failed: ${err.message}`);
    res.status(502).json({ error: `Planning Center request failed: ${err.message}` });
  }

  const app = express();
  app.set('trust proxy', 1); // trust the TLS-terminating proxy (Caddy) for Secure cookies
  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));

  // --- Authentication (cookie sessions; first-run admin setup) ---
  app.get('/api/auth/status', (req, res) => {
    const authenticated = !!getSession(sessionToken(req));
    res.json({ authenticated, setupRequired: !adminConfigured() });
  });

  // First-run only: create the admin account.
  app.post('/api/auth/setup', async (req, res) => {
    const ip = clientAddress(req);
    if (!isLoopback(ip) && loginLockedOut(ip)) {
      return res
        .status(429)
        .set('Retry-After', String(loginRetryAfter(ip)))
        .json({ error: 'too many attempts; try again shortly' });
    }
    if (adminConfigured()) return res.status(400).json({ error: 'an admin account already exists' });
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username) return res.status(400).json({ error: 'username is required' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    config.admin = { username, passwordHash: await hashPassword(password) };
    if (!persist()) return res.status(500).json({ error: 'failed to save config' });
    clearLoginFailures(ip);
    setSessionCookie(res, createSession(username), requestIsSecure(req));
    res.json({ ok: true, authenticated: true, setupRequired: false });
  });

  app.post('/api/auth/login', async (req, res) => {
    const ip = clientAddress(req);
    if (!isLoopback(ip) && loginLockedOut(ip)) {
      return res
        .status(429)
        .set('Retry-After', String(loginRetryAfter(ip)))
        .json({ error: 'too many failed login attempts; try again shortly' });
    }
    if (!adminConfigured()) return res.status(400).json({ error: 'no admin account yet; set one up first' });
    const body = req.body || {};
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (username !== config.admin.username || !(await verifyPassword(password, config.admin.passwordHash))) {
      if (!isLoopback(ip)) recordLoginFailure(ip);
      return res.status(401).json({ error: 'invalid username or password' });
    }
    clearLoginFailures(ip);
    setSessionCookie(res, createSession(username), requestIsSecure(req));
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    destroySession(sessionToken(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Update progress is deliberately PUBLIC: applying an update restarts the
  // control server, which wipes the in-memory sessions — the panel must still
  // be able to poll the progress bar after that. It only reveals update state
  // (version / percent / message), nothing sensitive.
  app.get('/api/update/progress', (req, res) => {
    res.json(readUpdateState(updateStatePath(configPath)));
  });

  // Everything else under /api requires a session (loopback is always allowed,
  // so the kiosk window and local control keep working without a login).
  app.use('/api', requireAuth);

  // Idle page shown on the TV while no service is selected. Served locally by
  // this same server; the kiosk browser points at it.
  app.get('/nowplaying', (req, res) => {
    res.type('html').send(renderNowPlaying());
  });

  app.get('/api/state', (req, res) => res.json(state()));
  app.get('/api/health', (req, res) => res.json({ ok: true, kiosk: { connected: kiosk.connected } }));

  app.put('/api/url-template', (req, res) => {
    const urlTemplate = typeof (req.body || {}).urlTemplate === 'string' ? req.body.urlTemplate.trim() : '';
    if (!urlTemplate) return res.status(400).json({ error: 'urlTemplate is required' });
    config.urlTemplate = urlTemplate;
    if (!persist()) return res.status(500).json({ error: 'failed to save config' });
    res.json({ urlTemplate: config.urlTemplate });
  });

  // Save panel settings: URL template, default display type, default theme.
  app.put('/api/settings', (req, res) => {
    const body = req.body || {};
    if (body.urlTemplate !== undefined) {
      const urlTemplate = typeof body.urlTemplate === 'string' ? body.urlTemplate.trim() : '';
      if (!urlTemplate) return res.status(400).json({ error: 'urlTemplate cannot be empty' });
      config.urlTemplate = urlTemplate;
    }
    if (body.defaultDisplayType !== undefined) {
      const value = body.defaultDisplayType === null ? null : String(body.defaultDisplayType);
      if (value !== null && !DISPLAY_TYPES.includes(value)) {
        return res.status(400).json({ error: `unknown display type "${value}"` });
      }
      config.defaultDisplayType = value;
    }
    if (body.defaultTheme !== undefined) {
      const value = body.defaultTheme;
      if (value !== null && value !== 'light' && value !== 'dark') {
        return res.status(400).json({ error: 'defaultTheme must be "light", "dark" or null' });
      }
      config.defaultTheme = value;
    }
    if (body.tvAutoOn !== undefined) {
      config.tv.autoOn = !!body.tvAutoOn;
    }
    if (body.tvLeadMinutes !== undefined) {
      const n = Number(body.tvLeadMinutes);
      if (!Number.isFinite(n) || n < 0 || n > 600) {
        return res.status(400).json({ error: 'tvLeadMinutes must be between 0 and 600' });
      }
      config.tv.leadMinutes = n;
    }
    // Reboot cron. Accept the old "HH:MM" rebootAt too (converted to cron).
    let rebootCron = body.rebootCron;
    if (rebootCron === undefined && body.rebootAt !== undefined) {
      rebootCron = body.rebootAt;
      if (rebootCron && /^\d{2}:\d{2}$/.test(String(rebootCron))) {
        rebootCron = `${Number(String(rebootCron).slice(3))} ${Number(String(rebootCron).slice(0, 2))} * * *`;
      }
    }
    if (rebootCron !== undefined) {
      const value = rebootCron === null ? null : String(rebootCron).trim();
      if (value !== null) {
        try {
          CronExpressionParser.parse(value);
        } catch {
          return res.status(400).json({ error: 'rebootCron must be a valid 5-field cron expression or null' });
        }
      }
      config.reboot.cron = value;
    }
    if (body.updatePrereleases !== undefined) {
      config.update.includePrereleases = !!body.updatePrereleases;
    }
    if (!persist()) return res.status(500).json({ error: 'failed to save config' });
    res.json({
      urlTemplate: config.urlTemplate,
      defaultDisplayType: config.defaultDisplayType,
      defaultTheme: config.defaultTheme,
      tvAutoOn: config.tv.autoOn,
      tvLeadMinutes: config.tv.leadMinutes,
      rebootCron: config.reboot.cron,
      updatePrereleases: config.update.includePrereleases,
    });
  });

  // Change the admin password. Requires the current password, so a change is
  // possible from the panel itself (the panel is behind the session login).
  app.put('/api/panel/password', async (req, res) => {
    const body = req.body || {};
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!adminConfigured()) return res.status(400).json({ error: 'no admin account configured' });
    if (!(await verifyPassword(current, config.admin.passwordHash))) {
      return res.status(401).json({ error: 'current password is incorrect' });
    }
    if (next.length < 8) {
      return res.status(400).json({ error: 'new password must be at least 8 characters' });
    }
    config.admin.passwordHash = await hashPassword(next);
    if (!persist()) return res.status(500).json({ error: 'failed to save config' });
    res.json({ ok: true });
  });

  // --- Software update ---

  app.get('/api/update/status', async (req, res) => {
    try {
      const info = await getUpdateInfo({
        version,
        includePrereleases: config.update.includePrereleases,
        signal: req.signal,
      });
      info.canApplyUpdate = canApplyUpdate();
      if (info.updateAvailable && !info.canApplyUpdate) {
        info.note =
          info.note ||
          'A newer release exists; apply it with nixos-rebuild (or your package manager), not from the panel.';
      }
      res.json(info);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Apply the update. Linux auto-reinstalls from the latest release (a script
  // invoked via a narrow sudoers entry); other platforms show the download.
  // Immutable installs (NixOS) set KIOSK_UPDATE_SCRIPT= empty so apply is disabled.
  // Progress is tracked in a state file the panel polls via
  // GET /api/update/progress.
  app.post('/api/update', async (req, res) => {
    const script = updateScriptPath();
    if (!canApplyUpdate()) {
      return res.json({
        ok: false,
        hint:
          'In-app updates are not available on this install. Update via your package manager (e.g. nixos-rebuild / flake bump).',
        releaseUrl: releasesUrl(),
      });
    }
    if (process.platform === 'linux') {
      const stateFile = updateStatePath(configPath);
      writeUpdateState(stateFile, { state: 'starting', progress: 0, message: 'Starting update\u2026' });
      // Resolve the exact release the panel offered (honoring the prerelease
      // toggle) and pass it to the updater, so clicking "install 2026.8.5-beta"
      // actually installs that tag rather than the latest stable. Best-effort:
      // on failure the updater resolves the latest release itself.
      let target = null;
      try {
        const info = await getUpdateInfo({ version, includePrereleases: config.update.includePrereleases, signal: req.signal });
        if (info.updateAvailable && info.latestVersion) target = info.latestVersion;
      } catch {
        /* updater falls back to its own resolution */
      }
      const args = ['-n', script];
      if (target) args.push(target);
      const child = spawn('sudo', args, { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        writeUpdateState(stateFile, { state: 'error', progress: 0, message: `could not start the update: ${err.message}` });
        logger.error(`[update] could not start update: ${err.message}`);
        res.status(502).json({ error: `could not start the update: ${err.message}`, hint: `run manually: sudo ${script}` });
      });
      child.on('spawn', () => {
        logger.log(`[update] update script started: ${script}`);
        res.json({ ok: true, message: 'update started' });
      });
    } else {
      res.json({
        ok: false,
        hint: 'On this platform, download the latest release and reinstall (Windows: replace the exe; macOS: re-run install-macos.sh).',
        releaseUrl: releasesUrl(),
      });
    }
  });

  // --- TV (HDMI-CEC) power control ---

  app.get('/api/tv/status', async (req, res) => {
    const available = cec.isAvailable();
    const status = { available };
    if (available) {
      const p = await cec.powerStatus();
      status.power = p.power;
      status.error = p.error || null;
    }
    res.json(status);
  });

  app.post('/api/tv/on', async (req, res) => {
    const r = await cec.powerOn();
    if (!r.ok) return res.status(502).json({ error: r.error || 'CEC command failed' });
    res.json({ ok: true });
  });

  app.post('/api/tv/off', async (req, res) => {
    const r = await cec.powerOff();
    if (!r.ok) return res.status(502).json({ error: r.error || 'CEC command failed' });
    res.json({ ok: true });
  });

  // Apply the saved defaults to the kiosk's current live page (no selection
  // needed). Best-effort per setting.
  app.post('/api/kiosk/settings/apply', async (req, res) => {
    const applied = { displayType: null, theme: null };
    try {
      if (config.defaultDisplayType) {
        await kiosk.setDisplayType(config.defaultDisplayType);
        applied.displayType = config.defaultDisplayType;
      }
      if (config.defaultTheme) {
        await kiosk.setTheme(config.defaultTheme);
        applied.theme = config.defaultTheme;
      }
      res.json({ ok: true, applied });
    } catch (err) {
      logger.error(`[kiosk] apply settings failed: ${err.message}`);
      res.status(502).json({ error: err.message, applied });
    }
  });

  app.post('/api/services', (req, res) => {
    const body = req.body || {};
    const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : '';
    if (!serviceId) return res.status(400).json({ error: 'serviceId is required' });
    const service = {
      id: crypto.randomUUID(),
      name: (typeof body.name === 'string' && body.name.trim()) || serviceId,
      serviceId,
      displayType: typeof body.displayType === 'string' ? body.displayType.trim() : '',
      serviceTypeId: null,
    };
    config.services.push(service);
    if (!persist()) return res.status(500).json({ error: 'failed to save config' });
    // Backfill the service type id (needed for the auto-on scheduler) in the
    // background; only works when a PCO API key is configured.
    if (pcoApiKey()) {
      resolveServiceTypeId(service.serviceId, { apiKey: pcoApiKey() })
        .then((st) => {
          if (st && !service.serviceTypeId) {
            service.serviceTypeId = st;
            persist();
          }
        })
        .catch(() => {});
    }
    res.status(201).json({ service });
  });

  app.put('/api/services/:id', (req, res) => {
    const service = findService(req.params.id);
    if (!service) return res.status(404).json({ error: 'service not found' });
    const body = req.body || {};
    if (body.serviceId !== undefined) {
      const serviceId = typeof body.serviceId === 'string' ? body.serviceId.trim() : '';
      if (!serviceId) return res.status(400).json({ error: 'serviceId cannot be empty' });
      service.serviceId = serviceId;
    }
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      service.name = name || service.serviceId;
    }
    if (body.displayType !== undefined) {
      service.displayType = typeof body.displayType === 'string' ? body.displayType.trim() : '';
    }
    if (!persist()) return res.status(500).json({ error: 'failed to save config' });
    res.json({ service });
  });

  app.delete('/api/services/:id', (req, res) => {
    const idx = config.services.findIndex((s) => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'service not found' });
    const [removed] = config.services.splice(idx, 1);
    if (config.activeServiceId === removed.id) {
      config.activeServiceId = null;
      syncKiosk();
    }
    if (!persist()) return res.status(500).json({ error: 'failed to save config' });
    res.json({ ok: true });
  });

  // Select a service: record it as active and navigate the kiosk tab there.
  // If the kiosk is unreachable we still record the selection so that the
  // next connection self-heals, and report 502 so the UI can warn.
  app.post('/api/select', async (req, res) => {
    const service = findService((req.body || {}).id);
    if (!service) return res.status(404).json({ error: 'service not found' });
    const url = buildUrl(config.urlTemplate, service);
    const displayTypeValue = service.displayType || config.defaultDisplayType;
    const applyDisplayType = !!displayTypeValue;
    const applyTheme = !!config.defaultTheme;
    const needsDesktop = applyDisplayType || applyTheme;

    try {
      // The layout/theme controls only render at a desktop viewport. Emulate
      // one BEFORE navigating so the TV never shows the emulated (zoomed)
      // view — it lands inside the loading screen instead.
      if (needsDesktop) await kiosk.setDeviceMetrics(1920, 1080);
      const result = await kiosk.navigate(url);
      if (needsDesktop && result.skipped) {
        // The tab was already on this URL (loaded at its native viewport, so
        // no controller controls). Reload it so it re-renders at the desktop
        // viewport we just emulated.
        await kiosk.reload();
      }
      config.activeServiceId = service.id;
      if (!persist()) return res.status(500).json({ error: 'failed to save config' });

      // Apply the display type (per-service override, else the saved default)
      // and the default theme. Best-effort — never blocks the selection.
      let displayType = null;
      if (applyDisplayType) {
        try {
          await kiosk.setDisplayType(displayTypeValue, { emulate: false, restoreViewport: false });
          displayType = { value: displayTypeValue, applied: true, source: service.displayType ? 'service' : 'default' };
        } catch (err) {
          logger.warn(`[kiosk] display type "${displayTypeValue}" not applied: ${err.message}`);
          displayType = { value: displayTypeValue, applied: false, error: err.message };
        }
      }
      if (applyTheme) {
        try {
          await kiosk.setTheme(config.defaultTheme, { emulate: false, restoreViewport: false });
        } catch (err) {
          logger.warn(`[kiosk] theme "${config.defaultTheme}" not applied: ${err.message}`);
        }
      }
      res.json({ ok: true, url, activeServiceId: service.id, skipped: result.skipped, displayType });
    } catch (err) {
      config.activeServiceId = service.id;
      persist();
      res.status(502).json({
        error: 'kiosk unreachable',
        detail: err.message,
        url,
        activeServiceId: service.id,
      });
    } finally {
      if (needsDesktop) {
        try { await kiosk.clearDeviceMetrics(); } catch { /* kiosk may be down */ }
      }
    }
  });

  // Set the kiosk's current live page display type directly (used by the
  // panel's remote-control section to experiment without editing a service).
  app.post('/api/kiosk/display-type', async (req, res) => {
    const value = (req.body || {}).value;
    if (!value) return res.status(400).json({ error: 'value is required' });
    try {
      await kiosk.setDisplayType(value);
      res.json({ ok: true, value });
    } catch (err) {
      logger.error(`[kiosk] set display type failed: ${err.message}`);
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/deselect', async (req, res) => {
    try {
      await kiosk.navigate(kiosk.idleUrl);
    } catch (err) {
      logger.warn(`[kiosk] deselect navigate failed: ${err.message}`);
    }
    config.activeServiceId = null;
    persist();
    res.json({ ok: true, activeServiceId: null });
  });

  // --- Optional Planning Center API integration (read-only) ---

  // Never returns the key itself; only whether one is configured.
  app.get('/api/pco/status', (req, res) => {
    res.json({ configured: !!pcoApiKey(), viaEnv: !!process.env.KIOSK_PCO_API_KEY });
  });

  // Save/clear the API key in the config file (empty string clears it).
  app.put('/api/pco/config', (req, res) => {
    const apiKey = typeof (req.body || {}).apiKey === 'string' ? req.body.apiKey.trim() : '';
    config.pco.apiKey = apiKey || null;
    if (!persist()) return res.status(500).json({ error: 'failed to save config' });
    res.json({ configured: !!pcoApiKey(), viaEnv: !!process.env.KIOSK_PCO_API_KEY });
  });

  app.get('/api/pco/plans', async (req, res) => {
    const apiKey = pcoApiKey();
    if (!apiKey) return res.status(400).json({ error: 'no Planning Center API key configured' });
    try {
      const existing = new Set(config.services.map((s) => s.serviceId));
      const groups = await listPlanGroups({ apiKey, signal: req.signal });
      for (const group of groups) {
        for (const st of group.serviceTypes) {
          for (const plan of st.plans) plan.existing = existing.has(plan.id);
        }
      }
      res.json({ groups });
    } catch (err) {
      handlePcoError(err, res);
    }
  });

  // Add selected plans to the service list (dedupes by PCO plan id).
  app.post('/api/pco/import', async (req, res) => {
    const apiKey = pcoApiKey();
    if (!apiKey) return res.status(400).json({ error: 'no Planning Center API key configured' });
    const planIds = Array.isArray((req.body || {}).planIds) ? (req.body.planIds || []).map(String) : [];
    if (!planIds.length) return res.status(400).json({ error: 'planIds is required' });
    try {
      const plans = await listPlans({ apiKey, signal: req.signal });
      const existingIds = new Set(config.services.map((s) => s.serviceId));
      const created = [];
      const skipped = [];
      for (const id of planIds) {
        if (existingIds.has(id)) {
          skipped.push({ id, reason: 'already exists' });
          continue;
        }
        const plan = plans.find((p) => p.id === id);
        if (!plan) {
          skipped.push({ id, reason: 'not found' });
          continue;
        }
        const service = {
          id: crypto.randomUUID(),
          name: `${plan.serviceTypeName} \u00b7 ${plan.shortDates || plan.sortDate || id}`,
          serviceId: id,
          displayType: '',
          serviceTypeId: plan.serviceTypeId || null,
        };
        config.services.push(service);
        existingIds.add(id);
        created.push(service);
      }
      if (!persist()) return res.status(500).json({ error: 'failed to save config' });
      res.json({ ok: true, created, skipped });
    } catch (err) {
      handlePcoError(err, res);
    }
  });

  // --- Wi-Fi (supported SBCs only, e.g. Raspberry Pi with NetworkManager) ---
  // The panel only shows this section when wifi.isAvailable() is true, so
  // Windows/macOS and unsupported boards never see it. Passwords go straight
  // to NetworkManager; they are never stored in config.json or logged.

  app.get('/api/wifi/status', async (req, res) => {
    try {
      res.json(await wifi.status({ signal: req.signal }));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Rescans (a few seconds on an SBC) and returns nearby networks.
  app.get('/api/wifi/networks', async (req, res) => {
    try {
      const r = await wifi.listNetworks({ signal: req.signal });
      if (!r.ok) return res.status(502).json({ error: r.error || 'wifi scan failed' });
      res.json({ supported: true, networks: r.networks });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/wifi/connect', async (req, res) => {
    try {
      const body = req.body || {};
      const ssid = typeof body.ssid === 'string' ? body.ssid.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const r = await wifi.connectNetwork(ssid, password);
      if (!r.ok) return res.status(502).json({ error: r.error || 'could not connect' });
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // --- Remote control of the kiosk tab (screencast + input forwarding) ---
  // Used for the one-time PCO login from a phone: the panel streams the kiosk
  // tab and forwards taps/keystrokes, so the session cookie lands in the
  // kiosk's own Chromium profile. These routes sit behind requireAuth, so LAN
  // clients must be logged in (loopback stays exempt for the kiosk window).
  const sseClients = new Set();
  let remoteActive = false;
  let lastFrameMeta = null;

  kiosk.on('frame', (params) => {
    lastFrameMeta = params.metadata || lastFrameMeta;
    const payload = `data: ${JSON.stringify({ data: params.data, meta: params.metadata })}\n\n`;
    for (const client of sseClients) client.write(payload);
  });

  // Map a point in the screencast frame (device pixels of the JPEG) to CSS
  // page coordinates for Input.dispatchMouseEvent.
  function frameToPage(x, y) {
    const meta = lastFrameMeta || {};
    const scale = meta.pageScaleFactor || 1;
    return {
      x: (x - (meta.offsetX || 0)) / scale + (meta.scrollOffsetX || 0),
      y: (y - (meta.offsetY || 0)) / scale + (meta.scrollOffsetY || 0),
    };
  }

  // keyCode matches what KioskDriver.key() forwards as windowsVirtualKeyCode.
  const KEYMAP = {
    Enter: { key: 'Enter', code: 'Enter', text: '\r', keyCode: 13 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  };

  app.post('/api/remote/start', async (req, res) => {
    const url = (req.body || {}).url;
    try {
      if (url) {
        await kiosk.navigate(url);
        // Let the renderer finish navigating/loading before asking Chrome for
        // a screencast, otherwise Page.startScreencast fails with
        // "Not attached to an active page".
        await kiosk.waitForPageLoad();
      }
      await kiosk.startScreencast();
      remoteActive = true;
      res.json({ ok: true });
    } catch (err) {
      logger.error(`[remote] start failed: ${err.message}`);
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/remote/stop', async (req, res) => {
    remoteActive = false;
    await kiosk.stopScreencast();
    lastFrameMeta = null;
    for (const client of sseClients) client.end();
    sseClients.clear();
    res.json({ ok: true });
  });

  app.post('/api/remote/input', async (req, res) => {
    const body = req.body || {};
    try {
      if (body.type === 'mouse') {
        const p = frameToPage(Number(body.x) || 0, Number(body.y) || 0);
        const ev = body.event; // move | down | up
        const isDown = ev === 'down';
        const isUp = ev === 'up';
        const type = isDown ? 'mousePressed' : isUp ? 'mouseReleased' : 'mouseMoved';
        await kiosk.dispatchMouse({
          type,
          x: Math.round(p.x),
          y: Math.round(p.y),
          button: body.button || 'left',
          buttons: isDown ? 1 : 0,
          clickCount: isDown ? 1 : 1,
        });
      } else if (body.type === 'text' && typeof body.text === 'string') {
        await kiosk.insertText(body.text);
      } else if (body.type === 'key' && KEYMAP[body.key]) {
        const spec = KEYMAP[body.key];
        // Only the char event carries `text`; down/up get key identity + keyCode.
        await kiosk.key({ type: 'rawKeyDown', key: spec.key, code: spec.code, keyCode: spec.keyCode });
        if (spec.text !== undefined) {
          await kiosk.key({ type: 'char', key: spec.key, code: spec.code, text: spec.text, keyCode: spec.keyCode });
        }
        await kiosk.key({ type: 'keyUp', key: spec.key, code: spec.code, keyCode: spec.keyCode });
      } else {
        return res.status(400).json({ error: 'unsupported input' });
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error(`[remote] input failed: ${err.message}`);
      res.status(502).json({ error: err.message });
    }
  });

  // Server-Sent Events stream of screencast frames (one-way; inputs go over
  // POST /api/remote/input).
  app.get('/api/remote/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ connected: kiosk.connected, active: remoteActive })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // --- Background scheduler (auto-on + daily reboot) ---
  let scheduler = null;
  if (runScheduler) {
    const { createScheduler } = require('./scheduler');
    scheduler = createScheduler({
      config,
      persist,
      pco: { listPlanTimes, resolveServiceTypeId },
      cec,
      apiKey: pcoApiKey,
      logger,
      rebootFn,
    });
    scheduler.start();
  }

  return { app, kiosk, config, scheduler };
}

function renderNowPlaying() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiosk</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0d1117;
    color: #e6edf3;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 5vmin;
  }
  main { max-width: 60rem; }
  .label { font-size: 3vmin; letter-spacing: 0.35em; text-transform: uppercase; color: #7d8590; margin-bottom: 3vmin; }
  #name { font-size: 11vmin; line-height: 1.15; font-weight: 700; color: #f0f6fc; }
  #sub { margin-top: 3vmin; font-size: 4vmin; color: #7d8590; }
  body[data-active="true"] #name { color: #f0883e; }
</style>
</head>
<body data-active="false">
  <main>
    <p class="label">Planning Center</p>
    <h1 id="name">Waiting for a service selection&hellip;</h1>
    <p id="sub"></p>
  </main>
  <script>
    (async function tick() {
      try {
        const s = await (await fetch('/api/state')).json();
        const active = s.services.find(function (x) { return x.id === s.activeServiceId; });
        var name = document.getElementById('name');
        var sub = document.getElementById('sub');
        if (active) {
          name.textContent = active.name;
          sub.textContent = 'Selected from the control panel \u2014 switch anytime.';
          document.body.dataset.active = 'true';
        } else {
          name.textContent = 'Waiting for a service selection\u2026';
          sub.textContent = '';
          document.body.dataset.active = 'false';
        }
      } catch (e) { /* control server restarting */ }
      setTimeout(tick, 5000);
    })();
  </script>
</body>
</html>
`;
}

module.exports = { createApp };
