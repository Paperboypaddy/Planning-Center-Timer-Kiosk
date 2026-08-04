'use strict';

// Planning Center Kiosk — single-file Windows app.
//
// One Electron process contains everything: the control server (run in-process
// with in-server HTTPS + Basic Auth for the LAN panel), the kiosk display (an
// Electron BrowserWindow driven by the same CDP logic as everywhere else), and
// a system-tray icon to Start / Stop / Quit.
//
// Tray:
//   Start kiosk     show/reload the kiosk window
//   Stop kiosk      hide the kiosk window (panel stays available)
//   Open panel      open https://<hostname>.local in the default browser
//   Quit            stop everything and exit

const { app, BrowserWindow, Tray, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const LOCAL_PORT = 3001;
const PANEL_PORT = 443;
const PANEL_HOST = `${os.hostname()}.local`;

let kioskWindow = null;
let kioskWanted = true;
let quitting = false;
let tray = null;
let logPath = '';

function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(logPath, `${line}\n`);
  } catch {
    /* best effort */
  }
}

// Only one instance of the kiosk may run.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Same Chromium switches the Linux kiosk uses: CDP for the control server,
// and a dark background so page loads don't flash white.
app.commandLine.appendSwitch('remote-debugging-port', '9222');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('force-dark-mode');
app.commandLine.appendSwitch('blink-settings', 'backgroundcolor=FF000000');

function parseLogin(file) {
  const text = fs.readFileSync(file, 'utf8');
  const user = /^User: (.+)$/m.exec(text);
  const pass = /^Password: (.+)$/m.exec(text);
  return { user: user ? user[1] : 'kiosk', password: pass ? pass[1] : '' };
}

// First run: generate the self-signed cert and the panel password.
function ensureSecrets(userData) {
  const certFile = path.join(userData, 'kiosk-cert.pem');
  const keyFile = path.join(userData, 'kiosk-key.pem');
  const loginFile = path.join(userData, 'panel-login.txt');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    const { generateCert } = require('./kiosk/gen-cert');
    return generateCert(userData, PANEL_HOST).then(() => {
      if (!fs.existsSync(loginFile)) {
        const password = crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
        fs.writeFileSync(
          loginFile,
          `Planning Center Kiosk control panel\nURL: https://${PANEL_HOST}\nUser: kiosk\nPassword: ${password}\n`
        );
        log(`first run: generated cert + panel password (${loginFile})`);
      }
      return { certFile, keyFile, loginFile };
    });
  }
  return Promise.resolve({ certFile, keyFile, loginFile });
}

// Start the control server in-process (same server/index.js used everywhere).
function startServer(userData) {
  return ensureSecrets(userData).then(({ certFile, keyFile, loginFile }) => {
    const login = parseLogin(loginFile);
    process.env.KIOSK_PORT = String(LOCAL_PORT);
    process.env.KIOSK_PANEL_PORT = String(PANEL_PORT);
    process.env.KIOSK_TLS = '1';
    process.env.KIOSK_CERT = certFile;
    process.env.KIOSK_KEY = keyFile;
    process.env.KIOSK_PANEL_USER = login.user;
    process.env.KIOSK_PANEL_PASSWORD = login.password;
    process.env.KIOSK_CONFIG = path.join(userData, 'config.json');
    require('./server/index.js');
    log(`control server started (panel https://${PANEL_HOST}, local :${LOCAL_PORT})`);
  });
}

function createKioskWindow() {
  const windowed = process.argv.includes('--windowed') || process.env.KIOSK_WINDOWED === '1';
  kioskWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    fullscreen: !windowed,
    autoHideMenuBar: true,
    backgroundColor: '#000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  kioskWindow.loadURL(`http://127.0.0.1:${LOCAL_PORT}/nowplaying`);
  kioskWindow.on('close', (e) => {
    // Closing the window hides it (tray app behavior) unless we're quitting.
    if (!quitting) {
      e.preventDefault();
      kioskWindow.hide();
    }
  });
  kioskWindow.webContents.on('render-process-gone', (event, details) => {
    log(`kiosk renderer gone: ${details.reason}`);
    if (kioskWanted && !quitting) {
      setTimeout(() => {
        if (kioskWanted && !quitting && kioskWindow) kioskWindow.reload();
      }, 2000);
    }
  });
  log('kiosk window created');
}

function toggleKiosk() {
  kioskWanted = !kioskWanted;
  if (kioskWanted) {
    if (!kioskWindow || kioskWindow.isDestroyed()) {
      createKioskWindow();
    } else {
      kioskWindow.show();
      kioskWindow.reload();
    }
    log('kiosk started');
  } else {
    if (kioskWindow && !kioskWindow.isDestroyed()) kioskWindow.hide();
    log('kiosk stopped (panel stays up)');
  }
  updateTray();
}

function updateTray() {
  const menu = Menu.buildFromTemplate([
    { label: kioskWanted ? 'Stop kiosk' : 'Start kiosk', click: toggleKiosk },
    { type: 'separator' },
    { label: 'Open control panel', click: () => shell.openExternal(`https://${PANEL_HOST}`) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  tray = new Tray(iconPath);
  tray.setToolTip('Planning Center Kiosk');
  tray.on('double-click', () => shell.openExternal(`https://${PANEL_HOST}`));
  updateTray();
}

app.on('window-all-closed', () => {
  // Tray app: keep running until Quit.
});

app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  logPath = path.join(userData, 'kiosk.log');
  log(`--- kiosk app starting (v${app.getVersion()}) ---`);

  startServer(userData)
    .then(() => {
      createTray();
      if (kioskWanted) createKioskWindow();
    })
    .catch((err) => {
      log(`failed to start: ${err.message}`);
      if (!tray) {
        tray = new Tray(path.join(__dirname, 'build', 'icon.ico'));
        updateTray();
      }
    });
});

app.on('second-instance', () => {
  if (kioskWindow) kioskWindow.show();
});
