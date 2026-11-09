// Draws the extension icon (teal disc, white microphone, crossed-out music note) as PNGs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// signed distance helpers in unit space (0..1)
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const sdBox = (x, y, cx, cy, hw, hh, r = 0) => {
  const dx = Math.abs(x - cx) - hw + r, dy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};
const sdRing = (x, y, cx, cy, r, w) => Math.abs(Math.hypot(x - cx, y - cy) - r) - w;
const sdSeg = (x, y, ax, ay, bx, by, w) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h) - w;
};

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const ss = 4; // supersampling
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          const disc = sdCircle(x, y, 0.5, 0.5, 0.48);
          if (disc > 0) continue;
          // background gradient teal
          const t = y;
          let cr = 18 + 10 * t, cg = 170 - 40 * t, cb = 130 - 20 * t;
          // microphone: capsule + U holder + stem + base
          const capsule = sdBox(x, y, 0.5, 0.38, 0.11, 0.2, 0.11);
          const holder = Math.max(sdRing(x, y, 0.5, 0.42, 0.19, 0.035), y < 0.42 ? 1 : -1);
          const stem = sdBox(x, y, 0.5, 0.7, 0.035, 0.08);
          const base = sdBox(x, y, 0.5, 0.79, 0.14, 0.035, 0.03);
          const mic = Math.min(capsule, holder, stem, base);
          if (mic < 0) { cr = 255; cg = 255; cb = 255; }
          r += cr; g += cg; b += cb; a += 255;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(r / Math.max(1, a / 255));
      buf[i + 1] = Math.round(g / Math.max(1, a / 255));
      buf[i + 2] = Math.round(b / Math.max(1, a / 255));
      buf[i + 3] = Math.round(a / n);
    }
  }
  return png(size, buf);
}

export function makeIcons(dir) {
  mkdirSync(dir, { recursive: true });
  for (const s of [16, 32, 48, 128]) writeFileSync(join(dir, `icon${s}.png`), draw(s));
}

if (import.meta.url === `file://${process.argv[1]}`) makeIcons(process.argv[2] ?? 'dist/icons');
