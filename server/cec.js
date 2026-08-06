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
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn('cec-client', ['-s', '-d', '1']);
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish({ ok: false, error: e.message, out, err }));
    child.on('close', (code, signal) => {
      if (timedOut) {
        return finish({ ok: false, error: `cec-client timed out after ${timeoutMs}ms`, out, err });
      }
      if (code !== 0) {
        return finish({
          ok: false,
          error: err.trim() || `cec-client exited with code ${code}${signal ? ` (${signal})` : ''}`,
          out,
          err,
          code,
        });
      }
      finish({ ok: true, out, err });
    });
    try {
      child.stdin.write(`${command}\n`);
      child.stdin.end();
    } catch (e) {
      finish({ ok: false, error: e.message, out, err });
    }
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
