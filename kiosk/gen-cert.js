'use strict';

// Generate a self-signed certificate for the Caddy panel proxy on any OS.
// Usage: node kiosk/gen-cert.js [outDir] [commonName]
//
// Writes kiosk-cert.pem and kiosk-key.pem into outDir (default /etc/caddy).
// On Linux the installer chowns them to the caddy user; on Windows/macOS the
// installer writes them into the app directory.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const selfsigned = require('selfsigned');

const DAYS = 3650;

function lanIp() {
  try {
    const out = execFileSync('hostname', ['-I'], { encoding: 'utf8', timeout: 3000 }).trim();
    const first = out.split(/\s+/)[0];
    return first && /^\d+\.\d+\.\d+\.\d+$/.test(first) ? first : '';
  } catch {
    return '';
  }
}

async function main() {
  const outDir = process.argv[2] || '/etc/caddy';
  const host = process.argv[3] || `${os.hostname()}.local`;
  const ip = lanIp();

  const altNames = [
    { type: 2, value: host },
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
  ];
  if (ip) altNames.push({ type: 7, ip });

  const pems = await selfsigned.generate([{ name: 'commonName', value: host }], {
    days: DAYS,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'kiosk-key.pem'), pems.private);
  fs.writeFileSync(path.join(outDir, 'kiosk-cert.pem'), pems.cert);
  console.log(`wrote kiosk-cert.pem / kiosk-key.pem to ${outDir} (CN=${host}${ip ? `, IP=${ip}` : ''})`);
}

main().catch((err) => {
  console.error(`gen-cert failed: ${err.message}`);
  process.exit(1);
});
