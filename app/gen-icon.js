'use strict';

// Generates app/build/icon.ico (used for the EXE and the tray icon) with no
// dependencies: draws a simple dark "countdown clock" and packs it as a
// 256x256 32-bit BMP inside an ICO container.
//
// Usage: node app/gen-icon.js [outputPath]

const fs = require('fs');
const path = require('path');

const SIZE = 256;
const px = Buffer.alloc(SIZE * SIZE * 4); // RGBA, top-down, transparent init

const DARK = [27, 31, 39, 255]; // #1b1f27
const ORANGE = [240, 136, 62, 255]; // #f0883e
const LIGHT = [255, 226, 196, 255];

function set(x, y, col) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  px[i] = col[0];
  px[i + 1] = col[1];
  px[i + 2] = col[2];
  px[i + 3] = col[3];
}

function inRoundedRect(x, y, r) {
  const x1 = Math.min(Math.max(x, r), SIZE - 1 - r);
  const y1 = Math.min(Math.max(y, r), SIZE - 1 - r);
  const dx = x - x1;
  const dy = y - y1;
  return dx * dx + dy * dy <= r * r;
}

function fillCircle(cx, cy, r, col) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) set(x, y, col);
    }
  }
}

function thickLine(x0, y0, x1, y1, w, col) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / len;
  const uy = dy / len;
  const half = w / 2;
  const steps = Math.ceil(len);
  for (let t = 0; t <= steps; t += 1) {
    const cx = x0 + ux * t;
    const cy = y0 + uy * t;
    for (let oy = -Math.ceil(half); oy <= Math.ceil(half); oy += 1) {
      for (let ox = -Math.ceil(half); ox <= Math.ceil(half); ox += 1) {
        if (ox * ox + oy * oy <= half * half) set(Math.round(cx + ox), Math.round(cy + oy), col);
      }
    }
  }
}

function draw() {
  const radius = 44;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (inRoundedRect(x, y, radius)) set(x, y, DARK);
    }
  }
  // clock ring
  fillCircle(128, 128, 96, ORANGE);
  fillCircle(128, 128, 70, DARK);
  // hour + minute hands
  thickLine(128, 128, 128, 84, 10, LIGHT); // 12 o'clock
  thickLine(128, 128, 176, 128, 10, LIGHT); // 3 o'clock
  fillCircle(128, 128, 10, ORANGE);
}

function packBmp() {
  const xor = Buffer.alloc(SIZE * SIZE * 4);
  for (let row = 0; row < SIZE; row += 1) {
    const srcRow = (SIZE - 1 - row) * SIZE * 4; // BMP is bottom-up
    for (let x = 0; x < SIZE; x += 1) {
      const si = (row * SIZE + x) * 4;
      const di = srcRow + x * 4;
      xor[di] = px[si + 2]; // B
      xor[di + 1] = px[si + 1]; // G
      xor[di + 2] = px[si]; // R
      xor[di + 3] = px[si + 3]; // A
    }
  }
  const andMask = Buffer.alloc(SIZE * SIZE / 8); // all zero = opaque
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(SIZE, 4); // biWidth
  header.writeInt32LE(SIZE * 2, 8); // biHeight (XOR + AND)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression
  header.writeUInt32LE(SIZE * SIZE * 4, 20); // biSizeImage
  return Buffer.concat([header, xor, andMask]);
}

function main() {
  const out = process.argv[2] || path.join(__dirname, 'build', 'icon.ico');
  draw();
  const image = packBmp();
  const ico = Buffer.alloc(22 + image.length);
  ico.writeUInt16LE(0, 0); // reserved
  ico.writeUInt16LE(1, 2); // type = icon
  ico.writeUInt16LE(1, 4); // count
  ico[6] = 0; // width 256
  ico[7] = 0; // height 256
  ico[8] = 0; // colors
  ico[9] = 0; // reserved
  ico.writeUInt16LE(1, 10); // planes
  ico.writeUInt16LE(32, 12); // bitCount
  ico.writeUInt32LE(image.length, 14); // bytesInRes
  ico.writeUInt32LE(22, 18); // imageOffset
  image.copy(ico, 22);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, ico);
  console.log(`wrote ${out} (${ico.length} bytes)`);
}

module.exports = { main, draw };

if (require.main === module) main();
