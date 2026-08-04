'use strict';

// First-run setup for installers that don't use install.sh (Windows/macOS).
// Generates the panel password, a self-signed cert, and the Caddy config for
// the HTTPS + Basic Auth panel proxy; run.js then starts Caddy with it.
//
// Usage: node kiosk/setup.js [appDir] [outDir]
//   appDir  app directory (Caddyfile + panel-login.txt written here; default cwd)
//   outDir  where certs go (default <appDir>/caddy)
//
// Env overrides: KIOSK_PANEL_USER, KIOSK_PANEL_PASSWORD

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const bcrypt = require('bcryptjs');

function randomPassword(len = 20) {
  return crypto.randomBytes(len).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, len);
}

async function main() {
  const appDir = path.resolve(process.argv[2] || process.cwd());
  const outDir = path.resolve(process.argv[3] || path.join(appDir, 'caddy'));
  const user = process.env.KIOSK_PANEL_USER || 'kiosk';
  const password = process.env.KIOSK_PANEL_PASSWORD || randomPassword();
  const host = `${os.hostname()}.local`;

  // Self-signed cert (cross-platform generator).
  execFileSync(process.execPath, [path.join(__dirname, 'gen-cert.js'), outDir, host], { stdio: 'inherit' });

  // Caddy's basic_auth requires a bcrypt hash of the password.
  const hash = bcrypt.hashSync(password, 10);
  const certPath = path.join(outDir, 'kiosk-cert.pem').replace(/\\/g, '/');
  const keyPath = path.join(outDir, 'kiosk-key.pem').replace(/\\/g, '/');

  const caddyfile = `:443 {
    tls ${certPath} ${keyPath}
    basic_auth {
        ${user} ${hash}
    }
    reverse_proxy 127.0.0.1:3001 {
        flush_interval -1
    }
}
`;
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'Caddyfile'), caddyfile);
  fs.writeFileSync(
    path.join(appDir, 'panel-login.txt'),
    `Planning Center Kiosk control panel\nURL:      https://${host}\nUsername: ${user}\nPassword: ${password}\n`
  );

  console.log(`Panel:     https://${host}`);
  console.log(`Username:  ${user}`);
  console.log(`Password:  ${password}`);
  console.log(`(saved to ${path.join(appDir, 'panel-login.txt')})`);
}

main().catch((err) => {
  console.error(`setup failed: ${err.message}`);
  process.exit(1);
});
