'use strict';

const { EventEmitter } = require('events');
const CDP = require('chrome-remote-interface');

const DEFAULT_RECONNECT_MS = 5000;

// The live-page layout options offered by the Planning Center live controller
// toolbar ("display type" for a service). Stored per-service in `displayType`
// or globally as the default display type.
const DISPLAY_TYPES = ['Normal Layout', 'Countdown Full', 'Countdown Lower', 'Lower Third', 'Fullscreen Overview'];

// The light/dark theme toggle on the live controller toolbar.
const THEMES = ['light', 'dark'];

// Drives the kiosk's Chromium tab over the Chrome DevTools Protocol.
//
// Chromium runs with --remote-debugging-port=9222 (localhost only) and a
// persistent --user-data-dir. We connect to the *page* target (the actual
// browser tab), so navigation is a true top-level navigation — unaffected by
// X-Frame-Options / CSP frame-blocking headers.
//
// The driver tolerates Chromium being down or restarting: a background loop
// keeps (re)connecting, and each (re)connection emits 'connect' so the server
// can re-normalize the tab to the active service (or the idle page).
class KioskDriver extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 9222, idleUrl = '', reconnectMs = DEFAULT_RECONNECT_MS } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.idleUrl = idleUrl;
    this.reconnectMs = reconnectMs;
    this.client = null;
    this.stopped = false;
    this._connecting = null;
    this._exclusive = Promise.resolve();
  }

  // Serialize mutations that touch viewport / navigation so overlapping
  // select / display-type / theme / remote-start calls cannot interleave CDP.
  runExclusive(fn) {
    const run = this._exclusive.then(() => fn());
    // Keep the chain alive even if fn rejects; swallow so the queue continues.
    this._exclusive = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  get connected() {
    return !!this.client;
  }

  // Pick the "kiosk tab". Prefer the tab sitting on the idle page; otherwise
  // fall back to the first page target (a kiosk typically has exactly one tab).
  _selectTarget(targets) {
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!pages.length) throw new Error('no page targets available (Chromium not ready?)');
    if (this.idleUrl) {
      const match = pages.find((t) => normalizeUrl(t.url).startsWith(normalizeUrl(this.idleUrl)));
      if (match) return match;
    }
    return pages[0];
  }

  _listTargets() {
    return CDP.List({ host: this.host, port: this.port });
  }

  async connect() {
    if (this.stopped) throw new Error('kiosk driver stopped');
    if (this.client) return this.client;
    if (this._connecting) return this._connecting;

    this._connecting = (async () => {
      const client = await CDP({
        host: this.host,
        port: this.port,
        target: (targets) => this._selectTarget(targets),
        // Use the protocol schema bundled with chrome-remote-interface instead
        // of fetching /json/protocol on every (re)connect.
        local: true,
      });
      if (this.stopped) {
        try { client.close(); } catch { /* ignore */ }
        throw new Error('kiosk driver stopped');
      }
      client.on('disconnect', () => this._onDisconnect());
      await client.send('Page.enable');
      // Force a black page background on every new document. Sites like the
      // Planning Center SPA paint a white shell before their (dark) theme
      // hydrates, which flashes on a dark-mode TV. --force-dark-mode and
      // --blink-settings cover the browser surfaces but not a page's own CSS,
      // so inject a style as early as possible in each new document.
      try {
        await client.send('Page.addScriptToEvaluateOnNewDocument', {
          source: `(function(){
            function paint(){
              var s = document.createElement('style');
              s.textContent = 'html,body{background-color:#000!important}';
              (document.head || document.documentElement).appendChild(s);
            }
            if (document.documentElement) paint();
            else {
              var t = setInterval(function(){
                if (document.documentElement) { clearInterval(t); paint(); }
              }, 0);
            }
          })();`,
        });
      } catch {
        // unsupported on some Chromium builds; harmless
      }
      if (this.stopped) {
        try { client.close(); } catch { /* ignore */ }
        throw new Error('kiosk driver stopped');
      }
      this.client = client;
      this.emit('connect');
      return client;
    })();

    try {
      return await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  _onDisconnect() {
    this.client = null;
    this.emit('disconnect');
  }

  async currentUrl() {
    try {
      const targets = await this._listTargets();
      return this._selectTarget(targets).url || null;
    } catch {
      return null;
    }
  }

  // Navigate the kiosk tab. Skips the round-trip if it is already on the same
  // URL, so re-selecting a service (or re-syncing after a reconnect) doesn't
  // cause an unnecessary page reload.
  async navigate(url) {
    const current = await this.currentUrl();
    if (current && normalizeUrl(current) === normalizeUrl(url)) {
      return { skipped: true, url };
    }
    const client = await this.connect();
    await client.send('Page.navigate', { url });
    return { skipped: false, url };
  }

  // Background (re)connection loop. Logs nothing on transient failures —
  // Chromium simply may not be running yet.
  start() {
    this.stopped = false;
    this._loop();
  }

  async _loop() {
    while (!this.stopped) {
      try {
        await this.connect();
      } catch {
        // browser down or no tabs yet; retry shortly
      }
      await sleep(this.reconnectMs);
    }
  }

  // --- Remote control (screencast + input) ---
  //
  // Lets the control panel stream the kiosk tab (Page.startScreencast) and
  // forward taps/keystrokes (Input domain). Used for the one-time PCO login
  // from a phone so the session cookie ends up in the kiosk's own profile.

  get screencasting() {
    return !!this._screencasting;
  }

  // Best-effort wait for the current page to finish loading. Chrome refuses
  // Page.startScreencast with "Not attached to an active page" while the
  // renderer is mid-navigation, so call this after navigating somewhere.
  async waitForPageLoad({ timeoutMs = 15000 } = {}) {
    const client = await this.connect();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const resp = await client.send('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        });
        if (resp.result && resp.result.value === 'complete') return true;
      } catch {
        // navigation may interrupt evaluation; keep polling
      }
      if (Date.now() >= deadline) return false;
      await sleep(250);
    }
  }

  async startScreencast({ quality = 60, maxWidth = 1280, maxHeight = 720 } = {}) {
    if (this._screencasting) await this.stopScreencast();
    const client = await this.connect();
    this._frameHandler = (params) => {
      this.emit('frame', params);
      // Chrome only keeps producing frames after we ack each one.
      client.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    };
    client.on('Page.screencastFrame', this._frameHandler);
    const params = {
      format: 'jpeg',
      quality,
      maxWidth,
      maxHeight,
      everyNthFrame: 1,
    };
    let lastErr;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await client.send('Page.startScreencast', params);
        this._screencasting = true;
        return;
      } catch (err) {
        lastErr = err;
        if (err.message && err.message.includes('Not attached to an active page')) {
          await sleep(500);
          continue;
        }
        break;
      }
    }
    client.removeListener('Page.screencastFrame', this._frameHandler);
    this._frameHandler = null;
    throw lastErr;
  }

  async stopScreencast() {
    if (!this._screencasting) return;
    this._screencasting = false;
    try {
      const client = await this.connect();
      if (this._frameHandler) {
        client.removeListener('Page.screencastFrame', this._frameHandler);
        this._frameHandler = null;
      }
      await client.send('Page.stopScreencast');
    } catch {
      // client may have died; the reconnect loop re-syncs everything
    }
  }

  // x/y are CSS pixels relative to the page viewport.
  async dispatchMouse({ x, y, type, button = 'left', buttons = 0, clickCount = 1 }) {
    const client = await this.connect();
    await client.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount });
  }

  async insertText(text) {
    const client = await this.connect();
    await client.send('Input.insertText', { text });
  }

  async key({ type, key, code, text, keyCode }) {
    const client = await this.connect();
    await client.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      text,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }

  // Evaluate JS in the kiosk tab and return the (by-value) result.
  async evaluate(expression) {
    const client = await this.connect();
    const resp = await client.send('Runtime.evaluate', { expression, returnByValue: true });
    if (resp.exceptionDetails) throw new Error('page evaluation failed');
    return resp.result && resp.result.value;
  }

  async setDeviceMetrics(width, height) {
    const client = await this.connect();
    await client.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async clearDeviceMetrics() {
    const client = await this.connect();
    try { await client.send('Emulation.clearDeviceMetricsOverride'); } catch { /* tab may have navigated */ }
  }

  // Reload the kiosk tab so it re-renders at the current (possibly emulated)
  // viewport. Used when a navigation was skipped but the page needs to pick up
  // a desktop viewport to show the live-controller controls.
  async reload() {
    const client = await this.connect();
    await client.send('Page.reload', { ignoreCache: true });
  }

  // Set the live page's display type (the layout dropdown in the PCO live
  // controller toolbar). The dropdown only renders in a desktop-size
  // viewport, so we briefly emulate one, select the layout, then restore the
  // native viewport. Pass `emulate: false` (with viewport handled by the
  // caller) when driving the layout as part of a select flow that emulates
  // *before* navigating, so the TV never shows the emulated view.
  async setDisplayType(value, { restoreViewport = true, emulate = true } = {}) {
    if (!DISPLAY_TYPES.includes(value)) {
      throw new Error(`unknown display type "${value}"; expected one of: ${DISPLAY_TYPES.join(', ')}`);
    }
    const client = await this.connect();
    if (emulate) await this.setDeviceMetrics(1920, 1080);
    try {
      const target = JSON.stringify(value);
      const deadline = Date.now() + 15000;
      for (;;) {
        const r = await this.evaluate(`(() => {
          const LAYOUT = ${JSON.stringify(DISPLAY_TYPES)};
          const groups = [...document.querySelectorAll('.LiveToolbar-control.dropdown-group')];
          const g = groups.find(x => [...x.querySelectorAll('.dropdown-menu li span')]
            .some(s => LAYOUT.includes((s.textContent || '').trim())));
          if (!g) return { state: 'waiting' };
          const trigger = ((g.querySelector('.dropdown-trigger') || {}).textContent || '').trim();
          if (trigger === ${target}) return { state: 'done' };
          const span = [...g.querySelectorAll('.dropdown-menu li span')]
            .find(s => (s.textContent || '').trim() === ${target});
          if (!span) return { state: 'bad-value', items: [...g.querySelectorAll('.dropdown-menu li span')].map(s => (s.textContent || '').trim()) };
          span.click();
          return { state: 'clicked' };
        })()`);
        if (r && r.state === 'done') return { ok: true };
        if (r && r.state === 'bad-value') {
          throw new Error(`display type "${value}" not in the live page menu: ${(r.items || []).join(', ')}`);
        }
        if (Date.now() > deadline) {
          throw new Error(
            r && r.state === 'waiting'
              ? 'live controller toolbar not available on this page'
              : `could not set display type "${value}"`
          );
        }
        await sleep(500);
      }
    } finally {
      if (emulate && restoreViewport) await this.clearDeviceMetrics();
    }
  }

  // Set the live page's light/dark theme (the radio switch in the live
  // controller toolbar). Same viewport dance as setDisplayType.
  async setTheme(theme, { restoreViewport = true, emulate = true } = {}) {
    if (!THEMES.includes(theme)) {
      throw new Error(`unknown theme "${theme}"; expected light or dark`);
    }
    const client = await this.connect();
    if (emulate) await this.setDeviceMetrics(1920, 1080);
    try {
      const target = JSON.stringify(theme);
      const deadline = Date.now() + 15000;
      for (;;) {
        const r = await this.evaluate(`(() => {
          const sw = document.querySelector('.theme-toggle-switch');
          if (!sw) return { state: 'waiting' };
          const checked = sw.querySelector('input:checked');
          if (checked && checked.value === ${target}) return { state: 'done' };
          const input = sw.querySelector('input[value=${target}]');
          if (!input) return { state: 'bad-value' };
          input.click();
          return { state: 'clicked' };
        })()`);
        if (r && r.state === 'done') return { ok: true };
        if (r && r.state === 'bad-value') throw new Error(`theme "${theme}" switch not found on this page`);
        if (Date.now() > deadline) {
          throw new Error(r && r.state === 'waiting' ? 'theme switch not available on this page' : `could not set theme "${theme}"`);
        }
        await sleep(500);
      }
    } finally {
      if (emulate && restoreViewport) await this.clearDeviceMetrics();
    }
  }

  stop() {
    this.stopped = true;
    if (this.client) {
      try { this.client.close(); } catch { /* already closed */ }
    }
    this.client = null;
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return (url || '').trim();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { KioskDriver, normalizeUrl, DISPLAY_TYPES, THEMES };
