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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

const children = [];
let stopping = false;

function start(label, cmd, args) {
  console.log(`[run] starting ${label}`);
  const child = spawn(cmd, args, { stdio: 'inherit' });
  children.push({ label, child });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.log(`[run] ${label} exited (code=${code} signal=${signal}); restarting in 3s`);
    setTimeout(() => start(label, cmd, args), 3000);
  });
  child.on('error', (err) => {
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

function main() {
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
