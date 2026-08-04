'use strict';

// Cross-platform "launch everything" supervisor used on Windows/macOS so the
// kiosk runs as a normal program started at logon. Spawns the control server,
// Caddy (if present), and the kiosk browser, restarting anything that exits.
// On Linux the systemd units already provide this supervision; run.js is only
// needed where there is no systemd service manager.
//
// Flags:
//   --kiosk        launch the browser fullscreen (default: normal window)
//   --no-browser   don't start the browser (server/Caddy only)
//   --no-caddy     don't start Caddy (dev mode, plain HTTP panel)
//   --stop         stop any running children recorded in the pidfile and exit

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PID_FILE = path.join(ROOT, 'run.pids');

const children = [];
let stopping = false;

function readPids() {
  try {
    return fs.readFileSync(PID_FILE, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function writePids(pids) {
  try {
    fs.writeFileSync(PID_FILE, pids.join('\n'));
  } catch {
    /* best effort */
  }
}

function record(pid) {
  const pids = readPids();
  if (!pids.includes(String(pid))) writePids([...pids, String(pid)]);
}

function unrecord(pid) {
  writePids(readPids().filter((p) => p !== String(pid)));
}

function killProcess(pid) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

function start(label, cmd, args) {
  console.log(`[run] starting ${label}`);
  const child = spawn(cmd, args, { stdio: 'inherit' });
  children.push({ label, child });
  record(child.pid);
  child.on('exit', (code, signal) => {
    unrecord(child.pid);
    if (stopping) return;
    console.log(`[run] ${label} exited (code=${code} signal=${signal}); restarting in 3s`);
    setTimeout(() => start(label, cmd, args), 3000);
  });
  child.on('error', (err) => {
    unrecord(child.pid);
    if (stopping) return;
    console.error(`[run] ${label} failed to start: ${err.message}; retrying in 5s`);
    setTimeout(() => start(label, cmd, args), 5000);
  });
  return child;
}

function resolveCaddy() {
  const candidates = [
    path.join(ROOT, 'caddy', process.platform === 'win32' ? 'caddy.exe' : 'caddy'),
    'caddy',
  ];
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['version'], { stdio: 'ignore' });
      if (r.status === 0) return c;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

function resolveCaddyfile() {
  const local = path.join(ROOT, 'Caddyfile');
  if (fs.existsSync(local)) return local;
  if (process.platform === 'linux' && fs.existsSync('/etc/caddy/Caddyfile')) return '/etc/caddy/Caddyfile';
  return null;
}

function stopAll() {
  const pids = readPids();
  if (!pids.length) {
    console.log('[run] nothing recorded to stop');
    return;
  }
  console.log(`[run] stopping ${pids.length} recorded process(es)`);
  for (const pid of pids) killProcess(pid);
  writePids([]);
}

function main() {
  if (process.argv.includes('--stop')) {
    stopAll();
    return;
  }

  const kiosk = process.argv.includes('--kiosk');
  const runBrowser = !process.argv.includes('--no-browser');
  const runCaddy = !process.argv.includes('--no-caddy');

  start('control', NODE, [path.join(ROOT, 'server', 'index.js')]);

  if (runCaddy) {
    const caddy = resolveCaddy();
    const caddyfile = resolveCaddyfile();
    if (caddy && caddyfile) {
      start('caddy', caddy, ['run', '--config', caddyfile]);
    } else {
      console.log('[run] Caddy not found/config missing; panel will be plain HTTP (dev mode)');
    }
  }

  if (runBrowser) {
    const args = [path.join(ROOT, 'kiosk', 'launch-kiosk.js')];
    if (kiosk) args.push('--kiosk');
    start('browser', NODE, args);
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopping = true;
      console.log(`[run] ${sig}; stopping children`);
      for (const { child } of children) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
      setTimeout(() => process.exit(0), 500);
    });
  }
}

main();
