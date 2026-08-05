'use strict';

// First-run setup for installers that don't use install.sh (macOS).
// Generates a self-signed cert and the Caddy config for the HTTPS panel proxy;
// run.js then starts Caddy with it. Authentication is handled by the app
// itself (a login page with a first-run admin setup), so Caddy is TLS-only.
//
// Usage: node kiosk/setup.js [appDir] [outDir]
//   appDir  app directory (Caddyfile written here; default cwd)
//   outDir  where certs go (default <appDir>/caddy)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

async function main() {
  const appDir = path.resolve(process.argv[2] || process.cwd());
  const outDir = path.resolve(process.argv[3] || path.join(appDir, 'caddy'));
  const host = `${os.hostname()}.local`;

  // Self-signed cert (cross-platform generator).
  execFileSync(process.execPath, [path.join(__dirname, 'gen-cert.js'), outDir, host], { stdio: 'inherit' });

  const certPath = path.join(outDir, 'kiosk-cert.pem').replace(/\\/g, '/');
  const keyPath = path.join(outDir, 'kiosk-key.pem').replace(/\\/g, '/');

  const caddyfile = `:443 {
    tls ${certPath} ${keyPath}
    reverse_proxy 127.0.0.1:3001 {
        flush_interval -1
    }
}
`;
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'Caddyfile'), caddyfile);
  console.log(`Panel:     https://${host}`);
  console.log('(create the admin account on first visit to the panel)');
}

main().catch((err) => {
  console.error(`setup failed: ${err.message}`);
  process.exit(1);
});
