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
