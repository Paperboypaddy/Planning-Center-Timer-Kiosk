'use strict';

const { EventEmitter } = require('events');
const CDP = require('chrome-remote-interface');

const DEFAULT_RECONNECT_MS = 5000;

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
      client.on('disconnect', () => this._onDisconnect());
      await client.send('Page.enable');
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

  stop() {
    this.stopped = true;
    if (this.client) this.client.close();
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

module.exports = { KioskDriver, normalizeUrl };
