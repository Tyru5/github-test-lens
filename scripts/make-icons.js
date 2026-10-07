#!/usr/bin/env node
// Generates icons/icon-{16,32,48,128}.png with zero dependencies (node:zlib + hand-rolled PNG chunks).
// Design: rounded square split diagonally — blue (production) top-left, purple (test) bottom-right,
// with a white diagonal seam. Rendered 4x supersampled for anti-aliasing.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 32, 48, 128];
const OUT = path.join(__dirname, '..', 'icons');
const PROD = [9, 105, 218];     // #0969da (GitHub accent)
const TEST = [130, 80, 223];    // #8250df (GitHub done)
const SEAM = [255, 255, 255];

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Returns [r,g,b,a] for a point in unit square coords (0..1).
function shade(u, v) {
  const r = 0.22; // corner radius (relative)
  const dx = Math.max(r - u, u - (1 - r), 0);
  const dy = Math.max(r - v, v - (1 - r), 0);
  if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
  const d = (u - v) / Math.SQRT2; // signed distance from the diagonal
  const seamHalf = 0.045;
  if (Math.abs(d) < seamHalf) return [...SEAM, 255];
  return [...(d > 0 ? PROD : TEST), 255];
}
function render(size) {
  const ss = 4;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          const a = px[3] / 255;
          acc[0] += px[0] * a; acc[1] += px[1] * a; acc[2] += px[2] * a; acc[3] += a;
        }
      }
      const n = ss * ss;
      const a = acc[3] / n;
      const i = (y * size + x) * 4;
      if (a > 0) {
        out[i] = Math.round(acc[0] / acc[3]);
        out[i + 1] = Math.round(acc[1] / acc[3]);
        out[i + 2] = Math.round(acc[2] / acc[3]);
      }
      out[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, out);
}
fs.mkdirSync(OUT, { recursive: true });
for (const s of SIZES) {
  const file = path.join(OUT, `icon-${s}.png`);
  fs.writeFileSync(file, render(s));
  console.log('wrote', path.relative(process.cwd(), file));
}
