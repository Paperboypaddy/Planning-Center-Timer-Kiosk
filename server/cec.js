'use strict';

// HDMI-CEC power control for the TV, via cec-client (cec-utils package).
// All functions are safe to call when cec-client is missing or the TV/CEC
// bus is unavailable — they resolve with { ok: false } rather than throwing.

const { spawn, spawnSync } = require('child_process');

let availabilityChecked = false;
let cecAvailable = false;

function commandExists(cmd) {
  // spawnSync returns { status } — status 0 means the command was found.
  // A non-zero exit (command missing) is NOT an exception, so check the code.
  const r = spawnSync('which', [cmd], { stdio: 'ignore', timeout: 3000 });
  return r.status === 0;
}

function isAvailable() {
  if (!availabilityChecked) {
    cecAvailable = commandExists('cec-client');
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

module.exports = { isAvailable, powerOn, powerOff, powerStatus };
