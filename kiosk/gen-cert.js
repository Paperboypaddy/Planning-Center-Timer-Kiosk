'use strict';

// Generate a self-signed certificate for the panel (HTTPS) on any OS.
// CLI: node kiosk/gen-cert.js [outDir] [commonName]
// API: const { generateCert } = require('./gen-cert'); await generateCert(dir, host)
//
// Writes kiosk-cert.pem and kiosk-key.pem into outDir. On Linux the installer
// chowns them to the caddy user; the Windows single-file app generates them
// into its own userData directory.

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

async function generateCert(outDir, host, ip = lanIp()) {
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
  const key = path.join(outDir, 'kiosk-key.pem');
  const cert = path.join(outDir, 'kiosk-cert.pem');
  fs.writeFileSync(key, pems.private);
  fs.writeFileSync(cert, pems.cert);
  return { key, cert };
}

async function main() {
  const outDir = process.argv[2] || '/etc/caddy';
  const host = process.argv[3] || `${os.hostname()}.local`;
  const { key, cert } = await generateCert(outDir, host);
  console.log(`wrote ${cert} / ${key} (CN=${host})`);
}

module.exports = { generateCert };

if (require.main === module) {
  main().catch((err) => {
    console.error(`gen-cert failed: ${err.message}`);
    process.exit(1);
  });
}
