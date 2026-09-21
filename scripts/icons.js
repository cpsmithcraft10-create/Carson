'use strict';

/* Draws the house mark out to the PNG sizes a phone asks for when somebody
   puts this on their home screen.
 
   A phone will not take the SVG favicon for a home-screen icon — iOS wants a
   square PNG and Android wants 192 and 512 — so the mark is drawn here rather
   than pulled in with an image library. Nothing to install: shapes are
   measured by distance, sampled a few times per pixel so the edges are smooth,
   and written out as a PNG by hand.
 
   Run it after changing the mark:
 
     npm run icons
*/

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');

const GREEN = [0x17, 0x40, 0x2e];
const WHITE = [0xff, 0xff, 0xff];

/* Everything below is measured in a 0..1 square, so one drawing serves every
   size. `inset` shrinks the mark for the maskable icon, where Android crops a
   circle out of the middle and anything near the edge is lost. */
const DROP_TOP = 0.145;
const DROP_CENTRE = [0.5, 0.605];
const DROP_R = 0.265;

/* ----------------------------- measuring ----------------------------- */

function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len = vx * vx + vy * vy;
  let t = len ? (wx * vx + wy * vy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** The two points where a line from the apex just grazes the circle. */
function tangentPoints() {
  const [cx, cy] = DROP_CENTRE;
  const ax = 0.5;
  const ay = DROP_TOP;
  const d = Math.hypot(ax - cx, ay - cy);
  const ux = (ax - cx) / d;
  const uy = (ay - cy) / d;
  const cos = DROP_R / d;
  const sin = Math.sqrt(1 - cos * cos);

  // The perpendicular, taken both ways round.
  return [1, -1].map((side) => [
    cx + DROP_R * (cos * ux + sin * side * -uy),
    cy + DROP_R * (cos * uy + sin * side * ux),
  ]);
}

const TANGENTS = tangentPoints();

function inTriangle(px, py, a, b, c) {
  const sign = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const p = [px, py];
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** The water drop: a circle with a cone drawn up to the point. */
function inDrop(x, y) {
  const [cx, cy] = DROP_CENTRE;
  if (Math.hypot(x - cx, y - cy) <= DROP_R) return true;
  return inTriangle(x, y, [0.5, DROP_TOP], TANGENTS[0], TANGENTS[1]);
}

/** The arrow inside it — a stem and a chevron, same as the favicon. */
function inArrow(x, y) {
  const w = 0.042;
  return distanceToSegment(x, y, 0.5, 0.485, 0.5, 0.735) <= w
    || distanceToSegment(x, y, 0.5, 0.485, 0.383, 0.602) <= w
    || distanceToSegment(x, y, 0.5, 0.485, 0.617, 0.602) <= w;
}

/** A rounded square for the plain icon; `radius` of 0 leaves it full bleed. */
function inBackground(x, y, radius) {
  if (!radius) return true;
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - radius), 0);
  return Math.hypot(dx, dy) <= radius;
}

/* ------------------------------ drawing ------------------------------ */

/**
 * One pixel's colour, sampled on a grid so the curves come out smooth.
 * Returns [r, g, b, a].
 */
function colourAt(x0, y0, step, { radius, inset }) {
  const samples = 4;
  let bg = 0;
  let mark = 0;

  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const x = x0 + ((sx + 0.5) / samples) * step;
      const y = y0 + ((sy + 0.5) / samples) * step;

      if (inBackground(x, y, radius)) bg += 1;

      // Shrink the mark towards the middle by `inset` before testing it.
      const mx = 0.5 + (x - 0.5) * inset;
      const my = 0.5 + (y - 0.5) * inset;
      if (inDrop(mx, my) && !inArrow(mx, my)) mark += 1;
    }
  }

  const total = samples * samples;
  const cover = bg / total;
  if (!cover) return [0, 0, 0, 0];

  const white = Math.min(mark / total, cover);
  const mix = (i) => Math.round(GREEN[i] * (cover - white) / cover + WHITE[i] * white / cover);

  return [mix(0), mix(1), mix(2), Math.round(cover * 255)];
}

function draw(size, opts) {
  const rows = [];
  const step = 1 / size;

  for (let py = 0; py < size; py += 1) {
    const row = Buffer.alloc(size * 4 + 1); // A filter byte, then the pixels.
    for (let px = 0; px < size; px += 1) {
      const [r, g, b, a] = colourAt(px * step, py * step, step, opts);
      row[1 + px * 4] = r;
      row[2 + px * 4] = g;
      row[3 + px * 4] = b;
      row[4 + px * 4] = a;
    }
    rows.push(row);
  }

  return Buffer.concat(rows);
}

/* ------------------------------ the file ----------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bits per channel
  header[9] = 6;   // colour with alpha
  header[10] = 0;  // deflate
  header[11] = 0;  // no filtering beyond the per-row byte
  header[12] = 0;  // not interlaced

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------- run it ------------------------------ */

const WANTED = [
  // Android's two, and what the browser tab falls back to.
  { file: 'icon-192.png', size: 192, radius: 0.22, inset: 1 },
  { file: 'icon-512.png', size: 512, radius: 0.22, inset: 1 },

  // Android crops this one to whatever shape the phone uses, so it runs to
  // the edge and the mark sits well inside.
  { file: 'icon-maskable-512.png', size: 512, radius: 0, inset: 1.42 },

  // iOS rounds the corners itself and will not have a see-through icon.
  { file: 'apple-touch-icon-180.png', size: 180, radius: 0, inset: 1 },
];

function main() {
  fs.mkdirSync(OUT, { recursive: true });

  for (const want of WANTED) {
    const pixels = draw(want.size, { radius: want.radius, inset: want.inset });
    const file = path.join(OUT, want.file);
    fs.writeFileSync(file, png(want.size, pixels));
    console.log(`${want.file}  ${want.size}x${want.size}`);
  }

  console.log(`\nWritten to ${OUT}`);
}

if (require.main === module) main();

module.exports = { draw, png };
