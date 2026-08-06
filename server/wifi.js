'use strict';

// Wi-Fi management for supported single-board computers.
//
// This is intentionally narrow: the panel can only manage Wi-Fi on hardware we
// have validated. Right now that is a Raspberry Pi running Linux with
// NetworkManager (nmcli). On any other platform (Windows, macOS, Orange Pi,
// x86 Mini PCs) isAvailable() is false and the panel hides the section.
//
// Credentials are passed straight to NetworkManager, which stores the
// connection profile itself; we never persist the password in config.json or
// echo it back. All functions are best-effort and never throw.

const fs = require('fs');
const { execFile } = require('child_process');
const { scanPathForCommand } = require('./cec');

const MODEL_FILES = ['/proc/device-tree/model', '/sys/firmware/devicetree/base/model'];

let checked = false;
let available = false;
let model = null;

function readModel() {
  if (model !== null) return model;
  for (const f of MODEL_FILES) {
    try {
      const s = fs.readFileSync(f, 'utf8');
      if (s && s.trim()) {
        model = s.trim();
        return model;
      }
    } catch {
      // try the next location
    }
  }
  model = '';
  return model;
}

function isRaspberryPi(m) {
  return !!m && /raspberry\s*pi/i.test(m);
}

// Supported = validated SBC hardware + NetworkManager present. Only evaluated
// once per process.
function isAvailable() {
  if (!checked) {
    available = process.platform === 'linux' && isRaspberryPi(readModel()) && !!scanPathForCommand('nmcli');
    checked = true;
  }
  return available;
}

function hardware() {
  return readModel() || null;
}

function runNmcli(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile('nmcli', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '').trim() || err.message });
      resolve({ ok: true, out: stdout });
    });
  });
}

// nmcli -t separates fields with ':' and backslash-escapes ':' and '\' inside
// a value, so split on unescaped colons.
function parseFields(line) {
  const fields = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      cur += line[i + 1];
      i += 1;
    } else if (c === ':') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

// Scan for nearby networks. Requests a fresh scan (takes a few seconds on an
// SBC). Returns { ok, networks } where each network is
// { inUse, ssid, signal, security }.
async function listNetworks({ signal } = {}) {
  if (!isAvailable()) return { ok: false, error: 'wifi is not supported on this device' };
  const r = await runNmcli(
    ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'yes'],
    30000
  );
  if (!r.ok) return r;
  const networks = r.out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [inUse, ssid, signal, security] = parseFields(line);
      return { inUse: inUse === '*', ssid, signal: Number(signal) || 0, security: security || '--' };
    })
    .filter((n) => n.ssid);
  return { ok: true, networks };
}

// Connect to a network. Open networks (empty password) skip the password
// argument. The password is only passed to nmcli; it is never logged or stored
// by the control server.
async function connectNetwork(ssid, password, { signal } = {}) {
  if (!isAvailable()) return { ok: false, error: 'wifi is not supported on this device' };
  if (!ssid) return { ok: false, error: 'ssid is required' };
  const args = ['device', 'wifi', 'connect', ssid];
  if (password) args.push('password', password);
  const r = await runNmcli(args, 60000);
  return r.ok ? { ok: true } : { ok: false, error: r.error || 'connect failed' };
}

// Current connection state: the SSID with an IN-USE flag (cached scan, no
// rescan). Returns { supported, connectedSsid }.
async function status({ signal } = {}) {
  if (!isAvailable()) return { supported: false, connectedSsid: null };
  const r = await runNmcli(['-t', '-f', 'IN-USE,SSID', 'device', 'wifi'], 15000);
  let connectedSsid = null;
  if (r.ok) {
    for (const line of r.out.trim().split('\n')) {
      const [inUse, ...rest] = parseFields(line);
      if (inUse === '*') {
        connectedSsid = rest.join(':');
        break;
      }
    }
  }
  return { supported: true, connectedSsid };
}

module.exports = { connectNetwork, hardware, isAvailable, listNetworks, parseFields, status };
