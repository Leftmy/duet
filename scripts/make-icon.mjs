// Renders the app icon (a terminal prompt on a dark rounded tile) to build/icon.png and build/icon.ico.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
fs.mkdirSync(out, { recursive: true });

const clamp = (v) => Math.max(0, Math.min(1, v));
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function roundRectDist(px, py, x, y, w, h, r) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const shapes = [
  { color: [224, 122, 82], d: (x, y) => segDist(x, y, 80, 84, 130, 128) - 12 },
  { color: [224, 122, 82], d: (x, y) => segDist(x, y, 130, 128, 80, 172) - 12 },
  { color: [236, 236, 236], d: (x, y) => segDist(x, y, 146, 172, 184, 172) - 12 },
];

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const cx = x + 0.5;
    const cy = y + 0.5;
    const tile = clamp(0.5 - roundRectDist(cx, cy, 8, 8, SIZE - 16, SIZE - 16, 56));
    const shade = 30 + Math.round(10 * (1 - cy / SIZE));
    let rgb = [shade, shade, shade];
    for (const s of shapes) {
      const a = clamp(0.5 - s.d(cx, cy));
      if (a > 0) rgb = rgb.map((c, i) => Math.round(c * (1 - a) + s.color[i] * a));
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = rgb[0];
    raw[o + 1] = rgb[1];
    raw[o + 2] = rgb[2];
    raw[o + 3] = Math.round(tile * 255);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(out, 'icon.png'), png);

const ico = Buffer.alloc(22);
ico.writeUInt16LE(0, 0);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = 0;
ico[7] = 0;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([ico, png]));
console.log('icon written to', out);
