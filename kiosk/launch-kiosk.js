'use strict';

// Cross-platform kiosk browser launcher.
//
// Resolves Chrome/Edge/Chromium, builds the kiosk flag set, and launches the
// browser. X-only extras (waiting for the X server, disabling blanking, hiding
// the cursor) run only on Linux X11 sessions. Under Wayland (e.g. NixOS + Cage)
// those are skipped and Chromium is launched with --ozone-platform=wayland.
// Everything else is identical on Windows, macOS, and Linux, so the same
// control server + CDP drive the tab everywhere.
//
// Modes:
//   (default)      normal window at $KIOSK_URL
//   --kiosk        fullscreen kiosk at $KIOSK_URL
//   --login        maximized window (same profile dir) for the one-time login
//
// Environment:
//   KIOSK_CHROMIUM    explicit browser path (default: auto-detect)
//   KIOSK_PROFILE_DIR persistent profile dir (default per-OS)
//   KIOSK_URL         initial URL (default: control server idle page)
//   KIOSK_DEBUG_PORT  CDP port (default 9222, localhost only)
//   KIOSK_X_TIMEOUT   seconds to wait for X on Linux X11 (default 60)
//   WAYLAND_DISPLAY / XDG_SESSION_TYPE=wayland — skip X extras, use ozone Wayland

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PLATFORM = process.platform;
const DEFAULT_IDLE_URL = 'http://127.0.0.1:3001/nowplaying';
const DEFAULT_DEBUG_PORT = '9222';

function defaultProfileDir(platform = PLATFORM, env = process.env, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || home, 'kiosk-chromium');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'kiosk-chromium');
  return path.join(home, '.config', 'kiosk-chromium');
}

function browserCandidates(platform = PLATFORM, env = process.env) {
  if (platform === 'win32') {
    const pf32 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const pf64 = env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(pf32, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf64, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf64, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf32, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  // linux: command names resolved via PATH
  return ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
}

function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function commandExists(cmd) {
  const r = spawnSync(PLATFORM === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

function findBrowser(platform = PLATFORM, env = process.env) {
  const override = env.KIOSK_CHROMIUM;
  if (override) {
    if (!exists(override)) throw new Error(`KIOSK_CHROMIUM set but not found: ${override}`);
    return override;
  }
  const candidates = browserCandidates(platform, env);
  if (platform === 'linux') {
    for (const c of candidates) if (commandExists(c)) return c;
  } else {
    for (const c of candidates) if (exists(c)) return c;
  }
  throw new Error('no Chromium/Chrome/Edge browser found; set KIOSK_CHROMIUM to one');
}

function isWayland(env = process.env) {
  return !!(env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland');
}

function buildFlags({ profileDir, debugPort, wayland = false }) {
  const flags = [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--noerrdialogs',
    '--disable-session-crashed-bubble',
    '--password-store=basic',
    '--force-dark-mode',
    '--blink-settings=backgroundcolor=FF000000',
    '--disable-features=TranslateUI,MediaRouter',
  ];
  if (wayland) flags.push('--ozone-platform=wayland');
  return flags;
}

// mode: 'window' | 'kiosk' | 'login'
function buildCommandLine({ chrome, profileDir, debugPort, url, mode, wayland = false }) {
  const args = [chrome, ...buildFlags({ profileDir, debugPort, wayland })];
  if (mode === 'login') {
    args.push('--start-maximized');
  } else if (mode === 'kiosk') {
    args.push('--kiosk', url);
  } else {
    args.push(url);
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Linux: wait for the X server before launching (the kiosk systemd service can
// start before lightdm has brought up :0). Mirrors the old bash launcher.
async function waitForX(timeoutMs) {
  const display = process.env.DISPLAY || ':0';
  const socket = path.join('/tmp/.X11-unix', `X${String(display).replace(/^:/, '')}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(socket)) return;
    if (Date.now() >= deadline) {
      console.error(`error: X server not ready (${socket} missing after ${timeoutMs / 1000}s)`);
      process.exit(1);
    }
    await sleep(1000);
  }
}

function setBlankOff() {
  for (const args of [['s', 'off'], ['s', 'noblank'], ['-dpms']]) {
    try {
      spawnSync('xset', args, { stdio: 'ignore' });
    } catch {
      /* xset missing */
    }
  }
}

function hideCursor() {
  try {
    const child = spawn('unclutter', ['-idle', '0.5', '-root'], { stdio: 'ignore' });
    child.on('error', () => {});
    return child;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--login') ? 'login' : args.includes('--kiosk') ? 'kiosk' : 'window';

  let chrome;
  try {
    chrome = findBrowser();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const profileDir = process.env.KIOSK_PROFILE_DIR || defaultProfileDir();
  const debugPort = process.env.KIOSK_DEBUG_PORT || DEFAULT_DEBUG_PORT;
  const url = process.env.KIOSK_URL || DEFAULT_IDLE_URL;
  const wayland = isWayland();
  fs.mkdirSync(profileDir, { recursive: true });

  // X11 kiosk (Debian install.sh): wait for :0, blanking off, hide cursor.
  // Wayland kiosk (NixOS + Cage): compositor is already up; skip X extras.
  if (PLATFORM === 'linux' && !wayland) {
    await waitForX(Number(process.env.KIOSK_X_TIMEOUT || 60) * 1000);
    setBlankOff();
  }

  const cmdLine = buildCommandLine({ chrome, profileDir, debugPort, url, mode, wayland });
  const browser = spawn(cmdLine[0], cmdLine.slice(1), { stdio: 'inherit' });
  let unclutter = null;
  if (PLATFORM === 'linux' && !wayland) unclutter = hideCursor();

  browser.on('error', (err) => {
    console.error(`error: failed to start browser (${cmdLine[0]}): ${err.message}`);
    process.exit(1);
  });
  browser.on('exit', (code, signal) => {
    if (unclutter) {
      try {
        unclutter.kill();
      } catch {
        /* already gone */
      }
    }
    if (signal) process.exit(0);
    process.exit(code == null ? 0 : code);
  });
}

module.exports = {
  browserCandidates,
  findBrowser,
  buildFlags,
  buildCommandLine,
  defaultProfileDir,
  isWayland,
  main,
};

if (require.main === module) {
  main();
}
