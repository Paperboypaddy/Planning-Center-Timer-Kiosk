'use strict';

// HDMI-CEC power control for the TV, via cec-client (cec-utils on Linux; a
// Pulse-Eight USB adapter provides cec-client on Windows/macOS). All functions
// are safe to call when cec-client is missing or the TV/CEC bus is
// unavailable — they resolve with { ok: false } rather than throwing.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let availabilityChecked = false;
let cecAvailable = false;

const PLATFORM = process.platform;

// Cross-platform PATH lookup (no reliance on `which`/`where`).
function scanPathForCommand(cmd, pathEnv = process.env.PATH || '', platform = PLATFORM) {
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = pathEnv.split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, cmd + ext)).isFile()) return path.join(dir, cmd + ext);
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

function isAvailable() {
  if (!availabilityChecked) {
    cecAvailable = !!scanPathForCommand('cec-client');
    availabilityChecked = true;
  }
  return cecAvailable;
}

function run(command, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('cec-client', ['-s', '-d', '1'], { timeout: timeoutMs });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', () => resolve({ ok: true, out, err }));
    child.stdin.write(`${command}\n`);
    child.stdin.end();
  });
}

async function powerOn() {
  if (!isAvailable()) return { ok: false, error: 'cec-client not installed' };
  return run('on 0');
}

async function powerOff() {
  if (!isAvailable()) return { ok: false, error: 'cec-client not installed' };
  return run('standby 0');
}

// Returns { ok, power } where power is 'on' | 'standby' | null.
async function powerStatus() {
  if (!isAvailable()) return { ok: false, power: null, error: 'cec-client not installed' };
  const r = await run('pow 0');
  if (!r.ok) return { ok: false, power: null, error: r.error };
  const m = /power status:\s*(\w+)/i.exec(r.out);
  const power = m ? m[1].toLowerCase() : null;
  return { ok: true, power, raw: r.out.trim().slice(0, 200) };
}

module.exports = { isAvailable, powerOn, powerOff, powerStatus, scanPathForCommand };
